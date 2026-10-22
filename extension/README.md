# Agent 积分过期日历 — 扩展（v0.3.16）

Chrome MV3 扩展（Opera 直接兼容）。在月历上标出每家 AI Agent 哪一天有积分到期，
外加余额总览、批次明细和手动修正。需求与决策记录在仓库根的 `REQUIREMENTS.md`。

**现在的状态：v0.3.16，Qoder 页面内直读 + LobsterAI / TRAE 跨域截获、WorkBuddy 同源截获已接入。**

v0.3.16 是**只修边界、不加功能**的版本（补上导入除外）：

- **补录表单不再被后台写入冲掉**：service worker 每次唤醒都会跑一次 `retireQoderHook`，
  而它无条件整份 `set()` 存储，扩展页收到 `onChanged` 就重画——正在填的补录表单连同
  已输入内容一起消失，且没有任何提示。现在退役逻辑先读后判（已是目标状态就不写），
  UI 的补录表单也有了独立于 `edit` 的 `adding` 守卫。
- **诊断页不再自相矛盾**：`outcome:"error"`（流程本身崩了）以前仍被标绿写成
  「读到了页面响应」。标题口径收进 `lib/diagnose.js` 的 `verdict()`，与正文同一份。
- **补上导入 + 清空改两段式确认**：需求 §3.3 承诺的 JSON 导入一直没做，所以
  「清空本机数据」之后其实无路可退。现在页脚有「导入备份（JSON）」，落库前过
  `importSnapshot` 白名单清洗（坏文件不会把 doc 结构打烂），清空则复用行内两段式确认。
- **同一平台的并发刷新加互斥**：连点两次会覆盖探针、`ephemeral` 路径还会把另一轮
  的钩子拆掉却把 `hookActive` 写成 `true`，之后自动同步静默失效。
- 读路径钳制 `threshold` / `staleDays`（坏的 `NaN` 会让「即将到期」永久空白），
  Qoder 的 `endpoint` 不再每次 `load()` 被抹成 `null`；
  `web_accessible_resources.matches` 从全 `https://*` 收敛到四个已知域名。

v0.3.15 修「刷新余额」面板自己骗自己：代发兜底那条链路里，真正入库的那次
`storeCapture` 没带探针（计数丢失），而代发请求又被自己的钩子截了一遍记成「重复」，
于是诊断显示「0 条新样本 / 1 条内容相同 —— 数字确实没变」，实际日历已经更新了 2 笔；
标题还按 `outcome` 判成「没读到」。现在代发窗口内的同接口响应按回声丢弃、入库计数
归到代发那一次，标题与结论都按「页面没发、扩展代发、存了几条」来讲。同时清掉
被完整响应取代的旧截断样本（指纹不同、判重抓不到，只能一直挂着「响应体被截断」）。
v0.3.14 修 WorkBuddy「刷新余额」永远失败：真机探针显示页面加载完了（钩子心跳在、
8 个响应全是 `galileotelemetry` 埋点），但一次额度接口都没请求——目标接口
`targetSeen:false`。前端 bundle 里套餐数据由 `getCurrentPlan()` 触发，它被登录态
（uid）和页面分区状态挡着，扩展没法让 SPA 重新取数。现在两轮钩子都等不到时，
改为在**已经打开的那个页面上下文里**代发一次与站点完全一致的只读 POST
（URL / body / headers 逐字取自站点前端 bundle），成功即入库并同步；401/403 明确
说「这个页面没有登录态」，页面留前台让你登录。钩子成功路径完全不变。
v0.3.2 修了 LobsterAI 在多接口页面里选错样本的问题：portal 会同时请求 plans / subscription /
usage-conversations 等接口，它们比额度接口的启发式分数更高，旧逻辑选中后自然一条批次也认不出。
v0.3.3 统一了两家的主操作文案：Qoder 和 LobsterAI 都叫「刷新余额」，区别只在实现里——
Qoder 在页面内发一次只读请求，LobsterAI 开 portal 页让页面自己请求、扩展旁听。
v0.3.4 把已授权状态下的「重新授权」改名为「保持实时同步」：点它会重装常驻钩子并打开 portal 页，
之后全局「立即同步」也会先抓活数据；日常只想更新一次仍用「刷新余额」。同时把授权行改成
「地址一行、按钮一行」，按钮多了也只在窄窗内换行，不会把输入框和模态框一起撑破。
「授权」负责首次权限与登录，「解除钩子」只在钩子注册着时出现。
v0.3.5 接入 TRAE：portal `www.trae.cn` 与额度接口 `api.trae.cn` 跨域，扩展同样只在 portal
页面上旁听页面自己发出的响应；映射只认 `user_entitlement_pack_list`，按包逐笔成批。顶部
`usage_summary` 是合计，不单独成批。签到包常常同名，标签会追加最后可用日。
v0.3.6 修掉一个会打断目标页面的钩子 bug：`capture-main.js` 误把
`XMLHttpRequest.setRequestHeader` 当成原型方法，保存下来是 `undefined`，页面一调用
`setRequestHeader` 就抛 `undefined.apply`。TRAE dashboard 用 XHR 做登录/重定向，
所以在真实站点上表现为停在空白后台页。现在改为读 `XMLHttpRequest.prototype.setRequestHeader`，
并补了 XHR 回归；钩子在场的页面不再因包装而中断。
v0.3.7 补上授权流程的“下一步”：点「授权」打开后台页后，扩展会把这次授权记成一段等待会话
（持久化，10 分钟内有效）。你在页面里登录、页面请求额度接口后，只要截到 adapter 指定的接口且 HTTP 2xx，
扩展就自动跑一次同步、写入日历，不需要再回来点「刷新余额」。授权面板实时显示
「等待授权中（还剩约 N 分钟）→ 最近一次授权完成」，总览卡片显示「授权中」；
401/403 会提示登录后自动继续，10 分钟没等到则标记超时，不会在几天后逛后台时突然改日历。
Qoder 不再往 qoder.com 注入钩子——此前已确认钩子在场会让站点作废登录态。现在点「刷新余额」，
扩展开一个同源页面，在页面上下文里发一次只读的额度 GET，读完关页；cookie 由浏览器带上，
CSRF token 只活在页面里，扩展不读取也不保存。LobsterAI 的页面和额度接口分属两个子域，
扩展挂在 portal 页面上截获页面自己发出的跨域响应，再用真实样本写好的映射产出批次。
v0.3.8 接入 WorkBuddy：页面 `www.workbuddy.cn/profile/plans-usage` 自己请求
`/billing/meter/get-user-resource-free-packages`，适配器按 `data.Accounts` 逐笔成批。
这份接口只覆盖免费/赠送包（40 余笔，剩余合计约 5.8k）；如果控制台总余额里还包含
付费套餐，那部分需要另一个接口的样本。金额取 `CycleCapacity*Precise`，到期取 `CycleEndTime`；
同名同到期日太多，标签末尾追加由 `ResourceId` 派生的 8 位短码（不保存原 id）。
v0.3.9 修掉 WorkBuddy 在真机上的「样本被截断」：真实 free-packages 响应约 130KB，
旧默认上限 60KB 会截在 `Accounts` 数组中间，点多少次「刷新余额」都只能得到 truncated。
现在脱敏上限与 `capture-main` 的 200KB 对齐；超过 200KB 仍标记截断并拒绝同步。
选样本时优先完整样本；同内容的重复响应也不再直接丢弃，而是原位替换旧样本，
所以旧版留下的 60KB 截断样本会在下一次刷新时被完整响应升级，条目数不变。
刷新流程也只认 adapter 指定的目标接口：`plans` / `usage` 这类干扰接口先返回不会提前关页，
不会出现「干扰接口回来了、目标接口还没到就收工」。
升级后对 WorkBuddy 点一次「刷新余额」即可把旧截断样本换成完整响应。
没有写映射的平台仍会明确回 `no-adapter`，不会猜字段把假数据显示成真抓的。

