/**
 * dsh-cs-legacy — protobuf 解析器（Node 重写）。
 *
 * 算法与字段号完全照搬 hermes-agent 的 plugins/platforms/douyin/protobuf_codec.py
 * （2026-08 用真实抓包样本实测验证），只做语言移植，不改变语义：
 *
 * - 抖音 frontier 帧 = Protobuf 信封 → 内层一段明文 JSON（{"text": ...}）
 * - 因为抖音随时可能改字段编号/嵌套层级，**不写死 .proto**，用「通用递归扫描」：
 *   按 wire format 递归解开，凡 length-delimited 字段就尝试当 UTF-8，命中 JSON 且
 *   含已知业务键（text / aweType / richTextInfos …）即视为消息载荷。
 * - 另有「精确字段提取」路径（字段号实测确认），拿确定值的会话 id / 发送者 / 短 id；
 *   解不出时退回启发式（正则猜），降级必须在 metadata 里可见。
 * - 上行发送走「模板替换」：抓页面自己发过的一次请求体，只换会话/正文少数字段。
 *
 * 纯 Node 内置模块，零第三方依赖（不需要 protobuf 官方库）。
 */

import { randomUUID } from 'node:crypto'

// ── wire types ──────────────────────────────────────────────────────────────
const WT_VARINT = 0
const WT_FIXED64 = 1
const WT_LENGTH_DELIMITED = 2
const WT_START_GROUP = 3 // deprecated
const WT_END_GROUP = 4 // deprecated
const WT_FIXED32 = 5

// 递归深度上限：防御畸形数据爆栈。真实帧嵌套约 3-5 层。
const MAX_DEPTH = 12
// 单帧大小上限（4MB）。
const MAX_FRAME_BYTES = 4 * 1024 * 1024

// 判定「这段 JSON 是消息载荷」的业务键。
const PAYLOAD_HINT_KEYS = new Set([
  'text',
  'aweType',
  'richTextInfos',
  'mention_users',
  'related_share_video',
])

// 心跳帧内容（扩展侧已过滤，这里二次防御）。
const HEARTBEAT_MARKERS = ['hi', 'hb']

export class ProtobufDecodeError extends Error {}
export class ProtobufEncodeError extends Error {}

/** 读一个 varint，返回 { value: bigint, pos }。 */
export function readVarint(buf, pos) {
  let result = 0n
  let shift = 0n
  const n = buf.length
  while (pos < n) {
    if (shift > 63n) throw new ProtobufDecodeError('varint 过长')
    const byte = buf[pos]
    pos += 1
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result, pos }
    shift += 7n
  }
  throw new ProtobufDecodeError('varint 意外结束')
}

/**
 * 遍历一段 Protobuf 字节，yield { fieldNo, wireType, value }。
 * value 类型：varint/fixed64 → bigint；fixed32 → number；length-delimited → Buffer。
 * 遇到无法解析的字节就停止（尽力解析未知结构，不是严格校验）。
 */
export function* iterFields(buf) {
  let pos = 0
  const n = buf.length
  while (pos < n) {
    let tag
    try {
      ;({ value: tag, pos } = readVarint(buf, pos))
    } catch {
      return
    }
    const fieldNo = Number(tag >> 3n)
    const wireType = Number(tag & 0x07n)
    if (fieldNo === 0) return // 字段编号 0 非法 → 已不是有效 protobuf

    try {
      if (wireType === WT_VARINT) {
        const r = readVarint(buf, pos)
        pos = r.pos
        yield { fieldNo, wireType, value: r.value }
      } else if (wireType === WT_FIXED64) {
        if (pos + 8 > n) return
        const value = buf.readBigUInt64LE(pos)
        pos += 8
        yield { fieldNo, wireType, value }
      } else if (wireType === WT_LENGTH_DELIMITED) {
        const len = readVarint(buf, pos)
        pos = len.pos
        const length = len.value
        if (length < 0n || pos + Number(length) > n) return
        const value = buf.subarray(pos, pos + Number(length))
        pos += Number(length)
        yield { fieldNo, wireType, value }
      } else if (wireType === WT_FIXED32) {
        if (pos + 4 > n) return
        const value = buf.readUInt32LE(pos)
        pos += 4
        yield { fieldNo, wireType, value }
      } else if (wireType === WT_START_GROUP || wireType === WT_END_GROUP) {
        return // 已废弃的 group 语法，抖音不用
      } else {
        return
      }
    } catch {
      return
    }
  }
}

