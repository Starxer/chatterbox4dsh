# dsh-feishu TODO

> 定位见 [README.md](./README.md)：**把 DSH 的原生特性接入飞书，而非再造一个 agent 平台/助手**。
> 状态：`已有` ✅ / `部分` ⚠️ / `待实现` 🔲 / `规划中` 📋 / `待调研` 🔍

---

## ⬜ 未完成清单（2026-09-23 逐条核实）

> **这是唯一的未完成台账。** 下面各历史章节里的「未动工 / 只剩一条」等字样可能已过期，**以本表为准**。
> 核实方式：每条都在当期 `src/` 里 grep / 读代码确认过，不采信文档里的旧结论（旧结论正是本次要修的东西）。
> 分类：**功能缺口**（用户可感知）→ **上游阻塞**（我们能做的都做完了）→ **可选项**（无明确需求）→ **开发卫生**。

### 功能缺口

| # | 项 | 优先级 | 状态与出处 |
|---|---|---|---|
| O1 | **思考期占位卡（方案 A）** | 中 | ✅ **已实现并生效（2026-09-23，11:38 重启后实测；使用者已目视确认）**。`step/start`（模型请求发出前）立即发「🧠 深度思考中…」占位卡，并按 5s 刷新已用时；`assistant/message` / `tool/call` / `tool/result` 全部在**同一张卡**上就地更新；某步最终没有可显示内容时在 `step/end` 折叠为「本步无输出」。四个边角（占位态渲染、`stepHasVisibleContent` 放行、无内容步的去留、i18n）按原方案处理；方案 B（逐字流式）仍不做，见下文「已知问题 → 思考期无反馈」。**生效证据**：journal 出现 `[message] card already sent for this step → updating`（卡片在模型消息落地前已在屏上——旧路径下首卡只会在 `assistant/message` 或首个 `tool/call` 时发出），探针另抓到「🧠 深度思考中… → 工具调用 → 工具完成」同一张卡的四阶段连续状态 |
| O2 | **`/subagents` 子代理卡片命令** | 中 | 🔲 **未实现**（`src/` 内无该命令，只在历史 `.bak` 文件里留有注释）。数据源 `ctx.subagents.listChildren` / `listDescendants`；与 rc.1 评估的 **C2** 是同一件事。**与 O10 共用数据源与渲染，建议一并实现** |
| O3 | **补 `produced` 交付物**（write/edit 成功改过的文件） | 中 | 🔲 **未实现**。插件只订阅 `deliverables/presented`（[`feishu-streaming.ts:1122`](./src/feishu-streaming.ts)，行号按 2026-09-23 的 `src/` 重核），WebUI 的 produced 那一半没有对应物 → 实测 **32%（18/56 轮）** WebUI 有产物行而飞书完全没有。同节另两个缺口：complete 卡只对**飞书触发的**轮次发（唯一发送点 [`channel.ts:525`](./src/channel.ts)）；`renderReplyCards` 的 else 分支不带 `turnStats`（交付清单与指标整块不渲染） |
| O4 | **残留的就地更新上限（带按钮的卡）** | **高**（交互可靠性） | 🔲 **仍在**（2026-09-23 二轮复核：全仓 `updateCard` / `updateCardInstance` **22 处实际调用**（另 3 处是能力探测）逐个过了一遍，行号按当前 `src/` 重核）。**会被反复点到失效的 3 张卡**：① `/session` 管理面板卡——[`feishu-session.ts:397`](./src/feishu-session.ts)（`action==='refresh'`）与 [`:439`](./src/feishu-session.ts)（`op==='pin'/'unpin'`）就地重绘**同一张卡**，即「🔄 刷新」「📌 置顶」「📍 取消置顶」三个按钮**共用同一份额度**，点到 2–3 次后整张面板的按钮（含切换/归档/分叉）一起不再回调；② `/model`（无参）选择向导卡——[`feishu-model-select.ts:590`](./src/feishu-model-select.ts) 的 `cardByMessage` 逐次 `updateCardInstance`（定义在 `:573`，调用点 `:646` `:660` `:742` `:748` `:802`，含 provider→model→确认→成功各步），**整条向导是一张卡**；③ `/new` 的模型步骤复用同一个向导（provider 卡在 `index.ts:830` 新建 → 点 provider = 更新 1 → 确认后 `retireModelCard`（`index.ts:754`）再改写 1 次 = 更新 2，已到 2–3 次边缘）。**同类但更轻的 2 张**（每次点击就地重绘、重绘后按钮仍在）：[`feishu-busy.ts:105`](./src/feishu-busy.ts) 的 `/busy` 卡（2 个按钮、当前项 disabled，有效点击上限本就 1–2 次）、[`feishu-permission.ts:216`](./src/feishu-permission.ts) 的 `/permission` 卡（3 个模式同理）。**其余 12 处是一次性终态改写**（审批卡、问答卡 settle、`card-supersede`、step 卡、tool 卡、改名空标题、归档取消、`retireModelCard`），改完按钮即消失或卡本身已退休；**另有 5 处目标卡没有按钮**（step 卡 [`feishu-streaming.ts:728`](./src/feishu-streaming.ts)/[`:750`](./src/feishu-streaming.ts)、tool 卡 `:164`、`/new` 结果卡 `index.ts:236`/`:1231`），可以安全连续就地更新（关键坑 11 只管带按钮的卡）。飞书对**带按钮**的卡片就地更新 2–3 次后停止投递回调（关键坑 11）→ 改法是「每步发新卡 + 旧卡置失效」（`/new`、`/display` 已是此模式） |
| O5 | **`#18` reasoning 代码块可折叠** | 中 | 🔲 **未实现**（`src/` 内无 `collapsible`） |
| O6 | **错误详情**（用户可见的报错） | 中 | ✅ **主体已实现（2026-09-23，本批）**；原假设被实测**推翻**，缺口换成另一件事。① **四条"截断上限"从未咬到**：全部 23 个会话日志 / 21645 条工具结果 / **734 次 `isError`**，错误文本 p50 **149** · p90 **313** · **max 344** 字，超 600 字 **0 条**、超 1500 字 **0 条**；`turn/end` 失败全历史 3 次、最长 140 字。② **真正没解决的是"有一类错误用户完全看不到"**：`[update] failed` 7 天内 **15 次**只有 journal 一行，卡片**静默停在旧内容**（停在「深度思考中」的那两张卡即此）。本批两项：**[`error-text.ts`](./src/error-text.ts)** 补 `cause` 链（≤4 跳、去重、防自引用）+ SDK `response.data.msg` + 信封业务码，上限 600 → 1000，**只读 message/code/response、绝不读 `config`/`request`**（关键坑 29）；**[`feishu-streaming.ts`](./src/feishu-streaming.ts)** 陈旧卡**纯文本**上报（2s 确认窗内被下一次写入救回则**不报**、每卡一次、`stop()` 清定时器），选文本是因为要报的正是"卡片写不进去"（关键坑 39）。**仍可选**：工具结果 >4k 另发文本全文（0/734 触发）、超大错误落文件交 `feishu_send_file`；`/error` 回看**倾向不做** |
| O7 | **`renderMode: auto\|card\|text`** | 低 | 🔲 **未实现**（2026-09-23 复核：`src/` 内仍无）。超长回复回退纯文本的能力，来自「飞书消息长度限制调研」的「待定」 |
| O8 | reasoning 预览字数是否可配置 | 低 | 🔍 **待定**。`REASONING_CAP = 200` 硬编码在两处（[`channel.ts:33`](./src/channel.ts)、[`feishu-streaming.ts:1336`](./src/feishu-streaming.ts)，行号按 2026-09-23 的 `src/` 重核） |
| O9 | **后台任务面板卡**（一张卡列出本群**全部**后台任务） | 中 | ✅ **已实现（2026-09-23，已重启生效）**。标题固定 `🧩 后台任务`；**一张卡列出该聊天全部后台任务**，列 = 状态 · 任务 · 编号 · 耗时 · 进度/结果；**只发不更新**（名册一变发一张新卡，取代 `663a96a` 的一任务一卡与就地更新）；判据不变（只列模型真拿到 jobId 的后台任务，前台 bash 调用不进表、不发卡，关键坑 37）。上限 8 行 + 已结算 30 分钟 TTL + 非紧急刷新下限 30s。**同日追加 `🧹 清理已完成` 按钮**（对齐 WebUI 的 Clear：只从名册里删已结算的行、宿主注册表不动；还有运行中的行就重发干净卡，清空则回一句文字；回调按被点击卡片的 message id 回查名册键）。实现见 [`src/feishu-jobs.ts`](./src/feishu-jobs.ts) / [`src/feishu-panel.ts`](./src/feishu-panel.ts)，实测见 CHANGELOG「后台任务 / 子代理面板卡」与「面板卡三处跟进」 |
| O10 | **子代理面板卡**（一张卡列出**全部**子代理） | 中 | ✅ **已实现（2026-09-23，已重启生效）**。标题固定 `🤖 子代理`，同样只发不更新；数据源 = 父会话 `subagent/catalog` + 宿主 `subagent/start` / `subagent/end`（`{ global: true }` 注册），**按子会话 id 关联**，**不读** `listChildren` / `listDescendants`（因此不需要每事件一次的全量异步读取）。嵌套子代理按已知父子关系归属到同一聊天，渲染时**画树**（`├─ ` / `└─ ` + `│  ` 竖线，深度优先排列；此前用空格缩进，实测飞书会折叠单元格前导空白 → 看起来是平铺）；表里另有**模型**列，值取自**子会话自己**的 `request/context`。进程外子代理（`local: false`）不列。实现见 [`src/feishu-subagents.ts`](./src/feishu-subagents.ts)。**O2（`/subagents` 命令）仍可在此基础上做「渲染这张面板卡的快照」** |
| O11 | **后台任务唤醒的轮次标记** | 低 | ✅ **已实现（2026-09-23）**。`turn/start` 重置两个回合级开关，本回合**第一条** `user/message` 的 `source.kind === 'tool-jobs'` 即认定"这轮是任务完成通知开的"（宿主对空闲 owner `followup`、忙时 `inject`，靠 append 顺序区分），该回合每张步骤卡正文顶部加 `⚡ 本回合由后台任务完成通知触发`；忙时注入的**不标**。目前只认 `tool-jobs`，`schedule` / `subagent-settled` / `goal` / `webhook` 等各自加一行即可。实现见 [`src/feishu-streaming.ts`](./src/feishu-streaming.ts) |
| O12 | **卡片 markdown 图片：中和 / 拒收兜底 / 内联真图** | **高**（曾经整卡被拒 → 整轮答案丢失 + 卡片永久停在「深度思考中」） | ✅ **已实现（2026-09-23，L1+L2+L3；提交 `49df1ba` + 本批）**。飞书把卡片 markdown 的 `![alt](src)` 当**图片元素**，`src` 只认上传后的 `img_v3_…`（本地路径与公网 URL 都让**整张卡** 400：`200570`/`230099`）。**L1** [`card-markdown.ts`](./src/card-markdown.ts) 中和代码跨度外的非法图片引用（闭合反引号才保护、目标里带反引号也不保护——均实测）；**L2** [`card-write.ts`](./src/card-write.ts) 拒收后无差别剥净再试一次 + CardKit sequence 单调下限 + 实例更新失败回退 `im.v1.message.patch`（堵死"卡片停在旧内容"）；**L3** [`card-images.ts`](./src/card-images.ts) 把工作区内真实图片上传后**内联进卡片**（realpath 判包含、魔数嗅探、≤10MB、每卡 8 张、单卡 6s 预算、`path+mtime+size` 缓存 + 并发去重）。**外加一个设置项 `cardImages: text\|workspace\|any`（默认 `workspace`）**：设置页「卡片显示」里的「正文里的图片」下拉，决定允许多走多远（永不上传 / 只传工作区内 / 任意可读路径）；`.volatile()` 热生效、不重启。**没有「关闭」档**——L1 中和不可关，关了卡片就会被拒收。**L4「在 `feishu_send_file` 描述里让模型别写这种 markdown」明确不做**：模型输出只有一份、WebUI 是它的正确渲染器，该适配的是渲染侧。全部实测表与解释见 CHANGELOG 同名条目与关键坑 39。**真机已验证（2026-09-23）**：正文里写 `![…](notes/inline-probe.png)`（未用 `feishu_send_file`）→ journal `[img] uploaded … → img_v3_…` **只上传一次**，服务端回读确认卡片正文已换成真 key，使用者目视看到图片内联；18:36 与 20:10 两次重启后卡片相关 error 均为 0。**唯独 L2 的三步（剥净重试 / 回退 patch）还没有活体样本**，目前只有单测覆盖 |

| O13 | **重启落在活跃回合上会清空「聊天→会话」绑定**（2026-09-23 事故） | **高**（静默数据丢失） | ✅ **已修（2026-09-23，本批）**。现象：重启后聊天退回**默认哈希会话**（一个旧会话），而不是原来的绑定。取证：01:47 升级备份里 `chatToSession` 11 条 / `chatToRootId` 10 条，事故后只剩 1 / 0，**唯独 `busyMode` 6 条完好** = `dispose()` 清空三张表、却漏清 `chatToBusyMode` 的签名；`toSessionId` 是 `sha256('feishu\0'+chatKey)`，算出的 DM 默认会话正是那个"旧 session"；会话日志显示原会话 21:51:19→22:01:29 无事件、默认会话 21:56:37 被唤醒。根因：`dispose()` 之后 in-flight 任务仍持已 dispose 的实例 → `saveSessionMap()` 把清空后的内存写回磁盘（触发条件＝**重启正好打在正在跑的回合上**；20:10 那次空闲重启没丢）。修法：`disposed` 门拒写 + 空表拒写 + **原子写（tmp+rename）** + 坏文件隔离 `.corrupt-<ts>` + 启动打印读回条数 + `dispose()` 也清 busyMode。**顺带**：`cardkit.card.create` 对非法内容不抛错而是 `code=200570` + `card_id=""`，空 id 曾被当引用发出（`cardid is invalid`、步骤卡永不出现）→ 现改为抛可识别错误 + 空 id 走普通发送。丢掉的 10 个话题绑定与 10 个话题根已从备份合并恢复（在服务停止窗口内写入）。详见 CHANGELOG 同名条目与关键坑 41 |

### 上游阻塞（我们能做的都做完了，只能等 DSH）

