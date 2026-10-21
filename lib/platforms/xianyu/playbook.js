/**
 * 闲鱼话术沉淀（playbook 聚合，M4d）。
 *
 * 思路对齐 Hermes `playbook_aggregator.py`：
 *   - 周期性复盘客户档案里的**新增对话**，用一个小模型把「有效的买家类型/应对打法」提炼成
 *     markdown 话术库（`<dataDir>/knowledge/*.md`），供 AI 自动回复使用；
 *   - 只做**增量**（每买家新增轮次 ≥ minNewTurns 才送模型），避免反复烧 token；
 *   - 落盘前备份到 `knowledge/.backups/`；refine 只在**唯一精确子串**命中时替换，绝不整文件覆盖；
 *   - 全流程失败只记日志（后台任务，不影响客服主链路）。
 *
 * 与 Hermes 的差异：
 *   - 不分「类型目录」，直接维护 knowledge/ 下的 md 文件（与 aiContext 读取口径一致）；
 *   - 模型调用走 DSH `ctx.llm.stream`（由 runtime.callModel 注入），不引入辅助任务配置体系。
 */

import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_MODEL_MIN_TURNS = 3
const MATERIAL_MAX_CHARS = 6000
const MAX_OPS = 8
const ALLOWED_FILE = /^[\w\u4e00-\u9fa5.\-]+\.md$/

const SYSTEM_PROMPT = `你是电商客服主管。下面给你「买家对话的增量记录」与「现有话术库文件列表」。
请只输出一个 JSON 对象（不要 markdown 代码块、不要解释）：
{"ops":[{"op":"append"|"refine"|"noop","file":"话术.md","text":"要追加的打法","find":"现有原文片段","replace":"替换后的文本","why":"一句理由"}],"summary":"一句话总结"}
规则：
1. 只提炼**可复用**的接待打法（买家类型 + 应对要点），不要记录具体买家隐私；
2. append 用于新增打法；refine 仅当现有句子明显过时/错误，且 find 是文件里的**唯一精确子串**；
3. 没有值得沉淀的就返回 {"ops":[{"op":"noop"}],"summary":"无新增"}；
4. 最多 4 条 ops，每条 text 不超过 200 字。`

/** 去重/限长的小工具 */
const clip = (s, n) => String(s || '').slice(0, n)

/**
 * 跑一次聚合。
 *
 * @param {object} opts
 * @param {string} opts.accountId
 * @param {object} opts.customerStore   customer_store 实例（list/get）
 * @param {string} opts.knowledgeDir    话术库目录
 * @param {Function} opts.callModel     async ({system,messages}) => string
 * @param {string} [opts.model]         模型名（仅日志/审计展示，实际 provider 由内核选）
 * @param {number} [opts.minNewTurns=3]
 * @param {object} [opts.log]
 * @returns {Promise<{ok:boolean, skipped?:string, processed?:number, applied?:number, ops?:Array, error?:string}>}
 */
export async function runPlaybookOnce({
  accountId,
  customerStore,
  knowledgeDir,
  callModel,
  model = '',
  minNewTurns = DEFAULT_MODEL_MIN_TURNS,
  log = null,
  state = null,
} = {}) {
  const lg = log || { info() {}, warn() {}, error() {}, debug() {} }
  if (!accountId || !customerStore || !knowledgeDir || typeof callModel !== 'function') {
    return { ok: false, skipped: 'deps', error: '缺少 accountId/customerStore/knowledgeDir/callModel' }
  }
  try {
    const customers = await customerStore.list(accountId, { limit: 200 })
    const prev = (state && state.perBuyer) || {}
    const next = { ...prev }
    const material = []
    let processed = 0
    for (const c of customers) {
      const buyerId = String(c.buyerId || '')
      if (!buyerId) continue
      const rec = await customerStore.get(accountId, buyerId)
      if (!rec || !Array.isArray(rec.turns)) continue
      const prevCount = Number(prev[buyerId]) || 0
      const total = rec.turns.length
      next[buyerId] = total
      const fresh = total - prevCount
      if (fresh <= 0) continue
      processed += fresh
      const newTurns = rec.turns.slice(prevCount)
      for (const t of newTurns.slice(-8)) {
        material.push(`买家(${buyerId}): ${clip(t.buyerMsg || t.buyer || '', 200)}\n客服: ${clip(t.reply || '', 200)}`)
      }
    }
    if (processed < Math.max(1, Number(minNewTurns) || 1)) {
      return { ok: true, skipped: 'threshold', processed, perBuyer: next }
    }

    // 现有话术库文件（作为 refine 的上下文，只给文件名 + 每个文件前 1500 字）
    await mkdir(join(knowledgeDir, '.backups'), { recursive: true })
    let files = []
    try {
      const { readdir } = await import('node:fs/promises')
      files = (await readdir(knowledgeDir)).filter((n) => ALLOWED_FILE.test(n))
    } catch { /* ignore */ }
    const fileHints = []
    for (const f of files.slice(0, 6)) {
      try {
        const text = await readFile(join(knowledgeDir, f), 'utf8')
        fileHints.push(`【${f}】\n${text.slice(0, 1500)}`)
      } catch { /* ignore */ }
    }

    const userPrompt = [
      `## 现有话术库文件\n${files.join('、') || '（空）'}`,
      `## 文件内容摘要\n${fileHints.join('\n\n') || '（无）'}`,
      `## 新增对话记录\n${material.join('\n\n').slice(0, MATERIAL_MAX_CHARS)}`,
    ].join('\n\n')

    const raw = await callModel({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }] })
    const parsed = parseOps(raw)
    if (!parsed) return { ok: false, error: '模型输出不是合法 JSON', processed, perBuyer: next }

    const applied = []
    for (const op of (parsed.ops || []).slice(0, MAX_OPS)) {
      const r = await applyOp(op, knowledgeDir, lg)
      if (r) applied.push({ ...r, why: clip(op.why || '', 120) })
    }
    lg.info(`话术沉淀：新增轮次 ${processed}，应用 ${applied.length} 条${model ? `（model=${model}）` : ''}`)
    return { ok: true, processed, applied: applied.length, ops: applied, summary: clip(parsed.summary || '', 200), perBuyer: next }
  } catch (error) {
    lg.warn(`话术沉淀失败（不影响主链路）: ${(error && error.message) || error}`)
    return { ok: false, error: String((error && error.message) || error) }
  }
}