// ── 载荷 JSON 识别 ───────────────────────────────────────────────────────────

function looksLikeJsonObject(raw) {
  const s = raw
  // 找第一个非空白字节
  let start = 0
  while (start < s.length && (s[start] === 0x20 || s[start] === 0x09 || s[start] === 0x0a || s[start] === 0x0d)) start += 1
  let end = s.length - 1
  while (end >= 0 && (s[end] === 0x20 || s[end] === 0x09 || s[end] === 0x0a || s[end] === 0x0d)) end -= 1
  return s[start] === 0x7b /* { */ && s[end] === 0x7d /* } */
}

function tryParseJsonPayload(raw) {
  if (!looksLikeJsonObject(raw)) return undefined
  let text
  try {
    text = raw.toString('utf8')
  } catch {
    return undefined
  }
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return undefined
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  // 必须命中至少一个业务键，否则可能是别的元数据 JSON
  if (!Object.keys(obj).some((k) => PAYLOAD_HINT_KEYS.has(k))) return undefined
  return obj
}

/** 递归扫描 Protobuf 帧，抽出所有内嵌的消息载荷 JSON。 */
export function extractJsonPayloads(frame, depth = 0) {
  if (depth > MAX_DEPTH || !frame || frame.length === 0) return []
  const found = []
  for (const { wireType, value } of iterFields(frame)) {
    if (wireType !== WT_LENGTH_DELIMITED || !Buffer.isBuffer(value)) continue
    if (value.length === 0) continue
    const payload = tryParseJsonPayload(value)
    if (payload !== undefined) {
      found.push(payload)
      continue
    }
    if (value.length >= 2) found.push(...extractJsonPayloads(value, depth + 1))
  }
  return found
}

// ── 精确字段提取 ────────────────────────────────────────────────────────────
//
// 2026-08-07 用真实下行帧实测确认的消息体内部 schema（字段号）：
//   .1 conversation_id  .2 conversation_type  .3 server_message_id
//   .4 create_us  .5 conversation_short_id  .6 message_type  .7 sender_uid
//   .8 content(JSON)  .9 repeated ext{1:key,2:value}  .10 create_time
//   .13 order_index  .14 sender_sec_uid
//
// ⚠️ .3 / .5 曾被标反（只有下行样本时无法分辨），是上行 send 请求体交叉比对纠正的。
// 标反的后果：去重键变成会话级常量，同一客户第二条消息被当重复吞掉。

const MSG_F_CONVERSATION_ID = 1
const MSG_F_CONVERSATION_TYPE = 2
const MSG_F_SERVER_MESSAGE_ID = 3
const MSG_F_CONVERSATION_CREATE_US = 4
const MSG_F_CONVERSATION_SHORT_ID = 5
const MSG_F_MESSAGE_TYPE = 6
const MSG_F_SENDER_UID = 7
const MSG_F_CONTENT = 8
const MSG_F_EXT = 9
const MSG_F_CREATE_TIME = 10
const MSG_F_ORDER_INDEX = 13
const MSG_F_SENDER_SEC_UID = 14

const KV_F_KEY = 1
const KV_F_VALUE = 2

const FRONTIER_MSG_ID_PREFIX = 'msg_'

/** 把一段 protobuf 的字段按字段号分组（repeated 字段会有多项）。 */
export function groupFields(buf) {
  const out = new Map()
  for (const { fieldNo, wireType, value } of iterFields(buf)) {
    if (!out.has(fieldNo)) out.set(fieldNo, [])
    out.get(fieldNo).push({ wireType, value })
  }
  return out
}

function first(fields, fieldNo, wireType) {
  const list = fields.get(fieldNo)
  if (!list) return undefined
  for (const item of list) if (item.wireType === wireType) return item.value
  return undefined
}

function firstStr(fields, fieldNo) {
  const raw = first(fields, fieldNo, WT_LENGTH_DELIMITED)
  if (!Buffer.isBuffer(raw)) return ''
  try {
    return raw.toString('utf8')
  } catch {
    return ''
  }
}

