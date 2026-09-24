# chatterbox4dsh

**中文** ｜ **English**

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接进飞书/Lark 的唠叨型插件。
> A chatty Feishu/Lark channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

---

## 简介 / Overview

**中文**

把 DeepSeek Harness 的 agent 能力接入飞书/Lark 聊天，并把 **agent 的每一步都唠叨给你看**（推理、工具调用、结果、时长/token）。安装后，用户直接从飞书与 Harness Agent 对话，共享 DSH 的模型、工具、工作区和会话存储。

> **定位**：`chatterbox4dsh`（chatterbox = 唠叨话痨）只做"DSH 原生特性 → 飞书聊天"这一层接入，**DSH 本身才是 agent 本体**。我们不做一个独立的 agent 平台或 24h 常驻助手——那是另一个产品。飞书和 DSH Web UI 共享同一套服务，飞书只是多出一个聊天端口。
>
> **设计理念**：功能对齐优先于功能创新。新增能力前先对照 DSH Web UI 是否有同名/等价能力，有则对齐，无再讨论。
>
> **差异化**：step 级过程透明——每个 step 一张卡片（💬 Reasoning / 📝 Message / 🛠 Tool call + 结果），底部两行 footer（时长/token · 速度/上下文），标题标注「第几轮 · 第几步」，reasoning 标题标注思考耗时与思考 token；快步骤自动合并为一张卡。弱模型下也能观察 Agent 行为并即时干预（`/steer` `/stop`），其余 IM 桥接多收敛到"结果交付/审批"。

**English**

Bridges DeepSeek Harness agents into Feishu/Lark chat and narrates **every agent step** (reasoning, tool calls, results, timing/tokens). Once installed, you talk to the same Harness agent from Feishu, sharing DSH's models, tools, workspaces and session storage.

> **Positioning**: `chatterbox4dsh` ("chatterbox" = talkative) only bridges **DSH's native capabilities into Feishu chat** — DSH itself is the agent. It is not a standalone agent platform or a 24/7 always-on assistant; that would be a different product. Feishu and the DSH Web UI share the same services — Feishu is just another chat port.
>
> **Design principle**: feature parity first. Before adding anything, check whether the DSH Web UI already has an equivalent; if it does, match it; only discuss new ideas when it doesn't.
>
> **What's different**: step-level transparency — one card per step (💬 Reasoning / 📝 Message / 🛠 Tool call + result), a two-line footer (duration/tokens · speed/context), the title tagged with "turn · step", and the reasoning header showing thinking time and thinking tokens; fast steps collapse into a single card. You can watch a weak model work and intervene immediately (`/steer`, `/stop`), while most other IM bridges stop at "deliver the result / approve".

---

## 功能 / Features

**中文**

