/* adapters 层： node test/adapters.test.cjs */
process.env.TZ = "Asia/Shanghai";
var N = require("../lib/normalize.js");   // 顺带把 globalThis.CreditNormalize 挂上
var A = require("../lib/agents.js");
require("../lib/store.js");
var D = require("../adapters/index.js");

var pass = 0, fail = 0;
function eq(l, g, w) {
  var a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) pass++; else { fail++; console.log("FAIL  " + l + "\n      got  " + a + "\n      want " + b); }
}

/* 没注册之前：SYNC 该老实说没有 adapter，而不是猜 */
eq("未注册 -> has=false", D.has("qoder"), false);
eq("未注册 -> runSync 回 no-adapter", D.runSync("qoder", [], new Date(2026, 9, 21)).reason, "no-adapter");
eq("四个平台都缺", D.listMissing(["qoder", "trae", "workbuddy", "lobster"]).length, 4);

/* 注册一个契约形状正确的 adapter */
var adapter = D.register("qoder", {
  endpointHint: /credit/i,
  extract: function (capture) {
    var j = JSON.parse(capture.bodyPreview);
    return (j.data.balances || []).map(function (r) {
      return { label: r.name, granted: r.total, remaining: r.remaining, expiry: r.expires_at, semantics: "resetsAt" };
    });
  }
});
eq("注册后 has=true", D.has("qoder"), true);
eq("agentId 自动补齐", adapter.agentId, "qoder");
eq("注册过的不再算缺", D.listMissing(["qoder", "trae"]).length, 1);

function bad(msg) {
  try { D.register("x", msg); return false; } catch (e) { return true; }
}
eq("没有 extract 的注册被拒", bad({ endpointHint: /x/ }), true);

/* 样本挑选：分数优先，同分取最新 */
var caps = [
  { agentId: "qoder", score: 3, at: "2026-10-20T00:00:00Z", url: "low", bodyPreview: '{"data":{"balances":[]}}' },
  { agentId: "qoder", score: 9, at: "2026-10-01T00:00:00Z", url: "best",
    bodyPreview: JSON.stringify({ data: { balances: [
      { name: "plan", total: 6000, remaining: 1840, expires_at: "2026-11-01T00:00:00Z" },
      { name: "bonus", total: 2000, remaining: 500, expires_at: "2026-10-31T00:00:00Z" }
    ] } }) },
  { agentId: "qoder", score: 9, at: "2026-10-19T00:00:00Z", url: "same-score-later", bodyPreview: '{"data":{"balances":[]}}' },
  { agentId: "trae", score: 99, at: "2026-10-21T00:00:00Z", url: "other-agent", bodyPreview: "{}" }
];
eq("高分优先且跨平台隔离", D.pickCapture(caps, "qoder").url, "same-score-later");
eq("同分取最新", D.pickCapture(caps, "qoder").at > "2026-10-01", true);
eq("别的平台的样本不会被选中", D.pickCapture(caps, "trae").url, "other-agent");
eq("没有样本时返回 null", D.pickCapture([], "qoder"), null);

/* v0.3.2：endpointHint 参与选样本。一个页面会顺带请求很多接口，
 * 只按分数会选中「看起来像积分、其实没有目标字段」的那份。 */
var hintedCaps = [
  { agentId: "qoder", url: "https://x/api/plans", score: 11, at: "2026-10-22T02:00:00Z", bodyPreview: "{}" },
  { agentId: "qoder", url: "https://x/api/credit", score: 5, at: "2026-10-20T00:00:00Z", bodyPreview: "{}" },
  { agentId: "qoder", url: "https://x/api/credit?page=2", score: 9, at: "2026-10-21T00:00:00Z", bodyPreview: "{}" }
];
eq("接口提示优先于更高分", D.pickCapture(hintedCaps, "qoder").url, "https://x/api/credit?page=2");
eq("接口提示圈内仍比分", D.pickCapture(hintedCaps.slice(1), "qoder").score, 9);
eq("没有接口匹配时退回总分", D.pickCapture(hintedCaps.slice(0, 1), "qoder").url, "https://x/api/plans");

/* v0.3.17：同一个接口的多份样本按时间取新的。
 * 分数是接口形状的属性，不是新鲜度；余额被花完后字段变少、分数反而更低，
 * 按分数选会永远选回那份胖的旧样本 —— 表现就是「刷新了但数字和后台对不上」。 */
var sameUrlCaps = [
  { agentId: "qoder", url: "https://x/api/credit", score: 9, at: "2026-10-20T00:00:00Z", bodyPreview: "{}" },
  { agentId: "qoder", url: "https://x/api/credit", score: 5, at: "2026-10-23T00:00:00Z", bodyPreview: "{}" }
];
eq("同一接口取最新，哪怕分数更低", D.pickCapture(sameUrlCaps, "qoder").at, "2026-10-23T00:00:00Z");

/* runSync 走通：样本 -> 批次 */
var r = D.runSync("qoder", caps, new Date(2026, 9, 21));
eq("选中那条没认出批次就说 no-rows", r.reason, "no-rows");

var good = [{ agentId: "qoder", score: 9, at: "2026-10-21T00:00:00Z", url: "https://api/q/credit",
  bodyPreview: caps[1].bodyPreview }];
var ok = D.runSync("qoder", good, new Date(2026, 9, 21));
eq("产出 2 个批次", ok.batches.length, 2);
eq("批次带 agent", ok.batches[0].agent, "qoder");
eq("清零时刻换成最后可用日", ok.batches.map(function (b) { return b.expiresAt; }),
  ["2026-10-31", "2026-10-30"]);
eq("单位默认 credits", ok.batches[0].unit, "credits");

/* 失败路径要各有不同说法，不能都推给"没数据" */
eq("截断样本明确报截断", D.runSync("qoder", [Object.assign({}, good[0], { truncated: true })], new Date(2026, 9, 21)).reason, "truncated");
eq("有 adapter 但没样本 -> no-capture", D.runSync("qoder", [{ agentId: "trae", score: 9, url: "u", bodyPreview: "{}" }], new Date(2026, 9, 21)).reason, "no-capture");
eq("没注册 adapter 优先报这个", D.runSync("trae", good, new Date(2026, 9, 21)).reason, "no-adapter");
eq("adapter 抛异常不吞掉", D.runSync("qoder", [{ agentId: "qoder", score: 9, url: "u", bodyPreview: "not json" }], new Date(2026, 9, 21)).reason, "adapter-threw");

/* 批次再喂给 mergeBatches，整条链路才闭合 */
var m = N.mergeBatches([], ok.batches, { now: new Date(2026, 9, 21) });
eq("映射结果可直接进合并", m.batches.length, 2);
var m2 = N.mergeBatches(m.batches, D.runSync("qoder", good, new Date(2026, 9, 21)).batches, { now: new Date(2026, 9, 21) });
eq("再同步不重复", m2.batches.length, 2);
eq("再同步不新增", m2.added, 0);

/* 只同步一家时，别家的缺席计数不该被带上 */
var mixed = m2.batches.concat(N.normalizeBatch({ agent: "trae", label: "月度", granted: 100, remaining: 100, expiry: "2026-12-31" }, { now: new Date(2026, 9, 21) }));
var onlyQ = N.mergeBatches(mixed, D.runSync("qoder", good, new Date(2026, 9, 21)).batches, { now: new Date(2026, 9, 21) });
var traeBatch = onlyQ.batches.filter(function (b) { return b.agent === "trae"; })[0];
eq("同步 Qoder 不影响别家批次", !traeBatch.absentCount, true);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
