/**
 * dsh-cs kernel — HTTP 路由（平台无关）
 *
 * 把客服台的全部读写接口挂到宿主 webServer 上。**路由路径与旧插件
 * `lib/_legacy/index.js` 662–1187 逐字一致**（只换前缀），client 半不改也能跑。
 * 唯一新增路径是 `/diag`（排障用，旧版没有）。
 *
 * 约定：
 * - 所有 handler 都走统一鉴权 `auth.check(req)` 与统一错误包装（500 + 结构化错误）
 * - JSON body 上限 1MB
 * - SSE 通过 runtime 的事件总线转发，断开即清理订阅
 */

const MAX_BODY_BYTES = 1024 * 1024

/**
 * 挂载路由。
 *
 * @param {object} opts
 * @param {object} opts.webServer   宿主 webServer（提供 register({kind,path,handler})）
 * @param {object} opts.runtime     lib/kernel/runtime.js 的返回值
 * @param {string} [opts.prefix]    路径前缀（默认 '/dsh-cs'）；旧版是 '/dsh-cs-legacy'
 * @param {object|Function} [opts.auth] 鉴权：{check(req)} / 函数；返回 false 或 {ok:false} 时 401
 * @param {object} [opts.log]       日志器
 * @returns {{routes: Array, dispose: Function}}
 */
