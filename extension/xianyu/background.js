// background.js (MV3 Service Worker) —— 维持与 DSH 客服中心本地桥的 WebSocket 连接。
//
// 职责：
// - 连接 ws://127.0.0.1:<port>/ws（默认 8765），用配对码握手
// - content.js 上报的帧/告警 → 按 DSH 桥协议转发
// - DSH 下发的指令 → 转发给对应标签页的 content.js 执行
//
// 注意：MV3 service worker 会休眠。用 chrome.alarms 周期唤醒 + 断线重连
// 维持长连接的可用性。连接/重连/配对码/保活逻辑移植自抖音扩展（平台无关）。
//
// 协议要点（与 DSH 桥冻结的版本对齐）：
//   扩展 → 桥: hello / frame / user_info / risk_alert / current_chat /
//              platform_account / api_result / cmd_result
//   桥 → 扩展: hello_ack / send_text / send_image / call_api
// 页面 ↔ 扩展内部标记（__hermes_xianyu__ / __hermesHooked 等）是跨文件契约，
// 与本协议无关，保持原名不动。

// 扩展版本 + 能力清单。随 hello 上报给桥 —— 面板据此确认浏览器里跑的版本与能力。
// 改了扩展代码记得 bump 这里，否则诊断会误导。
const EXT_VERSION = "0.2.0";
const EXT_FEATURES = [
  "frame",
  "send_text",
  "send_image",
  "call_api",
  "mtop",
  "publish_item",
  "read_page",
  "user_info",
  "current_chat",
  "risk_alert",
  "platform_account",
];
const PLATFORM = "xianyu";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;

let socket = null;
let reconnectTimer = null;
let connectWatchdog = null;
let connectAttempts = 0;
// 配对码被桥拒绝(hello_ack ok=false)→ 停止自动重连,直到用户重新保存配对码。
let pairCodeRejected = false;
let config = { host: DEFAULT_HOST, port: DEFAULT_PORT, pairCode: "", accountId: "default" };

// 平台账号昵称（闲鱼页面暂未暴露卖家昵称，先留空；platform_account 仍上报 id）。
let selfNickname = "";

// 自愈(断线/未 hook 自动刷新):
let connectedAt = 0;          // 最近一次连上桥的时刻
let lastHookAt = 0;           // 最近一次收到页面 ws 已 hook 信号的时刻
let hookCheckTimer = null;    // "连上桥但页面没 hook" 的检查定时器
const _reloadHistory = {};    // tabId -> [近期自动刷新时间戳](节流防刷新风暴)

// 同一 tab 10 分钟内最多自动刷新 3 次,超过就停(避免坏页面被无限刷)。
function _canAutoReload(tabId) {
  const now = Date.now();
  const arr = (_reloadHistory[tabId] || []).filter((t) => now - t < 10 * 60 * 1000);
  _reloadHistory[tabId] = arr;
  return arr.length < 3;
}

// 自动刷新所有 goofish 标签页(带节流),让页面 ws 重新挂载。
function reloadGoofishTabs(reason) {
  try {
    chrome.tabs.query({ url: "*://*.goofish.com/*" }, function (tabs) {
      (tabs || []).forEach(function (t) {
        if (t.id == null) return;
        if (!_canAutoReload(t.id)) {
          console.info("[DSH闲鱼] 跳过自动刷新(已达上限) tab", t.id);
          return;
        }
        _reloadHistory[t.id].push(Date.now());
        console.info("[DSH闲鱼] 自动刷新闲鱼页(" + reason + ") tab", t.id);
        try { chrome.tabs.reload(t.id); } catch (_) {}
      });
    });
  } catch (_) {}
}

// 连上桥后启动检查:N 秒内没收到 ws_hooked(页面没接上)→ 刷新 goofish 页兜底。
function scheduleHookCheck() {
  connectedAt = Date.now();
  if (hookCheckTimer) { clearTimeout(hookCheckTimer); hookCheckTimer = null; }
  const mark = connectedAt;
  hookCheckTimer = setTimeout(function () {
    // 这次连接之后没收到过 hook 信号 → 页面可能没接上,刷一次。
    if (connectedAt === mark && lastHookAt < mark) {
      reloadGoofishTabs("connected-but-not-hooked");
    }
  }, 20000);
}

