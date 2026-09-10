# `/display` 交互卡片设计（卡片内设置显示开关）

> 状态：**已实现（2026-09-10）**——按方案 A 落地，实现见 [`src/feishu-display.ts`](../src/feishu-display.ts)。本文保留调研与设计依据；实际实现与设计的差异见文末「实现记录」。
> 关联：[`src/commands.ts`](../src/commands.ts) 的 `/display` 命令、[`docs/feishu-capabilities.md`](./feishu-capabilities.md)、[`AGENTS.md`](../AGENTS.md) 关键坑 4 / 11 / 12。

## 一、目标

`/display` 目前只有文本路径（2026-09-09 已实现）：

- `/display` → 文本列出四个开关状态；
- `/display <key> on|off` → 文本确认。

目标：**无参 `/display` 发一张交互卡片**，用户直接在卡片上点选切换 `showReasoning` / `showToolCalls` / `showToolArgs` / `showToolResults`，不必记命令语法。写路径不变——仍是同一批配置字段（WebUI 面板、`/display` 命令、卡片三者同源）。

## 二、结论

**可行，且仓库里已有两套成熟范式可直接照搬。** 推荐方案 A（每次点击发新卡 + 旧卡改写为失效），不用就地更新。理由见第四节。

## 三、仓库内可参考的卡片实现

| 文件 | 交互形态 | 更新方式 | 可复用的点 |
|---|---|---|---|
| [`src/feishu-busy.ts`](../src/feishu-busy.ts) | 2 个按钮二选一（Enter 行为） | `channel.updateCard(messageId, …)` 就地更新 | `byCard: Map<messageId, ConversationMessage>` 记住话题坐标；`decodeCardValue` 解 value；`open(chat)` 发首卡 |
| [`src/feishu-permission.ts`](../src/feishu-permission.ts) | 3 个按钮选权限 | 就地更新 | 同上；按钮 `disabled` 标当前项；`value: JSON.stringify({ p, mode })` |
| [`src/feishu-onboarding.ts`](../src/feishu-onboarding.ts) `sendCard`（约 750–766 行） | 多步流程每步一张新卡 | **新卡 + `supersedePrevious`** | `createCardInstance` → `sendCardByReference` → `supersedePrevious(chatId)` → `note(chatId, {cardId, messageId})`；`topicOpts` / `chatTopic` / `recordTopic` 保证卡片落在原话题 |
| [`src/card-supersede.ts`](../src/card-supersede.ts) | — | 旧卡改写为灰色「已失效」提示 | `createCardSuperseder({channel, logger, getTranslations, sequenceByCard})`；优先 `updateCardInstance`，回退 `updateCard` |
| [`src/feishu-questions.ts`](../src/feishu-questions.ts) | form 容器 + `input` + 提交按钮 | — | form 提交读 `evt.raw.action.form_value`（约 150 行）；提交按钮用 `form_action_type: 'submit'` + `name` |
| [`src/card-action.ts`](../src/card-action.ts) | — | — | `action.value` 双重编码，必须 `decodeCardValue` 解开 |

`/display` 的卡片形态最接近 **busy/permission**（都是「一组开关，点一下改一个设置」），但点击次数更多（4 个开关），更新策略必须换。

## 四、关键约束（决定方案）

1. **交互卡片就地更新约 2–3 次后按钮回调失效**（AGENTS.md 关键坑 11，2026-09-08 实测）：`im.v1.message.patch` 与 `cardkit.v1.card.update` **都**受限。busy（2 选 1，点 1 次）和 permission（3 选 1，点 1 次）就地更新是安全的；**`/display` 有 4 个开关，用户可能连点 4 次 → 就地更新方案必然踩坑**。
2. **`cardAction` 事件不带话题信息**：事件只有 `messageId` / `chatId` / `operator` / `action`（见 [`src/index.ts`](../src/index.ts) 的 `CardActionEvent`）。要在原话题里发新卡，必须在 `open()` 时把 `ConversationMessage` 按 `messageId` 存下来（`feishu-busy.ts` 已经这么做）。
3. **form 按钮与普通按钮的 value 形态不同**：form 内按钮要 `form_action_type: 'submit'` + `name`，值走 `form_value`；普通按钮走 `behavior` + `value`（AGENTS.md 关键坑 4）。
4. **发卡顺序屏障**：`cardChannel.send` 会先 `await` streaming 的 pending-card-flush（AGENTS.md「卡片顺序」）。`/display` 卡片走同一通道即可，无需额外处理。

## 五、方案对比

### 方案 A（推荐）：每个开关一个按钮，点击即发新卡 + 旧卡失效

