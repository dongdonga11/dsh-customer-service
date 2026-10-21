// probe_cover.js —— 封面上传网络探针（一次性调研，不参与正常投稿链路）。
//
// 背景：选图后出现「设置封面」裁剪弹层（.image-uploader），点「保存」会走
// 「正在上传封面」；若最终失败，问题多半在**上传 API 响应**，不是 DOM 点不到。
// 私信探针靠正文 token；封面是二进制/ multipart，改用 URL 关键词过滤。
//
// ── 用法（创作者中心投稿编辑页 Console）────────────────────────────────
//   1. 打开含封面编辑的页面（出现裁剪弹层前后均可）
//   2. F12 → Console，粘贴本文件全文回车
//   3. 手动：上传封面 → 裁剪弹层 → 点「保存」
//   4. Console 会打出可疑请求；完成后 __hermesCoverProbe.dump()
//   5. 把 JSON 发回来；__hermesCoverProbe.off() 卸载
//
// 只读：不改请求内容，只记录 URL / 状态码 / 响应片段 / 调用栈。
(function () {
  "use strict";

  if (window.__hermesCoverProbe && window.__hermesCoverProbe.__installed) {
    console.warn("[封面探针] 已安装，先 __hermesCoverProbe.off() 再重装");
    return;
  }

  const hits = [];
  const MAX_RESP = 8 * 1024;
  const MAX_HITS = 80;

  // URL 命中：封面 / 图片上传相关（宁可多抓，dump 时再筛）
  const URL_RE =
    /cover|封面|image|imagex|upload|vupload|tos-|byteimg|creator\/|media\/|aweme\/v|video\/|crop|thumbnail|poster|pic/i;

  // 明显无关的噪音
  const NOISE_RE =
    /\/favicon|\/telemetry|\/log\/|\/collect|\/monitor|\/sentry|google|hotjar|clarity|sockjs|websocket/i;

  function interestingUrl(url) {
    const u = String(url || "");
    if (!u || NOISE_RE.test(u)) return false;
    if (URL_RE.test(u)) return true;
    // 创作者域名上的 POST 也值得看一眼
    if (/creator\.douyin\.com|douyin\.com|byteoversea|bytedance/i.test(u)) {
      return true;
    }
    return false;
  }

  function stackOf() {
    try {
      return (new Error().stack || "").split("\n").slice(2, 16).join("\n");
    } catch (_) {
      return "";
    }
  }

  function clipText(t, n) {
    t = String(t == null ? "" : t);
    if (t.length <= n) return t;
    return t.slice(0, n) + "…[clipped]";
  }

  function headersToObject(h) {
    try {
      if (!h) return null;
      if (typeof Headers !== "undefined" && h instanceof Headers) {
        const o = {};
        h.forEach(function (v, k) {
          o[k] = v;
        });
        return o;
      }
      if (Array.isArray(h)) {
        const o = {};
        for (let i = 0; i < h.length; i++) {
          const pair = h[i];
          if (pair && pair.length >= 2) o[pair[0]] = pair[1];
        }
        return o;
      }
      if (typeof h === "object") return h;
    } catch (_) {}
    return null;
  }

  function describeReqBody(body) {
    try {
      if (body == null) return { kind: "empty" };
      if (typeof body === "string") {
        return { kind: "text", bytes: body.length, preview: clipText(body, 400) };
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const keys = [];
        body.forEach(function (_v, k) {
          keys.push(k);
        });
        return { kind: "formdata", keys: keys };
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) {
        return { kind: "blob", bytes: body.size, type: body.type || "" };
      }
      if (body instanceof ArrayBuffer) {
        return { kind: "arraybuffer", bytes: body.byteLength };
      }
      if (ArrayBuffer.isView(body)) {
        return { kind: "typedarray", bytes: body.byteLength };
      }
      return { kind: typeof body };
    } catch (_) {
      return { kind: "unknown" };
    }
  }

  function pushHit(entry) {
    if (hits.length >= MAX_HITS) return;
    entry.at = new Date().toISOString();
    hits.push(entry);
    const badge =
      entry.ok === false || (entry.status && entry.status >= 400)
        ? "#d1242f"
        : "#fe2c55";
    console.log(
      "%c[封面探针] " + entry.channel + " " + (entry.method || "") + " " + (entry.status || ""),
      "color:#fff;background:" + badge + ";padding:2px 6px;border-radius:3px",
      entry.url
    );
    if (entry.resp_preview) console.log("  resp:", entry.resp_preview);
    if (entry.error) console.log("  err:", entry.error);
  }

  // ── fetch ───────────────────────────────────────────────────────────────

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      const url =
        typeof input === "string"
          ? input
          : (input && input.url) || String(input);
      const method = String(
        (init && init.method) || (input && input.method) || "GET"
      ).toUpperCase();
      const watch = interestingUrl(url) && method !== "GET" && method !== "HEAD";
      // GET 图片 CDN 太多；只记非 GET，或 URL 强相关 cover/upload
      const watchGet =
        interestingUrl(url) &&
        (method === "GET" || method === "HEAD") &&
        /cover|upload|imagex|vupload|thumbnail|poster/i.test(url);

      const p = nativeFetch.apply(this, arguments);
      if (!watch && !watchGet) return p;

      const reqBody = describeReqBody(init && init.body);
      return p.then(
        function (resp) {
          const cloned = resp.clone();
          cloned
            .text()
            .then(function (text) {
              pushHit({
                channel: "fetch",
                method: method,
                url: url,
                status: resp.status,
                ok: resp.ok,
                req_headers: headersToObject(init && init.headers),
                req_body: reqBody,
                resp_preview: clipText(text, MAX_RESP),
                stack: stackOf(),
              });
            })
            .catch(function (e) {
              pushHit({
                channel: "fetch",
                method: method,
                url: url,
                status: resp.status,
                ok: resp.ok,
                req_body: reqBody,
                error: "read body: " + String((e && e.message) || e),
                stack: stackOf(),
              });
            });
          return resp;
        },
        function (err) {
          pushHit({
            channel: "fetch",
            method: method,
            url: url,
            ok: false,
            req_body: reqBody,
            error: String((err && err.message) || err),
            stack: stackOf(),
          });
          throw err;
        }
      );
    };
    window.fetch.__hermesCoverProbe = true;
  }

  // ── XHR ─────────────────────────────────────────────────────────────────

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__coverProbeMethod = method;
      this.__coverProbeUrl = url;
      this.__coverProbeHeaders = {};
    } catch (_) {}
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      if (this.__coverProbeHeaders) this.__coverProbeHeaders[k] = v;
    } catch (_) {}
    return nativeSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__coverProbeUrl || "";
      const method = String(this.__coverProbeMethod || "GET").toUpperCase();
      const watch =
        interestingUrl(url) &&
        (method !== "GET" && method !== "HEAD"
          ? true
          : /cover|upload|imagex|vupload|thumbnail|poster/i.test(url));
      if (watch) {
        const xhr = this;
        const reqBody = describeReqBody(body);
        xhr.addEventListener("loadend", function () {
          pushHit({
            channel: "xhr",
            method: method,
            url: url,
            status: xhr.status,
            ok: xhr.status >= 200 && xhr.status < 300,
            req_headers: xhr.__coverProbeHeaders || null,
            req_body: reqBody,
            resp_preview: clipText(xhr.responseText || "", MAX_RESP),
            stack: stackOf(),
          });
        });
      }
    } catch (_) {}
    return nativeSend.apply(this, arguments);
  };

  // ── 对外 ────────────────────────────────────────────────────────────────

  window.__hermesCoverProbe = {
    __installed: true,
    hits: hits,
    /** 全部记录 JSON（优先把 status>=400 或 ok:false 的发回来）。 */
    dump: function () {
      const failed = hits.filter(function (h) {
        return h.ok === false || (h.status && h.status >= 400);
      });
      const json = JSON.stringify(
        {
          kind: "cover_upload_probe",
          total: hits.length,
          failed_count: failed.length,
          failed: failed,
          hits: hits,
        },
        null,
        2
      );
      try {
        if (typeof copy === "function") {
          copy(json);
          console.log(
            "[封面探针] 已复制 " +
              hits.length +
              " 条（失败 " +
              failed.length +
              "）到剪贴板"
          );
        }
      } catch (_) {}
      return json;
    },
    /** 只看失败/非 2xx。 */
    dumpFailed: function () {
      const failed = hits.filter(function (h) {
        return h.ok === false || (h.status && h.status >= 400);
      });
      const json = JSON.stringify(failed, null, 2);
      try {
        if (typeof copy === "function") {
          copy(json);
          console.log("[封面探针] 已复制 " + failed.length + " 条失败请求");
        }
      } catch (_) {}
      return json;
    },
    off: function () {
      try {
        if (window.fetch && window.fetch.__hermesCoverProbe) {
          window.fetch = nativeFetch;
        }
      } catch (_) {}
      XMLHttpRequest.prototype.open = nativeOpen;
      XMLHttpRequest.prototype.send = nativeSend;
      XMLHttpRequest.prototype.setRequestHeader = nativeSetHeader;
      window.__hermesCoverProbe.__installed = false;
      console.log("[封面探针] 已卸载");
    },
  };

  console.log(
    "%c[封面探针] 已安装",
    "color:#fff;background:#2ea043;padding:2px 6px;border-radius:3px"
  );
  console.log(
    "下一步：手动上传封面 → 裁剪弹层点「保存」→ 等「正在上传封面」结束"
  );
  console.log(
    "然后 __hermesCoverProbe.dump() 或 dumpFailed()；卸载 __hermesCoverProbe.off()"
  );
})();
