/*
 * calendar.js — 扩展页面 UI。
 *
 * 渲染逻辑直接移植自已验证的 prototype/index.html（日历纯事件点、单位不跨 agent
 * 合并、按最近到期排序、行内两段式删除、已过期沉没成本），这里只把它接到
 * chrome.storage.local 上，并加上授权、捕获样本与冲突裁决。
 */
(function () {
  "use strict";

  var N = CreditNormalize, Store = CreditStore, AG = CreditAgents;
  var IS_EXT = Store.hasChrome && typeof chrome !== "undefined" && !!chrome.runtime;
  var TODAY = N.startOfDay(new Date());

  var doc = null;
  var view, sel, edit, wasted, delConfirm, authOpen = false, authView = null;
  /* 「正在填补录表单」的标记。语义与 edit 并列，但必须单独一个：
   * renderAdd 不写 edit（补录的是还没有 batchId 的新批次），于是后台任何一次写入
   * 触发的 onChanged 重画都会把表单连同已输入的内容冲掉 —— 而 service worker
   * 每次唤醒都可能写一次存储。同理 renderDetail 在 adding 时也不能动 #detail。 */
  var adding = false;
  var confirmTimer = null;
  // 样本详情的展开状态（key -> true）与当前渲染出来的样本列表（供导出按钮回查）。
  // 响应体最大 200KB 一条、最多 60 条，全量塞进 DOM 会直接把扩展页卡死，
  // 所以默认只渲染前面一小段，要看完整内容得用户自己点开那一条。
  var capOpen = {}, capList = [];

  function $(s) { return document.querySelector(s); }
  function $$(s) { return [].slice.call(document.querySelectorAll(s)); }
  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  /* toast 队列：连续几条提示（同步结果就是「完成 + 数据来源」两三条）如果直接覆盖，
   * 用户只看得见最后一条，前面的关键信息等于没说。改成排队播，时长按字数给。 */
  var toastQ = [];
  function toast(t) {
    toastQ.push(String(t));
    if (toastQ.length === 1) drainToast();
  }
  function drainToast() {
    var el = $("#toast");
    if (!toastQ.length) { el.classList.remove("on"); return; }
    var t = toastQ.shift();
    el.textContent = t;
    el.classList.add("on");
    clearTimeout(el._x);
    el._x = setTimeout(drainToast, Math.min(9000, Math.max(2600, t.length * 90)));
  }
  function ago(iso) {
    if (!iso) return "从未";
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 0) s = 0;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + " 分钟前";
    if (s < 86400) return Math.round(s / 3600) + " 小时前";
    return Math.round(s / 86400) + " 天前";
  }
  function fmt(unit, n) {
    if (unit === "tokens") {
      if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
      return String(n);
    }
    return (n || 0).toLocaleString();
  }
  function unitLabel(u) { return u === "tokens" ? "tokens" : u === "requests" ? "次" : "积分"; }
  function chipAmt(b) { return fmt(b.unit, b.remaining) + (b.unit === "requests" ? " 次" : ""); }
  function shortLbl(l) { return l && l.length > 12 ? l.slice(0, 12) + "…" : (l || "未命名批次"); }

  /** 样本时刻 -> "10/21 14:03"，用在同步结果里说明"这笔数字是什么时候的" */
  function hm(iso) {
    if (!iso) return "更早";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "更早";
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  /* ---------- 启动与持久化 ---------- */

  function boot() {
    Store.load().then(function (d) {
      doc = d;
      var u = doc.ui || {};
      view = u.view || [TODAY.getFullYear(), TODAY.getMonth()];
      sel = u.sel || null; edit = u.edit || null; wasted = u.wasted || null;
      render();
    });
  }

  /* UI 侧落盘统一走 commit：在 Store.update 的读-改-写里基于**存储里的最新文档**
   * 重放改动，不再拿页面内存里的旧快照整份覆盖。此前 persist() 直接 Store.save(doc)，
   * 后台刚写进来的捕获样本 / authPending 会被几十秒前的快照抹掉。
   * 改动先同步应用到内存 doc（渲染立刻可见），再在 update 队列里对最新文档重放一遍；
   * 跨上下文仍非严格原子，但竞态窗口从"任意长"缩到毫秒级。 */
  function commit(mutate) {
    if (mutate) mutate(doc);
    return Store.update(function (f) {
      if (mutate) mutate(f);
      f.ui = { view: view, sel: sel, edit: edit, wasted: wasted };
      doc = f;
    });
  }
  function persist() { return commit(null); }

  if (IS_EXT && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (_ch, area) {
      if (area !== "local") return;
      // 捕获样本从别的标签页写进来时刷新视图；正在编辑就不打断用户
      Store.load().then(function (d) {
        doc = d;
        // 授权面板开着时也必须跟着刷新：用户从后台页登录回来，
        // 这里要能立刻显示「等待中 → 已自动写入」的状态变化。
        // 只在主列表且没有输入框聚焦时重画，避免冲掉正在填的地址/样本。
        var typing = document.activeElement && document.activeElement.tagName === "INPUT"
          && document.activeElement.closest && document.activeElement.closest("#authBody");
        if (authOpen && !authView && !typing) renderAuth();
        if (!edit && !adding && !authOpen) render();
        else renderCards(), renderFresh(), renderNotice();
      });
    });
  }

  /* ---------- 派生 ---------- */

  function ORDER() { return AG.AGENTS.map(function (a) { return a.id; }); }
  function colorOf(id) { var a = AG.byId(id); return a ? a.color : "#888"; }
  function isExpired(b) { var d = N.daysLeft(b.expiresAt, TODAY); return d != null && d < 0; }
  function byId(id) {
    for (var i = 0; i < doc.batches.length; i++) if (doc.batches[i].batchId === id) return doc.batches[i];
    return null;
  }
  function expiringOn(dayStr) {
    return doc.batches.filter(function (b) { return b.expiresAt === dayStr; })
      .sort(function (a, c) { return c.remaining - a.remaining; });
  }
  function upcoming() {
    var lim = doc.settings.threshold;
    return doc.batches.filter(function (b) { var d = N.daysLeft(b.expiresAt, TODAY); return d != null && d >= 0 && d <= lim; })
      .sort(function (a, c) { return N.daysLeft(a.expiresAt, TODAY) - N.daysLeft(c.expiresAt, TODAY); });
  }
  function agentSummary(agent) {
    var all = doc.batches.filter(function (b) { return b.agent === agent; });
    var act = all.filter(function (b) { return !isExpired(b); });
    var exp = all.filter(function (b) { return isExpired(b); });
    var total = 0; act.forEach(function (b) { total += b.remaining; });
    var lost = 0; exp.forEach(function (b) { lost += b.remaining; });
    var manualCount = 0, conflicts = 0;
    act.forEach(function (b) { if (b.manualEdited) manualCount++; if (b.conflict) conflicts++; });
    var soonest = null;
    act.forEach(function (b) {
      if (!soonest || N.daysLeft(b.expiresAt, TODAY) < N.daysLeft(soonest.expiresAt, TODAY)) soonest = b;
    });
    var newest = all.slice().sort(function (a, c) { return a.capturedAt < c.capturedAt ? 1 : -1; })[0];
    var cfg = doc.agents[agent] || {};
    return {
      agent: agent, name: cfg.name || agent, unit: cfg.unit || "credits",
      count: act.length, total: total, wasted: lost, wastedCount: exp.length,
      manualCount: manualCount, conflicts: conflicts, soonest: soonest,
      capturedAt: (newest && newest.capturedAt) || cfg.lastSyncAt || null,
      fetchMode: cfg.fetchMode || "unauthorized"
    };
  }

  /* ---------- 顶部提示 ---------- */

  function renderNotice() {
    var box = $("#notice"), msgs = [];
    if (!IS_EXT) {
      msgs.push("当前是 <b>file:// 预览模式</b>：授权与抓取不可用，日历与手动录入照常工作。装进浏览器后这里会变成授权入口。");
    }
    var conf = doc.batches.filter(function (b) { return b.conflict; }).length;
    if (conf) msgs.push("有 <b>" + conf + " 笔</b>积分的抓取值和你手填的值不一致，等你裁决（点卡片上的黄色标记）。");
    var unauth = ORDER().filter(function (a) {
      var ag = doc.agents[a];
      // 正在等登录的平台不算「没授权」，否则用户会同时看到「等待授权」和「还没授权」
      return ag.fetchMode === "unauthorized" && !authPendingLive(ag);
    }).length;
    if (IS_EXT && unauth) msgs.push("还有 <b>" + unauth + " 个平台</b>没授权，它们的数据只能手填。");
    box.innerHTML = msgs.length
      ? '<div class="banner">' + msgs.join(" ") + "</div>" : "";
  }

  /* ---------- 总览卡片 ---------- */

  function renderCards() {
    var list = ORDER().map(agentSummary);
    list.sort(function (x, y) {
      var dx = x.soonest ? N.daysLeft(x.soonest.expiresAt, TODAY) : 1e9;
      var dy = y.soonest ? N.daysLeft(y.soonest.expiresAt, TODAY) : 1e9;
      return dx - dy;
    });

    $("#cards").innerHTML = list.map(function (s) {
      var m = AG.MODE_LABEL[s.fetchMode] || ["未知", "u"];
      // 授权页已经打开、还没等到目标接口时优先显示「授权中」：
      // 页面顺带发的其他接口也会让 fetchMode 变成 capture，但那还不是授权完成。
      if (authPendingLive(doc.agents[s.agent] || {})) {
        m = ["授权中", "h"];
      }
      var cd;
      if (!s.soonest) cd = '<span class="cd none">无有效积分</span>';
      else {
        var d = N.daysLeft(s.soonest.expiresAt, TODAY);
        var k = d <= 2 ? "hot" : d <= 7 ? "warm" : "cool";
        cd = '<span class="cd ' + k + '">' + (d === 0 ? "今天最后可用" : "还有 " + d + " 天") + "</span>";
      }
      return '<div class="card" style="--c:' + colorOf(s.agent) + '">'
        + '<div class="card-head"><span class="agent-name">' + esc(s.name) + "</span>"
        + '<span class="chip ' + m[1] + '">' + m[0] + "</span></div>"
        + (s.count
          ? '<div class="balance">' + fmt(s.unit, s.total) + '<span class="u">' + unitLabel(s.unit) + " 可用</span></div>"
          : '<div class="balance" style="color:var(--ink-3)">0<span class="u">' + unitLabel(s.unit) + "</span></div>")
        + (s.soonest
          ? '<div class="next">最近一笔 <b>' + esc(shortLbl(s.soonest.label)) + "</b> · "
            + s.soonest.expiresAt.slice(5).replace("-", "/") + " 到期</div>" + cd
          : '<div class="empty-b">当前无未过期批次</div>')
        + '<div class="tstamp">' + (s.count
            ? s.count + " 个批次 · " + timeText(s)
            : '0 个批次 · <span class="mn">还没有数据</span>')
        + (s.conflicts ? ' <span class="badge" data-act="conflicts" data-agent="' + s.agent + '">'
            + s.conflicts + " 笔待裁决</span>" : "") + "</div>"
        + (s.wastedCount
          ? '<div class="wasted" data-act="wasted" data-agent="' + s.agent + '">'
            + "已过期未用完 <b>" + fmt(s.unit, s.wasted) + unitTail(s.unit) + "</b>（" + s.wastedCount + " 笔）"
            + '<span class="ar">查看 ›</span></div>'
          : "")
        + "</div>";
    }).join("");
  }

  function timeText(s) {
    if (s.fetchMode === "manual-only" || s.fetchMode === "unauthorized") {
      return '<span class="mn">手填于 ' + ago(s.capturedAt) + "</span>";
    }
    var t = "取数于 " + ago(s.capturedAt);
    if (s.manualCount) t += ' · <span class="mn">' + s.manualCount + " 笔含手动改动</span>";
    return t;
  }
  function unitTail(unit) { return unit === "requests" ? " 次" : " " + unitLabel(unit); }

  /* ---------- 月历 ---------- */

  function renderCal() {
    var y = view[0], mo = view[1];
    var inMonth = doc.batches.filter(function (b) {
      var d = N.parseYmd(b.expiresAt); return d && d.getFullYear() === y && d.getMonth() === mo;
    }).length;
    $("#moTitle").innerHTML = y + " 年 " + (mo + 1) + " 月<span>" + inMonth + " 笔到期</span>";

    var first = new Date(y, mo, 1);
    var lead = first.getDay();                       // 周日开头
    var start = N.addDays(first, -lead);
    var cells = [];
    for (var i = 0; i < 42; i++) cells.push(N.addDays(start, i));
    // 裁掉整行都不在本月的尾行，避免末行挂孤儿格子
    while (cells.length >= 7) {
      var tail = cells.slice(-7), allOut = true;
      for (var k = 0; k < 7; k++) if (tail[k].getMonth() === mo) { allOut = false; break; }
      if (!allOut) break;
      cells = cells.slice(0, -7);
    }

    var selTs = sel ? N.parseYmd(sel).getTime() : null;
    var todayTs = TODAY.getTime();

    $("#grid").innerHTML = cells.map(function (d) {
      var ds = N.ymd(d), out = d.getMonth() !== mo, past = d.getTime() < todayTs;
      var cls = "cell" + (out ? " out" : "") + (past ? " past" : "")
        + ((d.getDay() === 0 || d.getDay() === 6) ? " we" : "")
        + (d.getTime() === selTs ? " sel" : "");
      var items = out ? [] : expiringOn(ds);
      var shown = items.slice(0, 3);
      var html = '<div class="' + cls + '" data-day="' + ds + '"><div class="dnum">'
        + (d.getTime() === todayTs ? '<span class="td">今天</span>' : "")
        + '<span style="' + (d.getDate() === 1 ? "font-weight:650;color:var(--ink)" : "") + '">'
        + d.getDate() + "</span></div>";
      if (shown.length) {
        html += '<div class="entries">' + shown.map(function (b) {
          return '<div class="e' + (past ? " dim" : "") + '" style="--c:' + colorOf(b.agent)
            + '" data-bid="' + b.batchId + '" title="' + esc(b.label) + '"><b>'
            + esc((doc.agents[b.agent] || {}).name || b.agent) + "</b> " + chipAmt(b) + "</div>";
        }).join("")
          + (items.length > 3 ? '<div class="more">+' + (items.length - 3) + " 笔，点开看</div>" : "")
          + "</div>";
      }
      return html + "</div>";
    }).join("");
  }

  function renderLegend() {
    $("#legend").innerHTML = ORDER().map(function (a) {
      return '<span class="lg" style="--c:' + colorOf(a) + '"><span class="dot"></span>'
        + esc((doc.agents[a] || {}).name || a) + "（" + unitLabel((doc.agents[a] || {}).unit || "credits") + "）</span>";
    }).join("") + '<span class="lg" style="margin-left:auto;color:var(--ink-3)">仅标当日到期 · 单位不跨 agent 合并</span>';
  }

  /* ---------- 即将到期 ---------- */

  function renderUpcoming() {
    var u = upcoming(), box = $("#upcoming");
    $("#thr").value = String(doc.settings.threshold);
    if (!u.length) {
      box.innerHTML = '<div class="none-yet">未来 ' + doc.settings.threshold + ' 天内无积分到期'
        + (doc.batches.length ? "" : "，点日历里的任意一天可以补录") + "</div>";
      return;
    }
    box.innerHTML = u.map(function (b) {
      var d = N.daysLeft(b.expiresAt, TODAY);
      var k = d <= 2 ? "#b91c1c" : d <= 7 ? "#9a3412" : "var(--ink-2)";
      return '<div class="row" data-bid="' + b.batchId + '" style="--c:' + colorOf(b.agent) + '">'
        + '<span class="bar"></span><div class="info"><div class="l1">'
        + esc((doc.agents[b.agent] || {}).name || b.agent)
        + ' <span style="font-weight:450;color:var(--ink-2)">· ' + esc(shortLbl(b.label)) + "</span></div>"
        + '<div class="l2">' + b.expiresAt.slice(5).replace("-", "/") + " 到期 · "
        + '<span style="color:' + k + ';font-weight:600">'
        + (d === 0 ? "今天最后可用" : "还剩 " + d + " 天") + "</span></div></div>"
        + '<div class="amt">' + fmt(b.unit, b.remaining) + "<small>" + unitLabel(b.unit) + "</small></div></div>";
    }).join("");
  }

  /* ---------- 右栏详情 ---------- */

  function renderDetail() {
    var box = $("#detail");
    // 正在填补录表单：谁也别动这块 DOM。重画一次就等于把用户刚敲的内容扔掉，
    // 而 storage 变更、同步结果、定时刷新都会走到这里。
    if (adding) return;
    if (edit) return renderEdit(box, byId(edit));
    if (wasted) return renderWasted(box, wasted);

    if (sel) {
      var items = expiringOn(sel), d = N.daysLeft(sel, TODAY);
      box.innerHTML = '<div class="sec-h"><h3>' + sel.replace(/-/g, "/") + " 到期明细</h3>"
        + '<span class="cnt">' + (d < 0 ? "已过去" : d === 0 ? "今天" : "还有 " + d + " 天") + "</span></div>"
        + (items.length
          ? '<div class="sec-b">' + items.map(function (b) {
              return '<div class="row" data-bid="' + b.batchId + '" style="--c:' + colorOf(b.agent) + '">'
                + '<span class="bar"></span><div class="info"><div class="l1">'
                + esc((doc.agents[b.agent] || {}).name || b.agent) + "</div>"
                + '<div class="l2">' + esc(b.label)
                + (isExpired(b) ? ' · <span style="color:#b91c1c">已过期</span>' : "") + "</div></div>"
                + '<div class="amt">' + fmt(b.unit, b.remaining) + "<small>" + unitLabel(b.unit) + "</small></div></div>";
            }).join("") + "</div>"
            + '<div class="sec-b" style="padding-top:2px"><button class="mini" data-act="add">+ 补录一笔到这天</button></div>'
          : '<div class="none-yet">这一天没有积分到期</div>'
            + '<div class="sec-b" style="padding-top:2px"><button class="mini" data-act="add">+ 在这一天补录批次</button></div>');
      return;
    }

    box.innerHTML = '<div class="sec-h"><h3>批次明细</h3></div>'
      + '<div class="hint">点日历里的色条，或点「即将到期」里的任意一行，就能查看和修正这一笔积分。'
      + "<br><br>抓取一定会出错，所以<b style=\"color:var(--ink-2)\">必须能手动改</b>：改过期日、改剩余量、删除、补录。"
      + "改过的批次会标「手动改动」，之后同步不再覆盖它的过期日，而是把抓取值留给你裁决。</div>";
  }

  function renderWasted(box, agent) {
    var exp = doc.batches.filter(function (b) { return b.agent === agent && isExpired(b); })
      .sort(function (a, c) { return a.expiresAt < c.expiresAt ? -1 : 1; });
    if (!exp.length) { wasted = null; return renderDetail(); }
    var sum = 0; exp.forEach(function (b) { sum += b.remaining; });
    var unit = (doc.agents[agent] || {}).unit || "credits";
    box.innerHTML = '<div class="sec-h"><h3>已过期未用完</h3>'
      + '<span class="cnt" style="color:var(--ink-3);cursor:pointer" data-act="close">关闭 ✕</span></div>'
      + '<div class="sec-b" style="--c:' + colorOf(agent) + '">'
      + '<div style="padding:8px 8px 4px;font-size:12.5px;color:var(--ink-2)">'
      + esc((doc.agents[agent] || {}).name || agent) + " · 共 <b style=\"color:var(--warn)\">"
      + fmt(unit, sum) + unitTail(unit) + "</b> 在到期时没用掉</div>"
      + exp.map(function (b) {
          return '<div class="row" data-bid="' + b.batchId + '"><span class="bar"></span><div class="info">'
            + '<div class="l1">' + esc(shortLbl(b.label)) + "</div>"
            + '<div class="l2">' + b.expiresAt + " 到期 · 已过期 " + (-N.daysLeft(b.expiresAt, TODAY)) + " 天</div></div>"
            + '<div class="amt" style="color:var(--warn)">' + fmt(b.unit, b.remaining)
            + "<small>" + unitLabel(b.unit) + " 未用</small></div></div>";
        }).join("")
      + "</div>"
      + '<div class="hint">这块是"沉没成本"，只用于回看：一是判断哪些平台你其实用不完、不该再加购；'
      + "二是校准提醒阈值该往前挪几天。</div>";
  }

  function renderEdit(box, b) {
    if (!b) { edit = null; return renderDetail(); }
    var d = N.daysLeft(b.expiresAt, TODAY);
    var conflict = b.conflict && b.scraped
      ? '<div class="conflict"><b>抓取值与手填值不一致</b>，你说了算：'
        + '<div class="r"><span>你填的</span><span>' + fmt(b.unit, b.remaining) + "</span></div>"
        + '<div class="r"><span>抓到的</span><span>' + fmt(b.unit, b.scraped.remaining)
        + "（" + ago(b.scraped.capturedAt) + "）</span></div>"
        + '<button class="mini" data-act="accept">采用抓取值</button></div>'
      : "";
    box.innerHTML = '<div class="sec-h"><h3>修正批次</h3>'
      + '<span class="cnt" style="color:var(--ink-3);cursor:pointer" data-act="close">关闭 ✕</span></div>'
      + '<div class="dt" style="--c:' + colorOf(b.agent) + '">'
      + conflict
      + '<div class="ttl">' + esc((doc.agents[b.agent] || {}).name || b.agent)
      + (b.manualEdited ? '<span class="manual-flag">手动改动</span>' : "") + "</div>"
      + '<div class="lbl" style="color:var(--ink-2)">' + esc(b.label) + " · "
      + (d < 0 ? '<span style="color:#b91c1c">已过期 ' + (-d) + " 天</span>"
        : d === 0 ? '<span style="color:#b91c1c">今天最后可用</span>'
        : "还有 " + d + " 天") + "</div>"
      + '<div class="fld"><label>批次名称</label><input data-f="label" value="' + esc(b.label) + '"></div>'
      + '<div class="fld"><label>过期日（最后一个可用日）</label>'
      + '<input type="date" data-f="expiresAt" value="' + b.expiresAt + '"></div>'
      + '<div class="fld two"><div><label>剩余 ' + unitLabel(b.unit) + "</label>"
      + '<input type="number" data-f="remaining" value="' + b.remaining + '" min="0"></div>'
      + "<div><label>发放总量</label>"
      + '<input type="number" data-f="granted" value="' + b.granted + '" min="0"></div></div>'
      + '<div class="fld"><label>数据来源</label><select data-f="source">'
      + '<option value="auto"' + (b.source === "auto" ? " selected" : "") + ">自动抓取</option>"
      + '<option value="manual"' + (b.source === "manual" ? " selected" : "") + ">手动录入</option></select></div>"
      + '<div class="meta">batchId ' + b.batchId + "<br>dedupKey " + esc(N.dedupKey(b)) + "<br>"
      + (b.source === "manual" ? "手填时间 " : "取数时间 ")
      + new Date(b.capturedAt).toLocaleString("zh-CN")
      + (b.resetInstant ? "<br>实际清零时刻 " + new Date(b.resetInstant).toLocaleString("zh-CN") : "")
      + (b.updatedAt ? '<br><span style="color:#92400e">手动修改于 '
          + new Date(b.updatedAt).toLocaleString("zh-CN") + "（同步不再覆盖它的过期日）</span>" : "")
      + (b.absentCount ? '<br><span style="color:#9a3412">最近 ' + b.absentCount + " 次同步没返回这笔</span>" : "")
      + "</div>"
      + '<div class="acts"><button class="primary" data-act="save">保存</button>'
      + '<button class="danger' + (delConfirm === b.batchId ? " armed" : "") + '" data-act="del">'
      + (delConfirm === b.batchId ? "确认删除这一笔？" : "删除") + "</button></div></div>";
  }

  function renderAdd() {
    var box = $("#detail");
    var defDay = sel || N.ymd(N.addDays(TODAY, 30));
    box.innerHTML = '<div class="sec-h"><h3>补录批次</h3>'
      + '<span class="cnt" style="color:var(--ink-3);cursor:pointer" data-act="close">关闭 ✕</span></div>'
      + '<div class="dt"><div class="ttl">新批次<span class="manual-flag">手动</span></div>'
      + '<div class="lbl">抓不到的平台就走这条路，UI 上会如实标成手动录入。</div>'
      + '<div class="fld"><label>Agent</label><select data-nf="agent">'
      + ORDER().map(function (a) { return '<option value="' + a + '">' + esc(doc.agents[a].name) + "</option>"; }).join("")
      + "</select></div>"
      + '<div class="fld"><label>批次名称</label><input data-nf="label" placeholder="如：11月 套餐积分"></div>'
      + '<div class="fld"><label>过期日</label><input type="date" data-nf="expiresAt" value="' + defDay + '"></div>'
      + '<div class="fld two"><div><label>剩余</label><input type="number" data-nf="remaining" value="1000" min="0"></div>'
      + "<div><label>发放总量</label><input type=\"number\" data-nf=\"granted\" value=\"6000\" min=\"0\"></div></div>"
      + '<div class="acts"><button class="primary" data-act="addsave">加入日历</button></div></div>';
  }

  /* ---------- 授权与样本 ---------- */

  var AUTH_WAIT_MIN = 10;

  function authPendingLive(a) {
    if (!a.authPending) return false;
    var started = Date.parse(a.authPending.startedAt) || 0;
    return !!started && Date.now() - started <= AUTH_WAIT_MIN * 60000;
  }

  /**
   * 授权流程的状态说明。
   *
   * 以前点完「授权」只弹一条 toast，然后焦点被新标签页抢走；用户登录完回来
   * 看不到任何进度，也不知道还要点「刷新余额」，表现就是"没有下一步"。
   * 现在把等待和自动收尾的结果直接写在平台行里，回来后一眼能看到。
   */
  function authStatusLine(a) {
    if (a.authPending) {
      var started = Date.parse(a.authPending.startedAt) || 0;
      var left = AUTH_WAIT_MIN - Math.floor((Date.now() - started) / 60000);
      var note = a.authResult && a.authResult.ok === false && a.authResult.message
        ? " " + esc(a.authResult.message) : "";
      if (left > 0) {
        // "打开页面但一直不同步"必须能自己看出断在哪一环，不能只会说"请先登录"。
        // 心跳只认本次等待会话内的（早于 startedAt 的是上一次会话留下的旧值）：
        //   中继 + 钩子都在 → 注入成功，正在等页面发目标接口；
        //   只有中继 → MAIN world 钩子没起来（老内核常见），截不到，走粘贴样本；
        //   都没有 → 页面还没加载完，或内容脚本压根没注册上。
        var relay = a.lastRelayAt && Date.parse(a.lastRelayAt) >= started;
        var hook = a.lastHookAt && Date.parse(a.lastHookAt) >= started;
        var fresh = (doc.captures || []).filter(function (c) {
          return c.agentId === a.id && Date.parse(c.at) >= started;
        }).length;
        var live = relay
          ? (hook ? "钩子已注入本页" : "钩子没注上（只有中继心跳），这家多半截不到，可用「粘贴样本」")
          : "还没收到钩子心跳：页面可能还没加载完，或钩子没注册上";
        if (fresh) live += "；本次已截到 " + fresh + " 条新样本";
        return '<div class="hintline" style="color:#b45309"><b>等待授权中</b>：' + esc(live)
          + "。确认已在打开的页面里登录后不用再点按钮，截到额度接口会自动写入日历"
          + "（还剩约 " + left + " 分钟）。" + note + "</div>";
      }
      return '<div class="hintline" style="color:#b45309"><b>等待已超时</b>：如果已经登录，点「重新打开页面」重试。'
        + note + "</div>";
    }
    var r = a.authResult;
    if (!r) return "";
    if (r.ok) {
      return '<div class="hintline" style="color:#047857"><b>最近一次授权完成</b>：'
        + esc(r.message || "已写入日历") + (r.added ? "（新增 " + r.added + " 笔）" : "")
        + (r.at ? " · " + hm(r.at) : "") + "</div>";
    }
    return '<div class="hintline" style="color:#b45309"><b>最近一次授权未完成</b>：'
      + esc(r.message || r.reason || "未知原因") + "</div>";
  }

  function renderAuth() {
    var box = $("#authBody");
    if (!authOpen) { $("#mAuth").classList.remove("on"); return; }
    $("#mAuth").classList.add("on");

    if (authView === "__diag__") return renderDiag(box);
    if (authView && authView.indexOf("__paste__:") === 0) return renderPaste(box, authView.slice("__paste__:".length));
    if (authView) return renderCaptureList(box, authView);

    box.innerHTML =
      (IS_EXT ? '<button class="mini" data-act="diag" style="margin-bottom:10px">权限自检（授权失败时点这个）</button>' : "")
      + '<div class="privacy"><b>取数方式</b>：Qoder 走「页面内直读」——扩展打开你自己的 qoder.com 用量页，'
      + "在这个页面里发一次只读额度请求。cookie 与 CSRF token 都由页面自己携带，扩展不读取、不保存、不上报它们；"
      + "不注入钩子，所以不会再影响 Qoder 的登录态。其余平台仍走「授权截获」：在页面里旁路观察它自己的接口响应，"
      + "鉴权同样由页面完成，样本只留请求头名字、不留值。</div>"
      + '<ol class="steps">'
      + "<li><b>Qoder</b>：点「刷新余额」→ 自动开隐藏页读一次；若提示未登录，会在前台留下登录页，登录后再点一次</li>"
      + "<li><b>其余平台</b>：填后台地址 → 点授权 → 在打开的页面里登录，扩展截获疑似积分接口</li>"
      + "<li>有样本后点「立即同步」产出批次；手动录入作为兜底永远可用</li>"
      + "</ol>"
      + ORDER().map(function (id) {
          var staticAgent = AG.byId(id);
          var a = doc.agents[id], m = AG.MODE_LABEL[a.fetchMode] || ["未知", "u"];
          var caps = (doc.captures || []).filter(function (c) { return c.agentId === id; });
          // captures 数组不保证按时间排序，取最新要自己比一遍
          var newest = caps.reduce(function (m, c) {
            return !m || String(c.at || "") > String(m.at || "") ? c : m;
          }, null);
          var direct = !!(staticAgent && staticAgent.direct);
          // 用「有没有真正授过权」判断，而不是「地址填了没」：地址是失焦就记下的，
          // 拿它当条件会让首次授权的按钮在填完地址后消失，永远点不到授权。
          // 等待中的会话优先按「未完成」显示：页面顺带发别的接口也会把 fetchMode
          // 改成 capture，但目标额度接口还没回来，这时不该提前露出「刷新余额」。
          var pendingNow = authPendingLive(a);
          var authed = direct || (!pendingNow && !!a.origin && a.fetchMode !== "unauthorized");
          var btns = "";
          if (direct) {
            // 直读平台没有「授权/解除钩子」这回事，只有一次性的「刷新余额」。
            btns = '<button class="mini primary" data-act="reauth" data-id="' + id + '">刷新余额</button>'
              + ' <button class="mini" data-act="caps" data-id="' + id + '">'
              + (caps.length ? "看样本（" + caps.length + "）" : "读取诊断") + "</button>";
          } else           if (!authed) {
            btns = '<button class="mini primary" data-act="auth" data-id="' + id + '">'
              + (pendingNow ? "重新打开页面" : "授权") + "</button>"
              // 等待会话必须能被取消：点了授权却发现登录态早就好着、或者只是想先
              // 用别的方式取数，这 10 分钟窗口里不该只能干等它自己超时。
              // 后台 UNREGISTER 本来就会清 authPending，这里只是给它一个入口。
              + (pendingNow
                ? ' <button class="mini" data-act="cancelauth" data-id="' + id + '">取消等待</button>'
                : "");
          } else {
            // 两家的主操作都叫「刷新余额」，区别只藏在实现里：直读平台发一次
            // 页面内请求，截获平台开页让页面自己发请求。「保持实时同步」负责把
            // 常驻钩子重新装上，让全局「立即同步」也能活体刷新。
            btns = '<button class="mini primary" data-act="reauth" data-id="' + id + '">刷新余额</button>'
              + ' <button class="mini" data-act="auth" data-id="' + id + '"'
              + ' title="重新安装常驻钩子并打开 portal 页；之后「立即同步」会先抓活数据">保持实时同步</button>'
              + ' <button class="mini" data-act="caps" data-id="' + id + '">'
              + (caps.length ? "看样本（" + caps.length + "）" : "截获诊断") + "</button>";
          }
          // 粘贴样本：钩子不能用（页面不发 XHR）或不该用时的人工退路；直读平台也保留
          if (IS_EXT) {
            btns += ' <button class="mini" data-act="paste" data-id="' + id + '">粘贴样本</button>';
          }
          // 解除钩子只在钩子确实注册着时出现；已经解除就别再摆一个无效按钮
          if (authed && !direct && a.hookActive) {
            btns += ' <button class="mini" data-act="unhook" data-id="' + id + '">解除钩子</button>';
          }
          return '<div class="arow" style="--c:' + colorOf(id) + '">'
            + '<div class="an"><i></i>' + esc(a.name) + "</div>"
            + '<div><input type="url" data-url="' + id + '" placeholder="https://… 积分页面完整地址" value="'
            + esc(a.consoleUrl || "") + '"' + (direct ? ' readonly title="Qoder 直读页面固定为账户用量页"' : "")
            + '><div class="hintline">'
            + '<span class="chip ' + m[1] + '">' + m[0] + "</span> "
            + esc(staticAgent.hint)
            + (caps.length ? " · 已截获 " + caps.length + " 条样本" + (newest ? "（最新 " + hm(newest.at) + "）" : "") : "")
            + (direct
                ? " · " + (a.lastError
                    ? '<b style="color:#b45309">上次读取：' + esc(a.lastError) + "</b>"
                    : '<b style="color:#047857">不装钩子，点「刷新余额」实时读取</b>')
                : (authed ? " · 已授权 " + esc(a.origin) : "")
                  + (authed ? " · " + (a.hookActive
                      ? '<b style="color:#047857">钩子在（同步会实时读取）</b>'
                      : '<b style="color:#b45309">钩子已解除（同步只读样本）</b>') : ""))
            + (direct ? "" : (a.lastError ? '<div class="hintline" style="color:#b91c1c">' + esc(a.lastError) + "</div>" : ""))
            + (direct ? "" : authStatusLine(a))
            + "</div></div>"
            + '<div class="abtns">' + btns + "</div></div>";
        }).join("");
  }

  /**
   * 权限自检：把「授权到底成没成」的真实状态读出来，而不是让人猜。
   * 授权失败有三种完全不同的病因，解法也不同：
   *   a) 浏览器压根没弹窗（Opera 某些版本对 optional_permissions 的运行时请求不弹窗）
   *   b) 弹了但你点了拒绝 / 之前拒绝过被记住了
   *   c) 权限其实已经有了，是代码没走到下一步
   * 这一屏把三种都能区分开。
   */
  function renderDiag(box) {
    if (!IS_EXT || typeof chrome === "undefined" || !chrome.permissions) {
      box.innerHTML = '<button class="mini" data-act="backauth">‹ 返回平台列表</button>'
        + '<div class="none-yet">权限自检只在装成扩展之后有意义 —— 现在是 file:// 预览模式，没有扩展 API。</div>';
      return;
    }
    box.innerHTML = '<button class="mini" data-act="backauth">‹ 返回平台列表</button>'
      + '<div style="margin:12px 0 8px;font-size:12.5px;color:var(--ink-2)">正在读取权限状态…</div>';

    var rows = [];
    function line(k, v) { rows.push('<div class="r"><span>' + esc(k) + "</span><span>" + esc(String(v)) + "</span></div>"); }

    function done(extra) {
      box.innerHTML = '<button class="mini" data-act="backauth">‹ 返回平台列表</button>'
        + '<div style="margin:12px 0 8px;font-size:13px;font-weight:600">权限自检</div>'
        + '<div class="sec-b diag">' + rows.join("") + "</div>"
        + (extra || "")
        + '<div class="hint">把这一屏的内容发我，我就能判断是浏览器不弹窗、还是被拒过、'
        + "还是权限其实已经有了。三种病因的解法完全不同，猜是猜不出来的。</div>";
    }

    line("扩展页面", IS_EXT ? "chrome-extension://（正常）" : "file://（预览模式，没有扩展 API）");
    line("userAgent", navigator.userAgent);
    line("扩展 ID", (chrome.runtime && chrome.runtime.id) || "无");
    line("chrome.permissions 可用", typeof (chrome.permissions || {}).request === "function");

    var mfPromise;
    try {
      mfPromise = fetch(chrome.runtime.getURL("manifest.json")).then(function (r) { return r.json(); });
    } catch (e) { mfPromise = Promise.resolve(null); }

    mfPromise.then(function (mf) {
      line("manifest.host_permissions", mf ? JSON.stringify(mf.host_permissions) : "读不到");
      line("manifest.optional_permissions", mf ? JSON.stringify(mf.optional_permissions) : "读不到");
      return new Promise(function (res) {
        chrome.permissions.getAll(function (all) {
          if (chrome.runtime.lastError) { line("permissions.getAll 报错", chrome.runtime.lastError.message); return res(); }
          line("已授予的 permissions", (all.permissions || []).join(", ") || "（空）");
          line("已授予的 origins", (all.origins || []).join(", ") || "（空 —— 一个域名都没拿到）");
          res();
        });
      });
    }).then(function () {
      var withOrigin = ORDER().filter(function (id) { return doc.agents[id].origin; });
      if (!withOrigin.length) { line("逐域名检查", "还没有任何平台填了地址"); return; }
      return withOrigin.reduce(function (chain, id) {
        return chain.then(function () {
          var pattern = doc.agents[id].origin + "/*";
          return new Promise(function (res) {
            chrome.permissions.contains({ origins: [pattern] }, function (has) {
              if (chrome.runtime.lastError) {
                line(doc.agents[id].name + " contains(" + pattern + ")", "报错：" + chrome.runtime.lastError.message);
              } else {
                line(doc.agents[id].name + " contains(" + pattern + ")", has ? "已授予" : "未授予");
              }
              line(doc.agents[id].name + " 上次错误", doc.agents[id].lastError || "（无）");
              res();
            });
          });
        });
      }, Promise.resolve());
    }).then(function () {
      done();
    }).catch(function (e) {
      line("自检过程出错", String((e && e.message) || e));
      done();
    });
  }

  /**
   * 粘贴样本：钩子不能用或不该用时的退路。
   * 两种典型情况：页面数字是服务端渲染进 HTML、根本不发 XHR；
   * 或站点对页面里的注入/包装很敏感（2026-10-21 Opera 上 qoder.com
   * 登录态异常消失，钩子在场就是触发条件）。这时由人自己取一次响应
   * （DevTools Network 里 Copy response，或自己跑一遍 curl），只把响应体贴进来。
   * 入库仍走同一套打分与脱敏，凭据边界不变：这里要的是响应体，不是请求头。
   */
  function renderPaste(box, id) {
    var a = doc.agents[id];
    box.innerHTML = '<button class="mini" data-act="backauth">‹ 返回平台列表</button>'
      + '<div style="margin:12px 0 8px;font-size:13px;font-weight:600">粘贴样本 · ' + esc(a.name) + "</div>"
      + '<div class="hint" style="margin-bottom:8px;line-height:1.7">取响应体的办法：打开后台页 → F12 开发者工具 → Network，'
      + "找到返回积分的那个请求（名字里通常带 usage / credits / quota），右键 → Copy → Copy response；"
      + "或者自己跑一遍 curl，把输出贴进来。<b>只贴响应体</b>，不要贴 cookie 和请求头——"
      + "响应体是你自己的额度数据，cookie 是凭据。</div>"
      + '<input type="url" id="pasteUrl" placeholder="https://… 这个响应的接口地址" value="'
      + esc(a.endpoint || a.consoleUrl || "") + '">'
      + '<textarea id="pasteBody" rows="10" placeholder="{ …响应体 JSON… }"></textarea>'
      + '<div style="margin-top:8px"><button class="mini primary" data-act="pastesave" data-id="' + id
      + '">存为样本</button></div>';
  }

  /**
   * 最近一次刷新的探针记录。失败时这一屏是唯一的定位证据：
   * 五个可能的断点（钩子没注入 / 页面不发请求 / 发了但不像积分接口 /
   * origin 对不上 / 判重丢弃）在这里能一眼分开，不用靠猜。
   */
  function renderProbe(a) {
    var p = a && a.probe;
    if (!p) return "";
    function row(k, vHtml) { return '<div class="r"><span>' + esc(k) + "</span><span>" + vHtml + "</span></div>"; }
    // 标题与正文共用 lib/diagnose.js 的口径：同一个探针不会出现「标题说读到了、
    // 结论说流程出错」这种自相矛盾的两句话。
    var v = CreditDiagnose.verdict(p);

    if (p.mode === "direct") {
      var attemptsD = (p.attempts || []).map(function (x) {
        return (x.visible ? "可见页" : "隐藏页") + " · " + Math.round((x.ms || 0) / 1000) + "s"
          + (x.seen ? " · 页面内请求已执行" : " · 没执行成功")
          + "（页面状态 " + esc(String(x.tabStatus || "?")) + "）"
          + (x.tabUrl && x.tabUrl !== a.consoleUrl ? "，最终停在 " + esc(x.tabUrl) : "");
      }).join("<br>") || "无";
      return '<div style="margin:12px 0 6px;font-size:13px;font-weight:600;color:'
        + (v.ok ? "#047857" : "#b91c1c") + '">最近一次「刷新余额」的诊断 · '
        + v.text + "</div>"
        + '<div class="sec-b diag">'
        + row("取数方式", "页面内直读（MAIN world，不装钩子）")
        + row("接口", esc(p.endpoint || a.endpoint || "未记录"))
        + row("HTTP", p.httpStatus ? String(p.httpStatus) : "没拿到响应")
        + row("响应体", (p.bodyBytes || 0) + " 字节" + (p.stored ? " · 入库 " + p.stored + " 条" : "")
            + (p.dups ? " · 判重替换 " + p.dups + " 条" : "")
            + (p.upgraded ? " · 其中截断样本升级 " + p.upgraded + " 条" : ""))
        + row("开页尝试", attemptsD)
        + row("耗时", Math.round((p.elapsedMs || 0) / 1000) + " 秒 · " + esc(hm(p.startedAt)))
        + row("结论", "<b>" + esc(diagnose(p)) + "</b>")
        + "</div>";
    }

    // 代发成功也算读到了：数据是扩展在页面里现取回来的，不是缓存。
    // 口径见 CreditDiagnose.verdict（error / both-failed / 代发成功三种情况分开算）。
    var fbOk = !!(p.fallback && p.fallback.ok);
    var attempts = (p.attempts || []).map(function (x) {
      return (x.visible ? "可见页" : "隐藏页") + " 等 " + Math.round((x.ms || 0) / 1000) + "s，"
        + (x.seen ? (x.changed ? "截到新内容" : "有响应但内容没变") : "没等到")
        + "（页面状态 " + esc(String(x.tabStatus || "?")) + "）"
        + (x.tabUrl && x.tabUrl !== a.consoleUrl ? "，最终停在 " + esc(x.tabUrl) : "");
    }).join("<br>") || "无";
    return '<div style="margin:12px 0 6px;font-size:13px;font-weight:600;color:'
      + (v.ok ? "#047857" : "#b91c1c") + '">最近一次「刷新余额」的诊断 · '
      + v.text + "</div>"
      + '<div class="sec-b diag">'
      + row("钩子注入", p.hookAt ? "MAIN world 已起来 " + esc(hm(p.hookAt))
                                 : (p.relayAt ? "只有中转脚本，MAIN world 被挡" : "没起来"))
      + row("页面响应数", p.responses + " 个（" + p.rejected + " 个被打分刷掉"
          + (fbOk ? "，不含代发的那 1 条" : "") + "）")
      + ((p.rejectUrls && p.rejectUrls.length)
          ? row("被刷掉的响应", p.rejectUrls.map(function (u) { return esc(u); }).join("<br>")) : "")
      + row("积分接口候选", p.candidates + " 个" + (p.topUrl ? "，最高分 " + p.bestScore + "：" + esc(p.topUrl) : ""))
      + row("入库 / 判重", p.stored + " 条新样本 / " + p.dups + " 条内容相同原位替换"
          + (p.upgraded ? "（其中 " + p.upgraded + " 条是截断样本升级）" : "")
          + (p.superseded ? "；另清掉 " + p.superseded + " 条被完整响应取代的旧截断样本" : ""))
      + (fbOk ? row("代发兜底", "页面没自己发请求，扩展在页面里代发了一次 · HTTP "
          + (p.fallback.status || "?") + " · " + (p.fallback.bytes || 0) + " 字节") : "")
      + row("开页尝试", attempts)
      + row("耗时", Math.round((p.elapsedMs || 0) / 1000) + " 秒 · " + esc(hm(p.startedAt)))
      + row("结论", "<b>" + esc(diagnose(p)) + "</b>")
      + "</div>";
  }

  /**
   * 探针诊断：口径只有一份，在 lib/diagnose.js，background 存的 diagnosis 用的也是它。
   * 以前这里另写了一遍"同口径"的翻译，结果两边措辞逐渐漂移（直读成功那句后台带
   * 字节数、UI 不带），同一份探针在两个地方显示成两句话。
   */
  function diagnose(p) { return CreditDiagnose.of(p); }

  function renderCaptureList(box, agentId) {
    var caps = (doc.captures || []).filter(function (c) { return c.agentId === agentId; })
      // 同分时新的在前：与 pickCapture（adapters/index.js，按 at 降序）同一口径。
      // 否则"排第一的那条"可能是几分钟前的旧样本，而真正被 adapter 采用的是另一条。
      .sort(function (a, b) {
        return (b.score || 0) - (a.score || 0)
          || (String(b.at || "") < String(a.at || "") ? -1 : 1);
      });
    capList = caps;   // 导出按钮靠 key 回查，见 capByKey
    var a = doc.agents[agentId];
    box.innerHTML = '<button class="mini" data-act="backauth">‹ 返回平台列表</button>'
      + renderProbe(a)
      + '<div style="margin:12px 0 8px;font-size:12.5px;color:var(--ink-2)">'
      + esc(a.name) + " 共 " + caps.length + " 条候选，按「像不像积分接口」打分排序。"
      + "最高分那条就是我要的字段映射目标。</div>"
      + caps.map(function (c, i) {
          var key = capKey(c);
          var open = !!capOpen[key];
          return '<div class="cap' + (i === 0 ? " hi" : "") + '">'
            + '<div class="u">' + esc(c.method) + " " + esc(c.url) + "</div>"
            + '<div class="why">评分 ' + (c.score || 0) + " · " + esc((c.reasons || []).join("；"))
            + " · " + (c.via || "") + " · " + c.status + " · " + c.bodyLength + " 字节</div>"
            + (c.requestHeaderNames && c.requestHeaderNames.length
                ? '<div class="hh">请求头（只有名字，无值）：' + esc(c.requestHeaderNames.join(", ")) + "</div>" : "")
            + (c.truncated
                ? '<div class="hh" style="color:#9a3412">响应体被截断（共 ' + c.bodyLength
                  + " 字节，只存了前面一段），批次数组可能在后半段 —— 点「刷新余额」再试一次</div>" : "")
            + (c.bodyPreview && c.bodyPreview.length > CAP_PREVIEW
                // 完整响应默认不铺开：WorkBuddy 单条就有 130KB，六十条一起渲染会把页面卡死。
                // 要看全貌就点开这一条，或者导出成文件用编辑器看。
                ? '<div class="hh"><button class="mini" data-act="captoggle" data-key="' + esc(key) + '">'
                  + (open ? "收起" : "展开响应体（" + fmtBytes(c.bodyPreview.length) + "）") + "</button>"
                  + ' <button class="mini" data-act="capexport" data-key="' + esc(key) + '">'
                  + '导出这条</button></div>' : "")
            + "<pre>" + prettyPreview(c.bodyPreview, open ? CAP_EXPAND : CAP_PREVIEW) + "</pre></div>";
        }).join("")
      + (caps.length ? "" : '<div class="none-yet">'
        + (AG.byId(agentId).direct
            ? "还没有直读样本。点「刷新余额」，扩展会在你的 qoder.com 用量页里发一次只读请求；"
              + "如果提示未登录，登录留在前台的那个页面后再点一次。"
            : "还没截到候选。"
              + (a.lastHookAt
                  ? '钩子已经注入成功（' + ago(a.lastHookAt) + '），说明这个页面的额度数字不是用 XHR 取的 —— '
                    + "它大概率是服务端直接渲染进 HTML。在那个页面里点一下「用量/订阅」标签再回来；"
                    + "要是还是没有，这一家就只能走手动录入。"
                  : a.lastRelayAt
                    ? "中转脚本注上了，但 MAIN world 的钩子没起来 —— 多半是注入被挡，"
                      + "看看 opera://extensions 里这个扩展有没有红字报错。"
                    : "注入脚本还没起来。可能页面在你点授权之前就加载完了 —— 刷新那个页面再回来。"))
        + "</div>");
  }

  /* ---------- 样本响应体的显示 ----------
   * 单条样本最大 200KB、最多存 60 条。全量渲染进 <pre> 是 MB 级 DOM 文本，
   * 扩展页会直接卡住，所以默认只给前面一段；要看全貌由用户逐条点开或导出。
   */
  var CAP_PREVIEW = 2000;    // 折叠时展示的字符数
  var CAP_EXPAND = 40000;    // 展开后最多渲染的字符数，再大请走导出

  function capKey(c) { return (c.bodyHash || "") + "|" + c.url; }

  function capByKey(key) {
    for (var i = 0; i < capList.length; i++) if (capKey(capList[i]) === key) return capList[i];
    return null;
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    return n >= 1024 ? (n / 1024).toFixed(n >= 10240 ? 0 : 1) + " KB" : n + " 字节";
  }

  /**
   * 超过 limit 就按原文截断，**不做** JSON.parse：
   * 折叠视图对 60 条各解析一次 130KB 本身就是浪费，截断后的串也不是合法 JSON，
   * 解析必然失败。所以长的走原样截断，短的（或已展开的）才交给 pretty 格式化。
   */
  function prettyPreview(s, limit) {
    if (!s) return "";
    var raw = String(s);
    if (raw.length <= limit) return pretty(raw);
    return esc(raw.slice(0, limit))
      + "\n…（共 " + fmtBytes(raw.length) + "，只显示前 " + limit + " 字符，完整内容用「导出这条」）";
  }

  function pretty(s) {
    if (!s) return "";
    try { return esc(JSON.stringify(JSON.parse(s), null, 1)); } catch (e) { return esc(s); }
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  /* ---------- 新鲜度 / 页脚 ---------- */

  function renderFresh() {
    var el = $("#fresh");
    var hrs = doc.lastSyncAt ? (Date.now() - new Date(doc.lastSyncAt).getTime()) / 3600000 : 1e9;
    var stale = hrs > doc.settings.staleDays * 24;
    el.className = "fresh" + (stale ? " stale" : "");
    el.innerHTML = doc.lastSyncAt
      ? "数据截至 " + new Date(doc.lastSyncAt).toLocaleString("zh-CN",
          { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
        + "<br>" + (stale ? "<b>已超过 " + doc.settings.staleDays + " 天未同步，数字可能过时</b>" : "同步于 " + ago(doc.lastSyncAt))
      : "尚未同步过<br>可先手动录入";
    $("#modeTag").textContent = IS_EXT
      ? "浏览器扩展 · 数据存在本机 chrome.storage.local"
      : "file:// 预览模式 · 数据存在本机 localStorage";
  }

  /* ---------- 页脚：备份、恢复与清空 ---------- */

  /* 清空是唯一不可恢复的操作，所以走和"删一笔批次"同一套两段式确认：
   * 第一次点只改文案并给 5 秒窗口，第二次才真删。需求 §4.3 对删一笔都要求确认，
   * 删全部却一键执行，这是这条路上最不对称的地方。 */
  var wipeArmed = false, wipeTimer = null;

  function renderFoot() {
    $("#foot").innerHTML =
      "<b>已实现的规则</b><br>"
      + "① 一个批次只出现在到期那一格；② 倒计时由卡片与即将到期区承担；③ 单位不跨 agent 相加；"
      + "④ 每个 agent 有取数档位；⑤ 已过期批次降饱和加删除线、不计入可用余额；⑥ 抓取结果可手动修正，"
      + "改过的批次冻结并由你裁决冲突；⑦ 时间措辞按档位区分；⑧ 行内两段式删除；⑨ 已过期未用完沉没成本。<br>"
      + "<b>还没做的</b>：到期通知；.ics 导出。<br>"
      + '<a href="#" id="wipe" style="color:' + (wipeArmed ? "#b91c1c" : "var(--ink-3)") + '">'
      + (wipeArmed ? "确认清空全部数据？再点一次（批次 / 样本 / 授权配置都会删掉）"
                   : "清空本机数据重新开始")
      + "</a>"
      + '<span style="color:var(--ink-3)"> · </span>'
      + '<a href="#" id="impLink" style="color:var(--ink-3)">导入备份（JSON）</a>'
      + '<input type="file" id="impFile" accept=".json,application/json" hidden>';

    $("#impLink").onclick = function (e) { e.preventDefault(); $("#impFile").click(); };
    $("#impFile").onchange = function () {
      var f = this.files && this.files[0];
      this.value = "";                 // 清空 value，才能连续导入同一个文件
      if (f) readImport(f);
    };

    $("#wipe").onclick = function (e) {
      e.preventDefault();
      if (!wipeArmed) {
        wipeArmed = true; renderFoot();
        clearTimeout(wipeTimer);
        wipeTimer = setTimeout(function () { wipeArmed = false; renderFoot(); }, 5000);
        toast("这一步会删掉全部批次、捕获样本和四个平台的授权配置，无法撤销。要留底就先「导出全部数据」。");
        return;
      }
      clearTimeout(wipeTimer); wipeArmed = false;
      Store.wipe().then(function () { location.reload(); });
    };
  }

  /**
   * 导入备份。需求 §3.3 承诺的恢复路径，之前只有导出没有导入 ——
   * 所以「清空本机数据」之后用户其实无路可退，连"把导出的 JSON 贴回来"都做不到。
   *
   * 为什么先清洗再合并，而不是直接 Store.save(parsed)：文件是用户可以手改的，
   * 一个坏字段就能把 doc 结构打烂（batches 不是数组 → renderCal 抛错 → 整页白屏，
   * 而用户只会以为"导入没生效"）。清洗规则在 lib/normalize.js 的 importSnapshot。
   *
   * 合并语义：按 dedupKey 补缺，同键以**现有数据为准**（导入是恢复/拼接，
   * 不是覆盖 —— 现有数据通常更新，而且覆盖等于又造了一条不可恢复的路径）。
   */
  function readImport(file) {
    if (file.size > 8 * 1024 * 1024) { toast("文件太大（超过 8MB），不像是本扩展导出的数据"); return; }
    var fr = new FileReader();
    fr.onerror = function () { toast("读文件失败：" + ((fr.error && fr.error.message) || "未知错误")); };
    fr.onload = function () {
      var raw;
      try { raw = JSON.parse(String(fr.result || "")); }
      catch (e) { toast("这个文件不是合法 JSON：" + ((e && e.message) || "解析失败")); return; }
      applyImport(raw);
    };
    fr.readAsText(file);
  }

  function applyImport(raw) {
    var clean;
    try { clean = N.importSnapshot(raw, { agents: ORDER() }); }
    catch (e) { toast("这份备份的格式看不懂：" + ((e && e.message) || "")); return; }

    if (!clean.batches.length && !clean.captures.length) {
      toast("这份文件里没有能导入的批次或样本 —— 是别的应用导出的数据吗？");
      return;
    }

    var stats = { addedB: 0, dupB: 0, addedC: 0 };
    function merge(f) {
      // commit 会先在内存 doc 上跑一遍、再在存储里的最新文档上跑一遍，
      // 所以计数每次都要从 0 开始，否则统计会翻倍。
      stats.addedB = 0; stats.dupB = 0; stats.addedC = 0;

      var have = {};
      f.batches.forEach(function (b) { have[N.dedupKey(b)] = true; });
      clean.batches.forEach(function (b) {
        var k = N.dedupKey(b);
        if (have[k]) { stats.dupB++; return; }
        f.batches.push(b); have[k] = true; stats.addedB++;
      });

      var capKey = function (c) { return c.agentId + "|" + c.url + "|" + c.bodyHash; };
      f.captures = f.captures || [];
      var caps = {};
      f.captures.forEach(function (c) { caps[capKey(c)] = true; });
      clean.captures.forEach(function (c) {
        if (caps[capKey(c)]) return;
        caps[capKey(c)] = true;
        f.captures.push(c); stats.addedC++;
      });
    }

    commit(merge).then(function () {
      render();
      var parts = ["导入完成：批次 +" + stats.addedB];
      if (stats.dupB) parts.push("已存在跳过 " + stats.dupB);
      if (stats.addedC) parts.push("样本 +" + stats.addedC);
      if (clean.droppedBatches || clean.droppedCaptures) {
        parts.push("忽略损坏条目 " + (clean.droppedBatches + clean.droppedCaptures));
      }
      toast(parts.join("，") + "。点「立即同步」可让新样本参与计算。");
    });
  }

  function render() {
    TODAY = N.startOfDay(new Date());   // 页面可能跨零点长开，"今天"必须每次渲染现算
    renderCards(); renderCal(); renderLegend(); renderUpcoming();
    renderDetail(); renderFresh(); renderNotice(); renderFoot();
    if (authOpen) renderAuth();
  }

  /* ---------- 事件 ---------- */

  $("#cards").addEventListener("click", function (e) {
    var w = e.target.closest('[data-act="wasted"]');
    if (w) { wasted = w.getAttribute("data-agent"); edit = null; adding = false; sel = null; persist(); render(); return; }
    var c = e.target.closest('[data-act="conflicts"]');
    if (c) {
      var first = doc.batches.filter(function (b) { return b.conflict && b.agent === c.getAttribute("data-agent"); })[0];
      if (first) { edit = first.batchId; adding = false; sel = null; wasted = null; persist(); render(); }
    }
  });

  $("#grid").addEventListener("click", function (e) {
    var chip = e.target.closest("[data-bid]");
    if (chip) { edit = chip.getAttribute("data-bid"); adding = false; sel = null; wasted = null; delConfirm = null; persist(); render(); return; }
    var cell = e.target.closest(".cell");
    if (!cell || cell.classList.contains("out")) return;
    var d = cell.getAttribute("data-day");
    sel = (sel === d ? null : d); edit = null; adding = false; wasted = null; delConfirm = null;
    persist(); render();
  });

  $("#upcoming").addEventListener("click", function (e) {
    var r = e.target.closest("[data-bid]"); if (!r) return;
    edit = r.getAttribute("data-bid"); adding = false; sel = null; wasted = null; delConfirm = null;
    persist(); render();
  });

  $("#detail").addEventListener("click", function (e) {
    var t = e.target.closest("[data-act]");
    if (!t) {
      var r = e.target.closest("[data-bid]");
      if (r) { edit = r.getAttribute("data-bid"); adding = false; delConfirm = null; persist(); render(); }
      return;
    }
    var act = t.getAttribute("data-act");

    if (act === "close") { edit = null; adding = false; wasted = null; delConfirm = null; clearTimeout(confirmTimer); persist(); renderDetail(); return; }
    if (act === "add") { edit = null; adding = true; renderAdd(); return; }

    if (act === "accept") {
      var b0 = byId(edit); if (!b0) return;
      var acc = N.acceptScraped(b0);
      var accId = b0.batchId;
      commit(function (f) { replaceIn(f, accId, acc); });
      toast("已采用抓取值，该批次解除冻结");
      render(); return;
    }

    if (act === "del") {
      var b = byId(edit); if (!b) return;
      if (delConfirm !== b.batchId) {
        delConfirm = b.batchId; renderEdit($("#detail"), b);
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(function () {
          if (delConfirm === b.batchId) { delConfirm = null; renderEdit($("#detail"), byId(b.batchId)); }
        }, 4000);
        toast("再点一次就会删除这一笔，4 秒内不点自动取消");
        return;
      }
      var delId = b.batchId;
      edit = null; delConfirm = null; clearTimeout(confirmTimer);
      commit(function (f) { f.batches = f.batches.filter(function (x) { return x.batchId !== delId; }); });
      render(); toast("已删除");
      return;
    }

    if (act === "save") {
      var cur = byId(edit); if (!cur) return;
      var patch = {};
      $$("#detail [data-f]").forEach(function (inp) {
        var f = inp.getAttribute("data-f"), v = inp.value;
        if (f === "expiresAt") { if (v) patch.expiresAt = v; }
        else if (f === "remaining" || f === "granted") {
          var n = parseFloat(v);
          // 保留小数：WorkBuddy 的 Precise 字段就是小数余额，parseInt 会静默截掉
          patch[f] = isFinite(n) ? Math.max(0, n) : 0;
        }
        else patch[f] = v;
      });
      var next = N.applyManualEdit(cur, patch);
      if (!next) { toast("批次名称不能为空（只有空格也算空）"); return; }
      var oldId = cur.batchId;
      // batchId 是 32 位哈希取前 8 位，理论上会撞。补录路径已经挡了，编辑路径也得挡：
      // byId() 只返回第一个匹配，撞了就变成"改 A 实际改了 B"，而且没有提示。
      if (next.batchId !== oldId && byId(next.batchId)) {
        toast("改完会和已有批次撞车（同名同到期日），改个名字或到期日再存");
        return;
      }
      edit = next.batchId;   // batchId 随 dedupKey 变了，跟上新值
      commit(function (f) { replaceIn(f, oldId, next); });
      render(); toast("已保存，该批次已冻结，抓取值将交给你裁决");
      return;
    }

    if (act === "addsave") {
      var v = {};
      $$("#detail [data-nf]").forEach(function (inp) { v[inp.getAttribute("data-nf")] = inp.value; });
      // 只有空格的名字会变成 dedupKey 里的空段，两笔"空名"批次互相覆盖且看不出来
      v.label = String(v.label || "").trim();
      if (!v.label || !v.expiresAt) { toast("批次名称和过期日不能为空"); return; }
      var cfg = doc.agents[v.agent] || {};
      var nb = N.normalizeBatch({
        agent: v.agent, label: v.label, granted: +v.granted || 0, remaining: +v.remaining || 0,
        expiry: v.expiresAt, semantics: "lastUsableDay", unit: cfg.unit || "credits", source: "manual"
      });
      nb.manualEdited = true; nb.updatedAt = new Date().toISOString();
      if (byId(nb.batchId)) { toast("已存在同名同到期日的批次（dedupKey 命中）"); return; }
      adding = false;
      sel = nb.expiresAt; edit = nb.batchId; wasted = null; delConfirm = null;
      commit(function (f) { f.batches.push(nb); });
      render(); toast("已加入日历");
    }
  });

  /** 在传入文档上原位替换/追加批次（供 commit 的 mutator 用，别直接改 doc.batches）。 */
  function replaceIn(f, oldId, next) {
    for (var i = 0; i < f.batches.length; i++) if (f.batches[i].batchId === oldId) { f.batches[i] = next; return; }
    f.batches.push(next);
  }

  $("#prev").onclick = function () { shift(-1); };
  $("#next").onclick = function () { shift(1); };
  $("#today").onclick = function () {
    TODAY = N.startOfDay(new Date());
    view = [TODAY.getFullYear(), TODAY.getMonth()]; sel = N.ymd(TODAY);
    edit = null; adding = false; wasted = null; persist(); render();
  };
  function shift(n) {
    var d = new Date(view[0], view[1] + n, 1);
    view = [d.getFullYear(), d.getMonth()]; persist(); renderCal();
  }
  $("#thr").onchange = function () {
    // 钳制：下拉取到空值/非法值时 +this.value 是 NaN，落库后「即将到期」会永久空白
    // 且不给任何提示——用户只会以为"最近没有要过期的"，其实是阈值坏了。
    var v = parseInt(this.value, 10);
    if (!isFinite(v)) v = 14;
    v = Math.min(365, Math.max(1, v));
    commit(function (f) { f.settings.threshold = v; });
    renderUpcoming();
  };

  /* ---------- 同步 ---------- */

  $("#sync").onclick = function () {
    var btn = this;
    if (!IS_EXT) { toast("预览模式不能抓取，请装成扩展后再同步"); return; }
    btn.disabled = true; btn.textContent = "同步中…";
    chrome.runtime.sendMessage({ type: "SYNC" }, function (r) {
      btn.disabled = false; btn.textContent = "立即同步";
      if (r && r.ok) {
        var t = (r.results || []).filter(function (x) { return x.ok; }).map(function (x) {
          return x.agentId + " 新增 " + x.added + "/更新 " + x.updated
            + (x.conflicts ? "，" + x.conflicts + " 笔待裁决" : "");
        }).join("；");
        toast("同步完成：" + (t || "数字没有变化"));

        /* 数字来自哪一刻，必须说清楚：
         *   fresh === true  本次真的让页面重发了一次请求（直读或钩子），读到的是活数据
         *   fresh === false 想让页面重发但没等到响应，用的还是上次的样本
         *   fresh === null  钩子平台没装钩子，只能用样本（direct 平台不会落到这一档）
         * 三者对用户是完全不同的结论，混成一句"同步完成"会让人以为都是实时的。 */
        var fresh = (r.results || []).filter(function (x) { return x.fresh === true; });
        var staleRefresh = (r.results || []).filter(function (x) { return x.ok && x.fresh === false; });
        var hooked = (r.results || []).filter(function (x) { return x.ok && x.fresh == null; });
        var directFresh = fresh.filter(function (x) { return x.direct; });
        var hookFresh = fresh.filter(function (x) { return !x.direct; });
        if (directFresh.length) {
          toast("接口直读：" + directFresh.map(function (x) { return x.agentId; }).join("、")
            + "（在你的页面里请求了额度接口，不是旧样本）");
        }
        if (hookFresh.length) {
          toast("活体读取：" + hookFresh.map(function (x) { return x.agentId; }).join("、") + "（页面刚重新请求过）");
        }
        if (staleRefresh.length) {
          var errs = staleRefresh.map(function (x) { return x.refreshError; }).filter(Boolean);
          toast("刷新失败，用的是样本：" + staleRefresh.map(function (x) {
            return x.agentId + " " + hm(x.sampleAt);
          }).join("、") + (errs.length ? "。" + errs.join("；")
            : "。后台页可能没登录，或用量接口没被触发"));
        }
        if (hooked.length) {
          toast("这些平台没装钩子，读的是既有样本：" + hooked.map(function (x) {
            return x.agentId + " " + hm(x.sampleAt);
          }).join("、") + "。想更新就「粘贴样本」，或点「刷新余额」（临时装钩子）");
        }

        if (r.message) toast("另有平台没同步成功：" + r.message);
        Store.load().then(function (d) { doc = d; render(); });
      } else toast((r && (r.message || r.reason)) || "同步失败");
    });
  };

  /* ---------- 授权面板 ---------- */

  $("#btnAuth").onclick = function () {
    authOpen = true; authView = null; adding = false; renderAuth();
    if (!IS_EXT) toast("预览模式：可以填地址，但授权与抓取需要装成扩展");
  };
  $("#closeAuth").onclick = function () { authOpen = false; authView = null; $("#mAuth").classList.remove("on"); render(); };
  $("#mAuth").addEventListener("click", function (e) { if (e.target === this) $("#closeAuth").click(); });

  $("#authBody").addEventListener("click", function (e) {
    var t = e.target.closest("[data-act]"); if (!t) return;
    var act = t.getAttribute("data-act"), id = t.getAttribute("data-id");
    if (act === "backauth") { authView = null; renderAuth(); return; }
    if (act === "diag") { authView = "__diag__"; renderAuth(); return; }
    if (act === "caps") { authView = id; renderAuth(); return; }
    if (act === "paste") { authView = "__paste__:" + id; renderAuth(); return; }
    if (act === "captoggle") {
      var ck = t.getAttribute("data-key");
      capOpen[ck] = !capOpen[ck];
      renderAuth();
      return;
    }
    if (act === "capexport") {
      var one = capByKey(t.getAttribute("data-key"));
      if (!one) { toast("这条样本已经不在了（可能被新样本淘汰）"); return; }
      download("credit-capture-" + (authView || "agent") + "-" + Date.now() + ".json",
        JSON.stringify(one, null, 2));
      toast("已导出这一条样本。里面是平台响应体，可能带账号标识，分享前请先脱敏");
      return;
    }
    if (act === "cancelauth") {
      var ca = doc.agents[id];
      if (!ca || !ca.authPending) { toast("当前没有进行中的授权等待"); return; }
      chrome.runtime.sendMessage({ type: "UNREGISTER", origin: ca.origin }, function () {
        void chrome.runtime.lastError;
        // 后台的 UNREGISTER 已清 authPending；UI 侧再落一条结果，让状态行说明
        // 是"人取消的"而不是"莫名超时"——两种结局给用户的下一步提示完全不同。
        commit(function (f) {
          var ag = f.agents[id];
          if (!ag) return;
          ag.authPending = null;
          ag.authResult = {
            at: new Date().toISOString(), ok: false, reason: "cancelled",
            message: "你手动取消了这次授权等待，钩子已解除。"
          };
        });
        // commit 只改数据不重绘：后台虽会写存储触发 onChanged 回流，但那是异步的，
        // 这里先显式画一次，按钮立刻消失，不让用户以为没点上。
        renderAuth();
        toast("已取消等待，钩子已解除。之后可以「粘贴样本」，或随时重新点「授权」");
      });
      return;
    }
    if (act === "unhook") {
      var uo = doc.agents[id] && doc.agents[id].origin;
      if (!uo) { toast("还没授权过，没有钩子可解除"); return; }
      chrome.runtime.sendMessage({ type: "UNREGISTER", origin: uo }, function (r) {
        if (chrome.runtime.lastError) { toast("后台没响应：" + chrome.runtime.lastError.message); return; }
        toast("已解除钩子：" + uo + " 不再被截获。再要活数据点「刷新余额」（临时装钩子），或「粘贴样本」");
      });
      return;
    }
    if (act === "pastesave") {
      var pu = ($("#pasteUrl") || {}).value || "", pb = ($("#pasteBody") || {}).value || "";
      pu = pu.trim();
      if (!pu || !pb.trim()) { toast("接口地址和响应体都要填"); return; }
      chrome.runtime.sendMessage({ type: "PASTE_CAPTURE", agentId: id, url: pu, body: pb }, function (r) {
        if (chrome.runtime.lastError) { toast("后台没响应：" + chrome.runtime.lastError.message); return; }
        if (r && r.ok && r.stored) {
          toast(r.upgraded ? "样本已更新：之前截断的旧样本换成了完整响应，「立即同步」开始认这个平台"
            : (r.replaced ? "样本已更新（内容和上次相同，记录时间已刷新），「立即同步」开始认这个平台"
            : "样本已存（打分 " + r.score + "），「立即同步」开始认这个平台"));
          authView = id; renderAuth();
        } else if (r && r.ok) {
          toast("没存：" + (r.reason === "平台未登记"
            ? "这个平台没有登记在册，样本不知道该记给谁"
            : r.reason === "origin 未授权"
            ? "这个域名和该平台已授权的域名对不上"
            : "打分太低，看起来不像积分接口"));
        } else {
          toast("存样本失败：" + ((r && (r.error || r.reason)) || "未知错误"));
        }
      });
      return;
    }
    if (act === "auth") { doAuthorize(id); return; }
    if (act === "reauth") {
      var url = $('[data-url="' + id + '"]').value.trim();
      if (!url) { toast("先填后台地址"); return; }
      var isDirect = !!AG.byId(id).direct;
      /* 钩子已解除的平台，点「刷新余额」只能临时装一次：
       * 开隐藏页 → 等响应 → 关页 → 立刻注销。装钩子这件事有风险，所以只在用户
       * 亲手点这一下时发生，绝不自动、也不留在页面上。
       * 直读平台没有钩子，直接页面内请求，不存在这个风险窗口。 */
      var ephemeral = !isDirect && !doc.agents[id].hookActive;
      if (ephemeral) toast("该平台钩子已解除，这次只临时装一下：开页 → 截一次 → 立刻注销（隐藏页失败会自动改用可见页重试，可能抢一次焦点）");
      if (isDirect) toast("正在你的 Qoder 页面里刷新余额…");
      // 刷新期间把按钮禁掉：后台有互斥，但用户看不出「为什么第二次没反应」，
      // 而连点本身会踩坏探针和 hookActive（见 background 里 refreshing 的注释）。
      busyReauth(id, true);
      chrome.runtime.sendMessage({ type: "REFRESH_CAPTURES", agentId: id, ephemeral: ephemeral }, function (r) {
        busyReauth(id, false);
        if (chrome.runtime.lastError) { toast("后台没响应：" + chrome.runtime.lastError.message); return; }
        if (!r) { toast("后台没回话"); return; }
        if (r.busy) { toast(r.error || "上一次刷新还没结束"); return; }
        if (r.ok) {
          if (r.fallback && r.fallback.ok) {
            // v0.3.14：页面自己一次额度接口都没发，扩展在页面上下文里代发成功。
            // 这件事必须说出来——不然用户会以为数字是从页面缓存里读的。
            toast("页面这次没自己请求额度接口，扩展在你的页面里代发了一次（HTTP "
              + r.fallback.status + "，"
              + (r.fallback.duplicate ? "和上次逐字节相同，余额没变" : "已存为新样本") + "）");
          } else if (isDirect) {
            toast(r.changed ? "已读取最新余额（有更新）" : "已读取最新余额（和上次一样，数字没变）");
          } else {
            toast(r.changed
              ? (ephemeral ? "已截到新响应，钩子已注销" : "已截到新响应")
              : (r.upgraded ? "后台页有响应：之前截断的旧样本已替换为完整响应"
              : "后台页有响应，但内容和上次一样（数字确实没变）"));
          }
          // 截获之后后台已经顺手对该平台跑了一次同步，把批次变化说出来，
          // 否则用户只知道"截到了"，不知道日历到底动没动。
          var s = r.sync;
          if (s && s.ok) {
            toast("日历已更新：" + id + " 新增 " + s.added + "/更新 " + s.updated
              + (s.conflicts ? "，" + s.conflicts + " 笔待裁决" : "")
              + (s.added || s.updated || s.conflicts ? "" : "（数字无变化）"));
          } else if (s) {
            toast("样本读到了，但没能算进日历：" + (s.message || s.reason));
          }
        } else {
          // 失败时不许只说"没读到"：探针已经把断点定位出来了，直接讲人话
          toast(r.error || r.diagnosis || "没读到数据");
          var p = r.probe;
          if (p && p.mode === "direct") {
            toast("诊断：接口 " + (p.endpoint || "?") + " · HTTP " + (p.httpStatus || "无")
              + " · 响应 " + (p.bodyBytes || 0) + " 字节"
              + " · 开页尝试 " + (p.attempts || []).map(function (x) {
                  return (x.visible ? "可见页" : "隐藏页") + "/" + (x.tabStatus || "?");
                }).join("，")
              + "。点「读取诊断」看完整记录");
          } else if (p) {
            toast("诊断细节：钩子" + (p.hookAt ? "已注入" : "没注入")
              + " · 页面发出 " + p.responses + " 个响应"
              + " · 像积分接口的 " + p.candidates + " 个"
              + " · 入库 " + p.stored + " · 判重 " + p.dups
              + " · 尝试了 " + p.attempts.length + " 次（" +
              p.attempts.map(function (x) { return (x.visible ? "可见页" : "隐藏页") + "/" + (x.tabStatus || "?"); }).join("，") + "）"
              + "。点「截获诊断」看完整记录");
          }
          if (r.tabLeftOpen) {
            toast(isDirect
              ? "登录页给你留在前台了：登录后回来再点「刷新余额」"
              : "那个标签页给你留着没关（钩子已注销），看一眼它是登录态还是空页面");
          }
        }
        Store.load().then(function (d) { doc = d; renderAuth(); render(); });
      });
      return;
    }
  });

  /* 填了地址就记下，不必等点「授权」——否则关掉面板一改回来全没了 */
  $("#authBody").addEventListener("change", function (e) {
    var inp = e.target.closest("[data-url]"); if (!inp) return;
    var id = inp.getAttribute("data-url");
    var url = (inp.value || "").trim();
    if (!url) return;
    try { if (new URL(url).protocol !== "https:") { toast("只支持 https 地址"); return; } }
    catch (err) { toast("地址格式不对，要贴完整的 https 链接"); return; }
    var origin = new URL(url).origin;
    commit(function (f) {
      if (f.agents[id]) { f.agents[id].consoleUrl = url; f.agents[id].origin = origin; }
    });
    renderAuth();   // change 已经在失焦之后触发，重画一次让按钮状态跟上
  });

  /**
   * 刷新期间置灰「刷新余额」。后台有互斥（repeated click 会被拒），但按钮不 disable
   * 的话用户只会觉得"点了没反应"；而且连点正是踩坏探针/hookActive 的入口。
   * 回调里必须先复原再处理结果：失败分支可能直接 return，不会走到重绘。
   */
  function busyReauth(id, on) {
    $$('[data-act="reauth"][data-id="' + id + '"]').forEach(function (b) {
      b.disabled = !!on;
      b.textContent = on ? "刷新中…" : "刷新余额";
    });
  }

  function doAuthorize(id) {
    var inp = $('[data-url="' + id + '"]');
    var url = (inp.value || "").trim();
    var origin;
    try {
      var u = new URL(url);
      if (u.protocol !== "https:") { toast("只支持 https 地址"); return; }
      origin = u.origin;
    } catch (e) { toast("地址格式不对，要贴完整的 https 链接"); return; }

    if (!IS_EXT) { commit(function (f) { if (f.agents[id]) f.agents[id].consoleUrl = url; }); toast("预览模式：地址已记下，授权需装成扩展"); return; }

    var pattern = origin + "/*";

    // 先看权限是不是已经有了：手动在浏览器设置里给过、或上次授权过，
    // 这种情况再去 request 反而可能拿到 false（重复请求会被静默拒）。
    chrome.permissions.contains({ origins: [pattern] }, function (already) {
      if (chrome.runtime.lastError) {
        failAuth(id, "contains 调用失败：" + chrome.runtime.lastError.message);
        return;
      }
      if (already) { openAndHook(id, origin, url); return; }

      chrome.permissions.request({ origins: [pattern] }, function (granted) {
        // lastError 必须读出来：不读它就分不清「用户点了拒绝」「不是用户手势」
        // 「Opera 压根没弹窗」这三种情况，而它们的解法完全不同。
        var err = chrome.runtime.lastError;
        if (granted) { openAndHook(id, origin, url); return; }
        failAuth(id, err
          ? "权限请求被拒：" + err.message
          : "权限请求返回未授予，但没有报错信息 —— 多半是浏览器根本没弹授权窗。"
            + "点「权限自检」看详情，或按自检页里的手动授权办法来。");
      });
    });
  }

  function openAndHook(id, origin, url) {
    chrome.runtime.sendMessage({ type: "REGISTER_AND_OPEN", agentId: id, origin: origin, url: url },
      function (r) {
        if (chrome.runtime.lastError) {
          failAuth(id, "后台没响应：" + chrome.runtime.lastError.message);
          return;
        }
        if (!r || !r.ok) { failAuth(id, "注入失败：" + ((r && r.error) || "未知错误")); return; }
        // 后台已经把 consoleUrl / origin / authPending 写进存储了。
        // 这里不能再 persist() 本地旧 doc，否则会用旧快照把刚写下的授权等待状态覆盖掉。
        toast(r.worldAware
          ? "已打开后台页。请在里面登录，登录后会自动读取并写入日历，不用再点「刷新余额」"
          : "已打开，但本浏览器不支持注入到页面上下文，只能读 DOM（样本可能截不到）");
        Store.load().then(function (d) { doc = d; renderAuth(); render(); });
      });
  }

  function failAuth(id, msg) {
    commit(function (f) { if (f.agents[id]) f.agents[id].lastError = msg; });
    toast(msg);
    renderAuth();
  }

  $("#expCap").onclick = function () {
    if (!(doc.captures || []).length) { toast("还没有捕获样本"); return; }
    download("credit-captures-" + N.ymd(new Date()) + ".json", JSON.stringify({
      exportedAt: new Date().toISOString(),
      note: "请求头只保留名字、不含值；bodyPreview 是平台原始响应，可能包含账号标识（如 Uin / payerUin / ResourceId），请勿上传到公开仓库或直接发给他人。",
      agents: doc.agents, captures: doc.captures
    }, null, 2));
    toast("样本已导出：含响应体，可能带账号标识；分享前先脱敏，别传到公开仓库");
  };
  $("#expDoc").onclick = function () {
    download("credit-calendar-" + N.ymd(new Date()) + ".json", JSON.stringify(doc, null, 2));
    toast("全部数据已导出：包含捕获样本，可能带账号标识；别上传到公开仓库");
  };

  boot();
})();
