#!/usr/bin/env node
/**
 * 清理 fake-ext-e2e 写进真实库的合成数据（必须在插件**停用**状态下跑）。
 *
 * 用法：
 *   1) plugin_manager set_bundle target=dsh-cs enabled=false   （让插件 flush 完毕）
 *   2) node scripts/clean-e2e-data.mjs
 *   3) plugin_manager set_bundle target=dsh-cs enabled=true    （重新读盘）
 *
 * 只删自己造的记号线：account/thread 里含 `unb-e2e-` / `c1id-e2e-` / `cid-e2e-` 的条目。
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DATA = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-cs')
const FILE = join(DATA, 'state.json')
if (!existsSync(FILE)) { console.error(`没有 state.json：${FILE}`); process.exit(1) }

const MARK = /(unb-e2e-|cid-e2e-|buyer-e2e)/i
const state = JSON.parse(readFileSync(FILE, 'utf8'))
const removed = { accounts: 0, threads: 0, messages: 0, contacts: 0 }

for (const key of Object.keys(state.accounts || {})) {
  if (MARK.test(key) || MARK.test(JSON.stringify(state.accounts[key] || {}))) { delete state.accounts[key]; removed.accounts++ }
}
for (const key of Object.keys(state.threads || {})) {
  if (MARK.test(key) || MARK.test(JSON.stringify(state.threads[key] || {}))) {
    delete state.threads[key]
    delete state.messages?.[key]
    removed.threads++
  }
}
for (const key of Object.keys(state.messages || {})) {
  const arr = state.messages[key]
  if (Array.isArray(arr) && arr.some((m) => MARK.test(String(m.text || '')))) {
    // 整个会话已被上面删掉时这里不会命中；命中说明是残留会话，删整表
    if (!state.threads?.[key]) { delete state.messages[key]; removed.messages++ }
  }
}
for (const key of Object.keys(state.contacts || {})) {
  if (MARK.test(key) || MARK.test(JSON.stringify(state.contacts[key] || {}))) { delete state.contacts[key]; removed.contacts++ }
}

const tmp = `${FILE}.clean-tmp`
writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
renameSync(tmp, FILE)

const accounts = Object.keys(state.accounts || {}).length
const threads = Object.keys(state.threads || {}).length
console.log(`已清理：${JSON.stringify(removed)}；剩余 accounts=${accounts} threads=${threads}`)
