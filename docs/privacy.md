# 媒体与隐私 / Media & privacy

> 基线：仓库主线，2026-10-13 文档核对。本文说明数据流和已验证边界，不承诺端到端加密、跨应用隔离或自动清理。
> Baseline: repository main, reviewed 2026-10-13. This describes data flow and verified boundaries, not end-to-end encryption, cross-app isolation or automatic retention cleanup.

## 数据会去哪里？

| 操作 | 数据流与边界 |
|---|---|
| 用户在飞书上传图片/视频/文件 | 字节首先交给飞书服务；插件按消息资源 API 下载到宿主的 DSH 附件库 |
| 图片交给 agent | 保存为原生 image 内容块；若所选路线支持图像，图片数据可进入该模型供应商的 API 请求。使用本地模型也需确认实际 endpoint 在哪里 |
| 用户发来的视频/音频/普通文件 | 当前入口把本地文件路径交给 agent，**不等于自动作为原生视频/音频模型输入**；agent 后续工具可能读取、抽帧、转写或发送内容 |
| 模型正文引用本地媒体 | `cardImages` 允许时上传到飞书，再以内联图片/播放器显示。只生成一个 Markdown 引用也可能触发上传，不必先调用发文件工具 |
| `present` 或自动产出交付 | 媒体可能自动内联，白名单文档可能自动发送，其他文件需点击确认；配置见下 |
| `feishu_send_file` | 显式读取文件并上传到绑定聊天，可能发成媒体或原生文件消息 |
| Web/自动化回合镜像 | `mirrorExternalTurns` 默认开：绑定会话的外部回合也会回显消息、收尾和交付 |

**English:** Inbound bytes are already held by Feishu before the plugin downloads them to DSH. Image blocks may be sent to the selected vision-model API. Other attachments initially expose local paths, but later tools may read, transform or transmit them. A media reference in model text can trigger an automatic Feishu upload; `present`, filtered produced artifacts and explicit sends have separate delivery paths. External turns are mirrored by default.

本地附件和会话日志有持久存储。**压缩上下文不是删除日志，折叠卡片不是删除数据，也不能假定附件有 TTL/自动回收**。插件未提供附件保留期限或删除飞书端已上传资源的开关；清理需按宿主附件库与飞书平台的能力单独管理。

Local attachments and session logs persist. **Context compaction does not delete logs, a folded card does not delete data, and no attachment TTL should be assumed.** This plugin does not expose a retention policy or a control to delete already uploaded Feishu resources.

## 资源 key 是公开链接吗？

`img_v3_…` / `file_v3_…` 是飞书资源标识，**不是可匿名访问的公开 URL**，不意味着“拿到 key 就能在浏览器里下载”。但 key 也不是“只有发送者本人能看”的保证。

2026-10-12 使用一套应用凭据做过资源读取探针，能支持的结论只有：

| 对象 | 已观测到什么 | 不能据此推断什么 |
|---|---|---|
| 应用上传的消息图片 | 无 token/无效 token 不能读取；同租户的该应用 token + 正确 key 可读取 | 未测试另一租户或同租户另一应用，因此不能保证跨租户/跨应用具体隔离规则；图片结果也不能覆盖所有文件 API |
| 用户消息中的图片 | 该样本只给 key 无法读取；正确消息 id + key + 应用 token 能读取，错误消息坐标/错误 key 被拒 | 不能把本次样本的行为推广成所有消息类型的永久平台承诺 |

资源权限由飞书接口、应用权限、租户和消息归属共同决定。**应按敏感标识处理 key 与消息坐标**，不要公开整段 API 响应、凭据或下载请求。

**English:** Resource keys are not anonymous public URLs. In a single-app probe, an app-uploaded message image was readable with that app's tenant token and its key, not without a valid token. A sampled user-message image required the matching message id/key/token. No second app or tenant was tested, and the image probe does not establish every file API's rules. Treat keys and message coordinates as sensitive identifiers.

