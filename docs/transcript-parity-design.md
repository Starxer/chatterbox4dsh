# 上下文注入、压缩摘要与显示级别：与 WebUI 的对齐调研

> 状态：**调研完成；§1 注入与 §2 压缩已拍板，§3 显示档位待拍板（2026-09-28）——尚未动代码**。
> 关联：[`src/feishu-streaming.ts`](../src/feishu-streaming.ts)（`session/event` fan-out 与步骤卡全部逻辑）、[`src/feishu-display.ts`](../src/feishu-display.ts)（`/display` 卡片）、[`src/config.ts`](../src/config.ts)（4 个显示开关）、[`docs/step-card-phases-design.md`](./step-card-phases-design.md)（O20，同一片代码、同一批信号）、[`docs/display-card-design.md`](./display-card-design.md)。
> 台账：`TODO.md` 的 **O21**（注入与压缩完全不可见）、**O22**（显示级别不对齐）。
> 依据的 DSH 版本：**0.2.0-rc.1**（`dsh-v0.2.0-rc.1` = `4878cdabd8`）。下文所有源码路径都相对 DSH 检出根。

## 零、结论摘要

| # | 缺口 | DSH 侧事实 | WebUI 怎么演 | 飞书现状 | 建议修法 |
|---|---|---|---|---|---|
| 1 | **上下文注入不可见**（AGENTS.md、技能目录、子代理通知…） | 注入是**持久** `user/message` 事件（`data.source.kind !== 'user'`），共 8 种来源 | 一条可折叠的「上下文注入」行；展开按 6 种 `form` 分派 | handler 只认 `source.kind === 'tool-jobs'`，其余**全部静默丢弃** | **每次注入发一张独立卡片**，落在它发生的时刻（✅ 已拍板，见 §1.5） |
| 2 | **压缩不可见**（自动压缩 + `/compact`） | `compaction/start` → `compaction/summary` → `compaction/end`（失败时 `end` 带 `error`），外加一条 replacement checkpoint | 「上下文已压缩 · 已折叠 N 条历史 · ~M tokens」+ 展开看摘要 | **完全没有订阅**（`compaction/*`、`command/*` 都没订阅） | 一张压缩卡：进行中 → **详情行在折叠区之上、摘要可折叠且 ≤200 字** → 收尾/失败原因（✅ 已拍板，见 §2.4） |
| 3 | **显示级别不对齐** | WebUI 是**一个 4 档枚举 + 4 条策略轴** | 简洁 / 标准 / 详细 / 完全展开（默认「详细」） | **4 个互不相干的布尔**（思考 / 工具 / 参数 / 结果），轴的含意都不同 | 引入同名的 4 档 `transcriptView` 作权威档位，4 个布尔降为「自定义」档的细分 |

三件事的**共同点**：都落在 `session/event` 这一个 handler 上，而且第 3 件决定了前两件的默认音量。建议顺序 **2 → 1 → 3**（压缩卡与注入各自独立可发；级别落地后回头把注入的档位接上）。

---

## 一、缺口一：上下文注入在飞书完全不可见

### 1.1 DSH 侧：注入是持久事件，不是隐藏的请求头

`@deepseek-ai/dsh-agent-instructions`（`packages/context/agent-instructions/`）把工作区指令文件（`AGENTS.md` 这一族）作为**上下文消息**写进会话；同族还有技能目录、插件清单、跨会话召回、子代理结算通知等。它们的持久形态**统一是 `user/message`**，靠 `data.source` 区分：

