/**
 * 闲鱼工具集批次 2 契约测试（产品库/客户档案/采集库/退款/曝光）。
 * 用内存假 store + 假 adapter，验证工具语义与调用形状；真实 store 由 xianyu-stores.test.mjs 覆盖。
 *
 * 运行：node --test --experimental-test-isolation=none test/xianyu-store-tools.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildXianyuStoreTools } from '../lib/platforms/xianyu/tools.stores.js'
import { createProductStore } from '../lib/platforms/xianyu/product_store.js'
import { createCustomerStore } from '../lib/platforms/xianyu/customer_store.js'
import { createCollectStore } from '../lib/platforms/xianyu/collect_store.js'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const noop = { info() {}, warn() {}, error() {}, debug() {} }
const parse = (s) => JSON.parse(String(s))
const byName = (defs, name) => defs.find((d) => d.name === name)

function fakeProductStore() {
  const map = new Map()
  const calls = []
  return {
    calls,
    syncSkeleton(accountId, items) {
      calls.push({ op: 'syncSkeleton', accountId, items })
      let added = 0, updated = 0
      for (const it of items) {
        if (!it.itemId) continue
        if (map.has(it.itemId)) { updated++ } else { added++ }
        const prev = map.get(it.itemId) || {}
        map.set(it.itemId, {
          ...prev, itemId: it.itemId, title: it.title, price: it.price, mainPic: it.mainPic,
          detail: prev.detail || { intro: '', netdisk: '', images: [], faq: [], sellingPoints: '', pricing: '', dealScripts: '' },
          detailStatus: prev.detailStatus || '待完善',
          stats: prev.stats || {},
          autoDeliver: prev.autoDeliver || false,
        })
      }
      return { added, updated, total: map.size }
    },
    list(accountId, { keyword = '', status = '', limit = 50 } = {}) {
      return [...map.values()]
        .filter((r) => (!keyword || r.title.includes(keyword)) && (!status || r.detailStatus === status))
        .slice(0, limit)
    },
    all() { return [...map.values()] },
    get(_a, itemId) { return map.get(itemId) || null },
    updateDetail(_a, itemId, patch, { status, source } = {}) {
      const rec = map.get(itemId) || { itemId, title: '', price: '', detail: {}, detailStatus: '待完善', stats: {} }
      rec.detail = { ...rec.detail, ...patch }
      rec.detailStatus = status || (source === 'ai' ? 'AI草稿' : rec.detailStatus || '待完善')
      map.set(itemId, rec)
      return rec
    },
    setStats(_a, itemId, stats) {
      const r = map.get(itemId)
      if (!r) return false
      r.stats = { ...r.stats, ...stats }
      return true
    },
    setAutoDeliver(_a, itemId, { enabled, deliveryText }) {
      const r = map.get(itemId) || { itemId, detail: {}, stats: {} }
      r.autoDeliver = enabled
      r.deliveryText = deliveryText
      map.set(itemId, r)
      return r
    },
    buildDeliveryContent(_a, itemId) {
      const r = map.get(itemId)
      if (!r) return ''
      return (r.deliveryText || (r.detail && r.detail.netdisk) || '').trim()
    },
  }
}

function fakeCustomerStore() {
  const map = new Map()
  return {
    get(_a, buyerId) { return map.get(buyerId) || null },
    update(_a, buyerId, patch) {
      const rec = { buyerId, ...(map.get(buyerId) || {}), ...patch }
      map.set(buyerId, rec)
      return rec
    },
    list(_a, { limit = 100 } = {}) { return [...map.values()].slice(0, limit) },
    recordTurn(_a, buyerId, turn) {
      const rec = map.get(buyerId) || { buyerId, turns: [] }
      rec.turns = [...(rec.turns || []), turn]
      map.set(buyerId, rec)
      return rec
    },
    lookup(_a, buyerId) { const r = map.get(buyerId); return r ? { name: r.buyerNick || '', avatar: r.avatar || '' } : null },
  }
}

function fakeCollectStore() {
  const map = new Map()
  return {
    upsert(_a, items, source) {
      let added = 0, updated = 0
      for (const it of items) {
        if (!it.itemId) continue
        if (map.has(it.itemId)) { updated++ } else { added++ }
        const prev = map.get(it.itemId) || { firstSeenAt: Date.now() }
        map.set(it.itemId, { ...prev, ...it, picked: prev.picked || false, source })
      }
      return { scanned: items.length, kept: items.length, new: added, updated }
    },
    list(_a, { limit = 50 } = {}) { return [...map.values()].slice(0, limit) },
    get(_a, itemId) { return map.get(itemId) || null },
    setPicked(_a, itemId, picked) { const r = map.get(itemId); if (!r) return false; r.picked = picked; return true },
  }
}

function makeDeps(overrides = {}) {
  const calls = { mtop: [], send: [], outbound: [] }
  const adapter = {
    spec: { name: 'xianyu', label: '闲鱼' },
    async callApi(payload, io) {
      calls.mtop.push({ payload })
      if (overrides.mtop) return overrides.mtop(payload)
      return { ok: true, ret: 'SUCCESS::调用成功', data: {}, raw: {} }
    },
    async send(thread, text) { calls.send.push({ thread, text }); return { ok: true, server_message_id: 'sv-1' } },
  }
  const store = {
    getAccounts: () => [{ id: 'unb-1', platform: 'xianyu', connected: true }],
    recordOutbound: (...args) => calls.outbound.push(args),
  }
  const runtime = { ioFor: () => ({ bridge: {} }), state: () => ({ accounts: [], threads: [] }) }
  const stores = overrides.stores || {
    product: fakeProductStore(),
    customer: fakeCustomerStore(),
    collect: fakeCollectStore(),
  }
  return { calls, deps: { adapter, runtime, store, stores, log: noop } }
}

test('S1 工具清单：批次 2 共 16 个，不可逆工具提示确认', () => {
  const { deps } = makeDeps()
  const defs = buildXianyuStoreTools(deps)
  assert.equal(defs.length, 16)
  const names = defs.map((d) => d.name)
  assert.equal(new Set(names).size, names.length)
  for (const n of [
    'xianyu_sync_items', 'xianyu_list_items', 'xianyu_get_product', 'xianyu_update_product', 'xianyu_draft_products',
    'xianyu_set_auto_deliver', 'xianyu_deliver', 'xianyu_get_customer', 'xianyu_update_customer', 'xianyu_list_customers',
    'xianyu_collect', 'xianyu_list_collected', 'xianyu_pick_collected', 'xianyu_draft_from_collected',
    'xianyu_refund', 'xianyu_shop_exposure',
  ]) assert.ok(names.includes(n), `缺少 ${n}`)
  for (const d of defs) { assert.equal(typeof d.execute, 'function'); assert.equal(typeof d.output?.render, 'function') }
  assert.match(byName(defs, 'xianyu_refund').description, /确认/)
})

test('S2 sync_items：分页拉取 cardList 并只写骨架', async () => {
  const page1 = { cardList: Array.from({ length: 20 }, (_, i) => ({ cardData: { id: `i${i}`, title: `品${i}`, priceInfo: { price: `${i}00` }, picInfo: { picUrl: `p${i}` } } })) }
  const page2 = { cardList: [{ cardData: { id: 'i20', title: '品20', priceInfo: { price: '2000' }, picInfo: {} } }] }
  const { deps, calls } = makeDeps({ mtop: (p) => ({ ok: true, ret: 'SUCCESS', data: p.data.pageNumber === 1 ? page1 : page2 }) })
  const defs = buildXianyuStoreTools(deps)
  const r = parse(await byName(defs, 'xianyu_sync_items').execute({ max_pages: 5 }))
  assert.equal(r.success, true)
  assert.equal(r.added, 21, '两页共 21 个商品')
  assert.equal(calls.mtop[0].payload.injectUnbAs, 'userId', '商品列表需要 inject_unb_as=userId')
  assert.equal(calls.mtop[0].payload.data.groupName, '在售')
  assert.equal(calls.mtop.length, 2)
  // 骨架同步不覆盖 detail（fake store 保证；这里断言 list 里仍是待完善）
  const list = parse(await byName(defs, 'xianyu_list_items').execute({}))
  assert.equal(list.items[0].detailStatus, '待完善')
})

test('S3 产品库：update→draft→set_auto_deliver（无内容警告）→deliver 发送', async () => {
  const { deps, calls } = makeDeps()
  const defs = buildXianyuStoreTools(deps)
  const e = (n, a) => byName(defs, n).execute(a)

  assert.equal(parse(await e('xianyu_sync_items', {})).success, true)
  const upd = parse(await e('xianyu_update_product', { item_id: 'i0', intro: '介绍', netdisk: '网盘链接', status: '已确认' }))
  assert.equal(upd.product.detail.netdisk, '网盘链接')
  assert.equal(upd.product.detailStatus, '已确认')

  const warn = parse(await e('xianyu_set_auto_deliver', { item_id: 'i1', enabled: true }))
  assert.equal(warn.success, true)
  assert.match(warn.warning, /没有可用交付内容/)

  const okAuto = parse(await e('xianyu_set_auto_deliver', { item_id: 'i0', enabled: true }))
  assert.equal(okAuto.content_preview, '网盘链接')

  const sent = parse(await e('xianyu_deliver', { item_id: 'i0', chat_id: 'c1', buyer_id: 'b1' }))
  assert.equal(sent.success, true)
  assert.deepEqual(calls.send[0].thread, { platform: 'xianyu', accountId: 'unb-1', conversationId: 'c1', buyerUid: 'b1', buyerName: '' })
  assert.equal(calls.send[0].text, '网盘链接')
  assert.equal(calls.outbound.length, 1)
})

test('S4 客户档案：update / get / list', async () => {
  const { deps } = makeDeps()
  const defs = buildXianyuStoreTools(deps)
  const e = (n, a) => byName(defs, n).execute(a)
  const upd = parse(await e('xianyu_update_customer', { buyer_id: 'b1', region: '杭州', tags: ['砍价'], deal: true }))
  assert.equal(upd.customer.region, '杭州')
  const got = parse(await e('xianyu_get_customer', { buyer_id: 'b1' }))
  assert.equal(got.exists, true)
  assert.equal(got.customer.deal, true)
  const lst = parse(await e('xianyu_list_customers', {}))
  assert.equal(lst.count, 1)
})

test('S5 采集库：collect（搜索映射+过滤）→list→pick→draft', async () => {
  const mk = (id, price, want) => ({ item: { main: { exContent: { itemId: id, title: `品${id}`, price, wantCnt: want, area: '杭州' } } } })
  const { deps, calls } = makeDeps({
    mtop: () => ({ ok: true, ret: 'SUCCESS', data: { resultList: [mk('c1', '99', 10), mk('c2', '5', 100)] } }),
  })
  const defs = buildXianyuStoreTools(deps)
  const e = (n, a) => byName(defs, n).execute(a)
  const col = parse(await e('xianyu_collect', { keyword: '示例店铺', min_want: 50 }))
  assert.equal(col.success, true)
  assert.equal(col.kept, 1, 'min_want 过滤掉一个')
  assert.equal(calls.mtop[0].payload.data.keyword, '示例店铺')
  assert.equal(calls.mtop[0].payload.appKey, '12574478')

  const lst = parse(await e('xianyu_list_collected', {}))
  assert.equal(lst.count, 1)
  assert.equal(parse(await e('xianyu_pick_collected', { item_id: 'c2' })).picked, true)
  const draft = parse(await e('xianyu_draft_from_collected', { item_id: 'c2' }))
  assert.equal(draft.success, true)
  assert.ok(draft.draft.price > 0, '草稿价 = 参考价×1.15')
  assert.match(draft.draft.instructions, /自己的品/)
})

test('S6 退款：从 btnList 取动态接口执行；无按钮时返回可操作清单', async () => {
  const order = (btnList) => ({ ok: true, ret: 'SUCCESS', data: { module: { items: [{ commonData: { orderId: 'o1' }, rightVO: { btnList } }], nextPage: 'false' } } })
  const agreeBtn = { name: '同意退款', clickEvent: { data: { apiName: 'mtop.x.refund.agree', apiVersion: '2.0', params: { refundId: 'r1' } } } }
  const { deps, calls } = makeDeps({
    mtop: (p) => (p.api === 'mtop.taobao.idle.trade.merchant.sold.get' ? order([agreeBtn]) : { ok: true, ret: 'SUCCESS::调用成功', data: {} }),
  })
  const defs = buildXianyuStoreTools(deps)
  const ok = parse(await byName(defs, 'xianyu_refund').execute({ order_id: 'o1', decision: 'agree' }))
  assert.equal(ok.success, true)
  assert.equal(ok.api, 'mtop.x.refund.agree')
  const dyn = calls.mtop.find((c) => c.payload.api === 'mtop.x.refund.agree')
  assert.ok(dyn, '必须调用按钮自带的 apiName')
  assert.equal(dyn.payload.version, '2.0')
  assert.equal(dyn.payload.data.orderId, 'o1', '缺 orderId 时自动补')
  assert.equal(dyn.payload.data.refundId, 'r1', '按钮自带 params 必须原样带上')

  const noBtn = makeDeps({ mtop: () => order([]) })
  const defs2 = buildXianyuStoreTools(noBtn.deps)
  const bad = parse(await byName(defs2, 'xianyu_refund').execute({ order_id: 'o1' }))
  assert.equal(bad.success, false)
  assert.match(bad.error, /没有「同意退款」/)
})

test('S8 真实 store 联调：产品库/采集库/客户档案各自分区落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xy-real-stores-'))
  const stores = {
    product: createProductStore({ dataDir: dir }),
    customer: createCustomerStore({ dataDir: dir }),
    collect: createCollectStore({ dataDir: dir }),
  }
  const { deps } = makeDeps({
    stores,
    mtop: (p) => {
      if (p.api === 'mtop.idle.web.xyh.item.list') {
        return { ok: true, ret: 'SUCCESS', data: { cardList: [{ cardData: { id: 'p1', title: '本店品', priceInfo: { price: '88' } } }] } }
      }
      if (p.api === 'mtop.taobao.idlemtopsearch.pc.search') {
        return { ok: true, ret: 'SUCCESS', data: { resultList: [{ item: { main: { exContent: { itemId: 'c1', title: '别人的品', price: '66', wantCnt: 9 } } } }] } }
      }
      return { ok: true, ret: 'SUCCESS', data: {} }
    },
  })
  const defs = buildXianyuStoreTools(deps)
  const e = (n, a) => byName(defs, n).execute(a)
  try {
    assert.equal(parse(await e('xianyu_sync_items', {})).success, true)
    assert.equal(existsSync(join(dir, 'products', 'unb-1.json')), true, '产品库按账号落盘')
    const prod1 = JSON.parse(readFileSync(join(dir, 'products', 'unb-1.json'), 'utf8'))
    assert.equal(prod1.p1.title, '本店品')

    assert.equal(parse(await e('xianyu_collect', { keyword: '示例店铺' })).success, true)
    assert.equal(existsSync(join(dir, 'collected', 'unb-1.json')), true, '采集库独立目录')
    const collected = JSON.parse(readFileSync(join(dir, 'collected', 'unb-1.json'), 'utf8'))
    assert.ok(collected.c1, '采集库有别人的商品')
    const prod2 = JSON.parse(readFileSync(join(dir, 'products', 'unb-1.json'), 'utf8'))
    assert.equal(Object.keys(prod2).length, 1, '采集不得写进产品库')

    assert.equal(parse(await e('xianyu_update_customer', { buyer_id: 'b1', region: '杭州' })).success, true)
    assert.equal(existsSync(join(dir, 'customers', 'unb-1', 'b1.json')), true, '客户档案按账号/买家落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('S7 曝光体检：命中风控立即早停；refresh=false 只看缓存排序', async () => {
  const risk = makeDeps({
    mtop: (p) => (p.api === 'mtop.idle.web.xyh.item.list'
      ? { ok: true, ret: 'SUCCESS', data: { cardList: [{ cardData: { id: 'i0', title: '品0', priceInfo: { price: '10' } } }] } }
      : { ok: false, ret: 'FAIL_SYS_USER_VALIDATE::请验证', error: 'risk' }),
  })
  const d1 = buildXianyuStoreTools(risk.deps)
  await byName(d1, 'xianyu_sync_items').execute({})
  const r1 = parse(await byName(d1, 'xianyu_shop_exposure').execute({ max_items: 3, delay: 0 }))
  assert.equal(r1.success, true)
  assert.equal(r1.risk_hit, true, '命中风控应早停')
  assert.match(r1.warning, /风控/)

  const cacheOnly = makeDeps({
    mtop: (p) => (p.api === 'mtop.idle.web.xyh.item.list'
      ? { ok: true, ret: 'SUCCESS', data: { cardList: [{ cardData: { id: 'i0', title: '品0', priceInfo: { price: '10' } } }] } }
      : { ok: true, ret: 'SUCCESS', data: {} }),
  })
  const d2 = buildXianyuStoreTools(cacheOnly.deps)
  await byName(d2, 'xianyu_sync_items').execute({})
  const r2 = parse(await byName(d2, 'xianyu_shop_exposure').execute({ refresh: false }))
  assert.equal(r2.success, true)
  assert.equal(r2.fetched, 0)
  assert.ok(Array.isArray(r2.hot))
})
