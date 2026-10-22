/* trae 真 adapter： node test/trae.test.cjs
 *
 * 骨架来自 2026-10-22 用户提供的真实响应
 * （GET https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list），
 * 金额、用户 id、entitlement id 都换成假值——仓库里不留真实余额与账号标识。
 */
process.env.TZ = "Asia/Shanghai";
var N = require("../lib/normalize.js");
require("../lib/agents.js");
var D = require("../adapters/index.js");
require("../adapters/trae.js");   // 注册真 adapter

var pass = 0, fail = 0;
function eq(l, g, w) {
  var a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) pass++; else { fail++; console.log("FAIL  " + l + "\n      got  " + a + "\n      want " + b); }
}
function sec(y, mo, d, h, mi, s) {
  return Math.floor(new Date(y, mo - 1, d, h || 0, mi || 0, s || 0).getTime() / 1000);
}

function pack(desc, limit, used, expire, opts) {
  opts = opts || {};
  var quota = limit == null ? { enable_solo_agent: true } : { credits_limit: limit };
  var pkg = {
    package_name: desc,
    package_source_type: opts.sourceType || 0,
    quota: limit == null ? {} : { credits_limit: limit }
  };
  return {
    display_desc: desc,
    group_name: opts.group || "",
    expire_time: expire == null ? 0 : expire,
    is_hide: !!opts.hide,
    status: 1,
    entitlement_base_info: {
      entitlement_id: opts.id || ("fake_" + desc),
      end_time: expire == null ? 0 : expire,
      quota: quota,
      product_extra: { package_extra: pkg }
    },
    usage: used == null ? {} : { credits_amount: used }
  };
}

var MONTHLY_EXP = sec(2026, 11, 1, 23, 59, 59);
var C1_EXP = sec(2026, 10, 23, 10, 0, 0);
var C2_EXP = sec(2026, 10, 24, 9, 0, 0);
var C3_EXP = sec(2026, 10, 25, 0, 0, 0);
var C4_EXP = sec(2026, 10, 26, 12, 0, 0);

var BODY = JSON.stringify({
  is_credits_billing: true,
  is_dollar_usage_billing: false,
  is_pay_freshman: true,
  trial_status: { is_eligible_for_trial: false, is_in_trial: false },
  usage_summary: { consumed_amount: 250.5, consumption_ratio: 0.36, total_amount: 700 },
  user_entitlement_pack_list: [
    // 免费包只有能力开关，没有 credits_limit：不是积分批次
    pack("免费", null, null, MONTHLY_EXP, { id: "free_fake", group: "" }),
    pack("每月登录赠送", 300, 50.5, MONTHLY_EXP, { id: "monthly_fake", group: "每月登录积分" }),
    pack("签到奖励", 120, 120, C1_EXP, { id: "checkin_1" }),   // 用满
    pack("签到奖励", 120, null, C2_EXP, { id: "checkin_2" }),  // 未用
    pack("签到奖励", 80, 80, C3_EXP, { id: "checkin_3" }),     // 用满
    pack("签到奖励", 80, null, C4_EXP, { id: "checkin_4" }),   // 未用
    // 无到期日：跳过
    pack("活动赠送", 50, 0, null, { id: "no_expiry" })
  ]
});

var capture = {
  agentId: "trae",
  url: "https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list",
  method: "GET", status: 200, score: 9, at: "2026-10-22T00:00:00Z",
  bodyPreview: BODY, truncated: false
};

eq("真 adapter 已注册", D.has("trae"), true);
eq("这是钩子平台，没有 direct 配置", D.get("trae").direct, undefined);

var rows = D.get("trae").extract(capture);
eq("免费包/零额度/无到期日跳过，其余逐笔成批", rows.length, 5);
eq("同名签到包用最后可用日区分", rows.map(function (r) { return r.label; }),
  ["每月登录赠送 10-31", "签到奖励 10-22", "签到奖励 10-23", "签到奖励 10-24", "签到奖励 10-25"]);
eq("granted=credits_limit，remaining=limit-used（用满保留 0）",
  rows.map(function (r) { return [r.granted, r.remaining]; }),
  [[300, 249.5], [120, 0], [120, 120], [80, 0], [80, 80]]);
eq("累计剩余与明细一致", rows.reduce(function (s, r) { return s + r.remaining; }, 0), 449.5);