function firstInt(fields, fieldNo) {
  const raw = first(fields, fieldNo, WT_VARINT)
  return typeof raw === 'bigint' ? raw : undefined
}

/** 解析 repeated 的 {1: key, 2: value} 键值对（ext / 信封头部都是这个形状）。 */
function parseKvPairs(fields, fieldNo) {
  const out = {}
  const list = fields.get(fieldNo)
  if (!list) return out
  for (const { wireType, value } of list) {
    if (wireType !== WT_LENGTH_DELIMITED || !Buffer.isBuffer(value)) continue
    const inner = groupFields(value)
    const key = firstStr(inner, KV_F_KEY)
    if (!key) continue
    out[key] = firstStr(inner, KV_F_VALUE)
  }
  return out
}

/** 从 `0:<type>:<uidA>:<uidB>` 里取出两侧 uid。 */
function parseConversationParticipants(conversationId) {
  const parts = (conversationId || '').split(':')
  if (parts.length !== 4) return []
  const uids = parts.slice(2).filter((p) => /^\d+$/.test(p))
  return uids.length === 2 ? uids : []
}

// ── 陌生人判定 ─────────────────────────────────────────────────────────────
// ⚠️ 不要用 ext["s:is_stranger"]（两份真实样本里它都是 "false"）。
// 可靠信号：① content.stranger_index >= 1 ② ext["s:chat_tag"] == "stranger"
// ③ ext["s:is_stranger_message"] 非空。任一命中即陌生人。

const EXT_CHAT_TAG = 's:chat_tag'
const EXT_IS_STRANGER_MESSAGE = 's:is_stranger_message'
const EXT_IS_STRANGER_LEGACY = 's:is_stranger'
const CONTENT_STRANGER_INDEX = 'stranger_index'

function deriveIsStranger(ext, content) {
  const index = content[CONTENT_STRANGER_INDEX]
  if (typeof index === 'number' && index >= 1) return true
  if ((ext[EXT_CHAT_TAG] || '').trim().toLowerCase() === 'stranger') return true
  if ((ext[EXT_IS_STRANGER_MESSAGE] || '').trim()) return true
  if ((ext[EXT_CHAT_TAG] || '').trim()) return false
  return undefined
}

function looksLikeMessageNode(fields) {
  const content = first(fields, MSG_F_CONTENT, WT_LENGTH_DELIMITED)
  if (!Buffer.isBuffer(content) || tryParseJsonPayload(content) === undefined) return false
  const hasConversation = Boolean(firstStr(fields, MSG_F_CONVERSATION_ID))
  const hasSender = firstInt(fields, MSG_F_SENDER_UID) !== undefined
  return hasConversation || hasSender
}

function buildRecord(fields) {
  const contentRaw = first(fields, MSG_F_CONTENT, WT_LENGTH_DELIMITED)
  const content = Buffer.isBuffer(contentRaw) ? tryParseJsonPayload(contentRaw) || {} : {}
  const conversationId = firstStr(fields, MSG_F_CONVERSATION_ID)
  const senderUidInt = firstInt(fields, MSG_F_SENDER_UID)
  const senderUid = senderUidInt !== undefined ? senderUidInt.toString() : ''
  const participants = parseConversationParticipants(conversationId)

  let counterpartUid = ''
  if (participants.length === 2 && senderUid) {
    const others = participants.filter((u) => u !== senderUid)
    if (others.length === 1) counterpartUid = others[0]
  }

  const ext = parseKvPairs(fields, MSG_F_EXT)
  const serverMessageId = firstInt(fields, MSG_F_SERVER_MESSAGE_ID)
  const conversationShortId = firstInt(fields, MSG_F_CONVERSATION_SHORT_ID)

  return {
    conversation_id: conversationId,
    conversation_type: firstInt(fields, MSG_F_CONVERSATION_TYPE),
    conversation_short_id: conversationShortId !== undefined ? conversationShortId.toString() : '',
    conversation_create_us: firstInt(fields, MSG_F_CONVERSATION_CREATE_US),
    server_message_id: serverMessageId !== undefined ? serverMessageId.toString() : '',
    client_message_id: ext['s:client_message_id'] || '',
    message_type: firstInt(fields, MSG_F_MESSAGE_TYPE),
    sender_uid: senderUid,
    sender_sec_uid: firstStr(fields, MSG_F_SENDER_SEC_UID),
    participants,
    counterpart_uid: counterpartUid,
    content,
    text: content.text || '',
    create_time: firstInt(fields, MSG_F_CREATE_TIME),
    order_index: firstInt(fields, MSG_F_ORDER_INDEX),
    ext,
    chat_scene: ext['chat_scene'] || '',
    is_stranger: deriveIsStranger(ext, content),
    chat_tag: ext[EXT_CHAT_TAG] || '',
    stranger_index: content[CONTENT_STRANGER_INDEX],
    is_stranger_message: ext[EXT_IS_STRANGER_MESSAGE] || '',
    is_stranger_legacy: ext[EXT_IS_STRANGER_LEGACY] || '',
    access: ext['a:access'] || '',
    biz: ext['a:biz'] || '',
    relation_type: ext['a:relation_type'] || '',
  }
}

