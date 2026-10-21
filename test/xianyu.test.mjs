/**
 * M2 闲鱼适配器测试（离线：合成 msgpack 帧，不联网、不写 $DSH_HOME）
 * ============================================================================
 *
 * 对齐依据（Hermes，Python）：
 *   - `plugins/platforms/xianyu/codec.py`  base64(MessagePack) 解码
 *   - `plugins/platforms/xianyu/parser.py` 帧 → 消息 / KIND 分类 / item_id 提取
 *   - `plugins/platforms/xianyu/adapter.py` 入站事件语义、自消息过滤、发送契约
 *   - `extension/content.js` / `background.js` / `injected.js` 扩展协议形状
 *
 * 每条断言失败信息带「Hermes 行为（file:line）vs 新实现（file:function）」。
 *
 * 运行：node --test test/xianyu.test.mjs
 *   （本机沙箱若禁 spawn，可用 `node --test --experimental-test-isolation=none ...`
 *     或直接 `node test/xianyu.test.mjs`）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MessagePackDecoder, MessagePackDecodeError, decrypt, decryptValue, base64ToBytes } from '../lib/platforms/xianyu/codec.js'
import {
  KIND_CARD,
  KIND_CHAT,
  KIND_CONFIRM_RECEIPT,
  KIND_DELIVERY_TRIGGER,
  KIND_RATE_REQUEST,
  classify,
  fmtTime,
  parseFrame,
} from '../lib/platforms/xianyu/parser.js'
import { createXianyuAdapter, spec as xianyuSpec, accountIdOf } from '../lib/platforms/xianyu/adapter.js'
import { Store } from '../lib/kernel/store.js'
import { createRuntime } from '../lib/kernel/runtime.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

/** 断言器：失败信息带 Hermes 出处与新实现出处。 */
function A(hermesRef, implRef) {
  const fmt = (desc) => `${desc}\n    Hermes 行为: ${hermesRef}\n    新实现: ${implRef}`
  return {
    eq(actual, expected, desc) {
      assert.equal(actual, expected, fmt(desc))
    },
    deep(actual, expected, desc) {
      assert.deepEqual(actual, expected, fmt(desc))
    },
    ok(cond, desc) {
      assert.ok(cond, fmt(desc))
    },
    throws(fn, desc) {
      assert.throws(fn, fmt(desc))
    },
  }
}

// ── 最小 MessagePack 编码器（只为造 fixture；生产侧不依赖） ─────────────────

function u8(n) {
  return Buffer.from([n & 0xff])
}
function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}
function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
function u64(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}
function encInt(n) {
  const v = typeof n === 'bigint' ? n : BigInt(n)
  if (v >= 0n && v < 0x80n) return u8(Number(v)) // positive fixint
  if (v < 0n && v >= -32n) return u8(0x100 + Number(v)) // negative fixint（0xe0..0xff）
  if (v >= 0n) {
    if (v <= 0xffn) return Buffer.concat([u8(0xcc), u8(Number(v))])
    if (v <= 0xffffn) return Buffer.concat([u8(0xcd), u16(Number(v))])
    if (v <= 0xffffffffn) return Buffer.concat([u8(0xce), u32(Number(v))])
    return Buffer.concat([u8(0xcf), u64(v)])
  }
  if (v >= -128n) return Buffer.concat([u8(0xd0), Buffer.from([Number(v) & 0xff])])
  if (v >= -32768n) {
    const b = Buffer.alloc(2)
    b.writeInt16BE(Number(v))
    return Buffer.concat([u8(0xd1), b])
  }
  if (v >= -2147483648n) {
    const b = Buffer.alloc(4)
    b.writeInt32BE(Number(v))
    return Buffer.concat([u8(0xd2), b])
  }
  const b = Buffer.alloc(8)
  b.writeBigInt64BE(v)
  return Buffer.concat([u8(0xd3), b])
}
function encStr(s) {
  const b = Buffer.from(String(s), 'utf8')
  if (b.length < 32) return Buffer.concat([u8(0xa0 + b.length), b]) // fixstr
  if (b.length <= 0xff) return Buffer.concat([u8(0xd9), u8(b.length), b])
  if (b.length <= 0xffff) return Buffer.concat([u8(0xda), u16(b.length), b])
  return Buffer.concat([u8(0xdb), u32(b.length), b])
}
function enc(value) {
  if (value === null || value === undefined) return u8(0xc0)
  if (value === true) return u8(0xc3)
  if (value === false) return u8(0xc2)
  if (typeof value === 'bigint') return encInt(value)
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return encInt(value)
    const b = Buffer.alloc(8)
    b.writeDoubleBE(value)
    return Buffer.concat([u8(0xcb), b])
  }
  if (typeof value === 'string') return encStr(value)
  if (Buffer.isBuffer(value)) return Buffer.concat([u8(0xc4), u8(value.length), value]) // bin 8
  if (Array.isArray(value)) {
    const body = Buffer.concat(value.map(enc))
    if (value.length < 16) return Buffer.concat([u8(0x90 + value.length), body])
    return Buffer.concat([u8(0xdc), u16(value.length), body])
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    const body = Buffer.concat(keys.map((k) => Buffer.concat([encStr(k), enc(value[k])])))
    if (keys.length < 16) return Buffer.concat([u8(0x80 + keys.length), body])
    return Buffer.concat([u8(0xde), u16(keys.length), body])
  }
  throw new Error(`无法编码的类型: ${typeof value}`)
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const msgpackB64 = (obj) => b64(enc(obj))
const plainJsonB64 = (obj) => b64(Buffer.from(JSON.stringify(obj), 'utf8'))

// ── 帧 fixture（结构照抄真实闲鱼帧；值全是合成的） ─────────────────────────

const T0 = 1790000000123

