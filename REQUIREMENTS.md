# AI Agent 积分过期日历 · 需求规划（v3）

> 状态：`extension/` **v0.3.16**，Qoder 页面内直读、LobsterAI / TRAE 跨域截获、WorkBuddy 同源截获已接入（授权后自动收尾）。
> v0.3.9 修掉 WorkBuddy 130KB 响应被 60KB 上限截断，并让旧截断样本在刷新时原位升级。
> v0.3.10 是修 bug 的版本：收紧样本归属的信任边界（页面伪造 `agentId` 可污染别家批次）、样本详情不再全量渲染、`contentHash` 精度、冻结批次 `status`、刷新等待改事件驱动。详见 `CODE_REVIEW.md`。
> v0.3.11 补回事件驱动的兜底复查（只靠 `storage.onChanged` 会在 SW 被回收时静默丢事件）。
> v0.3.12–13 把「目标接口到底回了什么 / 到底有没有被请求」记进探针，诊断不再瞎猜。
> v0.3.14 修 WorkBuddy「刷新余额」永远失败：页面自己不发额度请求时，改在同一个页面上下文里代发一次只读请求（决策 24）。
> v0.3.16 补上导入、清空改两段式确认，并修掉「后台每次唤醒都重写存储冲掉补录表单」「诊断页标题与结论打架」等边界问题（决策 26）。
> 目标平台：Qoder、TRAE、WorkBuddy、LobsterAI
> 形态：**Chrome MV3 浏览器扩展**（v1 的「本地单页网页 + Node/Playwright 抓取」方案已废弃，见 §7 决策记录）
> 日常浏览器：Opera（Chromium 内核，按 Chrome 扩展装载）
> 公开脱敏：文中真机笔数与合计均为近似值，不写具体账户额度；凭据从不入库。

## 1. 目标与非目标

**要解决的唯一问题**：我在每个 Agent 上还剩多少积分，它们分别哪天失效，我该先花掉哪一笔。

MVP 目标：

- 一个**日历视图**：只在批次到期当天标注「xx agent 今日有 xx 积分过期」
- 一个**即将到期与余额总览**：承担"该赶紧花掉哪一笔"的决策（日历不表达倒计时，这部分是必要补充，不可裁掉）
- 数据来自四个平台官网控制台的自动抓取，手动录入作为兜底

非目标：

- 不做多用户、账号体系、云端同步
- 不做积分消耗预测或预算建议
- 不做任何写操作（充值、扣费、改套餐），工具全程只读
- 不追求四平台 100% 自动覆盖；抓不通的平台降级为 manual-only，不阻塞主线

## 2. 领域模型

工具里只有一个真正的数据对象：**积分批次（CreditBatch）**。

核心判断：这些平台的积分不是一笔总余额，而是**分批发放、每批各自带独立过期时间**（月度套餐包、活动赠送包、活动加购包到期日完全不同）。只记录"余额 + 一个过期日"必然算错，必须按批次建模；余额只是所有未过期批次的求和结果。

```jsonc
{
  "agent": "qoder",                 // qoder | trae | workbuddy | lobsterai
  "batchId": "qoder-3f9a2c",        // 由 dedupKey 哈希得到，稳定
  "label": "10月 套餐积分",          // 控制台上的原始名称
  "unit": "credits",                // 四平台当前都是 credits；字段留着给以后真的不同的平台
  "granted": 6000,                  // 该批发放总量
  "remaining": 4800,                // 该批当前剩余
  "expiresAt": "2026-10-31",        // 最后一个可用日（见下方时间约定）
  "resetInstant": "2026-11-01T00:00:00+08:00",  // 原文是清零时刻时另存，仅用于精确展示
  "capturedAt": "2026-10-21T09:12:00+08:00",
  "source": "auto",                 // auto | manual
  "status": "active",               // active | expired | unknown
  "manualEdited": false,            // true = 冻结，抓取不得覆盖
  "conflict": false,                // true = 抓取值与手填值不一致，等你裁决
  "scraped": null,                  // 冲突时暂存的抓取值 {remaining,granted,expiresAt,capturedAt}
  "absentCount": 0                  // 连续几次同步没返回这笔（只记一次没抓到，不删数据）
}
```

Agent 配置（每个平台一条，独立于批次）：

```jsonc
{
  "agent": "qoder",
  "name": "Qoder",
  "consoleUrl": "https://.../usage",   // 你粘进来的积分页面地址（骨架里故意留空，不臆造域名）
  "origin": "https://...",             // 授权时按这一个域名申请 host_permissions
  "endpoint": "https://.../credit",    // 截获到的那个接口，用作同步目标
  "fetchMode": "capture",              // unauthorized | capture | background | hidden-tab | manual-only
  "enabled": true,
  "lastSyncAt": null,
  "lastError": null
}
```

三条必须定死的约定：

**过期时间语义**。控制台常写成 "resets on Nov 1" 或 "valid until Oct 31"，两者差一天。统一约定 `expiresAt` = **该批次最后一个可用日**，抓取时按原文语义换算，UI 文案直接写"10-31 到期 / 10-31 当天仍可用"。所有提醒比 `expiresAt` 提前一天触发，避免用户在最后一天误判成"已经没了"。实现上：只要原文是"清零时刻"（ISO 时间戳、"resets on…"），一律 **减一天**取最后可用日，宁可少标一天也不把不能用的一天标成可用；原始清零时刻另存 `resetInstant` 供精确展示。

**批次去重键（dedupKey）**。每次同步都会返回一批记录，必须能判断"这是老批次的剩余量更新"还是"这是个新批次"，否则同步十次日历上就多十坨重复。用 `(agent, label, expiresAt)` 归一化后作为 dedupKey：命中则只更新 `remaining / capturedAt / status`，未命中才新建。这是抓取方案能否长期跑起来的关键。
两个补充口径：`label` 归一化 = 去首尾空格 + 转小写 + 折叠连续空格；`expiresAt` **故意不参与冻结批次的匹配**——用户手改的经常就是过期日，一改 dedupKey 就变，下次同步会把它当新批次再加一遍，页面上出现两笔同名不同到期日的钱。所以被 `manualEdited` 冻结的批次额外按 `(agent, label)` 兜底匹配，抓到不一致的值时记 `conflict` 交用户裁决。

**单位不可比**。四个平台的单位都已确认是 **credits（积分）**，但**仍然不可相加**——1 Qoder 积分和 1 WorkBuddy 积分不是一个东西，购买力、换算比、用完的速度都不同。所以所有汇总必须按 agent 分别列出，禁止出现"当日总积分"这种合并数字，UI 上也只在同一张卡片内部做求和。

## 3. 架构

### 3.1 一个 artifact，三个部件

```
┌─ Chrome 扩展（MV3）────────────────────────────────────────────┐
│                                                               │
│  钩子平台（TRAE / WorkBuddy / LobsterAI）                       │
│  [capture-main.js]  注入目标页面 MAIN world，document_start     │
│        │  包住 fetch / XHR，劫持页面自己发出的额度响应           │
│        ▼  window.postMessage                                   │
│  [capture-relay.js]  ISOLATED world 中转（MAIN 里没扩展 API）   │
│        ▼  chrome.runtime.sendMessage                           │
│                                                               │
│  直读平台（Qoder，v0.3.0）                                      │
│  [background]  开一个同源页面 → executeScript(world: MAIN)      │
│        │  在页面上下文里发一次只读 GET；cookie 由浏览器带上，     │
│        │  CSRF token 只活在页面里，不经过扩展、不落盘             │
│        ▼                                                       │
│  [Service Worker]  打分存样本 → adapters/<agent>.js 认字段       │
│        │  normalizeBatch → dedupKey → mergeBatches             │
│        ▼                                                       │
│  [chrome.storage.local]  batches + agentConfig + captures      │
│        ▲  读                                                   │
│  [calendar.html]  全屏标签页 UI：月历 + 总览 + 编辑 + 授权面板    │
└───────────────────────────────────────────────────────────────┘
```

日历 UI 做成扩展的**全屏标签页**（`chrome-extension://<id>/calendar.html`），不是 popup——月历在小 popup 里放不下。建议同时把它设为首页或收藏栏常驻入口。数据用 `chrome.storage.local`（申请 `unlimitedStorage`），UI 与抓取层共享同一份存储，不需要文件、不需要本地服务。

这消掉了 v1 里「本地单页网页无法跨域抓取」的分层冲突：**只剩一个交付物**。

### 3.2 取数档位（`fetchMode`）— v3 授权截获，v0.3 增加页面内直读

v2 的三档设计默认由扩展主动去请求控制台接口。实现骨架时否掉了这个默认：**扩展 service worker
发起的跨站请求属于 third-party，SameSite=Lax/Strict 的登录 cookie 根本不会带上**，
"复用浏览器登录态"在多数平台上不成立；要让它成立就得自己搬运 token，那既是安全风险也是返工风险。

所以主路径改成你说的"授权形式"——不我们请求，而是**让页面自己请求，我们劫持它的响应**：

**`capture`（主路径）** — 你在 UI 里填后台地址并点授权 → 申请该域名的 host 权限（一次性弹窗）
→ 打开该页面并用 `registerContentScripts`（`world: 'MAIN'`，`document_start`）注入钩子
→ 包住 `window.fetch` 与 `XMLHttpRequest`，页面自己发出的额度接口响应被截下
→ 按"像不像积分接口"打分存成候选样本。**鉴权完全由页面自己完成，扩展不接触 token 和密码。**
代价：第一次需要你打开页面并登录一次；页面必须真的用 XHR 拿数据（纯服务端渲染截不到）。

**`hidden-tab`（自动补抓）** — 已授权之后，同步时开一个 `active: false` 的后台标签页加载控制台，
让 SPA 自己发请求，钩子照常截获，等 12 秒拿不到就关掉并明确报"这次没抓到，保留旧数据"。
它复用的还是 `capture` 那套钩子，不是第二套抓取实现。

**`direct`（v0.3.0，当前只有 Qoder）— 页面内直读，不是后台裸调。**
Qoder 已确认"钩子在场 → 站点作废登录态"的因果（决策 19），所以这个平台不能再注入钩子。
适配器里写死已知的只读接口（`GET /api/v2/me/usages/big_model_credits`）与取数页面；
点「刷新余额」或同步时，扩展开一个同源页面，用 `chrome.scripting.executeScript({world:"MAIN"})`
在该页面上下文里发**一次**与站点自己完全一致的 GET：
`credentials: "include"`、`X-CSRF-TOKEN`（取自页面里的 `window.csrfToken`）、
`x-requested-with`、`X-Timezone`。cookie 由浏览器按同源规则自动带上，CSRF token 在页面里读取并立即使用，
**扩展既不读到 token 的值，也不保存 cookie，更不在 service worker 里发跨站请求**——所以 §3.2
开头那条 SameSite 限制依然成立，这里没有绕开它。请求不得是写操作，URL 由 adapter 固定，不接受任意目标。
401/403 判定为未登录：把那个页面留在前台让用户登录；其余失败关页、保留旧批次并报真因。
代价：接口或鉴权头一旦改版就会失效，只能靠探针报 `http-error` / `no-quota`，届时更新 adapter。

