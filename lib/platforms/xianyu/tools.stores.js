/**
 * 闲鱼工具集（M4 批次 2）：产品库 / 客户档案 / 采集库 / 退款 / 曝光体检。
 *
 * 对齐 Hermes `tools.py` 的同名 handler；差异：
 *   - 存储换成 DSH 侧 `product_store.js` / `customer_store.js` / `collect_store.js`（camelCase）；
 *   - 所有工具返回 JSON 字符串，失败返回 `{success:false,error}`，绝不抛异常。
 *
 * 依赖：buildXianyuTools 同款 deps + `stores = { product, customer, collect }`
 * （任一 store 缺失时，相关工具返回明确错误，不影响其它工具）。
 */

import { toolError, toolOk } from '../../kernel/toolkit.js'

const PLATFORM = 'xianyu'
const S = (description) => ({ type: 'string', description })
const N = (description) => ({ type: 'number', description })
const B = (description) => ({ type: 'boolean', description })
const SEARCH_APP_KEY = '12574478'

function outDef() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value == null ? '' : value) }],
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function buildXianyuStoreTools({ adapter, runtime, store, stores = {}, log = null }) {
  if (!adapter) return []
  const lg = log || { warn() {}, info() {}, error() {}, debug() {} }
  const product = stores.product || null
  const customer = stores.customer || null
  const collect = stores.collect || null

  function accounts() {
    try { return (store.getAccounts() || []).filter((a) => (a.platform || PLATFORM) === PLATFORM) } catch { return [] }
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
  const finish = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  const needProduct = () => (product ? null : toolError('产品库存储未就绪（product_store 未加载）'))
  const needCustomer = () => (customer ? null : toolError('客户档案存储未就绪（customer_store 未加载）'))
  const needCollect = () => (collect ? null : toolError('采集库存储未就绪（collect_store 未加载）'))

  async function mtop(accountId, api, version, data, { timeout = 25000, injectUnbAs = '', appKey = '' } = {}) {
    return adapter.callApi({ api, version, data, accountId, timeout, injectUnbAs, appKey }, ioOf(accountId))
  }

  // ── 1. 同步本店商品骨架 ──────────────────────────────────────────────────
  const syncItems = {
    name: 'xianyu_sync_items',
    description: '拉取本店在售商品建产品库骨架（标题/价格/主图）。接手/上新后调用；不覆盖已录详情。',
    parameters: {
      type: 'object',
      properties: { max_pages: N('最多翻几页（默认 10）'), page_size: N('每页数量（默认 20）'), account_id: S('可选账号') },
      required: [],
    },
    output: outDef(),
    async execute(args = {}) {
      const miss = needProduct(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const maxPages = Number(args.max_pages) || 10
        const pageSize = Number(args.page_size) || 20
        const items = []
        for (let page = 1; page <= maxPages; page++) {
          const data = {
            needGroupInfo: false,
            pageNumber: page,
            pageSize,
            groupName: '在售',
            defaultGroup: true,
          }
          const r = await mtop(accountId, 'mtop.idle.web.xyh.item.list', '1.0', data, { timeout: 25000, injectUnbAs: 'userId' })
          if (!r || r.ok !== true) {
            if (page === 1) return finish(toolError(`同步商品失败: ${(r && (r.ret || r.error)) || '无响应'}`))
            break
          }
          const cardList = (r.data && r.data.cardList) || []
          if (!cardList.length) break
          for (const card of cardList) {
            const cd = (card && card.cardData) || {}
            const itemId = String(cd.id || '')
            if (!itemId) continue
            const priceInfo = cd.priceInfo || {}
            const picInfo = cd.picInfo || {}
            items.push({
              itemId,
              title: String(cd.title || ''),
              price: String(priceInfo.price || ''),
              mainPic: String(picInfo.picUrl || picInfo.url || ''),
            })
          }
          if (cardList.length < pageSize) break
        }
        const res = await product.syncSkeleton(accountId, items)
        return finish(toolOk({
          account_id: accountId,
          ...res,
          note: '骨架已同步；详情层（介绍/网盘/图片）需补录：见 xianyu_draft_products / xianyu_update_product',
        }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 2. 列出产品库 ────────────────────────────────────────────────────────
  const listItems = {
    name: 'xianyu_list_items',
    description: '列出本店在售商品（标题/价格/详情完善状态）。需先 xianyu_sync_items。',
    parameters: {
      type: 'object',
      properties: { keyword: S('可选：标题关键词'), status: S('可选：待完善/AI草稿/已确认'), limit: N('数量，默认 50'), account_id: S('可选账号') },
      required: [],
    },
    output: outDef(),
    async execute(args = {}) {
      const miss = needProduct(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const rows = await product.list(accountId, { keyword: args.keyword, status: args.status, limit: Number(args.limit) || 50 })
        return finish(toolOk({ account_id: accountId, count: rows.length, items: rows }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 3. 查产品详情 ────────────────────────────────────────────────────────
  const getProduct = {
    name: 'xianyu_get_product',
    description: '查产品库某个商品的详情（介绍/网盘/图片/FAQ/卖点/话术/曝光）。',
    parameters: { type: 'object', properties: { item_id: S('商品 id'), account_id: S('可选账号') }, required: ['item_id'] },
    output: outDef(),
    async execute(args = {}) {
      const miss = needProduct(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const rec = await product.get(accountId, String(args.item_id || ''))
        if (!rec) return finish(toolError('产品库没有这个商品（先 xianyu_sync_items）'))
        return finish(toolOk({ product: rec }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 4. 更新产品详情 ──────────────────────────────────────────────────────
  const updateProduct = {
    name: 'xianyu_update_product',
    description: '更新产品库详情（介绍/网盘/图片/FAQ/卖点/定价/成交话术/状态）。',
    parameters: {
      type: 'object',
      properties: {
        item_id: S('商品 id'),
        intro: S('产品介绍'),
        netdisk: S('网盘/交付内容'),
        images: { type: 'array', items: { type: 'string' }, description: '图片 URL 列表' },
        faq: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'FAQ 列表 [{q,a}]' },
        selling_points: S('卖点'),
        pricing: S('定价说明'),
        deal_scripts: S('成交话术'),
        status: S('待完善/AI草稿/已确认'),
        account_id: S('可选账号'),
      },
      required: ['item_id'],
    },
    output: outDef(),
    async execute(args = {}) {
      const miss = needProduct(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const patch = {}
        for (const k of ['intro', 'netdisk', 'images', 'faq', 'selling_points', 'pricing', 'deal_scripts']) {
          if (args[k] !== undefined) patch[k] = args[k]
        }
        if (!Object.keys(patch).length) return finish(toolError('没有可更新的字段'))
        const rec = await product.updateDetail(accountId, String(args.item_id || ''), patch, { status: args.status, source: 'manual' })
        return finish(toolOk({ product: rec }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 5. 待完善清单（给 AI 起草） ──────────────────────────────────────────
  const draftProducts = {
    name: 'xianyu_draft_products',
    description: '列出「待完善」商品清单，供 AI 生成初稿后用 xianyu_update_product 回写。',
    parameters: { type: 'object', properties: { limit: N('数量，默认 20'), account_id: S('可选账号') }, required: [] },
    output: outDef(),
    async execute(args = {}) {
      const miss = needProduct(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const rows = await product.list(accountId, { status: '待完善', limit: Number(args.limit) || 20 })
        return finish(toolOk({ count: rows.length, items: rows.map((r) => ({ itemId: r.itemId, title: r.title, price: r.price })) }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 6. 自动交付配置 ──────────────────────────────────────────────────────
  const setAutoDeliver = {
    name: 'xianyu_set_auto_deliver',
    description: '设置某商品的自动交付（买家付款后秒发网盘/资料）。开了但没内容会警告。',
    parameters: {
      type: 'object',
      properties: {
        item_id: S('商品 id'),
        enabled: B('是否开启'),
        delivery_text: S('自定义交付文案（留空则用产品详情的网盘字段拼）'),
        account_id: S('可选账号'),
      },
      required: ['item_id', 'enabled'],
    },
    output: outDef(),
    async execute(args = {}) {
      const miss = needProduct(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const itemId = String(args.item_id || '')
        const rec = await product.setAutoDeliver(accountId, itemId, { enabled: args.enabled === true, deliveryText: String(args.delivery_text || '') })
        const content = await product.buildDeliveryContent(accountId, itemId)
        const warn = args.enabled === true && !content ? '已开启但当前没有可用交付内容（补 delivery_text 或详情 netdisk）' : ''
        return finish(toolOk({ product: rec, content_preview: content.slice(0, 200), warning: warn }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 7. 手动补发交付 ──────────────────────────────────────────────────────
  const deliver = {
    name: 'xianyu_deliver',
    description: '手动补发交付内容（网盘/资料）给买家；付款事件已自动发过时一般不需要。',
    parameters: {
      type: 'object',
      properties: { item_id: S('商品 id'), chat_id: S('会话 id'), buyer_id: S('买家 id'), account_id: S('可选账号') },
      required: ['item_id'],
    },
    output: outDef(),
    async execute(args = {}) {
      const miss = needProduct(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const itemId = String(args.item_id || '')
        const content = await product.buildDeliveryContent(accountId, itemId)
        if (!content) return finish(toolError('该商品没有可用交付内容（先 xianyu_set_auto_deliver / 补 netdisk）'))
        const chatId = String(args.chat_id || '').trim()
        const buyerId = String(args.buyer_id || '').trim()
        if (!chatId || !buyerId) return finish(toolError('缺少 chat_id / buyer_id（从买家消息上下文取）'))
        const thread = { platform: PLATFORM, accountId, conversationId: chatId, buyerUid: buyerId, buyerName: '' }
        const res = await adapter.send(thread, content, ioOf(accountId))
        if (!res || res.ok !== true) return finish(toolError((res && res.error) || '发送失败'))
        const serverId = res.server_message_id || res.serverMessageId || ''
        try { store.recordOutbound(accountId, chatId, content, serverId, 'ai', PLATFORM) } catch { /* ignore */ }
        return finish(toolOk({ item_id: itemId, chat_id: chatId, sent: true }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 8~10. 客户档案 ───────────────────────────────────────────────────────
  const getCustomer = {
    name: 'xianyu_get_customer',
    description: '查买家档案（对话流水/标签/地区/性别/心理/成交/备注）。buyer_id 空则从当前会话反查。',
    parameters: { type: 'object', properties: { buyer_id: S('买家 id（可空）'), account_id: S('可选账号') }, required: [] },
    output: outDef(),
    async execute(args = {}) {
      const miss = needCustomer(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const buyerId = String(args.buyer_id || '').trim()
        if (!buyerId) return finish(toolError('缺少 buyer_id（从买家消息上下文取）'))
        const rec = await customer.get(accountId, buyerId)
        if (!rec) return finish(toolOk({ exists: false, buyer_id: buyerId }))
        const turns = Array.isArray(rec.turns) ? rec.turns.slice(-20) : []
        return finish(toolOk({ exists: true, customer: { ...rec, turns } }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }
  const updateCustomer = {
    name: 'xianyu_update_customer',
    description: '更新买家档案（地区/性别/心理/标签/成交/备注/昵称）。',
    parameters: {
      type: 'object',
      properties: {
        buyer_id: S('买家 id'),
        region: S('地区'), gender: S('性别'), psychology: S('心理画像'),
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
        deal: B('是否成交'), notes: S('备注'), buyer_nick: S('昵称'),
        account_id: S('可选账号'),
      },
      required: ['buyer_id'],
    },
    output: outDef(),
    async execute(args = {}) {
      const miss = needCustomer(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const patch = {}
        for (const k of ['region', 'gender', 'psychology', 'tags', 'deal', 'notes', 'buyer_nick']) {
          if (args[k] !== undefined) patch[k] = args[k]
        }
        const rec = await customer.update(accountId, String(args.buyer_id || ''), patch)
        return finish(rec ? toolOk({ customer: rec }) : toolError('更新失败（存储不可用）'))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }
  const listCustomers = {
    name: 'xianyu_list_customers',
    description: '列出客户档案（按期活跃/更新时间倒序）。',
    parameters: { type: 'object', properties: { limit: N('数量，默认 100'), account_id: S('可选账号') }, required: [] },
    output: outDef(),
    async execute(args = {}) {
      const miss = needCustomer(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const rows = await customer.list(accountId, { limit: Number(args.limit) || 100 })
        return finish(toolOk({ count: rows.length, customers: rows }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 11~14. 采集库（选品） ────────────────────────────────────────────────
  const collectItems = {
    name: 'xianyu_collect',
    description: '搜索并批量采集别人的商品进采集库（选品/竞品研究，与自家产品库隔离）。可按价格/想要人数过滤。',
    parameters: {
      type: 'object',
      properties: {
        keyword: S('搜索关键词'),
        pages: N('采集页数，默认 1'),
        page_size: N('每页数量，默认 20'),
        price_min: N('最低价'), price_max: N('最高价'),
        min_want: N('想要人数下限'),
        account_id: S('可选账号'),
      },
      required: ['keyword'],
    },
    output: outDef(),
    async execute(args = {}) {
      const miss = needCollect(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const keyword = String(args.keyword || '').trim()
        if (!keyword) return finish(toolError('缺少 keyword'))
        const pages = Math.max(1, Number(args.pages) || 1)
        const pageSize = Number(args.page_size) || 20
        const collected = []
        for (let page = 1; page <= pages; page++) {
          const data = {
            pageNumber: page, keyword, fromFilter: false, rowsPerPage: pageSize,
            bizFrom: 'pc', searchReqFromPage: 'pcSearch',
          }
          const r = await mtop(accountId, 'mtop.taobao.idlemtopsearch.pc.search', '1.0', data, { timeout: 25000, appKey: SEARCH_APP_KEY })
          if (!r || r.ok !== true) {
            if (page === 1) return finish(toolError(`采集失败: ${(r && (r.ret || r.error)) || '无响应'}`))
            break
          }
          for (const cell of (r.data && r.data.resultList) || []) {
            try {
              const itemData = (cell.item && cell.item.main) || cell.main || {}
              const ex = itemData.exContent || {}
              const click = itemData.clickParam || {}
              let itemId = ex.itemId || ex.id || ''
              if (!itemId && click.args && click.args.item_id) itemId = click.args.item_id
              if (!itemId) continue
              const priceText = String(ex.price || (ex.priceInfo && ex.priceInfo.price) || '')
              // 价格归一复用 store 的口径（¥/千分位/「1.2万」→12000），否则筛选与落库不一致
              const priceNum = typeof collect.priceNum === 'function'
                ? (collect.priceNum(priceText) ?? 0)
                : (Number(String(priceText).replace(/[^\d.]/g, '')) || 0)
              const want = Number(ex.wantCnt || 0)
              if (args.price_min !== undefined && priceNum && priceNum < Number(args.price_min)) continue
              if (args.price_max !== undefined && priceNum && priceNum > Number(args.price_max)) continue
              if (args.min_want !== undefined && want < Number(args.min_want)) continue
              collected.push({
                itemId: String(itemId),
                title: String(ex.title || ''),
                price: priceText,
                priceNum,
                area: String(ex.area || ''),
                sellerName: String(ex.userNickName || ex.sellerNick || ''),
                itemUrl: String(ex.itemUrl || ''),
                mainImage: String(ex.picUrl || ''),
                wantCount: want,
                publishTime: String(ex.publishTime || ''),
                raw: null,
              })
            } catch { /* 单条解析失败跳过 */ }
          }
          if (page < pages) await sleep(1200) // 页间拟人节流
        }
        const res = await collect.upsert(accountId, collected, `search:${keyword}`)
        return finish(toolOk({ keyword, ...res }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }
  const listCollected = {
    name: 'xianyu_list_collected',
    description: '看采集库（默认按想要人数降序），支持价格/关键词/已选中过滤。',
    parameters: {
      type: 'object',
      properties: {
        keyword: S('标题关键词'), min_want: N('想要人数下限'),
        price_min: N('最低价'), price_max: N('最高价'),
        picked_only: B('只看已选中'), sort_by: S('want|price|time'), limit: N('数量，默认 50'),
        account_id: S('可选账号'),
      },
      required: [],
    },
    output: outDef(),
    async execute(args = {}) {
      const miss = needCollect(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const rows = await collect.list(accountId, {
          keyword: args.keyword, minWant: args.min_want,
          priceMin: args.price_min, priceMax: args.price_max,
          pickedOnly: args.picked_only === true, sortBy: args.sort_by, limit: Number(args.limit) || 50,
        })
        return finish(toolOk({ count: rows.length, items: rows }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }
  const pickCollected = {
    name: 'xianyu_pick_collected',
    description: '标记采集库商品为「已选中（准备仿照上架）」。',
    parameters: { type: 'object', properties: { item_id: S('采集库 item_id'), picked: B('true=选中，false=取消'), account_id: S('可选账号') }, required: ['item_id'] },
    output: outDef(),
    async execute(args = {}) {
      const miss = needCollect(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const ok = await collect.setPicked(accountId, String(args.item_id || ''), args.picked !== false)
        return finish(ok ? toolOk({ item_id: args.item_id, picked: args.picked !== false }) : toolError('采集库没有该商品'))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }
  const draftFromCollected = {
    name: 'xianyu_draft_from_collected',
    description: '把采集库商品转成发布草稿（参考标题/价/主图 + 改写指引），不自动发布；给 AI/运营者改写成自己的品后再 xianyu_publish_item。',
    parameters: { type: 'object', properties: { item_id: S('采集库 item_id'), account_id: S('可选账号') }, required: ['item_id'] },
    output: outDef(),
    async execute(args = {}) {
      const miss = needCollect(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const itemId = String(args.item_id || '')
        const rec = await collect.get(accountId, itemId)
        if (!rec) return finish(toolError('采集库没有该商品（先 xianyu_collect）'))
        const priceNum = Number(rec.priceNum) || Number(String(rec.price || '').replace(/[^\d.]/g, '')) || 0
        const draft = {
          title: rec.title || '',
          price: priceNum ? Number((priceNum * 1.15).toFixed(2)) : 0,
          images: rec.mainImage ? [rec.mainImage] : [],
          description: '',
          reference: rec,
          instructions: '做自己的品：改写标题/描述/定价，优先换自己实拍图；不要把别人的原标题原价照搬当二道贩子。',
        }
        await collect.setPicked(accountId, itemId, true)
        return finish(toolOk({ draft, note: '草稿未发布；改写后用 xianyu_publish_item' }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 15. 退款（动态接口） ─────────────────────────────────────────────────
  const AGREE_HINTS = ['同意退款', '同意退货', '确认退款', 'AGREE_REFUND', 'REFUND_AGREE']
  const REFUSE_HINTS = ['拒绝退款', '拒绝', 'REFUSE_REFUND', 'REFUND_REFUSE']
  async function findOrderWithActions(accountId, orderId) {
    for (let page = 1; page <= 3; page++) {
      const data = { pageNumber: page, rowsPerPage: 30, orderIds: '', queryCode: 'ALL', orderSearchParam: '{}' }
      const r = await mtop(accountId, 'mtop.taobao.idle.trade.merchant.sold.get', '1.0', data, { timeout: 25000 })
      if (!r || r.ok !== true) return null
      const items = (r.data && r.data.module && r.data.module.items) || []
      for (const it of items) {
        const common = (it && it.commonData) || {}
        if (String(common.orderId || '') === String(orderId)) {
          const right = (it && it.rightVO) || {}
          return { common, btnList: right.btnList || [] }
        }
      }
      if (String((r.data && r.data.module && r.data.module.nextPage) || 'false') !== 'true') break
    }
    return null
  }
  const refund = {
    name: 'xianyu_refund',
    description: '处理买家退款：同意(agree)或拒绝(refuse)。需要订单号。买家申请退款后用。⚠️ 不可逆钱款操作，先确认。',
    parameters: {
      type: 'object',
      properties: { order_id: S('订单号'), decision: S('agree=同意退款（默认），refuse=拒绝'), account_id: S('可选账号') },
      required: ['order_id'],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const accountId = pickAccount(args.account_id)
        const orderId = String(args.order_id || '').trim()
        const decision = String(args.decision || 'agree').toLowerCase()
        if (!orderId) return finish(toolError('缺少 order_id'))
        const found = await findOrderWithActions(accountId, orderId)
        if (!found) return finish(toolError('没找到这笔订单，或订单列表查询失败。确认订单号，或买家是否真的发起了退款。'))
        const hints = decision === 'agree' ? AGREE_HINTS : REFUSE_HINTS
        let target = null
        for (const btn of found.btnList) {
          if (!btn) continue
          const name = String(btn.name || '')
          const ta = String(btn.tradeAction || '')
          if (hints.some((h) => name.includes(h) || ta.includes(h))) { target = btn; break }
        }
        if (!target) {
          const avail = found.btnList.map((b) => String((b && b.name) || '')).filter(Boolean)
          return finish(toolError(
            `这笔订单当前没有「${decision === 'agree' ? '同意退款' : '拒绝退款'}」操作按钮。当前可操作：${avail.join('、') || '无'}。可能买家还没发起退款，或退款已处理。`,
            { available_actions: avail },
          ))
        }
        const ce = (target.clickEvent && typeof target.clickEvent === 'object') ? target.clickEvent : {}
        const cdata = (ce.data && typeof ce.data === 'object') ? ce.data : {}
        const api = cdata.apiName
        if (!api) return finish(toolError(`退款按钮「${target.name}」没有可直接调用的接口（走页面跳转），需要运营者在 App 里点一下。`))
        const version = cdata.apiVersion || '1.0'
        let params = cdata.params && typeof cdata.params === 'object' ? { ...cdata.params } : {}
        if (!('orderId' in params) && !('bizOrderId' in params)) params.orderId = orderId
        const r = await mtop(accountId, api, version, params, { timeout: 25000 })
        if (!r || r.ok !== true) return finish(toolError(`${decision === 'agree' ? '同意' : '拒绝'}退款失败: ${(r && (r.ret || r.error)) || '无响应'}`))
        return finish(toolOk({ order_id: orderId, decision, api }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  // ── 16. 曝光体检 ────────────────────────────────────────────────────────
  const RISK_RETS = ['FAIL_SYS_USER_VALIDATE', 'RGV587', '验证码', 'punish']
  function scanStats(obj, stats = {}) {
    // 通用递归扫描：抓 浏览/想要/收藏/pv 类字段（闲鱼详情接口字段名不稳定）
    const seen = new Set()
    const walk = (node, depth) => {
      if (!node || depth > 8 || typeof node !== 'object' || seen.has(node)) return
      seen.add(node)
      for (const [k, v] of Object.entries(node)) {
        const key = String(k).toLowerCase()
        if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
          const n = Number(v)
          if (/^browse|^pv$|^view/.test(key)) stats.browse = stats.browse ?? n
          else if (/want/.test(key)) stats.want = stats.want ?? n
          else if (/collect|favor/.test(key)) stats.collect = stats.collect ?? n
          else if (/wantbuy|want_buy/.test(key)) stats.wantBuy = stats.wantBuy ?? n
        } else if (typeof v === 'object') walk(v, depth + 1)
      }
    }
    walk(obj, 0)
    return stats
  }
  const shopExposure = {
    name: 'xianyu_shop_exposure',
    description: '店铺曝光体检：逐个商品取浏览/想要/收藏，排序出热门与沉底品。默认慢速 3s+抖动（防风控），命中验证码立即早停。',
    parameters: {
      type: 'object',
      properties: {
        refresh: B('是否刷新（false=只看上次缓存）'),
        max_items: N('本次最多刷新几个（0=全部）'),
        delay: N('每个之间延迟秒数（默认 3）'),
        sort_by: S('browse|want|collect（默认 browse）'),
        limit: N('返回条数，默认 20'),
        cold_threshold: N('沉底阈值（默认 5）'),
        min_interval_hours: N('跳过 N 小时内已取过的'),
        account_id: S('可选账号'),
      },
      required: [],
    },
    output: outDef(),
    async execute(args = {}) {
      const miss = needProduct(); if (miss) return finish(miss)
      try {
        const accountId = pickAccount(args.account_id)
        const refresh = args.refresh !== false
        const delay = Math.max(0, Number(args.delay ?? 3))
        const maxItems = Math.max(0, Number(args.max_items) || 0)
        const minIntervalHours = Number(args.min_interval_hours) || 0
        let recs = await product.all(accountId)
        if (!recs.length) return finish(toolError('产品库为空：先 xianyu_sync_items 同步本店商品。'))
        let fetched = 0
        let failed = 0
        let riskHit = false
        if (refresh) {
          const cutoff = minIntervalHours > 0 ? Date.now() - minIntervalHours * 3600 * 1000 : 0
          let candidates = recs.filter((r) => {
            const at = (r.stats && r.stats.fetchedAt) || ''
            if (!cutoff) return true
            const ts = Date.parse(at)
            return !Number.isFinite(ts) || ts < cutoff
          })
          candidates = candidates.sort((a, b) => String((a.stats && a.stats.fetchedAt) || '').localeCompare(String((b.stats && b.stats.fetchedAt) || '')))
          const targets = maxItems > 0 ? candidates.slice(0, maxItems) : candidates
          for (let i = 0; i < targets.length; i++) {
            const itemId = targets[i].itemId
            const r = await mtop(accountId, 'mtop.taobao.idle.pc.detail', '1.0', { itemId }, { timeout: 20000 })
            const ret = String((r && (r.ret || r.error)) || '')
            if (RISK_RETS.some((k) => ret.includes(k))) { riskHit = true; break }
            if (r && r.ok === true) {
              const stats = scanStats(r.data || {})
              stats.fetchedAt = new Date().toISOString()
              await product.setStats(accountId, itemId, stats)
              fetched++
            } else failed++
            if (i < targets.length - 1) await sleep((delay + Math.random() * Math.max(0.5, delay * 0.5)) * 1000)
          }
          recs = await product.all(accountId)
        }
        const rows = recs.map((r) => {
          const s = r.stats || {}
          return {
            item_id: r.itemId, title: r.title || '', price: r.price || '',
            browse: Number(s.browse) || 0, want: Number(s.want) || 0,
            collect: Number(s.collect) || 0, favor: Number(s.favor) || 0,
            want_buy: Number(s.wantBuy) || 0, fetched_at: s.fetchedAt || '',
          }
        })
        const sortBy = String(args.sort_by || 'browse')
        rows.sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0))
        const limit = Number(args.limit) || 20
        const coldThreshold = Number(args.cold_threshold) || 5
        return finish(toolOk({
          fetched, failed, risk_hit: riskHit,
          warning: riskHit ? '命中风控验证码，已立即停止；请人工在浏览器处理后再继续' : '',
          hot: rows.slice(0, limit),
          cold: rows.filter((r) => (r[sortBy] || 0) <= coldThreshold).slice(0, limit),
        }))
      } catch (e) { return finish(toolError(e && e.message)) }
    },
  }

  return [
    syncItems, listItems, getProduct, updateProduct, draftProducts,
    setAutoDeliver, deliver,
    getCustomer, updateCustomer, listCustomers,
    collectItems, listCollected, pickCollected, draftFromCollected,
    refund, shopExposure,
  ]
}

export default buildXianyuStoreTools
