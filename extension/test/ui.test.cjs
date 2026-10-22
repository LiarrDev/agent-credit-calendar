/*
 * test/ui.test.cjs — UI 接线回归：页脚、清空确认、导入。
 *
 * 为什么需要它：lib/ 的单测覆盖的是规则，adapters 的单测覆盖的是映射，e2e 覆盖的是
 * 后台链路 —— 但 UI 里"某个渲染函数根本没人调用"这类问题三层都测不到。
 * v0.3.16 就是在补「清空确认 + 导入」时发现的：renderFoot() 定义了却没有任何调用方，
 * 于是页脚（含唯一的清空入口）一直没渲染出来。
 *
 * 做法：用一个极小的 DOM 桩（不引 jsdom）在 vm 里真实加载 calendar.js，
 * 再直接触发元素的 onclick/onchange。不追求像素级渲染，只钉住"接起来"的行为：
 *   1. boot 之后页脚必须真的渲染出来（清空 / 导入入口存在）
 *   2. 清空第一次只改文案、第二次才真删（两段式确认）
 *   3. 导入合法 JSON 会合并进批次，坏 JSON 只提示、不动文档
 */
var vm = require("vm"), fs = require("fs"), path = require("path");

var ROOT = path.join(__dirname, "..");
var KEY = "credit-calendar-v1";

var pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log("ok   " + label); }
  else { fail++; console.log("FAIL " + label + (extra !== undefined ? "  => " + JSON.stringify(extra) : "")); }
}

/* ---------- DOM 桩：按选择器记住一个元素，够 calendar.js 用就行 ---------- */
function createDom() {
  var els = {};
  function El(sel) {
    return {
      _sel: sel, innerHTML: "", textContent: "", value: "", disabled: false, files: null,
      classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
      style: {},
      addEventListener: function (type, fn) { this["on" + type] = fn; },
      removeEventListener: function () {},
      closest: function () { return null; },
      click: function () {},
      appendChild: function () {}, remove: function () {},
      getAttribute: function () { return null; }, setAttribute: function () {}
    };
  }
  var document = {
    querySelector: function (s) { return els[s] || (els[s] = El(s)); },
    querySelectorAll: function () { return []; },
    createElement: function () { return El("created"); },
    body: { appendChild: function () {} },
    activeElement: null
  };
  return { document: document, el: function (s) { return document.querySelector(s); } };
}

/* ---------- chrome 桩：内存存储 + Promise API ---------- */
function createChrome(mem, onChanged) {
  return {
    runtime: {
      id: "test", lastError: null,
      getURL: function (p) { return "chrome-extension://test/" + p; },
      sendMessage: function () {}
    },
    storage: {
      local: {
        get: function (k) {
          var out = {}, keys = Array.isArray(k) ? k : [k];
          keys.forEach(function (key) {
            if (mem[key] !== undefined) out[key] = JSON.parse(JSON.stringify(mem[key]));
          });
          return Promise.resolve(out);
        },
        set: function (o) {
          Object.keys(o).forEach(function (k) { mem[k] = JSON.parse(JSON.stringify(o[k])); });
          return Promise.resolve();
        },
        remove: function (k) { deletes.push(k); delete mem[k]; return Promise.resolve(); }
      },
      onChanged: {
        addListener: function (fn) { onChanged.push(fn); },
        removeListener: function () {}
      }
    },
    permissions: null
  };
}

var deletes = [];

function createUi(seed) {
  var mem = {}, onChanged = [], reloaded = 0;
  var dom = createDom();
  var sandbox = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    chrome: createChrome(mem, onChanged),
    document: dom.document,
    location: { reload: function () { reloaded++; } },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
    Date: Date, JSON: JSON, Math: Math, URL: URL, Blob: Blob, navigator: { userAgent: "test" },
    // FileReader：同步回调，省掉等待；calendar.js 只用到 result / onload / onerror
    FileReader: function () {
      this.readAsText = function (f) {
        if (f._broken) { this.error = { message: "读不了" }; this.onerror && this.onerror(); return; }
        this.result = f._text;
        this.onload && this.onload();
      };
    }
  };
  var ctx = vm.createContext(sandbox);
  ["lib/agents.js", "lib/normalize.js", "lib/diagnose.js", "lib/store.js", "ui/calendar.js"].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  });
  if (seed) mem[KEY] = seed;
  return { ctx: ctx, mem: mem, el: dom.el, deletes: deletes, reloaded: function () { return reloaded; } };
}

function seedDoc() {
  return {
    schema: 1, batches: [], captures: [],
    agents: { qoder: { id: "qoder", fetchMode: "direct", origin: "https://qoder.com", enabled: true } },
    settings: { threshold: 14, staleDays: 7, lazySyncDays: 3 },
    lastSyncAt: null, ui: {}
  };
}

function booted(ext) {
  // boot() 是异步的（Store.load → render），等两个 tick 足够
  return new Promise(function (res) { setTimeout(res, 30); }).then(function () { return ext; });
}

