/* qoder 真 adapter： node test/qoder.test.cjs
 *
 * 样本骨架来自 2026-10-21 用户提供的真实响应（GET /api/v2/me/usages/big_model_credits），
 * 但 id / user_id 全换成假值，条目数裁到最小——仓库里不留用户的真实数据。
 */
process.env.TZ = "UTC";
var N = require("../lib/normalize.js");
require("../lib/agents.js");
require("../lib/store.js");
var D = require("../adapters/index.js");
require("../adapters/qoder.js");   // 注册真 adapter

var pass = 0, fail = 0;
function eq(l, g, w) {
  var a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) pass++; else { fail++; console.log("FAIL  " + l + "\n      got  " + a + "\n      want " + b); }
}

var T1 = Date.UTC(2026, 10, 20, 2, 0, 0);   // 2026-11-20T02:00Z -> 最后可用日 11-19
var T2 = Date.UTC(2026, 9, 23, 1, 52, 0);   // 2026-10-23T01:52Z -> 10-22
var T3 = Date.UTC(2026, 9, 22, 0, 0, 0);    // 2026-10-22T00:00Z -> 10-21

function entry(id, limit, used, remaining, expires, source) {
  return { id: id, limit_value: limit, used_value: used, remaining_value: remaining,
           unit: "credits", is_active: true, usage_percentage: 0,
           expires_at: expires, source: source || "RESOURCE_PACKAGE_SOURCE_BONUS", status: "ACTIVE" };
}

var BODY = JSON.stringify({
  user_id: "fake-user",
  quota_key: "big_model_credits",
  status: "active",
  plan_quota: {
    quota_summary: { used_value: 0, limit_value: 0, remaining_value: 0, unit: "credits" },
    quota_detail: [entry("plan-0001", 0, 0, 0, 0, "PLAN")]          // 无到期日 + 零额度：必须被跳过
  },
  resource_package_quota: {
    quota_summary: { used_value: 127, limit_value: 2000, remaining_value: 1873, unit: "credits" },
    quota_detail: [
      entry("batch-0c84", 100, 0, 100, T1),
      entry("batch-0a73", 100, 27, 73, T2),
      entry("batch-0d00", 100, 100, 0, T3),
      entry("batch-0z00", 0, 0, 0, T1)                              // 零额度：必须被跳过
    ]
  },
  dedicated_resource_package_quota: { quota_summary: { used_value: 0, limit_value: 0, remaining_value: 0, unit: "credits" }, quota_detail: null },
  total_quota: {
    // 并集！adapter 若误取这里，每笔批次会出现两次
    quota_summary: { used_value: 127, limit_value: 2000, remaining_value: 1873, unit: "credits" },
    quota_detail: [
      entry("plan-0001", 0, 0, 0, 0, "PLAN"),
      entry("batch-0c84", 100, 0, 100, T1),
      entry("batch-0a73", 100, 27, 73, T2),
      entry("batch-0d00", 100, 100, 0, T3)
    ]
  },
  lastResetAt: 1772244899742,
  nextResetAt: 1773454547808
});

var capture = { agentId: "qoder", url: "https://qoder.com/api/v2/me/usages/big_model_credits",
                method: "GET", status: 200, score: 9, at: "2026-10-21T00:00:00Z",
                bodyPreview: BODY, truncated: false };

eq("真 adapter 已注册", D.has("qoder"), true);

