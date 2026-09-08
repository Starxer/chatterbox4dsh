# dsh-feishu TODO

> 定位见 [AGENTS.md](./AGENTS.md)：**把 DSH 的原生特性接入飞书，而非再造一个 agent 平台/助手**。
> 状态：`已有` ✅ / `部分` ⚠️ / `待实现` 🔲 / `规划中` 📋 / `待调研` 🔍

---

## 0.1.2-alpha.1 适配（已完成，2026-08-28）

- 删除 `apiproxy` 依赖（DSH 0.1.2-alpha.1 整包移除 `packages/host/apiproxy`）
- events 订阅改 `ctx.on('session/event', (session, event) => ...)` —— 5 文件统一改
- user-questions / approval 答案改 `ctx.on('user-questions/request' / 'approval/request', listener return answer/outcome)` —— 走 Cordis waterfall，listener return 即 claim
- selectModel 改 `ctx.sessionController.selectModel(...)` 一站式同步 agent ref + WebUI + 持久化（之前 plugin 自己的 `selections: Map` + `installModelSelection` 删除）
- inject 数组 `'apiProxy'` → `'sessionController', 'userQuestions', 'approval'`
- `/stop` 改 `sessionController.cancel({ sessionId })`
- 132 tests pass / typecheck 0 errors / build OK
- 已知降级：`tool/call` 事件无 view 字段（callView 永远 undefined）；`tool/result` 用 `event.data.meta` 作 resultView

---

## 已完成