| # | 项 | 卡在哪 |
|---|---|---|
| B1 | **C3 的最后一处弃用 API**：`summarizeTurn` 仍需读单轮原始事件（逐 step 计时 / 首 token 时间） | 等上游提供**逐步计时类投影**；现有 `sessionProjections` 不提供。代码注释已写明这是**有意保留** |
| B2 | **P6-4**：用投影替代剩余的全量日志扫描 | 与 B1 同一上游缺口。**2026-09-23 alpha.2 复核：仍无新投影**（`sessionProjections` 的方法集与 alpha.1 完全一致） |
| B3 | **坑 28 撤权宜之计**（服务入口从构建产物切回源码入口） | 上游 `#7011` / `#6986` **仍未修**（alpha.2 范围内**没有任何 commit 引用**这两个编号）。要撤必须**先做实测实验**，不要凭推断撤 |

### 可选项（无明确需求，记录备查）

| # | 项 | 说明 |
|---|---|---|
| ~~X1~~ | ✅ **已完成（2026-09-23）** P6-5 | 设置页 = 配置，插件详情页 = 连接与扫码（见上方 P6-5） |
| ~~X2~~ | ✅ **已完成（2026-09-23）** P6-6 | `icon.svg` + 双语 `locale/*.json`（见上方 P6-6） |
| X3 | 🟡 **按收窄范围完成 3/5（2026-09-23）** P6-7 | ✅ `job-controller`（任务卡）、✅ 工作区 pin/unpin、✅ `modelCatalog()`；❌ `speech-to-text`（本机无语音供应商，无法端到端验证→本次不做）、❌ `readBytes`（原生 `Uint8Array`；纯内部重构、用户不可见→本次不做） |
| X4 | **MiniMax M3 思考强度** | 修法已定（**纯 settings，插件与 DSH 都不用改**：`compat.forceAdaptiveThinking` + `reasoningEfforts`），**尚未执行** —— 等确认要不要用 M3 再说。真机验证要点见「问题追踪」 |
| X5 | **C5 代理环境** | 入站 WebSocket（`ws`）不认 `HTTP_PROXY` 等环境变量，纯代理出网可能「发得出收不到」；**暂不处理** |
| X6 | **V13 压缩阈值实测** | **不是待改项**。要长会话自然跑到 ~680k 才会出现 `compaction/start`，**至今未触发**；公式已在代码侧核对 |
| X7 | 流式输出（CardKit `streaming_mode`） | ❌ **已取消**（2026-09-02 使用者决定）。下方技术方案仅作留档，**不要当待办** |

### 开发卫生（非功能，但会咬人）

| # | 项 | 说明 |
|---|---|---|
| H1 | `src/harness.ts.bak.20260902_172344` / `_215829` | 坑 3 要求「验证启动正常后**手动删** `.bak.*`」；这两份 2026-09-02 的临时备份**至今未删** |
| H2 | 本机旧产物 | `~/.dsh/plugin-node-modules.pre-017`（168M）、`plugin-package-lock.json.pre-017`、8 个 `settings.yaml.bak.*`；确认没有回退需求后可删 |
| H3 | 检出根 `lib/types/{index,invariant,startup}.js`（各 11 字节存根） | ⚠️ **别删**：`pnpm run clean` 不会碰它，但它已穿过两次完整构建；删了可能立刻回到 `Cannot find entry` 一类失败。见坑 32 与 `notes/upgrade-0.1.7-alpha.2.md` §6 |

---

## 已实施：后台任务 / 子代理面板卡（2026-09-23，O9 + O10）

**使用者原话**：

> 这个后台任务现在这个标题是不合适的，应该改成「后台任务」。然后这个卡片要列出所有的后台任务，还有这个任务的命令、状态这些。sub agent 也是一样的。就是在生成后台任务或者后台任务更新的时候，会自动发卡片展示一下，sub agent 也是。展示的形式暂定就是用表格形式。

> （同日补充定形）这两个卡片的发卡时机都是触发了相关的东西的时候，**这两个卡片是发卡即可，不需要就地更新**。因为这两个都相当于是后台的任务。

### 实施结果（as built，与上面草案的差异以本节为准）

1. **标题固定**：`🧩 后台任务` / `Background jobs`、`🤖 子代理` / `Subagents`。**不再用 job label 当标题**。
2. **一张卡列全部 + 只发不更新**：每个聊天（严格说是每个**话题坐标**，即 session 绑定的 `chatId + threadId`）一张快照卡；名册一变就**发一张新卡**，**不就地更新**、也不发灰色「已失效」卡——这是草案里"刷新同一张卡"被使用者后一条指令**取代**的地方。发卡纪律集中在 [`src/feishu-panel.ts`](./src/feishu-panel.ts)：同一刻合并（flush 时重新渲染）· 非紧急刷新下限 30s（只有进度文案变化才等它）· **指纹去重**（耗时等时钟文本不进指纹）· 按 chat 串行。
3. **后台任务表列**：状态（🔄 / ⏹️ / ✅ / ❌ / ⛔）· 任务（`JobView.label`，截断 48 字 + 行内代码）· 编号（`bash-N`）· 耗时（`finishedAt ?? now` − `startedAt`）· **进度 / 结果**（运行中取 `progress`，终态取 `detail`）——草案里的「进度」「结束原因」两列**合并成一列**，否则卡片太宽。
4. **子代理表列**：状态 · 子代理（`label`）· 子会话 id（截断 14 字）· 模式 · 耗时；**深度不占列**，改用缩进（`　` × (depth−1)）表达嵌套。
5. **数据源最终选择**：后台任务 = `jobs.events` 事件 + 工具结果句式的门控（**没用** `jobs.list`）；子代理 = 父会话 `subagent/catalog`（会话事件）+ 宿主 `subagent/start` / `subagent/end`（**没用** `listChildren` / `listDescendants`，也就没有每事件一次的异步全量读取，无需节流）。
6. **有界**：一张卡最多 **8 行**（超出提示「另有 N 条更早的记录未列出」），已结算的行 **30 分钟**后退出名册；聊天里的历史卡保留——它们就是记录本身。

### 侦察结论（原「实施前要侦察的」逐条答案）

1. **子代理的终态触发** → 有，但**不是会话事件**：`subagent/catalog` 只在创建时 append，`running → inactive` 没有任何 `session/event`；可用的是宿主的 `subagent/start` / `subagent/end`（`packages/subagent/subagent/src/lifecycle.ts`，按委派父级做 scoped dispatch → 本模块用 `{ global: true }` 注册，与 DSH 自己的 invariant 同一写法）。**没有**采用轮询 / `turn/end` 边界刷新。见关键坑 38。
2. **`jobs.list(owner)` 口径** → **没有依赖它**：名册由门控后的 registry 事件自己攒，所以不存在"前台调用是否还在列表里"的歧义（判据仍是关键坑 37 的工具结果句式）。
3. **表格真机表现** → ✅ **使用者已目视确认（2026-09-23）**：表格与树形连线的渲染、列宽、长命令截断、zh/en 排版都没问题，`🧹 清理已完成` 按钮点击效果也正常。观测局限不变：API 侧读到的是卡片实体引用（`请升级至最新版本客户端，以查看内容`），**读不到正文**，这类结论只能由使用者给出。备用改法仍留着——替换 `renderTable` 一处（换成"一行一个任务"的列表）。
4. **退场语义** → 已定：卡**保留**最后状态（发新卡，历史卡不动），名册里的结算行 30 分钟后清掉。
5. **一张卡还是两张** → 已定：**两张独立卡**（`🧩 后台任务` / `🤖 子代理`），触发源与数据源不同。

### 实测（2026-09-23 12:00:57 重启后，探针）

- 起 `run_in_background` 的 `sleep 25`（job `bash-6`）+ 一次前台 `subagent` → 窗口内**恰好 4 条**面板消息：`🧩 后台任务`（12:02:45，任务开始）· `🤖 子代理`（12:02:45，注册）· `🤖 子代理`（12:02:48，**新消息** = 终态）· `🧩 后台任务`（12:03:09，**新消息** = `exit code: 0`）。
- **只发不更新被证实**：两张 `🧩 后台任务` 的 message id **不同**，采样器全程没有对它们报过 `CHANGED`。
- 前台 bash 调用 → **0 张卡、不进表**（该轮多次前台调用）。
- 完整记录见 [CHANGELOG.md](./CHANGELOG.md)「后台任务 / 子代理面板卡」。

### 仍未做（可选后续）

- **O2 `/subagents` 命令**：可以直接渲染这张面板卡的快照（共用 `renderSubagentPanelCard`）。
- **进程外子代理**（`local: false`，claude-code / codex / acp / dsh-sdk provider）：没有本地子会话就没有 `subagent/catalog`，lifecycle 事件也不带聊天归属 → **当前不列**。要覆盖可读 `subagent/start` 的 scope carrier（`dsh-scope` 的 `carrierKeyOf`，需新增 peer）拿父 agent。
- **进度明细区**：长命令目前截断到 48 字；如果确实要看全文，可在表下加「明细」区或改用 `/job` 类命令。
- **配置开关**：是否需要 `jobCards: off|detached|all` 之类（暂不做）。

---

## 0.1.2-alpha.1 适配（已完成，2026-08-28）

- 删除 `apiproxy` 依赖（DSH 0.1.2-alpha.1 整包移除 `packages/host/apiproxy`）
- events 订阅改 `ctx.on('session/event', (session, event) => ...)` —— 5 文件统一改
- user-questions / approval 答案改 `ctx.on('user-questions/request' / 'approval/request', listener return answer/outcome)` —— 走 Cordis waterfall，listener return 即 claim
- selectModel 改 `ctx.sessionController.selectModel(...)` 一站式同步 agent ref + WebUI + 持久化（之前 plugin 自己的 `selections: Map` + `installModelSelection` 删除）
- inject 数组 `'apiProxy'` → `'sessionController', 'userQuestions', 'approval'`
- `/stop` 改 `sessionController.cancel({ sessionId })`
- 132 tests pass / typecheck 0 errors / build OK
- 已知降级：`tool/call` 事件无 view 字段（callView 永远 undefined）；`tool/result` 用 `event.data.meta` 作 resultView

---

## DSH 0.1.5-rc.1 适配（已评估，2026-09-10）

> 完整评估见 [`docs/migration-0.1.5-alpha.1-to-rc.1.md`](./docs/migration-0.1.5-alpha.1-to-rc.1.md)（279 commits）。

- ✅ **插件运行时代码零改动**；依赖范围 `^0.1.5-alpha.1` **无需修改**（与 rc.1 同属 `0.1.5` tuple，semver 预发布范围自动命中）。
- ✅ 17 个被 import 的 `dsh-*` 包 `exports` map 零差异，仅 5 个包源码有变动且全为增量/注释；19 个宿主服务名全在。
- ✅ **测试环境坑（发版阻塞，已修 2026-09-10）**：`dsh-client-ui-primitives@rc.1` 把运行时依赖降为 `devDependencies`，全新安装后 `tests/client.spec.ts` 报 `Failed to resolve import "clsx"`。**采用 B1**：`vitest.config.ts` 加 `resolve.alias` 指向 `tests/stubs/ui-primitives.tsx`（按真组件可观测契约实现的四个替身），**零新增依赖、断言一条未删**。验证＝真模拟（移走 `node_modules/clsx`）：无 alias ❌ `Cannot find package 'clsx'`，有 alias ✅ 307 passed。完整记录见评估文档「问题 B」。
- ✅ **C1（高）已实现（2026-09-10）——接管 `deliverables/presented`**。但结论与最初设想不同：**只把交付物列进 Turn Complete 卡片，不推送文件**。飞书没有工作区浏览器，推送既噪音大、又会与 `feishu_send_file` 重复；清单保留了 `present` 的全部信息（模型筛过的成品 + 描述），用户真要文件时说一句即可。实现落在 `feishu-streaming.ts`（收集）+ `channel.ts` `renderFooterCard`（渲染），**没有新建 `src/feishu-deliverables.ts`**。清单排在**卡片最前面**并用分隔线与指标隔开（2026-09-10 真机反馈修正，原先夹在 stats 与元信息之间）。
- 🔲 **C2（中）`/subagents` 子代理卡片**：rc.1 有 `subagent/catalog` 事件 + 子代理排队/steer/stop，插件目前完全隐藏子代理会话。
- ✅ **C4（低）已实现（2026-09-10）**：`deriveToolSummary` 补了 `present` 分支，显示 `交付文件：a.txt +2`（2026-09-11 随 i18n 对齐把「交付物」改成 WebUI 的「交付文件」），不再落到「工具名 · 首字段」的 `present · files` 兜底。
- 📋 **C5（记录）代理环境**：入站 WebSocket（`ws`）不认 `HTTP_PROXY` 等环境变量，纯代理出网可能「发得出收不到」；暂不处理。
- ✅ **C3 `/feedback` 无需改动**：它是宿主 `commands` 注册表命令，插件的 `commands.execute` 兜底路径已自动转发，且会出现在 `/help` 的「DSH 内置」分组。

---

## DSH 0.1.5-rc.2 适配（已评估并升级，2026-09-10）

> rc.2 距 rc.1 仅 **4 commits**（`dsh-v0.1.5-rc.1...dsh-v0.1.5-rc.2`），其中 2 个是 release/version bump，实质改动只有 1 个 Web 回移提交。

- ✅ **插件运行时代码零改动、依赖范围不变**（与 rc.1 同属 `0.1.5` tuple，`^0.1.5-alpha.1` 自动命中；实测 `semver.satisfies('0.1.5-rc.2','^0.1.5-alpha.1') === true`）。
- ✅ **17 个被插件 import 的宿主包一个都没变**：rc.2 仅改动 Web 客户端包 `ui-message-feedback`（点赞/点踩改弹窗确认）、`ui-deliverables`（产物卡片排版与间距）、`ui-primitives`（`CodeFileIcon` 重构为 artwork manifest）。`SESSION_FORMAT_VERSION` 仍为 **3**，无会话日志迁移，随时可退回 rc.1。
- ✅ `ui-primitives` 的 `Button` / `Input` / `Switch` / `StateDot` 公开契约未变（只动 `CodeFileIcon`），且 **rc.2 仍未把运行时依赖放回 `dependencies`**，故 B1 测试替身继续有效、无需调整。
- 🔲 飞书侧可受益的 rc.2 新特性：**无**（纯 Web 显示层改进，无对应聊天端口能力）。

---

## DSH 0.1.6-alpha.2 适配（已评估并升级，2026-09-18）

