# 上下文注入、压缩摘要与显示级别：与 WebUI 的对齐调研

> 状态：**调研完成；§1 注入与 §2 压缩已拍板，§3 显示档位待拍板（2026-09-28）——尚未动代码**。
> 修订：2026-09-28 第二版按使用者质疑复核，**更正了 §1.1（来源是开放集合，不是 8 种）/ §1.2（注入行会被整轮折叠）/ §1.4（真实频次远低于第一版采信的单次开发期会话）**；同日第三版按使用者第二次提案把 §1.5 改为**插进所属 step 卡正文最前面**（原「独立卡片」决定作废），并新增 **§1.6 位置实测** 作为核验依据；同日第四版按使用者第三次决定收紧为**只显示一行提示、不渲染注入内容**（`form` 正文渲染与截断逻辑一并取消）。
> 关联：[`src/feishu-streaming.ts`](../src/feishu-streaming.ts)（`session/event` fan-out 与步骤卡全部逻辑）、[`src/feishu-display.ts`](../src/feishu-display.ts)（`/display` 卡片）、[`src/config.ts`](../src/config.ts)（4 个显示开关）、[`docs/step-card-phases-design.md`](./step-card-phases-design.md)（O20，同一片代码、同一批信号）、[`docs/display-card-design.md`](./display-card-design.md)。
> 台账：`TODO.md` 的 **O21**（注入与压缩完全不可见）、**O22**（显示级别不对齐）。
> 依据的 DSH 版本：**0.2.0-rc.1**（`dsh-v0.2.0-rc.1` = `4878cdabd8`）。下文所有源码路径都相对 DSH 检出根。

## 零、结论摘要

| # | 缺口 | DSH 侧事实 | WebUI 怎么演 | 飞书现状 | 建议修法 |
|---|---|---|---|---|---|
| 1 | **上下文注入不可见**（AGENTS.md、技能目录、子代理通知…） | 注入是**持久** `user/message` 事件（`data.source.kind !== 'user'`）；来源是**开放集合**（17+ 个声明点，实测出现过 12 种） | 一条可折叠的「上下文注入」行；展开按 6 种 `form` 分派；**但会被整轮折叠吃掉**（§1.4②） | handler 只认 `source.kind === 'tool-jobs'`，其余**全部静默丢弃** | **插进「声明它的那个 step」卡片正文最前面，且只显示一行提示、不渲染注入内容**（✅ 见 §1.5；位置实测 §1.6） |
| 2 | **压缩不可见**（自动压缩 + `/compact`） | `compaction/start` → `compaction/summary` → `compaction/end`（失败时 `end` 带 `error`），外加一条 replacement checkpoint | 「上下文已压缩 · 已折叠 N 条历史 · ~M tokens」+ 展开看摘要 | **完全没有订阅**（`compaction/*`、`command/*` 都没订阅） | 一张压缩卡：进行中 → **详情行在折叠区之上、摘要可折叠且 ≤200 字** → 收尾/失败原因（✅ 已拍板，见 §2.4） |
| 3 | **显示级别不对齐** | WebUI 是**一个 4 档枚举 + 4 条策略轴** | 简洁 / 标准 / 详细 / 完全展开（默认「详细」） | **4 个互不相干的布尔**（思考 / 工具 / 参数 / 结果），轴的含意都不同 | 引入同名的 4 档 `transcriptView` 作权威档位，4 个布尔降为「自定义」档的细分 |

三件事的**共同点**：都落在 `session/event` 这一个 handler 上，而且第 3 件的档位决定前两件**能给出多少细节**（档位越高，注入块与压缩摘要给得越全）。建议顺序 **2 → 1 → 3**（压缩卡与注入各自独立可发；级别落地后回头把前两件的详略接上档位）。

---

## 一、缺口一：上下文注入在飞书完全不可见

### 1.1 DSH 侧：注入是持久事件，不是隐藏的请求头

`@deepseek-ai/dsh-agent-instructions`（`packages/context/agent-instructions/`）把工作区指令文件（`AGENTS.md` 这一族）作为**上下文消息**写进会话；同族还有技能目录、插件清单、跨会话召回、子代理结算通知等。它们的持久形态**统一是 `user/message`**，靠 `data.source.kind` 区分。

**这不是一份固定清单**：`MessageSourceMap`（`packages/llm/llm/src/message.ts:110`）是 merge-extensible 接口，任何插件都能 `declare module` 往里加一种——0.2.0-rc.1 里有 **17 个真实声明点**。所以渲染**必须按未知 kind 兜底**，不能写死一张表。本次全量会话统计里实际出现过的：

| `source.kind` | `form` | 何时出现 | 有价值的字段 |
|---|---|---|---|
| `agent-instructions` | `instructions` | 基线一次（`baseline: true`）+ 每次 `read`/`write`/`edit` 碰到指令文件时的增量 | `changes: [{action, scope, path, digest}]`、`baselineIdentity` |
| `skill-catalog` | `catalog` | 可用技能集合变化时 | `entries` |
| `plugin` | `snapshot` | 存活插件包清单变化时 | `plugin`、`sections` |
| `runtime-context` | — | agent-loop 的动态运行时快照变化时（`packages/core/agent-loop/src/runtime-context.ts`） | 整段快照文本 |
| `session-reference` | `recall` | 跨会话召回 | `references: [{label, …}]` |
| `skill-invocation` | — | 模型调用某个 skill | `name` |
| `model-selection` / `plan-mode` / `user-approval` | 多为 `notice` / 无 | 模型切换 / 计划模式进出 / 审批结果回填 | 各自的判定字段 |
| `agent-message` | `relay` | 别的会话发来的消息 | `senderSessionId` |
| `subagent-settled` | `notice` | **子代理结算**（宿主把结果注入父会话） | `senderSessionId`、`summary` |
| `tool-jobs` | — | 后台任务完成通知（**插件已识别**，见 O11） | 任务 id / 结果 |
| `goal` | — | 目标轮次推进 | `goalId`、`revision`、`round` |
| **`compact-checkpoint`** | — | 压缩落地时的替换型 checkpoint | **必须排除**，见 §2.3 |
| 其余（`time-context`、`tmux-context`、`schedule`、`repeat-tool-reminder`、`team-message`、`hooks-*`、`cordis-host-runner`…） | 多为 `notice` / 无 | 各自插件决定 | — |

