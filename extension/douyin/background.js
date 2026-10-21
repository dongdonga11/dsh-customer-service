// background.js (MV3 Service Worker) —— 维持与 Hermes 本地桥的 WebSocket 连接。
//
// 职责：
// - 连接 ws://127.0.0.1:<port>/ws，用配对码握手
// - content.js 上报的帧/告警 → 转发给 Hermes
// - Hermes 下发的指令 → 转发给 douyin 标签页的 content.js 执行
//
// 注意：MV3 service worker 会休眠。用 chrome.alarms 周期唤醒 + 断线重连维持
// 长连接的可用性。结构移植自闲鱼扩展（这套连接维持逻辑与平台无关）。

// 扩展版本 + 能力清单。随 hello 上报给桥 —— 这样 Hermes 侧能**确定**浏览器里跑的
// 是哪一版，而不是靠超时去猜。改了扩展代码记得 bump 这里，否则诊断会误导。
const EXT_VERSION = "0.9.14";
const EXT_FEATURES = [
  "frame",
  "send_template",
  "send_raw",
  "call_api",
  "probe",
  "post_form",
  "get_json",
  "post_imapi",
  "create_template",
  "user_info",
  "put_file",
  "publish_prepare",
  "list_hotspots",
];

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8766; // 闲鱼用 8765，两个桥可同时跑
const DOUYIN_TAB_GLOB = "*://*.douyin.com/*";
const LAIKE_TAB_GLOB = "*://life.douyin.com/*";
const KEEPALIVE_URL = "https://www.douyin.com/user/self";
// 投稿入口：拖拽区 + 隐藏 file input。填完文件后页面自己跳到 post/video。
const CREATOR_UPLOAD_URL =
  "https://creator.douyin.com/creator-micro/content/upload?enter_from=dou_web";
const CREATOR_TAB_GLOB = "*://creator.douyin.com/*";

let socket = null;
let reconnectTimer = null;
let connectWatchdog = null;
let connectAttempts = 0;
// 配对码被桥拒绝(hello_ack ok=false) → 停止自动重连，直到用户重新保存配对码。
let pairCodeRejected = false;
let config = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  pairCode: "",
  accountId: "default",
};

// 自愈（断线 / 页面未 hook 自动刷新）：
let connectedAt = 0; // 最近一次连上桥的时刻
let lastHookAt = 0; // 最近一次收到页面 ws 已 hook 信号的时刻
let hookCheckTimer = null;
const _reloadHistory = {}; // tabId -> [近期自动刷新时间戳]（节流防刷新风暴）

// 单次连接尝试的握手超时；桥首次启动可能要数十秒，所以持续重试到上限才报错。
const CONNECT_TIMEOUT_MS = 6000;
const MAX_CONNECT_ATTEMPTS = 20;

// 同一 tab 10 分钟内最多自动刷新 3 次，避免坏页面被无限刷。
function _canAutoReload(tabId) {
  const now = Date.now();
  const arr = (_reloadHistory[tabId] || []).filter((t) => now - t < 10 * 60 * 1000);
  _reloadHistory[tabId] = arr;
  return arr.length < 3;
}

// life.douyin.com 是**来客客服工作台**，不属于「抖音私信」这条流程：
//   - 它没有 frontier 长连接（ws_hooked 永远不会来）
//   - 更不能被"没 hook 就自动刷新"误伤 —— 刷新会丢掉工作台里打开的会话
// 所以凡是「抖音标签页」的地方都要把它排除掉。
function isLaikeUrl(url) {
  return /^https?:\/\/life\.douyin\.com\//i.test(String(url || ""));
}

function douyinTabsOnly(tabs) {
  return (tabs || []).filter(function (t) {
    return !isLaikeUrl(t.url);
  });
}

function reloadDouyinTabs(reason) {
  try {
    chrome.tabs.query({ url: DOUYIN_TAB_GLOB }, function (tabs) {
      douyinTabsOnly(tabs).forEach(function (t) {
        if (t.id == null) return;
        if (!_canAutoReload(t.id)) {
          console.info("[DSH 客服] 跳过自动刷新(已达上限) tab", t.id);
          return;
        }
        _reloadHistory[t.id].push(Date.now());
        console.info("[DSH 客服] 自动刷新抖音页(" + reason + ") tab", t.id);
        try {
          chrome.tabs.reload(t.id);
        } catch (_) {}
      });
    });
  } catch (_) {}
}

// 连上桥后启动检查：N 秒内没收到 ws_hooked（页面没接上）→ 刷新抖音页兜底。
// 典型场景：用户先开了抖音页，之后才装/连扩展 —— 页面的 frontier 连接早就建好，
// hook 挂不上，必须刷一次页面。
function scheduleHookCheck() {
  connectedAt = Date.now();
  if (hookCheckTimer) {
    clearTimeout(hookCheckTimer);
    hookCheckTimer = null;
  }
  const mark = connectedAt;
  hookCheckTimer = setTimeout(function () {
    if (connectedAt === mark && lastHookAt < mark) {
      reloadDouyinTabs("connected-but-not-hooked");
    }
  }, 20000);
}

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
  config.accountId = stored.detectedAccountId || stored.accountId || "default";
}

