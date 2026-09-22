# 升级方案：DSH 0.1.6-alpha.2 → 0.1.7-alpha.1

> 评估与执行日：2026-09-22。对比 `dsh-v0.1.6-alpha.2...dsh-v0.1.7-alpha.1`：**1299 commits**。
> 本文档是**可公开**的版本；本机部署细节、取证日志与逐项实测留在本地笔记，不随仓库发布。
> 前置阅读：关键坑 13（preset 重校）/ 14（延迟重启）/ 17（依赖范围）/ 28（同模块双实例）/ **32（切 tag 清产物）** / **33（重建会话时挂哪个 preset）**。
> 上一跳：[`docs/migration-0.1.6-alpha.1-to-alpha.2.md`](./migration-0.1.6-alpha.1-to-alpha.2.md)。

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 插件运行时代码 | **4 处必改**：设置服务换代（A1）、preset 包改名（A2）、`tool/result` 拍平（C1）、`locale` 跟随退化（C4）；`archiveSession` 语义变化（C2）按设计只留注释 |
| 依赖范围 | **必须改**（关键坑 17）：`@deepseek-ai/dsh-*` `^0.1.6-alpha.1` → `^0.1.7-alpha.1`；`schemastery` → `^3.18.3`（新增 `.volatile()`）；`cordis` → `^4.0.3` |
| 会话控制 / 流式 / 工具 / 附件 / 客户端 UI | **未被破坏**（逐项核对见 §1.3） |
| 会话日志 | 格式升到 **V4**，但**不重写已存代次**；被继续写入的会话产生 V4 后继文件，V3 原件保留 |
| 部署侧数据 | **1 项必搬**（legacy `settings.yaml` 的插件段，删一行即由官方 importer 导入）、**1 项确认等价**（默认 preset 回落）、**1 项处置**（目录型 preset 在新 registry 不再被发现 → 不迁移、直接删除） |
| 上游修复红利 | 压缩死区（阈值改为 `min(W × ratio, W − O − headroom)`）与 `turn/end` 被静默拒绝导致「turn 永远开着」两条链**已修** |

**一句话**：插件侧真正的破坏只有「设置服务换血」一处（改动面大但机械），其余是几处语义退化；风险集中在上游**改名/删除的包**与**跨 tag 的残留构建产物**上——后者已让本仓库的升级**栽过两次**，见 §3.2。

---

## 1. 影响评估

### 1.1 硬破坏（不改则 `apply()` 抛错）

**A1 `settings` 服务换血 → `SettingsForms`**

| 0.1.6 | 0.1.7 |
|---|---|
| `settings.register(ns, schema, {base, applies}) → SettingsScope<T>`，scope 有 `.get/.watch/.update/.replace` | **`register` / `get` / scope 全部删除**；服务只剩 `configure / describe / update / replace / mutate / prepareDocument / documentPath` |
| 读配置经 scope | 直接读 `apply(ctx, config)` 收到的 **live Config**：`config.<field>.get()` |

- **`.volatile()` 是硬要求**：写入有三道门 —— entry 不存在抛 `No configurable plugin entry`；entry 无 volatile 字段抛 `has no volatile fields`；写入路径非 volatile 抛 `Config field "…" is not volatile`。`describe()` 也只投影 volatile 字段。**不声明 `.volatile()` 的插件，设置页会空白、所有写配置的路径全失败。**
- `ns` 不再是插件自选的字符串，而是 **profile 行 id**（`describe()` 的 `ns` 取自 `entry.options.id`）。**不要依赖"碰巧同名"**，应从自身 fiber 反查。
- `scope.watch(cb)` → **`ctx.on('loader/volatile-update', cb)`**（值提交进引用后向该配置所属 fiber 发这个本地事件）。
- `mutate/describe/documentPath` 的签名未变，但只有在 `.volatile()` 补齐后才不抛错。
- 若插件自带设置页，按官方约定 `settings.configure({ auto: false }, ctx.fiber)` 关掉自动生成的页面。
- 语义提升：volatile 字段的写入**进运行中的引用、不重挂插件**，因此「改一个开关」不再需要重连/重启（替代了此前自己实现的「保存后重连」）。

