/**
 * dsh-cs — 闲鱼（Goofish）MessagePack 编解码（纯 JS、零依赖）
 * ============================================================================
 *
 * 行为对齐 Hermes：`plugins/platforms/xianyu/codec.py`
 *
 * 闲鱼 PC 端 WebSocket 收到的同步包里，单条消息体是 **base64(MessagePack)**；
 * 解开后通常是一段 JSON 文本（parse 后再按 "1"/"2"/"10" 这类键取值）。
 *
 * 设计取舍：
 * - 扩展只负责 hook 页面 WS、把帧原样回传（不解析）；解析集中在宿主侧一处维护。
 * - 这里不引入任何 npm 依赖（与内核其余部分一致：DSH 环境没有 msgpack 库）。
 * - **64 位整数**：MessagePack 的 uint64/int64 可能是「买家 id / 商品 id」这类
 *   超过 2^53 的值。超过安全整数范围时用 BigInt 保留精度（Python 是无损 int）；
 *   `decrypt()` 输出 JSON 字符串时再转成十进制字符串（Python json 会写成数字，
 *   但对下游 `str()` 取值语义等价）。
 */

/** 与 codec.py 同名的错误类型（便于上层区分「帧格式不对」与其它异常）。 */
export class MessagePackDecodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MessagePackDecodeError'
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** MessagePack 解码器（移植 codec.py:MessagePackDecoder，逐分支对齐）。 */
export class MessagePackDecoder {
  /** @param {Uint8Array|Buffer} data */
  constructor(data) {
    this.data = Buffer.isBuffer(data) ? data : Buffer.from(data)
    this.pos = 0
    this.length = this.data.length
  }

  readByte() {
    if (this.pos >= this.length) throw new MessagePackDecodeError('Unexpected end of data')
    const b = this.data[this.pos]
    this.pos += 1
    return b
  }

  readBytes(count) {
    if (this.pos + count > this.length) throw new MessagePackDecodeError('Unexpected end of data')
    const out = this.data.subarray(this.pos, this.pos + count)
    this.pos += count
    return out
  }

  readUint8() {
    return this.readByte()
  }
  readUint16() {
    return this.readBytes(2).readUInt16BE(0)
  }
  readUint32() {
    return this.readBytes(4).readUInt32BE(0)
  }
  /** uint64：超出安全整数时返回 BigInt（Python 无此限制）。 */
  readUint64() {
    const v = this.readBytes(8).readBigUInt64BE(0)
    return v <= MAX_SAFE ? Number(v) : v
  }
  readInt8() {
    return this.readBytes(1).readInt8(0)
  }
  readInt16() {
    return this.readBytes(2).readInt16BE(0)
  }
  readInt32() {
    return this.readBytes(4).readInt32BE(0)
  }
  /** int64：超出安全整数时返回 BigInt。 */
  readInt64() {
    const v = this.readBytes(8).readBigInt64BE(0)
    return v >= -MAX_SAFE && v <= MAX_SAFE ? Number(v) : v
  }
  readFloat32() {
    return this.readBytes(4).readFloatBE(0)
  }
  readFloat64() {
    return this.readBytes(8).readDoubleBE(0)
  }
  /** 与 Python `decode('utf-8', errors='replace')` 一致：非法字节变 U+FFFD。 */
  readString(length) {
    return this.readBytes(length).toString('utf8')
  }

