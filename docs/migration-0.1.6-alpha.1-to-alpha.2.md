# 升级方案：DSH 0.1.6-alpha.1 → 0.1.6-alpha.2

> 评估日：2026-09-18。对比 `dsh-v0.1.6-alpha.1...dsh-v0.1.6-alpha.2`：**887 commits / 2622 个改动文件**。
> 本文档只做**影响评估与改造清单**，评估时**未改动本机 DSH**。
> 前置阅读：[`notes/upstream-and-compat.md`](../notes/upstream-and-compat.md)（版本兼容台账）、关键坑 13（preset 重校）/ 14（延迟重启）/ 17（依赖范围）。

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 插件运行时代码 | **零必改**——四个被消费的 `sessionController` 方法签名逐字节未变，client slot 契约零差异 |
| 依赖范围 | **无需修改**（与 alpha.1 同属 `0.1.6` tuple，坑 17 补充规则） |
| 默认模型目录 | 移除 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`；插件走 `llm.listModels/resolveModelInfo` 动态解析，**代码安全**，但**本机 settings 踩到**（P0-1） |
| Creator preset 工具集 | `cordis_define/run/stop/undefine` **全部删除**，改由 `plugin_manager` 承担（P0-2） |
| 解析模式默认值 | `link` → `runtime` **翻转**，不再物化 fallback 链接（P0-4） |
| profile 热重载 | `dsh-base` 默认挂 `plugin-manager` + `dsh-hmr`；web 侧配置改动**即时生效**、插件可**热卸载**（P0-5） |
| `dsh.profile.patchReload` | 字段与校验**删除**；headless 的「仅启动生效」意图改由 headless bundle 的 `hmr: disabled` 承接（P0-3）|

**一句话**：插件本身几乎不用动，但**本机部署侧有 5 项必须先处理**（其中 P0-5 已复核为「无需改动」，见下文）；P0-4 是本轮唯一**新引入的运行时风险**，且用一次 `npm install` 即可消除。

---

## 1. 影响评估

### 1.1 插件的 19 个 `peerDependencies` 逐包 diff

按包名反查目录后逐包统计「除 `package.json` 与 `tests/` 外的源码改动文件数」：

| 包 | 改动源码文件 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-api-session-controller` | 18 | 见 §1.2；**被消费的四个方法未变** |
| `@deepseek-ai/dsh-agent-presets` | 6 | 仅 shipped preset 组合文件与两个 skill 文本（§1.5） |
| `@deepseek-ai/dsh-llm` | 5 | 仅 `llm/llm`：`inputModalities` 新增返回（§1.2） |
| `@deepseek-ai/dsh-user-questions` | 4 | 仅 README + `types.ts` 新增可选 `callId` |
| `@deepseek-ai/dsh-session` | 1 | 仅 `known-event-types.ts` 新增 `workspace/changes` |
| 其余 14 个 | **0** | 只有 `package.json` 的 `version` 行变化 |

> `@deepseek-ai/dsh-session` 是 `packages/core/session`；`packages/session/**` 全部只有版本号变化。

### 1.2 host 侧 API 核对

**逐字节未变**（`packages/api/session-controller/src/index.ts` + `commands.ts` 实现均未动）：

| 方法 | 插件调用点 |
|---|---|
| `sessionController.prompt(request, signal)` | `src/harness.ts:463` |
| `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })` | `src/commands.ts`、`src/feishu-model-select.ts` |
| `sessionController.rename({ sessionId, title })` | `src/feishu-session.ts` |
| `sessionController.fork({ sessionId }) → { sessionId }` | `src/feishu-session.ts` |

`Session.snapshotEvents(fromSeq, toSeqExclusive)`、`SessionId`、`SessionHandle`、`reason.error` / `TurnEndReason` / `turn/end` 载荷**全部未变**——关键坑 7（1:1 对齐 WebUI 错误）、坑 8（必须带范围读事件）的现有做法继续有效。

**行为面变化（需知悉，非必改）**：

