/**
 * dsh-cs — 闲鱼【采集库】（选品/竞品研究，持久化）
 * ============================================================================
 *
 * 语义对齐 Hermes：`plugins/platforms/xianyu/collect_store.py`（逐函数迁移，camelCase 字段）
 *
 * **与产品库完全隔离**（铁律）：
 *   产品库 = 自己店铺在售品（发品/客服要用）；
 *   采集库 = **别人的**商品（选品参考、竞品对标、仿照上架的素材来源）。
 *   独立目录 / 独立 schema / 独立工具，绝不互相污染。
 *
 * 落盘：`<dataDir>/collected/<accountId>.json`（默认 dataDir=$DSH_HOME/dsh-cs）
 * 结构：`{ "<itemId>": CollectRecord }`
 *
 * 记录字段：itemId / title / price / priceNum / area / sellerName / itemUrl /
 *          mainImage / wantCount / publishTime / source / firstSeenAt /
 *          lastSeenAt / picked
 * 时间戳用 **epoch 秒**（与 Hermes 一致：便于 recent 排序/比较）。
 *
 * 并发/持久化边界（与 product_store 一致）：
 *   单进程内按账号文件串行化；原子写（tmp + rename）；损坏 JSON 备份后当空库；不做跨进程锁。
 *
 * 三套存储刻意互不 import：各自独立、可单独搬迁复用。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// ── 内部小工具（与另外两套存储刻意各留一份，保持模块独立） ─────────────────

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

function nowSec() {
  return Math.floor(Date.now() / 1000)
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
    lg.warn(`[${label}] 读取失败（按空库处理）: ${path} → ${(e && e.message) || e}`)
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

/** 列表返回：真数组 + total/shown/items 非枚举属性（同 product_store 的双向兼容）。 */
function listResult(rows, total) {
  const arr = Array.isArray(rows) ? rows : []
  Object.defineProperties(arr, {
    total: { value: total === undefined ? arr.length : total, enumerable: false },
    shown: { value: arr.length, enumerable: false },
    items: { get() { return arr }, enumerable: false },
  })
  return arr
}

/** 排序值别名（工具层文档写 want|price|time；Hermes 写 price_asc/price_desc/recent）。 */
function normalizeSort(sortBy) {
  const s = String(sortBy || 'want').toLowerCase()
  if (['price', 'price_asc', 'priceasc'].includes(s)) return 'priceAsc'
  if (['price_desc', 'pricedesc'].includes(s)) return 'priceDesc'
  if (['time', 'newest', 'recent'].includes(s)) return 'recent'
  if (['want', 'want_desc', 'hot'].includes(s)) return 'want'
  return 'want'
}

function pickFirst(obj, keys, dflt) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return dflt
}

/**
 * 价格 → 数字（collect_store.py:73-88）：`"¥1810"` / `"1810"` / `"1.2万"` / `"1,299"`。
 * 解析失败返回 null（用于价格过滤/排序）。
 */
