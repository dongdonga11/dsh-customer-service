/**
 * dsh-cs — 闲鱼【产品库】（自己店铺在售品的资料库，持久化）
 * ============================================================================
 *
 * 语义对齐 Hermes：`plugins/platforms/xianyu/product_store.py`（逐函数迁移，camelCase 字段）
 *
 * 两层结构（铁律）：
 *   骨架层：闲鱼同步来的 title / price / mainPic，**会刷新**；
 *   详情层：人工/AI 补录的 intro / netdisk / images / faq / sellingPoints /
 *           pricing / dealScripts，**同步时绝不覆盖**（含 detailStatus / stats /
 *           autoDeliver / deliveryText）。
 *
 * 落盘：`<dataDir>/products/<accountId>.json`（`dataDir` 默认 `$DSH_HOME/dsh-cs`）
 * 结构：`{ "<itemId>": ProductRecord }`（与 Hermes 顶层 map 一致，便于对拍）
 *
 * 并发/持久化边界（刻意写清）：
 *   - 单进程内按「账号文件」串行化读写（promise 队列），避免 read-modify-write 互相踩；
 *   - 原子写（tmp + rename），断电最多丢最后一次写，不会半写损坏；
 *   - 损坏 JSON：备份成 `<file>.corrupt-<ts>` 后当空库，绝不抛崩；
 *   - **不做跨进程锁**：同一 dataDir 只允许一个 DSH 实例写（与内核 Store 同一边界）。
 *
 * 三套存储（product/customer/collect）刻意互不 import：各自独立、可单独搬迁复用。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// ── 常量（与 Hermes product_store.py:28-36 对齐）───────────────────────────

/** detailStatus 取值 */
export const STATUS_PENDING = '待完善'
export const STATUS_DRAFT = 'AI草稿'
export const STATUS_CONFIRMED = '已确认'

/** 详情层字段（只有这些会被 updateDetail 写入；product_store.py:33-36） */
export const DETAIL_KEYS = ['intro', 'netdisk', 'images', 'faq', 'sellingPoints', 'pricing', 'dealScripts']

/**
 * 输入别名（snake_case → camelCase）。
 * 工具层 schema 用 snake_case（selling_points / deal_scripts），存储用 camelCase；
 * 这里统一收口，避免工具层与存储层字段风格不同导致「写了但没存」。
 */
const DETAIL_ALIASES = {
  selling_points: 'sellingPoints',
  deal_scripts: 'dealScripts',
}

/** 曝光统计字段（product_store.py:216；`want_buy` → `wantBuy`） */
export const STAT_KEYS = ['browse', 'want', 'collect', 'favor', 'wantBuy']

const VALID_STATUS = new Set([STATUS_PENDING, STATUS_DRAFT, STATUS_CONFIRMED])

// ── 内部小工具（三套存储各自内联一份，保持模块独立） ───────────────────────

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

/** 损坏 JSON 容错：ENOENT → 空库；解析失败 → 备份后当空库（不崩）。 */
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
    // 备份原始坏文件，便于人工恢复；备份失败也不影响继续
    try {
      await rename(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    lg.warn(`[${label}] JSON 损坏，已备份并重置: ${path}`)
    return {}
  }
}

/** 原子写：写同目录临时文件 → rename。 */
async function atomicWriteJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** 按 key 串行化异步任务（单进程内 read-modify-write 保护）。 */
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

/** 列表返回值同时兼容两种消费方式：
 *   - 数组语义（工具层）：rows.length / rows.map / JSON 序列化成数组
 *   - 摘要语义（Hermes）：res.total / res.shown / res.items
 * 实现：真数组 + 三个非枚举属性（不会被 JSON.stringify 带出，也就不会循环引用）。
 */
function listResult(rows, total) {
  const arr = Array.isArray(rows) ? rows : []
  Object.defineProperties(arr, {
    total: { value: total === undefined ? arr.length : total, enumerable: false },
    shown: { value: arr.length, enumerable: false },
    items: { get() { return arr }, enumerable: false },
  })
  return arr
}

function emptyDetail() {
  return { intro: '', netdisk: '', images: [], faq: [], sellingPoints: '', pricing: '', dealScripts: '' }
}

function pickFirst(obj, keys, dflt) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return dflt
}

