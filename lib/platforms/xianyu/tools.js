/**
 * 闲鱼工具集（M2 批次 1：收发 + 订单/交易 + 商品读写 + 找品/发品/读页面）。
 *
 * 对齐 Hermes `plugins/platforms/xianyu/tools.py` 的行为与 mtop 接口名；
 * 差异：DSH 工具返回统一 JSON 字符串，通过 `ctx.tools.register` 暴露给 Agent。
 *
 * 约定：
 *   - 所有不可逆动作（发货/评价/关单/下架/发品）在 description 里明确要求先与运营者确认；
 *   - 每个 execute 自己 try/catch，失败返回 `{success:false,error}`，绝不抛异常打断 turn；
 *   - account_id 省略时自动选该平台已连接账号。
 */

import { toolError, toolOk } from '../../kernel/toolkit.js'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

const PLATFORM = 'xianyu'
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
const MAX_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * 本地图片 → data URL（扩展 fetch 不到本机文件，必须先转）。
 * http(s)/data URL 原样返回。
 */
async function normalizeImageList(images) {
  const out = []
  for (const raw of images) {
    const s = String(raw || '').trim()
    if (!s) continue
    if (/^(https?:|data:)/i.test(s)) { out.push(s); continue }
    try {
      const buf = await readFile(s)
      if (buf.length > MAX_LOCAL_IMAGE_BYTES) return { error: `本地图片过大(>8MB): ${s}` }
      const mime = IMAGE_MIME[extname(s).toLowerCase()] || 'image/png'
      out.push(`data:${mime};base64,${buf.toString('base64')}`)
    } catch {
      return { error: `读不到本地图片（路径不存在或无权限）: ${s}` }
    }
  }
  if (!out.length) return { error: 'images 全部无效' }
  return { images: out }
}

// 与 Hermes 对齐的接口常量（改版时只改这里）
const API = {
  orderDetail: ['mtop.idle.web.trade.order.detail', '1.0'],
  consign: ['mtop.taobao.idle.logistic.consign.dummy', '1.0'],
  freeshipping: ['mtop.idle.groupon.activity.seller.freeshipping', '1.0'],
  rate: ['mtop.taobao.idle.rate.create', '4.0'],
  closeOrder: ['mtop.taobao.idle.trade.merchant.close.by.seller', '2.0'],
  buyerCredit: ['mtop.idle.web.trade.rate.list', '1.0'],
  listOrders: ['mtop.taobao.idle.trade.merchant.sold.get', '1.0'],
  itemDetail: ['mtop.taobao.idle.pc.detail', '1.0'],
  polish: ['mtop.taobao.idle.item.polish', '2.0'],
  deleteItem: ['mtop.alibaba.idle.seller.pc.item.delete', '1.0'],
  search: ['mtop.taobao.idlemtopsearch.pc.search', '1.0'],
}
const SEARCH_APP_KEY = '12574478' // 搜索用（交易接口默认 34839810，由扩展兜底）
const POLISH_SOFT_OK = ['宝贝已经擦亮过了', 'IDLEITEM_POLISH_AGAIN', '一天只能擦亮一次', 'POLISH_DUPLICATE']

const S = (description) => ({ type: 'string', description })
const N = (description) => ({ type: 'number', description })
const B = (description) => ({ type: 'boolean', description })

/** 工具统一 output：模型看到的文本由 render 生成 */
function outDef() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value == null ? '' : value) }],
  }
}