/** 普通买家聊天帧（parse_chat_message 的 m10 分支：parser.py:229-232）。 */
function chatFrame({
  chatId = 'cid-1001@goofish',
  sender = 'buyer-2001',
  nick = '买家甲',
  text = '你好，还在吗？',
  itemId = 'item-3001',
  messageId = 'mid-4001',
  msgTime = T0,
} = {}) {
  return {
    1: {
      1: { 1: `${sender}@goofish` },
      2: chatId,
      5: msgTime,
      6: { 3: { 2: text } },
      10: {
        senderUserId: sender,
        senderNick: nick,
        reminderTitle: '买家提醒',
        reminderContent: text,
        reminderUrl: `https://example.invalid/item?itemId=${itemId}&spm=a1`,
        bizTag: JSON.stringify({ messageId }),
        extJson: JSON.stringify({ messageId, itemId }),
      },
    },
  }
}

/** 系统营销提示（msgArg1 == MsgTips → 应被过滤）。 */
function systemTipFrame() {
  return { 1: { 10: { extJson: JSON.stringify({ msgArg1: 'MsgTips' }) } } }
}

/** 卡片消息：reminderContent == "[卡片消息]" + 1.6.3.5 里带标题。 */
function cardFrame({ title = '小刀优惠', chatId = 'cid-card@goofish', sender = 'buyer-card' } = {}) {
  const frame = chatFrame({ chatId, sender, text: '[卡片消息]' })
  frame[1][6][3]['5'] = JSON.stringify({
    dxCard: { item: { main: { exContent: { title } } } },
  })
  return frame
}

/** 卡片更新消息：message["1"] 是字符串，内容在 message["4"]（parser.py:257-279）。 */
function cardUpdateFrame({ text = '[我已付款，等待你发货]', itemId = 'item-7777' } = {}) {
  return {
    1: 'system-flag',
    2: 'cid-7777@goofish',
    5: T0 + 5000,
    4: {
      senderUserId: 'buyer-7001',
      reminderTitle: '交易提醒',
      reminderContent: text,
      reminderUrl: `https://example.invalid/order?itemId=${itemId}`,
      extJson: JSON.stringify({ messageId: 'mid-7777' }),
    },
  }
}

/** 同步包：body.syncPushPackage.data[] = [{data: base64}]（parser.py:313-330）。 */
function syncPackage(items) {
  return { body: { syncPushPackage: { data: items.map((data) => ({ data })) } } }
}

function fakeBridge({ accountIds = ['unb-seller'], responder } = {}) {
  const sent = []
  const accs = new Set(accountIds)
  return {
    defaultPlatform: 'xianyu',
    port: 8765,
    pairCode: 'xy-pair',
    isConnected: true,
    _sent: sent,
    hasAccount: (id) => accs.has(id),
    accountsOfPlatform: () => [...accs],
    platformOf: () => 'xianyu',
    sendCommandAck: (cmd, acct, timeout) => {
      sent.push({ cmd, acct, timeout })
      return Promise.resolve(responder ? responder(cmd, acct) : { ok: false, error: 'no responder' })
    },
    sendCommand: (cmd, acct) => {
      sent.push({ cmd, acct })
      return true
    },
    addPairCode() {},
    removePairCode() {},
    registerPlatformAccount() {},
    setInboundHandler() {},
    async start() {
      return true
    },
    stop() {},
  }
}

/** 适配器测试用 io：捕获 request 的下发内容。 */
function makeIo({ responder } = {}) {
  const calls = []
  return {
    calls,
    io: {
      accountId: 'unb-seller',
      bridge: fakeBridge({ accountIds: ['unb-seller'] }),
      request: (cmd, acct, timeout) => {
        calls.push({ cmd, acct, timeout })
        return Promise.resolve(responder ? responder(cmd, acct) : { ok: true })
      },
      sendText: (cmd, acct) => {
        // 文本走 fire-and-forget；仍记录与旧断言一致的 timeout 元数据（协议层约定值）
        calls.push({ cmd, acct, timeout: 25000 })
        return Promise.resolve(responder ? responder(cmd, acct) : { ok: true })
      },
      echo: { remember() {}, consume() { return false } },
      log: silent,
    },
  }
}

async function makeStack(dir) {
  const store = new Store({ dataDir: dir, sessionSlug: 'xy', defaultPlatform: 'xianyu', label: 'xy-test' })
  await store.init()
  const adapter = createXianyuAdapter({ store, log: silent, dataDir: dir })
  const bridge = fakeBridge({ accountIds: ['unb-seller'], responder: () => ({ ok: true }) })
  const runtime = createRuntime({ ctx: null, config: { label: 'xy-test' }, store, adapters: [adapter], bridges: [bridge], log: silent })
  runtime.setBridgeStarted(true)
  return { store, adapter, runtime, bridge }
}

