# 迁移分析：DSH 0.1.2-alpha.4 → 0.1.3-alpha.1

> **来源**：DSH 远端最新 release `dsh-v0.1.3-alpha.1`（2026-09-04 发布）。本文基于 `dsh-v0.1.2-alpha.4..dsh-v0.1.3-alpha.1`（**336 个 commit**）的分析。
> **创建日期**：2026-09-04
> **基线**：本插件当前在 `dsh-v0.1.2-alpha.4` 下运行/验证。0.1.2-alpha.4 与 0.1.2-alpha.2 之间无 API 破坏（上轮已核），故迁移范围即 alpha.4 → alpha.1。
>
> ⚠️ **注意**：本文档涉及的是 DSH **服务/事件 API 面**与 **插件调用点** 的对应关系，用于指导改造。文中路径均为中性表达（如 `<DSH_HOME>/attachments/v1`、会话工作区 `.feishu-inbox`），不含任何本机私有路径。

---

## 结论速览

| 优先级 | 改动 | 插件文件 | 类型 |
|---|---|---|---|
| 🔴 P0 | `assistant/chunk` 流式机制被替换 | `src/feishu-streaming.ts` | 破坏性 |
| 🔴 P0 | `sessionPersistence.readFrom()/prepare()` 被移除 | `src/harness.ts` | 破坏性 |
| 🟡 P1 | `sessionPersistence.list()` 返回结构变化 | `src/harness.ts` | 兼容 |
| 🟡 P1 | `commands` `input.images` → `input.attachments` | `src/index.ts` | 兼容（空数组不受影响） |
| 🟢 P2 | 通用文件附件原生缝合 | `src/channel.ts` / `src/feishu-receive-file.ts` / `src/feishu-send-file.ts` | 新特性接入 |
| 🟢 P2 | `/steer` `/queue` 走 `sessionController.prompt()` | `src/harness.ts` / `src/index.ts` | 新特性接入（✅ 已实现，版本无关） |
| ⚪ 免改 | 图片接入 (`saveImage`/`imageLimits`)、瀑布事件、`sessionController` 系列 | — | 无变化 |

**一句话**：升级到 0.1.3 需要 **1 处核心重构（流式渲染）+ 1 处持久化调用迁移（SessionHandle）+ 少量取值适配**；图片接入与审批/问答瀑布事件**无需改动**。新版本带来的**原生文件附件**是替换插件 `.feishu-inbox` 手工路径的最佳机会。

---

## 一、🔴 破坏性变更 1：`assistant/chunk` 流式机制被整体替换

这是本次迁移**影响最大**的一处。

### 现象

插件 `src/feishu-streaming.ts` 通过订阅 `session/event` 读取 `event.type === 'assistant/chunk'`（单个 `{ type: 'reasoning-delta' | 'text-delta', text: string }` 增量），逐个累积 `reasoning` 与 `text`，实现逐 token 渲染。

**0.1.3 下这个事件词从 `SessionEventMap` 中移除了。**

### 根因（DSH 侧 commit）

- `f99b06eaed` `feat(session)!: embed assistant streams in format v2`
- `30e045dfad` `feat(agent): emit live assistant stream frames`
- `d1521ea783` `feat(session)!: add released format migration`
- `b4ea3efcf6`（session-format-06-v2-snapshot-rollout，merge #3400）

### 新的事件/数据模型

| 项 | 0.1.2-alpha.4（旧） | 0.1.3-alpha.1（新） |
|---|---|---|
| 实时逐 token | 持久 `assistant/chunk`（`session/event`） | **agent-scoped 实时事件 `agent/assistant-stream`**（`@deepseek-ai/dsh-agent`），帧类型 `start`/`chunk`/`end` |
| 完成内容 | `assistant/message` | `assistant/message`（**内嵌 `stream: AssistantStreamRecord[]`**，含完整 text/reasoning 批量序列 + `usage?` + `interrupted?`） |
| 未成文尝试 | — | 新增持久 **`assistant/attempt`** `{ turn, step, stream }`（失败/重试/取消，无 surface message） |
| 实时帧 opt-in | — | `session-controller.follow({ assistantStream: true })` |

