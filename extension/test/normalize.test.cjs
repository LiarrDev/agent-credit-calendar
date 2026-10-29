/* 归一化与合并规则的单元测试： node test/normalize.test.cjs */
var N = require("../lib/normalize.js");

var pass = 0, fail = 0;
function eq(label, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log("FAIL  " + label + "\n      got  " + g + "\n      want " + w); }
}

/* ---------- 过期语义 ---------- */
eq("纯日期视为最后可用日",
  N.toExpiresAt("2026-10-31").expiresAt, "2026-10-31");

eq("resets on Nov 1 保留实际日期 11-01",
  N.toExpiresAt("resets on Nov 1, 2026").expiresAt, "2026-11-01");

eq("valid until Oct 31 -> 10-31",
  N.toExpiresAt("valid until Oct 31, 2026").expiresAt, "2026-10-31");

eq("带时刻的 ISO 按清零时刻处理",
  N.toExpiresAt("2026-11-01T09:00").expiresAt, "2026-11-01");

eq("显式声明 lastUsableDay 可覆盖时刻推断",
  N.toExpiresAt("2026-11-01T00:00", "lastUsableDay").expiresAt, "2026-11-01");

eq("缺年份用 yearHint 补",
  N.toExpiresAt("valid until Dec 20", "lastUsableDay", 2026).expiresAt, "2026-12-20");

eq("毫秒时间戳零点到期保留当日",
  N.toExpiresAt(new Date(2026, 9, 31, 0, 0).getTime()).expiresAt, "2026-10-31");

eq("当天 09:00 到期不再提前一天",
  N.toExpiresAt("2026-11-01T09:00").expiresAt, "2026-11-01");

eq("清零时刻被保留，供 UI 精确说明",
  N.toExpiresAt("resets on Nov 1, 2026").resetInstant !== null, true);

eq("无时区的 ISO 时刻保留秒，不截到分钟",
  N.toExpiresAt("2026-11-01T09:00:05").resetInstant,
  new Date(2026, 10, 1, 9, 0, 5).toISOString());
eq("无时区的 ISO 时刻保留毫秒",
  N.toExpiresAt("2026-11-01T09:00:05.123").resetInstant,
  new Date(2026, 10, 1, 9, 0, 5, 123).toISOString());

eq("无法解析返回 null", N.toExpiresAt("下辈子"), null);
eq("空值返回 null", N.toExpiresAt(""), null);

eq("拒绝 2 月 31 日这种溢出日期", N.parseYmd("2026-02-31"), null);

/* ---------- 倒计时 ---------- */
var today = new Date(2026, 9, 21);
eq("今天到期 = 0 天", N.daysLeft("2026-10-21", today), 0);
eq("明天到期 = 1 天", N.daysLeft("2026-10-22", today), 1);
eq("昨天到期 = -1", N.daysLeft("2026-10-20", today), -1);
eq("跨月倒计时", N.daysLeft("2026-11-20", today), 30);
eq("状态：过期", N.statusOf("2026-10-20", today), "expired");
eq("状态：有效（到期当天仍有效）", N.statusOf("2026-10-21", today), "active");

/* ---------- dedupKey ---------- */
var k1 = N.dedupKey({ agent: "qoder", label: " 10月  套餐积分 ", expiresAt: "2026-10-31" });
var k2 = N.dedupKey({ agent: "qoder", label: "10月 套餐积分", expiresAt: "2026-10-31" });
eq("dedupKey 对空白与大小写归一", k1, k2);
eq("dedupKey 不含 remaining，所以剩余量变化不会造出新批次",
  N.dedupKey({ agent: "qoder", label: "A", expiresAt: "2026-10-31" }),
  N.dedupKey({ agent: "qoder", label: "A", expiresAt: "2026-10-31", remaining: 999 }));

/* ---------- normalizeBatch ---------- */
var nb = N.normalizeBatch({
  agent: "trae", label: "Monthly Speed Points", granted: "30,000",
  remaining: "4,200", expiry: "resets on Nov 1, 2026"
}, { now: today });
eq("千分位字符串转数字", nb.remaining, 4200);
eq("granted 千分位", nb.granted, 30000);
eq("归一化后 expiresAt", nb.expiresAt, "2026-11-01");
eq("默认单位 credits", nb.unit, "credits");
eq("batchId 稳定", nb.batchId, N.normalizeBatch({
  agent: "trae", label: "Monthly Speed Points", granted: 30000, remaining: 4200,
  expiry: "2026-11-01" }, { now: today }).batchId);

