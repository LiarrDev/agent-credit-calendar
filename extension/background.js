/*
 * background.js — MV3 service worker。
 *
 * 职责：注册/注销注入脚本、接收捕获样本、管理授权标签页、执行同步。
 *
 * 一个实现约束值得记下来：chrome.permissions.request() 在 service worker 里不可用，
 * 必须从扩展页面（calendar.html）在用户手势里调用。所以"申请域名权限"发生在 UI，
 * 这里只负责拿到权限之后的注册与抓取。
 */
"use strict";

importScripts("lib/normalize.js", "lib/store.js", "lib/agents.js", "lib/diagnose.js", "adapters/index.js");
importScripts("adapters/qoder.js");
importScripts("adapters/lobsterai.js");
importScripts("adapters/trae.js");
importScripts("adapters/workbuddy.js");

var CAL_URL = chrome.runtime.getURL("ui/calendar.html");
var MAX_CAPTURES = 60;
var SYNC_WAIT_MS = 12000;
var DIRECT_WAIT_MS = 20000;
// 授权等待窗口：点「授权」后，用户需要在这段时间内完成登录。
// 超过之后即使再截到响应也不再自动收尾，免得几天后逛一次后台就突然改日历。
var AUTH_PENDING_MS = 10 * 60 * 1000;

/* 等待中的同步：origin -> {resolve, timer, endpoint} */
var pending = {};
/* 授权收尾互斥：同一平台可能一次返回多条候选，只让第一条去跑 syncOne */
var authSyncing = {};

chrome.action.onClicked.addListener(function () {
  chrome.tabs.create({ url: CAL_URL });
});

chrome.runtime.onInstalled.addListener(function (details) {
  // 升级也要退役 Qoder 的旧钩子：动态注册的 content script 会跨扩展更新保留，
  // 用户什么都没点它也会继续注入，而 qoder.com 的登录态正因此失效。
  retireQoderHook();
  // 升级时顺手清掉被完整响应取代的旧截断样本（理由见 pruneShadowedTruncated）。
  pruneShadowedTruncated();
  if (details.reason === "install") {
    CreditStore.update(function (doc) { return doc; });   // 落一份初始文档
    chrome.tabs.create({ url: CAL_URL });
  }
});

chrome.runtime.onStartup.addListener(function () {
  retireQoderHook();
  pruneShadowedTruncated();
});

/* ---------- 消息路由 ---------- */

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case "CAPTURED":
      // 页面可伪造通道：agentId / origin 都不采信，归属由 sender.tab.url 决定。
      onCaptured(msg.entry, sender).then(function (r) { respond(r); },
        function (e) { respond({ ok: false, error: String(e) }); });
      return true;

    case "PASTE_CAPTURE": {
      // 粘贴样本通道：钩子不能用或不该用时的退路（页面服务端渲染不发 XHR；
      // 或站点反爬把被 hook 的 fetch 当异常）。样本仍走同一套打分与脱敏。
      var apiOrigin = originOf(msg.url);
      var prep = Promise.resolve();
      if (msg.agentId) {
        prep = CreditStore.update(function (d) {
          var a = d.agents[msg.agentId];
          if (!a) return;
          // origin 记的是「页面」而不是接口。LobsterAI 页面在 lobsterai.youdao.com，
          // 接口在 lobsterai-server.youdao.com；拿接口域名当 origin，后续钩子会注册到
          // 错地方（而且没有那个域名的权限）。已授权的 origin 不覆盖；没授权时优先
          // 从后台页面地址推断，最后才退回接口域名。
          if (!a.origin) a.origin = originOf(a.consoleUrl) || apiOrigin || null;
          // 粘贴的接口地址单独记 endpoint，不要拿它替换 consoleUrl。
          if (msg.url) a.endpoint = msg.url;
        });
      }
      prep.then(function () {
        return onCaptured({
          url: msg.url, body: msg.body, method: "GET", status: msg.status || 200,
          requestHeaderNames: [], via: "paste", origin: apiOrigin,
          // 粘贴是用户在该平台卡片上点的，平台身份已经明确；跨域接口的 URL origin
          // 认不出平台，所以这里直接带上 agentId，不靠 resolveAgent。
          agentId: msg.agentId
          // trusted：这条消息来自扩展自己的 UI 页面，不是页面脚本，可以采信 agentId。
        }, sender, { trusted: true });
      }).then(function (r) {
        // onCaptured 的入库结果本身没有 ok 字段（钩子通道由后台内部消费）；
        // 粘贴通道是 UI 直呼，UI 靠 r.ok 区分「成功 / 没入库 / 出错」三态。
        if (r && r.ok === false) { respond(r); return; }
        respond(Object.assign({ ok: true }, r || {}));
      }, function (e) { respond({ ok: false, error: String(e) }); });
      return true;
    }

    case "HOOK_READY":
    case "RELAY_READY":
      // 这两条只用来诊断「授权后一条样本都没截到」到底是注入失败还是页面根本不发 XHR：
      // 有 RELAY 没 HOOK = MAIN world 注入被挡；两个都有但没样本 = 数据是服务端渲染的。
      noteHook(msg.type, msg, sender).then(function () { respond({ ok: true }); });
      return true;

    case "REGISTER_AND_OPEN":
      registerAndOpen(msg.agentId, msg.origin, msg.url)
        .then(function (r) { respond(r); }, function (e) { respond({ ok: false, error: String(e) }); });
      return true;

    case "UNREGISTER":
      unregister(msg.origin).then(function () {
        return CreditStore.update(function (doc) {
          Object.keys(doc.agents).forEach(function (id) {
            if (doc.agents[id].origin === msg.origin) {
              doc.agents[id].hookActive = false;
              // 解除钩子也就取消了这次授权等待，面板上不该再挂着「等待登录」。
              doc.agents[id].authPending = null;
            }
          });
        });
      }).then(function () { respond({ ok: true }); },
        function (e) { respond({ ok: false, error: String(e) }); });
      return true;

    case "REFRESH_CAPTURES":
      // 截获只是拿到新样本，日历上的数字要靠 adapter + merge 才会变。
      // 这里截获成功后顺手对该平台跑一次 syncOne，让「刷新余额」一步到位，
      // 不用再手动点「立即同步」——否则用户看到的是"页面开了又关、数字没动"。
      refreshCaptures(msg.agentId, { ephemeral: !!msg.ephemeral }).then(function (r) {
        if (!r || !r.ok) return r;   // 没截到就不动 batches，把失败原因如实回给 UI
        return syncOne(msg.agentId, new Date()).then(function (s) {
          r.sync = s;
          return r;
        }, function () { return r; });   // 同步失败不影响"截获成功"这个事实
      }).then(function (r) { respond(r); },
        function (e) { respond({ ok: false, error: String(e) }); });
      return true;

    case "CLEAR_CAPTURES":
      CreditStore.update(function (doc) {
        doc.captures = (doc.captures || []).filter(function (c) { return c.agentId !== msg.agentId; });
      }).then(function () { respond({ ok: true }); });
      return true;

    case "OPEN_CALENDAR":
      chrome.tabs.create({ url: CAL_URL });
      respond({ ok: true });
      return false;

    default:
      return false;
  }
});

/* ---------- 注入注册 ---------- */

function patternFor(origin) { return origin + "/*"; }

function idsFor(origin) {
  var slug = origin.replace(/[^a-z0-9]/gi, "-").slice(-40);
  return ["credit-main-" + slug, "credit-relay-" + slug];
}

function register(origin) {
  var mainId = idsFor(origin)[0], relayId = idsFor(origin)[1];
  var match = patternFor(origin);

  // 注意：chrome.scripting 的字段是 camelCase（runAt / allFrames），
  // 和 manifest.json 里 content_scripts 的 snake_case 不是一套名字。
  // 传错名字不会警告，而是整个调用被拒（Unexpected property），注入静默失败。
  var main = { id: mainId, matches: [match], js: ["capture-main.js"], runAt: "document_start", allFrames: false };
  var relay = { id: relayId, matches: [match], js: ["capture-relay.js"], runAt: "document_start", allFrames: false };

  // world 字段要 Chrome 111+ / 对应世代的 Opera。不支持就退回 ISOLATED，
  // 那时只能读 DOM，读不到页面自己的接口响应，UI 要如实说明。
  main.world = "MAIN";
  relay.world = "ISOLATED";

  // 先注销同 ID 的旧脚本再注册：重复点「授权」或「刷新余额」时脚本已经注册过，
  // registerContentScripts 对重复 ID 是直接拒的（Duplicate script ID），
  // 不先注销的话第二次及以后每次都会失败。注销失败（本来就没注册）忽略。
  return unregister(origin).then(function () {
    return chrome.scripting.registerContentScripts([main, relay]).then(function () {
      return { worldAware: true };
    }).catch(function (err) {
      // 只有确实是 world 不支持才降级重试；别的错误（比如字段名写错）原样抛出去，
      // 否则真正的病因会被"重试也失败"盖掉，UI 上只能看到一句没信息量的报错。
      if (!/world/i.test(String((err && err.message) || err))) throw err;
      delete main.world; delete relay.world;
      return chrome.scripting.registerContentScripts([main, relay]).then(function () {
        return { worldAware: false };
      });
    });
  });
}

function unregister(origin) {
  var ids = idsFor(origin);
  return chrome.scripting.unregisterContentScripts({ ids: ids }).catch(function () { return null; });
}

