/**
 * 资料库内核测试（离线）。
 * 运行：node --test --experimental-test-isolation=none test/library.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLibrary, sanitizeRelPath, tokenize } from '../lib/kernel/library.js'
import { createXianyuAdapter } from '../lib/platforms/xianyu/adapter.js'
import { createDouyinAdapter } from '../lib/platforms/douyin/adapter.js'

const noop = { info() {}, warn() {}, error() {}, debug() {} }
const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-cs-lib-'))

test('L1 项目 CRUD + 文件树 + 路径穿越防护', async () => {
  const dir = tmp()
  try {
    const lib = createLibrary({ dataDir: dir, log: noop })
    const p = await lib.createProject({ id: 'demo-shop', name: '示例店铺', description: '示例店铺 DIY' })
    assert.equal(p.id, 'demo-shop')
    assert.equal((await lib.listProjects()).length, 1)

    await lib.writeDoc(p.id, '店规速查.md', '# 店规\n不议价')
    await lib.writeDoc(p.id, '话术/接待.md', '# 接待\n亲，在的~')
    const t = await lib.tree(p.id)
    assert.equal(t.tree.length, 2)
    const dirNode = t.tree.find((n) => n.type === 'dir')
    assert.equal(dirNode.name, '话术')
    assert.equal(dirNode.children[0].path, '话术/接待.md')

    await assert.rejects(() => lib.writeDoc(p.id, '../evil.md', 'x'), /跳出|绝对/)
    await assert.rejects(() => lib.writeDoc(p.id, 'C:/evil.md', 'x'), /绝对/)
    assert.equal(existsSync(join(dir, 'evil.md')), false)

    const doc = await lib.readDoc(p.id, '店规速查.md')
    assert.match(doc.text, /不议价/)
    assert.equal(doc.kind, 'text')

    // 改/删
    await lib.movePath(p.id, '店规速查.md', '规则/店规.md')
    assert.equal((await lib.readDoc(p.id, '规则/店规.md')).kind, 'text')
    await lib.deletePath(p.id, '规则/店规.md')
    await assert.rejects(() => lib.readDoc(p.id, '规则/店规.md'))

    const r = await lib.deleteProject(p.id)
    assert.ok(r.trash.includes('.trash'))
    assert.equal(existsSync(join(dir, 'library', '.trash')), true)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})

test('L2 账号绑定：一个账号只属一个项目（改绑会从旧项目移除）', async () => {
  const dir = tmp()
  try {
    const lib = createLibrary({ dataDir: dir, log: noop })
    const a = await lib.createProject({ name: 'demo-shop' })
    const b = await lib.createProject({ name: 'gaobao' })
    await lib.bindAccount(a.id, { platform: 'xianyu', accountId: '100000001', label: '示例店铺客服' })
    assert.equal((await lib.projectForAccount('xianyu', '100000001')).id, a.id)

    await lib.bindAccount(b.id, { platform: 'xianyu', accountId: '100000001' })
    const a2 = await lib.getProject(a.id)
    const b2 = await lib.getProject(b.id)
    assert.equal(a2.accounts.length, 0, '旧项目应解绑')
    assert.equal(b2.accounts.length, 1)
    assert.equal((await lib.projectForAccount('xianyu', '100000001')).id, b.id)

    // 不同平台同 account id 是两条绑定
    await lib.bindAccount(a.id, { platform: 'douyin', accountId: '100000001' })
    assert.equal((await lib.projectForAccount('douyin', '100000001')).id, a.id)
    assert.equal((await lib.projectForAccount('xianyu', '100000001')).id, b.id)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})

test('L3 检索与上下文：两个项目资料互不串；pinned 必读优先；无命中返回空', async () => {
  const dir = tmp()
  try {
    const lib = createLibrary({ dataDir: dir, log: noop })
    const pin = await lib.createProject({ name: 'demo-shop' })
    const high = await lib.createProject({ name: 'gaobao' })
    await lib.writeDoc(pin.id, '店规.md', '# 店规\n示例店铺店不议价，满 50 包邮。\n## 发货\n48 小时内发出。')
    await lib.writeDoc(pin.id, '话术.md', '# 话术\n亲，在的~ 示例店铺材料包邮。')
    await lib.writeDoc(high.id, '高考志愿.md', '# 高考志愿\n高报服务：冲稳保三档，一对一。')
    await lib.updateProject(pin.id, { pinned: ['店规.md'] })
    await lib.bindAccount(pin.id, { platform: 'xianyu', accountId: 'A' })
    await lib.bindAccount(high.id, { platform: 'xianyu', accountId: 'B' })

    const c1 = await lib.contextForAccount({ platform: 'xianyu', accountId: 'A', query: '包邮吗' })
    assert.match(c1.kb, /必读：店规\.md/)
    assert.match(c1.kb, /满 50 包邮/)
    assert.ok(c1.citations.some((x) => x.path === '店规.md'))
    // 不应出现高报项目内容
    assert.equal(c1.kb.includes('高考志愿'), false)

    const c2 = await lib.contextForAccount({ platform: 'xianyu', accountId: 'A', query: '高考 志愿 怎么填' })
    assert.equal(c2.kb.includes('高考志愿'), false, '跨项目检索不得串料')

    // 命中
    const c3 = await lib.contextForAccount({ platform: 'xianyu', accountId: 'A', query: '发货 多久' })
    assert.match(c3.kb, /48 小时内发出/)

    // 未绑定账号
    const c4 = await lib.contextForAccount({ platform: 'xianyu', accountId: 'NOPE', query: '包邮' })
    assert.equal(c4.kb, '')
    assert.match(c4.error, /尚未分配项目/)

    // 无命中且无 pinned → 空 kb（内核会转人工）
    await lib.updateProject(pin.id, { pinned: [] })
    const c5 = await lib.buildContext(pin.id, '完全不相关的词 zzz')
    assert.equal(c5.kb, '')
    assert.match(c5.error, /没有命中/)

    // 索引可重建
    const idx = await lib.buildIndex(pin.id)
    assert.ok(Array.isArray(idx.chunks) && idx.chunks.length > 0)
    assert.ok(idx.chunks.every((c) => Array.isArray(c.tokens)))
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})

test('L4 迁移：旧全局 knowledge 自动进「默认项目」并绑定现有账号', async () => {
  const dir = tmp()
  const legacy = join(dir, 'legacy-knowledge')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, '店规速查.md'), '# 店规\n旧知识库内容', 'utf8')
  writeFileSync(join(legacy, '话术.md'), '# 话术\n亲，在的~', 'utf8')
  try {
    const lib = createLibrary({ dataDir: join(dir, 'cs'), log: noop })
    const r = await lib.ensureInitial({
      legacyKnowledgeDir: legacy,
      accounts: [{ platform: 'xianyu', accountId: '100000001' }, { platform: 'douyin', accountId: 'default' }],
    })
    assert.equal(r.created, true)
    const p = await lib.getProject('default')
    assert.ok(p, '应创建默认项目')
    assert.equal(p.accounts.length, 2, '两个账号都应绑定到默认项目')
    assert.deepEqual(p.pinned.slice().sort(), ['店规速查.md', '话术.md'].sort())
    const doc = await lib.readDoc(p.id, '店规速查.md')
    assert.match(doc.text, /旧知识库内容/)
    // 旧文件仍在（复制而非移动）
    assert.equal(existsSync(join(legacy, '店规速查.md')), true)
    // 再跑一次：幂等
    const r2 = await lib.ensureInitial({ legacyKnowledgeDir: legacy, accounts: [] })
    assert.equal(r2.created, false)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})

test('L7 规则层：AGENTS.md 每次必带且排在最前；不计入索引重复', async () => {
  const dir = tmp()
  try {
    const lib = createLibrary({ dataDir: dir, log: noop })
    const p = await lib.createProject({ id: 'demo-shop', name: '示例店铺' })
    await lib.writeDoc(p.id, 'AGENTS.md', '# 规则\n## 范围边界\n退款必须转人工。\n## 输出规范\n不承诺店铺。')
    await lib.writeDoc(p.id, '店规.md', '# 店规\n普通烫免费。')
    await lib.updateProject(p.id, { pinned: ['店规.md'] })
    const ctx = await lib.buildContext(p.id, '普通烫多少钱')
    assert.ok(ctx.kb.includes('项目规则（AGENTS.md）'), '上下文应包含规则层')
    const iRules = ctx.kb.indexOf('项目规则（AGENTS.md）')
    const iPinned = ctx.kb.indexOf('必读：店规.md')
    assert.ok(iRules >= 0 && iPinned > iRules, '规则层必须排在必读/检索之前')
    assert.ok(ctx.citations.some((c) => c.path === 'AGENTS.md' && c.score === 200))
    // 规则文件不进索引（避免重复占预算）
    const hits = await lib.search(p.id, '退款 转人工', { limit: 5 })
    assert.equal(hits.some((h) => h.path === 'AGENTS.md'), false, 'AGENTS.md 不应出现在检索结果里')
    // 诊断 helper
    const r = await lib.rules(p.id)
    assert.ok(r.chars > 0)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})

test('L8 资料库及时响应：外部改文件（资源管理器/脚本）后自动重建索引', async () => {
  const dir = tmp()
  try {
    const lib = createLibrary({ dataDir: dir, log: noop })
    const p = await lib.createProject({ id: 'demo-shop', name: '示例店铺' })
    await lib.writeDoc(p.id, '店规.md', '# 店规\n普通烫免费。')
    const first = await lib.search(p.id, '毛巾烫', { limit: 5 })
    assert.equal(first.length, 0, '一开始没有毛巾烫内容')

    // 绕过 library API 直接改文件（模拟用户用资源管理器/脚本更新资料）
    const file = join(dir, 'library', 'projects', 'demo-shop', 'files', '店规.md')
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(file, '# 店规\n普通烫免费。\n毛巾烫 5 元一件。', 'utf8')

    const hits = await lib.search(p.id, '毛巾烫', { limit: 5 })
    assert.ok(hits.length >= 1, '外部修改后搜索应能命中（索引自动重建）')
    assert.match(hits[0].text, /毛巾烫 5 元/)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})

test('L5 工具函数：路径清洗 / 分词', () => {
  assert.equal(sanitizeRelPath('a/b.md'), 'a/b.md')
  assert.equal(sanitizeRelPath('./a.md'), 'a.md')
  assert.throws(() => sanitizeRelPath('../a.md'))
  assert.throws(() => sanitizeRelPath('/a.md'))
  assert.throws(() => sanitizeRelPath(''))
  const t = tokenize('示例材料包邮吗？满50包邮')
  assert.ok(t.includes('包邮'))
  assert.ok(t.includes('示例'))
  assert.equal(t.includes('的'), false)
})

test('L6 适配器接入：闲鱼/抖音 aiContext 都按「账号→项目」取资料，诊断带项目', async () => {
  const dir = tmp()
  try {
    const lib = createLibrary({ dataDir: dir, log: noop })
    const p = await lib.createProject({ id: 'demo-shop', name: '示例店铺' })
    await lib.writeDoc(p.id, '店规.md', '# 店规\n示例店铺满 50 包邮，不议价。\n## 发货\n48 小时内发出。')
    await lib.updateProject(p.id, { pinned: ['店规.md'] })
    await lib.bindAccount(p.id, { platform: 'xianyu', accountId: '100000001' })
    await lib.bindAccount(p.id, { platform: 'douyin', accountId: 'default' })

    const store = { dataDir: dir, resolveName: () => '' }
    const xy = createXianyuAdapter({ store, log: noop, dataDir: dir, library: lib })
    const ctx1 = await xy.aiContext({ accountId: '100000001', platform: 'xianyu', query: '包邮吗' })
    assert.match(ctx1.kb, /满 50 包邮/)
    assert.equal(ctx1.project.name, '示例店铺')
    const diag1 = await xy.aiDiagnostics({ accountId: '100000001', platform: 'xianyu' })
    assert.ok(diag1.kb.chars > 0, '诊断应统计项目字数')
    assert.equal(diag1.project.id, 'demo-shop')

    // 未绑定账号 → 明确「未分配项目」，不退回旧全局 knowledge
    const ctx2 = await xy.aiContext({ accountId: 'nope', platform: 'xianyu', query: '包邮' })
    assert.equal(ctx2.kb, '')
    assert.match(String(ctx2.kbError), /分配项目/)
    const diag2 = await xy.aiDiagnostics({ accountId: 'nope', platform: 'xianyu' })
    assert.match(String(diag2.kb.error), /分配项目/)

    const dy = createDouyinAdapter({ store, log: noop, dataDir: dir, library: lib })
    const ctx3 = await dy.aiContext({ accountId: 'default', platform: 'douyin', query: '包邮吗' })
    assert.match(ctx3.kb, /满 50 包邮/, '抖音应共用同一项目的资料')
    assert.equal(ctx3.project.name, '示例店铺')
    assert.ok(ctx3.realtime && ctx3.realtime.status)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})
