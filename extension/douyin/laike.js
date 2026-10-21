/**
 * DSH 客服 —— 来客客服内容脚本（isolated world）
 * ============================================================================
 *
 * 路线 A：**不碰来客的 IM 协议**，只用两件事
 *   收：同源 REST 明文 JSON（get_history_msg / batchGetUserInfoForMerchant）
 *   发：驱动页面自己的 UI（点会话 → 校验 → 输入 → 发送 → 回读确认）
 *
 * 为什么发送要"点 UI"而不是调接口：
 *   来客的 IM 走字节 PaaS IM SDK，protobuf 编码、域名由 TCC 下发，而且跑在
 *   **主世界之外的 realm**（worker/容器）里 —— 主世界 hook 不到，实例也拿不到。
 *   详见《抖音客服插件-方向方案.md》§7.4。
 *
 * 安全设计（这是客服，发错人比发不出去严重得多）：
 *   1. 发送前必须**用数据**确认目标会话已打开 —— 依据是「点击后页面自己发起了
 *      该 bizConversationId 的 get_history_msg」（由 laike_injected.js 录制）。
 *      确认不了就中止，**绝不输入、绝不发送**。
 *   2. 发送后**回读历史消息**确认这条真的出现在会话里，才回报成功。
 *      只信回读，不信"点了发送按钮"。
 *
 * 轮询节流：所有已知会话轮转拉取，间隔 1200ms（约 0.8 req/s），
 * 与页面自身 getConversationTag 的轮询频率同一量级。
 */