**`background`（仍不做）** — 在 service worker 里带 cookie 裸调平台接口；SameSite 与凭据搬运问题不变。
`direct` 不属于这一档：它借的是页面自己的上下文，不是扩展后台的身份。

**`manual-only` / `unauthorized`（兜底，永远可用）** — 抓不通就手填。UI 上明确标注这条数据来自手动录入，
别让它冒充自动同步结果。

首次引导：某 agent 两条路都拿不到数据时，提示"请先在该浏览器里登录一次 xxx"——**cookie 不存在，扩展变不出登录态**，这是唯一必须你手动做一次的事。

抓取之后还有一段映射：截到的是原始 JSON，`adapters/<agent>.js` 负责从里面认出批次
（`{label, granted, remaining, expiry, semantics}`），再进 `normalizeBatch` → `mergeBatches`。
**这一层刻意不靠猜**：没拿到样本的平台不进 registry，「立即同步」如实回 `no-adapter`，
而不是编一个映射产出看起来像真数据的假批次。当前四家都已接入：Qoder 走页面内直读，
LobsterAI / TRAE 走跨域截获，WorkBuddy 走同源截获。WorkBuddy 的接口目前只覆盖免费/赠送包，见决策 23。

### 3.3 存储与导出

`chrome.storage.local` 存 `batches`、`agentConfig` 和候选 `captures`，是唯一事实来源。另提供 JSON 导出/导入（迁移、备份）和 `.ics` 导出（每个批次一个全天事件，提前一天提醒），用 `chrome.downloads` 落盘。`.ics` 建议做进 M3，不挡主线。
**导出与导入都已实现（导入从 v0.3.16 起）**：导入走 `N.importSnapshot` 白名单清洗，按 `dedupKey`
补缺合并（同键以现有数据为准），不恢复 `agents` 配置；「清空本机数据」是两段式确认，
清空前建议先「导出全部数据」。

`.ics` 到底是什么：iCalendar 是系统日历（日历 App / Outlook / Google Calendar）通用的一种文本格式，
每个批次导成一条"全天事件"，标题写「Qoder 10月包 4800 积分到期」，并带一个提前一天的提醒。
导进去之后，提醒和多端同步是系统日历白送的，不用我们自己写通知。代价是一次性快照——
它不会随后续同步自动更新，没有后台订阅 URL；到期日改了要重新导一次。

样本只保留响应体的**前 200000 字节**并标 `truncated`，请求头一律只存名字、不存值。
被截断的样本不参与同步（`runSync` 直接报 `truncated`，让你点一次「刷新余额」重截），避免"批次数组在后半段没存下来"
被误读成"这个平台没有积分了"。

抓取实现约束：MV3 Service Worker 空闲约 30 秒即被回收，不能承载长时间驱动页面的操作。所以抓取一律设计成**短任务**——一次请求或一次后台 tab 抽取，秒级完成；不要指望它在 SW 里做多步点击流程。

## 4. 视图与交互

### 4.1 月历（主视图，纯事件点）

以月为单位，**批次只出现在 `expiresAt` 那一格**，标注形如「Qoder · 4800 credits 到期」，同格多 agent 分行列出，不做合并总数。跨月浏览 + "回到今天"。今日格子高亮。已过期的历史月份正常可回看。

因为日历不再表达"还有几天"，格子本身要有一个轻状态区分：`expiresAt` 在今天之后 = 计划中（正常色）；已过期 = 降饱和 + 该 agent 是否仍显示余额由总览区决定。避免你在日历上看到"到期"却分不清是将来还是已经没了。

### 4.2 即将到期 + 余额总览（与日历同屏，日历的必要补充）

顶部横向卡片区，每个 agent 一张：当前有效剩余合计、最近一笔的到期日与**倒计时天数**、`fetchMode` 标签、批次数量与数据新鲜度。卡片按"最快要过期"排序。

时间措辞**必须按取数档位区分**：`capture` / `hidden-tab` 写「取数于 X 前」，`manual-only` / `unauthorized` 写「手填于 X 前」——后者的时间戳是上次人工编辑的时间，写成"取数"会伪装成机器同步结果，属于诚实性问题。一笔都没有时不写「手填于 从未」，直接写「还没有数据」。若自动平台里有批次被人工改过，额外点出「N 笔含手动改动」。

卡片底部给一条**「已过期未用完」沉没成本**（按 agent 各自统计，不跨 agent 合并），点开可回看具体是哪几笔、各浪费了多少。用途有两个：判断哪些平台其实用不完、不该再加购；以及校准提醒阈值该往前挪几天。

下方一条「即将到期 Top N」清单（默认未来 14 天内到期，阈值可改），每条显示剩余量、到期日、还剩几天。这一区是"要不要赶紧用掉"的直接答案，也是本工具真正的日常价值所在。

### 4.3 批次明细与手动修正

选中批次可看来源、`capturedAt`、若有则显示「手动修改于」时间、原始 label、状态、batchId 与 dedupKey。**必须支持手动修正**：改过期日、改剩余量、删除错误批次、新增批次。抓取一定会出错，没有修正入口的工具活不下来。手动改过的批次打上 `manualEdited` 标记，下次同步时**手动修改优先于抓取结果**（冲突处理见 §7 决策 6）。

**删除走行内两段式确认**，不用原生 `confirm()`：第一次点击把按钮变成「确认删除这一笔？」并转为实心红，4 秒内不点第二次自动撤销。原生对话框在扩展页面里会阻塞交互、样式也不可控，且误删不可恢复时缺少缓冲。

补录的批次自动继承该 agent 的单位，并标 `source: manual`；若 dedupKey 与已有批次命中则拒绝新增并提示，避免手工造出重复。

### 4.4 同步入口

页面顶部：「立即同步」按钮 + 「数据截至 10-21 09:12」。任一 agent 同步失败只在它自己的卡片上标红并保留旧数据，绝不影响其他 agent。

## 5. 同步策略：手动为主 + 懒自动，不做定时

支撑这条策略的观察：**日历结构不需要每天更新**。真正改变日历的是"出现新批次"和"过期日变了"，一个月也就几次；`remaining` 会实时下降，但它只影响总览数字，不影响"哪天过期"。所以低频同步完全够。

- **立即同步**：永远保留的手动动作，你主动核对余额时点。
- **懒自动**：打开日历页时，若距上次成功同步超过设定时长（默认 3 天）就后台静默抓一轮。你不需要额外动作，也不会看到陈旧数据。
- **`chrome.alarms` 每日定时：不做。** 定时抓取最容易在平台改版后天天静默报错、攒一堆失败日志，而你并不会每天打开日历，收益不明显。

两条硬规则，任何路径都不得违反：抓取失败一律**保留旧数据**、只标"同步失败"，绝不写空数组把日历抹掉；UI **始终显示数据新鲜度**，超过 7 天给陈旧提示。一个静默给出错误到期日的工具比手动录入更危险。

扩展架构的已知约束：**扩展跑在浏览器进程里，Chrome 未启动时（含 `chrome.alarms`）不会执行任何抓取**。由于"你看日历时浏览器必然开着"，这条约束在懒同步策略下几乎不构成损失，可接受；若未来要求"关着浏览器也同步"，唯一出路是回到独立后台进程。

## 6. 里程碑

**M0 · 情报（半天，去风险）**
~~手写样例数据把日历跑通~~ **已完成**，见 §10 原型。~~判定每个平台落在哪一档~~ **已被授权截获取代**：现在不用预先判定档位，而是每个平台走一遍授权，截到的响应就是事实。剩下要做的是：你在 UI 里填入四个后台地址、各授权一次、点「导出捕获样本」把 JSON 给我。**这一步的产出（四份样本）决定 M1 的工作量，必须先做。**

**M1 · 单平台端到端（半天）**
挑样本最干净的平台（大概率 Qoder）写第一个 `adapters/qoder.js`：`extract(capture)` → 归一化 → dedupKey 合并 → storage → UI 刷新。adapter 契约、normalize、时间换算、手动优先的冲突规则**已在骨架里定型并有单测覆盖**，M1 只补字段映射这一层。

**M2 · 四平台补齐（半天）**
按 M1 定型的契约接其余三个。落在 `manual-only` 的平台明确标注，不硬撑。

**M3 · 体验打磨**
导入导出、`.ics` 导出、扩展图标红点提醒。倒计时、提醒阈值、编辑与删除交互、已过期沉没成本、授权面板与样本查看已在原型/骨架阶段完成并验证。

## 7. 决策记录

