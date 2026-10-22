# Code Review · Agent 积分过期日历（extension/ v0.3.9）

> **2026-10-22 已按本轮结论修复完毕，版本推进到 v0.3.11。**
> 下面每条问题后面都标了处置结果；新增/修改的回归测试见「修复后的测试基线」。
> 原始的问题分析全部保留，方便回看当时为什么这么判。

## ⚠️ v0.3.11：修一条 v0.3.10 自己引入的回归

**症状**：WorkBuddy 点「刷新余额」永远失败，日历数字一动不动。

**根因**：第 3 条的修复做过头了。v0.3.10 把 `waitForCapture` 从「每 500ms 轮询」
改成了**纯** `chrome.storage.onChanged` 事件驱动。而 `onChanged` 并不在所有环境
都可靠——MV3 的 service worker 一旦在等待窗口（12s / 20s）内被回收或重启，函数内
注册的监听器不会自动恢复；各家的 MV3 实现也不完全一致。

事件没派发时的表现极具迷惑性：

- 样本**其实已经入库**了（`captures` +1、`lastTargetAt` 已更新）；
- 但等待一直判 `seen: false` → `ok: false` → **后续 `syncOne` 根本不跑**；
- 于是 `batches` 一条没变，用户看到「余额刷不出来」；
- 更糟的是探针里 `stored: 1`，诊断照样说"截到并存了 1 条新样本"——
  和"刷新失败"自相矛盾。

**为什么单测没拦住**：338 条断言全绿。它们覆盖的是 lib / adapters 的纯函数，
而这里坏的是**接线**（等待机制），属于"每一段都对、接起来坏"。

**修法**：事件驱动保留（快），但**不能当唯一手段**。
- 注册监听后立刻复查一次——消除"取基线到挂监听之间样本已写入"的竞态；
- 2 秒定时器从"只判超时"升级为"判超时 + 兜底复查"，事件失效时最迟 2 秒发现。

代价是每 2 秒一次反序列化，仍比 v0.3.9 的每 500ms 全量解析轻一个量级。

**守卫**：新增 `test/e2e-refresh.test.cjs`，在 mock 的 chrome 环境里真实加载
`background.js` 走完整刷新链路，两个场景都跑（事件正常派发 / 事件不派发）。
把兜底复查临时回退后实测：3 条断言失败、退出码 1，症状与线上完全一致。

顺带回退第 11 条的 `use_dynamic_url: true`：它是纯收益极低的防指纹改动，却有可能
影响 MAIN world content script 的注入路径，而我无法在真实浏览器上验证。主功能
面前不冒这个险。

## 修复后的测试基线

`cd extension && npm test`（等价 `node test/run-all.cjs`）：

```
adapters 27 · capture-main 15 · capture-relay 12 · diagnose 21 · e2e-refresh 7
integration 61 · lobsterai 26 · normalize 72 · ownership 10 · qoder 22 · trae 28 · workbuddy 44
—— 345 passed, 0 failed（12 个文件，修复前是 271 条）
```

新增的 5 个测试文件：`ownership.test.cjs`（样本归属的信任边界）、
`capture-relay.test.cjs`（中继入库前的形状闸 + 剥离 agentId）、
`diagnose.test.cjs`（探针诊断口径）、
`e2e-refresh.test.cjs`（刷新链路端到端，拦"接线"类回归）、
`run-all.cjs`（聚合 runner，非测试）。

### 处置汇总