另有一族 `developer/message`（`packages/session/session-format-v3-to-v4/src/developer.ts`）走同一套展示，插件同样没订阅。

`content` 是**给模型看的整段文本**。一次真实采样：一条 `agent-instructions` 基线 6258 字（开头就是 `<system-reminder>The following workspace instructions may be relevant to your work.…`）。

### 1.2 WebUI 侧：一条可折叠的「上下文注入」行

- 分类：`packages/client/ui-chat/src/client/conversation-nodes/message.ts:76` 只判断 `event.data.source.kind !== 'user'`，是就造 `kind: 'context'` 节点（`developer/message` 走 `developerMessageDefinition`，共用同一套呈现）。
- 渲染：`packages/client/ui-chat/src/client/chat/ContextInjectionRow.tsx` —— 标题 `上下文注入`（`producer.role === 'recall'` 时是 `跨会话召回`），标题右侧是 **producer label**（`agent-instructions` 取 `changes[].path`，如 `AGENTS.md`；`skill-invocation` 取 skill 名），只有 `notice` 形态额外带一行摘要。整行默认**收起**，点开才看正文。
- 正文按 `form` 分派 6 种（`packages/client/ui-chat/src/client/chat/ContextBody.tsx:551`）：`instructions` / `catalog` / `snapshot` / `notice` / `relay` / `recall`；**form 缺失或本版本不认识就退回 opaque**（把 `source` 字段原样列出来）——这条兜底很重要：未知来源也必须能渲染。
- **⚠️ 这些行其实会被「整轮折叠」吃掉**——本文档第一版写的「不随显示级别折叠」**是错的**，正确机制见 §1.4②。

### 1.3 飞书侧现状

[`src/feishu-streaming.ts:1469`](../src/feishu-streaming.ts) 的 `user/message` 分支只做一件事：判断「本轮是不是被后台任务完成通知唤醒的」（O11）。命中条件是 `source.kind === 'tool-jobs'`，**其余来源一律落空**（来源是开放集合，§1.1）——`agent-instructions` 连一行日志都没有。

后果：使用者看不到「这一轮被喂了哪些上下文」；**子代理结算通知**（`subagent-settled`）看不到；跨会话召回（`session-reference`）看不到；指令文件被改动时的增量（`changes`）也看不到。

### 1.4 实测：真实频次，以及 WebUI 为什么看起来不频繁

**① 频次（全量会话统计：73 个会话、逐条解压后统计非 user 的 `user/message`）**

| 指标 | 值 |
|---|---|
| 每个会话的注入条数 | **中位数 3** · 均值 41 · p90 275 · 最大 306 |
| 长会话的每轮注入 | 约 **0.4 – 1.2 条/轮**（样本 306/260 轮、286/762 轮、281/747 轮） |
| 按 kind 的总量 | `agent-instructions` 1221 · `plugin` 811 · `skill-catalog` 629 · `subagent-settled` 99 · `runtime-context` 89 · `agent-message` 70 · `tool-jobs` 23 · `goal` 19 · `model-selection` 12 · `plan-mode` 2 · `user-approval` 2 |
| 0 条注入的会话 | **0**（每个会话至少有会话开始那一批：AGENTS.md 基线 + 插件清单 + 技能目录） |

> **❗重要更正（2026-09-28，使用者质疑后复核）**：本文档第一版写「一次 39 轮样本会产生 55 张注入卡 → 聊天会被淹没」，并据此建议飞书侧默认聚合。**那个结论是错的**：
>
> - 那 55 条来自**一次开发期会话**——在里面 `AGENTS.md` 自己被测了 19 次（内容 6258 → 6501 字逐版增长，每次改动触发一条 `agent-instructions`），插件集也在反复变动（14 条 `plugin`）。它**不代表常态**。
> - 常态是**每个会话 3 条上下**（中位数），其中 2–3 条是会话开始时的固定批次；长会话每轮约 0.4–1.2 条。
> - ⇒ 「淹没」不成立。按真实频次，「每次注入一张卡」完全可承受。

**② 可见性：WebUI 里这些行其实被「整轮折叠」吃掉了**

第一版还写「注入行不随显示级别折叠」——**同样错了**，真实机制恰好相反：