function wsUrl() {
  return `ws://${config.host}:${config.port}/ws`;
}

// state: "idle" | "connecting" | "connected" | "error"
function setConnState(state, error) {
  chrome.storage.local.set({
    connState: state,
    connError: error || "",
    connected: state === "connected",
  });
  try {
    const badge =
      state === "connected"
        ? "ON"
        : state === "connecting"
        ? "…"
        : state === "error"
        ? "!"
        : "";
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
  if (pairCodeRejected) return;
  if (!config.pairCode) {
    setConnState("error", "未填写配对码");
    console.warn("[DSH 客服] 未设置配对码，先在 popup 配置");
    return;
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    setConnState("connected", "");
    return;
  }
  // CONNECTING 卡住的 socket 不能挡住新连接 —— 直接丢弃重来。
  forceCloseSocket();

  setConnState("connecting", "");
  try {
    socket = new WebSocket(wsUrl());
  } catch (e) {
    console.warn("[DSH 客服] 建立 WS 失败", e);
    setConnState("error", "无法连接桥地址 " + wsUrl());
    scheduleReconnect();
    return;
  }

  const watchedSocket = socket;
  clearWatchdog();
  connectWatchdog = setTimeout(() => {
    if (watchedSocket && watchedSocket.readyState !== WebSocket.OPEN) {
      try {
        watchedSocket.close();
      } catch (_) {}
      connectAttempts += 1;
      if (connectAttempts >= MAX_CONNECT_ATTEMPTS) {
        setConnState(
          "error",
          "连接超时：确认 DSH 客服中心已打开、桥地址/端口正确(默认 127.0.0.1:8766)"
        );
      } else {
        setConnState("connecting", `桥启动中，自动重试…(${connectAttempts})`);
        scheduleReconnect();
      }
    }
  }, CONNECT_TIMEOUT_MS);

  socket.onopen = function () {
    socket.send(
      JSON.stringify({
        type: "hello",
        pair_code: config.pairCode,
        account_id: config.accountId,
        ext_version: EXT_VERSION,
        features: EXT_FEATURES,
      })
    );
    // 此处不立刻判 connected —— 要等桥回 hello_ack 才算配对成功。
    console.info("[DSH 客服] WS 已打开，等待配对确认…");
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
      if (msg.ok === false) {
        setConnState("error", "配对码不正确");
        pairCodeRejected = true;
        try {
          socket.close();
        } catch (_) {}
      } else {
        setConnState("connected", "");
        connectAttempts = 0;
        console.info("[DSH 客服] 已连接 DSH 桥");
        try {
          ensureKeepAliveTab();
        } catch (_) {}
        try {
          scheduleHookCheck();
        } catch (_) {}
        try {
          // 把断线期间 / 未连上时抓到的模板补传给 Hermes
          setTimeout(replayStoredTemplates, 300);
        } catch (_) {}
      }
      return;
    }

    // 需要返回值的指令（探针开关/取结果等）：拿到 data 回传 api_result。
    if (msg.type === "call_api") {
      forwardByPlatform(msg, (resp) => {
        trySend({
          type: "api_result",
          req_id: msg.req_id,
          data: (resp && resp.data) || { error: "no_response" },
        });
      });
      return;
    }

    // 带 ack 的动作指令（send_text）：把 content.js 的真实执行结果回传给桥，
    // 让 Hermes 侧知道"到底发出去没"，而不是假装成功。
    if (msg.ack && msg.req_id) {
      const replyCmd = function (resp) {
        const r = resp || {};
        trySend({
          type: "cmd_result",
          req_id: msg.req_id,
          ok: !!r.ok,
          error: r.error || (r.ok ? "" : "扩展执行失败或页面无响应"),
          // 抖音的响应体原样带回 —— Hermes 靠它判定业务成败（抖音会用
          // HTTP 200 + status!=0 表示业务失败）。send_raw 是 protobuf 走
          // resp_b64，post_form 是 JSON 走 resp_text。put_file 等 DOM 动作
          // 走 detail（文件大小 / 接受的文件名之类的诊断字段）。
          resp_b64: r.resp_b64 || "",
          resp_text: r.resp_text || "",
          http_status: r.http_status || 0,
          detail: r.detail || null,
        });
      };
      // 投稿草稿必须打到创作者中心 upload 页，不能随便扔给一个抖音 tab。
      if (msg.type === "publish_prepare") {
        ensureCreatorUploadTabThen(msg, replyCmd);
        return;
      }
      // 热点列表必须在投稿编辑页刮；优先 post/video，否则任意创作者中心 tab。
      if (msg.type === "list_hotspots") {
        ensureCreatorPostTabThen(msg, replyCmd);
        return;
      }
      forwardByPlatform(msg, replyCmd);
      return;
    }
    forwardByPlatform(msg, null);
  };

  socket.onclose = function () {
    clearWatchdog();
    chrome.storage.local.get(["connState", "connError"], (s) => {
      const wrongCode =
        s.connState === "error" && /配对码不正确/.test(s.connError || "");
      if (s.connState !== "error") {
        setConnState("idle", "");
      }
      if (!wrongCode) {
        scheduleReconnect();
      } else {
        console.info("[DSH 客服] 配对码不正确，已停止自动重连");
      }
    });
  };

  socket.onerror = function () {
    clearWatchdog();
    setConnState("error", "连接桥失败，请确认 DSH 客服中心已打开且端口正确");
    try {
      socket.close();
    } catch (_) {}
  };
}