// 连接看门狗超时(毫秒):单次尝试多久没握手成功就重试。
const CONNECT_TIMEOUT_MS = 6000;
// 桥首次启动(gateway import)可能要数十秒,持续重试到这么多次才真正报错。
const MAX_CONNECT_ATTEMPTS = 20;

async function loadConfig() {
  const stored = await chrome.storage.local.get([
    "host",
    "port",
    "pairCode",
    "accountId",
    "detectedAccountId",
  ]);
  config.host = stored.host || DEFAULT_HOST;
  config.port = stored.port || DEFAULT_PORT;
  config.pairCode = stored.pairCode || "";
  // 优先用探测到的真实 unb;否则回退到手填/默认(兼容旧配置)。
  config.accountId = stored.detectedAccountId || stored.accountId || "default";
}

function wsUrl() {
  return `ws://${config.host}:${config.port}/ws`;
}

// 统一的“发给桥”入口：未连接时静默丢弃（与 DSH 桥 trySend 语义一致）。
function sendToBridge(obj) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(obj));
    return true;
  } catch (_) {
    return false;
  }
}

// 平台账号注册：DSH 桥用 platform_account 给账号卡片命名/归属。
// 闲鱼账号 id 来自 cookie unb；昵称拿不到时上报空串（桥侧会先用 id 占位）。
function sendPlatformAccount() {
  const accountId = (config.accountId || "").trim();
  if (!accountId || accountId === "default") return;
  sendToBridge({
    type: "platform_account",
    platform: PLATFORM,
    account_id: accountId,
    nickname: selfNickname,
  });
}

function setStatus(connected) {
  chrome.storage.local.set({ connected: !!connected });
  try {
    chrome.action.setBadgeText({ text: connected ? "ON" : "" });
    chrome.action.setBadgeBackgroundColor({ color: connected ? "#2ea043" : "#888" });
  } catch (_) {}
}

// 细粒度连接状态(popup 用来给出明确反馈)。
// state: "idle" | "connecting" | "connected" | "error"
function setConnState(state, error) {
  chrome.storage.local.set({
    connState: state,
    connError: error || "",
    connected: state === "connected",
  });
  try {
    const badge =
      state === "connected" ? "ON" : state === "connecting" ? "…" : state === "error" ? "!" : "";
    const color =
      state === "connected" ? "#2ea043" : state === "error" ? "#d1242f" : "#888";
    chrome.action.setBadgeText({ text: badge });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) {}
}

function clearWatchdog() {
  if (connectWatchdog) {
    clearTimeout(connectWatchdog);
    connectWatchdog = null;
  }
}

function forceCloseSocket() {
  if (socket) {
    try {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    } catch (_) {}
  }
  socket = null;
}