> 完整评估与事故记录见 [`docs/migration-0.1.6-alpha.1-to-alpha.2.md`](./docs/migration-0.1.6-alpha.1-to-alpha.2.md)（**887 commits / 2622 个改动文件**）。

- ✅ **插件运行时代码零必改**：四个被消费的 `sessionController` 方法签名逐字节未变、client slot 契约零差异；依赖范围因同属 `0.1.6` tuple 无需改（只重装了工作区依赖）。
- ⚠️ **Creator preset 工具集替换**：`cordis_define/run/stop/undefine` 全部删除，改由 `plugin_manager` 承担（自建 preset 需跟着改）。
- ⚠️ **解析模式默认值 `link` → `runtime`**，核心包必须只有**一份物理副本**；本机当天因此在 `tsx` 源码入口触发 `@deepseek-ai/dsh-tools` 双实例 → **每次工具调用**报 `Cannot read properties of undefined (reading 'prepare')`。
- ✅ **临时措施（仍生效）**：服务入口从 `tsx src/bin.ts` 改为**构建产物入口**（关键坑 28；**不动 DSH 源码、等上游**）。代价：改 host 源码必须重建、**dsh 运行期间绝不 `pnpm run build`**、跨 tag 切版本必须先清产物（关键坑 32）。
- 🔲 上游修复落地后：把服务入口切回源码入口并复验一次工具调用。**2026-09-22 复核：0.1.7 里 `TOOL_RUNTIME_SCHEDULER` 仍是局部 `Symbol(...)`（未改 `Symbol.for`），且 alpha.2 的默认解析模式开关已随解析模型重写消失 → 权宜之计仍未退休，只能靠实测实验撤。2026-09-23 alpha.2 复核：仍未修**（alpha.2 范围内无任何 commit 引用 `#7011` / `#6986`）——详见上方 **B3**。

---

## DSH 0.1.7-alpha.1 适配（已评估并升级，2026-09-22）

> 完整方案、执行记录、两次 build 失败的根因与逐项实测见 [`docs/migration-0.1.6-alpha.2-to-0.1.7-alpha.1.md`](./docs/migration-0.1.6-alpha.2-to-0.1.7-alpha.1.md)（**1299 commits**）。

- ✅ **A1 设置服务换血**：`settings.register()` / `settingsScope.get()` / `scope.watch()` 全删（服务变 `SettingsForms`），配置改读 `apply()` 收到的 live Config；`ConfigSchema` 字段**必须 `.volatile()`**（否则设置页空白、所有写路径抛错）；`ns` 改为**从自身 fiber 反查**（不再依赖"碰巧同名"）；`scope.watch` → `ctx.on('loader/volatile-update')`。
- ✅ **A2 preset 包改名**：`@deepseek-ai/dsh-agent-presets` → `@deepseek-ai/dsh-agent-preset-registry`（服务名与 `list/resolve/mount/defaultId` 不变）；依赖范围整体升 `^0.1.7-alpha.1`（关键坑 17）、`schemastery` → `^3.18.3`、`cordis` → `^4.0.3`。
- ✅ **C1 `tool/result` 拍平**：改读 message 自身的 `content` / `isError`（旧读法会把**失败渲染成成功**），并加回归测试锁死「失败必须渲染成 ❌ 失败」。
- ✅ **C4 `locale:'auto'`** 恢复跟随 DSH 语言（改走 `settings.describe()` + 1s TTL 缓存）。
- ✅ **升级红利已兑现**：压缩死区（阈值改为 `min(W × ratio, W − O − headroom)`）与 `turn/end` 被 `Session.append` 静默拒绝两条链由上游修复；坑 28 的双实例症状在产物入口下**未复现**（但权宜之计未撤）。
- ✅ **C2 归档运行中会话**（2026-09-22 完成）：对齐 WebUI 的「先问再停」——第一次归档不带 `stopActivity`（绝不静默停止正在跑的工作）；DSH 回以 `WorkspaceActiveSessionError` 时发**第二张确认卡**写明活动类型，按钮变「停止并归档」，只有它的确认才传 `{ stopActivity: true }`。错误识别用鸭子类型（宿主抛的类，插件可能持有另一份副本，与关键坑 28 同源）。
- 🟡 **C3 弃用 API**（部分完成）：`snapshotEvents` / `eventAt` / `ownEvents` 已被上游弃用（2026-09-09 决策：既有逻辑可暂不迁移、**禁止新增调用**）。**会话列表已迁**：活动会话的标题/预设/空白位改读宿主投影 `title` / `agentPreset` / `sessionListMetadata`，活跃度用与 WebUI 相同的 `max(createdAt, lastPromptAt)`（关键坑 8 同源）；投影服务缺失时保留日志回放。**仍保留一处**：`summarizeTurn` 需要单轮的原始事件（逐步计时等，现有投影不提供），已在注释写明理由。
- ✅ **B3 目录型 preset：已决定不再保留（2026-09-22 处置完毕）**。0.1.7 的 registry 既不扫目录也不收 preset 路径 → 本地「持久模式」preset（`~/.dsh/.agent-presets/persistent/`）本就不再出现在 `agentPresets.list()`；使用者决定**不迁移、直接删除**，已把整个 `~/.dsh/.agent-presets/` 移出（含 6 份历史副本）。**原本的搬迁做法（留档备查）**：若要恢复，需搬成 `@deepseek-ai/dsh-agent-preset` 声明式行，且**必须文本级搬运**（保留 `!!js` 表达式）、**不要丢 `isolate` 组**。删除前已精确复核：**0 个会话**记录过该 preset；删除前后 `--dump-config` 逐字节一致（无引用，故无需重启）。
- ✅ **升级后发现的插件 bug 已修**：重建冷会话时用**插件配置默认值**覆盖了会话自己记录的 preset → 「卡片写 `cordis`、工具集却是 `standard`」。与 0.1.7 无关（`0.1.6-alpha.2` 上已复现），已修并固化为**关键坑 33**。
- ✅ **C2 / C3 / P6-8 批次已上线**（2026-09-22 22:40 重启后确认）：`apply()` 三项服务 available、`[ws] ws client ready`、`dsh web:` banner 在、journal **0 error**；并已用 `cordis_inspect` 证实宿主 `sessionProjections` 服务在 **host 平面**存在，`stateOf(session, key)` 契约与代码假设一致，且 `ctx.get(...)` + 判 `undefined` 正是官方许可的**可选访问**方式（`requiresUndefinedCheck: true`）。

---

## DSH 0.1.7-alpha.2 适配（已评估并升级，2026-09-23）

> 对比 `dsh-v0.1.7-alpha.1...dsh-v0.1.7-alpha.2`：**162 commits / 869 个文件**。完整执行记录见本机 `notes/upgrade-0.1.7-alpha.2.md`。

- ✅ **插件零改动**：逐符号核过 `settings.section` / `sessionProjections` / `configForms` 契约 / `remote.credentials` / `sessionController.prompt`、`selectModel` / `archiveSession` / `WorkspaceActiveSessionError` / `whileServed` —— **全部 0 差异**；18 个 peer 包里 16 个源码 0 变更，其余两个（`api/session-controller`、`core/tools`）只有**纯新增可选字段**（`SessionPageRequest.turnWindow?`、`ToolDefinition.projectContent?`）。持久化 schema 无变化 → **无需数据迁移**。
- ✅ **产物逐字节一致**：升级前后 `lib/index.js` / `client/client.js` 的 sha256 相同——「不需要改」不是推断，是构建结果。typecheck 0 error、**458 tests 全绿**（插件 dev 依赖已对齐 alpha.2：44 个 `@deepseek-ai/*` 包全部 `0.1.7-alpha.2`，`cordis` 4.0.4、`schemastery` 3.18.4）。
- ✅ **升级红利**：① 后台任务完成唤醒**默认无上限**——修掉「用户离开后会话被静默卡住」，飞书场景正好命中（本机未配置 `maxConsecutiveWakes`，升级即得）；② Web 服务重启后原页面**恢复连接**，不再「显示已连接但收不到回复」；③ 客户端批次脚本失败改为**按行重试**，设置卡更不容易被同批次其他行拖垮。
- ⚠️ **一处破坏性配置变更不适用**：`spill-policy` 的 `maxInlineBytes` → `maxInlineTokens`（改为按 token 计预算）。本机没有任何自定义 spill-policy（上游改的是 base bundle 默认值）。
- ℹ️ **发行说明那句「插件依赖解析模式调整为运行时解析 / 插件管理支持运行时卸载，请开发者检查加载与卸载逻辑」的落点**：对应 `workspace:^` → `workspace:*`（DSH 目标精确）/ `~`（vendor、native）的**依赖范围策略**（连 remote API cookbook 的示例也改了），**不是运行时行为改动**——alpha.2 里 `packages/boot/app-boot/src/profile-resolution/*` 一个文件都没动。我们已符合「共享实例的 dsh 包同时声明在 `peerDependencies` 与 `devDependencies`」；linked 解析**不校验 peer 范围**，且 `^0.1.7-alpha.1` 本就涵盖 alpha.2（同 tuple，关键坑 17），所以 `package.json` 无需改动。插件自身的卸载卫生也复核过：定时器在 `dispose()` 里 clear，路由/字典/表单全走 `ctx.effect`，无裸 `process.on` / `globalThis` 泄漏。
- ℹ️ **服务入口路径未变**（`apps/cli/package.json` 的 `bin` 两版一致）→ systemd 单元无需修改，**关键坑 28 的产物入口规避继续有效**；升级后工具调用正常，`prepare` 报错未复现。
- 🔲 **仍未解决**：坑 28 的上游讨论（源码入口下 `dsh-tools` 被求值两次）在 alpha.2 范围内**没有任何 commit 引用**，无法确认已修 → 权宜之计**不撤**。
- 🔲 **P6-4 仍被上游阻塞**：alpha.2 没有新增任何逐步计时类投影（`sessionProjections` 的方法集与 alpha.1 完全一致）。

---

## 迁移遗留：P6 可选重构（2026-09-22 盘点，2026-09-23 复核）

> 来源：0.1.7 升级评估 §2.6「可借新特性重构」。没有一条是"必改"，但都是"能删掉自造轮子"的改进。
> **状态（2026-09-23 收口：8 项里 6 项完成 / 1 项阻塞 / 1 项按收窄后的范围完成）**：P6-1 / P6-2 / **P6-3** / **P6-5** / **P6-6** / P6-8 ✅ 已完成；**P6-4 被上游阻塞**（见 B2）；**P6-7 完成 3 项**（modelCatalog / 工作区 pin-unpin / job 任务卡），`speech-to-text` 与 `readBytes` 按使用者 2026-09-23 的决定**本次不做**（见 X3）。**后续修复（2026-09-23）**：P6-7c 的 job 任务卡原本把**前台** bash/pwsh 调用也镜像成卡（每个工具调用多一张，关键坑 37）→ 已改为只镜像工具结果确认过的后台任务，`removed` 不再改写终态卡；同批实现 **O1** 思考期占位卡。
>
> **已重启生效（2026-09-23 02:33）**：`MainPID` 3017371 → 3110625、启动时刻 01:50:34 → 02:33:24；journal **0 error**；`ctx.get('jobs')` **拿到服务**（那条 `no background-job registry` 出现 0 次 → 任务卡功能开着）；产物含 `startFeishuJobs` 与 `plugins.detail.*`。⚠️ 任务卡是否送达 **journal 证明不了**（只在失败时记日志），与页面级效果一样待使用者目视。
>
> ⚠️ 本表原先**漏了 P6-3**（从 P6-2 直接跳到 P6-4），2026-09-23 补上——它的内容随 P6-1 一起落地了。

| # | 项 | 收益 / 代价 |
|---|---|---|
| ~~P6-1~~ | ✅ **已完成（2026-09-22）** 设置页改走原生 **`ctx.configForms`**（ns = profile 行 id `lark-channel`）+ **`ctx.remote.credentials`**（密钥按引用读写） | **自建的 `SETTINGS_PATH` 路由与 `settings-api.ts`（140 行：字段白名单 / 脱敏 / revision 栅栏）已整块删除**；页面位置不变（仍是 Settings → 飞书与 Lark 标签页），仅保留 `/dsh-feishu/provision` 承载扫码与运行状态。**已重启生效（2026-09-23 00:13）**：服务 active、journal 无 error、产物核对通过 |
| ~~P6-2~~ | ✅ **已完成（2026-09-22）** | 「留空 = 保留 secret」由凭据域写入语义实现（只在用户输入时 `.set()`），不需要自建表单组件 |
| ~~P6-3~~ | ✅ **已完成（随 P6-1 一并落地，2026-09-23 复核确认）** `.volatile()` 免重启、**不杀正在跑的 turn** → 替代原来的「保存后重连」 | ① 19 个可编辑字段**全部** `.volatile()`（`src/config.ts:98-116`）→ 保存立即生效、**不需要重启 Harness**；② 「不杀正在跑的 turn」由 `connectionFingerprint`（`src/config.ts:181`）保证——指纹**只覆盖连接字段**（`appId` / `appSecret` / `domain` / `requireMention` / `dmMode` / 两个 allowlist / `reactEmoji`），显示开关、语言、`provider`/`model`/`workspace`/`agentPreset`、`errorMessage` **都不在指纹里** ⇒ 改它们不会推倒 runtime（坑 20；注释里还留着 2026-09-10 那次「跑 turn 时切显示开关 → `flush on a closed handle`」的事故记录）；③ `loader/volatile-update` 仍会调 `runtime.reconcile()`，但它是**指纹门控**的，非连接字段的重复写是空操作 |
| ~~P6-8~~ | ✅ **已完成（2026-09-22）** 两项清理 | ① `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-runtime` 已删（现为 locale / ui-settings / ui-plugin-manager / api-remotes）；② `settings.action` 的 `id:'open-document'` + `priority:-1` 影子注册**已补注释**（`src/client/index.ts:61-71`），写明它必须与壳层同名同 id 才能压掉壳层入口。⚠️ 注释里仍留着一句「Intent not re-verified」——**当初为什么要压掉壳层那条 action，仍未复核** |
| P6-4 | 用 `sessionController.projections()` 替代剩余的全量日志读 | 与 C3 剩下那处（`summarizeTurn`）同源；**要等上游提供逐步计时类投影**，否则轮次指标会退化 |
| ~~P6-5~~ | ✅ **已完成（2026-09-23，commit `cff2c91`）** `plugins.detail.badge` / `actions` / `section`（新单元格 id `lark-channel`，关键坑 35） | 设置页只留**配置**，**连接状态与扫码**搬到插件详情页：badge = 状态标签、actions = 「扫码配置 / 重新扫码」、section = 连接与扫码区块（二维码在这里）。三个 entry 都认 subject（非本插件返回 `null`，且**不订阅、不发请求**）。**「重新连接」在客户端不可达**（宿主 `reconcile()` 按连接指纹门控、调用点全在宿主侧）→ 给的是有真实副作用的扫码动作；限制与两个替代做法写在 `docs/feishu-setup.md`。文档同步：README（中英双语「两个页面」+ 快速开始改指向）与 `docs/feishu-setup.md` |
| ~~P6-6~~ | ✅ **已完成（2026-09-23，commit `f43750b`）** `locale` meta + `package.json` `icon` | `locale/en.json` + `locale/zh.json`（`meta.title` / `meta.description`）+ `icon.svg`；`package.json` 顶层 `icon`、`exports` 放行 `./locale/*.json`、`files` 补两个资源。**验证用宿主自己的 `readPluginMeta()`**：返回中英两套文案 + base64 SVG 且**无 `error`** |
| ~~P6-7~~ | 🟡 **按收窄后的范围完成 3/5（2026-09-23）** | ✅ `modelCatalog()`（`sessionController.modelCatalog()` 一次拿 provider + **可读模型名** + 每模型推理档位，llm 目录降为回落；`eb33289`）、✅ 工作区 **pin/unpin**（面板两个幂等按钮 + 📌 标记，归档互斥走专门文案；`825e273`）、✅ **job 任务卡**（一人一卡、就地更新、首发不防抖、`dispose()` 退订；`663a96a`）。**本次不做**：`speech-to-text`（本机无语音供应商，无法端到端验证）、`readBytes`（纯内部重构、用户不可见）。**2026-09-23 修复**：job 任务卡的判据曾是「registry 里有 job 就发卡」，而前台 bash/pwsh 调用也是 job → 每个工具调用多一张卡（关键坑 37）；现改为只镜像**工具结果确认过**的后台任务，且 `removed` 只清账、终态卡保留 |