| 能力 | 说明 |
|---|---|
| 单聊 / 群聊 / 话题群 | 单聊和群聊按聊天复用 Session；话题群按线程独立 Session |
| 统一 per-step 卡片 | 每个 agent step 一张卡片，包含推理、文本、工具调用、结果预览；标题带「第 N 轮 · 第 M 步」，reasoning 标题带思考耗时与思考 token，footer 两行（`⏱ 时长 · 📥 本步新输入 → 📤 输出` / `🚀 tok/s · 📊 上下文占用/窗口`）。**📥 只算本步真正处理的输入**（未缓存 + 缓存写入，命中读取不算），有命中时附带 `♻️ NN%`；上下文总量只出现在 📊 一处，避免与 📥 重复。快步骤（思考→工具调用→结果落在 150ms 内）只发**一张**卡。**思考期占位**：`step/start`（模型请求发出前）就发出「🧠 深度思考中…」卡，并按 5s 刷新已用时；reasoning / 工具调用 / 结果全部在**同一张卡**上就地更新。某步最终没有任何可显示内容时，占位卡改写为「本步无输出」，不会一直停在思考中 |
| 工具调用展示 | 工具名内联代码 + args（独立 fenced 代码块防溢出）+ 结果预览（terminal/web/search/read/diff），原地更新 wathet→green/red |
| 正文媒体内联 | 模型在回答里引用工作区媒体时，卡片把它们**直接内联渲染**（对齐 DSH Web UI「工作区路径可直接打开」，而飞书点不开本地路径）：`![图](runs/a.png)` / `[图](runs/a.png)` → 上传成 `img_v3_…` 显示；`[片段](runs/a.mp4)` → 可播放的卡片 **video 元素**（QuickTime 先 `-c copy` 转封装、`ffmpeg` 抽封面、`ffprobe` 取时长）；`[语音](runs/a.opus)` → 内联 **`<audio>` 播放器**（只认 Opus，wav/mp3/m4a/flac 有 `ffmpeg` 时自动转码）。范围收窄：只认带 `()` 目标的 Markdown 引用、只认 `realpath` 后仍在工作区内的文件（`any` 可放宽）、图片 ≤10MB、音视频 ≤30MB、单卡 ≤12 图 + 12 音视频、上传与 ffmpeg 全部有界（有界并发 3 路，且趁模型还在打字就**预热上传**）；任何失败都退回可读文字，**卡片绝不会因媒体被拒收**。PDF / Office / 压缩包等**没有**卡片组件，仍走原生文件气泡 |
| Turn Complete 卡片 | turn 结束后展示总时长/LLM 时间/工具时间、TTFT/吞吐量、token/缓存命中率，footer 另显示 **Enter while busy**；吞吐量口径与 DSH Web UI `deriveTurnMetrics` 对齐（首 token 判定含 tool-call delta，token 与 decode 时间同批配对）。模型用 DSH `present` 工具声明的**交付物**列在**卡片最前面**（`📦 交付物`，路径 + 描述，之后用分隔线接指标）：**只列清单、不推送文件**，需要时让模型发即可 |
| 会话管理面板 | `/session`：交互式卡片下拉选会话 + 切换/detach/归档/fork/改名/**置顶/取消置顶**/列表/刷新；已置顶的会话在下拉与 `/session list` 表格里带 `📌` 标记；`/session N` 快速切换 |
| 后台任务 / 子代理面板卡 | **标题固定**（`🧩 后台任务` / `🤖 子代理`，不再拿命令当标题），**一张卡列出该聊天全部后台任务 / 全部子代理**，表列分别是「状态 · 任务 · 编号 · 耗时 · 进度/结果」与「状态 · 子代理 · **模型** · 子会话 · 模式 · 耗时」。**只发不更新**：名册一变就发**一张新卡**（当前状态快照），不再就地更新、也不发灰色「已失效」卡。后台任务卡带 **`🧹 清理已完成`** 按钮（对齐 WebUI 的 Clear：只把已结算的行移出名册、宿主注册表不动；清空后回一句文字，否则重发一张干净卡）。**嵌套子代理画成树**：`├─ ` / `└─ ` + `│  ` 竖线（不是空格缩进——飞书会折叠单元格前导空白）。子代理的**模型**来自子会话自己的 `request/context`。判据不变：**只列模型真的拿到 jobId 的后台任务**（`run_in_background` 的 bash / pwsh / `terminal_send`、后台 subagent、workflow），**前台** bash 调用虽然也是宿主 job，但既不发卡也不进表（2026-09-23 修，关键坑 37）。子代理来自父会话的 `subagent/catalog` + 宿主 `subagent/start` / `subagent/end`；未绑定会话、进程外（无本地子会话）的子代理不列。一张卡最多 8 行，已结算的行 30 分钟后退出名册（历史卡保留） |
| 斜杠命令 | `/model` `/new` `/session` `/status` `/stop` `/steer` `/queue` `/busy` `/permission` `/reasoning` `/display` `/approve` `/deny` `/help` 等 |
| 审批 | 与 DSH Web UI 共享同一份 pending 审批状态；审批卡片 **允许在上 / 拒绝在下**，显示原因，**中英双语随 `/lang`**（术语对齐 WebUI：等待审批 / 允许一次 / 拒绝）；本轮中止时卡片自动作废去按钮 |
| `ask_user_question` 卡片 | 问题卡片（选项/自定义输入/跳过），一次多问时**顺序迭代**、整批返回答案 |
| 图片 / 文件接收 | 图片按**真实字节判型**（PNG/JPEG/WebP/GIF）经 attachment store 落盘；文件、**用户发来的视频与语音**同样下载到 **DSH 原生附件库**（`~/.dsh/attachments/v1/files/…`）并附 `fileHostPath` 给 agent 读取 |
| agent 主动发文件 | `feishu_send_file` 模型工具：agent 可把工作区文件推送到当前飞书聊天（≤30MB）。**图片内联预览**、**MP4/MOV（H.264/HEVC/MPEG-4）发成可播放的视频气泡**（有 `ffmpeg` 时附带抽帧封面）、**Ogg/Opus 发成语音气泡**；其余（含放不出来的容器/codec）仍作为文件 |
| agent 接收文件 | `feishu_receive_file` 模型工具：agent 按需/兜底直接下载入站飞书文件（含视频/语音）到 **DSH 原生附件库**，返回 `fileHostPath` |
| 运行中注入 steer | `/steer <内容>` 一次性注入当前 turn；`/busy steer` 可把"运行中发消息"默认设为注入（持久化）；agent 空闲时 `/steer`/`/queue` 自动回退为发新消息。运行中发普通消息会**先回一条纯文本提示**（已插入 / 已排队），且被注入的消息**不再单独回一张回复卡**（由当前轮的回复卡回答） |
| 运行中排队（/queue） | `/queue <内容>` 强制走 queue 路径（即使处于 steer 模式）作为新一轮运行；空闲时回退为发新消息 |
| 权限模式选择 | `/permission`：查看/切换会话权限（沙箱）模式，名称与显示名对齐 WebUI（Read Only / Workspace Write / Full access），**交互式卡片**点选切换 |
| 报错带具体原因 | 出错回报带具体原因与错误码（`errorText`），不再只回统一道歉文案 |
| WebSocket 长连接 | 无需公网服务器，支持飞书中国版和国际版 Lark |
| 访问控制 | 群聊白名单、单聊白名单、@机器人 要求 |

