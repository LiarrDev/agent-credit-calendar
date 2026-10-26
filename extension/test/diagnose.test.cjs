/*
 * 探针诊断的回归：node test/diagnose.test.cjs
 *
 * 这条不变量是：background 存探针、UI 渲染探针，两边说的必须是**同一句话**。
 * v0.3.9 时两份实现各写各的，措辞已经漂移（直读成功那句后台带字节数、UI 不带），
 * 于是同一份探针在两个地方显示成两句不同的话。现在只剩 lib/diagnose.js 一份。
 */
var D = require("../lib/diagnose.js");
var N = require("../lib/normalize.js");

var pass = 0, fail = 0;
function eq(label, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log("FAIL  " + label + "\n      got  " + g + "\n      want " + w); }
}
function has(label, text, frag) {
  if (String(text).indexOf(frag) >= 0) pass++;
  else { fail++; console.log("FAIL  " + label + "\n      期望包含「" + frag + "」\n      实际 " + JSON.stringify(text)); }
}

eq("没有探针也能给出结论（不抛异常）", typeof D.of(null), "string");

/* ---------- 直读链路 ---------- */
has("401 明确指向没登录", D.of({ mode: "direct", outcome: "auth", httpStatus: 401 }), "没有登录态");
has("401 给出下一步动作", D.of({ mode: "direct", outcome: "auth", httpStatus: 401 }), "刷新余额");
has("http-error 报状态码", D.of({ mode: "direct", outcome: "http-error", httpStatus: 500 }), "HTTP 500");
has("no-quota 提示平台改版", D.of({ mode: "direct", outcome: "no-quota" }), "改版");
has("not-json 提示被重定向", D.of({ mode: "direct", outcome: "not-json" }), "登录页");
has("页面内错误带出原因", D.of({ mode: "direct", outcome: "page-error", error: "CSRF 拿不到" }), "CSRF 拿不到");
has("直读成功带字节数", D.of({ mode: "direct", outcome: "direct", stored: 1, bodyBytes: 131072 }), "131072");
has("截断样本升级要单独说", D.of({ mode: "direct", outcome: "direct", stored: 0, upgraded: 1, bodyBytes: 999 }), "替换");
has("内容与上次相同要说清楚是没变不是没读到",
  D.of({ mode: "direct", outcome: "direct-dup" }), "余额确实没变");
has("未知终态不装作成功", D.of({ mode: "direct", outcome: "???", httpStatus: 200 }), "原因未记录");

/* ---------- 钩子链路：五个断点必须能分开 ---------- */
var noInject = D.of({ responses: 0, candidates: 0, stored: 0 });
var noHook = D.of({ relayAt: "x", responses: 0, candidates: 0, stored: 0 });
var noResponse = D.of({ hookAt: "x", relayAt: "x", responses: 0, candidates: 0, stored: 0 });
var noCandidate = D.of({ hookAt: "x", relayAt: "x", responses: 7, candidates: 0, stored: 0 });
var allDup = D.of({ hookAt: "x", relayAt: "x", responses: 7, candidates: 3, stored: 0, dups: 2 });
var okNew = D.of({ hookAt: "x", relayAt: "x", responses: 7, candidates: 3, stored: 1, bestScore: 9 });

has("断点1：两个心跳都没有 = 钩子没注入", noInject, "没注入");
has("断点2：有中继没钩子 = MAIN world 被挡", noHook, "MAIN world");
has("断点2 给出退路", noHook, "粘贴样本");
has("断点3：钩子在但页面不发响应", noResponse, "响应都没发");
has("断点4：发了但都不像积分接口（带出响应数）", noCandidate, "7");
has("断点5：内容逐字节相同 = 数字没变", allDup, "数字确实没变");
has("成功：存了几条 + 最高分", okNew, "1");
has("成功带出最高分", okNew, "9");
eq("五个断点给出五种不同的结论",
  new Set([noInject, noHook, noResponse, noCandidate, allDup, okNew]).size, 6);

/* ---------- 与 normalize 的配合 ---------- */
has("截断样本升级：重复里区分出 upgraded",
  D.of({ hookAt: "x", responses: 3, candidates: 1, stored: 0, dups: 3, upgraded: 1 }), "完整响应");

/* ---------- 目标接口自身的 HTTP 状态（v0.3.12 新增的探针字段） ---------- */
/* 登录态失效时接口回 401 HTML，一个额度字段都没有，打分为 0、样本不入库——
 * 没有 endpointStatus 这笔记录，诊断只会说"没有一个像积分接口"，真因被藏起来。 */
var authDead = D.of({ hookAt: "x", relayAt: "x", responses: 5, candidates: 0,
  stored: 0, endpointStatus: 401, endpointBytes: 653 });
