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
| 统一 per-step 卡片 | 每个 agent step 一张卡片，包含推理、文本、工具调用、结果预览；标题带「第 N 轮 · 第 M 步」，reasoning 标题带思考耗时与思考 token，footer 两行（`⏱ 时长 · 📥 本步新输入 → 📤 输出` / `🚀 tok/s · 📊 上下文占用/窗口`）。**📥 只算本步真正处理的输入**（未缓存 + 缓存写入，命中读取不算），有命中时附带 `♻️ NN%`；上下文总量只出现在 📊 一处，避免与 📥 重复。快步骤（思考→工具调用→结果落在 150ms 内）只发**一张**卡 |
| 工具调用展示 | 工具名内联代码 + args（独立 fenced 代码块防溢出）+ 结果预览（terminal/web/search/read/diff），原地更新 wathet→green/red |
| Turn Complete 卡片 | turn 结束后展示总时长/LLM 时间/工具时间、TTFT/吞吐量、token/缓存命中率，footer 另显示 **Enter while busy**；吞吐量口径与 DSH Web UI `deriveTurnMetrics` 对齐（首 token 判定含 tool-call delta，token 与 decode 时间同批配对）。模型用 DSH `present` 工具声明的**交付物**列在**卡片最前面**（`📦 交付物`，路径 + 描述，之后用分隔线接指标）：**只列清单、不推送文件**，需要时让模型发即可 |
| 会话管理面板 | `/session`：交互式卡片下拉选会话 + 切换/detach/归档/fork/改名/列表/刷新；`/session list` 表格卡；`/session N` 快速切换 |
| 斜杠命令 | `/model` `/new` `/session` `/status` `/stop` `/steer` `/queue` `/busy` `/permission` `/reasoning` `/display` `/approve` `/deny` `/help` 等 |
| 审批 | 与 DSH Web UI 共享同一份 pending 审批状态；审批卡片 **Approve 在上 / Reject 在下**，并显示 `Reason:` 原因 |
| `ask_user_question` 卡片 | 问题卡片（选项/自定义输入/跳过），一次多问时**顺序迭代**、整批返回答案 |
| 图片 / 文件接收 | 图片按**真实字节判型**（PNG/JPEG/WebP/GIF）经 attachment store 落盘；文件下载到 **DSH 原生附件库**（`~/.dsh/attachments/v1/files/…`）并附 `fileHostPath` 给 agent 读取 |
| agent 主动发文件 | `feishu_send_file` 模型工具：agent 可把工作区文件推送到当前飞书聊天（≤30MB） |
| agent 接收文件 | `feishu_receive_file` 模型工具：agent 按需/兜底直接下载入站飞书文件到 **DSH 原生附件库**，返回 `fileHostPath` |
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
| Unified per-step card | One card per agent step with reasoning, text, tool calls and result previews; the title carries "turn N · step M", the reasoning header shows thinking time and thinking tokens, and the footer is two lines (`⏱ duration · 📥 in → 📤 out` / `🚀 tok/s · 📊 context`). A fast step (thinking → tool call → result inside 150 ms) sends only **one** card |
| Tool call display | Tool name in inline code + args (its own fenced block to avoid overflow) + result preview (terminal/web/search/read/diff), updated in place wathet→green/red |
| Turn Complete card | After a turn: total / LLM / tool time, TTFT, throughput, tokens, cache hit rate, plus **Enter while busy** in the footer. Throughput matches the DSH Web UI's `deriveTurnMetrics` (first-token detection includes tool-call deltas; tokens and decode time are paired). Files the model declared through DSH's `present` tool are listed here too (`📦 Deliverables`, path + description): **listed only, never pushed** — ask for one when you want it |
| Session panel | `/session`: an interactive card with a session dropdown plus switch / detach / archive / fork / rename / list / refresh; `/session list` renders a table card; `/session N` switches by index |
| Slash commands | `/model`, `/new`, `/session`, `/status`, `/stop`, `/steer`, `/queue`, `/busy`, `/permission`, `/reasoning`, `/display`, `/approve`, `/deny`, `/help` and more |
| Approvals | Shares the same pending approvals as the DSH Web UI; the card puts **Approve on top / Reject below** and shows the `Reason:` |
| `ask_user_question` card | Question cards with options, free-form input and a skip button; multiple questions are asked **one at a time** and returned as one batch |
| Image / file intake | Images are typed from their **real bytes** (PNG/JPEG/WebP/GIF) and stored via the attachment store; files are downloaded into the **native DSH attachment store** (`~/.dsh/attachments/v1/files/…`) and exposed to the agent as `fileHostPath` |
| Agent sends files | The `feishu_send_file` model tool pushes a workspace file into the current Feishu chat (≤30 MB) |
| Agent receives files | The `feishu_receive_file` model tool downloads an inbound Feishu file into the **native DSH attachment store** on demand and returns its `fileHostPath` |
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

**中文**：然后在 DSH **Settings** → 飞书与 Lark 中配置 App ID 和 App Secret。支持扫码一键配置（推荐）或手动创建应用。详见 [docs/feishu-setup.md](docs/feishu-setup.md)。

**English**: Then configure the App ID and App Secret in DSH **Settings** → Feishu & Lark. You can use the QR-code one-click setup (recommended) or create the app manually. See [docs/feishu-setup.md](docs/feishu-setup.md).

## 快速开始 / Quick start

**中文**

1. 安装插件（上方命令）
2. 启动 DSH：`npx @deepseek-ai/dsh web`
3. 在 Settings → 飞书与 Lark 中配置应用凭据
4. 在飞书中找到机器人，发送消息即可

**English**

1. Install the plugin (command above)
2. Start DSH: `npx @deepseek-ai/dsh web`
3. Configure the app credentials in Settings → Feishu & Lark
4. Find the bot in Feishu and send it a message

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
