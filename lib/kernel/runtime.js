/**
 * dsh-cs kernel — 客服运行时（平台无关）
 *
 * 职责：
 *   1. `apply(msg, accountId)`：桥的入站总入口。内建 `_paired` / `_disconnected`，
 *      其余消息交给对应平台适配器的 `parseInbound()` → `applyEvent()`
 *   2. 事件落库：消息/批量同步/账号身份/模板捕获/诊断（含回声抑制与去重）
 *   3. AI 自动回复运行时：闸门（幂等/人工优先/静默期/最小间隔/时效/退避）、
 *      审计、发送前复查、会话级接管
 *   4. `sendToThread()`：按 thread.platform 找适配器发送；`sendHuman()`：人工回复
 *      + 自动转人工接管
 *   5. 供 HTTP 层（lib/kernel/routes.js）调用的读接口与 bus 订阅
 *
 * 本文件不得出现平台专有字符串：平台差异只经由 adapter 方法 / spec 获得。
 * 行为基线：lib/_legacy/index.js 106–154（回声/去重）、217–390（入站）、
 * 407–649（AI 运行时）、650–660（刷新）、757–802（人工发送后处理）、
 * 890–1029（AI 设置/测试/日志/模式）。
 */

import {
  buildSystemPrompt,
  buildMessages,
  planReply,
  runReply,
  parseModelOutput,
} from './ai.js'
import { adapterFor, bridgeFor, listAccounts, listThreads, listPlatforms } from './desk.js'

// ── 回声抑制：出站时记 (account, text)，入站命中即丢弃 ─────────────────────
const ECHO_TTL_MS = 25000
const ECHO_MAX = 256

// ── 消息去重（有界，基于 server_message_id / frontier msg_id）───────────────
const DEDUPE_LIMIT = 2048

/** 简单的进程内事件总线（供 SSE 用）。 */
export function createBus() {
  const subs = new Set()
  return {
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {}
      subs.add(fn)
      return () => subs.delete(fn)
    },
    emit(event, payload) {
      for (const fn of [...subs]) {
        try {
          fn(event, payload)
        } catch {
          /* 订阅者异常不得影响主流程 */
        }
      }
    },
    get size() {
      return subs.size
    },
  }
}

/**
 * 创建客服运行时。
 *
 * @param {object} opts
 * @param {object} [opts.ctx]        DSH ctx（用于 ctx.inject(['llm'])，可为 null：离线测试）
 * @param {object} [opts.config]     resolveConfig() 的结果（可选：label/ports）
 * @param {object} opts.store        kernel Store
 * @param {Array}  opts.adapters     平台适配器列表
 * @param {object} [opts.bus]        createBus() 的结果；不传则内部建一个
 * @param {object} [opts.bridges]    桥（单个或数组）；也可后续 attachBridge()
 * @param {object} [opts.log]        日志器 {info,warn,error,debug}
 */
