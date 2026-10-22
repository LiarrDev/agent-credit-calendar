/*
 * test/e2e-refresh.test.cjs — 后台「刷新余额」整条链路的端到端回归。
 *
 * 为什么需要它：单测覆盖的是 lib/ 与 adapters/ 这些纯函数，而「刷新余额」真正
 * 出问题的地方往往在它们的**接线**上——开页 → 钩子心跳 → 上报 → 归属 → 等待 →
 * 同步。v0.3.10 就把 waitForCapture 改成了纯 storage.onChanged 事件驱动：单测
 * 338 条全绿，真实环境里事件一旦没派发，样本其实已经入库、等待却一直判
 * seen:false，于是刷新报失败、syncOne 根本不跑，用户看到的就是「余额刷不出来」。
 * 这种"每一段都对、接起来坏"的回归，只有端到端能拦住。
 *
 * 做法：mock 掉 chrome.*，在 vm 里真实加载 background.js，走一次完整的
 * REFRESH_CAPTURES，再断言最终落库的 batches。
 *
 * 两个场景刻意都跑：
 *   1. onChanged 正常 —— 应该秒回（事件驱动生效）
 *   2. onChanged 不派发 —— 也必须成功（2 秒兜底复查生效），这正是上面那个坑
 */
var vm = require("vm"), fs = require("fs"), path = require("path");

var ROOT = path.join(__dirname, "..");
var KEY = "credit-calendar-v1";
var API = "https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages";
var PAGE = "https://www.workbuddy.cn/profile/plans-usage";

var pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log("ok   " + label); }
  else { fail++; console.log("FAIL " + label + (extra !== undefined ? "  => " + JSON.stringify(extra) : "")); }
}

function account(i) {
  return {
    PackageName: "CodeBuddy个人版国内运营裂变包",
    SubProductName: "CodeBuddy个人版",
    ResourceId: "res-e2e-" + i, AccountId: "acct-" + i, DealName: "deal-" + i,
    CapacitySize: 0, CapacityRemain: 0, CapacityUsed: 0,
    CycleCapacitySizePrecise: "500",
    CycleCapacityRemainPrecise: String(100 + i),
    CycleCapacityUsedPrecise: String(400 - i),
    CycleStartTime: "2026-10-01 00:00:00",
    CycleEndTime: "2026-11-01 00:00:00",
    DeductionEndTime: "2035-01-01 00:00:00",
    ExpiredTime: "", Status: 0
  };
}
var BODY = JSON.stringify({
  code: 0, msg: "OK",
  data: { TotalCount: 3, Accounts: [account(1), account(2), account(3)] }
});