- **新增错误码 `session/writer-held`**：resume 被活动写句柄占用时，原先报 `gateway/internal`。`prompt` / `selectModel` / `rename` 都可能抛出。→ 确认 `prompt` 调用点的 rejection 已被处理（关键坑 24：被丢弃的 promise 能杀掉 dsh）。
- `resolveAgent` 在共享 resume 后改为返回**已发布的 live agent**，而非 await 的 resume 结果。
- `updateQueue` 变为 `async`（插件未调用，仅备查）。
- 控制流 `queue` 帧、`ISessions.open/openSubagent/clear`、`SessionSnapshot.queue` 被删——**插件全部未使用**。

### 1.3 client 契约核对

- `packages/client/ui-settings/src/client/contract/slots.ts` **零行 diff**：`settings.action` / `settings.section` 仍是 `{ kind: 'list'; scope: 'root' }`，注册项、owner props、渲染点、声明点全部一致。
- `slots.inject` / `slots.register` 签名**逐字节一致**；`ctx.slots` 服务名未变。
- 插件用的 `@deepseek-ai/dsh-client-ui-primitives` 四个组件 —— `Button.tsx` / `Input.tsx` / `Switch.tsx` / `StateDot.tsx` —— **diff 为空**（该包其余 36 个改动文件与插件无关）。
- 新增 Component Factory 体系（`registerFactory` 等）**纯增量**。
- 被移除且插件未使用的：`useSessionPendingInteraction`（→ `useSessionStatus` + `useSessionRetainInfo`）、`sessions.open/clear`、`SessionListState.current`。

### 1.4 被移除 / 被替换的宿主面

| 变化 | 影响 |
|---|---|
| `DshProfileManifest.patchReload` 与 `ProfilePatchReload` 类型删除；旧的非法值校验一并移除 | 声明该字段的 profile 被**静默忽略**，不报错（P0-3） |
| `apps/cli/src/profile-boot.ts` 的 `resolutionMode` 默认值由 `'link'` 改为 `'runtime'` | 不再物化 `$DSH_HOME/profiles/node_modules` fallback 链接，改为把「包代际」挂在 Node ESM/CJS resolver 上（P0-4） |
| `packages/bundle/base/cordis.patch.yml` 新增 `plugin-manager` 与 `hmr` 两行（`disabled: !!js "!ctx.get('profileContext')"`） | base-backed profile 默认获得插件管理与**热重载**（P0-5） |
| `hmr` 行的模块名由 `@deepseek-ai/cordis-plugin-hmr` 改为 `@deepseek-ai/dsh-hmr` | patch 行若同时断言旧 `name`，会被 `vendor/include` **静默跳过**（只打一条 warning） |
| `packages/boot/app-boot` 不再安装用户 patch watcher（`watchUserPatches` 删除，新增 `reconcileProfilePatches`） | 热重载职责移交给 `dsh-hmr` 行 |
| `@deepseek-ai/dsh-plugin-manager` 为**新增包**；`@deepseek-ai/dsh-plugin-manager/tools` 注册 `plugin_manager` | 见 P0-2 |
| `tool-cordis` 由 7 个工具缩到 2 个（仅 `cordis_inspect_list` / `cordis_inspect_query`） | 见 P0-2 |
| `packages/llm/llm-deepseek/src/common/models.ts` 从默认目录删除 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` | 见 P0-1 |
| `attachment-local` 的 `sharp` 改为懒加载（`createLazyRequire`） | 缺 sharp 时错误从「启动即失败」推迟到「首次栅格操作」；仅影响排障时序 |
| `messages/serialize.ts` 的历史 tool input 非法 JSON 由抛 `INVALID_REQUEST` 改为降级为空对象 | 修复类改动，插件无感 |

### 1.5 Creator preset 的工具集替换

- `presets/cordis/agent.cordis.yml` 末尾新增 `- id: tool-plugin-manager / name: '@deepseek-ai/dsh-plugin-manager/tools'`（启用）；`presets/standard` 与 `presets/ptc` 也各加一行但 `disabled: true`。
- `tool-cordis` 的行保留，但语义收窄为**只读自省**；`cordis-host-runner` 的失败引导文案由「自行修正并重试」改为「把失败上报给用户」。
- 两个随 preset 交付的 skill 被重写：`cordis-plugin-development`（改为「在工作区写 bundle → `plugin_manager install_bundle`」）与 `editing-cordis-compositions`。
- 新增流程的安装语义：`installBundle` 会**即时尝试挂载**；patch 坏掉时报 `application: 'failed'` 且 profile 已被改写（只有 `applying` 之前的失败才回滚 `package.json` / `pnpm-lock.yaml`）。

### 1.6 依赖范围：本次**不需要**改

`0.1.6-alpha.1` 与 `0.1.6-alpha.2` 同属 `0.1.6` tuple，`^0.1.6-alpha.1` 在 semver 预发布规则下**已能匹配** alpha.2（关键坑 17 的补充规则）。实测依据：宿主在**装载期与安装期都不校验 peer 版本范围**（profile 以 `autoInstallPeers: false` 创建），该字段只作为依赖图的边参与代际闭包。

> 因此「升到 `^0.1.6-alpha.2`」属于文档级整洁，不是正确性要求；但若同时重装 `node_modules`（推荐，见 P0-4），锁文件会自然解析到 alpha.2。

> **取证校正（留档）**：本次评估起初依据「`packages/boot/app-boot/src/profile-resolution/` 在两端 diff 为空」判断「解析语义未变」——该结论**错误**。代码确实逐字节一致，但 `apps/cli/src/profile-boot.ts` 的**默认值翻转了**（`options.resolutionMode ?? 'link'` → `?? 'runtime'`），行为因此改变。教训：默认值翻转不会出现在实现文件的 diff 里，必须单独核对入口处的 `??` 兜底。

---

## 2. 前置项（P0）

### P0-1 本机 settings 的 subagent 路由指向被移除的模型

`deepseek-official` 的模型目录未在本机 settings 中覆盖，因此使用 DSH 内置 `DEFAULT_MODELS`。alpha.2 删除了 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp`（目录只剩 `deepseek-flash`(V41-Flash，带 image 输入) 与 `deepseek-v4-pro`）。

