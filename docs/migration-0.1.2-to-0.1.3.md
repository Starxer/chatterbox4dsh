# 迁移分析：DSH 0.1.2-alpha.4 → 0.1.3-alpha.1

> **来源**：DSH 远端最新 release `dsh-v0.1.3-alpha.1`（2026-09-04 发布）。本文基于 `dsh-v0.1.2-alpha.4..dsh-v0.1.3-alpha.1`（**336 个 commit**）的分析。
> **创建日期**：2026-09-04
> **基线**：本插件当前在 `dsh-v0.1.2-alpha.4` 下运行/验证。0.1.2-alpha.4 与 0.1.2-alpha.2 之间无 API 破坏（上轮已核），故迁移范围即 alpha.4 → alpha.1。
>
> ⚠️ **注意**：本文档涉及的是 DSH **服务/事件 API 面**与 **插件调用点** 的对应关系，用于指导改造。文中路径均为中性表达（如 `<DSH_HOME>/attachments/v1`、会话工作区 `.feishu-inbox`），不含任何本机私有路径。
>
> ✅ **可信度**：本文全部 API 签名均已对照 **0.1.3 源码**逐条核实（本地 checkout 含 `dsh-v0.1.3-alpha.1` tag，经 `git show dsh-v0.1.3-alpha.1:<path>` 读取，非工作区文件）。涉及 `sessionPersistence`/`SessionHandle` 与 `attachments.saveFile`/`FileAttachmentRef` 两块的签名由源码的准确摘录为准，**不依赖插件 `node_modules` 里链接的旧版（rc.8 级）类型**。

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

> ⚠️ **重要修正（2026-09-08 核对源码后）**：现状卡片**并不是逐 token 流式**——`assistant/chunk` 只做内存累积（`state.reasoning +=` / `state.text +=`），真正的 `sendStepCard` 只在 `assistant/message` 或首个 `tool/call` 边界发**整卡**。因此 **0.1.3 的流式迁移以「方案 B（从 `assistant/message.stream` 一次性重建）」为主**——它贴近现状、近乎零回归；方案 A（订阅 `agent/assistant-stream` 实时帧、逐 delta 渲染）是**今天并不存在**的增量能力，降为**可选**。早期文档（2026-09-06）写的"方案 A 为主 + end 兜底"已作废。

---

## 一、🔴 破坏性变更 1：`assistant/chunk` 流式机制被整体替换

这是本次迁移**影响最大**的一处。

### 现象

插件 `src/feishu-streaming.ts` 通过订阅 `session/event` 读取 `event.type === 'assistant/chunk'`（单个 `{ type: 'reasoning-delta' | 'text-delta', text: string }` 增量），把 `reasoning` 与 `text` 累积进 `SessionStepState`（供 `sendStepCard`/`buildStepCard` 组装 per-step 卡片）。注意：**这只做内存累积，不驱动逐 token 渲染**——真正出卡在 `assistant/message` 或首个 `tool/call` 边界（见"迁移方案"）。

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

**`AssistantStreamRecord`**（`@deepseek-ai/dsh-llm` 的 `assistant-stream.ts`）为批量记录型（无损紧凑表示，不合并 delta 边界）：

```ts
| { type: 'text-chunks';     time0; index; dt: number[]; texts: string[] }
| { type: 'reasoning-chunks'; time0; index; dt: number[]; texts: string[] }
| { type: 'tool-call-chunks'; time0; index; dt: number[]; id: ToolCallId; name?: string; args: string[] }
| { type: 'chunk';            time; chunk: StreamChunk }   // 单条原始 chunk
```

- 用 `expandAssistantStream(stream): readonly TimedStreamChunk[]` 展开成 `{ time, chunk }` 序列，`chunk.type` 可能是 `text-delta`/`reasoning-delta`/`tool-call-delta`。
- 工具调用信息（`id`/`name`/`args` 增量）也在 stream 里，但插件当前从 `tool/call`（`session/event`）读工具调用——**该词在 0.1.3 保留**，故工具块无需改从 stream 重建。

