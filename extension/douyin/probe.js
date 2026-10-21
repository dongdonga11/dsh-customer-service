// probe.js —— 出站通道探针（一次性调研工具，不参与正常收发链路）。
//
// 目的：确定「页面发一条私信」这个动作,到底走 fetch / XHR / WebSocket 哪条
// 通道、打到哪个 URL、请求体长什么样、以及**页面自己的发送函数在哪**。
//
// 为什么能零噪点:私信正文在帧/请求体里是**明文 UTF-8**(下行样本里
// `{"text":"这是什么"}` 就是裸的)。所以只要你发一条内容里带唯一标记的消息,
// 探针在**字节层**搜这个标记,就能精准命中承载它的那一次调用 —— 与传输通道
// 无关,fetch / XHR / WebSocket 一网打尽,不用在 Network 面板里肉眼捞。
//
// 附带产出:命中时打印 `new Error().stack`。这条栈直接指向页面 IM SDK 的
// 发送函数,是后续「调页面自己的发送函数」方案的入口地址。
//
// ── 用法（浏览器 Console，无需装扩展）────────────────────────────────────
//   1. 打开抖音私信页面,F12 → Console
//   2. 把本文件全文粘进去回车,会打印一个标记(如 hp3f9k2)
//   3. 在页面里发一条消息,内容**必须包含**那个标记,比如:「你好 hp3f9k2」
//   4. Console 会打印命中详情;`__hermesProbe.dump()` 复制成 JSON 发我
//   5. `__hermesProbe.off()` 卸载探针(或直接刷新页面)
//
// 只读:探针不改任何请求内容,原样透传给原生实现。
(function () {
  "use strict";

  if (window.__hermesProbe && window.__hermesProbe.__installed) {
    console.warn("[DSH 探针] 已安装,先 __hermesProbe.off() 再重装");
    return;
  }

  // ── 标记 ─────────────────────────────────────────────────────────────────
  // 纯 ASCII:这样它在 UTF-8 字节流里逐字节原样出现,字节搜索必定命中。
  function genToken() {
    const chars = "abcdefghijkmnpqrstuvwxyz23456789";
    let s = "hp";
    for (let i = 0; i < 5; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }

  const token = genToken();
  const tokenBytes = new TextEncoder().encode(token);
  const hits = [];
  const MAX_DUMP_BYTES = 64 * 1024; // 单条记录最多留 64KB，够看结构

  // ── 字节搜索（传输无关的命中判定）─────────────────────────────────────

  function bytesContainToken(bytes) {
    const n = bytes.length;
    const m = tokenBytes.length;
    if (m === 0 || n < m) return false;
    outer: for (let i = 0; i <= n - m; i++) {
      for (let j = 0; j < m; j++) {
        if (bytes[i + j] !== tokenBytes[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  function toBytes(data) {
    try {
      if (data == null) return null;
      if (typeof data === "string") return new TextEncoder().encode(data);
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      }
      if (typeof URLSearchParams !== "undefined" && data instanceof URLSearchParams) {
        return new TextEncoder().encode(data.toString());
      }
      if (typeof FormData !== "undefined" && data instanceof FormData) {
        const parts = [];
        for (const [k, v] of data.entries()) {
          parts.push(k + "=" + (typeof v === "string" ? v : "[blob]"));
        }
        return new TextEncoder().encode(parts.join("&"));
      }
      // Blob 是异步的,同步路径拿不到;命中判定退回 URL。
      return null;
    } catch (_) {
      return null;
    }
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function describeBody(bytes) {
    if (!bytes) return { kind: "unknown", note: "同步路径无法读取(可能是 Blob)" };
    const clipped = bytes.length > MAX_DUMP_BYTES;
    const view = clipped ? bytes.subarray(0, MAX_DUMP_BYTES) : bytes;
    // 永远带上 base64:逆向上行帧需要**精确字节**,不能只留一份可能有损的文本。
    const out = {
      bytes: bytes.length,
      clipped: clipped,
      base64: bytesToBase64(view),
    };
    // 能整体解成可打印 UTF-8 → 当文本给（form / JSON 一眼可读）
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(view);
      let printable = 0;
      for (const ch of text) {
        const code = ch.codePointAt(0);
        // 排除 C0/C1 控制字符（保留 \t \n \r）
        const isCtrl =
          (code < 0x20 && ch !== "\t" && ch !== "\n" && ch !== "\r") ||
          (code >= 0x7f && code <= 0x9f);
        if (!isCtrl) printable++;
      }
      if (printable >= [...text].length * 0.9) {
        out.kind = "text";
        out.text = text;
        return out;
      }
    } catch (_) {}
    out.kind = "binary";
    return out;
  }

  function record(entry) {
    entry.at = new Date().toISOString();
    hits.push(entry);
    console.log(
      "%c[DSH 探针] 命中 " + entry.channel,
      "color:#fff;background:#fe2c55;padding:2px 6px;border-radius:3px",
      entry
    );
    return entry;
  }

  function stackOf() {
    try {
      return (new Error().stack || "").split("\n").slice(2, 14).join("\n");
    } catch (_) {
      return "";
    }
  }

  // ── hook: fetch ──────────────────────────────────────────────────────────

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      try {
        const url =
          typeof input === "string" ? input : (input && input.url) || String(input);
        const method =
          (init && init.method) || (input && input.method) || "GET";
        const body = init && init.body;
        const bytes = toBytes(body);
        if (
          (bytes && bytesContainToken(bytes)) ||
          bytesContainToken(new TextEncoder().encode(url))
        ) {
          record({
            channel: "fetch",
            method: String(method).toUpperCase(),
            url: url,
            headers: (init && init.headers) || null,
            body: describeBody(bytes),
            stack: stackOf(),
          });
        }
      } catch (_) {}
      return nativeFetch.apply(this, arguments);
    };
    window.fetch.__hermesProbe = true;
  }

  // ── hook: XMLHttpRequest ─────────────────────────────────────────────────

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__probeMethod = method;
      this.__probeUrl = url;
      this.__probeHeaders = {};
    } catch (_) {}
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      if (this.__probeHeaders) this.__probeHeaders[k] = v;
    } catch (_) {}
    return nativeSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const bytes = toBytes(body);
      const url = this.__probeUrl || "";
      if (
        (bytes && bytesContainToken(bytes)) ||
        bytesContainToken(new TextEncoder().encode(url))
      ) {
        record({
          channel: "xhr",
          method: String(this.__probeMethod || "GET").toUpperCase(),
          url: url,
          headers: this.__probeHeaders || null,
          body: describeBody(bytes),
          stack: stackOf(),
        });
      }
    } catch (_) {}
    return nativeXhrSend.apply(this, arguments);
  };

  // ── hook: WebSocket.prototype.send ───────────────────────────────────────
  // 挂 prototype 而不是构造函数:这样**已经建立**的连接也一并覆盖,不用刷页面。

  const nativeWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      const bytes = toBytes(data);
      if (bytes && bytesContainToken(bytes)) {
        record({
          channel: "websocket",
          url: this.url || "",
          readyState: this.readyState,
          body: describeBody(bytes),
          stack: stackOf(),
        });
      }
    } catch (_) {}
    return nativeWsSend.apply(this, arguments);
  };

  // ── 入站帧捕获（可选，用 __hermesProbe.watchInbound() 开启）──────────────
  //
  // 为什么需要它:DevTools 的 Messages 面板对二进制帧只显示**有损的文本渲染**，
  // 复制出来的字节是坏的，解不出字段号。要拿到能解析的样本必须自己取 base64。
  //
  // 与出站 hook 的区别:出站挂 `WebSocket.prototype.send`（对**已建立**的连接
  // 也生效）；入站必须在 `new WebSocket()` 时挂 message 监听，所以只能覆盖
  // **此后新建**的连接。让页面重连的最快办法:DevTools → Network → 勾上
  // Offline，几秒后取消 —— 页面自己会重连，不用刷新（刷新会把探针冲掉）。

  const nativeWebSocket = window.WebSocket;
  const inboundHits = [];
  let inboundConfig = null; // { contains: string, limit: number }

  function isHeartbeatFrame(bytes) {
    return bytes.length > 0 && bytes.length <= 4 && bytesContainAscii(bytes, "hi");
  }

  function bytesContainAscii(bytes, needle) {
    const nb = new TextEncoder().encode(needle);
    if (nb.length > bytes.length) return false;
    outer: for (let i = 0; i <= bytes.length - nb.length; i++) {
      for (let j = 0; j < nb.length; j++) {
        if (bytes[i + j] !== nb[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  function recordInbound(url, bytes) {
    if (!inboundConfig) return;
    if (isHeartbeatFrame(bytes)) return;
    if (inboundHits.length >= inboundConfig.limit) return;
    if (
      inboundConfig.contains &&
      !bytesContainAscii(bytes, inboundConfig.contains)
    ) {
      return;
    }
    const entry = {
      url: url,
      bytes: bytes.length,
      base64: bytesToBase64(bytes),
      at: new Date().toISOString(),
    };
    inboundHits.push(entry);
    console.log(
      "%c[DSH 探针] 入站帧 #" + inboundHits.length + " (" + bytes.length + " 字节)",
      "color:#fff;background:#0969da;padding:2px 6px;border-radius:3px"
    );
    console.log(entry.base64);
  }

  function HookedWebSocket(url, protocols) {
    const ws =
      protocols === undefined
        ? new nativeWebSocket(url)
        : new nativeWebSocket(url, protocols);
    try {
      ws.addEventListener("message", function (event) {
        try {
          const data = event.data;
          if (data instanceof ArrayBuffer) {
            recordInbound(url, new Uint8Array(data));
          } else if (typeof Blob !== "undefined" && data instanceof Blob) {
            data.arrayBuffer().then(function (buf) {
              recordInbound(url, new Uint8Array(buf));
            });
          } else if (typeof data === "string") {
            recordInbound(url, new TextEncoder().encode(data));
          }
        } catch (_) {}
      });
    } catch (_) {}
    return ws;
  }
  HookedWebSocket.prototype = nativeWebSocket.prototype;
  HookedWebSocket.CONNECTING = nativeWebSocket.CONNECTING;
  HookedWebSocket.OPEN = nativeWebSocket.OPEN;
  HookedWebSocket.CLOSING = nativeWebSocket.CLOSING;
  HookedWebSocket.CLOSED = nativeWebSocket.CLOSED;

  // ── hook: sendBeacon（便宜的兜底）────────────────────────────────────────

  let nativeBeacon = null;
  if (navigator.sendBeacon) {
    nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try {
        const bytes = toBytes(data);
        if (bytes && bytesContainToken(bytes)) {
          record({
            channel: "sendBeacon",
            url: String(url),
            body: describeBody(bytes),
            stack: stackOf(),
          });
        }
      } catch (_) {}
      return nativeBeacon(url, data);
    };
  }

  // ── 对外接口 ─────────────────────────────────────────────────────────────

  window.__hermesProbe = {
    __installed: true,
    token: token,
    hits: hits,
    /** 全部命中记录的 JSON（复制这个发给开发）。 */
    dump: function () {
      const json = JSON.stringify({ token: token, hits: hits }, null, 2);
      try {
        if (typeof copy === "function") {
          copy(json);
          console.log("[DSH 探针] 已复制到剪贴板(" + hits.length + " 条)");
        }
      } catch (_) {}
      return json;
    },
    /**
     * 只取「发消息」那几次请求的 base64（滤掉表情联想之类的噪音命中）。
     * 顺序即发送顺序。
     */
    sends: function () {
      return hits
        .filter(function (h) {
          return /imapi\.douyin\.com\/v1\/message\/send/.test(h.url || "");
        })
        .map(function (h) {
          return h.body && h.body.base64;
        })
        .filter(Boolean);
    },
    /**
     * 复制「发消息」请求体的 base64 数组，直接喂给
     * `scripts/inspect_frame.py --from-probe`。
     */
    dumpSends: function () {
      const arr = this.sends();
      const json = JSON.stringify(arr, null, 2);
      try {
        if (typeof copy === "function") {
          copy(json);
          console.log("[DSH 探针] 已复制 " + arr.length + " 条 send 请求体到剪贴板");
        }
      } catch (_) {}
      if (arr.length < 3) {
        console.warn(
          "[DSH 探针] 只抓到 " + arr.length + " 条 —— 需要 3 条（同一会话 2 条 + 另一会话 1 条）"
        );
      }
      return json;
    },
    inboundHits: inboundHits,
    /**
     * 开启入站帧捕获（用于取下行样本的 base64）。
     *
     * @param {object} [opts]
     * @param {string} [opts.contains] 只留正文含这段 ASCII 的帧（如让对方发
     *        "test9" 就填 "test9"）。中文不要填 —— 要在字节层匹配，用 ASCII。
     * @param {number} [opts.limit=5] 最多留几条，防刷屏。
     */
    watchInbound: function (opts) {
      opts = opts || {};
      inboundConfig = {
        contains: opts.contains || "",
        limit: opts.limit || 5,
      };
      inboundHits.length = 0;
      try {
        window.WebSocket = HookedWebSocket;
      } catch (_) {}
      console.log(
        "%c[DSH 探针] 入站捕获已开启",
        "color:#fff;background:#0969da;padding:2px 6px;border-radius:3px"
      );
      console.log(
        "入站 hook 只对**新建**的连接生效。让页面重连（不要刷新，刷新会冲掉探针）:"
      );
      console.log("  DevTools → Network → 勾上 Offline，等几秒 → 取消 Offline");
      console.log("然后让对方发一条消息，base64 会直接打印出来。");
      console.log("取结果: __hermesProbe.dumpInbound()");
    },
    /** 入站帧的 base64 列表（复制这个发给开发）。 */
    dumpInbound: function () {
      const json = JSON.stringify(inboundHits, null, 2);
      try {
        if (typeof copy === "function") {
          copy(json);
          console.log(
            "[DSH 探针] 已复制 " + inboundHits.length + " 条入站帧到剪贴板"
          );
        }
      } catch (_) {}
      return json;
    },
    /** 卸载探针,恢复原生实现。 */
    off: function () {
      try {
        if (window.fetch && window.fetch.__hermesProbe) window.fetch = nativeFetch;
      } catch (_) {}
      XMLHttpRequest.prototype.open = nativeOpen;
      XMLHttpRequest.prototype.send = nativeXhrSend;
      XMLHttpRequest.prototype.setRequestHeader = nativeSetHeader;
      WebSocket.prototype.send = nativeWsSend;
      try {
        window.WebSocket = nativeWebSocket;
      } catch (_) {}
      inboundConfig = null;
      if (nativeBeacon) navigator.sendBeacon = nativeBeacon;
      window.__hermesProbe.__installed = false;
      console.log("[DSH 探针] 已卸载");
    },
  };

  console.log(
    "%c[DSH 探针] 已安装",
    "color:#fff;background:#2ea043;padding:2px 6px;border-radius:3px"
  );
  console.log(
    "下一步:在页面里发一条消息,内容必须包含这个标记 → %c" + token,
    "font-size:16px;font-weight:bold;color:#fe2c55"
  );
  console.log('例如输入:「你好 ' + token + '」然后发送。');
  console.log("命中后执行 __hermesProbe.dump() 复制结果;__hermesProbe.off() 卸载。");
  console.log(
    "要抓**入站**帧（对方发来的）:__hermesProbe.watchInbound({contains:'test9'})"
  );
})();
