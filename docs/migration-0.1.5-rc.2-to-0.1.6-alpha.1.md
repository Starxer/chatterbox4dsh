# 升级方案：DSH 0.1.5-rc.2 → 0.1.6-alpha.1

> **来源**：DSH tag `dsh-v0.1.6-alpha.1`（2026-09-14 发版，09-15 并入 master）。基线是本机正在运行的 `dsh-v0.1.5-rc.2`（2026-09-10）。
>
> **规模**：`dsh-v0.1.5-rc.2..dsh-v0.1.6-alpha.1` 共 **800 个 commit**，仓库级 `3942 files changed, +784113/-47018`（含 lockfile 与生成物）。
>
> **npm 现状**：`alpha` = `0.1.6-alpha.1`，`next` = `0.1.5-rc.2`，`latest` = `0.1.5-rc.1` —— 即我们跑的 rc.2 是 `next` 线，而 `latest` 反而更旧。
>
> **结论**：
> 1. **插件运行时代码预期零改动**，但要按惯例全量重验（插件 19 个 `@deepseek-ai/dsh-*` 依赖已确认全部发布了 `0.1.6-alpha.1`）。跨 tuple（`0.1.5` → `0.1.6`），**必须同时改依赖范围**，且必须删 lockfile 重装 —— 当前 lockfile 实际锁死在 `0.1.5-alpha.1`（比运行时还旧一个小版本）。
> 2. **会话持久化不用迁移**：`SESSION_FORMAT_VERSION` 两个 tag 都是 **3**。
> 3. **插件用到的 API 面没有被破坏**：3 个被移除的导出插件都没用；`permissionPresets.current/set`、`sandboxPolicy.resolve/setSandboxMode`、常驻终端围栏的报错文案、`ui-primitives` 的四个组件全部原样。
> 4. **风险最高的不是插件 API，而是 DSH 的 boot / profile 解析重构**（`packages/boot` + `apps/cli/src`：**41 个 commit、26 文件、+4241/-814**，新增了一整套 `profile-resolution/` 子系统）。本插件正是通过 `link:` + `dsh.bundle.patch` 挂进 profile 的，这个安装路径必须在阶段 4 显式验证。
> 5. **升级前置项（P0）不在插件里**：本部署自建的 `persistent` preset 引用了 `@deepseek-ai/dsh-workflow-worker-thread`，该包在 0.1.6 中被删除（由 `@deepseek-ai/dsh-workflow-ptc` 取代）。此项必须**与升级同一步**完成，不可提前。
>
> **English**: DSH `0.1.5-rc.2` → `0.1.6-alpha.1` (800 commits). No plugin runtime change is expected, but all 19 `@deepseek-ai/dsh-*` ranges must move to the new tuple and the lockfile must be regenerated. Session format stays v3. The highest-risk area is DSH's boot/profile-resolution rework (41 commits, +4241/-814) because this plugin is installed via `link:` plus `dsh.bundle.patch`; the deployment's own `persistent` preset also references a package deleted in 0.1.6 and must be fixed in the same step.

## 0. 升级决策

| 问题 | 事实 |
|---|---|
| 为什么要升 | 800 个 commit 的累积；新增 `ptc` / `cordis` 预设、permission-presets 的 `catalog()` 投影、boot 解析修复 |
| 为什么可以等 | 目标是 **alpha**，不是 rc/stable；`latest` 仍停在 `0.1.5-rc.1` |
| 不升的代价 | 已知且可控：本次会话发现的 vision 能力声明问题与 DSH 版本无关；插件当前全部功能正常 |
| 建议 | 先按本文在**维护窗口**内一次做完；确认 rc 版本发布后再作为常规节奏跟进 |

## 1. 影响评估（已完成）

核验方法与既有迁移文档一致：在两个 tag 之间做依赖 API diff、逐包源码 diff、导出符号 diff、宿主服务名 pre-flight、设置键 pre-flight。

### 1.1 会话持久化

| 项 | 0.1.5-rc.2 | 0.1.6-alpha.1 | 影响 |
|---|---|---|---|
| `SESSION_FORMAT_VERSION` | 3 | **3** | 无迁移；旧日志直接可读 |
| 日志新事件类型 | — | `known-event-types.ts` +6 | 增量；插件不认识的类型按 `ignorable` 语义忽略 |

### 1.2 插件 import 的 19 个包：源码 diff

`package.json#exports` 无差异；源码有改动的只有 10 个：

