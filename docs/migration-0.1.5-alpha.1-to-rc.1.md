# 升级评估：DSH 0.1.5-alpha.1 → 0.1.5-rc.1

> **来源**：DSH release tag `dsh-v0.1.5-rc.1`（2026-09-10 发布）。本文基于 `dsh-v0.1.5-alpha.1..dsh-v0.1.5-rc.1`（**279 个 commit**）分析。
>
> **结论**：
> 1. **插件运行时代码零改动**。typecheck / build 全绿；插件 import 的 **17 个 `@deepseek-ai/dsh-*` 包**里只有 5 个源码有变动，且**全部是增量（新增字段/新事件类型/新图标）或纯注释**，无一破坏性。
> 2. **依赖范围也不用改**。`^0.1.5-alpha.1` 与 rc.1 **同属 `0.1.5` tuple**，npm semver 的预发布匹配规则下自动命中 rc.1（实测 `npm install` 装到的就是 `0.1.5-rc.1`）。这与 0.1.3→0.1.5 那次跳跃不同（那次 tuple 变了，必须改范围，见 [migration-0.1.3-to-0.1.5.md](./migration-0.1.3-to-0.1.5.md)）。
> 3. **有一个真实但只在开发/CI 环境暴露的坑**：`@deepseek-ai/dsh-client-ui-primitives@0.1.5-rc.1` 把全部运行时依赖从 `dependencies` 降为 `devDependencies`，导致插件全新安装后 `tests/client.spec.ts` 无法解析 `clsx`。**已按 B1 修复（2026-09-10）**。见「问题 B」。
> 4. **rc.1 带来了一个高价值对齐机会**：Web 的 `standard`/`ptc`/`cordis` preset 新增 `present` 工具 + `deliverables/presented` 事件，飞书侧目前完全没接。见「改进机会 C1」。
>
> **English**: DSH `0.1.5-alpha.1` → `0.1.5-rc.1` (279 commits). The plugin needs **no runtime code changes** and **no dependency-range change** (same `0.1.5` tuple). One dev/CI-only breakage was found in `dsh-client-ui-primitives` packaging, plus one high-value feature-alignment opportunity (`present` / `deliverables/presented`).

## 核验方法

1. **依赖 API diff**：把插件源码复制到临时目录，删 `package-lock.json` 后全新 `npm install`（实测解析到 `@deepseek-ai/dsh-agent@0.1.5-rc.1`），逐个对比 17 个被 import 的 `@deepseek-ai/dsh-*` 包在两个 tag 下的 `package.json#exports`、变更文件数与源码 diff。
2. **编译与测试**：临时目录里 `tsc --noEmit` / `vitest run` / `tsdown` 全套跑。
3. **服务名 pre-flight**：插件 `inject` / `ctx.get()` 用到的 18 个宿主服务名在 rc.1 源码里逐个确认仍存在。
4. **事件词汇**：对照 `packages/core/session/src/known-event-types.ts`。
5. **发行说明逐条过**：把 release notes 的「其他变更 / 破坏性变更」逐条映射到插件代码。

## 逐包 API diff

`exports` map：17 个包 **0 差异**。源码变动：

| 包 | 变动 | 对本插件 |
|---|---|---|
| `dsh-api-session-controller` | 新增 `SessionOpenWorkspacePathRequest.action?: 'reveal'`、新增 `workspaceDesktop()` 方法、`revealPath` internals/`nativeFileManager` | 纯增量。插件只用 `prompt` / `selectModel` / `fork` / `rename` / `cancel` |
| `dsh-llm` | `LlmConfigurableProvider` 新增可选 `error?: string` | 纯增量。插件只用 `errorChain` / `isTokenDelta` / 类型 |
| `dsh-session` | 已知事件类型新增 `deliverables/presented`、`subagent/catalog`；注释措辞 | 增量。插件不认识的类型直接忽略，不会炸 |
| `dsh-session-persistence` | 仅注释/文档措辞（`assertVersion` 语义说明） | 无影响 |
| `dsh-client-ui-primitives` | 新增 `CodeFileIcon` / `FileTypeIcon` / `code-file-types`，改 `LinkIcon` / `Menu` / `CodeBlock`；**包元数据把运行时依赖降为 devDependencies** | 运行时零影响（插件 client bundle 把它 external，由 DSH Web 提供）；测试环境受影响 → **问题 B（已修）** |

其余 12 个包（`dsh-agent` / `agent-default-model` / `agent-presets` / `attachment` / `commands` / `credentials` / `host-directory-picker` / `host-webserver` / `settings` / `tools` / `user-approval` / `user-questions` / `workspace`）**源码 0 变动**。

