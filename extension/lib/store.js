/*
 * store.js — 唯一读写持久化的地方。
 *
 * 扩展里走 chrome.storage.local；在普通 file:// 下预览时自动降级到 localStorage，
 * 这样同一份 UI 代码既能当扩展页面跑，也能不装扩展直接打开看。
 *
 * 整个文档存在一个 key 下，一次读一次写。数据量级是几十条批次，不做分片。
 */
(function (root) {
  "use strict";

  var KEY = "credit-calendar-v1";

  var hasChrome = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  function defaults() {
    var agents = {};
    var list = (root.CreditAgents && root.CreditAgents.AGENTS) || [];
    list.forEach(function (a) {
      agents[a.id] = {
        id: a.id, name: a.name, unit: a.unit,
        consoleUrl: a.consoleUrl || "",
        // Qoder 这类已知接口的平台直接用 direct；其余平台仍从未授权开始。
        fetchMode: a.fetchMode || "unauthorized",
        origin: a.origin || null,
        enabled: true,
        lastSyncAt: null, lastError: null,
        // 授权会话：点「授权」后先记一笔等待，截到目标接口时后台自动收尾。
        // 存进文档而不是内存，MV3 的 service worker 被回收后等待状态也不会丢。
        authPending: null,
        authResult: null
      };
    });
    return {
      schema: 1,
      batches: [],
      agents: agents,
      captures: [],
      settings: { threshold: 14, staleDays: 7, lazySyncDays: 3 },
      lastSyncAt: null,
      ui: { view: null, sel: null, edit: null, wasted: null }
    };
  }

  /** 读进来的数字一律夹到合法区间：坏值不该靠每条写入路径各自记得夹一次。 */
  function clampInt(v, min, max, dflt) {
    var n = typeof v === "number" ? v : parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    n = Math.round(n);
    return Math.min(max, Math.max(min, n));
  }

  function migrate(doc) {
    var d = Object.assign(defaults(), doc || {});
    var st = Object.assign(defaults().settings, (doc && doc.settings) || {});
    /* 读路径也必须钳制，而不是只在 onchange 里夹。
     * 反例：v0.3.11 之前写进去的 threshold: NaN 会一直躺在文档里，
     * upcoming() 的 `d <= NaN` 恒为 false →「未来 14 天无积分到期」永远显示，
     * 而 #thr 下拉的 value 是 "NaN"、选中态直接空掉。用户看不出任何异常，
     * 只会以为"最近确实没有要过期的"。 */
    st.threshold = clampInt(st.threshold, 1, 365, 14);
    st.staleDays = clampInt(st.staleDays, 1, 60, 7);
    st.lazySyncDays = clampInt(st.lazySyncDays, 0, 90, 3);
    d.settings = st;
    d.ui = Object.assign({ view: null, sel: null, edit: null, wasted: null }, (doc && doc.ui) || {});
    // agent 配置以代码里的 AGENTS 为准，存储里只留用户可改的字段
    var base = defaults().agents;
    Object.keys(base).forEach(function (id) {
      var saved = (doc && doc.agents && doc.agents[id]) || {};
      // direct 是代码级取数方式，不由旧存储状态决定。Qoder 从 v0.3 起强制直读：
      // 旧文档里残留的 capture + hookActive 必须压回 direct + false，
      // 否则升级后同步还会自动注入那个会作废登录态的钩子。
      var isDirect = base[id].fetchMode === "direct";
      d.agents[id] = Object.assign(base[id], {
        // 空串视同没填：代码里预置的默认地址要能覆盖旧文档里的空值。
        // direct 平台的取数页面在 adapter 里写死，存储里的自定义地址对它没有意义。
        consoleUrl: isDirect ? base[id].consoleUrl : (saved.consoleUrl || base[id].consoleUrl),
        fetchMode: isDirect ? "direct" : (saved.fetchMode || base[id].fetchMode),
        origin: isDirect ? base[id].origin : (saved.origin || null),
        // endpoint 是**运行时事实**（这一家真正读到的接口），不该每次 load 被抹掉：
        // 直读流水线和 syncOne 都会写它，抹成 null 就成了只写不读的字段，诊断页对
        // Qoder 永远显示「未记录」。唯一例外是 Qoder 从钩子迁到直读的那一次——
        // 那时的 endpoint 记的是已经废掉的钩子路径，留着会把排查引到错地方。
        endpoint: isDirect && saved.fetchMode !== "direct" ? null : (saved.endpoint || null),
        lastSyncAt: saved.lastSyncAt || null,
        // 旧版钩子失败留下的红字对直读没有意义，Qoder 升级到 direct 的那一次清掉；
        // 已经是 direct 的文档要保留真实错误，其余平台更不能每次加载都被抹掉。
        lastError: isDirect && saved.fetchMode !== "direct" ? null : (saved.lastError || null),
        lastHookAt: isDirect ? null : (saved.lastHookAt || null),
        lastRelayAt: isDirect ? null : (saved.lastRelayAt || null),
        // 钩子当前是否注册着：决定「立即同步」能不能先做活体刷新，
        // 也决定「刷新余额」走常驻还是临时钩子。
        // 严格认 true：这个标记会让同步自动去注入页面，脏值当真值处理等于偷偷装钩子。
        hookActive: isDirect ? false : saved.hookActive === true,
        // 最近一次"页面确实响应了"的时刻（含内容没变的重复响应）
        lastSeenAt: saved.lastSeenAt || null,
        // 最近一次**目标接口**响应的时刻。刷新流程靠它区分「目标回来了」和
        // 「只是 plans/usage 这类干扰接口先回来了」，漏迁会被 migrate 丢掉。
        lastTargetAt: isDirect ? null : (saved.lastTargetAt || null),
        // 最近一次刷新的探针记录：失败时靠它定位断在哪一环，别让人瞎试。
        // Qoder 从钩子迁到直读时，旧探针记录的是已经废掉的路径，清掉免得诊断页张冠李戴。
        probe: isDirect && saved.fetchMode !== "direct" ? null : (saved.probe || null),
        // 授权等待/结果只对截获类平台有意义；直读平台没有「授权」这一步。
        authPending: isDirect ? null : (saved.authPending || null),
        authResult: isDirect ? null : (saved.authResult || null)
      });
    });
    if (!Array.isArray(d.batches)) d.batches = [];
    if (!Array.isArray(d.captures)) d.captures = [];
    return d;
  }

  function load() {
    if (hasChrome) {
      return chrome.storage.local.get(KEY).then(function (r) {
        return migrate(r && r[KEY]);
      });
    }
    try {
      var s = localStorage.getItem(KEY);
      return Promise.resolve(migrate(s ? JSON.parse(s) : null));
    } catch (e) {
      return Promise.resolve(defaults());
    }
  }

  function save(doc) {
    if (hasChrome) return chrome.storage.local.set((function (o) { o[KEY] = doc; return o; })({}));
    try { localStorage.setItem(KEY, JSON.stringify(doc)); } catch (e) { /* 配额满，忽略 */ }
    return Promise.resolve();
  }

  /**
   * 读-改-写。并发写会互相覆盖，所以调用方一律走这里，不要各自 load 后再 save。
   *
   * ⚠️ mutator 里禁止再调 update()：整条队列是串行的，内层 update 排在自己后面，
   * 而外层要等内层 resolve 才能继续 —— 必然死锁（表现为"存不进去、也不报错"）。
   * mutator 只做纯内存修改，要读的数据从它拿到的 doc 里取。
   */
  var chain = Promise.resolve();
  function update(mutator) {
    var run = chain.then(function () {
      return load().then(function (doc) {
        var res = mutator(doc);
        return save(doc).then(function () { return res === undefined ? doc : res; });
      });
    });
    // 单次失败不能把整条队列卡死
    chain = run.catch(function () {});
    return run;
  }

  function wipe() {
    if (hasChrome) return chrome.storage.local.remove(KEY);
    try { localStorage.removeItem(KEY); } catch (e) {}
    return Promise.resolve();
  }

  var api = {
    KEY: KEY, load: load, save: save, update: update, wipe: wipe,
    defaults: defaults, migrate: migrate, hasChrome: !!hasChrome
  };
  root.CreditStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