async function connect() {
  await loadConfig();
  // 配对码已被桥拒绝过 → 不再自动重连,等用户改码重连(connect_now 会清此标记)。
  if (pairCodeRejected) {
    return;
  }
  if (!config.pairCode) {
    setConnState("error", "未填写配对码");
    console.warn("[DSH闲鱼] 未设置配对码，先在 popup 配置");
    return;
  }
  // 已经连上的不重连;但 CONNECTING 卡住的 socket 不能挡住新连接 ——
  // 直接丢弃重来(这正是「一直连接中」的根因之一)。
  if (socket && socket.readyState === WebSocket.OPEN) {
    setConnState("connected", "");
    return;
  }
  forceCloseSocket();

  setConnState("connecting", "");
  try {
    socket = new WebSocket(wsUrl());
  } catch (e) {
    console.warn("[DSH闲鱼] 建立 WS 失败", e);
    setConnState("error", "无法连接桥地址 " + wsUrl());
    scheduleReconnect();
    return;
  }

  // 看门狗:单次尝试超时仍未握手 → 自动重试(桥首次启动要数十秒,不能直接判死)。
  const watchedSocket = socket;
  clearWatchdog();
  connectWatchdog = setTimeout(() => {
    if (watchedSocket && watchedSocket.readyState !== WebSocket.OPEN) {
      try { watchedSocket.close(); } catch (_) {}
      connectAttempts += 1;
      if (connectAttempts >= MAX_CONNECT_ATTEMPTS) {
        setConnState(
          "error",
          "连接超时:确认 DSH 客服中心已打开、桥地址/端口正确(默认 127.0.0.1:8765)"
        );
      } else {
        // 仍在等桥就绪:保持 connecting 态,提示重试中,继续连。
        setConnState("connecting", `桥启动中,自动重试…(${connectAttempts})`);
        scheduleReconnect();
      }
    }
  }, CONNECT_TIMEOUT_MS);

  socket.onopen = function () {
    // 握手：pair_code + account_id + 版本/能力/平台（DSH 桥据此登记能力卡）
    socket.send(
      JSON.stringify({
        type: "hello",
        pair_code: config.pairCode,
        account_id: config.accountId,
        ext_version: EXT_VERSION,
        features: EXT_FEATURES,
        platform: PLATFORM,
      })
    );
    // 注意:此处不立刻判 connected —— 要等桥回 hello_ack 才算配对成功。
    console.info("[DSH闲鱼] WS 已打开,等待配对确认…");
  };

  socket.onmessage = function (event) {
    let msg = null;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    if (!msg || !msg.type) return;

    if (msg.type === "hello_ack") {
      clearWatchdog();
      // 桥确认配对结果
      if (msg.ok === false) {
        setConnState("error", "配对码不正确");
        pairCodeRejected = true;  // 停止自动重连,等用户改码
        try { socket.close(); } catch (_) {}
      } else {
        setConnState("connected", "");
        connectAttempts = 0;
        console.info("[DSH闲鱼] 已连接 DSH 桥");
        // 连上桥后,确保有一个后台 goofish 页维持账号级 ws(关键:这样不用一直
        // 手动开着网页也能持续收买家消息)。
        try { ensureKeepAliveTab(); } catch (_) {}
        // 自愈:连上桥后启动"页面 hook 检查"——若 20s 内没收到页面 ws 已 hook
        // 的信号(ws_hooked),说明 goofish 页可能没接上(先开页后连扩展的经典
        // 症状),自动刷新该页一次兜底。
        try { scheduleHookCheck(); } catch (_) {}
        // 上报平台账号（桥用它在面板里建 xianyu 账号卡）。
        try { sendPlatformAccount(); } catch (_) {}
      }
      return;
    }

    // 需要返回值的 call_api：拿到结果回传
    if (msg.type === "call_api") {
      // 发品(publish_item):需要先确保有一个发布页 tab,在那个 tab 跑 DOM 流程。
      // 页面勘查(read_page) target=publish 时同样确保发布页 tab 再读。
      const needPublishTab =
        msg.action === "publish_item" ||
        (msg.action === "read_page" && msg.args && msg.args.target === "publish");
      if (needPublishTab) {
        ensurePublishTabThen(msg, (resp) => {
          sendToBridge({
            type: "api_result",
            req_id: msg.req_id,
            data: (resp && resp.data) || { error: "no_response" },
          });
        });
        return;
      }
      forwardToActiveTab(msg, (resp) => {
        sendToBridge({
          type: "api_result",
          req_id: msg.req_id,
          data: (resp && resp.data) || { error: "no_response" },
        });
      });
      return;
    }

    // 其余动作指令（send_text / send_image）转给 content.js。
    // 带 ack 的指令(发图)需要把 content.js 的真实执行结果回传给桥,
    // 让 DSH 侧知道"到底发出去没"(发图涉及上传 CDN,可能失败)。
    if (msg.ack && msg.req_id) {
      forwardToActiveTab(msg, (resp) => {
        const r = (resp && resp.data) || resp || {};
        sendToBridge({
          type: "cmd_result",
          req_id: msg.req_id,
          ok: !!r.ok,
          error: r.error || (r.ok ? "" : "扩展执行失败或页面无响应"),
        });
      });
      return;
    }
    forwardToActiveTab(msg, null);
  };

  socket.onclose = function () {
    clearWatchdog();
    // 已是 error(如配对失败/超时)就保留错误,否则标记断开。
    // 配对码不正确(pairBad)时**不再自动重连**,避免拿错码疯狂重试刷爆桥日志;
    // 用户改了配对码点保存(connect_now)会重置 pairBad 并重连。
    chrome.storage.local.get(["connState", "connError"], (s) => {
      const wrongCode = s.connState === "error" && /配对码不正确/.test(s.connError || "");
      if (s.connState !== "error") {
        setConnState("idle", "");
      }
      if (!wrongCode) {
        scheduleReconnect();
      } else {
        console.info("[DSH闲鱼] 配对码不正确,已停止自动重连;请填正确配对码后保存");
      }
    });
  };

  socket.onerror = function () {
    clearWatchdog();
    setConnState("error", "连接桥失败,请确认 DSH 客服中心已打开且端口正确");
    try {
      socket.close();
    } catch (_) {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

// 把指令转发给 goofish 标签页的 content.js。
//
// 关键:可能有多个 goofish 标签页,且某些标签页的 content.js 可能不可达
// (扩展刚重载、页面没刷新 → 上下文失效)。所以:
// 1) 优先 active 的标签页,再逐个尝试其余 goofish 标签页;
// 2) 每次都检查 chrome.runtime.lastError —— 不可达就换下一个;
// 3) 全部不可达时回传明确错误 content_no_response(而不是笼统 no_response),
//    让 DSH 侧能告诉用户「刷新闲鱼页面」,而不是误判成「订单查不到」。
function forwardToActiveTab(msg, callback) {
  chrome.tabs.query({ url: "*://*.goofish.com/*" }, function (tabs) {
    if (!tabs || tabs.length === 0) {
      if (callback) callback({ data: { error: "no_goofish_tab" } });
      return;
    }
    const ordered = tabs
      .slice()
      .sort((a, b) => (b.active === true) - (a.active === true));
    let idx = 0;
    function tryNext() {
      if (idx >= ordered.length) {
        if (callback) {
          callback({
            data: {
              error: "content_no_response",
              detail: "goofish 页面未应答(扩展可能刚重载),请刷新闲鱼页面后重试",
            },
          });
        }
        return;
      }
      const tabId = ordered[idx++].id;
      try {
        chrome.tabs.sendMessage(tabId, msg, function (resp) {
          const err = chrome.runtime.lastError;
          if (err || !resp) {
            // 该标签页 content.js 不可达,换下一个
            tryNext();
            return;
          }
          if (callback) callback(resp);
        });
      } catch (e) {
        tryNext();
      }
    }
    tryNext();
  });
}

// 发品:确保有一个停在发布页(www.goofish.com/publish)的 tab,等它加载完,
// 再把 publish_item 指令发给那个 tab 的 content.js(它在发布页跑 DOM 流程)。
// 复用现成 goofish tab:有发布页 tab 直接用;有其它 goofish tab 就把它导航到
// 发布页;都没有就新开一个。导航后等 content.js ready(轮询 ping)再下发。
const PUBLISH_URL = "https://www.goofish.com/publish";

function ensurePublishTabThen(msg, callback) {
  chrome.tabs.query({ url: "*://*.goofish.com/*" }, function (tabs) {
    tabs = tabs || [];
    let pubTab = tabs.find((t) => /\/publish/.test(t.url || ""));
    if (pubTab) {
      // 已在发布页:直接(等一下确保 content 就绪)下发。
      sendToTabWhenReady(pubTab.id, msg, callback);
      return;
    }
    if (tabs.length > 0) {
      // 复用一个现有 goofish tab,导航到发布页。
      const tabId = tabs[0].id;
      chrome.tabs.update(tabId, { url: PUBLISH_URL, active: true }, function () {
        waitTabComplete(tabId, () => sendToTabWhenReady(tabId, msg, callback));
      });
      return;
    }
    // 没有任何 goofish tab:新开一个发布页。
    chrome.tabs.create({ url: PUBLISH_URL, active: true }, function (tab) {
      waitTabComplete(tab.id, () => sendToTabWhenReady(tab.id, msg, callback));
    });
  });
}

// 等某 tab 加载到 complete(最多 ~30s)。
function waitTabComplete(tabId, done) {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
    // 加载完成后再宽限一会,让 React 发布页渲染。
    setTimeout(done, 2500);
  };
  function listener(id, info) {
    if (id === tabId && info.status === "complete") finish();
  }
  chrome.tabs.onUpdated.addListener(listener);
  // 兜底超时
  setTimeout(finish, 30000);
  // 可能已经 complete 了
  try {
    chrome.tabs.get(tabId, function (t) {
      if (t && t.status === "complete") finish();
    });
  } catch (_) {}
}

// 给指定 tab 发指令,带重试(content.js 可能还没就绪)。
function sendToTabWhenReady(tabId, msg, callback, attempt) {
  attempt = attempt || 0;
  try {
    chrome.tabs.sendMessage(tabId, msg, function (resp) {
      const err = chrome.runtime.lastError;
      if (err || !resp) {
        if (attempt < 10) {
          setTimeout(() => sendToTabWhenReady(tabId, msg, callback, attempt + 1), 1500);
        } else if (callback) {
          callback({ data: { error: "content_no_response", detail: "发布页未应答,请刷新发布页重试" } });
        }
        return;
      }
      if (callback) callback(resp);
    });
  } catch (e) {
    if (attempt < 10) {
      setTimeout(() => sendToTabWhenReady(tabId, msg, callback, attempt + 1), 1500);
    } else if (callback) {
      callback({ data: { error: "send_failed", detail: String(e) } });
    }
  }
}

// content.js 上报的帧/告警 → 桥;popup 的「立即连接」请求 → connect()
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (msg.type === "account_detected") {
    // content.js 探测到当前登录的闲鱼 unb。作为 account_id 持久化;若与当前
    // 配置不同(用户在该 Profile 切换了账号),更新并触发重连用新身份握手。
    const detected = (msg.account_id || "").trim();
    if (detected && detected !== config.accountId) {
      config.accountId = detected;
      chrome.storage.local.set({ accountId: detected, detectedAccountId: detected });
      // 已连接的话,用新身份重连(账号变了);重连握手后会补发 platform_account。
      if (socket && socket.readyState === WebSocket.OPEN) {
        clearWatchdog();
        forceCloseSocket();
        connectAttempts = 0;
        connect();
      }
    } else if (detected) {
      chrome.storage.local.set({ detectedAccountId: detected });
      // 账号未变 → 直接补报一次平台账号（桥可能刚重启/刚连上）。
      sendPlatformAccount();
    }
    if (sendResponse) sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "connect_now") {
    // popup 保存后请求立即(重)连。先彻底断开旧连接再连。重置重试计数。
    clearWatchdog();
    forceCloseSocket();
    connectAttempts = 0;
    pairCodeRejected = false;  // 用户改了配对码,解除"拒绝重连"封印
    connect();
    if (sendResponse) sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "seed_pair") {
    // 一键托管:专属 Chrome 启动 URL 带的一次性配对码(content.js 播种)。
    // 存进 storage 并立即连桥,免用户手填配对码。
    const code = (msg.pairCode || "").trim();
    if (code) {
      const patch = { pairCode: code };
      if (msg.port) patch.port = msg.port;
      chrome.storage.local.set(patch, function () {
        config.pairCode = code;
        if (msg.port) config.port = msg.port;
        // 已连着同一个码就不折腾;否则(重)连。
        if (socket && socket.readyState === WebSocket.OPEN) {
          if (sendResponse) sendResponse({ ok: true, already: true });
          return;
        }
        clearWatchdog();
        forceCloseSocket();
        connectAttempts = 0;
        pairCodeRejected = false;
        connect();
        if (sendResponse) sendResponse({ ok: true });
      });
      return true;  // async sendResponse
    }
    if (sendResponse) sendResponse({ ok: false });
    return true;
  }

  // ── 以下为 content.js → 桥的上行转发（载荷严格按 DSH 桥协议）──────────────
  if (msg.type === "frame") {
    if (msg.raw) sendToBridge({ type: "frame", raw: msg.raw });
    return;
  }
  if (msg.type === "risk_alert") {
    sendToBridge({ type: "risk_alert", detail: msg.detail || "" });
    return;
  }
  if (msg.type === "ws_hooked") {
    // content/injected 报告:goofish 页面消息长连接已成功 hook。记录时间戳,
    // 供"连上桥但页面没 hook → 自动刷新"的检查判定(此信号与买家活跃无关)。
    lastHookAt = Date.now();
    return;
  }
  if (msg.type === "current_chat") {
    // 页面暴露的"当前正在看的会话",转给桥(发图等据此定向)。
    sendToBridge({
      type: "current_chat",
      chat_id: msg.chat_id || "",
      buyer_id: msg.buyer_id || "",
    });
    return;
  }
  if (msg.type === "user_info") {
    const users = Array.isArray(msg.users) ? msg.users : [];
    if (!users.length) return;
    console.info("[DSH闲鱼] SW←user_info", users.length);
    sendToBridge({ type: "user_info", users: users });
    return;
  }
});