v0.3.10 是**修 bug 的版本**，抓取行为与界面没有变化：

- **修掉一个会污染别家数据的信任边界问题**：被注入页面的脚本可以自己伪造一条捕获
  消息并塞进 `agentId`，而后台原来只要 entry 带了 `agentId` 就跳过 origin 归属判断——
  等于允许「workbuddy.cn 上的脚本往你的 Qoder 批次里写假到期日」。现在 `agentId`
  只有扩展自己的 UI（粘贴样本）能带，其余通道一律按消息来自哪个标签页认平台。
- **「看样本」不再把整份响应体铺进页面**：单条最大 200KB、最多 60 条，全量渲染会
  把扩展页卡死。现在默认只显示前 2000 字符，另有「展开响应体」和「导出这条」。
- 修 `contentHash` 的哈希精度（浮点乘法溢出 2^53 丢低位）。
- 修「手动改过的批次过期后 `status` 一直是 active」。
- 刷新等待从「每 500ms 全量反序列化整个文档」改成事件驱动（存储变更时浏览器直接
  把新文档递过来），只在开等前读一次。
- 探针诊断的口径合并成一份（`lib/diagnose.js`），后台与 UI 不会再说出两句不同的话。
- 钩子的中间状态改用 `WeakMap`，页面脚本枚举不到（可枚举属性本身就是"被 hook"的检测特征）。

## 目录

```
manifest.json          权限与入口（host_permissions 列用户给过的四个域名，装载时授予）
background.js          service worker：页面内直读（Qoder）、注册钩子（其余钩子平台）、收样本、执行同步
capture-main.js        注入到页面 MAIN world 的钩子，劫持页面自己发出的接口响应（LobsterAI / TRAE / WorkBuddy）
capture-relay.js       ISOLATED world 的中转，把样本转给 service worker
lib/normalize.js       领域规则：到期语义、dedupKey、抓取值与手填值的合并
lib/store.js           读写持久化（chrome.storage.local，file:// 下自动降级 localStorage）
lib/agents.js          四个平台的静态信息 + 「像不像积分接口」打分 + 样本归属判定（attributeAgent）
lib/diagnose.js        探针计数 -> 人话结论（background 与 UI 共用同一份口径）
adapters/index.js      字段映射层的契约与注册表
adapters/qoder.js      Qoder 的字段映射与直读配置（照 2026-10-21 真实响应写的，有单测）
adapters/lobsterai.js  LobsterAI 的 creditItems 映射（照 2026-10-22 真实响应写的，有单测）
adapters/trae.js       TRAE 的额度包映射（照 2026-10-22 真实响应写的，有单测）
adapters/workbuddy.js  WorkBuddy 的免费/赠送包映射 + 代发兜底配方（照真实响应与站点 bundle 写的，有单测）
ui/calendar.html|css|js  日历界面
test/*.test.cjs        node 单测，共 464 条断言（含 capture-main 的 XHR 回归、中继的
                       信任边界回归、探针诊断回归、130KB 截断样本升级回归、导入清洗回归，
                       以及 e2e-refresh 在 mock chrome 里跑通的整条刷新链路、
                       ui.test 用 DOM 桩钉住的页脚/清空确认/导入接线）
test/run-all.cjs       串起全部单测并汇总（npm test 用的就是它）
```

