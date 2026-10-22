/*
 * normalize.js — 积分批次的归一化、去重键、以及"抓取结果与手动修正合并"的规则。
 * 这是整个工具唯一的事实规则层：抓取层和 UI 都不允许自己发明合并逻辑。
 *
 * 同时被三处使用：service worker（importScripts）、扩展页面（<script>）、node 单测（require）。
 * 所以只用 ES5 安全写法 + UMD 导出，不依赖任何 DOM 或 chrome.* 。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CreditNormalize = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var MS_DAY = 86400000;

  /* ---------- 日期工具 ---------- */

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function ymd(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  /** 'YYYY-MM-DD' -> 本地零点的 Date。无效输入返回 null。 */
  function parseYmd(s) {
    if (typeof s !== "string") return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (isNaN(d.getTime())) return null;
    // 拒绝 2026-02-31 这类溢出
    if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
    return d;
  }

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  function addDays(d, n) { return startOfDay(new Date(d.getTime() + n * MS_DAY)); }

  /** 距今剩余天数。expiresAt 是"最后一个可用日"，所以今天到期 = 0。 */
  function daysLeft(expiresAt, today) {
    var e = parseYmd(expiresAt), t = today || startOfDay(new Date());
    if (!e) return null;
    return Math.round((e.getTime() - startOfDay(t).getTime()) / MS_DAY);
  }

  function statusOf(expiresAt, now) {
    var e = parseYmd(expiresAt);
    if (!e) return "unknown";
    return e.getTime() < startOfDay(now || new Date()).getTime() ? "expired" : "active";
  }

  /* ---------- 过期时间语义 ---------- */

  /**
   * 把各平台五花八门的写法统一成"最后一个可用日" YYYY-MM-DD。
   *
   * semantics:
   *   "lastUsableDay"  原文是 valid until Oct 31  → 10-31 仍可用，11-01 起失效
   *   "resetsAt"       原文是 resets on Nov 1     → 11-01 清零，最后可用日是 10-31
   *   省略时按值的形态猜：带时间/时刻的一律当 resetsAt，纯日期当 lastUsableDay。
   *
   * 返回 { expiresAt, resetInstant, source } ；无法解析返回 null。
   */
  function toExpiresAt(value, semantics, yearHint) {
    if (value == null || value === "") return null;

    // 纯毫秒时间戳
    if (typeof value === "number" && isFinite(value)) {
      return fromInstant(new Date(value), yearHint);
    }

    if (value instanceof Date) return fromInstant(value, yearHint);

    var s = String(value).trim();

    // 已经是标准 YYYY-MM-DD
    if (parseYmd(s)) {
      return { expiresAt: s, resetInstant: null, source: "iso-date" };
    }

    // ISO 时刻，可能带 Z 或时区偏移
    // 秒和毫秒也要解析：没有时区后缀时不能把整串交给 Date（各引擎对无时区串的处理不一致），
    // 这里按本地时间显式构造；LobsterAI 的 expiresAt 就带秒。
    var iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(s);
    if (iso) {
      var hasZone = s.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(s);
      var d = hasZone ? new Date(s) : new Date(
        +iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5],
        +(iso[6] || 0), iso[7] ? +((iso[7] + "00").slice(0, 3)) : 0
      );
      if (!isNaN(d.getTime())) {
        return semantics === "lastUsableDay"
          ? { expiresAt: ymd(d), resetInstant: null, source: "iso-instant" }
          : fromInstant(d, yearHint);
      }
    }

    // 英文形态：resets on Nov 1, 2026 / renews on 2026/11/01
    var reset = /\b(reset|renew|expire[sd]?|refresh)\w*\s+(?:on|at)\s+([^\s,]+[, ]+[^\s,]+.*)$/i.exec(s);
    if (reset) {
      var rd = parseLooseDate(reset[2], yearHint);
      if (rd) return fromInstant(rd, yearHint);
    }

    // valid until / until / to：Oct 31, 2026
    var until = /\b(valid\s+until|until|through|to)\s+(.+)$/i.exec(s);
    if (until) {
      var ud = parseLooseDate(until[2], yearHint);
      if (ud) return { expiresAt: ymd(startOfDay(ud)), resetInstant: null, source: "text-until" };
    }

    // 兜底：整串当日期解析
    var loose = parseLooseDate(s, yearHint);
    if (loose) return { expiresAt: ymd(startOfDay(loose)), resetInstant: null, source: "loose" };

    return null;
  }

  /**
   * 清零时刻 -> 最后可用日。
   *
   * 一律取该时刻的前一天，不区分"零点清零"还是"当天 09:00 清零"：
   * 后者虽然当天早上还能用几小时，但把到期日标在那一天会让人误以为"一整天都能用"，
   * 从而白白损失积分。宁可少标一天，精确时刻通过 resetInstant 在 UI 上单独说明。
   */
  function fromInstant(d, yearHint) {
    return {
      expiresAt: ymd(addDays(startOfDay(d), -1)),
      resetInstant: d.toISOString(),
      source: "instant"
    };
  }

  var MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  /** 宽松解析：'Nov 1, 2026' / '2026/11/1' / '1 Nov 2026' / 'Nov 1'（缺年份用 yearHint） */
  function parseLooseDate(str, yearHint) {
    var s = String(str).trim().replace(/[.]/g, " ").replace(/,/g, " ").replace(/\s+/g, " ");
    var m;

    m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

    m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/.exec(s);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);

    m = /^([a-z]{3,9})\s+(\d{1,2})(?:\s+(\d{4}))?$/i.exec(s);
    if (m) {
      var mo = monthIndex(m[1]);
      if (mo != null) return new Date(+(m[3] || yearHint || new Date().getFullYear()), mo, +m[2]);
    }

    m = /^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?$/i.exec(s);
    if (m) {
      var mo2 = monthIndex(m[2]);
      if (mo2 != null) return new Date(+(m[3] || yearHint || new Date().getFullYear()), mo2, +m[1]);
    }

    var t = Date.parse(s);
    return isNaN(t) ? null : new Date(t);
  }

  function monthIndex(name) {
    var k = String(name).slice(0, 3).toLowerCase();
    return Object.prototype.hasOwnProperty.call(MON, k) ? MON[k] : null;
  }

  /* ---------- 去重键与 id ---------- */

  function normLabel(label) {
    return String(label == null ? "" : label).trim().toLowerCase().replace(/\s+/g, " ");
  }

  /**
   * dedupKey：判断"这是老批次更新还是新批次"的唯一依据。
   * 故意不含 remaining —— 它每次同步都在变。
   */
  function dedupKey(b) {
    return [b.agent, normLabel(b.label), b.expiresAt].join("|");
  }

  /** 冻结批次专用的松匹配键：不含 expiresAt，见 mergeBatches 里的说明 */
  function frozenKey(b) {
    return [b.agent, normLabel(b.label)].join("|");
  }

  function hash6(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16) + "000000".slice(0, 6 - Math.min(6, (h >>> 0).toString(16).length));
  }

  /**
   * 内容指纹：判断"这份响应体和已存的那份是不是逐字节相同"。
   *
   * 为什么不用 bodyLength：额度数字变了但位数没变（1873 → 1870）时长度完全一样，
   * 拿长度当去重键会把"页面刚返回的新数据"误判成重复样本丢掉，样本永远停在旧值，
   * 表现为"重新截获后数字不刷新"。所以这里对整份 body 做双 rolling hash（32+32 位），
   * 再拼上长度，碰撞概率对单平台几十条样本而言可以忽略。
   */
  function contentHash(str) {
    var s = String(str == null ? "" : str);
    var h1 = 0x811c9dc5, h2 = 0x1000193;   // FNV-1a 与一个独立乘子，双路降低碰撞
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      // 必须用 Math.imul：普通乘法在 32 位量级上会溢出 2^53（h1 那一路最大 7.2e16、
      // h2 更是 9.6e18），静默丢掉低位——结果仍确定，但有效位数缩水、哈希质量下降。
      // 这里每几十条样本比一次全等，位数少了碰撞概率就会上来。
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
      h2 ^= h2 >>> 13;
    }
    return s.length + "-" + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  }

  function batchId(agent, key) { return agent + "-" + hash6(key).slice(0, 8); }

  /**
   * 稳定短码：同一个 seed 每次同步都得到同一个值（8 位 hex）。
   *
   * 用来给「同名 + 同到期日」的多笔批次做区分——WorkBuddy 的裂变包、TRAE 的签到
   * 奖励一天能有十几笔完全同名，只加日期后缀仍会撞 dedupKey，被并成一笔就等于
   * 丢掉一笔真实余额。只存短码、不存原始 id（ResourceId / payerUin 等不落盘）。
   *
   * FNV-1a + 位混淆：避免只差末尾字符的 id 在截断后撞码。
   * TRAE 与 WorkBuddy 共用这一份，两家的短码风格必须一致。
   */
  function stableTag(seed) {
    if (!seed) return "";
    var h = 0x811c9dc5;
    for (var i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    var s = (h >>> 0).toString(16);
    while (s.length < 8) s = "0" + s;
    return s.slice(-8);
  }

  /**
   * 到期日的「MM-DD」后缀，换算走 toExpiresAt，不由调用方自己减一天。
   * adapter 用它拼 label，保证 label 里的日期和列表里显示的到期日永远一致。
   */
  function daySuffix(value, semantics, yearHint) {
    var exp = toExpiresAt(value, semantics, yearHint);
    return exp ? exp.expiresAt.slice(5) : null;
  }

  /* ---------- 抓取结果 -> 批次 ---------- */

  /**
   * 把某个平台 adapter 解析出的原始条目转成标准批次。
   * raw: { agent, label, granted, remaining, expiry, semantics, unit }
   */
  function normalizeBatch(raw, opts) {
    opts = opts || {};
    if (!raw || !raw.agent) return null;
    var exp = toExpiresAt(raw.expiry != null ? raw.expiry : raw.expiresAt, raw.semantics, opts.yearHint);
    if (!exp) return null;

    var b = {
      agent: raw.agent,
      label: String(raw.label == null ? "未命名批次" : raw.label).trim(),
      unit: raw.unit || "credits",
      granted: numOr(raw.granted, 0),
      remaining: numOr(raw.remaining, numOr(raw.granted, 0)),
      expiresAt: exp.expiresAt,
      resetInstant: exp.resetInstant,
      capturedAt: (opts.now || new Date()).toISOString(),
      source: raw.source || "auto",
      manualEdited: false,
      status: statusOf(exp.expiresAt, opts.now)
    };
    b.batchId = batchId(b.agent, dedupKey(b));
    // 不再往批次对象上挂 _expSource：它是"这条到期日是走哪条解析规则算出来的"
    // 调试信息，跟着批次一起落盘、一起被导出，但没有任何消费方。真要查时拿
    // expiresAt 再跑一次 toExpiresAt 就能拿到 source，不必留在领域对象里。
    return b;
  }

  function numOr(v, fallback) {
    var n = typeof v === "string" ? parseFloat(v.replace(/[,\s]/g, "")) : v;
    return typeof n === "number" && isFinite(n) ? n : fallback;
  }

  /* ---------- 合并：抓取结果 vs 已有数据 ---------- */

  /**
   * 规则（对应 REQUIREMENTS.md 决策 6）：
   *   1. dedupKey 命中 -> 更新；未命中 -> 新增。绝不因为"这次没抓到"就删除，
   *      否则平台某次只展示部分批次就会把历史抹掉。
   *   2. 已手动改过的批次：过期日、名称、总量一律不动。抓到的剩余量放进
   *      scraped.remaining，并标 conflict=true 交给 UI 让用户裁决，
   *      不静默选边——静默选哪边都可能是错的。
   *      冻结批次额外按 (agent+label) 兜底匹配，用户改的经常就是 expiresAt。
   *   3. 未手动改过的批次：抓取值直接覆盖，并记 absentCount=0。
   *   4. 这次没出现的批次 absentCount++，供 UI 提示"该平台已连续 N 次没返回这笔"。
   *      只在本次 incoming 覆盖到的 agent 内部计算；incoming 为空视为抓取失败，
   *      什么都不记——"抓不到"和"没有了"必须区分开。
   *
   * 返回 { batches, added, updated, conflicts, unchanged } ，batches 是新数组，不改动入参。
   */
  function mergeBatches(existing, incoming, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var byKey = {}, out = [], i;

    for (i = 0; i < existing.length; i++) {
      var e = Object.assign({}, existing[i]);
      byKey[dedupKey(e)] = e;
      out.push(e);
    }

    var added = 0, updated = 0, conflicts = 0, unchanged = 0;
    var seen = {};

    // 手改过的批次额外按 (agent + label) 建索引。用户手改的经常就是过期日，
    // 一改 dedupKey 就变了，下次同步会把它当新批次再加一遍，页面上出现两笔同名、
    // 到期日不同的钱——所以先用全键找，找不到再按名字找冻结批次。
    var frozenByName = {};
    for (i = 0; i < out.length; i++) {
      if (out[i].manualEdited) frozenByName[frozenKey(out[i])] = out[i];
    }

    for (i = 0; i < incoming.length; i++) {
      var n = incoming[i];
      var k = dedupKey(n);
      seen[k] = true;
      var cur = byKey[k] || frozenByName[frozenKey(n)];
      if (cur) seen[dedupKey(cur)] = true;

      if (!cur) {
        var created = Object.assign({}, n);
        created.absentCount = 0;
        out.push(created);
        byKey[k] = created;
        added++;
        continue;
      }

      cur.absentCount = 0;

      if (cur.manualEdited) {
        // 过期状态照常跟着（用户填的）到期日走。手改之后这个分支是它唯一的更新入口，
        // 不更新的话一个早已过期的冻结批次会永远挂着 status:"active"——
        // 现在 UI 一律用 daysLeft 判断所以看不出来，但 status 是领域模型字段，
        // 一旦导出或筛选用到它就会错。
        cur.status = statusOf(cur.expiresAt, now);

        // 冲突判定要跟"用户当前认的值"比，不是跟上次抓取值比——
        // 否则第一次同步必然误报冲突。
        var differs = n.remaining !== cur.remaining || n.granted !== cur.granted
          || n.expiresAt !== cur.expiresAt;
        if (differs) {
          cur.scraped = {
            remaining: n.remaining, granted: n.granted,
            expiresAt: n.expiresAt, capturedAt: now.toISOString()
          };
          cur.conflict = true;
          conflicts++;
        } else {
          delete cur.scraped;
          delete cur.conflict;
        }
        unchanged++;
        continue;
      }

      var touched = false;
      if (cur.remaining !== n.remaining) { cur.remaining = n.remaining; touched = true; }
      if (cur.granted !== n.granted) { cur.granted = n.granted; touched = true; }
      if (cur.expiresAt !== n.expiresAt) {
        cur.expiresAt = n.expiresAt;
        cur.batchId = batchId(cur.agent, dedupKey(cur));
        touched = true;
      }
      if (touched) {
        cur.capturedAt = now.toISOString();
        cur.status = statusOf(cur.expiresAt, now);
        delete cur.conflict;
        delete cur.scraped;
        updated++;
      } else {
        unchanged++;
      }
    }

    // "这次没出现" 只在同一次同步覆盖到的 agent 内部成立：只同步 Qoder 时，
    // 不能顺手把 TRAE 的批次记成缺席，否则 absentCount 会被别家的同步刷脏。
    var agentsInIncoming = {};
    for (i = 0; i < incoming.length; i++) { if (incoming[i]) agentsInIncoming[incoming[i].agent] = true; }

    for (i = 0; i < out.length; i++) {
      var b = out[i];
      if (!seen[dedupKey(b)] && agentsInIncoming[b.agent]) {
        b.absentCount = (b.absentCount || 0) + 1;
        b.status = statusOf(b.expiresAt, now);
      }
    }

    return { batches: out, added: added, updated: updated, conflicts: conflicts, unchanged: unchanged };
  }

  /** 用户手动改过之后调用：冻结该批次并清掉冲突标记 */
  function applyManualEdit(batch, patch) {
    var b = Object.assign({}, batch, patch);
    b.manualEdited = true;
    b.updatedAt = new Date().toISOString();
    if (b.source === "auto") b.source = "manual";
    delete b.conflict;
    b.batchId = batchId(b.agent, dedupKey(b));
    b.status = statusOf(b.expiresAt);
    return b;
  }

  /** 冲突时用户选择"采用抓取值" */
  function acceptScraped(batch) {
    var b = Object.assign({}, batch);
    if (b.scraped) {
      b.remaining = b.scraped.remaining;
      b.granted = b.scraped.granted;
      b.capturedAt = b.scraped.capturedAt;
    }
    delete b.scraped;
    delete b.conflict;
    b.manualEdited = false;
    b.source = "auto";
    return b;
  }

  /* ---------- 隐私：捕获样本脱敏 ---------- */

  /** 只保留 header 的名字，绝不保留值；body 截断。捕获样本要给用户看、也可能被贴给我。 */
  function sanitizeCapture(entry, maxBody) {
    // 上限要够大：adapter 后面要靠这份样本反推字段映射，截太早会看不到批次数组的尾部。
    // WorkBuddy 的 40 余笔 free-packages 响应约 130KB，60KB 会截在 Accounts 数组中间，
    // 每次刷新都只能得到 truncated。默认与 capture-main 的 200KB 对齐。
    // 请求头的值一律不存（只存名字），所以这里存的只有响应体。
    var limit = maxBody || 200000;
    var body = typeof entry.body === "string" ? entry.body : safeJson(entry.body);
    var names = [];
    var h = entry.requestHeaders || {};
    Object.keys(h).forEach(function (k) { names.push(k); });

    return {
      url: entry.url,
      method: entry.method || "GET",
      status: entry.status,
      requestHeaderNames: names,
      bodyPreview: body.length > limit ? body.slice(0, limit) + "\n…(truncated)" : body,
      bodyLength: body.length,
      bodyHash: contentHash(body),
      truncated: body.length > limit,
      at: new Date().toISOString()
    };
  }

  function safeJson(v) {
    try { return typeof v === "string" ? v : JSON.stringify(v); }
    catch (e) { return String(v); }
  }

  return {
    ymd: ymd, parseYmd: parseYmd, startOfDay: startOfDay, addDays: addDays,
    daysLeft: daysLeft, statusOf: statusOf,
    toExpiresAt: toExpiresAt, parseLooseDate: parseLooseDate,
    dedupKey: dedupKey, batchId: batchId, normalizeBatch: normalizeBatch,
    stableTag: stableTag, daySuffix: daySuffix,
    mergeBatches: mergeBatches, applyManualEdit: applyManualEdit, acceptScraped: acceptScraped,
    sanitizeCapture: sanitizeCapture, numOr: numOr, contentHash: contentHash
  };
});