> `@deepseek-ai/schemastery` 必须 `^3.18.3`：3.18.2 没有 `volatile`。

**A2 preset 包改名**

- `@deepseek-ai/dsh-agent-presets` **整包删除** → `@deepseek-ai/dsh-agent-preset-registry`（另有新包 `@deepseek-ai/dsh-agent-preset`、`@deepseek-ai/dsh-persona`）。
- 服务名 `agentPresets` 与 `list/resolve/mount/defaultId` **全都不变** → 插件逻辑零改动，只需改 import 与 `peerDependencies`。
- 按坑 17，`@deepseek-ai/dsh-*` 范围整体上跳：预发布 comparator 只在同一 `major.minor.patch` tuple 内生效，`^0.1.6-alpha.1` **永远不满足** `0.1.7-alpha.1`。

### 1.2 语义退化（能跑，但结果不对）

| # | 现象 | 改法 |
|---|---|---|
| **C1** | **`tool/result` 消息被拍平**：0.1.6 是 `{role:'user', content:[ToolResultBlock]}`，0.1.7 是 `{role:'tool', toolCallId, isError?, content}`。仍按旧形态读 `content[0].content` / `content[0].isError` → 文本靠兜底侥幸显示，但**失败会被渲染成成功** | 读 message 自身的 `content` / `isError`；判定 `isError = event.data?.error !== undefined \|\| event.data?.message?.isError === true`。关联没断：`ToolMessageSource.callId` 两版都在 |
| **C2** | **`archiveSession(id)` 拒绝运行中的会话**：新增 `options.stopActivity`，未传且会话仍有活动（turn / subagent / job / schedule）时抛 `WorkspaceActiveSessionError`；归档还会顺手清 pin | 传 `{ stopActivity: true }`，或接住该错误并把 `activity[].kind` 回显到卡片。本插件**刻意不传**——WebUI 在停掉一个 turn 之前会先征求确认，而这里的失败已被既有 `try/catch` 渲染成一张报错卡，不会静默杀掉正在跑的 turn；更友好的确认卡留作后续 |
| **C3** | `snapshotEvents` / `eventAt` / `ownEvents` 打了 `@deprecated`（仍可用） | 后续迁 `sessionProjections` / `projections()`（与关键坑 8 同源：不要无参全量拉历史） |
| **C4** | `settings.get('locale')` 抛 TypeError（被本地 try/catch 吞）→ `locale:'auto'` **不再跟随 DSH 语言** | 随 A1 改成 `settings.describe({redactSecrets:true}).find(r => r.ns === 'locale')?.value?.preference`。注意 `describe()` 会重建表单并读 profile 目录，**不能进热路径**（本插件加了 1s TTL 缓存 + 写入即失效） |
| **C5** | `sessionController.prompt()` 的 content 契约换了（image 走 base64 `data`、file 走 `{type:'file', receiptId}`，**不再收 durable attachment ref**） | 本插件本就有 `return false` 回落到 `agent.steer/followup` —— **必须保留这条绕行，不要"顺手修好"** |

### 1.3 已核「无影响」（一行都不用改）

`sessionController`（方法名逐个同名，`SessionCreate/SelectModel/Prompt` 的请求/返回结构逐字段相同）· `dsh-agent`（`cancel`/`whenIdle`/`inbox`）· `dsh-llm` 流式（`expandAssistantStream`/`isTokenDelta` 行号未动）与模型目录（`LlmProviderInfo`/`LlmModelInfo` diff 为空）· `agentDefaultModel`（`currentSelection`/`saveSelection`）· `defineTool`（签名 diff 为空）· `attachment`（入站附件链路 + 新的「声明载体」规则都认 `user/message.data.content`）· `commands`/`credentials`/`directory-picker`/`user-questions`/`user-approval`（只改版本号）· 客户端 `Button`/`Input`/`Switch` 与 `settings.section`/`settings.action` slot 契约 · bundle/加载契约 · **会话日志 V4**（插件只走 `sessionPersistence.open/readFrom`，不解析 JSONL；读的十余种事件类型新版全在）。

