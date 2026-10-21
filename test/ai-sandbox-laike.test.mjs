/**
 * S4：抖音来客（子平台 douyin-laike）账号测试——资料库按「账号自己的平台」绑定。
 * 回归：adapter 名是 douyin，但 account.platform 是 douyin-laike；若用 adapter 名查项目会查不到 → 知识库 0 字。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../lib/kernel/store.js'
import { createRuntime } from '../lib/kernel/runtime.js'
import { createLibrary } from '../lib/kernel/library.js'
import { createDouyinAdapter } from '../lib/platforms/douyin/adapter.js'

const noop = { info() {}, warn() {}, error() {}, debug() {} }

function fakeCtx(reply) {
  return {
    inject(keys, cb) {
      if (keys.includes('llm')) cb({ llm: { async *stream() { yield { type: 'text-delta', text: reply } } } })
      if (keys.includes('agentDefaultModel')) cb({ agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } })
    },
  }
}

test('S4 沙箱：抖音来客账号必须用 douyin-laike 平台查项目（否则知识库 0 字）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cs-sandbox-laike-'))
  try {
    const lib = createLibrary({ dataDir: dir, log: noop })
    const p = await lib.createProject({ id: 'demo-shop', name: '示例店铺' })
    await lib.writeDoc(p.id, '店规.md', '# 店规\n普通烫免费；单人1小时 9.9 元。')
    await lib.bindAccount(p.id, { platform: 'douyin-laike', accountId: 'laike-A' })

    const store = new Store({ dataDir: dir, sessionSlug: 'dy', defaultPlatform: 'douyin', label: 'sandbox', slugByPlatform: { douyin: 'dy' } })
    await store.init()
    store.upsertAccount({ id: 'laike-A', platform: 'douyin-laike', nickname: 'DSH来客', connected: true })

    const adapter = createDouyinAdapter({ store, log: noop, dataDir: dir, library: lib })
    const runtime = createRuntime({ ctx: fakeCtx('{"reply":"单人1小时 9.9 元哈","need_human":false}'), config: {}, store, adapters: [adapter], bridges: [], log: noop })

    const r = await runtime.aiTest({ question: '单人1小时多少钱', platform: 'douyin-laike', accountId: 'laike-A' })
    assert.equal(r.accountPlatform, 'douyin-laike')
    assert.ok(r.kbChars > 0, '知识库应 >0（用账号平台 douyin-laike 查到项目），实际：' + r.kbChars + ' error=' + r.kbError)
    assert.equal(r.project && r.project.name, '示例店铺')
    assert.match(String(r.reply), /9\.9/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})