/* ---------- merge：三种关键情形 ---------- */
function mk(o) {
  return Object.assign({
    agent: "qoder", label: "10月包", unit: "credits", granted: 6000, remaining: 1840,
    expiresAt: "2026-10-31", capturedAt: "2026-10-01T00:00:00.000Z", source: "auto",
    manualEdited: false
  }, o);
}

// 1) 同批次剩余量更新
var r = N.mergeBatches([mk()], [mk({ remaining: 900 })], { now: today });
eq("命中 dedupKey -> 只更新不新增", r.batches.length, 1);
eq("剩余量被更新", r.batches[0].remaining, 900);
eq("计为 updated", r.updated, 1);

// 2) 新批次
r = N.mergeBatches([mk()], [mk({ remaining: 900 }), mk({ label: "加购包", remaining: 500 })], { now: today });
eq("未命中 -> 新增", r.batches.length, 2);
eq("计为 added", r.added, 1);

// 3) 这次一条都没抓到：视为"这轮没数据"，既不删也不记缺席
r = N.mergeBatches([mk()], [], { now: today });
eq("抓不到时不删除历史批次", r.batches.length, 1);
eq("空结果不累加 absentCount（可能是抓取失败，不是真没了）", !r.batches[0].absentCount, true);

// 3b) 抓到了别的批次，这一笔没出现：才记缺席
r = N.mergeBatches([mk()], [mk({ label: "加购包" })], { now: today });
eq("同平台漏掉某笔时累加 absentCount", r.batches[0].absentCount, 1);

// 3c) 只同步 A 平台不能把 B 平台的批次算缺席
r = N.mergeBatches([mk(), mk({ agent: "trae", label: "月度" })], [mk({ label: "加购包" })], { now: today });
eq("别家平台的批次不受本次同步影响",
  !r.batches.filter(function (b) { return b.agent === "trae"; })[0].absentCount, true);

// 4) 手动改过的批次：抓取值不覆盖，转成交给用户裁决的冲突
var manual = N.applyManualEdit(mk(), { remaining: 100 });
eq("手动编辑后 manualEdited", manual.manualEdited, true);
eq("手动编辑后 source 变 manual", manual.source, "manual");
r = N.mergeBatches([manual], [mk({ remaining: 1840 })], { now: today });
eq("冲突不覆盖用户填的剩余量", r.batches[0].remaining, 100);
eq("冲突被抓出来", r.conflicts, 1);
eq("抓取值另存待裁决", r.batches[0].scraped.remaining, 1840);

// 5) 用户裁决采用抓取值
var accepted = N.acceptScraped(r.batches[0]);
eq("采纳后剩余量", accepted.remaining, 1840);
eq("采纳后解除冻结", accepted.manualEdited, false);
eq("采纳后清冲突", accepted.conflict, undefined);

// 6) 手动改过之后不再重复报冲突
r = N.mergeBatches([manual], [mk({ remaining: 100 })], { now: today });
eq("抓取值与手填一致时不算冲突", r.conflicts, 0);

/* ---------- 权威清单：没出现 = 这笔不在了（v0.3.17） ----------
 * 真机场景（LobsterAI）：平台把花完的批次从 creditItems 里整条摘掉，不会给 0。
 * 只记 absentCount 的话它会永远停在最后一次见到的余额上，余额比后台只多不少，
 * 而每次同步都只报「数字无变化」。
 */
r = N.mergeBatches([mk()], [mk({ label: "加购包" })], { now: today, authoritative: { qoder: true } });
eq("权威清单里没出现 -> 关掉这笔", r.batches[0].closed, true);
eq("关掉的笔数单独报出来", r.closed, 1);
eq("关闭时刻落盘（供 UI 说「什么时候起没再返回」）", r.batches[0].closedAt, today.toISOString());
eq("仍然不删除历史", r.batches.length, 2);
eq("缺席计数照常累加", r.batches[0].absentCount, 1);

r = N.mergeBatches([mk()], [mk({ label: "加购包" })], { now: today });
eq("没有标权威的平台不关批次（其它三家可能只返回部分批次）", !r.batches[0].closed, true);

