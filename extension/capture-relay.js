/*
 * capture-relay.js — ISOLATED world 的中继。
 *
 * MAIN world 里没有 chrome.runtime，所以由这层把捕获结果转给 service worker。
 * 同时它负责告诉 SW「注入成功了」，SW 据此决定是等捕获还是直接判定该平台抓不到。
 *
 * 信任边界（想清楚再改）：MAIN world 与页面脚本共享同一个 JS 环境，页面自己的
 * 脚本同样能 postMessage 伪造 __creditCapture，而中继拿不到任何页面读不到的
 * 密钥——发给 MAIN world 的东西页面都看得见。所以这里只做形状校验（同源、
 * 字段类型、体量上限），挡住跨 iframe 与明显畸形的伪造；站点若想往日历里塞
 * 假余额，它在自己页面上就能做到，不依赖这条通道。要彻底杜绝只能放弃截获，
 * 走「粘贴样本」那种人来确认的通道。
 */
(function () {
  "use strict";

  var MAX_ENTRY_BODY = 200000;   // 与 capture-main.js 的 MAX_BODY 对齐

  /** 入库前的最后一道形状闸：非 http(s)、状态码离谱、体量超限、跨源伪造一律丢弃。 */
  function validEntry(entry, origin) {
    if (!entry || typeof entry !== "object") return false;
    if (typeof entry.url !== "string" || !/^https?:/i.test(entry.url)) return false;
    if (typeof entry.body !== "string" || entry.body.length > MAX_ENTRY_BODY) return false;
    var st = Number(entry.status);
    if (!isFinite(st) || st < 100 || st >= 600) return false;
    if (origin && entry.origin && entry.origin !== origin) return false;
    return true;
  }

  function send(msg) {
    try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); }
    catch (e) { /* SW 刚被回收，下一次消息会把它唤醒 */ }
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d) return;

    if (d.__creditCaptureReady) {
      send({ type: "HOOK_READY", origin: location.origin, pageUrl: location.href });
      return;
    }
    if (d.__creditCapture && d.entry) {
      if (!validEntry(d.entry, location.origin)) return;
      // agentId 一律不转发：它决定这份样本最终记到哪个平台的账上，而 MAIN world
      // 与页面脚本共享同一个 JS 环境，页面可以自己 postMessage 伪造一条带 agentId
      // 的 entry。平台归属只能由后台按「这条消息来自哪个 tab」来定，页面说了不算。
      // 不放行它，站点就顶多能伪造**自己**那一家的样本——这正是我们声明的边界。
      delete d.entry.agentId;
      send({ type: "CAPTURED", entry: d.entry });
    }
  }, false);

  send({ type: "RELAY_READY", origin: location.origin, pageUrl: location.href });
})();