**帧结构**（`AssistantStreamFrame`，`packages/core/agent/src/runtime-types.ts`）：

```ts
| { type:'start';  attemptId: LlmAttemptId; revision; turn; step }
| { type:'chunk';  attemptId: LlmAttemptId; revision; index; time; chunk: StreamChunk }
| { type:'end';    attemptId: LlmAttemptId; revision; index;
    outcome: { kind:'committed', eventType:'assistant/message'|'assistant/attempt', seq: SessionSeq }
           | { kind:'abandoned' } }
```

- `attemptId`：session-local `${sessionId}:${attempt}`；`revision` 在单个 attached Agent 生命周期内单调，replacement Agent 从 1 重启。
- `index`：chunk 在 attempt 内的连续 dense 下标（0 起）；`end.index` = 下一 chunk 位置。
- `chunk` 帧的 `chunk` 字段就是**原始 `StreamChunk`**（`{ type:'text-delta'|'reasoning-delta', text }`）——**与插件现在从 `event.data.chunk` 读的是同一个对象**，逐 delta 累积逻辑可原样复用。
- 事件是 **agent-scoped `@mode emit`**（`payload: { agent, frame }`）：进程本地、**无重放**，插件需在 Agent 开始输出前订上才能收到完整 `start→chunk*→end`。

**`AssistantStreamRecord`**（`@deepseek-ai/dsh-llm` 的 `assistant-stream.ts`）为批量记录型：

```ts
| { type: 'text-chunks'; time0; index; dt: number[]; texts: string[] }
| { type: 'reasoning-chunks'; time0; index; dt: number[]; texts: string[] }
```

### `session/event` 本身未变

`session/event` 仍是 `(session, event)` 双参、`@mode emit`——插件订阅无需改。**变的只是它能承载的事件词**：不再有 `assistant/chunk`，改为 `assistant/message`（带 `stream`）与 `assistant/attempt`。

### 插件受影响点

- `src/feishu-streaming.ts`：`handleEvent` 的 `else if (event.type === 'assistant/chunk')` 分支（逐 delta 累积 reasoning/text、记 TTFT）。`assistant/message` 分支已存在（读 `message`/`usage`）。
- `src/feishu-toolcalls.ts` / `src/feishu-todos.ts`：订阅 `session/event`，读 `tool/call`、`tool/result`、`todo/write` —— **这些词在 0.1.3 均保留**，无需改。

### 迁移方案（推荐 A + end 兜底）

> 本小节记录"方案 A 能否保持与现状一致的体感"的核查结论（2026-09-06），作为改造依据。

**现状体感的机制**：插件现在的逐 token 效果来自 `assistant/chunk` 的逐 delta 累积（`feishu-streaming.ts` 的 `state.reasoning += ...` / `state.text += ...` + TTFT 记录），并用 **150ms debounce** 把高频更新合并成对**同一张卡片的原地 `updateCard` patch**。所以用户看到的并不是"逐字符"，而是"每 ~150ms 刷新的逐步增量 + 卡片原地更新"。

**方案 A（保留逐 token 体感）**：订阅 agent-scoped 实时帧。

- host 侧 `ctx.on('agent/assistant-stream', ...)` 收 `payload.frame`，`chunk` 帧里取 `frame.chunk`（原始 `StreamChunk`）做 delta 累积；`start` 帧开新 attempt（重置 delta 基线），`end` 帧收尾。
- 或经 `session-controller.follow({ assistantStream: true })` 的返回流收 `{ type:'assistant-stream', frame }`。
- 注意：**agent-scoped** 事件，订阅需绑定到对应 Agent/session；`@mode emit`、进程本地、无重放。

**方案 B（低改动，失去逐 token）**：只订阅 `session/event` 的 `assistant/message`，消息完整到达后一次性从 `message.stream` 拆出 text/reasoning 渲染。工具调用、usage 展示不变。失去流式增量观感，但实现最简、最稳。

