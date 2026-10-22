/* workbuddy 真 adapter： node test/workbuddy.test.cjs
 *
 * 骨架来自 2026-10-22 用户提供的真实响应
 * （GET https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages），
 * 金额、用户 id、资源 id 都换成假值——仓库里不留真实余额与账号标识。
 * 真实响应有 40 余笔；这里保留会踩坑的形状：同名同日、精确小数、零剩余、
 * DeductionEndTime 远未来、Capacity* 全是 0、以及无 PackageName 的回退。
 */
process.env.TZ = "Asia/Shanghai";
var N = require("../lib/normalize.js");
require("../lib/agents.js");
var D = require("../adapters/index.js");
require("../adapters/workbuddy.js");   // 注册真 adapter

var pass = 0, fail = 0;
function eq(l, g, w) {
  var a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) pass++; else { fail++; console.log("FAIL  " + l + "\n      got  " + a + "\n      want  " + b); }
}

function pack(opts) {
  var a = {
    PackageName: opts.name == null ? "CodeBuddy个人版国内运营裂变包" : opts.name,
    SubProductName: opts.sub || "腾讯云代码助手 (IDE) - 赠送包",
    ResourceId: opts.id || ("fake-res-" + opts.end),
    AccountId: opts.accountId || ("fake-account-" + opts.id),
    DealName: opts.deal || ("fake-deal-" + opts.id),
    // 样本里这三个总数一直是 0，不能当余额用
    CapacitySize: 0,
    CapacityRemain: 0,
    CapacityUsed: 0,
    CycleCapacitySize: opts.size,
    CycleCapacityRemain: opts.remain,
    CycleCapacityUsed: opts.used == null ? Math.max(0, opts.size - opts.remain) : opts.used,
    CycleStartTime: opts.start || "2026-10-01 00:00:00",
    CycleEndTime: opts.end,
    DeductionEndTime: opts.dedEnd == null ? 1794130400000 : opts.dedEnd,
    ExpiredTime: "",
    Status: 0,
    CapacityType: opts.capacityType || 1,
    AccountAttributes: [
      { Key: "payerUin", Value: "FAKE_UIN_DO_NOT_STORE", Type: 5 },
      { Key: "grantSource", Value: "welcome_gift", Type: 3 }
    ]
  };
  if (opts.precise) {
    a.CycleCapacitySizePrecise = opts.precise[0];
    a.CycleCapacityRemainPrecise = opts.precise[1];
    a.CycleCapacityUsedPrecise = opts.precise[2];
  }
  return a;
}

var accounts = [
  // 体验版：额度带小数，DeductionEndTime 在 2035 年，不能拿来当到期日
  pack({ name: "CodeBuddy个人体验版", sub: "腾讯云代码助手 (IDE)", id: "fake-trial",
    size: 500, remain: 123.45, used: 376.55, end: "2026-10-30 23:59:59",
    dedEnd: 2051861599000, capacityType: 4, precise: ["500", "123.45000016", "376.54999984"] }),
  // 拉新包：CapacityRemain 是 0，CycleCapacityRemain 才是 1500
  pack({ name: "CodeBuddy个人版拉新权益包", id: "fake-welcome",
    size: 1500, remain: 1500, end: "2026-12-08 17:33:20" }),
  // 两笔同名、同一秒清零，只有 ResourceId 不同：label 必须仍能区分
  pack({ name: "CodeBuddy个人版国内运营裂变包", id: "fake-same-a",
    size: 100, remain: 100, end: "2026-12-10 10:09:02", start: "2026-11-10 10:09:03" }),
  pack({ name: "CodeBuddy个人版国内运营裂变包", id: "fake-same-b",
    size: 8, remain: 8, end: "2026-12-10 10:09:02", start: "2026-11-10 10:09:03" }),
  // 用满的包保留为 0
  pack({ name: "CodeBuddy个人版国内运营裂变包", id: "fake-zero",
    size: 7, remain: 0, end: "2026-12-12 09:27:46" }),
  // 999 的长周期包
  pack({ name: "CodeBuddy个人版国内运营裂变包", id: "fake-long",
    size: 999, remain: 999, end: "2027-02-08 17:50:29" }),
  // 只有数值字段、没有 Precise：也要能读，且用掉一部分
  pack({ name: "CodeBuddy个人版国内运营裂变包", id: "fake-numeric",
    size: 9, remain: 4, used: 5, end: "2026-12-15 10:05:40" }),
  // PackageName 为空：回退 SubProductName
  pack({ name: "", id: "fake-fallback",
    size: 500, remain: 500, end: "2026-12-16 12:56:26" }),
  // 零发放量、缺到期日：跳过
  pack({ name: "零额度包", id: "fake-empty", size: 0, remain: 0, end: "2026-12-20 10:00:00" }),
  pack({ name: "没有到期日", id: "fake-no-expiry", size: 50, remain: 50, end: "" })
];

