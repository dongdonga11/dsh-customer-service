/**
 * dsh-cs — 平台适配器：闲鱼（Goofish）
 * ============================================================================
 *
 * 行为对齐 Hermes：`plugins/platforms/xianyu/adapter.py`（入站/出站语义）
 * + `extension/injected.js` / `content.js`（扩展协议形状）。
 *
 * 寄生方案：Chrome 扩展在用户已登录的 goofish.com 页面里 hook 消息 WS，把帧原样
 * 回传给本地桥；本适配器解析 → 交给内核落库/AI；回复通过 `send_text` 指令下发，
 * 扩展优先用页面自己的 WS 定向发送（带 chat_id/buyer_id/seller_id），缺定向信息时
 * 退化到 DOM 当前窗口（Hermes 同款兜底，但会明确标注降级）。
 *
 * 与抖音频道的结构差异：
 *   - 帧是 **JSON 文本**（不是 protobuf），消息体在同步包里是 base64(MessagePack)；
 *   - **没有发送模板**（capabilities.requiresSendTemplate=false / sendMode='direct'）；
 *   - 入站需要按 `senderUserId == 自己 unb` 过滤自消息（Hermes adapter.py:194-197）。
 *
 * 内核只通过下列方法交互：
 *   spec / bridgeSharingKey / accountIdOf / identifySelf / parseInbound / send /
 *   canSend / enrichBuyer / aiContext / aiDiagnostics / dispose
 */

