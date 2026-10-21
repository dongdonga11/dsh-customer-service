/**
 * 事件通知（kernel，平台无关）。
 *
 * DSH 没有 Hermes gateway 的多平台消息通道，所以这里给一个**最小、可配置**的出口：
 *   - 默认关闭；配置 `notify.webhookUrl` 后，把事件以 JSON POST 出去（企业微信/飞书/钉钉机器人、
 *     自建 webhook 都能接；不做平台 SDK、不存储凭证）；
 *   - 事件：order（出单）/ urge（买家催）/ rate（待评价）/ risk（风控）/ delivery_sent（自动交付成功）；
 *   - 同事件 + 同账号 + 同买家在 throttleSeconds 内只发一次（防刷屏）；
 *   - 旁路能力：任何失败只记日志，绝不影响主流程。
 */

export const DEFAULT_NOTIFY = {
  enabled: false,
  webhookUrl: '',
  events: ['order', 'urge', 'rate', 'risk'],
  throttleSeconds: 60,
  timeoutMs: 5000,
}

const URGE_KEYWORDS = ['在吗', '催', '发货', '什么时候', '尽快', '急', '还没', '快点', '好了吗']

export function isUrgeMessage(text) {
  const s = String(text || '')
  if (!s) return false
  return URGE_KEYWORDS.some((k) => s.includes(k))
}

/**
 * @param {object} opts
 * @param {object} [opts.config]    { enabled, webhookUrl, events, throttleSeconds, timeoutMs }
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试用）
 * @param {object} [opts.log]
 */
export function createNotifier({ config = {}, fetchImpl = null, log = null } = {}) {
  const cfg = { ...DEFAULT_NOTIFY, ...(config || {}) }
  const lg = log || { info() {}, warn() {}, error() {}, debug() {} }
  const lastSent = new Map() // key -> ts
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  const throttleMs = Math.max(0, Number(cfg.throttleSeconds) || 0) * 1000

  function isEnabled() {
    return cfg.enabled === true && Boolean(String(cfg.webhookUrl || '').trim()) && Boolean(doFetch)
  }

  /**
   * @param {string} event
   * @param {object} payload  { accountId, buyerId, ... }
   * @returns {Promise<{ok:boolean, skipped?:string, error?:string}>}
   */
  async function notify(event, payload = {}) {
    try {
      if (!isEnabled()) return { ok: false, skipped: 'disabled' }
      const name = String(event || '')
      if (Array.isArray(cfg.events) && cfg.events.length && !cfg.events.includes(name)) return { ok: false, skipped: 'event-filtered' }
      const key = `${name}|${payload.accountId || ''}|${payload.buyerId || payload.chatId || ''}`
      const now = Date.now()
      if (throttleMs > 0) {
        const prev = lastSent.get(key) || 0
        if (now - prev < throttleMs) return { ok: false, skipped: 'throttled' }
      }
      lastSent.set(key, now)
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || 5000) : null
      try {
        const res = await doFetch(String(cfg.webhookUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ event: name, at: new Date(now).toISOString(), ...payload }),
          signal: controller ? controller.signal : undefined,
        })
        const ok = Boolean(res && res.ok)
        if (!ok) lg.warn(`通知失败（${name}）: HTTP ${res && res.status}`)
        return { ok, status: res && res.status }
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch (error) {
      lg.warn(`通知异常（${event}）: ${(error && error.message) || error}`)
      return { ok: false, error: String((error && error.message) || error) }
    }
  }

  return {
    notify,
    isEnabled,
    isUrgeMessage,
    get config() { return { ...cfg, webhookUrl: cfg.webhookUrl ? '***' : '' } },
    /** 清空节流表（测试/诊断用） */
    resetThrottle() { lastSent.clear() },
  }
}

export default createNotifier