**English**

| Capability | Description |
|---|---|
| DM / group / topic group | DMs and groups reuse one Session per chat; a topic group gives each thread its own Session |
| Unified per-step card | One card per agent step with reasoning, text, tool calls and result previews; the title carries "turn N · step M", the reasoning header shows thinking time and thinking tokens, and the footer is two lines (`⏱ duration · 📥 new input → 📤 output` / `🚀 tok/s · 📊 context used / window`). **📥 counts only what this step actually processed** (uncached + cache writes, never cache reads) and appends `♻️ NN%` when there was a hit; the full context size appears exactly once, in 📊. A fast step (thinking → tool call → result inside 150 ms) sends only **one** card. **Thinking placeholder**: the card is posted at `step/start` (before the model request goes out) as "🧠 Thinking…" and refreshes its elapsed time every 5 s; reasoning, tool calls and results all update that same card in place. A step that ends with nothing to show is folded into "Empty step" instead of sitting on "thinking" forever |
| Tool call display | Tool name in inline code + args (its own fenced block to avoid overflow) + result preview (terminal/web/search/read/diff), updated in place wathet→green/red |
| Media inlined from card text | When the model references workspace media, the card renders it **inline** (matching the DSH Web UI, where a workspace path can simply be opened — something Feishu cannot do): `![img](runs/a.png)` / `[img](runs/a.png)` is uploaded and shown as `img_v3_…`; `[clip](runs/a.mp4)` becomes a playable card **video element** (QuickTime is remuxed with `-c copy`, `ffmpeg` extracts a cover, `ffprobe` measures the duration); `[voice](runs/a.opus)` becomes an inline **`<audio>` player** (Opus only; wav/mp3/m4a/flac are transcoded when `ffmpeg` is available). Scope stays narrow: only Markdown references carrying a `()` destination, only files whose `realpath` is still inside the session workspace (`any` relaxes that), images ≤10 MB, audio/video ≤30 MB, at most 12 images and 12 audio/video items per card, every upload/ffmpeg run is bounded, uploads run three at a time, and they are **warmed** while the model is still typing. Anything that fails degrades to readable text — **a card is never rejected over media**. PDF / Office / archives have **no** card component at all and still travel as native file messages |
| Turn Complete card | After a turn: total / LLM / tool time, TTFT, throughput, tokens, cache hit rate, plus **Enter while busy** in the footer. Throughput matches the DSH Web UI's `deriveTurnMetrics` (first-token detection includes tool-call deltas; tokens and decode time are paired). Files the model declared through DSH's `present` tool lead the card (`📦 Deliverables`, path + description, followed by a divider before the metrics): **listed only, never pushed** — ask for one when you want it |
| Session panel | `/session`: an interactive card with a session dropdown plus switch / detach / archive / fork / rename / **pin / unpin** / list / refresh; pinned sessions carry a `📌` mark in the dropdown and in `/session list`; `/session N` switches by index |
| Background-job / subagent panels | **Fixed titles** (`🧩 Background jobs` / `🤖 Subagents`, never the command), and **one card listing every background job / every subagent of that chat**: columns are "state · task · id · duration · progress/result" and "state · subagent · **model** · session · mode · duration". The job panel carries a **`🧹 Clear finished`** button (WebUI parity: it only drops settled rows from the roster, the host registry keeps its records). **Nested subagents are drawn as a tree** (`├─ ` / `└─ ` with `│  ` bars) instead of space indentation, which Feishu collapses inside a table cell; a subagent's **model** comes from the child session's own `request/context`. **Send-only**: every roster change posts a **new** card (a snapshot of the current state) — no in-place updates and no grey "stale" cards. The gate is unchanged: **only jobs the model was actually handed a handle for** are listed (background bash / pwsh / `terminal_send`, background subagents, workflows), while a **foreground** bash call is a host job too but appears in neither the table nor a card (fixed 2026-09-23, key pitfall 37). Subagents come from the parent's `subagent/catalog` plus the Host's `subagent/start` / `subagent/end`; unbound sessions and out-of-process children (no local child session) are not listed. A card carries at most 8 rows, and settled rows leave the roster after 30 minutes (the posted cards stay) |
| Slash commands | `/model`, `/new`, `/session`, `/status`, `/stop`, `/steer`, `/queue`, `/busy`, `/permission`, `/reasoning`, `/display`, `/approve`, `/deny`, `/help` and more |
| Approvals | Shares the same pending approvals as the DSH Web UI; the card puts **Approve on top / Reject below** and shows the `Reason:` |
| `ask_user_question` card | Question cards with options, free-form input and a skip button; multiple questions are asked **one at a time** and returned as one batch |
| Image / file intake | Images are typed from their **real bytes** (PNG/JPEG/WebP/GIF) and stored via the attachment store; files — **and videos/voice notes the user sent** — are downloaded into the **native DSH attachment store** (`~/.dsh/attachments/v1/files/…`) and exposed to the agent as `fileHostPath` |
| Agent sends files | The `feishu_send_file` model tool pushes a workspace file into the current Feishu chat (≤30 MB). **Images preview inline**, **MP4/MOV (H.264/HEVC/MPEG-4) is sent as a playable video bubble** (with an ffmpeg-extracted cover when ffmpeg is available), and **Ogg/Opus as a voice bubble**; everything else — including a container/codec Feishu cannot play — stays a file |
| Agent receives files | The `feishu_receive_file` model tool downloads an inbound Feishu file (video and voice included) into the **native DSH attachment store** on demand and returns its `fileHostPath` |
| Steer while running | `/steer <text>` injects one message into the current turn; `/busy steer` makes "send while running" mean inject by default (persisted); when the agent is idle, `/steer` and `/queue` fall back to a normal new message. A plain message sent while running gets a **plain-text notice first** (injected / queued), and the injected message **does not get its own reply card** — the running turn's reply answers it |
| Queue while running (`/queue`) | `/queue <text>` forces the queue path (even in steer mode) and runs as a new turn; falls back to a normal message when idle |
| Permission mode | `/permission` views/switches the session permission (sandbox) mode with an **interactive card**; names match the Web UI (Read Only / Workspace Write / Full access) |
| Errors explain themselves | Failures come back with the concrete cause and error code (`errorText`) instead of a generic apology |
| WebSocket connection | No public server required; works with both Feishu (China) and Lark (international) |
| Access control | Group allowlist, DM allowlist, mention requirement |

