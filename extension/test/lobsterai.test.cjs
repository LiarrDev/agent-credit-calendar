/* lobsterai 真 adapter： node test/lobsterai.test.cjs
 *
 * 骨架来自 2026-10-22 用户提供的真实响应
 * （GET https://lobsterai-server.youdao.com/api/user/profile-summary），
 * 金额、数量都换成假值——仓库里不留用户的真实余额。
 */
process.env.TZ = "Asia/Shanghai";
var N = require("../lib/normalize.js");
require("../lib/agents.js");
var D = require("../adapters/index.js");
require("../adapters/lobsterai.js");   // 注册真 adapter

var pass = 0, fail = 0;
function eq(l, g, w) {
  var a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) pass++; else { fail++; console.log("FAIL  " + l + "\n      got  " + a + "\n      want  " + b); }
}

function item(label, remaining, expiresAt, type) {
  return {
    type: type || "campaign",
    label: label,
    labelEn: label === "加油包" ? "Boost Pack" : "Daily Login Reward",
    creditsRemaining: remaining,
    expiresAt: expiresAt
  };
}

var BODY = JSON.stringify({
  code: 0,
  message: "success",
  data: {
    id: 1,
    nickname: "fake-user",
    totalCreditsRemaining: 1150.5,
    creditItems: [
      item("每日登录奖励", 100, "2026-10-24T10:30:05"),
      item("每日登录奖励", 50.5, "2026-10-28T09:19:47"),
      item("加油包", 1000, "2027-09-14T14:55:51", "boost"),
      item("每日登录奖励", 0, "2026-10-30T10:02:15"),
      item("每日登录奖励", 88, null),                    // 无到期日：跳过
      item("每日登录奖励", null, "2026-11-01T10:00:00")  // 没有剩余量：跳过
    ],
    availableResetCount: 0,
    creditsResetCampaign: { enabled: true, active: false, startAt: "2026-07-01T00:00:00" }
  }
});

var capture = {
  agentId: "lobsterai",
  url: "https://lobsterai-server.youdao.com/api/user/profile-summary",
  method: "GET", status: 200, score: 9, at: "2026-10-22T00:00:00Z",
  bodyPreview: BODY, truncated: false
};

eq("真 adapter 已注册", D.has("lobsterai"), true);
eq("这是钩子平台，没有 direct 配置", D.get("lobsterai").direct, undefined);
// creditItems 就是当下全部批次，平台把花完的整条摘掉 —— 同步时"没出现"才能关批次
eq("标了权威清单", D.get("lobsterai").authoritative, true);

var rows = D.get("lobsterai").extract(capture);
eq("只认 creditItems：无到期日/无剩余量跳过，0 保留", rows.length, 4);
/* 对账：明细之和必须等于服务端的 totalCreditsRemaining。
 * 这条断言是 v0.3.17 那个 bug 的照妖镜——当时本机合计比后台高 131.35，
 * 就是因为已经消失的批次还留在本地余额里。 */
eq("明细之和等于服务端合计（映射没漏项）",
  rows.reduce(function (s, r) { return s + r.remaining; }, 0),
  JSON.parse(BODY).data.totalCreditsRemaining);
eq("同名每日奖励用最后可用日区分", rows.map(function (r) { return r.label; }),
  ["每日登录奖励 10-23", "每日登录奖励 10-27", "加油包 09-13", "每日登录奖励 10-29"]);
eq("granted 暂用剩余量填，不是 0", rows.map(function (r) { return [r.granted, r.remaining]; }),
  [[100, 100], [50.5, 50.5], [1000, 1000], [0, 0]]);

var now = new Date(2026, 9, 22, 12, 0, 0);
var res = D.runSync("lobsterai", [capture], now);
eq("runSync 走通", res.ok, true);

/* v0.3.2 真机回归：portal 一次加载会截到十几个接口，plans / usage-conversations
 * 这些响应的启发式分数比 profile-summary 还高。选样本必须先看接口提示，
 * 否则 adapter 拿到的是没有 creditItems 的那一份，报 "没认出批次"。 */
var noisy = [
  { agentId: "lobsterai", url: "https://lobsterai-server.youdao.com/api/plans",
    score: 11, at: "2026-10-22T02:15:00Z", bodyPreview: '{"code":0,"data":[]}' },
  { agentId: "lobsterai", url: "https://lobsterai-server.youdao.com/api/user/usage-conversations?startDate=2026-10-16",
    score: 11, at: "2026-10-22T02:14:00Z", bodyPreview: '{"code":0,"data":{}}' },
  { agentId: "lobsterai", url: "https://lobsterai-server.youdao.com/api/credits-reset-campaign/status",
    score: 10, at: "2026-10-22T02:13:00Z", bodyPreview: '{"code":0,"data":{}}' },
  capture
];
eq("高分的无关接口不挤掉 profile-summary", D.pickCapture(noisy, "lobsterai").url, capture.url);
eq("混合样本里仍能认出 4 个批次", D.runSync("lobsterai", noisy, now).batches.length, 4);
eq("清零时刻减一天成最后可用日", res.batches.map(function (b) { return b.expiresAt; }),
  ["2026-10-23", "2026-10-27", "2027-09-13", "2026-10-29"]);
