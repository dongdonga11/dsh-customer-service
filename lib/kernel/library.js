/**
 * 资料库（kernel，平台无关）。
 *
 * 核心概念：**项目 = 资料库 + 账号绑定 +（可选）MCP 配置**
 *   - 一个账号只属于一个项目（避免串料）；项目可绑多个账号（抖音号 + 闲鱼号）。
 *   - AI 上下文按「thread.accountId + platform → 项目 → 资料」注入（pinned 必读 + 关键词检索）。
 *   - 文件即真相：`$DSH_HOME/dsh-cs/library/projects/<id>/files/**`，索引可随时重建。
 *
 * 安全边界：
 *   - 所有路径先 sanitize（拒绝绝对路径 / `..` / 盘符 / NUL），再 realpath 校验不逃出 files 根；
 *   - 只允许文本与图片扩展名；单文件读写上限 1MB（索引单文件 20000 字）。
 */

import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.log', '.yaml', '.yml', '.html'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_READ_CHARS = 20000
const DEFAULT_RETRIEVAL = { mode: 'keyword', maxChars: 6000, maxChunks: 5, topFiles: 3 }
const CHUNK_CHARS = 600
const INDEX_VERSION = 1
/** 规则层文件名（每个项目根目录一份；每次 AI 上下文最前面注入） */
const AGENTS_FILE = 'AGENTS.md'
const RULES_MAX_CHARS = 5000

const nowIso = () => new Date().toISOString()
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
const isText = (p) => TEXT_EXT.has(extname(p).toLowerCase())
const isImage = (p) => IMAGE_EXT.has(extname(p).toLowerCase())

/** 日志归一化 */
function lgOf(log) {
  const l = log || {}
  return {
    info: (m) => { try { l.info?.(m) } catch { /* ignore */ } },
    warn: (m) => { try { l.warn?.(m) } catch { /* ignore */ } },
    debug: (m) => { try { l.debug?.(m) } catch { /* ignore */ } },
  }
}

/** 路径清洗：只接受项目内相对路径（不做寻址逃逸） */
export function sanitizeRelPath(rel) {
  const raw = String(rel == null ? '' : rel).replace(/\\/g, '/').trim()
  if (!raw) throw new Error('空路径')
  if (raw.includes('\0')) throw new Error('非法路径字符')
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('//')) throw new Error('不允许绝对路径')
  const norm = normalize(raw).replace(/\\/g, '/')
  if (norm.startsWith('..') || norm.split('/').includes('..')) throw new Error('不允许跳出资料库目录')
  return norm.replace(/^\.\/+/, '')
}

function assertChild(root, target) {
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || rel.startsWith(sep)) {
    if (rel === '') return
    throw new Error('路径超出资料库范围')
  }
}

