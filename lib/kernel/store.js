/**
 * dsh-cs kernel — 通用独立存储（所有寄生平台共用）。
 *
 * 客服会话与 DSH 的 session/workspace 完全隔离：数据写在自己的命名空间
 * `$DSH_HOME/dsh-cs/` 下，永不调用 ctx.sessions / workspaceRegistry，
 * 因此客服会话天然不会出现在侧边「最近会话」列表里。
 *
 * 存储形态：JSON 文件。量级（单店客服）远低于需要数据库的门槛；用原子写入
 * （写临时文件 + rename）保证断电/崩溃时至少保留上一份完整数据。
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/**
 * 客服数据目录。
 *
 * `DSH_CS_DATA_DIR` 是给**测试**用的隔离出口：验证脚本必须指向临时目录，
 * 否则会把样本数据写进真实客服库（曾把 hermes 的 fixture 会话「这是什么」
 * 写进用户真实面板里）。生产路径永远是 `$DSH_HOME/dsh-cs`，与旧插件
 * `$DSH_HOME/dsh-cs-legacy` 完全隔离（迁移只读旧库，回退时旧库仍完好）。
 */
export const DATA_DIR = process.env.DSH_CS_DATA_DIR || join(DSH_HOME, 'dsh-cs')

// ── 数据模型 ─────────────────────────────────────────────────────────────────
//
// 两个标识要分清（抖音给的是两套 id，缺一不可）：
//   uid       数字 id，出现在 conversation_id（0:1:A:B）与帧的 .7 字段
//   sec_uid   "MS4wLjABAAAA…" 稳定字符串 id，出现在帧的 .14 字段与页面链接里
// 私信帧**不带昵称**，昵称只能从页面侧拿到（扩展 hook 的 /im/user/info/ 接口），
// 所以这里维护一份「通讯录」按两种 id 建索引，展示时再解析成名字。

/**
 * @typedef CsAccount
 * @property {string} id            扩展握手时上报的 account_id
 * @property {string} platform      平台 id（如 'douyin' | 'douyin-laike' | 'xianyu'）
 * @property {string} nickname      账号昵称
 * @property {string} detectedId    扩展从 cookie 探测到的账号 id
 * @property {string} selfSecUid    本账号自己的 sec_uid（用于认出通讯录里的"自己"）
 * @property {string} selfUid       本账号自己的数字 uid（从入站帧的对侧自举）
 * @property {boolean} connected    扩展是否已配对
 * @property {boolean} canSend      是否已捕获发送模板
 */

/**
 * @typedef CsContact
 * @property {string} uid
 * @property {string} secUid
 * @property {string} nickname
 * @property {string} avatar
 * @property {number} at            最近一次更新时间
 */

/**
 * @typedef CsThread
 * @property {string} id
 * @property {string} platform
 * @property {string} accountId
 * @property {string} conversationId
 * @property {string} conversationShortId
 * @property {string} buyerUid
 * @property {string} buyerSecUid
 * @property {string} lastMessage
 * @property {number} lastActiveAt
 * @property {number} unread
 */

/** 通讯录条目的主键：优先 sec_uid（跨会话稳定），退 uid。 */
function contactKey({ secUid, uid }) {
  if (secUid) return `sec:${secUid}`
  if (uid) return `uid:${uid}`
  return ''
}