| # | 功能 | 说明 |
|---|---|---|
| 1 | 卡片化 + footer | 最终回复卡片底部标注 workspace + preset + **模型名** + **思考强度** + **上下文使用量** |
| 4 | `/status` 命令 | 展示 session id / title / workspace / preset / model / **reasoning** / tokens / context / **缓存命中率** / **TTFT** / **吞吐量** / **LLM 时间** / **工具时间** |
| 5 | 工具调用展示 | 订阅 `ctx.on('session/event')` → `tool/call` + `tool/result`，wathet/green/red 卡片。**原地更新**：`tool/call` 发卡片后保存 `messageId`，`tool/result` 用 `updateCard` 更新同一张卡片 |
| 6 | todo 展示 | 订阅 `ctx.on('session/event')` → `todo/write`，turquoise 卡片含进度条 |
| 11 | 中间消息不可见 | ✅ 改为 `ctx.on('session/event')` + `tool/call` 时 flush 累积文字，紫色卡片 |
| 12 | tool call 卡片 markdown 渲染 | ✅ `lark_md` → `markdown`，4 文件 11 处 |
| 13 | 卡片 Markdown 渲染不稳定 | ✅ 全面迁移到 Card JSON 2.0，表格/标题/内联代码原生渲染，移除降级逻辑 |
| 14 | 纯查询命令即时返回 | ✅ fire-and-forget + agent 运行状态检测 |
| 15 | Agent 消息队列调研 | 两层队列机制已确认（见下方调研记录） |
| 17 | `/reasoning` 思考强度命令 | ✅ `/reasoning [off|low|high|max]`，通过 `agentDefaultModel.saveSelection` 持久化 |
| 19 | tool_call / tool_done 顺序问题 | ✅ `tool/call` 直接发送保存 `messageIdPromise`，`tool/result` 等待后 `updateCard`，消除竞态 |
| 20 | 工具调用摘要 | ✅ 通过 mux `frame.view` 获取 `presentCall`/`presentResult` 的 `description`、`title`，显示在工具名称上方 |
| 21 | 卡片颜色区分 | ✅ 工具调用中 wathet → 成功 green → 失败 red；Reply 蓝色；Turn Complete 绿色 |
| 22 | Reply 标题命名 | ✅ 已统一为 "Reply" |
| — | `/stop` 命令 | 通过 `ctx.sessionController.cancel({ sessionId })` 中断运行中的 agent，等同 WebUI 停止按钮 |
| — | `/stream` 命令 | 切换 `showIntermediateMessages` 设置（已与中间消息模块解耦，保留备用） |
| — | 统一 per-step 卡片 | ✅ 每个 step 一张卡片，包含 reasoning + text + 工具调用 + 结果预览 + step 时长/token footer |
| — | 工具结果预览 | ✅ 按 `resultView.card` 类型分发渲染（terminal/web/search/read/diff/generic） |
| — | 工具名称内联代码 | ✅ 工具名用 `` ` `` 内联代码展示（如 `` `read` ``、`` `edit` ``） |
| — | Turn Complete 卡片 | ✅ 显示轮次时长、TTFT、吞吐量、输入输出 token、缓存命中率 |
| — | Step token footer | ✅ 每个 step 卡片底部显示时长 + 输入输出 token |
| — | Debounce + flush 同步 | ✅ 150ms debounce 合并快速更新，turn/end 时 flush 确保 footer 在 card update 之后发送 |
| — | 防止卡片消失 | ✅ 内层 try/catch 保护 mux 事件处理，timer 回调 error-safe |
| — | 不同步骤工具调用分离 | ✅ `resetStep` 不清除 `state.chat`（session 级坐标），每个 step 独立卡片 |
| — | 审批按钮反馈 | ✅ 点击后卡片更新为 ✅ Approved / ❌ Rejected，移除按钮 |
| — | 飞书事件订阅修复 | ✅ provision 新增 `im:message.reaction` 权限 |
| — | 卡片按钮回调修复 | ✅ ~~Node.js SDK `MessageType.CARD` 被过滤~~**经对照实验证实补丁不必要**：`card.action.trigger` 以 `type='event'` 到达，帧过滤不拦它；已移除 `patch-sdk-card-action.sh` + `postinstall`（还原 pristine SDK） |
| — | 选项卡片反馈 | ✅ 选择后 recall 旧卡 + 发新卡（青绿色头部，显示所有选项，已选高亮） |
| — | 双重编码 JSON | ✅ Feishu `action.value` 双重编码 → 二次 `JSON.parse`（questions + approvals） |
| — | Turn Complete 时间修复 | ✅ LLM 时间（assistant/message 累加）与工具时间（tool/result 累加）分开统计 |
| — | `/thread` 改名 `/session` | ✅ 命令实际操作 DSH session（`listSessions`/`switchToSession`），与飞书原生"话题"混淆、与 WebUI「会话」心智不一致；已重命名（`commands.ts`/`index.ts`/`tests`/文案/`FEISHU_OWNED_COMMANDS`），**不保留 `/thread` 别名** |
| — | `/session` 管理面板 | ✅ `feishu-session.ts`：下拉选会话 + 切换（占用先确认）/detach/归档/fork/改名（独立卡片，`sessionController.rename`）/列表/刷新；`/session list` 表格卡；`/session N` 快速切换 |
| — | `/help` 卡片化 + 分组 | ✅ 飞书文本不渲染 markdown → 卡片；分「🔹 dsh-feishu 插件 / 💠 DSH 内置」两组，被拦截命令（busy/steer/queue/permission/stop）补进 Feishu 组 |
| — | 工具调用摘要找回 | ✅ `deriveToolSummary`（`feishu-streaming.ts`）按 Web UI `classifyTool`+`deriveSummary` 从 tool/call 的 arguments 本地推导（bash/search/read/write/code/未知）；因 DSH 0.1.2-alpha.1 不再发射 `presentCall`，`callView` 路径已死 |
| — | 工具 args fenced 代码块 | ✅ args 用独立 `` ``` `` 代码块渲染（`sanitizeCodeblock` 折反引号/剔控制字符），避免破坏卡 markdown/横向溢出 |
| — | 工具结果兜底展示 | ✅ `renderResultPreview` 各分支无输出时 `finish()` 兜底渲染原始结果内容，保证结果始终可见 |
| — | 免会话命令重启可用 | ✅ `resolveAgentOrResume`（harness）冷会话懒恢复 + 真正免会话命令（`/model`/`/reasoning`/`/approvals`/`/approve`/`/deny`/`/help`）在 `resolveAgent` 兜底前直接拦截 |
| — | 问题结算卡保留描述 | ✅ `renderSettledQuestionCard` 补上 `detail` |
| — | Turn Complete 展示 busy 模式 | ✅ footer 只读显示 `**Enter while busy:**`（Queue/Steer），与 `/status` 一致 |
| — | `/busy` 交互选择卡 + `/queue` | ✅ `feishu-busy.ts`、`/queue`（`forceQueue`），模式匹配短接 |
| — | `action.value` 双解码 | ✅ `decodeCardValue`（多深度 JSON.parse，cap 4），busy/permission/model-select/session 共用 |
| — | `/model` 一站式 | ✅ `ctx.sessionController.selectModel`（agent scoped ref + WebUI + 持久化），不再用插件 `selections: Map`/`installModelSelection` |