| `source.kind` | `form` | 何时出现 | 有价值的字段 |
|---|---|---|---|
| `agent-instructions` | `instructions` | 基线一次（`baseline: true`）+ 每次 `read`/`write`/`edit` 碰到指令文件时的增量 | `changes: [{action, scope, path, digest}]`、`baselineIdentity` |
| `skill-catalog` | `catalog` | 可用技能集合变化时 | `entries` |
| `plugin` | `snapshot` | 存活插件包清单变化时 | `plugin`、`sections` |
| `session-reference` | `recall` | 跨会话召回 | `references: [{label, …}]` |
| `skill-invocation` | — | 模型调用某个 skill | `name` |
| `agent-message` | `relay` | 别的会话发来的消息 | `senderSessionId` |
| `subagent-settled` | `notice` | **子代理结算**（宿主把结果注入父会话） | `senderSessionId`、`summary` |
| `goal` | — | 目标轮次推进 | `goalId`、`revision`、`round` |

另有一族 `developer/message`（`packages/session/session-format-v3-to-v4/src/developer.ts`）走同一套展示，插件同样没订阅。

`content` 是**给模型看的整段文本**。一次真实采样：一条 `agent-instructions` 基线 6258 字（开头就是 `<system-reminder>The following workspace instructions may be relevant to your work.…`）。

### 1.2 WebUI 侧：一条可折叠的「上下文注入」行

- 分类：`packages/client/ui-chat/src/client/conversation-nodes/message.ts:76` 只判断 `event.data.source.kind !== 'user'`，是就造 `kind: 'context'` 节点（`developer/message` 走 `developerMessageDefinition`，共用同一套呈现）。
- 渲染：`packages/client/ui-chat/src/client/chat/ContextInjectionRow.tsx` —— 标题 `上下文注入`（`producer.role === 'recall'` 时是 `跨会话召回`），标题右侧是 **producer label**（`agent-instructions` 取 `changes[].path`，如 `AGENTS.md`；`skill-invocation` 取 skill 名），只有 `notice` 形态额外带一行摘要。整行默认**收起**，点开才看正文。
- 正文按 `form` 分派 6 种（`packages/client/ui-chat/src/client/chat/ContextBody.tsx:551`）：`instructions` / `catalog` / `snapshot` / `notice` / `relay` / `recall`；**form 缺失或本版本不认识就退回 opaque**（把 `source` 字段原样列出来）——这条兜底很重要：未知来源也必须能渲染。
- **不随显示级别折叠**：注入行属于 `input-message` 家族（与用户消息同级），不是过程组（`turn-process`）的成员，所以 4 档下都在。

### 1.3 飞书侧现状

[`src/feishu-streaming.ts:1469`](../src/feishu-streaming.ts) 的 `user/message` 分支只做一件事：判断「本轮是不是被后台任务完成通知唤醒的」（O11）。命中条件是 `source.kind === 'tool-jobs'`，**其余 8 种来源一律落空**——`agent-instructions` 连一行日志都没有。

后果：使用者看不到「这一轮被喂了哪些上下文」；**子代理结算通知**（`subagent-settled`）看不到；跨会话召回（`session-reference`）看不到；指令文件被改动时的增量（`changes`）也看不到。

### 1.4 关键约束：注入的**频次**决定了不能照抄 WebUI

同一次真实会话（39 轮）里非 user 的注入条数：

| kind | 条数 |
|---|---|
| `agent-instructions` | 19 |
| `plugin` | 14 |
| `skill-catalog` | 8 |
| `agent-message` | 6 |
| `subagent-settled` | 6 |
| `goal` | 2 |
| **合计** | **55**（同一会话的真实用户消息是 34 条） |

⇒ **「一条注入 = 一条消息」会让聊天消息量翻倍以上**。WebUI 能这么干是因为它是一个可滚动的转录流、折叠行只占一行且默认收起；飞书的消息是**持久气泡**，缩不回去。所以飞书侧必须默认聚合。

### 1.5 已拍板的形态（2026-09-28）

**使用者决策：不要折进 Turn Complete 卡，改为「每次注入一张独立卡片」。** 原话：

> 「不要显示在 turn complete 卡片中，而是显示为一个单独的卡片。因为这是中间步骤，如果显示在 turn complete 卡片里，我只知道发生过这个事情，但它的具体行为就看不出来了。」