## 发行说明里的破坏性变更，逐条对照插件

| rc.1 变更 | 插件是否受影响 | 依据 |
|---|---|---|
| 会话日志 V3 / `SessionHandle` / 异步 `agentLoop.create()` / session 锁 | 否 | 已在 0.1.3→0.1.5-alpha.1 那轮适配完毕，rc.1 未再变 |
| **插件 Agent API：移除 `ctx.agent`** | 否 | 插件从不使用 `ctx.agent`；只用 `exec.agent`（工具执行上下文）与 `request.agent`（审批/提问 waterfall） |
| **Inbox API：`Inbox` 不再是可构造类，`hasPending` / `claim` 移出公共接口** | 否 | 插件从不触碰 `agent.inbox`（代码里只有「next-step inbox」的注释文案） |
| **Web 插件面板 API：新增 `sidebar.panellist` / `main`，原 `conversation` Slot 迁移为 `main` 的 conversation key** | 否 | 插件只用 `settings.action` + `settings.section` 两个 Slot；`packages/client/ui-settings/src/client/contract/slots.ts` 在两个 tag 之间**字节零差异** |
| 自定义 persona 拆 prefix/suffix | 否 | 同一变更在 alpha.1 已出现，本机自建 preset 已修（见 AGENTS.md 关键坑 #13） |
| 默认工具调整：`minimal` / `sdk-minimal` 默认只给持久 shell，`str_replace_editor` 需显式启用 | **间接**（只影响自建 preset 的维护，不影响插件代码） | 见「注意事项 D」 |
| 所有出站请求遵循 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | **部分**（值得记录，暂不处理） | 见「改进机会 C5」 |
| 新模型 `DeepSeek-V41-Flash`（`deepseek-flash`）成为新会话默认 | 否 | 插件 `/model` 走 `llm` 服务动态列模型，无硬编码 |
| 会话统计改成两个可展开摘要 / Sidebar 多标签预览 / 通用文件上传 | 否 | 与插件已有的 Turn Complete 卡片、附件收发是**平行实现**，非替代 |

## 服务名 pre-flight

`agents` / `sessions` / `sessionPersistence` / `agentDefaultModel` / `agentPresets` / `workspaceRegistry` / `settings` / `credentials` / `webServer` / `commands` / `llm` / `attachments` / `tools` / `sessionController` / `userQuestions` / `approval` / `directoryPicker` / `sandboxPolicy` / `permissionPresets` —— 19 个全部在 rc.1 源码里原样存在。

另：`/session` 面板用来过滤子代理会话的会话头字段 `origin: 'subagent'` 在 rc.1 仍是合法值（`packages/core/session/src/types.ts` 与 `subagent-child-agent.ts` 都没变），过滤逻辑继续有效。

## 问题 B：`dsh-client-ui-primitives` 打包变更弄坏插件测试环境

**现象**：全新安装 rc.1 后 `npm run test`：

```
FAIL  tests/client.spec.ts
Error: Failed to resolve import "clsx" from
  "node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js"
```

**根因**：alpha.1 的 `dsh-client-ui-primitives` 在 `dependencies` 里声明了 `clsx` / `anser` / `katex` / `shiki` / `@shikijs/langs` / `mdast-util-*` / `micromark-*`；rc.1 把这些**整体搬到了 `devDependencies`**（发行时依赖由宿主 Web 应用提供），但**构建产物 `lib/index.js` 仍然 `import` 它们**。插件独立 `npm install` 时不会安装依赖的 devDependencies，于是 vitest 在解析 `ui-primitives` 的模块图时找不到这些包。

**影响面**：仅 `tests/client.spec.ts`（它 `import '../src/client/LarkSettingsSection.tsx'`，进而加载真实的 `ui-primitives`）。
`npm run typecheck` 与 `npm run build` **都不受影响**（client bundle 已经把 `@deepseek-ai/dsh-client-ui-primitives` 标为 external，由 DSH Web 运行时提供）。
线上运行也不受影响——插件从不自带这份代码。

**实测修复**：把 18 个包加进插件 `devDependencies` 后，临时目录里 **281 tests 全绿**：
`clsx` `anser` `katex` `shiki` `@shikijs/langs` `mdast-util-from-markdown` `mdast-util-gfm` `mdast-util-math` `micromark-core-commonmark` `micromark-extension-gfm` `micromark-extension-math` `micromark-factory-space` `micromark-util-character` `micromark-util-classify-character` `micromark-util-sanitize-uri` `micromark-util-symbol` `micromark-util-types` `@types/mdast`。

