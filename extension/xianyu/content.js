// content.js —— 运行在隔离世界，桥接「页面主世界」与「background」。
//
// 职责：
// 1. 把 injected.js 注入页面主世界（去 hook 页面 WebSocket）
// 2. 接收主世界 postMessage 上来的原始帧 / 风控告警，转发给 background
// 3. 接收 background 下发的动作指令（send_text / send_image / call_api），
//    在页面上执行（调页面已登录接口 / 模拟 UI 操作）
(function () {
  "use strict";

  // injected.js 现在由 manifest 以 world:"MAIN" + document_start 直接注入(最早执行,
  // 确保在闲鱼页面建立 WebSocket 之前就 hook 好,不漏接消息)。这里不再用 <script>
  // 标签注入(那是异步的,会晚于页面自己的 ws,导致账号级长连接 hook 不到)。

  // 1.4) 一键托管:专属 Chrome 启动 URL 带一次性配对码(?__hermes_pair=xxx&
  //      __hermes_port=8765)。读到就把配对码+端口播种给 background(它存进
  //      chrome.storage 并立即连桥),免手填配对码。读完从 URL 抹掉,不留痕。
  (function seedPairFromUrl() {
    try {
      const sp = new URLSearchParams(location.search || "");
      const pair = sp.get("__hermes_pair");
      if (!pair) return;
      const port = sp.get("__hermes_port") || "";
      try {
        chrome.runtime.sendMessage({
          type: "seed_pair",
          pairCode: pair,
          port: port ? parseInt(port, 10) : undefined,
        });
      } catch (_) {}
      // 从地址栏抹掉这两个参数(不刷新页面),避免配对码留在 URL 里。
      try {
        sp.delete("__hermes_pair");
        sp.delete("__hermes_port");
        const qs = sp.toString();
        const clean = location.pathname + (qs ? "?" + qs : "") + location.hash;
        history.replaceState(null, "", clean);
      } catch (_) {}
    } catch (_) {}
  })();

  // 1.5) 自动探测当前登录的闲鱼账号(cookie 里的 unb),上报给 background
  //      作为 account_id —— 多账号(多 Chrome Profile)时每个 Profile 登哪个号
  //      就自动报哪个号,无需手填、不会撞 default。页面 cookie 可能稍后才就绪,
  //      所以重试几次直到读到为止。
  (function reportAccountId() {
    function readUnb() {
      const m = document.cookie.match(/(?:^|; )unb=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : "";
    }
    let tries = 0;
    function tick() {
      const unb = readUnb();
      if (unb) {
        try {
          chrome.runtime.sendMessage({ type: "account_detected", account_id: unb });
        } catch (_) {}
        return;
      }
      if (tries++ < 20) setTimeout(tick, 1000);
    }
    tick();
  })();

  // 2) 主世界 → background
  // 用一个安全包装:扩展被重载后旧 content script 的 chrome.runtime 会失效
  // (抛 "Extension context invalidated"),这里吞掉并提示用户刷新页面,
  // 避免每帧都往控制台刷红。
  let _ctxInvalidated = false;
  // 扩展上下文失效(扩展被重载/更新)时,旧 content script 的 chrome.runtime 会死,
  // 无法再连桥 → 自愈:自动刷新本页(节流,避免循环)。刷新后新 content script
  // 带新上下文重新接入。
  function _selfReloadOnce() {
    try {
      const KEY = "__hermes_xy_reload_at";
      const last = parseInt(sessionStorage.getItem(KEY) || "0", 10) || 0;
      const now = Date.now();
      // 同一页 60s 内最多自动刷一次,防刷新风暴。
      if (now - last < 60000) return;
      sessionStorage.setItem(KEY, String(now));
      console.info("[DSH闲鱼] 扩展上下文失效,自动刷新本页重新接入");
      setTimeout(function () { try { location.reload(); } catch (_) {} }, 800);
    } catch (_) {}
  }
  function safeSendMessage(payload) {
    if (_ctxInvalidated) return;
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        _ctxInvalidated = true;
        console.info("[DSH闲鱼] 扩展已更新,请刷新本页面以重新接入");
        _selfReloadOnce();
        return;
      }
      chrome.runtime.sendMessage(payload, function () {
        // 读一下 lastError,避免未处理的回调错误;失效则标记停止后续发送
        const err = chrome.runtime.lastError;
        if (err && /context invalidated|Receiving end/.test(err.message || "")) {
          _ctxInvalidated = true;
          _selfReloadOnce();
        }
      });
    } catch (e) {
      _ctxInvalidated = true;
      console.info("[DSH闲鱼] 扩展上下文已失效,请刷新本页面");
      _selfReloadOnce();
    }
  }


  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__hermes_xianyu__ !== true) return;

    if (d.dir === "frame") {
      safeSendMessage({ type: "frame", raw: d.payload });
    } else if (d.dir === "ws_hooked") {
      // 页面消息长连接已成功 hook —— 告诉 background"页面真接上了"(用于
      // "连上桥但页面没 hook → 自动刷新"的判断)。
      safeSendMessage({ type: "ws_hooked" });
    } else if (d.dir === "risk") {
      safeSendMessage({ type: "risk_alert", detail: d.detail });
    } else if (d.dir === "current_chat") {
      // 页面出站帧暴露的"当前正在看的会话"——上报给 sidecar,发图等可据此定向。
      safeSendMessage({
        type: "current_chat",
        chat_id: d.chat_id || "",
        buyer_id: d.buyer_id || "",
      });
    } else if (d.dir === "user_info") {
      // idlemessage.pc.user.query → 买家 fishNick + logo，供客服台显示。
      const users = Array.isArray(d.users) ? d.users : [];
      if (users.length) {
        try {
          console.info("[DSH闲鱼] content←user_info", users.length);
        } catch (_) {}
        safeSendMessage({ type: "user_info", users: users });
      }
    }
  });

  // 3) background → 页面执行动作
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === "send_text") {
      // 精确定向:带 chat_id + buyer_id 时,经页面 WebSocket 发给指定会话
      // (修复"回错窗口"bug)。缺这些信息则退回 DOM 模拟(发当前打开的窗口)。
      if (msg.chat_id && msg.buyer_id && msg.seller_id) {
        sendViaPageWs(msg.chat_id, msg.buyer_id, msg.seller_id, msg.text)
          .then((ok) => {
            if (ok) {
              sendResponse({ ok: true });
            } else {
              // ws 发送不可用 → 兜底 DOM(当前窗口)。
              sendTextMessage(msg.chat_id, msg.text)
                .then((ok2) => sendResponse({ ok: ok2 }))
                .catch(() => sendResponse({ ok: false }));
            }
          })
          .catch(() => {
            sendTextMessage(msg.chat_id, msg.text)
              .then((ok2) => sendResponse({ ok: ok2 }))
              .catch(() => sendResponse({ ok: false }));
          });
        return true; // async
      }
      sendTextMessage(msg.chat_id, msg.text)
        .then((ok) => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true; // async
    }

    if (msg.type === "send_image") {
      sendImageMessage(msg.chat_id, msg.buyer_id, msg.seller_id, msg.image_url)
        .then((r) => sendResponse(typeof r === "object" ? r : { ok: !!r }))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;
    }

    if (msg.type === "call_api") {
      callXianyuApi(msg.action, msg.args)
        .then((data) => sendResponse({ data }))
        .catch((e) => sendResponse({ data: { error: String(e) } }));
      return true;
    }
  });

  // ── 动作实现（稳健 DOM 多策略；不碰接口签名，最不易触发风控）──────────
  //
  // 闲鱼网页版聊天:在会话页找到输入框 → 填入文本 → 触发发送(回车或点发送按钮)。
  // 页面结构会变,所以用多策略:多种选择器找输入框、React 受控组件用原生
  // setter 触发 input、回车失败再找发送按钮点击。联调时如某策略不灵,
  // 把真实 DOM 结构告诉作者再精调选择器。

  function _isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  }

  function _findMessageInput() {
    // 候选选择器(从最可能到兜底);取可见的那个。
    const selectors = [
      'textarea[class*="msg"]',
      'textarea[placeholder*="回复"]',
      'textarea[placeholder*="输入"]',
      'div[contenteditable="true"][class*="msg"]',
      'div[contenteditable="true"][class*="input"]',
      'div[contenteditable="true"]',
      "textarea",
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (_isVisible(el)) return el;
      }
    }
    return null;
  }

  // React 受控 textarea:必须用原生 value setter + input 事件,直接赋 value 不生效。
  function _setNativeValue(el, value) {
    try {
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) {
        setter.set.call(el, value);
      } else {
        el.value = value;
      }
    } catch (_) {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function _setContentEditable(el, value) {
    el.focus();
    // 优先用 execCommand 插入,触发 React 的 onInput
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
      document.execCommand("insertText", false, value);
    } catch (_) {
      el.textContent = value;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  }

  function _pressEnter(el) {
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // ── 页面勘查(read_page):把当前页结构化成精简的「可交互元素清单」──────────
  //
  // 给 AI 当"现场勘查"工具:闲鱼改版导致某步失败时,AI 自己调它看清当前 DOM,
  // 不用人 F12 截图。回的是精简结构(不是整页 raw HTML —— 那个又大又乱),
  // 每个元素带:类型 / 关联 label 文案 / placeholder / 当前值 / 是否可见 /
  // 一个尽量稳定的选择器提示(优先 ant-form-item 的 label title,因为中文 label
  // 不变,而 css-xxx / xxx--HASH 类名天天变)。

  function _txt(el, max) {
    const t = ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
    max = max || 60;
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  // 为元素找最近的 ant-form-item 容器里的 label 文案(稳定锚点)。
  function _labelFor(el) {
    try {
      const item = el.closest(".ant-form-item, [class*='form-item']");
      if (item) {
        const lab = item.querySelector("label[title], label");
        if (lab) {
          const ti = lab.getAttribute("title");
          if (ti) return ti.trim();
          return _txt(lab, 30);
        }
      }
      if (el.getAttribute) {
        const al = el.getAttribute("aria-label") || el.getAttribute("title");
        if (al) return al.trim();
      }
    } catch (_) {}
    return "";
  }

  // 生成一个"尽量稳定"的选择器提示:能用 label 文案定位的,标成 label= 形式;
  // 否则退回 tag+placeholder / 稳定属性。不依赖 css-xxx / --HASH 类名。
  function _stableHint(el) {
    const tag = (el.tagName || "").toLowerCase();
    const ph = el.getAttribute && el.getAttribute("placeholder");
    const ty = el.getAttribute && el.getAttribute("type");
    const label = _labelFor(el);
    const parts = [];
    if (label) parts.push('label="' + label + '"');
    if (ph) parts.push('placeholder="' + ph + '"');
    if (ty) parts.push("type=" + ty);
    if (!parts.length) {
      const role = el.getAttribute && el.getAttribute("role");
      if (role) parts.push("role=" + role);
    }
    return tag + (parts.length ? "[" + parts.join(", ") + "]" : "");
  }

  function _readPage(opts) {
    opts = opts || {};
    const wantRaw = !!opts.raw;
    const scopeSel = opts.scope || "";
    let root = document;
    if (scopeSel) {
      try {
        const r = document.querySelector(scopeSel);
        if (r) root = r;
      } catch (_) {}
    }

    const sel =
      "input, textarea, select, [contenteditable='true'], button, " +
      "[role='button'], [role='switch'], [role='radio'], [role='combobox'], " +
      "[role='option'], label.ant-radio-wrapper";
    const seen = new Set();
    const fields = [];
    const buttons = [];
    let nodes = [];
    try {
      nodes = Array.prototype.slice.call(root.querySelectorAll(sel));
    } catch (_) {
      nodes = [];
    }
    for (const el of nodes) {
      if (seen.has(el)) continue;
      seen.add(el);
      const tag = (el.tagName || "").toLowerCase();
      const type = (el.getAttribute && el.getAttribute("type")) || "";
      const role = (el.getAttribute && el.getAttribute("role")) || "";
      const isButton =
        tag === "button" || role === "button" || type === "submit" || type === "button";
      const rec = {
        tag: tag,
        type: type || undefined,
        role: role || undefined,
        label: _labelFor(el) || undefined,
        placeholder: (el.getAttribute && el.getAttribute("placeholder")) || undefined,
        value:
          tag === "input" || tag === "textarea"
            ? (el.value || "").slice(0, 40) || undefined
            : undefined,
        text: isButton ? _txt(el, 24) || undefined : undefined,
        editable:
          el.getAttribute && el.getAttribute("contenteditable") === "true" ? true : undefined,
        checked:
          el.tagName === "INPUT" && (type === "radio" || type === "checkbox")
            ? !!el.checked
            : undefined,
        visible: _isVisible(el),
        hint: _stableHint(el),
      };
      Object.keys(rec).forEach((k) => rec[k] === undefined && delete rec[k]);
      if (isButton) buttons.push(rec);
      else fields.push(rec);
    }

    const out = {
      ok: true,
      url: location.href,
      title: document.title,
      is_publish_page: /\/publish/.test(location.href),
      field_count: fields.length,
      button_count: buttons.length,
      fields: fields.slice(0, 80),
      buttons: buttons.slice(0, 40),
    };
    if (wantRaw) {
      try {
        const html = (root.outerHTML || document.body.innerHTML || "").replace(/\s+/g, " ");
        out.raw_html = html.slice(0, 12000);
      } catch (_) {}
    }
    return out;
  }



  function _clickSendButton() {
    // 回车不灵时,找"发送"按钮点击。
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], span, div')
    );
    for (const el of candidates) {
      if (!_isVisible(el)) continue;
      const t = (el.textContent || "").trim();
      if (t === "发送" || t === "发 送" || t === "Send") {
        el.click();
        return true;
      }
    }
    return false;
  }

  async function sendTextMessage(chatId, text) {
    try {
      const input = _findMessageInput();
      if (!input) {
        console.warn("[DSH闲鱼] 未找到消息输入框,请确认停在闲鱼会话页面");
        return false;
      }
      input.focus();
      if (input.tagName === "TEXTAREA") {
        _setNativeValue(input, text);
      } else {
        _setContentEditable(input, text);
      }
      // 给 React 一点时间处理受控更新
      await new Promise((r) => setTimeout(r, 120));
      _pressEnter(input);
      // 回车后稍等,若输入框没清空,认为没发出去,改点发送按钮
      await new Promise((r) => setTimeout(r, 200));
      const stillHasText =
        input.tagName === "TEXTAREA"
          ? (input.value || "").trim().length > 0
          : (input.textContent || "").trim().length > 0;
      if (stillHasText) {
        _clickSendButton();
        await new Promise((r) => setTimeout(r, 150));
      }
      console.info("[DSH闲鱼] 已尝试发送文本到会话", chatId);
      return true;
    } catch (e) {
      console.warn("[DSH闲鱼] 发送文本失败", e);
      return false;
    }
  }

  // 经页面主世界(injected.js)用页面自己的 WebSocket 精确发消息到指定会话。
  // content.js 不能直接碰主世界的 ws,所以 postMessage 给 injected,它发完回 ack。
  const _pendingWsSends = {};
  let _wsSendSeq = 0;

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__hermes_xianyu__ !== true || d.dir !== "send_ack") return;
    const cb = _pendingWsSends[d.req_id];
    if (cb) {
      delete _pendingWsSends[d.req_id];
      cb(!!d.ok);
    }
  });

  function sendViaPageWs(chatId, buyerId, sellerId, text) {
    return new Promise(function (resolve) {
      const reqId = "s" + Date.now() + "_" + _wsSendSeq++;
      let done = false;
      _pendingWsSends[reqId] = function (ok) {
        if (!done) {
          done = true;
          resolve(ok);
        }
      };
      try {
        window.postMessage(
          {
            __hermes_xianyu__: true,
            dir: "send",
            req_id: reqId,
            chat_id: String(chatId),
            buyer_id: String(buyerId),
            seller_id: String(sellerId),
            text: String(text),
          },
          "*"
        );
      } catch (e) {
        delete _pendingWsSends[reqId];
        resolve(false);
        return;
      }
      // 超时兜底:5s 没 ack 视为失败,调用方会退回 DOM。
      setTimeout(function () {
        if (!done && _pendingWsSends[reqId]) {
          delete _pendingWsSends[reqId];
          resolve(false);
        }
      }, 5000);
    });
  }

  async function sendImageMessage(chatId, buyerId, sellerId, imageUrl) {
    // 发图片:① 拿到闲鱼 CDN URL(外链/本地图先上传到闲鱼CDN,已是 goofish CDN 的直接用)
    //         ② 取图片尺寸 ③ 经页面 ws 发图片帧(injected.js)。
    // 全程用页面登录态(上传 + 发送都是页面自己的请求),抗风控一致。
    // 返回 {ok, error} —— 把真实失败原因带回去,DSH 侧不再假装发成功。
    try {
      if (!imageUrl) return { ok: false, error: "图片为空" };
      if (!chatId || !buyerId || !sellerId) {
        console.warn("[DSH闲鱼] send_image 缺 chat_id/buyer_id/seller_id");
        return { ok: false, error: "缺会话/买家信息(chat_id/buyer_id),无法定向发图" };
      }
      let cdnUrl = imageUrl;
      let width = 800, height = 800;

      const isGoofishCdn = /goofish|alicdn|taobaocdn|img\.alicdn/.test(imageUrl);
      if (!isGoofishCdn) {
        // 外链/本地图 → 下载成 blob → 上传到闲鱼 CDN。
        const uploaded = await uploadImageToXianyu(imageUrl);
        if (!uploaded || !uploaded.url) {
          console.warn("[DSH闲鱼] 图片上传闲鱼CDN失败");
          return { ok: false, error: (uploaded && uploaded.error) || "图片上传闲鱼CDN失败(登录态/网络)" };
        }
        cdnUrl = uploaded.url;
        if (uploaded.width) width = uploaded.width;
        if (uploaded.height) height = uploaded.height;
      } else {
        const dim = await _probeImageSize(imageUrl);
        if (dim) { width = dim.width; height = dim.height; }
      }

      // 经主世界 ws 发图片帧。
      const ok = await new Promise((resolve) => {
        const reqId = "i" + Date.now() + "_" + _wsSendSeq++;
        let done = false;
        _pendingWsSends[reqId] = function (ok) {
          if (!done) { done = true; resolve(ok); }
        };
        window.postMessage(
          {
            __hermes_xianyu__: true, dir: "send_image", req_id: reqId,
            chat_id: String(chatId), buyer_id: String(buyerId),
            seller_id: String(sellerId), cdn_url: String(cdnUrl),
            width: width, height: height,
          },
          "*"
        );
        setTimeout(() => {
          if (!done && _pendingWsSends[reqId]) {
            delete _pendingWsSends[reqId];
            resolve(false);
          }
        }, 8000);
      });
      return ok
        ? { ok: true, error: "" }
        : { ok: false, error: "页面 WebSocket 未就绪或发送超时(刷新闲鱼页面重试)" };
    } catch (e) {
      console.warn("[DSH闲鱼] 发图片失败", e);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 下载图片 → 上传到闲鱼 CDN,返回 {url, width, height} 或 {error}。上传用页面 cookie(credentials)。
  async function uploadImageToXianyu(srcUrl) {
    try {
      let blob;
      try {
        const imgResp = await fetch(srcUrl, { credentials: "omit" });
        if (!imgResp.ok) return { error: "读取图片失败(HTTP " + imgResp.status + ")" };
        blob = await imgResp.blob();
      } catch (e) {
        return { error: "读取图片失败: " + String((e && e.message) || e) };
      }
      if (!blob || blob.size === 0) return { error: "图片内容为空" };
      const dim = await _probeBlobSize(blob);

      const fd = new FormData();
      const fname = "img_" + Date.now().toString(36) + ".jpg";
      fd.append("file", blob, fname);

      const up = await fetch(
        "https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=xy_chat&_input_charset=utf-8",
        {
          method: "POST",
          credentials: "include",
          headers: {
            "x-requested-with": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
          },
          body: fd,
        }
      );
      if (!up.ok) return { error: "上传 CDN 失败(HTTP " + up.status + ")" };
      const txt = await up.text();
      if (/<!DOCTYPE html>|<html>/i.test(txt)) return { error: "上传被拒(闲鱼登录态失效,请在该页面重新登录)" };
      let data;
      try { data = JSON.parse(txt); } catch (_) { return { error: "上传响应解析失败" }; }
      const url =
        (data && data.data && data.data.url) ||
        (data && data.object && data.object.url) ||
        (data && data.url) ||
        (data && data.result && data.result.url) ||
        (data && data.data && (data.data.fileUrl || data.data.file_url));
      if (!url) return { error: "上传成功但未返回图片URL" };
      return { url: url, width: dim ? dim.width : 800, height: dim ? dim.height : 800 };
    } catch (e) {
      console.warn("[DSH闲鱼] 上传图片异常", e);
      return { error: "上传异常: " + String((e && e.message) || e) };
    }
  }

  function _probeImageSize(url) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth || 800, height: img.naturalHeight || 800 });
        img.onerror = () => resolve(null);
        img.src = url;
        setTimeout(() => resolve(null), 4000);
      } catch (_) { resolve(null); }
    });
  }

  function _probeBlobSize(blob) {
    return new Promise((resolve) => {
      try {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          const r = { width: img.naturalWidth || 800, height: img.naturalHeight || 800 };
          URL.revokeObjectURL(url);
          resolve(r);
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
        setTimeout(() => resolve(null), 4000);
      } catch (_) { resolve(null); }
    });
  }

  // ── 二期：调闲鱼已登录 mtop 接口（订单详情/确认发货/评价等）──────────────
  //
  // 走页面自己的登录态：用 document.cookie 里的 _m_h5_tk 签名，fetch 带
  // credentials 直发 h5api.m.goofish.com。指纹与页面原生 mtop 请求一致
  // （UA/Referer 由浏览器自动带），抗风控最稳。Python 侧只传 api/version/data，
  // 具体接口名/参数由工具决定，扩展是「会签名的透明转发」，加新接口不必重载扩展。

  function _readCookie(name) {
    const esc = name.replace(/([.$?*|{}()\[\]\\\/+^])/g, "\\$1");
    const m = document.cookie.match(new RegExp("(?:^|; )" + esc + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  async function mtopRequest(api, version, dataObj, retry, appKeyOverride) {
    retry = retry || 0;
    // 大多数闲鱼交易/消息接口用 34839810;网页搜索类接口可能用不同 appKey
    // (如 12574478)。允许调用方覆盖,默认保持原值不变(不影响既有调用)。
    const appKey = (appKeyOverride && String(appKeyOverride)) || "34839810";
    const t = String(Date.now());
    const dataVal = JSON.stringify(dataObj == null ? {} : dataObj);
    const h5tk = _readCookie("_m_h5_tk");
    const token = h5tk ? h5tk.split("_")[0] : "";
    const sign = md5(token + "&" + t + "&" + appKey + "&" + dataVal);

    const params = new URLSearchParams({
      jsv: "2.7.2",
      appKey: appKey,
      t: t,
      sign: sign,
      v: version,
      type: "originaljson",
      accountSite: "xianyu",
      dataType: "json",
      timeout: "20000",
      api: api,
      sessionOption: "AutoLoginOnly",
    });
    const url =
      "https://h5api.m.goofish.com/h5/" + api + "/" + version + "/?" + params.toString();

    const body = new URLSearchParams();
    body.set("data", dataVal);

    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    // 大整数精度修复:闲鱼 orderId 是 19 位长整数,超过 JS 安全整数范围
    // (Number.MAX_SAFE_INTEGER ≈ 16 位),直接 resp.json() 会把末几位抹成 0
    // (5120904457569002830 → 5120904457569002000),导致拿错订单号发货失败。
    // 解法:先取文本,把"冒号后的 ≥16 位整数值"包成字符串再 JSON.parse,
    // 这样长 ID 以字符串形式无损保留(itemId/buyerId 较短不受影响,仍是数字)。
    const respText = await resp.text();
    let json;
    try {
      const safe = respText.replace(
        /:(\s*)(-?\d{16,})(\s*[,}\]])/g,
        ':$1"$2"$3'
      );
      json = JSON.parse(safe);
    } catch (_) {
      json = JSON.parse(respText);
    }

    // 令牌过期：服务端已通过 set-cookie 刷新 _m_h5_tk，重试用新 token 重签
    const ret = (json && json.ret) || [];
    const retStr = (ret[0] || "") + "";
    if (/TOKEN_EXPIRED|TOKEN_EXOIRED|FAIL_SYS_TOKEN_EMPTY/i.test(retStr) && retry < 2) {
      await new Promise((r) => setTimeout(r, 400));
      return mtopRequest(api, version, dataObj, retry + 1, appKeyOverride);
    }
    // 透传 HTTP 状态,便于排查限流(403/429)等通道层问题。
    try {
      if (json && typeof json === "object" && !json.__http_status) {
        json.__http_status = resp.status;
      }
    } catch (_) {}
    return json;
  }

  // ── 发品(路 B′):在已登录的 goofish 发布页做 DOM 自动化 ───────────────────
  //
  // 移植自原项目 xianyu_publisher 的整体流程与选择器。约定:**调用前 background
  // 已确保当前 tab 就是发布页**(www.goofish.com/publish),所以这里不做导航,
  // 一次性跑完:上传图 → 填描述 → 等分类自动识别 → 填价格 → 设包邮 → 设所在地 →
  // 点发布 → 检测跳转判断成功。返回 {ok, item_id?, item_url?, error?}。

  function _pubSleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function _queryVisible(selectors) {
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (_isVisible(el)) return el;
        }
      } catch (_) {}
    }
    return null;
  }

  async function _waitVisible(selectors, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      const el = _queryVisible(selectors);
      if (el) return el;
      await _pubSleep(300);
    }
    return null;
  }

  function _clickEl(el) {
    try {
      el.scrollIntoView({ block: "center" });
    } catch (_) {}
    el.click();
  }

  // 找上传用的 <input type=file>。注意:闲鱼发布页该 input 是 display:none,
  // 绝不能用 _isVisible 过滤(否则永远找不到)。只要在 DOM 里就用。
  function _findFileInput() {
    const sels = [
      'input[type="file"][accept*="image"]',
      'input[type="file"]',
      'input[accept*="image"]',
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // 图片(本地 data: / 网络 URL)→ File 对象。
  async function _imageToFile(imageUrl, idx) {
    let blob;
    if (/^data:/i.test(imageUrl)) {
      const resp = await fetch(imageUrl);
      blob = await resp.blob();
    } else {
      const resp = await fetch(imageUrl, { credentials: "omit" });
      if (!resp.ok) throw new Error("读取图片失败 HTTP " + resp.status);
      blob = await resp.blob();
    }
    if (!blob || blob.size === 0) throw new Error("图片内容为空");
    let ext = "jpg";
    if (blob.type && blob.type.indexOf("/") > 0) ext = blob.type.split("/")[1] || "jpg";
    return new File([blob], "pub_" + Date.now() + "_" + (idx || 0) + "." + ext, {
      type: blob.type || "image/jpeg",
    });
  }

  async function _pubUploadImages(images) {
    // 等上传控件挂载(input 可能 display:none,故用 _findFileInput 不查可见性)。
    let fileInput = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      fileInput = _findFileInput();
      if (fileInput) break;
      await _pubSleep(300);
    }
    if (!fileInput) throw new Error("未找到图片上传输入框");

    // 发布页的 file input 带 multiple,一次性塞所有图(比逐张更稳,避免 React
    // 重渲染后 input 句柄失效)。
    const dt = new DataTransfer();
    let n = 0;
    for (let i = 0; i < images.length; i++) {
      try {
        dt.items.add(await _imageToFile(images[i], i));
        n++;
      } catch (e) {
        if (i === 0) throw e; // 第一张就失败 → 整体失败
      }
    }
    if (n === 0) throw new Error("没有可用图片");
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    // 等图上传完 + 闲鱼按图智能识别分类/属性。多图多等。
    await _pubSleep(3000 + n * 2500);
    return n;
  }

  function _pubFillDescription(title, description) {
    const sel = [
      'div[data-placeholder*="描述"]',
      'div[contenteditable="true"]',
      '[class*="editor"]',
      "textarea",
    ];
    const el = _queryVisible(sel);
    if (!el) throw new Error("未找到描述输入框");
    let full = "";
    if (title && description) full = title + "\n\n" + description;
    else full = title || description || "";
    if (el.tagName === "TEXTAREA") {
      _setNativeValue(el, full);
    } else {
      _setContentEditable(el, full);
    }
  }

  function _pubFillPrice(price, originalPrice) {
    // 真实发布页:价格/原价 input 的 placeholder 都是 "0.00",在
    // ant-input-affix-wrapper(带 ￥ 前缀)里。邮费框也是 0.00 但在
    // ant-form-item-hidden(display:none),_isVisible 会过滤掉它。
    // 可见的 input[placeholder="0.00"]:第1个=价格,第2个=原价。
    const inputs = [];
    document
      .querySelectorAll('.ant-input-affix-wrapper input, input[placeholder="0.00"], input[placeholder*="0.00"]')
      .forEach((el) => {
        if (_isVisible(el) && inputs.indexOf(el) < 0) inputs.push(el);
      });
    // 兜底:旧选择器
    if (inputs.length === 0) {
      const pi = _queryVisible(['input[placeholder*="价格"]', '[class*="price"] input']);
      if (pi) inputs.push(pi);
    }
    if (inputs[0]) _setNativeValue(inputs[0], String(price));
    if (originalPrice && Number(originalPrice) > 0 && inputs[1]) {
      _setNativeValue(inputs[1], String(originalPrice));
    }
    return inputs.length > 0;
  }

  function _pubSetFreeShipping() {
    // 发布页发货方式是 radio,包邮 value="0" 默认已 checked。保险点一下。
    const radio = document.querySelector('input.ant-radio-input[value="0"]');
    if (radio) {
      if (!radio.checked) _clickEl(radio);
      return true;
    }
    // 兜底:找含"包邮"的可点元素
    const cands = document.querySelectorAll("label, button, div, span");
    for (const el of cands) {
      if (!_isVisible(el)) continue;
      if ((el.textContent || "").trim() === "包邮") {
        _clickEl(el);
        return true;
      }
    }
    return false;
  }

  async function _pubWaitCategory() {
    // 闲鱼发布页分类是「上传主图/填写内容后智能识别」,不需要、也不应手动点
    // (手动点 categoryText 会打开属性面板干扰)。这里只等识别完成一会儿。
    await _pubSleep(2500);
  }

  // ── 主动选分类(AI 指定 category 时)─────────────────────────────────────
  // category 支持 "电子资料" 或多级路径 "一级/二级/三级"(/ 、> 、空格 都可分隔)。
  // 闲鱼分类面板结构会改版,这里走**文本驱动**:逐级在面板里找文字匹配的可点项,
  // 尽量点"叶子"节点(后代最少的精确匹配),最后点"确定"(若有)。

  // 在文档里找文本可点项:优先"文本完全等于 text 且后代最少"的叶子;退而求包含匹配的短文本元素。
  function _pubFindClickableByText(text) {
    const all = document.querySelectorAll(
      'li,div,span,button,a,[role="option"],[role="menuitem"],[class*="item"],[class*="cell"]'
    );
    let best = null;
    let bestDepth = Infinity;
    for (const el of all) {
      if (!_isVisible(el)) continue;
      const t = (el.textContent || "").trim();
      if (t !== text) continue;
      const depth = el.querySelectorAll("*").length;
      if (depth < bestDepth) {
        best = el;
        bestDepth = depth;
      }
    }
    if (best) return best;
    // 包含匹配兜底:取文本最短、且不是大容器的元素。
    let cand = null;
    let candLen = Infinity;
    for (const el of all) {
      if (!_isVisible(el)) continue;
      const t = (el.textContent || "").trim();
      if (!t || t.indexOf(text) < 0) continue;
      if (el.querySelectorAll("*").length > 4) continue;
      if (t.length < candLen) {
        cand = el;
        candLen = t.length;
      }
    }
    return cand;
  }

  async function _pubClickPanelItemByText(text, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
      const el = _pubFindClickableByText(text);
      if (el) {
        _clickEl(el);
        return true;
      }
      await _pubSleep(300);
    }
    return false;
  }

  function _pubClickConfirmIfAny() {
    const btns = document.querySelectorAll(
      '.ant-modal-footer button, [role="dialog"] button, button'
    );
    for (const b of btns) {
      if (!_isVisible(b)) continue;
      const t = (b.textContent || "").trim();
      if (t === "确定" || t === "确认" || t === "完成" || t === "保存") {
        _clickEl(b);
        return true;
      }
    }
    return false;
  }

  async function _pubSelectCategory(category) {
    if (!category) return { ok: true, skipped: true };
    const tokens = String(category)
      .split(/[/>\\,，、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) return { ok: true, skipped: true };

    // 1. 打开分类选择器:点"分类"那一行(categoryText / 含"分类"短文案的可点行)。
    let trigger =
      _queryVisible(['[class*="categoryText"]', '[class*="category--"]']) || null;
    if (!trigger) {
      const cands = document.querySelectorAll("div,span,label,button");
      for (const el of cands) {
        if (!_isVisible(el)) continue;
        const t = (el.textContent || "").trim();
        if (/分类/.test(t) && t.length <= 14) {
          trigger = el;
          break;
        }
      }
    }
    if (!trigger) return { ok: false, error: "category_trigger_not_found" };
    _clickEl(trigger);
    await _pubSleep(1200);

    // 2. 逐级点 token(每级在弹出的面板里找文字匹配项)。
    for (let i = 0; i < tokens.length; i++) {
      const ok = await _pubClickPanelItemByText(tokens[i], 6000);
      if (!ok) {
        return {
          ok: false,
          error: "category_item_not_found",
          detail: "分类面板里没找到:" + tokens[i],
        };
      }
      await _pubSleep(900);
    }
    // 3. 部分面板要点"确定"才生效。
    _pubClickConfirmIfAny();
    await _pubSleep(800);
    return { ok: true };
  }

  // ── 配送方式(虚拟品常用"无需邮寄";不传则默认包邮)──────────────────────
  async function _pubSetDelivery(delivery) {
    const want = String(delivery || "").trim();
    if (!want) return false;
    // 精确匹配优先(包邮 / 无需邮寄 / 一口价 / 按距离计费 / 支持自提)。
    const cands = document.querySelectorAll(
      'label,.ant-radio-wrapper,[role="radio"],button,div,span'
    );
    for (const el of cands) {
      if (!_isVisible(el)) continue;
      if ((el.textContent || "").trim() === want) {
        _clickEl(el);
        return true;
      }
    }
    for (const el of cands) {
      if (!_isVisible(el)) continue;
      const t = (el.textContent || "").trim();
      if (t && t.indexOf(want) >= 0 && t.length <= 12) {
        _clickEl(el);
        return true;
      }
    }
    return false;
  }


  async function _pubSetAddress(address) {
    // 发布页默认已带宝贝所在地(账号默认地址)。仅当调用方明确传了 address 才尝试改。
    if (!address) return;
    try {
      // 触发地址弹窗:点 addressWrap / address 文本块。
      let trigger =
        document.querySelector(".addressWrap--qO_6KVXf") ||
        document.querySelector('[class*="addressWrap"]') ||
        document.querySelector('[class*="address--"]');
      if (!trigger) {
        const cands = document.querySelectorAll("div, span, label");
        for (const el of cands) {
          if (!_isVisible(el)) continue;
          const t = (el.textContent || "").trim();
          if (t.indexOf("宝贝所在地") >= 0 && t.length < 30) {
            trigger = el;
            break;
          }
        }
      }
      if (!trigger) return;
      _clickEl(trigger);
      await _pubSleep(1200);
      const input = await _waitVisible(
        ['.ant-modal input', '[role="dialog"] input', 'input[placeholder*="请输入"]'],
        4000
      );
      if (!input) return;
      input.focus();
      _setNativeValue(input, address);
      await _pubSleep(2500);
      const opt = _queryVisible([
        ".amap-sug-result [class*='item']",
        ".ant-list-item",
        '[role="option"]',
        ".ant-modal li",
      ]);
      if (opt) {
        _clickEl(opt);
        await _pubSleep(800);
      }
      const cands2 = document.querySelectorAll(".ant-modal-footer button, button");
      for (const b of cands2) {
        if (!_isVisible(b)) continue;
        const t = (b.textContent || "").trim();
        if (t === "确定" || t === "确认" || t === "完成") {
          _clickEl(b);
          break;
        }
      }
      await _pubSleep(800);
    } catch (_) {}
  }

  async function publishItem(item) {
    // 必须在发布页执行。
    if (!/\/publish/.test(location.pathname + location.search) &&
        !/\/publish/.test(location.href)) {
      return { ok: false, error: "not_on_publish_page", detail: "当前不在发布页" };
    }
    const images = Array.isArray(item.images) ? item.images : [];
    if (images.length === 0) {
      return { ok: false, error: "no_images", detail: "发布必须至少一张图片" };
    }
    try {
      // 等发布表单渲染
      await _waitVisible(["input", "textarea", "button"], 30000);
      await _pubSleep(1500);

      await _pubUploadImages(images);
      // 上传内部已等待识别;这里再确保分类识别落定。
      await _pubWaitCategory();

      _pubFillDescription(item.title || "", item.description || "");
      await _pubSleep(1500);

      // 分类:调用方指定了 category 就主动逐级选;否则沿用闲鱼按图+描述自动识别。
      if (item.category) {
        const cat = await _pubSelectCategory(item.category);
        if (!cat.ok) {
          return {
            ok: false,
            error: cat.error || "category_select_failed",
            detail:
              (cat.detail || "分类选择失败") +
              "(可让 AI 用 read_page 勘查发布页分类面板结构后重试,或改用闲鱼能识别的关键词)",
          };
        }
        await _pubSleep(1200);
      }

      _pubFillPrice(item.price, item.original_price);
      await _pubSleep(800);

      // 配送方式:指定了就按指定选(虚拟品常用"无需邮寄"/"支持自提");否则默认包邮。
      if (item.delivery) {
        _pubSetDelivery(item.delivery);
      } else {
        _pubSetFreeShipping();
      }
      await _pubSleep(500);

      await _pubSetAddress(item.address || "");
      await _pubSleep(800);

      // 点发布
      const publishBtn = await _waitVisible(
        [
          '[class*="publish-button"]',
          'button[type="submit"]',
        ],
        5000
      ) || (function () {
        const bs = document.querySelectorAll("button");
        for (const b of bs) {
          if (_isVisible(b) && /发布|立即发布/.test(b.textContent || "")) return b;
        }
        return null;
      })();
      if (!publishBtn) {
        return { ok: false, error: "no_publish_button", detail: "未找到发布按钮" };
      }
      _clickEl(publishBtn);

      // 等结果:轮询 URL 跳转 / 成功文案,最多 ~12s
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        await _pubSleep(1000);
        const url = location.href;
        if (/\/item/.test(url) || /[?&]id=\d+/.test(url)) {
          const m = url.match(/[?&]id=(\d+)/) || url.match(/\/item\/(\d+)/);
          return {
            ok: true,
            item_url: url,
            item_id: m ? m[1] : "",
            message: "发布成功(已跳转商品页)",
          };
        }
        const body = (document.body && document.body.innerText) || "";
        if (/发布成功|已发布/.test(body)) {
          return { ok: true, message: "发布成功(页面提示)" };
        }
        if (/网页版暂不支持发布此分类/.test(body)) {
          return { ok: false, error: "category_unsupported", detail: "该分类网页版不支持发布,请换分类或手动发布" };
        }
        if (/发布失败/.test(body)) {
          return { ok: false, error: "publish_failed", detail: "页面提示发布失败" };
        }
      }
      return {
        ok: false,
        error: "not_redirected",
        detail: "点了发布但页面没跳转(可能:所在地未设/触发审核/风控/分类受限)。请在闲鱼页面看一眼。",
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function callXianyuApi(action, args) {
    args = args || {};
    try {
      if (action === "mtop") {
        const data = args.data || {};
        // 某些接口（商品列表）要求 data 里带卖家自己的 userId(unb)。Python 侧
        // 拿不到真实 unb，由扩展从页面 cookie 注入：inject_unb_as 指定填到哪个键。
        if (args.inject_unb_as) {
          const unb = _readCookie("unb");
          if (unb && !data[args.inject_unb_as]) {
            data[args.inject_unb_as] = unb;
          }
        }
        return await mtopRequest(args.api, args.version || "1.0", data, 0, args.app_key);
      }
      if (action === "publish_item") {
        // 发品(路 B′):在用户已登录的 goofish 页里做 DOM 自动化发布。
        // 移植自原项目 xianyu_publisher 的整体流程与选择器。
        return await publishItem(args.item || {});
      }
      if (action === "read_page") {
        // 页面勘查:返回当前页结构化的可交互元素清单(诊断/自愈用)。
        return _readPage(args || {});
      }
      return { error: "unknown_action", action: action };
    } catch (e) {
      console.warn("[DSH闲鱼] call_api 失败", action, e);
      return { error: String(e), action: action };
    }
  }

  // ── MD5（blueimp-md5, MIT）—— mtop sign 所需，crypto.subtle 不支持 MD5 ──────
  function md5(string) {
    return rstr2hex(rstrMD5(str2rstrUTF8(string)));
  }
  function rstrMD5(s) {
    return binl2rstr(binlMD5(rstr2binl(s), s.length * 8));
  }
  function rstr2hex(input) {
    const hexTab = "0123456789abcdef";
    let output = "";
    for (let i = 0; i < input.length; i += 1) {
      const x = input.charCodeAt(i);
      output += hexTab.charAt((x >>> 4) & 0x0f) + hexTab.charAt(x & 0x0f);
    }
    return output;
  }
  function str2rstrUTF8(input) {
    return unescape(encodeURIComponent(input));
  }
  function rstr2binl(input) {
    const output = [];
    output[(input.length >> 2) - 1] = undefined;
    for (let i = 0; i < output.length; i += 1) output[i] = 0;
    const length8 = input.length * 8;
    for (let i = 0; i < length8; i += 8) {
      output[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << i % 32;
    }
    return output;
  }
  function binl2rstr(input) {
    let output = "";
    const length32 = input.length * 32;
    for (let i = 0; i < length32; i += 8) {
      output += String.fromCharCode((input[i >> 5] >>> i % 32) & 0xff);
    }
    return output;
  }
  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function bitRotateLeft(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }
  function md5cmn(q, a, b, x, s, t) {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function md5ff(a, b, c, d, x, s, t) {
    return md5cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function md5gg(a, b, c, d, x, s, t) {
    return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function md5hh(a, b, c, d, x, s, t) {
    return md5cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function md5ii(a, b, c, d, x, s, t) {
    return md5cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  function binlMD5(x, len) {
    x[len >> 5] |= 0x80 << len % 32;
    x[(((len + 64) >>> 9) << 4) + 14] = len;
    let a = 1732584193;
    let b = -271733879;
    let c = -1732584194;
    let d = 271733878;
    for (let i = 0; i < x.length; i += 16) {
      const olda = a;
      const oldb = b;
      const oldc = c;
      const oldd = d;
      a = md5ff(a, b, c, d, x[i], 7, -680876936);
      d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = md5ff(c, d, a, b, x[i + 2], 17, 606105819);
      b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = md5ff(a, b, c, d, x[i + 4], 7, -176418897);
      d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341);
      b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416);
      d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = md5ff(c, d, a, b, x[i + 10], 17, -42063);
      b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682);
      d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290);
      b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);
      a = md5gg(a, b, c, d, x[i + 1], 5, -165796510);
      d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = md5gg(c, d, a, b, x[i + 11], 14, 643717713);
      b = md5gg(b, c, d, a, x[i], 20, -373897302);
      a = md5gg(a, b, c, d, x[i + 5], 5, -701558691);
      d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = md5gg(c, d, a, b, x[i + 15], 14, -660478335);
      b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = md5gg(a, b, c, d, x[i + 9], 5, 568446438);
      d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = md5gg(c, d, a, b, x[i + 3], 14, -187363961);
      b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467);
      d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473);
      b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);
      a = md5hh(a, b, c, d, x[i + 5], 4, -378558);
      d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562);
      b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060);
      d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = md5hh(c, d, a, b, x[i + 7], 16, -155497632);
      b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = md5hh(a, b, c, d, x[i + 13], 4, 681279174);
      d = md5hh(d, a, b, c, x[i], 11, -358537222);
      c = md5hh(c, d, a, b, x[i + 3], 16, -722521979);
      b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = md5hh(a, b, c, d, x[i + 9], 4, -640364487);
      d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = md5hh(c, d, a, b, x[i + 15], 16, 530742520);
      b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);
      a = md5ii(a, b, c, d, x[i], 6, -198630844);
      d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905);
      b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571);
      d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = md5ii(c, d, a, b, x[i + 10], 15, -1051523);
      b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359);
      d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380);
      b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = md5ii(a, b, c, d, x[i + 4], 6, -145523070);
      d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = md5ii(c, d, a, b, x[i + 2], 15, 718787259);
      b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);
      a = safeAdd(a, olda);
      b = safeAdd(b, oldb);
      c = safeAdd(c, oldc);
      d = safeAdd(d, oldd);
    }
    return [a, b, c, d];
  }
})();