### `session/event` 本身未变

`session/event` 仍是 `(session, event)` 双参、`@mode emit`——插件订阅无需改。**变的只是它能承载的事件词**：不再有 `assistant/chunk`，改为 `assistant/message`（带 `stream`）与 `assistant/attempt`。

### 插件受影响点

- `src/feishu-streaming.ts`：`handleEvent` 的 `else if (event.type === 'assistant/chunk')` 分支（逐 delta 累积 reasoning/text、记 TTFT）。`assistant/message` 分支已存在（读 `message`/`usage`）。
- `src/feishu-toolcalls.ts` / `src/feishu-todos.ts`：订阅 `session/event`，读 `tool/call`、`tool/result`、`todo/write` —— **这些词在 0.1.3 均保留**，无需改。

### 迁移方案（推荐 B 为主 + 可选 A）

> 本小节记录"哪种方案贴近现状体感"的核查结论（2026-09-08，基于源码而非推断）。

**现状体感的真实机制**：插件现在的效果**不是逐 token**。`assistant/chunk` 分支只做**内存累积**（`state.reasoning +=` / `state.text +=`，见 `feishu-streaming.ts` 的 `assistant/chunk` 分支），**不发卡、不更新卡**。真正的卡片发送/更新只在以下**离散边界**发生：

| 触发点 | 动作 |
|---|---|
| `assistant/message` 到达 | `sendStepCard` 发**整张**卡（此时文本已完整） |
| 首个 `tool/call` 到达 | 若尚未发卡 → `sendStepCard`（带此刻已累积的推理+文本+工具块） |
| 后续 `tool/call` / `tool/result` | `updateStepCard` 原地 patch（150ms debounce 合并） |

150ms debounce 合并的是 `tool/result`、后续 `tool/call`、`request/context` 这些事件，**不含 chunk**。所以用户看到的是**一块一块**的卡片（先出推理块、再出回复块、再出工具调用块），在每个事件边界整块组装，**不是逐字符生长**。

**方案 B（低改动，贴近现状）——推荐主选**：只订阅 `session/event` 的 `assistant/message`，从 `message.stream` 一次性重建 text/reasoning 后出卡。

- 调用 `@deepseek-ai/dsh-llm` 的 **`expandAssistantStream(stream: readonly AssistantStreamRecord[]): readonly TimedStreamChunk[]`**，返回 `{ time, chunk }` 序列（`chunk` 就是 `StreamChunk`：`type: 'text-delta'|'reasoning-delta'`），按其类型累积到 `state.text`/`state.reasoning`，`firstTokenTime` 取首个 `TimedStreamChunk.time`。累积逻辑可原样复用。
- `sendStepCard`/`buildStepCard`/工具块（`tool/call`、`tool/result` 分支）**完全不动**——它们不依赖 chunk。
- 0.1.3 `assistant/message` 事件 `data = { turn, step, message, stream, usage?, interrupted? }`。`message` 是组装好的 `AssistantMessage`，`stream` 是 `AssistantStreamRecord[]`。
- **TTFT 退化点**：无实时 delta，`firstTokenTime` 只能从首个 record 的 `time0`（或 `TimedStreamChunk.time`）取，与"实际第一个 token"可能有偏差（完整 record 已压缩为批量记录）。文档标注此为可接受的退化。
- **`interrupted: true` 前缀**：0.1.3 的 `assistant/message` 带此标记时是"turn 被取消、仅交付的 text/reasoning 前缀"，行内工具调用缺失。迁移时需在该分支识别并照常出前缀卡（不当作完整正文）。

**方案 A（保留逐 token 增量——今天并不存在的额外能力）——可选**：订阅 agent-scoped 实时帧。