- `packages/client/ui-chat/src/client/contract/turn-process.ts:32` 的 `TURN_PROCESS_INDEPENDENT_KINDS` 明确列出「**不参与**回合过程折叠」的 kind：`system-prompt` / `user` / `steering` / `turn-trigger` / `turn-process` / `turn-error` / `turn-max-tokens` / `turn-tail` —— **`context` 与 `compaction` 都不在名单里**。名单语义是「independent of a Turn's process disclosure」，没进名单就是**过程内容**。
- 于是注入行被判为**过程组成员**：`ChatNodeSeat.tsx:83` 的 `processMember` = 非独立 kind + `anchorSeq` 落在 `[turn.start.seq, answerAnchorSeq)` 窗口内（`turn-process.ts:161` 的 `processStartSeq = turn.start?.seq`）。
- 过程成员在 `ChatNodeSeat.tsx:110` 的 `processHidden` 下被整段隐藏（`useSearchableHidden`）；回合结束后整轮过程再折一次（`ChatGroupSeat.tsx:152` 的 `outerHidden`）。
- 使用者的 WebUI 默认观感正是如此：本机 profile 把 `ui-chat.transcriptView` 钉在 legacy 值 `expanded`，**0.2.0 读作 `detailed`**，而 `detailed` 的 `foldCompletedTurns: true`。
- `packages/client/ui-chat/src/client/conversation-nodes/README.md` 的「What the reader sees」表同口径：整轮折叠时只剩「输入、整轮控制条、最终回答、footer」，**没有任何过程内容**。
- 唯一会独立成行的是**唤醒型**注入：把一个空闲 agent 唤醒的注入被归为 `turn-trigger`（在独立名单里）→ 独立可见（`conversation-nodes/message.ts:88-91` 的 `waking` 判定）。

⇒ 结论两条：**(1)** WebUI 对中途注入的实际呈现是「折进该回合的过程里」，要展开那一轮才看得见——这就是「感觉不频繁」的真正原因；**(2)** 飞书没有折叠层，注入在飞书天然比 WebUI 显眼。这一点上「对齐 WebUI」没有可抄的视觉范式，只能按飞书自己的介质定（使用者要的正是「看得到具体行为」）——**最终形态见 §1.5：插进所属 step 卡的最前面**。

### 1.5 形态（2026-09-28 第二次修订：插进所属 step 卡，不再单独发卡）

使用者提案（原话）：

> 「能否把注入提醒放在现有卡片里面？也就是在哪个步骤注入，就把消息插入到哪里。……1. 如果是在调用模型之前发生了注入，那就在这个 step 卡片的最前面显示"注入 agent MD"。2. 如果是在模型调用之后、下一个 turn 之前，那就在这个卡片的最后（即 footer 之前）加上注入的消息。」

**核验结论：位置模型成立，但方向比提案更简单——"情况 2"在持久事件里根本不存在（§1.6 实测）**：DSH 是在步骤**认领收件箱**的那一刻把注入落盘的，所以"语义上晚到"的注入（子代理结算、会话间消息）也会被物化到**下一个 step 的开头**，而不是上一步的末尾。因此只有一条规则：

> **每条注入都插进「声明它的那个 step」的卡片正文最前面。**

| 注入落点 | 占比 | 处理 |
|---|---|---|
| `step/start` 之后、`request/header` 之前 | **93.0%**（2408/2589） | 卡片已在屏上（`step/start` 发的占位卡）→ 就地重渲染，把注入块放在正文最前 |
| `step/start` 之前（**全部发生在压缩事务里**重新注入插件清单，或会话启动时） | **6.8%**（177/2589） | 先进内存缓冲；等那个 step 的 `step/start` 时随首版卡片一起渲染 |
| `request/header` 之后、回复之前 | **0.15%**（4/2589） | 仍按"插到本步卡片最前面"处理（属本步上下文；只是该请求已冻结，模型这一次看不到它） |

**明确不做**：不再单独发"注入卡"（第一版的决定作废）；不做"追加到卡片末尾 / footer 之前"那一档（没有事件落在那个位置）；Turn Complete 卡也不承载注入汇总。

顶部注入块的规格（`user/message` 且 `source.kind` 不是 `user` / `compact-checkpoint` 时触发）：

> **使用者决策（2026-09-28，第三次修订）：只显示一行「提示」，不渲染注入的内容。**
> ⇒ 因此**不需要**按 `form` 渲染正文（第一版里那张 instructions / catalog / snapshot / notice / relay / recall 的表**作废**），也**不需要**任何截断逻辑：`content`（给模型看的那整段文本，实测一条 6.2k 字）根本不进卡片。**提示行里的信息全部来自 `source` 的元数据，不来自 `content`。**

| `source.kind` | 提示行（只有这一行） |
|---|---|
| `agent-instructions` | `📥 注入上下文 · AGENTS.md（已更新）`——路径取 `changes[].path`（多个用 `、` 连接），动作照抄 WebUI 的 `instructionAction(action, baseline)`：`remove`→已移除、`baseline`→已载入、非 baseline 的 `set`→已新增、`replace`→已更新 |
| `skill-catalog` | `📥 注入上下文 · 技能目录（N 条）` |
| `plugin` | `📥 注入上下文 · 插件清单（N 个包）` |
| `runtime-context` | `📥 注入上下文 · 运行时快照` |
| `session-reference` | `🔗 跨会话召回 · <references[].label 连接>` |
| `skill-invocation` | `📥 已载入技能 · <name>` |
| `agent-message` | `✉️ 会话间消息 · 来自会话 <senderSessionId>` |
| `subagent-settled` | `🤖 子代理已结算 · <senderSessionId>`（**不显示 `summary`**，那是内容） |
| `goal` / `model-selection` / `plan-mode` / `user-approval` | 各自一行标题 + 一个判定字段 |
| **`tool-jobs`** | **不在顶部重复**：它已有 O11 的「本回合由后台任务完成通知触发」标记 |
| 未知 `kind` | `📥 注入上下文 · <kind>`（只报种类，**不渲染原始字段**） |