**体感一致性结论**：

- ✅ **可达一致**：`chunk` 帧携带的就是原始 `StreamChunk`，插件的 delta 累积逻辑与 150ms debounce + 原地 patch 机制对新帧流**依旧成立**——帧流频率与现在 `assistant/chunk` 一致（模型产出多少 delta 就发多少帧），因此用户看到的逐 token 增量 + 卡片原地刷新节奏不变。
- ⚠️ **唯一落差点 = 接入时机**：`agent/assistant-stream` 是进程本地、`@mode emit`、**无重放**的实时事件。插件若在某个 turn 中途才接通（而非从 turn 开始就常驻订阅），会缺起始几帧；`follow({assistantStream:true})` 虽会补一个 cached active-attempt baseline，但不保证与"从 start 帧一路看下来"完全一致。对**开 channel 即常驻订阅**的飞书通道通常无感，但不如现在 `session/event` 的"任意 seq 可补"那么兜底。
- ✅ **兜底方案**：在 `end` 帧（`outcome.kind==='committed'`）时，用对应的 `assistant/message.stream`（或 `message.content`）做一次**完整正文补齐**——即便中途接入或缺帧，最终正文也不为空。避免出现"正文消失"。

**推荐实现**：**方案 A 为主 + end 帧兜底**。A 保逐 token 观感；end 兜底保完整性（补中途缺帧/正文）。若后续实测接入时机无问题，A 即可独当；若不想承担实时订阅复杂度，退方案 B（放弃逐 token，保正文完整）。

---

## 二、🔴 破坏性变更 2：`sessionPersistence` 改为 `SessionHandle` 缝

### 现象

插件在 `src/harness.ts` 多处调用：

- `sessionPersistence.readFrom(id, 0)`（约第 748/761/782/851 行）——读某会话的 header + events。
- `sessionPersistence.prepare(id)`。
- `sessionPersistence.list()`（第 440/613/731 行）——列会话，读 `item.id`。

**0.1.3 下 `readFrom()` / `prepare()` 被移除，`list()` 返回结构变化。**

### 根因（DSH 侧 commit）

- `bec6805d6a` `refactor(session-persistence)!: handle-based seam with a lifecycle-owned write path`
- `c58097a826` `feat(session-persistence-jsonl): cross-process write-ownership lease`
- `7acc038beb`（merge #3362）

### 新 API

```ts
// 读路径
const handle = await persistence.open(id, 'read')   // 返回 AsyncDisposable SessionHandle
handle.read(offset?, length?)                       // 读事件；offset 为 SessionLogOffset
// 写路径
const handle = await persistence.open(id, 'write')  // 持写所有权（跨进程 lease，无过期）
handle.append(events); handle.flush(); handle.close()  // close 释放所有权
// 元数据
persistence.list(opts?)   // 返回 SessionPersistenceSnapshot[] { header, revision, eventCount?, sizeBytes? }
persistence.stat(id)
persistence.create(header, opts?) -> SessionHandle
```

- `list()` 的 `SessionHeader` 现在挂在 `snapshot.header`，不再直接是列表元素。
- `SessionHandle` 是 `AsyncDisposable`，用后必须 `close()`（或进入 `ctx.effect` 作用域托管）。
- 新增错误：`SessionAlreadyExistsError` / `SessionAlreadyOwnedError` / `SessionReadOnlyError` / `SessionOwnershipLostError` / `SessionHandleClosedError` / `SessionPersistenceCorruptionError` / `SessionFormatUnsupportedError`；`SessionPersistenceNotFoundError` 保留。
- 跨进程写所有权用 kernel 仲裁（POSIX `flock` / Win32 命名信号量），**无过期**——一个卡住的 live holder 会一直持有。
- 对应地，`SessionHandle.read` 的参数是 branded `SessionLogOffset`，但该 brand 仅编译期、运行时等同数字。

### 插件迁移

