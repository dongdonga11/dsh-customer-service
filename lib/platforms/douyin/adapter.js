/**
 * dsh-cs — 平台适配器：抖音私信 + 抖音来客（同一适配器管两个 thread.platform）
 *
 * 职责边界（内核只通过下列方法与本文件交互）：
 *   spec / accountIdOf / identifySelf / parseInbound / send / canSend / enrichBuyer
 *   captureSendTemplate / hasSendTemplate / aiContext / aiDiagnostics
 *
 * 本文件承载**全部抖音专有知识**：
 *   - frontier 帧 protobuf 解析（./protobuf.js）
 *   - 「捕获发送模板才能发」的模板中间态（发送通道 A）
 *   - 抖音来客的 DOM 自动化发送（发送通道 B）
 *   - 客服知识库（店规速查.md + 实时数据.json）与店铺 MCP 店铺数据
 *
 * 行为基线：lib/_legacy/index.js（只读）。所有对外字段名、错误文案与
 * lib/_legacy/index.js 保持一致，避免 client 半与既有 state.json 失配。
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises'
import { decodeRecordsB64, describeSendTemplate, rewriteSendBody, parseSendResponse } from './protobuf.js'
import { DOUYIN_SPEC, DOUYIN_LAIKE_SPEC } from '../../kernel/config.js'

/** 本适配器所在目录（lib/platforms/douyin）—— 用于定位插件根下的客服知识库。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 知识库缓存 TTL：改完文件 60s 内生效，不用重启插件（旧实现同值）。 */
const KB_TTL_MS = 60000

/** 聊天写死的平台 id（与 spec.handles / config 保持一致）。 */
const P_PM = 'douyin'
const P_LAIKE = 'douyin-laike'

/**
 * 平台规格。取自 kernel/config.js（内核里唯一允许出现平台名的地方），
 * 这里补上 M1 文档约定的 `platforms` 别名与 AI 默认平台。
 */
export const spec = {
  ...DOUYIN_SPEC,
  /** M1 文档字段名（等价于 config 的 handles） */
  platforms: DOUYIN_SPEC.handles,
  /** 同一适配器负责的来客子平台规格（供内核列举平台卡） */
  subSpecs: [DOUYIN_SPEC, DOUYIN_LAIKE_SPEC],
  /**
   * `aiSettings.platforms` 为空时，AI 默认对哪些 thread.platform 生效。
   * 旧实现硬编码 ['douyin-laike']（来客是主战场；抖音私信要显式加）。
   */
  aiDefaultPlatforms: [P_LAIKE],
  capabilities: {
    ...DOUYIN_SPEC.capabilities,
    /** 发送通道需要"先捕获模板"（发送通道 A） */
    requiresSendTemplate: true,
    /** 同一扩展进程上报两类平台账号（私信 + 来客），一条 WS 连接 */
    multiPlatformPerConnection: true,
  },
}

/** 与旧实现一致的默认店铺名（提示词里用；可由调用方覆盖）。 */
const DEFAULT_SHOP_NAME = '示例店铺'

/** 平台账号 id（握手/上报里的 account_id）。 */
export function accountIdOf(handshakeMsg) {
  const id = handshakeMsg && handshakeMsg.account_id
  return id ? String(id) : 'default'
}

/**
 * 创建抖音适配器。
 *
 * @param {object} opts
 * @param {object} opts.store             kernel Store（只读写，不替换）
 * @param {object} [opts.kb]              知识库配置覆盖：{ dir?, ttlMs?, shopName?, env? }
 * @param {object|null} [opts.shopMcp]    店铺 MCP 客户端（装配层注入；不传则本适配器惰性自建）
 * @param {object} [opts.log]             日志器 {info,warn,error,debug}
 * @param {string} [opts.host]            桥监听地址（仅用于日志/诊断展示）
 * @param {string} [opts.dataDir]         数据目录（默认 store.dataDir）
 * @param {string} [opts.legacyDir]       旧插件数据目录（只读：沿用旧发送模板）
 * @param {string} [opts.label]           日志前缀（默认 'dsh-cs'）
 */