## 下一轮待办（2026-08-30 定，未动工）

> 用户最后明确：**先更新 TODO 文件，暂不动手改代码**。以下 5 项为下一轮实现计划。

| # | 功能 | 优先级 | 说明 |
|---|---|---|---|
| 1 | subagent 会话独立命令 | **中** | **主会话列表剔除 subagent 会话：✅ 已完成（2026-09-02）** —— `listSessions()` 按会话 durable header `origin === 'subagent'` 过滤（DSH 子代理会话创建时即写该字段；fork 会话只有 `parentSession`、无 `origin`，不受影响，仍显示）。`/session`、`/session list`、`/session N`、onboarding 选择卡全部经 `listSessions`，一处过滤全覆盖。剩余：新增专门命令（暂定名 `subagent`）单独查看子代理会话，数据源 `ctx.subagents.listChildren` / `listDescendants`（列名称/状态/depth），只读。**尚未动工** |
| 2 | `/steer` 与 `/queue` idle 兼容 | **中** | ✅ **已完成（2026-09-08）**：agent 空闲时 `/steer` 自动回退为发新消息，不再报错 |
| 3 | `locale` 设置 + `/lang` | **中** | ✅ 已完成（2026-08-31）：插件 `locale` 字段（`auto`/`zh`/`en`，默认 `auto`）+ `/lang [zh\|en\|auto]` 切换持久化。**语言源 = 插件字段，默认跟随 DSH**（`settings.get('locale').preference`，无值回退 `zh`）。见 CHANGELOG「中英双语 i18n」 |
| 4 | 插件文案 i18n（zh/en) | **中** | ✅ 已完成（2026-08-31）：命令响应层（`CommandTranslations` 拆 zh/en，`src/commands-i18n.ts`）+ 卡片层（`Translations` 字典 `src/i18n.ts`）：streaming/session/busy/permission/questions/onboarding/model-select/status/footer 全部双语，术语对齐 DSH。191 测试通过 |
| 5 | 测试 + typecheck + build + restart + 文档 | **中** | 上述改动收尾：补 spec、`npm run typecheck`/`test`/`build`、`systemctl --user restart dsh`、AGENTS/CHANGELOG 更新 |

---

## 待实现

> ⚠️ 状态已刷新（2026-08-30）：`#16 权限系统接入`、`/thread→/session` 改名均已**完成**，从本表移除。

