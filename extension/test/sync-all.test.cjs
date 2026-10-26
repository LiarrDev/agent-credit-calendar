/*
 * test/sync-all.test.cjs — 全局「立即同步」对「钩子已解除」平台的处理（v0.3.19）。
 *
 * 背景：以前 syncAll 只对 hookActive 为真的平台做活体刷新，解除过钩子的平台
 * 直接拿旧样本算，结果是「点了一次同步，只有 Qoder/TRAE 真的去查了余额」。
 * v0.3.19 起，显式点「立即同步」= 用户此刻要活数据，所以未挂钩平台会**临时**
 * 装一次钩子（读完立刻注销，hookActive 保持 false）。
 *
 * 这里钉住三件事：
 *   1. 未挂钩平台会被临时抓取，且抓完钩子确实注销、hookActive 不被改写；
 *   2. 常驻钩子平台仍走原路径（结果不标 ephemeral，hookActive 保持 true）；
 *   3. 临时抓取失败（401）时同步仍照常跑，退回旧样本，绝不写空批次。
 *
 * 做法与 e2e-refresh 相同：mock chrome.*，在 vm 里加载真实 background.js，
 * 走不带 agentId 的 SYNC 消息。
 */
var vm = require("vm"), fs = require("fs"), path = require("path");

var ROOT = path.join(__dirname, "..");
var KEY = "credit-calendar-v1";
var WB_PAGE = "https://www.workbuddy.cn/profile/plans-usage";
var WB_API = "https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages";
var QODER_PAGE = "https://qoder.com/account/usage";
var QODER_API = "https://qoder.com/api/v2/me/usages/big_model_credits";

var pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log("ok   " + label); }
  else { fail++; console.log("FAIL " + label + (extra !== undefined ? "  => " + JSON.stringify(extra) : "")); }
}

function wbAccount(i) {
  return {
    PackageName: "CodeBuddy个人版国内运营裂变包",
    ResourceId: "res-sync-" + i, AccountId: "acct-" + i, DealName: "deal-" + i,
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
function wbBody(n) {
  var list = [];
  for (var i = 1; i <= n; i++) list.push(wbAccount(i));
  return JSON.stringify({ code: 0, msg: "OK", data: { TotalCount: n, Accounts: list } });
}

var QODER_BODY = JSON.stringify({
  plan_quota: { quota_detail: [] },
  resource_package_quota: {
    quota_detail: [{
      id: "pkg-0001", limit_value: 1000, remaining_value: 600, unit: "credits",
      source: "RESOURCE_PACKAGE_SOURCE_BONUS",
      expires_at: Date.parse("2026-11-02T00:00:00Z")
    }]
  },
  dedicated_resource_package_quota: { quota_detail: [] }
});

function sendResult(body, status) {
  return {
    ok: true, status: status || 200, finalUrl: "",
    contentType: "application/json", body: body, bodyBytes: body.length,
    truncated: false, tokenFound: true
  };
}

/**
 * seed：预置存储；wbStatus：WorkBuddy 代发返回的 HTTP 状态（默认 200）。
 * executeScript 按目标标签页的 URL 分派响应——Qoder 直读与 WorkBuddy 代发
 * 都会走同一条 chrome.scripting 通道。
 */
function createExt(seed, wbStatus) {
  var mem = {}, onChanged = [], listeners = [], tabSeq = 1000;
  var tabUrl = {};
  var log = { registered: [], unregistered: [], created: [], removed: [], fg: 0 };

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
            var changes = {}; changes[k] = { newValue: JSON.parse(JSON.stringify(o[k])) };
            setTimeout(function () { onChanged.slice().forEach(function (fn) { fn(changes, "local"); }); }, 0);
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
      registerContentScripts: function (scripts) {
        log.registered.push(scripts.map(function (s) { return s.id; }));
        return Promise.resolve();
      },
      unregisterContentScripts: function (o) {
        if (o && o.ids) log.unregistered.push(o.ids.slice());
        return Promise.resolve();
      },
      executeScript: function (opts) {
        var url = tabUrl[opts && opts.target && opts.target.tabId] || "";
        if (url.indexOf("qoder.com") >= 0) return Promise.resolve([{ result: sendResult(QODER_BODY) }]);
        if (wbStatus === 401) {
          return Promise.resolve([{ result: sendResult(JSON.stringify({ code: 401 }), 401) }]);
        }
        return Promise.resolve([{ result: sendResult(wbBody(3)) }]);
      }
    },
    tabs: {
      create: function (o) {
        tabSeq++;
        tabUrl[tabSeq] = o.url;
        log.created.push({ id: tabSeq, active: !!o.active, url: o.url });
        return Promise.resolve({ id: tabSeq, url: o.url, active: !!o.active });
      },
      get: function (id) {
        return Promise.resolve({ id: id, status: "complete", url: tabUrl[id] || WB_PAGE });
      },
      remove: function (id) { log.removed.push(id); return Promise.resolve(); },
      update: function (id, props) {
        if (props && props.active) log.fg++;
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
  sandbox.importScripts = function () {
    for (var i = 0; i < arguments.length; i++) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, arguments[i]), "utf8"), ctx, { filename: arguments[i] });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx, { filename: "background.js" });

  if (seed) mem[KEY] = JSON.parse(JSON.stringify(seed));

  function sync() {
    return new Promise(function (resolve) {
      listeners.forEach(function (fn) { fn({ type: "SYNC" }, {}, resolve); });
    });
  }

  return { mem: mem, log: log, sync: sync };
}

