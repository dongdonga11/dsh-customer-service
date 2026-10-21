/**
 * dsh-cs — 闲鱼消息解析与分类（纯函数，零依赖）
 * ============================================================================
 *
 * 行为对齐 Hermes：`plugins/platforms/xianyu/parser.py`（逐函数、逐关键词照搬）。
 *
 * 输入：扩展回传的**原始 WS 帧**（已 JSON.parse 的 object；闲鱼主链路是 JSON 文本帧）。
 * 输出：0..N 条标准化消息（`ParsedMessage`，字段名与 Python 版一致，便于对照）。
 *
 * 帧结构（真实形态）：
 *   普通消息：`{ "1": { "1": {"1": "<sender>@goofish"}, "2": "<chat_id>@goofish",
 *                       "5": <ms>, "6": {...}, "10": {reminderContent, senderUserId,
 *                       senderNick, reminderUrl, extJson, bizTag} },
 *              "4": {...} }`
 *   同步包：  `{ body: { syncPushPackage: { data: [ {data: <base64>}, ... ] } } }`
 *             其中 base64 解开后可能是 JSON 文本，也可能是 MessagePack(JSON)。
 *
 * 归一化约定（与 Python 版一致）：
 * - 数字/布尔等值一律用 Python `str()` 语义转字符串（None → "None"）；
 * - 任何 `AttributeError` 场景（键在但类型不对）解析结果为 null（旧实现 try/except）。
 */

import { decrypt, decryptValue } from './codec.js'

// ── 消息分类（parser.py:23-28）────────────────────────────────────────────

export const KIND_CHAT = 'chat' // 普通买家聊天 → 交 agent 回复
export const KIND_DELIVERY_TRIGGER = 'delivery_trigger' // 付款待发货 → 触发发货
export const KIND_RATE_REQUEST = 'rate_request' // 评价请求 → 触发评价
export const KIND_CONFIRM_RECEIPT = 'confirm_receipt' // 确认收货
export const KIND_CARD = 'card' // 卡片消息（小刀等）
export const KIND_SYSTEM = 'system' // 其他系统消息（跳过）

/** 自动发货触发关键词（parser.py:32-37，逐字照抄） */
export const AUTO_DELIVERY_KEYWORDS = [
  '[我已付款，等待你发货]',
  '[已付款，待发货]',
  '我已付款，等待你发货',
  '[记得及时发货]',
]

/** 评价请求关键词（parser.py:39-42；注意是**整串相等**判定，不是包含） */
export const RATE_REQUEST_KEYWORDS = ['快给ta一个评价吧~', '快给ta一个评价吧～']

/** 确认收货关键词（parser.py:44-47） */
export const CONFIRM_RECEIPT_KEYWORDS = ['[买家确认收货，交易成功]', '买家已确认收货，交易成功']

// ── 通用小工具 ─────────────────────────────────────────────────────────────

/** 等价 Python `isinstance(x, dict)`。 */
function isDict(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) && !Buffer.isBuffer(x)
}