export function priceNum(price) {
  if (price === null || price === undefined) return null
  if (typeof price === 'number') return Number.isFinite(price) ? price : null
  let s = String(price).trim().replace(/^[¥￥\s]+/, '').replace(/,/g, '')
  if (!s) return null
  try {
    if (s.includes('万')) {
      const n = Number.parseFloat(s.replace(/万/g, '').trim())
      return Number.isFinite(n) ? n * 10000 : null
    }
    const m = s.match(/\d+(?:\.\d+)?/)
    return m ? Number.parseFloat(m[0]) : null
  } catch {
    return null
  }
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

/**
 * 创建采集库。
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir] 数据根目录（默认 `$DSH_HOME/dsh-cs`）
 * @param {object} [opts.log]     日志器
 */
export function createCollectStore({ dataDir, log } = {}) {
  const dataRoot = resolveDataRoot(dataDir)
  const dir = join(dataRoot, 'collected')
  const withLock = createKeyedQueue()
  const lg = normalizeLog(log)

  /** 某账号采集库文件路径。 */
  function pathFor(accountId) {
    return join(dir, `${safeName(accountId)}.json`)
  }

  const lockKey = (accountId) => safeName(accountId)
  const load = (accountId) => readJsonSafe(pathFor(accountId), lg, 'collect')
  const save = (accountId, data) => atomicWriteJson(pathFor(accountId), data)

  /**
   * 批量写入采集结果（按 itemId 去重 upsert）。
   *
   * 与 Hermes 的差异仅在于返回值多了 `scanned/kept`（Lead 要求）：
   *   scanned = 传入条数；kept = itemId 有效并入库的条数；new/updated/total 同 Hermes。
   * 刷新快照时**保留人工字段** picked / firstSeenAt。
   *
   * @param {string} accountId
   * @param {Array<object>} items 来自 search/采集的解析结果
   * @param {string} [source] 来源标记：`search:iphone` / `home` / `seller:123`
   * @returns {Promise<{scanned:number, kept:number, new:number, updated:number, total:number}>}
   */
  async function upsert(accountId, items = [], source = '') {
    const list = Array.isArray(items) ? items : []
    return withLock(lockKey(accountId), async () => {
      const data = await load(accountId)
      let added = 0
      let updated = 0
      let kept = 0
      for (const it of list) {
        if (!isObj(it)) continue
        const itemId = toStr(pickFirst(it, ['itemId', 'item_id'], '')).trim()
        if (!itemId) continue
        kept += 1
        const price = toStr(it.price)
        const snapshot = {
          itemId,
          title: toStr(it.title),
          price,
          priceNum: priceNum(it.price),
          area: toStr(it.area),
          sellerName: toStr(pickFirst(it, ['sellerName', 'seller_name'], '')),
          itemUrl: toStr(pickFirst(it, ['itemUrl', 'item_url'], '')),
          mainImage: toStr(pickFirst(it, ['mainImage', 'main_image'], '')),
          wantCount: Number.isFinite(Number(it.wantCount ?? it.want_count))
            ? Math.trunc(Number(it.wantCount ?? it.want_count))
            : 0,
          publishTime: toStr(pickFirst(it, ['publishTime', 'publish_time'], '')),
          source: toStr(source) || toStr(it.source),
        }
        const rec = data[itemId]
        if (!isObj(rec)) {
          data[itemId] = {
            ...snapshot,
            firstSeenAt: nowSec(),
            lastSeenAt: nowSec(),
            picked: false,
          }
          added += 1
        } else {
          // 刷新快照，但保留人工字段（picked / firstSeenAt）
          const picked = Boolean(rec.picked)
          const first = rec.firstSeenAt ?? nowSec()
          Object.assign(rec, snapshot)
          rec.picked = picked
          rec.firstSeenAt = first
          rec.lastSeenAt = nowSec()
          updated += 1
        }
      }
      await save(accountId, data)
      return { scanned: list.length, kept, new: added, updated, total: Object.keys(data).length }
    })
  }

  /**
   * 列出/筛选采集库。返回 {total, shown, items}。
   *
   * @param {string} accountId
   * @param {{keyword?:string, minWant?:number, priceMin?:number, priceMax?:number,
   *          pickedOnly?:boolean, sortBy?:'want'|'priceAsc'|'priceDesc'|'recent',
   *          limit?:number}} [filters]
   */
  async function list(accountId, filters = {}) {
    const f = filters || {}
    const data = await load(accountId)
    let rows = Object.values(data).filter(isObj)

    if (f.keyword) {
      const kw = String(f.keyword).toLowerCase()
      rows = rows.filter((r) => toStr(r.title).toLowerCase().includes(kw))
    }
    const minWant = Number(f.minWant) || 0
    if (minWant) rows = rows.filter((r) => Number(r.wantCount) >= minWant)
    if (f.priceMin !== undefined && f.priceMin !== null && f.priceMin !== '') {
      const min = Number(f.priceMin)
      if (Number.isFinite(min)) rows = rows.filter((r) => r.priceNum !== null && r.priceNum >= min)
    }
    if (f.priceMax !== undefined && f.priceMax !== null && f.priceMax !== '') {
      const max = Number(f.priceMax)
      if (Number.isFinite(max)) rows = rows.filter((r) => r.priceNum !== null && r.priceNum <= max)
    }
    if (f.pickedOnly) rows = rows.filter((r) => r.picked)

    const total = rows.length
    const sortBy = normalizeSort(f.sortBy)
    if (sortBy === 'priceAsc') {
      // null 价格排最后（collect_store.py:172-173）
      rows.sort((a, b) => (a.priceNum === null ? 1 : 0) - (b.priceNum === null ? 1 : 0) || (a.priceNum || 0) - (b.priceNum || 0))
    } else if (sortBy === 'priceDesc') {
      rows.sort((a, b) => (b.priceNum || 0) - (a.priceNum || 0))
    } else if (sortBy === 'recent') {
      rows.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    } else {
      rows.sort((a, b) => (Number(b.wantCount) || 0) - (Number(a.wantCount) || 0))
    }

    const limit = Math.max(1, Number(f.limit) || 50)
    return listResult(rows.slice(0, limit), total)
  }

  /** 取单条（供「选品→发布草稿」桥使用）。 */
  async function get(accountId, itemId) {
    const iid = toStr(itemId).trim()
    if (!iid) return null
    const data = await load(accountId)
    const rec = data[iid]
    return isObj(rec) ? rec : null
  }

  /** 标记/取消标记「已选中（准备仿照上架）」。 */
  async function setPicked(accountId, itemId, picked = true) {
    const iid = toStr(itemId).trim()
    if (!iid) return false
    return withLock(lockKey(accountId), async () => {
      const data = await load(accountId)
      const rec = data[iid]
      if (!isObj(rec)) return false
      rec.picked = Boolean(picked)
      await save(accountId, data)
      return true
    })
  }

  /** 从采集库移除。 */
  async function remove(accountId, itemId) {
    const iid = toStr(itemId).trim()
    if (!iid) return false
    return withLock(lockKey(accountId), async () => {
      const data = await load(accountId)
      if (!Object.prototype.hasOwnProperty.call(data, iid)) return false
      delete data[iid]
      await save(accountId, data)
      return true
    })
  }

  return { dataRoot, dir, pathFor, upsert, list, get, setPicked, remove, priceNum }
}

export default createCollectStore
