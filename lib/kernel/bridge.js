/**
 * dsh-cs kernel — 通用本地 WebSocket 桥（寄生平台共用；Node 实现）。
 *
 * 协议与 hermes-agent 的 plugins/platforms/douyin/bridge.py 完全一致：
 * - 在 127.0.0.1:8766 起 WebSocket server，等 Chrome 扩展接入
 * - 校验配对码（防本机其他程序乱连）
 * - 把扩展上报的消息回调给上层；把上层的指令下发给扩展
 * - 支持需要返回值的指令：req_id + Promise 关联响应
 *
 * DSH 环境里没有 `ws` 库（profile node_modules 与 runtime deps 均无），所以
 * 这里手写一个只覆盖扩展实际用到的子集（文本帧 / close / ping-pong）的
 * RFC6455 服务端。扩展只发 JSON 文本小帧，无需二进制分片、无压缩扩展。
 */

import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// ── 最小 WebSocket 服务端 ────────────────────────────────────────────────────

const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/**
 * 一个已握手的 WebSocket 连接。
 * 只处理 text / close / ping / pong；扩展发的是小 JSON，不需要分片重组。
 */
class WsConnection {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.closed = false
    this.onMessage = null
    this.onClose = null
    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('error', () => this._close())
    socket.on('close', () => this._close())
  }

  send(obj) {
    if (this.closed || this.socket.destroyed) return false
    try {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8')
      this.socket.write(this._frame(OP_TEXT, payload))
      return true
    } catch {
      return false
    }
  }

  close() {
    if (this.closed) return
    try {
      this.socket.write(this._frame(OP_CLOSE, Buffer.alloc(0)))
      this.socket.end()
    } catch {
      /* ignore */
    }
    this._close()
  }

  _frame(opcode, payload) {
    const head = Buffer.from([0x80 | opcode])
    if (payload.length < 126) {
      return Buffer.concat([head, Buffer.from([payload.length]), payload])
    }
    if (payload.length < 65536) {
      const len = Buffer.alloc(2)
      len.writeUInt16BE(payload.length)
      return Buffer.concat([head, Buffer.from([126]), len, payload])
    }
    const len = Buffer.alloc(8)
    len.writeBigUInt64BE(BigInt(payload.length))
    return Buffer.concat([head, Buffer.from([127]), len, payload])
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    // 循环解析：每次尝试读一个完整帧
    for (;;) {
      const frame = this._tryReadFrame()
      if (frame === null) break // 数据不够，等下一块
      this._handleFrame(frame)
      if (this.closed) break
    }
  }

  _tryReadFrame() {
    const buf = this.buffer
    if (buf.length < 2) return null
    const b0 = buf[0]
    const b1 = buf[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < offset + 2) return null
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) return null
      const big = buf.readBigUInt64BE(offset)
      offset += 8
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null // 拒绝超大帧
      len = Number(big)
    }
    let maskKey = null
    if (masked) {
      if (buf.length < offset + 4) return null
      maskKey = buf.subarray(offset, offset + 4)
      offset += 4
    }
    if (buf.length < offset + len) return null
    let payload = buf.subarray(offset, offset + len)
    this.buffer = buf.subarray(offset + len)

    if (masked && maskKey) {
      const unmasked = Buffer.alloc(payload.length)
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i & 3]
      payload = unmasked
    }
    return { fin, opcode, payload }
  }

  _handleFrame(frame) {
    const { opcode, payload } = frame
    if (opcode === OP_TEXT) {
      if (this.onMessage) {
        try {
          this.onMessage(JSON.parse(payload.toString('utf8')))
        } catch {
          /* 非 JSON 文本帧忽略 */
        }
      }
    } else if (opcode === OP_CLOSE) {
      this.close()
    } else if (opcode === OP_PING) {
      // 回 pong（payload 原样）
      try {
        this.socket.write(this._frame(OP_PONG, payload))
      } catch {
        /* ignore */
      }
    } else if (opcode === OP_PONG) {
      // 忽略
    }
    // 其余 opcode（binary / continuation）扩展不用，忽略
  }

  _close() {
    if (this.closed) return
    this.closed = true
    if (this.onClose) {
      try {
        this.onClose()
      } catch {
        /* ignore */
      }
    }
    try {
      this.socket.destroy()
    } catch {
      /* ignore */
    }
  }
}