- ⏳ **V13 压缩阈值实测**：上游把触发公式改为 `min(W × ratio, W − O − headroom)`（本机 = `min(800000, 680000)` = **680000**）；需要一个长会话自然跑到该水位才能确认日志出现 `compaction/start`，**至今未触发**。公式已在代码侧核对，**不是待改项**，只是"待观察"。

---

## 已完成

| # | 功能 | 说明 |
|---|---|---|
| — | 归档运行中的会话 | ✅ **已完成（2026-09-22）**：DSH 0.1.7 起拒绝归档仍有活动的会话（`WorkspaceActiveSessionError`）→ 插件发**第二张确认卡**写明活动类型（turn / 子代理 / 后台任务 / 定时任务）、按钮「✅ 停止并归档」，**只有它确认**才传 `{ stopActivity: true }`；错误按 `name` + `activity[].kind` 鸭子类型识别（宿主抛的类，插件可能持有另一份副本）。对齐 WebUI 的「先问再停」，绝不静默停止正在跑的工作 |
| 1 | 卡片化 + footer | 最终回复卡片底部标注 workspace + preset + **模型名** + **推理等级** + **上下文使用量** |
| 4 | `/status` 命令 | 展示 session id / title / workspace / preset / model / **reasoning** / tokens / context / **缓存命中率** / **TTFT** / **吞吐量** / **LLM 时间** / **工具时间** |
| 5 | 工具调用展示 | 订阅 `ctx.on('session/event')` → `tool/call` + `tool/result`，wathet/green/red 卡片。**原地更新**：`tool/call` 发卡片后保存 `messageId`，`tool/result` 用 `updateCard` 更新同一张卡片 |
| 6 | todo 展示 | 订阅 `ctx.on('session/event')` → `todo/write`，turquoise 卡片含进度条 |
| 11 | 中间消息不可见 | ✅ 改为 `ctx.on('session/event')` + `tool/call` 时 flush 累积文字，紫色卡片 |
| 12 | tool call 卡片 markdown 渲染 | ✅ `lark_md` → `markdown`，4 文件 11 处 |
| 13 | 卡片 Markdown 渲染不稳定 | ✅ 全面迁移到 Card JSON 2.0，表格/标题/内联代码原生渲染，移除降级逻辑 |
| 14 | 纯查询命令即时返回 | ✅ fire-and-forget + agent 运行状态检测 |
| 15 | Agent 消息队列调研 | 两层队列机制已确认（见下方调研记录） |
| 17 | `/reasoning` 推理等级命令 | ✅ `/reasoning [off|low|high|max]`，通过 `agentDefaultModel.saveSelection` 持久化 |
| 19 | tool_call / tool_done 顺序问题 | ✅ `tool/call` 直接发送保存 `messageIdPromise`，`tool/result` 等待后 `updateCard`，消除竞态 |
| 20 | 工具调用摘要 | ✅ 通过 mux `frame.view` 获取 `presentCall`/`presentResult` 的 `description`、`title`，显示在工具名称上方 |
| 21 | 卡片颜色区分 | ✅ 工具调用中 wathet → 成功 green → 失败 red；Reply 蓝色；Turn Complete 绿色 |
| 22 | Reply 标题命名 | ✅ 已统一为 "Reply" |
| — | `/stop` 命令 | 通过 `ctx.sessionController.cancel({ sessionId })` 中断运行中的 agent，等同 WebUI 停止按钮 |
| — | `/stream` 命令 | 切换 `showIntermediateMessages` 设置（已与中间消息模块解耦，保留备用） |
| — | 统一 per-step 卡片 | ✅ 每个 step 一张卡片，包含 reasoning + text + 工具调用 + 结果预览 + step 时长/token footer |
| — | 工具结果预览 | ✅ 按 `resultView.card` 类型分发渲染（terminal/web/search/read/diff/generic） |
| — | 工具名称内联代码 | ✅ 工具名用 `` ` `` 内联代码展示（如 `` `read` ``、`` `edit` ``） |
| — | Turn Complete 卡片 | ✅ 显示轮次时长、TTFT、吞吐量、输入输出 token、缓存命中率 |
| — | Step token footer | ✅ 每个 step 卡片底部显示时长 + 输入输出 token |
| — | Debounce + flush 同步 | ✅ 150ms debounce 合并快速更新，turn/end 时 flush 确保 footer 在 card update 之后发送 |
| — | 卡片顺序（步骤卡优先） | ✅ 每 chat 步骤卡消息串行链 + 发卡前屏障（问题卡/审批卡/溢出续卡前先刷出并等待步骤卡消息）+ 溢出续卡显式 `await lastStepSend`；修「续卡排到更早步骤卡前」与「问题卡先于步骤卡」 |
| — | 卡片显示粒度开关 + 面板精简 | ✅ **已完成（2026-09-09）**：`showToolCalls` / `showToolArgs` / `showToolResults`（+ 已有 `showReasoning`）四个开关；工具总开关关闭时纯工具步骤不发卡；WebUI 面板改为「应用凭据 / 访问策略 / 卡片显示」三卡，移除 Provider/Model/Workspace/Agent Preset/失败提示；修 `SETTINGS_KEYS` 漏收 `showReasoning`；新增 `/display` 斜杠命令覆盖四个开关 |
| — | 防止卡片消失 | ✅ 内层 try/catch 保护 mux 事件处理，timer 回调 error-safe |
| — | 不同步骤工具调用分离 | ✅ `resetStep` 不清除 `state.chat`（session 级坐标），每个 step 独立卡片 |
| — | 提问/审批两端同时弹卡 | ✅ **已完成（2026-09-11）**：飞书绑定会话不再让 WebUI 静默失效——最外层监听器渲染飞书卡后用 `next()` 把同一请求交给 WebUI，`firstDefined()` 赛跑、谁先答谁生效；飞书胜出时用信号门中止转发（浏览器卡片消失），WebUI 胜出时飞书卡改写为「已在网页端处理」。见 `src/dual-answerer.ts` + CHANGELOG |
| — | 审批按钮反馈 | ✅ 点击后卡片结算为 ✅ 已允许 / ❌ 已拒绝（随 `/lang` 双语），移除按钮 |
| — | 审批卡：中止作废 + 取值统一 | ✅ **已完成（2026-09-11）**：本轮中止（`/stop`、turn 取消、请求结束）时审批卡此前会留下点不动的活按钮，现改写为灰色「⏹️ 审批已失效」并去按钮；按钮 `action.value` 从自写的「只认字符串」解析改为共享 `decodeCardValue()`（字符串/双重编码/对象都吃）。整卡原先硬编码英文，现已全量双语（`approval*` 一组 i18n 字段） |
| — | i18n 词典对齐 WebUI locale | ✅ **已完成（2026-09-11）**：以各 `client` 包的 `src/client/locales.ts` 为准对齐中英词表——审批 `等待审批`/`允许一次`/`拒绝`、`推理等级`（原「推理强度」）、会话 `分叉`（原「派生」）、`交付文件`（原「交付物」）、`首 token 延迟`（原 `TTFT 平均`）。能取自词典的测试断言改为引用 `t.xxx()`，避免改词即红 |
| — | 飞书事件订阅修复 | ✅ provision 新增 `im:message.reaction` 权限 |
| — | 卡片按钮回调修复 | ✅ ~~Node.js SDK `MessageType.CARD` 被过滤~~**经对照实验证实补丁不必要**：`card.action.trigger` 以 `type='event'` 到达，帧过滤不拦它；已移除 `patch-sdk-card-action.sh` + `postinstall`（还原 pristine SDK） |
| — | 选项卡片反馈 | ✅ 选择后 recall 旧卡 + 发新卡（青绿色头部，显示所有选项，已选高亮） |
| — | 双重编码 JSON | ✅ Feishu `action.value` 双重编码 → 二次 `JSON.parse`（questions + approvals） |
| — | Turn Complete 时间修复 | ✅ LLM 时间（assistant/message 累加）与工具时间（tool/result 累加）分开统计 |
| — | `/thread` 改名 `/session` | ✅ 命令实际操作 DSH session（`listSessions`/`switchToSession`），与飞书原生"话题"混淆、与 WebUI「会话」心智不一致；已重命名（`commands.ts`/`index.ts`/`tests`/文案/`FEISHU_OWNED_COMMANDS`），**不保留 `/thread` 别名** |
| — | `/session` 管理面板 | ✅ `feishu-session.ts`：下拉选会话 + 切换（占用先确认）/detach/归档/fork/改名（独立卡片，`sessionController.rename`）/列表/刷新；`/session list` 表格卡；`/session N` 快速切换 |
| — | `/help` 卡片化 + 分组 | ✅ 飞书文本不渲染 markdown → 卡片；分「🔹 dsh-feishu 插件 / 💠 DSH 内置」两组，被拦截命令（busy/steer/queue/permission/stop）补进 Feishu 组 |
| — | 工具调用摘要找回 | ✅ `deriveToolSummary`（`feishu-streaming.ts`）按 Web UI `classifyTool`+`deriveSummary` 从 tool/call 的 arguments 本地推导（bash/search/read/write/code/未知）；因 DSH 0.1.2-alpha.1 不再发射 `presentCall`，`callView` 路径已死 |
| — | 工具 args fenced 代码块 | ✅ args 用独立 `` ``` `` 代码块渲染（`sanitizeCodeblock` 折反引号/剔控制字符），避免破坏卡 markdown/横向溢出 |
| — | 工具结果兜底展示 | ✅ `renderResultPreview` 各分支无输出时 `finish()` 兜底渲染原始结果内容，保证结果始终可见 |
| — | 免会话命令重启可用 | ✅ `resolveAgentOrResume`（harness）冷会话懒恢复 + 真正免会话命令（`/model`/`/reasoning`/`/approvals`/`/approve`/`/deny`/`/help`）在 `resolveAgent` 兜底前直接拦截 |
| — | 问题结算卡保留描述 | ✅ `renderSettledQuestionCard` 补上 `detail` |
| — | Turn Complete 展示 busy 模式 | ✅ footer 只读显示 `**Enter while busy:**`（Queue/Steer），与 `/status` 一致 |
| — | `/busy` 交互选择卡 + `/queue` | ✅ `feishu-busy.ts`、`/queue`（`forceQueue`），模式匹配短接 |
| — | `action.value` 双解码 | ✅ `decodeCardValue`（多深度 JSON.parse，cap 4），busy/permission/model-select/session 共用 |
| — | `/model` 一站式 | ✅ `ctx.sessionController.selectModel`（agent scoped ref + WebUI + 持久化），不再用插件 `selections: Map`/`installModelSelection` |
| — | 步骤卡实例更新必须等消息发出 | ✅ **已修复（2026-09-08）**：飞书在发送引用卡片实体的消息时对内容做快照，`cardkit.v1.card.update` 若早于 `sendCardByReference` 就不会进入该消息（表现为「只剩 reasoning」/「工具停在 running」）。`executeCardUpdate` 先 `await ref.messageId` 再更新。用 `im.v1.message.list` 带 `card_msg_content_type: 'user_card_content'` 拉回真实渲染内容验证 |
| — | 快步骤首发合并 | ✅ **已优化（2026-09-08）**：`STEP_CARD_DEBOUNCE_MS = 150`，首发也防抖——一步内 reasoning→call→result 全落窗口内时只发一张卡（内容已含结果）；步骤在窗口内结束或 turn/end 时 `flushPendingSend` 补发 |
| — | Turn Complete tok/s 口径 | ✅ **已修复（2026-09-08）**：首 token 判定改用 dsh-llm `isTokenDelta`（含 tool-call delta），新增 `totalDecodeTokens` 与 decode 时间同批配对，对齐 Web UI `deriveTurnMetrics`（此前「只调工具」的步骤会虚高，实测最高 2×） |
| — | 每张助手卡都带 tok/s | ✅ **已完成（2026-09-08）**：步骤卡 footer、溢出续卡、兜底回复卡 footer 均显示速度 |
| — | 步骤卡 footer 两行 + 定位信息 | ✅ **已完成（2026-09-08）**：footer 拆两行；卡片标题带「第 N 轮 · 第 M 步」；reasoning 标题带思考耗时与思考 token（`💬 **推理** · 4.3s · 1.2K tokens`）。**token 口径 2026-09-10 修订**：第一行 `⏱ 时长 · 📥 本步新输入（未缓存+缓存写入，有命中带 ♻️ NN%）→ 📤 输出`，第二行 `🚀 tok/s · 📊 上下文占用/窗口 (百分比)`——📥 不再用整段 prompt（那与 📊 是同一个数，会重复显示） |
| — | 运行中发消息提示 + steer 去重 | ✅ **已完成（2026-09-08）**：运行中发普通消息立即回一条**纯文本**提示（steer 已插入 / queue 已排队）；steer 分支不再等待本轮、不返回文本，避免同一 turn 出现两张回复卡 |
| — | 去掉用户消息的 `[Feishu] ` 前缀 | ✅ **已完成（2026-09-08）**：`reply()`/`steer()` 都不再拼通道前缀，用户文本原样进模型；纯图片/文件消息只带 image/file 块（不再补空文本块）。通道归属由 session↔chat 绑定记录，回复路由由插件决定，与文本无关。见 CHANGELOG |
| — | 步骤卡标题色带"变白底"定性 | ✅ **已定性（2026-09-08）**：插件发出的 `header.template` 始终正确，飞书服务端实体也是正确颜色；**部分客户端在卡片更新后不重绘标题背景**，属飞书客户端渲染问题，非插件 bug。取证方法：`im.v1.message.list` + `card_msg_content_type: 'user_card_content'`。不再往代码里查（详见下方「已知问题」） |

