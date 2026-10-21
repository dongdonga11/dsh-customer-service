/**
 * 通用工具注册（kernel，平台无关）。
 *
 * 把各平台适配器暴露的工具定义注册进 DSH `ctx.tools`：
 *   - 平台负责「有哪些工具、参数、执行逻辑」（adapter.tools() 或外部 builder）
 *   - 内核负责注册生命周期（disposer 随插件/effect 释放）
 *
 * 工具定义契约（DSH）：{ name, description, parameters, output:{schema, render}, execute(args, exec) }
 */
export function registerToolDefs(ctx, defs, log = null) {
  const disposers = []
  if (!ctx || typeof ctx.tools?.register !== 'function') {
    log?.warn?.('tools 服务不可用：工具未注册（其余功能照常）')
    return () => {}
  }
  for (const def of Array.isArray(defs) ? defs : []) {
    if (!def || !def.name) continue
    try {
      disposers.push(ctx.tools.register(def))
    } catch (error) {
      log?.warn?.(`工具注册失败 ${def.name}: ${(error && error.message) || error}`)
    }
  }
  return () => {
    for (const d of disposers.reverse()) {
      try { d() } catch { /* ignore */ }
    }
  }
}

/** 统一错误结果（工具返回值必须是 lossless JSON 可序列化的东西；这里统一成字符串） */
export function toolError(message, extra = {}) {
  return JSON.stringify({ success: false, error: String(message || '未知错误'), ...extra }, null, 2)
}

/** 统一成功结果 */
export function toolOk(payload = {}) {
  return JSON.stringify({ success: true, ...payload }, null, 2)
}

export default { registerToolDefs, toolError, toolOk }