**两个候选修法**：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **B1 ✅ 已采用（2026-09-10）** | 在 `vitest.config.ts` 加 `resolve.alias`，把 `@deepseek-ai/dsh-client-ui-primitives` 指向一个本地测试替身（只导出 `Button` / `Input` / `StateDot` / `Switch`，见 `tests/stubs/ui-primitives.tsx`） | 零新增依赖、CI 自洽；**符合事实**——该包本来就是宿主提供的（client bundle 已 external） | 失去「真实 `Switch` 是否还接受我们的 props」这层覆盖（可以接受：这些 a11y 契约归 DSH 自己的组件库所有，且 props 类型仍由 `typecheck` 拿真包 `.d.ts` 校验） |
| **B2** | 把上面 18 个包写进 `devDependencies` | 一行配置都不用改，测试继续跑真实组件 | 依赖清单臃肿且**易碎**——DSH 下次给 primitives 加一个新依赖，这里又会红 |

**B1 落地情况（2026-09-10）**：`tests/stubs/ui-primitives.tsx` 按真组件的可观测契约实现四个替身（`role="switch"` + `aria-label` / 原生 `disabled` / 受控 `input` / `data-state`），**原有测试断言一条未删**；`vitest.config.ts` 的 `server.deps.inline` 保留不变（替身后该规则对该包已无实际作用，留着不影响）。验证方式是**真模拟**：把 `node_modules/clsx` 移走（而不是移走整个 primitives 包）。

| 场景 | 结果 |
|---|---|
| 移走 `clsx` + 无 alias（对照） | ❌ `Cannot find package 'clsx' imported from .../dsh-client-ui-primitives/lib/index.js` —— 与预判一致 |
| 移走 `clsx` + 新 alias | ✅ `tests/client.spec.ts` **10 passed** |
| 移走整个 primitives 包 + 新 alias | ✅ 全套 **307 passed（26 files）** |
| 还原后 `npm run typecheck` / `npx vitest run` | ✅ 0 error / 307 passed |

**触发时机**：当前 `package-lock.json` 仍锁在 alpha.1，`npm ci` 暂时不会红；但**任何一次重新生成 lockfile 的依赖变更都会踩到**——现已消除该隐患。

## 改进机会

### C1（高）接管 `deliverables/presented` ✅ 已实现，但结论与原设想相反

rc.1 给 Web 的 `standard` / `ptc` / `cordis` preset 加了 `@deepseek-ai/dsh-tool-present`，它的工具描述**要求模型「用户要的文件必须调 `present`」**，并在成功后往会话日志 append：

```ts
// packages/fs/tool-present/src/index.ts
session.append('deliverables/presented', {
  turn, callId: exec.callId, files,   // files: [{ path, description? }]（相对路径按 session cwd 解析，最多 8 个）
})
```

Web UI 用它渲染「本轮交付物」卡片行；评估时飞书侧**什么都不发生**——事件不在 `feishu-streaming.ts` 的处理列表里，被静默忽略，使用者在飞书只看到一张 `present` 工具卡被告知「文件已交付」。

> ~~**原始建议**：新增 `src/feishu-deliverables.ts` 订阅事件，按会话 `header.cwd` 解析路径后**复用 `feishu_send_file` 的推送路径自动把文件发进聊天**（去重 / 上限 / 独立开关 `autoSendPresented`）。~~

**实际实现（2026-09-10）与原建议相反：只列清单，不推送文件。**

- 落点：`src/feishu-streaming.ts` 收集（按 `path` 去重、后声明的描述覆盖先前的、单轮上限 16）+ `src/channel.ts` 的 `renderFooterCard` 渲染（最多 6 条，其余折成「…另有 N 个」）。**没有新建 `src/feishu-deliverables.ts`**。
- 位置：`📦 交付物（N）` 是 **Turn Complete 卡片的第一个元素**，紧跟一条分隔线再接指标——使用者真机反馈放在 stats 与元信息之间「位置不合理」（2026-09-10）。
- **为什么不推送**：飞书没有工作区浏览器，Web 那套「交付物卡片行 + 点开在侧栏预览」在这里没有等价物；而自动把文件推进聊天既噪音大，又会让模型同时调 `present` 与 `feishu_send_file` 造成重复发送。清单保留了 `present` 的全部价值——**模型筛过的成品 + 描述**——用户真要文件时说一句即可，仍走已有的 `feishu_send_file`。
- 因此这里**不再是功能对齐缺口**：rc.1 带来的唯一实打实缺口已闭环。