## 下一轮待办（2026-08-30 定）—— 5 项里只剩 1 项

> 原记录：「用户最后明确：**先更新 TODO 文件，暂不动手改代码**」。
> **2026-09-23 复核：第 2/3/4/5 项已全部完成，只剩第 1 项的「专门命令」没做**（已并入上方 **O2**）。

| # | 功能 | 优先级 | 说明 |
|---|---|---|---|
| 1 | subagent 会话独立命令 | **中** | **主会话列表剔除 subagent 会话：✅ 已完成（2026-09-02）** —— `listSessions()` 按会话 durable header `origin === 'subagent'` 过滤（DSH 子代理会话创建时即写该字段；fork 会话只有 `parentSession`、无 `origin`，不受影响，仍显示）。`/session`、`/session list`、`/session N`、onboarding 选择卡全部经 `listSessions`，一处过滤全覆盖。剩余：新增专门命令（暂定名 `subagent`）单独查看子代理会话，数据源 `ctx.subagents.listChildren` / `listDescendants`（列名称/状态/depth），只读。**尚未动工**（2026-09-11 核实：`src/` 内无该命令；与上文 rc.1 评估的 **C2** 是同一件事） |
| 2 | `/steer` 与 `/queue` idle 兼容 | **中** | ✅ **已完成（2026-09-08）**：agent 空闲时 `/steer` 自动回退为发新消息，不再报错 |
| 3 | `locale` 设置 + `/lang` | **中** | ✅ 已完成（2026-08-31）：插件 `locale` 字段（`auto`/`zh`/`en`，默认 `auto`）+ `/lang [zh\|en\|auto]` 切换持久化。**语言源 = 插件字段，默认跟随 DSH**（`settings.get('locale').preference`，无值回退 `zh`）。见 CHANGELOG「中英双语 i18n」 |
| 4 | 插件文案 i18n（zh/en) | **中** | ✅ 已完成（2026-08-31）：命令响应层（`CommandTranslations` 拆 zh/en，`src/commands-i18n.ts`）+ 卡片层（`Translations` 字典 `src/i18n.ts`）：streaming/session/busy/permission/questions/onboarding/model-select/status/footer 全部双语，术语对齐 DSH。191 测试通过 |
| 5 | 测试 + typecheck + build + restart + 文档 | **中** | ✅ 已完成：改动均已补 spec，`npm run typecheck` / `npm run test` / `npm run build` 全绿，延迟重启生效，CHANGELOG 与文档同步（`AGENTS.md` 为本地开发笔记，不入库） |

---

## 待实现

> ⚠️ 状态已刷新（2026-08-30）：`#16 权限系统接入`、`/thread→/session` 改名均已**完成**，从本表移除。
>
> 下表是**条目状态归档**（含已完成项，保留以便追溯）。**未完成项一律以上方「⬜ 未完成清单」为准**——「真正还没动工的只剩一条 #18」是 2026-08-30 的旧结论，2026-09-23 复核已被刷新（实际还有 O1–O8）。

| # | 功能 | 优先级 | 说明 |
|---|---|---|---|
| — | **`/display` 交互卡片**（卡片内设置显示开关） | **中** | ✅ **已完成（2026-09-10）**：按方案 A 落地，`src/feishu-display.ts`。无参 `/display` 发「📇 卡片显示」卡片，四个开关各一个按钮（`✅ 工具调用：开` / `⬜ 结果：关`），点击取反即持久化；**每次点击发新卡 + 上一张改写成「已失效」**（绕开「就地更新 2–3 次后按钮回调失效」）；按钮 `value` 带目标值，重复投递幂等；按 `messageId` 记住话题坐标让新卡留在原话题；发卡失败回退文本列表。测试 `tests/feishu-display.spec.ts`（9 例）。设计依据与实现差异见 [`docs/display-card-design.md`](./docs/display-card-design.md)。**未采用**方案 B 的 `checker` 多选（无需真机验证）。 |
| 18 | 思考内容**可折叠** | **中** | reasoning 代码块支持折叠（飞书 Card JSON 2.0 `collapsible` 组件）。**2026-09-08 核实**：reasoning 已收紧为 **200 字预览**（`REASONING_CAP`，不展示完整思维链）、text 超 3000 字改为拆溢出续卡；仅 `collapsible` 未实现 |
| — | **step 卡片可见性开关**（过程透明可配置） | **中** | ✅ **已完成（2026-09-09）**：新增 `showToolCalls` / `showToolArgs` / `showToolResults` 三个布尔配置（连同已有的 `showReasoning`，默认全 `true`），分别门控工具段落、`⚙️ 参数`、`📤 结果`、思考过程；`showToolCalls=false` 时工具段落整体不渲染、且**只有工具、无文字/思考的步骤不发卡**；WebUI 面板新增「卡片显示」卡承载四个 `Switch` + 插件语言。见 CHANGELOG「新增：卡片显示粒度开关 + 精简 WebUI 面板」。原记录：**后续计划**（2026-08-30 定）。step 级透明是双刃剑：对需观察/干预者有价值，对偶发使用者是打扰噪音。新增配置开关，控制三段式 per-step 卡片（💬 Reasoning / 📝 Message / 🛠 Tool call）各段展示内容，可自定义——如：①只展示其中一段；②只展示工具 description + 工具名、不展示具体 args。与 `showIntermediateMessages` 不同，是精细到"段/字段"的颗粒度 |
| 3 | ~~工作区候选补全~~ → 目录浏览器 | **中** | ✅ **已完成（2026-09-08）**：改为**目录浏览器**（比输入前缀补全更直接）——`/new` 工作区卡片新增「📂 浏览目录…」，可导航 / 分页 / 显示隐藏目录 / 选当前目录为工作区。目录来源优先 DSH `directoryPicker` 的 `browse` 能力，`native` 或缺失时回退插件自带只读列举。见 CHANGELOG「新增：/new 工作区卡片支持浏览目录」。**前缀补全本身不再做**（浏览器已覆盖）。**2026-09-08 追加**：工作区列表与目录浏览最终统一用 **`interactive_container`**（Card 2.0 整块可点击区域，官方定位就是「卡片内的列表项」）：每个工作区 / 目录一整行可点、无按钮外观、名字与路径不省略——按钮宫格 / 按内容宽度分行（飞书不认列内 `width: 'fill'`）、编号下拉框（要先选号再提交，太绕）、整行按钮（有多余按钮外观）均已弃用。控制按钮行用 `column_set` + `flex_mode: 'stretch'`（窄屏堆叠，避免手机端被压缩截断） |
| — | **旧卡片改写为「已失效」提示** | **中** | ✅ **已完成（2026-09-08）**：新增 `src/card-supersede.ts`，交互流程每发一张新卡就把上一张改写成无按钮的灰色提示卡（zh/en 双语、优先 CardKit 实例、best-effort）。已接入 `/new` 全流程（含目录浏览每一步、预设→模型交接）与 model-select 的兜底发新卡路径；`cancel`/`attach`/错误卡标记 terminal，不被改写。见 CHANGELOG「发新卡片时把被替换的旧卡片改写为『已失效』提示」。**仍待排查（2026-09-23 二轮复核，**仍在** → O4）：`feishu-session.ts` 的面板卡仍有就地更新——「🔄 刷新」（`:397`）与「📌 置顶 / 📍 取消置顶」（`:439`）都直接重绘**被点击的那张卡**，三者共享同一份额度；切换/断开/归档/fork/改名走「发新卡」，结果卡也是新卡，不占额度 |
| — | **交互卡片就地更新上限** | **高** | ✅ **已修复（2026-09-08）**：飞书对同一条消息的卡片**就地更新约 2–3 次后停止投递按钮回调**（patch 与 CardKit 实例**同样**受限）。目录浏览器改「每次导航发新卡片」；`sendCard` 已不再用 `updateCardInstance`。**仍待排查（2026-09-23 二轮复核，**仍在** → O4）：`feishu-session.ts` 面板卡的 3 个按钮（`:397`/`:439`）；`feishu-model-select.ts` 整个选择向导（provider→model→确认→成功卡**全是同一张卡**，`updateCardInstanceOnMessage` 定义 `:573`、调用点 `:646`/`:660`/`:742`/`:748`/`:802`）。两者都可能到第 2–3 次点击后回调失效——改法是「每步发新卡 + 旧卡置失效」（`/new`、`/display` 已是此模式） |
| — | **step 卡编辑次数上限** | **中** | ✅ **已修复（2026-09-08）**：step 卡改走 CardKit 卡片实例（`cardkit.v1.card.update` + 单调 `sequence`），通道未提供时回退 patch。**重要澄清**：飞书对**带按钮**的卡片就地更新约 2–3 次后停止投递回调；**step 卡没有按钮**，因此连续原地更新是安全的（详见上一条「交互卡片就地更新上限」）。见 CHANGELOG「修复：step 卡片改用 CardKit 卡片实例」 |
| — | **step 卡丢失更新（工具状态不刷新 / 卡片只剩 reasoning）** | **高** | ✅ **已修复（2026-09-08）**：① `assistant/message` 曾无条件发新卡 → 工具先开卡时旧卡被弃、再也收不到结果；改为「已有卡就更新」。② 防抖表按 session state 键 → 下一步骤的更新取消上一步骤待触发的定时器；改为按卡片 ref 键。另加 `[send]`/`[update]` 诊断日志。见 CHANGELOG「修复：step 卡片丢失工具状态更新 / 只剩 reasoning」 |
| 9 | 流式输出 → CardKit | ~~低~~ **不再做** | ~~解决 5 QPS 瓶颈。单卡持续流式更新（`streaming_mode`）~~。**2026-09-02 用户决定：不再做流式输出，方向取消** |
| — | ~~清除 `/stream`（stream on 状态）~~ | **中** | ✅ **已完成（2026-09-02）**：移除 `/stream` 命令 + `showIntermediateMessages` 配置，保留三段式 per-step 卡片更新机制（stream off/默认行为不变）。见 CHANGELOG「移除：/stream 命令及 showIntermediateMessages 配置」。原记录：**只清除「stream on = 流式更新文字」这个一直没用状态；三段式 per-step 卡片更新机制保留，stream off（默认）行为不变**。范围：`/stream` 命令（index.ts + commands.ts 注册/`/help`）+ `config.ts` 的 `showIntermediateMessages` 字段 + toggle 写入路径。**关键事实**：`showIntermediateMessages` 只在 `/stream` toggle 写入，无任何渲染路径读取——统一三段式卡片始终渲染、与开关无关，故删掉不影响默认行为 |
| 8 | 文档与版本一致性 | **低** | **README / docs/architecture.md / TODO / CHANGELOG 已同步（2026-09-08 二轮）**：per-step 卡片/footer/定位信息、reasoning 耗时与思考 token、原生附件库、busy 提示、`[Feishu] ` 前缀移除、标题色带客户端问题均已写入；README/TODO 里指向未公开 `AGENTS.md` 的链接已改指 `CHANGELOG.md`/`README.md`。版本号 `package.json` 已是 **`0.2.0`**（旧记录误写 0.1.0），发版时统一 bump |
| — | 飞书 SDK 卡片回调补丁追踪 | **低** | 2026-08-30 核实：**可关闭** —— 无 postinstall/patch，SDK `1.73.0` 原版；card 帧被过滤已**证伪**（「已知问题」同段已标注）。仅为未来 SDK 变更留档 |
| — | **思考期反馈 / 发卡时机** | **中** | ✅ **已实现（2026-09-23，见上方 O1）**：此前思考期间完全无反馈，第一张卡只在本步模型输出落地后才出现，用户感知延迟 = **思考时长 + 150ms 首发防抖**。根因：0.1.3 起 `assistant/chunk` 被移除、token 级增量不再是持久事件（实时增量只以 client-only `assistant/live-chunk` 存在于 Web 的 follow 流），而插件订阅的是持久事件总线 `session/event`；`step/start`（思考开始时就到）当时只重置状态、不发卡。**采用方案 A**（已落地）：`step/start` 立即发「深度思考中…」占位卡，`assistant/message` 到达后原地更新为 reasoning 区。**明确不做流式**（原方案 B）。详见「已知问题 → 思考期无反馈：发卡时机偏慢」。 |
| — | **agent 回复过长被飞书截断 → 自动分段发送** | **中** | ✅ **已实现**（2026-09-08）：step 卡 text 超 `TEXT_STEP_CAP=3000` 自动拆溢出卡（`renderOverflowCard` + `chunkText`），不再截断丢弃；reasoning 收紧 200 字；args 改 pretty 打印 2k 上限。见 CHANGELOG「修复：step 卡 text 超 3000 字不再截断 → 自动拆分溢出卡发送」 |

> ✅ 已从本表移除（2026-08-30 确认完成）：
> - `/new` 带参数（`--workspace`/`--preset`）—— 已实现
> - 多 session 话题导航 —— 已做（会话映射持久化 + 话题映射）；**不再做并行可见性**（用户明确）
> - `#16` 权限系统接入、`/thread→/session` 改名、SDK 补丁追踪（证伪关闭）

---

## `/thread` → `/session` 改名清单 —— ✅ 已完成（2026-08-30）