⇒ 采纳的是方案 C 的**位置语义**（注入在自己发生的时刻占一条卡片，而不是被回合结束时的汇总吞掉），但**内容**不必用折叠面板（折叠能力留给压缩摘要，见 §2.4）：卡面直接给出「具体行为」——标题 + producer label + 该 `form` 的内容（超长截断）。

卡片规格（草案；`user/message` 且 `source.kind !== 'user'` 时触发）：

| `source.kind` | 卡面 |
|---|---|
| `agent-instructions` | 标题 `📥 上下文注入`；副标题 = `changes[].path`（如 `AGENTS.md`）+ 动作（`已载入` / `已更新` / `已新增` / `已移除`，对齐 WebUI 的 `message.context.instructions.*`）；正文 = 变更条目（`scope` / `digest`）与其对应内容，超长截断 |
| `skill-catalog` / `plugin` | 标题同名；正文 = 条目清单（截断 + `…还有 N 条`，对齐 WebUI 的 `message.context.catalog.more`） |
| `session-reference` | 标题 `🔗 跨会话召回`；正文 = `references[].label` |
| `skill-invocation` | 标题 `📥 已载入技能`；正文 = skill 名 |
| `agent-message` | 标题 `✉️ 会话间消息`；正文 = 来源会话 + 内容摘要 |
| `subagent-settled` | 标题 `🤖 子代理已结算`；正文 = `summary` |
| `goal` | 标题 `🎯 目标推进`；正文 = `goalId` / `round` |
| 未知 `kind` 或未知 `form` | 标题 `📥 上下文注入`；正文 = 原始字段（对齐 WebUI 的 opaque 兜底：来源不认识也必须能渲染） |

**体量提醒（使用者已知情）**：一次 39 轮样本会产生 **55 张**注入卡（§1.4）。会连续刷屏的是三类例行快照——`agent-instructions`（每次 `read`/`write`/`edit` 触碰指令文件，样本 19 条）、`plugin`（14）、`skill-catalog`（8）。建议给这三类留一个「**同一回合内同类合并成一张、就地更新**」的开关，默认**关**（＝每条一张，与拍板一致），需要降噪时再打开；做成配置项而不是写死在逻辑里。

**原先提的「两个例外」不再是例外**：`subagent-settled`（子代理跑完在唤醒父会话，回答「为什么会有这一轮」）与 `session-reference`（跨会话召回，改变答案的依据来源）本身就是注入，在「每条注入一张卡」下自然可见，不需要额外的 Turn Complete 变体。

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
- 同样**不随显示级别折叠**（它不是过程组行）。

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

**⚠️ 折叠组件的可用性尚未核实——这是实现的第一步**：

- 本插件**从未用过**任何折叠组件（`docs/feishu-capabilities.md` 把 `collapsible` 记为能力缺口，与 **O5「reasoning 代码块可折叠」** 是同一个组件）；组件 tag 在 Card JSON 1.0 / 2.0 里的名字（`collapsible` vs `collapsible_panel`）和字段名（`expanded` / `default_expanded` / `header` / `elements` …）**逐字段未核实**。
- 本机**读不到飞书官方文档**：`open.feishu.cn` 解析到非公网地址，抓取工具以「解析到非公网 IP 地址」为由直接拒绝——与 `docs/display-card-design.md` 里 `checker` 那条「字段未逐字段核实」是同一个坑。
- **验证手段（不动任何聊天）**：一次**不发出去的** `cardkit.card.create` 探针。关键坑 41 已证明「非法卡内容不抛错，而是 `code=200570` + 空 `card_id`」，所以拿到非空 `card_id` 就说明服务端至少接受了这份 JSON；拿不到就立刻换写法。
- **退路**（探针失败时）：详情行 + 摘要前 200 字**不折叠**直出；或摘要单独一张卡。两条都不需要新组件。

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

三条设计选择：

