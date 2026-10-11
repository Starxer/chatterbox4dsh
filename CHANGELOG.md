# Changelog

## Unreleased

> 对齐 DSH `0.1.5-alpha.1`。插件**无需改代码**：typecheck / tests / build 全绿，全部 `@deepseek-ai/dsh-*` 依赖的公开 API 逐项 diff 无变化。
>
> Aligned with DSH `0.1.5-alpha.1`. **No plugin code changes needed**: typecheck / tests / build all green, and the public API of every `@deepseek-ai/dsh-*` dependency is unchanged.
>
> 另已评估 **并已升级到** DSH `0.1.5-rc.1`（279 commits，见 `docs/migration-0.1.5-alpha.1-to-rc.1.md`）：运行时代码与依赖范围**都无需修改**；下面新增的「交付物清单」正是 rc.1 新 `present` 工具带来的对齐项。
>
> 也已评估 **并已升级到** DSH `0.1.5-rc.2`（距 rc.1 仅 4 commits）：只改动 Web 客户端包（反馈弹窗、产物卡片排版、`CodeFileIcon` 重构），**17 个被插件 import 的宿主包零变化**，`SESSION_FORMAT_VERSION` 仍为 3——插件零改动、依赖范围不变，B1 测试替身继续有效。记录见 `TODO.md`。
>
> 另已评估 **并已升级到** DSH **`0.1.6-alpha.2`**（887 commits / 2622 改动文件）：插件运行时代码**零必改**（四个被消费的 `sessionController` 方法逐字节未变、client slot 契约零差异、依赖范围因同属 `0.1.6` tuple 也无需改）。部署侧前置项：默认模型目录删除两个 id（已改 settings 路由）、Creator preset 工具集由 `cordis_define/run` 换成 `plugin_manager`、解析模式默认值 `link`→`runtime`、web profile 默认开 HMR、`dsh.profile.patchReload` 字段被删除（已复核无动作）。完整评估、升级/回滚步骤与**事故记录**见 [`docs/migration-0.1.6-alpha.1-to-alpha.2.md`](./docs/migration-0.1.6-alpha.1-to-alpha.2.md)。
>
> ⚠️ **升级当天触发上游 alpha.2 回归，会话坏过一次**：源码入口下 `@deepseek-ai/dsh-tools` 被求值两次 → 每次工具调用报 `Cannot read properties of undefined (reading 'prepare')`。已用**服务入口改走构建产物**规避，**未改动 DSH 源码**；上游修复前不改 DSH 源码（详见 migration 文档 §6）。
>
> 同批次修掉：超阈值分卡把表格/代码块切成两半——切分改为块感知（见下条）。
>
> 同批次修掉：**一次永不返回的出站请求会永久冻结整个聊天的卡片投递**（Agent 答完、WebUI 能看见、飞书什么都没有）；同一次挂起还会让**卡片排序屏障静默失效**，于是「老问题重新出现」——问题卡片又抢在步骤卡片前面。两条见下。
>
> 同批次修掉：**在群里新建话题建会话时，创建流程的卡片被发到另一个话题**——卡片所属话题不能按「群」推断（一个群只有一个 `chatId`、却有很多话题），改成按**被点击卡片的 message id** 精确回查。见下。
>
> 已升级到 DSH **`0.1.7-alpha.1`**（1299 commits）：这一版**换掉了设置服务**，插件侧有 4 处必改（见下节）。会话控制 / 流式 / 工具 / 附件 / 客户端 UI / 会话日志格式**均未破坏**。完整评估、升级/回滚步骤与**两次构建失败的根因**见 [`docs/migration-0.1.6-alpha.2-to-0.1.7-alpha.1.md`](./docs/migration-0.1.6-alpha.2-to-0.1.7-alpha.1.md)。
>
> Upgraded to DSH **`0.1.7-alpha.1`** (1299 commits). This release **replaced the settings service**, so the plugin needed four changes (see the first entry below). Session control, streaming, tools, attachments, the client slot contract, and the session-log format are unaffected.
>
> 也已评估 **并已升级到** DSH **`0.1.7-alpha.2`**（162 commits）：**插件零改动**——逐符号核过 `settings.section` / `sessionProjections` / `configForms` / `remote.credentials` / `sessionController.prompt`、`selectModel` / `archiveSession` / `whileServed` 全部 0 差异；18 个 peer 包里 16 个源码 0 变更，其余两个只有**纯新增可选字段**（`ToolDefinition.projectContent?`、`SessionPageRequest.turnWindow?`）；持久化 schema 无变化。升级前后 `lib/index.js` 与 `client/client.js` **逐字节一致**，typecheck 0 error、458 tests 全绿。这一版有两条对本项目有用的上游修复：**后台任务完成唤醒默认不再有上限**（此前默认 3 次后降级为注入，用户离开时会话会静默卡住）、**Web 服务重启后原页面能恢复连接**。一处破坏性配置变更（`spill-policy` 的 `maxInlineBytes` → `maxInlineTokens`）只影响自定义过该策略的部署，本仓库未设置。
>
> Also evaluated **and upgraded to** DSH **`0.1.7-alpha.2`** (162 commits): **no plugin changes**. Symbol-by-symbol diffs of `settings.section`, `sessionProjections`, `configForms`, `remote.credentials`, `sessionController.prompt`/`selectModel`, `archiveSession`, and `whileServed` are empty; 16 of the 18 peer packages have no source change, and the other two only add optional fields (`ToolDefinition.projectContent?`, `SessionPageRequest.turnWindow?`); the persistence schema is unchanged. `lib/index.js` and `client/client.js` are **byte-identical** before and after, with typecheck clean and 458 tests green. Two upstream fixes matter here: background-job completion wakes are now unbounded by default (a cap of three used to park notices invisibly while the user was away), and a Web client recovers its connection after a server restart. The one breaking config change (`spill-policy`'s `maxInlineBytes` → `maxInlineTokens`) affects only deployments that customised that policy; this one does not.
>
> 也已评估 **并已升级到** DSH **`0.1.7-rc.1`**（相对本仓库基线 **156 commits / 933 个文件**）：**插件零代码改动**。这一版的发行说明是**从 `0.1.5-rc.3` 累计**写的，其中绝大多数内容此前已随 `0.1.7-alpha.1` / `alpha.2` 纳入；相对 alpha.2 的真实增量集中在 Web 展示层与插件安装链路。**唯一的新闸门**是插件 / 组合包 / preset 行的 **DSH peer 兼容性检查**（`includePrerelease: true`，豁免走 profile 的 `compatibility.json` 或 `dsh plugin allow-version`）——本插件声明的 18 个 peer 范围全部满足 `0.1.7-rc.1`，启动时 **0 条拒绝**。其余与本插件相关：**工作过程展示改为 4 档**（`compact`/`standard`/`detailed`/`verbose`，默认从 `compact` 变为 `standard`，旧值 `expanded` 读作 `detailed`）；工具行新增 `preparing → start → result` 三阶段（**纯客户端**：不改模型请求、不改工具派发时机、不改 Session 事件、不改持久化格式）；聊天内本地图片预览；pnpm 运行**有界**（进程退出即完成 + 静默超时 + 回收进程树），装上或卸下插件不再可能长期占住 profile 锁；新增 `agentPresetRegistry.readDocument()`（只读查看 preset 组成）；Office 引擎改用随应用安装的 `libreoffice-kit` 0.1.0。会话日志仍是 **V4**（无迁移）；跨重启实测「聊天 → 会话」绑定表**完好**、真实工具调用正常、`typecheck` 0 error、**650 tests / 41 files** 全绿。本次**未重建插件产物**（升级前后哈希一致），插件 dev 依赖有意保持在 `0.1.7-alpha.2`。
>
> Also evaluated **and upgraded to** DSH **`0.1.7-rc.1`** (**156 commits / 933 files** against this repository's baseline): **no plugin changes needed**. This release's notes are written cumulatively from `0.1.5-rc.3`, and most of that had already been taken up with `0.1.7-alpha.1`/`alpha.2`; the real delta since alpha.2 concentrates on the Web presentation layer and the plugin install path. The one genuinely new gate is the **DSH peer compatibility check** for plugin, bundle, and agent-preset rows (`includePrerelease: true`; exemptions live in the profile's `compatibility.json` or `dsh plugin allow-version`). All 18 peers this plugin declares satisfy `0.1.7-rc.1`, and startup reported **zero refusals**. Other relevant changes: work details now have **four modes** (`compact`/`standard`/`detailed`/`verbose`, default moved from `compact` to `standard`, saved `expanded` read as `detailed`); tool rows gained `preparing → start → result` stages (**client-only**: no change to model requests, dispatch timing, Session events, or the persisted format); local images preview inside chat; pnpm runs are now **bounded** (process exit rather than pipe EOF, an idle timeout, and whole-tree reaping), so an install or removal can no longer hold the profile lock indefinitely; `agentPresetRegistry.readDocument()` was added for read-only preset composition viewing; and Office tasks now use the bundled `libreoffice-kit` 0.1.0. Session logs remain **V4** (no migration); across the restart the chat→session binding table stayed intact, real tool calls worked, `typecheck` was clean, and **650 tests across 41 files** passed. The plugin artifacts were **not rebuilt** (hashes unchanged before and after), and the plugin's dev dependencies were deliberately left at `0.1.7-alpha.2`.

### 修复：连接状态指示在出站全断时仍显示「已连接」（O26，`src/outbound-health.ts`（新）/ `src/runtime.ts` / `src/index.ts` / `src/client/LarkPluginDetail.tsx` / `src/client/LarkChannelStatusController.ts` / `src/client/index.ts`，2026-10-11）

**事故**（2026-10-11 16:48:29 → 16:56:50）：**79 行 `write EPROTO … tlsv1 unrecognized name (SSL alert 112)`**，**每一个新建的出站 TLS 握手都被拒** —— 回复、卡片创建与更新、`feishu_send_file`、reaction 全部发不出去；而那 8 分半里**插件详情页的徽章一直是「已连接」**。真正发生的是**两个方向命运不同**：已建立的长连接（入站）活着（16:49/16:50/16:51 的 `[msg]` 照收），新建的出站握手全挂。根因在本机之外的网关（`open.feishu.cn` 被解析成 `198.18.0.0/15` 里的一个 fake-IP（连 `1.1.1.1`/`223.5.5.5` 问也是它） ⇒ DNS 在网关上游被劫持），**插件改不了**；插件能改的是**别再谎报正常**。

**问题**：`LarkRuntime` 的 `connected` 是**建连那一刻的快照** —— `start()` 返回即置位，之后永不复查（`src/runtime.ts` 的 `snapshot`），UI 只读这一个字段。于是「WebSocket 连上了」被当成「链路健康」，而链路真正能不能发东西，这个快照从来不知道。

**改法：两个方向都按事实报，不按建连结果报。**

1. **出站 = 请求自己的历史（`src/outbound-health.ts`（新））**：SDK 的每一个 HTTP 请求都走 `Client`/`WSClient` 的 `httpInstance`（实测只调用 `.request`，`lib/index.js:100718` 以 `params.httpInstance || defaultHttpInstance` 兜底）⇒ 把 SDK 自己的 `defaultHttpInstance` 包一层 **Proxy**（不是逐方法转发：接口以后新增方法也自动被观测；非函数属性原样透传；调用一律以**原实例**作 receiver，所以 axios 内部 `get → this.request` 的自调用不会重复计数）后经 `createLarkChannel({ httpInstance })` 交给通道。**判定只有一条**：rejection 里**有 `response`** = 对端**答了**（400/429/500 都算答了，链路是好的）；**没有 `response`** = 链路失败；`ERR_CANCELED`（我们自己取消的）**两者都不算**。`verdict` 从**第一次无人应答**起就是 `failing`，直到下一次收到应答才回到 `ok`（失败计数作为历史保留）。
2. **入站 = 长连接的真实生命周期**：`runtime.status()` 每次都读 `channel.getConnectionStatus()`，随状态一起报 `inbound: { state, reconnectAttempts, … }`（可选：通道没这个方法就只报建连结论，绝不因此让 `/status` 挂掉）。
3. **UI 不再二选一**：`connected` 之上若出站 `failing` → 徽章「**已连接 · 出站异常**」+ 红点 + 明细行（连续失败次数 + 对端原话）；长连接 `reconnecting`/`failed`/`idle` → 「**已连接 · 长连接断开**」+ 重连次数。**只有 `connected` 会被二次判读**（`connecting`/`error` 本来就在描述自己，旧失败不该改它们的画）。另：**`observed === 0` 时不再暗示健康**，明细行写「尚未观测到出站请求」——「没测过」和「测过是好的」必须区分。
4. **指示本身必须是活的**：这条路由原来**每个页面只读一次**（进入详情页那一刻），所以「页面已经开着、之后才断」照样看不出来 —— 正是这次事故的形态。现在只要有条目挂在页上就持续复读：配置流程在跑时 2s、其余 **10s**（本机 loopback 的 JSON GET，页面关掉即停）。顺带把「一次配置跑完回调一次」的保证从「读完就停表」改成**观察到 active → terminal 那次跳变**，否则慢速轮询会把「重读凭据徽章」重复触发。

**验证**：`npm run typecheck` 0 error；**1024 tests / 55 files 全绿**（本批新增 32 例：`tests/outbound-health.spec.ts` 18 例钉住分类口径/计数/复发与恢复/Proxy 透传与「一次调用只记一次」，`tests/runtime.spec.ts` 5 例钉住入站随取随读、可选字段与「通道没有 getter 也不崩」，`tests/client.spec.ts` 9 例钉住两种异常徽章、明细行、健康时不多嘴、未观测提示、脏状态不改 `connecting`，以及轮询节拍/页面关掉即停/配置完成只回调一次）；`npm run build` 产出 `lib/index.js` + `client/client.js`。**另跑了一次一次性真机探针**（真 SDK + 真凭据，跑完即删）：真实 `chat.get` 走通且 `observed` 累加到 2（token 请求也在这条线上），把域名指到一个没人监听的本地端口后 `verdict` 立刻变 `failing`、`lastError = connect ECONNREFUSED`，再答一次即回到 `ok` —— 证明插件确实截到了 SDK 的真实流量，而不是只在单测里自洽。**生效需要重启 dsh**。

### 新增：本轮「产出物」——一行计数 + 只投产出物形状的那一份（O3 结案，`src/produced-files.ts`（新）/ `src/feishu-streaming.ts` / `src/channel.ts` / `src/config.ts` / `src/i18n.ts` / `src/client/`，2026-10-11）

承接 O3（「飞书这边没有 produced 产物行」）。**先决定不做什么**：WebUI 的 produced 是**成功 `write`/`edit` 改过的文件**，而飞书是聊天不是工作区浏览器 —— 本会话实测 **69 个 produced 路径 vs 3 个 presented**，逐条看全是 `src/`、`tests/`、`docs/` 与 `/tmp` 脚本，**没有一个是用户要拿走的东西**；每轮贴 4–6 行路径只会把答案挤出屏幕。所以**不做 produced 全表**（也因此没去接 `workspace/changes` / `workspaceChanges.summary()` 那条 git 口径的主机服务：全表都不做，它就没有必须接的理由）。

**做的是两件**：

1. **Turn Complete 卡加一行计数**：`📦 本回合新生成 N 个文件`（notation 档、**不列路径、不带按钮**），只在真有产出物时出现。
2. **只投「产出物形状」的那一份**：媒体（图/视频/音频）与 pdf/office 文档，**复用既有 `present` 投递管线** —— 媒体卡内内联、文档 ≤ `deliverDocMaxMb` 自动发原生文件消息、其余给可点行。源码、测试、临时脚本**永不投递**（`producedArtifacts()` 按 `deliver-files.ts` 的分类过滤）。这条正是几次真机场景：模型生成了图/报告却忘了 `present`，以前聊天里毫无迹象。

**实现**：

- **`src/produced-files.ts`（新，纯函数）**：`mutationPathOf()` 按 WebUI `ui-deliverables/src/client/turn-deliverables.ts` 的同一套规则从工具参数取路径（`write` 需 string `content`；`edit` 需非空且真的不同的 `old_string`/`new_string`；`str_replace_editor` 只认 `create`/`str_replace`/`insert`）；`settleProducedCall()` 与**成功**的 `tool/result` 配对（失败的结果不产出任何东西）；`producedArtifacts()` 只留媒体与文档；`mergeProducedArtifacts()` 按**解析后路径**去重（模型写 `out.png`、`present` 写 `/abs/ws/out.png` 时不能投两次）后并入 `present` 的清单。
- **采集（`feishu-streaming.ts`）**：`tool/call` 时把「这个调用会写哪个文件」记在 `StepToolCall.produced`（**参数只在 `tool/call` 上**），`tool/result` 时按 `isError` 结算进 `turnStats.produced`（逐回合清空）；另有**会话级** `everPresentedPaths` —— `present` 声明过的路径记一辈子，避免「更早的轮次 `present` 交付过、这一轮又写了一次」被再投一遍。
- **合并与显示（`channel.ts`）**：只有 `produceCard === 'delivery'` 才把这些产出物并进 `deliver.plan()` 的 `files`（于是走 `stat`/`realpath`/大小/白名单那一整套既有校验）；计数行由 `renderFooterCard(..., producedCount)` 渲染，`off` 时调用方传 `undefined`。
- **开关（`produceCard`，默认 `delivery`）**：`off` 完全静默（= 以前的行为）/ `summary` 只报个数、不投任何文件 / `delivery` 两者都做。WebUI 设置页「卡片显示」里的「本轮产出物」也是它，`.volatile()` 热生效。默认选 `delivery` 是因为缺口是实测的（21 个回合写过文件，只有 1 个回合调过 `present`）；不同意就选 `off`。

**验证**：`npm run typecheck` 0 error；**993 tests / 54 files 全绿**（新增 27 例：`tests/produced-files.spec.ts` 18 例钉住参数规则/成败配对/分类过滤/去重口径，`feishu-streaming.spec.ts` 4 例钉住采集与逐回合清空，`channel-footer.spec.ts` 2 例钉住计数行**只报数不列路径**与 `off`/0 的静默，`plugin.spec.ts` 2 例钉住 `delivery` 真的把产出物并进 plan、`summary` 一个都不投，`config.spec.ts` 1 例钉住默认与未知值回退）；`npm run build` 产出 `lib/index.js` + `client/client.js`。**生效需要重启 dsh**（本次按要求未重启）。

### 修复：提问卡的「确认提交」点完卡片原样不动，看不出是否已确认（`src/feishu-questions.ts` / `src/i18n.ts`，2026-10-11）

操作者反馈：提问卡的最后一张「📝 确认全部回答」卡上点「✅ 确认提交」后**卡片样式没有任何变化**，因此无法判断答案是否已经提交给模型。

**取证（只查、未重启）**：

- 事件日志（2026-10-11 09:08，`ask_user_question` 单题批次）：09:08:21 发问题卡 `om_…ef7ad` → 09:08:42 `answer-open`（点选项行）→ 09:08:48 `[card] type=batch-confirm` → 09:08:48 `[q] batch card tap type=batch-confirm` → 09:08:48 起**再无任何卡片写入**（无 patch、无 `230020`、无拒收警告）。
- 只读读回飞书上的两张卡（`im.v1.message.get` + `card_msg_content_type=user_card_content`）：问题卡已是 `turquoise` 表头、选中项 `✅ … — *已选择*`、无按钮（说明**选项行那一步确实重绘过**）；确认卡仍是 `blue` 表头、两行答案 + `✅ 确认提交` / `↩️ 返回上一题` 两个按钮**原样**，其最后写入时间就是它**发出**的时刻。
- 提交本身是成功的：该会话日志 `turn 417 step 1` 的 `tool/result` = `{"answers":[{"id":"which_two","selected":["三个都跑（5 个模型）"]}]}`。
- 代码侧对得上：`batch-confirm` 分支原来只 `dispatch({kind:'confirm'})` 就放行回合，`askBatchConfirm` 里提交后也没有任何重绘 ⇒ **不是写入失败，是提交后从来没写入过**。单题批次的回执卡按设计被跳过（最后一个答案由最终卡记录），所以用户连 `✅ 已提交` 那张回执也看不到，观感被放大。

**改了什么**：`batch-confirm` 被认下的那次点击，在把答案交给模型**之前**把确认卡就地重绘为结算态——表头 `blue 📝 确认全部回答` → `green ✅ 已提交`，保留逐题答案行，底部提示换成「这组回答已经交给模型，这张卡片不再接受修改。要改请在下面直接回复。」，**去掉两个按钮**。写入走 `updateCardQuiet`（失败只记 warn），提交本身绝不依赖卡片写入（坑 29）；重绘只在**真正被认下**的点击上发生，歧义卡（`fromCard` 忽略掉的陈旧点击）不会留下假回执。行渲染抽成 `batchAnswerRows()`，确认卡与结算卡共用。

**验证**：`npm run typecheck` 0 error；**966 tests / 53 files 全绿**（`tests/feishu-questions.spec.ts` 23 → 24 例，新增「确认后确认卡被重绘成绿色回执、答案仍在、按钮为 0」；测试替身顺手补上**真实 message id**：此前 `commitBatch` 在确认卡还没发出时就点「最后一张卡」，走的是 `evt.messageId === undefined` 兜底路径，根本测不到重绘）；`npm run build` 产出 `lib/index.js`。**生效需要重启 dsh**（本次按操作者要求**未重启**）。

### 修复：标点被包进加粗（`**加粗。**后面`）时飞书按字面渲染星号（`src/card-emphasis.ts`（新）/ `src/card-markdown.ts` / `tests/card-emphasis.spec.ts`（新），2026-10-10）

承接上一条排查时发现的第二类成因。真机探针（两张编号卡：A 每行一个 `markdown` 元素，B 全部行放一个元素 + 一个表格单元格）逐条确认：

| 源文本 | 渲染 |
|---|---|
| `**加粗。**后面` / `**加粗：**后面` / `**带括号（说明）**后面` / `**加粗…**后面` | **字面 `**`**（编号 2 / 4 / 9 / 11，表格单元格同） |
| `**加粗**。后面` / `**加粗**：后面` / `**加粗**，后面` | 粗体正常（3 / 5 / 6） |
| `**加粗** 前后有空格` / `前缀**加粗**后缀` / `**整行只有加粗**` / `**两处**和**第二处**` / 行内代码混排 | 粗体正常（1 / 7 / 8 / 10 / 12 / 14） |

即：**关闭 `**` 夹在"末尾标点"与"紧跟的字"之间时不是合法的关闭分隔符**，飞书照字面输出；把标点移到加粗外面即可（可见文字完全不变）。这正是 CommonMark 的分隔符规则，第三方实现（[loopx PR #5352](https://github.com/loopx-project/loopx/pull/5352)）独立得出了同一条结论。

- 新增 `src/card-emphasis.ts` 的 `normalizeCardEmphasis(text)`：只处理成对的 `**`（`***` 长串不碰），按规则把加粗内部的末尾标点移到外面；围栏代码块、行内代码 span、转义字符、链接目标一律不透明，未闭合的 marker 不动（那是上一条截断问题，不是这里的事）；**幂等**。
- 接入 `neutralizeCardMarkdown` 的**最后一道**：判的是飞书真正收到的 markdown（包括前面回退逻辑刚插入的代码 span），于是每张出站卡片自动经过。
- **全量实测**：9019 条真实助手文本中 **67 条（0.74%）、87 行**被改写；**可见文字 0 变化**（只移动 `**` 的位置）；对全部真实文本幂等。
- 测试：`tests/card-emphasis.spec.ts` 17 例（探针 14 条逐条钉住、不透明性、幂等、与 `neutralizeCardMarkdown` 的集成）。
- **上线与确认**：两条修复（本条 + 上一条截断）于 **2026-10-10 12:39:54** 插件重载后同时生效（重载后仍正常收发卡片、无 error），使用者当日确认「没问题了」。

### 修复：卡片里的加粗被固定字数硬切，星号按字面渲染（`src/text-chunk.ts` / `src/feishu-progress.ts` / `src/feishu-streaming.ts` / `src/feishu-compaction.ts` / `src/channel.ts` / `src/feishu-deliver.ts` / `src/error-text.ts`，2026-10-10）

使用者反馈「卡片消息加粗符号近期经常渲染失败」。逐条排查后确认，问题在**我们自己把文本切短的方式**，不在飞书：

- **根因**：所有一行式预览都用 `slice(0, N) + '…'` 硬切。当切口落在 `**…**` 的中间，卡上就剩下一个**未闭合的 `**`**，飞书按字面渲染出星号；如果切口落在行内代码 span 里，同样会留下一个孤零零的反引号。全量取证：8998 条助手文本里，简洁档解说行（上限 80 字）有 **218 条（3.1%）** 会被切出悬空 `**`，近三天为 6/63、2/272、5/281——与「近期经常」吻合（简洁档的解说行是 2026-10-09 那一批改动引入的）。
- **修法**：新增 `truncateInline(text, maxLen)`（`src/text-chunk.ts`）：切之前先定位切口处仍未闭合的 `**` 或行内代码 span，把该 opener **丢掉**再补省略号。刻意**不自动补闭合**——补了会把模型没写完的句子整段加粗；丢掉 marker 只是少一处强调，读者看到的文字不变。转义字符（`\*`）与三连星（`***`）不参与判定，反引号只有"与开 span 等长"才算闭合。
- **接入点**：简洁档解说行 `condenseStepNote`（80）、推理预览（80）、压缩摘要（200）、回合交付物说明（60）、交付清单行说明（60）、错误原因（1000）。推理全文与摘要正文渲染在代码围栏里，不受影响。
- **测试**：`tests/truncation.spec.ts` 新增 8 例（含"切口正好落在 `**` 两个星号之间"、"闭合的粗体对保持不动"、"未闭合行内代码被丢掉"），`tests/feishu-progress.spec.ts` 新增 1 例；**948 tests / 52 files** 全绿，typecheck 0 error，`npm run build` 通过（`client/client.js` 未变动）。**上线**：与下一条（强调边界规范化）同批于 2026-10-10 12:39:54 插件重载后生效。
- **同批发现的第二条**（真机探针确认，修法见下一条）：第三方实现 [loopx PR #5352](https://github.com/loopx-project/loopx/pull/5352) 报告的「关闭 `**` 夹在标点与后字之间时 Lark 不认」确实作用于**卡片**元素——已发两张编号探针卡实测确认。

### 新增：简洁档把整轮的工具活动合并到一张卡片（O22 第二轮，`src/feishu-progress.ts`（新）/ `src/display-level.ts` / `src/feishu-streaming.ts` / `src/i18n.ts`，2026-10-09）

O22 落地时留了一条「仍待拍板」：**`compact` 档要不要真的合并卡片**。当时只把步骤卡缩成状态行（`🔧 N 个工具调用 · M 个失败`），理由是要合并就得新造一套跨 step 的卡片生命周期。本轮按使用者的要求补上，形态先拍板（卡片 vs 普通消息 → **卡片**）。

- **一张回合级过程卡**：从 `turn/start` 起算，**首个工具调用时懒创建**（没有工具调用的回合根本没有这张卡），之后整轮就地更新，`turn/end` 定格。标题 `⚙️ 本回合进行中 · N 个工具 · 12.3s`（运行中灰头 → 正常结束绿头 → 回合失败红头；失败原因仍由那张失败卡承载，不重复，坑 7/40）；正文按 **step 小节**（`**第 2 步** · 3.4s`，运行中带 `…`）+ **每行一个工具**（`✅ \`read\` · 0.4s` / `⏳ \`bash\` · 1.2s…` / `❌ \`edit\` · 50ms`）。**只显示工具名与耗时**，没有参数、结果与推理——那正是 `compact` 的定义。
- **连续同名调用合并成一行**（`✅ \`read\` ×2 · 1.2s`，耗时累加；运行中的按首个开始时刻走表）。**超过 40 行按整步折叠**进 `collapsible_panel`（复用 `card-fold.ts` 那套「看得出来已折叠」的外观），面板正文另有 60 行上限——折叠只少占屏，**JSON 仍然随卡发出去**，所以两处都必须有界（坑 42 的 30KB 整卡拒收）。
- **写入纪律**（坑 45 的 `230020` 真机链条）：单卡同时只允许**一次写入在飞**、只写**最新一版**（被顶掉的渲染直接丢弃、不重放），并加 900ms 合并窗口；CardKit 实例优先（无编辑上限），退化走 `im.v1.message.patch`；整张卡彻底发不出去时，**回合结束时补一条纯文本汇总**（文本而不是第二张卡，坑 40）。
- **三条寿命红线，都来自实测**：① 卡片实体**只能发送一次、有效期 14 天**（`cardkit.card.create` 接口说明，见 `docs/feishu-capabilities.md` §七）⇒ **每回合新建实体、不跨回合复用、不落盘**，重启后这张卡停在最后一次写入的形态（沿用既有「陈旧卡」文本兜底，不做跨重启恢复）；② 带按钮的卡就地更新 2–3 次后**停止投递回调**（坑 11），`interactive_container` 行被点过一次后该卡不再投递行回调（坑 55）⇒ 这张卡**永远没有按钮、没有可点行**（有测试钉住）；③ 本插件**未启用** `streaming_mode` ⇒ 不受「流式卡片 10 分钟自动关闭」约束，长回合不会被强制关闭。
- **档位门控**：新增策略轴 `turnCard`，**只有 `compact` 为真**（`showToolCalls=false` 时同样关闭——要求完全不显示工具的人不该收到一张列出每个工具的卡）；`standard` / `detailed` / `verbose` 行为零变化。**步骤卡与过程卡的分工（2026-10-09 真机复核后按使用者拍板定稿）**：`compact` 的步骤卡**只承载答案正文**——`tools` 降为 `off`，工具段整段不渲染，**只有工具调用的步骤因此不再发卡**（它的活动全在那张回合过程卡上），`step/start` 的占位卡也只在**该步带着注入提示行**时才发（注入行只渲染在步骤卡上，丢了就真丢了，O21①；`step/end` 的终态 `done` 形态同样保留注入行）。⇒ 一轮的实际形态是「`⚙️ 本回合…`（工具时间线）+ 有正文的那几张卡」，而不是「每步一张计数卡 + 一张过程卡」。答案正文**不并进**过程卡（30KB 上限与溢出续卡会失控）。
- **明确没做**：卡上不带参数/结果（`verbose` 才显示）；不做跨回合/跨天复用的常驻卡（实体 14 天且只能发送一次）；不把答案正文合并进来。

**验证**：`npm run typecheck` 0 error；**908 tests / 51 files 全绿**（新增 25 例：`tests/feishu-progress.spec.ts` 18 例——耗时格式化、运行与终态头色、同名合并、运行/失败行、整步折叠与面板上限、无按钮无行、懒开卡、每回合新实体、无工具回合零卡片、突发合并成一次写入、一次在飞且渲染最新态、终态绿色且 `turn/end` 后不再动作、发卡失败只补一条文本、话题坐标、`stop()`；`tests/feishu-streaming.spec.ts` 新增 5 例接线——简洁档只有工具的一步**一张卡都不发**、正文卡不含任何工具痕迹、简洁档由**正文**开卡（占位不再无条件发）、详细档不发过程卡、`showToolCalls=false` 不发、无工具回合不发、简洁档的正文/隐藏推理渲染；`tests/display-level.spec.ts` 新增 2 例——档位映射与「简洁用过程卡取代步骤卡的工具段」）；`npm run build`（`lib/index.js` 656,855 → 672,376 B；`client/client.js` 未变，本批纯宿主侧）；**生效需要重启 dsh**。

**English**: The one open question O22 left behind — should `compact` really merge cards — is now implemented, with the shape picked first (card vs plain message → **card**). A **turn-level progress card** opens lazily on the first tool call (a turn that calls no tool never sees it), is updated in place for the whole turn and freezes at `turn/end`: grey running header → green on success / red on failure (the failure facts still ride the dedicated failure card), a section per step (`**Step 2** · 3.4s`, `…` while running) and one line per tool (`✅ \`read\` · 0.4s`, `⏳ \`bash\` · 1.2s…`, `❌ \`edit\` · 50ms`) — names and durations only, no arguments, no results, no reasoning. Consecutive same-named calls merge into one row with a summed duration; past 40 rows the older **whole steps** fold into a `collapsible_panel` (same "you can see it is folded" chrome as the reasoning panel) whose body is itself capped at 60 lines, because folding hides pixels but the JSON still ships (坑 42's 30KB rejection). Writes follow the `230020` discipline measured in 坑 45: at most one write in flight per card, only the newest render, a 900ms coalescing window, the CardKit instance first and `im.v1.message.patch` as the fallback, plus one plain-text summary at `turn/end` when no card could be created at all. Three lifetime rules, all measured: a card entity may be **sent once only** and is operable for **14 days**, so every turn gets a new entity and nothing is persisted (after a restart the card simply stops updating); a card carrying buttons stops delivering callbacks after 2-3 in-place updates (坑 11) and a tapped `interactive_container` row stops delivering row callbacks (坑 55), so this card **never carries a button or a tappable row** (pinned by a test); and this plugin does not enable `streaming_mode`, so the 10-minute auto-close of native streaming cards does not apply. The feature is gated by a new `turnCard` policy axis that is true only at `compact` (and false when tool display is off entirely); the other three levels are unchanged. The split between the two cards was finalised after seeing it live: under `compact` the step cards carry the ANSWER only (their tool section is off entirely), so a step that only ran tools posts no card at all, and the `step/start` placeholder is now sent only for a step that claimed injection notices (those render on a step card and nowhere else); the answer text is deliberately NOT merged into the turn card. Verified with typecheck clean, **906 tests across 51 files green** (23 new), and a rebuilt `lib/index.js` (`client/client.js` untouched, host-only batch).

### 修复：续接（重建）会话被强行切到「全局默认模型」（`src/harness.ts` / `tests/harness.spec.ts`，2026-10-09）

现象：重启 dsh（或某个会话的 agent 已被回收）之后，很多飞书会话的模型被换成了「别的地方最近挑过的那个模型」。

根因（两层，缺一不可）：
- **上游：一个 loop 的路线只认「创建者传的 `agentOptions`」**——`packages/core/agent-loop/src/agent.ts:556` 是 `const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }`，会话自己日志里的 `request/header` **只在 provider+model 相同时**用来补 `reasoningEffort`。会话控制器（`session-controller`）本来会给它建的 agent 装一个 selection 监听器，让「会话自己的路线」优先（`selectionFor`：pending → 日志里的 header → 全局默认）；但本插件是**直接**走 `agents.create` / `agents.resume` 建 agent 的（为了自己挂 preset），**没装那个监听器**，于是 `agentOptions` 说了算。
- **插件：新建和续接共用同一段 `initial`**——`creation?.provider ?? config.provider ?? deps.selection()`，而 `deps.selection()` 就是 `agentDefaultModel.currentSelection()`，即**全局默认**；`config.provider/model` 本部署没配，续接时 `creation` 也不存在（`creation` 只由 `/new` 与新会话卡片写入）⇒ **每次重建都拿全局默认当路线**。而 DSH 的 `selectModel` 每次都会 `agentDefaultModel.saveSelection()` 把这个选择持久化成默认 ⇒ 任何一个入口（Web UI 选择器 / 插件 `/model`、`/effort`、模型卡、`/new`）挑一次模型，之后**每次重启都会把所有被重建的飞书会话拽到那个模型**。

实测（真机日志）：本会话 20:47:10 打出 `request/header reason=resume cfg=cpa-codex/gpt-6.1-sol/medium startsSeries=true`，而它自己的路线是 `deepseek-official/deepseek-flash`，且全日志**没有任何 cpa-codex 的 `model/selection`**；同一时段另一个飞书会话 20:50:20 也是「minimax → cpa-codex，无 selection 事件」——两个都是被默认值顶掉的。

修法：新增 `recordedRoute(sessionId)`，续接前读**该会话自己的日志**（`sessionPersistence.open(id,'read')` 分块读、`readFrom` 兜底、内存有界；不缓存，所以 agent 存活期间改过的路线照样生效），优先级 **最后一条 `model/selection`（明确的用户/插件选择）> 最后一条非 `resume` 的 `request/header`（它自己在自己进程里跑过的路线）> 第一条 header**；`initial` 改成 **`creation` > `recorded` > `config` > 全局默认**（新建会话行为不变）。日志读不出来时静默回退到配置——绝不让一条消息因为读日志失败而卡住。

已发生的会话修复（一次性，**不需要重启**）：扫全部 53 个会话，只有 4 个「自身记录 ≠ 最后一次请求路线」，其中 2 个有明确自选记录被 resume 顶掉（`lark-v2-2b18e9cf…`：10-02 选了 MiniMax-M3.1-Flash-Preview，10-08 被顶成 deepseek-flash；`lark-v2-6185f515…`：09-28 选了 MiniMax-M3.1-Flash-Preview，09-30 被顶掉），用运行中宿主自己的 RPC（`POST /api/session/selectModel`，走 `dsh web` 的 cookie 认证）写回各自路线，并把 `selectModel` 顺带改写的全局默认**还原**；另外 2 个未动——`session-2be5cb53…` 其实还带着 pending 选择（UI 显示本来就对），`lark-v2-e4a580b1…` 从来没有 `model/selection`（63 条 header 全是 `resume`，无从判断意图，强改等于猜）。验证：`session/list` 的 `modelSelection.next` 已是各自路线。

**English**: Re-created (resumed) sessions were silently moved onto the deployment default model. Upstream takes a loop's route from the `agentOptions` its creator passed — a session's own logged `request/header` only donates a reasoning effort, and only when provider and model already match (`agent-loop`). The session controller installs a selection listener that would prefer the session's own route, but this bridge creates and resumes its agents through `agents` directly (to mount its own preset), so no listener exists and `agentOptions` decides; the bridge built those options as `creation ?? config ?? deps.selection()` — and `deps.selection()` is `agentDefaultModel.currentSelection()`, the global default. Since DSH's `selectModel` persists every pick as that default, any pick anywhere plus any restart dragged every rebuilt chat onto it. The fix reads the session's own route from its log before resuming (`recordedRoute`: last `model/selection` > last non-`resume` `request/header` > first header, chunked and uncached) and prefers it over the default; creation routes still win. The four already-mismatched sessions were inspected, the two with a recorded choice were restored through the running host's own `session/selectModel` RPC (no restart) and the default that call rewrote was put back.

### 改进：提问卡的确认流程重做——点选即作答、回执卡带「返回」、最后一张卡统一提交（`src/feishu-questions.ts` / `src/i18n.ts`，2026-10-09）

使用者的三条要求（原话）：① 点击后还是会发确认卡，但**默认就是确认**，不再需要用户点击确认；② 确认卡上增加一个「返回」按钮，用来**反悔这一次作答**；③ 当用户回答完所有的卡片后，有一个**最终的确认卡**用来提交回答，此时需要用户选择「确认」或「返回上一题」。

- **点选即作答**：`interactive_container` 行 / `checker` 提交 / 自定义回答 / 跳过，一次点击就把这一题记下来（旧流程是「先弹确认卡、再点一次确认」，两次点击）。问题卡**就地写成本题的结算卡**（选中项打勾、无交互），**不再有第二次确认**。
- **每答一题发一张回执卡（`✅ 已提交`）**：写明「已选：X」，带一个 **`↩️ 返回重答`** 按钮——这就是「反悔这一次作答」的入口；点它会把这道题**重开成一张全新的问题卡**（被点过行的卡飞书不再投递行回调，坑 55），回执卡就地变成灰色「已撤销」提示，已记下的答案被丢弃。
- **最后一张卡统一提交**：所有题都有答案后发一张 `📝 确认全部回答`，逐题列出「问题 → 作答」，两个按钮 **`✅ 确认提交`（把整组答案交给模型）/ `↩️ 返回上一题`（丢掉最后一题、重开那张卡）**。**只有点「确认提交」才真正 resolve 这次 `ask_user_question`**——所以一张卡的答案也能反悔，代价是单问题也要多点一次确认（这是「最终确认卡」语义的直接结果；想改回「单问题一票即交」只需去掉这条分支）。
- **卡片数**：N 题 = **N 张问题卡 + (N-1) 张回执卡 + 1 张最终卡**（最后一题的答案由最终卡记录，不再多发一张回执）；单问题 = 2 张。相比旧流程的「问题卡 + 确认卡 + 结果卡」三连，每题的卡片数没增加，但**每一步都能反悔**，且不再有「已作废·结果见下方新卡的卡片」这种指针卡。
- **实现**：`PendingCard`（每问一个）换成 **`PendingBatch`**（整批一个状态：答案表 / 当前是第几题 / 问题卡与回执卡的 message id / 最终卡 / 等待中的 settle + 队列），`presentQuestions` 变成一个状态机循环：跳过已作答的题 → 问下一题 → 记答案、发回执 → 全答完发最终卡 → `确认` 结束 / `返回上一题` 或任一回执的 `返回` 走 `{kind:'undo'}` 分支回到那一题。回调一律**按 `evt.messageId` 认当前卡**（问题卡 / 回执卡 / 最终卡各只认自己那张），旧卡与已作废卡的点击一律忽略。被 Web UI 抢先或回合中止时，**整批的三类卡片一起退休**（`cancelCard`）。

**验证**：`npm run typecheck` 0 error；**936 tests / 52 files 全绿**（`tests/feishu-questions.spec.ts` 23 例按新流程重写/新增：两问批次「问题卡 → 回执 → 问题卡 → 最终卡 → 确认」的顺序与答案、`返回上一题` 重开最后一题后重新作答再确认、回执「返回重答」撤销后再作答、点选即作答（无第二次确认）、回执卡与最终卡的按钮类型、已作答的卡再点不产生第二张卡/第二个答案、Web UI 抢先时整批退休）；**未重启**（使用者上一轮要求先不重启，本次同样等确认）。

**English**: The operator's three requirements for the question cards, implemented literally: tapping a row IS the answer (no second confirmation tap), every answer is followed by a receipt card carrying 返回 so that one answer can be redone, and once every question is answered a single final card commits the whole set with 确认提交 / 返回上一题. Internals: the per-question `PendingCard` became one `PendingBatch` (answers, current index, the message ids of the question/receipt/final cards, a parked settle plus a one-slot queue), and `presentQuestions` is now a small state machine — skip answered questions, ask the next one, record the answer and post a receipt, then post the final card; 确认 resolves the `ask_user_question` call, while 返回上一题 or any receipt's 返回 dispatches an undo that re-asks exactly that question on a fresh card. Card count per batch: N question cards + (N-1) receipts + one final card. Every callback is validated against the message id of the card that role owns, and an abort or a Web UI win retires the whole batch.

### 修复：提问卡不再为每个答案多发一张「结果卡」+「已作废」指针（`src/feishu-questions.ts` / `src/i18n.ts`，2026-10-09）

使用者复看时指出「**在 Agent 发出问题卡片的时候还是会产生大量的碎卡片**」，并怀疑是**废卡机制**的问题。取真机证据后确认：**两边都对**——碎卡片里既有一半是我上一批引入的（见下一条），另一半正是提问卡的**废卡指针**机制。

**证据**（话题 `dsh-sshtk`，一轮 5 个问题的问答，19:41–19:47，用 `im/v1/messages` 逐条读回 `create_time` / `update_time` / 当前卡片内容）：

- **每个被作答的问题都产生三张新卡片**：`问题卡`（`[q] sending card`）→ 点选后**新发的确认卡** → 提交后**又新发一张「结果卡」**，同时原来的问题卡被就地改写成灰色 `已作废 · 本题已提交，结果见下方新发的卡片` 指着它。⇒ 一轮 5 问 ≈ 15 张卡起步（实测那 4 分钟里 22 条消息）。
- **「废卡」本身是就地改写、不是新发**（`create_time` 早于 `update_time`，如 `19:41:09 → 19:41:55`，同一条消息）⇒ 机制没坏，**坏的是「结果另发一张、再让旧卡指向它」这个形状**：多一张卡，还要多一张灰卡去解释它。

**改法**：`submitAnswer` 把结算卡**写回问题卡本卡**（`updateCard`，与多选 / 跳过 / 自定义回答三条分支本来就是同一个形状），**不再新发结果卡**，`renderSubmittedQuestionCard` 与 `questionCardSubmitted` 随之删除（没有指针要解释了）。只有「问题卡的 message id 从来没拿到」这一种情况才兜底发一张。⇒ 一次作答从 **3 张实体卡降到 2 张**（问题卡 + 确认卡），且不再出现 `已作废`。

**验证**：`npm run typecheck` 0 error；**935 tests / 52 files 全绿**（`tests/feishu-questions.spec.ts` 里钉住旧形状的那一例改成新形状：提交后 `sentCards` 从 3 降到 2，问题卡被就地写成带勾选的结算卡）；**未重启**（使用者要求先不重启）。

**English**: The operator pushed back on my first diagnosis — "I think the retired-card mechanism is the problem" — and the evidence backs them. Reading every message of one five-question batch back from the API (`create_time`, `update_time`, current card JSON) shows **three new cards per answered question**: the question card, a new confirmation card on the first tap, and **another new "result" card** on submit — while the spent question card was repainted in place as a grey `已作废 · 本题已提交，结果见下方新发的卡片` pointer at it. The retirement itself is an in-place rewrite (create time older than update time), so the mechanism was fine; the **shape** was wrong. `submitAnswer` now writes the settled card **into the question card itself** — the same shape the multi-select, skip and custom branches always used — so no result card is posted, no pointer is needed, and `renderSubmittedQuestionCard` / `questionCardSubmitted` are gone. One answered question now costs two cards instead of three, and no `已作废` card appears at all. (The other half of the fragments was mine and is fixed in the entry below.)

### 修复 / 改进：简洁档的「单卡」收口——注入与中段正文并入过程卡、外部卡片后另起新卡、只显示最新 5 步、运行中的工具不再显示 0ms（`src/card-interleave.ts`（新）/ `src/feishu-progress.ts` / `src/feishu-streaming.ts` / `src/feishu-compaction.ts` / `src/index.ts` / `src/i18n.ts`，2026-10-09）

上一轮上线后使用者复看，报了五条。逐条都取到了真机证据（会话日志 + 从聊天读回卡片）：

- **「reply 出现在第一步时会溢出成为单卡」与「上下文注入消息也是单独卡片」是同一个根因**。真机证据：每个回合的 **step 1** 都必然认领一条 `user/message`（`source.kind = 'time-context'`，即「Time sampled while preparing turn N, step 1: …」）。旧逻辑里「带注入的 step 必须发卡」（O21① 的例外）于是**每个回合的第一步都被强制开一张步骤卡**，而它同时载着这一步的正文 ⇒ 看起来就是「第一步冒出一张 reply 卡」。**改法：`compact` 下注入提示行改为回合过程卡上该步小节里的一行**（`📥 注入上下文 · …`，渲染在叙述行与工具行之前），**不再为注入开任何步骤卡**；注入先于 `step/start` 到达时照旧缓冲、由那一步认领。**O21① 的意图（注入不能丢）保留**：回合过程卡存在时注入在它上面；整轮没有任何工具时，步骤卡（即答案卡）仍会带上注入行——所以一条提示**只会出现一次**，也**不会**为了渲染它而多出一张卡。中段正文（同一条消息既写话又调用工具）因此回到上一轮定下的行为，第一步不再有例外。
- **外部卡片之后另起新卡（`src/card-interleave.ts` 新）**：就地更新的卡会把新内容画在**它原来的位置**——一旦别的模块在它下面发了一张卡（📋 Todo List、任务卡、子代理名册、提问卡、压缩卡），继续就地更新就会让「最新的一行」出现在那张卡的**上面**，读起来是乱的。**只在真的有新内容时才开新卡**（同日真机教训）：提问卡一次是**三张连着**（问题卡 → 确认卡 → 作废卡），第一版实现「收到通知立刻开新卡」于是每次问答都刷出一张内容完全相同、只有耗时在变的 `⚙️ 本回合进行中 · 1 个工具 · …`，一轮 5 个问题的问答里 17 条消息有 9 条是这种碎片。现在收到通知只是**关掉当前分段**（旧卡冻结、不再增长），**下一件真事**（新的 `tool/call` 或新 step）才开新卡；被关掉的那张卡仍保留**时钟**（仍在跑的调用每 30 秒照旧刷新已耗时间，但不会多出一行），并在 `turn/end` 时**只改表头**写成终态（绿/红 + 工具计数），正文保持冻结——一张永远写着「进行中」的卡是假话。新增一个极小的注册表：`cardChannel.send`（所有**别的**模块发卡的路径，且只针对卡片、不含纯文本）在发送成功后 `note(chatId)`，压缩卡自己 `note`。回合过程卡收到通知就**结束当前分段**：屏幕上那张停更，下一次事件**新开一张卡**，只渲染从那之后发生的步骤/工具（标题里的计数仍是整轮总数；分段切在一个还没结束的 step 上时，那一步留在新卡里，否则它的后续工具行会落进一张永远不显示它们的卡）。`compact` 的答案卡同理：收到通知后本步这张卡**退休**，之后新到的正文**发新卡、只带新增的那部分**（`supersededFrom` 记录切点）。
- **过程卡只显示最新 5 步**（原来按 40 行预算，长回合约 20 步）：新增 `PROGRESS_MAX_STEPS = 5`，可见窗口是**最新的 5 个整步**，更早的整步（连同小节标题）折叠进 `collapsible_panel`；40 行仍作为外层上限保留（单步就可能几十行）。
- **运行中的工具不再显示 `0ms`**：没跑满 1 秒的调用显示 **`执行中`**（`turnCardRunningLabel`），超过 1 秒显示已消耗时间，并新增 **30 秒一次的重绘**（`PROGRESS_RUNNING_TICK_MS`）让这个时间真的在走——以前卡片是在调用刚开始时写的，那一行于是永远停在 `0ms`。**快的工具不付这笔开销**：计时器只在有调用仍在跑时存在，最后一个跑完就撤掉，没到 30 秒的调用一次都不会触发。

**验证**：`npm run typecheck` 0 error；**935 tests / 52 files 全绿**（本批新增 13 例：`tests/feishu-progress.spec.ts` 9 例——注入行顺序、只留最新 5 步且折叠计数正确、分段只渲染本段行而计数保持整轮、`执行中`→30s 重绘、快调用不排 tick、外部卡片后另起新卡且旧卡零更新、跨中断的「仍在跑的 step」留在新段；`tests/feishu-streaming.spec.ts` 3 例——注入 + 工具 + 叙述**只发一张回合卡**（注入与 `💬` 都在上面）、其他档位仍把注入留在步骤卡、外部卡片后简洁答案卡另起新卡且只带新增正文；`tests/card-interleave.spec.ts` 3 例——广播、退订、监听器抛错不打断发送；2 例钉住碎片回归——**连续三次中断通知只关分段、不新开卡**，以及被关掉的分段**只走时钟、不加行**）；`npm run build`（`lib/index.js` 676,881 → 686,794 B；`client/client.js` 未变，本批纯宿主侧）；**生效需要重启 dsh**。

**English**: Five follow-ups from the user's second look, each grounded in live evidence. First, the two card complaints share one root cause: EVERY turn's step 1 claims a `time-context` injection, and the old "an injection-bearing step must have a card" rule (O21①) therefore forced a step card on it — a card that also carried that step's narration, which is what read as "a stray reply at step 1". Injection notices are now one row of the turn card's step section, no card is opened for them, and O21① survives as content rather than as a card: the notice shows on the turn card when it exists and on the answer card when the turn ran no tool — exactly once, never a card of its own. Second, a new tiny `card-interleave` registry (`src/card-interleave.ts`): the channel's general `send` path (what every OTHER module posts cards through — todos, jobs, subagent panels, questions; plus the compaction card explicitly) announces that a card landed in a chat, and the long-lived compact cards end their segment there. The turn card stops updating and the next event that has something genuinely new — a tool call, a step — opens a NEW card below the interruption carrying only what happened since (the first implementation opened one immediately on every notice, so a question card, its confirmation card and its retirement notice each spawned an identical `本回合进行中` fragment: 9 of the 17 messages in one five-question exchange; a closed card now keeps only its elapsed clock alive and gets a header-only terminal render at `turn/end`) (counters stay turn-wide; a step that is still running stays in the new segment so its remaining rows stay readable), and `compact`'s answer card retires so further text arrives as a new card with only the new part. Third, the turn card keeps only the NEWEST FIVE steps visible (`PROGRESS_MAX_STEPS`); older whole steps fold away with their headers, and the 40-row budget stays as the outer bound. Fourth, a running tool no longer prints a frozen `0ms`: under a second it says `执行中`, after that it shows the elapsed time, and a 30-second tick repaints the card so that time actually moves — dropped as soon as the last call settles, so a fast tool pays nothing.

### 改进：中间回复不再单独发卡 + 简洁档卡片收紧（O22 第三轮，`src/feishu-progress.ts` / `src/feishu-streaming.ts` / `src/i18n.ts`，2026-10-09）

第二轮上线后使用者报了两条：**「模型中间的 reply 还是单独发，应该压到步骤卡片里面，或者不显示」**、**「compact 的步骤卡片行距太大，可以小一些」**。两条都按「压进去 + 收紧」处理，没有选「不显示」。

- **中间回复改判为「过程」，不再单独发卡**。判据取 WebUI 自己的定义：只有**不含 tool-call 块的正文消息**才算一轮的最终答案（`ui-chat/src/client/conversation-nodes/turn-process.ts` 的 `latestAnswer` 明确拒绝任何带 tool-call 的 assistant 消息），所以在**同一条消息里既写了话又调用了工具**的正文属于**过程叙述**。`compact` 下它不再开步骤卡（以前会被当成一次「回复」，一轮里出现好几张），而是作为**该步小节下的一行 `💬 …`** 落到那张回合过程卡上——只取首个非空行、空白折叠、80 字截断（过程卡是索引，正文归答案卡）。**判定发生在 `assistant/message`**：tool-call 块就在这条已组装消息里（`tool/call` 事件是之后才来的），所以在「本来要发卡」的那一刻就能判。**保留的例外**：该步带着注入提示行时步骤卡照发（注入行只渲染在步骤卡上，O21①），正文跟它一起留在卡上、不再往过程卡上重复一份；另外三档行为不变（中段正文仍各自成卡）。
- **简洁档答案卡收紧**：去掉 `📝 **消息**` 小节标题（这一档只有这一节，标题只是多一个空段落）、去掉正文与脚注之间的 `hr`、**脚注两行（`⏱/📥/📤` 与 `🚀/📊`）合并成一个元素**（每个元素都要各自付一次元素间距）、并给整张卡设 `body.vertical_spacing: 4px`。回合过程卡同样设为 4px（它整张卡就是一行行短文本，40+ 行时默认间距读起来像每行之间空一行）。**字段是实测的，不是猜的**：`cardkit.card.create` 静默容忍未知字段（坑 48），所以按坑 54 的办法在**一次性测试群**里逐案真发一次、随即撤回（`~/.dsh/probe-card-spacing.py`）——未知字段与非法取值分别被 `230099`（`2006 unknown property` / `11310` 取值）拒收，而 markdown 的 `margin`（`0px`、`4px 4px`、`0px 0px 8px 0px`、裸 `0` 均可）、`body.vertical_spacing`（`small|medium|large|extra_large` 或任意 px）**都被接受**；`body.vertical_spacing: 'none'`、markdown `padding`、`line_height` 则被拒。⇒ 新的关键坑 58。

**验证**：`npm run typecheck` 0 error；**921 tests / 51 files 全绿**（本批新增 13 例：`tests/feishu-progress.spec.ts` 6 例——`condenseStepNote` 取首行/折叠空白/截断/纯空白、小节下的 `💬` 行顺序与「无叙述则无该行」、`vertical_spacing`、懒开卡时叙述进入**首版**渲染、重复叙述不产生写入且只保留最新；`tests/feishu-streaming.spec.ts` 5 例——简洁档「带工具的消息」正文只落过程卡且**只发一张卡**、带注入的同类步骤仍发步骤卡且不重复、详细档行为不变、简洁档答案卡无小节标题/无 `hr`/脚注只有一个 notation 元素/间距 4px、详细档小节标题与 `hr` 仍在；另含既有 2 例回归）；`npm run build`（`lib/index.js` 672,376 → 676,881 B；`client/client.js` 未变，本批纯宿主侧）；**生效需要重启 dsh**。上一节记录的 908 tests 是本批开始前的数字，以本节为准。

**English**: Two things the user reported right after the second round: the model's mid-turn reply still arrived as a card of its own, and `compact`'s step card had too much spacing. Both are handled by folding and tightening — not by hiding. **A reply-bearing assistant message that also calls tools is process, not the answer**: the Web UI draws exactly that line (`ui-chat/src/client/conversation-nodes/turn-process.ts` → `latestAnswer` refuses any assistant message whose blocks contain a tool call), and the tool-call blocks are already inside the assembled `assistant/message`, so `compact` can decide at the moment it would have sent the card. Such text no longer opens a step card; it becomes one `💬 …` row under that step's section on the turn progress card (first non-empty line, whitespace squeezed, 80 characters — the card is an index, the prose belongs to the answer). A step that carries injection notices keeps its step card (notices render there and nowhere else), and the other three levels are unchanged. The `compact` answer card also loses chrome that only made it taller: no `📝 Message` section label, no `hr` before the footer, both footer lines in ONE element, and `body.vertical_spacing: 4px` on the card (the progress card too, whose every row is a short line). The spacing fields were **measured, not guessed**: `cardkit.card.create` silently tolerates unknown fields, so each candidate was really sent once to a throwaway group and deleted immediately — unknown fields and bad values come back as `230099` (`2006` / `11310`), while markdown `margin` and `body.vertical_spacing` are accepted (`none`, markdown `padding` and `line_height` are not). See key pitfall 58.

### 改进：所有「自动启动的回合」都有标记——与 Web UI 同一张触发来源表（`src/feishu-turn-origin.ts` / `src/feishu-streaming.ts` / `src/feishu-external-turns.ts` / `src/channel.ts` / `src/i18n.ts`，2026-10-08）

紧跟上一批：外部入口的回合已经能回显、收尾、交付，但**步骤卡**上只有后台任务那一种标记（`tool-jobs` → 「本回合由后台任务完成通知触发」），定时提醒 / 子代理 / 团队消息等自动启动的回合在飞书侧看不出「谁把它叫醒的」。

- **用上游自己的触发器表**：DSH Web UI 的 `ui-chat/src/client/chat/turn-trigger.ts` 就是这件事的权威清单，逐项对齐——`tool-jobs`（后台任务状态更新）· `schedule`（自动化任务）· `subagent-settled`（子任务状态更新）· `agent-message`（收到任务消息）· `team-message`（收到团队消息）· `goal`（继续执行目标）· `webhook`（收到外部事件，`provider: github` 时是 GitHub 事件）· `cordis-host-runner`（插件状态更新）· 其余非人类来源兜底「收到执行请求」。**文案照抄 Web UI 的中英用词**，同一个事件在聊天与 GUI 里叫同一个名字。
- **宿主侧唤醒点逐个核对过**（`followup()` 调用点 = 能在空闲 owner 上开新回合的地方）：`jobs/tool-jobs`、`schedule/schedule/src/runtime.ts`、`subagent/subagent`（结算与 `agent-message`）、`webhook/webhook/src/session.ts`、`goal/goal-round-driver` —— 全部落在上表里；`api/session-controller` / `acp` / `sdk` / `headless` 的 `user` 来源是人类入口，不算自动启动。自定义/未知来源走兜底家族，**只报家族名、绝不贴 `source` 里的自由文本**（坑 50）。
- **两条判定规则（都对齐 Web UI）**：① **人类消息拥有这一回合**——人类先说话，则本回合里后来被认领的通知不再算触发器（既有「忙回合里被注入的通知不算触发」测试语义不变，也避免 Web GUI 回合被后台通知抢标）；② **具名家族优先于兜底**——新会话的第一个回合先认领指令注入（`agent-instructions` → 兜底「收到执行请求」），随后真正的唤醒者（如 `schedule`）把它升级成具名家族；反过来，兜底项遇到人类消息会被**撤下**。
- **两处标记**：步骤卡首行 `⚡ 本回合由**<家族名>**自动触发`（回合级属性，每个 step 都带）；收尾卡首行改成**具名来源**——`💬 本回合的来源是**Web GUI**` / `**自动化任务**` / `**后台任务状态更新**`…，不再是笼统的「Web GUI / 后台任务」。

**验证**：`npm run typecheck` 0 error；**883 tests / 50 files 全绿**（新增 13 例：触发表 3、回合归因 5、步骤卡具名/升级/撤销 3、收尾卡具名与兜底 2）；`npm run build`。**生效需要重启 dsh。**

**English**: Follow-up to the previous entry. External turns could already be mirrored and completed, but only ONE automatic way to start a turn was marked on the step cards (a settled background job). The marker is now driven by the DSH Web UI's own turn-trigger table (`ui-chat/src/client/chat/turn-trigger.ts`), with the same names in both languages: `tool-jobs`, `schedule`, `subagent-settled`, `agent-message`, `team-message`, `goal`, `webhook` (GitHub flavour when `provider: github`), `cordis-host-runner`, and a generic "Execution requested" family for any other non-human source (named, never quoted). Every host-side `followup()` call site that can open a turn on an idle owner was checked and lands in that table: `jobs/tool-jobs`, `schedule/schedule`, `subagent/subagent`, `webhook/webhook`, `goal/goal-round-driver`; the `user` sources of `session-controller` / `acp` / `sdk` / `headless` are human entrances. Two rules, both mirroring the Web UI: a human message owns its turn (a notice claimed later in it is not a trigger), and a named family beats the generic fallback (a fresh session claims its instruction injection first, then the real waker upgrades it; the generic guess is dropped once a human message arrives). Step cards now lead with `⚡ This turn was started automatically: **<family>**`, and the completion card names the source (`Web GUI`, `Automation task`, `Background task updated`, …). typecheck clean, 883 tests across 50 files green (13 new), artifacts rebuilt.

### 新增：外部入口的回合也完整镜像到飞书（Web GUI / 后台任务 / 定时任务）+ 飞书界面提示词（`src/feishu-turn-origin.ts`（新）/ `src/feishu-surface.ts`（新）/ `src/feishu-external-turns.ts`（新）/ `src/harness.ts` / `src/channel.ts` / `src/config.ts` / `src/i18n.ts` / `src/index.ts`，2026-10-08）

操作者的问题：「绑定飞书会话、但我在 Web GUI 操作会发生什么」——答案是**飞书只看到过程、看不到收尾**。`channel.ts` 只处理它自己分发的回合（收到飞书消息 → prompt → 回复卡 + Turn Complete 卡 + 交付），所以 Web GUI 发起或后台任务唤醒的回合在飞书侧只有步骤卡：**没有「谁问的」，没有收尾卡，也没有 `present` 的交付面**（`renderFooterCard` 全仓只有 `channel.ts` 那两处），而模型那一轮看到的提示词恰好是「你在 Web GUI 里 + present 有 native-open」，于是它既不会调 `feishu_send_file`，飞书也不会收到任何交付物。这就是 TODO O25 记的「仍未做：WebUI 触发的轮次没有交付卡」。

**这一批用原生机制补齐三件事**（不改 DSH 源码、不改会话记录格式、不新增 `MessageSourceMap` kind、不遮蔽上游任何 section）：

- **回合来源判别**（`feishu-turn-origin.ts`）：DSH 的 `SessionPromptRequest` **没有客户端身份字段**（只有 `requestId` / `mode` / `content` / 可选 `clientTimeZone`），所以来源从原生 `user/message.source` 读——插件 mint 的 `requestId` 被 session-controller **原样**写进 `source.rpcId`（`commands.ts`），因此「这条用户消息是我替飞书发的」可以精确匹配；走 `agent.steer/followup` 直连的图片/文件消息（无 `rpcId`）记一次性标记，且**只被「带附件的下一条消息」消费**（别的 surface 发一条纯文本插不进来）；其余 `kind:'user'` 即其它入口（`clientTimeZone` 由浏览器客户端带、我们从不带，**只用来区分「Web GUI」与「其它入口」的文案**，不用来判定来源）。判定是**逐回合**的：`turn/start` 重置、本回合第一条用户消息定调 ⇒ Web GUI 的插话不会把正在跑的飞书回合改判成外部回合。
- **回显用户消息**：外部入口的用户消息以**纯文本**（150KB、不经 markdown ⇒ 不会被图片/链接语法整卡拒收）发进该会话的**话题**（硬规则 3），前缀 `💬 Web GUI：` / `💬 其它入口：`；**一期不上传附件**，只写「（附件：N 张图片、N 个文件，未镜像到飞书）」。实现上是渲染 `user/message` 事件——Web GUI 显示飞书消息用的就是同一份会话事件流，方向反过来而已。
- **收尾 + 交付**：`turn/end` 时对**绑定会话中非飞书发起**的回合（含后台任务唤醒、定时任务这种根本没有用户消息的回合）复用：streaming 的 `flushed()`（这正是「收尾卡必须排在最后一张步骤卡之后」的保证）、`renderFooterCard()`（新增可选的 `externalTurn` 标记，卡首行写「💬 本回合不是从飞书消息发起的（Web GUI / 后台任务）」）、以及**同一个 deliver 控制器**（`plan` + `autoSend`，可点行 token、话题登记、文档自动投递与飞书发起的回合完全同一条路径）。**飞书发起的回合仍由 `channel.ts` 独占** ⇒ 一个回合不可能出现两张收尾卡。
- **飞书界面提示词**（`feishu-surface.ts`）：用 `systemPrompt.section`（`inject` 动态注入，**与 Web bundle 的 `app:web-surface` 完全同形**、同一个 `WEB_SURFACE` 顺序槽，排在 `ui:deliverable-file-references` 之后，正好就地纠正那句 native-open）补一句只有本通道知道的事实：用户在飞书聊天里、打不开本地路径、`present` 落在回合末交付卡上（媒体内联 / 白名单文档自动发 / 其余点一下）、要「能保存或转发的原件」或「回合没结束就要给」就调 `feishu_send_file`。`text` 是 provider：**非绑定飞书的会话返回空串**（别人的提示词一个字节不变）；文案**每会话稳定、不随回合变**——因为交付面补上之后，这句话对任何回合都成立 ⇒ 组装出的提示词在绑定期间永不变化（变化的系统提示词会让上游**追加**一条 `system/message` 节点并使缓存前缀失效）。两个开关 `surfaceContext` / `mirrorExternalTurns`（都默认开，形状与上游 `surfaceContext` 一致）。

**明确没做**：外部回合若「最后一张步骤卡写入失败」不会回退发正文卡（发起方通常正看着 Web GUI；飞书发起回合的那条回退仍在 `channel.ts`）；附件不上传；O3 的 `produced` 口径（write/edit 产出的文件）不在本条。

**验证**：`npm run typecheck` 0 error；**870 tests / 50 files 全绿**（新增 30 例 / 3 文件：`tests/feishu-turn-origin.spec.ts` 11 例——minted `rpcId` 命中 / 外来 `rpcId` 按 `clientTimeZone` 分 Web GUI 与其它入口 / 宿主注入 kind 不算外部 / 跨会话不误配 / TTL 过期 / 逐回合定调且插话不改判 / 直连标记只被附件消息消费 / 直连标记过期；`tests/feishu-surface.spec.ts` 7 例——注册名与 `WEB_SURFACE` 槽、绑定会话出文案、非绑定与诊断组装为空、开关关掉为空、开关**实时读取**、文案里不含 native-open、disposer 幂等；`tests/feishu-external-turns.spec.ts` 12 例——文本/附件/非浏览器三类回显与话题坐标、自己分发的消息不回显、宿主注入不回显、开关关掉与未绑定不动作、外部回开发收尾卡（含标记行 + `plan`/`autoSend`/话题登记）、飞书发起的回合不发第二张、无用户消息的后台回合照样收尾、`describeExternalMessage` 的空消息与超长截断）；`npm run build` 产出 `lib/index.js` + `client/client.js`；**生效需要重启 dsh**。

**English**: A session bound to one Feishu chat can also be driven from the Web GUI, and turns started there (or woken by a background job or a schedule) reached the chat as step cards only: no message above them, no Turn Complete card, no `present` delivery — while that turn's prompt said "you are in the Web GUI" and "present gives preview and native-open", so the model never called `feishu_send_file` and nothing was delivered. The fix uses only native mechanisms (no DSH patch, no new session event, no new `MessageSourceMap` kind, no shadowing of upstream sections): a **turn-origin** module reads the native `user/message.source` (the session controller writes this plugin's `requestId` verbatim into `source.rpcId`, so a message this plugin dispatched matches exactly; a direct `steer`/`followup` carries no id and is covered by a one-shot marker consumed only by the next message that has an attachment; `source.clientTimeZone` merely labels the echo as "Web GUI" vs "another surface"). The origin is decided **per turn** from its first user message, so a Web GUI steering message cannot relabel a running Feishu turn. Other surfaces' user messages are echoed into the same topic as plain text (attachments are named, not uploaded in phase one), and `turn/end` for a non-Feishu turn posts the **same Turn Complete card** — with a first line saying so — and runs the **same delivery pipeline**, reusing streaming's `flushed()` so the footer can never overtake the final step card; a Feishu-started turn stays owned by `channel.ts`, so no turn can produce two footers. Finally, a **Feishu surface prompt section** — the exact shape of the Web bundle's `app:web-surface`, in the same `WEB_SURFACE` slot and after `ui:deliverable-file-references`, so it reads as the correction of the native-open promise — tells a bound session where the user is; its provider returns `''` for any other session, and the text is stable per session (after this change no part of it depends on where the turn came from, so the assembled prompt never changes and no extra `system/message` node or cache invalidation is produced). Two settings, both default on: `surfaceContext` and `mirrorExternalTurns`. Verified with typecheck clean and **870 tests across 50 files green** (30 new across three specs). Known gaps: no text fallback when the final step card failed on an external turn, attachments are not uploaded, and O3's `produced` files are untouched.

### 修复：问题卡片——选项描述终于显示、单选改成「整行可点 + 确认卡」、选项不再被截断、多选题可以作答（O24，`src/feishu-questions.ts` / `src/i18n.ts`，2026-10-07）

操作者的原话是「在 WebUI 中，每个选项下面都有一个具体的描述，但在我们这里只有选项，没有选项的描述」，本轮他判定这是**最影响使用的缺口**。根因全在渲染层，上游一路都给足了数据（`AskUserQuestionOption.description`、`AskUserQuestionItem.multiSelect` 都是随 `user-questions/request` 一起到的持久字段）：

- **描述从未被读取**：卡片正文只拼 `header / question / detail`，选项**只**做成按钮、按钮文字就是 `option.label`。现在**单选题的每个选项本身就是整行可点的内容**（但**点一下不会直接作答**：先弹一张确认卡，见下）（`interactive_container`，与工作区选择面板、交付清单同一形状：`width:fill` + `has_border:false` + `padding:4px 12px`），行内是 `1. **标签**` + 一行 `description`（`text_size: notation`）——**点一下选中的就是这一项**（但要过确认卡才结算），不再有「选项 → 序号按钮 → 自己对照」这一步，**也没有任何选项按钮**；结算卡同样带描述，并用 `✅`/`⬜` 标出选中项。
- **第 7 个选项起凭空消失**：`options.slice(0, 6)` 是插件自己造的上限、不是飞书边界，已删除（不另设上限；卡片真正的硬边界仍是关键坑 42 的 200 元素 / ~30KB）。
- **多选题不再把选项写两遍**（操作者 2026-10-07 反馈「主干会显示选项，选项也会显示，太重复了」）：正文只留一行提示，**复选框自己带标签 + 描述**（`checker.text` 用 `lark_md`：`1. **标签**` 加粗、描述换行在下；该 tag 已用**发送校验器**验过会被接受）。
- **多选题在飞书侧原本答不出来**：`multiSelect` 过去只改按钮配色（`default` vs `primary`），点一下仍然只回一个 label。多选题**不用可点行**（每次勾选都要重绘卡片 → 撞坑 11），而是渲染成 `form` + **每个选项一个 `checker` 复选框**（正文保留带描述的选项列表）+ 一个「✅ 提交」按钮，**一次提交带回全部勾选项**（`form_value = {"opt_0":true,"opt_1":false,…}`）——过程中没有任何就地重绘，天然避开「带按钮的卡改 2–3 次后回调失效」（关键坑 11）。
- **回退安全**：若租户/客户端拒收复选框卡，发送失败后**自动重试一次「只放序号」的单选卡**，问题不会因为控件不支持而丢失（新用例覆盖）。
- **点选即冻结 + 两个出口都以「旧卡变灰 + 发新卡」收尾**（操作者 2026-10-07 第二轮要求）：点一行后**立刻**把问题卡改成无交互的灰卡（`⏳ 已选择 **标签**，请在下方确认卡上确认或返回。`，行与按钮全部移除）；然后 ① 按「✅ 确认提交」→ **结果作为一张新卡发出**（已选态 ✅/⬜），原问题卡变灰「本题已提交，结果见下方新发的卡片」；② 按「↩️ 返回」→ 原问题卡变灰「已作废」，**新发一张可交互的同一张问题卡**。两条出口的终态一致：**问题卡永远不再复用**。结果卡发不出去时回退为「直接把结果写进问题卡」（否则结果无处可见）；跳过 / 自定义回答 / 多选题提交仍是单次交互，保持原地结算。
- **可点行必须防误触（操作者 2026-10-07 要求）**：整行点击的命中面积大，点错了答案就错了。现在点选一行只**弹确认卡**（`📋 确认提交`：显示将要提交的选项 + 描述，按钮「✅ 确认提交」/「↩️ 返回」），只有「确认提交」才结算；「返回」把确认卡与那张问题卡**一并改成灰卡**，并**另发一张可交互的问题卡**（首版写的是「返回后原问题卡还能继续选」，真机验收证否：被点过的可点行不再投递回调，见下方 15:37 那段与关键坑 55）。确认卡带按钮 ⇒ **最多只写一次**：换选另一个选项时**发新卡并退休旧卡**（不就地改），因此不碰坑 11。取消/被 WebUI 抢先/Turn 中断时，确认卡也会被一并退休（问题卡与确认卡各写一次）。**确认卡发送失败不能变成死路**：此时直接按原选择提交并留 warning（问题不会卡住）。跳过与自定义回答不受影响（它们本来就不是「一下即生效」的误触路径）。
- 顺带修掉：卡片里的「自定义回答」提示 / 占位 / 按钮 / 跳过按钮此前**硬编码中文**，`i18n.ts` 里的键早就存在却没接上，现按当前语言渲染。
- **确认卡文案与实现对齐**（2026-10-07 复审文档时发现）：确认卡上写的还是首版口径「点错了就按『返回』——问题卡片仍然可以继续选别的」/「已返回。问题卡片仍然可以作答」，而「返回」的实际行为是**作废这张卡 + 另发一张新的问题卡**（下面 15:37 那段就是它被迫改的原因）⇒ 改成「这张卡会作废，并另发一张新的问题卡给你重选」/「已返回。这张确认卡已作废，请在下方新发的问题卡上继续作答」，英文同步（`questionConfirmNote` / `questionConfirmBacked`）。

**探针发现（已固化为关键坑 54）**：`cardkit.card.create` **容忍未知字段**（只有伪造 tag 才会被拒），所以它证明不了字段名；而 `im.v1.message.create` **严格校验**——给 `checker` 塞 `options` 直接被拒（`200621 unknown property`），且**被拒的卡不会发出去**，于是「真发一次」成了**免费的字段探针**。实测结论：`checker` 是**单个复选框**（`text` + `checked`，**没有 `options` 字段**），多选 = 每个选项一个 checker（`name` 各异），回调形状 `form_value = {"c1":true,…}`。

**验证**：`npm run typecheck` 0 error；**840 tests / 47 files 全绿**（`tests/feishu-questions.spec.ts` 由 11 例增到 22 例：选项整行可点且无按钮、结算卡带描述、8 个选项全渲染（旧上限外）、多选 = 每项一个 `checker` + 一次提交、未勾选不结算 + 列表形状容错、复选框卡被拒时回退单选、返回时**重发新问题卡**、重复点同一项忽略、确认卡发不出去时直接提交、别处答完后退休确认卡、自定义回答 i18n 接线）；`npm run build` 产出 `lib/index.js`。**多选控件真机验证（2026-10-07 14:14）**：先经 `cardkit` 探针确认 tag 存在（伪造 tag 对照被拒），再向操作者发一张三复选框试验卡，勾选三项提交后 journal 读回 `[q] probe=checker form_value={"c1":true,"c2":true,"c3":true}` ⇒ 复选框**渲染成功**且**每项只带回一个布尔**，与实现的解析口径一致。**真机端到端验证（2026-10-07 14:29–14:30，重启后）**：在飞书里真发一张 **8 个长选项**（每项都带描述，标签 20–30 字）的单选卡 + 一张 **5 选项多选卡** —— ① 正文 8 条「序号 + 标签 · 描述」与 **8 个序号按钮**全部渲染（那一轮还是「序号按钮」；15:37 的确认卡验收才把它换成整行可点），操作者点第 3 项，答案按 label 正确结算（`O3 补 produced 交付物`），即第 7、8 个选项**不再被截断**；② 多选卡勾 3 项后**一次提交**，journal 读回 `[q] multi-submit form_value={"opt_0":true,"opt_1":true,"opt_2":false,"opt_3":true,"opt_4":false}`，工具侧收到 3 个 label ⇒ 复选框卡走的是**主路径**、没有触发单选回退；③ 操作者确认「描述都显示了 / 序号按钮点下去是那一项 / 多选提交顺手」三项到位。**确认卡真机验收（2026-10-07 15:37–15:38，重启后）踩到一个真 bug，已修**：操作者点第一行 → journal 出现 `value={"selected":["照搬 WebUI 的 produced 口径：…"],"type":"answer-open"}`（行可点、长标签原样带回）→ **另发了一张确认卡**（回调来自新的 message id）→ 按「↩️ 返回」→ **再点选项行就没有任何回调了**（`[card]` 那行日志是无条件打的，`src/index.ts:557`：这段时间一条都没有），**而同一张卡上的「⏭️ 跳过本题」按钮照样能回调**。⇒ 判定为**飞书客户端侧的行为**：**一张卡上的 `interactive_container` 行一旦被点过一次，这张卡后续的行点击不再投递回调**（普通 `button` 不受影响）。修法：①「↩️ 返回」不再只是清状态，而是**重发一张全新的问题卡**，并把用过的那张改成灰卡（「已作废…请使用下方新发的同一张问题卡」）；② 所有回调**按 `evt.messageId` 认卡**——确认卡的回调只认当前确认卡、其余只认当前问题卡，**旧卡上的点击一律忽略**（否则旧卡能再开一张确认卡）。⇒ 修复后二轮真机验收通过（2026-10-07 15:44–15:46）：4 次回调分别来自 **4 个不同的 message id** —— ① `answer-open`（原问题卡）→ ② `answer-back`（确认卡）→ ③ **`answer-open`（「返回」后新发的那张问题卡）**←这一步就是原先丢回调的地方，现在通了 → ④ `answer-confirm`（新的确认卡，**「✅ 确认提交」此前从未真机点过，这次也通了**），工具侧收到所选 label。三条路径（行可点 / 返回重发新卡后仍可点 / 确认提交）全部真机通过。注意：卡片正文**读不回来**（`im.v1.message.get` 只回「请升级至最新版本客户端」），这类结论只能靠回调日志 + 使用者目视（关键坑 26）。**生效需要重启 dsh。**

**明确没做**：`plan-review` 意图不渲染（上游只有接收端、没有发送端，模型造不出来，等上游）；选项数照旧不设自造上限，真撞到卡片元素预算时按步骤卡相位那套处理。

**English**: The question card had three rendering defects, all fixable without waiting for upstream, which already ships `AskUserQuestionOption.description` and `AskUserQuestionItem.multiSelect` on the request event: the option descriptions were never read (the body only carried header/question/detail and every option became a button labelled with its own text), options past the sixth were dropped by a self-invented `slice(0, 6)`, and a multi-select question could only ever return one label (`multiSelect` merely changed the button colour). Each single-select option is now a **full-width tappable row** (the same `interactive_container` as the workspace picker and the deliverable list: the label and its description live in the row and there are **no option buttons** at all), and one tap does **not** settle the answer — it freezes that card into a button-less grey card and posts a **confirmation card** (`✅ Submit` / `↩️ Back`). Submit posts the **result as a new card** and greys the old one; Back greys the spent card and **posts a fresh question card**, because the Feishu client consumes a tapped `interactive_container` row and that card then never delivers further row taps (key pitfall 55) — so callbacks are matched by `evt.messageId` and taps on a superseded card are ignored. Settled cards keep the descriptions and mark the picked rows with `✅`/`⬜`, the six-option cap is gone, and a multi-select question renders one `checker` checkbox per option in a form plus a single Submit — **one submission carries every check** (`form_value = {"opt_0":true,…}`) with no card re-render at all, sidestepping the callback death after 2–3 in-place updates (key pitfall 11). If a tenant or client rejects the checkbox card, the send retries once as a single-pick index card so the question is never lost, and the custom-answer controls are finally translated instead of hardcoded Chinese. The probe finding behind the shape is now key pitfall 54: `cardkit.card.create` **tolerates unknown fields** (it only rejects made-up tags), while `im.v1.message.create` **validates them** — a `checker` with an `options` field is refused with `200621 unknown property`, and a refused card **is never posted**, which makes a real send a free field-name oracle. `checker` is a single checkbox (`text` + `checked`, no `options`), so multi-select means one checker per option, and the live tap returned `form_value = {"c1":true,"c2":true,"c3":true}`. Verified with typecheck clean, 840 tests across 47 files green (11 new in that spec), and a rebuilt `lib/index.js`; a restart is required.

### 新增：`present` 交付物按类型投递——文档自动发、其余确认后发、媒体卡内内联（O25，`src/deliver-files.ts`（新）/ `src/feishu-deliver.ts`（新）/ `src/feishu-send-file.ts` / `src/channel.ts` / `src/config.ts` / `src/client/` / `src/i18n.ts`，2026-10-07）



原来 `present` 只做了一件事：把路径列成 Turn Complete 卡上的一行。清单本身没错，但**清单就是终点**——真机扫过的 13 次 `present` 里只有 1 次真正送达（那一次还是模型自己额外调了 `feishu_send_file`），而卡片根本没有文件组件，`.md` / `.csv` / `.zip` 这类文件在卡上**无处可放**（关键坑 42），于是那行永远是「点不动的路径」。本次按操作者 2026-10-07 拍板的四条口径补齐投递：

- **媒体（图片 / 视频 / 音频）**：**卡内内联**（复用既有 `card-images.ts` 水合器，不额外发消息），但行上**写出文件名**——内联图片的 alt 只是悬停提示，不写名字就看不出收到的是哪个文件；引用仍写成 `[预览](路径)` 交给水合器上传。
- **文档白名单**（`pdf` / `doc` / `docx` / `ppt` / `pptx` / `xls` / `xlsx`）：不超过新设置项 **`deliverDocMaxMb`**（1–30，默认 30 = 飞书文件接口硬顶）就**自动发成原生文件消息**，行尾标 `自动投递`——**故意不写「已发送」**，因为这一行在推送之前就已渲染好，失败另有文字提示。**单轮最多自动发 8 个**（`DELIVER_AUTO_CAP`）——聊天消息撤不回，超出的文档与其余文件一样变成可点行，由操作者点。
- **其余文件**（源码、`.md`、`.csv`、压缩包……）与**超限文档**：交付清单里变成**可点行**（`interactive_container`，即工作区选择面板那种整行可点样式），点一下弹**确认卡**，只有按下「📤 发送」才真正投递。这是操作者的要求（聊天消息撤不回），也是本次唯一新增的交互。
- **超过飞书 30MB / 文件已不存在 / 落在会话工作区外**：不给按钮，行内直接写原因——一个点了没反应的按钮比没有按钮更糟。

实现要点（安全与有界是硬要求）：

- **回调里绝不放路径**。[`src/feishu-deliver.ts`](./src/feishu-deliver.ts) 为每个可点行发一个**不透明 token**（`randomUUID`），登记「会话 / 聊天 / 工作区 real root / real 绝对路径 / 大小 / 描述 / 时间戳」；token **30 分钟过期、最多 200 个**，每次点击都**重新校验**（文件仍在、是普通文件、非空、≤30MB、`realpath` 仍在工作区内）——卡片发出后把文件换成指向工作区外的符号链接，点击一样会被拒。
- **自动发送天然有界且去重**：走的是从 `feishu_send_file` 抽出来的同一个 `sendWorkspaceFile`（`src/feishu-send-file.ts`），**每次发送都套 120s 上限**（SDK 的 HTTP client `timeout: 0`，此前工具路径其实没有上限——顺手补上关键坑 29 的这处缺口）；`src/deliver-files.ts` 记「本会话 10 分钟内已发过这个路径」，所以模型已经显式 `feishu_send_file` 过的文件不会因为 `present` 再发一遍。失败只发一条文字说明，不抛错（确认卡回调抛错会杀进程，见 `card-dispatch.ts`）。
- **清单与投递不会被「没有步骤卡」那条路径吃掉**：`channel.ts` 现在在发卡**前**规划交付物，把行的渲染交给新模块；没有步骤卡承载正文的回退分支**只在真的有交付物时**补发 Turn Complete 卡（顺带补上 O3 里「回退分支不带 `turnStats`」的缺口）。
- **确认卡只被改一次**（点「发送」/「取消」后结算），Turn Complete 卡本身**只发不改**，因此不碰「带按钮的卡就地更新 2–3 次后回调失效」（关键坑 11）；确认卡与随后的文件消息一律用**这张卡自己的话题**（硬规则 3 / 关键坑 31）——两层保证：规划时就把话题存进 token，同时 `channel.ts` 把交付卡的 message id **登记进 `card-topics`**（新增 `noteCardTopic` 接线），所以点击**不再依赖**「按群最近使用」的兜底（评审发现的缺口：这张卡此前从没登记过，多话题群里会把确认卡与文件发进另一个话题）。同一轮评审还顺手补了两个会在自动路径上咬人的旧隐患：**封面帧上传**（`im.v1.image.create`）此前没有超时上限；内联失败回退成文件消息时，若失败原因正是**我们自己的 120s 超时**则不再回退（超时不是拒绝，回退会把同一个文件发两次）。
- 新设置项落在 WebUI 插件设置页（`deliverDocMaxMb`，中英双语说明），`.volatile()` 热生效不重启。

**明确没做的**：① WebUI 触发的轮次**仍然没有任何交付卡**（完整卡只在飞书入站那条链路上发，O3 的剩余部分），本次只覆盖飞书触发的轮次；② **提示词层未动**——`ui-deliverables` 那条全局 system prompt 仍会让模型以为「已经交付了」（关键坑 52 / O25 的 C 方案），文档类现在至少会真的送达，但模型的行为没有被纠正；③ 清单仍最多显示 10 行（超出只计数），第 11 行起的文件不会自动投递也不会给按钮；④ 交付清单**有意不去重**（同一文件可能既内联又作为文件消息出现一次）。

**验证**：`npm run typecheck` 0 error；**829 tests / 47 files 全绿**（新增 42 例：`tests/feishu-deliver.spec.ts` 31 例覆盖分类 / 规划 / 自动投递上限 / 渲染 / 自动投递 / 去重 / 失败通知 / 点击确认 / 取消 / 串聊拒绝 / 文件消失 / 符号链接逃逸 / 过期与淘汰 token / 计划期话题优先 / 双击只发一次 / dispose；另加 `channel.ts` 接线 4 例、footer 渲染与媒体水合 2 例、配置与设置页钳制/一致性 3 例、共享发送器超时与工具记账 2 例）；`npm run build` 产出 `lib/index.js` + `client/client.js`；两张新卡形态另经**真机 `cardkit.card.create` 探针**验证（`code=0`，只建实体不发消息）。**生效需要重启 dsh**。

**真机验证（2026-10-07 13:08–13:23，重启后）**：一轮真实对话里用 `present` 声明三份探针文件（PDF / PNG / Markdown），再用 `im.v1.message.list` **回读聊天**核对：① 13:09:02 的 Turn Complete 卡**第一个元素就是 `img`** ⇒ `still.png` **卡内内联**（媒体分支，且行上写了文件名）；② 13:09:03 收到 **`file` 消息 `report.pdf`** ⇒ 文档分支**自动送达、无需任何点击**；③ 13:22:58 点击 `notes.md` 那一行（回调载荷实测只有 `{"p":"deliver-open","token":"…uuid…"}`，**不含路径**）→ 13:22:59 弹出 **「📤 文件投递」确认卡** → 13:23:03 按「📤 发送」→ 13:23:04 收到 **`file` 消息 `notes.md`**。三条分支（媒体内联 / 文档自动 / 其他确认）**全部真机通过**；客户端侧新设置项需刷新页面后可见（client bundle 已重建）。

**English**: `present` used to end at a line on the Turn Complete card, and that line cannot be tapped — a card has no file component (key pitfall 42), so 12 of 13 real `present` calls delivered nothing. Per the operator's 2026-10-07 decisions, delivery now splits three ways: **media** stays inline in the card via the existing hydrator (with the FILE NAME written out, since an inlined picture's alt text is only a tooltip); **office documents** (`pdf`/`doc`/`docx`/`ppt`/`pptx`/`xls`/`xlsx`) under the new `deliverDocMaxMb` setting (1–30 MB, default 30 = Feishu's file ceiling) are pushed as native file messages by themselves (at most **8 per turn**, `DELIVER_AUTO_CAP`) and labelled `auto-delivery` — deliberately not "sent", because the row is rendered before the push and a failure reports itself separately; **everything else** — and any document over the setting — becomes a tappable row (`interactive_container`, the workspace picker's whole-row shape) that opens a confirmation card, where only its Send button delivers. Files over 30 MB, missing files and paths outside the session workspace get an explanatory row instead of a dead button. A callback never carries a path: each row carries an opaque token (30-minute TTL, 200-entry cap) whose entry is re-validated on every tap — still present, a regular non-empty file, ≤30 MB, and still inside the workspace on its REAL path, so a symlink swapped in after the card was built is refused. Auto-delivery reuses the same `sendWorkspaceFile` the tool now uses, every send is bounded at 120 s (the old tool path was unbounded — a latent pitfall 29 hole), and `deliver-files.ts` suppresses a file the model already sent with `feishu_send_file` in the same session. The fallback reply path (no step card carried the text) now also posts the footer, but only when there really are deliverables. Confirmation cards settle with one update; the Turn Complete card is never edited, so pitfall 11's callback death does not apply, and both the confirmation and the file message resolve their topic from that card's own topic (pitfall 31) — the plan stores it in each token AND `channel.ts` now registers the delivery card's message id in `card-topics` via a new `noteCardTopic` hook, so the chat-level "most recent topic" guess is no longer relied on (this card had never been registered, which would have sent the confirmation and the file into another topic of a multi-topic group). The same review closed two older hazards on the automatic path: the cover-frame upload (`im.v1.image.create`) had no timeout, and an inline-failure fallback no longer runs when the failure was our own 120 s timeout (a timeout is not a rejection — retrying as a file would deliver the same file twice). Not done: WebUI-triggered turns still get no delivery card at all, and the global `ui-deliverables` prompt that tells the model `present` already delivered is untouched (pitfall 52). Verified with a clean typecheck, **829 tests in 47 files** (31 deliver-module cases plus 11 elsewhere), a production build, and a live `cardkit.card.create` probe of both new card shapes (`code=0`, entities only — no messages sent); a dsh restart is required for it to take effect. **Live verification (2026-10-07 13:08–13:23, after the restart)**: one real turn declared three probe files (PDF / PNG / Markdown) with `present`, and reading the chat back through `im.v1.message.list` confirmed all three branches — the Turn Complete card at 13:09:02 leads with an `img` element (the PNG inlined, with its file name written on the row), `report.pdf` arrived as a `file` message at 13:09:03 **with no tap at all**, and tapping the `notes.md` row (whose callback payload carried only `{"p":"deliver-open","token":"<uuid>"}` — no path) opened the confirmation card at 13:22:59, whose Send button delivered `notes.md` at 13:23:04. The new setting needs a page refresh to show up, since the client bundle was rebuilt.

### 文档：README / 设计文档按 rc.2 与已上线能力刷新（2026-10-02，零代码改动）

升级之后做的一次**文档体检**，找出并修掉三处已经过时的说法（都不涉及代码）：

- 🔴 **安装要求写错了整整一个大版本线**：README 仍写「要求 DSH `0.1.5-alpha.1` 或更高（同一 `0.1.5` 预发布线）」，而插件实际的 peer 范围早已是 **`^0.2.0-rc.1`**。更糟的是 DSH 0.1.7 起有**版本闸门**（peer 不满足就静默跳过加载），照着旧说明装会直接装不上。已改成「要求 DSH `0.2.0-rc.1` 或更高（同一 `0.2.0` 预发布线，已在 `0.2.0-rc.2` 实测）」，并说明同一 `0.2.0` 线内升 `rc.2` 无需改动。
- 🔴 **已上线的能力在 README 里查不到**：4 档工作展示（`transcriptView`，含「开关只能减不能加」的合成规则）、可折叠的思考面板与压缩摘要、**上下文注入提示行**、**压缩卡**（自动压缩与 `/compact` 都会发）——README 的能力表、`/display` 命令行、配置项说明都还是这批能力之前的样子（`/display` 只写了四个布尔开关，压缩那段还写着「本插件不订阅 compaction」）。中英双语表都已补齐，并新增 `transcriptView` 配置项说明。
- ⚠️ **一处会让人以为卡上有数的说法**：README 两处写「reasoning 标题带思考耗时与**思考 token**」。思考 token 取不到（见上一条结论），已改成只写耗时并指向原因。
- ℹ️ `docs/transcript-parity-design.md` 的基线从 `0.2.0-rc.1`（`4878cdabd8`）刷新到 `0.2.0-rc.2`（`639ed01539`）：核实 `packages/llm/llm/src/message.ts` 在两版之间**零改动**（`MessageSourceMap` 仍在第 110 行），状态行从「§3 待拍板、尚未动代码」改为「三件事都已实现」，并在「已实现」表里补上折叠可见性那一项。**顺带查出一件新事**：rc.2 给 `MessageSourceMap` 加了第 29 个声明者 —— `user-questions` 的 `user-question-reply`（timed 问答的迟到答案），已记为坑 50 与 TODO；本部署 `Config.mode` 仍是 `legacy`，所以它还从未在真机上出现。

**English**: documentation-only pass after the rc.2 upgrade. The README's install requirement still named DSH `0.1.5-alpha.1` while the plugin's peer range has been `^0.2.0-rc.1` for a while — and since DSH 0.1.7 a mismatched peer range is silently skipped at load, so following the old line could not have worked. It now states DSH `0.2.0-rc.1`+ on the `0.2.0` prerelease line (verified on `0.2.0-rc.2`). The feature tables, the `/display` row and the configuration table now document what actually shipped: the four work-detail levels (with the rule that the old switches can only subtract), the folded reasoning panel and compaction summary, the context-injection notice line, and the compaction card. Two claims that reasoning tokens are shown were corrected — they are not obtainable. The parity design doc's baseline moved to `0.2.0-rc.2` and its status line now says the three gaps are closed; that review also surfaced DSH rc.2 adding a 29th `MessageSourceMap` producer (`user-question-reply`, the late-reply injection of timed questions), recorded as key pitfall 50 and a TODO — unreachable on this deployment because `Config.mode` is still `legacy`.

### 文档：跨平台兼容性审计入档（2026-10-05，零代码改动）

有人问「我们这个插件是否跨平台兼容」，于是做了一次**只读的跨平台审计**，结论与三处文档更新（**没有改任何 `src/` 或 `client/` 代码，因此不重建、不重启**）：

- ✅ **构造上跨平台，证据是硬的**：`src/` 里 `process.platform` 出现 **0 次**；没有 `/proc`、`/etc`、systemctl、`chmod`、`process.kill`、信号等 POSIX-only 调用；**没有硬编码的平台绝对路径**；只用了 `node:os`（`homedir`/`tmpdir`）、`node:path`、`node:fs/promises`、`node:child_process`（**仅**用于按裸名调 ffmpeg / ffprobe）。4 个运行时依赖全是纯 JS，无原生模块、无 install script、无 `os`/`cpu`/`engines` 约束；本包 `package.json` **也没有** `os`/`cpu`/`engines` ⇒ 任何平台都装得上。依赖树里 76 个平台限定包**全部是 `optional`**（esbuild / rolldown / rollup / node-addon），由 npm 按平台自选，且都在构建期。
- ✅ **Windows 意识早就在代码里**，不是这次推断的：`pwsh` 与 `bash` 归一到同一个摘要变体（[`src/feishu-streaming.ts`](./src/feishu-streaming.ts) 与 [`src/feishu-jobs.ts`](./src/feishu-jobs.ts) 各有一处）、`~` 展开同时接受 `~/` 与 `~\`、vitest 配置用 `fileURLToPath(new URL(...))` 而非 `__dirname`。
- ⚠️ **但「构造兼容」不等于「验证过」**：完整链路（真机卡片渲染、媒体转码、宿主联调）**只在 Linux x64 跑过一次**。新增的 README「平台支持 / Platform support」一节把这句话写在了最显眼处，并按中英双语说明 **实测只有 Linux**、ffmpeg 是**可选**外部依赖（缺失只影响封面与音频转码，媒体引用退化为路径文字）。
- 🔴 **记一条待修（TODO O23）**：「聊天 → 会话」绑定表的路径是自己手拼的 `` `${homedir()}/.dsh` ``（[`src/index.ts`](./src/index.ts)），**没问宿主**。当前口径与上游 `resolveDshHome` 一致，**所以现在不是 bug**；但宿主已经把 `dshHomePath` 服务 provide 出来了，上游一旦改口径就会**静默写到另一个目录** ⇒ 重启后聊天退回默认会话，症状与 O13 一样却查不到原因。**未动代码**，等拍板。
- ⚪ **一个 Windows 上的已知退化**（失败方向安全，不会漏发工作区外文件）：工作区包含判断是路径前缀比较，Windows 的大小写不敏感与 8.3 短名可能让工作区**内**的媒体判成区外、只留路径文字。
- 📋 **验证状态本身进 TODO（H5）**：别的平台跑一遍 `typecheck` + `test` 只能证明「装得上、测得过」，证不了卡片渲染；要真的算「支持」得在 macOS / Windows 上各起一次冷启动 + 一轮真实对话。

**English**: a read-only cross-platform audit, prompted by the question of whether this plugin is cross-platform. `src/` contains **zero** `process.platform` branches, no POSIX-only calls, no hardcoded platform paths, and all four runtime dependencies are pure JavaScript with no `os`/`cpu`/`engines` constraints (the 76 platform-constrained packages in the tree are all `optional` build-time entries npm picks per platform). Windows awareness was already in the code rather than inferred: `pwsh` and `bash` normalize to the same summary variant, `~` expansion accepts both separators, and the vitest config resolves paths with `fileURLToPath(new URL(...))`. But "compatible by construction" is not "verified": the full path has only ever run on Linux x64, and the new README **Platform support** section now says so in both languages, also recording that ffmpeg is an *optional* external dependency. Two findings became TODOs — the chat→session binding path is hand-assembled instead of asking the host's `dshHomePath` service (not a bug today, since the resolution currently matches upstream, but a silent-divergence risk), and the fact that no non-Linux platform has been verified at all. No `src/` or `client/` code changed, so nothing was rebuilt and dsh was not restarted.

### 文档：`present` 交付缺口入档（2026-10-06，零代码改动）

有人问「present 工具，是不是我们插件没实现兼容」，于是把这条从头核了一遍。结论是**部分兼容，而且缺口恰好落在 `present` 真正被用的那一类文件上**（记入 TODO O25 + 关键坑 52，**没有改任何 `src/`，不需要 build / 重启**）：

- ✅ **事件层是接了的**：订阅 `deliverables/presented`，按 path 去重收集（单轮上限 16），渲染成 Turn Complete 卡第一个元素 `📦 交付文件（N）`（≤6 条 + 「另 N 个」）。
- ✅ **媒体类交付真能到用户手里**：`png` / `mp4` / `ogg` 的条目走既有 hydrator 真上传、在卡内内联。
- ❌ **文档类交付只落到一行点不动的纯文本**：`docx` / `xlsx` / `pdf` / `zip` / `md` / `csv` / `ts` 会被 `linkFallback()` 降级成 `描述 · \`path\``。根因是卡片能力边界（卡片没有文件/附件组件，只能走原生文件消息），**不是渲染 bug**。
- ❌ **提示词层我们零干预，模型被误导**：WebUI 的 `ui-deliverables` 在 host 半注册了一条**全局** system prompt（「Each presented file adds a card below the reply, with preview and native-open actions」），**不区分客户端**，飞书会话同样收到；而飞书既没有 `native-open`（那是 WebUI 的宿主桌面路由）也没有文档预览 ⇒ 模型以为已经交付了。
- 📊 **真机数据（3 个飞书会话 / 444 轮）**：`present` 调用 **13 次**，其中**只有 1 次**真正送达（那一轮模型自己额外调了 `feishu_send_file`）；13 次全是非媒体（`.md`/`.sh`/`.csv`/`.tsx`/`.ts`），媒体 **0 次**。
- 🧭 **三个候选修法（当时建议「卡片加『发送文件』按钮 + 给飞书会话注入一段说明」，两者都没做）**：卡片按钮（路径须校验「本会话本轮声明过 + 在工作区内」）、收到事件后自动推送（有重复/刷屏与排序风险）、或只注入一段提示让模型改用 `feishu_send_file`。

**English**: a documentation-only record of the `present` (deliverables) compatibility review, prompted by the question of whether the plugin is compatible with DSH's `present` tool. The event is consumed and rendered on the Turn Complete card, and media deliverables (image/video/audio) are genuinely uploaded and inlined; but every non-media deliverable — the exact file types `present` is actually used for — degrades to an inert `description · \`path\`` text line, because Feishu cards have no attachment component. Worse, the WebUI's `ui-deliverables` host half registers a **global** system-prompt section promising "a card below the reply, with preview and native-open actions", which reaches Feishu sessions too and is not corrected anywhere in this plugin. A scan of three Feishu sessions (444 turns) found 13 `present` calls, exactly one of which reached the user (that turn also called `feishu_send_file` explicitly), and all 13 were non-media. Three candidate fixes were identified; the operator chose to record the finding for now. Recorded as TODO O25 and pitfall 52; no `src/` or `client/` code changed.

### DSH 适配：0.2.0-rc.1 → 0.2.0-rc.2（2026-10-02，插件零必改）

> 本跳 **187 commits / 1022 文件、同一 `0.2.0` tuple、零包增删**，是 rc.1 以来以**桌面端/客户端**为主的小版本。完整逐符号/逐事件核查、三轨彩排、切换与实测见本机 `notes/upgrade-0.2.0-rc.2.md`。

- ✅ **插件零必改**：被 import 的 18 个宿主包 + 客户端 5 个包导出**零删除**，插件用到的 **30 个事件名逐个仍在**。
- ✅ **依赖范围有意保持在 `^0.2.0-rc.1`**（同 tuple 覆盖 rc.2，semver 与运行时 peer 闸门都实测通过）；升到 `^0.2.0-rc.2` 反而会让**回滚到 rc.1 被闸门拒**。只把 `package-lock.json` 刷新到 rc.2（提交 `3d009d5`，零源码改动、产物逐字节一致），使本地 typecheck / **787 用例 / 46 文件**跑在真正运行的那版上。
- ⚠️ 两个有源码改动的相关包：`user-questions` 新增**实验性异步问答**（`tool-ask-user` 行 `Config.mode` 默认 `'legacy'` ⇒ 本部署行为不变）；`llm-pi-ai` 升到 **pi-ai 0.87.1**（compat 字段有增删，本部署用到的 `forceAdaptiveThinking`/`reasoningEfforts` 均不受影响，冷启动彩排已验证补丁整体解析通过）。
- ✅ **先彩排后切换、三轨全绿**（宿主构建 / 插件全新装 787 用例 / 真实补丁隔离 `DSH_HOME` 冷启动且 0 peer denial）；**正式切换一次跑通**：`TARGET_OK=1 PLUGIN_OK=1 ROLLED_BACK=0`，`NRestarts=0`，session map 与停服前逐项一致，journal 无 error、**peer denial 0**。
- ⚠️ 如实记录一次**与升级无关的瞬时网络抖动**（`20:11` 两次到飞书的 `ECONNRESET`，插件重试后送达，此后 0 条 `sdk error`）——非 rc.2 回归。

### 结论（无代码改动）：推理面板的 `· N tokens` 为什么永远不出现（2026-09-29）

使用者问「思考块还是获取不了 token 数目吗」。答案是**拿不到，而且不是插件的 bug**，所以这一条**不改代码**（`renderStepCard` 里「有 `usage.reasoningTokens` 就显示」的分支保留，作为等上游的出口）。三环取证：

1. **最上游就不给**：本部署飞书会话跑 MiniMax-M3.1-Flash-Preview（pi-ai 的 anthropic-messages 协议，`https://api.minimaxi.com/anthropic`）。直连原始接口（返回体里确实有 `type:"thinking"` 块），`usage` 只有 `input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` —— **没有思考明细**，思考被算进 `output_tokens`。
2. **pi-ai 只给部分协议填 `usage.reasoning`**：`@earendil-works/pi-ai@0.85.1` 的 `Usage.reasoning` 只在 `openai-completions` / `openai-responses` / `google-vertex` / `google-generative-ai` 里赋值，**anthropic-messages 不填**。
3. **DSH 的适配层也不映射**：`packages/llm/llm-pi-ai/src/stream.ts` 的 `mapUsage()` 与 `packages/llm/llm-deepseek/src/translate.ts` 的 `updateUsage()` 都只带 input/output/cache/total —— 全仓库 `grep -rn "reasoningTokens:" packages apps`（排除测试）**没有任何生产者**；最近 7 天 12 个会话日志里 `"reasoningTokens"` 命中 **0** 次。

⇒ 卡片上那个 `· N tokens` 是**永不执行**的「等上游」代码；真机读回同一张卡也确认 header 只有耗时（`💬 **推理** · 1.3s（▸ 已折叠 · 点击展开）`）。

**曾评估、未采用**：显示估算值 `≈ N tokens`。实测标定（直连 MiniMax，比较 `output_tokens` 与 thinking 文本长度）显示字符/token 在 **2.5–4.3** 之间浮动（短链路固定开销占比大），误差约 ±40%；且**中文提问时 thinking 文本常常是英文**，「中文 1 字≈1 token」的直觉不成立。使用者最终选择**保持现状**，所以既不做估算、也不把 `output_tokens` 当思考量（那里面还含正文与工具调用）。**排查口诀**：要显示某个用量字段前，先 `grep -rn "<字段>:" packages apps` 确认**真有人生产**它。

**English**: no code change — the reasoning header's `· N tokens` can never appear, and it is not a plugin bug. (1) The provider does not report it: a raw call to the MiniMax Anthropic endpoint this deployment uses (the response really does carry `type:"thinking"` blocks) returns `usage` with only `input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`. (2) pi-ai fills `Usage.reasoning` only for its `openai-completions`, `openai-responses`, `google-vertex` and `google-generative-ai` APIs, not for `anthropic-messages`. (3) DSH's adapters do not map it either (`mapUsage()` in the pi-ai adapter, `updateUsage()` in the DeepSeek one), and a repository-wide grep finds **no producer** of `reasoningTokens` outside tests; 12 session logs from the last week contain zero occurrences. The branch therefore stays as a dormant "waiting on upstream" path. An estimated `≈ N tokens` was evaluated and rejected: calibration against the real API put the ratio at 2.5–4.3 chars/token (±40%), and MiniMax's thinking text is frequently English even for Chinese prompts. Rule of thumb recorded for next time: before displaying a usage field, grep for its producer.

### 修复：折叠面板现在一眼能看出「已折叠」（`src/card-fold.ts`（新）/ `src/feishu-streaming.ts` / `src/feishu-compaction.ts` / `src/i18n.ts`，2026-09-29）

**问题**（使用者原话）：「思考块看不出来是已经折叠的样子。不了解的人不知道这个东西已经折叠了」——压缩卡的摘要面板同理。这是收起态的**结构性**事实：面板收起时只渲染 `header`，而光秃秃的 header 就是一个「小标题」的样子；WebUI 的同类行有 chevron，飞书这张卡什么都没有。

**修法**（两条一起上：一条靠我们说，一条靠客户端画）：

1. **文案**：面板 header 标题结尾统一加 `（▸ 已折叠 · 点击展开）`（英文 ` (▸ Collapsed · click to expand)`）——写成 i18n 函数 `cardFoldTitle(title)`，因为中文不要空格、英文要。这是**唯一客户端丢不掉**的信号。
2. **外观**：面板加 `border: {color:'grey-300', corner_radius:'4px'}`，header 加 `background_color: 'grey-100'`——有边框、有底色的 header 才像「一块可点的东西」，而不是「一行标题」。

推理面板与压缩摘要面板改走同一个 `foldedPanel()`（`src/card-fold.ts`），值只存在一处，不会再各自漂移。

**取证口径（重要，已写进关键坑 48）**：`cardkit.card.create` **静默容忍未知字段**——往 `collapsible_panel.header` 里塞 `bogus_xyz` 照样 `code=0`。所以「建卡成功」**不能**证明字段存在，**只有「某个值被拒」才算**：

| 字段 | 通过 | 被拒 |
|---|---|---|
| `border.color` | 命名色 token（`grey` / `grey-300` / `blue` / `neutral`） | `#DEE0E3`、`rgba(...)` → `11310 collapsible panel border color is invalid` |
| `header.background_color` | 同一套命名色 token（`grey-50`…`grey-300`、`blue`、`yellow`…） | hex / rgba → `11310 … header background color is invalid`；**对象** `{light,dark}` → `10002 expected string for background_color` |
| `border.corner_radius` | `4px` / `8px` / `0px` | `4`、`50%`、`4pt` → `10002 invalid corner radius` |
| `header.padding` | `4px`，或四个值 `4px 8px 4px 8px` | `4px 8px`、`4`、对象 → `10002 invalid panel header padding` |
| `expanded` | `true` / `false` | 字符串 → `10002 bad variable formmat` |
| `header.icon` | `{tag:'standard_icon',…}`（**token 不校验**，乱写也过 ⇒ 不可用） | `{tag:'custom_icon', img_key:'img_v3_…伪造'}` → `200570 card contains invalid image keys` |

端到端再校一遍：把**插件真实渲染出来的**产物——zh/en 各一张步骤卡（折叠推理 + 工具参数/结果 + 页脚）、压缩卡的 summary 与 done 两态——直接打给 `cardkit.card.create`，四张全部 `code=0`（脚本 `~/.dsh/probe-real-fold-cards.py`，渲染走插件的 `vite-node`）——防止「手写探针能过、产物不能过」。完整表与脚本清单见 [`docs/feishu-capabilities.md`](./docs/feishu-capabilities.md) §2.3.2。

**验证**：`npm run typecheck` 0 error；**787 tests / 46 files 全绿**（新增 `tests/card-fold.spec.ts` 5 例，并把「色值只能是命名 token / 半径只能是 px」写进断言，防止以后有人手滑改成 hex）；`npm run build` 通过，`lib/index.js` 已重建（本批不动客户端，`client/client.js` 无 diff）。**真机验证（2026-09-29 02:21:33 重启后）**：读回线上卡片（`im.v1.messages.get?card_msg_content_type=user_card_content`）确认三个字段都到了服务端渲染态——`collapsible_panel expanded=false border={grey-300, 4px} header.background_color=grey-100 title=💬 **推理** · 1.3s（▸ 已折叠 · 点击展开）`；journal 0 条 error / `230020`。

**English**: a folded panel must look folded. A collapsed `collapsible_panel` renders only its header, and a bare header reads as a section title — nothing suggests there is more behind it (the Web UI's equivalent row draws a chevron; this card had nothing). The fix is two-layered: the header title now always ends with `（▸ 已折叠 · 点击展开）` / ` (▸ Collapsed · click to expand)` via an i18n function (`cardFoldTitle`, because CJK takes no space and Latin does), and the panel is drawn as a bordered, tinted block (`border {grey-300, 4px}` + `header.background_color: grey-100`) so the header reads as a control. Both folds (reasoning and compaction summary) now share one `foldedPanel()` builder. The evidence rule matters here and is recorded as key pitfall 48: `cardkit.card.create` **silently tolerates unknown fields** (a `bogus_xyz` inside `header` still returns `code=0`), so a successful create proves nothing — only a *rejected value* does (named colour tokens only: hex/rgba are refused with `11310` and an object-valued `background_color` with `10002`; `corner_radius` is px-only; `header.padding` takes one or four px values). The plugin's real render output for four cards (zh/en step cards, compaction summary and done) was then fed straight to `cardkit.card.create` — all `code=0`. `npm run typecheck` clean, **787 tests across 46 files** green (5 new in `tests/card-fold.spec.ts`, which also pins the probed value constraints), `npm run build` rebuilt `lib/index.js` with no client diff. Live check after the 02:21:33 restart: reading a real card back (`im.v1.messages.get?card_msg_content_type=user_card_content`) shows `collapsible_panel expanded=false border={grey-300, 4px} header.background_color=grey-100 title=💬 **推理** · 1.3s（▸ 已折叠 · 点击展开）`, with zero error / `230020` lines in the journal.

**上线与实测（2026-09-23，两次重启）**：

- **上线**：`49df1ba`（L1+L2）+ `0b82880`（L3）于 18:36:14 重启生效（`MainPID` 4193368 → 384812）；`e914bc9`（`cardImages` 设置）于 20:10:45 重启生效（→ 529495）。两次都 `systemctl` active、journal 里**卡片相关的 error / `invalid image keys` / `message handling failed` 均为 0**；产物核对 `lib/index.js` 与 `client/client.js` 都含 `cardImages`。
- **L3 真机端到端（使用者要求"不走 `feishu_send_file`、直接内联"）**：在工作区内造了一张 120×120 蓝白棋盘格 PNG（`notes/inline-probe.png`，297 字节，放在 gitignore 的 `notes/` 下，工作区保持干净），然后**只在回答正文里**写 `![内联探针 · 蓝白棋盘格](notes/inline-probe.png)`：
  - journal：`21:26:01 dsh-feishu: [img] uploaded notes/inline-probe.png → img_v3_0215q_b271840d-…` —— **整个回合只上传一次**（步骤卡期间被 update 多次，命中的是 `path+mtime+size` 缓存），且**没有**任何 `card image … left as text`；
  - **服务端回读**（`im.v1.messages` + `card_msg_content_type=user_card_content`）：最近 20 条卡片里有 **2 张**的正文已经是 `![内联探针 · 蓝白棋盘格](img_v3_0215q_b271840d-…)`，即卡片确实被改写成了真 key，而不是只上传成功；
  - **使用者目视确认**：卡片里直接显示了那张棋盘格图片。⇒ L3 从"相对路径 → 工作区解析 → 上传 → 内联渲染"整条链路成立，全程未调用 `feishu_send_file`。
- **仍未真机触发过的路径**（如实记录）：L2 的"飞书仍拒收 → 剥净重试 → 回退 patch"——L1 已经覆盖了实测到的全部非法形态，重启后 0 次拒收，所以这三步目前只有单测（`tests/card-write.spec.ts` 的 12 例）覆盖，还没有活体样本。

### 新增：四档「工作步骤展示」+ 推理可折叠 + 压缩卡 + 注入提示行（O22 / O5 / O21，`src/display-level.ts`（新）/ `src/injection-notice.ts`（新）/ `src/feishu-compaction.ts`（新）/ `src/feishu-streaming.ts` / `src/config.ts` / `src/commands.ts` / `src/feishu-display.ts` / `src/i18n.ts` / `src/client/`，2026-09-29）

一批四件事，全部围绕「飞书里能看到多少、以及看不到的那两件事」。调研与逐条实测见 [`docs/transcript-parity-design.md`](./docs/transcript-parity-design.md)。

**① 四档显示级别（对齐 WebUI 的 `ui-chat.transcriptView`，O22）**

新增设置项 `transcriptView`：`compact｜standard｜detailed｜verbose`，**默认 `detailed`**，文案与 WebUI 逐字一致（简洁 / 标准 / 详细 / 完全展开）；`/display <档位>` 与 `/display` 卡片顶部四个按钮都能切换，WebUI 设置页也新增同名下拉框。历史写法 `normal` / `expanded` 一律**按 `detailed` 读**（0.2.0 自己的读法），非法值也退回默认。

- 档位**只改渲染轴**，不比对枚举：`compact` = 推理不显示 + 工具只报计数；`standard` = 推理首行 + 每个工具一行摘要（无参数、无结果）；`detailed` = 推理 200 字折叠 + 参数 + 结果（**与加档位之前完全相同**）；`verbose` = 推理全文 + 参数/结果放宽到 4 倍上限。
- **档位是基线，四个老开关只能「减」不能「加」**（用 AND 合成）：任何档位下 `showReasoning=false` 都等于「推理 off」，`detailed` 下 `showToolArgs=false` 仍生效。这样升级不会把用户关掉的东西又打开，也不需要再造一个 `custom` 档。
- **飞书侧不做「合并卡片」**：WebUI 的 `foldCompletedTurns` / `stepGrouping` 两轴在飞书没有视觉等价物（一个 step 只能一张卡，关键坑 12），所以 `compact` 只是把卡片缩成状态行，**不合并一轮里的多张卡**——合并会让交付正文归属变得含混。
- 一处诚实说明：`verbose` 的「不截断」是**把上限提到 4 倍**（结果 1500→6000、参数 2000→6000 字符），不是真的无限——卡片 JSON 过 ~30KB 会被整张拒收（关键坑 42），而**被拒收的卡什么都不显示**，所以上界必须留。

**② 推理可折叠（O5，`collapsible_panel` 首次真机使用）**

推理段从「明文代码块 + 开头 200 字」改成**默认收起、点开看全文**的折叠面板：头部就是原来的 `💬 **推理** · 耗时 · tokens`（外加推理时长与思考 token 数），正文在面板里。

- 组件名是 **`collapsible_panel`**（2.0 的名字）；1.0 时代的 `collapsible` 会被服务端以 `10002 not support tag` 拒收——本机文档不可达，这条是用**只建实体、不发送**的 `cardkit.v1.card.create` 探针 + **伪造 tag 对照**实测出来的（见 `docs/feishu-capabilities.md` §2.3.1）。
- **顺带解决了信息损失**：以前砍到 200 字是因为「不折叠会占满屏」；收起来之后 `detailed` 仍给 200 字（与旧观感一致）、`verbose` 给全文。
- 已知小限制：卡片**就地更新会重写整张卡的 JSON**，客户端本地的展开状态可能被重置（一步通常只剩 1–2 次写入）；压缩卡同理。

**③ 压缩卡（O21 第②件）**

以前自动压缩与 `/compact` 在聊天里**完全没有迹象**（插件根本没订阅 `compaction/*`），使用者不知道模型刚丢掉了几百条历史。现在一次压缩是一张可更新卡：

```
🗜️ 正在压缩上下文…            ← compaction/start，grey，写明触发方式（自动 / /compact）
🗜️ 上下文已压缩                ← compaction/summary，green
已折叠 609 条历史记录 · 约 302K tokens · provider/model   ← 详情行在折叠区【之上】
 摘要（▸ 已折叠 · 点击展开）      ← collapsible_panel，expanded:false，正文上限 200 字；灰底+边框（2026-09-29 追加）
⚠️ 上下文压缩失败 + 原因 + 「本次没有产生摘要」  ← compaction/end 带 error 时，red
```

- **不假设「start 之后必有 summary」**：失败路径（`compaction/end.error`）没有摘要；`compaction/prune`（无模型的纯裁剪）整场都没有 `summary` 事件——两者都按实际有的事实渲染，没有正文时明说「这次压缩没有摘要内容」。
- **没有「把完整摘要另发文件」按钮**（使用者已否掉）；摘要超 200 字即截断。
- 写入走同一套 CardKit 实例更新（一次一张、序列递增）；**卡片完全发不出去时退回纯文本**一行（关键坑 40：报告写入失败的东西不能又是卡片）。

**④ 上下文注入提示行（O21 第①件）**

DSH 的上下文注入是持久事件（统一落在 `user/message`，`data.source.kind !== 'user'`），来源是**开放集合**；以前插件只认 `tool-jobs`，其余**全部静默丢弃**，所以「这轮被喂了什么」在飞书完全看不到。现在每条注入在**它所归属的那张 step 卡的正文最前面**加**一行提示**：

- 只显示**元数据**，**绝不显示注入内容**（`content` 是给模型看的，实测 `AGENTS.md` 基线一条 6.2k 字）；
- 例如 `📥 注入上下文 · AGENTS.md（已更新）`、`📥 注入上下文 · 技能目录（12 条）`、`📥 注入上下文 · 插件 @deepseek-ai/dsh-system-prompt`、`🔗 跨会话召回 · …`、`✉️ 会话间消息 · 来自会话 …`、`🤖 子代理已结算 · …`；未知 kind 只报种类，**不 dump 原始字段**（将来的生产者不能借这个通道往卡片上贴任意文本）；
- **`compact-checkpoint` 与 `tool-jobs` 静默**：前者由压缩卡负责，后者已有「本回合由后台任务完成通知触发」标记（关键坑 37），不能重复；
- **位置规则**：注入总是先于它所归属的那次请求落盘（实测 93.0% 落在 `step/start` 之后、`request/header` 之前），所以「插到卡的最前面」既是语义正确、也是「这一次请求确实读到了它」的可视证据；剩下 6.8% 落在 `step/start` **之前**（全是压缩事务里的插件重注入）→ **先进会话级缓冲**，等那个 step 建卡时并入首版（放在 step 状态里会被 `resetStep` 清掉，这正是要缓冲的原因）；提案里「追加到卡片末尾」那一档在持久事件里**实测 0 条**，故不实现。
- 卡片总数**不增加一张**；有注入的 step 一定有卡（`step/start` 的建卡是无条件的，已就地注释）。

**同时改动**：`/display` 文本命令新增档位形式（`/display compact`），`/display` 后不带参数会先报当前档位；`src/commands.ts` 的 `DisplayControl` 增加 `getLevel` / `setLevel`（档位与四个开关写的是同一批 `lark-channel` 配置字段，三个入口永远同源）；WebUI 设置页新增「工作步骤展示」下拉框（`transcriptView`）。

**验证**：`npm run typecheck` 0 error（含 client）；**782 tests / 45 files 全绿**（新增 **51 例**：三个新模块自带 35 例——档位→策略映射与 legacy 读法、注入提示行（**用真机会话日志里的真实 `source` 载荷**逐个核对字段名）、压缩卡渲染与控制器（顺序、序列、话题、纯文本兜底、`stop()` 后不再开卡）；`feishu-streaming.spec.ts` 新增 13 例折叠/档位/注入/压缩接线；`config.spec.ts` 1 例、`client.spec.ts` 2 例）；`npm run build` 通过，`lib/index.js` 与受跟踪的 `client/client.js` 均已重建。另跑了一次**只建实体、不发送**的整卡探针（`~/.dsh/probe-step-card-panel.py`，用例与结果见 [`docs/feishu-capabilities.md`](./docs/feishu-capabilities.md) §2.3.1）：本批产出的**步骤卡**（注入提示行 + 折叠推理面板 + 正文 + 工具参数/结果 + 页脚）与**压缩卡**都被 CardKit 接受（`code=0`），把面板换回 1.0 的 `collapsible` 则被拒（`10002`）——对照组有效。**真机验证（2026-09-29 01:55 重启后）**：按 09-23 那次内联媒体验证用过的同一招读回线上卡片（`im.v1.messages` + **`card_msg_content_type=user_card_content`**；不加这个参数只会拿到降级内容、只有 title 是新的），**一张真实步骤卡同时确认三件事**——`📥 注入上下文 · AGENTS.md（已更新）` 在**正文最前面**且卡内没有注入正文（由一次真实的 `agent-instructions/replace` 注入触发）、推理面板 `collapsible_panel` + **`expanded:false`（默认收起真的生效）**、默认「详细」档的工具段完整；元素顺序与页脚正确，写入链 seq 1→4 完好、无 `230020`。WebUI 半边也已核对：启动页拼出的插件包里含 `transcriptView*` 全部键与「工作步骤展示」文案。**仍未真机验**：压缩卡三态（需一次真压缩）、`/display compact|verbose` 的观感切换。

**English**: four things in one batch. (1) A new `transcriptView` setting mirroring the WebUI's `ui-chat.transcriptView` (`compact`/`standard`/`detailed`/`verbose`, default `detailed`, same wording), switchable from `/display <level>`, from four buttons on the `/display` card, and from the WebUI settings page; the two WebUI legacy spellings (`normal`, `expanded`) both read as `detailed` and anything unreadable falls back to the default. A level only projects onto render axes (compact = no reasoning text + tool counts; standard = reasoning first line + one summary line per call; detailed = the exact pre-level behavior; verbose = whole reasoning + 4x payload caps), and it is a BASELINE: the four existing switches are ANDed in and can only ever remove detail, so an upgrade cannot re-enable something a deployment had turned off. Feishu deliberately does NOT merge cards across a turn — the WebUI's folding axes have no visual equivalent when one step is one card. "Untruncated" at `verbose` honestly means four times the cap, because a card over ~30 KB is refused whole and would show nothing. (2) Reasoning is now a collapsed `collapsible_panel` (the 1.0-era `collapsible` tag is refused with `10002 not support tag` — verified with a send-free `cardkit.card.create` probe plus a bogus-tag control), which also lifts the information loss: the 200-character cut only ever existed because an unfolded chain filled the screen. (3) A compaction card finally reports what used to be invisible: `compaction/start` opens it, `compaction/summary` adds a details line above a folded, 200-character-capped summary, and `compaction/end` closes it green or red with the failure reason and an explicit "no summary was produced" — never assuming a summary exists, since neither a failed attempt nor a `compaction/prune` emits one. (4) Every injected context message now adds ONE metadata-only notice line at the top of the step card whose request reads it (`compact-checkpoint` and `tool-jobs` stay silent, unknown kinds are named but never dumped), buffered session-side when it arrives before `step/start` (6.8%, all of them compaction re-injections) so `resetStep` cannot lose it; the proposed "append before the footer" position has zero occurrences in the durable log and is not implemented. Typecheck clean, 782 tests across 45 files pass (51 new, using real `source` payloads copied from this machine's session logs), artifacts rebuilt.

### 变更：步骤卡区分「请求还没发出 / 已发出等待 / 思考中 / 回复中」（O20 方案 2，`src/feishu-streaming.ts` / `src/i18n.ts`，2026-09-29）

**问题**（使用者原话）：「卡片就是在模型输出首字之前的那个卡片，和模型开始思考的卡片要区分开来」。占位卡在 `step/start` 就发出，而那一刻 DSH **还没组装、更没发出**请求，标题却写着「🧠 深度思考中…」——该说「等待」的时候说「思考」；等模型真的开始思考时，插件手里**没有任何实时信号**（0.1.3 起 token 级增量不再是持久事件，`assistant/chunk` 已死，代码里那段是只累加不发卡的历史遗留），只能等整条消息落地后一次性写进同一张卡，标题此刻已经是「回复」——该说「思考」的时候又说了「回复」。

**修法（方案 2：接实时流，只用来切阶段；内容仍等 `assistant/message`）**：

1. **订阅瞬时发布 `agent/assistant-stream`**：注册 `{ global: true }`（它是 agent-scoped 的 `emit`，与子代理名册同一套写法），按 `payload.agent.session.id` 关联会话，并沿用既有的 `bridge.resolveChat` 门控——只服务已绑定飞书聊天的会话（关键坑 31）。帧序 `start → chunk… → end`，按 attempt 发布。
2. **相位机（一次尝试内只前进）**：`start` → **`awaiting`**（请求已发出、还没拿到 token）；首个 `reasoning-delta` → **`thinking`**；首个 `text-delta` → **`replying`**；`end` 且 `outcome.kind === 'abandoned'`（重试 / 中断）→ 退回占位，等重试自己的 `start`。迟到的 reasoning delta **不会**把「回复中」改回「思考中」。
3. **文案**：占位改成 `⏳ 正在分析请求 · 第 N 轮 · 第 M 步` + 「请求还没发出，模型尚未收到这一轮的内容」，把「深度思考」从这个阶段彻底拿掉；新增 `📡 已发出请求，等待输出…` / `🧠 思考中…` / `✍️ 回复中`（zh + en）。
4. **等待阶段带 route**：`awaiting` 时在卡上补一行 `📡 provider / model`，取自持久的 `request/context`（路由变化时才有该事件，所以按会话记住、不按步清空），回答「这次请求发给了谁」。
5. **只重绘没有内容的卡**：相位只在卡的「无内容」形态上生效——内容一旦落地，标题仍由既有规则（回复 / 工具进行中 / 工具完成 / 工具出错 / 本步无输出）决定，迟到的帧影响不到已结算的卡。
6. **生命周期**：退订挂在 `stop()`；`step/end` 之后不再理会该步的帧；`step/start` / `turn/end` 复位相位。

**写入纪律不变**：相位切换走既有的 `updateStepCard`（按卡防抖、一卡同时只允许一次写入在飞、只保留最新一版），每步最多多 2–3 次写入；卡仍是**一个 step 一张**（关键坑 12），相位切换**只更新不重发**。

**验证**：typecheck 0 error；**729 tests / 42 files 全绿**，其中新增 **9 例**——4 例单元（四相位的标题与正文、route 只在等待阶段出现、有内容时相位被忽略）+ 5 例接线（一张卡走完 占位→等待→思考→回复、迟到推理不倒退、`abandoned` 退回后再 `start`、非绑定会话的帧被忽略、`step/end` 后与 `stop()` 不再响应）。测试替身同步改成**按事件名**登记监听器，避免把瞬时帧喂给持久事件的处理器。产物已重建（`lib/index.js`；`client/client.js` 逐字节未变）。

**English**: the step card used to say "Thinking…" the moment `step/start` arrived — before DSH had even built the request — and then say "Reply" while the model was actually thinking, because no token delta is a durable session event any more (`assistant/chunk` was removed in 0.1.3). The card now carries a live phase fed by the transient `agent/assistant-stream` publication, subscribed `{ global: true }` and attributed through `payload.agent.session.id`, gated on a bound Feishu chat. Phase machine: the attempt's `start` frame means "request sent, awaiting output", the first reasoning delta means thinking, the first text delta means replying, and an `abandoned` end returns to the placeholder for the retry that follows; within one attempt the phase only moves forward. The pre-request placeholder is now "Analyzing request" plus "the request has not been sent", the awaiting card names the route from the durable `request/context`, and the phase only ever repaints a card that still has no content, so settled steps are untouched. Phases ride the existing debounced per-card update path with latest-wins coalescing, keep one card per step, and are unsubscribed on `stop()`. Typecheck clean, 729 tests across 42 files pass (9 new), artifacts rebuilt.

### 修复：最后一张步骤卡停在「深度思考中」——卡片发送自己等自己 60 秒（`src/feishu-streaming.ts` / `src/index.ts` / `src/card-write.ts`，2026-09-24）



**现象**（使用者报告）：「刚才有个会话的最后卡片又卡在思考了，turn complete 卡片出来了以后那个卡片都没有最终更新」。journal 里这次留下了完整链条（19:30:27–19:31:28）：

1. `[send] card instance create failed: Client network socket disconnected before secure TLS connection was established` —— CardKit 建卡掉线，走 `channel.send` 兜底；
2. 之后 30 秒每 5 秒一条 `[update] no card instance, falling back to patch`（占位卡的计时 tick），全部悬在 `ref.messageId` 上；
3. `pending card flush gave up: … step-card flush before send timed out after 60000ms` **紧跟** `[send] message=om_… via send` —— 卡片比它本该出现的时间晚了整整 **60.000s**（= `CARD_BARRIER_TIMEOUT_MS`）；随后 **7 次** `[update] patch` 在同一秒齐发，飞书回 `230020 This operation triggers the frequency limit, ext=Update the single messages too frequently`，载着这一版答案的那次写入被拒（400）；turn 随即结束，`[reply] a step card carried the text → footer only` —— 插件以为正文已上屏，于是只发了 footer，那张卡永远停在「🧠 深度思考中」。

**根因（自锁死）**：`actuallySendStepCard` 在**发起 send 之前**就把这条 send 的 promise 登记进 `lastCardSendByChat`（这是"后一张卡必须等前一张卡的消息建好"的顺序保证），而 `cardChannel.send` 走 `cardBarrier.run(...)`，它的 flush 正是「flush 本聊天还没发的防抖卡 + `await lastCardSendByChat.get(chatId)`」。于是**步骤卡自己的兜底 send 在等自己**：只有「由 flush 内部触发的 send」（`flushPendingSend → actuallySendStepCard`）被屏障的 `flushing` 集合豁免，而由防抖定时器直接触发的那条路径不在其中 → 一直卡到 barrier 超时。首选的 `sendCardByReference` 不走屏障，所以这条路径平时看不见。

**修法（三处，另加一处韧性）**：

1. **步骤卡自己的 send 不再过屏障**：新增 `cardChannel.sendStepCard`（`index.ts`，只保留 HTTP 外层的有界超时），流式侧的兜底分支用 `channel.sendStepCard ?? channel.send`。这与首选的 `sendCardByReference` 同一档位；「与前一张卡的顺序」本来就由调用方的 `previousSettled` 保证（`resetStep` 会先 `flushPendingSend`，所以前一张卡一定已登记进链）。
2. **一张卡同时只允许一次写入在飞，且只保留最新一张**：`writeSlots`（按 `StepCardRef`）。在飞时到达的渲染只记住最新那张，被顶掉的旧渲染直接以 `false` 结束——它的内容更旧，重放只会制造 `230020`。慢写入 + 5 秒 tick 因此不再堆积成突发。
3. **送达判据从「有文本落地过」改成「最新一版文本落地了」**：`turnTextOrder`（`{next, delivered, failed}`）按**构建顺序**（内容新旧）盖戳，而不是完成顺序；被顶掉的写入不盖戳。`flushed()` 只在 `delivered > 0 && failed <= delivered` 时保留乐观标记，否则撤回 → `channel.ts` 照发回复卡。旧的布尔标记会把「第一步落地、最后一步被拒」判成"已送达"，于是最后一版答案静默消失。
4. **建卡传输失败重试一次**：`createCardInstanceWithRetry`（`card-write.ts`）。内容类拒收不重试（card writer 已经剥图重试过）。一次掉线不再把这张卡**永久**降到 `patch` 路径——而 `patch` 正是有 `230020` 频率限制的那条路。

**验证**：typecheck 0 error、**720 tests / 42 files** 全绿，产物已重建（`lib/index.js` 含 `sendStepCard`/`writeSlots`/`turnTextOrder`；`client/client.js` 逐字节未变）。新增 4 例回归（`tests/feishu-streaming.spec.ts`「the step card must not wait on the ordering barrier it belongs to」）+ 3 例重试（`tests/card-write.spec.ts`）。**反向验证**：三例在修前全红——真实 barrier 装配下 raw send **调用 0 次**（自锁死）、并发渲染产生 **4 次**写入而不是 1 次、被拒后 `clearIntermediateSent` **0 次**。

**English**: the last step card of a turn could stay on "🧠 深度思考中" after the Turn Complete card had already been posted. The journal shows the whole chain: the CardKit instance create dropped its socket, the fallback send wedged for exactly 60.000s (`CARD_BARRIER_TIMEOUT_MS`) because it was waiting on the chat's own step-card send chain — which held the very promise that send was inside — then the seven updates scheduled in between were released in one burst, Feishu answered `230020` (per-message edit frequency) and the write carrying the answer was refused. Three changes: the step card's own send now goes through `cardChannel.sendStepCard`, which is deliberately not barrier-wrapped (ordering against the previous card is already guaranteed by the caller's `previousSettled`, and the preferred `sendCardByReference` path never used the barrier either); card writes are serialized per card with latest-wins coalescing (`writeSlots`), so a slow write plus the 5s placeholder tick can no longer pile up into a burst; and the delivery record became `turnTextOrder`, a content-order stamp of the newest text-carrying write that landed versus the newest one refused, because a plain "some text landed" boolean judged "first step landed, last step refused" as delivered and silently lost the final answer. A dropped socket during the instance create is also retried once (`createCardInstanceWithRetry`) instead of permanently downgrading that card to the rate-limited patch path. All 720 tests pass, and each of the three regressions fails before the fix.

### 新增：三个媒体**大小**上限分开设置；修 `feishu_send_file` 的图片兜底（`src/config.ts` / `src/card-images.ts` / `src/feishu-send-file.ts` / `src/client/`，2026-09-24）

**动机**（使用者的要求）：「增加设置自动内联的媒体大小，默认 15mb。三个媒体分开设置，注意输入范围检查」，以及「顺便把刚才那个发图片的修了」（TODO O15）。

**做法**：

- 新增三个配置字段，各自带范围（`.volatile()`，保存即生效）：`cardImageMaxMb` **1–10，默认 10**、`cardVideoMaxMb` **1–30，默认 15**、`cardAudioMaxMb` **1–30，默认 15**。**图片的默认值是 10 而不是 15**：飞书 `im.v1.image.create` 的硬上限就是 10MB，给 15 只会是个永远碰不到的数字（图片转成卡片图片元素必须走这个接口）；视频/音频走 `im.v1.file.create`，30MB。所以三个范围的上界都是**平台边界**，不是我们的口味；视频/音频默认 15 是刻意的——超过它的代价是**等**（上传发生在写卡路径上），不是被拒收。
- 判定改成**按分类后的类型**逐类比上限：以前是"图片一个上限、其余一切共享一个上限"，而且 ISO-BMFF 的检查发生在分类之前。现在 ISO-BMFF 先分类（video/audio）再各比各的上限；`inspect()` 的返回值也分出第三种结果 `{ refused: 'size' }`，与"根本不是媒体"区分开。
- **顺带堵住一个洞**：Opus/WAV/MP3/FLAC 这些非 ISO-BMFF 音频**从来没有字节检查**（旧的 `maxFileBytes` 只作用在 ISO-BMFF 分支），一个 100MB 的 WAV 会被转码并上传。现在同样受 `cardAudioMaxMb` 约束。
- **超限文件不再写「检过但不是媒体」的负缓存**（加设置时发现的交互 bug）：那张负缓存按 `path+mtime+size` 命中就直接跳过，于是**把上限改大不会生效**，要等缓存淘汰或文件变动。现在只有"真的不是媒体"才记负缓存；超限的每次重新判（代价是一次 64 字节头读，不是上传）。用例直接锁死这条：先用 1KB 上限跑一遍、再抬到 10KB 跑第二张卡，必须内联出来。
- **`feishu_send_file` 的图片补上 `{file}` 兜底**（O15）：工具里视频/音频本来就有 `sendWithFileFallback`，图片却是直接 `ch.send({ image })`——一张 ≤10MB 但超过分辨率上限的图（GIF > 2000×2000、其他 > 12000×12000，`234039`）会让整次调用抛错、文件一份都不落地，而官方文档对这类图的口径正是「请用上传文件接口以文件形式发送」。现在图片也走同一条兜底，`sent_as` 如实报 `file`；工具描述同步写明超分辨率也算。

**验证**：typecheck 0 error、**713 tests / 42 files** 全绿。新增：`tests/config.spec.ts` 2 例（三个默认值 + 逐类钳制：999→上界、0→下界、小数取整、`NaN`/空→该类默认）、`tests/card-images.spec.ts` 3 例（各类各比各的上限、超限的**非 ISO 音频**也被拦、上限**实时重读**所以改大下一张卡就生效）、`tests/client.spec.ts` 2 例（三个输入框各自的 min/max 与默认值、保存写出**数字**且越界/清空分别落到上界/默认）、`tests/feishu-send-file.spec.ts` 1 例（图片被拒 → 仍以 `file` 送达、`sent_as: 'file'`）。**反向验证**：把图片分支还原成旧的直接 `ch.send({image})`，用例立刻转红（`Failed to send "tall.png" via Feishu: … 234039 …`），恢复后转绿。

**English**：The auto-inline SIZE limit became three settings, one per media kind, each with its own range: `cardImageMaxMb` (1-10, default 10), `cardVideoMaxMb` and `cardAudioMaxMb` (1-30, default 15). The image default is 10 rather than 15 because that is Feishu's own ceiling — a card image must come from `im.v1.image.create`, which refuses more than 10 MB, so a larger field value could never be reached; video/audio go through `im.v1.file.create` (30 MB). The hydrator now measures each file against the ceiling of its CLASSIFIED kind (ISO-BMFF is classified before the check), which also closed a hole: Opus/WAV/MP3/FLAC had no byte check at all, so an oversized WAV was transcoded and uploaded regardless. Over-ceiling files are no longer written to the "inspected, not media" negative cache — that entry is keyed on path+mtime+size and short-circuited the next card, so raising a limit would not have taken effect until the entry was evicted. And `feishu_send_file` gained the file fallback its image branch was missing: a picture under 10 MB but over Feishu's resolution ceiling (GIF > 2000x2000, anything else > 12000x12000, `234039`) used to fail the whole call and deliver nothing, where the API's own advice is to send it as a file; it now arrives as an attachment with `sent_as: 'file'`, and reverting the branch turns the new test red.

### 新增：单卡媒体上限做成设置项（`src/config.ts` / `src/card-images.ts` / `src/index.ts` / `src/client/`，2026-09-24）

**动机**（使用者的要求）：「这个媒体文件的数量限制也在设置页面做一个」——上一批把视频/音频上限从 2 提到 12，但那个数字是代码里的常量，改它要发版。

**做法**：新增配置字段 `cardMediaLimit`（`1–30`，默认 `12`，`.volatile()` ⇒ 保存即生效、不重启、不打断正在跑的 turn）。语义与设置页文案一致：**图片算一处、视频与音频合起来算一处（各按这个数）**——这样一份图片很多的回答不会把同一条消息里的视频挤掉。hydrator 通过 `mediaLimit: () => currentSettings().cardMediaLimit` **每次判定时实时读**，所以下一次卡片写入就用新值；`claim()` 里两个计数各自对着这个数判。客户端是自包含的（不 import host 模块，否则会把 zod 和 config schema 打进浏览器包），所以 `CARD_MEDIA_LIMIT` 的边界在 `src/client/LarkSettingsCardController.ts` 里镜像了一份，真正校验的是 host schema；客户端 `writeValue` 再把暂存的文本转成**数字**（`999 → 30`、空 → 回到默认 12 而不是写最小值）。上限取 30 不是随意的：30 个视频 = 90 个计名额 + 它们拆出的文本段，仍在飞书 200 元素预算内，不变量测试就按**设置的上限**跑。

**验证**：typecheck 0 error、**704 tests / 42 files** 全绿（新增 `tests/config.spec.ts` 2 例：默认值/取值 + 越界钳制；`tests/client.spec.ts` 2 例：输入框渲染与 min/max、保存写出**数字**、越界与清空分别落到 30 / 默认；`tests/card-images.spec.ts` 2 例：上限**实时**生效、按组各算一份而不是一个共享池；最坏情况不变量测试改用设置的上限）。

**English**：The per-card media limit is now a setting, `cardMediaLimit` (1-30, default 12, `.volatile()` so a save applies without a restart and without killing a running turn). It counts per group — images on the one hand, video and audio together on the other — so an image-heavy reply cannot starve its own clips. The hydrator reads it live on every card write, and the worst-case card-budget test now runs at the setting's maximum, which is why 30 is the ceiling (30 videos spend 90 counted elements plus the text segments around them, still inside Feishu's 200). The client bundle mirrors the bounds because it deliberately imports no host module.

### 修复：卡片内联媒体的三个缺口——单卡只放 2 个、交付清单走不到内联、溢出续卡不过 hydrator（`src/card-images.ts` / `src/channel.ts` / `src/feishu-streaming.ts`，2026-09-24）

**现象**（使用者报告）：① 一张卡里的视频超过两个就不再内联，只剩路径文字；② 末尾那张 Turn Complete（交付文件）卡完全不渲染媒体。

**先查清"这是插件的限制还是飞书的限制"**（使用者的第一个要求）：真机打 `cardkit.v1.card.create`（只建卡片实体、不发消息），并带**负对照**证明探针能测出拒绝：

| 卡片内容 | 元素数 | 卡片字节 | 结果 |
|---|---|---|---|
| 2 / 8 / 16 / 32 / 64 个视频（带封面+fallback） | 3–65 | 0.7–19.3 KB | ✅ 全部接受 |
| **66 个视频** | 67 | 19.8 KB | ✅ 接受 |
| **67 个视频** | 68 | 20.2 KB | ❌ `300305 element exceeds the limit` |
| 198 个视频（不带封面/fallback） | 199 | 25.5 KB | ✅ 接受 |
| 199 个内联 `<audio>` | 200 | 28.7 KB | ✅ 接受 |
| 8 图 + 8 视频 + 8 音频 | 24 | 4.4 KB | ✅ 接受 |
| **负对照：201 个纯文本元素** / 对照：200 个 | 201 / 200 | 8.8 / 8.7 KB | ❌ / ✅ |

⇒ 飞书的真边界是**一张卡 200 个元素或组件**（嵌套的 `cover`、`fallback` 各占一个名额，所以带封面的视频一个吃 3 个，上限 66 个）与**卡片 JSON ~30KB**（`200860`，66 个视频才 19.8KB，先撞的是元素数）。**"2"完全是插件自己的上限，比飞书的边界小 33 倍**；真实成本只有上传时间（实测 ~1.2MB/s、串行、写卡前 `await`）。

**根因（三处）**：

1. `DEFAULT_MAX_MEDIA_PER_CARD = 2`，而且计数只算"新上传"——缓存命中的分支在计数前就 `continue`，于是同一张卡重复渲染时能内联几个取决于缓存时序而不是规则。
2. Turn Complete 卡的交付清单用行内代码 `` • `path` `` 渲染，而扫描器按坑 42 只认带 `()` 的 Markdown 引用 ⇒ **这张卡永远不可能内联**。2026-09-24 14:07 那轮 `present` 交付了 3 个视频（正文里根本没引用它们），3 个全成了路径。
3. 溢出 "continued" 续卡走的是裸 `channel.send`，**完全没过 hydrator** ⇒ 正文超过 `TEXT_STEP_CAP`（3000 字）之后，尾部的媒体永远不内联。

**修法**：

- 上限改为 **12/12**（视频/音频 12、图片 12），并改成数"**这张卡实际渲染几个**"（缓存命中与新上传一起计数）⇒ 同一张卡的重复渲染得到同一组媒体。附一条**最坏情况不变量测试**：12 视频 × 3 个计名额 + 12 张图 + 由它们拆出的文本段 ≤ 200 元素且 < 30KB。
- 上传改**有界并发 3**（`UPLOAD_CONCURRENCY`）：六个片段从六次串行往返降到一轮；每次上传仍带自己的 `withTimeout`，卡片总等待仍由每类预算封顶。
- 新增**预热**（`cardImages.warm`）：流式 `text-delta` 防抖 400ms 后，拿当前正文当一张一次性卡片跑**同一条判定链**（同 mode / 同工作区 realpath / 同字节与数量上限），只丢弃结果 ⇒ 真正写卡时基本是缓存命中，或直接 await 同一个在飞上传（`pending` 表本来就去重）。预热**不写负面缓存**（`recordFailure: false`）：流式文本可能在工具写完文件之前就出现该路径，记一条 60s 的"缺失"会让本该内联的媒体陪跑（关键坑 44）。
- 交付清单改为 `• [desc](path)`（无描述时 label 用路径；描述里的 `[`/`]`/反引号会破坏链接，做清洗；路径含空格或括号时用 `[label](<target>)` 形式），非媒体仍由中和逻辑退回 `desc · \`path\`` —— 与改动前等价。溢出续卡改为**并发 `prepareCard` 后按序发送**（一张一发地内联会让 N 张卡各付一次预算）。
- 去重有意不做：DSH Web UI 本身就是"正文一份 + 交付行一份"，且按 turn 去重会让步骤卡**自己的下一次更新**把媒体删掉（坑 43 同类）；缓存命中后重复几乎免费。

**验证**：typecheck 0 error、**698 tests / 42 files** 全绿（`card-images` 48、`channel-footer` 15、`feishu-streaming` 74）。新增用例覆盖：六片段回答全部内联（旧上限下会掉 4 个）、13 个引用只内联 12 个且第 13 个仍是可读引用、缓存命中计入上限使重复渲染得到同一组、上传确实重叠、预热命中缓存且**不污染**失败缓存、交付卡端到端内联出 `video` 元素、非媒体交付物退回"label · code span"、溢出续卡经 hydrator、以及飞书元素/体积不变量。

**English**：Card media inlining had three gaps. (1) The per-card cap was 2 videos/audio, and it counted only *fresh* uploads (a cache hit `continue`d before the counters), so how many media a card could render depended on cache timing. (2) The Turn Complete card rendered its `present` deliverables as inline code spans, which the reference scanner deliberately ignores — so that card could never inline anything. (3) The overflow "continued" cards were handed to the raw channel and never hydrated at all, so media past `TEXT_STEP_CAP` never rendered. A live probe against `cardkit.v1.card.create` (with a negative control) established that none of this comes from Feishu: a card may hold **200 elements or components**, where a `video` with `cover` + `fallback` spends three — 66 videos were accepted and 67 refused with `300305 element exceeds the limit` (198 cover-less videos, 199 inline `<audio>` tags and 200 plain elements all fine) — plus a ~30 KB card-JSON ceiling. The plugin's cap of 2 was 33x stricter than Feishu's own. The caps are now 12/12 and count what the card actually renders (cached hits included), uploads run with a bounded concurrency of three, a new `warm()` pass resolves the streaming text's media ahead of the write (identical pipeline, result discarded, and it deliberately does **not** record a missing file in the negative cache — key pitfall 44), deliverables became Markdown links so the existing hydrator inlines them, and the overflow cards now go through the same hydrator. Deduplication between the reply text and the deliverable list is intentionally absent: it mirrors the Web UI, and per-turn bookkeeping would strip media from a step card's own next update. A worst-case invariant test keeps the built card inside Feishu's 200-element and 30 KB budgets.



### 修复：媒体内联让卡片写入变慢，交付守卫读到过期状态 → 回复后多发一张 reply 卡（`src/feishu-streaming.ts` / `src/channel.ts`，2026-09-24）

**现象**（使用者报告）：「在 reply 以后又生成了一张 reply 卡」——同一段回答先随步骤卡上屏，紧接着又出现一张正文相同的回复卡。

**根因（不是新逻辑写错，而是旧竞态被拉宽）**：`channel.ts` 靠两个标记决定"这段文字是不是已经在屏上了"——流式侧 `noteStepCardText()` 在把带文字的卡**交给飞书的那一刻**乐观地打标（`markIntermediateSent`），确认送达后再由 `noteTextDelivered()` 记 `turnTextDelivered`；`flushed()` 在 turn/end 时**如果没有任何确认送达，就撤回那个乐观标记**，channel 于是走"没人显示过正文"的分支、把整段回复再发一遍（这是为了让"卡片根本没发出去"时不吞掉答案，2026-09-21 的修复）。

问题在"撤回"这一侧的判据：`flushed()` 只等 `flushPromises`（turn/end 的 flush，覆盖**还在 150ms 防抖窗口里**的那次写入）和最后一次 send，**不等已经出窗口、正在飞的那次 update**。媒体内联把这一次写入从毫秒级拉到**秒级**（要上传整段视频/音频、可能还要 ffmpeg 转封装）——于是 turn/end 到来时：防抖条目早就删了 → `flushPromises` 立刻 resolve → `flushed()` 读到 `turnTextDelivered === false` → 撤回乐观标记 → channel 发完整回复卡；而那次在飞的写入随后落地（02:17:20 的 `[update] seq=2`），步骤卡也拿到了同一段文字 ⇒ 两张卡内容重复，且第二张出现在 reply 之后。journal 时间线完全对上：`02:17:18 assistant/message → updating` → 三次 `[media] uploaded` → `02:17:20 [update] seq=2`。单看旧行为（只内联图片）也能命中，但窗口只有几百毫秒，所以一直没被踩到。

**修法**：跟踪**在飞的步骤卡写入**（`inFlightUpdates`，按 session 记一组 promise），`flushed()` 在读完 `flushPromises`/最后一次 send **之后**再 `Promise.all` 等它们落地，然后才读 `turnTextDelivered`。等待是有界的（`FLUSH_TIMEOUT_MS = 120s`，而单卡媒体预算最多 15s）；写入失败仍会保持"未送达"→ 照旧回退到发回复卡，所以"卡片发不出去"的兜底没有被削弱。

**顺带加了两行诊断日志**（这类问题以前在 journal 里完全看不见）：命中步骤卡分支打 `[reply] a step card carried the text → footer only`，回退分支打 `[reply] no step card carried the text → posting N reply card(s)`。

**验证**：新增回归用例 `tests/feishu-streaming.spec.ts`「waits for a text-carrying write that is still in flight instead of withdrawing the note」——门控 `updateCard` 只在带正文的那次写入上挂起，断言 `flushed()` 在写入落地前**不会** resolve、且 `clearIntermediateSent` 不被调用。**反向验证过**：把 `flushed()` 里新加的 `Promise.all(inFlightUpdates…)` 那一行去掉，该用例立刻转红（`expected true to be false`），恢复后转绿。全量 **683 tests / 42 files** 全绿，typecheck 0 error，产物已重建。

**真机复核（2026-09-24 02:23）**：修好后那次重启的同一轮回答里，journal 只出现 `[reply] a step card carried the text → footer only`，第二张 reply 卡没再出现；使用者确认「没有异常，都正常渲染」。

**English**：The duplicate reply was a pre-existing race that media hydration widened. `channel.ts` trusts two marks to decide whether the turn's text is already on screen: an optimistic one set when a text-carrying card is handed to Feishu, and a confirmed one set when that write lands; `flushed()` withdraws the optimistic mark when nothing was confirmed, so the fallback reply card is posted. It only awaited the turn/end flush (which covers a write still inside the 150 ms debounce) and the last `send` — never a write that had left the debounce and was in flight. Uploading a video/audio file for card media turns that write into a multi-second operation, so `flushed()` read `turnTextDelivered === false` while the card that would receive the very same text was still on its way, posted the full reply card, and the in-flight update landed right after it. `flushed()` now awaits every in-flight step-card write (bounded by the existing 120 s flush timeout; per-card media budgets are 15 s at most) before reading the delivery record, and two journal lines now say which branch was taken. A regression test gates the text-carrying write and asserts the flush waits; removing the new await makes it fail.

### 新增：卡片内联媒体——视频与音频也能进消息（`src/media-upload.ts`（新）/ `src/card-images.ts` / `src/card-markdown.ts` / `src/media-sniff.ts` / `src/config.ts` / `src/client/`，2026-09-24）

**动机（对齐 DSH，而非自造功能）**：DSH 的 Web UI 把模型正文里的工作区路径解析成可打开的文件（`[图](runs/a.png)` 内联成图、`[clip](runs/a.mp4)` 是可点击的文件链接、正文里的 `` `report.pdf` `` 会变成可点开的文件 chip），模型因此习惯用 Markdown 引用自己产出的文件。飞书卡片**没有**指向本地文件的链接能力，但**有真正的媒体组件**——所以对齐方式就是把媒体直接渲染在消息里。

**官方事实（2026-09-24 逐条读文档确认，`open.feishu.cn` 的 `.md` 端点）**：

- **视频**：卡片 JSON 2.0 的 `{tag:'video'}` 元素，**只认 MP4 容器**、单文件 ≤30MB、客户端 ≥V7.56（低版本显示 `fallback`），且**含视频的卡片必须在 `config` 里写 `enable_forward: false`，否则卡片发送直接失败**；`file_key` 必须由 `im.v1.file.create({file_type:'mp4', duration})` 上传，且上传应用与发卡应用一致。
- **音频**：`{tag:'audio'}` 元素，**或**富文本里的 `<audio file_key='file_v3_…' audio_id='…' show_time=true></audio>`（本插件用后者：不必把 markdown 元素拆开）；**只认 Opus**、≥V7.49、同样要求 `enable_forward:false`，且含音频的卡片不能用「仅特定人可见」接口发送。`audio_id` 相同 + `file_key` 相同时，卡片更新不打断播放。
- **其余文件类型（PDF / doc / xls / ppt / zip / stream…）：没有任何内联组件**——`file` / `attachment` / `media` / `cloud-doc` / `file-preview` 文档路径全部 404，v2 组件总览里也没有文件类；富文本的 HTML 白名单里同样没有 `<file>`（`<video>` 也不能写进富文本，视频只能是独立元素）。这类文件只能继续走原生文件气泡（`msg_type:'file'`，即现状）。

**实现**（沿用 L3 的水位线：路径限定、上传有界、失败退回文字）：

- `src/media-sniff.ts`：新增 `sniffAudioFormat()`（opus/wav/mp3/flac/m4a，按魔数）与 `classifyMedia()`（图片 → 可播 MP4/QuickTime → 音频）；ISO-BMFF 只有**没有视频轨**时才判为音频，避免把「编解码器飞书播不了的 MP4」误传到 `file_type:'opus'`。`sampleEntryCodecs()` 从 `findVideoCodec()` 里提出，两处共用。
- `src/media-upload.ts`（新）：`im.v1.image.create` / `im.v1.file.create` 的上传 + `ffprobe` 时长 + `ffmpeg` 抽封面（视频）与**转封装/转码**：QuickTime → MP4（`-c copy`）、wav/mp3/m4a/flac → Opus。每个网络调用与每个 ffmpeg 调用都有超时，临时文件必删，任何失败只 warn 并返回 `undefined`（引用退回文字，绝不让媒体拖垮消息）。
- `src/card-images.ts`：从「只认 `![](path)` 图片」扩到**所有卡片媒体**——`[label](path)` 这类**链接**也会被识别（DSH 的 Web UI 正是这样渲染文件链接的，而飞书点不开本地路径）。改写规则：图片 → `img_v3_…`；音频 → 原地插入 `<audio>` 播放器（`audio_id` 由 key 派生，所以卡片反复更新也不会打断播放）；视频 → **把 markdown 元素拆成「文字 + `{tag:'video'}` 元素 + 文字」**（媒体元素装不进富文本组件），并给卡片补 `config.enable_forward = false`。缓存按 `path+mtime+size`，并新增**「已检查过但不是媒体」的负缓存**（普通文件链接不会被反复读盘）；并发去重覆盖三种媒体。
- **边界**：图片 ≤10MB、视频/音频 ≤30MB；单卡最多 8 张图 + 2 个音/视频；图片预算 6s、媒体预算 15s（超时就留在文字里，**在途上传继续跑并把 key 写进缓存**，下一张卡就能用上）；`any` 模式仍然只放宽路径范围，不放松大小/数量/时间。
- `src/card-markdown.ts`：新增 `<audio>` 中和——`file_key` 不是飞书发的 `file_v3_…` 就降级成 `🔊 \`…\``（代码块/闭合行内代码里原样保留）；末次兜底（`aggressive`）会把 `{tag:'video'}`/`{tag:'audio'}` 元素一并降级成文字——被拒收时「卡片发出去」优先于「内联播放」。
- **设置项**：沿用 `cardImages` 这个键（改名会丢已保存的值），含义扩为**正文里的媒体**：`text` 永不上传 / `workspace` 仅工作区内（默认）/ `any` 任意可读路径。设置页文案与 `Config.description` 已同步。

**实测**：`npm run typecheck` 0 error；**682 tests / 42 files 全绿**（新增 32 例：媒体分类 6、卡片改写与限额 10、音频中和 4、上传器 12）；`npm run build` 产出 `lib/index.js` + `client/client.js`。**ffmpeg/ffprobe 真机联调**（一次性脚本，不留在测试里）：真实 H.264 MP4 → 分类 `video/mp4/avc1`、时长 1000ms、封面抽取并上传成功；真实 WAV → 转 Opus 上传、时长 1007ms。

**真机端到端（2026-09-24 02:23，修复重复 reply 卡后的那次重启）**：在工作区 `notes/` 下造了三个探针文件（1.5KB PNG / 11.5KB 2s H.264 MP4 / 14.8KB 2s Opus），**只在回答正文里**写 `![探针图片](notes/media-probe.png)`、`[探针视频](notes/media-probe.mp4)`、`[探针音频](notes/media-probe.opus)`：

- journal：`[media] uploaded …png → image img_v3_…` / `…mp4 → video file_v3_…` / `…opus → audio file_v3_…`，三条各一次，随后 `[reply] a step card carried the text → footer only`（**没有** `posting N reply card(s)`，即没有第二张回复卡）；
- **使用者目视确认**：图片、卡片内可播放的视频（带封面、2s）、卡片内音频播放器三样都正常渲染，整轮没有异常、没有重复卡片。

⇒ 「Markdown 里的工作区媒体引用 → 解析 → 上传 → 卡片内联渲染」整条链路成立，且与「一张回复卡」的交付语义并存。

**这一批明确没做**（记录在案）：① 正文里的**行内代码路径**（`` `runs/a.mp4` ``，DSH 的 `fileMentions` 会把它变成可点 chip）未扫描——只处理带 `()` 目标的 Markdown 引用，避免正文里任何一段代码都被当成待上传文件；② 非媒体文件仍然无法内联（上游没有组件），也不新开公网文件服务（本插件唯一的 HTTP 路由是 loopback-only）；③ 只有 `workspace`/`any` 两档路径范围，没有「只内联视频不内联音频」这类细分开关。

**English**：Feishu cards gained real media components (video/audio element, Opus-only audio, `enable_forward:false` mandatory, MP4-only video) while offering no way to open a local path — so the DSH-WebUI habit of writing `[clip](runs/a.mp4)` in a reply produced nothing clickable here. The plugin now resolves Markdown **image and link** destinations against the session workspace and renders them natively: images become `img_v3_…` (L3, unchanged), audio becomes an inline `<audio>` player (Opus; other containers are transcoded with ffmpeg), and video becomes a real `{tag:'video'}` element spliced next to the surrounding text (QuickTime is remuxed to MP4), with `config.enable_forward = false` added because Feishu refuses such a card otherwise. Uploads keep the L3 discipline — workspace-scoped paths (plus an opt-in `any`), byte/quantity/time caps, `path+mtime+size` caching with a negative cache for inspected non-media, bounded uploads and ffmpeg runs, and a text fallback that is always cheaper than losing the card. Every other file type (PDF/office/zip/stream) has no card component at all and still travels as a native file message. The `cardImages` setting now governs all media (key kept so saved values survive). typecheck clean, **682 tests green**, artifacts rebuilt; verified against real ffmpeg/ffprobe output (MP4 duration + cover, WAV → Opus).

### 修复：重启落在活跃回合上，会把「聊天 → 会话」绑定整份清空（`src/harness.ts` / `src/index.ts` / `src/feishu-streaming.ts`，2026-09-23）

**现象**：使用者报告「服务重启了以后，切换到了一个以前的 session，而不是自动回到当前的 session」。查下来不是"选错了会话"，而是**磁盘上的绑定表被清空**，聊天于是退回**按 chatId 算出来的默认会话**——那个默认会话恰好是一个旧会话。

**取证（三条独立证据）**：

1. **有升级前的备份可对照**。09-23 01:47 的 alpha.2 升级脚本留了一份 `lark-session-map.json` 副本：`chatToSession` **11 条**（1 个 DM + 10 个群话题）、`chatToRootId` **10 条**；而事故后磁盘上只剩 `chatToSession` 1 条、`chatToRootId` **0 条**——**唯独 `busyMode` 6 条完好无损**。
2. **默认会话是确定性哈希，可验算**。`toSessionId` = `sha256('feishu\0' + chatKey)` 前 40 位（`conversation.ts`）。算 `chat:<DM>` 得到一个确定的 `lark-v2-…` id，正是重启后聊天落到的那个"旧 session"。
3. **会话日志时间线对得上**。事故前的那个会话在 **21:51:19 → 22:01:29 没有任何事件**；而算出来的默认会话（此前最后活动是凌晨 03:20）在 **21:56:37** 突然被唤醒，使用者 21:56 那条消息就是进了它。

**根因**：`HarnessConversationService.dispose()` 会清空 `chatToSession` / `chatToRootId` / `seenChatKeys` / `chatToCreation`，而 `saveSessionMap()` 把内存里的这几张表整体写成文件。**dispose 之后仍有 in-flight 异步任务持有这个已 dispose 的实例**（`bridgeHolder.current` 不被清），任何一次 `recordChatKey` / `noteTopic` / `setBusyMode` 都会触发保存 → **把清空后的状态写回磁盘**。触发条件是「重启正好打在正在跑的回合上」（本次 21:51:06 的停止，21:51:04 还在发步骤卡；20:10 那次重启时聊天空闲，所以没丢）。`chatToBusyMode` 是唯一幸存字段，因为 dispose 漏清了它——这条特征也正是把嫌疑锁定到 dispose 的依据（文件被截断或解析失败会让四个字段一起空，并且会打 `loadSessionMap failed`，journal 里 0 条）。

**改动**：

- `dispose()` 先置 `disposed`；`saveSessionMap()` 见到它直接**拒写**并留一行日志。
- 再加一条**空表拒写**：本次启动从磁盘读回过绑定（`loadedBindings > 0`）而现在两张表都空了，说明有*第二条*清空路径，同样拒写并打日志——这行日志若真出现，就是那条未知路径的线索。
- 落盘改为**临时文件 + rename**（原子写）：重启/SIGKILL 打在写盘中间不再留下半截 JSON（那会让下一次启动把**全部**绑定一起丢掉，而不只是上次保存之后的改动）。
- 启动读取失败时把坏文件**隔离**成 `lark-session-map.json.corrupt-<ts>`，而不是让下一次保存直接覆盖掉唯一的副本。
- `loadSessionMap()` 每次启动打一行「读回了几条绑定 / 几个话题根」——本次事故只能靠不相关的升级备份反推，就是因为少了这一行。
- `dispose()` 顺带清 `chatToBusyMode`，不再制造「只剩一个字段」这种看着像正常的半损坏文件。

**顺带修掉的第二个洞（真机实测发现）**：飞书对**非法卡内容不抛错**，而是返回 **`code=200570` + `card_id: ""`**（实测：普通卡 `code=0` + 19 位 id；带非法图片 key 的卡 `code=200570` + 空 id）。而 `createCardInstance` 原先只判 `cardId === undefined`，**空字符串会通过**，被当成正常 card_id 交给 `sendCardByReference('')` → 飞书报 `cardid is invalid`，且该分支**不再回退普通发送** → **那张步骤卡永远不出现**。这正是 journal 里 `[send] send by reference failed: … cardid is invalid` 的成因。现在：`createCardInstance` 遇非零 code 抛出**带 code/msg 文本**的错误（于是能被 `card-write.ts` 的拒收重试与回退 patch 认出来），空 id 一律拒绝；`feishu-streaming.ts` 侧也把空 id 当"没有可用引用"，直接走普通发送。

**测试**：`tests/harness.spec.ts` +2（disposed 实例不得覆写已持久化的 map——含话题根；原子写不留 `.tmp`），`tests/feishu-streaming.spec.ts` +1（空 card id 回退普通发送、不调 `sendCardByReference`）。全量 **650 passed / 41 files**，typecheck 0 error，build 通过且 `client/client.js` **逐字节未变**。

**数据恢复（已执行 2026-09-23 22:10–22:11）**：事故丢掉的是 10 个群话题的绑定与 10 个话题根坐标（它们**全部**不等于各自的默认值，也就是说这 10 个话题当时也一起退回了默认会话）。恢复脚本：先把合并结果写成暂存文件（**失败就不动服务**）→ `systemctl --user stop dsh` → 在**服务已停的窗口内**安装（运行实例不可能覆盖它）→ `start`。合并口径＝`chatToSession` + `seenChatKeys` + `chatToRootId` 取 01:47 备份、`busyMode` 取当前（当天 `/busy` 的最新值）、DM 那条以使用者 22:01 手切的结果为准。

- **一处硬限制**：11 条绑定里 **2 条恢复不了**——`omt_19f4c75f…` / `omt_19f108b6…` 指向的会话在 `~/.dsh/sessions/**` 里**已无任何日志文件**（其余 9 条都在）。脚本按"会话日志是否存在"过滤，跳过这两条并写进日志；它们此后按默认会话走。
- **实测**：`staged 9 bindings, 10 roots, 6 busy modes` → `installed 9 / 10 / 6` → 启动后 journal 出现新加的那行 `dsh-feishu: session map loaded: 9 bound, 11 seen, 10 topic roots, 6 busy modes`（此前是 `1 / 1 / 0 / 6`），复检文件仍为 9/11/10/6、**未被再次清空**，重启后 **0 条 error**。
- **证据状态（如实记录）**：`disposed` 门与空表拒写在真机上**还没有被触发过一次**（重启后尚无保存发生），二者的证据目前是单测两例；真再发生会在 journal 留下 `refusing to persist the session map` 一行。

### 修复：卡片写不进去时用户不再一无所知；错误原因不再被外层包装吃掉（`src/error-text.ts` / `src/feishu-streaming.ts` / `src/i18n.ts`，2026-09-23）

**先纠正旧结论**：TODO 里 O6 记的是「飞书侧报错被截断、不如 WebUI 详细」。使用者先说「现在很多错误在飞书已经能看得到了」，实测证实了这个观察——**那四条截断上限在真实负载下一次都没咬到**。口径：本机全部 **23 个会话日志**（`session.v3.jsonl.zstd`）解出每个 `tool-result` 块，取 `isError === true` 的正文长度：

| 指标 | 实测值 |
|---|---|
| 工具结果总数 / `isError=true` | 21645 / **734** |
| 错误文本长度 | min 22 · p50 **149** · p90 **313** · p99 **313** · **max 344** |
| 超过 600 / 1500 / 3000 / 10000 字 | **0 / 0 / 0 / 0 条** |
| `turn/end` 且 `reason.kind === 'error'` | 全历史 **3 次**，最长 **140** 字 |

p90 才 313 字，离 1500 的预览上限差 5 倍。真正没解决的因此不是"被截断"，而是**有一类错误用户完全看不到**：7 天 journal 里 `[update] failed`（`cardkit.card.update` / patch）出现 **15 次**，而那两个分支只 `console.log` + `logger.warn` —— 卡片**静默停在旧内容**，这正是「WebUI 已经在跑工具调用、飞书仍显示🧠深度思考中」那两张卡的成因（另一类 `message handling failed` 6 次是有用户可见文本的）。

**改动 1：`errorText()` 补上根因（`src/error-text.ts`）**

- 补 **`cause` 链**：最多 4 跳、去重、防自引用（`cause === 自身` 直接停），用 ` ← ` 拼在原文后面，例如 `Request failed with status code 400 ← socket hang up`。此前只取 `error.message`，而本仓最常见的两个错误形态恰恰是外层没有信息量的包装：`withTimeout` 的 `xxx failed: ...` 与飞书 SDK 的 `Request failed with status code 400`。
- 补**飞书 SDK 响应信封**的 `response.data.msg`（真正的原因在那里，如 `Failed to create card content, ext=ErrCode: 200570; ErrMsg: card contains invalid image keys`），`code` 也认信封里的业务码。
- **只读 `message` / `code` / `response.data`，绝不读 `config` / `request`**——那是请求体，token 路径上带 app secret（关键坑 29）。
- 上限 600 → **1000** 字符。这里不涉及卡片体积：9 个调用点全是**文本消息**，而文本消息请求体上限 150 KB，是卡片的 5 倍；`errorText` 的输出也不再进 markdown，所以不会被图片/链接语法连带拒收（关键坑 39）。

**改动 2：陈旧卡改为用户可见（`src/feishu-streaming.ts` + `src/i18n.ts`）**

- `StepCardRef` 记下**最近一次写入是否失败**：失败的 `catch` 里记原因，成功时清除。只报"**最终**没被写回去"的卡，一次网络抖动被下一次防抖写入救回时**不报**（`STALE_CARD_CONFIRM_MS = 2s` 确认窗，比 150ms 防抖 + 一次出站往返宽松）。
- 超过确认窗仍在失败 → 发一条**纯文本**消息，`⚠️ 第 N 轮第 M 步的卡片没能更新，已停在旧内容。\n原因：…`（轮/步号在发卡时捕获，`resetStep` 清空状态后仍能准确指认）。**每张卡只报一次**；`stop()` 清掉待发定时器，dispose 之后绝不再发。
- **为什么用普通文本消息而不是卡片**：要上报的正是"这张卡写不进去"，再用卡片上报是自相矛盾（同一类拒收会把它一起吞掉）；文本不经 markdown 解析，错误原文里的任何图片/链接语法都只是文字（关键坑 39）；150 KB 的预算也让原因不必再截断。
- 与既有的"答案兜底"分工不重叠：channel.ts 的 `Reply` 兜底卡负责**别丢答案**，这条通知负责**告诉用户那张卡为什么停在旧内容**。

**仍保留的上限（有数据支撑，本次不动）**：`RESULT_PREVIEW_CAP = RESULT_CONTENT_CAP = 1500`、结构化预览取样（paths 20 / files 5 / matches 3 / diffs 3×8 行）、`REASONING_CAP = 200`、`TEXT_STEP_CAP = 3000`（正文溢出拆续卡，**不丢**）。仍可选的逃生口记录在 TODO O6：工具结果 >4k 时另发文本全文（0/734 触发）、超大错误落文件交 `feishu_send_file`；`/error` 回看**倾向不做**（与前者信息重复）。

**测试**：`tests/error-text.spec.ts` 7 → **14 例**（cause 链、嵌套与深度上限、cause 与正文重复时不复述、`response.data.msg`、信封业务码、自引用 cause、**`config` 里的内容绝不外泄**、新上限）；`tests/feishu-streaming.spec.ts` 新增 **3 例**（持续失败 → 恰好一条文本通知且带轮/步号与因果链、被后续成功写入救回则**静默**、`stop()` 后待发通知不再发出）。全量 **647 passed / 41 files**，typecheck 0 error，`npm run build` 通过且 `client/client.js` **逐字节未变**（本次未动客户端）。

### 新增：卡片图片模式设置（`src/config.ts` / `src/client/` / `src/card-images.ts`，2026-09-23）

- **新增配置项 `cardImages: 'text' | 'workspace' | 'any'`（默认 `workspace`）**，在 **Settings → 飞书与 Lark → 卡片显示** 里以「正文里的图片」下拉呈现（沿用该页既有的原生 `<select>` 行，不需要新组件）。三档的含义：
  - `workspace`（默认）：自动上传**会话工作区内**的图片并**内联显示**在卡片里（即上面 L3 的行为）；
  - `text`：**永不上传**，正文里的图片引用只保留成路径文字（最保守；需要图时让模型调 `feishu_send_file`）；
  - `any`：正文里出现的**任意可读图片路径**（含工作区外）都上传并内联。
- **为什么没有「关闭」档**：L1 的中和不是可选项——不做卡片就会被飞书**整张拒收**（`200570`）。所以这一项管的是「允许多走多远」，不是「要不要防炸卡」；设置项提示里写明了这一点。
- **热生效、不重启**：字段与其余可编辑字段一样是 `.volatile()`，读取点是 `startCardImages({ mode: () => currentSettings().cardImages })` 里的**活取值**，保存即生效（与 P6-3 同一套语义；`connectionFingerprint` 不含它，所以改它不会推倒 runtime）。
- **`any` 不是新增能力而是放宽**：模型本来就能用 `feishu_send_file` 发工作区外的任意文件，所以这一档只是省掉一次显式工具调用；`workspace` 之所以作为默认，是把"隐式上传"的范围收在工作区内（隐私边界，见关键坑 39）。
- **测试**：`tests/card-images.spec.ts` 新增 5 例（`text` 零上传、`any` 允许越界、越界告警里提示 `any`、`any` 下跟随符号链接到真实文件、**活取值**——运行时切换档位立即生效）；`tests/config.spec.ts` 1 例（三档取值与默认）；`tests/client.spec.ts` 2 例（下拉渲染三个选项与当前值、改档后保存实写 `cardImages`）。全量 **637 passed / 41 files**，typecheck 0 error，`npm run build` 通过并重建 `client/client.js`（客户端 UI 有改动，必须一起提交）。

### 修复：飞书因 markdown 图片拒收整张卡片（`src/card-markdown.ts` / `src/card-write.ts` / `src/card-images.ts`，2026-09-23）

**现象**：一张步骤卡**永久停在「🧠 深度思考中…」**，而 WebUI 里那一轮的工具调用和答案都已经出来了；同一轮里另一处「处理这条消息时出错：Failed to create card content, ext=ErrCode: 200570; ErrMsg: card contains invalid image keys; ErrorValue: image key runs/…png」。

**根因（已取证到 API 层）**：飞书卡片 markdown 里的 `![alt](src)` **不是文本，是图片元素**，而那个槽位只认**上传图片接口返回的 `img_key`**（官方[富文本文档](https://open.feishu.cn/document/feishu-cards/card-components/content-components/rich-text?lang=zh-CN)：图片语法即 `![hover_text](image_key)`）。括号里放本地路径、甚至放公网 URL，都会让**整张卡 400**（`200570`，外层再包一层 `230099`）——不是丢那张图，是整条消息作废。模型之所以会写这种 markdown：**WebUI 会解析工作区路径**，那句在那里是有用的。于是「一个模型输出、两个渲染器」的问题被飞书用最激烈的方式暴露出来。

对同一个卡片实体逐个试过（`card.create` + `card.update`，未发任何消息）：

| 载荷 | 结果 |
|---|---|
| `![](runs/a.png)` | ❌ `200570`，ErrorValue 就是那个路径 |
| `![](https://example.com/a.png)` | ❌ `200570`，**公网 URL 同样不行**（飞书卡片不做外链抓取） |
| `![](img_v3_…)`（真上传过的 key） | ✅ 通过 |
| `[a](runs/a.png)`（没有 `!`） | ✅ 通过（渲染成链接，但点不动） |
| 围栏 / **闭合**行内代码里的 `![]()` | ✅ 通过（当字面量） |
| `` `![x](runs/a.png) ``（**未闭合**的反引号） | ❌ `200570`（反引号并不保护） |
| `> ![x](…)`（引用块）、`\| ![x](…) \|`（表格单元）、`![a](p "t")`（带标题） | ❌ 全部 `200570` |
| `![a](runs/a\`b.png)`（目标里有反引号） | ❌ `200570`——**反引号在目标里也不算代码跨度** |
| `![a](runs/a b.png)`（目标里有空格） | ✅ 通过 |

**修法（三层，按 2026-09-23 的决定做 L1–L3；L4 明确不做）**：

1. **L1 中和**（`src/card-markdown.ts`）：卡片 markdown 里凡是**代码跨度和围栏之外**、又不是真 `img_v3_…` key 的图片引用，降级为 `🖼 alt · \`path\``；飞书点不动的相对/绝对路径链接降级为 `label · \`path\``；外链、`mailto:`、真 key、**闭合**代码跨度一律原样保留。信息不丢——路径还在，可以复制，也可以让模型用 `feishu_send_file` 补发。扫描器按上面那张表的实测结论写：**只有闭合**的反引号才保护，未闭合的、以及目标里的反引号都不保护。
2. **L2 拒收兜底**（`src/card-write.ts` + `src/index.ts`）：L1 之后仍被拒（说明有没想到的非法元素）→ **无差别剥掉所有图片引用再写一次**；CardKit 的 `sequence` 用内部**单调下限**推进（重试重复了调用方已经计过的一次写，不能复用它的号）；`card_id → message_id` 记账，实例更新仍被拒就**回退 `im.v1.message.patch`**——于是"卡片静默停在旧内容"这条路被堵死；连剥净版都被拒才告警。
3. **L3 内联真图**（`src/card-images.ts`）：正文里指向**本会话工作区内真实图片**的路径，先上传拿到 `img_key`，再把卡片改写成 `![alt](img_v3_…)` → **图片直接在卡片里渲染**（不必另发一条图片消息）。范围严格收窄：只认 `![alt](path)` 语法里的路径、只认工作区**真实路径**之内（`realpath` 后再判包含，符号链接指向外面一律拒绝）、只认真实图片格式（魔数嗅探）、单个 ≤10MB、每卡最多 8 张、单卡总预算 6s；按 `path+mtime+size` 缓存 key 并在同文件并发时**共享同一次上传**（步骤卡一次要 update 十几回）；任何失败都只是退回 L1 的文字形态，**绝不因为图而丢内容**。
4. **L4「让模型别再写」明确不做**（使用者 2026-09-23 决定）：那会破坏 WebUI 体验——**模型输出只有一份，WebUI 是它的正确渲染器**，该适配的是渲染侧的飞书，而不是让模型迁就某个渠道。

**接入点（单点兜底，不改那 ~90 处 markdown 构建）**：适配器覆盖所有自己发卡的模块；**并把 channel 工厂包一层**，因为 `channel.ts` 的回复卡/续卡/footer 是直接走 SDK 的，否则会绕过全部保护。

**验证**：`tests/card-markdown.spec.ts` 22 例 + `tests/card-write.spec.ts` 12 例 + `tests/card-images.spec.ts` 24 例（越界与符号链接逃逸、缓存与并发去重、mtime 变化重传、非图片/缺失/超限、上传抛错、预算耗尽、每卡上限、围栏内不处理）；全量 **630 passed / 41 files**，typecheck 0 error，`npm run build` 通过且 **`client/client.js` 逐字节未变**（本批只动 host 侧）。见关键坑 39。

### 变更：面板卡三处跟进（清理按钮 / 触发归属 / 子代理模型与树形，2026-09-23）

**1. 后台任务卡加「🧹 清理已完成」按钮**（`src/feishu-jobs.ts` / `src/feishu-panel.ts`）

- **语义对齐 WebUI**：WebUI 的 job list 里那个 Clear 是**只清视图**（源码注释原文 *client-side hide only; the registry keeps its records*）——飞书这边照抄：把**已结算的行**从名册里删掉，宿主注册表一条不动，聊天里已发出的历史卡也不动。
- **只在卡上确实有已结算行时才出现**（点了没用的按钮比没按钮更糟）。点完：还有运行中的行 → **重发一张干净的面板卡**（那就是反馈）；全清光了 → 回一句 `🧹 已清理 N 个已完成的后台任务`（否则清空后没有卡可发，用户看不到任何反馈）。
- **回查按被点击卡片的 message id**：面板发送器维护一份**有界**的 `messageId → 名册键` 映射（`keyOf`，上限 64 条，FIFO 淘汰）——卡片回调只带 `chatId` + `messageId`，而一个群可以有多个话题（关键坑 31），绝不按群猜。查不到就记一行 info 而不是装作没事。
- 卡**只发不更新**，所以按钮永远不会撞上「就地更新 2–3 次后回调失效」（关键坑 11）；载荷走 `behaviors`（关键坑 4）。

**2. 标记「本回合由后台任务完成通知触发」**（`src/feishu-streaming.ts`）

- **上游事实**：任务结算时 `@deepseek-ai/dsh-tool-jobs` 会塞一条**带来源的用户消息**（`source.kind = 'tool-jobs'`）：owner **空闲** → `owner.followup(...)`（**这一轮就是它开的**）；owner **忙** → `owner.inject(...)`（只是插进当前轮的上下文）。
- **判据**：DSH 把开轮的消息紧跟在 `turn/start` 之后第一个 `step/start` 后面 append，而注入的 notice 要到更靠后的某一步才被认领 —— 所以「**本回合第一条 `user/message` 的来源**」就是触发源（`turn/start` 重置两个回合级开关）。这与 WebUI 的 turn-trigger 归属同源（它按客户端专有的 `inbox-next-turn` 认领集判定，宿主侧读不到）。
- **渲染**：该回合**每一张步骤卡**正文最上方加一行 `⚡ 本回合由**后台任务完成通知**触发`（notation）；`step/start` 早于那条消息，所以占位卡是先上屏、随后**同一张卡**补上标记；若通知落在首卡 150ms 防抖窗口内，首卡构建时就已经带上（两条路径都有单测）。
- **有意不标**：忙时注入的 notice（那一轮是人发起的）。目前只认 `tool-jobs`；`schedule` / `subagent-settled` / `goal` / `agent-message` / `webhook` 等同类来源各自加一行即可。

**3. 子代理卡显示模型 + 树形连线**（`src/feishu-subagents.ts`）

- **模型列**：值来自**子会话自己**的 `request/context`（`{provider, model, contextWindow}`）——父会话的 `subagent/catalog` 与 `subagent/start|end` 都不带模型；子会话同样是普通 session，其事件本来就到这个插件的 `session/event` 订阅里（`session.append` 对每次 append 都发布，无类型过滤），所以**零新依赖、零异步读取**。未知时显示 `—`。
  - 噪音控制：模型只算"细节变化" → 走面板**非紧急刷新下限**（30s），且若此刻正有一张卡在构建中就直接跳过（那次构建已经带上新模型，`hasPending()`）。净效果：短子代理仍然只发 2 张卡（注册 / 结算带模型）。
- **树形连线**：每行记住 `parentId`（子会话 id），卡片按**深度优先**排列（父行紧跟其整棵子树），标签前画 `├─ ` / `└─ `（最后一个子节点），祖先"下面还有节点"时补 `│  `。
  - 起因：使用者反馈**全角空格缩进在飞书里"效果很一般"**——表格单元格里的前导空白会被折叠/吃掉，缩进看起来就是平铺。改画线后可见、还能看出哪个是最后一个子节点。
  - 实现坑：连接线必须写在**行内代码之外**——`tableCell()` 会 `.replace(/\s+/g, ' ')`，把 `│  `（两空格）压成 `│ `，树的竖线就错位了。
  - 兜底：父行不在名册里（被 30 分钟 TTL 清掉）时该行**当根**渲染（无连线）；被 8 行上限挤出窗口时连线仍在（会指向表外的父），卡上另有「另有 N 条更早的记录未列出」。

**验证**：typecheck（host + client）0 error；**572 passed / 38 files**（相对上一笔 +5：清理按钮的存在/载荷/清理重发/清空回执/未跟踪卡/外来载荷/回调退订、`keyOf`、`hasPending`、模型已知未知、树形兄弟/第三层/孤儿行/树序、触发标记五例等）；`client/client.js` 逐字节未变。

**实测（2026-09-23 12:20–14:33，三次重启后）**：

- **清理按钮 / 触发归属**：`run_in_background` 的 `sleep 45` 结算时（12:18:20）**我没有发任何消息**，DSH 自己开了新的一轮；该轮的步骤卡由实测走的就是这条判定（日志时间线与 `source.kind = tool-jobs` 的事实链见上）。**按钮的实际点击**只能由使用者在飞书上做——API 读回的卡片正文是实体引用（`请升级至最新版本客户端，以查看内容`），读不到按钮；回调路径本身有 6 例单测。
- **子代理模型**：让子代理显式传 `provider: minimax-cn, model: MiniMax-M3` 去建孙代理，孙代理**自己的会话日志**里 `request/context` 正是 `{"provider":"minimax-cn","model":"MiniMax-M3"}`（不是继承的）；不传时两层都继承父级 `deepseek-flash`。
- **嵌套**：本部署在 profile patch 里把 `subagent.maxDepth` 由默认 1 提到 2（**loader patch 层热应用、不需要重启**，实测同一进程 1h33m 未重启即生效）；`多子代理-父` 一次建出 `孙代理-A` / `孙代理-B` 两个孙代理（从子代理自己的会话日志读到 2 条 catalog 事件），面板在 14:32:55–58 发 4 张卡、message id 各异、无就地更新。
- ✅ **使用者目视确认（2026-09-23）**：表格与树形连线在客户端里显示正常，`🧹 清理已完成` 按钮可用（点击后确实按预期清理）。此前记的那条观测局限仍然成立——**API 只读得到卡片实体引用**（`请升级至最新版本客户端，以查看内容`），所以这类结论只能由使用者在客户端给出。

### 变更：后台任务 / 子代理**面板卡**（O9 + O10，2026-09-23，`src/feishu-panel.ts` / `src/feishu-jobs.ts` / `src/feishu-subagents.ts` / `src/index.ts` / `src/i18n.ts`）

**使用者定形（原话）**：标题不该用命令，要固定为「后台任务」；卡里要**列出全部后台任务**（命令、状态、进度、耗时、退出原因），**子代理同理**；**发卡即可、不需要就地更新**——两者都是后台任务，卡是通知而不是控制面。

**新增 `src/feishu-panel.ts`（两张卡共用的只发不更新快照发送器）**，四条规则：

1. **同一刻合并**：同步突发（一步里起 3 个后台任务）只发**一张**卡，卡在 flush 时**重新渲染**，所以永远是最新名册；
2. **非紧急刷新有下限**（默认 30s）：名册变化（新增行 / 状态翻转 / 结算）是紧急的、立即发；**只有进度文案变了**的刷新排队等下限——否则一个每秒改进度的任务会每秒一张卡。这是**可调**的（`refreshMs`）；
3. **指纹去重**：卡的结构指纹与"上一条**已送达**的"相同就不发；**耗时这类由时钟产生的文本不进指纹**，所以"时间流逝"本身永远不能成为发卡理由；
4. **按 chat 串行**：同一聊天的发送排队，后发的快照不会排到先发的上面。

新名册的**首卡既不延迟也不去重**（关键坑 12：只会看到新触发的防抖会让名册一直不可见）。话题纪律沿用调用方给的坐标（`replyTo` + `reply_in_thread`，关键坑 25/31）；与步骤卡的先后顺序仍由既有的卡片屏障负责，本模块不需要自己的屏障。

**`src/feishu-jobs.ts` 重写：一任务一卡 → 一聊天一张面板卡**

- **标题固定** `🧩 后台任务`（不再拿命令当标题），表列 = 状态 · 任务 · 编号 · 耗时 · 进度/结果；每次触发**发新卡**，**不再就地更新**、也不再发灰色「已失效」卡。
- **判据不变**（关键坑 37）：只列**模型真的拿到 jobId** 的后台任务，前台 `bash`/`pwsh` 调用既不进表也不发卡。
- 终态那一行**留在表里**（`removed` 只清账不动名册），后续卡片仍能看到它刚结束的样子——这正是旧实现丢掉的信息。
- 名册**有界**：一张卡最多 **8 行**（`PANEL_MAX_ROWS`，多余的按"另有 N 条更早的记录未列出"提示），已结算的行 **30 分钟**后（`PANEL_ROW_TTL_MS`）从名册里清掉；聊天里的历史卡不受影响，它们就是记录本身。

**新增 `src/feishu-subagents.ts`：一聊天一张 `🤖 子代理` 面板卡**

侦察结论（原「实施前要侦察」的第 1 条）：**子代理的终态没有会话事件**。`subagent/catalog` 只在**创建**时 append 到父会话，running → inactive 没有任何 `session/event`。可用的是宿主自己的 lifecycle 扇出 `subagent/start` / `subagent/end`（`packages/subagent/subagent/src/lifecycle.ts`），**按委派父级做 scoped dispatch**——本模块用 `{ global: true }` 注册（与 DSH 自己的 invariant 同一写法），因此不受作用域过滤影响。据此：

- **两张事实按子会话 id 关联**：`subagent/catalog`（会话事件）给"谁被创建了 + 模式 + 委派描述 + 创建时间"，`subagent/start` / `subagent/end` 给"这一轮开始 / 结束 + 停止原因"。宿主先 `establishCatalogChild` 再 `observeRun`，所以行一定先存在。**不需要** `listChildren` / `listDescendants`（因此**没有**每事件一次的异步全量读取，也不需要节流），也**不需要**新依赖（`dsh-subagent` / `dsh-scope` 都不是本插件 peer）。
- **归属**：父会话是本插件已知的**子**会话 → 孙代理，同一个聊天、深度 +1；否则父会话能解析出飞书聊天 → 直接子代理；否则（没人绑定的会话）**不渲染**。表里用**缩进**表示嵌套，不占第六列。
- **状态**：`🔄 运行中` / `✅ 已完成` / `❌ 失败` / `⛔ 已中止` / `🚫 已拒绝` / `⚠️ 超出 token 上限` / `⏹️ 已结束`（未知停止原因）。续谈型子代理再次被唤醒时该行**回到运行中**并重新计时。
- **已知不覆盖**：**进程外**子代理（`local: false`，如 claude-code / codex provider）没有本地子会话、不 append catalog，lifecycle 事件又不带聊天归属 → **不列**。当前部署只用 in-process provider，如将来启用进程外 provider 需要再补归属（可读 `subagent/start` 的 scope carrier）。

**验证**：typecheck（host + client）0 error；**555 passed / 38 files**（新增 `tests/feishu-panel.spec.ts` 18 例、`tests/feishu-subagents.spec.ts` 21 例，重写 `tests/feishu-jobs.spec.ts` 30 例：门控、面板合并、指纹去重、刷新下限、上限与提示、跨聊天隔离、失败重试、`removed` 保留行、嵌套归属、终态映射等）；`npm run build` 通过，`client/client.js` **逐字节未变**（只改 host 侧）。

**上线核对（2026-09-23 12:00:57 重启后）**：

- **重启**：`MainPID` 3926849 → **3964870**，启动时刻 11:38:18 → **12:00:57**；`systemd-run` 独立 cgroup（关键坑 14，脚本 `sleep 40` 后重启、不在同一脚本里自检）。启动序列 `apply()` → `startFeishuStreaming` → `[ws] ws client ready` → `dsh web:` banner，`error|failed|already registered` **0 命中**；`lib/index.js` 含 `startFeishuSubagents` / `jobPanelTitle`。
- **实测（探针，12:02:41→12:03:09；采样器跑在独立 systemd 单元里，只读聊天记录）**：先用 `run_in_background` 起 `sleep 25; echo panel-probe-done`（job `bash-N`），并前台调一次 `subagent`（描述 "Panel card probe"）。窗口内与两张面板卡相关的消息**恰好 4 条**：
  - `12:02:45` **`🧩 后台任务`**（任务开始，1 行，状态运行中）；
  - `12:02:45` **`🤖 子代理`**（子代理注册，1 行，运行中）；
  - `12:02:48` **`🤖 子代理`**（同一次运行的终态：**新消息**，不是就地更新）；
  - `12:03:09` **`🧩 后台任务`**（任务 `exit code: 0` 后的**新消息**）。
- **「只发不更新」被证实**：两张 `🧩 后台任务` 的 **message id 不同**（采样器全程没有对它们报过 `CHANGED`），即终态是**新卡**；同一窗口里**没有**任何多余的 job 卡（该轮的前台 `bash` 调用、读日志等都没进表）。
- ✅ **使用者目视确认（2026-09-23）**：表格在客户端里观感正常（列宽、长命令截断、zh/en 排版都没问题）。观测局限不变：卡片**正文**在 API 侧读到的是卡片实体引用（`请升级至最新版本客户端，以查看内容`），**用 API 看不到表格**，这类结论只能由使用者给出。备用改法仍保留——若哪天某客户端渲染不佳，把 `renderTable` 一处换成"一行一个任务"的列表即可（`src/feishu-panel.ts` 单点）。

### 修复：任务卡只镜像真后台任务（关键坑 37）+ 步骤卡思考期占位（O1，2026-09-23）

**问题（使用者报）**：每个工具调用旁边多出一张卡，标题就是那条命令 —— 看起来像某一步的卡片被拆了出来。

**根因**：DSH 里「job」≠「后台任务」。`promoteOnTimeout` 默认开，所以**每个前台 `bash`/`pwsh` 调用**（以及后台 `terminal_send`）都会注册成 job（让命令一开始就可见、可 kill、超时可提升），而 `src/feishu-jobs.ts` 原本的判据是「registry 里有 job 就发卡」→ **每个工具调用多一张卡**（实测同窗口 51 次 bash 调用 ↔ 51 张这种卡）。`JobView` 里没有前台/后台标志，会话事件流里也没有 job 事件；唯一能区分两者的事实是**工具结果文本**（`JobSpec.label` 的官方定义即「the command; the delegation description」，所以卡标题才会是命令 / 委派描述）。

**修复**：

- 判据改为「模型真的拿到了 jobId」：`src/feishu-streaming.ts` 把每条 `tool/result` 转发给任务卡模块，后者用**按工具名固定的整行句式**（`started background job <id>` / `started background subagent job <id>` / `workflow "…" started in the background as job <id>.`，只认第一非空行，工具名限制为 `bash` / `pwsh` / `terminal_send` / `subagent` / `subagent_fork` / `workflow`）提取 id，**只有确认过的任务才建卡**；owner 与会话不一致、或 registry 里查不到该句柄时记日志并跳过（不猜聊天，关键坑 31）。
- 首卡从**已缓存的最近投影**构建（确认通常在 `registered` 之后、`settled` 之前到达），仍然不防抖。
- **不再把终态卡改写成灰色「已失效」**：`settled` 必然先于 `removed`，卡上已经是终态事实，改写只会丢信息（那句文案还指向一张并不存在的「最新卡片」）。现在任务离开可见集合只清账、不动卡。

**同时实现 O1（步骤卡思考期占位）**：`step/start`（模型请求发出前）立即发出「🧠 深度思考中…」卡（带轮/步号），并按 **5s** 刷新已用时；`assistant/message`（reasoning / 文本）、`tool/call`、`tool/result` 全部在**同一张卡**上就地更新 —— 即「占位 → 思考 → 工具调用 → 结果」四阶段一张卡。某步最终没有任何可显示内容时，占位卡在 `step/end` 折叠为「本步无输出」，不会一直停在思考中。

**验证**：typecheck（host + client）0 error；**512 passed / 36 files**（新增 13 例：句式正反例、门控、owner 守卫、`removed` 不再改灰卡、占位卡四个阶段 + 结果转发）；`npm run build` 通过，`client/client.js` 逐字节未变（本次只改 host 侧）。

**上线核对（2026-09-23 11:38:18 重启后）**：

- **重启**：`MainPID` 3110625 → **3926849**，启动时刻 02:33:24 → **11:38:18**；重启单元 `Result=success` / `ExecMainStatus=0`（`systemd-run` 独立 cgroup，关键坑 14）；启动序列 `apply()` → `startFeishuStreaming` → `[ws] ws client ready` → `dsh web:` banner，journal 无 error。
- **修复生效（实测）**：重启后第一个回合（第 82 轮）聊天里只有 **2 条消息、都是步骤卡**（`工具完成 · 第 82 轮 · 第 1 步` / `工具调用 · 第 82 轮 · 第 2 步`），**`✅ <命令>` 这种 job 卡 0 张**、灰色「已失效」卡 0 张 —— 而该轮有多次前台 bash 调用，修复前会一一多出卡片。
- **占位卡生效（journal 证据）**：该轮出现 `[message] card already sent for this step → updating`，即**卡片在模型消息落地之前就已经在屏幕上**（旧路径下首卡只会在 `assistant/message` 或首个 `tool/call` 时发出）。占位标题「🧠 深度思考中…」会在思考结束时被就地更新掉，所以它只在"正在思考"那一刻可见（长思考步骤最明显）——✅ **使用者已目视确认（2026-09-23）**。观测局限不变：它会被就地更新掉，**事后再拉卡片历史只能看到末态**，所以这类「瞬时态」结论只能由使用者给出。
- **真后台任务实测（11:42，探针；观察者放在独立 systemd 单元里，不占用前台）**：`run_in_background` 的 `sleep 18`（job `bash-9`，exit 0）→ ①工具调用**立刻返回** `started background job bash-9`；任务存活期间（11:42:34→53）第 3、4 步照常跑完（11:42:37→45），**前台不被阻塞**；②聊天里**只多出一张卡**：11:42:34 为 `🔄 sleep 18; echo probe2-done`，11:42:53 **同一条消息**就地变成 `✅ …`（用完整 message id 核对过，不是新发一张）；③该窗口共 4 张步骤卡 + 1 张任务卡，**0 张多余卡**（含同批的前台 `systemd-run` / `date` / 读日志这些 bash 调用）。
- **占位卡现场（11:42，同一探针）**：采样器抓到 `🧠 深度思考中… · 第 84 轮 · 第 3 步`（11:42:37）→ `工具调用 · 第 84 轮 · 第 3 步`（11:42:40）→ `工具完成 · 第 84 轮 · 第 3 步`（11:42:43），第 4 步同样（11:42:43 → 11:42:45）——「占位 → 思考 → 工具调用 → 结果」四阶段同一张卡的实测证据。

> 备注：11:40 的第一轮探针把轮询脚本放在了**同一个 step 的前台**，那一步因此被阻塞了 34 秒——那是观察者的代价，不是后台任务的（`run_in_background` 的工具结果本身就是立刻返回的 `started background job <id>`）。该轮只用于验证卡片数量，**"不阻塞"以 11:42 这轮为准。**

### 上线：P6 批次已重启生效（2026-09-23 02:33），逐项核对结果

- **重启**：`MainPID` 3017371 → 3110625，启动时刻 01:50:34 → **02:33:24**；重启单元 `Result=success`（`systemd-run` 独立 cgroup，关键坑 14）。
- **启动序列**：`apply() called, sessionController= available userQuestions= available approval= available` → `startFeishuStreaming` → `[ws] ws client ready` → `dsh web:` banner；**journal error 计数 0**。
- **后台任务注册表**：`ctx.get('jobs')` **拿到了**服务——那条「no background-job registry in this composition」出现 **0** 次，任务卡功能是开的；job 卡失败告警 **0** 次。
- **产物**：`lib/index.js` 与 `client/client.js` 均为本批次重建（分别含 `startFeishuJobs` 与 `plugins.detail.*`）；工具调用正常（关键坑 28 的双实例未复现），飞书入站/出站链路正常。
- ⚠️ **一个观测局限（如实记录）**：`src/feishu-jobs.ts` 只在**失败时**记日志，而它的卡走 `channel.send`（**不打日志**）——`[send] instance card=` 那条日志是 `feishu-streaming.ts` 的**步骤卡专用**。因此 **journal 无法证明任务卡是否送达**，只能证明「没有失败」；任务卡到没到只能在飞书里目视。
- ⚠️ **页面级效果仍留给使用者确认**：插件详情页的徽章 / 「扫码配置」按钮 / 「连接与扫码」区块（含二维码），以及设置页「打开配置文件」按钮回归与那句指路。

### 变更：后台任务卡（`src/feishu-jobs.ts` / `src/index.ts` / `src/i18n.ts`）

- **一个后台任务一张卡**，发在**它所属会话绑定的那个飞书会话**里：`registered` 建卡 → `progress` / `stopping` **就地更新同一张卡** → `settled` 立刻刷新为终态（completed 绿 / failed 红 / killed 灰 / stopping 橙）→ `removed` 用 `renderSupersededCard` 改写为「已失效」。卡上**没有按钮**（带按钮的卡不能连续就地更新，关键坑 11），因此也不提供 kill；**未绑定会话或无主的任务一张卡都不发**——绝不按群猜话题（关键坑 31）。
- **首次发卡永不防抖**：`progress` 变化比合并窗口（300ms）还快的长任务，如果首发也进防抖就会被一次次推迟，直到它安静下来才出现——正好反了。所以只有**就地更新**参与合并，首发立即发；发送失败后的重试也不早于这个窗口（不会变成无界重试）。
- **按 job 串行链**：同一任务的 send/update 串起来，避免「首次 send 还没返回就 update」——那会拿着还不知道的 messageId 去 patch，或者干脆多发一张卡（关键坑 12）。
- **记账有界**：`removed` 直接删；宿主不发 `removed` 时，已结算的记账在下一次**结算**或下一次建卡时按 30 分钟 TTL 清掉。注册表监听器是同步派发的，整个 handler 被 try/catch 包住（监听器抛错会打断注册表派发）；`dispose()` 退订并清掉所有待触发定时器。
- **可选服务**：`ctx.get('jobs')` 判 undefined、不进 `inject`（关键坑 2）——组合里没有该服务时只记一行 info，插件照常启动，只是没有任务卡。
- **测试**：新增 `tests/feishu-jobs.spec.ts` **18 例**（建卡、就地更新不重复发卡、三种终态、未绑定会话一张都不发、重复 `registered` 不重发、`dispose()` 之后不再发、发送抛错不打挂订阅、首发不被防抖吞掉、300ms 合并）。全量 **499 passed / 36 files**、typecheck 0 error。

### 变更：扫码与连接状态移到「插件」详情页，设置页只管配置（`src/client/`）

- **分开摆放**：**配置**（凭据 / 访问策略 / 卡片显示）留在 DSH **Settings → 飞书与 Lark**；**连接状态与扫码授权**搬到 **Plugins → 飞书与 Lark 详情页**，通过三个根作用域槽位贡献——`plugins.detail.badge`（标题旁的状态标签）、`plugins.detail.actions`（头部的「扫码配置 / 重新扫码」）、`plugins.detail.section`（页面内容之下的「连接与扫码」区块，二维码在这里）。设置页保留一句指路。
- **每个贡献点都认 subject**：只对 `kind: 'bundle' | 'row'` 且 `pkg.name` 是本插件的页面渲染，其它插件的详情页返回 `null`——**而且不订阅、不发请求**。三个 entry 都是「guard + body」两段：guard 先判 subject，订阅发生在只命中时才挂载的子组件里；这样既不会在早退之后调 hook（切页会打乱 hook 顺序），也不让别家的详情页触发我们的状态读取。
- **注册 id 用自己的新值**：`plugins.detail.*` 的单元格 id 是 `lark-channel`（不是壳层的任何 id），所以是**在旁边新增单元格**，而不是遮蔽别人的条目（关键坑 35）。
- **是「扫码配置」而不是「重新连接」**：浏览器侧强制重连**不可达**——宿主 `reconcile()` 按**连接指纹**门控（指纹不变直接返回），四个调用点全在宿主侧（扫码完成 / 凭据引用更新 / 配置热更新 / 进程启动）。所以这里给一个**有真实副作用**的动作，而不是一个点了不会重连的按钮；`docs/feishu-setup.md` 写明了这一点与两个可用替代（改一次连接相关配置触发 reconcile，或重走授权）。
- **控制器拆分**：`LarkSettingsCardController` 只留表单 + 凭据（新增 `rereadCredential()`）；连接与扫码抽到新的 `LarkChannelStatusController`——**懒读**（第一个订阅者才发请求）、**最后一个订阅者离开即停轮询**、`dispose()` 兜底、每个请求另有 10s abort 上限（关键坑 29）。共享的 30 行 `SnapshotStore` 是零依赖实现；注释写明了为什么不用平台那份（采用它要 devDep + 打包 `external` + vitest alias 三处协同，就是关键坑 18 那个三件套），以及 `latest` dist-tag 陈旧这个坑。
- **文档同步**：`README.md`（中英双语「两个页面」+ 快速开始第 3 步改为先去 Plugins 详情页扫码、新增第 5 步回 Settings 调策略/显示）与 `docs/feishu-setup.md`（扫码三步改从详情页进入、新增「为什么是扫码而不是重新连接」、注明设置页只管配置）。
- **验证**：build ✅、typecheck **0 error**、全量 **497 passed / 36 files**；`tests/client.spec.ts` 11 → 25（新增覆盖 subject 过滤、徽章/按钮/区块渲染、懒读与「最后一个订阅者离开即停轮询」）。**页面级渲染仍留给使用者在浏览器里目视确认。**

### 变更：会话面板支持置顶 / 取消置顶（`src/feishu-session.ts` / `src/index.ts` / `src/i18n.ts`）

- **宿主能力**：`workspaceRegistry` 上有一份 **registry 全局、按置顶顺序**的 `pinnedSessionIds`，外加两个**幂等**方法 `pinSession(id)` / `unpinSession(id)`（已置顶再 pin、未置顶再 unpin 都是空操作）。这与 WebUI 侧边栏的置顶是同一份数据。
- **面板**：新增「📌 置顶」「📍 取消置顶」两个按钮（与切换 / 断开 / 归档 / 分叉 / 改名同一行）。点完发一条确认文案，并把面板**重绘一次**，让 📌 标记跟上注册表。
- **标记**：`/session` 面板的下拉项与 `/session list` 表格里，已置顶的会话名前面加 `📌`。表格**不加列**、只加前缀，所以 `sessionListTableHeader` 的列数不用动。
- **归档互斥**：给已归档会话置顶时宿主抛 `WorkspaceArchivedSessionPinError`，插件**按 `name` 鸭子类型识别**（宿主抛的类，插件可能持有另一份副本，与关键坑 28 同源）并回「已归档，无法置顶——请先取消归档」，而不是一句泛泛的失败；注册表没暴露方法时只记 warn、不发消息。
- **测试**：`tests/feishu-session.spec.ts` 新增 5 例——置顶与取消置顶各一条并核对确认文案、归档互斥走专门文案、注册表缺能力时只告警、📌 出现在下拉与列表且未置顶项**不带**标记。该文件 14 → 19 例。

### 变更：模型选择改走宿主自己的模型目录（`src/feishu-model-select.ts`）

- **背景**：模型选择器此前自己拼三份数据——`llm.listProviders()`、`llm.listModels(provider)`，再对**单个**模型调 `llm.resolveModelInfo()` 取推理档位。宿主的 `sessionController.modelCatalog()` **一次**就答完这三件事，还带上**可读模型名**（`name`）与每个模型的 `reasoning.efforts`。
- **改法**：新增两个内部助手 `discoverProviders()` 与 `discoverModels(provider)`，内部先读 `sessionController.modelCatalog()`；`modelCatalog` **不存在、或读取抛错**时回落到原来的 llm 目录路径（并留一条 warn 日志）。`resolveModelInfo` 现在只出现在回落路径里。
- **为什么能如实映射**：`LlmProviderInfo` 恰好就是 `{id, name}`，而 `LlmModelInfo` 除 `provider`/`id`/`name` 外全是可选字段 —— 所以目录项可以直接构造成这两个类型，**没有类型强转**。
- **测试**：`tests/feishu-model-select.spec.ts` 新增 4 例——目录路径渲染可读名且**完全不碰 llm**、目录读取失败时回落并告警、宿主没有目录时走 llm、确认时按目录的档位自动降级（给 `low` 而目录只有 `high` → 落 `high`）。本文件 7 → 11 例。

### 修复：不再压掉壳层的「打开配置文件」按钮（`src/client/index.ts`）

- **背景**：插件从上游 dsh-lark 继承了一条 `settings.action` 注册——与壳层 `ui-settings-general` 的 `open-document` **同名同 id**、`priority: -1`，渲染一个什么都不画的分支，旧注释写的是「替换掉壳层那个按钮」。这条注册**没有任何代码、注释或提交信息解释过为什么**要压它（在 fork 点上就已经是这样）。
- **为什么它其实是错的**：`settings.action` 是**根作用域**的 list 槽位，单元格按 `name` + `id` 遮蔽、且 **`priority` 最小者渲染**。所以 `-1` 压掉的不是「我们这一节」，而是**设置页里每一个 section** 的同一个按钮——包括壳层自己的「常规」页。
- **那个按钮该不该在**：该在。宿主 `settings-controller` 对 `hasDocument` **无条件返回 `true`**，`openSettingsDocument()` 会先 `prepareDocument()`（文件不存在就创建）再交给系统原生打开器；而且 0.1.7 之前我们的配置**正是**写在那份文档里（`settings.yaml` 的 `lark-channel` 段）。
- **改法**：删掉这条注册，并把结论写进代码注释（说明为什么删、以及"别按『压掉壳层』的思路加回来"）。
- **验证**：`client/client.js` 里 `open-document` 出现次数 **0**；typecheck 0 error、458 tests 全绿。页面上重新出现「打开配置文件」按钮这一**视觉效果**留给使用者在浏览器里目视确认。

### 变更：插件在「插件」页有了本地化名称与图标（`package.json` / `locale/` / `icon.svg`）

- **本地化显示名**：新增 `locale/en.json` 与 `locale/zh.json`（各含 `meta.title` / `meta.description`），并在 `exports` 里放行 `./locale/*.json`。DSH 的插件清单按「**语言 id 作文件名**、且必须与 `en.json` 同目录」的规则读取这些文件，`title` 缺失时回落成包名——所以此前插件页显示的是 `@starxer/chatterbox4dsh` 这个技术名。
- **图标**：新增 `icon.svg`（64×64 圆角蓝底 + 白色对话气泡），在 `package.json` 顶层声明 `icon` 为**相对路径**。清单读取器接受 SVG/PNG/JPEG/WebP、≤256 KiB、且必须落在 manifest 目录内；越界路径、非法扩展名或超限会让整个 `meta` **只剩一条 `error`**（标题描述也一起没有），所以这三条约束是硬要求。
- **`files` 白名单**同步加入 `icon.svg` 与 `locale/*.json`——否则 npm 包里不会有这两个资源，安装后图标与本地化名都会消失。
- **验证**：直接调用宿主自己的 `readPluginMeta('<包名>', '<profile>/package.json')`（由 `@deepseek-ai/dsh-app-boot` 导出，**就是插件清单用的那个函数**），返回中英两套标题与描述 + `data:image/svg+xml;base64,…`，且**没有 `error` 字段**。

### 变更：设置页改用 DSH 原生配置表单与凭据服务，删除自建 HTTP 写路径（`src/client/` / `src/web.ts` / `src/index.ts`）

- **背景**：插件此前自带一整套设置页后端——客户端把改动 `POST /dsh-feishu/settings`，宿主侧 `src/settings-api.ts`（140 行）负责**字段白名单、密钥脱敏、`expectedRevision` 版本栅栏**。DSH `0.1.7` 已提供等价且更完整的能力，这层自建基础设施可以整块删掉。
- **字段读写改走 `ctx.configForms`**（`ui-settings` 的客户端服务）：`configForms.get('lark-channel')` 取得该 profile 行的表单控制器，`mutate(ops, revision)` **一次提交全部改动**；**版本栅栏、宿主校验、持久化、被拒后重载由 DSH 自己完成**。`whileServed(['lark-channel'])` 保证宿主没组合这一行时页面上不出现任何痕迹。
- **密钥值不走配置字段，走凭据域**：`ctx.remote.credentials.describe([ref])` 读状态、`.set(ref, value)` 写、`.unset(ref)` 删除（引用默认 `DSH_LARK_APP_SECRET`），并用 `credentials/reference-updated` 事件在别处改了同一引用时刷新徽章。「留空 = 保留」由**只在用户真的输入了内容时才写**保证；清除只能走独立的删除按钮。
- **页面位置不变**：仍是 Settings → 飞书与 Lark 标签页（`settings.section`，id / order / label 与之前一致），因此 README 与 `docs/feishu-setup.md` 的指路无需改动。这些字段都是 `.volatile()`，保存**不需要重启 Harness**。
- **宿主只留一个自建路由**：`/dsh-feishu/provision` —— 扫码配置与飞书连接状态，这两件事没有原生对应物；GET/POST 统一返回 `{ runtime, provision }`。
- **删除**：`src/settings-api.ts`、`tests/settings-api.spec.ts`、旧的 `src/client/LarkSettingsSection.tsx`（fetch 版）、`SETTINGS_PATH` 与 `handleSettingsRequest`。
- **附带清理**：`dsh.client.inject` 补上 `@deepseek-ai/dsh-client-ui-plugin-manager` 与 `@deepseek-ai/dsh-api-remotes`（与官方 `ui-settings-web-search` 的清单逐项一致，纯解析顺序提示，不新增 npm 依赖）；测试里一个私网 IP 字面量换成 RFC 5737 文档地址。
- **验证**：typecheck 0 error、build ✅（`client/client.js` 重建）。测试数 472 → 458：删掉的 11 例属于已删除路由的专属用例，客户端用例改写为新的服务面（保存时 ops 与 revision 正确、留空不写 secret、删除 secret、四个显示开关的联动、凭据徽章、扫码与运行状态）。
- **注意**：宿主与客户端的载荷形状一起变了（`{ runtime, provision }`），**两侧需同时重启**；只刷新页面会看到运行状态停在 `connecting`。
- **实测（2026-09-23 00:13 重启后）**：服务 `active`、插件 `apply()` 正常、`[ws] ws client ready`、journal **无 error**；产物核对确认线上就是新代码——客户端含 `whileServed` / `lark-channel` / `settings.section` 且 `dsh-feishu/settings` **0 处**，宿主只剩 `dsh-feishu/provision`。**页面级行为**（保存、留空保留 Secret、删除 Secret、运行状态徽章）留给使用者在浏览器里目视确认。
- **已知限制**：凭据徽章只反映**凭据域**（按 `appSecretRef` 引用查）。若某个部署仍在用已废弃的**字面量 `appSecret`**（明文写在配置里，原生表单快照会把它脱敏掉），徽章会显示「未配置」而通道其实可用——本机走 `appSecretRef`，不受影响。

### 新增：归档运行中的会话先问「停止并归档」（`src/feishu-session.ts` / `src/i18n.ts`）

- **背景**：DSH `0.1.7` 起 `archiveSession(id)` 会**拒绝仍有活动的会话**（`WorkspaceActiveSessionError`，列出 turn / subagent / job / schedule）。此前的处理是让这个错误落到通用的「操作失败」卡上——安全（不会静默杀掉正在跑的 turn），但用户只看到一句英文报错，也没有"要不要停"的选择。
- **改法**：对齐 Web UI 的「先问再停」。第一次归档**不带** `stopActivity`，因此任何情况下都不会静默停止正在跑的工作；若 DSH 回以活动错误，就发**第二张确认卡**，写明仍在运行的活动类型（turn / 子代理 / 后台任务 / 定时任务），确认按钮变成「停止并归档」；**只有这张卡的确认**才调用 `archiveSession(id, { stopActivity: true })`。其它错误仍走原来的失败卡。
- **错误识别用鸭子类型**（`name === 'WorkspaceActiveSessionError'` + 读 `activity[].kind`），不用 `instanceof`——错误由宿主抛出，而插件可能持有同一类的另一份副本（与关键坑 28 同源的风险）。
- **验证**：新增 6 例（卡片文案与按钮、鸭子类型识别、二次确认后才停、非活动错误仍出失败卡）。472 passed / 36 files，typecheck 0 error，build ✅。

### 变更：会话列表改读宿主投影，不再重放实时会话日志（`src/harness.ts` / `src/index.ts`）

- `Session.snapshotEvents()` / `eventAt()` / `ownEvents()` 已被 DSH 弃用（2026-09-09 决策：「既有逻辑可以暂不迁移，但**禁止新增调用**」）。`/session` 列表过去对**活动中的**会话读实时事件快照，用来取标题、预设和「是否空白」。
- 现在改为读宿主自己维护的**投影**：`title`、`agentPreset`、`sessionListMetadata`（空白位 + 最近一次提示时间），活跃度用与 Web UI 相同的口径 `max(header.createdAt, lastPromptAt)`——于是聊天列表与 Web UI 列表由**同一个来源**得出，不再各扫各的日志。投影服务用 `ctx.get` 读取（**不进 `inject`**，宿主没有该服务也能启动，关键坑 2）；服务缺失时保留原有的日志回放路径。
- 剩下的一处弃用调用（`summarizeTurn`）**有意保留**，并在注释里写明原因：它需要**单轮**的原始事件（逐步计时、assistant 流、tool/result 配对、事件时间）才能还原 Web UI 的轮次指标，而现有投影不提供逐步计时；它也没有新增任何事件依赖。

### 清理：客户端清单里解析不到的包 + 影子注册补注释（`package.json` / `src/client/index.ts`）

- `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-runtime` 在 `0.1.6` / `0.1.7` 都解析不到（该字段只是解析提示，不报错）→ 移除；单测同步改为断言「不含它」。
- `settings.action` 的影子注册（`id: 'open-document'` + `priority: -1`）补注释：说明它与壳层 `ui-settings-general` 的注册**同 id、因而替换掉**那个「打开文档」动作，以及 id 必须保持一致、否则该动作会重新出现。意图未再核实，注释如实标注。

### 修复：恢复会话时按**会话记录的 preset** 挂载，不再静默套用插件配置默认（`src/harness.ts`）

- **现象**：进程重启后第一次收到消息（或 `/session` 切换到一个未激活的会话）时，会话**实际运行在 `agentPresets.defaultId`（`standard`）下**，与它记录的 preset 不一致。DSH `0.1.7-alpha.1` 上表现为：会话 header、`/status`、footer 都写 `cordis`，但工具集里没有 `cordis_inspect` / `plugin_manager`，随附技能目录也是空的（`standard` 的预期行为）。**这不是 0.1.7 的回归**——同一现象在 `0.1.6-alpha.2` 上已复现过。
- **根因**：插件的冷会话重建路径（`createAgent`）在**恢复**分支里也用 `creation?.agentPreset ?? config.agentPreset` 解析 preset；本部署的 profile 行没有配 `agentPreset` → `agentPresets.resolve(undefined)` 回落到默认 preset，随后把这个 preset 的 `setup` 交给 `agents.resume(...)`，**覆盖掉会话自己记录的组合**。宿主自己的恢复路径（`session-controller` → `presetForObservation`）读的是 `agentPreset` Session 投影（`header.agentPreset`，被较晚的 `agent-preset/selected` 覆盖），插件绕过了它。
- **改法**：恢复分支先读会话记录——`header.agentPreset`，被日志里最后一条 `agent-preset/selected` 覆盖（与 `getSessionMeta`、`/session list` 已在使用的规则一致）——再挂载它；**新建会话仍用配置 / `/new` 指定的 preset**。记录里的 preset 在当前安装中无法解析时（例如只以扫描目录形式存在过的 preset）不阻塞恢复：回落到配置默认并打一条 `console.warn`。
- **验证**：新增 5 例（新建会话仍用配置 preset；恢复按 header 挂载；`agent-preset/selected` 覆盖 header；未知 preset 回落并告警；只读日志头部恢复 preset）。464 passed / 36 files，typecheck 0 error，build ✅（`client/client.js` 未变）。

### 兼容：对齐 DSH `0.1.7-alpha.1`——设置服务换代为 `SettingsForms`、preset 包改名、扁平的 `tool/result`、归档语义（`src/config.ts` / `src/index.ts` / `src/feishu-streaming.ts` / `src/feishu-toolcalls.ts` / `src/feishu-session.ts` / `package.json`）

- **依赖范围**：`@deepseek-ai/dsh-*` 整体 `^0.1.6-alpha.1` → `^0.1.7-alpha.1`（预发布 comparator 只在同一 `major.minor.patch` 内生效，旧范围永远不会满足新版本）；`@deepseek-ai/schemastery` `^3.18.1` → `^3.18.3`（新增 `.volatile()`）；`@deepseek-ai/cordis` `^4.0.1` → `^4.0.3`。
- **设置：`settings.register()` / `settingsScope.get()` / `scope.watch()` 在 0.1.7 全部被删除**（服务更名为 `SettingsForms`，只剩 `configure / describe / update / replace / mutate / prepareDocument / documentPath`）。改法：
  1. 配置**直接从 `apply(ctx, config)` 收到的 live Config 读**——每个可编辑字段现在是 `.volatile()` 引用，`Volatile.get()` 才是当前生效值。`resolveSettingsConfig()` 因此接受 `ConfigInput`（`LiveConfig | Config`），新增 `readField()` 同时兼容引用与普通值（单测、以及任何直接传已解析值的宿主仍可用）。
  2. `ConfigSchema` 的**每个字段都声明 `.volatile()`**：0.1.7 拒绝写非 volatile 字段（`has no volatile fields` / `Config field "…" is not volatile`），而 volatile 字段正是原来 `{ applies: 'live' }` 的语义——写入进运行中的引用、**不重挂插件**。
  3. 命名空间 **`ns` 现在是 profile 行 id**（`describe()` 按 `entry.options.id` 索引），改为从自身 fiber 反查（`ctx.fiber.entry.options.id`），不再依赖「插件恰好叫 `lark-channel`」。
  4. `scope.watch(cb)` → `ctx.on('loader/volatile-update', cb)`（0.1.7 把值提交进引用之后，向**该配置所属 fiber** 发这个本地事件）。`/display`、`/lang`、设置页写的仍是 `settings.mutate(ns, ops, revision)`，签名未变。
  5. 插件自带设置页，按官方约定用 `settings.configure({ auto: false }, ctx.fiber)` 关掉「自动生成页面」（不改变配置读写能力）。
  6. `locale: 'auto'`（跟随 DSH 界面语言）此前用 `settings.get('locale')` 读取，该 API 已删除；改为从 `describe()` 的表单投影里取，并**加了一秒 TTL + 「写入即失效」的缓存**——`currentLocale()` 在每次卡片重绘时都会走，而 `describe()` 会重建每个条目的表单并读 profile 目录，不能放在热路径上。
- **preset 包改名**：`@deepseek-ai/dsh-agent-presets` 整包删除 → `@deepseek-ai/dsh-agent-preset-registry`。服务名与 `list / resolve / mount / defaultId` **全都不变**，插件逻辑零改动，只换了类型引入的包名与依赖项。
- **`tool/result` 消息被拍平**：旧形态是 user 角色、真正的 `{ content, isError }` 嵌在 `content[0]`（一个 `tool-result` 块）里；0.1.7 直接把 `{ role: 'tool', toolCallId, content, isError }` 放在 message 上。插件原来读嵌套块，**失败会被渲染成成功**（内容靠兜底侥幸显示）。改为读 message 自身的 `content` / `isError`，并新增回归测试锁死「失败必须渲染成 ❌ 失败」。
- **`archiveSession()` 拒绝运行中的会话**：0.1.7 新增 `options.stopActivity`，不传且会话仍有活动时抛 `WorkspaceActiveSessionError`（列明是 turn / subagent / job / schedule）。插件**刻意不传 `stopActivity`**——Web UI 在停掉一个 turn 之前会先征求确认，而这里的失败已由既有 `try/catch` 渲染成一张报错卡，不会静默杀掉正在跑的 turn。飞书侧更友好的「是否停止并归档」确认卡留作后续。
- **未改但要留意的语义**：`snapshotEvents / eventAt / ownEvents` 已被标 `@deprecated`（仍可用，后续迁 `sessionProjections`）；`sessionController.prompt()` 的 content 契约换成 base64 / `{ type: 'file', receiptId }`——插件里那条 `return false` 回落到 `agent.steer/followup` 的绕行**必须保留**。
- **验证**：`npm run typecheck` 0 error，`npm test` **459 passed / 36 files**（新增 3 例：扁平 `tool/result` 的失败态、live Config 引用读取、数组字段拷贝），`npm run build` ✅（`lib/index.js` 与受跟踪的 `client/client.js` 一起更新；本次客户端代码零改动）。
- **其余升级前置项属于部署数据**（legacy `settings.yaml` 的段导入、默认 preset 回落、目录型 preset 在 0.1.7 不再被发现），不在插件代码范围内。

### 修复：群里新建话题建 DSH 会话时，创建流程的卡片被发到另一个话题（`src/card-topics.ts`（新）/ `src/index.ts` / `src/feishu-onboarding.ts` / `src/feishu-model-select.ts` / `tests/card-topics.spec.ts`（新））

- **问题**（2026-09-21 使用者报告「在群里创建话题创建 dsh 会话，创建过程的卡片被发错话题」）：在已开启话题的群里新开一个话题、并在其中走 `/new` 创建会话时，**流程前半段的卡片落在新话题里，后半段（模型选择卡、最终确认卡）却落到另一个旧话题里**。
- **根因**：**话题坐标被按「群」保存和查询**。飞书卡片回调只带 `chatId` + `messageId`，而一个群只有一个 `chatId`、却可以有任意多个话题，于是所有 `chatId` 维度的话题表（`feishu-onboarding` 的 `chatTopic`、bridge 的 `topicFor`）都只能记住**这个群最后用过的那一个话题**。事故链（journal 可复现）：
  1. 某群新话题里的第一条消息被记录，`topicFor` 指向**新**话题；流程的引导卡、工作区选择卡、目录浏览卡、预设卡都正确进入新话题；
  2. 约 8 分钟后，**同一群的旧话题**来了一条无关消息（在另一个会话里继续对话），`noteTopic` 把旧话题移到「最近使用」队尾；
  3. `index.ts` 的 `onModelStep` / `onNewSessionConfirm` 明明拿到的是**带正确话题坐标**的卡片回调（`feishu-onboarding` 已经补齐了 `threadId`/`rootId`），却丢弃它、改用 `chatTopicFor(chatId)` 按**群**重查 → 命中刚刚变成「最近使用」的旧话题 → 模型卡与确认卡被发进旧话题。
  同源的隐患：`feishu-model-select` 的 `topicFor` 也只看 `chatId`。
- **改法**（新增 `src/card-topics.ts`）：
  1. **按被点击的卡片精确回查**：新增 `messageId → 话题` 注册表（`createCardTopicRegistry`，有界 500 条、LRU 淘汰）。**每发出一张卡就登记它落在哪个话题**（`feishu-onboarding.sendCard`、`index.ts` 的模型卡/确认卡、`sendModelCardV2` 的 `/model` 卡），点击回调再按 `messageId` 取回——`messageId` 唯一定位「操作者点的到底是哪张卡」，与群里有多少话题无关。
  2. **统一解析顺序**（`resolveCardTopic`）：① 回调消息自带的坐标（话题里的入站消息、已被上游补齐的回调）→ ② 该卡片自己的话题（注册表）→ ③ 才轮到按群猜（bridge 的「最近使用」→ onboarding 的副本，重启后靠 bridge 的持久化兜底）。前两级命中时**不再调用**第③级，避免它再次劫持。
  3. `feishu-model-select` 的 `topicFor` 改为接收 `{ chatId, messageId }`（把回调里的 message id 透出来），`feishu-onboarding.withTopicContext` 同样先按卡片自身的 message id 回查、再退回按群记的旧表。
  4. 半已知坐标（只有 `threadId` 没有 `rootId`）**一律不登记、不采信**——那正是「`reply_in_thread` 但没有 `replyTo`」的静默顶层兜底，在话题群里等于**又开一个新话题**。
- **验证**：新增 `tests/card-topics.spec.ts` 11 例（注册表往返/半已知坐标被拒/超上限淘汰/`clear`；`resolveCardTopic` 的三级优先级，并**直接锁死本次事故**：卡片已知时必须忽略「群最近使用」那个猜测，且该猜测**不得被查询**；**私聊/未开话题的群聊解析为「无话题」**）；`tests/onboarding.spec.ts` 新增 4 例（**同群另一个话题来消息后，点击新话题里的卡片仍把下一张卡发回新话题**；注册表没有记录的旧卡仍按群兜底；**私聊流程每张卡都是普通顶层消息（`{}`）、且不会往 `chatMessage` 上塞话题**；**未开话题的群聊同理**）；`tests/feishu-model-select.spec.ts` 新增 3 例（`topicFor` 必须收到被点击卡片的 messageId、恢复的话题要落到转发出去的 `chatMessage` 上、`sendModelCardV2` 必须登记所发卡片的话题）。全套 **456 passed / 36 files**（原 438 / 35），typecheck 0 error，build ✅。
- **兼容性（DM / 未开话题的群聊）**：私聊与未开话题的群聊里，消息**没有** `threadId`/`rootId`，注册表也**不登记**无话题的发送，因此 `resolveCardTopic` 三级全部落空 → 返回 `{}` → 卡片照旧以**普通顶层消息**发送，`chatMessage` 上也不会被塞进话题（会话仍绑定 `chat:<chatId>`）。即：**开启话题的群聊被修好，其余场景逐字未变**（新增的 4 例专门锁这条）。
- **注意**：修复需要**重启 dsh** 才对运行中的进程生效。
- **已知残余**：注册表是**进程内**的。插件重载后点击「重载前发出的旧卡」时会退回按群猜测（第③级）；此时若同群另一个话题恰好刚有流量，仍可能发错话题。要彻底消除需要按 message id 调飞书 API 反查 `thread_id`（`topic-roots.ts` 已有同类调用），未做——重载中途还在点旧卡属于窄缝，代价（每次点击多一次 API 调用）不值当。

### 修复：卡片排序屏障曾被一次挂起**静默**废掉——问卡重新抢在步骤卡之前（`src/card-send-barrier.ts`（新）/ `src/index.ts` / `tests/card-send-barrier.spec.ts`（新））

- **问题**（2026-09-21 使用者报告「问题卡片在生成步骤卡片之前出现，应该是先生成步骤卡片，然后才生成提出的问题」，并指出这是**老问题重现**）：飞书侧实测问卡与步骤卡分别为 `…36.161` / `…36.326`，问卡早 165ms。同一现象 2026-09-09 已修过。
- **根因（两处设计缺陷叠加，与下一条同源）**：「步骤卡必须先于它自己那一步发起的问答/审批卡」由 `index.ts` 的 `cardChannel.send` 保证——发任何卡之前先 `await pendingCardFlush(chatId)`，让 streaming 把还在防抖窗口里的步骤卡立刻发出并等它的消息落地。而：
  1. **再入哨兵是全局计数器 `cardSendDepth`**（与 chatId 无关）；
  2. **屏障内部的等待没有上界**（最后 `await lastCardSendByChat.get(chatId)`）。

  事故链：某群话题一次 `message.create` 挂起 ⇒ 46 秒后同一话题又一张卡走 `send` 兜底路径 ⇒ 进入屏障并**永久**等待那个永不 settle 的 promise ⇒ `finally` 永不执行 ⇒ **`cardSendDepth` 永久停在 1** ⇒ 此后**所有聊天**的 `cardChannel.send` 都静默跳过 flush、排序保证消失、**日志里一个字都没有**；近 3 小时后私聊里的一次 `ask_user_question` 就复现了 09-09 的倒序。
- **改法**（新模块 `src/card-send-barrier.ts`）：
  1. **哨兵按 chat 记账**（`Set<chatId>`）：一个聊天卡住不再影响其他聊天；同聊天的再入仍被挡住——步骤卡自己走 `send` 兜底时必须不能等那个正在生产它的 flush。
  2. **屏障等待有界**（`CARD_BARRIER_TIMEOUT_MS = 60s`）：即使 flush 永不 settle，`finally` 也一定执行、哨兵一定释放；超时只是**放弃排序**并打一行 `pending card flush gave up: …`，卡片照发。
  3. `cardChannel.send` 的外层上界相应为「屏障 60s + 出站 20s」（原来最坏是无限等待）。
- **验证**：新增 `tests/card-send-barrier.spec.ts` 6 例，其中两例**直接锁死这次的失效模式**——「某聊天 flush 永不 settle 时，**另一个聊天**的 flush 仍必须执行」（旧全局计数器下第二个 flush 会被跳过）、「一次卡住的 flush 之后哨兵必须释放，下一次 flush 仍会执行」（旧实现下永久为 1）；另 4 例覆盖顺序保证、同聊天再入不重复 flush、超时后照发并回报原因、未注册 flush 时直接发送。全套 **438 passed / 35 files**（原 432 / 34），typecheck 0 error，build ✅。
- **注意**：与下一条一样，修复需要**重启 dsh** 才对运行中的进程生效。
- **真机复验（2026-09-21 14:10 重启后）**：同一步骤先 `assistant/message`（步骤卡进入防抖窗口）再 `ask_user_question`，日志为 `[q] sending card` → `[send] instance card=…` → `[send] message=… via card=…` → `[q] card sent`，即**屏障先 flush 步骤卡并等其消息落地，才发问卡**；飞书侧实测步骤卡 `…47.559` 早于问卡 `…48.569`。作为对照，修复前同一场景为问卡 `…36.161` 早于步骤卡 `…36.326`。

### 修复：一次永不返回的出站请求会永久冻结整个聊天的卡片投递——出站调用加超时、卡片链加兜底、正文加兜底，并给 SDK 日志脱敏（`src/outbound-timeout.ts`（新）/ `src/log-redact.ts`（新）/ `src/feishu-streaming.ts` / `src/index.ts` / `src/channel.ts` / `src/harness.ts`）

- **问题**（2026-09-21 使用者报告「从飞书发消息，Agent 完成了回答，WebUI 上能看见，但飞书上就看不见回答」）：某个**群话题**在某一刻之后对 Agent 卡片彻底静默——步骤卡、回答正文、Turn Complete 页脚全都不再出现，但同一进程里的私聊一切正常，斜杠命令卡与纯文本通知也照常到达。
- **根因（三段，缺一不成灾）**：
  1. **SDK 的 HTTP 客户端没有请求超时**（`timeout: 0`）。网络抖动（日志里成对的 `ECONNRESET`）之后，一次 `im.v1.message.create` 请求发出去**再也没返回**，promise 永久 pending。
  2. **步骤卡按聊天串行，且这个串行等待没有上界**：每张卡都排在「上一张卡的消息」之后（`previousSend.catch(...).then(...)`）。第一张卡的消息永不 settle，**之后每张卡都只创建了 CardKit 实例、消息永远发不出去**——日志特征就是 `[send] instance card=…` 后面**不再**跟 `[send] message=… via card=…`。取证：该话题最后一条成功投递是某时刻，之后 8 个孤立卡实例；全量日志按 card id 做集合差，历史上共有 **80 个**孤立实例，分两批（另一次更早的爆发 72 个，被重启清掉）。
  3. **回答正文只以「更新步骤卡」的方式上屏，而兜底被自己关掉了**：`noteStepCardText()` 是**乐观**标记——卡片交给飞书就置位「正文已上屏」，而 `channel.ts` 只有两条分支（发页脚 / 发整卡），于是「没上屏就补发整卡」这条路被跳过；同时 `flushed()` 又 `await` 同一个永不 settle 的 promise，**连页脚也发不出去**。三者叠加 = 该聊天彻底静默。
- **改法**：
  1. **出站调用一律有界**（`src/outbound-timeout.ts`：`withTimeout` / `settleWithin`，20s）。落在 `cardChannel` 的全部方法（`send` / `createCardInstance` / `sendCardByReference` / `updateCardInstance` / `updateCard`）与 `channel.ts` 的所有出站发送上。超时**不是取消**——请求可能仍在服务端成功，所以只把「结果未知」当失败处理，**绝不重试发送**。
  2. **卡片链等待有上界**：串行等待改成 `settleWithin(previousSend, …, 45s)`，等不到就照发——**代价是卡片顺序，不是整个回答**。
  3. **正文兜底真的兜得住**：新增 `clearIntermediateSent()`；`feishu-streaming` 按轮记录「确实有带正文的卡片被飞书**确认**投递」（`turnTextDelivered`，`turn/start` 复位），`flushed()` 发现没有就把乐观标记**撤回**；`channel.ts` 相应把 `consumeIntermediateSent()` **移到 `await flushed()` 之后**，于是这种情况会走「发整卡」分支把回答送出去。标记按轮隔离，不会把上一轮的投递结论带到下一轮。
  4. **`flushed()` 自身也有界**（120s）——等待超时必须退化成「照发页脚」，而不是「什么都不发」。
  5. **顺带的安全修复（独立问题）**：SDK 默认 logger 是 `console.log('[error]:', …)`，会把整个 axios error 打出来，而它的 `config.data` 就是取 token 的请求体——**`app_secret` 明文进了 journal**。现在改为自建 logger（`src/log-redact.ts`）：Error 只留 message + stack（不含请求体），其余值 JSON 化并**按已知密钥值逐个打码**，Bearer token 也一并打码。
- **验证**：新增 `tests/outbound-safety.spec.ts` 11 例（`withTimeout` 透传/传播拒绝/到点拒绝并点名、`settleWithin` 超时回报并返回 undefined、密钥与 Bearer 打码、axios 形态错误不泄漏 `config.data`）；`tests/feishu-streaming.spec.ts` 新增 4 例（发送未确认投递 → `flushed()` 撤回标记；确认投递 → 保留标记；**投递结论不跨轮泄漏**；假计时器下**前一张卡永不 settle 时后一张卡仍会发出**）；`tests/plugin.spec.ts` 新增 2 例（**撤回标记后必须发整卡正文**、确认后只发页脚——直接锁住「先 `flushed()` 再读标记」的顺序）。全套 **432 passed / 34 files**（原 415 / 33），typecheck 0 error，build ✅。
- **注意**：这是**进程内状态**的修复；出问题的那一刻起已经被冻结的聊天，需要**重启 dsh** 才会解锁（重启前的挂起 promise 无法回收）。

### 修复：超阈值分卡把表格/代码块切成两半——切分改为块感知（`src/text-chunk.ts` / `src/feishu-streaming.ts`）

- **问题**（2026-09-18 使用者报告「卡片消息超出设定的字数阈值后，分卡发消息会破坏 Markdown 格式（比如表格等）」）：长回复被拆到多张卡时，**跨行结构**被从中间切开，两端各渲染半张表。两处硬切：① `feishu-streaming.ts` 的 `fullText.slice(TEXT_STEP_CAP)` 是纯字符切片，切点落进表格/代码块内部就切坏；② `text-chunk.ts` 在「单个段落超预算」时 `para.split('\n')` 逐行硬切——而 Markdown 表格行间只有单个 `\n`、没有空行，所以**整张表算一个段落**，必走这条分支。同一问题也影响 `channel.ts` 的 reply 卡。
- **改法**（按使用者提出的「从空行切、提前点切」）：
  1. **切分器重写为块感知**（`src/text-chunk.ts`）：先切块——空行分隔，且**代码围栏内部的空行不算分隔**、整块保留；再装箱，当下一块放不进剩余预算时**回退到上一个块边界**结束当前卡，绝不切进块内部。
  2. **超预算单块**按类型给最小破坏的切法：代码围栏在每片**闭合再重开**（每片都是合法代码块），表格在每片**重复表头与分隔行**（每片都是合法表格），其余退回行边界、单行超长才按字符切。
  3. **步骤卡与续卡共用同一次切分**（`src/feishu-streaming.ts`）：步骤卡渲染 `segments[0]`，其余成为 `Reply (continued N/M)` 续卡——两者不再各自切片，因此不可能对不上；`MAX_OVERFLOW_CARDS = 30` 沿用原有续卡上限。
- **顺带核实并保留（勿清理）**：`TOOL_SUMMARY_VARIANTS` / `TOOL_SUMMARY_TITLED` 里的 `cordis_package_inspect` / `cordis_runtime_inspect` / `cordis_run` / `cordis_stop` / `cordis_undefine` 看着像「alpha.2 已删除的工具」，但它们**必须留着**——这张表镜像的是 Web UI 的 `TOOL_VARIANTS`，而该文件在 alpha.1/alpha.2 之间**逐字节未变**、仍映射这些旧名，为的是让**旧会话记录下来的工具调用**继续以相同摘要重渲染。升级时曾按「已删除」把这几行换成 `cordis_inspect_list`/`cordis_inspect_query`，核对 Web UI 后**已回退**；`plugin_manager`（alpha.2 新增、Web UI 变体表未收录）走通用 `plugin_manager · <action>` 行，与 Web UI 一致。
- **验证**：`tests/truncation.spec.ts` 新增 7 例（提前切到上一个空行 / 表格整体进下一张卡 / 超预算表格重复表头 / 代码围栏闭合重开 / 围栏内空行不作边界 / 单行超长仍按字符切 / 混合文档逐块保真），`tests/feishu-streaming.spec.ts` 新增 2 例并改写 1 例（2990 字填充 + 表格 → 步骤卡只含填充、表格整体进续卡；短文本表格完整渲染；titled 工具改用 `cordis_inspect_query`）。全套 **415 passed / 33 files**（原 405 / 33），typecheck 0 error，build ✅。

### 修复：工具先开卡、正文后到时误判「没显示过正文」，会多发一张重复回复卡（`src/feishu-streaming.ts` / `tests/feishu-streaming.spec.ts`）

- **问题**（2026-09-17 排查「产物信息出现在步骤卡而不是 complete 卡」时顺带发现、同日修复）：某一步先被 `tool/call` **开卡**、该步正文稍后才到时，`channel.ts` 会误判「飞书这边还没显示过正文」，于是**再发一张蓝色 `Reply` 卡**（同一段正文出现两遍），并且**不发 Turn Complete 卡**——连同 📦 交付文件 清单与本轮耗时/token 指标一起丢掉。
- **根因**：`bridge.markIntermediateSent()` 只在 **`actuallySendStepCard()`** 里判定，判据是「卡片发出那一刻 `state.text` 是否为空」。而卡片常常由 `tool/call` 在正文到达前就发出（工具要跑几秒，卡先以 `⏳ running…` 上屏），正文随后只经 **`updateStepCard()`** 到达屏幕——更新路径从不补这个标记，于是 `bridge.consumeIntermediateSent()` 返回 false，channel.ts 走了「没有中间卡」的分支。
- **改法**：把判定抽成 `noteStepCardText(sessionId, state)`（正文非空 → `markIntermediateSent`），**发送路径与更新路径都调用**。`updateStepCard` 因此需要 sessionId，把它放进了 `SessionStepState`（该状态本就是 per-session）。
- **影响面**：只关掉这个误判；同时**缩小**（不消除）`channel.ts` 那条「整块丢交付清单 + 指标」的 else 分支的触发面。交付物面本身仍窄（produced 整半未实现、complete 卡只对飞书触发的轮次发送）——见 `TODO.md`。
- **验证**：`tests/feishu-streaming.spec.ts` 新增 3 例：① 工具开卡（无正文）→ 正文经 `request/context` 的更新上屏 → 断言**卡片里确有正文**且已标记；② 正文随卡一起发出 → 仍标记（回归保护）；③ 无正文的更新 → **不**标记（保持判据狭窄）。全套 **405 passed / 33 files**（原 402 / 33），typecheck 0 error。

### 修复：飞书把 turn 失败压成一句通用错误——改为按 WebUI 的方式渲染同一份失败事实（`src/turn-failure.ts`（新）/ `src/conversation.ts` / `src/harness.ts` / `src/channel.ts` / `src/i18n.ts`）

- **问题**（2026-09-17 使用者报告「飞书端报错没有 1:1 对应 WebUI，有时能正确显示，有时只剩一个默认的句子」）：同一个失败，WebUI 显示的是**具体原因 + 错误码**，飞书这边却只回一句 `处理这条消息时出错：Harness turn did not produce a successful assistant response`。日志取证：这句话在 journald 里**出现过 20+ 次**（09-08 至 09-17），最近的几次正对应会话里的 413（`DeepSeek Messages request failed (413)` / `INVALID_REQUEST`）。
- **根因**：`harness.reply()` 只拿 `summarizeTurn()` 的结果做非空判断，而 `summarizeTurn()` 读到 `turn/end` 的 `reason` 时**只记 `kind`、把 `reason.error` 整段丢掉**，随后 `reply()` 抛出一句硬编码英文。**结构化失败事实在插件里走了一整圈又被扔掉**，于是飞书显示什么与 WebUI 显示什么毫无关系。
- **改法（按使用者要求：插件不自己解释错误，只看 WebUI 怎么显示）**：
  1. **新增 `src/turn-failure.ts`，逐行移植 WebUI 的投影**——`displayFailure()`（= `packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts`：非对象取 `String(failure)`、非字符串 `code` 丢弃、非字符串 `message` 落 JSON 序列化、`code === 'AUTH'` 只留 code 丢掉 message 以防凭据回显）与 `renderTurnFailureCard()`（= 同包 `chat/MessageItem.tsx` 的 `TurnErrorItem`：红头 + `message.turnError` 标题 + 原文正文 + `code` 内联代码；`AUTH` 换成本地化的 `message.failure.auth`）。两条文案直接对齐 DSH locale：`本轮运行失败` / `This turn failed`、`API 密钥无效` / `API key is invalid`。
  2. **`summarizeTurn()` 保留失败事实**：新增 `ended`（`turn/end` 的 `reason.kind`）与 `failure`（`error` 结束时的投影结果）两个字段，不再只回 `{ text, ok }`。
  3. **`harness.reply()` 不再吞掉原因**：`error` 结束 → 抛 `TurnFailureError`（携带 `failure`）；`aborted` / `interrupted` / `blocked` / `max-tokens` 等**非失败**结束 → 不再报错，改为返回本轮已有的文本（WebUI 对它们也从不显示错误行）。顺带修掉一个长期存在的错报：`/stop` 中止当前轮后，发起该轮的那条消息原来一定会收到这句"运行失败"。
  4. **`channel.ts` 按类型分流**：`TurnFailureError` → 红卡（与 WebUI 的 turn-error 行同构）；其余插件侧错误（飞书 API、斜杠命令、图片/文件准入）继续走 `errorText()` 的具体原因。**卡片若被飞书拒绝，自动退回纯文本 `本轮运行失败：<原因> [<CODE>]`**——换了更丰富的载体，不等于可以把原因赌丢。
- **未改**（仍是已知问题，见下条）：工具失败的结果预览上限（1500 字符 / 结构化取样）与 `errorText()` 的 600 字符截断。
- **验证**：新增 `tests/turn-failure.spec.ts` 10 例（投影的四种形态含 `AUTH` 去 message / 卡片三段结构 / AUTH 双语替换 / 空体兜底 / 文本行与卡片刻画同一份事实 / `TurnFailureError` 不重新推导），`tests/conversation.spec.ts` 由 2 例扩到 6 例（保留 `ended`+`failure`、`AUTH` 投影、`aborted` 不造假失败），`tests/harness.spec.ts` 3 例（结构化失败原样抛出 / 无细节时按 WebUI 方式投影 / `aborted` 不报错而是返回已产出的文本），`tests/plugin.spec.ts` 2 例（`TurnFailureError` 渲染成红卡且载荷逐字段断言 / 卡片被拒后回退文本仍带原因与 code）。全套 **402 passed / 33 files**（原 387 / 32），typecheck 0 error，build ✅。

### 已知问题（**未修，只记录**）：飞书侧报错内容比 WebUI 简略——错误摘要有三处硬上限（2026-09-16 使用者报告）

> ① turn 级错误的"通用句子"问题已于 **2026-09-17 修复**（见上一条）；`errorText()` 的 600 字符截断与下面②③仍是已知差距。

- **现象**：使用者报告「报错时 feishu 端显示的内容不详细，没有和 webui 对齐」。同一次失败，WebUI 能看到完整错误原文，飞书这边只剩一句被截断的摘要。
- **现状（三处上限，均在插件侧）**：① **turn 级错误**走 `channel.ts` 的纯文本 `处理这条消息时出错：<reason>`，`reason` 由 `src/error-text.ts` 的 `errorText()` 生成——只取 `error.message` + 数字/字符串 `code`，**丢掉 `cause` 链与堆栈**，并**在 600 字符处截断加 `…`**；② **工具失败**在步骤卡里只有结果预览，`RESULT_PREVIEW_CAP = RESULT_CONTENT_CAP = 1500` 字符，结构化预览还会再取样（`paths` 前 20 / `files` 前 5 / `matches` 前 3 / `diffs` 前 3 / 每个 diff 各 8 行）；③ 思考 200、正文 3000（正文溢出拆「Reply (continued N/M)」卡**不丢**，但错误文本没有等价机制）。
- **WebUI 对照**：`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` 把 `record.cell.outputDetail` **整段**放进 `<pre>` 并附「复制输出」按钮，**不做字符截断**；聊天区同样保留完整错误文本。
- **为什么这样**：飞书单条消息/卡片有体积与渲染上限，卡片是即时可读界面，整段堆栈会淹掉卡片。**要"对齐"就得另想办法**，不能直接放开上限。
- **可选方向（未定、未动工）**：① 出错时额外发一张「详细错误卡」/溢出卡；② `/error` 命令回看最近一次错误全文；③ 把完整错误写成 `.log`/`.txt` 落工作区，交给已有的 `feishu_send_file` 推送（零新面）。
- **处理**：**2026-09-16 决定先记录、不改**（与上文推理 token 回归同处理方式）。

### 新增：视频/语音改走飞书原生消息（可播放视频气泡 / 语音气泡），并接收用户发来的视频与语音（`src/media-sniff.ts`（新）/ `src/feishu-resource.ts`（新）/ `src/feishu-send-file.ts` / `src/feishu-receive-file.ts` / `src/channel.ts`）

- **问题**（2026-09-16 使用者报告「视频也是以文件的形式发送的」）：agent 用 `feishu_send_file` 推出的 mp4 一律走 `{ file }` → `file_type:'stream'` + `msg_type:'file'`，用户只能点开下载；而**用户发来的**视频/语音则完全收不到——SDK 把视频归一化成 `resources: [{ type:'video', … }]`、语音成 `type:'audio'`，而 `admitFilesForMessage` 只筛 `type === 'file'`，于是 agent 只看到 `content` 里一行 `<video key="…" name="…" duration="…"/>` 标签。
- **出站（真机取证后实现）**：SDK（`@larksuiteoapi/node-sdk@1.74.0`）本身就带这两条 payload，插件只需**按字节**判定走哪条，不用手写上传：`{ video }` → `im.v1.file.create({ file_type:'mp4', duration })` + `msg_type:'media'`；`{ audio }` → `file_type:'opus'` + `msg_type:'audio'`。新增 `src/media-sniff.ts`：`sniffVideoContainer` 要求 ISO-BMFF `ftyp` 盒子、MP4 系 brand（或 `qt  `）**且**视频 sample entry 的 codec 属可播集合（`avc1`/`avc3`/`hvc1`/`hev1`/`mp4v`）**且** `moov → mvhd` 存在（SDK 要从它算时长）；`sniffAudioContainer` 要求 `OggS` + `OpusHead`。不满足一律退回文件——**把放不出来的容器当 mp4 传上去，比"下载后本地播"更糟**，而且 SDK 对 `media` 没有降级路径（只对 `post` 有）。
- **封面**：飞书**不会**从 mp4 里抽帧，`msg_type:'media'` 的 `image_key` 只是"发送方交给它的海报图"（实测：只有 `file_key` 时参数校验通过、消息也发得出去，但客户端没有可画的东西 → 气泡无缩略图；同一 file_key 配上另一次 `im.v1.image.create` 得到的 `image_key` 就有封面）。故新增 best-effort 封面：PATH 上有 `ffmpeg` 就抽第 1 秒一帧（比 1 秒还短的片子回退第 0 帧），按 `image_type:'message'` 上传换 `image_key`；**没有 ffmpeg、抽帧失败、上传失败都只 warn**，照常发不带封面的视频。为便于测试，抽帧函数经 `FeishuSendFileDeps.extractCoverFrame` 注入（默认真 ffmpeg 实现）。
- **兜底**：SDK 在算不出 mp4/opus 时长时会抛 `duration could not be determined for …`，所以 `{video}`/`{audio}` 发送失败一律退回 `{file}` 再发一次，**任何情况下都不丢投递**。
- **入站**：`channel.ts` 的准入集合从 `file` 扩到 `file | video | audio`；下载统一收敛到新的 `src/feishu-resource.ts`。**两条下载端点是互补的（2026-09-16 双向真机实测）**：`im.v1.messageResource.get` 的 `type` **只认 `image` / `file`**（传 `media`/`video` 直接 `234001 Invalid request param`），而 `type='file'` 在**用户发的** media 消息上可用（用户发的 12.5s 视频完整取回 2.6MB），在 **app 自己发的**上却得 `234003 File not in msg.`；`im.v1.file.get({ file_key })` 恰好相反（app 发的可取回，用户发的得 `234008 The app is not the resource sender.`）。所以实现是「先 `messageResource`，失败再 `file.get`」，两种来源都不丢。无文件名的语音/视频会补上 `.mp4` / `.opus` 扩展名。<br>另注：用户用飞书客户端发的视频**自带 `image_key` 封面**（消息 content 里就有），印证了「封面由发送方提供」这一点。
- **可观测性**：工具输出新增 `sent_as`（`image` / `video` / `audio` / `file`），工具描述同步说明各分支；`feishu_receive_file` 也改走同一个下载助手。
- **验证**：`tests/media-sniff.spec.ts` 12 例（真 MP4 形态 / `qt  ` / 仅兼容 brand 命中 / ProRes 与 VP9 拒绝 / 纯音频轨 / 缺 `mvhd` / 截断与空字节 / Ogg-Opus / 非 Opus Ogg）；`tests/feishu-send-file.spec.ts` 10 例（图片、文件、视频带封面、无封面、封面上传失败仍发视频、视频失败回退文件、ProRes 走文件、Opus 语音、语音失败回退文件）；`tests/plugin.spec.ts` +3 例（入站 video 落附件库、无名语音补 `.opus`、`messageResource` 失败后走 `file.get`）。全套 **387 passed / 32 files**（原 365 / 31），typecheck 0 error。真机预检（未重启、只发消息）：本机一段 H.264+AAC mp4（5.17s / 728KB / `ftyp`=`isom,avc1,mp41`）以 `file_type:'mp4'` 上传成功（不传 `duration` 也成功），带/不带封面的 `media` 消息均正常送达。**入站也真机验证过**：使用者在聊天里发的 12.5s 视频（`msg_type=media`、`sender=user`、带 `image_key`）经 `messageResource.get?type=file` 完整取回 2622263 字节，而 `im.v1.file.get` 对它报 `234008`——与上面的双向结论一致。

### 已知回归（**宿主侧，非插件 bug，未修只记录**）：DSH `0.1.6` 起推理 token 数消失——默认 wire 协议换成 `messages`，而该端点不上报 thinking token（2026-09-16 定性）

- **现象**（使用者真机报告「升级 0.1.6 以后推理的 token 速度丢失」）：步骤卡的推理标题从 `💬 **推理** · 807ms · 135 tokens` 变成 `💬 **推理** · 5.3s`——**思考耗时还在，推理 token 数没了**。真机卡片历史取证（`im.v1.message.list` + `card_msg_content_type: 'user_card_content'`，264 张推理卡）：09-15 15:45 及以前均带 token 数（不带的都是该步本就没有推理），**09-15 20:20 重启后 0 张**。
- **根因（取证到 wire 层）**：DSH `0.1.6` 把 `@deepseek-ai/dsh-llm-deepseek` 的 `protocol` 默认值改成 **`messages`**（`packages/llm/llm-deepseek/src/config.ts`，端点 `https://api.deepseek.com/anthropic`），而**该端点 usage 不带 thinking 明细**——直接打 API（流式与非流式）只返回 `input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `service_tier`，`protocols/messages/translate.ts` 的 `updateUsage` 也只映射这四个计数。老协议 `/chat/completions` 仍返回 `completion_tokens_details.reasoning_tokens`（实测 `{"reasoning_tokens": 23}`），`chat-completions/mapUsage` 会映射成 `reasoningTokens`。会话日志逐小时统计佐证：09-15 20 点前几乎每步都有 `usage.reasoningTokens`，**20:20 重启后 174 步全部为 0**。
- **影响面**：插件步骤卡的 `· N tokens`；**以及 DSH WebUI Trajectory 的 think 用量格**（`packages/client/ui-trajectory` 读的是同一个 `usage.reasoningTokens`）——两端一起丢，属宿主侧行为变化。
- **为什么没修**：数值在 wire 上不存在，宿主拿不到、插件更拿不到。可选只有「切回 `chat-completions`（精确）」或「按推理文本估算并标 `≈`（近似）」两条取舍，**2026-09-16 使用者决定只记录、不改**。要恢复精确值只需给 `llm-deepseek` settings 段（或 profile overlay 行）设 `protocol: chat-completions`。
- **建议**：反馈给 DSH——`TokenUsage.reasoningTokens` 仍在类型里、`ui-trajectory` 仍在读，但默认协议已不再产出它。

### 修复：WebUI 里跑话题会话时，卡片溢出到话题外（`src/harness.ts` / `src/conversation.ts` / `src/channel.ts` / `src/topic-roots.ts`（新）/ `src/index.ts`）

- **问题**（2026-09-16 使用者真机报告「在 webui 对话时，feishu 话题绑定了的 session 的消息会在 feishu 群里面溢出到话题外」）：一个绑定到飞书话题的会话，如果从 **WebUI** 侧驱动（而不是在话题里发消息），它产生的每张卡片都不落在原话题里，而是变成**群里的新话题**——每个话题下只有那一条孤零零的卡片。真机取证：`im.v1.message.list`（`container_id_type=chat`）拉回该群最近 29 条顶层消息，其中 **10 条是 `sender=app` 的 `interactive`，且各自所在话题内只有它自己 1 条消息**，而 9 个已绑定话题的根消息都在群里（说明会话绑定完好，问题只出在发送坐标上）。
- **根因（两层）**：
  1. **话题根消息 id 只存在于内存**：飞书话题回复必须 `replyTo: <话题根消息 id>` + `reply_in_thread`，否则 SDK 的 `rawSend` 在 `replyTo` 为空时**直接退回 `im.v1.message.create`**——`create` 没有话题参数，于是消息成为新的顶层消息（话题群里就是新话题）。这个根 id 只在**入站**消息里出现（`message.root_id`，话题根消息自身则用 `message_id` 兜底），原实现把它记在 `HarnessConversationService.chatToRootId` 这个**纯内存 Map** 里，`dispose()` 还会清空它。
  2. **WebUI 驱动的 turn 没有入站消息**：它的坐标只能由 `resolveChat(sessionId)` 从那张 Map 反查。于是**任何一次重启（每次插件更新都会重启）、或任何一次连接 reconcile**之后，从 WebUI 发起的 turn 都拿不到根 id，卡片全部 `message.create` 到群顶层。同源的第二处泄漏：`channel.ts` 原先只在**非命令消息**进入 `bridge.reply()` 时才记录根 id，所以"只在话题里用过斜杠命令"的话题同样没有记录。
- **改法**：
  1. **话题根随状态文件持久化**（`harness.ts` + `conversation.ts`）：`chatToRootId` 与 `chatToSession` / `seenChatKeys` / `busyMode` 一起写进 `lark-session-map.json`，重启后自动恢复。记录时 `delete()` + `set()` 让 Map（及落盘顺序）按**最近使用**排序。
  2. **每个入站话题消息都记录**（`channel.ts`）：新增 `bridge.noteTopic(...)`，放在 `replyToId = rootId ?? messageId` 之后、**斜杠命令分支之前**——命令提前 return 也不再漏记。这同时统一了原先分散在 `feishu-onboarding.ts` 里的另一份内存话题表：`topicFor(chatId)`（卡片回调只带 `chatId`，需要反查话题）现在**优先问 bridge**，onboarding 的内存表退化为回退。
  3. **一次性补齐历史上缺失的根**（`src/topic-roots.ts`（新）+ `index.ts`）：`fetchThreadRootId()` 用 `im.v1.message.list` 的 `container_id_type: 'thread'`（`ByCreateTimeAsc`、`page_size: 1`）取话题第一条消息作为根（其 `root_id` 为空即它自己；若非根则优先用 `root_id`）。每次通道连上后，`recoverTopicRoots()` 在后台把 `missingTopicRoots()` 列出的历史话题逐个补齐，**不阻塞连接、失败只记日志**。真机预检：9/9 个已绑定话题都能解析出根。
  4. **让"降级"不再静默**（`index.ts`）：`sendCardByReference` 在 `replyInThread` 为真却拿不到 `replyTo` 时打一行日志——这种降级此前完全不可观测。顺带把卡片通道 `send` / `sendCardByReference` 的 `opts` 类型补上 `replyTo`（原先只在后者上声明，`cardChannel.send` 的签名把 `replyTo` 吞掉了）。
- **验证**：新增 `tests/topic-roots.spec.ts` 四例（取话题第一条 / 优先 `root_id` / 空话题与空参返回 `undefined` / API 抛错时降级为 `undefined` 且不抛）、`tests/harness.spec.ts` 六例（`resolveChat` 带上话题根 / 根跨重启持久化 / 无话题或无根时 `noteTopic` 不记录 / `topicFor` 返回最近使用的话题且缺根时返回 `{}` / `missingTopicRoots` 与 `setTopicRoot`）、`tests/plugin.spec.ts` 两例（入站话题消息——含**话题根消息自身没有 `root_id`**——都记录；斜杠命令提前返回前也已记录）。全套 **365 passed / 31 files**（原 354 / 30），typecheck 0 error，build ✅。

### 修复：一次卡片点击能杀掉整个 dsh 进程——`/permission` 切换触发 DSH 拒绝后被升级成 `fatal load failure`（`src/card-dispatch.ts`（新）/ `src/feishu-permission.ts` / `src/feishu-session.ts` / `src/index.ts` / `src/i18n.ts`）

- **问题**（2026-09-14 使用者真机报告「刚才有一次 permission 切换故障」）：在话题里点 `/permission` 卡片的「🔓 Full access」，**dsh 进程直接以 status=1 退出**，systemd 重启（`restart counter is at 1`），当时所有正在跑的 turn 一起被杀。日志证据：`[card] … value={"p":"permission","mode":"danger-full-access"}` 紧跟一行 `dsh: fatal load failure: Error: cannot change sandbox mode from "workspace-write" to "danger-full-access" while persistent terminal sessions are open or being created`。
- **根因（两层，缺一不可）**：
  1. **DSH 的合法拒绝**：`dsh-terminal-bash` 注册了一个 `internal/dispatch` 全局监听——某会话仍有常驻 PTY（`terminals.hasOwnerActivity(owner)`）时，禁止改沙箱模式（会波及正在执行的命令）。该监听在 `session.append('sandbox/mode')` 的**回调收集阶段**抛出，所以事件根本没入日志。触发它的会话是 `minimal` 预设——**该预设唯一的 shell 就是常驻 bash**（`dsh-tool-bash-persistent`），于是 agent 跑过任何一条命令之后，这个会话在整个生命周期内都不能再切沙箱模式。**这是 DSH 行为，不是插件 bug**（WebUI 走 `/permission` 命令同样会撞上）。
  2. **插件把拒绝升级成了致命错误**：卡片回调的扇出是 `for (const h of cardActionHandlers) void h(evt)`——没有任何人 await、也没有任何人持有这个 promise。`feishu-permission` 的处理器是 `async`，`permissionPresets.set()` 的同步抛出因此变成一个**无主的 rejected promise**；DSH 的 `installFailLoud` 把 `unhandledRejection` 一律当成启动失败（打印 `fatal load failure` 后 `process.exit(1)`）。**结论：在这个插件里，任何一个被丢弃的 promise 都能杀掉守护进程。**
- **改法**：
  1. **扇出逐个兜住失败**（新模块 `src/card-dispatch.ts` 的 `dispatchCardAction`）：`Promise.resolve(handler(evt)).catch(onError)` + 同步 throw 的 try/catch，一个处理器失败不影响其余处理器，失败走 `console.log`（进 journald）。按钮点错可以失败，但不能停服务。
  2. **`/permission` 把拒绝讲清楚**（`src/feishu-permission.ts` 的 `describePermissionSwitchFailure`）：写入失败不再上抛，而是**原地重绘卡片**并附一行 `⚠️ 切换未生效：<DSH 原文>`；命中常驻终端围栏时再补一句可执行的建议（新建会话 / 换用不含常驻终端的预设）。`/permission <模式>` 文本路径同样接管，不再回落到通道的兜底 `命令执行出错`。读回当前模式也加了保护——读失败不能掩盖写失败。
  3. **`feishu-session.ts` 的 `return void handleRename/handleConfirm/handlePanel(...)` 改为 `return handle...(...)`**：这是同一个病——`void` 丢掉的 promise 若 reject 同样无主、同样致命。改为让失败传回扇出（由第 1 条兜住并记录）。
- **影响面与遗留**：崩溃后重启会清空 `terminals`（PTY 是内存态），所以围栏只在"会话跑过常驻 shell"期间存在；但**崩溃前已发出的那张 `/permission` 卡片在重启后成了死卡**（`byCard` 是进程内 Map），需要重新执行 `/permission` 拿新卡。
- **验证**：新增 `tests/card-dispatch.spec.ts` 五例（逐个投递 / 异步 reject 被兜住且不影响后续处理器 / 同步 throw 不打断扇出 / **不产生 `unhandledRejection`** / 健康处理器不报错），`tests/feishu-permission.spec.ts` 三例（围栏拒绝时处理器**resolve 而非 reject**、卡片含原因+建议且按钮仍在 / 非围栏原因的拒绝不带那段建议 / 读回模式抛错时仍重绘卡片），`tests/feishu-session.spec.ts` 一例（面板操作失败必须由处理器 promise 传出，供扇出兜住）。**反证过**：把扇出改回 `void handler(evt)`，`unhandledRejection` 那例立刻变红（并把 `boom` 原样打出来）；把 session 改回 `return void handlePanel(...)`，新例变红。全套 **354 passed / 30 files**，typecheck 0 error，build ✅。

### 修复：`/new` 走到模型卡就断——换 provider 后下拉初始值不属于该 provider，确认被静默丢弃（`src/feishu-model-select.ts` / `src/index.ts`）

- **问题**（2026-09-11 使用者真机二次反馈「选择模式的卡片还是被 retire 了，似乎也没有最后的参数确定卡片」）：真机卡片时间线显示流程走到 `🤖 模型选择` 就停住——目录决定卡已正确冻结，但它之后只有一张灰提示（预设卡）和那张模型卡，**确认卡从未出现**；`lark-session-map.json` 未更新、主聊天也没有落错地方的卡片，`ctx.logger` 又不进 journald，所以整条链路没有任何痕迹。
- **根因**：`handleSelectProvider` 把**当前会话的模型**直接塞给刚选中的 provider 的下拉——`renderModelSelectCard(providers, models, provider, current.model, …)`。话题里的当前模型是 `deepseek-official/deepseek-flash`，而 operator 点的是 `minimax-cn`（选项只有 MiniMax-M2.7 / M2.7-highspeed / M3）：`select_static` 的 `value` 不在自己的 `options` 里，飞书渲染成空下拉，提交时 `form_value.model` 为空，`parseCardAction` 判 `model !== ''` 不成立便 **`return undefined`，无卡片、无报错、无日志**，确认按钮看起来完全没反应。（14:31 那次能建出会话，只是因为当时当前模型恰好落在 minimax 列表里。）
- **改法**：
  1. **初始值回退到该 provider 自己的模型表**：`const initialModel = models.find(m => m.id === current.model)?.id ?? models[0]?.id ?? current.model`——属于当前 provider 就沿用，否则取该 provider 的第一个。下拉永远有合法选中项，确认永远不会再因为"没选中"而丢。
  2. **消灭静默失败**：`model` 为空时打一行 `console.log`（进 journald，见关键坑 7 的"不许静默失败"），把 provider 与收到的 `form_value` 一起写出来。
  3. **补上卡片回调日志**：`cardChannel.onCardAction` 的扇出入口新增一行 `dsh-feishu: [card] …`（`chatId` / `messageId` / `action.value` / `raw.action.form_value`）。此前**没有任何地方记录卡片点击**（`channel.ts` 只记 `[msg]` 文本），"点了没反应"从外部根本无法定位。一次点击一行，成本可忽略。
  4. **预设卡改为冻结保留**（`onModelStep`）：它记录的是真实决定（`标准模式`/`PTC 模式`…），不再收成通用灰提示，末尾追加 `✅ 已选择：<预设名> —— 这张卡片已锁定，不能再修改`。
- **验证**：新增 `tests/feishu-model-select.spec.ts`（该模块**此前零测试**，正是这个 bug 长期存活的原因）四例——换 provider 后下拉初始值必须是该 provider 的合法选项、当前模型属于该 provider 时保持不变、`flow: 'new-session'` 的确认确实转发给 `onNewSessionConfirm`（这条链路之前无法真机验证）、提交缺 `model` 时不静默而是留下日志。**反证过**：把初始值改回 `current.model`，第一条立刻转红。全套 **345 passed / 29 files**，typecheck 0 error。

### 修复：目录决定卡仍退化成灰色提示——载荷被"翻页"标记丢掉了（`src/card-supersede.ts` / `src/feishu-onboarding.ts`）

- **问题**（2026-09-11 使用者真机反馈「怎么和之前没有差别」）：上一节的「决定卡冻结保留」上线后，走 `/new` 的**目录浏览器**路径时，点「✅ 用这个目录」那张卡**仍然是裸灰提示**，没有冻结显示所选路径。真机卡片时间线可证：`/new` 之后连续 8 张全是「⬆️ 此卡片已失效」，没有一张带结算文案。
- **根因**：`sendCard` 记「上一张卡」时按导航标记决定要不要带上原始载荷——`...(options?.navigation === true ? {} : { card })`。目录页正是 `navigation: true` 发的，于是它的载荷**根本没被记住**；而 `supersedePrevious` 里 `keep` 的前提是 `previous.card !== undefined`，于是 `commitWorkspace` 明明传了 `{ mode: 'keep', note }` 也拿不到内容，只能回退成通用灰提示。**「要不要保留」被编码成了「有没有记住载荷」这个隐式副作用**，两者本就不该耦合：一张卡在被退休之前随时可能变成决定卡（目录页就是典型——翻页时是纯导航，用户点「用这个目录」那一刻就是决定）。
- **改法**：**载荷永远记住，形态只由退休模式决定**。`CardRef` 新增 `navigation?: boolean`，`sendCard` 一律带 `card`、按需标 `navigation: true`；`supersedePrevious` 的 keep 判定改为按优先级取模式——显式 `'notice'` → 不保留；显式 `'keep'` → 保留（有载荷时）；**未指定** → 导航卡不保留（翻页仍是裸提示，满足「翻页的不保留内容」），其余卡保留。`browse-back` 回工作区选择卡走的正是「未指定 + 上一张是导航页」，行为不变。
- **验证**：新增 `tests/onboarding.spec.ts` 一例（`browse-open` → `browse-enter` → `browse-pick`：断言被冻结的是**目录页 card-2**、含 `✅ 已选择：<workspace>/projects`、仍含目录项 `my-app`、且无任何 `behaviors`）；`tests/card-supersede.spec.ts` 新增两例（导航卡默认收成提示 / 导航卡被显式 `mode:'keep'` 时仍冻结）。**反证过**：把 `sendCard` 那行改回旧写法，onboarding 新例立刻转红，恢复后转绿。全套 **341 passed / 28 files**，typecheck 0 error。

### 修复：新建会话时选的模型/推理等级真正生效（`src/harness.ts`）

- **问题**（2026-09-11 使用者真机报告「新建会话时的模型选择没有生效」）：`/new` 卡片流程里选完 `minimax-cn/MiniMax-M3`，结果卡也明确写着 `🤖 minimax-cn/MiniMax-M3`，但会话实际跑的是全局默认 `deepseek-official/deepseek-flash`。会话日志可证：**没有 `model/selection` 事件**，第一条 `request/header` 就是默认路线，连 system prompt 的 `{{model}}` 也被改写成默认模型。
- **根因**：插件靠 `chatToCreation` → `agents.create({ agentOptions })` 传路线，**但那只是"声明"，不是 DSH 认定的会话选择**。第一个 prompt 经 `sessionController.prompt()` 派发时，`ApiSessionAgentController.selectionFor(agent)` 会装上 `installModelSelection` 的 `agent/request` 监听；而对该会话（尚无 `request/header`）它的 `selection.current` 回退到 `agentDefaultModel.currentSelection()`，于是在 loop 自己解析完路线之后**又覆盖回全局默认**，连 `system-prompt/assemble` 的 `{{provider}}`/`{{model}}` 变量也一起覆盖。
- **改法**：新建 agent 之后走 DSH 自己的写路径 `sessionController.selectModel({ sessionId, provider, model, reasoningEffort })`——它会写入持久的 `model/selection` 会话事件并设置 agent scoped ref（WebUI 选模型走的就是这条路），第一个 prompt 便不再被默认值覆盖。与 WebUI 一致，它同时会把该选择保存为全局默认。`selectModel` 缺失或抛错只记一行日志，不阻断会话（仍跑默认路线）。
- **影响面**：`/new` 卡片流程与 `/new <工作区> <预设> [provider/model[:effort]]` 文本路径都覆盖到（同一条 `chatToCreation` 通路）。
- **验证**：`tests/harness.spec.ts` 新增三例——新建时按 creation 选项调 `selectModel`（含 reasoningEffort）、没带模型时**不**碰路线、`selectModel` 抛错时会话仍可用且打了日志。全套 **331 passed / 27 files**，typecheck 0 error。

### 变更：`/new` 流程收尾重做——决定卡冻结保留 + 最终确认卡（`src/new-session-card.ts` / `src/card-supersede.ts` / `src/feishu-onboarding.ts` / `src/index.ts` / `src/i18n.ts`）

- **问题**（2026-09-11 使用者报告）：交互流程每步发新卡、并把上一张**整张替换**成一句灰色「此卡片已失效」，走一遍 `/new`（开卡 + 工作区选择 + 目录浏览几页 + 预设 + 模型）后聊天里剩下一墙没有内容的灰卡；而且**模型卡的「确认」一按就直接建会话**，没有让使用者看过「这个会话到底配了什么」。
- **改法一：决定卡冻结保留**。`CardRef` 增加可选 `card`（发卡时的原始 JSON），退休时由调用方选模式：
  - `{ mode: 'keep', note }` —— **冻结**：保留原卡全部内容，只递归删掉所有 `behaviors`（Card JSON 2.0 里唯一能触发回调的字段）、header 置灰、末尾追加 `note`。用于**做了决定的卡**：点某一行选定工作区、或点「✅ 用这个目录」确认目录时，那张卡就停在那里显示选择结果，**不可再编辑**（`cardSettledNote(value)`：`✅ 已选择：<值> —— 这张卡片已锁定，不能再修改。`，zh/en）。
  - `{ mode: 'notice' }` —— **不保留**：整张替换成通用灰提示。用于**只是路过的卡**（目录浏览器的翻页、上/家目录）和**纯向导步骤**（预设卡、模型卡），否则翻十页会留下十条没用的目录清单。
- **改法二：最终确认卡**。模型卡按「确认」不再建会话，而是把**所有设置**收进一张新卡（`src/new-session-card.ts`）：📁 工作区 / 🧩 Agent 预设 / 🤖 模型 / 🧠 推理等级 + 「✅ 创建会话 / ✖️ 取消」两个按钮（走 `behaviors`，因为卡片是 CardKit 实例——顶层 `value` 会被静默丢弃）。**确认后才建会话**，确认卡原地变成绿色「✅ 会话已创建」（`commitNewSession` 新增 `repaint` 参数，用卡片实例原地更新而非再发一张）；取消则原地变成灰色「✖️ 已取消新建会话」。pending 状态按 chat 存在 `pendingNewSession`，cardAction 订阅随插件 dispose 释放。
- **验证**：新增 `tests/new-session-card.spec.ts`（4 例：列全设置 / 两个回调走 behaviors 且不带顶层 value / 未选工作区时给默认提示 / 取消卡无按钮）；`card-supersede` 扩到 10 例（含 `mode: 'notice'` 丢弃内容、`mode: 'keep'` 带结算文案且无回调）；`onboarding` 两例改断言「工作区决定卡冻结显示 `/ws-2`」「预设卡退休只剩通用提示」「en 词典」。全套 **338 passed / 28 files**，typecheck 0 error。

### 变更：审批卡结算/失效后保留原有内容（`src/feishu-approvals.ts` / `src/i18n.ts`）

- **问题**：审批卡一旦结算（点允许/拒绝）、本轮中止、或被网页端接管，重画出来的卡就只剩一行结果——`✅ \`bash\` — 已允许一次`。**触发这次审批的原因（reason）和 short code 全没了**，回头翻聊天记录不知道当时批的是什么。
- **改法**（对齐问题卡的做法：问题卡结算后仍保留 `question` 与 `detail`）：抽出 `approvalAskMarkdown()`，把「工具 + 位置提示（short code / 本话题）+ 原因」作为**原样保留的提问块**，三种后续状态都在它**下面追加**结果——结算卡（绿/红）追加 `approvalDecidedLine`、失效卡（灰）追加 `approvalExpiredBody`、被网页端接管的卡也在它后面追加结果。
- **i18n**：`approvalDecidedBody(toolName, approved)` → `approvalDecidedLine(approved)`（不再重复工具名，工具名已在提问块里），中英各改一处。
- **验证**：新增两例——飞书结算后卡片仍含工具名、reason 与结果且无按钮；本轮中止的失效卡同样保留工具名与 reason。全套 **325 passed / 27 files**，typecheck 0 error。



### 变更：败方卡片显示「对方选了什么」（`src/card-supersede.ts` / `feishu-questions.ts` / `feishu-approvals.ts`）

- **诉求**：WebUI 先答时，飞书那张卡虽然会变成灰色「已在网页端处理」，但只说了"作废"，没告诉你在网页端**选了什么**，回头翻聊天记录看不出结论。
- **改法**：两个 surface 的答案本来就在手上（`firstDefined` 返回的 `winner.value`），之前渲染时丢掉了，现在把它带上：
  - **提问卡**：改用 `renderSettledQuestionCard` 渲染（带 `title`/`template`/`note` 覆盖参数），标题为「已在网页端处理」、灰色，正文照旧列出所有选项并**高亮网页端选中的那个**，自定义回答与跳过也照常标注。
  - **审批卡**：`renderAnsweredElsewhereCard` 增加可选 `detail` 行，并在后续改动中把整块提问（工具 + 位置 + 原因）一并带上，于是卡片同时显示「已在网页端处理」和结果行。
- **未做**：反向（飞书先答时让 WebUI 显示飞书选了什么）做不到——那条路径是**中止转发**，只能让浏览器撤卡，无法往对面写内容。
- **验证**：`feishu-questions.spec.ts` 断言败方卡片同时含「已在网页端处理」与 `✅ **No**` 且不含按钮；`feishu-approvals.spec.ts` 断言含工具名与「已拒绝」。全套 **323 passed / 27 files**，typecheck 0 error。**真机已验证（2026-09-11）**：WebUI 先选 → 飞书灰卡标题「✅ 已在网页端处理」、被选项高亮为 `✅ **第二个选项** — 已选择`、其余为 ⬜、卡片无按钮。

### 变更：i18n 词典按 DSH WebUI 的 locale 文件对齐（`src/i18n.ts` / `src/commands-i18n.ts` / `src/feishu-streaming.ts`）

- **背景**：DSH WebUI 自己的中文词表在 `packages/client/ui-*/src/client/locales.ts`，与插件词典长期各写各的，出现了「同一件事两个词」。
- **对齐（以 WebUI 为准，中英都改）**：
  - 审批卡标题 `审批请求`/`Approval needed` → **`等待审批`/`Waiting for approval`**（`ui-approval` `waiting`）；按钮 `批准一次`/`Approve once` → **`允许一次`/`Allow once`**（`allowOnce`）；结算卡随之改为 `✅ 已允许` / `✅ Allowed once`。`/approve` 命令文案同步改用「允许」。
  - 推理档位 `推理强度` → **`推理等级`**（`ui-model-selection` `menu.effort`；英文仍是 reasoning effort）。
  - 会话操作 `派生` / `已 fork` → **`分叉` / `已分叉`**（`ui-workspace` `menu.fork` = `分叉会话`）。
  - Turn Complete 的 `📦 交付物` → **`📦 交付文件`**（`ui-deliverables` `row.title`），英文 `Deliverables` → `Present files`；工具摘要 `交付物：a.txt +2` → `交付文件：a.txt +2`。
  - `/status` 的 `TTFT 平均` → **`首 token 延迟`**（`ui-trajectory` `timing.ttft`；英文仍是 `TTFT`）。
- **验证**：`feishu-approvals` / `feishu-session` / `feishu-streaming` / `channel-footer` 的断言同步更新，其中能取自词典的一律改成引用 `t.deliverablesTitle(...)`，避免以后再改词就红；全套 **323 passed / 27 files**，typecheck 0 error。

### 修复：审批卡双语化 + 本轮中止时作废 + 按钮取值改用共享解码（`src/feishu-approvals.ts` / `src/i18n.ts`）

- **审批卡此前全英文**：`Approval needed` / `Approve once` / `Reject` / `✅ Approved` / `❌ Rejected` / `pending in this thread` 都是写死的英文，`/lang zh` 也不变，与双语的提问卡不一致。现在整张卡（标题、`工具：`/`原因：` 标签、位置提示、两个按钮、结算卡）都走 `i18n.ts` 新增的 `approval*` 一组字段。
- **本轮中止时审批卡不作废**（真 bug）：`/stop`、turn 取消或请求结束时，待审记录被删掉，但卡片原样留着、按钮齐全——点下去找不到 pending 条目，**静默无反应**。现在中止路径会把卡片改写为灰色「⏹️ 审批已失效」并去掉按钮（提问卡此前已有同样处理，这次补齐审批卡）。顺带把 `cardAnsweredElsewhereBody` 的「问题」改成中性的「请求」，因为它现在同时用于提问卡和审批卡。
- **按钮取值改用共享解码**：审批卡自己实现了一套「只接受 JSON 字符串」的解析，与提问卡/其余卡片统一的 `decodeCardValue()`（字符串、双重编码、普通对象都吃）不一致，飞书一旦改投递形态就会静默失灵。已统一。
- **验证**：`tests/feishu-approvals.spec.ts` 新增三例（中文整卡渲染、中止后作废且卡片无按钮、对象形态 `action.value` 可解），全套 **323 passed / 27 files**，typecheck 0 error。

### 变更：提问与审批现在**飞书和 WebUI 同时弹卡**，谁先回答谁生效（`src/dual-answerer.ts` + `feishu-questions.ts` / `feishu-approvals.ts`）

- **问题**：会话一旦绑定到飞书话题，DSH Web UI 就**再也不弹** `ask_user_question` 卡片或审批卡片了。
- **根因**：这两个事件是 Agent 作用域的 Cordis waterfall。`api-remotes` 在 boot 时注册了一个把请求转发给浏览器、并**阻塞等待**的内层监听器；插件为了能渲染飞书卡片，用 `prepend: true` 把自己注册成**最外层**，命中绑定会话就**直接返回答案**——waterfall 就此结束，内层的 WebUI 转发永远不会执行（见旧版关键坑 #6）。
- **改法**：最外层不再"独占"，而是**两个界面都呈现**后再比谁先答：
  1. 飞书照常发卡；同时调用 `next()` 把同一个请求交给内层的 WebUI 转发器，于是浏览器也弹出卡片。
  2. 用 `firstDefined()` 赛跑两个答案，**第一个真正给出答案的一方胜出**；某一边"给不了答案"（没有浏览器连接、客户端委托、发卡失败）只算弃权，不影响另一边。
  3. **飞书先答**时，通过 `installSignalGate()` 把请求的 `signal` 换成一个可主动中止的组合信号再交给转发器——`api-gateway` 把转发卡片的生命周期绑在这个 signal 上，中止时会给浏览器发 `cancel` 帧，**WebUI 卡片随之消失**。这是 DSH 现有 API 下从插件侧关掉另一端卡片的唯一手段（gate 同时跟随调用方原本的 turn signal，所以 turn 中止时两端照常一起取消）。
  4. **WebUI 先答**时，飞书卡片被改写为「✅ 已在网页端处理」的失效卡（不再像还能点）。
- **兼容**：`installSignalGate` 用 `Object.defineProperty` 改写请求对象；若将来 DSH 冻结该对象，则退化为"WebUI 卡片挂在 turn 结束才消失"，不会报错。未绑定飞书的会话行为完全不变（直接 `next()` 走 WebUI）。
- **验证**：新增 `tests/dual-answerer.spec.ts`（赛跑与信号门 8 例）、`feishu-questions.spec.ts` 三例（WebUI 胜 / 飞书胜 / WebUI 弃权）、`feishu-approvals.spec.ts` 三例（同上）；全套 **320 passed / 27 files**，typecheck 0 error、build OK。

### 修复：rc.1 的 `dsh-client-ui-primitives` 打包变更让插件测试加载不了组件库（`vitest.config.ts` / `tests/stubs/ui-primitives.tsx`）

- **现象**：DSH `0.1.5-rc.1` 的全新安装下跑 `npm run test`，`tests/client.spec.ts` 报 `Cannot find package 'clsx' imported from .../dsh-client-ui-primitives/lib/index.js`（Vite 另会报 `Failed to resolve import "clsx"`）。
- **根因**：`dsh-client-ui-primitives` 在 alpha.1 里把 `clsx` / `anser` / `katex` / `shiki` / `micromark-*` / `mdast-util-*` 声明在 `dependencies`，rc.1 把它们**整体降为 `devDependencies`**（发行时这些依赖由宿主 Web 应用提供），但构建产物 `lib/index.js` 仍然静态 `import` 它们。插件独立 `npm install` 不会安装依赖的 devDependencies，于是 vitest 解析 `ui-primitives` 的模块图时找不到这些包。
- **影响面**：**仅单元测试**。`typecheck` / `build` / 线上运行都不受影响——client bundle 早就把该包标为 external，由 DSH Web 运行时提供，插件从不自带这份代码。隐患在于：`package-lock.json` 一旦重新生成（任何一次依赖变更、CI 全新 `npm ci`）就会踩到。
- **改法（采纳 B1，而非"补依赖"）**：既然该包由宿主提供、插件从不需要在自己的 `node_modules` 里拥有它，测试就不应从插件的 node_modules 解析真包。`vitest.config.ts` 加 `resolve.alias` 把 `@deepseek-ai/dsh-client-ui-primitives` 指向 `tests/stubs/ui-primitives.tsx`——按真组件的**可观测契约**实现 `Button` / `Input` / `StateDot` / `Switch`（`role="switch"` + 来自 `label` 的 `aria-label`、原生 `disabled`、受控 `input`、`data-state`）。**原有测试断言一条未删**，零新增依赖。另一条路（把 18 个传递依赖写进 `devDependencies`）被否：依赖清单臃肿，且 DSH 下次给 primitives 加一个依赖就会再红。
- **验证**（真模拟，而不是移走整个 primitives 包）：移走 `node_modules/clsx` 时——无 alias ❌ 报 `Cannot find package 'clsx'`；有 alias ✅ `tests/client.spec.ts` 10 passed。再把整个 primitives 包移走 ✅ 全套 307 passed（26 files）。还原后 `npm run typecheck` 0 error、`npx vitest run` 307 passed。

### 变更：步骤卡 footer 的 token 口径——📥 只报「本步新输入」，不再与上下文重复（`src/feishu-streaming.ts`）

- **问题**：第一行 `📥 in` 用的是**计费输入**（未缓存 + 缓存读 + 缓存写 = 完整 prompt），而第二行 `📊` 的分子也是同一个值（`contextMeta.lastInputTokens` 就是那次请求的计费 prompt）。于是每一步卡片上同一个数字出现两次，看起来像重复统计。
- **原委**：LLM 每次请求都重发整个上下文，所以「本步输入」与「上下文占用」本来就是同一个量的两种说法；📊 唯一多出来的信息是窗口容量与百分比。
- **改法**：📥 改为**本步真正处理的输入** = `inputTokens + cacheWriteTokens`（未命中处理 + 写入缓存），**排除 `cacheReadTokens`**（命中是复用、没有重算）；命中存在时附 `♻️ NN%`（`cacheRead / 全部 prompt`）。上下文总量此后**只**出现在 📊 一处。
- **口径依据**：DeepSeek / OpenAI 系只报「命中 / 未命中」，`inputTokens` 即未命中部分，故 📥 与适配器数值一致；Anthropic 系显式缓存会单独报 cache write，加上它才是"本步新增"。DSH Web UI 的 Trajectory 用量面板把三个桶分行显示（输入 / 缓存读取 / 缓存写入 / 其他），卡片宽度有限，才合成「新输入 + 复用率」。
- **验证**：`tests/feishu-streaming.spec.ts` 新增一例覆盖三种形态（DeepSeek 无 cache write、Anthropic 有 cache write、完全没有缓存活动时不出现 ♻️）。

### 修复：改设置会把整个飞书运行时推倒重建，进而杀掉正在跑的 turn（`src/config.ts` / `src/runtime.ts`）

- **现象**：agent 正在跑时点 `/display` 卡片（或执行 `/display <开关> on|off`、`/lang zh`），聊天里回一条 `处理这条消息时出错：session "…": flush on a closed handle`，**Agent 随即变成空闲**。
- **根因链**（日志证据：点一次卡就出现一对 `[ws] ws client closed manually` → `ws client ready`）：
  1. `index.ts` 的 `settingsScope.watch(...)` 在设置变化时调 `runtime.reconcile()`；
  2. `reconcile()` 用 **`JSON.stringify(config)` 整个 settings 对象**当指纹，而 `resolveRuntimeConfig` 返回的就是 `{ ...config, appSecret }`——于是**改动任意一个设置字段（含四个显示开关、`locale`、`session` 默认值）都会让指纹变化**，被当成「连接配置变了」；
  3. `reconcile()` 于是 `stopCurrent()` → 断开 WebSocket + **`bridge.dispose()`**；
  4. `bridge.dispose()` 会 dispose 掉 `handles` 里的**每一个 agent** → agent-loop 关闭该 session 的写句柄；
  5. 此时若有一个 turn 在跑或有一条消息排在 `await agent.whenIdle()` 上，它的 `sessions.flush(agent.session)` 就打在一个已关闭的句柄上 → `flush on a closed handle`，turn 直接失败、agent 变空闲。
  - 影响面不止新卡片：`/display <开关> on|off`（文本路径）与 `/reasoning show on|off`、`/lang` 从加入起就有同样的问题；WebUI 面板因为外面包了 `beginUpdate`/`endUpdate`（`apiUpdateDepth`）才没暴露。
- **修复**：新增 `connectionFingerprint(config)`，指纹只覆盖**通道构造时真正捕获的字段**（`appId` / `appSecret` / `domain` / `requireMention` / `dmMode` / `groupAllowlist` / `dmAllowlist` / `reactEmoji`），`reconcile()` 改用它比较。显示开关、`locale`、`workspace`/`agentPreset`/`provider`/`model`、`errorMessage` 都不再触发重建——它们要么被其它子系统**实时读取**，要么（`errorMessage`）只是兜底文案、不值得为它重连一次。
- **验证**：`tests/config.spec.ts` 断言「非连接字段不改变指纹、连接字段改变指纹」；`tests/runtime.spec.ts` 新增一例——连续改显示开关/`locale`/`errorMessage`/会话默认值后，`start` 只调用一次且旧运行时**从未被 stop**。`npm run typecheck` / `npm run test`（305 passed）/ `npm run build` 全绿。


### 新增：`/display` 无参改为交互式开关卡片（`src/feishu-display.ts` / `src/index.ts` / `src/i18n.ts`）

- 无参 `/display` 现在发一张 **📇 卡片显示** 卡片：四个开关各一个按钮，文案直接带状态（`✅ 工具调用：开` / `⬜ 结果：关`），点一下取反并立即持久化——不用再记命令语法。带参 `/display <开关> on|off` 保持不变。卡片发送失败时自动回退到原来的文本列表，`/display` 永远有回应。
- **每次点击都发新卡，并把上一张改写成「已失效」提示**（复用 `card-supersede.ts`）。这不是保守选择：飞书对同一条消息的卡片**就地更新约 2–3 次后就不再投递按钮回调**（`im.v1.message.patch` 与 `cardkit.v1.card.update` 同样受限），而这张卡天然会被连点四次。按钮的回调载荷带的是**目标值**而非「切换」标记，因此即使同一次点击被重复投递也不会翻转两次。
- **卡片跟随原话题**：`cardAction` 事件不带话题信息，所以 `open()` 把 `ConversationMessage` 按 `messageId` 记下来，刷新出的新卡仍落在同一话题（与 `feishu-busy.ts` 同一套做法）。
- 写的是和 WebUI 设置面板、`/display` 文本命令**完全相同**的四个配置字段，三处永远一致。
- **首次上线后修掉的两个「点了没反应」**（2026-09-10，真机复现）：
  1. **按钮回调必须用 `behaviors`**。这张卡走 CardKit 卡片实例（`createCardInstance` + `sendCardByReference`），而**实例卡片只认 `behaviors: [{ type: 'callback', value }]`，顶层 `value` 会被静默丢弃**（内嵌卡片两种都吃，所以 `feishu-busy.ts` / `feishu-permission.ts` 的写法在这里不适用）。`value` 传普通对象即可，不需要 `JSON.stringify`。
  2. **写设置必须 `await` 之后再重读**。`settings.mutate()` 是排队的异步写，`settingsScope.get()` 只在它持久化完成后才更新；原先「先 `set` 再 `get` 重渲染」读到的是旧值。为此 `DisplayControl.set` 的返回类型改为 `void | Promise<void>`，`index.ts` 返回 `settings.mutate(...)` 的 promise（并挂一个 detached `.catch`，供忽略返回值的 `/display` 文本路径使用），卡片路径 `await` 它。
- 顺带补了诊断日志：点击命中我方载荷但卡片未知 / 载荷非法时打印一行（`[display] action for unknown card …` / `[display] ignored malformed action …`），下次同类问题不用再靠猜——**没有日志正是这次排查绕了一圈的原因**。
- **验证**：`tests/feishu-display.spec.ts`（11 例：渲染/本地化/幂等目标值/`behaviors` 形态回归/**写落地后才重绘**/发新卡+失效改写/话题保持/非法载荷忽略/stop 后不响应/发送失败不破坏点击）。

### 新增：Turn Complete 卡片列出本轮「交付物」（`src/feishu-streaming.ts` / `src/channel.ts` / `src/i18n.ts`）

- DSH `0.1.5-rc.1` 起，随附 Web 的 `standard` / `ptc` / `cordis` preset 带有 **`present` 工具**，其指引要求模型对用户要接收的文件显式调用它；成功后往会话日志写 `deliverables/presented`（`{ turn, callId, files: [{ path, description? }] }`）。插件此前完全忽略这个事件——**模型声明交付了文件，飞书聊天里却什么都没有**。现在把它收进本轮统计，渲染在 **Turn Complete 卡片的最前面**，其后紧跟一条分隔线，再才是耗时/token 等指标：

  ```
  📦 交付物（2）
  • `reports/summary.md` — 月度汇总
  • `assets/chart.png`
  ─────────────────────
  ⏱ 12.3s · 🧠 LLM 8.1s · 🔧 Tools 2.4s
  ...
  ```

  放在最前是因为**用户可能真的要动手拿文件**，而指标只是读一眼的数字；起初放在 stats 与元信息之间，使用者在真机上指出位置不合理（2026-09-10）后前移。

  ```
  📦 交付物（2）
  • `reports/summary.md` — 月度汇总
  • `assets/chart.png`
  ```

- **只列清单，不推送文件**（⚠️ **已于 2026-10-07 取代**，见「Unreleased」首条「`present` 交付物按类型投递」）。飞书没有工作区浏览器，Web 那套「交付物卡片行 + 点开在侧栏预览」在这里没有等价物；而把文件直接推进聊天既噪音大，又会让模型同时调 `present` 与 `feishu_send_file` 造成重复发送。清单保留了 `present` 的全部价值——**模型筛过的成品 + 描述**——用户真要文件时说一句即可，仍走已有的 `feishu_send_file`。
- 细节：按 `path` 去重、**后声明的描述覆盖先前的**（对齐 Web UI `ui-deliverables`）；单轮上限 16 条；卡片最多列 6 条，其余折成 `…另有 N 个`；路径里的反引号/换行会被压平，避免破坏卡片 markdown；不做图片内联。
- `deriveToolSummary` 为 `present` 增加分支（`交付物：a.txt +2`），不再落到 `present · files` 的兜底文案。
- **验证**：新增 4 例测试（收集与去重、后声明描述优先、非法载荷忽略、跨轮清空）+ `deriveToolSummary` 的 `present` 用例 + `renderFooterCard` 的「交付物在首位、其后是分隔线」用例。

### 文档：DSH 0.1.5-alpha.1 → 0.1.5-rc.1 升级评估（`docs/migration-0.1.5-alpha.1-to-rc.1.md`）

- 记录 279 个 commit 的逐包 API diff（17 个包的 `exports` 零差异、19 个宿主服务名全在、发行说明里的破坏性变更逐条不碰插件）、依赖范围无需修改的原因（同 `0.1.5` tuple），以及 rc.1 暴露的一处**开发/CI 环境坑**（`dsh-client-ui-primitives` 把运行时依赖降为 `devDependencies`，重新生成 lockfile 后 `tests/client.spec.ts` 会解析不到 `clsx`）与改进机会清单。

### 新增：卡片显示粒度开关 + 精简 WebUI 面板（`src/config.ts` / `src/settings-api.ts` / `src/index.ts` / `src/feishu-streaming.ts` / `src/client/*`）

- **新配置（均为布尔，默认 `true`，不写即保持现状）**：`showToolCalls`（工具调用总开关）、`showToolArgs`（参数块）、`showToolResults`（结果预览）。连同已有的 `showReasoning`，四个开关分别对应步骤卡上的思考过程、工具段落、`⚙️ 参数`、`📤 结果`。
- **语义**：`showToolCalls=false` 时步骤卡不显示任何工具信息（含标题的工具状态色，回落到普通回复标题）；**只有工具调用、没有文字/思考的步骤不再发卡**（`stepHasVisibleContent` 门控 `queueStepCardSend`/`updateStepCard`，不产生空壳卡）。`showToolArgs`/`showToolResults` 只在 `showToolCalls=true` 时生效，面板上置灰并提示。文字回复不受任何开关影响，始终完整显示（超出 3000 字仍走溢出续卡）。
- **修复隐藏缺陷**：`settings-api.ts` 的 `SETTINGS_KEYS` 之前漏收 `showReasoning`——面板/接口写这个字段会被 `unknown settings field` 拒绝；本次连同三个新键一起补上。
- **斜杠命令**：新增 `/display [reasoning|tools|args|results] [on|off]`——无参列出四个开关状态，带参切换其中一个（接受 `on/off`、`true/false`、`1/0`、`开/关`，以及 `tool`/`arguments`/`result` 等别名）；与 WebUI 面板写同一批配置字段，两处始终一致。`/reasoning show on|off` 保留为 `showReasoning` 的别名。命令走 `executeSlashCommand` 的 conversation-free 分支，**没有 live agent 时也能用**（与 `/reasoning`、`/lang` 同级），并计入 `/help` 的 chatterbox4dsh 分组。
- **WebUI 面板精简重排**（`src/client/LarkSettingsSection.tsx`）：由「应用凭据 / 访问策略 / Agent 配置」改为 **「应用凭据 / 访问策略 / 卡片显示」** 三卡。移除 Provider、Model、Workspace、Agent Preset、失败提示五项（新会话的模型/工作区/预设由 `/new` 流程在建会话时指定，不再用面板做全局默认）；新增「卡片显示」卡承载四个开关与插件语言 `locale`。布尔改用原生 `Switch`，字段带一行说明；工具参数/结果开关在总开关关闭时置灰。面板不再依赖 `connection` / `llm.models`，客户端 `inject` 相应缩减为 `['slots', 'locale']`。
- **对齐说明**：DSH Web UI 自身只有「对话显示 = Normal/Compact」一个粗粒度开关（`ui-chat` 的 `TranscriptViewRow`），没有按 reasoning/工具/参数/结果分级的设置——这四个开关是本插件为飞书卡片做的扩展，非原生能力。
- **验证**：`npm run typecheck` / `npm run test`（281 passed）/ `npm run build`。

### 修复：卡片顺序——溢出续卡与问题卡不再抢在步骤卡前面（`src/feishu-streaming.ts` / `src/index.ts` / `tests/feishu-streaming.spec.ts`）

- **现象**：① 文本超过 3000 字的溢出续卡（`Reply (continued N/M)`）有时排在**更早的步骤卡**前面；② `ask_user_question` 的问题卡比**同一步的步骤卡**先弹出。
- **根因**：所有出站消息都是各发各的，没有任何顺序约束。步骤卡走 CardKit 两步（`cardkit.v1.card.create` → `im.v1.message.create/reply`），首发还要过 `STEP_CARD_DEBOUNCE_MS = 150` 的合并窗口；而问题卡、溢出续卡都走 `im.v1.message.create` 一步就发出。日志实测（`tool/call ask_user_question` → `[q] card sent` → 才出现 `[send] instance card=…`）确认问题卡的消息先于步骤卡创建，飞书按服务端创建时间排序，于是显示反了。溢出续卡同理：`turn/end` 只 `flushPendingSend` 发起了步骤卡，没等它的 `messageId`，续卡就抢先创建。
- **修复**（三条互相配合）：
  1. **每会话（按 chat）串行链** `lastCardSendByChat`：一张步骤卡的消息必须等前一张的消息创建完成后才创建，快步骤连续出卡也不会倒序（`createCardInstance` 仍并行预取，只串行最后的 message create）。
  2. **发卡前屏障**：streaming 通过新的可选 `channel.registerPendingCardFlush()` 注册 `flushPendingSendsForBarrier(chatId)`——把该 chat 还在合并窗口里的步骤卡立即发出，并等到它的消息存在。`index.ts` 的 `cardChannel.send` 在发任何 card/text 前先 `await` 这个屏障；用 `cardSendDepth` 防重入（非 CardKit 兜底路径下步骤卡自身也会走 `send`，不能等自己）。
  3. **溢出续卡显式等待**：`turn/end` 在 `resetStep` 清引用前先捕获 `lastStepSendPromises`，发续卡前 `await`，覆盖没有注册屏障的通道（含测试桩）。
- **验证**：新增 3 例测试（屏障刷出合并窗口内的步骤卡、同 chat 步骤卡消息串行、步骤卡消息未创建前不发续卡）；`npm run typecheck` / `npm run test`（269 passed）/ `npm run build`；重启后真实聊天确认问题卡已排在步骤卡之后。

### 构建：依赖范围与锁文件对齐 DSH 0.1.5（`package.json` / `package-lock.json`）

- `peerDependencies` / `devDependencies` 的 `@deepseek-ai/dsh-*` 由 **`^0.1.3-alpha.1`** 升到 **`^0.1.5-alpha.1`**（锁文件解析到 `0.1.5-alpha.1`）。
- **原因**：semver 的预发布规则下，带预发布标签的范围只匹配**同一 `major.minor.patch`** 的预发布版本——实测 `semver.satisfies('0.1.5-alpha.1', '^0.1.3-alpha.1') === false`。旧范围虽然「看起来」覆盖 0.1.5，实际不匹配，`npm ci` 仍会装到 `0.1.3-alpha.2`。每次 DSH 预发布版本跳跃都必须同步升这个范围。
- 重新生成 `package-lock.json`，`npm ci` 可直接安装（359 个包）。

### 文档：DSH 0.1.3-alpha.2 → 0.1.5-alpha.1 升级评估（`docs/migration-0.1.3-to-0.1.5.md`）

- 新增升级评估文档，记录 563 个 commit 里的关键变更、插件兼容性核验方法、以及唯一的必改项（依赖范围）。

## 0.2.0 (2026-09-08)

> 首个以 `chatterbox4dsh` 名义独立发布的版本（npm `@starxer/chatterbox4dsh@0.1.0` 之后）。要求 DSH `0.1.3-alpha.x`（`assistant/chunk` 已移除，改由 `assistant/message.stream` 重建；不再向前兼容 0.1.2）。
>
> First independent release as `chatterbox4dsh` (after npm `@starxer/chatterbox4dsh@0.1.0`). Requires DSH `0.1.3-alpha.x`; 0.1.2 compatibility was intentionally dropped.

### 构建：依赖范围与锁文件对齐 DSH 0.1.3（`package.json` / `package-lock.json` / `.github/workflows/ci.yml`）

- `peerDependencies` / `devDependencies` 的 `@deepseek-ai/dsh-*` 由 `^0.1.0-rc.5` / `^0.1.0-rc.7` 统一升到 **`^0.1.3-alpha.1`**（锁文件解析到 `0.1.3-alpha.2`），与代码实际要求一致（`assistant/message.stream`、`FileAttachmentRef` / `saveFileStream`）。旧范围会让 CI 与发布流程装到 rc.8，typecheck 直接失败。
- 重新生成 `package-lock.json`，`npm ci` 可直接安装（429 个包）。
- CI 的 `latest-harness` 矩阵不再手动列包 + `--legacy-peer-deps`，改为删掉锁文件后 `npm install` 重新解析声明的范围；旧的 `dsh-host-apiproxy` 已随 DSH 0.1.2-alpha.1 移除。

### 文档：同步全部文档到当前实现，并重写仓库与 npm 包简介（`README.md` / `docs/*` / `TODO.md` / `package.json`）

- **README**：**改为中英文对照**（每个小节先中文后英文，表格与命令表各出一份），修正指向未公开 `AGENTS.md` 的失效链接（改指 `CHANGELOG.md`）；新增「已知问题」小节（步骤卡标题色带在部分客户端不重绘、审批卡结算颜色）；开发节补上「重启会中断运行中的会话」提示。
- **docs/architecture.md**：`harness.ts` 行注明用户文本原样进入模型（无通道前缀，纯图片/文件消息只带 image/file 块）；技术要点新增「标题色带是客户端渲染，插件只保证数据正确」及其取证方法。
- **docs/feishu-capabilities.md**：刷新「dsh-feishu 现状」列（图片/文件收发、`column_set`、`select_static`、`input` 均已使用），功能规划表补状态列，已知限制表补卡片实体 14 天有效期、JSON 2.0 客户端要求、标题色带重绘问题。
- **docs/feishu-setup.md**：权限表对齐 `FEISHU_PROVISION_SCOPES`（补 `im:message.group_msg`、`im:message.reaction`、`application:application:patch`）。
- **TODO.md**：新增本轮完成项（去掉 `[Feishu] ` 前缀、标题色带定性）；**更正过期结论**——原「`im.v1.message.patch` 不更新卡片 header」不成立，实为部分客户端不重绘；合并重复的 `#18` 小节；修正失效链接与文档查法说明。
- **简介**：GitHub 仓库 About 与 `package.json` 的 `description` 重写为更直白的中英文表述。

### 变更：去掉用户消息的 `[Feishu] ` 来源前缀（`src/harness.ts` / `tests/harness.spec.ts`）

- **背景**：每条从飞书进来的用户消息都会被加上 `[Feishu] ` 前缀，本意是让模型/日志能区分消息来自飞书还是 WebUI。实际使用中这个信息几乎用不上，代价却是每条 turn 都被污染：模型上下文与 session log 里都带前缀，纯图片/文件消息还会多出一个只有 `[Feishu] ` 的空文本块。
- **改动**：`reply()` 与 `steer()` 都不再拼前缀，用户文本原样进入模型（通道归属由 session↔chat 绑定记录，回复路由也由插件决定，与文本无关）；纯图片/文件消息的 content 只剩 image/file 块，不再补空文本块。
- **验证**：更新 5 处测试断言（文本原样、纯图片无 text 块、mixed turn、steer/queue 注入）；`npm run typecheck` / `npm run test`（266 passed）/ `npm run build`。

### 文档：同步 README / 架构文档 / TODO 到当前实现（`README.md` / `docs/architecture.md` / `TODO.md`）

- **README**：per-step 卡片行补上「标题带轮次/步骤、reasoning 带耗时与思考 token、footer 两行、快步骤只发一张卡」；Turn Complete 行注明吞吐量口径对齐 Web UI；入站/接收文件从过期的 `.feishu-inbox/` 改为 **DSH 原生附件库**；busy 段落补上「运行中发普通消息先回纯文本提示、steer 不再单独回卡」。
- **docs/architecture.md**：事件流改为 0.1.3 实际路径（`assistant/chunk` 已移除，改由 `assistant/message.stream` 重建），补上「实例更新必须等消息发出」与「首发防抖合并」两条约束；Step 卡片与 Debounce 小节同步当前 footer/定位信息。
- **TODO**：新增本轮修复/优化条目（卡片更新时序、首发合并、tok/s 口径、每卡 tok/s、footer 两行与定位信息、busy 提示去重）；修正 reasoning 截断的过期描述（3000 → 200 字预览）；`#8 文档一致性` 标记 README/架构文档已同步。

### 变更：reasoning 标题去掉两个指标的 emoji（`src/feishu-streaming.ts` / `tests/feishu-streaming.spec.ts`）

- **改动**：reasoning 标题由 `💬 **推理** · 🧠 4.3s · 🪙 1.2K tokens` 改为 `💬 **推理** · 4.3s · 1.2K tokens`（只保留「推理」前的 💬，去掉耗时与 token 两处 emoji）。
- **验证**：同步更新 2 例断言；`npm run typecheck` / `npm run test`（266 passed）/ `npm run build`。

### 变更：reasoning 标题同时显示思考耗时与思考 token 数（`src/feishu-streaming.ts` / `tests/feishu-streaming.spec.ts`）

- **改动**：`StepUsage` 增加 `reasoningTokens`（来自 provider 的 `usage.reasoningTokens`，DeepSeek 适配器由 `completion_tokens_details.reasoning_tokens` 翻译而来）；reasoning 标题拼成 `💬 **推理** · 🧠 4.3s · 🪙 1.2K tokens`，两段各自缺失时自动省略。
- **验证**：改写 2 例测试（`renderStepCard` 直出断言 `🧠 3.2s · 🪙 1.2K tokens`、流式层断言 `🧠 1.0s · 🪙 42 tokens`）；`npm run typecheck` / `npm run test`（266 passed）/ `npm run build`，样张卡已发到真实聊天确认排版。

### 变更：步骤卡显示 reasoning 耗时与轮次/步骤位置（`src/feishu-streaming.ts` / `src/i18n.ts` / `tests/feishu-streaming.spec.ts`）

- **reasoning 耗时**：记录本步第一条/最后一条 reasoning-delta 的时间戳（`assistant/chunk` 与 0.1.3 的 `assistant/message.stream` 重建两条路径都记），思考结束后在 reasoning 标题后追加 `· 🧠 4.3s`；只有一条 delta（时长为 0）时不显示。
- **轮次/步骤**：从 `step/start` 取 DSH 的 1-based `turn` / `step`，拼到卡片标题后面（zh `工具完成 · 第 2 轮 · 第 3 步`，en `Tool Done · Turn 2 · Step 3`）；拿不到时保持原标题。新增 i18n `stepPosition(turn, step)`。
- **验证**：新增 2 例测试（`renderStepCard` 直出断言标题/耗时、流式层 `step/start` + reasoning 流断言卡片带位置与 `🧠 1.0s`）；`npm run typecheck` / `npm run test`（266 passed）/ `npm run build`，并把样张卡发到真实聊天确认排版。

### 变更：步骤卡 footer 改为两行（`src/feishu-streaming.ts` / `tests/feishu-streaming.spec.ts`）

- **改动**：`renderStepCard` 的 footer 由一行拆成两行 notation 文本——第一行 `⏱ 时长 · 📥 计费输入 → 📤 输出`，第二行 `🚀 tok/s · 📊 上下文占比`。缺少某一段时对应行自动省略（只有一行时不补空行）。溢出续卡的 `🚀 tok/s` 与 Turn Complete 卡片不变。
- **验证**：新增 1 例测试（footer 恰好两个 notation 元素、第一行只有耗时/token、第二行只有速度/上下文）；`npm run typecheck` / `npm run test`（264 passed）/ `npm run build`，并把渲染出的样张卡发到真实聊天确认排版。

### 变更：运行中发普通消息给出纯文本提示 + 插话不再回两张卡（`src/harness.ts` / `src/channel.ts` / `src/i18n.ts` / `tests/`）

- **背景**：agent 运行中发**普通消息**（不是 `/steer`、`/queue` 命令）时，消息会被静默插入当前轮或排队，用户没有任何反馈；而且 steer 模式下这条被插入的消息在本轮结束时还会**再发一张回复卡**，与最初启动本轮的那条消息的回复卡重复（两张卡回答同一个 turn）。
- **改动**：
  - `HarnessConversationService.reply()` 新增 `onBusy?: (mode: 'steer' | 'queue') => void`：运行中被 steer 注入或排队时回调一次；channel 层用它发**纯文本**提示（非卡片）——steer：`🎯 已插入当前运行轮…`，queue：`📥 已排队，当前轮结束后执行…`（zh/en 双语，`i18n.ts` 的 `busySteeredNotice` / `busyQueuedNotice`）。`/steer`、`/queue` 命令本身已有各自的文本回执，不传 `onBusy`，不会重复提示。
  - **steer 分支不再等待本轮结束、也不再返回文本**（返回 `undefined`）：被插入的消息由当前轮的回复卡回答，channel 层遇到 `undefined` 直接返回、不发第二张卡。queue 路径仍等待并返回新轮的答复（排队消息是独立的一轮，理应各自有回复）。
- **验证**：新增 4 例测试（steer 注入返回 undefined 且回调 `onBusy('steer')`、queue 回调 `onBusy('queue')` 并仍返回新轮答复、channel 层排队提示是纯文本、steer 消息不发第二张卡）；同步修正 plugin.spec 的 `bridge.reply` 断言（多了 opts 参数）。`npm run typecheck` / `npm run test`（263 passed）/ `npm run build`。

### 变更：每张助手卡片都显示 token 速度（`src/feishu-streaming.ts` / `src/channel.ts` / `tests/`）

- **背景**：步骤卡片的 footer 一直有 `🚀 tok/s`，但「只调工具、没有思考/文本」的步骤因为没有首 token 锚点而缺失（已由上一条修复）；此外溢出续卡与兜底回复卡没有速度行。
- **改动**：
  - 抽出 `computeStepTps(state)`（步骤级 tok/s），步骤卡与溢出续卡共用；
  - **溢出续卡**（`Reply (continued N/M)`，正文超过 3000 字时产生）也带一行 `🚀 N tok/s`；
  - **兜底回复卡**（`renderReplyCards`，仅在流式模块没有发出步骤卡时使用）footer 增加 `tokensPerSecond`，由 `flushed()` 的 turn 统计经新的 `turnTokensPerSecond()` 注入（与 Turn Complete 同一套配对口径）。
- **验证**：用真实会话日志回放了一个 13 步的 turn（含 5 个「只有工具调用」的步骤），**13 张步骤卡全部带 tok/s**；新增 2 例测试（溢出续卡带速度、兜底回复卡 footer 带速度）。`npm run typecheck` / `npm run test`（260 passed）/ `npm run build`。

### 修复：Turn Complete 的 tok/s 被高估（分子分母未配对）（`src/feishu-streaming.ts` / `src/channel.ts` / `src/harness.ts` / `tests/`）

- **现象**：Turn Complete 卡片上的 `🚀 xxx tok/s` 有时明显高于 Web UI（实测某个 13 步的 turn：卡片 620 tok/s，按 Web UI 口径应为 363）。
- **根因（两个叠加）**：
  1. **首 token 锚点漏了 tool-call-delta**：DSH Web UI 的 `isTokenDelta` 把 `text-delta` / `reasoning-delta` / `tool-call-delta`（带 name 或参数增量）都算作「第一个 token」。插件只在流里找 text/reasoning，于是**只调用工具、没有思考/文本的步骤**（本机日志 565 步里有 76 步，占 13%）`firstTokenTime` 一直是 0。
  2. **分子分母不配对**：`totalOutputTokens` 对这些步骤照加，但 `totalDecodeMs` 因没有锚点而不加 → tok/s 被抬高（含工具调用的 turn 最高被抬 2 倍）。
- **修复**：改用 `@deepseek-ai/dsh-llm` 导出的 **`isTokenDelta`** 作为首 token 判定（与 Web UI 同一份实现，含 `assistant/chunk` 与 `assistant/message.stream` 两条路径）；新增 `TurnStats.totalDecodeTokens`，只在**同一批**计入 decode 时间的步骤里累加输出 token；`renderFooterCard` 用 `totalDecodeTokens / totalDecodeMs` 计算 tok/s（与 Web UI `deriveTurnMetrics` 的配对口径一致）。`📤 out` 仍显示全部输出 token，不受影响。
- **验证**：真实会话日志按新口径重算——整体 88 tok/s（原 89），此前偏差最大的 turn 从 620 → 363，与 Web UI 一致。新增 3 例测试：tool-call-only 步骤仍能锚定并计入、无 token delta 的步骤只计 token 不计 tok/s、footer 用配对 token 计算（20 tokens / 0.5s = 40 tok/s，未配对时不出 tok/s 行）。`npm run typecheck` / `npm run test`（258 passed）/ `npm run build`。

### 优化：步骤卡片首发合并（快模型一步一张卡，不再「先发再更新」）（`src/feishu-streaming.ts` / `tests/feishu-streaming.spec.ts`）

- **背景**：快模型下 reasoning → tool/call → tool/result 常常在毫秒内完成。原实现只要第一个事件到达就立刻发卡，随后再更新一次，于是一个本来可以一次成型的步骤也要渲染两次（多发一次卡片实体 + 一次 `cardkit.v1.card.update`）。
- **改动**：新增 `STEP_CARD_DEBOUNCE_MS = 150`，把**首发也纳入同一个防抖窗口**（与更新防抖共用一个常量）。`queueStepCardSend` 在第一个有内容的事件时排一个 150ms 定时器并预留卡片身份（`stepCardSent=true`、`stepCardRef` 仍为空），窗口内到达的事件不再触发更新；定时器到点用**当时累积的完整状态**建卡并发送一次。慢工具不受影响——卡片仍在步骤开始约 150ms 后出现并显示 `⏳ running…`，工具结束时再更新一次。
- **边界处理**：步骤在窗口内就结束（`step/start`）或整轮结束（`turn/end`）时，`resetStep` / turn/end 会 `flushPendingSend` 立即把这张卡发出去（否则会丢卡）；`stop()` 清理未触发的定时器。
- **测试**：新增「快步骤只发一张卡」用例（窗口内 reasoning+call+result → 仅 1 次 create + 1 次 send、0 次 update，且卡片内容已含结果）；原「更新必须等消息发出」用例改为在 send 进行中再产生结果，断言更新被推迟到 send resolve 之后。其余涉及发卡时序的用例相应等过 150ms 窗口。
- **验证**：`npm run typecheck` / `npm run test`（255 passed）/ `npm run build`。

### 修复：步骤卡片的卡片实例更新必须等消息发出（`src/feishu-streaming.ts` / `tests/feishu-streaming.spec.ts`）

- **现象**：部分中间步骤卡片只显示 reasoning（看不出有没有工具调用）；部分卡片的工具行停在 `⏳ running…` 或没有结果。
- **根因（实测确认）**：飞书在**发送引用该卡片实体的消息时对卡片内容做快照**——在消息创建之前调用 `cardkit.v1.card.update` 的更新**不会进入该消息**，消息永远渲染创建时的内容。用 `im.v1.message.list` 的 `card_msg_content_type: 'user_card_content'` 拉回真实渲染内容比对：`[update] seq=1/2` 全部发生在 `[send] message=… via card=…` **之前**的卡片，内容都停在创建那一刻（reasoning-only / 工具 running）；只要有一次更新落在 send 之后，卡片就是正确的 Tool Done + 结果。本机日志里约四成步骤卡片属于前者。
- **修复**：`executeCardUpdate` 的 CardKit 分支在调用 `cardkit.v1.card.update` 前先 `await ref.messageId`（即 `sendCardByReference` 的完成），**所有实例更新都排在消息发出之后**；`sequence` 仍单调递增。消息发送失败（`messageId === undefined`）时跳过更新并打日志。
- **回归测试**：新增 1 例——`sendCardByReference` 挂起时先触发 `tool/call` + `tool/result`，断言 250ms 内**不调用** `updateCardInstance`，resolve 后才调用一次，且更新内容含工具结果（不是创建时的快照）。
- **验证**：`npm run typecheck` / `npm run test`（254 passed）/ `npm run build`。

### 变更：工作区选择也改为可点击行 + 顶部控制按钮窄屏堆叠（`src/feishu-onboarding.ts` / `src/i18n.ts` / `tests/onboarding.spec.ts`）

- **手机端顶部按钮显示不全**：控制行（上一级 / 家目录 / 显示隐藏）用 `column_set` 的 `flex_mode: 'none'`——它是「按比例压缩」，窄屏把三个按钮压到文字被裁。改为 **`flex_mode: 'stretch'`（窄屏变上下堆叠）**，宽屏仍并排；翻页行同款。
- **已有工作区选择改为与目录浏览相同的样式**：每个工作区渲染为一个 **`interactive_container` 可点击行**（无边框、`width: 'fill'`，内容为 `📁 **名字**` + 完整路径，当前工作区带 ✅），**点整行即选中**；删掉 `select_static` 下拉与「✅ 使用这个工作区」提交按钮（先选号再提交的两步操作没了）。新建工作区的输入框 + 创建按钮仍在自己的 form 里（提交按钮必须归属其容器）。
- **兼容**：`parseOnboardingAction` 的 `form_value.workspace` 分支保留——聊天里已发出的旧下拉卡片仍能提交；新增卡片只走 `pick-workspace` 回调。
- **i18n**：删除不再使用的 `onboardingWorkspaceSelectPlaceholder` / `onboardingWorkspaceSelectButton`。
- **验证**：`npm run typecheck` / `npm run test`（253 passed，改写 2 例：工作区是可点击行且带完整路径、长路径不省略；目录浏览断言控制行 `flex_mode: 'stretch'`）/ `npm run build`；工作区选择卡与目录浏览卡各发一张预览到真实话题，`cardkit.v1.card.create` 均 `code=0 success`。

### 变更：目录浏览列表改用 `interactive_container` 整块点击行（`src/feishu-onboarding.ts` / `tests/onboarding.spec.ts`）

- **背景**：上一版把每个目录做成整行按钮，虽然可点，但每行都套一层按钮外观。用户指出飞书有「不是按钮、但可以点击互动」的组件，要求查 SDK 文档。
- **查证**：Card 2.0 的 **`interactive_container`**（整块可点击区域）正是官方给「卡片内的列表项」的组件——`behaviors` 与按钮同款（`callback` / `open_url`），但渲染的是内部子元素（这里放一个 `markdown`），所以**没有按钮外观、整行都能点**，且 `width: 'fill'` 真正撑满。参考：[交互容器 `interactive_container`（larksuite/cli 组件参考）](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/card/components/interactive_container.md)、[配置卡片交互](https://open.feishu.cn/document/feishu-cards/configuring-card-interactions)。
- **改动**：每个目录渲染为一个 `interactive_container`（`width: 'fill'` / `has_border: false` / `padding: '4px 12px'`，子元素 `markdown` 内容 `📁 名字`），`behaviors: [{ type: 'callback', value: { kind: 'browse-enter', value: 绝对路径 } }]`。名字仍**一律不省略**；回调仍走 `parseOnboardingAction` 的 `browse-enter`（按 `action.value` 解析，与元素 tag 无关）。上一级 / 家目录 / 隐藏开关 / 翻页仍是短标签按钮行。
- **验证**：`npm run typecheck` / `npm run test`（253 passed，改写 1 例：条目是 `interactive_container` 且无边框、名字不省略）/ `npm run build`；`cardkit.v1.card.create` 校验 30 项浏览卡 `code=0 success`，并把预览卡发到真实话题（`im.v1.message.reply` + `reply_in_thread`）确认可渲染。

### 变更：目录浏览列表改为可直接点击的整行按钮（`src/feishu-onboarding.ts` / `src/i18n.ts` / `tests/onboarding.spec.ts`）

> ⚠️ 本条的「整行按钮」已被上一条取代——改用 `interactive_container`，保留点击区域但去掉按钮外观。

- **背景**：编号下拉框要「先选号、再点进入」两步，实际操作太绕。用户希望**列表本身就能直接点**。
- **改动**：每个目录渲染成**整行宽按钮**（`width: 'fill'`，文案 `📁 名字`，**名字一律不省略**），点击即进入该目录；删掉 `form` / `select_static` / 「📁 进入这个目录」按钮，以及 `form_value.browse_target` 解析与对应的两个 i18n 键。上一级 / 家目录 / 隐藏开关 / 翻页仍是短标签按钮行（`buttonRow`）。
- **为什么不是「可点击的 markdown 列表」**：卡片没有可点击的列表行组件，markdown 链接只能 `open_url`、无法触发回调；而列内按钮又无法 `width: 'fill'`（这正是之前宫格 / 按宽度分行失败的原因）。所以「可直接点的列表」只能落到**每个条目一个整行按钮**上。
- **验证**：`npm run typecheck` / `npm run test`（253 passed，改写 2 例：每个条目都是整行按钮且名字不省略、点击进入子目录）/ `npm run build`；用 profile 凭据调 `cardkit.v1.card.create` 校验 30 项浏览卡（37 个元素、30 个条目按钮）`code=0 success`。

### 变更：目录浏览也改为编号下拉框（`src/feishu-onboarding.ts` / `src/i18n.ts` / `tests/onboarding.spec.ts`）

> ⚠️ 本条的编号下拉框已被上一条取代——用户反馈「选序号太麻烦」，最终改为**每个目录一个整行按钮**，列表可直接点击。下面这段保留作为取舍记录。

- **背景**：目录浏览器此前把每个子目录渲染成一个按钮，再按标签宽度把它们装进行（`packedRows`）。按钮宽度只能按**内容宽度**给，但飞书**不认列内按钮的 `width: 'fill'`**——按钮永远按自身文字宽度渲染，宽列里多出来的宽度就变成两个按钮之间的空隙（实机表现为 `qwentts.cpp` 与 `R` 相距一大段空白）。同一行要么紧挨着、要么留缝，无法既等宽又贴边，迭代几版都不稳定。
- **改动**：目录浏览器与工作区选择器**统一为同一种交互**——一个编号 `select_static` 下拉框 + 提交按钮：
  - 正文逐行列出 `**1.** 📁 \`目录名\``（30 项一页），**名字一律不省略**；
  - 下拉选项只放**行号**（`1` / `2` …，翻页后编号连续），**绝对路径仍是 option 的 `value`**，选中结果精确；
  - 「📁 进入这个目录」是 form 提交按钮，`parseOnboardingAction` 新增 `form_value.browse_target` 解析（与 `pick-workspace` / `create-workspace` 同一分支）。
  - 上/家目录/隐藏开关、翻页仍是短标签按钮，改用 `buttonRow`（单行 `column_set` + `width: 'auto'` 列）排布；`displayWidth` / `BROWSE_ROW_BUDGET` / `packedRows` / `browseEntryCell` / `plainCell` 全部删除。
- **多语言**：新增 `onboardingBrowseSelectPlaceholder` / `onboardingBrowseEnterButton`（zh/en）。
- **验证**：`npm run typecheck` / `npm run test`（253 passed，改写 1 例、新增 1 例：正文列出全部名字且下拉只含行号与全路径 value、表单提交进入子目录）/ `npm run build`；并用 profile 凭据调 `cardkit.v1.card.create` 校验生成的浏览卡 `code=0 success`。

### 变更：工作区下拉只显示序号 + 目录浏览按内容宽度分行排列（`src/feishu-onboarding.ts` / `tests/onboarding.spec.ts`）

> ⚠️ 本条中「目录浏览按内容宽度分行排列」已被上一条取代——按钮布局无法同时满足等宽与贴边，目录浏览最终也改为编号下拉框。工作区下拉只显示序号的部分仍然有效。

- **长路径在下拉里怎么缩都显示不全**：`select_static` 的选项是**单行且被飞书裁切**，无论截成三级、两级还是一级，目录名一长就只剩省略号。改为**把完整路径移到卡片正文**：
  - 正文按行列出 `**1.** \`/完整/路径\``（当前工作区带 ✅），路径在 markdown 里可换行、**必定完整可读**；
  - 下拉选项只放**行号**（`1` / `2`，当前项 `1 ✅`），**完整路径仍是 option 的 `value`**，选中结果不变；
  - 这与 `ask_user_question` 卡片一贯的做法一致（选项文字放题干、按钮只放序号）。
- **宫格按钮名字被省略得太狠**：等宽三列宫格把每个名字压进 1/3 卡宽，只能 `elideMiddle(…, 12)`，长目录名几乎认不出。**中间试过 `flex_mode: 'flow'`，实测排版炸掉**——飞书把所有列挤在**一行**而不是换行，已回退。
- **最终方案：显式分行 + 按内容宽度分配列宽 + 行尾补空列**（`packedRows`）。按 `displayWidth`（CJK/emoji/全角算 2，其余算 1）估算每个按钮宽度，`BROWSE_ROW_BUDGET = 32` 决定一行放几个等列（由该行**最宽**标签反推），超预算的长名字**独占一行**。每行 `column_set`（`flex_mode: 'none'`，即实测排版正常的写法），`weight = 标签宽度`，**条目名一律不省略**。
  - **行尾补一个占位列**把每行总宽补到 32：否则「短名字恰好独占一行」时会占满整卡宽度，反而显得**比长名字还宽**（用户实测 `R`、`~` 比长目录还宽就是这个问题）。
  - ⚠️ **占位内容必须是「可见」字符（表意空格 `\u3000`）**：先用普通 ASCII 空格时被 markdown 渲染器裁掉、整列被丢弃，短按钮照样被拉伸（实机确认）。
- **实机校验**：用 profile 凭据调飞书 `cardkit.v1.card.create` 验证生成的**工作区选择卡**与**目录浏览卡**，均 `code=0 success`；并检查生成的列结构——控制按钮 1 行 2 列 + 补空、短目录 1 行 4 列 + 补空、`~` 独占 1 行但补了 28 宽的空列（不再撑满）、超长目录独占 1 行。
- **验证**：`npm run typecheck` / `npm run test`（252 passed，改写 2 例：下拉选项只含序号且正文含完整路径、按钮按预算分行且长名字独占一行、名字逐字不省略）/ `npm run build` 全绿。

### 变更：`/new` 工作区选择改为下拉框，只显示最后三级目录（`src/feishu-onboarding.ts` / `src/i18n.ts` / `tests/onboarding.spec.ts`）

- **背景**：工作区越来越多时，工作区卡片按「每个工作区一行 markdown + 一个按钮」渲染，按钮数量随工作区线性增长，卡片越滚越长。
- **改动**：`renderWorkspacePicker` 改为**一个 `select_static` 下拉框 + 「✅ 使用这个工作区」提交按钮**：
  - 下拉项文案只显示**路径最后三级**（更长的路径前缀以 `…` 省略，如 `…/two/three`），**完整路径仍是 option 的 `value`**；当前工作区带 `✅` 并作为默认选中项。
  - 下拉与「🆕 新建工作区」输入框**共用同一个 form**（提交按钮必须归属其容器，卡片只保留一个 form），`parseOnboardingAction` 新增 `pick-workspace` 的 `form_value.workspace` 解析；旧的按钮回调路径保留，聊天里已发出的旧卡片仍可点。
  - **标签自动去重**：两个工作区尾部三级相同（`/a/x/y/z` vs `/b/x/y/z`）时，层级逐级加深直到每个选项唯一（最多到全路径）；单段过长再走 `elideMiddle(48)`，避免下拉行溢出。
  - 「📂 浏览目录…」与「← 取消」按钮不变。
- **验证**：`npm run typecheck` / `npm run test`（251 passed，新增 3 例：下拉标签只留三级且 value 为全路径、表单提交推进到预设步骤、重复尾部自动加深到可区分）/ `npm run build` 全绿。

### 新增：发新卡片时把被替换的旧卡片改写为「已失效」提示（`src/card-supersede.ts` 新增 / `src/feishu-onboarding.ts` / `src/feishu-model-select.ts` / `src/index.ts` / `src/i18n.ts` / `tests/card-supersede.spec.ts` / `tests/onboarding.spec.ts`）

- **背景**：为了绕开「就地更新约 2–3 次后按钮回调失效」的硬上限（见下条），交互卡片流程改成**每一步发一张新卡片**，旧卡片留在聊天里（用户明确不要 recall）。但旧卡片仍显示着看起来能点的按钮，容易误导。
- **实现**：新增 `src/card-supersede.ts`——一个共享的「失效卡」标记器：
  - `renderSupersededCard(t)` 渲染**无按钮**的灰色提示卡（按钮一律不放，避免遗留可点击的旧入口）；
  - `createCardSuperseder({ channel, logger, getTranslations, sequenceByCard })` 按 chat 记住最后发出的卡片，`supersedePrevious(chatId)` 把它改写成提示卡。优先 `cardkit.v1.card.update`（带单调 `sequence`，与调用方共用同一张 `sequenceByCard` 表，避免序号回退被飞书拒绝），通道没有实例方法时回退 `im.v1.message.patch`。**全程 best-effort**：改写失败只 `warn`，绝不影响已经成功的新卡片流程。
  - 改写时机 = **新卡片发出之后**（用户不会看到空窗），顺序为 `send → supersedePrevious(旧卡) → note(新卡)`。
  - 结果/错误卡（`cancel` / `attach` 成功与归档 / 建工作区失败 / 列举失败）标记为 `terminal`，**不进入记忆**，后续流程不会把它们改写成失效提示。
- **接入点**：
  - `feishu-onboarding.ts` 的 `sendCard`：`/new` 工作区卡 → 目录浏览每一步 → 预设卡，每一张都会把上一张改写为失效提示；新增 `supersedePrevious(chatId)` 到 handle。
  - `index.ts` 的 `onModelStep`：模型卡由 `feishu-model-select` 渲染，发完后调用 `onboardingHandle.supersedePrevious(...)` 把预设卡改写为失效提示。
  - `feishu-model-select.ts` 的 `updateCardInstanceOnMessage` 兜底分支：就地更新失败而改发新卡时，把那张旧卡也改写为失效提示。
- **多语言**：新增 `cardSupersededTitle` / `cardSupersededBody`（zh/en 双份，`satisfies` 校验），改写时按**当前 locale** 现读现渲染。
- **验证**：`npm run typecheck` / `npm run test`（248 passed，新增 9 例：失效卡无按钮 + 双语、实例路径单调 sequence、patch 兜底、改写失败只告警、`forget` 不改写、onboarding 连续两次改写、英文文案、terminal 卡不被改写、改写失败不中断流程）/ `npm run build` 全绿。

### 修复：step 卡片丢失工具状态更新 / 只剩 reasoning（`src/feishu-streaming.ts` / `tests/feishu-streaming.spec.ts`）

- **现象**：部分 step 卡片的工具状态停在 `⏳ running…` 不更新；部分卡片只剩 reasoning 内容、工具根本不出现。
- **根因（两处，均导致"这一步的卡片收不到后续更新"）**：
  1. **`assistant/message` 无条件新发一张卡片**。一个 step 里工具调用可能先到（先开卡），assembled message 后到；此时旧代码又发了一张新卡，于是 `state.stepCardRef` 指向新卡，**旧卡再也不会被更新**——它的工具永远停在 running，而新卡只带 reasoning（如果工具事件已过去）。改为：本 step 已有卡片时走 `updateStepCard`，不再新发。
  2. **防抖表按 session state 键**（`Map<SessionStepState, ...>`）。一个 state 对象服务该会话的所有 step，因此下一步骤的更新会**清掉上一步骤尚未触发的 150ms 定时器**——上一步的卡片就此丢掉工具结果。改为**按卡片 ref 键**（`Map<StepCardRef, ...>`），各卡互不干扰；`flushPendingUpdate` 也按 `state.stepCardRef` 查找。
- **诊断日志**：`[send] instance card=…` / `[send] message=…` / `[update] card=… seq=…` / `[update] skipped: …` / `[message] card already sent … → updating`，便于下次直接从 `journalctl` 定位。
- **验证**：`npm run typecheck` / `npm run test`（239 passed，新增 2 例：工具先开卡后 assembled message 只更新不新发、下一步骤不会取消上一步骤的待更新）/ `npm run build` 全绿。

### 修复：目录浏览器翻几页后按钮失效 → 每次导航发新卡片（`src/feishu-onboarding.ts` / `tests/onboarding.spec.ts`）

- **现象**：`/new` 的目录浏览卡翻到若干页后按钮不再响应（"翻不了了"）。
- **根因**：**飞书对同一条消息的卡片就地更新次数有硬上限**——大约 2–3 次之后就停止投递按钮回调。这一点本仓库在 V1 模型选择器里已经踩过并记录（`git show 6d68a9e`：*"after 2-3 `im.v1.message.patch` calls the card's buttons stop responding entirely"*），当时的解法就是**每次导航发一张新卡片**。本轮误以为 CardKit 卡片实例（`cardkit.v1.card.update`）能绕开这个限制（`src/index.ts` 的注释也这么写），实测**同样会失效**。
- **修复**：`feishu-onboarding.ts` 的 `sendCard` 改为**始终新建卡片实例并发送新消息**（不再 `updateCardInstance`），删掉 `cardByMessage`/`sequenceByCard` 两张映射表；`OnboardingChannel` 接口相应收窄到 `onCardAction` / `createCardInstance` / `sendCardByReference`。每页条目数从 12 提到 **30**（每次翻页都是一条新消息，页数越少越好）。另加一行 `browse <kind> → <path> page=N` 日志便于后续排查。
- **注意**：**无按钮的卡片不受影响**——step 卡只做渲染、没有回调，仍可安全地用卡片实例连续更新（本轮的 step 卡迁移保留）。
- **验证**：`npm run typecheck` / `npm run test`（237 passed，新增 1 例：100 项目录翻 4 页，每页都是新卡片且内容正确、末页无「下一页」）/ `npm run build` 全绿。

### 新增：`/new` 工作区卡片支持「📂 浏览目录」（不知道路径也能从飞书选目录）（`src/feishu-onboarding.ts` / `src/i18n.ts` / `src/index.ts` / `tests/onboarding.spec.ts`）

- **背景**：此前 `/new` 只能选已注册的工作区，或**手输绝对路径/`~` 路径**；人不在电脑前、查不到路径时无解。DSH WebUI 有目录浏览器，插件补上对应能力。
- **实现**：工作区卡片新增「📂 浏览目录…」按钮 → 打开可导航的浏览卡（CardKit 卡片实例，**无 `im.v1.message.patch` 的编辑次数上限**）：显示当前目录 + 面包屑路径、⬆️ 上一级、🏠 家目录、👁 显示/隐藏 dot 目录、每页 12 项分页、📁 点目录进入、**✅ 用这个目录**（`workspaceRegistry.create` 注册后直接进入预设选择）。
- **目录来源**：优先用 DSH `ctx.directoryPicker` 的 **`browse` 能力**；但 `directory-picker-auto` 在"看起来有人值守"的主机（loopback 绑定、非 SSH、有显示会话 + zenity/kdialog）会解析为 **`native`**（在主机屏幕上弹 OS 选择框）——对飞书远程用户无用。故 `native` 或服务缺失时**回退到插件自带的只读列举**（`opendir` 一级子目录、名字排序、dot 目录标 hidden、1000 项上限、symlink 仅当其指向目录），与 `browse` 后端同形。**不新增运行时依赖**（`@deepseek-ai/dsh-host-directory-picker` 仅作类型 peer）。
- **注意**：工作区**不能切换**——DSH 只在新建会话时 `attachSession`，已有会话 `header.cwd` 持久不变。所以浏览器只在 `/new` 流程内，不做独立 `/workspace` 切换命令。
- **验证**：`npm run typecheck` / `npm run test`（236 passed，新增 5 例：浏览入口恒在、隐藏目录过滤、下钻/注册/返回、native 后端回退到自带列举、列举失败带具体原因）/ `npm run build` 全绿。

### 修复：step 卡片改用 CardKit 卡片实例，避开 `im.v1.message.patch` 的编辑次数上限（`src/feishu-streaming.ts` / `tests/feishu-streaming.spec.ts`）

- **问题**：per-step 卡片一直用 `updateCard`（= `im.v1.message.patch`）。该接口对同一条消息**有约 20 次编辑上限，超限后静默禁用卡片**（本仓库 `src/index.ts` 早在引入 CardKit 时就记录了这一点，`/model`、`/new` 因此迁到卡片实例）。而 step 卡在一次长 step（多轮工具调用 + 长文字，150ms 防抖合并）里可能远超 20 次更新 → 卡片中途停止刷新。
- **修复**：`feishu-streaming.ts` 的 step 卡改走 **CardKit 卡片实例**——`cardkit.v1.card.create` 拿 `card_id` → 按 `card_id` 发送 → `cardkit.v1.card.update` 带**单调递增 `sequence`** 更新（`StepCardRef` 统一持有 messageId/cardId/sequence）。三个新方法在 `FeishuStreamingChannel` 上为**可选**：通道未提供时自动回退 `send` + `updateCard`（旧行为，测试与无 CardKit 的部署照常工作）。
- **验证**：`npm run typecheck` / `npm run test`（236 passed，新增 2 例：有 CardKit 时走实例且 sequence 递增、无 CardKit 时回退 patch）/ `npm run build` 全绿。

### 修复：step 卡 text 超 3000 字不再截断 → 自动拆分溢出卡发送（`src/feishu-streaming.ts` / `tests/feishu-streaming.spec.ts`）

- **问题**：agent 回复正文（text）在 step 卡里被 `slice(0,3000)+'…(truncated)'` 硬截断，超出部分直接丢弃。而 `renderReplyCards` 的 4000 分卡（`CARD_TEXT_MAX`）只在 `intermediateSent=false` 时才走——正常 agent 回复几乎不走这条路，所以用户看到的截断就是 step 卡的 3000 上限。
- **修复**：step 卡 text 超过 `TEXT_STEP_CAP=3000` 时，首屏只展示前 3000 字（不加 `…(truncated)` 标记），**溢出部分在 `turn/end` flush 完成后自动拆成「Reply (continued N/M)」卡发送**（复用 `chunkText` 按段落分段）。不再丢弃任何内容。reasoning（200 字）和工具 args（2000 字 pretty JSON）预算不变。
- **验证**：`npm run typecheck` / `npm run test`（229 passed，新增 1 例：step 卡 text 3000 字截断无标记）/ `npm run build` 全绿。

### 调整：reasoning 只留预览窗口（200 字）+ 工具调用 args 显示更详细（`src/feishu-streaming.ts` / `src/channel.ts` / `tests/feishu-streaming.spec.ts` / `tests/truncation.spec.ts`）

- **reasoning 截断收紧到 200 字**：用户认为 reasoning 内容应截断、且应留得更少——统一三处 reasoning 预览窗口从 `3000/5000/2000` 收紧为 **`REASONING_CAP = 200`**（`feishu-streaming.ts` `renderStepCard`、`channel.ts` `renderReasoningForReply`/`renderReplyCards`）。reasoning 只是"思考概要"预览，不展示完整思维链。
- **工具调用 args 显示更详细**：原 `summarizeValue(tool.arguments, 200)` 只留 200 字、超出即 `…` 省略。改用新 `formatToolArgs()`：**JSON 参数 pretty-print（2 格缩进，逐 key 一行）**，字符串参数尝试 JSON.parse 再格式化，上限放宽到 **`ARGS_DISPLAY_CAP = 2000`**（超限才 `…`）。读者能看清真实参数（路径/命令/flag），不再是压缩摘要。
- **验证**：`npm run typecheck` / `npm run test`（228 passed，新增 3 例：reasoning 200 字截断 ×2、args pretty 打印不截断）/ `npm run build` 全绿。

### 记录：agent 回复过长被飞书截断 → 需自动分段发送（**调研完成，分段实现待后续**）

- **调研结论**：飞书 text 消息请求体上限 **150 KB**、卡片/富文本 **30 KB**，单个卡片 `markdown` 元素另有 ~10k 字符隐式上限，且**超限时 API 返回 200、静默丢弃溢出内容**。本插件 `renderReplyCards`（`chunkText(text, 4000)`）已分段，但 `feishu-streaming.ts` 的 step 卡 text/reasoning 仍是 `slice(0,3000)+…(truncated)` 硬截断（reasoning 已改 200，text 分段待实现）。详见 TODO.md「飞书消息长度限制调研记录」。

### 整理：飞书文件路径收敛到 DSH 原生附件库（不再向前兼容 alpha.4）（`src/channel.ts` / `src/feishu-receive-file.ts` / `src/index.ts` / `tests/plugin.spec.ts` / `tests/feishu-receive-file.spec.ts`）

- **背景**：插件此前对入站文件维护**两条并行路径**——0.1.3 走原生 `attachments.saveFile`（`FileAttachmentRef` + `fileHostPath`），旧版/无 `saveFile` 回退写工作区 `.feishu-inbox/` 并注入 `[文件: name → path]` 文本。既然插件不再向前兼容 alpha.4（DSH 已是 `0.1.3-alpha.2`，`AttachmentStore` 必有 `saveFileStream`/`fileHostPath`），把文件统一收敛到**一条原生路径**。
- **改动**：
  - `channel.ts`：`AttachmentLike` 改为要求 `saveFileStream` + `fileHostPath`（去掉可选的 `saveFile`）；`FileAdmission` 只剩 `{ fileRef, hostPath?, fileName }`（去掉 `path`）；`admitFilesForMessage` 单路径——下载流经新 `downloadStream()`（`AsyncIterable<Uint8Array>`，背压、不整块进内存）直接喂 `attachments.saveFileStream`；删除 `getFallbackInboxDir`/`resolveInboxDir` 与 `[文件: …]` 文本注入；`startChannel` 移除 `resolveWorkspaceRoot` 参数；文件消息无附件服务时像图片一样明确拒绝。
  - `feishu-receive-file.ts`：依赖改为必填原生 `saveFileStream` + `fileHostPath`，删除 `.feishu-inbox` 写盘与 `resolveWorkspaceRoot`，`downloadStream()` 保留空文件/超 30MB 校验；工具输出 schema 去掉 `workspace` 字段。
  - `index.ts`：`startFeishuReceiveFileTool` 直接传 `attachments`（去掉 `as unknown as` 类型转换与 `resolveWorkspaceRoot` 回调），移除 `startChannel` 的 `resolveWorkspaceRoot` 实参；删除未用的 `AttachmentStore` import。
  - **图片路径不变**（`saveImage`/`imageLimits`/`sniffImageMime` 已对齐原生）。
- **验证**：`npm run typecheck` / `npm run test`（225 passed，含重写的文件用例：流式进入原生 store、干净地附 `{ type:'file', attachment }` 块、无 `.feishu-inbox` 遗留）/ `npm run build` 全绿。

### 迁移：兼容 DSH `0.1.3-alpha.1` → `0.1.3-alpha.2`（**P0/P1/P2 全部已实现，DSH 已升级并验证**）

- DSH 远端最新打 tag 的 release 仍为 `dsh-v0.1.3-alpha.1`（2026-09-04），但 `origin/master` 上已有 `0.1.3-alpha.2` 的 release commit（`e379fa8bdd`）——距本插件基线 `dsh-v0.1.2-alpha.4` 共 **449 个 commit**。完整分析见 **[docs/migration-0.1.2-to-0.1.3.md](./docs/migration-0.1.2-to-0.1.3.md)**。**本条目所有迁移项均已实现**：DSH 已升级到 `0.1.3-alpha.2`（`git switch -d e379fa8bdd`），`npm run typecheck`（含 client）/ `npm run test`（225）/ `npm run build` 全绿，实机 `systemctl --user restart dsh` 后干净启动（无 `error|failed|already registered`，插件加载 + 流式卡片 + 工具调用正常）。
- ✅ **可信度**：迁移文档全部 API 签名已对照 **0.1.3 源码**逐条核实（`git show dsh-v0.1.3-alpha.1` + `e379fa8bdd`），不依赖插件 `node_modules` 里链接的旧版（rc.8 级）类型。

#### 已实现（破坏性）

- 🔴 ✅ **流式渲染（方案 B）**：`assistant/chunk` 从 `session/event` **移除**，改为 `assistant/message.stream`（内嵌 `AssistantStreamRecord[]`）+ 新增 `assistant/attempt` + agent-scoped 实时事件 `agent/assistant-stream`（`start/chunk/end`，经 `follow({assistantStream:true})` opt-in）。**已实现方案 B**（2026-09-08 修正；早期「方案A为主」已作废）：结合源码核对发现**现状本就不是逐 token**——`assistant/chunk` 只做内存累积，`sendStepCard` 只在 `assistant/message`/首个 `tool/call` 边界发整卡，方案 B 贴近现状、近乎零回归。方案 A（`agent/assistant-stream` 逐 delta）是今天不存在的能力，降为可选。`src/feishu-streaming.ts` 在 `assistant/message` 分支用 `@deepseek-ai/dsh-llm` 的 `expandAssistantStream(stream)` 重建 text/reasoning，TTFT 从首个 `TimedStreamChunk.time` 取（有偏差，记为退化点）；保留旧版 chunk 累积作兜底。详见迁移文档 §1。
- 🔴 ✅ **`sessionPersistence`**：`readFrom()/prepare()` 移除，改为 `SessionHandle`（`open(id,'read')+handle.read`，用后 `close()`，否则写句柄泄漏所有权）；`list()` 返回 `SessionPersistenceSnapshot[]`（`.id` → `.header.id`）。`src/harness.ts` 新增 `persistedIdOf()`（归一 `.id`/`.header.id`）与 `readColdSession()`（0.1.3 用 `open(id,'read')+handle.read(0)+close()`，**alpha.2 又把 `handle.read()` 返回从 `ReadonlyArray<Event>` 改成 `{ eventState, events }` envelope**——`readColdSession` 改为 `const result = await handle.read(0); const events = result?.events ?? result` envelope-first / array-fallback 双兼容；旧版回退 `readFrom`）。所有 `list().some(item=>item.id)` → `persistedIdOf`。详见迁移文档 §2。

#### 已适配（兼容）

- ✅ `commands` 的 `input.images` → 声明式 `CommandInputDescriptor.attachments?: boolean`（插件传空数组 `[]`，**核对后零改动**）。
- ✅ `admitPromptContent` 从自由函数变 `ctx.attachments` service 方法（插件未用，不改）。
- ✅ 另确认 `@deepseek-ai/dsh-client-file-upload` 是 **host+client**（非纯浏览器），拒绝 subagent；宿主插件直接调 `attachments` 即可，不需要它。
- ✅ **修 3 个 0.1.3 真实契约**：`AgentLike.session.events` 改可选（0.1.3 `Session` 无 `.events`）、`SessionPersistenceSnapshot` 只有 `.header.id`（无顶层 id）、`todo/write` 宽松匹配（运行时仍发射，但不在 `SessionEventMap` 判别联合里，见 `src/feishu-todos.ts`）。

#### 新特性已实现

- ✅ **通用文件附件**：`ctx.attachments.saveFile/saveFileStream/admitEncodedFile` → `FileAttachmentRef`（`{ attachmentId, name(必填), bytes }`），文件块 `{ type:'file', attachment }`，`fileHostPath` 给绝对路径，`projectFilesToText`/`fileHandleText` 投影 handle 文本（永不 raw 上传 provider）。已替换 `.feishu-inbox` 手工路径（`channel.ts`/`feishu-receive-file.ts`/`harness.ts`：`InboundMessage.fileBlocks`、`dispatchPrompt` 对带文件回退直连），旧版无 `saveFile` 时回退 `.feishu-inbox`；**图片路径（`saveImage`/`imageLimits`）不变**。⚠️ `saveFileStream` 的 `data` 是 `AsyncIterable<Uint8Array>`。
- ✅ `/steer`、`/queue`、普通/带图消息可改走 `sessionController.prompt()`（`mode:'queue'|'steer'`，原生图片 admission）。**已实现（版本无关，已实机验证）**：`src/harness.ts` 新增 `dispatchPrompt`（文本派发改走 `prompt()`，带图/带文件与 `prompt` 不可用时回退直连 `agent.steer/followup`），`src/index.ts` 把 `sessionController` 注入桥接 deps；保留 `whenIdle`/running-guard/`TurnDroppedError` 包装，体感不变。**两处适配器坑已修**（`prompt()` 需真实 `AbortSignal`、且必须作为方法调用保持 `this` 绑定，详见迁移文档 §五）。**复核**：0.1.3 的 `SessionPromptRequest`/`PromptContentPart` 与 alpha.4 一致，升级后无需再改；`PromptContentPart` 里 image 是 `{ mediaType, data: base64 }`（与插件预存的 `ImageAttachmentRef` 类型不匹配），故带图走直连是**类型必然**。

### 修复：消息处理触发 `JavaScript heap out of memory` 崩溃——`reply()` 不再整段快照会话历史（`src/harness.ts` / `tests/harness.spec.ts`）

- **现象**：给某一(些)会话发消息后约几十秒，dsh 进程以 `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory` 崩溃并 core dump（`systemd-coredump`，`status=6/ABRT`），`Restart=on-failure` 自动重启，`/session list` 里的会话还在但当前轮丢失。日志显示崩溃紧随 `[msg]` 之后，堆由低快速涨到默认 ~4GB 上限。
- **根因（两层）**：
  1. **会话历史膨胀**：主会话历史解压后达 ~170MB、约 31 万条事件、约 9000 轮，内含多个 100KB–735KB 的大工具结果块；DSH 每轮都要加载整段历史。
  2. **插件放大器**：`reply()`（steer 与 queue 两条路径，`src/harness.ts` 的 `readSessionEvents`）调用 `session.snapshotEvents()` 时**不带范围参数**——DSH 源码的 `snapshotEvents(fromSeq, toSeqExclusive)` 无参默认 `(0, seq)`，并**缓存一份整段历史的冻结副本**（`eventsSnapshot = Object.freeze([...log])`）。每条消息都这么调，等于在 DSH 自身开销之上再整天复读历史并叠加一份常驻副本，堆被推过 4GB → OOM。而 `summarizeTurn()` 本就 `if (event.seq < firstSeq) continue` 只关心本轮事件，全量快照纯属浪费。
- **修复**：`readSessionEvents(agent, fromSeq?)` 接受可选 `fromSeq`；`snapshotEvents` 存在时传 `fromSeq`（`snapshotEvents(fromSeq)`）只拷贝本轮增量事件，而不是整段 log。`reply()` 两条路径改为 `readSessionEvents(agent, firstSeq)`。`/session list` live 路径仍按需全量（需探测 `turn/start` 与 `agent-preset/selected` 覆盖事件，且该项为用户主动调用、非每消息触发）。
- **验证**：`npm run typecheck` / `npm run test`（225 passed，新增 1 例：`snapshotEvents` 被以 `firstSeq` 调用、而非无参全量）/ `npm run build` 全绿。
- **说明**：此修复消除插件侧的全量快照放大。若会话本身已大到 DSH 核心每轮加载仍易触顶，建议对超大会话执行 **DSH 内置的 `compact` 命令**（`@deepseek-ai/dsh-command-compact`，注册 `/compact` 并调 `compaction.compactNow`）或另开新会话，见 TODO。（本插件**从未注册** `compact` 命令——早期曾做过 `/compact`，但与 DSH 自带的 `command-compact` 重名、启动即 `command "compact" is already registered` 冲突，故已作为 fork 分歧移除，见 AGENTS.md「关键坑」第 1 条；压缩功能始终由 DSH 内置命令提供。）

### 修复：`/session`（含 `/session list`）不再误列 subagent 会话（`src/harness.ts` / `tests/harness.spec.ts`）

- **背景**：`listSessions()` 原样列出 `sessionPersistence.list()` 里的所有会话，subagent 生成的子代理会话也混入 `/session`、`/session list`、`/session N`、onboarding 选择卡，与 WebUI 会话树（只展示非子会话）不一致。
- **改动**：`listSessions()` 对每个持久化会话按 session header 的 `origin === 'subagent'` 过滤并跳过。DSH 的子代理会话在创建时即写 durable header `origin: 'subagent'`（`subagent/child-agent.ts`），故仅凭该字段即可精确判别；**fork 会话只有 `parentSession`、无 `origin`，不受影响仍正常显示**。live 会话在持久化 seam 缺失时回退读 `agent.session.header.origin`。
- **覆盖面**：`/session`、`/session list`、`/session N`、onboarding 选择卡均经 `bridge.listSessions()`，一处过滤即全覆盖。
- **验证**：`npm run typecheck` / `npm run test`（222 passed，新增 2 例：subagent 被过滤、fork 保留）/ `npm run build` 全绿。
- **剩余**：单独查看子代理会话的 `subagent` 命令（数据源 `ctx.subagents.listChildren`，只读）仍待动工，记 TODO。

### 移除：`/stream` 命令及 `showIntermediateMessages` 配置（`src/index.ts` / `src/commands.ts` / `src/commands-i18n.ts` / `src/config.ts` / `tests/*`）

- **背景**：用户决定不再做「流式输出」（stream on 状态），但**保留三段式 per-step 卡片更新机制**（stream off/默认行为不变）。经核查 `showIntermediateMessages` 已是死配置——只在 `/stream` toggle 里被写入，无任何渲染路径读取，统一 per-step 卡片本就始终渲染、与开关无关，故移除安全。
- **改动**：
  - 删除 `commands.ts` 的 `/stream` 命令注册、`FEISHU_OWNED_COMMANDS` 里的 `'stream'`、`renderFeishuCommandsOnly` 里的 `/stream` 条目、`CommandTranslations.streamDescription` 字段。
  - 删除 `commands-i18n.ts` 的 zh/en `streamDescription`。
  - 删除 `index.ts` 的 `/stream` 命令 handler（`executeSlashCommand`）、`toggleStream` 参数、`startChannel` 调用处的 toggle 回调。
  - 删除 `config.ts` 的 `showIntermediateMessages` 字段 / `SettingsConfig` 键 / zod schema / 默认值。
  - 同步清理 `tests/commands.spec.ts`（注册名列表、translations 对象）与 `tests/plugin.spec.ts`（config 载荷）。
- **保留**：`feishu-streaming.ts` 三段式 `renderStepCard`/逐卡更新、`assistant/chunk` 逐 delta 累积、`feishu-toolcalls.ts` 原地更新——默认（stream off）行为完全不变。
- **验证**：`npm run typecheck` / `npm run test`（220 passed）/ `npm run build` 全绿。

### 修复：图片判型按真实字节，不再猜 JPEG（非 JPEG 图片接收失败）（`src/channel.ts` / `tests/plugin.spec.ts`）

- **问题**：用户发送**非 JPEG 图片**（PNG/WebP/GIF 等）时，插件报 `图片处理出错：Declared image type does not match its bytes. (code: IMAGE_TYPE_MISMATCH)` 并被拒收。只碰巧收到 JPEG 图才正常。
- **根因**：`pickImageMime` 对入站 image 资源**无文件名**（飞书 `im.v1.messageResource` 只告诉类型、不给内容 MIME，SDK `convertImage` 产出的资源只有 `{ type: 'image', fileKey }`，无 `fileName`），于是总走到兜底分支**默认猜成 `image/jpeg`**。而 DSH `attachment-local` 的 `saveImage` 会用 `detectImage` 按**真实 magic bytes** 校验"声明 vs 实际"，声明 JPEG 实为 PNG/WebP/GIF 时必然抛 `IMAGE_TYPE_MISMATCH`。
- **修复**：改 `admitImagesForMessage` 为**先下载字节、再从真实字节判型**——新增 `sniffImageMime(bytes)` 按 magic bytes 判出 PNG/JPEG/WebP/GIF（`image/png`：`89 50 4E 47 0D 0A 1A 0A`；`image/jpeg`：`FF D8 FF`；`image/webp`：`RIFF....WEBP`；`image/gif`：`GIF87a`/`GIF89a`），作为 `saveImage` 的 `mediaType`；文件后缀仅作兜底，**不再猜 JPEG**。无需改 DSH 源码（DSH 校验本身正确，是插件此前猜型违约）。
- **验证**：`npm run typecheck` / `npm run test` 全绿（217 passed）；`tests/plugin.spec.ts` 新增 PNG magic 字节 → 推导 `image/png` 用例（正是此前必失败的场景），`fakeChannel` 支持按测试注入下载字节。实机发送 PNG（1920x1080）成功接收，归一化副本标 `image/png`。

### 修复：`feishu_send_file` 发图变成文件、需点开才能预览（`src/feishu-send-file.ts` / `src/channel.ts` / `tests/feishu-send-file.spec.ts`）

- **问题**：agent 用 `feishu_send_file` 发图片给用户时，图片变成**文件消息**（`msg_type: 'file'`），用户要点开才能预览，而不是直接内联显示。
- **根因**：工具**一律**走 `channel.send(chatId, { file: {...} })` → SDK `sendFile` → `msg_type: 'file'`。飞书**内联预览**需要走图片消息：`sendImage` → `msg_type: 'image'` + `content.image_key`（经 `im.v1.image.create`，`image_type: 'message'` 上传）。
- **修复**：读文件字节后，用 `sniffImageMime(bytes)`（从 `channel.ts` 导出的 magic-byte 嗅探）判断是否为**真实图片**。是图且 ≤ 10 MB（飞书图片上传上限）→ 发 `{ image: { source: bytes } }` 内联预览；非图 / 图超 10MB → 仍走 `{ file: { source, fileName } }`（保证能落地）。
- **复用**：`sniffImageMime` / `ImageMediaTypeId` 由 `channel.ts` 导出（入站图片判型同一函数），避免两处重复维护 magic-byte 逻辑。
- **验证**：`npm run typecheck` / `npm run test` 全绿（220 passed）；`tests/feishu-send-file.spec.ts` 新增 PNG 字节→image payload、文本→file payload 用例。实机：agent 通过 `feishu_send_file` 发送 PNG（1920x1080）到飞书，**直接内联显示**、无需点开。

### 修复：入站连接自愈（网络静默分区后飞书消息到不了 DSH）（`src/channel.ts`）

- **问题**：插件入站只走 WebSocket 长连接（`channel.on('message')`），出站 `channel.send` 走 HTTP REST（每条消息新建立连接）。所以遇到**网络静默分区**（TCP half-open——数据包被丢弃、socket 不触发干净 `close`）时：出站仍能发（HTTP 每次新连），但入站死掉，飞书消息再也到不了 DSH。
- **根因**：SDK 的 `LarkChannel` 自带 liveness 看门狗，可在 ping 后 `pingTimeout` 秒内无入站帧时 `terminate()` 死连接 → 触发 `close` → `reConnect()` → `tryConnect()`/`communicate()` **重新挂载入站消息 handler**，实现自愈；但该看门狗**默认 `pingTimeout` 为 0（被禁用）**，静默分区下永远等不到 `close` 事件从而不重连。`autoReconnect`/`reconnectCount: -1` 等虽为默认开启，却因找不到死连接而不触发。
- **修复**：向 `createLarkChannel` 工厂选项传 `wsConfig: { pingTimeout: 60 }`，启用 liveness 看门狗（60 秒无入站帧即终止死 socket 触发重连），恢复入站自愈。`pingInterval` 默认 120s，看门狗只在 ping 后武装、任何入站帧都会取消，健康空闲连接不会被误杀。无需改 DSH 源码。
- **验证**：`npm run typecheck` / `npm run test` 全绿；`tests/plugin.spec.ts` 断言工厂收到 `wsConfig: { pingTimeout: expect.any(Number) }`。

### 改进：入站文件落地到会话工作区的 `.feishu-inbox/`（`src/channel.ts` / `src/index.ts`）

- **问题**：用户发送的普通文件经 `admitFilesForMessage` 下载到**全局** `~/.dsh/feishu-inbox/`（跨会话共享），与"文件属于某个会话工作区"的心智不符；不同会话的文件混在一起。
- **修复**：`startChannel` 新增 `resolveWorkspaceRoot(message)` 回调（`index.ts` 里经 `bridge.getSessionMeta(coords).workspace` 解析该消息所属会话的工作区根），`admitFilesForMessage` 优先把文件写到 **`<workspace>/.feishu-inbox/`**（懒创建）；工作区解析不出时回退全局 `~/.dsh/feishu-inbox/`。注入消息内容的 `[文件: <name> → <path>]` 路径随之指向工作区目录。
- **约束**：**转发块**（`forwarded_messages`）不在归一化消息的 `resources[]` 里（SDK `convertMergeForward` 把子消息展开成文本并恒返回 `resources: []`，内层 file_key 被丢弃），因此转发来的文件**不预下载**——要处理必须额外调飞书子消息/消息列表 API 挖内层 key（需 `im:message` 读权限），本期明确不做。普通用户直接发的文件仍正常预下载。

### 新增：`feishu_receive_file` 收文件工具（`src/feishu-receive-file.ts` / `src/index.ts`）

- **背景**：`feishu_send_file` 是"agent 往飞书 push 文件"的出站侧；入站侧 agent 此前只能依赖插件自动预下载，无法**按需/兜底**直接下载某个飞书文件资源。
- **实现**：注册 host 全局 model tool `feishu_receive_file`（`ctx.tools.register(defineTool(...))`，参数 `message_id` + `file_key` 必填 + `file_name` 可选）。执行时：`exec.agent.id` → `bridge.resolveChat(sessionId)` 反查 chat → `channel.rawClient.im.v1.messageResource.get({ type: 'file' })` 拉字节 → 校验（非空/≤30MB）→ 落到 **`<workspace>/.feishu-inbox/`**（`resolveWorkspaceRoot`，无则回退全局收件箱），返回 `{ file_name, path, workspace }`。
- **约束**：与 `feishu_send_file` 一致，转发块的内层 key 拿不到，故对转发文件同样无解；unbound session 执行期返回明确错误。两条路径共用同一工作区收件箱目录，避免 agent 在"预下载落盘"与"工具拉取"之间迷失。

### 改进：模型输出超长不再截断，按卡片分片发送（`src/channel.ts` / `src/feishu-streaming.ts` / `src/text-chunk.ts`）

- **问题**：模型输出较长时，卡片内容会被**截断**（`renderReplyCard` 直接把整段文本塞进一张卡；`renderStepCard` 对 text/reasoning 超过 3000 字符直接 `…(truncated)`），用户看到答案中断。
- **修复**：新增 `src/text-chunk.ts` 的 `chunkText(text, maxLen, maxChunks)`（默认 `CARD_TEXT_MAX = 4000`，最多 30 张卡，超量折叠成 `···（continued）` 标记）——按空白行分段落打包、避免在 `code fence` 中间切分；`renderReplyCard` 改为 `renderReplyCards`，返回**多张卡**（标题标 `Reply (i/N)`，首卡带 reasoning、末卡带 footer meta），`renderReplyCard` 调用点在 `startChannel` 里**串行发送**。
- **注**：关闭流式（`showIntermediateMessages: false`）时走 `renderReplyCards` 多卡路径。流式 step 卡仍是**单张实时更新**（`updateCard` 按一个 messageId patch），多卡拆分与实时修补的交互复杂，本期未对流式 step 卡做多卡化，维持其 3000 字符截断（流式当前默认关闭）。

### 改进：工作区选择卡片长路径溢出（`src/feishu-onboarding.ts`）

- **问题**：`/new` 的工作区选择把完整路径塞进按钮的 `plain_text`，路径过长时按钮内**无法完整显示路径**（飞书按钮单行截断/溢出），看不清选了哪个工作区。
- **修复**：`renderWorkspacePicker` 对每个工作区渲染**两行**——先渲染**完整路径的 `markdown` 行（可换行、必可读）**，再渲染一个**紧凑选择按钮**（按钮文案 = 工作区名，或超长路径用 `elideMiddle` 头尾省略；完整路径放 `behaviors.value` 供切换，选中不受影响）。避免依赖飞书按钮不支持的 `note` 字段（Card JSON 2.0 无 `note` 标签），保证完整路径始终可见。

### 改进：`/session list` 增加 agent 预设与最近活跃列（`src/harness.ts` / `src/feishu-session.ts` / `src/i18n.ts`）

- **问题**：`/session list` 表格只显示 会话 / ID / 占用 / 最近活跃，看不出每个会话用的是哪个 Agent 预设，不便在多会话间辨识。
- **修复**：`harness.listSessions` 现在为每个会话读取**agent 预设**——从会话 header meta 取 `agentPreset` id，并叠加较晚的 `agent-preset/selected`（空白期切换）事件；再经 `agentPresets.list()` 把 id 解析为**显示名**（名缺省回退 id），未知显示 `-`。「最近活跃」仍取最新事件时间（`updatedAt`，相对时间）。
- **表格**：`| 会话 | ID | 预设 | 占用 | 最近活跃 |`（zh）/ `| Session | ID | Preset | In use | Last active |`（en）。
- 测试：`feishu-session.spec.ts` 更新表头断言并校验预设名/`-` 兜底；`harness.spec.ts` 新增「listSessions 显示 agent 预设显示名」。

### 修复：`/permission` 选「完全权限」后 DSH 识别为 Custom（`src/feishu-permission.ts` / `src/index.ts`）

- **根因**：DSH 的权限 preset 是**双 knob 捆绑**——一个 preset 同时带 sandbox 模式**和** approval 策略（`danger-full-access` 的捆绑是 `sandbox: danger-full-access` + `approval: never`）。旧飞书实现只 `session.append('sandbox/mode', ...)` 写 sandbox 这一个 knob，approval  knob 停留原值（如 `ask`），于是投影 `derive` 找不到匹配项——DSH WebUI 显示 "Current sandbox and approval settings do not match a preset."（即 `custom`）。
- **修复**：切换走 DSH 的 `permissionPresets.set(session, preset)` 写路径——它记录 `permission/preset` 意图并写全 `sandbox/mode` + `approval/policy` 两个 knob。读取当前模式用 `permissionPresets.current(session)`（优先），服务不可用时才回退到单 knob `sandbox/mode` append。
  - `feishu-permission.ts`：新增 `PermissionPresets` 依赖，`onCardAction`/`open` 分别走 `set()`/`current()`。
  - `index.ts`：新增 `ctx.get('permissionPresets')`，卡片路径 `startFeishuPermission` 与带参文本路径 `/permission <mode>` 都改用 `set()`。
  - 卡片按钮配色：三个按钮无一再是 `default`（灰），Read Only / Workspace Write 用 `primary`（蓝）、仅 Full access 用 `danger`（红）；当前模式是**唯一**的 `disabled` + 灰色 + `✓` 按钮，不再与「仅可查看」的灰色混淆，也明确了哪个可点。
- 测试：`feishu-permission.spec.ts` 新增「走 permissionPresets.set() 写路径」「服务缺失时回退 sandbox/mode」「无灰按钮、仅当前 disabled」。

### 修复：步骤卡片工具调用输出不可见（`src/feishu-streaming.ts`）

- **根因**：DSH 0.1.2-alpha.2 的 `ToolResultMessage.content` 是 `[ToolResultBlock]`（`{ type: 'tool-result', toolCallId, content, isError }`），**真实结果内容块嵌套在 `content[0].content`**。旧代码在 `tool/result` 处读 `event.data.message.content`（外层数组），然后按 `type === 'text'` 过滤——外层块的类型是 `tool-result` 而非 `text`，于是 `result.content` 恒为空。而 `renderResultPreview` 依赖的 `card` 词汇（`presentResult` 的 `card:'terminal'/'read'/'diff'` 等）在 alpha.2 **已不存在**（工具把私有 `presentationMeta` 放 `event.data.meta`，无 `card` 字段），所以任何分支都不匹配，最后兜底又因 `content === ''` 而空——结果输出完全消失。
- **修复**：
  - `tool/result` 改读 `message.content[0]`（`ToolResultBlock`），从 `.content` 取真实内容块，`isError` 取 `block.isError`（对齐 Web UI `tool.ts`）。
  - `renderResultPreview` 改为**按真实 meta 形状**分发：grep/glob 的 `shape:'paths'/'matches'`、fs/read 的 `lines:[{number,text}]`、fs/edit 的 `diffs:[{path,oldText,newText}]`；保留 `card` 词汇分支作安全网（一般无渲染文本而走内容兜底）。**每个分支都走 `finish()`**，产出空时兜底渲染原始结果文本（`renderRawCode`，上限 1500 字符），保证结果始终可见。
  - 结果内容提取上限从 300 提升到 1500 字符，避免长 bash 输出被截成不可读。

### 修复：Turn Complete 卡片 token 用量与 Web UI 对不上（`src/channel.ts` / `src/feishu-streaming.ts`）

- **根因**：DSH 的 `TokenUsage.inputTokens` **只算未缓存输入**（缓存输入在 `cacheReadTokens`/`cacheWriteTokens` 单独上报）。旧卡片 `📥 uncachedIn in · 📤 out` 未把缓存读/写计入，且没有「本轮总消耗」项；而 Web UI 的 turn-tail pill 显示的是 **总消耗**（`totalTokens` = 未缓存输入 + 缓存读 + 缓存写 + 输出）。多步 turn 里缓存占比高（尤其 reasoning/长上下文），显式对比时卡片数「明显偏少」。
- **修复**：
  - `StepUsage`/`TurnStats` 增加 `totalTokens`/`totalBilledTokens`（每个 assistant/message 的计费总消耗：有 `usage.totalTokens` 用原始值，否则 = 输入 + 缓存读 + 缓存写 + 输出，即 Web UI 推导口径）。
  - Turn Complete 卡片新增 `📦 总消耗 tokens`（= 计费输入 + 输出，匹配 Web UI 的 "consumed"）；`📥 in` 改用**计费输入**（未缓存 + 缓存读 + 缓存写），`💾 cache%` 分母同步用计费输入。
  - per-step 卡 footer 的 `📥 in → 📤 out` 同样改用计费输入。
- 测试：`channel-footer.spec.ts` 新增「billed total + cache-inclusive input like Web UI」；`feishu-streaming.spec.ts` 新增「no-shape 兜底（真实 bash meta 情形）」「read-shaped」「edit-shaped」渲染用例。

### 修复：工具调用两个代码块无小标题（`src/feishu-streaming.ts` / `src/i18n.ts`）

- **问题**：修好工具输出可见后，每个工具调用会渲染**两个裸 fenced 代码块**（参数 / 结果），都没有标题或注释，看不出哪个是输入、哪个是输出。
- **修复**：给两个代码块加**小标题**（随 `/lang` 双语）：
  - 参数块前加 `stepToolArgsHeader`（`⚙️ 参数` / `⚙️ Args`）。
  - 结果块前加 `stepToolResultHeader`（`📤 结果` / `📤 Result`），仅在结果块有产出时出现，避免空标题。
  - `src/i18n.ts` 的 `Translations` 接口 + `zh`/`en` 两份各加这两个键；`feishu-streaming.ts` 在 fenced 块前 push 标题 markdown 元素。
- 测试：`feishu-streaming.spec.ts` 新增「labels both the args and result code blocks」（校验两个标题都出现、结果标题在输出文本之前），并调整 `codeBlocksOf`（改为按 fence 存在匹配，因标题行在 fence 前）。

### `/session` 切换：一律弹确认 + 释放被离开的旧会话（`src/feishu-session.ts` / `src/harness.ts`）

- **切换一律弹确认**（`feishu-session.ts` `handlePanel`）：原来只有「目标被别的 chat 占用」时才弹「接管/取消」确认卡，目标空闲时点「🔀 切换」直接切到新会话（`attachSession`）。改为**任何切换都先弹确认卡**——切换 = 离开当前会话、改绑到另一个，误触会静默丢掉当前进行中的对话。确认后才 `execOp → attachSession`。
- **释放被离开的旧会话**（`harness.ts` `attachSession` + 新 `releaseSessionForChat`）：切换时 chat 原本绑定一个旧会话 S1，改绑到 S2 后 S1 未被释放，其 agent 仍可能把问题/步骤卡片路由回这个 chat（"原会话的卡片仍推到已切换的飞书"的幽灵）。新增 `releaseSessionForChat(S1, key, S2)`：切换前若该 chat 绑定了不同于目标的会话，则清理它——删除该 chat 的 live handle、落盘，使 S1 不再解析回当前 chat（`resolveChat(S1)`/`sessionOwnerKey(S1)` 均返回 undefined）。注意：不用 `detachSession`（那会把 owner 重置到全新空会话、与改绑冲突），只做「断旧会话→chat 关联」。
- 测试：`harness.spec.ts` 新增「attachSession 改绑并释放旧会话（无幽灵）」；`feishu-session.spec.ts` 的「free 会话切换」改为「free 也先弹确认、确认后才 attach」。

### 中英双语 i18n：`locale` 设置 + `/lang` + 命令/卡片层双语（`src/i18n.ts` 等）

- **语言源**：新增插件 `locale` 字段（`auto`/`zh`/`en`，默认 `auto`）。`auto` 时读 DSH host 侧 `settings.get('locale').preference` 的浏览器语言偏好（由 `@deepseek-ai/dsh-client-locale` 注册的 `'locale'` namespace），无值回退 `zh`。`/lang [zh|en|auto]` 切换并持久化（`auto` unset 字段回到跟随 DSH），`/lang` 无参显示当前与来源。
- **命令层**：把原单一英文实现 `larkCommandTranslations` 拆成 `zh`/`en` 两份（`src/commands-i18n.ts`，`CommandTranslations` 接口不变），模块级 `activeCommandTranslations` 随 locale 同步；`/model` `/reasoning` `/help` `/approve` `/deny` `/approvals` `/new` `/session` `/detach` `/status` 等命令文案即时按语言切换。
- **卡片层**：`feishu-busy` / `feishu-permission` / `feishu-model-select` / `feishu-session` / `feishu-onboarding` / `feishu-questions` / `feishu-streaming`（per-step 卡）/ `channel.ts`（Turn Complete footer）/ `renderStatusCard` 的硬编码文案抽成 `Translations` 字典（`src/i18n.ts` 的 `Translations` 接口 + `zh`/`en` 两份，`satisfies` 类型校验两侧键集一致）。
- **卡片层动态 getter（关键）**：卡片层不是把 `t` 作为启动时**值快照**传给 `start*` 工厂（那样 `/lang` 切换后 `/new`/`/busy`/`/session` 等卡不跟随，实测维持值快照时的语言），而是 `getTranslations: () => Translations` **getter**，每次渲染卡时动态读当前语言。命令层用模块级 `activeCommandTranslations` 同步，`/status`/`/model` 每次调用动态取——三者一致，`/lang` 后新发卡片立即切换语言。
- **术语对齐 DSH**：`Agent 预设` / `会话` / `工作区` / `推理强度` / `工具调用` / 权限 `仅可查看`/`可写入工作区`/`完全权限`；模式短标签（`Queue`/`Steer`，权限枚举值、`Enter while busy`/`Permission` 标题）两种语言均保持英文（对齐 WebUI 固定命名）。
- 测试：`npm run test` 191 通过；`npm run typecheck` 干净；`npm run build` 产出 lib/client。

### 兼容 DSH `0.1.2-alpha.2`（`src/index.ts` / `src/feishu-onboarding.ts`）

- **`settingsNamespace` 从 `@deepseek-ai/dsh-settings` 移除**：alpha.2 删掉了 `settingsNamespace`（连同 `installSettingsSection`/`deepEqualJson`），改成内部 `parseSettingsNamespace`，且 `settings.register()` 新签名**直接接受字面量字符串**（内部校验 kebab-case）。原代码 `settingsNamespace(LARK_SETTINGS_NAMESPACE)` 在 alpha.2 会 `TypeError: settingsNamespace is not a function` 导致起不来。
  - **改法**：`settingsNamespace(LARK_SETTINGS_NAMESPACE)` → `LARK_SETTINGS_NAMESPACE as SettingsNamespace`（`register` 直接收字面量；`as SettingsNamespace` 仅补 alpha.1/alpha.2 都需要的 brand），`import { settingsNamespace }` 改为 `import type { SettingsNamespace }`。
  - **双向兼容**：alpha.1 运行时 `register` 把 namespace 当纯字符串 key（brand 仅编译期），传字面量运行时等价；`as` cast 在构建时被编译掉，所以 `lib/index.js` 对 alpha.1/alpha.2 是同一份。alpha.1 启动验证通过，alpha.2 就绪（待升级后实测）。
- **preset 选择卡显示名 `title` → `name`**（`renderPresetPicker`）：`AgentPreset` 类型从未有 `title`（只有 `name?/id`），原代码 `preset.title ?? preset.id` 一直回退到裸 id。改为 `preset.name ?? preset.id`，吃 alpha.2 的 localized shipped preset names。

### 插件更名：`dsh-feishu` → `chatterbox4dsh`（2026-08-30）

- **背景**：生态里已有 13 个同名 `dsh-feishu` 仓库 + 大量 `dsh-lark*` 变体，命名严重饱和、难区分。为跳出同名簇并突出差异化，改用「唠叨话痨」意象的独立品牌名。
- **改名**：`@starxer/dsh-feishu` → `@starxer/chatterbox4dsh`（npm 包名）；GitHub `Starxer/dsh-feishu` → `Starxer/chatterbox4dsh`（旧链接自动重定向）。
- **命名理由**：`chatterbox`（唠叨话痨）= 把 agent 每一步唠叨给你看（对应 step 级过程透明卖点）；`4dsh`（for dsh）保住 DSH 生态搜索词；`dsh-feishu` 簇彻底隔离。
- **范围**：改 npm 包名 + GitHub repo 名/描述/topics + 文档（README/AGENTS/CHANGELOG）+ 用户可见的 `/help` 分组标题。**插件运行 id `lark-channel` 保持不变**（DSH loader 实际读它，改动风险高）；`/dsh-feishu/settings` 内部路由/日志前缀/CSS 类等内部标识不动（与 web.ts/client 需保持一致）。
- **可发现性兜底**：GitHub topics（`dsh`/`feishu`/`lark`/`deepseek-harness`）+ npm `description` 明确「Feishu/Lark plugin for DSH」。

### 工具调用卡片：args 用代码块防溢出 + 结果兜底展示（`src/feishu-streaming.ts`）

- **args 内联代码块破坏格式/溢出**：原来 `> args: \`${args}\`` 用内联代码，args 含换行/反引号或超长单行时会把卡片 markdown 破坏、内容横向溢出。改为在工具名下方用**独立的 fenced 代码块**渲染 args（` ``` `）——自动换行/滚动，且 `sanitizeCodeblock` 折叠连续反引号、剔除控制字符，避免破坏 fence。
- **工具调用结果不展示**：`renderResultPreview` 里多个分支（terminal / web / search / read / diff / generic）匹配到 `resultView.card` 后**提前 `return`**；若该视图缺关键字段（如 terminal 视图无 `output`），会返回空元素且**不再回退到原始结果**。新增 `finish()` 兜底：任一匹配分支产出空、且有原始结果内容时，改为渲染原始结果的代码块，保证结果始终可见。
- 测试：新增 `renderStepCard` 两项（terminal 视图无 output 时回退原始结果；args 含反引号时落在代码块内）。

本仓库基于 [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark) HEAD（`ee639df`）独立维护，**不再跟踪 upstream 同步**。所有改动仅修改本仓库文件，**未对 DSH 源码做任何改动**。上游 LICENSE（MIT, Copyright (c) 2026 sugarforever）保留以满足 MIT modified-work 声明。

### `/session` 综合会话管理面板 + `/session list` 表格 + `/help` 卡片（`src/feishu-session.ts` / `src/index.ts`）

- **`/session`（无参）→ 交互式管理卡片**：下拉选择会话（按名称）+ 操作按钮【🔀 切换 / 🔓 detach / 🗄️ 归档 / 🍴 fork / ✏️ 改名】+ 「📋 列表」/「🔄 刷新」。复用 `select_static` + form 提交 + `form_value` 读选中会话 id（同 `feishu-model-select.ts` 模式），走共享 `cardChannel.onCardAction`（跨重连自动重绑）。
  - **切换**（飞书插件能力，`bridge.attachSession` 强制接管）：会话被别的对话占用 → 先弹「接管 / 取消」确认卡；空闲 → 直接 attach。
  - **detach**（飞书插件能力，`bridge.detachSession`）、**归档**（DSH `workspaceRegistry.archiveSession`）、**fork**（DSH `sessionController.fork`）——均先弹「确认 / 取消」卡。
  - **改名走独立卡片**：点「✏️ 改名」弹出专门的改名卡（文本输入新标题 + 确认按钮），提交后执行 `sessionController.rename` 并回结果卡——不再在面板底部放输入框。
  - 结果用绿色结果卡回报；`/detach` 命令撤销（并入面板）。
- **`/session list` → 表格卡片**（会话名 / 短 id / 占用锁 / 最近活跃），原「列 session + 按下标切换」的文本列表被此卡片取代；面板内「📋 列表」按钮复用该表格卡。
- **`/session N`**：保留，按下标快速切换，走同 detach+attach 语义（`bridge.attachSession`）。
- **`/help` → 卡片**：原为文本消息（飞书文本不渲染 markdown），改为把分组帮助内容包进卡片 markdown。
- 归属：切换与 detach 是飞书插件（chat→session 所有权），rename/fork/archive 委派 DSH 既有能力（`sessionController`/`workspaceRegistry`；缺失时给「本部署未启用」提示）。

### `/thread` 命令改名为 `/session`（`src/commands.ts` / `src/index.ts` / `tests/*`）

- **变更**：用户侧命令名 `thread` → `session`（列表会话 / 按 index 切换本 chat 到某个 session）。对应注册名、`executeSlashCommand` 直接分发、`FEISHU_OWNED_COMMANDS`、即帮助渲染的静态元数据一并改为 `session`；内部标识（`threadDescription`/`threadUsage`/`threadList*`/`handleThread*` 等）仍保留 `thread` 前缀以免大范围 churn。
- **用户文案**：`Usage: /thread [N]` → `Usage: /session [N]`；列表头 `reply with \`/thread N\`` → `\`/session N\``。`/help`、即列表、`/detach`（引用列表 index）随之更新。
- **无冲突**：DSH 原生命令只有 `goal`/`feedback`/`compact`，无 `session`/`thread`，改名安全。
- 测试：`commands.spec` 的注册名断言、`item.name === 'session'`、`/session` 文案更新。

### 问题选择卡片：结算后保留问题描述（`src/feishu-questions.ts`）

- **症状**：`ask_user_question` 卡片选择选项（或自定义/跳过）后原地更新，更新后的结算卡片**只显示选项、丢了问题描述**。
- **根因**：`renderSettledQuestionCard` 只重渲 header + `question` + 选项，遗漏了原问题卡片会展示的 `AskUserQuestionItem.detail`（随问题一并展示的支持性描述）。
- **修复**：结算卡片在 `question` 之后补上 `detail`（非空才渲染），与 `renderQuestionCard` 对齐。新增回归测试断言结算卡片 markdown 同时含 detail 与 `✅ **<选项>**`。

### Turn Complete 卡片展示 busy 模式（只读）+ 找回中间步骤卡片的工具调用摘要（`src/channel.ts` / `src/feishu-streaming.ts` / `src/index.ts`）

- **Turn Complete footer 只读 busy**：绿色 Turn Complete 卡片底部 footer 区新增一行 `**Enter while busy:** \`queue\` Queue 📥`（或 `steer` … `🎯`），与 `/status` 一致。`ReplyCardMeta` 新增 `busyMode`，由 `index.ts` 的 `replyCardMeta` 生产者注入 `bridge.busyMode(coords)`。**只读、不放按钮**（按用户澄清）。
- **找回工具调用摘要**：中间步骤卡片（per-step 卡）的工具名上方此前应有的一段「说明要做什么的简短文字」丢失了。经查旧 commit（`046e226`/`f89221b`），旧实现是订阅旧 apiproxy **mux 信封**读 `<frame>.view`（`for==='call'` → `presentCall` 的 `callView`；`for==='result'` → `resultView`）。迁移到 DSH `0.1.2-alpha.1` seam（`8e75f02`）后 mux 信封改为直接 `ctx.on('session/event')`——**`resultView` 半块幸存**（现走 `tool/result` 的 `event.data.meta`），**`callView` 半块丢失**：`presentCall` 在当下 DSH 只被定义、从未被发射（`agent-loop`/`session`/`api/*` 均无发射点），故无法直接复活 `frame.view` 钩子。
- **对齐当下 Web UI**：Web UI 已不再依赖 `presentCall`，改为**从调用 `arguments` 推导摘要**（`packages/client/ui-tool/.../tool-call-model.ts` 的 `classifyTool`+`deriveSummary`）。本插件在 `feishu-streaming.ts` 本地复刻这一纯逻辑为 `deriveToolSummary(toolName, argsRaw)`：按工具名分类（bash/pwsh→bash、read/web_fetch→read、web_search/grep/glob→search、write/edit、run_code→code、cordis_* 等），再按 variant 提取 `description`/`command`/`query`/`path` 等、`search` 多 `queries[]` 取各 query 首行 join、未知工具取第一个字符串字段并回退 args 首行、`others` 且非专属标题时前缀 `工具名 · `。`renderStepCard` 的摘要槽位优先级改为 `callView.description ?? callView.title ?? deriveToolSummary(...)`（保留 `callView`/`resultView` 路径，若上游将来恢复 view 则自动生效）。

### 免会话命令修复：重启后不再要求「先发一条消息」＋真正免会话命令直接可用（`src/index.ts` / `src/commands.ts` / `src/harness.ts`）

- **背景**：`executeSlashCommand` 末尾对未特殊处理的命令统一 `resolveAgent`，拿不到 live agent 就报「needs an existing conversation」。而 DSH 重启后，会话在磁盘（persistence）里、但 live agent 未水合，直到下一次消息才被拉起——于是 `/help`、`/model`、`/reasoning`、`/approvals`、`/approve`、`/deny` 等会话级命令在重启后全部误报「需要对话」。
- **修复**：
  - **恢复冷会话**：`bridge` 新增 `resolveAgentOrResume(message)`——有 live agent 直接返回；否则若该 chat 有持久化会话就**懒恢复**（复用 `createAgent` 的 `resume` 分支），此时才返回 agent；完全没有会话才返回 `undefined`。`executeSlashCommand` 的兜底改用该方法，于是所有「本就有会话」的命令重启后立即可用（`/help`、`/model`、`/reasoning`、`/compact` 等）。
  - **真正免会话命令直接拦截**：`/model list`、`/model <route>`、`/reasoning`、`/approvals`、`/approve`、`/deny`、`/help` 属于部署/持久化层，根本不需要 live agent——在 `resolveAgent` 兜底**之前**直接调用对应 handler（用派生 sessionId 构造极简 invocation）。于是它们**连会话都不需要**（全新 chat 也能用）：`/model list` 列目录、`/reasoning` 读写部署默认、`/approvals`/`/approve`/`/deny` 读/结 pending（无则提示）、`/help` 有 agent 列全量、无 agent 列本插件命令（`renderFeishuCommandsOnly`）。
  - **保持需会话**：`/steer`、`/permission`（落点在 DSH 会话日志）、DSH 原生（`compact`/`goal` 等）仍需会话，兜底未命中时清晰提示；但因为有 `resolveAgentOrResume`，已有持久化会话时它们重启后也能用。
- **实现**：`commands.ts` 导出 `handleHelpCommand`/`handleModelCommand`/`handleReasoningCommand`/`handleApprovalCommand`/`handleListApprovalsCommand`（+`LlmDirectoryLike`/`SessionControllerLike`/`FEISHU_OWNED_COMMANDS`/`FEISHU_INTERCEPTED_COMMANDS`/`renderFeishuCommandsOnly`）；`index.ts` 在 `apply()` 提升 `approvalControl`/`showReasoningControl` 供命令运行时与免会话拦截共用。新增 harness `resolveAgentOrResume` 单测（live/冷会话恢复/无会话三态）。

### `/help` 命令分类：dsh-feishu 插件 / DSH 内置（`src/commands.ts` / `src/index.ts`）

- **背景**：`/help` 原先把 `commands.list()` 的所有命令平铺列出，无法区分哪些来自本插件、哪些是 DSH（或其它插件）自带的。
- **实现**：`handleHelpCommand` 改为分两组渲染：
  - **🔹 dsh-feishu 插件：**按 `FEISHU_OWNED_COMMANDS` 名称集合从 `commands.list()` 中挑出本插件注册的命令。
  - **💠 DSH 内置：**其余（如 `compact`/`goal`/`export`/`feedback` 等 DSH 原生命令）。
  - **补充被拦截的命令**：`busy`/`steer`/`queue`/`permission`/`stop` 是在 `executeSlashCommand` 里直接拦截处理的（不注册、不在 `commands.list()` 里），此前从不出现在 `/help`；现在用 `FEISHU_INTERCEPTED_COMMANDS`（含描述/输入提示）把它们补进 Feishu 组，并对命令 runtime 列出的 Feishu 命令去重（registered 优先）。
  - 组内按名称排序；两组都无条目时才回 `helpEmpty`。翻译新增 `helpFeishuHeader` / `helpNativeHeader`（替换原 `helpHeader`）。

### 移除「Node SDK 过滤 `MessageType.CARD`」补丁（经对照实验证伪）（`package.json` / `scripts/patch-sdk-card-action.sh`）

- **背景**：早期为解决飞书卡片回调，往 `@larksuiteoapi/node-sdk` 打了一个 `postinstall` sed 补丁（`patch-sdk-card-action.sh`），把 WS `handleEventData` 的过滤从 `type !== MessageType.event` 改成也放行 `type === MessageType.card`。
- **纠错**：该补丁的判断（卡片回调以 `type='card'` 到达会被丢弃）**经对照实验证伪**。还原 pristine SDK（`type !== MessageType.event`）后重启，`card.action.trigger` 仍以 `type='event'`（带 `event_type`）到达插件，`/busy`、`/permission`、`/model` 卡片点选全部正常——**帧过滤并不拦它**。真正导致卡片点选无反应的是 `action.value` 双编码解析问题（见下方 `decodeCardValue` 修复）。
- **处置**：删除 `scripts/patch-sdk-card-action.sh`、移除 `package.json` 的 `postinstall`，SDK 还原为官方原版 `1.73.0`（不再改动 gitignored 的 node_modules）。对应 issue（`larksuite/node-sdk` #98/#156/#128/#64）均为「事件名类型缺失」用泛型注册可绕过，未涉及帧过滤。
- **版本**：`@larksuiteoapi/node-sdk` 保持 `^1.73.0`（最新版仍是 1.73.0）。

### `action.value` 双编码修复：`/permission`、`/busy` 卡片点选无反应（`src/card-action.ts` / `src/feishu-permission.ts` / `src/feishu-busy.ts`）

- **症状**：`/permission` 与 `/busy` 的交互式选择卡片，点击按钮**没有任何反应**（卡片不刷新、模式不切换）。
- **根因**：飞书按钮 `action.value` 是**双重编码**的——真实 payload 先 `JSON.stringify`，再作为 JSON 字符串包一层（实测 `value` 形如 `"{\"p\":\"busy\",\"mode\":\"steer\"}"`）。busy/permission 只 `JSON.parse` 一次得到的是字符串，`parsed.p !== 'busy'` 恒成立 → 处理器直接返回。web 端的 model-select 处理器用**多层 parse 循环**已处理此情况，故它正常工作。
- **修复**：新增 `src/card-action.ts` 的 `decodeCardValue(value)`——解包为对象（多层 `JSON.parse`，深度上限 4），在 `feishu-busy.ts` 与 `feishu-permission.ts` 的 `onCardAction` 中统一使用。`decodeCardValue` 导出以便单测（含双编码、更深嵌套、非 JSON 等用例）。

### `/busy` 交互式选择卡片 + `/queue` 命令（`src/feishu-busy.ts` / `src/index.ts` / `src/harness.ts`）

- **`/busy` 卡片**：`/busy` 无参原本只回文本列出 Queue/Steer 选项。新增 `feishu-busy.ts`（仿 `feishu-permission.ts`），复用共享 `cardChannel.onCardAction` 多订阅者 + 跨重连自动重绑。无参改为发送 **交互式卡片**（header "Enter while busy"，turquoise）：body 展示当前模式（`✓` + `disabled`），下方两个按钮 `Queue · 当前轮结束后作为新轮运行（默认）` / `Steer · 注入当前运行轮立即响应`。点击按钮 → `bridge.setBusyMode(chat, mode)` 持久化 → `updateCard` 原地刷新重新标记。`/busy queue|steer` 文本快捷路径保留。`renderBusyCard` 导出以便单测。
- **`/queue <内容>` 命令**：`/steer` 的共轭——即使聊天处于 steer 模式，也**强制走 queue 路径**（等当前 turn 结束、作为新一轮运行），而不是注入当前轮。`bridge.reply` 新增 `opts.forceQueue`（默认为按 chat busy 模式），`/queue` 传 `{ forceQueue: true }`。命令**立即回执**（`📥 已把消息排队为该聊天下一轮运行：\`<内容>\`...`），实际排队在后台进行（`bridge.reply` 内部本就等 idle 后 followup）；排队结果的输出仍经 per-step 流式卡片渲染。排队期间 `/stop` 会递增代际 → `TurnDroppedError`（静默丢弃，不视为失败）。`/queue` 内容为空返回用法报错。**模式已匹配时短接**：若聊天已在 queue 模式，`/queue` 是冗余（普通消息本就排队）——不再实际提交，返回提示「已在 queue 模式，直接发消息即可」「想注入用 `/steer` 或 `/busy steer`」。
- **`/steer` 模式已匹配短接**：若聊天已在 steer 模式，`/steer` 是冗余（普通消息本就注入）——不再实际提交，返回提示「已在 steer 模式，直接发消息即会注入」「想排队用 `/queue` 或 `/busy queue`」。其他情况（queue 模式下用 `/steer` 强制注入）仍在成功时立即回执 `🎯 已注入运行中的 turn：...`。

### `/steer` 立即回执反馈（`src/index.ts`）

- **症状**：`/steer <内容>` 注入运行中 turn 成功后原来返回 `{ kind: 'consumed' }`，飞书端**没有任何反馈**——只有被注入内容经 per-step 卡片流式渲染才算有反应，用户难以确认 `/steer` 是否被接收、注入的是什么。
- **修复**：`/steer` 成功改返回 `{ kind: 'success', text }`，立即回执一条确认消息：`🎯 已注入运行中的 turn：\`<内容>\`\n\nAgent 会把它作为下一步指令继续执行。若想中止，发送 \`/stop\`。`；失败仍返回带原因的报错文本。`bridge.steer` 仍不 `whenIdle`（注入即返回），回执与后续 per-step 流式卡片互不冲突，不会重复回执卡片。

### 权限模式选择（`/permission`，对齐 WebUI）+ `/status` 显示权限模式（`src/index.ts`）

- **背景**：DSH Web UI 用 `ui-permission-presets` 插件把这个能力命名为 **Permission（权限）**，命令是 **`/permission <预设>`**，预设显示名 `Read Only` / `Workspace Write` / `Full access`（`danger-full-access` 的产物文案）。最初我用 `/sandbox` 命名，与 Web UI 不一致。
- **实现**：
  - 命令改为 **`/permission [模式]`**（保留 `/sandbox` 作为隐藏别名）：无参时展示当前**有效模式**（`sandboxPolicy.resolve({ session }).mode`，优先级 = 显式授权 grant > 会话 `sandbox/mode` 事件 > 部署默认）与可选模式列表（显示名对齐 WebUI：`Read Only` / `Workspace Write` / `Full access`）；带参时切换（复用 DSH `setSandboxMode` 的写路径——向会话日志追加一条 **log-only** `sandbox/mode` 事件，下一次受限调用 bash/fs 即生效）。
  - 模式词表 `SANDBOX_MODES` 与 `PERMISSION_LABELS`（kebab→title，`danger-full-access`→`Full access`）在插件内定义；`dsh-sandbox-policy` 未作为插件依赖（node_modules 无此包），故不 import，改用 `ctx.get('sandboxPolicy')` 服务 + 直接 `session.append('sandbox/mode', { mode })` 复刻写路径。
  - `/status` 卡片新增 `**Permission:** \`<mode>\` <Label>（如 \`workspace-write\` Workspace Write ✍️）` 行。

### `/permission` 交互式选择卡片（`src/feishu-permission.ts` / `src/index.ts`）

- **背景**：`/permission` 无参时原来是纯文本列出当前模式与选项，无法像 WebUI 的 picker 那样点选切换。
- **实现**：新增 `feishu-permission.ts`，复用 shared `cardChannel.onCardAction`（多订阅者、跨重连自动重绑，见 `index.ts` 的 `cardActionHandlers` Set）。`/permission` 无参改为发送 **交互式卡片**：header "Permission"（turquoise），body 展示当前模式（`✓` 标记、active 按钮 `disabled`），下方三个按钮 `Read Only`（default）/ `Workspace Write`（primary）/ `Full access`（danger）。点击按钮 → 解析 `{ p: 'permission', mode }` → `session.append('sandbox/mode', { mode })` 切换 → `updateCard` 原地刷新、重新标记当前项。`/permission <模式>` 文本路径保留（对齐 WebUI 直接打 `/permission <预设>` 的直接切换）。`renderPermissionCard` 导出以便单测（4 用例：当前模式/标记/类型、点击切换、忽略无关action/未知卡片）。

### 审批卡片：按钮顺序 + 显示原因（`src/feishu-approvals.ts`）

- **症状**：审批卡片上「Reject」按钮排在「Approve once」上方（违反确认在前、危险在后的惯例）；卡面只有 Tool 名和 id，没有展示审批原因，用户不知道工具要做什么。
- **修复**：`renderApprovalCard` 按钮改为「Approve once（primary）」在上、「Reject（danger）」在下；卡面新增 `**Reason:** <request.reason>` 一行（`ApprovalRequest.reason` 为空时省略该行）。`PendingApproval` 增加 `reason` 字段，仅在存在时注入（`exactOptionalPropertyTypes`）。`renderApprovalCard` 导出以便单测。

### `/steer <内容>` 运行中注入（`src/harness.ts` / `src/index.ts`）

- **背景**：DSH 消息队列有 `queue`（排入 `next-turn`，当前 turn 结束后开新轮）与 `steer`（注入 `next-step`，**当前进行中的 turn** 在下一步边界立即消费）两种模式。飞书 bridge 恒走 `agent.followup`（queue），所以运行中发消息永远排队成新轮，无法像 WebUI 那样在中途注入。
- **实现**：
  - `HarnessConversationService.steer(message)`（`harness.ts`）：解析已有 agent（不创建），校验 `agent.status === 'running'`，构造带 `[Feishu] ` 标记的用户消息并调 `agent.steer(...)`，立即返回（不 `whenIdle`，注入由运行中的 turn 消费，step 卡片经 feishu-streaming 渲染）。
  - 新增 `/steer <内容>` 斜杠命令（`index.ts`）：取 `parsed.rawInput` 作为注入内容；成功返回 `{ kind: 'consumed' }`（避免多余回执卡片），失败（无会话 / 未运行 / 内容为空）返回带原因的错误文本。
- **注意**：`/steer` 是显式 opt-in。运行中直接发**普通消息仍走 queue**（对齐 WebUI 默认行为）；只有 `/steer` 才注入当前 turn。

### `/stop` 丢弃排队消息，对齐 WebUI 停止语义（`src/index.ts`）

- **症状**：agent 运行中从飞书又发了一条新消息（进入 agent inbox 排队），此时 `/stop` 只终止了当前循环，排队的新消息又立即开启新一轮循环；而 WebUI 的停止按钮会终止所有运行（包括队列里的）。两者体验不一致。
- **根因**：`sessionController.cancel({ sessionId })` 内部硬编码 `agent.cancel({ kind: 'user' }, { keepInbox: true })`——只中止当前 turn、**保留 inbox**。于是被中止后，排队消息被兑现，重启一轮。
- **修复**：`/stop` 改为直接取 live agent（`agents.get(sessionId)`）并调用 `agent.cancel({ kind: 'user' }, { keepInbox: false })`——同时**清空 pending inbox**（丢弃排队消息）并中止当前 turn，对齐 WebUI 停止按钮。无 live agent 时返回「该 session 当前没有运行中的 agent，无需停止。」。插件新增注入 `agents`（host `AgentRegistry`）并透传给 `executeSlashCommand`。
- **⚠️ 已知限制（未完全生效）**：agent 运行中你从飞书发新消息时，该消息**不在 agent inbox 里**——`bridge.reply`（`harness.ts`）先 `await agent.whenIdle()` 等当前 turn 结束，**之后**才 `agent.followup(...)` 入队。所以 `/stop` 的 `keepInbox:false` 清空的是（当时为空的）inbox；当前 turn 被中止后 `whenIdle()` 立即 resolve，等待中的 `bridge.reply` 继续 followup 该消息 → **仍会开启新 turn**。这与 WebUI（prompt RPC 立即 `agent.followup` 入队，故 `keepInbox:false` 能丢弃）的路径不同。**根因在 Feishu 的"先等 idle 再入队"延迟提交，而非 `keepInbox`。** 彻底修法是在 `/stop` 时给会话标记一次停止代际（generation），`bridge.reply` 在 `whenIdle` 后若检测到代际变化则丢弃该消息不 followup。**→ 已由下方「busy 消息行为持久化 + /stop 真正丢弃排队消息」实现解决。**

### 术语对齐 WebUI + 修复 latest-harness CI typecheck（`src/index.ts`）

- **术语对齐**：把 `/status` 的 `Queue mode:` 改为 **`Enter while busy:`**（WebUI `ui-conversation` 设置名「Enter behavior while busy」），值显示为 `Queue` / `Steer`（WebUI 选项文案）；`/busy` 无参/切换文案也改用「运行中（busy）的 Enter 行为」「排队发送 / 插话发送」的说法。命令 `/busy` 与机器值 `queue`/`steer` 保持（与 DSH 内部 `busyEnter`/`BusyEnterBehavior` 概念一致）。
- **CI 修复**：`ci.yml` 的 **latest-harness** 矩阵在 typecheck 报 `'credentials/updated'` 不属于 `keyof Events`——新 Harness 把凭据变更事件从 `credentials/updated` 改名为 **`credentials/reference-updated`**。插件改为用宽松 cast 同时注册两个事件名（`ctx.on` 对不存在的事件只是永不触发，无副作用），typecheck 在 locked(rc.7)/latest 两个矩阵都通过，且 latest 下凭据变更触发 reconcile 的功能恢复（之前静默失效）。

### `/status` 显示队列模式（`src/index.ts`）

- **背景**：`/status` 已显示权限模式，但看不到当前 busy（队列）行为。用户在飞书切了 `/busy queue|steer` 后想在 `/status` 一眼确认。
- **实现**：`/status` 解析 `bridge.busyMode(chatMessage)`，卡片新增 `**Queue mode:** \`queue\` 📥 / \`steer\` 🎯 行。

### busy 消息行为（`queue`/`steer`）持久化 + `/stop` 真正丢弃排队消息（`src/harness.ts` / `src/channel.ts` / `src/index.ts`）

- **背景**：上一节把 `/stop` 记为了"丢弃排队消息未完全生效"的已知限制，根因是飞书 `bridge.reply` 先 `await whenIdle()` 再 `followup`，消息在等待期间不在 inbox，`keepInbox:false` 清不掉。同时用户希望能在飞书把"运行中发消息"的行为切为 **steer（注入当前 turn）** 并持久化，而非总是排队。
- **实现**：
  - **持久化 per-chat busy 模式**：`HarnessConversationService` 新增 `chatToBusyMode: Map<chatKey, 'queue'|'steer'>`（默认 `queue`），随 `chatToSession` 一起存进 `lark-session-map.json`（`saveSessionMap`/`loadSessionMap` 读写 `busyMode` 字段），重启后保留。方法：`busyMode(message)` 查询、`setBusyMode(message, mode)` 设置并持久化。
  - **`bridge.reply` 按模式分支**：`busyMode==='steer'` 且 agent 运行中 → 立即 `agent.steer(msg)` 注入当前 turn，`whenIdle` 等运行轮（含 steered step）结束再汇总；否则走 queue 路径（先等 idle 再 followup）。
  - **`/stop` 真正丢弃排队消息**：`stopSession(message)` 先把该 chat 的**停止代际+1**，再 `agent.cancel({kind:'user'},{keepInbox:false})`。`bridge.reply` 的 queue 路径在 `await whenIdle()` 后检查代际——若 `/stop` 在等待期间发生则丢消息、抛 `TurnDroppedError`（不再 followup 开新 turn）。channel 对 `TurnDroppedError` 静默丢弃（不报错卡片）。**`/stop` 已知限制已解决。**
  - **新增 `/busy [queue|steer]` 命令**（`index.ts`）：无参显示当前 busy 行为，带参切换并持久化；一次性注入仍用 `/steer <内容>`。

### `/stop` 命令报 "no code" 修复（`src/index.ts`）

- **症状**：执行 `/stop` 恒失败，飞书回 `⚠️ 停止失败: unknown error (no code)`。
- **根因**：`sessionController.cancel` 成功时返回 `{ accepted: true }`，失败路径**直接 throw**（`TypertRemoteFailure`，如 `session-not-found`），而非旧 apiproxy `sessions.cancel` 那种 `{ ok: boolean; error: { code, message } }` 包。插件却按 `{ ok, error }` 解析——`response.ok` 恒为 `undefined`（真值判断为 false），于是永远落进错误分支，`response.error?.code` 也是 `undefined`，拼出 `(no code)`。
- **修复**：改为检查 `response.accepted === true` 判成功；失败改由 `catch` 捕获，`session-not-found` 单独映射为"该 session 当前没有运行中的 agent，无需停止"，其余用 `errorText(error, ...)` 带出具体原因与错误码（复用上一条改动）。

### 报错消息带具体原因/错误码（`src/error-text.ts` / `src/channel.ts` / `src/feishu-send-file.ts`）

- **症状**：插件任何环节出错（agent turn 失败、图片拉取失败、斜杠命令执行失败、发文件失败）都在飞书回一条**统一道歉文案** `errorMessage`（"抱歉，处理这条消息时遇到了问题，请稍后重试。"），用户不知道到底哪里出了问题。
- **修复**：
  - 新增 `src/error-text.ts` 的 `errorText(error, fallback)`：提取 `error.message`（非 Error 则 `String(error)`），错误带数字 `code` 时追加 `(code: N)`（并去重——消息里已含 code 就不再重复），无可用信息时回退 `fallback`，超 600 字符截断。
  - `src/channel.ts` 的 4 处统一道歉改为带前缀的具体原因：`命令执行出错：<原因>`、`图片处理出错：<原因>`、`处理这条消息时出错：<原因>`（×2，覆盖 agent turn 失败与 dispatch 同步失败）。`errorMessage` 仅作为确实无原因时的兜底。
  - `src/feishu-send-file.ts` 的 caption 与文件 `ch.send` 包上 `.catch` 重抛：`Failed to send "<file>" via Feishu: <原因> (code: N)`，让飞书 API 错误码（如 230021 超过大小上限）直接透传给 agent 汇报。

### 问题/审批卡片不显示修复（`src/feishu-questions.ts` / `src/feishu-approvals.ts`）

- **症状**：模型调 `ask_user_question` 时飞书侧收不到问题卡片，agent 一直等到信号中断返回「ASK_ABORTED」（approval 卡片同理）。
- **根因**：0.1.2-alpha.1 的 `user-questions/request` / `approval/request` 是 **agent-scoped waterfall**。`api-remotes`（WebUI BFF）在 boot 时对这两个事件也注册了 waterfall listener，且是**先注册**（最外层）。它在 `forwardWaterfall` 里把请求推给 WebUI 客户端并**阻塞等待 WebUI 回答**；飞书 listener 是**后注册**（内层），只有当外层调用 `next()` 时才会执行——而 WebUI 一直没回答，`next()` 从未被调用，飞书 listener 永远到不了，卡片自然不渲染。旧 apiproxy mux 是**并行广播**（WebUI 与飞书同时收到、先答先赢），迁移成 waterfall 后变成顺序链路，飞书被卡在 WebUI 之后。
- **修复**：飞书 listener 改用 `ctx.on(event, handler, { prepend: true })` 注册，成为 waterfall **最外层**，先于 `api-remotes` 认领。`handleRequest` 只在 session 绑定到当前飞书 chat 时才认领（`resolveChat` 命中）；未绑定的 session 照常 `next()` 回退给 WebUI answerer，两个 UI 按实际使用入口各司其职。

### `ask_user_question` 多问题顺序迭代（`src/feishu-questions.ts`）

- **症状**：一次 `ask_user_question` 传多个问题时，飞书只渲染并回答了**第一个**问题，其余被静默丢弃（返回答案只含第 1 问）。
- **根因**：`presentQuestions` 写死了 `const question = questions[0]!`，答完第一问就返回整个批次，注释声称"iterates sequentially"但实现从未迭代。
- **修复**：`presentQuestions` 改为**逐个问题顺序渲染**——答完一题自动出下一题卡片，跳过也产出空选择项，最终返回 `{ answers: [q1, q2, ...] }` 整批答案（与 WebUI 的整批编码对齐）。请求中止或卡片发送失败时中断并返回已累积部分。
- **调试**：`[q]` 系列日志从 `logger.info`（被 DSH 日志级别过滤、journal 看不到）改为 `console.log`（直出 stdout/journal），便于验证渲染路径。

### 文件接收（`src/channel.ts`）

- **收文件**：飞书聊天发送文件（`msg_type: 'file'`，标准化后资源 `type === 'file'`）时，插件通过 `im.v1.messageResource.get({ params: { type: 'file' }, path: { message_id, file_key } })` 下载文件字节，并写入 `~/.dsh/feishu-inbox/`（`DSH_HOME`）下的持久目录。
- **注入消息内容**：下载成功后，把 `[文件: <fileName> → <absPath>]` 追加进 `inboundMessage.content`，让 agent 能通过文件工具读取该路径。下载失败仅记日志、不阻断消息（agent 仍收到原始 `<file .../>` 标签）。
- **为什么不用 `/tmp`**：channel service 与 agent 工具沙箱的 `/tmp` 是隔离的 mount，插件写入 `/tmp` 的文件 agent 读不到；`~/.dsh/feishu-inbox`（`DSH_HOME`）是真实磁盘目录，两侧都能访问。下载目录懒创建。
- **依赖**：新增 `node:fs/promises`（`mkdir`/`writeFile`）、`node:os`（`homedir`）。

### agent 主动发文件工具 `feishu_send_file`（`src/feishu-send-file.ts`）

- **背景**：DSH 本身没有"agent 往客户端 push 二进制文件"的原语——agent 只是把文件写进工作区，WebUI 靠 `ui-deliverables` 自动检测 `write`/`edit`/`str_replace_editor` 产出并渲染成可点击链接；飞书此前没有等价物，agent 写的产物文件在飞书侧只能靠回复文本里的路径让用户自己去翻。
- **实现**：注册 host 全局 model tool `feishu_send_file`（`ctx.tools.register(defineTool(...))`，参数 `path` 必填 + `caption` 可选）。执行时：`exec.agent.id` → `bridge.resolveChat(sessionId)` 反查所属 chat（复用 `feishu-questions.ts` 的同一反向映射）→ 本地校验（存在/常规文件/非空/≤30MB）→ `channel.send(chatId, { file: { source, fileName } }, opts)` 由 SDK 内部走 `im.v1.file.create`（`file_type: 'stream'` 通用桶）+ file 消息，话题回复复用 `replyTo`/`replyInThread`。
- **未绑定会话降级**：WebUI 直接创建的 session 调 `resolveChat` 返回 `undefined`，工具返回明确错误，提示 agent 改用文本告诉用户路径。
- **约束**：Feishu 文件消息上限 30MB、不允许空文件；`file_type` 固定 `stream`（SDK `send({file})` 路径行为），任意扩展名可发，但超大文件/目录需先压缩拆分。
- **依赖**：新增 `@deepseek-ai/dsh-tools`（peerDep + devDep）；`inject` 数组加 `'tools'`。

### 适配 DSH 0.1.2-alpha.1（`@deepseek-ai/dsh-api-session-controller` 等新 capability seam）

- **删除 apiproxy 依赖**：`@deepseek-ai/dsh-host-apiproxy` 整包在 0.1.2-alpha.1 删除（`refactor(api): remove ApiProxy package`），所有 `ctx.apiProxy.events.mux()` / `apiProxy.respond()` / `apiProxy.sessions.selectModel()` 调用全部替换：
  - **events 订阅**（5 个文件：`feishu-todos.ts` / `feishu-streaming.ts` / `feishu-toolcalls.ts` / `feishu-questions.ts` / `feishu-approvals.ts`）：从 `for await (const envelope of apiProxy.events.mux(...))` 改为 `ctx.on('session/event', (session, event) => { ... })`。`(session, event)` 直接给 session 和 event 对象，无需拆 envelope / frame。
  - **user-questions 答案**：从 `apiProxy.respond({ type: 'client-response', rpcId, result })` 改为 `ctx.on('user-questions/request', async (req, next) => { ... return answer })` listener，listener 内部 await cardAction 回调后 return 答案；plugin 在 `apply()` 时注册 listener，return 答案即 claim 请求（默认 tool-ask-user provider 不会看到）。
  - **approval 答案**：从 `apiProxy.respond({ ... outcome })` 改为 `ctx.on('approval/request', async (req, next) => { ... return 'allowed-once' | 'rejected' })` listener，return outcome 即 claim。`scopeTarget(req.agent, req.agent)` 由 user-approval service 内部限定，plugin 不需要 scope 逻辑。
  - **selectModel**（`feishu-model-select.ts` + `commands.ts`）：从 `apiProxy.sessions.selectModel({ payload })` + `agentDefaultModel.saveSelection` + `bridge.setCurrentSelection` 三步法改为 `ctx.sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })` 一站式——`sessionController` 内部 `resolveAgent`（恢复 session）+ `resolveCallConfig`（校验）+ `agents.selectForNextRequest(agent, ref)`（写 agent scoped ref，WebUI 立即看到）+ `agentDefaultModel.saveSelection`（持久化）一次性完成。
- **删除 plugin 自己的 selection 缓存**（`harness.ts`）：`selections: Map<string, LiveSelection>`、`setCurrentSelection()`、`currentSelectionFor()`、`installModelSelection()` 调用、`LiveSelection` interface 全部删除——`ApiSessionAgentController` 内部 `WeakMap<Agent, InstalledSelection>` 已经替它做，plugin 不再需要 mutable ref。`getSessionMeta` 改用 `request/header` 事件（更权威的源）+ `agentDefaultModel.currentSelection()` fallback。
- **inject 数组**（`index.ts`）：`'apiProxy'` 替换为 `'sessionController'`, `'userQuestions'`, `'approval'`；`/stop` 命令改用 `sessionController.cancel({ sessionId })`。
- **依赖变化**（`package.json`）：删 `@deepseek-ai/dsh-host-apiproxy` peerDep / devDep；加 `@deepseek-ai/dsh-api-session-controller` + `@deepseek-ai/dsh-user-approval` peerDep / devDep。
- **测试**：mock `apiProxy.events.mux()` 异步迭代器改为 mock `ctx.on('user-questions/request', listener)` 同步注册 + `ctx.on('session/event', ...)` 同步 trigger；新增 `fakeSessionController()` 测试 helper。132 tests pass。
- **已知降级**（可接受）：
  - `tool/result` 事件的 `event.data.meta` 是 tool-private 呈现数据（对应之前的 `frame.view?.for === 'result'`），plugin 用它作 resultView。`tool/call` 事件没有 view 字段，callView 永远 undefined（`renderStepCard` fallback 到工具名 + args）。
  - `ctx.sessionController.selectModel` 内部走 `commands.selectModel` → `resolveAgent`（force resume）。对**未聊过**的 session 调 `/model` 会**强制创建 agent**（`resolveAgent` 在 `sessionPersistence.list()` 找到该 sessionId 时会 resume；找不到时 reject）。这是接口语义变化——之前 plugin 调 `setCurrentSelection` 不会创建 agent；现在会。如果想保持旧行为，未来可拆分为"createSessionController vs selectModel"两套 API。

### 工具调用展示（`src/feishu-toolcalls.ts`）

### 工具调用展示（`src/feishu-toolcalls.ts`）

- 订阅 apiproxy mux 的 `tool/call` + `tool/result` 事件，在飞书侧展示模型的工具调用过程。
- **原地更新**：`tool/call` 发送卡片后保存 `messageIdPromise`，`tool/result` 等待 `messageId` 后用 `updateCard` 更新同一张卡片（蓝色→绿色/红色），不再发两张独立卡片。
- 消除竞态：`tool/call` 直接发送（不走批量队列），确保 `messageId` 在 `tool/result` 到达前可用。
- 使用 Card JSON 2.0 格式，内联代码（反引号）正常渲染。

### Todo 展示（`src/feishu-todos.ts`）

- 订阅 apiproxy mux 的 `todo/write` 事件，展示 agent 的任务进度。
- 绿色卡片，含进度条（完成数/总数）和状态图标（⬜ 待办 / 🔄 进行中 / ✅ 完成）。
- 500ms debounce。

### 回复卡片消息（`src/channel.ts`）

- 每轮最终结果渲染为飞书 interactive card（蓝色 header "Assistant"），替代原来的纯文本消息。
- **全面迁移到 Card JSON 2.0**（`schema: '2.0'` + `body.elements`），原生支持表格、标题、内联代码（反引号）、代码块等完整 markdown 语法。
- 不再需要 `needsPlainTextFallback()` 降级逻辑——所有回复统一走卡片。
- `note` 标签（2.0 不支持）替换为 `markdown` + `text_size: 'notation'`，footer 视觉效果保持一致。
- 底部 footer 自动注入当前 session 的 workspace + preset + model + reasoning + context 信息。
- 空回复显示 `(empty response)` 占位。

### Session 映射持久化（`src/harness.ts`）

- `/new` 和 `/thread` 的 chat→session 映射现在持久化到 `~/.dsh/lark-session-map.json`，dsh 重启后自动恢复。
- 之前映射仅存内存，重启后 `/new` 创建的新 session 会丢失，回退到确定性 hash（旧 session）。
- 使用 `os.homedir()` + `/.dsh` 作为 `DSH_HOME` 的 fallback，解决 systemd 用户服务不继承 shell 环境变量的问题。

### `/status` 命令

- 新增 `/status` 命令，直接在 `executeSlashCommand` 中处理（不需要 live agent），返回飞书 interactive card。
- 显示字段：session id、title、workspace、preset、model、activity（turns/steps/tool calls）、tokens（input/output）、context 使用率。
- 数据从 `sessionPersistence.readFrom()` 读取 session header + events，不经过 LLM。

### `/new` 和 `/thread` 不再依赖已有对话

- `/new` 和 `/thread` 现在可以在没有 live agent 的情况下使用（直接在 `executeSlashCommand` 中处理）。
- 之前需要先发一条普通消息创建 session 才能用 `/new`，现在可以直接用。

### 卡片结构修复

- **所有飞书卡片**全面迁移到 **Card JSON 2.0** 格式（`schema: '2.0'` + `body.elements`），原生支持表格、标题、内联代码等完整 markdown 语法。
- `note` 标签（2.0 不支持）替换为 `markdown` + `text_size: 'notation'`。
- `feishu-approvals.ts` 审批卡片同步修复。

### `harness.ts` — persisted session 跳过 `attachSession`

- 已持久化的 session（在 `sessionPersistence.list()` 中）resume 时跳过 `workspace.attachSession()`。
- 之前 `attachSession` 会因 session 的 `cwd` 与当前 workspace 不匹配而失败（例如旧 session 在父 workspace 下创建），导致整个 `bridge.reply()` 崩溃。

### `conversation.ts` — `summarizeTurn` 健壮性

- turn 成功完成但只有 tool calls 没有文本时，返回 `{ text: '(no text response)', ok: true }` 而非失败。
- `event.data?.message` 和 `event.data?.reason` 增加 null safety。

### 定位与范围（2026-08-23）

- **定位变更**：从"飞书 channel 插件"改为 **"把 DSH 的原生特性接入飞书，而非再造一个 agent 平台/助手"**（详见 AGENTS.md「定位」）。不做 openclaw / hermes 式 24h 常驻助手；DSH 才是 agent 本体，本插件只做"DSH 原生特性 → 飞书聊天"这层接入。
- **本轮需求决策**（对应 TODO.md「本轮需求决策」）：
  - workspace / agent preset **只在创建新 session 时设定**（`/new --workspace / --preset`，persisted），不运行时热切，全部按 WebUI 原生行为。
  - **每轮最终结果渲染为飞书卡片**，底部注明当前 session 的 workspace + preset；该 footer **不调用 LLM**，插件从 session meta 自动注入。
  - 工作区选择用 **cd 式候选补全**（列子目录候选供选，只目录不文件）。
  - 新增 **`/status`** 命令，展示 WebUI 的 session 全部状态。

### `ask_user_question` 飞书卡片支持

之前模型调 `ask_user_question` 时，问题只在 WebUI 弹出，飞书聊天完全看不到，体验像是“卡住了”。本次让飞书侧也能看见选项并选择：

- 新增 `src/feishu-questions.ts`：订阅 `ctx.apiProxy.events.mux()` 的 `question/requested` 帧，给持有该 session 的飞书 chat 发一张 interactive card（header + 问题正文 + 每条 option 一个 button），收到 `cardAction` 回调后通过 `apiProxy.respond()` 把答案打回 apiproxy 的 `pendingQuestions`。WebUI 与飞书同时看到同一个问题，谁先答谁赢（共享同一份 `pendingQuestions`）。
- 走 mux 订阅而不是 `ctx.userQuestions.registerProvider()`：DSH 的 user-questions seam 是单例 provider slot，apiproxy 已经注册了；走 mux 订阅是 apiproxy 文档化的 fan-out 路径，与 WebUI 客户端用的是同一条，无需修改 DSH。
- `bridge.resolveChat(sessionId)` 反向查表：把 session id 映射回 chat 坐标（含 `/new` / `/thread` 覆盖）。`startChannel` 现在返回 `{stop, channel}`，`LarkRuntime` 暴露 `onChannelChange` 回调，让 questions listener 在 channel reconcile 后自动重新挂 `cardAction`。
- `inject` 数组新增 `'apiProxy'`；`peerDependencies` / `peerDependenciesMeta` / `devDependencies` 增加 `@deepseek-ai/dsh-host-apiproxy` 和 `@deepseek-ai/dsh-user-questions`（`rc.5`/`rc.7`）。CI workflow 的 `latest-harness` 步骤同步加入两个新包。

### `ask_user_question` 自定义回答 + 跳过（Card JSON 2.0 form 容器）

- **Card JSON 2.0 迁移**：所有问题卡片和审批卡片迁移到 v2 格式。v2 不支持 `action` 容器标签，按钮直接放在 `body.elements` 中，使用 `behaviors` 代替顶层 `value`。
- **Form 容器自定义回答**：用 `form` 容器 + `input` + `submit` 按钮实现卡片内自定义输入，替代之前的消息拦截方案。form 按钮使用 `form_action_type: "submit"` + `name`，通过 `includeRawEvent: true` 从 `evt.raw.action.form_value` 读取输入值。
- **跳过按钮**：卡片底部新增「⏭️ 跳过本题」按钮，提交空答案。
- **Settled 卡片**：选中选项用 ✅ 标记（无删除线），自定义回答显示「✅ 自定义回答：xxx」，跳过显示「⏭️ 已跳过」。
- **提示文字**：输入框上方显示「以上选项都不满意？在下方输入你的自定义回答：」引导用户。
- **`includeRawEvent: true`**：channel.ts 启用原始事件传递，使 `form_value` 可用。
- 删除 `messageInterceptors`、`onMessageInterceptor`、`pendingCustomInputs` 等消息拦截相关代码。

### `/model` 同步到 WebUI

- **问题**：飞书 `/model` 切换后，飞书侧 `/status` 和 Turn Complete 卡片显示新模型，但 WebUI 显示旧模型，实际生效的也是旧模型。
- **根因**：WebUI 通过 `apiProxy.selections`（`WeakMap<Agent, WebModelSelectionRef>`，由 `apiProxy` 的 `selectionFor()` 维护）读取当前模型；飞书插件用自己的 `bridge.selections`（`Map<sessionId, LiveSelection>`）读取模型。飞书 `/model` 只更新了 `bridge.selections` 和全局 settings，没有调用 `apiProxy.sessions.selectModel(...)` 同步更新 WebUI 的 selections Map。
- **修复**：`handleModelCommand` 在调用 `agentDefaultModel.saveSelection()` 和 `bridge.setCurrentSelection()` 之后，额外调用 `apiProxy.sessions.selectModel({ payload: { sessionId, provider, model, reasoningEffort? } })`，让 `selectionFor(agent).current = selected` 同步生效。
- `bridge.resolveSessionIdFor` 和 `bridge.resolveAgent` 暴露给 commands；`registerLarkCommands` 新增可选 `apiProxy` 参数，未配置 apiProxy 的部署自动降级到原有行为（settings + bridge selections 仍生效）。
- 调用 `apiProxy.sessions.selectModel` 失败时不影响主流程（model 已落 settings + bridge selections，下次 assemble 会生效）。
- **同 bug 复现于 `/reasoning`**：`/think`、`/reasoning high` 等切换 reasoning effort 也有同样的问题（飞书侧切换成功，WebUI 不变，实际也不生效）。`handleReasoningCommand` 同样在 `saveSelection` + `setCurrentSelection` 后调用 `apiProxy.sessions.selectModel({ payload: { sessionId, provider, model, reasoningEffort: level } })`，保持 `selectionFor(agent).current.reasoningEffort` 同步。

### 测试

- `tests/feishu-questions.spec.ts` 新增 6 个用例：点选项后 answer 经 `apiProxy.respond` 上报、自定义回答从 `form_value` 读取、空输入忽略、忽略不匹配的 rpcId、跨 chat session（不是本插件持有的 chat）跳过渲染、`stop()` 清掉 `cardAction` handler。
- `tests/runtime.spec.ts` 适配 `LarkRuntimeStart` 返回值（`{stop, channel}`），所有 reconcile / dispose / credential-change 用例继续过。
- `tests/plugin.spec.ts` 适配 `startChannel` 新返回值（`const { stop } = await startChannel(...)`）。
- `tests/plugin.spec.ts` 的 `IMAGE_LIMITS` 增加 `maxImageDimension`（DSH attachment rc.8 必填）。

### 兼容性

- 适配 DeepSeek Harness `0.1.0-rc.7`（2026-08-18 升级）：移除对 host-plane `compaction` 服务的依赖（rc.7 的 preset 架构把 `compaction-basic` 移进了 per-session preset realm，host 平面不再有全局 `compaction`）。

### 命令注册

- 移除 `/compact` 命令（飞书聊天内）：与 DSH 自带 `command-compact` 插件同名（`name: "compact"`），DSH 启动时两个注册会抛 `command "compact" is already registered` 导致插件崩溃、boot 失败。DSH web UI 仍可通过 DSH 自带 `command-compact` 使用 `/compact`。
- `/model`、`/stop` 保留。
- `inject` 数组去掉 `'compaction'`；`apply()` 中不再 `ctx.get('compaction')`；`executeSlashCommand` 不再传 `_compaction` 参数。

### dsh 启动必需配置

- `~/.dsh/profiles/web/cordis.patch.yml` 必须启用 `compaction-basic` + `command-compact`（拉回 host plane），否则 DSH 自带 `/compact` 命令在 web UI 上也不可用。
- 启用 `lark-channel`（无特殊要求，前提是上方 `command-compact` 已启用）。

### 命名与仓库迁移

- GitHub 仓库：`Starxer/dsh-feishu`（fork）→ `Starxer/dsh-feishu`（独立仓库）
- npm 包名：`@starxer/ds-feishu` → `@starxer/dsh-feishu`
- 本地目录保留 `workspace/dsh-feishu`（不改名，避免影响 `~/.dsh/profiles/web/package.json` 的 pnpm link 路径）
- 与上游分叉：移除 `/compact` 命令与上游设计哲学冲突，无法反向合并回 upstream

### Bug 修复

- 备份与临时文件清理：删除了 `src/commands.ts.bak.*` 和 `src/index.ts.bak.*`（编译时调试产物，已 gitignore 防止再次产生）。

## Unreleased

- Add an emoji reaction (`reactEmoji`, default `THUMBSUP`) to each inbound message as an immediate acknowledgement; set it to an empty string to disable. A failed reaction logs a warning without blocking the reply.
- Register three chat-side slash commands that bridge into the Harness command plane: `/model` (show, list, fuzzy-search by keyword, or switch the active default model through Harness Settings), `/compact` (call `ctx.compaction.compactNow()` against the chat's existing Agent), and `/stop` (call `agent.cancel({ kind: 'user' })` to abort the running turn). `/model` and `/compact` require that the chat has sent at least one ordinary message first so a session already exists.

## Unreleased — 飞书 slash 命令与 session 切换

### 新增命令

- `/new`：在当前 chat 内创建一个全新的 session，下次普通消息落到新会话；旧 session 保留在 agents registry。
- `/thread`：列出本 workspace 所有 persisted sessions（按 `session/title` 显示最新标题、`updatedAt` 粗粒度相对时间 + session id），并支持 `/thread N` 切到第 N 个。session id 来源：`sessionPersistence.list()` + live agents events。
- `/thread` 列表与 WebUI 行为对齐：
  - 隐藏 `workspaceRegistry.archivedSessionIds` 里的归档 session；
  - 隐藏 live blank session（DSH 自动创建、从未发过 user message）；
  - cold session 通过 `readFrom(id, 0)` 读 `session/title` 与 `turn/start` 事件，避免重复标题误读；
  - `/thread N` 命中归档 session 时返回 `threadArchived` 错误，提示用户在 web UI 取消归档。
- `/help`：通过 `ctx.commands.list(agent)` 列出该 agent 当前可用的所有 slash 命令（包括 DSH 自带的 `compact` / `goal` / `feedback` / `export` 与本插件注册的 `model` / `new` / `thread`），每条命令附 description 与可选 input hint（`[<hint>]`）。DSH 自带的命令无需在本插件二次注册即可被飞书用户发现与触发。

### `/model` 命令行为变更

- 切换成功后区分 `modelLiveApplied`（chat 已有 live agent，立即生效）和 `modelPersisted`（仅落 settings，下次创建 session 时生效）。
- `harness.ts` 的 reuse 路径 bug 修复：dsh 重启后 `selections` 缓存丢失，原本无法再次挂 `installModelSelection` 到 live agent 的 ctx；现在 reuse 时若 `selections.get(sessionId) === undefined` 会重新挂一次 ref，`/model` 切换真正生效。
- `commands.execute` 修复：`commands.execute(agent, line, images, signal)` 四参数签名，之前少传了 `images: []` 导致 4 参错位（controller.signal 被当成 images 数组）。

### 测试

- `tests/commands.spec.ts` 从 8 个用例扩到 18 个，覆盖 `/model` live/persisted 切换、`/new`、`/thread` 列表（含 archived + blank 过滤）、`/thread N` 切换（合法/越界/非数字/archived）、相对时间桶（just now / Nm / Nh / Nd / unknown）。
- `tests/harness.spec.ts` 从 7 个用例扩到 11 个，覆盖 reuse-path 挂 selection ref、`/thread` archived 过滤、`switchToSession` 拒绝归档、`/model` 切换写入 ref.current。
- `tests/commands.spec.ts` 新增 4 个 `/help` 用例：列表所有 descriptor、带 input hint 的渲染、空列表、忽略多余 rawInput。
- `tests/plugin.spec.ts` 新增 3 个图片消息用例：下载 image 资源 + 注入 ImageBlock、缺 attachment service 时拒绝、保存失败走 safe fallback。
- `tests/harness.spec.ts` 新增 5 个用例：文本+图片 mixed turn、纯图片 turn、空消息拒绝、`[Feishu]` 前缀对纯文本 / mixed / image-only 三种 turn 的覆盖。

### 飞书图片消息支持

- `inject` 数组新增 `'attachments'`；启动时 `ctx.get('attachments')` 必填，部署未带 `dsh-attachment-local` 时启动失败。
- `channel.ts` 在消息处理前先把 `resources` 里的 image 资源经 `channel.rawClient.im.v1.messageResource.get({message_id, file_key})` 下载成字节（注意：`LarkChannel.downloadResource` 走的是 `im.v1.image`，那是机器人自己上传的 key，用户消息里的资源走 `im.v1.messageResource`，两者 API 不同），再调 `attachments.saveImage()` 拿到 `ImageAttachmentRef[]`，交给 bridge。
- `harness.ts` 的 `reply` 接受可选 `imageBlocks` 字段，构建 user-turn content 时按顺序追加 `{type:'text', text}` + `{type:'image', attachment}`，符合 `ContentBlockMap` 合并扩展约定。
- 缺图片附件服务或图片 admission 失败时，回复一条用户可见错误文本（不动 bridge，不把空消息当成普通 turn）。
- 每条 user turn 的文本前面自动加 `[Feishu] ` 前缀，让模型（和 session log）能区分消息来自 Lark channel 还是 webui 客户端；纯图片消息把 `[Feishu] ` 单独作为一个 text 块放在 image 块之前（而不是塞到 caption 里），保证 LLM 一定能看到来源 tag。

---

> **以下为 fork 前上游 `sugarforever/dsh-lark` 的历史记录**（版本号 0.1.0–0.2.2 属于上游，与本仓库的 `0.2.0` 无关；本仓库的版本从 `0.1.0` 重新起算）。保留仅供追溯。
>
> The sections below are the pre-fork history of upstream `sugarforever/dsh-lark`. Their 0.1.0–0.2.2 numbers belong to upstream and are unrelated to this repository's `0.2.0`; this fork restarted versioning at `0.1.0`. Kept for reference only.

## 0.2.2

- Restore npm 12 lockfile entries required for clean Linux CI installs.

## 0.2.1

- Mark Harness-provided peer dependencies as optional for package-manager resolution, avoiding misleading missing-peer warnings in DSH Profiles.
- Keep the supported Harness range starting at `0.1.0-rc.6` while validating development and release builds against `0.1.0-rc.7`.
- Add continuous compatibility checks against the latest published Harness packages.

## 0.2.0

- Contribute an embedded **Feishu & Lark** section to Harness Settings through the plugin web client.
- Require same-origin browser requests for settings and credential mutations.
- Store App Secret through Harness Credentials using `DSH_LARK_APP_SECRET` by default.
- Apply Settings and credential changes by replacing the Lark channel without restarting Harness.
- Keep the plugin active but idle until required application credentials are configured.
- Show explicit configured and missing App Secret states without returning the secret to the browser.
- Populate linked Provider and Model selectors from the current Harness model catalog.
- Resume persisted Lark sessions after restart and reuse an already-live Agent when available.
- Print initial connection, channel, and message-handling failures to the terminal as well as the Harness logger, with App Secret redaction.
- Remove the generic configuration-file action from the Lark-focused Settings experience.

## 0.1.1

- Mount the Harness default or configured Agent Preset for Lark sessions.
- Associate Lark sessions with an explicit Workspace or the first registered Workspace.
- Start corrected sessions with a v2 identity so legacy uncomposed sessions are not reused.

## 0.1.0

- Initial Feishu/Lark WebSocket Channel integration for DeepSeek Harness.
- Stable chat/thread to Harness Session mapping.
- Official SDK policy, deduplication, stale-event filtering, and per-chat queue reuse.
