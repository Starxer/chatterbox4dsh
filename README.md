# chatterbox4dsh

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接进飞书 / Lark 的聊天通道——用飞书对话，agent 的工作过程直接显示在卡片上。

[文档导航](<./docs/README.md>) · [配置指南](<./docs/feishu-setup.md>) · [媒体与隐私](<./docs/privacy.md>) · [架构](<./docs/architecture.md>) · [变更记录](<./CHANGELOG.md>)

## 这是什么

DSH 才是 agent 本体，这个插件只做一件事：把 DSH 的原生能力翻译成飞书里的聊天交互。

飞书和 DSH Web UI 共用同一套模型、工具、工作区、会话和审批服务；在哪边发起，另一边的记录都在。它不是另一个 agent 平台，也不是 24 小时在线的通用助手。

## 能做什么

- **聊天即会话**：单聊、群聊各用一份 Session；话题群里每个话题是独立会话，绑定关系重启不丢。
- **过程看得见**：推理、工具调用和结果按档位展示（简洁 / 标准 / 详细 / 完全展开），步骤卡带耗时、token 与上下文用量。
- **会话管理**：`/new`、`/session`、`/fork`，切换模型和推理等级，调整权限，归档与会话置顶。
- **权限**：`/permission` 与 DSH 的权限预设目录对齐；profile 里启用官方 `auto-review` 实验包时会多出「自动审查」（无沙箱、逐次调用前由模型审查，切换前先确认，和「完全权限」同色）。
- **智能体团队**：启用官方 Agent Teams 实验包、且 Agent 自动组队时，飞书里会跟着出现团队看板卡（成员 + 共享任务），只有内容变化才发新卡。
- **在线文档**：直接读写飞书 docx——读成 Markdown、按 Markdown 写入、把同一篇当发布目标、改单个块、发评论；公式写成飞书原生可编辑公式。
- **文件与媒体**：收发图片、文件、音视频；交付物可以内联在卡片里，也可以发原件。
- **审批与提问**：和 Web UI 共享同一份状态，哪边先答哪边生效。

## 安装

前置：Node.js 24.9+，已安装 DSH。

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

- 完整链路只在 **Linux x64** 上验证过；macOS / Windows 未做端到端验证。
- 部分飞书客户端不重绘就地更新后的卡片标题颜色（服务端数据本身是对的）。
- 「完全展开」档仍受平台字节上限约束；折叠与压缩不等于删除本地历史。

## English

A chat channel that brings [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) into Feishu / Lark: one Session per chat (each thread in a topic group gets its own), the agent's work shown as cards, the same models, tools, workspaces, sessions and approvals as the Web UI, plus document tools that read and write Feishu docx. DSH stays the agent; this plugin is only the chat surface.

```sh
npx @deepseek-ai/dsh plugin --profile web add @starxer/chatterbox4dsh
npx @deepseek-ai/dsh web
```

Open the Web page, go to **Plugins → Feishu & Lark** and choose **scan to configure**, or follow the [setup guide](<./docs/feishu-setup.md>).

When the official experimental `auto-review` plugin is enabled, `/permission` also offers the Auto review preset (no sandbox, per-call model review, confirmation before the switch); when the Agent Teams plugin is enabled and a team is formed, a team board card follows in the chat. Both come from the Host's own services and change nothing when the plugins are absent.

## 许可

MIT。上游 fork 自 [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark)（`ee639df`），此后独立维护、不再跟踪上游；改动见 [变更记录](<./CHANGELOG.md>)。