### 1.4 升级后必须保持的部署态

| 项 | 原因 |
|---|---|
| `session-log-deepseek` 保持 `enabled: false` | 否则长会话首个请求会上传整段未压缩日志 → 413 且永久不可用（见关键坑与上一跳文档 §2 P0-5） |
| **不要**为了「拿回 reasoning token 数」去设 `llm-deepseek.protocol` | 0.1.7 **已整包移除 `protocol` 与 `protocols/chat-completions/`**，该选项已不存在；`usage.reasoningTokens` 从此没有获取路径（WebUI 的 think 格同样消失） |
| 入站附件继续走「声明式内容块」 | 不要改成往自定义事件里塞附件 |

---

## 2. 升级前置项（数据迁移）

### B1 legacy `settings.yaml` 的插件段：删掉已删除字段那一行

0.1.7 的 importer **先把 `settings.yaml` 改名成 `settings.yaml.imported`**，再逐段 `update()`。段里只要还有**已不在 `ConfigSchema` 里的字段**，`validatePaths` 就会抛错并**整段拒绝**——而此时旧文件已经改完名，值只剩在 `.imported` 里。

⇒ 做法：停服窗口内把插件段里那个**已被移除的字段行删掉**（行级删除 + 同目录临时文件 + `os.replace` 原子替换，权限位原样保留，其余字节不动）。删掉后官方 importer 就能把整段正常导入 profile 行。

> 要点：这是**文本/结构级**操作，不涉及凭据（`appSecret` 走凭据服务 + `appSecretRef`，不在 `settings.yaml` 里）。

### B2 默认 preset：先确认是否真的偏离

`agent-presets:` 段映射的 entry id 在新版**已不存在** → 用户选的默认 preset 会**静默回落**到 bundle 默认。若原值就是 bundle 默认（本仓库部署即如此，`standard`），**无动作**；只有偏离时才需要在新 registry 行上写 `selectedDefault`。

### B3 目录型 preset 在 0.1.7 不再被发现（**处置：不迁移，直接删除**）

新 registry **既不扫目录也不接受 preset 路径**（`roots` / `includeShippedRoot` / `includeUserRoot` 三个字段全删）。因此「放在用户 preset 目录里」的自建 preset **不再出现在 `agentPresets.list()`**。

本部署的结论是**不再保留这个 preset、也不做迁移**：把整个用户 preset 目录移出即可。删除前的两道复核 —— ① **没有会话**记录过它（按会话 header 的 `agentPreset` 与 `agent-preset/selected` 事件精确解析，而不是全文 grep：正文里出现 `persistent-bash`、"state is persistent across command calls" 之类文本会造成大量假阳性）；② 删除前后组合配置**逐字节一致**，说明运行中的组合没有引用它，**因此不需要重启**。

> **⚠️ 别混淆**：DSH 随附的 `minimal` preset **自己也用持久 shell**（`persistent-shell` 组 + `tool-bash-persistent`）。那是上游组合、不在用户 preset 目录里，不受本项处置影响；若想完全不要"持久 shell"的 preset，需要在 profile patch 里禁用 `preset-minimal`，那是另一件事。

**如果将来要恢复/新建同类 preset**，正规做法是声明式 preset 行（`@deepseek-ai/dsh-agent-preset`：`id` 必填 + `name`/`description`/`order`/`plugins`），两条硬约束：

1. 若原文件含 `!!js` 标签，**必须文本级搬运**——用 YAML 解析器 round-trip 会把表达式销毁（该包声明了 `static readonly [EntryGroup.key] = true`，即"保留子表达式直到各自插件激活"，说明表达式是预期支持的）；
2. 服务行若在带 `isolate` 的组里，**不要丢 `isolate`**，否则组合会发布到 root realm（关键坑 9/28 的领域）。