/**
 * 退役 Qoder 的历史钩子。动态脚本跨浏览器重启保留，光改 UI 不会让它消失。
 *
 * 这个函数在**每次 service worker 唤醒**时都会跑（顶层调用），所以它必须
 * 「先读后判」：以前无条件 CreditStore.update() = 整份文档 load + 序列化 + set，
 * 哪怕三个字段早就是目标值。那次写入会通过 chrome.storage.onChanged 唤醒扩展页，
 * 而扩展页收到变更就重画 —— 用户正在填「补录批次」表单时（renderAdd 没有编辑标记），
 * 另一个标签页加载一次 workbuddy.cn 的心跳就能把它连同已输入的内容冲掉。
 * 现在已是目标状态就直接返回，不写、不惊动 UI。
 *
 * 注：load() 会过 migrate()，而 migrate 对 direct 平台已经强制这三项
 * （fetchMode=direct / hookActive=false / origin=代码值），所以对今天的 Qoder 来说
 * 判完必然是「已是目标状态」。update 那一支留作保险：万一以后 Qoder 不再是 direct
 * 平台，这里仍然要把它压回去，而不是悄悄跳过。
 */
var QODER_ORIGIN = "https://qoder.com";

function retireQoderHook() {
  return unregister(QODER_ORIGIN).then(function () {
    return CreditStore.load().then(function (d) {
      var a = d.agents && d.agents.qoder;
      if (!a) return null;
      if (!a.hookActive && a.fetchMode === "direct" && a.origin === QODER_ORIGIN) return null;
      return CreditStore.update(function (doc) {
        var q = doc.agents && doc.agents.qoder;
        if (q) {
          q.hookActive = false;
          q.fetchMode = "direct";
          q.origin = QODER_ORIGIN;
        }
      });
    });
  }).catch(function () { /* 存储还没初始化时忽略 */ });
}

/**
 * 清掉「已经有完整样本、却还留着的旧截断样本」。
 *
 * 判重比的是内容指纹，截断样本和完整样本的指纹本来就不同，所以它们不会被替换，
 * 只会一直挂在样本库里：UI 上永远显示「响应体被截断，点刷新再试一次」，而真数据
 * 其实早就在旁边了。升级/启动时跑一次，老用户不用再手动刷一次才能看到干净的面板。
 */
function pruneShadowedTruncated() {
  return CreditStore.update(function (d) {
    var list = d.captures || [];
    var full = {};
    list.forEach(function (c) { if (!c.truncated) full[c.agentId + "|" + c.url] = true; });
    d.captures = list.filter(function (c) {
      return !(c.truncated && full[c.agentId + "|" + c.url]);
    });
  }).catch(function () { /* 存储还没初始化时忽略 */ });
}

function registerAndOpen(agentId, origin, url) {
  // 直读平台不注册任何脚本：这里的「打开」只是把后台页开给用户登录/确认，
  // 真正的读取在「刷新余额」时由 executeScript 一次性完成。
  //
  // 注意：这个分支目前**没有入口** —— 直读平台的卡片只渲染「刷新余额 / 看样本」，
  // 不会发 REGISTER_AND_OPEN。保留它是因为哪天直读平台需要「打开后台页登录」时，
  // 这是唯一一处把 origin/consoleUrl/fetchMode 一起写对的地方；删掉后重写要重新
  // 面对权限与注销顺序的细节。改这里之前先确认入口真的存在，别以为它在跑。
  var adapter = CreditAdapters.get(agentId);
  if (adapter && adapter.direct) {
    var cfg = adapter.direct;
    var dOrigin = directOrigin(cfg);
    return unregister(dOrigin).then(function () {
      return CreditStore.update(function (doc) {
        var a = doc.agents[agentId];
        if (a) {
          a.consoleUrl = cfg.pageUrl || url;
          a.origin = dOrigin;
          a.fetchMode = "direct";
          a.hookActive = false;
          a.lastError = null;
          a.authPending = null;
          a.authResult = null;
        }
      });
    }).then(function () {
      return chrome.tabs.create({ url: cfg.pageUrl || url, active: true });
    }).then(function (tab) {
      return { ok: true, direct: true, tabId: tab.id, worldAware: true };
    });
  }

  return register(origin).then(function (info) {
    return CreditStore.update(function (doc) {
      var a = doc.agents[agentId];
      if (a) {
        a.consoleUrl = url;
        a.origin = origin;
        a.lastError = null;
        a.hookActive = true;
        // 从这里开始算一次授权会话：页面打开后用户可能要登录，
        // 等钩子截到目标接口的 200 响应，onCaptured 会自动 syncOne 收尾。
        a.authPending = { startedAt: new Date().toISOString(), tabId: null };
        a.authResult = null;
      }
    }).then(function () { return info; });
  }).then(function (info) {
    return chrome.tabs.create({ url: url, active: true }).then(function (tab) {
      return { ok: true, tabId: tab.id, worldAware: info.worldAware };
    });
  });
}

/* ---------- 捕获收件箱 ---------- */

/* 刷新探针：记录"这一次刷新到底走到哪一步断掉的"。
 *
 * 为什么必须有它：「刷新余额」失败时，可能的断点有五个（钩子没注入 / 注入了但页面不发请求 /
 * 发了但打分不够 / 打分够但 origin 对不上 / 存了但被判重复），每一个的解法完全不同。
 * 过去只能回一句"没返回候选"，等于让人瞎试。现在把每一环的计数都记下来，
 * 一次失败就能定位到具体环节。
 *
 * 只在刷新窗口内计数（beginProbe/endProbe 之间），平时为 null，不影响正常浏览时的开销。
 */
var probeMem = {};

function beginProbe(agentId, mode) {
  var p = {
    agentId: agentId, mode: mode || "hook",
    startedAt: new Date().toISOString(), t0: Date.now(),
    responses: 0,      // 钩子上报过的响应总数（含被打分刷掉的）
    rejected: 0,       // 打分 <= 0，看起来不像积分接口
    candidates: 0,     // 打分 > 0
    stored: 0,         // 真正新增的样本（判重替换不算）
    dups: 0,           // 内容指纹相同，走了替换而不是新增
    upgraded: 0,       // 其中「旧的截断样本被完整响应替换」的次数
    superseded: 0,     // 被完整响应取代、顺手清掉的旧截断样本数
    echoes: 0,         // 代发请求被自己的钩子截到的次数（不计入任何计数）
    selfUrl: null, selfAt: 0,   // 代发窗口：见 pageSend / onCaptured
    bestScore: 0, topUrl: null,
    hookAt: null, relayAt: null, worldAware: null,
    endpoint: null, httpStatus: null, bodyBytes: 0, error: null,
    attempts: [],      // 每次开标签页的结果：{visible, seen, changed, tabStatus, tabUrl, ms}
    // 目标接口追踪：hasHint = adapter 是否指定了 endpointHint（beginProbe 时定）；
    // targetSeen 在 storeCapture 命中 hint 时置 true。用来区分「目标接口根本没被
    // 请求」和「请求了但不像积分接口」——两者一个是页面行为、一个是匹配问题，
    // 混成一句"没有响应像积分接口"会把排查引向完全错误的方向。
    hasHint: false, targetSeen: false,
    rejectUrls: [],    // 被刷掉响应的去重 URL（最多 5 条）：页面到底请求了什么，唯一的硬证据
    rejectReasons: {}, // 刷掉原因 -> 次数（响应体为空 / 过大 …）
    outcome: null, elapsedMs: 0
  };
  var _ad = CreditAdapters.get(agentId);
  p.hasHint = !!(_ad && _ad.endpointHint);
  probeMem[agentId] = p;
  return p;
}

function probeOf(agentId) { return probeMem[agentId] || null; }

/** 收尾：把探针写进 store 供 UI 展示，然后从内存里摘掉 */
function endProbe(agentId, outcome) {
  var p = probeMem[agentId];
  if (!p) return Promise.resolve(null);
  delete probeMem[agentId];
  p.outcome = outcome;
  p.elapsedMs = Date.now() - p.t0;
  delete p.t0;
  return CreditStore.update(function (d) {
    if (d.agents[agentId]) d.agents[agentId].probe = p;
  }).then(function () { return p; });
}

/** 照探针计数推断断在哪一环。口径只有一份，在 lib/diagnose.js ——
 *  UI 渲染同一个探针时调的是同一个函数，两边不可能再说出两句不同的话。 */
function diagnoseProbe(p) { return CreditDiagnose.of(p); }

function onCaptured(entry, sender, opts) {
  if (!entry || !entry.url) return Promise.resolve({ ok: false, reason: "empty" });
  var trusted = !!(opts && opts.trusted);

  /*
   * 平台归属统一走 lib/agents.js 的 attributeAgent（那里有完整说明与单测）：
   * 只有 trusted 通道（扩展 UI 的粘贴样本）才认 entry.agentId，其余通道一律按
   * sender.tab.url 的 origin 认——entry 是页面能伪造的对象，agentId 与 origin 都不可信。
   */
  var who = CreditStore.load().then(function (doc) {
    return CreditAgents.attributeAgent(entry, sender, trusted, doc.agents);
  });

  return who.then(function (agentId) {
    if (!agentId) return { ok: true, stored: false, reason: trusted ? "平台未登记" : "origin 未授权" };
    var p = probeOf(agentId);
    var abs = absolutize(entry.url, entry.pageUrl);
    // 自己代发的那一次会被自己的钩子截到（详细理由见 pageSend）。这段窗口内同一个
    // 接口的响应直接丢弃：它既不是「页面发的」，也不是「用户环境里的第三方请求」，
    // 计进探针只会让「页面响应数 / 判重」出现假数字。
    if (p && p.selfUrl && Date.now() - (p.selfAt || 0) < SELF_ECHO_MS && String(abs) === String(p.selfUrl)) {
      p.echoes = (p.echoes || 0) + 1;
      return { ok: true, stored: false, reason: "self-echo" };
    }
    if (p) p.responses++;
    return storeCapture(agentId, entry, p).then(function (stored) {
      if (!stored || !stored.url) return stored;
      return settleAuthCapture(agentId, stored.url, entry, stored).then(function () {
        return stored;
      });
    });
  });
}

