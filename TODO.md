# dsh-feishu TODO

> 定位见 [README.md](./README.md)：**把 DSH 的原生特性接入飞书，而非再造一个 agent 平台/助手**。
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

## DSH 0.1.5-rc.1 适配（已评估，2026-09-10）

> 完整评估见 [`docs/migration-0.1.5-alpha.1-to-rc.1.md`](./docs/migration-0.1.5-alpha.1-to-rc.1.md)（279 commits）。

- ✅ **插件运行时代码零改动**；依赖范围 `^0.1.5-alpha.1` **无需修改**（与 rc.1 同属 `0.1.5` tuple，semver 预发布范围自动命中）。
- ✅ 17 个被 import 的 `dsh-*` 包 `exports` map 零差异，仅 5 个包源码有变动且全为增量/注释；19 个宿主服务名全在。
- ✅ **测试环境坑（发版阻塞，已修 2026-09-10）**：`dsh-client-ui-primitives@rc.1` 把运行时依赖降为 `devDependencies`，全新安装后 `tests/client.spec.ts` 报 `Failed to resolve import "clsx"`。**采用 B1**：`vitest.config.ts` 加 `resolve.alias` 指向 `tests/stubs/ui-primitives.tsx`（按真组件可观测契约实现的四个替身），**零新增依赖、断言一条未删**。验证＝真模拟（移走 `node_modules/clsx`）：无 alias ❌ `Cannot find package 'clsx'`，有 alias ✅ 307 passed。完整记录见评估文档「问题 B」。
- ✅ **C1（高）已实现（2026-09-10）——接管 `deliverables/presented`**。但结论与最初设想不同：**只把交付物列进 Turn Complete 卡片，不推送文件**。飞书没有工作区浏览器，推送既噪音大、又会与 `feishu_send_file` 重复；清单保留了 `present` 的全部信息（模型筛过的成品 + 描述），用户真要文件时说一句即可。实现落在 `feishu-streaming.ts`（收集）+ `channel.ts` `renderFooterCard`（渲染），**没有新建 `src/feishu-deliverables.ts`**。清单排在**卡片最前面**并用分隔线与指标隔开（2026-09-10 真机反馈修正，原先夹在 stats 与元信息之间）。
- 🔲 **C2（中）`/subagents` 子代理卡片**：rc.1 有 `subagent/catalog` 事件 + 子代理排队/steer/stop，插件目前完全隐藏子代理会话。
- ✅ **C4（低）已实现（2026-09-10）**：`deriveToolSummary` 补了 `present` 分支，显示 `交付物：a.txt +2`，不再落到「工具名 · 首字段」的 `present · files` 兜底。
- 📋 **C5（记录）代理环境**：入站 WebSocket（`ws`）不认 `HTTP_PROXY` 等环境变量，纯代理出网可能「发得出收不到」；暂不处理。
- ✅ **C3 `/feedback` 无需改动**：它是宿主 `commands` 注册表命令，插件的 `commands.execute` 兜底路径已自动转发，且会出现在 `/help` 的「DSH 内置」分组。

---

## DSH 0.1.5-rc.2 适配（已评估并升级，2026-09-10）

> rc.2 距 rc.1 仅 **4 commits**（`dsh-v0.1.5-rc.1...dsh-v0.1.5-rc.2`），其中 2 个是 release/version bump，实质改动只有 1 个 Web 回移提交。

