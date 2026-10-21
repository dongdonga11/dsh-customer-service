/**
 * 多平台内核测试（M2 前置）：不依赖任何真实平台适配器。
 *
 * 目的：锁死「一个内核跑两个平台」的边界行为：
 *   - 会话 key 用各平台自己的 slug（xy: / dy:），互不覆盖
 *   - 入站消息按 platform 落库，thread.platform 正确
 *   - /state 同时返回两个平台的账号卡/会话/平台标签
 *   - sendToThread 只发到该平台自己的桥（不串台）
 *   - AI 默认平台取 adapter.spec.aiDefaultPlatforms
 *
 * 运行：node --test --experimental-test-isolation=none test/multiplatform.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../lib/kernel/store.js'
import { CsBridge } from '../lib/kernel/bridge.js'
import { createRuntime } from '../lib/kernel/runtime.js'
import { mountRoutes } from '../lib/kernel/routes.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-cs-mp-'))
const noopLog = { info() {}, warn() {}, error() {}, debug() {} }

async function waitFor(fn, timeoutMs = 4000, stepMs = 30) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let v
    try { v = fn() } catch { v = undefined }
    if (v) return v
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** 假适配器：parseInbound 直接把 msg.text 变 message 事件；send 记录下发命令。 */
function fakeAdapter({ name, label, slug, canSend = true }) {
  const sent = []
  return {
    sent,
    spec: {
      name,
      label,
      sessionSlug: slug,
      platforms: [name],
      handles: [name],
      capabilities: { sendMode: 'direct' },
      aiDefaultPlatforms: [name],
    },
    bridgeSharingKey: name,
    parseInbound(msg) {
      if (msg.type !== 'text') return []
      return [{
        kind: 'message',
        platform: name,
        accountId: msg.account_id,
        conversationId: msg.chat_id,
        buyerUid: msg.buyer_id || '',
        text: msg.text,
        serverMessageId: msg.message_id,
        at: Date.now(),
      }]
    },
    async send(thread, text, io) {
      const cmd = { type: 'send_text', chat_id: thread.conversationId, buyer_id: thread.buyerUid, text }
      sent.push({ platform: name, cmd })
      return { ok: true, serverMessageId: 'srv-1' }
    },
    canSend() { return { ok: canSend } },
    enrichBuyer(thread) { return { name: thread.buyerName || '', avatar: '', nameKnown: false } },
    identifySelf() { return {} },
    accountIdOf(msg) { return String(msg.account_id || 'default') },
    dispose() {},
  }
}

function fakeWebServer() {
  return {
    routes: [],
    register(route) { this.routes.push(route); return () => {} },
    getOrigin() { return 'http://127.0.0.1:1' },
  }
}

async function callRoute(webServer, path) {
  const route = webServer.routes.find((r) => r.path === path)
  if (!route) throw new Error(`缺少路由 ${path}`)
  const req = {
    method: 'GET',
    url: path,
    headers: { origin: 'http://127.0.0.1:1' },
    on(ev, cb) { if (ev === 'end') cb(); return req },
    destroy() {},
  }
  const chunks = []
  const res = { status: 0, writeHead(s) { this.status = s }, end(p) { if (p) chunks.push(String(p)) } }
  await route.handler(req, res)
  await new Promise((r) => setTimeout(r, 10))
  return { status: res.status, json: JSON.parse(chunks.join('') || 'null') }
}