/**
 * 样本入库的唯一入口：钩子捕获与页面内直读共用，保证打分、脱敏、去重、
 * lastSeenAt、endpoint 这些口径永远一致。p 是当前刷新窗口的探针（可为 null）。
 */
function storeCapture(agentId, entry, p) {
  var abs = absolutize(entry.url, entry.pageUrl);
  var scored = CreditAgents.scoreCapture(abs, entry.body);
  // 已写映射的平台，样本的「有用程度」由接口提示决定，不再只看启发式分数。
  // LobsterAI 的 portal 会顺带请求 plans / subscription / usage-conversations，
  // 它们分数更高但没有 creditItems；选样本和淘汰样本都必须优先保护真正的接口。
  var adapter = CreditAdapters.get(agentId);
  var hint = adapter && adapter.endpointHint;
  var matchesHint = hint ? hint.test(abs) : true;
  // 目标接口现身就记一笔（无论最后打分如何）：HTTP 状态与体量是「登录态失效」
  // 这类故障的唯一证据（401 的 HTML 里一个额度字段都没有，必然被打分刷掉、
  // 样本库里什么都看不到）；targetSeen 则供诊断区分「没被请求」和「请求了但不像」。
  if (p && hint && matchesHint) {
    p.targetSeen = true;
    p.endpointStatus = Number(entry.status);
    // 页面内代发带回来的是真实字节数（UTF-8），比字符串长度更接近「这条响应多大」：
    // 66081 字节 / 66051 字符这种差额全是中文，面板上两个数字对不上会让人怀疑截断。
    p.endpointBytes = entry.bodyBytes || (entry.body ? String(entry.body).length : 0);
  }
  var clean = CreditNormalize.sanitizeCapture({
    url: abs, method: entry.method, status: entry.status,
    requestHeaders: {}, body: entry.body
  });
  // header 名字是 MAIN world 单独传上来的字符串数组，不是键值对，直接采纳
  clean.requestHeaderNames = Array.isArray(entry.requestHeaderNames)
    ? entry.requestHeaderNames.map(function (s) { return String(s); }) : [];
  // 直读在页面里就把 body 截到 200KB 了；原始长度要带回来，否则 UI 会误以为
  // 响应本来就只有这么长，截断样本还会被当成正常样本去跑 adapter。
  if (entry.bodyBytes && entry.bodyBytes > clean.bodyLength) clean.bodyLength = entry.bodyBytes;
  if (entry.truncated) clean.truncated = true;

  if (scored.score <= 0) {
    if (p) {
      p.rejected++;
      // 被刷掉的响应记下 URL 与原因：这是「目标接口为什么没被算进来」的硬证据。
      // URL 去重、只留 5 条；原因取打分给出的第一条，按次数累计。都不含响应内容。
      p.rejectUrls = p.rejectUrls || [];
      if (p.rejectUrls.indexOf(abs) < 0) {
        p.rejectUrls.push(abs);
        if (p.rejectUrls.length > 5) p.rejectUrls.shift();
      }
      p.rejectReasons = p.rejectReasons || {};
      var _rk = (scored.reasons && scored.reasons[0]) || "未知原因";
      p.rejectReasons[_rk] = (p.rejectReasons[_rk] || 0) + 1;
    }
    return Promise.resolve({ stored: false, score: 0, url: abs });
  }
  if (p) {
    p.candidates++;
    if (scored.score > p.bestScore) { p.bestScore = scored.score; p.topUrl = abs; }
  }

  clean.agentId = agentId;
  clean.score = scored.score;
  clean.reasons = scored.reasons;
  clean.via = entry.via;

  return CreditStore.update(function (doc) {
    var list = doc.captures || [];
    // 去重看内容指纹，不看 bodyLength：额度从 1873 变成 1870 位数没变、长度一样，
    // 用长度当键会把页面刚返回的新数据误判成重复丢掉，样本永远停在旧值。
    // 老样本没有 bodyHash 字段时退回按长度比，避免把历史样本全部当成新的重存一遍。
    var dupIndex = -1;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.agentId !== agentId || c.url !== abs) continue;
      var same = (c.bodyHash && clean.bodyHash)
        ? c.bodyHash === clean.bodyHash
        : c.bodyLength === clean.bodyLength;
      if (same) { dupIndex = i; break; }
    }
    var a0 = doc.agents[agentId];
    // 页面确实响应了就要记下来——哪怕内容和上次一模一样（dup）。
    // 「内容没变」和「根本没响应」对刷新流程是两种完全不同的结论。
    if (a0) {
      a0.lastSeenAt = new Date().toISOString();
      // 目标接口单独记一笔：刷新流程靠它区分「目标回来了」和「只是干扰接口先回来了」。
      if (hint && matchesHint) a0.lastTargetAt = a0.lastSeenAt;
    }

    // 重复样本不新增条目，但必须用这一次的响应原位替换旧样本：
    // 0.3.8 及以前按 60KB 截断存的样本，bodyHash 是整份响应的指纹；升级后刷新
    // 拿到的完整响应指纹相同，若还按「重复」直接丢掉，样本就永远停在 truncated，
    // 点多少次「刷新余额」都修不好。替换不改变条目数，刷新流程仍判为「内容没变」。
    var oldDup = dupIndex >= 0 ? list[dupIndex] : null;
    var upgraded = !!(oldDup && oldDup.truncated && !clean.truncated);
    if (oldDup) {
      list.splice(dupIndex, 1, clean);
      if (p) { p.dups++; if (upgraded) p.upgraded++; }
    } else {
      if (p) p.stored++;
      list.push(clean);
      while (list.length > MAX_CAPTURES) {
        // 超上限时丢「最没用」的那个：各平台先保护自己 adapter 指定的接口，
        // 再比分数。否则一个页面顺带发的十几个高分响应会把真正的接口样本挤出去。
        // 但刚入库的这一条不参与淘汰：它是本次刷新的成果，探针也已经把它记成
        // stored+1，当场淘汰就变成「探针说存了 1 条、库里没有」。
        var worst = -1;
        for (var j = 0; j < list.length; j++) {
          if (list[j] === clean) continue;
          if (worst < 0 || captureRank(list[j]) < captureRank(list[worst])) worst = j;
        }
        if (worst < 0) break;   // 库里只有这一条，无从淘汰（防御性，正常不会走到）
        list.splice(worst, 1);
      }
    }

    // 完整响应到手后，把同一接口下被它取代的旧截断样本清掉。
    //
    // 为什么判重抓不到它们：指纹算的是内容，截断样本和完整样本指纹本来就不同，
    // 于是两条并存——旧那条 bodyPreview 只有 60KB，UI 上永远挂着「响应体被截断，
    // 点刷新再试一次」，可真数据早就有了（2026-10-22 17:29 那次就是这样：
    // 完整样本已入库、日历更新了 2 笔，面板上排第一的却是 12:53 的截断样本）。
    // 它们还会白占 MAX_CAPTURES 的名额——本来就只有 60 条。
    if (!clean.truncated) {
      for (var k = list.length - 1; k >= 0; k--) {
        var cc = list[k];
        if (cc === clean || cc.agentId !== agentId || cc.url !== abs) continue;
        if (!cc.truncated) continue;
        list.splice(k, 1);
        if (p) p.superseded++;
      }
    }
    doc.captures = list;

    var a = doc.agents[agentId];
    if (a) {
      if (a.fetchMode === "unauthorized" || a.fetchMode === "manual-only") a.fetchMode = "capture";
      if (hint) {
        // 有接口提示时，endpoint 只认真实接口：别的响应分数再高也不许改写。
        // 这样面板上不会再把 usage-conversations 当成 LobsterAI 的额度接口。
        var currentMatches = a.endpoint && hint.test(a.endpoint);
        if (matchesHint && (!currentMatches || clean.score > endpointScore(doc, a.endpoint))) {
          a.endpoint = abs;
        }
      } else if (!a.endpoint || clean.score > endpointScore(doc, a.endpoint)) {
        a.endpoint = abs;
      }
      a.lastError = null;
    }
    return {
      stored: true,
      added: !oldDup,
      replaced: !!oldDup,
      upgraded: upgraded,
      // 供直读通道沿用旧口径：内容相同、且不是「截断 -> 完整」的升级，算数字没变。
      duplicate: !!oldDup && !upgraded,
      score: scored.score, agentId: agentId, url: abs
    };
  });
}

function endpointScore(doc, url) {
  var best = 0;
  (doc.captures || []).forEach(function (c) { if (c.url === url) best = Math.max(best, c.score || 0); });
  return best;
}

