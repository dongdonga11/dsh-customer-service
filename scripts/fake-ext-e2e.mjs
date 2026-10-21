#!/usr/bin/env node
/**
 * 假扩展端到端冒烟（对**正在运行的 DSH** 验证 M2 真机链路）
 *
 * 做的事：
 *   1. 读 $DSH_HOME/dsh-cs/pair-code-xianyu.txt
 *   2. 连 ws://127.0.0.1:8765/ws，hello（带 platform:'xianyu'）
 *   3. 发一个「合成闲鱼聊天帧」（base64+MessagePack，与真实帧同形）
 *   4. 断开，等落盘，读 $DSH_HOME/dsh-cs/state.json
 *   5. 断言出现 xy: 会话、正文/未读/平台正确
 *
 * 不碰真实闲鱼、不依赖扩展；只验证 DSH 里加载的 adapter+kernel 全链路。
 * 运行：node scripts/fake-ext-e2e.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA = join(HOME, 'dsh-cs')
const PORT = Number(process.env.XIANYU_WS_PORT || 8765)
const ACCOUNT = `unb-e2e-${Date.now().toString(36)}`
const CHAT = `cid-e2e-${Date.now().toString(36)}@goofish`
const TEXT = `E2E 合成消息 ${new Date().toISOString()}`

// ── 最小 MessagePack 编码器（只造 fixture） ────────────────────────────────
const u8 = (n) => Buffer.from([n & 0xff])
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
function encInt(n) {
  const v = BigInt(n)
  if (v >= 0n && v < 0x80n) return u8(Number(v))
  if (v >= 0n && v <= 0xffn) return Buffer.concat([u8(0xcc), u8(Number(v))])
  if (v <= 0xffffn) return Buffer.concat([u8(0xcd), u16(Number(v))])
  if (v <= 0xffffffffn) return Buffer.concat([u8(0xce), u32(Number(v))])
  const b = Buffer.alloc(8); b.writeBigUInt64BE(v); return Buffer.concat([u8(0xcf), b])
}
function encStr(s) {
  const b = Buffer.from(String(s), 'utf8')
  if (b.length < 32) return Buffer.concat([u8(0xa0 + b.length), b])
  if (b.length <= 0xff) return Buffer.concat([u8(0xd9), u8(b.length), b])
  return Buffer.concat([u8(0xda), u16(b.length), b])
}
function enc(v) {
  if (v === null || v === undefined) return u8(0xc0)
  if (v === true) return u8(0xc3)
  if (v === false) return u8(0xc2)
  if (typeof v === 'number') return encInt(v)
  if (typeof v === 'string') return encStr(v)
  if (Array.isArray(v)) {
    if (v.length < 16) return Buffer.concat([u8(0x90 + v.length), ...v.map(enc)])
    return Buffer.concat([u8(0xdc), u16(v.length), ...v.map(enc)])
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v)
    const body = entries.flatMap(([k, val]) => [encStr(k), enc(val)])
    if (entries.length < 16) return Buffer.concat([u8(0x80 + entries.length), ...body])
    return Buffer.concat([u8(0xde), u16(entries.length), ...body])
  }
  throw new Error('unsupported type')
}
const msgpackB64 = (obj) => Buffer.from(enc(obj)).toString('base64')

// 聊天帧（与 Hermes parse_chat_message 的 m10 分支同形；parser.py:229-232）
const now = Date.now()
const chatMessage = {
  1: {
    1: { 1: `buyer-e2e@goofish` },
    2: CHAT,
    5: now,
    6: { 3: { 2: TEXT } },
    10: {
      senderUserId: 'buyer-e2e',
      senderNick: 'E2E 买家',
      reminderTitle: '买家提醒',
      reminderContent: TEXT,
      reminderUrl: 'https://example.invalid/item?itemId=item-e2e&spm=a1',
      bizTag: JSON.stringify({ messageId: `mid-e2e-${now}` }),
      extJson: JSON.stringify({ messageId: `mid-e2e-${now}`, itemId: 'item-e2e' }),
    },
  },
}
const frame = { body: { syncPushPackage: { data: [{ data: msgpackB64(chatMessage) }] } } }

// ── 流程 ──────────────────────────────────────────────────────────────────
const pairCode = readFileSync(join(DATA, 'pair-code-xianyu.txt'), 'utf8').trim()
console.log(`[e2e] port=${PORT} account=${ACCOUNT} chat=${CHAT}`)
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
const acks = []
ws.onmessage = (ev) => { try { acks.push(JSON.parse(String(ev.data))) } catch { /* ignore */ } }

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 40))
  }
}

await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连不上 8765（插件没起桥？）')) })
ws.send(JSON.stringify({ type: 'hello', pair_code: pairCode, account_id: ACCOUNT, ext_version: '0.2.0', platform: 'xianyu', features: ['frame', 'send_text'] }))
await waitFor(() => acks.find((m) => m.type === 'hello_ack' && m.ok === true))
console.log('[e2e] 配对成功')
ws.send(JSON.stringify({ type: 'frame', raw: frame }))
console.log('[e2e] 已发送合成帧')
await new Promise((r) => setTimeout(r, 1200)) // 等 store 节流落盘（500ms）
ws.close()
await new Promise((r) => setTimeout(r, 300))

// ── 断言 ─────────────────────────────────────────────────────────────────
const state = JSON.parse(readFileSync(join(DATA, 'state.json'), 'utf8'))
const expectId = `xy:${ACCOUNT}:${CHAT.replace(/@goofish$/, '')}`
const thread = state.threads && state.threads[expectId]
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }

check('会话落库（xy: 前缀）', Boolean(thread), expectId)
check('thread.platform = xianyu', thread?.platform === 'xianyu', String(thread?.platform))
check('正文正确', (state.messages?.[expectId] || []).some((m) => m.text === TEXT), '')
check('未读 +1', Number(thread?.unread) === 1, String(thread?.unread))
check('买家 uid 落库', thread?.buyerUid === 'buyer-e2e', String(thread?.buyerUid))

const failed = results.filter((r) => !r.ok)
if (failed.length) { console.error(`[e2e] ${failed.length} 项失败`); process.exit(1) }
console.log('[e2e] 全部通过 ✅（真实 DSH 进程内的 adapter+kernel+store 链路）')
