/**
 * dsh-cs — 闲鱼【客户档案】（每个买家一份，持续累积；聚合话术库的原料）
 * ============================================================================
 *
 * 语义对齐 Hermes：`plugins/platforms/xianyu/customer_store.py`（逐函数迁移，camelCase 字段）
 *
 * 设计要点：
 *   - **每个买家都留档**（不只成交的）——所有沟通记录都是后续提炼话术的原料；
 *   - 对话流水 `turns` 上限 **200** 条（超出丢最旧的，防无限膨胀）；
 *   - 分析字段（tags/region/gender/psychology/deal/notes/avatarUrl）由 agent 或聚合回填；
 *   - `upsertProfiles` 把扩展捕获的 `mtop.taobao.idlemessage.pc.user.query` 结果写进来
 *     （昵称取 fishNick、头像取 logo；有值就覆盖，比 WS 里的脱敏 nick 更准）。
 *
 * 落盘：`<dataDir>/customers/<accountId>/<buyerId>.json`（默认 dataDir=$DSH_HOME/dsh-cs）
 *
 * 并发/持久化边界（与 product_store 一致）：
 *   - 单进程内按「买家文件」串行化读写；原子写（tmp + rename）；
 *   - 损坏 JSON 备份成 `.corrupt-<ts>` 后当空档案；**不做跨进程锁**。
 *
 * 三套存储刻意互不 import：各自独立、可单独搬迁复用。
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 单个买家档案最多保留多少轮对话（customer_store.py:26） */
export const MAX_TURNS = 200

/** update() 允许写入的普通字段白名单（customer_store.py:142） */
export const PROFILE_FIELDS = ['buyerNick', 'region', 'gender', 'psychology', 'notes', 'avatarUrl']

/** 输入别名：工具层 schema 用 snake_case，存储统一 camelCase。 */
const PROFILE_ALIASES = { buyer_nick: 'buyerNick', avatar_url: 'avatarUrl' }

// ── 内部小工具（与 product_store 刻意各留一份，保持模块独立） ───────────────

function resolveDataRoot(explicit) {
  if (explicit) return String(explicit)
  const envDir = process.env.DSH_CS_DATA_DIR
  if (envDir) return String(envDir)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-cs')
}