/**
 * 授权会话的收尾。
 *
 * 点「授权」只负责装钩子 + 开页，真正的取数发生在用户登录之后页面自己发请求时。
 * 以前这里没有收尾：用户登录完回到扩展，看到的还是「授权」按钮，不知道下一步该点
 * 什么，于是以为流程卡住了。现在只要截到 adapter 指定的目标接口（HTTP 2xx），
 * 就自动跑一次 syncOne 写进日历，并把结果落在 authResult 上给面板展示。
 *
 * 失败不急着结束等待：401/403 说明还没登录，保持 pending，登录后的下一次响应
 * 会再来一遍；真正的超时（10 分钟）才清掉 pending。
 */
function settleAuthCapture(agentId, abs, entry, stored) {
  if (!stored || !stored.score || entry.via === "paste") return Promise.resolve(null);

  return CreditStore.load().then(function (doc) {
    var a = doc.agents[agentId];
    if (!a || !a.authPending) return null;

    var startedAt = a.authPending.startedAt;
    var started = Date.parse(startedAt) || 0;
    if (!started || Date.now() - started > AUTH_PENDING_MS) {
      return CreditStore.update(function (d) {
        var ag = d.agents[agentId];
        // 只在还是同一个会话时清理，避免把用户刚重新发起的一次等待误清掉
        if (!ag || !ag.authPending || ag.authPending.startedAt !== startedAt) return;
        ag.authPending = null;
        ag.authResult = {
          at: new Date().toISOString(), ok: false, reason: "timeout",
          message: "等待授权超时（超过 10 分钟）。请重新点「授权」再试。"
        };
      });
    }

    var adapter = CreditAdapters.get(agentId);
    var hint = adapter && adapter.endpointHint;
    // 有映射的平台只认它指定的接口；没有映射的平台只能等第一条像积分的响应。
    if (hint && !hint.test(abs)) return null;

    if (entry.status === 401 || entry.status === 403) {
      return CreditStore.update(function (d) {
        var ag = d.agents[agentId];
        if (!ag || !ag.authPending || ag.authPending.startedAt !== startedAt) return;
        ag.authResult = {
          at: new Date().toISOString(), ok: false, reason: "auth",
          message: "页面还没登录（接口返回 " + entry.status + "）。登录后会自动继续，不用再点按钮。"
        };
      });
    }
    if (!(entry.status >= 200 && entry.status < 300)) return null;
    if (authSyncing[agentId]) return null;

    authSyncing[agentId] = true;
    return syncOne(agentId, new Date()).then(function (s) {
      return CreditStore.update(function (d) {
        var ag = d.agents[agentId];
        if (!ag) return;
        if (s.ok) {
          ag.authPending = null;
          ag.authResult = {
            at: new Date().toISOString(), ok: true,
            added: s.added, updated: s.updated, conflicts: s.conflicts, total: s.total,
            closed: s.closed, reopened: s.reopened,
            endpoint: s.capture && s.capture.url,
            message: "日历已写入 " + s.total + " 个批次。"
          };
        } else if (!CreditAdapters.has(agentId)) {
          // 没有 adapter 的平台至少要把「样本已截到」和「算不出批次」分开说
          ag.authPending = null;
          ag.authResult = {
            at: new Date().toISOString(), ok: false, reason: s.reason,
            message: "已截到样本；这个平台还没有字段映射，暂时算不出批次。"
          };
        } else {
          // 保留 pending：可能只是接口返回了空数据，登录完成后的下一次响应还能收尾
          ag.authResult = {
            at: new Date().toISOString(), ok: false, reason: s.reason,
            message: "已截到额度接口，但没算出批次：" + (s.message || s.reason)
          };
        }
      });
    }).catch(function (e) {
      return CreditStore.update(function (d) {
        var ag = d.agents[agentId];
        if (ag) {
          ag.authResult = {
            at: new Date().toISOString(), ok: false, reason: "error",
            message: "授权收尾出错：" + String((e && e.message) || e)
          };
        }
      });
    }).then(function (r) {
      authSyncing[agentId] = false;
      return r;
    });
  });
}

/** 样本淘汰排序：匹配该平台 adapter 接口提示的样本 +1000，其余再比分数。 */
function captureRank(c) {
  if (!c) return -1;
  var ad = CreditAdapters.get(c.agentId);
  var hint = ad && ad.endpointHint;
  var bonus = hint && hint.test(String(c.url || "")) ? 1000 : 0;
  return bonus + (c.score || 0);
}

function absolutize(url, pageUrl) {
  try { return new URL(url, pageUrl || undefined).href; } catch (e) { return String(url); }
}

function originOf(url) {
  try { return new URL(url).origin; } catch (e) { return ""; }
}

/** origin -> agentId。授权时把 origin 记在 agent 配置上。 */
function resolveAgent(origin) {
  return CreditStore.load().then(function (doc) {
    var ids = Object.keys(doc.agents || {});
    for (var i = 0; i < ids.length; i++) if (doc.agents[ids[i]].origin === origin) return ids[i];
    return null;
  });
}

/** 记下钩子有没有注上，写进对应 agent，UI 的样本空态会直接引用它 */
function noteHook(type, msg, sender) {
  var origin = msg.origin || (sender && sender.tab && sender.tab.url) || "";
  if (!origin) return Promise.resolve({ ok: true, stored: false });
  var field = type === "HOOK_READY" ? "lastHookAt" : "lastRelayAt";
  return resolveAgent(origin).then(function (agentId) {
    if (!agentId) return { ok: true, stored: false, reason: "origin 未授权" };
    // 探针在跑就把心跳时刻也记上：这是区分"注入失败"和"页面不发请求"的唯一证据
    var p = probeOf(agentId);
    if (p) p[type === "HOOK_READY" ? "hookAt" : "relayAt"] = new Date().toISOString();
    return CreditStore.update(function (doc) {
      var a = doc.agents[agentId];
      if (a) a[field] = new Date().toISOString();
      return { ok: true, stored: true, agentId: agentId, field: field };
    });
  });
}

/* ---------- 刷新余额（hidden-tab 机制） ----------
 *
 * ephemeral=true：临时钩子。注册 → 开标签页 → 等到响应 → 关标签页 → 立刻注销。
 * 给"解除钩子"之后的平台用：要活体数据就得让钩子在场一次，
 * 但把在场时间压到一次页面加载那么短，用完即拆。风险窗口存在但不常驻，
 * 由用户点按钮显式触发，不做自动。Qoder 已不走这条路（direct，见 directCapture）。
 *
 * 两轮尝试（v0.2.6）：先隐藏标签页，等不到再改用**可见**标签页重试一次。
 * 原因是隐藏页这条路在真机上从没验证过，而 SPA 在后台标签里可能被节流甚至冻结、
 * 压根不发额度请求；「授权」那条路能截到，正是因为它开的是可见页。
 * 可见页会抢一次焦点，代价可接受——总比静默失败、让人反复点强。
 * 两轮都失败时**把可见标签页留着不关**（钩子仍然注销），让你直接看到那页到底是
 * 登录态还是空页面，这是最省事的排查证据。
 */
var VISIBLE_WAIT_MS = 20000;

/** 代发请求属于自己的回声窗口：这段时间内同一接口的钩子响应一律不计入探针。 */
var SELF_ECHO_MS = 60000;

/**
 * 刷新互斥：同一平台同一时刻只允许一次刷新。
 *
 * 连点两次「刷新余额」的后果不是"两次都失败"，而是状态机被踩坏：
 *   1. 第二次 beginProbe 覆盖第一次的探针 → 第一次 endProbe 删掉它 →
 *      第二次 endProbe 拿到 null，诊断页变成「没有探针记录」；
 *   2. ephemeral 路径下两次各自 register()，先结束的那次 unregister() 会把
 *      另一次的钩子拆掉，而它自己却把 hookActive 写成 true。之后 syncAll 以为
 *      钩子在、可以去抓活数据，实际每次都在没有钩子的页面上白等 32 秒。
 * 第二个症状尤其糟：它不会报错，只会让自动同步静默失效。
 *
 * 语义与 authSyncing 一致（同平台互斥），这里单列一份是因为刷新的窗口更长、
 * 且失败原因要原样回给 UI（第二次不该显示成"没读到数据"）。
 *
 * 锁带超时（REFRESH_LOCK_MS）：真卡住时（例如某个 chrome.* promise 永远不 settle）
 * 必须能自己解开，否则这个平台从此再也点不动「刷新余额」，而用户看不出原因。
 */
var REFRESH_LOCK_MS = 120000;
var refreshing = {};

function refreshCaptures(agentId, opts) {
  var cur = refreshing[agentId];
  if (cur && Date.now() - cur.at < REFRESH_LOCK_MS) {
    return Promise.resolve({
      ok: false, busy: true, agentId: agentId,
      error: "上一次刷新还没结束（最长约一分钟），等它出结果再点一次"
    });
  }
  // token 认身份：万一上一轮在超时之后才真正收尾，它不能把这一轮的锁删掉。
  var token = {};
  refreshing[agentId] = { at: Date.now(), token: token };
  function unlock() {
    if (refreshing[agentId] && refreshing[agentId].token === token) delete refreshing[agentId];
  }
  return doRefresh(agentId, opts).then(function (r) {
    unlock();
    return r;
  }, function (e) {
    unlock();
    throw e;
  });
}