var now = new Date(2026, 9, 22, 12, 0, 0);
var res = D.runSync("trae", [capture], now);
eq("runSync 走通", res.ok, true);
eq("秒级时间戳按清零时刻减一天", res.batches.map(function (b) { return b.expiresAt; }),
  ["2026-10-31", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
eq("resetInstant 保留秒级精确时刻", res.batches[1].resetInstant,
  new Date(2026, 9, 23, 10, 0, 0).toISOString());
eq("全部是 active", res.batches.map(function (b) { return b.status; }),
  ["active", "active", "active", "active", "active"]);
eq("dedupKey 互不相同", (function () {
  var ks = res.batches.map(function (b) { return N.dedupKey(b); });
  return new Set(ks).size;
})(), 5);

var m1 = N.mergeBatches([], res.batches, { now: now });
eq("首批进合并：5 新增", m1.added, 5);
var m2 = N.mergeBatches(m1.batches, D.runSync("trae", [capture], now).batches, { now: now });
eq("再同步不冒重复", m2.added, 0);
eq("再同步全部 unchanged", m2.unchanged, 5);

/* usage_summary 是合计：total_amount 恰好等于各包授予量之和，读了就会翻倍 */
var summaryOnly = JSON.parse(BODY);
summaryOnly.usage_summary.total_amount = 999999;
summaryOnly.usage_summary.consumed_amount = 0;
var r2 = D.runSync("trae", [Object.assign({}, capture, { bodyPreview: JSON.stringify(summaryOnly) })], now);
eq("usage_summary 不参与映射", r2.batches.length, 5);
eq("明细剩余量不受合计影响", r2.batches[0].remaining, 249.5);

/* 用掉一部分之后，下一次同步要把剩余量降下来 */
var usedMore = JSON.parse(BODY);
usedMore.user_entitlement_pack_list[3].usage = { credits_amount: 30 };
var m3 = N.mergeBatches(m2.batches, D.runSync("trae",
  [Object.assign({}, capture, { bodyPreview: JSON.stringify(usedMore) })], now).batches, { now: now });
eq("剩余量随消耗更新", m3.batches[2].remaining, 90);
eq("只更新这一笔", m3.updated, 1);
eq("同 label 的其他签到包不被误伤", m3.batches[1].remaining, 0);

/* 合计之外，秒/毫秒两种时间戳都不能落到 1970 */
var msBody = JSON.parse(BODY);
msBody.user_entitlement_pack_list[1].expire_time = C1_EXP * 1000;
msBody.user_entitlement_pack_list[1].entitlement_base_info.end_time = C1_EXP * 1000;
var msRows = D.get("trae").extract(Object.assign({}, capture, { bodyPreview: JSON.stringify(msBody) }));
eq("毫秒时间戳也能识别", msRows[1].label, "签到奖励 10-22");

/* 接口层失败要说清楚，不能伪装成"没认出批次" */
var unauth = Object.assign({}, capture, { status: 401, bodyPreview: '{"message":"unauthorized"}' });
var ru = D.runSync("trae", [unauth], now);
eq("401 报 adapter-threw", ru.reason, "adapter-threw");
eq("401 明确说登录失效", /登录态失效/.test(ru.message), true);
eq("500 报接口失败", /HTTP 500/.test(D.runSync("trae",
  [Object.assign({}, capture, { status: 500 })], now).message), true);
eq("没有 pack_list 报 no-rows", D.runSync("trae", [Object.assign({}, capture,
  { bodyPreview: JSON.stringify({ is_credits_billing: true }) })], now).reason, "no-rows");
eq("截断样本报截断", D.runSync("trae",
  [Object.assign({}, capture, { truncated: true })], now).reason, "truncated");

/* 样本挑选：dashboard 会同时请求套餐/账单等接口，高分干扰项不能挤掉目标 */
var noisy = [
  { agentId: "trae", url: "https://api.trae.cn/trae/api/v2/pay/plans",
    score: 11, at: "2026-10-22T02:15:00Z", bodyPreview: '{"plans":[]}' },
  { agentId: "trae", url: "https://api.trae.cn/trae/api/v2/pay/user_entitlement_list",
    score: 11, at: "2026-10-22T02:14:00Z", bodyPreview: '{"list":[]}' },
  capture
];
eq("高分干扰接口不挤掉 entitlement_list", D.pickCapture(noisy, "trae").url, capture.url);
eq("混合样本里仍能认出 5 个批次", D.runSync("trae", noisy, now).batches.length, 5);
eq("query 参数不影响提示匹配", D.get("trae").endpointHint.test(capture.url + "?t=1"), true);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
