/*
 * adapters/workbuddy.js — WorkBuddy 免费/赠送额度包的字段映射。
 *
 * 样本来源：2026-10-22 用户提供的真实响应
 *   GET https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages
 *   页面：https://www.workbuddy.cn/profile/plans-usage
 *
 * 响应骨架：
 *   {
 *     code: 0, msg: "OK",
 *     data: {
 *       TotalCount: <笔数>,
 *       Accounts: [{
 *         PackageName, SubProductName, ResourceId, AccountId, DealName,
 *         CapacitySize, CapacityRemain, CapacityUsed,          // 样本里全是 0，不是余额
 *         CycleCapacitySize, CycleCapacityRemain, CycleCapacityUsed,
 *         CycleCapacitySizePrecise, CycleCapacityRemainPrecise, CycleCapacityUsedPrecise,
 *         CycleStartTime, CycleEndTime,                       // "YYYY-MM-DD HH:mm:ss"
 *         DeductionEndTime, ExpiredTime, Status,
 *         AccountAttributes: [{ Key, Value, Type }]
 *       }]
 *     }
 *   }
 *
 * 映射规则（每条都对应样本里看得到的事实）：
 *   - 只认 data.Accounts 的逐笔明细；TotalCount 是条数，不是额度。
 *   - 余额与发放量取 CycleCapacity*Precise（回退到 CycleCapacity*）。样本里
 *     CapacitySize / CapacityRemain / CapacityUsed 全是 0，拿它当余额会把 40 余笔
 *     全部显示成 0。Precise 字段带小数（体验版剩余带小数）。
 *   - 到期时刻取 CycleEndTime，按清零时刻减一天得到最后可用日。
 *     不用 DeductionEndTime：体验版那笔的 DeductionEndTime 在 2035 年，明显不是
 *     这一轮的失效时刻；也不用 ExpiredTime（样本里全是空串）。
 *   - 不按 Status / CapacityType 过滤：样本里 40 余笔 Status 都是 0，没有枚举定义；
 *     猜一个值可能把真实余额藏掉。零剩余保留，否则余额降到 0 的过程会消失。
 *   - 40 余笔里多数叫「CodeBuddy个人版国内运营裂变包」，而且很多笔同一天到期
 *     （多笔同一天），只加日期后缀仍会撞 dedupKey。因此 label 末尾再加一个
 *     由 ResourceId 派生的 8 位稳定短码；不存 ResourceId 原文，只存短码。
 *   - AccountAttributes 里有 payerUin 等账号信息，完全不读取、不落盘。
 *   - HTTP 401/403 明确报登录失效；code 非 0 或其它非 2xx 报接口失败，
 *     不当成「没认出批次」。
 */
