/*
 * adapters/lobsterai.js — LobsterAI 额度接口的字段映射。
 *
 * 样本来源：2026-10-22 用户提供的真实响应
 *   GET https://lobsterai-server.youdao.com/api/user/profile-summary
 *
 * 响应骨架：
 *   {
 *     code: 0, message: "success",
 *     data: {
 *       totalCreditsRemaining: 约 2.4k,
 *       creditItems: [
 *         { type, label, labelEn, creditsRemaining, expiresAt }
 *       ]
 *     }
 *   }
 *
 * 映射规则（每条都对应样本里看得到的事实）：
 *   - 只认 data.creditItems。totalCreditsRemaining 是明细的合计，取它会把同一笔钱算两遍。
 *   - expiresAt 是清零时刻，形如 "2026-10-24T10:30:05"，没有时区后缀（服务端本地时间）。
 *     交给 normalize 取本地到期日期，精确时刻留在 resetInstant。
 *   - 接口只给剩余量、不给原始发放量。granted 暂用 creditsRemaining 填，至少编辑框里不是 0；
 *     这个值会随消耗一起下降，它不是真正的 grant，UI 和汇总都只看 remaining。
 *   - "每日登录奖励"会同时存在十几笔，label 完全相同。label 末尾带上到期日期的 MM-DD，
 *     否则 ① 明细里十几行同名无法分辨；② 某一笔被手改后，mergeBatches 的冻结兜底按
 *     (agent+label) 匹配，会把抓取值挂到同名的另一笔上。日期取自 normalize 的换算结果，
 *     与列表显示的到期日一致；只要服务端不改变某笔的 expiresAt，label 就是稳定的。
 *   - 没有 expiresAt 的条目（将来若出现永久额度）跳过：批次模型要求到期日，编一个比不显示更糟。
 *   - 剩余量为 0 的条目保留：用完后要能把余额更新到 0，否则它会永远停在旧数字。
 *   - code 非 0 时抛错，让 runSync 报 adapter-threw 并带上服务端 message；
 *     这是接口层失败，不能伪装成"没认出批次"。
 *   - **标 authoritative**：creditItems 是当下全部批次，而且平台是把花完/回收的
 *     批次**整条摘掉**，不是把 creditsRemaining 写成 0（2026-10-23 真机数据：
 *     5 笔从列表里消失，本机余额一直停在 2115.98，后台其实是 1984.64，差 131.35
 *     正好等于这 5 笔的残留之和）。所以"这次没出现"必须能关掉这批，
 *     否则日历永远比后台高，而且每次同步都只报「数字无变化」。
 *   - totalCreditsRemaining 仍是明细的合计，**不拿它当数据源**，只在
 *     test/lobsterai.test.cjs 里当对账基准：明细之和必须等于它。
 */
(function (root) {
  "use strict";

  var N = root.CreditNormalize;

  function labelFor(item) {
    var name = item.label || item.labelEn || item.type || "额度";
    // N 在真实加载路径上一定存在（background 先 import normalize；runSync 也会检查）。
    // 共用日期换算，保证 label 后缀与列表到期日一致。
    var day = N && N.daySuffix ? N.daySuffix(item.expiresAt) : null;
    return name + (day ? " " + day : "");
  }

  function extract(capture) {
    var data = JSON.parse(capture.bodyPreview);
    if (data && data.code != null && Number(data.code) !== 0) {
      throw new Error("接口返回 code=" + data.code
        + (data.message ? "：" + data.message : ""));
    }

    var items = data && data.data && data.data.creditItems;
    if (!Array.isArray(items)) return [];

    var rows = [];
    items.forEach(function (item) {
      if (!item || !item.expiresAt) return;
      if (item.creditsRemaining == null) return;
      var remaining = Number(item.creditsRemaining);
      if (!isFinite(remaining)) return;
      if (remaining < 0) remaining = 0;

      rows.push({
        label: labelFor(item),
        granted: remaining,
        remaining: remaining,
        expiry: item.expiresAt,
        unit: "credits"
      });
    });
    return rows;
  }

  var adapter = {
    // 必须精确到 profile-summary：portal 还会请求 credits-reset-campaign/status、
    // invitation/reward-credits 等带 credit 字样的接口，宽泛匹配会选错样本。
    endpointHint: /\/user\/profile-summary(?:[?#]|$)/i,
    // 一次性返回全部批次，没出现的就是没了（理由见文件头）
    authoritative: true,
    extract: extract
  };
  root.CreditAdapters.register("lobsterai", adapter);
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})(typeof self !== "undefined" ? self : globalThis);