> 命令实际操作的是 DSH session（`bridge.listSessions()` / `bridge.switchToSession()`），`thread` 命名与飞书原生"话题"混淆，且与 WebUI「会话」心智不一致。**不保留 `/thread` 别名**，`/help` 列表中只出现 `/session`。下方清单为提出时的改动范围，历史存档。
>
> ⚠️ 只改**命令相关**的 thread 引用；`threadId` / `replyInThread` / `thread_id`（飞书话题消息坐标）与命令无关，**不要动**。

| 文件 | 改动内容 |
|---|---|
| `src/commands.ts` | 翻译键 `threadDescription`/`threadUsage`/`threadListHeader`/`threadListEmpty`/`threadListEntry`/`threadSwitched`/`threadInvalidIndex`/`threadArchived`/`threadIdle`/`threadLastActive*` → `session*`；`name: 'thread'` → `'session'`；`handleThreadCommand` 函数名；`formatRelativeTime` 内 `t.threadLastActive*` 引用 |
| `src/index.ts` | `executeSlashCommand` 中 `parsed.name === 'thread'` → `'session'`；translations 定义（约 489-502 行）的 `threadXxx` 键 → `sessionXxx`；`handleThreadDirect` 函数名及内部 `t.thread*` 引用 |
| `tests/commands.spec.ts` | stub translations 的 `threadXxx` 键 → `sessionXxx`；`registered.map(item => item.name)` 期望数组 `'thread'` → `'session'`；`describe('/thread command')`；`item.name === 'thread'` 查找；`Usage: /thread [N]` 断言文本 |
| `README.md` | 斜杠命令表 `/thread` → `/session`；`\| /thread [N] \| 列出/切换会话 \|` 行 |
| `AGENTS.md` | 3 处 `/thread` 提及（功能对齐表"多 thread 并行工作"行、session 映射持久化行）→ `/session` |
| `CHANGELOG.md` | 在 Unreleased 段**新增**一条改名记录（历史条目保留原文不动） |
| `TODO.md` | 本文档自身："多 thread 话题导航"行中 `/new` `/thread` 已通 → `/new` `/session` |

不需要改：`tests/harness.spec.ts`（无 thread 字样，经确认）；`src/harness.ts` / `src/conversation.ts` / `src/channel.ts` / `src/feishu-*.ts` / `docs/architecture.md`（仅含飞书话题 `threadId`/`replyInThread`，与命令无关）。

---

## 已知问题

### 思考期无反馈：发卡时机偏慢（**2026-09-22 定性 → 2026-09-23 方案 A 已实现**）

**已实现（2026-09-23，O1 收口）**：`step/start`（模型请求发出前）立即发「🧠 深度思考中…」占位卡（带轮/步号，`PLACEHOLDER_TICK_MS = 5s` 刷新已用时）→ `assistant/message` 写入 reasoning / 文本 → `tool/call` → `tool/result`，四阶段**同一张卡**就地更新；`step/end` 时若该步始终没有可见内容，占位卡折叠为「本步无输出」（新增 i18n：`stepPlaceholderTitle` / `stepPlaceholderBody` / `stepEmptyTitle` / `stepEmptyBody`）。方案 B（消费 client-only `assistant/live-chunk` 做逐字流式）**仍不做**：真流式只在 Web 客户端 follow 流里，改动面大（新增消费链 + 卡片更新限流 + 与 `session/event` 去重），使用者 2026-09-22 已决定不做。

**现象**：使用者报告「模型正在思考的时候并不会发卡」——长思考（`high`/`max` 推理等级）期间聊天里完全没有动静，第一张步骤卡直到**本步模型输出落地**才出现。

**根因（三条，都是宿主契约变更后遗留的）**：

| # | 事实 | 后果 |
|---|---|---|
| 1 | DSH **0.1.3 移除了 `assistant/chunk`**，token 级增量**不再是持久事件**（0.1.6 的 `packages/core/agent-loop/tests/loop.spec.ts` 直接断言该事件不存在）。实时增量改为 **client-only** 的 `assistant/live-chunk`，只存在于 Web 客户端的 follow 流（`packages/api/session-controller/src/client/sessions/assistant-stream.ts`；其 README：「every stream member becomes a **Client-only** `assistant/live-chunk` entry」） | 宿主侧看不到"正在生成"的增量 |
| 2 | 插件订阅的是**持久事件总线** `ctx.on('session/event', …)`（`src/feishu-streaming.ts`） | 结构上就看不到任何未提交的内容；插件里唯一的"早期触发"正是那条已死事件——文件头注释与 `assistant/chunk` 分支仍是 0.1.3 之前的契约，现在是**只累加、不发卡**的死代码 |
| 3 | **`step/start` 才是"思考开始"的信号**（`packages/core/agent-loop/src/agent.ts` 在 `await this.step(...)` **之前** append，必然早于模型请求发出），但插件收到它只 `resetStep` + 记时间，**不发卡**；其余发卡点（`assistant/message` / `tool/call` / `tool/result`）全在本步输出落地之后 | 首卡延迟 = 完整思考时长 + 150ms 首发防抖 |

⇒ 代码注释里那句「card still appears ~150ms after the step starts」是 0.1.3 之前的描述，**现已不成立**（实际是"本步内容落地后 150ms"）。

> 补充事实：`assistant/attempt` 是**持久**事件且带 `{turn,step,stream}`（部分思考流），但只在 abort / error / retry 的 settle 时刻 append → 可用于渲染"被打断的思考"，**当不了思考开始的节拍器**。

**方案 A（2026-09-23 已按此实现，见 O1）**：`step/start` 立即发一张「深度思考中…」占位卡（带已用时），`assistant/message` 到达后**原地更新**成 reasoning 区——复用了原有的 `stepCardSent` → `updateStepCard` 路径。

要处理的边角（**四条均已按此处理**，见 O1）：

1. 需要一个**占位态渲染**（现在卡片标题/颜色只看工具状态，无 reasoning/text/tools 时没有专门形态）；
2. 现有 `stepHasVisibleContent` 门控在无内容时**跳过发卡**，占位阶段需放行；
3. 要定「本步最终无可见内容」（例如只调工具且关掉工具显示）时占位卡的去留——现有设计明确不产生噪音卡，倾向撤掉或改写为一行极简结果；
4. 文案进 i18n（zh/en 各一条）。

**成本**：常见路径**不增加发卡次数**（占位卡就是那张步骤卡，后续只是 update），仅"最终无内容"的步骤多一次创建。

**明确不做**：方案 B —— 订阅 `sessionController.follow()` 消费 `assistant/live-chunk` 逐字渲染（对齐 Web UI）。改动大（新增消费链、卡片更新限流、有界等待纪律、与 `session/event` 去重），且 **2026-09-22 使用者决定不做流式**。

### ✅ 超阈值分卡会切坏 Markdown（表格等）—— **已修复（2026-09-18）**

**现象**：使用者报告「卡片消息超出设定的字数阈值后，分卡发消息会破坏 Markdown 格式（比如表格等）」——同一条回复被拆到多张卡上时，表格/代码块等**跨行结构**被从中间切开，两端各渲染半张表。

**定位（两处硬切，均无 Markdown 边界感知）**：

| 位置 | 原实现 | 问题 |
|---|---|---|
| `feishu-streaming.ts` | `fullText.slice(TEXT_STEP_CAP)`（3000）| **纯字符切片**——切点落在哪全看字数，落进表格/代码块内部就各持一半 |
| `text-chunk.ts` | 单个段落超预算时 `para.split('\n')` 逐行硬切 | Markdown **表格是一个段落**（行间只有单个 `\n`、没有空行），因此整张表走这条分支被切两半；同时影响 `channel.ts` 的 reply 卡 |

**修法（用户方案：从空行切、提前点切）**——`src/text-chunk.ts` 重写为**块感知切分**：

1. **装箱阶段**：先把 markdown 切成「块」（空行分隔；**代码围栏内部的空行不算分隔**），再把块装进卡里；当下一块放不进剩余预算时，**回退到上一个块边界**结束当前卡，绝不让一块跨两张卡。
2. **超预算单块**按类型给最小破坏的切法：**代码围栏**在每个分片闭合再重开（每片都是合法代码块）；**表格**在每个分片重复表头与分隔行（每片都是合法表格）；其余（长列表/引用/段落）退回行边界，单行超长才按字符切。
3. `feishu-streaming.ts` 的步骤卡与续卡改为**共用同一次切分**：步骤卡渲染 `segments[0]`，其余成为续卡——两者永远一致，不可能再对不上。

**验证**：`tests/truncation.spec.ts` 新增 7 例（提前切到上一个空行 / 表格整体进下一张卡 / 超预算表格重复表头 / 代码围栏闭合重开 / 围栏内空行不作边界 / 单行超长仍按字符切 / 混合文档逐块保真），`tests/feishu-streaming.spec.ts` 新增 1 例（2990 字填充 + 表格 → 步骤卡只含填充、表格整体进续卡；短文本表格完整渲染）。

> **一条踩过的坑（勿再清理）**：升级时曾把工具摘要表里的 `cordis_run/stop/undefine`、`cordis_package_inspect/runtime_inspect` 当成「alpha.2 已删除的工具」换掉——**错的**。这张表镜像 Web UI 的 `TOOL_VARIANTS`，而该文件在 alpha.1/alpha.2 之间逐字节未变、仍映射这些旧名，为的是让**旧会话记录的工具调用**继续以相同摘要重渲染。已回退（见 CHANGELOG）。`plugin_manager` 不在 Web UI 变体表里，走通用 `plugin_manager · <action>` 行即对齐。

全套 **415 passed / 33 files**（原 405），typecheck 0 error，build ✅。

> 相关：本文档「飞书消息长度限制调研记录」已给出卡片 30KB 请求体 / 单 markdown 元素约 10k 字符的隐式上限与推荐拆卡阈值（~6k–8k 字符）；本次修法与该阈值选择无耦合。

### 飞书侧报错内容比 WebUI 简略（**turn 级 2026-09-17 修复；剩余部分 2026-09-23 复核并收口 → O6**）

**现象**：使用者报告「报错时 feishu 端显示的内容不详细，没有和 webui 对齐」——同一次失败，WebUI 能看到完整错误原文，飞书这边只剩一句被截断的摘要。

**✅ 已修（2026-09-17，turn 级错误）**：飞书原先只回一句通用句子，现在**直接渲染 WebUI 那一份失败事实**。根因是 `summarizeTurn()` 丢掉 `turn/end` 的 `reason.error`，`harness.reply()` 随即抛硬编码的 `Harness turn did not produce a successful assistant response`（journald 里 09-08 起出现 20+ 次）。改法见 CHANGELOG「飞书把 turn 失败压成一句通用错误」：新增 `src/turn-failure.ts` **逐行移植** WebUI 的 `displayFailure` + `TurnErrorItem`（红头 + `本轮运行失败`/`This turn failed` + 原文正文 + `code`；`AUTH` 换 `API 密钥无效`/`API key is invalid`），红卡被拒时回退同样内容的纯文本。顺带修掉 `/stop` 中止当前轮后**必然错报一次"运行失败"**的问题（`aborted`/`interrupted` 等非失败结束不再报错）。

**✅ 复核（2026-09-23）——原记录的「仍存在的上限」一条都没被触发过。** 使用者先说「现在很多错误在飞书已经能看得到了」，逐条实测证实了这个观察。测量口径：`~/.dsh/sessions/*/*/session.v3.jsonl.zstd` 全部 **23 个会话日志**，解出 `tool/result` 的每个 `tool-result` 块，取 `isError === true` 的 `content[].text` 长度：

| 指标 | 值 |
|---|---|
| 工具结果总数 / `isError=true` | **21645 / 734** |
| 错误文本长度 | min **22** · p50 **149** · p90 **313** · p99 **313** · **max 344** |
| 超过 600 字 | **0 条（0.00%）** |
| 超过 1500 / 3000 / 4000 / 10000 字 | **0 条（0.00%）** |
| `turn/end` 且 `reason.kind === 'error'` | 全历史 **3 次**，最长 **140** 字（`UNSUPPORTED_REASONING_EFFORT` ×2、`PI_AI_ERROR` ×1） |

即「工具 1500 / reasoning 200 / 正文 3000 / 插件侧 600」这四条上限**在真实负载下一次都没咬到**（p90 才 313，离 1500 差 5 倍）。**作为"报错不详细"的问题，O6 已经被 09-17 的 turn 级修复 + 错误本来就短这两件事实解掉了。**

**真正的缺口换成了另一件事：有一类错误用户永远看不到。** 7 天 journal 分类：

| 错误 | 次数 | 用户看得见？ |
|---|---|---|
| `[update] failed`（`cardkit.card.update` / patch） | **15** | ❌ **只有 journal**，卡片**静默停在旧内容** |
| `message handling failed` | 6 | ✅ 有（文本，`errorText()`） |
| `[send] card instance create failed` | 2 | ❌ journal（有回退，回退失败就没了） |
| `[send] send by reference failed` | 1 | ❌ journal（同上） |
| `[sdk error]` / `[sdk warn]` / `reconcile failed` | 7 / 3 / 1 | ❌ journal |

停在「🧠 深度思考中」的那两张卡（第 28 轮第 9 步、第 30 轮第 4 步）就是 17:43:49 / 17:50:26 的两条 `[update] failed`：`feishu-streaming.ts` 的更新失败分支只 `console.log` + `logger.warn`。L2（[`card-write.ts`](./src/card-write.ts)）已把"内容级拒收 → 剥净重试 → 回退 patch"补进写路径，**18:36 重启后至今 0 条 `[update] failed`**；但"回退也失败"时用户仍然什么都收不到。

**✅ 2026-09-23 收口（本批两件事）**：

1. **`errorText()` 不再丢根因**（[`error-text.ts`](./src/error-text.ts)）：补 `cause` 链（最多 4 跳、去重、防自引用，用 ` ← ` 拼）与飞书 SDK 响应信封里的 `response.data.msg`，`code` 也认信封里的业务码。动机是本仓真实错误形态：`Request failed with status code 400` 这句话里没有任何信息量，真正的原因是 `card contains invalid image keys`。**只读 `message`/`code`/`response.data`，绝不读 `config`/`request`**（请求体，token 路径上有 app secret → 关键坑 29）。上限 600 → **1000** 字符（文本消息上限 150KB，这个数字只是防病态负载）。
2. **陈旧卡改为用户可见**（[`feishu-streaming.ts`](./src/feishu-streaming.ts)）：步骤卡写入失败且此后无成功写入时，发一条**纯文本**通知「⚠️ 第 N 轮第 M 步的卡片没能更新，已停在旧内容。原因：…」。`STALE_CARD_CONFIRM_MS = 2s` 确认窗——被下一次写入救回的错误**不报**（15 次里有相当一部分是瞬时失败，报出来就是把恢复过程变成噪音）；每张卡只报一次；`stop()` 清掉待发定时器。**选文本而非卡片**：要上报的正是「卡片写不进去」，再用卡片去报是自相矛盾；且文本不经 markdown 解析，不会因为错误原文里的图片/链接语法被整卡拒收（关键坑 39）。

