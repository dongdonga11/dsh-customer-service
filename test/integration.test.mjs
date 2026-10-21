/**
 * 端到端接线测试（不依赖 DSH）：
 *   A. runtime + bridge + douyin adapter：真实 WebSocket 握手 → 账号事件 → store
 *   B. lib/index.js 装配：fake ctx + fake webServer → 配对码落盘 + 路由注册 + /state 可用
 *
 * 运行：node --test test/integration.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../lib/kernel/store.js'
import { CsBridge } from '../lib/kernel/bridge.js'
import { createRuntime } from '../lib/kernel/runtime.js'
import { createDouyinAdapter } from '../lib/platforms/douyin/adapter.js'
import { apply as pluginApply } from '../lib/index.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-cs-it-'))
const noopLog = { info() {}, warn() {}, error() {}, debug() {} }

async function waitFor(fn, timeoutMs = 4000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let v
    try { v = fn() } catch { v = undefined }
    if (v) return v
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

test('A. 真实 WS：hello 配对 → _paired 落库 → platform_account 注册第二账号', async () => {
  const dir = tmp()
  const store = new Store({ dataDir: dir, sessionSlug: 'dy', defaultPlatform: 'douyin', label: 'it' })
  await store.init()
  const adapter = createDouyinAdapter({ store, log: noopLog, dataDir: dir, host: '127.0.0.1' })
  const bridges = []
  const runtime = createRuntime({ ctx: null, config: { label: 'it' }, store, adapters: [adapter], bridges, log: noopLog })
  const bridge = new CsBridge({ host: '127.0.0.1', port: 0, pairCode: 'TESTCODE', defaultPlatform: 'douyin', label: 'it' })
  bridges.push(bridge)
  runtime.attachBridge(bridge)
  bridge.setInboundHandler((msg, acct) => runtime.apply(msg, acct))
  try {
    const ok = await bridge.start()
    assert.equal(ok, true)
    const port = bridge._server.address().port

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const acks = []
    ws.onmessage = (ev) => { try { acks.push(JSON.parse(String(ev.data))) } catch { /* ignore */ } }
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = (e) => reject(new Error('ws 连接失败'))
    })
    // 先验证「错误配对码被拒」：用独立连接，避免关连接影响后续（真实扩展也是失败即停）
    const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const badAcks = []
    bad.onmessage = (ev) => { try { badAcks.push(JSON.parse(String(ev.data))) } catch { /* ignore */ } }
    bad.onerror = () => { /* 拒绝后可能直接关闭，不算失败 */ }
    await new Promise((r) => { bad.onopen = r; setTimeout(r, 1500) })
    bad.send(JSON.stringify({ type: 'hello', pair_code: 'WRONG', account_id: 'acct0' }))
    await waitFor(() => badAcks.find((m) => m.type === 'hello_ack' && m.ok === false) || bad.readyState === WebSocket.CLOSED)
    try { bad.close() } catch { /* ignore */ }
    assert.equal(bridge._connections.has('acct0'), false, '错误配对码不得建立账号连接')

    // 正确配对码（复用已开的连接）
    ws.send(JSON.stringify({ type: 'hello', pair_code: 'TESTCODE', account_id: 'acct1', ext_version: '1', features: [] }))
    await waitFor(() => acks.find((m) => m.type === 'hello_ack' && m.ok === true))
    await waitFor(() => store.getAccount('acct1')?.connected === true)

    // 同一连接上报第二平台账号（来客）
    ws.send(JSON.stringify({ type: 'platform_account', platform: 'douyin-laike', account_id: 'laike-1', nickname: '测试店' }))
    await waitFor(() => store.getAccount('laike-1'))
    assert.equal(bridge.platformOf('laike-1'), 'douyin-laike')
    assert.equal(bridge.accountsOfPlatform('douyin-laike').includes('laike-1'), true)

    ws.close()
    await bridge.stop()
    assert.equal(bridge._running, false)
  } finally {
    // teardown：先停运行时 + 显式 flush，再删临时目录。
    // Store 的落盘是 500ms 节流的；直接 rmSync 会让挂起的 save() 在目录消失后
    // 才执行 mkdir/rename，报 ENOENT（测试仍 pass，但 stderr 脏、误导排障）。
    try { runtime.dispose() } catch { /* ignore */ }
    try { await store.save() } catch { /* ignore */ } // save() 内部会清掉挂起的定时器
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

/** fake ctx：记录 effect/disposer，注入一个 fake webServer */
function makeCtx() {
  const disposers = []
  const webServer = {
    routes: [],
    register(route) {
      this.routes.push(route)
      return () => { const i = this.routes.indexOf(route); if (i >= 0) this.routes.splice(i, 1) }
    },
    getOrigin() { return 'http://127.0.0.1:1' },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const out = fn()
      if (typeof out === 'function') disposers.push(out)
      else if (out && typeof out.then === 'function') out.then((d) => { if (typeof d === 'function') disposers.push(d) })
      return out
    },
    inject(_services, cb) { cb({ webServer }) },
    get() { return undefined },
    webServer,
    async disposeAll() {
      for (const d of disposers.reverse()) {
        try { await d() } catch { /* ignore */ }
      }
    },
  }
  return ctx
}

