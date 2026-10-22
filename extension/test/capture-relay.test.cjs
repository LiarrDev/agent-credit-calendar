/*
 * capture-relay.js 的浏览器侧回归：node test/capture-relay.test.cjs
 *
 * 验的是"入库前的最后一道闸"：形状校验 + **剥离 agentId**。
 * 中继是页面消息进入后台的唯一入口，agentId 一旦放行，页面就能把样本记到别的
 * 平台账上（详见 lib/agents.js 的 attributeAgent 注释）。
 */
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log("FAIL  " + label + (extra !== undefined ? "\n      => " + JSON.stringify(extra) : "")); }
}

var sent = [];       // 中继转发给后台的消息
var handler = null;  // window 上的 message 监听器

var sandbox = {
  console: console,
  Number: Number,
  String: String,
  Object: Object,
  Array: Array,
  isFinite: isFinite,
  location: {
    origin: "https://www.workbuddy.cn",
    href: "https://www.workbuddy.cn/profile/plans-usage"
  },
  addEventListener: function (_type, fn) { handler = fn; },
  chrome: {
    runtime: {
      lastError: null,
      sendMessage: function (msg, cb) { sent.push(msg); if (cb) cb(); }
    }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "capture-relay.js"), "utf8"),
  sandbox,
  { filename: "capture-relay.js" }
);

// vm 里取到的 window 是「上下文化的全局代理」，不是我们塞进去的 sandbox 对象。
// 中继的 `ev.source !== window` 比的就是这个代理，所以伪造页面消息时 source 必须
// 用同一个对象，否则会误判成跨 iframe 消息而被丢掉，测的就不是真实路径了。
var WIN = vm.runInContext("window", sandbox);

/** 模拟页面脚本 window.postMessage 一条消息（ev.source === window）。 */
function fromPage(data) {
  handler({ source: WIN, data: data });
}

function entry(over) {
  return Object.assign({
    origin: "https://www.workbuddy.cn",
    pageUrl: "https://www.workbuddy.cn/profile/plans-usage",
    url: "https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages",
    method: "GET",
    status: 200,
    body: '{"code":0,"data":{"Accounts":[]}}'
  }, over || {});
}

ok("启动即上报 RELAY_READY（后台靠它判断注入成功）",
  sent.length === 1 && sent[0].type === "RELAY_READY", sent);
ok("RELAY_READY 带上 origin", sent[0] && sent[0].origin === "https://www.workbuddy.cn", sent[0]);

/* ---------- 形状校验 ---------- */

sent.length = 0;
fromPage({ __creditCapture: true, entry: entry({ url: "chrome-extension://abc/x" }) });
ok("非 http(s) 的 entry 丢弃", sent.length === 0, sent);

fromPage({ __creditCapture: true, entry: entry({ status: 999 }) });
ok("状态码离谱的 entry 丢弃", sent.length === 0, sent);

fromPage({ __creditCapture: true, entry: entry({ body: new Array(200002).join("a") }) });
ok("超过 200KB 的 entry 丢弃", sent.length === 0, sent);

fromPage({ __creditCapture: true, entry: entry({ origin: "https://qoder.com" }) });
ok("跨源伪造（origin 与页面不符）丢弃", sent.length === 0, sent);

/* ---------- 核心：agentId 一律不放行 ---------- */

sent.length = 0;
fromPage({ __creditCapture: true, entry: entry({ agentId: "qoder" }) });
ok("合法的 entry 正常转发", sent.length === 1 && sent[0].type === "CAPTURED", sent);
ok("**伪造的 agentId 被剥离**（页面不能决定样本记给哪个平台）",
  sent[0] && !("agentId" in sent[0].entry), sent[0] && sent[0].entry);

sent.length = 0;
fromPage({ __creditCapture: true, entry: entry({ agentId: "qoder", origin: "https://qoder.com" }) });
ok("既冒充 agentId 又冒充 origin 的，整条丢弃", sent.length === 0, sent);

/* ---------- 正常样本不该被误伤 ---------- */

sent.length = 0;
fromPage({ __creditCapture: true, entry: entry() });
ok("普通样本照常转发", sent.length === 1 && sent[0].type === "CAPTURED", sent);
ok("转发时保留 url / body / status（后台打分要用）",
  sent[0] && sent[0].entry.status === 200 && /Accounts/.test(sent[0].entry.body),
  sent[0] && sent[0].entry);

ok("无关消息不转发", (function () {
  sent.length = 0;
  fromPage({ hello: "world" });
  fromPage({ __creditCapture: false, entry: entry() });
  return sent.length === 0;
})(), sent);

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