function doRefresh(agentId, opts) {
  opts = opts || {};
  return CreditStore.load().then(function (doc) {
    var a = doc.agents[agentId];
    if (!a) return { ok: false, error: "未知平台" };

    // 已知接口 + 页面内鉴权方式的平台（当前是 Qoder）走直读：
    // 不注册钩子，开页只为了拿同源页面上下文和它的 CSRF token。
    var adapter = CreditAdapters.get(agentId);
    if (adapter && adapter.direct) {
      return directCapture(agentId, adapter.direct, opts);
    }

    if (!a.consoleUrl) return { ok: false, error: "该平台还没授权，没有可打开的后台地址" };
    var origin = a.origin;
    var probe = beginProbe(agentId, "hook");

    return register(origin).then(function (info) {
      probe.worldAware = !!info.worldAware;

      // v0.3.18：adapter 给了代发配方（readFallback）的平台（WorkBuddy）不再先等
      // 页面自己发请求。决策 24 的探针已经证明：后台标签里这个 SPA 根本不发额度
      // 接口，原「隐藏页 12s → 可见页 20s」的隐藏轮是必败的白等，用户看到的就是
      // 「每次刷新都要开两次页面」。现在隐藏页一加载完就代发，成功路径只有一次
      // 页面加载、不抢焦点；代发失败时才落回原有的可见页兜底。
      var fallbackCfg = adapter && adapter.readFallback;
      if (fallbackCfg) {
        return sendFirst(agentId, fallbackCfg, a.consoleUrl, probe).then(function (r) {
          if (r.fb && r.fb.ok) {
            return settleSend(agentId, probe, r, "hidden-send", opts, origin, false);
          }
          // 401/403 = 页面没有登录态：标签页留着切到前台，登录后再点一次。
          // 口径与直读的 auth 失败一致（failDirect）。
          if (r.fb && r.fb.needLogin) {
            return settleSend(agentId, probe, r, "auth", opts, origin, true);
          }
          // 其余失败（注入被挡 / 非 JSON / 接口侧错误）：页面自己的请求在可见页里
          // 仍然可能成功，落回原有兜底。先把代发的回声窗口清掉——可见页里页面
          // 自己发的同一个接口不能再被当成回声丢掉。
          probe.selfUrl = null;
          probe.selfAt = 0;
          return closeQuietly(r.tabId).then(function () {
            return attempt(agentId, a.consoleUrl, true, VISIBLE_WAIT_MS).then(function (r2) {
              if (r2.seen) return settle(r2, "visible");
              // 两轮都没等到：把可见页留着（settle 里按 both-failed 不关），
              // 并在这个页面上下文里代发一次只读请求（adapter.readFallback）。
              return settle(r2, "both-failed");
            });
          });
        });
      }

      return attempt(agentId, a.consoleUrl, false, SYNC_WAIT_MS).then(function (r1) {
        if (r1.seen) return settle(r1, "hidden");
        // 隐藏页没等到 → 换可见页再试一次。先关掉隐藏页：以前这里不关，每次
        // 刷新失败都留一个僵尸标签页在标签栏里越积越多。
        return closeQuietly(r1.tabId).then(function () {
          return attempt(agentId, a.consoleUrl, true, VISIBLE_WAIT_MS).then(function (r2) {
            if (r2.seen) return settle(r2, "visible");
            return settle(r2, "both-failed");
          });
        });
      });
      function settle(r, mode) {
        var fallbackCfg = adapter && adapter.readFallback;
        var keepTabOpen = mode === "both-failed" && r.visible;
        var closeIt = keepTabOpen ? Promise.resolve() : closeQuietly(r.tabId);
        return closeIt.then(function () {
          // 兜底只在「钩子两轮都没等到目标接口」时触发，成功路径一个字都不改。
          // 存在的理由：真机上出现过页面加载完却一次额度接口都不发的情况
          // （探针 responses 全是埋点、targetSeen=false），而 SPA 是否取数由
          // 登录态和页面分区决定，扩展侧没有任何办法让它重新发请求。
          if (mode !== "both-failed" || !fallbackCfg || !r.tabId) return null;
          return pageSend(agentId, fallbackCfg, r.tabId, probe).then(function (fb) {
            probe.fallback = fb;
            // 代发成功就不必再把那个标签页留给用户看：留着只是"排查证据"，
            // 而这次已经有结论了。
            if (fb && fb.ok) {
              keepTabOpen = false;
              return closeQuietly(r.tabId);
            }
          }, function (e) {
            probe.fallback = { ok: false, message: String((e && e.message) || e) };
          });
        }).then(function () {
          var after;
          if (opts.ephemeral) {
            after = unregister(origin).then(function () {
              return CreditStore.update(function (d) {
                if (d.agents[agentId]) d.agents[agentId].hookActive = false;
              });
            });
          } else {
            after = CreditStore.update(function (d) {
              if (d.agents[agentId]) d.agents[agentId].hookActive = true;
            });
          }
          return after.then(function () {
            return endProbe(agentId, mode).then(function (p) {
              var fb = (p && p.fallback) || null;
              var fbOk = !!(fb && fb.ok);
              return {
                ok: r.seen || fbOk,            // 页面回话了，或代发成功
                fresh: r.seen || fbOk,         // 读到的就是当下后台的状态
                changed: r.seen ? r.changed : (fbOk && !fb.duplicate), // 内容确实变了
                upgraded: !!(fb && fb.upgraded) || !!(p && p.upgraded), // 旧截断样本被完整响应替换
                mode: mode,            // hidden / visible / both-failed
                tabLeftOpen: keepTabOpen,
                tabId: r.tabId,
                ephemeral: !!opts.ephemeral,
                fallback: fb,          // 代发结果（没有则为 null）
                probe: p,
                diagnosis: diagnoseProbe(p)
              };
            });
          });
        });
      }
    }).catch(function (e) {
      // beginProbe 之后任何一步抛错都要把探针收尾：register() 失败、开页失败、
      // 甚至 endProbe 之前的一次意外异常，都会让 probeMem[agentId] 留着上一次的
      // 半截记录，下次刷新读到的诊断属于上上次的失败——比没有诊断更误导人。
      // 顺手把真因记进探针，否则用户只看到「流程出错」四个字，等于没说。
      probe.error = String((e && e.message) || e);
      return endProbe(agentId, "error").then(function () { throw e; });
    });
  });
}

/**
 * v0.3.18 代发优先：开一个隐藏标签页，等它加载完，立刻在页面上下文里代发一次
 * 只读请求（adapter.readFallback）。与 attempt() 的区别是不等页面自己发请求——
 * 真机上后台标签里等不到（决策 24 的探针证据）。返回 {fb, tabId, tabStatus, tabUrl}，
 * 收尾交给 settleSend（成功 / 未登录）或落回可见页兜底（其余失败）。
 */
function sendFirst(agentId, cfg, consoleUrl, probe) {
  return chrome.tabs.create({ url: cfg.pageUrl || consoleUrl, active: false }).then(function (tab) {
    var t0 = Date.now();
    return waitForTab(tab.id, DIRECT_WAIT_MS).then(function (info) {
      function record(fb) {
        probe.fallback = fb;
        probe.attempts.push({ visible: false, seen: !!(fb && fb.ok),
          tabStatus: info.status, tabUrl: info.url, ms: Date.now() - t0 });
        return { fb: fb, tabId: tab.id, tabStatus: info.status, tabUrl: info.url };
      }
      return pageSend(agentId, cfg, tab.id, probe).then(record, function (e) {
        return record({ ok: false, message: String((e && e.message) || e) });
      });
    });
  });
}

/**
 * 代发优先路径的收尾。needLogin=false：页面代发拿到了数据（含「内容没变」），
 * 关页照常收尾；needLogin=true：页面没有登录态，标签页留着并切到前台，
 * 口径与直读的 failDirect 一致——登录后再点一次「刷新余额」。
 */
function settleSend(agentId, probe, r, outcome, opts, origin, needLogin) {
  var msg = null;
  if (needLogin) {
    msg = "页面没有登录态（接口返回 " + ((r.fb && r.fb.status) || "401/403")
      + "）。已把页面切到前台，登录后再点「刷新余额」。";
  }
  var closeIt = needLogin ? Promise.resolve() : closeQuietly(r.tabId);
  var bring = needLogin && r.tabId
    ? chrome.tabs.update(r.tabId, { active: true }).catch(function () {})
    : null;
  return Promise.resolve(bring).then(function () { return closeIt; }).then(function () {
    // 401 的状态是「目标接口回了什么」的硬证据，探针里单独留一笔供诊断页展示
    if (needLogin && r.fb && r.fb.status) {
      probe.endpointStatus = Number(r.fb.status);
    }
    var after = CreditStore.update(function (d) {
      var a = d.agents[agentId];
      if (!a) return;
      a.hookActive = !opts.ephemeral;
      if (msg) a.lastError = msg;
    });
    var unreg = opts.ephemeral ? unregister(origin) : Promise.resolve();
    return unreg.then(function () { return after; }).then(function () {
      return endProbe(agentId, outcome).then(function (p) {
        var fb = (p && p.fallback) || null;
        var fbOk = !!(fb && fb.ok);
        var res = {
          ok: fbOk, fresh: fbOk,
          changed: fbOk && !!fb && !fb.duplicate,
          upgraded: !!(fb && fb.upgraded),
          mode: "hidden-send",
          tabLeftOpen: !!needLogin, tabId: r.tabId,
          ephemeral: !!opts.ephemeral,
          fallback: fb,
          probe: p,
          diagnosis: diagnoseProbe(p)
        };
        if (needLogin) {
          res.ok = false; res.fresh = false; res.needLogin = true; res.error = msg;
        }
        return res;
      });
    });
  });
}