  decodeValue() {
    if (this.pos >= this.length) throw new MessagePackDecodeError('Unexpected end of data')
    const fb = this.readByte()

    if (fb <= 0x7f) return fb // positive fixint
    if (fb >= 0x80 && fb <= 0x8f) return this.decodeMap(fb & 0x0f) // fixmap
    if (fb >= 0x90 && fb <= 0x9f) return this.decodeArray(fb & 0x0f) // fixarray
    if (fb >= 0xa0 && fb <= 0xbf) return this.readString(fb & 0x1f) // fixstr
    if (fb === 0xc0) return null // nil
    if (fb === 0xc2) return false
    if (fb === 0xc3) return true
    if (fb === 0xc4) return this.readBytes(this.readUint8()) // bin 8
    if (fb === 0xc5) return this.readBytes(this.readUint16()) // bin 16
    if (fb === 0xc6) return this.readBytes(this.readUint32()) // bin 32
    if (fb === 0xca) return this.readFloat32()
    if (fb === 0xcb) return this.readFloat64()
    if (fb === 0xcc) return this.readUint8()
    if (fb === 0xcd) return this.readUint16()
    if (fb === 0xce) return this.readUint32()
    if (fb === 0xcf) return this.readUint64()
    if (fb === 0xd0) return this.readInt8()
    if (fb === 0xd1) return this.readInt16()
    if (fb === 0xd2) return this.readInt32()
    if (fb === 0xd3) return this.readInt64()
    if (fb === 0xd9) return this.readString(this.readUint8()) // str 8
    if (fb === 0xda) return this.readString(this.readUint16()) // str 16
    if (fb === 0xdb) return this.readString(this.readUint32()) // str 32
    if (fb === 0xdc) return this.decodeArray(this.readUint16()) // array 16
    if (fb === 0xdd) return this.decodeArray(this.readUint32()) // array 32
    if (fb === 0xde) return this.decodeMap(this.readUint16()) // map 16
    if (fb === 0xdf) return this.decodeMap(this.readUint32()) // map 32
    if (fb >= 0xe0) return fb - 0x100 // negative fixint

    // 与 codec.py 相同：其余格式（0xc1 / fixext / ext）不支持，直接报错
    throw new MessagePackDecodeError(`Unknown format byte: ${fb.toString(16).padStart(2, '0')}`)
  }

  decodeArray(size) {
    const out = new Array(size)
    for (let i = 0; i < size; i++) out[i] = this.decodeValue()
    return out
  }

  decodeMap(size) {
    const out = {}
    for (let i = 0; i < size; i++) {
      const key = this.decodeValue()
      const value = this.decodeValue()
      out[key] = value
    }
    return out
  }

  decode() {
    return this.decodeValue()
  }
}

/**
 * base64 → 字节。对齐 codec.py 的处理顺序：
 * 非 ASCII 字符先过滤，再补 padding（Node 的 base64 解码本身宽容，补上是为一致）。
 */
export function base64ToBytes(data) {
  let s = typeof data === 'string' ? data : String(data)
  s = s.replace(/[^\x00-\x7f]/g, '')
  const pad = s.length % 4
  if (pad) s += '='.repeat(4 - pad)
  return Buffer.from(s, 'base64')
}

/** 深度归一化：BigInt → 十进制字符串；Buffer → utf8 字符串（Python bytes 序列化语义）。 */
function toJsonSafe(value, seen) {
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value === null || typeof value !== 'object') return value
  const stack = seen || new Set()
  if (stack.has(value)) return null // 防御循环引用（MessagePack 不会有，但别让 stringify 爆）
  stack.add(value)
  let out
  if (Array.isArray(value)) {
    out = value.map((v) => toJsonSafe(v, stack))
  } else {
    out = {}
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v, stack)
  }
  stack.delete(value)
  return out
}

/**
 * 解密闲鱼消息体：base64(MessagePack) → **JSON 字符串**（行为同 codec.py:decrypt）。
 *
 * @param {string|any} data base64 文本
 * @returns {string} JSON 文本（对象/数组）或标量的字符串形式
 */
export function decrypt(data) {
  const value = decryptValue(data)
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(toJsonSafe(value, new Set()))
  }
  return String(value)
}

/**
 * 同 `decrypt`，但直接返回解码后的值（内部用：避免 JSON 往返丢掉 64 位精度）。
 * 非 dict/list 的标量原样返回。
 *
 * @param {string|any} data base64 文本
 * @returns {any}
 */
export function decryptValue(data) {
  const bytes = base64ToBytes(data)
  const decoder = new MessagePackDecoder(bytes)
  return decoder.decode()
}

export default { MessagePackDecoder, MessagePackDecodeError, decrypt, decryptValue, base64ToBytes }