/** 递归定位帧里的 IM 消息节点，按字段号精确抽取结构化信息。 */
export function extractMessageRecords(frame, depth = 0) {
  if (depth > MAX_DEPTH || !frame || frame.length === 0) return []
  const found = []
  for (const { wireType, value } of iterFields(frame)) {
    if (wireType !== WT_LENGTH_DELIMITED || !Buffer.isBuffer(value)) continue
    if (value.length < 2) continue
    let fields
    try {
      fields = groupFields(value)
    } catch {
      continue
    }
    if (looksLikeMessageNode(fields)) {
      found.push(buildRecord(fields))
      continue
    }
    found.push(...extractMessageRecords(value, depth + 1))
  }
  return found
}

/** 取信封层的 frontier 消息 id（`msg_...`）。 */
export function extractFrontierMsgId(frame) {
  for (const { wireType, value } of iterFields(frame)) {
    if (wireType !== WT_LENGTH_DELIMITED || !Buffer.isBuffer(value)) continue
    if (!value.subarray(0, 4).toString('ascii') === FRONTIER_MSG_ID_PREFIX) continue
    if (!value.toString('ascii').startsWith(FRONTIER_MSG_ID_PREFIX)) continue
    const text = value.toString('ascii')
    if (text.length > FRONTIER_MSG_ID_PREFIX.length) return text
  }
  return ''
}

// ── base64 帧入口 ───────────────────────────────────────────────────────────

function isHeartbeat(frame) {
  if (frame.length > 32) return false
  return HEARTBEAT_MARKERS.some((m) => frame.includes(Buffer.from(m)))
}

function decodeB64Frame(rawB64) {
  if (!rawB64) return undefined
  let frame
  try {
    frame = Buffer.from(rawB64, 'base64')
    // base64 解码失败时 Buffer.from 不抛错，这里校验 round-trip 意义不大，
    // 与 Python 行为一致地尽量解码即可。
  } catch {
    return undefined
  }
  if (frame.length > MAX_FRAME_BYTES) return undefined
  if (isHeartbeat(frame)) return undefined
  return frame
}

/** 解码 base64 帧，返回 { records, frontierMsgId }。任何失败都返回空（不抛异常）。 */
export function decodeRecordsB64(rawB64) {
  const frame = decodeB64Frame(rawB64)
  if (frame === undefined) return { records: [], frontierMsgId: '' }
  try {
    return { records: extractMessageRecords(frame), frontierMsgId: extractFrontierMsgId(frame) }
  } catch {
    return { records: [], frontierMsgId: '' }
  }
}

/** 解码 base64 帧，返回消息载荷 JSON 列表（只要正文的降级入口）。 */
export function decodeFrameB64(rawB64) {
  const frame = decodeB64Frame(rawB64)
  if (frame === undefined) return []
  try {
    return extractJsonPayloads(frame)
  } catch {
    return []
  }
}