/** 建一个带 mock chrome 的扩展环境，返回发消息与读存储的句柄。 */
function createExt(dropOnChanged, fastWait) {
  var mem = {}, onChanged = [], msgListeners = [], tabSeq = 1000;

  function fire(key, doc) {
    if (dropOnChanged) return;
    var changes = {}; changes[key] = { newValue: doc };
    onChanged.slice().forEach(function (fn) { try { fn(changes, "local"); } catch (e) {} });
  }

  var chrome = {
    runtime: {
      lastError: null,
      getURL: function (p) { return "chrome-extension://test/" + p; },
      onMessage: { addListener: function (fn) { msgListeners.push(fn); }, removeListener: function () {} },
      onInstalled: { addListener: function () {} },
      onStartup: { addListener: function () {} }
    },
    action: { onClicked: { addListener: function () {} } },
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
          Object.keys(o).forEach(function (k) {
            mem[k] = JSON.parse(JSON.stringify(o[k]));
            setTimeout(function () { fire(k, JSON.parse(JSON.stringify(o[k]))); }, 0);
          });
          return Promise.resolve();
        },
        remove: function (k) { delete mem[k]; return Promise.resolve(); }
      },
      onChanged: {
        addListener: function (fn) { onChanged.push(fn); },
        removeListener: function (fn) {
          var i = onChanged.indexOf(fn); if (i >= 0) onChanged.splice(i, 1);
        }
      }
    },
    scripting: {
      registerContentScripts: function () { return Promise.resolve(); },
      unregisterContentScripts: function () { return Promise.resolve(); },
      // v0.3.14 的代发兜底：真实环境是 chrome.scripting.executeScript 在页面里
      // 跑 directFetchInPage；这里直接回一份和站点一致的 200 响应。
      executeScript: function (opts) {
        if (sandbox.__scriptResult) return Promise.resolve([{ result: sandbox.__scriptResult }]);
        return Promise.resolve([{ result: {
          ok: true, status: 200, finalUrl: API,
          contentType: "application/json", body: BODY,
          bodyBytes: BODY.length, truncated: false, tokenFound: true
        } }]);
      }
    },
    tabs: {
      create: function (o) { tabSeq++; return Promise.resolve({ id: tabSeq, url: o.url, active: !!o.active }); },
      get: function (id) { return Promise.resolve({ id: id, status: "complete", url: PAGE }); },
      remove: function () { return Promise.resolve(); }
    }
  };

  var sandbox = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    chrome: chrome,
    setTimeout: setTimeout, setInterval: setInterval,
    clearInterval: clearInterval, clearTimeout: clearTimeout,
    URL: URL, URLSearchParams: URLSearchParams
  };
  var ctx = vm.createContext(sandbox);
  sandbox.importScripts = function () {
    for (var i = 0; i < arguments.length; i++) {
      var f = arguments[i];
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
    }
  };
  // 场景 3 需要「两轮都等不到」，按真实 12s + 20s 会把测试拖到半分钟。
  // 只在这个场景把两个等待窗口调小；等待逻辑本身由场景 1/2 覆盖。
  var src = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  if (fastWait) {
    src = src.replace("var SYNC_WAIT_MS = 12000;", "var SYNC_WAIT_MS = 400;")
             .replace("var VISIBLE_WAIT_MS = 20000;", "var VISIBLE_WAIT_MS = 600;");
  }
  vm.runInContext(src, ctx, { filename: "background.js" });

  // 预置：workbuddy 已授权、钩子在场
  mem[KEY] = {
    schema: 1, batches: [], captures: [],
    agents: {
      workbuddy: {
        id: "workbuddy", name: "WorkBuddy", unit: "credits",
        origin: "https://www.workbuddy.cn", consoleUrl: PAGE,
        fetchMode: "capture", hookActive: true, endpoint: null, enabled: true
      }
    },
    settings: { threshold: 14, staleDays: 7, lazySyncDays: 3 },
    lastSyncAt: null, ui: {}
  };

  var sender = { tab: { id: 1001, url: PAGE } };
  function send(msg, cb) {
    var handled = false;
    msgListeners.forEach(function (fn) {
      fn(msg, sender, function (r) { handled = true; if (cb) cb(r); });
    });
    return handled;
  }

  return { mem: mem, send: send, sender: sender, ctx: ctx };
}