两条可再收紧的地方（等使用者一句话就能改）：① 是否连 `<路径>` / `<skill 名>` 这些**元数据**也去掉，只留「📥 注入上下文」；② `N 条` / `N 个包` 这类计数是否保留（计数同样来自元数据，不来自内容）。


**为什么要缓冲**：注入可能先于 `step/start` 到达（6.8%），此时那一轮还没有卡片。缓冲到该 step 建立卡片时并入首版；若该会话此后**再也没有 step**（纯空闲），这条注入就不显示——可接受（聊天里本来也没有卡片可挂）。

**有注入的 step 必须发卡**：现状是每个 step 都在 `step/start` 发占位卡，所以天然满足；但今后若改动发卡策略（例如"工具独占的 step 不发卡"），必须保留"有注入就一定发卡"这条例外，否则注入会静默消失。

**体量（已按 §1.4 更正）**：注入只落在**2.7% 的 step** 上（1658/62141），其中绝大多数是 1 条（1227 个 step）、会话开始那批是 3 条（309 个 step）。改成"插进卡片"之后**卡片总数不增加一张**，只是这些 step 卡**多一行提示**。

### 1.6 位置实测（对提案的核验依据）

115 个会话目录（同目录只取最新版本文件）、逐条解压统计，共 **2589 条**非 user 注入：

| 位置 | 条数 | 占比 |
|---|---|---|
| 步骤内、`request/header` 之前 | 2408 | **93.0%** |
| 步骤外（该 `step/start` 之前） | 177 | 6.8% |
| 步骤内、`request/header` 之后、回复之前 | 4 | 0.2% |
| **模型回复之后 / `turn/end` 之后（＝提案的"情况 2"）** | **0** | **0%** |

按 kind 看（同一批数据，位置用 A=步骤内请求前 / C=步骤间 / D=步骤外）：

| kind | 总数 | 位置 |
|---|---|---|
| `agent-instructions` | 1230 | A 全部 |
| `plugin` | 509 | A 332 · **D 177** · C 4 |
| `skill-catalog` | 437 | A 全部 |
| `runtime-context` | 170 | A 全部 |
| `subagent-settled` 76 · `tool-jobs` 64 · `agent-message` 53 · `model-selection` 27 · `goal` 16 · `user-approval` 4 · `plan-mode` 2 · `tool-goal` 1 | 243 | A 全部 |

三条可直接核对的原始轨迹（`seq` = 会话内序号，同一会话）：

```
step/start(1)@8 · system/message@9 · user/message[user]@10
  → user/message[agent-instructions/baseline]@11 · [plugin]@12 · [skill-catalog]@13 → request/header@14

step/end(52)@292 · agent/inbox/spliced@293 · step/start(53)@294
  → user/message[agent-message]@295 · [subagent-settled]@296 → assistant/message(53)@297

step/end(59)@331 · agent/inbox/spliced@332 · step/start(60)@333
  → user/message[agent-message]@334 → assistant/message(60)@335
```

**那 177 + 4 条"步骤外"注入的真相**：它们**无一例外**都是这个形状——`compaction/start` → `compaction/summary` → **`user/message[plugin]`** → `compaction/end` →（`agent/inbox/spliced` →）`turn/start` 或 `step/start(step=1)`。即：**压缩事务里重新注入的插件清单**（压缩替换了模型表面，会话级上下文必须在新表面里重新声明），紧接着就被下一个 step 认领 ⇒ 仍归"下一个 step 卡的最前面"。

**另外两条与卡片设计有关的事实**：

1. 注入**总是先于它所归属的那次请求**落盘（93%），所以"顶部块"恰好是「这一次请求确实读到了它」的可视证据——这正是使用者想要的"看得到具体行为"。
2. 会话里 `request/header` 很稀少（一次 1000 步的会话里只有 14 条），因此**不能**拿它当"每步都发"的边界信号（这一点对 O20 的方案 2 同样重要）。

⇒ 结论：提案的**情况 1 覆盖 93%**；剩下的 7% 全是"压缩后重注入 / 会话启动"，用**缓冲到下一个 step** 即可；**情况 2 没有对应事件，无需实现**。

---

## 二、缺口二：压缩在飞书完全不可见

### 2.1 DSH 侧：一次压缩是三个持久事件 + 一条 checkpoint

自动压缩跑在**步骤之间**（`packages/compaction/compaction-basic/src/index.ts:144` 的注释即 "automatic between-step pressure and model-request overflow"），也可以由 `/compact` 手动触发（`compaction/start` 带 `sourceCommandId`）。事件序列（`compaction-basic/src/region.ts:210/491/237`）：

| 事件 | 载荷 | 说明 |
|---|---|---|
| `compaction/start` | `{compactionId, turn, sourceCommandId?}` | 已提交的开场标记 |
| `compaction/summary` | `{compactionId, summary: ContentBlock[], shadowedRange:{start,end}, shadowedSeqs: number[], shadowedTokenCount, provider, model, usage?}` | 摘要内容与「折叠了多少」 |
| `user/message`（checkpoint） | `source.kind === 'compact-checkpoint'`，带 `surfaceOp: {op:'replace', startSeq, endSeq}` | **替换型**表面事件：模型侧被折叠掉的那段历史 |
| `compaction/end` | `{compactionId, turn, sourceCommandId?, error?}` | 成功无 `error`；**失败时这里带 `error` 链，且没有 `summary`** |

一次真实采样：`shadowedSeqs` 609 条、`shadowedTokenCount` ≈ 302k。