- ✅ **插件运行时代码零改动、依赖范围不变**（与 rc.1 同属 `0.1.5` tuple，`^0.1.5-alpha.1` 自动命中；实测 `semver.satisfies('0.1.5-rc.2','^0.1.5-alpha.1') === true`）。
- ✅ **17 个被插件 import 的宿主包一个都没变**：rc.2 仅改动 Web 客户端包 `ui-message-feedback`（点赞/点踩改弹窗确认）、`ui-deliverables`（产物卡片排版与间距）、`ui-primitives`（`CodeFileIcon` 重构为 artwork manifest）。`SESSION_FORMAT_VERSION` 仍为 **3**，无会话日志迁移，随时可退回 rc.1。
- ✅ `ui-primitives` 的 `Button` / `Input` / `Switch` / `StateDot` 公开契约未变（只动 `CodeFileIcon`），且 **rc.2 仍未把运行时依赖放回 `dependencies`**，故 B1 测试替身继续有效、无需调整。
- 🔲 飞书侧可受益的 rc.2 新特性：**无**（纯 Web 显示层改进，无对应聊天端口能力）。

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
| — | 卡片顺序（步骤卡优先） | ✅ 每 chat 步骤卡消息串行链 + 发卡前屏障（问题卡/审批卡/溢出续卡前先刷出并等待步骤卡消息）+ 溢出续卡显式 `await lastStepSend`；修「续卡排到更早步骤卡前」与「问题卡先于步骤卡」 |
| — | 卡片显示粒度开关 + 面板精简 | ✅ **已完成（2026-09-09）**：`showToolCalls` / `showToolArgs` / `showToolResults`（+ 已有 `showReasoning`）四个开关；工具总开关关闭时纯工具步骤不发卡；WebUI 面板改为「应用凭据 / 访问策略 / 卡片显示」三卡，移除 Provider/Model/Workspace/Agent Preset/失败提示；修 `SETTINGS_KEYS` 漏收 `showReasoning`；新增 `/display` 斜杠命令覆盖四个开关 |
| — | 防止卡片消失 | ✅ 内层 try/catch 保护 mux 事件处理，timer 回调 error-safe |
| — | 不同步骤工具调用分离 | ✅ `resetStep` 不清除 `state.chat`（session 级坐标），每个 step 独立卡片 |
| — | 提问/审批两端同时弹卡 | ✅ **已完成（2026-09-11）**：飞书绑定会话不再让 WebUI 静默失效——最外层监听器渲染飞书卡后用 `next()` 把同一请求交给 WebUI，`firstDefined()` 赛跑、谁先答谁生效；飞书胜出时用信号门中止转发（浏览器卡片消失），WebUI 胜出时飞书卡改写为「已在网页端处理」。见 `src/dual-answerer.ts` + CHANGELOG |
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
| — | 步骤卡实例更新必须等消息发出 | ✅ **已修复（2026-09-08）**：飞书在发送引用卡片实体的消息时对内容做快照，`cardkit.v1.card.update` 若早于 `sendCardByReference` 就不会进入该消息（表现为「只剩 reasoning」/「工具停在 running」）。`executeCardUpdate` 先 `await ref.messageId` 再更新。用 `im.v1.message.list` 带 `card_msg_content_type: 'user_card_content'` 拉回真实渲染内容验证 |
| — | 快步骤首发合并 | ✅ **已优化（2026-09-08）**：`STEP_CARD_DEBOUNCE_MS = 150`，首发也防抖——一步内 reasoning→call→result 全落窗口内时只发一张卡（内容已含结果）；步骤在窗口内结束或 turn/end 时 `flushPendingSend` 补发 |
| — | Turn Complete tok/s 口径 | ✅ **已修复（2026-09-08）**：首 token 判定改用 dsh-llm `isTokenDelta`（含 tool-call delta），新增 `totalDecodeTokens` 与 decode 时间同批配对，对齐 Web UI `deriveTurnMetrics`（此前「只调工具」的步骤会虚高，实测最高 2×） |
| — | 每张助手卡都带 tok/s | ✅ **已完成（2026-09-08）**：步骤卡 footer、溢出续卡、兜底回复卡 footer 均显示速度 |
| — | 步骤卡 footer 两行 + 定位信息 | ✅ **已完成（2026-09-08）**：footer 拆两行；卡片标题带「第 N 轮 · 第 M 步」；reasoning 标题带思考耗时与思考 token（`💬 **推理** · 4.3s · 1.2K tokens`）。**token 口径 2026-09-10 修订**：第一行 `⏱ 时长 · 📥 本步新输入（未缓存+缓存写入，有命中带 ♻️ NN%）→ 📤 输出`，第二行 `🚀 tok/s · 📊 上下文占用/窗口 (百分比)`——📥 不再用整段 prompt（那与 📊 是同一个数，会重复显示） |
| — | 运行中发消息提示 + steer 去重 | ✅ **已完成（2026-09-08）**：运行中发普通消息立即回一条**纯文本**提示（steer 已插入 / queue 已排队）；steer 分支不再等待本轮、不返回文本，避免同一 turn 出现两张回复卡 |
| — | 去掉用户消息的 `[Feishu] ` 前缀 | ✅ **已完成（2026-09-08）**：`reply()`/`steer()` 都不再拼通道前缀，用户文本原样进模型；纯图片/文件消息只带 image/file 块（不再补空文本块）。通道归属由 session↔chat 绑定记录，回复路由由插件决定，与文本无关。见 CHANGELOG |
| — | 步骤卡标题色带"变白底"定性 | ✅ **已定性（2026-09-08）**：插件发出的 `header.template` 始终正确，飞书服务端实体也是正确颜色；**部分客户端在卡片更新后不重绘标题背景**，属飞书客户端渲染问题，非插件 bug。取证方法：`im.v1.message.list` + `card_msg_content_type: 'user_card_content'`。不再往代码里查（详见下方「已知问题」） |

