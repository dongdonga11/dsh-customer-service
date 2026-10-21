/**
 * 资料库 HTTP 路由测试（离线，不依赖 DSH）。
 * 运行：node --test --experimental-test-isolation=none test/library-routes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLibrary } from '../lib/kernel/library.js'
import { mountRoutes } from '../lib/kernel/routes.js'

const noop = { info() {}, warn() {}, error() {}, debug() {} }
const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-cs-lib-http-'))

const mkRes = () => ({
  status: 0, body: '',
  writeHead(s) { this.status = s },
  write(x) { this.body += x },
  end(x) { if (x) this.body += x },
})
const mkReq = (method, url, body) => {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { origin: 'http://127.0.0.1:1' }
  if (body !== undefined) {
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    }, 0)
  }
  return req
}

async function setup() {
  const dir = tmp()
  const library = createLibrary({ dataDir: dir, log: noop })
  const registered = []
  const webServer = { register(r) { registered.push(r); return () => {} } }
  const runtime = {
    state: () => ({ ok: true, accounts: [], threads: [], platforms: [] }),
    subscribe: () => () => {},
  }
  const dispose = mountRoutes({ webServer, runtime, prefix: '/dsh-cs', log: noop, library })
  const call = async (path, method, url, body) => {
    const route = registered.find((r) => r.path === '/dsh-cs' + path)
    assert.ok(route, `缺少路由 ${path}`)
    const res = mkRes()
    await route.handler(mkReq(method, '/dsh-cs' + url, body), res)
    let json = null
    try { json = JSON.parse(res.body) } catch { /* ignore */ }
    return { status: res.status, json }
  }
  return { dir, library, call, dispose }
}

const q = (s) => encodeURIComponent(s)

test('R1 资料库路由：建项目 → 写文件 → 树/读/搜索 → 绑定 → 预览 → 改/删', async () => {
  const { dir, call, dispose } = await setup()
  try {
    // 建两个项目
    let r = await call('/library/project', 'POST', '/library/project', { action: 'create', id: 'demo-shop', name: '示例店铺' })
    assert.equal(r.status, 200)
    assert.equal(r.json.project.id, 'demo-shop')
    r = await call('/library/project', 'POST', '/library/project', { action: 'create', id: 'gaobao', name: '高报' })
    assert.equal(r.status, 200)

    // 写文件（含子目录）
    r = await call('/library/file', 'POST', '/library/file', { project: 'demo-shop', action: 'write', path: '店规.md', content: '# 店规\n满 50 包邮，不议价。\n## 发货\n48 小时内发出。' })
    assert.equal(r.status, 200)
    r = await call('/library/file', 'POST', '/library/file', { project: 'demo-shop', action: 'write', path: '话术/接待.md', content: '# 接待\n亲，在的~' })
    assert.equal(r.status, 200)
    // 路径穿越必须被拒
    r = await call('/library/file', 'POST', '/library/file', { project: 'demo-shop', action: 'write', path: '../evil.md', content: 'x' })
    assert.equal(r.status, 500)
    assert.match(r.json.error, /跳出|绝对/)

    // 树
    r = await call('/library/tree', 'GET', '/library/tree?project=demo-shop')
    assert.equal(r.status, 200)
    assert.equal(r.json.tree.length, 2)
    // 读
    r = await call('/library/file-get', 'GET', `/library/file-get?project=demo-shop&path=${q('店规.md')}`)
    assert.equal(r.status, 200)
    assert.match(r.json.doc.text, /包邮/)
    // 搜索
    r = await call('/library/search', 'GET', `/library/search?project=demo-shop&q=${q('包邮')}`)
    assert.equal(r.status, 200)
    assert.ok(r.json.hits.length >= 1)
    assert.equal(r.json.hits[0].path, '店规.md')

    // 绑定账号 + 预览
    r = await call('/library/bind', 'POST', '/library/bind', { project: 'demo-shop', platform: 'xianyu', accountId: '100000001', label: '示例店铺客服' })
    assert.equal(r.status, 200)
    r = await call('/library/context-preview', 'POST', '/library/context-preview', { platform: 'xianyu', accountId: '100000001', text: '包邮吗' })
    assert.equal(r.status, 200)
    assert.match(r.json.ctx.kb, /包邮/)
    assert.equal(r.json.ctx.project.id, 'demo-shop')

    // 未绑定账号预览 → 明确错误
    r = await call('/library/context-preview', 'POST', '/library/context-preview', { platform: 'xianyu', accountId: 'nope', text: 'x' })
    assert.equal(r.json.ctx.kb, '')

    // 改项目：置为必读 + 改名
    r = await call('/library/project', 'POST', '/library/project', { action: 'update', project: 'demo-shop', name: '示例店铺项目', pinned: ['店规.md'] })
    assert.equal(r.json.project.name, '示例店铺项目')

    // 列表
    r = await call('/library/projects', 'GET', '/library/projects')
    assert.equal(r.json.projects.length, 2)
    const pin = r.json.projects.find((p) => p.id === 'demo-shop')
    assert.equal(pin.accounts.length, 1)

    // 删项目（进回收站）
    r = await call('/library/project', 'POST', '/library/project', { action: 'delete', project: 'gaobao' })
    assert.equal(r.status, 200)
    r = await call('/library/projects', 'GET', '/library/projects')
    assert.equal(r.json.projects.length, 1)
  } finally { dispose(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})
