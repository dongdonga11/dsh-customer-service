#!/usr/bin/env node
/**
 * 初始化话术库模板（幂等，不覆盖已有文件）。
 *
 * 用法：
 *   node scripts/seed-knowledge.mjs               # 写入 $DSH_HOME/dsh-cs/knowledge
 *   node scripts/seed-knowledge.mjs --dir <路径>  # 指定目录（测试/自定位置）
 *   node scripts/seed-knowledge.mjs --force       # 覆盖已有文件（谨慎）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : '' }
const force = args.includes('--force')
const dataDir = getArg('--dir') || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-cs')
const target = join(dataDir, 'knowledge')
const templates = join(import.meta.dirname || process.cwd(), '..', 'docs', 'knowledge-templates')
const templateSource = existsSync(templates) ? templates : join(process.cwd(), 'docs', 'knowledge-templates')

if (!existsSync(templateSource)) {
  console.error(`找不到模板目录: ${templateSource}`)
  process.exit(1)
}
mkdirSync(target, { recursive: true })
const existing = new Set(readdirSync(target))
let created = 0
let skipped = 0
for (const name of readdirSync(templateSource)) {
  if (!/\.(md|txt)$/i.test(name)) continue
  const dst = join(target, name)
  if (existing.has(name) && !force) { skipped++; continue }
  copyFileSync(join(templateSource, name), dst)
  created++
  console.log(`写入模板: ${dst}`)
}
console.log(`完成：新增 ${created}，跳过已存在 ${skipped}（目录 ${target}）`)
console.log('下一步：编辑这些文件成你自己店铺的真实规则，然后重启 DSH（或等 60s 缓存过期）。')