| 旧 | 新 |
|---|---|
| `readFrom(id, 0)` → `.meta` / `.events` | `open(id,'read')` → `handle.read(0)`；header 从别处（`stat`/`list` 或 `handle`）取 |
| `list()` 元素 `.id` | `snapshot.header.id` |
| `prepare(id)` | `open(id,'write')` + `SessionPreparation`（若确需） |

> 插件为**读会话**以展示 `/session`、`/status`、turn 汇总与 meta。多数只需 `open(id,'read')` + `handle.read(...)`；若读取目的只是"判断是否存在/取 header"，优先 `list()`/`stat(id)` 而非开 handle。

---

## 三、🟡 兼容性变更

### `commands`：`input.images` → `input.attachments`

`@deepseek-ai/dsh-commands` 的 `defineCommand` 的 `input.images` 字段改名为 `input.attachments`（类型变为 `(ImageBlock | FileBlock)[]`），handler 参 `images` → `submittedAttachments`。

**插件结论**：不受影响。`src/index.ts` 的 `commands.execute(agent, line, [], signal)` 传的是**空数组 `[]`**，无论字段叫 `images` 还是 `attachments` 都是同一值，且插件无图片附件命令路径。**无需改动**。

### `admitPromptContent` 从自由函数变 service 方法

`@deepseek-ai/dsh-attachment` 顶层不再导出 `admitPromptContent`，改为 `ctx.attachments.admitPromptContent(...)`。

**插件结论**：不受影响（插件未使用该自由函数，图片走 `saveImage`）。新代码建议用 service 方法。

### `session-controller` Config：`coldBlankProbeMaxBytes` 移除

**插件结论**：不受影响（插件 config 无该字段）。

---

## 四、🟢 新特性：通用文件附件原生缝合（PR #3109）

这是 0.1.3 **最值得接入**的新特性，可替掉插件 `.feishu-inbox` 手工文件路径。

### 新 API

**`ctx.attachments`（`@deepseek-ai/dsh-attachment`）** 新增通用文件路径：

```ts
saveFile({ data: Uint8Array, name? })            -> FileAttachmentRef
saveFileStream({ data: Iterable<Uint8Array>, signal?, name? }) -> FileAttachmentRef
admitEncodedFile({ data: base64, name? })        -> FileAttachmentRef
readFileStream(ref, signal?)
fileHostPath(ref)                                 -> string | undefined
admitPromptContent(content)                      // 现为 service 方法，一次性 admission 图片+文件
```

- **`FileAttachmentRef`**：`{ attachmentId = sha256, name, bytes }`（内容寻址）。
- **`ctx.fileUploads`（`@deepseek-ai/dsh-client-file-upload`，新包）**：浏览器侧 hosted 服务，Agent-scoped 暂存回执（`upload`/`uploadStream`/`resolve`/`bindPrompt`/`retirePrompt`/`registerAgentResolver`）。**拒绝 subagent 会话**。
- **`FileBlock` 内容类型**（`@deepseek-ai/dsh-llm`）：`{ type: 'file', attachment }`。**永不 raw 上传给 provider**——由 `projectFilesToText` / `fileHandleText` / `contentHasFile` 投影为确定的 handle 文本（`[File "name" (N bytes, sha256:…)…]`）给每个模型路由。
- 落盘：`<DSH_HOME>/attachments/v1/files/<sha256[:2]>/<sha256>/<leafName>`（+ content alias `file-objects/...`）；图片仍在 `objects/`，两棵独立树。

### 对插件的意义

| 插件现有实现 | 0.1.3 原生替代 |
|---|---|
| `channel.ts` `admitFilesForMessage` 下载飞书文件 → 写会话工作区 `.feishu-inbox/` | `ctx.attachments.saveFile({ data, name })` → `FileAttachmentRef`，在 user message 里用 `{ type:'file', attachment }` |
| `feishu-receive-file.ts` 兜底下载 → `.feishu-inbox` | 同上 |
| `feishu-send-file.ts` 发文件（>10MB / 非图走 `{ file }`） | 读取 `FileAttachmentRef` 字节后仍按飞书通道发（保留 `sniffImageMime` 判型） |