function trySend(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

// 模板本地备份：桥还没连上时页面已经点了「私信」，不能丢。
// 连上 hello_ack 后重放，避免「控制台已捕获但 can_create 仍 false」。
function persistAndSendTemplate(kind, payload) {
  const patch = {};
  if (kind === "send_template") {
    patch.lastSendTemplate = {
      body_b64: payload.body_b64 || "",
      at: Date.now(),
    };
  } else if (kind === "create_template") {
    patch.lastCreateTemplate = {
      body_b64: payload.body_b64 || "",
      at: Date.now(),
    };
  } else if (kind === "create_pair") {
    patch.lastCreatePair = {
      req_b64: payload.req_b64 || "",
      resp_b64: payload.resp_b64 || "",
      http_status: payload.http_status || 0,
      at: Date.now(),
    };
  }
  try {
    chrome.storage.local.set(patch);
  } catch (_) {}
  const ok = trySend(payload);
  if (!ok) {
    console.warn(
      "[DSH 客服] 桥未连接，已本地保存",
      kind,
      "—— 连上后会自动重传"
    );
  } else {
    console.info("[DSH 客服] 已经 WS 上报", kind);
  }
  // HTTP 旁路备份（桌面 sidecar 漏接类型时仍可入库）
  try {
    const host = config.host || "127.0.0.1";
    const port = config.port || 8766;
    fetch("http://" + host + ":" + port + "/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          console.info("[DSH 客服] SW HTTP ingest", kind, r.status, j);
        });
      })
      .catch(function (e) {
        console.warn(
          "[DSH 客服] SW HTTP ingest 失败",
          kind,
          e && e.message ? e.message : e
        );
      });
  } catch (_) {}
  return ok;
}

