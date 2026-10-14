# 架构 / Architecture

> 当前实现说明，基线为仓库主线与 DSH `0.2.0-rc.2`。历史 API 和候选方案见 [文档索引](<./README.md>)；不要把它们当成当前契约。

## 数据流

```text
Feishu / Lark user
  │ im.message.receive_v1 (WebSocket)
  ▼
Lark SDK (normalization, policy, deduplication, queue)
  │ NormalizedMessage + admitted attachments
  ▼
Conversation bridge (chat/thread ↔ SessionId, persisted topic roots)
  │ Workspace + recorded/new-session preset and model route
  ▼
DSH Agent (model, tools, approvals, questions, durable session log)
  ├─ session/event ──────────────► committed content and usage
  └─ agent/assistant-stream ─────► transient phase changes only
                                  │
                                  ▼
                      step cards / compact progress segments
                                  │ flush + delivery checks
                                  ▼
                      completion card + native file delivery
```

插件在宿主进程内运行，复用 DSH 原生服务。Web 半边通过槽位提供设置与插件详情页；没有独立服务或公网 webhook。扫码与运行状态通过宿主上的回环路由 `/dsh-feishu/provision` 获取；配置、凭据分别走 `configForms` 与原生凭据服务。

**English:** The bridge runs in the DSH process, reusing native services. Its Web half contributes settings and plugin details. No separate service or public webhook is required; provisioning/status has a loopback-only host route, while configuration and credentials use native services.

## 模块导航

表中只列职责，行为约束集中在后面的小节，避免长段落塞进表格并重复维护。

### 入口、会话与界面

| 文件 | 职责 |
|---|---|
| [入口](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/index.ts>) | 服务接线、运行时、命令与卡片通道；发送排序屏障与生命周期 |
| [配置](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/config.ts>) | Config schema、默认值、live Config 读取、连接指纹 |
| [运行时](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/runtime.ts>) | 建连、配置协调、运行状态 |
| [聊天通道](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/channel.ts>) | 入站附件 admission、回复兜底、收尾卡与交付接线 |
| [会话桥](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/harness.ts>) | 聊天绑定、会话恢复、模型/preset 路线、消息派发与状态持久化 |
| [命令](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/commands.ts>) | 插件斜杠命令与宿主命令转发 |
| [Web 路由](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/web.ts>) / [扫码流程](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/provision.ts>) | 回环与同源校验；官方扫码授权、权限和事件配置 |
| [客户端入口](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/client/index.ts>) | 设置页配置，以及插件详情页的状态、扫码动作与区块 |

### 过程、交互与名册

| 文件 | 职责 |
|---|---|
| [步骤卡](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-streaming.ts>) | 持久事件消费、相位、内容渲染、更新节流、送达记账、溢出续卡 |
| [档位策略](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/display-level.ts>) | `transcriptView` + 四开关投影成渲染策略 |
| [回合过程卡](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-progress.ts>) | compact 工具/叙述/注入时间线、状态灯、窗口、折叠与分段 |
| [压缩卡](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-compaction.ts>) / [注入提示](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/injection-notice.ts>) | 压缩事务状态与摘要；只渲染注入来源元数据 |
| [穿插通知](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/card-interleave.ts>) | 其它卡片落入聊天时关闭长寿命卡的当前分段 |
| [提问](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-questions.ts>) / [审批](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-approvals.ts>) / [双端协调](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/dual-answerer.ts>) | 飞书与 Web UI 同时展示、谁先处理谁生效 |
| [会话面板](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-session.ts>) / [新建流程](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-onboarding.ts>) / [模型选择](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-model-select.ts>) | 会话与工作区操作、模型选择与创建确认 |
| [显示控制](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-display.ts>) / [Todo](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-todos.ts>) | 展示配置卡与进度清单 |
| [名册发送器](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-panel.ts>) | 快照指纹、合并、节流、按聊天串行、按钮归属回查 |
| [后台任务](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-jobs.ts>) / [子代理](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-subagents.ts>) | 真正后台任务的名册；子代理生命周期、模型、树与手动目录合并 |

### 渲染、交付与可靠性