| # | 功能 | 优先级 | 说明 |
|---|---|---|---|
| 18 | 思考内容**可折叠** | **中** | reasoning 代码块支持折叠（飞书 Card JSON 2.0 `collapsible` 组件）。**2026-08-30 核实**：3000 字符截断**已做**（`feishu-streaming.ts` reasoning/text 均 `slice(0,3000)`），仅 `collapsible` 未实现 |
| — | **step 卡片可见性开关**（过程透明可配置） | **中** | **后续计划**（2026-08-30 定）。step 级透明是双刃剑：对需观察/干预者有价值，对偶发使用者是打扰噪音。新增配置开关，控制三段式 per-step 卡片（💬 Reasoning / 📝 Message / 🛠 Tool call）各段展示内容，可自定义——如：①只展示其中一段；②只展示工具 description + 工具名、不展示具体 args。与 `showIntermediateMessages` 不同，是精细到"段/字段"的颗粒度 |
| 3 | ~~工作区候选补全~~ → 目录浏览器 | **中** | ✅ **已完成（2026-09-08）**：改为**目录浏览器**（比输入前缀补全更直接）——`/new` 工作区卡片新增「📂 浏览目录…」，可导航 / 分页 / 显示隐藏目录 / 选当前目录为工作区。目录来源优先 DSH `directoryPicker` 的 `browse` 能力，`native` 或缺失时回退插件自带只读列举。见 CHANGELOG「新增：/new 工作区卡片支持浏览目录」。**前缀补全本身不再做**（浏览器已覆盖）。**2026-09-08 追加**：工作区列表从「每个工作区一行 + 一个按钮」改为**下拉框（只显示序号，全路径在正文）**，避免工作区变多后卡片无限变长；目录浏览同样改为**编号下拉框**（正文列名字、下拉只放行号）——按钮宫格/按内容宽度分行都因飞书不认列内 `width: 'fill'` 而失败，已弃用 |
| — | **旧卡片改写为「已失效」提示** | **中** | ✅ **已完成（2026-09-08）**：新增 `src/card-supersede.ts`，交互流程每发一张新卡就把上一张改写成无按钮的灰色提示卡（zh/en 双语、优先 CardKit 实例、best-effort）。已接入 `/new` 全流程（含目录浏览每一步、预设→模型交接）与 model-select 的兜底发新卡路径；`cancel`/`attach`/错误卡标记 terminal，不被改写。见 CHANGELOG「发新卡片时把被替换的旧卡片改写为『已失效』提示」。**仍待排查**：`feishu-session.ts` 面板仍是就地更新（未改成发新卡，故无失效提示可写） |
| — | **交互卡片就地更新上限** | **高** | ✅ **已修复（2026-09-08）**：飞书对同一条消息的卡片**就地更新约 2–3 次后停止投递按钮回调**（patch 与 CardKit 实例**同样**受限）。目录浏览器改「每次导航发新卡片」；`sendCard` 已不再用 `updateCardInstance`。**仍待排查**：`feishu-session.ts` 面板（切换/列表/刷新多次点击）、`feishu-model-select.ts`（provider→model→confirm 2–3 次）仍在就地更新，可能同样会失效 |
| — | **step 卡编辑次数上限** | **中** | ✅ **已修复（2026-09-08）**：step 卡改走 CardKit 卡片实例（`cardkit.v1.card.update` + 单调 `sequence`），通道未提供时回退 patch。**重要澄清**：飞书对**带按钮**的卡片就地更新约 2–3 次后停止投递回调；**step 卡没有按钮**，因此连续原地更新是安全的（详见上一条「交互卡片就地更新上限」）。见 CHANGELOG「修复：step 卡片改用 CardKit 卡片实例」 |
| — | **step 卡丢失更新（工具状态不刷新 / 卡片只剩 reasoning）** | **高** | ✅ **已修复（2026-09-08）**：① `assistant/message` 曾无条件发新卡 → 工具先开卡时旧卡被弃、再也收不到结果；改为「已有卡就更新」。② 防抖表按 session state 键 → 下一步骤的更新取消上一步骤待触发的定时器；改为按卡片 ref 键。另加 `[send]`/`[update]` 诊断日志。见 CHANGELOG「修复：step 卡片丢失工具状态更新 / 只剩 reasoning」 |
| 9 | 流式输出 → CardKit | ~~低~~ **不再做** | ~~解决 5 QPS 瓶颈。单卡持续流式更新（`streaming_mode`）~~。**2026-09-02 用户决定：不再做流式输出，方向取消** |
| — | ~~清除 `/stream`（stream on 状态）~~ | **中** | ✅ **已完成（2026-09-02）**：移除 `/stream` 命令 + `showIntermediateMessages` 配置，保留三段式 per-step 卡片更新机制（stream off/默认行为不变）。见 CHANGELOG「移除：/stream 命令及 showIntermediateMessages 配置」。原记录：**只清除「stream on = 流式更新文字」这个一直没用状态；三段式 per-step 卡片更新机制保留，stream off（默认）行为不变**。范围：`/stream` 命令（index.ts + commands.ts 注册/`/help`）+ `config.ts` 的 `showIntermediateMessages` 字段 + toggle 写入路径。**关键事实**：`showIntermediateMessages` 只在 `/stream` toggle 写入，无任何渲染路径读取——统一三段式卡片始终渲染、与开关无关，故删掉不影响默认行为 |
| 8 | 文档与版本一致性 | **低** | 2026-08-30 核实：package.json `0.1.0`，README 明显过期未同步，仍待办 |
| — | 飞书 SDK 卡片回调补丁追踪 | **低** | 2026-08-30 核实：**可关闭** —— 无 postinstall/patch，SDK `1.73.0` 原版；card 帧被过滤已**证伪**（「已知问题」同段已标注）。仅为未来 SDK 变更留档 |
| — | **agent 回复过长被飞书截断 → 自动分段发送** | **中** | ✅ **已实现**（2026-09-08）：step 卡 text 超 `TEXT_STEP_CAP=3000` 自动拆溢出卡（`renderOverflowCard` + `chunkText`），不再截断丢弃；reasoning 收紧 200 字；args 改 pretty 打印 2k 上限。见 CHANGELOG「修复：step 卡 text 超 3000 字不再截断 → 自动拆分溢出卡发送」 |

