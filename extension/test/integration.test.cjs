/* store / agents / 端到端合并流程： node test/integration.test.cjs */
// 断言里写死了 "…T00:00:00Z" -> 本地日期 的换算，必须固定时区才稳定
process.env.TZ = "Asia/Shanghai";
var N = require("../lib/normalize.js");
var A = require("../lib/agents.js");   // 先加载：store.js 的 defaults() 读 globalThis.CreditAgents
var S = require("../lib/store.js");

var pass = 0, fail = 0;
function eq(l, g, w) {
  var a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) pass++; else { fail++; console.log("FAIL  " + l + "\n      got  " + a + "\n      want " + b); }
}

/* ---------- store ---------- */
var d0 = S.defaults();
eq("初始四个 agent", Object.keys(d0.agents).length, 4);
eq("初始只有 Qoder 直读，其余未授权", [
  d0.agents.qoder.fetchMode,
  d0.agents.trae.fetchMode, d0.agents.workbuddy.fetchMode, d0.agents.lobsterai.fetchMode
], ["direct", "unauthorized", "unauthorized", "unauthorized"]);
eq("Qoder 默认 origin 就是取数页面同源", d0.agents.qoder.origin, "https://qoder.com");
eq("单位统一为 credits", A.AGENTS.every(function (a) { return a.unit === "credits"; }), true);
eq("默认地址就是用户给过的四个，一个都不许多", A.AGENTS.map(function (a) { return a.consoleUrl; }),
  ["https://qoder.com/account/usage", "https://www.trae.cn/dashboard",
   "https://www.workbuddy.cn/profile/plans-usage", "https://lobsterai.youdao.com/portal#/profile/detail"]);
eq("默认阈值 14 天", d0.settings.threshold, 14);

var saved = { agents: { trae: { consoleUrl: "https://t.example/usage", fetchMode: "capture", origin: "https://t.example",
                                endpoint: "https://t.example/api/credit-usage", lastHookAt: "2026-10-21T02:00:00.000Z" } },
              batches: [{ batchId: "x" }], lastSyncAt: "2026-10-20T00:00:00.000Z" };
var m = S.migrate(saved);
eq("migrate 保留用户填的后台地址", m.agents.trae.consoleUrl, "https://t.example/usage");
eq("migrate 保留 fetchMode", m.agents.trae.fetchMode, "capture");
eq("migrate 保留 origin", m.agents.trae.origin, "https://t.example");
eq("migrate 保留 endpoint", m.agents.trae.endpoint, "https://t.example/api/credit-usage");
eq("migrate 保留注入心跳 lastHookAt", m.agents.trae.lastHookAt, "2026-10-21T02:00:00.000Z");
eq("migrate 补全缺失的 agent", Object.keys(m.agents).length, 4);
eq("migrate 保留批次", m.batches.length, 1);
eq("migrate 给用户没动过的平台填默认地址", m.agents.workbuddy.consoleUrl, "https://www.workbuddy.cn/profile/plans-usage");
eq("migrate 空串视同没填，默认地址回填", S.migrate({ agents: { workbuddy: { consoleUrl: "" } } }).agents.workbuddy.consoleUrl,
  "https://www.workbuddy.cn/profile/plans-usage");
eq("migrate 补 settings 缺字段", m.settings.staleDays, 7);
eq("migrate 容忍残缺文档", S.migrate({}).batches.length, 0);

/* v0.3 迁移：Qoder 旧文档里的钩子状态必须压回 direct + false，
 * 否则升级后同步还会自动注入那个会让 qoder.com 登录态失效的钩子。 */
var mq = S.migrate({ agents: { qoder: {
  consoleUrl: "https://q.example/usage", fetchMode: "capture",
  origin: "https://q.example", hookActive: true, lastSeenAt: "2026-10-21T03:00:00.000Z"
} } });
eq("Qoder 旧 capture 强制升级为 direct", mq.agents.qoder.fetchMode, "direct");
eq("Qoder 旧 hookActive 强制关闭", mq.agents.qoder.hookActive, false);
eq("Qoder 直读 origin 以代码配置为准", mq.agents.qoder.origin, "https://qoder.com");
eq("Qoder 直读页面以代码配置为准", mq.agents.qoder.consoleUrl, "https://qoder.com/account/usage");
eq("Qoder 迁移仍保留 lastSeenAt", mq.agents.qoder.lastSeenAt, "2026-10-21T03:00:00.000Z");
eq("Qoder 旧钩子心跳升级时清掉", S.migrate({ agents: { qoder: { fetchMode: "capture",
  lastHookAt: "2026-10-21T02:00:00.000Z" } } }).agents.qoder.lastHookAt, null);