1. **按批次建模，不按余额**——四平台积分均为分批发放、各自独立到期。
2. **日历只标到期当天（纯事件点）**，不用"到期前 N 天重复标注"的状态窗口——按你第 3 轮的选择；相应地把倒计时与预警职责全部交给 §4.2 的总览区，该区从"可选"升级为"必要"。
3. **形态从「本地单页网页 + Node/Playwright」改为 Chrome MV3 扩展**——复用真实浏览器里的登录会话，免维护独立 profile，免首次登录到单独实例，且只剩一个交付物。（v3 注：当初顺带设想的"后台跨域抓取更省事"并不成立，见决策 4。）放弃的能力：浏览器关闭时同步、脱离浏览器的定时任务。
4. ~~**抓取分三档 `fetchMode`**（background / hidden-tab / manual-only）~~ **v3 修订：主路径改为「授权 + 截获页面自身响应」（`capture`），`hidden-tab` 复用同一套钩子做补抓，`background` 后台裸调不主动做。** 原因见 §3.2——扩展后台发的是跨站请求，SameSite cookie 不带，"复用登录态"这个前提本身不成立；而截获页面对自己发出的响应，鉴权完全交给页面，扩展不必碰凭据。放弃的能力：第一次必须由你打开页面并登录一次；纯服务端渲染的页面截不到，只能回落到 `manual-only`。
5. **同步 = 立即同步 + 打开页面时懒自动（默认 3 天阈值），不做每日定时。**
6. **手动修正优先于抓取结果**——同 dedupKey 批次若被人工改过，后续同步只更新 `remaining` 以外的抓取元信息，过期日不覆盖，并在 UI 提示"该批次有手动改动"。
7. **时间措辞按 `fetchMode` 区分**（取数于 / 手填于），手动改动笔数显式点出——避免手填数据冒充机器同步结果。原型已实现。
8. **删除采用行内两段式确认**，弃用原生 `confirm()`。原型已实现。
9. **卡片增加「已过期未用完」按 agent 统计**——日历上的灰删除线只表达"过期了"，不回答"损失了多少"，而后者才是"该不该再加购、提醒阈值往前挪几天"的依据。原型已实现。
10. **冻结批次额外按 `(agent, label)` 兜底匹配**（不含 `expiresAt`）——用户手改的经常就是过期日，若仍只按 dedupKey 匹配，下次同步会把它当新批次再加一遍，页面上出现两笔同名、到期日不同的钱。骨架已实现并有单测。
11. **"这次没返回"只在本次同步覆盖到的 agent 内部计算**；`incoming` 为空视为抓取失败，什么都不记。「抓不到」和「没有了」必须区分开，否则只同步 Qoder 一次就会把 TRAE 的批次计数刷脏。骨架已实现并有单测。
12. **字段映射（adapter）不靠猜**：四个平台样本到手之前 `adapters/` registry 为空，「立即同步」如实回 `no-adapter`。理由同决策 7——编出来的映射产出的假批次跟真抓的在 UI 上无法区分，错了没人发现。
13. **截获的样本只存请求头名字、不存值；响应体截到 200000 字节并标 `truncated`**；被截断的样本不参与同步。这样"扩展不碰凭据"是代码层面的事实，不是承诺。上限从 60KB 提到 200KB 是 v0.3.9 的决定：WorkBuddy 的真实明细约 130KB，60KB 会截在 `Accounts` 数组中间，导致每次刷新都报 truncated（见决策 23 的 v0.3.9 注记）。
14. ~~**`host_permissions` 出厂为空**，只在你对某个平台点授权时申请那一个域名~~ **v3.1 修订：Qoder 的 `https://qoder.com/*` 写进 `host_permissions`（装载时授予），其余三家仍走运行时申请。** ~~其余三家仍走运行时申请~~ **v3.2 再修订：四家全部写进 `host_permissions`。** 原因：真机装载后点「授权」，`chrome.permissions.request` 直接回 `false` 且不报错——`optional_permissions` 的运行时弹窗在这台 Opera（135 / Chromium 151）上没弹出来（这是 Chromium 侧的已知问题类型，不是我们的调用姿势错：调用发生在点击手势里、请求的域名是 `optional_permissions: ["https://*/*"]` 的子集，Chrome 文档明确允许请求子集）。v3.2 的触发点：四家后台地址都已由用户本人提供，装载时一次授予四个已知域名的代价，小于再赌三次运行时弹窗。放弃的能力：装载时不再是零域名权限，Opera 会在载入未打包扩展时给一次列出四个站点的访问警告。保留的边界：只写用户实际给过的域名，不写 `<all_urls>`；运行时申请这条路留着（含完整报错与自检页），将来粘贴 manifest 里没有的新域名时仍走它。
15. **授权失败必须报出真实原因，不许只说"没授予权限"。** 三种病因（浏览器没弹窗 / 你点了拒绝 / 权限其实已经有了）解法完全不同，所以：回调里读 `chrome.runtime.lastError` 并写进该 agent 的 `lastError` 显示在面板上；先 `permissions.contains` 再 `request`（已有权限时重复请求反而会被静默拒）；面板提供「权限自检」页，直接把 `permissions.getAll()`、逐域名 `contains()`、manifest 里的两项权限声明和 userAgent 摊开，让人一眼看出是哪一种。**v3.2 注：这套自检第一次真机使用就立功了**——它证明权限其实已授予，真病因是注入注册被拒（见决策 16 之下的实现注记）。
16. **四家后台地址预置为 `consoleUrl` 默认值**（用户 2026-10-21 提供：qoder.com/account/usage、www.trae.cn/dashboard、www.workbuddy.cn/profile/plans-usage、lobsterai.youdao.com/portal#/profile/detail）。推翻 v3「consoleUrl 一律留空」的口径：留空防的是"我编域名"，用户给过的地址不算编。`migrate` 里空串视同没填，旧文档里的空值会被默认值覆盖；用户改成别的地址仍以存储为准。LobsterAI 是 hash 路由（`#/profile/detail`），注入与权限都按 origin 匹配，不受影响；额度接口在 `lobsterai-server.youdao.com`，与 portal 不同源，这个域名不申请权限，详见决策 20。

**实现注记（v0.2.1，真机报错换来的）**：`chrome.scripting.registerContentScripts` 的字段是 camelCase（`runAt` / `allFrames`），与 manifest `content_scripts` 的 snake_case 不是一套名字；传错不警告而是整个调用被拒（`Unexpected property: 'run_at'`），表现是"授权成功但注入静默失败"。降级重试的 catch 也改成只在错误确与 `world` 相关时才降级，否则原样抛出，避免真病因被"重试也失败"盖掉。

**实现注记（v0.2.2，第二轮真机报错）**：`register()` 必须幂等——重复点「授权」或「重新截获」时同 ID 脚本已注册，`registerContentScripts` 对重复 ID 直接拒（`Duplicate script ID`）。改为先 `unregisterContentScripts` 再注册。这一轮同时确认了主路径是通的：Qoder 首次授权即截到 1 条样本、fetchMode 升为 `capture`，红字只来自第二次点击。

**实现注记（v0.2.3，站点异常事件）**：Opera 上 qoder.com 登录态异常消失（换浏览器正常）。审计注入层：响应用 `clone()` 读、不消耗页面 body，钩子不碰 cookie 与请求头值；最可疑的是站点反爬（`bx-v` 头、`isg`/`tfstk` 等阿里系标记）检测到 `window.fetch` 被包装后由服务端作废会话。对策三件：包装函数 `toString` 返回原生签名（只覆盖 `fetch.toString()` 这一层，`Function.prototype.toString.call` 那条路不堵——堵它要改 `Function.prototype.toString` 本身，侵入太大）；跳过 `text/event-stream` 与 content-length > 2MB 的响应（`clone().text()` 缓冲整条流既吃内存又可能拖页面）；以及决策 17 的免钩子退路。

17. **粘贴样本与解除钩子是正式退路，不是临时补丁。** 触发条件有二：页面数字服务端渲染、根本不发 XHR（§9 最高风险的既定对策）；或站点反爬把被 hook 的 fetch 当异常（v0.2.3 事件）。粘贴入库走与自动截获**完全相同**的打分与脱敏（`sanitizeCapture`），`via: "paste"` 只用于来源标注；「解除钩子」把该域名的注入脚本注销，站点恢复未装扩展状态。放弃的能力：解除钩子后该平台不再自动截获，样本靠人贴或重新授权。保留的边界：粘贴只收响应体，不收 cookie 与请求头值。

**实现注记（v0.2.4，因果确认）**：解除钩子后 qoder.com 登录态恢复正常——**钩子在场就是触发条件**，v0.2.3 的反爬假设由相关性升级为已确认因果。因此 Qoder 的默认姿势定为「钩子解除 + 粘贴样本」，`重新授权`（常驻钩子）不再推荐用于该平台。

18. **同步的新鲜度必须显式说出来，"读到活数据"和"读的是上次的样本"不能长得一样。** 样本是快照：不重新截获，`立即同步` 永远在算同一份旧响应。活体读取的唯一合法姿势是**让页面自己再发一次请求**（隐藏标签页 + 钩子），扩展不代持凭据直接 `fetch`——那要读 cookie、要伪造 `x-csrf-token`、还要过反爬，既越了凭据边界也不稳。由此定三条：
    - **`hookActive` 是自动刷新的开关**，只有钩子确实注册着才允许同步前自动开隐藏页；解除钩子的平台**永不自动装回去**（那等于偷偷撤销用户刚做的决定），同步只读样本并在结果里标出来。
    - **临时钩子（`ephemeral`）只能由用户点「重新截获」触发**：注册 → 开隐藏页 → 等响应 → 关页 → 立刻注销，把在场时间压到一次页面加载。
    - **结果分三态并回传 UI**：`fresh === true`（页面刚回话，数字是活的）/ `false`（想刷但没等到响应，用的是 `sampleAt` 那份样本）/ `null`（没装钩子，只能是样本）。`waitForCapture` 同时区分 `changed`（内容变了、样本库多一条）与 `seen`（内容没变但页面确实回话了）——"额度没动"和"根本没读到"是两种结论，混成一个 false 会让人误以为数字是最新的。
    放弃的能力：后台主动定时抓取（决策见 §3.2）。保留的边界：扩展不接触 cookie / token / 密码，活体数据一律由页面自己请求。
    **v0.3.0 修订**：这条「唯一合法姿势」自此只描述钩子平台。Qoder 走 `direct`——请求仍由页面上下文发出，
    扩展不代持凭据；区别只是由页面里的扩展代码主动发一次已知接口的 GET，而不是等页面自己发（决策 19）。

**实现注记（v0.2.5，「重新截获后数字不刷新」）**：真机复现——点「重新截获」，qoder 后台页开了又关，但日历数字没动。两个独立病因：① **去重键用 `bodyLength`**，额度 `1873 → 1870` 位数没变、响应体长度一样，新数据被 `onCaptured` 误判成"重复样本"直接丢弃，样本永远停在旧值，UI 还回一句"内容和上次一样"。改为对整份 body 做双 rolling hash（`contentHash`，拼上长度前缀）逐字节比对，`sanitizeCapture` 落 `bodyHash`，老样本无此字段时退回按长度比。② **「重新截获」只截获、不重算日历**：拿到新样本后没跑 adapter + merge，批次数值不变，用户还得再点一次「立即同步」。改为 `REFRESH_CAPTURES` 在截获成功后顺手对该平台 `syncOne`，一步到位，并把 `新增/更新/待裁决` 回传 UI。这两条一起才是"数字刷新"的完整链路：截到新响应（不被误丢）→ 认字段 → 合并进批次。

**实现注记（v0.2.6，「重新截获」开页又关页但什么都没发生）**：用户已排除登录态问题（手动打开后台页能看到数字），说明失败点在"钩子有没有真的看到响应"这一段，而这一段此前**没有任何可观测性**——只能回一句"没返回候选"，等于让人瞎试。同时发现一个结构性疑点：唯一成功过一次的路径是「授权」，它开的是**可见**标签页；`refreshCaptures` 走的是隐藏页，这条路从没在真机验证过，而 SPA 在后台标签里可能被节流/冻结、压根不发额度请求。三件事：① **加刷新探针**，把五个可能断点分开计数（钩子心跳 / 页面响应总数 / 打分刷掉数 / 候选数 / 入库与判重数 / 每次开页的 visible、等待时长、tab.status、最终 url），写进 `agents[id].probe`，失败时 UI 直接给人话结论，「截获诊断」页展示完整记录。② **隐藏页失败自动改用可见页重试一次**（12s + 20s），可见页会抢一次焦点，代价可接受；两轮都失败时**把可见标签页留着不关**（钩子仍注销），让用户直接看到那页是登录态还是空页面。③ `onCaptured` 改为**先认平台再打分**，否则被打分刷掉的响应不进计数，就分不清"页面没发请求"和"发了但不像积分接口"。探针只在刷新窗口内计数，平时为 null。