| 包 | 改动规模 | 对本插件 |
|---|---|---|
| `dsh-core/session`（`dsh-session`） | 5 文件 +190/-39 | 新增事件类型与 surface 能力；插件的 `snapshotEvents` 范围读取语义不变 |
| `dsh-core/tools` | 5 文件 +169/-62 | 增量；插件只用 `ctx.tools.register(defineTool(...))` |
| `dsh-llm` | 6 文件 +147/-105 | 增量（图片投影 / 错误链）；插件用到的 `errorChain` / `isTokenDelta` 仍在 |
| `dsh-preset/agent-presets` | 4 文件 +99/-83 | 见 §1.5 与 §2 |
| `interaction/permission-presets` | 3 文件 +160/-88 | 见 §1.4 |
| `dsh-attachment` | 3 文件 +42/-13 | 见 §1.3 |
| `core/agent` | 2 文件 +35/-49 | 增量 |
| `interaction/commands` | 4 文件 +24/-4 | 见 §1.3 |
| `compaction` | 4 文件 +22/-4 | 增量 |
| `api/session-controller` | 6 文件 +9/-5 | 增量；`prompt` / `selectModel` / `fork` / `rename` / `cancel` 签名不变 |
| `workspace` | 1 文件 +23/-0 | 增量 |
| 其余 7 个（`agent-default-model` / `credentials` / `host-directory-picker` / `host-webserver` / `session-persistence` / `settings` / `user-questions`） | **0 文件** | 无 |

### 1.3 被移除的导出（3 个，插件全部未使用）

| 包 | 移除的符号 | 插件引用数 |
|---|---|---|
| `dsh-attachment` | `requestImageDimensions` | 0 |
| `dsh-session` | `SessionSurface` / `SurfaceFoldReplacement` / `SurfaceFoldResult` | 0 |
| `dsh-commands` | `CommandId` 的 index 再导出（定义仍在 `brand.ts`） | 0 |

### 1.4 行为面核对

| 面 | 核对结果 |
|---|---|
| `permissionPresets.current(session)` / `.set(session, name)` | **签名不变**；`current()` 仍以 `custom` 兜底。新增 `catalog()` / `optionOf()` / `resolve()` / `AUTO_PRESET`，均为增量 |
| 常驻终端围栏 | 抛错文案**一字未改**（`terminal-bash/src/index.ts:59`），插件那条「因为常驻终端」提示的 `/persistent terminal/i` 检测继续有效 |
| `sandboxPolicy.resolve({session})` / `setSandboxMode` | 仍在；改动集中在工作区根路径的绝对性校验 |
| `ui-primitives`（dev） | 插件只用了 `Button` / `Input` / `Switch` / `StateDot`，四个都还在；仅移除 `projectUserText`（未使用） |
| `cordis` / `schemastery` | vendor 版本 `4.0.2` / `3.18.2` 两个 tag 相同，插件的 `^4.0.1` / `^3.18.1` 无需改 |
| 宿主服务名 pre-flight | 插件 `ctx.get()` 用到的 18 个服务对应的包在 0.1.6 全部存在，无一改名 |

### 1.5 DSH 级设置键 pre-flight

本部署 `~/.dsh/settings.yaml` 用到的 DSH 自身 section 与键，在 0.1.6 全部仍被识别：`ui-chat.transcriptView`、`ui-onboarding.welcomeNoticeVersion`、`shell.timeoutMs`、`subagent-model-selection.allowedModels`、`locale.preference`、`agent-presets.default`、`agent-default-model.*`。

`llm-pi-ai` 的配置 schema（`config.ts`）在两个 tag 之间**零改动**，因此本部署手工补的每模型 `input: [text, image]` 声明在升级后依然有效，不会被抹掉。

新增：`permission-presets` 现在会注册 `permission` settings 命名空间（新键，有默认值，无需手工设置）。

### 1.6 最高风险区：boot / profile 解析重构

```
packages/boot + apps/cli/src : 41 commits, 26 files, +4241/-814
新增：packages/boot/app-boot/src/profile-resolution/{resolver,service,legacy-links,worker-bootstrap}.ts
```

本插件的挂载链路正是这条：`~/.dsh/profiles/web` 里 `link:` 指向本仓库 → `dsh plugin add` 时 `reconcilePlugins()` 读到本包的 `dsh.bundle.patch` → 追加进 `dsh.profile.bundles` → boot 时作为一层 patch 合成 `cordis.yml`。

好消息：`reconcilePlugins()`（`apps/cli/src/plugin.ts:59`）与 `bundlePatches` 合成（`apps/cli/src/profile-boot.ts:204/245/345`）在 0.1.6 都还在，机制没被拿掉。但这仍是本次升级**唯一需要人守着看的一步** —— 阶段 4 必须确认插件真的被加载，而不只是「dsh 起来了」。

另一个连带的安装层风险：`pnpm-workspace.yaml` 移除了 `linkWorkspacePackages: true`，并把 `node-addon-*` 内置 loader 从 `0.1.4` 提到 `0.1.6`。这意味着**不能增量 install**，必须删干净重装。

## 2. 前置项（P0，必须先做，且与升级同步）

### P0-1 自建 preset 引用了被删除的包

`<dshHome>/.agent-presets/persistent/agent.cordis.yml` 第 266-267 行引用 `@deepseek-ai/dsh-workflow-worker-thread`。该包在 0.1.6 已删除，`packages/workflow/` 下现在是 `workflow` / `workflow-ptc` / `tool-workflow` / `tool-ralph`。对照 0.1.6 的 shipped `standard`，这是一次整行替换：