const TEXT_TOKEN_SPLIT = /[\s,，。；;、（）()【】\[\]{}<>《》"'`~!！?？:：/\\|+*=#\-_@$%^&]+/

/** 常见同义词扩展：买家口语 → 资料里的词（提高「套餐/位置/多少钱」类问题命中率） */
const QUERY_SYNONYMS = {
  套餐: ['团购', '代金券', '畅玩', '体验'],
  团购: ['套餐', '代金券', '畅玩'],
  多少钱: ['售价', '价格'],
  价格: ['售价'],
  位置: ['店铺', '体验位'],
  空位: ['店铺', '体验位'],
  预定: ['预约', '预订'],
  订位: ['预约', '预订'],
}

/** 中文按 2-gram、英文/数字按词切；去停用词与单字噪声 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase().slice(0, 4000)
  const out = new Set()
  const ascii = s.match(/[a-z0-9]{2,}/g) || []
  for (const w of ascii) out.add(w)
  const cjkSeg = s.replace(/[a-z0-9]+/g, ' ').split(TEXT_TOKEN_SPLIT)
  const STOP = new Set(['的', '了', '是', '在', '和', '与', '就', '也', '我', '你', '他', '她', '有', '吗', '呢', '吧', '啊', '呀', '这', '那', '个', '不', '要', '会', '能', '可以', '怎么', '什么', '一下', '亲', '哦', '哈', '嗯'])
  for (const seg of cjkSeg) {
    const t = seg.trim()
    if (!t || t.length === 1) continue
    // 整段（短词）与 2-gram 都收：查询「包邮吗」也能命中「包邮」
    if (t.length <= 6 && !STOP.has(t)) out.add(t)
    for (let i = 0; i + 2 <= t.length; i++) {
      const g = t.slice(i, i + 2)
      if (!STOP.has(g)) out.add(g)
    }
  }
  return [...out].slice(0, 80)
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir   $DSH_HOME/dsh-cs
 * @param {object} [opts.log]
 */
export function createLibrary({ dataDir, log = null } = {}) {
  if (!dataDir) throw new Error('createLibrary: 缺少 dataDir')
  const lg = lgOf(log)
  const root = join(dataDir, 'library')
  const projectsFile = join(root, 'projects.json')
  const projectsDir = join(root, 'projects')

  let state = null // { version, projects: [] }

  async function ensureDirs() {
    await mkdir(projectsDir, { recursive: true })
  }

  async function load() {
    if (state) return state
    await ensureDirs()
    try {
      const raw = await readFile(projectsFile, 'utf8')
      const parsed = JSON.parse(raw)
      state = { version: INDEX_VERSION, projects: Array.isArray(parsed.projects) ? parsed.projects : [] }
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        // 损坏：备份后重建空库（不静默丢数据）
        try { await copyFile(projectsFile, `${projectsFile}.corrupt-${Date.now()}`) } catch { /* ignore */ }
        lg.warn(`projects.json 损坏，已备份并重建：${(e && e.message) || e}`)
      }
      state = { version: INDEX_VERSION, projects: [] }
    }
    // 字段补默认
    for (const p of state.projects) {
      p.accounts = Array.isArray(p.accounts) ? p.accounts : []
      p.pinned = Array.isArray(p.pinned) ? p.pinned : []
      p.mcp = Array.isArray(p.mcp) ? p.mcp : []
      p.retrieval = { ...DEFAULT_RETRIEVAL, ...(p.retrieval || {}) }
      p.enabled = p.enabled !== false
    }
    return state
  }

  async function save() {
    await ensureDirs()
    const tmp = `${projectsFile}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await rename(tmp, projectsFile)
  }

  function filesRoot(projectId) {
    return join(projectsDir, projectId, 'files')
  }

  function findProject(idOrName) {
    const key = String(idOrName || '')
    return (state.projects || []).find((p) => p.id === key || p.name === key) || null
  }

  function getProject(id) {
    return findProject(id)
  }

  async function listProjects() {
    const s = await load()
    return s.projects.map((p) => {
      let docCount = 0
      try {
        // 粗略统计，避免每次全量递归（P2 用索引统计）
        docCount = Array.isArray(p._docCount) ? p._docCount.length : 0
      } catch { docCount = 0 }
      return { ...p, accountCount: p.accounts.length, docCount }
    })
  }

  async function createProject({ name, id, description = '', accounts = [], pinned = [] } = {}) {
    const s = await load()
    const display = String(name || '').trim()
    if (!display) throw new Error('项目名不能为空')
    let pid = slug(id || display)
    if (!pid) pid = `p${Date.now().toString(36)}`
    if (findProject(pid)) throw new Error(`项目 id 已存在：${pid}`)
    const project = {
      id: pid,
      name: display,
      description: String(description || ''),
      enabled: true,
      pinned: pinned.map(String),
      accounts: [],
      mcp: [],
      retrieval: { ...DEFAULT_RETRIEVAL },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    s.projects.push(project)
    await save()
    await mkdir(filesRoot(pid), { recursive: true })
    // 创建时可直接绑定账号（仍保持「一个账号只属一个项目」）
    for (const a of accounts) {
      try { await bindAccount(pid, a) } catch (e) { lg.warn(`绑定失败: ${(e && e.message) || e}`) }
    }
    lg.info(`资料库：创建项目 ${display}（${pid}）`)
    return findProject(pid)
  }

  async function updateProject(id, patch = {}) {
    const s = await load()
    const p = findProject(id)
    if (!p) throw new Error('项目不存在')
    for (const k of ['name', 'description', 'enabled', 'pinned', 'mcp', 'retrieval']) {
      if (patch[k] !== undefined) p[k] = patch[k]
    }
    if (Array.isArray(p.pinned)) p.pinned = p.pinned.map(String)
    if (p.retrieval) p.retrieval = { ...DEFAULT_RETRIEVAL, ...p.retrieval }
    p.updatedAt = nowIso()
    await save()
    return p
  }

  /** 删除项目：移到 library/.trash/（不物理删除文件，可人工恢复） */
  async function deleteProject(id) {
    const s = await load()
    const p = findProject(id)
    if (!p) throw new Error('项目不存在')
    const trash = join(root, '.trash')
    await mkdir(trash, { recursive: true })
    const from = join(projectsDir, p.id)
    const to = join(trash, `${p.id}-${Date.now()}`)
    if (existsSync(from)) { try { await rename(from, to) } catch (e) { lg.warn(`项目目录移入回收站失败: ${(e && e.message) || e}`) } }
    s.projects = s.projects.filter((x) => x.id !== p.id)
    await save()
    lg.info(`资料库：删除项目 ${p.name}（${p.id}），文件在 ${to}`)
    return { ok: true, trash: to }
  }

  /** 绑定账号（同一账号从其它项目解绑） */
  async function bindAccount(projectId, { platform, accountId, label = '' } = {}) {
    const s = await load()
    const p = findProject(projectId)
    if (!p) throw new Error('项目不存在')
    const plat = String(platform || '').trim()
    const acct = String(accountId || '').trim()
    if (!plat || !acct) throw new Error('绑定需要 platform + accountId')
    for (const other of s.projects) {
      if (other.id === p.id) continue
      other.accounts = (other.accounts || []).filter((a) => !(a.platform === plat && String(a.accountId) === acct))
    }
    p.accounts = (p.accounts || []).filter((a) => !(a.platform === plat && String(a.accountId) === acct))
    p.accounts.push({ platform: plat, accountId: acct, label: String(label || '') })
    p.updatedAt = nowIso()
    await save()
    return p
  }

  async function unbindAccount(platform, accountId) {
    const s = await load()
    const plat = String(platform || '')
    const acct = String(accountId || '')
    let changed = 0
    for (const p of s.projects) {
      const before = p.accounts.length
      p.accounts = p.accounts.filter((a) => !(a.platform === plat && String(a.accountId) === acct))
      if (p.accounts.length !== before) { p.updatedAt = nowIso(); changed++ }
    }
    if (changed) await save()
    return changed > 0
  }

  /** 账号 → 项目（一个账号只会命中一个项目） */
  async function projectForAccount(platform, accountId) {
    const s = await load()
    const plat = String(platform || '')
    const acct = String(accountId || '')
    return (
      s.projects.find(
        (p) => p.enabled !== false && (p.accounts || []).some((a) => a.platform === plat && String(a.accountId) === acct),
      ) || null
    )
  }

  // ── 文件树 ────────────────────────────────────────────────────────────────

  function resolveInProject(project, rel) {
    if (!project) throw new Error('项目不存在')
    const clean = sanitizeRelPath(rel)
    const base = filesRoot(project.id)
    const target = resolve(base, clean)
    assertChild(base, target)
    return target
  }

  async function tree(projectId, rel = '') {
    const s = await load()
    const project = findProject(projectId)
    if (!project) throw new Error('项目不存在')
    const base = filesRoot(project.id)
    const start = rel ? resolveInProject(project, rel) : base
    async function walk(dir, relDir) {
      let names = []
      try { names = await readdir(dir) } catch { return [] }
      names = names.filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b))
      const out = []
      for (const name of names) {
        const full = join(dir, name)
        const relPath = relDir ? `${relDir}/${name}` : name
        let st = null
        try { st = await stat(full) } catch { continue }
        if (st.isDirectory()) {
          out.push({ type: 'dir', name, path: relPath, children: await walk(full, relPath) })
        } else {
          out.push({
            type: 'file', name, path: relPath, size: st.size, mtime: st.mtime.toISOString(),
            kind: isText(name) ? 'text' : isImage(name) ? 'image' : 'other',
          })
        }
      }
      // 目录在前
      return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    }
    return { project: project.id, tree: await walk(start, rel || '') }
  }

  async function readDoc(projectId, rel, { maxChars = MAX_READ_CHARS, asDataUrl = false } = {}) {
    const s = await load()
    const project = findProject(projectId)
    if (!project) throw new Error('项目不存在')
    const full = resolveInProject(project, rel)
    const st = await stat(full)
    if (!st.isFile()) throw new Error('不是文件')
    const name = basename(full)
    if (isImage(name)) {
      const buf = await readFile(full)
      return {
        project: project.id, path: rel, kind: 'image', size: st.size, mtime: st.mtime.toISOString(),
        mime: `image/${extname(name).slice(1).replace('jpg', 'jpeg')}`,
        dataUrl: asDataUrl ? `data:image/${extname(name).slice(1).replace('jpg', 'jpeg')};base64,${buf.toString('base64')}` : '',
      }
    }
    if (!isText(name)) throw new Error(`不支持读取该文件类型：${name}`)
    const text = await readFile(full, 'utf8')
    return {
      project: project.id, path: rel, kind: 'text', size: st.size, mtime: st.mtime.toISOString(),
      text: text.slice(0, maxChars), truncated: text.length > maxChars, chars: text.length,
    }
  }

  async function writeDoc(projectId, rel, content) {
    const s = await load()
    const project = findProject(projectId)
    if (!project) throw new Error('项目不存在')
    const full = resolveInProject(project, rel)
    const name = basename(full)
    if (!isText(name)) throw new Error(`只允许写入文本类文件：${name}`)
    const text = String(content == null ? '' : content)
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('文件超过 1MB 上限')
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text, 'utf8')
    await invalidateIndex(project.id)
    return { path: rel, size: Buffer.byteLength(text, 'utf8') }
  }

  async function mkdirProject(projectId, rel) {
    const s = await load()
    const project = findProject(projectId)
    if (!project) throw new Error('项目不存在')
    const full = resolveInProject(project, rel)
    await mkdir(full, { recursive: true })
    return { path: rel }
  }

  async function deletePath(projectId, rel, { recursive = false } = {}) {
    const s = await load()
    const project = findProject(projectId)
    if (!project) throw new Error('项目不存在')
    const full = resolveInProject(project, rel)
    const st = await stat(full)
    if (st.isDirectory() && !recursive) {
      const names = await readdir(full)
      if (names.length) throw new Error('目录非空（需要 recursive=true 才能删）')
    }
    await rm(full, { recursive: st.isDirectory(), force: false })
    await invalidateIndex(project.id)
    return { path: rel }
  }

  async function movePath(projectId, from, to) {
    const s = await load()
    const project = findProject(projectId)
    if (!project) throw new Error('项目不存在')
    const src = resolveInProject(project, from)
    const dst = resolveInProject(project, to)
    if (!existsSync(src)) throw new Error('源不存在')
    await mkdir(dirname(dst), { recursive: true })
    await rename(src, dst)
    await invalidateIndex(project.id)
    return { from: sanitizeRelPath(from), to: sanitizeRelPath(to) }
  }

  // ── 索引与检索 ────────────────────────────────────────────────────────────

  function indexPath(projectId) { return join(projectsDir, projectId, 'index.json') }

  async function invalidateIndex(projectId) {
    try { await rm(indexPath(projectId), { force: true }) } catch { /* ignore */ }
  }

  async function walkTextFiles(dir, relDir = '') {
    const out = []
    let names = []
    try { names = await readdir(dir) } catch { return out }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const full = join(dir, name)
      const relPath = relDir ? `${relDir}/${name}` : name
      let st = null
      try { st = await stat(full) } catch { continue }
      if (st.isDirectory()) out.push(...(await walkTextFiles(full, relPath)))
      else if (isText(name) && name !== AGENTS_FILE && st.size <= MAX_TEXT_BYTES) out.push({ full, relPath, size: st.size, mtime: st.mtimeMs })
    }
    return out
  }

  function splitChunks(text) {    const lines = String(text).split(/\r?\n/)
    const chunks = []
    let heading = ''
    let buf = []
    const flush = () => {
      const body = buf.join('\n').trim()
      if (body) chunks.push({ heading, text: body.slice(0, CHUNK_CHARS * 2) })
      buf = []
    }
    for (const line of lines) {
      const h = /^(#{1,4})\s+(.*)$/.exec(line.trim())
      if (h) { flush(); heading = h[2].trim().slice(0, 80) }
      buf.push(line)
      if (buf.join('\n').length > CHUNK_CHARS) flush()
    }
    flush()
    // 超长 chunk 再切
    const out = []
    for (const c of chunks) {
      if (c.text.length <= CHUNK_CHARS * 1.5) { out.push(c); continue }
      for (let i = 0; i < c.text.length; i += CHUNK_CHARS) out.push({ heading: c.heading, text: c.text.slice(i, i + CHUNK_CHARS) })
    }
    return out.slice(0, 500)
  }

  async function buildIndex(projectId) {
    const s = await load()
    const project = findProject(projectId)
    if (!project) throw new Error('项目不存在')
    const base = filesRoot(project.id)
    const files = await walkTextFiles(base)
    const chunks = []
    for (const f of files) {
      let text = ''
      try { text = await readFile(f.full, 'utf8') } catch { continue }
      for (const c of splitChunks(text)) {
        chunks.push({
          path: f.relPath,
          heading: c.heading || '',
          text: c.text,
          tokens: tokenize(`${c.heading} ${c.text}`),
          len: c.text.length,
          mtime: f.mtime,
        })
      }
    }
    const idx = { version: INDEX_VERSION, builtAt: nowIso(), builtAtMs: Date.now(), sourceMtime: files.reduce((n, f) => Math.max(n, f.mtime || 0), 0), project: project.id, chunks }
    await mkdir(dirname(indexPath(project.id)), { recursive: true })
    await writeFile(indexPath(project.id), JSON.stringify(idx), 'utf8')
    return idx
  }

  async function getIndex(projectId) {
    try {
      const raw = await readFile(indexPath(projectId), 'utf8')
      const idx = JSON.parse(raw)
      if (idx && idx.version === INDEX_VERSION && Array.isArray(idx.chunks)) {
        // 新鲜度：外部（资源管理器/脚本）改了文件也要能及时反映，自动重建
        const s = await load()
        const project = findProject(projectId)
        if (project) {
          const files = await walkTextFiles(filesRoot(project.id))
          const latest = files.reduce((n, f) => Math.max(n, f.mtime || 0), 0)
          if (latest > (idx.sourceMtime || 0)) return buildIndex(projectId)
        }
        return idx
      }
    } catch { /* missing/broken */ }
    return buildIndex(projectId)
  }

  async function search(projectId, query, { limit = 5 } = {}) {
    const qTokens = tokenize(query)
    if (!qTokens.length) return []
    // 同义词扩展（只加词不改原词）：让「套餐」也能命中「团购/畅玩」内容
    const qStr = String(query || '')
    const extra = new Set()
    for (const [k, syns] of Object.entries(QUERY_SYNONYMS)) {
      if (!qStr.includes(k)) continue
      for (const s of syns) for (const t of tokenize(s)) extra.add(t)
    }
    for (const t of extra) if (!qTokens.includes(t)) qTokens.push(t)
    const idx = await getIndex(projectId)
    const qset = new Set(qTokens)
    const scored = []
    for (const c of idx.chunks) {
      let score = 0
      const tokens = c.tokens || []
      const tokenSet = new Set(tokens)
      for (const t of qTokens) if (tokenSet.has(t)) score += 1
      // 标题/文件名加成
      for (const t of qTokens) {
        if (c.heading && c.heading.toLowerCase().includes(t)) score += 2
        if (c.path && c.path.toLowerCase().includes(t)) score += 1.5
      }
      if (score <= 0) continue
      // 归一化避免长文占优
      score = score / Math.sqrt(Math.max(1, tokens.length / 40))
      scored.push({ ...c, score })
    }
    scored.sort((a, b) => b.score - a.score)
    // 每个文件最多 2 个 chunk
    const perFile = new Map()
    const picked = []
    for (const c of scored) {
      const n = perFile.get(c.path) || 0
      if (n >= 2) continue
      perFile.set(c.path, n + 1)
      picked.push({ path: c.path, heading: c.heading, score: Number(c.score.toFixed(3)), text: c.text })
      if (picked.length >= limit) break
    }
    return picked
  }

  /** 组装 AI 上下文：pinned 全文 + 检索命中；没有内容返回 kb='' */
  async function buildContext(projectId, query = '', opts = {}) {
    const s = await load()
    const project = findProject(projectId)
    if (!project || project.enabled === false) return { kb: '', project: null, citations: [], chars: 0, error: '项目不存在或已停用' }
    const r = { ...DEFAULT_RETRIEVAL, ...(project.retrieval || {}), ...(opts || {}) }
    const maxChars = Math.max(500, Math.min(20000, Number(r.maxChars) || 6000))
    const parts = []
    const citations = []
    let used = 0

    // 0) 规则层：AGENTS.md 每次必带（项目边界 / 数据源 / 工具策略 / 输出规范）
    try {
      const rulesDoc = await readDoc(project.id, AGENTS_FILE, { maxChars: RULES_MAX_CHARS })
      if (rulesDoc.kind === 'text' && String(rulesDoc.text || '').trim()) {
        const block = `## 项目规则（AGENTS.md）\n${rulesDoc.text}`
        if (used + block.length <= maxChars) {
          parts.push(block)
          used += block.length
        } else {
          const cut = block.slice(0, Math.max(500, maxChars - used))
          parts.push(cut)
          used += cut.length
        }
        citations.push({ path: AGENTS_FILE, heading: '项目规则', score: 200 })
      }
    } catch { /* 没有规则文件：老项目/新建项目跳过 */ }

    // 1) 必读置顶
    for (const rel of project.pinned.slice(0, 6)) {
      try {
        const doc = await readDoc(project.id, rel, { maxChars: 3000 })
        if (doc.kind !== 'text' || !doc.text) continue
        const block = `## 必读：${rel}\n${doc.text}`
        if (used + block.length > maxChars) break
        parts.push(block)
        used += block.length
        citations.push({ path: rel, heading: '必读', score: 100 })
      } catch { /* 文件被删/改错名字：跳过 */ }
    }

    // 2) 关键词检索
    let hits = []
    try { hits = await search(project.id, query, { limit: r.maxChunks }) } catch (e) { lg.warn(`检索失败: ${(e && e.message) || e}`) }
    for (const h of hits) {
      const block = `### ${h.path}${h.heading ? ` · ${h.heading}` : ''}（相关度 ${h.score}）\n${h.text}`
      if (used + block.length > maxChars) continue
      parts.push(block)
      used += block.length
      citations.push({ path: h.path, heading: h.heading, score: h.score })
    }

    if (!parts.length) {
      return { kb: '', project: { id: project.id, name: project.name }, citations: [], chars: 0, error: '没有命中的资料（也没有必读文件）' }
    }
    const kb = `【项目资料：${project.name}】\n` + parts.join('\n\n')
    return { kb, project: { id: project.id, name: project.name }, citations, chars: kb.length, error: '' }
  }

  /** 账号上下文：项目 → 资料 */
  async function contextForAccount({ platform, accountId, query = '', maxChars } = {}) {
    const project = await projectForAccount(platform, accountId)
    if (!project) return { kb: '', project: null, citations: [], chars: 0, error: '该账号尚未分配项目' }
    return buildContext(project.id, query, maxChars ? { maxChars } : {})
  }

  /** 规则层读取（面板诊断/权限提示用） */
  async function rules(projectId) {
    const project = findProject(projectId)
    if (!project) return { path: '', chars: 0, error: '项目不存在' }
    try {
      const doc = await readDoc(project.id, AGENTS_FILE, { maxChars: 20000 })
      return { path: AGENTS_FILE, chars: doc.text.length, error: '', text: doc.text }
    } catch {
      return { path: '', chars: 0, error: '未配置 AGENTS.md（点面板「规则」可生成模板）' }
    }
  }

  /** 首启迁移：把旧的全局 knowledge/*.md 收进「默认项目」，并绑定现有账号 */
  async function ensureInitial({ legacyKnowledgeDir = '', accounts = [] } = {}) {
    const s = await load()
    if (s.projects.length) return { created: false }
    let project
    try {
      project = await createProject({ id: 'default', name: '默认项目', description: '由旧全局知识库自动迁移；可改名/拆分' })
    } catch (e) {
      // 并发/已存在
      project = findProject('default')
      if (!project) throw e
    }
    // 迁移 knowledge/*.md（复制，不删原件）
    if (legacyKnowledgeDir && existsSync(legacyKnowledgeDir)) {
      try {
        const names = (await readdir(legacyKnowledgeDir)).filter((n) => isText(n))
        for (const n of names) {
          try {
            await copyFile(join(legacyKnowledgeDir, n), resolveInProject(project, n))
          } catch (e) { lg.warn(`迁移 ${n} 失败: ${(e && e.message) || e}`) }
        }
        if (names.length) await updateProject(project.id, { pinned: names.slice(0, 3) })
        lg.info(`资料库：已迁移 ${names.length} 个旧知识库文件到「默认项目」`)
      } catch (e) { lg.warn(`旧知识库迁移失败: ${(e && e.message) || e}`) }
    }
    for (const a of accounts) {
      try { await bindAccount(project.id, a) } catch { /* ignore */ }
    }
    return { created: true, projectId: project.id }
  }

  return {
    root,
    projectsFile,
    // 项目
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    // 账号绑定
    bindAccount,
    unbindAccount,
    projectForAccount,
    // 文件
    tree,
    readDoc,
    writeDoc,
    mkdirProject,
    deletePath,
    movePath,
    // 规则
    rules, AGENTS_FILE,
    // 检索
    buildIndex,
    search,
    buildContext,
    contextForAccount,
    // 迁移
    ensureInitial,
  }
}

export default createLibrary
