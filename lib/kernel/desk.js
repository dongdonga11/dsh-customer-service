/**
 * dsh-cs kernel — 客服台聚合（纯函数式：不碰网络、不碰 ctx、不发请求）
 *
 * 这一层只做「把 store 里的原始数据整理成面板要的形状」，所有平台差异都通过
 * adapter 方法获得（canSend / enrichBuyer / spec），本文件不得出现平台专有字符串。
 *
 * 行为基线：lib/_legacy/index.js 698–741（`/state` 的账号卡与会话行）。
 * 字段名一个都不能改 —— client 半（lib/client.js）直接消费这些字段。
 */

/** 从 adapter 列表里挑出负责该平台的适配器；无匹配且只有一个 adapter 时兜底用它。 */
export function adapterFor(adapters, platform) {
  const list = Array.isArray(adapters) ? adapters.filter(Boolean) : adapters ? [adapters] : []
  if (list.length === 0) return null
  if (platform) {
    const hit = list.find((a) => {
      const spec = a.spec || {}
      const names = [].concat(spec.platforms || [], spec.handles || [], spec.name || [])
      return names.includes(platform)
    })
    if (hit) return hit
    // 子平台（如 spec.subSpecs 里的独立 platform id）
    const sub = list.find((a) => {
      const spec = a.spec || {}
      return (spec.subSpecs || []).some((s) => s && s.name === platform)
    })
    if (sub) return sub
  }
  return list.length === 1 ? list[0] : null
}

/** 归一化 bridges 入参：允许单个桥或桥数组。 */
export function asBridgeList(bridges) {
  if (!bridges) return []
  return Array.isArray(bridges) ? bridges.filter(Boolean) : [bridges]
}

/**
 * 为某个适配器挑一条桥。
 * M1 只有一条桥；M2 多平台时按 `defaultPlatform` 匹配，匹配不到退第一条。
 */
export function bridgeFor(adapters, bridges, adapter) {
  const list = asBridgeList(bridges)
  if (list.length === 0) return null
  const name = adapter && adapter.spec ? adapter.spec.name : ''
  if (name) {
    const hit = list.find((b) => b && b.defaultPlatform === name)
    if (hit) return hit
  }
  return list[0]
}

/** 该会话/账号所属平台（缺省用 adapter spec.name）。 */
function platformOfThread(thread, adapter) {
  return (thread && thread.platform) || (adapter && adapter.spec && adapter.spec.name) || ''
}

// ── 会话行 ───────────────────────────────────────────────────────────────────

/**
 * 会话列表行（面板左侧 + 工作台头部消费）。
 *
 * @param {object} store
 * @param {string} [platform] 可选过滤（只看某平台）
 * @param {object} [opts] { adapters, log }
 * @returns {Array<object>} 与旧 `/state.threads` 字段一致
 */
export function listThreads(store, platform, opts = {}) {
  const adapters = opts.adapters || []
  const rows = []
  for (const t of store.getThreads()) {
    if (platform && t.platform !== platform) continue
    const adapter = adapterFor(adapters, t.platform)
    let enriched = { name: '', avatar: '', nameKnown: false }
    if (adapter && typeof adapter.enrichBuyer === 'function') {
      try {
        enriched = adapter.enrichBuyer(t, { store }) || enriched
      } catch (e) {
        logWarn(opts.log, `enrichBuyer 失败（${t.id}）: ${(e && e.message) || e}`)
      }
    } else {
      // 无适配器时退化为 store 解析链（内核自带的通用逻辑）
      enriched = {
        name: store.resolveName(t.buyerUid, t.buyerSecUid) || '',
        avatar: store.resolveAvatar(t.buyerUid, t.buyerSecUid) || '',
        nameKnown: Boolean(store.resolveName(t.buyerUid, t.buyerSecUid)),
      }
    }
    rows.push({
      ...t,
      displayName: enriched.name || t.buyerSecUid || t.buyerUid || '买家',
      avatar: enriched.avatar || '',
      nameKnown: Boolean(enriched.nameKnown),
    })
  }
  return rows
}

/**
 * 单个会话视图：`{ thread, messages }`。
 * 与旧 `/thread` 一致 —— thread 原样返回（不附加 displayName，面板顶栏用的是列表行）。
 */
export function getThreadView(store, threadId, adapter) {
  const thread = store.getThread(threadId)
  if (!thread) return null
  return { thread, messages: store.getMessages(threadId) }
}