/** 直接调路由 handler，返回 {status, body} */
async function callRoute(ctx, path, { method = 'GET', body, headers = {} } = {}) {
  const route = ctx.webServer.routes.find((r) => r.path === path)
  if (!route) throw new Error(`路由未注册: ${path}（已注册：${ctx.webServer.routes.map((r) => r.path).join(', ')}）`)
  const req = {
    method,
    url: path,
    headers: { origin: 'http://127.0.0.1:1', ...headers },
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
      return req
    },
    destroy() {},
  }
  const chunks = []
  const res = {
    status: 0,
    writeHead(status) { this.status = status; return this },
    end(payload) { if (payload) chunks.push(String(payload)) },
    on() {},
  }
  await route.handler(req, res)
  // 等微任务（handler 可能是 async）
  await new Promise((r) => setTimeout(r, 20))
  const raw = chunks.join('')
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { /* ignore */ }
  return { status: res.status, raw, json: parsed }
}

test('B. 装配层：fake ctx 下启动 → 配对码落盘 → 路由注册 → /state 返回结构', async () => {
  const dir = tmp()
  const ctx = makeCtx()
  try {
    await pluginApply(ctx, {
      dataDir: dir,
      routePrefix: '/dsh-cs',
      ports: { douyin: 0, xianyu: 0 },
      platforms: ['douyin'],
      migrateFrom: false,
    })
    // 配对码必须持久化（扩展重启后不换码）
    assert.equal(existsSync(join(dir, 'pair-code-douyin.txt')), true, '配对码文件应存在')
    assert.ok(readFileSync(join(dir, 'pair-code-douyin.txt'), 'utf8').trim().length >= 8)

    // 路由必须挂上（client 半靠这些路径）
    const paths = ctx.webServer.routes.map((r) => r.path)
    for (const p of ['/dsh-cs/state', '/dsh-cs/thread', '/dsh-cs/send', '/dsh-cs/rename', '/dsh-cs/ai-settings', '/dsh-cs/refresh-event']) {
      assert.equal(paths.includes(p), true, `缺少路由 ${p}`)
    }

    // /state 契约（client 半依赖 accounts/threads/ok 字段）
    const state = await callRoute(ctx, '/dsh-cs/state')
    assert.equal(state.status, 200)
    assert.equal(state.json?.ok, true)
    assert.ok(Array.isArray(state.json.accounts))
    assert.ok(Array.isArray(state.json.threads))
    assert.ok(state.json.platformLabels === undefined || typeof state.json.platformLabels === 'object')

    // AI 设置：必须逐平台返回知识库诊断（否则面板会把「抖音未配置」误报成「闲鱼不能用」）
    const ai = await callRoute(ctx, '/dsh-cs/ai-settings')
    assert.equal(ai.status, 200)
    assert.equal(ai.json?.ok, true)
    assert.ok(Array.isArray(ai.json.platformKbs) && ai.json.platformKbs.length >= 1, '应返回 platformKbs')
    const kbEntry = ai.json.platformKbs.find((p) => p.platform === 'douyin')
    assert.ok(kbEntry, 'platformKbs 应包含 douyin')
    assert.equal(typeof kbEntry.kb, 'object')
    assert.equal(typeof kbEntry.label, 'string')

    // 越权 Origin 必须被拒（自有路由没有全局鉴权，必须自己把住）
    const denied = await callRoute(ctx, '/dsh-cs/state', { headers: { origin: 'http://evil.example' } })
    assert.equal(denied.status, 401)

    await ctx.disposeAll()
    // teardown：装配层的 flush effect 是 `void store.save()`（不 await），
    // 这里等它落完再删目录 —— 否则挂起的 mkdir/rename 会在 rmSync 之后报 ENOENT。
    await new Promise((r) => setTimeout(r, 150))
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