- host 侧 `ctx.on('agent/assistant-stream', ({ agent, frame }) => ...)` 收 `payload.frame`；`chunk` 帧里取 `frame.chunk`（原始 `StreamChunk`）做 delta 累积；`start` 帧开新 attempt（重置 delta 基线），`end` 帧收尾。或经 `session-controller.follow({ assistantStream: true })` 的返回流收 `{ type:'assistant-stream', frame }`。
- **注意**：agent-scoped、`@mode emit`、进程本地、**无重放**，订阅需在 Agent 开始输出前建立，中途接入会缺起始帧。靠 `end` 帧（`outcome.kind==='committed'`）用 `message.stream` 补齐正文可兜底。
- **权衡**：这是**引入今天不存在**的逐 token 增量，要额外维护实时订阅的接入时机。

**体感一致性结论（2026-09-08 修正）**：

- ✅ **方案 B 与现状近乎一致**：因为现状本就是"事件边界整块组装"，B 只读 `assistant/message` 一次性重建，卡片骨架、工具块、turn 汇总、reasoning/reply/工具调用分块呈现**全部保留**。唯一损失是……几乎没有用户可感知的损失。
- ⚠️ **方案 A 反而是新增能力**：它提供今天没有的逐 token 增量，但需要处理无重放 / 中途接入时机问题，复杂度更高。除非明确要"逐字符生长"的观感，否则不必要。

**推荐实现**：**方案 B 为主**（贴近现状、低回归、实现最简）。方案 A 保留为可选项，若日后确要逐 token 增量再加上（需先评估无重放接入时机）。

---

## 二、🔴 破坏性变更 2：`sessionPersistence` 改为 `SessionHandle` 缝

### 现象

插件在 `src/harness.ts` 多处调用：

- `sessionPersistence.list()`——判存在/列会话，读 `.id`（`needsOnboarding` :673、`listSessions` :791、归档过滤 :500/:1154）。
- `sessionPersistence.readFrom(id, 0)`——读某会话的 header + events（`listSessions` 冷会话 :808-849、`getSessionMeta` :911-968）。

**0.1.3 下 `readFrom()` / `prepare()` 被移除，`list()` 返回结构变化。**

### 根因（DSH 侧 commit）

- `bec6805d6a` `refactor(session-persistence)!: handle-based seam with a lifecycle-owned write path`
- `c58097a826` `feat(session-persistence-jsonl): cross-process write-ownership lease`
- `7acc038beb`（merge #3362）

### 新 API（已对照 0.1.3 源码核实）

```ts
// 服务（packages/session/session-persistence/src/index.ts）
abstract create(header: SessionHeader, options?: ...): Promise<SessionHandle>   // 传入 header 而非 id
abstract open(id: SessionId, access: 'read' | 'write', options?: ...): Promise<SessionHandle>
abstract stat(id: SessionId, options?: ...): Promise<SessionPersistenceSnapshot | undefined>
abstract list(options?: ...): Promise<readonly SessionPersistenceSnapshot[]>
abstract flush(): Promise<void>

// 读路径
const handle = await persistence.open(id, 'read')   // SessionHandle extends AsyncDisposable
handle.read(offset?, length?, options?)             // offset/length 为 plain number，非 branded
await handle.close()                                // 释放（read 无所谓，write 必须）

// 元数据
// SessionPersistenceSnapshot = { header: SessionHeader; revision: SessionPersistenceRevision; eventCount?: number; sizeBytes?: number }
// id = snapshot.header.id（不再是顶层字段）
persistence.stat(id)   // 只取 header/元数据时优先用这个，而非开 handle
```