function parseOps(raw) {
  const text = String(raw || '').trim()
  const tryParse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null } catch { return null } }
  let v = tryParse(text)
  if (v) return v
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) { v = tryParse(fence[1].trim()); if (v) return v }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) return tryParse(text.slice(first, last + 1))
  return null
}

async function applyOp(op, knowledgeDir, lg) {
  if (!op || typeof op !== 'object') return null
  const kind = String(op.op || 'noop')
  if (kind === 'noop') return null
  const file = String(op.file || '话术.md')
  if (!ALLOWED_FILE.test(file)) { lg.warn(`话术沉淀：拒绝非法文件名 ${file}`); return null }
  const path = join(knowledgeDir, file)
  const exists = existsSync(path)
  const current = exists ? await readFile(path, 'utf8') : ''

  if (kind === 'append') {
    const text = String(op.text || '').trim()
    if (!text) return null
    if (current.includes(text)) return null // 幂等：同内容不重复追加
    if (exists) { try { await copyFile(path, backupPath(knowledgeDir, file)) } catch { /* ignore */ } }
    const next = current ? `${current.replace(/\s+$/, '')}\n\n${text}\n` : `# ${file.replace(/\.md$/, '')}\n\n${text}\n`
    await writeFile(path, next, 'utf8')
    return { op: 'append', file, text: clip(text, 120) }
  }

  if (kind === 'refine') {
    const find = String(op.find || '')
    const replace = String(op.replace || '')
    if (!find || !replace) return null
    const first = current.indexOf(find)
    if (first < 0) return null
    if (current.indexOf(find, first + find.length) >= 0) { lg.warn(`话术沉淀：refine 片段不唯一，跳过（${file}）`); return null }
    try { await copyFile(path, backupPath(knowledgeDir, file)) } catch { /* ignore */ }
    await writeFile(path, current.slice(0, first) + replace + current.slice(first + find.length), 'utf8')
    return { op: 'refine', file, find: clip(find, 80), replace: clip(replace, 120) }
  }
  return null
}

function backupPath(knowledgeDir, file) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return join(knowledgeDir, '.backups', `${file}.${ts}.bak.md`)
}

/**
 * 后台定时器（幂等 start；stop 可 await；dispose 时 stop）。
 * 首次延迟默认 5 分钟（避开冷启动），之后每 intervalMinutes 跑一次。
 */
export function createPlaybookTicker({ intervalMinutes = 30, initialDelayMs = 5 * 60 * 1000, runOnce, log = null } = {}) {
  const lg = log || { info() {}, warn() {}, error() {}, debug() {} }
  const ms = Math.max(60 * 1000, (Number(intervalMinutes) || 30) * 60 * 1000)
  let firstTimer = null
  let intervalTimer = null
  let stopped = false

  async function tick() {
    if (stopped) return
    try {
      await runOnce()
    } catch (e) {
      lg.warn(`话术沉淀定时任务失败: ${(e && e.message) || e}`)
    }
  }

  return {
    get running() { return firstTimer !== null || intervalTimer !== null },
    start() {
      if (stopped || firstTimer || intervalTimer) return
      lg.info(`话术沉淀定时器启动：首次 ${Math.round(initialDelayMs / 60000)} 分钟后，间隔 ${Math.round(ms / 60000)} 分钟`)
      firstTimer = setTimeout(() => {
        firstTimer = null
        if (stopped) return
        void tick()
        intervalTimer = setInterval(tick, ms)
        if (typeof intervalTimer.unref === 'function') intervalTimer.unref()
      }, Math.max(1000, initialDelayMs))
      if (typeof firstTimer.unref === 'function') firstTimer.unref()
    },
    async stop() {
      stopped = true
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null }
      if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null }
    },
    /** 立即跑一次（测试/手动触发） */
    runOnce: tick,
  }
}

export const PLAYBOOK_DEFAULTS = { enabled: false, intervalMinutes: 30, minNewTurns: DEFAULT_MODEL_MIN_TURNS }

export default { runPlaybookOnce, createPlaybookTicker, PLAYBOOK_DEFAULTS }
