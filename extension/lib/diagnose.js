/*
 * diagnose.js — 把「刷新探针」的五段计数翻译成一句人话。
 *
 * 为什么单独成文件：探针由 background 记录、由 UI 展示，两边都要把同一份计数翻成
 * 结论。各写一份必然漂移——v0.3.9 时两边的措辞已经不一样了（直读成功那句后台带
 * 字节数、UI 不带；「钩子没注入」那句两边的解释长度也不同），于是同一份探针在
 * 两个地方显示成两句话，读的人根本分不清该信哪个。
 *
 * 这里是唯一的口径：background 存探针后用它生成 diagnosis 回传，UI 也调它渲染。
 * 纯函数、不碰 chrome.*，所以能在 node 里直接测。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CreditDiagnose = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /**
   * 照探针计数推断「断在哪一环」。
   *
   * 探针形态（两种取数方式共用一套字段）：
   *   mode        "direct" 页面内直读 / 其余为钩子截获
   *   hookAt / relayAt   两个注入心跳的时刻（缺哪个就知道注入断在哪）
   *   responses   页面一共发了几个响应（打分刷掉的也算，用来区分"没发"和"发了但不像"）
   *   candidates  过了打分的候选数
   *   stored / dups / upgraded   入库 / 重复 / 由截断样本升级
   *   outcome     直读模式的终态（auth / http-error / no-quota / not-json / direct / direct-dup）
   */
  function core(p) {
    if (!p) return "没有探针记录";

    /* 直读只有一条链路：开页 → 页面内 fetch → 看 HTTP 状态 → 入库。
     * 失败时最要紧的是区分「没登录（401/403）」和「接口/页面出问题」，两者解法不同。 */
    if (p.mode === "direct") {
      if (p.outcome === "auth") {
        return "接口返回 " + (p.httpStatus || "401/403")
          + "：这个页面没有登录态。已把页面切到前台，登录后再点「刷新余额」。";
      }
      if (p.outcome === "page-error") return "页面内请求没发出去：" + (p.error || "未知错误");
      if (p.outcome === "http-error") return "接口返回 HTTP " + (p.httpStatus || "?") + "，这次没拿到数据。";
      if (p.outcome === "no-quota") return "接口返回 200，但响应里没有额度字段 —— 平台可能改版了。";
      if (p.outcome === "not-json") return "接口回了 200，但不是 JSON —— 多半被重定向到登录页或站点换了接口。";
      if (p.outcome === "direct") {
        if (p.upgraded) {
          return "直读成功：接口返回 200，之前截断的旧样本已替换为完整响应（"
            + (p.bodyBytes || "?") + " 字节）。";
        }
        return "直读成功：接口返回 200，存了 " + p.stored + " 条新样本（"
          + (p.bodyBytes || "?") + " 字节）。";
      }
      if (p.outcome === "direct-dup") {
        return "接口返回 200，但内容和上次逐字节相同 —— 余额确实没变。";
      }
      return "直读没完成，原因未记录。";
    }

    // outcome:"error" 是「刷新流程本身崩了」（注册脚本失败、开页失败……），
    // 不是「平台没给数据」。两者解法完全不同，必须分开说，不能掉进下面的计数推断。
    if (p.outcome === "error") {
      return "刷新流程本身出错了：" + (p.error || "原因未记录") + "。这不是平台没给数据，"
        + "下面的计数只记录到一半，参考意义有限。";
    }

    if (!p.hookAt && !p.relayAt) {
      return "钩子根本没注入到这个页面（两个心跳都没收到）。可能是页面在注册之前就加载完了，或该浏览器挡住了 MAIN world 注入。";
    }
    if (p.relayAt && !p.hookAt) {
      return "中转脚本注上了、MAIN world 钩子没起来 —— 这个浏览器不支持注入到页面上下文，"
        + "截不到接口响应，只能走「粘贴样本」。";
    }
    if (p.responses === 0) {
      return "钩子在，但这个页面一个接口响应都没发出来。数字可能是服务端直接渲染进 HTML 的，"
        + "或页面在后台标签里没真正加载。";
    }
    // endpointStatus 只在「adapter 指定了目标接口、且这条响应就是它」时才记录
    // （background 的 storeCapture 负责写）。它被刷掉、样本库里看不到时，
    // 这里是唯一能说出"目标接口到底回了什么"的地方。
    if (p.endpointStatus && p.endpointStatus >= 400) {
      return "目标接口本身返回了 HTTP " + p.endpointStatus + "（" + (p.endpointBytes || 0)
        + " 字节，不是额度数据）—— "
        + (p.endpointStatus === 401 || p.endpointStatus === 403
          ? "登录态已失效。重新打开该平台的后台页面登录一次，再点「刷新余额」。"
          : "接口侧报错了，稍后重试；若持续出现，站点可能改了接口，把「看样本」里的记录发我。");
    }
    if (p.endpointStatus === 200 && p.candidates === 0) {
      return "目标接口回了 200（" + (p.endpointBytes || 0) + " 字节），但内容不像额度数据 —— "
        + "可能被重定向到登录页，或站点改了响应结构。把「看样本」里最新的响应发我看看。";
    }
    // hasHint/targetSeen 由 background 的 beginProbe/storeCapture 写入；旧探针没有
    // 这两个字段（undefined），不走这个分支，行为与老版本一致。
    if (p.hasHint && p.targetSeen === false && p.responses > 0) {
      return "页面发了 " + p.responses + " 个响应，但 adapter 认定的目标接口这一次根本没被请求 —— "
        + "页面可能用了本地缓存的数据，或这份额度要页面上某个分区被点开才会加载。"
        + "在打开的页面里切到套餐/用量相关的分区再刷新一次；急着要数据就用「粘贴样本」。"
        + ((p.rejectUrls || []).length ? "这次页面实际请求的是：" + p.rejectUrls.join("、") : "");
    }
    if (p.candidates === 0) {
      var topReason = null;
      if (p.rejectReasons) {
        var rks = Object.keys(p.rejectReasons);
        for (var ri = 0; ri < rks.length; ri++) {
          if (topReason === null || p.rejectReasons[rks[ri]] > p.rejectReasons[topReason]) topReason = rks[ri];
        }
      }
      return "页面发了 " + p.responses + " 个响应，但没有一个像积分接口（全被打分刷掉"
        + (topReason ? "，主要是：" + topReason : "") + "）。目标接口可能在别的域名上。";
    }
    if (p.stored === 0 && p.upgraded > 0) {
      return "截到了积分接口，并把之前截断的旧样本替换成了完整响应"
        + (p.dups > p.upgraded ? "（另有 " + (p.dups - p.upgraded) + " 条重复）" : "") + "。";
    }
    if (p.stored === 0 && p.dups > 0) {
      return "截到了积分接口，但响应内容和已存样本逐字节相同 —— 数字确实没变（样本时间已更新）。";
    }
    if (p.stored > 0) {
      return "截到并存了 " + p.stored + " 条新样本（最高分 " + p.bestScore + "）"
        + (p.superseded ? "，顺手清掉 " + p.superseded + " 条被它取代的旧截断样本" : "") + "。";
    }
    return "有 " + p.candidates + " 条候选但没入库，原因未记录。";
  }

  /**
   * 对外唯一入口：先按上面的口径判断点，再把「代发兜底」的结果接在后面。
   *
   * 为什么要接在后面而不是另起一句：钩子路径和代发路径是同一次刷新的两段，
   * 只报其中一段会让人以为"页面明明发了请求"或"扩展什么都没做"。两段都在，
   * 才能解释「页面自己没发、扩展代发成了」这种真实情况。
   */
  function of(p) {
    var fb = p && p.fallback;

    // 代发成功时，「截到 / 没截到」这套说法整段失效：这一次的数据根本不是页面发的，
    // 是扩展在页面里替它发的一次只读请求。以前是把它接在「没截到候选」后面，
    // 于是同一屏上出现「页面发了 N 个响应、一个都不像积分接口」＋「代发成功已入库」
    // 两句互相打架的话（2026-10-22 17:29 的真机诊断就是这样）。
    if (fb && fb.ok && p.outcome === "both-failed") {
      var head = "页面自己一次额度接口都没发"
        + (p.responses ? "（那 " + p.responses + " 个响应全是别的接口）" : "")
        + "；扩展在这个页面里代发了一次，HTTP " + (fb.status || "?") + "，"
        + (fb.bytes || 0) + " 字节。";
      if (p.stored > 0) return head + "存了 " + p.stored + " 条新样本 —— 数字已更新。";
      if (p.dups > 0) return head + "但响应内容和上次逐字节相同 —— 余额确实没变。";
      return head + "但没入库，原因未记录。";
    }

    var text = core(p);
    if (!fb) return text;
    if (fb.ok) {
      return text + "（另外：扩展在这个页面里代发了一次额度请求，HTTP " + (fb.status || "?")
        + "，" + (fb.bytes || 0) + " 字节，已入库。）";
    }
    return text + "（另外：扩展代发也失败 —— " + (fb.message || "原因未记录") + "）";
  }

  return { of: of };
});
