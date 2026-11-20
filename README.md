# chatterbox4dsh

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接进飞书 / Lark 的聊天通道——用飞书对话，agent 的工作过程直接显示在卡片上。

[文档导航](<./docs/README.md>) · [配置指南](<./docs/feishu-setup.md>) · [媒体与隐私](<./docs/privacy.md>) · [架构](<./docs/architecture.md>) · [变更记录](<./CHANGELOG.md>)

## 这是什么

DSH 才是 agent 本体，这个插件只做一件事：把 DSH 的原生能力翻译成飞书里的聊天交互。

飞书和 DSH Web UI 共用同一套模型、工具、工作区、会话和审批服务；在哪边发起，另一边的记录都在。它不是另一个 agent 平台，也不是 24 小时在线的通用助手。

## 能做什么

- **聊天即会话**：单聊、群聊各用一份 Session；话题群里每个话题是独立会话，绑定关系重启不丢。
- **过程看得见**：深度思考、工具调用和结果按档位展示（简洁 / 标准 / 详细 / 完全展开），步骤卡带耗时、token 与上下文用量；思考内容默认折叠、可切成平铺，**全文不截断**（超过一张卡的上限就接着发续卡）。
- **会话管理**：`/new`、`/session`、`/fork`，切换模型和推理等级，调整权限，归档与会话置顶。
- **权限**：`/permission` 与 DSH 的权限预设目录对齐；profile 里启用官方 `auto-review` 实验包时会多出「自动审查」（无沙箱、逐次调用前由模型审查，切换前先确认，和「完全权限」同色）。
- **智能体团队**：启用官方 Agent Teams 实验包、且 Agent 自动组队时，飞书里会跟着出现团队看板卡（成员 + 共享任务），只有内容变化才发新卡。
- **在线文档**：直接读写飞书 docx——读成 Markdown、按 Markdown 写入、把同一篇当发布目标、改单个块、发评论；公式写成飞书原生可编辑公式。
- **文件与媒体**：收发图片、文件、音视频；交付物可以内联在卡片里，也可以发原件。卡片内联不了的媒体（超出内联上限、格式不支持、没装 `ffmpeg`）会**自动按原文件发一条文件消息**，不会只剩一行路径。
- **审批与提问**：和 Web UI 共享同一份状态，哪边先答哪边生效。
- **失败能接着跑**：可重试的失败（速率限制 / 服务端 / 超时 / 网络 / 空响应）回合会在失败卡上带一个 `🔁 继续生成` 按钮，点一下就走宿主原生的「空 prompt 继续」—和 Web UI 的继续生成同一条路径；模型方内容安全审查拒绝时，失败卡会额外说明这不是网络或插件问题，并保留原始报错与错误码。

## 安装

前置：Node.js 24.9+，已安装 DSH `0.2.x`（peer 范围 `^0.2.0-rc.1`，本版在 `0.2.2-rc.5` 上构建并验证）。

```sh
# 安装插件并启动 DSH Web
npx @deepseek-ai/dsh plugin --profile web add @starxer/chatterbox4dsh
npx @deepseek-ai/dsh web
```

启动后：

1. 打开 Web 页面 → **Plugins → 飞书与 Lark** → **扫码配置**，用飞书扫码并确认授权。
2. 在飞书里找到机器人，发一条消息（群聊默认需要 @ 机器人）。
3. 之后在 **Settings** → 飞书与 Lark 里调整凭据、访问策略和展示档位。

> 手动建应用、权限清单、事件订阅与收发故障排查见 [配置指南](<./docs/feishu-setup.md>)。

## 常用命令

| 命令 | 作用 |
|---|---|
| `/help` | 查看当前可用的全部命令 |
| `/new` | 新建会话（可选工作区、预设、模型） |
| `/model` | 查看或切换模型 |
| `/session` | 会话面板、列表或按编号切换 |
| `/subagents` | 子代理面板（`tree` 看层级）；rc.5 起显示同级唯一的 agent 名与路径 |
| `/display` | 切换工作展示档位 |
| `/permission` | 切换权限预设（含实验性的「自动审查」） |
| `/stop` | 中止本轮并丢弃排队消息 |