19. **（v0.3.0）Qoder 改用同源页面内直读，撤销该平台的钩子方案。** 决策 18 之后，Qoder 的姿势是"钩子常驻解除 + 粘贴样本 / 临时钩子"；但那仍然要求用户反复手工贴响应，且临时钩子每次都有风险。既已确认钩子在场就是登录态失效的触发条件，正确做法不是把钩子藏得更短，而是这个平台**根本不再注入钩子**，同时把"读活数据"变成一次可控的页面内请求：
    - **为什么不是回到被否掉的 `background`**：后台请求是 third-party，SameSite cookie 不带、token 要自己搬。`direct` 在 `https://qoder.com` 页面上下文里执行 `fetch`，cookie 由浏览器按同源规则带上；CSRF token 只在页面函数内部读取并立即使用，**不经过扩展、不写入存储、不上报**。扩展没有拿到任何凭据，也仍然不做跨站后台调用。
    - **边界写死在 adapter 与流程里**：只接受 `GET`，URL/pageUrl 由 `adapters/qoder.js` 固定，不走用户输入；每次读取前先注销同域钩子（幂等），SW 启动、安装、升级时也各退役一次；UI 对 Qoder 只保留「刷新余额 / 看样本 / 粘贴样本」，没有授权或重装钩子的入口。
    - **失败语义**：401/403 或落到登录页 = 未登录，页面留在前台让用户登录，不写批次；其他失败关页、写 `lastError`、`syncOne` 继续用旧样本，绝不拿空结果覆盖日历。探针新增 `mode: "direct"`，记录接口、HTTP、字节数、开页尝试与最终结论。
    - **迁移必须强制**：旧文档里的 `capture + hookActive: true` 一律压回 `direct + false`，`origin/consoleUrl` 以代码配置为准；旧钩子的错误、心跳、探针清空，但已经进入 direct 的文档要保留真实读取错误与直读探针。否则升级后同步还会把那个会作废登录态的钩子装回去。
    放弃的能力：Qoder 接口改版时需要人工更新 adapter（`http-error` / `no-quota` 会直说）；直读仍可能被平台风控拒绝，但不再有"被包装过的 fetch"这个可检测特征。保留的边界：只读、同源、一次性、不存凭据；其余钩子平台没有"钩子会作废登录态"的证据，继续走截获——LobsterAI 与 TRAE 已按真实样本接入（决策 20/21），WorkBuddy 待样本。

**实现注记（v0.3.0，验证）**：`adapters/qoder.js` 增加 `direct` 配置（接口、页面、登录路径、CSRF、时区），`extract` 未改；`background.js` 增加直读流水线与 `retireQoderHook()`。在 Opera 135 里用本地 qoder 替身跑通端到端 40 条断言：默认 `direct`、未登录 401 保留登录页且不写批次、登录后直读 200 产出 3 个批次合计 1800、再同步不重复且 `lastSeenAt` 推进、页面里没有钩子标记、`getRegisteredContentScripts()` 为空。真实 qoder.com 的未登录冒烟也跑过：后台页被重定向到 `/users/sign-in`，页面内 token 可读，接口回 401 JSON，登录页被留在前台、`lastError` 写入、批次为 0。**真实登录态下的直读成功路径还需要你在自己的 Opera 里点一次「刷新余额」确认。**

20. **（v0.3.1）LobsterAI 走跨域截获：钩子挂在 portal，接口在另一子域，adapter 只认 `creditItems`。**
    真实响应（2026-10-22）里，页面 `lobsterai.youdao.com/portal#/profile/detail` 自己请求
    `lobsterai-server.youdao.com/api/user/profile-summary`。由此定下：
    - **平台归属按页面 origin，接口地址只记 `endpoint`**。钩子只注册 portal，`host_permissions` 不为 API 子域扩权；粘贴样本时直接带 `agentId`，不让 `lobsterai-server` 覆盖 `origin`——否则后续钩子会装到 API 域名（既没权限，也截不到页面请求）。
    - **批次只来自 `data.creditItems`**。`totalCreditsRemaining` 是合计，单独成批会翻倍；`creditsResetCampaign` 是活动状态，不是额度。缺 `expiresAt` 或 `creditsRemaining` 的项跳过；剩余为 0 仍保留（余额要能降到 0）。
    - **同名批次必须可区分**。十余笔「每日登录奖励」的 label 完全相同，而冻结批次的兜底匹配按 `(agent, label)`。标签追加最后可用日的 `MM-DD`（如「每日登录奖励 10-23」），既让明细可读，也保证冻结匹配不会串到另一笔。
    - **接口没有原始发放量**，`granted` 暂等于 `remaining`；「已用」在该平台不准确，这是有意的妥协，等接口补字段再改。
    - **秒级时间戳必须保留**。`expiresAt` 形如 `2026-10-24T10:30:05`，normalize 原来只解析到分钟，会丢掉秒；已改为保留秒/毫秒，最后可用日的判定不变（仍减一天）。
    - **样本选择必须按接口圈定（v0.3.2）**。portal 一次加载会请求 `plans` / `subscription` / `usage-conversations` 等十几个接口，启发式分数（11）反而比真正的 `profile-summary`（9）高；只按分数选，adapter 收到没有 `creditItems` 的样本就会报「没认出批次」。v0.3.2 起 `endpointHint` 真正参与流程：选样本先按提示圈定、再在圈内比分；`endpoint` 只允许命中提示的接口改写；样本超上限淘汰时也优先保护命中提示的样本。
    放弃的能力：接口只返回剩余量，无法还原已用；页面若改版不再请求该接口，截获会失败，只能回到粘贴样本或 manual-only。
    保留的边界：仍然只读、不在后台裸调、不接触 cookie/token；API 域名不申请 host 权限。

**实现注记（v0.3.1，验证）**：`adapters/lobsterai.js` + 24 条单测，用真实响应验证十余笔批次、合计约 2.4k、标签两两不同；本地双源替身（portal `:47841` / API `:47842`）跑 Opera 135 端到端 56 条断言，覆盖跨域归属、活体刷新、解除钩子、粘贴回退。这一轮修掉三个问题：① `closeQuietly()` 没返回 `chrome.tabs.remove()` 的 Promise，所有钩子平台截获成功后都会在收尾处抛 "undefined 没有 then"，表现成刷新失败（Qoder 直读不走这条链，所以 v0.3.0 未暴露）；② 粘贴跨域 API 样本时用 API URL 推断 origin，会把钩子目标改成 API 子域；③ `PASTE_CAPTURE` 的结果缺 `ok:true`，UI 的成功分支永远不触发。**真实 LobsterAI 账号的授权与活体读取仍需用户在本机确认。**

**实现注记（v0.3.2，验证）**：真机上 LobsterAI 已截到 11 条样本却报「adapter 没从这份样本里认出批次」。直接读扩展的 LevelDB 存储确认：样本里有 `plans` / `subscription` / `usage-conversations` / `credits-reset-campaign` 等 11 个接口，前几个分数 11，`profile-summary` 只有 9；旧 `pickCapture` 只按分数排序，于是把 `plans` 交给 adapter，`extract` 找不到 `creditItems`，只能报 no-rows。`endpointHint` 此前只是注释里的文档字段，没有任何代码使用。修复：`pickCapture` 先按 `endpointHint` 圈定（圈内再比分，圈外才回退全池）；LobsterAI 的提示收紧到 `/\/user\/profile-summary(?:[?#]|$)/i`（宽泛的 `credit` 会命中 `credits-reset-campaign`）；`storeCapture` 只允许命中提示的接口改写 `endpoint`，样本淘汰时命中提示的加 1000 分保护。用真机上已存的 17 条捕获复现了旧逻辑的 no-rows，修复后选中 `profile-summary`、认回十余个批次、合计约 2.4k。**无需重走授权：重载扩展后点一次「立即同步」即可算出已有样本；之后点「刷新余额」恢复活体刷新。**

**实现注记（v0.3.3，按钮文案统一）**：两个平台的主操作都改叫「刷新余额」，并放在主按钮位置。这只是**文案与呈现的统一，不改变取数实现**：Qoder 仍在页面内发一次只读 GET；LobsterAI 仍开 portal 页让页面自己请求、扩展旁听，钩子解除时临时装一次、截完即注销。「授权」保留原名，负责首次权限与登录；「解除钩子」只在 `hookActive` 为真时出现，避免刚解除后还摆一个无效按钮。截断样本、未登录、诊断标题等所有引用旧按钮名的人话文案同步改成「刷新余额」。

**实现注记（v0.3.4，维护入口改名）**：已授权状态下的「重新授权」改名为「保持实时同步」。这个名字直接描述用户能得到的后果：点击后会重新注册常驻钩子并打开可见的 portal 页，之后全局「立即同步」也会先抓活数据；日常只更新一次仍用「刷新余额」（临时钩子，截完即拆）。按钮保留 `title` 说明，避免“保持同步”被误解为后台定时任务。只改文案，不改 `REGISTER_AND_OPEN` 的权限申请、注入与打开页面流程。按钮从 4 个变 5 个后授权行会挤窄地址框，因此同一轮把行布局改为「名称 + 地址/提示」第一行、按钮第二行；窄窗只收窄名称列并让按钮自然换行，防止撑破模态框。

21. **（v0.3.5）TRAE 走跨域截获：钩子挂 dashboard，adapter 只认 `user_entitlement_pack_list`。**
    真实响应（2026-10-22）里，页面 `www.trae.cn/dashboard` 自己请求
    `api.trae.cn/trae/api/v2/pay/user_current_entitlement_list`。由此定下：
    - **归属与权限同 LobsterAI**：钩子只注册 dashboard，`host_permissions` 不为 `api.trae.cn` 扩权；
      `origin` 记页面，`endpoint` 记 API。粘贴样本直接带 `agentId`，不让 API 域名覆盖页面 origin。
    - **批次只来自 `user_entitlement_pack_list`**。`usage_summary` 是全部包的合计，
      单独成批会翻倍；没有 `credits_limit` 的免费包跳过；缺到期日的跳过；剩余为 0 的保留。
    - **剩余量必须算**：接口只给 `credits_limit` 与 `usage.credits_amount`，
      `remaining = limit - used`（负数夹到 0），不能把 `credits_limit` 当余额。
    - **秒级时间戳**：`expire_time` / `end_time` 是 epoch 秒，换算后按最后可用日减一天；
      原始清零时刻存 `resetInstant`。
    - **同名签到包靠日期后缀区分**：十余笔「签到奖励」共享服务端 label，
      标签追加最后可用日 `MM-DD`，冻结批次的 `(agent, label)` 兜底匹配才不会串。
    - **`endpointHint` 继续优先于分数**：dashboard 还会请求 `plans` / `user_entitlement_list`，
      启发式分数可能更高；选样本只在命中 `user_current_entitlement_list` 的接口里挑，
      `endpoint` 也只允许它改写。
    放弃的能力：接口只列包、不提供单笔消耗流水；页面若改版不再请求该接口，截获失效，只能粘贴样本。
    保留的边界：只读、页面自己请求、不接触 cookie/token，API 域名不申请权限。
    真实响应验证：十余笔有效包、剩余合计约 1.4k（其中若干笔为 0，另跳过免费包），
    映射后十余个批次、标签两两不同。