export function mountRoutes(opts = {}) {
  const { webServer, runtime } = opts
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('mountRoutes: 缺少 webServer.register')
  }
  if (!runtime) throw new Error('mountRoutes: 缺少 runtime')

  const log = normalizeLog(opts.log)
  const prefix = normalizePrefix(opts.prefix === undefined ? '/dsh-cs' : opts.prefix)
  const prefixes = prefix ? [prefix] : ['']
  const auth = opts.auth || null
  let authWarned = false

  const json = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  const readBody = (req) =>
    new Promise((accept, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.trim().length === 0) return accept({})
        try {
          accept(JSON.parse(raw))
        } catch {
          reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }))
        }
      })
      req.on('error', reject)
    })

  /**
   * 统一鉴权：只有显式 false / {ok:false} 才拒绝。
   *
   * 失败一律回 **401**（M1 规格 §1.3「失败 401」）：调用方若额外给了 status
   * （比如装配层想区分 403 origin mismatch），只写日志诊断，不改响应码 ——
   * client 半统一按 401 处理，避免两套语义。
   */
  function authorized(req) {
    if (!auth) return { ok: true }
    let r
    try {
      if (typeof auth === 'function') r = auth(req)
      else if (typeof auth.check === 'function') r = auth.check(req)
      else if (typeof auth.verify === 'function') r = auth.verify(req)
      else r = true
    } catch (e) {
      log.warn(`鉴权异常（按拒绝处理）: ${(e && e.message) || e}`)
      return { ok: false, reason: 'auth-error' }
    }
    if (r === undefined) {
      if (!authWarned) {
        authWarned = true
        log.warn('auth.check() 返回 undefined —— 视为放行（本地回环默认信任）')
      }
      return { ok: true }
    }
    if (r === false) return { ok: false, reason: 'rejected' }
    if (r && r.ok === false) return { ok: false, reason: String(r.reason || 'rejected'), status: r.status }
    return { ok: true }
  }

  /** 包装 handler：鉴权 → 异常统一 500。 */
  function wrap(path, handler) {
    return async (req, res) => {
      const verdict = authorized(req)
      if (!verdict.ok) {
        log.warn(`拒绝请求 ${path}${verdict.reason ? `（${verdict.reason}）` : ''}`)
        json(res, 401, { ok: false, error: 'unauthorized' })
        return
      }
      try {
        await handler(req, res)
      } catch (e) {
        const status = (e && e.statusCode) || 500
        json(res, status, { ok: false, error: String((e && e.message) || e) })
      }
      void path
    }
  }

  function requireMethod(req, res, method) {
    if (String(req.method || '').toUpperCase() === method) return true
    json(res, 405, { ok: false, error: 'method-not-allowed' })
    return false
  }

  const query = (req) => new URL(req.url ?? '/', 'http://localhost')

  // ── 各接口的实现（不含前缀） ──────────────────────────────────────────────

  /** 状态总览：账号卡 + 会话列表 + 桥状态（旧 `/state` 逐字段一致）。 */
  const hState = (req, res) => {
    json(res, 200, runtime.state())
  }

  /** 打开会话：顺带标已读（旧 `/thread`）。 */
  const hThread = (req, res) => {
    const id = query(req).searchParams.get('id') || ''
    const view = runtime.threadView(id)
    if (!view) {
      json(res, 404, { ok: false, error: 'not-found' })
      return
    }
    json(res, 200, { ok: true, thread: view.thread, messages: view.messages })
  }

  /** 人工发送（旧 `/send`）：成功即落库 + 默认转人工接管。 */
  const hSend = async (req, res) => {
    const body = await readBody(req)
    const threadId = String(body.threadId || '')
    const text = String(body.text || '').trim()
    if (!threadId || !text) {
      json(res, 400, { ok: false, error: 'need threadId and text' })
      return
    }
    const result = await runtime.sendHuman(threadId, text)
    if (result && result.statusCode === 404) {
      json(res, 404, { ok: false, error: 'thread not found' })
      return
    }
    json(res, 200, result)
  }

  /** 单会话标已读（旧 `/mark-read`）。 */
  const hMarkRead = (req, res) => {
    const id = query(req).searchParams.get('id') || ''
    runtime.markRead(id)
    json(res, 200, { ok: true })
  }

  /** SSE：入站/审计有变化就推一条 refresh（旧 `/refresh-event`）。 */
  const hEvents = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write('retry: 3000\n\n')
    const off = runtime.subscribe(() => {
      try {
        res.write('data: refresh\n\n')
      } catch {
        /* 连接已断，close 回调会清理 */
      }
    })
    const cleanup = () => {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
  }

  /** 清空客服数据（旧 `/reset`）。 */
  const hClear = async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    await runtime.clearAll()
    json(res, 200, { ok: true })
  }

  /** 手动改名（旧 `/rename`）。 */
  const hRename = async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const body = await readBody(req)
    const threadId = String(body.threadId || '')
    const ok = runtime.rename(threadId, body.name)
    if (!ok) {
      json(res, 404, { ok: false, error: 'thread not found' })
      return
    }
    json(res, 200, { ok: true })
  }

  /** 删除单个会话（旧 `/delete-thread`）。 */
  const hDeleteThread = async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const body = await readBody(req)
    await runtime.deleteThread(String(body.threadId || ''))
    json(res, 200, { ok: true })
  }

  /** AI 设置：GET 读 / POST 改后回读（旧 `/ai-settings`）。 */
  const hAiSettings = async (req, res) => {
    const isPost = String(req.method || '').toUpperCase() === 'POST'
    if (isPost) {
      const body = await readBody(req)
      const patch = {}
      if (body.enabled !== undefined) patch.enabled = body.enabled === true
      for (const k of ['provider', 'model']) {
        if (body[k] !== undefined) patch[k] = String(body[k] || '')
      }
      for (const k of ['silenceMs', 'humanCooldownMs', 'minGapMs', 'maxPerThreadPerDay']) {
        if (body[k] !== undefined) {
          const n = Number(body[k])
          if (Number.isFinite(n) && n >= 0) patch[k] = n
        }
      }
      if (Array.isArray(body.platforms)) patch.platforms = body.platforms.map(String)
      runtime.setAiSettings(patch)
    }
    // POST 时强制重读知识库；GET 可用 ?platform= 指定平台诊断（多平台不串台）
    const query = (() => { try { return new URL(req.url, 'http://x').searchParams } catch { return { get: () => null } } })()
    const platform = String(query.get('platform') || '')
    const view = await runtime.getAiSettingsView(isPost ? { force: true, platform } : { platform })
    json(res, 200, view)
  }

  /** AI 自检：拿一个问题真跑一次模型（旧 `/ai-test`）。 */
  const hAiTest = async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const body = await readBody(req)
    const out = await runtime.aiTest({
      question: body.question,
      platform: body.platform,
      accountId: body.accountId,
      threadId: body.threadId,
      history: body.history,
    })
    json(res, 200, out)
  }

  /** AI 审计日志（旧 `/ai-log`）。 */
  const hAiLog = (req, res) => {
    const raw = Number(query(req).searchParams.get('limit') || 60) || 60
    const limit = Math.min(raw, 300)
    json(res, 200, { ok: true, log: runtime.aiLog(limit) })
  }

  /** 会话级 AI 模式：接管 / 交回 / 立即回一次（旧 `/ai-mode`）。 */
  const hAiMode = async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const body = await readBody(req)
    const out = runtime.aiMode(body)
    if (out && out.statusCode === 404) {
      json(res, 404, { ok: false, error: 'thread not found' })
      return
    }
    json(res, 200, out)
  }

  /** 诊断（新增）：状态 + AI/知识库/MCP 健康度，排障用。 */
  const hDiag = async (req, res) => {
    const ai = await runtime.getAiSettingsView({ force: true })
    json(res, 200, { ok: true, state: runtime.state(), ai })
  }

  // ── 资料库（kernel/library.js；项目 = 资料 + 账号绑定） ────────────────────

  const library = opts.library || null
  const needLibrary = (res) => {
    if (library) return true
    json(res, 503, { ok: false, error: '资料库未初始化' })
    return false
  }

  const hLibProjects = async (req, res) => {
    if (!needLibrary(res)) return
    if (!requireMethod(req, res, 'GET')) return
    json(res, 200, { ok: true, projects: await library.listProjects() })
  }

  /** 项目增/改/删（一个接口三种动作，避免动态路径） */
  const hLibProject = async (req, res) => {
    if (!needLibrary(res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readBody(req)
    const action = String(body.action || 'create')
    if (action === 'create') {
      const project = await library.createProject({
        id: body.id, name: body.name, description: body.description,
        accounts: Array.isArray(body.accounts) ? body.accounts : [],
      })
      json(res, 200, { ok: true, project })
      return
    }
    if (action === 'update') {
      const project = await library.updateProject(String(body.project || body.id || ''), {
        name: body.name, description: body.description, enabled: body.enabled,
        pinned: body.pinned, mcp: body.mcp, retrieval: body.retrieval,
      })
      json(res, 200, { ok: true, project })
      return
    }
    if (action === 'delete') {
      const out = await library.deleteProject(String(body.project || body.id || ''))
      json(res, 200, { ok: true, ...out })
      return
    }
    json(res, 400, { ok: false, error: 'action 必须是 create/update/delete' })
  }

  const hLibBind = async (req, res) => {
    if (!needLibrary(res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readBody(req)
    if (body.unbind) {
      const ok = await library.unbindAccount(String(body.platform || ''), String(body.accountId || ''))
      json(res, 200, { ok: true, unbound: ok })
      return
    }
    const project = await library.bindAccount(String(body.project || ''), {
      platform: body.platform, accountId: body.accountId, label: body.label,
    })
    json(res, 200, { ok: true, project })
  }

  const hLibTree = async (req, res) => {
    if (!needLibrary(res)) return
    const q = query(req)
    const project = String(q.searchParams.get('project') || '')
    const rel = q.searchParams.get('path') || ''
    if (!project) { json(res, 400, { ok: false, error: 'need project' }); return }
    json(res, 200, { ok: true, ...(await library.tree(project, rel)) })
  }

  const hLibFileGet = async (req, res) => {
    if (!needLibrary(res)) return
    const q = query(req)
    const project = String(q.searchParams.get('project') || '')
    const rel = String(q.searchParams.get('path') || '')
    if (!project || !rel) { json(res, 400, { ok: false, error: 'need project & path' }); return }
    const doc = await library.readDoc(project, rel, { asDataUrl: true })
    json(res, 200, { ok: true, doc })
  }

  /** 写文件 / 建文件夹 / 删 / 移动 / 重建索引（统一 POST body） */
  const hLibFileWrite = async (req, res) => {
    if (!needLibrary(res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readBody(req)
    const project = String(body.project || '')
    const action = String(body.action || 'write')
    if (!project) { json(res, 400, { ok: false, error: 'need project' }); return }
    if (action === 'write') {
      const out = await library.writeDoc(project, String(body.path || ''), body.content)
      json(res, 200, { ok: true, ...out })
      return
    }
    if (action === 'mkdir') {
      json(res, 200, { ok: true, ...(await library.mkdirProject(project, String(body.path || ''))) })
      return
    }
    if (action === 'delete') {
      json(res, 200, { ok: true, ...(await library.deletePath(project, String(body.path || ''), { recursive: body.recursive === true })) })
      return
    }
    if (action === 'move') {
      json(res, 200, { ok: true, ...(await library.movePath(project, String(body.from || ''), String(body.to || ''))) })
      return
    }
    json(res, 400, { ok: false, error: 'action 必须是 write/mkdir/delete/move' })
  }

  const hLibSearch = async (req, res) => {
    if (!needLibrary(res)) return
    const q = query(req)
    const project = String(q.searchParams.get('project') || '')
    const text = String(q.searchParams.get('q') || '')
    if (!project || !text) { json(res, 400, { ok: false, error: 'need project & q' }); return }
    const limit = Math.max(1, Math.min(10, Number(q.searchParams.get('limit') || 5) || 5))
    json(res, 200, { ok: true, project, query: text, hits: await library.search(project, text, { limit }) })
  }

  const hLibReindex = async (req, res) => {
    if (!needLibrary(res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readBody(req)
    const project = String(body.project || '')
    if (!project) { json(res, 400, { ok: false, error: 'need project' }); return }
    const idx = await library.buildIndex(project)
    json(res, 200, { ok: true, project, chunks: idx.chunks.length, builtAt: idx.builtAt })
  }

  /** 调试：按账号预览「AI 实际会读到的资料」 */
  const hLibContextPreview = async (req, res) => {
    if (!needLibrary(res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readBody(req)
    const platform = String(body.platform || '')
    const accountId = String(body.accountId || '')
    const text = String(body.text || '')
    const ctx = accountId
      ? await library.contextForAccount({ platform, accountId, query: text })
      : await library.buildContext(String(body.project || ''), text)
    json(res, 200, { ok: true, ctx })
  }

  // ── 路由表（路径相对前缀，与旧插件逐字一致） ──────────────────────────────

  const table = [
    { path: '/state', handler: hState },
    { path: '/thread', handler: hThread },
    { path: '/send', handler: hSend },
    { path: '/mark-read', handler: hMarkRead },
    { path: '/refresh-event', handler: hEvents },
    { path: '/reset', handler: hClear },
    { path: '/rename', handler: hRename },
    { path: '/delete-thread', handler: hDeleteThread },
    { path: '/ai-settings', handler: hAiSettings },
    { path: '/ai-test', handler: hAiTest },
    { path: '/ai-log', handler: hAiLog },
    { path: '/ai-mode', handler: hAiMode },
    // 资料库
    { path: '/library/projects', handler: hLibProjects },
    { path: '/library/project', handler: hLibProject },
    { path: '/library/bind', handler: hLibBind },
    { path: '/library/tree', handler: hLibTree },
    { path: '/library/file', handler: hLibFileWrite },
    { path: '/library/file-get', handler: hLibFileGet },
    { path: '/library/search', handler: hLibSearch },
    { path: '/library/reindex', handler: hLibReindex },
    { path: '/library/context-preview', handler: hLibContextPreview },
    // 唯一新增：排障入口（旧版没有；不影响旧路径）
    { path: '/diag', handler: hDiag },
  ]

  const registered = []
  for (const p of prefixes) {
    for (const item of table) {
      const route = { kind: 'exact', path: `${p}${item.path}`, handler: wrap(item.path, item.handler) }
      try {
        registered.push(webServer.register(route))
      } catch (e) {
        log.error(`注册路由失败 ${route.path}: ${(e && e.message) || e}`)
      }
    }
  }
  log.info(`已注册 ${registered.length} 条路由（前缀: ${prefixes.join(', ')}）`)

  /**
   * 返回值必须**可直接当 effect disposer 用**（`ctx.effect(() => mountRoutes(...))`），
   * 所以返回函数本体，并把 routes/dispose 挂在它上面便于测试与排障。
   */
  const dispose = function disposeRoutes() {
    for (const r of registered) {
      try {
        if (typeof r === 'function') r()
        else if (r && typeof r.dispose === 'function') r.dispose()
      } catch {
        /* ignore */
      }
    }
    registered.length = 0
  }
  dispose.routes = registered
  dispose.dispose = dispose
  return dispose
}

function normalizePrefix(p) {
  const s = String(p || '').trim()
  if (!s) return ''
  const withSlash = s.startsWith('/') ? s : `/${s}`
  return withSlash.replace(/\/+$/, '')
}

function normalizeLog(log) {
  const l = log && typeof log === 'object' ? log : {}
  const mk = (fn, level) => (msg) => {
    try {
      if (typeof fn === 'function') fn(msg)
      else console[level](msg)
    } catch {
      /* ignore */
    }
  }
  return { info: mk(l.info, 'log'), warn: mk(l.warn, 'warn'), error: mk(l.error, 'error'), debug: mk(l.debug, 'debug') }
}

export default mountRoutes