- `agent-default-model` 用的是 `deepseek-flash` → **安全**。
- `subagent-model-selection.allowedModels` 里有一条 `provider: deepseek-official / model: deepseek-v4-flash-vision-exp` → **失效项**。

**处理**：改为 `deepseek-flash`，或在 `llm-deepseek.models` 自建目录项把该 id 补回。

### P0-2 Creator preset 工具集替换

本会话（创造模式）当前持有的 `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` 在 alpha.2 **不存在**，取而代之的是 `plugin_manager`。

**处理**：

1. 升级后确认 preset 中出现 `tool-plugin-manager` 行（随 shipped `cordis` preset 自动生效；**本机自建 preset 需按关键坑 13 逐行重校**）。
2. 同步本仓库所有引用旧工作流的文档与笔记：`AGENTS.md`（关联记录）、`notes/`、本目录其他 migration 文档、以及任何提到 `cordis_define`/`cordis_run` 的 skill 引用。
3. 插件本身的安装方式不受影响：`dsh.bundle.patch` + `cordis.patch.yml` 契约形状**未变**（`app-boot` 仍读取 `dsh.bundle.patch`；无 patch 的包仍报 `not-bundle`）。

### P0-3 `patchReload` 字段被删除

`dsh.profile` 现在只读 `bundles`；`patchReload` 及旧的非 `live|startup` 校验全部移除。本机 `headless` profile 声明了 `"patchReload": "startup"`——**不会启动失败**（字段被忽略），但语义失效。

alpha.2 由 composition 决定热重载：`packages/bundle/headless/cordis.patch.yml` 显式写了 `- id: hmr / disabled: true`，因此 **headless 的「仅启动生效」意图已由它承接**，web 侧则默认开启。