**实现注记（v0.3.5，验证）**：`adapters/trae.js` + 28 条单测（5 笔有效行、跳过免费/无到期日、零剩余保留、
秒级时刻减一天、同名标签追加日期、再同步不重复、401/500/no-rows/截断口径，以及 `plans` 与
`user_entitlement_list` 分数更高时仍按提示选中目标样本）。本地双源替身（dashboard `:47851` / API `:47852`）
跑 Opera 135 端到端 50 条断言，覆盖跨域归属、选样、活体刷新、幂等、UI 与解除钩子。
**真实 TRAE 账号的授权与活体读取仍需用户在本机确认。**

**实现注记（v0.3.6，真机 TRAE 页面打不开）**：用户点「授权」后，TRAE dashboard 停在空白壳、没有跳到登录页。
在 Opera 135 用真实 `www.trae.cn` 复现：不装钩子时页面正常 302 到
`/login?redirect_url=...`；装钩子后停在 `/dashboard`，PageError 为
`Cannot read properties of undefined (reading 'apply')`，栈顶是 `capture-main.js:138` 的
`XMLHttpRequest.setRequestHeader`。根因：钩子把 `XMLHttpRequest.setRequestHeader`（构造函数上不存在）
当成原生方法保存，得到 `undefined`，随后 `SRH.apply` 抛错；TRAE 的登录/重定向链路正好用 XHR 设置请求头，
所以整个跳转被打断。修复为读取 `XMLHttpRequest.prototype.setRequestHeader`。修复后同一真实页面在钩子在场时
与未装钩子一致地跳到登录页，无 pageerror。新增 `test/capture-main.test.cjs` 7 条 VM 回归，
TRAE 双源 E2E 增加「页面自带 XHR / setRequestHeader 不被包装打断」断言后共 53 条。
**真实登录态下的授权与活体读取仍需用户确认。**

22. **（v0.3.7）授权是「一段会话」，截到目标接口就自动收尾，不再让用户猜下一步。**
    真机反馈：点「授权」后扩展到后台页，登录完就没有下文了——面板还停在授权按钮，
    用户不知道要不要再点「刷新余额」。根因不是页面打不开，而是流程缺收尾：
    `REGISTER_AND_OPEN` 只注册钩子并开页，截到响应只存样本；授权面板在打开期间也不响应
    storage 变化，看不到任何进展。
    - **等待状态持久化**：`authPending = { startedAt, tabId }` 写进每个 agent 的存储，
      MV3 service worker 被回收也不丢；窗口 10 分钟（`AUTH_PENDING_MS`）。
    - **自动收尾的条件**：样本不是粘贴、有分数、命中 adapter 的 `endpointHint`、HTTP 2xx。
      满足后后台直接 `syncOne`，成功后清 `authPending`、写 `authResult`（新增/更新/冲突/总数/接口），
      UI 显示「日历已写入 N 个批次」。2xx 分支用 `authSyncing[agentId]` 互斥，避免连续响应并发读改写。
    - **失败不急着结束等待**：401/403 只提示「登录后会自动继续」并保留 pending，
      登录后的下一次响应会再次触发；超过 10 分钟才清 pending 并标注超时。
      非目标接口、非 2xx 的噪声响应一律不触发，避免逛后台顺手改日历。
    - **没有 adapter 的平台**明确提示「已截到样本，但还没有字段映射」，
      清掉等待但保留样本（v0.3.7 时 WorkBuddy 是这种情况，v0.3.8 已补上映射）；
      有 adapter 但算出 0 批时保留 pending 并给出原因。
    - **UI 闭环**：授权面板显示「等待授权中（还剩约 N 分钟）/ 超时 / 最近一次授权完成/未完成」，
      总览卡片在等待期间显示「授权中」，按钮变「重新打开页面」；打开页面的回调不再
      用旧 doc 覆写后台刚写入的 `authPending`，而是重新 `Store.load()`。
    - **解除钩子即取消等待**：`UNREGISTER` 清 `authPending`，面板不会继续挂着「等待登录」。
    放弃的能力：等待窗口外的响应不会再自动同步——这是故意的，实时更新仍可手动点「刷新余额」。
    **真实 TRAE / LobsterAI 账号的自动收尾仍需用户在本机登录后确认一次。**

23. **（v0.3.8）WorkBuddy 接免费/赠送包接口：逐包成批，同名同到期日靠稳定短码区分。**
    用户提供的真实响应（2026-10-22）确认页面会请求
    `https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages`，返回
    `{code, msg, data:{TotalCount, Accounts:[...]}}`，共 40 余笔免费/赠送包。由此定下：
    - **批次只来自 `data.Accounts`**。`TotalCount` 是条数不是额度，不读任何合计字段。
    - **金额只用 `CycleCapacity*Precise`，回退到 `CycleCapacity*`**。样本里的
      `CapacitySize` / `CapacityRemain` / `CapacityUsed` 全为 0，拿来当余额会把 40 余笔全显示成 0。
      `Precise` 字段带小数（体验版剩余带小数），金额原样保留。
    - **到期只用 `CycleEndTime`**。`DeductionEndTime` 在体验版那笔落在 2035 年，
      `ExpiredTime` 全空；按清零时刻减一天得到最后可用日。
    - **不按 `Status` 过滤**：40 余笔全是 0，没有枚举定义；零剩余保留，余额要能降到 0。
    - **同名同到期日必须区分**：多数同名「CodeBuddy个人版国内运营裂变包」，
      多笔同一天到期，只加日期后缀仍会撞 dedupKey。label 末尾追加由 `ResourceId`
      派生的 8 位稳定短码（FNV-1a + 位混淆）；不保存 `ResourceId` 原文，
      `AccountAttributes`（含 payerUin）完全不读、不落盘。
    - **只覆盖免费/赠送包**：接口名与样本都表明不含付费套餐。若控制台总余额更高，
      需要另补付费/订阅接口样本，不能拿免费包数字冒充总余额。
    放弃的能力：付费套餐（若有）暂时不在日历里；接口改版或不再被页面请求时只能粘贴样本。
    保留的边界：只读、页面自己请求、不接触 cookie/token；页面与接口同源，也不需要额外权限。

**实现注记（v0.3.8，验证）**：`adapters/workbuddy.js` + 38 条单测（脱敏骨架覆盖 8 笔有效包、
同名同日、零剩余、金额字段回退、空名称回退、401/403/500/code 非 0/无条目/截断，
以及高分干扰接口不挤掉目标）。真实响应当地重验：40 余笔、40 余个唯一标签、剩余合计约 5.8k、
发放合计约 6.1k。本地同源替身（`:47861`）跑 Opera 135 端到端 77 条断言，覆盖授权会话、
自动收尾、活体刷新、幂等、旧截断样本升级、UI 与解除钩子。**真实 WorkBuddy 账号的授权与活体读取仍需用户在本机确认。**

**实现注记（v0.3.9，真机「样本被截断」）**：v0.3.8 真机授权后，面板一直报
「样本被截断了，去授权面板点「刷新余额」再截一次」，刷新也无效。对照用户提供的原始响应：
free-packages 响应有 **约 130KB**，而 `sanitizeCapture` 的默认上限仍是 60,000 字节，
于是每次捕获都在 `Accounts` 数组中间被截断并标 `truncated`；`runSync` 按既定规则拒绝
截断样本，所以无论刷新多少次都算不出批次。修复：脱敏上限从 60KB 提到 200KB，与
`capture-main` 的上限对齐；`capture-main` 对超过 200KB 的响应显式带上 `truncated`，
不再静默切片；Qoder 直读的上限也统一为 200KB。真实响应现在能完整存下，40 余笔全部可解析。
同时 `pickCapture` 改为优先完整样本：升级前存下的旧样本可能分数更高，
但它一定跑不出批次，不能继续挡住新截到的完整响应。
还有两处必须同时修，否则用户现有的截断样本升不上来：
1. 重复样本不再直接丢弃，而是按 `bodyHash` 原位替换。旧样本的 hash 是整份响应算的，
   刷新拿到同样内容时会撞上；若按旧逻辑判重 return，截断样本就永远修不好。
   替换不增加条目数，刷新仍如实报告「内容没变」，但样本本身已经完整。
2. `waitForCapture` 对已知接口只认 `endpointHint` 匹配的目标响应。页面并发请求
   `plans` / `usage` 时，干扰接口先回来会推进 `lastSeenAt`；旧逻辑据此立刻关页，
   130KB 的目标响应还没到。现在目标接口单独记 `lastTargetAt`（已纳入 migrate），
   干扰响应不会让刷新提前收工。
回归：`workbuddy` 单测增加 130KB 完整链路、>200KB 拒绝、完整样本压过高分截断样本，
共 44 条；本地 WorkBuddy 替身响应撑到 >60KB，E2E 增加「130KB 目标响应没有被截断」、
「旧截断样本在原位被升级」与「干扰接口先回也不提前关页」，共 77 条。

24. **（v0.3.14）WorkBuddy：钩子两轮都等不到目标接口时，改为在同一个页面上下文里代发一次只读请求。**
    真机探针（2026-10-22 17:12）给出决定性证据：`hookAt`/`relayAt` 都在、`worldAware:true`、
    两次开页 `tabStatus:complete` 且 `tabUrl` 就是 `profile/plans-usage`，但 `responses:8`
    全是 `galileotelemetry.tencent.com` 埋点、`candidates:0`、`targetSeen:false`——
    **页面一次额度接口都没请求**，不是钩子、不是选样、也不是登录 401。前端 bundle
    佐证：套餐数据由 `getCurrentPlan()` → `ru()` 触发，被登录态 `a?.uid` 与页面分区状态
    挡在前面；`refreshPaidPlan()` 走的是 `lightweight:true` 分支，那个分支**故意不含**
    free-packages。扩展没有任何办法让 SPA 重新取数。
    - **只在失败路径上加，不动成功路径**：仍然是「注册钩子 → 隐藏页 12s → 可见页 20s」，
      两轮都没 `seen` 时才调用 `adapter.readFallback`，在**已经打开的那个标签页**里用
      `chrome.scripting.executeScript({world:"MAIN"})` 发一次请求；成功即入库 + `syncOne`，
      标签页顺手关掉。页面自己会请求的场合完全不受影响。
    - **请求参数逐字来自站点前端 bundle**（`assets.workbuddy.cn/.../config-PxOBnci5.js`：
      `ys = e => _.post("/billing/meter/get-user-resource-free-packages", e)`；
      `index-YX--o6WY.js` 的 `getCnPlan`：`PageNumber:1, PageSize:200, Status:[0]`、
      今天 `00:00:00–23:59:59` 的时间切片、`PackageCodes` = freeMon + activity +
      versionBonus + compensation + newUserBonus；`X-Client-Platform: web` 来自其 axios
      拦截器）。**不猜字段**：body 里没有任何账号标识，`AccountAttributes` 依旧完全不读。
    - **边界不变**：请求仍由页面自己发（同源 + `credentials:"include"`），cookie 由浏览器带，
      扩展不读不存 token/cookie；只读、单次、URL 由 adapter 固定。
    - **失败语义**：401/403 直接说「这个页面没有登录态」并把页面留在前台；非 2xx / 非 JSON /
      没有额度字段一律如实报错，`probe.fallback` 落库供诊断页展示，绝不写空批次。
    - **诊断口径**：`lib/diagnose.js` 保留「目标接口根本没被请求」的原判，再把代发结果接在后面
      （「另外：扩展在这个页面里代发了一次…」/「另外：扩展代发也失败 —— …」），
      两段都说得出来，避免"页面明明发了请求"的误读。
    放弃的能力：站点如果改了接口或加了新签名，代发会以 HTTP 400/401 失败，需要重新取样本更新配方。
    回归：`workbuddy` +13 条（配方与请求体）、`diagnose` +5 条（代发措辞）、
    `e2e-refresh` 增场景 3（页面不发请求 → 代发兜底 → 批次写入），共 **380 条**。