export function buildXianyuTools({ adapter, runtime, store, log = null }) {
  if (!adapter) return []
  const lg = log || { warn() {}, info() {}, error() {}, debug() {} }

  function accounts() {
    try {
      return (store.getAccounts() || []).filter((a) => (a.platform || PLATFORM) === PLATFORM)
    } catch { return [] }
  }
  function pickAccount(explicit) {
    const id = String(explicit || '').trim()
    if (id) return id
    const list = accounts()
    return String((list.find((a) => a.connected !== false) || list[0] || {}).id || '')
  }
  function ioOf(accountId) {
    try { return runtime.ioFor(PLATFORM, accountId) || {} } catch { return {} }
  }
  function finish(value) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }

  async function mtop(args, [api, version], data, { accountId, timeout = 25000, injectUnbAs = '', appKey = '' } = {}) {
    const io = ioOf(accountId)
    if (typeof adapter.callApi !== 'function') return { ok: false, error: '适配器不支持 mtop' }
    return adapter.callApi({ api, version, data, accountId, timeout, injectUnbAs, appKey }, io)
  }

  // ── 1. 状态 ──────────────────────────────────────────────────────────────
  const status = {
    name: 'xianyu_status',
    description: '查询闲鱼连接状态（桥是否在跑、扩展是否已配对、当前账号/未读）。被问「连上了吗」时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: outDef(),
    async execute() {
      try {
        const st = runtime.state()
        const list = (st.accounts || []).filter((a) => a.platform === PLATFORM)
        const threads = (st.threads || []).filter((t) => t.platform === PLATFORM)
        return finish(toolOk({
          platform: PLATFORM,
          connected: list.some((a) => a.connected !== false),
          accounts: list.map((a) => ({ id: a.id, nickname: a.nickname || '', connected: a.connected !== false })),
          threads: threads.length,
          unread: threads.reduce((n, t) => n + Number(t.unread || 0), 0),
        }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 2. 发消息 ────────────────────────────────────────────────────────────
  const sendMessage = {
    name: 'xianyu_send_message',
    description: '给闲鱼买家发文本（或图片）。必须带 chat_id + buyer_id 才能精确定向；缺 buyer_id 会退化为「当前打开会话」发送，可能发错人。',
    parameters: {
      type: 'object',
      properties: {
        text: S('要发送的文本（与 image_url 至少给一个）'),
        image_url: S('要发送的图片：http(s) URL 或本地图片路径'),
        chat_id: S('会话 id（入站消息上下文里的 chat_id）'),
        buyer_id: S('买家 id（入站消息里的 buyer_id；定向发送必需）'),
        account_id: S('可选：多账号时指定闲鱼账号 id'),
      },
      required: [],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const accountId = pickAccount(args.account_id)
        const chatId = String(args.chat_id || '').trim()
        const buyerId = String(args.buyer_id || '').trim()
        const text = String(args.text || '')
        const imageUrl = String(args.image_url || '').trim()
        if (!text && !imageUrl) return finish(toolError('缺少 text 或 image_url'))
        if (!chatId) return finish(toolError('缺少 chat_id（从买家消息上下文取）'))
        const thread = { platform: PLATFORM, accountId, conversationId: chatId, buyerUid: buyerId, buyerName: '' }
        const io = ioOf(accountId)
        const res = imageUrl
          ? await adapter.sendImage(thread, imageUrl, io)
          : await adapter.send(thread, text, io)
        if (!res || res.ok !== true) return finish(toolError((res && res.error) || '发送失败', { chat_id: chatId }))
        const serverId = res.server_message_id || res.serverMessageId || ''
        try { store.recordOutbound(accountId, chatId, text || `[图片] ${imageUrl}`, serverId, 'ai', PLATFORM) } catch { /* ignore */ }
        return finish(toolOk({ chat_id: chatId, buyer_id: buyerId, sent: true, server_message_id: serverId }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 3. 万能 mtop（模型可自行调接口） ─────────────────────────────────────
  const mtopTool = {
    name: 'xianyu_mtop',
    description: '直接调用闲鱼 mtop 接口（进阶/排障用）。常见接口：mtop.idle.web.trade.order.detail(v1.0,tid)、mtop.taobao.idle.trade.merchant.sold.get(v1.0)。返回原始 ret/data。',
    parameters: {
      type: 'object',
      properties: {
        api: S('mtop 接口名，如 mtop.idle.web.trade.order.detail'),
        version: S('接口版本，默认 1.0'),
        data: { type: 'object', description: '请求 data 体（JSON 对象）' },
        inject_unb_as: S('可选：让扩展把卖家 unb 注入 data 的某个键（如 userId）'),
        app_key: S('可选：覆盖 appKey（默认扩展内置）'),
        timeout_ms: N('超时毫秒（默认 25000）'),
        account_id: S('可选：多账号时指定账号'),
      },
      required: ['api'],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const accountId = pickAccount(args.account_id)
        const r = await adapter.callApi({
          api: String(args.api || ''),
          version: String(args.version || '1.0'),
          data: args.data && typeof args.data === 'object' ? args.data : {},
          accountId,
          timeout: Number(args.timeout_ms) || 25000,
          injectUnbAs: String(args.inject_unb_as || ''),
          appKey: String(args.app_key || ''),
        }, ioOf(accountId))
        return finish(r && typeof r === 'object' ? r : { ok: false, error: '扩展无响应' })
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 4. 订单详情 ──────────────────────────────────────────────────────────
  const getOrder = {
    name: 'xianyu_get_order',
    description: '查闲鱼订单详情（规格/数量/金额/收货信息）。需要 order_id（可先用 xianyu_list_orders 找到）。',
    parameters: { type: 'object', properties: { order_id: S('订单号 tid'), account_id: S('可选账号') }, required: ['order_id'] },
    output: outDef(),
    async execute(args = {}) {
      try {
        const orderId = String(args.order_id || '').trim()
        if (!orderId) return finish(toolError('缺少 order_id'))
        const accountId = pickAccount(args.account_id)
        const r = await mtop(args, API.orderDetail, { tid: orderId }, { accountId })
        if (!r || r.ok !== true) return finish(toolError(`获取订单详情失败: ${(r && (r.ret || r.error)) || '无响应'}`, { api: API.orderDetail[0] }))
        return finish(toolOk({ order_id: orderId, raw: r.data }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 5. 订单列表 ──────────────────────────────────────────────────────────
  const listOrders = {
    name: 'xianyu_list_orders',
    description: '列出卖家订单（默认待发货），用于找 order_id。query_code：NOT_SHIP（待发货）/ ALL（全部）。',
    parameters: {
      type: 'object',
      properties: {
        query_code: S('NOT_SHIP（默认）或 ALL'),
        page: N('页码，默认 1'),
        buyer_id: S('可选：只看某买家'),
        account_id: S('可选账号'),
      },
      required: [],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const accountId = pickAccount(args.account_id)
        const buyerFilter = String(args.buyer_id || '').trim()
        const data = {
          pageNumber: Number(args.page) || 1,
          rowsPerPage: 20,
          orderIds: '',
          queryCode: String(args.query_code || 'NOT_SHIP'),
          orderSearchParam: '{}',
        }
        const r = await mtop(args, API.listOrders, data, { accountId, timeout: 25000 })
        if (!r || r.ok !== true) return finish(toolError(`查询订单列表失败: ${(r && (r.ret || r.error)) || '无响应'}`))
        const items = (r.data && r.data.module && r.data.module.items) || []
        const orders = []
        for (const it of items) {
          const common = (it && it.commonData) || {}
          const buyer = (it && it.buyerInfoVO) || {}
          const price = (it && it.priceVO) || {}
          const orderId = String(common.orderId || '')
          if (!orderId) continue
          const bid = String(buyer.buyerId || '')
          if (buyerFilter && bid !== buyerFilter) continue
          orders.push({
            order_id: orderId,
            item_id: String(common.itemId || ''),
            title: String(common.itemTitle || ''),
            buyer_id: bid,
            buyer_nick: String(buyer.buyerNick || ''),
            price: String(price.price || price.totalPrice || ''),
            status: String(common.orderStatus || ''),
          })
        }
        return finish(toolOk({ query_code: data.queryCode, page: data.pageNumber, orders }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 6. 确认发货（虚拟商品免物流） ────────────────────────────────────────
  const confirmShip = {
    name: 'xianyu_confirm_ship',
    description: '卖家确认发货（虚拟商品免物流）。⚠️ 不可逆交易动作，调用前先与运营者确认。普通发货失败时会提示改用 xianyu_freeshipping。',
    parameters: {
      type: 'object',
      properties: { order_id: S('订单号'), account_id: S('可选账号') },
      required: ['order_id'],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const orderId = String(args.order_id || '').trim()
        if (!orderId) return finish(toolError('缺少 order_id'))
        const accountId = pickAccount(args.account_id)
        const data = { orderId, tradeText: '', picList: [], newUnconsign: true }
        const r = await mtop(args, API.consign, data, { accountId })
        const ret = String((r && r.ret) || '')
        const already = ret.includes('ORDER_ALREADY_DELIVERY') || ret.includes('已发货')
        if ((r && r.ok) || already) return finish(toolOk({ order_id: orderId, already_delivered: already, method: 'consign', ret }))
        return finish(toolError(`确认发货失败: ${ret || (r && r.error) || '无响应'}`, { hint: '小刀/拼团订单请改用 xianyu_freeshipping（需 item_id + buyer_id）' }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 7. 免拼发货 ──────────────────────────────────────────────────────────
  const freeshipping = {
    name: 'xianyu_freeshipping',
    description: '免拼发货（小刀/拼团订单）。⚠️ 不可逆交易动作，先确认。需要 order_id + item_id + buyer_id。',
    parameters: {
      type: 'object',
      properties: { order_id: S('订单号'), item_id: S('商品 id'), buyer_id: S('买家 id'), account_id: S('可选账号') },
      required: ['order_id', 'item_id', 'buyer_id'],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const orderId = String(args.order_id || '').trim()
        const itemId = String(args.item_id || '').trim()
        const buyerId = String(args.buyer_id || '').trim()
        if (!orderId || !itemId || !buyerId) return finish(toolError('缺少 order_id/item_id/buyer_id'))
        const accountId = pickAccount(args.account_id)
        const data = { orderId, itemId, buyerId }
        const r = await mtop(args, API.freeshipping, data, { accountId })
        if (!r || r.ok !== true) return finish(toolError(`免拼发货失败: ${(r && (r.ret || r.error)) || '无响应'}`))
        return finish(toolOk({ order_id: orderId, method: 'freeshipping', ret: r.ret }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 8. 评价买家 ──────────────────────────────────────────────────────────
  const rate = {
    name: 'xianyu_rate',
    description: '给买家好评。⚠️ 不可逆，先确认。需要 trade_id（订单号）。',
    parameters: {
      type: 'object',
      properties: {
        trade_id: S('订单号（兼容 order_id）'),
        order_id: S('兼容字段：订单号'),
        feedback: S('评价内容，默认「不错的买家」'),
        account_id: S('可选账号'),
      },
      required: [],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const tradeId = String(args.trade_id || args.order_id || '').trim()
        const feedback = String(args.feedback || '不错的买家')
        if (!tradeId) return finish(toolError('缺少 trade_id（订单号）'))
        const accountId = pickAccount(args.account_id)
        const r = await mtop(args, API.rate, { tradeId, rate: 1, feedback, createOrAppend: 0 }, { accountId })
        if (!r || r.ok !== true) return finish(toolError(`评价失败: ${(r && (r.ret || r.error)) || '无响应'}`))
        return finish(toolOk({ trade_id: tradeId, feedback }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 9. 关闭订单 ──────────────────────────────────────────────────────────
  const closeOrder = {
    name: 'xianyu_close_order',
    description: '卖家关闭订单。⚠️ 不可逆，先确认。',
    parameters: {
      type: 'object',
      properties: { order_id: S('订单号'), reason: S('关闭原因，默认「其他原因」'), account_id: S('可选账号') },
      required: ['order_id'],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const orderId = String(args.order_id || '').trim()
        if (!orderId) return finish(toolError('缺少 order_id'))
        const accountId = pickAccount(args.account_id)
        const data = { tid: orderId, bizOrderId: orderId, closeReason: String(args.reason || '其他原因') }
        const r = await mtop(args, API.closeOrder, data, { accountId })
        if (!r || r.ok !== true) return finish(toolError(`关闭订单失败: ${(r && (r.ret || r.error)) || '无响应'}`))
        return finish(toolOk({ order_id: orderId }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 10. 买家信用 ─────────────────────────────────────────────────────────
  const buyerCredit = {
    name: 'xianyu_buyer_credit',
    description: '查买家评价数（信用参考）。',
    parameters: { type: 'object', properties: { buyer_id: S('买家 id'), account_id: S('可选账号') }, required: ['buyer_id'] },
    output: outDef(),
    async execute(args = {}) {
      try {
        const buyerId = String(args.buyer_id || '').trim()
        if (!buyerId) return finish(toolError('缺少 buyer_id'))
        const accountId = pickAccount(args.account_id)
        const data = {
          rateType: 0, ratedUid: buyerId, raterType: 0,
          rowsPerPage: 20, pageNumber: 1, foldFlag: 0, fishAdCode: '330110', extraTag: '',
        }
        const r = await mtop(args, API.buyerCredit, data, { accountId })
        if (!r || r.ok !== true) return finish(toolError(`查询买家评价失败: ${(r && (r.ret || r.error)) || '无响应'}`))
        const total = r.data && r.data.totalCount
        return finish(toolOk({ buyer_id: buyerId, rate_count: total }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 11. 商品详情（探针） ─────────────────────────────────────────────────
  const itemDetail = {
    name: 'xianyu_item_detail',
    description: '查闲鱼商品详情（可指定 api/version/app_key 覆盖，用于排障）。需要 item_id。',
    parameters: {
      type: 'object',
      properties: {
        item_id: S('商品 id'),
        api: S('覆盖详情接口名，默认 mtop.taobao.idle.pc.detail'),
        version: S('覆盖版本，默认 1.0'),
        account_id: S('可选账号'),
      },
      required: ['item_id'],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const itemId = String(args.item_id || '').trim()
        if (!itemId) return finish(toolError('缺少 item_id'))
        const accountId = pickAccount(args.account_id)
        const api = String(args.api || API.itemDetail[0])
        const version = String(args.version || API.itemDetail[1])
        const r = await mtop(args, [api, version], { itemId }, { accountId })
        return finish(r && r.ok === true ? toolOk({ item_id: itemId, api, raw: r.data }) : toolError(`查询商品详情失败: ${(r && (r.ret || r.error)) || '无响应'}`, { api }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 12. 擦亮 ─────────────────────────────────────────────────────────────
  const refreshItem = {
    name: 'xianyu_refresh_item',
    description: '擦亮商品（提升曝光，每天一次）。需要 item_id。软成功（已擦过/今日已擦）也视为成功。',
    parameters: { type: 'object', properties: { item_id: S('商品 id'), account_id: S('可选账号') }, required: ['item_id'] },
    output: outDef(),
    async execute(args = {}) {
      try {
        const itemId = String(args.item_id || '').trim()
        if (!itemId) return finish(toolError('缺少 item_id'))
        const accountId = pickAccount(args.account_id)
        const r = await mtop(args, API.polish, { itemId }, { accountId })
        const ret = String((r && r.ret) || '')
        if (r && r.ok) return finish(toolOk({ item_id: itemId, method: 'polish', ret }))
        if (POLISH_SOFT_OK.some((k) => ret.includes(k))) return finish(toolOk({ item_id: itemId, method: 'polish', already: true, ret }))
        if (ret.includes('UNSUPPORTED_ITEM_STATUS')) return finish(toolError('商品已下架，无法擦亮', { item_id: itemId, down: true, ret }))
        return finish(toolError(`擦亮失败: ${ret || (r && r.error) || '无响应'}`, { api: API.polish[0] }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 13. 下架 ─────────────────────────────────────────────────────────────
  const deleteItem = {
    name: 'xianyu_delete_item',
    description: '下架（删除）自己的商品。⚠️ 不可逆，先确认。需要 item_id。',
    parameters: { type: 'object', properties: { item_id: S('商品 id'), account_id: S('可选账号') }, required: ['item_id'] },
    output: outDef(),
    async execute(args = {}) {
      try {
        const itemId = String(args.item_id || '').trim()
        if (!itemId) return finish(toolError('缺少 item_id'))
        const accountId = pickAccount(args.account_id)
        const r = await mtop(args, API.deleteItem, { itemId, draftId: null }, { accountId, timeout: 20000 })
        if (!r || r.ok !== true) return finish(toolError(`下架失败: ${(r && (r.ret || r.error)) || '无响应'}`))
        const d = r.data || {}
        const ok = d.code === 'success' || d.data === true || d.success === true
        return finish(ok ? toolOk({ item_id: itemId }) : toolError(`下架接口返回未确认成功: ${JSON.stringify(d).slice(0, 300)}`))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 14. 全站找品 ─────────────────────────────────────────────────────────
  const searchItems = {
    name: 'xianyu_search',
    description: '全站关键词找品（选品/看同类价）。返回 item_id/标题/价格/想要人数等；分页用 page。',
    parameters: {
      type: 'object',
      properties: {
        keyword: S('搜索关键词'),
        page: N('页码，默认 1'),
        page_size: N('每页数量，默认 20'),
        price_min: N('最低价'),
        price_max: N('最高价'),
        account_id: S('可选账号'),
      },
      required: ['keyword'],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const keyword = String(args.keyword || '').trim()
        if (!keyword) return finish(toolError('缺少 keyword'))
        const accountId = pickAccount(args.account_id)
        const data = {
          pageNumber: Number(args.page) || 1,
          keyword,
          fromFilter: false,
          rowsPerPage: Number(args.page_size) || 20,
          bizFrom: 'pc',
          searchReqFromPage: 'pcSearch',
        }
        if (args.price_min !== undefined) data.priceMin = String(args.price_min)
        if (args.price_max !== undefined) data.priceMax = String(args.price_max)
        const r = await mtop(args, API.search, data, { accountId, timeout: 25000, appKey: SEARCH_APP_KEY })
        if (!r || r.ok !== true) return finish(toolError(`找品失败: ${(r && (r.ret || r.error)) || '无响应'}`, { hint: '若报签名失败，可用 xianyu_mtop 换 app_key 试（如 34839810）' }))
        const list = (r.data && r.data.resultList) || []
        const items = []
        for (const cell of list) {
          try {
            const itemData = (cell.item && cell.item.main) || cell.main || {}
            const ex = itemData.exContent || {}
            const click = itemData.clickParam || {}
            let itemId = ex.itemId || ex.id || ''
            if (!itemId && click.args && click.args.item_id) itemId = click.args.item_id
            if (!itemId) continue
            items.push({
              item_id: String(itemId),
              title: String(ex.title || ''),
              price: String(ex.price || (ex.priceInfo && ex.priceInfo.price) || ''),
              area: String(ex.area || ''),
              want_count: Number(ex.wantCnt || 0),
              item_url: String(ex.itemUrl || ''),
              main_image: String(ex.picUrl || ''),
            })
          } catch { /* 单条解析失败跳过 */ }
        }
        return finish(toolOk({ keyword, page: data.pageNumber, count: items.length, items }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 15. 发品（扩展 DOM 自动化） ──────────────────────────────────────────
  const publishItem = {
    name: 'xianyu_publish_item',
    description: '发布（上架）一个闲鱼商品：扩展在已登录的发布页跑 DOM 自动化（图/标题/描述/价格/包邮/所在地）。⚠️ 不可逆且可能触发平台审核，先确认。本地图片路径会转 base64。',
    parameters: {
      type: 'object',
      properties: {
        title: S('商品标题'),
        description: S('商品描述'),
        price: N('售价（元）'),
        images: { type: 'array', items: { type: 'string' }, description: '图片：http(s) URL / data URL / 本地绝对路径（至少一张）' },
        original_price: N('可选：原价'),
        address: S('可选：宝贝所在地'),
        category: S('可选：分类文案'),
        delivery: S('可选：发货方式'),
        account_id: S('可选账号'),
      },
      required: ['title', 'price', 'images'],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const title = String(args.title || '').trim()
        const description = String(args.description || '').trim()
        const price = args.price
        const images = Array.isArray(args.images) ? args.images.map(String).filter(Boolean) : []
        if (!title && !description) return finish(toolError('缺少 title/description'))
        if (price === undefined || price === null || String(price).trim() === '') return finish(toolError('缺少 price'))
        if (!images.length) return finish(toolError('缺少 images（至少一张图）'))
        const norm = await normalizeImageList(images)
        if (norm.error) return finish(toolError(norm.error))
        const accountId = pickAccount(args.account_id)
        const item = { title, description, price: String(price), images: norm.images, address: String(args.address || '') }
        if (args.original_price !== undefined && args.original_price !== null && String(args.original_price).trim()) item.original_price = String(args.original_price)
        if (args.category) item.category = String(args.category)
        if (args.delivery) item.delivery = String(args.delivery)
        const raw = await adapter.callApiRaw(
          { action: 'publish_item', args: { item }, accountId, timeout: 90000 },
          ioOf(accountId),
        )
        if (!raw || raw.ok !== true) return finish(toolError(`发品失败: ${(raw && raw.error) || '扩展无响应'}`, { hint: '查看发布页是否卡在分类/滑块；可用 xianyu_read_page 勘查现场' }))
        return finish(toolOk({ item: { title, price: String(price) }, result: raw.data }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 16. 页面勘查 ─────────────────────────────────────────────────────────
  const readPage = {
    name: 'xianyu_read_page',
    description: '勘查闲鱼页面：返回当前（或发布）页可交互元素的结构化清单（label/placeholder/值/可见性/定位提示）。发品失败或怀疑改版时先调它看现场。纯只读。',
    parameters: {
      type: 'object',
      properties: {
        target: S('留空=当前活跃闲鱼页；publish=发布页（没开会自动打开）'),
        raw: B('是否额外返回截断的原始 HTML（默认 false）'),
        scope: S('可选：只勘查某个 CSS 选择器区域'),
        account_id: S('可选账号'),
      },
      required: [],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const accountId = pickAccount(args.account_id)
        const callArgs = {}
        if (String(args.target || '') === 'publish') callArgs.target = 'publish'
        if (args.raw === true) callArgs.raw = true
        if (args.scope) callArgs.scope = String(args.scope)
        const timeout = callArgs.target === 'publish' ? 45000 : 20000
        const raw = await adapter.callApiRaw({ action: 'read_page', args: callArgs, accountId, timeout }, ioOf(accountId))
        if (!raw || raw.ok !== true) return finish(toolError(`读页面失败: ${(raw && raw.error) || '扩展无响应'}`))
        const data = raw.data
        if (data && data.error) {
          const hint = { no_goofish_tab: '用户 Chrome 没打开 goofish.com', content_no_response: '页面未应答（刷新闲鱼页）' }[data.error]
          return finish(toolError(hint || String(data.error), { detail: data.detail }))
        }
        return finish(toolOk({ page: callArgs.target || 'current', data }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  return [
    status,
    sendMessage,
    mtopTool,
    getOrder,
    listOrders,
    confirmShip,
    freeshipping,
    rate,
    closeOrder,
    buyerCredit,
    itemDetail,
    refreshItem,
    deleteItem,
    searchItems,
    publishItem,
    readPage,
  ]
}
