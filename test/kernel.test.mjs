/**
 * 内核单元测试：config / pairing / migrate / store / bridge 非网络部分。
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig, specOf, DOUYIN_SPEC, XIANYU_SPEC } from '../lib/kernel/config.js'
import { resolvePairCode } from '../lib/kernel/pairing.js'
import { migrateLegacyState } from '../lib/kernel/migrate.js'
import { Store } from '../lib/kernel/store.js'
import { CsBridge } from '../lib/kernel/bridge.js'
import { planReply, parseModelOutput, validateReply } from '../lib/kernel/ai.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-cs-test-'))

test('config: 默认值来自 spec，env 可覆盖端口/目录', () => {
  const a = resolveConfig({}, {})
  assert.equal(a.dataDir.endsWith('.dsh\\dsh-cs') || a.dataDir.endsWith('.dsh/dsh-cs'), true)
  assert.equal(a.ports.douyin, DOUYIN_SPEC.defaultPort)
  assert.equal(a.ports.xianyu, XIANYU_SPEC.defaultPort)
  assert.equal(a.routePrefix, '/dsh-cs')
  assert.deepEqual(a.platforms, ['douyin', 'xianyu'])

  const b = resolveConfig({ ports: { douyin: 9001 } }, { DOUYIN_WS_PORT: '9002', XIANYU_WS_PORT: '9003' })
  assert.equal(b.ports.douyin, 9002, 'env 优先于 config')
  assert.equal(b.ports.xianyu, 9003)
  assert.equal(b.host, '127.0.0.1')
})

test('config: specOf 精确名优先，handles 兜底（laike 由抖音适配器接管）', () => {
  assert.equal(specOf('douyin-laike').name, 'douyin-laike')
  assert.equal(specOf('douyin-laike').capabilities.sendMode, 'dom')
  assert.equal(specOf('douyin').handles.includes('douyin-laike'), true)
  assert.equal(specOf('xianyu').sessionSlug, 'xy')
  assert.equal(specOf('unknown-platform'), null)
})

test('pairing: 首次生成并落盘，第二次读回同一码；env 优先', () => {
  const dir = tmp()
  try {
    const a = resolvePairCode({ dataDir: dir, platform: 'douyin' })
    assert.equal(a.source, 'new')
    assert.equal(a.code.length, 16)
    const b = resolvePairCode({ dataDir: dir, platform: 'douyin' })
    assert.equal(b.source, 'file')
    assert.equal(b.code, a.code)
    const c = resolvePairCode({ dataDir: dir, platform: 'douyin', envCode: 'ENVCODE' })
    assert.equal(c.code, 'ENVCODE')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pairing: 旧插件配对码只读继承，且不写旧目录', () => {
  const legacy = tmp()
  const dir = join(tmp(), 'new')
  try {
    writeFileSync(join(legacy, 'pair-code.txt'), 'legacy-code-1234', 'utf8')
    const before = readFileSync(join(legacy, 'pair-code.txt'), 'utf8')
    const r = resolvePairCode({ dataDir: dir, platform: 'douyin', legacyDir: legacy })
    assert.equal(r.code, 'legacy-code-1234')
    assert.equal(r.source, 'legacy')
    assert.equal(readFileSync(join(legacy, 'pair-code.txt'), 'utf8'), before, '旧目录不得被修改')
  } finally { rmSync(legacy, { recursive: true, force: true }) }
})

test('migrate: 只读复制旧库，目标已存在则不迁移，旧库不变', async () => {
  const legacy = tmp()
  const dir = join(tmp(), 'new')
  const oldState = { accounts: { a: { id: 'a', platform: 'douyin' } }, threads: { 'dy:a:c': { id: 'dy:a:c' } } }
  writeFileSync(join(legacy, 'state.json'), JSON.stringify(oldState), 'utf8')
  try {
    const r1 = await migrateLegacyState({ dataDir: dir, legacyDir: legacy })
    assert.equal(r1.migrated, true)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), oldState)
    assert.deepEqual(JSON.parse(readFileSync(join(legacy, 'state.json'), 'utf8')), oldState)

    const r2 = await migrateLegacyState({ dataDir: dir, legacyDir: legacy })
    assert.equal(r2.migrated, false)
    assert.equal(r2.reason, 'target-exists')
  } finally { rmSync(legacy, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
})

test('store: 会话 key 用平台 slug，入站累加未读，落盘可读回', async () => {
  const dir = tmp()
  try {
    const s = new Store({ dataDir: dir, sessionSlug: 'xy', defaultPlatform: 'xianyu', label: 'test' })
    await s.init()
    const t = s.recordInbound({ accountId: 'acct', conversationId: 'chat1', text: '在吗' })
    assert.equal(t.id, 'xy:acct:chat1')
    assert.equal(t.platform, 'xianyu')
    assert.equal(t.unread, 1)
    s.recordInbound({ accountId: 'acct', conversationId: 'chat1', text: '多少钱' })
    assert.equal(s.getThread('xy:acct:chat1').unread, 2)
    await s.save()
    const s2 = new Store({ dataDir: dir, sessionSlug: 'xy', defaultPlatform: 'xianyu', label: 'test' })
    await s2.init()
    assert.equal(s2.getThread('xy:acct:chat1').unread, 2)
    assert.equal(s2.getMessages('xy:acct:chat1').length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('store: 轮询同步按服务端消息 id 幂等（不重复堆积/未读不暴涨）', async () => {
  const dir = tmp()
  try {
    const s = new Store({ dataDir: dir, sessionSlug: 'dl', defaultPlatform: 'douyin-laike', label: 'test' })
    await s.init()
    const messages = [
      { id: 'm1', text: '你好', direction: 'in', at: 1 },
      { id: 'm2', text: '在吗', direction: 'in', at: 2 },
    ]
    s.syncThreadMessages?.({ accountId: 'a', conversationId: 'c1', unread: 0, messages })
    const n1 = s.getMessages('dl:a:c1').length
    s.syncThreadMessages?.({ accountId: 'a', conversationId: 'c1', unread: 0, messages })
    assert.equal(s.getMessages('dl:a:c1').length, n1, '重复轮询不得重复入库')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bridge: 配对码集合与平台归属（无需真实网络）', () => {
  const b = new CsBridge({ port: 0, pairCode: 'CODE123', defaultPlatform: 'xianyu', label: 'xy' })
  assert.equal(b.platformOf('unknown'), 'xianyu')
  b.addPairCode('EXTRA')
  assert.equal(b._validPairCodes.has('EXTRA'), true)
  b.removePairCode('EXTRA')
  assert.equal(b._validPairCodes.has('EXTRA'), false)
  // 默认码不可被 removePairCode 移除
  b.removePairCode('CODE123')
  assert.equal(b._validPairCodes.has('CODE123'), true)
})

test('ai: 结构化输出解析 + 红线/gate 基本行为（保持与旧插件一致）', () => {
  assert.equal(parseModelOutput('{"reply":"在的","need_human":false}')?.reply, '在的')
  // 非法 JSON 一律转人工（安全侧，绝不把思考过程当回复发出去）
  const bad = parseModelOutput('不是 JSON')
  assert.equal(bad?.needHuman, true)
  assert.equal(typeof bad?.reason, 'string')
  // 空回复被拦
  assert.equal(validateReply('').ok, false)
  // 默认闸门：AI 总开关关 → skip；正常情况 → reply
  assert.equal(planReply({ globalEnabled: false }).action, 'skip')
  assert.equal(planReply({}).action, 'reply')
})