var BODY = JSON.stringify({
  code: 0,
  msg: "OK",
  requestId: "fake-request-id",
  data: { TotalCount: accounts.length, Accounts: accounts }
});

var capture = {
  agentId: "workbuddy",
  url: "https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages",
  method: "GET", status: 200, score: 8, at: "2026-10-22T00:00:00Z",
  bodyPreview: BODY, truncated: false
};

eq("真 adapter 已注册", D.has("workbuddy"), true);
eq("这是钩子平台，没有 direct 配置", D.get("workbuddy").direct, undefined);

var rows = D.get("workbuddy").extract(capture);
eq("零额度/缺到期日跳过，其余 8 笔全保留", rows.length, 8);
eq("余额取 CycleCapacityRemain，不用全是 0 的 CapacityRemain",
  rows.map(function (r) { return r.remaining; }),
  [123.45000016, 1500, 100, 8, 0, 999, 4, 500]);
eq("发放量取 CycleCapacitySize", rows.map(function (r) { return r.granted; }),
  [500, 1500, 100, 8, 7, 999, 9, 500]);
eq("体验版保留接口给的精确小数", rows[0].remaining, 123.45000016);
eq("同名同日包靠稳定短码区分", (function () {
  var same = rows.filter(function (r) { return /12-09/.test(r.label); });
  return [same.length, new Set(same.map(function (r) { return r.label; })).size];
})(), [2, 2]);
eq("8 个 label 两两不同", new Set(rows.map(function (r) { return r.label; })).size, 8);
eq("label 末尾是 8 位稳定短码", rows.every(function (r) { return / · [0-9a-f]{8}$/.test(r.label); }), true);
eq("label 不泄露 ResourceId 原文", rows.some(function (r) { return /fake-/.test(r.label); }), false);
eq("label 不泄露 payerUin", rows.some(function (r) { return /FAKE_UIN/.test(r.label); }), false);
eq("PackageName 为空时回退 SubProductName", /^腾讯云代码助手 \(IDE\) - 赠送包 12-15 · /.test(rows[7].label), true);
eq("两次提取的短码稳定", D.get("workbuddy").extract(capture).map(function (r) { return r.label; }),
  rows.map(function (r) { return r.label; }));

// 列表顺序变化不能改变任何 label / dedupKey
var reversed = Object.assign({}, capture, {
  bodyPreview: JSON.stringify({ code: 0, data: { TotalCount: accounts.length, Accounts: accounts.slice().reverse() } })
});
eq("接口顺序变化不影响标签集合",
  D.get("workbuddy").extract(reversed).map(function (r) { return r.label; }).sort(),
  rows.map(function (r) { return r.label; }).sort());

var now = new Date(2026, 9, 22, 12, 0, 0);
var res = D.runSync("workbuddy", [capture], now);
eq("runSync 走通", res.ok, true);
eq("产出 8 个批次", res.batches.length, 8);
eq("累计剩余 3234.45", Math.abs(res.batches.reduce(function (s, b) { return s + b.remaining; }, 0) - 3234.45000016) < 1e-6, true);
eq("CycleEndTime 按清零时刻减一天", res.batches.map(function (b) { return b.expiresAt; }),
  ["2026-10-29", "2026-12-07", "2026-12-09", "2026-12-09", "2026-12-11",
    "2027-02-07", "2026-12-14", "2026-12-15"]);