- `list()` 的 `SessionHeader` 现在挂在 `snapshot.header`，不再直接是列表元素；`.id` → `.header.id`。
- `SessionHandle` 是 **`AsyncDisposable`**（`[Symbol.asyncDispose]` 委托给 `close()`），用后必须 `close()`（`await using` 或 try/finally）。**写句柄不 close 会在进程生命周期内泄漏写所有权**（JSONL 后端持 in-process `writers` map + kernel `flock`，无过期，第二个 `open(id,'write')` 抛 `SessionAlreadyOwnedError`）。本插件**只读会话**，不走写路径，故只需 read 句柄。
- `SessionHandle.read(offset?: number, length?: number, options?)` 返回 `readonly SessionEvent[]`；每个元素是 `{ type, seq, time, data, ignorable? }`（**带 `time` 字段**，不只是 `{seq,type,data}`）；`offset` 即 `seq`，为 plain number（非 `SessionLogOffset` brand）。
- `SessionEventMap[K]` 的 `data` 有强类型（如 `'tool/result': { turn, step, message, error?, meta? }`），插件现有 `{seq,type,data}` 的消费方式兼容（多出的 `time` 无害）。
- 新增错误：`SessionAlreadyExistsError` / `SessionAlreadyOwnedError` / `SessionReadOnlyError` / `SessionOwnershipLostError` / `SessionHandleClosedError` / `SessionPersistenceCorruptionError` / `SessionFormatUnsupportedError`；`SessionPersistenceNotFoundError` 保留。
- 跨进程写所有权用 kernel 仲裁（POSIX `flock` / Win32 命名信号量），**无过期**——一个卡住的 live holder 会一直持有（但进程死亡即释放，崩溃安全）。backend 自会经 `ctx.effect(...)` 关闭打开句柄 + `ctx.on('session/disposed', ...)` 关闭该会话 writer，兜底回收。

### 插件迁移

| 旧 | 新 |
|---|---|
| `readFrom(id, 0)` → `.meta` / `.events` | `open(id,'read')` → `handle.read(0)` → 关句柄；header 从 `handle.header` 或 `stat(id)` 取 |
| `list()` 元素 `.id` | `snapshot.header.id` |
| `prepare(id)` | 本插件不写会话，**不用**（`prepare` 仅存在于内存 `SessionStore`，不在 `sessionPersistence`） |

> 插件为**读会话**以展示 `/session`、`/status`、turn 汇总与 meta。多数只需 `open(id,'read')` + `handle.read(...)`；若读取目的只是"判断是否存在/取 header"，**优先 `stat(id)`/`list()` 而非开 handle**（开句柄要负责 close）。本插件 4 处 `list()` 判存只需 `.header.id` 比较；2 处 `readFrom` 需改为 `open(id,'read')` + `handle.read(0)` + `close()`。

---

## 三、🟡 兼容性变更

### `commands`：`input.images` 移除 → 声明式 `input.attachments?: boolean`

`@deepseek-ai/dsh-commands` 的 `input.images` 字段已被**移除**，替换为声明式的 `CommandInputDescriptor`（见 0.1.3 `packages/interaction/commands/src/types.ts`）：

```ts
export interface CommandInputDescriptor {
  /** Placeholder shown before the user supplies free-form input. */
  readonly hint: string
  /** Whether composer attachments may accompany an invocation. Absent/false = executor rejects. */
  readonly attachments?: boolean
}
// 执行时提交的附件参数类型：
export type CommandSubmitAttachment =
  | ({ readonly type: 'image' } & EncodedImageAttachment)
  | { readonly type: 'file'; readonly receiptId: string }
```

**插件结论**：不受影响。`src/index.ts` 的 `commands.execute(agent, line, [], signal)` 传的是**空数组 `[]`**（作为执行参数/提交附件，而非 `input` 描述符），无论字段叫 `images`、`attachments` 还是 `CommandSubmitAttachment` 都是同一空值，且插件无图片/文件附件命令路径。**无需改动**。

### `admitPromptContent` 从自由函数变 service 方法

`@deepseek-ai/dsh-attachment` 顶层不再导出 `admitPromptContent`，改为 `ctx.attachments.admitPromptContent(...)`。

**插件结论**：不受影响（插件未使用该自由函数，图片走 `saveImage`）。新代码建议用 service 方法。