**失败形态要专门处理**：`compaction/end` 是唯一带 `error` 的事件，且失败路径**不会**有 `summary`。所以卡片不能假设「start 之后必然有 summary」。

### 2.2 WebUI 侧：一行可展开的压缩标记

- 节点：`packages/client/ui-chat/src/client/conversation-nodes/compaction.ts`（自动压缩，`kind: 'compaction'`）+ `packages/client/ui-chat/src/client/conversation-nodes/command.ts`（手动 `/compact` 折进 `manual-compaction`）。
- 渲染：`packages/client/ui-chat/src/client/chat/CompactionItem.tsx` —— 标题 `上下文已压缩`（手动时是 `compact`），右侧摘要 `已压缩 {items} 条历史记录（约 {tokens} tokens）`；**只有**当前窗口还留着摘要事件时按钮才可点，展开显示摘要 markdown；拿不到计数就退回命令的结算文本或 `压缩摘要不可用`。
- 与注入行同理：`compaction` **也不在** `TURN_PROCESS_INDEPENDENT_KINDS` 里 ⇒ 它是**过程组成员**，回合结束后会跟着整轮过程一起被折掉（机制与取证见 §1.4②）。

### 2.3 飞书侧现状

插件**完全没有订阅** `compaction/*`。连带后果：

1. 自动压缩发生时聊天里**没有任何迹象**——使用者不知道模型刚丢掉了 609 条历史；
2. `/compact`（DSH 自带的 `command-compact`，插件不再自己注册同名命令）也没有任何反馈；
3. 更隐蔽的一条：checkpoint 也是 `user/message`。它落在 `src/feishu-streaming.ts:1469` 那个分支上，**目前不会误伤**（`sawTurnUserMessage` 只在 `source.kind === 'tool-jobs'` 时才被用来判定触发原因），但接线时**必须显式排除** `compact-checkpoint`，否则将来任何「第一条 user/message 就是触发原因」的推论都会被它污染（`packages/client/ui-chat/src/client/conversation-nodes/message.ts:39` 的 `isCompactionCheckpoint` 就是上游的同款排除）。

### 2.4 已拍板的形态（2026-09-28）

使用者决策（原话：「压缩的摘要内容：设置为可折叠显示，字数上限按 200 字」「压缩的详情（例如压缩了多少轮对话、多少 token）：显示在折叠部分之上」「界面调整：不要那个发文按钮」）：

```
🗜️ 上下文已压缩                          ← 标题（手动 /compact 时用 /compact）
已折叠 609 条历史记录 · 约 302k tokens    ← 详情行：在折叠区【之上】
 ▸ 摘要                                  ← 可折叠区：最多 200 字
```

| 触发 | 卡片 | 颜色 |
|---|---|---|
| `compaction/start` | `🗜️ 正在压缩上下文…` + 触发者（自动 / `/compact`） | grey |
| `compaction/summary` | 详情行（`shadowedSeqs.length` 条历史 · `shadowedTokenCount` tokens · `provider/model`）+ 折叠区（摘要 ≤200 字） | green |
| `compaction/end` | 有 `error` → 失败卡（`errorText()` 展开 cause 链，关键坑 40）并写明**没有产生摘要**；无 `error` → 收尾 | red / green |

**明确不做**：不提供「完整摘要另发文件」的按钮（使用者已否掉）；摘要超 200 字即截断，不做全文出口。

**✅ 折叠组件已探针验证（2026-09-29）——可以做**：

用一次**只建实体、不发送**的 `cardkit.card.create` 探针（脚本留在 `~/.dsh/probe-collapsible-card.py`，凭据从 `.credentials.yaml` 读、不打印），并带一个**伪造 tag 的对照**来证明判据有区分力：

| 用例 | 结果 |
|---|---|
| A `collapsible_panel` + `expanded: false` + `header.title` + `elements` | **`code=0`，拿到 `card_id`** ✅ |
| B `collapsible_panel` + `default_expanded` | `code=0`（未知字段被容忍，**无法据此判定正确字段名**） |
| C `collapsible`（Card JSON 1.0 时代的名字） | `code=10002 ErrMsg: not support tag` ❌ |
| D **对照**：伪造 tag `collapsible_bogus` | `code=10002 not support tag` ❌（**对照有效**：tag 会被服务端校验，A 的成功因此有意义） |
| E 对照：普通卡 | `code=0` |

结论三条：

1. **tag 用 `collapsible_panel`**（2.0 的名字）；`docs/feishu-capabilities.md` 里记的 `collapsible` 是**错的**（1.0 名字，CardKit 直接拒），已在该文件更正。
2. **初始展开态的字段名仍未定**：`expanded` 与 `default_expanded` 都被接受，create 接口区分不出来——按 `expanded: false` 实现，真正的渲染效果留到压缩卡真机上线时看；若渲染成默认展开，改一个字段名即可（纯外观，不影响结构，也**不会**让卡片发不出去）。
3. 顺带从 SDK 的接口说明里读到一条运维事实：**一个卡片实体只能发送一次、有效期 14 天**（`cardkit.card.create`）。现有「每次发卡都新建实体」的流程天然符合，但**长期存活、隔天还要更新的卡片**不能复用实体——这一点与关键坑 11 是同一族约束。

**退路**（若真机发现折叠渲染有问题）：详情行 + 摘要前 200 字**不折叠**直出；或摘要单独一张卡。两条都不需要新组件。

**2026-09-30 追加：折叠必须「看得出来」**（使用者反馈：「思考块看不出来是已经折叠的样子，不了解的人不知道这个东西已经折叠了」——压缩摘要同理）。