// ── 账号卡 ───────────────────────────────────────────────────────────────────

/**
 * 账号行（客服中心第一层「账号卡」）。
 *
 * 与旧 `/state.accounts` 逐字段一致：
 * `{...account, platform, displayName, connected, canSend, unread, threadCount}`
 *
 * @param {object} store
 * @param {Array} adapters
 * @param {Array|object} bridges
 * @param {object} [opts] { log }
 */
export function listAccounts(store, adapters, bridges, opts = {}) {
  const threads = store.getThreads()
  const rows = []
  for (const a of store.getAccounts()) {
    const adapter = adapterFor(adapters, a.platform)
    const platform = a.platform || (adapter && adapter.spec ? adapter.spec.name : '')
    const bridge = bridgeFor(adapters, bridges, adapter)
    const connected = Boolean(bridge && bridge.hasAccount(a.id)) && a.connected !== false
    let canSend = false
    if (adapter && typeof adapter.canSend === 'function') {
      try {
        const r = adapter.canSend({ ...a, platform, connected }, { store, bridge }) || {}
        canSend = r.ok === true
      } catch (e) {
        logWarn(opts.log, `canSend 失败（${a.id}）: ${(e && e.message) || e}`)
        canSend = a.canSend === true
      }
    } else {
      canSend = a.canSend === true
    }
    const own = threads.filter((t) => t.accountId === a.id)
    rows.push({
      ...a,
      platform,
      displayName: store.resolveAccountName(a) || a.detectedId || a.id,
      connected,
      canSend,
      unread: own.reduce((sum, t) => sum + (t.unread || 0), 0),
      threadCount: own.length,
    })
  }
  return rows
}

// ── 平台卡 ───────────────────────────────────────────────────────────────────

/**
 * 平台摘要行（客服中心第一层分组头 / 导航角标）。
 *
 * 这是旧版没有的新结构（旧版把平台名硬编码在 client 里）；M2 多平台时用。
 *
 * @param {Array} adapters
 * @param {Array|object} bridges
 * @returns {Array<{name,label,sendMode,connected,accounts,threadCount}>}
 */
export function listPlatforms(adapters, bridges) {
  const list = Array.isArray(adapters) ? adapters.filter(Boolean) : adapters ? [adapters] : []
  const out = []
  for (const adapter of list) {
    const spec = adapter.spec || {}
    const bridge = bridgeFor(list, bridges, adapter)
    const accounts = bridge ? (bridge.accountsOfPlatform(spec.name) || []) : []
    out.push({
      name: spec.name || '',
      label: spec.label || spec.name || '',
      sendMode: (spec.capabilities && spec.capabilities.sendMode) || '',
      requiresSendTemplate: Boolean(spec.capabilities && spec.capabilities.requiresSendTemplate),
      connected: Boolean(bridge && bridge.isConnected),
      /** 该平台自己的桥地址/配对码（多平台时面板必须按平台显示，否则会填错码） */
      host: (bridge && bridge.host) || '',
      port: (bridge && bridge.port) || 0,
      pairCode: (bridge && bridge.pairCode) || '',
      bridgeRunning: Boolean(bridge && bridge.isConnected),
      accounts,
      accountCount: accounts.length,
    })
  }
  return out
}

// ── 读状态 / 未读 / 改名 / 删除 ──────────────────────────────────────────────

export function unreadTotal(store, filter = {}) {
  const { accountId = '', platform = '' } = filter
  let sum = 0
  for (const t of store.getThreads()) {
    if (accountId && t.accountId !== accountId) continue
    if (platform && t.platform !== platform) continue
    sum += t.unread || 0
  }
  return sum
}

export function markRead(store, threadId) {
  if (!threadId) return false
  store.markRead(threadId)
  return true
}

/**
 * 手动改名（优先级最高）。返回 false 表示会话不存在。
 */
export function renameThread(store, threadId, name) {
  const thread = store.getThread(threadId)
  if (!thread) return false
  store.renameContact(thread.buyerUid, thread.buyerSecUid, name)
  return true
}

export async function deleteThread(store, threadId) {
  if (!threadId) return false
  await store.deleteThread(threadId)
  return true
}

export async function clearAll(store) {
  await store.clearAll()
  return true
}

function logWarn(log, msg) {
  try {
    if (log && typeof log.warn === 'function') log.warn(msg)
    else console.warn(msg)
  } catch {
    /* ignore */
  }
}