/**
 * 开一次标签页并等响应。visible=false 走隐藏页，抢不到焦点但可能被浏览器节流。
 * 关掉之前先把标签页的真实 url / status 读出来：如果被重定向到登录页，
 * 这里能看见，不用猜"是不是没登录"。
 */
function attempt(agentId, url, visible, waitMs) {
  return chrome.tabs.create({ url: url, active: visible }).then(function (tab) {
    return waitForCapture(agentId, tab.id, waitMs).then(function (got) {
      return chrome.tabs.get(tab.id).then(function (t) {
        return { status: t.status, url: t.url };
      }, function () {
        return { status: "unknown", url: null };
      }).then(function (info) {
        var p = probeOf(agentId);
        if (p) {
          p.attempts.push({
            visible: visible, seen: got.seen, changed: got.changed,
            tabStatus: info.status, tabUrl: info.url, ms: Date.now() - got.t0
          });
        }
        return {
          seen: got.seen, changed: got.changed, tabId: tab.id, visible: visible,
          tabStatus: info.status, tabUrl: info.url
        };
      });
    });
  });
}

/**
 * 等一次响应。resolve 出来的不是布尔值，而是三态：
 *   { changed: true }  抓到新内容，样本数变多了
 *   { changed: false, seen: true }  页面确实回话了，但内容和上次一模一样
 *                                    （重复响应只原位替换样本、推进 lastSeenAt，不新增条目）
 *   { changed: false, seen: false }  等了 SYNC_WAIT_MS 什么都没发生
 * 后两种对用户是完全不同的结论：一个是"数字真没变"，一个是"根本没读到"，
 * 混成一个 false 会让人以为额度没动，其实是没登录或接口没触发。
 *
 * 基线必须在开轮询之前读出来：以前是"边读基线边轮询"，第一次 tick 常常跑在
 * load() 之前，before 还是 0，于是任何已有样本都会被当成"新增"，永远假报成功。
 *
 * 监听改成事件驱动（v0.3.10）：原来每 500ms 调一次 load() 把整个文档反序列化一遍，
 * 而文档里躺着最多 60 条、每条 200KB 的响应体样本——20 秒窗口就是 40 次全量解析，
 * WorkBuddy 那种单条 130KB、十几条样本的情况下，光等待就能把 service worker 拖出
 * 明显卡顿。现在只在开等前读一次基线，之后由 chrome.storage.onChanged 把新文档
 * 直接递过来（newValue），一次多余的解析都没有。
 */
function waitForCapture(agentId, tabId, waitMs) {
  var limit = waitMs || SYNC_WAIT_MS;
  return CreditStore.load().then(function (doc0) {
    var adapter = CreditAdapters.get(agentId);
    var hint = adapter && adapter.endpointHint;
    // 已知目标接口的平台只认目标接口：WorkBuddy 页面同时请求 plans / usage，
    // 干扰接口先回来时 lastSeenAt 就会变。旧逻辑据此立刻关页，130KB 的目标响应
    // 还没到，样本永远升不了级——表现就是「刷新了还是 truncated」。
    var countTargets = function (doc) {
      var n = 0;
      (doc.captures || []).forEach(function (c) {
        if (c.agentId !== agentId) return;
        if (hint && !hint.test(String(c.url || ""))) return;
        n++;
      });
      return n;
    };
    var targetSeen = function (doc) {
      var a = doc.agents[agentId] || {};
      return (hint ? a.lastTargetAt : a.lastSeenAt) || null;
    };
    var before = countTargets(doc0);
    var seenBefore = targetSeen(doc0);
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var finished = false;
      var timer = null;

      function finish(o) {
        if (finished) return;
        finished = true;
        o.t0 = t0;
        clearInterval(timer);
        if (unwatch) unwatch();
        resolve(o);
      }

      function evaluate(doc) {
        if (!doc) return;
        if (countTargets(doc) > before) { finish({ changed: true, seen: true }); return; }
        var seen = targetSeen(doc);
        if (seen && seen !== seenBefore) finish({ changed: false, seen: true });
      }

      /*
       * 监听存储变更：浏览器把变更后的整个文档直接递到 newValue 里，不用我们再
       * 读一遍。locale 之外的区域不看；文档被删（newValue 为空）就当没变。
       */
      var unwatch = null;
      if (chrome.storage && chrome.storage.onChanged) {
        var onChange = function (changes, area) {
          if (finished || area !== "local") return;
          var ch = changes && changes[CreditStore.KEY];
          if (!ch || !ch.newValue) return;
          evaluate(ch.newValue);
        };
        chrome.storage.onChanged.addListener(onChange);
        unwatch = function () { chrome.storage.onChanged.removeListener(onChange); };
      } else {
        // 理论上走不到（background 一定是扩展环境），但真退化时不能变成死等
        var poll = setInterval(function () { CreditStore.load().then(evaluate); }, 1000);
        unwatch = function () { clearInterval(poll); };
      }

      // 注册完监听先复查一次：从上面 load() 取到基线、到监听器真正挂上这段时间里，
      // 样本可能已经写进去了（页面是常驻钩子时，请求比开页快得多）。不补这一次，
      // 那份样本会被算进 before，之后再也等不到"变多"，只能干等到超时。
      CreditStore.load().then(evaluate);

      // 这个定时器承担三件事，缺一个都会让「刷新余额」静默失败：
      //   1. 判超时；
      //   2. 在 MV3 下"证明自己还活着"——service worker 空闲 30 秒就被回收，
      //      回调本身算一次事件、能续命；没有它，等待期间一旦被回收，上面这个
      //      闭包连同 Promise 一起消失，刷新永远卡住（页面开着、数字不动、没提示）。
      //   3. 兜底复查存储。
      //
      // 第 3 条是 v0.3.10 踩过的坑：那一版把轮询去掉、只靠 onChanged 事件驱动，
      // 而 onChanged 并不是在所有环境都可靠（MV3 的 SW 一旦在等待窗口内被回收或
      // 重启，函数内注册的监听器不会自动恢复；各家的 MV3 实现也不完全一致）。
      // 事件没派发时，样本其实已经入库了，等待却一直判 seen:false，于是刷新报失败、
      // 后续 syncOne 根本不跑——用户看到的就是"余额刷不出来"，而样本库里躺着
      // 一条刚抓到的新数据。所以事件只用来"更快"，不能用来"唯一"。
      // 2 秒一次反序列化，仍比 v0.3.9 的每 500ms 全量解析轻一个量级。
      timer = setInterval(function () {
        if (Date.now() - t0 > limit) { finish({ changed: false, seen: false }); return; }
        CreditStore.load().then(evaluate);
      }, 2000);
    });
  });
}

function closeQuietly(tabId) {
  // 必须 return：钩子刷新链路会 `closeIt.then(...)` 再接收尾。
  // 漏掉返回值时前面明明已经截到响应，整条链却在这里抛「undefined 没有 then」，
  // 用户看到的就是"刷新失败、用的还是旧样本"。
  return chrome.tabs.remove(tabId).catch(function () {});
}

/* ---------- 代发兜底（adapter.readFallback，v0.3.14） ----------
 *
 * 场景：钩子在场、页面也加载完了，但页面自己一次额度接口都没请求——探针里
 * responses 全是埋点、targetSeen=false，于是「刷新余额」永远失败，样本停在旧的
 * 那一份。前端代码表明套餐数据由 getCurrentPlan() 触发，而它被登录态（uid）和
 * 页面分区状态挡着；扩展没有任何办法让 SPA 重新取数。
 *
 * 兜底做法与 Qoder 的直读同源同思路：在**页面上下文**里发一次与站点自己完全
 * 一致的只读请求（URL / method / body / headers 全部来自站点前端 bundle），
 * cookie 由浏览器带，扩展不接触凭据。区别是它只在钩子两轮都失败后才跑，
 * 成功路径（页面自己会请求的平台/场合）完全不受影响。
 *
 * 失败语义：401/403 = 没登录（页面已经留在前台，登录后再点一次）；
 * 非 2xx / 非 JSON / 没有额度字段 = 如实报错，绝不写空批次。
 */