## 跑测试

不需要装任何依赖，也不需要构建：

```bash
cd extension
npm test                     # 等价于 node test/run-all.cjs
node test/normalize.test.cjs # 也可以只跑某一个文件
```

每个 `test/*.test.cjs` 都是自带断言计数的独立脚本（打印 `N passed, M failed`），
失败时进程非 0 退出，可以直接挂到 pre-commit 上。

> 别用 `node --test test/`：那个参数会把目录当模块去 require，直接 MODULE_NOT_FOUND。
> `node --test test/*.test.cjs` 能跑，但会把每个文件当成一个用例，吞掉各文件自己的
> 断言计数，看不出一共多少条。

加新平台时至少补两组：`adapters/<平台>.test.cjs`（照真实响应写字段映射断言）和
在 `integration.test.cjs` 里补一条"同步 A 平台不影响 B 平台批次"的隔离断言。

## 装进 Opera

1. 地址栏打开 `opera://extensions`
2. 打开右上角的 **Developer mode**
3. 点 **Load unpacked extension**，选中 `agent-balance/extension` 这个目录
4. 点工具栏图标即打开日历（数据存在本机 `chrome.storage.local`，不上传任何地方）

Chrome 同理，入口是 `chrome://extensions`。Edge 是 `edge://extensions`。

## 不想装扩展，先看界面

直接用浏览器打开 `ui/calendar.html`（file:// 即可）。顶部会写明当前是 **file:// 预览模式**：
手动录入、日历、总览、冲突裁决都能玩，授权与抓取不可用，数据落在 localStorage。

## Qoder：页面内直读（v0.3.0）

Qoder 不需要「授权」，也不会再装钩子。原因已经确认：钩子在场会让 qoder.com 作废登录态，
解除后恢复。v0.3.0 撤掉了这个平台的钩子路线，改成一次性的同源页面内读取。

点「授权与样本」，Qoder 那一行只有三件事：**刷新余额 / 看样本（或读取诊断）/ 粘贴样本**。

1. 点「刷新余额」→ 扩展在后台打开 `qoder.com/account/usage`（隐藏标签页）→
   用页面自己的上下文发一次 `GET /api/v2/me/usages/big_model_credits` → 存样本、顺手同步 → 关页。
2. 请求带的是同源 cookie 与页面里的 `window.csrfToken`；token 在页面函数里读取并立即使用，
   **不经过扩展、不写进存储**。扩展没有拿你的 cookie 或 token 去做别的事，也不会在后台裸调接口。
3. 如果没登录，接口回 401：这个页面会**留在前台**，你登录完再点一次「刷新余额」即可；
   其他失败会关页、在行内显示原因，并保留旧批次。
4. 地址框对 Qoder 是只读的——接口和取数页面由 adapter 固定，避免误改成任意地址。
5. 失败时点「读取诊断」：探针会列出接口、HTTP 状态、响应字节数、开页尝试和最终结论
   （未登录 / 页面内请求没发出去 / HTTP 错误 / 200 但没有额度字段），比一句"读取失败"更能定位。

直读失败不会清空日历：旧批次原样保留，只在 Qoder 行内显示上次错误。

旧版本装过 Qoder 钩子也没关系：装载 v0.3.0 或更新版本、浏览器启动、service worker 每次启动、
以及每次「刷新余额」之前，都会把 qoder.com 的动态注入脚本注销，并把存储里的
`hookActive` 压回 `false`。升级后建议刷新一次已经打开的 qoder.com 标签页。
「解除钩子」按钮对 Qoder 已不存在，因为没有钩子可解。

**粘贴样本仍然保留**：接口改版或直读被风控拒绝时，F12 → Network → 找到返回积分的请求 →
Copy response，只把响应体贴进去。入库走同一套打分与脱敏。

## LobsterAI：跨域接口截获（v0.3.1）

后台页是 `https://lobsterai.youdao.com/portal#/profile/detail`，额度接口却在另一个子域：
`https://lobsterai-server.youdao.com/api/user/profile-summary`。页面自己会带着 cookie 请求这份 JSON，
所以仍然走「授权 → 打开 portal → 钩子旁路截获」：钩子只挂在 portal 域名上，
`host_permissions` 里也不需要接口域名，截到的样本 URL 仍记录完整的 API 地址。

1. 「授权与样本」里确认 LobsterAI 地址，点「授权」→ 打开 portal 页；在里面登录后，
   截到 `profile-summary` 且接口 2xx，扩展会自动同步并写入日历（v0.3.7），面板从
   「等待授权中」变成「最近一次授权完成」
2. 点「刷新余额」→ 扩展开一个 portal 页，让页面自己重发请求，读到当下的数字；
   钩子已被解除时只在这一刻临时装一次，读完立刻注销
3. 「立即同步」只负责按已有样本算批次；钩子不在时不会产生新数据，并明确标 `fresh: null`

**为什么不会选错接口**：portal 一次加载会请求十几个接口，`plans` / `subscription` /
`usage-conversations` 的启发式分数（11）比真正的 `profile-summary`（9）还高。
v0.3.2 起，选样本先按 adapter 的 `endpointHint` 圈定接口、再在圈内比分；
`endpoint` 也只允许目标接口改写，面板不会再把别的接口当成额度接口。

