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
 *     //   日期按原值使用；时刻取本地到期日期，并保留 resetInstant，不减一天。
 *     //   semantics 沿用 normalize.js 的 "lastUsableDay" / "resetsAt" 兼容取值。
 *     extract: function (capture) { return [ ... ]; },
 *     // 可选：已知接口的页面内直读配置（目前只有 Qoder）。
 *     // 有 direct 的平台不再注入钩子，background 会开同源页执行一次只读 GET。
 *     direct: { url, pageUrl, loginPath, method: "GET", headers, csrf, timezone },
 *     // 可选：这份响应是否枚举了该平台**当下的全部**批次（LobsterAI / WorkBuddy）。
 *     // 标了 authoritative 的平台，同步时"本次没出现"的批次会被关掉（closed），
 *     // 不再计入余额——因为它的接口是把花完的批次直接摘掉，而不是给 0。
 *     // 只对活读样本生效，粘贴的旧样本不会用这个口径去关批次。
 *     authoritative: true
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
  function orderedCaptures(captures, agentId) {
    var pool = (captures || []).filter(function (c) {
      return c && c.agentId === agentId && c.bodyPreview;
    });
    /* 非 2xx 响应先剔掉：它们不可能是额度数据，只适合用来解释失败。
     * 反例（v0.3.32）：TRAE 接口 URL 自带 entitlement，401 的启发式分数是 2，
     * 会被正常入库并成为同接口最新的一条；旧逻辑同接口取最新，于是每次同步都
     * 选中这条 401、报 adapter-threw，把旁边可用的 200 样本完全挡住。
     * 只有池子里**全是**非 2xx 时才保留，让 adapter 说出「登录态失效」这种
     * 准确原因，而不是假装没样本。 */
    var okStatus = pool.filter(function (c) {
      return !c.status || (c.status >= 200 && c.status < 300);
    });
    if (okStatus.length) pool = okStatus;
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
    // 同一个接口的多份样本：**新的赢**，分数只在跨接口时用来分高下。
    //
    // 分数衡量的是"这个接口像不像额度数据"，是接口形状的属性，跟新鲜度无关；
    // 一旦 hint 已经把范围收到唯一一个接口，再按分数排就会出错——而错误方向
    // 恰好是最糟的那种：批次变少（余额被花完）时响应里的额度字段跟着变少，
    // 新样本分数反而更低（实测：15 笔 → 9 分，2 笔 → 7 分），于是永远选回旧样本，
    // 表现就是「点了刷新、数字不动、和后台对不上」。v0.3.17 修的就是这个。
    var sameUrl = pool.length > 1 && pool.every(function (c) { return c.url === pool[0].url; });
    pool.sort(function (a, b) {
      var byAt = String(b.at || "").localeCompare(String(a.at || ""));
      if (sameUrl) return byAt;
      var s = (b.score || 0) - (a.score || 0);
      return s !== 0 ? s : byAt;
    });
    return pool;
  }

  /** 选最可能的那一条（= 有序候选里的第一条）。 */
  function pickCapture(captures, agentId) {
    return orderedCaptures(captures, agentId)[0] || null;
  }

  /** 对单条样本跑一次映射。返回 runSync 的同形结果。 */
  function extractOne(agentId, capture, N, now) {
    // 截断的样本很可能让 JSON.parse 直接失败，先说清楚，别让人以为平台没数据
    if (capture.truncated) {
      return { ok: false, reason: "truncated", message: "样本被截断了，去授权面板点「刷新余额」再截一次" };
    }
    var ad = get(agentId);
    // 有接口提示却选中了别的接口，说明目标接口的样本根本不在库里（多是被样本
    // 上限挤掉的，见 background.js 的 captureRank）。这时再说「没认出批次」会把
    // 人引向接口改版，必须说清手上只有哪个接口。
    if (ad.endpointHint && !ad.endpointHint.test(String(capture.url || ""))) {
      return {
        ok: false, reason: "no-target",
        message: "样本库里只有 " + String(capture.url || "").slice(0, 120)
          + "，没有额度接口的样本；去「授权与样本」再点一次「刷新余额」"
      };
    }

    var rows;
    try {
      rows = ad.extract(capture) || [];
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
    return {
      ok: true, batches: batches,
      // via 要带出去：syncOne 只有知道这份样本是活读的还是粘贴的，才敢用
      // 「没出现 = 这笔没了」去关批次（见 mergeBatches 规则 5）。
      capture: { url: capture.url, score: capture.score || 0, at: capture.at, via: capture.via || null }
    };
  }

  /**
   * 跑一次映射：capture 样本 -> normalizeBatch -> 批次数组。
   * 纯函数，不碰 chrome.*，不写存储，所以能在 node 里直接测。
   *
   * 按候选顺序逐条尝试：最新的一条解析失败（被重定向成登录页 HTML、接口临时
   * 返回坏结构）时，回退到上一条可用样本，而不是让整个平台同步失败。
   * 池子里通常只有一条（同一接口只保留最新），所以常见路径行为不变。
   */
  function runSync(agentId, captures, now) {
    var N = root.CreditNormalize;
    if (!N) return { ok: false, reason: "no-normalize", message: "normalize.js 没加载" };
    if (!has(agentId)) return { ok: false, reason: "no-adapter" };

    var pool = orderedCaptures(captures, agentId);
    if (!pool.length) return { ok: false, reason: "no-capture", message: "这个平台还没有捕获样本" };

    var primary = null;
    for (var i = 0; i < pool.length; i++) {
      var r = extractOne(agentId, pool[i], N, now);
      if (r.ok) return r;
      if (!primary) primary = r;
    }
    return primary;
  }

  var api = {
    register: register, get: get, has: has, listMissing: listMissing,
    pickCapture: pickCapture, runSync: runSync
  };
  root.CreditAdapters = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