> 这也是为什么本项当初被推迟到升级后处理：正确形态要用**运行中的** schema 核对，盲改一个大 YAML 风险不成比例。最终的处置比迁移更简单——不需要它了。

---

## 3. 升级步骤

### 3.1 顺序（含通用化命令）

```sh
# 1) 停服 + 备份（settings.yaml / profile patch / profile package.json /
#    凭据 / 插件状态映射 / 会话日志整目录）
systemctl --user stop dsh
systemctl --user show -p MainPID --value dsh     # 期望 0

# 2) 数据迁移 B1（删掉插件段里已删除的那一行）

# 3) 切 tag + 清产物 + 完整重建
cd <dsh checkout>
pnpm run clean            # checkout 前
git checkout dsh-v0.1.7-alpha.1
pnpm run clean            # checkout 后
for d in packages/*/* apps/* vendor/*; do
  [ -d "$d" ] && [ ! -f "$d/package.json" ] && echo "RESIDUE: $d"
done
pnpm install
pnpm run build                                 # 完整 build，不是 build:native-system
node apps/cli/lib/bin.js --version             # 期望 0.1.7-alpha.1；失败则【不要启动服务】

# 4) 插件侧：按 A1/A2/C1/C4 改代码 → npm ci && npm run build && npm run typecheck && npm test
# 5) 启动 + 验证（§6）
```

> 升级脚本必须经 `systemd-run --user --collect` 在**独立 cgroup** 里跑（关键坑 14：`setsid` 不脱离 cgroup，会被 `systemctl stop dsh` 一起杀掉）。脚本应内置「build 失败 → 自动回滚到源 tag 并重建启动」，这样最坏情况是回到升级前的版本，而不是留下一个起不来的服务。

### 3.2 ⚠️ 两次 build 失败的根因与守卫（**关键坑 32**）

本仓库的升级**在同一个根因上栽过两次**（上一跳 0.1.6-alpha.2、本次 0.1.7-alpha.1）。两次的症状都是构建报 `Cannot find entry`：

1. `git checkout <tag>` **不会删除未跟踪产物**。
2. 目标 tag **改名或删除**某个包时（0.1.7 把 `packages/preset/agent-presets` 改名成 `agent-preset-registry`），旧包目录**还在**——里面剩 `lib/` 与 `node_modules/`，但 `package.json` 已随 checkout 消失。
3. 构建工具因此把该目录当成工作区成员，**包名回落成根包名** → 找不到入口。

**为什么第一次的"修法"没修住**：当时用的是手写 `find packages apps -maxdepth 3 -type d \( -name lib -o -name dist \) -exec rm -rf {} +`，它只能清「**仍然存在**的包」下面的产物，对「**包目录本身已被删除**」这一类完全无效——修的是**症状**，不是**成因**。

**正确做法：调用仓库自带的清理入口**（`pnpm run clean`），checkout **前后各一次**，再加一道覆盖 `apps/*`、`vendor/*` 的残留断言（清理器只扫 `packages/*/*`）。该清理器知道哪些是生成物，**遇到未知文件会整体拒绝**而不是猜着删。另：**构建失败时不要启动服务**——上一跳正是在构建失败后仍启动了半成品树，才把问题从"构建失败"扩大成"会话彻底不可用"。

### 3.3 「插件先行」这个顺序的固有风险（本次的教训）

本次按使用者的要求改成**先更新插件代码、再升级 DSH**。由于插件是 `link:` 挂载、且 `lib/index.js` **只在进程启动时读一次**（不热加载），这段窗口内运行中的**旧版宿主**一旦重启就会加载**新版插件代码** → 报 `settings.configure is not a function`（本次确实发生了一次）。