import { XIANYU_SPEC } from '../../kernel/config.js'
import { parseFrame, KIND_CARD, KIND_CONFIRM_RECEIPT, KIND_DELIVERY_TRIGGER, KIND_RATE_REQUEST } from './parser.js'
import { mkdir, stat, writeFile, appendFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 平台 id（= thread.platform / spec.name） */
const PLATFORM = 'xianyu'

/** 发送超时：与 Hermes 桥 `send_command_ack` 默认 25s 对齐。 */
const SEND_TIMEOUT_MS = 25000

/**
 * 平台规格。取自 kernel/config.js 的 XIANYU_SPEC（内核里唯一允许出现平台名的地方），
 * 再补上适配器契约要求的字段。
 */
export const spec = {
  ...XIANYU_SPEC,
  /** M1 文档字段名（等价于 config 的 handles） */
  platforms: XIANYU_SPEC.handles,
  /** 同一适配器负责的 thread.platform 取值（M1 契约字段） */
  handles: XIANYU_SPEC.handles,
  /** 该平台 AI 默认生效（`aiSettings.platforms` 为空时） */
  aiDefaultPlatforms: [PLATFORM],
  capabilities: {
    ...XIANYU_SPEC.capabilities,
    sendMode: 'direct',
    requiresSendTemplate: false,
    supportsImages: true,
    supportsPolling: false,
    /** 扩展与抖音不是同一条桥（端口 8765 vs 8766），各自独立 */
    multiPlatformPerConnection: false,
  },
}

/** 握手账号 id：闲鱼是 cookie 里的 unb（extension/content.js:42-56）→ account_id。 */
export function accountIdOf(handshake) {
  const id = handshake && handshake.account_id
  return id ? String(id) : 'default'
}

/**
 * 创建闲鱼适配器。
 *
 * @param {object} opts
 * @param {object} opts.store           kernel Store（只读写，不替换）
 * @param {object} [opts.log]           日志器 {info,warn,error,debug}
 * @param {string} [opts.dataDir]       数据目录（M2 未用；为契约对齐保留）
 * @param {string} [opts.legacyDir]     旧插件目录（M2 未用；留给 M3 话术库）
 * @param {string} [opts.host]          桥地址（仅诊断展示）
 * @param {string} [opts.label]         日志前缀（默认 'dsh-cs'）
 */
export function createXianyuAdapter(opts = {}) {
  const { store, log } = opts
  if (!store) throw new Error('createXianyuAdapter: 缺少 store')
  /** 资料库（kernel library）；有则按「账号→项目」取资料，否则退回旧的全局 knowledge */

  const label = String(opts.label || 'dsh-cs')
  const lg = normalizeLog(log, label)
  /** 数据目录（mtop 诊断日志落这里）；测试可不传 */
  const dataDir = String(opts.dataDir || (store && store.dataDir) || '')
  /** 资料库实例（kernel library，可选） */
  const library = opts.library || null

  /**
   * 已知的「自己」的 user id。
   *
   * Hermes 侧维护 `_account_ids` / `_self_user_ids` 两个集合，并在**每条入站消息**
   * 上把当前 account_id 记进去（adapter.py:132-133）；随后按
   * `send_user_id ∈ self_user_ids || send_user_id == account_id` 丢弃自消息
   * （adapter.py:194-197），防止「自己发的消息被当成买家消息再回一遍」。
   */
  const selfUserIds = new Set()

  function rememberSelf(accountId) {
    const id = String(accountId || '')
    if (id) selfUserIds.add(id)
  }

  /** 把帧时间（`1.5`/`5` 的毫秒）转 ms；拿不到就用当前时间（仅作事件元信息）。 */
  function frameTimeMs(parsed) {
    const raw = parsed && parsed.raw
    try {
      const m1 = raw && raw['1']
      const cand = m1 && typeof m1 === 'object' ? m1['5'] : raw && raw['5']
      const n = Number(cand)
      if (Number.isFinite(n) && n > 0) return n
    } catch {
      /* ignore */
    }
    return Date.now()
  }

  /**
   * Hermes 的「系统事件」文本前缀（adapter.py:206-233）。
   *
   * M2 不做自动交付（那要 product_store 与发送链路，属 M3），所以 delivery_trigger
   * 只走「待发货」分支；卡片消息带上标题。`text`（入库正文）保持干净，
   * 前缀只放在 `agentText` 里给 M3 的 AI 用。
   */
  function agentTextOf(parsed) {
    const text = parsed.send_message || ''
    const tail = `item_id=${parsed.item_id || ''} chat_id=${parsed.chat_id || ''}`
    switch (parsed.kind) {
      case KIND_DELIVERY_TRIGGER:
        return `[系统事件:买家已付款待发货] ${tail}\n${text}`
      case KIND_RATE_REQUEST:
        return `[系统事件:买家发起评价请求] ${tail}\n${text}`
      case KIND_CONFIRM_RECEIPT:
        return `[系统事件:买家确认收货] ${tail}\n${text}`
      case KIND_CARD:
        return `[系统事件:卡片消息 ${parsed.card_title || ''}]\n${text}`
      default:
        return text
    }
  }

  // ── 账号身份识别 ─────────────────────────────────────────────────────────

  /**
   * 从扩展上报里读出身份字段（落库由内核统一处理）。
   *
   * @returns {object} { platform, accountId, nickname?, detectedId?, selfUid?,
   *                     selfSecUid?, connected?, contacts?, refresh? }
   */
  function identifySelf(msg, accountId) {
    const out = { accountId: String(accountId || accountIdOf(msg)) }
    if (!msg || typeof msg !== 'object') return out
    const type = String(msg.type || '')

    if (type === 'platform_account') {
      out.platform = String(msg.platform || PLATFORM)
      out.nickname = String(msg.nickname || '')
      out.detectedId = String(msg.detected_id || '')
      out.selfUid = String(msg.self_uid || msg.account_id || accountId || '')
      out.connected = true
      out.refresh = true
      return out
    }
    if (type === 'account_detected') {
      // 扩展探测到当前登录的 unb（content.js:42-56）→ 既是账号 id 也是 self user id
      out.platform = PLATFORM
      const id = String(msg.account_id || '')
      if (id) {
        out.detectedId = id
        out.selfUid = id
      }
      return out
    }
    if (type === 'account_identity') {
      // 闲鱼侧只有 unb（没有 sec_uid 双 id 体系）
      out.platform = PLATFORM
      const id = String(msg.unb || msg.uid || msg.account_id || '')
      if (id) out.selfUid = id
      return out
    }
    if (type === 'user_info') {
      // mtop.taobao.idlemessage.pc.user.query → 买家 fishNick + logo（买家档案）
      const users = Array.isArray(msg.users) ? msg.users : []
      const contacts = []
      for (const u of users) {
        if (!u || typeof u !== 'object') continue
        const uid = String(u.uid || u.userId || u.user_id || '').trim()
        if (!uid) continue
        contacts.push({
          uid,
          secUid: '',
          nickname: String(u.nickname || u.fishNick || u.nick || '').trim(),
          avatar: String(u.avatar_url || u.avatar || u.logo || '').trim(),
        })
      }
      out.platform = PLATFORM
      out.contacts = contacts
      // 有人名/头像更新 → 面板要刷新（同抖音 user_info 的行为）
      if (contacts.length) out.refresh = true
      return out
    }
    return out
  }

  // ── 入站解析（纯函数：不落库、不发送） ──────────────────────────────────

  /**
   * 把扩展上报的消息解析成内核事件（内核只认
   * message / send_template / account / batch / probe / thread-hint 六种）。
   *
   * @param {object} msg 扩展上报的原始 JSON
   * @param {object} io   { accountId, bridge, store, log }
   * @returns {Array<object>} CsEvent[]
   */
  function parseInbound(msg, io = {}) {
    if (!msg || typeof msg !== 'object') return []
    const accountId = String(io.accountId || msg.account_id || 'default')
    // Hermes：每条入站都登记当前账号为「自己」（adapter.py:132-133）
    rememberSelf(accountId)
    const type = String(msg.type || '')

    switch (type) {
      // 原始 WS 帧（JSON 文本，已 parse）→ 0..N 条买家消息
      case 'frame': {
        let raw = msg.raw
        if (typeof raw === 'string') {
          // 防御：扩展/桥任一侧 stringify 过也能解析（真实链路里是 object）
          try {
            raw = JSON.parse(raw)
          } catch {
            lg.warn('收到无法解析的 frame.raw 字符串，已忽略')
            return []
          }
        }
        let parsedList
        try {
          parsedList = parseFrame(raw)
        } catch (e) {
          lg.warn(`帧解析失败: ${(e && e.message) || e}`)
          return []
        }
        const events = []
        for (const parsed of parsedList) {
          // 过滤自己发出的消息（防回复循环，adapter.py:194-197）
          if (parsed.send_user_id && selfUserIds.has(parsed.send_user_id)) continue
          if (parsed.send_user_id === accountId) continue
          // chat_id 缺失的帧无法定位会话（Hermes 会交给 agent，但会话 key 必须有）
          if (!parsed.chat_id) continue
          const buyerUid =
            parsed.send_user_id && parsed.send_user_id !== 'unknown' ? parsed.send_user_id : ''
          const buyerName = parsed.send_user_name || ''
          // 帧里带的 senderNick 就是买家档案的昵称：顺手落通讯录，面板才能显示名字
          // （内核 recordInbound 不存 buyerName；Hermes 侧对应 customer_store 的 profile 写入）
          if (buyerUid && buyerName && buyerName !== '系统') {
            events.push({
              kind: 'account',
              platform: PLATFORM,
              accountId,
              contacts: [{ uid: buyerUid, secUid: '', nickname: buyerName, avatar: '' }],
            })
          }
          events.push({
            kind: 'message',
            platform: PLATFORM,
            accountId,
            conversationId: parsed.chat_id,
            conversationShortId: '',
            buyerUid,
            buyerName,
            text: parsed.send_message || '',
            // Hermes 无 messageId 时用时间戳兜底（adapter.py:247），保证 AI 幂等有键
            serverMessageId: parsed.message_id
              ? String(parsed.message_id)
              : `xy-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            at: frameTimeMs(parsed),
            // 以下为平台元信息（内核可忽略；M3 AI 用 agentText）
            xianyuKind: parsed.kind,
            itemId: parsed.item_id || '',
            cardTitle: parsed.card_title || '',
            msgTime: parsed.msg_time || '',
            agentText: agentTextOf(parsed),
          })
        }
        return events
      }

      // 账号身份 / 买家档案
      case 'platform_account':
      case 'account_detected':
      case 'account_identity':
      case 'user_info': {
        const id = identifySelf(msg, accountId)
        if (id.selfUid) rememberSelf(id.selfUid)
        return [toAccountEvent(id, accountId)]
      }

      // 登录态：在线/离线（Hermes adapter.py:135-144）
      case 'login_state': {
        const online = Boolean(msg.online)
        const events = [
          {
            kind: 'account',
            platform: PLATFORM,
            accountId,
            connected: online,
            refresh: true,
          },
        ]
        if (!online) {
          events.push({
            kind: 'probe',
            platform: PLATFORM,
            accountId,
            note: '闲鱼登录态',
            data: { online: false, hint: '登录失效，请在浏览器重新登录 goofish.com' },
          })
        }
        return events
      }

      // 风控/验证页告警（Hermes adapter.py:146-154）
      case 'risk_alert':
        return [
          {
            kind: 'probe',
            platform: PLATFORM,
            accountId,
            note: '闲鱼风控告警',
            data: { detail: String(msg.detail || '出现风控/验证页') },
          },
        ]

      // 页面消息长连接已 hook
      case 'ws_hooked':
        return [{ kind: 'account', platform: PLATFORM, accountId, connected: true }]

      // 页面当前打开的会话（injected.js 钩出站帧得到）→ 只补会话元信息，不建会话
      case 'current_chat': {
        const chatId = stripAt(msg.chat_id)
        if (!chatId) return []
        const ev = {
          kind: 'thread-hint',
          platform: PLATFORM,
          accountId,
          conversationId: chatId,
        }
        const buyerId = String(msg.buyer_id || '')
        if (buyerId) ev.buyerUid = buyerId
        return [ev]
      }

      default:
        // 其它类型（Hermes 也忽略）
        return []
    }
  }

  /** identifySelf 结果 → 内核 account 事件。 */
  function toAccountEvent(id, accountId) {
    const ev = {
      kind: 'account',
      platform: id.platform || PLATFORM,
      accountId: id.accountId || accountId,
    }
    if (id.nickname) ev.nickname = id.nickname
    if (id.detectedId) ev.detectedId = id.detectedId
    if (id.selfUid) ev.selfUid = id.selfUid
    if (id.selfSecUid) ev.selfSecUid = id.selfSecUid
    if (id.connected !== undefined) ev.connected = id.connected === true
    if (Array.isArray(id.contacts) && id.contacts.length) ev.contacts = id.contacts
    if (id.refresh) ev.refresh = true
    return ev
  }

  function stripAt(value) {
    const s = String(value || '')
    return s.includes('@') ? s.split('@')[0] : s
  }

  // ── 发送 ─────────────────────────────────────────────────────────────────

  function resolveRequest(io) {
    if (io && typeof io.request === 'function') return io.request
    const bridge = io && io.bridge
    if (bridge && typeof bridge.sendCommandAck === 'function') {
      return (cmd, acct, timeout) => bridge.sendCommandAck(cmd, acct, timeout)
    }
    return null
  }

  /**
   * 文本发送通道：闲鱼扩展的 `send_text` **没有 cmd_result 回执**（Hermes 也是
   * fire-and-forget，tools.py:298-302），所以必须用 `sendCommand`（返回 bool），
   * 不能用 `sendCommandAck` —— 否则每条文本都要白等 25s 超时、面板显示发送失败。
   * 只有在没有 sendCommand 的旧桥/测试替身上才退回 request。
   */
  function resolveSendText(io) {
    if (io && typeof io.sendText === 'function') return io.sendText
    const bridge = io && io.bridge
    if (bridge && typeof bridge.sendCommand === 'function') {
      return (cmd, acct) => Promise.resolve({ ok: bridge.sendCommand(cmd, acct) === true })
    }
    return resolveRequest(io)
  }

  /**
   * 发送文本：下发 `send_text` 指令（扩展优先页面 WS 定向，缺信息退 DOM）。
   *
   * 命令形状对齐 Hermes（tools.py:298-302 / extension/content.js:146-171）：
   * `{type:'send_text', chat_id, buyer_id, seller_id, text}`
   *
   * @returns {Promise<{ok:boolean, error?:string, serverMessageId?:string, server_message_id?:string}>}
   */
  async function send(thread, text, io = {}) {
    if (!thread) return { ok: false, error: '会话不存在' }
    const content = typeof text === 'string' ? text : String(text == null ? '' : text)
    if (!content) return { ok: false, error: 'text 不能为空' }

    const request = resolveSendText(io)
    if (!request) return { ok: false, error: '桥不可用（无法下发发送指令）' }

    const accountId = String(thread.accountId || '')
    const chatId = String(thread.conversationId || '')
    const buyerId = String(thread.buyerUid || '')

    // 出站回声：内核的 echo 表只拦 message 事件里的同文本；这里再记一次，
    // 覆盖「扩展把自己的消息回推成帧、但 sender 字段缺失」的边缘情况。
    try {
      if (io.echo && typeof io.echo.remember === 'function') io.echo.remember(accountId, content)
    } catch {
      /* ignore */
    }

    let res
    try {
      res = await request(
        {
          type: 'send_text',
          chat_id: chatId,
          buyer_id: buyerId,
          seller_id: accountId,
          text: content,
        },
        accountId,
        SEND_TIMEOUT_MS,
      )
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
    if (!res || res.ok !== true) {
      return { ok: false, error: String((res && res.error) || '下发发送指令失败') }
    }

    // Hermes 成功时用时间戳兜底 message_id（adapter.py:315）
    const id = String(Date.now())
    return { ok: true, serverMessageId: id, server_message_id: id }
  }

  /**
   * 发送图片：`send_image` + image_url（Hermes tools.py:304-311 / content.js:174-179）。
   * M2 内核还没有图片入口（routes 未暴露），先提供方法给 M3/装配层调用。
   *
   * @returns {Promise<{ok:boolean, error?:string, serverMessageId?:string, server_message_id?:string}>}
   */
  async function sendImage(thread, imageUrl, io = {}) {
    if (!thread) return { ok: false, error: '会话不存在' }
    const url = String(imageUrl || '')
    if (!url) return { ok: false, error: 'image_url 不能为空' }
    const request = resolveRequest(io)
    if (!request) return { ok: false, error: '桥不可用（无法下发发送指令）' }

    const accountId = String(thread.accountId || '')
    const chatId = String(thread.conversationId || '')
    const buyerId = String(thread.buyerUid || '')
    // 发图没有 DOM 兜底：必须能定向到买家（Hermes tools.py:288-293）
    if (!chatId || !buyerId) {
      return {
        ok: false,
        error: '发图需要 chat_id + buyer_id 才能定向；请让买家先发一条消息（建立会话）后再发图',
      }
    }

    let res
    try {
      res = await request(
        {
          type: 'send_image',
          chat_id: chatId,
          buyer_id: buyerId,
          seller_id: accountId,
          image_url: url,
        },
        accountId,
        SEND_TIMEOUT_MS,
      )
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
    if (!res || res.ok !== true) {
      return { ok: false, error: String((res && res.error) || '下发图片指令失败') }
    }
    const id = String(Date.now())
    return { ok: true, serverMessageId: id, server_message_id: id }
  }

  /**
   * 是否具备发送条件。闲鱼是直发通道：**桥在线即可发**；
   * 缺 chat_id / buyer_id 时仍允许（扩展退 DOM 当前窗口），但必须标注降级。
   *
   * `subject` 可能是 **会话行**（thread，带 conversationId/buyerUid），
   * 也可能是**账号卡行**（account，只带 id）—— 内核 `/state` 走的是后者（desk.listAccounts），
   * 所以账号 id 两个字段都认：`accountId || id`。
   */
  function canSend(subject, io = {}) {
    const s = subject || {}
    const accountId = String(s.accountId || s.id || '')
    const bridge = io.bridge
    const paired = Boolean(bridge && typeof bridge.hasAccount === 'function' && bridge.hasAccount(accountId))
    // 与抖音适配器一致：桥上有该账号连接 **且** 账号未被标记断开
    const online = paired && s.connected !== false
    if (!online) return { ok: false, reason: '闲鱼扩展未接入' }
    // 账号卡行没有会话字段：此时只判断「桥在线就能发」，不报缺字段
    const isAccountRow = s.id !== undefined && s.accountId === undefined && s.conversationId === undefined
    if (isAccountRow) return { ok: true, reason: '' }
    const missing = []
    if (!s.conversationId) missing.push('chat_id')
    if (!s.buyerUid) missing.push('buyer_id')
    if (missing.length === 0) return { ok: true, reason: '' }
    return {
      ok: true,
      reason: `缺少 ${missing.join('/')}：将退化为 DOM「当前窗口」发送（可能发错窗口）`,
    }
  }

  // ── 买家富化 ─────────────────────────────────────────────────────────────

  /**
   * 展示名解析：thread.buyerName（帧里带的 senderNick）优先 →
   * 买家档案/通讯录昵称 → 都没有则 nameKnown=false（面板回退显示 id）。
   */
  function enrichBuyer(thread, io = {}) {
    const t = thread || {}
    const st = (io && io.store) || store
    let name = String(t.buyerName || '')
    let nameKnown = Boolean(name)
    if (!name) {
      try {
        name = st.resolveName(t.buyerUid, t.buyerSecUid) || ''
      } catch {
        name = ''
      }
      nameKnown = Boolean(name)
    }
    let avatar = ''
    try {
      avatar = st.resolveAvatar(t.buyerUid, t.buyerSecUid) || ''
    } catch {
      avatar = ''
    }
    return {
      name,
      avatar,
      buyerId: String(t.buyerUid || t.buyerSecUid || ''),
      nameKnown,
    }
  }

  // ── AI 上下文：店规/话术库（M3） ─────────────────────────────────────────

  /**
   * 知识库目录优先级：显式 env > `<dataDir>/knowledge` > `<dataDir>/kb`。
   * 内容 = 目录下所有 .md/.txt 按文件名排序拼接（带「## 文件名」小节标题），
   * 超过 20000 字截断（与 Hermes 侧知识库整份塞 prompt 的策略一致，后续可换检索）。
   */
  const KB_TTL_MS = 60000
  const KB_MAX_CHARS = 20000
  let kbCache = { at: 0, text: '', dir: '', path: '', error: '' }

  function kbDirCandidates() {
    const out = []
    if (process.env.DSH_CS_KB_DIR) out.push(String(process.env.DSH_CS_KB_DIR))
    if (dataDir) { out.push(join(dataDir, 'knowledge')); out.push(join(dataDir, 'kb')) }
    return out
  }

  async function loadKb(force = false) {
    if (!force && Date.now() - kbCache.at < KB_TTL_MS) return kbCache
    const errors = []
    for (const dir of kbDirCandidates()) {
      try {
        const names = (await readdir(dir)).filter((n) => /\.(md|txt)$/i.test(n)).sort()
        if (!names.length) { errors.push(`${dir} 下没有 .md/.txt`); continue }
        const parts = []
        const paths = []
        for (const name of names) {
          try {
            const text = String(await readFile(join(dir, name), 'utf8')).trim()
            if (!text) continue
            parts.push(`## ${name.replace(/\.(md|txt)$/i, '')}\n${text}`)
            paths.push(join(dir, name))
          } catch { /* 单文件读失败跳过 */ }
        }
        const text = parts.join('\n\n').slice(0, KB_MAX_CHARS)
        if (text) {
          kbCache = { at: Date.now(), text, dir, path: paths.join(';'), error: '' }
          return kbCache
        }
        errors.push(`${dir} 下文件为空`)
      } catch (e) {
        errors.push(`${dir}: ${(e && e.code) || (e && e.message) || '不可读'}`)
      }
    }
    kbCache = {
      at: Date.now(),
      text: '',
      dir: kbDirCandidates()[0] || '',
      path: '',
      error: `未找到话术库（把 .md/.txt 放到 ${join(dataDir || '$DSH_HOME/dsh-cs', 'knowledge')}/）; ${errors.slice(0, 2).join('; ')}`,
    }
    return kbCache
  }

  /**
   * 内核 AI 运行时每次回复前调用。
   * 优先走「资料库（项目）」；没绑定项目才退回旧的全局 knowledge。两条都空 → 内核转人工。
   */
  async function aiContext({ force = false, accountId = '', platform = PLATFORM, query = '' } = {}) {
    if (library && accountId) {
      try {
        const ctx = await library.contextForAccount({ platform: platform || PLATFORM, accountId, query })
        if (ctx && !ctx.project) {
          // 已启用资料库但该账号没绑项目：明确告知去绑定，不偷偷退回旧全局话术库
          return {
            kb: '',
            kbPath: '',
            kbError: '该闲鱼账号还没分配项目：去「资料库」把它绑到一个项目',
            kbDir: '',
            realtime: null,
            shopName: '',
            project: null,
            citations: [],
          }
        }
        if (ctx && (ctx.kb || ctx.project)) {
          return {
            kb: ctx.kb || '',
            kbPath: '',
            kbError: ctx.kb ? '' : (ctx.error || '项目资料没有命中'),
            kbDir: ctx.project ? `project:${ctx.project.id}` : '',
            realtime: null,
            shopName: (ctx.project && ctx.project.name) || '',
            project: ctx.project || null,
            citations: ctx.citations || [],
          }
        }
      } catch (e) {
        lg.warn(`资料库上下文失败，退回全局知识库: ${(e && e.message) || e}`)
      }
    }
    const kb = await loadKb(force)
    return {
      kb: kb.text,
      kbPath: kb.path,
      kbError: kb.error,
      kbDir: kb.dir,
      realtime: null,
      shopName: '',
      project: null,
      citations: [],
    }
  }

  /** 面板 `/ai-settings` 的诊断字段（含项目名/字数）。 */
  async function aiDiagnostics({ force = false, accountId = '', platform = PLATFORM } = {}) {
    if (library && accountId) {
      try {
        const project = await library.projectForAccount(platform || PLATFORM, accountId)
        if (project) {
          let chars = 0
          let chunks = 0
          try {
            const idx = await library.buildIndex(project.id)
            chunks = idx.chunks.length
            chars = idx.chunks.reduce((n, c) => n + (c.len || 0), 0)
          } catch { /* ignore */ }
          // 规则层（AGENTS.md）不计入索引，但要统计进「可读字数」
          let rulesChars = 0
          try {
            const r = await library.rules(project.id)
            rulesChars = r.chars || 0
          } catch { /* ignore */ }
          return {
            kb: {
              path: `project:${project.id}`,
              dir: `project:${project.id}`,
              chars: chars + rulesChars,
              error: chars + rulesChars || project.pinned.length ? '' : '项目资料为空（去「资料库」上传文档）',
            },
            project: { id: project.id, name: project.name, chunks, pinned: project.pinned.length, rulesChars },
            realtime: { status: 'unknown' },
            shopMcp: { enabled: false, alive: false, lastError: '', lastOkAgoMs: -1, readOnlyTools: [] },
          }
        }
        // 已启用资料库但账号没绑项目：明确提示（不退回旧全局话术库）
        return {
          kb: { path: '', chars: 0, dir: '', error: '该闲鱼账号还没分配项目：去「资料库」把它绑到一个项目' },
          project: null,
          realtime: { status: 'unknown' },
          shopMcp: { enabled: false, alive: false, lastError: '', lastOkAgoMs: -1, readOnlyTools: [] },
        }
      } catch (e) {
        lg.warn(`资料库诊断失败: ${(e && e.message) || e}`)
      }
    }
    const kb = await loadKb(force)
    return {
      kb: { path: kb.path, chars: kb.text.length, error: kb.error, dir: kb.dir },
      project: null,
      realtime: { status: 'unknown' },
      shopMcp: { enabled: false, alive: false, lastError: '', lastOkAgoMs: -1, readOnlyTools: [] },
    }
  }

  // ── 扩展接口调用（mtop / 发品 / 读页面）──────────────────────────────────
  //
  // 对齐 Hermes `_mtop()`：Python 侧只把 {api,version,data} 交给扩展，扩展用页面
  // 登录态签名直发；这里同样只做转发 + 结果归一，不碰签名。
  const MTOP_DEBUG_FILE = dataDir ? join(dataDir, 'mtop_debug.log') : ''
  const MTOP_DEBUG_MAX_BYTES = 512 * 1024

  async function appendMtopDebug(entry) {
    if (!MTOP_DEBUG_FILE || process.env.DSH_CS_MTOP_DEBUG === 'off') return
    try {
      await mkdir(dataDir, { recursive: true })
      let size = 0
      try { size = (await stat(MTOP_DEBUG_FILE)).size } catch { size = 0 }
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
      if (size > MTOP_DEBUG_MAX_BYTES) await writeFile(MTOP_DEBUG_FILE, line, 'utf8')
      else await appendFile(MTOP_DEBUG_FILE, line, 'utf8')
    } catch {
      /* 诊断日志失败绝不影响主链路 */
    }
  }

  function resolveCallApi(io) {
    if (io && typeof io.callApi === 'function') return io.callApi
    const bridge = io && io.bridge
    if (bridge && typeof bridge.callApi === 'function') {
      return (action, args, acct, timeout) => bridge.callApi(action, args, acct, timeout)
    }
    return null
  }

  /** 调扩展任意 call_api 动作（mtop / publish_item / read_page），返回扩展原样 data。 */
  async function callApiRaw({ action, args = {}, accountId = '', timeout = 20000 } = {}, io = {}) {
    const call = resolveCallApi(io)
    if (!call) return { ok: false, error: '桥不可用（无法调用扩展接口）' }
    try {
      const raw = await call(String(action), args || {}, String(accountId), Number(timeout) || 20000)
      if (raw === undefined) return { ok: false, error: '扩展无响应（页面未打开/未登录/超时）' }
      return { ok: true, data: raw }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  /**
   * mtop 调用（对齐 Hermes tools.py `_mtop`）。
   * @returns {{ok:boolean, ret?:string, ret_all?:string[], data?:any, raw?:any, error?:string, api?:string}}
   */
  async function callApi({
    api,
    version = '1.0',
    data = {},
    accountId = '',
    timeout = 25000,
    injectUnbAs = '',
    appKey = '',
  } = {}, io = {}) {
    if (!api) return { ok: false, error: 'api 不能为空' }
    const args = { api: String(api), version: String(version || '1.0'), data: data && typeof data === 'object' ? data : {} }
    if (injectUnbAs) args.inject_unb_as = String(injectUnbAs)
    if (appKey) args.app_key = String(appKey)
    const res = await callApiRaw({ action: 'mtop', args, accountId, timeout: Number(timeout) || 25000 }, io)
    if (!res.ok) return { ok: false, error: res.error, api: args.api }
    const raw = res.data
    const ret = Array.isArray(raw && raw.ret) ? raw.ret : []
    const retText = String(ret[0] || '')
    const out = {
      ok: retText.includes('SUCCESS'),
      ret: retText,
      ret_all: ret,
      data: (raw && raw.data) !== undefined ? raw.data : null,
      raw,
      api: args.api,
    }
    await appendMtopDebug({ api: args.api, version: args.version, args, raw })
    return out
  }

  return {
    spec,
    /** 闲鱼与抖音各自一条桥（端口不同），不共享 */
    bridgeSharingKey: PLATFORM,
    accountIdOf,
    identifySelf,
    parseInbound,
    send,
    sendImage,
    canSend,
    enrichBuyer,
    aiContext,
    aiDiagnostics,
    /** 扩展接口调用（mtop 归一 / 任意动作原样）——工具层用 */
    callApi,
    callApiRaw,
    /** 无子进程/长连接需要释放（桥由装配层管） */
    dispose() {},
    /** 闲鱼是推送型（帧由扩展上报），内核不需要 poll */
    poll: null,
  }
}

/** 日志器归一化（与抖音适配器同款前缀约定）。 */
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

export default createXianyuAdapter