1. **档位是权威，布尔降为「自定义」档**：新增 `transcriptView: 'compact' | 'standard' | 'detailed' | 'verbose' | 'custom'`（默认 `detailed`）。选具体档位时按上表派生 4 个布尔（**不覆写存储**，切回来还在）；选 `custom` 时 4 个布尔直接生效。`/display` 卡改成「档位四选一 + 自定义时才出现的 4 个开关」。
2. **默认 `detailed` 与现状等价**：现有部署 4 个布尔都是 schema 默认 `true`，正好等于上表的「详细」，所以默认值不会改变任何人的观感。
3. **命名与文案直接沿用 WebUI**（`简洁 / 标准 / 详细 / 完全展开`，字段名 `transcriptView`），这样两边的设置页能对着看；插件自己的 settings 命名空间是 `lark-channel`，与 `ui-chat` 不冲突。

---

## 四、实施要点与纪律

1. **一处 handler**：三件事都在 `src/feishu-streaming.ts` 的 `session/event` 分支里；注入走 `user/message`，压缩走 `compaction/*`。不要新开第二个 `ctx.on('session/event')` 监听器（现有的四个模块各自订阅是为了独立生命周期，这里不需要）。
2. **写入纪律**：压缩卡必须走 `channel.sendStepCard` / `updateStepCard` 同一套（关键坑 45）；注入卡走普通 `channel.send`（无按钮、不需要就地更新），但**必须落在正确的话题里**——按绑定的 root 坐标发，不按群推断（关键坑 25 / 31）。
3. **排除清单**：接线 `user/message` 时显式跳过 `compact-checkpoint`（§2.3）与 `tool-jobs`（已有分支），避免污染「本轮触发原因」的判定。
4. **发/更新策略**：压缩卡是一张**可更新**的卡（start → summary → end 三次写入，同一步骤卡的模式）；注入卡**只发不更新**（一次注入一张，内容在发出时就完整；没有按钮，因此不受关键坑 11「带按钮的卡就地更新 2–3 次后回调失效」的约束）。
5. **有界**：摘要 200 字硬上限（§2.4）；注入正文按 `form` 各自截断并补 `…还有 N 条`；两者**都不再提供全文出口**（使用者已否掉发文按钮）。
6. **验证方式（真机）**：一轮里制造 ① 自动压缩（长会话）② `/compact` ③ 子代理结算 ④ 改一次 `AGENTS.md` 让指令增量触发，检查：压缩卡三次状态是否按序、详情行与折叠区位置是否正确、折叠组件是否真的渲染、`230020` 是否出现、journal 是否干净；注入卡是否**每次注入各一张**且正文能看出具体行为（改了哪个文件 / 哪一条）。

---

## 五、决策状态

### 已拍板（2026-09-28）

| # | 决策 | 依据 |
|---|---|---|
| 1 | 注入**不折进 Turn Complete**，改为**每次注入一张独立卡片**，卡面要能看出具体行为 | §1.5 |
| 2 | 压缩摘要**可折叠显示**，上限 **200 字** | §2.4 |
| 3 | 压缩详情（折叠了几条历史 / 多少 token）放在**折叠区之上** | §2.4 |
| 4 | **不做**「完整摘要另发文件」按钮；摘要超 200 字即截断 | §2.4 |

### 仍待拍板

1. **注入卡要不要同时提供降噪开关**：默认「每次注入一张」（＝已拍板）；可选的「同一回合内同类合并成一张、就地更新」是否现在就做（§1.5 的体量：一次 39 轮样本 55 张）。
2. **档位是否引入**（§3.3）：① 档位作权威 + 4 个布尔降为 `custom`（推荐）；② 只做「档位 = 一键写 4 个布尔」的轻量预设（改动最小，但没有对齐折叠 / 推理预览两个新轴）；③ 先不做档位，只做 §1 / §2。
3. **档位与 O20（步骤卡阶段）的先后**：档位里的 `liveProcessDetail` 这一轴正是 O20 方案 2 要接的实时流——O20 先做，或与档位同批。
4. **折叠组件的探针**：实现压缩卡前先跑一次「不发出去」的 `cardkit.card.create` 探针（§2.4）；失败就走退路（不折叠直出）。