// ── 桥 ──────────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8766

export class CsBridge {
  /**
   * @param {object} opts
   * @param {string} [opts.host]            监听地址（默认 127.0.0.1，不要暴露公网）
   * @param {number} [opts.port]            监听端口（来自平台 spec.defaultPort）
   * @param {string} [opts.pairCode]        配对码（为空则随机生成）
   * @param {string} [opts.defaultPlatform] 未标注平台的消息归属（平台 spec.name）
   * @param {string} [opts.label]           日志前缀（平台 label）
   */
  constructor({ host = '127.0.0.1', port = DEFAULT_PORT, pairCode = '', defaultPlatform = 'douyin', label = 'cs' } = {}) {
    this.host = host
    this.port = port
    this.defaultPlatform = defaultPlatform
    this.label = label
    // 配对码：未提供则随机生成
    this.pairCode = pairCode || randomUUID().replace(/-/g, '').slice(0, 16)
    this.generatedPairCode = !pairCode
    this._validPairCodes = new Set([this.pairCode])
    this._connections = new Map() // accountId -> WsConnection
    this._accountExt = new Map() // accountId -> { version, features }
    this._pending = new Map() // reqId -> { resolve, timer }
    this._inboundHandler = null
    this._server = null
    this._running = false
  }

  get isConnected() {
    return this._running && this._connections.size > 0
  }

  get connections() {
    return Array.from(this._connections.keys())
  }

  addPairCode(code) {
    if (code) this._validPairCodes.add(String(code))
  }

  removePairCode(code) {
    if (code && String(code) !== this.pairCode) this._validPairCodes.delete(String(code))
  }

  setInboundHandler(fn) {
    this._inboundHandler = fn
  }

  hasAccount(accountId) {
    return this._connections.has(accountId)
  }

  /** 该账号属于哪个平台；未知时归到本桥的默认平台。 */
  platformOf(accountId) {
    const info = this._accountExt.get(accountId)
    return (info && info.platform) || this.defaultPlatform
  }

  /** 某平台下已注册的账号 id 列表。 */
  accountsOfPlatform(platform) {
    const out = []
    for (const [acct, info] of this._accountExt) {
      if (((info && info.platform) || this.defaultPlatform) === platform) out.push(acct)
    }
    return out
  }

  /**
   * 注册一个「同一条连接上的额外平台账号」。
   *
   * 为什么要这样：一个浏览器 profile 里，抖音私信和来客客服是同一个扩展实例、
   * 同一条 WebSocket。但它们是两个不同的账号（平台不同、会话空间不同），
   * 所以把两个 account_id 都映射到同一条连接上，靠 platform 区分路由。
   */
  registerPlatformAccount({ connection, accountId, platform, nickname, detectedId }) {
    if (!connection || !accountId) return false
    this._connections.set(accountId, connection)
    this._accountExt.set(accountId, {
      version: String((this._accountExt.get(accountId) || {}).version || 'unknown'),
      features: (this._accountExt.get(accountId) || {}).features || [],
      platform: String(platform || this.defaultPlatform),
      nickname: String(nickname || ''),
      detectedId: String(detectedId || ''),
    })
    return true
  }

  extensionInfo(accountId = '') {
    if (accountId && this._accountExt.has(accountId)) return this._accountExt.get(accountId)
    if (this._accountExt.size === 1) return this._accountExt.values().next().value
    return { version: 'unknown', features: [] }
  }

  supports(feature, accountId = '') {
    const info = this.extensionInfo(accountId)
    const feats = info.features || []
    if (feats.length === 0) return undefined
    return feats.includes(feature)
  }

  start() {
    if (this._running) return true
    return new Promise((resolve) => {
      this._server = createServer()
      this._server.on('upgrade', (req, socket, head) => {
        if (head && head.length > 0) {
          // 首个 upgrade 报文里若带了数据，塞回 socket（扩展不会带，防御性处理）
          socket.unshift(head)
        }
        this._handleUpgrade(req, socket)
      })
      this._server.on('error', (err) => {
        console.error(`[${this.label}] 桥监听 ${this.host}:${this.port} 失败: ${err.message}`)
        this._running = false
        resolve(false)
      })
      this._server.listen(this.port, this.host, () => {
        this._running = true
        if (this.generatedPairCode) {
          console.warn(`[${this.label}] 扩展配对码: ${this.pairCode}  —— ws://${this.host}:${this.port}/ws`)
        } else {
          console.log(`[${this.label}] 桥已启动 ws://${this.host}:${this.port}/ws`)
        }
        resolve(true)
      })
    })
  }

