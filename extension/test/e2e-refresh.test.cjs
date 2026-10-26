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
function createExt(dropOnChanged, fastWait, scriptResults) {
  var mem = {}, onChanged = [], msgListeners = [], tabSeq = 1000;
  // 写存储的次数：service worker 每次唤醒都会整份 set() 一次的话，扩展页会被
  // onChanged 叫醒重画，正在填的补录表单就没了（见 background 的 retireQoderHook）。
  var writes = 0;

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
          writes++;
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
      // v0.3.18 起支持排队：scriptResults 里的结果先出（测代发失败→兜底），用完回落默认。
      executeScript: function (opts) {
        if (sandbox.__scriptResults && sandbox.__scriptResults.length) {
          return Promise.resolve([{ result: sandbox.__scriptResults.shift() }]);
        }
        if (sandbox.__scriptResult) return Promise.resolve([{ result: sandbox.__scriptResult }]);
        return Promise.resolve([{ result: {
          ok: true, status: 200, finalUrl: API,
          contentType: "application/json", body: BODY,
          bodyBytes: BODY.length, truncated: false, tokenFound: true
        } }]);
      }
    },
    tabs: {
      created: [], removed: [], fg: 0,
      create: function (o) {
        tabSeq++;
        chrome.tabs.created.push({ id: tabSeq, active: !!o.active, url: o.url });
        return Promise.resolve({ id: tabSeq, url: o.url, active: !!o.active });
      },
      get: function (id) { return Promise.resolve({ id: id, status: "complete", url: PAGE }); },
      remove: function (id) { chrome.tabs.removed.push(id); return Promise.resolve(); },
      update: function (id, props) {
        if (props && props.active) chrome.tabs.fg++;
        return Promise.resolve({ id: id, active: !!(props && props.active) });
      }
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
  sandbox.__scriptResults = (scriptResults || []).slice();
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

  return { mem: mem, send: send, sender: sender, ctx: ctx, tabs: chrome.tabs, writes: function () { return writes; } };
}