| # | 问题 | 处置 | 落点 |
|---|---|---|---|
| 1 | 页面可伪造 `agentId` 污染别家批次 | ✅ 双闸：中继剥离 + `attributeAgent` 只认可信通道 | `capture-relay.js`、`lib/agents.js`、`background.js` |
| 2 | 样本详情全量渲染卡死 | ✅ 折叠 2000 字符 / 展开上限 40000 + 单条导出 | `ui/calendar.js` |
| 3 | 每 500ms 全量反序列化文档 | ✅ 改 `chrome.storage.onChanged` 事件驱动 + 2s 兜底复查（v0.3.11 修正：事件只用来"更快"，不能当唯一手段，见顶部） | `background.js` |
| 4 | `contentHash` 浮点乘法丢低位 | ✅ 两路都换 `Math.imul` | `lib/normalize.js` |
| 5 | 冻结批次 `status` 永不更新 | ✅ 手动分支补 `statusOf` | `lib/normalize.js` |
| 6 | 诊断逻辑后台/UI 双份 | ✅ 抽成 `lib/diagnose.js`，两边共用 | `lib/diagnose.js` |
| 7 | `stableTag`/`lastUsableDay` 逐字重复 | ✅ 抽成 `N.stableTag` / `N.daySuffix`，三家共用 | `lib/normalize.js` + 三个 adapter |
| 8 | 编辑路径 batchId 碰撞无防护 | ✅ 保存前校验新 id 未被占用 | `ui/calendar.js` |
| 9 | `_expSource` 污染导出 | ✅ 不再写入批次对象 | `lib/normalize.js` |
| 10 | 探针异常路径泄漏 | ✅ 钩子路径加 `.catch` 收尾 + 直读把早退挪到建探针前；诊断新增 `outcome:"error"` 分支 | `background.js`、`lib/diagnose.js` |
| 11 | WAR 可被指纹探测 | ⬜ **已回退**。`use_dynamic_url: true` 在 v0.3.10 短暂启用过，为排查 WorkBuddy 刷新失败而撤回（见顶部）：收益只是防指纹，却可能动到 MAIN world 注入路径，无法真机验证。真要收敛，优先把 `matches` 从 `https://*/*` 收到四个已知 origin | — |
| 12 | 工具栏无图标 | ⬜ 未做（需要真实 png 资源，且 README 说图标是刻意留白的） | — |
| 13 | 无 `npm test` / README 无测试说明 | ✅ 加 `package.json` + `test/run-all.cjs` + README 一节 | `extension/` |
| 14 | 阈值取到空值变 NaN | ✅ 钳制到 1–365，非法值回落 14 | `ui/calendar.js` |
| 15 | XHR `loadend` 监听器累积 | ✅ 改 `{ once: true }` | `capture-main.js` |
| 16 | `__cc*` 可枚举实例属性暴露钩子 | ✅ 改 `WeakMap` | `capture-main.js` |
| 17 | `update()` 可重入死锁 | ✅ 注释写明 mutator 内禁止调 `update()` | `lib/store.js` |

UI 层另做了 jsdom 冒烟（一次性脚本，未入库以保持零依赖）：130KB 样本的详情页
DOM 从 ~161KB 降到 2KB，展开/收起/导出按钮均可用，全程无 JS 报错。

---

评审范围：`extension/`（manifest / lib / adapters / background / capture-* / ui）与 `REQUIREMENTS.md`。
测试基线：`node test/*.test.cjs` × 8 个文件，**271 条断言全绿**（normalize 56、integration 61、adapters 27、qoder 22、lobsterai 26、trae 28、workbuddy 44、capture-main 7）。

---

## 总体评价

这是我见过注释写得最认真的个人项目之一：**每一条非直觉的代码决策都注明了「为什么」和「放弃了什么」**，且注释与 `REQUIREMENTS.md` 的决策记录严格对应（§7 的 23 条决策能逐条落到具体文件与行）。抓取层的可观测性设计（刷新探针五段计数、授权会话持久化、权限自检页）明显是"被真机 bug 打过之后长出来的"，不是纸上设计。