### `session-controller` Config：`coldBlankProbeMaxBytes` 移除

**插件结论**：不受影响（插件 config 无该字段）。

---

## 四、🟢 新特性：通用文件附件原生缝合（PR #3109）

这是 0.1.3 **最值得接入**的新特性，可替掉插件 `.feishu-inbox` 手工文件路径。

### 新 API（已对照 0.1.3 源码核实）

**`ctx.attachments`（`@deepseek-ai/dsh-attachment`，`packages/attachment/attachment`）** 新增通用文件路径：

```ts
saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef>                  // { data: Uint8Array; name? }
saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef>      // { data: AsyncIterable<Uint8Array>; signal?; name? }
admitEncodedFile(input: EncodedFileAttachment): Promise<FileAttachmentRef>       // { data: base64; name? }
readFileStream(ref: FileAttachmentRef, signal?): AsyncIterable<Uint8Array>
fileHostPath(ref: FileAttachmentRef): string | undefined
admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]>  // 现为 service 方法
```

- **`FileAttachmentRef`**（`packages/attachment/attachment/src/types.ts`）：
  ```ts
  { attachmentId: AttachmentId /* sha256 摘要, opaque */; name: string /* 必填, 净化后的 display name & 叶名 */; bytes: number }
  ```
  ⚠️ **`name` 必填**（不同于图片 ref 的 `name?` 可选），且须是 `fileLeafName(name)` 净化后的叶名——缺名会挂。
- **`saveFileStream` 的 `data` 是 `AsyncIterable<Uint8Array>`（分块），不是同步 `Iterable`**；`readFileStream` 返回 `AsyncIterable<Uint8Array>`（异步生成器）。
- **文件内容块**（`@deepseek-ai/dsh-llm`）：`{ type: 'file', attachment: FileAttachmentRef }`（`FileBlock`，仅 user content）。**没有现成的"attach file"助手**——需自己构造该块：`createUserMessage({ content: [{ type:'file', attachment }], source })`。图片块 `{ type:'image', attachment: ImageAttachmentRef }` 不变。
- **`fileHostPath(ref)`** 返回 `<DSH_HOME>/attachments/v1/files/<sha256[:2]>/<sha256>/<name>`（本地实现 `storedFilePath`）；图片仍在 `objects/`，两棵独立树。
- **文件投影（`packages/llm/llm/src/content.ts`）**：`contentHasFile` / `fileHandleText` / `projectFilesToText`。文件块**永不 raw 上传给 provider**，`projectFilesToText` 在每次请求组装时把每个文件出现（含 tool-result 内嵌）替换为 handle 文本 `[File "<name>" (<bytes> bytes, sha256:…): verbatim read-only copy saved at "<path>". Read that path...]`，模型路由读到的是 handle 文本（路径来自 `fileHostPath`）；因此 agent 需经路径而非字节读文件。
- **⚠️ 类型不匹配说明**：`admitPromptContent` 的输入 `AttachmentAdmissionPart` 里 `image` 部分是 **`{ mediaType, data: base64 }`**，处理时经 `admitEncodedImages` 重新 admission 成 `ImageAttachmentRef`；`file` 部分是 durable `FileAttachmentRef` 透传。这与插件已用 `saveImage` 预存的 `ImageAttachmentRef` **不兼容**（见 §五）。

### 对插件的意义

| 插件现有实现 | 0.1.3 原生替代 |
|---|---|
| `channel.ts` `admitFilesForMessage`（:190-216）下载飞书文件 → 写会话工作区 `.feishu-inbox/` + 注入 `[文件: name → path]` 文本 | `ctx.attachments.saveFile({ data, name })` → `FileAttachmentRef`，在 user message content 里用 `{ type:'file', attachment }` 块 |
| `feishu-receive-file.ts`（:101-179）兜底下载 → `.feishu-inbox` | 同上，返回 path 时用 `fileHostPath(ref)` |
| `feishu-send-file.ts` 发文件（>10MB / 非图走 `{ file }`） | **维持不变**——它是输出方向，读 agent 写的工作区文件字节，不依赖 `FileAttachmentRef`；保留 `sniffImageMime` 判型 |