function pageSend(agentId, cfg, tabId, probe) {
  var req = {};
  Object.keys(cfg).forEach(function (k) { if (k !== "buildBody") req[k] = cfg[k]; });
  if (typeof cfg.buildBody === "function") {
    try { req.body = cfg.buildBody(new Date()); } catch (e) { req.body = null; }
  }

  // 这一轮代发请求会**被自己的钩子截到**：注入的 fetch 就是页面 window.fetch，
  // 我们代发的那一次照样会走 capture-main 的包装。要是不打招呼，它会被记成一个
  // 「页面响应」，而真正入库的那次（下面 storeCapture 带 probe）反倒没计数 ——
  // 探针就会出现「0 条新样本 / 1 条内容相同」这种与事实相反的数（2026-10-22 17:29
  // 那次真机刷新就是这样：日历其实更新了 2 笔，面板却说数字没变）。
  // 所以代发前把 URL 记在探针上，onCaptured 认出这段时间内同一个接口的响应就丢掉。
  if (probe) { probe.selfUrl = cfg.url; probe.selfAt = Date.now(); }

  return chrome.scripting.executeScript({
    target: { tabId: tabId }, world: "MAIN", func: directFetchInPage, args: [req]
  }).then(function (out) {
    var res = out && out[0] && out[0].result;
    if (!res) return { ok: false, message: "页面里没有拿到请求结果（注入可能被挡）" };
    if (!res.ok) return { ok: false, message: "页面内请求没发出去：" + (res.error || "未知错误") };

    var status = Number(res.status) || 0;
    if (status === 401 || status === 403) {
      return {
        ok: false, status: status, needLogin: true,
        message: "接口返回 " + status + "：这个页面没有登录态。在该页面登录后再点「刷新余额」。"
      };
    }
    if (status < 200 || status >= 300) {
      return { ok: false, status: status, message: "接口返回 HTTP " + status + "，这次没拿到数据。" };
    }
    if (!/json/i.test(res.contentType || "")) {
      return { ok: false, status: status, message: "接口回了 200，但内容不是 JSON（可能被重定向到登录页）。" };
    }

    return storeCapture(agentId, {
      url: cfg.url, method: cfg.method || "GET", status: status,
      body: res.body, bodyBytes: res.bodyBytes, truncated: res.truncated,
      requestHeaderNames: [], via: "direct", origin: originOf(cfg.url), pageUrl: cfg.pageUrl
    }, probe || null).then(function (s) {
      if (!s || !s.stored) {
        return { ok: false, status: status, message: "接口返回 200，但响应里没有可用的额度字段。" };
      }
      return {
        ok: true, status: status, bytes: res.bodyBytes || 0,
        duplicate: !!s.duplicate, upgraded: !!s.upgraded,
        message: "页面没自己请求额度接口，扩展在页面里代发了一次成功（HTTP " + status
          + "，" + (res.bodyBytes || 0) + " 字节）。"
      };
    });
  });
}

/* ---------- 页面内直读（Qoder） ----------
 *
 * 与钩子方案的分工：
 *   - 钩子：不预先知道接口，靠包 fetch 观察页面自己发什么。侵入性强，会被反爬检测。
 *   - 直读：接口已知、鉴权方式也已知（同源 cookie + 页面内 window.csrfToken），
 *     开一个同源页面，在 MAIN world 里发一次与站点自己完全一样的只读请求。
 *     不改页面任何函数，不常驻，不在后台带 cookie 裸调。
 *
 * 失败处理只分两种：401/403 = 没登录，把页面切到前台让用户登录；其余一律
 * 关页 + 报真因。失败不覆盖旧批次，syncOne 仍会用既有样本。
 */

function directOrigin(cfg) {
  try { return new URL(cfg.url).origin; } catch (e) { return ""; }
}

function finishDirect(agentId, p, outcome, extra) {
  return endProbe(agentId, outcome).then(function (storedProbe) {
    return Object.assign({
      ok: outcome === "direct",
      fresh: outcome === "direct",
      changed: false, seen: false,
      mode: "direct", direct: true,
      tabLeftOpen: false, tabId: null,
      probe: storedProbe,
      diagnosis: diagnoseProbe(storedProbe)
    }, extra || {});
  });
}

/** 直读失败收尾：默认关页；登录失效时保留并切到前台。 */
function failDirect(agentId, p, r, outcome, message, keepTab) {
  if (r && r.tabId && !keepTab) closeQuietly(r.tabId);
  var bring = keepTab && r && r.tabId
    ? chrome.tabs.update(r.tabId, { active: true }).catch(function () {})
    : Promise.resolve();
  return bring.then(function () {
    p.error = message;
    return CreditStore.update(function (d) {
      var a = d.agents[agentId];
      if (a) a.lastError = message;
    });
  }).then(function () {
    return finishDirect(agentId, p, outcome, {
      ok: false, fresh: false, seen: false, error: message,
      tabLeftOpen: !!keepTab, tabId: (r && r.tabId) || null,
      httpStatus: p.httpStatus || null
    });
  });
}

function directCapture(agentId, cfg, opts) {
  opts = opts || {};
  var origin = directOrigin(cfg);
  var pageUrl = cfg.pageUrl || (opts.url || "");
  // 配置不全要在建探针**之前**退出：探针一旦建了就必须有 endProbe 收尾，
  // 否则 probeMem[agentId] 会一直挂着这条没结论的半截记录，下次刷新读到的
  // 是上上次的失败，诊断页直接张冠李戴。
  if (!pageUrl) {
    return Promise.resolve({
      ok: false, fresh: false, direct: true,
      error: "直读配置里没有可打开的页面地址",
      diagnosis: "直读配置不全：adapter 缺 pageUrl"
    });
  }

  var p = beginProbe(agentId, "direct");
  p.endpoint = cfg.url;

  // 每次直读前都把同域名的旧钩子拆掉。qoder.com 上钩子在场会让登录态失效，
  // 这个动作是幂等的；即使从来没注册过也无害。
  return unregister(origin).then(function () {
    return CreditStore.update(function (d) {
      var a = d.agents[agentId];
      if (a) {
        a.hookActive = false;
        a.fetchMode = "direct";
        if (origin) a.origin = origin;
      }
    });
  }).then(function () {
    return directAttempt(agentId, pageUrl, cfg, !!opts.visible, DIRECT_WAIT_MS, p);
  }).then(function (r) {
    if (!r) return failDirect(agentId, p, null, "page-error", "没有打开页面", false);
    if (r.error) return failDirect(agentId, p, r, "page-error", "页面内请求失败：" + r.error, false);

    var res = r.result;
    if (!res) return failDirect(agentId, p, r, "page-error", "页面里没有返回请求结果（注入可能被挡）", false);

    p.httpStatus = res.status || 0;
    p.bodyBytes = res.bodyBytes || 0;

    if (!res.ok) {
      return failDirect(agentId, p, r, "page-error", "页面内 fetch 抛错：" + (res.error || "未知"), false);
    }
    // 401/403 或最终停在登录页：页面没有登录态。把这一页留在前台，登录完再点一次。
    var onLoginPage = cfg.loginPath && r.tabUrl && String(r.tabUrl).indexOf(cfg.loginPath) >= 0;
    if (res.status === 401 || res.status === 403 || (onLoginPage && !/json/i.test(res.contentType || ""))) {
      // 401/403 就是没登录，别拿"token 没读到"盖住它：登录页上没有 token 是正常的。
      // 只有页面还在且确实缺 token 时，才提示页面结构可能变了。
      var authMsg;
      if (res.status === 401 || res.status === 403) {
        authMsg = "登录态失效（接口返回 " + res.status + "）。已把该页面切到前台，登录后再点「刷新余额」。"
          + (res.tokenFound === false ? "另外这次没在页面里读到 CSRF token，若登录后仍失败，刷新页面再试。" : "");
      } else {
        authMsg = "页面被重定向到登录页，当前没有登录态。已把该页面切到前台，登录后再点「刷新余额」。";
      }
      return failDirect(agentId, p, r, "auth", authMsg, true);
    }
    if (res.status < 200 || res.status >= 300) {
      return failDirect(agentId, p, r, "http-error", "接口返回 HTTP " + res.status, false);
    }
    if (!/json/i.test(res.contentType || "")) {
      return failDirect(agentId, p, r, "not-json", "接口回了 200，但内容不是 JSON（可能被重定向到登录/风控页）", !!onLoginPage);
    }

    return storeCapture(agentId, {
      url: cfg.url,
      method: cfg.method || "GET",
      status: res.status,
      body: res.body,
      bodyBytes: res.bodyBytes,
      truncated: res.truncated,
      requestHeaderNames: [],
      via: "direct",
      origin: origin,
      pageUrl: r.tabUrl
    }, p).then(function (s) {
      if (!s.stored && !s.reason) {
        // 200 + JSON，但打分认为里面没有额度字段：平台改版或接口换了语义
        return failDirect(agentId, p, r, "no-quota", "接口返回 200，但响应里没有任何积分类字段——平台可能改版了", false);
      }
      return CreditStore.update(function (d) {
        var a = d.agents[agentId];
        if (a) {
          a.fetchMode = "direct";
          a.origin = origin;
          a.endpoint = cfg.url;
          a.lastError = null;
        }
      }).then(function () {
        closeQuietly(r.tabId);
        return finishDirect(agentId, p, s.duplicate ? "direct-dup" : "direct", {
          ok: true, fresh: true, changed: !!s.stored && !s.duplicate, seen: true,
          httpStatus: res.status, tabLeftOpen: false, tabId: r.tabId,
          bodyBytes: res.bodyBytes || 0
        });
      });
    });
  }, function (e) {
    return failDirect(agentId, p, null, "page-error", "直读流程出错：" + String((e && e.message) || e), false);
  });
}

/** 开一个页面，等它加载完，然后在页面上下文里执行 directFetchInPage。 */
function directAttempt(agentId, url, cfg, visible, waitMs, p) {
  return chrome.tabs.create({ url: url, active: visible }).then(function (tab) {
    var t0 = Date.now();
    return waitForTab(tab.id, waitMs).then(function (info) {
      var rec = { visible: !!visible, tabStatus: info.status, tabUrl: info.url, ms: 0, seen: false };
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: directFetchInPage,
        args: [cfg]
      }).then(function (out) {
        rec.ms = Date.now() - t0;
        rec.seen = !!(out && out[0] && out[0].result && out[0].result.ok);
        p.attempts.push(rec);
        return {
          tabId: tab.id, tabStatus: info.status, tabUrl: info.url,
          result: out && out[0] ? out[0].result : null, ms: rec.ms
        };
      }, function (err) {
        rec.ms = Date.now() - t0;
        p.attempts.push(rec);
        return {
          tabId: tab.id, tabStatus: info.status, tabUrl: info.url,
          error: String((err && err.message) || err), ms: rec.ms
        };
      });
    });
  });
}