r = N.mergeBatches([mk()], [], { now: today, authoritative: { qoder: true } });
eq("一次都没抓到（抓取失败）不许关批次", !r.batches[0].closed, true);

var closedOnce = N.mergeBatches([mk()], [mk({ label: "加购包" })], { now: today, authoritative: { qoder: true } });
r = N.mergeBatches(closedOnce.batches, [mk()], { now: today, authoritative: { qoder: true } });
eq("平台又返回了 -> 重新计入", r.batches[0].closed, undefined);
eq("重新计入的笔数单独报出来", r.reopened, 1);
eq("再次出现时清掉关闭时刻", r.batches[0].closedAt, undefined);
eq("重新计入的那笔不算「新关掉」，被落下的那笔才计入", r.closed, 1);

r = N.mergeBatches([manual], [mk({ label: "加购包" })], { now: today, authoritative: { qoder: true } });
eq("手改过的批次不自动关（用户认的钱优先）", !r.batches[0].closed, true);

/* ---------- 脱敏 ---------- */
var cap = N.sanitizeCapture({
  url: "https://x.dev/api/credits", method: "GET", status: 200,
  requestHeaders: { Authorization: "Bearer SUPERSECRET", Cookie: "session=abc", Accept: "application/json" },
  body: JSON.stringify({ ok: 1 })
});
eq("只保留 header 名字", cap.requestHeaderNames.sort(), ["Accept", "Authorization", "Cookie"]);
eq("样本里不含任何 header 值", /SUPERSECRET|"abc"|session=/.test(JSON.stringify(cap)), false);
cap = N.sanitizeCapture({ url: "u", body: "x".repeat(9000) }, 6000);
eq("超长 body 被截断", cap.bodyPreview.length < 6100, true);
eq("截断有标记", /\(truncated\)/.test(cap.bodyPreview), true);

/* ---------- 内容指纹：修「重新截获后数字不刷新」的回归 ---------- */
// 病因是拿 bodyLength 当去重键：额度 1873 → 1870 位数没变、长度一样，
// 新数据被误判成重复丢掉。contentHash 必须能区分这种"等长但不同值"的响应。
eq("相同内容指纹相同", N.contentHash('{"remaining":1873}'), N.contentHash('{"remaining":1873}'));
eq("等长不同值指纹不同", N.contentHash('{"remaining":1873}') !== N.contentHash('{"remaining":1870}'), true);
eq("等长不同值 bodyLength 相同（正是要靠指纹区分的场景）",
  N.sanitizeCapture({ url: "u", body: '{"remaining":1873}' }).bodyLength,
  N.sanitizeCapture({ url: "u", body: '{"remaining":1870}' }).bodyLength);
eq("等长不同值 bodyHash 不同",
  N.sanitizeCapture({ url: "u", body: '{"remaining":1873}' }).bodyHash !==
  N.sanitizeCapture({ url: "u", body: '{"remaining":1870}' }).bodyHash, true);
eq("指纹含长度前缀", /^\d+-/.test(N.contentHash("abc")), true);
eq("空串也有稳定指纹", N.contentHash(""), N.contentHash(""));
eq("sanitizeCapture 一定带 bodyHash", typeof N.sanitizeCapture({ url: "u", body: "{}" }).bodyHash, "string");

/* ---------- 指纹精度（Math.imul 回归） ----------
 * 曾经两路哈希都写成普通乘法 ((h ^ c) * 0x01000193) >>> 0：中间乘积最大 7.2e16 /
 * 9.6e18，都超过 2^53，静默丢掉低位。结果仍然确定，所以老样本不会突然失配，
 * 但有效位数缩水、碰撞概率上升。这两条把「低位真的参与运算」钉住。 */
var H1_PREFIX = N.contentHash("x").split("-")[1];
eq("指纹末位是有效位（不能因为浮点溢出恒为 0）",
  N.contentHash("a") !== N.contentHash("b"), true);
eq("只差最后一个字符的两个串指纹不同",
  N.contentHash("aaaaaaaaaaaaaaaaaaaa1") !== N.contentHash("aaaaaaaaaaaaaaaaaaaa2"), true);
eq("长串末 4 位不全为 0（浮点乘法曾把低位抹平）",
  /[1-9a-f]/.test(N.contentHash(new Array(5000).join("credit")).slice(-4)), true);

