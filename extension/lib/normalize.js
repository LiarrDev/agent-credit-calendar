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

  function daysLeft(expiresAt, today) {
    var e = parseYmd(expiresAt), t = today || startOfDay(new Date());
    if (!e) return null;
    return Math.round((e.getTime() - startOfDay(t).getTime()) / MS_DAY);
  }

  function expiryInstant(batch) {
    if (!batch.resetInstant) return null;
    var d = new Date(batch.resetInstant);
    // 手改日期后，原始时刻只留作来源依据，不覆盖用户选定的日期。
    return !isNaN(d.getTime()) && ymd(d) === batch.expiresAt ? d : null;
  }

  function formatExpiry(batch) {
    var d = expiryInstant(batch);
    return d ? ymd(d) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
      : batch.expiresAt + "（具体时间未知）";
  }

  function statusOf(expiresAt, now, resetInstant) {
    var e = parseYmd(expiresAt);
    if (!e) return "unknown";
    var d = expiryInstant({ expiresAt: expiresAt, resetInstant: resetInstant });
    if (d) return d.getTime() <= (now || new Date()).getTime() ? "expired" : "active";
    return e.getTime() < startOfDay(now || new Date()).getTime() ? "expired" : "active";
  }

  /* ---------- 过期时间语义 ---------- */

  // 时刻按本地日期展示并保留精度；lastUsableDay 或纯日期不推测具体时分。
  function toExpiresAt(value, semantics, yearHint) {
    if (value == null || value === "") return null;

    if (typeof value === "number" && isFinite(value) || value instanceof Date) {
      var instant = fromInstant(new Date(value));
      if (instant && semantics === "lastUsableDay") instant.resetInstant = null;
      return instant;
    }

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
          : fromInstant(d);
      }
    }

    // 英文形态：resets on Nov 1, 2026 / renews on 2026/11/01
    var reset = /\b(reset|renew|expire[sd]?|refresh)\w*\s+(?:on|at)\s+([^\s,]+[, ]+[^\s,]+.*)$/i.exec(s);
    if (reset) {
      var rd = parseLooseDate(reset[2], yearHint);
      if (rd) return fromInstant(rd);
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

  function fromInstant(d) {
    if (isNaN(d.getTime())) return null;
    return {
      expiresAt: ymd(d),
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

  function actualExpiryLabel(b, expiresAt) {
    if (["trae", "workbuddy", "lobsterai"].indexOf(b.agent) < 0 || !b.resetInstant) return b.label;
    var d = new Date(b.resetInstant);
    if (isNaN(d.getTime())) return b.label;
    var oldDay = ymd(addDays(startOfDay(d), -1)).slice(5), actualDay = ymd(d).slice(5);
    return String(b.label).replace(/ (\d{2}-\d{2})( · [a-f0-9]{8})?$/, function (match, day, tag) {
      return day === oldDay || day === actualDay ? " " + (expiresAt || ymd(d)).slice(5) + (tag || "") : match;
    });
  }

  function migrateExpiry(batch) {
    var b = Object.assign({}, batch);
    var d = b.resetInstant ? new Date(b.resetInstant) : null;
    if (d && !isNaN(d.getTime())) {
      if (!b.manualEdited && b.source !== "manual") {
        b.label = actualExpiryLabel(b);
        b.expiresAt = ymd(d);
        b.batchId = batchId(b.agent, dedupKey(b));
      }
      b.status = statusOf(b.expiresAt, null, b.resetInstant);
    }
    if (b.scraped && ["qoder", "trae", "workbuddy", "lobsterai"].indexOf(b.agent) >= 0) {
      var old = parseYmd(b.scraped.expiresAt);
      if (old) {
        // 旧冲突快照只存减过一天的日期，不能借用旧批次的时分冒充新抓取时刻。
        var expiresAt = ymd(new Date(old.getFullYear(), old.getMonth(), old.getDate() + 1));
        b.scraped = Object.assign({}, b.scraped, {
          expiresAt: expiresAt, resetInstant: null, label: actualExpiryLabel(b, expiresAt)
        });
      }
    }
    return b;
  }

  function frozenKey(b) {
    // 冻结批次保留旧名称，匹配时换算日期后缀，避免升级后多出一笔。
    return [b.agent, normLabel(actualExpiryLabel(b))].join("|");
  }

  /**
   * 32 位哈希 -> 定长 8 位 hex。
   *
   * 以前是 "取前 8 位" 但拼零逻辑写错了，实际长度在 6/7/8 之间浮动（3000 次实测
   * 6 位 9 次、7 位 184 次、8 位 2807 次）。batchId 是导出文件里的字段、也是 UI
   * meta 里给人看的东西，长度不定会让"同一个格式"这句话不成立，也更容易和真实
   * 名字混淆。一位不多、一位不少。
   */
  function hash8(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
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

  function batchId(agent, key) { return agent + "-" + hash8(key); }

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
      status: statusOf(exp.expiresAt, opts.now, exp.resetInstant)
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
   *   5. opts.authoritative 里标了 true 的 agent（当前只有 LobsterAI）例外：它的
   *      额度接口一次性返回**当下全部**批次，没出现就是真的不在了（花完 / 被平台
   *      回收 / 被新的一笔替代）。这种批次标 closed=true，不删历史但不再计入余额。
   *      为什么必须这么做：平台把花完的批次直接从列表里摘掉（不是给 0），
   *      只靠规则 4 的话它会永远停在最后一次见到的非 0 余额上，「可用」比后台只多
   *      不少、而且每次同步都只报「数字无变化」——正是 v0.3.17 修的那个毛病。
   *      手改过的批次不自动关：那是用户自己认定的钱，只记 absentCount 让他裁决。
   *
   * 返回 { batches, added, updated, conflicts, unchanged, closed, reopened }，
   * batches 是新数组，不改动入参。closed = 本次新关掉的笔数，
   * reopened = 本次因为平台又返回而重新计入的笔数。
   */
  function mergeBatches(existing, incoming, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    // { agentId: true } —— 这份响应是否枚举了该平台当下的全部批次（见规则 5）
    var authoritative = opts.authoritative || {};
    var byKey = {}, out = [], i;

    for (i = 0; i < existing.length; i++) {
      var e = Object.assign({}, existing[i]);
      byKey[dedupKey(e)] = e;
      out.push(e);
    }

    var added = 0, updated = 0, conflicts = 0, unchanged = 0, closed = 0, reopened = 0;
    var seen = {};

    // 手改过的批次额外按 (agent + label) 建索引。用户手改的经常就是过期日，
    // 一改 dedupKey 就变了，下次同步会把它当新批次再加一遍，页面上出现两笔同名、
    // 到期日不同的钱——所以先用全键找，找不到再按名字找冻结批次。
    //
    // 同名可能有多笔（WorkBuddy 的裂变包一天十几笔同名），所以这里存的是队列：
    // 以前只留最后一个，另一笔永远匹配不上，absentCount 会无上限增长，UI 上一直
    // 显示"最近 N 次同步没返回这笔"，看着像抓取坏了，其实是匹配坏了。
    var frozenByName = {};
    for (i = 0; i < out.length; i++) {
      if (out[i].manualEdited) {
        var fk0 = frozenKey(out[i]);
        (frozenByName[fk0] || (frozenByName[fk0] = [])).push(out[i]);
      }
    }

    /** 从同名队列里领一笔，并把它标记为已用（同一个对象不会被两笔 incoming 领走） */
    function takeFrozen(n) {
      var arr = frozenByName[frozenKey(n)];
      if (!arr || !arr.length) return null;
      return arr.shift();
    }
    /** byKey 命中时，同一个对象如果还在某个同名队列里，也要移出去 */
    function dropFrozen(obj) {
      var arr = frozenByName[frozenKey(obj)];
      if (!arr) return;
      var idx = arr.indexOf(obj);
      if (idx >= 0) arr.splice(idx, 1);
    }

    for (i = 0; i < incoming.length; i++) {
      var n = incoming[i];
      var k = dedupKey(n);
      seen[k] = true;
      var cur = byKey[k] || takeFrozen(n);
      if (cur) {
        seen[dedupKey(cur)] = true;
        dropFrozen(cur);
      }

      if (!cur) {
        var created = Object.assign({}, n);
        created.absentCount = 0;
        out.push(created);
        byKey[k] = created;
        added++;
        continue;
      }

      cur.absentCount = 0;

      // 之前判为"已不在后台"的批次又回来了（平台临时漏项、或用户补买/恢复）：
      // 立刻重新计入余额，closedAt 也不留——它现在是一笔活钱。
      if (cur.closed) {
        delete cur.closed;
        delete cur.closedAt;
        reopened++;
      }

      if (cur.manualEdited) {
        cur.status = statusOf(cur.expiresAt, now, cur.resetInstant);

        // 冲突判定要跟"用户当前认的值"比，不是跟上次抓取值比——
        // 否则第一次同步必然误报冲突。
        var differs = n.remaining !== cur.remaining || n.granted !== cur.granted
          || n.expiresAt !== cur.expiresAt || (n.resetInstant || null) !== (cur.resetInstant || null);
        if (differs) {
          cur.scraped = {
            label: n.label, remaining: n.remaining, granted: n.granted,
            expiresAt: n.expiresAt, resetInstant: n.resetInstant || null, capturedAt: now.toISOString()
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
      if ((cur.resetInstant || null) !== (n.resetInstant || null)) {
        cur.resetInstant = n.resetInstant || null;
        touched = true;
      }
      if (cur.expiresAt !== n.expiresAt) {
        cur.expiresAt = n.expiresAt;
        cur.batchId = batchId(cur.agent, dedupKey(cur));
        touched = true;
      }
      cur.status = statusOf(cur.expiresAt, now, cur.resetInstant);
      if (touched) {
        cur.capturedAt = now.toISOString();
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
        b.status = statusOf(b.expiresAt, now, b.resetInstant);
        // 权威清单（见规则 5）：没出现 = 这笔真的不在后台了，从余额里剔除。
        // 手改过的不动——用户的数字优先，UI 用 absentCount 提示他自己决定。
        if (authoritative[b.agent] && !b.manualEdited && !b.closed) {
          b.closed = true;
          b.closedAt = now.toISOString();
          closed++;
        }
      }
    }

    return {
      batches: out, added: added, updated: updated, conflicts: conflicts,
      unchanged: unchanged, closed: closed, reopened: reopened
    };
  }

  /**
   * 用户手动改过之后调用：冻结该批次并清掉冲突标记。
   *
   * 返回 null 表示这次修改不合法（名称改成了空白），调用方应保留原批次并提示。
   * 为什么必须在这里挡：dedupKey 里含 label，名称被改成空白后键会变成
   * `qoder||2026-11-01`，两笔"空名"批次互相覆盖，而在 UI 上只是一片空白，
   * 看不出异常。补录路径早就有这条校验，编辑路径原来漏了。
   */
  function applyManualEdit(batch, patch) {
    patch = Object.assign({}, patch || {});
    if (patch.label !== undefined) {
      patch.label = String(patch.label == null ? "" : patch.label).trim();
      if (!patch.label) return null;
    }
    var b = Object.assign({}, batch, patch);
    if (!b.label || !String(b.label).trim()) return null;
    b.manualEdited = true;
    b.updatedAt = new Date().toISOString();
    if (b.source === "auto") b.source = "manual";
    delete b.conflict;
    b.batchId = batchId(b.agent, dedupKey(b));
    b.status = statusOf(b.expiresAt, null, b.resetInstant);
    return b;
  }

  /** 冲突时用户选择"采用抓取值" */
  function acceptScraped(batch) {
    var b = Object.assign({}, batch);
    if (b.scraped) {
      b.label = b.scraped.label || actualExpiryLabel(b, b.scraped.expiresAt);
      b.remaining = b.scraped.remaining;
      b.granted = b.scraped.granted;
      b.expiresAt = b.scraped.expiresAt;
      b.resetInstant = b.scraped.resetInstant || null;
      b.capturedAt = b.scraped.capturedAt;
    }
    delete b.scraped;
    delete b.conflict;
    b.manualEdited = false;
    b.source = "auto";
    b.batchId = batchId(b.agent, dedupKey(b));
    b.status = statusOf(b.expiresAt, null, b.resetInstant);
    return b;
  }

  /* ---------- 导入：导出的 JSON -> 可落库的数据 ----------
   *
   * 需求 §3.3 把「导出 / 导入」当成换机器与备份的唯一出路，但此前只做了导出，
   * 「清空本机数据」之后没有任何恢复路径。导入必须过这一关，不能直接 Store.save：
   * 导出的文件是用户能手改的，batches 一旦不是数组，renderCal 就会抛错、整页白屏，
   * 而用户只会以为"导入没生效"。
   *
   * 规则：只保留白名单字段，认不出的条目直接丢（不猜、不修），并回报丢了多少条。
   * 也顺手夹住极端值（负数余额、超长名称），免得一条脏数据把卡片撑变形。
   * 平台配置（agents）不从文件恢复：授权是浏览器按域名给的，跨机器搬过来也用不了。
   */
  var IMPORT_MAX_CAPTURES = 60;

  function importNum(v) {
    var n = typeof v === "string" ? parseFloat(v.replace(/[,\s]/g, "")) : v;
    return typeof n === "number" && isFinite(n) ? n : null;
  }
  function importIso(v) {
    if (!v) return null;
    var t = Date.parse(v);
    return isFinite(t) ? new Date(t).toISOString() : null;
  }

  function importBatch(raw, known) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var agent = typeof raw.agent === "string" ? raw.agent : "";
    if (!agent || (known && known.indexOf(agent) < 0)) return null;
    var label = String(raw.label == null ? "" : raw.label).trim();
    if (!label) return null;
    var exp = String(raw.expiresAt == null ? "" : raw.expiresAt).trim();
    if (!parseYmd(exp)) return null;
    var remaining = importNum(raw.remaining);
    if (remaining === null) return null;
    var granted = importNum(raw.granted);

    var b = {
      agent: agent,
      label: label.slice(0, 60),
      unit: raw.unit === "tokens" || raw.unit === "requests" ? raw.unit : "credits",
      granted: granted === null ? Math.max(0, remaining) : Math.max(0, granted),
      remaining: Math.max(0, remaining),
      expiresAt: exp,
      resetInstant: importIso(raw.resetInstant),
      capturedAt: importIso(raw.capturedAt) || new Date().toISOString(),
      source: raw.source === "manual" ? "manual" : "auto",
      manualEdited: !!raw.manualEdited,
      status: statusOf(exp, null, importIso(raw.resetInstant)),
      absentCount: Math.max(0, importNum(raw.absentCount) || 0)
    };
    var upd = importIso(raw.updatedAt);
    if (upd) b.updatedAt = upd;
    // 「后台已不再返回」是状态而不是数字：导出的备份要能原样导回来，
    // 否则那些钱会在新机器上重新变成"可用余额"，余额又对不上后台。
    if (raw.closed === true) {
      b.closed = true;
      var cl = importIso(raw.closedAt);
      if (cl) b.closedAt = cl;
    }
    // batchId 一律重算：文件里的值可能是手改的，撞车就会"改 A 影响 B"。
    b.batchId = batchId(b.agent, dedupKey(b));
    return b;
  }

  function importCapture(raw, known) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var agentId = typeof raw.agentId === "string" ? raw.agentId : "";
    if (!agentId || (known && known.indexOf(agentId) < 0)) return null;
    var url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) return null;
    var body = typeof raw.bodyPreview === "string" ? raw.bodyPreview : "";
    if (!body) return null;
    var hash = typeof raw.bodyHash === "string" && raw.bodyHash ? raw.bodyHash : contentHash(body);
    var len = importNum(raw.bodyLength);
    return {
      url: url,
      method: typeof raw.method === "string" && /^[A-Z]+$/.test(raw.method) ? raw.method : "GET",
      status: importNum(raw.status) || 0,
      requestHeaderNames: Array.isArray(raw.requestHeaderNames)
        ? raw.requestHeaderNames.filter(function (s) { return typeof s === "string"; }).slice(0, 40)
        : [],
      bodyPreview: body.slice(0, 200000),
      bodyLength: len === null ? body.length : Math.max(0, len),
      bodyHash: hash,
      truncated: !!raw.truncated,
      at: importIso(raw.at) || new Date().toISOString(),
      agentId: agentId,
      score: Math.max(0, importNum(raw.score) || 0),
      reasons: Array.isArray(raw.reasons)
        ? raw.reasons.filter(function (s) { return typeof s === "string"; }).slice(0, 8) : [],
      via: typeof raw.via === "string" ? raw.via : "import"
    };
  }

  /**
   * @param raw   导出的 JSON（整份 doc，或 { captures } / { batches } 之一）
   * @param opts  { agents: ["qoder", ...] } 认得的平台；不传则不校验（单测/预览）
   * @returns { batches, captures, droppedBatches, droppedCaptures }
   */
  function importSnapshot(raw, opts) {
    opts = opts || {};
    var known = opts.agents || null;
    var src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    var out = { batches: [], captures: [], droppedBatches: 0, droppedCaptures: 0 };
    var seenKey = {}, seenCap = {};

    var rawBatches = Array.isArray(src.batches) ? src.batches : [];
    var rawCaptures = Array.isArray(src.captures) ? src.captures : [];

    rawBatches.forEach(function (r) {
      var b = importBatch(r, known);
      if (!b) { out.droppedBatches++; return; }
      if (!(src.schema >= 2)) b = migrateExpiry(b);
      var k = dedupKey(b);
      if (seenKey[k]) { out.droppedBatches++; return; }   // 文件内部重复
      seenKey[k] = true;
      out.batches.push(b);
    });

    rawCaptures.forEach(function (r) {
      var c = importCapture(r, known);
      if (!c) { out.droppedCaptures++; return; }
      var k = c.agentId + "|" + c.url + "|" + c.bodyHash;
      if (seenCap[k]) { out.droppedCaptures++; return; }
      seenCap[k] = true;
      out.captures.push(c);
    });

    // 与 background 的 MAX_CAPTURES 对齐：多条低分样本不该挤掉真正的高分接口。
    out.captures.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    if (out.captures.length > IMPORT_MAX_CAPTURES) out.captures.length = IMPORT_MAX_CAPTURES;
    return out;
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
    expiryInstant: expiryInstant, formatExpiry: formatExpiry, migrateExpiry: migrateExpiry,
    toExpiresAt: toExpiresAt, parseLooseDate: parseLooseDate,
    dedupKey: dedupKey, batchId: batchId, normalizeBatch: normalizeBatch,
    stableTag: stableTag, daySuffix: daySuffix,
    mergeBatches: mergeBatches, applyManualEdit: applyManualEdit, acceptScraped: acceptScraped,
    importSnapshot: importSnapshot,
    sanitizeCapture: sanitizeCapture, numOr: numOr, contentHash: contentHash
  };
});