/** 走一次完整刷新，返回结果与耗时。 */
function runRefresh(dropOnChanged, fastWait) {
  var ext = createExt(dropOnChanged, fastWait);
  var s = ext.sender;

  return new Promise(function (resolve) {
    var t0 = Date.now(), result = null;

    ext.send({ type: "REFRESH_CAPTURES", agentId: "workbuddy", ephemeral: false }, function (r) {
      result = r;
      resolve({ r: r, ms: Date.now() - t0, mem: ext.mem });
    });

    if (fastWait) {
      // 场景 3：页面加载完了，但一次额度接口都不请求（真机 09:12 那次的样子）。
      setTimeout(function () {
        ext.send({ type: "HOOK_READY", origin: "https://www.workbuddy.cn", pageUrl: PAGE });
        ext.send({ type: "RELAY_READY", origin: "https://www.workbuddy.cn", pageUrl: PAGE });
      }, 50);
    } else {
      setTimeout(function () {
        ext.send({ type: "HOOK_READY", origin: "https://www.workbuddy.cn", pageUrl: PAGE });
        ext.send({ type: "RELAY_READY", origin: "https://www.workbuddy.cn", pageUrl: PAGE });
      }, 200);

      setTimeout(function () {
        ext.send({
          type: "CAPTURED",
          entry: {
            url: API, method: "GET", status: 200,
            requestHeaderNames: ["content-type"], body: BODY, via: "fetch",
            origin: "https://www.workbuddy.cn", pageUrl: PAGE
          }
        });
      }, 500);
    }

    // 兜底：真卡住也别把测试挂死
    setTimeout(function () {
      if (result === null) resolve({ r: { ok: false, reason: "timeout" }, ms: Date.now() - t0, mem: ext.mem });
    }, 40000);
  });
}

(function main() {
  console.log("--- 场景 1：storage.onChanged 正常派发");
  runRefresh(false).then(function (a) {
    ok("事件驱动：刷新成功", a.r && a.r.ok === true, a.r);
    ok("事件驱动：抓到新内容", !!(a.r && a.r.changed), a.r && a.r.changed);
    ok("事件驱动：日历写入 3 笔批次",
      (a.mem[KEY].batches || []).length === 3, (a.mem[KEY].batches || []).length);
    ok("事件驱动：秒回（<5s，说明走的是事件而不是轮询）", a.ms < 5000, a.ms);

    console.log("--- 场景 2：storage.onChanged 不派发（v0.3.10 的回归点）");
    return runRefresh(true);
  }).then(function (b) {
    ok("兜底复查：事件没派发也要刷新成功", b.r && b.r.ok === true, b.r);
    ok("兜底复查：日历仍然写入 3 笔批次",
      (b.mem[KEY].batches || []).length === 3, (b.mem[KEY].batches || []).length);
    ok("兜底复查：没退化成干等超时（<10s）", b.ms < 10000, b.ms);

    console.log("--- 场景 3：页面加载完但一次额度接口都不请求（v0.3.14 代发兜底）");
    return runRefresh(false, true);
  }).then(function (c) {
    ok("代发兜底：刷新仍然成功", c.r && c.r.ok === true, c.r);
    ok("代发兜底：结果里带 fallback 记录", !!(c.r && c.r.fallback && c.r.fallback.ok), c.r && c.r.fallback);
    ok("代发兜底：日历写入 3 笔批次",
      (c.mem[KEY].batches || []).length === 3, (c.mem[KEY].batches || []).length);
    ok("代发兜底：诊断说清「页面没发、扩展代发」",
      /代发/.test(String(c.r && c.r.diagnosis)), c.r && c.r.diagnosis);
    ok("代发兜底：探针把 fallback 落库（诊断页能看到）",
      !!(c.mem[KEY].agents.workbuddy.probe && c.mem[KEY].agents.workbuddy.probe.fallback),
      c.mem[KEY].agents.workbuddy.probe && c.mem[KEY].agents.workbuddy.probe.fallback);
    // v0.3.15：pageSend 必须把探测句柄传进 storeCapture，否则真正入库的那条不计数，
    // 探针会显示「0 条新样本 / 1 条内容相同」——真机 09:29 那次的假结论就是这么来的。
    ok("代发兜底：探针记到 1 条新样本",
      c.mem[KEY].agents.workbuddy.probe.stored === 1,
      c.mem[KEY].agents.workbuddy.probe.stored);
    ok("代发兜底：没有被误记成重复",
      c.mem[KEY].agents.workbuddy.probe.dups === 0,
      c.mem[KEY].agents.workbuddy.probe.dups);
    ok("代发兜底：诊断说的是「存了新样本」而不是「逐字节相同」",
      /1 条新样本/.test(String(c.r && c.r.diagnosis))
        && !/逐字节相同/.test(String(c.r && c.r.diagnosis)),
      c.r && c.r.diagnosis);

    console.log("--- 场景 4：代发请求被自己的钩子截到（回声）");
    return echoChecks();
  }).then(function () {
    console.log("--- 场景 5：完整响应会清掉同接口的旧截断样本");
    return pruneChecks();
  }).then(function () {
    console.log("\n" + pass + " passed, " + fail + " failed");
    process.exit(fail ? 1 : 0);
  }, function (e) {
    console.log("FAIL 端到端异常：" + e);
    console.log("\n" + pass + " passed, " + (fail + 1) + " failed");
    process.exit(1);
  });
})();