export function createRuntime(opts = {}) {
  const { ctx = null, config = {}, store } = opts
  if (!store) throw new Error('createRuntime: 缺少 store')
  // ⚠️ 适配器/桥列表**保持调用方传入的数组引用**：装配层是「先建 runtime、
  //    再按平台懒加载 adapter 并 push」的模式（lib/index.js），复制会永远看到空。
  const adapters = Array.isArray(opts.adapters) ? opts.adapters : opts.adapters ? [opts.adapters] : []
  const bus = opts.bus && typeof opts.bus.emit === 'function' ? opts.bus : createBus()
  const label = String(config.label || opts.label || 'dsh-cs')
  const log = normalizeLog(opts.log, label)

  const bridges = Array.isArray(opts.bridges) ? opts.bridges : opts.bridges ? [opts.bridges] : []
  let started = false
  let disposed = false
  /** 事件旁路钩子（自动交付/通知等；见 onEvent） */
  const eventHooks = new Set()

  // ── 回声 / 去重状态 ───────────────────────────────────────────────────────
  const echoStore = new Map() // "account\0text" -> ts
  const seenOrder = []
  const seenIds = new Set()

  function rememberOutbound(accountId, text) {
    const t = (text || '').trim()
    if (!t) return
    const now = Date.now()
    echoStore.set(`${accountId || 'default'}\0${t}`, now)
    if (echoStore.size > ECHO_MAX) {
      for (const [k, ts] of echoStore) {
        if (now - ts > ECHO_TTL_MS) echoStore.delete(k)
      }
      while (echoStore.size > ECHO_MAX) {
        const oldest = [...echoStore.keys()].reduce((a, b) => (echoStore.get(a) < echoStore.get(b) ? a : b))
        echoStore.delete(oldest)
      }
    }
  }

  function isOwnEcho(accountId, text) {
    const t = (text || '').trim()
    if (!t) return false
    const key = `${accountId || 'default'}\0${t}`
    const ts = echoStore.get(key)
    if (ts === undefined) return false
    if (Date.now() - ts > ECHO_TTL_MS) {
      echoStore.delete(key)
      return false
    }
    echoStore.delete(key)
    return true
  }

  function isDuplicate(messageId) {
    if (!messageId) return false
    if (seenIds.has(messageId)) return true
    seenIds.add(messageId)
    seenOrder.push(messageId)
    while (seenOrder.length > DEDUPE_LIMIT) seenIds.delete(seenOrder.shift())
    return false
  }

  // ── 桥 / 适配器解析 ───────────────────────────────────────────────────────

  function attachBridge(bridge) {
    if (!bridge) return
    if (!bridges.includes(bridge)) bridges.push(bridge)
  }

  function setBridgeStarted(ok) {
    started = Boolean(ok)
  }

  /** 消息归属的平台：消息自带 platform 优先，其次按「哪条桥登记了这个账号」判定（多桥不能取第一条），最后用唯一适配器兜底。 */
  function platformOfMessage(msg, accountId) {
    if (msg && msg.platform) return String(msg.platform)
    for (const b of bridges) {
      if (!b || typeof b.platformOf !== 'function') continue
      if (typeof b.hasAccount === 'function' && !b.hasAccount(accountId)) continue
      try {
        const platform = b.platformOf(accountId)
        if (platform) return platform
      } catch {
        /* ignore */
      }
    }
    for (const b of bridges) {
      if (b && typeof b.platformOf === 'function') {
        try { return b.platformOf(accountId) } catch { /* ignore */ }
      }
    }
    return ''
  }

  function adapterOf(platform) {
    const hit = adapterFor(adapters, platform)
    if (hit) return hit
    return adapters.length === 1 ? adapters[0] : null
  }

  /** 适配器的 io 上下文（桥指令 + store + 回声 + 日志）。 */
  function makeIo(adapter, accountId) {
    const bridge = bridgeFor(adapters, bridges, adapter)
    return {
      accountId,
      bridge,
      store,
      log,
      echo: { remember: rememberOutbound, consume: isOwnEcho },
      /**
       * 无回执的文本发送通道（fire-and-forget）。
       * 平台协议里「发文本没有 cmd_result」时走这里；需要回执的（发图/mtop）用 request。
       */
      sendText: (cmd, acct) => {
        try {
          if (bridge && typeof bridge.sendCommand === 'function') return Promise.resolve({ ok: bridge.sendCommand(cmd, acct) === true })
        } catch (e) {
          return Promise.resolve({ ok: false, error: String((e && e.message) || e) })
        }
        return Promise.resolve({ ok: false, error: '桥不可用' })
      },
      request: (cmd, acct, timeout) => {
        if (bridge && typeof bridge.sendCommandAck === 'function') return bridge.sendCommandAck(cmd, acct, timeout)
        return Promise.resolve({ ok: false, error: '桥未启动' })
      },
      /** 请求-响应式调用（扩展 call_api：mtop / 发品 / 读页面），返回扩展原样 data。 */
      callApi: (action, args, acct, timeout) => {
        if (bridge && typeof bridge.callApi === 'function') return bridge.callApi(action, args, acct, timeout)
        return Promise.resolve(undefined)
      },
    }
  }

  // ── 事件应用 ──────────────────────────────────────────────────────────────

  function emitRefresh() {
    bus.emit('refresh', {})
  }

  /**
   * 桥入站总入口（桥的 setInboundHandler 直接指向它）。
   *
   * @param {object} msg        扩展上报的原始 JSON
   * @param {string} accountId  桥判定的账号归属
   */
  function apply(msg, accountId) {
    if (disposed || !msg || typeof msg !== 'object') return
    const type = String(msg.type || '')
    const acct = String(accountId || msg.account_id || 'default')

    // 桥已内建消费的两种响应（正常不会到这里；防御性忽略）
    if (type === 'api_result' || type === 'cmd_result') return

    // ── 内核内建类型 ──────────────────────────────────────────────────────
    if (type === '_paired') {
      store.upsertAccount({ id: acct, connected: true })
      emitRefresh()
      return
    }
    if (type === '_disconnected') {
      store.setAccountConnected(acct, false)
      emitRefresh()
      return
    }

    const platform = platformOfMessage(msg, acct)
    const adapter = adapterOf(platform)
    if (!adapter) {
      log.debug(`没有适配器处理消息类型 ${type}（platform=${platform || '?'}）`)
      return
    }

    let events
    try {
      events = adapter.parseInbound(msg, makeIo(adapter, acct)) || []
    } catch (e) {
      log.error(`入站解析失败（${type}）: ${(e && e.stack) || e}`)
      return
    }
    for (const ev of events) {
      try {
        applyEvent(ev, adapter)
      } catch (e) {
        log.error(`事件应用失败（${(ev && ev.kind) || '?'}）: ${(e && e.stack) || e}`)
      }
      // 平台/装配层的事件钩子（自动交付、通知等旁路能力；失败绝不影响主链路）
      for (const hook of eventHooks) {
        try {
          Promise.resolve(hook(ev, adapter)).catch((e) => log.warn(`事件钩子失败: ${(e && e.message) || e}`))
        } catch (e) {
          log.warn(`事件钩子异常: ${(e && e.message) || e}`)
        }
      }
    }
  }

  /**
   * 注册「事件旁路钩子」：主链路（落库/未读/SSE）完成之后调用，
   * 用于自动交付、通知等附加动作。返回注销函数。
   */
  function onEvent(fn) {
    if (typeof fn !== 'function') return () => {}
    eventHooks.add(fn)
    return () => eventHooks.delete(fn)
  }

  /** 应用单条 CsEvent。 */
  function applyEvent(ev, adapter) {
    if (!ev || !ev.kind) return
    const accountId = String(ev.accountId || 'default')

    switch (ev.kind) {
      // 抖音私信：一帧可能含多条消息 → 逐条去重后入库
      case 'message': {
        if (!ev.text) return
        if (isOwnEcho(accountId, ev.text)) return
        if (isDuplicate(ev.serverMessageId)) return
        store.recordInbound({
          accountId,
          platform: ev.platform || (adapter && adapter.spec && adapter.spec.name) || '',
          conversationId: ev.conversationId,
          conversationShortId: ev.conversationShortId,
          buyerUid: ev.buyerUid,
          buyerSecUid: ev.buyerSecUid,
          buyerName: ev.buyerName,
          buyerAvatar: ev.buyerAvatar,
          text: ev.text,
          // 服务端消息 id：AI 闸门靠它做幂等，缺失则不会自动回复
          messageId: ev.serverMessageId || ev.messageId || '',
        })
        // 单聊里「不是发送者的那一侧」就是我们自己 —— 自举出自身 uid，
        // 用来在通讯录里认出「自己」，从而把账号名显示成昵称而不是一堆 id。
        if (ev.counterpartUid) store.upsertAccount({ id: accountId, selfUid: ev.counterpartUid })
        emitRefresh()
        return
      }

      // 发送模板捕获（平台专有中间态，交给适配器处理）
      case 'send_template': {
        if (!adapter || typeof adapter.captureSendTemplate !== 'function') return
        Promise.resolve(adapter.captureSendTemplate(accountId, ev.bodyB64)).catch((e) => {
          log.error(`发送模板捕获失败: ${(e && e.message) || e}`)
        })
        return
      }

      // 账号身份 / 昵称 / 头像 / 连接态
      case 'account':
        applyAccountEvent(ev, accountId)
        return

      // 轮询型平台的批量同步（幂等合并 + 触发 AI）
      case 'batch': {
        const threads = Array.isArray(ev.threads) ? ev.threads : []
        for (const t of threads) {
          if (!t || !t.conversationId) continue
          const th = store.syncThreadMessages({
            accountId,
            platform: String(ev.platform || ''),
            conversationId: String(t.conversationId),
            conversationShortId: String(t.conversationShortId || ''),
            buyerUid: String(t.buyerUid || ''),
            buyerSecUid: String(t.buyerSecUid || ''),
            buyerName: String(t.buyerName || ''),
            buyerAvatar: String(t.buyerAvatar || ''),
            unread: Number.isFinite(t.unread) ? t.unread : undefined,
            messages: Array.isArray(t.messages) ? t.messages : [],
          })
          // 新消息进来 → 预约一次 AI 回复（静默期后执行，合并连发）
          if (th) scheduleAi(th.id, store.getAiSettings().silenceMs)
        }
        if (threads.length > 0) emitRefresh()
        return
      }

      // 平台诊断 dump：只打日志，不打库
      case 'probe': {
        const note = String(ev.note || '诊断')
        log.info(`${note}(${accountId}): ${JSON.stringify(ev.data || {}).slice(0, 4000)}`)
        return
      }

      // 会话级提示（页面当前打开的会话里有更可靠的买家 id）
      case 'thread-hint': {
        if (!ev.conversationId) return
        const threadId = store.threadId(accountId, ev.conversationId, ev.platform || (adapter && adapter.spec && adapter.spec.name))
        const thread = store.getThread(threadId)
        if (thread && ev.buyerSecUid && !thread.buyerSecUid) thread.buyerSecUid = ev.buyerSecUid
        return
      }

      default:
        log.debug(`未知事件类型: ${ev.kind}`)
    }
  }

  /**
   * 账号事件：先落通讯录（昵称/头像），再落账号字段，最后处理「认出自己」规则。
   *
   * 规则（旧实现同）：通讯录里能认出自己 → 账号名 = 自己昵称；
   * 认不出且还没有可用账号名 → 先用上报里的第一个昵称兜底。
   */
  function applyAccountEvent(ev, accountId) {
    if (Array.isArray(ev.contacts)) {
      for (const c of ev.contacts) {
        if (!c) continue
        store.upsertContact(c)
      }
    }
    const patch = { id: accountId }
    if (ev.platform) patch.platform = String(ev.platform)
    if (ev.nickname) patch.nickname = String(ev.nickname)
    if (ev.detectedId) patch.detectedId = String(ev.detectedId)
    if (ev.selfUid) patch.selfUid = String(ev.selfUid)
    if (ev.selfSecUid) patch.selfSecUid = String(ev.selfSecUid)
    if (ev.connected !== undefined) patch.connected = ev.connected === true
    store.upsertAccount(patch)

    if (ev.guessedNickname !== undefined) {
      const acc = store.getAccount(accountId)
      const selfName = store.resolveName(acc && acc.selfUid, acc && acc.selfSecUid)
      if (selfName) {
        // 已经在通讯录里认出了自己 → 账号名用它（确定值）
        store.upsertAccount({ id: accountId, nickname: selfName })
      } else if (!store.resolveAccountName(acc) && ev.guessedNickname) {
        // 还没认出自己：先用第一个昵称兜底
        store.upsertAccount({ id: accountId, nickname: ev.guessedNickname })
      }
    }

    if (ev.refresh) emitRefresh()
  }

  // ── AI 自动回复运行时 ─────────────────────────────────────────────────────

  let llmService = null
  let agentDefault = null
  if (ctx && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['llm'], (scoped) => {
        llmService = scoped.llm
      })
      ctx.inject(['agentDefaultModel'], (scoped) => {
        agentDefault = scoped.agentDefaultModel
      })
    } catch (e) {
      log.error(`llm 服务注入失败（AI 不可用，其余功能照常）: ${(e && e.message) || e}`)
    }
  }

  /** 调模型：走宿主 llm 服务，把流式增量拼成整段。 */
  async function callModel({ system, messages, signal }) {
    if (!llmService) throw new Error('llm 服务不可用')
    const s = store.getAiSettings()
    const sel = currentSelection()
    const provider = s.provider || sel.provider || ''
    const model = s.model || sel.model || ''
    if (!provider || !model) throw new Error('没有可用模型（未指定且拿不到默认模型）')

    let text = ''
    for await (const chunk of llmService.stream({ provider, model, system, messages, signal })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') text += chunk.text || ''
      else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        throw new Error((chunk.reason.failure && chunk.reason.failure.message) || '模型返回错误')
      }
    }
    return text
  }

  function currentSelection() {
    try {
      if (agentDefault && typeof agentDefault.currentSelection === 'function') return agentDefault.currentSelection() || {}
    } catch {
      /* ignore */
    }
    return {}
  }

  const aiTimers = new Map() // threadId -> timer
  const aiBusy = new Set() // 正在跑的会话（防重入）

  function scheduleAi(threadId, delayMs) {
    if (!threadId || disposed) return
    if (aiTimers.has(threadId)) return
    const ms = Math.max(200, Math.min(Number(delayMs) || 0, 30000))
    const timer = setTimeout(() => {
      aiTimers.delete(threadId)
      void tryAiReply(threadId)
    }, ms)
    aiTimers.set(threadId, timer)
  }

  /** 对一个会话尝试一次 AI 自动回复。闸门不过就直接返回。 */
  async function tryAiReply(threadId) {
    if (disposed || aiBusy.has(threadId)) return
    const thread = store.getThread(threadId)
    if (!thread) return

    const settings = store.getAiSettings()
    const adapter = adapterOf(thread.platform)
    const specDefaults = (adapter && adapter.spec && adapter.spec.aiDefaultPlatforms) || []
    const allowed = Array.isArray(settings.platforms) && settings.platforms.length ? settings.platforms : specDefaults
    if (!allowed.includes(thread.platform || (adapter && adapter.spec && adapter.spec.name) || '')) return

    const messages = store.getMessages(threadId)
    let lastIn = null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].direction === 'in') {
        lastIn = messages[i]
        break
      }
    }
    // 没有服务端消息 id 就无法保证幂等 —— 宁可不回，也不能重复轰炸顾客
    if (!lastIn || !lastIn.id) return

    const plan = planReply({
      mode: thread.aiMode || 'auto',
      globalEnabled: settings.enabled === true,
      now: Date.now(),
      humanLastReplyAt: thread.humanLastReplyAt || 0,
      humanCooldownMs: settings.humanCooldownMs,
      lastInboundAt: Number(lastIn.at) || 0,
      silenceMs: settings.silenceMs,
      aiLastReplyAt: thread.aiLastReplyAt || 0,
      minGapMs: settings.minGapMs,
      messageId: String(lastIn.id),
      handledIds: thread.aiHandled || [],
      aiCountToday: store.aiCountToday(threadId),
      maxPerThreadPerDay: settings.maxPerThreadPerDay,
      // 三道防"骚扰/烧钱"的护栏
      maxMessageAgeMs: Number(settings.maxMessageAgeMs) || 10 * 60 * 1000,
      lastAttemptAt: Number(thread.aiLastAttemptAt) || 0,
      lastAttemptMessageId: String(thread.aiLastAttemptMessageId || ''),
      retryBackoffMs: Number(settings.retryBackoffMs) || 60 * 1000,
    })
    if (plan.action === 'skip') return
    if (plan.action === 'defer') {
      scheduleAi(threadId, (plan.deferMs || 1000) + 300)
      return
    }

    // 先记"尝试过"：失败也不至于每 2.5s 重试一次
    store.noteAiAttempt(threadId, String(lastIn.id))

    aiBusy.add(threadId)
    try {
      // 资料库上下文：按「账号→项目」取资料；query 用最近几条买家消息，便于检索命中
      const recentIn = messages.filter((m) => m.direction === 'in').slice(-3).map((m) => String(m.text || ''))
      const query = recentIn.join('\n').slice(-600)
      const ai =
        adapter && typeof adapter.aiContext === 'function'
          ? await adapter.aiContext({ accountId: thread.accountId, platform: thread.platform, thread, query })
          : {}
      const kbText = String(ai.kb || '')
      if (!kbText) {
        store.markAiEscalated(threadId, `知识库不可用: ${ai.kbError || ''}`)
        return
      }
      const realtime = ai.realtime || { status: 'unknown' }
      const sel = currentSelection()
      const attemptStartedAt = Date.now()
      const systemInput = { kb: kbText, realtime }
      if (ai.shopName) systemInput.shopName = ai.shopName

      const recheckFn = () => {
        const fresh = store.getThread(threadId)
        if (!fresh) return { ok: false, reason: '会话已不存在' }
        const cfg = store.getAiSettings()
        if (cfg.enabled !== true) return { ok: false, reason: 'AI 开关已被关闭' }
        if ((fresh.aiMode || 'auto') !== 'auto') return { ok: false, reason: '会话已被切为人工接管' }
        const h = Number(fresh.humanLastReplyAt) || 0
        if (h && h > attemptStartedAt - 1000) {
          return {
            ok: false,
            reason: `人工在这几秒内已回复，AI 让位（${Math.round((Date.now() - h) / 1000)}s 前）`,
          }
        }
        return { ok: true }
      }
      const auditFn = (record) => {
        store.appendAiLog(record)
        emitRefresh()
      }
      const deps = {
        callModel,
        send: (text) => sendToThread(thread, text),
        /** ★ 发送前复查：模型调用通常要好几秒，这期间人工完全可能已经回复了。 */
        recheck: recheckFn,
        audit: auditFn,
      }
      const inputBase = {
        accountId: thread.accountId,
        threadId,
        messageId: String(lastIn.id),
        incomingText: lastIn.text || '',
        messages: buildMessages(
          // 历史里去掉最后这条（它单独作为"需要回复的消息"传给模型）
          messages.slice(0, Math.max(0, messages.lastIndexOf(lastIn))),
          12,
          lastIn.text,
        ),
        provider: settings.provider || sel.provider || '',
        model: settings.model || sel.model || '',
      }
      const callOnce = (systemText) => runReply(deps, { ...inputBase, system: systemText })
      let result = await callOnce(buildSystemPrompt(systemInput))
      // 通用兜底：模型判了转人工但资料其实有内容 → 让它带着「复核」提示再答一次（只重试一次）
      if (result && result.escalate === true && String(ai.kb || '').trim()) {
        result = await callOnce(
          buildSystemPrompt(systemInput) +
            '\n\n## 复核提示\n你上一轮判定需要人工。请重新核对《项目资料》：资料中确有直接依据的，就直接按资料回答（need_human=false）；确实没有依据才 need_human=true。',
        )
      }

      if (result.ok) {
        store.noteAiHandled(threadId, String(lastIn.id))
        store.noteAiReply(threadId, Date.now())
        store.recordOutbound(thread.accountId, thread.conversationId, result.reply, result.serverMessageId, 'ai', thread.platform)
        log.info(`AI 已回复 ${threadId}: ${String(result.reply).slice(0, 40)}`)
      } else if (result.escalate) {
        store.noteAiHandled(threadId, String(lastIn.id))
        store.markAiEscalated(threadId, result.error)
        log.warn(`AI 转人工 ${threadId}: ${result.error}`)
      } else {
        // 模型/网络/发送失败 → **不记 handled**（下次还能再试），但要让人工看到
        store.markAiEscalated(threadId, `自动回复失败：${result.error}`)
        log.warn(`AI 回复失败 ${threadId}: ${result.error}`)
      }
      emitRefresh()
    } catch (e) {
      log.error(`AI 回复异常: ${(e && e.stack) || e}`)
    } finally {
      aiBusy.delete(threadId)
    }
  }

  // ── 发送 ──────────────────────────────────────────────────────────────────

  /** 按 thread.platform 找适配器发送。 */
  function sendToThread(thread, text) {
    if (!thread) return Promise.resolve({ ok: false, error: '会话不存在' })
    const adapter = adapterOf(thread.platform)
    if (!adapter || typeof adapter.send !== 'function') {
      return Promise.resolve({ ok: false, error: `没有可用的平台适配器（${thread.platform || ''}）` })
    }
    return Promise.resolve(adapter.send(thread, text, makeIo(adapter, thread.accountId))).catch((e) => ({
      ok: false,
      error: String((e && e.message) || e),
    }))
  }

  /**
   * 人工回复（面板输入框）。
   *
   * 与旧 `/send` 完全一致：发送成功后落库并（默认）把该会话转为人工接管，
   * 同时把刚被回复的那条客户消息记为已处理，避免交回 AI 后它重答旧消息。
   */
  async function sendHuman(threadId, text) {
    const thread = store.getThread(threadId)
    if (!thread) return { ok: false, error: 'thread not found', statusCode: 404 }
    const result = await sendToThread(thread, text)
    if (result && result.ok) {
      const serverId = result.server_message_id !== undefined ? result.server_message_id : result.serverMessageId
      store.recordOutbound(thread.accountId, thread.conversationId, text, serverId, 'human', thread.platform)

      const cfg = store.getAiSettings()
      if (cfg.autoTakeoverOnHuman !== false) {
        const msgs = store.getMessages(thread.id)
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].direction === 'in' && msgs[i].id) {
            store.noteAiHandled(thread.id, String(msgs[i].id))
            break
          }
        }
        store.setThreadAiMode(thread.id, 'human')
        log.info(`人工回复 → 该会话转为人工接管: ${thread.id}`)
      }
      emitRefresh()
    }
    return result
  }

  // ── 读接口（HTTP 层用） ───────────────────────────────────────────────────

  function primaryBridge() {
    return bridges.length > 0 ? bridges[0] : null
  }

  /**
   * 平台显示名与能力表（**新增字段**，旧 client 不消费；新 client 可据此渲染，
   * 避免把平台名硬编码在 UI 里）。全部来自 spec，内核不写平台名。
   */
  function platformLabels() {
    const labels = {}
    const caps = {}
    for (const adapter of adapters) {
      const spec = (adapter && adapter.spec) || {}
      const specs = [spec, ...(spec.subSpecs || [])]
      for (const s of specs) {
        if (!s || !s.name) continue
        labels[s.name] = s.label || s.name
        caps[s.name] = { ...(s.capabilities || {}) }
      }
    }
    return { platformLabels: labels, capabilities: caps }
  }

  /** 旧 `/state` 的完整响应体（字段形状不变，尾部为新增字段）。 */
  function state() {
    const bridge = primaryBridge()
    return {
      ok: true,
      bridgeRunning: bridge ? Boolean(bridge.isConnected) || started : started,
      bridgeStarted: started,
      pairCode: bridge ? bridge.pairCode : '',
      wsPort: bridge ? bridge.port : 0,
      accounts: listAccounts(store, adapters, bridges, { log }),
      threads: listThreads(store, '', { adapters, log }),
      // 新增（additive）：平台分组卡 / 平台显示名 / 能力表
      platforms: listPlatforms(adapters, bridges),
      ...platformLabels(),
    }
  }

  function threadView(threadId) {
    const thread = store.getThread(threadId)
    if (!thread) return null
    store.markRead(threadId)
    return { thread, messages: store.getMessages(threadId) }
  }

  /**
   * 选「AI 相关的那个适配器」：多平台时不能固定 adapters[0]（会把闲鱼诊断显示成抖音）。
   * 优先级：显式 platform → 会话所属平台 → 声明了 aiDefaultPlatforms 的适配器 → 第一个。
   */
  function aiAdapterFor(platform, threadId) {
    let plat = String(platform || '')
    if (!plat && threadId) {
      const t = store.getThread(threadId)
      if (t) plat = t.platform || ''
    }
    // 没有显式平台时，优先「已有账号的平台」（运营者实际在用的那个），避免总是落到抖音
    if (!plat) {
      const acc = (store.getAccounts() || [])[0]
      if (acc && acc.platform) plat = String(acc.platform)
    }
    if (plat) {
      const hit = adapterOf(plat)
      if (hit) return hit
    }
    return (
      adapters.find((a) => a && a.spec && Array.isArray(a.spec.aiDefaultPlatforms) && a.spec.aiDefaultPlatforms.length) ||
      adapters[0]
    )
  }

  /** 所有平台的 AI 诊断（面板逐平台显示，避免「抖音未配置」被误读成「闲鱼不能用」） */
  async function allPlatformAiDiagnostics(o = {}) {
    const out = []
    const accounts = store.getAccounts() || []
    for (const a of adapters) {
      const name = (a && a.spec && a.spec.name) || ''
      const label = (a && a.spec && a.spec.label) || name
      const acct = accounts.find((x) => (x.platform || '') === name) || null
      try {
        const diag = typeof a.aiDiagnostics === 'function'
          ? await a.aiDiagnostics({ ...o, accountId: acct ? acct.id : '', platform: name })
          : null
        out.push({
          platform: name,
          label,
          accountId: acct ? acct.id : '',
          kb: (diag && diag.kb) || { chars: 0, error: '无诊断' },
          project: (diag && diag.project) || null,
        })
      } catch (e) {
        out.push({ platform: name, label, accountId: acct ? acct.id : '', kb: { chars: 0, error: String((e && e.message) || e) } })
      }
    }
    return out
  }

  function getAiSettingsView(o = {}) {
    const s = store.getAiSettings()
    const sel = currentSelection()
    const adapter = aiAdapterFor(o.platform, o.threadId)
    const adapterName = (adapter && adapter.spec && adapter.spec.name) || ''
    const acct = (store.getAccounts() || []).find((a) => (a.platform || '') === adapterName) || null
    const diagOpts = { ...o, accountId: o.accountId || (acct ? acct.id : ''), platform: o.platform || adapterName }
    return Promise.all([
      adapter && typeof adapter.aiDiagnostics === 'function'
        ? adapter.aiDiagnostics(diagOpts)
        : { kb: { path: '', chars: 0, error: '', dir: '' }, realtime: { status: 'unknown' }, shopMcp: {} },
      allPlatformAiDiagnostics(o),
    ]).then(([diag, platformKbs]) => ({
      ok: true,
      platform: adapterName,
      settings: s,
      resolvedModel: { provider: s.provider || sel.provider || '', model: s.model || sel.model || '' },
      llmAvailable: Boolean(llmService),
      kb: diag.kb,
      project: diag.project || null,
      platformKbs,
      realtime: diag.realtime,
      shopMcp: diag.shopMcp,
      busy: [...aiBusy],
    }))
  }

  function setAiSettings(patch) {
    store.setAiSettings(patch)
    emitRefresh()
    return store.getAiSettings()
  }

  /**
   * AI 沙箱测试：真实走「规则+知识库→模型→红线/解析」链路，但**不发送到任何平台**。
   * - 支持多轮：history=[{direction:'in'|'out', text}]（前端把「买家/AI」两轮传回来）；
   * - 不写 store（不落会话、不写审计），完全隔离，关掉弹窗即消失；
   * - 复用 runReply 的本地红线/转人工判定，所以看到的就是真实自动回复效果（除了不发出去）。
   */
  async function aiTest(input) {
    const opts = typeof input === 'string' ? { question: input } : (input || {})
    const q = String(opts.question || '').slice(0, 1000)
    if (!q.trim()) return { ok: false, error: '测试消息不能为空', replies: [] }

    const accounts = store.getAccounts() || []
    const requested = opts.accountId ? accounts.find((a) => a.id === opts.accountId) || null : null
    const platHint = String((requested && requested.platform) || opts.platform || '')
    const adapter = adapterOf(platHint) || aiAdapterFor(platHint, opts.threadId)
    // ⚠️ 必须用「账号自己的平台」（如 douyin-laike），不能用适配器名（douyin）：
    //    资料库按 platform+accountId 绑定，用适配器名会找不到项目 → 知识库 0 字。
    const acct = requested || accounts.find((a) => (a.platform || '') === platHint) || null
    const acctPlatform = String((acct && acct.platform) || platHint || (adapter && adapter.spec && adapter.spec.name) || '')

    const history = (Array.isArray(opts.history) ? opts.history : [])
      .filter((m) => m && String(m.text || '').trim())
      .slice(-12)
      .map((m) => ({ direction: m.direction === 'out' || m.role === 'ai' ? 'out' : 'in', text: String(m.text || '').slice(0, 600) }))
    const query = [history.filter((m) => m.direction === 'in').slice(-2).map((m) => m.text).join('\n'), q].filter(Boolean).join('\n').slice(-800)

    const ai = adapter && typeof adapter.aiContext === 'function'
      ? await adapter.aiContext({
          force: true,
          accountId: acct ? acct.id : '',
          platform: acctPlatform,
          query,
          thread: { platform: acctPlatform, accountId: acct ? acct.id : '', conversationId: 'sandbox' },
        })
      : {}

    const s = store.getAiSettings()
    const sel = currentSelection()
    const startedAt = Date.now()
    const replies = []
    let audit = null
    let error = ''
    let rawModel = ''

    const systemInput = { kb: String(ai.kb || ''), realtime: ai.realtime || { status: 'unknown' } }
    if (ai.shopName) systemInput.shopName = ai.shopName

    const deps = {
      // 捕获模型原始输出，便于在沙箱里排查「为什么判转人工」
      callModel: async (args) => {
        const out = await callModel(args)
        rawModel = String(out == null ? '' : out)
        return out
      },
      send: async (text) => { replies.push(text); return { ok: true } },
      // 沙箱没有真实会话状态：发送前复查恒通过（真实人工接管等闸门不参与测试）
      recheck: () => ({ ok: true }),
      audit: (record) => { audit = record },
    }
    const inputBase = {
      accountId: acct ? acct.id : '',
      threadId: 'sandbox',
      messageId: 'sandbox-' + Date.now(),
      incomingText: q,
      messages: buildMessages(history, 12, q),
      provider: s.provider || sel.provider || '',
      model: s.model || sel.model || '',
    }
    const callOnce = (systemText) =>
      runReply(deps, { ...inputBase, system: systemText }).catch((e) => {
        error = String((e && e.message) || e)
        return null
      })
    let result = await callOnce(buildSystemPrompt(systemInput))
    // 与真实链路相同的通用兜底：有资料却被判转人工 → 复核一次
    if (result && result.escalate === true && String(ai.kb || '').trim()) {
      result = await callOnce(
        buildSystemPrompt(systemInput) +
          '\n\n## 复核提示\n你上一轮判定需要人工。请重新核对《项目资料》：资料中确有直接依据的，就直接按资料回答（need_human=false）；确实没有依据才 need_human=true。',
      )
    }

    return {
      ok: !error && Boolean(result),
      ms: Date.now() - startedAt,
      question: q,
      provider: s.provider || sel.provider || '',
      model: s.model || sel.model || '',
      project: ai.project || null,
      kbChars: String(ai.kb || '').length,
      citations: ai.citations || [],
      realtime: ai.realtime || null,
      kbError: ai.kbError || '',
      realtime: (ai.realtime || {}).status,
      replies,
      reply: replies[0] || (result && result.reply) || '',
      // 真实链路里的拦截/转人工原因（沙箱里只展示、不发送）
      escalate: Boolean(result && result.escalate),
      stage: (result && result.record && result.record.stage) || '',
      guard: (result && result.record && String(result.record.guard || '')) || '',
      modelReason: (result && result.record && result.record.modelReason) || '',
      /** 模型原始输出（调试沙箱用；最多 4000 字） */
      raw: rawModel.slice(0, 4000),
      accountId: acct ? acct.id : '',
      accountPlatform: acctPlatform,
      audit,
      error: error || (result && result.ok === false ? String(result.error || '') : ''),
    }
  }

  function aiMode({ threadId, mode, replyNow, clearEscalated } = {}) {
    const thread = store.getThread(threadId)
    if (!thread) return { ok: false, error: 'thread not found', statusCode: 404 }
    if (mode === 'human' || mode === 'auto' || mode === 'paused') store.setThreadAiMode(threadId, mode)
    if (replyNow === true) scheduleAi(threadId, 200) // 手动触发一次（照常走全部闸门）
    if (clearEscalated === true) store.setThreadAiMode(threadId, 'auto')
    emitRefresh()
    return { ok: true, thread: store.getThread(threadId) }
  }

  /** 停掉定时器并让后续事件失效（插件卸载时调用）。 */
  function dispose() {
    disposed = true
    for (const t of aiTimers.values()) clearTimeout(t)
    aiTimers.clear()
    aiBusy.clear()
    // 适配器可能持有子进程/连接（如平台侧 MCP 客户端）：一并释放
    for (const adapter of adapters) {
      try {
        if (adapter && typeof adapter.dispose === 'function') adapter.dispose()
      } catch {
        /* 单个平台释放失败不影响其它 */
      }
    }
  }

  /**
   * 装配层兼容入口（`runtime.start?.()`）。
   * AI 运行时是事件驱动 + 定时器，无需显式启动；这里只做一次自检日志。
   */
  function start() {
    if (!disposed) log.debug(`运行时就绪：适配器 ${adapters.length} 个，桥 ${bridges.length} 条`)
    return Promise.resolve(true)
  }

  return {
    // 入站
    apply,
    applyEvent,
    attachBridge,
    setBridgeStarted,
    // 发送
    sendToThread,
    sendHuman,
    // 读/写（HTTP 层）
    state,
    threadView,
    getAiSettingsView,
    setAiSettings,
    aiTest,
    aiMode,
    aiLog: (limit) => store.getAiLog(limit),
    markRead: (threadId) => store.markRead(threadId),
    rename: (threadId, name) => {
      const thread = store.getThread(threadId)
      if (!thread) return false
      store.renameContact(thread.buyerUid, thread.buyerSecUid, name)
      emitRefresh()
      return true
    },
    deleteThread: async (threadId) => {
      await store.deleteThread(threadId)
      emitRefresh()
      return true
    },
    clearAll: async () => {
      await store.clearAll()
      emitRefresh()
      return true
    },
    // AI 运行时（测试/运维用）
    scheduleAi,
    tryAiReply,
    // 事件总线
    bus,
    subscribe: (fn) => bus.subscribe(fn),
    /** 事件旁路钩子：自动交付/通知等（返回注销函数） */
    onEvent,
    emitRefresh,
    /** 供工具层拿某个平台/账号的 io（桥指令 + store + 回声 + 日志）。 */
    ioFor: (platform, accountId) => {
      const adapter = adapterOf(platform)
      if (!adapter) return null
      return makeIo(adapter, String(accountId || ''))
    },
    // 生命周期
    dispose,
    start,
    get started() {
      return started
    },
    get bridges() {
      return bridges
    },
    get adapters() {
      return adapters
    },
  }
}

/** 把外部日志器归一化成 {info,warn,error,debug}，并统一加前缀。 */
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

export default createRuntime