```diff
-    - id: workflow-worker-thread
-      name: '@deepseek-ai/dsh-workflow-worker-thread'
+    - id: workflow-ptc
+      name: '@deepseek-ai/dsh-workflow-ptc'
       config:
         provider: spawn
```

⚠️ **不能提前单独改**：`workflow-ptc` 在 rc.2 上不存在，提前替换会立刻让该 preset 在**当前**版本坏掉。必须与 checkout 新 tag 同一步完成。

该 preset 与 shipped `standard` 的全部差异只有 2 个 hunk（1 行注释 + 整个 `# ── shell` 段的一次性 shell → 常驻 shell 替换），其余 220+ 行逐字节相同 —— 所以这次替换之后，建议顺手把差异固化成 patch 或生成脚本，避免下次升级再手工找。`workflow-worker-thread` 位于公共段，重新同步一次即可自动跟上游。

### P0-2 `tool-ralph` 在新 `standard` 中默认关闭

0.1.6 的 `standard` 给 `tool-ralph` 加了 `disabled: true`。若本部署依赖 ralph，需在自建 preset 中显式保持开启。

### P0-3 工作区必须干净

- 本插件仓库存在**未提交改动批次**（含 `src/` 新增文件与 `CHANGELOG.md`）。升级前先按提交约定落成一个 commit，否则回滚时无法干净地回到「升级前」。
- `git status` 需确认没有 `.bak.*` 之类的意外文件进入提交。

### P0-4 备份

```sh
# DSH 侧
cd <dsh-checkout>
git rev-parse HEAD                 # 记录回滚点（应为 dsh-v0.1.5-rc.2）
cp -a <dshHome>/settings.yaml       <dshHome>/settings.yaml.pre-0.1.6
cp -a <dshHome>/profiles/web/package.json  <dshHome>/profiles/web/package.json.pre-0.1.6
cp -a <dshHome>/profiles/web/cordis.yml    <dshHome>/profiles/web/cordis.yml.pre-0.1.6
cp -a <dshHome>/profiles/web/cordis.patch.yml <dshHome>/profiles/web/cordis.patch.yml.pre-0.1.6
cp -a <dshHome>/.agent-presets      <dshHome>/.agent-presets.pre-0.1.6
```

会话日志不必备份（格式未变），但若在意，`<dshHome>/sessions` 可整体快照。

### P0-5 关掉会话日志上传（否则长会话必坏）

0.1.6 把 `@deepseek-ai/dsh-session-log-deepseek` 的 `enabled` 默认从 `false` 翻成 `true`，于是每个请求体都会挂上**无上限**的 `dsh_session_log`（= 会话日志后缀，与进模型的 surface 无关）。任何历史长会话在升级后的**第一个**请求就会把整段日志一次性上传；超过边缘 48 MiB 上限即 413，而水位线只在 2xx 后才前进 —— 于是**每个**请求都 413，永久卡死（详见 §8 F2）。

```yaml
# <dshHome>/profiles/web/cordis.patch.yml
- id: session-log-deepseek
  config:
    enabled: false
```

⚠️ 必须走 overlay 行：该插件没有声明 settings section，写 `<dshHome>/settings.yaml` 的 `session-log-deepseek:` 段**不生效**。若确实想保留上传，须先在小会话上跑一次建立水位线。

**它是什么**（上游设计笔记 `.agents/notes/implemented/architecture/2026-09-14-session-log-upload-default.md`）：

- **对推理零作用**：字段在 `messages`/system/tools 之外，模型看不到，0 输入 token，不影响 KV cache。上下文（surface）已经够模型用了。
- **它要的是上下文刻意丢掉的那部分**：普通请求的 `messages` 是**有损投影**（压缩把区间遮蔽掉），而 OTel 那条路"刻意丢弃大多数 assistant 分片"，所以官方 API 无法从任一现成通道重建完整 harness 轨迹 —— 这就是该字段存在的理由。本会话的对比很直观：surface 1.24 MiB / 448 节点，而这个字段 85.63 MiB / 26,844 事件。
- **不投影、不脱敏**：笔记原文「`events` 数组会直接包含完整的权威 `SessionEvent` 对象。发送方会复制事件的每个已有成员，**不执行投影或脱敏**」；后果段则明列发送内容为「消息文本、工具参数与结果、**工作区路径**和反馈」，并承认「**请求正文可能显著增大，提供方拒绝仍会使请求失败**」—— 本次故障正是这句话的实例。
- 同一套 seam 还默认开启 `dsh_plugin_packages`（本机存活插件包的精确版本 = 构建指纹）与 `x-deepseek-harness-user-id`（每个 harness home 一个稳定 UUID）。关闭 OTel **不会**关闭这些。

## 3. 升级步骤

### 阶段 1 —— 停服务（推荐）