25. **（v0.3.15）代发兜底这条链路不能再自己骗自己：回声不入账、入库要计数、结论按事实讲。**
    2026-10-22 17:29 那次真机刷新，面板上同时出现三句互相矛盾的话：标题「没读到（隐藏页和
    可见页都试过了）」、诊断「内容与已存样本逐字节相同 —— 数字确实没变」、以及样本列表里
    一条挂着「响应体被截断（共 66081 字节）」的旧样本。把扩展自己的 `chrome.storage.local`
    （Opera 的 `Local Extension Settings`，LevelDB）整份提出来对账，事实是：
    - 代发那条 **成功入库**（新样本 66105 字节，`via:"direct"`，`at` 与探针同一秒），
      `syncOne` 也跑了，日历里 **2 笔批次的 `capturedAt` 真的更新到 09:29**。刷新是成功的。
    - 探针却记成 `stored:0 / dups:1`。两个原因：`pageSend` 调 `storeCapture(…, null)`
      没带探针，真正入库的那次**不计数**；而代发请求走的就是页面的 `window.fetch`
      （正是被 `capture-main` 包过的那一个），立刻被自己的钩子又截了一次，
      那次「回声」反倒计入 `responses` 并撞成 `dups`。
    - 那条「被截断」的样本是 12:53 的旧记录（`bodyPreview` 只有 60013 字符）。
      它与 66105 的新响应**内容指纹不同**（时间切片变了），所以判重抓不到、两条并存；
      UI 只按分数排序，同为 9 分时旧的排前面，看上去就像是这次刷新出来的。
    - 标题那句只看 `outcome !== "both-failed"`，没看 `fallback.ok`，所以代发成功也写「没读到」。

    修法（都只在代发这条失败路径上，成功路径一个字没动）：
    - **回声不入账**：代发前把 URL 与时刻记进探针（`selfUrl` / `selfAt`），`onCaptured`
      在这个窗口（60s）内认出同一接口的响应就按 `self-echo` 丢掉，只累加 `echoes`，
      不碰 `responses` / `candidates` / `stored` / `dups`。
    - **入库要计数**：`pageSend` 把探针传进 `storeCapture`，代发那条的每一条新样本都算数。
    - **结论按事实讲**：`diagnose.of` 在「`both-failed` + 代发成功」时整段换口径——
      「页面自己一次额度接口都没发（那 N 个响应全是别的接口）；扩展在这个页面里代发了一次，
      HTTP 200，X 字节。存了 1 条新样本 —— 数字已更新。」/「…但响应内容和上次逐字节相同 ——
      余额确实没变。」；UI 标题同步改成「页面没发请求，代发读到了」。
    - **清掉被取代的截断样本**：完整响应入库时，同 `agent + url` 下的 `truncated` 样本一并删除
      （`probe.superseded` 记账）；升级/启动时也跑一次（`pruneShadowedTruncated`），
      老用户不必再点一次刷新才能看到干净面板。它们本来还白占 `MAX_CAPTURES` 的 60 个名额。
    - **字节数改成真字节**：`directFetchInPage` 用 `TextEncoder` 算 UTF-8 长度，
      不再拿字符串长度当字节数报（66081 字节 / 66051 字符的差额全是中文，两个数字对不上
      本身就会让人以为被截断）。
    回归：`diagnose` +6 条（代发成功的三种终态 + 老探针兼容）、`e2e-refresh` +2 个场景
    （回声不入账、完整响应清理旧截断样本）与场景 3 的 3 条计数断言，共 **397 条**。

26. **（v0.3.16）不可恢复的操作必须两段式确认，承诺了导入就要有导入；后台不要无缘无故写存储。**
    这一版没有新功能（导入除外），全部是第二轮 code review（`CODE_REVIEW_v0.3.15.md`）里
    「会直接影响信任」的几条：
    - **补录表单会被后台写入冲掉**：`retireQoderHook` 在 `background.js` 顶层、每次 SW 唤醒
      都跑，且无条件 `CreditStore.update()`（整份 load + set）。扩展页收到 `onChanged` 就
      `render()`，而 `renderAdd` 不设任何编辑标记 → 另一个标签页加载一次 workbuddy.cn
      （`RELAY_READY` 唤醒 SW）就足以让正在填的表单连同内容消失，无提示。
      修法：退役逻辑**先读后判**（已是目标状态就不写），补录表单加独立的 `adding` 守卫
      （语义与 `edit` 并列），`renderDetail()` 在 `adding` 时不动 `#detail`。
    - **诊断页自相矛盾**：`outcome:"error"`（流程本身崩了）被 `ok = p.outcome !== "both-failed"`
      判成成功 → 绿色标题「读到了页面响应」＋正文「刷新流程本身出错了」。标题口径收进
      `lib/diagnose.js` 的 `verdict(p) -> {ok, text}`，与正文同一份实现，UI 不再自己算。
    - **清空无确认、也没有导入**：需求 §3.3 把「导出/导入」当备份的唯一出路，导出做了、
      导入从来没做，于是「清空本机数据」之后无路可退。现在页脚有「导入备份（JSON）」，
      落库前过 `N.importSnapshot` 白名单清洗（只留白名单字段、认不出的条目丢掉并回报条数），
      再按 `dedupKey` 补缺合并（同键以现有数据为准，不覆盖）；清空复用行内两段式确认（5 秒窗口）。
      导入不恢复 `agents` 配置：授权是浏览器按域名给的，跨机器搬过来也用不了。
      另外发现 `renderFoot()` 此前**没有任何调用方** —— 页脚（含清空入口）其实一直没渲染过，
      这轮把它接进 `render()`，所以清空确认与导入是一起上线的。
    - **同一平台并发刷新踩坏状态机**：第二次 `beginProbe` 覆盖第一次的探针，两次 `endProbe`
      互相删记录；`ephemeral` 路径下先结束的那次 `unregister()` 拆掉另一次的钩子，却把
      `hookActive` 写成 `true`，之后 `syncAll` 每次都在没有钩子的页面上白等 32 秒。
      修法：`refreshing[agentId]` 互斥，第二次直接回 `{ok:false, busy:true}`；UI 侧刷新期间
      disable 按钮（失败分支也要复原，否则按钮永远停在「刷新中…」）。
    - **读路径也要钳制**：`threshold: NaN` 会一路活到渲染，`d <= NaN` 恒 false →
      「未来 14 天无积分到期」永久空白、下拉选中态也空掉，用户看不出异常。`migrate()` 现在
      统一夹 `threshold` / `staleDays` / `lazySyncDays`，让「读进来的东西一定合法」成为不变量。
    - **Qoder 的 `endpoint` 不再每次 load 被抹掉**：直读流水线与 `syncOne` 都写它，`migrate`
      却强制 `null`，成了只写字段、诊断页永远显示「未记录」。现在保留；只有「从钩子迁到直读」
      那一次清掉（记的是已废掉的路径）。
    - **`web_accessible_resources.matches` 从 `https://*/*` 收敛到四个已知 origin**：
      上一轮不敢动的是 `use_dynamic_url`（怕影响 MAIN world 注入），收敛 `matches` 不碰注入路径。
    - 其余 P3：`MAX_CAPTURES` 淘汰不再可能淘汰刚入库的那条（探针 `stored+1` 与库不一致）、
      `applyManualEdit` 校验并 trim 名称（空名会让 `dedupKey` 变成 `qoder||2026-11-01`）、
      同名冻结批次改成队列匹配（原来只留最后一个，另一笔 `absentCount` 无上限增长）、
      `batchId` 后缀定长 8 位 hex、样本列表同分时按 `at` 降序（与 `pickCapture` 对齐）、
      分块传输按 content-type 挡掉二进制响应。
    回归：`diagnose` +8（标题口径）、`normalize` +20（编辑校验/同名队列/batchId 长度/导入清洗）、
    `integration` +9（读路径钳制与 endpoint 保留）、`e2e-refresh` +8（启动零写入、并发互斥）、
    新增 `ui.test.cjs` +19（用 DOM 桩钉住页脚渲染、清空两段式确认、导入合并与坏文件不清空文档），
    共 **464 条**。
    没做：`waitForCapture` 的 2 秒兜底仍会全量 `load()`（建议改成只轮询轻量 `capture-seq` key）。
    它是 v0.3.11 为可靠性加回来的路径，动它要先证明「事件不可靠时兜底仍生效」，收益（每 2 秒一次
    反序列化）小于风险，留作后续。

## 8. 需要你提供 / 待确认

**已确认（v3 落实进代码）**：四个平台的单位都是 credits（但依然不跨 agent 合并，见 §2）；日常浏览器是 Opera，按 Chrome MV3 扩展装载（`opera://extensions` → 开发者模式 → 载入已解包的扩展）。

**四家的映射都已接入，不再缺基础响应样本。** Qoder 直读（v0.3.0）、LobsterAI（v0.3.1）、
TRAE（v0.3.5）、WorkBuddy 免费/赠送包（v0.3.8）都照真实响应写过映射。现在只剩两件事：

1. **真机确认**：在你的 Opera 登录态下，Qoder / WorkBuddy 各点一次「刷新余额」
   （WorkBuddy 已授权过，这次会把旧的 60KB 截断样本原位换成完整响应）；
   LobsterAI / TRAE 若还没授权，各点一次「授权」，在打开的页面里登录并等面板显示
   「最近一次授权完成」（v0.3.7 起会自动写入日历，不用再点「刷新余额」）。
2. **WorkBuddy 付费/订阅接口（可能没有）**：`get-user-resource-free-packages` 只覆盖免费/赠送包。
   如果控制台总余额明显高于免费包合计约 5.8k，说明还有付费套餐走了别处；把那个接口的响应给我，
   我再补映射。截不到就点「粘贴样本」把响应体贴进来（或发 cURL，cookie/token 替换成 `REDACTED`）。