**迁移要点（`channel.ts`）**：
- `AttachmentLike`（:42）从 `Pick<AttachmentStore, 'saveImage' | 'imageLimits'>` 扩为含 `saveFile`。
- `admitFilesForMessage` 返回结构从 `{ path, fileName }[]` 改为 `FileAttachmentRef[]`（或附 `hostPath`）。
- 注入路径从"拼接 `[文件: ...]` 文本到 content"改为"把 `{ type:'file', attachment }` 块 push 进 content 数组"（`inboundMessage.content` 需支持 content block——现为文本或 `[{...}]`，需确认 `InboundMessage.content` 的 shape 是否兼容块数组）。
- `inboundMessage.content` 的块数组形态需与 `bridge.reply` → `createUserMessage({ content })` 对齐（`createUserMessage` 接受 `ContentBlock[]`，`file` 块合法）。

**注意**：
- 图片路径（`saveImage`/`saveImages`/`imageLimits`）**完全未变**，`sniffImageMime` + `IMAGE_TYPE_MISMATCH` 纪律照常，不并入文件改造。
- **`@deepseek-ai/dsh-client-file-upload` 并非纯客户端**——它是 host+client 服务（host 侧 `ctx.fileUploads` 注册 `/api/session/uploadFileBinary` 路由，内部复用 `attachments.admitEncodedFile`/`saveFileStream`）。宿主插件直接调 `ctx.attachments` 即可获得同样的 durable ref，**不需要它**；它是给浏览器侧上传暂存回执的入口（`upload` → `receiptId` → `bindPrompt`）。
- **行为变化（需实测确认）**：改用 `saveFile` 后，agent 侧不再通过 `.feishu-inbox` 相对路径读文件，而是从模型收到的 handle 文本里的 `fileHostPath` 绝对路径读。需在 0.1.3 实测验证 agent 会去读该路径、且路径在 agent 工具沙箱内可读（DSH 附件库路径通常可达）。

---

## 五、新特性：`/steer`、`/queue`、消息投递走 `sessionController.prompt()`

0.1.3 的 `sessionController.prompt()`（`@deepseek-ai/dsh-api-session-controller`）是原生统一的 Agent 消息投递入口，内含图片 admission 与模态校验：

```ts
// host 服务端（packages/api/session-controller/src/index.ts:329 与 commands.ts:293）
prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>

export interface SessionPromptRequest {
  readonly requestId: SessionRequestId
  readonly sessionId: SessionId
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}
export interface SessionPromptValue { readonly accepted: true }

// Browser-submitted prompt content（types.ts:75）—— Host 把图片字节提升为 durable ref
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string }  // base64 字节
  | { readonly type: 'file'; readonly receiptId: Branded<'file-upload-receipt-id'> }  // 0.1.3 新增：走 fileUploads 暂存回执
```

- `mode: 'queue'` → `agent.followup`；`mode: 'steer'` → `agent.steer`。
- 内置 `routeServed` + `session/model-unavailable` 校验、图片内容 admission（`admitPromptContent`）+ 模型图片模态校验、`requestId`/`clientTimeZone` 溯源、`hasPromptRequest(agent, requestId)` 幂等（同 requestId 重复提交直接 `{accepted:true}`）。
- 0.1.3 新增 `file` receipt 路径（`fileUploads.bindPrompt(agent, admission.receiptIds, requestId)`），走浏览器侧上传暂存；与宿主插件"下载飞书字节→saveFile"是两条独立路径。
- 与 WebUI 共享同一 queued/steering/context placement 语义。