has("目标接口 401 = 直接说出登录态失效", authDead, "登录态已失效");
has("401 时带出状态码与体量", authDead, "401");
var api5xx = D.of({ hookAt: "x", relayAt: "x", responses: 2, candidates: 0,
  stored: 0, endpointStatus: 502, endpointBytes: 0 });
has("目标接口 5xx = 说接口侧报错而不是怪打分", api5xx, "接口侧报错");
var okButOdd = D.of({ hookAt: "x", relayAt: "x", responses: 4, candidates: 0,
  stored: 0, endpointStatus: 200, endpointBytes: 1200 });
has("接口 200 但不像额度数据 = 提示响应结构可能变了", okButOdd, "不像额度数据");
has("没有 endpointStatus 的探针不吃这些分支（老文档兼容）",
  D.of({ hookAt: "x", relayAt: "x", responses: 4, candidates: 0, stored: 0 }), "没有一个像积分接口");

/* ---------- 目标接口「根本没被请求」（v0.3.13 的探针字段） ---------- */
/* 页面发了响应但目标接口不在其中：这是页面行为问题（缓存/分区没点开），
 * 不是接口匹配问题——必须分开说，否则排查方向整个错掉。 */
var notHit = D.of({ hookAt: "x", relayAt: "x", responses: 9, candidates: 0, stored: 0,
  hasHint: true, targetSeen: false, rejectUrls: ["https://x/a", "https://x/b"] });
has("目标接口没被请求 = 明说并给出建议", notHit, "根本没被请求");
has("列出页面实际请求过的 URL", notHit, "https://x/a");
has("给出「粘贴样本」退路", notHit, "粘贴样本");
has("全被刷掉时带出主要原因",
  D.of({ hookAt: "x", relayAt: "x", responses: 3, candidates: 0, stored: 0,
    rejectReasons: { "响应体为空": 3 } }), "主要是：响应体为空");
has("老探针（无 hasHint）不吃目标接口分支",
  D.of({ hookAt: "x", relayAt: "x", responses: 9, candidates: 0, stored: 0 }), "没有一个像积分接口");

/* ---------- 代发兜底（v0.3.14 / v0.3.15） ---------- */
/* 页面自己没发请求、扩展在页面里代发成功：这时「截到 / 没截到」整套说法都失效了，
 * 结论必须直接讲「页面没发、我代发了、存了几条」。以前是把代发结果接在
 * 「一个都不像积分接口」后面，同一屏两句话互相打架（真机 2026-10-22 17:29）。 */
var withFb = D.of({
  hookAt: "x", relayAt: "x", responses: 8, candidates: 1, stored: 1, bestScore: 9,
  hasHint: true, targetSeen: true, outcome: "both-failed",
  fallback: { ok: true, status: 200, bytes: 66081 }
});
has("代发成功：明说页面一次都没发", withFb, "一次额度接口都没发");
has("代发成功：带上状态码与字节数", withFb, "HTTP 200，66081 字节");
has("代发成功：说清存了几条新样本", withFb, "1 条新样本");
has("代发成功：不再说「没截到候选」", withFb, "代发");
eq("代发成功：不出现「截到」这种自相矛盾的措辞", /截到/.test(withFb), false);

var fbDup = D.of({
  hookAt: "x", relayAt: "x", responses: 8, candidates: 1, stored: 0, dups: 1,
  hasHint: true, targetSeen: true, outcome: "both-failed",
  fallback: { ok: true, status: 200, bytes: 66051 }
});
has("代发成功但内容没变：说「余额确实没变」", fbDup, "余额确实没变");
eq("代发成功但内容没变：不能说成「没读到」", /没读到/.test(fbDup), false);

var fbEmpty = D.of({
  hookAt: "x", relayAt: "x", responses: 8, candidates: 0, stored: 0,
  outcome: "both-failed", fallback: { ok: true, status: 200, bytes: 900 }
});
has("代发成功却没入库：如实说没入库", fbEmpty, "没入库");

// 老探针（没有 outcome 字段）仍走原来的拼接逻辑：升级前存下的诊断不能变成另一句话。
var fbLegacy = D.of({
  hookAt: "x", relayAt: "x", responses: 9, candidates: 0, stored: 0,
  hasHint: true, targetSeen: false,
  fallback: { ok: true, status: 200, bytes: 132000 }
});
has("老探针：保留「目标接口没被请求」的原始结论", fbLegacy, "根本没被请求");
has("老探针：补一句代发结果", fbLegacy, "代发了一次额度请求");

var fbAuth = D.of({
  hookAt: "x", relayAt: "x", responses: 9, candidates: 0, stored: 0,
  hasHint: true, targetSeen: false,
  fallback: { ok: false, status: 401, message: "接口返回 401：这个页面没有登录态。" }
});
has("代发失败：说出真实原因", fbAuth, "代发也失败");
has("代发失败：401 的措辞直达登录", fbAuth, "没有登录态");

