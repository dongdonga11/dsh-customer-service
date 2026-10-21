/**
 * 旧插件数据迁移（一次性、只读旧库、可回退）。
 *
 * 规则（回退安全的关键）：
 * 1. **绝不写旧目录**：旧插件禁用后仍要能原样启动 → 旧库必须保持一字节不变。
 * 2. 新库已存在 → 不迁移（避免覆盖用户在新版里产生的新数据）。
 * 3. 迁移只做「复制 + 版本标记」，不做字段改写；旧 schema 与新 schema 字段兼容
 *    （Store.init 只认已知键，未知键自然忽略）。
 * 4. 回退 = 禁用新插件、启用旧插件；旧数据从未被改过，所以回退无损。
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATE_MARK = 'migrate-info.json'

/**
 * @param {object} opts
 * @param {string} opts.dataDir    新目录
 * @param {string} [opts.legacyDir] 旧目录（空字符串表示不迁移）
 * @param {{info:Function,warn:Function}} [opts.log]
 * @returns {Promise<{migrated:boolean, reason?:string, from?:string}>}
 */
export async function migrateLegacyState({ dataDir, legacyDir, log }) {
  if (!legacyDir) return { migrated: false, reason: 'disabled' }
  const legacyState = join(legacyDir, 'state.json')
  if (!existsSync(legacyState)) return { migrated: false, reason: 'no-legacy' }

  const target = join(dataDir, 'state.json')
  if (existsSync(target)) return { migrated: false, reason: 'target-exists' }

  await mkdir(dataDir, { recursive: true })
  try {
    const raw = await readFile(legacyState, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log?.warn?.(`旧库格式异常，跳过迁移：${legacyState}`)
      return { migrated: false, reason: 'bad-legacy' }
    }
    // 原样复制（保真优先），再写标记文件；标记失败不影响迁移结果
    await copyFile(legacyState, target)
    try {
      await writeFile(
        join(dataDir, MIGRATE_MARK),
        JSON.stringify({
          from: legacyState,
          at: new Date().toISOString(),
          note: '只读复制自旧插件；旧目录未被修改，可随时回退',
        }, null, 2),
        'utf8',
      )
    } catch { /* ignore */ }
    log?.info?.(`已迁移旧库 → ${target}`)
    return { migrated: true, from: legacyState }
  } catch (error) {
    log?.warn?.(`迁移失败（不影响启动，新库从空开始）：${error?.message || error}`)
    return { migrated: false, reason: 'error' }
  }
}