- 卡片：标题「📇 卡片显示」+ 一行说明 + 4 个按钮；按钮文案直接带状态，如 `✅ 工具调用：开` / `⬜ 参数：关`，点击取反（`value` 带**目标值**而非「切换」标记，重复点击幂等）。
- 点击：`display.set(key, value)` → 用 CardKit 发**新卡**（`createCardInstance` → `sendCardByReference`）→ `superseder.supersedePrevious(chatId)` 把上一张改写成灰色失效提示 → `note` 新卡。
- 优点：完全绕开就地更新上限；与 onboarding 现有范式一致；旧卡不留「看起来能点」的按钮。
- 缺点：每点一次聊天里多一张卡（旧卡变灰）。4 个开关全调一遍会有 4 张灰卡 + 1 张活卡。

### 方案 B：form + `checker` 多选 + 一次提交

- 卡片：form 容器里一个 `checker`（多选项：思考过程 / 工具调用 / 参数 / 结果），勾选=开、取消=关，底部「保存」提交按钮；提交读 `form_value` 得到选中集合，映射成 4 个布尔。
- 优点：**改 4 个也只发一次卡**，聊天干净；一次写全。
- 缺点 / 待验证：
  - `checker` 在 Card JSON 2.0 有文档（[v2 checker 文档](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/checker.md?lang=zh-CN)），但**本插件从未用过**，需先在真实聊天里验证渲染与 `form_value` 形状；
  - 交互语义从「点开关」变成「勾选 + 保存」，多一步；
  - 本机无法直接抓取飞书文档（`open.feishu.cn` 解析到非公网地址），`checker` 的字段名（`checked` / `options` / `initial_selected`？）**尚未逐字段核实**，实现前要用一张试验卡确认。

### 方案 C：就地更新（busy / permission 风格）

- 代码最少，但见约束 1：4 个开关连点会失效。**不推荐**，除非接受「按钮死了就重新 `/display`」。

### 关于「开关」组件