三个架构选择值得肯定：
- **规则层 `lib/normalize.js` 用 UMD + ES5 写法**，同时被 SW（`importScripts`）、扩展页面（`<script>`）、node 单测（`require`）消费，一份实现三处复用——这是本项目的地基。
- **隐私边界落实到了代码**而不仅是承诺：`sanitizeCapture` 只存 header 名字、WorkBuddy adapter 完全不读 `AccountAttributes`（含 payerUin）、`ResourceId` 只落派生短码。
- **"抓不到"与"没有了"严格区分**（`absentCount` 只在本次覆盖的 agent 内累加、`truncated` 样本拒绝同步、`fresh` 三态），这正是一个"给错误到期日比没数据更危险"的工具该有的谨慎。

问题主要集中在**信任边界**和**规模下的性能**，逻辑正确性整体扎实。

---

## P1 · 应当修复

### 1. `entry.agentId` 可被被注入页面伪造，污染任意平台的批次

`capture-relay.js:20-28` 的 `validEntry` 只做形状校验（协议、状态码、体量、origin），**不校验也不剥离 `agentId`**；随后 `background.js:363`：

```js
var who = entry.agentId ? Promise.resolve(entry.agentId) : resolveAgent(entry.origin);
```

只要 entry 自带 `agentId`，就**完全跳过 origin → 平台的归属判断**。而 MAIN world 与页面脚本共享 JS 环境，页面（或页面里任何第三方脚本 / XSS）可以自行 `window.postMessage({__creditCapture:true, entry:{...自己填的 agentId...}}, "*")`，绕过 `capture-main.js` 直接投递。

**影响**：`REQUIREMENTS.md` §`capture-relay.js` 头部注释承认的威胁模型是"站点只能污染**自己**那一家的数据"。`agentId` 透传把这个范围扩大成了**任意平台**——比如 `www.workbuddy.cn` 上的脚本可以伪造一份 Qoder adapter 认得出的 JSON，往你的 Qoder 批次里塞假的到期日与余额。这与项目自己写下的原则（§5："一个静默给出错误到期日的工具比手动录入更危险"）直接冲突。

**建议**：`CAPTURED` 通道强制走 `resolveAgent(sender.tab.url 的 origin)`，`agentId` 只允许 `PASTE_CAPTURE`（来自扩展自身 UI，可信）携带；或至少在 relay 的 `validEntry` 里 `delete entry.agentId`。

> ✅ **已修（两道闸都加了）**
> - `capture-relay.js`：转发前 `delete d.entry.agentId`，页面伪造的样本根本带不出平台归属。
> - `lib/agents.js` 新增 `attributeAgent(entry, sender, trusted, agents)`，作为**唯一**归属入口：
>   trusted（粘贴样本）才认 `entry.agentId`，且校验该 id 真的登记过；其余通道一律按
>   `sender.tab.url` 的 origin 认（浏览器给出的值，页面改不了），缺失时才退回 `entry.origin`。
> - `background.js` 的 `onCaptured` 改走它，签名加 `{ trusted: true }`，只有 PASTE_CAPTURE 传。
> - 回归：`test/ownership.test.cjs`（10 条）+ `test/capture-relay.test.cjs`（12 条）。

### 2. 「看样本」会把 200KB 响应体全量塞进 DOM

`calendar.js:760`：

```js
+ "<pre>" + pretty(c.bodyPreview) + "</pre>"
```

`pretty()`（:778）还会 `JSON.stringify(..., null, 1)` 再展开，130KB 的 WorkBuddy 响应缩进后更大。`doc.captures` 上限是 60 条（`background.js:19`），单条上限 200KB——点一次「看样本」就是 **MB 到十 MB 级的 DOM 文本 + 60 次 JSON 解析**，扩展页必然卡死数秒甚至被系统判定无响应。

**建议**：默认只渲染前 2–5KB + 「展开这一条」按钮 + 「单独导出这条」按钮（`download()` 已存在，直接复用）。

---

## P2 · 建议修复

### 3. `waitForCapture` 每 500ms 全量反序列化一次整个文档

