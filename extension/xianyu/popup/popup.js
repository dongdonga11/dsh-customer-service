// popup.js —— 配置桥地址/端口/配对码/账号,保存并立即触发 background 连接,
// 并显示明确的连接状态反馈(连接中 / 已连接 / 失败原因)。

function $(id) {
  return document.getElementById(id);
}

async function load() {
  const s = await chrome.storage.local.get([
    "host",
    "port",
    "pairCode",
    "accountId",
    "detectedAccountId",
    "connState",
    "connError",
  ]);
  $("host").value = s.host || "127.0.0.1";
  $("port").value = s.port || "8765";
  $("pairCode").value = s.pairCode || "";
  $("accountId").value = s.detectedAccountId || s.accountId || "";
  renderStatus(s.connState || "idle", s.connError || "");
}

// state: "idle" | "connecting" | "connected" | "error"
function renderStatus(state, error) {
  const dot = $("dot");
  const text = $("statusText");
  const map = {
    idle: { cls: "off", label: "未连接" },
    connecting: { cls: "off", label: "连接中…" },
    connected: { cls: "on", label: "已连接 DSH 客服中心" },
    error: { cls: "off", label: "连接失败" },
  };
  const m = map[state] || map.idle;
  dot.className = "dot " + m.cls;
  text.textContent = error ? `${m.label} — ${error}` : m.label;
}

function setSaving(saving) {
  const btn = $("save");
  btn.disabled = saving;
  btn.textContent = saving ? "连接中…" : "保存并连接";
}

$("save").addEventListener("click", async function () {
  const host = $("host").value.trim() || "127.0.0.1";
  const port = parseInt($("port").value.trim() || "8765", 10);
  const pairCode = $("pairCode").value.trim();

  if (!pairCode) {
    renderStatus("error", "请先填写配对码");
    return;
  }

  setSaving(true);
  renderStatus("connecting", "");

  // 不再手填 account_id —— background 用 content.js 探测到的真实 unb 握手。
  await chrome.storage.local.set({
    host,
    port,
    pairCode,
    connState: "connecting",
    connError: "",
  });

  // 主动让 background 立即(重)连,不只依赖 storage.onChanged。
  try {
    chrome.runtime.sendMessage({ type: "connect_now" }, function () {
      // 忽略响应;状态由 storage.onChanged 更新
      void chrome.runtime.lastError;
    });
  } catch (_) {
    /* ignore */
  }

  // 兜底:1.2s 后恢复按钮可点(连接结果通过状态条体现)
  setTimeout(() => setSaving(false), 1200);
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local") return;
  if (changes.detectedAccountId) {
    $("accountId").value = changes.detectedAccountId.newValue || "";
  }
  if (changes.connState || changes.connError) {
    chrome.storage.local.get(["connState", "connError"], (s) => {
      renderStatus(s.connState || "idle", s.connError || "");
      if ((s.connState || "idle") !== "connecting") {
        setSaving(false);
      }
    });
  }
});

load();