function safeName(value, fallback = 'default') {
  const s = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  return s || fallback
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function nowStr() {
  const d = new Date()
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(
    d.getSeconds(),
  )}`
}

function normalizeLog(log) {
  const l = log && typeof log === 'object' ? log : {}
  const mk = (fn, level) => (msg) => {
    try {
      if (typeof fn === 'function') fn(msg)
      else console[level](msg)
    } catch {
      /* ignore */
    }
  }
  return { info: mk(l.info, 'log'), warn: mk(l.warn, 'warn'), error: mk(l.error, 'error'), debug: mk(l.debug, 'debug') }
}

async function readJsonSafe(path, lg, label) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return {}
    lg.warn(`[${label}] 读取失败（按空档案处理）: ${path} → ${(e && e.message) || e}`)
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    return isObj(parsed) ? parsed : {}
  } catch {
    try {
      await rename(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    lg.warn(`[${label}] JSON 损坏，已备份并重置: ${path}`)
    return {}
  }
}

async function atomicWriteJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

function createKeyedQueue() {
  const tails = new Map()
  return function withLock(key, fn) {
    const prev = tails.get(key) || Promise.resolve()
    const next = prev.then(
      () => fn(),
      () => fn(),
    )
    const tail = next.then(
      () => {},
      () => {},
    )
    tails.set(key, tail)
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return next
  }
}

function toStr(v) {
  return v === undefined || v === null ? '' : String(v)
}

/** 新建一份空档案（customer_store.py:96-106 / 136-141）。 */
function emptyProfile(buyerId, accountId) {
  return {
    buyerId,
    buyerNick: '',
    accountId: toStr(accountId),
    firstSeen: nowStr(),
    lastSeen: '',
    turns: [],
    // 分析字段（聚合/agent 回填）
    tags: [],
    region: '',
    gender: '',
    psychology: '',
    interestedItems: [],
    deal: false,
    notes: '',
    avatarUrl: '',
  }
}

/** 把 fields 合并进档案（update 与 upsertProfiles 共用一份规则，snake_case 也认）。 */
function mergeProfile(rec, fields = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k) && fields[k] !== null && fields[k] !== undefined
  for (const k of PROFILE_FIELDS) {
    if (has(k)) {
      rec[k] = fields[k]
      continue
    }
    const alias = Object.keys(PROFILE_ALIASES).find((a) => PROFILE_ALIASES[a] === k)
    if (alias && has(alias)) rec[k] = fields[alias]
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'deal')) rec.deal = Boolean(fields.deal)
  if (Array.isArray(fields.tags)) {
    // 合并去重后排序（customer_store.py:147-152）
    const merged = new Set(Array.isArray(rec.tags) ? rec.tags : [])
    for (const t of fields.tags) merged.add(t)
    rec.tags = [...merged].sort()
  }
  rec.updatedAt = nowStr()
  return rec
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

/**
 * 创建客户档案库。
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir] 数据根目录（默认 `$DSH_HOME/dsh-cs`）
 * @param {object} [opts.log]     日志器
 */
export function createCustomerStore({ dataDir, log } = {}) {
  const dataRoot = resolveDataRoot(dataDir)
  const dir = join(dataRoot, 'customers')
  const withLock = createKeyedQueue()
  const lg = normalizeLog(log)

  function accountDir(accountId) {
    return join(dir, safeName(accountId))
  }

  /** 某买家档案文件路径（customer 的 pathFor 带 buyerId）。 */
  function pathFor(accountId, buyerId) {
    return join(accountDir(accountId), `${safeName(buyerId, 'unknown')}.json`)
  }

  const lockKey = (accountId, buyerId) => `${safeName(accountId)}/${safeName(buyerId, 'unknown')}`
  const load = (accountId, buyerId) => readJsonSafe(pathFor(accountId, buyerId), lg, 'customer')
  const save = (accountId, buyerId, rec) => atomicWriteJson(pathFor(accountId, buyerId), rec)

  /**
   * 追加一轮对话（入站链路调用）。
   *
   * @param {string} accountId
   * @param {string} buyerId
   * @param {{buyerNick?:string, chatId?:string, itemId?:string, itemTitle?:string,
   *          buyerMsg?:string, reply?:string}} [turn]
   * @returns {Promise<object|null>} 更新后的档案（buyerId 为空返回 null）
   */
  async function recordTurn(accountId, buyerId, turn = {}) {
    const bid = toStr(buyerId).trim()
    if (!bid) return null
    const { buyerNick = '', chatId = '', itemId = '', itemTitle = '', buyerMsg = '', reply = '' } = turn || {}
    return withLock(lockKey(accountId, bid), async () => {
      const existing = await load(accountId, bid)
      const rec = isObj(existing) && existing.buyerId ? existing : emptyProfile(bid, accountId)
      if (buyerNick && !rec.buyerNick) rec.buyerNick = toStr(buyerNick)
      rec.lastSeen = nowStr()
      if (itemTitle) {
        const list = Array.isArray(rec.interestedItems) ? rec.interestedItems : (rec.interestedItems = [])
        if (!list.includes(itemTitle)) list.push(itemTitle)
      }
      const turns = Array.isArray(rec.turns) ? rec.turns : (rec.turns = [])
      turns.push({
        t: nowStr(),
        chatId: toStr(chatId),
        itemId: toStr(itemId),
        buyer: toStr(buyerMsg),
        reply: toStr(reply),
      })
      if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS)
      await save(accountId, bid, rec)
      return rec
    })
  }

  /**
   * 回填/更新分析字段（agent 在对话中发现关键事实，或聚合复盘时调用）。
   *
   * @param {string} accountId
   * @param {string} buyerId
   * @param {object} fields {buyerNick?,region?,gender?,psychology?,notes?,avatarUrl?,deal?,tags?[]}
   * @returns {Promise<object|null>}
   */
  async function update(accountId, buyerId, fields = {}) {
    const bid = toStr(buyerId).trim()
    if (!bid) return null
    return withLock(lockKey(accountId, bid), async () => {
      const existing = await load(accountId, bid)
      const rec = isObj(existing) && existing.buyerId ? existing : emptyProfile(bid, accountId)
      mergeProfile(rec, fields)
      await save(accountId, bid, rec)
      return rec
    })
  }

  /** 取档案（不存在返回 null）。 */
  async function get(accountId, buyerId) {
    const bid = toStr(buyerId).trim()
    if (!bid) return null
    const rec = await load(accountId, bid)
    return isObj(rec) && Object.keys(rec).length > 0 ? rec : null
  }

  /**
   * 列出客户档案摘要（按文件修改时间倒序；customer_store.py:167-189）。
   *
   * @returns {Promise<Array<{buyerId,buyerNick,avatarUrl,tags,deal,turnCount,lastSeen}>>}
   */
  async function list(accountId, opts = {}) {
    const limit = Math.max(1, Number((opts && opts.limit) || 100) || 100)
    const d = accountDir(accountId)
    let files
    try {
      files = (await readdir(d)).filter((f) => f.endsWith('.json'))
    } catch (e) {
      if (e && e.code === 'ENOENT') return []
      lg.warn(`[customer] 列目录失败: ${d} → ${(e && e.message) || e}`)
      return []
    }
    const withTime = []
    for (const f of files) {
      const p = join(d, f)
      try {
        const st = await stat(p)
        withTime.push({ p, f, mtime: st.mtimeMs || 0 })
      } catch {
        /* ignore */
      }
    }
    withTime.sort((a, b) => b.mtime - a.mtime)
    const out = []
    for (const { p, f } of withTime.slice(0, limit)) {
      try {
        const rec = JSON.parse(await readFile(p, 'utf8'))
        if (!isObj(rec)) continue
        out.push({
          buyerId: toStr(rec.buyerId) || f.replace(/\.json$/, ''),
          buyerNick: toStr(rec.buyerNick),
          avatarUrl: toStr(rec.avatarUrl),
          tags: Array.isArray(rec.tags) ? rec.tags : [],
          deal: Boolean(rec.deal),
          turnCount: Array.isArray(rec.turns) ? rec.turns.length : 0,
          lastSeen: toStr(rec.lastSeen),
        })
      } catch {
        /* 单份损坏不影响其它档案 */
      }
    }
    return out
  }

  /**
   * 客服台/工具读昵称+头像（enrichBuyer 用）。
   * @returns {Promise<{name:string, avatar:string}>}
   */
  async function lookup(accountId, buyerId) {
    const rec = await get(accountId, buyerId)
    if (!rec) return { name: '', avatar: '' }
    return { name: toStr(rec.buyerNick), avatar: toStr(rec.avatarUrl) }
  }

  /**
   * 把扩展捕获的用户资料写入档案（customer_store.py:200-238）。
   *
   * @param {string} accountId
   * @param {Array<{uid?:string, buyerId?:string, nickname?:string, avatarUrl?:string,
   *                avatar_url?:string, buyerNick?:string}>} users
   * @param {{source?:string}} [opts]
   * @returns {Promise<number>} 成功写入条数
   */
  async function upsertProfiles(accountId, users = [], opts = {}) {
    const source = toStr((opts && opts.source) || 'user_query') || 'user_query'
    let n = 0
    for (const raw of Array.isArray(users) ? users : []) {
      if (!isObj(raw)) continue
      const bid = toStr(raw.uid ?? raw.buyerId).trim()
      const nick = toStr(raw.nickname ?? raw.buyerNick).trim()
      const avatar = toStr(raw.avatarUrl ?? raw.avatar_url).trim()
      if (!bid || (!nick && !avatar)) continue
      await withLock(lockKey(accountId, bid), async () => {
        const existing = await load(accountId, bid)
        const rec = isObj(existing) && existing.buyerId ? existing : emptyProfile(bid, accountId)
        const fields = {}
        if (nick) fields.buyerNick = nick
        if (avatar) fields.avatarUrl = avatar
        mergeProfile(rec, fields)
        rec.profileSource = source // 审计痕迹：昵称从哪来的
        await save(accountId, bid, rec)
      })
      n += 1
    }
    return n
  }

  return {
    dataRoot,
    dir,
    pathFor,
    recordTurn,
    update,
    get,
    list,
    lookup,
    upsertProfiles,
    MAX_TURNS,
    PROFILE_FIELDS,
  }
}

export default createCustomerStore
