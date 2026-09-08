# Changelog

## Unreleased

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