**字段口径**（`adapters/lobsterai.js`，照 2026-10-22 的真实响应写）：

- 批次只来自 `data.creditItems` 的每一项：`creditsRemaining` 是剩余量，`expiresAt` 是清零时刻。
- `data.totalCreditsRemaining` 只是合计，不单独成批，否则会把同一笔钱算两遍。
- `data.creditsResetCampaign` 是活动元数据，不是额度，跳过。
- 十余笔「每日登录奖励」共用同一个服务端 label。批次标签会自动带上最后可用日的 `MM-DD`
  （如「每日登录奖励 10-23」），否则明细列表和手动冻结的兜底匹配都分不清是哪一笔。
- 接口只给剩余量、不给原始发放量，所以 `granted` 暂时等于 `remaining`；这一家的「已用」
  在界面上不具参考性，看剩余和到期日。
- `2026-10-24T10:30:05` 这种清零时刻按**最后可用日**显示为 10-23：
  10-23 全天可用，10-24 上午才清零，日历不该把它标在 10-24。

真实响应共十余笔、剩余合计约 2.4k，映射后也是十余个批次、标签两两不同。

**粘贴样本也支持跨域接口**：接口地址填 `lobsterai-server.youdao.com/api/user/profile-summary`，
扩展只把它记成 `endpoint`，页面 origin 仍是 portal——不会因此把钩子装到接口域名上，
也不会在粘贴后自动装钩子。

## TRAE：跨域接口截获（v0.3.5）

后台页是 `https://www.trae.cn/dashboard`，额度接口在另一个子域：
`https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list`。页面自己会带 cookie 请求这份 JSON，
所以和 LobsterAI 一样走「授权 → 打开 dashboard → 钩子旁路截获」：钩子只挂在 `www.trae.cn` 上，
`host_permissions` 里也没有 `api.trae.cn`，截到的样本 URL 仍记录完整的 API 地址。

1. 「授权与样本」里确认 TRAE 地址，点「授权」→ 打开 dashboard；在里面登录后，
   截到 `user_current_entitlement_list` 且接口 2xx，扩展会自动同步并写入日历（v0.3.7），
   面板从「等待授权中」变成「最近一次授权完成」，不用再点「刷新余额」
2. 点「刷新余额」→ 页面重新请求，数字更新；钩子已解除时只临时装一次，读完立刻注销
3. 「立即同步」按已有样本算批次；没装钩子时标 `fresh: null`，不会假装刚读过

**字段口径**（`adapters/trae.js`，照 2026-10-22 的真实响应写）：

- 批次只来自 `user_entitlement_pack_list` 的每个额度包。`usage_summary` 只是合计，
  不单独成批，否则会把同一笔钱算两遍。
- 剩余量 = `credits_limit - usage.credits_amount`（负数夹到 0）。没有 `credits_limit`
  的免费包跳过；缺到期日的跳过；**剩余为 0 的包保留**，否则余额降到 0 的过程会从日历上消失。
- `expire_time` / `end_time` 是**秒级** epoch。换算成清零时刻后按最后可用日显示（减一天），
  原始时刻另存 `resetInstant`。
- 十余笔「签到奖励」共用同一个服务端 label，批次标签会追加最后可用日的 `MM-DD`；
  冻结批次的兜底匹配按 `(agent, label)`，不加后缀会串到另一笔。
- 名称优先取 `display_desc`，其次 `group_name`，再退到套餐名。
- 不按 `status` / `is_hide` 过滤：接口会列出已用完的包，零剩余也要显示。

真实响应共十余笔有效包、剩余合计约 1.4k；其中若干笔剩余为 0，另有免费包因没有
`credits_limit` 被跳过。映射后是十余个批次，标签两两不同。

**接口提示优先**：dashboard 同时请求 `plans` 和 `user_entitlement_list`，启发式分数都可能高于
目标接口。`endpointHint` 圈定 `user_current_entitlement_list` 后只在该接口里选样本，
`endpoint` 也不会被高分但无关的接口改写。

## WorkBuddy：同源接口截获（v0.3.8 接入，v0.3.9 修截断）

后台页是 `https://www.workbuddy.cn/profile/plans-usage`，页面自己会请求
`https://www.workbuddy.cn/billing/meter/get-user-resource-free-packages`（同源）。
所以仍走「授权 → 打开页面 → 钩子旁路截获」，不会在 service worker 里拿你的 cookie 裸调接口。

1. 「授权与样本」里确认 WorkBuddy 地址，点「授权」→ 打开页面；登录后截到
   `get-user-resource-free-packages` 且接口 2xx，扩展会自动同步并写入日历（v0.3.7 起的授权会话），
   面板从「等待授权中」变成「最近一次授权完成」
2. 点「刷新余额」→ 页面重新请求，数字更新；钩子已解除时只临时装一次，读完立刻注销
3. 「立即同步」按已有样本算批次；没装钩子时标 `fresh: null`，不会假装刚读过

**字段口径**（`adapters/workbuddy.js`，照 2026-10-22 的真实响应写）：

- 批次只来自 `data.Accounts` 的每一项；`data.TotalCount` 是条数，不是额度。
- 余额与发放量取 `CycleCapacityRemainPrecise` / `CycleCapacitySizePrecise`，
  缺失时回退到不带 `Precise` 的 `CycleCapacity*`。样本里的
  `CapacitySize` / `CapacityRemain` / `CapacityUsed` 全是 0，**不能用**；
  `Precise` 字段带小数（体验版剩余带小数），金额原样保留。
