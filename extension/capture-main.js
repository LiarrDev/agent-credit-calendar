/*
 * capture-main.js — 注入到目标站点的 MAIN world，在页面自己的 JS 跑起来之前劫持
 * window.fetch 与 XMLHttpRequest，把响应截获下来。
 *
 * 为什么走 MAIN world：只有在这里才能包到页面自己发出的请求，从而完全复用它的
 * 登录态与鉴权头——我们不需要、也不去碰它的 token 是怎么生成的。
 *
 * 隐私边界（重要）：
 *   - 只上报请求头的【名字】，绝不上报值。Authorization / Cookie 的真实内容不离开页面。
 *   - 响应体截断到 200KB，交给 service worker 再做一次脱敏和打分。
 *   - 静态资源、埋点、扩展自身的请求全部跳过。
 */
(function () {
  "use strict";
  if (window.__creditCaptureHooked) return;
  window.__creditCaptureHooked = true;

  var MAX_BODY = 200000;
  var SKIP = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(\?|$)/i;
  var SKIP_HOST = /(google-analytics|googletagmanager|sentry|analytics|log\.|track|beacon|hotjar|clarity|facebook|doubleclick)/i;

  function skip(url) {
    if (!url) return true;
    if (/^(data|blob|chrome-extension):/i.test(url)) return true;
    if (SKIP.test(url)) return true;
    if (SKIP_HOST.test(url)) return true;
    return false;
  }

  /** 只取 header 名字。任何情况下都不读 value。 */
  function headerNames(h) {
    var out = [];
    try {
      if (!h) return out;
      if (typeof Headers !== "undefined" && h instanceof Headers) {
        h.forEach(function (_v, k) { out.push(k); });
      } else if (Array.isArray(h)) {
        h.forEach(function (p) { if (p && p[0]) out.push(String(p[0])); });
      } else if (typeof h === "object") {
        Object.keys(h).forEach(function (k) { out.push(k); });
      }
    } catch (e) { /* 结构不认识就算了 */ }
    return out;
  }

  function post(entry) {
    try {
      entry.origin = location.origin;
      entry.pageUrl = location.href;
      entry.at = Date.now();
      window.postMessage({ __creditCapture: true, entry: entry }, "*");
    } catch (e) { /* 中继没注入进来，静默丢掉即可 */ }
  }

  /**
   * 让包装函数的 toString 看起来像原生函数。
   *
   * 为什么需要：部分站点的反爬脚本会检查 window.fetch / XHR 方法是不是被包过
   * （toString 里有没有 "[native code]"）。被判定为"被hook"的后果可能是会话被
   * 服务端作废——2026-10-21 用户在 Opera 上 qoder.com 登录态异常消失，
   * 最可疑的就是这一类检测（该站带 bx-v / isg / tfstk 等阿里系反爬标记）。
   *
   * 边界说清楚：这只覆盖 fetch.toString() / String(fetch) 这类调用；
   * Function.prototype.toString.call(fetch) 仍会看到真源码。要连那条路一起堵
   * 就得改 Function.prototype.toString 本身，对页面侵入太大，不做。
   * 真被检测站点针对时，正解是「解除钩子 + 粘贴样本」那条退路，不是军备竞赛。
   */
  function nativeLooking(fn, name) {
    try {
      Object.defineProperty(fn, "toString", {
        value: function () { return "function " + name + "() { [native code] }"; },
        configurable: true, writable: true
      });
    } catch (e) { /* 定义不上就算了，不影响功能 */ }
    return fn;
  }

  /* ---------- fetch ---------- */
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || "GET";
      var names = headerNames(init && init.headers);
      var promise = origFetch.apply(this, arguments);
      if (!skip(url)) {
        promise.then(function (res) {
          try {
            // 流式响应（SSE，比如聊天补全）不读：clone().text() 会把整条流缓冲到结束，
            // 既吃内存又可能拖住页面。超大响应同理，按 content-length 提前放弃。
            var ct = "";
            var cl = 0;
            try {
              ct = res.headers.get("content-type") || "";
              cl = parseInt(res.headers.get("content-length") || "0", 10) || 0;
            } catch (e) {}
            if (/text\/event-stream/i.test(ct)) return;
            if (cl > 2000000) return;
            res.clone().text().then(function (text) {
              var whole = String(text);
              post({ url: url, method: method, status: res.status,
                     requestHeaderNames: names, body: whole.slice(0, MAX_BODY),
                     truncated: whole.length > MAX_BODY, via: "fetch" });
            }).catch(function () {});
          } catch (e) {}
        }).catch(function () {});
      }
      return promise;
    };
    nativeLooking(window.fetch, "fetch");
  }

  // XHR 的 open/send 在 MAIN world 里，顺手记下 URL 与方法（不记请求头的值）。
  //
  // 存在 WeakMap 而不是挂在 xhr 实例上：__ccUrl 这类可枚举自有属性，页面脚本
  // for…in 一把就能看见——这本身就是"fetch/XHR 被人包过"的可检测特征，而某些
  // 站点（带反爬标记的）正是靠这类检测把会话作废的。WeakMap 不可枚举，
  // 也不会阻止 xhr 被回收。
  var meta = new WeakMap();

  var O = XMLHttpRequest.prototype.open;
  var S = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    meta.set(this, { method: method, url: url, headers: [] });
    return O.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var m = meta.get(xhr) || { method: "GET", url: "", headers: [] };
    if (!skip(m.url)) {
      // once：同一个 XHR 复用多次 send 时不会累积监听器、也就不会重复上报。
      xhr.addEventListener("loadend", function () {
        try {
          var t = "";
          if (xhr.responseType === "" || xhr.responseType === "text") t = xhr.responseText || "";
          else if (xhr.responseType === "json") {
            // responseType:"json" 时访问 responseText 直接抛 InvalidStateError，
            // 上报就成了空响应体——打分必然为 0，看起来像"页面没发请求"。
            // 页面拿得到 xhr.response，把对象串回去即可。
            try { t = JSON.stringify(xhr.response) || ""; } catch (e2) {}
          }
          var whole = String(t);
          post({ url: m.url, method: m.method || "GET", status: xhr.status,
                 requestHeaderNames: m.headers, body: whole.slice(0, MAX_BODY),
                 truncated: whole.length > MAX_BODY, via: "xhr" });
        } catch (e) {}
      }, { once: true });
    }
    return S.apply(this, arguments);
  };

  // setRequestHeader 也在 MAIN world 里，顺手记下 header 名字（同样不记值）
  var SRH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, _value) {
    var m = meta.get(this);
    if (m) m.headers.push(String(name));
    return SRH.apply(this, arguments);
  };
  nativeLooking(XMLHttpRequest.prototype.open, "open");
  nativeLooking(XMLHttpRequest.prototype.send, "send");
  nativeLooking(XMLHttpRequest.prototype.setRequestHeader, "setRequestHeader");

  try { window.postMessage({ __creditCaptureReady: true }, "*"); } catch (e) {}
})();