/** 走一次完整刷新，返回结果与耗时。 */
function runRefresh(dropOnChanged, fastWait, scriptResults) {
  var ext = createExt(dropOnChanged, fastWait, scriptResults);
  var s = ext.sender;

  return new Promise(function (resolve) {
    var t0 = Date.now(), result = null;

    ext.send({ type: "REFRESH_CAPTURES", agentId: "workbuddy", ephemeral: false }, function (r) {
      result = r;
      resolve({ r: r, ms: Date.now() - t0, mem: ext.mem, ext: ext });
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
  // v0.3.18 代发优先：WorkBuddy 的常规路径不再等页面自己发请求。场景 1/2 要继续
  // 覆盖 waitForCapture 的事件驱动行为，所以让隐藏页的代发先失败（注入被挡），
  // 流程落到可见页兜底，页面自己的 CAPTURED 在可见轮被等到。
  var SEND_FAIL = { ok: false, error: "注入被挡" };

  console.log("--- 场景 1：storage.onChanged 正常派发");
  runRefresh(false, false, [SEND_FAIL]).then(function (a) {
    ok("事件驱动：刷新成功", a.r && a.r.ok === true, a.r);
    ok("事件驱动：抓到新内容", !!(a.r && a.r.changed), a.r && a.r.changed);
    ok("事件驱动：日历写入 3 笔批次",
      (a.mem[KEY].batches || []).length === 3, (a.mem[KEY].batches || []).length);
    ok("事件驱动：秒回（<5s，说明走的是事件而不是轮询）", a.ms < 5000, a.ms);
    ok("事件驱动：先开隐藏页（代发失败），再开可见页等截获",
      a.ext.tabs.created.length === 2 &&
        a.ext.tabs.created[0].active === false && a.ext.tabs.created[1].active === true,
      a.ext.tabs.created);
    ok("事件驱动：两个标签页都已关闭（v0.3.18 修僵尸页，旧实现隐藏页不关）",
      a.ext.tabs.removed.length === 2 &&
        a.ext.tabs.removed.indexOf(a.ext.tabs.created[0].id) >= 0 &&
        a.ext.tabs.removed.indexOf(a.ext.tabs.created[1].id) >= 0,
      a.ext.tabs.removed);

    console.log("--- 场景 2：storage.onChanged 不派发（v0.3.10 的回归点）");
    return runRefresh(true, false, [SEND_FAIL]);
  }).then(function (b) {
    ok("兜底复查：事件没派发也要刷新成功", b.r && b.r.ok === true, b.r);
    ok("兜底复查：日历仍然写入 3 笔批次",
      (b.mem[KEY].batches || []).length === 3, (b.mem[KEY].batches || []).length);
    ok("兜底复查：没退化成干等超时（<10s）", b.ms < 10000, b.ms);

    console.log("--- 场景 3：代发优先——页面不发请求也一次读成（v0.3.18）");
    return runRefresh(false, true);
  }).then(function (c) {
    ok("代发优先：刷新成功", c.r && c.r.ok === true, c.r);
    ok("代发优先：结果里带 fallback 记录", !!(c.r && c.r.fallback && c.r.fallback.ok), c.r && c.r.fallback);
    ok("代发优先：日历写入 3 笔批次",
      (c.mem[KEY].batches || []).length === 3, (c.mem[KEY].batches || []).length);
    ok("代发优先：诊断说清「没等页面、直接代发」",
      /代发/.test(String(c.r && c.r.diagnosis)), c.r && c.r.diagnosis);
    ok("代发优先：探针把 fallback 落库（诊断页能看到）",
      !!(c.mem[KEY].agents.workbuddy.probe && c.mem[KEY].agents.workbuddy.probe.fallback),
      c.mem[KEY].agents.workbuddy.probe && c.mem[KEY].agents.workbuddy.probe.fallback);
    // v0.3.15：pageSend 必须把探测句柄传进 storeCapture，否则真正入库的那条不计数，
    // 探针会显示「0 条新样本 / 1 条内容相同」——真机 09:29 那次的假结论就是这么来的。
    ok("代发优先：探针记到 1 条新样本",
      c.mem[KEY].agents.workbuddy.probe.stored === 1,
      c.mem[KEY].agents.workbuddy.probe.stored);
    ok("代发优先：没有被误记成重复",
      c.mem[KEY].agents.workbuddy.probe.dups === 0,
      c.mem[KEY].agents.workbuddy.probe.dups);
    ok("代发优先：诊断说的是「存了新样本」而不是「逐字节相同」",
      /1 条新样本/.test(String(c.r && c.r.diagnosis))
        && !/逐字节相同/.test(String(c.r && c.r.diagnosis)),
      c.r && c.r.diagnosis);
    ok("代发优先：outcome 记为 hidden-send",
      c.mem[KEY].agents.workbuddy.probe.outcome === "hidden-send",
      c.mem[KEY].agents.workbuddy.probe && c.mem[KEY].agents.workbuddy.probe.outcome);
    ok("代发优先：只开过一次页面（隐藏页）且已关闭，不抢焦点",
      c.ext.tabs.created.length === 1 && c.ext.tabs.created[0].active === false
        && c.ext.tabs.removed.length === 1,
      { created: c.ext.tabs.created, removed: c.ext.tabs.removed });

    console.log("--- 场景 3b：页面没登录（代发返回 401）→ 保页切前台");
    return needLoginChecks();
  }).then(function () {
    console.log("--- 场景 3c：隐藏代发失败 → 可见页兜底（老链路保留）");
    return bothFailedFallbackChecks();
  }).then(function () {
    console.log("--- 场景 4：代发请求被自己的钩子截到（回声）");
    return echoChecks();
  }).then(function () {
    console.log("--- 场景 5：完整响应会清掉同接口的旧截断样本");
    return pruneChecks();
  }).then(function () {
    console.log("--- 场景 6：SW 唤醒时不该产生无谓的存储写入（v0.3.16）");
    return startupWriteChecks();
  }).then(function () {
    console.log("--- 场景 7：同一平台的并发刷新要被互斥挡住（v0.3.16）");
    return concurrentChecks();
  }).then(function () {
    console.log("--- 场景 8：后台不再返回的批次必须从余额里剔掉（v0.3.17）");
    return goneChecks();
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
 * 场景 6：service worker 每次唤醒都会跑一遍 retireQoderHook（顶层调用）。
 * 它以前无条件 CreditStore.update() = 整份文档 load + 序列化 + set，于是任意一个
 * 后台页心跳都会触发 onChanged → 扩展页 render()，把正在填的「补录批次」表单
 * 连同已输入内容冲掉。这里断言：Qoder 已是目标状态时，启动不产生任何写入。
 */
function startupWriteChecks() {
  var ext = createExt(false, true);
  return new Promise(function (res) { setTimeout(res, 120); }).then(function () {
    ok("启动：Qoder 已是目标状态时零写入", ext.writes() === 0, ext.writes());
    return ext.ctx.CreditStore.load();
  }).then(function (d) {
    ok("启动：Qoder 仍是 direct 且无钩子",
      d.agents.qoder.fetchMode === "direct" && d.agents.qoder.hookActive === false,
      { fetchMode: d.agents.qoder.fetchMode, hook: d.agents.qoder.hookActive });
  });
}

/**
 * 场景 7：连点两次「刷新余额」。
 *
 * 以前第二次会覆盖第一次的探针，等两次各自收尾时探针已经被删掉，诊断变成
 * 「没有探针记录」；ephemeral 路径下先结束的那次还会把另一次的钩子拆掉，
 * 却把 hookActive 写成 true —— 之后自动同步一直在没有钩子的页面上白等 32 秒。
 * 现在第二次直接被拒（busy），且不影响第一次。
 */
function concurrentChecks() {
  var ext = createExt(false);
  var second = null;

  return new Promise(function (resolve) {
    var settled = 0;
    function done() { if (++settled === 2) resolve(); }

    ext.send({ type: "REFRESH_CAPTURES", agentId: "workbuddy", ephemeral: false }, function (r) {
      ok("并发：第一次仍然成功", !!(r && r.ok), r);
      ok("并发：第一次的探针完整落库（没被第二次覆盖）",
        !!(ext.mem[KEY].agents.workbuddy.probe && ext.mem[KEY].agents.workbuddy.probe.outcome),
        ext.mem[KEY].agents.workbuddy.probe);
      ok("并发：hookActive 保持 true",
        ext.mem[KEY].agents.workbuddy.hookActive === true, ext.mem[KEY].agents.workbuddy.hookActive);
      done();
    });

    // 第一次刚进等待窗口时插进来的第二次
    ext.send({ type: "REFRESH_CAPTURES", agentId: "workbuddy", ephemeral: false }, function (r) {
      second = r;
      ok("并发：第二次被拒（不进入刷新流程）", !!(r && r.ok === false && r.busy === true), r);
      ok("并发：第二次给的是人话原因", /还没结束/.test(String(r && r.error)), r && r.error);
      ok("并发：第二次没有动内存里的探针", !!(ext.ctx.probeMem && ext.ctx.probeMem.workbuddy),
        ext.ctx.probeMem && Object.keys(ext.ctx.probeMem));
      done();
    });

    // 让第一次正常收尾（不然要等满 12 秒）
    setTimeout(function () {
      ext.send({
        type: "CAPTURED",
        entry: {
          url: API, method: "GET", status: 200,
          requestHeaderNames: ["content-type"], body: BODY, via: "fetch",
          origin: "https://www.workbuddy.cn", pageUrl: PAGE
        }
      });
    }, 300);
  });
}

/**
 * 场景 3b：代发返回 401 = 页面没有登录态。标签页必须留着并切到前台
 * （口径与直读的 failDirect 一致），诊断直接说没登录，不能掉进
 * 「页面一个接口响应都没发」的计数推断；批次一个都不能写。
 */
function needLoginChecks() {
  var FAIL401 = {
    ok: true, status: 401, finalUrl: API, contentType: "application/json",
    body: JSON.stringify({ code: 401, msg: "unauthorized" }),
    bodyBytes: 34, truncated: false, tokenFound: true
  };
  var ext = createExt(false, true, [FAIL401]);
  return new Promise(function (resolve) {
    ext.send({ type: "REFRESH_CAPTURES", agentId: "workbuddy", ephemeral: false }, function (r) {
      resolve({ r: r, mem: ext.mem, tabs: ext.tabs, ctx: ext.ctx });
    });
  }).then(function (o) {
    var probe = o.mem[KEY].agents.workbuddy.probe;
    ok("未登录：刷新失败", !!(o.r && o.r.ok === false), o.r);
    ok("未登录：结果标 needLogin 且标签页留着",
      !!(o.r && o.r.needLogin === true && o.r.tabLeftOpen === true), o.r);
    ok("未登录：标签页没有被关掉", o.tabs.removed.length === 0, o.tabs.removed);
    ok("未登录：页面被切到前台", o.tabs.fg === 1, o.tabs.fg);
    ok("未登录：探针 outcome 记为 auth", !!(probe && probe.outcome === "auth"),
      probe && probe.outcome);
    ok("未登录：诊断直接说没有登录态并给出下一步",
      /没有登录态/.test(String(o.r && o.r.diagnosis)) && /登录后再点/.test(String(o.r && o.r.diagnosis)),
      o.r && o.r.diagnosis);
    var v = o.ctx.CreditDiagnose.verdict(probe);
    ok("未登录：标题判定为失败（不说读到）", !!(v && v.ok === false), v);
    ok("未登录：lastError 写入面板",
      /没有登录态/.test(String(o.mem[KEY].agents.workbuddy.lastError || "")),
      o.mem[KEY].agents.workbuddy.lastError);
    ok("未登录：绝不写空批次", (o.mem[KEY].batches || []).length === 0, o.mem[KEY].batches);
  });
}

/**
 * 场景 3c：隐藏页代发失败（接口侧错误）时，老的两轮兜底必须还在：
 * 可见页等页面自己发 → 等不到就在可见页里再代发一次（both-failed，决策 24）。
 * 隐藏页要被关掉，成功后代发所在的可见页也要关掉。
 */
function bothFailedFallbackChecks() {
  var ext = createExt(false, true, [{ ok: false, error: "接口侧错误" }]);
  return new Promise(function (resolve) {
    ext.send({ type: "REFRESH_CAPTURES", agentId: "workbuddy", ephemeral: false }, function (r) {
      resolve({ r: r, mem: ext.mem, tabs: ext.tabs });
    });
  }).then(function (o) {
    ok("兜底代发：隐藏代发失败后，可见页代发成功",
      !!(o.r && o.r.ok && o.r.fallback && o.r.fallback.ok), o.r);
    ok("兜底代发：outcome 仍是 both-failed",
      o.mem[KEY].agents.workbuddy.probe.outcome === "both-failed",
      o.mem[KEY].agents.workbuddy.probe && o.mem[KEY].agents.workbuddy.probe.outcome);
    ok("兜底代发：批次写入 3 笔",
      (o.mem[KEY].batches || []).length === 3, (o.mem[KEY].batches || []).length);
    ok("兜底代发：诊断接上代发结果", /代发/.test(String(o.r && o.r.diagnosis)), o.r && o.r.diagnosis);
    ok("兜底代发：两个标签页都已关闭",
      o.tabs.created.length === 2 && o.tabs.removed.length === 2,
      { created: o.tabs.created.length, removed: o.tabs.removed.length });
  });
}

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

/**
 * 场景 8：LobsterAI 的「刷新后说没变化，但和后台对不上」。
 *
 * 真机症状：卡片「可用」2115.98，后台 1984.64，差的 131.35 正好是 5 笔
 * 已经从 creditItems 里消失的批次；每次点刷新又都报「数字无变化」。
 *
 * 这条链路横跨三处接线，单测各自都过：
 *   1. pickCapture 要选到**新**样本（余额变少 → 额度字段变少 → 分数反而更低）
 *   2. runSync 要把样本来源（via）带出来
 *   3. syncOne 只对「活读 + adapter 标了 authoritative」的平台关批次
 */
function goneChecks() {
  var LIM = "https://lobsterai-server.youdao.com/api/user/profile-summary";
  var PAGE2 = "https://lobsterai.youdao.com/portal#/profile";
  var mem = {}, listeners = [];
  var chrome = {
    runtime: {
      lastError: null,
      getURL: function (p) { return "chrome-extension://test/" + p; },
      onMessage: { addListener: function (fn) { listeners.push(fn); }, removeListener: function () {} },
      onInstalled: { addListener: function () {} },
      onStartup: { addListener: function () {} }
    },
    action: { onClicked: { addListener: function () {} } },
    storage: {
      local: {
        get: function (k) { return Promise.resolve(mem[k] ? (function () { var o = {}; o[k] = JSON.parse(JSON.stringify(mem[k])); return o; })() : {}); },
        set: function (o) { Object.keys(o).forEach(function (k) { mem[k] = JSON.parse(JSON.stringify(o[k])); }); return Promise.resolve(); },
        remove: function (k) { delete mem[k]; return Promise.resolve(); }
      },
      onChanged: { addListener: function () {}, removeListener: function () {} }
    },
    tabs: {
      create: function () { return Promise.resolve({ id: 1 }); },
      get: function () { return Promise.resolve({ status: "complete", url: PAGE2 }); },
      remove: function () { return Promise.resolve(); }
    },
    scripting: {
      registerContentScripts: function () { return Promise.resolve(); },
      unregisterContentScripts: function () { return Promise.resolve(); },
      executeScript: function () { return Promise.resolve([{ result: null }]); }
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
      vm.runInContext(fs.readFileSync(path.join(ROOT, arguments[i]), "utf8"), ctx, { filename: arguments[i] });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx, { filename: "background.js" });

  function body(items) {
    return JSON.stringify({
      code: 0, message: "success",
      data: {
        id: 1, nickname: "u",
        totalCreditsRemaining: items.reduce(function (s, i) { return s + i.creditsRemaining; }, 0),
        creditItems: items
      }
    });
  }
  function item(remaining, expiresAt) {
    return { type: "campaign", label: "每日登录奖励", labelEn: "Daily Login Reward",
      creditsRemaining: remaining, expiresAt: expiresAt };
  }
  // 8 笔 → 1 笔：花完的那 7 笔平台不再返回。
  // 笔数变少 → 响应里的额度字段也跟着变少 → 启发式分数从 9 掉到 4（没有两个以上日期，连日期分都拿不到）。
  // 这正是"按分数选样本"会永远选回旧样本的原因，所以断言必须钉住分数是反的。
  function days(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(item(100, "2027-03-" + ("0" + (9 + i * 2)).slice(-2) + "T09:12:44"));
    return out;
  }
  var fat = body(days(8));
  var thin = body(days(1));
  function cap(b, at) {
    return { agentId: "lobsterai", url: LIM, method: "GET", status: 200,
      score: 0, at: at, bodyPreview: b, bodyLength: b.length, truncated: false, via: "fetch" };
  }
  // 分数用真实打分器算，别手写：这里要证的就是「新样本分数更低」
  var c8 = cap(fat, "2027-03-01T00:00:00.000Z"), c1 = cap(thin, "2027-03-02T00:00:00.000Z");
  c8.score = ctx.CreditAgents.scoreCapture(LIM, fat).score;
  c1.score = ctx.CreditAgents.scoreCapture(LIM, thin).score;

  mem[KEY] = {
    schema: 1, batches: [], captures: [c8],
    agents: { lobsterai: { id: "lobsterai", name: "LobsterAI", unit: "credits",
      origin: "https://lobsterai.youdao.com", consoleUrl: PAGE2,
      fetchMode: "capture", hookActive: false, endpoint: LIM, enabled: true } },
    settings: { threshold: 14, staleDays: 7, lazySyncDays: 3 }, lastSyncAt: null, ui: {}
  };

  function sync() {
    return new Promise(function (res) {
      listeners.forEach(function (fn) { fn({ type: "SYNC", agentId: "lobsterai" }, {}, res); });
    });
  }

  return sync().then(function (r) {
    ok("批次消失：第一次同步写入 8 笔", !!(r && r.ok) && mem[KEY].batches.length === 8,
      { ok: r && r.ok, n: mem[KEY].batches.length });
    ok("批次消失：新样本分数确实更低（旧 9 → 新 4）", c1.score < c8.score, { old: c8.score, now: c1.score });
    // 第二份样本入库，平台少返回了 7 笔
    return ctx.CreditStore.update(function (d) { d.captures.push(c1); });
  }).then(function () {
    return sync();
  }).then(function (r) {
    ok("批次消失：同步成功", !!(r && r.ok), r);
    ok("批次消失：选中的是**新**样本（少 7 笔）", r && r.updated === 0 && r.closed === 7,
      { updated: r && r.updated, closed: r && r.closed, added: r && r.added });
    var closed = mem[KEY].batches.filter(function (b) { return b.closed; });
    ok("批次消失：消失的 7 笔被关掉", closed.length === 7, closed.map(function (b) { return b.expiresAt; }));
    ok("批次消失：不删历史", mem[KEY].batches.length === 8, mem[KEY].batches.length);
    var live = mem[KEY].batches.filter(function (b) { return !b.closed; })
      .reduce(function (s, b) { return s + b.remaining; }, 0);
    ok("批次消失：余额重新对上后台（100，不是 800）", live === 100, live);
    // 粘贴样本不能用来关批次：它是历史快照
    return ctx.CreditStore.update(function (d) {
      d.captures.push(Object.assign({}, cap(thin, "2027-03-03T00:00:00.000Z"), { via: "paste" }));
      d.batches.forEach(function (b) { delete b.closed; delete b.closedAt; });
      d.captures = d.captures.filter(function (c) { return c !== c1; });
    });
  }).then(function () {
    return sync();
  }).then(function (r) {
    ok("绑定：粘贴样本不按权威口径关批次", r && r.closed === 0, r && r.closed);
  });
}
