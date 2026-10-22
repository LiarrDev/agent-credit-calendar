/*
 * adapters/qoder.js — Qoder 用量接口的字段映射。
 *
 * 样本来源：2026-10-21 用户提供的真实响应（GET /api/v2/me/usages/big_model_credits）。
 *
 * 响应骨架：
 *   {
 *     plan_quota:                  { quota_summary, quota_detail[] },
 *     resource_package_quota:      { quota_summary, quota_detail[] },
 *     dedicated_resource_package_quota: { quota_summary, quota_detail|null },
 *     total_quota:                 { quota_summary, quota_detail[] },  // 前三段的并集！
 *     lastResetAt, nextResetAt
 *   }
 *   quota_detail[]: { id, limit_value, used_value, remaining_value, unit,
 *                     is_active, usage_percentage,
 *                     expires_at,   // 毫秒时间戳；0 = 无到期日
 *                     source, status }
 *
 * 映射规则（每条都对应样本里看得到的事实）：
 *   - 只取三个分段的 quota_detail，**不取 total_quota**——它是并集，取了每笔批次会出现两次。
 *     （就算误取，dedupKey 相同也会在合并时收敛，但 added 计数会脏，源头就别错。）
 *   - expires_at === 0 表示无到期日（样本里的 PLAN 主额度就是 0）。批次模型要求到期日，
 *     编一个比不显示更糟，所以跳过；哪天主额度有了非零金额，需要给模型加"无到期批次"
 *     的表示法，再回来改这里。
 *   - limit_value === 0 的不算批次（没发过东西）。
 *   - expires_at 是毫秒时间戳，按"清零时刻"理解：直接把数字交给 normalizeBatch，
 *     统一规则会减一天得到"最后可用日"（宁可少标一天，见 normalize.js 的 fromInstant）。
 *   - label = source + " #" + id 末四位。source 会大批重复（全是
 *     RESOURCE_PACKAGE_SOURCE_BONUS），id 才是服务端给每批的稳定标识；
 *     label 里**不放到期日**——冻结批次靠 (agent+label) 兜底匹配，放了就会失配冒重复。
 *   - 已用完的批次（remaining=0）保留：它们是真实历史，过期后也不进沉没成本
 *     （沉没成本只看"过期且剩余>0"），但明细里该看得见。
 */
(function (root) {
  "use strict";

  var SECTIONS = ["plan_quota", "resource_package_quota", "dedicated_resource_package_quota"];

  function extract(capture) {
    var data = JSON.parse(capture.bodyPreview);
    var rows = [];
    SECTIONS.forEach(function (sec) {
      var detail = data && data[sec] && data[sec].quota_detail;
      if (!Array.isArray(detail)) return;
      detail.forEach(function (d) {
        if (!d || !d.expires_at) return;   // 无到期日（主额度）暂不进日历
        if (!d.limit_value) return;        // 零额度不算批次
        rows.push({
          label: (d.source || sec) + " #" + String(d.id || "").slice(-4),
          granted: d.limit_value,
          remaining: d.remaining_value,
          expiry: d.expires_at,
          unit: d.unit || "credits"
        });
      });
    });
    return rows;
  }

  /* 页面内直读配方（v0.3）。
   *
   * 为什么不再用 MAIN world 钩子：已实测「钩子在场」就会让
   * 登录态失效（解除钩子即恢复，因果已确认）。继续包 fetch 等于用登录态换数据。
   *
   * 直读不是扩展后台拿 cookie 裸调：请求在 **qoder.com 页面上下文**里发起，
   * 和页面自己点用量页完全同源同凭据。CSRF token 由页面里的函数从 window.csrfToken
   * 读取后立即放进请求头——值不经过扩展进程、不落盘、不上报；cookie 由浏览器自己带。
   *
   * 这三个请求头和站点自己的 axios 配置逐字对齐（见其前端 bundle）：
   *   X-CSRF-TOKEN: window.csrfToken
   *   x-requested-with: XMLHttpRequest
   *   X-Timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
   */
  var direct = {
    url: "https://qoder.com/api/v2/me/usages/big_model_credits",
    pageUrl: "https://qoder.com/account/usage",
    loginPath: "/users/sign-in",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    csrf: true,
    // x-requested-with 由页面函数按这个开关加：v0.3.14 起 background 不再无条件
    // 塞这个头（WorkBuddy 的代发走 cookie，不需要它）。
    xrw: true,
    timezone: true
  };

  var adapter = { endpointHint: /usages|credits|quota/i, direct: direct, extract: extract };
  root.CreditAdapters.register("qoder", adapter);
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})(typeof self !== "undefined" ? self : globalThis);
