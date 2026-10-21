/**
 * dsh-cs —— DSH 客服中心（Host 半装配层）。
 *
 * 只做装配，不含业务逻辑：
 *   配置 → 存储（含旧库只读迁移）→ 每平台一条 WS 桥 → 平台适配器
 *        → 内核运行时（入站/落库/AI/事件总线）→ HTTP 路由（面板取数/人工回复）
 *
 * 平台差异全部在 lib/platforms/<name>/adapter.js；内核不写平台 if（见 docs/M1-INTERFACES.md）。
 *
 * ⚠️ 第三方插件初始化失败绝不能拖垮 DSH 启动：apply() 整体 try/catch（旧插件踩过
 *    "web boot 有 entry 没激活 = 应用无法启动" 的坑）。
 */
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

import { CsBridge } from './kernel/bridge.js'
import { Store } from './kernel/store.js'
import { resolveConfig, specOf, dshHome, ALL_SPECS } from './kernel/config.js'
import { resolvePairCode } from './kernel/pairing.js'
import { migrateLegacyState } from './kernel/migrate.js'
import { createRuntime, createBus } from './kernel/runtime.js'
import { createLibrary } from './kernel/library.js'
import { buildLibraryTools } from './kernel/library_tools.js'
import { mountRoutes } from './kernel/routes.js'
import { registerToolDefs } from './kernel/toolkit.js'
import { buildXianyuTools } from './platforms/xianyu/tools.js'
import { buildXianyuStoreTools } from './platforms/xianyu/tools.stores.js'
import { createAutoDeliver } from './platforms/xianyu/auto_deliver.js'
import { runPlaybookOnce, createPlaybookTicker } from './platforms/xianyu/playbook.js'
import { createNotifier, isUrgeMessage } from './kernel/notifier.js'

export const name = 'dsh-cs'
/** 可选服务一律用 ctx.inject；写进 inject 会让没有该服务的 profile 整个插件不激活 */
export const inject = []

/** 平台适配器工厂（懒加载：某个平台适配器缺失时只跳过该平台，不影响其它平台） */
const ADAPTER_FACTORIES = {
  douyin: async () => (await import('./platforms/douyin/adapter.js')).createDouyinAdapter,
  xianyu: async () => (await import('./platforms/xianyu/adapter.js')).createXianyuAdapter,
}

/** 平台工具构建器（按 adapter.spec.name 选择；未列出的平台不注册工具） */
const TOOL_BUILDERS = {
  xianyu: (deps) => [...buildXianyuTools(deps), ...buildXianyuStoreTools(deps)],
}

/** 平台独立存储（懒加载：store 模块缺失时相关工具退化为「明确报错」而不是插件起不来） */
const STORE_FACTORIES = {
  xianyu: async () => {
    const [p, c, k] = await Promise.all([
      import('./platforms/xianyu/product_store.js').catch(() => null),
      import('./platforms/xianyu/customer_store.js').catch(() => null),
      import('./platforms/xianyu/collect_store.js').catch(() => null),
    ])
    return {
      product: p ? p.createProductStore : null,
      customer: c ? c.createCustomerStore : null,
      collect: k ? k.createCollectStore : null,
    }
  },
}

export async function apply(ctx, rawConfig = {}) {
  try {
    await setup(ctx, rawConfig || {})
  } catch (error) {
    const msg = `[dsh-cs] 初始化失败（插件已降级，不影响 DSH）：${error?.message || error}`
    try { ctx.logger?.error?.(msg) } catch { /* ignore */ }
    console.error(msg)
  }
}

function makeLogger(ctx) {
  const call = (level) => (msg) => {
    try {
      if (ctx.logger?.[level]) ctx.logger[level](`[dsh-cs] ${msg}`)
      else console[level === 'info' ? 'log' : level](`[dsh-cs] ${msg}`)
    } catch { /* ignore */ }
  }
  return { info: call('info'), warn: call('warn'), error: call('error'), debug: call('debug') }
}