**注意**：`present` 工具随 rc.1 的 shipped preset 走，**自建 preset 必须手动补 `- id: present / name: '@deepseek-ai/dsh-tool-present'`**（本机 `persistent` 已补），否则清单永远是空的——与「关键坑 #13」同类的 preset 漂移问题。

### C2（中）子代理可见性 / 控制

rc.1 新增 `subagent/catalog` 事件（parent-owned、分片存储）与「可继续对话的子代理支持排队 / 编辑 / 删除 / 单条或全部 Steer / 停止」。插件目前把子代理会话**完全隐藏**（`listSessions` 按 `origin === 'subagent'` 过滤，与 WebUI 会话树一致，这个行为本身仍然正确）。
若要跟进，可新增只读的 `/subagents` 卡片：从 `subagent/catalog` 折叠出子会话清单（label / mode / 状态），并提供 steer / stop 按钮。**优先级中**——取决于使用者是否真的在飞书里调度子代理。

### C3（无工作量）`/feedback` 已自动可用

rc.1 的 `/feedback <text>` 是**宿主 `commands` 注册表**里的命令（`packages/feedback/command-feedback`），不需要 Web UI。插件的 `executeSlashCommand` 末尾会把非插件自有命令交给 `commands.execute(agent, line, [], signal)`，所以它**已经在飞书里能用**，也会自动出现在 `/help` 的「💠 DSH 内置」分组。只需在真机上确认一次。

### C4（低）`present` 工具卡的渲染

接 C1 之后，`present` 会以普通工具卡出现（工具名 `present`、args 是文件数组）。`deriveToolSummary` 目前对未知工具走「工具名 · 首字段」兜底，显示会是 `present · files`。可以在 `deriveToolSummary` 里给 `present` 加一个分支（`present · a.txt +2`），成本极低。

### C5（低，仅记录）代理环境下的入站连通性

rc.1 让 DSH 自身的出站请求遵循 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`。插件本身的出站分两条腿：
- **出站 REST**（`channel.send`）走 `@larksuiteoapi/node-sdk` 的 HTTP（axios）。axios 在 Node 下默认读 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 环境变量，**大概率已自动支持**。
- **入站消息**走 WebSocket（`wsConfig: { pingTimeout: 60 }`，见 AGENTS.md 关键坑的「入站连接自愈」）。`ws` **不认代理环境变量**。

所以纯代理出网的环境里，插件可能「发得出、收不到」。真遇到时的修法是给 SDK 的 WS 客户端传代理 agent。**当前只是记录，不建议现在改**。

### C6（低）`minimal` preset 收窄

rc.1 的 `minimal` 从「持久 shell + `str_replace_editor`」收成「只有持久 shell」，`standard`/`ptc`/`cordis` 则新增 `@deepseek-ai/dsh-tool-present` 行。这与插件代码无关，但**属于 AGENTS.md 关键坑 #13 的复检范围**：任何「从 shipped preset 拷出来改过」的本地 preset 都应在升级后重新对照当前 shipped 版本过一遍，确认（a）persona prefix/suffix 仍匹配、（b）是否要补 `present` 行、（c）`bash` 不重复注册。

## 注意事项 D：本机升级到 rc.1 的动作清单

> 仅当决定升级时执行；本文只做评估，**未执行任何升级或代码改动**。

1. 升级 DSH 源码到 tag `dsh-v0.1.5-rc.1` → `pnpm install` → `pnpm run build`（`pnpm install` 不会自动产 `lib/`）。
2. 复检自建 agent preset（关键坑 #13 的逐行 Config 校验脚本），特别是 persona 的 prefix/suffix 与 `minimal` 的工具行变化。
3. 本插件：`npm install`（会解析到 rc.1）后**先修「问题 B」再跑测试**，否则 `tests/client.spec.ts` 会红。
4. 重启走「关键坑 #14」的延迟 + 脱进程组方式；在**新 turn**里用 `journalctl --user -u dsh -n 30` 验证干净启动。
5. 真机回归：发一条普通消息（step 卡）、`/status`、`/session`、`/display`、`/permission`，以及一条带文件的对话。

## 相关

- 上一轮评估：[migration-0.1.3-to-0.1.5.md](./migration-0.1.3-to-0.1.5.md)（0.1.3-alpha.2 → 0.1.5-alpha.1）
- 能力对齐总表：[../AGENTS.md](../AGENTS.md)（本地笔记，不入库）
- 功能待办：[../TODO.md](../TODO.md)