> ✅ 已从本表移除（2026-08-30 确认完成）：
> - `/new` 带参数（`--workspace`/`--preset`）—— 已实现
> - 多 session 话题导航 —— 已做（会话映射持久化 + 话题映射）；**不再做并行可见性**（用户明确）
> - `#16` 权限系统接入、`/thread→/session` 改名、SDK 补丁追踪（证伪关闭）

---

## `/thread` → `/session` 改名清单 —— ✅ 已完成（2026-08-30）

> 命令实际操作的是 DSH session（`bridge.listSessions()` / `bridge.switchToSession()`），`thread` 命名与飞书原生"话题"混淆，且与 WebUI「会话」心智不一致。**不保留 `/thread` 别名**，`/help` 列表中只出现 `/session`。下方清单为提出时的改动范围，历史存档。
>
> ⚠️ 只改**命令相关**的 thread 引用；`threadId` / `replyInThread` / `thread_id`（飞书话题消息坐标）与命令无关，**不要动**。

| 文件 | 改动内容 |
|---|---|
| `src/commands.ts` | 翻译键 `threadDescription`/`threadUsage`/`threadListHeader`/`threadListEmpty`/`threadListEntry`/`threadSwitched`/`threadInvalidIndex`/`threadArchived`/`threadIdle`/`threadLastActive*` → `session*`；`name: 'thread'` → `'session'`；`handleThreadCommand` 函数名；`formatRelativeTime` 内 `t.threadLastActive*` 引用 |
| `src/index.ts` | `executeSlashCommand` 中 `parsed.name === 'thread'` → `'session'`；translations 定义（约 489-502 行）的 `threadXxx` 键 → `sessionXxx`；`handleThreadDirect` 函数名及内部 `t.thread*` 引用 |
| `tests/commands.spec.ts` | stub translations 的 `threadXxx` 键 → `sessionXxx`；`registered.map(item => item.name)` 期望数组 `'thread'` → `'session'`；`describe('/thread command')`；`item.name === 'thread'` 查找；`Usage: /thread [N]` 断言文本 |
| `README.md` | 斜杠命令表 `/thread` → `/session`；`\| /thread [N] \| 列出/切换会话 \|` 行 |
| `AGENTS.md` | 3 处 `/thread` 提及（功能对齐表"多 thread 并行工作"行、session 映射持久化行）→ `/session` |
| `CHANGELOG.md` | 在 Unreleased 段**新增**一条改名记录（历史条目保留原文不动） |
| `TODO.md` | 本文档自身："多 thread 话题导航"行中 `/new` `/thread` 已通 → `/new` `/session` |

不需要改：`tests/harness.spec.ts`（无 thread 字样，经确认）；`src/harness.ts` / `src/conversation.ts` / `src/channel.ts` / `src/feishu-*.ts` / `docs/architecture.md`（仅含飞书话题 `threadId`/`replyInThread`，与命令无关）。

---

## 已知问题

### `im.v1.message.patch` 不更新卡片头部

**现象**：`updateCard`（底层调 `im.v1.message.patch`）只更新 body，不更新 header（标题、颜色）。

**影响**：
- Tool Call → Tool Done 颜色变化不生效（保持初始颜色）
- 选项卡片选择后颜色变化不生效

**解决**：需要改 header 时，recall 旧卡 + 发新卡。已用于：
- 选项卡片（feishu-questions.ts）— 选择后 recall + resend
- 审批卡片（feishu-approvals.ts）— 使用 updateCard（仅 body 变化，header 橙→绿 需要 recall）

**待优化**：审批卡片的 header 颜色变化目前依赖 updateCard，实际上不会生效。需要改为 recall + resend。**2026-08-30 核实**：`feishu-approvals.ts` 结算卡仍走 `channel.updateCard`（=patch），未按 `已知问题` 说明改 recall+resend，故橙→绿 header 变化至今仍未生效 —— **暂搁置**（审批卡片触发频率低，用户决定先不处理）。

### ~~Node.js SDK `MessageType.CARD` 被过滤~~（已证伪，补丁已移除）

**现象（原判断）**：飞书卡片回调事件（`card.action.trigger`）通过 WebSocket 推送时 `type='card'`，Node.js SDK 的 `handleEventData` 过滤了 `type !== 'event'` 的消息。