`background.js:786-798` 用 `setInterval(..., 500)` 反复调 `CreditStore.load()`，而 `load()` 是把整个文档（含全部 captures）从 `chrome.storage.local` 取出并 JSON 解析。20 秒窗口 = 40 次全量读取；按当前 WorkBuddy 单条 ~130KB、十余条样本估算就是每次 1–2MB、总计几十 MB 的解析开销，全部堆在 service worker 里。

**建议**：改用 `chrome.storage.onChanged` 事件驱动（`storeCapture` 已经在写 `lastSeenAt` / `lastTargetAt`，监听这两个字段即可）；或把寄存器计数放内存、只轮询一个轻量计数器。

### 4. `contentHash` 用浮点乘法，静默丢失低位

`normalize.js:206-211`：

```js
h1 = ((h1 ^ c) * 0x01000193) >>> 0;
h2 = ((h2 + c) * 0x85ebca6b) >>> 0;
```

`(h1^c)` 最大 ~4.29e9，乘 0x01000193（1.68e7）得 **7.21e16 > 2^53**；h2 那一路更是到 **9.6e18**。实测：

```
浮点乘 vs Math.imul 是否一致: false  差值: -35716716105302016
```

结果仍然确定（不会误判），但有效位数缩水，且与 `trae.js:86` / `workbuddy.js:78` 里**正确使用了 `Math.imul`** 的 `stableTag` 自相矛盾。v0.2.5 那条"1873→1870 位数没变导致误判重复"的回归正是靠这个函数兜住的，不该在精度上留隐患。

**建议**：两处都换 `Math.imul`。

### 5. 冻结批次的 `status` 永不更新

`normalize.js:309-327` 的 `manualEdited` 分支只写 `scraped` / `conflict`，不更新 `status`（非冻结分支 :339 和缺席分支 :357 都更新了）。实测复现：

```
冻结批次 status（expiresAt=2026-01-01，今天 2026-10-22）: active
缺席批次 status: expired  ✔
```

目前 UI 一律用 `daysLeft()` 判断过期，所以看不出来。但 `status` 是 `REQUIREMENTS.md` §2 领域模型里的正式字段，一旦 M3 的 `.ics` 导出或任何筛选逻辑读它，就会把过期批次当有效。

**建议**：手动分支补 `cur.status = statusOf(cur.expiresAt, now)`。

### 6. `diagnoseProbe` 在后台与 UI 各写一份，且已经漂移

`background.js:308-356`（`diagnoseProbe`）与 `calendar.js:714-739`（`diagnose`），注释写的是"同口径，UI 侧再算一次，免得依赖后台回传"。但实际措辞已经不一致（如 direct 分支：后台版带"N 字节"，UI 版不带）。更关键的是——**后台 `refreshCaptures` 明明已经回了 `diagnosis` 字段**（`background.js:712`），UI 却又自己算了一遍，等于双份真相。

**建议**：抽到 `lib/` 共用，UI 直接用后台回传值。

### 7. `stableTag` / `lastUsableDay` 在 trae.js 与 workbuddy.js 逐字重复

`trae.js:86-101` 与 `workbuddy.js:78-93` 是同一份 FNV-1a + 位混淆（15 行，逐字相同）；`lastUsableDay` 也在两家各写一遍（`trae.js:55` / `workbuddy.js:64`）。这类"同一批次标识算法"一旦某天只改一边，两家的短码口径就会分叉。

**建议**：提到 `normalize.js` 导出（它已经在做 `contentHash`，放一起最自然），或新增 `lib/stable.js`。

---