/**
 * 自有 HTTP 路由鉴权。
 * DSH 的 webServer 没有全局鉴权（官方文档明确），127.0.0.1 对本机所有进程开放，
 * 而这里承载买家隐私 —— 所以必须自己把住：
 *   1) 有 connection 服务时用它判定（浏览器令牌 / peer 信任）；
 *   2) 否则退化为同源校验（Origin 必须等于本 web 服务 origin）。
 */
function createAuth(ctx, webServer) {
  return {
    check(req) {
      const conn = ctx.get?.('connection')
      if (conn && typeof conn.requestRejection === 'function') {
        try {
          const rejection = conn.requestRejection({ headers: req.headers })
          if (rejection) return { ok: false, status: rejection.status || 403, reason: 'connection rejected' }
          return { ok: true }
        } catch { /* 退化为同源校验 */ }
      }
      let expected = ''
      try { expected = new URL(webServer.getOrigin()).origin } catch { /* ignore */ }
      const origin = req.headers?.origin
      if (expected && origin && origin !== expected) {
        return { ok: false, status: 403, reason: 'origin mismatch' }
      }
      return { ok: true }
    },
  }
}

async function setup(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = makeLogger(ctx)
  log.info(`启动：dataDir=${config.dataDir} ports=${JSON.stringify(config.ports)} platforms=${config.platforms.join(',')}`)

  // ── 1. 数据：只写新目录；旧插件数据只读迁移（迁移必须在 store.init 之前） ──
  const legacyDir = config.migrateFrom ? join(dshHome(), config.migrateFrom) : ''  /** 平台 id → 会话 key 前缀（多平台：xy / dy / dl） */
  const slugByPlatform = Object.fromEntries(ALL_SPECS.map((s) => [s.name, s.sessionSlug]))
  const store = new Store({
    dataDir: config.dataDir,
    sessionSlug: 'dy',
    defaultPlatform: 'douyin',
    label: 'dsh-cs',
    slugByPlatform,
  })
  const migrated = await migrateLegacyState({ dataDir: config.dataDir, legacyDir, log })
  await store.init()
  if (migrated.migrated) log.info(`已从旧库迁移（只读，不覆盖旧库）：${legacyDir}`)
  // 迁移来的账号是旧插件的历史绑定：新插件里它们还没连过桥，统一标记离线，
  // 等扩展真正 hello 配对后再置在线（否则面板/AI 警告会把「历史账号」当成在线平台）。
  let staleOffline = 0
  for (const acc of store.getAccounts()) {
    if (acc && acc.connected !== false) { store.setAccountConnected(acc.id, false); staleOffline++ }
  }
  if (staleOffline) log.info(`已将 ${staleOffline} 个历史账号标记为离线（等扩展重新配对）`)
  // 保险：三套存储目录启动即建好（工具首次使用前备份/验收脚本也能直接看到）
  for (const sub of ['products', 'customers', 'collected', 'knowledge']) {
    try { await mkdir(join(config.dataDir, sub), { recursive: true }) } catch { /* ignore */ }
  }

  // ── 1.5 资料库（项目 = 资料 + 账号绑定；首启把旧全局 knowledge 收进「默认项目」） ──
  const library = createLibrary({ dataDir: config.dataDir, log })
  try {
    const init = await library.ensureInitial({
      legacyKnowledgeDir: join(config.dataDir, 'knowledge'),
      accounts: store.getAccounts().map((a) => ({ platform: a.platform || '', accountId: a.id, label: a.nickname || '' })),
    })
    if (init && init.created) {
      log.info(`资料库：已创建「默认项目」并把 ${store.getAccounts().length} 个账号绑定进去（可去面板改绑/改名）`)
    }
  } catch (error) {
    log.warn(`资料库初始化失败（不影响客服主链路）：${(error && error.message) || error}`)
  }

  // ── 2. 内核运行时（入站分发 / 落库 / 未读 / AI / 事件总线） ──────────────
  const bus = createBus()
  const adapters = []
  const bridges = []
  const runtime = createRuntime({ ctx, config, store, adapters, bus, bridges, log })

  // ── 3. 平台适配器（懒加载；缺失/加载失败只跳过该平台） ──────────────────
  const bridgeByKey = new Map() // 共享键 -> 桥（同一 adapter 的多平台 id 共用一条桥）
  for (const platform of config.platforms) {
    const factoryLoader = ADAPTER_FACTORIES[platform]
    if (!factoryLoader) { log.warn(`未知平台 ${platform}，跳过`); continue }
    let factory
    try {
      factory = await factoryLoader()
    } catch (error) {
      log.warn(`平台 ${platform} 适配器未就绪，跳过：${error?.message || error}`)
      continue
    }
    const spec = specOf(platform) || {}
    const adapter = factory({
      config,
      store,
      log,
      library,
      dataDir: config.dataDir,
      host: config.host,
      legacyDir: platform === 'douyin' ? legacyDir : '',
    })
    adapters.push(adapter)

    // 同一 adapter 的多平台 id 共享一条桥（抖音私信 + 抖音来客）
    const bridgeKey = adapter.bridgeSharingKey || spec.name || platform
    let bridge = bridgeByKey.get(bridgeKey)
    if (!bridge) {
      const pair = resolvePairCode({
        dataDir: config.dataDir,
        platform: spec.name || platform,
        envCode: config.pairCodeEnv?.[spec.name || platform] || '',
        legacyDir: platform === 'douyin' ? legacyDir : '',
      })
      bridge = new CsBridge({
        host: config.host,
        port: config.ports[spec.name || platform] ?? spec.defaultPort,
        pairCode: pair.code,
        defaultPlatform: spec.name || platform,
        label: spec.label || platform,
      })
      bridge.setInboundHandler((msg, accountId) => {
        try { runtime.apply(msg, accountId) } catch (error) { log.error(`入站处理失败：${error?.message || error}`) }
      })
      bridgeByKey.set(bridgeKey, bridge)
      bridges.push(bridge)
      if (pair.generated) log.warn(`${spec.label || platform} 配对码（请填入扩展）：${pair.code}  ws://${config.host}:${bridge.port}/ws`)
      else if (pair.source === 'legacy') log.info(`${spec.label || platform} 沿用旧插件配对码：${pair.code}`)
    }
    runtime.attachBridge(bridge)
  }

  if (!adapters.length) log.warn('没有可用平台适配器：客服中心不启用（仅保留占位）')

  // ── 3.4 AI 平台白名单迁移 ────────────────────────────────────────────────
  // 旧插件只开了 douyin-laike（aiSettings.platforms=['douyin-laike']）；新插件还带闲鱼，
  // 若不迁移，运营者开了 AI 也会出现「闲鱼永远不自动回」（白名单不含 xianyu）。
  try {
    const allPlatforms = new Set()
    for (const a of adapters) {
      const spec = (a && a.spec) || {}
      if (spec.name) allPlatforms.add(spec.name)
      for (const sub of spec.subSpecs || []) if (sub && sub.name) allPlatforms.add(sub.name)
    }
    const s = store.getAiSettings()
    const list = Array.isArray(s.platforms) ? s.platforms.map(String) : []
    const legacyOnly = list.length > 0 && list.every((p) => p === 'douyin' || p === 'douyin-laike')
    if (s.enabled === true && legacyOnly) {
      const merged = [...new Set([...list, ...allPlatforms])].filter((p) => allPlatforms.has(p))
      store.setAiSettings({ platforms: merged })
      log.info(`AI 平台白名单已扩展（旧配置来自抖音插件）：${JSON.stringify(list)} → ${JSON.stringify(merged)}`)
    }
  } catch (error) {
    log.warn(`AI 平台白名单迁移失败（不影响其它功能）：${(error && error.message) || error}`)
  }

  // ── 3.5 平台独立存储（产品库/客户档案/采集库；缺失不影响主链路） ────────
  const platformStores = {}
  for (const adapter of adapters) {
    const name = adapter?.spec?.name
    const factory = name ? STORE_FACTORIES[name] : null
    if (!factory) continue
    try {
      const create = await factory()
      platformStores[name] = {
        product: create.product ? create.product({ dataDir: config.dataDir, log }) : null,
        customer: create.customer ? create.customer({ dataDir: config.dataDir, log }) : null,
        collect: create.collect ? create.collect({ dataDir: config.dataDir, log }) : null,
      }
      const ready = Object.entries(platformStores[name]).filter(([, v]) => v).map(([k]) => k)
      if (ready.length) log.info(`${name} 存储就绪：${ready.join('/')}`)
    } catch (error) {
      log.warn(`${name} 存储初始化失败（相关工具会明确报错）：${error?.message || error}`)
    }
  }

  // ── 3.6 事件旁路：自动交付 + 通知（失败绝不影响收发主链路） ──────────────
  const notifier = createNotifier({ config: config.notify, log })
  const offHooks = []
  const xyAdapter = adapters.find((a) => a?.spec?.name === 'xianyu')
  if (xyAdapter && platformStores.xianyu?.product) {
    offHooks.push(runtime.onEvent(createAutoDeliver({
      adapter: xyAdapter,
      store,
      productStore: platformStores.xianyu.product,
      log,
      notify: (event, payload) => notifier.notify(event, payload),
    })))
  }
  // 出单 / 催货 / 评价 / 风控 → 通知（需在 config notify 里开启）
  offHooks.push(runtime.onEvent(async (ev) => {
    if (!ev || ev.platform !== 'xianyu') return
    const base = {
      accountId: ev.accountId || '',
      buyerId: ev.buyerUid || '',
      chatId: ev.conversationId || '',
      itemId: ev.itemId || '',
      text: String(ev.text || '').slice(0, 200),
    }
    if (ev.kind === 'message') {
      const k = ev.xianyuKind || ''
      if (k === 'delivery_trigger') await notifier.notify('order', { ...base, subtype: 'paid' })
      else if (k === 'confirm_receipt') await notifier.notify('order', { ...base, subtype: 'confirm_receipt' })
      else if (k === 'rate_request') await notifier.notify('rate', base)
      else if (isUrgeMessage(ev.text)) await notifier.notify('urge', base)
    } else if (ev.kind === 'probe' && /风控|验证码|punish|captcha|risk/i.test(String(ev.note || ''))) {
      await notifier.notify('risk', { ...base, detail: String(ev.note || '') })
    }
  }))
  ctx.effect(() => () => {
    for (const off of offHooks) { try { off() } catch { /* ignore */ } }
  }, 'dsh-cs: event hooks')

  // ── 4. 起桥（effect 里启动，disposer 里 await 关闭，HMR 重载不撞端口） ──
  for (const [idx, bridge] of bridges.entries()) {
    ctx.effect(async () => {
      const ok = await bridge.start()
      if (!ok) throw new Error(`桥启动失败（端口 ${bridge.port} 被占用？）`)
      try { runtime.setBridgeStarted(true) } catch { /* ignore */ }
      return async () => {
        try { await bridge.stop() } catch (error) { log.warn(`桥停止异常：${error?.message || error}`) }
      }
    }, `dsh-cs: bridge ${idx}`)
  }

  // ── 5. 平台工具（Agent 可调用；按平台适配器注册，随插件卸载摘除） ─────────
  ctx.inject(['tools'], (scoped) => {
    const tools = scoped?.tools
    if (!tools) return
    const defs = []
    for (const adapter of adapters) {
      const build = TOOL_BUILDERS[adapter?.spec?.name]
      if (!build) continue
      try {
        defs.push(...(build({ adapter, runtime, store, log, stores: platformStores[adapter.spec.name] || {} }) || []))
      } catch (error) {
        log.warn(`构建 ${adapter.spec.name} 工具失败：${error?.message || error}`)
      }
    }
    // 资料库工具（平台无关：列项目/查资料/读文件），让 Agent 也能按项目查资料
    try {
      defs.push(...(buildLibraryTools({ library, log }) || []))
    } catch (error) {
      log.warn(`构建资料库工具失败：${error?.message || error}`)
    }
    if (defs.length) log.info(`已注册 ${defs.length} 个客服工具（${defs.map((d) => d.name).slice(0, 4).join(', ')}…）`)
    ctx.effect(() => registerToolDefs({ tools }, defs, log), 'dsh-cs: platform tools')
  })

  // ── 5.5 话术沉淀定时器（默认关闭；开启后复盘客户档案 → 更新 knowledge/*.md） ──
  if (config.playbook?.enabled && platformStores.xianyu?.customer) {
    const knowledgeDir = join(config.dataDir, 'knowledge')
    const stateFile = join(config.dataDir, 'playbook-state.json')
    const customerStore = platformStores.xianyu.customer
    const readState = async () => {
      try { return JSON.parse(await readFile(stateFile, 'utf8')) || { accounts: {} } } catch { return { accounts: {} } }
    }
    const runOnce = async () => {
      const st = await readState()
      if (!st.accounts) st.accounts = {}
      let changed = false
      for (const acc of store.getAccounts().filter((a) => a.platform === 'xianyu')) {
        const result = await runPlaybookOnce({
          accountId: acc.id,
          customerStore,
          knowledgeDir,
          callModel: (opts) => runtime.callModel(opts),
          model: config.playbook.model,
          minNewTurns: config.playbook.minNewTurns,
          log,
          state: st.accounts[acc.id],
        })
        if (result && result.perBuyer) {
          st.accounts[acc.id] = { perBuyer: result.perBuyer, lastRunAt: new Date().toISOString() }
          changed = true
        }
      }
      if (changed) {
        try {
          await mkdir(config.dataDir, { recursive: true })
          await writeFile(stateFile, JSON.stringify(st, null, 2), 'utf8')
        } catch (error) {
          log.warn(`话术沉淀状态落盘失败: ${(error && error.message) || error}`)
        }
      }
    }
    const ticker = createPlaybookTicker({
      intervalMinutes: config.playbook.intervalMinutes,
      runOnce,
      log,
    })
    ticker.start()
    ctx.effect(() => () => { void ticker.stop() }, 'dsh-cs: playbook ticker')
    log.info(`话术沉淀已启用（每 ${config.playbook.intervalMinutes} 分钟；knowledge=${knowledgeDir}）`)
  }

  // ── 6. 自有 HTTP 路由 + SSE（面板取数 / 人工回复） ───────────────────────
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped?.webServer
    if (!webServer) return
    const auth = createAuth(ctx, webServer)
    ctx.effect(
      () => mountRoutes({ webServer, prefix: config.routePrefix, auth, runtime, bus, config, store, log, library }),
      'dsh-cs: routes',
    )
  })

  // ── 6. 退出：落盘（桥的停止由各自 effect 负责） ──────────────────────────
  ctx.effect(() => () => { void store.save().catch(() => {}) }, 'dsh-cs: store flush')
  ctx.effect(() => () => { try { runtime.dispose() } catch { /* ignore */ } }, 'dsh-cs: runtime dispose')

  // 启动 AI 运行时（若已配置/开启；内部有闸门与错误隔离）
  try { runtime.start?.() } catch (error) { log.warn(`AI 运行时启动异常：${error?.message || error}`) }
  log.info('客服中心已就绪')
}