(function (root) {
  "use strict";

  var N = root.CreditNormalize;

  /** 数字或数字字符串 -> number；空串/非法返回 null。 */
  function num(value) {
    if (typeof value === "number") return isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    var s = value.replace(/[,\s]/g, "");
    if (!s) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function amount(item, preciseKey, plainKey) {
    var v = num(item[preciseKey]);
    if (v != null) return v;
    return num(item[plainKey]);
  }

  /** 与服务端时间一致的展示用后缀；换算交给 normalize，避免两处规则漂移。 */
  function lastUsableDay(iso) {
    return N && N.daySuffix ? N.daySuffix(iso, "resetsAt") : null;
  }

  /**
   * 稳定短码：同一个 ResourceId 每次同步得到同一个值。
   * 只用于让同名同到期日的包互不覆盖，不保存原始 id。
   * 用 FNV-1a + 位混淆，避免只差末尾字符的 id 在截断后撞码。
   */
  function stableSeed(item) {
    return String(item.ResourceId || item.AccountId || item.DealName || item.PackageCode || "");
  }

  /**
   * 与 trae.js 共用 normalize 里的同一份短码实现（8 位 hex）：
   * 两家的 label 短码必须是同一套算法，各写一份迟早有一边改了另一边没改。
   */
  function stableTag(seed) {
    return N && N.stableTag ? N.stableTag(seed) : "";
  }

  function baseLabel(item) {
    return String(
      item.PackageName
      || item.SubProductName
      || item.ProductName
      || "WorkBuddy 额度"
    ).trim();
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
    if (!data || typeof data !== "object") return [];
    if (data.code != null && Number(data.code) !== 0) {
      throw new Error("额度接口返回 code=" + data.code + (data.msg ? "（" + data.msg + "）" : ""));
    }
    var accounts = data.data && data.data.Accounts;
    if (!Array.isArray(accounts)) return [];

    var rows = [];
    var seen = {};
    accounts.forEach(function (item) {
      if (!item) return;

      var size = amount(item, "CycleCapacitySizePrecise", "CycleCapacitySize");
      var remain = amount(item, "CycleCapacityRemainPrecise", "CycleCapacityRemain");
      if (size == null && remain != null) size = remain;
      if (remain == null) {
        var used = amount(item, "CycleCapacityUsedPrecise", "CycleCapacityUsed");
        if (size != null && used != null) remain = size - used;
      }
      if (size == null || size <= 0 || remain == null) return;
      if (remain < 0) remain = 0;

      var iso = item.CycleEndTime;
      if (!iso) return;
      var day = lastUsableDay(iso);
      if (!day) return;

      var seed = stableSeed(item);
      var tag = stableTag(seed);
      // 同一份响应里重复的资源只留一笔，避免 label/dedupKey 完全相同的两行互相覆盖。
      // 内部按原始 seed 判重，不用 8 位短码，短码碰撞不应该吃掉一笔真实额度。
      if (seed && seen[seed]) return;
      if (seed) seen[seed] = true;

      var label = baseLabel(item) + " " + day + (tag ? " · " + tag : "");
      rows.push({
        label: label,
        granted: size,
        remaining: remain,
        expiry: iso,
        semantics: "resetsAt",
        unit: "credits"
      });
    });
    return rows;
  }

  /* 页面没发请求时的兜底：在页面上下文里代发同一个只读 POST（v0.3.14）。
   *
   * 为什么需要：真机日志里出现过「钩子在、页面也加载完了，但一次额度接口都没发」
   * 的情况（探针 responses 全是 galileotelemetry 埋点，targetSeen=false）。
   * 前端 bundle 里套餐数据由 getCurrentPlan() 触发，而它被登录态（uid）与
   * 页面分区状态挡在前面——我们没法从扩展侧让 SPA 重新取数，只能在同一个
   * 页面上下文里替它发一次**与站点自己完全一致**的请求。
   *
   * 参数逐字来自站点自己的前端 bundle（assets.workbuddy.cn …/config-PxOBnci5.js）：
   *   ys = e => _.post("/billing/meter/get-user-resource-free-packages", e)
   *   调用点在 index-YX--o6WY.js 的 getCnPlan：PageNumber 1 / PageSize 200 /
   *   Status:[valid=0] / 今天 00:00:00–23:59:59 / PackageCodes 见下。
   *   X-Client-Platform 由站点 axios 拦截器统一写 "web"（re() 为假时）。
   *
   * 边界：只在「钩子两轮都没等到目标接口」之后才走这条路；body 在后台按当天
   * 日期构造，不含任何账号字段；请求由页面自己发（同源 + credentials include），
   * 扩展不接触 cookie / token。返回不是 2xx 或不是 JSON 时如实报错，不写批次。
   */
  var WB_PACKAGE_CODES = [
    "TCACA_code_008_cfWoLwvjU4",   // freeMon 免费包
    "TCACA_code_007_nzdH5h4Nl0",   // activity 活动赠送
    "TCACA_code_028_NtpWi0jzXs",   // versionBonus 版本福利
    "TCACA_code_029_6wCGEWquYy",   // compensation 补偿
    "TCACA_code_030_BjSt89qTvr"    // newUserBonus 新人礼
  ];

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  /** 与站点 getCnPlan 完全一致的请求体；时间切片取"今天"（本地时区）。 */
  function buildBody(now) {
    var d = now instanceof Date ? now : new Date();
    var day = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    return {
      PageNumber: 1,
      PageSize: 200,
      Status: [0],
      SlicePeriodStartTime: day + " 00:00:00",
      SlicePeriodEndTime: day + " 23:59:59",
      PackageCodes: WB_PACKAGE_CODES.slice()
    };
  }

  var readFallback = {
    url: "https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages",
    pageUrl: "https://www.workbuddy.cn/profile/plans-usage",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Client-Platform": "web"
    },
    buildBody: buildBody
  };

  var adapter = {
    // 页面会同时请求套餐、账单、用量等接口；只认这份免费/赠送包明细。
    endpointHint: /\/billing\/meter\/get-user-resource-free-packages(?:[?#]|$)/i,
    extract: extract,
    readFallback: readFallback
  };
  root.CreditAdapters.register("workbuddy", adapter);
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})(typeof self !== "undefined" ? self : globalThis);
