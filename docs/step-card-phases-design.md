# 步骤卡的阶段划分与 WebUI 对齐（调研 + 方案）

> 状态：**调研完成，方案待拍板（2026-09-28）——尚未动代码**。
> 关联：[`src/feishu-streaming.ts`](../src/feishu-streaming.ts)（步骤卡全部逻辑）、[`src/i18n.ts`](../src/i18n.ts)（文案）、[`docs/architecture.md`](./architecture.md)（现状说明）、[`AGENTS.md`](../AGENTS.md) 关键坑 45（步骤卡写入纪律）。
> 台账：`TODO.md` 的 **O20**。

## 一、问题（使用者原话）

> 「卡片就是在模型输出首字之前的那个卡片，和模型开始思考的卡片要区分开来。但是我希望尽量对齐 WebUI 的体验，当然不需要一模一样，对齐就行。」

一句话：**现在「首字之前」的那张卡，标题写的是「🧠 深度思考中…」——但它出现时模型连请求都还没收到；等模型真开始思考时，插件又没有任何实时信号，卡片标题已经变成「回复」了。** 该说「等待」的时候说「思考」，该说「思考」的时候说「回复」。

## 二、现状：插件是一步一卡、四阶段就地更新

| 阶段 | 触发信号 | 卡片标题 | 颜色 | 正文 |
|---|---|---|---|---|
| 占位 | `step/start`（**DSH 在发请求之前** append） | `🧠 深度思考中…` | violet | 「⏳ 模型正在思考，输出会就地更新在这张卡上」+ 每 5s 刷新已用时（`PLACEHOLDER_TICK_MS = 5000`） |
| 推理/正文落地 | `assistant/message`（**整条消息一次性到达**） | 立即变 `回复` | blue | `💬 推理`（前 200 字，`REASONING_CAP = 200`，超出截断）+ `📝 消息` |
| 工具开始 | `tool/call` | `工具调用` | wathet | `> 摘要` + 运行中 |
| 工具结束 | `tool/result` | `工具完成` / `工具出错` | green / red | 结果预览 |
| 空步收尾 | `step/end` 且该步始终无可见内容 | `本步无输出` | grey | — |

**根因（两条，都在 0.1.3 之后成立）**：

1. **`step/start` 早于请求**：DSH 的 agent loop 先 append `step/start`，之后才组装 system/user 消息、冻结请求（`request/header`）、把 HTTP 打出去。所以占位卡诞生的那一刻，模型**什么都还没收到**——「深度思考中」是从第一步就写错的措辞。
2. **token 级增量不再是持久事件**：`assistant/chunk` 已从 `session/event` 移除，插件订阅的正是持久总线（`ctx.on('session/event', …)`），因此**结构上**看不到任何未提交的增量。`src/feishu-streaming.ts` 里那段 `assistant/chunk` 分支现在是**只累加、不发卡的历史遗留**；连 `⏱` / `🚀` 的 TTFT 也是从 `assistant/message.stream` 内各 chunk 的时间戳**反推**的近似值。

结论：**「等待首字」与「开始思考」的分界，本质上要求接一条实时流**——但那不等于必须大改，见第五节。

## 三、对齐目标：WebUI 实际怎么演

WebUI 手里有插件没有的实时流，它的呈现是「一个会 shimmer 的过程组标题 + 一条实时详情行 + 推理/正文分开的块」：

| 位置 | 行为 | 依据（DSH 源码） |
|---|---|---|
| 过程组标题（运行中） | `正在分析请求`（thinking）/ `正在运行命令` / `正在读取文件` / `正在搜索代码` / `准备调用工具`…，带 shimmer 动画 | `packages/client/ui-chat/src/client/locale.ts` 的 `message.stepProcess.*`；`ChatGroupSeat.tsx` |
| 详情行（标题右侧，受 `liveProcessDetail` 策略控制，standard / detailed 开） | **没有工具在跑时 = 最新一段推理的尾部**（≤160 字）；有工具在跑时 = 该工具的实时详情 | `conversation-nodes/process-activity.ts` 的 `liveReasoningDetail()` |
| 推理 | **独立的折叠行**，默认收起，摘要取「最近一个完整段落的首行」，展开才是全文 markdown | `chat/ReasoningRow.tsx` |
| 正文 | 逐字流式，与推理分开渲染 | `conversation-nodes/assistant.ts` 的 blocks 模型 |
| 结束后 | 标题变 `已完成分析` / `已读取文件、执行了命令` 等汇总 | `chat/step-process.ts` |

