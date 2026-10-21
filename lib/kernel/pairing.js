/**
 * 配对码持久化。
 *
 * 为什么必须持久化：扩展端「配对码被拒 → 停止自动重连」，如果每次重启换码，
 * 用户必须每次重填（旧插件踩过这个坑）。所以码落 `$DSH_HOME/dsh-cs/pair-code-<platform>.txt`，
 * 只在第一次生成；env 同名变量优先。
 *
 * 兼容旧插件：首次启动时若旧目录有 `pair-code.txt`（抖音），读出来当初始码，
 * 但**不写回旧目录**（旧插件回退后仍能用自己的码）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

function readText(p) {
  try { return readFileSync(p, 'utf8').trim() } catch { return '' }
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir    本插件数据目录
 * @param {string} opts.platform   平台 id
 * @param {string} [opts.envCode]  env 里显式指定的码（优先）
 * @param {string} [opts.legacyDir] 旧插件数据目录（只读兜底）
 * @returns {{code: string, generated: boolean, source: 'env'|'file'|'legacy'|'new'}}
 */
export function resolvePairCode({ dataDir, platform, envCode = '', legacyDir = '' }) {
  if (envCode) return { code: String(envCode), generated: false, source: 'env' }
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, `pair-code-${platform}.txt`)
  const saved = readText(file)
  if (saved) return { code: saved, generated: false, source: 'file' }
  if (legacyDir) {
    const legacy = readText(join(legacyDir, 'pair-code.txt'))
    if (legacy) {
      // 复制到新目录（旧目录保持只读）
      try { writeFileSync(file, legacy, 'utf8') } catch { /* ignore */ }
      return { code: legacy, generated: false, source: 'legacy' }
    }
  }
  const code = randomUUID().replace(/-/g, '').slice(0, 16)
  try { writeFileSync(file, code, 'utf8') } catch { /* ignore */ }
  return { code, generated: true, source: 'new' }
}

export function hasLegacyState(legacyDir) {
  return Boolean(legacyDir) && existsSync(join(legacyDir, 'state.json'))
}