**对插件的意义**：`/steer`、`/queue`、普通消息、带图消息四条路径当前由 `src/harness.ts` 手工维护（`chatToBusyMode` + `agent.steer/followup/whenIdle`）。可用 `prompt()` 归一，去掉自建状态机。注：`prompt()` 不提供"排队后等 idle 再回"的返回值语义，插件若需 `whenIdle` 等待仍需保留为 wrapper。

> **实现状态（2026-09 已实现并实测）**：`/steer`、`/queue` 的**派发**已改走 `sessionController.prompt()`（`prompt({ mode: 'steer'|'queue', ... })`），但**保留**插件原有的 running-guard、`whenIdle` 等待、代际/`/stop` 丢弃（`TurnDroppedError`）与 `summarizeTurn` 包装。规则：
> - **文本内容**（`/steer`、`/queue` 均为纯文本）→ 经 `sessionController.prompt()` 派发（获得 `routeServed` 路由校验 + `requestId` 溯源）。
> - **带图内容**（普通带图消息）→ **仍走直连 `agent.steer/followup`**，这是**类型必然而非审慎**：插件已用 `attachments.saveImage` 预存并拿 durable `ImageAttachmentRef` 喂给 agent，而 `prompt()` 的 `PromptContentPart` 里 image 是 `{ mediaType, data: base64 }`——**`ImageAttachmentRef` 不满足 `PromptContentPart`**，即使强塞也会被 `admitPromptContent` 当作 base64 重新 admission（重复 admission、路径未验证）。故带图/带文件一律走直连。
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
| `tool/call`、`tool/result`、`todo/write` 事件形状 | 保留（`tool/result` 带 `meta` 照常） |
| `assistant/message` | **保留但形状变化**（`data` 增 `stream`；用于读取 `usage` 的分支不变，文本重建见 §1） |
| `assistant/chunk` | **已移除**（改为 `assistant/message.stream` + `assistant/attempt`，见 §1） |
| `user-questions/request`、`approval/request` | 仍是 agent-scoped 瀑布事件，`{ prepend: true }` 有效 |
| `sessionController.selectModel/fork/rename/create` | 签名不变 |
| `agentDefaultModel.currentSelection/saveSelection` | 不变 |
| `permissionPresets.set/current` | 不变 |
| `sandboxPolicy.resolve` | 不变 |
| `Agent.steer/followup/whenIdle/cancel` | 不变 |
| `commands.register/list/execute` | 不变（`CommandInputDescriptor` 字段变更见 §三） |
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
| `@deepseek-ai/dsh-client-file-upload` | **host+client** 文件上传服务：host 侧 `ctx.fileUploads` 注册 `/api/session/uploadFileBinary` 路由 + `upload/uploadStream/resolve/bindPrompt/retirePrompt`，内部复用 `attachments.admitEncodedFile`/`saveFileStream`；**拒绝 subagent 会话**（`agent.session.header.origin === 'subagent'` → `subagent/attachment-invalid`）。宿主插件直接调 `attachments` 可得同样 durable ref，**不需要它** |
| `@deepseek-ai/dsh-http-proxy` | 将 `HTTP_PROXY`/`HTTPS_PROXY` 安装为 undici 全局 dispatcher，使 Node `fetch` 被代理 |
| `@deepseek-ai/dsh-session-format`（+ `-catalog`/`-v0-to-v1`/`-v1-to-v2`） | 纯 session 格式迁移机制（整件 v0/v1→v2，自动迁移） |
| `@deepseek-ai/dsh-session-format-v1-to-v2` | 把旧顶层 `assistant/chunk` 内嵌进 `assistant/message.stream` |

**移除**：无（`session-persistence-sqlite` 已于更早版本移除为 JSONL-only；本版本段无整包移除）。`@deepseek-ai/dsh-session` 移除了 `decodeStorageRecord`/`packChunkRuns`/`ChunkRow`/`StorageRecord` 导出（迁移码内使用）。

---

## 八、迁移计划 / TODO