- 到期时刻取 `CycleEndTime`（如某个具体清零时刻），按清零时刻减一天得到最后可用日。
  `DeductionEndTime` 在体验版那笔上落在 2035 年，不是这一轮的失效时刻；
  `ExpiredTime` 样本里全是空串，两者都不用。
- `Status` 样本里 40 余笔全是 0，没有枚举定义，不按它过滤；零剩余保留，
  否则余额降到 0 的过程会从日历上消失。
- 40 余笔里多数同名「CodeBuddy个人版国内运营裂变包」，多笔同一天到期。
  只加 `MM-DD` 后缀仍会撞 dedupKey，所以标签再带一个由 `ResourceId` 派生的
  8 位稳定短码（如 `… 11-08 · 1a2b3c4d`）。不保存 `ResourceId` 原文；
  `AccountAttributes` 里的 `payerUin` 等账号信息完全不读、不落盘。
- 免费/零额度/无到期日的项跳过；401/403 报登录态失效，`code != 0` 或其它非 2xx 报接口失败，
  不当成「没认出批次」。

真实响应共 40 余笔有效包、剩余合计约 5.8k、发放合计约 6.1k；
映射后 40 余个批次，标签、dedupKey、batchId 两两不同。

**这份接口的边界**：`get-user-resource-free-packages` 只列免费/赠送包（拉新、运营裂变、体验版），
不包含明显付费套餐。如果控制台总余额大于这里算出的约 5.8k，多出来的部分大概率来自另一个
付费/订阅接口——把那个接口的响应给我，我再补映射。当前实现不会拿免费包的数字冒充总余额。

**截获的退路：粘贴样本。** 页面数字若是服务端渲染进 HTML（不发 XHR），或站点反爬把被 hook 的
fetch 当异常，点该平台的「粘贴样本」：F12 → Network → 找到返回积分的请求 → Copy response，
只把响应体贴进来即可，入库走同一套打分与脱敏。对应的还有「解除钩子」按钮：把注入脚本从该域名
注销，站点恢复"没装扩展"的状态。

## 授权之后会发生什么（v0.3.7）

点「授权」不再只是“装钩子 + 开一个页面”。扩展会把这次授权记成一段**等待会话**，
并在你登录后自动把结果收尾：

1. 点「授权」→ 钩子注册、后台页打开，同时写入 `authPending`（带 `startedAt`）。
   它存在 `chrome.storage.local` 里，service worker 被回收也不会丢。
2. 授权面板显示「等待授权中（还剩约 N 分钟）」，总览卡片显示「授权中」，
   按钮变成「重新打开页面」。这 10 分钟就是留给你登录的窗口。
3. 页面自己请求额度接口后，只有同时满足**命中 adapter 的 `endpointHint`** 和
   **HTTP 2xx** 才会自动收尾：后台跑一次 `syncOne`，写入日历，面板显示
   「最近一次授权完成：日历已写入 N 个批次」。
4. 401/403 表示还没登录，扩展**不会**结束等待，只提示「登录后会自动继续」；
   登录后的下一次响应会再次触发收尾。
5. 超过 10 分钟没有成功：清掉等待并标注「等待授权超时」，之后你再逛后台截到响应
   也不会偷偷改日历——想看最新数据，重新点一次「授权」或「刷新余额」。
6. 如果某个平台还没有 adapter，扩展会明确区分「已截到样本」和「算不出批次」：
   样本照样保存，收尾提示“还没有字段映射”，不会假装写入了数据。当前四家都已接入映射。

自动收尾只由这一次授权触发一次；重复响应、相同内容不会反复写日历。
同一平台的 `syncOne` 还加了内存互斥，避免 2xx 响应连着来时并发读改写存储。

## 「立即同步」读的是什么时候的数据

**Qoder 是接口直读**：每次同步都会在页面里现读一次，提示写「接口直读」；读不到就保留旧数据并说原因，
不会拿空结果覆盖日历。未登录时会把登录页留在前台。

**钩子平台（TRAE / WorkBuddy / LobsterAI）**：钩子在时，同步会开一个隐藏的后台页，
让**页面自己**再发一次请求，扩展在旁边截新的；不会在 service worker 里拿你的 cookie 裸调接口。
钩子被解除时，同步只能算上次的样本。同步结果分三种，提示里会直说是哪一种：

| 提示 | 含义 | 怎么办 |
| --- | --- | --- |
| 活体读取：xxx | 钩子在，同步前开了隐藏页、页面刚重新请求过 | 数字就是当下的 |
| 刷新失败，用的是样本：xxx 10/21 14:03 | 想刷但没等到响应 | 后台页可能没登录，或用量接口没被触发；手动开一次该页再同步 |
| 这些平台没装钩子，读的是既有样本：xxx | 你解除过钩子 | 「粘贴样本」更新，或点「刷新余额」临时装一次钩子 |

「刷新余额」的行为取决于钩子状态：钩子在 → 常驻刷新；钩子已解除 → **临时钩子**，
注册 → 开隐藏页 → 等响应 → 关页 → 立刻注销，只在这几秒内在场，且只由你点按钮触发，
同步流程**永远不会**自动把解除掉的钩子装回去。授权面板每行会显示「钩子在（同步会实时读取）」
或「钩子已解除（同步只读样本）」，以及最新样本的时刻。