/* ---------- 代发优先（v0.3.18） ---------- */
/* WorkBuddy 的常规刷新现在是「隐藏页加载完直接代发」：代发不再是兜底而是主路径，
 * 结论不能再挂「另外：…」的后缀；页面没登录（401）也要单独说，不能掉进
 * 「页面一个接口响应都没发」的计数推断。 */
var sentFirst = D.of({
  hookAt: "x", relayAt: "x", responses: 3, candidates: 0, stored: 1, bestScore: 9,
  hasHint: true, targetSeen: true, outcome: "hidden-send",
  fallback: { ok: true, status: 200, bytes: 132867 }
});
has("代发优先成功：明说没等页面、直接代发", sentFirst, "没有等页面自己发请求");
has("代发优先成功：带状态码与字节数", sentFirst, "HTTP 200，132867 字节");
has("代发优先成功：说清存了几条", sentFirst, "1 条新样本");
eq("代发优先成功：不再用「另外」的后缀措辞", /另外/.test(sentFirst), false);

var sentDup = D.of({
  hookAt: "x", relayAt: "x", responses: 2, candidates: 0, stored: 0, dups: 1,
  outcome: "hidden-send", fallback: { ok: true, status: 200, bytes: 132867 }
});
has("代发优先但内容没变：说「余额确实没变」", sentDup, "余额确实没变");
eq("代发优先但内容没变：不能说成「没读到」", /没读到/.test(sentDup), false);

var sentAuth = D.of({
  hookAt: "x", relayAt: "x", responses: 1, candidates: 0, stored: 0,
  endpointStatus: 401, outcome: "auth",
  fallback: { ok: false, status: 401, needLogin: true,
    message: "接口返回 401：这个页面没有登录态。在该页面登录后再点「刷新余额」。" }
});
has("代发遇到 401：直接说没有登录态", sentAuth, "没有登录态");
has("代发遇到 401：给出下一步（登录后再点）", sentAuth, "登录后再点");
eq("代发遇到 401：不能掉进「页面没发响应」的推断", /响应都没发/.test(sentAuth), false);

/* ---------- 诊断页标题的口径（v0.3.16） ---------- */
/* v0.3.15 修掉了「代发成功、标题却写没读到」这一支，但 outcome:"error" 漏了：
 * 标题标绿写「读到了页面响应」，正文写「刷新流程本身出错了」。这类"同一屏两句话
 * 打架"是这个项目明令禁止的，所以标题口径也收进 diagnose.js，一起测。 */
var vErr = D.verdict({ hookAt: "x", responses: 3, candidates: 1, outcome: "error", error: "开页失败" });
eq("error 探针：标题不能说成读到了", vErr.ok, false);
has("error 探针：标题点明是流程出错", vErr.text, "流程出错");
eq("error 探针：标题与正文不打架",
  /流程出错/.test(vErr.text) && !/读到了页面响应/.test(vErr.text), true);

var vBoth = D.verdict({ outcome: "both-failed", responses: 2 });
eq("两轮都没等到：标题是失败色", vBoth.ok, false);
has("两轮都没等到：标题说清楚两轮都试过", vBoth.text, "都试过了");

var vFb = D.verdict({ outcome: "both-failed", responses: 2, fallback: { ok: true, status: 200 } });
eq("代发成功：标题算读到", vFb.ok, true);
has("代发成功：标题说明是代发", vFb.text, "代发");

var vOk = D.verdict({ hookAt: "x", responses: 5, candidates: 2, stored: 1 });
eq("正常截到：标题算读到", vOk.ok, true);

var vDirect = D.verdict({ mode: "direct", outcome: "direct", stored: 1 });
eq("直读成功：标题算读到", vDirect.ok, true);
var vDirectBad = D.verdict({ mode: "direct", outcome: "auth", httpStatus: 401 });
eq("直读 401：标题是失败色", vDirectBad.ok, false);
has("直读 401：标题不说读到", vDirectBad.text, "没读到");

var vSent = D.verdict({ outcome: "hidden-send", fallback: { ok: true, status: 200 } });
eq("代发优先成功：标题算读到", vSent.ok, true);
has("代发优先成功：标题说明是后台页代发", vSent.text, "代发");

var vSentAuth = D.verdict({ outcome: "auth", fallback: { ok: false, status: 401 } });
eq("代发遇到 401：标题是失败色", vSentAuth.ok, false);
has("代发遇到 401：标题点明未登录", vSentAuth.text, "未登录");
eq("代发遇到 401：标题不说读到", /读到了页面响应/.test(vSentAuth.text), false);

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
void N;
