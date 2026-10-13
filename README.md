# chatterbox4dsh

**中文** ｜ **English**

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生能力接进飞书 / Lark 聊天，并把 agent 的过程讲给你看。
> A chatty Feishu / Lark channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

[文档导航 / Documentation](<./docs/README.md>) · [应用配置 / Setup](<./docs/feishu-setup.md>) · [媒体与隐私 / Privacy](<./docs/privacy.md>) · [架构 / Architecture](<./docs/architecture.md>) · [变更记录 / Changelog](<./CHANGELOG.md>)

## 简介 / Overview

**中文**：插件只做“DSH 原生特性 → 飞书聊天”的映射层，**DSH 才是 agent 本体**。飞书与 DSH Web UI 共享模型、工具、工作区、会话和审批服务；不是另一个 agent 平台，也不是 24 小时常驻助手。功能对齐优先于创新，卡片形态则适应聊天端的限制。

**English:** This plugin bridges **DSH's native capabilities into Feishu chat**; DSH itself is the agent. Feishu and the Web UI share models, tools, workspaces, sessions and approvals. It is not another agent platform or a 24/7 assistant. Feature parity comes first, with card interactions adapted to the chat surface.

> **文档基线 / Documentation baseline**：以下描述仓库主线，已在 DSH `0.2.0-rc.2` 验证，依赖范围保留 `^0.2.0-rc.1`。npm 上已发布的插件 `0.2.0` 早于这些改动，**不等于当前仓库主线**；新版本发布与安装彩排仍待完成，见 [待办](<https://github.com/Starxer/chatterbox4dsh/blob/main/TODO.md>) H4。不要用版本豁免强行加载不兼容的旧包。
>
> This page describes repository main, verified on DSH `0.2.0-rc.2` with ranges starting at `^0.2.0-rc.1`. The published plugin `0.2.0` predates these changes and **is not equivalent to main**. A new release and clean-profile installation rehearsal remain open (H4); do not bypass compatibility checks to force an old package to load.

## 安装与快速开始 / Installation & quick start

npm 安装入口如下；**先确认要安装的发布版本兼容你的 DSH**。仓库主线的要求不能用来推断旧 npm 包的要求。

The npm installation entry is below; **check the selected release's DSH compatibility first**. Main's requirements do not establish an older package's requirements.

```sh
npx @deepseek-ai/dsh plugin --profile web add @starxer/chatterbox4dsh
npx @deepseek-ai/dsh web
```

| 步骤 / Step | 中文 | English |
|---|---|---|
| 1 | 安装兼容版本并启动 DSH Web Profile | Install a compatible version and start the DSH Web profile |
| 2 | **Plugins → 飞书与 Lark** 详情页点“扫码配置”，用飞书授权 | On **Plugins → Feishu & Lark**, choose **Scan to configure** and authorize |
| 3 | 在飞书找到机器人发送消息；群聊默认需要 @机器人 | Message the bot in Feishu; groups require an @mention by default |
| 4 | 在 **Settings** → 飞书与 Lark 调整凭据、访问策略和展示 | Adjust credentials, access policy and display in **Settings** → Feishu & Lark |

手动建应用、权限与事件订阅见 [配置指南](<./docs/feishu-setup.md>)。**设置页管配置；插件详情页管连接状态与扫码。**

See the [setup guide](<./docs/feishu-setup.md>) for manual app creation, permissions and events. **Settings handles configuration; the plugin detail page handles connection status and scanning.**

## 功能 / Features

| 能力 / Capability | 中文 | English |
|---|---|---|
| 聊天与会话 / Conversations | 单聊、群聊按聊天复用 Session；话题群每个线程独立 Session，绑定跨重启保存 | One Session per DM/group; topic-group threads have independent Sessions, with bindings persisted |
| 过程透明 / Work details | 推理、文本、工具与结果按档位展示；步骤卡附耗时、token、速度和上下文；思考 token 无上游数据时不估算 | Reasoning, text, calls and results follow the detail level; cards carry time, tokens, speed and context; no invented thinking-token counts |
| 实时相位 / Live phases | 区分“正在分析请求 → 等待输出 → 思考中 → 回复中”，工具调用另示状态；**不逐 token 更新正文** | Distinguishes preparing, awaiting output, thinking and replying, plus tool states; **not token-by-token text streaming** |
| 上下文与压缩 / Context & compaction | 注入只显示来源提示、不贴注入正文；压缩卡就地更新，摘要折叠，正文预算 22,000 UTF-8 字节，超出会注明 | Injection notices show the source, not the payload; compaction updates one card, with a folded summary capped at 22,000 UTF-8 bytes and an explicit truncation notice |
| 会话管理 / Session management | 切换、断开绑定、归档、分叉、改名、置顶；新会话可选工作区、预设与模型 | Switch, detach, archive, fork, rename and pin; new sessions select workspace, preset and model |
| 新建工作区 / Workspace creation | 不存在的手输路径先确认、最终创建会话时才建目录并注册；浏览器“新建文件夹”是独立的立即操作 | A missing typed path is confirmed, then created/registered at final session creation; the browser's **New folder** is a separate immediate action |
| 后台任务与子代理 / Jobs & subagents | 每类一张名册快照，名册变更发新卡、不就地更新；只列真正后台任务；子代理显示模型和树形关系，支持 `/subagents tree` | Send-only roster snapshots, not one card per job; foreground tool jobs are excluded; subagents show model and nesting, with `/subagents tree` |
| 审批 / Approvals | 与 Web UI 共享 pending 状态，两端都显示，谁先处理谁生效；中止后卡片作废 | Shared pending state on both surfaces; the first answer wins and aborted requests retire their cards |
| 问答 / Questions | 单选整行点选即记录，回执可返回重答；全部答完后最终确认才提交。多选每选项一个复选框，一次提交 | Single-select records on tap, with undo receipts; only final batch confirmation submits to the model. Multi-select uses one checkbox per option and one submit |
| 媒体与文件 / Media & files | 接收入站图片、文件、视频与语音到 DSH 附件库；支持卡内图片/视频/音频与 `feishu_send_file` 主动发原件 | Intake uses DSH's attachment store; card media is inlined and `feishu_send_file` can send original files |
| 回合交付 / Deliverables | `present` 媒体内联、白名单文档自动发、其他文件点确认后发；未声明的产出默认只投媒体和白名单文档 | `present` inlines media, auto-sends allowlisted documents and confirms other files; unpresented output is filtered to media and allowlisted documents |
| 外部回合 / External turns | 绑定会话从 Web GUI 或自动化启动的回合也回显、收尾、交付，来源具名；`mirrorExternalTurns` 默认开 | Web/automation turns in bound sessions are echoed, completed and delivered with a named origin; enabled by default |
| 连接与访问 / Connection & access | WebSocket 长连接，无需公网 webhook；支持飞书 / Lark、单聊策略、群白名单与 @要求 | WebSocket transport needs no public webhook; Feishu/Lark, DM policies, group allowlists and mention requirements |

### 工作展示档位 / Work-detail levels

| 档位 / Level | 中文 | English |
|---|---|---|
| `compact` | 答案卡 + 按需创建的回合过程卡；中间叙述、注入和工具行合并到过程里，纯工具步骤不发步骤卡 | Answer cards plus a lazy turn-progress card; narration, notices and tools are process rows, with no tool-only step card |
| `standard` | 每个可见步骤一张卡；推理首行预览、工具一行摘要，无参数或结果块 | Visible steps get cards; one-line reasoning and tool summaries, no args/results blocks |
| `detailed`（默认 / default） | 推理折叠，预览 200 字；工具参数最多 2,000 字符、结果预览最多 1,500 字符 | Folded reasoning, 200-character preview; args up to 2,000 characters, result previews up to 1,500 |
| `verbose` | 推理面板保留全文，工具参数/结果上限各 6,000 字符；**不是无限长度**，推理仍默认折叠 | Full reasoning inside a folded panel; args/results capped at 6,000 each; **not unlimited**, reasoning still starts collapsed |

四个 `show*` 开关与档位 **AND 合成，只减不加**。所有飞书会话共用本插件的展示配置；它与 Web UI 使用同名档位，**但不是 Web 聊天的同一份设置**。

The four `show*` switches are **ANDed with the level and only subtract**. Feishu sessions share this plugin's display config; the levels have Web UI names but **do not change the Web chat's separate setting**.

`compact` 过程卡运行标题为“深度求索中 · 耗时”（`DeepSeeking · elapsed`）。最多显示最新 **5 步 / 40 行**，更早内容最多 **60 行**折叠；每步标题在引用框外，可见与折叠区共用按步分组。运行步骤带等待/思考/回复/工具状态灯；运行时钟每 30 秒刷新。别的卡片插入后，下一件实际活动另开分段，避免新内容更新到更早位置。详见 [架构](<./docs/architecture.md>)。

The running title is `DeepSeeking · elapsed`. Progress keeps up to **five steps / 40 visible rows**, plus **60 folded rows**; headings stay outside per-step quote frames in both areas. A live phase light and 30-second clock track activity. Interleaved cards close a segment; the next real activity opens another. See [architecture](<./docs/architecture.md>).

## 斜杠命令 / Slash commands

| 命令 / Command | 中文 | English |
|---|---|---|
| `/model [list\|<provider>/<model>]` | 查看、列出、切换模型；无参打开向导 | View/list/switch models; no args opens the picker |
| `/new [--workspace <path>] [--preset <id>]` | 新会话；无参走卡片流程，带参数路径需已注册工作区 | New session; card flow without args, registered workspace required for the text path |
| `/session [N\|list]` | 会话管理面板、列表或按编号切换 | Session panel, list or switch by index |
| `/status` | 会话与性能指标、权限、运行中发送模式 | Session metrics, permissions and busy-message mode |
| `/reasoning [档位 / effort]` | 支持的推理强度随模型而变；`show on\|off` 控制思考显示 | Supported efforts depend on the model; `show on\|off` controls display |
| `/display [compact\|standard\|detailed\|verbose]` | 切档；无参发控制卡 | Switch level; no args opens controls |
| `/display [reasoning\|tools\|args\|results] [on\|off]` | 切四个显示开关 | Toggle the four display switches |
| `/stop` | 中止本轮并丢弃排队消息 | Abort the turn and drop queued messages |
| `/steer <text>` | 插入当前轮；空闲时作为新消息 | Inject into the current turn; new message if idle |
| `/queue <text>` | 强制排队到下一轮；空闲时作为新消息 | Force next-turn queueing; new message if idle |
| `/busy [queue\|steer]` | 运行中普通消息的行为，持久化 | Persist what ordinary messages do while busy |
| `/permission [mode]` | 查看/切换会话权限，无参发选择卡 | View/switch permissions; no args opens a card |
| `/subagents [tree]` | 子代理名册；`tree` 列完整子树 | Subagent roster; `tree` lists descendants |
| `/approve` `/deny` `/approvals` | 处理/查看审批 | Handle/view approvals |
| `/lang [zh\|en\|auto]` | 插件语言 | Plugin language |
| `/help` | 插件与宿主提供的可用命令 | Available plugin and host commands |

`/compact` 由 **DSH 内置插件**提供，本插件不重复注册。自动与手动压缩都展示压缩卡；压缩只改变模型上下文视图，**不删除完整事件日志**。命令可用性取决于宿主实际挂载的插件。

`/compact` belongs to **DSH's built-in plugin**, not this bridge. Automatic/manual compaction produces a card and changes the model's context view, **not the complete event log**. Host command availability depends on mounted plugins.

## 配置 / Configuration

下面是 Profile Patch 的配置行示例，凭据只使用引用，不把值写进文档或补丁。

Example configuration entry for a profile patch; credentials use references, never literal values in documentation or patches.

```yaml
- id: lark-channel
  config:
    appId: cli_xxxxxxxxxxxxxxxx
    appSecretRef: DSH_LARK_APP_SECRET
    domain: feishu
    requireMention: true
    dmMode: open
    transcriptView: detailed
    cardImages: workspace
    produceCard: delivery
```

| 配置项 / Option | 默认 / Default | 中文 | English |
|---|---|---|---|
| `appId` | — | 应用 ID | Application ID |
| `appSecretRef` | `DSH_LARK_APP_SECRET` | Harness 凭据引用名 | Harness credential reference |
| `domain` | `feishu` | `feishu` / `lark` | Feishu / Lark platform |
| `requireMention` | `true` | 群消息需要 @机器人 | Require group @mentions |
| `dmMode` | `open` | `open` / `allowlist` / `disabled` | DM access policy |
| `groupAllowlist` | `[]` | 群 `chat_id` 白名单 | Group `chat_id` allowlist |
| `dmAllowlist` | `[]` | 用户 `open_id` 白名单 | User `open_id` allowlist |
| `provider` / `model` | Harness 默认 / default | 新会话的模型默认值；恢复会话优先读自己的记录 | New-session defaults; resumed sessions prefer their recorded route |
| `workspace` | 首个注册工作区 / first registered | 默认工作区 | Default workspace |
| `agentPreset` | Harness 默认 / default | 新会话预设；恢复优先会话记录 | New-session preset; resume prefers recorded preset |
| `reactEmoji` | `THUMBSUP` | 入站表情回应，空字符串关闭 | Inbound reaction; empty string disables it |
| `transcriptView` | `detailed` | 上方四档展示 | Four detail levels above |
| `showReasoning` | `true` | 显示推理，受档位约束 | Reasoning, within the selected level |
| `showToolCalls` | `true` | 显示工具；关闭也不发简洁过程卡 | Tools; disabling also suppresses compact progress |
| `showToolArgs` | `true` | 参数块，需工具开启且档位允许 | Args, when tools and level allow |
| `showToolResults` | `true` | 结果预览，需工具开启且档位允许 | Result previews, when tools and level allow |
| `locale` | `auto` | `auto` 跟随 Harness，或 `zh` / `en` | Follow Harness or force `zh` / `en` |
| `cardImages` | `workspace` | `text` 不自动上传 / `workspace` 只传区内 / `any` 允许区外媒体 | `text`: no automatic uploads; `workspace`: workspace-only; `any`: outside paths allowed |
| `cardMediaLimit` | `12` | 1–30；图片一组、音视频合为一组，各按此数 | 1–30, separately for images and combined audio/video |
| `cardImageMaxMb` | `10` | 1–10 MB，卡片图片内联上限 | 1–10 MB, card image limit |
| `cardVideoMaxMb` | `15` | 1–30 MB，卡片视频内联上限 | 1–30 MB, card video limit |
| `cardAudioMaxMb` | `15` | 1–30 MB，卡片音频内联上限 | 1–30 MB, card audio limit |
| `deliverDocMaxMb` | `30` | 1–30 MB，文档自动发文件上限，每轮最多 8 个 | 1–30 MB, automatic document limit; up to 8 per turn |
| `produceCard` | `delivery` | `off` 静默 / `summary` 计数 / `delivery` 另投媒体与白名单文档 | Ignore / count / additionally deliver filtered media and documents |
| `surfaceContext` | `true` | 对绑定飞书的会话说明通道交互边界 | Explain the surface to Feishu-bound sessions |
| `mirrorExternalTurns` | `true` | 镜像 Web GUI / 自动化等外部回合 | Mirror Web/automation turns |

`appSecret` 是遗留兼容字段，新配置请使用 `appSecretRef`。连接相关字段（凭据、平台、访问策略、`reactEmoji`）变化会重建通道，可能中断活动回合；显示、语言与新会话默认值热生效，不会因保存而重建通道。

`appSecret` is a legacy field; use `appSecretRef` for new configurations. Credentials, platform, access policy and `reactEmoji` changes rebuild the channel and may interrupt activity; display, locale and new-session defaults do not rebuild it.

## 媒体与隐私 / Media & privacy

**上传飞书就是把字节交给飞书，收到的图片还可能交给选定的视觉模型供应商。** `img_v3_…` / `file_v3_…` 是资源标识，不是公开网页链接，也不是端到端加密保证。不要把“没有公网 URL”理解成“只有我自己能看”。

**Uploading sends bytes to Feishu; incoming images may also be sent to the selected vision-model provider.** Resource keys are not public URLs or an end-to-end encryption guarantee. “No public URL” does not mean “only I can see it”.

默认媒体内联与 `present` 投递有工作区围栏，**显式 `feishu_send_file` 当前没有相同的工作区包含校验**。`cardImages: text` 只关闭卡片媒体自动上传，不关闭主动发送和文档交付。群内成员与截图/转发同样是暴露边界。详细数据流、API 取证范围与保守设置见 [媒体与隐私](<./docs/privacy.md>)。

Automatic card media and `present` delivery enforce workspace containment; **explicit `feishu_send_file` currently does not apply that same containment check**. `cardImages: text` disables automatic card-media uploads, not explicit sends or document delivery. Chat membership, screenshots and forwarding remain exposure paths. See [media & privacy](<./docs/privacy.md>).

## 平台支持 / Platform support

- 插件是纯 JavaScript；完整链路**只在 Linux x64 验证**，macOS / Windows 未验证。DSH 的平台覆盖不等于本插件已做跨平台验收。
- `ffmpeg` / `ffprobe` 是可选外部依赖：视频封面、转封装与非 Opus 音频转码需要它们；缺失时相应增强退回文字或文件，不影响基本聊天。
- Windows 的媒体路径围栏可能因大小写/短名差异把区内媒体判为区外；这是已知的安全方向退化，不是跨平台验证结论。

**English:** Pure JavaScript, but the full integration is **verified on Linux x64 only**. DSH platform coverage is not plugin certification. Optional `ffmpeg` / `ffprobe` enable covers, remuxing and audio transcoding; unavailable enhancements fall back to text/files. Windows path casing/short names may cause safe false negatives for workspace media.

## 架构与开发 / Architecture & development

```text
Feishu / Lark → WebSocket SDK → chat/thread ↔ DSH Session
                                  ↓
                         DSH models / tools / workspace
                                  ↓
                      step or progress cards → delivery
```

插件在 DSH Host 内运行，不需要独立服务或公网 webhook；在宿主 Web 服务上注册 **仅回环可访问**的扫码/状态路由（`/dsh-feishu/provision`），配置与凭据走原生服务。详见 [架构](<./docs/architecture.md>)。

The plugin runs inside DSH, with no separate service or public webhook. A **loopback-only** provisioning/status route (`/dsh-feishu/provision`) uses the host Web server; configuration and credentials use native services. See [architecture](<./docs/architecture.md>).

```sh
npm ci
npm run typecheck
npm test
npm run build
```

产物：`lib/index.js` 不受 Git 跟踪，`client/client.js` 受跟踪。修改源码后重建插件；Host 改动在空闲维护窗口按部署方式重新加载/重启，**不要从正在执行的 agent 回合里直接同步重启它所在的进程**。只改文档无需重启。构建客户端本身不保证当前页面自动更新。

Artifacts: `lib/index.js` is untracked; `client/client.js` is tracked. Rebuild after source changes and reload/restart Host changes in an idle maintenance window. **Do not synchronously restart the process hosting the active agent turn.** Documentation-only changes need no restart; building a client bundle alone does not establish live-page updates.

## 已知限制 / Known limitations

- 部分飞书客户端不重绘更新后的标题背景色，服务端 `header.template` 仍正确；不是通过改卡片数据能修的插件 bug。
- 部分带按钮的控制卡仍有反复就地更新后回调失效风险（O4）。重新打开命令可获得新卡，完整待办见 [项目待办](<https://github.com/Starxer/chatterbox4dsh/blob/main/TODO.md>)。
- `verbose` 仍受工具预览与平台字节上限约束；压缩与折叠不等于删除本地历史。
- 收得到消息不等于发得出去。无表情或回复时先区分权限错误与出站网络失败，见 [故障排查](<./docs/feishu-setup.md#常见问题>)。

**English:** Some Feishu clients do not repaint updated header colors. Certain button-bearing controls still risk callback exhaustion (O4); reopen the command for a fresh card. `verbose` remains bounded, and folding/compaction does not delete local history. Inbound delivery does not prove outbound health; see [troubleshooting](<./docs/feishu-setup.md#常见问题>).

## 上游来源与许可 / Upstream & license

Fork 自 [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark)（`ee639df`），独立维护、不再跟踪上游。改动见 [变更记录](<./CHANGELOG.md>)。

Forked from [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark) (`ee639df`), independently maintained rather than tracking upstream. See the [changelog](<./CHANGELOG.md>).

MIT — Copyright (c) 2026 sugarforever (upstream), modified work by Starxer.