区分「内容没变」和「根本没读到」也很重要：页面回话了但响应和上次一样，提示是
"后台页有响应，但内容和上次一样（数字确实没变）"；第一轮 12 秒什么都没等到才会换可见页重试。

**「刷新余额」一步到位（该行为自 v0.2.5 起）**：截到新响应后会自动对该平台跑一次同步，日历数字直接更新，
不用再单独点「立即同步」；提示会说明"新增 X/更新 Y"。判断"这份响应是不是重复"用的是响应体
逐字节内容指纹，不是长度——额度从 `1873` 变成 `1870`、长度一样也会被正确识别为新数据。

**失败会自己说清断在哪一环（v0.2.6）**：每次刷新都带探针记录，失败时提示直接给人话结论，
「截获诊断」页展示完整记录（钩子心跳、页面响应数、候选数、入库/判重数、每次开页等了多久、
页面最终停在哪个 URL）。**先开隐藏标签页等 12 秒，等不到就自动改用可见标签页再等 20 秒**
（会抢一次焦点）；两轮都失败时，**那个可见标签页会留着不关**（钩子仍然注销），
你可以直接看到它是登录态还是被重定向到了登录页。

**隐私边界（代码层面已经做到的）**
- 文档中的真机笔数与合计均为近似值，不写入具体账户额度
- 鉴权由页面自己完成：扩展不接触密码、不生成任何凭据；Qoder 的 CSRF token 只在页面函数内读取并立即使用，
  扩展侧拿不到它的值，也不存 cookie
- 直读只发 adapter 固定的只读 GET，不接受任意 URL；其余平台只在页面旁路观察响应
- 样本里只保存请求头的**名字**，值一律不落盘（`sanitizeCapture` 只取 key）
- `host_permissions` 里只写你实际给过地址的域名（当前四家：qoder.com / www.trae.cn /
  www.workbuddy.cn / lobsterai.youdao.com），不是 `<all_urls>`；装载时一次授予，
  因为在 Opera 上实测运行时申请拿不到弹窗。将来粘新域名才走运行时申请那一路。
  LobsterAI 的接口在 `lobsterai-server.youdao.com`、TRAE 的接口在 `api.trae.cn`，
  这两个域名**都没有**申请权限——请求由页面自己发出，扩展只在页面上看响应
- 全程只读：不对任何平台做充值、扣减、下单等写操作
- 响应体只保留前 200000 字节并标 `truncated`，超长的样本不会整份存下来。
  这个上限是为了装下 WorkBuddy 约 130KB 的真实明细；超过上限的样本不参与同步

## 还没做 / 需要你补

| 项目 | 状态 |
| --- | --- |
| `adapters/qoder.js` + 页面内直读 | **已完成**（照真实响应写映射；22 条单测 + 41 条浏览器端到端） |
| `adapters/lobsterai.js` + 跨域截获 | **已完成**（照真实响应写映射；26 条单测 + 67 条浏览器端到端，真实账号待你点一次授权） |
| `adapters/trae.js` + 跨域截获 | **已完成**（照真实响应写映射；28 条单测 + 62 条浏览器端到端，真实账号待你点一次授权） |
| `adapters/workbuddy.js` + 同源截获 | **已完成**（免费/赠送包；44 条单测 + 77 条浏览器端到端，真实账号待你点一次授权） |
| WorkBuddy 付费/订阅包接口（如果控制台总余额高于免费包合计） | 待样本，有的话再补一个 adapter 分支 |
| `.ics` 导出（导进系统日历白拿提醒） | 计划 M3，还没动 |
| 图标、名称微调 | 还没做 |

## 我这边验过什么、没验什么

跑过：`node test/normalize.test.cjs`（56）、`node test/integration.test.cjs`（61）、
`node test/adapters.test.cjs`（27）、`node test/qoder.test.cjs`（22）、
`node test/lobsterai.test.cjs`（26）、`node test/trae.test.cjs`（28）、
`node test/capture-main.test.cjs`（7）、`node test/workbuddy.test.cjs`（44），
共 **271 条断言**全部 0 失败；
所有 JS 过 `node --check`；
浏览器端到端共 **247 条**（Qoder 41 / LobsterAI 67 / TRAE 62 / WorkBuddy 77），全部 0 失败；
`ui/calendar.html` 在 file:// 下逐条断言过渲染、补录、修正、行内二次确认删除、
冲突裁决（采用抓取值）、已过期未用完视图、导出按钮不抛异常、控制台无报错。

**LobsterAI 跨域截获的浏览器端到端**（Opera 135 + 本地双源替身：portal `:47841`、API `:47842`，
67 条断言）：授权前页面没有钩子、页面自身的跨域请求成功；portal 同时请求 3 个接口，
其中两个干扰接口的启发式分数（11）高于 `profile-summary`（9），但样本仍选中 `profile-summary`、
`endpoint` 也不被高分接口改写；授权后响应归到 lobsterai、样本 URL 是 API 域名而 agent origin 仍是 portal；
**授权会话**：点授权后进入「等待授权中」、卡片显示「授权中」，截到目标接口后自动同步、
清掉等待并显示「最近一次授权完成」，不需要再点同步；
同步 `fresh:true` 产出 3 个批次合计 1150，同名每日奖励标签不同、到期日按最后可用日换算；
再同步不重复、`lastSeenAt` 推进、隐藏页关闭；UI 卡片与「立即同步」按钮都走通；
解除钩子后注册脚本清空；用 API 域名粘贴样本不会覆盖页面 origin、不会自动装回钩子，
同步 2 个批次且 `fresh:null`；面板只显示「刷新余额」和「保持实时同步」、不再出现旧按钮名，
钩子已解除时不显示「解除钩子」；授权行的按钮不撑出行宽；无 console error。
这一轮还修掉一个影响所有钩子平台的潜伏 bug：`closeQuietly()` 没有返回
`chrome.tabs.remove()` 的 Promise，刷新链路在截获成功后接 `.then` 直接抛 `undefined`，
表现成"明明截到了却报刷新失败"。Qoder 直读不走这条链，v0.3.0 的端到端没暴露它。