eq("Qoder 旧钩子留下的错误升级时清掉", S.migrate({ agents: { qoder: { fetchMode: "capture",
  lastError: "注入失败" } } }).agents.qoder.lastError, null);
eq("Qoder 直读自身的失败信息要保留", S.migrate({ agents: { qoder: { fetchMode: "direct",
  lastError: "认证错误：需要登录" } } }).agents.qoder.lastError, "认证错误：需要登录");
eq("其他平台的上次错误不被每次加载抹掉", S.migrate({ agents: { trae: { fetchMode: "capture",
  lastError: "后台页没返回候选" } } }).agents.trae.lastError, "后台页没返回候选");
eq("Qoder 旧钩子的探针升级时清掉", S.migrate({ agents: { qoder: { fetchMode: "capture",
  probe: { outcome: "both-failed" } } } }).agents.qoder.probe, null);
eq("Qoder 直读自己的探针要保留", S.migrate({ agents: { qoder: { fetchMode: "direct",
  probe: { mode: "direct", outcome: "auth" } } } }).agents.qoder.probe.outcome, "auth");

/* v0.2.4 活体同步：钩子状态和"页面最后一次回话时刻"必须活过 migrate，
 * 否则重装扩展后 hookActive 丢失，同步会退回只读样本，用户还以为在读实时数据。 */
var m4 = S.migrate({ agents: { trae: { hookActive: true, lastSeenAt: "2026-10-21T03:00:00.000Z" } } });
eq("migrate 保留 hookActive", m4.agents.trae.hookActive, true);
eq("migrate 保留 lastSeenAt", m4.agents.trae.lastSeenAt, "2026-10-21T03:00:00.000Z");
// 刷新流程靠 lastTargetAt 区分目标接口与 plans/usage 干扰；漏迁会让 waitForCapture
// 永远看不到目标响应，刷新只能等满超时。
eq("migrate 保留目标接口响应时刻 lastTargetAt",
  S.migrate({ agents: { trae: { lastTargetAt: "2026-10-22T07:00:00.000Z" } } }).agents.trae.lastTargetAt,
  "2026-10-22T07:00:00.000Z");
eq("老文档 lastTargetAt 默认空", S.migrate({}).agents.trae.lastTargetAt, null);
// 老文档没有这两个字段时必须是 false/null：默认自动装钩子去刷页面是不可接受的
eq("老文档 hookActive 默认关", S.migrate({ agents: { trae: { fetchMode: "capture" } } }).agents.trae.hookActive, false);
eq("老文档 lastSeenAt 默认空", S.migrate({}).agents.trae.lastSeenAt, null);
eq("hookActive 只认真正的 true，脏字符串不算", S.migrate({ agents: { trae: { hookActive: "yes" } } }).agents.trae.hookActive, false);
// 刷新探针要活过 migrate：失败诊断是排查"截不到"的唯一证据，重载扩展后不能丢
var probe = { responses: 3, candidates: 1, stored: 0, dups: 1, outcome: "both-failed", attempts: [] };
eq("migrate 保留刷新探针", S.migrate({ agents: { trae: { probe: probe } } }).agents.trae.probe.outcome, "both-failed");
eq("没有探针时默认为 null", S.migrate({}).agents.trae.probe, null);

/* v0.3.7 授权会话：等待状态和自动收尾结果必须活过 migrate，
 * 否则 service worker 被回收后，用户登录回来就再也没人把响应写进日历。 */
