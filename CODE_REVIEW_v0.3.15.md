# Code Review · 第二轮（`extension/` v0.3.15）

> 评审时间：2026-10-22 · 范围：`extension/` 全量（12 个源文件 3.4k 行 + 12 个测试文件 3.1k 行）
> 基线：`cd extension && npm test` → **397 passed, 0 failed**
> 上一轮（v0.3.9）的 `CODE_REVIEW.md` 已归档在项目根，本轮只记新发现，以及上一轮结论的复核。
>
> **处置状态（v0.3.16 已落地）**：P1 #1 #2 #3、P2 #4 #5 #6 #7，以及 P3 #8 #9 #10 #11 #12 #14 #16 均已修复
> （#15 保留但已在注释里标明"暂无入口"）；仅 #13（`waitForCapture` 的 2 秒兜底仍全量 `load()`）未做，
> 理由见 `REQUIREMENTS.md` 决策 26。新增回归 67 条，`npm test` → **464 passed, 0 failed**。
> 修复过程中另发现一处评审没提的问题：`renderFoot()` 没有任何调用方，页脚（含唯一的清空入口）
> 其实一直没渲染过；已接入 `render()`，并由新增的 `test/ui.test.cjs` 钉住。
> 落地细节见 `REQUIREMENTS.md` 决策 26 与 `extension/README.md` 的 v0.3.16 段。

## 0. 上一轮 17 条的复核

逐条对照代码，**15 条确认已落地**（`Math.imul`、冻结批次补 `statusOf`、`WeakMap`、`{once:true}`、`stableTag` 收归 `normalize`、`diagnose` 单一口径、编辑路径 batchId 撞车校验、`_expSource` 已移除、探针 `.catch` 收尾、阈值写入钳制、`package.json` + `run-all.cjs`、mutator 禁重入注释…均已验到）。

两条按记录**主动放弃**：

| # | 状态 | 本轮意见 |
|---|---|---|
| 11 `use_dynamic_url` | 回退 | 回退理由成立（怕动 MAIN world 注入路径）。但**收敛 `matches` 是零风险的替代**，见 P2-5，建议做。 |
| 12 工具栏图标 | 未做 | 保持现状可接受；但 `action` 无 `icons` 时 Chrome 会显示占位拼图，而唯一的入口就是它。 |

新的问题集中在**跨上下文写入时序**和**刚长出来的代发兜底链路**上，规则层（`lib/normalize.js`）这次没找到新问题。

---

## P1 · 应当修复

### 1. 每次 service worker 唤醒都会整份重写文档，进而把「补录批次」表单冲掉

两处单独看都合理，接起来是个 bug：

- `background.js:1399` 顶层调 `retireQoderHook()`，而它（`:205-216`）在 **`unregister` 之后无条件 `CreditStore.update()`**。`update` = `load()` 整份文档 + 序列化 + `set()`。SW 每次被唤醒（任意消息、任意站点的心跳）都会跑一次，哪怕 Qoder 的三字段早就是目标值。
- `ui/calendar.js:102-118` 监听 `chrome.storage.onChanged`，在 `!edit && !authOpen` 时直接 `render()`。

而 **`renderAdd()`（`:417`）不设任何"正在编辑"标记**（`edit` 仍是 `null`），所以：

> 用户点「+ 补录一笔到这天」→ 正在填名称/数量 → 另一个标签页加载了一次 workbuddy.cn（`capture-relay.js:55` 的 `RELAY_READY` 唤醒 SW）→ `retireQoderHook` 写存储 → `onChanged` → `render()` → **表单连同已输入的字段一起消失，无提示**。

同一个 `onChanged` 分支对 `renderEdit`（有 `edit` 守卫）和 `renderPaste`（`authView` + `typing` 守卫）都是安全的，只有新增表单漏了。这也是为什么这个问题只在补录路径上出现。

**建议（两条都做）**

1. `retireQoderHook` 先读后判，已经是目标状态就不写：

```js
function retireQoderHook() {
  return unregister("https://qoder.com").then(function () {
    return CreditStore.load().then(function (d) {
      var a = d.agents && d.agents.qoder;
      // 已经是目标状态就别写：SW 每次唤醒都整份 set() 一次，
      // 会把 UI 从渲染中叫醒（补录表单就是这么被冲掉的），也白耗一次反序列化。
      if (!a || (!a.hookActive && a.fetchMode === "direct" && a.origin === QODER_ORIGIN)) return null;
      return CreditStore.update(function (doc) { /* 原有赋值 */ });
    });
  }).catch(function () {});
}
```

