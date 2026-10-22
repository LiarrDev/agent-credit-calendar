/*
 * 信任边界回归：node test/ownership.test.cjs
 *
 * 锁死一条不变量：**只有扩展自己的 UI（粘贴样本）能指定样本归属哪个平台**。
 * 页面脚本能伪造 entry 的全部字段（MAIN world 与页面共享 JS 环境），如果钩子通道
 * 也采信 entry.agentId，A 站点的页面就能往 B 平台的批次里塞假到期日——
 * 这比"抓不到"危险得多。
 */
var AG = require("../lib/agents.js");

var pass = 0, fail = 0;
function eq(label, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.log("FAIL  " + label + "\n      得到 " + g + "\n      期望 " + w);
  }
}

var AGENTS = {
  qoder:     { origin: "https://qoder.com" },
  workbuddy: { origin: "https://www.workbuddy.cn" }
};

function tab(url) { return { tab: { url: url } }; }

/* ---------- 可信通道（粘贴样本） ---------- */

eq("粘贴通道采信 UI 传来的 agentId",
  AG.attributeAgent({ agentId: "qoder" }, tab("chrome-extension://abc/ui/calendar.html"), true, AGENTS),
  "qoder");

eq("粘贴通道：agentId 未登记则拒绝（不能凭空造一个平台）",
  AG.attributeAgent({ agentId: "evil" }, tab("chrome-extension://abc/ui/calendar.html"), true, AGENTS),
  null);

eq("粘贴通道：没带 agentId 也拒绝，不退化成按 origin 猜",
  AG.attributeAgent({ origin: "https://qoder.com" }, tab("chrome-extension://abc/ui/calendar.html"), true, AGENTS),
  null);

/* ---------- 不可信通道（钩子 / 中继）：entry 的字段一律不采信 ---------- */

eq("钩子通道按 tab 的 origin 认平台",
  AG.attributeAgent({ url: "https://qoder.com/api/x" }, tab("https://qoder.com/account/usage"), false, AGENTS),
  "qoder");

eq("伪造 agentId 无效：workbuddy 页面自称 qoder 也记给 workbuddy",
  AG.attributeAgent(
    { agentId: "qoder", origin: "https://www.workbuddy.cn", url: "https://www.workbuddy.cn/x" },
    tab("https://www.workbuddy.cn/profile/plans-usage"), false, AGENTS),
  "workbuddy");

eq("伪造 origin 也无效：entry.origin 与 tab 不一致时以 tab 为准",
  AG.attributeAgent(
    { origin: "https://qoder.com" },
    tab("https://www.workbuddy.cn/profile/plans-usage"), false, AGENTS),
  "workbuddy");

eq("tab.url 缺失时退回 entry.origin（后台可能拿不到 tab）",
  AG.attributeAgent({ origin: "https://qoder.com" }, undefined, false, AGENTS),
  "qoder");

eq("两者都没有就认不出平台",
  AG.attributeAgent({}, undefined, false, AGENTS),
  null);

eq("未授权的 origin 认不出平台",
  AG.attributeAgent({}, tab("https://evil.example/pwn"), false, AGENTS),
  null);

eq("sender 缺 tab 不抛异常",
  AG.attributeAgent({ origin: "https://qoder.com" }, {}, false, AGENTS),
  "qoder");

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