## 下一轮待办（2026-08-30 定，未动工）

> 用户最后明确：**先更新 TODO 文件，暂不动手改代码**。以下 5 项为下一轮实现计划。

| # | 功能 | 优先级 | 说明 |
|---|---|---|---|
| 1 | subagent 会话独立命令 | **中** | **主会话列表剔除 subagent 会话：✅ 已完成（2026-09-02）** —— `listSessions()` 按会话 durable header `origin === 'subagent'` 过滤（DSH 子代理会话创建时即写该字段；fork 会话只有 `parentSession`、无 `origin`，不受影响，仍显示）。`/session`、`/session list`、`/session N`、onboarding 选择卡全部经 `listSessions`，一处过滤全覆盖。剩余：新增专门命令（暂定名 `subagent`）单独查看子代理会话，数据源 `ctx.subagents.listChildren` / `listDescendants`（列名称/状态/depth），只读。**尚未动工** |
| 2 | `/steer` 与 `/queue` idle 兼容 | **中** | ✅ **已完成（2026-09-08）**：agent 空闲时 `/steer` 自动回退为发新消息，不再报错 |
| 3 | `locale` 设置 + `/lang` | **中** | ✅ 已完成（2026-08-31）：插件 `locale` 字段（`auto`/`zh`/`en`，默认 `auto`）+ `/lang [zh\|en\|auto]` 切换持久化。**语言源 = 插件字段，默认跟随 DSH**（`settings.get('locale').preference`，无值回退 `zh`）。见 CHANGELOG「中英双语 i18n」 |
| 4 | 插件文案 i18n（zh/en) | **中** | ✅ 已完成（2026-08-31）：命令响应层（`CommandTranslations` 拆 zh/en，`src/commands-i18n.ts`）+ 卡片层（`Translations` 字典 `src/i18n.ts`）：streaming/session/busy/permission/questions/onboarding/model-select/status/footer 全部双语，术语对齐 DSH。191 测试通过 |
| 5 | 测试 + typecheck + build + restart + 文档 | **中** | ✅ 已完成：改动均已补 spec，`npm run typecheck` / `npm run test` / `npm run build` 全绿，延迟重启生效，CHANGELOG 与文档同步（`AGENTS.md` 为本地开发笔记，不入库） |

---

## 待实现

> ⚠️ 状态已刷新（2026-08-30）：`#16 权限系统接入`、`/thread→/session` 改名均已**完成**，从本表移除。
>
> 下表是**条目状态归档**（含已完成项，保留以便追溯）。真正还没动工的只剩一条：**#18 reasoning 代码块折叠**。

