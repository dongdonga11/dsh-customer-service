/**
 * 店铺 MCP 客户端（可选 · 只读）
 * ============================================================================
 *
 * 可选集成：把本机任意一个 **stdio MCP 服务**（店铺数据/库存等）当只读数据源，
 * 通过标准 JSON-RPC 调用，给 AI 回复提供实时数据。
 *
 * 协议要点：
 *   - stdio 传输是**按行分隔的 JSON**（不是 Content-Length 分帧）
 *   - 握手：initialize → notifications/initialized → tools/list / tools/call
 *   - 工具结果在 `result.content[0].text` 里，是一段 JSON 字符串
 *
 * 配置（环境变量，均可不填；都不填时该能力视为未启用）：
 *   DOUYIN_CS_SHOP_MCP          = off 可彻底关闭
 *   DOUYIN_CS_SHOP_MCP_NODE     运行 MCP 服务的 node（默认当前进程的 node）
 *   DOUYIN_CS_SHOP_MCP_TSX      tsx 的 cli 路径（可选）
 *   DOUYIN_CS_SHOP_MCP_SCRIPT   MCP 服务入口脚本
 *   DOUYIN_CS_SHOP_MCP_CWD      工作目录
 *
 * ⚠️ 安全边界（这是给"自动回复顾客"用的，必须只读）：
 *   白名单只有 `shop_state` / `stock_list`。开台/关台/改库存等写操作**绝不放进自动调用** ——
 *   顾客说一句"我到了"不该等于给 ta 开台。写操作留给人在后台手动做。
 */

import { spawn } from 'node:child_process'

/** 允许 AI 自动调用的工具（只读）。写操作故意不在里面。 */
export const READ_ONLY_TOOLS = new Set(['shop_state', 'stock_list'])

/** 默认配置（全部来自环境变量；脚本未配置时视为未启用）。 */
export const DEFAULT_SHOP_MCP = {
  command: process.env.DOUYIN_CS_SHOP_MCP_NODE || process.execPath,
  args: process.env.DOUYIN_CS_SHOP_MCP_SCRIPT
    ? [process.env.DOUYIN_CS_SHOP_MCP_TSX || '', process.env.DOUYIN_CS_SHOP_MCP_SCRIPT].filter(Boolean)
    : [],
  cwd: process.env.DOUYIN_CS_SHOP_MCP_CWD || process.cwd(),
}

export class ShopMcpClient {
  /**
   * @param {object} opts
   * @param {string} [opts.command]
   * @param {string[]} [opts.args]
   * @param {string} [opts.cwd]
   * @param {object} [opts.env]        额外环境变量（密钥走 .env.local，不从这里传）
   * @param {(msg:string)=>void} [opts.log]
   * @param {number} [opts.timeoutMs]
   */
  constructor(opts = {}) {
    this.command = opts.command || DEFAULT_SHOP_MCP.command
    this.args = opts.args || DEFAULT_SHOP_MCP.args
    this.cwd = opts.cwd || DEFAULT_SHOP_MCP.cwd
    this.env = opts.env || undefined
    this.log = opts.log || (() => {})
    this.timeoutMs = opts.timeoutMs || 12000

    this._child = null
    this._buf = ''
    this._nextId = 1
    this._pending = new Map()
    this._starting = null
    this._stderr = ''
    this._ready = false
    /** 最近一次失败原因（面板要显示"为什么拿不到店铺数据"） */
    this.lastError = ''
    this.lastOkAt = 0
  }

  get alive() {
    return Boolean(this._child && !this._child.killed && this._ready)
  }

  /** 启动并握手（并发调用只会启动一次）。 */
  ensureStarted() {
    if (this.alive) return Promise.resolve(true)
    if (this._starting) return this._starting
    this._starting = this._start()
      .then((ok) => {
        this._starting = null
        return ok
      })
      .catch((e) => {
        this._starting = null
        this.lastError = String((e && e.message) || e)
        return false
      })
    return this._starting
  }

