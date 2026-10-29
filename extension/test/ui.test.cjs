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
    var html = "";
    return {
      _sel: sel, _writes: 0, textContent: "", value: "", disabled: false, files: null,
      get innerHTML() { return html; },
      set innerHTML(value) { html = value; this._writes++; },
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

function createUi(seed, now) {
  var mem = {}, onChanged = [], reloaded = 0, intervals = [];
  var dom = createDom(), clock = now == null ? null : new Date(now).getTime();
  // 到期边界用可推进的本地时钟，不等真实分钟，也不依赖运行测试当天的日期。
  var UiDate = clock == null ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  var sandbox = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    chrome: createChrome(mem, onChanged),
    document: dom.document,
    location: { reload: function () { reloaded++; } },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function (fn, ms) { intervals.push({ fn: fn, ms: ms }); return intervals.length; },
    clearInterval: function (id) { intervals[id - 1] = null; },
    Date: UiDate, JSON: JSON, Math: Math, URL: URL, Blob: Blob, navigator: { userAgent: "test" },
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
  // 种子必须在加载脚本**之前**放进存储：calendar.js 末尾直接调 boot()，
  // 而 chrome.storage.local.get 是同步取快照的（真浏览器里也是立刻发请求），
  // 放到后面再塞就会渲染出一份空文档。
  if (seed) mem[KEY] = seed;
  ["lib/agents.js", "lib/normalize.js", "lib/diagnose.js", "lib/store.js", "ui/calendar.js"].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  });
  return {
    ctx: ctx, mem: mem, el: dom.el, deletes: deletes, reloaded: function () { return reloaded; },
    intervals: intervals,
    setNow: function (value) { clock = new Date(value).getTime(); },
    tick: function () { intervals.forEach(function (t) { if (t) t.fn(); }); }
  };
}

function seedDoc(schema) {
  return {
    schema: schema || 1, batches: [], captures: [],
    agents: { qoder: { id: "qoder", fetchMode: "direct", origin: "https://qoder.com", enabled: true } },
    settings: { threshold: 14, staleDays: 7, lazySyncDays: 3 },
    lastSyncAt: null, ui: {}
  };
}

function booted(ext) {
  // boot() 是异步的（Store.load → render），等两个 tick 足够
  return new Promise(function (res) { setTimeout(res, 30); }).then(function () { return ext; });
}