**重要观察**：WebUI 的**标题本身也不区分**「等待首字」和「思考中」（都叫「正在分析请求」）。它是靠 **① 详情行开始出现内容、② 推理折叠行开始出现** 来让人感知「开始思考了」。这一点直接决定了方案取舍——不必为了「有区别」去发明新词表，先有实时信号才是关键。

## 四、可用信号清单（逐条查过 DSH 源码）

| 信号 | 到达时机 | 持久？ | 能界定什么 |
|---|---|---|---|
| `step/start` | 步骤开始，**请求发出之前** | ✅ 持久 | 「步骤开始了」 |
| `request/header` | 请求冻结、**即将发出**（带 provider / model / 工具表） | ✅ 持久 | **「首字之前」的准确边界**——插件目前完全没订阅它 |
| `agent/assistant-stream` 的 `start` 帧 | `preparedCall.stream()` 之后、**第一个 chunk 之前** | ⚡ 实时（进程内 emit） | 「请求已发出，等首字」 |
| 第一个 `chunk`（`reasoning-delta` / `text-delta` / `tool-call-delta`） | 首字到达 | ⚡ 实时 | **「开始思考」/「开始回复」的唯一即时判据** |
| `assistant/message` | 整条消息 + usage 一次性落地 | ✅ 持久 | 权威内容与用量（去重后的唯一真源） |
| `assistant/attempt` | 只在 abort / error / retry 落地 | ✅ 持久 | 被打断的部分流 |
| `tool/call` / `tool/result` | 工具调用与结果 | ✅ 持久 | 现状 |

两个关键结论：

1. **「首字之前」不需要任何新能力**：`request/header` 是持久事件，今天就能订阅，足以把「步骤开始」和「请求已发出、等首字」拆成两张/两种状态，并顺带把 route（`provider/model`）写进卡里。
2. **「开始思考」需要实时流，但不必用 `sessionController.follow()`**：`agent/assistant-stream` 是 agent-scoped 的 `emit` 事件（`packages/core/agent/src/runtime-types.ts`、subject 解析见 `packages/core/scope/src/scoped-events.generated.ts`），插件用
   `ctx.on('agent/assistant-stream', handler, { global: true })`
   即可收到 `{ agent, frame }`，按 `agent.session.id` 过滤——**与插件现在订阅 `subagent/start` / `subagent/end` 是同一套写法**。帧序列为 `start → chunk… → end`，重试会更换 `attemptId` / `revision`，天然提供「这次尝试作废、重新开始」的信号。
   （`sessionController.follow({ assistantStream: true })` 同样可行，但那条路要自己处理快照 / 游标 / seq 校验，此处没有必要。）

## 五、方案（成本递增；推荐先 2，再视需要上 3）

### 方案 1 —— 只改文案与边界（不接实时流）

- `step/start` → `⏳ 正在分析请求 · 第 N 轮·第 M 步`（对齐 WebUI 的 `正在分析请求`，把「深度思考」从这个阶段拿掉）
- `request/header` → `📡 已发出请求，等待首个输出`，正文写 route（`provider/model`）+ 已用时
- 只有真的出现推理时（`assistant/message` 中 reasoning 非空）才用「思考」措辞
- 改动面：`feishu-streaming.ts` 一个 handler + 若干 i18n key。**风险最低**，但它治的是「用词错位」，**不能**在思考期间告诉你「开始思考了」。

### 方案 2 —— 接实时流，但只用来切阶段（**推荐先做这档**）

订阅 `agent/assistant-stream`，把帧映射成卡片状态；**内容仍然等 `assistant/message` 落地后渲染**（不逐字上屏）：

| 卡片状态 | 触发 | 标题 | 颜色 |
|---|---|---|---|
| 等待首字 | `start` 帧 | `📡 已发出请求，等待首个输出` | violet |
| 思考中 | 第一个 `reasoning-delta` | `🧠 思考中…`（可选：附最新一段思考的尾部） | violet |
| 回复中 | 第一个 `text-delta` | `✍️ 回复中` | blue |
| 完成 | `assistant/message` / `step/end` | 现状（`回复` / `工具完成` / `本步无输出`） | 现状 |