// ── 保活 goofish 标签页 ────────────────────────────────────────────────────
// 寄生方案下,买家消息走的是 goofish 页面自己的账号级 WebSocket。页面没了 ws 就
// 没了 → 收不到消息。所以扩展确保**始终有一个 goofish 标签页在后台跑着**(用户
// 不用盯着、最小化也行)。没有就后台开一个(不抢焦点);被关了就重开。
// 边界:浏览器完全关掉仍收不到(扩展能力之外)——这是"不用主动盯网页"而非"关浏览器也收"。

const KEEPALIVE_URL = "https://www.goofish.com/im";
let keepAliveTabId = null;
let openingKeepAlive = false;

function hasGoofishTab(cb) {
  try {
    chrome.tabs.query({ url: "*://*.goofish.com/*" }, function (tabs) {
      cb(tabs && tabs.length > 0 ? tabs : []);
    });
  } catch (_) {
    cb([]);
  }
}

// 确保有一个 goofish 标签页在跑:有现成的就复用(记下其一作为保活 tab),
// 没有才后台开一个。避免开一堆 tab。
function ensureKeepAliveTab() {
  if (openingKeepAlive) return;
  hasGoofishTab(function (tabs) {
    if (tabs.length > 0) {
      // 已有 goofish 页:复用,记住其中一个(优先已记录的那个还在的话)。
      const existing = tabs.find((t) => t.id === keepAliveTabId);
      keepAliveTabId = existing ? existing.id : tabs[0].id;
      return;
    }
    // 没有任何 goofish 页 → 后台开一个保活页(不抢焦点)。
    openingKeepAlive = true;
    try {
      chrome.tabs.create({ url: KEEPALIVE_URL, active: false, pinned: true }, function (tab) {
        openingKeepAlive = false;
        if (chrome.runtime.lastError || !tab) {
          console.info("[DSH闲鱼] 后台开保活页失败", chrome.runtime.lastError);
          return;
        }
        keepAliveTabId = tab.id;
        console.info("[DSH闲鱼] 已在后台开保活 goofish 页", tab.id);
      });
    } catch (e) {
      openingKeepAlive = false;
    }
  });
}