这是收起态的结构性事实：面板收起时**只渲染 header**，而光秃秃的 header 就是一个「小标题」的样子；WebUI 的同类行有 chevron，飞书这张卡得自己造。两条一起上，因为一条靠我们说、一条靠客户端画：

1. **文案**——header 标题结尾统一 `（▸ 已折叠 · 点击展开）`（英文 ` (▸ Collapsed · click to expand)`），i18n 函数 `cardFoldTitle(title)`（中文不要空格、英文要）。这是唯一客户端丢不掉的信号。
2. **外观**——`border: {color:'grey-300', corner_radius:'4px'}` + `header.background_color: 'grey-100'`：有边框、有底色的 header 才像「一块可点的东西」。

两处折叠（推理、压缩摘要）改走同一个 `foldedPanel()`（`src/card-fold.ts`），值只存在一处，不会再各自漂移。

**取证口径（写进坑 48）**：`cardkit.card.create` **静默容忍未知字段**——往 `header` 里塞 `bogus_xyz` 照样 `code=0`，所以「建卡成功」**不能**证明字段存在，**只有「值被拒」才算**。按这个口径实测出来的字段约束：命名色 token only（hex/rgba 被 `11310` 拒；对象形式的 `background_color` 被 `10002 expected string` 拒）、`corner_radius` 只认 px（`4`/`50%`/`4pt` 被拒）、`header.padding` 只认 1 或 4 个 px 值（`4px 8px` 被拒）、`expanded` 只认布尔（字符串报 `bad variable formmat`）；`header.icon` 的 `standard_icon` **token 不校验**（乱写也过 ⇒ 不可用），`custom_icon` 要真上传的 `img_key`（伪造被 `200570` 拒）。完整表在 [`docs/feishu-capabilities.md`](./feishu-capabilities.md) §2.3.2，端到端校验（真实渲染产物直打 create）也在那里。

**其余要点**：

- **写入纪律**：压缩卡走 `channel.sendStepCard` 同一套（关键坑 45：步骤卡自己的 send 不能过聊天排序屏障），一卡同时只允许一次写入在飞。压缩发生在**步骤之间**，天然不会与某一步的更新交错。
- **失败形态**：`compaction/end` 是唯一带 `error` 的事件，且失败路径**没有** `summary`（§2.1）——「start 之后必然有 summary」的假设必须排除。
- **上下文水位（可选）**：`compaction/summary` 之后的下一个 `request/header` 能拿到压缩后的 `lastInputTokens`，可在收尾时补一句「上下文 302k → 41k」。
- **200 字**：与推理预览同一个预算（`REASONING_CAP = 200`，见 O8）；实现时写成命名常量，别散落魔数。

---

## 三、缺口三：显示级别（4 档）不对齐

### 3.1 WebUI 的 4 档是一张策略表，不是一个开关集合

设置项：`ui-chat.transcriptView`，`packages/client/ui-chat/src/chat-settings.ts`。

- 取值：`compact | standard | detailed | verbose`；
- 默认：`detailed`（非 Desktop 的 Web 客户端；`DEFAULT_TRANSCRIPT_VIEW_MODE`）；
- 历史值：`normal`（两档时代的遗留）与 `expanded` **都按 `detailed` 读**，不再提供、也不再写回（`LEGACY_TRANSCRIPT_VIEW_MODE` / `LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE`）；
- UI：设置页「工作步骤展示（Work details）」四选一，文案 `简洁 / 标准 / 详细 / 完全展开`。

**关键在于它只改 4 条策略轴**（`packages/client/ui-chat/src/client/presentation-policy.ts`），渲染器从不比较档位枚举——加档只改这张表：

| 档位 | `foldCompletedTurns` | `stepGrouping` | `liveProcessDetail` | `settledReasoningPreview` |
|---|---|---|---|---|
| `compact` 简洁 | ✅ 折 | `collapsed` 全折 | ❌ | ❌ |
| `standard` 标准 | ✅ 折 | `collapsed` 全折 | ✅ | ✅ |
| `detailed` 详细 | ✅ 折 | `history` 只折**已关闭**的回合 | ✅ | ✅ |
| `verbose` 完全展开 | ❌ 不折 | `none` 不分组 | ❌ | ✅ |

各轴的落点（供映射时参考）：

- `foldCompletedTurns` → `ChatGroupSeat.tsx:152` 的 `outerHidden`：**已结束回合**的整段过程行被折叠；
- `stepGrouping` → `ChatGroupSeat.tsx:143`：过程组标题是否可折叠，`history` 只折已关闭的回合（当前回合保持展开）；
- `liveProcessDetail` → `ChatGroupSeat.tsx:101/111`：运行中的组标题右侧是否追加**实时细节**（正在跑的命令 / 路径 / 查询 / 推理尾部）；
- `settledReasoningPreview` → `ReasoningRow.tsx:58`：已结束的思考行是否在标题旁显示**首行预览**（否则只剩「Think」）。

### 3.2 飞书侧现状：4 个布尔，轴完全不同

`src/config.ts` 的 `showReasoning` / `showToolCalls` / `showToolArgs` / `showToolResults`（都默认 `true`，都 `.volatile()`），`/display` 卡片逐个切换（`src/feishu-display.ts`）。

它们回答的是「**显示哪些内容**」（开关粒度 = 内容类型），而 WebUI 的 4 档回答的是「**显示多少细节 + 折到哪一层**」。两套轴可以并存，但不能用一个替代另一个：