/** 递归收集帧里所有可解成 UTF-8 的字符串字段（调试/探针用）。 */
export function collectStrings(frame, depth = 0, minLen = 3) {
  if (depth > MAX_DEPTH || !frame || frame.length === 0) return []
  const out = []
  for (const { wireType, value } of iterFields(frame)) {
    if (wireType !== WT_LENGTH_DELIMITED || !Buffer.isBuffer(value)) continue
    if (value.length < minLen) continue
    let text
    try {
      text = value.toString('utf8')
    } catch {
      out.push(...collectStrings(value, depth + 1, minLen))
      continue
    }
    let printable = 0
    for (const ch of text) {
      const cp = ch.codePointAt(0)
      if ((cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f)) || ch === '\n' || ch === '\r' || ch === '\t') printable += 1
    }
    if (printable >= text.length * 0.8) out.push(text)
    else out.push(...collectStrings(value, depth + 1, minLen))
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 上行：send 请求体的「模板替换」
// ═══════════════════════════════════════════════════════════════════════════
//
// POST https://imapi.douyin.com/v1/message/send  Content-Type: application/x-protobuf
// URL 上无签名参数。鉴权在 body（identity_security_token 等）+ cookie。
// 所以不复算签名，也不从零构造请求体 —— 用「模板替换」：扩展存下页面自己发过的
// 一次请求体，我们只替换会话与正文相关字段，其余原封不动沿用。
//
// 上行 schema（样本 tests/fixtures/douyin/outbound_send_body.b64）：
//   8.100.1 conversation_id  8.100.2 conversation_type  8.100.3 conversation_short_id
//   8.100.4 content(JSON)  8.100.5 repeated ext kv  8.100.6 message_type
//   8.100.7 ticket  8.100.8 client_message_id
// 顶层字段 2 是请求序号（实测每次递增）。

const SEND_F_SEQUENCE = 2
const SEND_F_BODY = 8
const SEND_F_REQUEST = 100

const SEND_F_CONVERSATION_ID = 1
const SEND_F_CONVERSATION_TYPE = 2
const SEND_F_CONVERSATION_SHORT_ID = 3
const SEND_F_CONTENT = 4
const SEND_F_EXT = 5
const SEND_F_MESSAGE_TYPE = 6
const SEND_F_TICKET = 7
const SEND_F_CLIENT_MESSAGE_ID = 8

const EXT_CLIENT_MESSAGE_ID = 's:client_message_id'
const EXT_STIME = 's:stime'

function writeVarint(value) {
  let v = BigInt(value)
  if (v < 0n) throw new ProtobufEncodeError(`负数无法编码为 varint: ${value}`)
  const out = []
  while (true) {
    const byte = Number(v & 0x7fn)
    v >>= 7n
    if (v) out.push(byte | 0x80)
    else {
      out.push(byte)
      break
    }
  }
  return Buffer.from(out)
}

/** 把一段 protobuf 解成有序的 [{ fieldNo, wireType, value }] 列表（保序）。 */
export function parseTree(buf) {
  return Array.from(iterFields(buf))
}

/** 把 parseTree 的结果重新序列化。 */
export function serializeTree(fields) {
  const parts = []
  for (const { fieldNo, wireType, value } of fields) {
    const tag = writeVarint((BigInt(fieldNo) << 3n) | BigInt(wireType))
    parts.push(tag)
    if (wireType === WT_VARINT) {
      parts.push(writeVarint(value))
    } else if (wireType === WT_FIXED64) {
      const b = Buffer.alloc(8)
      b.writeBigUInt64LE(BigInt(value))
      parts.push(b)
    } else if (wireType === WT_LENGTH_DELIMITED) {
      if (!Buffer.isBuffer(value)) throw new ProtobufEncodeError(`字段 ${fieldNo} 期望 Buffer`)
      parts.push(writeVarint(value.length))
      parts.push(value)
    } else if (wireType === WT_FIXED32) {
      const b = Buffer.alloc(4)
      b.writeUInt32LE(Number(value))
      parts.push(b)
    } else {
      throw new ProtobufEncodeError(`字段 ${fieldNo} 的 wire type ${wireType} 不支持`)
    }
  }
  return Buffer.concat(parts)
}

/** 就地替换第一个匹配字段的值。不存在返回 false（不新增）。 */
function replaceFirst(fields, fieldNo, wireType, value) {
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].fieldNo === fieldNo && fields[i].wireType === wireType) {
      fields[i] = { fieldNo, wireType, value }
      return true
    }
  }
  return false
}

