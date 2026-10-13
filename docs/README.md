# 项目文档 / Documentation

> 当前文档基线：仓库主线，DSH `0.2.0-rc.2` 已验证；依赖范围保留 `^0.2.0-rc.1`。这不是 npm 已发布版本的能力承诺。
> Current baseline: repository main, verified with DSH `0.2.0-rc.2`; dependency ranges retain `^0.2.0-rc.1`. This does not describe every published npm version.

## 按任务阅读 / Start here

| 你要做什么 / Task | 文档 / Read |
|---|---|
| 了解插件、安装、命令与配置 / Overview, installation, commands, settings | [项目首页 / Project overview](<../README.md>) |
| 创建应用、扫码、排查收发故障 / App setup and connection troubleshooting | [飞书与 Lark 配置 / Feishu & Lark setup](<./feishu-setup.md>) |
| 判断媒体会传到哪里、自动上传的边界 / Media data flow and upload boundaries | [媒体与隐私 / Media & privacy](<./privacy.md>) |
| 修改插件、理解模块和卡片生命周期 / Modules and card lifecycles | [架构 / Architecture](<./architecture.md>) |
| 核查飞书组件、平台限制与实测证据 / Feishu components, limits, probe evidence | [飞书能力参考 / Feishu capability reference](<./feishu-capabilities.md>) |
| 看剩余工作 / Remaining work | [待办 / TODO](<https://github.com/Starxer/chatterbox4dsh/blob/main/TODO.md>) |
| 追溯改动与决策 / Change history | [变更记录 / Changelog](<../CHANGELOG.md>) |

## 当前行为速查 / Current behavior

- **显示档位**：`compact` 是答案卡 + 按需创建的回合过程卡；`standard` / `detailed` / `verbose` 使用步骤卡。默认 `detailed`。四个 `show*` 开关只能减少档位允许的内容；这是插件的展示配置，不是改写 DSH Web 聊天的展示配置。
- **简洁过程卡**：可见窗口最多最新 5 步、40 行；更早的内容最多保留 60 行并折叠。可见区与折叠区均按步分组，标题在引用块外；行内标记未闭合的叙述行会单独成元素。别的卡片插入聊天后，下一件实际活动另起分段，不保证整轮只有一条消息。
- **压缩摘要**：使用 `22,000` UTF-8 字节的正文预算，超出时写明截断，不再是旧的 200 字上限。折叠不减少卡片 JSON 字节数。
- **问答**：单选点选即记录，可通过回执返回重答；全部答完后需最终确认才提交给模型。多选通过每选项一个 `checker` 一次提交。
- **交付**：`present` 媒体内联、白名单文档自动发文件、其他文件点击确认后发送；未 `present` 的产出默认只投递媒体与白名单文档，不列整张源码清单。
- **平台**：完整链路只验证过 Linux x64。macOS / Windows 未进行端到端验证。

**English:** `compact` separates the answer from a lazily created, segmented turn-progress card; the other levels use step cards. `detailed` is the default, and the plugin's four `show*` switches only subtract detail. Progress keeps at most five recent steps / 40 visible rows and 60 folded rows. Compaction summaries have a 22,000-byte UTF-8 budget. Single-select answers are recorded on tap but the batch is submitted only after final confirmation; multi-select uses one checkbox per option. Deliverables are routed by type. Full integration is verified on Linux x64 only.

## 设计决策记录 / Design records

以下文件保留提出时的现状、候选方案与取舍，**不是当前使用手册或待执行计划**。先看各文件顶部的状态说明，再看实现章节。

These records preserve the original problem and alternatives; they are **not current usage instructions or execution plans**. Read their status notes first.

| 记录 / Record | 状态 / Status |
|---|---|
| [显示控制卡 / Display controls](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/display-card-design.md>) | 已实现；后来加入 4 档，保持每次点击发新卡 / Implemented; four levels added later |
| [步骤相位 / Step phases](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/step-card-phases-design.md>) | 实时流仅切相位，不逐 token 上屏 / Live frames drive phase changes, not token-by-token text |
| [注入、压缩与展示对齐 / Transcript parity](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/transcript-parity-design.md>) | 已实现；顶部现状优先于历史提案 / Implemented; current summary takes precedence |
| [最初实现计划 / Original implementation plan](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/superpowers/plans/2026-08-15-dsh-lark-channel-plugin.md>) | 历史存档；未勾选项不代表当前待办 / Historical; unchecked boxes are not an active backlog |

## 历史迁移 / Historical migrations

这些记录只适用于标题里的版本跳跃。文中“当前版本”、API 签名、命令与依赖范围都是**当时的快照**，不要照抄到新版本。当前兼容范围以 [包声明](<../package.json>) 为准；后续 `0.1.7` / `0.2.0` 适配摘要见 [变更记录](<../CHANGELOG.md>)。

Migration records apply only to the versions named in their titles. API signatures and dependency ranges are historical snapshots; use the [manifest](<../package.json>) for current ranges.

| 版本跳跃 / Version transition | 记录 / Record |
|---|---|
| rc.8 → 0.1.2-alpha.1 | [ApiProxy 拆分 / ApiProxy split](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/migration-rc8-to-0.1.2.md>) |
| 0.1.2-alpha.4 → 0.1.3-alpha.1 | [事件流与原生附件 / Events and attachments](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/migration-0.1.2-to-0.1.3.md>) |
| 0.1.3-alpha.2 → 0.1.5-alpha.1 | [依赖范围与日志格式 / Dependency ranges and log format](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/migration-0.1.3-to-0.1.5.md>) |
| 0.1.5-alpha.1 → 0.1.5-rc.1 | [测试环境与交付事件 / Test environment and deliverables](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/migration-0.1.5-alpha.1-to-rc.1.md>) |
| 0.1.5-rc.2 → 0.1.6-alpha.1 | [启动与解析变更 / Boot and resolution changes](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/migration-0.1.5-rc.2-to-0.1.6-alpha.1.md>) |
| 0.1.6-alpha.1 → 0.1.6-alpha.2 | [双实例事故 / Duplicate module incident](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/migration-0.1.6-alpha.1-to-alpha.2.md>) |
| 0.1.6-alpha.2 → 0.1.7-alpha.1 | [设置服务与恢复语义 / Settings and resume semantics](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/migration-0.1.6-alpha.2-to-0.1.7-alpha.1.md>) |

## 维护约定 / Maintenance

1. 首页写“怎么用”，架构写“现在怎么实现”，能力参考写“平台有什么限制”；设计记录写“为什么这样选”，变更记录写“何时改变”，待办只维护仍需跟进的状态。
2. 行为变更时同步中英文，不把旧提案继续写成现状；完成事项从当前待办移到完成索引，保留编号，不另建第二份待办表。
3. 平台限制、插件默认值与部署自定义值分开写。测试通过、服务端接受卡片与人眼确认渲染是三种证据，不能互相替代。
4. 公共文档只使用中性路径和占位符。凭据只写字段名/引用名，不写值；本地运维、机器信息和原始取证不发布。
5. npm 包随附首页、文档索引、配置、架构、隐私、能力参考与变更记录；设计和迁移的完整记录在源码仓库，故上方使用仓库链接。

**English:** Keep usage, implementation, platform evidence, decisions, changes and the active backlog separate. Update both languages, preserve stable issue identifiers, distinguish defaults from deployment overrides, and never publish local operations or credential values.