;(function () {
  'use strict'
  if (window.__laikeCs) return
  window.__laikeCs = { installed: true, version: '1.0.0' }

  const LOG = '[DSH·来客]'
  const PLATFORM = 'douyin-laike'
  const REC_TOPIC = '__laike_rec__'
  const POLL_GAP_MS = 1200
  const POLL_SIZE = 20
  const FRESH_MS = 10000 // 同一会话 10s 内不重复拉

  // ── 页面上下文 ────────────────────────────────────────────────────────────
  function readPageCtx() {
    const u = new URL(location.href)
    return {
      accountId: u.searchParams.get('accountId') || u.searchParams.get('groupId') || '',
      conGroupId: u.searchParams.get('conGroupId') || '',
      rootLifeAccountId: u.searchParams.get('lifeAccountId') || '',
    }
  }
  const pageCtx = readPageCtx()
  /** 桥上区分抖音账号与来客账号 */
  const ACCOUNT_ID = `laike-${pageCtx.accountId || 'default'}`

  const log = (...a) => console.log(LOG, ...a)
  const warn = (...a) => console.warn(LOG, ...a)

  function sendBg(payload) {
    try {
      chrome.runtime.sendMessage({ ...payload, account_id: ACCOUNT_ID, platform: PLATFORM }, () => {
        void chrome.runtime.lastError // 扩展重载后上下文失效，忽略
      })
    } catch {
      /* ignore */
    }
  }

  // ── 会话表 ────────────────────────────────────────────────────────────────
  // bizConversationId 形如 "<买家pigeonUid>:<shopId>:<conGroupId>"
  const BIZ_ID_RE = /^\d{8,20}:\d{8,20}:\d{1,12}$/
  const convs = new Map() // bizId -> { bizId, talkId, buyerUid, name, avatar, unread, lastPolledAt, lastText }

  function buyerUidOfBiz(bizId) {
    const first = String(bizId || '').split(':')[0]
    return /^\d+$/.test(first) ? first : ''
  }

  function rememberConv(partial) {
    const bizId = String(partial.bizId || '')
    if (!BIZ_ID_RE.test(bizId)) return undefined
    const prev = convs.get(bizId) || { bizId, buyerUid: buyerUidOfBiz(bizId), lastPolledAt: 0 }
    const next = { ...prev }
    for (const [k, v] of Object.entries(partial)) {
      if (v === undefined || v === null || v === '') continue
      next[k] = v
    }
    next.bizId = bizId
    convs.set(bizId, next)
    return next
  }

  /**
   * 从任意 JSON 里挖出会话 —— **不假设字段名**。
   * 判据：出现形如 a:b:c 的 biz id 字符串。这样无论哪个接口、什么结构都能认。
   */
  function harvestConversations(node, ctx, seen, budget) {
    if (budget.n <= 0 || node === null || node === undefined) return
    budget.n -= 1
    if (typeof node === 'string') {
      if (BIZ_ID_RE.test(node)) rememberConv({ ...ctx, bizId: node })
      return
    }
    if (typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      // 两个数组并行（BizConversationIDList / ConversationIDList）→ 按下标配对
      for (let i = 0; i < node.length && i < 500; i++) harvestConversations(node[i], ctx, seen, budget)
      return
    }

    // 先看本层有没有 biz id 字段
    const local = { ...ctx }
    let hasBiz = false
    for (const [k, v] of Object.entries(node)) {
      if (typeof v !== 'string') continue
      if (BIZ_ID_RE.test(v)) {
        local.bizId = v
        hasBiz = true
      } else if (/^(talk_?id|talkId|conversation_?id|conversationId)$/i.test(k) && /^\d{6,}$/.test(v)) {
        local.talkId = v
      } else if (/^(pigeon_?uid|pigeonUid|PigeonCID|pigeon_cid)$/i.test(k) && /^\d{6,}$/.test(v)) {
        local.buyerUid = v
      } else if (/^(nick|nick_?name|NickName|nickname|userName|name)$/i.test(k) && v.length <= 64) {
        local.name = v
      } else if (/^(avatar|Avatar|avatar_?url|headImg|head_url)$/i.test(k) && /^https?:/.test(v)) {
        local.avatar = v
      } else if (/^(unread|unread_?count|unreadCount|msg_?unread)$/i.test(k)) {
        local.unread = Number(v)
      }
    }
    if (hasBiz) rememberConv(local)

    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') harvestConversations(v, local, seen, budget)
    }
  }

  function harvest(json) {
    harvestConversations(json, {}, new Set(), { n: 20000 })
  }

  // ── 录制流量（来自 laike_injected.js）────────────────────────────────────
  const traffic = [] // { url, reqBody, respJson, at }
  const historyWaiters = [] // { bizId, at, resolve, timer, ignoreOwn }
  /** 本店（本客服账号）的名字 —— 从 batch_get_cs_info / get_cs_info 响应里挖 */
  let shopName = ''
  /**
   * 记录器健康度。
   *
   * 为什么必须盯这个：切会话的「数据依据」全靠主世界记录器回传。
   * 记录器要是没工作（曾经因为依赖应用调用 addEventListener('loadend') 而
   * 一条都录不到），表现就是"点了打不开" —— 会让人往 DOM 选择器方向白查。
   * 所以每次失败都把它的健康度一起报出来。
   */
  const recorderHealth = { ready: false, seen: 0, lastAt: 0, lastBeatAt: 0, lastUrls: [] }

  /** 上报本平台账号（带店铺名）。周期性重发，避免"桥还没连上时那一次"丢掉。 */
  function announce() {
    sendBg({
      type: 'platform_account',
      account_id: ACCOUNT_ID,
      platform: PLATFORM,
      detected_id: pageCtx.accountId,
      nickname: shopName || undefined,
    })
  }

  /**
   * 从任意 JSON 里挖「本店名字」。
   * 判据：对象里同时有 `pigeonCid`（客服自己的 id）和 `nick`。
   * 不这么卡的话会把**买家**昵称当成店铺名 —— 实际踩过：账号卡显示成了
   * 某个买家的名字（高考志愿技术宅）。
   */
  function harvestShopName(node, budget) {
    if (!node || typeof node !== 'object' || budget.n <= 0) return ''
    budget.n -= 1
    if (Array.isArray(node)) {
      for (const it of node.slice(0, 50)) {
        const r = harvestShopName(it, budget)
        if (r) return r
      }
      return ''
    }
    const hasSelfId = typeof node.pigeonCid === 'string' || typeof node.pigeon_id === 'string'
    if (hasSelfId) {
      const nick = node.nick || node.nickName || node.nickname || node.shopName
      if (typeof nick === 'string' && nick.trim() && nick.trim().length <= 40) return nick.trim()
    }
    for (const v of Object.values(node)) {
      const r = harvestShopName(v, budget)
      if (r) return r
    }
    return ''
  }

  function pushTraffic(entry) {
    traffic.push(entry)
    if (traffic.length > 60) traffic.shift()

    // 店铺名（账号卡要显示它，而不是某个买家的昵称）
    if (entry.respJson && /batch_get_cs_info|get_cs_info|get_pigeon_id_by_cs/.test(entry.url)) {
      const name = harvestShopName(entry.respJson, { n: 500 })
      if (name && name !== shopName) {
        shopName = name
        log('认出本店名称:', shopName)
        announce()
      }
    }

    // getConversationTag 的**请求体**里有全部会话 id → 白送一份会话列表
    if (entry.url.indexOf('getConversationTag') >= 0 && entry.reqBody) {
      try {
        const body = JSON.parse(entry.reqBody)
        const bizList = body.BizConversationIDList || []
        const talkList = body.ConversationIDList || []
        for (let i = 0; i < bizList.length; i++) {
          rememberConv({ bizId: String(bizList[i]), talkId: talkList[i] ? String(talkList[i]) : undefined })
        }
      } catch {
        /* ignore */
      }
    }
    if (entry.respJson) harvest(entry.respJson)

    // 页面自己请求了某个会话的历史 → 说明该会话已被打开
    if (entry.url.indexOf('get_history_msg') >= 0) {
      const m = /[?&]bizConversationId=([^&]+)/.exec(entry.url)
      const bizId = m ? decodeURIComponent(m[1]) : ''
      if (bizId) {
        for (const w of historyWaiters.slice()) {
          if (w.bizId === bizId) {
            clearTimeout(w.timer)
            historyWaiters.splice(historyWaiters.indexOf(w), 1)
            w.resolve(true)
          }
        }
        // 页面自己的历史响应也直接吃下来（白送消息）
        if (entry.respJson) syncFromHistory(bizId, entry.respJson)
      }
    }
  }

  /** 等页面为指定会话发起 get_history_msg（= 该会话确实是当前打开的会话）。 */
  function waitForHistoryRequest(bizId, timeoutMs) {
    return new Promise((resolve) => {
      const w = { bizId, resolve }
      w.timer = setTimeout(() => {
        const i = historyWaiters.indexOf(w)
        if (i >= 0) historyWaiters.splice(i, 1)
        resolve(false)
      }, timeoutMs)
      historyWaiters.push(w)
    })
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return
    const d = ev.data
    if (!d || d[REC_TOPIC] !== true) return
    if (d.kind === 'ready') {
      log('主世界记录器已就绪')
      recorderHealth.ready = true
      return
    }
    if (d.kind === 'heartbeat') {
      recorderHealth.ready = true
      recorderHealth.seen = Number(d.seen) || recorderHealth.seen
      recorderHealth.lastBeatAt = Date.now()
      return
    }
    if (d.kind === 'traffic') {
      recorderHealth.seen += 1
      recorderHealth.lastAt = Date.now()
      recorderHealth.lastUrls.push(String(d.url || '').slice(0, 160))
      if (recorderHealth.lastUrls.length > 8) recorderHealth.lastUrls.shift()
      pushTraffic({ url: String(d.url || ''), reqBody: d.reqBody || null, respJson: d.respJson || null, at: Number(d.at) || Date.now() })
    }
  })

  // ── REST：自己拉（同源 + 登录态）─────────────────────────────────────────
  // __dsh=1 用来把自己的请求和页面自己的请求区分开（记录器会把两者都录下来）
  function apiUrl(path, params) {
    const u = new URL(path, location.origin)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
    }
    // 页面请求带的这两个反爬参数，能抄就抄
    const msToken = readCookie('msToken')
    if (msToken) u.searchParams.set('msToken', msToken)
    u.searchParams.set('__dsh', '1')
    return u.toString()
  }

  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : ''
  }

  const COMMON = () => ({
    accountId: pageCtx.accountId,
    LIFE_IM_ACCOUNT_TYPE: '',
    CON_GROUP_ID: pageCtx.conGroupId,
    ROOT_LIFE_ACCOUNT_ID: pageCtx.rootLifeAccountId,
    root_life_account_id: pageCtx.rootLifeAccountId,
    PIGEON_BIZ_TYPE: '7',
  })

  async function getHistory(bizId, size = POLL_SIZE) {
    const url = apiUrl('/chat/api/backstage/conversation/get_history_msg', {
      ...COMMON(),
      bizConversationId: bizId,
      direction: 0,
      size,
    })
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) throw new Error(`get_history_msg HTTP ${res.status}`)
    return res.json()
  }

  async function getConversationList() {
    const url = apiUrl('/chat/api/backstage/conversation/get_current_conversation_list', {
      ...COMMON(),
      pageNo: 0,
      pageSize: 50,
      conGroupId: pageCtx.conGroupId,
    })
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) throw new Error(`get_current_conversation_list HTTP ${res.status}`)
    return res.json()
  }

  async function getUserInfo(pigeonCidList) {
    const url = apiUrl('/napi/v1/web/cs/conversation/batchGetUserInfoForMerchant', COMMON())
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pigeonCidList: pigeonCidList.slice(0, 20),
        conversationIdList: [],
        extend: { ConGroupId: pageCtx.conGroupId, lifeAccountId: pageCtx.rootLifeAccountId },
      }),
    })
    if (!res.ok) throw new Error(`batchGetUserInfoForMerchant HTTP ${res.status}`)
    return res.json()
  }

  // ── 消息归一化 ────────────────────────────────────────────────────────────
  // 只取 ext.type === 'text' 的真消息：系统事件（close_conversation /
  // allocated_service / card）不进聊天记录，否则未读会被系统消息刷爆。
  function normalizeHistory(bizId, json) {
    const data = (json && (json.data || json)) || {}
    const list = Array.isArray(data.msgList) ? data.msgList : []
    const messages = []
    let newestText = ''
    let newestAt = 0
    let talkId = ''
    for (const it of list) {
      const b = (it && it.messageBody) || {}
      const ext = b.ext || {}
      // talk_id 的可靠来源之一：就在消息的 ext 里（会话列表接口不一定录得到）
      if (!talkId) {
        const t = ext.talk_id || ext.talkId
        if (typeof t === 'string' && /^\d{6,}$/.test(t)) talkId = t
      }
      if (String(ext.type || '') !== 'text') continue
      const text = String(b.content || '').trim()
      if (!text) continue
      const role = String(ext.sender_role || '')
      const at = Number(b.createTime) || 0
      messages.push({
        id: String(it.serverMessageId || it.indexInConversation || ''),
        text,
        at,
        direction: role === '2' ? 'out' : 'in',
      })
      if (at >= newestAt) {
        newestAt = at
        newestText = text
      }
    }
    return { messages, lastText: newestText, lastAt: newestAt, talkId, nextCursor: data.nextCursor }
  }

  function syncFromHistory(bizId, json) {
    const norm = normalizeHistory(bizId, json)
    // 从历史里学到的 talk_id 要存回会话表（会话列表接口可能没录到）
    const conv = rememberConv({ bizId, talkId: norm.talkId || undefined })
    if (!conv) return
    if (norm.messages.length === 0) return
    // 每个会话只打一次，方便用户在 Console 里一眼看出「收消息通了」
    if (!conv.__logged) {
      conv.__logged = true
      log(`收消息已通：会话 ${bizId} 共 ${norm.messages.length} 条（买家 ${conv.name || conv.buyerUid || '?'}，talkId=${conv.talkId || '未知'}）`)
    }
    sendBg({
      type: 'laike_sync',
      threads: [
        {
          conversationId: bizId,
          conversationShortId: conv.talkId || norm.talkId || '',
          buyerUid: conv.buyerUid || '',
          buyerName: conv.name || '',
          buyerAvatar: conv.avatar || '',
          messages: norm.messages,
        },
      ],
    })
  }

  // ── 轮询：轮转拉所有已知会话 ──────────────────────────────────────────────
  let rrIndex = 0
  let lastListAt = 0
  let nameFetchPending = new Set()

  async function tick() {
    try {
      // 每 60s 主动刷一次会话列表（页面不一定会自己全量刷）
      if (Date.now() - lastListAt > 60000) {
        lastListAt = Date.now()
        try {
          harvest(await getConversationList())
        } catch (e) {
          warn('拉会话列表失败（继续用已录到的会话）:', e.message)
        }
      }

      const ids = [...convs.keys()]
      if (ids.length === 0) return
      // 轮转：每轮一个会话，跳过 10s 内刚拉过的
      for (let i = 0; i < ids.length; i++) {
        const bizId = ids[(rrIndex + i) % ids.length]
        const conv = convs.get(bizId)
        if (!conv) continue
        if (Date.now() - (conv.lastPolledAt || 0) < FRESH_MS) continue
        conv.lastPolledAt = Date.now()
        rrIndex = (rrIndex + i + 1) % ids.length
        try {
          const json = await getHistory(bizId)
          syncFromHistory(bizId, json)
          // 顺带补昵称（每次只补一个，避免打爆接口）
          if (!conv.name && conv.buyerUid && !nameFetchPending.has(conv.buyerUid)) {
            nameFetchPending.add(conv.buyerUid)
            void fetchNames([conv.buyerUid])
          }
        } catch (e) {
          warn(`拉 ${bizId} 历史失败:`, e.message)
        }
        return
      }
    } catch (e) {
      warn('轮询异常:', e && e.message)
    }
  }

  async function fetchNames(uids) {
    try {
      const json = await getUserInfo(uids)
      harvest(json) // 结构未知 → 照样用通用挖掘（昵称/头像字段名都覆盖到了）
    } catch (e) {
      warn('拉买家信息失败:', e.message)
    }
  }

  // ── DOM 自动化发送 ────────────────────────────────────────────────────────
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const st = window.getComputedStyle(el)
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity || '1') > 0.01
  }

  /**
   * 左侧会话列表项候选。
   *
   * ⚠️ 来客前端用的是 **CSS Modules**，类名带哈希后缀（`contactCard-NdfsWo`）。
   * 实测真实的会话卡片类名是 `contactCard-*`，选中态多一个 `selected-*`。
   * 早期版本只猜 conversation/session/li —— **全部匹配 0 个**，发送必然失败。
   *
   * 两级策略：
   *   ① 已知类名模式（快、准）
   *   ② 找不到时用**重复结构启发式**：左栏里同一 class 反复出现、高度相近的
   *      元素就是列表项。这样即使来客改了类名也不会立刻失效。
   */
  function listItemCandidates() {
    const known = [
      '[class*="contactCard" i]',
      '[class*="conversation" i]',
      '[class*="session" i]',
      '[class*="chat-item" i]',
      '[class*="chatItem" i]',
      'li',
      '[role="listitem"]',
    ].join(',')

    const accept = (el) => {
      if (!isVisible(el)) return false
      const r = el.getBoundingClientRect()
      if (r.height > 160 || r.height < 24 || r.width < 120) return false
      const txt = String(el.innerText || '').trim()
      if (!txt || txt.length > 200) return false
      return { el, text: txt }
    }

    let hit = []
    for (const el of document.querySelectorAll(known)) {
      const ok = accept(el)
      if (ok) hit.push(ok)
    }
    // 去掉「包含其他候选」的外层容器，保留最内层的
    hit = hit.filter((c) => !hit.some((o) => o !== c && c.el.contains(o.el)))
    if (hit.length > 0) return hit.slice(0, 40)

    // ② 重复结构启发式：只扫左栏，按 class 分组，出现 ≥2 次且高度相近的算列表项
    const all = document.querySelectorAll('div,li,a,span')
    const cap = Math.min(all.length, 2500)
    const groups = new Map()
    for (let i = 0; i < cap; i++) {
      const el = all[i]
      let r
      try {
        r = el.getBoundingClientRect()
      } catch {
        continue
      }
      if (!r || r.left > 460 || r.width < 140 || r.height < 36 || r.height > 140) continue
      const cls = String(el.className || '')
      if (!cls || cls.length > 120) continue
      const txt = String(el.innerText || '').trim()
      if (!txt || txt.length > 200) continue
      if (!groups.has(cls)) groups.set(cls, [])
      groups.get(cls).push({ el, text: txt, h: Math.round(r.height), top: Math.round(r.top) })
    }
    let best = []
    for (const list of groups.values()) {
      if (list.length < 2) continue
      const hs = list.map((x) => x.h)
      if (Math.max(...hs) - Math.min(...hs) > 8) continue // 高度不一致 → 不是同一个列表
      if (list.length > best.length) best = list
    }
    if (best.length >= 2) {
      warn(`会话列表用启发式识别到（class 重复 ${best.length} 次）—— 建议把类名加进 known 列表`)
      return best
        .slice(0, 40)
        .filter((c) => !best.some((o) => o !== c && c.el.contains(o.el)))
        .map((c) => ({ el: c.el, text: c.text }))
    }
    return []
  }

  /**
   * 点击元素。
   *
   * 用 `elementFromPoint` 取**真正的落点元素**再派发 —— 真实点击命中的是最内层
   * 那个元素，事件再冒泡上去。直接对容器派发时，如果 onClick 挂在内层子元素上
   * 就不会触发（React 的合成事件也依赖这个冒泡路径）。
   */
  function clickEl(el) {
    const r = el.getBoundingClientRect()
    const clientX = r.left + Math.min(r.width / 2, 40)
    const clientY = r.top + Math.min(r.height / 2, 20)
    let target = el
    try {
      const t = document.elementFromPoint(clientX, clientY)
      if (t && (t === el || el.contains(t))) target = t
    } catch {
      /* 拿不到就用容器本身 */
    }
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
    }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        target.dispatchEvent(new MouseEvent(type, opts))
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * DOM 体检 —— 只在**出错时**调用（正常路径零开销）。
   *
   * 目的：选择器失配时不要只说"没找到"，而是把页面上**实际有什么**报出来。
   * 有这份数据，一次就能把选择器钉死，不用来回猜。
   */
  function domDigest() {
    const out = {
      at: new Date().toISOString(),
      url: location.href.slice(0, 200),
      selectorCounts: {},
      leftColumnSamples: [],
      inputs: [],
      buttons: [],
    }
    const sels = [
      '[class*="contactCard" i]',
      '[class*="conversation" i]',
      '[class*="session" i]',
      '[class*="chat-item" i]',
      '[class*="chatItem" i]',
      '[role="listitem"]',
      'li',
    ]
    for (const s of sels) {
      try {
        out.selectorCounts[s] = document.querySelectorAll(s).length
      } catch {
        out.selectorCounts[s] = -1
      }
    }
    // 左半屏（会话列表通常在这一列）的元素样本。
    // 只做 rect 判断、不调 getComputedStyle —— 否则几千个元素会把页面卡住。
    let all = []
    try {
      all = document.querySelectorAll('div,li,a,span')
    } catch {
      all = []
    }
    const cap = Math.min(all.length, 2500)
    const seen = new Set()
    for (let i = 0; i < cap; i++) {
      const el = all[i]
      let r
      try {
        r = el.getBoundingClientRect()
      } catch {
        continue
      }
      if (!r || r.left > 420 || r.width < 80 || r.height < 28 || r.height > 160) continue
      const txt = String(el.innerText || el.textContent || '').trim()
      if (!txt || txt.length > 60) continue
      const cls = String(el.className || '').slice(0, 80)
      const key = cls + txt.slice(0, 12)
      if (seen.has(key)) continue
      seen.add(key)
      out.leftColumnSamples.push({ tag: el.tagName, cls, txt: txt.slice(0, 30), top: Math.round(r.top), h: Math.round(r.height) })
      if (out.leftColumnSamples.length >= 12) break
    }
    for (const el of document.querySelectorAll('[contenteditable="true"], textarea, button, [role="button"]')) {
      let r
      try {
        r = el.getBoundingClientRect()
      } catch {
        continue
      }
      if (!r || r.width < 20 || r.height < 12) continue
      const item = {
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 60),
        txt: String(el.innerText || el.textContent || '').trim().slice(0, 20),
        top: Math.round(r.top),
        h: Math.round(r.height),
      }
      if (el.tagName === 'BUTTON' || (el.getAttribute && el.getAttribute('role') === 'button')) {
        if (out.buttons.length < 10) out.buttons.push(item)
      } else if (out.inputs.length < 6) out.inputs.push(item)
    }
    return out
  }

  /** 失败时附上 DOM 体检 + 记录器健康度（同时打到页面 Console，方便直接复制） */
  function failDetail(extra) {
    let dom = null
    try {
      dom = domDigest()
      warn('DOM 体检:', JSON.stringify(dom))
    } catch (e) {
      dom = { error: String((e && e.message) || e) }
    }
    const recorder = {
      ready: recorderHealth.ready,
      seen: recorderHealth.seen,
      lastTrafficAgoMs: recorderHealth.lastAt ? Date.now() - recorderHealth.lastAt : -1,
      lastBeatAgoMs: recorderHealth.lastBeatAt ? Date.now() - recorderHealth.lastBeatAt : -1,
      lastUrls: recorderHealth.lastUrls,
      knownConversations: convs.size,
      withTalkId: [...convs.values()].filter((c) => c.talkId).length,
    }
    warn('记录器健康度:', JSON.stringify(recorder))
    return { ...extra, recorder, dom }
  }

  /**
   * 找到输入框（contenteditable 优先，其次 textarea）。
   *
   * 单纯取"面积最大"不够稳：工作台别处也可能有大编辑区（快捷回复/卡片模板）。
   * 聊天输入框的位置特征更强 —— 它在**页面下半部**。所以：
   * 优先在"下半屏"的候选里挑，没有才退回全局最大。
   */
  function findInput() {
    const cands = []
    for (const el of document.querySelectorAll('[contenteditable="true"], textarea')) {
      if (!isVisible(el)) continue
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') continue
      const r = el.getBoundingClientRect()
      if (r.width < 100 || r.height < 16) continue
      cands.push({ el, area: r.width * r.height, bottom: r.top + r.height, top: r.top })
    }
    const vh = window.innerHeight || 900
    const lowerHalf = cands.filter((c) => c.top > vh * 0.4)
    const pool = lowerHalf.length > 0 ? lowerHalf : cands
    // 下半屏里取最靠下的（输入框在底部），面积做次要权重
    pool.sort((a, b) => b.bottom - a.bottom || b.area - a.area)
    return pool[0] ? pool[0].el : null
  }

  /** 读回输入框当前内容（用来确认"真的写进去了"）。 */
  function readInputText(el) {
    if (!el) return ''
    const tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return String(el.value || '')
    return String(el.innerText || el.textContent || '')
  }

  /**
   * 把文本写进输入框，返回**是否确认写入成功**。
   *
   * contenteditable 的坑：直接 `textContent = x` 会让 React/富文本编辑器的
   * 内部 state 对不上，之后点发送会被当成"空内容"而不发。
   * 正确做法：聚焦 → 用 Range 把光标放到编辑区末尾（必要时先选中清空）
   * → `execCommand('insertText')`（它会触发 input 事件，编辑器才认）。
   */
  /** 最近一次写输入框走的是哪条路（诊断用）。 */
  let lastInputVia = ''

  function setInputText(el, text) {
    el.focus()
    const tag = el.tagName
    lastInputVia = ''
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      // ① 先走**真实输入管线**：execCommand('insertText') 会触发 beforeinput + input，
      //    React 的 onChange 一定会收到 —— 比直接改 value 更接近真人打字。
      //    （踩过：DOM 里有文字，但应用 state 还是空 → 点发送什么也不发）
      let viaCmd = false
      try {
        const cur = readInputText(el)
        if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, cur.length)
        if (cur) document.execCommand('delete', false, null)
        viaCmd = document.execCommand('insertText', false, text)
      } catch {
        viaCmd = false
      }
      if (viaCmd && readInputText(el).includes(text)) {
        lastInputVia = 'execCommand'
        return true
      }
      // ② 退回原生 setter（React 受控组件的经典绕法：绕过它的 value tracker）
      try {
        const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      } catch {
        /* ignore */
      }
      lastInputVia = 'nativeSetter'
      return readInputText(el).includes(text)
    }

    const sel = window.getSelection ? window.getSelection() : null
    const selectContents = () => {
      const range = document.createRange()
      range.selectNodeContents(el)
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
    const caretToEnd = () => {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }

    // 先清掉草稿（如果有）
    if (readInputText(el).trim()) {
      try {
        selectContents()
        document.execCommand('delete', false, null)
      } catch {
        /* ignore */
      }
    }
    caretToEnd()
    let inserted = false
    try {
      inserted = document.execCommand('insertText', false, text)
    } catch {
      inserted = false
    }
    if (!inserted || !readInputText(el).includes(text)) {
      // 退路：直接改文本 + 手动派发 input（有些编辑器只认这条）
      try {
        el.textContent = text
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      } catch {
        /* ignore */
      }
      lastInputVia = 'textContent'
    } else {
      lastInputVia = 'execCommand'
    }
    return readInputText(el).includes(text)
  }

  /** 发送按钮是否被禁用（禁用了就别点，点了也是假的）。 */
  function isDisabled(el) {
    if (!el) return true
    if (el.disabled === true) return true
    if (String(el.getAttribute('aria-disabled') || '') === 'true') return true
    const cls = String(el.className || '')
    if (/(^|[\s-])(disabled|is-disabled)([\s-]|$)/i.test(cls)) return true
    return false
  }

  function findSendButton() {
    const cands = []
    for (const el of document.querySelectorAll('button, [role="button"], [class*="send" i]')) {
      if (!isVisible(el)) continue
      const txt = (el.innerText || el.textContent || '').trim()
      const cls = String(el.className || '')
      if (/发送/.test(txt)) cands.push({ el, score: 100 })
      else if (/send/i.test(cls) && txt.length <= 12) cands.push({ el, score: 60 })
      else if (/^\s*(发送|Send)\s*$/i.test(txt)) cands.push({ el, score: 90 })
    }
    cands.sort((a, b) => b.score - a.score)
    return cands[0] ? cands[0].el : null
  }

  /** 点输入框里的 Enter（很多聊天框回车发送）。 */
  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      )
    }
  }

  /**
   * 通过「点击后页面是否请求了该会话的历史」来确认目标会话真的被打开了。
   * 这是**数据依据**，不是靠标题猜 —— 猜错就会把消息发给别人。
   */
  /** 这张卡片是不是"当前选中"状态（来客用 CSS Modules，选中态类名含 selected）。 */
  function isSelected(el) {
    try {
      return /selected/i.test(String(el.className || ''))
    } catch {
      return false
    }
  }

  /**
   * 点击后确认"目标会话确实打开了"，返回用的是哪个依据（空串=没确认）。
   *
   * 三个依据，从强到弱：
   *   1. `history` —— 页面自己发起了该会话的 get_history_msg（最强，但**可能不出现**：
   *      会话历史已被前端缓存时不会再请求）
   *   2. `url`     —— URL 里的 talkId 变成了目标会话的 talkId
   *   3. `selected`—— 我们点的那张卡片被标记为选中（反映应用自己的状态）
   */
  async function waitForOpen(cand, conversationId, talkId, histPromise, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let viaHist = false
    histPromise.then((v) => {
      viaHist = Boolean(v)
    }).catch(() => {})
    for (;;) {
      if (viaHist) return 'history'
      if (talkId && location.href.indexOf(talkId) >= 0) return 'url'
      if (isSelected(cand.el)) return 'selected'
      if (Date.now() >= deadline) return ''
      await sleep(120)
    }
  }

  async function openConversation(target) {
    const { conversationId, buyerUid, displayName, talkId } = target

    const items = listItemCandidates()
    if (items.length === 0) {
      return {
        ok: false,
        error: 'conversation_list_not_found: 页面上没找到会话列表（左侧列表选择器没匹配上）',
        detail: failDetail({ candidates: 0 }),
      }
    }

    const byName = displayName ? items.filter((c) => c.text.includes(displayName)) : []
    const byUid = buyerUid ? items.filter((c) => c.text.includes(String(buyerUid))) : []
    const named = [...new Set([...byName, ...byUid])]
    let ordered = [...new Set([...named, ...items])]
    // 名字/uid 匹配上的优先；兜底扫描限制在 8 个以内，避免把整列表都点一遍
    ordered = named.length ? ordered : ordered.slice(0, 8)

    const tried = []
    for (const cand of ordered) {
      // ⚠️ 必须先挂监听再点击：页面的 get_history_msg 可能来得非常快
      // （命中缓存 / 本地状态），先点后挂会漏掉这个证据。
      const histPromise = waitForHistoryRequest(conversationId, 4200)
      clickEl(cand.el)
      const via = await waitForOpen(cand, conversationId, talkId, histPromise, 4200)
      const matched = named.includes(cand)
      tried.push({ text: cand.text.slice(0, 40), via: via || '未确认', matched })
      // ★ 安全：只有**按名字/uid 匹配上**的候选才允许用「选中态」作为依据。
      //   盲扫（没匹配上）时只用数据依据（history / url），否则可能点错人还发出去。
      if (via && (via !== 'selected' || matched)) {
        log(`已确认目标会话打开（依据=${via}，候选="${cand.text.slice(0, 20)}"）`)
        return { ok: true, via }
      }
      if (via === 'selected') {
        warn('候选被选中但名字没匹配上目标买家 —— 不敢当成功，继续找')
      }
    }
    return {
      ok: false,
      error:
        `conversation_not_confirmed: 点了 ${ordered.length} 个候选都没能确认打开目标会话（${conversationId}）。` +
        `为避免发错人，已中止。` +
        (named.length === 0 ? '（列表里没有任何一个候选的文本包含目标买家名/uid）' : ''),
      detail: failDetail({ candidates: ordered.length, namedMatches: named.length, target: conversationId, talkId: talkId || '', tried }),
    }
  }

  /**
   * 回读历史，确认我们的文本**这一次**真的作为「客服发出」出现在会话里。
   *
   * ⚠️ 这里曾经有个假成功：只按「方向 out + 文本一致」匹配，那么当这句话
   * 在历史里本来就存在时（比如之前发过同样的内容），输入框没生效、什么都没发，
   * 也会匹配到那条**旧消息**并回报成功 —— DSH 显示已发、来客什么都没收到。
   *
   * 所以必须加两道时间门：
   *   1. 消息 id 不在发送前的基线集合里（`beforeIds`）
   *   2. 服务端 createTime 不早于点击发送的时刻（`notBeforeAt`，留 5s 容差）
   * 来客的 createTime 是标准 UTC 毫秒时间戳，可以直接和 Date.now() 比。
   */
  async function confirmSent(bizId, text, beforeIds, notBeforeAt, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastSeen = ''
    while (Date.now() < deadline) {
      try {
        const json = await getHistory(bizId, 10)
        const norm = normalizeHistory(bizId, json)
        for (let i = norm.messages.length - 1; i >= 0; i--) {
          const m = norm.messages[i]
          if (m.direction !== 'out' || m.text !== text) continue
          lastSeen = m.id
          const isNew = !beforeIds.has(String(m.id))
          const isFresh = !notBeforeAt || !m.at || m.at >= notBeforeAt - 5000
          if (isNew && isFresh) return m
        }
      } catch (e) {
        warn('回读确认失败（继续重试）:', e.message)
      }
      await sleep(1200)
    }
    if (lastSeen) {
      warn(`回读只找到同样文本的**旧**消息(${lastSeen})，不算本次成功 —— 说明这次其实没发出去`)
    }
    return null
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function handleSend(cmd, reply) {
    const bizId = String(cmd.conversation_id || '')
    const text = String(cmd.text || '')
    if (!bizId || !text) {
      reply({ ok: false, error: 'missing conversation_id or text' })
      return
    }

    const opened = await openConversation({
      conversationId: bizId,
      buyerUid: String(cmd.buyer_uid || ''),
      displayName: String(cmd.display_name || ''),
      // 目标会话的 talkId：用于「URL 里出现该 talkId」这条确认依据
      talkId: String(cmd.conversation_short_id || '') || (convs.get(bizId) || {}).talkId || '',
    })
    if (!opened.ok) {
      reply({ ok: false, error: opened.error, detail: opened.detail })
      return
    }

    // 打开后再等一下让输入区渲染完
    await sleep(600)
    const input = findInput()
    if (!input) {
      reply({ ok: false, error: 'input_not_found: 没找到消息输入框', detail: failDetail({}) })
      return
    }

    // ★ 步骤 1：写入并**确认真的写进去了** —— 写不进去就绝不点发送
    let wrote = false
    try {
      wrote = setInputText(input, text)
    } catch (e) {
      reply({ ok: false, error: `input_failed: ${e.message}` })
      return
    }
    if (!wrote) {
      const r = input.getBoundingClientRect ? input.getBoundingClientRect() : {}
      reply({
        ok: false,
        error:
          'input_rejected: 文本没能写进输入框（编辑器没接受）。已中止，没有点发送。请把页面结构发我，我按实际的编辑区改。',
        detail: failDetail({
          inputTag: input.tagName,
          inputVia: lastInputVia,
          inputRect: { top: Math.round(r.top || 0), left: Math.round(r.left || 0), w: Math.round(r.width || 0), h: Math.round(r.height || 0) },
          inputText: readInputText(input).slice(0, 100),
        }),
      })
      return
    }
    await sleep(250)

    // ★ 步骤 2：发送前先取一次历史基线 —— 回读时只认「基线之后新出现的」消息，
    // 避免匹配到历史里同样文本的旧消息，造成假成功。
    let beforeIds = new Set()
    try {
      const before = normalizeHistory(bizId, await getHistory(bizId, 10))
      beforeIds = new Set(before.messages.map((m) => String(m.id)))
    } catch (e) {
      warn('取发送前基线失败（会退化成只按时间判定）:', e.message)
    }
    const sentAt = Date.now()

    // ★ 步骤 3：发送。**按钮点和回车都试**，因为：
    //   - 有的编辑器只认回车（按钮虽在，点了不触发它的提交逻辑）
    //   - 有的按钮挂了 onMouseDown / 被父级拦截，合成点击不生效
    //   单试一条路失败就整体报失败，会产生"明明有按钮却发不出去"的死结。
    const btn = findSendButton()
    const btnState = btn
      ? { found: true, disabled: isDisabled(btn), cls: String(btn.className || '').slice(0, 80), txt: String(btn.innerText || '').trim().slice(0, 10) }
      : { found: false }
    if (btn && isDisabled(btn)) {
      reply({
        ok: false,
        error: 'send_button_disabled: 发送按钮是禁用状态（通常表示应用认为输入框里还是空的）。已中止，请把页面结构发我。',
        detail: failDetail({ inputText: readInputText(input).slice(0, 100), sendPath: 'none', btnState }),
      })
      return
    }

    const attempted = []
    let confirmed = null
    if (btn) {
      clickEl(btn)
      attempted.push('button')
      confirmed = await confirmSent(bizId, text, beforeIds, sentAt, 5000)
    }
    if (!confirmed) {
      // 按钮那条路没成 → 改试回车（真实用户最常用的方式）
      pressEnter(input)
      attempted.push('enter')
      confirmed = await confirmSent(bizId, text, beforeIds, sentAt, 7000)
    }

    // ★ 步骤 4：只信回读，且只认「本次新出现」的那条
    if (!confirmed) {
      reply({
        ok: false,
        error:
          'send_not_confirmed: 已执行发送动作（' +
          attempted.join(' → ') +
          '），但回读历史没有看到这条**新**消息。可能输入框没生效或被拦截 —— 请在来客页面上确认，不要当成功。',
        detail: failDetail({
          conversation_id: bizId,
          text,
          sendPath: attempted.join(' → '),
          inputVia: lastInputVia,
          inputText: readInputText(input).slice(0, 100),
          btnState,
        }),
      })
      return
    }
    reply({ ok: true, detail: { server_message_id: confirmed.id, conversation_id: bizId, via: attempted.join(' → ') } })
  }

  // ── 与后台通信 ────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.platform !== PLATFORM) return false // 不是来客的指令，交回后台
    if (msg.type === 'laike_send') {
      handleSend(msg, (out) => {
        try {
          sendResponse(out)
        } catch {
          /* ignore */
        }
      })
      return true // 异步回复
    }
    if (msg.type === 'laike_dump') {
      sendResponse({
        ok: true,
        detail: {
          accountId: ACCOUNT_ID,
          pageCtx,
          conversations: [...convs.values()].map((c) => ({ bizId: c.bizId, talkId: c.talkId, buyerUid: c.buyerUid, name: c.name })),
          traffic: traffic.map((t) => ({ url: t.url.slice(0, 300), hasReq: Boolean(t.reqBody), hasResp: Boolean(t.respJson) })),
          inputFound: Boolean(findInput()),
          sendButtonFound: Boolean(findSendButton()),
          listItems: listItemCandidates().length,
        },
      })
      return true
    }
    return false
  })

  // ── 启动 ──────────────────────────────────────────────────────────────────
  log(`来客模块启动，账号 ${ACCOUNT_ID}，conGroupId=${pageCtx.conGroupId || '(未知)'}`)
  // 周期性重报平台账号：桥可能晚于本页启动，一次性上报会丢（丢了的后果是把来客
  // 数据记到抖音账号名下）。桥侧也有自愈逻辑，这里是第二道保险。
  announce()
  setInterval(announce, 30000)
  setInterval(() => void tick(), POLL_GAP_MS)
  setTimeout(() => void tick(), 1500)
})()