/** 轮询标签页状态。加载超时也返回最后一次状态，让上层照样尝试注入。 */
function waitForTab(tabId, waitMs) {
  var limit = waitMs || DIRECT_WAIT_MS;
  return new Promise(function (resolve) {
    var t0 = Date.now();
    function tick() {
      chrome.tabs.get(tabId).then(function (t) {
        if (t.status === "complete" || Date.now() - t0 >= limit) {
          resolve({ status: t.status || "unknown", url: t.url || null });
        } else {
          setTimeout(tick, 250);
        }
      }, function () {
        resolve({ status: "closed", url: null });
      });
    }
    tick();
  });
}

/**
 * 这段字符串会被 chrome.scripting.executeScript 序列化后注入页面 MAIN world。
 * 不能引用外部变量，所有参数必须从 cfg 来。
 *
 * 关键点：请求由页面自己发（同源 + credentials include），cookie 由浏览器自动带；
 * CSRF token 用页面已经存在的 window.csrfToken（兜底读同名 cookie），
 * 扩展不读取、不保存 cookie 值，也不把 token 发往任何第三方。
 */
async function directFetchInPage(cfg) {
  try {
    var token = "";
    // 只有需要 CSRF 的平台（Qoder）才去读 token：WorkBuddy 这条链路靠 cookie，
    // 读不到 token 是正常情况，不该让它变成"页面结构可能变了"的提示。
    if (cfg.csrf) {
      try { token = window.csrfToken || ""; } catch (e) {}
      if (!token) {
        var m = document.cookie.match(/(?:^|;\s*)qoder_csrf_token=([^;]+)/);
        if (m) token = decodeURIComponent(m[1]);
      }
    }

    var headers = Object.assign({}, cfg.headers || {});
    if (cfg.csrf) headers["X-CSRF-TOKEN"] = token;
    if (cfg.xrw) headers["x-requested-with"] = "XMLHttpRequest";
    if (cfg.timezone) headers["X-Timezone"] = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // 请求体由后台按 adapter 的 buildBody 构造好再传进来（这里不做业务判断）。
    var payload = cfg.body ? JSON.stringify(cfg.body) : undefined;

    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 15000);
    var res, text;
    try {
      res = await fetch(cfg.url, {
        method: cfg.method || "GET",
        credentials: "include",
        headers: headers,
        body: payload,
        cache: "no-store",
        signal: ctl.signal
      });
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    // 「多大」要按字节报：中文一个字 3 字节，用字符串长度当字节数报出去，
    // 面板上的数字会比响应实际小一截，和别的数字对不上时很难解释。
    var bytes = text.length;
    try { bytes = new TextEncoder().encode(text).length; } catch (e2) {}

    return {
      ok: true,
      status: res.status,
      finalUrl: res.url,
      contentType: res.headers.get("content-type") || "",
      body: text.slice(0, 200000),
      bodyBytes: bytes,
      truncated: text.length > 200000,
      tokenFound: cfg.csrf ? !!token : true
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), tokenFound: cfg.csrf ? false : true };
  }
}

/* ---------- 同步 ----------
 *
 * 数据链路：页面内直读（Qoder）或授权截获（其余三家）→ 存成 capture 样本
 *          → adapters/<agent>.js 的 extract() 认字段 → normalizeBatch → mergeBatches。
 *
 * Qoder 直读，LobsterAI / TRAE / WorkBuddy 截获都已接入；WorkBuddy 当前只映射
 * 免费/赠送包接口。这一步刻意不猜字段：猜出来的批次看起来跟真抓的一模一样，
 * 错了也没人发现。没有 adapter 的平台仍会回 no-adapter 并说明原因；
 * 手动录入不依赖 adapter，永远可用。
 */
function syncOne(agentId, now) {
  return CreditStore.load().then(function (doc) {
    var res = CreditAdapters.runSync(agentId, doc.captures, now);
    if (!res.ok) {
      var msg = res.reason === "no-adapter"
        ? "还没有该平台的字段映射 adapter。请先授权捕获样本，把导出结果给我写映射。"
        : (res.message || res.reason);
      return CreditStore.update(function (d) {
        if (d.agents[agentId]) d.agents[agentId].lastError = msg;
      }).then(function () {
        return { ok: false, agentId: agentId, reason: res.reason, message: msg };
      });
    }
    return CreditStore.update(function (d) {
      // 权威清单直接来自 adapter，但只在"这份样本是活读的"时生效：
      // 粘贴进来的是历史快照，拿它去关批次会把现在还在的钱关掉（见 mergeBatches 规则 5）。
      var ad = CreditAdapters.get(agentId);
      var live = res.capture && res.capture.via !== "paste";
      var authoritative = {};
      if (ad && ad.authoritative && live) authoritative[agentId] = true;

      var merged = CreditNormalize.mergeBatches(d.batches, res.batches, {
        now: now, authoritative: authoritative
      });
      d.batches = merged.batches;
      var a = d.agents[agentId];
      if (a) {
        a.lastSyncAt = now.toISOString();
        a.lastError = null;
        if (res.capture && res.capture.url) a.endpoint = res.capture.url;
        if (a.fetchMode === "unauthorized" || a.fetchMode === "manual-only") a.fetchMode = "capture";
      }
      d.lastSyncAt = now.toISOString();
      return {
        ok: true, agentId: agentId,
        added: merged.added, updated: merged.updated,
        conflicts: merged.conflicts, unchanged: merged.unchanged,
        closed: merged.closed, reopened: merged.reopened,
        total: merged.batches.length, capture: res.capture,
        sampleAt: res.capture && res.capture.at ? res.capture.at : null
      };
    });
  });
}

/**
 * UI 的「立即同步」不带 agentId：一次跑完所有已授权且有 adapter 的平台。
 * 没 adapter 的平台只在结果里说明原因，不写空数据——这是需求里定的硬规则。
 */
function syncAll(now) {
  return CreditStore.load().then(function (doc) {
    var ids = Object.keys(doc.agents).filter(function (id) {
      var a = doc.agents[id];
      return a.enabled !== false
        && (a.fetchMode === "capture" || a.fetchMode === "hidden-tab" || a.fetchMode === "direct")
        && CreditAdapters.has(id);
    });
    if (!ids.length) {
      var authed = Object.keys(doc.agents).filter(function (id) {
        return doc.agents[id].fetchMode === "capture" || doc.agents[id].fetchMode === "direct";
      });
      return {
        ok: false, reason: "no-adapter", ran: [],
        message: authed.length
          ? "已授权 " + authed.length + " 个平台，但字段映射还没写。导出捕获样本给我，我按样本写 adapters。"
          : "还没有授权任何平台。可以先手动录入，或在「授权与样本」里走授权截获。"
      };
    }
    return ids.reduce(function (chain, id) {
      return chain.then(function (acc) {
        // 活体语义：直读平台先页面内请求一次；钩子还注册着的平台开隐藏页刷一份；
        // 刷不到（best-effort）就照旧用最近样本，结果里标 fresh=false 让 UI 说清楚。
        // 解除钩子的平台不自动刷——那等于偷偷把钩子装回去，正是用户刚拆掉的东西。
        return CreditStore.load().then(function (d) {
          var adapter = CreditAdapters.get(id);
          if (adapter && adapter.direct) {
            return refreshCaptures(id, {}).then(function (r) {
              return { fresh: !!r.fresh, direct: true, refreshError: r.ok ? null : (r.error || r.diagnosis || null) };
            }, function (e) {
              return { fresh: false, direct: true, refreshError: String((e && e.message) || e) };
            });
          }
          if (d.agents[id] && d.agents[id].hookActive) {
            return refreshCaptures(id, {}).then(function (r) { return { fresh: !!r.fresh }; },
              function () { return { fresh: false }; });
          }
          return { fresh: null };   // null = 未装钩子，本次同步读的是既有样本
        }).then(function (fr) {
          return syncOne(id, now).then(function (r) {
            r.fresh = fr.fresh;
            if (fr.direct) r.direct = true;
            if (fr.refreshError) r.refreshError = fr.refreshError;
            acc.results.push(r); return acc;
          });
        });
      });
    }, Promise.resolve({ results: [] })).then(function (acc) {
      var okN = acc.results.filter(function (r) { return r.ok; }).length;
      return {
        ok: okN > 0, ran: acc.results.map(function (r) { return r.agentId; }),
        results: acc.results,
        message: acc.results.filter(function (r) { return !r.ok; })
          .map(function (r) { return r.agentId + "：" + (r.refreshError || r.message); }).join("；")
      };
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (!msg || msg.type !== "SYNC") return false;
  var now = new Date();
  var p = msg.agentId ? syncOne(msg.agentId, now) : syncAll(now);
  Promise.resolve(p).then(respond, function (e) {
    respond({ ok: false, reason: "error", message: String((e && e.message) || e) });
  });
  return true;
});

// 每次 service worker 启动兜底退役一次 Qoder 钩子（onInstalled 之外的最后一道保险）。
retireQoderHook();