test('多平台：会话 key/落库/平台卡/出站路由互不串台', async () => {
  const dir = tmp()
  const store = new Store({
    dataDir: dir,
    sessionSlug: 'dy',
    defaultPlatform: 'douyin',
    label: 'mp',
    slugByPlatform: { douyin: 'dy', xianyu: 'xy' },
  })
  await store.init()

  const dy = fakeAdapter({ name: 'douyin', label: '抖音', slug: 'dy' })
  const xy = fakeAdapter({ name: 'xianyu', label: '闲鱼', slug: 'xy' })
  const bridges = []
  const runtime = createRuntime({ ctx: null, config: { label: 'mp' }, store, adapters: [dy, xy], bridges, log: noopLog })

  const bDy = new CsBridge({ host: '127.0.0.1', port: 0, pairCode: 'DYCODE', defaultPlatform: 'douyin', label: '抖音' })
  const bXy = new CsBridge({ host: '127.0.0.1', port: 0, pairCode: 'XYCODE', defaultPlatform: 'xianyu', label: '闲鱼' })
  for (const [bridge, adapter, code] of [[bDy, dy, 'DYCODE'], [bXy, xy, 'XYCODE']]) {
    bridges.push(bridge)
    runtime.attachBridge(bridge)
    bridge.setInboundHandler((msg, acct) => runtime.apply(msg, acct))
    assert.equal(await bridge.start(), true)
    // 配对 + 发一条入站消息
    const port = bridge._server.address().port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')) })
    const acks = []
    ws.onmessage = (ev) => { try { acks.push(JSON.parse(String(ev.data))) } catch { /* ignore */ } }
    ws.send(JSON.stringify({ type: 'hello', pair_code: code, account_id: `${adapter.spec.name}-acct`, platform: adapter.spec.name }))
    // 必须等桥真正登记账号后再发消息（否则消息会被当成未配对连接直接拒绝）
    await waitFor(() => bridge._connections.has(`${adapter.spec.name}-acct`))
    await waitFor(() => acks.some((m) => m.type === 'hello_ack' && m.ok === true))
    ws.send(JSON.stringify({ type: 'text', account_id: `${adapter.spec.name}-acct`, chat_id: 'chat1', buyer_id: 'buyer1', text: `来自${adapter.spec.label}的买家`, message_id: `${adapter.spec.name}-m1` }))
    await waitFor(() => store.getThreads().some((t) => t.id.startsWith(`${adapter.spec.name === 'xianyu' ? 'xy' : 'dy'}:`)))
    ws.close()
  }

  try {
    // 1) 会话 key 用各自 slug，互不覆盖
    const threads = store.getThreads()
    assert.equal(threads.length, 2)
    const byId = Object.fromEntries(threads.map((t) => [t.id, t]))
    assert.ok(byId['dy:douyin-acct:chat1'], '抖音会话应为 dy: 前缀')
    assert.ok(byId['xy:xianyu-acct:chat1'], '闲鱼会话应为 xy: 前缀')
    assert.equal(byId['xy:xianyu-acct:chat1'].platform, 'xianyu')
    assert.equal(byId['dy:douyin-acct:chat1'].platform, 'douyin')
    assert.equal(byId['xy:xianyu-acct:chat1'].unread, 1)
    assert.equal(byId['dy:douyin-acct:chat1'].unread, 1)

    // 2) /state 同时包含两个平台
    const ws = fakeWebServer()
    const dispose = mountRoutes({ webServer: ws, runtime, prefix: '/dsh-cs', auth: null, log: noopLog })
    const state = await callRoute(ws, '/dsh-cs/state')
    assert.equal(state.status, 200)
    assert.equal(state.json.ok, true)
    assert.equal(state.json.threads.length, 2, '/state 应同时返回两个平台的会话')
    assert.equal(state.json.platformLabels?.xianyu, '闲鱼')
    assert.equal(state.json.platformLabels?.douyin, '抖音')
    const platforms = (state.json.platforms || []).map((p) => p.name || p.id || p)
    assert.ok(platforms.includes('xianyu'), '/state.platforms 应包含 xianyu')
    assert.ok(platforms.includes('douyin'), '/state.platforms 应包含 douyin')
    // 多平台必须按平台给出各自的端口/配对码（面板「桥信息」靠它，否则会填错码）
    const xyPlatform = (state.json.platforms || []).find((p) => p.name === 'xianyu')
    const dyPlatform = (state.json.platforms || []).find((p) => p.name === 'douyin')
    assert.equal(xyPlatform?.pairCode, 'XYCODE', '闲鱼平台卡应带自己的配对码')
    assert.equal(dyPlatform?.pairCode, 'DYCODE', '抖音平台卡应带自己的配对码')
    assert.equal(typeof xyPlatform?.port, 'number')

    // 3) 出站只发自己的桥（fake adapter 记录 + 命令字段）
    const xyThread = byId['xy:xianyu-acct:chat1']
    const res = await runtime.sendToThread(xyThread, '闲鱼回复')
    assert.equal(res.ok, true)
    assert.equal(xy.sent.length, 1, '闲鱼消息只能经闲鱼适配器发送')
    assert.equal(dy.sent.length, 0, '抖音适配器不得收到闲鱼消息')
    assert.deepEqual(xy.sent[0].cmd, { type: 'send_text', chat_id: 'chat1', buyer_id: 'buyer1', text: '闲鱼回复' })

    dispose()
  } finally {
    for (const b of bridges) { try { await b.stop() } catch { /* ignore */ } }
    try { await store.save() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('多平台：store.threadId 按平台 slug，未知平台退回默认前缀', async () => {
  const dir = tmp()
  try {
    const store = new Store({ dataDir: dir, label: 'mp', slugByPlatform: { xianyu: 'xy' } })
    assert.equal(store.threadId('a', 'c', 'xianyu'), 'xy:a:c')
    assert.equal(store.threadId('a', 'c', 'douyin'), 'dy:a:c', '未登记平台退回默认 dy')
    assert.equal(store.threadId('a', 'c'), 'dy:a:c')
    assert.equal(store.slugFor('xianyu'), 'xy')
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})