/* ---------- 1. 页脚必须真的渲染出来 ---------- */
var ui = createUi(seedDoc());
booted(ui).then(function (ext) {
  var foot = ext.el("#foot").innerHTML;
  ok("页脚渲染出来了（renderFoot 有调用方）", foot.indexOf("已实现的规则") >= 0, foot.slice(0, 60));
  ok("页脚有清空入口", foot.indexOf("清空本机数据") >= 0);
  ok("页脚有导入入口", foot.indexOf("导入备份") >= 0);
  ok("页脚有隐藏的文件输入", foot.indexOf('type="file"') >= 0);

  /* ---------- 2. 清空：两段式确认 ---------- */
  var wipe = ext.el("#wipe");
  var before = ext.deletes.length;
  wipe.onclick({ preventDefault: function () {} });
  ok("清空第一次点击不删数据", ext.deletes.length === before, ext.deletes);
  ok("清空第一次点击把文案改成确认",
    ext.el("#foot").innerHTML.indexOf("确认清空全部数据") >= 0,
    ext.el("#foot").innerHTML.slice(-80));
  ok("清空第一次点击后数据还在", !!(ext.mem[KEY] && ext.mem[KEY].batches), !!ext.mem[KEY]);

  wipe.onclick({ preventDefault: function () {} });
  // wipe() 是异步的，reload 在下一个 tick
  return new Promise(function (res) { setTimeout(res, 20); }).then(function () {
    ok("清空第二次点击才真删", ext.deletes.indexOf(KEY) >= 0, ext.deletes);
    ok("清空后刷新页面", ext.reloaded() === 1, ext.reloaded());

    /* ---------- 3. 导入 ---------- */
    return createUi(seedDoc());
  });
}).then(function (ext) {
  return booted(ext).then(function () {
    var file = ext.el("#impFile");
    // 合法备份：1 笔批次 + 1 条样本
    file.files = [{
      name: "credit-calendar-2026-10-22.json", size: 2048, type: "application/json",
      _text: JSON.stringify({
        batches: [{
          agent: "qoder", label: "恢复的包", granted: 1000, remaining: 700,
          expiresAt: "2026-11-30", source: "manual", manualEdited: true
        }],
        captures: [{ agentId: "qoder", url: "https://qoder.com/api/usage", bodyPreview: '{"a":1}', score: 6 }]
      })
    }];
    file.onchange.call(file);

    return new Promise(function (res) { setTimeout(res, 30); }).then(function () {
      var b = (ext.mem[KEY].batches || []);
      var c = (ext.mem[KEY].captures || []);
      ok("导入：批次进了文档", b.length === 1, b.length);
      ok("导入：字段按白名单重写", b[0] && b[0].label === "恢复的包" && b[0].remaining === 700,
        b[0] && { label: b[0].label, remaining: b[0].remaining });
      ok("导入：样本进了文档", c.length === 1, c.length);
      ok("导入：提示里说清加了几笔",
        ext.el("#toast").textContent.indexOf("批次 +1") >= 0, ext.el("#toast").textContent);
      ok("导入：文件选择框被清空（能连续导入同一个文件）", file.value === "", file.value);

      // 再导一次同样的文件：不重复
      file.files = [{
        name: "again.json", size: 100, type: "application/json",
        _text: JSON.stringify({ batches: [{ agent: "qoder", label: "恢复的包", granted: 1000, remaining: 700, expiresAt: "2026-11-30" }] })
      }];
      file.onchange.call(file);
      return new Promise(function (res) { setTimeout(res, 30); });
    }).then(function () {
      ok("导入：同一笔不会重复加", (ext.mem[KEY].batches || []).length === 1, ext.mem[KEY].batches.length);

      // 坏 JSON：只提示，不动文档
      file.files = [{ name: "bad.json", size: 10, type: "application/json", _text: "{ 这不是 JSON" }];
      file.onchange.call(file);
      return new Promise(function (res) { setTimeout(res, 20); });
    }).then(function () {
      ok("导入坏 JSON：给出提示", ext.el("#toast").textContent.indexOf("不是合法 JSON") >= 0,
        ext.el("#toast").textContent);
      ok("导入坏 JSON：文档没变", (ext.mem[KEY].batches || []).length === 1, ext.mem[KEY].batches.length);

      // 结构不对：batches 不是数组，不能把 doc 打烂
      file.files = [{ name: "weird.json", size: 10, type: "application/json", _text: '{"batches":"no"}' }];
      file.onchange.call(file);
      return new Promise(function (res) { setTimeout(res, 20); });
    }).then(function () {
      ok("导入结构不对：文档仍是数组", Array.isArray(ext.mem[KEY].batches), typeof ext.mem[KEY].batches);
      ok("导入结构不对：提示没有可导入的内容",
        ext.el("#toast").textContent.indexOf("没有能导入") >= 0, ext.el("#toast").textContent);
    });
  });
}).then(function () {
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}, function (e) {
  console.log("FAIL UI 测试异常：" + (e && e.stack || e));
  console.log("\n" + pass + " passed, " + (fail + 1) + " failed");
  process.exit(1);
});