function replayStoredTemplates() {
  chrome.storage.local.get(
    ["lastSendTemplate", "lastCreateTemplate", "lastCreatePair"],
    function (s) {
      const acct = config.accountId || "default";
      if (s.lastSendTemplate && s.lastSendTemplate.body_b64) {
        trySend({
          type: "send_template",
          account_id: acct,
          body_b64: s.lastSendTemplate.body_b64,
        });
        console.info("[DSH 客服] 已重传本地发送模板");
      }
      if (s.lastCreateTemplate && s.lastCreateTemplate.body_b64) {
        trySend({
          type: "create_template",
          account_id: acct,
          body_b64: s.lastCreateTemplate.body_b64,
        });
        console.info("[DSH 客服] 已重传本地开聊模板");
      }
      if (s.lastCreatePair && (s.lastCreatePair.req_b64 || s.lastCreatePair.resp_b64)) {
        trySend({
          type: "create_pair",
          account_id: acct,
          req_b64: s.lastCreatePair.req_b64 || "",
          resp_b64: s.lastCreatePair.resp_b64 || "",
          http_status: s.lastCreatePair.http_status || 0,
        });
        console.info("[DSH 客服] 已重传本地 create_pair");
      }
    }
  );
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

// 把指令转发给抖音标签页的 content.js。
//
// 可能有多个抖音标签页，且某些页的 content.js 可能不可达（扩展刚重载、页面没
// 刷新 → 上下文失效）。所以：优先 active 页，逐个回退；全都不可达时回传明确的
// content_no_response，让 Hermes 能告诉用户「刷新抖音页面」而不是笼统失败。
function forwardToDouyinTab(msg, callback) {
  chrome.tabs.query({ url: DOUYIN_TAB_GLOB }, function (tabs) {
    tabs = douyinTabsOnly(tabs);
    if (!tabs || tabs.length === 0) {
      if (callback)
        callback({ ok: false, error: "no_douyin_tab: 浏览器里没有打开抖音页面" });
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
            ok: false,
            error:
              "content_no_response: 抖音页面未应答（扩展可能刚重载），请刷新抖音页面后重试",
          });
        }
        return;
      }
      const tabId = ordered[idx++].id;
      try {
        chrome.tabs.sendMessage(tabId, msg, function (resp) {
          const err = chrome.runtime.lastError;
          if (err || !resp) {
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

// 把指令转发给来客工作台标签页的 laike.js。
// 与 forwardToDouyinTab 同款策略：优先 active 页，逐个回退，全都不可达时给出
// 明确的错误，让 DSH 侧能提示「打开来客工作台 / 刷新页面」而不是笼统失败。
function forwardToLaikeTab(msg, callback) {
  chrome.tabs.query({ url: LAIKE_TAB_GLOB }, function (tabs) {
    if (!tabs || tabs.length === 0) {
      if (callback)
        callback({
          ok: false,
          error: "no_laike_tab: 浏览器里没有打开来客客服工作台（life.douyin.com/cs/web/）",
        });
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
            ok: false,
            error:
              "content_no_response: 来客页面未应答（扩展可能刚重载），请刷新来客工作台后重试",
          });
        }
        return;
      }
      const tabId = ordered[idx++].id;
      try {
        chrome.tabs.sendMessage(tabId, msg, function (resp) {
          const err = chrome.runtime.lastError;
          if (err || !resp) {
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

// 按平台选择转发目标。抖音私信与来客客服是同一条桥连接上的两个账号，
// 靠 msg.platform 区分，绝不能把来客的指令扔给抖音页面。
function forwardByPlatform(msg, callback) {
  if (msg && msg.platform === "douyin-laike") {
    forwardToLaikeTab(msg, callback);
    return;
  }
  forwardToDouyinTab(msg, callback);
}

// 投稿:确保有一个停在创作者中心 upload 页的 tab，再把指令发给那个 tab。// 不能复用 forwardToDouyinTab（它会优先 active 的私信页，投稿打错地方）。
// 列出/选热点：优先已打开的投稿编辑页，不要导航到 upload（会丢草稿）。
function ensureCreatorPostTabThen(msg, callback) {
  chrome.tabs.query({ url: CREATOR_TAB_GLOB }, function (tabs) {
    tabs = tabs || [];
    const editTab = tabs.find((t) =>
      /\/content\/post\/video/.test(t.url || "")
    );
    if (editTab) {
      sendToTabWhenReady(editTab.id, msg, callback);
      return;
    }
    if (tabs.length > 0) {
      sendToTabWhenReady(tabs[0].id, msg, callback);
      return;
    }
    if (callback) {
      callback({
        ok: false,
        error:
          "没有打开创作者中心页面；请先 douyin_publish（submit=false）进入编辑页后再 list_hotspots",
      });
    }
  });
}

function ensureCreatorUploadTabThen(msg, callback) {
  chrome.tabs.query({ url: CREATOR_TAB_GLOB }, function (tabs) {
    tabs = tabs || [];
    let uploadTab = tabs.find((t) => /\/content\/upload/.test(t.url || ""));
    // 已经在编辑页也可以：content.js 的 publish_prepare 会识别并只填标题，
    // 或提示需要回到 upload。这里优先 upload；没有则导航/新开。
    if (uploadTab) {
      sendToTabWhenReady(uploadTab.id, msg, callback);
      return;
    }
    if (tabs.length > 0) {
      const tabId = tabs[0].id;
      chrome.tabs.update(
        tabId,
        { url: CREATOR_UPLOAD_URL, active: true },
        function () {
          waitTabComplete(tabId, () => sendToTabWhenReady(tabId, msg, callback));
        }
      );
      return;
    }
    chrome.tabs.create({ url: CREATOR_UPLOAD_URL, active: true }, function (tab) {
      if (!tab || tab.id == null) {
        if (callback)
          callback({ ok: false, error: "无法打开创作者中心页面" });
        return;
      }
      waitTabComplete(tab.id, () => sendToTabWhenReady(tab.id, msg, callback));
    });
  });
}

function waitTabComplete(tabId, done) {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    try {
      chrome.tabs.onUpdated.removeListener(listener);
    } catch (_) {}
    // 给 React 微前端一点渲染时间。
    setTimeout(done, 2500);
  };
  function listener(id, info) {
    if (id === tabId && info.status === "complete") finish();
  }
  chrome.tabs.onUpdated.addListener(listener);
  setTimeout(finish, 30000);
  try {
    chrome.tabs.get(tabId, function (t) {
      if (t && t.status === "complete") finish();
    });
  } catch (_) {}
}

function sendToTabWhenReady(tabId, msg, callback, attempt) {
  attempt = attempt || 0;
  try {
    chrome.tabs.sendMessage(tabId, msg, function (resp) {
      const err = chrome.runtime.lastError;
      if (err || !resp) {
        if (attempt < 10) {
          setTimeout(
            () => sendToTabWhenReady(tabId, msg, callback, attempt + 1),
            1500
          );
        } else if (callback) {
          callback({
            ok: false,
            error:
              "content_no_response: 创作者中心页面未应答，请刷新该页后重试",
          });
        }
        return;
      }
      if (callback) callback(resp);
    });
  } catch (e) {
    if (attempt < 10) {
      setTimeout(
        () => sendToTabWhenReady(tabId, msg, callback, attempt + 1),
        1500
      );
    } else if (callback) {
      callback({ ok: false, error: String((e && e.message) || e) });
    }
  }
}

// ── content.js / popup → background ────────────────────────────────────────

function isLoopbackFileUrl(u) {
  try {
    const parsed = new URL(String(u));
    if (parsed.protocol !== "http:") return false;
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch (_) {
    return false;
  }
}

function debuggerSend(tabId, method, params) {
  return new Promise(function (resolve, reject) {
    try {
      chrome.debugger.sendCommand(
        { tabId: tabId },
        method,
        params || {},
        function (result) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(result || {});
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}

function debuggerAttach(tabId) {
  return new Promise(function (resolve, reject) {
    try {
      chrome.debugger.attach({ tabId: tabId }, "1.3", function () {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "";
          // 已附着时继续用。
          if (/already attached/i.test(msg)) {
            resolve(false);
            return;
          }
          reject(new Error(msg));
          return;
        }
        resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function debuggerDetach(tabId) {
  return new Promise(function (resolve) {
    try {
      chrome.debugger.detach({ tabId: tabId }, function () {
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
}

function waitForDebuggerEvent(tabId, method, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      try {
        chrome.debugger.onEvent.removeListener(listener);
      } catch (_) {}
      reject(new Error("等待 " + method + " 超时（" + timeoutMs + "ms）"));
    }, timeoutMs || 8000);

    function listener(source, methodName, params) {
      try {
        if (!source || source.tabId !== tabId) return;
        if (methodName !== method) return;
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
        resolve(params || {});
      } catch (e) {
        clearTimeout(timer);
        try {
          chrome.debugger.onEvent.removeListener(listener);
        } catch (_) {}
        reject(e);
      }
    }

    try {
      chrome.debugger.onEvent.addListener(listener);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

// 用 CDP DOM.setFileInputFiles 把**本机绝对路径**塞进 file input。
// 这是 Playwright 同一招：浏览器原生设置 files，页面会当真选过文件，
// 不像 content script 派发的 change/drop（isTrusted=false）经常被忽略。
// 副作用：附着期间标签页顶栏可能出现「正在调试」黄条，用完立刻 detach。
//
// 注意：封面场景下直接塞 hidden input 会误进「设置封面+保存」裁剪弹层（手动不会）；
// 封面优先走 setFileViaFileChooser（拦截系统选文件框）。
async function setFileInputFilesViaDebugger(tabId, selector, filePath) {
  const path = String(filePath || "");
  const sel =
    String(selector || "").trim() ||
    'input[type="file"][accept*="video"]';
  if (!path || path.charAt(0) !== "/") {
    return {
      ok: false,
      error: "local_path 必须是绝对路径（以 / 开头）: " + path,
    };
  }
  if (tabId == null) {
    return { ok: false, error: "setFileInputFiles 缺少 tabId" };
  }

  try {
    await debuggerAttach(tabId);
    await debuggerSend(tabId, "DOM.enable", {});
    const doc = await debuggerSend(tabId, "DOM.getDocument", { depth: -1 });
    const rootId = doc && doc.root && doc.root.nodeId;
    if (!rootId) {
      return { ok: false, error: "CDP DOM.getDocument 无 root" };
    }
    let node = await debuggerSend(tabId, "DOM.querySelector", {
      nodeId: rootId,
      selector: sel,
    });
    if (!node || !node.nodeId) {
      // 兜底：任意 file input
      node = await debuggerSend(tabId, "DOM.querySelector", {
        nodeId: rootId,
        selector: 'input[type="file"]',
      });
    }
    if (!node || !node.nodeId) {
      return {
        ok: false,
        error: "CDP 找不到 file input（selector=" + sel + "）",
      };
    }
    await debuggerSend(tabId, "DOM.setFileInputFiles", {
      nodeId: node.nodeId,
      files: [path],
    });
    return {
      ok: true,
      error: "",
      method: "cdp_setFileInputFiles",
      path: path,
    };
  } catch (e) {
    return {
      ok: false,
      error:
        "CDP 设置文件失败: " +
        String((e && e.message) || e) +
        "。若提示无 debugger 权限，请重载扩展；若提示无法读文件，把视频拷到 /tmp 再试。",
    };
  } finally {
    // 无论是否我们 attach 的，投稿场景下用完都卸掉，避免黄条常驻。
    await debuggerDetach(tabId);
  }
}

// 封面 fileChooser 两阶段会话（content 点「上传封面」，后台拦截选框填路径）。
// tabId -> { promise, resolve, reject, timer, listener }
const _fileChooserSessions = new Map();

async function cleanupFileChooserSession(tabId, detach) {
  const sess = _fileChooserSessions.get(tabId);
  if (sess) {
    try {
      clearTimeout(sess.timer);
    } catch (_) {}
    try {
      if (sess.listener) {
        chrome.debugger.onEvent.removeListener(sess.listener);
      }
    } catch (_) {}
    _fileChooserSessions.delete(tabId);
  }
  try {
    await debuggerSend(tabId, "Page.setInterceptFileChooserDialog", {
      enabled: false,
    });
  } catch (_) {}
  if (detach !== false) {
    await debuggerDetach(tabId);
  }
}

async function armFileChooser(tabId) {
  if (tabId == null) {
    return { ok: false, error: "arm_file_chooser 缺少 tabId" };
  }
  // 清掉上一次残留
  if (_fileChooserSessions.has(tabId)) {
    await cleanupFileChooserSession(tabId, false);
  }
  try {
    await debuggerAttach(tabId);
    await debuggerSend(tabId, "Page.enable", {});
    await debuggerSend(tabId, "DOM.enable", {});
    await debuggerSend(tabId, "Page.setInterceptFileChooserDialog", {
      enabled: true,
    });

    let resolve;
    let reject;
    const promise = new Promise(function (res, rej) {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(function () {
      const s = _fileChooserSessions.get(tabId);
      if (!s) return;
      try {
        chrome.debugger.onEvent.removeListener(s.listener);
      } catch (_) {}
      _fileChooserSessions.delete(tabId);
      reject(new Error("等待 Page.fileChooserOpened 超时（15000ms）"));
    }, 15000);

    function listener(source, methodName, params) {
      if (!source || source.tabId !== tabId) return;
      if (methodName !== "Page.fileChooserOpened") return;
      const s = _fileChooserSessions.get(tabId);
      if (!s) return;
      try {
        clearTimeout(s.timer);
      } catch (_) {}
      try {
        chrome.debugger.onEvent.removeListener(listener);
      } catch (_) {}
      s.opened = params || {};
      s.resolve(params || {});
    }

    chrome.debugger.onEvent.addListener(listener);
    _fileChooserSessions.set(tabId, {
      promise: promise,
      resolve: resolve,
      reject: reject,
      timer: timer,
      listener: listener,
      opened: null,
    });
    return { ok: true, error: "" };
  } catch (e) {
    await cleanupFileChooserSession(tabId, true);
    return {
      ok: false,
      error: "arm_file_chooser 失败: " + String((e && e.message) || e),
    };
  }
}

async function finishFileChooser(tabId, filePath) {
  const path = String(filePath || "");
  if (!path || path.charAt(0) !== "/") {
    await cleanupFileChooserSession(tabId, true);
    return {
      ok: false,
      error: "local_path 必须是绝对路径（以 / 开头）: " + path,
    };
  }
  const sess = _fileChooserSessions.get(tabId);
  if (!sess) {
    return {
      ok: false,
      error: "finish_file_chooser：未 arm（请先 arm_file_chooser）",
    };
  }
  try {
    const params = sess.opened || (await sess.promise);
    const backendNodeId = params && params.backendNodeId;
    if (backendNodeId == null) {
      return {
        ok: false,
        error: "fileChooserOpened 无 backendNodeId",
        detail: { params: params || {} },
      };
    }
    await debuggerSend(tabId, "DOM.setFileInputFiles", {
      backendNodeId: backendNodeId,
      files: [path],
    });
    return {
      ok: true,
      error: "",
      method: "cdp_file_chooser",
      path: path,
    };
  } catch (e) {
    return {
      ok: false,
      error:
        "CDP fileChooser 失败: " +
        String((e && e.message) || e) +
        "。请重载扩展后重试。",
    };
  } finally {
    await cleanupFileChooserSession(tabId, true);
  }
}

async function cancelFileChooser(tabId) {
  await cleanupFileChooserSession(tabId, true);
  return { ok: true };
}

// 内容脚本跑在 https://creator.douyin.com 里，直接 fetch(127.0.0.1) 会被
// Chrome 当成「公开站点访问私有网络」拦掉（Failed to fetch）。Service Worker
// 用扩展自己的身份取文件，再把 ArrayBuffer 回传给 content —— host_permissions
// 里的 http://127.0.0.1/* 在这里生效。
async function fetchLocalFileForContent(url) {
  if (!isLoopbackFileUrl(url)) {
    return { ok: false, error: "拒绝：取文件 URL 必须是本机回环地址" };
  }
  let resp;
  try {
    resp = await fetch(url, { cache: "no-store" });
  } catch (e) {
    return {
      ok: false,
      error:
        "桥取文件失败（连不上 127.0.0.1）: " +
        String((e && e.message) || e) +
        "。确认 DSH 客服中心插件在跑，且扩展已重载。",
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      error: "桥取文件失败：HTTP " + resp.status + "（token 可能已过期）",
    };
  }
  const buf = await resp.arrayBuffer();
  if (!buf || buf.byteLength === 0) {
    return { ok: false, error: "桥取到的文件是空的" };
  }
  return {
    ok: true,
    buffer: buf,
    content_type: resp.headers.get("Content-Type") || "application/octet-stream",
    size: buf.byteLength,
  };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === "fetch_local_file") {
    fetchLocalFileForContent(msg.url)
      .then(function (r) {
        sendResponse(r);
      })
      .catch(function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true; // async
  }

  if (msg.type === "set_file_input_path") {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    setFileInputFilesViaDebugger(tabId, msg.selector, msg.path)
      .then(function (r) {
        sendResponse(r);
      })
      .catch(function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true; // async
  }

  if (msg.type === "arm_file_chooser") {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    armFileChooser(tabId)
      .then(function (r) {
        sendResponse(r);
      })
      .catch(function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }

  if (msg.type === "finish_file_chooser") {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    finishFileChooser(tabId, msg.path)
      .then(function (r) {
        sendResponse(r);
      })
      .catch(function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }

  if (msg.type === "cancel_file_chooser") {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    cancelFileChooser(tabId)
      .then(function (r) {
        sendResponse(r);
      })
      .catch(function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }

  if (msg.type === "account_detected") {
    const detected = String(msg.account_id || "").trim();
    if (!detected) {
      if (sendResponse) sendResponse({ ok: true });
      return true;
    }
    const cur = config.accountId || "default";
    const curIsPlaceholder = !cur || cur === "default";
    // 已有 ck_（cookie）身份时，拒绝被页面误探的 MS4w sec_uid 覆盖
    if (cur.indexOf("ck_") === 0 && detected.indexOf("MS4wLjAB") === 0) {
      if (sendResponse) sendResponse({ ok: true, kept: cur });
      return true;
    }
    if (detected === cur) {
      chrome.storage.local.set({ detectedAccountId: detected });
      if (sendResponse) sendResponse({ ok: true });
      return true;
    }
    config.accountId = detected;
    chrome.storage.local.set({
      accountId: detected,
      detectedAccountId: detected,
    });
    console.info(
      "[DSH 客服] account_id",
      cur,
      "→",
      detected,
      curIsPlaceholder ? "（升级，重连一次）" : "（不拆线，避免模板键散掉）"
    );
    // 只在 default→真实 时重连；已有账号间切换不再拆 WS
    if (curIsPlaceholder && socket && socket.readyState === WebSocket.OPEN) {
      clearWatchdog();
      forceCloseSocket();
      connectAttempts = 0;
      connect();
    }
    if (sendResponse) sendResponse({ ok: true, updated: detected });
    return true;
  }

  if (msg.type === "connect_now") {
    clearWatchdog();
    forceCloseSocket();
    connectAttempts = 0;
    pairCodeRejected = false; // 用户改了配对码，解除"拒绝重连"封印
    connect();
    if (sendResponse) sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "seed_pair") {
    const code = (msg.pairCode || "").trim();
    if (code) {
      const patch = { pairCode: code };
      if (msg.port) patch.port = msg.port;
      chrome.storage.local.set(patch, function () {
        config.pairCode = code;
        if (msg.port) config.port = msg.port;
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
      return true; // async sendResponse
    }
    if (sendResponse) sendResponse({ ok: false });
    return true;
  }

  // ── 来客客服（life.douyin.com/cs/web/）────────────────────────────────────
  // 内容脚本已经把来客的 REST 明文 JSON 归一化好，这里只做**透传**。
  // 关键：绝不能把 account_id 换成 config.accountId —— 同一条桥上挂着两个账号
  // （抖音私信 + 来客客服），来客的消息必须用自己的 account_id 归属。
  if (msg.platform === "douyin-laike") {
    trySend({
      type: msg.type,
      platform: "douyin-laike",
      account_id: msg.account_id,
      nickname: msg.nickname,
      detected_id: msg.detected_id,
      threads: msg.threads,
      sample: msg.sample,
    });
    return;
  }

  if (msg.type === "ws_hooked") {
    // 页面 frontier 长连接已成功 hook。记时间戳，供"连上桥但页面没 hook →
    // 自动刷新"的判定（此信号与有没有私信进来无关）。
    lastHookAt = Date.now();
    return;
  }

  if (msg.type === "frame") {
    trySend({
      type: "frame",
      account_id: config.accountId,
      raw_b64: msg.raw_b64,
      context: msg.context || {},
    });
    return;
  }

  if (msg.type === "send_template") {
    // 页面自己发了一条私信 → 把请求体上报给 Hermes 当发送模板。
    persistAndSendTemplate("send_template", {
      type: "send_template",
      account_id: config.accountId,
      body_b64: msg.body_b64,
    });
    return;
  }

  if (msg.type === "create_template") {
    // 页面点「私信」触发的 conversation/create 请求体 → 冷启动开聊模板。
    console.info(
      "[DSH 客服] SW←create_template",
      (msg.body_b64 || "").length,
      "account=",
      config.accountId
    );
    persistAndSendTemplate("create_template", {
      type: "create_template",
      account_id: config.accountId,
      body_b64: msg.body_b64,
    });
    return;
  }

  if (msg.type === "create_pair") {
    // create 的请求+响应成对上报，Hermes 解析 short_id 并登记路由。
    console.info(
      "[DSH 客服] SW←create_pair",
      "req",
      (msg.req_b64 || "").length,
      "resp",
      (msg.resp_b64 || "").length
    );
    persistAndSendTemplate("create_pair", {
      type: "create_pair",
      account_id: config.accountId,
      req_b64: msg.req_b64 || "",
      resp_b64: msg.resp_b64 || "",
      http_status: msg.http_status || 0,
    });
    return;
  }

  if (msg.type === "user_info") {
    const users = Array.isArray(msg.users) ? msg.users : [];
    if (!users.length) return;
    console.info("[DSH 客服] SW←user_info", users.length);
    trySend({
      type: "user_info",
      account_id: config.accountId,
      users: users,
    });
    return;
  }

  if (msg.type === "comment_baseline") {
    // 页面自己发了一条评论 → 上报响应，Hermes 拿它当「正常值」基线。
    trySend({
      type: "comment_baseline",
      account_id: config.accountId,
      http_status: msg.http_status || 0,
      resp_text: msg.resp_text || "",
    });
    return;
  }

  if (
    msg.type === "risk_alert" ||
    msg.type === "login_state" ||
    msg.type === "current_chat" ||
    msg.type === "account_identity"
  ) {
    trySend(Object.assign({ account_id: config.accountId }, msg));
    return;
  }
});

// ── 保活抖音标签页 ─────────────────────────────────────────────────────────
// 私信走的是页面自己的 frontier 连接：页面没了连接就没了 → 收不到消息。所以
// 扩展确保**始终有一个抖音标签页在后台跑着**（用户不用盯着，最小化也行）。
// 边界：浏览器完全关掉仍收不到 —— 这是"不用主动盯网页"，不是"关浏览器也收"。

let keepAliveTabId = null;
let openingKeepAlive = false;
// 是否由本扩展自动创建（只有自动创建的页才允许被切换/定时重载，避免打扰用户自己开的抖音页）
let keepAliveAutoCreated = false;

// MV3 Service Worker 会反复休眠重启，内存状态不可靠 → 把保活标记落到 storage
try {
  chrome.storage.local.get(["keepAliveTabId", "keepAliveAutoCreated"], function (s) {
    if (s && s.keepAliveAutoCreated && s.keepAliveTabId) {
      keepAliveAutoCreated = true;
      if (!keepAliveTabId) keepAliveTabId = s.keepAliveTabId;
    }
  });
} catch (_) {}

function saveKeepAliveState() {
  try {
    chrome.storage.local.set({ keepAliveTabId: keepAliveTabId, keepAliveAutoCreated: keepAliveAutoCreated });
  } catch (_) {}
}
// 每 6 小时重载一次保活页：抖音 SPA 长时间运行内存会缓慢上涨，重载可把占用拉回基线
const KEEPALIVE_RELOAD_ALARM = "hermes-douyin-keepalive-reload";

function ensureKeepAliveTab() {
  if (openingKeepAlive) return;
  try {
    chrome.tabs.query({ url: DOUYIN_TAB_GLOB }, function (tabs) {
      tabs = douyinTabsOnly(tabs);
      if (tabs.length > 0) {
        const existing = tabs.find((t) => t.id === keepAliveTabId);
        keepAliveTabId = existing ? existing.id : tabs[0].id;
        // 自己开的保活页：如果还停在首页（带视频流），切到轻页面，省 CPU/GPU
        if (keepAliveAutoCreated && existing && existing.url && existing.url.indexOf("/user/self") === -1) {
          chrome.tabs.update(existing.id, { url: KEEPALIVE_URL, active: false });
        }
        return;
      }
      openingKeepAlive = true;
      chrome.tabs.create(
        { url: KEEPALIVE_URL, active: false, pinned: true },
        function (tab) {
          openingKeepAlive = false;
          if (chrome.runtime.lastError || !tab) {
            console.info(
              "[DSH 客服] 后台开保活页失败",
              chrome.runtime.lastError
            );
            return;
          }
          keepAliveTabId = tab.id;
          keepAliveAutoCreated = true;
          saveKeepAliveState();
          console.info("[DSH 客服] 已在后台开保活抖音页", tab.id);
        }
      );
    });
  } catch (_) {
    openingKeepAlive = false;
  }
}

/** 定时重载自动创建的保活页（控制内存；用户正在看的页不动）。 */
function reloadKeepAliveIfIdle() {
  if (!keepAliveAutoCreated || !keepAliveTabId) return;
  try {
    chrome.tabs.get(keepAliveTabId, function (tab) {
      if (chrome.runtime.lastError || !tab || tab.active) return;
      chrome.tabs.reload(keepAliveTabId, { bypassCache: false }, function () {
        console.info("[DSH 客服] 保活页定时重载（控制内存）");
      });
    });
  } catch (_) {}
}

try {
  chrome.tabs.onRemoved.addListener(function (tabId) {
    if (tabId === keepAliveTabId) {
      keepAliveTabId = null;
      keepAliveAutoCreated = false;
      saveKeepAliveState();
      setTimeout(ensureKeepAliveTab, 4000);
    }
  });
} catch (_) {}

// 周期唤醒 + 保活。chrome.alarms 不可用时退化为 setInterval。
function keepaliveTick() {
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    connect();
  }
  if (config.pairCode && !pairCodeRejected) {
    ensureKeepAliveTab();
  }
}

try {
  if (chrome.alarms && typeof chrome.alarms.create === "function") {
    chrome.alarms.create("hermes-douyin-keepalive", { periodInMinutes: 0.4 });
    chrome.alarms.create(KEEPALIVE_RELOAD_ALARM, { periodInMinutes: 360 });
    chrome.alarms.onAlarm.addListener(function (alarm) {
      if (alarm.name === "hermes-douyin-keepalive") keepaliveTick();
      if (alarm.name === KEEPALIVE_RELOAD_ALARM) reloadKeepAliveIfIdle();
    });
  } else {
    setInterval(keepaliveTick, 25000);
  }
} catch (e) {
  try {
    setInterval(keepaliveTick, 25000);
  } catch (_) {}
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

connect();