// 保活 tab 被关掉 → 延迟几秒重开(用户手动关了那个后台页也兜回来)。
try {
  chrome.tabs.onRemoved.addListener(function (tabId) {
    if (tabId === keepAliveTabId) {
      keepAliveTabId = null;
      setTimeout(ensureKeepAliveTab, 4000);
    }
  });
} catch (_) {}


// 周期唤醒 + 保活。chrome.alarms 需要 "alarms" 权限;做防御性判断,
// 缺权限/不可用时退化为 setInterval,绝不让 service worker 因此崩溃。
function keepaliveTick() {
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    connect();
  }
  // 顺带守护保活页:已配对(有码且没被拒)才维持后台 goofish 页,
  // 避免用户还没配置就乱开网页。
  if (config.pairCode && !pairCodeRejected) {
    ensureKeepAliveTab();
  }
}

try {
  if (chrome.alarms && typeof chrome.alarms.create === "function") {
    chrome.alarms.create("dsh-xianyu-keepalive", { periodInMinutes: 0.4 });
    chrome.alarms.onAlarm.addListener(function (alarm) {
      if (alarm.name === "dsh-xianyu-keepalive") keepaliveTick();
    });
  } else {
    setInterval(keepaliveTick, 25000);
  }
} catch (e) {
  try { setInterval(keepaliveTick, 25000); } catch (_) {}
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// popup 改配置后通知重连
// 注:配置变更后的(重)连由 popup 的 ``connect_now`` 消息显式触发(见上面的
// onMessage 监听),不再在 storage.onChanged 里重复 connect,避免两条路径同时
// close+connect 互相打断。这里只在「配置变了但没走 connect_now」的兜底场景下
// (理论上不会发生)留空。

connect();