**纠错**：该判断经**对照实验证伪**——还原 pristine SDK（`type !== MessageType.event`）后重启，`card.action.trigger` 仍以 `type='event'`（带 `event_type`）到达插件，卡片点按正常。即帧过滤并不拦它，**此前加的 `scripts/patch-sdk-card-action.sh` + `postinstall` 补丁是过度诊断，已移除**，SDK 还原为官方原版。真正导致卡片「点按无反应」的是 `action.value` 双编码解析问题（用 `decodeCardValue` 修复，见 CHANGELOG）。

**长期方案**：若未来 SDK 变更导致 card 帧被拦，再评估提 issue/PR。

### `action.value` 双重编码

**现象**：飞书返回的 `action.value` 是 JSON 字符串内嵌 JSON 字符串（双重编码）。

**解决**：`JSON.parse` 两次（feishu-questions.ts、feishu-approvals.ts）。

---

## 问题追踪（2025-08-27）

### ✅ WebUI 改模型后 status 命令显示不更新 —— 已解决（2026-08-30）

**现象**：
- WebUI 里切换模型后，`/status` 命令显示的模型名仍是旧模型
- 即使在 WebUI 切换后进行一轮对话，`/status` 仍显示旧模型
- 在飞书继续对话后，`/status` 仍不更新，但实际对话的模型已经是 WebUI 切换后的模型

**复现**：WebUI 修改模型 → `/status`（显示旧模型）

**根因分析**：`/status` 命令读取的是 `bridge.selections`（飞书侧的 per-chat selection ref），而 WebUI 切换模型只更新了 `apiProxy.selections`（WeakMap，WebUI 侧）。两者是独立的缓存，没有同步。

**修复方向**：`/status` 命令需要优先从 `sessionController.selectModel` 的结果或 `selectionFor(agent).current` 读取当前实际模型，而不是只读 bridge 的 selection ref。

**解决**：`/model` 已改为 `ctx.sessionController.selectModel(...)` 一站式（写 agent scoped ref + WebUI + 持久化），插件不再维护独立的 `selections: Map`/`installModelSelection`；`/status` 改为读 `selectionFor(agent).current`（scoped ref）。飞书与 WebUI 收敛到同一处缓存，不再各读各的。**已确认解决**。

---

### ⚠️ MiniMax M3 思考强度选项差异 —— 已知，非 bug

**现象**：MiniMax M3 模型的思考强度选项与标准模型不同。

**根因**：MiniMax-M3 支持的 thinking 选项是 `disable` / `adaptive`，而非标准的 `off` / `low` / `high` / `max`。这是模型本身的差异，非插件 bug。

**状态**：✅ **已明确，无需修复**。`/reasoning` 命令显示的是 DSH 标准选项，MiniMax M3 实际行为由模型侧决定。

---

## 卡片颜色参考

| 颜色 | 用途 | 文件 |
|---|---|---|
| blue | Reply 回复卡片、问题卡片 | `channel.ts`、`feishu-questions.ts` |
| turquoise (青绿) | Todo 列表卡片、已选问题卡片 | `feishu-todos.ts`、`feishu-questions.ts` |
| wathet (浅蓝) | Tool Call 调用中 | `feishu-streaming.ts` |
| green | Tool Result 成功 / Turn Complete | `feishu-streaming.ts`、`channel.ts` |
| red | Tool Error 失败 | `feishu-streaming.ts` |
| orange | 审批请求 | `feishu-approvals.ts` |
| grey | 无选项问题 | `feishu-questions.ts` |

---

## #11 中间消息不可见 —— ✅ 已修复

- **根因 1**：旧代码用 `ctx.on('session/event')` 订阅 Cordis 事件，在插件 scope 中不生效
- **根因 2**：旧代码依赖 `showIntermediateMessages` 设置，默认为 `false`
- **修复**（2025-08-25）：
  - 改用 `ctx.on('session/event')` 监听（与 toolcalls/todos 一致）
  - 逻辑：`assistant/chunk` → 累积 text-delta → `tool/call` 到达时 flush 为紫色卡片
  - 不再依赖 `/stream` 开关或 `showIntermediateMessages` 设置
  - 不再调用 `markIntermediateSent`（中间消息 ≠ 最终回复，不应跳过最终卡片）

## #17 `/reasoning` 思考强度命令 —— ✅ 已实现

- **命令**：`/reasoning` 查看 / `/reasoning off|low|high|max` 设置
- **持久化**：通过 `agentDefaultModel.saveSelection()` 写入 DSH settings，重启后自动恢复
- **联动**：status 卡片 + footer 均显示当前 reasoning effort

## #12 tool call 卡片 markdown 不渲染 —— ✅ 已修复

