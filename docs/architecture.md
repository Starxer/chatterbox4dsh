# Architecture

```text
飞书用户
  │ im.message.receive_v1 (WebSocket)
  ▼
Lark SDK (自动重连、去重、串行处理)
  │ NormalizedMessage
  ▼
dsh-feishu 会话适配器
  │ chat/thread → SessionId
  ▼
Workspace + Agent Preset 组合
  │ cwd + tools + system prompt
  ▼
Harness Agent (模型、工具、会话日志)
  │ assistant text + tool results
  ▼
飞书卡片 (per-step card + Turn Complete)
```

## 核心模块

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口，注册服务和命令 |
| `src/channel.ts` | 飞书 Channel 封装，入站图片/文件接收（`admitImagesForMessage`/`admitFilesForMessage`），回复卡片渲染，Turn Complete 卡片 |
| `src/harness.ts` | Harness 会话服务，session 映射持久化；用户文本原样进入模型（不加 `[Feishu] ` 之类的通道前缀，纯图片/文件消息只带 image/file 块），通道归属由 session↔chat 绑定记录。**状态文件的写入纪律（关键坑 41）**：`chatToSession` / `seenChatKeys` / `chatToRootId` / `busyMode` 是**内存表整体覆盖写文件**，因此 ①`dispose()` 之后**拒绝再写**（`disposed` 门：dispose 会清空这些表，而 dispose 之后仍有回合收尾代码在跑，写出去就是把绑定整份清空）；②本次启动从磁盘读回过绑定、而现在表空了也拒写并留日志；③落盘是**原子写**（`.tmp` + rename），读取失败的文件隔离为 `.corrupt-<ts>`；④每次启动打一行「读回 N 条绑定 / M 个话题根」 |
| `src/feishu-streaming.ts` | **陈旧卡上报**：某张步骤卡的写入失败、且此后没有成功写入把它补回来时，发一条**纯文本**通知（「这张卡已停在旧内容」+ 原因 + 轮/步号）；`STALE_CARD_CONFIRM_MS = 2s` 确认窗——被下一次写入救回的错误**不报**（否则恢复过程会变成聊天噪音），每张卡只报一次，`stop()` 清掉待发定时器。选文本而非卡片，是因为要上报的正是「卡片写不进去」，而且文本不经 markdown 解析（关键坑 39）。**后台任务唤醒归属**：`turn/start` 重置两个回合级开关，本回合**第一条** `user/message` 的 `source.kind === 'tool-jobs'` 即认定"这一轮由任务完成通知开启"（宿主对空闲 owner 走 `followup`、忙时走 `inject`，两者靠 append 顺序区分），该回合每张步骤卡正文顶部加 `⚡ 本回合由后台任务完成通知触发`。**统一 per-step 卡片**：订阅 mux 事件流，渲染 reasoning（200 字预览 + 思考耗时/思考 token）+ text（3000 字上屏 + 溢出自动拆 continued 卡）+ 工具调用（pretty-print args，2000 字上限）+ 结果预览；标题带「第 N 轮 · 第 M 步」，footer 两行（时长/token · tok/s/上下文）。**四阶段一张卡**：`step/start` 立即发「🧠 深度思考中…」占位卡（5s 刷新已用时；**例外：`compact` 档只有该步带注入提示行时才发**——它的步骤卡只承载答案正文、纯工具步骤不发卡，工具活动全在 `feishu-progress.ts` 的回合过程卡上；**同一条消息里既写话又调用工具的正文在 `compact` 下也不单独成卡**（判据与 WebUI 的 `latestAnswer` 一致：带 tool-call 块的消息永远不是最终答案），改为过程卡上该步的 `💬` 行，另三档不变；`compact` 的答案卡另去掉 `📝 消息` 小节标题与 `hr`、脚注两行合成一个元素、间距设 `4px`；注入行不再让它开卡（O21① 改为按内容保留：回合卡存在时在回合卡上，整轮无工具时在答案卡上），且别的模块在它下面发过卡之后它退休、后续正文另发新卡只带新增部分）→ `assistant/message` 写入 reasoning/文本 → `tool/call` → `tool/result`，全部就地更新；某步最终无可见内容时在 `step/end` 折叠为「本步无输出」。**写入纪律（关键坑 45）**：①**步骤卡自己的 send 不走聊天的排序屏障**（`channel.sendStepCard`）——屏障的 flush 会 `await` 本聊天的卡链，而卡链里正是这条 send 自己（自锁死到 60s 超时），绕屏障后的排序由调用方的 `previousSettled` 保证；②一张卡同时**只允许一次写入在飞**，期间到达的渲染**只保留最新一张**（`writeSlots`）——慢写入（媒体上传）叠上 5s 占位 tick 会攒出突发，飞书按 `230020` 拒掉其中一次，而「载着答案的那次」就在里面；③送达判据是 `turnTextOrder`（按**构建顺序**盖戳，比较「最新落地的一版」与「最新被拒的一版」），**不是**「有文本落地过」——否则「第一步落地、最后一步被拒」会被判成已送达，只发 footer 而最后一版答案消失 |
| `src/feishu-progress.ts` | **回合过程卡**（`compact` 档专用，TODO O22 第二轮）：把整轮的工具活动合并到**一张回合级卡片**上——首个 `tool/call` 懒创建（没有工具调用的回合零卡片）、整轮**就地更新**（CardKit 实例优先，退化 `im.v1.message.patch`）、`turn/end` 定格（运行中灰头 → 正常结束绿头 → 回合失败红头，失败原因仍归失败卡）。正文 = step 小节（`▸ **第 2 步** · 3.4s`，运行中带 `…`；`▸` 只是 i18n 模板里的图标）+ 该步的工具行（`✅ \`read\` · …/src/x.ts · 0.4s` / `⏳ \`bash\` · 1.2s…` / `❌ \`edit\` · 50ms`，**不带列表符**：分隔线已经把步分开了，列表符只是多余标点）+ **步骤中间夹的叙述行排成引用**（`> 💬 …`，`PROGRESS_QUOTE_MARKER`）；**步与步之间是一个原生 `hr` 元素**（不是 `---` 文本——卡片 markdown 不保证画成线，而画一排制表符是假线还照样占一行），只落在步与步之间（首组之前不加、同一步被叙述行拆成两个元素时也不加），**名字 + 它碰了什么 + 耗时**（无参数/结果/推理）+ **该步的叙述行**（`💬 我先看一下…`——同一条消息里既写话又调用工具的正文属于过程，不是答案，判据与 WebUI 的 `latestAnswer` 一致；取首个非空行、折叠空白、80 字**安全**截断——走 `truncateInline()`，绝不在 `**`／行内代码里下刀，见关键坑 60）；连续同名调用合并（`×N`，耗时累加），合并行的名字**跨调用累计、最多 3 个**（`bash ×3 · npm / tail / git`，不是把每个命令的程序全列出来）；**行的"碰了什么"由 `feishu-streaming.ts` 的 `progressToolDetails()` 派生**——文件类工具给末两段路径（`…/src/feishu-progress.ts`），`bash`/`pwsh` 给程序名（**`src/shell-programs.ts`（新）** 的 `shellPrograms()`：**解析而不是切分**——引号、`#` 注释、heredoc 正文整体跳过，分隔符只在它们之外生效，`\` 续行留在同一段，`do`/`then`/`{` 只跳过自己（`do curl` 要认 `curl`），`for`/`done`/`$(…)`/`cd` 整段跳过，候选词必须是**裸程序名**才采纳，取 basename、去重、上限 3；**读不出来的词直接丢**，因为写错一个名字比不写更糟。2026-10-12 用会话日志里 12 条真实命令复现过：修前 6 条错（引号内 `\|`、heredoc 散文、循环关键字都被当成程序）），其余工具不给（名字已经说明一切）；超过 `PROGRESS_MAX_ROWS = 40` 行**按整步**折叠进 `collapsible_panel`，面板正文再限 `PROGRESS_MAX_FOLDED = 60` 行（折叠只省屏不省字节）。正文元素间距用实测合法的 `body.vertical_spacing: 4px`（坑 58），并且**一步的行装在同一个 markdown 元素里**（2026-10-11，②）：每个元素都是一个独立块、两侧各付一次间距，实测一张 327 字的卡曾为此付掉 64px 纯间距；元素内换行是普通换行，于是只有**步与步之间**付间距（步边界因此仍看得出来）。**叙述行是模型文本，只有行内标记成对时（`**`／反引号计数为偶）才并入本步元素**，否则单独占一个元素——奇数的 `**` 在多行元素里会与下一行配对、渲染成错的加粗（坑 60）**可见窗口 = 最新 `PROGRESS_MAX_STEPS = 3` 步**（2026-10-12 起**按步骤计数**而不是按行数：三步是"在干什么 + 怎么走到这"，更早的整步连同标题折叠；`PROGRESS_MAX_ROWS = 40` 仍是外层上限，因为单步可能有几十个调用）；**运行中的工具显示 `执行中`，超过 1 秒显示已耗时间，并由 30 秒一次的重绘（`PROGRESS_RUNNING_TICK_MS`）推动**，最后一个调用结算即撤掉计时器（快调用不排 tick）；**注入提示行渲染在它所属 step 的小节里**（`📥 …`，排在叙述与工具行之前）；**别的模块在它下面发过卡之后本卡停更**（`src/card-interleave.ts`）：下一次事件新开一张只渲染 `segmentFrom` 之后内容的卡（计数仍是整轮总数）。**写入纪律**（关键坑 45/57）：一次写入在飞 + `PROGRESS_WRITE_GAP_MS = 900` 合并窗口 + 只写最新一版；整卡发不出去时回合结束补**一条纯文本**汇总（坑 40）。**寿命红线**：卡片实体只能发送一次且 14 天有效 ⇒ 每回合新建、不落盘、不跨重启恢复；**永不带按钮/可点行**（坑 11/55）；本插件未启用 `streaming_mode` ⇒ 不受 10 分钟自动关闭约束 |
| `src/card-supersede.ts` | 交互流程「每步发新卡」的配套：把被替换的旧卡片改写成无按钮的失效提示（zh/en 双语，优先 CardKit 实例、best-effort） |
| `src/feishu-todos.ts` | Todo 进度卡片 |
| `src/feishu-approvals.ts` | 工具审批处理 |
| `src/feishu-questions.ts` | **`ask_user_question` 卡片**（关键坑 11 / 54 / 55）。**单选题**：每个选项是**整行可点**的 `interactive_container`（行内「序号 + 加粗标签 + 描述」，**没有选项按钮**），点一下把该卡**冻结成无交互灰卡**（`⏳ 已选择 …`）并**另发一张确认卡**；确认 → 结果**再发一张新卡**、原卡变灰「已提交」；返回 → 原卡变灰「已作废」+ **新发一张可交互的问题卡**——飞书客户端会**消费掉被点过的可点行**（同一张卡后续行点击不再投递回调，坑 55）⇒ 必须重发，且所有回调**按 `evt.messageId` 认当前卡**、旧卡点击一律忽略；结果卡发不出去时回退为把结果写进问题卡。**多选题**：`form` + **每个选项一个 `checker`**（单个复选框：`text` + `checked`，**没有 `options`**；标签与描述写在复选框上，正文不重复列）+ 一次「✅ 提交」带回全部勾选，**全程不重绘**（天然避开坑 11）；复选框卡被拒时回退「只放序号」的单选卡。数据全取上游持久字段（`AskUserQuestionOption.description` / `AskUserQuestionItem.multiSelect`），**不设自造选项数上限**（旧 `slice(0, 6)` 已删），自定义回答 / 跳过已接 i18n |
| `src/commands.ts` | 斜杠命令注册和处理 |
| `src/feishu-panel.ts` | 两张名册面板卡共用的**只发不更新**快照发送器：同一刻合并（flush 时重新渲染）· 非紧急刷新下限（默认 30s，仅细节变化时生效）· **指纹去重**（耗时等时钟文本不进指纹，故"时间流逝"不能成为发卡理由）· 按 chat 串行；`hasPending()` 让"正在构建中的卡"吞掉紧随其后的细节刷新；`keyOf()` 维护**有界**的 `messageId → 名册键` 映射给卡片按钮回查用（关键坑 31）；另提供表格渲染与单元格转义/截断、`formatDuration`、话题回复坐标 |
| `src/feishu-jobs.ts` | 后台任务**面板卡**：标题固定 `🧩 后台任务`，**一张卡列出该聊天全部后台任务**（状态 · 任务 · 编号 · 耗时 · 进度/结果），名册一变就**发新卡**（不就地更新）。判据 = 工具结果句式（关键坑 37；前台 bash/pwsh 调用不列）。订阅 `ctx.jobs` 事件扇出跟随状态，`removed` 只清账、**行留在名册**；上限 8 行 + 已结算 30 分钟 TTL。带 **`🧹 清理已完成`** 按钮：只从名册删已结算行（宿主注册表不动，对齐 WebUI 的 Clear），有运行中行就重发干净卡、清空则回文字；回调按被点击卡片的 message id 回查名册键。`dispose()` 退订、退订卡片回调并清定时器 |
| `src/feishu-subagents.ts` | 子代理**面板卡**：标题固定 `🤖 子代理`，同样只发不更新。数据源 = 父会话的 `subagent/catalog`（会话事件，给 id/模式/描述/创建时间）+ 宿主 `subagent/start` / `subagent/end`（scoped dispatch，本模块用 `{ global: true }` 注册），**按子会话 id 关联**；**模型**另取自**子会话自己**的 `request/context`（父级事实里没有）。不读 `listChildren` / `listDescendants`。归属：已知子会话的父 → 孙代理（同聊天）；否则父会话能解析出聊天 → 直接子代理；否则不渲染。渲染按**深度优先**排（父行紧跟其子树），嵌套用 `├─ ` / `└─ ` + `│  ` **画线**（连接线在行内代码之外，否则会被 `tableCell` 的空白折叠压平）；父行不在名册时该行当根。进程外子代理（`local: false`，无本地子会话）不列 |
| `src/card-markdown.ts` | **卡片 markdown 的图片/链接中和**（关键坑 39）：飞书把 `![alt](src)` 当**图片元素**、`src` 只认上传后的 `img_v3_…`，本地路径与公网 URL 都会让**整张卡**被拒（`200570`/`230099`）。本模块把**闭合代码跨度与围栏之外**、又不是真 key 的图片引用降级成 `🖼 alt · path`，把飞书点不动的相对/绝对路径链接降级成 `label · path`；外链、`mailto:`、真 key、闭合代码跨度原样保留。扫描器按实测写：**只有闭合**的反引号才保护（未闭合的、以及目标里的反引号都不保护），表格单元/引用块/带 `"title"` 的写法都覆盖。`neutralizeCard()` 递归改写卡片树里的每个 `markdown` 元素，`isCardContentRejection()` 判定"内容级拒收"。**最后一道是强调边界规范化**（`src/card-emphasis.ts`，关键坑 60），所以判的是飞书真正收到的文本 |
| `src/card-emphasis.ts` | **加粗的强调边界规范化**（关键坑 60，2026-10-10 真机探针定论）：飞书**不认**「关闭 `**` 夹在末尾标点与紧跟的字之间」这种写法——`**加粗。**后面`、`**加粗：**后面`、`**带括号（说明）**后面`、`**加粗…**后面` 全部按**字面**渲染出星号，而把标点移到加粗外面（`**加粗**。后面`）恢复正常，**可见文字完全不变**（这正是 CommonMark 的分隔符规则，第三方实现 loopx#5352 独立得出了同一结论）。`normalizeCardEmphasis(text)` 只处理成对的 `**`（`***` 长串不碰），把加粗内部的末尾标点移到外面；**围栏代码块、行内代码 span、转义字符、链接目标一律不透明**，未闭合的 marker 不动，**幂等**。实测覆盖全部 9019 条真实助手文本：67 条（0.74%）/ 87 行被改写，可见文字 0 变化 |
| `src/text-chunk.ts` | **卡片文本的分块与安全截断**：`chunkText()` 按块（空行）切分长文本，块内不切——围栏代码块按「关掉再重开」、表格按「重复表头」拆，只有超长单行才按字符切（2026-09-18 起，避免表格/代码块被切两半）；`truncateInline()` 是**一行式预览的固定字数截断**：切之前先找出切口处仍未闭合的 `**` 或行内代码 span，把该 opener 丢掉再补省略号（**不自动补闭合**），因为一条被切在 `**…**` 里的解说行会让卡片显示字面 `**`（关键坑 60，2026-10-10）；`capChunks()` 是给已分块列表的硬上限兜底 |
| `src/card-write.ts` | **卡片写入的安全网**（关键坑 39）：写入前先中和图片引用；仍被飞书拒收（内容级）就用"无差别剥掉全部图片引用"的版本**重试一次**；`nextSequence()` 维护 CardKit `sequence` 的**单调下限**，使重试不会复用调用方已计过的号；`noteCardMessage()` / `messageIdFor()` 记 `card_id → message_id`，供适配器在实例更新仍被拒时**回退 `im.v1.message.patch`**（这是"卡片静默停在旧内容"的唯一堵口）。`withCardSafety()` 包一层通道，让**直连 SDK** 的 `channel.ts` 回复卡也走同一套。**创建侧的同一条纪律**：飞书对非法卡内容**不抛错**，而是 `code=200570` + **空 `card_id`**（真机实测）→ `createCardInstance` 必须对非零 code 抛出**带 code/msg 文本**的错误（否则拒收重试与回退 patch 都认不出来），空 id 一律拒绝；调用侧也把空 id 当"没有可用引用"，走普通发送而非 `sendCardByReference('')`（那会 `cardid is invalid` 且不再回退，卡永不出现，关键坑 41） |
| `src/card-images.ts` | **把工作区媒体内联进卡片**（关键坑 39 的 L3，2026-09-24 扩到视频/音频）：正文里带 `()` 目标的 Markdown 引用（`![图](path)` 与 `[片段](path)`）指向会话工作区内真实媒体时，解析 → 上传 → 改写。改写分三态：图片换成 `img_v3_…`；音频原地插入 `<audio file_key='file_v3_…'>`（`audio_id` 由 key 派生，卡片更新不打断播放）；视频**把 markdown 元素拆成「文字 + `{tag:'video'}` 元素 + 文字」**（媒体元素装不进富文本），并给卡片补 `config.enable_forward = false`（飞书对含音视频的卡片强制要求，否则整卡发送失败）。范围收窄（上传=把文件发到飞书）：只认 Markdown 引用里的路径、只认 `realpath` 后仍在工作区内的文件（符号链接指出去拒绝）、只认魔数嗅探出的真媒体、图片 ≤10MB / 音视频 ≤30MB；每卡上限由设置项 `cardMediaLimit`（1–30，默认 12）给出：图片一处、音视频一处，各按这个数；另有**三个分开的大小上限**（`cardImageMaxMb` 默认 10 / `cardVideoMaxMb` 默认 15 / `cardAudioMaxMb` 默认 15，上限分别是飞书的 10MB 与 30MB），**按分类后的类型**逐类判（超限只 warn + 退回文字，且**不写负缓存**，因此改大设置下一次写卡就生效），**数的是这张卡实际渲染几个**（缓存命中与新上传一起计数，所以同一张卡的重复渲染得到同一组媒体），并有一条最坏情况不变量测试保证构建出的卡片仍在飞书的 200 元素 / 30KB 之内。缓存按 `path+mtime+size`，另有"检查过但不是媒体"的**负缓存**（普通文件链接不反复读盘），同文件并发**共享一次上传**。预算分两档（图片 6s / 媒体 15s），超时就留在文字里、在途上传继续跑并写缓存。上传走**有界并发 3**（六个片段一轮往返而不是六轮）；`warm()` 让流式正文一出现媒体引用就提前跑同一条判定链（结果丢弃、**不写负缓存**，因为工具可能还没写完那个文件），于是写卡时通常是缓存命中。任何失败都退回文字形态 |
| `src/media-upload.ts` | 卡片媒体的**上传与转码**：`im.v1.image.create` / `im.v1.file.create`（`file_type: 'mp4'` / `'opus'`）+ `ffprobe` 取时长 + `ffmpeg` 抽视频封面、QuickTime → MP4 转封装（`-c copy`）、wav/mp3/m4a/flac → Opus 转码。每个网络/子进程调用都有超时，临时文件必删，任何失败只 warn 并返回 `undefined`（引用退回文字，绝不让媒体拖垮消息）；ffmpeg 缺失时对应格式不内联。测试用的 ffprobe/remux/transcode/封面四处都能注入替身 |
| `src/deliver-files.ts` | **`present` 交付物的分类与去重**：按扩展名分流（图片/视频/音频 vs 文档白名单 pdf/doc/docx/ppt/pptx/xls/xlsx vs 其他），给出飞书两个硬边界（文件 30MB / 图片 10MB）与 `formatFileSize()`；并维护「本会话 10 分钟内已发过这个 `realpath`」的表，让模型显式 `feishu_send_file` 过的文件不会因 `present` 再发一遍。**`.ts` 故意不算视频**（代码工作区里它是 TypeScript，误判会让源码永远进不了投递） |
| `src/feishu-deliver.ts` | **`present` 交付的规划与投递**（TODO O25）：发卡前 `stat` + `realpath` 判工作区包含，产出卡片行（媒体写成 `[预览](路径)` 交给 hydrator 内联并**在行上写文件名**；白名单文档 ≤ `deliverDocMaxMb` 标 `自动投递`；其余与超限文档是 `interactive_container` 可点行；超 30MB/不存在/区外只写原因）；发卡后自动推送白名单文档（单轮上限 8，`DELIVER_AUTO_CAP`，走 `feishu-send-file.ts` 的 `sendWorkspaceFile`）；点击流是 `不透明 token → 确认卡 → 📤 发送`，token 30 分钟过期、上限 200、**每次点击重验**存在性/普通文件/≤30MB/`realpath` 仍在工作区内，且**回调载荷里不放路径**。话题取规划期存下的坐标（并配合 `channel.ts` 的 `noteCardTopic` 登记），不用「按群最近使用」兜底 |
| `src/produced-files.ts` | **本轮「产出」的文件**（TODO O3，WebUI `produced` 集合的宿主侧镜像）：从 `write` / `edit` / `str_replace_editor` 的**参数**取路径（与 `ui-deliverables` 同一套校验规则），与该调用**成功**的 `tool/result` 配对——所以采集必须发生在 `tool/call`（参数只在那一侧）与 `tool/result`（成败只在那一侧）两处。**刻意不做全表**：飞书是聊天不是工作区浏览器，而这套仓库里的 produced 几乎全是源码/测试/`/tmp` 脚本（实测 69 条 produced vs 3 条 presented，全部是工作区文件）⇒ `producedArtifacts()` 只留媒体与白名单文档，其余静默丢弃；`mergeProducedArtifacts()` 把留下的按**解析后路径**去重并入 `present` 的交付清单，于是它们走 `feishu-deliver.ts` 完全相同的三条投递路径。设置项 `produceCard`（`off` / `summary` / `delivery`，默认 `delivery`），`summary` 只在收尾卡写一行计数 |
| `src/shell-programs.ts` | **`bash` 命令跑了哪些程序**（TODO O27 补丁）：给 compact 过程卡的 `bash` 行写 `✅ \`bash\` · npm / tail / git`。**解析而不是切分**——引号内的 `\|`、`#` 注释、heredoc 正文、多行引号里的 Python、`for … do … done` 都不算命令；`\` 续行留在同一段；`do`/`then`/`{` 只跳过自己，`for`/`done`/`$(…)`/`cd` 整段跳过；候选词必须是裸程序名（`/^[A-Za-z_][A-Za-z0-9_.+-]*$/`），读不出来的直接丢。**刻意不是 shell**：不解析命令替换、别名或 PATH。判据来自真机：2026-10-12 拿会话日志里 12 条真实命令跑，旧实现 6 条错（卡片上印出过 `echo / grep / first_frame"`），现在 12 条全对，那 6 条逐字进了 `tests/shell-programs.spec.ts` |
| `src/outbound-timeout.ts` | **出站调用的有界等待**（坑 29）：SDK 的 HTTP client 是 `timeout: 0`，对端不回就永远挂着 ⇒ 每一次出站调用都由 `withTimeout` / `settleWithin` 兜时间；**超时不是取消**（请求可能仍在服务端成功），所以只当「结果未知」、绝不盲目重试发送。2026-10-11 起它承担第二件事：**报告「放弃等待」**——`withLinkTimeout`（`link` 版 `withTimeout`）覆盖全部 18 个真的发飞书请求的调用点，放弃时经 `observeOutboundWaits` 通知 `outbound-health.ts`；**待在自家管线上的等待（卡片链 flush、上一张卡 settle）不是链路事实**，仍走普通 `withTimeout`。预算由调用点自己给（普通发送 20s、发文件 120s），**不在这里猜阈值**（猜小了会把慢上传误判成故障）；上报是 best-effort——观察者抛错也必须让等待结束 |
| `src/outbound-health.ts` | **出站链路的实时健康**（TODO O26，2026-10-11 事故后新增）：`LarkRuntime` 的 `connected` 是**建连那一刻的快照**（`start()` 返回即置位、之后永不复查），于是「WebSocket 连上了」被当成「链路健康」——2026-10-11 16:48–16:56 网关拒掉了**每一个新建的 TLS 握手**（`SSL alert 112`）时，插件详情页徽章仍显示「已连接」（同段时间入站长连接活着，`[msg]` 照收）。这里改成按**请求自己**判定，两个来源合起来才是全部：① **有结局的请求**由 `wrapHttpInstance` 观测 —— SDK 的每个 HTTP 请求都过 `Client`/`WSClient` 的 `httpInstance`（实测只调 `.request`），所以把 SDK 的 `defaultHttpInstance` 用 **Proxy** 包一层交给 `createLarkChannel({ httpInstance })`（Proxy 而不是逐方法转发：接口以后新增方法也自动被观测；非函数属性原样透传；调用一律以**原实例**作 receiver，axios 内部 `get → this.request` 的自调用不会重复计数）；② **永不 settle 的请求**（半开连接）没有结局可观测，只能由外层的有界等待上报（`noteAbandoned`，见上一行），否则指示会一直绿着而消息一条都发不出去。判定：**有 `response` = 对端答了**（400/429/500 都算答了，链路是好的）/ **没有 `response` = 链路失败** / `ERR_CANCELED`（我们自己取消）两者都不算；`verdict` 自第一次无人应答（或放弃等待）起 `failing`，下一次收到应答才回 `ok`（失败数留作历史），`observed === 0` 表示「还没发过请求」而不是「健康」。入站半边由 `runtime.ts` 读 `channel.getConnectionStatus()` 随状态一起报，UI 只在 `connected` 之上二次判读 |
| `src/feishu-turn-origin.ts` | **回合来源判别**：DSH 的 `SessionPromptRequest` 没有客户端身份字段，所以来源只能从原生 `user/message` 的 `source` 读——插件 mint 的 `requestId` 被 `session-controller` 原样写进 `source.rpcId`（精确匹配）；直连 `agent.steer/followup`（图片/文件消息，无 `rpcId`）记一次性标记、只被「带附件的下一条消息」消费；其余 `kind:'user'` 即其它入口（`clientTimeZone` 只用于区分「Web GUI」与「其它入口」的文案）。**逐回合**判定（`turn/start` 重置、本回合第一条用户消息定调），Web GUI 的插话不会把正在跑的飞书回合改判 |
| `src/feishu-surface.ts` | **飞书界面提示词**：用 `systemPrompt.section`（`inject` 动态注入，与 Web bundle 的 `app:web-surface` 同形、同一个 `WEB_SURFACE` 顺序槽，排在 `ui:deliverable-file-references` 之后）补一句只有本通道知道的事实——用户在飞书、打不开本地路径、`present` 落在回合末交付卡上、要用户能保存/转发的原件就调 `feishu_send_file`。`text` 是 provider：非绑定会话返回 `''`（别的 surface 提示词一字不变）；**每会话稳定、不随回合变**，避免 system 节点追加与缓存前缀失效。设置项 `surfaceContext` |
| `src/feishu-external-turns.ts` | **外部入口回合的镜像与收尾**（TODO O25 的剩余半边）：`user/message` 来自其它 surface 时以纯文本回显进该会话的话题（硬规则 3），`turn/end` 时对**非飞书发起**的绑定回合复用 streaming 的 `flushed()`（保证收尾卡排在最后一张步骤卡之后）+ `renderFooterCard(..., externalTurn)`（首行标注「不是从飞书消息发起的」）+ 同一个 deliver 控制器（可点行 token、话题登记与飞书发起的回合完全同一条路径）。飞书发起的回合由 `channel.ts` 独占 ⇒ 同一回合不会有两张收尾卡。设置项 `mirrorExternalTurns`；**一期不上传附件**（只写「N 张图片 / N 个文件」），也没有「最后一张步骤卡写入失败」时的正文回退 |
| `src/error-text.ts` | **用户可见的错误原因**：把捕获到的 `unknown` 变成一条能发回聊天的理由。刻意**比 `.message` 多走两步**——补上飞书 SDK 响应信封里的 `response.data.msg`（`Request failed with status code 400` 的真正含义在那里），并沿 `cause` 链（最多 4 跳、去重、防自引用）用 ` ← ` 拼出被外层包装掩掉的根因；`code` 优先取错误自身、其次取信封里的业务码。只读 `message`/`code`/`response.data`，**绝不读 `config`/`request`**（那是请求体，token 路径上有 app secret，关键坑 29）。上限 `ERROR_TEXT_CAP = 1000`：实测 23 个会话日志 / 734 次失败最长 344 字，该上限几乎不生效，只是防病态负载；调用方一律发**文本消息**（150KB 上限是卡片的 5 倍，且不解析 markdown ⇒ 不会被图片/链接语法整卡拒收） |
| `src/client/` | Web 客户端半边：设置页（`LarkSettingsCard` + `LarkSettingsCardController`，**只管配置与凭据**）与**插件详情页**的三处贡献（`LarkPluginDetail` 的 badge / actions / section，配合 `LarkChannelStatusController` 的连接状态与扫码轮询）。经 `ctx.slots` 注册、`ctx.configForms` 读写配置、`ctx.remote.credentials` 读写密钥 |

## 事件流

每个 agent step 的事件流：

```
step/start        → 记录开始时间与 1-based turn/step（resetStep 清空本 step 的卡片身份）
assistant/chunk   → 累积 reasoning/text（旧版 DSH；0.1.3 已移除该事件）
assistant/message → 0.1.3 的唯一来源：用 event.data.stream 经 expandAssistantStream 重建
                    reasoning/text，并记录 usage、首 token、最后一条 reasoning 的时间
                    （思考耗时 = 末 - 首），然后发卡/更新卡
tool/call         → 追加工具调用（状态 ⏳ running），已有卡更新、无卡则发卡
tool/result       → 追加工具结果和预览（✅/❌），更新卡片，记录完成时间
turn/end          → flush 待发卡 + pending debounce → 发送溢出文本 continued 卡（如有）
                    → 发送 Turn Complete footer 卡
```

> **一步一卡**：`assistant/message` 与 `tool/call` 都遵循「本 step 已有卡就更新，否则排入首发」。首发经 `queueStepCardSend` 防抖 150ms 合并（见下），排入后 `stepCardSent` 为真而 `stepCardRef` 尚空，窗口内的事件只改状态、不触发更新——定时器到点用当时的状态发**一张**卡。任一分支无条件发新卡都会让 `state.stepCardRef` 改指新卡，**旧卡从此收不到更新**——表现为工具永远停在 `⏳ running…`，或卡片只剩 reasoning。
>
> **防抖按卡片 ref 键**：`pendingUpdates` 是 `Map<StepCardRef, …>`，不是 `Map<SessionStepState, …>`。一个 state 对象服务该会话所有 step，按 state 键会让下一步骤的更新取消上一步骤尚未触发的 150ms 定时器，上一步的卡片丢掉工具结果。
>
> **实例更新必须等消息发出**：飞书在发送引用卡片实体的消息时对内容做快照，`cardkit.v1.card.update` 若发生在 `sendCardByReference` 之前**不会进入该消息**（卡片停在创建时的内容）。故 `executeCardUpdate` 先 `await ref.messageId` 再更新；`sequence` 仍单调递增。

## 卡片设计

- **Step 卡片**：每个 agent step 一张，wathet→green/red 颜色变化。标题 `{状态} · 第 N 轮 · 第 M 步`；reasoning 标题带思考耗时与思考 token（`💬 **推理** · 4.3s · 1.2K tokens`）；footer 两行——第一行 `⏱ 时长 · 📥 本步新输入（有缓存命中时带 ♻️ NN%）→ 📤 输出`，第二行 `🚀 tok/s · 📊 上下文占用/窗口 (百分比)`。**📥 只算本步真正处理的输入**（`inputTokens + cacheWriteTokens`，命中读取是复用、不计入），所以它**不再**和 📊 的上下文总量重复——后者是最近一次请求的完整 prompt，只出现在这一处；text 超 3000 字自动拆 `Reply (continued N/M)` 卡发送（续卡也带 tok/s）。发送走 **CardKit 卡片实例**（`createCardInstance` → `sendCardByReference`，更新走 `updateCardInstance` + 单调 `sequence`，通道缺这些方法时回退 `send` + `updateCard`）——step 卡没有按钮，不受「同一条消息就地更新 2–3 次后按钮回调失效」的限制，因此可以持续原地更新
- **Turn Complete 卡片**：turn 结束后发送，绿色。若本轮有交付物，`📦 交付物（N）` 清单**排在卡片最前面**，其后以分隔线接性能指标（耗时 / LLM / 工具、TTFT / tok/s / 步数、token 明细与缓存命中率），再一条分隔线接配置信息（工作区 / 模型 / 推理强度 / 上下文占用 / Enter while busy）
- **Todo 卡片**：turquoise，含进度条
- **审批卡片**：orange，含 approve/deny 按钮
- **任务卡（后台任务）**：一个后台任务一张卡，发在**它所属会话绑定的飞书会话**里。`registered` 建卡 → `progress`/`stopping` **就地更新同一张卡**（卡上没有按钮，所以可以连续原地更新；带按钮的卡不行，见关键坑 11）→ `settled` 立刻刷新为终态（completed 绿 / failed 红 / killed 灰 / stopping 橙）→ `removed` 改写为「已失效」。**未绑定会话或无主的任务不发卡**——绝不按群猜话题（关键坑 31）。`progress` 突发按 300ms 合并，结算走立即刷新

## 技术要点

- **Debounce**：`STEP_CARD_DEBOUNCE_MS = 150`。**首发也防抖**——快模型一步内 reasoning→tool/call→tool/result 全落在窗口内时只发一张卡（内容已含结果），不产生 send+update 两次渲染；步骤在窗口内结束或 turn/end 时 `flushPendingSend` 立即补发。**更新防抖表按卡片 ref 键**（见上「防抖按卡片 ref 键」），且实例更新必须等消息发出（见上「实例更新必须等消息发出」）
- **交互卡片不能就地更新**：飞书对同一条消息的卡片就地更新约 2–3 次后**不再投递按钮回调**（`im.v1.message.patch` 与 `cardkit.v1.card.update` 同样受限）。带按钮的卡片（`/new` 流程、目录浏览器、`/model`、`/session` 面板）**每一步都新建卡片实例 + 发新消息**；旧卡留在聊天里，不做 recall
- **旧卡改写为失效提示**：每发一张新卡，就用 `src/card-supersede.ts` 把上一张改写为无按钮的灰色提示（顺序 `send → supersedePrevious → note`）；结果/错误卡 `terminal: true` 只改写上一张、自身不进记忆。改写失败只 warn，不阻断流程
- **Flush 同步**：`turn/end` 时 flush pending debounce，确保卡片更新在 Turn Complete 之前完成
- **Error-safe**：内层 try/catch 保护 mux 事件处理，防止单个事件错误导致整个流断开
- **Card JSON 2.0**：所有卡片使用 `schema: '2.0'` + `body.elements`，原生支持 markdown
- **入站图片判型按字节**：飞书 `messageResource` 不给内容 MIME、SDK 归一化的 image 资源无文件名，故图片必须**先下载字节、用 magic bytes 判真实格式**（`sniffImageMime`）再交给 `attachments.saveImage`，**不得猜 JPEG**——DSH 附件库会校验声明与实际字节（`IMAGE_TYPE_MISMATCH`），猜错即拒收非 JPEG 图片
- **入站文件/图片统一走 DSH 原生附件库**：图片经 `admitImagesForMessage` → `saveImage`；文件经 `admitFilesForMessage` → `downloadStream()`（`AsyncIterable`，背压）→ `saveFileStream`。两者都落 DSH 原生附件库（`~/.dsh/attachments/v1/`，文件在 `files/<sha256 前 2 位>/<sha256>/<文件名>`），agent 经 `fileHostPath` 读取；不再写 `.feishu-inbox/` 或注入 `[文件: …]` 文本（单路径）
- **会话事件读取必须按 seq 范围，不要全量物化**：DSH `Session` 的 `snapshotEvents(fromSeq, toSeqExclusive)` 无参默认 `(0, seq)` 且**缓存一整段日志的冻结副本**（`eventsSnapshot`）；会话日志是 **append-only**、随使用无限膨胀。插件读会话事件（如 `summarizeTurn` 做本轮摘要）应传 `firstSeq` 只取本轮增量，避免每条消息全量复读+常驻副本引发的内存峰值（本项目曾直接 `JavaScript heap out of memory`）。
- **压缩只改 surface、不删日志**：DSH `compaction-basic` 压缩改写的是 **surface（进模型的上下文视图）**，经 `replaceGeneration` 替换它；**事件日志本体不被删除**，仍是全量。故日志体积只能靠「新会话/归档」收敛，压缩只降低每轮上下文折叠的峰值。读会话事件时须牢记「日志 ≠ 上下文」这一差别。
- **标题色带是客户端渲染，插件只保证数据正确**：每张步骤卡的 `header.template` 都随状态写入（调用中 wathet → 完成 green / 失败 red / 回复 blue）。已核实某些飞书客户端在卡片实体更新后不重绘标题背景（同一条消息在不同设备上一台正常、一台白底），而用 `im.v1.message.list` + `card_msg_content_type: 'user_card_content'` 拉回的服务端实体始终是正确颜色。**这是飞书客户端问题，不要在插件里改 header 数据去"修"它**。