2. 给补录表单加守卫（`adding` 标志，语义与 `edit` 并列）：

```js
var adding = false;
// act === "add" 时：adding = true;
// 保存/关闭/切格子时：adding = false;
// onChanged: if (!edit && !adding && !authOpen) render(); else renderCards(), ...
```

### 2. `probe.outcome === "error"` 时，诊断页标题仍写「读到了页面响应」并标绿

`ui/calendar.js:715-721`：

```js
var fbOk = !!(p.fallback && p.fallback.ok);
var ok = p.outcome !== "both-failed" || fbOk;          // ← "error" 也落进 true
var verdict = p.outcome !== "both-failed" ? "读到了页面响应" : ...
```

`endProbe(agentId, "error")`（`background.js:790`）存下来的探针，`outcome` 是 `"error"`。于是同一屏出现：绿色标题「读到了页面响应」+ 下面结论「刷新流程本身出错了…下面的计数只记录到一半」（`lib/diagnose.js:60-63`）。

这正是 v0.3.15 花一整轮修掉的"同一屏两句话互相打架"，只是当时只补了 `both-failed + fallback` 那一支，`error` 这一支漏了。

**建议**

```js
var errored = p.outcome === "error";
var ok = (!errored && p.outcome !== "both-failed") || fbOk;
var verdict = errored ? "流程出错（不是平台没给数据）"
  : p.outcome !== "both-failed" ? "读到了页面响应"
  : (fbOk ? "页面没发请求，代发读到了" : "没读到（隐藏页和可见页都试过了）");
```

顺带：`diagnose.test.cjs` 里加一条"error 探针的 UI 标题口径"断言成本很低（`of()` 已经覆盖了 error 文案，缺的是 UI 那层——但它可以抽成纯函数放进 `lib/diagnose.js`，例如 `Diagnose.verdict(p) -> {ok, text}`，两边共用）。

### 3. 「清空本机数据重新开始」一键执行、零确认，且没有导入可回滚

`ui/calendar.js:873-877`：

```js
$("#wipe").onclick = function (e) {
  e.preventDefault();
  Store.wipe().then(function () { location.reload(); });
};
```

一次点击 = `chrome.storage.local.remove(KEY)`（`lib/store.js:132`），批次、样本、四个平台的授权配置、`authPending`、探针全部消失，**没有二次确认，也没有导入功能**（全仓 grep `FileReader` / `导入` / `type="file"` 无命中）。

两个问题叠在一起才危险：

- 需求 §4.3 对"删一笔批次"都要求行内两段式确认（决策 8），对"删全部数据"却零缓冲；
- 需求 §3.3 把 **JSON 导出/导入** 当作换机器/备份的唯一出路，导出做了、**导入从来没做**。所以清空之后没有任何恢复路径，连"我把导出的 JSON 贴回来"都做不到。

**建议**：① `#wipe` 复用行内两段式确认（同一套 `delConfirm` 机制，4 秒撤销）；② 补 `IMPORT` 消息或纯前端 `FileReader` 导入，落库前必须过 `Store.migrate` + 校验 `batches`/`captures` 类型（否则一个坏 JSON 就能把 `doc` 结构打烂，UI 会白屏）。这一条同时也是需求 §3.3 里唯一还没兑现的承诺。

---

## P2 · 建议修复

### 4. 同一 agent 的并发刷新没有互斥，会留下错误的 `hookActive`

`probeMem`（`background.js:295`）只按 `agentId` 置位，`refreshCaptures`（`:699`）没有任何 in-flight 判断，UI 的「刷新余额」按钮在刷新期间也不 disable（`ui/calendar.js:1162-1173`）。连点两次的后果不是"两次都失败"，而是**状态机被踩坏**：

1. 第二次 `beginProbe` 覆盖第一次的探针 → 第一次 `endProbe` 把 `probeMem[agentId]` 删掉 → 第二次 `endProbe` 拿到 `null`，存回去的诊断是「没有探针记录」（`lib/diagnose.js:31`）；
2. 更糟的是 `ephemeral` 路径：两次刷新各自 `register()`，结束时**先到的那次 `unregister()` 会把另一次的钩子拆掉**（`:753-757`），而它自己的 `hookActive` 却写成了 `true`。

于是 `syncAll` 会据此认为"钩子在，可以自动抓活数据"（`:1362`），而实际上钩子已被注销 —— 之后每次「立即同步」都在一个没有钩子的页面上等 32 秒，并且这不是用户能自己看出来的失败。