## P3 · 可选改进

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 8 | `normalize.js:189-193,215` / `calendar.js:909` | `batchId` 取 32 位哈希前 8 位 hex，40+ 批次时碰撞概率 ~3e-7；`addsave`（:927）校验了重复，但**编辑保存路径没校验**，`byId()` 又只返回第一个匹配 → 撞车时会改错批次 | 编辑保存时同样校验新 `batchId` 未被占用 |
| 9 | `normalize.js:243` | `b._expSource = exp.source` 是内部调试字段，会随 JSON 导出一起出去 | 加 `_` 前缀过滤，或干脆不落盘 |
| 10 | `background.js:656-720` | `beginProbe` 之后若 `register()` 抛错，`endProbe` 不执行，`probeMem[agentId]` 在 SW 生命周期内永久驻留，下次刷新读到脏探针 | 整体包 try/finally |
| 11 | `manifest.json:27-38` | `web_accessible_resources` 的 `matches` 是 `https://*/*` 且 `use_dynamic_url: false` → 脚本 URL 稳定，任意 https 页面可探测到本扩展（指纹识别） | 改 `use_dynamic_url: true`；matches 尽量收敛到四个已知 origin |
| 12 | `manifest.json:24-26` | `action` 无 icons，Chrome 显示占位拼图块，工具栏里不易辨认 | 补一组 icon（README 说"故意留空"指扩展图标，工具栏图标还是建议有） |
| 13 | 项目根 | 无 `package.json`，README（434 行）里**完全没有测试运行说明**；实测 `node --test test/` 会报 `MODULE_NOT_FOUND`（目录被当模块） | 加 `package.json` + `"test"` 脚本，README 补一节 |
| 14 | `calendar.js:951-955` | 阈值下拉若取到空值/非法值，`+this.value` 落库成 `NaN`，「即将到期」永久空白且无任何提示 | `Math.min/max` 钳制到 1–365 |
| 15 | `capture-main.js:120-135` | XHR 的 `send` 每次都 `addEventListener("loadend")`，复用同一 XHR 多次 send 会累积监听器并重复上报 | 用 `{ once: true }` 或先 remove |
| 16 | `capture-main.js:116-119,139-141` | `__ccUrl` / `__ccMethod` / `__ccHeaders` 是可枚举实例属性，挂在 XHR 上页面脚本能枚举到——这本身就是"fetch 被 hook"的可检测特征，与项目规避反爬的目标相悖 | 改用 `Symbol` 或 `WeakMap` |
| 17 | `store.js:112-124` | `update()` 用 promise 链串行化；若任何 mutator 内部再调 `update()` 会自我死锁。目前所有 mutator 都是纯的，但这是个没有护栏的坑 | 在注释里写明"mutator 内禁止调用 update"，或加重入检测 |

---

## 值得保留的做法（别在后续重构里丢掉）

- **刷新探针的五段计数**（`responses` / `rejected` / `candidates` / `stored` / `dups`+`upgraded`）——把"没读到"从一个结论拆成五个可定位的断点，这是本项目最有价值的设计之一。
- **`hookActive` 严格认 `=== true`**（`store.js:73`）：这个标记会让同步自动去注入页面，脏值当真值处理等于偷偷装钩子。
- **`commit()` 的读-改-写重放**（`calendar.js:88-95`）：UI 侧不再拿内存旧快照整份覆盖，避免抹掉后台刚写入的样本与授权状态。
- **样本重复改为原位替换而非丢弃**（`background.js:443-451`）：这是 v0.3.9 让旧截断样本能被完整响应升级的关键，逻辑很绕但注释解释得很清楚。
- **`pickCapture` 的三级圈定**（`adapters/index.js:55-82`）：direct 优先 → `endpointHint` 圈定 → 排除截断 → 才比分。顺序不能乱。

## 建议的修复顺序

1. #1（信任边界）→ #2（UI 卡死）
2. #4 #5（都是静默错误，测试也测不出来）
3. #3 #7 → #6
4. 其余 P3 按触感排

#1 和 #2 建议各配一条回归：#1 在 `capture-main.test.cjs` 里加"伪造 agentId 的 entry 应被归属到 origin 而非 agentId"；#2 加"单条 130KB 样本的详情页 DOM 节点数 < N"。