| # | 功能 | 优先级 | 说明 |
|---|---|---|---|
| — | **`/display` 交互卡片**（卡片内设置显示开关） | **中** | ✅ **已完成（2026-09-10）**：按方案 A 落地，`src/feishu-display.ts`。无参 `/display` 发「📇 卡片显示」卡片，四个开关各一个按钮（`✅ 工具调用：开` / `⬜ 结果：关`），点击取反即持久化；**每次点击发新卡 + 上一张改写成「已失效」**（绕开「就地更新 2–3 次后按钮回调失效」）；按钮 `value` 带目标值，重复投递幂等；按 `messageId` 记住话题坐标让新卡留在原话题；发卡失败回退文本列表。测试 `tests/feishu-display.spec.ts`（9 例）。设计依据与实现差异见 [`docs/display-card-design.md`](./docs/display-card-design.md)。**未采用**方案 B 的 `checker` 多选（无需真机验证）。 |
| 18 | 思考内容**可折叠** | **中** | reasoning 代码块支持折叠（飞书 Card JSON 2.0 `collapsible` 组件）。**2026-09-08 核实**：reasoning 已收紧为 **200 字预览**（`REASONING_CAP`，不展示完整思维链）、text 超 3000 字改为拆溢出续卡；仅 `collapsible` 未实现 |
| — | **step 卡片可见性开关**（过程透明可配置） | **中** | ✅ **已完成（2026-09-09）**：新增 `showToolCalls` / `showToolArgs` / `showToolResults` 三个布尔配置（连同已有的 `showReasoning`，默认全 `true`），分别门控工具段落、`⚙️ 参数`、`📤 结果`、思考过程；`showToolCalls=false` 时工具段落整体不渲染、且**只有工具、无文字/思考的步骤不发卡**；WebUI 面板新增「卡片显示」卡承载四个 `Switch` + 插件语言。见 CHANGELOG「新增：卡片显示粒度开关 + 精简 WebUI 面板」。原记录：**后续计划**（2026-08-30 定）。step 级透明是双刃剑：对需观察/干预者有价值，对偶发使用者是打扰噪音。新增配置开关，控制三段式 per-step 卡片（💬 Reasoning / 📝 Message / 🛠 Tool call）各段展示内容，可自定义——如：①只展示其中一段；②只展示工具 description + 工具名、不展示具体 args。与 `showIntermediateMessages` 不同，是精细到"段/字段"的颗粒度 |
| 3 | ~~工作区候选补全~~ → 目录浏览器 | **中** | ✅ **已完成（2026-09-08）**：改为**目录浏览器**（比输入前缀补全更直接）——`/new` 工作区卡片新增「📂 浏览目录…」，可导航 / 分页 / 显示隐藏目录 / 选当前目录为工作区。目录来源优先 DSH `directoryPicker` 的 `browse` 能力，`native` 或缺失时回退插件自带只读列举。见 CHANGELOG「新增：/new 工作区卡片支持浏览目录」。**前缀补全本身不再做**（浏览器已覆盖）。**2026-09-08 追加**：工作区列表与目录浏览最终统一用 **`interactive_container`**（Card 2.0 整块可点击区域，官方定位就是「卡片内的列表项」）：每个工作区 / 目录一整行可点、无按钮外观、名字与路径不省略——按钮宫格 / 按内容宽度分行（飞书不认列内 `width: 'fill'`）、编号下拉框（要先选号再提交，太绕）、整行按钮（有多余按钮外观）均已弃用。控制按钮行用 `column_set` + `flex_mode: 'stretch'`（窄屏堆叠，避免手机端被压缩截断） |
| — | **旧卡片改写为「已失效」提示** | **中** | ✅ **已完成（2026-09-08）**：新增 `src/card-supersede.ts`，交互流程每发一张新卡就把上一张改写成无按钮的灰色提示卡（zh/en 双语、优先 CardKit 实例、best-effort）。已接入 `/new` 全流程（含目录浏览每一步、预设→模型交接）与 model-select 的兜底发新卡路径；`cancel`/`attach`/错误卡标记 terminal，不被改写。见 CHANGELOG「发新卡片时把被替换的旧卡片改写为『已失效』提示」。**仍待排查**：`feishu-session.ts` 面板仍是就地更新（未改成发新卡，故无失效提示可写） |
| — | **交互卡片就地更新上限** | **高** | ✅ **已修复（2026-09-08）**：飞书对同一条消息的卡片**就地更新约 2–3 次后停止投递按钮回调**（patch 与 CardKit 实例**同样**受限）。目录浏览器改「每次导航发新卡片」；`sendCard` 已不再用 `updateCardInstance`。**仍待排查**：`feishu-session.ts` 面板（切换/列表/刷新多次点击）、`feishu-model-select.ts`（provider→model→confirm 2–3 次）仍在就地更新，可能同样会失效 |
| — | **step 卡编辑次数上限** | **中** | ✅ **已修复（2026-09-08）**：step 卡改走 CardKit 卡片实例（`cardkit.v1.card.update` + 单调 `sequence`），通道未提供时回退 patch。**重要澄清**：飞书对**带按钮**的卡片就地更新约 2–3 次后停止投递回调；**step 卡没有按钮**，因此连续原地更新是安全的（详见上一条「交互卡片就地更新上限」）。见 CHANGELOG「修复：step 卡片改用 CardKit 卡片实例」 |
| — | **step 卡丢失更新（工具状态不刷新 / 卡片只剩 reasoning）** | **高** | ✅ **已修复（2026-09-08）**：① `assistant/message` 曾无条件发新卡 → 工具先开卡时旧卡被弃、再也收不到结果；改为「已有卡就更新」。② 防抖表按 session state 键 → 下一步骤的更新取消上一步骤待触发的定时器；改为按卡片 ref 键。另加 `[send]`/`[update]` 诊断日志。见 CHANGELOG「修复：step 卡片丢失工具状态更新 / 只剩 reasoning」 |
| 9 | 流式输出 → CardKit | ~~低~~ **不再做** | ~~解决 5 QPS 瓶颈。单卡持续流式更新（`streaming_mode`）~~。**2026-09-02 用户决定：不再做流式输出，方向取消** |
| — | ~~清除 `/stream`（stream on 状态）~~ | **中** | ✅ **已完成（2026-09-02）**：移除 `/stream` 命令 + `showIntermediateMessages` 配置，保留三段式 per-step 卡片更新机制（stream off/默认行为不变）。见 CHANGELOG「移除：/stream 命令及 showIntermediateMessages 配置」。原记录：**只清除「stream on = 流式更新文字」这个一直没用状态；三段式 per-step 卡片更新机制保留，stream off（默认）行为不变**。范围：`/stream` 命令（index.ts + commands.ts 注册/`/help`）+ `config.ts` 的 `showIntermediateMessages` 字段 + toggle 写入路径。**关键事实**：`showIntermediateMessages` 只在 `/stream` toggle 写入，无任何渲染路径读取——统一三段式卡片始终渲染、与开关无关，故删掉不影响默认行为 |
| 8 | 文档与版本一致性 | **低** | **README / docs/architecture.md / TODO / CHANGELOG 已同步（2026-09-08 二轮）**：per-step 卡片/footer/定位信息、reasoning 耗时与思考 token、原生附件库、busy 提示、`[Feishu] ` 前缀移除、标题色带客户端问题均已写入；README/TODO 里指向未公开 `AGENTS.md` 的链接已改指 `CHANGELOG.md`/`README.md`。版本号 `package.json` 已是 **`0.2.0`**（旧记录误写 0.1.0），发版时统一 bump |
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