/** 替换 repeated ext（{1: key, 2: value}）里指定 key 的值。 */
function rewriteExt(fields, updates) {
  for (let i = 0; i < fields.length; i++) {
    const { fieldNo, wireType, value } = fields[i]
    if (fieldNo !== SEND_F_EXT || wireType !== WT_LENGTH_DELIMITED) continue
    if (!Buffer.isBuffer(value)) continue
    const inner = parseTree(value)
    let key = ''
    for (const item of inner) {
      if (item.fieldNo === KV_F_KEY && item.wireType === WT_LENGTH_DELIMITED && Buffer.isBuffer(item.value)) {
        try {
          key = item.value.toString('utf8')
        } catch {
          key = ''
        }
        break
      }
    }
    if (!(key in updates)) continue
    replaceFirst(inner, KV_F_VALUE, WT_LENGTH_DELIMITED, Buffer.from(updates[key], 'utf8'))
    fields[i] = { fieldNo, wireType, value: serializeTree(inner) }
  }
}

/**
 * 基于抓到的模板生成一条新的 send 请求体。只替换会话与正文相关字段。
 * 结构不符合预期时抛 ProtobufEncodeError（宁可发送失败也不凑可疑请求）。
 */
export function rewriteSendBody(
  template,
  {
    text,
    conversationId = '',
    conversationShortId = '',
    conversationType = undefined,
    clientMessageId = '',
    stime = '',
    ticket = '',
    sequence = undefined,
  },
) {
  if (!text) throw new ProtobufEncodeError('text 不能为空')

  const top = parseTree(template)
  if (sequence !== undefined) replaceFirst(top, SEND_F_SEQUENCE, WT_VARINT, sequence)

  let bodyRaw = null
  let bodyIndex = -1
  for (let i = 0; i < top.length; i++) {
    const { fieldNo, wireType, value } = top[i]
    if (fieldNo === SEND_F_BODY && wireType === WT_LENGTH_DELIMITED && Buffer.isBuffer(value)) {
      bodyRaw = value
      bodyIndex = i
      break
    }
  }
  if (bodyRaw === null) throw new ProtobufEncodeError(`模板里找不到 body 字段 ${SEND_F_BODY}`)

  const body = parseTree(bodyRaw)
  let requestRaw = null
  let requestIndex = -1
  for (let i = 0; i < body.length; i++) {
    const { fieldNo, wireType, value } = body[i]
    if (fieldNo === SEND_F_REQUEST && wireType === WT_LENGTH_DELIMITED && Buffer.isBuffer(value)) {
      requestRaw = value
      requestIndex = i
      break
    }
  }
  if (requestRaw === null) throw new ProtobufEncodeError(`模板里找不到 request 字段 ${SEND_F_REQUEST}`)

  const request = parseTree(requestRaw)

  // 正文：保留模板 content 里除 text 以外的所有键，只换 text。
  const contentRaw = first(groupFields(requestRaw), SEND_F_CONTENT, WT_LENGTH_DELIMITED)
  let content = {}
  if (Buffer.isBuffer(contentRaw)) {
    try {
      const loaded = JSON.parse(contentRaw.toString('utf8'))
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) content = loaded
    } catch {
      content = {}
    }
  }
  if (!content || Object.keys(content).length === 0) throw new ProtobufEncodeError('模板 content 解析失败，拒绝凭空构造')
  content.text = text
  if (!replaceFirst(request, SEND_F_CONTENT, WT_LENGTH_DELIMITED, Buffer.from(JSON.stringify(content), 'utf8'))) {
    throw new ProtobufEncodeError('模板里找不到 content 字段')
  }

  if (conversationId) {
    if (!replaceFirst(request, SEND_F_CONVERSATION_ID, WT_LENGTH_DELIMITED, Buffer.from(conversationId, 'utf8'))) {
      throw new ProtobufEncodeError('模板里找不到 conversation_id 字段')
    }
  }
  if (conversationShortId) {
    if (!/^\d+$/.test(conversationShortId)) {
      throw new ProtobufEncodeError(`conversation_short_id 必须是数字: ${conversationShortId}`)
    }
    if (!replaceFirst(request, SEND_F_CONVERSATION_SHORT_ID, WT_VARINT, BigInt(conversationShortId))) {
      throw new ProtobufEncodeError('模板里找不到 conversation_short_id 字段')
    }
  }
  if (conversationType !== undefined) replaceFirst(request, SEND_F_CONVERSATION_TYPE, WT_VARINT, conversationType)
  if (ticket) replaceFirst(request, SEND_F_TICKET, WT_LENGTH_DELIMITED, Buffer.from(ticket, 'utf8'))

  // 每条消息必须换新的 client_message_id，否则服务端按幂等去重。
  if (!clientMessageId) clientMessageId = randomUUID()
  replaceFirst(request, SEND_F_CLIENT_MESSAGE_ID, WT_LENGTH_DELIMITED, Buffer.from(clientMessageId, 'utf8'))

  if (!stime) stime = Date.now().toFixed(4)
  rewriteExt(request, { [EXT_CLIENT_MESSAGE_ID]: clientMessageId, [EXT_STIME]: stime })

  body[requestIndex] = { fieldNo: SEND_F_REQUEST, wireType: WT_LENGTH_DELIMITED, value: serializeTree(request) }
  top[bodyIndex] = { fieldNo: SEND_F_BODY, wireType: WT_LENGTH_DELIMITED, value: serializeTree(body) }
  return serializeTree(top)
}