- 我们的「每步一张卡」是不可变的（关键坑 12：一个 step 只能一张卡），所以 WebUI 的「折叠」在飞书**没有视觉等价物**——飞书的对应物只能是**少发卡**（把一轮的过程合并进更少的卡）与**把汇总放进 Turn Complete 卡**。
- 因此级别映射到飞书时，`foldCompletedTurns` / `stepGrouping` 这两轴要翻译成「**本轮发几张卡**」，而 `liveProcessDetail` 正是 O20 方案 2 要接的实时流（**有依赖**：没有实时信号时这一轴只能是空转）。

### 3.3 建议的档位表（待拍板）

| 档位 | 步骤卡 | 工具调用 | 推理 | 与现有布尔的关系 |
|---|---|---|---|---|
| **简洁** `compact` | 一轮**合并成 1 张过程卡**（就地更新）+ Turn Complete | 只显示计数（`3 个工具调用 · 1 失败`）；无参数、无结果 | 只显示「思考中」状态，**不显示内容** | `reasoning=false` `args=false` `results=false`；`tools=true`（否则过程卡空） |
| **标准** `standard` | **每步 1 张**（现状） | 一行摘要（名字 + 状态 + 耗时）；无参数、无结果 | 首行预览（对齐 `settledReasoningPreview`） | `reasoning=true` `tools=true` `args=false` `results=false` |
| **详细** `detailed`（默认） | 每步 1 张（现状） | 摘要 + 参数 + 结果（现状） | 首行预览 + 可展开 | 全 `true`（= 现状） |
| **完全展开** `verbose` | 每步 1 张 **+ 每个工具调用 1 张独立卡**（对齐「不分组」） | 摘要 + 参数 + 完整结果（不截断） | 全文，不截断 | 全 `true` + 注入逐条成行 + 摘要在压缩卡上全文 |

三条设计选择（**提案**，最终实现见 §3.4）：

1. **档位是权威，布尔降为「自定义」档**：新增 `transcriptView: 'compact' | 'standard' | 'detailed' | 'verbose' | 'custom'`（默认 `detailed`）。选具体档位时按上表派生 4 个布尔（**不覆写存储**，切回来还在）；选 `custom` 时 4 个布尔直接生效。`/display` 卡改成「档位四选一 + 自定义时才出现的 4 个开关」。
2. **默认 `detailed` 与现状等价**：现有部署 4 个布尔都是 schema 默认 `true`，正好等于上表的「详细」，所以默认值不会改变任何人的观感。
3. **命名与文案直接沿用 WebUI**（`简洁 / 标准 / 详细 / 完全展开`，字段名 `transcriptView`），这样两边的设置页能对着看；插件自己的 settings 命名空间是 `lark-channel`，与 `ui-chat` 不冲突。

### 3.4 实际实现（2026-09-29，与 §3.3 的**三处**偏离）

| 档位 | 推理 | 工具 | 参数 | 结果 | 上限 |
|---|---|---|---|---|---|
| **简洁** `compact` | 不显示 | 只报计数（`N 个工具调用 · M 个失败`） | 否 | 否 | — |
| **标准** `standard` | 首行预览（无折叠区） | 每个调用一行摘要 | 否 | 否 | — |
| **详细** `detailed`（默认） | 折叠面板，正文 200 字 | 摘要 + 参数 + 结果 | 是 | 是 | 1500 / 2000 字符 |
| **完全展开** `verbose` | 折叠面板，**全文** | 同上 | 是 | 是 | **6000 / 6000 字符** |

三处有意偏离上面的提案，理由并列在此：

1. **档位是「基线」，不是「权威」**：不提 `custom` 档，而是把档位与四个老开关用 **AND** 合成（`resolveDisplayPolicy`，`src/display-level.ts`）。理由：① 升级不能让用户**已经关掉**的东西重新出现（`showToolArgs=false` 的部署不该因为档位是「详细」就把参数放回来）；② `custom` 档需要从四个布尔**反推**当前档位、并且要为「档位与布尔不一致」定义展示规则，是纯增复杂度；③ AND 语义下「档位能显示什么」永远是上界，理解成本最低。
2. **简洁档不合并卡片**：提案里「一轮合并成 1 张过程卡」会引入一个新的卡片聚合生命周期（跨 step 复用一张卡、正文追加、与 `resetStep` / 交付守卫 / 溢出续卡全部交互），而收益只是「少几张卡」；`compact` 现在**只把卡片缩成状态行**，卡片数量不变。WebUI 的 `foldCompletedTurns` / `stepGrouping` 两轴在飞书因此**没有对应物**——这是「一个 step 只能一张卡」（关键坑 12）的直接后果，不是遗漏。
3. **`verbose` 的「不截断」是 4 倍上限，不是无限**：卡片 JSON 过 ~30KB 会被整张拒收（关键坑 42），而被拒收的卡**什么都不显示**；留一个上界比「完整但发不出去」诚实。

---

## 四、实施要点与纪律