- **问题**：`feishu-toolcalls.ts` / `feishu-todos.ts` / `feishu-questions.ts` / `feishu-approvals.ts` 使用 `{ tag: 'div', text: { tag: 'lark_md' } }`，只支持粗体/斜体/链接，不支持代码块。
- **修复**：改为 `{ tag: 'markdown', content }`（同 reply card）。`channel.ts` 的 note 区保持 `lark_md`（note 只支持 lark_md）。

## #13 卡片 Markdown 渲染不稳定 —— ✅ 已修复（Card JSON 2.0）

- **根因**：Card JSON 1.0 的 markdown 组件不支持表格、标题、内联代码等完整语法
- **修复**（2025-08-25）：
  - 全面迁移到 **Card JSON 2.0**（`schema: '2.0'` + `body.elements`）
  - 表格、标题、内联代码（反引号）原生渲染，不再降级
  - `note` 标签（2.0 不支持）替换为 `markdown` + `text_size: 'notation'`
  - 删除 `needsPlainTextFallback()`、`logReplyDiagnostic()`、`buildFooterText()` 三个废弃函数
  - 回复流程简化：始终发卡片，不再有 markdown 消息降级路径

## #16 权限系统接入 —— ✅ 已实现（2026-08-30）

- **DSH 权限**：3 种 sandbox 模式（read-only / workspace-write / danger-full-access）+ permission presets
- **Session 事件**：`sandbox/mode`、`permission/preset`，持久化在 session log
- **飞书接入**：`/permission [模式]`（`feishu-permission.ts`）交互式选择卡 + 带参直接切换；`/sandbox` 保留为隐藏别名；命名/显示名对齐 WebUI `ui-permission-presets`（Read Only / Workspace Write / Full access）；`/status` 显示 Permission。复用 `ctx.get('sandboxPolicy')` 服务 + 会话日志 log-only `sandbox/mode` 事件

## #18 思考内容展示