async function teardown({ dir, store, runtime }) {
  try {
    if (runtime) runtime.dispose()
  } catch {
    /* ignore */
  }
  try {
    if (store) await store.save()
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

// ═══ T1 codec：MessagePack 解码 / base64 / decrypt ═════════════════════════

test('T1 codec：MessagePack 全类型解码 + base64(MessagePack)→JSON（对齐 codec.py）', () => {
  const a = A('codec.py:76-153（decode_value 逐分支）+ 156-195（decrypt）', 'lib/platforms/xianyu/codec.js')

  // 基本类型往返（fixstr/fixint/fixarray/fixmap/bool/nil/float/bin）
  const obj = {
    s: '闲鱼消息',
    n: 42,
    neg: -7,
    big: 1234567890123,
    f: 1.5,
    t: true,
    f2: false,
    nil: null,
    arr: [1, 'two', { three: 3 }],
    bin: Buffer.from('二进制文本', 'utf8'),
  }
  const bytes = enc(obj)
  a.eq(bytes[0] >> 4, 0x8, '编码器产出 fixmap 头（fixture 自检）')
  const decoded = new MessagePackDecoder(bytes).decode()
  a.deep(decoded, obj, 'MessagePack 全类型往返一致')

  // 64 位整数：超过 2^53 用 BigInt 保精度（Python 是无损 int）
  const bigId = 18446744073709551615n
  const bigDecoded = new MessagePackDecoder(enc({ id: bigId })).decode()
  a.eq(bigDecoded.id, bigId, 'uint64 超大值用 BigInt 保精度')
  a.ok(decrypt(msgpackB64({ id: bigId })).includes('18446744073709551615'), 'decrypt 输出保留 64 位十进制值')

  // decrypt：base64(MessagePack(JSON)) → JSON 字符串
  const json = decrypt(msgpackB64(chatFrame()))
  const back = JSON.parse(json)
  a.eq(back['1']['2'], 'cid-1001@goofish', 'decrypt 把 MessagePack 还原成 JSON 文本')
  a.eq(typeof json, 'string', 'decrypt 返回字符串（同 codec.py 签名）')

  // 缺 padding 的 base64 也能解（codec.py:178-182 的补位逻辑）
  const noPad = msgpackB64({ a: 'x' }).replace(/=+$/, '')
  a.eq(decryptValue(noPad).a, 'x', '缺 padding 的 base64 可解')

  // 未知格式字节 → 抛错（codec.py:139）
  a.throws(() => new MessagePackDecoder(Buffer.from([0xc1])).decode(), '0xc1 未知格式字节抛错')
  a.ok(new MessagePackDecodeError('x') instanceof Error, 'MessagePackDecodeError 可用')
  a.deep(Array.from(base64ToBytes('YQ==')), [0x61], 'base64ToBytes 解出字节')
})

// ═══ T2 parser：普通聊天帧字段提取 ═════════════════════════════════════════

test('T2 parser：普通聊天帧 → chat / 文本 / chat_id / 买家 / item_id / message_id', () => {
  const a = A('parser.py:220-253（parse_chat_message）+ 158-217（id/item 提取）', 'lib/platforms/xianyu/parser.js parseChatMessage/extractItemId')

  const msgs = parseFrame(chatFrame())
  a.eq(msgs.length, 1, '一帧普通聊天 → 1 条消息')
  const m = msgs[0]
  a.eq(m.kind, KIND_CHAT, 'kind=chat（parser.py:244）')
  a.eq(m.send_message, '你好，还在吗？', '正文取 m10.reminderContent（parser.py:231）')
  a.eq(m.send_user_id, 'buyer-2001', '买家 id 取 m10.senderUserId（parser.py:230）')
  a.eq(m.send_user_name, '买家甲', '买家名优先 senderNick（parser.py:232）')
  a.eq(m.chat_id, 'cid-1001', 'chat_id 去掉 @goofish 后缀（parser.py:226）')
  a.eq(m.item_id, 'item-3001', 'item_id 从 reminderUrl 的 itemId= 提取（parser.py:203-205）')
  a.eq(m.message_id, 'mid-4001', 'message_id 取 bizTag 里的 messageId（parser.py:165-173）')
  a.eq(m.msg_time, fmtTime(T0), 'msg_time 是本地时间字符串（parser.py:191-197）')
  a.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(m.msg_time), 'msg_time 格式 %Y-%m-%d %H:%M:%S')

  // 有 reminderContent 但缺 senderNick/reminderTitle → 名字兜底「系统」（parser.py:232）
  const noNick = chatFrame()
  delete noNick[1][10].senderNick
  delete noNick[1][10].reminderTitle
  const msgs2 = parseFrame(noNick)
  a.eq(msgs2.length, 1, '缺 senderNick/reminderTitle 仍可解析')
  a.eq(msgs2[0].send_user_name, '系统', '名字兜底「系统」（parser.py:232 or "系统"）')

  // 缺 senderUserId → 默认 unknown（parser.py:230）
  const noSender = chatFrame()
  delete noSender[1][10].senderUserId
  const msgs3 = parseFrame(noSender)
  a.eq(msgs3.length, 1, '缺 senderUserId 仍产出消息')
  a.eq(msgs3[0].send_user_id, 'unknown', '买家 id 兜底 unknown（parser.py:230）')

  // 非 dict 帧 → []
  a.deep(parseFrame(null), [], '非对象帧 → 空数组（parser.py:319-320）')
  a.deep(parseFrame('not-a-frame'), [], '字符串帧 → 空数组')
})

// ═══ T3 parser：同步包（多条 + plain JSON + chatType 系统消息） ═════════════

test('T3 parser：同步包多消息 / 明文 JSON 兜底 / chatType 系统消息丢弃', () => {
  const a = A('parser.py:313-336（parse_frame）+ 84-102（decrypt_sync_item）', 'lib/platforms/xianyu/parser.js parseFrame/decryptSyncItem')

  const f1 = chatFrame({ chatId: 'cid-1@goofish', messageId: 'mid-1', text: '第一条' })
  const f2 = chatFrame({ chatId: 'cid-2@goofish', messageId: 'mid-2', text: '第二条' })
  const frame = syncPackage([
    msgpackB64(f1), // base64(MessagePack(JSON))
    plainJsonB64(f2), // base64(JSON 文本)
    plainJsonB64({ chatType: 1, foo: 'bar' }), // 未加密系统消息 → 丢弃（parser.py:94-97）
    '!!!not-base64!!!', // 两边都解不开 → 丢弃
  ])
  const msgs = parseFrame(frame)
  a.eq(msgs.length, 2, '同步包里只有 2 条业务消息（系统消息/坏数据被丢弃）')
  a.eq(msgs[0].send_message, '第一条', 'MessagePack 路径解析正确')
  a.eq(msgs[1].send_message, '第二条', '明文 JSON 路径解析正确')
  a.eq(msgs[1].chat_id, 'cid-2', '明文 JSON 路径 chat_id 正确')

  // data 为空数组 → 不是同步包，按普通帧解析 → []
  a.deep(parseFrame({ body: { syncPushPackage: { data: [] } } }), [], 'data 为空的同步包按普通帧处理（parser.py:71-82）')
})

// ═══ T4 parser：KIND 分类（关键词表逐条） ═══════════════════════════════════

test('T4 parser：KIND 分类——发货触发/评价请求/确认收货/普通聊天（关键词照抄）', () => {
  const a = A('parser.py:32-47（关键词表）+ 297-308（classify）', 'lib/platforms/xianyu/parser.js classify')

  a.eq(classify('[我已付款，等待你发货]'), KIND_DELIVERY_TRIGGER, '发货关键词 1')
  a.eq(classify('[已付款，待发货]'), KIND_DELIVERY_TRIGGER, '发货关键词 2')
  a.eq(classify('我已付款，等待你发货'), KIND_DELIVERY_TRIGGER, '发货关键词 3（无方括号）')
  a.eq(classify('[记得及时发货]'), KIND_DELIVERY_TRIGGER, '发货关键词 4')
  a.eq(classify('买家说[我已付款，等待你发货]了'), KIND_DELIVERY_TRIGGER, '关键词是包含匹配（parser.py:300-302）')

  a.eq(classify('快给ta一个评价吧~'), KIND_RATE_REQUEST, '评价请求：整串相等')
  a.eq(classify('快给ta一个评价吧～'), KIND_RATE_REQUEST, '评价请求：全角波浪号')
  a.eq(classify('快给ta一个评价吧~谢谢'), KIND_CHAT, '评价请求是**整串相等**而非包含（parser.py:303-304）')

  a.eq(classify('[买家确认收货，交易成功]'), KIND_CONFIRM_RECEIPT, '确认收货关键词 1')
  a.eq(classify('买家已确认收货，交易成功'), KIND_CONFIRM_RECEIPT, '确认收货关键词 2')

  a.eq(classify('你好，在吗'), KIND_CHAT, '普通文本 → chat')

  // 经完整 parseFrame 也应得到同样分类（parse_single 会再 classify，parser.py:356）
  const paid = chatFrame({ text: '[我已付款，等待你发货]' })
  a.eq(parseFrame(paid)[0].kind, KIND_DELIVERY_TRIGGER, 'parseFrame 内部也做业务分类')
})

// ═══ T5 parser：系统提示过滤 / 卡片消息 ═════════════════════════════════════

test('T5 parser：MsgTips 系统提示被过滤 / 卡片消息带标题 / 卡片标题缺失则不算卡片', () => {
  const a = A('parser.py:339-355（_parse_single）+ 282-293（extract_card_title）', 'lib/platforms/xianyu/parser.js parseSingle/extractCardTitle')

  a.deep(parseFrame(systemTipFrame()), [], 'msgArg1=MsgTips 不入库（parser.py:341-342）')

  const card = parseFrame(cardFrame({ title: '小刀优惠' }))
  a.eq(card.length, 1, '卡片消息产出 1 条')
  a.eq(card[0].kind, KIND_CARD, 'kind=card（parser.py:349-353）')
  a.eq(card[0].card_title, '小刀优惠', 'card_title 取 dxCard.item.main.exContent.title')
  a.eq(card[0].send_message, '[卡片消息]', '卡片正文保留占位文本')

  // 只有 1.6.3 没有 1.10 的纯卡片（is_card_message 分支，parser.py:365-372）
  const cardOnly = { 1: { 2: 'cid-c@goofish', 5: T0, 6: { 3: { 5: JSON.stringify({ dxCard: { item: { main: { exContent: { title: '拼团' } } } } }) } } } }
  const cardOnlyMsgs = parseFrame(cardOnly)
  a.eq(cardOnlyMsgs.length, 1, '纯卡片（无 reminderContent）也能识别')
  a.eq(cardOnlyMsgs[0].kind, KIND_CARD, '纯卡片 kind=card')
  a.eq(cardOnlyMsgs[0].card_title, '拼团', '纯卡片标题提取正确')

  // 标题拿不到 → 不算卡片，仍按 chat 解析（parser.py:349-354）
  const noTitle = cardFrame()
  delete noTitle[1][6][3]['5']
  const noTitleMsgs = parseFrame(noTitle)
  a.eq(noTitleMsgs.length, 1, '没有标题时仍产出消息')
  a.eq(noTitleMsgs[0].kind, KIND_CHAT, '没有标题 → 不标 card，按 chat 分类')
})

// ═══ T6 parser：卡片更新消息（m1 是字符串、内容在 m4） ═════════════════════

test('T6 parser：卡片更新消息走 m4 分支，并按内容分类 + 提取 item_id', () => {
  const a = A('parser.py:257-279（parse_card_update_message）+ 359-363', 'lib/platforms/xianyu/parser.js parseCardUpdateMessage')

  const msgs = parseFrame(cardUpdateFrame())
  a.eq(msgs.length, 1, '卡片更新消息 → 1 条')
  const m = msgs[0]
  a.eq(m.send_message, '[我已付款，等待你发货]', '正文取 m4.reminderContent')
  a.eq(m.send_user_id, 'buyer-7001', '买家 id 取 m4.senderUserId')
  a.eq(m.send_user_name, '交易提醒', '发送者名取 m4.reminderTitle')
  a.eq(m.chat_id, 'cid-7777', 'chat_id 取 message.2 并去 @')
  a.eq(m.item_id, 'item-7777', 'item_id 从 m4.reminderUrl 提取')
  a.eq(m.message_id, 'mid-7777', 'message_id 取 m4.extJson')
  a.eq(m.kind, KIND_DELIVERY_TRIGGER, '卡片更新消息也要分类（parser.py:361-362）')
})

// ═══ T7 adapter.parseInbound：frame → message 事件 ═════════════════════════

test('T7 adapter.parseInbound(frame)：message 事件形状 + 自消息过滤 + 边缘输入', () => {
  const a = A('adapter.py:175-198（frame 分发）+ 243-257（MessageEvent 字段）', 'lib/platforms/xianyu/adapter.js parseInbound(frame)')
  const adapter = createXianyuAdapter({ store: new Store({ dataDir: join(tmpdir(), 'xy-unused'), label: 'x' }), log: silent })
  const io = { accountId: 'unb-seller' }

  const events = adapter.parseInbound({ type: 'frame', raw: chatFrame() }, io)
  // 一帧会产出 2 个事件：先「买家档案（contacts）」再「消息」——顺序保证内核先落昵称
  a.eq(events.length, 2, '一帧 → 买家档案 + 消息 共 2 个事件')
  a.eq(events[0].kind, 'account', '第一个事件是 account（买家档案）')
  a.deep(
    events[0].contacts,
    [{ uid: 'buyer-2001', secUid: '', nickname: '买家甲', avatar: '' }],
    'senderNick 顺手落通讯录（面板显示名来源）',
  )
  const ev = events[1]
  a.eq(ev.kind, 'message', '第二个事件 kind=message')
  a.eq(ev.platform, 'xianyu', 'platform=xianyu')
  a.eq(ev.accountId, 'unb-seller', 'accountId 来自桥判定')
  a.eq(ev.conversationId, 'cid-1001', 'conversationId = chat_id')
  a.eq(ev.buyerUid, 'buyer-2001', 'buyerUid = senderUserId')
  a.eq(ev.buyerName, '买家甲', 'buyerName = senderNick')
  a.eq(ev.text, '你好，还在吗？', 'text = 消息正文')
  a.eq(ev.serverMessageId, 'mid-4001', 'serverMessageId = message_id（去重/幂等键）')
  a.eq(ev.xianyuKind, KIND_CHAT, '附带 xianyuKind 供 M3 使用')
  a.eq(ev.itemId, 'item-3001', '附带 itemId')
  a.ok(Number.isFinite(ev.at) && ev.at === T0, 'at = 帧时间毫秒')

  // 自消息过滤：senderUserId == 自己 unb（adapter.py:194-197）
  const selfFrame = chatFrame({ sender: 'unb-seller', nick: '我自己' })
  a.deep(adapter.parseInbound({ type: 'frame', raw: selfFrame }, io), [], '自己发的消息被过滤（防回复循环）')

  // 同步包 → 多事件
  const pkg = syncPackage([msgpackB64(chatFrame({ chatId: 'cid-a@goofish' })), plainJsonB64(chatFrame({ chatId: 'cid-b@goofish' }))])
  const pkgEvents = adapter.parseInbound({ type: 'frame', raw: pkg }, io)
  a.eq(pkgEvents.filter((e) => e.kind === 'message').length, 2, '同步包 → 2 个 message 事件')
  a.eq(pkgEvents.filter((e) => e.kind === 'account').length, 2, '同步包 → 每条消息各带一次买家档案')

  // raw 是字符串也容忍（防御性）
  a.eq(
    adapter.parseInbound({ type: 'frame', raw: JSON.stringify(chatFrame()) }, io).filter((e) => e.kind === 'message').length,
    1,
    'raw 为 JSON 字符串时也能解析',
  )

  // 缺 chat_id → 丢弃（会话 key 必须有）
  const noChat = chatFrame({ chatId: '' })
  a.deep(adapter.parseInbound({ type: 'frame', raw: noChat }, io), [], '缺 chat_id 的帧被丢弃')

  // 未知类型 / 坏输入
  a.deep(adapter.parseInbound({ type: 'whatever' }, io), [], '未知类型 → 空事件')
  a.deep(adapter.parseInbound(null, io), [], 'null 输入 → 空事件')

  // Hermes 无 messageId 时用时间戳兜底（adapter.py:247）→ 这里给唯一 id
  const noId = chatFrame()
  delete noId[1][10].bizTag
  delete noId[1][10].extJson
  const noIdEvents = adapter.parseInbound({ type: 'frame', raw: noId }, io).filter((e) => e.kind === 'message')
  a.ok(noIdEvents[0].serverMessageId.startsWith('xy-'), '无 messageId 时生成兜底 id（对齐 adapter.py:247）')
  a.ok(noIdEvents[0].agentText.includes('你好'), 'agentText 提供 Hermes 风格文本（M3 AI 用）')
})

// ═══ T8 adapter.parseInbound：账号/登录态/风控/当前会话 ═════════════════════

test('T8 adapter.parseInbound(其它)：user_info 买家档案 / login_state / risk_alert / current_chat / 账号识别', () => {
  const a = A(
    'adapter.py:129-179（_on_inbound 各分支）+ content.js:42-56（unb 探测）+ injected.js:325-360（user_info）',
    'lib/platforms/xianyu/adapter.js parseInbound/identifySelf',
  )
  const store = new Store({ dataDir: join(tmpdir(), 'xy-unused2'), label: 'x' })
  const adapter = createXianyuAdapter({ store, log: silent })
  const io = { accountId: 'unb-seller' }

  // 买家档案：uid/nickname/avatar → account 事件里的 contacts
  const ui = adapter.parseInbound(
    { type: 'user_info', users: [{ uid: 'buyer-2001', nickname: '买家甲', avatar_url: 'https://example.invalid/a.png' }] },
    io,
  )
  a.eq(ui.length, 1, 'user_info → 1 个 account 事件')
  a.eq(ui[0].kind, 'account', 'kind=account')
  a.deep(ui[0].contacts, [{ uid: 'buyer-2001', secUid: '', nickname: '买家甲', avatar: 'https://example.invalid/a.png' }], 'contacts 字段与内核 upsertContact 对齐')
  a.eq(ui[0].refresh, true, '买家资料更新要刷新面板')

  // 登录态在线
  const on = adapter.parseInbound({ type: 'login_state', online: true }, io)
  a.eq(on.length, 1, 'login_state 在线 → 1 个事件')
  a.eq(on[0].kind, 'account', '在线 → account 事件')
  a.eq(on[0].connected, true, 'connected=true')

  // 登录态离线：account + probe（Hermes 会报 fatal error，DSH 里落成诊断）
  const off = adapter.parseInbound({ type: 'login_state', online: false }, io)
  a.eq(off.length, 2, 'login_state 离线 → account + probe')
  a.eq(off[0].connected, false, 'connected=false')
  a.eq(off[1].kind, 'probe', '离线附带 probe 诊断')
  a.ok(String(off[1].note).includes('登录态'), 'probe note 说明是登录态')

  // 风控告警
  const risk = adapter.parseInbound({ type: 'risk_alert', detail: '验证页' }, io)
  a.eq(risk.length, 1, 'risk_alert → 1 个 probe')
  a.eq(risk[0].kind, 'probe', 'kind=probe')
  a.eq(risk[0].data.detail, '验证页', 'detail 透传')

  // 当前会话（injected.js 从出站帧挖出来的）
  const cur = adapter.parseInbound({ type: 'current_chat', chat_id: 'cid-cur@goofish', buyer_id: 'buyer-cur' }, io)
  a.eq(cur.length, 1, 'current_chat → 1 个 thread-hint')
  a.eq(cur[0].kind, 'thread-hint', 'kind=thread-hint')
  a.eq(cur[0].conversationId, 'cid-cur', 'conversationId 去 @ 后缀')
  a.eq(cur[0].buyerUid, 'buyer-cur', 'buyerUid 透传')

  // 平台账号注册（扩展上报 / 桥自愈注册）
  const pa = adapter.parseInbound({ type: 'platform_account', platform: 'xianyu', nickname: '店铺名', detected_id: 'unb-seller', self_uid: 'unb-seller' }, io)
  a.eq(pa.length, 1, 'platform_account → 1 个 account')
  a.eq(pa[0].kind, 'account', 'kind=account')
  a.eq(pa[0].nickname, '店铺名', 'nickname 透传')
  a.eq(pa[0].detectedId, 'unb-seller', 'detectedId 透传')
  a.eq(pa[0].connected, true, 'connected=true')
  a.eq(pa[0].refresh, true, '注册后刷新面板')

  // account_detected：unb 既是 detectedId 也是 selfUid
  const ad = adapter.parseInbound({ type: 'account_detected', account_id: 'unb-seller' }, io)
  a.eq(ad[0].detectedId, 'unb-seller', 'account_detected → detectedId')
  a.eq(ad[0].selfUid, 'unb-seller', 'account_detected → selfUid（unb 与 senderUserId 同源）')

  // account_identity（闲鱼只有 unb）
  const ai = adapter.parseInbound({ type: 'account_identity', unb: 'unb-seller' }, io)
  a.eq(ai[0].selfUid, 'unb-seller', 'account_identity → selfUid')

  // ws_hooked
  const hooked = adapter.parseInbound({ type: 'ws_hooked' }, io)
  a.eq(hooked[0].connected, true, 'ws_hooked → connected=true')

  // 未知类型
  a.deep(adapter.parseInbound({ type: 'no_such_type' }, io), [], '未知类型 → 空事件')

  // 握手账号 id
  a.eq(accountIdOf({ account_id: 'unb-seller' }), 'unb-seller', '握手 account_id = unb')
  a.eq(accountIdOf({}), 'default', '缺 account_id → default')
})

// ═══ T9 adapter.send：send_text 指令形状 ═══════════════════════════════════

test('T9 adapter.send：下发 send_text 指令字段与 Hermes 一致，成功回时间戳 id', async () => {
  const a = A(
    'tools.py:298-302（send_text 命令）+ content.js:146-171（扩展执行）+ background.js:261-274（cmd_result）',
    'lib/platforms/xianyu/adapter.js send',
  )
  const store = new Store({ dataDir: join(tmpdir(), 'xy-unused3'), label: 'x' })
  const adapter = createXianyuAdapter({ store, log: silent })
  const thread = { id: 'xy:unb-seller:cid-1001', platform: 'xianyu', accountId: 'unb-seller', conversationId: 'cid-1001', buyerUid: 'buyer-2001' }

  const okIo = makeIo()
  const ok = await adapter.send(thread, '在的，稍等哈', okIo.io)
  a.eq(ok.ok, true, '发送成功 ok=true')
  a.eq(okIo.calls.length, 1, '只下发一条指令')
  const call = okIo.calls[0]
  a.eq(call.cmd.type, 'send_text', '指令 type=send_text')
  a.eq(call.cmd.chat_id, 'cid-1001', 'chat_id 定向')
  a.eq(call.cmd.buyer_id, 'buyer-2001', 'buyer_id 定向（缺则扩展退 DOM）')
  a.eq(call.cmd.seller_id, 'unb-seller', 'seller_id = 本账号 unb')
  a.eq(call.cmd.text, '在的，稍等哈', 'text 原样下发')
  a.eq(call.acct, 'unb-seller', '指令发给对应账号连接')
  a.eq(call.timeout, 25000, '超时 25s（对齐 bridge.py send_command_ack 默认）')
  a.ok(/^\d+$/.test(ok.serverMessageId), '成功返回时间戳兜底 message id（adapter.py:315）')
  a.eq(ok.server_message_id, ok.serverMessageId, '同时给 snake_case 字段（路由/旧调用方兼容）')

  // 失败：扩展回报错误
  const failIo = makeIo({ responder: () => ({ ok: false, error: 'content_no_response' }) })
  const fail = await adapter.send(thread, 'hi', failIo.io)
  a.eq(fail.ok, false, '扩展失败 → ok=false')
  a.eq(fail.error, 'content_no_response', '错误码透传')

  // 无桥 / 无 request
  const noIo = await adapter.send(thread, 'hi', {})
  a.eq(noIo.ok, false, '无桥时失败')
  a.ok(String(noIo.error).includes('桥不可用'), '明确报「桥不可用」')

  // 空文本：Hermes 侧是 `if not text`（空串才算空；纯空白在 Python 里 truthy，会被发出去）
  // —— 但内核 /send 路由已先 trim，所以空白永远到不了这里；这里只测空串。
  const empty = await adapter.send(thread, '', makeIo().io)
  a.eq(empty.ok, false, '空串拒发（对齐 tools.py:259-260 的 not text）')
  a.ok(String(empty.error).includes('不能为空'), '明确报 text 不能为空')
  const blank = await adapter.send(thread, '   ', makeIo().io)
  a.eq(blank.ok, true, '纯空白按 Hermes 语义（not text 为 False）照发；内核已 trim 兜底')
})

// ═══ T10 adapter.sendImage：send_image 指令形状与定向约束 ══════════════════

test('T10 adapter.sendImage：send_image + image_url；缺 buyer_id 时明确拒绝（无 DOM 兜底）', async () => {
  const a = A('tools.py:304-311 + 288-293（发图必须能定向）+ content.js:174-179', 'lib/platforms/xianyu/adapter.js sendImage')
  const store = new Store({ dataDir: join(tmpdir(), 'xy-unused4'), label: 'x' })
  const adapter = createXianyuAdapter({ store, log: silent })
  const thread = { id: 'xy:unb-seller:cid-1001', platform: 'xianyu', accountId: 'unb-seller', conversationId: 'cid-1001', buyerUid: 'buyer-2001' }

  const io = makeIo()
  const r = await adapter.sendImage(thread, 'https://example.invalid/p.png', io.io)
  a.eq(r.ok, true, '发图成功')
  const cmd = io.calls[0].cmd
  a.eq(cmd.type, 'send_image', '指令 type=send_image')
  a.eq(cmd.image_url, 'https://example.invalid/p.png', 'image_url 透传')
  a.eq(cmd.chat_id, 'cid-1001', 'chat_id 定向')
  a.eq(cmd.buyer_id, 'buyer-2001', 'buyer_id 定向')
  a.eq(cmd.seller_id, 'unb-seller', 'seller_id 透传')

  const noBuyer = await adapter.sendImage({ ...thread, buyerUid: '' }, 'https://example.invalid/p.png', makeIo().io)
  a.eq(noBuyer.ok, false, '缺 buyer_id → 拒发（发图没有 DOM 兜底）')
  a.ok(String(noBuyer.error).includes('buyer_id'), '错误说明缺定向信息')

  const noUrl = await adapter.sendImage(thread, '', makeIo().io)
  a.eq(noUrl.ok, false, '空 image_url → 拒发')
})

// ═══ T11 canSend / enrichBuyer 边界 ════════════════════════════════════════

test('T11 canSend：桥在线即可发；缺定向信息标注 DOM 降级；enrichBuyer 三级解析', async () => {
  const a = A(
    'adapter.py:306-316（未接入则失败）+ tools.py:265-274（缺定向退化）+ customer_store 昵称',
    'lib/platforms/xianyu/adapter.js canSend/enrichBuyer',
  )
  const dir = mkdtempSync(join(tmpdir(), 'xy-t11-'))
  const store = new Store({ dataDir: dir, sessionSlug: 'xy', defaultPlatform: 'xianyu', label: 'x' })
  await store.init()
  const adapter = createXianyuAdapter({ store, log: silent })
  try {
    const bridge = fakeBridge({ accountIds: ['unb-seller'] })
    const full = { accountId: 'unb-seller', conversationId: 'cid-1', buyerUid: 'buyer-1' }
    a.eq(adapter.canSend(full, { bridge }).ok, true, '桥在线 + 定向信息齐全 → 可发')
    a.eq(adapter.canSend(full, { bridge }).reason, '', '无需降级提示')

    const noBuyer = { accountId: 'unb-seller', conversationId: 'cid-1', buyerUid: '' }
    const r2 = adapter.canSend(noBuyer, { bridge })
    a.eq(r2.ok, true, '缺 buyer_id 仍允许发（扩展退 DOM）')
    a.ok(String(r2.reason).includes('DOM'), '明确标注降级到 DOM 当前窗口')

    const offline = adapter.canSend(full, { bridge: fakeBridge({ accountIds: [] }) })
    a.eq(offline.ok, false, '扩展未接入 → 不可发')
    a.ok(String(offline.reason).includes('未接入'), '原因说明扩展未接入')

    // enrichBuyer：thread.buyerName 优先
    a.eq(adapter.enrichBuyer({ buyerUid: 'b1', buyerName: '帧内昵称' }).name, '帧内昵称', '优先用帧里的 senderNick')
    a.eq(adapter.enrichBuyer({ buyerUid: 'b1', buyerName: '帧内昵称' }).nameKnown, true, 'nameKnown=true')

    // 其次买家档案（通讯录）昵称
    store.upsertContact({ uid: 'b2', nickname: '档案昵称' })
    const e2 = adapter.enrichBuyer({ buyerUid: 'b2' })
    a.eq(e2.name, '档案昵称', '退到买家档案昵称')
    a.eq(e2.nameKnown, true, '档案命中 → nameKnown=true')

    // 都没有 → nameKnown=false（面板回退显示 id）
    const e3 = adapter.enrichBuyer({ buyerUid: 'never-seen' })
    a.eq(e3.name, '', '查不到昵称时 name 为空')
    a.eq(e3.nameKnown, false, 'nameKnown=false')
    a.eq(e3.buyerId, 'never-seen', 'buyerId 仍然给出')
  } finally {
    await store.save()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

// ═══ T12 spec / 契约 / aiContext ═══════════════════════════════════════════

test('T12 spec 与适配器契约：端口 8765 / platforms / bridgeSharingKey / aiContext 空实现', async () => {
  const a = A('M1-INTERFACES.md §1.1/§3（adapter 契约）+ parasitic_platforms.py:59-76（闲鱼规格）', 'lib/platforms/xianyu/adapter.js')
  const store = new Store({ dataDir: join(tmpdir(), 'xy-unused5'), label: 'x' })
  const adapter = createXianyuAdapter({ store, log: silent })

  a.eq(xianyuSpec.name, 'xianyu', 'spec.name')
  a.eq(xianyuSpec.label, '闲鱼', 'spec.label')
  a.eq(xianyuSpec.sessionSlug, 'xy', 'spec.sessionSlug（会话 key 前缀）')
  a.eq(xianyuSpec.defaultPort, 8765, 'spec.defaultPort（与抖音 8766 区分）')
  a.deep(xianyuSpec.platforms, ['xianyu'], 'spec.platforms')
  a.deep(xianyuSpec.aiDefaultPlatforms, ['xianyu'], 'spec.aiDefaultPlatforms')
  a.eq(xianyuSpec.capabilities.sendMode, 'direct', 'capabilities.sendMode=direct（无模板中间态）')
  a.eq(xianyuSpec.capabilities.requiresSendTemplate, false, 'capabilities.requiresSendTemplate=false')
  a.eq(xianyuSpec.capabilities.supportsImages, true, 'capabilities.supportsImages=true')
  a.eq(adapter.bridgeSharingKey, 'xianyu', 'bridgeSharingKey（装配层合桥用）')
  a.eq(adapter.poll, null, '无 poll（推送型平台）')

  for (const m of ['accountIdOf', 'identifySelf', 'parseInbound', 'send', 'canSend', 'enrichBuyer', 'aiContext', 'aiDiagnostics', 'dispose']) {
    a.eq(typeof adapter[m], 'function', `adapter.${m} 是函数`)
  }

  const ctxInfo = await adapter.aiContext()
  a.eq(ctxInfo.kb, '', '无话术库时返回空 kb（内核会转人工，不会误发）')
  a.ok(String(ctxInfo.kbError).includes('话术库'), '空知识库带原因说明（M3：未找到话术库）')
  const diag = await adapter.aiDiagnostics()
  a.eq(diag.kb.chars, 0, 'aiDiagnostics.kb.chars=0')
  a.eq(diag.realtime.status, 'unknown', 'aiDiagnostics.realtime=unknown')
})

// ═══ T13 与内核联调：帧 → 会话落库 → 人工回复 ═════════════════════════════

test('T13 内核联调：frame 落库成 xy: 会话、未读/买家名正确、sendHuman 走 send_text', async () => {
  const a = A('adapter.py:181-258（解析→事件）+ 内核 store/runtime 契约', 'lib/platforms/xianyu/adapter.js + lib/kernel/{store,runtime}.js')
  const dir = mkdtempSync(join(tmpdir(), 'xy-t13-'))
  const stack = await makeStack(dir)
  const { store, runtime, bridge } = stack
  try {
    // 桥配对成功 → 建账号（生产链路由桥的 _paired 触发）
    runtime.apply({ type: '_paired', account_id: 'unb-seller' }, 'unb-seller')
    runtime.apply({ type: 'frame', raw: chatFrame() }, 'unb-seller')
    const threads = store.getThreads()
    a.eq(threads.length, 1, '一帧建出一个会话')
    const th = threads[0]
    a.eq(th.platform, 'xianyu', '会话平台=xianyu')
    a.eq(th.accountId, 'unb-seller', '会话绑定账号')
    a.eq(th.conversationId, 'cid-1001', 'conversationId=chat_id')
    a.eq(th.buyerUid, 'buyer-2001', 'buyerUid')
    a.eq(th.unread, 1, '未读 +1')
    a.eq(store.getMessages(th.id).length, 1, '消息入库')
    a.eq(store.getMessages(th.id)[0].text, '你好，还在吗？', '消息正文正确')

    // 同一帧再来一次 → 按 message_id 去重
    runtime.apply({ type: 'frame', raw: chatFrame() }, 'unb-seller')
    a.eq(store.getMessages(th.id).length, 1, '重复帧按 messageId 去重')
    a.eq(store.getThread(th.id).unread, 1, '重复帧不涨未读')

    // 自己发的消息被 adapter 过滤，不落库
    runtime.apply({ type: 'frame', raw: chatFrame({ sender: 'unb-seller', messageId: 'mid-self' }) }, 'unb-seller')
    a.eq(store.getMessages(th.id).length, 1, '自消息不入库')

    // 人工回复 → send_text → 落库 by=human + 自动转人工接管
    const r = await runtime.sendHuman(th.id, '在的，马上看')
    a.eq(r.ok, true, '人工回复成功')
    const call = bridge._sent.find((x) => x.cmd.type === 'send_text')
    a.ok(Boolean(call), '下发的是 send_text')
    a.eq(call.cmd.chat_id, 'cid-1001', '定向 chat_id')
    const msgs = store.getMessages(th.id)
    a.eq(msgs[msgs.length - 1].by, 'human', '出站消息 by=human')
    a.eq(store.getThread(th.id).aiMode, 'human', '人工回复后自动转人工接管')

    // /state 形状：账号卡 + 会话行（client 半消费）
    const st = runtime.state()
    const acc = st.accounts.find((x) => x.id === 'unb-seller')
    a.ok(Boolean(acc), '/state 里有该账号卡')
    a.eq(acc.canSend, true, 'canSend=true（桥在线）')
    const row = st.threads.find((x) => x.id === th.id)
    a.eq(row.displayName, '买家甲', '会话行 displayName 用 senderNick')
  } finally {
    await teardown({ dir, ...stack })
  }
})
