// content.js —— 运行在隔离世界，桥接「页面主世界」与「background」。
//
// 职责：
// 1. 接收主世界(injected.js) postMessage 上来的原始帧 / 风控告警，转发给
//    background（injected.js 由 manifest 以 world:"MAIN" + document_start 注入，
//    确保早于页面自己建立 frontier 连接，不漏接消息）
// 2. 探测当前登录账号 + 当前打开的私信会话，上报给 Hermes
// 3. 执行 background 下发的动作指令（send_text）
//
// ⚠️ 发消息目前走 **DOM 模拟**（找输入框 → 填字 → 回车/点发送）。
// 设计稿 §12.5 PR-3 的「用页面 frontier 连接定向发帧」需要先实测确认出站帧
// 格式，未验证的东西不写进代码。DOM 路径的已知代价：只能发到**当前打开的
// 会话**，所以下面对「目标会话 ≠ 当前会话」的情况是**拒发**而不是赌一把。
(function () {
  "use strict";

  // iframe 里也要挂 message 监听（create/send 可能在子 frame），
  // 但账号探测 / 会话轮询只在顶层跑，避免 N 个 iframe × 定时 DOM 扫描把 CPU 打满。
  const IS_TOP_FRAME = window === window.top;

  // ── 与 background 通信的安全包装 ─────────────────────────────────────────
  // 扩展被重载后旧 content script 的 chrome.runtime 会失效（抛 "Extension
  // context invalidated"），这里吞掉并自动刷新本页重新接入。

  let _ctxInvalidated = false;

  function _selfReloadOnce() {
    try {
      const KEY = "__hermes_dy_reload_at";
      const last = parseInt(sessionStorage.getItem(KEY) || "0", 10) || 0;
      const now = Date.now();
      // 同一页 60s 内最多自动刷一次，防刷新风暴。
      if (now - last < 60000) return;
      sessionStorage.setItem(KEY, String(now));
      console.info("[DSH 客服] 扩展上下文失效，自动刷新本页重新接入");
      setTimeout(function () {
        try {
          location.reload();
        } catch (_) {}
      }, 800);
    } catch (_) {}
  }

  function safeSendMessage(payload) {
    if (_ctxInvalidated) return;
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        _ctxInvalidated = true;
        _selfReloadOnce();
        return;
      }
      chrome.runtime.sendMessage(payload, function () {
        const err = chrome.runtime.lastError;
        if (err && /context invalidated|Receiving end/.test(err.message || "")) {
          _ctxInvalidated = true;
          _selfReloadOnce();
        }
      });
    } catch (e) {
      _ctxInvalidated = true;
      _selfReloadOnce();
    }
  }

  // HTTP 旁路：不依赖 SW→WS。手动测见扩展 service worker 控制台，或终端 curl。
  function httpIngest(payload) {
    try {
      chrome.storage.local.get(["host", "port", "accountId"], function (s) {
        const host = s.host || "127.0.0.1";
        const port = s.port || 8766;
        const body = Object.assign(
          { account_id: s.accountId || "default" },
          payload || {}
        );
        fetch("http://" + host + ":" + port + "/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
          .then(function (r) {
            return r.json().then(function (j) {
              console.info("[DSH 客服] HTTP ingest", r.status, j);
              return j;
            });
          })
          .catch(function (e) {
            console.warn(
              "[DSH 客服] HTTP ingest 失败",
              e && e.message ? e.message : e
            );
          });
      });
    } catch (e) {
      console.warn("[DSH 客服] HTTP ingest 异常", e);
    }
  }

  // ── 一键托管：URL 携带的一次性配对码 ─────────────────────────────────────
  // 专属 Chrome 启动 URL 带 ?__hermes_pair=xxx&__hermes_port=8766，读到就播种给
  // background（存 storage + 立即连桥），免用户手填。读完从地址栏抹掉。
  (function seedPairFromUrl() {
    if (!IS_TOP_FRAME) return;
    try {
      const sp = new URLSearchParams(location.search || "");
      const pair = sp.get("__hermes_pair");
      if (!pair) return;
      const port = sp.get("__hermes_port") || "";
      safeSendMessage({
        type: "seed_pair",
        pairCode: pair,
        port: port ? parseInt(port, 10) : undefined,
      });
      try {
        sp.delete("__hermes_pair");
        sp.delete("__hermes_port");
        const qs = sp.toString();
        history.replaceState(
          null,
          "",
          location.pathname + (qs ? "?" + qs : "") + location.hash
        );
      } catch (_) {}
    } catch (_) {}
  })();

  // ── 账号探测 ─────────────────────────────────────────────────────────────
  // 只需要一个**稳定区分不同登录账号**的本地 key（多 Chrome Profile 各登一个号
  // 时不能都叫 default）。不追求"等于抖音真实 uid"——那个值 Hermes 并不使用。

  function readCookie(name) {
    const m = document.cookie.match(
      new RegExp("(?:^|; )" + name + "=([^;]*)")
    );
    return m ? decodeURIComponent(m[1]) : "";
  }

  function detectAccountId() {
    // 登录后才有的 cookie —— 比页面上的 /user/ 链接稳定得多。
    // ⚠️ 绝不能再用 document.querySelector('a[href*=MS4wLjAB]') 当账号：
    // feed 里到处是别人的主页，一点击/刷新就会换 account_id，模板全存散、
    // 状态永远对不上（真实踩过：account_id 每次查都不一样）。
    const candidates = ["uid_tt", "sid_tt", "odin_tt"];
    for (const name of candidates) {
      const v = readCookie(name);
      if (v) return "ck_" + name + "_" + String(v).slice(0, 48);
    }
    // 只有「自己的主页」唯一候选时才用 sec_uid
    const own = detectOwnSecUid();
    if (own) return own;
    return "";
  }

  /**
   * 探测**本账号自己的** sec_uid —— 自消息过滤的硬判据。
   *
   * ⚠️ 未实测确认:页面上到处都是别人的主页链接(feed 里每个作者都有),
   * 所以不能随便抓一个 `a[href*="/user/"]`。这里只认「我的主页」这类入口,
   * 且要求候选**唯一**;拿不准就返回空,宁可不报也不能报错人 —— 报错了会把
   * 客户的消息当成自己发的丢掉,那是最难查的一类 bug。
   *
   * 报不出来也不影响功能:adapter 还有两层兜底 —— 从单聊 conversation_id
   * 自举出自身 uid（`0:1:A:B` 里不是发送者的那一侧），以及回声指纹。
   */
  const OWN_PROFILE_SELECTORS = [
    '[data-e2e="user-info"] a[href*="/user/"]',
    'a[href*="/user/self"]',
    '[class*="my-profile"] a[href*="/user/"]',
    '[class*="userInfo"] a[href*="/user/"]',
  ];

  function detectOwnSecUid() {
    const found = new Set();
    for (const sel of OWN_PROFILE_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      for (const el of nodes) {
        const m = (el.getAttribute("href") || "").match(/\/user\/(MS4wLjAB[\w-]+)/);
        if (m) found.add(m[1]);
      }
    }
    // 唯一候选才敢用
    return found.size === 1 ? [...found][0] : "";
  }

  (function reportAccountId() {
    if (!IS_TOP_FRAME) return;
    let tries = 0;
    let sentAccount = false;
    let sentIdentity = false;
    function tick() {
      if (!sentAccount) {
        const id = detectAccountId();
        if (id) {
          safeSendMessage({ type: "account_detected", account_id: id });
          sentAccount = true;
        }
      }
      if (!sentIdentity) {
        const secUid = detectOwnSecUid();
        if (secUid) {
          safeSendMessage({ type: "account_identity", sec_uid: secUid });
          sentIdentity = true;
        }
      }
      if ((!sentAccount || !sentIdentity) && tries++ < 20) setTimeout(tick, 1000);
    }
    tick();
  })();

  // ── 主世界 → background ──────────────────────────────────────────────────

  // 投稿点「发布」前武装；主世界钩到 create_v2 响应后通过下面分支 resolve。
  let _pendingCreateV2 = null;

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__hermes_douyin__ !== true) return;

    if (d.dir === "frame") {
      // 附上「当前打开的会话」作为 context：Protobuf 信封里的会话/发送者字段
      // 尚未逐一实测确认，页面侧这份上下文是目前最可靠的定向依据。
      // iframe 里扫 DOM 没意义且贵；顶层也做 1s 缓存，避免每帧都 querySelector。
      const ctx = IS_TOP_FRAME ? readCurrentConversationCached() : {};
      safeSendMessage({
        type: "frame",
        raw_b64: d.raw_b64,
        context: ctx,
      });
    } else if (d.dir === "ws_hooked") {
      safeSendMessage({ type: "ws_hooked" });
    } else if (d.dir === "risk") {
      safeSendMessage({ type: "risk_alert", detail: d.detail });
    } else if (d.dir === "send_template") {
      // 页面自己发了一条 → 把请求体上报给 Hermes 当发送模板
      safeSendMessage({ type: "send_template", body_b64: d.body_b64 });
    } else if (d.dir === "create_template") {
      try {
        console.info("[DSH 客服] content←开聊模板", (d.body_b64 || "").length);
      } catch (_) {}
      safeSendMessage({ type: "create_template", body_b64: d.body_b64 });
      // 旁路：桌面 sidecar 曾漏接 create；HTTP 直达桥，方便控制台验证。
      httpIngest({ type: "create_template", body_b64: d.body_b64 });
    } else if (d.dir === "create_pair") {
      try {
        console.info(
          "[DSH 客服] content←create_pair",
          "req",
          (d.req_b64 || "").length,
          "resp",
          (d.resp_b64 || "").length
        );
      } catch (_) {}
      const pairPayload = {
        type: "create_pair",
        req_b64: d.req_b64 || "",
        resp_b64: d.resp_b64 || "",
        http_status: d.http_status || 0,
      };
      safeSendMessage(pairPayload);
      httpIngest(pairPayload);
    } else if (d.dir === "user_info") {
      const users = Array.isArray(d.users) ? d.users : [];
      if (users.length) {
        try {
          console.info("[DSH 客服] content←user_info", users.length);
        } catch (_) {}
        safeSendMessage({ type: "user_info", users: users });
      }
    } else if (d.dir === "call_api_ack") {
      const pendingApi = _pendingCallApi[d.req_id];
      if (pendingApi) {
        delete _pendingCallApi[d.req_id];
        clearTimeout(pendingApi.timer);
        pendingApi.resolve(d.data || {});
      }
    } else if (d.dir === "send_raw_ack") {
      const pending = _pendingSendRaw[d.req_id];
      if (pending) {
        delete _pendingSendRaw[d.req_id];
        clearTimeout(pending.timer);
        pending.resolve({
          ok: !!d.ok,
          error: d.error || "",
          resp_b64: d.resp_b64 || "",
        });
      }
    } else if (d.dir === "post_imapi_ack") {
      const pendingIm = _pendingPostImapi[d.req_id];
      if (pendingIm) {
        delete _pendingPostImapi[d.req_id];
        clearTimeout(pendingIm.timer);
        pendingIm.resolve({
          ok: !!d.ok,
          error: d.error || "",
          resp_b64: d.resp_b64 || "",
          http_status: d.http_status || 0,
        });
      }
    } else if (d.dir === "post_form_ack") {
      const pendingForm = _pendingPostForm[d.req_id];
      if (pendingForm) {
        delete _pendingPostForm[d.req_id];
        clearTimeout(pendingForm.timer);
        pendingForm.resolve({
          ok: !!d.ok,
          error: d.error || "",
          http_status: d.http_status || 0,
          resp_text: d.resp_text || "",
        });
      }
    } else if (d.dir === "get_json_ack") {
      const pendingGet = _pendingGetJson[d.req_id];
      if (pendingGet) {
        delete _pendingGetJson[d.req_id];
        clearTimeout(pendingGet.timer);
        pendingGet.resolve({
          ok: !!d.ok,
          error: d.error || "",
          http_status: d.http_status || 0,
          resp_text: d.resp_text || "",
        });
      }
    } else if (d.dir === "comment_baseline") {
      // 页面自己发了一条评论 → 把响应上报给 Hermes 当「正常值」基线。
      safeSendMessage({
        type: "comment_baseline",
        http_status: d.http_status || 0,
        resp_text: d.resp_text || "",
      });
    } else if (d.dir === "create_v2_result") {
      if (_pendingCreateV2) {
        const pending = _pendingCreateV2;
        _pendingCreateV2 = null;
        pending.resolve({
          http_status: d.http_status || 0,
          resp_text: d.resp_text || "",
        });
      }
    }
  });

  // ── send_raw：把字节交给主世界用页面自己的 XHR POST 出去 ────────────────
  // 必须在主世界发（带页面 cookie 与同源上下文），所以这里只做转发 + 等回执。

  const _pendingSendRaw = {};
  const _pendingCallApi = {};
  const _pendingPostForm = {};
  const _pendingGetJson = {};
  const _pendingPostImapi = {};

  /** 把一个需要返回值的指令交给主世界执行（探针开关等）。 */
  function callApiInPage(action, args) {
    return new Promise(function (resolve) {
      const reqId = "ca" + Date.now() + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(function () {
        delete _pendingCallApi[reqId];
        resolve({ error: "主世界未回执（页面可能已卸载）" });
      }, 15000);
      _pendingCallApi[reqId] = { resolve: resolve, timer: timer };
      try {
        window.postMessage(
          {
            __hermes_douyin__: true,
            dir: "call_api",
            req_id: reqId,
            action: action,
            args: args || {},
          },
          "*"
        );
      } catch (e) {
        delete _pendingCallApi[reqId];
        clearTimeout(timer);
        resolve({ error: String((e && e.message) || e) });
      }
    });
  }

  function sendRawViaPage(bodyB64) {
    return new Promise(function (resolve) {
      const reqId = "sr" + Date.now() + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(function () {
        delete _pendingSendRaw[reqId];
        resolve({ ok: false, error: "主世界未回执（页面可能已卸载）" });
      }, 18000);
      _pendingSendRaw[reqId] = { resolve: resolve, timer: timer };
      try {
        window.postMessage(
          {
            __hermes_douyin__: true,
            dir: "send_raw",
            req_id: reqId,
            body_b64: bodyB64,
          },
          "*"
        );
      } catch (e) {
        delete _pendingSendRaw[reqId];
        clearTimeout(timer);
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  /** imapi 通用 POST（conversation/create 等）。 */
  function postImapiViaPage(url, bodyB64) {
    return new Promise(function (resolve) {
      const reqId = "pi" + Date.now() + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(function () {
        delete _pendingPostImapi[reqId];
        resolve({ ok: false, error: "主世界未回执（页面可能已卸载）" });
      }, 18000);
      _pendingPostImapi[reqId] = { resolve: resolve, timer: timer };
      try {
        window.postMessage(
          {
            __hermes_douyin__: true,
            dir: "post_imapi",
            req_id: reqId,
            url: url,
            body_b64: bodyB64,
          },
          "*"
        );
      } catch (e) {
        delete _pendingPostImapi[reqId];
        clearTimeout(timer);
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  /** 把一个 form-urlencoded POST 交给主世界执行（发评论等）。 */
  function postFormViaPage(url, fields) {
    return new Promise(function (resolve) {
      const reqId = "pf" + Date.now() + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(function () {
        delete _pendingPostForm[reqId];
        resolve({ ok: false, error: "主世界未回执（页面可能已卸载）" });
      }, 18000);
      _pendingPostForm[reqId] = { resolve: resolve, timer: timer };
      try {
        window.postMessage(
          {
            __hermes_douyin__: true,
            dir: "post_form",
            req_id: reqId,
            url: url,
            fields: fields,
          },
          "*"
        );
      } catch (e) {
        delete _pendingPostForm[reqId];
        clearTimeout(timer);
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  /** 把一个 GET JSON 交给主世界执行（评论列表 / 搜索等读接口）。 */
  function getJsonViaPage(url) {
    return new Promise(function (resolve) {
      const reqId = "gj" + Date.now() + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(function () {
        delete _pendingGetJson[reqId];
        resolve({ ok: false, error: "主世界未回执（页面可能已卸载）" });
      }, 18000);
      _pendingGetJson[reqId] = { resolve: resolve, timer: timer };
      try {
        window.postMessage(
          {
            __hermes_douyin__: true,
            dir: "get_json",
            req_id: reqId,
            url: url,
          },
          "*"
        );
      } catch (e) {
        delete _pendingGetJson[reqId];
        clearTimeout(timer);
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  // ── 当前会话探测 ─────────────────────────────────────────────────────────
  // 抖音私信面板的 DOM 会改版，所以用多策略 + 属性模糊匹配，任一策略命中即用。
  // 联调时若都不灵，把真实 DOM 结构贴出来再精调选择器（这是本文件唯一需要
  // 按页面改版维护的地方）。

  const CONVERSATION_ID_ATTRS = [
    "data-conversation-id",
    "data-conversationid",
    "data-conv-id",
    "data-id",
    "data-e2e-conversation-id",
  ];

  const ACTIVE_ITEM_SELECTORS = [
    '[class*="conversation"][class*="active"]',
    '[class*="conversation"][class*="selected"]',
    '[class*="session"][class*="active"]',
    '[class*="chat-item"][class*="active"]',
    '[aria-selected="true"][class*="conversation"]',
  ];

  function readAttrId(el) {
    if (!el || !el.getAttribute) return "";
    for (const attr of CONVERSATION_ID_ATTRS) {
      const v = el.getAttribute(attr);
      if (v && String(v).trim()) return String(v).trim();
    }
    return "";
  }

  function readCurrentConversation() {
    const out = { conversation_id: "", peer_id: "" };
    try {
      for (const sel of ACTIVE_ITEM_SELECTORS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        let id = readAttrId(el);
        if (!id) {
          // 有些实现把 id 放在祖先节点上
          let p = el.parentElement;
          for (let i = 0; i < 4 && p && !id; i++) {
            id = readAttrId(p);
            p = p.parentElement;
          }
        }
        if (id) {
          out.conversation_id = id;
          break;
        }
      }
      // 对方 sec_uid：私信面板里通常有对方主页链接。
      const link = document.querySelector(
        '[class*="chat"] a[href*="/user/"], [class*="conversation"] a[href*="/user/"]'
      );
      if (link) {
        const m = (link.getAttribute("href") || "").match(/\/user\/([^/?#]+)/);
        if (m) out.peer_id = m[1];
      }
    } catch (_) {}
    return out;
  }

  // 会话变化就上报一次（节流），让 Hermes 侧知道"现在在跟谁聊"。
  let _lastReportedConv = "";
  let _cachedConv = { at: 0, ctx: {} };
  function readCurrentConversationCached() {
    const now = Date.now();
    if (now - _cachedConv.at < 1000) return _cachedConv.ctx;
    const ctx = readCurrentConversation();
    _cachedConv = { at: now, ctx: ctx };
    return ctx;
  }
  function reportCurrentChatIfChanged() {
    const ctx = readCurrentConversationCached();
    if (!ctx.conversation_id || ctx.conversation_id === _lastReportedConv) return;
    _lastReportedConv = ctx.conversation_id;
    safeSendMessage({
      type: "current_chat",
      conversation_id: ctx.conversation_id,
      peer_id: ctx.peer_id,
    });
  }
  if (IS_TOP_FRAME) {
    setInterval(reportCurrentChatIfChanged, 3000);
  }

  // ── 发消息（DOM 模拟）───────────────────────────────────────────────────

  function isVisible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        st.visibility !== "hidden" &&
        st.display !== "none"
      );
    } catch (_) {
      return false;
    }
  }

  const INPUT_SELECTORS = [
    '[class*="chat"] textarea',
    '[class*="im"] textarea',
    '[class*="message"] textarea',
    'textarea[placeholder*="消息"]',
    'textarea[placeholder*="发送"]',
    '[class*="chat"] [contenteditable="true"]',
    '[class*="im"] [contenteditable="true"]',
    'div[contenteditable="true"]',
    "textarea",
  ];

  function findInput() {
    for (const sel of INPUT_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  // React 受控组件：直接改 .value 不会触发 onChange，必须走原生 setter。
  function setNativeValue(el, value) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        desc.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    // contenteditable
    el.focus();
    el.textContent = value;
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" })
    );
  }

  function pressEnter(el) {
    const opts = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  function findSendButton() {
    const nodes = document.querySelectorAll(
      'button, [role="button"], [class*="send"]'
    );
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const label = (el.textContent || "").trim();
      if (label === "发送" || /^发\s*送$/.test(label)) return el;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 尝试切到目标会话：在会话列表里找带该 id 的条目并点一下。
  async function trySwitchConversation(conversationId) {
    if (!conversationId) return false;
    for (const attr of CONVERSATION_ID_ATTRS) {
      const el = document.querySelector(
        "[" + attr + '="' + CSS.escape(conversationId) + '"]'
      );
      if (el && isVisible(el)) {
        try {
          el.click();
        } catch (_) {
          continue;
        }
        await sleep(900);
        return readCurrentConversation().conversation_id === conversationId;
      }
    }
    return false;
  }

  async function sendText(conversationId, text, allowBlind) {
    if (!text) return { ok: false, error: "空消息" };

    // ── fail-closed:除非能**肯定**当前打开的就是目标会话，否则不发 ──────
    //
    // DOM 模拟只能发到当前打开的会话。这里的判定必须"确认成功才发"，不能
    // "没发现不一致就发"—— 后者在选择器失配（`readCurrentConversation()`
    // 返回空）时会静默地把回复发给屏幕上恰好开着的那个人，是最坏的失败模式。
    // 客服场景里发错客户比不发严重得多，所以宁可拒发并报错。
    //
    // `allowBlind`（Hermes 侧 DOUYIN_ALLOW_BLIND_SEND=1）是给单会话联调用的
    // 逃生门：明确知道只开着一个会话时才该打开。
    if (conversationId) {
      let current = readCurrentConversation().conversation_id;
      if (current !== conversationId) {
        const switched = await trySwitchConversation(conversationId);
        current = readCurrentConversation().conversation_id;
        if (!switched || current !== conversationId) {
          if (!allowBlind) {
            return {
              ok: false,
              error:
                "无法确认当前打开的会话就是目标会话(" +
                conversationId +
                "，页面侧读到的是「" +
                (current || "未识别") +
                "」)，已拒发以免发错客户。" +
                "请在页面里打开该会话；若确定只在接待一个客户，可设 " +
                "DOUYIN_ALLOW_BLIND_SEND=1 允许发往当前窗口。",
            };
          }
          console.warn(
            "[DSH 客服] 盲发模式:未能确认目标会话，按配置仍发往当前窗口"
          );
        }
      }
    }

    const input = findInput();
    if (!input) {
      return {
        ok: false,
        error: "找不到私信输入框，请确认抖音私信面板已打开并处于可输入状态",
      };
    }

    try {
      input.focus();
      setNativeValue(input, text);
      await sleep(120 + Math.floor(Math.random() * 180)); // 抖动，像真人
      pressEnter(input);
      await sleep(400);

      // 校验：输入框被清空通常意味着发出去了。没清空就试点发送按钮。
      const leftover = (input.value !== undefined ? input.value : input.textContent) || "";
      if (leftover.trim()) {
        const btn = findSendButton();
        if (btn) {
          btn.click();
          await sleep(400);
        }
      }
      const after = (input.value !== undefined ? input.value : input.textContent) || "";
      if (after.trim()) {
        return { ok: false, error: "填入了内容但未能触发发送（回车与发送按钮均无效）" };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ── background → 页面执行动作 ────────────────────────────────────────────

  // ── put_file：把本地文件送进页面的 <input type=file> ────────────────────
  //
  // 投稿要上传视频。视频几十 MB，不走「Python 转 base64 塞进 WS 消息」那条路
  // （闲鱼发品对图片是那么做的，放到视频上要在内存里过好几份几十 MB 的拷贝）。
  // 改成 Hermes 只发一个带一次性 token 的本地 URL，这里自己 fetch —— 内容脚本
  // 对 manifest host_permissions 里的域有跨域特权，所以能取 127.0.0.1。
  //
  // 取到 Blob 后用 DataTransfer 塞进 input.files（唯一能编程赋值的办法，
  // input.files 本身是只读的），再派发 change 让页面的框架感知到。
  //
  // URL 硬限定在回环地址:这个能力是「把本机文件读进页面」，允许任意 host
  // 就等于给了页面一个任意 URL 取内容的代理。
  //
  // ⚠️ 取文件必须经 background，不能在 content script 里直接 fetch(127.0.0.1)。
  // 内容脚本的 fetch 会算作页面源（https://creator.douyin.com）访问私有网络，
  // Chrome 直接 Failed to fetch。Service Worker 用扩展身份取，再把 ArrayBuffer
  // 回传过来。

  function isLoopbackUrl(u) {
    try {
      const parsed = new URL(String(u));
      if (parsed.protocol !== "http:") return false;
      return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    } catch (_) {
      return false;
    }
  }

  function fetchLocalFileViaBackground(url) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          { type: "fetch_local_file", url: url },
          function (resp) {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve({
                ok: false,
                error: "扩展后台未应答: " + (err.message || String(err)),
              });
              return;
            }
            resolve(resp || { ok: false, error: "扩展后台无回执" });
          }
        );
      } catch (e) {
        resolve({
          ok: false,
          error: "扩展上下文失效: " + String((e && e.message) || e),
        });
      }
    });
  }

  function findFileInput(selector) {
    if (selector) {
      const el = document.querySelector(selector);
      return el && el.tagName === "INPUT" && el.type === "file" ? el : null;
    }
    // 没给选择器时自己找。抖音的上传框通常是隐藏的，所以**不能**按可见性筛。
    const sels = [
      'input[type="file"][accept*="video"]',
      'input[type="file"][accept*="mp4"]',
      'input[type="file"]',
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function mimeFromFilename(name, fallback) {
    const n = String(name || "").toLowerCase();
    if (n.endsWith(".mp4") || n.endsWith(".m4v")) return "video/mp4";
    if (n.endsWith(".mov")) return "video/quicktime";
    if (n.endsWith(".webm")) return "video/webm";
    if (n.endsWith(".mkv")) return "video/x-matroska";
    if (n.endsWith(".avi")) return "video/x-msvideo";
    if (fallback && /^video\//.test(fallback)) return fallback;
    return "video/mp4";
  }

  function findDragZone(fileInput) {
    if (fileInput) {
      let p = fileInput.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        const cls = String(p.className || "");
        if (/container-drag|upload|dragger|drop/i.test(cls)) return p;
        p = p.parentElement;
      }
      if (fileInput.parentElement) return fileInput.parentElement;
    }
    const byClass = document.querySelector(
      '[class*="container-drag"], [class*="upload-drag"], [class*="dragger"]'
    );
    if (byClass) return byClass;
    // 文案兜底：拖拽区标题
    const nodes = document.querySelectorAll("div");
    for (let i = 0; i < nodes.length; i++) {
      const t = (nodes[i].textContent || "").trim();
      if (t.indexOf("拖入此区域") >= 0 || t.indexOf("点击上传") >= 0) {
        return nodes[i].closest('[class*="container-drag"]') || nodes[i];
      }
    }
    return null;
  }

  // 创作者中心上传区文案是「拖入此区域」——很多逻辑挂在 drop，不只是
  // input.change。两手都做：赋值 input + 在拖拽区派发 dragenter/dragover/drop。
  function dispatchFileDrop(target, dataTransfer) {
    if (!target || !dataTransfer) return;
    const types = ["dragenter", "dragover", "drop"];
    for (let i = 0; i < types.length; i++) {
      let ev;
      try {
        ev = new DragEvent(types[i], {
          bubbles: true,
          cancelable: true,
          dataTransfer: dataTransfer,
        });
      } catch (_) {
        ev = new Event(types[i], { bubbles: true, cancelable: true });
      }
      // 部分浏览器构造 DragEvent 时会丢掉 dataTransfer，强制挂上。
      try {
        if (!ev.dataTransfer) {
          Object.defineProperty(ev, "dataTransfer", {
            value: dataTransfer,
            configurable: true,
          });
        }
      } catch (_) {}
      try {
        target.dispatchEvent(ev);
      } catch (_) {}
    }
  }

  async function putFileIntoInput(url, filename, selector) {
    if (!isLoopbackUrl(url)) {
      return { ok: false, error: "拒绝：取文件 URL 必须是本机回环地址" };
    }
    const input = findFileInput(selector);
    if (!input) {
      return {
        ok: false,
        error: selector
          ? "页面上没有匹配 " + selector + " 的 file input"
          : "页面上找不到 file input（可能不在上传页，或上传控件还没渲染）",
      };
    }

    const fetched = await fetchLocalFileViaBackground(url);
    if (!fetched || !fetched.ok) {
      return {
        ok: false,
        error: "取文件失败：" + ((fetched && fetched.error) || "未知错误"),
      };
    }
    if (!fetched.buffer || !fetched.size) {
      return { ok: false, error: "取到的文件是空的" };
    }

    const fname = String(filename || "upload.mp4");
    const mime = mimeFromFilename(fname, fetched.content_type);
    let blob;
    try {
      blob = new Blob([fetched.buffer], { type: mime });
    } catch (e) {
      return {
        ok: false,
        error: "构造 Blob 失败：" + String((e && e.message) || e),
      };
    }

    let file;
    let dt;
    try {
      file = new File([blob], fname, { type: mime });
      dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      try {
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (_) {}
      try {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_) {}
      // 拖拽区 drop：页面文案就是「拖入此区域」，只派 change 经常没人听。
      const zone = findDragZone(input);
      dispatchFileDrop(zone || input, dt);
      if (zone && zone !== input) {
        dispatchFileDrop(input, dt);
      }
    } catch (e) {
      return {
        ok: false,
        error: "填入 file input 失败：" + String((e && e.message) || e),
      };
    }

    // 只确认「文件已交给页面」。**不**声称上传成功 —— 转码/校验是后续异步过程，
    // 由调用方另行判定（判定要严，见 skill 第 4 步）。
    if (!input.files || input.files.length === 0) {
      return { ok: false, error: "赋值后 input.files 仍为空，页面可能重置了它" };
    }
    return {
      ok: true,
      error: "",
      detail: {
        file_size: fetched.size,
        file_type: mime,
        accepted_name: input.files[0].name,
        drop_dispatched: true,
      },
    };
  }

  // ── publish_prepare：上传 → 填表 →（可选）点发布 ──────────────────────
  //
  // 页面事实（2026-08 侦察）:
  // - upload 页用 CDP setFileInputFiles 塞本地路径（脚本 change/drop 不认）。
  // - 传完进 /content/post/video；标题 input[placeholder*="填写作品标题"]。
  // - 作品描述：作品描述区 slate contenteditable（create_v2.caption）。
  // - 封面：点「选择封面」→ 弹层里上传本地图（cover_local_path，CDP 塞图）。
  //   选哪张图由 Hermes/agent 决定，不点「Ai智能推荐」缩略图。
  // - 「谁可以看」：公开=0 / 好友可见=2 / 仅自己可见=1（必须限定该 section）。
  // - submit=false（默认）：填完停在编辑页，不点「发布」（测试阶段）。
  // - submit=true：点「发布」；成功优先 create_v2，辅证 manage?enter_from=publish。
  // - 合集：添加合集 → .select-collection-* → 选项「不选择合集」或合集名。
  // - 自主声明：请选择自主声明 → 弹层单选 → 确定。
  // - 热点：关联热点 → filterable select；list_hotspots 刮列表，publish.hotspot 点选。

  const TITLE_MAX_CHARS = 30;
  const DESC_MAX_CHARS = 1000;
  const UPLOAD_WAIT_MS = 180000;
  const PUBLISH_SUCCESS_WAIT_MS = 90000;
  const COVER_WAIT_MS = 45000;

  const VISIBILITY_OPTS = {
    only_self: { label: "仅自己可见", value: "1" },
    friends: { label: "好友可见", value: "2" },
    public: { label: "公开", value: "0" },
  };

  // declaration 入参 → 弹层 radio 文案
  const DECLARATION_OPTS = {
    none: "无需添加自主声明",
    ai: "内容由AI生成",
    opinion: "内容为个人观点或见解",
    repost: "内容为转载信息",
    marketing: "内容含营销推广信息",
    fiction: "虚构演绎，仅供娱乐",
  };

  function _pubSleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function _setNativeValue(el, value) {
    try {
      const proto =
        el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (_) {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function _clickByText(texts) {
    const want = texts.map(function (t) {
      return String(t).trim();
    });
    const nodes = document.querySelectorAll("div, span, button, a");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const t = (el.textContent || "").trim();
      if (want.indexOf(t) < 0) continue;
      try {
        el.click();
        return true;
      } catch (_) {}
    }
    return false;
  }

  function findTitleInput() {
    const sels = [
      'input[placeholder*="填写作品标题"]',
      'input[placeholder*="作品标题"]',
      "input.semi-input.semi-input-default",
    ];
    for (let i = 0; i < sels.length; i++) {
      const el = document.querySelector(sels[i]);
      if (el && el.tagName === "INPUT") return el;
    }
    return null;
  }

  function isEditPage() {
    try {
      return /\/content\/post\/video/.test(location.pathname || "");
    } catch (_) {
      return false;
    }
  }

  function isUploadPage() {
    try {
      return /\/content\/upload/.test(location.pathname || "");
    } catch (_) {
      return false;
    }
  }

  function pageLooksLikeUploadIdle() {
    const body = (document.body && document.body.innerText) || "";
    return (
      body.indexOf("拖入此区域") >= 0 ||
      body.indexOf("点击上传 或直接将视频文件拖入") >= 0
    );
  }

  function detectUploadErrorText() {
    const body = (document.body && document.body.innerText) || "";
    const patterns = [
      /上传失败[^\n]{0,40}/,
      /格式不支持[^\n]{0,40}/,
      /文件过大[^\n]{0,40}/,
      /请重新上传[^\n]{0,40}/,
      /网络异常[^\n]{0,40}/,
      /上传出错[^\n]{0,40}/,
    ];
    for (let i = 0; i < patterns.length; i++) {
      const m = body.match(patterns[i]);
      if (m) return m[0];
    }
    return "";
  }

  function detectUploadProgress() {
    const body = (document.body && document.body.innerText) || "";
    if (/上传中|转码中|处理中|正在上传/.test(body)) return true;
    if (/\d{1,3}\s*%/.test(body) && !pageLooksLikeUploadIdle()) return true;
    return false;
  }

  // 等编辑页标题框；顺带认「上传中 / 失败 / 一直停在拖拽区」。
  // 页面流程：选文件 →（异步）传到 CDN → 成功才进 post/video。
  async function waitForTitleInput(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const started = Date.now();
    let sawProgress = false;
    while (Date.now() < deadline) {
      if (isEditPage()) {
        const el = findTitleInput();
        if (el) return { ok: true, el: el };
      }
      const el2 = findTitleInput();
      if (el2) return { ok: true, el: el2 };

      const err = detectUploadErrorText();
      if (err) {
        return { ok: false, error: "页面提示：" + err };
      }
      if (detectUploadProgress()) sawProgress = true;

      // 45s 仍停在「拖入此区域」且从没出现过进度 → 页面根本没接住文件。
      if (
        !sawProgress &&
        Date.now() - started > 45000 &&
        isUploadPage() &&
        pageLooksLikeUploadIdle()
      ) {
        return {
          ok: false,
          error:
            "页面仍停留在拖拽上传区，没有出现上传进度 —— 上传未被页面接住。" +
            " 当前 URL: " +
            (location.href || ""),
        };
      }
      await _pubSleep(500);
    }
    return {
      ok: false,
      error:
        "等了 " +
        Math.round(timeoutMs / 1000) +
        " 秒仍无标题框。" +
        (sawProgress
          ? "曾出现上传进度，但未进入编辑页（转码/审核卡住？）。"
          : "始终没有上传进度。") +
        " 当前 URL: " +
        (location.href || ""),
      saw_progress: sawProgress,
    };
  }

  async function waitForVideoFileInput(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = findFileInput('input[type="file"][accept*="video"]');
      if (el) return el;
      const any = findFileInput("");
      if (any) return any;
      await _pubSleep(300);
    }
    return null;
  }

  function setLocalFileViaDebugger(localPath, selector) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          {
            type: "set_file_input_path",
            path: localPath,
            selector: selector || 'input[type="file"][accept*="video"]',
          },
          function (resp) {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve({
                ok: false,
                error: "扩展后台未应答: " + (err.message || String(err)),
              });
              return;
            }
            resolve(resp || { ok: false, error: "扩展后台无回执" });
          }
        );
      } catch (e) {
        resolve({
          ok: false,
          error: "扩展上下文失效: " + String((e && e.message) || e),
        });
      }
    });
  }

  function _sendBg(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({
              ok: false,
              error: "扩展后台未应答: " + (err.message || String(err)),
            });
            return;
          }
          resolve(resp || { ok: false, error: "扩展后台无回执" });
        });
      } catch (e) {
        resolve({
          ok: false,
          error: "扩展上下文失效: " + String((e && e.message) || e),
        });
      }
    });
  }

  function clickCoverUploadEntry() {
    // 只点外层「上传封面」，避开 .image-uploader 裁剪层
    const sels = [
      ".upload-ZOJTUA .upload-tips-KomyJM .text-zsBQsb",
      ".upload-ZOJTUA .upload-tips-KomyJM",
      ".upload-tips-KomyJM .text-zsBQsb",
      ".upload-tips-KomyJM",
      ".upload-ZOJTUA .semi-upload-drag-area",
      ".semi-upload-drag-area",
    ];
    for (let i = 0; i < sels.length; i++) {
      const el = document.querySelector(sels[i]);
      if (!el) continue;
      if (el.closest && el.closest(".image-uploader")) continue;
      try {
        el.scrollIntoView({ block: "center" });
      } catch (_) {}
      try {
        el.click();
        return { ok: true, clicked: sels[i] };
      } catch (e) {
        return {
          ok: false,
          error: "点击上传入口失败：" + String((e && e.message) || e),
        };
      }
    }
    return { ok: false, error: "找不到「上传封面」入口" };
  }

  // 两阶段：后台先拦截 fileChooser → content 点上传 → 后台填路径。
  // 比单靠 Runtime.evaluate 点击更稳（页面自己的 click 处理器会开选框）。
  async function setLocalFileViaChooser(localPath) {
    const arm = await _sendBg({ type: "arm_file_chooser" });
    if (!arm || !arm.ok) {
      return {
        ok: false,
        error: (arm && arm.error) || "arm_file_chooser 失败",
      };
    }
    await _pubSleep(80);
    const clicked = clickCoverUploadEntry();
    if (!clicked.ok) {
      await _sendBg({ type: "cancel_file_chooser" });
      return clicked;
    }
    const fin = await _sendBg({
      type: "finish_file_chooser",
      path: localPath,
    });
    if (fin && fin.ok) {
      fin.clicked = clicked.clicked;
      fin.method = "cdp_file_chooser";
    }
    return fin || { ok: false, error: "finish_file_chooser 无回执" };
  }

  function findSectionByTitle(title) {
    const want = String(title || "").trim();
    if (!want) return null;
    const nodes = document.querySelectorAll(
      ".title-content-oaqcSp, .title-dS7kae, .title-bu2hyo, .title-cnbkZe"
    );
    for (let i = 0; i < nodes.length; i++) {
      const t = (nodes[i].textContent || "").replace(/\s+/g, "");
      if (t.indexOf(want.replace(/\s+/g, "")) < 0) continue;
      return (
        nodes[i].closest(".content-obt4oA") ||
        nodes[i].closest('[class*="content-obt"]') ||
        nodes[i].parentElement
      );
    }
    return null;
  }

  function setVisibility(mode) {
    // 必须限定在「谁可以看」里：value=0/1/2 在「保存权限/定时发布」里也有。
    const key = VISIBILITY_OPTS[mode] ? mode : "only_self";
    const opt = VISIBILITY_OPTS[key];
    const section = findSectionByTitle("谁可以看");
    const root = section || document;
    const labels = root.querySelectorAll("label");
    for (let i = 0; i < labels.length; i++) {
      const lab = labels[i];
      const text = (lab.textContent || "").replace(/\s+/g, "");
      // 「公开」要避免误匹配其它含「公开」的文案；页面 label 就是「公开」。
      let match = false;
      if (key === "public") {
        match = text === "公开" || text.indexOf("公开可见") >= 0;
      } else {
        match = text.indexOf(opt.label.replace(/\s+/g, "")) >= 0;
      }
      if (!match) continue;
      try {
        lab.scrollIntoView({ block: "center" });
      } catch (_) {}
      try {
        lab.click();
      } catch (_) {}
      const input =
        lab.querySelector('input[value="' + opt.value + '"]') ||
        lab.querySelector("input");
      const checked =
        (input && input.checked) || lab.getAttribute("data-checked") === "true";
      return {
        ok: true,
        detail: {
          visibility: key,
          visibility_value: opt.value,
          visibility_checked: !!checked,
        },
      };
    }
    return {
      ok: false,
      error: "找不到「谁可以看 → " + opt.label + "」选项",
    };
  }

  function resolveCollectionWant(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return { skip: true, label: "" };
    const low = s.toLowerCase();
    if (
      low === "none" ||
      low === "skip" ||
      low === "null" ||
      s === "不选择合集" ||
      s === "无" ||
      s === "不选"
    ) {
      return { skip: false, label: "不选择合集" };
    }
    return { skip: false, label: s };
  }

  function listVisibleSelectOptions() {
    // Semi 下拉常挂 body；取当前可见 option
    const nodes = document.querySelectorAll(
      ".semi-select-option, [role=\"option\"], .semi-popover .semi-select-option"
    );
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      try {
        const st = window.getComputedStyle(el);
        if (st && (st.display === "none" || st.visibility === "hidden")) continue;
      } catch (_) {}
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t) out.push({ el: el, text: t });
    }
    return out;
  }

  async function setCollection(raw) {
    const want = resolveCollectionWant(raw);
    if (want.skip) {
      return { ok: true, detail: { collection: "", collection_skipped: true } };
    }

    const section =
      findSectionByTitle("添加合集") || findSectionByTitle("合集");
    const root = section || document;
    const select =
      root.querySelector(".select-collection-nkL6sA") ||
      root.querySelector('[class*="select-collection"]') ||
      root.querySelector(".mix-sel-wrap-X7ee1N .semi-select:last-child") ||
      root.querySelector(".sel-area-uXj3oO .semi-select:nth-child(2)");
    if (!select) {
      return { ok: false, error: "找不到「添加合集」下拉框" };
    }
    try {
      select.scrollIntoView({ block: "center" });
    } catch (_) {}
    try {
      select.click();
    } catch (e) {
      return {
        ok: false,
        error: "打开合集下拉失败：" + String((e && e.message) || e),
      };
    }
    await _pubSleep(350);

    const wantNorm = want.label.replace(/\s+/g, "");
    const noneNorm = "不选择合集";

    function dismissCollectionDropdown() {
      // 无合集时「不选择合集」往往点不到；点空白 / Esc 关掉下拉即可
      try {
        document.body.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true })
        );
        document.body.click();
      } catch (_) {}
      try {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            bubbles: true,
          })
        );
      } catch (_) {}
    }

    let options = listVisibleSelectOptions();
    let deadline = Date.now() + 4000;
    while (!options.length && Date.now() < deadline) {
      await _pubSleep(200);
      options = listVisibleSelectOptions();
    }
    if (!options.length) {
      dismissCollectionDropdown();
      await _pubSleep(200);
      return {
        ok: true,
        detail: {
          collection: "",
          collection_selected: "",
          collection_fallback: true,
          warning: "合集下拉无选项，已点空白关闭（不选择合集）",
        },
      };
    }

    function findOption(norm) {
      for (let i = 0; i < options.length; i++) {
        const t = options[i].text.replace(/\s+/g, "");
        if (t === norm || t.indexOf(norm) >= 0) return options[i];
      }
      return null;
    }

    // 显式只要「不选择合集」：有可点项才点；否则点空白关闭
    if (wantNorm === noneNorm) {
      const noneHit = findOption(noneNorm);
      if (noneHit) {
        try {
          noneHit.el.click();
        } catch (e) {
          dismissCollectionDropdown();
          return {
            ok: false,
            error: "点击「不选择合集」失败：" + String((e && e.message) || e),
          };
        }
        await _pubSleep(300);
        return {
          ok: true,
          detail: {
            collection: "不选择合集",
            collection_selected: noneHit.text,
          },
        };
      }
      dismissCollectionDropdown();
      await _pubSleep(200);
      return {
        ok: true,
        detail: {
          collection: "",
          collection_selected: "",
          collection_fallback: true,
          warning: "无「不选择合集」可点项，已点空白关闭下拉",
        },
      };
    }

    let hit = findOption(wantNorm);
    if (!hit) {
      // 账号没有该合集：不要硬点「不选择合集」（常点不到），点空白关掉
      dismissCollectionDropdown();
      await _pubSleep(200);
      return {
        ok: true,
        detail: {
          collection: "",
          collection_selected: "",
          collection_fallback: true,
          collection_requested: want.label,
          warning:
            "账号没有合集「" + want.label + "」，已点空白关闭下拉（不选择合集）",
          collection_options: options
            .map(function (o) {
              return o.text;
            })
            .slice(0, 12),
        },
      };
    }
    try {
      hit.el.click();
    } catch (e) {
      return {
        ok: false,
        error: "点击合集选项失败：" + String((e && e.message) || e),
      };
    }
    await _pubSleep(300);
    return {
      ok: true,
      detail: {
        collection: want.label,
        collection_selected: hit.text,
      },
    };
  }

  function resolveDeclarationLabel(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return { skip: true, label: "", key: "" };
    const low = s.toLowerCase().replace(/\s+/g, "");
    const aliases = {
      none: "none",
      skip: "none",
      "无需添加自主声明": "none",
      "无需声明": "none",
      "不声明": "none",
      ai: "ai",
      "内容由ai生成": "ai",
      "ai生成": "ai",
      opinion: "opinion",
      "内容为个人观点或见解": "opinion",
      "个人观点": "opinion",
      repost: "repost",
      "内容为转载信息": "repost",
      "转载": "repost",
      marketing: "marketing",
      "内容含营销推广信息": "marketing",
      "营销": "marketing",
      fiction: "fiction",
      "虚构演绎，仅供娱乐": "fiction",
      "虚构演绎": "fiction",
      "仅供娱乐": "fiction",
    };
    const key = aliases[low] || aliases[s] || "";
    if (key && DECLARATION_OPTS[key]) {
      return { skip: false, label: DECLARATION_OPTS[key], key: key };
    }
    // 允许直接传完整中文文案
    const keys = Object.keys(DECLARATION_OPTS);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (
        DECLARATION_OPTS[k] === s ||
        DECLARATION_OPTS[k].replace(/\s+/g, "") === low
      ) {
        return { skip: false, label: DECLARATION_OPTS[k], key: k };
      }
    }
    return {
      skip: false,
      error:
        "declaration 无效（" +
        s +
        "），允许: none / ai / opinion / repost / marketing / fiction",
    };
  }

  async function setDeclaration(raw) {
    const want = resolveDeclarationLabel(raw);
    if (want.skip) {
      return {
        ok: true,
        detail: { declaration: "", declaration_skipped: true },
      };
    }
    if (want.error) {
      return { ok: false, error: want.error };
    }

    const section =
      findSectionByTitle("自主声明") ||
      findSectionByTitle("添加声明") ||
      document;
    const opener =
      section.querySelector(".selectBox-buZRzi") ||
      section.querySelector(".selectText-XSrMFZ") ||
      section.querySelector('[class*="selectBox"]') ||
      section.querySelector('[class*="selectText"]');
    // 文案兜底
    let target = opener;
    if (!target) {
      const nodes = section.querySelectorAll("div, span");
      for (let i = 0; i < nodes.length; i++) {
        const t = (nodes[i].textContent || "").replace(/\s+/g, "");
        if (t.indexOf("请选择自主声明") >= 0 || t === "自主声明") {
          target = nodes[i];
          break;
        }
      }
    }
    if (!target) {
      return { ok: false, error: "找不到「请选择自主声明」入口" };
    }
    try {
      target.scrollIntoView({ block: "center" });
    } catch (_) {}
    try {
      target.click();
    } catch (e) {
      return {
        ok: false,
        error: "打开自主声明失败：" + String((e && e.message) || e),
      };
    }

    // 等弹层
    let modal = null;
    let deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      modal =
        document.querySelector(".semi-modal-body .selectorWrapper-jLswM6") ||
        document.querySelector(".semi-modal-body") ||
        document.querySelector(".semi-modal-content");
      if (
        modal &&
        ((modal.textContent || "").indexOf("请选择声明类型") >= 0 ||
          (modal.textContent || "").indexOf("对作品内容添加声明") >= 0)
      ) {
        break;
      }
      modal = null;
      await _pubSleep(200);
    }
    if (!modal) {
      return { ok: false, error: "自主声明弹层未出现" };
    }

    const wantNorm = want.label.replace(/\s+/g, "");
    const labels = modal.querySelectorAll("label.semi-radio, label");
    let radioLab = null;
    for (let i = 0; i < labels.length; i++) {
      const t = (labels[i].textContent || "").replace(/\s+/g, "");
      if (t.indexOf(wantNorm) >= 0 || t === wantNorm) {
        radioLab = labels[i];
        break;
      }
    }
    if (!radioLab) {
      // 关掉弹层
      const cancelBtns = modal.querySelectorAll("button");
      for (let i = 0; i < cancelBtns.length; i++) {
        if ((cancelBtns[i].textContent || "").replace(/\s+/g, "") === "取消") {
          try {
            cancelBtns[i].click();
          } catch (_) {}
          break;
        }
      }
      return {
        ok: false,
        error: "自主声明弹层里没有「" + want.label + "」",
      };
    }
    try {
      radioLab.click();
    } catch (e) {
      return {
        ok: false,
        error: "点选声明失败：" + String((e && e.message) || e),
      };
    }
    await _pubSleep(250);

    // 点「确定」（选完后 disabled 会去掉）
    deadline = Date.now() + 5000;
    let confirmed = false;
    while (Date.now() < deadline) {
      const footer =
        document.querySelector(".btnWrapper-LtGF4z") ||
        document.querySelector(".semi-modal-footer") ||
        document.querySelector(".semi-modal-content");
      const buttons = (footer || document).querySelectorAll("button");
      for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        const t = (b.textContent || "").replace(/\s+/g, "");
        if (t !== "确定") continue;
        if (b.disabled || b.getAttribute("disabled") != null) continue;
        if ((b.className || "").indexOf("semi-button-disabled") >= 0) continue;
        try {
          b.click();
          confirmed = true;
          break;
        } catch (_) {}
      }
      if (confirmed) break;
      await _pubSleep(200);
    }
    if (!confirmed) {
      return {
        ok: false,
        error: "已选「" + want.label + "」但「确定」不可点或点不到",
      };
    }
    await _pubSleep(350);
    return {
      ok: true,
      detail: {
        declaration: want.key,
        declaration_label: want.label,
      },
    };
  }

  function dismissHotspotDropdown() {
    try {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      document.body.click();
    } catch (_) {}
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          bubbles: true,
        })
      );
    } catch (_) {}
  }

  function findHotspotSelectRoot() {
    const section = findSectionByTitle("关联热点");
    const root = section || document;
    return (
      root.querySelector(".semi-select-filterable") ||
      root.querySelector('.semi-select[style*="width"]') ||
      root.querySelector(".semi-select")
    );
  }

  function findHotspotFilterInput() {
    // Semi filterable：打开后 input 可能在 selection 内或 portal 里
    const candidates = document.querySelectorAll(
      ".semi-select-filterable input, .semi-select-selection input, .semi-popover input, input.semi-input-default"
    );
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      try {
        const st = window.getComputedStyle(el);
        if (st && (st.display === "none" || st.visibility === "hidden")) continue;
      } catch (_) {}
      if (el.offsetParent == null && el.getClientRects().length === 0) continue;
      return el;
    }
    return null;
  }

  async function openHotspotSelect() {
    const select = findHotspotSelectRoot();
    if (!select) {
      return { ok: false, error: "找不到「关联热点」下拉（需在投稿编辑页）" };
    }
    try {
      select.scrollIntoView({ block: "center" });
    } catch (_) {}
    try {
      select.click();
    } catch (e) {
      return {
        ok: false,
        error: "打开热点下拉失败：" + String((e && e.message) || e),
      };
    }
    await _pubSleep(400);
    return { ok: true };
  }

  function scrapeHotspotOptions(limit) {
    const max = limit || 60;
    const nodes = document.querySelectorAll(
      ".semi-select-option-list .semi-select-option, .semi-select-option[role=\"option\"]"
    );
    const out = [];
    const seen = {};
    for (let i = 0; i < nodes.length && out.length < max; i++) {
      const el = nodes[i];
      try {
        const st = window.getComputedStyle(el);
        if (st && (st.display === "none" || st.visibility === "hidden")) continue;
      } catch (_) {}
      const wordEl = el.querySelector(".select-word");
      const countEl = el.querySelector(".hot-count");
      const word = wordEl
        ? (wordEl.textContent || "").replace(/\s+/g, " ").trim()
        : "";
      if (!word || seen[word]) continue;
      seen[word] = true;
      out.push({
        word: word,
        hot_count: countEl
          ? (countEl.textContent || "").replace(/\s+/g, " ").trim()
          : "",
        el: el,
      });
    }
    return out;
  }

  async function typeHotspotFilter(query) {
    const q = String(query || "").trim();
    if (!q) return;
    let input = findHotspotFilterInput();
    if (!input) {
      // 再点一次 selection 以聚焦 filter
      const sel = findHotspotSelectRoot();
      if (sel) {
        try {
          sel.click();
        } catch (_) {}
        await _pubSleep(200);
      }
      input = findHotspotFilterInput();
    }
    if (!input) return;
    try {
      input.focus();
      _setNativeValue(input, q);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
    await _pubSleep(400);
  }

  async function listHotspots(query) {
    if (!isEditPage() && !findHotspotSelectRoot()) {
      return {
        ok: false,
        error:
          "当前不在投稿编辑页，无法列出热点。请先 douyin_publish（submit=false）进入编辑页后再 list。",
      };
    }
    const opened = await openHotspotSelect();
    if (!opened.ok) return opened;

    const q = String(query || "").trim();
    if (q) await typeHotspotFilter(q);

    let options = scrapeHotspotOptions(60);
    let deadline = Date.now() + 5000;
    while (!options.length && Date.now() < deadline) {
      await _pubSleep(250);
      options = scrapeHotspotOptions(60);
    }

    dismissHotspotDropdown();
    await _pubSleep(200);

    const hotspots = options.map(function (o) {
      return { word: o.word, hot_count: o.hot_count };
    });
    return {
      ok: true,
      error: "",
      detail: {
        hotspots: hotspots,
        count: hotspots.length,
        query: q,
      },
    };
  }

  async function setHotspot(raw) {
    const word = String(raw == null ? "" : raw).trim();
    if (!word) {
      return { ok: true, detail: { hotspot: "", hotspot_skipped: true } };
    }
    const low = word.toLowerCase();
    if (low === "none" || low === "skip" || word === "不关联" || word === "无") {
      dismissHotspotDropdown();
      return {
        ok: true,
        detail: {
          hotspot: "",
          hotspot_skipped: true,
          warning: "hotspot=none，已跳过关联热点",
        },
      };
    }

    const opened = await openHotspotSelect();
    if (!opened.ok) return opened;

    // 先输入关键词过滤（过长则用前缀）
    const filterQ = word.length > 12 ? word.slice(0, 12) : word;
    await typeHotspotFilter(filterQ);

    let options = scrapeHotspotOptions(80);
    let deadline = Date.now() + 5000;
    while (!options.length && Date.now() < deadline) {
      await _pubSleep(250);
      options = scrapeHotspotOptions(80);
    }

    const wantNorm = word.replace(/\s+/g, "");
    let hit = null;
    for (let i = 0; i < options.length; i++) {
      const t = options[i].word.replace(/\s+/g, "");
      if (t === wantNorm || t.indexOf(wantNorm) >= 0 || wantNorm.indexOf(t) >= 0) {
        hit = options[i];
        break;
      }
    }
    if (!hit) {
      dismissHotspotDropdown();
      await _pubSleep(200);
      return {
        ok: true,
        detail: {
          hotspot: "",
          hotspot_requested: word,
          hotspot_fallback: true,
          warning: "热点列表没有「" + word + "」，已点空白关闭（不关联）",
          hotspot_options: options
            .map(function (o) {
              return o.word;
            })
            .slice(0, 15),
        },
      };
    }
    try {
      hit.el.click();
    } catch (e) {
      dismissHotspotDropdown();
      return {
        ok: false,
        error: "点击热点失败：" + String((e && e.message) || e),
      };
    }
    await _pubSleep(300);
    return {
      ok: true,
      detail: {
        hotspot: hit.word,
        hotspot_selected: hit.word,
        hotspot_count: hit.hot_count || "",
      },
    };
  }

  function findDescriptionEditor() {
    const section = findSectionByTitle("作品描述");
    const root = section || document;
    return (
      root.querySelector(
        '[data-slate-editor="true"][contenteditable="true"]'
      ) ||
      root.querySelector(
        ".editor-comp-publish [contenteditable=\"true\"]"
      ) ||
      root.querySelector('.zone-container[contenteditable="true"]')
    );
  }

  function fillDescription(descText) {
    const text = String(descText || "");
    if (!text) {
      return { ok: true, detail: { description_written: "" } };
    }
    if (text.length > DESC_MAX_CHARS) {
      return {
        ok: false,
        error:
          "作品描述超过 " +
          DESC_MAX_CHARS +
          " 字（当前 " +
          text.length +
          "）",
      };
    }
    const el = findDescriptionEditor();
    if (!el) {
      return { ok: false, error: "找不到作品描述编辑框" };
    }
    try {
      el.focus();
      try {
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);
      } catch (_) {
        el.textContent = text;
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: text,
          })
        );
      }
    } catch (e) {
      return {
        ok: false,
        error: "填作品描述失败：" + String((e && e.message) || e),
      };
    }
    const got = (el.textContent || "").replace(/\u200b/g, "").trim();
    // Slate 回读不一定完全一致；有内容且以目标开头就算写入成功。
    if (!got || got.indexOf(text.slice(0, Math.min(12, text.length))) < 0) {
      return {
        ok: false,
        error:
          "作品描述写入后回读不像期望（期望前缀 " +
          JSON.stringify(text.slice(0, 12)) +
          "，实际 " +
          JSON.stringify(got.slice(0, 40)) +
          "）",
        detail: { description_written: got },
      };
    }
    return {
      ok: true,
      detail: { description_written: text },
    };
  }

  function clickSelectCoverButton(orientation) {
    // 竖封面3:4 / 横封面4:3。入口文案可能是「选择封面」或已有图后的「编辑封面」。
    const want =
      orientation === "horizontal" || orientation === "landscape"
        ? "横封面"
        : "竖封面";
    const section = findSectionByTitle("设置封面");
    const root = section || document;
    const tips = root.querySelectorAll(
      ".cover-tip-YkBvmu, [class*=\"cover-tip\"]"
    );
    for (let i = 0; i < tips.length; i++) {
      const tipText = (tips[i].textContent || "").replace(/\s+/g, "");
      if (tipText.indexOf(want) < 0) continue;
      const control =
        tips[i].closest(".coverControl-CjlzqC") ||
        tips[i].closest('[class*="coverControl"]') ||
        tips[i].parentElement;
      if (!control) continue;
      const btn =
        control.querySelector(".title-wA45Xd") ||
        control.querySelector(".cover-Jg3T4p") ||
        control.querySelector('[class*="cover-Jg"]');
      const target = btn || control;
      try {
        target.scrollIntoView({ block: "center" });
      } catch (_) {}
      try {
        target.click();
        return { ok: true, orientation: want };
      } catch (e) {
        return {
          ok: false,
          error: "点击封面入口失败：" + String((e && e.message) || e),
        };
      }
    }
    // 兜底：区块里「选择封面 / 编辑封面」
    const nodes = root.querySelectorAll(".title-wA45Xd, div, span");
    for (let i = 0; i < nodes.length; i++) {
      const t = (nodes[i].textContent || "").replace(/\s+/g, "");
      if (t !== "选择封面" && t !== "编辑封面") continue;
      try {
        nodes[i].click();
        return { ok: true, orientation: want, fallback: true };
      } catch (_) {}
    }
    return {
      ok: false,
      error: "找不到「设置封面 → " + want + " → 选择/编辑封面」",
    };
  }

  // 自定义封面（2026-08 实测正确流程，串行，不要在向导里同时切横/竖）：
  //   1) 点竖封面「选择/编辑封面」打开编辑器
  //   2) 点「上传封面」走系统选文件（与手动同路径）→ 底栏「取消 + 完成」→「完成」
  //   3) 回到编辑页，再点横封面预览/编辑
  //   4) 再上传 → 再点「完成」
  //
  // 重要：手动不会出现 .image-uploader「设置封面+保存」裁剪弹层。
  // 直塞 file input / 点到裁剪层里的 upload-btn 才会误进那条路 —— 要避免。

  function findCoverCropModal() {
    return (
      document.querySelector(".semi-modal-body .image-uploader") ||
      document.querySelector(".image-uploader") ||
      null
    );
  }

  function dismissCoverCropModal() {
    const crop = findCoverCropModal();
    if (!crop) return { ok: true, skipped: true };
    const area =
      crop.querySelector(".btn-area-yY4w20, [class*=\"btn-area\"]") || crop;
    const buttons = area.querySelectorAll("button");
    for (let i = 0; i < buttons.length; i++) {
      const t = (buttons[i].textContent || "").replace(/\s+/g, "");
      if (t !== "取消") continue;
      try {
        buttons[i].click();
        return { ok: true, clicked: "取消" };
      } catch (e) {
        return {
          ok: false,
          error: "关闭误入裁剪层失败：" + String((e && e.message) || e),
        };
      }
    }
    // 找不到取消：点遮罩关闭（尽力）
    try {
      const mask = document.querySelector(".semi-modal-mask, .semi-modal-wrap");
      if (mask) mask.click();
    } catch (_) {}
    return { ok: false, error: "裁剪层没有「取消」" };
  }

  function findCoverEditorRoot() {
    return (
      document.querySelector(".selectArea-BCIYQD") ||
      document.querySelector(".semi-upload-drag-area") ||
      document.querySelector(".buttons-BoCvr4") ||
      document.querySelector('[class*="upload-ZOJTUA"]') ||
      null
    );
  }

  function coverEditorOpen() {
    if (findCoverEditorRoot()) return true;
    if (document.querySelector("input.semi-upload-hidden-input")) return true;
    const body = (document.body && document.body.innerText) || "";
    return (
      body.indexOf("点击上传文件或拖拽文件到这里") >= 0 ||
      body.indexOf("上传封面") >= 0
    );
  }

  function findCoverImageFileInput() {
    const roots = [
      document.querySelector(".selectArea-BCIYQD"),
      document.querySelector('[class*="upload-ZOJTUA"]'),
      document.querySelector(".semi-upload"),
      findCoverCropModal(),
      document,
    ];
    const sels = [
      "input.semi-upload-hidden-input",
      "input.semi-upload-hidden-input-replace",
      'input.upload-btn-input-UY_qeY',
      'input[name="upload-btn"][accept*="image"]',
      'input[type="file"][accept*="image"]',
    ];
    for (let r = 0; r < roots.length; r++) {
      if (!roots[r]) continue;
      for (let i = 0; i < sels.length; i++) {
        const nodes = roots[r].querySelectorAll(sels[i]);
        for (let j = 0; j < nodes.length; j++) {
          const el = nodes[j];
          const acc = String(el.getAttribute("accept") || "").toLowerCase();
          if (acc.indexOf("video") >= 0 && acc.indexOf("image") < 0) continue;
          return el;
        }
      }
    }
    return null;
  }

  function clickCoverWizardButton(exactText, preferPrimary) {
    const want = String(exactText || "").replace(/\s+/g, "");
    const root =
      document.querySelector(".buttons-BoCvr4") ||
      document.querySelector('[class*="buttons-"]') ||
      document;
    const buttons = root.querySelectorAll("button");
    let fallback = null;
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const text = (b.textContent || "").replace(/\s+/g, "");
      if (text !== want) continue;
      // 绝不点「取消」
      if (text === "取消") continue;
      const cls = String(b.className || "");
      const isPrimary =
        cls.indexOf("primary-RstHX_") >= 0 ||
        (cls.indexOf("semi-button-primary") >= 0 &&
          cls.indexOf("semi-button-light") < 0 &&
          cls.indexOf("secondary-") < 0);
      if (preferPrimary) {
        if (isPrimary) {
          try {
            b.click();
            return { ok: true, clicked: want, primary: true };
          } catch (e) {
            return {
              ok: false,
              error: "点击「" + want + "」失败：" + String((e && e.message) || e),
            };
          }
        }
        fallback = b;
        continue;
      }
      try {
        b.click();
        return { ok: true, clicked: want, primary: isPrimary };
      } catch (e) {
        return {
          ok: false,
          error: "点击「" + want + "」失败：" + String((e && e.message) || e),
        };
      }
    }
    if (fallback) {
      try {
        fallback.click();
        return { ok: true, clicked: want, primary: false };
      } catch (e) {
        return {
          ok: false,
          error: "点击「" + want + "」失败：" + String((e && e.message) || e),
        };
      }
    }
    return { ok: false, error: "找不到按钮「" + exactText + "」" };
  }

  function clickCropSave() {
    // 实测弹层：.semi-modal-body .image-uploader
    //   .btn-area-yY4w20 > button.primary-cECiOJ「保存」
    const crop = findCoverCropModal();
    if (!crop) return { ok: false, missing: true };
    const area =
      crop.querySelector(".btn-area-yY4w20, [class*=\"btn-area\"]") || crop;
    const buttons = area.querySelectorAll("button");
    let fallback = null;
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const t = (b.textContent || "").replace(/\s+/g, "");
      if (t !== "保存") continue;
      const cls = String(b.className || "");
      const isPrimary =
        cls.indexOf("primary-cECiOJ") >= 0 ||
        cls.indexOf("primary-") >= 0 ||
        (b.style && /254,\s*44,\s*85/.test(b.style.background || ""));
      if (isPrimary) {
        try {
          b.click();
          return { ok: true, clicked: "保存", primary: true };
        } catch (e) {
          return {
            ok: false,
            error: "点击裁剪「保存」失败：" + String((e && e.message) || e),
          };
        }
      }
      fallback = b;
    }
    if (fallback) {
      try {
        fallback.click();
        return { ok: true, clicked: "保存", primary: false };
      } catch (e) {
        return {
          ok: false,
          error: "点击裁剪「保存」失败：" + String((e && e.message) || e),
        };
      }
    }
    return { ok: false, error: "裁剪弹层里没有「保存」" };
  }

  function detectCoverSaveErrorText() {
    const body = (document.body && document.body.innerText) || "";
    const patterns = [
      /上传失败[^\n]{0,60}/,
      /封面上传失败[^\n]{0,40}/,
      /格式不支持[^\n]{0,40}/,
      /文件过大[^\n]{0,40}/,
      /请重新上传[^\n]{0,40}/,
      /网络异常[^\n]{0,40}/,
      /上传出错[^\n]{0,40}/,
    ];
    for (let i = 0; i < patterns.length; i++) {
      const m = body.match(patterns[i]);
      if (m) return m[0];
    }
    return "";
  }

  async function waitCoverSaveSettled(timeoutMs) {
    // 点「保存」后常见：出现「正在上传封面」→ 成功关弹层 / 失败 toast
    const deadline = Date.now() + (timeoutMs || 20000);
    let sawUploading = false;
    while (Date.now() < deadline) {
      const body = (document.body && document.body.innerText) || "";
      if (body.indexOf("正在上传封面") >= 0) sawUploading = true;

      const err = detectCoverSaveErrorText();
      if (err) {
        return { ok: false, error: err, saw_uploading: sawUploading };
      }

      // 裁剪弹层已关 = 保存流程走完（不一定业务成功，再看错误文案）
      if (!findCoverCropModal()) {
        // 关层后错误 toast 可能还在 body 上
        await _pubSleep(600);
        const err2 = detectCoverSaveErrorText();
        if (err2) {
          return { ok: false, error: err2, saw_uploading: sawUploading };
        }
        return {
          ok: true,
          closed: true,
          saw_uploading: sawUploading,
        };
      }

      // 仍在上传中
      if (body.indexOf("正在上传封面") >= 0) {
        await _pubSleep(300);
        continue;
      }

      await _pubSleep(250);
    }
    if (findCoverCropModal()) {
      return {
        ok: false,
        error: "点「保存」后裁剪弹层未关闭（可能上传卡住）",
        saw_uploading: sawUploading,
        detail: { debug: snapshotCoverDebugUi() },
      };
    }
    return { ok: true, closed: true, saw_uploading: sawUploading };
  }

  async function waitCoverEditorClosed(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const open =
        document.querySelector(".buttons-BoCvr4") ||
        document.querySelector(".semi-upload-drag-area") ||
        findCoverCropModal();
      if (!open) return true;
      // 编辑页已回到「设置封面」区块且没有完成/取消底栏
      if (
        findSectionByTitle("设置封面") &&
        !document.querySelector(".buttons-BoCvr4")
      ) {
        return true;
      }
      await _pubSleep(250);
    }
    return !document.querySelector(".buttons-BoCvr4");
  }

  function coverUiWrongCropPath() {
    // 手动上传不会进这条；出现即判定走错路径
    return !!findCoverCropModal();
  }

  function coverUiReacted() {
    // 误入裁剪「保存」层 ≠ 成功
    if (coverUiWrongCropPath()) return "";

    const root = document.querySelector(".buttons-BoCvr4");
    if (root) {
      const t = (root.textContent || "").replace(/\s+/g, "");
      if (t.indexOf("重新检测") >= 0) return "recheck";
      if (t.indexOf("取消") >= 0 && t.indexOf("完成") >= 0) {
        // 上传成功后常见：取消 + 完成（不再是「设置竖封面」）
        if (t.indexOf("设置竖封面") < 0 && t.indexOf("设置横封面") < 0) {
          return "cancel_complete";
        }
        // 有时仍显示设置竖/横，但「完成」已是主按钮
        const ready = waitPrimaryCompleteReadySync();
        if (ready) return "primary_complete";
      }
    }
    // scrubber 预览帧还在 + 上传 tip 仍在，不够当成功；只认底栏变化
    return "";
  }

  function waitPrimaryCompleteReadySync() {
    const root = document.querySelector(".buttons-BoCvr4") || document;
    const buttons = root.querySelectorAll("button");
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const text = (b.textContent || "").replace(/\s+/g, "");
      if (text !== "完成") continue;
      const cls = String(b.className || "");
      if (
        cls.indexOf("primary-RstHX_") >= 0 ||
        (cls.indexOf("semi-button-primary") >= 0 &&
          cls.indexOf("semi-button-light") < 0)
      ) {
        return true;
      }
    }
    return false;
  }

  function snapshotCoverDebugUi() {
    const buttons = [];
    document.querySelectorAll(".buttons-BoCvr4 button, .semi-modal button").forEach(
      function (b) {
        buttons.push({
          text: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
          className: String(b.className || "").slice(0, 120),
        });
      }
    );
    const inputs = [];
    document
      .querySelectorAll(
        'input[type="file"], input.semi-upload-hidden-input, input.semi-upload-hidden-input-replace'
      )
      .forEach(function (el) {
        inputs.push({
          className: String(el.className || "").slice(0, 80),
          name: el.getAttribute("name") || "",
          accept: (el.getAttribute("accept") || "").slice(0, 80),
          files: el.files ? el.files.length : 0,
        });
      });

    function clip(el, n) {
      if (!el) return "";
      try {
        return String(el.outerHTML || "").slice(0, n || 2500);
      } catch (_) {
        return "";
      }
    }

    const crop = findCoverCropModal();
    const modal =
      document.querySelector(".semi-modal-body") ||
      document.querySelector(".semi-modal") ||
      null;
    const uploadBox =
      document.querySelector(".upload-ZOJTUA") ||
      document.querySelector(".semi-upload") ||
      null;

    return {
      reacted: coverUiReacted() || "",
      has_image_uploader: !!document.querySelector(".image-uploader"),
      has_react_crop: !!document.querySelector(".ReactCrop, .ReactCrop__image"),
      has_semi_modal: !!document.querySelector(".semi-modal"),
      has_drag_area: !!document.querySelector(".semi-upload-drag-area"),
      button_texts: buttons,
      file_inputs: inputs,
      html_crop: clip(crop, 3000),
      html_modal_body: clip(modal, 3000),
      html_upload_box: clip(uploadBox, 2000),
      hint:
        "请核对是否仍在 scrubber「上传封面」页（不应出现带「保存」的裁剪弹层）；" +
        "自动化已暂停，不会点完成。",
    };
  }

  function snapshotCoverPreviewSig() {
    const parts = [];
    document
      .querySelectorAll(
        ".preview-frame-rt7Mc1, [class*=\"preview-frame\"], .slider-preview-x80FhD, [class*=\"slider-preview\"]"
      )
      .forEach(function (el) {
        try {
          parts.push(String((el.style && el.style.backgroundImage) || "").slice(0, 160));
        } catch (_) {}
      });
    document
      .querySelectorAll(
        ".recommend-bubble-preview-img-gKNo9J, [class*=\"recommend-bubble-preview\"]"
      )
      .forEach(function (el) {
        try {
          parts.push(String((el.style && el.style.backgroundImage) || "").slice(0, 100));
        } catch (_) {}
      });
    return parts.join("||");
  }

  function coverFormatErrorText() {
    const body = (document.body && document.body.innerText) || "";
    const m = body.match(
      /不支持的图片格式[^\n]{0,60}|只支持\s*jpg[^\n]{0,40}|封面上传失败[^\n]{0,40}/i
    );
    return m ? m[0] : detectCoverSaveErrorText();
  }

  async function waitCoverPreviewSettled(beforeSig, timeoutMs) {
    // 等到预览换图 / 上传成功且不在「正在上传」——就绪即返回，不再额外干等。
    const deadline = Date.now() + (timeoutMs || 45000);
    let sawUploading = false;
    let sawSuccessToast = false;
    while (Date.now() < deadline) {
      if (coverUiWrongCropPath()) {
        dismissCoverCropModal();
        await _pubSleep(300);
        continue;
      }
      const body = (document.body && document.body.innerText) || "";
      const fmt = coverFormatErrorText();
      if (fmt) {
        return { ok: false, error: fmt, saw_uploading: sawUploading };
      }
      if (body.indexOf("正在上传") >= 0) {
        sawUploading = true;
        await _pubSleep(250);
        continue;
      }
      if (body.indexOf("上传成功") >= 0) sawSuccessToast = true;

      const sig = snapshotCoverPreviewSig();
      const changed = !!(beforeSig && sig && sig !== beforeSig);
      if (changed || (sawSuccessToast && !sawUploading)) {
        if (coverFormatErrorText()) {
          return {
            ok: false,
            error: coverFormatErrorText(),
            saw_uploading: sawUploading,
          };
        }
        return {
          ok: true,
          changed: changed,
          saw_success_toast: sawSuccessToast,
          saw_uploading: sawUploading,
        };
      }
      await _pubSleep(250);
    }
    return {
      ok: false,
      error: "选图后等待封面预览更新超时",
      saw_uploading: sawUploading,
      saw_success_toast: sawSuccessToast,
      detail: { debug: snapshotCoverDebugUi() },
    };
  }

  async function putCoverFileOnce(absPath, coverUrl, filename) {
    const attempts = [];
    let lastErr = "";
    const beforeSig = snapshotCoverPreviewSig();

    // 若上次误入裁剪层，先取消关掉
    if (coverUiWrongCropPath()) {
      dismissCoverCropModal();
      await _pubSleep(500);
    }

    // —— 主路径：拦截系统选文件框（与手动一致）——
    const viaChooser = await setLocalFileViaChooser(absPath);
    attempts.push({
      method: "cdp_file_chooser",
      ok: !!(viaChooser && viaChooser.ok),
      error: (viaChooser && viaChooser.error) || "",
      clicked: (viaChooser && viaChooser.clicked) || "",
    });
    if (viaChooser && viaChooser.ok) {
      if (coverUiWrongCropPath()) {
        dismissCoverCropModal();
        await _pubSleep(500);
      }
      const settled = await waitCoverPreviewSettled(beforeSig, 45000);
      if (settled.ok && !coverUiWrongCropPath()) {
        return {
          ok: true,
          error: "",
          detail: {
            method: "cdp_file_chooser",
            reacted: settled.changed ? "preview_changed" : "success_toast",
            clicked: viaChooser.clicked || "",
            attempts: attempts,
            saw_uploading: !!settled.saw_uploading,
          },
        };
      }
      lastErr =
        (settled && settled.error) ||
        "fileChooser 后预览未更新或误入裁剪层";
      if (coverUiWrongCropPath()) {
        dismissCoverCropModal();
        lastErr = "fileChooser 后出现裁剪「保存」层（已取消）; " + lastErr;
      }
    } else {
      lastErr = (viaChooser && viaChooser.error) || "fileChooser 失败";
    }

    // —— 兜底：只塞外层 Semi upload（绝不碰裁剪层 upload-btn）——
    const selectors = [
      ".upload-ZOJTUA input.semi-upload-hidden-input",
      ".upload-ZOJTUA input.semi-upload-hidden-input-replace",
      "input.semi-upload-hidden-input",
      "input.semi-upload-hidden-input-replace",
    ];
    for (let i = 0; i < selectors.length; i++) {
      const sel = selectors[i];
      const el = document.querySelector(sel);
      if (!el || (el.closest && el.closest(".image-uploader"))) {
        attempts.push({ selector: sel, skipped: true });
        continue;
      }
      const put = await setLocalFileViaDebugger(absPath, sel);
      attempts.push({
        method: "cdp_setFileInputFiles",
        selector: sel,
        ok: !!(put && put.ok),
        error: (put && put.error) || "",
      });
      if (!put || !put.ok) {
        lastErr = put && put.error ? put.error : "unknown";
        continue;
      }
      if (coverUiWrongCropPath()) {
        dismissCoverCropModal();
        await _pubSleep(400);
        lastErr = "直塞 " + sel + " 误入裁剪层，已取消";
        continue;
      }
      const settled = await waitCoverPreviewSettled(beforeSig, 45000);
      if (settled.ok && !coverUiWrongCropPath()) {
        return {
          ok: true,
          error: "",
          detail: {
            method: "cdp_setFileInputFiles",
            selector: sel,
            reacted: settled.changed ? "preview_changed" : "success_toast",
            attempts: attempts,
          },
        };
      }
      lastErr = (settled && settled.error) || lastErr;
    }

    // —— 最后：桥 DataTransfer 丢到外层 drag-area ——
    if (coverUrl) {
      const fallback = await putFileIntoInput(
        coverUrl,
        filename || absPath.split("/").pop() || "cover.jpg",
        ".upload-ZOJTUA input.semi-upload-hidden-input, input.semi-upload-hidden-input"
      );
      attempts.push({
        method: "datatransfer_fallback",
        ok: !!(fallback && fallback.ok),
        error: (fallback && fallback.error) || "",
      });
      await _pubSleep(1500);
      if (coverUiWrongCropPath()) {
        dismissCoverCropModal();
        lastErr = "DataTransfer 后误入裁剪层";
      } else if (fallback.ok) {
        const settled = await waitCoverPreviewSettled(beforeSig, 45000);
        if (settled.ok && !coverUiWrongCropPath()) {
          return {
            ok: true,
            error: "",
            detail: {
              method: "datatransfer_fallback",
              reacted: settled.changed ? "preview_changed" : "success_toast",
              attempts: attempts,
            },
          };
        }
        lastErr = (settled && settled.error) || (fallback.error || lastErr);
      } else {
        lastErr = (fallback && fallback.error) || lastErr;
      }
    }

    return {
      ok: false,
      error:
        "封面未按手动路径接住（应直接回 scrubber，不应出现「保存」弹层）。" +
        (lastErr ? " 最后: " + lastErr : ""),
      detail: { attempts: attempts, debug: snapshotCoverDebugUi() },
    };
  }

  async function finishCropIfPresent() {
    // 上传后等裁剪/保存弹层（.image-uploader + ReactCrop +「保存」）
    const deadline = Date.now() + 12000;
    let saw = false;
    while (Date.now() < deadline) {
      if (findCoverCropModal()) {
        saw = true;
        break;
      }
      if (
        document.querySelector(
          ".ReactCrop__image, img.crop-preview-gcoD69, [class*=\"crop-preview\"]"
        )
      ) {
        saw = true;
        break;
      }
      const modalBtns = document.querySelectorAll(
        ".semi-modal-body .image-uploader button, .semi-modal button"
      );
      for (let i = 0; i < modalBtns.length; i++) {
        if ((modalBtns[i].textContent || "").replace(/\s+/g, "") === "保存") {
          saw = true;
          break;
        }
      }
      if (saw) break;
      await _pubSleep(250);
    }
    if (!saw) return { ok: true, skipped: true };

    // 等预览图出来再点保存，避免裁剪区未就绪
    const previewDeadline = Date.now() + 8000;
    while (Date.now() < previewDeadline) {
      if (
        document.querySelector(
          ".ReactCrop__image, img.crop-preview-gcoD69, [class*=\"crop-preview\"]"
        )
      ) {
        break;
      }
      await _pubSleep(200);
    }
    await _pubSleep(400);

    let saved = clickCropSave();
    if (saved.missing || !saved.ok) {
      const buttons = document.querySelectorAll(
        ".semi-modal-body .image-uploader button, .semi-modal button"
      );
      for (let i = 0; i < buttons.length; i++) {
        const t = (buttons[i].textContent || "").replace(/\s+/g, "");
        if (t !== "保存") continue;
        try {
          buttons[i].click();
          saved = { ok: true, clicked: "保存" };
          break;
        } catch (e) {
          return {
            ok: false,
            error: "点击「保存」失败：" + String((e && e.message) || e),
          };
        }
      }
    }
    if (!saved.ok) {
      return {
        ok: false,
        error: saved.error || "出现了疑似裁剪层但点不到「保存」",
        detail: { debug: snapshotCoverDebugUi() },
      };
    }

    const settled = await waitCoverSaveSettled(20000);
    if (!settled.ok) {
      return {
        ok: false,
        error: settled.error || "封面保存上传失败",
        detail: Object.assign(
          { saw_uploading: !!settled.saw_uploading },
          settled.detail || { debug: snapshotCoverDebugUi() }
        ),
      };
    }
    await _pubSleep(300);
    return {
      ok: true,
      clicked: "保存",
      saw_uploading: !!settled.saw_uploading,
    };
  }

  async function waitPrimaryCompleteReady(timeoutMs) {
    // 上传成功后底栏变为：取消(次) + 完成(主 primary-RstHX_)
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const root = document.querySelector(".buttons-BoCvr4") || document;
      const buttons = root.querySelectorAll("button");
      for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        const text = (b.textContent || "").replace(/\s+/g, "");
        if (text !== "完成") continue;
        const cls = String(b.className || "");
        if (
          cls.indexOf("primary-RstHX_") >= 0 ||
          (cls.indexOf("semi-button-primary") >= 0 &&
            cls.indexOf("semi-button-light") < 0)
        ) {
          return { ok: true, button: b };
        }
      }
      await _pubSleep(250);
    }
    return { ok: false, error: "上传后未出现主按钮「完成」" };
  }

  async function uploadAndCompleteOnce(
    absPath,
    coverUrl,
    filename,
    which,
    debugPause
  ) {
    const put = await putCoverFileOnce(absPath, coverUrl, filename);

    // 调试：无论是否判定成功，塞图尝试后都停，方便复制弹层 HTML
    if (debugPause) {
      await _pubSleep(2500);
      const dbg = (put.detail && put.detail.debug) || snapshotCoverDebugUi();
      return {
        ok: true,
        paused: true,
        detail: {
          stage: "cover_debug_paused",
          which: which,
          put_ok: !!(put && put.ok),
          put_error: (put && put.error) || "",
          method: (put.detail && put.detail.method) || "",
          reacted: (put.detail && put.detail.reacted) || coverUiReacted() || "",
          attempts: (put.detail && put.detail.attempts) || [],
          debug: dbg,
          next:
            "已暂停。请确认页面仍是 scrubber「上传封面」（不应有「保存」裁剪层）。" +
            "正常则 cover_debug_pause=false 继续；异常把 HTML 发回来。",
        },
      };
    }

    if (!put.ok) {
      return {
        ok: false,
        error: which + "上传失败：" + (put.error || ""),
        detail: put.detail || { debug: snapshotCoverDebugUi() },
      };
    }

    // 手动路径没有「保存」裁剪层；若误入则取消，不算成功
    if (coverUiWrongCropPath()) {
      dismissCoverCropModal();
      return {
        ok: false,
        error:
          which +
          "误入裁剪「保存」弹层（手动不会出现）。已点取消；请重载扩展后重试。",
        detail: { debug: snapshotCoverDebugUi() },
      };
    }

    // 上传完成（预览已变）后立刻点「完成」
    const ready = await waitPrimaryCompleteReady(8000);
    const preFmt = coverFormatErrorText();
    if (preFmt) {
      return {
        ok: false,
        error: which + "点「完成」前已报错：" + preFmt,
        detail: { debug: snapshotCoverDebugUi() },
      };
    }
    if (!ready.ok) {
      const done = clickCoverWizardButton("完成", true);
      if (!done.ok) {
        const done2 = clickCoverWizardButton("完成", false);
        if (!done2.ok) {
          return {
            ok: false,
            error: ready.error,
            detail: { debug: snapshotCoverDebugUi() },
          };
        }
      }
    } else {
      try {
        ready.button.click();
      } catch (e) {
        return {
          ok: false,
          error: which + "点「完成」失败：" + String((e && e.message) || e),
        };
      }
    }

    await _pubSleep(400);
    const fmtHit = coverFormatErrorText();
    if (fmtHit) {
      return {
        ok: false,
        error: which + "点「完成」后页面报格式错误：" + fmtHit,
        detail: { debug: snapshotCoverDebugUi() },
      };
    }

    const closed = await waitCoverEditorClosed(12000);
    if (!closed) {
      return {
        ok: false,
        error: which + "点了「完成」但封面编辑器未关闭",
        detail: { debug: snapshotCoverDebugUi() },
      };
    }
    return {
      ok: true,
      detail: {
        method: (put.detail && put.detail.method) || "cdp_file_chooser",
        crop: "not_expected_on_manual_path",
        preview: (put.detail && put.detail.reacted) || "",
      },
    };
  }

  async function uploadOneCoverOrientation(
    absPath,
    coverUrl,
    filename,
    orientation,
    debugPause
  ) {
    const label = orientation === "horizontal" ? "横封面" : "竖封面";
    const stage = "cover_" + orientation;

    const opened = clickSelectCoverButton(orientation);
    if (!opened.ok) {
      return { ok: false, error: opened.error, detail: { stage: stage } };
    }
    await _pubSleep(900);

    let waitUntil = Date.now() + COVER_WAIT_MS;
    while (Date.now() < waitUntil) {
      if (coverEditorOpen() || findCoverImageFileInput()) break;
      await _pubSleep(300);
    }
    if (!coverEditorOpen() && !findCoverImageFileInput()) {
      return {
        ok: false,
        error: "打开" + label + "后未出现上传区（semi-upload-drag-area）",
        detail: { stage: stage, debug: snapshotCoverDebugUi() },
      };
    }

    const r = await uploadAndCompleteOnce(
      absPath,
      coverUrl,
      filename,
      label,
      !!debugPause
    );
    if (r.paused) {
      return {
        ok: true,
        paused: true,
        detail: Object.assign(
          {
            cover_path: absPath,
            cover: "upload",
            stage: "cover_debug_paused",
            cover_flow: "debug_pause_after_first_upload",
            first_orientation: orientation,
          },
          r.detail || {}
        ),
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        error: r.error,
        detail: Object.assign({ cover_path: absPath, stage: stage }, r.detail || {}),
      };
    }
    return {
      ok: true,
      detail: Object.assign({ stage: stage + "_done" }, r.detail || {}),
    };
  }

  async function uploadCustomCover(
    localPath,
    coverUrl,
    filename,
    orientation,
    debugPause,
    coverBoth
  ) {
    const absPath = String(localPath || "").trim();
    if (!absPath) {
      return { ok: true, detail: { cover_path: "", cover: "default" } };
    }

    // 默认只做一次：先竖封面（与手动一致），做完再退出。
    // cover_both=true 时再串行做横封面 —— 绝不并行、中间要等编辑器关干净。
    const wantHorizontal =
      orientation === "horizontal" || orientation === "landscape";
    const primary = wantHorizontal ? "horizontal" : "vertical";
    const doBoth = !!coverBoth;
    const order = doBoth
      ? ["vertical", "horizontal"]
      : [primary];
    const stepsDone = [];

    let r = await uploadOneCoverOrientation(
      absPath,
      coverUrl,
      filename,
      order[0],
      debugPause
    );
    if (r.paused) {
      return { ok: true, error: "", detail: r.detail || {} };
    }
    if (!r.ok) {
      return {
        ok: false,
        error: r.error,
        detail: Object.assign(
          {
            cover_path: absPath,
            cover_orientation: order[0],
            cover_order: order,
            cover_both: doBoth,
          },
          r.detail || {}
        ),
      };
    }
    stepsDone.push(order[0]);

    if (!doBoth || order.length < 2) {
      return {
        ok: true,
        detail: {
          cover_path: absPath,
          cover: "upload",
          cover_orientation: order[0],
          cover_steps: stepsDone,
          cover_order: order,
          cover_both: false,
          cover_confirm: "完成",
          cover_flow: "single_orientation",
          warning:
            "仅完成了" +
            (order[0] === "horizontal" ? "横" : "竖") +
            "封面。需要横+竖都设时传 cover_both=true。",
        },
      };
    }

    // 竖封面编辑器关净后再开横封面（短等，不额外垫时间）
    let guard = Date.now() + 8000;
    while (Date.now() < guard) {
      if (
        !findCoverCropModal() &&
        !document.querySelector(".buttons-BoCvr4") &&
        !document.querySelector(".semi-upload-drag-area")
      ) {
        break;
      }
      await _pubSleep(200);
    }

    r = await uploadOneCoverOrientation(
      absPath,
      coverUrl,
      filename,
      order[1],
      false
    );
    if (!r.ok) {
      return {
        ok: false,
        error: "竖封面已完成，但横封面失败：" + (r.error || ""),
        detail: Object.assign(
          {
            cover_path: absPath,
            cover_orientation: "vertical",
            cover_order: order,
            cover_both: true,
            steps: stepsDone,
          },
          r.detail || {}
        ),
      };
    }
    stepsDone.push(order[1]);

    return {
      ok: true,
      detail: {
        cover_path: absPath,
        cover: "upload",
        cover_orientation: "vertical",
        cover_steps: stepsDone,
        cover_order: order,
        cover_both: true,
        cover_confirm: "完成",
        cover_flow: "vertical_then_horizontal_serial",
      },
    };
  }

  function armCreateV2Watch() {
    if (_pendingCreateV2 && _pendingCreateV2.timer) {
      try {
        clearTimeout(_pendingCreateV2.timer);
      } catch (_) {}
    }
    const holder = { resolve: null, timer: null };
    const promise = new Promise(function (resolve) {
      holder.resolve = resolve;
      holder.timer = setTimeout(function () {
        if (_pendingCreateV2 === holder) _pendingCreateV2 = null;
        resolve({ missed: true, http_status: 0, resp_text: "" });
      }, PUBLISH_SUCCESS_WAIT_MS + 5000);
    });
    holder.promise = promise;
    _pendingCreateV2 = holder;
    try {
      window.postMessage(
        { __hermes_douyin__: true, dir: "create_v2_arm" },
        "*"
      );
    } catch (_) {}
    return promise;
  }

  function disarmCreateV2Watch() {
    try {
      window.postMessage(
        { __hermes_douyin__: true, dir: "create_v2_disarm" },
        "*"
      );
    } catch (_) {}
    if (_pendingCreateV2 && _pendingCreateV2.timer) {
      try {
        clearTimeout(_pendingCreateV2.timer);
      } catch (_) {}
    }
    _pendingCreateV2 = null;
  }

  function parseCreateV2Result(raw) {
    const text = String((raw && raw.resp_text) || "");
    const http = (raw && raw.http_status) || 0;
    if (raw && raw.missed) {
      return { seen: false, ok: false, missed: true, http_status: http };
    }
    if (!text) {
      return {
        seen: true,
        ok: false,
        http_status: http,
        error: "create_v2 响应体为空（HTTP " + http + "）",
      };
    }
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      return {
        seen: true,
        ok: false,
        http_status: http,
        error: "create_v2 响应不是 JSON",
        resp_preview: text.slice(0, 200),
      };
    }
    const code = obj.status_code;
    const ok = code === 0 || code === "0";
    return {
      seen: true,
      ok: ok,
      http_status: http,
      status_code: code,
      item_id: obj.item_id || (obj.aweme && obj.aweme.aweme_id) || "",
      error: ok
        ? ""
        : "create_v2 业务失败 status_code=" + String(code),
      resp_preview: text.slice(0, 200),
    };
  }

  function clickPublishButton() {
    const buttons = document.querySelectorAll("button");
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const t = (b.textContent || "").replace(/\s+/g, "");
      // 只要「发布」，不要「暂存离开」
      if (t !== "发布") continue;
      try {
        b.scrollIntoView({ block: "center" });
      } catch (_) {}
      try {
        b.click();
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          error: "点击发布失败：" + String((e && e.message) || e),
        };
      }
    }
    return { ok: false, error: '找不到文案为「发布」的按钮' };
  }

  function isPublishSuccessUrl() {
    try {
      const path = location.pathname || "";
      const href = location.href || "";
      return (
        /\/content\/manage/.test(path) && /enter_from=publish/.test(href)
      );
    } catch (_) {
      return false;
    }
  }

  async function waitForPublishSuccess(timeoutMs, createV2Promise) {
    const deadline = Date.now() + timeoutMs;
    let createV2 = null;
    let urlOk = false;
    let pageUrl = "";

    const onCreate = createV2Promise
      ? createV2Promise.then(function (raw) {
          createV2 = parseCreateV2Result(raw || {});
          return createV2;
        })
      : null;

    while (Date.now() < deadline) {
      if (isPublishSuccessUrl()) {
        urlOk = true;
        pageUrl = location.href || "";
      }
      if (createV2 && createV2.seen && !createV2.ok && !createV2.missed) {
        return {
          ok: false,
          error: createV2.error || "create_v2 失败",
          page_url: pageUrl || location.href || "",
          create_v2: createV2,
        };
      }
      // 严判优先：拿到成功的 create_v2 即可；URL 跳转作为辅证。
      if (createV2 && createV2.seen && createV2.ok) {
        return {
          ok: true,
          page_url: pageUrl || location.href || "",
          create_v2: createV2,
          url_ok: urlOk,
        };
      }
      // 已跳管理页但 create_v2 还没到：再多等一会儿，不立刻当成功。
      if (urlOk && createV2 && createV2.missed) {
        return {
          ok: true,
          page_url: pageUrl,
          create_v2: createV2,
          url_ok: true,
          warning: "已跳到作品管理页，但未捕获 create_v2 响应体",
        };
      }
      const err = detectUploadErrorText();
      if (err) {
        return { ok: false, error: "发布后页面提示：" + err };
      }
      const body = (document.body && document.body.innerText) || "";
      if (/发布失败|提交失败|请稍后再试/.test(body) && !isEditPage()) {
        const m = body.match(/(发布失败|提交失败)[^\n]{0,40}/);
        if (m) return { ok: false, error: "页面提示：" + m[0] };
      }
      await _pubSleep(500);
    }

    if (onCreate) {
      try {
        await Promise.race([onCreate, _pubSleep(10)]);
      } catch (_) {}
    }

    if (createV2 && createV2.seen && createV2.ok) {
      return {
        ok: true,
        page_url: pageUrl || location.href || "",
        create_v2: createV2,
        url_ok: urlOk,
      };
    }
    if (urlOk) {
      return {
        ok: true,
        page_url: pageUrl,
        create_v2: createV2 || { seen: false },
        url_ok: true,
        warning: "已跳到作品管理页，但未捕获 create_v2 响应体",
      };
    }
    return {
      ok: false,
      error:
        "点了发布，但 " +
        Math.round(timeoutMs / 1000) +
        " 秒内没有跳到作品管理页，也没有成功的 create_v2。" +
        " 当前 URL: " +
        (location.href || ""),
      page_url: location.href || "",
      create_v2: createV2 || { seen: false },
    };
  }

  function _truthySubmit(v) {
    if (v === true || v === 1) return true;
    const s = String(v == null ? "" : v)
      .trim()
      .toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }

  async function finishPublishAfterTitle(titleDetail, putDetail, opts) {
    opts = opts || {};
    const visibility = opts.visibility || "only_self";
    const description = opts.description || "";
    const coverLocalPath = String(opts.cover_local_path || "").trim();
    const coverUrl = String(opts.cover_url || "").trim();
    const coverFilename = String(opts.cover_filename || "").trim();
    const coverOrientation = opts.cover_orientation || "vertical";
    // 封面调试暂停默认关闭；排查时显式 cover_debug_pause=true。
    const coverDebugPause = _truthySubmit(opts.cover_debug_pause);
    // 默认只做竖或指定的那一侧；cover_both=true 才串行竖→横。
    const coverBoth = _truthySubmit(opts.cover_both);
    // 测试阶段默认不点发布；必须显式 submit=true。
    const doSubmit = _truthySubmit(opts.submit);
    let extra = {};

    await _pubSleep(300);

    if (description) {
      const desc = fillDescription(description);
      if (!desc.ok) {
        return {
          ok: false,
          error: desc.error,
          detail: Object.assign(
            {},
            putDetail || {},
            titleDetail || {},
            desc.detail || {}
          ),
        };
      }
      extra = Object.assign(extra, desc.detail || {});
      await _pubSleep(300);
    }

    if (coverLocalPath) {
      const cov = await uploadCustomCover(
        coverLocalPath,
        coverUrl,
        coverFilename,
        coverOrientation,
        coverDebugPause,
        coverBoth
      );
      if (!cov.ok) {
        return {
          ok: false,
          error: cov.error,
          detail: Object.assign(
            {},
            putDetail || {},
            titleDetail || {},
            extra,
            cov.detail || {}
          ),
        };
      }
      extra = Object.assign(extra, cov.detail || {});
      // 调试暂停：停在封面弹层，不再继续填可见性/发布
      if (
        (cov.detail && cov.detail.stage === "cover_debug_paused") ||
        (cov.detail && cov.detail.cover_flow === "debug_pause_after_first_upload")
      ) {
        return {
          ok: true,
          error: "",
          detail: Object.assign(
            {},
            putDetail || {},
            titleDetail || {},
            extra,
            {
              page_url: location.href || "",
              stage: "cover_debug_paused",
              submitted: false,
              cover_debug_pause: true,
              warning:
                (cov.detail && cov.detail.next) ||
                "封面上传已暂停，请复制弹层 HTML 后把 cover_debug_pause=false 再跑。",
            }
          ),
        };
      }
      await _pubSleep(400);
    } else {
      extra.cover = "default";
      extra.cover_path = "";
    }

    const vis = setVisibility(visibility);
    if (!vis.ok) {
      return {
        ok: false,
        error: vis.error,
        detail: Object.assign({}, putDetail || {}, titleDetail || {}, extra),
      };
    }
    extra = Object.assign(extra, vis.detail || {});
    await _pubSleep(300);

    const collection = opts.collection;
    const decl = opts.declaration;
    if (collection != null && String(collection).trim() !== "") {
      const col = await setCollection(collection);
      if (!col.ok) {
        return {
          ok: false,
          error: col.error,
          detail: Object.assign(
            {},
            putDetail || {},
            titleDetail || {},
            extra,
            col.detail || {}
          ),
        };
      }
      extra = Object.assign(extra, col.detail || {});
      await _pubSleep(250);
    } else {
      extra.collection_skipped = true;
    }

    if (decl != null && String(decl).trim() !== "") {
      const dec = await setDeclaration(decl);
      if (!dec.ok) {
        return {
          ok: false,
          error: dec.error,
          detail: Object.assign(
            {},
            putDetail || {},
            titleDetail || {},
            extra,
            dec.detail || {}
          ),
        };
      }
      extra = Object.assign(extra, dec.detail || {});
      await _pubSleep(250);
    } else {
      extra.declaration_skipped = true;
    }

    const hotspot = opts.hotspot;
    if (hotspot != null && String(hotspot).trim() !== "") {
      const hot = await setHotspot(hotspot);
      if (!hot.ok) {
        return {
          ok: false,
          error: hot.error,
          detail: Object.assign(
            {},
            putDetail || {},
            titleDetail || {},
            extra,
            hot.detail || {}
          ),
        };
      }
      extra = Object.assign(extra, hot.detail || {});
      await _pubSleep(250);
    } else {
      extra.hotspot_skipped = true;
    }

    if (!doSubmit) {
      const warnParts = [];
      if (extra.warning) warnParts.push(String(extra.warning));
      warnParts.push(
        "已填好草稿，未点「发布」。确认无误后再次调用并传 submit=true。"
      );
      return {
        ok: true,
        error: "",
        detail: Object.assign(
          {},
          putDetail || {},
          titleDetail || {},
          extra,
          {
            page_url: location.href || "",
            stage: "ready_to_publish",
            submitted: false,
            visibility: (vis.detail && vis.detail.visibility) || visibility,
            warning: warnParts.join(" "),
          }
        ),
      };
    }

    const createV2Promise = armCreateV2Watch();
    const clicked = clickPublishButton();
    if (!clicked.ok) {
      disarmCreateV2Watch();
      return {
        ok: false,
        error: clicked.error,
        detail: Object.assign(
          {},
          putDetail || {},
          titleDetail || {},
          extra,
          { submitted: false }
        ),
      };
    }

    const done = await waitForPublishSuccess(
      PUBLISH_SUCCESS_WAIT_MS,
      createV2Promise
    );
    disarmCreateV2Watch();
    if (!done.ok) {
      return {
        ok: false,
        error: done.error,
        detail: Object.assign(
          {},
          putDetail || {},
          titleDetail || {},
          extra,
          vis.detail || {},
          {
            page_url: done.page_url || location.href || "",
            stage: "publish_clicked",
            submitted: true,
            create_v2: done.create_v2 || null,
          }
        ),
      };
    }

    return {
      ok: true,
      error: "",
      detail: Object.assign(
        {},
        putDetail || {},
        titleDetail || {},
        extra,
        vis.detail || {},
        {
          page_url: done.page_url || location.href || "",
          stage: "published",
          submitted: true,
          visibility: (vis.detail && vis.detail.visibility) || visibility,
          create_v2: done.create_v2 || null,
          create_v2_ok: !!(done.create_v2 && done.create_v2.ok),
          warning: done.warning || "",
        }
      ),
    };
  }

  async function publishPrepare(url, filename, title, localPath, opts) {
    opts = opts || {};
    const titleText = String(title || "").trim();
    if (!titleText) {
      return { ok: false, error: "标题为空" };
    }
    if (titleText.length > TITLE_MAX_CHARS) {
      return {
        ok: false,
        error:
          "标题超过 " + TITLE_MAX_CHARS + " 字（当前 " + titleText.length + "）",
      };
    }
    const visKey = String(opts.visibility || "only_self");
    if (!VISIBILITY_OPTS[visKey]) {
      return {
        ok: false,
        error:
          "visibility 无效（" +
          visKey +
          "），允许: only_self / friends / public",
      };
    }

    let putDetail = {};

    // 已在编辑页：跳过上传，直接填标题 → 可见性 →（可选）发布。
    if (!(isEditPage() && findTitleInput())) {
      if (!isUploadPage() && !isEditPage()) {
        return {
          ok: false,
          error:
            "当前不在创作者中心上传/编辑页（" +
            (location.pathname || "") +
            "）。请重试。",
        };
      }

      try {
        _clickByText(["发布视频"]);
      } catch (_) {}
      await _pubSleep(400);

      const fileInput = await waitForVideoFileInput(12000);
      if (!fileInput) {
        return {
          ok: false,
          error: "上传页找不到 video file input（页面可能未加载完）",
        };
      }

      const selector = 'input[type="file"][accept*="video"]';
      let put;
      const absPath = String(localPath || "").trim();
      if (absPath) {
        put = await setLocalFileViaDebugger(absPath, selector);
        if (put && put.ok) {
          put = {
            ok: true,
            error: "",
            detail: {
              accepted_name: filename || absPath.split("/").pop() || "",
              method: "cdp_setFileInputFiles",
              local_path: absPath,
            },
          };
        }
      }
      if (!put || !put.ok) {
        const cdpErr = put && put.error ? put.error : "";
        if (!url) {
          return {
            ok: false,
            error:
              (cdpErr ? "CDP 失败: " + cdpErr + "；" : "") +
              "且没有可用的桥文件 URL 可回退",
          };
        }
        const fallback = await putFileIntoInput(url, filename, selector);
        if (!fallback.ok) {
          return {
            ok: false,
            error:
              (cdpErr ? "CDP 失败: " + cdpErr + "；回退也失败: " : "") +
              (fallback.error || "未知错误"),
            detail: fallback.detail || null,
          };
        }
        put = fallback;
        if (cdpErr) {
          put.detail = Object.assign({}, put.detail || {}, {
            cdp_error: cdpErr,
            method: "datatransfer_fallback",
          });
        }
      }
      putDetail = put.detail || {};

      const waited = await waitForTitleInput(UPLOAD_WAIT_MS);
      if (!waited || !waited.ok) {
        return {
          ok: false,
          error: (waited && waited.error) || "等待编辑页失败",
          detail: Object.assign({}, putDetail, {
            saw_progress: !!(waited && waited.saw_progress),
            page_url: location.href || "",
          }),
        };
      }
    }

    const filled = fillTitle(titleText);
    if (!filled.ok) {
      filled.detail = Object.assign({}, putDetail, filled.detail || {});
      return filled;
    }

    return await finishPublishAfterTitle(filled.detail || {}, putDetail, {
      visibility: visKey,
      description: opts.description || "",
      cover_local_path: opts.cover_local_path || "",
      cover_url: opts.cover_url || "",
      cover_filename: opts.cover_filename || "",
      cover_orientation: opts.cover_orientation || "vertical",
      cover_debug_pause: opts.cover_debug_pause,
      cover_both: opts.cover_both,
      collection: opts.collection,
      declaration: opts.declaration,
      hotspot: opts.hotspot,
      submit: opts.submit,
    });
  }

  function fillTitle(titleText) {
    const el = findTitleInput();
    if (!el) {
      return { ok: false, error: "找不到标题输入框" };
    }
    try {
      el.focus();
      _setNativeValue(el, titleText);
    } catch (e) {
      return {
        ok: false,
        error: "填标题失败：" + String((e && e.message) || e),
      };
    }
    const got = String(el.value || "");
    if (got !== titleText) {
      // React 有时会截断或异步回写；再试一次后仍不一致就报错，不假装成功。
      _setNativeValue(el, titleText);
      if (String(el.value || "") !== titleText) {
        return {
          ok: false,
          error:
            "标题写入后回读不一致（期望 " +
            JSON.stringify(titleText) +
            "，实际 " +
            JSON.stringify(el.value) +
            "）",
          detail: { title_written: String(el.value || "") },
        };
      }
    }
    return {
      ok: true,
      error: "",
      detail: { title_written: titleText },
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === "ping") {
      // 任意 frame 可应答；动作指令只让 top 执行，避免 all_frames 下重复 POST
      sendResponse({ ok: true, top: window === window.top });
      return true;
    }

    // all_frames=true 时每个 iframe 都会收到指令；只允许顶层执行出站动作
    if (window !== window.top) {
      return;
    }

    if (msg.type === "call_api") {
      callApiInPage(msg.action, msg.args)
        .then((data) => sendResponse({ data }))
        .catch((e) =>
          sendResponse({ data: { error: String((e && e.message) || e) } })
        );
      return true; // async
    }

    if (msg.type === "send_raw") {
      // 主路径：Hermes 已经把请求体拼好，这里只负责用页面身份 POST 出去。
      sendRawViaPage(msg.body_b64)
        .then((r) => sendResponse(r))
        .catch((e) =>
          sendResponse({ ok: false, error: String((e && e.message) || e) })
        );
      return true; // async
    }

    if (msg.type === "post_imapi") {
      postImapiViaPage(msg.url, msg.body_b64)
        .then((r) => sendResponse(r))
        .catch((e) =>
          sendResponse({ ok: false, error: String((e && e.message) || e) })
        );
      return true; // async
    }

    if (msg.type === "post_form") {
      // 通用 form POST（发评论等）。同样必须在主世界发 —— 隔离世界里没有
      // 字节的 security-secsdk，签名参数不会被自动补上。
      postFormViaPage(msg.url, msg.fields)
        .then((r) => sendResponse(r))
        .catch((e) =>
          sendResponse({ ok: false, error: String((e && e.message) || e) })
        );
      return true; // async
    }

    if (msg.type === "get_json") {
      // 通用 GET JSON（评论列表 / 搜索）。主世界发，secsdk 可在 send 时补签。
      getJsonViaPage(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) =>
          sendResponse({ ok: false, error: String((e && e.message) || e) })
        );
      return true; // async
    }

    if (msg.type === "put_file") {
      putFileIntoInput(msg.url, msg.filename, msg.selector)
        .then((r) => sendResponse(r))
        .catch((e) =>
          sendResponse({ ok: false, error: String((e && e.message) || e) })
        );
      return true; // async
    }

    if (msg.type === "publish_prepare") {
      publishPrepare(msg.url, msg.filename, msg.title, msg.local_path, {
        visibility: msg.visibility,
        description: msg.description,
        cover_local_path: msg.cover_local_path,
        cover_url: msg.cover_url,
        cover_filename: msg.cover_filename,
        cover_orientation: msg.cover_orientation,
        cover_debug_pause: msg.cover_debug_pause,
        cover_both: msg.cover_both,
        collection: msg.collection,
        declaration: msg.declaration,
        hotspot: msg.hotspot,
        submit: msg.submit,
      })
        .then((r) => sendResponse(r))
        .catch((e) =>
          sendResponse({ ok: false, error: String((e && e.message) || e) })
        );
      return true; // async
    }

    if (msg.type === "list_hotspots") {
      listHotspots(msg.query || "")
        .then((r) => sendResponse(r))
        .catch((e) =>
          sendResponse({ ok: false, error: String((e && e.message) || e) })
        );
      return true; // async
    }

    if (msg.type === "send_text") {
      // 兜底路径：DOM 模拟。只在没有发送模板时才会走到（见 sender.py）。
      sendText(msg.conversation_id, msg.text, !!msg.allow_blind)
        .then((r) => sendResponse(r))
        .catch((e) =>
          sendResponse({ ok: false, error: String((e && e.message) || e) })
        );
      return true; // async
    }
  });
})();