/** 读出模板里的关键字段，供诊断与「这个模板能不能发给目标会话」的判断。 */
export function describeSendTemplate(template) {
  try {
    const top = groupFields(template)
    const bodyRaw = first(top, SEND_F_BODY, WT_LENGTH_DELIMITED)
    if (!Buffer.isBuffer(bodyRaw)) return {}
    const body = groupFields(bodyRaw)
    const requestRaw = first(body, SEND_F_REQUEST, WT_LENGTH_DELIMITED)
    if (!Buffer.isBuffer(requestRaw)) return {}
    const request = groupFields(requestRaw)
    const shortId = firstInt(request, SEND_F_CONVERSATION_SHORT_ID)
    return {
      conversation_id: firstStr(request, SEND_F_CONVERSATION_ID),
      conversation_type: firstInt(request, SEND_F_CONVERSATION_TYPE),
      conversation_short_id: shortId !== undefined ? shortId.toString() : '',
      message_type: firstInt(request, SEND_F_MESSAGE_TYPE),
      ticket: firstStr(request, SEND_F_TICKET),
      client_message_id: firstStr(request, SEND_F_CLIENT_MESSAGE_ID),
      ext: parseKvPairs(request, SEND_F_EXT),
    }
  } catch {
    return {}
  }
}

// ── 发送响应解析 ───────────────────────────────────────────────────────────
//
// 2026-08-07 实测确认（样本 tests/fixtures/douyin/send_response_ok.b64）：
//   1 cmd 回显  2 序号回显  3 status_code(0=成功)  4 status_message("OK")
//   6.100.1 server_message_id  6.100.4 client_message_id 回显  7 logid  13 自己的 uid
// 成功判据要严：status 0 **且** 真的拿到了 server_message_id。

const RESP_F_CMD = 1
const RESP_F_SEQUENCE = 2
const RESP_F_STATUS_CODE = 3
const RESP_F_STATUS_MESSAGE = 4
const RESP_F_BODY = 6
const RESP_F_LOGID = 7
const RESP_F_SELF_UID = 13

const RESP_BODY_F_INNER = 100
const RESP_INNER_F_SERVER_MESSAGE_ID = 1
const RESP_INNER_F_CLIENT_MESSAGE_ID = 4

/**
 * 把一段字节**结构性地**列出来：每个字段的号 / wire type / 值或长度。
 *
 * 为什么需要：`status=null` 这种错误只说明「没解析出 status_code」，
 * 但看不出响应体到底是什么形状。有了字段 dump，一眼就能看出是
 * protobuf 换了字段号、还是根本返回了 JSON/HTML。
 */
export function dumpFields(buf, max = 24) {
  const out = []
  if (!Buffer.isBuffer(buf) || buf.length === 0) return out
  try {
    for (const { fieldNo, wireType, value } of iterFields(buf)) {
      const item = { field: fieldNo, wt: wireType }
      if (typeof value === 'bigint') item.varint = value.toString()
      else if (Buffer.isBuffer(value)) {
        item.len = value.length
        // 短的且可打印 → 直接给文本，方便认出 JSON / 错误页
        const txt = value.toString('utf8')
        if (/^[\x20-\x7e\u4e00-\u9fa5\s]*$/.test(txt) && txt.trim()) item.text = txt.slice(0, 120)
        else item.hex = value.subarray(0, 24).toString('hex')
      }
      out.push(item)
      if (out.length >= max) break
    }
  } catch {
    /* 结构坏掉时返回已拿到的部分 */
  }
  return out
}