本机 DSH 以源码方式运行（`node --import tsx/esm apps/cli/src/bin.ts web ...`）。`pnpm install` 会重写 `node_modules`，而运行中的进程仍可能动态 import 尚未加载的模块，拿到不一致的版本。因此**不要用「延迟 20 秒重启」跨越 install 阶段**；窗口内直接停：

```sh
systemctl --user stop dsh
systemctl --user show -p MainPID --value dsh   # 期望 0
```

（若确实不能停机，则退而求其次：阶段 2/3 全部做完之后再延迟重启，并接受中途 import 不一致的风险 —— 但这时**不要**在脚本里做重启后自检，见「关键坑 14」。）

### 阶段 2 —— DSH 源码升级

```sh
cd <dsh-checkout>
git fetch --tags --prune origin
git checkout dsh-v0.1.6-alpha.1
git status --porcelain                 # 期望只剩 worktree 类的未跟踪目录

# 全新安装（不能增量：内置 loader 0.1.4 → 0.1.6，且移除了 linkWorkspacePackages）
pnpm install

# 清掉陈旧的 tsc 增量状态，否则可能跳过重编
find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
rm -rf apps/web/dist

# ⚠️ 必须是【完整】构建，不是 build:native-system
pnpm run build                          # = native-system + lib:host + lib:client + web

# 硬门槛：确认 F1 产物存在，缺任何一个都不要启动（见 §8 F1）
for f in packages/api/terminal-controller/lib/client.js \
         packages/client/ui-sidebar-terminal/lib/client.js \
         packages/client/ui-settings-unarchive-sessions/lib/client.js \
         packages/interaction/permission-presets/lib/typert.host.js \
         packages/api/terminal-controller/lib/typert.host.js; do
  [ -f "$f" ] || { echo "MISSING $f"; exit 1; }
done

# 冒烟
node --import tsx/esm apps/cli/src/bin.ts --version
```

**验证点**：`pnpm install` 无 peer 冲突报错；`pnpm run build` 退出码 0；上面 5 个产物全部存在；`--version` 输出 `0.1.6-alpha.1`。

> 实测：`pnpm install` 约 3s（store 已缓存），**完整 `pnpm run build` 约 105s**。别用 `build:native-system` 顶替——它只产 `native/system` 的原生件，不产 `lib/`，首轮就是这么崩的。

### 阶段 3 —— 插件依赖升级与全量重验

```sh
cd <plugin-repo>

# 1) P0-1 / P0-2：自建 preset 与升级同步修改（见 §2）
#    <dshHome>/.agent-presets/persistent/agent.cordis.yml
#    workflow-worker-thread → workflow-ptc；按需保留 tool-ralph

# 2) 依赖范围整体上移一个 tuple（关键坑 17）
#    peerDependencies：18 个 @deepseek-ai/dsh-*（不含 @deepseek-ai/cordis）
#    devDependencies ：同上 16 个 + @deepseek-ai/dsh-client-ui-primitives
#    ^0.1.5-alpha.1  →  ^0.1.6-alpha.1
#    保持不动：@deepseek-ai/cordis ^4.0.1、@deepseek-ai/schemastery ^3.18.1

# 3) 必须删 lockfile：当前 lockfile 把依赖锁死在 0.1.5-alpha.1，只改范围不会动它
rm -rf node_modules package-lock.json
npm install
node -e "for (const p of ['dsh-session','dsh-llm','dsh-commands']) console.log(p, require('./node_modules/@deepseek-ai/'+p+'/package.json').version)"
# 期望：三个都是 0.1.6-alpha.1

npm run typecheck
npm run test
npm run build
```

**验证点**：
- `typecheck` 0 错误（这是本次升级的真正判据 —— 它会把 §1.3 之外的隐藏导出漂移全暴露出来）
- `test` 基线是 **354 passed / 30 files**，不得下降
- `build` 产出新的 `lib/index.js` 与 `client/client.js`
- 新增依赖范围在 `package-lock.json` 中确实解析到 `0.1.6-alpha.1`

**若 typecheck 报错**：说明 §1 的扫描漏了某个导出，按错误逐个修正后更新本文档的 §1。

### 阶段 4 —— 启动与加载验证

```sh
systemctl --user start dsh
sleep 8
systemctl --user show -p MainPID --value dsh    # 非 0
journalctl --user -u dsh -n 60 --no-pager | grep -iE "error|failed|already registered|fatal"
```

**验证点（逐条，缺一不可）**：

1. journal 无 `error|failed|already registered|fatal load failure`
2. 出现 web 监听日志（`dsh web: http://127.0.0.1:...`）
3. `<dshHome>/profiles/web/cordis.yml` 合成成功，且其中仍有 `lark-channel` 行 —— 这是 §1.6 那个风险点的**决定性检查**
4. 飞书侧通道起来（journal 无 WebSocket 反复重连）

### 阶段 5 —— 功能回归