## 配置

日常配置走 **Settings** → 飞书与 Lark；也可以写在 DSH profile 的 patch 文件里。凭据只保存引用（`appSecretRef`），不写明文。完整配置项见[配置指南](<./docs/feishu-setup.md>)。

「自动审查」和团队看板依赖 DSH 官方实验插件（`auto-review` / Agent Teams）：在 profile 里启用后自动出现，未启用时插件行为和以前完全一样。

## 文档

- [文档导航](<./docs/README.md>)：按要做的事找对应文档
- [配置指南](<./docs/feishu-setup.md>)：建应用、扫码、权限、排查收发
- [媒体与隐私](<./docs/privacy.md>)：媒体会传到哪里、自动上传的边界
- [飞书能力参考](<./docs/feishu-capabilities.md>)：平台限制与实测证据
- [架构](<./docs/architecture.md>)：模块划分与卡片生命周期
- [变更记录](<./CHANGELOG.md>)

## 已知限制

- 完整链路（飞书收发、卡片、媒体、重启）在 **Linux x64** 上做过端到端验证。
- **Windows**：DSH **桌面版**已在真机安装 `0.4.2`，扫码授权、卡片与飞书收发正常（使用者确认，2026-11-12）；CI 另有 `windows-latest` 必过腿（`typecheck` + 全部单元测试，2026-11-11 起）。仍未单独验证：依赖外部 `ffmpeg` / `ffprobe` 的转码与封面，以及 macOS。
- 部分飞书客户端不重绘就地更新后的卡片标题颜色（服务端数据本身是对的）。
- 「完全展开」档仍受平台字节上限约束；折叠与压缩不等于删除本地历史。

## English

A chat channel that brings [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) into Feishu / Lark: one Session per chat (each thread in a topic group gets its own), the agent's work shown as cards, the same models, tools, workspaces, sessions and approvals as the Web UI, plus document tools that read and write Feishu docx. DSH stays the agent; this plugin is only the chat surface.

```sh
npx @deepseek-ai/dsh plugin --profile web add @starxer/chatterbox4dsh
npx @deepseek-ai/dsh web
```

Requires DSH `0.2.x` (peer range `^0.2.0-rc.1`; built and verified on `0.2.2-rc.5`) and Node.js 24.9+.

Platform: the full path (Feishu send/receive, cards, media, restarts) is verified on **Linux x64**. On **Windows**, the **DSH desktop app** has now run the plugin on a real machine (0.4.2): scan-to-configure, cards and Feishu send/receive all work (operator-confirmed, 2026-11-12), and a `windows-latest` CI leg (type-check + the whole unit suite) has been a required check since 2026-11-11. Still not separately verified: media transcoding and covers that need external `ffmpeg`/`ffprobe`, and macOS end to end.

Failed turns the Host considers retryable now carry a `🔁 Continue` button on the error card (the Web UI's continue-generation path, i.e. an empty retry prompt); a provider content-safety refusal explains itself instead of reading like a transport error, and `/subagents` shows the rc.5 agent names and tree paths.

Open the Web page, go to **Plugins → Feishu & Lark** and choose **scan to configure**, or follow the [setup guide](<./docs/feishu-setup.md>).

When the official experimental `auto-review` plugin is enabled, `/permission` also offers the Auto review preset (no sandbox, per-call model review, confirmation before the switch); when the Agent Teams plugin is enabled and a team is formed, a team board card follows in the chat. Both come from the Host's own services and change nothing when the plugins are absent.

## 许可

MIT。上游 fork 自 [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark)（`ee639df`），此后独立维护、不再跟踪上游；改动见 [变更记录](<./CHANGELOG.md>)。