**注意**：图片路径（`saveImage`/`saveImages`/`imageLimits`）**完全未变**，`sniffImageMime` + `IMAGE_TYPE_MISMATCH` 纪律照常，不并入文件改造。

---

## 五、新特性：`/steer`、`/queue`、消息投递走 `sessionController.prompt()`

0.1.3 的 `sessionController.prompt()`（`@deepseek-ai/dsh-api-session-controller`）是原生统一的 Agent 消息投递入口，内含图片 admission 与模态校验：

```ts
prompt({ sessionId, requestId, mode: 'queue' | 'steer', content, clientTimeZone? })
// -> { accepted: true }
```

- `mode: 'queue'` → `agent.followup`；`mode: 'steer'` → `agent.steer`。
- 内置 `routeServed` + `session/model-unavailable` 校验、图片内容 admission（`admitPromptContent`）+ 模型图片模态校验、`requestId`/`clientTimeZone` 溯源。
- 与 WebUI 共享同一 queued/steering/context placement 语义。

**对插件的意义**：`/steer`、`/queue`、普通消息、带图消息四条路径当前由 `src/harness.ts` 手工维护（`chatToBusyMode` + `agent.steer/followup/whenIdle`）。可用 `prompt()` 归一，去掉自建状态机。注：`prompt()` 不提供"排队后等 idle 再回"的返回值语义，插件若需 `whenIdle` 等待仍需保留为 wrapper。

> **实现状态（2026-09 已实现并实测）**：`/steer`、`/queue` 的**派发**已改走 `sessionController.prompt()`（`prompt({ mode: 'steer'|'queue', ... })`），但**保留**插件原有的 running-guard、`whenIdle` 等待、代际/`/stop` 丢弃（`TurnDroppedError`）与 `summarizeTurn` 包装。规则：
> - **文本内容**（`/steer`、`/queue` 均为纯文本）→ 经 `sessionController.prompt()` 派发（获得 `routeServed` 路由校验 + `requestId` 溯源）。
> - **带图内容**（普通带图消息）→ **仍走直连 `agent.steer/followup`**：本插件已用 `attachments.saveImage` 预存并直接拿 `ImageAttachmentRef` 喂给 agent，而 `prompt()` 会经 `admitPromptContent` 重新 admission，重复路径未验证有回归风险，故排除。
> - `sessionController.prompt` 不可用（未注入/老版本）→ 回退直连，不抛错。
> - 实现位于 `src/harness.ts` 的 `HarnessConversationService.dispatchPrompt`（`HarnessDependencies.sessionController` 注入）；桥接注入见 `src/index.ts`。**此改动版本无关**——当前 `dsh-v0.1.2-alpha.4` 已具备 `prompt()`（接口与 0.1.3 一致），改完即可在当版本运行。**已实机验证**：重启 dsh 后普通文本消息正常走通。
>
> **⚠️ 两个适配器必踩坑（已修，务必遵守）**：
> 1. **`AbortSignal` 强必传**：`sessionController.prompt()` 的适配器层直接 `signal.throwIfAborted()`（无可选链），传 `undefined` 会抛 `Cannot read properties of undefined (reading 'throwIfAborted')`。必须传真实 `new AbortController().signal`。
> 2. **必须作为方法调用**：`prompt()` 内部读 `this.commands.prompt(...)`，若先提取成局部变量再以裸函数调用，`this` 丢失，抛 `Cannot read properties of undefined (reading 'commands')`。必须 `sessionController.prompt(...)`（保持 `this` 绑定）。

---

## 六、确认无变化（免改）清单