---

## 安装 / Installation

```sh
npx @deepseek-ai/dsh plugin --profile web add @starxer/chatterbox4dsh
```

> **要求 DSH `0.1.5-alpha.1` 或更高（同一 `0.1.5` 预发布线）**。DSH 仍处于 pre-release，预发布版本之间 API 可能变动；插件的 `@deepseek-ai/dsh-*` 依赖范围会随 DSH 预发布版本同步升级，升级 DSH 后请一并升级本插件。
>
> **Requires DSH `0.1.5-alpha.1` or newer on the same `0.1.5` prerelease line.** DSH is still pre-release and its API may change between prereleases; the plugin bumps its `@deepseek-ai/dsh-*` ranges in lockstep, so upgrade both together.

**中文**：插件提供两个页面——**配置**（App ID / App Secret / 访问策略 / 卡片显示）在 DSH **Settings** → 飞书与 Lark；**连接状态与扫码一键配置**在 **Plugins** → 飞书与 Lark 详情页。扫码是推荐路径，也可以手动创建应用。详见 [docs/feishu-setup.md](docs/feishu-setup.md)。

**English**: The plugin adds two pages — **configuration** (App ID / App Secret / access policy / card display) lives in DSH **Settings** → Feishu & Lark, while **connection status and the QR-code one-click setup** live on the **Plugins** → Feishu & Lark detail page. Scanning is the recommended path; you can also create the app manually. See [docs/feishu-setup.md](docs/feishu-setup.md).