**处理**：从文档/脚本里删掉对 `patchReload` 的断言，不需要新增动作；若某 profile 确实要关热重载，改为显式 `- id: hmr / disabled: true`。

### P0-4 runtime 解析模式：核心包必须只有**一份物理副本**

alpha.1 下 launcher 会物化 fallback 符号链接，插件的裸 `@deepseek-ai/dsh-*` import 走文件系统链接解析；alpha.2 改为进程内代际，**不再建链接**。

插件构建产物 `lib/index.js` 保留了 8 个外部 import：

```
@deepseek-ai/dsh-credentials  @deepseek-ai/dsh-commands  @deepseek-ai/schemastery
@deepseek-ai/dsh-llm          @deepseek-ai/dsh-session   @deepseek-ai/dsh-user-approval
@deepseek-ai/dsh-user-questions  @deepseek-ai/dsh-tools
```

**失败模式（DSH 官方已知问题）**：一旦解析链上出现**第二份物理副本**，`@deepseek-ai/dsh-tools` 会加载两次，模块级 Symbol 不匹配，**每一次工具调用**都报
`Cannot read properties of undefined (reading 'prepare')`。

- [Discussion #2078 — 一行 `Symbol.for` 修复该崩溃](https://github.com/deepseek-ai/deepseek-harness/discussions/2078)
- [Discussion #3516 — profile 里的第二份核心副本让每次工具调用失败](https://github.com/deepseek-ai/deepseek-harness/discussions/3516)
- [运维手册：修复重复的核心运行时闭包](https://github.com/sandbaseai/deepseek-harness-handbook/blob/main/docs/en/troubleshooting/duplicate-core-runtime-closure.md)

> ⚠️ **版本对齐不等于去重**。两份同版本（甚至同为 `0.1.6-alpha.2`）的拷贝依然是两个模块实例、两套 Symbol——所以「把依赖升到同一版本」**并不能**消除这个失败模式。真正的判据是**解析链上只有一个 realpath**。

**本部署的实测结论（2026-09-18，升级后审计）：**

| 位置 | 结果 |
|---|---|
| `profiles/node_modules/@deepseek-ai/`（259 项） | 全部是 pnpm 软链，`realpath` 均落回检出里的 workspace 包（如 `dsh-tools` → `packages/core/tools`）→ **同一份物理包** |
| `profiles/web/node_modules/@deepseek-ai/` | **空**（只有 `@starxer/chatterbox4dsh` 这一条 link） |
| 安装体（`apps/cli` 解析根） | `dsh-tools` / `dsh-llm` / `dsh-session` 均为 `0.1.6-alpha.2`，realpath 指向 workspace 包 |
| 运行期 `reading 'prepare'` 报错计数 | **0** |

即：插件工作区自己那份 `node_modules/@deepseek-ai/*`（真实目录、非软链）虽与安装体版本一致，但**裸包名被代际解析路由到安装体**，没有被加载；profile 侧也没有第二份。两侧都干净。

> ⚠️ **这张表测的是「临时措施生效之后」的状态，不是自然状态**。升级当天本机确实撞上了这个崩溃（会话坏过一次）：`tsx` 源码入口会让 `@deepseek-ai/dsh-tools` 加载两次。当前运行的补救办法是**把服务入口改成构建产物** `apps/cli/lib/bin.js`（见 `notes/upstream-and-compat.md`），它让解析闭包只剩一份，症状才消失。**代价**：改任何 host 源码后必须先 `pnpm run build` 再重启。上游修复落地前，不要直接切回 `tsx` 源码入口。
>
> **✅ 已定策略（2026-09-18）：不改 DSH 源码、不往检出里打补丁，等上游修复**（保持检出干净，便于随时切 tag）。上游修复进入正式 release 后，再把服务入口切回源码入口并复验一次工具调用。上游讨论：[#7011](https://github.com/deepseek-ai/deepseek-harness/discussions/7011)（仍 open）/ [#6986](https://github.com/deepseek-ai/deepseek-harness/discussions/6986)。
>
> **🔴 纪律：dsh 运行期间不要 `pnpm run build`**。产物入口下整个图都从 `lib` 加载，就地重建后任何惰性 import 会把同一模块求值第二次，用同样的机制把崩溃重新引出来。

**处理**：

1. 保持 `@deepseek-ai/dsh-*` 版本与运行中的 DSH 一致（本次已在升级脚本里重装到 `0.1.6-alpha.2`）——这是**正确性**要求（API 漂移），不是去重手段。
2. 升级后**必须**审计解析链上没有第二份副本（上表三条命令即可），**并且**确认服务入口与当前规避方案一致。
3. 已在 `profiles/node_modules` 里的遗留投影不必手删：resolver 会通过 `legacy-links.ts` 的 `isProfileModuleFallbackLink` 排除它们（`resolver.ts` 的 legacy 过滤分支）。但**不要**再往那里装第二份核心包。
4. **跨版本切 tag 前必须先清构建产物**（`lib/`、`dist/`、`*.tsbuildinfo`）——残留的 alpha.2 产物引用 alpha.1 不存在的导出会让 `build:lib` 直接失败；且**构建失败时不要启动服务**。


> 附带约束：包代际的替换是**只增不减**的——改动或删除已有映射会抛 "requires a process restart"。

### P0-5 web profile 默认 HMR + `plugin_manager` 可热卸载

`dsh-base` 现在默认挂 `plugin-manager` 与 `hmr`，因此 web profile 上：配置改动即时生效，插件可被**热禁用/重挂**。重挂会重新走一遍 `apply`，所以凡是没挂在 Cordis fiber 上的副作用都会泄漏，重挂时表现为重复卡片 / 重复定时任务，或直接因工具重名抛 `tool "<name>" is already registered`（该错误是致命的）。

**复核结论（2026-09-18 实测审计）：插件的拆卸面是干净的，本项无需改动代码。** 证据：

| 副作用 | 归属 | 拆卸路径 |
|---|---|---|
| 3 处 `setTimeout`（streaming 两处 debounce、todos 一处 debounce） | 各自的 per-session 状态对象 | `stopStreaming()` / `stopTodos()` 逐个 `clearTimeout`，且都在 `ctx.effect(() => () => {...})` 的清理里被调用 |
| `session/event`、`approval/request`、`user-questions/request` 等监听 | `ctx.on(...)` 的 disposer | 同上，统一在该 effect 清理里调用 |
| 两个 web 路由（settings / provision） | `ctx.effect(() => webServer.register(...))` | Cordis 自动卸载 |
| 工具注册（send-file / receive-file） | `stopSendFileTool()` / `stopReceiveFileTool()` | 同上 |
| 客户端 `<style>` | `ctx.effect` + `style.dataset.plugin = NS` | 正好命中 alpha.2「只清理 `style[data-plugin]`」的规则 |
| `process.on` / `setInterval` / 全局单例 | **不存在**（全量 grep 为零） | — |

三处 `addEventListener('abort')` 都挂在单次请求的 `AbortSignal` 上（`{ once: true }`），随请求结束释放，不跨 session 累积。

**顺带发现**：`src/feishu-toolcalls.ts` 的 `startFeishuToolCalls` 在 `src/` 与 `tests/` 中**已无任何引用**（死模块）；它自带定时器，但因为从未启动，不构成热卸载风险。清理与否与本次升级无关，仅记录。

> 结论修正留档：本项在初评时被列为「可能需要改代码」，依据是「存在裸 `setTimeout`」。实际审计表明这些定时器全部挂在可清理的 per-session 状态上、且清理函数确在 fiber 拆卸路径中——**判据不能只看「有没有裸定时器」，要看它有没有归属与拆卸路径**。

---

## 3. 升级步骤

### 阶段 1 —— 停服务（推荐）

`pnpm install` 会重写 `node_modules`，运行中的进程可能动态 import 到不一致的版本。**不要用「延迟 20 秒重启」跨越 install 阶段**（关键坑 14）：

```sh
systemctl --user stop dsh
systemctl --user show -p MainPID --value dsh   # 期望 0
```

### 阶段 2 —— DSH 源码升级

```sh
cd <dsh-checkout>
git fetch --tags --prune origin
git checkout dsh-v0.1.6-alpha.2
git status --porcelain

pnpm install
find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
rm -rf apps/web/dist

# ⚠️ 先清跨版本残留产物，再跑【完整】构建（不是 build:native-system，它不产 lib/）
# 用仓库自带的清理入口，checkout 前后各一次（它有"未知文件就整体拒绝"的保护）。
# 不要手写 `find -name lib`：清不掉"包目录本身已被删除、只剩 lib/ 和 node_modules/"的残留
# ——那正是本次与后续 0.1.7 升级两次构建失败的根因（关键坑 32）。
pnpm run clean        # 若已 checkout 完成，就地清一次
git checkout dsh-v0.1.6-alpha.2
pnpm run clean        # checkout 后再清一次（清掉目标 tag 残留 + 全部构建输出）
for d in packages/*/* apps/* vendor/*; do
  [ -d "$d" ] && [ ! -f "$d/package.json" ] && echo "RESIDUE: $d"
done
pnpm run build

# 服务入口当前是构建产物，就用同一个入口验版本
node apps/cli/lib/bin.js --version   # 期望 0.1.6-alpha.2
```

**验证点**：`pnpm install` 无 peer 冲突；`pnpm run build` 退出码 0；`--version` 输出 `0.1.6-alpha.2`。

> ⚠️ **构建失败就不要启动服务**。2026-09-18 的教训：残留产物让 `build:lib` 失败后仍 `systemctl start`，把半成品树拉起来，会话直接不可用。
>
> 本部署的**服务入口是构建产物 `apps/cli/lib/bin.js`**（临时规避 alpha.2 的 `dsh-tools` 双实例崩溃，见 §P0-4 与 `notes/upstream-and-compat.md`），因此完整 `pnpm run build` 是硬前提——**改任何 host 源码都必须重新构建再重启**。

### 阶段 3 —— 本机配置（P0-1 / P0-3 / P0-4）

```sh
# P0-1：subagent 路由指向被移除的模型 → 改为 deepseek-flash（或自建目录项）
#       文件：<dshHome>/settings.yaml
# P0-3：确认没有脚本/文档断言 dsh.profile.patchReload
# P0-4：插件工作区依赖重装到 alpha.2
cd <plugin-repo>
rm -rf node_modules package-lock.json
npm install
node -e "for (const p of ['dsh-session','dsh-llm','dsh-tools']) \
  console.log(p, require('./node_modules/@deepseek-ai/'+p+'/package.json').version)"   # 期望 0.1.6-alpha.2

npm run typecheck
npm run test
npm run build
```

**验证点**：

- `typecheck` 0 错误（本次真正的判据——它会暴露 §1 之外的隐藏导出漂移）
- `test` 基线 **405 passed / 33 files**（评估日实测），不得下降
- `build` 产出新的 `lib/index.js` 与 `client/client.js`，且 `client/client.js` 随提交一起更新（受 git 跟踪）

### 阶段 4 —— 启动与加载验证

```sh
systemctl --user start dsh
sleep 8
systemctl --user show -p MainPID --value dsh
journalctl --user -u dsh -n 60 --no-pager | grep -iE "error|failed|already registered|pending|fatal"
```

**验证点（缺一不可）**：

1. journal 无 `error|failed|already registered|fatal`——特别是**不出现 `tool "..." is already registered`**
2. 出现 web 监听日志（`dsh web: http://127.0.0.1:...`）
3. 合成出的 profile composition 中仍有 `lark-channel` 行
4. 飞书通道起来（journal 无 WebSocket 反复重连）
5. **不再出现 `session-log-deepseek` 相关的 413**（该 overlay 继续有效：base row 的 id 未变）

### 阶段 5 —— 功能回归

| # | 功能 | 检查方式 |
|---|---|---|
| 1 | 基础对话 + 步骤卡 | 发一句话，确认 per-step 卡、footer 指标、Turn Complete 卡正常 |
| 2 | 斜杠命令 | `/help` `/status` `/lang` |
| 3 | 模型选择 | `/model` 走一遍；确认**已不存在的模型 id 不再出现在列表里**（P0-1 的回归点） |
| 4 | 权限 / 审批 / 提问卡 | 各触发一次；确认关键坑 7（错误 1:1 对齐）与坑 22（双端弹卡）仍成立 |
| 5 | 图片 / 文件收发 | 图片需模型声明 `input: [image]`；文件走 `feishu_send_file` |
| 6 | Web UI 设置页 | 打开设置，确认「飞书与 Lark」分区仍挂载（client slot 契约的回归点） |
| 7 | 热重载（新增） | 在 web profile 改一次 `cordis.patch.yml`，确认插件被干净重挂、**无重复工具报错、无重复步骤卡** |
| 8 | 子代理 / 工作流 | 跑一次子代理；确认 subagent 路由不再引用被删模型 |
| 9 | Creator 模式 | 确认工具集变为「只读自省 + `plugin_manager`」，旧 `cordis_define/run` 已消失 |

---

## 4. 回滚方案

任一阶段失败都可回滚；回滚**必须整体做**（DSH 源码 + 本机配置 + 插件依赖三者同步）。

```sh
systemctl --user stop dsh

cd <dsh-checkout>
git checkout dsh-v0.1.6-alpha.1
pnpm install
pnpm run build            # 同样是完整构建

cd <plugin-repo>
git checkout <升级前 commit>
rm -rf node_modules package-lock.json
npm install
npm run build

# P0-1 的 settings 改动按需回退（用升级前的备份）
systemctl --user start dsh
```

> 会话格式：`SESSION_FORMAT_VERSION` 仍为 **3**（定义在 `packages/core/session/src/types.ts`，该文件两端**字节相同**），会话日志可直接回退，无需迁移。

---

## 5. 取证方式（可复现）

本次评估**未改动本机 DSH**，方法可复现：

```sh
git clone --no-checkout --filter=blob:none \
  --branch dsh-v0.1.6-alpha.2 https://github.com/deepseek-ai/deepseek-harness.git <tmp>
cd <tmp>
git fetch --filter=blob:none origin tag dsh-v0.1.6-alpha.1
git diff --name-only dsh-v0.1.6-alpha.1 dsh-v0.1.6-alpha.2 | wc -l    # 2622
```

要点：

- **按包名反查目录**再统计，不要按目录名字猜测（例如 `@deepseek-ai/dsh-session` 在 `packages/core/session`，而 `packages/session/**` 是另一组包）——否则会把「0 改动」和「未找到」混为一谈。
- 判断「某个 API 是否变了」要看**入口文件与默认值**，不能只看实现文件的 diff：本次 `resolutionMode` 的默认值翻转就是典型反例（§1.6 留档）。
- 判断「某个包是否只改了版本号」用 `git diff --stat <tag1> <tag2> -- <dir> ':!*tests*' ':!*package.json'`。

---

## 6. 事故记录（2026-09-18）

升级本身按 §3 跑完（`DSH_OK=1` / `PLUGIN_OK=1`），但**随后触发了上游 alpha.2 的致命回归，会话坏过一次**。完整根因与三条纪律见本地笔记的「关键坑 28」（`notes/pitfalls.md`）。时间线：

| 时间 | 事件 |
|---|---|
| 02:59–03:02 | 升级脚本执行完成，DSH 起在 `0.1.6-alpha.2` |
| 03:02 后 | 命中上游回归：`tsx` 源码入口下 `@deepseek-ai/dsh-tools` 被求值两次 → **每次工具调用**报 `Cannot read properties of undefined (reading 'prepare')`；会话在该轮中断（会话日志从 03:0x 直接断到 15:xx） |
| 14:41 | 回滚脚本执行 → **构建失败**（跨版本残留产物，见下），但脚本仍启动了半成品树，问题进一步恶化 |
| 15:02 | 服务单元 `ExecStart` 改为**构建产物入口** `apps/cli/lib/bin.js`（临时措施，单元文件内已注明原因并引用 #6986/#7011） |
| 15:06 | 服务在新入口上重启，恢复可用 |

**两个教训（都已固化进 §2 的处理项与升级/回滚脚本）**：

1. **回滚失败的直接原因是跨版本残留的构建产物**：alpha.2 的 `plugin-manager/lib/types/index.js` 引用了 alpha.1 不存在的 `readProfilePatches` / `reconcileProfilePatches`，`git checkout` 回 alpha.1 后这些**未被 git 跟踪的 `lib/`** 让 `pnpm run build` 在 rolldown 报 `[MISSING_EXPORT]`。必须**先清产物再构建**。
   > **2026-09-22 追加（重要）**：当时写下的修法是手写 `find … -name lib -exec rm -rf`，**它不够**——清不掉「包目录本身已被删除、只剩 `lib/` 与 `node_modules/`」这一类残留（`git checkout` 不删未跟踪产物，而目标 tag 会改名/删除包）。同一个根因在 **0.1.7-alpha.1 升级时再次导致构建失败**（`Cannot find entry`）。**正确做法是调用仓库自带的清理入口 `pnpm run clean`（checkout 前后各一次）+ 覆盖 `apps/*`、`vendor/*` 的残留断言**，详见 [docs/migration-0.1.6-alpha.2-to-0.1.7-alpha.1.md](./migration-0.1.6-alpha.2-to-0.1.7-alpha.1.md) §3.2 与关键坑 32。
2. **构建失败时不要启动服务**。上一轮把半成品树拉起来，才是「会话彻底不可用」的那一步。

**上游状态（2026-09-22 复核）**：`#7011` / `#6986` 当时均 **open**。0.1.7-alpha.1 里 `TOOL_RUNTIME_SCHEDULER` **仍是局部 `Symbol(...)`**（未改成 `Symbol.for`），而 alpha.2 那个「默认解析模式」开关在 0.1.7 已随解析模型重写而**消失**：即上面列的两种源码级改法，一个上游仍未采用，一个已无处可改。好消息是 0.1.7 的 "resolve linked plugin peers from the running installation" + `linkedRoots()`（显式跳过悬空链）**可能**从结构上避免 link 插件再带第二份核心包，升级后实测**未复现** `prepare` 报错；但符号身份**没有兜底**。**结论：权宜之计（服务入口走构建产物）继续保留**，要撤只能做实测实验，不要凭推断撤。**已定策略不变：不改 DSH 源码、不往检出打补丁。**

**会话完整性**：上游提示「在 `tool/call` 之后崩溃的会话可能缺配对 `tool/result`，建议新建会话」。本会话实测**干净**，无需重建：260 次 `tool/call` / 259 已配对（唯一未配对的是当时正在执行的调用），`turn/end` 为 7 `completed` + 1 `interrupted`、**0 `error`**。会话日志里出现的 `reading 'prepare'` 字样全部来自事后读取的文本（单元文件注释、讨论内容、journal 摘录），不是真实报错。

---

## 7. 关联记录

- 版本兼容台账与历史基线：`notes/upstream-and-compat.md`
- 关键坑全文（13 / 14 / 17 / 24 / **28**）：`notes/pitfalls.md`
- 上一跳（0.1.5-rc.2 → 0.1.6-alpha.1）：`docs/migration-0.1.5-rc.2-to-0.1.6-alpha.1.md`
- 下一跳（0.1.6-alpha.2 → 0.1.7-alpha.1，含本页「清产物」教训的**修正**）：[docs/migration-0.1.6-alpha.2-to-0.1.7-alpha.1.md](./migration-0.1.6-alpha.2-to-0.1.7-alpha.1.md)
- 评估期间发现、**本次不改**的插件侧问题：见 `TODO.md`「已知问题」段