**建议**：`var refreshing = {}` 作互斥，第二个请求直接回 `{ok:false, error:"上一次刷新还没结束"}`；UI 侧在 `sendMessage` 前 `t.disable = true`，回调里复原（`reauth` 分支现在完全没有 disable）。语义与 `authSyncing`（`:29`）一致，可以合并成一个 `busy[agentId]`。

### 5. `web_accessible_resources` 仍对全 https 开放（上一轮 #11 的廉价替代）

`manifest.json:27-37`：`resources: [capture-main.js, capture-relay.js]` + `matches: ["https://*/*"]`。任何 https 页面都能用固定 URL 探测到本扩展（`use_dynamic_url` 撤了），而这两个脚本只可能出现在四个已知 origin 上。

上一轮不敢动的是 `use_dynamic_url`（可能影响 MAIN world 注入）。但 **`matches` 收敛到四个 origin 不碰注入路径**，纯收益：

```json
"matches": [
  "https://qoder.com/*",
  "https://www.trae.cn/*",
  "https://www.workbuddy.cn/*",
  "https://lobsterai.youdao.com/*"
]
```

将来粘贴新域名时，`optional_permissions` 那条路本来就要求同时补 manifest，届时一起加即可。

### 6. `settings` 在 `migrate` 里不钳制，坏的 `threshold` 会永久空白「即将到期」

上一轮 #14 修的是**写入路径**（`ui/calendar.js:1015-1023` 钳制 1–365），但读路径没管。实测：

```
migrate 后 threshold = NaN        // Store.migrate({settings:{threshold:NaN}})
```

来源不必是攻击：老版本（#14 修复之前）写进去的 `NaN` 会一直躺在文档里，`upcoming()`（`:133-137`）的 `d <= NaN` 恒为 false，于是"未来 N 天内无积分到期"永远显示，**而且 `#thr` 下拉的 value 是 "NaN"，选中态直接空掉**——用户看不到任何异常。

**建议**：在 `lib/store.js:47` 的 settings 合并后统一钳制一次（`staleDays` / `lazySyncDays` 同样处理），让"读进来的东西一定合法"成为不变量，而不是指望每条写入路径都记得夹一下。

### 7. Qoder 的 `endpoint` 永远存不住（写一次被抹一次）

`lib/store.js:63`：`endpoint: isDirect ? null : (saved.endpoint || null)`。

但直读流水线每次成功都会写它（`background.js:1146` `a.endpoint = cfg.url`；`syncOne:1310` 也写）。结果是：写入 → 下次 `load()`（每次 UI 打开、每个 SW 唤醒）→ 又变 `null`。实测：

```
migrate 后 qoder.endpoint = null | fetchMode = direct
```

当前没有功能因此坏掉（`renderProbe` 有 `a.endpoint` 兜底、`renderPaste` 也有），但这是一个**只写不读的字段**：以后任何"显示当前取数接口"的需求都会踩一次坑，而且诊断页对 Qoder 永远显示"未记录"。

**建议**：`origin` / `consoleUrl` 强制代码值是有理由的（钩子会挂错域名），`endpoint` 没有这个理由——它是运行时事实，应当保留 `saved.endpoint`。

---