⇒ 结论：**「插件先行」不是免费的**。要么把窗口压到最短并明确禁止期间重启服务，要么改成「先宿主、后插件」（但那会留下一段"插件太旧"的窗口）。两者的取舍应显式记录，而不是靠运气。

---

## 4. 插件侧改动清单

| 文件 | 改了什么 |
|---|---|
| `src/config.ts` | 每个可编辑字段加 `.volatile()`；`Config` 字段类型改 `Volatile<T>`；新增 `readField()`（鸭子类型判 `.get()`，同时兼容 volatile 引用与普通值）与 `resolveSettingsConfig()`；数组字段拷贝出来 |
| `src/index.ts` | 删 `settings.register(...)` / `settingsScope`；配置改读 `apply()` 收到的 live Config；`ns` 改为**从自身 fiber 反查**（`ctx.fiber.entry?.options.id`）；`scope.watch` → `ctx.on('loader/volatile-update')`；`settings.configure({auto:false}, ctx.fiber)`；`locale` 改走 `describe({redactSecrets:true})` + 1s TTL 缓存 + `settings/document-updated` 失效（**刻意不在该事件里调 `describe()`**，那个事件正是 `describe()` 自己发的，会重入）；preset import 改包名 |
| `src/feishu-streaming.ts`、`src/feishu-toolcalls.ts` | `tool/result` 改读扁平 `message.content` / `message.isError` / `message.toolCallId` |
| `src/feishu-session.ts` | 归档路径**只加注释**说明为何不传 `stopActivity`（见 C2） |
| `package.json` / `package-lock.json` | 依赖范围与包名 |
| `tests/*.spec.ts` | `tool/result` fixture 改扁平形态；新增「扁平失败态必须渲染成 ❌ 失败」等回归测试 |

> 改动后必须 `npm run build`（`lib/index.js` 与**受 git 跟踪**的 `client/client.js` 一起更新），并按「一个批次一个 commit」提交。

---

## 5. 回滚与不可逆点

**不可逆 / 半可逆**

1. `settings.yaml` 被**改名**为 `settings.yaml.imported`（备份可恢复，但新版不会再读它）。
2. **会话日志 V3 → V4**：迁移**不重写已存代次**，V3 原件保留；但被继续写入的会话会产生 **V4 后继文件**，退回 0.1.6 后**那些新内容读不到**。→ 所以停服窗口的备份必须包含**整个会话目录**。
3. profile patch 被数据迁移改写（备份可恢复）。
4. 插件 `node_modules` 被重解析到 0.1.7（保留旧副本可回退）。

**回滚步骤**：停服 → 恢复备份（settings / profile patch / profile manifest / preset 目录 / 会话目录 / 插件 `node_modules`）→ `git checkout <源 tag>` → **`pnpm run clean`** → `pnpm install && pnpm run build` → `--version` 校验 → 启动 → 只读验证。

---

## 6. 验证清单（含本次实测结果）

| # | 验证 | 结果 |
|---|---|---|
| V1 | 服务日志出现 `dsh web: http://…`，无 `error\|failed\|already registered` | ✅ |
| V2 | `node apps/cli/lib/bin.js --version` | ✅ `0.1.7-alpha.1` |
| V3 | 插件装配（各注入服务 available、无 missing 警告） | ✅ |
| V4 | **模块解析（关键坑 28）**：工具调用是否报 `prepare` | ✅ 未复现（但服务入口**仍走构建产物**，"撤销权宜之计"留作独立实验） |
| V5 | 飞书收发：入站消息 → 步骤卡 send/update → 工具调用 → 结果 | ✅ 真实消息往返 |
| V6 | 设置页读写；改一个开关**不重启即生效** | ✅（`GET` 200；用过期 revision 写入会被拒并报 `settings namespace "…" changed since it was read`，用当前 revision 写同值 → 200 且无需重启） |
| V7 | legacy 导入：`settings.yaml.imported` 出现、profile 行 config 完整、日志无 `was not imported` | ✅（因为 B1 已在窗口内先删掉那一行） |
| V8 | 默认 preset 与升级前一致 | ✅（本就等于 bundle 默认） |
| V9 | 目录型 preset 出现在列表里 | ✅ **不适用**——B3 的处置是**不迁移、直接删除**（使用者决定不再保留该 preset）；删除前后组合逐字节一致，无需重启 |
| V10 | 故意跑一个失败工具 → 卡片显示**失败**而不是成功 | ✅（并有单测锁死） |
| V11 | 归档运行中的会话：要么成功停止、要么给出明确错误卡 | ✅ 错误卡（按 C2 的设计） |
| V12 | DSH 语言切 English 后插件文案跟随 | ✅ |
| V13 | 长会话在压缩阈值触发压缩（不再有「请求必死但压缩不触发」的死区） | ⏳ 未触发（需跑到阈值）；代码侧已核 `trigger = min(W × ratio, W − O − headroom)` |
| V14 | 会话日志：`turn/start` 与 `turn/end` 平衡、无 `/compact` 永久 busy | ✅ V4 后继文件生成，header 字段完整 |