| # | 功能 | 检查方式 |
|---|---|---|
| 1 | 基础对话 + 步骤卡 | 发一句话，确认 per-step 卡片、footer 指标、Turn Complete 卡都正常 |
| 2 | 斜杠命令 | `/help` `/status` `/lang` |
| 3 | 权限卡片 | `/permission` 发卡 → 点一个模式 → 卡片更新；**并确认失败时是卡片报错而不是 dsh 退出**（关键坑 24） |
| 4 | 会话面板 | `/session list` / `/session` 面板 / 改名 |
| 5 | 新建流程 | 完整走一遍 `/new`（工作区 → 预设 → 模型 → 确认卡）；该流程自上次修复后未重新验证，本次一并补 |
| 6 | 图片收发 | 图片消息（应先确认模型声明了 `input: [image]`） |
| 7 | 文件收发 | `feishu_send_file` / 入站文件 |
| 8 | 审批与提问卡片 | 触发一次审批，确认飞书卡与 WebUI 双端语义仍在 |
| 9 | 子代理 / 工作流 | 若自建 preset 调用了 `workflow-ptc`，跑一次确认不再引用被删包 |

## 4. 回滚方案

任一阶段失败都可回滚；回滚**必须整体做**（DSH 源码 + 插件依赖 + preset 三者同步）。

```sh
systemctl --user stop dsh

cd <dsh-checkout>
git checkout dsh-v0.1.5-rc.2
pnpm install
pnpm run build:native-system

cd <plugin-repo>
git checkout <升级前 commit>
rm -rf node_modules package-lock.json
npm install
npm run build

# 恢复配置
cp -a <dshHome>/settings.yaml.pre-0.1.6                <dshHome>/settings.yaml
cp -a <dshHome>/profiles/web/package.json.pre-0.1.6    <dshHome>/profiles/web/package.json
cp -a <dshHome>/profiles/web/cordis.yml.pre-0.1.6      <dshHome>/profiles/web/cordis.yml
cp -a <dshHome>/profiles/web/cordis.patch.yml.pre-0.1.6 <dshHome>/profiles/web/cordis.patch.yml
rm -rf <dshHome>/.agent-presets && cp -a <dshHome>/.agent-presets.pre-0.1.6 <dshHome>/.agent-presets

systemctl --user start dsh
```

⚠️ **`pnpm install` 必须重新跑**：内置 loader 与 workspace link 语义在两个 tag 间不同，只 checkout 而不重装会得到一个混合状态。

## 5. 风险登记

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 自建 preset 引用被删包，会话无法创建 | 高（确定会发生） | P0-1，与升级同步改；失败时 preset 会以 broken 行列出并给出原因，不会静默半加载 |
| R2 | boot / profile 解析重构影响 `link:` + `bundle.patch` 挂载路径 | 中高 | **实测已过**：0.1.6 新增 `packages/boot/app-boot/src/profile-resolution/`（rc.2 无此目录），`$DSH_HOME/profiles/node_modules` 是指向工作区的符号链接投影、不需要手工刷新；关键是**必须先完成完整构建**（§3 阶段 2 的硬门槛），否则 `./typert` 入口会缺 `lib/typert.host.js` |
| R2b | 源码态直接跑（`tsx`）在 0.1.6 起不再自足：新增 `lib/client.js` 与 `./typert` 产物 | **高（确定会发生）** | 与升级同步执行**完整** `pnpm run build` + 产物硬门槛校验；只跑 `build:native-system` 必然首启崩溃（§8 F1） |
| R2c | 旧版本升上来的长会话被 `dsh_session_log` 一次打爆（永久 413） | **高（确定会发生）** | P0-5：升级前在 profile overlay 里 `session-log-deepseek.enabled: false`（§8 F2） |
| R3 | 增量 install 留下混合的 node_modules | 中 | 阶段性删除 `node_modules`；DSH 侧 `pnpm install` 前先 `git checkout` 到干净 tag |
| R4 | 目标为 alpha 版本 | 中 | 保留完整回滚点（P0-4）；建议等 rc 后再作为常规节奏 |
| R5 | 未提交的插件改动让回滚不干净 | 中 | P0-3 |
| R6 | 插件 lockfile 长期落后（锁在 `0.1.5-alpha.1`，运行时是 rc.2） | 低 | 本次一并提到 `0.1.6-alpha.1`，消除 typecheck 与运行时的版本差 |

## 6. 升级后的对齐机会（非本次必须，记录备查）

| # | 机会 | 依据 |
|---|---|---|
| C1 | 权限模式标签改为读 `permissionPresets.catalog()` / `optionOf()` | 插件当前在 `src/feishu-permission.ts` 硬编码三档标签与配色；0.1.6 提供了投影接口，可自动跟上 DSH 命名 |
| C2 | `AUTO_PRESET`（`auto`）目前插件不识别 | 仅在部署注册了 live Auto 集成时才出现在目录中；若届时出现，插件需决定是展示还是过滤 |
| C3 | 新的 shipped 预设 `ptc` / `cordis` | `/new` 的预设列表会自动带上，无需改码；但文档中的预设说明需要同步 |
| C4 | 自建 preset 的差异固化 | 见 P0-1 结尾 |