**WebUI 侧对照**：`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` 的输出格把 `record.cell.outputDetail` **整段**塞进 `<pre>`（并附「复制输出」按钮），**不做字符截断**；聊天区也保留完整错误文本。现在的差距只剩"超长原文"这一档，而它在 734 次失败里 0 次出现。

**仍保留的上限（有数据支撑，本批不动）**：工具失败预览 `RESULT_PREVIEW_CAP = RESULT_CONTENT_CAP = 1500`；结构化预览取样（`paths` 前 20、`files` 前 5、`matches` 前 3、`diffs` 前 3、每个 diff 各 8 行）；`REASONING_CAP = 200`；`TEXT_STEP_CAP = 3000`（正文溢出拆「Reply (continued N/M)」卡，**不丢**）。

**仍可选（记录备查，未动工）**：

1. 工具结果 **> 4k** 时，卡片里保留预览、另发一条**文本**全文（当前 0/734 触发，尚无需求）；
2. 超大错误（> ~100KB）落 `.log`/`.txt` 到工作区，交已有的 `feishu_send_file` 推送（零新面，第三级逃生口）；
3. ~~`/error` 命令回看最近一次错误的全文~~ **倾向不做**：与 1 信息重复，且插件不保留会话级错误状态，成本高于收益。

### 交付物面比 WebUI 窄：produced 整半未实现 + complete 卡只对飞书触发的轮次发送（**2026-09-17 记录，2026-09-23 复核仍未做 → O3**）

**现象**：使用者报告「产物信息有的时候出现在最后一个卡片，这是步骤卡片而不是 complete 卡片」。

**核实一：步骤卡上那条不是 bug。** 步骤卡里的「交付文件：xxx +N」是 DSH `present` **工具调用**的渲染（`feishu-streaming.ts:1235` 的 `deriveToolSummary` 摘要 + 紧随的 `⚙️ 参数` / `📤 结果`）；WebUI 对同一个工具调用也是照样渲染，两端一致。`📦 **交付文件（N）**` 清单只可能出现在 complete 卡上：唯一渲染点 `channel.ts:770`（`renderFooterCard`，清单取自 `turnStats.deliverables`），唯一调用点 `channel.ts:525`（**行号已按 2026-09-23 的 `src/` 更新**）。实测 DM 1500 条消息 + 群 25 个话题 2005 条消息，**0 例**出现在步骤卡。

> 排查方法（可复现）：`im.v1.message.list` 带 `card_msg_content_type: 'user_card_content'` 拉回用户可见卡片 JSON，再**按元素开头精确匹配** `^📦 **(交付文件|Present files)**`；判定步骤卡里的那条用 `^> 交付文件：`。⚠️ 不要用「正文含『交付文件』」这种粗筛——工具参数/结果里可能字面含这四个字（例如 grep 过 CHANGELOG），会大量假阳性。

**核实二：真正的缺口是 produced。** 插件只订阅 `deliverables/presented`（`feishu-streaming.ts:864`），**没有实现 WebUI 的 produced 这一半**。

**WebUI 的真实渲染条件**（`packages/client/ui-deliverables/src/client/Deliverables.tsx` 的 `selectDeliverables`）：`produced.length + presented.length === 0 ? null : {...}` —— 「本轮 write/edit 成功改过文件」**或**「调过 `present`」二者有其一才挂载那一行（所以 WebUI 也不是每轮都显示，这点使用者已当场指出）。`produced` 的推导在 `turn-deliverables.ts` 的 `mutationPath()`：只认 `write` / `edit` / `str_replace_editor`（tool/call 记路径，tool/result **非 error** 才算），按 path 去重、首次出现顺序，并排除 closing assistant seq 之后的结果。

**量化**（本会话 turn ≥ 200 共 56 轮，逐轮从 `session.v3.jsonl.zstd` 统计）：`present` 5 轮、write/edit 有产出 23 轮、两者皆无 33 轮 ⇒ **WebUI 有产物行而飞书完全没有 = 18 轮（32%）**。"改了文件但没调 `present`"是常态而非偶发。

**这解释了现象本身**：不调 `present` 的轮次（18/23 的多数），飞书侧唯一的产物线索就是步骤卡里 `write`/`edit` 工具调用的 `⚙️ 参数`（`file_path`）与 `📤 结果`（`<path>…`）；WebUI 轮末那行「改动的文件」在飞书没有对应物。而"有时候"＝模型恰好调了 `present` 的轮次——那时 📦 清单才出现在 complete 卡上。

**缺口 2（origin）**：complete 卡只在**飞书入站消息触发的轮次**发送（唯一发送点在 `channel.ts:525`，位于 `bridge.reply().then()` 内），而 WebUI 的交付行挂在 `turn/start` 上、与来源无关。实测第 **251** 轮（此前 6.5 小时无飞书消息，最后停在「回复 · 第 251 轮 · 第 8 步」）**没有 complete 卡**，第 203 轮同样。本窗口内没有「`present` + 非飞书触发」的轮次，故尚未造成实际丢失，属逻辑风险。

**缺口 3（整块丢）**：`channel.ts:531-544` 的 else 分支（`intermediateSent === false`）走 `renderReplyCards`，而它的入参只有 `meta` + 一个 `tps` 数字，**拿不到 `turnStats.deliverables`** ⇒ 交付清单不渲染，也没有 Turn Complete 的指标行（tok/s 那一行有，是从 `turnStats` 单独算出 `tps` 传进去的）。群里实测命中 **15 次**，DM 0 次。

**✅ 顺带隐患已修（2026-09-17）**：`markIntermediateSent` 原先只在卡片**首次发出**时判断有无文本（`feishu-streaming.ts` 的 `actuallySendStepCard`）；若该步先被 `tool/call` 开卡、正文后到（走 `updateStepCard`），标记不会补上 → channel.ts 会再发一张**重复**的蓝色 `Reply` 卡（正文出现两遍）并且不发 complete 卡。现抽成 `noteStepCardText(sessionId, state)`、**发送与更新两条路径都调用**（`SessionStepState` 因此带上 `sessionId`），3 例新测试；这也**缩小了下面缺口 3 的触发面**。详见 CHANGELOG「工具先开卡、正文后到时误判…」。

**可选方向（未定、未动工）**：

1. **补 produced**（直接消掉那 18 轮缺口）：在 streaming 里按 WebUI 同规则收集 write/edit/str_replace_editor 的成功产出（path 去重、首次出现顺序、closing seq 截断），渲染进 complete 卡；
2. **complete 卡改为「轮次结束即发」**：让 streaming 在 `turn/end` 补发，并与 channel.ts 约定「谁负责这一轮的 footer」，覆盖飞书没触发的轮次；
3. **else 分支接上 `turnStats`**，至少把交付清单渲染出来。

**处理**：2026-09-17 使用者决定**三个缺口先只记录、不改**；同轮只修了上面那个已复现的隐患。**2026-09-23 复核：三个缺口一个都没动 → O3。**

### 推理 token 数在 DSH 0.1.6 后消失（**宿主侧回归，非插件 bug**，2026-09-16 定性）

**现象**：步骤卡的推理标题从 `💬 **推理** · 807ms · 135 tokens` 变成 `💬 **推理** · 5.3s`——思考耗时还在，**推理 token 数没了**。真机卡片历史对照（`im.v1.message.list` + `card_msg_content_type: 'user_card_content'`，264 张推理卡）：09-15 15:45 及以前带 token 数（不带的都是该步本就没有推理），**09-15 20:20 重启后 0 张**。

**根因（已取证到 wire 层）**：DSH `0.1.6` 把 `@deepseek-ai/dsh-llm-deepseek` 的 `protocol` 默认值改成了 **`messages`**（`packages/llm/llm-deepseek/src/config.ts`，端点 `https://api.deepseek.com/anthropic`），而**该端点的 usage 根本不带 thinking 明细**——直接打 API（流式 + 非流式都试过）只返回 `input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `service_tier`；`protocols/messages/translate.ts` 的 `updateUsage` 自然也只映射这四个计数字段。老协议 `/chat/completions` 仍返回 `completion_tokens_details.reasoning_tokens`（实测 `{"reasoning_tokens": 23}`），`chat-completions/mapUsage` 会映射成 `reasoningTokens`。会话日志逐小时统计佐证：09-15 20 点前几乎每步都有 `usage.reasoningTokens`，**20:20 重启后 174 步全部为 0**。

**影响面**：插件步骤卡的 `· N tokens`；**以及 DSH WebUI Trajectory 面板的 think 用量格**（`packages/client/ui-trajectory` 读的就是同一个 `usage.reasoningTokens`）——两端一起丢，所以这是宿主侧的事。

**为什么插件修不了**：数值在 wire 上不存在，宿主拿不到，插件更拿不到。可选只有两条，**2026-09-16 使用者决定「先不改，只记录」**：

1. 给 `llm-deepseek` settings 段（或 profile overlay 行）设 `protocol: chat-completions` → 精确值立刻回来（代价：本机不再走 `messages` 协议）；
2. 插件按推理文本做 CJK 感知估算并标 `≈` → 全协议可用，但不是精确值。

**处理**：不要在插件里继续找这个"bug"。建议把这个宿主侧回归反馈给 DSH：`TokenUsage.reasoningTokens` 仍在类型里、`ui-trajectory` 仍在读，但默认协议已经不再产出它。

### 卡片标题色带在部分客户端更新后不重绘（2026-09-08 重新定性）

**现象**：卡片更新（`im.v1.message.patch` 或 `cardkit.v1.card.update`）后，标题背景色在部分飞书客户端上消失、变成白底（`header.template` 的缺省值 `default`）；同一张卡片在另一台设备上显示正常。

**核实结论**：**不是插件 bug，也不是 patch 的问题**。用 `im.v1.message.list` 带 `card_msg_content_type: 'user_card_content'` 拉回用户可见卡片 JSON，最近 2000 条消息 / 1836 张卡片的 `header.template` 全部合法（green/blue/wathet/red/grey/turquoise），**0 张缺失或 default**，且头体一致、服务端实体颜色正确。故属于飞书客户端渲染问题。

**旧记录更正**：早期「`im.v1.message.patch` 只更新 body、不更新 header」的判断**不成立**——拉回的实体里 header 标题与 template 都已更新（例如 patch 后标题从「创建时」变为「更新后」）。真正不生效的是部分客户端的**重绘**。

**处理**：不要在插件里改 header 数据去"修"它。用户侧切换会话 / 重启客户端通常可恢复。若将来要弱化影响，方向是让状态不依赖标题色带（用标题文字/emoji 表达），而不是改数据。

### ~~Node.js SDK `MessageType.CARD` 被过滤~~（已证伪，补丁已移除）

**现象（原判断）**：飞书卡片回调事件（`card.action.trigger`）通过 WebSocket 推送时 `type='card'`，Node.js SDK 的 `handleEventData` 过滤了 `type !== 'event'` 的消息。

**纠错**：该判断经**对照实验证伪**——还原 pristine SDK（`type !== MessageType.event`）后重启，`card.action.trigger` 仍以 `type='event'`（带 `event_type`）到达插件，卡片点按正常。即帧过滤并不拦它，**此前加的 `scripts/patch-sdk-card-action.sh` + `postinstall` 补丁是过度诊断，已移除**，SDK 还原为官方原版。真正导致卡片「点按无反应」的是 `action.value` 双编码解析问题（用 `decodeCardValue` 修复，见 CHANGELOG）。

**长期方案**：若未来 SDK 变更导致 card 帧被拦，再评估提 issue/PR。

### `action.value` 双重编码

**现象**：飞书返回的 `action.value` 是 JSON 字符串内嵌 JSON 字符串（双重编码）。

**解决**：`JSON.parse` 两次（feishu-questions.ts、feishu-approvals.ts）。

---

## 问题追踪（2025-08-27）

### ✅ WebUI 改模型后 status 命令显示不更新 —— 已解决（2026-08-30）

**现象**：
- WebUI 里切换模型后，`/status` 命令显示的模型名仍是旧模型
- 即使在 WebUI 切换后进行一轮对话，`/status` 仍显示旧模型
- 在飞书继续对话后，`/status` 仍不更新，但实际对话的模型已经是 WebUI 切换后的模型

**复现**：WebUI 修改模型 → `/status`（显示旧模型）

**根因分析**：`/status` 命令读取的是 `bridge.selections`（飞书侧的 per-chat selection ref），而 WebUI 切换模型只更新了 `apiProxy.selections`（WeakMap，WebUI 侧）。两者是独立的缓存，没有同步。

**修复方向**：`/status` 命令需要优先从 `sessionController.selectModel` 的结果或 `selectionFor(agent).current` 读取当前实际模型，而不是只读 bridge 的 selection ref。

**解决**：`/model` 已改为 `ctx.sessionController.selectModel(...)` 一站式（写 agent scoped ref + WebUI + 持久化），插件不再维护独立的 `selections: Map`/`installModelSelection`；`/status` 改为读 `selectionFor(agent).current`（scoped ref）。飞书与 WebUI 收敛到同一处缓存，不再各读各的。**已确认解决**。

---

### ⚠️ MiniMax M3 思考强度选项差异 —— **可解（2026-09-17 重新定性）：settings 一处即可，插件与 DSH 都不用改**

**现象**：MiniMax M3 的思考强度选项与标准模型不同——`/reasoning` 列出 `off / minimal / low / medium / high`，而 M3 的 `/anthropic` 端点只认 `adaptive` / `disabled`。

**根因（已取证到 wire 层）**：

- M3 在本部署走 `llm-pi-ai` 的 `api: anthropic-messages`（`baseUrl: https://api.minimaxi.com/anthropic`）。pi-ai 随附的 `providers/data/minimax-cn.json` 里 M3 只有 `reasoning: true`，**既无 `thinkingLevelMap` 也无 `compat`**；DSH 的 `resolveModelReasoning()`（`packages/llm/llm-pi-ai/src/catalog.ts`，`efforts === undefined` 分支）原样透传 → `getSupportedThinkingLevels()` 列出上面那 5 档，请求走 pi-ai 的 **budget 分支**：`thinking: {type:'enabled', budget_tokens:N}`（`@earendil-works/pi-ai` `dist/api/anthropic-messages.js` 的 `streamSimple`，只有 `compat.forceAdaptiveThinking === true` 才走 adaptive）。
- MiniMax 官方口径：**M3 只接受 `thinking:{type:'adaptive'}` / `{type:'disabled'}`，会静默忽略 Anthropic 的 `enabled + budget_tokens`**（表现为拿不到 thinking 块 / `reasoning_tokens=0`）；M2.x 反而继续用 manual 形态。两家独立实现为此各发过一个 fix，可直接当参照：hermes-agent `3c680ea`（fix(minimax): preserve native M3 thinking on Anthropic routes）、`8267f85`（fix(anthropic-adapter): treat MiniMax M3 as adaptive-thinking on /anthropic），两处都注明来源为 [MiniMax Anthropic 兼容文档](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api)。