/* ---------- 稳定短码 ---------- */
eq("同一 seed 短码稳定", N.stableTag("res-12345"), N.stableTag("res-12345"));
eq("不同 seed 短码不同", N.stableTag("res-12345") !== N.stableTag("res-12346"), true);
eq("空 seed 返回空串", N.stableTag(""), "");
eq("空/未定义 seed 返回空串", N.stableTag(null), "");
eq("短码是 8 位 hex", /^[0-9a-f]{8}$/.test(N.stableTag("abc")), true);
eq("只差末尾字符的 id 短码不同（截断后撞码的坑）",
  N.stableTag("resource-id-0001") !== N.stableTag("resource-id-0002"), true);

/* ---------- 到期日后缀 ---------- */
eq("daySuffix 取实际日期 MM-DD", N.daySuffix("2026-11-01T09:00"), "11-01");
eq("daySuffix 说明语义后不减一天", N.daySuffix("2026-11-01T09:00", "lastUsableDay"), "11-01");
eq("daySuffix 解析不了返回 null", N.daySuffix("不是日期"), null);

/* ---------- 冻结批次的过期状态 ---------- */
var frozenBase = [{
  agent: "x", label: "手改过的批次", unit: "credits", granted: 100, remaining: 100,
  expiresAt: "2026-01-01", manualEdited: true, batchId: "x-1", status: "active"
}];
var frozenAgain = N.mergeBatches(
  frozenBase,
  [{ agent: "x", label: "手改过的批次", unit: "credits", granted: 100, remaining: 50,
     expiresAt: "2026-01-01" }],
  { now: new Date(2026, 9, 22) });
eq("冻结批次同步后 status 跟着（用户填的）到期日走",
  frozenAgain.batches[0].status, "expired");
eq("冻结批次本身的值不被抓取值覆盖", frozenAgain.batches[0].remaining, 100);
eq("冻结批次照样报冲突", !!frozenAgain.batches[0].conflict, true);

var frozenFuture = N.mergeBatches(
  [{ agent: "x", label: "L2", expiresAt: "2026-12-31", manualEdited: true,
     remaining: 10, granted: 10, status: "expired" }],
  [{ agent: "x", label: "L2", expiresAt: "2026-12-31", remaining: 10, granted: 10 }],
  { now: new Date(2026, 9, 22) });
eq("未过期的冻结批次 status 回到 active", frozenFuture.batches[0].status, "active");

/* ---------- 编辑路径的校验（v0.3.16） ----------
 * 名称被改成空白后 dedupKey 会变成 `qoder||2026-11-01`，两笔"空名"批次互相覆盖，
 * 而 UI 上只是一片空白，看不出异常。补录路径早就有这条校验，编辑路径原来漏了。 */
var editBase = N.normalizeBatch({ agent: "qoder", label: "包A", granted: 100, remaining: 50, expiry: "2026-11-01" });
eq("把名称改成空白：拒绝保存", N.applyManualEdit(editBase, { label: "   " }), null);
eq("把名称改成空串：拒绝保存", N.applyManualEdit(editBase, { label: "" }), null);
eq("名称两边的空格被 trim",
  N.applyManualEdit(editBase, { label: "  包B  " }).label, "包B");
eq("不传 label 时仍能正常冻结",
  N.applyManualEdit(editBase, { remaining: 20 }).manualEdited, true);

/* ---------- 同名多笔冻结批次（v0.3.16） ----------
 * 以前 frozenByName 同名只留最后一个，另一笔永远匹配不上，absentCount 无上限增长，
 * UI 上一直显示"最近 N 次同步没返回这笔"，看着像抓取坏了。 */
var sameNameBase = { agent: "qoder", label: "同名包", unit: "credits", granted: 100, remaining: 100 };
var f1 = Object.assign({}, sameNameBase, { batchId: "a", manualEdited: true, expiresAt: "2026-11-05", absentCount: 0 });
var f2 = Object.assign({}, sameNameBase, { batchId: "b", manualEdited: true, expiresAt: "2026-11-06", absentCount: 0 });
var twoIncoming = [
  N.normalizeBatch({ agent: "qoder", label: "同名包", granted: 100, remaining: 30, expiry: "2026-11-01" }),
  N.normalizeBatch({ agent: "qoder", label: "同名包", granted: 100, remaining: 40, expiry: "2026-11-02" })
];
var twoRes = N.mergeBatches([f1, f2], twoIncoming, { now: new Date(2026, 9, 22) });
eq("两笔同名冻结批次各被匹配一次（absentCount 都归零）",
  twoRes.batches.map(function (b) { return b.absentCount; }), [0, 0]);