## 7. 未决问题

1. 升级窗口：现在（alpha）还是等 rc？本文的评估在任一时点都成立，成本主要是重跑一遍阶段 3-5。
2. 停机窗口能否接受（阶段 1 的推荐做法）？若必须在线完成，需要额外评估混合 `node_modules` 的风险。
3. `tool-ralph` 在本部署是否需要保持开启（P0-2）。

## 8. 首次升级失败复盘（2026-09-15，已回退）

脚本层面**完整成功**：`git checkout dsh-v0.1.6-alpha.1` → `pnpm install` → `build:native-system` → 插件 `npm ci` + `build` → preset 迁移 → 起服务，全程约 14 秒，日志无 `FAILED`、无回滚（日志见 `~/dsh-upgrade-0.1.6.log`，117 行）。

但它**没有可用**，两个独立原因，本文档初稿都漏了：

### F1 启动缺构建产物（首启直接崩溃）

```
dsh: plugin tree failed to load: required startup failure: 1 entry did not activate
client-modules: 3 client packages failed to compose:
  client bundle not found; run `pnpm run build` before launch:
  - packages/api/terminal-controller/lib/client.js
  - packages/client/ui-sidebar-terminal/lib/client.js
  - packages/client/ui-settings-unarchive-sessions/lib/client.js
```

systemd 重启后仍带警告 `2 entries did not activate`：`@deepseek-ai/dsh-permission-presets` 与 `@deepseek-ai/dsh-api-terminal-controller` 的 `./typert` 入口，报 `Cannot find module '.../lib/typert.host.js'`。

- **根因（两半其实是同一个）**：本部署用 `tsx` 直接跑源码，从未执行过仓库级 `pnpm run build`；0.1.6 新增了若干 `lib/client.js` 与 `./typert` 产物，源码运行不再自足。**三处报错都只是"产物没构建出来"，不是"包版本陈旧"**。
- ⚠️ **曾经的错误结论（已更正）**：一度认为 `~/.dsh/profiles/node_modules` 是"0.1.5-rc.2 的发行版副本、缺 `lib/typert.host.js`"，因此打算刷新该目录。**错**。实测该目录里 `@deepseek-ai/dsh-*` 全是指向**工作区的符号链接**（`dsh-session-log-deepseek -> <repo>/packages/session/session-log-deepseek`，全目录仅 1.4 MB）；报错路径里的 `apps/cli/node_modules/@deepseek-ai/dsh-base/node_modules/...` 也只是链路中间段，`readlink -f` 最终落在工作区。所以读到的 `0.1.5-rc.2` 只是**当前 checkout 的 workspace 版本**，一旦升到 0.1.6 它就自动变成 0.1.6——**该目录不需要动**。
- **补法**：阶段 2 用完整的 `pnpm run build`（= `build:native-system` + `build:lib`(host&client) + `build:web`），**并加产物校验**：升级脚本必须在启动前确认 F1 那三个 `lib/client.js` 与两个 `lib/typert.host.js` 都存在，缺失即回滚、绝不启动。
- ⚠️ 只跑 `build:native-system` 是**不够的**（首轮就是这么失败的）：它只产 `native/system` 的原生件，不产 `lib/`。
- §3 阶段 2 与 §5 R2 已据此更新。

### F2 会话被无上限的 `dsh_session_log` 上传字段撑爆（413）

现象：升级后该会话完全不可用，每次请求都失败。会话日志里三次 turn 全部为：

```json
turn/end  {"kind":"error","error":{"message":"DeepSeek Messages request failed (413)","code":"INVALID_REQUEST","status":413}}
```

连 `compaction/start` 的压缩请求本身也是 413。

**根因**：0.1.6 把 `@deepseek-ai/dsh-session-log-deepseek` 的 `enabled` 默认值从 `false` 翻成了 `true`：

```ts
// packages/session/session-log-deepseek/src/index.ts
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),   // rc.2 为 default(false)
})
```

该插件向**每一个** DeepSeek 请求体挂一个顶层字段 `dsh_session_log`，内容是**会话日志（canonical log）的后缀**——原始事件、未压缩、含全部工具结果，与进模型的 surface 无关。它也与协议无关：`protocols/chat-completions/adapter.ts` 与 `protocols/messages/adapter.ts` 都会调 `prepareRequestExtensions`。

水位线存在日志自身的 `session-log-deepseek/delivery-accepted` 事件里，没有则为 `-1`。rc.2 从未注册过这个字段，所以本会话**一条 acceptance 事件都没有**（实测 0 / 26,844）。于是升级后第一个请求按 `afterSeq = -1` 取 `snapshotEvents(0)`，**把整段日志一次性塞进请求体**：

```ts
const afterSeq = acceptedThrough(session)                              // -1：无 acceptance 时
const suffix = session.snapshotEvents(SessionLogOffset(afterSeq + 1))  // 全量
const value = { version: 1, afterSeq, throughSeq, events: suffix.map(wireEvent) }
```

