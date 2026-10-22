/*
 * adapters/index.js — 「响应样本 → 积分批次」的字段映射层。
 *
 * 为什么单独一层：抓取到的 JSON 长什么样，只有看过真实样本才知道。
 * 这一层的输入输出口径先定死，平台样本进来时只需要往 registry 里塞一个
 * extract()，不用再动 background 和 UI。
 *
 * adapter 契约（每个平台一个对象）：
 *   {
 *     agentId:   "qoder",
 *     endpointHint: /credit|usage|quota/i,   // 同一平台截到多个接口时，选样本用
 *     // capture: sanitizeCapture() 之后的样本（url / method / status / bodyPreview / truncated）
 *     // 返回原始批次数组，字段名对齐 normalizeBatch 的入参：
 *     //   { label, granted, remaining, expiry, semantics, unit }
 *     //   semantics 取值必须用 normalize.js 认的两个词（写别的词一律按清零时刻减一天）：
 *     //     "lastUsableDay" 原文已是最后一天，直接用；"resetsAt" 清零时刻，会减一天；省略同 resetsAt
 *     extract: function (capture) { return [ ... ]; },
 *     // 可选：已知接口的页面内直读配置（目前只有 Qoder）。
 *     // 有 direct 的平台不再注入钩子，background 会开同源页执行一次只读 GET。
 *     direct: { url, pageUrl, loginPath, method: "GET", headers, csrf, timezone }
 *   }
 *
 * 当前 Qoder / LobsterAI / TRAE / WorkBuddy 四家已进 registry；没有样本的平台仍会
 * 明确回 no-adapter，而不是猜一个映射出来把假数据显示成真抓的数据。
 */
(function (root) {
  "use strict";

  var registry = {};

  function register(agentId, adapter) {
    if (!adapter || typeof adapter.extract !== "function") {
      throw new Error("adapter 必须实现 extract(capture)");
    }
    adapter.agentId = agentId;
    registry[agentId] = adapter;
    return adapter;
  }

  function get(agentId) { return registry[agentId] || null; }
  function has(agentId) { return !!registry[agentId]; }
  function listMissing(agentIds) {
    return (agentIds || []).filter(function (id) { return !has(id); });
  }

  /**
   * 同一平台多个样本时选最可能的那个。
   *
   * v0.3.2：先按 adapter 的 endpointHint 圈定接口，再在圈内比分。
   * 只看分数会选错——LobsterAI 的 portal 一次加载会发十来个请求，
   * usage-conversations / plans / subscription 这些高分响应里没有 creditItems，
   * 会把真正的 profile-summary（分数反而低）挤掉，表现成"adapter 没认出批次"。
   * hint 是接口形状的一部分，必须参与选样本；没有 hint 或圈内为空时才退回总分。
   */
  function pickCapture(captures, agentId) {
    var pool = (captures || []).filter(function (c) {
      return c && c.agentId === agentId && c.bodyPreview;
    });
    // 直读平台优先用本次页面里读到的样本。升级前可能留着旧的粘贴样本，
    // 它的启发式分数有可能更高（比如旧响应里刚好有更多额度字段），
    // 但那份是快照；不优先直读的话，刚读到的数字会被旧样本盖住。
    var ad = get(agentId);
    if (ad && ad.direct) {
      var fresh = pool.filter(function (c) { return c.via === "direct"; });
      if (fresh.length) pool = fresh;
    }
    if (ad && ad.endpointHint) {
      var hinted = pool.filter(function (c) {
        return ad.endpointHint.test(String(c.url || ""));
      });
      if (hinted.length) pool = hinted;
    }
    // 截断样本一定跑不出批次。升级前存下的 60KB 旧样本可能分数更高，
    // 不能让它在完整样本入库后继续被选中；只有全都截断时才保留它来报 truncated。
    var usable = pool.filter(function (c) { return !c.truncated; });
    if (usable.length) pool = usable;
    pool.sort(function (a, b) {
      var s = (b.score || 0) - (a.score || 0);
      return s !== 0 ? s : String(b.at || "").localeCompare(String(a.at || ""));
    });
    return pool[0] || null;
  }

  /**
   * 跑一次映射：capture 样本 -> normalizeBatch -> 批次数组。
   * 纯函数，不碰 chrome.*，不写存储，所以能在 node 里直接测。
   * 返回 { ok, batches, capture, reason?, message? }
   */
  function runSync(agentId, captures, now) {
    var N = root.CreditNormalize;
    if (!N) return { ok: false, reason: "no-normalize", message: "normalize.js 没加载" };
    if (!has(agentId)) return { ok: false, reason: "no-adapter" };

    var capture = pickCapture(captures, agentId);
    if (!capture) return { ok: false, reason: "no-capture", message: "这个平台还没有捕获样本" };
    if (capture.truncated) {
      // 截断的样本很可能让 JSON.parse 直接失败，先说清楚，别让人以为平台没数据
      return { ok: false, reason: "truncated", message: "样本被截断了，去授权面板点「刷新余额」再截一次" };
    }

    var rows;
    try {
      rows = get(agentId).extract(capture) || [];
    } catch (e) {
      return { ok: false, reason: "adapter-threw", message: String((e && e.message) || e) };
    }
    if (!Array.isArray(rows) || !rows.length) {
      return { ok: false, reason: "no-rows", message: "adapter 没从这份样本里认出批次" };
    }

    var batches = rows.map(function (r) {
      return N.normalizeBatch(Object.assign({ agent: agentId, unit: "credits", source: "auto" }, r), { now: now });
    }).filter(Boolean);
    if (!batches.length) {
      return { ok: false, reason: "no-rows", message: "认出了条目，但没有一条能拿到合法的到期日" };
    }
    return { ok: true, batches: batches, capture: { url: capture.url, score: capture.score || 0, at: capture.at } };
  }

  var api = {
    register: register, get: get, has: has, listMissing: listMissing,
    pickCapture: pickCapture, runSync: runSync
  };
  root.CreditAdapters = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