/** 响应体是不是文本（JSON / HTML 错误页），是就给预览。 */
function textPreview(buf, limit = 200) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return ''
  const head = buf.subarray(0, limit)
  let printable = 0
  for (const b of head) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0x80) printable += 1
  if (printable / head.length < 0.9) return ''
  return head.toString('utf8')
}

export function parseSendResponse(raw) {
  const out = {
    ok: false,
    status_code: null,
    status_message: '',
    server_message_id: '',
    client_message_id: '',
    logid: '',
    self_uid: '',
    sequence: null,
    /** 诊断用（解析不出东西时靠它定位） */
    raw_len: 0,
    raw_hex: '',
    raw_text: '',
    field_dump: [],
  }
  if (!raw || raw.length === 0) {
    out.status_message = '空响应'
    return out
  }
  out.raw_len = raw.length
  out.raw_hex = raw.subarray(0, 48).toString('hex')
  out.raw_text = textPreview(raw)

  // ① 先试 JSON —— 网关/风控返回错误时常常是 JSON 而不是 protobuf。
  //    不先判这个，protobuf 解析会在 JSON 字节上跑出"没有 field 3"的假象。
  const text = out.raw_text.trim()
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const j = JSON.parse(out.raw_text)
      const code = j.status_code ?? j.status ?? j.code ?? j.err_no
      out.status_code = code === undefined || code === null ? null : Number(code)
      out.status_message = String(j.status_message || j.status_msg || j.message || j.msg || j.description || '')
      out.logid = String(j.log_id || j.logid || '')
      const sid = j.server_message_id || (j.data && (j.data.server_message_id || j.data.msg_id))
      out.server_message_id = sid ? String(sid) : ''
      out.ok = out.status_code === 0 && Boolean(out.server_message_id)
      if (!out.ok && !out.status_message) out.status_message = `JSON 响应但无明确状态 (status=${out.status_code})`
      out.field_dump = [{ json: true }]
      return out
    } catch {
      /* 不是合法 JSON，继续按 protobuf 试 */
    }
  }

  // ② protobuf
  let top
  try {
    top = groupFields(raw)
  } catch (e) {
    out.status_message = `响应无法按 protobuf 解析: ${e}`
    out.field_dump = dumpFields(raw)
    return out
  }
  out.field_dump = dumpFields(raw)

  const statusCode = firstInt(top, RESP_F_STATUS_CODE)
  const selfUid = firstInt(top, RESP_F_SELF_UID)
  out.status_code = statusCode !== undefined ? Number(statusCode) : null
  out.status_message = firstStr(top, RESP_F_STATUS_MESSAGE)
  out.logid = firstStr(top, RESP_F_LOGID)
  out.sequence = firstInt(top, RESP_F_SEQUENCE)
  out.self_uid = selfUid !== undefined ? selfUid.toString() : ''

  const bodyRaw = first(top, RESP_F_BODY, WT_LENGTH_DELIMITED)
  if (Buffer.isBuffer(bodyRaw)) {
    const innerRaw = first(groupFields(bodyRaw), RESP_BODY_F_INNER, WT_LENGTH_DELIMITED)
    if (Buffer.isBuffer(innerRaw)) {
      const inner = groupFields(innerRaw)
      const serverId = firstInt(inner, RESP_INNER_F_SERVER_MESSAGE_ID)
      out.server_message_id = serverId !== undefined ? serverId.toString() : ''
      out.client_message_id = firstStr(inner, RESP_INNER_F_CLIENT_MESSAGE_ID)
    }
  }

  out.ok = out.status_code === 0 && Boolean(out.server_message_id)
  if (!out.ok && !out.status_message) {
    // 兜底信息要**带形状**，否则只有一句"发送未成功"根本没法排查
    const shape = out.field_dump.map((f) => `${f.field}:${f.wt}`).join(',') || '(无字段)'
    out.status_message = `发送未成功 (status=${out.status_code}) 响应字段=[${shape}] len=${out.raw_len}`
  }
  return out
}
