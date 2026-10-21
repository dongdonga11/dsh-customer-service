/**
 * 闲鱼自动交付（M4a 触发侧）。
 *
 * 语义（对齐 Hermes adapter.py:262-290 `_try_auto_deliver`）：
 *   - 只处理 `delivery_trigger`（买家已付款/待发货）事件；
 *   - 产品库该商品开了 auto_deliver 且有交付内容 → **立即**精确发给买家（不等 AI）；
 *   - 发成功记出站消息 + 把该消息标成 aiHandled（避免 AI 再发一遍）；
 *   - 任何失败只记日志，绝不阻塞主链路（事件钩子本身也是旁路）。
 *
 * 模块保持纯函数式依赖注入，便于离线测试。
 */

const PLATFORM = 'xianyu'

/**
 * @param {object} deps
 * @param {object} deps.adapter      闲鱼适配器（需要 send）
 * @param {object} deps.store        kernel Store
 * @param {object} deps.productStore 产品库（需要 getAutoDelivery）
 * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}} [deps.log]
 * @param {Function} [deps.notify]   可选：事件通知回调 (event, payload) => void
 * @returns {(ev:object) => Promise<void>}
 */
export function createAutoDeliver({ adapter, store, productStore, log = null, notify = null }) {
  const lg = log || { info() {}, warn() {}, error() {}, debug() {} }
  return async function onXianyuEvent(ev) {
    try {
      if (!ev || ev.platform !== PLATFORM) return
      if ((ev.xianyuKind || '') !== 'delivery_trigger') return
      if (!ev.accountId || !ev.conversationId) return
      if (!productStore || typeof productStore.getAutoDelivery !== 'function') return
      const accountId = String(ev.accountId)
      const chatId = String(ev.conversationId)
      const buyerId = String(ev.buyerUid || '')
      const itemId = String(ev.itemId || '')
      if (!itemId) return

      const auto = await productStore.getAutoDelivery(accountId, itemId)
      if (!auto || auto.enabled !== true || !String(auto.content || '').trim()) return

      const thread = { platform: PLATFORM, accountId, conversationId: chatId, buyerUid: buyerId, buyerName: ev.buyerName || '' }
      const res = await adapter.send(thread, auto.content, {})
      if (!res || res.ok !== true) {
        lg.warn(`自动交付发送失败（item=${itemId} chat=${chatId}）: ${(res && res.error) || '未知'}`)
        return
      }
      const serverId = res.server_message_id || res.serverMessageId || ''
      try {
        store.recordOutbound(accountId, chatId, auto.content, serverId, 'ai', PLATFORM)
      } catch { /* ignore */ }
      // 防 AI 重复发：把触发这条付款消息标记为已处理
      try {
        if (ev.serverMessageId) {
          const tid = store.threadId(accountId, chatId, PLATFORM)
          store.noteAiHandled?.(tid, String(ev.serverMessageId))
        }
      } catch { /* ignore */ }
      lg.info(`已自动交付（item=${itemId} chat=${chatId}）`)
      if (typeof notify === 'function') {
        try { notify('delivery_sent', { accountId, chatId, buyerId, itemId }) } catch { /* ignore */ }
      }
    } catch (error) {
      lg.warn(`自动交付异常（不影响主链路）: ${(error && error.message) || error}`)
    }
  }
}

export default createAutoDeliver