- 每步只多 2–3 次卡写入，不动内容渲染，**直击「区分两张卡」的诉求**；顺带把 TTFT / tok-s 从「时间戳反推」变成真实到达时间。
- 改动面：`feishu-streaming.ts` 新增一个订阅 + 少量状态位 + `stop()` 里退订；i18n 若干 key。

### 方案 3 —— 完整对齐 WebUI（推理 / 正文也流式上屏）

在方案 2 之上把 live chunk 直接渲染进卡片：推理只显示**最新一段的尾部**（像 WebUI 的详情行，而不是现在的「开头 200 字截断」），正文逐字更新；`assistant/message` 到达时用权威内容**整体替换**（去重，不叠加）。

- 收益最大（飞书里终于有「正在写」的感觉），风险也最大：飞书卡片有速率限制（历史上撞过 `230020`），而 WebUI 是本地的、没有这层限制，**节奏不能照抄**，节流大概要放到 0.5–1s/次。
- 必须沿用既有写入纪律：**一卡同时只允许一次写入在飞、只保留最新一版**（`writeSlots`）、送达判据按构建顺序盖戳（`turnTextOrder`），以及关键坑 45 那条「步骤卡自己的 send 不能过排序屏障」。

### 附带的对齐小事（不论选哪档都建议做）

- 工具段落措辞从通用的「工具调用」换成 WebUI 的活动词表（`正在运行命令` / `正在读取文件` / `正在搜索网页`…），结束时用「已…」汇总；
- 推理段落的呈现从「开头 200 字 + 截断」改成「最近一段的首行 / 尾部摘要」（WebUI 就是这么折叠的）；
- 显示开关语义保持不变：`showReasoning = false` 时不流推理**内容**，但「思考中」这个**状态**仍可显示。

## 六、实施要点与纪律（无论选哪个方案）

1. **写入纪律不能破**：关键坑 45 的三条（步骤卡 send 不过聊天排序屏障、一卡一次写入在飞且只留最新、按构建顺序盖戳判送达）是上次「卡在深度思考中」事故的定语；新增的阶段性写入会**提高**写入频次，必须走同一套 `updateStepCard` / `recordKeyFor` 路径，不得另开直连。
2. **去重**：`assistant/message` 是权威内容与 usage 的唯一真源；实时累积的内容在它到达时必须被**替换**而不是追加。
3. **重试与中断**：`agent/assistant-stream` 的 `start` 帧带新 `attemptId` / `revision`，收到即重置本步的实时累积；`assistant/attempt`（abort / error / retry）是部分思考流的持久落点。
4. **生命周期**：订阅在插件 `stop()` 时必须退订；只为**已绑定飞书聊天**的会话工作（沿用 `bridge.resolveChat(sessionId)` 的判据，关键坑 31：不按群推话题）；`turn/end` 清掉本轮的实时状态。
5. **实时总线不要越界读**：不要为了拿增量去无参 `snapshotEvents()`（关键坑 8）。
6. **验证方式**：真机在飞书里跑一轮「长思考 + 工具 + 长回复」，看四段状态是否按序出现、卡片是否只更新不重发、journal 是否干净；`230020` 与「卡停在旧内容」两处是重点观察项。

## 七、待拍板（拍完即可开工）

1. **选哪档**：方案 1（只换文案、不接流）/ **方案 2（接流只切阶段，推荐）** / 方案 3（连内容也流式）。
2. **「思考中」卡上要不要带内容**：只显示状态 + 已用时；还是像 WebUI 那样带一行「最新一段思考」的尾部（节流更新）。
3. **标题词表是否整体换成 WebUI 的说法**：会改掉现有的「🧠 深度思考中…」「工具调用」等字样，属可见的体验变化。

> 建议：**方案 1 的文案 + 方案 2 的订阅合成一个批次做**（同一个 handler，一次改完、一次验证），按仓库约定一个批次一个 commit、跑测试 + typecheck + 重建产物 + 按关键坑 14 延迟重启验证。