var pendingAuth = { startedAt: "2026-10-22T06:00:00.000Z", tabId: 42 };
var ma = S.migrate({ agents: { trae: {
  authPending: pendingAuth,
  authResult: { at: "2026-10-22T06:01:00.000Z", ok: true, total: 4 }
} } });
eq("migrate 保留授权等待", ma.agents.trae.authPending.startedAt, "2026-10-22T06:00:00.000Z");
eq("migrate 保留授权结果", ma.agents.trae.authResult.total, 4);
eq("没有授权会话时默认为 null", S.migrate({}).agents.trae.authPending, null);
eq("直读平台不保留授权会话", S.migrate({ agents: { qoder: { authPending: pendingAuth } } }).agents.qoder.authPending, null);

/* ---------- 捕获打分 ---------- */
var creditBody = JSON.stringify({
  data: { balances: [
    { name: "plan_credits", remaining: 1840, total: 6000, expires_at: "2026-10-31T00:00:00Z" },
    { name: "bonus_credits", remaining: 2000, total: 2000, expires_at: "2026-11-15T00:00:00Z" }
  ] }
});
var sc = A.scoreCapture("https://api.example.com/v1/user/credit-usage", creditBody);
eq("积分接口得高分", sc.score >= 8, true);
eq("给出理由", sc.reasons.length >= 2, true);

eq("静态资源得 0 分", A.scoreCapture("https://x.dev/app.js", creditBody).score, 0);
eq("无关响应得 0 分", A.scoreCapture("https://x.dev/api/config", '{"theme":"dark"}').score, 0);
eq("空响应得 0 分", A.scoreCapture("https://x.dev/api/credits", "").score, 0);
eq("超大响应跳过", A.scoreCapture("https://x.dev/api/credits", new Array(500001).join("x")).score, 0);

/* ---------- 端到端：捕获样本 -> 批次 -> 两次同步 ---------- */
// 这一步模拟 adapter 该干的活：从响应 JSON 里挑出批次
function fakeAdapter(agentId, body) {
  var j = JSON.parse(body);
  return (j.data.balances || []).map(function (r) {
    return N.normalizeBatch({
      agent: agentId, label: r.name, granted: r.total, remaining: r.remaining,
      expiry: r.expires_at, semantics: "resetsAt", unit: "credits"
    }, { now: new Date(2026, 9, 21) });
  });
}
var batches = N.mergeBatches([], fakeAdapter("qoder", creditBody), { now: new Date(2026, 9, 21) });
eq("首次同步产出 2 个批次", batches.batches.length, 2);
eq("ISO 清零时刻换算成最后可用日", batches.batches[0].expiresAt, "2026-10-30");
eq("第二笔到期日", batches.batches[1].expiresAt, "2026-11-14");

// 同样的响应再同步一次：不该产生重复
var again = N.mergeBatches(batches.batches, fakeAdapter("qoder", creditBody), { now: new Date(2026, 9, 21) });
eq("重复同步不产生重复批次", again.batches.length, 2);
eq("重复同步不算新增", again.added, 0);
eq("absentCount 归零", again.batches[0].absentCount, 0);

// 用掉 40 积分后再同步
var used = JSON.parse(creditBody); used.data.balances[0].remaining = 1800;
var third = N.mergeBatches(again.batches, fakeAdapter("qoder", JSON.stringify(used)), { now: new Date(2026, 9, 22) });
eq("剩余量随使用下降", third.batches[0].remaining, 1800);
eq("仍然只有 2 个批次", third.batches.length, 2);

// 平台改版：这笔不再返回
var fourth = N.mergeBatches(third.batches, [third.batches[0]], { now: new Date(2026, 9, 23) });
eq("没返回的批次不删除", fourth.batches.length, 2);
eq("改为累加 absentCount", fourth.batches[1].absentCount, 1);

// 用户手填修正 -> 冻结 -> 抓取冲突交裁决
var frozen = N.applyManualEdit(fourth.batches[0], { expiresAt: "2026-10-31", remaining: 1800 });
var fifth = N.mergeBatches([frozen, fourth.batches[1]], fakeAdapter("qoder", creditBody), { now: new Date(2026, 9, 24) });
eq("冻结批次的过期日不被抓取覆盖", fifth.batches[0].expiresAt, "2026-10-31");
eq("手改过期日后，下次同步不会冒出重复批次", fifth.batches.length, 2);
eq("抓到不同值时报冲突而非静默覆盖", fifth.batches[0].conflict, true);
eq("冲突里保留抓取值", fifth.batches[0].scraped.remaining, 1840);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
