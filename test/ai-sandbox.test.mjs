/**
 * AI 沙箱测试（面板「AI 测试」弹窗的后端）：真实走规则/资料/模型/红线，但不发送、不落库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../lib/kernel/store.js'
import { createRuntime } from '../lib/kernel/runtime.js'
import { createLibrary } from '../lib/kernel/library.js'
import { createXianyuAdapter } from '../lib/platforms/xianyu/adapter.js'

const noop = { info() {}, warn() {}, error() {}, debug() {} }
const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-cs-sandbox-'))

function fakeCtx(reply) {
  const queue = Array.isArray(reply) ? reply.slice() : null
  let calls = 0
  return {
    get calls() { return calls },
    inject(keys, cb) {
      if (keys.includes('llm')) {
        cb({
          llm: {
            async *stream() {
              calls++
              const text = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : reply
              yield { type: 'text-delta', text }
            },
          },
        })
      }
      if (keys.includes('agentDefaultModel')) {
        cb({ agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) } })
      }
    },
  }
}

async function setup(reply) {
  const dir = tmp()
  const lib = createLibrary({ dataDir: dir, log: noop })
  const p = await lib.createProject({ id: 'demo-shop', name: '示例店铺' })
  await lib.writeDoc(p.id, '店规.md', '# 店规\n普通烫免费；特殊烫免费；毛巾烫 5 元。')
  await lib.writeDoc(p.id, 'AGENTS.md', '# 规则\n退款必须转人工。')
  await lib.bindAccount(p.id, { platform: 'xianyu', accountId: 'A' })

  const store = new Store({ dataDir: dir, sessionSlug: 'xy', defaultPlatform: 'xianyu', label: 'sandbox', slugByPlatform: { xianyu: 'xy' } })
  await store.init()
  store.upsertAccount({ id: 'A', platform: 'xianyu', nickname: '测试闲鱼号', connected: true })

  const adapter = createXianyuAdapter({ store, log: noop, dataDir: dir, library: lib })
  const runtime = createRuntime({ ctx: fakeCtx(reply), config: {}, store, adapters: [adapter], bridges: [], log: noop })
  return { dir, lib, store, runtime, teardown: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
}

test('S1 沙箱：走真实规则+项目资料，回复正常且不落会话/不写审计', async () => {
  const s = await setup('{"reply":"免费的～镜像烫要开拼前说哈","need_human":false,"reason":""}')
  try {
    const r = await s.runtime.aiTest({ question: '特殊烫免费吗？', platform: 'xianyu', accountId: 'A' })
    assert.equal(r.ok, true)
    assert.match(String(r.reply), /免费/)
    assert.equal(r.project && r.project.name, '示例店铺')
    assert.ok(r.kbChars > 0, '应带上项目资料/规则')
    assert.equal(r.escalate, false)
    // 关键：不发送到平台、不创建会话、不写审计
    assert.equal(s.store.getThreads().length, 0, '沙箱不得创建会话')
    assert.equal(s.runtime.aiLog(20).length, 0, '沙箱不得写 AI 审计')
  } finally { s.teardown() }
})

test('S2 沙箱：多轮对话（带历史）也不落库；模型判定转人工时 escalate=true', async () => {
  const s = await setup('{"reply":"我帮您问一下店员哈，稍等","need_human":true,"reason":"涉及退款"}')
  try {
    const r1 = await s.runtime.aiTest({ question: '我要退款', platform: 'xianyu', accountId: 'A' })
    assert.equal(r1.escalate, true, '应判定转人工')
    assert.equal(r1.replies.length, 0, '转人工不产生发送')
    assert.match(String(r1.reply), /问一下店员/)

    const r2 = await s.runtime.aiTest({
      question: '那还能退吗？',
      platform: 'xianyu',
      accountId: 'A',
      history: [{ direction: 'in', text: '我要退款' }, { direction: 'out', text: r1.reply }],
    })
    assert.equal(r2.escalate, true)
    assert.equal(s.store.getThreads().length, 0, '多轮沙箱也不得创建会话')
    assert.equal(s.runtime.aiLog(20).length, 0)
  } finally { s.teardown() }
})

test('S3 通用兜底：模型误判转人工 → 带「复核」提示重答一次（有依据必须答）', async () => {
  const s = await setup([
    '{"reply":"我帮您问一下店员哈～","need_human":true,"reason":"不确定"}',
    '{"reply":"单人1小时 9.9 元，3 小时 24.9 元哈～","need_human":false,"reason":""}',
  ])
  try {
    const r = await s.runtime.aiTest({ question: '有什么套餐', platform: 'xianyu', accountId: 'A' })
    assert.equal(r.escalate, false, '复核后应正常回答，不再转人工')
    assert.match(String(r.reply), /9\.9/)
    assert.equal(s.store.getThreads().length, 0)
    assert.equal(s.runtime.aiLog(20).length, 0)
  } finally { s.teardown() }
})