## P3 · 可选改进

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 8 | `background.js:478-487` | `MAX_CAPTURES` 淘汰循环可能淘汰**刚入库的那条**：`worst` 从 0 开始比 `captureRank`，新样本若分数最低会当场被删，而 `p.stored` 已经 `+1`（探针说存了 1 条，库里没有） | 循环里 `if (list[j] === clean) continue;`，或在候选里排除 `clean` |
| 9 | `lib/normalize.js:411-420` | `applyManualEdit` 不校验也不 trim `label`。实测把名称改成空格后 `dedupKey = "qoder||2026-11-01"`，两笔空名批次会互相覆盖；`renderEdit` 走了 `esc` 也看不出异常 | patch 进对象前 `label` 做 `String(v).trim()`，空串则拒绝保存（补录路径已有此校验，编辑路径漏了） |
| 10 | `lib/normalize.js:326-336` | `frozenByName` 同名只留最后一个。两笔同名冻结批次时，另一笔永远匹配不上，`absentCount` 无上限增长（实测 `[1, 0]`），UI 上会一直显示"最近 N 次同步没返回这笔" | 同名多笔时改成队列/数组匹配，或至少在 UI 上把 `absentCount > 3` 的批次提示"可考虑删除" |
| 11 | `lib/normalize.js:189-193,218` | `hash6` 拼零的逻辑让 batchId 后缀长度不定长。实测 3000 次：`{6: 9, 7: 184, 8: 2807}`，与注释「取前 8 位 hex」不符 | `("00000000" + h.toString(16)).slice(-8)` 一行搞定 |
| 12 | `ui/calendar.js:758-759` | 「看样本」只按 `score` 排序，同分时**旧样本在前**；`pickCapture`（`adapters/index.js:79`）却在同分时按 `at` 降序。两处口径不一致，v0.3.15 那条"面板上排第一的却是 12:53 的旧样本"只修了成因（清理截断样本），没修观感 | 排序补一个 `at` 降序 tiebreak，与 `pickCapture` 对齐 |
| 13 | `background.js:925-928` | 2 秒兜底复查每次 `CreditStore.load()` 反序列化整份文档（最多 60 条 × 200KB）。v0.3.9 被诟病的正是这个，v0.3.11 为了可靠性又加回来了 | 单独维护一个轻量 key（如 `capture-seq`），`storeCapture` 每次 `+1`；等待期间只读这个小 key，命中后再 `load()` 一次。既保留兜底，又不回到全量轮询 |
| 14 | `capture-main.js:86-104` | 只按 `content-length` 挡大响应。分块传输（无该头）时会 `clone().text()` 把整条响应缓冲进内存，再 `slice(0, MAX_BODY)` —— 一个流式下载就能把页面内存拉满 | 对 `cl` 缺失的情况也设一道（例如 `ct` 为 `text/event-stream` 已挡；再跳过 `application/octet-stream` / `application/pdf` 等） |
| 15 | `background.js:236-261` | `registerAndOpen` 的 `adapter.direct` 分支已无入口：UI 对直读平台只渲染「刷新余额/看样本」（`ui/calendar.js:526-530`），永远不会发 `REGISTER_AND_OPEN` | 删掉或在注释里写明"为未来直读平台保留" |
| 16 | `README.md:91` | 写「共 345 条断言」，实际 397（v0.3.15 补了 `diagnose` +16、`workbuddy` +13、`e2e-refresh` +15、`capture-main` +2） | 顺手改掉；这类数字漂移会让人怀疑其他数字 |

---

## 值得保留的做法（别在后续重构里丢掉）

- **`lib/normalize.js` 的 UMD + ES5 三处复用**（SW `importScripts` / 扩展页 `<script>` / node `require`）依然是这个项目最正确的地基决定。规则层 478 行、72 条单测，本轮没找到新问题，说明"把不变量塞进纯函数"这条路是对的。
- **`waitForCapture` 那 8 行注释**（`background.js:911-924`）把"事件驱动为什么不能当唯一手段"写清楚了，包括 `setInterval` 顺带续命 SW 这个非直觉副作用。这类注释比代码值钱。
- **`diagnose.js` 的单一口径**：`of(p)` 里把"代发成功"整段换口径而不是追加一句（`:137-145`），这是修"自相矛盾"的正确姿势，不是打补丁。
- **`attributeAgent` 的证据链注释**（`lib/agents.js:56-72`）把威胁模型、放行的后果、为什么 `sender.tab.url` 可信写在同一处，且配了 10 条 `ownership` 回归。这轮复核时我直接信了它，没再重新推一遍 —— 这就是好注释的复利。

## 建议的修复顺序

1. **#2**（一屏两句话矛盾，改动 5 行，直接违背项目自己的底线）→ **#1**（表单被冲掉 + 无谓的整份重写，一处改动同时解决两个症状）
2. **#3**（一键清空 + 无导入，唯一不可恢复的操作）
3. **#4**（并发踩坏 `hookActive`，会静默让自动同步失效）→ **#6 #7**（读路径不合法/字段丢失，都是"以后会咬人"）
4. **#5**（一行 manifest）→ 其余 P3 按触感排

配回归的建议：**#1** 在 `e2e-refresh.test.cjs` 里加"SW 启动时若 Qoder 已是目标状态，则不应产生 storage 写入"；**#2** 把 UI 那层口径抽成 `Diagnose.verdict(p)` 并加 2 条断言；**#3** 加"导入一个缺 `batches` 的 JSON 后文档结构仍然合法"；**#4** 加"并发两次 REFRESH_CAPTURES，第二次应被拒且 `hookActive` 不变"。