eq("体验版到期日不受 2035 年的 DeductionEndTime 影响", res.batches[0].expiresAt, "2026-10-29");
eq("体验版原始清零时刻保留秒", res.batches[0].resetInstant,
  new Date(2026, 9, 30, 23, 59, 59).toISOString());
eq("全部是 active", res.batches.map(function (b) { return b.status; }),
  ["active", "active", "active", "active", "active", "active", "active", "active"]);
eq("dedupKey 两两不同", new Set(res.batches.map(function (b) { return N.dedupKey(b); })).size, 8);
eq("batchId 两两不同", new Set(res.batches.map(function (b) { return b.batchId; })).size, 8);

var m1 = N.mergeBatches([], res.batches, { now: now });
eq("首批进合并：8 新增", m1.added, 8);
var m2 = N.mergeBatches(m1.batches, D.runSync("workbuddy", [capture], now).batches, { now: now });
eq("再同步不冒重复", m2.added, 0);
eq("再同步全部 unchanged", m2.unchanged, 8);

/* 用掉一部分之后，下一次同步要把剩余量降下来，且不能串到同名同日的那一笔 */
var usedMore = JSON.parse(BODY);
usedMore.data.Accounts[2].CycleCapacityRemainPrecise = "40";
usedMore.data.Accounts[2].CycleCapacityUsedPrecise = "60";
var m3 = N.mergeBatches(m2.batches, D.runSync("workbuddy",
  [Object.assign({}, capture, { bodyPreview: JSON.stringify(usedMore) })], now).batches, { now: now });
var sameDay = m3.batches.filter(function (b) { return /12-09/.test(b.label); })
  .sort(function (a, b) { return b.remaining - a.remaining; });
eq("消耗后只剩 40", sameDay[0].remaining, 40);
eq("同名同日的另一笔仍是 8", sameDay[1].remaining, 8);
eq("只更新这一笔", m3.updated, 1);

/* 接口层失败要说清楚，不能伪装成"没认出批次" */
eq("401 明确说登录失效", /登录态失效/.test(D.runSync("workbuddy",
  [Object.assign({}, capture, { status: 401, bodyPreview: '{"message":"unauthorized"}' })], now).message), true);
eq("403 也按登录失效", /登录态失效/.test(D.runSync("workbuddy",
  [Object.assign({}, capture, { status: 403 })], now).message), true);
eq("500 报接口失败", /HTTP 500/.test(D.runSync("workbuddy",
  [Object.assign({}, capture, { status: 500 })], now).message), true);
eq("code 非 0 报接口失败", /code=40001/.test(D.runSync("workbuddy",
  [Object.assign({}, capture, { bodyPreview: '{"code":40001,"msg":"token expired"}' })], now).message), true);
eq("没有 Accounts 报 no-rows", D.runSync("workbuddy",
  [Object.assign({}, capture, { bodyPreview: '{"code":0,"data":{}}' })], now).reason, "no-rows");
eq("截断样本报截断", D.runSync("workbuddy",
  [Object.assign({}, capture, { truncated: true })], now).reason, "truncated");

/* 真实响应约 130KB。旧默认上限 60KB 会截在 Accounts 数组中间，
   每次刷新都报 truncated（2026-10-22 真机故障）。这里把 130KB 样本走完整链路，
   并确认超过 200KB 时仍然明确拒绝，而不是拿半份 JSON 去猜。 */
var bigBody = JSON.parse(BODY);
bigBody._pad = "x".repeat(130000);
var bigCap = N.sanitizeCapture({
  url: capture.url, method: "GET", status: 200, requestHeaders: {},
  body: JSON.stringify(bigBody)
});
eq("约 130KB 的真实响应不被默认上限截断", bigCap.truncated, false);
eq("约 130KB 的样本仍能认出 8 个批次", D.runSync("workbuddy",
  [Object.assign({}, bigCap, { agentId: "workbuddy", score: 9, via: "fetch" })], now).batches.length, 8);

var hugeBody = JSON.parse(BODY);
hugeBody._pad = "x".repeat(210000);
var hugeCap = N.sanitizeCapture({
  url: capture.url, method: "GET", status: 200, requestHeaders: {},
  body: JSON.stringify(hugeBody)
});
eq("超过 200KB 仍标记截断", hugeCap.truncated, true);
eq("超限样本不参与同步", D.runSync("workbuddy",
  [Object.assign({}, hugeCap, { agentId: "workbuddy", score: 9, via: "fetch" })], now).reason, "truncated");