1. **一处 handler**：三件事都在 `src/feishu-streaming.ts` 的 `session/event` 分支里；注入走 `user/message`，压缩走 `compaction/*`。不要新开第二个 `ctx.on('session/event')` 监听器（现有的四个模块各自订阅是为了独立生命周期，这里不需要）。**已按此实现**：卡片渲染器各自独立成模块（`injection-notice.ts` / `feishu-compaction.ts`），但事件订阅只有一个。
2. **写入纪律（实现时有一处放宽，理由是实测）**：计划是压缩卡复用 `channel.sendStepCard` / `updateStepCard`，实际写成 `feishu-compaction.ts` 里的**独立小写入器**——同样的 CardKit 实例 + 递增 sequence + 话题坐标，但**不共享步骤卡的防抖/写槽/送达记账**。理由：压缩发生在**步骤之间**，与某一步的卡天然不会交错，而步骤卡那套复杂度（写槽、`turnTextOrder` 送达戳、媒体预热）全部是为「一次写入可能载着整轮答案」服务的，压缩卡**不载任何助手文本**，套进去只会让两件事的失败模式互相牵连。关键坑 45 的实际要求（**步骤卡自己的 send 不能过聊天排序屏障**）在这里不适用：压缩卡**不是**步骤卡，它走普通 `channel.send` 反而正确——那正是「排在上一张步骤卡之后」的保证。
   注入**不再是独立卡片**，而是所属 step 卡正文的第一段——所以它天然复用该卡的写入路径与话题坐标，**不需要任何新的发送逻辑**。
3. **排除清单**：接线 `user/message` 时显式跳过 `compact-checkpoint`（§2.3）与 `tool-jobs`（已有分支，避免在顶部重复显示），避免污染「本轮触发原因」的判定。
4. **发/更新策略**：压缩卡是一张**可更新**的卡（start → summary → end 三次写入，同一步骤卡的模式）；注入块随所属 step 卡的每次重渲染一起出现，**不额外增加写入次数**（唯一例外：注入先于 `step/start` 到达时，把它并入首版渲染，见 §1.5 的缓冲规则）。
5. **有界**：摘要 200 字硬上限（§2.4）；注入**只显示一行提示**（§1.5），所以既没有正文截断、也没有全文出口（使用者已否掉发文按钮）。
6. **验证方式（真机）**：一轮里制造 ① 自动压缩（长会话）② `/compact` ③ 子代理结算 ④ 改一次 `AGENTS.md` 让指令增量触发，检查：压缩卡三次状态是否按序、详情行与折叠区位置是否正确、折叠组件是否真的渲染、`230020` 是否出现、journal 是否干净；注入块是否出现在**正确那张 step 卡的最前面**（步骤内注入＝该步；压缩后重注入＝下一张 step 卡）且提示行点明了注入的种类与来源（如 `AGENTS.md（已更新）`）；**卡片正文里不应出现注入内容**。

---

## 五、决策状态

### 已拍板（2026-09-28）

| # | 决策 | 依据 |
|---|---|---|
| 1 | ~~注入每次一张独立卡片~~ → **改：插进「声明它的那个 step」卡片正文最前面**（第二次修订，使用者提案并经 §1.6 实测核验；原"独立卡片"决定作废） | §1.5 / §1.6 |
| 2 | 压缩摘要**可折叠显示**，上限 **200 字** | §2.4 |
| 3 | 压缩详情（折叠了几条历史 / 多少 token）放在**折叠区之上** | §2.4 |
| 4 | **不做**「完整摘要另发文件」按钮；摘要超 200 字即截断 | §2.4 |
| 5 | **不实现**「注入追加到卡片末尾 / footer 之前」：该位置在持久事件里不存在（0/2589） | §1.6 |
| 6 | **注入只显示一行提示，不渲染注入内容**（第三次修订）⇒ 不需要 `form` 正文渲染、不需要截断逻辑；提示行只用 `source` 的元数据 | §1.5 |

### 已实现（2026-09-29，一批四件）

| # | 事项 | 落点 | 验证 |
|---|---|---|---|
| 1 | **档位 = 基线 + 四开关 AND**（§3.4） | `src/display-level.ts`（新）、`src/config.ts`（`transcriptView`）、`/display` 文本与卡片、WebUI 设置页下拉框 | 8 例单元（含 legacy `normal`/`expanded` → `detailed`、AND 只减不加） |
| 2 | **推理折叠（O5）** | `renderStepCard` 的推理段改成 `collapsible_panel`（`expanded:false`），头部保留耗时/tokens | 4 例渲染 + 接线 1 例；组件真机探针见 §2.4 |
| 3 | **压缩卡（O21②）** | `src/feishu-compaction.ts`（新）+ `compaction/*` 三个分支 | 7 例渲染 + 8 例控制器（顺序 / 序列 / 话题 / 文本兜底 / stop） |
| 4 | **注入提示行（O21①）** | `src/injection-notice.ts`（新）+ `user/message` 分支 + `step/start` 的花名册搬运 | 11 例（**用真机日志里的真实 `source` 载荷**）+ 3 例接线（含「先于 step/start 到达」的缓冲） |

### 仍待拍板

1. **注入提示行还能再压到什么程度**：要不要连 `<路径>` / `<skill 名>` 这类元数据、以及 `N 条` 计数也去掉，只留「📥 注入上下文」（§1.5 末尾）。**现状**：保留元数据，未知 kind 只报种类。
2. **`compact` 档要不要真的合并卡片**（§3.4 偏离 2）：现在只缩内容不合并；若使用者要「一轮一张卡」，那是一项独立的卡片生命周期改造。
3. ~~折叠面板的初始展开态字段名~~：**已真机确认（2026-09-29）**——上线后读回线上卡片（`card_msg_content_type=user_card_content`）得到 `collapsible_panel` + `expanded=false`，即 `expanded` 生效、默认收起。

### 已被实现推翻的旧结论

- ~~「折叠组件要先探针、失败则不折叠直出」~~：探针已跑通（§2.4），折叠已用于推理与压缩摘要；退路（详情行 + 摘要 200 字直出不折叠）不再是默认路径。
- ~~「档位需要 `custom` 第五档」~~：改为 AND 合成，见 §3.4。