  async _start() {
    return new Promise((resolve) => {
      let settled = false
      const done = (ok, why) => {
        if (settled) return
        settled = true
        if (!ok) this.lastError = why || '启动失败'
        resolve(ok)
      }

      if (!this.args || !this.args.length) {
        done(false, '未配置店铺 MCP（设置 DOUYIN_CS_SHOP_MCP_SCRIPT 等环境变量后启用）')
        return
      }

      let child
      try {
        child = spawn(this.command, this.args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.env ? { ...process.env, ...this.env } : process.env,
        })
      } catch (e) {
        done(false, `spawn 失败: ${(e && e.message) || e}`)
        return
      }
      this._child = child
      this._buf = ''
      this._stderr = ''

      const startupTimer = setTimeout(() => done(false, `启动握手超时（${this.timeoutMs}ms）`), this.timeoutMs)

      child.on('error', (e) => {
        clearTimeout(startupTimer)
        this._ready = false
        done(false, `子进程错误: ${(e && e.message) || e}`)
      })
      child.on('exit', (code) => {
        this._ready = false
        // 未完成的请求全部失败，避免调用方永远挂着
        for (const [, p] of this._pending) {
          clearTimeout(p.timer)
          p.resolve({ __failed: true, reason: `MCP 进程退出(code=${code})` })
        }
        this._pending.clear()
        if (!settled) {
          clearTimeout(startupTimer)
          done(false, `MCP 进程退出(code=${code}) ${this._stderr.slice(0, 200)}`)
        }
      })
      child.stderr.on('data', (d) => {
        this._stderr += d.toString()
        if (this._stderr.length > 4000) this._stderr = this._stderr.slice(-2000)
      })
      child.stdout.on('data', (d) => this._onStdout(d))

      // 握手
      this._rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-cs-legacy', version: '1.0.0' },
      })
        .then((res) => {
          if (!res || res.error) {
            clearTimeout(startupTimer)
            done(false, `initialize 失败: ${JSON.stringify(res && res.error)}`)
            return
          }
          this._notify('notifications/initialized', {})
          this._ready = true
          clearTimeout(startupTimer)
          this.log(`店铺 MCP 已就绪: ${res.result && res.result.serverInfo ? res.result.serverInfo.name : 'demo-shop-shop'}`)
          done(true)
        })
        .catch((e) => {
          clearTimeout(startupTimer)
          done(false, `initialize 异常: ${(e && e.message) || e}`)
        })
    })
  }

  _onStdout(chunk) {
    this._buf += chunk.toString()
    let i
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).trim()
      this._buf = this._buf.slice(i + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue // 非 JSON 行（有些库会打日志到 stdout）忽略
      }
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const p = this._pending.get(msg.id)
        this._pending.delete(msg.id)
        clearTimeout(p.timer)
        p.resolve(msg)
      }
    }
  }

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this._child || !this._child.stdin.writable) {
        reject(new Error('MCP 进程不可用'))
        return
      }
      const id = this._nextId++
      const timer = setTimeout(() => {
        this._pending.delete(id)
        resolve({ __failed: true, reason: `${method} 超时（${this.timeoutMs}ms）` })
      }, this.timeoutMs)
      this._pending.set(id, { resolve, timer })
      try {
        this._child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this._pending.delete(id)
        reject(e)
      }
    })
  }

  _notify(method, params) {
    try {
      this._child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch {
      /* ignore */
    }
  }

  /**
   * 调一个工具。
   * @returns {Promise<{ok:boolean, data?:any, error?:string}>}
   */
  async callTool(name, args = {}) {
    if (!READ_ONLY_TOOLS.has(name)) {
      // 双保险：即使上层传错，这里也不允许写操作
      return { ok: false, error: `工具 ${name} 不在只读白名单里，拒绝调用` }
    }
    const started = await this.ensureStarted()
    if (!started) return { ok: false, error: this.lastError || 'MCP 未启动' }

    const res = await this._rpc('tools/call', { name, arguments: args })
    if (!res || res.__failed) {
      const why = (res && res.reason) || '无响应'
      this.lastError = why
      return { ok: false, error: why }
    }
    if (res.error) {
      this.lastError = `MCP 错误: ${JSON.stringify(res.error).slice(0, 200)}`
      return { ok: false, error: this.lastError }
    }
    const text = res.result && res.result.content && res.result.content[0] && res.result.content[0].text
    let data
    try {
      data = typeof text === 'string' ? JSON.parse(text) : text
    } catch {
      return { ok: false, error: '工具结果不是 JSON', raw: String(text).slice(0, 300) }
    }
    if (res.result && res.result.isError) {
      this.lastError = (data && data.message) || '工具报错'
      return { ok: false, error: this.lastError, data }
    }
    this.lastOkAt = Date.now()
    this.lastError = ''
    return { ok: true, data }
  }

  /**
   * 读店铺状态，换算成 AI 能直接用的实时数据。
   *
   * 返回的形状和 `客服知识库/实时数据.json` 一致 —— 因为 AI 的提示词就是按那个形状
   * 写的，这样接上 MCP 后提示词一行都不用改。
   */
  async seatStatus() {
    const r = await this.callTool('shop_state', {})
    if (!r.ok) return { status: 'unknown', source: 'mcp', error: r.error }
    const tables = Array.isArray(r.data && r.data.tables) ? r.data.tables : []
    const enabled = tables.filter((t) => t.status !== 'disabled')
    const free = enabled.filter((t) => t.status === 'free')
    const busy = enabled.filter((t) => t.status === 'busy')
    // 最近会空出来的台（给"要等多久"用）
    const soon = busy
      .filter((t) => Number(t.remainMinutes) > 0)
      .sort((a, b) => Number(a.remainMinutes) - Number(b.remainMinutes))[0]
    return {
      updated_at: new Date().toISOString(),
      stale_after_sec: 120,
      seats_total: enabled.length,
      seats_free: free.length,
      status: free.length === 0 ? 'full' : free.length <= 1 ? 'tight' : 'empty',
      free_tables: free.map((t) => t.name).filter(Boolean),
      soon_free_minutes: soon ? Number(soon.remainMinutes) : null,
      source: 'mcp',
      server_now: (r.data && r.data.now) || '',
    }
  }

  stop() {
    this._ready = false
    const c = this._child
    this._child = null
    if (!c) return
    try {
      c.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      c.kill()
    } catch {
      /* ignore */
    }
  }
}
