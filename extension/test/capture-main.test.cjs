/*
 * capture-main.js 的浏览器侧回归：node test/capture-main.test.cjs
 *
 * 这里不模拟完整页面，只验证钩子对 XHR 三个原型方法的包装没有打断页面：
 * 2026-10-22 真机 TRAE 的 dashboard 就是被 setRequestHeader 的
 * "undefined.apply" 打断的（脚本误取了 XMLHttpRequest.setRequestHeader，
 * 正确位置是 XMLHttpRequest.prototype.setRequestHeader）。
 *
 * 另外钉住两条隐私 / 隐蔽性不变量：
 *   1. 捕获只留请求头的【名字】，值绝不离开页面；
 *   2. 钩子的中间状态不挂在 xhr 实例上（页面脚本枚举不到）——可枚举实例属性
 *      本身就是"fetch/XHR 被人包过"的可检测特征，而某些带反爬标记的站点
 *      正是靠这类检测把会话作废的。
 */
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log("FAIL  " + label + (extra !== undefined ? "\n      => " + JSON.stringify(extra) : "")); }
}

var calls = [];
var posted = [];

function OrigXHR() {
  this._ls = {};
  this.responseText = "";
  this.responseType = "";
  this.status = 200;
}
OrigXHR.prototype.open = function (method, url) {
  calls.push({ kind: "open", method: method, url: url });
};
OrigXHR.prototype.send = function (body) {
  calls.push({ kind: "send", body: body });
};
OrigXHR.prototype.setRequestHeader = function (name, value) {
  calls.push({ kind: "header", name: name, value: value });
};
// 尽量贴近真实 addEventListener：支持 { once: true }，一次性监听器触发后即移除
OrigXHR.prototype.addEventListener = function (type, fn, opts) {
  var self = this;
  var once = !!(opts && opts.once);
  var wrapped = function (ev) {
    if (once) {
      self._ls[type] = (self._ls[type] || []).filter(function (g) { return g !== wrapped; });
    }
    fn.call(self, ev);
  };
  (this._ls[type] = this._ls[type] || []).push(wrapped);
};
/** 测试用：手动触发 loadend，模拟一次响应结束 */
OrigXHR.prototype.fire = function (type) {
  var self = this;
  (this._ls[type] || []).slice().forEach(function (f) { f.call(self, { type: type }); });
};

var sandbox = {
  console: console,
  Date: Date,
  String: String,
  Object: Object,
  Array: Array,
  JSON: JSON,
  WeakMap: WeakMap,
  parseInt: parseInt,
  isFinite: isFinite,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Headers: function () {},
  location: { origin: "https://example.test", href: "https://example.test/dashboard" },
  XMLHttpRequest: OrigXHR,
  fetch: function () { return Promise.resolve({}); },
  postMessage: function (msg) { posted.push(msg); }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "capture-main.js"), "utf8"),
  sandbox,
  { filename: "capture-main.js" }
);

ok("钩子已标记在页面", sandbox.__creditCaptureHooked === true);

var xhr = new OrigXHR();
var thrown = null;
try {
  xhr.open("GET", "/api/x");
  xhr.setRequestHeader("X-Test", "hello");
  xhr.responseText = '{"credits":100}';
  xhr.send("payload");
} catch (e) {
  thrown = String(e && e.message || e);
}
ok("XHR 的 open/setRequestHeader/send 不会打断页面", thrown === null, thrown);
ok("open 正常转发", calls.some(function (c) { return c.kind === "open" && c.method === "GET" && c.url === "/api/x"; }), calls);
ok("setRequestHeader 正常转发（值和名字都到原生实现）",
  calls.some(function (c) { return c.kind === "header" && c.name === "X-Test" && c.value === "hello"; }), calls);
ok("send 正常转发", calls.some(function (c) { return c.kind === "send" && c.body === "payload"; }), calls);

/* ---------- 隐蔽性：钩子状态不能挂在实例上 ---------- */

var ownKeys = Object.keys(xhr);
ok("xhr 实例上没有 __cc* 自有属性（页面枚举不出来）",
  ownKeys.filter(function (k) { return k.indexOf("__cc") === 0; }).length === 0, ownKeys);
var forInKeys = [];
for (var k in xhr) forInKeys.push(k);
ok("for…in 也看不到捕获状态",
  forInKeys.filter(function (k) { return k.indexOf("__cc") === 0; }).length === 0, forInKeys);
ok("原型上也没有可枚举的 __cc*", (function () {
  var protoKeys = [];
  for (var kp in OrigXHR.prototype) protoKeys.push(kp);
  return protoKeys.filter(function (k) { return k.indexOf("__cc") === 0; }).length === 0;
})());
ok("原型方法仍然看起来像原生函数",
  /\[native code\]/.test(String(OrigXHR.prototype.setRequestHeader)), String(OrigXHR.prototype.setRequestHeader));

/* ---------- 捕获内容 ---------- */

xhr.fire("loadend");
var entry = posted.length ? posted[posted.length - 1].entry : null;
ok("响应结束后上报一次", !!entry, posted);
ok("上报的 URL 与方法正确", entry && entry.url === "/api/x" && entry.method === "GET", entry);
ok("捕获到请求头，但只有名字没有值",
  entry && JSON.stringify(entry.requestHeaderNames) === JSON.stringify(["X-Test"]),
  entry && entry.requestHeaderNames);
ok("响应体原样带出", entry && entry.body === '{"credits":100}', entry && entry.body);

/* 复用同一个 XHR 再发一次：{ once: true } 之后不该重复上报 */
var before = posted.length;
xhr.responseText = '{"credits":99}';
xhr.send("again");
xhr.fire("loadend");
xhr.fire("loadend");
// 第二次 send 会新挂一个监听器，所以理应再上报 1 次；
// 真正要挡住的是同一个监听器被 loadend 反复触发（老实现没有 once，会成倍上报）。
ok("同一个响应不会被重复上报（监听器是 once）", posted.length === before + 1, posted.length - before);
ok("重复触发不会把同一条报两遍", posted[posted.length - 1].entry.body === '{"credits":99}',
  posted[posted.length - 1].entry);

/* responseType:"json" 的 XHR：responseText 不可用（真实浏览器里直接抛
 * InvalidStateError），必须从 xhr.response 序列化，否则上报空响应体。 */
var jx = new OrigXHR();
jx.responseType = "json";
jx.response = { code: 0, data: { Accounts: [1, 2, 3] } };
jx.open("POST", "/billing/meter/x");
jx.send("{}");
jx.fire("loadend");
var jentry = posted.length ? posted[posted.length - 1].entry : null;
ok("responseType=json 时从 response 序列化出响应体",
  jentry && jentry.body === JSON.stringify({ code: 0, data: { Accounts: [1, 2, 3] } }),
  jentry && jentry.body);
ok("json 分支也带出方法与 URL",
  jentry && jentry.method === "POST" && jentry.url === "/billing/meter/x", jentry);

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