若某平台截不到任何候选（数据直接写在 HTML 里、或你更愿意走 cURL），**发 cURL 也行，但请把 cookie/token 的值替换成 `REDACTED`**——我需要的只是 URL、请求头名字和响应结构，不是你的凭据。cURL 只有请求头没有响应体，所以它是"截获失败时补充结构信息"的退路，不能替代响应体本身。

~~四个积分后台的 URL~~ 已收到（2026-10-21），并预置为 `consoleUrl` 默认值（决策 16）。面板里仍可改。

`.ics` 导出建议做进 M3（解释见 §3.3），不挡主线；MVP 里先不做也可，因为扩展页面本身就会显示倒计时。

## 9. 风险

**中高（WorkBuddy 免费包接口）：只覆盖免费/赠送包，且同名同到期日极多。**
真实响应已确认页面会请求 `get-user-resource-free-packages`（40 余笔），所以“页面不发 XHR”的
最高风险已消除。剩下的风险是覆盖范围与区分度：多数同名、多笔同一天到期，
标签靠 `ResourceId` 派生的 8 位短码保证 dedupKey 唯一；如果控制台总余额包含付费/订阅套餐，
当前 adapter 看不到那部分——不会算错，但会少。若页面改版不再请求该接口，截获失效，
只能粘贴样本或 manual-only。对策：金额只用 `Precise` 字段、到期只用 `CycleEndTime`、
不猜 `Status`；付费接口有样本再补分支；失败以 `no-capture` / `no-rows` 报出，不静默产假数据。
（Qoder 已不依赖这条：它走已知接口的页面内直读，见 §3.2 / 决策 19；LobsterAI、TRAE 与
WorkBuddy 均已用真实样本确认页面会请求额度接口，分别见决策 20 / 21 / 23。）

**中高（LobsterAI 跨域截获）：页面与接口不同源，且同名批次共享 label。** 钩子只能挂在 portal 上，接口域名不在权限里；如果站点改成由 service worker 或服务器渲染该数据，截获会失效。十余笔「每日登录奖励」label 相同，批次靠追加最后可用日区分，冻结匹配也依赖这个标签；若未来两笔的到期日相同，标签会再次撞车，届时要引入接口侧唯一种子。对策：跨域归属按页面 origin、接口只记 endpoint 已有单测与双源端到端；映射只认 `creditItems` 并跳过合计/活动字段；真实账号改版后失败会以 `no-capture` / `no-rows` 报出，不会静默产出假数据。

**中（TRAE 跨域截获）：dashboard 与 API 不同源，签到包同名且到期时刻是秒级 epoch。** 钩子只能挂在 `www.trae.cn`，`api.trae.cn` 不在权限里；若页面改由服务端渲染或换接口，截获会失效。`user_entitlement_pack_list` 里 十余笔「签到奖励」共享标签，映射靠追加最后可用日区分，冻结匹配也依赖它。对策：`usage_summary` 只作合计不单独成批，免费包与缺到期日跳过、零剩余保留；`endpointHint` 圈定 `user_current_entitlement_list`，避免被分数更高的 `plans` / `user_entitlement_list` 抢走；失败以 `no-capture` / `no-rows` 报出，不静默产假数据。**真实账号的授权与活体读取仍需在本机确认。**

**高（Qoder 直读）：接口与鉴权头的契约是写死的。** 平台改 URL、换 header 名、或把 token 从 `window.csrfToken` 挪走，直读就会以 `http-error` / `no-quota` / `page-error` 失败；不会静默产出假数据。风控也可能拒绝页面内的额外请求，但至少没有"fetch 被包装"这个特征。对策：失败保留旧批次、探针直说断点，按新样本更新 adapter。

**高：页面结构与会话不可控。** 平台改版会静默返回空数据或换字段名。对策：adapter 隔离（一家映射坏了不影响别家）、失败一律保留旧数据、UI 显示新鲜度、`absentCount` 只累加不删除、`manual-only` 兜底通道永远可用。

**中：MAIN world 注入被拒或时序不对。** `world: 'MAIN'` 需要 Chrome 111+；注入失败的表现是"授权后一条样本都没截到"。骨架里 `register()` 已经做了降级（拿不到 MAIN 就只注 ISOLATED 并如实告知），并且注入层会上报 `HOOK_READY` / `RELAY_READY` 两个心跳，UI 的空态据此区分三种病因（没注入 / 注入了但页面不发 XHR / 还没加载完）。**真机行为我这边环境验不了**，需要你装载后跑一次。

**中：手动与自动的覆盖冲突。** 规则已定（决策 6 + 10），骨架已实现并有单测；晚做才会积累脏数据。

**低：多浏览器不同步。** 数据在单一浏览器的 `chrome.storage.local` 里，换浏览器/换机器看不到。对策是 JSON 导出导入；若这变成真实痛点，说明需求里应该有一条云同步，届时再议。

**低：样本里含你自己的标识。** 响应体是平台返回给你看的额度数据，正常只含额度与日期；存储上限截到 200000 字节，请求头只留名字。若某家响应里确实带了敏感字段，导出前可以先只在「看样本」里看过内容再决定给不给。上限提高是因为 WorkBuddy 的真实明细约 130KB；样本仍只存在本机 `chrome.storage.local`，不上传。

## 10. 原型（v0.3）

`prototype/index.html` —— 单文件假数据原型，日期按打开当天动态生成。它只用于验证视图与规则，正式实现是扩展，存储从 localStorage 换成 `chrome.storage.local`，抓取层从零补齐。

v0.3 相比 v0.2 加了周日开头（第一列是「日」，周末两列降饱和），这也是 §4.1 的排版口径。

已按本文规则实现并逐条实测通过：日历纯事件点、单位不跨 agent 合并、按最近到期排序的 agent 卡片、即将到期清单与 7/14/30 天阈值、点格子看当日明细、点色条进编辑表单、手动改动后同步不覆盖其 `capturedAt`、补录批次继承单位并被 dedupKey 拦重复、行内两段式删除与 4 秒自动撤销、按档位区分的时间措辞、已过期未用完沉没成本清单。

排版不变式在 2026—2028 连续 24 个月成立：格子数恒为 7 的倍数、不出现整行都不在本月的尾行（修掉过一个 10 月渲染 36 格、末行挂孤立 11/2 的 bug）。

**尚未验证**：≥1080px 的两栏桌面布局只做了结构检查，没拿到截图确认观感，需要你把浏览器窗口拉宽后实际看一眼。`color-mix()` 已实测可用（Chrome 支持，色条与格子底色按 agent 正确着色），但它是 Chrome 111+ 才有的特性——若日后要支持 Firefox/Safari 需换成预计算的 rgba。

## 11. 扩展实现（v0.3.9，`extension/`）

装载方式与各文件职责见 `extension/README.md`。这一节只记「哪些规则已经落成代码并验过、哪些还是空的」，
避免下次回到项目时重新试探。

**已经能用的**：月历纯事件点、agent 卡片总览与倒计时、即将到期清单与 7/14/30 阈值、当日明细、
补录 / 修正 / 行内两段式删除、`manualEdited` 冻结与冲突裁决（「采用抓取值」）、按 agent 的已过期沉没成本、
按档位区分的时间措辞、授权面板（填地址 → 申请该域名权限 → 打开页面 → 看候选样本 → 导出样本）、
`file://` 预览模式（同一份 UI，数据落 localStorage，授权与抓取如实标为不可用）。
v0.3.0 起 Qoder 走页面内直读：只保留「刷新余额 / 看样本 / 粘贴样本」，不装钩子；
旧文档迁移时强制 `direct` 并清掉钩子状态；未登录会把登录页留在前台，其余失败保留旧批次。
v0.3.1 起 LobsterAI 有字段映射：授权截获一次后，同步会开隐藏 portal 页读活数据，
`creditItems` 逐项成批，标签带上最后可用日以区分十余笔同名奖励。
v0.3.2 修了多接口页面的选样错误：`endpointHint` 现在真正参与选样本、`endpoint` 改写与样本淘汰，
不再让高分但无关的 `plans` / `usage-conversations` 挤掉 `profile-summary`。

v0.3.3 把两家主操作统一成「刷新余额」：Qoder 直读、LobsterAI 临时或常驻钩子旁听，
按钮文案不再暴露实现差异；「解除钩子」只在钩子确实注册着时显示。
v0.3.4 把已授权后的维护入口「重新授权」改名为「保持实时同步」，
让“点了以后立即同步也会抓活数据”这件事从按钮上就能读出来。
v0.3.5 接入 TRAE：dashboard 与额度接口跨域，钩子仍只挂页面；`user_entitlement_pack_list`
逐包成批，`usage_summary` 只作合计；秒级到期时刻按最后可用日换算，同名签到包追加日期后缀。
v0.3.6 修掉钩子对 XHR 的包装错误：`setRequestHeader` 应从 `XMLHttpRequest.prototype` 取，
误取构造函数属性会让该函数变成 `undefined`，页面一设置请求头就抛 `undefined.apply`；
TRAE dashboard 的登录/重定向依赖 XHR，因而停在空白后台页。修复后真实 trae.cn 在未登录态
与未装钩子一致地跳登录页，并补了 XHR 回归。
v0.3.7 把授权补成一段有始有终的会话：点「授权」后持久化 `authPending`（10 分钟窗口），
截到 adapter 指定接口且 2xx 时自动 `syncOne`、写 `authResult`；面板和卡片实时显示
「等待授权中 / 授权中 / 最近一次授权完成」，401/403 保留等待，超时或解除钩子则取消。
打开页面的回调改为重读存储，不再用旧 doc 覆盖后台刚写入的等待状态。
v0.3.8 接入 WorkBuddy：`data.Accounts` 逐包成批，金额用 `CycleCapacity*Precise`
（回退 `CycleCapacity*`），到期用 `CycleEndTime`；多数同名包靠 `ResourceId` 派生的
8 位稳定短码区分，原 id 不落盘。该接口只覆盖免费/赠送包，付费套餐若存在需另一份样本。
v0.3.9 修掉 WorkBuddy 真机的样本截断：真实响应约 130KB，脱敏默认上限 60KB
会截在 `Accounts` 中间，刷新多少次都只能报 truncated；上限统一为 200KB，
超过 200KB 仍显式标记并拒绝同步。重复响应改为原位替换（旧截断样本可被完整响应升级），
刷新等待只认目标接口（`lastTargetAt`，已纳入 migrate），不会被先返回的干扰接口提前收工。