v0.3.2 另外用真机上已经存下的 17 条捕获复现了本次故障：旧逻辑选中 `plans` 并报 no-rows；
修复后选中 `profile-summary`，认回十余个批次、合计约 2.4k。也就是说**不用重走授权**，
重载扩展后直接点一次「立即同步」就能把已有样本算出来；之后点「刷新余额」恢复活体刷新。

**TRAE 跨域截获的浏览器端到端**（Opera 135 + 本地双源替身：dashboard `:47851`、API `:47852`，
62 条断言）：授权前页面没有钩子、页面自身的跨域请求成功，**页面自带的 XHR（含
`setRequestHeader`）也成功到达 API**；dashboard 同时请求 3 个接口，
`plans` 与 `user_entitlement_list` 的启发式分数故意做得更高，但样本仍选中
`user_current_entitlement_list`，`endpoint` 也不被高分接口改写；授权后样本归到 trae、
样本 URL 是 API 域名而 agent origin 仍是 dashboard，**钩子在场时页面的 XHR 同样不被包装打断**；
**授权会话**：点授权后进入「等待授权中」、卡片显示「授权中」，目标接口慢 3 秒也仍然等得到；
截到后自动同步、清掉等待并显示「最近一次授权完成」，不需要再点「刷新余额」；
同步 `fresh:true` 从 5 个包里产出
4 个批次合计 369.5——没有 `credits_limit` 的免费包被跳过、零剩余保留、同名签到标签不同、
到期日按最后可用日换算；再同步不重复、`lastSeenAt` 推进、隐藏页关闭；UI 卡片与
「立即同步」按钮都走通；解除钩子后注册脚本清空；授权面板按钮不撑出行宽；无 console error。
这一轮同时修掉 `setRequestHeader` 取错对象导致真实 TRAE dashboard 停在空白页的 v0.3.5 bug。

**WorkBuddy 同源接口截获的浏览器端到端**（Opera 135 + 本地同源替身 `:47861`，77 条断言）：
授权前页面没有钩子、页面自身的 3 个请求成功，**页面自带的 XHR（含 `setRequestHeader`）也成功**；
替身响应被撑到约 130KB（真实响应约 130KB），用来回归 v0.3.9 的截断故障：
目标样本必须完整存下、`truncated` 为 false，7 个批次仍能照常算出；
页面同时请求 `plans` / `usage` 两个干扰接口，`endpoint` 仍指向
`get-user-resource-free-packages`；授权后样本归到 workbuddy、origin 记页面；
**授权会话**：点授权后进入「等待授权中」、卡片显示「授权中」，目标接口延迟 3 秒仍等得到；
截到后自动同步、清掉等待，`authResult.ok:true`、`total:7`，面板显示「最近一次授权完成」；
同步 `fresh:true` 从 7 个包里产出 7 个批次合计 2835.55——同名同日包标签独立、
短码稳定、零剩余保留、到期日按最后可用日换算；再同步不重复、`lastSeenAt` 推进、
隐藏页关闭；UI 卡片显示 2,835.55 且「立即同步」按钮走通并复位；
**旧截断样本升级**：把已在库里的目标样本改回 60KB + `truncated:true`（`bodyHash` 保持整份响应的），
再把目标接口重新放慢 3 秒，让 `plans` / `usage` 先返回；刷新不会被干扰接口提前收工，
也不会因内容相同而跳过——旧样本被完整响应原位替换，条目数不变、`truncated:false`、
探针记录 `upgraded:1`，7 个批次与 2835.55 保持不变；解除钩子后注册脚本为空；
授权面板按钮不撑出行宽；扩展页无 console error。

**Qoder 直读的浏览器端到端**（Opera 135 + 本地 qoder 替身，41 条断言）：默认直读且无钩子、
授权面板只给「刷新余额」且没有旧按钮名、未登录 401 保留登录页且不写批次、登录后读 200 产出 3 个批次合计 1800、
再同步不重复且 `lastSeenAt` 推进、读完关隐藏页、UI「立即同步」按钮也走通并复位、没有任何常驻注入脚本、普通页面没有钩子标记。
同一路径也对真实 qoder.com 的未登录状态验过：后台页被重定向到 `/users/sign-in`，
页面 `window.csrfToken` 可读，接口回 401 JSON，登录页被留在前台、错误被记录、批次保持为 0。