**修法（settings-only，改 `~/.dsh/settings.yaml` 的 `llm-pi-ai` 段；插件零改动）**：给 M3 显式声明 `compat.forceAdaptiveThinking` + `reasoningEfforts`：

```yaml
llm-pi-ai:
  providers:
    minimax-cn:
      models:
        - id: MiniMax-M3
          name: MiniMax-M3
          contextWindow: 1000000
          maxTokens: 128000
          compat:
            forceAdaptiveThinking: true   # → pi-ai 发 thinking:{type:'adaptive'}
          reasoningEfforts:
            off: disabled                 # 非 null → pi-ai 发 thinking:{type:'disabled'}
            high: high                    # 唯一"开"档（M3 本来就不分档）
```

要点与坑：

- `off:` **不能留空**。留空（= `null`）会被 pi-ai 读成"支持但什么都不发"（`model.reasoning && thinkingEnabled === false && thinkingLevelMap?.off !== null` 这条判据），而 M3 在**没有 thinking 参数时会返回空响应**——必须给个非空字面量，值本身不参与这条分支的 wire。
- **M2.x 不要加** `forceAdaptiveThinking`：M2 家族的 `/anthropic` 不支持 adaptive（同一仓库测试里就有 M2.x 保持 manual 的断言）。
- `/reasoning` 会**自动**跟着变，因为插件读的是 `llm.resolveModelInfo()` → pi-ai 的 `getSupportedThinkingLevels()`（`packages/llm/llm-pi-ai/src/adapter.ts` 的 `reasoningInfo()`）：声明后列表只剩 `off / high`，插件侧**一行都不用动**。

**残留风险（需真机验一次，不要只看配置）**：pi-ai 的 adaptive 分支除了 `thinking:{type:'adaptive'}` 还会带一个 `output_config:{effort:<映射值>}`，而 MiniMax 文档只提 adaptive/disabled、没提这个字段。若 M3 对多出来的字段返回 400，就落到 pi-ai/宿主侧，超出 settings 能解决的范围（只能等上游或改源码）。**验证方式**：切 M3 + `/reasoning high` 跑一轮，看步骤卡是否出现 `💬 推理`、以及是否报错——只是"配置生效"不算验证。

**状态**：原记录「✅ 已明确，无需修复」**已更正**为**可解**。settings 改动**尚未执行**（等确认是否需要切 M3 用再做）。

---

## 卡片颜色参考

| 颜色 | 用途 | 文件 |
|---|---|---|
| blue | Reply 回复卡片、问题卡片 | `channel.ts`、`feishu-questions.ts` |
| turquoise (青绿) | Todo 列表卡片、已选问题卡片 | `feishu-todos.ts`、`feishu-questions.ts` |
| wathet (浅蓝) | Tool Call 调用中 | `feishu-streaming.ts` |
| green | Tool Result 成功 / Turn Complete | `feishu-streaming.ts`、`channel.ts` |
| red | Tool Error 失败 | `feishu-streaming.ts` |
| orange | 审批请求 | `feishu-approvals.ts` |
| grey | 无选项问题 | `feishu-questions.ts` |

---

## #11 中间消息不可见 —— ✅ 已修复

- **根因 1**：旧代码用 `ctx.on('session/event')` 订阅 Cordis 事件，在插件 scope 中不生效
- **根因 2**：旧代码依赖 `showIntermediateMessages` 设置，默认为 `false`
- **修复**（2025-08-25）：
  - 改用 `ctx.on('session/event')` 监听（与 toolcalls/todos 一致）
  - 逻辑：`assistant/chunk` → 累积 text-delta → `tool/call` 到达时 flush 为紫色卡片
  - 不再依赖 `/stream` 开关或 `showIntermediateMessages` 设置
  - 不再调用 `markIntermediateSent`（中间消息 ≠ 最终回复，不应跳过最终卡片）

## #17 `/reasoning` 推理等级命令 —— ✅ 已实现

- **命令**：`/reasoning` 查看 / `/reasoning off|low|high|max` 设置
- **持久化**：通过 `agentDefaultModel.saveSelection()` 写入 DSH settings，重启后自动恢复
- **联动**：status 卡片 + footer 均显示当前 reasoning effort

## #12 tool call 卡片 markdown 不渲染 —— ✅ 已修复

- **问题**：`feishu-toolcalls.ts` / `feishu-todos.ts` / `feishu-questions.ts` / `feishu-approvals.ts` 使用 `{ tag: 'div', text: { tag: 'lark_md' } }`，只支持粗体/斜体/链接，不支持代码块。
- **修复**：改为 `{ tag: 'markdown', content }`（同 reply card）。`channel.ts` 的 note 区保持 `lark_md`（note 只支持 lark_md）。

## #13 卡片 Markdown 渲染不稳定 —— ✅ 已修复（Card JSON 2.0）

- **根因**：Card JSON 1.0 的 markdown 组件不支持表格、标题、内联代码等完整语法
- **修复**（2025-08-25）：
  - 全面迁移到 **Card JSON 2.0**（`schema: '2.0'` + `body.elements`）
  - 表格、标题、内联代码（反引号）原生渲染，不再降级
  - `note` 标签（2.0 不支持）替换为 `markdown` + `text_size: 'notation'`
  - 删除 `needsPlainTextFallback()`、`logReplyDiagnostic()`、`buildFooterText()` 三个废弃函数
  - 回复流程简化：始终发卡片，不再有 markdown 消息降级路径

## #16 权限系统接入 —— ✅ 已实现（2026-08-30）

- **DSH 权限**：3 种 sandbox 模式（read-only / workspace-write / danger-full-access）+ permission presets
- **Session 事件**：`sandbox/mode`、`permission/preset`，持久化在 session log
- **飞书接入**：`/permission [模式]`（`feishu-permission.ts`）交互式选择卡 + 带参直接切换；`/sandbox` 保留为隐藏别名；命名/显示名对齐 WebUI `ui-permission-presets`（Read Only / Workspace Write / Full access）；`/status` 显示 Permission。复用 `ctx.get('sandboxPolicy')` 服务 + 会话日志 log-only `sandbox/mode` 事件

## #18 思考内容展示 —— ✅ 基本完成（仅 `collapsible` 未做 → O5）

- **已完成**：
  - `feishu-streaming.ts` 从 `assistant/chunk`（旧版）与 `assistant/message.stream`（0.1.3）两条路径累积 reasoning-delta
  - step 卡片里 reasoning 放在代码块中，按 **200 字预览** 展示（不展示完整思维链，见 `REASONING_CAP`）
  - reasoning 标题显示思考耗时与思考 token（`💬 **推理** · 4.3s · 1.2K tokens`）
- **待优化**：
  - reasoning 代码块可折叠（飞书 Card JSON 2.0 支持 `collapsible` 组件）—— **未实现**
  - reasoning 预览字数是否做成可配置 —— 待定

## #19 tool_call / tool_done 顺序问题 —— ✅ 已修复

- **现象**：有时飞书先收到 tool result（绿色/红色卡片），后收到 tool call（蓝色卡片），顺序反了
- **根因**：`tool/call` 和 `tool/result` 都走 `scheduleBatch`（200ms debounce），`tool/result` 到达时 `messageId` 可能还没保存（异步竞态）
- **修复**（2025-08-25）：
  - `tool/call` 卡片**直接发送**（不走批量队列），保存 `messageIdPromise`
  - `tool/result` 时 `await messageIdPromise` 确保拿到 `messageId` 后再 `updateCard`
  - 效果：一张卡片从蓝色（调用中）→ 绿色/红色（完成），不再出现两张卡片

## #9 流式输出技术方案

> 详见下方 [飞书流式输出技术方案](#飞书流式输出技术方案)。

- **现状**：每次发独立新卡片，5 QPS 限制
- **目标**：CardKit 流式更新（单卡持续更新，无 QPS 限制）
- **状态**：❌ **已取消（2026-09-02 用户决定，见「待实现」表 #9）**——下方方案仅作技术留档

---

## 飞书流式输出技术方案

### 现状：普通卡片发送（5 QPS 限制）

```
POST /im/v1/messages → 每张独立消息，5 QPS
```

### 目标：CardKit 流式更新（无 QPS 限制）

```
POST /cardkit/v1/card {streaming_mode: true} → 创建流式卡片，拿到 card_id
POST /cardkit/v1/card/:card_id/contents      → 持续更新，无 QPS 限制
```

| 限制项 | 值 |
|---|---|
| 流式更新 QPS | **无限制** |
| 卡片大小 | 30KB |
| 组件数量 | 200 个 |
| 自动关闭 | 10 分钟 |
| 文本流式频率 | 70ms/次（可配） |

### 参考

- [流式更新卡片概述](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview.md)
- [飞书AI机器人流式输出实践](https://juejin.cn/post/7600990891206819867)
- [CardKit 流式更新 Python 示例](https://feishu.danling.org/streaming/cardkit/)

---

## Agent 消息队列调研记录

- **两层队列**：Lark SDK `chatQueue`（per-chat 串行）+ DSH Agent `Inbox`（per-agent 应用层）
- **`followup()`**：消息进 `next-turn` 队列，`wakeRequested` latch，当前 turn 完成后自动处理
- **`whenIdle()`**：spin-until-stable，等所有排队 turn 完成才返回
- **关键结论**：消息不会丢失，但飞书侧需等当前 turn 完成才能响应

---

## 飞书消息长度限制调研记录（2026-09-08）

> 出处：飞书/Lark 开放平台文档与实测参考。**查文档小技巧**：官方域名在本机解析到非公网 IP，`web_fetch` 会被拦，但用 `curl` 直连并在路径后加 `.md`（如 `https://open.feishu.cn/document/cardkit-v1/card/update.md`）可直接拿到纯 markdown 正文。

### 平台限制（请求体上限，非字符数）
- **text（文本）消息**：请求体最大 **150 KB**
- **interactive（卡片）/ 富文本消息**：请求体最大 **30 KB**
- 来源：[Tapdata Lark-IM 文档](https://github.com/tapdata/docs/blob/main/docs/prerequisites/saas-and-api/lark-im.md)（转引官方 `im/v1/message/create` 条款）。

### 卡片 markdown 元素的隐式内容上限
- 单个 `markdown` 元素的 `content` 有**隐式长度上限**（社区实测/报告约 **~10,000 字符/元素**）。**关键坑**：超限时 Feishu API 返回 **HTTP 200、无错误**，但**静默丢弃超出部分**——客户端无从感知，看到的回复就是被截断的。
- 来源：[openclaw/openclaw#88631](https://github.com/openclaw/openclaw/issues/88631)——流式卡片 text 累积超限即静默截断；[openclaw/openclaw#70651](https://github.com/openclaw/openclaw/pull/70651) 另记录了卡片**表格数量**超限错误码（`230099`/内层 `11310`，>3 个 markdown 表格）。

### 本插件现状（截断点，均需改成分段）
| 位置 | 现在 | 问题 |
|---|---|---|
| `feishu-streaming.ts` `renderStepCard` | text 前 3000 字上屏、溢出用 `chunkText` 拆 `Reply (continued N/M)` 卡（**已分段**）；reasoning 只保留 200 字预览（设计如此） | 已无硬截断；reasoning 仍是预览（不展示完整思维链） |
| `channel.ts` `renderReasoningForReply` | reasoning 超过 `REASONING_CAP = 200` 时截断加 `…(truncated)`（2026-09-10 核实：此处早已统一到和步骤卡同一个 200 字常量，不再是最初的 5000） | 两阶段 reply 的 thinking 卡按设计只做预览 |
| `channel.ts` `renderReplyCards`（546） | `chunkText(displayText, CARD_TEXT_MAX=4000)` 已分卡（≤30 张） | **已分段**，基本安全 |
| `text-chunk.ts` | `chunkText` 按段落装箱 + `capChunks` | 已具备分段工具，可复用 |

### 结论 / 改动方向
1. **step 卡 text**：✅ 已完成（2026-09-08）——超 3000 字改为拆溢出续卡，不再 `…(truncated)`；reasoning 按设计收紧为 200 字预览。
2. **阈值选择**：卡片 30KB 请求体（非字符数，中文按 UTF-8 ~3B/字）换算 ≈ **中文约 1 万字**、英文约 3 万字符；单 markdown 元素另有 ~10k 字符隐式上限。`CARD_TEXT_MAX=4000` 是保守安全值，**拆卡阈值宜取 ~6k–8k 字符**，留足 markdown 开销与表头/footer 余量。
3. **text 消息回退**：超长纯文本可改发 `text` 消息（150KB，上限远高于卡片），或卡片 + 文本混合。
4. **静默截断防护**：发送前按已知上限（30KB 请求体 / ~10k 元素）本地校验并主动分段，**不要依赖飞书静默截断**。

### 待定
- 是否需要 `renderMode: auto|card|text` 配置（对齐 openclaw 建议，让超长回复回退纯文本）。**仍未做**（**2026-09-23 复核**：`src/` 内无 `renderMode` → O7）。
- 分段后是否在每卡加 `Part i/N` 标注：**reply 卡已有**（`channel.ts` `Part ${i}/${total}`），**step 溢出续卡也已有**（`feishu-streaming.ts` `Reply (continued ${part}/${total})`）——2026-09-11 核实，此项实际已完成。
