/**
 * M3 自动交付 + 通知 + 闲鱼话术库 契约测试（离线）。
 *
 * 运行：node --test --experimental-test-isolation=none test/auto-deliver.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAutoDeliver } from '../lib/platforms/xianyu/auto_deliver.js'
import { createNotifier, isUrgeMessage } from '../lib/kernel/notifier.js'
import { createXianyuAdapter } from '../lib/platforms/xianyu/adapter.js'

const noop = { info() {}, warn() {}, error() {}, debug() {} }
const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-cs-ai-'))

function makeDeps(overrides = {}) {
  const calls = { send: [], outbound: [], handled: [], notify: [] }
  const adapter = {
    async send(thread, text) {
      calls.send.push({ thread, text })
      return overrides.sendResult || { ok: true, server_message_id: 'srv-d1' }
    },
  }
  const store = {
    recordOutbound: (...args) => calls.outbound.push(args),
    threadId: (a, c, p) => `${p === 'xianyu' ? 'xy' : 'dy'}:${a}:${c}`,
    noteAiHandled: (...args) => calls.handled.push(args),
  }
  const productStore = {
    async getAutoDelivery(accountId, itemId) {
      if (overrides.auto) return overrides.auto
      return { enabled: true, content: '网盘链接：https://example.invalid/pan' }
    },
  }
  return { calls, deps: { adapter, store, productStore, log: noop, notify: (e, p) => calls.notify.push({ e, p }) } }
}

const triggerEvent = (extra = {}) => ({
  kind: 'message',
  platform: 'xianyu',
  accountId: 'unb-1',
  conversationId: 'chat-1',
  buyerUid: 'buyer-1',
  itemId: 'item-1',
  xianyuKind: 'delivery_trigger',
  serverMessageId: 'mid-1',
  text: '[我已付款，等待你发货]',
  ...extra,
})

test('A1 自动交付：付款事件 → 立即发送 + 落库 + 标 aiHandled + 通知', async () => {
  const { calls, deps } = makeDeps()
  const handler = createAutoDeliver(deps)
  await handler(triggerEvent())
  assert.equal(calls.send.length, 1, '应发送一次')
  assert.deepEqual(calls.send[0].thread, { platform: 'xianyu', accountId: 'unb-1', conversationId: 'chat-1', buyerUid: 'buyer-1', buyerName: '' })
  assert.match(calls.send[0].text, /网盘链接/)
  assert.equal(calls.outbound.length, 1, '出站消息应落库')
  assert.equal(calls.outbound[0][4], 'ai', '标记 by=ai（不是人工）')
  assert.equal(calls.outbound[0][5], 'xianyu')
  assert.equal(calls.handled.length, 1, '触发消息应标 aiHandled，防 AI 重发')
  assert.deepEqual(calls.handled[0], ['xy:unb-1:chat-1', 'mid-1'])
  assert.equal(calls.notify.length, 1, '应发出通知')
})

test('A2 自动交付：未开启/无内容/非付款事件/其他平台 → 不发', async () => {
  // 未开启
  const off = makeDeps({ auto: { enabled: false, content: 'x' } })
  await createAutoDeliver(off.deps)(triggerEvent())
  assert.equal(off.calls.send.length, 0)

  // 无内容
  const empty = makeDeps({ auto: { enabled: true, content: '   ' } })
  await createAutoDeliver(empty.deps)(triggerEvent())
  assert.equal(empty.calls.send.length, 0)

  // 非付费触发
  const chat = makeDeps()
  await createAutoDeliver(chat.deps)(triggerEvent({ xianyuKind: 'chat' }))
  assert.equal(chat.calls.send.length, 0)

  // 其他平台
  const other = makeDeps()
  await createAutoDeliver(other.deps)(triggerEvent({ platform: 'douyin' }))
  assert.equal(other.calls.send.length, 0)
})

test('A3 自动交付：发送失败只记日志，不落库/不抛异常', async () => {
  const { calls, deps } = makeDeps({ sendResult: { ok: false, error: '扩展未接入' } })
  const handler = createAutoDeliver(deps)
  await assert.doesNotReject(() => handler(triggerEvent()))
  assert.equal(calls.send.length, 1)
  assert.equal(calls.outbound.length, 0, '失败不得记成已发')
  assert.equal(calls.handled.length, 0)
})

test('N1 通知：默认关闭；开启后 POST JSON（事件/时间/载荷）', async () => {
  const off = createNotifier({ log: noop })
  assert.equal((await off.notify('order', {})).skipped, 'disabled')

  const posts = []
  const fetchImpl = async (url, init) => { posts.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200 } }
  const n = createNotifier({ config: { enabled: true, webhookUrl: 'https://example.invalid/hook', throttleSeconds: 0 }, fetchImpl, log: noop })
  const r = await n.notify('order', { accountId: 'a1', buyerId: 'b1', itemId: 'i1' })
  assert.equal(r.ok, true)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, 'https://example.invalid/hook')
  assert.equal(posts[0].body.event, 'order')
  assert.equal(posts[0].body.buyerId, 'b1')
  assert.equal(typeof posts[0].body.at, 'string')
  assert.match(posts[0].init.headers['content-type'], /application\/json/)
})

test('N2 通知：事件过滤 / 节流 / webhook 失败不抛', async () => {
  const posts = []
  const fetchImpl = async (_url, init) => { posts.push(JSON.parse(init.body)); return { ok: false, status: 500 } }
  const n = createNotifier({ config: { enabled: true, webhookUrl: 'https://x', events: ['risk'], throttleSeconds: 60 }, fetchImpl, log: noop })
  assert.equal((await n.notify('order', { accountId: 'a', buyerId: 'b' })).skipped, 'event-filtered')
  const r1 = await n.notify('risk', { accountId: 'a', buyerId: 'b' })
  assert.equal(r1.ok, false, 'HTTP 500 → 非 ok，但不抛')
  const r2 = await n.notify('risk', { accountId: 'a', buyerId: 'b' })
  assert.equal(r2.skipped, 'throttled', '同事件同买家应被节流')
  assert.equal(posts.length, 1)
  // 不同买家不节流
  const r3 = await n.notify('risk', { accountId: 'a', buyerId: 'b2' })
  assert.notEqual(r3.skipped, 'throttled')
})

test('N3 催货关键词识别（宁少报不刷屏）', () => {
  assert.equal(isUrgeMessage('什么时候发货？'), true)
  assert.equal(isUrgeMessage('在吗'), true)
  assert.equal(isUrgeMessage('这个多少钱'), false)
  assert.equal(isUrgeMessage(''), false)
})

test('K1 闲鱼话术库：读 knowledge/*.md，空库给明确原因；诊断同步', async () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(join(dir, 'knowledge', '店规.md'), '# 店规\n不议价，满 50 包邮。', 'utf8')
    writeFileSync(join(dir, 'knowledge', '话术.md'), '# 话术\n亲，在的~', 'utf8')
    const adapter = createXianyuAdapter({ store: { dataDir: dir, resolveName: () => '' }, dataDir: dir, log: noop })
    const ctxInfo = await adapter.aiContext({ force: true })
    assert.ok(ctxInfo.kb.includes('不议价'), '知识库应包含店规')
    assert.ok(ctxInfo.kb.includes('亲，在的'), '知识库应包含话术')
    assert.equal(ctxInfo.kbError, '')
    assert.ok(ctxInfo.kbDir.endsWith('knowledge'))
    const diag = await adapter.aiDiagnostics({ force: true })
    assert.ok(diag.kb.chars > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }

  // 空库：明确原因（内核会转人工，不误发）
  const emptyDir = tmp()
  try {
    const adapter = createXianyuAdapter({ store: { dataDir: emptyDir, resolveName: () => '' }, dataDir: emptyDir, log: noop })
    const info = await adapter.aiContext({ force: true })
    assert.equal(info.kb, '')
    assert.match(info.kbError, /未找到话术库/)
  } finally { rmSync(emptyDir, { recursive: true, force: true }) }
})
