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
| `src/harness.ts` | Harness 会话服务，session 映射持久化 |
| `src/feishu-streaming.ts` | 统一 per-step 卡片：订阅 mux 事件流，渲染 reasoning（200 字预览）+ text（3000 字上屏 + 溢出自动拆 continued 卡）+ 工具调用（pretty-print args，2000 字上限）+ 结果预览 + 时长/token footer |
| `src/card-supersede.ts` | 交互流程「每步发新卡」的配套：把被替换的旧卡片改写成无按钮的失效提示（zh/en 双语，优先 CardKit 实例、best-effort） |
| `src/feishu-todos.ts` | Todo 进度卡片 |
| `src/feishu-approvals.ts` | 工具审批处理 |
| `src/feishu-questions.ts` | ask_user_question 卡片 |
| `src/commands.ts` | 斜杠命令注册和处理 |

## 事件流

每个 agent step 的事件流：

```
step/start        → 记录开始时间（resetStep 清空本 step 的卡片身份）
assistant/chunk   → 累积 reasoning/text，记录首 token 时间
assistant/message → 本 step 还没卡就发卡，已有卡就更新（text 前 3000 字上屏），记录 usage
tool/call         → 追加工具调用（状态 ⏳ running），已有卡更新、无卡则发卡
tool/result       → 追加工具结果和预览（✅/❌），更新卡片，记录完成时间
turn/end          → flush debounce → 发送溢出文本 continued 卡（如有）→ 发送 Turn Complete footer 卡
```

> **一步一卡**：`assistant/message` 与 `tool/call` 都遵循「`state.stepCardSent` 为真就 `updateStepCard`，否则 `sendStepCard`」。任一分支无条件发新卡都会让 `state.stepCardRef` 改指新卡，**旧卡从此收不到更新**——表现为工具永远停在 `⏳ running…`，或卡片只剩 reasoning。
>
> **防抖按卡片 ref 键**：`pendingUpdates` 是 `Map<StepCardRef, …>`，不是 `Map<SessionStepState, …>`。一个 state 对象服务该会话所有 step，按 state 键会让下一步骤的更新取消上一步骤尚未触发的 150ms 定时器，上一步的卡片丢掉工具结果。

## 卡片设计

- **Step 卡片**：每个 agent step 一张，wathet→green/red 颜色变化，底部显示时长和 token；text 超 3000 字自动拆 `Reply (continued N/M)` 卡发送。发送走 **CardKit 卡片实例**（`createCardInstance` → `sendCardByReference`，更新走 `updateCardInstance` + 单调 `sequence`，通道缺这些方法时回退 `send` + `updateCard`）——step 卡没有按钮，不受「同一条消息就地更新 2–3 次后按钮回调失效」的限制，因此可以持续原地更新
- **Turn Complete 卡片**：turn 结束后发送，绿色，展示性能指标和配置信息
- **Todo 卡片**：turquoise，含进度条
- **审批卡片**：orange，含 approve/deny 按钮

## 技术要点

- **Debounce**：150ms 合并快速更新，减少 API 调用；**表按卡片 ref 键**（见上「防抖按卡片 ref 键」）
- **交互卡片不能就地更新**：飞书对同一条消息的卡片就地更新约 2–3 次后**不再投递按钮回调**（`im.v1.message.patch` 与 `cardkit.v1.card.update` 同样受限）。带按钮的卡片（`/new` 流程、目录浏览器、`/model`、`/session` 面板）**每一步都新建卡片实例 + 发新消息**；旧卡留在聊天里，不做 recall
- **旧卡改写为失效提示**：每发一张新卡，就用 `src/card-supersede.ts` 把上一张改写为无按钮的灰色提示（顺序 `send → supersedePrevious → note`）；结果/错误卡 `terminal: true` 只改写上一张、自身不进记忆。改写失败只 warn，不阻断流程
- **Flush 同步**：`turn/end` 时 flush pending debounce，确保卡片更新在 Turn Complete 之前完成
- **Error-safe**：内层 try/catch 保护 mux 事件处理，防止单个事件错误导致整个流断开
- **Card JSON 2.0**：所有卡片使用 `schema: '2.0'` + `body.elements`，原生支持 markdown
- **入站图片判型按字节**：飞书 `messageResource` 不给内容 MIME、SDK 归一化的 image 资源无文件名，故图片必须**先下载字节、用 magic bytes 判真实格式**（`sniffImageMime`）再交给 `attachments.saveImage`，**不得猜 JPEG**——DSH 附件库会校验声明与实际字节（`IMAGE_TYPE_MISMATCH`），猜错即拒收非 JPEG 图片
- **入站文件/图片统一走 DSH 原生附件库**：图片经 `admitImagesForMessage` → `saveImage`；文件经 `admitFilesForMessage` → `downloadStream()`（`AsyncIterable`，背压）→ `saveFileStream`。两者都落 DSH 原生附件库（`~/.dsh/attachments/v1/`，文件在 `files/<sha256 前 2 位>/<sha256>/<文件名>`），agent 经 `fileHostPath` 读取；不再写 `.feishu-inbox/` 或注入 `[文件: …]` 文本（单路径）
- **会话事件读取必须按 seq 范围，不要全量物化**：DSH `Session` 的 `snapshotEvents(fromSeq, toSeqExclusive)` 无参默认 `(0, seq)` 且**缓存一整段日志的冻结副本**（`eventsSnapshot`）；会话日志是 **append-only**、随使用无限膨胀。插件读会话事件（如 `summarizeTurn` 做本轮摘要）应传 `firstSeq` 只取本轮增量，避免每条消息全量复读+常驻副本引发的内存峰值（本项目曾直接 `JavaScript heap out of memory`）。
- **压缩只改 surface、不删日志**：DSH `compaction-basic` 压缩改写的是 **surface（进模型的上下文视图）**，经 `replaceGeneration` 替换它；**事件日志本体不被删除**，仍是全量。故日志体积只能靠「新会话/归档」收敛，压缩只降低每轮上下文折叠的峰值。读会话事件时须牢记「日志 ≠ 上下文」这一差别。