/** 等价 Python `str(x)`（None → "None"，True/False 首字母大写）。 */
export function pyStr(value) {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * 等价 Python `dict.get(key, default)`；对象不是 dict 时**抛错**，
 * 由调用方 try/catch 转成「解析失败返回 null」——与旧实现 try/except 一致。
 */
function pyGet(obj, key, dflt) {
  if (!isDict(obj)) throw new TypeError(`not a dict: ${typeof obj}`)
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt
}

/** 键是否存在于 dict（非 dict 抛错，同 Python `in` 的 AttributeError 语义）。 */
function pyHas(obj, key) {
  if (!isDict(obj)) throw new TypeError(`not a dict: ${typeof obj}`)
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/** 安全 JSON.parse（失败返回 undefined，对应旧实现 `except: pass`）。 */
function tryJsonParse(raw) {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 等价 Python `time.strftime('%Y-%m-%d %H:%M:%S', localtime(ms/1000))`。 */
export function fmtTime(rawMs) {
  const n = Number(rawMs)
  const ms = Number.isFinite(n) && n > 0 ? n : Date.now()
  const d = new Date(ms)
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`
}

/** chat_id 形如 `<id>@goofish`：取 `@` 前一段（parser.py:226/262）。 */
function stripAt(value) {
  const s = pyStr(value)
  return s.includes('@') ? s.split('@')[0] : s
}

// ── 同步包 / 解密（parser.py:71-102）──────────────────────────────────────

/** 是否「同步包」：`body.syncPushPackage.data` 非空。 */
export function isSyncPackage(frame) {
  try {
    return (
      isDict(frame) &&
      'body' in frame &&
      isDict(frame.body) &&
      'syncPushPackage' in frame.body &&
      isDict(frame.body.syncPushPackage) &&
      'data' in frame.body.syncPushPackage &&
      Array.isArray(frame.body.syncPushPackage.data) &&
      frame.body.syncPushPackage.data.length > 0
    )
  } catch {
    return false
  }
}

/**
 * 解密同步包中的单条数据（parser.py:84-102）。
 * 先按「base64(JSON 文本)」试；解出来是含 chatType 的对象=系统消息，丢弃；
 * 否则按「base64(MessagePack(JSON))」再试。
 */
export function decryptSyncItem(syncItem) {
  if (!isDict(syncItem) || !('data' in syncItem)) return null
  const data = syncItem.data
  try {
    const decoded = Buffer.from(String(data), 'base64').toString('utf8')
    const parsed = JSON.parse(decoded)
    // 未加密消息（系统提示等）：含 chatType 的直接忽略
    if (isDict(parsed) && 'chatType' in parsed) return null
    return parsed
  } catch {
    try {
      return JSON.parse(decrypt(data))
    } catch {
      return null
    }
  }
}

// ── 消息类型判定（parser.py:106-154）──────────────────────────────────────

/** 平台营销 / 系统提示消息（`msgArg1 == MsgTips`），不应触发回复。 */
export function isSystemTipMessage(message) {
  try {
    const inner = pyGet(message, '1', undefined)
    if (!isDict(inner)) return false
    const meta = pyGet(inner, '10', undefined)
    if (!isDict(meta)) return false
    const extJson = pyGet(meta, 'extJson', '')
    if (typeof extJson !== 'string' || !extJson) return false
    const ext = JSON.parse(extJson)
    return isDict(ext) && ext.msgArg1 === 'MsgTips'
  } catch {
    return false
  }
}

/** 普通聊天消息：`message["1"]["10"]` 是 dict 且含 `reminderContent`。 */
export function isChatMessage(message) {
  try {
    return (
      isDict(message) &&
      isDict(pyGet(message, '1', undefined)) &&
      isDict(pyGet(pyGet(message, '1', {}), '10', undefined)) &&
      pyHas(pyGet(pyGet(message, '1', {}), '10', {}), 'reminderContent')
    )
  } catch {
    return false
  }
}

/** 卡片更新消息：`message["1"]` 是字符串、`message["4"]` 是 dict 且含 reminderContent。 */
export function isCardUpdateMessage(message) {
  try {
    return (
      isDict(message) &&
      typeof pyGet(message, '1', undefined) === 'string' &&
      isDict(pyGet(message, '4', undefined)) &&
      pyHas(pyGet(message, '4', {}), 'reminderContent')
    )
  } catch {
    return false
  }
}

/** 卡片消息：`message["1"]["6"]` 是 dict 且含 `"3"`。 */
export function isCardMessage(message) {
  try {
    const msg6 = pyGet(pyGet(message, '1', {}), '6', {})
    return isDict(msg6) && '3' in msg6
  } catch {
    return false
  }
}

// ── 消息 ID / 字段提取（parser.py:158-217）────────────────────────────────

/** 去重用消息 id：`1.10.bizTag|extJson` 或 `4.extJson` 里的 `messageId`。 */
export function extractMessageId(message) {
  try {
    if (!isDict(message)) return null
    const m1 = message['1']
    if (isDict(m1)) {
      const m10 = pyGet(m1, '10', {})
      if (isDict(m10)) {
        for (const key of ['bizTag', 'extJson']) {
          const raw = pyGet(m10, key, '')
          if (typeof raw === 'string' && raw) {
            const d = tryJsonParse(raw)
            if (isDict(d) && d.messageId) return d.messageId
          }
        }
      }
    }
    const m4 = message['4']
    if (isDict(m4)) {
      const raw = pyGet(m4, 'extJson', '')
      if (typeof raw === 'string' && raw) {
        const d = tryJsonParse(raw)
        if (isDict(d) && d.messageId) return d.messageId
      }
    }
  } catch {
    /* 旧实现：吞掉一切异常 */
  }
  return null
}

/** 从 `1.10` 里抽 item_id：优先 reminderUrl 的 `itemId=`，其次 bizTag/extJson。 */
export function extractItemId(message) {
  try {
    const m10 = pyGet(pyGet(message, '1', {}), '10', {})
    const urlInfo = pyGet(m10, 'reminderUrl', '')
    if (urlInfo && pyStr(urlInfo).includes('itemId=')) {
      return pyStr(urlInfo).split('itemId=')[1].split('&')[0]
    }
    for (const key of ['bizTag', 'extJson']) {
      const raw = pyGet(m10, key, '')
      if (raw) {
        const d = tryJsonParse(pyStr(raw))
        if (isDict(d) && d.itemId) return pyStr(d.itemId)
      }
    }
  } catch {
    /* 旧实现：吞掉一切异常 */
  }
  return ''
}

// ── 单条解析（parser.py:220-293）──────────────────────────────────────────

/** 普通聊天消息 → ParsedMessage（失败 null）。 */
export function parseChatMessage(message) {
  try {
    const m1 = pyGet(message, '1', {})
    const m10 = pyGet(m1, '10', {})

    const chatId = stripAt(pyGet(m1, '2', ''))
    const msgTime = fmtTime(pyGet(m1, '5', 0))

    let sendUserId
    let reminder
    let sendUserName
    if (m10 && m10.reminderContent) {
      sendUserId = pyGet(m10, 'senderUserId', 'unknown')
      reminder = pyGet(m10, 'reminderContent', '')
      sendUserName = pyGet(m10, 'senderNick', null) || pyGet(m10, 'reminderTitle', null) || '系统'
    } else {
      const m1_1 = pyGet(m1, '1', {})
      if (isDict(m1_1)) {
        sendUserId = stripAt(pyGet(m1_1, '1', ''))
      } else {
        sendUserId = 'unknown'
      }
      reminder = pyGet(pyGet(pyGet(m1, '6', {}), '3', {}), '2', '')
      sendUserName = '系统'
    }

    return {
      kind: KIND_CHAT,
      send_user_id: pyStr(sendUserId),
      send_user_name: pyStr(sendUserName),
      send_message: pyStr(reminder),
      chat_id: chatId,
      item_id: extractItemId(message),
      msg_time: msgTime,
      message_id: extractMessageId(message),
      card_title: null,
      raw: message,
    }
  } catch {
    return null
  }
}

/** 卡片更新消息 → ParsedMessage（失败 null）。 */
export function parseCardUpdateMessage(message) {
  try {
    const m4 = pyGet(message, '4', {})
    const chatId = stripAt(pyGet(message, '2', ''))
    let itemId = ''
    const urlInfo = pyGet(m4, 'reminderUrl', '')
    if (urlInfo && pyStr(urlInfo).includes('itemId=')) {
      itemId = pyStr(urlInfo).split('itemId=')[1].split('&')[0]
    }
    return {
      kind: KIND_CHAT,
      send_user_id: pyStr(pyGet(m4, 'senderUserId', 'unknown')),
      send_user_name: pyStr(pyGet(m4, 'reminderTitle', '系统')),
      send_message: pyStr(pyGet(m4, 'reminderContent', '')),
      chat_id: chatId,
      item_id: itemId,
      msg_time: fmtTime(pyGet(message, '5', 0)),
      message_id: extractMessageId(message),
      card_title: null,
      raw: message,
    }
  } catch {
    return null
  }
}

/** 卡片标题：`1.6.3.5` 里的 `dxCard.item.main.exContent.title`（缺失 → null）。 */
export function extractCardTitle(message) {
  try {
    const m6_3 = pyGet(pyGet(pyGet(message, '1', {}), '6', {}), '3', {})
    if (pyHas(m6_3, '5')) {
      const card = JSON.parse(pyGet(m6_3, '5', ''))
      return pyGet(
        pyGet(pyGet(pyGet(pyGet(card, 'dxCard', {}), 'item', {}), 'main', {}), 'exContent', {}),
        'title',
        '',
      )
    }
  } catch {
    /* 旧实现：吞掉 */
  }
  return null
}

// ── 分类（parser.py:297-308）──────────────────────────────────────────────

/** 按文本判定业务类型：发货触发（含）→ 评价请求（整串相等）→ 确认收货（含）→ 聊天。 */
export function classify(sendMessage) {
  const text = pyStr(sendMessage)
  for (const kw of AUTO_DELIVERY_KEYWORDS) if (text.includes(kw)) return KIND_DELIVERY_TRIGGER
  if (RATE_REQUEST_KEYWORDS.includes(text)) return KIND_RATE_REQUEST
  for (const kw of CONFIRM_RECEIPT_KEYWORDS) if (text.includes(kw)) return KIND_CONFIRM_RECEIPT
  return KIND_CHAT
}

// ── 顶层入口（parser.py:312-373）──────────────────────────────────────────

/** 解析单条（已解密）消息；系统/不认识的返回 null。 */
export function parseSingle(message) {
  // 过滤系统营销消息
  if (isSystemTipMessage(message)) return null

  if (isChatMessage(message)) {
    const parsed = parseChatMessage(message)
    if (!parsed) return null
    // 卡片消息（小刀等）：reminderContent 恰为「[卡片消息]」
    if (parsed.send_message === '[卡片消息]') {
      const title = extractCardTitle(message)
      if (title) {
        parsed.kind = KIND_CARD
        parsed.card_title = title
        return parsed
      }
    }
    // 普通聊天：按内容再分类（发货触发/评价/确认收货/聊天）
    parsed.kind = classify(parsed.send_message)
    return parsed
  }

  if (isCardUpdateMessage(message)) {
    const parsed = parseCardUpdateMessage(message)
    if (parsed) parsed.kind = classify(parsed.send_message)
    return parsed
  }

  if (isCardMessage(message)) {
    const title = extractCardTitle(message)
    if (title) {
      const parsed = parseChatMessage(message)
      if (parsed) {
        parsed.kind = KIND_CARD
        parsed.card_title = title
        return parsed
      }
    }
  }
  return null
}

/**
 * 解析一个原始 WS 帧，返回 0..N 条标准化消息（parser.py:313-336）。
 *
 * @param {object} frame 扩展回传的帧（已 JSON.parse）
 * @returns {Array<object>} ParsedMessage[]
 */
export function parseFrame(frame) {
  const results = []
  if (!isDict(frame)) return results

  const messages = []
  if (isSyncPackage(frame)) {
    for (const syncItem of frame.body.syncPushPackage.data) {
      if (!isDict(syncItem)) continue
      const decoded = decryptSyncItem(syncItem)
      if (isDict(decoded)) messages.push(decoded)
    }
  } else {
    messages.push(frame)
  }

  for (const message of messages) {
    const parsed = parseSingle(message)
    if (parsed) results.push(parsed)
  }
  return results
}

/** 解码辅助：给测试/诊断用（单个 sync item 的 base64 → 对象）。 */
export function decodeSyncItemValue(syncItem) {
  try {
    return decryptValue(syncItem.data)
  } catch {
    return null
  }
}

/** 与 Python 版同名类的静态方法集合（便于迁移代码直接照抄调用形式）。 */
export const XianyuMessageParser = {
  isSyncPackage,
  decryptSyncItem,
  isSystemTipMessage,
  isChatMessage,
  isCardUpdateMessage,
  isCardMessage,
  extractMessageId,
  extractItemId,
  parseChatMessage,
  parseCardUpdateMessage,
  extractCardTitle,
  classify,
  parseFrame,
  parseSingle,
  fmtTime,
}

export default XianyuMessageParser
