/*
 * adapters/trae.js — TRAE CN 额度接口的字段映射。
 *
 * 样本来源：2026-10-22 用户提供的真实响应
 *   GET https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list
 *   页面：https://www.trae.cn/dashboard
 *
 * 响应骨架：
 *   {
 *     is_credits_billing: true,
 *     usage_summary: { consumed_amount, consumption_ratio, total_amount },
 *     user_entitlement_pack_list: [
 *       {
 *         display_desc, group_name, expire_time,          // expire_time 是秒级时间戳
 *         entitlement_base_info: {
 *           end_time, quota: { credits_limit },
 *           product_extra: { package_extra: { quota: { credits_limit }, package_name } }
 *         },
 *         usage: { credits_amount }                       // 已消耗；可能为空对象
 *       }
 *     ]
 *   }
 *
 * 映射规则（每条都对应样本里看得到的事实）：
 *   - 只认 user_entitlement_pack_list 的逐笔明细。usage_summary 是合计，
 *     total_amount 恰好等于各包 credits_limit 之和；再把它当一笔会立刻翻倍。
 *   - 免费包没有 credits_limit（只有一组能力开关），不是积分批次，跳过。
 *   - 剩余 = credits_limit - usage.credits_amount；usage 为空表示还没用。
 *     用满的包 remaining=0 仍保留，否则同步后旧余额会停在用满之前。
 *   - expire_time / end_time 是**秒**级时间戳（样本是 10 位）。转成 ISO 后交给
 *     normalize 取本地到期日期；精确时刻留在 resetInstant。
 *   - label 用 display_desc（回退 group_name / package_name），末尾加到期日期
 *     的 MM-DD。签到奖励会有十几笔完全同名，不加日期无法区分，冻结批次的
 *     (agent+label) 兜底匹配也会串笔。同名**且**同到期日的两笔再加稳定短码区分，
 *     否则 dedupKey 相同会在 mergeBatches 里并成一笔、丢掉一笔真实余额
 *     （WorkBuddy 的 ResourceId 短码、Qoder 的 id 末四位防的都是这个，见 labelRows）。
 *   - 不按 status / is_hide 过滤：样本里没有这些枚举的完整定义，日期与明细
 *     已经足够判断是否过期；猜一个枚举值反而可能把真实余额藏掉。
 *   - HTTP 401/403 明确报登录失效；其它非 2xx 报接口失败，不当成"没认出批次"。
 */
(function (root) {
  "use strict";

  var N = root.CreditNormalize;

  /** 秒或毫秒时间戳 -> ISO；0/缺失/非法返回 null。 */
  function expiryIso(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return null;
    var d = new Date(n < 1e12 ? n * 1000 : n);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** 本地到期日期的展示后缀；换算交给 normalize，避免两处规则漂移。 */
  function expiryDay(iso) {
    return N && N.daySuffix ? N.daySuffix(iso) : null;
  }

  function baseLabel(item, base) {
    var pkg = base && base.product_extra && base.product_extra.package_extra;
    return String(
      item.display_desc
      || item.group_name
      || (pkg && pkg.package_name)
      || "额度"
    ).trim();
  }

  function packQuota(item, base) {
    var pkg = base && base.product_extra && base.product_extra.package_extra;
    var q = (base && base.quota) || (pkg && pkg.quota) || null;
    return q;
  }

  /** 每笔 entitlement 的稳定标识：有 id 字段用 id；样本里没有就用包名组合兜底。 */
  function packSeed(item, base) {
    var pkg = base && base.product_extra && base.product_extra.package_extra;
    return String(
      item.entitlement_id || item.id || (base && base.id) || (pkg && pkg.package_id)
      || [item.group_name || "", (pkg && pkg.package_name) || ""].join("|")
    );
  }

  /**
   * 与 workbuddy.js 共用 normalize 里的同一份短码实现（8 位 hex）：
   * 两家的 label 短码必须是同一套算法，各写一份迟早有一边改了另一边没改。
   */
  function stableTag(seed) {
    return N && N.stableTag ? N.stableTag(seed) : "";
  }

  /**
   * 日期后缀通常已能区分十几笔同名签到奖励；只有同一响应里出现 (名称+日期)
   * 都相同的组才追加稳定短码。只对重复组加是有意的：无条件给所有行加短码，
   * 已有批次会因 label 变化整批换 dedupKey，下次同步全部按新增处理、旧批次
   * 永远挂在日历上，余额直接翻倍。
   */
  function labelRows(rows) {
    var count = {}, i;
    for (i = 0; i < rows.length; i++) {
      var k = rows[i].base + " " + rows[i].day;
      count[k] = (count[k] || 0) + 1;
    }
    return rows.map(function (r) {
      var label = r.base + (r.day ? " " + r.day : "");
      if (count[r.base + " " + r.day] > 1) label += " · " + stableTag(r.seed);
      return { label: label, granted: r.granted, remaining: r.remaining, expiry: r.expiry, unit: "credits" };
    });
  }

  function extract(capture) {
    var status = Number(capture && capture.status);
    if (status === 401 || status === 403) {
      throw new Error("登录态失效（HTTP " + status + "）");
    }
    if (isFinite(status) && status >= 400) {
      throw new Error("额度接口返回 HTTP " + status);
    }

    var data = JSON.parse(capture.bodyPreview);
    var packs = data && data.user_entitlement_pack_list;
    if (!Array.isArray(packs)) return [];

    var rows = [];
    packs.forEach(function (item) {
      if (!item) return;
      var base = item.entitlement_base_info || {};

      var quota = packQuota(item, base);
      var limit = Number(quota && quota.credits_limit);
      if (!isFinite(limit) || limit <= 0) return;   // 免费包/零额度不是积分批次

      var iso = expiryIso(item.expire_time != null ? item.expire_time : base.end_time);
      if (!iso) return;

      var used = Number(item.usage && item.usage.credits_amount);
      if (!isFinite(used) || used < 0) used = 0;
      var remaining = limit - used;
      if (remaining < 0) remaining = 0;

      var day = expiryDay(iso);
      rows.push({
        base: baseLabel(item, base),
        day: day,
        seed: packSeed(item, base),
        granted: limit,
        remaining: remaining,
        expiry: iso
      });
    });
    return labelRows(rows);
  }

  var adapter = {
    // 页面会同时请求套餐、账单、活动等接口；必须精确到这份额度明细。
    endpointHint: /\/user_current_entitlement_list(?:[?#]|$)/i,
    extract: extract
  };
  root.CreditAdapters.register("trae", adapter);
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})(typeof self !== "undefined" ? self : globalThis);
