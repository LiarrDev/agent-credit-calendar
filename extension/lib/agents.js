/*
 * agents.js — 四个平台的静态配置。
 *
 * consoleUrl 的默认值来自用户本人提供的后台地址（2026-10-21 那一轮），不是猜的。
 * 用户仍可在「授权与样本」里改掉；清空后 migrate 会把默认值填回来。
 *
 * fetchMode 的含义：
 *   unauthorized   还没授权，不知道能不能抓（其余三家的初始态）
 *   direct         已知接口，在同源页面上下文里直读一次（Qoder）
 *   capture        已授权并截获过接口样本，但字段映射还没写
 *   background     裸调接口（已论证不做，保留字面量只防旧文档）
 *   hidden-tab     只能靠开后台标签页让页面自己发请求、我们截获响应
 *   manual-only    抓不到，纯手填
 */
(function (root) {
  "use strict";

  var AGENTS = [
    // Qoder 走「页面内只读直读」：不注入钩子（已实测钩子在场会作废站点登录态，解除后恢复）。
    // fetchMode 与 origin 是默认值，store.migrate 会把旧文档里的 capture 强制升级成 direct。
    { id: "qoder",     name: "Qoder",     unit: "credits", color: "#4f6ef7",
      consoleUrl: "https://qoder.com/account/usage",
      origin: "https://qoder.com",
      fetchMode: "direct",
      direct: true,
      hint: "Qoder 账户用量页。读取时在页面内发一次只读请求，不装钩子、不影响登录" },
    { id: "trae",      name: "TRAE",      unit: "credits", color: "#e8663c",
      consoleUrl: "https://www.trae.cn/dashboard",
      hint: "TRAE 控制台的额度页。月度包与签到/活动包按批进入日历，顶部合计不单独成批" },
    { id: "workbuddy", name: "WorkBuddy", unit: "credits", color: "#0f9d76",
      consoleUrl: "https://www.workbuddy.cn/profile/plans-usage",
      hint: "WorkBuddy 后台的额度页。当前适配免费/赠送包接口；若控制台还有单独的付费套餐，需要再补一个接口样本" },
    { id: "lobsterai", name: "LobsterAI", unit: "credits", color: "#9b51d6",
      consoleUrl: "https://lobsterai.youdao.com/portal#/profile/detail",
      hint: "LobsterAI 个人资料页。额度接口在另一个子域，钩子挂在 portal 页面即可截获" }
  ];

  var MODE_LABEL = {
    unauthorized: ["未授权", "u"],
    direct:       ["接口直读", "b"],
    capture:      ["已截获样本", "h"],
    background:   ["接口直取", "b"],
    "hidden-tab": ["后台页截获", "h"],
    "manual-only": ["手动录入", "m"]
  };

  function byId(id) {
    for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === id) return AGENTS[i];
    return null;
  }

  function originOf(url) {
    try { return new URL(url).origin; } catch (e) { return ""; }
  }

  /**
   * 判定一条捕获样本该记到哪个平台——这是唯一的归属入口，别在别处另起一套。
   *
   * trusted（可信通道）只有一种：扩展自己的 UI 页面发来的「粘贴样本」。此时
   * agentId 由用户在该平台卡片上点击带出，可以采信（但仍校验它真的存在）。
   *
   * 其余通道（钩子 / 中继）的 entry 是页面**能够完全伪造**的对象：MAIN world 与
   * 页面脚本共享同一个 JS 环境，页面上任何脚本都能自己 postMessage 一条
   * {__creditCapture:true, entry:{agentId:"qoder", ...}}，中继只做形状校验、看不出
   * 真假。所以非可信通道一律按 sender.tab.url 的 origin 认平台——它由浏览器给出，
   * 页面改不了；只有拿不到时才退回 entry.origin。
   *
   * 放行 agentId 的后果是「A 站点的页面往 B 平台的批次里塞数据」，比如 workbuddy.cn
   * 上的脚本伪造一份 Qoder adapter 认得出的 JSON 改掉 Qoder 的到期日。这超出了我们
   * 声明的边界（站点顶多能伪造自己那一家的样本），也正踩在「静默给出错误到期日比
   * 手动录入更危险」这条底线上。
   */
  function attributeAgent(entry, sender, trusted, agents) {
    entry = entry || {};
    agents = agents || {};

    if (trusted) {
      return entry.agentId && agents[entry.agentId] ? entry.agentId : null;
    }

    var tabOrigin = originOf((sender && sender.tab && sender.tab.url) || "");
    var origin = tabOrigin || entry.origin || "";
    if (!origin) return null;

    var ids = Object.keys(agents);
    for (var i = 0; i < ids.length; i++) {
      if (agents[ids[i]] && agents[ids[i]].origin === origin) return ids[i];
    }
    return null;
  }

  /**
   * 判断一条被截获的响应"像不像积分接口"。纯启发式，只用于缩小候选，
   * 最终字段映射还是要人看样本后写 adapter。
   */
  var CREDITY = /credit|quota|usage|balance|expire|expiry|reset|renew|subscription|plan|point|allowance|remaining|entitlement/i;
  var BATCHY  = /credit|quota|point|balance|remaining|allowance|entitlement|expire|expiry|reset|renew/i;

  /** 静态资源与埋点域名一律不算候选。注入层也查一遍，这里是入库前的第二道闸。 */
  var STATIC = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(\?|$)/i;
  var TRACKER = /(google-analytics|googletagmanager|sentry|analytics|log\.|track|beacon|hotjar|clarity|facebook|doubleclick)/i;

  function isStaticUrl(url) { return STATIC.test(url) || TRACKER.test(url); }

  function scoreCapture(url, bodyText) {
    if (isStaticUrl(url)) return { score: 0, reasons: ["静态资源或埋点请求"] };
    var score = 0, reasons = [];
    if (CREDITY.test(url)) { score += 2; reasons.push("url 含积分类关键词"); }
    if (!bodyText || bodyText.length < 8) { return { score: 0, reasons: ["响应体为空"] }; }
    if (bodyText.length > 400000) { return { score: 0, reasons: ["响应体过大，跳过"] }; }

    var hits = bodyText.match(/"[^"]*(credit|quota|point|balance|expire|expiry|reset|renew|remaining|allowance)[^"]*"\s*:\s*[^,}\]]+/gi);
    if (hits && hits.length) {
      score += Math.min(6, hits.length);
      reasons.push("响应里有 " + hits.length + " 个疑似额度字段");
    }
    // 出现多个日期字段 -> 更像"一批各有到期日的额度"，这是我们要的形态
    var dates = bodyText.match(/\d{4}-\d{2}-\d{2}/g);
    if (dates && dates.length >= 2) { score += 3; reasons.push("含 " + dates.length + " 个日期，可能是多批次"); }

    return { score: score, reasons: reasons };
  }

  var api = {
    AGENTS: AGENTS, MODE_LABEL: MODE_LABEL, byId: byId,
    originOf: originOf, attributeAgent: attributeAgent,
    scoreCapture: scoreCapture, isStaticUrl: isStaticUrl
  };
  root.CreditAgents = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