---

## 7. 升级后发现的插件 bug（已修）：重建会话时挂错 preset

升级后核对时发现：会话 header、`/status`、卡片 footer 都写 `cordis`，但**实际工具集是 `standard` 的**（缺 `cordis_inspect` / `plugin_manager`，随附技能目录为空）。经定位，**与 0.1.7 无关**——同一现象在 0.1.6-alpha.2 上就复现过，根因在插件自己：

- 插件为了让飞书侧掌控工作区/模型/建会话流程，**直接调底层 `agents.resume()` 并自带 `setup` 回调**；而底层 `resume` 只是机制（读完日志、建好 agent，然后 `await setup?.(agent.ctx, agent)`），**不读 preset、也不校验**。策略层原本在宿主 `session-controller` 里（读 `agentPreset` Session 投影 = `header.agentPreset` ← 最后一条 `agent-preset/selected`）。
- 插件在**恢复**分支里也用**自己的配置默认值**解析 preset，本部署该字段为空 → `resolve(undefined)` 回落到 `agentPresets.defaultId` → 把这个 preset 的 `setup` 交下去，**覆盖了会话自己记录的组合**。
- 危害是**静默**的：不报错、卡片还写着正确的 preset，只有工具集/技能这类**行为证据**才暴露；且每次进程重启后的第一条消息都会踩。
- 修法：恢复分支改读**会话记录**（header ← 最后一条 `agent-preset/selected`，与显示层同规则），配置默认**只用于新建会话**；记录里的 preset 在当前安装解析不了时不阻塞恢复，回落 + 告警；并且只读日志**头部**（该事件只可能在会话空白期追加），避免为恢复一个 preset 把上百 MB 的历史读进内存。
- 已固化为**关键坑 33**，回归测试 5 例。

> 判据要点：**「配置组合里有这个 preset」不等于「这个会话在用它」**。`--dump-config` 只能证明组装正确，绑定要看会话记录。

---

## 8. 关联记录

- 变更记录：[`CHANGELOG.md`](../CHANGELOG.md) 的「兼容：对齐 DSH `0.1.7-alpha.1`」与「修复：恢复会话时按会话记录的 preset 挂载」两条。
- 关键坑全文：13（preset 重校）/ 14（延迟重启）/ 17（依赖范围）/ 28（同模块双实例）/ **32（清产物）** / **33（preset 绑定）**。
- 上一跳：[`docs/migration-0.1.6-alpha.1-to-alpha.2.md`](./migration-0.1.6-alpha.1-to-alpha.2.md)；更早见 [`docs/migration-0.1.5-rc.2-to-0.1.6-alpha.1.md`](./migration-0.1.5-rc.2-to-0.1.6-alpha.1.md)。
- 版本兼容台账与历史基线：`notes/upstream-and-compat.md`（本地笔记，不随仓库发布）。
- 上游 release：`https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1`。
