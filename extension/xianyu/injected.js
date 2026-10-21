// injected.js —— 注入页面主世界(main world)，hook 页面自己的 WebSocket。
//
// 闲鱼 PC 页面自己会连 wss://wss-goofish.dingtalk.com/。我们覆写 window.WebSocket，
// 截获 onmessage 收到的每一帧，原样 postMessage 给 content.js（隔离世界），
// 再由 content.js 经 background 转发给 DSH。
//
// 关键：我们不新建任何连接、不改请求，只“听”页面已有连接 → 指纹零变化、抗风控。
(function () {
  "use strict";

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || NativeWebSocket.__hermesHooked) {
    return;
  }

  function postFrame(payload) {
    try {
      window.postMessage(
        { __hermes_xianyu__: true, dir: "frame", payload: payload },
        "*"
      );
    } catch (e) {
      /* ignore */
    }
  }

  function HookedWebSocket(url, protocols) {
    const ws =
      protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);

    // 只关心闲鱼的消息长连接
    const isXianyuWs =
      typeof url === "string" &&
      (url.indexOf("goofish") !== -1 || url.indexOf("dingtalk") !== -1);

    if (isXianyuWs) {
      ws.addEventListener("message", function (event) {
        try {
          const data = event.data;
          if (typeof data === "string") {
            // 页面收到的就是 JSON 文本帧
            let parsed = null;
            try {
              parsed = JSON.parse(data);
            } catch (_) {
              parsed = null;
            }
            if (parsed && typeof parsed === "object") {
              postFrame(parsed);
            }
          }
          // 二进制帧暂不处理（闲鱼主消息链路为文本帧）
        } catch (e) {
          /* ignore */
        }
      });

      // hook 出站 send:捕获页面自己发出的帧里的"当前会话"(cid + 对方 id)。
      // 你在闲鱼点开会话/发消息/已读时页面都会发带 cid 的帧——据此知道你现在
      // 正在看哪个买家,发图就能直接定向到 TA,不必等买家先开口。指纹零变化:
      // 我们只读不改,原样调用 native send。
      try {
        const _nativeSend = ws.send.bind(ws);
        ws.send = function (payload) {
          try {
            if (typeof payload === "string") {
              _maybeReportCurrentChat(payload);
            }
          } catch (_) {}
          return _nativeSend(payload);
        };
      } catch (_) {}

      // 记录这个 ws 实例，供 content.js 通过页面发送消息时复用（可选）
      try {
        window.__hermes_xianyu_ws__ = ws;
      } catch (_) {}

      // 通知 content/background:页面消息长连接已成功 hook(真·"页面已接上"信号,
      // 与有没有买家消息无关)。background 用它判断"连上桥但页面没 hook → 自动刷新"。
      try {
        window.postMessage(
          { __hermes_xianyu__: true, dir: "ws_hooked" },
          "*"
        );
      } catch (_) {}
    }

    return ws;
  }

  // 从页面出站帧里抽"当前会话":cid(会话 id)+ actualReceivers 里非己方的那个
  // 就是对方买家 id。任何带这两者的帧都拿来更新"当前会话",postMessage 给
  // content.js → background → sidecar。容错:解析失败静默忽略。
  function _maybeReportCurrentChat(text) {
    if (text.indexOf("@goofish") === -1) return;
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      return;
    }
    const body = obj && obj.body;
    if (!Array.isArray(body)) return;
    let cid = "";
    let receivers = null;
    for (const seg of body) {
      if (seg && typeof seg === "object") {
        if (!cid && typeof seg.cid === "string") cid = seg.cid;
        if (!receivers && Array.isArray(seg.actualReceivers)) {
          receivers = seg.actualReceivers;
        }
      }
    }
    if (!cid) return;
    const chatId = String(cid).split("@")[0];
    if (!chatId) return;
    let buyerId = "";
    if (Array.isArray(receivers)) {
      // actualReceivers = ["买家@goofish","卖家@goofish"];卖家是自己(unb),
      // 取与本账号 unb 不同的那个为买家。
      let unb = "";
      try {
        const m = document.cookie.match(/(?:^|; )unb=([^;]*)/);
        unb = m ? decodeURIComponent(m[1]) : "";
      } catch (_) {}
      for (const r of receivers) {
        const id = String(r || "").split("@")[0];
        if (id && id !== unb) {
          buyerId = id;
          break;
        }
      }
    }
    try {
      window.postMessage(
        {
          __hermes_xianyu__: true,
          dir: "current_chat",
          chat_id: chatId,
          buyer_id: buyerId,
        },
        "*"
      );
    } catch (_) {}
  }

  HookedWebSocket.prototype = NativeWebSocket.prototype;
  HookedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  HookedWebSocket.OPEN = NativeWebSocket.OPEN;
  HookedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  HookedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  HookedWebSocket.__hermesHooked = true;

  try {
    window.WebSocket = HookedWebSocket;
  } catch (e) {
    /* 某些环境禁止覆写，忽略 */
  }

  // ── 精确定向发消息:用页面自己的 WebSocket 发 LWP 帧到指定会话 ──────────────
  // content.js(隔离世界)postMessage {dir:"send", chat_id, buyer_id, seller_id, text}
  // 上来,这里用 window.__hermes_xianyu_ws__(被 hook 时保存的页面 ws)发出去,
  // 完全复刻闲鱼网页版的 /r/MessageSend/sendByReceiverScope 帧 —— 指定 cid,
  // 不依赖"当前打开哪个窗口"。发送的是页面自己的连接,指纹零变化、抗风控。
  function _genUuid() {
    return "-" + Date.now() + "1";
  }
  function _genMid() {
    return Math.floor(1000 * Math.random()) + "" + Date.now() + " 0";
  }
  function _b64Utf8(s) {
    return btoa(unescape(encodeURIComponent(s)));
  }

  function sendTextViaWs(chatId, buyerId, sellerId, text) {
    const ws = window.__hermes_xianyu_ws__;
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    try {
      const contentJson = JSON.stringify({ contentType: 1, text: { text: text } });
      const contentB64 = _b64Utf8(contentJson);
      return _sendCustomFrame(ws, chatId, buyerId, sellerId, contentB64);
    } catch (e) {
      return false;
    }
  }

  function sendImageViaWs(chatId, buyerId, sellerId, cdnUrl, width, height) {
    const ws = window.__hermes_xianyu_ws__;
    if (!ws || ws.readyState !== 1) return false;
    try {
      const contentJson = JSON.stringify({
        contentType: 2,
        image: {
          pics: [
            {
              height: parseInt(height, 10) || 800,
              type: 0,
              url: cdnUrl,
              width: parseInt(width, 10) || 800,
            },
          ],
        },
      });
      const contentB64 = _b64Utf8(contentJson);
      return _sendCustomFrame(ws, chatId, buyerId, sellerId, contentB64);
    } catch (e) {
      return false;
    }
  }

  // 共用的 LWP sendByReceiverScope 帧封装(文本/图片只是 custom.data 不同)。
  function _sendCustomFrame(ws, chatId, buyerId, sellerId, contentB64) {
    const msg = {
      lwp: "/r/MessageSend/sendByReceiverScope",
      headers: { mid: _genMid() },
      body: [
        {
          uuid: _genUuid(),
          cid: chatId + "@goofish",
          conversationType: 1,
          content: { contentType: 101, custom: { type: 1, data: contentB64 } },
          redPointPolicy: 0,
          extension: { extJson: "{}" },
          ctx: { appVersion: "1.0", platform: "web" },
          mtags: {},
          msgReadStatusSetting: 1,
        },
        { actualReceivers: [buyerId + "@goofish", sellerId + "@goofish"] },
      ],
    };
    ws.send(JSON.stringify(msg));
    return true;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__hermes_xianyu__ !== true) return;
    if (d.dir === "send") {
      const ok = sendTextViaWs(d.chat_id, d.buyer_id, d.seller_id, d.text);
      try {
        window.postMessage(
          { __hermes_xianyu__: true, dir: "send_ack", req_id: d.req_id, ok: ok },
          "*"
        );
      } catch (_) {}
    } else if (d.dir === "send_image") {
      const ok = sendImageViaWs(
        d.chat_id, d.buyer_id, d.seller_id, d.cdn_url, d.width, d.height
      );
      try {
        window.postMessage(
          { __hermes_xianyu__: true, dir: "send_ack", req_id: d.req_id, ok: ok },
          "*"
        );
      } catch (_) {}
    }
  });

  // 简单的风控页检测：URL 含 punish/captcha 时上报
  try {
    const href = location.href || "";
    if (href.indexOf("punish") !== -1 || href.indexOf("captcha") !== -1) {
      window.postMessage(
        { __hermes_xianyu__: true, dir: "risk", detail: "出现验证/风控页: " + href },
        "*"
      );
    }
  } catch (_) {}

  // ── 用户资料：mtop.taobao.idlemessage.pc.user.query → 昵称(fishNick)+头像(logo)
  // 点开会话时页面会打这个接口。请求体里有 userId，响应 data.userInfo 有
  // fishNick / logo / nick(脱敏)。只读不改，指纹零变化。
  const USER_QUERY_RE = /mtop\.taobao\.idlemessage\.pc\.user\.query/i;

  function _extractUserIdFromBody(body) {
    try {
      let s = "";
      if (typeof body === "string") {
        s = body;
      } else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        s = body.toString();
      } else if (typeof FormData !== "undefined" && body instanceof FormData) {
        const parts = [];
        for (const [k, v] of body.entries()) {
          parts.push(k + "=" + (typeof v === "string" ? v : ""));
        }
        s = parts.join("&");
      } else {
        return "";
      }
      // data=%7B%22userId%22%3A%22...%22%7D 或 data={"userId":"..."}
      let dataStr = "";
      const m = s.match(/(?:^|&)data=([^&]*)/);
      if (m) {
        try {
          dataStr = decodeURIComponent(m[1].replace(/\+/g, " "));
        } catch (_) {
          dataStr = m[1];
        }
      } else if (s.trim().charAt(0) === "{") {
        dataStr = s;
      }
      if (!dataStr) return "";
      const obj = JSON.parse(dataStr);
      return String(
        (obj && (obj.userId || obj.user_id || obj.uid || obj.peerUserId)) || ""
      ).trim();
    } catch (_) {
      return "";
    }
  }

  function _preferNick(fishNick, nick) {
    const f = String(fishNick || "").trim();
    const n = String(nick || "").trim();
    if (f) return f;
    // 脱敏 nick(起***2)仍可作兜底，但优先 fishNick
    return n;
  }

  function reportUserQuery(buyerId, text) {
    let data;
    try {
      data = JSON.parse(text || "");
    } catch (_) {
      return;
    }
    if (!data || typeof data !== "object") return;
    const ui =
      (data.data && data.data.userInfo) ||
      data.userInfo ||
      (data.data && typeof data.data === "object" ? data.data : null);
    if (!ui || typeof ui !== "object") return;
    const uid =
      String(buyerId || "").trim() ||
      String(ui.userId || ui.user_id || ui.uid || "").trim();
    const nickname = _preferNick(ui.fishNick, ui.nick);
    const avatar = String(ui.logo || ui.avatar || ui.avatarUrl || "").trim();
    if (!uid || (!nickname && !avatar)) return;
    try {
      window.postMessage(
        {
          __hermes_xianyu__: true,
          dir: "user_info",
          users: [
            {
              uid: uid,
              nickname: nickname,
              avatar_url: avatar,
            },
          ],
        },
        "*"
      );
      try {
        console.info("[DSH闲鱼] 已捕获用户资料", uid, nickname || "(无昵称)");
      } catch (_) {}
    } catch (_) {}
  }

  function watchUserQueryXhr(xhr, buyerId) {
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
        if (text) reportUserQuery(buyerId, text);
      } catch (_) {}
    });
  }

  // 常驻一层 XHR/fetch hook，只处理 user.query，其它请求原样放行。
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && !XHR.__hermesXyUserQueryHooked) {
      const open = XHR.prototype.open;
      const send = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        try {
          this.__hermesXyUrl = String(url || "");
        } catch (_) {}
        return open.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        try {
          const url = this.__hermesXyUrl || "";
          if (USER_QUERY_RE.test(url)) {
            const buyerId = _extractUserIdFromBody(body);
            watchUserQueryXhr(this, buyerId);
          }
        } catch (_) {}
        return send.apply(this, arguments);
      };
      XHR.__hermesXyUserQueryHooked = true;
    }
  } catch (_) {}

  try {
    if (typeof window.fetch === "function" && !window.fetch.__hermesXyUserQueryHooked) {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        let url = "";
        try {
          url =
            typeof input === "string"
              ? input
              : input && input.url
                ? String(input.url)
                : "";
        } catch (_) {}
        const p = nativeFetch(input, init);
        if (!USER_QUERY_RE.test(url)) return p;
        let buyerId = "";
        try {
          const body = init && init.body;
          buyerId = _extractUserIdFromBody(body);
        } catch (_) {}
        return p.then(function (resp) {
          try {
            const clone = resp.clone();
            clone.text().then(function (text) {
              reportUserQuery(buyerId, text);
            });
          } catch (_) {}
          return resp;
        });
      };
      window.fetch.__hermesXyUserQueryHooked = true;
    }
  } catch (_) {}
})();