本会话实测 **26,844 个事件 → 85.63 MiB**（按 `wireEvent()` 重建后的 JSON 体积；磁盘解压 85.39 MiB）。模型输入只有约 1.0 MiB —— **请求体几乎全由这个旁路字段构成**。

API 边缘（openresty）的请求体上限是 **48 MiB**，超限返回 **413**。`accept()` 只在 HTTP 2xx 之后调用，因此水位线**永不前进**，下一个请求重建出**完全相同**的 85.63 MiB —— 每个请求都 413。插件自己的 README 就写着这个失败模式：

> **No independent request-size cap** — complete delivery is fail-closed; provider rejection leaves the cursor unchanged instead of truncating the log.

压缩救不了它：字段取自 `session.snapshotEvents()`（append-only 的完整日志），不是 surface。所以 16:14 那次 `compaction/start` 也带着同样的 85 MiB 一起 413。

**为什么"同样的上下文"是个陷阱**：上下文从未参与判定。请求体 99% 是这个旁路字段，而 48 MiB 的判定发生在边缘、在解析 JSON 之前。

**证据链**

1. 报错文案 `DeepSeek Messages request failed (413)` 只在 `protocols/messages/transport.ts` 里生成，且**只有 provider 错误体里没有 `error.message` 时才会回退到这句话**——即 413 来自边缘而非模型 API（响应体是 openresty 的 HTML 页）。
2. **复现**：对两个端点各发"一条 user 消息 + 一个大 filler 字段"的请求体，与模型输入无关：

   | body | messages | chat-completions |
   |---|---|---|
   | 32 MiB | 200 | 200 |
   | 40 MiB | 200 | — |
   | 47.5 MiB | 200 | — |
   | 48 MiB | **413** `Failed to buffer the request body: length limit exceeded` | **413** |

3. **天然对照（决定性）**：升级窗口内（15:46–16:46）另一个**新建的**小会话（16:11:58 创建，21 个事件）成功上传，并写下 2 条真实的 `session-log-deepseek/delivery-accepted`（`throughSeq: 15`）。同一个进程一边给 16 个事件的会话放行，一边把 85 MiB 的会话打回 413。这两条事件本身就是"0.1.6 的插件代码（默认 `true`）确实被加载"的铁证——残留的旧副本默认 `false`，永远不会写它。
4. 只有本会话坏掉：全库 7 份 v3 日志里只有它（85.4 MiB）超过 48 MiB；另一份 19.3 MiB 低于上限，正常。

**已排除 / 已更正的解释**

| 假设 | 结论 |
|---|---|
| ~~端点被换到 `/anthropic` 是根因~~ | **错**。端点确实换了（见下），但 `protocol: chat-completions` 救不了：该字段对两种协议都注入，实测两个端点在同样体积下同样 413 |
| 压缩后的 surface 没生效 → 全量历史进请求 | 用两个 tag 的 `foldSurface` 跑同一份日志：448 节点 / 1.24 MiB，两版一致；且它与该字段无关 |
| 历史图片内联 | surface 里 0 张图、0 个文件 |
| 消息 / 工具体积过大 | 实测约 1.0 MiB 消息 + 29 KiB 工具 |

> ⚠️ 初稿为什么判错：上一轮所有探针都只重放**模型消息**，从未带上 adapter 附加的旁路顶层字段——重建出的请求自然永远进得去，于是注意力被引到了协议/端点上。教训：**排查"请求过大"时必须 dump 真正发出的 body，而不是重建模型输入。**

**仍然成立、但要降级的旁路事实**：0.1.6 新增了 `protocol` 开关且默认 `messages`（`https://api.deepseek.com/anthropic/v1/messages`），rc.2 只有 `${baseURL}/chat/completions`。本部署 `settings.yaml` 没有 `protocol` 键，所以升级确实会静默换端点。这是一处**独立**的行为变化，不是本次故障的原因，但升级时仍值得显式固定：

```yaml
# ~/.dsh/settings.yaml
llm-deepseek:
  protocol: chat-completions
```

`llm-deepseek` 走 `settings.installSection(ctx, 'llm-deepseek', Config, config, …)`，所以该段有效；但 `protocol` 在 rc.2 的 schema 里不存在，必须与升级同一步写入。

**升级前必须加的前置项（P0-5）**

在 profile overlay 里关掉会话日志上传：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: session-log-deepseek
  config:
    enabled: false
