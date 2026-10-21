/**
 * 闲鱼工具集契约测试（M2 批次 1）：离线、假 adapter/runtime/store。
 * 目的：锁死「工具名/参数/输出/执行语义」与 Hermes tools.py 的一致性，防止后续改动静默漂移。
 *
 * 运行：node --test --experimental-test-isolation=none test/xianyu-tools.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildXianyuTools } from '../lib/platforms/xianyu/tools.js'
import { registerToolDefs } from '../lib/kernel/toolkit.js'

const noop = { info() {}, warn() {}, error() {}, debug() {} }

function makeDeps(overrides = {}) {
  const calls = { mtop: [], raw: [], send: [], image: [], outbound: [] }
  const adapter = {
    spec: { name: 'xianyu', label: '闲鱼' },
    async callApi(payload, io) {
      calls.mtop.push({ payload, hasIo: Boolean(io) })
      return overrides.mtopResponse ? overrides.mtopResponse(payload) : { ok: true, ret: 'SUCCESS::调用成功', data: { ok: true }, raw: { ret: ['SUCCESS::调用成功'] } }
    },
    async callApiRaw(req, io) {
      calls.raw.push({ req, hasIo: Boolean(io) })
      return overrides.rawResponse ? overrides.rawResponse(req) : { ok: true, data: { done: true } }
    },
    async send(thread, text, io) {
      calls.send.push({ thread, text, hasIo: Boolean(io) })
      return { ok: true, server_message_id: 'srv-1' }
    },
    async sendImage(thread, url, io) {
      calls.image.push({ thread, url, hasIo: Boolean(io) })
      return { ok: true, server_message_id: 'srv-2' }
    },
  }
  const store = {
    getAccounts: () => [{ id: 'unb-1', platform: 'xianyu', connected: true, nickname: '店' }],
    recordOutbound: (...args) => calls.outbound.push(args),
  }
  const runtime = {
    ioFor: () => ({ bridge: { fake: true } }),
    state: () => ({
      accounts: [{ id: 'unb-1', platform: 'xianyu', connected: true }],
      threads: [{ id: 'xy:unb-1:c1', platform: 'xianyu', unread: 2 }],
    }),
  }
  return { calls, deps: { adapter, runtime, store, log: noop } }
}

const parse = (s) => JSON.parse(String(s))
const byName = (defs, name) => defs.find((d) => d.name === name)

test('T1 工具清单：批次 1 共 16 个，名字唯一，字段齐全', () => {
  const { deps } = makeDeps()
  const defs = buildXianyuTools(deps)
  assert.equal(defs.length, 16, '批次 1 应有 16 个工具')
  const names = defs.map((d) => d.name)
  assert.equal(new Set(names).size, names.length, '工具名不得重复')
  for (const expected of [
    'xianyu_status', 'xianyu_send_message', 'xianyu_mtop', 'xianyu_get_order', 'xianyu_list_orders',
    'xianyu_confirm_ship', 'xianyu_freeshipping', 'xianyu_rate', 'xianyu_close_order', 'xianyu_buyer_credit',
    'xianyu_item_detail', 'xianyu_refresh_item', 'xianyu_delete_item', 'xianyu_search',
    'xianyu_publish_item', 'xianyu_read_page',
  ]) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`)
  }
  for (const d of defs) {
    assert.equal(typeof d.description, 'string')
    assert.ok(d.description.length > 5, `${d.name} description 太短`)
    assert.equal(typeof d.parameters, 'object')
    assert.equal(d.parameters.type, 'object')
    assert.equal(typeof d.output?.schema, 'object')
    assert.equal(typeof d.output?.render, 'function')
    assert.equal(typeof d.execute, 'function')
  }
  // 不可逆动作必须在描述里提示确认
  for (const n of ['xianyu_confirm_ship', 'xianyu_rate', 'xianyu_delete_item', 'xianyu_publish_item', 'xianyu_close_order']) {
    assert.match(byName(defs, n).description, /确认|不可逆/, `${n} 描述应提示先确认`)
  }
})

test('T2 registerToolDefs：注册/释放（DSH ctx.tools 契约）', () => {
  const { deps } = makeDeps()
  const defs = buildXianyuTools(deps)
  const registered = []
  const ctx = { tools: { register: (def) => { registered.push(def.name); return () => { const i = registered.indexOf(def.name); if (i >= 0) registered.splice(i, 1) } } } }
  const dispose = registerToolDefs(ctx, defs, noop)
  assert.equal(registered.length, 16)
  dispose()
  assert.equal(registered.length, 0, '释放后应全部摘除')
})

test('T3 xianyu_status：返回账号/会话/未读（JSON 字符串）', async () => {
  const { deps } = makeDeps()
  const defs = buildXianyuTools(deps)
  const r = parse(await byName(defs, 'xianyu_status').execute({}))
  assert.equal(r.success, true)
  assert.equal(r.platform, 'xianyu')
  assert.equal(r.connected, true)
  assert.equal(r.accounts.length, 1)
  assert.equal(r.threads, 1)
  assert.equal(r.unread, 2)
})

test('T4 xianyu_mtop：透传 api/version/data 到 adapter.callApi', async () => {
  const { deps, calls } = makeDeps()
  const defs = buildXianyuTools(deps)
  const r = parse(await byName(defs, 'xianyu_mtop').execute({ api: 'mtop.idle.web.trade.order.detail', data: { tid: '123' } }))
  assert.equal(r.ok, true)
  assert.equal(calls.mtop.length, 1)
  assert.equal(calls.mtop[0].payload.api, 'mtop.idle.web.trade.order.detail')
  assert.equal(calls.mtop[0].payload.version, '1.0')
  assert.deepEqual(calls.mtop[0].payload.data, { tid: '123' })
  assert.equal(calls.mtop[0].payload.accountId, 'unb-1')
  assert.equal(calls.mtop[0].hasIo, true, '必须带 io（桥指令通道）')
})

test('T5 订单/交易工具：api 名与 data 体对齐 Hermes', async () => {
  const { deps, calls } = makeDeps()
  const defs = buildXianyuTools(deps)
  await byName(defs, 'xianyu_get_order').execute({ order_id: 'o1' })
  await byName(defs, 'xianyu_confirm_ship').execute({ order_id: 'o1' })
  await byName(defs, 'xianyu_rate').execute({ trade_id: 'o1', feedback: '好买家' })
  await byName(defs, 'xianyu_buyer_credit').execute({ buyer_id: 'b1' })
  const apis = calls.mtop.map((c) => c.payload.api)
  assert.deepEqual(apis, [
    'mtop.idle.web.trade.order.detail',
    'mtop.taobao.idle.logistic.consign.dummy',
    'mtop.taobao.idle.rate.create',
    'mtop.idle.web.trade.rate.list',
  ])
  assert.deepEqual(calls.mtop[0].payload.data, { tid: 'o1' })
  assert.deepEqual(calls.mtop[1].payload.data, { orderId: 'o1', tradeText: '', picList: [], newUnconsign: true })
  assert.equal(calls.mtop[2].payload.version, '4.0')
  assert.deepEqual(calls.mtop[2].payload.data, { tradeId: 'o1', rate: 1, feedback: '好买家', createOrAppend: 0 })
  assert.equal(calls.mtop[3].payload.data.ratedUid, 'b1')
})

test('T6 找品：固定 app_key=12574478 + 分页/价格参数', async () => {
  const { deps, calls } = makeDeps()
  const defs = buildXianyuTools(deps)
  await byName(defs, 'xianyu_search').execute({ keyword: 'iPhone', page: 2, price_min: 100, price_max: 900 })
  const p = calls.mtop[0].payload
  assert.equal(p.api, 'mtop.taobao.idlemtopsearch.pc.search')
  assert.equal(p.appKey, '12574478')
  assert.equal(p.data.pageNumber, 2)
  assert.equal(p.data.keyword, 'iPhone')
  assert.equal(p.data.priceMin, '100')
})

test('T7 发消息：定向 thread + 落库；缺 chat_id 明确失败', async () => {
  const { deps, calls } = makeDeps()
  const defs = buildXianyuTools(deps)
  const ok = parse(await byName(defs, 'xianyu_send_message').execute({ text: '在的', chat_id: 'c1', buyer_id: 'b1' }))
  assert.equal(ok.success, true)
  assert.equal(calls.send.length, 1)
  assert.deepEqual(calls.send[0].thread, { platform: 'xianyu', accountId: 'unb-1', conversationId: 'c1', buyerUid: 'b1', buyerName: '' })
  assert.equal(calls.outbound.length, 1, '出站消息应落库')
  assert.equal(calls.outbound[0][5], 'xianyu', '落库必须带平台（会话 key 用 xy: 前缀）')

  const bad = parse(await byName(defs, 'xianyu_send_message').execute({ text: 'x' }))
  assert.equal(bad.success, false)
  assert.match(bad.error, /chat_id/)
})

test('T8 发品/读页面：callApiRaw 的 action 与 args 形状（扩展契约）', async () => {
  const { deps, calls } = makeDeps()
  const defs = buildXianyuTools(deps)
  await byName(defs, 'xianyu_publish_item').execute({ title: '测试品', price: 9.9, images: ['https://example.invalid/a.png'] })
  const pub = calls.raw[0].req
  assert.equal(pub.action, 'publish_item')
  assert.equal(pub.args.item.title, '测试品')
  assert.equal(pub.args.item.price, '9.9')
  assert.equal(pub.timeout, 90000)

  await byName(defs, 'xianyu_read_page').execute({ target: 'publish', raw: true, scope: 'form' })
  const read = calls.raw[1].req
  assert.equal(read.action, 'read_page')
  assert.deepEqual(read.args, { target: 'publish', raw: true, scope: 'form' }, 'read_page 必须是扁平 args（扩展只认扁平）')
  assert.equal(read.timeout, 45000)
})

test('T9 接口失败/桥离线：结构化失败，不抛异常', async () => {
  const { deps } = makeDeps({
    mtopResponse: () => ({ ok: false, ret: 'FAIL_SYS_TOKEN_EXOIRED::令牌过期', error: '令牌过期' }),
  })
  const defs = buildXianyuTools(deps)
  const r = parse(await byName(defs, 'xianyu_get_order').execute({ order_id: 'o1' }))
  assert.equal(r.success, false)
  assert.match(r.error, /失败/)
  // 执行层绝不抛异常
  const offline = makeDeps({ rawResponse: () => ({ ok: false, error: '桥不可用' }) })
  const defs2 = buildXianyuTools(offline.deps)
  const r2 = parse(await byName(defs2, 'xianyu_read_page').execute({}))
  assert.equal(r2.success, false)
  assert.match(r2.error, /读页面失败|桥不可用/)
})
