/**
 * 话术沉淀（playbook）+ 买家昵称富化 契约测试（离线）。
 *
 * 运行：node --test --experimental-test-isolation=none test/playbook.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPlaybookOnce, createPlaybookTicker } from '../lib/platforms/xianyu/playbook.js'
import { createXianyuAdapter } from '../lib/platforms/xianyu/adapter.js'
import { Store } from '../lib/kernel/store.js'

const noop = { info() {}, warn() {}, error() {}, debug() {} }
const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-cs-playbook-'))

function fakeCustomerStore(turnsByBuyer) {
  return {
    async list() { return Object.keys(turnsByBuyer).map((buyerId) => ({ buyerId, turnCount: turnsByBuyer[buyerId].length })) },
    async get(_a, buyerId) { return turnsByBuyer[buyerId] ? { buyerId, turns: turnsByBuyer[buyerId] } : null },
  }
}

const mkTurns = (n, buyerMsg = '这个怎么卖') => Array.from({ length: n }, (_, i) => ({ t: i, buyerMsg: `${buyerMsg}${i}`, reply: `亲，${i} 元~` }))

function llmReturning(obj) {
  return async () => (typeof obj === 'string' ? obj : JSON.stringify(obj))
}

test('P1 话术沉淀：增量阈值 → append/refine 落盘 + 备份 + 状态推进', async () => {
  const dir = tmp()
  const knowledgeDir = join(dir, 'knowledge')
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(join(knowledgeDir, '话术.md'), '# 话术\n\n亲，在的~\n\n旧打法：一律不议价。\n', 'utf8')
  const turns = { b1: mkTurns(3), b2: mkTurns(2) }
  const ops = {
    summary: '沉淀议价打法',
    ops: [
      { op: 'append', file: '话术.md', text: '买家问能不能便宜 → 先给赠品，不直接降价。', why: '高频' },
      { op: 'refine', file: '话术.md', find: '旧打法：一律不议价。', replace: '旧打法：不直接降价，先给赠品。' },
      { op: 'noop' },
    ],
  }
  try {
    const state = { perBuyer: { b1: 0, b2: 0 } }
    const r = await runPlaybookOnce({
      accountId: 'unb-1',
      customerStore: fakeCustomerStore(turns),
      knowledgeDir,
      callModel: llmReturning(ops),
      minNewTurns: 3,
      state,
      log: noop,
    })
    assert.equal(r.ok, true)
    assert.equal(r.processed, 5, '新增轮次 = 3+2')
    assert.equal(r.applied, 2, 'append + refine 各一条')
    const text = readFileSync(join(knowledgeDir, '话术.md'), 'utf8')
    assert.match(text, /先给赠品，不直接降价/)
    assert.match(text, /不直接降价，先给赠品/)
    assert.equal(text.includes('旧打法：一律不议价。'), false, 'refine 应替换旧片段')
    const backups = readdirSync(join(knowledgeDir, '.backups'))
    assert.ok(backups.length >= 1, '改动前应备份')
    assert.equal(r.perBuyer.b1, 3)
    assert.equal(r.perBuyer.b2, 2)

    // 第二次跑：没有新增轮次 → 阈值跳过，不再调模型
    let called = 0
    const r2 = await runPlaybookOnce({
      accountId: 'unb-1',
      customerStore: fakeCustomerStore(turns),
      knowledgeDir,
      callModel: async () => { called++; return JSON.stringify(ops) },
      minNewTurns: 3,
      state: { perBuyer: r.perBuyer },
      log: noop,
    })
    assert.equal(r2.skipped, 'threshold')
    assert.equal(called, 0, '无新增时不得调用模型')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P2 话术沉淀：非法 JSON / 非法文件名 / 不唯一片段 都要安全跳过', async () => {
  const dir = tmp()
  const knowledgeDir = join(dir, 'knowledge')
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(join(knowledgeDir, '话术.md'), '# 话术\n\n重复片段\n\n重复片段\n', 'utf8')
  const turns = { b1: mkTurns(3) }
  try {
    const badJson = await runPlaybookOnce({
      accountId: 'a', customerStore: fakeCustomerStore(turns), knowledgeDir,
      callModel: async () => '我不是 JSON', minNewTurns: 1, state: { perBuyer: {} }, log: noop,
    })
    assert.equal(badJson.ok, false)
    assert.match(badJson.error, /JSON/)

    const evil = await runPlaybookOnce({
      accountId: 'a', customerStore: fakeCustomerStore(turns), knowledgeDir,
      callModel: llmReturning({ ops: [{ op: 'append', file: '../../evil.md', text: 'x' }] }),
      minNewTurns: 1, state: { perBuyer: {} }, log: noop,
    })
    assert.equal(evil.ok, true, '流程成功，但非法文件被丢弃')
    assert.equal(evil.applied, 0)
    assert.equal(existsSync(join(dir, 'evil.md')), false, '不得写出 knowledge 目录')

    const dupRefine = await runPlaybookOnce({
      accountId: 'a', customerStore: fakeCustomerStore(turns), knowledgeDir,
      callModel: llmReturning({ ops: [{ op: 'refine', file: '话术.md', find: '重复片段', replace: '改过了' }] }),
      minNewTurns: 1, state: { perBuyer: {} }, log: noop,
    })
    assert.equal(dupRefine.ok, true)
    assert.equal(dupRefine.applied, 0, '不唯一片段不得替换')
    assert.match(readFileSync(join(knowledgeDir, '话术.md'), 'utf8'), /重复片段/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P3 定时器：start/stop 幂等，runOnce 可手动触发', async () => {
  let runs = 0
  const ticker = createPlaybookTicker({ intervalMinutes: 1, initialDelayMs: 60_000, runOnce: async () => { runs++ }, log: noop })
  assert.equal(ticker.running, false)
  ticker.start()
  ticker.start() // 幂等
  assert.equal(ticker.running, true)
  await ticker.runOnce()
  assert.equal(runs, 1)
  await ticker.stop()
  assert.equal(ticker.running, false)
  await ticker.runOnce()
  assert.equal(runs, 1, 'stop 后 runOnce 不再执行')
})

test('P4 买家昵称富化：user_info 事件 → 通讯录 → enrichBuyer 返回昵称', async () => {
  const dir = tmp()
  try {
    const store = new Store({ dataDir: dir, sessionSlug: 'xy', defaultPlatform: 'xianyu', label: 't', slugByPlatform: { xianyu: 'xy' } })
    await store.init()
    const adapter = createXianyuAdapter({ store, log: noop, dataDir: dir })
    const events = adapter.parseInbound({
      type: 'user_info',
      platform: 'xianyu',
      account_id: 'unb-1',
      users: [{ uid: 'buyer-9', nickname: '小美', avatar_url: 'https://example.invalid/a.png' }],
    }, { store })
    assert.ok(Array.isArray(events) && events.length >= 1, 'user_info 应产出事件')
    // 走内核同一套事件应用（这里直接模拟 account 事件落库）
    for (const ev of events) {
      if (ev.kind === 'account' && Array.isArray(ev.contacts)) {
        for (const c of ev.contacts) store.upsertContact(c)
      }
    }
    assert.equal(store.resolveName('buyer-9'), '小美')
    const buyer = adapter.enrichBuyer({ buyerUid: 'buyer-9', platform: 'xianyu' }, { store })
    assert.equal(buyer.name, '小美')
    assert.equal(buyer.nameKnown, true)
    assert.equal(buyer.avatar, 'https://example.invalid/a.png')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