eq("resetInstant 保留精确时刻", res.batches[0].resetInstant,
  new Date(2026, 9, 24, 10, 30, 5).toISOString());
eq("全部是 active", res.batches.map(function (b) { return b.status; }),
  ["active", "active", "active", "active"]);
eq("dedupKey 互不相同", (function () {
  var ks = res.batches.map(function (b) { return N.dedupKey(b); });
  return new Set(ks).size;
})(), 4);

var m1 = N.mergeBatches([], res.batches, { now: now });
eq("首批进合并：4 新增", m1.added, 4);
var m2 = N.mergeBatches(m1.batches, D.runSync("lobsterai", [capture], now).batches, { now: now });
eq("再同步不冒重复", m2.added, 0);
eq("再同步全部 unchanged", m2.unchanged, 4);

/* 合计字段变了、明细没变 -> 不应该影响批次。adapter 读 total 的话这里会多出/改错钱 */
var totalOnly = JSON.parse(BODY);
totalOnly.data.totalCreditsRemaining = 999999;
var r2 = D.runSync("lobsterai", [Object.assign({}, capture, { bodyPreview: JSON.stringify(totalOnly) })], now);
eq("totalCreditsRemaining 不参与映射", r2.batches.length, 4);
eq("明细金额不受合计影响", r2.batches[3].remaining, 0);

/* 一笔用完之后接口仍返回它，余额要能更新到 0，而不是停在旧值 */
var used = JSON.parse(BODY);
used.data.creditItems[0].creditsRemaining = 0;
var m3 = N.mergeBatches(m2.batches, D.runSync("lobsterai",
  [Object.assign({}, capture, { bodyPreview: JSON.stringify(used) })], now).batches, { now: now });
eq("用完的批次仍匹配原批次", m3.batches.length, 4);
eq("剩余量更新为 0", m3.batches[0].remaining, 0);
eq("更新计数为 1", m3.updated, 1);
eq("同 label 的其他批次不被误伤", m3.batches[1].remaining, 50.5);

/* 接口层失败要说清楚，不能伪装成"没认出批次" */
var bad = JSON.parse(BODY);
bad.code = 401; bad.message = "未登录"; bad.data = null;
var rb = D.runSync("lobsterai", [Object.assign({}, capture, { bodyPreview: JSON.stringify(bad) })], now);
eq("code 非 0 报 adapter-threw", rb.reason, "adapter-threw");
eq("错误里带服务端 message", /\u672a\u767b\u5f55/.test(rb.message), true);
eq("没有 creditItems 报 no-rows", D.runSync("lobsterai", [Object.assign({}, capture,
  { bodyPreview: JSON.stringify({ code: 0, data: {} }) })], now).reason, "no-rows");
eq("截断样本报截断", D.runSync("lobsterai",
  [Object.assign({}, capture, { truncated: true })], now).reason, "truncated");

/* 这个平台的接口和页面不同源，但 adapter 只认响应，不关心 URL */
var otherHost = Object.assign({}, capture, { url: "https://lobsterai-server.youdao.com/other/path" });
eq("adapter 不看 URL 路径", D.get("lobsterai").extract(otherHost).length, 4);

/* v0.3.17：花完的批次被平台整条摘掉 —— 本机必须跟着把它从余额里剔掉。
 * 真机症状：日历「可用」2115.98，后台 1984.64，差的 131.35 正好是 5 笔消失批次的
 * 残留之和；而且每次刷新都报「数字无变化」，因为留下的那些一笔都没动。 */
var gone = JSON.parse(BODY);
gone.data.creditItems = gone.data.creditItems.filter(function (i) {
  return i.expiresAt !== "2026-10-28T09:19:47";      // 这笔花完了，平台不再返回
});
gone.data.totalCreditsRemaining = 1100;
var mg = N.mergeBatches(m2.batches, D.runSync("lobsterai",
  [Object.assign({}, capture, { bodyPreview: JSON.stringify(gone) })], now).batches,
  { now: now, authoritative: { lobsterai: true } });
eq("消失的批次被关掉", mg.closed, 1);
eq("没动的批次不算更新（这正是旧版报「数字无变化」的原因）", mg.updated, 0);
var goneOne = mg.batches.filter(function (b) { return b.closed; })[0];
eq("关掉的是那笔", goneOne.remaining, 50.5);
eq("不删历史", mg.batches.length, 4);
var liveSum = mg.batches.filter(function (b) { return !b.closed; })
  .reduce(function (s, b) { return s + b.remaining; }, 0);
eq("余额合计重新对上服务端", liveSum, 1100);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