飞书有设计规范里的「开关」控件（[开关 - 设计规范](https://open.feishu.cn/document/design-specification/component---data-entry/switch?lang=zh-CN)），但**未找到它作为 Card JSON 2.0 交互组件 `tag` 的官方文档**；搜索结果里指向「开关」的都是设计规范 / 低代码平台，不是卡片组件。因此**不假设存在 `tag: 'switch'`**。若要用，先按方案 B 的 `checker` 或方案 A 的按钮实现。

## 六、方案 A 详细设计（已实现）

### 新增 `src/feishu-display.ts`

```ts
export const DISPLAY_KEYS: readonly DisplayToggleKey[] = ['reasoning', 'tools', 'args', 'results']

export function renderDisplayCard(state: Record<DisplayToggleKey, boolean>, t: Translations): object
// header: 📇 卡片显示 / turquoise
// body: 说明行 + 4 个 button，value = JSON.stringify({ p: 'display', key, value: <目标布尔> })

export interface FeishuDisplayHandle {
  open(chat: ConversationMessage): Promise<string | undefined>
  stop(): void
}
export function startFeishuDisplay(deps: {
  channel: DisplayCardChannel          // send / createCardInstance / sendCardByReference / updateCardInstance / updateCard / onCardAction
  display: DisplayControl              // 复用 src/commands.ts 的读写接口
  logger: { warn(m: string): unknown; error(m: string): unknown }
  getTranslations: () => Translations
}): FeishuDisplayHandle
```

要点：

- `byCard: Map<messageId, ConversationMessage>`：点击时取出话题坐标，新卡仍落在原话题。
- `sequenceByCard: Map<cardId, number>` + `createCardSuperseder`：与 onboarding 同一套失效改写。
- 动作校验：`decodeCardValue` → `p === 'display'` → `key ∈ DISPLAY_KEYS` → `typeof value === 'boolean'`；不合法直接忽略。
- 点击后先 `display.set(...)`，再用 `display.get()` 重新渲染（读的是真实持久化值，不是点击载荷）。
- 发送失败只 `logger.warn`，不能让一次点击把整条链路打挂。

### `src/index.ts` 接线

- `let displayHandle: FeishuDisplayHandle | undefined`，在 `permissionHandle` / `busyHandle` 之后 `startFeishuDisplay({...})`，dispose 时 `displayHandle?.stop()`。
- `executeSlashCommand` 增加 `displayCard?: FeishuDisplayHandle` 参数（与 `busyCard` / `permissionCard` 同列）。
- `/display` 分支：`rawInput === ''` 且有 `displayCard` → `await displayCard.open(chatMessage)` → `return { kind: 'consumed' }`；失败回退现有文本（照抄 `/busy` 的错误处理）。带参仍走 `handleDisplayCommand` 文本路径。

### i18n（`src/i18n.ts`，卡片层，与 `commands-i18n.ts` 分开）

新增 `displayCardTitle` / `displayCardHint` / `displayCardLabel(key)` / `displayCardOn` / `displayCardOff` / `displayCardValue(label, state)`，zh / en 各一份。按钮文案 = `${on ? '✅' : '⬜'} ${displayCardValue(label, on ? on : off)}`。

### 测试（`tests/feishu-display.spec.ts`）

1. `renderDisplayCard` 四个按钮，开=primary/✅、关=default/⬜；
2. `open` 发卡并记录 messageId→chat；
3. 点击合法 value → `display.set` 被调用 + 发**新卡** + 旧卡被 supersede；
4. 非法 value / 未知 messageId → 不写设置、不发卡；
5. `stop()` 后不再响应点击。

## 七、实施前必须先在真实聊天验证的点

1. 方案 B 的 `checker`：字段名、渲染、`form_value` 形状（用一张一次性试验卡）。
2. 方案 A 的按钮文案长度：飞书按钮单行不换行，中文标签 + 状态要够短（`✅ 工具调用：开` 约 9 字，应无问题）。
3. 旧卡失效改写在 **非 CardKit 兜底路径**（通道没有 `createCardInstance`）下无法执行——此时只能保持就地更新或让旧按钮失效；实现时按 `card-supersede.ts` 的现有降级处理即可。

## 八、实施清单

- [x] `src/feishu-display.ts`（渲染 + 动作处理 + 发新卡 + supersede）
- [x] `src/i18n.ts` 五个键（zh / en）：`displayCardTitle` / `displayCardHint` / `displayCardLabel` / `displayCardButton` / `displayCardNote`
- [x] `src/index.ts` 接线（start / stop / `executeSlashCommand` 参数 / `/display` 无参分支）
- [x] `tests/feishu-display.spec.ts`（9 例）
- [x] `CHANGELOG.md` / `TODO.md` / `AGENTS.md` 对齐表同步
- [x] `npm run typecheck` / `test` / `build` 全绿（298 passed）

## 九、实现记录（2026-09-10）

按方案 A 落地，与第六节设计的差异：

1. **i18n 键收敛为 5 个**（原设计 6 个）：`displayCardValue` 并入 `displayCardButton(label, enabled)`，一次产出 `✅ 工具调用：开` 这整段文案。
2. **没有为 `args`/`results` 做「总开关关闭时置灰」的处理**——WebUI 面板会置灰，但卡片与既有的 `/display args on` 文本命令保持一致：四个开关互相独立，都可直接切换。理由是卡片上总开关的状态就在同一张卡里可见，不需要额外的禁用态解释成本。
3. **失败处理**：点击回调里所有异常只 `logger.warn`（设置已写入，失败的只是卡片刷新）；`/display` 发卡失败则**回退到文本列表**而不是报错，保证命令永远有回应。
4. **仍不需要真机验证 `checker`**——方案 B 未采用。
5. AGENTS.md 关键坑 4 的「按钮 `value` 双编码」由既有的 `decodeCardValue` 处理，未新增解码逻辑。

### 真机踩到的两个坑（已在实现中修正）

设计与单测都没覆盖到，**上线后点击无反应**，真机排查后修掉：

1. **实例卡片的按钮必须用 `behaviors`，顶层 `value` 被静默丢弃**。本文第四节「约束 3 / 4」只写了 form 与普通按钮的区别，漏了这条更关键的区别：`feishu-busy.ts` / `feishu-permission.ts` 用顶层 `value` 是因为它们走**内嵌卡片**（`channel.send(..., { card })`），而本卡片走 **CardKit 实例**（`createCardInstance` + `sendCardByReference`）——实例卡片不认顶层 `value`。已改为 `behaviors: [{ type: 'callback', value: { p: 'display', key, value: !enabled } }]`，并加了一例测试断言「每个按钮都没有顶层 `value`、且 `behaviors[0].value.p === 'display'`」。
   → 教训：**新写交互卡片前，先确认它走哪条发送路径**；`behaviors` 对两条路径都成立，应当作为默认写法。
2. **`settings.mutate()` 必须先 `await` 再重读**（第六节「点击后先 `display.set(...)`，再用 `display.get()` 重新渲染」这条设计本身有 bug）。`dsh-settings` 的写是排队的异步操作，`settingsScope.get()` 只在 `settings.mutate` 的 promise resolve 之后才反映新值，所以「写完立刻重读」拿到的是旧值。`DisplayControl.set` 的签名因此从 `=> void` 放宽为 `=> void | Promise<void>`，`index.ts` 返回 mutate 的 promise，卡片路径 `await` 后再 `post()`；忽略返回值的 `/display` 文本路径挂一个 detached `.catch` 防 unhandled rejection。测试里用「`set` 返回未决 promise，期间不得发卡」锁定这个顺序。
3. 补了诊断日志（`[display] action for unknown card …` / `[display] ignored malformed action …`）：这次排查没有任何日志可依，只能靠读代码、对比同仓库其它卡片的写法，绕了一圈才定位。**新增交互卡片时一并加一行「收到点击」的日志**，成本极低、收益很高。