- **目标**：模型 reasoning/thinking 内容以卡片形式展示，内容放在代码块里防止占用过多行
- **数据源**：`assistant/chunk` 事件中 `chunk.type === 'reasoning-delta'` 的文本
- **UI 方案**：紫色卡片（同中间消息），reasoning 文字包裹在 ` ``` ` 代码块中，可折叠

## #18 思考内容展示 —— 部分完成

- **已完成**：
  - `feishu-streaming.ts` 累积 `reasoning-delta` chunks
  - 在 `assistant/message` 时发送 step 卡片，reasoning 放在代码块中
  - `/reasoning show on|off` 控制是否显示 reasoning 内容
- **待优化**：
  - reasoning 代码块可折叠（飞书 Card JSON 2.0 支持 `collapsible` 组件）
  - reasoning 长度截断策略（当前 3000 字符）

## #19 tool_call / tool_done 顺序问题 —— ✅ 已修复

- **现象**：有时飞书先收到 tool result（绿色/红色卡片），后收到 tool call（蓝色卡片），顺序反了
- **根因**：`tool/call` 和 `tool/result` 都走 `scheduleBatch`（200ms debounce），`tool/result` 到达时 `messageId` 可能还没保存（异步竞态）
- **修复**（2025-08-25）：
  - `tool/call` 卡片**直接发送**（不走批量队列），保存 `messageIdPromise`
  - `tool/result` 时 `await messageIdPromise` 确保拿到 `messageId` 后再 `updateCard`
  - 效果：一张卡片从蓝色（调用中）→ 绿色/红色（完成），不再出现两张卡片

## #9 流式输出技术方案

> 详见下方 [飞书流式输出技术方案](#飞书流式输出技术方案)。

- **现状**：每次发独立新卡片，5 QPS 限制
- **目标**：CardKit 流式更新（单卡持续更新，无 QPS 限制）
- **状态**：方案已设计，待实现

---

## 飞书流式输出技术方案

### 现状：普通卡片发送（5 QPS 限制）

```
POST /im/v1/messages → 每张独立消息，5 QPS
```

### 目标：CardKit 流式更新（无 QPS 限制）

```
POST /cardkit/v1/card {streaming_mode: true} → 创建流式卡片，拿到 card_id
POST /cardkit/v1/card/:card_id/contents      → 持续更新，无 QPS 限制
```

| 限制项 | 值 |
|---|---|
| 流式更新 QPS | **无限制** |
| 卡片大小 | 30KB |
| 组件数量 | 200 个 |
| 自动关闭 | 10 分钟 |
| 文本流式频率 | 70ms/次（可配） |

### 参考

- [流式更新卡片概述](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview.md)
- [飞书AI机器人流式输出实践](https://juejin.cn/post/7600990891206819867)
- [CardKit 流式更新 Python 示例](https://feishu.danling.org/streaming/cardkit/)

---

## Agent 消息队列调研记录

- **两层队列**：Lark SDK `chatQueue`（per-chat 串行）+ DSH Agent `Inbox`（per-agent 应用层）
- **`followup()`**：消息进 `next-turn` 队列，`wakeRequested` latch，当前 turn 完成后自动处理
- **`whenIdle()`**：spin-until-stable，等所有排队 turn 完成才返回
- **关键结论**：消息不会丢失，但飞书侧需等当前 turn 完成才能响应

---

## 飞书消息长度限制调研记录（2026-09-08）

> 出处：飞书/Lark 开放平台文档与实测参考（官方域名 `open.feishu.cn` / `open.larksuite.com` 在本机 DNS 解析为非公网 IP 无法直连，结论综合可信第三方文档 + 已知 bug 报告）。

### 平台限制（请求体上限，非字符数）
- **text（文本）消息**：请求体最大 **150 KB**
- **interactive（卡片）/ 富文本消息**：请求体最大 **30 KB**
- 来源：[Tapdata Lark-IM 文档](https://github.com/tapdata/docs/blob/main/docs/prerequisites/saas-and-api/lark-im.md)（转引官方 `im/v1/message/create` 条款）。

### 卡片 markdown 元素的隐式内容上限
- 单个 `markdown` 元素的 `content` 有**隐式长度上限**（社区实测/报告约 **~10,000 字符/元素**）。**关键坑**：超限时 Feishu API 返回 **HTTP 200、无错误**，但**静默丢弃超出部分**——客户端无从感知，看到的回复就是被截断的。
- 来源：[openclaw/openclaw#88631](https://github.com/openclaw/openclaw/issues/88631)——流式卡片 text 累积超限即静默截断；[openclaw/openclaw#70651](https://github.com/openclaw/openclaw/pull/70651) 另记录了卡片**表格数量**超限错误码（`230099`/内层 `11310`，>3 个 markdown 表格）。

### 本插件现状（截断点，均需改成分段）
| 位置 | 现在 | 问题 |
|---|---|---|
| `feishu-streaming.ts` `renderStepCard`（~792/801） | text/reasoning 各 `slice(0,3000)+'…(truncated)'` | 独立 step 卡直接截断（用户看到的主因） |
| `channel.ts` `renderReasoningForReply`（525） | reasoning `slice(0,5000)+'…(truncated)'` | 两阶段 reply 的 thinking 卡截断 |
| `channel.ts` `renderReplyCards`（546） | `chunkText(displayText, CARD_TEXT_MAX=4000)` 已分卡（≤30 张） | **已分段**，基本安全 |
| `text-chunk.ts` | `chunkText` 按段落装箱 + `capChunks` | 已具备分段工具，可复用 |

### 结沦 / 改动方向（待实现）
1. **step 卡 & reasoning 卡**：把 `…(truncated)` 硬截断改为「超限即另起一段/一张卡」——流式 step 卡本身是逐 step 更新，长 step 的 text 可用 `chunkText` 拆多张连续卡，或至少放宽到安全阈值并标注「已分段」。
2. **阈值选择**：卡片 30KB 请求体（非字符数，中文按 UTF-8 ~3B/字）换算 ≈ **中文约 1 万字**、英文约 3 万字符；单 markdown 元素另有 ~10k 字符隐式上限。`CARD_TEXT_MAX=4000` 是保守安全值，**拆卡阈值宜取 ~6k–8k 字符**，留足 markdown 开销与表头/footer 余量。
3. **text 消息回退**：超长纯文本可改发 `text` 消息（150KB，上限远高于卡片），或卡片 + 文本混合。
4. **静默截断防护**：发送前按已知上限（30KB 请求体 / ~10k 元素）本地校验并主动分段，**不要依赖飞书静默截断**。

### 待定
- 是否需要 `renderMode: auto|card|text` 配置（对齐 openclaw 建议，让超长回复回退纯文本）。
- 分段后是否在每卡加 `Part i/N` 标注（`renderReplyCards` 已有，step 卡可复用）。