function seedWith(wbHookActive, captures) {
  return {
    schema: 1, batches: [], captures: captures || [],
    agents: {
      workbuddy: {
        id: "workbuddy", name: "WorkBuddy", unit: "credits",
        origin: "https://www.workbuddy.cn", consoleUrl: WB_PAGE,
        fetchMode: "capture", hookActive: wbHookActive, endpoint: null, enabled: true
      }
    },
    settings: { threshold: 14, staleDays: 7, lazySyncDays: 3 },
    lastSyncAt: null, ui: {}
  };
}

function resultOf(r, agentId) {
  return ((r && r.results) || []).filter(function (x) { return x.agentId === agentId; })[0] || null;
}

function main() {
  console.log("--- 场景 1：钩子已解除的平台，显式同步会临时抓一次");
  var ext = createExt(seedWith(false));
  return ext.sync().then(function (r) {
    var wb = resultOf(r, "workbuddy");
    ok("临时抓取：同步成功", !!(r && r.ok), r);
    ok("临时抓取：workbuddy 这次读到了活数据", !!(wb && wb.fresh === true), wb);
    ok("临时抓取：结果标明是临时钩子", !!(wb && wb.ephemeral === true), wb);
    ok("临时抓取：同步后 hookActive 仍为 false（不偷偷常驻）",
      ext.mem[KEY].agents.workbuddy.hookActive === false, ext.mem[KEY].agents.workbuddy.hookActive);
    ok("临时抓取：只开隐藏页并都已关闭",
      ext.log.created.length === 2 && ext.log.created.every(function (t) { return !t.active; })
        && ext.log.removed.length === 2,
      { created: ext.log.created, removed: ext.log.removed });
    var wbRegs = ext.log.registered.filter(function (ids) { return ids.join(",").indexOf("workbuddy") >= 0; });
    var wbUnregs = ext.log.unregistered.filter(function (ids) { return ids.join(",").indexOf("workbuddy") >= 0; });
    ok("临时抓取：workbuddy 钩子注册过、读完又注销",
      wbRegs.length === 1 && wbUnregs.length >= 2, { regs: wbRegs, unregs: wbUnregs });
    var wbBatches = (ext.mem[KEY].batches || []).filter(function (b) { return b.agent === "workbuddy"; });
    ok("临时抓取：日历写入 3 笔 workbuddy 批次", wbBatches.length === 3, wbBatches.length);
    ok("临时抓取：样本库收到新样本",
      (ext.mem[KEY].captures || []).some(function (c) {
        return c.agentId === "workbuddy" && c.url === WB_API;
      }), (ext.mem[KEY].captures || []).length);
    var q = resultOf(r, "qoder");
    ok("临时抓取：Qoder 直读路径不受影响", !!(q && q.direct && q.fresh === true && !q.ephemeral), q);

    console.log("--- 场景 2：常驻钩子的平台保持原路径");
    var ext2 = createExt(seedWith(true));
    return ext2.sync().then(function (r2) {
      var wb2 = resultOf(r2, "workbuddy");
      ok("常驻钩子：仍读到活数据", !!(wb2 && wb2.fresh === true), wb2);
      ok("常驻钩子：结果不标 ephemeral", !!(wb2 && !wb2.ephemeral), wb2);
      ok("常驻钩子：同步后 hookActive 保持 true",
        ext2.mem[KEY].agents.workbuddy.hookActive === true,
        ext2.mem[KEY].agents.workbuddy.hookActive);

      console.log("--- 场景 3：临时抓取失败（401）仍用旧样本完成同步");
      var old = {
        agentId: "workbuddy", url: WB_API, method: "POST", status: 200,
        score: 9, at: "2026-10-01T00:00:00.000Z",
        bodyPreview: wbBody(2), bodyLength: wbBody(2).length,
        truncated: false, via: "fetch"
      };
      var ext3 = createExt(seedWith(false, [old]), 401);
      return ext3.sync().then(function (r3) {
        var wb3 = resultOf(r3, "workbuddy");
        var batches = (ext3.mem[KEY].batches || []).filter(function (b) { return b.agent === "workbuddy"; });
        ok("失败回退：workbuddy 刷新失败但同步本身成功", !!(wb3 && wb3.ok === true), wb3);
        ok("失败回退：结果如实标 fresh=false 并给出原因",
          !!(wb3 && wb3.fresh === false && /没有登录态/.test(String(wb3.refreshError))), wb3);
        ok("失败回退：未登录页面被保留并切到前台",
          ext3.log.fg >= 1 && ext3.log.removed.length === 1,
          { fg: ext3.log.fg, removed: ext3.log.removed, created: ext3.log.created });
        ok("失败回退：旧样本照常算出 2 笔批次", batches.length === 2, batches.length);
        ok("失败回退：hookActive 仍是 false", ext3.mem[KEY].agents.workbuddy.hookActive === false,
          ext3.mem[KEY].agents.workbuddy.hookActive);
      });
    });
  });
}

main().then(function () {
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}, function (e) {
  console.log("FAIL 测试异常：" + (e && e.stack || e));
  console.log("\n" + pass + " passed, " + (fail + 1) + " failed");
  process.exit(1);
});