| 文件 | 职责 |
|---|---|
| [Markdown 安全](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/card-markdown.ts>) / [强调规范化](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/card-emphasis.ts>) | 修粘连围栏、中和非法媒体/路径语法、修强调边界 |
| [文本切分](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/text-chunk.ts>) / [折叠外观](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/card-fold.ts>) | 块感知切分、安全预览截断；统一折叠面板 |
| [安全写入](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/card-write.ts>) / [旧卡退休](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/card-supersede.ts>) / [回调分发](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/card-dispatch.ts>) | 拒收兜底、sequence、实例到消息映射；旧卡去交互；回调错误隔离 |
| [话题回查](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/card-topics.ts>) | 根据被点击卡片的 message id 找话题，不按群猜线程 |
| [媒体内联](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/card-images.ts>) / [上传转码](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/media-upload.ts>) | 工作区围栏、缓存、预热、并发、内联元素与可选 ffmpeg |
| [文件分类](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/deliver-files.ts>) / [交付控制](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-deliver.ts>) / [产出采集](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/produced-files.ts>) | `present` 分流、确认 token、去重；成功写入产出的过滤与合并 |
| [主动发送](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-send-file.ts>) / [按需接收](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-receive-file.ts>) | 原生媒体/文件消息；入站资源下载到附件库 |
| [回合来源](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-turn-origin.ts>) / [外部回合](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-external-turns.ts>) / [界面提示](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-surface.ts>) | 来源归因、Web/自动化镜像、绑定会话的稳定通道提示 |
| [有界等待](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/outbound-timeout.ts>) / [出站健康](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/outbound-health.ts>) | 请求超时与健康观测；内部管线等待不冒充网络事实 |
| [错误文本](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/error-text.ts>) / [回合失败](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/turn-failure.ts>) | 安全提取 cause/业务码、对齐 Web UI 的失败事实 |
| [程序名解析](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/shell-programs.ts>) | 解析脚本中的程序名供 compact 摘要；不靠分隔符硬切 |

## 会话与话题

- 单聊/普通群按聊天绑定会话，话题群按线程绑定。回复带 `replyTo: root_id ?? message_id` 和话题选项；根坐标持久化，后续自动回合没有新入站消息也能回复到原话题。
- 卡片回调只有聊天与 message id，**不能按群推话题**。每张卡登记落点，回调按被点击卡片回查；只有缺记录时才走兜底（关键坑 25 / 31）。
- 新会话的显式创建参数优先；恢复会话先读其自己的 preset 和最后记录的模型路线，再回退配置/全局默认。**默认值不是恢复事实**（关键坑 33 / 59）。
- 用户文本不加通道前缀。纯图片/文件用原生内容块；带附件消息不走纯文本 `sessionController.prompt()` 路径。
- 绑定状态原子写入（临时文件 + rename）；disposed 后拒写，已读回绑定却变成空表时拒覆盖，坏文件隔离。`dispose()` 的 clear 不得被 in-flight 收尾再次落盘（关键坑 41）。

## 事件与相位

| 信号 | 用途 |
|---|---|
| `turn/start` | 清回合状态，开始本轮来源判别 |
| 首条 `user/message` 的 `source` | 逐回合认飞书/Web/自动化来源；注入提示只读元数据 |
| `step/start` | 记录步骤开始；非 compact 档可显示“正在分析请求”占位 |
| `request/context` | 记模型路线；事件只在变化时出现，不能当作唯一事实源 |
| `agent/assistant-stream`（瞬时、global 监听） | `start` → 等待输出，reasoning delta → 思考中，text delta → 回复中；仅相位变化重绘，不逐 token 上屏 |
| `assistant/message` | 经 `expandAssistantStream` 重建已提交 reasoning/text 与 usage；这是权威内容来源 |
| `tool/call` / `tool/result` | 调用与结果配对，补状态、耗时、预览与成功产出 |
| `step/end` | 定格步骤，移除实时状态灯，忽略迟到帧 |
| `compaction/start` / `summary` / `prune` / `end` | 压缩事务卡：开始、详情与折叠摘要、成功/失败；prune 可能无摘要 |
| `turn/end` | flush 待发/在飞写入，按送达事实决定正文兜底，再收尾与交付 |

`assistant/chunk` 是旧版事件，**不是当前实时内容来源**。相位在一次尝试内只前进，abandoned 尝试才退回占位等待重试。瞬时帧以子/当前 agent 的会话 id 关联，只处理已绑定会话（关键坑 8 / 67）。

## 卡片生命周期

### 步骤卡：standard / detailed / verbose

每个可见步骤共享同一张无交互卡：占位 → reasoning/text → 工具 → 结果 → 终态。首发与更新使用 150ms 合并窗口；快步骤只发一张。CardKit 实例先创建再发送引用，更新必须等 message id 落地并保持 sequence 单调；能力缺失则退回普通发送/patch。

