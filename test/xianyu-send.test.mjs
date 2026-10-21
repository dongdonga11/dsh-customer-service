/**
 * 闲鱼文本发送通道契约（M2 修复回归）：
 * `send_text` 无 cmd_result 回执 → 必须走 fire-and-forget 的 bridge.sendCommand，
 * 绝不能走 sendCommandAck（否则每条消息白等 25s 超时、面板误报失败）。
 *
 * 运行：node --test --experimental-test-isolation=none test/xianyu-send.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../lib/kernel/store.js'
import { createRuntime } from '../lib/kernel/runtime.js'
import { createXianyuAdapter } from '../lib/platforms/xianyu/adapter.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-cs-xys-'))
const noop = { info() {}, warn() {}, error() {}, debug() {} }

test('send_text 走 sendCommand（fire-and-forget），不调用 sendCommandAck', async () => {
  const dir = tmp()
  try {
    const store = new Store({ dataDir: dir, label: 't', slugByPlatform: { xianyu: 'xy', douyin: 'dy' } })
    await store.init()
    const adapter = createXianyuAdapter({ store, log: noop, dataDir: dir })

    const calls = { sendCommand: [], ack: [] }
    const bridge = {
      defaultPlatform: 'xianyu',
      hasAccount: () => true,
      platformOf: () => 'xianyu',
      sendCommand(cmd, acct) { calls.sendCommand.push({ cmd, acct }); return true },
      sendCommandAck(cmd, acct) { calls.ack.push({ cmd, acct }); return new Promise(() => {}) }, // 不应被调用（会挂起）
    }
    const runtime = createRuntime({ ctx: null, config: {}, store, adapters: [adapter], bridges: [bridge], log: noop })

    const thread = store.recordInbound({
      accountId: 'unb-1',
      platform: 'xianyu',
      conversationId: '123456',
      buyerUid: 'buyer-9',
      text: '在吗',
    })

    const res = await runtime.sendHuman(thread.id, '在的，亲')
    assert.equal(res.ok, true, `发送应成功（实际：${JSON.stringify(res)}）`)
    assert.equal(calls.sendCommand.length, 1, '文本必须走 sendCommand')
    assert.equal(calls.ack.length, 0, '文本不得等 cmd_result（无回执会 25s 超时）')
    assert.deepEqual(calls.sendCommand[0].cmd, {
      type: 'send_text',
      chat_id: '123456',
      buyer_id: 'buyer-9',
      seller_id: 'unb-1',
      text: '在的，亲',
    })
    // 人工回复落库（出站消息）+ 自动转人工由 runtime 处理
    const msgs = store.getMessages(thread.id)
    assert.ok(msgs.some((m) => m.direction === 'out' && m.text === '在的，亲'), '人工回复应落库')
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})

test('桥未接入（sendCommand 返回 false）→ 明确失败，不静默成功', async () => {
  const dir = tmp()
  try {
    const store = new Store({ dataDir: dir, label: 't', slugByPlatform: { xianyu: 'xy' } })
    await store.init()
    const adapter = createXianyuAdapter({ store, log: noop, dataDir: dir })
    const bridge = { defaultPlatform: 'xianyu', hasAccount: () => false, platformOf: () => 'xianyu', sendCommand: () => false }
    const runtime = createRuntime({ ctx: null, config: {}, store, adapters: [adapter], bridges: [bridge], log: noop })
    const thread = store.recordInbound({ accountId: 'unb-1', platform: 'xianyu', conversationId: 'c1', buyerUid: 'b1', text: 'x' })
    const res = await runtime.sendHuman(thread.id, '回复')
    assert.equal(res.ok, false)
    assert.match(String(res.error || ''), /失败|不|不可用|未接入/, '失败必须有可读原因')
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})
