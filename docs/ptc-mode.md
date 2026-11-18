# PTC 模式适配 / PTC mode adaptation

> 状态：**已审计**（2026-11-17）；审计发现的后台任务面板与产出文件两处漏记 **已修复**（同一批次），非 compact 档的步骤卡仍是待设计的缺口。本文记录插件哪些事实来自工具事件、PTC 下如何变化、以及哪里已经/尚未对齐，供以后升级 DSH 或改事件消费逻辑时对照。
>
> Status: **audited** (2026-11-17). The background-job panel and produced-file gaps found by the audit are **fixed** in the same batch; the non-compact step-card gap is still a design decision. This page lists which plugin facts come from tool events, what PTC changes about them, and what is (not yet) aligned.

## 1. PTC 改变了什么

PTC 预设（`packages/bundle/web-app/presets/ptc.patch.yml`）为 agent 挂载 `@deepseek-ai/dsh-tool-executor-ptc`：**模型只看到 `run_code` 一个工具**，其余工具由生成的 SDK 在程序内调用，宿主把它们记为子调用事件：

| 事件 | 携带 |
|---|---|
| `tool/ptc-dispatch-start` | `rootCallId`、`parentCallId`、`subCallId`、`name`、`arguments`（JSON 规范化后的对象） |
| `tool/ptc-dispatch` | 上述全部 + `isError`、`content`（与 `tool/result` 同词法的完整结果块）、可选 `meta` / `error` |

因此判据是：**任何依赖 `tool/call` / `tool/result` 推导的插件事实，都必须再从 `tool/ptc-dispatch-*` 推导一遍**。`run_code` 的 `content` 只是程序输出，不等于内层工具的结果。

## 2. 事实源对照

| 插件能力 | 事实来源 | PTC 下 |
|---|---|---|
| compact 回合卡的内层工具行（`↳` + 文件/命令/URL/搜索词） | `tool/ptc-dispatch-*` | ✅ 2026-10-28 起已适配 |
| 父行一行描述（`run_code` 的必填 `description`） | `tool/call` 参数 | ✅ 2026-11-18 起在「描述在前」的行样式里只印一次（派生摘要与描述同句，见 §3） |
| 子代理名册 / 面板 | 全局 `subagent/start`、`subagent/end` + 父会话 `subagent/catalog` | ✅ PTC 内层调用走同一工具管线，catalog 由子代理管理器 append 到父会话 |
| Agent Teams 看板 | `team/member`、`team/task` + lead 会话的 `agentTeam` 投影 | ✅ |
| todo 卡 | 会话事件 `todo/write` | ✅ tool body 自己 append |
| `present` 交付物 | 会话事件 `deliverables/presented` | ✅ tool body 自己 append |
| 问答卡 / 审批卡 | `user-questions/request`、`approval/request` 服务事件 | ✅ 内层调用同样走审批/问答管线 |
| `feishu_send_file` / `feishu_receive_file` / `feishu_doc_*` | tool body | ✅ PTC 调用同一份实现 |
| 卡片媒体内联、卡片写入、话题、外部回合镜像 | 模型文本 / 卡片事件 | ✅ 与 PTC 无关 |
| **后台任务面板** | 外层 `tool/result` → `detachedJobIdFromToolResult()`（工具名白名单） | ❌ 已修复：PTC 内层 `bash` 的后台公告只出现在 `tool/ptc-dispatch.content`，外层是 `run_code` |
| **产出文件（produced）** | `tool/call` 参数 + `tool/result` 成败 | ❌ 已修复：内层 `write`/`edit` 不经过外层事件 |
| **非 compact 档的步骤卡** | `state.toolCalls`（仅 `tool/call`） | ⚠️ 待设计：`turnCard` 只对 `compact` 开启，`standard`/`detailed`/`verbose` 下 PTC 子调用整段被忽略，步骤卡只剩 `run_code` 一行 |
| **`/status` 的工具次数** | `harness.deriveSessionStats()` 数 `tool/call` | ❌ 已修复：一个 PTC 回合的内层调用原先全不计 |
| PTC 内层结果文本（`showToolResults`） | `tool/ptc-dispatch.content` | ⚠️ 未展示；compact 子行只有状态，detailed 连子行都没有（与上一行一并设计） |
| `src/feishu-toolcalls.ts` | 独立旧模块，未被 `index.ts` 启动 | ⚠️ 疑似死代码，与 PTC 无关，待确认清理或保留 |

## 3. 已修复（2026-11-17 / 2026-11-18）

- **后台任务面板**：`tool/ptc-dispatch` 结算时把 `content` 文本按内层 `name` 交给 `noteDetachedJob`，复用 job 镜像原有的 registry 核对、owner 校验与 `confirmed` 去重 —— PTC 程序里 `bash run_in_background`（以及前台超时转后台的通知行）产生的 job 现在会出现在面板里。
- **产出文件**：同一结算点用内层 `name` + `arguments` + `isError` 走 `pendingProducedCall()` → `settleProducedCall()`，结果推入 `turnStats.produced`。这让 Turn Complete 的「本轮产出」、`produceCard = delivery` 的自动交付、外部回合同步都恢复。
- **`/status` 工具次数**：`deriveSessionStats()` 把 `tool/ptc-dispatch` 计为一次工具调用。
- **compact 工具行把 `run_code` 描述印两遍**：`run_code` 的派生「摘要」用的是它必填的 `description`（程序代码没法缩成文件名/程序名），而 `compactToolRow = tool-description` 又把同一句描述放在工具名前 ⇒ 行读成 `✅ <描述> · \`run_code\` · <描述> · 1.4s`。渲染时只在「显示描述」的样式里丢掉与描述逐字相同的派生项：`tool` 样式仍保留派生摘要（那时它是整行唯一的信息），`description` 样式不变。

测试覆盖：PTC 子调用触发 job 通知、PTC 内层写文件计入 produced（成功/失败两例）、`getSessionMeta` 统计内层调用、compact 工具行三种样式下 `run_code` 描述的重复判定（`tests/feishu-progress.spec.ts`）。

## 4. 待设计 / 待确认

- **非 compact 档步骤卡**：两种形状可选 —— 把子调用作为缩进行挂进 `state.toolCalls`（类似 compact 的 `↳` 子行），或按 `tools = summary` 输出一行 `run_code › name, name, …`。前者信息完整、更接近 Web UI 轨迹；后者更紧凑。选定后再改，避免先改外观再返工。
- **PTC 内层结果文本**：`showToolResults` 打开时是否在子行/步骤卡展示 `content` 摘要（含失败的 `error`）。
- **`feishu-toolcalls.ts`**：确认用途后清理，或作为未来工具卡入口保留。

## 5. 排查 / 复查

```sh
# PTC 子调用事件的两个处理点（compact 行 + 新增的 job/produced 派生）
grep -n "ptc-dispatch" src/feishu-streaming.ts src/feishu-progress.ts

# job 面板的判定入口（白名单按工具名匹配）
grep -n "DETACHED_JOB_SENTENCES\|detachedJobIdFromToolResult" src/feishu-jobs.ts

# 产出文件的工具白名单
grep -n "PRODUCED_FILE_TOOLS" src/produced-files.ts
```

升级 DSH 后如果 PTC 事件的字段名或 `content` 词法变化，先核对本文第 1 节，再跑 `tests/feishu-streaming.spec.ts` 里的 PTC 用例。