正文按块切分，步骤首片预算 3,000 字符，溢出最多 30 张续卡；代码块闭合重开、表格重复表头。推理详细档预览 200 字，verbose 面板保留全文；工具参数/结果则仍有 2,000/1,500 或 6,000/6,000 字符上限。**完整推理不意味着任意大小卡片都能送达**。

footer 中 `📥` 是未缓存输入 + 缓存写入，不含缓存读取；完整上下文只在 `📊` 显示。推理 token 只有上游提供才显示，当前验证基线没有生产者，不估算（关键坑 49）。

### 回合过程卡：compact

- 首次工具调用懒创建，工具全关或整轮无工具则没有过程卡。最终答案仍有自己的卡；同消息带工具调用的叙述只作为过程行。
- 注入提示优先放所属步骤的过程行；无过程卡时保留在答案卡上，不为注入强制另发步骤卡。
- 写入合并间隔 900ms，一卡一次在飞，仅保留最新快照；运行标题 `🐳 深度求索中 · 耗时`；运行步骤表头显示等待/思考/回复状态，**尚有工具未结算时工具态优先**。结束即熄灯，时钟最多每 30 秒刷新。
- 显示最新最多 5 步、40 行，按整步折叠更早内容，折叠区另限 60 行。**折叠只省屏，不省 JSON 字节**。
- `groupByStep()` 供可见与折叠区共用：每步通常一个 markdown 元素；行内标记不成对的叙述单独拆出。标题不带 `>`，每条内容行显式带 `> `；**元素边界阻断跨步引用延续**，折叠区不能拼成一个大元素（关键坑 60 / 63 / 65）。可见步间使用原生 `hr`，折叠区不加步间 `hr`。
- 文件工具摘要只写裸文件名，脚本工具写可可靠解析的程序名；合并同名调用累加耗时与次数，细节去重最多 3 个。同名文件在这份摘要里可能不可区分，需查原调用。
- **回合失败时标出死在哪一步**：`turn/end` 报错就给最新一步加 `❌ 失败`，并列出这一步**流式生成过、但没真正执行**的工具调用（`⚠️ \`edit\` · 未执行`）。DSH 只在尝试**未提交**时追加 `assistant/attempt`，那是这类调用唯一的去处——失败的那一步因此不再只剩一个光秃秃的步头。这些调用不是工具行：没有状态与耗时，也**不计入标题的工具数**；重试提交或真出现 `tool/call` 时标记会被清掉，避免“恢复过的一步还在说自己什么都没跑”。
- 卡片穿插后关当前分段，**下一件真实活动才开新卡**，不因穿插通知立即复制旧内容。于是“一轮过程”可能有多个消息分段，不是强制一轮一消息（关键坑 57）。
- **没有 Turn Complete 卡**：`turn/end` 把筛选后的摘要写进承载答案的那张卡（答案被切成续卡时写在最后一张），内容取舍与理由见 [摘要模块](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/turn-summary.ts>)；这次写入不带正文，不影响 `flushed()` 的送达判定。**收尾卡在 header 上自报完成**：标题 `✅ 完成 · 总时长`（绿头、不带轮/步坐标——总时长因此不在 footer 重复），正文与 footer 之间一道 `hr`，footer 只留 `📦 回合 tokens · ♻️ 命中率`（入/出拆分去掉：总数即两者之和）与可选第二行；答案分片时 `📄 续 n/m`，最后一片换成完成标题。交付物另发一张只发一次的「📦 交付物」卡——载着可点行的卡就地更新 2–3 次后不再投递回调（关键坑 11 / 55）。没有任何卡承载正文时（例如镜像回合）发一张最小收尾卡（同一套标题/摘要，标题兜住「回合已结束」这句话）。

### 压缩、交互与面板

| 卡片类型 | 策略 |
|---|---|
| Turn Complete | 非紧凑档在回合末发一张：交付物行 + 统计 + 元信息；`compact` 不发（见上） |
| 压缩 | 一次事务一张无按钮卡，start → summary/prune → end；摘要正文最多 22,000 UTF-8 字节，切口避开字形簇，截断有说明；不提供全文文件按钮 |
| 问题 | 单选点选即记答案并结算问题卡；非最后题发可返回重答的回执；所有题完成后最终卡是唯一提交点。N 题通常为 N 问题卡 + N−1 回执 + 1 最终卡（重答会增加卡片） |
| 多选 | 每个选项一个 `checker`，各有 name；一次表单提交全部勾选，中途不重绘 |
| 双端问答/审批 | 外层 listener `prepend`，飞书先展示再 `next()` 交 Web；先答者胜出，另一端退休；取消批内问题/回执/最终卡 |
| 交互流程 | 通常每步发新卡，旧卡去按钮/退休；已点过可点行的卡不能复用。部分控制卡残余就地更新风险见待办 O4 |
| 后台任务 | 一个聊天一份名册快照，变化发新消息；只认模型确实获得 job handle 的后台调用；前台 bash/pwsh 不列 |
| 子代理 | 自动名册来自 catalog + global lifecycle，模型从子会话 `requestContext()` 与增量事件双源读取；手动 `/subagents` 额外合并宿主目录，`tree` 读 descendants |
| 名册容量 | 最多 8 行、已结算 30 分钟后退出内存名册；历史消息不更新。后台任务可“清理已完成”，仅清名册不清宿主记录 |