```

- 必须走 overlay 行、**不能**走 `settings.yaml`：`session-log-deepseek` 没有声明任何 settings section（与 `llm-deepseek` 不同），写 `session-log-deepseek:` 段不会生效。
- base bundle 的契约是"patch 整块替换该行的 `config`"，而 `enabled` 是它唯一的字段。
- 想让上传继续工作的替代做法：先在小会话上跑一次以建立水位线；否则它会对**任何**历史长会话一次打爆。
- 值得报给上游的真问题：**默认开启 + 无体积上限 + fail-closed**，会让任何从旧版本升级、且带着长会话的部署永久卡死。

**首次回退做法（已执行）**：`git checkout dsh-v0.1.5-rc.2` + 重启；自建 preset 与 `settings.yaml` 由 `.pre-upgrade-0.1.6` 备份恢复。

## 9. 第二次升级：成功（2026-09-15）

**与首轮唯一但决定性的区别**：把「完整构建 + 产物校验」做成启动前的硬门槛。首轮只跑了 `build:native-system`，于是首启崩在缺 `lib/client.js` / `lib/typert.host.js` 上。

### 做法

1. **先在独立 worktree 里预演**（`git worktree add` + `pnpm install` + `pnpm run build`），确认完整构建能产出全部 F1 产物再动生产树。这一步立刻抓出两个问题：
   - 我自己脚本的 bug：`pnpm run build --reporter=…` 会把 `--reporter` **转发进** `tsx scripts/build.ts`，而它的 `parseArgs` 只认 `--profile`，直接抛 `ERR_PARSE_ARGS_UNKNOWN_OPTION`。`pnpm run <script>` 后面别放 pnpm 自己的开关，改用环境变量。
   - 实树里有 **303 个陈旧 `.tsbuildinfo`**，不清掉可能让 `tsc -b` 跳过重编 → 脚本里显式清理并删 `apps/web/dist`。
2. 升级脚本用 `systemd-run --user --collect --unit=… --property=Type=oneshot --property=TimeoutStartSec=infinity` 脱离 dsh 自己的 cgroup 执行；注意 `oneshot` 默认 90s 启动超时而本流程要 ~220s，**务必显式放开**，否则会被 systemd 中途杀掉。
3. 硬门槛顺序：`pnpm run build` 退出码 → 5 个 F1 产物存在 → `apps/web/dist` 存在 → 插件 `npm run build` 产出 `lib/index.js` + `client/client.js` → preset 迁移。**任一不过即回滚，绝不启动。**
4. 启动后校验：服务 active、boot 日志无 `did not activate` / `client bundle not found` / `plugin tree failed to load`、`dsh web` 行出现；不过即回滚。
5. 插件侧**刻意不跑 `npm ci`**：`node_modules` 已是 0.1.6 且与 lockfile 一致，而 `npm ci` 会先删除 `node_modules`；一旦网络失败，回滚后的旧版本会拿不到插件依赖。只重建产物。

### 实测数据

| 项 | 值 |
|---|---|
| 停机窗口 | 20:18:49 停 → 20:20:42 起，**约 2 分钟** |
| `pnpm install` | 3s（store 全命中） |
| **完整 `pnpm run build`** | **104s** |
| 产物 | `lib/client.js=61`、`lib/typert.host.js=18`、`lib/*.js=2327`、`apps/web/dist` 存在 |
| boot | 零 warning、零 error |
| 回滚锚点 | `fb2c4b9e698e30edb738bca4cf0618587db7d203` |

### 升级后验证（可复现判据，不是"看起来能跑"）

- **F1 已消**：boot 日志全量无激活/产物失败。
- **P0-5 已生效**：扫描全部会话日志顶层 `session-log-deepseek/delivery-accepted` 事件，升级（20:20:42）之后 **0 条**；而失败那轮在 16:11:58 有过 2 条。字段与水位在同一处注册，无水位 ⇒ 字段未注入 ⇒ 不再外送整段日志。
- **413 已消**：长会话（原受害者）日志中 3 条 413 全部落在旧窗口 15:59:10 / 16:06:21 / 16:06:43；升级后至今 **0 条错误 turn**，且该会话正在正常多轮对话。
- ⚠️ 解析判据时注意：`turn/end` 的错误在 `data.reason.error`，不是 `data.error`——写错会得到"0 条 413"的**假阴性**。

### 升级后插件全量回归（在真实 0.1.6 运行环境上执行）

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（host + client 两套 tsc） | **exit 0**，零输出，3s |
| `npm run test`（vitest） | **exit 0，30 files / 354 tests 全通过**，6s |
| 与升级前基线对比 | **完全一致**（354 / 30），无回归 |
| 产物 | `lib/index.js` 380187 B、`client/client.js` 59865 B（升级时重建） |
| 运行时 | `apply()` 正常挂载（`sessionController`/`userQuestions`/`approval` 全部 available）；飞书实测消息正常产出步骤卡（send/update 成功） |
| 客户端半边 | Web shell `HTTP 200`、含 `__DSH_BOOT__`，客户端模块清单里出现 `"@starxer/chatterbox4dsh"`；journal 无 `client-modules` / 组合失败 |

> 读测试日志时注意：里面出现的 `reconcile failed: …` / `moves to an error state when …` 是**测试用例刻意构造的失败路径**的 stdout，不是失败；判据只看 `Test Files / Tests` 汇总与退出码。

### 收尾（✅ 已完成）

- 插件仓库的 `package.json` / `package-lock.json`（已升到 `^0.1.6-alpha.1`）与本文档**已随对应的兼容批次提交**。
