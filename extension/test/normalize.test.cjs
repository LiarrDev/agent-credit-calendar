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

eq("resets on Nov 1 -> 最后可用日是 10-31（差一天的坑）",
  N.toExpiresAt("resets on Nov 1, 2026").expiresAt, "2026-10-31");

eq("valid until Oct 31 -> 10-31",
  N.toExpiresAt("valid until Oct 31, 2026").expiresAt, "2026-10-31");

eq("带时刻的 ISO 按清零时刻处理",
  N.toExpiresAt("2026-11-01T09:00").expiresAt, "2026-10-31");

eq("显式声明 lastUsableDay 可覆盖时刻推断",
  N.toExpiresAt("2026-11-01T00:00", "lastUsableDay").expiresAt, "2026-11-01");

eq("缺年份用 yearHint 补",
  N.toExpiresAt("valid until Dec 20", "lastUsableDay", 2026).expiresAt, "2026-12-20");

eq("毫秒时间戳按清零时刻处理，最后可用日是前一天",
  N.toExpiresAt(new Date(2026, 9, 31, 0, 0).getTime()).expiresAt, "2026-10-30");

eq("当天 09:00 清零也不把那天算成可用日（宁可少标一天）",
  N.toExpiresAt("2026-11-01T09:00").expiresAt, "2026-10-31");

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
eq("归一化后 expiresAt", nb.expiresAt, "2026-10-31");
eq("默认单位 credits", nb.unit, "credits");
eq("batchId 稳定", nb.batchId, N.normalizeBatch({
  agent: "trae", label: "Monthly Speed Points", granted: 30000, remaining: 4200,
  expiry: "2026-10-31" }, { now: today }).batchId);

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
eq("daySuffix 取 MM-DD", N.daySuffix("2026-11-01T09:00"), "10-31");
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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