class Store {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dataDir]         数据目录（默认 DATA_DIR；测试用临时目录）
   * @param {string} [opts.sessionSlug]     会话 key 前缀（平台 spec.sessionSlug，如 xy/dy）
   * @param {string} [opts.defaultPlatform] 未标注平台时的归属（平台 spec.name）
   * @param {string} [opts.label]           日志前缀
   */
  constructor({ dataDir, sessionSlug = 'dy', defaultPlatform = 'douyin', label = 'cs', slugByPlatform = null } = {}) {
    this.dataDir = dataDir || DATA_DIR
    this.sessionSlug = sessionSlug
    this.defaultPlatform = defaultPlatform
    this.label = label
    /**
     * 平台 id → 会话 key 前缀（如 { xianyu:'xy', douyin:'dy', 'douyin-laike':'dl' }）。
     * 历史数据里已有 `dy:` 前缀的会话不受影响：老会话读出来 id 不变，新会话按平台前缀生成。
     */
    this.slugByPlatform = slugByPlatform && typeof slugByPlatform === 'object' ? { ...slugByPlatform } : {}
    this.state = {
      accounts: {}, // id -> CsAccount
      contacts: {}, // key -> CsContact
      renames: {}, // key -> 自定义名字（手动改名，优先级最高）
      threads: {}, // id -> CsThread
      messages: {}, // threadId -> CsMessage[]
      /** AI 自动回复的总设置 */
      aiSettings: {
        // ⚠️ 默认**关闭**：这是会真的自动发给顾客的功能，必须由店主显式打开。
        enabled: false,
        provider: '',
        model: '',
        silenceMs: 4000, // 客户连发时等这么久再合并回复
        humanCooldownMs: 300000, // 人工回复后 AI 静默 5 分钟
        minGapMs: 8000, // 两条 AI 回复最小间隔
        maxPerThreadPerDay: 60,
        // 消息超过这么久就不自动回（重启后别拿历史消息挨个回，顾客早走了）
        maxMessageAgeMs: 600000,
        // 同一条消息失败后的退避（否则每 2.5s 重试，刷爆日志和 token）
        retryBackoffMs: 60000,
        // 自动回复默认对所有已注册平台关闭；由平台在启动时显式选择开放哪些平台
        platforms: [],
        /**
         * 人工回一条 → 该会话自动转为「人工接管」，AI 不再插话；
         * 直到店主在面板上手动交回 AI。
         * （比"冷却 N 分钟自动恢复"更符合真实客服：既然人工接手了，
         *   AI 不该过几分钟自己又插进来。）
         */
        autoTakeoverOnHuman: true,
      },
      /** AI 回复审计（可回溯）：每条都记，环形保留 */
      aiLog: [],
    }
    /** uid -> contacts 的 key（派生索引，不落盘，init 时重建） */
    this._uidIndex = new Map()
    this._saveTimer = null
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true })
    try {
      const raw = await readFile(this._path('state.json'), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        this.state.accounts = parsed.accounts || {}
        this.state.contacts = parsed.contacts || {}
        this.state.renames = parsed.renames || {}
        this.state.threads = parsed.threads || {}
        this.state.messages = parsed.messages || {}
        // AI 设置合并（缺字段用默认值，避免升级后少字段）
        this.state.aiSettings = { ...this.state.aiSettings, ...(parsed.aiSettings || {}) }
        this.state.aiLog = Array.isArray(parsed.aiLog) ? parsed.aiLog : []
      }
    } catch {
      /* 首次运行或文件损坏：用空状态 */
    }
    this._rebuildUidIndex()
  }

  _rebuildUidIndex() {
    this._uidIndex.clear()
    for (const [key, c] of Object.entries(this.state.contacts)) {
      if (c && c.uid) this._uidIndex.set(String(c.uid), key)
    }
  }

  _path(name) {
    return join(this.dataDir, name)
  }

  async _atomicWrite(name, data) {
    const path = this._path(name)
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, path)
  }

  /** 节流落盘（避免每条消息都触发一次全量写）。 */
  scheduleSave() {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      void this.save()
    }, 500)
  }

  async save() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    try {
      await this._atomicWrite('state.json', this.state)
    } catch (error) {
      // 落盘失败只记录：内存态仍然可用，且绝不产生未处理的 Promise 拒绝。
      console.error(`[${this.label}] 落盘失败: ${error}`)
    }
  }

  // ── 账号 ──────────────────────────────────────────────────────────────────

  getAccounts() {
    return Object.values(this.state.accounts)
  }

  getAccount(id) {
    return this.state.accounts[id]
  }

  upsertAccount(partial) {
    const id = partial.id
    if (!id) return undefined
    const prev = this.state.accounts[id] || {}
    // 只在新值非空时覆盖旧值，避免后到的空字段把已知信息抹掉。
    const next = { platform: this.defaultPlatform, ...prev }
    for (const [k, v] of Object.entries(partial)) {
      if (v === undefined || v === null || v === '') continue
      next[k] = v
    }
    next.id = id
    this.state.accounts[id] = next
    this.scheduleSave()
    return next
  }

  setAccountConnected(id, connected) {
    const acc = this.state.accounts[id]
    if (acc) {
      acc.connected = connected
      this.scheduleSave()
    }
  }

  setAccountCanSend(id, canSend) {
    const acc = this.state.accounts[id]
    if (acc) {
      acc.canSend = canSend
      this.scheduleSave()
    }
  }

  // ── 通讯录（昵称解析）────────────────────────────────────────────────────

  /** 记录/更新一个联系人（扩展 /im/user/info/ 上报，含昵称与头像）。 */
  upsertContact({ uid, secUid, nickname, avatar }) {
    const key = contactKey({ secUid, uid })
    if (!key) return
    const prev = this.state.contacts[key] || {}
    const next = { ...prev }
    if (uid) next.uid = String(uid)
    if (secUid) next.secUid = String(secUid)
    if (nickname) next.nickname = String(nickname)
    if (avatar) next.avatar = String(avatar)
    next.at = Date.now()
    this.state.contacts[key] = next
    if (next.uid) this._uidIndex.set(next.uid, key)
    this.scheduleSave()
    return next
  }

  /** 按 uid / sec_uid 找一个联系人（两种 id 任一命中即可）。 */
  findContact(uid, secUid) {
    if (secUid && this.state.contacts[`sec:${secUid}`]) return this.state.contacts[`sec:${secUid}`]
    if (uid) {
      const key = this._uidIndex.get(String(uid))
      if (key) return this.state.contacts[key]
    }
    if (secUid) return Object.values(this.state.contacts).find((c) => c && c.secUid === secUid)
    return undefined
  }

  /** 手动改名（优先级最高）。name 传空串表示取消改名。 */
  renameContact(uid, secUid, name) {
    const trimmed = String(name || '').trim()
    for (const key of [secUid ? `sec:${secUid}` : '', uid ? `uid:${uid}` : '']) {
      if (!key) continue
      if (trimmed) this.state.renames[key] = trimmed
      else delete this.state.renames[key]
    }
    this.scheduleSave()
  }

  /**
   * 解析展示名。顺序：手动改名 → 通讯录昵称 → 空串（调用方再退 id）。
   */
  resolveName(uid, secUid) {
    for (const key of [secUid ? `sec:${secUid}` : '', uid ? `uid:${uid}` : '']) {
      if (key && this.state.renames[key]) return this.state.renames[key]
    }
    const c = this.findContact(uid, secUid)
    return (c && c.nickname) || ''
  }

  /** 联系人头像（有则返回 URL）。 */
  resolveAvatar(uid, secUid) {
    const c = this.findContact(uid, secUid)
    return (c && c.avatar) || ''
  }

  /** 账号自己的展示名：优先用「通讯录里匹配到自己」的那个昵称。 */
  resolveAccountName(account) {
    if (!account) return ''
    const self = this.resolveName(account.selfUid, account.selfSecUid)
    return self || account.nickname || ''
  }

  // ── 会话 ──────────────────────────────────────────────────────────────────

  /** 某平台对应的会话 key 前缀（未登记平台退回默认前缀）。 */
  slugFor(platform) {
    const p = platform || this.defaultPlatform
    return this.slugByPlatform[p] || this.sessionSlug
  }

  threadId(accountId, conversationId, platform) {
    return `${this.slugFor(platform)}:${accountId}:${conversationId}`
  }

  getThreads() {
    return Object.values(this.state.threads).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  getThread(id) {
    return this.state.threads[id]
  }

  /** 记录一条入站消息：找到/创建 thread，追加消息，更新未读。 */
  recordInbound({ accountId, conversationId, conversationShortId, buyerUid, buyerSecUid, buyerName, buyerAvatar, text, platform, messageId }) {
    const platformId = platform || this.defaultPlatform
    const id = this.threadId(accountId, conversationId, platformId)
    const now = Date.now()
    let thread = this.state.threads[id]
    if (!thread) {
      thread = {
        id,
        platform: platformId,
        accountId,
        conversationId,
        conversationShortId: conversationShortId || '',
        buyerUid: buyerUid || '',
        buyerSecUid: buyerSecUid || '',
        lastMessage: text,
        lastActiveAt: now,
        unread: 0,
      }
      this.state.threads[id] = thread
    } else {
      if (conversationShortId) thread.conversationShortId = conversationShortId
      if (buyerUid && !thread.buyerUid) thread.buyerUid = buyerUid
      if (buyerSecUid && !thread.buyerSecUid) thread.buyerSecUid = buyerSecUid
      thread.lastMessage = text
      thread.lastActiveAt = now
    }
    // 帧里带昵称/头像时落库（闲鱼消息帧不带，扩展 user_info 会经 account 事件写 contacts）
    if (buyerName) thread.buyerName = String(buyerName)
    if (buyerAvatar) thread.buyerAvatar = String(buyerAvatar)
    thread.unread += 1

    const messages = this.state.messages[id] || (this.state.messages[id] = [])
    // 服务端消息 id 必须落库：AI 闸门用 lastIn.id 做幂等（没有 id 就永不自动回复）
    messages.push({ id: messageId ? String(messageId) : '', direction: 'in', text, at: now })

    this.scheduleSave()
    return thread
  }

  /**
   * 同步一个会话（来客用）。
   *
   * 为什么不能复用 recordInbound：来客是**轮询**拉取历史消息（同源 REST），
   * 同一批消息会被反复拉到。recordInbound 是无脑 append + unread++，
   * 轮询几次就会重复堆积、未读暴涨。
   * 所以这里按 **服务端消息 id 幂等合并**：已见过的跳过。
   *
   * 未读语义：**只有新出现的入站消息才 +1**；首次建档时采用服务端给的未读数
   * （历史消息不算未读，否则 31 个会话一开就满屏红点）。
   */
  syncThreadMessages({
    accountId,
    platform = null,
    conversationId,
    conversationShortId,
    buyerUid,
    buyerSecUid,
    unread,
    messages,
    /** 会话级展示信息（名字/头像由 batchGetUserInfoForMerchant 提供） */
    buyerName,
    buyerAvatar,
  }) {
    if (!accountId || !conversationId) return undefined
    platform = platform || this.defaultPlatform
    const id = this.threadId(accountId, conversationId, platform)
    const now = Date.now()
    const isNew = !this.state.threads[id]
    let thread = this.state.threads[id]
    if (!thread) {
      thread = {
        id,
        platform,
        accountId,
        conversationId,
        conversationShortId: conversationShortId || '',
        buyerUid: buyerUid || '',
        buyerSecUid: buyerSecUid || '',
        lastMessage: '',
        lastActiveAt: now,
        // 首次建档：历史消息不算未读，只信服务端给的未读数
        unread: Number.isFinite(unread) && unread > 0 ? unread : 0,
      }
      this.state.threads[id] = thread
    } else {
      if (platform) thread.platform = platform
      if (conversationShortId && !thread.conversationShortId) thread.conversationShortId = conversationShortId
      if (buyerUid && !thread.buyerUid) thread.buyerUid = buyerUid
      if (buyerSecUid && !thread.buyerSecUid) thread.buyerSecUid = buyerSecUid
    }

    // 名字/头像进通讯录 —— 复用既有的「改名 > 通讯录昵称」解析链
    if ((buyerName || buyerAvatar) && (buyerUid || buyerSecUid)) {
      this.upsertContact({ uid: buyerUid, secUid: buyerSecUid, nickname: buyerName, avatar: buyerAvatar })
    }

    const list = this.state.messages[id] || (this.state.messages[id] = [])
    const known = new Set()
    for (const m of list.slice(-400)) if (m && m.id) known.add(String(m.id))

    let addedInbound = 0
    let added = 0
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || typeof m.text !== 'string' || m.text === '') continue
      const mid = m.id ? String(m.id) : ''
      if (mid && known.has(mid)) continue
      if (mid) known.add(mid)
      const direction = m.direction === 'out' ? 'out' : 'in'
      list.push({ id: mid, direction, text: m.text, at: Number(m.at) || now })
      added += 1
      if (direction === 'in' && !isNew) addedInbound += 1
    }

    if (added > 0) {
      // 按时间取最新一条作为会话摘要（不要把轮询顺序当时间顺序）
      let newest = null
      for (const m of list.slice(-400)) if (!newest || (m.at || 0) >= (newest.at || 0)) newest = m
      if (newest) {
        thread.lastMessage = newest.text
        thread.lastActiveAt = Math.max(thread.lastActiveAt || 0, newest.at || 0, now)
      }
    }
    if (addedInbound > 0) thread.unread = (thread.unread || 0) + addedInbound

    this.scheduleSave()
    return thread
  }

  /**
   * 记录一条出站消息（人工/自动回复）。
   *
   * `id` 传服务端消息 id 时必须带上 —— 否则来客下一轮轮询把这条消息从历史里
   * 拉回来时，因为没有 id 对不上，会被当成新消息重复入库。
   */
  recordOutbound(accountId, conversationId, text, id, by = 'human', platform) {
    const tid = this.threadId(accountId, conversationId, platform)
    const thread = this.state.threads[tid]
    const at = Date.now()
    if (thread) {
      thread.lastMessage = text
      thread.lastActiveAt = at
      // 人工回复 → 记时间，AI 让位（绝不抢话）
      if (by === 'human') thread.humanLastReplyAt = at
    }
    const messages = this.state.messages[tid] || (this.state.messages[tid] = [])
    messages.push({ id: id ? String(id) : '', direction: 'out', text, at, by })
    this.scheduleSave()
  }

  markRead(threadId) {
    const thread = this.state.threads[threadId]
    if (thread) {
      thread.unread = 0
      this.scheduleSave()
    }
  }

  /**
   * 清空客服数据（会话 / 消息 / 通讯录 / 改名）。
   *
   * 保留 accounts —— 它记录的是「哪个扩展连过桥」的绑定关系，不属于聊天数据。
   *
   * ⚠️ 为什么必须走方法而不是删文件：插件内存里也存着一份 state，只删
   * `state.json` 的话，下一次任何变更都会把内存里的旧状态整份写回磁盘。
   */
  async clearAll() {
    this.state.threads = {}
    this.state.messages = {}
    this.state.contacts = {}
    this.state.renames = {}
    this._uidIndex.clear()
    await this.save()
  }

  /** 删除单个会话（含消息）。 */
  async deleteThread(threadId) {
    delete this.state.threads[threadId]
    delete this.state.messages[threadId]
    await this.save()
  }

  getMessages(threadId) {
    return this.state.messages[threadId] || []
  }

  // ── AI 自动回复 ────────────────────────────────────────────────────────────
  //
  // 为什么这些状态要落盘：AI 自动回复是"无人值守"的，重启后必须还记得
  // 「哪些消息回过」「人工刚回过要静默」「今天的额度用了几条」——
  // 否则重启会让 AI 重复回复同一批消息、或者抢在人工前面说话。

  getAiSettings() {
    return this.state.aiSettings
  }

  setAiSettings(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === undefined || v === null) continue
      this.state.aiSettings[k] = v
    }
    this.scheduleSave()
    return this.state.aiSettings
  }

  /** 人工回复过 → 记时间，AI 让位（人工优先）。 */
  noteHumanReply(accountId, conversationId, platform) {
    const t = this.state.threads[this.threadId(accountId, conversationId, platform)]
    if (!t) return undefined
    t.humanLastReplyAt = Date.now()
    this.scheduleSave()
    return t
  }

  /** 会话级 AI 模式：'auto' | 'human'（人工接管）| 'paused' */
  setThreadAiMode(threadId, mode) {
    const t = this.state.threads[threadId]
    if (!t) return undefined
    t.aiMode = mode
    t.aiModeChangedAt = Date.now()
    if (mode === 'auto') {
      // 手动交回 AI：清掉"待人工"标记，并解掉人工静默与失败退避 ——
      // 否则「我刚点了交回 AI，它却不回」会很迷惑。
      t.aiEscalated = false
      t.aiEscalatedReason = ''
      t.humanLastReplyAt = 0
      t.aiLastAttemptAt = 0
      t.aiLastAttemptMessageId = ''
    }
    this.scheduleSave()
    return t
  }

  /** 记一条 AI 已处理的消息（幂等）。返回 true=是新的（可以回复）。 */
  noteAiHandled(threadId, messageId) {
    const t = this.state.threads[threadId]
    if (!t || !messageId) return false
    const list = t.aiHandled || (t.aiHandled = [])
    if (list.includes(messageId)) return false
    list.push(messageId)
    if (list.length > 200) list.splice(0, list.length - 200)
    this.scheduleSave()
    return true
  }

  hasAiHandled(threadId, messageId) {
    const t = this.state.threads[threadId]
    return Boolean(t && messageId && (t.aiHandled || []).includes(messageId))
  }

  noteAiReply(threadId, at) {
    const t = this.state.threads[threadId]
    if (!t) return undefined
    const when = at || Date.now()
    const day = new Date(when).toISOString().slice(0, 10)
    if (t.aiCountDate !== day) {
      t.aiCountDate = day
      t.aiCountToday = 0
    }
    t.aiLastReplyAt = when
    t.aiCountToday = (t.aiCountToday || 0) + 1
    // 成功回出去 → 之前的"待人工"标记自动解除
    t.aiEscalated = false
    t.aiEscalatedReason = ''
    this.scheduleSave()
    return t
  }

  /** 记一次「尝试过」。失败也要记，用于退避（否则每 2.5s 重试一次，刷爆日志和 token）。 */
  noteAiAttempt(threadId, messageId) {
    const t = this.state.threads[threadId]
    if (!t) return undefined
    t.aiLastAttemptAt = Date.now()
    t.aiLastAttemptMessageId = String(messageId || '')
    this.scheduleSave()
    return t
  }

  aiCountToday(threadId) {
    const t = this.state.threads[threadId]
    if (!t) return 0
    const day = new Date().toISOString().slice(0, 10)
    return t.aiCountDate === day ? t.aiCountToday || 0 : 0
  }

  /** 需要人工接手（模型判定 / 红线拦截 / 发送失败）。 */
  markAiEscalated(threadId, reason) {
    const t = this.state.threads[threadId]
    if (!t) return undefined
    t.aiEscalated = true
    t.aiEscalatedReason = String(reason || '').slice(0, 200)
    t.aiEscalatedAt = Date.now()
    this.scheduleSave()
    return t
  }

  /** 追加一条 AI 审计（可回溯）。 */
  appendAiLog(record, limit = 500) {
    const log = this.state.aiLog
    log.push(record)
    if (log.length > limit) log.splice(0, log.length - limit)
    this.scheduleSave()
    return record
  }

  /** 审计记录，新的在前。 */
  getAiLog(limit = 100) {
    return this.state.aiLog.slice(-limit).reverse()
  }

  clearAiLog() {
    this.state.aiLog = []
    this.scheduleSave()
  }
}

export { Store }
