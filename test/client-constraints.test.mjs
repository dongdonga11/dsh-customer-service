/**
 * 客户端约束回归测试（Electron/沙箱环境）。
 *
 * 背景：面板按钮点击「没反应」的根因之一是用 `window.prompt()` 取输入——
 * Electron 渲染进程不支持 prompt（调用即抛错），onClick 里一抛就静默失败。
 * 这里把「不得出现 window.prompt」锁进测试，防止以后再写回去。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

test('C1 客户端不得使用 window.prompt（Electron 不支持，按钮会静默失效）', () => {
  assert.equal(/window\.prompt\s*\(/.test(src), false, 'client.js 里出现 window.prompt(...)：请改成面板内自绘弹窗')
})

test('C2 资料库面板的写操作都有可见入口（项目/文档/文件夹/绑定/重命名/删除）', () => {
  for (const fn of ['createProject', 'renameProject', 'deleteProject', 'bindAccount', 'newDoc', 'newDir', 'renameEntry', 'removeEntry', 'saveFile']) {
    assert.ok(new RegExp(`const ${fn} = `).test(src), `缺少资料库操作：${fn}`)
  }
})