  /**
   * 停止桥并**等待端口真正释放**。
   *
   * 为什么必须 await：DSH 的 HMR 重载会先 dispose 旧插件再启动新插件，
   * 旧的 `server.close()` 是异步的（回调驱动）。不等它完成就重新 listen 会
   * 撞 EADDRINUSE，表现为「改完代码热重载后桥再也起不来」。
   */
  async stop() {
    this._running = false
    for (const ws of this._connections.values()) {
      try { ws.close() } catch { /* ignore */ }
    }
    this._connections.clear()
    for (const { resolve } of this._pending.values()) {
      resolve({ ok: false, error: '桥已停止' })
    }
    this._pending.clear()
    const server = this._server
    this._server = null
    if (!server) return
    await new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      // 先请求关闭（不再接受新连接）
      try { server.close(finish) } catch { finish() }
      // 兜底：已建立的长连接不主动断，close 回调永远不来 → 强制断开（Node 18+）
      try { server.closeAllConnections?.() } catch { /* ignore */ }
      const t = setTimeout(finish, 3000)
      if (typeof t.unref === 'function') t.unref()
    })
  }

  _handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key']
    const upgrade = (req.headers.upgrade || '').toLowerCase()
    if (upgrade !== 'websocket' || !key) {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const ws = new WsConnection(socket)
    ws.onMessage = (msg) => this._onMessage(ws, msg)
    ws.onClose = () => this._onClose(ws)
  }

  _onClose(ws) {
    // 一条连接上可能挂了多个账号（抖音 + 来客），全部摘掉 ——
    // 只删第一个会让剩下的账号一直显示「已连接」。
    const gone = []
    for (const [accountId, conn] of [...this._connections]) {
      if (conn === ws) {
        this._connections.delete(accountId)
        gone.push(accountId)
      }
    }
    for (const accountId of gone) {
      console.log(`[${this.label}] 扩展断开，账号: ${accountId}`)
      if (this._inboundHandler) {
        try {
          this._inboundHandler({ type: '_disconnected', account_id: accountId }, accountId)
        } catch {
          /* ignore */
        }
      }
    }
  }

  _onMessage(ws, data) {
    if (!data || typeof data !== 'object' || !data.type) return
    // 未配对前只接受 hello + 有效配对码
    let accountId = null
    for (const [acct, conn] of this._connections) {
      if (conn === ws) {
        accountId = acct
        break
      }
    }

    if (accountId === null) {
      const code = data.pair_code
      if (data.type !== 'hello' || !this._validPairCodes.has(String(code))) {
        ws.send({ type: 'hello_ack', ok: false })
        ws.close()
        return
      }
      accountId = String(data.account_id || 'default')
      this._connections.set(accountId, ws)
      this._accountExt.set(accountId, {
        version: String(data.ext_version || 'unknown'),
        features: Array.isArray(data.features) ? data.features.map(String) : [],
        platform: String(data.platform || this.defaultPlatform),
      })
      ws.send({ type: 'hello_ack', ok: true })
      console.log(`[${this.label}] 扩展已配对，账号: ${accountId}`)
      if (this._inboundHandler) {
        try {
          this._inboundHandler({ type: '_paired', account_id: accountId, pair_code: String(code) }, accountId)
        } catch {
          /* ignore */
        }
      }
      return
    }

    // ── 自愈：按消息里自带的平台标记注册账号 ──────────────────────────────
    // 内容脚本的 platform_account 是**一次性** fire-and-forget：来客页面在
    // document_start 就发，如果那一刻桥还没连上（DSH 刚启动 / 正在重连），
    // trySend 会**静默丢弃**，注册就永远丢了。
    // 后果很隐蔽：之后每条 laike_sync 都自带 account_id，但桥里查不到它，
    // 就回退记到抖音账号名下 —— 表现为「抖音平台下挂着来客的 33 个会话、
    // 账号名还是某个买家的昵称」，而会话自己的 platform 又是来客，两边不一致。
    // 所以这里不依赖那一次通知：任何带 platform + account_id 的消息都补注册。
    const claimedId = data.account_id ? String(data.account_id) : ''
    const claimedPlatform = data.platform ? String(data.platform) : ''
    if (
      claimedId &&
      claimedPlatform &&
      data.type !== 'hello' &&
      claimedId !== accountId &&
      this._connections.get(claimedId) !== ws
    ) {
      this.registerPlatformAccount({ connection: ws, accountId: claimedId, platform: claimedPlatform })
      console.log(`[${this.label}] 自愈注册平台账号: ${claimedPlatform} / ${claimedId}（来自 ${data.type}）`)
    }

    // 同一条连接上挂着多个平台账号（抖音私信 + 来客客服）时，按消息自带的
    // account_id 归属，避免把来客的消息记到抖音账号名下。
    if (claimedId && this._connections.get(claimedId) === ws) accountId = claimedId

    // 内容脚本上报「本页属于哪个平台账号」→ 注册成同一条连接上的第二账号
    if (data.type === 'platform_account') {
      const extraId = String(data.account_id || '')
      if (extraId && extraId !== accountId) {
        this.registerPlatformAccount({
          connection: ws,
          accountId: extraId,
          platform: data.platform,
          nickname: data.nickname,
          detectedId: data.detected_id,
        })
        console.log(`[${this.label}] 注册平台账号: ${data.platform} / ${extraId}`)
        accountId = extraId
      }
    }

    this._dispatchInbound(data, accountId)
  }

  _dispatchInbound(data, accountId) {
    const type = data.type
    // call_api 的响应：解决对应 Promise
    if (type === 'api_result') {
      const p = this._pending.get(data.req_id)
      if (p) {
        this._pending.delete(data.req_id)
        clearTimeout(p.timer)
        p.resolve(data.data)
      }
      return
    }
    // 带 ack 的指令真实结果
    if (type === 'cmd_result') {
      const p = this._pending.get(data.req_id)
      if (p) {
        this._pending.delete(data.req_id)
        clearTimeout(p.timer)
        const out = { ...data }
        delete out.type
        delete out.req_id
        out.ok = Boolean(data.ok)
        out.error = String(data.error || '')
        p.resolve(out)
      }
      return
    }
    if (this._inboundHandler) {
      try {
        this._inboundHandler(data, accountId)
      } catch (e) {
        console.error(`[${this.label}] 入站处理失败: ${e}`)
      }
    }
  }

  /** 向指定账号扩展下发指令（fire-and-forget）。 */
  sendCommand(command, accountId = 'default') {
    let ws = this._connections.get(accountId)
    if (!ws) {
      if (this._connections.size === 1) ws = this._connections.values().next().value
      else return false
    }
    return ws.send(command)
  }

  /** 下发指令并等扩展回报真实结果（cmd_result）。 */
  sendCommandAck(command, accountId = 'default', timeout = 25000) {
    return new Promise((resolve) => {
      const reqId = randomUUID().replace(/-/g, '')
      const timer = setTimeout(() => {
        this._pending.delete(reqId)
        resolve({ ok: false, error: '扩展处理超时(页面无响应)' })
      }, timeout)
      this._pending.set(reqId, { resolve, timer })

      const cmd = { ...command, req_id: reqId, ack: true }
      const ok = this.sendCommand(cmd, accountId)
      if (!ok) {
        this._pending.delete(reqId)
        clearTimeout(timer)
        resolve({ ok: false, error: '扩展未接入或下发失败' })
      }
    })
  }

  /** 下发需要返回值的指令，等待 api_result。超时返回 undefined。 */
  callApi(action, args, accountId = 'default', timeout = 20000) {
    return new Promise((resolve) => {
      const reqId = randomUUID().replace(/-/g, '')
      const timer = setTimeout(() => {
        this._pending.delete(reqId)
        resolve(undefined)
      }, timeout)
      this._pending.set(reqId, { resolve, timer })

      const ok = this.sendCommand({ type: 'call_api', req_id: reqId, action, args }, accountId)
      if (!ok) {
        this._pending.delete(reqId)
        clearTimeout(timer)
        resolve(undefined)
      }
    })
  }
}