// 升级时存储里可能还留着旧的粘贴样本；直读样本必须优先，否则刚读到的数字可能被旧快照盖住
var oldPaste = Object.assign({}, capture, { via: "paste", score: 11, at: "2026-10-20T00:00:00Z" });
var freshDirect = Object.assign({}, capture, { via: "direct", score: 8, at: "2026-10-21T01:00:00Z" });
eq("直读样本优先于旧的粘贴样本", D.pickCapture([oldPaste, freshDirect], "qoder").via, "direct");
// v0.3.17 改了口径：同一个接口的多份样本按时间取新的，分数只在跨接口时用。
// 旧的写法（分数优先）会被"余额花完 → 额度字段变少 → 分数反而更低"打穿，
// 于是永远选回那份胖的旧样本，刷新看起来毫无变化。
eq("同一接口的两份样本取新的那份",
  D.pickCapture([oldPaste,
    Object.assign({}, capture, { via: "paste", score: 9, at: "2026-10-21T02:00:00Z" })], "qoder").at,
  "2026-10-21T02:00:00Z");
eq("不同接口之间仍按分数决定",
  D.pickCapture([
    Object.assign({}, capture, { url: "https://qoder.com/api/v2/me/usages/other", score: 5, at: "2026-10-21T03:00:00Z" }),
    Object.assign({}, capture, { url: "https://qoder.com/api/v2/me/usages/big_model_credits", score: 11, at: "2026-10-20T03:00:00Z" })
  ], "qoder").score, 11);

/* v0.3 直读配方：接口与页面地址必须和前端 bundle 里的调用一致。
 * 少一个 CSRF/timezone 标志都会让页面内请求和站点自己的请求长得不一样。 */
var direct = D.get("qoder").direct;
eq("直读接口", direct && direct.url, "https://qoder.com/api/v2/me/usages/big_model_credits");
eq("直读页面是账户用量页", direct && direct.pageUrl, "https://qoder.com/account/usage");
eq("直读状态用 GET", direct && direct.method, "GET");
eq("直读带 CSRF token", direct && direct.csrf, true);
eq("直读带 X-Timezone", direct && direct.timezone, true);

var rows = D.get("qoder").extract(capture);
eq("只认三个分段：plan 无到期跳过、零额度跳过、total 并集不重复", rows.length, 3);
eq("label 带 source 与 id 末四位", rows.map(function (r) { return r.label; }),
  ["RESOURCE_PACKAGE_SOURCE_BONUS #0c84", "RESOURCE_PACKAGE_SOURCE_BONUS #0a73", "RESOURCE_PACKAGE_SOURCE_BONUS #0d00"]);
eq("granted/remaining 照抄 limit/remaining", rows.map(function (r) { return [r.granted, r.remaining]; }),
  [[100, 100], [100, 73], [100, 0]]);

var now = new Date(2026, 9, 21);
var res = D.runSync("qoder", [capture], now);
eq("runSync 走通", res.ok, true);
eq("清零时刻减一天成最后可用日", res.batches.map(function (b) { return b.expiresAt; }),
  ["2026-11-19", "2026-10-22", "2026-10-21"]);
eq("resetInstant 保留精确时刻", res.batches[0].resetInstant, new Date(T1).toISOString());
eq("今天到期的批次算 active 不算 expired", res.batches[2].status, "active");
eq("dedupKey 互不相同", (function () {
  var ks = res.batches.map(function (b) { return N.dedupKey(b); });
  return new Set(ks).size;
})(), 3);

var m1 = N.mergeBatches([], res.batches, { now: now });
eq("首批进合并：3 新增", m1.added, 3);
var m2 = N.mergeBatches(m1.batches, D.runSync("qoder", [capture], now).batches, { now: now });
eq("再同步不冒重复", m2.added, 0);
eq("再同步全部 unchanged", m2.unchanged, 3);

eq("截断样本报截断", D.runSync("qoder", [Object.assign({}, capture, { truncated: true })], now).reason, "truncated");
eq("坏 JSON 报 adapter-throw", D.runSync("qoder", [Object.assign({}, capture, { bodyPreview: "not json" })], now).reason, "adapter-threw");
eq("空 quota_detail 报 no-rows", D.runSync("qoder", [Object.assign({}, capture,
  { bodyPreview: JSON.stringify({ plan_quota: { quota_detail: [] }, resource_package_quota: { quota_detail: [] } }) })], now).reason, "no-rows");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
