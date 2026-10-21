// injected.js —— 注入页面主世界(main world)，hook 页面自己的 WebSocket。
//
// 抖音 PC 页面自己会连 wss://<xxx>-frontier.douyin.com/... 这条长连接收私信。
// 我们覆写 window.WebSocket，截获 onmessage 收到的每一帧，转成 base64 后
// postMessage 给 content.js（隔离世界），再经 background 转发给 Hermes 解析。
//
// 关键：我们不新建任何连接、不改请求、不参与签名（URL 里的 signature 是页面
// 自己算好的），只“听”页面已有连接 → 指纹零变化、抗风控。
//
// 解析在 Python 侧集中做（protobuf_codec.py）。这里只负责：
//   1) 认出哪条 ws 是 frontier 私信通道（排除 bytelink 那条噪音通道）
//   2) 丢掉 "hi" 心跳帧
//   3) 原样 base64 转发
(function () {
  "use strict";

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || NativeWebSocket.__hermesDouyinHooked) {
    return;
  }

  // ── 帧过滤 ────────────────────────────────────────────────────────────────

  // frontier 是私信长连接;bytelink 是字节内部 pub/sub(直播间状态/通知推送),
  // 与私信无关,截了只是噪音 —— 明确排除。
  function isFrontierUrl(url) {
    if (typeof url !== "string") return false;
    if (url.indexOf("bytelink") !== -1) return false;
    return url.indexOf("frontier") !== -1 && url.indexOf("douyin") !== -1;
  }

  // 心跳帧:内容固定为 "hi"(2 字节),周期性,无业务内容。直接丢弃不转发,
  // 省掉大量无效流量与 Python 侧空转。
  const HEARTBEAT_MAX_BYTES = 4;

  function isHeartbeat(bytes) {
    if (bytes.length === 0 || bytes.length > HEARTBEAT_MAX_BYTES) return false;
    let text = "";
    for (let i = 0; i < bytes.length; i++) {
      text += String.fromCharCode(bytes[i]);
    }
    text = text.trim().toLowerCase();
    return text === "hi" || text === "hb";
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000; // 分块，避免超长 apply 爆栈
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + chunk)
      );
    }
    return btoa(binary);
  }

  function postFrame(base64) {
    try {
      window.postMessage(
        { __hermes_douyin__: true, dir: "frame", raw_b64: base64 },
        "*"
      );
    } catch (e) {
      /* ignore */
    }
  }

  function handleBinary(bytes) {
    if (isHeartbeat(bytes)) return;
    try {
      postFrame(bytesToBase64(bytes));
    } catch (e) {
      /* ignore */
    }
  }

  function handleFrameData(data) {
    if (data instanceof ArrayBuffer) {
      handleBinary(new Uint8Array(data));
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      // Blob 需要异步读；抖音一般给 ArrayBuffer，这里兜底。
      try {
        data.arrayBuffer().then(function (buf) {
          handleBinary(new Uint8Array(buf));
        });
      } catch (_) {}
      return;
    }
    if (typeof data === "string") {
      // frontier 主链路是二进制帧；文本帧目前只见过心跳，按 UTF-8 编码后走
      // 同一条过滤/转发路径，Python 侧一样能兜住（解不出载荷就返回空列表）。
      try {
        const bytes = new TextEncoder().encode(data);
        handleBinary(bytes);
      } catch (_) {}
    }
  }

  // ── hook ─────────────────────────────────────────────────────────────────

  function HookedWebSocket(url, protocols) {
    const ws =
      protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);

    if (isFrontierUrl(url)) {
      // binaryType 保持页面自己的设置，不改动（改了可能影响页面逻辑）。
      ws.addEventListener("message", function (event) {
        try {
          handleFrameData(event.data);
        } catch (e) {
          /* ignore */
        }
      });

      // 保存页面连接引用：等出站帧格式实测确认后（设计稿 §12.5 PR-3），
      // 直接用它定向发消息，而不是走 DOM 模拟。当前 DOM 路径见 content.js。
      try {
        window.__hermes_douyin_ws__ = ws;
      } catch (_) {}

      // 通知 background：页面私信长连接已成功 hook。这是真·“页面已接上”信号，
      // 与有没有私信进来无关；background 用它判断“连上桥但页面没 hook → 刷新”。
      try {
        window.postMessage({ __hermes_douyin__: true, dir: "ws_hooked" }, "*");
      } catch (_) {}
    }

    return ws;
  }

  HookedWebSocket.prototype = NativeWebSocket.prototype;
  HookedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  HookedWebSocket.OPEN = NativeWebSocket.OPEN;
  HookedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  HookedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  HookedWebSocket.__hermesDouyinHooked = true;

  try {
    window.WebSocket = HookedWebSocket;
  } catch (e) {
    /* 某些环境禁止覆写，忽略 */
  }

  // ══════════════════════════════════════════════════════════════════════
  // 发送:捕获模板 + 用页面自己的 XHR 执行 POST
  // ══════════════════════════════════════════════════════════════════════
  //
  // 发送是 `POST imapi.douyin.com/v1/message/send`（protobuf 体，URL 无签名）。
  // 请求体里有几十个环境字段和一个每条都变、算法未逆的 ticket；但实测**服务端
  // 不校验 ticket 新鲜度**，所以:
  //
  //   1) hook 页面自己发的那次请求，把请求体原样上报 → Hermes 存为模板
  //   2) Hermes 侧替换会话/正文后把字节发回来 → 这里用页面自己的 XHR POST 出去
  //
  // 必须在**主世界**发,才能带上页面的 cookie 与同源上下文。

  const SEND_URL_RE = /imapi\.douyin\.com\/v1\/message\/send/;
  const SEND_URL = "https://imapi.douyin.com/v1/message/send";
  // 点「私信」建会话（2026-08-11 探针）: create → get_info_list → short_id
  const CREATE_URL_RE = /imapi\.douyin\.com\/v2\/conversation\/create/;
  const CREATE_URL = "https://imapi.douyin.com/v2/conversation/create";
  const IMAP_HOST_RE = /^https:\/\/imapi\.douyin\.com\//i;

  // 发评论走另一条完全不同的接口:form-urlencoded、回 JSON、**URL 上有签名**
  // （msToken / a_bogus / verifyFp）。实测裸 XHR 会被字节的 security-secsdk
  // 自动补签(它拦的是 XMLHttpRequest.send)，所以我们照常发、不构造签名 ——
  // 但这只在**主世界**成立，隔离世界里没有 secsdk。
  const COMMENT_PUBLISH_RE = /\/aweme\/v1\/web\/comment\/publish/;
  // 投稿 create_v2（仅武装期间关心）
  const CREATE_V2_RE = /\/web\/api\/media\/aweme\/create_v2\//i;
  let createV2Armed = false;
  // 私信会话列表批量拉用户资料（昵称 + 头像）
  const USER_INFO_RE = /\/aweme\/v1\/web\/im\/user\/info\/?/i;

  function bufToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function toBytesForTemplate(body) {
    try {
      if (body instanceof ArrayBuffer) return new Uint8Array(body);
      if (ArrayBuffer.isView(body)) {
        return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      }
    } catch (_) {}
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 统一的 XHR / fetch hook —— 同时服务两件事:
  //   ① 捕获发送模板（只认 message/send 那个 URL）
  //   ② 探针:按字节搜标记，命中就记录（供 agent 自助侦察新能力）
  //
  // **刻意只装一层 hook**。早期设想是探针启动时再包一层，但那样会与模板捕获的
  // 包装叠加，stop 时拆不干净（顺序一乱就把原生实现弄丢）。这里改成常驻一层，
  // 探针只是切一个开关 —— 装卸不再涉及改动原型链。
  // ══════════════════════════════════════════════════════════════════════

  // 探针状态。token 为空即关闭。
  // 注意：XHR/fetch 的原型包装是常驻的，但**默认只深入处理 imapi/评论/投稿**；
  // 探针 start 后才扫全站请求。否则抖音 feed 每秒上百次请求都会 clone/读 body，电脑会闷死。
  const probe = { token: "", tokenBytes: null, limit: 8, hits: [] };

  function probeOn() {
    return !!probe.token && probe.hits.length < probe.limit;
  }

  /** 这个 URL 是否值得读 body / 挂监听。绝大多数 CDN/埋点直接放行。 */
  function shouldInspectRequest(url) {
    if (probeOn()) return true;
    const u = String(url || "");
    if (!u) return false;
    // 廉价预筛：没命中关键词就绝不跑正则/读 body
    if (
      u.indexOf("imapi") === -1 &&
      u.indexOf("comment/publish") === -1 &&
      u.indexOf("create_v2") === -1 &&
      u.indexOf("im/user/info") === -1
    ) {
      return false;
    }
    return (
      SEND_URL_RE.test(u) ||
      CREATE_URL_RE.test(u) ||
      COMMENT_PUBLISH_RE.test(u) ||
      IMAP_HOST_RE.test(u) ||
      CREATE_V2_RE.test(u) ||
      USER_INFO_RE.test(u)
    );
  }

  function shouldWatchArmedCreateV2(url) {
    return createV2Armed && CREATE_V2_RE.test(String(url || ""));
  }

  function bytesContain(bytes, needle) {
    if (!bytes || !needle || needle.length === 0) return false;
    const n = bytes.length;
    const m = needle.length;
    if (n < m) return false;
    outer: for (let i = 0; i <= n - m; i++) {
      for (let j = 0; j < m; j++) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  function anyToBytes(body) {
    try {
      if (body == null) return null;
      if (typeof body === "string") return new TextEncoder().encode(body);
      if (body instanceof ArrayBuffer) return new Uint8Array(body);
      if (ArrayBuffer.isView(body)) {
        return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      }
      if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        return new TextEncoder().encode(body.toString());
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const parts = [];
        for (const [k, v] of body.entries()) {
          parts.push(k + "=" + (typeof v === "string" ? v : "[blob]"));
        }
        return new TextEncoder().encode(parts.join("&"));
      }
      // Blob/File 只能异步读 —— 同步路径返回 null，由 fetch hook 走 arrayBuffer()
    } catch (_) {}
    return null;
  }

  function reportCreateTemplate(bytes) {
    if (!bytes || !bytes.length) return;
    try {
      window.postMessage(
        {
          __hermes_douyin__: true,
          dir: "create_template",
          body_b64: bufToBase64(bytes),
        },
        "*"
      );
      try {
        console.info(
          "[DSH 客服] 已捕获开聊模板 create",
          bytes.length,
          "字节（点「私信」）"
        );
      } catch (_) {}
    } catch (_) {}
  }

  function reportCreatePair(reqBytes, respBytes, httpStatus) {
    try {
      window.postMessage(
        {
          __hermes_douyin__: true,
          dir: "create_pair",
          req_b64: reqBytes && reqBytes.length ? bufToBase64(reqBytes) : "",
          resp_b64: respBytes && respBytes.length ? bufToBase64(respBytes) : "",
          http_status: httpStatus || 0,
        },
        "*"
      );
      try {
        console.info(
          "[DSH 客服] 已上报 create 请求+响应",
          "req=",
          reqBytes ? reqBytes.length : 0,
          "resp=",
          respBytes ? respBytes.length : 0,
          "http=",
          httpStatus || 0
        );
      } catch (_) {}
    } catch (_) {}
  }

  async function bodyToBytesAsync(body) {
    const sync = anyToBytes(body);
    if (sync && sync.length) return sync;
    try {
      if (body && typeof body.arrayBuffer === "function") {
        return new Uint8Array(await body.arrayBuffer());
      }
    } catch (_) {}
    return null;
  }

  function describeBodyForProbe(bytes) {
    if (!bytes) return { kind: "unknown", note: "同步路径读不到（可能是 Blob/File）" };
    const MAX = 64 * 1024;
    const clipped = bytes.length > MAX;
    const view = clipped ? bytes.subarray(0, MAX) : bytes;
    const out = {
      bytes: bytes.length,
      clipped: clipped,
      base64: bufToBase64(view),
      kind: "binary",
    };
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(view);
      let ctrl = 0;
      for (const ch of text) {
        const c = ch.codePointAt(0);
        if ((c < 0x20 && !"\t\n\r".includes(ch)) || c === 0x7f) ctrl++;
      }
      if (ctrl === 0) {
        out.kind = "text";
        out.text = text;
      }
    } catch (_) {}
    return out;
  }

  function probeRecord(entry) {
    if (probe.hits.length >= probe.limit) return;
    entry.at = new Date().toISOString();
    probe.hits.push(entry);
  }

  function probeStack() {
    try {
      return (new Error().stack || "").split("\n").slice(2, 12).join("\n");
    } catch (_) {
      return "";
    }
  }

  /** 统一的出站观察点。只读，绝不改请求内容。 */
  function observeOutbound(kind, method, url, headers, body) {
    // 默认只盯 imapi/评论等；探针开启才扫全站（见 shouldInspectRequest）
    if (!shouldInspectRequest(url) && !shouldWatchArmedCreateV2(url)) return;

    const bytes = anyToBytes(body);

    // ① 模板捕获
    try {
      if (SEND_URL_RE.test(String(url || "")) && bytes && bytes.length > 0) {
        window.postMessage(
          {
            __hermes_douyin__: true,
            dir: "send_template",
            body_b64: bufToBase64(bytes),
          },
          "*"
        );
      }
      if (CREATE_URL_RE.test(String(url || "")) && bytes && bytes.length > 0) {
        reportCreateTemplate(bytes);
      }
    } catch (_) {}

    // ② 探针
    try {
      if (!probeOn()) return;
      const urlBytes = new TextEncoder().encode(String(url || ""));
      if (
        !bytesContain(bytes, probe.tokenBytes) &&
        !bytesContain(urlBytes, probe.tokenBytes)
      ) {
        return;
      }
      probeRecord({
        channel: kind,
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
        headers: headers || null,
        body: describeBodyForProbe(bytes),
        stack: probeStack(),
      });
    } catch (_) {}
  }

  try {
    const nativeXhrOpen = XMLHttpRequest.prototype.open;
    const nativeXhrSend = XMLHttpRequest.prototype.send;
    const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__hermesMethod = method;
        this.__hermesUrl = String(url || "");
        this.__hermesHeaders = {};
      } catch (_) {}
      return nativeXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try {
        // 请求头只给探针用；探针关着时不存，省对象写入
        if (probeOn() && this.__hermesHeaders) this.__hermesHeaders[k] = v;
      } catch (_) {}
      return nativeSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const url = this.__hermesUrl || "";
      const inspect = shouldInspectRequest(url);
      const armCreate = shouldWatchArmedCreateV2(url);
      if (!inspect && !armCreate) {
        return nativeXhrSend.apply(this, arguments);
      }
      try {
        this.__hermesReqBytes = anyToBytes(body);
      } catch (_) {
        this.__hermesReqBytes = null;
      }
      try {
        observeOutbound(
          "xhr",
          this.__hermesMethod,
          url,
          this.__hermesHeaders,
          body
        );
      } catch (_) {}
      try {
        watchCommentBaseline(this);
      } catch (_) {}
      try {
        watchCreateV2(this);
      } catch (_) {}
      try {
        watchConversationCreate(this);
      } catch (_) {}
      try {
        watchUserInfo(this);
      } catch (_) {}
      return nativeXhrSend.apply(this, arguments);
    };
  } catch (_) {}

  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
      window.fetch = function (input, init) {
        const url =
          typeof input === "string"
            ? input
            : (input && input.url) || "";
        const method = String(
          (init && init.method) || (input && input.method) || "GET"
        ).toUpperCase();
        const urlStr = String(url || "");
        const inspect = shouldInspectRequest(urlStr);
        const isCreate = inspect && CREATE_URL_RE.test(urlStr);
        const isSend = inspect && SEND_URL_RE.test(urlStr);

        // 只在 create/send（或探针）时 clone —— 全站 clone 是卡顿主因之一
        let reqClone = null;
        let bodyClone = null;
        if (isCreate || isSend || probeOn()) {
          try {
            if (typeof Request !== "undefined" && input instanceof Request) {
              reqClone = input.clone();
            }
          } catch (_) {}
          try {
            if (
              init &&
              init.body &&
              typeof Blob !== "undefined" &&
              init.body instanceof Blob
            ) {
              bodyClone = init.body.slice();
            }
          } catch (_) {}
        }

        if (inspect) {
          try {
            observeOutbound(
              "fetch",
              method,
              urlStr,
              init && init.headers,
              init && init.body
            );
          } catch (_) {}
        }

        const p = nativeFetch.apply(this, arguments);

        // create / send：补抓 Blob/Request 体 + create 响应（原先只 hook 了 XHR）
        if (isCreate || isSend) {
          Promise.resolve(p)
            .then(async function (resp) {
              try {
                let reqBytes = anyToBytes(init && init.body);
                if ((!reqBytes || !reqBytes.length) && bodyClone) {
                  reqBytes = await bodyToBytesAsync(bodyClone);
                }
                if ((!reqBytes || !reqBytes.length) && reqClone) {
                  try {
                    reqBytes = new Uint8Array(await reqClone.arrayBuffer());
                  } catch (_) {}
                }
                if (isCreate && reqBytes && reqBytes.length) {
                  reportCreateTemplate(reqBytes);
                }
                if (isSend && reqBytes && reqBytes.length) {
                  try {
                    window.postMessage(
                      {
                        __hermes_douyin__: true,
                        dir: "send_template",
                        body_b64: bufToBase64(reqBytes),
                      },
                      "*"
                    );
                  } catch (_) {}
                }
                if (isCreate && resp) {
                  try {
                    const buf = await resp.clone().arrayBuffer();
                    reportCreatePair(
                      reqBytes,
                      new Uint8Array(buf || []),
                      resp.status || 0
                    );
                  } catch (_) {}
                }
              } catch (_) {}
            })
            .catch(function () {});
        }

        // 会话列表用户资料（昵称/头像）
        if (inspect && USER_INFO_RE.test(urlStr)) {
          Promise.resolve(p)
            .then(function (resp) {
              if (!resp) return null;
              try {
                return resp.clone().text();
              } catch (_) {
                return null;
              }
            })
            .then(function (text) {
              if (text) reportUserInfoJson(text);
            })
            .catch(function () {});
        }
        return p;
      };
    }
  } catch (_) {}

  // 页面自己点「私信」时 create 的响应（含 short_id）→ 上报 Hermes 解析登记。
  function watchConversationCreate(xhr) {
    if (!CREATE_URL_RE.test(String(xhr.__hermesUrl || ""))) return;
    if (xhr.__hermesSelfIssued) return; // 我们自己发的走 post_imapi 回执
    xhr.addEventListener("loadend", function () {
      try {
        let respBytes = null;
        try {
          if (xhr.responseType === "arraybuffer" && xhr.response) {
            respBytes = new Uint8Array(xhr.response);
          } else if (xhr.responseText) {
            respBytes = new TextEncoder().encode(String(xhr.responseText || ""));
          }
        } catch (_) {}
        reportCreatePair(xhr.__hermesReqBytes, respBytes, xhr.status || 0);
      } catch (_) {}
    });
  }

  // ② 执行发送:content.js postMessage {dir:"send_raw", req_id, body_b64} 上来，
  //    这里用页面自己的 XHR POST，把响应体 base64 回传（Hermes 靠它判断成败）。
  function postSendRaw(reqId, bodyB64) {
    postImapiRaw(reqId, SEND_URL, bodyB64, "send_raw_ack");
  }

  // 通用 imapi POST（create 等）。硬限定 imapi.douyin.com。
  function postImapiRaw(reqId, url, bodyB64, ackDir) {
    ackDir = ackDir || "post_imapi_ack";
    function reply(ok, error, respB64, httpStatus) {
      try {
        window.postMessage(
          {
            __hermes_douyin__: true,
            dir: ackDir,
            req_id: reqId,
            ok: !!ok,
            error: error || "",
            resp_b64: respB64 || "",
            http_status: httpStatus || 0,
          },
          "*"
        );
      } catch (_) {}
    }
    if (!IMAP_HOST_RE.test(String(url || ""))) {
      reply(false, "拒绝:目标不是 imapi.douyin.com —— " + String(url).slice(0, 120));
      return;
    }
    let bytes;
    try {
      bytes = base64ToBytes(bodyB64);
    } catch (e) {
      reply(false, "请求体 base64 解码失败");
      return;
    }
    try {
      const xhr = new XMLHttpRequest();
      xhr.__hermesSelfIssued = true;
      xhr.open("POST", url, true);
      xhr.responseType = "arraybuffer";
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/x-protobuf");
      xhr.setRequestHeader("Accept", "application/x-protobuf");
      xhr.onload = function () {
        try {
          const resp = new Uint8Array(xhr.response || new ArrayBuffer(0));
          const httpOk = xhr.status >= 200 && xhr.status < 300;
          reply(
            httpOk,
            httpOk ? "" : "HTTP " + xhr.status,
            bufToBase64(resp),
            xhr.status
          );
        } catch (e) {
          reply(false, "读取响应失败: " + e);
        }
      };
      xhr.onerror = function () {
        reply(false, "网络错误（POST 未送达）");
      };
      xhr.ontimeout = function () {
        reply(false, "请求超时");
      };
      xhr.timeout = 15000;
      xhr.send(bytes);
    } catch (e) {
      reply(false, String((e && e.message) || e));
    }
  }

  // ── 评论响应基线 ─────────────────────────────────────────────────────────
  //
  // 为什么需要它:发评论的响应里，评论对象带一个 `status` 字段。裸请求实测拿到
  // 的是 7，但**没人知道 7 是不是正常值** —— 抖音对「仅自己可见」这类软拦截
  // 惯用 HTTP 200 + 正常响应体 + 一个非常规状态，接口层面看不出来。
  //
  // 与其猜，不如让页面自己回答:用户在网页上正常发一条评论时，把那次响应的
  // status 记下来当基线。之后我们自己发的评论只要 status 与基线一致，就能确定
  // 没被降权;不一致则**明确报警**，而不是假装成功。
  //
  // 与发送模板同样的思路（存下页面自己做过的一次），差别是这里存的是**响应**。
  // 只 hook XHR:实测这个接口走 XHR（secsdk 拦的就是 XHR.send）。
  //
  // 取正文**不能只认 responseText** —— 页面把 responseType 设成 json/blob 等
  // 非文本值时读它会抛 InvalidStateError。早先版本在这里静默 return，结果是用户
  // 连发数条都建不起基线、且没有任何迹象。现在按 responseType 分支取，并且取不到
  // 时往 console 留话:这条路径没有别的可观测面，静默失败等于没有失败报告。

  function readXhrText(xhr) {
    const kind = String(xhr.responseType || "");
    if (kind === "" || kind === "text") {
      try {
        return xhr.responseText || "";
      } catch (_) {
        return "";
      }
    }
    let resp;
    try {
      resp = xhr.response;
    } catch (_) {
      return "";
    }
    if (resp == null) return "";
    if (typeof resp === "string") return resp;
    if (kind === "json") {
      try {
        return JSON.stringify(resp);
      } catch (_) {
        return "";
      }
    }
    if (resp instanceof ArrayBuffer) {
      try {
        return new TextDecoder("utf-8").decode(new Uint8Array(resp));
      } catch (_) {
        return "";
      }
    }
    return "";
  }

  // 投稿 create_v2 响应（一次性武装）────────────────────────────────────
  //
  // 点「发布」后页面会 POST /web/api/media/aweme/create_v2/。URL 跳到作品管理
  // 只是弱信号；响应体里的 status_code 才是业务成败。content.js 在点发布前
  // postMessage create_v2_arm，这里挂一次 loadend，把正文回传后自动卸武。
  // CREATE_V2_RE / createV2Armed 已在上方与其它 URL 常量一起声明。

  function watchCreateV2(xhr) {
    if (!createV2Armed) return;
    if (!CREATE_V2_RE.test(String(xhr.__hermesUrl || ""))) return;
    createV2Armed = false; // 一次性
    xhr.addEventListener("loadend", function () {
      const emit = function (text) {
        try {
          window.postMessage(
            {
              __hermes_douyin__: true,
              dir: "create_v2_result",
              http_status: xhr.status,
              resp_text: (text || "").slice(0, 8192),
            },
            "*"
          );
        } catch (_) {}
      };
      let resp = null;
      try {
        resp = xhr.response;
      } catch (_) {}
      if (resp && typeof Blob !== "undefined" && resp instanceof Blob) {
        try {
          resp.text().then(emit, function () {
            emit("");
          });
        } catch (_) {
          emit("");
        }
        return;
      }
      emit(readXhrText(xhr));
    });
  }

  function pickAvatarUrl(user) {
    if (!user || typeof user !== "object") return "";
    const keys = ["avatar_thumb", "avatar_small", "avatar_medium", "avatar_larger"];
    for (let i = 0; i < keys.length; i++) {
      const block = user[keys[i]];
      if (block && block.url_list && block.url_list.length) {
        const u = String(block.url_list[0] || "").trim();
        if (u) return u;
      }
    }
    return String(user.avatar_url || "").trim();
  }

  function extractUsersFromUserInfoJson(text) {
    let data;
    try {
      data = JSON.parse(text || "");
    } catch (_) {
      return [];
    }
    if (!data || typeof data !== "object") return [];
    const arr = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.user_list)
        ? data.user_list
        : [];
    const out = [];
    for (let i = 0; i < arr.length && out.length < 80; i++) {
      const u = arr[i];
      if (!u || typeof u !== "object") continue;
      const uid = String(u.uid || u.user_id || "").trim();
      const sec = String(u.sec_uid || "").trim();
      const nick = String(u.nickname || "").trim();
      const avatar = pickAvatarUrl(u);
      if (!uid && !sec) continue;
      if (!nick && !avatar) continue;
      out.push({
        uid: uid,
        sec_uid: sec,
        nickname: nick,
        avatar_url: avatar,
        unique_id: String(u.unique_id || "").trim(),
        short_id: String(u.short_id || "").trim(),
      });
    }
    return out;
  }

  function reportUserInfoJson(text) {
    const users = extractUsersFromUserInfoJson(text);
    if (!users.length) return;
    try {
      window.postMessage(
        {
          __hermes_douyin__: true,
          dir: "user_info",
          users: users,
        },
        "*"
      );
      try {
        console.info(
          "[DSH 客服] 已捕获用户资料",
          users.length,
          "人（昵称/头像）"
        );
      } catch (_) {}
    } catch (_) {}
  }

  function watchUserInfo(xhr) {
    if (!USER_INFO_RE.test(String(xhr.__hermesUrl || ""))) return;
    xhr.addEventListener("loadend", function () {
      try {
        let text = "";
        try {
          if (xhr.responseType === "" || xhr.responseType === "text") {
            text = xhr.responseText || "";
          } else if (xhr.responseType === "json" && xhr.response) {
            text = JSON.stringify(xhr.response);
          }
        } catch (_) {}
        if (!text && xhr.response && typeof Blob !== "undefined" && xhr.response instanceof Blob) {
          try {
            xhr.response.text().then(reportUserInfoJson);
          } catch (_) {}
          return;
        }
        if (text) reportUserInfoJson(text);
      } catch (_) {}
    });
  }

  function watchCommentBaseline(xhr) {
    if (xhr.__hermesSelfIssued) return; // 我们自己发的不算基线
    if (!COMMENT_PUBLISH_RE.test(String(xhr.__hermesUrl || ""))) return;
    xhr.addEventListener("loadend", function () {
      const emit = function (text) {
        if (!text) {
          console.warn(
            "[DSH 客服] 评论响应取不到正文（responseType=" +
              String(xhr.responseType || "(空)") +
              "，HTTP " +
              xhr.status +
              "），基线未建立。"
          );
          return;
        }
        try {
          window.postMessage(
            {
              __hermes_douyin__: true,
              dir: "comment_baseline",
              http_status: xhr.status,
              resp_text: text.slice(0, 4096),
            },
            "*"
          );
          console.info(
            "[DSH 客服] 已上报评论响应基线（HTTP " + xhr.status + "）"
          );
        } catch (_) {}
      };
      let resp = null;
      try {
        resp = xhr.response;
      } catch (_) {}
      // Blob 只能异步读，单独走一支。
      if (resp && typeof Blob !== "undefined" && resp instanceof Blob) {
        try {
          resp.text().then(emit, function () {
            emit("");
          });
        } catch (_) {
          emit("");
        }
        return;
      }
      emit(readXhrText(xhr));
    });
  }

  // ── post_form / get_json:用页面身份发 XHR ───────────────────────────────
  //
  // 通用通道：写操作用 form POST（发评论），读操作用 GET（评论列表 / 搜索）。
  // Hermes 侧拼好 URL 与字段，这里只负责「用页面自己的 XHR 发出去」——编解码
  // 集中在 Python 侧，一处维护。
  //
  // fields 是**有序的 [key, value] 数组**而不是对象:出站参数顺序要和页面自己
  // 发的一致，JSON 对象的键序在跨语言往返时没有保证。
  //
  // 目标限定在 douyin.com:桥虽然有配对码，但「能让浏览器带着登录态请求任意
  // 地址」是个不该存在的能力，加一道硬闸更便宜。
  //
  // 与发评论同一条结论：主世界 XHR 会被 security-secsdk 在 send 时补签
  // （msToken / a_bogus 等）。隔离世界和 background 没有 secsdk，从那里发会挂。

  function isDouyinUrl(url) {
    try {
      const u = new URL(String(url), location.href);
      if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      return u.hostname === "douyin.com" || u.hostname.endsWith(".douyin.com");
    } catch (_) {
      return false;
    }
  }

  function replyHttp(dir, reqId, ok, error, httpStatus, respText) {
    try {
      window.postMessage(
        {
          __hermes_douyin__: true,
          dir: dir,
          req_id: reqId,
          ok: !!ok,
          error: error || "",
          http_status: httpStatus || 0,
          resp_text: respText || "",
        },
        "*"
      );
    } catch (_) {}
  }

  function postForm(reqId, url, fields) {
    const reply = function (ok, error, httpStatus, respText) {
      replyHttp("post_form_ack", reqId, ok, error, httpStatus, respText);
    };

    if (!isDouyinUrl(url)) {
      reply(false, "拒绝执行:目标不是 douyin.com —— " + String(url).slice(0, 200));
      return;
    }

    let body;
    try {
      const params = new URLSearchParams();
      const pairs = Array.isArray(fields) ? fields : [];
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length === 0) continue;
        params.append(String(pair[0]), pair[1] == null ? "" : String(pair[1]));
      }
      body = params.toString();
    } catch (e) {
      reply(false, "表单字段无法编码: " + ((e && e.message) || e));
      return;
    }

    try {
      const xhr = new XMLHttpRequest();
      // 标记自发:否则我们自己的评论会被 watchCommentBaseline 当成页面基线，
      // 基线就失去了「页面自己发的」这个参照意义。
      xhr.__hermesSelfIssued = true;
      xhr.open("POST", url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
      xhr.onload = function () {
        let text = "";
        try {
          text = xhr.responseText || "";
        } catch (_) {}
        // HTTP 层成功即回 ok；**业务成败由 Hermes 解响应体判定**
        // （抖音会用 HTTP 200 + status_code!=0 表示业务失败）。
        const httpOk = xhr.status >= 200 && xhr.status < 300;
        reply(httpOk, httpOk ? "" : "HTTP " + xhr.status, xhr.status, text);
      };
      xhr.onerror = function () {
        reply(false, "网络错误（POST 未送达）", 0, "");
      };
      xhr.ontimeout = function () {
        reply(false, "请求超时", 0, "");
      };
      xhr.timeout = 15000;
      xhr.send(body);
    } catch (e) {
      reply(false, String((e && e.message) || e), 0, "");
    }
  }

  // GET JSON：评论列表 / 搜索等读接口。query 已由 Hermes 拼进 url。
  function getJson(reqId, url) {
    const reply = function (ok, error, httpStatus, respText) {
      replyHttp("get_json_ack", reqId, ok, error, httpStatus, respText);
    };

    if (!isDouyinUrl(url)) {
      reply(false, "拒绝执行:目标不是 douyin.com —— " + String(url).slice(0, 200));
      return;
    }

    try {
      const xhr = new XMLHttpRequest();
      xhr.__hermesSelfIssued = true;
      xhr.open("GET", url, true);
      xhr.withCredentials = true;
      xhr.onload = function () {
        let text = "";
        try {
          text = xhr.responseText || "";
        } catch (_) {}
        const httpOk = xhr.status >= 200 && xhr.status < 300;
        reply(httpOk, httpOk ? "" : "HTTP " + xhr.status, xhr.status, text);
      };
      xhr.onerror = function () {
        reply(false, "网络错误（GET 未送达）", 0, "");
      };
      xhr.ontimeout = function () {
        reply(false, "请求超时", 0, "");
      };
      xhr.timeout = 15000;
      xhr.send();
    } catch (e) {
      reply(false, String((e && e.message) || e), 0, "");
    }
  }

  // ── call_api:需要返回值的指令（探针开关/取结果等）──────────────────────
  function handleCallApi(reqId, action, args) {
    args = args || {};
    let data;
    try {
      if (action === "probe_start") {
        probe.token = String(args.contains || "");
        probe.tokenBytes = probe.token
          ? new TextEncoder().encode(probe.token)
          : null;
        probe.limit = Math.max(1, Math.min(50, parseInt(args.limit, 10) || 8));
        probe.hits = [];
        data = { ok: !!probe.token, token: probe.token, limit: probe.limit };
        if (!probe.token) data.error = "contains 不能为空（需要一个 ASCII 标记）";
      } else if (action === "probe_dump") {
        data = { ok: true, token: probe.token, hits: probe.hits.slice() };
      } else if (action === "probe_stop") {
        const n = probe.hits.length;
        probe.token = "";
        probe.tokenBytes = null;
        probe.hits = [];
        data = { ok: true, cleared: n };
      } else if (action === "probe_status") {
        data = {
          ok: true,
          active: !!probe.token,
          token: probe.token,
          hit_count: probe.hits.length,
          limit: probe.limit,
        };
      } else {
        data = { error: "unknown_action: " + action };
      }
    } catch (e) {
      data = { error: String((e && e.message) || e) };
    }
    try {
      window.postMessage(
        {
          __hermes_douyin__: true,
          dir: "call_api_ack",
          req_id: reqId,
          data: data,
        },
        "*"
      );
    } catch (_) {}
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__hermes_douyin__ !== true) return;
    if (d.dir === "send_raw") {
      postSendRaw(d.req_id, d.body_b64);
    } else if (d.dir === "post_imapi") {
      postImapiRaw(d.req_id, d.url, d.body_b64, "post_imapi_ack");
    } else if (d.dir === "post_form") {
      postForm(d.req_id, d.url, d.fields);
    } else if (d.dir === "get_json") {
      getJson(d.req_id, d.url);
    } else if (d.dir === "call_api") {
      handleCallApi(d.req_id, d.action, d.args);
    } else if (d.dir === "create_v2_arm") {
      createV2Armed = true;
    } else if (d.dir === "create_v2_disarm") {
      createV2Armed = false;
    }
  });

  // ── 风控页检测 ────────────────────────────────────────────────────────────
  try {
    const href = location.href || "";
    if (
      href.indexOf("verify") !== -1 ||
      href.indexOf("captcha") !== -1 ||
      href.indexOf("punish") !== -1
    ) {
      window.postMessage(
        {
          __hermes_douyin__: true,
          dir: "risk",
          detail: "出现验证/风控页: " + href,
        },
        "*"
      );
    }
  } catch (_) {}
})();