function expiryBatch(id, day, instant, agent) {
  return {
    batchId: id, agent: agent || "qoder", label: id, unit: "credits", granted: 100, remaining: 100,
    expiresAt: day, resetInstant: instant ? new Date(instant).toISOString() : null,
    source: "auto", capturedAt: "2026-10-22T08:00:00.000Z"
  };
}
function rowIds(html) {
  return Array.from(html.matchAll(/data-bid="([^"]+)"/g), function (m) { return m[1]; });
}
function clickAct(ext, container, act, id) {
  var target = { getAttribute: function (name) { return name === "data-act" ? act : name === "data-id" ? id : null; } };
  ext.el(container).onclick({ target: { closest: function (s) { return s === "[data-act]" ? target : null; } } });
}
function editField(ext, name, value) {
  var el = ext.el('#detail [data-f="' + name + '"]');
  el.value = value;
  el.getAttribute = function (attr) { return attr === "data-f" ? name : null; };
  return el;
}
function dayHtml(ext, day) {
  return (ext.el("#grid").innerHTML.split('data-day="' + day + '"')[1] || "").split('<div class="cell')[0];
}
function clickDay(ext, day, entries, out) {
  var cell = {
    getAttribute: function (attr) { return attr === "data-day" ? day : null; },
    classList: { contains: function (cls) { return cls === "out" && out; } }
  };
  ext.el("#grid").onclick({ target: { closest: function (s) {
    return s === ".cell" ? cell : s === ".entries" && entries ? {} : null;
  } } });
}
function clickBatch(ext, container, id) {
  var row = { getAttribute: function (attr) { return attr === "data-bid" ? id : null; } };
  ext.el(container).onclick({ target: { closest: function (s) { return s === "[data-bid]" ? row : null; } } });
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
  /* ---------- 4. 「已不在后台返回」不计入余额（v0.3.17） ----------
   * 真机症状：卡片写着「可用 2115」，平台后台只有 1984，差的是 5 笔已经消失的批次。
   * 这里钉住三件事：卡片余额不含它们、卡片上要说出来、日历/即将到期不画它们。
   */
  var day = function (n) {
    var d = new Date(); d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  };
  var seed = seedDoc();
  seed.agents.lobsterai = { id: "lobsterai", fetchMode: "capture", origin: "https://lobsterai.youdao.com", enabled: true };
  seed.batches = [
    { agent: "lobsterai", label: "在的 A", unit: "credits", granted: 500, remaining: 500,
      expiresAt: day(20), batchId: "lob-a", capturedAt: new Date().toISOString(), source: "auto" },
    { agent: "lobsterai", label: "在的 B", unit: "credits", granted: 100, remaining: 100,
      expiresAt: day(25), batchId: "lob-b", capturedAt: new Date().toISOString(), source: "auto" },
    { agent: "lobsterai", label: "消失的 C", unit: "credits", granted: 100, remaining: 100,
      expiresAt: day(15), batchId: "lob-c", capturedAt: new Date().toISOString(), source: "auto",
      closed: true, closedAt: new Date().toISOString(), absentCount: 3 }
  ];
  var ui2 = createUi(seed);
  return booted(ui2).then(function (ext) {
    var cards = ext.el("#cards").innerHTML;
    // 按 data-agent 切卡片：卡片上显示的是 "LobsterAI"，和 agent id 不同名
    var seg = cards.split('<div class="card"')
      .filter(function (s) { return s.indexOf('data-agent="lobsterai"') >= 0; })[0] || "";
    ok("卡片余额不含已消失的批次（500+100，不是 700）", seg.indexOf("600") >= 0, seg.slice(0, 260));
    ok("卡片上没有把消失的 100 算进余额", seg.indexOf("可用") >= 0 && seg.indexOf("700") < 0, seg.slice(0, 260));
    ok("卡片上明说「已不在后台返回」", seg.indexOf("已不在后台返回") >= 0, seg.slice(0, 400));
    ok("「即将到期」不列已消失的批次",
      ext.el("#upcoming").innerHTML.indexOf("消失的 C") < 0, ext.el("#upcoming").innerHTML.slice(0, 300));
    ok("月历不画已消失的批次", ext.el("#grid").innerHTML.indexOf("消失的 C") < 0);
  });
}).then(function () {
  /* ---------- 5. 「已不在后台返回」的详情面板 ----------
   * 面板靠 doc.ui.wasted 恢复（'<agent>|gone'）。旧文档里存的是不带后缀的
   * '<agent>'，那种值必须继续打开「已过期未用完」，不能被新编码带歪。
   */
  var day2 = function (n) {
    var d = new Date(); d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  };
  function seedWithPanel(wasted) {
    var s = seedDoc();
    s.agents.lobsterai = { id: "lobsterai", name: "LobsterAI", fetchMode: "capture", enabled: true };
    s.ui = { wasted: wasted };
    s.batches = [
      { agent: "lobsterai", label: "消失的 C", unit: "credits", granted: 100, remaining: 100,
        expiresAt: day2(15), batchId: "lob-c", capturedAt: new Date().toISOString(), source: "auto",
        closed: true, closedAt: new Date().toISOString() },
      { agent: "lobsterai", label: "过期作废的 D", unit: "credits", granted: 50, remaining: 50,
        expiresAt: day2(-3), batchId: "lob-d", capturedAt: new Date().toISOString(), source: "auto" }
    ];
    return s;
  }
  var goneUi = createUi(seedWithPanel("lobsterai|gone"));
  return booted(goneUi).then(function (ext) {
    var d = ext.el("#detail").innerHTML;
    ok("详情面板：打开「已不在后台返回」", d.indexOf("已不在后台返回") >= 0, d.slice(0, 200));
    ok("详情面板：列出消失的那笔", d.indexOf("消失的 C") >= 0, d.slice(0, 300));
    ok("详情面板：不把过期作废的那笔混进来", d.indexOf("过期作废的 D") < 0, d.slice(0, 300));
    return booted(createUi(seedWithPanel("lobsterai")));
  }).then(function (ext) {
    var d = ext.el("#detail").innerHTML;
    ok("详情面板：旧文档里的旧编码仍打开「已过期未用完」", d.indexOf("已过期未用完") >= 0, d.slice(0, 200));
    ok("详情面板：旧编码不会误开「已不在后台返回」", d.indexOf("已不在后台返回") < 0, d.slice(0, 200));
  });
}).then(function () {
  /* ---------- 6. 「立即同步」的临时钩子提示（v0.3.19） ----------
   * 钩子已解除的平台现在也会被同步临时抓一次。提示必须说清楚「临时装钩子、
   * 读完已注销」，否则用户会以为扩展又把钩子常驻装回去了。
   */
  var ui3 = createUi(seedDoc());
  return booted(ui3).then(function (ext) {
    // toast 队列靠 setTimeout 逐条排队；这里把长延时改成同步执行，直接看最后一条。
    var realSetTimeout = ext.ctx.setTimeout;
    ext.ctx.setTimeout = function (fn, ms) {
      if (ms >= 2600) { fn(); return 0; }
      return realSetTimeout(fn, ms);
    };
    ext.ctx.chrome.runtime.sendMessage = function (msg, cb) {
      cb({
        ok: true, ran: ["lobsterai"],
        results: [{
          agentId: "lobsterai", ok: true, fresh: true, ephemeral: true,
          added: 1, updated: 0, sampleAt: new Date().toISOString()
        }]
      });
    };
    var btn = ext.el("#sync");
    btn.onclick.call(btn, {});
    return new Promise(function (res) { realSetTimeout(res, 30); }).then(function () {
      var t = ext.el("#toast").textContent;
      ok("同步提示：临时抓取要明说「读完已注销」", t.indexOf("临时装钩子，读完已注销") >= 0, t);
      ok("同步提示：不再把临时抓取说成「没装钩子」", t.indexOf("没装钩子") < 0, t);
      ok("同步提示：按钮已复位", btn.disabled === false && btn.textContent === "立即同步",
        { disabled: btn.disabled, text: btn.textContent });
    });
  });
}).then(function () {
  /* ---------- 7. 四个平台：实际日期、完整时分、同日顺序与精确过期 ---------- */
  var seed = seedDoc(2), day = "2026-10-23";
  var invalid = expiryBatch("invalid", day);
  invalid.resetInstant = "not-a-date";
  var stale = expiryBatch("stale", day, "2026-10-22T09:30:00");
  stale.manualEdited = true; // 手动换过日期，旧时刻不可再用于显示、排序或判过期
  seed.batches = [
    expiryBatch("date-only", day),
    expiryBatch("lobster-time", day, day + "T18:45:12", "lobsterai"),
    expiryBatch("expired", day, day + "T10:30:00"),
    expiryBatch("tomorrow-midnight", "2026-10-24", "2026-10-24T00:00:00"),
    expiryBatch("workbuddy-time", day, day + "T16:07:00", "workbuddy"),
    invalid, stale,
    expiryBatch("qoder-time", day, day + "T13:05:00", "qoder"),
    expiryBatch("trae-time", day, day + "T14:06:00", "trae"),
    expiryBatch("exact-boundary", day, day + "T12:00:00"),
    expiryBatch("yesterday", "2026-10-22"),
    expiryBatch("midnight-expired", day, day + "T00:00:00"),
    expiryBatch("outside-threshold", "2026-11-07"),
    Object.assign(expiryBatch("closed", day), { closed: true })
  ];
  return booted(createUi(seed, day + "T12:00:00")).then(function (ext) {
    var html = ext.el("#upcoming").innerHTML, ids = rowIds(html);
    ["13:05", "14:06", "16:07", "18:45"].forEach(function (hm) {
      ok("即将到期：完整本地日期与时分 " + hm, html.includes(day + " " + hm + " 到期"));
    });
    ok("零点批次显示实际到期日，不减一天", html.includes("2026-10-24 00:00 到期"));
    ok("同日按精确时间排序", JSON.stringify(ids.slice(0, 4)) === JSON.stringify([
      "qoder-time", "trae-time", "workbuddy-time", "lobster-time"
    ]), ids);
    ["date-only", "invalid", "stale"].forEach(function (id) {
      var row = html.split('data-bid="' + id + '"')[1] || "";
      row = row.split('data-bid="')[0];
      ok("未知时间仅显示日期：" + id, /2026-10-23(?:（具体时间未知）)? 到期/.test(row) && !/2026-10-23 \d{2}:\d{2}/.test(row));
      ok("未知时间排同日日末：" + id, ids.indexOf(id) >= 4 && ids.indexOf(id) < ids.indexOf("tomorrow-midnight"), ids);
    });
    ok("已精确过期/恰好到期/超阈值/关闭批次均被剔除", ids.length === 8 && [
      "expired", "exact-boundary", "yesterday", "midnight-expired", "outside-threshold", "closed"
    ].every(function (id) { return !ids.includes(id); }), ids);
    ok("即将到期与卡片使用「今天到期」", html.includes("今天到期") && ext.el("#cards").innerHTML.includes("今天到期")
      && !html.includes("今天最后可用") && !ext.el("#cards").innerHTML.includes("今天最后可用"));
    ok("卡片最近一笔也按精确时间排序", ext.el("#cards").innerHTML.includes("最近一笔 <b>qoder-time</b>"));

    // formatExpiry 的输出仍经过 HTML 转义，不能变成标签。
    var format = ext.ctx.CreditNormalize.formatExpiry;
    ext.ctx.CreditNormalize.formatExpiry = function () { return '<time datetime="x">&</time>'; };
    ext.tick();
    ok("到期格式化结果经过 HTML 转义", ext.el("#upcoming").innerHTML.includes("&lt;time datetime=&quot;x&quot;&gt;&amp;&lt;/time&gt;"));
    ext.ctx.CreditNormalize.formatExpiry = format;
  });
}).then(function () {
  /* ---------- 8. 编辑同日已过期批次；草稿/保存后的日期都不能带旧时间 ---------- */
  var seed = seedDoc(2), day = "2026-10-23";
  var batch = expiryBatch("edit-expired", day, day + "T10:30:00");
  seed.batches = [batch]; seed.ui.edit = batch.batchId;
  return booted(createUi(seed, day + "T12:00:00")).then(function (ext) {
    var html = ext.el("#detail").innerHTML;
    ok("编辑同日已过期：不再显示今天可用/今天到期", html.includes("已过期") && !html.includes("今天到期") && !html.includes("今天最后可用"));
    ok("编辑到期日期标签已更新", html.includes("<label>到期日期</label>") && !html.includes("最后一个可用日"));
    ok("有效元信息显示完整清零时刻", html.includes("实际清零时刻 2026-10-23 10:30"));
    ok("同日过期不显示已过期 0 天", !html.includes("已过期 0 天"));
    ok("日历同日平台全部已过期时降饱和", /class="e dim"[^>]*data-agent="qoder"/.test(ext.el("#grid").innerHTML));

    var fields = [
      editField(ext, "label", batch.label), editField(ext, "expiresAt", "2026-10-24"),
      editField(ext, "remaining", "100"), editField(ext, "granted", "100"), editField(ext, "source", "auto")
    ];
    var date = fields[1], writes = ext.el("#detail")._writes;
    ext.el("#detail").oninput({ target: date });
    ok("修改日期草稿立即隐藏旧时刻", ext.el("#editExpiryMeta").innerHTML === "");
    ok("日期草稿状态不沿用旧过期时刻", ext.el("#editExpiryStatus").innerHTML === "还有 1 天");
    ok("日期草稿更新不重建表单", ext.el("#detail")._writes === writes);
    date.value = day; ext.el("#detail").oninput({ target: date });
    ok("改回原日期才恢复有效时间与过期状态", ext.el("#editExpiryMeta").innerHTML.includes("10:30")
      && ext.el("#editExpiryStatus").innerHTML.includes("已过期"));
    date.value = "2026-10-24";
    ext.ctx.document.querySelectorAll = function (s) { return s === "#detail [data-f]" ? fields : []; };
    clickAct(ext, "#detail", "save");
    return booted(ext).then(function () {
      var saved = ext.mem[KEY].batches[0];
      ok("修改到期日期已保存", saved.expiresAt === "2026-10-24");
      ok("保存后元信息不显示旧清零时刻", !ext.el("#detail").innerHTML.includes("实际清零时刻"));
      ok("保存后即将到期仅显示新日期", /2026-10-24(?:（具体时间未知）)? 到期/.test(ext.el("#upcoming").innerHTML)
        && !ext.el("#upcoming").innerHTML.includes("10:30"));
    });
  });
}).then(function () {
  // 直接读取已编辑的旧文档也不能显示不匹配/无效的 resetInstant。
  return Promise.all(["2026-10-22T09:30:00", "invalid"].map(function (instant) {
    var seed = seedDoc(2), b = expiryBatch("old-time", "2026-10-23");
    b.resetInstant = instant === "invalid" ? instant : new Date(instant).toISOString();
    b.manualEdited = true;
    seed.batches = [b]; seed.ui.edit = b.batchId;
    return booted(createUi(seed, "2026-10-23T12:00:00")).then(function (ext) {
      ok("旧文档无效元信息不显示：" + instant, !ext.el("#detail").innerHTML.includes("实际清零时刻")
        && ext.el("#detail").innerHTML.includes("今天到期"));
    });
  }));
}).then(function () {
  var seed = seedDoc(2), b = expiryBatch("time-conflict", "2026-10-23", "2026-10-23T13:05:00");
  b.manualEdited = true; b.conflict = true;
  b.scraped = { label: b.label, remaining: 100, granted: 100, expiresAt: b.expiresAt,
    resetInstant: new Date("2026-10-23T14:06:00").toISOString(), capturedAt: b.capturedAt };
  seed.batches = [b]; seed.ui.edit = b.batchId;
  return booted(createUi(seed, "2026-10-23T12:00:00")).then(function (ext) {
    var html = ext.el("#detail").innerHTML;
    ok("时间冲突显示两份完整日期时分", html.includes("2026-10-23 13:05 到期") && html.includes("2026-10-23 14:06 到期"));
  });
}).then(function () {
  /* ---------- 9. 每分钟局部刷新：跨到期时刻/午夜且不打断输入和加载态 ---------- */
  var seed = seedDoc(2), day = "2026-10-23";
  seed.batches = [
    Object.assign(expiryBatch("timer-exact", day, day + "T12:00:00"), { remaining: 40 }),
    Object.assign(expiryBatch("timer-date", day), { remaining: 60 }),
    expiryBatch("timer-tomorrow", "2026-10-24")
  ];
  seed.ui.edit = "timer-exact";
  return booted(createUi(seed, day + "T11:59:00")).then(function (ext) {
    ok("仅注册一个每分钟刷新定时器", ext.intervals.length === 1 && ext.intervals[0].ms === 60000);
    ok("到期前精确批次仍在即将到期", rowIds(ext.el("#upcoming").innerHTML).includes("timer-exact"));
    var date = editField(ext, "expiresAt", day), label = editField(ext, "label", "尚未保存的名称");
    var detailWrites = ext.el("#detail")._writes, footWrites = ext.el("#foot")._writes;
    var sync = ext.el("#sync"); sync.onclick.call(sync); // sendMessage 不回调，模拟同步中
    ext.el("#btnAuth").onclick();
    var authWrites = ext.el("#authBody")._writes;
    var url = ext.el('[data-url="qoder"]'); url.value = "https://example.test/unfinished";
    ext.ctx.document.activeElement = url;
    var refresh = ext.el('[data-act="reauth"][data-id="qoder"]');
    refresh.disabled = true; refresh.textContent = "刷新中…";
    ext.setNow(day + "T12:00:00"); ext.tick();
    ok("到期时无需存储事件即从 upcoming 剔除", !rowIds(ext.el("#upcoming").innerHTML).includes("timer-exact"));
    ok("到期时余额与过期统计更新", ext.el("#cards").innerHTML.includes('class="balance">160<span')
      && ext.el("#cards").innerHTML.includes("已过期未用完"));
    ok("编辑中状态也随时刻变成已过期", ext.el("#editExpiryStatus").innerHTML.includes("已过期"));
    ok("定时器不重建编辑表单、不覆盖草稿", ext.el("#detail")._writes === detailWrites && label.value === "尚未保存的名称");
    ok("定时器保留授权输入和焦点", ext.el("#authBody")._writes === authWrites
      && url.value === "https://example.test/unfinished" && ext.ctx.document.activeElement === url);
    ok("定时器保留同步与平台刷新加载态", sync.disabled && sync.textContent === "同步中…"
      && refresh.disabled && refresh.textContent === "刷新中…");
    ok("定时器不重画页脚确认/文件输入", ext.el("#foot")._writes === footWrites);

    date.value = "2026-10-24"; ext.el("#detail").oninput({ target: date });
    ext.setNow("2026-10-24T00:00:00"); ext.tick();
    ok("跨午夜重新计算 TODAY 并剔除日期-only 旧批次", JSON.stringify(rowIds(ext.el("#upcoming").innerHTML)) === '["timer-tomorrow"]');
    ok("跨午夜更新日历今天标记", /data-day="2026-10-24"><div class="dnum"><span class="td">今天/.test(ext.el("#grid").innerHTML));
    ok("跨午夜仍以草稿日期显示到期状态，不恢复旧时间", ext.el("#editExpiryStatus").innerHTML.includes("今天到期")
      && ext.el("#editExpiryMeta").innerHTML === "" && ext.el("#detail")._writes === detailWrites);

    // 粘贴授权样本中的 textarea 也不能被定时器重画。
    clickAct(ext, "#authBody", "paste", "qoder");
    var pasteWrites = ext.el("#authBody")._writes, paste = ext.el("#pasteBody");
    paste.value = '{"unfinished":'; ext.ctx.document.activeElement = paste;
    ext.tick();
    ok("定时器保留授权样本输入", ext.el("#authBody")._writes === pasteWrites && paste.value === '{"unfinished":');
    ext.el("#closeAuth").onclick();
    clickAct(ext, "#detail", "add");
    var addWrites = ext.el("#detail")._writes, addLabel = ext.el('#detail [data-nf="label"]');
    addLabel.value = "补录草稿"; ext.tick();
    ok("定时器保留补录表单", ext.el("#detail")._writes === addWrites && addLabel.value === "补录草稿");
  });
}).then(function () {
  var html = fs.readFileSync(path.join(ROOT, "ui/calendar.html"), "utf8");
  var options = html.match(/<select id="thr">([\s\S]*?)<\/select>/)[1];
  ok("阈值选项包含 3/7/14/30 天", Array.from(options.matchAll(/value="(\d+)"/g), function (m) { return m[1]; }).join(",") === "3,7,14,30");
  ok("HTML 默认选中 3 天", /value="3" selected/.test(options) && (options.match(/selected/g) || []).length === 1);
  return booted(createUi(null, "2026-10-23T12:00:00")).then(function (ext) {
    ok("无存储时默认阈值为 3 天", ext.el("#thr").value === "3");
    ok("空列表文案使用 3 天", ext.el("#upcoming").innerHTML.includes("未来 3 天内无积分到期"));
  });
}).then(function () {
  var seed = seedDoc(2);
  delete seed.settings.threshold;
  seed.batches = ["2026-10-23", "2026-10-26", "2026-10-27", "2026-10-30", "2026-11-06", "2026-11-22"].map(function (day, i) {
    return expiryBatch("threshold-" + i, day);
  });
  return booted(createUi(seed, "2026-10-23T12:00:00")).then(function (ext) {
    ok("默认 3 天含今天和第 3 天，不含第 4 天", rowIds(ext.el("#upcoming").innerHTML).join(",") === "threshold-0,threshold-1");
    return [7, 14, 30, 3].reduce(function (previous, threshold) {
      return previous.then(function () {
        var select = ext.el("#thr"); select.value = String(threshold); select.onchange.call(select);
        return booted(ext).then(function () {
          var expected = { 3: 2, 7: 4, 14: 5, 30: 6 }[threshold];
          ok("切换 " + threshold + " 天立即更新逐笔列表", rowIds(ext.el("#upcoming").innerHTML).length === expected);
          ok("切换 " + threshold + " 天已持久化", ext.mem[KEY].settings.threshold === threshold);
        });
      });
    }, Promise.resolve()).then(function () {
      return booted(createUi(ext.mem[KEY], "2026-10-23T12:00:00"));
    }).then(function (reopened) {
      ok("重新打开保留 3 天选择", reopened.el("#thr").value === "3");
      var select = reopened.el("#thr"); select.value = "invalid"; select.onchange.call(select);
      return booted(reopened).then(function () {
        ok("非法阈值回退 3 天且不清空列表", reopened.mem[KEY].settings.threshold === 3
          && reopened.el("#thr").value === "3" && rowIds(reopened.el("#upcoming").innerHTML).length === 2);
      });
    });
  });
}).then(function () {
  var seed = seedDoc(2), day = "2026-10-23";
  seed.batches = [
    Object.assign(expiryBatch("group-q1", day, day + "T13:05:00"), { remaining: 100.25 }),
    Object.assign(expiryBatch("group-q2", day, day + "T18:30:00"), { remaining: 50.5 }),
    Object.assign(expiryBatch("group-expired", day, day + "T10:00:00"), { remaining: 20 }),
    Object.assign(expiryBatch("group-unknown", day), { remaining: 5 }),
    Object.assign(expiryBatch("group-trae", day, day + "T14:06:00", "trae"), { remaining: 80 }),
    Object.assign(expiryBatch("group-lobster", day, day + "T15:07:00", "lobsterai"), { remaining: 90 }),
    Object.assign(expiryBatch("group-workbuddy", day, day + "T16:08:00", "workbuddy"), { remaining: 70 }),
    Object.assign(expiryBatch("group-closed", day), { closed: true, remaining: 999 }),
    expiryBatch("group-tomorrow", "2026-10-24"),
    expiryBatch("group-past1", "2026-10-22"), expiryBatch("group-past2", "2026-10-22")
  ];
  var original = JSON.stringify(seed.batches);
  return booted(createUi(seed, day + "T12:00:00")).then(function (ext) {
    var cell = dayHtml(ext, day), tomorrow = dayHtml(ext, "2026-10-24"), past = dayHtml(ext, "2026-10-22");
    ok("已有 14 天阈值不被新默认值覆盖", ext.el("#thr").value === "14");
    ok("同日同平台只显示一条", (cell.match(/data-agent="qoder"/g) || []).length === 1);
    ok("平台内合计保留小数、排除已关闭批次", cell.includes("</b> 175.75</div>") && cell.includes("Qoder · 4 笔"));
    ok("不同平台不合并金额", cell.includes('data-agent="trae"') && cell.includes("</b> 80</div>")
      && cell.includes('data-agent="lobsterai"') && cell.includes("</b> 90</div>"));
    ok("每格最多三平台，更多按平台数提示", (cell.match(/data-agent=/g) || []).length === 3 && cell.includes("+1 个平台，点开看"));
    ok("不同日期不合并", tomorrow.includes("Qoder · 1 笔") && tomorrow.includes("</b> 100</div>"));
    ok("有效与过期混合组保持正常色", /class="e"[^>]*data-agent="qoder"/.test(cell));
    ok("全部已过期组降饱和且保留历史合计", /class="e dim"[^>]*data-agent="qoder"/.test(past) && past.includes("</b> 200</div>"));
    ok("聚合条不再指向任意单笔 ID", rowIds(cell).length === 0);
    var upcomingIds = rowIds(ext.el("#upcoming").innerHTML);
    ok("即将到期仍逐笔且不混入过期/关闭记录", upcomingIds.length === 7 && ["group-q1", "group-q2", "group-unknown"].every(function (id) {
      return upcomingIds.includes(id);
    }) && !upcomingIds.includes("group-expired") && !upcomingIds.includes("group-closed"));

    clickDay(ext, day, true);
    var detail = ext.el("#detail").innerHTML;
    ok("点击合并条进入当天逐笔明细", detail.includes("2026/10/23 到期明细") && rowIds(detail).length === 7);
    ok("日明细包含折叠的平台和历史过期批次", rowIds(detail).includes("group-workbuddy") && rowIds(detail).includes("group-expired")
      && detail.includes("已过期") && !rowIds(detail).includes("group-closed"));
    ["13:05", "18:30", "10:00", "14:06", "15:07", "16:08"].forEach(function (hm) {
      ok("到期明细显示完整日期时分 " + hm, detail.includes(day + " " + hm + " 到期"));
    });
    ok("到期明细不伪造未知时分", detail.includes(day + "（具体时间未知） 到期"));
    clickDay(ext, day, true);
    ok("再次点击合并条仍保持明细打开", rowIds(ext.el("#detail").innerHTML).length === 7);

    var format = ext.ctx.CreditNormalize.formatExpiry;
    ext.ctx.CreditNormalize.formatExpiry = function () { return '<time datetime="x">&</time>'; };
    ext.tick();
    ok("到期明细格式化时间也经过 HTML 转义", ext.el("#detail").innerHTML.includes("&lt;time datetime=&quot;x&quot;&gt;&amp;&lt;/time&gt;"));
    ext.ctx.CreditNormalize.formatExpiry = format;
    clickBatch(ext, "#detail", "group-q2");
    ok("聚合后的逐笔明细仍能编辑指定批次", ext.el("#detail").innerHTML.includes('value="group-q2"')
      && ext.el("#detail").innerHTML.includes("实际清零时刻 2026-10-23 18:30"));
    clickAct(ext, "#detail", "close");
    ok("关闭单笔编辑回到当天明细", rowIds(ext.el("#detail").innerHTML).length === 7);
    clickBatch(ext, "#upcoming", "group-q1");
    ok("即将到期仍直接进入对应批次编辑", ext.el("#detail").innerHTML.includes('value="group-q1"'));
    clickDay(ext, day, false);
    ok("点击日期空白也显示完整日期时分", ext.el("#detail").innerHTML.includes(day + " 13:05 到期"));
    clickDay(ext, day, false);
    ok("再次点击日期空白可取消选择", ext.el("#detail").innerHTML.includes("批次明细") && rowIds(ext.el("#detail").innerHTML).length === 0);
    clickDay(ext, "2026-11-01", false, true);
    ok("跨月占位格仍不可选择", ext.el("#detail").innerHTML.includes("批次明细"));
    return booted(ext).then(function () {
      ok("日历聚合与点击均不修改底层批次", JSON.stringify(ext.mem[KEY].batches) === original);
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