## 谁能看到？

- 机器人回复到单聊时，会进入该聊天；回复到群/话题时，**群内有访问权的成员**可能看到，不是仅请求者本人可见。
- 图片与文档可被保存、截图、录屏或转发。含音视频的卡片因平台要求设置 `enable_forward: false`，**这仍挡不住截图/录屏，也不覆盖所有原生媒体或文件消息**。
- 飞书是数据处理方。视觉模型请求还有所选供应商这条数据流；云端模型不是“全部留在宿主”。各方留存与训练使用规则须查自己的合同/服务配置，插件不能保证。

**English:** Group/topic replies may be visible to every member with access. Disabling forwarding on audio/video cards does not prevent capture and does not cover every native file/media message. Feishu and, when used, the vision-model provider are separate data processors; their retention and use policies are not guaranteed by this plugin.

## 三条上传路径的围栏不同

| 路径 | 当前文件边界 |
|---|---|
| 正文媒体自动内联 | 默认 `cardImages: workspace`，realpath 后仍在会话工作区内才上传；区外符号链接拒绝。`any` 显式放宽，`text` 不自动上传 |
| `present` / 自动产出交付 | 规划与可点确认均验证存在、普通文件、大小与 realpath 工作区包含；按钮仅带不透明 token，不带路径，点击时重验 |
| 显式 `feishu_send_file` | 验证存在、普通文件、非空、≤30MB，但**当前没有工作区包含检查**；不能把名称里的 workspace 当成强制围栏 |

发送工具能否使用还取决于 agent 工具集与宿主权限策略，**聊天白名单只决定谁能驱动机器人，不是文件泄露防护层**。拥有机器人使用权的人可能借模型与工具访问宿主允许读取的内容。

实现依据：[媒体内联](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/card-images.ts>)、[交付控制](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-deliver.ts>)、[主动发送](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/feishu-send-file.ts>)。

**English:** Automatic card media defaults to realpath workspace containment; planned delivery revalidates it on interaction. **Explicit `feishu_send_file` lacks that same containment check today.** Access allowlists control who can drive the bot, not which files every tool may transmit. Tool availability and host permissions remain critical.

## 较保守的配置

1. 默认保留 `cardImages: workspace`，敏感工作区可用 `text` 关闭正文媒体自动上传；**不要无意设成 `any`**。
2. `produceCard: off` 关闭未 `present` 文件的自动产出交付；`summary` 只报计数。
3. 调低 `deliverDocMaxMb` 可以减少自动发文档的大小，**不能彻底关闭所有 `present` 文档投递**，该项最小是 1 MB。
4. 不需要外部回合进群时设 `mirrorExternalTurns: false`。
5. 对敏感内容使用严格的群/用户白名单、宿主沙箱与精简工具集；当前 `feishu_send_file` 的边界不足时不要把它开放给不受信任的使用者。
6. 上传前确认数据是否允许进入飞书、所在群以及当前模型供应商。减少卡片显示（如隐藏推理）只减少显示，**不阻止模型请求或工具读取数据**。

**重要**：`cardImages: text` **不是全局“禁止上传”开关**——显式发送、文档交付与用户自己的上传都不受它控制。这批仅补文档，没有收紧工具权限或改变运行配置。

**English:** Prefer workspace-only media (or `text`), disable unpresented delivery when unnecessary, restrict mirroring and bot access, and use host sandbox/tool restrictions. A smaller automatic-document threshold is not an off switch. **`cardImages: text` is not a global no-upload policy**, and hiding card details does not stop model/tool data access. This documentation change does not modify runtime permissions.

## 相关文档

- [配置与默认值](<../README.md#配置--configuration>)
- [飞书配置与收发排查](<./feishu-setup.md>)
- [平台媒体大小与卡片边界](<./feishu-capabilities.md>)
- [插件数据流与实现](<./architecture.md>)