export function createDouyinAdapter(opts = {}) {
  const { store, kb, log } = opts
  if (!store) throw new Error('createDouyinAdapter: 缺少 store')

  const label = String(opts.label || 'dsh-cs')
  const dataDir = String(opts.dataDir || store.dataDir || '')
  const legacyDir = String(opts.legacyDir || '')
  const host = String(opts.host || '127.0.0.1')
  /** 资料库实例（kernel library，可选）：有则按「账号→项目」取资料 */
  const library = opts.library || null
  const lg = normalizeLog(log, label)
  const kbCfg = kb && typeof kb === 'object' ? kb : {}
  const shopName = String(kbCfg.shopName || DEFAULT_SHOP_NAME)

  /** 知识库目录（惰性解析并缓存；旧实现同名变量）。 */
  let kbDirResolved = ''
  /** 知识库正文缓存。 */
  let kbText = ''
  let kbAt = 0
  let kbPath = ''
  let kbError = ''

  /** 发送模板：内存 + 磁盘（模板是 protobuf 字节，不是 JSON）。 */
  const templates = new Map() // accountId -> Buffer
  const TEMPLATE_DIR = dataDir ? join(dataDir, 'templates') : ''
  /**
   * 旧插件的发送模板目录（**只读**）。
   *
   * 迁移只复制 state.json，不复制 templates/ —— 若不做这层兜底，升级后用户
   * 必须再在网页版手动发一条私信才能重新捕获模板（表现为「升完级发不出消息」）。
   */
  const LEGACY_TEMPLATE_DIR = legacyDir ? join(legacyDir, 'templates') : ''
  /** 发送失败诊断落盘目录（原始响应字节 + 解析结果）。 */
  const DIAG_DIR = dataDir ? join(dataDir, 'diag') : ''

  /** 实时数据缓存：MCP 成功 60s / 失败 30s（旧实现同策略）。 */
  let seatCache = { at: 0, value: null }

  /**
   * 店铺 MCP（可选）：装配层可注入自定义客户端；不注入时惰性加载内置的
   * 通用 stdio MCP 客户端（`shop-mcp.js`，默认不启用，需自行配置）。
   * `DOUYIN_CS_SHOP_MCP=off` 可彻底关闭（只用文件来源）。
   */
  const SHOP_MCP_DISABLED = process.env.DOUYIN_CS_SHOP_MCP === 'off'
  let shopMcpClient = opts.shopMcp || null
  let shopMcpTried = false

  /** 惰性拿到店铺 MCP 客户端（可能为 null：未关闭但模块不可用）。 */
  async function activeShopMcp() {
    if (SHOP_MCP_DISABLED) return null
    if (shopMcpClient) return shopMcpClient
    if (shopMcpTried) return null
    shopMcpTried = true
    for (const rel of ['../../kernel/shop-mcp.js']) {
      try {
        const mod = await import(new URL(rel, import.meta.url).href)
        const Cls = mod.ShopMcpClient || mod.default
        if (typeof Cls === 'function') {
          shopMcpClient = new Cls({ log: (m) => lg.info(m) })
          return shopMcpClient
        }
      } catch {
        /* 试下一个 */
      }
    }
    lg.warn('店铺 MCP 客户端不可用（店铺数据退化为文件来源）')
    return null
  }

  // ── 知识库定位 ────────────────────────────────────────────────────────────
  //
  // ⚠️ 旧实现踩过的坑：插件通过 junction 挂进 profile node_modules 后，
  // `import.meta.url` 可能停在 node_modules 路径下，往上两级找不到「客服知识库」。
  // 所以先 realpath 解析真实目录，再逐个候选探测存在性。
  async function resolveKbDir() {
    if (kbDirResolved) return kbDirResolved
    const tries = []
    if (kbCfg.dir) tries.push(String(kbCfg.dir))
    if (process.env.DOUYIN_CS_KB_DIR) tries.push(process.env.DOUYIN_CS_KB_DIR)
    try {
      // lib/platforms/douyin → 上三级 = 插件根
      tries.push(join(await realpath(HERE), '..', '..', '..', '客服知识库'))
    } catch {
      /* ignore */
    }
    tries.push(join(HERE, '..', '..', '..', '客服知识库'))
    for (const dir of tries) {
      try {
        await stat(join(dir, '店规速查.md'))
        kbDirResolved = dir
        return dir
      } catch {
        /* 下一个 */
      }
    }
    kbDirResolved = tries[tries.length - 1] || ''
    return kbDirResolved
  }

  /** 读知识库（带 TTL 缓存：改完文件 60s 内自动生效，不用重启插件）。 */
  async function ensureKb(force) {
    const ttl = Number(kbCfg.ttlMs) || KB_TTL_MS
    if (!force && kbText && Date.now() - kbAt < ttl) return
    const dir = await resolveKbDir()
    kbPath = dir ? join(dir, '店规速查.md') : ''
    try {
      kbText = await readFile(kbPath, 'utf8')
      kbAt = Date.now()
      kbError = ''
    } catch (e) {
      kbError = String((e && e.message) || e)
      if (!kbText) lg.error(`知识库读取失败: ${kbPath} → ${kbError}`)
    }
  }

  /**
   * 读实时数据（店铺等）。三种来源按优先级：
   *   ① 店铺 MCP（真实开台数据）—— 能答「现在有位置吗」
   *   ② `客服知识库/实时数据.json`（人工或别的系统写的）
   *   ③ 都拿不到 → unknown，AI 会转人工，**绝不猜**
   */
  async function readRealtime() {
    const mcp = await activeShopMcp()
    if (mcp) {
      const ttl = seatCache.value && seatCache.value.status !== 'unknown' ? 60000 : 30000
      if (seatCache.value && Date.now() - seatCache.at < ttl) return seatCache.value
      try {
        const st = await mcp.seatStatus()
        // unknown 时保留原因，方便面板显示；但仍然往下试文件来源
        if (st.status !== 'unknown') {
          seatCache = { at: Date.now(), value: st }
          return st
        }
        seatCache = { at: Date.now(), value: st }
        // ★ 配置类错误（密钥没填/填错）→ 主动杀掉子进程。
        //   MCP 是**启动时**读 .env.local 的，进程活着就不会重读；杀掉后下次调用
        //   会重新 spawn —— 于是「填好 .env.local」无需重启插件就能生效。
        if (st.error && /未配置|TOKEN|SECRET|少于 16/.test(String(st.error))) {
          lg.info(`店铺 MCP 配置未就绪，重建子进程以便下次重读 .env.local：${st.error}`)
          mcp.stop()
        }
      } catch (e) {
        lg.error(`店铺 MCP 取店铺失败: ${(e && e.message) || e}`)
      }
    }
    // ② 文件来源
    try {
      const dir = await resolveKbDir()
      const raw = await readFile(join(dir, '实时数据.json'), 'utf8')
      const j = JSON.parse(raw)
      const ageSec = (Date.now() - Date.parse(j.updated_at || 0)) / 1000
      if (!Number.isFinite(ageSec) || ageSec > Number(j.stale_after_sec || 600)) {
        return { status: 'unknown', stale: true, ageSec: Math.round(ageSec), source: 'file' }
      }
      return { ...j, source: 'file' }
    } catch {
      return seatCache.value || { status: 'unknown' }
    }
  }

  // ── 发送模板持久化（旧实现：二进制 + 原子写 + _primary 双键） ──────────────

  function safeAccount(accountId) {
    return String(accountId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default'
  }

  async function persistTemplate(accountId, body) {
    if (!TEMPLATE_DIR) return ''
    await mkdir(TEMPLATE_DIR, { recursive: true })
    const path = join(TEMPLATE_DIR, `${safeAccount(accountId)}.send.bin`)
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, body)
    await rename(tmp, path)
    return path
  }

  async function loadTemplate(accountId) {
    // 先新目录，再旧插件目录（只读兜底：迁移后不必让用户重新手动发一条）
    for (const dir of [TEMPLATE_DIR, LEGACY_TEMPLATE_DIR]) {
      if (!dir) continue
      for (const candidate of [safeAccount(accountId), '_primary']) {
        try {
          const data = await readFile(join(dir, `${candidate}.send.bin`))
          if (data && data.length > 0) return data
        } catch {
          /* not found */
        }
      }
    }
    return undefined
  }

  function hasSendTemplate(accountId) {
    return templates.has(accountId) || templates.has('_primary')
  }

  // ── 8. 平台账号 / 自身识别 ────────────────────────────────────────────────
  //
  // 只做「从消息里读出身份字段」，落库由内核统一处理（包括"认出自己后用自己
  // 的昵称当账号名"这条通用规则）。

  function identifySelf(msg, accountId) {
    const out = { accountId: accountId || accountIdOf(msg), contacts: [] }
    if (!msg || typeof msg !== 'object') return out
    const type = String(msg.type || '')

    if (type === 'account_detected') {
      // 扩展从 cookie 探测到的账号 id（与我方握手 key 不同，仅作元数据）
      out.detectedId = String(msg.account_id || '')
      return out
    }
    if (type === 'account_identity') {
      // 本账号自己的 sec_uid —— 认出通讯录里「自己」的可靠判据
      out.selfSecUid = String(msg.sec_uid || '')
      return out
    }
    if (type === 'platform_account') {
      out.platform = String(msg.platform || P_LAIKE)
      out.nickname = String(msg.nickname || '')
      out.detectedId = String(msg.detected_id || '')
      out.selfUid = String(msg.self_uid || '')
      out.connected = true
      // 旧实现：注册/更新平台账号后立即刷新面板（同一条连接上的第二账号，
      // 面板要马上多出一张账号卡）
      out.refresh = true
      return out
    }
    if (type === 'user_info') {
      // 扩展 hook 了 /im/user/info/ —— **私信帧本身不带昵称**，昵称只能从这里来
      const users = Array.isArray(msg.users) ? msg.users : []
      let guessed = ''
      for (const u of users) {
        if (!u || typeof u !== 'object') continue
        const uid = String(u.uid || u.user_id || '').trim()
        const secUid = String(u.sec_uid || '').trim()
        const nickname = String(u.nickname || u.nick_name || u.name || '').trim()
        if (!uid && !secUid) continue
        out.contacts.push({ uid, secUid, nickname, avatar: u.avatar_url || u.avatar || '' })
        if (!guessed && nickname) guessed = nickname
      }
      out.guessedNickname = guessed
      // 旧实现：昵称/头像更新后立即刷新面板（账号名可能刚从 sec_uid 变成昵称）
      out.refresh = true
      return out
    }
    return out
  }

  // ── 3. 入站解析（纯函数：不落库、不发送、不读文件） ───────────────────────

  /**
   * 把扩展上报的消息解析成内核事件。未知类型返回 []（旧实现 default 分支忽略）。
   *
   * @param {object} msg 扩展上报的原始 JSON
   * @param {object} io  { accountId, bridge, store, log }
   * @returns {Array<object>} CsEvent[]
   */
  function parseInbound(msg, io = {}) {
    if (!msg || typeof msg !== 'object') return []
    const accountId = String(io.accountId || msg.account_id || 'default')
    const type = String(msg.type || '')

    switch (type) {
      // 抖音私信 frontier 帧 → 结构化消息记录
      case 'frame': {
        let decoded
        try {
          decoded = decodeRecordsB64(msg.raw_b64)
        } catch (e) {
          lg.warn(`帧解析失败: ${(e && e.message) || e}`)
          return []
        }
        const records = (decoded && decoded.records) || []
        const frontierMsgId = (decoded && decoded.frontierMsgId) || ''
        if (records.length === 0) return []
        const events = []
        for (let i = 0; i < records.length; i++) {
          const r = records[i]
          if (!r || !r.text) continue
          // 去重键：server_message_id 优先，退 frontier id（多条加序号）
          let messageId = r.server_message_id
          if (!messageId) {
            messageId = frontierMsgId || r.client_message_id || ''
            if (messageId && records.length > 1) messageId = `${messageId}:${i}`
          }
          events.push({
            kind: 'message',
            platform: P_PM,
            accountId,
            conversationId: r.conversation_id,
            conversationShortId: r.conversation_short_id || '',
            buyerUid: r.sender_uid || r.peer_id || '',
            buyerSecUid: r.sender_sec_uid || '',
            text: r.text,
            serverMessageId: messageId,
            /** 单聊里「不是发送者的那一侧」就是我们自己 —— 自举出自身 uid */
            counterpartUid: r.counterpart_uid || '',
            at: Date.now(),
          })
        }
        return events
      }

      // 页面自己发了一条私信 → 请求体当发送模板
      case 'send_template': {
        if (!msg.body_b64) return []
        return [{ kind: 'send_template', platform: P_PM, accountId, bodyB64: String(msg.body_b64) }]
      }

      // 昵称/头像（/im/user/info/ 的 hook 结果）
      case 'user_info':
      case 'account_detected':
      case 'account_identity':
      case 'platform_account': {
        const id = identifySelf(msg, accountId)
        return [toAccountEvent(id, accountId)]
      }

      // 来客：一次性同步多个会话（列表轮询的产物）
      case 'laike_sync': {
        const threads = Array.isArray(msg.threads) ? msg.threads : []
        return [{ kind: 'batch', platform: String(msg.platform || P_LAIKE), accountId, threads }]
      }

      // 来客诊断 dump（只打日志，不打库）
      case 'laike_probe':
        return [
          {
            kind: 'probe',
            platform: P_LAIKE,
            accountId,
            data: msg.sample || {},
            note: '来客诊断',
          },
        ]

      // 页面 frontier 长连接已 hook —— 真·「页面已接上」信号
      case 'ws_hooked':
        return [{ kind: 'account', platform: P_PM, accountId, connected: true }]

      // 页面当前打开的会话：补记买家 sec_uid（页面链接里有，比帧字段更早可得）
      case 'current_chat': {
        if (!msg.conversation_id) return []
        const peer = String(msg.peer_id || '')
        // 只有 sec_uid 形状才值得记（页面链接里的就是它）
        if (!peer || !peer.startsWith('MS4wLjAB')) return []
        return [
          {
            kind: 'thread-hint',
            platform: P_PM,
            accountId,
            conversationId: String(msg.conversation_id),
            buyerSecUid: peer,
          },
        ]
      }

      default:
        // risk_alert / login_state 等暂不处理（旧实现同）
        return []
    }
  }

  /** identifySelf 结果 → 内核的 account 事件。 */
  function toAccountEvent(id, accountId) {
    const ev = {
      kind: 'account',
      platform: id.platform || P_PM,
      accountId: id.accountId || accountId,
      contacts: id.contacts || [],
    }
    if (id.nickname) ev.nickname = id.nickname
    if (id.detectedId) ev.detectedId = id.detectedId
    if (id.selfUid) ev.selfUid = id.selfUid
    if (id.selfSecUid) ev.selfSecUid = id.selfSecUid
    if (id.connected !== undefined) ev.connected = id.connected
    if (id.guessedNickname) ev.guessedNickname = id.guessedNickname
    if (id.refresh) ev.refresh = true
    return ev
  }

  // ── 4/5. 发送 ─────────────────────────────────────────────────────────────

  /**
   * 发送一条消息。按 thread.platform 分流到两条通道。
   *
   * @returns {Promise<{ok:boolean, error?:string, serverMessageId?:string, server_message_id?:string, detail?:object}>}
   */
  async function send(thread, text, io = {}) {
    if (!thread) return { ok: false, error: '会话不存在' }
    const platform = thread.platform || spec.name
    if (platform === P_LAIKE) return sendViaDom(thread, text, io)
    return sendViaTemplate(thread, text, io)
  }

  /**
   * 发送通道 A：模板改写 + 页面自己的 XHR POST。
   *
   * 为什么必须用模板：发送请求体里有几十个环境字段和一个每条都变、算法未逆的
   * ticket；实测**服务端不校验 ticket 新鲜度**，所以「捕获页面自己发的那次请求
   * 作为模板 → 只替换会话/正文 → 用页面自己的 XHR 发出去」是唯一稳的路。
   */
  async function sendViaTemplate(thread, text, io = {}) {
    const accountId = thread.accountId
    const conversationId = thread.conversationId
    const shortId = thread.conversationShortId

    const template = templates.get(accountId) || templates.get('_primary') || (await loadTemplate(accountId))
    if (!template) {
      return {
        ok: false,
        error:
          '还没有捕获到发送模板，这一条发不出去。请在抖音网页版里手动发一条私信（发给谁都行），扩展会自动把那次请求存为模板。',
      }
    }
    if (!shortId) {
      return {
        ok: false,
        error: '缺少会话短 id（conversation_short_id），无法定向发送。请先让客户在网页版里发一条消息。',
      }
    }

    let body
    try {
      body = rewriteSendBody(template, { text, conversationId, conversationShortId: shortId })
    } catch (e) {
      return { ok: false, error: `模板结构不符合预期，已拒发: ${e.message}` }
    }

    // 出站回声：防止自己发的内容被帧回读后当成新消息重复入库
    if (io.echo && typeof io.echo.remember === 'function') io.echo.remember(accountId, text)

    const request = io.request || (io.bridge && io.bridge.sendCommandAck && ((cmd, acct, t) => io.bridge.sendCommandAck(cmd, acct, t)))
    if (typeof request !== 'function') return { ok: false, error: '桥不可用（无法下发发送指令）' }

    const result = await request(
      { type: 'send_raw', body_b64: body.toString('base64'), conversation_id: conversationId },
      accountId,
      25000,
    )
    if (!result || !result.ok) return { ok: false, error: (result && result.error) || '扩展未能执行 POST' }

    const respB64 = result.resp_b64 || ''
    if (!respB64) return { ok: false, error: '扩展未回传响应体，无法确认是否真的发出' }

    let resp
    try {
      resp = parseSendResponse(Buffer.from(respB64, 'base64'))
    } catch (e) {
      return { ok: false, error: `响应解析失败: ${e.message}` }
    }

    // ── 发送失败诊断落盘 ──────────────────────────────────────────────────
    // 「发送未成功 (status=null)」只说明"没解析出 status_code"，看不出响应体
    // 到底是什么形状。把原始字节 + 字段结构写下来，才能判断是平台换了字段号、
    // 还是网关返回了 JSON / HTML 错误页。
    if (!resp.ok) {
      const diag = {
        at: new Date().toISOString(),
        conversation_id: conversationId,
        conversation_short_id: shortId,
        http_status: result.http_status || 0,
        raw_len: resp.raw_len,
        raw_hex: resp.raw_hex,
        raw_text: resp.raw_text,
        field_dump: resp.field_dump,
        parsed: {
          status_code: resp.status_code,
          status_message: resp.status_message,
          logid: resp.logid,
          server_message_id: resp.server_message_id,
        },
      }
      lg.error(`发送失败诊断: ${JSON.stringify(diag)}`)
      if (DIAG_DIR) {
        try {
          await mkdir(DIAG_DIR, { recursive: true })
          await writeFile(join(DIAG_DIR, 'last-send-response.bin'), Buffer.from(respB64, 'base64'))
          await writeFile(join(DIAG_DIR, 'last-send-diagnosis.json'), JSON.stringify(diag, null, 2), 'utf8')
        } catch (e) {
          lg.error(`诊断落盘失败: ${e}`)
        }
      }
      const shape = (resp.field_dump || []).map((f) => `${f.field}:${f.wt}`).join(',') || '无字段'
      const preview = resp.raw_text ? ` 文本="${resp.raw_text.slice(0, 120)}"` : ` hex=${resp.raw_hex}`
      const diagHint = DIAG_DIR ? `\n原始字节已存到 ${join(DIAG_DIR, 'last-send-response.bin')}` : ''
      return {
        ok: false,
        error:
          `抖音拒绝: ${resp.status_message || '未知'} (logid=${resp.logid || '空'})\n` +
          `诊断：字段=[${shape}] 长度=${resp.raw_len}${preview}` +
          diagHint,
      }
    }

    return { ok: true, serverMessageId: resp.server_message_id, server_message_id: resp.server_message_id }
  }

  /**
   * 发送通道 B：来客 DOM 自动化（路线 A）。
   *
   * 为什么不用接口：来客的 IM 走字节 PaaS IM SDK，protobuf 编码 + 域名由 TCC
   * 下发，而且**跑在主世界之外的 realm**（worker/容器）里 —— 主世界 hook 不到、
   * 也拿不到 SDK 实例。所以改成驱动页面本身的 UI：扩展切到目标会话 → 校验确实是
   * 这个买家 → 输入 → 点发送 → **回读历史消息确认真的发出去了**。
   *
   * 关键设计：**结果只信「回读到这条消息」**，不信「点了发送按钮」。
   */
  async function sendViaDom(thread, text, io = {}) {
    const accountId = thread.accountId
    // 先记出站回声，避免自己发的内容被下一轮轮询当成新消息重复入库
    if (io.echo && typeof io.echo.remember === 'function') io.echo.remember(accountId, text)

    const request = io.request || (io.bridge && io.bridge.sendCommandAck && ((cmd, acct, t) => io.bridge.sendCommandAck(cmd, acct, t)))
    if (typeof request !== 'function') return { ok: false, error: '桥不可用（无法下发发送指令）' }

    const result = await request(
      {
        type: 'laike_send',
        platform: P_LAIKE,
        account_id: accountId,
        conversation_id: thread.conversationId,
        conversation_short_id: thread.conversationShortId || '',
        buyer_uid: thread.buyerUid || '',
        display_name: store.resolveName(thread.buyerUid, thread.buyerSecUid) || '',
        text,
      },
      accountId,
      45000, // DOM 发送要切会话 + 等渲染 + 回读确认，给足时间
    )
    if (!result || !result.ok) {
      // 失败时把「扩展看到的页面实况」落盘：选择器失配这类问题，
      // 没有 DOM 体检就只能来回猜。
      const detail = (result && result.detail) || null
      if (detail) {
        lg.error(`来客发送失败诊断: ${JSON.stringify(detail).slice(0, 4000)}`)
        if (DIAG_DIR) {
          try {
            await mkdir(DIAG_DIR, { recursive: true })
            await writeFile(
              join(DIAG_DIR, 'last-laike-error.json'),
              JSON.stringify(
                {
                  at: new Date().toISOString(),
                  thread: { id: thread.id, conversationId: thread.conversationId },
                  error: result && result.error,
                  detail,
                },
                null,
                2,
              ),
              'utf8',
            )
          } catch (e) {
            lg.error(`来客诊断落盘失败: ${e}`)
          }
        }
      }
      const hint = detail && DIAG_DIR ? `\n（页面结构已存到 ${join(DIAG_DIR, 'last-laike-error.json')}）` : ''
      return { ok: false, error: ((result && result.error) || '来客页面未能完成发送') + hint }
    }
    // 扩展回读到的服务端消息 id（用于幂等，避免下轮轮询重复入库）
    const detail = result.detail || {}
    const id = String(detail.server_message_id || '')
    return { ok: true, serverMessageId: id, server_message_id: id, detail }
  }

  /**
   * 是否具备发送条件（面板「可发送 / 待捕获发送模板」）。
   *
   * @param {object} account 客户账号行：{ id, platform, connected, canSend }
   */
  function canSend(account, io = {}) {
    if (!account) return { ok: false, reason: '账号不存在' }
    const platform = account.platform || spec.name
    const bridge = io.bridge
    const connected = Boolean(bridge && bridge.hasAccount(account.id)) && account.connected !== false
    if (platform === P_LAIKE) {
      // 来客走 DOM 自动化，只要能连上就能发
      return { ok: connected, reason: connected ? '' : '来客页面未连接' }
    }
    // 抖音要靠「捕获发送模板」才能发
    const ok = hasSendTemplate(account.id) || account.canSend === true
    return { ok, reason: ok ? '' : '待捕获发送模板' }
  }

  // ── 6. 买家富化（解析链在内核 store：改名 > 通讯录昵称 > raw id） ─────────

  function enrichBuyer(thread, io = {}) {
    const t = thread || {}
    const name = store.resolveName(t.buyerUid, t.buyerSecUid) || ''
    return {
      name,
      avatar: store.resolveAvatar(t.buyerUid, t.buyerSecUid) || '',
      buyerId: t.buyerUid || t.buyerSecUid || '',
      nameKnown: Boolean(name),
    }
  }

  // ── 1/7. 发送模板捕获（抖音专有的"发送中间态"） ───────────────────────────

  /**
   * 捕获发送模板。来自页面自己发私信时上报的请求体。
   *
   * @returns {Promise<boolean>} 是否采信（旧实现仅在 body_b64 存在时处理）
   */
  async function captureSendTemplate(accountId, bodyB64) {
    if (!bodyB64) return false
    const body = Buffer.from(String(bodyB64), 'base64')
    if (!body.length) return false
    templates.set(accountId, body)
    templates.set('_primary', body)
    store.setAccountCanSend(accountId, true)
    void persistTemplate(accountId, body)
    // 从模板里顺手登记 conversation → short_id
    try {
      const info = describeSendTemplate(body)
      if (info.conversation_id) {
        const threadId = store.threadId(accountId, info.conversation_id)
        const thread = store.getThread(threadId)
        if (thread && info.conversation_short_id) thread.conversationShortId = info.conversation_short_id
      }
    } catch (e) {
      lg.warn(`模板字段解析失败（不影响发送）: ${(e && e.message) || e}`)
    }
    lg.info(`已捕获发送模板，账号: ${accountId}`)
    return true
  }

  // ── AI 上下文（业务知识库 + 实时数据） ───────────────────────────────────

  /**
   * 内核 AI 运行时每次回复前调用。抖音实现：整份店规速查 + 一行店铺实时数据。
   *
   * @param {{force?:boolean}} [o]
   * @returns {Promise<{kb:string, kbPath:string, kbError:string, kbDir:string, realtime:object, shopName:string}>}
   */
  async function aiContext(o = {}) {
    const realtime = await readRealtime()
    // 优先「资料库（项目）」：按 thread.accountId 解析项目，和闲鱼共用一套资料
    if (library && o.accountId) {
      try {
        const project = await library.projectForAccount(o.platform || 'douyin', o.accountId)
        if (project) {
          const ctx = await library.buildContext(project.id, o.query || '')
          return {
            kb: ctx.kb || '',
            kbPath: `project:${project.id}`,
            kbError: ctx.kb ? '' : (ctx.error || '项目资料没有命中'),
            kbDir: `project:${project.id}`,
            realtime: realtime || { status: 'unknown' },
            shopName: project.name || shopName,
            project: { id: project.id, name: project.name },
            citations: ctx.citations || [],
          }
        }
        // 已启用资料库但账号没绑项目：明确提示去绑定，不退回旧 `客服知识库`
        return {
          kb: '',
          kbPath: '',
          kbError: '该抖音账号还没分配项目：去「资料库」把它绑到一个项目',
          kbDir: '',
          realtime: realtime || { status: 'unknown' },
          shopName,
          project: null,
          citations: [],
        }
      } catch (e) {
        lg.warn(`资料库上下文失败，退回旧知识库: ${(e && e.message) || e}`)
      }
    }
    await ensureKb(o.force === true)
    return {
      kb: kbText,
      kbPath,
      kbError,
      kbDir: kbDirResolved,
      realtime: realtime || { status: 'unknown' },
      shopName,
      project: null,
      citations: [],
    }
  }

  /**
   * 面板 `/ai/*` 需要的诊断信息（知识库字数 / 店铺来源 / 店铺 MCP 健康度）。
   * 字段名与旧实现 `/dsh-cs-legacy/ai-settings` 响应保持一致。
   */
  async function aiDiagnostics(o = {}) {
    const ctxInfo = await aiContext(o)
    const mcp = await activeShopMcp()
    return {
      kb: {
        path: ctxInfo.kbPath,
        chars: String(ctxInfo.kb || '').length,
        error: ctxInfo.kbError,
        dir: ctxInfo.kbDir,
      },
      project: ctxInfo.project || null,
      realtime: ctxInfo.realtime,
      shopMcp: {
        enabled: Boolean(mcp),
        alive: Boolean(mcp && mcp.alive),
        lastError: (mcp && mcp.lastError) || '',
        lastOkAgoMs: mcp && mcp.lastOkAt ? Date.now() - mcp.lastOkAt : -1,
        // 只读白名单：开台/关台/改库存一律不放进来自动调
        readOnlyTools: ['shop_state', 'stock_list'],
      },
    }
  }

  return {
    spec,
    /**
     * 同一适配器负责的多个 thread.platform 共享同一条 WS 桥。
     * 装配层用这个键把「抖音私信 + 抖音来客」合成一个桥实例。
     */
    bridgeSharingKey: spec.name,
    accountIdOf,
    identifySelf,
    parseInbound,
    send,
    canSend,
    enrichBuyer,
    captureSendTemplate,
    hasSendTemplate,
    aiContext,
    aiDiagnostics,
    /** 插件卸载：停掉店铺 MCP 子进程（旧实现挂在 ctx.effect 的 shutdown 里）。 */
    dispose() {
      try {
        if (shopMcpClient && typeof shopMcpClient.stop === 'function') shopMcpClient.stop()
      } catch {
        /* ignore */
      }
    },
    /** 来客是轮询型平台，但轮询在扩展里做（laike_sync 上报），内核不需要 poll */
    poll: null,
  }
}

/** 把外部日志器归一化成 {info,warn,error,debug}，并统一加平台前缀。 */
function normalizeLog(log, label) {
  const prefix = `[${label}]`
  const safe = (fn, level) => (msg) => {
    try {
      if (typeof fn === 'function') fn(`${prefix} ${msg}`)
      else console[level](`${prefix} ${msg}`)
    } catch {
      /* ignore */
    }
  }
  const l = log && typeof log === 'object' ? log : {}
  return {
    info: safe(l.info, 'log'),
    warn: safe(l.warn, 'warn'),
    error: safe(l.error, 'error'),
    debug: safe(l.debug, 'debug'),
  }
}

export default createDouyinAdapter