eq("同名冻结批次不新增第三条", twoRes.batches.length, 2);
eq("两笔都报冲突（抓取值不同）", twoRes.conflicts, 2);

/* ---------- batchId 定长 ---------- */
var idLens = {};
for (var bi = 0; bi < 500; bi++) {
  var bid = N.batchId("qoder", "label-" + bi + "|2026-11-01");
  var suf = bid.slice("qoder-".length);
  idLens[suf.length] = true;
}
eq("batchId 后缀长度固定 8 位", Object.keys(idLens).map(Number), [8]);
eq("batchId 后缀是 hex", /^[0-9a-f]{8}$/.test(N.batchId("qoder", "x").slice(6)), true);

/* ---------- 导入备份（v0.3.16） ----------
 * 需求 §3.3 承诺的恢复路径。文件是用户能手改的，必须先清洗再落库：
 * 一个坏字段就能让 doc 结构打烂、整页白屏，而用户只会以为"导入没生效"。 */
var imported = N.importSnapshot({
  schema: 1,
  batches: [
    { agent: "qoder", label: "  恢复包  ", granted: 100, remaining: 40, expiresAt: "2026-11-30" },
    { agent: "qoder", label: "恢复包", granted: 100, remaining: 40, expiresAt: "2026-11-30" },  // 文件内重复
    { agent: "不存在的平台", label: "x", remaining: 1, expiresAt: "2026-11-30" },
    { agent: "qoder", label: "", remaining: 1, expiresAt: "2026-11-30" },
    { agent: "qoder", label: "日期坏了", remaining: 1, expiresAt: "2026/11/30" },
    { agent: "qoder", label: "余额不是数字", remaining: "很多", expiresAt: "2026-11-30" },
    null
  ],
  captures: [
    { agentId: "qoder", url: "https://qoder.com/api/usage", bodyPreview: '{"a":1}', score: 5,
      requestHeaderNames: ["content-type"], at: "2026-10-20T10:00:00.000Z" },
    { agentId: "qoder", url: "javascript:alert(1)", bodyPreview: "x" },
    { agentId: "qoder", url: "https://qoder.com/api/usage", bodyPreview: '{"a":1}', score: 5 }
  ]
}, { agents: ["qoder", "trae", "workbuddy", "lobsterai"] });

eq("导入：只留下 1 笔合法批次", imported.batches.length, 1);
eq("导入：名称被 trim", imported.batches[0].label, "恢复包");
eq("导入：丢弃的条目数如实回报（1 重复 + 1 未知平台 + 1 空名 + 1 坏日期 + 1 非数字 + 1 null）",
  imported.droppedBatches, 6);
eq("导入：batchId 一律按内容重算", imported.batches[0].batchId, N.batchId("qoder", N.dedupKey(imported.batches[0])));
eq("导入：只留下 1 条合法样本", imported.captures.length, 1);
eq("导入：非 http(s) 的接口地址被丢掉", imported.droppedCaptures, 2);
eq("导入：样本补上 agentId/score", [imported.captures[0].agentId, imported.captures[0].score], ["qoder", 5]);

// 「后台已不再返回」也得能原样导回来：丢了它，那笔钱在新机器上又会变成可用余额
var goneImport = N.importSnapshot({
  batches: [{ agent: "lobsterai", label: "每日登录奖励 11-07", granted: 100, remaining: 100,
    expiresAt: "2026-11-07", closed: true, closedAt: "2026-10-23T09:09:40.000Z" }]
}, { agents: ["lobsterai"] });
eq("导入：保留「已不在后台返回」标记", goneImport.batches[0].closed, true);
eq("导入：保留关闭时刻", goneImport.batches[0].closedAt, "2026-10-23T09:09:40.000Z");

var emptyImport = N.importSnapshot(null, { agents: ["qoder"] });
eq("导入：null 不抛异常，返回空结果", [emptyImport.batches.length, emptyImport.captures.length], [0, 0]);
var noBatches = N.importSnapshot({ batches: "不是数组" }, { agents: ["qoder"] });
eq("导入：batches 不是数组时当作空（结构不被污染）", noBatches.batches.length, 0);

