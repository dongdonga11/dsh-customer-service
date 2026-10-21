/**
 * 资料库工具（kernel，平台无关）。
 *
 * 让 Agent/运营者在主对话里也能「按项目」查资料：列项目、看目录、搜索、读文件。
 * 只读，不提供改/删（改删走面板资料库视图，避免误操作）。
 */
import { toolError, toolOk } from './toolkit.js'

const outDef = () => ({
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value == null ? '' : value) }],
})

const S = (description) => ({ type: 'string', description })

/**
 * @param {object} opts
 * @param {object} opts.library  createLibrary() 实例
 */
export function buildLibraryTools({ library, log = null } = {}) {
  if (!library) return []
  const lg = log || { warn() {}, info() {}, error() {}, debug() {} }

  async function resolveProject(nameOrId) {
    const key = String(nameOrId || '').trim()
    const list = await library.listProjects()
    if (key) {
      const hit = list.find((p) => p.id === key || p.name === key)
      if (!hit) throw new Error(`项目不存在：${key}（可用：${list.map((p) => p.name).join('、') || '无'}）`)
      return hit
    }
    if (list.length === 1) return list[0]
    if (!list.length) throw new Error('资料库还没有项目（先在客服中心「资料库」里创建）')
    throw new Error(`有多个项目，请指定 project：${list.map((p) => `${p.name}(${p.id})`).join('、')}`)
  }

  /** 把树压平成便于模型阅读的行（缩进表示层级） */
  function flattenTree(nodes, depth = 0, out = []) {
    for (const n of nodes || []) {
      const pad = '  '.repeat(depth)
      if (n.type === 'dir') {
        out.push(`${pad}${n.name}/`)
        flattenTree(n.children, depth + 1, out)
      } else {
        out.push(`${pad}${n.name}  (${n.kind}, ${Math.max(1, Math.round((n.size || 0) / 102.4) / 10)}KB)`)
      }
    }
    return out
  }

  const projects = {
    name: 'cs_library_projects',
    description: '列出客服资料库里的项目（每个项目绑定的账号、必读文件数）。想查资料但不知道有哪些项目时先调它。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: outDef(),
    async execute() {
      try {
        const list = await library.listProjects()
        return toolOk({
          projects: list.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description || '',
            accounts: (p.accounts || []).map((a) => `${a.platform}:${a.accountId}${a.label ? `(${a.label})` : ''}`),
            pinned: p.pinned || [],
            enabled: p.enabled !== false,
          })),
        })
      } catch (e) { return toolError(e && e.message) }
    },
  }

  const list = {
    name: 'cs_library_list',
    description: '查看某个项目资料库的目录树（文件夹/文档）。只有一个项目时可不传 project。',
    parameters: {
      type: 'object',
      properties: {
        project: S('项目名称或 id（可有多个项目时必填）'),
        path: S('只看某个子目录（可选，相对路径）'),
      },
      required: [],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const p = await resolveProject(args.project)
        const t = await library.tree(p.id, String(args.path || ''))
        const lines = flattenTree(t.tree)
        return toolOk({
          project: { id: p.id, name: p.name },
          path: args.path || '',
          files: lines.length,
          tree: lines.join('\n') || '（空）',
        })
      } catch (e) { return toolError(e && e.message) }
    },
  }

  const search = {
    name: 'cs_library_search',
    description: '在项目资料库里搜索（关键词/短语），返回命中的片段与文件路径。回答买家前想确认口径时用。',
    parameters: {
      type: 'object',
      properties: {
        query: S('搜索内容（买家问题或关键词）'),
        project: S('项目名称或 id（可选）'),
        limit: { type: 'number', description: '最多返回几段，默认 5' },
      },
      required: ['query'],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const q = String(args.query || '').trim()
        if (!q) return toolError('query 不能为空')
        const p = await resolveProject(args.project)
        const hits = await library.search(p.id, q, { limit: Math.max(1, Math.min(10, Number(args.limit) || 5)) })
        return toolOk({
          project: { id: p.id, name: p.name },
          query: q,
          count: hits.length,
          hits: hits.map((h) => ({ path: h.path, heading: h.heading, score: h.score, text: h.text })),
        })
      } catch (e) { return toolError(e && e.message) }
    },
  }

  const read = {
    name: 'cs_library_read',
    description: '按路径读项目资料库里的一篇文档（文本）。图片返回元信息/预览链接。',
    parameters: {
      type: 'object',
      properties: {
        path: S('相对路径，如「店规速查.md」或「话术/接待.md」'),
        project: S('项目名称或 id（可选）'),
        max_chars: { type: 'number', description: '最多读多少字，默认 8000' },
      },
      required: ['path'],
    },
    output: outDef(),
    async execute(args = {}) {
      try {
        const p = await resolveProject(args.project)
        const rel = String(args.path || '').trim()
        const doc = await library.readDoc(p.id, rel, { maxChars: Math.max(500, Math.min(20000, Number(args.max_chars) || 8000)), asDataUrl: true })
        if (doc.kind === 'image') {
          return toolOk({ project: { id: p.id, name: p.name }, path: rel, kind: 'image', size: doc.size, preview_url: doc.dataUrl })
        }
        return toolOk({
          project: { id: p.id, name: p.name },
          path: rel,
          chars: doc.chars,
          truncated: doc.truncated,
          text: doc.text,
        })
      } catch (e) { return toolError(e && e.message) }
    },
  }

  return [projects, list, search, read]
}

export default buildLibraryTools