/**
 * 场景 4：我们代发的请求走的是页面的 window.fetch，也就是被 capture-main 包过的那一个，
 * 所以它一定会被自己的钩子再截一次。那次必须被认成回声丢掉，不然探针上会多出
 * 一个「页面响应」和一条「内容相同」——正是真机上让人以为没刷新的假数字。
 */
function echoChecks() {
  var ext = createExt(false, true);
  var ctx = ext.ctx;
  var p = ctx.beginProbe("workbuddy", "hook");
  p.selfUrl = API;
  p.selfAt = Date.now();

  return ctx.onCaptured({
    url: API, method: "POST", status: 200, body: BODY, via: "fetch",
    requestHeaderNames: [], pageUrl: PAGE
  }, ext.sender).then(function (r) {
    ok("回声：不入库", !!(r && r.reason === "self-echo"), r);
    ok("回声：不算页面的响应数", p.responses === 0, p.responses);
    ok("回声：单独记一笔 echoes", p.echoes === 1, p.echoes);
    ok("回声：样本库里没多出条目", (ext.mem[KEY].captures || []).length === 0,
      (ext.mem[KEY].captures || []).length);
  });
}

/**
 * 场景 5：截断样本和完整样本的内容指纹本来就不同，判重抓不到，两条会并存。
 * 完整样本入库时必须把同接口的旧截断样本清掉，否则面板上永远挂着
 * 「响应体被截断，点刷新再试一次」，而真数据就在旁边。
 */
function pruneChecks() {
  var ext = createExt(false, true);
  var ctx = ext.ctx;
  var p = ctx.beginProbe("workbuddy", "hook");

  // 截断样本得用「能打到分」的身体来造：真实那条 60KB 截断样本前缀里字段齐全，
  // 打 9 分照常入库。拿半截非法 JSON 来模拟会被打分直接刷掉，测不到清理逻辑。
  var older = JSON.stringify({
    code: 0, msg: "OK",
    data: { TotalCount: 2, Accounts: [account(7), account(8)] }
  });
  var newer = JSON.stringify({
    code: 0, msg: "OK",
    data: { TotalCount: 2, Accounts: [account(7), account(8), account(9)] }
  });

  return ctx.storeCapture("workbuddy", {
    url: API, method: "POST", status: 200, body: older, bodyBytes: older.length + 4000,
    truncated: true, via: "xhr", pageUrl: PAGE, requestHeaderNames: []
  }, p).then(function (r1) {
    ok("清理：先存下一条旧截断样本", !!(r1 && r1.stored), r1);
    return ctx.storeCapture("workbuddy", {
      url: API, method: "POST", status: 200, body: newer, bodyBytes: newer.length,
      truncated: false, via: "fetch", pageUrl: PAGE, requestHeaderNames: []
    }, p);
  }).then(function () {
    var caps = (ext.mem[KEY].captures || []).filter(function (c) { return c.url === API; });
    ok("清理：同接口只剩完整样本", caps.length === 1 && !caps[0].truncated,
      caps.map(function (c) { return { truncated: c.truncated, len: c.bodyLength }; }));
    ok("清理：探针记下 superseded", p.superseded === 1, p.superseded);
  });
}
