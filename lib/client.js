/**
 * dsh-cs — browser half（客服中心 UI；并行验证期标题带「·新」）。
 *
 * 一个左侧栏「全局面板」：往 `sidebar.panellist` 注册图标（点击切面板），
 * 往 `main`（keyed slot，key=本面板 id）注册面板主体。
 *
 * 信息架构（两层）：
 *   第一层 客服中心 —— 平台（抖音 / 闲鱼）下的**账号卡**，带未读与会话数
 *   第二层 账号工作台 —— 该账号的买家会话列表 + 对话区（可人工回复、可改名）
 *
 * 与办公会话隔离：面板数据全部来自 node 半的 `/dsh-cs/*` HTTP 路由
 * （独立的 $DSH_HOME/dsh-cs-legacy 存储），不读不写 ctx.sessions / workspaces。
 *
 * 依赖 `react`（经 ModuleLoader require），无 JSX、无 bundler —— 与
 * dsh-wechat-md 的 client.js 同一写法。
 */

window.__ModuleLoader__.load({
  id: 'dsh-customer-service',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')

    const PANEL_ID = 'cs'

    const PANEL_LABEL = '客服中心'

    // 只用 slots：不做硬依赖 layout（本面板不调 ctx.layout，多一个硬依赖就多一类「等不到服务→entry 激活不了」的风险）
    const inject = ['slots']

    const h = react.createElement

    /**
     * 平台显示名：这里只是**默认表**，真实值由 node 半 `/state` 的 platformLabels 覆盖
     * （新增平台只改平台适配器的 spec.label，前端不用动）。
     */
    const PLATFORM_LABELS = { douyin: '抖音', 'douyin-laike': '抖音来客', xianyu: '闲鱼' }
    const platformLabel = (p) => PLATFORM_LABELS[p] || p || '平台'

    // ── 样式常量 ──────────────────────────────────────────────────────────────

    const S = {
      border: '1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))',
      muted: 'var(--dsw-alias-label-secondary,#666)',
      fg: 'var(--dsw-alias-label-primary,#1a1a1a)',
      bg: 'var(--dsw-alias-bg-base,#fff)',
      hover: 'var(--dsw-alias-bg-hover,rgba(0,0,0,.05))',
      accent: 'var(--dsw-accent,#4d6bfe)',
    }

    const smallBtn = {
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15))',
      background: 'transparent',
      color: S.muted,
      cursor: 'pointer',
    }

    // ── 数据拉取 ──────────────────────────────────────────────────────────────

    async function api(path, options) {
      const res = await fetch(path, options)
      return await res.json().catch(() => ({}))
    }

    const postJson = (path, body) =>
      api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })

    // ── 小组件 ────────────────────────────────────────────────────────────────

    function Btn(props) {
      const { onClick, disabled, primary, children, style } = props
      return h(
        'button',
        {
          onClick,
          disabled: !!disabled,
          style: {
            padding: '6px 12px',
            borderRadius: 8,
            border: primary ? '1px solid ' + S.accent : '1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12))',
            background: primary ? S.accent : 'transparent',
            color: primary ? '#fff' : S.fg,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            fontSize: 13,
            ...(style || {}),
          },
        },
        children,
      )
    }

    /** 头像占位：有真实头像用图，否则用名字首字色块（不阻塞列表）。 */
    function Avatar({ url, name, size = 32 }) {
      const char = (name || '?').trim().charAt(0) || '?'
      const base = {
        width: size,
        height: size,
        borderRadius: '50%',
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.45,
        color: '#fff',
        background: '#8b93a7',
        overflow: 'hidden',
      }
      if (url) {
        return h('img', { src: url, alt: '', style: { ...base, objectFit: 'cover' } })
      }
      return h('span', { style: base }, char)
    }

    function Badge({ count }) {
      if (!count) return null
      return h(
        'span',
        {
          style: {
            background: '#e5484d',
            color: '#fff',
            fontSize: 11,
            borderRadius: 9,
            padding: '1px 6px',
            flex: 'none',
          },
        },
        count,
      )
    }

    // ── 客服中心面板 ──────────────────────────────────────────────────────────

    function CsPanel() {
      const [state, setState] = react.useState(null)
      const [view, setView] = react.useState('hub') // 'hub' | 'account'
      const [activeAccountId, setActiveAccountId] = react.useState(null)
      const [activeThreadId, setActiveThreadId] = react.useState(null)
      const [threadData, setThreadData] = react.useState(null)
      const [draft, setDraft] = react.useState('')
      const [sending, setSending] = react.useState(false)
      const [notice, setNotice] = react.useState('')
      const [loadError, setLoadError] = react.useState('')
      const [showBridge, setShowBridge] = react.useState(false)
      /** 会话改名弹窗（Electron 无 window.prompt） */
      const [renameDlg, setRenameDlg] = react.useState(null)
      /** AI 沙箱测试弹窗（不发送到平台、不落会话） */
      const [sandboxOpen, setSandboxOpen] = react.useState(false)

      const loadState = react.useCallback(async () => {
        try {
          const data = await api('/dsh-cs/state')
          if (data && data.ok) {
            // node 半下发的平台元数据（label/capabilities）覆盖前端默认表
            if (data.platformLabels) Object.assign(PLATFORM_LABELS, data.platformLabels)
            setState(data)
            setLoadError('')
          } else {
            setLoadError((data && data.error) || '后端未响应')
          }
        } catch (e) {
          setLoadError(String((e && e.message) || e))
        }
      }, [])

      const loadThread = react.useCallback(async (id) => {
        const data = await api('/dsh-cs/thread?id=' + encodeURIComponent(id))
        setThreadData((prev) => {
          // 内容没变就沿用旧引用：避免每 2.5s 一次无谓重渲染（也会打断滚动位置）
          try {
            if (prev && JSON.stringify(prev) === JSON.stringify(data)) return prev
          } catch {
            /* 比较失败就当变了 */
          }
          return data
        })
      }, [])

      // 当前打开的会话 id 必须用 ref 跟踪：SSE/轮询回调是长生命周期闭包，
      // 直接闭包 state 会永远读到初始值（null）—— 这正是「左侧未读有更新、
      // 右侧消息却不刷新」的原因（只刷新了列表，没刷新对话）。
      const activeThreadIdRef = react.useRef(null)
      react.useEffect(() => {
        activeThreadIdRef.current = activeThreadId
      }, [activeThreadId])

      /** 消息区滚动容器：切会话时跳到底，新消息到达时只在「用户本来就在底部」才跟随，
       *  否则会打断往上翻历史。 */
      const msgBoxRef = react.useRef(null)
      const lastThreadRef = react.useRef(null)
      const msgCountRef = react.useRef(0)
      react.useEffect(() => {
        const el = msgBoxRef.current
        const count = (threadData && threadData.messages && threadData.messages.length) || 0
        const switched = lastThreadRef.current !== activeThreadId
        lastThreadRef.current = activeThreadId
        const prevCount = msgCountRef.current
        msgCountRef.current = count
        if (!el) return
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        if (switched || (count > prevCount && nearBottom)) el.scrollTop = el.scrollHeight
      }, [threadData, activeThreadId])

      // ── AI 状态（总开关 / 模型 / 知识库 / 转人工队列）──────────────────────
      const [aiSettings, setAiSettings] = react.useState(null)
      const [aiLog, setAiLog] = react.useState([])
      const [showAiLog, setShowAiLog] = react.useState(false)
      const [aiTest, setAiTest] = react.useState(null)

      /** AI 诊断对准哪个平台：优先当前打开的账号，其次第一个已连接账号（否则内核自己选） */
      const aiPlatformRef = react.useRef('')
      react.useEffect(() => {
        const accs = (state && state.accounts) || []
        const active = activeAccountId ? accs.find((a) => a.id === activeAccountId) : accs[0]
        aiPlatformRef.current = (active && active.platform) || ''
      }, [state, activeAccountId])

      const loadAi = react.useCallback(async () => {
        try {
          const p = aiPlatformRef.current
          const data = await api('/dsh-cs/ai-settings' + (p ? '?platform=' + encodeURIComponent(p) : ''))
          if (data && data.ok) setAiSettings(data)
        } catch {
          /* ignore */
        }
      }, [])

      /** 刷新「列表 + 当前打开的会话」。先拉会话（顺带把它标为已读），再拉列表，
       *  这样未读角标能立刻反映已经看过。 */
      const refresh = react.useCallback(async () => {
        const id = activeThreadIdRef.current
        if (id) await loadThread(id)
        await loadState()
        await loadAi()
      }, [loadState, loadThread, loadAi])

      react.useEffect(() => {
        refresh()
        // SSE 实时刷新（node 半在入站消息时推送）；失败则靠轮询兜底
        let es = null
        try {
          es = new EventSource('/dsh-cs/refresh-event')
          es.onmessage = () => refresh()
        } catch {
          /* EventSource 不可用则忽略 */
        }
        const poll = setInterval(refresh, 2500)
        return () => {
          clearInterval(poll)
          if (es) es.close()
        }
      }, [refresh])

      react.useEffect(() => {
        if (activeThreadId) loadThread(activeThreadId)
      }, [activeThreadId, loadThread])

      const flash = (msg) => {
        setNotice(msg)
        // 发送失败绝不能一闪而过：DOM 自动化 + 回读确认最长要十几秒，
        // 4 秒的提示用户很可能根本没看到，就会误以为发出去了。
        setTimeout(() => setNotice(''), 15000)
      }

      // ── AI 自动回复：开关 / 接管 / 审计 ────────────────────────────────────
      const toggleAi = async () => {
        const next = !(aiSettings && aiSettings.settings && aiSettings.settings.enabled)
        if (next && !window.confirm('开启后 AI 会**自动**回复买家咨询（发货/售后/价格等常见问题）。\n\n拿不准的会自动转人工；涉及退款赔付、承诺、投诉的一律不自动回。\n\n确定开启？')) return
        // 启用时把「当前已知平台」写进白名单，避免旧配置只有抖音导致闲鱼永不自动回
        const knownPlatforms = Object.keys((state && state.platformLabels) || {})
        const body = { enabled: next }
        if (next && knownPlatforms.length) body.platforms = knownPlatforms
        const r = await postJson('/dsh-cs/ai-settings', body)
        if (!r || !r.ok) {
          flash('AI 开关失败：' + ((r && r.error) || '未知'))
          return
        }
        await loadAi()
        flash(next ? '✅ AI 自动回复已开启' : 'AI 自动回复已关闭')
      }

      const setThreadAi = async (threadId, mode) => {
        const r = await postJson('/dsh-cs/ai-mode', { threadId, mode })
        if (!r || !r.ok) {
          flash('设置失败：' + ((r && r.error) || '未知'))
          return
        }
        await refresh()
        flash(mode === 'human' ? '已切为人工接管（AI 不再插话）' : '已交回 AI 自动回复')
      }

      const openAiLog = async () => {
        const data = await api('/dsh-cs/ai-log?limit=80')
        setAiLog((data && data.log) || [])
        setShowAiLog(true)
      }

      /** 真跑一次模型：接线有问题（比如 message 形状不对）时一眼看出来。 */
      const testAi = async () => {
        setShowAiLog(true)
        setAiTest({ running: true })
        const pf = aiPlatformRef.current || ''
        const acct = ((state && state.accounts) || []).find((x) => (x.platform || '') === pf) || null
        const r = await postJson('/dsh-cs/ai-test', { question: '你好，这个怎么卖？', platform: pf, accountId: acct ? acct.id : '' })
        setAiTest(r || { ok: false, error: '无响应' })
        await openAiLog()
        if (r && r.ok) {
          flash(`✅ 模型通了（${r.ms}ms）：${String(r.reply || '').slice(0, 50)}`)
        } else {
          flash(`❌ 模型调用失败：${(r && r.error) || '未知'}`)
        }
      }

      const send = async () => {
        const text = draft.trim()
        if (!text || !activeThreadId || sending) return
        setSending(true)
        try {
          const res = await postJson('/dsh-cs/send', { threadId: activeThreadId, text })
          if (res.ok) {
            setDraft('')
            await refresh()
          } else {
            // 明确标成失败 + 保留草稿（失败时不清空，用户不用重打）
            flash('⚠️ 没发出去：' + (res.error || '发送失败'))
          }
        } catch (e) {
          flash('发送失败: ' + (e?.message || e))
        } finally {
          setSending(false)
        }
      }

      const renameThread = (t) => {
        const current = t.displayName || ''
        setRenameDlg({ threadId: t.id, value: t.nameKnown ? current : '', hint: '给这个买家起个名字（留空则恢复默认）；当前 id：' + (t.buyerSecUid || t.buyerUid || '—') })
      }

      const submitRenameThread = async () => {
        const d = renameDlg
        if (!d || d.busy) return
        setRenameDlg({ ...d, busy: true })
        const r = await postJson('/dsh-cs/rename', { threadId: d.threadId, name: d.value })
        if (r && r.ok) {
          setRenameDlg(null)
          await loadState()
          if (activeThreadIdRef.current === d.threadId) await loadThread(d.threadId)
        } else {
          flash('改名失败：' + ((r && r.error) || '未知错误'))
          setRenameDlg({ ...d, busy: false })
        }
      }

      const deleteThread = async (t) => {
        if (!window.confirm('删除这个会话（含聊天记录）？只删本地，不影响平台那边。')) return
        const r = await postJson('/dsh-cs/delete-thread', { threadId: t.id })
        if (r && r.ok) {
          if (activeThreadId === t.id) {
            setActiveThreadId(null)
            setThreadData(null)
          }
          loadState()
        } else {
          flash('删除失败：' + ((r && r.error) || '未知错误'))
        }
      }

      const clearAll = async () => {
        if (!window.confirm('清空全部客服数据（会话 / 消息 / 通讯录）？此操作不可撤销。')) return
        const r = await postJson('/dsh-cs/reset')
        if (r && r.ok) {
          setActiveThreadId(null)
          setThreadData(null)
          setActiveAccountId(null)
          setView('hub')
          loadState()
        } else {
          flash('清空失败：' + ((r && r.error) || '未知错误'))
        }
      }

      // ── 加载态 ──────────────────────────────────────────────────────────────
      if (!state) {
        return h(
          'div',
          { style: { padding: 24, color: '#888', fontSize: 13, lineHeight: 1.8 } },
          h('div', null, '正在加载客服中心…'),
          loadError
            ? h(
                'div',
                { style: { marginTop: 8, color: '#b3261e' } },
                '后端未响应（' + loadError + '）。插件 node 半可能启动失败，或 /dsh-cs/state 未注册；重启 DSH 后仍如此请查看启动日志。',
              )
            : null,
        )
      }

      const accounts = state.accounts || []
      const allThreads = state.threads || []
      const activeAccount = accounts.find((a) => a.id === activeAccountId)
      const platformNames = [...new Set(accounts.map((a) => a.platform || 'douyin'))]

      // 桥信息（折叠）：按平台显示各自的端口/配对码（多平台填错码是踩过的坑）
      const platformRows = Array.isArray(state.platforms) ? state.platforms : []
      const bridgeBox = showBridge
        ? h(
            'div',
            { style: { padding: 12, fontSize: 12, color: S.muted, lineHeight: 1.8, background: S.hover } },
            h('div', null, '桥状态：' + (state.bridgeStarted ? '✅ 已启动' : '❌ 未启动')),
            ...(platformRows.length
              ? platformRows.map((p) =>
                  h(
                    'div',
                    { key: p.name },
                    `${p.label || p.name}：ws://${p.host || '127.0.0.1'}:${p.port || '?'}/ws · 配对码 ${p.pairCode || '—'} · ${p.accountCount ? `${p.accountCount} 个账号` : '未接入'}${p.connected ? '（在线）' : ''}`,
                  ),
                )
              : [
                  h('div', { key: 'code' }, '配对码：' + (state.pairCode || '—')),
                  h('div', { key: 'addr' }, '桥地址：ws://127.0.0.1:' + state.wsPort + '/ws'),
                ]),
            h('div', { style: { marginTop: 4 } }, '装扩展：Chrome → chrome://extensions → 开发者模式 → 加载已解压扩展 → 选插件目录 extension/'),
            h('div', null, '⚠ 每个平台有**自己的**端口和配对码：闲鱼填 8765 那行，抖音填 18766 那行；填错会显示「配对码不正确」。'),
          )
        : null

      const topBar = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: S.border,
            flex: 'none',
            gap: 8,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } }, ...(view === 'account'
          ? [
              h(
                'button',
                {
                  key: 'back',
                  onClick: () => {
                    setView('hub')
                    setActiveThreadId(null)
                    setThreadData(null)
                  },
                  style: { ...smallBtn, fontSize: 13, padding: '2px 10px' },
                  title: '返回客服中心',
                },
                '← 返回',
              ),
              h(
                'span',
                { style: { fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                activeAccount?.displayName || '账号',
              ),
            ]
          : [h('span', { key: 'title', style: { fontSize: 14, fontWeight: 600 } }, PANEL_LABEL)])),
        h(
          'div',
          { style: { display: 'flex', gap: 6, flex: 'none', alignItems: 'center' } },
          // AI 自动回复总开关：一眼看到状态，一键开关
          (() => {
            const s = (aiSettings && aiSettings.settings) || {}
            const on = s.enabled === true
            const m = (aiSettings && aiSettings.resolvedModel) || {}
            const kbs = Array.isArray(aiSettings && aiSettings.platformKbs) ? aiSettings.platformKbs : []
            const accountPlatforms = ((state && state.accounts) || []).map((a) => a.platform)
            const relevant = kbs.filter((p) => (accountPlatforms.length ? accountPlatforms.includes(p.platform) : true))
            const entries = relevant.length
              ? relevant
              : (kbs.length ? kbs : [{ platform: '', label: '知识库', kb: (aiSettings && aiSettings.kb) || {} }])
            const kbLine = entries
              .map((p) => `${p.label || p.platform || '知识库'}：${p.kb && p.kb.chars > 0 ? p.kb.chars + ' 字' : '读不到'}`)
              .join(' · ')
            const kbOk = entries.some((p) => p.kb && p.kb.chars > 0)
            const llmOk = Boolean(aiSettings && aiSettings.llmAvailable)
            // 只有「真正连着扩展的平台账号」才需要 AI 就绪；迁移来的历史账号不算
            const livePlatforms = ((state && state.platforms) || [])
              .filter((p) => p && p.connected !== false && (Number(p.accountCount) || 0) > 0)
              .map((p) => p.name)
            const liveEntries = livePlatforms.length ? entries.filter((p) => livePlatforms.includes(p.platform)) : []
            const ready = llmOk && (liveEntries.length ? liveEntries.some((p) => p.kb && p.kb.chars > 0) : true)
            return h(
              'button',
              {
                onClick: toggleAi,
                style: {
                  ...smallBtn,
                  background: on ? 'rgba(46,160,67,.14)' : 'transparent',
                  color: on ? '#2ea043' : S.muted,
                  fontWeight: 600,
                },
                title:
                  `AI 自动回复：${on ? '已开启' : '已关闭'}\n` +
                  `模型：${m.provider || '?'} / ${m.model || '?'}\n` +
                  `知识库：${kbLine}\n` +
                  `llm 服务：${llmOk ? '可用' : '不可用'}\n` +
                  `店铺/实时数据：${aiSettings && aiSettings.realtime ? aiSettings.realtime.status : '?'}`,
              },
              `AI ${on ? '已开' : '已关'}${ready ? '' : ' ⚠'}`,
            )
          })(),
          h('button', { onClick: () => setSandboxOpen(true), style: smallBtn, title: 'AI 测试（沙箱）：测当前账号，不发送到平台' }, activeAccount ? 'AI 测试·当前账号' : 'AI 测试'),
          h('button', { onClick: openAiLog, style: smallBtn, title: 'AI 回复审计（可回溯每一次）' }, 'AI 记录'),          h('button', { onClick: testAi, style: smallBtn, title: '真跑一次模型，验证接线（知识库/模型/解析）' }, '试一下'),
          h(
            'button',
            { onClick: () => setShowBridge((v) => !v), style: smallBtn, title: '桥状态与扩展接入说明' },
            showBridge ? '收起桥信息' : '桥信息',
          ),
          h('button', { onClick: clearAll, style: smallBtn, title: '清空全部客服数据' }, '清空数据'),
        ),
      )

      // AI 未就绪时的提示条（开关开了但知识库/模型有问题 → 这里直接说清）
      const aiWarn = (() => {
        if (!aiSettings) return null
        const s = aiSettings.settings || {}
        if (s.enabled !== true) return null
        const kbs = Array.isArray(aiSettings.platformKbs) ? aiSettings.platformKbs : []
        const llmOk = Boolean(aiSettings.llmAvailable)
        // 关键：只对「真正接了扩展的平台」判定就绪。迁移来的历史账号不算在线平台，
        // 否则会出现「抖音知识库读不到」这种与当前闲鱼使用无关的红条。
        const livePlatforms = ((state && state.platforms) || [])
          .filter((p) => p && p.connected !== false && (Number(p.accountCount) || 0) > 0)
          .map((p) => p.name)
        if (!livePlatforms.length) {
          return h(
            'div',
            { style: { padding: '6px 14px', fontSize: 12, color: S.muted, background: 'rgba(0,0,0,.03)', flex: 'none' } },
            'AI 已开启：等账号接入后生效（先在 Chrome 里装扩展并完成配对）',
          )
        }
        const missing = kbs.filter((p) => livePlatforms.includes(p.platform) && !(p.kb && p.kb.chars > 0))
        // 区分两类：账号没绑项目（提示，灰色）vs 项目资料/规则坏了（红色告警）
        const isUnbound = (p) => /分配项目/.test(String((p.kb && p.kb.error) || ''))
        const unbound = missing.filter(isUnbound)
        const broken = missing.filter((p) => !isUnbound(p))
        if (broken.length === 0 && llmOk) {
          if (!unbound.length) return null
          return h(
            'div',
            { style: { padding: '6px 14px', fontSize: 12, color: S.muted, background: 'rgba(0,0,0,.03)', flex: 'none' } },
            `提示：${unbound.map((p) => `${p.label || p.platform}账号还没分配到项目，AI 不会用它自动回复（去「资料库」绑定即可）`).join('；')}`,
          )
        }
        const kbPart = broken
          .map((p) => {
            const err = (p.kb && p.kb.error) || '知识库不可用'
            const label = p.label || p.platform || '知识库'
            return `${label} 知识库读不到（${err}）`
          })
          .join('；')
        const unbindPart = unbound.map((p) => `${p.label || p.platform}账号未分配项目`).join('；')
        return h(
          'div',
          { style: { padding: '6px 14px', fontSize: 12, color: '#b3261e', background: 'rgba(179,38,30,.06)', flex: 'none' } },
          `⚠ AI 已开启但还不能用：${llmOk ? '' : 'llm 服务不可用；'}${[kbPart, unbindPart].filter(Boolean).join('；')}`,
        )
      })()

      // AI 审计面板（每条可回溯）
      const aiLogBox = showAiLog
        ? h(
            'div',
            {
              style: {
                maxHeight: 260,
                overflowY: 'auto',
                borderBottom: S.border,
                padding: '8px 14px',
                fontSize: 12,
                flex: 'none',
                background: S.hover,
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
              h('span', { style: { fontWeight: 600, color: S.fg } }, `AI 回复记录（最近 ${aiLog.length} 条）`),
              h('button', { onClick: () => setShowAiLog(false), style: { ...smallBtn, padding: '0 6px' } }, '关闭'),
            ),
            // 「试一下」的结果：模型/知识库接线是否正常，一眼可见
            aiTest
              ? h(
                  'div',
                  {
                    style: {
                      marginBottom: 6,
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: aiTest.running ? 'transparent' : aiTest.ok ? 'rgba(46,160,67,.12)' : 'rgba(179,38,30,.1)',
                      color: aiTest.running ? S.muted : aiTest.ok ? '#2ea043' : '#b3261e',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    },
                  },
                  aiTest.running
                    ? '正在试跑模型…'
                    : aiTest.ok
                      ? `模型通了（${aiTest.ms}ms，${aiTest.model || '默认模型'})` +
					`\n项目：${(aiTest.project && aiTest.project.name) || '—'} · 知识库 ${aiTest.kbChars || 0} 字` +
					`\n问题：${aiTest.question}\n回答：${aiTest.reply || aiTest.raw || '(空)'}` +
                        (aiTest.escalate ? '\n（判定转人工：' + (aiTest.guard || aiTest.modelReason || '模型认为需要人工') + '）' : '')
                      : `模型调用失败：${aiTest.error || '未知'}`,
                )
              : null,
            aiLog.length === 0
              ? h('div', { style: { color: S.muted } }, '还没有记录。AI 每处理一次（无论发没发出去）都会留一条。')
              : aiLog.map((r, i) =>
                  h(
                    'div',
                    { key: i, style: { padding: '4px 0', borderTop: i ? '1px solid rgba(0,0,0,.06)' : 'none', color: S.fg } },
                    h(
                      'span',
                      { style: { color: r.sent ? '#2ea043' : '#b3261e', fontWeight: 600, marginRight: 6 } },
                      r.sent ? '已发' : r.stage === 'escalate' ? '转人工' : r.stage === 'blocked' ? '被拦截' : '失败',
                    ),
                    h('span', { style: { color: S.muted, marginRight: 6 } }, String(r.at || '').slice(11, 19)),
                    h('span', null, r.sent ? String(r.reply || '').slice(0, 60) : String(r.guard || r.error || '').slice(0, 80)),
                    h('span', { style: { color: S.muted, marginLeft: 6 } }, r.ms ? `${r.ms}ms` : ''),
                  ),
                ),
          )
        : null

      const noticeBar = notice
        ? h('div', { style: { padding: '6px 14px', fontSize: 12, color: '#b3261e', background: 'rgba(179,38,30,.06)', flex: 'none' } }, notice)
        : null

      // ── 会话改名弹窗（Electron 无 window.prompt，必须自绘） ────────────────
      const renameDlgBox = renameDlg
        ? h(
            'div',
            {
              style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
              onClick: (e) => { if (e.target === e.currentTarget) setRenameDlg(null) },
            },
            h(
              'div',
              { style: { width: 360, maxWidth: '90vw', background: S.bg, color: S.fg, borderRadius: 10, padding: 14, border: S.border, boxShadow: '0 10px 40px rgba(0,0,0,.25)' } },
              h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, '会话改名'),
              h('div', { style: { fontSize: 12, color: S.muted, marginBottom: 8, lineHeight: 1.6 } }, renameDlg.hint || ''),
              h('input', {
                autoFocus: true,
                value: renameDlg.value || '',
                onChange: (e) => setRenameDlg({ ...renameDlg, value: e.target.value }),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') submitRenameThread()
                  if (e.key === 'Escape') setRenameDlg(null)
                },
                style: { width: '100%', padding: '6px 8px', border: S.border, borderRadius: 6, fontSize: 13, background: S.bg, color: S.fg, boxSizing: 'border-box' },
              }),
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 } },
                h('button', { onClick: () => setRenameDlg(null), style: smallBtn }, '取消'),
                h('button', { onClick: submitRenameThread, disabled: renameDlg.busy, style: { ...smallBtn, padding: '4px 12px', fontWeight: 600, color: '#fff', border: 'none', background: S.accent } }, renameDlg.busy ? '保存中…' : '保存'),
              ),
            ),
          )
        : null

      // ══ 第一层：客服中心（平台 → 账号）══════════════════════════════════════
      if (view === 'hub') {
        const body =
          accounts.length === 0
            ? h(
                'div',
                { style: { padding: 24, fontSize: 13, color: S.muted, lineHeight: 1.9 } },
                h('div', { style: { fontWeight: 600, marginBottom: 8, color: S.fg } }, '还没绑定账号'),
                h('div', null, '① 点右上角「桥信息」，找到对应平台（闲鱼 8765 / 抖音 18766）那行的配对码'),
                h('div', null, '② Chrome 装扩展（chrome://extensions → 开发者模式 → 加载已解压扩展 → extension/ 目录）'),
                h('div', null, '③ 扩展里填桥地址 + 配对码，徽章变 ON'),
                h('div', null, '④ 抖音私信：登录 douyin.com 打开私信面板'),
                h('div', null, '⑤ 抖音来客：打开来客客服工作台 life.douyin.com/cs/web/（页面开着即可，不用管它）'),
              )
            : h(
                'div',
                { style: { padding: 14, overflowY: 'auto' } },
                platformNames.map((p) =>
                  h(
                    'div',
                    { key: p, style: { marginBottom: 18 } },
                    h(
                      'div',
                      { style: { fontSize: 12, color: S.muted, marginBottom: 8, fontWeight: 600 } },
                      platformLabel(p),
                    ),
                    ...accounts
                      .filter((a) => (a.platform || 'douyin') === p)
                      .map((a) =>
                        h(
                          'button',
                          {
                            key: a.id,
                            onClick: () => {
                              setActiveAccountId(a.id)
                              setView('account')
                              setActiveThreadId(null)
                              setThreadData(null)
                            },
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              width: '100%',
                              textAlign: 'left',
                              padding: '12px 14px',
                              marginBottom: 8,
                              borderRadius: 10,
                              border: S.border,
                              background: S.bg,
                              color: S.fg,
                              cursor: 'pointer',
                            },
                          },
                          h(Avatar, { name: a.displayName || a.id, size: 36 }),
                          h(
                            'div',
                            { style: { flex: 1, minWidth: 0 } },
                            h(
                              'div',
                              { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                              h(
                                'span',
                                { style: { fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                                a.displayName || a.id,
                              ),
                              a.connected ? h('span', { style: { fontSize: 12, color: '#2ea043' } }, '● 在线') : h('span', { style: { fontSize: 12, color: '#999' } }, '○ 离线'),
                            ),
                            h(
                              'div',
                              { style: { fontSize: 12, color: S.muted, marginTop: 2 } },
                              a.threadCount + ' 个会话' + (a.canSend ? ' · 可发送' : ' · 待捕获发送模板'),
                            ),
                          ),
                          h(Badge, { count: a.unread }),
                          h('span', { style: { fontSize: 12, color: S.muted } }, '进入 ›'),
                        ),
                      ),
                  ),
                ),
              )

        return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', background: S.bg, color: S.fg } }, topBar, bridgeBox, aiWarn, aiLogBox, noticeBar, body, renameDlgBox, sandboxOpen ? h(AiSandbox, { accounts, account: activeAccount, initialAccountId: activeAccountId || '', onClose: () => setSandboxOpen(false) }) : null)
      }

      // ══ 第二层：账号工作台（会话列表 + 对话）════════════════════════════════
      const threads = allThreads.filter((t) => t.accountId === activeAccountId)
      const activeThread = threads.find((t) => t.id === activeThreadId)
      const messages = threadData?.messages || []

      const threadList = h(
        'div',
        { style: { width: 220, borderRight: S.border, overflowY: 'auto', flex: 'none' } },
        threads.length === 0
          ? h('div', { style: { padding: 16, color: '#999', fontSize: 12, lineHeight: 1.7 } }, '暂无买家会话', h('div', { style: { marginTop: 6 } }, '让客户发条私信就会出现在这里'))
          : threads.map((t) =>
              h(
                'div',
                {
                  key: t.id,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06))',
                    background: t.id === activeThreadId ? S.hover : 'transparent',
                  },
                },
                h(
                  'button',
                  {
                    onClick: () => setActiveThreadId(t.id),
                    style: { flex: 1, minWidth: 0, textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: S.fg },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
                    h(
                      'span',
                      { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } },
                      t.displayName || '买家',
                    ),
                    h(Badge, { count: t.unread }),
                  ),
                  h(
                    'div',
                    { style: { fontSize: 12, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    t.lastMessage || '',
                  ),
                ),
                h(
                  'button',
                  {
                    onClick: () => deleteThread(t),
                    title: '删除这个会话（只删本地）',
                    style: { ...smallBtn, padding: '0 6px', flex: 'none' },
                  },
                  '×',
                ),
              ),
            ),
      )

      let chatPane
      if (!activeThread) {
        chatPane = h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', fontSize: 13 } }, '点击左侧会话查看')
      } else {
        const msgs = messages.map((m, i) =>
          h(
            'div',
            { key: i, style: { display: 'flex', justifyContent: m.direction === 'out' ? 'flex-end' : 'flex-start', marginBottom: 8 } },
            h(
              'div',
              {
                style: {
                  maxWidth: '70%',
                  padding: '8px 12px',
                  borderRadius: 12,
                  background: m.direction === 'out' ? S.accent : S.hover,
                  color: m.direction === 'out' ? '#fff' : S.fg,
                  fontSize: 13,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              },
              // AI 自动发的标一下，便于店主事后核对（可回溯的一部分）
              m.by === 'ai'
                ? h(
                    'span',
                    {
                      style: {
                        fontSize: 10,
                        border: '1px solid rgba(255,255,255,.55)',
                        borderRadius: 6,
                        padding: '0 4px',
                        marginRight: 6,
                        verticalAlign: 'middle',
                      },
                      title: '这条是 AI 自动回复的',
                    },
                    'AI',
                  )
                : null,
              m.text,
            ),
          ),
        )
        chatPane = h(
          'div',
          { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } },
          h(
            'div',
            {
              style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: S.border, flex: 'none' },
            },
            h(Avatar, { url: activeThread.avatar, name: activeThread.displayName, size: 26 }),
            h(
              'span',
              { style: { fontSize: 13, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              activeThread.displayName || '买家',
            ),
            activeThread.nameKnown
              ? null
              : h('span', { style: { fontSize: 11, color: S.muted }, title: '抖音还没提供这个买家的昵称，显示的是他的用户 ID' }, '未获取到昵称'),
            // AI 转人工标记：让店主一眼看到哪条需要人接手
            activeThread.aiEscalated
              ? h(
                  'span',
                  {
                    style: { fontSize: 11, color: '#b3261e', background: 'rgba(179,38,30,.1)', padding: '1px 6px', borderRadius: 8 },
                    title: 'AI 没敢自动回：' + (activeThread.aiEscalatedReason || ''),
                  },
                  '待人工',
                )
              : null,
            // 会话级：人工接管 / 交回 AI
            //
            // 规则（店主定的）：**人工回了一条 → 这个会话自动转人工接管**，AI 不再插话；
            // 直到你在这里手动点「交回 AI」，之后的新消息才继续由 AI 回。
            h(
              'button',
              {
                onClick: () => setThreadAi(activeThread.id, activeThread.aiMode === 'human' ? 'auto' : 'human'),
                style: {
                  ...smallBtn,
                  color: activeThread.aiMode === 'human' ? '#b3261e' : S.muted,
                  fontWeight: activeThread.aiMode === 'human' ? 600 : 400,
                },
                title:
                  activeThread.aiMode === 'human'
                    ? '你已人工接管这个会话（回过消息后自动切换）。点这里把后续消息交回 AI。'
                    : '让 AI 不要在这个会话里插话（转人工接管）',
              },
              activeThread.aiMode === 'human' ? 'AI 已让位 · 点此交回' : '让 AI 别管',
            ),
            h('button', { onClick: () => renameThread(activeThread), style: smallBtn, title: '手动起个名字（留空恢复默认）' }, '改名'),
          ),
          h('div', { ref: msgBoxRef, style: { flex: 1, overflowY: 'auto', padding: 14 } }, msgs),
          h(
            'div',
            { style: { display: 'flex', gap: 8, padding: 10, borderTop: S.border, flex: 'none' } },
            h('input', {
              value: draft,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              },
              placeholder: '回复买家（Enter 发送）',
              style: {
                flex: 1,
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15))',
                fontSize: 13,
                background: S.bg,
                color: S.fg,
              },
            }),
            h(Btn, { onClick: send, disabled: !draft.trim() || sending, primary: true }, sending ? '发送中…' : '发送'),
          ),
        )
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', background: S.bg, color: S.fg } },
        topBar,
        bridgeBox,
        aiWarn,
        aiLogBox,
        noticeBar,
        h('div', { style: { flex: 1, display: 'flex', minHeight: 0 } }, threadList, chatPane),
        renameDlgBox,
        sandboxOpen ? h(AiSandbox, { accounts, account: activeAccount, initialAccountId: activeAccountId || '', onClose: () => setSandboxOpen(false) }) : null,
      )
    }

    // ── AI 沙箱测试（弹窗；不发送到抖音/闲鱼，不落会话，不污染侧边聊天区） ──
    function AiSandbox({ accounts, account = null, initialAccountId, onClose }) {
      /** 账号 → 项目（用于默认选一个「有资料」的账号，避免测出来全是转人工） */
      const [projects, setProjects] = react.useState([])
      const [accountId, setAccountId] = react.useState(account ? account.id : (initialAccountId || ''))
      const [turns, setTurns] = react.useState([]) // {role:'buyer'|'ai', text, meta?}
      const [input, setInput] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const listRef = react.useRef(null)
      const active = (accounts || []).find((a) => a.id === accountId) || null

      react.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const r = await api('/dsh-cs/library/projects')
            if (alive && r && r.ok) setProjects(r.projects || [])
          } catch { /* ignore */ }
        })()
        return () => { alive = false }
      }, [])

      const projectOf = (acc) => {
        if (!acc) return null
        const hit = (projects || []).find((p) => (p.accounts || []).some((b) => b.platform === acc.platform && String(b.accountId) === acc.id))
        return hit ? hit.name : null
      }

      // 默认账号：优先「已绑定项目且在线」→「已绑定项目」→「在线」→ 第一个
      react.useEffect(() => {
        if (accountId || !(accounts || []).length) return
        const bound = (accounts || []).filter((a) => projectOf(a))
        const pick =
          (initialAccountId && (accounts || []).find((a) => a.id === initialAccountId && projectOf(a))) ||
          bound.find((a) => a.connected) ||
          bound[0] ||
          (accounts || []).find((a) => a.connected) ||
          (accounts || [])[0]
        if (pick) setAccountId(pick.id)
      }, [accounts, projects, accountId, initialAccountId])

      react.useEffect(() => {
        const el = listRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [turns, busy])

      const send = async () => {
        const text = String(input || '').trim()
        if (!text || busy) return
        const history = turns.map((t) => ({ direction: t.role === 'ai' ? 'out' : 'in', text: t.text }))
        setTurns((prev) => [...prev, { role: 'buyer', text }])
        setInput('')
        setBusy(true)
        let r = null
        try {
          r = await postJson('/dsh-cs/ai-test', {
            question: text,
            platform: active ? active.platform : '',
            accountId: active ? active.id : '',
            history,
          })
        } catch (e) {
          r = { ok: false, error: String((e && e.message) || e) }
        }
        setBusy(false)
        const meta = r
          ? {
              project: r.project ? r.project.name : '',
              kbChars: r.kbChars || 0,
              ms: r.ms || 0,
              escalate: Boolean(r.escalate),
              guard: r.guard || '',
              modelReason: r.modelReason || '',
              stage: r.stage || '',
              kbError: r.kbError || '',
              accountPlatform: r.accountPlatform || '',
              realtime: r.realtime || null,
              raw: r.raw || '',
              citations: (r.citations || []).map((c) => c.path).slice(0, 3),
              model: r.model || '',
            }
          : {}
        if (r && r.ok && r.reply) {
          setTurns((prev) => [...prev, { role: 'ai', text: r.reply, meta }])
        } else {
          const why = (r && (r.guard || r.error)) || '未知'
          setTurns((prev) => [...prev, { role: 'ai', text: (r && r.escalate ? '（转人工）' : '⚠ 没生成回复：') + why, meta, error: !(r && r.escalate) }])
        }
      }

      const metaLine = (m) => {
        if (!m) return ''
        const parts = []
        if (m.project) parts.push('项目：' + m.project)
        parts.push('知识库 ' + (m.kbChars || 0) + ' 字' + (m.kbError ? '（' + m.kbError + '）' : ''))
        if (m.ms) parts.push(m.ms + 'ms')
        if (m.model) parts.push('模型：' + m.model)
        if (m.escalate) parts.push('判定转人工：' + (m.guard || m.modelReason || '模型认为需要人工'))
        if (m.citations && m.citations.length) parts.push('命中：' + m.citations.join('、'))
        if (m.realtime) {
          const rt = m.realtime
          if (rt.seats_free !== undefined && rt.seats_free !== null) parts.push('店铺：空 ' + rt.seats_free + '/' + (rt.seats_total ?? '?') + '（' + (rt.status || '') + '）')
          else if (rt.error) parts.push('店铺数据：拿不到（' + String(rt.error).slice(0, 40) + '）')
        }
        return parts.join(' · ')
      }

      return h(
        'div',
        {
          style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 },
          onClick: (e) => { if (e.target === e.currentTarget) onClose() },
        },
        h(
          'div',
          { style: { width: 620, maxWidth: '92vw', height: '70vh', minHeight: 380, background: S.bg, color: S.fg, borderRadius: 12, border: S.border, boxShadow: '0 12px 48px rgba(0,0,0,.3)', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
          // 头部
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: S.border, flex: 'none' } },
            h('span', { style: { fontSize: 14, fontWeight: 600 } }, 'AI 测试（沙箱）'),
            h('span', { style: { fontSize: 12, color: S.muted } }, '只调模型 + 知识库，不会发到抖音/闲鱼，也不进会话列表'),
            h('span', { style: { flex: 1 } }),
            h('button', { onClick: onClose, style: smallBtn }, '关闭'),
          ),
          // 测试对象：跟随你当前打开的账号（不用再选）
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: S.border, fontSize: 12, color: S.muted, flex: 'none', flexWrap: 'wrap' } },
            active
              ? h('span', null, '测试对象：', h('b', { style: { color: S.fg } }, `${platformLabel(active.platform)} · ${active.displayName || active.id}`))
              : h('span', null, '还没有接入账号：先在客服中心连扩展'),
            active
              ? projectOf(active)
                ? h('span', { style: { color: '#2ea043' } }, `项目「${projectOf(active)}」的规则 + 资料`)
                : h('span', { style: { color: '#b3261e' } }, '⚠ 该账号未分配项目：AI 没有资料，先去「资料库」绑定，否则只会转人工')
              : null,
            account ? null : h('span', { style: { color: S.muted } }, '（当前未进入账号，默认用已绑项目账号）'),
          ),
          // 对话区
          h(
            'div',
            { ref: listRef, style: { flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 } },
            turns.length === 0
              ? h(
                  'div',
                  { style: { fontSize: 12, color: S.muted, lineHeight: 1.8 } },
                  '发一条买家消息试试，例如：',
                  h('div', null, '· 特殊烫免费吗？'),
                  h('div', null, '· 你们几点关门？'),
                  h('div', null, '· 单人1小时多少钱？'),
                  h('div', null, '· 能给我留个位置吗？（应转人工）'),
                )
              : turns.map((t, i) =>
                  h(
                    'div',
                    { key: i, style: { display: 'flex', flexDirection: 'column', alignItems: t.role === 'buyer' ? 'flex-end' : 'flex-start' } },
                    h(
                      'div',
                      {
                        style: {
                          maxWidth: '85%', padding: '7px 10px', borderRadius: 10, fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6,
                          background: t.role === 'buyer' ? 'rgba(77,107,254,.12)' : t.error ? 'rgba(179,38,30,.10)' : S.hover,
                          color: t.error ? '#b3261e' : S.fg,
                        },
                      },
                      t.text,
                    ),
                    t.role === 'ai' && metaLine(t.meta)
                      ? h('div', { style: { fontSize: 11, color: S.muted, marginTop: 2 } }, metaLine(t.meta))
                      : null,
                    t.role === 'ai' && t.meta
                      ? h(
                          'details',
                          { style: { fontSize: 11, color: S.muted, marginTop: 2, maxWidth: '85%' } },
                          h('summary', { style: { cursor: 'pointer' } }, '调试信息'),
                          h(
                            'pre',
                            { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '4px 0 0', fontSize: 11, lineHeight: 1.5 } },
                            '账号平台：' + (t.meta.accountPlatform || '') +
                              '\n知识库：' + (t.meta.kbChars || 0) + ' 字' + (t.meta.kbError ? '（' + t.meta.kbError + '）' : '') +
                              '\nstage：' + (t.meta.stage || '') +
                              '\n判定原因：' + (t.meta.guard || t.meta.modelReason || '无') +
                              '\n模型：' + (t.meta.model || '') +
                              '\n店铺实时数据：' + (t.meta.realtime ? JSON.stringify(t.meta.realtime) : '（无）') +
                              '\n\n模型原始输出：\n' + (t.meta.raw || '（无）'),
                          ),
                        )
                      : null,
                  ),
                ),
            busy
              ? h('div', { style: { fontSize: 12, color: S.muted } }, 'AI 思考中…（走真实链路：规则→资料→模型→红线）')
              : null,
          ),
          // 输入区
          h(
            'div',
            { style: { display: 'flex', gap: 6, padding: '10px 14px', borderTop: S.border, flex: 'none', alignItems: 'center' } },
            h('input', {
              value: input,
              onChange: (e) => setInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') send() },
              placeholder: '输入一条买家消息，回车发送（沙箱，不会发给真实顾客）',
              style: { flex: 1, padding: '7px 10px', border: S.border, borderRadius: 8, fontSize: 13, background: S.bg, color: S.fg },
            }),
            h('button', { onClick: send, disabled: busy || !input.trim(), style: { ...smallBtn, padding: '6px 12px', fontWeight: 600, opacity: busy || !input.trim() ? 0.5 : 1 } }, busy ? '测试中…' : '发送'),
            turns.length ? h('button', { onClick: () => setTurns([]), style: smallBtn, title: '清空本次测试对话' }, '清空') : null,
          ),
        ),
      )
    }

    // 侧栏图标
    function CsGlyph(props) {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: props.size || 16, lineHeight: 1 } },
        '🎧',
      )
    }

    /**
     * 注册一个 slot 内容，等目标 slot 被它的宿主插件声明之后再注册。
     *
     * ⚠️ 必须走 `ctx.slots.inject(key, ...)`，不能直接 `ctx.slots.register(...)`：
     * `sidebar.panellist` / `main` 都是**别的插件**声明的 slot，本插件激活时它们
     * 可能还没被声明，直接 register 会抛
     * 「slot "..." is not declared (a parent entry's children table must declare it)」，
     * 该异常会让本 client entry 激活失败 —— DSH 把它当作整个 web boot 的致命错误，
     * 表现就是「应用无法启动或已意外停止」。inject 会在声明提交后回调，顺序无关。
     *
     * 再套一层 try/catch：第三方插件注册失败只应让自己这个面板消失，绝不能拖垮
     * 整个应用的启动。
     */
    function registerWhenDeclared(ctx, slotKey, makeRegistration, label) {
      return ctx.effect(
        () =>
          ctx.slots.inject(slotKey, () => {
            try {
              return makeRegistration()
            } catch (error) {
              console.error('[dsh-cs] 注册 slot "' + slotKey + '" 失败（本面板不可用，但不影响应用启动）: ' + error)
              return () => {}
            }
          }),
        label,
      )
    }

    // ── 资料库（独立面板，与「客服中心」平级）────────────────────────────────

    const LIB_PANEL_ID = 'cs-library'
    const LIB_PANEL_LABEL = '资料库'

    /**
     * 资料库面板：项目（资料库 + 账号绑定）管理。
     * 独立注册到 sidebar.panellist / main，不再塞进客服中心内部。
     */
    function LibraryPanel() {
      const [projects, setProjects] = react.useState([])
      const [projectId, setProjectId] = react.useState('')
      const [tree, setTree] = react.useState([])
      const [file, setFile] = react.useState(null)
      const [draft, setDraft] = react.useState('')
      const [preview, setPreview] = react.useState(null)
      const [query, setQuery] = react.useState('')
      const [accounts, setAccounts] = react.useState([])
      const [notice, setNotice] = react.useState('')
      const [loading, setLoading] = react.useState(false)
      /** 当前所在目录（点文件夹「进去」后，新建文档/文件夹默认落在这里） */
      const [currentDir, setCurrentDir] = react.useState('')
      /** 面板内弹窗（Electron 不支持 window.prompt，全部改用自绘弹窗） */
      const [dialog, setDialog] = react.useState(null)

      const flash = (msg) => {
        setNotice(msg)
        setTimeout(() => setNotice(''), 8000)
      }

      const loadProjects = react.useCallback(async () => {
        const data = await api('/dsh-cs/library/projects')
        if (data && data.ok && Array.isArray(data.projects)) {
          setProjects(data.projects)
          setProjectId((prev) => (prev && data.projects.some((p) => p.id === prev) ? prev : (data.projects[0] ? data.projects[0].id : '')))
        }
      }, [])

      const loadAccounts = react.useCallback(async () => {
        const data = await api('/dsh-cs/state')
        if (data && data.ok) setAccounts(data.accounts || [])
      }, [])

      const loadTree = react.useCallback(async (pid) => {
        if (!pid) { setTree([]); return }
        const data = await api('/dsh-cs/library/tree?project=' + encodeURIComponent(pid))
        if (data && data.ok) setTree(data.tree || [])
      }, [])

      react.useEffect(() => { loadProjects(); loadAccounts() }, [loadProjects, loadAccounts])
      react.useEffect(() => { loadTree(projectId) }, [projectId, loadTree])
      // 账号在线状态变化时刷新（绑定列表要显示在线/离线）
      react.useEffect(() => {
        const t = setInterval(loadAccounts, 5000)
        return () => clearInterval(t)
      }, [loadAccounts])

      const project = projects.find((p) => p.id === projectId) || null

      // ── 自绘弹窗（Electron/沙箱里 window.prompt 不可用，所有按钮必须走这里） ──
      const askText = (opts) => setDialog({ kind: 'text', value: '', submitLabel: '确定', ...opts })
      const askPick = (opts) =>
        setDialog({ kind: 'pick', picked: (opts.options && opts.options[0] && opts.options[0].value) || '', submitLabel: '确定', ...opts })
      const askConfirm = (opts) => setDialog({ kind: 'confirm', submitLabel: '确认', danger: true, ...opts })

      const submitDialog = async () => {
        const d = dialog
        if (!d || d.busy) return
        setDialog({ ...d, busy: true })
        try {
          const value = d.kind === 'pick' ? d.picked : d.kind === 'confirm' ? true : d.value
          await d.onSubmit(value)
          setDialog(null)
        } catch (error) {
          flash(String((error && error.message) || error))
          setDialog({ ...d, busy: false })
        }
      }

      const updateProject = async (patch) => {
        if (!projectId) return
        const r = await postJson('/dsh-cs/library/project', { action: 'update', project: projectId, ...patch })
        if (!r || !r.ok) throw new Error('更新失败：' + ((r && r.error) || '未知'))
        await loadProjects()
      }

      const createProject = () =>
        askText({
          title: '新建项目',
          hint: '项目名（如：示例店铺 / 高报 / 其他项目）',
          placeholder: '示例店铺',
          onSubmit: async (raw) => {
            const name = String(raw || '').trim()
            if (!name) throw new Error('项目名不能为空')
            const r = await postJson('/dsh-cs/library/project', { action: 'create', name })
            if (!r || !r.ok) throw new Error('建项目失败：' + ((r && r.error) || '未知'))
            await loadProjects()
            setProjectId(r.project.id)
            flash('已创建项目：' + r.project.name)
          },
        })

      const renameProject = () => {
        if (!project) return
        askText({
          title: '项目改名',
          value: project.name,
          onSubmit: async (raw) => {
            const name = String(raw || '').trim()
            if (!name) throw new Error('名称不能为空')
            if (name === project.name) return
            await updateProject({ name })
            flash('已改名：' + name)
          },
        })
      }

      const deleteProject = () => {
        if (!project) return
        askConfirm({
          title: `删除项目「${project.name}」？`,
          hint: '文档会移入 library/.trash（可人工恢复）；账号绑定会解除。',
          onSubmit: async () => {
            const r = await postJson('/dsh-cs/library/project', { action: 'delete', project: projectId })
            if (!r || !r.ok) throw new Error('删除失败：' + ((r && r.error) || '未知'))
            setFile(null); setDraft(''); setPreview(null)
            await loadProjects()
            flash('已删除项目（文件在回收站）')
          },
        })
      }

      const bindAccount = () => {
        if (!projectId) return
        if (!accounts.length) { flash('还没有已接入账号（先在「客服中心」里把扩展连上）'); return }
        askPick({
          title: '绑定账号到项目',
          hint: '一个账号只能属于一个项目；改绑会自动从旧项目移除。',
          options: accounts.map((a) => ({
            value: a.id,
            label: `${platformLabel(a.platform)} · ${a.displayName || a.id}${a.connected ? '（在线）' : '（离线）'}`,
          })),
          picked: (accounts[0] && accounts[0].id) || '',
          onSubmit: async (value) => {
            const acc = accounts.find((x) => x.id === value)
            if (!acc) throw new Error('请选择一个账号')
            const r = await postJson('/dsh-cs/library/bind', { project: projectId, platform: acc.platform, accountId: acc.id, label: acc.displayName || acc.id })
            if (!r || !r.ok) throw new Error('绑定失败：' + ((r && r.error) || '未知'))
            await loadProjects()
            flash('已绑定：' + (acc.displayName || acc.id))
          },
        })
      }

      const unbindAccount = async (a) => {
        const r = await postJson('/dsh-cs/library/bind', { project: projectId, unbind: true, platform: a.platform, accountId: a.accountId })
        if (!r || !r.ok) { flash('解绑失败：' + ((r && r.error) || '未知')); return }
        await loadProjects()
      }

      const openFile = async (path) => {
        setLoading(true)
        const r = await api('/dsh-cs/library/file-get?project=' + encodeURIComponent(projectId) + '&path=' + encodeURIComponent(path))
        setLoading(false)
        if (!r || !r.ok) { flash('打开失败：' + ((r && r.error) || '未知')); return }
        const doc = r.doc || {}
        setFile({ path, kind: doc.kind })
        setDraft(doc.text || '')
        setPreview(null)
      }

      const saveFile = async () => {
        if (!projectId || !file) return
        const r = await postJson('/dsh-cs/library/file', { project: projectId, action: 'write', path: file.path, content: draft })
        if (!r || !r.ok) { flash('保存失败：' + ((r && r.error) || '未知')); return }
        await loadTree(projectId)
        flash('已保存：' + file.path)
      }

      const newDoc = () => {
        if (!projectId) return
        const base = currentDir
        askText({
          title: '新建文档' + (base ? `（在 ${base}/ 下）` : ''),
          hint: '可带文件夹，例如：话术/接待.md' + (base ? '；会自动落在当前目录里' : ''),
          placeholder: '店规速查.md',
          onSubmit: async (raw) => {
            const rel = String(raw || '').trim()
            if (!rel) throw new Error('路径不能为空')
            const path = base ? `${base}/${rel}` : rel
            const title = path.split('/').pop().replace(/\.md$/, '')
            const r = await postJson('/dsh-cs/library/file', { project: projectId, action: 'write', path, content: `# ${title}\n\n` })
            if (!r || !r.ok) throw new Error('新建失败：' + ((r && r.error) || '未知'))
            await loadTree(projectId)
            await openFile(path)
          },
        })
      }

      const newDir = () => {
        if (!projectId) return
        const base = currentDir
        askText({
          title: '新建文件夹' + (base ? `（在 ${base}/ 下）` : ''),
          hint: '可多级，例如：产品/示例店铺' + (base ? '；会自动落在当前目录里' : ''),
          placeholder: '话术',
          onSubmit: async (raw) => {
            const rel = String(raw || '').trim()
            if (!rel) throw new Error('名称不能为空')
            const path = base ? `${base}/${rel}` : rel
            const r = await postJson('/dsh-cs/library/file', { project: projectId, action: 'mkdir', path })
            if (!r || !r.ok) throw new Error('新建文件夹失败：' + ((r && r.error) || '未知'))
            await loadTree(projectId)
            setCurrentDir(path)
            flash('已创建文件夹：' + path)
          },
        })
      }

      const removeEntry = (path, isDir) => {
        if (!projectId) return
        askConfirm({
          title: `删除 ${path}？`,
          hint: isDir ? '目录会递归删除（不可撤销，注意备份）' : '删除后不可恢复',
          onSubmit: async () => {
            const r = await postJson('/dsh-cs/library/file', { project: projectId, action: 'delete', path, recursive: isDir })
            if (!r || !r.ok) throw new Error('删除失败：' + ((r && r.error) || '未知'))
            if (file && file.path === path) { setFile(null); setDraft('') }
            await loadTree(projectId)
          },
        })
      }

      const renameEntry = (path) => {
        if (!projectId) return
        askText({
          title: '重命名 / 移动',
          hint: '输入新路径（可移到子目录），例如：话术/接待.md',
          value: path,
          onSubmit: async (raw) => {
            const to = String(raw || '').trim()
            if (!to || to === path) return
            const r = await postJson('/dsh-cs/library/file', { project: projectId, action: 'move', from: path, to })
            if (!r || !r.ok) throw new Error('重命名失败：' + ((r && r.error) || '未知'))
            if (file && file.path === path) setFile({ ...file, path: to })
            await loadTree(projectId)
          },
        })
      }

      const togglePinned = async (path) => {
        if (!project) return
        const cur = project.pinned || []
        await updateProject({ pinned: cur.includes(path) ? cur.filter((x) => x !== path) : [...cur, path] })
      }

      const previewContext = async () => {
        if (!projectId) return
        const r = await postJson('/dsh-cs/library/context-preview', { project: projectId, text: query || '' })
        setPreview(r && r.ok ? r.ctx : { error: (r && r.error) || '预览失败' })
      }

      const reindex = async () => {
        if (!projectId) return
        const r = await postJson('/dsh-cs/library/reindex', { project: projectId })
        if (!r || !r.ok) { flash('重建索引失败：' + ((r && r.error) || '未知')); return }
        flash(`索引已重建：${r.chunks} 段`)
      }

      /** 打开/生成项目的规则文件 AGENTS.md（AI 每次回复都会先读到它） */
      const openRules = async () => {
        if (!projectId) return
        const name = (project && project.name) || '项目'
        const today = new Date().toISOString().slice(0, 10)
        const r = await api('/dsh-cs/library/file-get?project=' + encodeURIComponent(projectId) + '&path=AGENTS.md')
        if (!r || !r.ok) {
          const content = [
            `# AGENTS.md — ${name}客服规则`,
            '',
            `版本：v0.1 ｜ 更新：${today}`,
            '',
            '## 1. 身份与语气',
            `- 你是「${name}」的客服，语气亲切、简短、口语，一次回复不超过 3 行。`,
            '- 只依据登记过的资料回答；拿不准就转人工，绝不编造价格/时间/活动。',
            '',
            '## 2. 范围边界',
            '### 可以回答',
            '- （列出这个项目可以回答的主题）',
            '### 必须转人工',
            '- 退款/赔付/免单/优惠、具体金额、投诉/差评/情绪激动、发票、查不到的问题、连续追问两次',
            '',
            '## 3. 数据源登记',
            '| 资料 | 类型 | 优先级 | 场景 |',
            '|---|---|---|---|',
            '| 店规速查.md | 规则 | 必读 | 所有规则问题 |',
            '',
            '## 4. 工具与 MCP 调用策略',
            '| 场景 | 动作 | 需要人工确认 | 失败兜底 |',
            '|---|---|---|---|',
            '| 退款 / 改价 / 关单 / 发品 | **禁止 AI 执行** | 必须人工 | 转人工 |',
            '',
            '## 5. 输出规范',
            '- 不承诺店铺/留位/等待时间；不报赔付金额。',
            '',
            '## 6. 变更记录',
            '| 版本 | 日期 | 改了什么 | 为什么 |',
            '|---|---|---|---|',
            `| v0.1 | ${today} | 初版 | 上线 |`,
            '',
            '## 7. 自测问句',
            '| 问句 | 期望 |',
            '|---|---|',
            '| （补充） | （补充） |',
            '',
          ].join('\n')
          const w = await postJson('/dsh-cs/library/file', { project: projectId, action: 'write', path: 'AGENTS.md', content })
          if (!w || !w.ok) { flash('创建规则失败：' + ((w && w.error) || '未知')); return }
          await loadTree(projectId)
        }
        await openFile('AGENTS.md')
      }

      // 目录导航：点文件夹=进入（只显示该目录下的内容），不再整树展开
      const findNode = (nodes, path) => {
        if (!path) return { type: 'dir', path: '', children: nodes || [] }
        let list = nodes || []
        let found = null
        for (const seg of String(path).split('/').filter(Boolean)) {
          found = (list || []).find((n) => n.type === 'dir' && n.name === seg) || null
          if (!found) return null
          list = found.children || []
        }
        return found
      }
      const dirNode = findNode(tree, currentDir)
      const entries = (dirNode && dirNode.children) || []
      const bound = (project && project.accounts) || []
      const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
      const crumbSegs = String(currentDir || '').split('/').filter(Boolean)

      // 当前目录被删/改名后自动退回根目录
      react.useEffect(() => {
        if (currentDir && !findNode(tree, currentDir)) setCurrentDir('')
      }, [tree, currentDir])

      // 自绘弹窗（输入 / 选择账号 / 确认删除）
      const dialogBox = dialog
        ? h(
            'div',
            {
              style: {
                position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                background: 'rgba(0,0,0,.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
              },
              onClick: (e) => { if (e.target === e.currentTarget) setDialog(null) },
            },
            h(
              'div',
              {
                style: {
                  width: 380, maxWidth: '90vw', background: S.bg, color: S.fg, borderRadius: 10, padding: 14,
                  boxShadow: '0 10px 40px rgba(0,0,0,.25)', border: S.border,
                },
              },
              h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, dialog.title),
              dialog.hint ? h('div', { style: { fontSize: 12, color: S.muted, marginBottom: 8, lineHeight: 1.6 } }, dialog.hint) : null,
              dialog.kind === 'pick'
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' } },
                    (dialog.options || []).map((o) =>
                      h(
                        'button',
                        {
                          key: o.value,
                          onClick: () => setDialog({ ...dialog, picked: o.value }),
                          style: {
                            textAlign: 'left', padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
                            border: dialog.picked === o.value ? '1px solid ' + S.accent : S.border,
                            background: dialog.picked === o.value ? 'rgba(77,107,254,.08)' : 'transparent',
                            color: S.fg,
                          },
                        },
                        o.label,
                      ),
                    ),
                  )
                : dialog.kind === 'text'
                  ? h('input', {
                      autoFocus: true,
                      value: dialog.value || '',
                      placeholder: dialog.placeholder || '',
                      onChange: (e) => setDialog({ ...dialog, value: e.target.value }),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter') submitDialog()
                        if (e.key === 'Escape') setDialog(null)
                      },
                      style: { width: '100%', padding: '6px 8px', border: S.border, borderRadius: 6, fontSize: 13, background: S.bg, color: S.fg, boxSizing: 'border-box' },
                    })
                  : null,
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 } },
                h('button', { onClick: () => setDialog(null), style: smallBtn }, '取消'),
                h(
                  'button',
                  {
                    onClick: submitDialog,
                    disabled: dialog.busy,
                    style: {
                      ...smallBtn, padding: '4px 12px', fontWeight: 600, color: '#fff', border: 'none',
                      background: dialog.danger ? '#b3261e' : S.accent, cursor: dialog.busy ? 'default' : 'pointer',
                    },
                  },
                  dialog.busy ? '处理中…' : (dialog.submitLabel || '确定'),
                ),
              ),
            ),
          )
        : null

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', background: S.bg, color: S.fg } },
        // 顶栏
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: S.border, flex: 'none' } },
          h('span', { style: { fontSize: 14, fontWeight: 600 } }, LIB_PANEL_LABEL + (project ? ` · ${project.name}` : '')),
          h('span', { style: { fontSize: 12, color: S.muted } }, '项目 = 文档库 + 账号绑定；AI 只读当前账号所属项目'),
          h('span', { style: { flex: 1 } }),
          h('button', { onClick: () => { loadProjects(); loadTree(projectId); loadAccounts() }, style: smallBtn }, '↻ 刷新'),
        ),
        notice
          ? h('div', { style: { padding: '6px 14px', fontSize: 12, color: '#b3261e', background: 'rgba(179,38,30,.06)', flex: 'none' } }, notice)
          : null,
        dialogBox,
        h(
          'div',
          { style: { display: 'flex', flex: 1, minHeight: 0 } },
          // 左：项目
          h(
            'div',
            { style: { width: 210, borderRight: S.border, display: 'flex', flexDirection: 'column', flex: 'none' } },
            h(
              'div',
              { style: { padding: '8px 10px', borderBottom: S.border, display: 'flex', gap: 6, alignItems: 'center' } },
              h('span', { style: { fontSize: 12, fontWeight: 600, flex: 1 } }, '项目'),
              h('button', { onClick: createProject, style: smallBtn }, '+ 新建'),
            ),
            h(
              'div',
              { style: { overflowY: 'auto', flex: 1 } },
              projects.length === 0
                ? h('div', { style: { padding: 12, fontSize: 12, color: S.muted, lineHeight: 1.8 } }, '还没有项目。点「+ 新建」创建「示例店铺」「高报」等项目，再把对应闲鱼号/抖音号绑进去。')
                : projects.map((p) =>
                    h(
                      'button',
                      {
                        key: p.id,
                        onClick: () => { setProjectId(p.id); setFile(null); setDraft(''); setPreview(null); setCurrentDir('') },
                        style: {
                          display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                          borderBottom: '1px solid rgba(0,0,0,.05)', cursor: 'pointer', color: S.fg,
                          background: p.id === projectId ? S.hover : 'transparent',
                        },
                      },
                      h('div', { style: { fontSize: 13, fontWeight: 600 } }, p.name),
                      h('div', { style: { fontSize: 11, color: S.muted } }, `${(p.accounts || []).length} 账号 · ${(p.pinned || []).length} 必读`),
                    ),
                  ),
            ),
          ),
          // 右：详情
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
            h(
              'div',
              { style: { padding: '8px 12px', borderBottom: S.border, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 13, fontWeight: 600 } }, project ? project.name : '选择或新建一个项目'),
              h('button', { onClick: renameProject, style: smallBtn, disabled: !project }, '改名'),
              h('button', { onClick: deleteProject, style: smallBtn, disabled: !project }, '删除项目'),
              h('button', { onClick: bindAccount, style: smallBtn, disabled: !project }, '绑定账号'),
              h('button', { onClick: newDoc, style: smallBtn, disabled: !project }, '+ 文档'),
              h('button', { onClick: newDir, style: smallBtn, disabled: !project }, '+ 文件夹'),
              h('button', { onClick: saveFile, style: smallBtn, disabled: !file }, '保存'),
              h('button', { onClick: openRules, style: smallBtn, disabled: !project, title: '编辑项目规则 AGENTS.md（AI 每次回复都会先读）' }, '规则'),
              h('button', { onClick: reindex, style: smallBtn, disabled: !project, title: '文档改动后立即重建检索索引' }, '重建索引'),
            ),
            h(
              'div',
              { style: { padding: '6px 12px', borderBottom: S.border, fontSize: 12, color: S.muted, display: 'flex', gap: 8, flexWrap: 'wrap' } },
              bound.length
                ? bound.map((b) =>
                    h(
                      'span',
                      { key: b.platform + ':' + b.accountId, style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 10, background: S.hover } },
                      `${platformLabel(b.platform)} · ${b.label || b.accountId}`,
                      h('button', { onClick: () => unbindAccount(b), style: { ...smallBtn, padding: '0 4px' }, title: '解绑' }, '×'),
                    ),
                  )
                : [h('span', { key: 'none' }, '未绑定账号：绑定后该账号的 AI 才会用这个项目的资料')],
            ),
            h(
              'div',
              { style: { display: 'flex', flex: 1, minHeight: 0 } },
              // 文件列表（只显示当前目录；点文件夹进入，点文件编辑）
              h(
                'div',
                { style: { width: 260, borderRight: S.border, overflowY: 'auto', flex: 'none' } },
                // 面包屑：根目录 › 子目录 …
                h(
                  'div',
                  {
                    style: {
                      display: 'flex', alignItems: 'center', gap: 2, padding: '4px 6px', borderBottom: S.border,
                      fontSize: 11, color: S.muted, position: 'sticky', top: 0, background: S.bg, zIndex: 1, flexWrap: 'wrap',
                    },
                  },
                  h('button', { onClick: () => setCurrentDir(''), style: { ...smallBtn, padding: '0 4px' }, title: '回到根目录' }, '根目录'),
                  crumbSegs.map((seg, i) => [
                    h('span', { key: 'sep' + i, style: { color: '#bbb' } }, '›'),
                    h(
                      'button',
                      {
                        key: 'seg' + i,
                        onClick: () => setCurrentDir(crumbSegs.slice(0, i + 1).join('/')),
                        style: { ...smallBtn, padding: '0 4px', fontWeight: i === crumbSegs.length - 1 ? 600 : 400 },
                        title: '回到这一层',
                      },
                      seg,
                    ),
                  ]),
                ),
                currentDir
                  ? h(
                      'div',
                      { style: { padding: '3px 6px', borderBottom: S.border } },
                      h('button', { onClick: () => setCurrentDir(parentOf(currentDir)), style: { ...smallBtn, padding: '0 4px' } }, '↑ 上一级'),
                    )
                  : null,
                entries.length === 0
                  ? h(
                      'div',
                      { style: { padding: 12, fontSize: 12, color: S.muted } },
                      currentDir ? '这个文件夹是空的：点「+ 文档」会建在当前目录' : '还没有文档，点「+ 文档」新建（支持 Markdown）',
                    )
                  : entries.map((n) =>
                      h(
                        'div',
                        { key: n.path, style: { display: 'flex', alignItems: 'center', gap: 3, padding: '3px 6px', fontSize: 12 } },
                        h(
                          'button',
                          {
                            onClick: () => { if (n.type === 'file') openFile(n.path); else setCurrentDir(n.path) },
                            title: n.type === 'dir' ? '点击进入文件夹' : '点击打开编辑',
                            style: {
                              flex: 1, textAlign: 'left', border: 'none', background: 'transparent', color: S.fg, padding: 0,
                              cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            },
                          },
                          (n.type === 'dir' ? '📁 ' : '📄 ') + n.name,
                          n.type === 'dir' ? h('span', { style: { color: S.muted, fontSize: 11 } }, `（${(n.children || []).length} 项）`) : null,
                        ),
                        n.type === 'file'
                          ? h('button', { onClick: () => togglePinned(n.path), title: '设为/取消 AI 必读', style: { ...smallBtn, padding: '0 4px' } }, (project && (project.pinned || []).includes(n.path)) ? '★' : '☆')
                          : null,
                        h('button', { onClick: () => renameEntry(n.path), title: '重命名/移动', style: { ...smallBtn, padding: '0 4px' } }, '✎'),
                        h('button', { onClick: () => removeEntry(n.path, n.type === 'dir'), title: '删除', style: { ...smallBtn, padding: '0 4px' } }, '×'),
                      ),
                    ),
              ),
              // 编辑器
              h(
                'div',
                { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
                file
                  ? h(
                      'div',
                      { style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } },
                      h('div', { style: { padding: '4px 10px', fontSize: 12, color: S.muted } }, file.path + (loading ? '（加载中…）' : '')),
                      h('textarea', {
                        value: draft,
                        onChange: (e) => setDraft(e.target.value),
                        style: { flex: 1, minHeight: 120, resize: 'none', border: 'none', outline: 'none', padding: 10, fontFamily: 'ui-monospace, monospace', fontSize: 12, background: S.bg, color: S.fg },
                      }),
                    )
                  : h('div', { style: { padding: 16, fontSize: 12, color: S.muted } }, '点左侧文档开始编辑（Markdown）；AI 只读「必读 ★ + 检索命中」的内容'),
                preview
                  ? h(
                      'div',
                      { style: { borderTop: S.border, maxHeight: 200, overflowY: 'auto', padding: '6px 10px', fontSize: 11, whiteSpace: 'pre-wrap', color: S.muted } },
                      preview.error
                        ? `⚠ ${preview.error}`
                        : `预览：${preview.chars} 字 · 来源 ${(preview.citations || []).map((c) => c.path).join('、') || '无'}\n${String(preview.kb || '').slice(0, 1500)}`,
                    )
                  : null,
              ),
            ),
            // 模拟问句 → 预览
            h(
              'div',
              { style: { display: 'flex', gap: 6, padding: '6px 12px', borderTop: S.border, alignItems: 'center' } },
              h('span', { style: { fontSize: 12, color: S.muted } }, '模拟买家一句话 →'),
              h('input', {
                value: query,
                onChange: (e) => setQuery(e.target.value),
                placeholder: '如：包邮吗？什么时候发货？',
                style: { flex: 1, padding: '4px 8px', border: S.border, borderRadius: 6, fontSize: 12, background: S.bg, color: S.fg },
              }),
              h('button', { onClick: previewContext, style: smallBtn, disabled: !project }, '看 AI 会读到什么'),
            ),
          ),
        ),
      )
    }

    function LibGlyph() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, lineHeight: 1 } },
        '📚',
      )
    }

    /**
     * client 半激活入口。
     *
     * ⚠️ 整体兜一层 try/catch：client entry 激活失败会被 DSH 当作整个 web boot 的
     * 致命错误（弹「应用无法启动」），第三方插件不该有这个权力。任何意外只记录日志
     * —— 代价是客服面板不出现，应用照常启动。
     */
    function apply(ctx) {
      try {
        // ① 侧栏全局面板图标（由 ui-sidebar 声明 sidebar.panellist）
        registerWhenDeclared(
          ctx,
          'sidebar.panellist',
          () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: PANEL_LABEL }, CsGlyph),
          'dsh-cs: panel glyph',
        )
        // ② 中央面板主体（keyed slot，key = 面板 id，由 shell 声明 main）
        registerWhenDeclared(
          ctx,
          'main',
          () => ctx.slots.register({ name: 'main', key: PANEL_ID }, CsPanel),
          'dsh-cs: panel body',
        )
        // ③ 资料库：与客服中心**平级**的第二个侧栏面板（方便手动维护资料）
        registerWhenDeclared(
          ctx,
          'sidebar.panellist',
          () => ctx.slots.register({ name: 'sidebar.panellist', id: LIB_PANEL_ID, order: 31, label: LIB_PANEL_LABEL }, LibGlyph),
          'dsh-cs: library glyph',
        )
        registerWhenDeclared(
          ctx,
          'main',
          () => ctx.slots.register({ name: 'main', key: LIB_PANEL_ID }, LibraryPanel),
          'dsh-cs: library body',
        )
      } catch (error) {
        console.error(
          '[dsh-cs] client 半激活失败（客服面板不可用，但不影响应用启动）: ' +
            (error && error.stack ? error.stack : error),
        )
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