**规则层的单测**（`node test/*.test.cjs`，共 271 条断言全过）：
`normalize` 56 条 —— 过期语义（含 "resets on" 与 "valid until" 差一天的坑）、千分位字符串、dedupKey 稳定性、
合并六情形、样本脱敏（断言任何 header 的值都不出现在样本里）、内容指纹（等长不同值必须判为不同，v0.2.5 回归）、
v0.3.1 的秒/毫秒时间戳保留（`2026-10-24T10:30:05` 不能被截成 `10:30:00`）；
`integration` 61 条 —— store 默认值与 migrate、打分门槛、端到端五轮同步（重复同步不重复、用掉的量下降、
没返回的不删只记 absent、冻结批次不被覆盖且报冲突）、v0.2.4 的活体同步状态位
（`hookActive` / `lastSeenAt` / `lastTargetAt` 活过 migrate；老文档默认 `false` / `null`，脏字符串不当真值），v0.3.0
Qoder 迁移（旧 capture + hookActive 压回 direct + false、origin/页面用代码值、旧钩子错误与心跳清空、
direct 的真实错误与其余平台的错误不被误清），以及 v0.3.7 授权会话（`authPending.startedAt` 与
`authResult.total` 活过 migrate、缺省为 null、直读平台不保留授权状态）；
`adapters` 27 条 —— 契约校验、样本挑选（高分优先且跨平台隔离、`endpointHint` 命中优先于更高分、
圈内比分、无命中回退全池）、`runSync` 的四种失败口径
（`no-adapter` / `no-capture` / `truncated` / `adapter-threw`）、只同步一家不影响别家的缺席计数；
`qoder` 22 条 —— 真 adapter 对着脱敏骨架样本：三个分段取数、`total_quota` 并集不重复、
无到期日与零额度跳过、毫秒时刻减一天、再同步不冒重复，`direct` 配置的接口 / 页面 / 登录路径 /
GET / CSRF / 时区字段，以及直读样本优先于旧的粘贴样本；
`lobsterai` 26 条 —— 照真实响应造脱敏骨架：多笔逐项成批且合计约 2.4k、`totalCreditsRemaining`
不重复计入、`creditsResetCampaign` 跳过、缺到期日/剩余量跳过、零剩余保留、同名 label 追加
最后可用日后两两不同、秒级时刻减一天、再同步不冒重复、`code != 0` / 无条目 / 截断的真实报错口径，
以及 v0.3.2 的回归：混入分数更高的 `plans` / `usage-conversations` / `credits-reset-campaign` 样本时
仍选中 `profile-summary` 并认出 4 个批次；
`trae` 28 条 —— 照真实响应造脱敏骨架：只认 `user_entitlement_pack_list`、5 笔有效包、
剩余 = 额度 − 已用、免费包/缺到期日跳过、零剩余保留、秒级时刻减一天、同名签到标签追加日期后两两不同、
`usage_summary` 不单独成批、再同步不冒重复、401/500/no-rows/截断口径，
以及 `plans` / `user_entitlement_list` 分数更高时仍按 `endpointHint` 选中目标接口；
`workbuddy` 44 条 —— 照真实响应造脱敏骨架：8 笔有效包逐笔成批、金额只认 `CycleCapacity*Precise`
并验证普通字段回退、同名同日两笔标签不同、`ResourceId` 派生 8 位短码且不泄露原文/payerUin、
零剩余保留、零额度/缺到期日跳过、体验版小数、到期按最后可用日减一天、顺序变化标签稳定、
再同步不冒重复、401/403/500/code 非 0/无条目/截断口径，
以及分数更高的干扰接口不挤掉 `get-user-resource-free-packages`；
v0.3.9 截断回归：130KB 样本默认不截断并仍能认出 8 批，>200KB 仍标 truncated 且不参与同步，
分数更高的旧截断样本也不能挤掉完整样本；
`capture-main` 7 条 —— 用 VM 假 `XMLHttpRequest` 跑钩子：`open` / `setRequestHeader` / `send`
都必须正常转发，header 名字记录但不保存值，原型方法仍伪装成原生函数；
这是 v0.3.6 空白 dashboard 的回归（旧代码把 `setRequestHeader` 取成 `undefined`）。

**浏览器端到端（v0.3.9，Opera 135，本地同源替身）**：77 条断言全过——
页面在 `:47861`，同时请求 `plans` / `usage` 两个干扰接口与目标
`get-user-resource-free-packages`；替身响应被撑到约 130KB（真实响应约 130KB），
验证目标样本完整存下、`truncated` 为 false（v0.3.9 截断回归）；
再把库里的目标样本改回 60KB 截断态、目标接口重新放慢 3 秒，让干扰接口先返回：
刷新不会提前收工，旧样本被完整响应原位替换（条目数不变、`upgraded:1`），
7 个批次与 2835.55 不受影响；
授权前无钩子、页面 3 个请求成功、页面自带 XHR（含 `setRequestHeader`）成功；
授权后样本归到 workbuddy、origin 记页面、
`endpoint` 不被干扰接口改写；**授权会话**：点授权后进入「等待授权中」、卡片显示「授权中」，
目标接口延迟 3 秒仍能等到；截到后自动同步、清掉等待，`authResult.ok:true`、`total:7`，
面板显示「最近一次授权完成」；同步 `fresh:true` 产出 7 个批次合计 2835.55
（同名同日标签独立、短码稳定、零剩余保留、到期日按最后可用日）；再同步不重复、
`lastSeenAt` 推进、隐藏页关闭；UI 卡片显示 2,835.55 且「立即同步」按钮走通并复位；
解除钩子后注册脚本为空；授权面板按钮不撑出行宽；扩展页无 console error。

**浏览器端到端（v0.3.7，Opera 135，本地 qoder 替身）**：41 条断言全过——
默认直读且无钩子、授权面板只给「刷新余额」且不出现旧按钮名、未登录 401 保留并前置登录页、失败不写批次、
登录后页面内直读 200 并同步出 3 个批次合计 1800、卡片标「接口直读」、再同步不重复且 `lastSeenAt` 推进、
隐藏页成功读取后关闭、UI「立即同步」按钮也走通并复位、`getRegisteredContentScripts()` 为空、普通加载的页面没有 `__creditCaptureHooked` 标记、
扩展页无 console error。这是逻辑与时序的验证，不等于真实账号已验证（见下）。

**浏览器端到端（v0.3.7，Opera 135，本地双源替身）**：67 条断言全过——
在 v0.3.1 的场景上把替身页面改成**同时请求 3 个接口**：`plans` 与
`usage-conversations` 故意做得比 `profile-summary` 分更高。验证 portal 与 API 仍分属
`:47841` / `:47842`、跨域响应归到 lobsterai、目标样本一定被选中（哪怕不是最高分）、
`endpoint` 不被干扰接口改写、同步 `fresh:true` 产出 3 批合计 1150、同名奖励标签不同；
**授权会话**：点授权后 `authPending` 带 `startedAt`，面板显示「等待授权中」、卡片显示「授权中」，
截到目标接口后自动同步并清掉等待，`authResult.ok:true`、`total:3`，面板显示「最近一次授权完成」；
再同步不重复、`lastSeenAt` 推进、隐藏页关闭；UI 卡片与按钮；解除钩子后注册脚本为空；
用 API 域名粘贴不覆盖页面 origin、不自动装回钩子，同步 2 批且 `fresh:null`；
`profile-summary` 的重复响应只留一条；面板只显示「刷新余额」、不出现旧按钮名，
已授权后显示「保持实时同步」，钩子已解除时不显示「解除钩子」，五个按钮不撑出授权行；
扩展页无 console error。
这一轮同时修掉 `closeQuietly()` 未返回 Promise 的潜伏 bug（v0.3.1）与多接口选样错误（v0.3.2）。

**浏览器端到端（v0.3.7，Opera 135，本地双源替身）**：62 条断言全过——
dashboard 在 `:47851`、API 在 `:47852`；页面同时请求 `plans` / `user_entitlement_list` /
`user_current_entitlement_list`，前两者的启发式分数故意更高，另外还带一个设置自定义请求头的
XHR 探针。验证授权前无钩子、跨域请求成功、XHR 成功；授权后样本归到 trae、origin 仍是 dashboard、
`endpoint` 不被高分接口改写、**钩子在场时页面的 XHR 也不被包装打断**；
**授权会话**：点授权后进入「等待授权中」、卡片显示「授权中」，目标接口延迟 3 秒仍能等到；
截到后自动同步、清掉等待，`authResult.ok:true`、`total:4`，面板显示「最近一次授权完成」；
同步 `fresh:true` 从 5 个包里产出 4 个批次合计 369.5（免费包跳过、零剩余保留、同名签到标签不同、日期按最后可用日）；
再同步不重复、`lastSeenAt` 推进、隐藏页关闭；UI 卡片与「立即同步」按钮；解除钩子后注册脚本为空；
授权面板按钮不撑出行宽；扩展页无 console error。v0.3.5 的 50 条主流程断言、v0.3.6 的
3 条 XHR 回归（授权前后各一条 + 请求到达 API）与 v0.3.7 的 9 条授权会话断言全部通过。

**故意留空的**：WorkBuddy 的付费/订阅包接口（如果有，等样本，见 §8）；
`.ics` 导出（M3）；扩展图标；service worker 里的跨站 `fetch` 主动抓取（§3.2 已论证不做，`direct` 不属于这一档）。

**我验不了、需要你装载后跑的**：WorkBuddy 在**真实账号**下的授权 / 活体读取 / 自动收尾，
以及控制台是否还有免费包之外的付费/订阅接口；TRAE 在**真实账号**下的授权 / 活体读取；
Qoder 在**真实登录态**下的直读成功路径；LobsterAI 在**真实账号**下的授权与活体读取。
直读未登录分支、跨域截获、粘贴回退、整套 UI 与同步已在 Opera + 本地替身中对过，
但真实会话与站点风控只有你的浏览器里有。

**真机回环第一轮（2026-10-21，Opera 135 / Chromium 151）**：权限自检页首次真机使用即定位问题——
`host_permissions` 装载时授予这条路是通的（`contains()` 回已授予）；真病因是
`registerContentScripts` 字段名 snake_case 被拒（§7 实现注记），v0.2.1 修掉。
运行时弹窗不再挡主线：四家域名都走装载时授予，`optional_permissions` 运行时申请只服务于将来新粘的域名。

**真机回环第二轮（2026-10-21）**：Qoder 全链路打通——授权 → 截获 → 粘贴响应体 → `adapters/qoder.js`
按真实结构映射（三段 `quota_detail`、跳过 `total_quota` 并集、毫秒时刻减一天）→ 同步产出批次。
同一轮暴露站点兼容问题（钩子在场导致登录态失效，解除后恢复，见 §7 决策 17 之下的 v0.2.4 注记），
并由此产生决策 18：同步区分活体 / 刷新失败 / 未装钩子三态，临时钩子只由用户显式触发。

**真机回环第三轮（2026-10-21，v0.3.0）**：用户报告"Qoder 拿不到数据"，根因不再是字段映射，而是
Qoder 这条钩子路线本身与站点登录态互斥。撤销该平台的钩子，改为固定接口的页面内直读（决策 19）；
迁移、后台退役、UI、探针与测试同步改完。等用户在真实登录态下点一次「刷新余额」即可闭环。
