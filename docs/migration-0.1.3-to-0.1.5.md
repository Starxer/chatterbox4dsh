# 升级评估：DSH 0.1.3-alpha.2 → 0.1.5-alpha.1

> **来源**：DSH release tag `dsh-v0.1.5-alpha.1`（2026-09-08 发布）。本文基于 `dsh-v0.1.3-alpha.2..dsh-v0.1.5-alpha.1`（**563 个 commit**）分析。
>
> **结论**：插件**无需改代码**。typecheck / 266 tests / build 全绿；插件 import 的全部 16 个 `@deepseek-ai/dsh-*` 包公开 API 逐项 diff 无变化。**唯一必改项**是 `package.json` 的依赖范围（见下）。
>
> **English**: DSH `0.1.3-alpha.2` → `0.1.5-alpha.1` (563 commits). The plugin needs **no code changes**; the only required edit is the `@deepseek-ai/dsh-*` dependency range in `package.json`.

## 必改项：依赖范围

`peerDependencies` / `devDependencies` 的 `@deepseek-ai/dsh-*` 必须从 `^0.1.3-alpha.1` 升到 **`^0.1.5-alpha.1`**。

**原因**：npm semver 的预发布规则要求「带预发布标签的范围只匹配同一 `major.minor.patch` 的预发布版本」。实测：

```js
semver.satisfies('0.1.5-alpha.1', '^0.1.3-alpha.1')  // false
semver.satisfies('0.1.5-alpha.1', '^0.1.5-alpha.1')  // true
```

所以旧范围在 `npm ci` 下仍会装到 `0.1.3-alpha.2`，不会自动跟上 0.1.5。**每次 DSH 预发布版本跳跃都要同步升这个范围**（0.1.2→0.1.3 时同理）。

## DSH 侧关键变更

### 会话日志格式 V2 → V3（`SESSION_FORMAT_VERSION = 3`）

这是本次升级唯一有实际成本的变更：

- **事件 envelope 规范化**：`system/message`、`user/message`、`assistant/message`、`tool/result` 必须带 `surfaceOp`；其余 log-only 事件只允许 `type` / `seq` / `time` / `data` / 可选 `ignorable`。
- **系统提示词变成 surface 节点**：`request/header.header.system` 被移除，改用 `system/message` 事件（surface node 0）。读取 `request/header` 里系统提示词的代码需要改走 `system/message`——**本插件不读该字段，不受影响**。
- 附带 `@deepseek-ai/dsh-session-format-v2-to-v3` 迁移包；**升级后首次启动会自动迁移已有会话日志**（V2 → V3），保留事件顺序与时间戳。

### 事件词汇

- 新增 `system/message`。
- `tool/code-dispatch` → **`tool/ptc-dispatch`** 改名（本插件不处理该事件）。
- 插件订阅的 `assistant/message` / `tool/call` / `tool/result` / `step/start` / `turn/start` / `turn/end` / `request/header` / `request/context` / `session/title` / `todo/write` 全部仍在 V3 已知事件列表中；`assistant/chunk` 已彻底移除（插件保留的分支是死代码，无害）。

### 其他

- `@deepseek-ai/dsh-agent` 不再 `export * from './inbox.ts'`（插件只用 `Agent` / `ModelSelection`，不受影响）；`AgentSetup` 签名新增第二个 `agent` 参数；新增 `parentAgent` 选项。
- `dsh-llm` 新增 `SystemPromptUpdate` 类型与 `systemPromptUpdate` 字段（纯增量）。
- 桌面端 electron、worktree 侧栏、slash 命令 i18n、goal 恢复等新功能，与插件无交互。

## 插件兼容性核验方法

1. **依赖 API diff**：把插件源码复制到临时目录，依赖范围改 `^0.1.5-alpha.1` 后全新 `npm install`，对 16 个 `@deepseek-ai/dsh-*` 包的 `package.json#exports`、入口 `.d.ts` 的导出符号与 `export {}` 再导出逐项 diff——全部为 0 差异。
2. **编译与测试**：`npm run typecheck` / `npm run test`（266 passed）/ `npm run build` 全绿。
3. **服务名 pre-flight**：插件 `ctx.get()` / `inject` 用到的 18 个服务名（`agents` / `sessions` / `sessionController` / `sessionPersistence` / `agentDefaultModel` / `agentPresets` / `workspaceRegistry` / `settings` / `credentials` / `webServer` / `commands` / `llm` / `attachments` / `directoryPicker` / `sandboxPolicy` / `permissionPresets` / `userQuestions` / `approval`）在 0.1.5 源码里全部原样存在；`apiProxy` 已移除且插件本就按可选处理。
4. **事件词汇**：对照 `packages/core/session/src/known-event-types.ts` 的 V3 已知集合。
5. **自建 preset**：两个版本间 shipped preset 内容零改动、`dsh-persona` 的 Config 未变，本机从 `standard` 复制出来的 `persistent` preset 仍有效。

## 宿主升级步骤（本机部署）

```sh
# 1) 备份运行配置（.credentials.yaml 可能被新版迁移格式）
cp ~/.dsh/.credentials.yaml  <备份目录>/
cp ~/.dsh/settings.yaml      <备份目录>/
cp ~/.dsh/profiles/web/cordis.patch.yml <备份目录>/

# 2) 切到新 tag 并重建
cd <DSH 源码目录>
git checkout dsh-v0.1.5-alpha.1
pnpm install
pnpm run build          # pnpm install 不会自动 build 新增包的 lib/ 产物

# 3) 重启（会中断运行中的 turn）
systemctl --user restart dsh
```

**风险**：首次启动会迁移已有会话日志 V2 → V3。回退时用旧 commit `git checkout <旧 commit>` → `pnpm run clean` → `pnpm install` → `pnpm run build` → 重启（`clean` 是必须的，否则旧 `lib/` 产物会引用已删符号）。

## 验证清单

- `journalctl --user -u dsh -n 50`：无 `error` / `failed` / `already registered` / `pending (waiting for service`。
- 插件仍挂载（DSH Settings → 飞书与 Lark 可读配置，或飞书里发一条消息收到回复）。
- 老会话仍能 `/session` 列出并继续对话（验证 V2→V3 迁移）。