卡片实体只能发送一次且仅 14 天可操作；长寿命过程卡不带按钮、不跨轮或跨重启复用，引用不落盘（关键坑 11 / 54 / 55 / 57）。

## 发送可靠性与健康

1. **排序与自锁**：普通卡发送先 flush 步骤卡；步骤卡自己的 send 走 `sendStepCard` 绕过自身排序屏障，由 `previousSettled` 保序，否则会等自己（关键坑 45）。
2. **一卡一次在飞**：写槽只保留最新渲染，慢上传与定时 tick 不能堆成突发。送达使用构建顺序戳 `turnTextOrder`，不是“曾经发过正文”；flush 要等待 in-flight 写入（关键坑 43 / 45）。
3. **内容拒收兜底**：修粘连收尾围栏在扫描最前面，其次处理中和与强调；内容级拒收剥净媒体引用重试、必要时实例更新回退 patch。非零业务码与空 card id 必须当失败（关键坑 39 / 41 / 68）。
4. **有界不等于取消**：真网络请求走 `withLinkTimeout`，内部等待走 `withTimeout` / `settleWithin`。超时是结果未知，服务端可能仍成功，不能盲目重放发送（关键坑 29 / 62）。
5. **健康分方向**：已建 WebSocket 不证明新 HTTP/TLS 请求健康。有 response（即使 400/429/500）说明对端应答，无 response 才是链路失败，自家取消不计；无人应答请求由外层超时上报。入站状态独立读 SDK 生命周期，零观测不是“健康”（关键坑 61 / 62）。
6. **错误最小披露**：只读取 message/code/response.data/cause，绝不序列化 config/request；纯文本报原因，卡片失败后 2 秒内恢复则不报陈旧卡，持续失败每卡报一次。全出站故障时文本通知也可能送不到。

## 附件与交付边界

入站图片下载后按真实字节判型，再 `saveImage`；文件/视频/音频经 `saveFileStream` 落 DSH 原生附件库，不再另建 inbox 路径。图片可以进入视觉模型请求；文件路径只是可读入口，后续工具仍可能读取或发送内容。

正文媒体自动内联默认 realpath 工作区包含校验（区外符号链接拒绝），魔数判型，按类型大小与分组数量限制；3 路有界并发、同文件共享上传、缓存包含 mtime/size。预热不写负缓存，超限不记“不是媒体”；图片为 key、视频为独立元素、音频为播放器，含音视频强制关闭卡片转发（关键坑 42 / 44）。

`present` 规划时 stat/realpath 校验，文档白名单自动投递（单轮最多 8 个），其它文件点击确认；回调仅不透明随机 token（30 分钟、最多 200），**每次点击重验**，不在载荷里放路径。显式发送与自动文档按会话 + realpath 做 10 分钟去重。`produceCard` 只补成功产出的媒体与白名单文档，不推整张源码列表（关键坑 53）。

**这些围栏不能泛化到所有发送入口**：显式 `feishu_send_file` 当前校验文件存在/普通文件/非空/≤30MB，**不校验它仍在会话工作区内**。完整风险与资源可见性边界见 [媒体与隐私](<./privacy.md>)。

## 验证入口

```sh
npm run typecheck
npm test
npm run build
```

单测使用 SDK/service 替身，不连接真实飞书；服务端建卡成功不能证明字段被使用，真发送字段校验也不等于客户端渲染正确。外观改动先发真实渲染样板给人眼确认；上限与字段证据见 [能力参考](<./feishu-capabilities.md>)。

服务端回读需 `card_msg_content_type=user_card_content`，否则 CardKit 内容可能只是升级客户端提示。标题色带部分客户端不重绘已定性为客户端问题，不要改正确的 `header.template` 去“修”它。跨平台验证状态与构建/重载限制见 [项目首页](<../README.md>)。