> 每项给出「受影响文件·函数/行」+「迁移写法」+「本次（alpha.4）可做与否」。**除第 5 项（已完成）外，其余均依赖 0.1.3 运行时，当前 alpha.4 无法实测**——需先升级 DSH 到 0.1.3 再动工。

1. **[P0] 流式渲染**——`src/feishu-streaming.ts`。
   **方案 B 为主（贴近现状，近乎零回归）**：删除 `assistant/chunk` 分支（仅需累积逻辑迁走）；在 `assistant/message` 分支（:362-419）用 `expandAssistantStream(event.data.stream)` 展开，按 `chunk.type` 累积到 `state.text`/`state.reasoning`，`firstTokenTime` 取首个 `TimedStreamChunk.time`；识别 `interrupted: true` 前缀。`sendStepCard`/`buildStepCard`/工具块分支**不动**。**可选项方案 A**（订阅 `agent/assistant-stream` 逐 delta 实时渲染）——今天并不存在的能力，除非明确要逐 token 观感否则不做。
2. **[P0] SessionHandle**——`src/harness.ts`。
   - `list()` 的 `.id` → `.header.id`（`needsOnboarding` :673、`listSessions` :791、归档过滤 :500/:1154），并确认 `agentPresets.list()` 相关的 `persisted` 判断继续成立。
   - `readFrom(id, 0)` → `open(id,'read')` + `handle.read(0)`（`listSessions` 冷会话 :808-849、`getSessionMeta` :911-968），**用后 `close()`**（`await using` 或 try/finally）；header 从 `handle.header` 取。
   - **只读优先 `stat(id)`/`list()` 取 header，不开 handle**；`prepare` 本插件不用，忽略。
   - `readSessionEvents`（:305-316）走 live agent 的 `session.events`/`snapshotEvents`，**不涉 `sessionPersistence`，无需改**。
3. **[P1] 取值适配**——核对确认：`list()` 返回结构（第 2 项覆盖）；`commands` 的 `input.images`→`CommandInputDescriptor.attachments` —— 插件传空数组 `[]`，**预期零改动**（§三）。
4. **[P2] 原生文件附件**——`src/channel.ts`（`admitFilesForMessage` :190-216、`AttachmentLike` :42）、`src/feishu-receive-file.ts`、`src/feishu-send-file.ts`。
   - 入站文件下载 → `ctx.attachments.saveFile({ data, name })` 返回 `FileAttachmentRef` → 在 user message content push `{ type:'file', attachment }` 块（替代写 `.feishu-inbox` + `[文件: …]` 文本）；`feishu-receive-file.ts` 返回 path 用 `fileHostPath(ref)`。
   - `feishu-send-file.ts` **不动**（输出方向，不依赖 `FileAttachmentRef`）；图片路径（`saveImage`/`imageLimits`）**不动**。
   - **需实测**：agent 从 handle 文本读 `fileHostPath` 绝对路径、且路径在 agent 工具沙箱内可读。
   - 不需要 `@deepseek-ai/dsh-client-file-upload`（host 插件直接调 `attachments` 可得同样 durable ref）。
5. **[P2] 消息投递原生化**——`/steer`、`/queue`。**✅ 已实现（版本无关）**：文本派发已走 `prompt()`（`harness.ts` `dispatchPrompt`），保留 whenIdle/running-guard 包装；带图/带文件与不可用时回退直连（类型必然，见 §五）。**升级 0.1.3 后无需再改**。
6. **[验证]**：`npm run typecheck` / `npm run test` / `npm run build` 全绿；实机 `systemctl --user restart dsh` 后 `journalctl --user -u dsh -n 30` 干净启动（无 `error|failed|already registered`）。

> ⚠️ 本插件 `node_modules` 内链接的 DSH 类型为旧版（rc.8 级），**不能**作为 0.1.3 兼容信号的依据；改造后应基于 0.1.3 源码做类型核验（本文 §二/§四 的签名已按 0.1.3 源码核实）。