**没验过**（必须真装进浏览器才能测）：**WorkBuddy 真实账号的授权 / 活体读取 / 自动收尾**，
以及它的控制台是否还有免费包之外的付费/订阅接口；**TRAE 真实账号的授权 / 活体读取 / 自动收尾**；
**Qoder 在真实登录态下的直读成功路径**；以及 **LobsterAI 真实账号的授权 / 活体读取 / 自动收尾**——
本地替身覆盖了跨域请求、钩子归属、同步、授权等待与自动收尾，但真实站点的登录、风控和字段
只能在你的 Opera 里验证。本地替身是 `http://127.0.0.1`，而面板的授权只接受 https 地址，
所以 E2E 直接向后台发 `REGISTER_AND_OPEN`（真实站点只多这一层 https 校验，
注册、注入、开页、收尾走同一条代码路径）。
请在升级到 **0.3.9** 后对 Qoder / WorkBuddy 各点一次「刷新余额」——WorkBuddy 已授权过，
这次刷新会把旧的 60KB 截断样本原位换成完整响应；LobsterAI / TRAE 若还没授权，各点一次「授权」，
在打开的页面里登录并等面板显示「最近一次授权完成」。如果 WorkBuddy 控制台总余额明显高于
免费包合计（约 5.8k），把付费/订阅接口的响应另存一份给我。
权限弹窗已不在主路径上（四家域名装载时授予）。

**真机回环已验过两轮**（Opera 135 / Chromium 151）：第一轮权限自检页证明装载时授予是通的
（`contains()` 回已授予），并揪出 v0.2.0 的注入字段名 bug（`run_at` 应为 `runAt`）；
第二轮 Qoder 首次授权即截到样本（主路径成立），并揪出 v0.2.1 的 register 不幂等
（重复 ID 被拒），v0.2.2 改为先注销再注册。同一轮还确认了 qoder.com 登录态失效的
**因果**：解除钩子后站点恢复正常 ⇒ 钩子在场就是触发条件（详见 REQUIREMENTS 决策 17/18）。
v0.3.0 据此撤销 Qoder 钩子，改走页面内直读（决策 19）。

## 授权点了没反应 / 提示没授予权限

这一节针对钩子平台（TRAE / WorkBuddy / LobsterAI）；Qoder 不点授权，走「刷新余额」，见上文。

先点面板顶上的 **「权限自检」**，它会摊开四件事：`chrome.permissions.getAll()` 的实际结果、
每个已填地址域名的 `contains()`、manifest 里的 `host_permissions` 与 `optional_permissions`、
以及你的 userAgent。把那一屏发我就能定位。三种病因对应三种解法：

| 自检显示 | 病因 | 解法 |
| --- | --- | --- |
| `origins` 为空，且点授权时**没弹窗** | 这台浏览器不响应 `optional_permissions` 的运行时申请 | 把该平台域名写进 manifest 的 `host_permissions`，重载扩展（装载时授予，不再需要弹窗） |
| 「上次错误」含 `Unexpected property: 'run_at'` | 扩展还是 v0.2.0：注册注入时字段名写成了 manifest 风格，整个调用被 Chrome 拒掉 | 重载扩展，确认版本号 ≥ **0.2.1**（v0.2.1 已改成 API 要求的 `runAt` / `allFrames`） |
| 「上次错误」含 `Duplicate script ID` | 扩展还是 v0.2.1：重复点授权/刷新余额时同 ID 脚本已注册过，register 不幂等 | 重载扩展，确认版本号 ≥ **0.2.2**（register 改为先注销再注册）。已截到的样本不受影响，直接看样本/导出 |
| 面板上该平台的「上次错误」有别的文字 | 请求被拒或被记住的拒绝 | 按错误信息处理；必要时重载扩展清掉拒绝记录再试一次 |
| `contains(...)` 显示已授予，但点授权仍失败 | 权限没问题，卡在注入 | 看下一步的「截获诊断」 |

四家域名都已经写进 `host_permissions` 了——因为在 Opera（135 / Chromium 151）上实测点授权
拿不到弹窗、回调直接回 `false`。重载扩展时 Opera 会列一次这四个站点的访问警告，点允许即可。

## 授权成功但一条样本都没截到

「截获诊断」会直接告诉你是哪一种（钩子注入成功了但页面不发 XHR /
中转起来了但 MAIN world 钩子没起来 / 注入脚本压根没起来），不用再猜。对应地：

1. 三种都没有 → `opera://extensions` 里扩展的 error 链接有没有红字（多半是注入失败）
2. 提示"不是用 XHR 取的" → 那页的数字是服务端渲染进 HTML 的，只能走手动录入
3. 提示"注入脚本还没起来" → 页面在点授权之前就加载完了，刷新那个页面再回来

## 装了扩展之后站点本身不对劲（登录态消失 / 页面空掉）

2026-10-21 真机出现过：Opera 上 qoder.com 登录态异常消失、重新登录无效，换浏览器正常。
审计后确认**钩子在场就是触发条件**——解除钩子后站点恢复（见 REQUIREMENTS 决策 17/18）。

**v0.3.0 起 Qoder 不再有这个问题**：这个平台不再注册任何注入脚本，UI 上也没有「授权 / 保持实时同步 /
解除钩子」；升级、浏览器启动、SW 启动和每次读取前都会主动退役旧钩子。升级后如果 qoder.com
仍然异常，先**刷新一次已经打开的 qoder.com 标签页**（旧页面里可能还留着升级前的包装函数），
再按下面隔离：

1. `opera://extensions` 里把扩展**开关关掉**（不用卸载），刷新该站点：恢复了 → 与扩展有关
2. 确认扩展版本 ≥ **0.3.0**，并在 `opera://extensions` 里点一次「重新加载」；
   打开旧的 qoder.com 标签页时不要继续用升级前的页面
3. 仍不恢复 → 清该站 cookie 重新登录；会话 cookie 泄露过就先轮换会话

钩子平台（TRAE / WorkBuddy / LobsterAI）仍可能出现类似风控反应：
对应平台点「解除钩子」，样本改走「粘贴样本」。