## 快速开始 / Quick start

**中文**

1. 安装插件（上方命令）
2. 启动 DSH：`npx @deepseek-ai/dsh web`
3. 在 **Plugins** → 飞书与 Lark 详情页点「扫码配置」完成授权（二维码显示在该页的「连接与扫码」区块）
4. 在飞书中找到机器人，发送消息即可
5. 之后在 **Settings** → 飞书与 Lark 调整访问策略与卡片显示

> 手动创建的应用：把 App ID / App Secret 填到 **Settings** → 飞书与 Lark（该页只管配置；连接状态与扫码已移到 Plugins 详情页）。

**English**

1. Install the plugin (command above)
2. Start DSH: `npx @deepseek-ai/dsh web`
3. On the **Plugins** → Feishu & Lark detail page, click **Scan to configure** and authorize (the QR code appears in that page's connection section)
4. Find the bot in Feishu and send it a message
5. Afterwards, adjust the access policy and card display in **Settings** → Feishu & Lark

> For a manually created app, put the App ID / App Secret in **Settings** → Feishu & Lark. That page is configuration only; connection status and scanning live on the Plugins detail page.

---

## 斜杠命令 / Slash commands

**中文**

| 命令 | 说明 |
|---|---|
| `/model [list\|<provider>/<model>]` | 查看/列出/切换模型 |
| `/new [--workspace <path>] [--preset <id>]` | 新建会话（可指定工作区和 preset） |
| `/session [N\|list]` | 无参：交互式会话管理面板；`list`：表格；`N`：按下标快速切换 |
| `/status` | 展示会话状态（token/TTFT/吞吐量/缓存命中率/权限模式/Enter while busy 等） |
| `/reasoning [off\|low\|high\|max]` | 设置推理强度（`show on\|off` 切换思考过程显示） |
| `/display [reasoning\|tools\|args\|results] [on\|off]` | 查看/切换卡片显示开关（思考过程 / 工具调用 / 参数 / 结果）。**无参时发交互卡片**，点按钮即可切换 |
| `/stop` | 中止当前轮次并丢弃排队消息（不再进入下一 turn） |
| `/steer <内容>` | agent 运行中，把一条消息注入当前 turn；**空闲时自动回退为发新消息** |
| `/queue <内容>` | /steer 的共轭：强制把消息排队为新轮（即使处于 steer 模式）；空闲时回退为发新消息 |
| `/busy [queue\|steer]` | 设置运行中（busy）的 Enter 行为：排队发送（默认）或插话发送，**持久化** |
| `/permission [模式]` | 查看/切换会话权限（沙箱）模式；无参发交互式选择卡片 |
| `/approve` `/deny` `/approvals` | 处理工具审批 |
| `/help` | 卡片列出所有可用命令（分组：chatterbox4dsh 插件 / DSH 内置） |

**English**

| Command | Description |
|---|---|
| `/model [list\|<provider>/<model>]` | View / list / switch models |
| `/new [--workspace <path>] [--preset <id>]` | Create a session (optionally with a workspace and preset) |
| `/session [N\|list]` | No args: interactive session panel; `list`: table; `N`: switch by index |
| `/status` | Session status (tokens / TTFT / throughput / cache hit rate / permission mode / Enter while busy) |
| `/reasoning [off\|low\|high\|max]` | Set the reasoning effort (`show on\|off` toggles reasoning display) |
| `/display [reasoning\|tools\|args\|results] [on\|off]` | View / toggle the card display switches (reasoning / tool calls / arguments / results). With no argument it posts an **interactive card** — just tap a switch |
| `/stop` | Abort the current turn and drop queued messages (they no longer run as the next turn) |
| `/steer <text>` | While the agent runs, inject a message into the current turn; **falls back to a new message when idle** |
| `/queue <text>` | The counterpart of `/steer`: force the message to queue as a new turn (even in steer mode); falls back to a new message when idle |
| `/busy [queue\|steer]` | Set what Enter does while busy: queue (default) or steer, **persisted** |
| `/permission [mode]` | View / switch the session permission (sandbox) mode; no args sends an interactive card |
| `/approve` `/deny` `/approvals` | Handle tool approvals |
| `/help` | A card listing every command (grouped: chatterbox4dsh plugin / DSH built-in) |

> **关于会话压缩 / On compaction**：`compact` 命令由 **DSH 内置**提供（`@deepseek-ai/dsh-command-compact`，注册 `/compact` 并调用官方压缩），本插件**不注册** `compact` 命令（避免与 DSH 内置同名冲突）。当某个会话历史过大时，用 DSH 内置的 `/compact` 压缩其上下文，或将会话归档/另开新会话。DSH 压缩只改写「进入模型上下文的部分」，会话的完整事件日志不会被删除。
>
> The `compact` command is provided by **DSH itself** (`@deepseek-ai/dsh-command-compact`, registered as `/compact`). This plugin deliberately **does not** register `compact` (a same-name conflict with the built-in would fail at boot). When a session's history grows too large, use the built-in `/compact` to compact its context, or archive the session / start a new one. DSH compaction only rewrites the part that enters the model context; the full event log is never deleted.

> **运行中发消息的行为（`/busy`）**：`queue`（排队发送，等待当前轮结束后作为新轮运行）或 `steer`（插话发送，注入当前轮立即响应，persist）。`/status` 的 **Enter while busy** 行显示当前值。一次性插话用 `/steer <内容>`；一次性排队用 `/queue <内容>`。**agent 空闲时**，`/steer`、`/queue` 都会自动回退为「作为新消息发送」而不是报错。运行中发普通消息时会**立即回一条纯文本提示**（steer：已插入当前轮；queue：已排队，本轮结束后执行）——提示是文本消息而非卡片；steer 注入的消息由当前轮的回复卡统一回答，**不会再单独回一张卡**。`/stop` 会中止当前轮并**丢弃排队/等待中的消息**（不再自动进入下一 turn）。
>
> **What happens when you send while running (`/busy`)**: `queue` (wait for the current turn, then run as a new turn) or `steer` (inject into the current turn and respond immediately, persisted). The **Enter while busy** row in `/status` shows the current value. Use `/steer <text>` for a one-off injection and `/queue <text>` for a one-off queue. When the agent is **idle**, both fall back to "send as a new message" instead of erroring. A plain message sent while running gets an **immediate plain-text notice** (steer: injected into the current turn; queue: queued for after this turn) — a text message, not a card; the injected message is answered by the running turn's reply card and **never gets a second card**. `/stop` aborts the current turn and **drops queued/waiting messages** (they no longer run as the next turn).

---

## 配置 / Configuration

```yaml
- id: lark-channel
  config:
    appId: cli_xxxxxxxxxxxxxxxx
    appSecretRef: DSH_LARK_APP_SECRET
    domain: feishu              # feishu（中国版）/ lark（国际版） · feishu (China) / lark (international)
    requireMention: true         # 群聊是否必须 @机器人 · require an @mention in groups
    dmMode: open                 # open / allowlist / disabled
    workspace: /path/to/project  # 默认工作区 · default workspace
    agentPreset: coding          # 默认 agent preset · default agent preset
    showReasoning: true          # 卡片显示：思考过程 · card display: reasoning
    showToolCalls: true          # 卡片显示：工具调用 · card display: tool calls
    showToolArgs: true           # 卡片显示：工具参数 · card display: tool args
    showToolResults: true        # 卡片显示：工具结果 · card display: tool results
    locale: auto                 # auto / zh / en
    cardImages: workspace        # text / workspace / any —— 正文媒体（图片/视频/音频）怎么处理 · how card-text media is handled
    cardMediaLimit: 12           # 1–30 —— 单卡最多内联几个媒体 · most media one card may inline
    cardImageMaxMb: 10           # 1–10 —— 图片内联大小上限 · largest image to inline
    cardVideoMaxMb: 15           # 1–30 —— 视频内联大小上限 · largest video to inline
    cardAudioMaxMb: 15           # 1–30 —— 音频内联大小上限 · largest audio to inline
```

**中文**

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `appId` | — | 飞书应用 App ID |
| `appSecretRef` | `DSH_LARK_APP_SECRET` | Harness Credentials 中的 Secret 引用名 |
| `domain` | `feishu` | `feishu` 或 `lark` |
| `requireMention` | `true` | 群聊是否必须 @机器人 |
| `dmMode` | `open` | 单聊策略：`open` / `allowlist` / `disabled` |
| `groupAllowlist` | `[]` | 允许的群 chat_id 列表 |
| `dmAllowlist` | `[]` | allowlist 模式下的用户 open_id 列表 |
| `provider` / `model` | Harness 默认 | 为飞书渠道指定模型 |
| `workspace` | 第一个注册的 Workspace | Agent 工作目录 |
| `agentPreset` | Harness 默认 Preset | Agent preset |
| `reactEmoji` | `THUMBSUP` | 收到消息时的表情回应（空字符串关闭） |
| `showReasoning` | `true` | 步骤卡是否展示模型思考过程（200 字预览） |
| `showToolCalls` | `true` | 是否展示工具调用；关闭后只有工具的步骤不再发卡 |
| `showToolArgs` | `true` | 是否展示工具调用的参数块（需 `showToolCalls`） |
| `showToolResults` | `true` | 是否展示工具结果预览（需 `showToolCalls`） |
| `locale` | `auto` | 插件语言：`auto`（跟随 Harness）/ `zh` / `en` |
| `cardImages` | `workspace` | 正文里的**媒体**（图片 / 视频 / 音频）怎么处理：`text` 永不上传（只留路径文字）/ `workspace` 只上传会话工作区内、`realpath` 后仍在区内的媒体并内联显示 / `any` 工作区外的可读媒体路径也上传。键名保留 `cardImages`（改名会丢已保存的值），含义已扩到全部媒体。无论哪档，卡片都不会因媒体语法被飞书拒收 |
| `cardMediaLimit` | `12` | 一张卡里最多内联几个媒体：**图片**算一处、**视频与音频**合起来算一处（各按这个数），1–30。超出的引用退回可读路径文字。飞书本身的边界高得多（一卡 200 个元素/组件，带封面的视频一个占 3 个名额 ⇒ 约 66 个），这个数字只是为了让消息别太长 |
| `cardImageMaxMb` | `10` | **图片**自动内联的大小上限（MB），范围 1–10。超过就只留路径文字。上限 10 是飞书的硬边界（`im.v1.image.create` 拒收 >10MB），所以默认就给到顶 |
| `cardVideoMaxMb` | `15` | **视频**自动内联的大小上限（MB），范围 1–30（飞书文件接口硬上限 30MB）。数字越大，卡片等上传的时间越长 |
| `cardAudioMaxMb` | `15` | **音频**自动内联的大小上限（MB），范围 1–30。非 Opus 的音频还要先转码，另受 ffmpeg 是否可用影响 |

**English**

| Option | Default | Description |
|---|---|---|
| `appId` | — | Feishu app ID |
| `appSecretRef` | `DSH_LARK_APP_SECRET` | Name of the Secret reference in Harness Credentials |
| `domain` | `feishu` | `feishu` or `lark` |
| `requireMention` | `true` | Whether groups must @mention the bot |
| `dmMode` | `open` | DM policy: `open` / `allowlist` / `disabled` |
| `groupAllowlist` | `[]` | Allowed group `chat_id`s |
| `dmAllowlist` | `[]` | Allowed user `open_id`s in allowlist mode |
| `provider` / `model` | Harness default | Pin a model for the Feishu channel |
| `workspace` | First registered workspace | Agent working directory |
| `agentPreset` | Harness default preset | Agent preset |
| `reactEmoji` | `THUMBSUP` | Reaction added on incoming messages (empty string disables it) |
| `showReasoning` | `true` | Show the model reasoning preview on step cards (200-char window) |
| `showToolCalls` | `true` | Show tool calls; when off, tool-only steps post no card |
| `showToolArgs` | `true` | Show each tool call's argument block (requires `showToolCalls`) |
| `showToolResults` | `true` | Show each tool call's result preview (requires `showToolCalls`) |
| `locale` | `auto` | Plugin language: `auto` (follow Harness) / `zh` / `en` |
| `cardImages` | `workspace` | How **media** (image / video / audio) referenced in card text is handled: `text` never uploads (the path stays text) / `workspace` uploads and inlines media inside the session workspace only / `any` also uploads readable media paths outside it. The key keeps its historical name so saved values survive; it now covers every media kind. Whichever mode is set, a card is never rejected over media syntax |
| `cardMediaLimit` | `12` | How many media one card may inline, counted per group — **images** on the one hand, **video and audio** together on the other, each using this number, 1-30. References past it stay readable paths. Feishu's own ceiling is far higher (200 elements/components per card; a video with a cover spends three, so about 66 videos); this number only keeps a message readable |
| `cardImageMaxMb` | `10` | Largest **image** (MB) to inline automatically, 1-10. Anything bigger keeps its path as text. The 10 is Feishu's own ceiling (`im.v1.image.create` refuses more), which is why the default is at the top of the range |
| `cardVideoMaxMb` | `15` | Largest **video** (MB) to inline automatically, 1-30 (Feishu's file API caps at 30 MB). A bigger number only costs wait: the upload runs on the card-write path |
| `cardAudioMaxMb` | `15` | Largest **audio** (MB) to inline automatically, 1-30. Non-Opus audio is transcoded first, so ffmpeg has to be available |

---

## 架构 / Architecture

```
飞书用户 / Feishu user
  → Lark SDK (WebSocket)
  → chatterbox4dsh
  → Harness Agent
  → 回复卡片 / reply cards
```

**中文**：插件运行在 DSH Host 内部，不启动额外进程，不暴露 HTTP 端点。每个飞书聊天映射一个 DSH Session，Agent 在 turn 完成后复用。详见 [docs/architecture.md](docs/architecture.md)。

**English**: The plugin runs inside the DSH host, starts no extra process and exposes no HTTP endpoint. Each Feishu chat maps to one DSH Session, reused across turns. See [docs/architecture.md](docs/architecture.md).

---

## 开发 / Development

```sh
npm install
npm run test
npm run build
```

**中文**：修改源码后需要 `npm run build` 并重启 DSH 进程（如 `systemctl --user restart dsh`，具体取决于部署方式）。注意重启会中断正在运行的会话/turn，建议在空闲时执行。

**English**: After changing the source, run `npm run build` and restart the DSH process (e.g. `systemctl --user restart dsh`, depending on your deployment). Note that a restart interrupts running sessions/turns — do it while idle.

## 已知问题 / Known issues

**中文**

- **步骤卡标题色带在部分飞书客户端不显示**：插件发出的卡片 JSON 里 `header.template` 始终存在且正确（服务端卡片实体为 green/wathet/red），但某些飞书客户端在卡片被更新后不重绘标题背景，表现为白底。属飞书客户端渲染问题（同一条消息在不同设备上表现不同），不是插件 bug；切换会话或重启客户端通常可恢复。
- **审批卡片结算后的颜色变化**：结算卡走 `im.v1.message.patch`，标题颜色变化在部分客户端同样可能不重绘（同上）。

**English**

- **Step-card title color missing on some Feishu clients**: the card JSON this plugin sends always carries a correct `header.template` (the server-side card entity is green/wathet/red), but some Feishu clients fail to repaint the header background after a card update, showing it as white. This is a Feishu client rendering issue (the same message looks different across devices), not a plugin bug; switching chats or restarting the client usually restores it.
- **Approval card color after settling**: the settled card is updated via `im.v1.message.patch`, and the title color change may likewise not repaint on some clients (same cause as above).

## 上游来源 / Upstream

**中文**：基于 [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark)（`ee639df`）fork，**已独立维护**，不再跟踪上游同步。本仓库的改动记录见 [CHANGELOG.md](./CHANGELOG.md)。

**English**: Forked from [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark) (`ee639df`) and **maintained independently** — upstream is no longer tracked. See [CHANGELOG.md](./CHANGELOG.md) for this repository's changes.

## License

MIT — Copyright (c) 2026 sugarforever (upstream), modified work by Starxer.