### 卡片标题色带在部分客户端更新后不重绘（2026-09-08 重新定性）

**现象**：卡片更新（`im.v1.message.patch` 或 `cardkit.v1.card.update`）后，标题背景色在部分飞书客户端上消失、变成白底（`header.template` 的缺省值 `default`）；同一张卡片在另一台设备上显示正常。

**核实结论**：**不是插件 bug，也不是 patch 的问题**。用 `im.v1.message.list` 带 `card_msg_content_type: 'user_card_content'` 拉回用户可见卡片 JSON，最近 2000 条消息 / 1836 张卡片的 `header.template` 全部合法（green/blue/wathet/red/grey/turquoise），**0 张缺失或 default**，且头体一致、服务端实体颜色正确。故属于飞书客户端渲染问题。

**旧记录更正**：早期「`im.v1.message.patch` 只更新 body、不更新 header」的判断**不成立**——拉回的实体里 header 标题与 template 都已更新（例如 patch 后标题从「创建时」变为「更新后」）。真正不生效的是部分客户端的**重绘**。

**处理**：不要在插件里改 header 数据去"修"它。用户侧切换会话 / 重启客户端通常可恢复。若将来要弱化影响，方向是让状态不依赖标题色带（用标题文字/emoji 表达），而不是改数据。

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