function toStr(v) {
  return v === undefined || v === null ? '' : String(v)
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

/**
 * 创建产品库。
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir] 数据根目录（默认 `$DSH_HOME/dsh-cs`；测试传临时目录）
 * @param {object} [opts.log]     日志器 {info,warn,error,debug}
 */
export function createProductStore({ dataDir, log } = {}) {
  const dataRoot = resolveDataRoot(dataDir)
  const dir = join(dataRoot, 'products')
  const withLock = createKeyedQueue()
  const lg = normalizeLog(log)

  /** 某账号产品库文件路径（不含创建）。 */
  function pathFor(accountId) {
    return join(dir, `${safeName(accountId)}.json`)
  }

  const lockKey = (accountId) => safeName(accountId)
  const load = (accountId) => readJsonSafe(pathFor(accountId), lg, 'product')
  const save = (accountId, data) => atomicWriteJson(pathFor(accountId), data)

  /**
   * 闲鱼同步骨架层：只刷新 title/price/mainPic，**绝不碰详情层**（铁律）。
   *
   * @param {string} accountId
   * @param {Array<{itemId:string,title?:string,price?:any,mainPic?:string}>} items
   * @returns {Promise<{added:number, updated:number, total:number}>}
   */
  async function syncSkeleton(accountId, items = []) {
    const list = Array.isArray(items) ? items : []
    return withLock(lockKey(accountId), async () => {
      const data = await load(accountId)
      let added = 0
      let updated = 0
      for (const it of list) {
        if (!isObj(it)) continue
        const itemId = toStr(pickFirst(it, ['itemId', 'item_id'], '')).trim()
        if (!itemId) continue
        const rec = data[itemId]
        if (!rec || !isObj(rec)) {
          // 新产品：建骨架 + 空详情 + 待完善
          data[itemId] = {
            itemId,
            title: toStr(it.title),
            price: toStr(it.price),
            mainPic: toStr(pickFirst(it, ['mainPic', 'main_pic'], '')),
            detail: emptyDetail(),
            detailStatus: STATUS_PENDING,
            detailSource: '',
            updatedAt: nowStr(),
          }
          added += 1
        } else {
          // 已存在：只刷新骨架；详情/状态/stats/autoDeliver 原样保留
          const title = toStr(it.title)
          if (title) rec.title = title
          if (it.price) rec.price = toStr(it.price)
          const pic = toStr(pickFirst(it, ['mainPic', 'main_pic'], ''))
          if (pic) rec.mainPic = pic
          updated += 1
        }
      }
      await save(accountId, data)
      return { added, updated, total: Object.keys(data).length }
    })
  }

  /** 列表（摘要）：{total, shown, items:[{itemId,title,price,detailStatus}]}。 */
  async function list(accountId, filters = {}) {
    const { status = '', keyword = '', limit = 50 } = filters || {}
    const data = await load(accountId)
    const rows = []
    for (const [itemId, rec] of Object.entries(data)) {
      if (!isObj(rec)) continue
      if (status && rec.detailStatus !== status) continue
      const title = toStr(rec.title)
      if (keyword && !title.includes(String(keyword))) continue
      rows.push({
        itemId,
        title,
        price: toStr(rec.price),
        detailStatus: rec.detailStatus || STATUS_PENDING,
      })
    }
    const max = Math.max(0, Number(limit) || 0) || 50
    return listResult(rows.slice(0, max), rows.length)
  }

  /** 取单条完整记录（骨架 + 详情 + 状态），不存在返回 null。 */
  async function get(accountId, itemId) {
    const iid = toStr(itemId).trim()
    if (!iid) return null
    const data = await load(accountId)
    const rec = data[iid]
    return isObj(rec) ? rec : null
  }

  /** 全部记录（含 stats 若有）；供曝光体检遍历。 */
  async function all(accountId) {
    const data = await load(accountId)
    return Object.values(data).filter((rec) => isObj(rec) && rec.itemId)
  }

  /** 标题（找不到返回 ''）。 */
  async function titleOf(accountId, itemId) {
    const rec = await get(accountId, itemId)
    return rec ? toStr(rec.title) : ''
  }

  /**
   * 写详情层（对话补录 / AI 初稿 / 发品入库都走它）。
   *
   * @param {string} accountId
   * @param {string} itemId
   * @param {object} [patch] 可含 DETAIL_KEYS + title/price（**仅新建占位时**用于骨架）
   * @param {{status?:string, source?:string}} [opts]
   *        status 不传时：source==='ai_draft' → AI草稿，否则 已确认
   * @returns {Promise<object|null>} 更新后的记录
   */
  async function updateDetail(accountId, itemId, patch = {}, opts = {}) {
    const iid = toStr(itemId).trim()
    if (!iid) return null
    const source = toStr((opts && opts.source) || 'manual') || 'manual'
    const wantStatus = toStr(opts && opts.status)
    return withLock(lockKey(accountId), async () => {
      const data = await load(accountId)
      let rec = data[iid]
      if (!rec || !isObj(rec)) {
        // 不在库（如发品新产品）→ 自动建骨架占位
        rec = {
          itemId: iid,
          title: toStr(patch && patch.title),
          price: toStr(patch && patch.price),
          mainPic: '',
          detail: emptyDetail(),
          detailStatus: STATUS_PENDING,
          detailSource: '',
          updatedAt: nowStr(),
        }
      }
      const detail = isObj(rec.detail) ? rec.detail : emptyDetail()
      for (const k of DETAIL_KEYS) {
        const alias = Object.keys(DETAIL_ALIASES).find((a) => DETAIL_ALIASES[a] === k)
        const value = patch && Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : alias && patch ? patch[alias] : undefined
        if (value !== null && value !== undefined) detail[k] = value
      }
      rec.detail = detail
      rec.detailSource = source
      rec.detailStatus = VALID_STATUS.has(wantStatus) ? wantStatus : source === 'ai_draft' ? STATUS_DRAFT : STATUS_CONFIRMED
      rec.updatedAt = nowStr()
      data[iid] = rec
      await save(accountId, data)
      return rec
    })
  }

  /**
   * 写曝光统计（覆盖 stats 子字段 + fetchedAt）。item 不在库返回 false。
   */
  async function setStats(accountId, itemId, stats = {}) {
    const iid = toStr(itemId).trim()
    if (!iid) return false
    return withLock(lockKey(accountId), async () => {
      const data = await load(accountId)
      const rec = data[iid]
      if (!isObj(rec)) return false
      const out = {}
      for (const k of STAT_KEYS) {
        const n = Number(stats && stats[k])
        out[k] = Number.isFinite(n) ? Math.trunc(n) : 0
      }
      out.fetchedAt = nowStr()
      rec.stats = out
      data[iid] = rec
      await save(accountId, data)
      return true
    })
  }

  /**
   * 开/关某商品的自动交付，可选设置自定义交付文案。
   *
   * @param {string} accountId
   * @param {string} itemId
   * @param {{enabled?:boolean, deliveryText?:string, clearDeliveryText?:boolean}|boolean} [opts]
   *        （也兼容第三个参数直接传 boolean，方便从 Hermes 工具迁移）
   * @returns {Promise<object|null>} 成功返回更新后的记录；item 不在库返回 null
   *
   * deliveryText 语义：空串/纯空白视为「未提供」（保留已有自定义文案）——
   * 因为工具层调用约定是「没填就传 空串」；要清空请显式传 clearDeliveryText=true
   * 或 deliveryText=null。
   */
  async function setAutoDeliver(accountId, itemId, opts = {}) {
    const iid = toStr(itemId).trim()
    if (!iid) return false
    const options = typeof opts === 'boolean' ? { enabled: opts } : opts || {}
    return withLock(lockKey(accountId), async () => {
      const data = await load(accountId)
      const rec = data[iid]
      if (!isObj(rec)) return null
      rec.autoDeliver = options.enabled === undefined ? true : Boolean(options.enabled)
      const clear = options.clearDeliveryText === true || options.deliveryText === null
      const text = options.deliveryText === undefined ? "": toStr(options.deliveryText)
      if (clear) {
        rec.deliveryText = ""
      } else if (text.trim() !== "") {
        rec.deliveryText = text
      }
      rec.updatedAt = nowStr()
      data[iid] = rec
      await save(accountId, data)
      return rec
    })
  }

  /**
   * 据产品记录拼交付文案（product_store.py:283-299）。
   * 优先 deliveryText；否则用 detail.netdisk + 标题包一层。空串=没有可发内容。
   */
  function buildDeliveryContentFromRecord(rec) {
    if (!isObj(rec)) return ''
    const custom = toStr(rec.deliveryText).trim()
    if (custom) return custom
    const detail = isObj(rec.detail) ? rec.detail : {}
    const netdisk = toStr(detail.netdisk).trim()
    if (!netdisk) return ''
    const title = toStr(rec.title).trim()
    const head = title ? `亲,这是您拍的【${title}】的资料~` : '亲,这是您拍的资料~'
    return `${head}\n${netdisk}\n收到后有任何问题随时找我,满意的话麻烦给个好评哦~`
  }

  /**
   * 拼某商品的交付内容。支持两种调用：
   *   buildDeliveryContent(accountId, itemId)
   *   buildDeliveryContent(rec)            ← 兼容 Hermes 的「传记录」写法
   */
  async function buildDeliveryContent(accountIdOrRec, itemId) {
    if (isObj(accountIdOrRec)) return buildDeliveryContentFromRecord(accountIdOrRec)
    const rec = await get(accountIdOrRec, itemId)
    return buildDeliveryContentFromRecord(rec)
  }

  /** 取自动交付配置 + 可发内容；item 不在库返回 null。 */
  async function getAutoDelivery(accountId, itemId) {
    const rec = await get(accountId, itemId)
    if (!rec) return null
    return { enabled: Boolean(rec.autoDeliver), content: buildDeliveryContentFromRecord(rec) }
  }

  /** 从产品库移除（如已在闲鱼下架后清理）。 */
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

  return {
    dataRoot,
    dir,
    pathFor,
    syncSkeleton,
    list,
    get,
    all,
    titleOf,
    updateDetail,
    setStats,
    setAutoDeliver,
    buildDeliveryContent,
    buildDeliveryContentFromRecord,
    getAutoDelivery,
    remove,
    // 常量透出，工具层直接引用，避免再造一份字符串
    STATUS_PENDING,
    STATUS_DRAFT,
    STATUS_CONFIRMED,
    DETAIL_KEYS,
    STAT_KEYS,
  }
}

export default createProductStore