var manyCaps = N.importSnapshot({ captures: new Array(80).fill(0).map(function (_, i) {
  return { agentId: "qoder", url: "https://qoder.com/api/" + i, bodyPreview: "{}", score: i };
}) }, { agents: ["qoder"] });
eq("导入：样本上限 60 条", manyCaps.captures.length, 60);
eq("导入：超上限时留高分的那批", manyCaps.captures[0].score, 79);

var timed = N.normalizeBatch({ agent: "qoder", label: "精确时间", granted: 100, remaining: 80,
  expiry: "2026-11-01T09:05:30.123" });
eq("列表完整日期和时分", N.formatExpiry(timed), "2026-11-01 09:05");
eq("到期前 1 毫秒仍有效", N.statusOf(timed.expiresAt, new Date(2026, 10, 1, 9, 5, 30, 122), timed.resetInstant), "active");
eq("到期那一毫秒即过期", N.statusOf(timed.expiresAt, new Date(2026, 10, 1, 9, 5, 30, 123), timed.resetInstant), "expired");
eq("到期当日下午已过期", N.statusOf(timed.expiresAt, new Date(2026, 10, 1, 12), timed.resetInstant), "expired");
eq("午夜到期不减日期", N.toExpiresAt("2026-11-01T00:00").expiresAt, "2026-11-01");
eq("午夜到期当天零点即过期", N.statusOf("2026-11-01", new Date(2026, 10, 1),
  new Date(2026, 10, 1).toISOString()), "expired");
eq("未知时间不伪造午夜", N.formatExpiry({ expiresAt: "2026-11-01" }), "2026-11-01（具体时间未知）");
eq("只有日期时全天有效", N.statusOf("2026-11-01", new Date(2026, 10, 1, 23, 59, 59)), "active");
eq("只有日期时次日过期", N.statusOf("2026-11-01", new Date(2026, 10, 2)), "expired");
eq("非法原始时间不显示 NaN", N.formatExpiry({ expiresAt: "2026-11-01", resetInstant: "bad" }), "2026-11-01（具体时间未知）");
eq("无效 Date 不抛错", N.toExpiresAt(new Date(NaN)), null);
eq("超范围毫秒不抛错", N.toExpiresAt(1e20), null);
eq("数字显式日期语义不编造时分", N.toExpiresAt(new Date(2026, 10, 1).getTime(), "lastUsableDay").resetInstant, null);
eq("Date 显式日期语义不编造时分", N.toExpiresAt(new Date(2026, 10, 1), "lastUsableDay").resetInstant, null);

var editedTime = N.applyManualEdit(timed, { expiresAt: "2026-11-03" });
eq("手改日期不显示旧时分", N.formatExpiry(editedTime), "2026-11-03（具体时间未知）");
eq("手改日期不被旧时刻提前判过期", N.statusOf(editedTime.expiresAt, new Date(2026, 10, 2), editedTime.resetInstant), "active");
eq("仅手改余额保留时间", N.formatExpiry(N.applyManualEdit(timed, { remaining: 50 })), "2026-11-01 09:05");

var later = Object.assign({}, timed, { resetInstant: new Date(2026, 10, 1, 10, 30).toISOString() });
var timeMerged = N.mergeBatches([timed], [later], { now: new Date(2026, 10, 1, 9, 30) });
eq("同日仅时分变更也更新", timeMerged.updated, 1);
eq("同日时分变更不新增批次", timeMerged.added, 0);
eq("同步时刻变更后展示新时间", N.formatExpiry(timeMerged.batches[0]), "2026-11-01 10:30");
eq("同步时刻变更后仍有效", timeMerged.batches[0].status, "active");
eq("无数字变化也更新过期状态", N.mergeBatches([later], [later], {
  now: new Date(2026, 10, 1, 10, 30) }).batches[0].status, "expired");
var timeConflict = N.mergeBatches([N.applyManualEdit(timed, { remaining: 80 })], [later], {
  now: new Date(2026, 10, 1, 9, 30) });
eq("冻结批次时刻变更进入冲突", timeConflict.conflicts, 1);
eq("冲突保留新时刻", timeConflict.batches[0].scraped.resetInstant, later.resetInstant);
eq("采纳冲突后显示新时刻", N.formatExpiry(N.acceptScraped(timeConflict.batches[0])), "2026-11-01 10:30");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
