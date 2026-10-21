/**
 * DSH 客服 —— 来客工作台请求记录器（MAIN world，document_start）
 * ============================================================================
 *
 * 为什么需要它（而不是让内容脚本自己去猜接口）：
 *
 *   来客工作台自己就会调这些接口：
 *     GET  /chat/api/backstage/conversation/get_current_conversation_list   会话列表
 *     POST /napi/v1/web/cs/conversation/getConversationTag                  （请求体带全部会话 id）
 *     GET  /chat/api/backstage/conversation/get_history_msg                历史消息
 *     POST /napi/v1/web/cs/conversation/batchGetUserInfoForMerchant        买家昵称头像
 *
 *   与其去猜它们的**返回结构**，不如直接把页面自己的**请求体 + 响应**录下来：
 *   - getConversationTag 的请求体里有全部会话 id + talk_id → 白送一份会话列表
 *   - 响应结构直接从真实数据里学，不用试错
 *
 * ⚠️ 踩过的坑（务必保留这条护栏）：
 *   最早版本把记录逻辑挂在 **应用自己调用 `xhr.addEventListener('loadend')`** 上。
 *   但 axios 用的是 `onreadystatechange` / `onload` —— 于是 **XHR 路径一条都没录到**，
 *   表现为「所有会话的 talk_id 都是空」「页面切会话也看不到 get_history_msg」，
 *   进而让上层误判成「会话打不开」。
 *   现在改成：**在 `send()` 里用原生 addEventListener 自己挂监听**（不依赖应用行为），
 *   并且 loadend + readystatechange 双保险 + 去重标记。
 *
 * 只读：只记录，不改请求/响应，不新建连接。录到的内容通过 window.postMessage
 * 交给内容脚本（隔离世界拿不到主世界的对象，只能走 postMessage）。
 */
;(function () {
  'use strict'
  if (window.__laikeRecorder) return
  window.__laikeRecorder = { installed: true, seen: 0 }

  const TOPIC = '__laike_rec__'
  const INTERESTING = [
    'get_current_conversation_list',
    'getConversationTag',
    'get_history_msg',
    'batchGetUserInfoForMerchant',
    'batch_get_cs_info',
    'get_cs_info',
  ]
  const MAX_BODY = 400000 // 单个响应最多录 400KB，避免大响应把内存吃满

  function post(payload) {
    try {
      window.postMessage({ [TOPIC]: true, ...payload }, window.location.origin)
    } catch {
      /* ignore */
    }
  }

  function isInteresting(url) {
    return INTERESTING.some((k) => url.indexOf(k) >= 0)
  }

  function parseMaybeJson(text) {
    if (typeof text !== 'string' || text.length === 0) return null
    const head = text.slice(0, 2000)
    if (!/^\s*[[{]/.test(head)) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  function report(url, reqBody, respText) {
    if (!isInteresting(url)) return
    window.__laikeRecorder.seen += 1
    post({
      kind: 'traffic',
      url: String(url).slice(0, 2000),
      reqBody: reqBody === undefined || reqBody === null ? null : String(reqBody).slice(0, MAX_BODY),
      respJson: parseMaybeJson(respText),
      at: Date.now(),
    })
  }

  // ── XHR ────────────────────────────────────────────────────────────────────
  // hook **原型**方法而不是实例方法 —— 库里常常提前保存了
  // `XMLHttpRequest.prototype.open` 的引用，hook 实例会漏。
  try {
    const XHR = window.XMLHttpRequest
    if (XHR && XHR.prototype && !XHR.prototype.__laikeHooked) {
      XHR.prototype.__laikeHooked = true
      const origOpen = XHR.prototype.open
      const origSend = XHR.prototype.send
      const nativeAdd = XHR.prototype.addEventListener

      XHR.prototype.open = function (method, url) {
        try {
          this.__laikeUrl = String(url || '')
          this.__laikeMethod = String(method || 'GET').toUpperCase()
        } catch {
          /* ignore */
        }
        return origOpen.apply(this, arguments)
      }

      XHR.prototype.send = function (body) {
        try {
          this.__laikeBody = body
          // ★ 关键：在 send 里自己挂监听，**不依赖应用是否调用 addEventListener**
          if (!this.__laikeListening && this.__laikeUrl) {
            this.__laikeListening = true
            const self = this
            const flush = function () {
              if (self.__laikeReported) return
              self.__laikeReported = true
              try {
                let text = ''
                const kind = String(self.responseType || '')
                if (kind === '' || kind === 'text') text = self.responseText
                else if (kind === 'json') text = self.response ? JSON.stringify(self.response) : ''
                let b = self.__laikeBody
                if (b && typeof b !== 'string') b = String(b)
                report(self.__laikeUrl, b, text)
              } catch {
                /* ignore */
              }
            }
            nativeAdd.call(self, 'loadend', flush)
            // 老实现 / 被打断时 loadend 不一定来，用 readystatechange 兜底
            nativeAdd.call(self, 'readystatechange', function () {
              if (self.readyState === 4) flush()
            })
          }
        } catch {
          /* ignore */
        }
        return origSend.apply(this, arguments)
      }
    }
  } catch {
    /* ignore */
  }

  // ── fetch ──────────────────────────────────────────────────────────────────
  try {
    const nativeFetch = window.fetch
    if (typeof nativeFetch === 'function' && !nativeFetch.__laikeHooked) {
      const hooked = function (input, init) {
        const url = typeof input === 'string' ? input : input && input.url
        const body = init && init.body
        const p = nativeFetch.apply(this, arguments)
        try {
          if (url && isInteresting(String(url))) {
            p.then((res) => {
              res
                .clone()
                .text()
                .then((t) => report(url, body, t))
                .catch(() => {})
            }).catch(() => {})
          }
        } catch {
          /* ignore */
        }
        return p
      }
      hooked.__laikeHooked = true
      window.fetch = hooked
    }
  } catch {
    /* ignore */
  }

  // 告诉内容脚本「记录器就绪」，并周期性上报心跳（内容脚本据此判断记录器活着）
  post({ kind: 'ready' })
  setInterval(() => {
    try {
      post({ kind: 'heartbeat', seen: window.__laikeRecorder.seen })
    } catch {
      /* ignore */
    }
  }, 5000)
})()