## #18 思考内容展示 —— ✅ 基本完成（仅 `collapsible` 未做）

- **已完成**：
  - `feishu-streaming.ts` 从 `assistant/chunk`（旧版）与 `assistant/message.stream`（0.1.3）两条路径累积 reasoning-delta
  - step 卡片里 reasoning 放在代码块中，按 **200 字预览** 展示（不展示完整思维链，见 `REASONING_CAP`）
  - reasoning 标题显示思考耗时与思考 token（`💬 **推理** · 4.3s · 1.2K tokens`）
- **待优化**：
  - reasoning 代码块可折叠（飞书 Card JSON 2.0 支持 `collapsible` 组件）—— **未实现**
  - reasoning 预览字数是否做成可配置 —— 待定

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

> 出处：飞书/Lark 开放平台文档与实测参考。**查文档小技巧**：官方域名在本机解析到非公网 IP，`web_fetch` 会被拦，但用 `curl` 直连并在路径后加 `.md`（如 `https://open.feishu.cn/document/cardkit-v1/card/update.md`）可直接拿到纯 markdown 正文。

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
| `feishu-streaming.ts` `renderStepCard` | text 前 3000 字上屏、溢出用 `chunkText` 拆 `Reply (continued N/M)` 卡（**已分段**）；reasoning 只保留 200 字预览（设计如此） | 已无硬截断；reasoning 仍是预览（不展示完整思维链） |
| `channel.ts` `renderReasoningForReply` | reasoning 超过 `REASONING_CAP = 200` 时截断加 `…(truncated)`（2026-09-10 核实：此处早已统一到和步骤卡同一个 200 字常量，不再是最初的 5000） | 两阶段 reply 的 thinking 卡按设计只做预览 |
| `channel.ts` `renderReplyCards`（546） | `chunkText(displayText, CARD_TEXT_MAX=4000)` 已分卡（≤30 张） | **已分段**，基本安全 |
| `text-chunk.ts` | `chunkText` 按段落装箱 + `capChunks` | 已具备分段工具，可复用 |

### 结论 / 改动方向
1. **step 卡 text**：✅ 已完成（2026-09-08）——超 3000 字改为拆溢出续卡，不再 `…(truncated)`；reasoning 按设计收紧为 200 字预览。
2. **阈值选择**：卡片 30KB 请求体（非字符数，中文按 UTF-8 ~3B/字）换算 ≈ **中文约 1 万字**、英文约 3 万字符；单 markdown 元素另有 ~10k 字符隐式上限。`CARD_TEXT_MAX=4000` 是保守安全值，**拆卡阈值宜取 ~6k–8k 字符**，留足 markdown 开销与表头/footer 余量。
3. **text 消息回退**：超长纯文本可改发 `text` 消息（150KB，上限远高于卡片），或卡片 + 文本混合。
4. **静默截断防护**：发送前按已知上限（30KB 请求体 / ~10k 元素）本地校验并主动分段，**不要依赖飞书静默截断**。

### 待定
- 是否需要 `renderMode: auto|card|text` 配置（对齐 openclaw 建议，让超长回复回退纯文本）。
- 分段后是否在每卡加 `Part i/N` 标注（`renderReplyCards` 已有，step 卡可复用）。