/* 升级前存下的旧样本是 60KB 截断版，分数可能更高。刷新后完整样本必须能赢过它，
   否则用户升级后仍会一直看到「样本被截断」。 */
var staleTrunc = Object.assign({}, capture, {
  score: 12, at: "2026-10-22T03:00:00Z", truncated: true
});
eq("完整样本优先于分数更高的截断样本",
  D.pickCapture([staleTrunc, capture], "workbuddy").truncated, false);
eq("完整样本能直接跑出批次", D.runSync("workbuddy",
  [staleTrunc, capture], now).batches.length, 8);

/* 样本挑选：页面还有套餐/账单等接口，高分干扰项不能挤掉目标 */
var noisy = [
  { agentId: "workbuddy", url: "https://www.workbuddy.cn/billing/meter/plans",
    score: 12, at: "2026-10-22T02:15:00Z", bodyPreview: '{"plans":[]}' },
  { agentId: "workbuddy", url: "https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages?lang=zh",
    score: 11, at: "2026-10-22T02:14:00Z", bodyPreview: BODY },
  { agentId: "workbuddy", url: "https://www.workbuddy.cn/billing/meter/usage",
    score: 11, at: "2026-10-22T02:13:00Z", bodyPreview: '{"usage":[]}' }
];
eq("高分干扰接口不挤掉 free-packages", D.pickCapture(noisy, "workbuddy").url,
  "https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages?lang=zh");
eq("混合样本里仍能认出 8 个批次", D.runSync("workbuddy", noisy, now).batches.length, 8);
eq("query 参数不影响提示匹配",
  D.get("workbuddy").endpointHint.test(capture.url + "?t=1"), true);

/* ---------- 代发兜底配方（v0.3.14） ----------
 * 参数逐字来自站点自己的前端 bundle（config-PxOBnci5.js 的 ys=… 与 getCnPlan 调用点），
 * 一旦有人在站点改版后凭印象改这里，至少要能看出"改了什么"。
 */
var rf = D.get("workbuddy").readFallback;
eq("有代发兜底配方", !!rf, true);
eq("兜底打的就是目标接口", rf.url,
  "https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages");
eq("兜底接口能被 endpointHint 命中", D.get("workbuddy").endpointHint.test(rf.url), true);
eq("兜底用 POST（站点自己的写法）", rf.method, "POST");
eq("兜底页面就是已预置的后台地址", rf.pageUrl, "https://www.workbuddy.cn/profile/plans-usage");
eq("兜底带上站点 axios 拦截器写的平台头", rf.headers["X-Client-Platform"], "web");
eq("兜底带 Content-Type", rf.headers["Content-Type"], "application/json");

var body = rf.buildBody(new Date(2026, 9, 22, 9, 0, 0));
eq("请求体：分页参数与站点一致", [body.PageNumber, body.PageSize], [1, 200]);
eq("请求体：只取有效状态（valid=0）", body.Status, [0]);
eq("请求体：时间切片是当天 00:00:00–23:59:59",
  [body.SlicePeriodStartTime, body.SlicePeriodEndTime],
  ["2026-10-22 00:00:00", "2026-10-22 23:59:59"]);
eq("请求体：免费包 + 四类赠送包编码", body.PackageCodes, [
  "TCACA_code_008_cfWoLwvjU4", "TCACA_code_007_nzdH5h4Nl0",
  "TCACA_code_028_NtpWi0jzXs", "TCACA_code_029_6wCGEWquYy",
  "TCACA_code_030_BjSt89qTvr"
]);
eq("请求体不含任何账号字段（不读 payerUin/Uin）",
  /Uin|payer|AccountId/i.test(JSON.stringify(body)), false);
eq("每次调用都给一份新数组（不会被调用方改脏）",
  rf.buildBody(new Date(2026, 9, 22)).PackageCodes !== rf.buildBody(new Date(2026, 9, 22)).PackageCodes, true);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
