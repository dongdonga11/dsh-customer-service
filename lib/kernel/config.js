/**
 * 平台规格与运行配置（kernel 里唯一允许出现平台名的地方）。
 *
 * 设计：所有平台差异 = spec 数据 + adapter 方法；内核不写 `if (platform === ...)`。
 * 端口/目录/URL 一律来自这里，避免散落在 bridge/store/client 三处（旧插件的问题）。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 抖音私信 */
export const DOUYIN_SPEC = {
  name: 'douyin',
  label: '抖音',
  sessionSlug: 'dy',
  defaultPort: 8766,
  loginUrl: 'https://www.douyin.com/',
  extensionDir: 'extension/douyin',
  tabGlob: '*://*.douyin.com/*',
  /** 该 adapter 负责的 thread.platform 取值（同一适配器可管多个平台 id） */
  handles: ['douyin', 'douyin-laike'],
  capabilities: {
    sendMode: 'template',
    requiresSendTemplate: true,
    supportsImages: false,
    supportsPolling: false,
  },
}

/** 抖音来客（与抖音共用同一条 WS 连接、同一 adapter） */
export const DOUYIN_LAIKE_SPEC = {
  ...DOUYIN_SPEC,
  name: 'douyin-laike',
  label: '抖音来客',
  sessionSlug: 'dl',
  loginUrl: 'https://life.douyin.com/',
  tabGlob: '*://life.douyin.com/*',
  capabilities: { sendMode: 'dom', requiresSendTemplate: false, supportsImages: false, supportsPolling: true },
}

/** 闲鱼（M2 接入；当前先占位，适配器未实现时平台不启用） */
export const XIANYU_SPEC = {
  name: 'xianyu',
  label: '闲鱼',
  sessionSlug: 'xy',
  defaultPort: 8765,
  loginUrl: 'https://www.goofish.com/',
  extensionDir: 'extension/xianyu',
  tabGlob: '*://*.goofish.com/*',
  handles: ['xianyu'],
  capabilities: {
    sendMode: 'direct',
    requiresSendTemplate: false,
    supportsImages: true,
    supportsPolling: false,
  },
}

/** 所有已知平台（adapter 可声明 handles 覆盖多个平台 id） */
export const ALL_SPECS = [DOUYIN_SPEC, DOUYIN_LAIKE_SPEC, XIANYU_SPEC]

export function specOf(name) {
  const exact = ALL_SPECS.find((s) => s.name === name)
  if (exact) return exact
  return ALL_SPECS.find((s) => (s.handles || []).includes(name)) || null
}

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

const toInt = (v, d) => {
  if (v === undefined || v === null || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : d
}
const toBool = (v, d) => {
  if (v === undefined || v === null || v === '') return d
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())
}

/**
 * 归一化 Loader 行 config + 环境变量。
 * 环境变量只做**覆盖**（保持与旧插件 env 习惯兼容）：DOUYIN_WS_PORT / XIANYU_WS_PORT 等。
 */
export function resolveConfig(raw = {}, env = process.env) {
  const dataDir = String(raw.dataDir || env.DSH_CS_DATA_DIR || join(dshHome(env), 'dsh-cs'))
  const rawPorts = raw.ports || {}
  const ports = {
    douyin: toInt(env.DOUYIN_WS_PORT ?? rawPorts.douyin, DOUYIN_SPEC.defaultPort),
    xianyu: toInt(env.XIANYU_WS_PORT ?? rawPorts.xianyu, XIANYU_SPEC.defaultPort),
  }
  const host = String(raw.host || env.DSH_CS_WS_HOST || '127.0.0.1')
  const ai = {
    enabled: toBool(env.DSH_CS_AI ?? raw?.ai?.enabled, false),
    model: String(raw?.ai?.model || env.DSH_CS_AI_MODEL || ''),
    provider: String(raw?.ai?.provider || ''),
  }
  /** 事件通知（webhook）：默认关闭；配置后出单/催/风控/评价会 POST 出去 */
  const notify = {
    enabled: toBool(env.DSH_CS_NOTIFY ?? raw?.notify?.enabled, false),
    webhookUrl: String(raw?.notify?.webhookUrl || env.DSH_CS_NOTIFY_WEBHOOK || ''),
    events: Array.isArray(raw?.notify?.events) && raw.notify.events.length
      ? raw.notify.events.map(String)
      : ['order', 'urge', 'rate', 'risk'],
    throttleSeconds: toInt(raw?.notify?.throttleSeconds, 60),
  }
  /** 话术沉淀（后台复盘客户档案 → 更新 knowledge/*.md；默认关闭，避免后台烧 token） */
  const playbook = {
    enabled: toBool(env.DSH_CS_PLAYBOOK ?? raw?.playbook?.enabled, false),
    intervalMinutes: Math.max(1, toInt(raw?.playbook?.intervalMinutes, 30)),
    minNewTurns: Math.max(1, toInt(raw?.playbook?.minNewTurns, 3)),
    model: String(raw?.playbook?.model || ''),
  }
  /** 启用的平台：默认两个都启；adapter 不存在时自动跳过（M1 只有抖音） */
  const platforms = Array.isArray(raw.platforms) && raw.platforms.length
    ? raw.platforms.map(String)
    : ['douyin', 'xianyu']
  return {
    dataDir,
    host,
    ports,
    routePrefix: String(raw.routePrefix || '/dsh-cs').replace(/\/+$/, '') || '/dsh-cs',
    ai,
    notify,
    playbook,
    platforms,
    /** 旧插件数据目录（只读迁移来源；回退时旧库不得被写） */
    migrateFrom: raw.migrateFrom === false ? '' : String(raw.migrateFrom ?? 'dsh-cs-legacy'),
    pairCodeEnv: {
      douyin: env.DOUYIN_PAIR_CODE || '',
      xianyu: env.XIANYU_PAIR_CODE || '',
    },
  }
}