| 项 | 0.1.3 状态 |
|---|---|
| `session/event` 订阅签名 | `(session, event)` 双参、`@mode emit` —— 不变 |
| `tool/call`、`tool/result`、`assistant/message`、`todo/write` 事件形状 | 保留 |
| `user-questions/request`、`approval/request` | 仍是 agent-scoped 瀑布事件，`{ prepend: true }` 有效 |
| `sessionController.selectModel/fork/rename/create` | 签名不变 |
| `agentDefaultModel.currentSelection/saveSelection` | 不变 |
| `permissionPresets.set/current` | 不变 |
| `sandboxPolicy.resolve` | 不变 |
| `Agent.steer/followup/whenIdle/cancel` | 不变 |
| `commands.register/list/execute` | 除上述字段改名外不变 |
| `tools.register/defineTool` | 不变 |
| `attachments.saveImage/saveImages/imageLimits` | 不变（图片路径） |
| `webServer.register` | 不变 |
| `dsh-llm` 导出（`createUserMessage`/`ReasoningEffortId`/`LlmRuntime` 等） | 不变 |
| `dsh-settings register/get/mutate/describe` | 不变 |
| `agent-presets list/defaultId` | 不变 |
| `SessionHeader.origin: 'subagent'` | 保留 |
| message 编辑（same-session editing） | 已在 0.1.3 前 **revert**，0.1.3 不含 |
| agent-team send-message steer | 仅 team 内部统一（删 `followup_task`、`delivery` 字段）；插件用 `agent.followup/steer` 不受影响 |
| skill 模糊搜索 / 可点击链接 / toolcard 图片结果 / python macOS wheel | 仅客户端或打包，无插件影响 |

---

## 七、新安装/新包

| 新包 | 用途 |
|---|---|
| `@deepseek-ai/dsh-client-file-upload` | 浏览器侧文件上传服务（Agent-scoped 暂存回执） |
| `@deepseek-ai/dsh-http-proxy` | 将 `HTTP_PROXY`/`HTTPS_PROXY` 安装为 undici 全局 dispatcher，使 Node `fetch` 被代理 |
| `@deepseek-ai/dsh-session-format`（+ `-catalog`/`-v0-to-v1`/`-v1-to-v2`） | 纯 session 格式迁移机制（整件 v0/v1→v2，自动迁移） |
| `@deepseek-ai/dsh-session-format-v1-to-v2` | 把旧顶层 `assistant/chunk` 内嵌进 `assistant/message.stream` |

**移除**：无（`session-persistence-sqlite` 已于更早版本移除为 JSONL-only；本版本段无整包移除）。`@deepseek-ai/dsh-session` 移除了 `decodeStorageRecord`/`packChunkRuns`/`ChunkRow`/`StorageRecord` 导出（迁移码内使用）。

---

## 八、迁移计划 / TODO

1. **[P0] 流式渲染**：`src/feishu-streaming.ts` 从 `assistant/chunk` 迁到新机制。先方案 B（读 `assistant/message.stream`，一次性渲染）保底；如需逐 token 再上方案 A（`agent/assistant-stream` 或 `follow({assistantStream:true})`）。
2. **[P0] SessionHandle**：`src/harness.ts` 的 `readFrom` → `open(id,'read') + handle.read()`；`list()` 的 `.id` → `.header.id`；确认 `prepare` 是否仍被需要（未用可删）。
3. **[P1] 取值适配**：核对 `list()` 返回结构、`commands` 字段改名是否影响（预期无）。
4. **[P2] 原生文件附件**：`channel.ts`/`feishu-receive-file.ts` 的 `.feishu-inbox` 改走 `ctx.attachments.saveFile` → `{ type:'file' }`；`feishu-send-file.ts` 保留 `sniffImageMime` 判型。图片路径不动。
5. **[P2] 消息投递原生化**：`/steer`、`/queue`、普通/带图消息改走 `sessionController.prompt()`。**✅ 已实现（版本无关）**：文本派发已改走 `prompt()`（`harness.ts` `dispatchPrompt`），保留 whenIdle/running-guard 包装；带图与不可用时回退直连。见 §五。
6. **[验证]**：`npm run typecheck` / `npm run test` / `npm run build` 全绿；实机 `systemctl --user restart dsh` 后 `journalctl --user -u dsh -n 30` 干净启动（无 `error|failed|already registered`）。

> ⚠️ 本插件 `node_modules` 内链接的 DSH 类型为旧版（rc.8 级），**不能**作为 0.1.3 兼容信号的依据；改造后应基于 0.1.3 源码做类型核验。
