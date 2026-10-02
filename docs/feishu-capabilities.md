# 飞书能力调研

> 本文件记录飞书开放平台支持的消息类型、卡片组件、权限、事件订阅等能力，
> 供 dsh-feishu 功能规划参考。
>
> 更新时间：2026-09-08

---

## 一、消息类型

飞书 `im.v1.message.create` 支持的 `msg_type`：

| 类型 | msg_type | 说明 | dsh-feishu 现状 | 潜在场景 |
|---|---|---|---|---|
| 纯文本 | `text` | 无格式文本 | ✅ 斜杠命令回复、busy 提示 | — |
| 富文本 | `post` | 加粗/链接/@/图片混排 | SDK 支持，未使用 | 格式化回复（替代纯 markdown） |
| 图片 | `image` | 上传图片消息 | ✅ 接收用户图片（按字节判型）+ `feishu_send_file` 主动发图（≤10MB 内联预览） | 输出图片/截图/图表 |
| 文件 | `file` | 文件附件 | ✅ 接收用户文件 + `feishu_send_file` 主动发（≤30MB） | 导出代码/文档/PDF |
| 音频 | `audio` | 语音消息 | ✅ `feishu_send_file` 把 Ogg/Opus 发成语音气泡（≤30MB） | — |
| 视频 | `video`（`msg_type: 'media'`） | 视频消息（可播放气泡） | ✅ `feishu_send_file` 把 MP4/MOV（可播 codec）发成视频气泡 + ffmpeg 抽帧封面 | — |
| 表情贴纸 | `sticker` | 贴纸表情 | 未使用 | 趣味回复 |
| **卡片** | `interactive` | 交互式卡片（按钮/选择器/表单） | ✅ 主要使用 | 核心 UI |
| 分享群聊 | `share_chat` | 分享群聊卡片 | 未使用 | 快速分享群给用户 |
| 分享用户 | `share_user` | 分享联系人卡片 | 未使用 | — |

**SDK 调用方式**（`channel.send`）：

```js
channel.send(chatId, { text: 'hello' })           // 纯文本
channel.send(chatId, { card: { schema: '2.0', ... } }) // 卡片
channel.send(chatId, { markdown: '**bold**' })     // 富文本（SDK 自动转 post）
channel.send(chatId, { image: { key: 'xxx' } })    // 图片
channel.send(chatId, { file: { key: 'xxx' } })     // 文件
channel.send(chatId, { shareChat: { chatId } })    // 分享群聊
```

---

## 二、Card JSON 2.0 组件

飞书卡片 JSON 2.0（`schema: '2.0'`）支持的组件分为三类：

> **一张卡的容量**（2026-09-24 真机实测，`cardkit.v1.card.create` + 负对照）：**200 个元素或组件**，且`video` 元素带的 `cover`、`fallback` **各占一个名额** —— 带封面的视频 66 个接受、67 个被 `300305 element exceeds the limit` 拒绝；不带封面的视频 198 个、内联 `<audio>` 199 个、纯文本元素 200 个都可接受。另一条边界是**卡片 JSON ~30KB**（`200860`）。所以"单卡内联几个"从来不是飞书的限制，插件现在按设置项 `cardMediaLimit`（1–30，默认 12；图片一处、音视频一处，各按这个数）渲染。
>
> **上传接口的大小 / 分辨率上限**（`im.v1.file.create` / `im.v1.image.create`，2026-09-24 逐条复核官方页面）——**文件 ≤ 30 MB**（视频 / 音频 / PDF / Office / 压缩包都走它，不能 0 字节；`234006` 超限、`234010` 空文件）；**图片 ≤ 10 MB**，且**分辨率**：GIF ≤ 2000×2000、其他 ≤ 12000×12000（`234039`），官方对超分辨率大图的口径是「改用上传文件接口以文件形式发送」。**发送消息只是引用上传得到的 key，不再按文件大小卡**；另一类容易混淆的 "30KB" 是**消息体**限制（文本 ≤ 150 KB、卡片/富文本 ≤ 30 KB，`230025`），与文件大小无关。两个上传接口频控均为 **1000 次/分钟、50 次/秒**。插件侧：`feishu_send_file` 与收文件用 30 MB / 10 MB 常量，**卡片内联则把这三个数字做成设置项**（`cardImageMaxMb` 1–10 默认 10、`cardVideoMaxMb` / `cardAudioMaxMb` 1–30 默认 15）——上限就是上面这两个硬边界，所以设置里的范围不会再往大放。
>
> **媒体类只有三种：图片 / 视频 / 音频**。**没有任何"文件/附件"组件**（`file` / `attachment` / `media` / `cloud-doc` / `file-preview` 文档路径全 404；富文本的 HTML 白名单里也没有 `<file>`，且 `<video>` 只能作独立元素、写不进富文本）——PDF / Office / 压缩包等只能走原生文件消息。详情与实测见 CHANGELOG「卡片内联媒体」。

### 2.1 内容组件（Content）

| 组件 | tag | 说明 | dsh-feishu 现状 |
|---|---|---|---|
| 普通文本 | `plain_text` | 无格式文本 | ✅ 卡片 header |
| Markdown | `markdown` | 表格/标题/内联代码/链接/粗体/斜体 | ✅ 主要使用 |
| Lark Markdown | `lark_md` | 旧版 markdown（仅粗体/斜体/链接） | ⚠️ note 区域使用 |
| 图片 | `img` | 图片组件（`img_key` 必须是上传得到的 `img_v3_…`） | ✅ 正文图片内联（`src/card-images.ts`）+ 面板卡 |
| **视频** | `video` | 内嵌 MP4 播放（**仅 MP4**、≤30MB、客户端 ≥V7.56；含视频的卡片**必须** `config.enable_forward: false`，否则发送失败） | ✅ 2026-09-24 起：正文里 `[片段](runs/a.mp4)` 自动内联（QuickTime 先转封装、ffmpeg 抽封面） |
| **音频** | `audio`（或富文本里 `<audio file_key='…'>`） | 内嵌音频播放（**仅 Opus**、≥V7.49；同样要求 `enable_forward: false`，且不能配合"仅特定人可见"发送） | ✅ 2026-09-24 起：正文里 `[语音](runs/a.opus)` 自动内联（其他音频格式有 ffmpeg 时转 Opus） |
| 表格 | `table` | 结构化表格 | ✅ 后台任务 / 子代理面板卡 |
| 图表 | `chart` | 柱状图/折线图/饼图等 | 未使用 |
| 多列布局 | `column_set` + `column` | 多列并排 | ✅ 按钮行 / 目录浏览器布局（`flex_mode: 'stretch'`） |

### 2.2 交互组件（Interactive）

| 组件 | tag | 说明 | dsh-feishu 现状 | 潜在场景 |
|---|---|---|---|---|
| **按钮** | `button` | 点击按钮，触发 `cardAction` | ✅ 审批卡片 | 通用操作 |
| **单选下拉** | `select_static` | 下拉单选，选项列表 | ✅ `/session` 会话选择 | `/model` 选模型、选 workspace、选 preset |
| **多选下拉** | `multi_select_static` | 下拉多选 | ❌ 未使用 | 批量操作选项 |
| **复选组** | `checker` | 勾选组（Card JSON 2.0 有官方文档，本插件未用过） | ❌ 未使用 | `/display` 交互卡片的一次性多开关提交（见 [`display-card-design.md`](./display-card-design.md)） |
| **日期选择** | `date_picker` | 日期选择器 | ❌ 未使用 | — |
| **时间选择** | `time_picker` | 时间选择器 | ❌ 未使用 | — |
| **人员选择** | `select_person` | 选择人员 | ❌ 未使用 | 多人协作 |
| **文本输入** | `input` | 文本输入框 | ✅ 问题卡片自定义回答、会话改名卡、新建工作区 | 带占位符的输入（替代部分斜杠命令） |
| **溢出菜单** | `overflow` | 更多操作菜单 | ❌ 未使用 | 查看上下文/清空/导出 |

### 2.3 容器/布局组件（Container）

| 组件 | tag | 说明 | dsh-feishu 现状 | 潜在场景 |
|---|---|---|---|---|
| **可折叠面板** | `collapsible_panel` | 折叠/展开内容块 | ✅ **已用于真机**（2026-09-29：推理段与压缩摘要；2026-09-29：加边框+底色+「已折叠 · 点击展开」文案，收起态才看得出来；探针见下） | 🔥 压缩摘要、长 reasoning、长工具输出 |
| **标签页** | `tab` + `tab_content` | 多标签页切换 | ❌ 未使用 | 多 step 结果分页查看 |
| 分割线 | `hr` | 水平分割线 | ✅ 已使用 | — |
| 注释 | `note` | 底部注释（Card JSON 1.0） | ⚠️ 2.0 不支持 | 用 `markdown` + `text_size: 'notation'` 替代 |

#### 2.3.1 折叠组件探针实测（2026-09-29）

折叠组件本插件从未用过，且本机**读不到飞书官方文档**（`open.feishu.cn` 经 fake-ip 解析成非公网地址，抓取工具直接拒），所以 tag 与字段名只能实测。做法是**只建卡片实体、不发送**的 `cardkit.card.create` 探针（脚本 `~/.dsh/probe-collapsible-card.py`），并带一个**伪造 tag 的对照**来证明判据有区分力：

| 用例 | 结果 |
|---|---|
| `collapsible_panel` + `expanded: false` + `header.title` + `elements` | `code=0`，拿到 `card_id` ✅ |
| `collapsible_panel` + `default_expanded` | `code=0`（未知字段被容忍，据此判不出正确字段名） |
| `collapsible`（1.0 名字） | `code=10002 ErrMsg: not support tag` ❌ |
| 对照：伪造 tag `collapsible_bogus` | `code=10002 not support tag` ❌（对照有效 ⇒ 上面的成功有意义） |

结论：**tag 必须写 `collapsible_panel`**；初始展开态的字段名（`expanded` vs `default_expanded`）用 create 分不出来，按 `expanded` 实现、真机再校（纯外观，不影响结构，也不会让卡片发不出去）。

**2026-09-29 起已在产品里使用**：步骤卡的推理段（`src/feishu-streaming.ts` 的 `renderStepCard`）与压缩卡的摘要（`src/feishu-compaction.ts`）都用 `collapsible_panel` + `expanded:false` + `header.title` + `elements`，是把上面这份探针 JSON 原样搬进渲染器的。

**同日的第二个探针（`~/.dsh/probe-step-card-panel.py`）**：上面验的是面板**自己**，这里再验**整张卡**——因为真实卡片是 markdown + `hr` + `text_size: notation` + 面板混排，而 `cardkit.card.create` 会对整份 JSON 做服务端校验。三个用例（只建实体、不发送）：

| 用例 | 结果 |
|---|---|
| A 步骤卡（注入提示行 + 折叠推理面板 + 正文 + 工具参数/结果 + 页脚两行） | `code=0`，拿到 `card_id`（1457 字节）✅ |
| B 压缩卡（详情行 + 折叠摘要） | `code=0`，拿到 `card_id`（583 字节）✅ |
| C 对照：A 的卡片把面板换回 1.0 的 `collapsible` | `code=10002 not support tag` ❌ |

⇒ 本批产出的两种卡**服务端可创建**；`expanded:false` 的真实渲染态另用**读回线上卡片**确认（见下一条）。

**2026-09-29 01:55 真机读回（唯一能看见「渲染成什么样」的服务端手段）**：`GET /im/v1/messages/<message_id>` 默认只回**降级**内容（CardKit 2.0 卡被折成一句「请升级至最新版本客户端」，**只有 title 是新的**）；加 **`?card_msg_content_type=user_card_content`** 才拿到**当前渲染态**的完整卡片 JSON。本批上线后的第一张真实步骤卡读回结果：

```
0  markdown           📥 注入上下文 · AGENTS.md（已更新）
1  collapsible_panel  expanded=false  title=💬 **推理** · 1.9s
2  hr → 📝 **消息** → 🔧 **工具调用** + 参数 + 结果 → 页脚
```

⇒ **推理折叠默认收起**（`expanded:false`）、**注入提示行在正文最前面且卡内没有注入正文**、档位是默认「详细」——三项一次读完。**仍未验证的一点**：真机上「初始到底是不是收起」——`expanded` 若被忽略就会默认展开；若真机看到的是展开，只改一个字段名（`default_expanded`）即可，不影响结构、也不会让卡片发不出去。

#### 2.3.2 「折叠要看得出来」实测（2026-09-29）

使用者反馈：**收起态的面板看不出来是折叠的**（"不了解的人不知道这个东西已经折叠了"）。原因是结构性的事实——收起时面板只渲染 `header`，而光秃秃的 header 长得就像一个小标题，飞书客户端不一定会画（或画得很淡）任何 chevron。WebUI 的同类行有 chevron，飞书这张卡必须自己想办法。

修法是两条一起上：**文案**（`cardFoldTitle`，任何客户端都丢不掉）+ **外观**（`border` 与 `header.background_color`，让 header 像一块可点的东西）。外观字段能不能用，只能靠服务端校验来判定，而这里有一个**必须写下来的取证口径**：

> `cardkit.card.create` **静默容忍未知字段**——在 `collapsible_panel` 的 `header` 里塞一个 `bogus_xyz` 照样 `code=0`。所以「建卡成功」**不能**证明字段存在；只有「某个**值**被拒」才是证据。

`~/.dsh/probe-panel-affordance.py` 的逐个字段实测（手写卡片；对照组是「合法值 vs 明显非法的值」）：

| 字段 | 通过 | 被拒（⇒ 字段确实存在且被校验） |
|---|---|---|
| `border.color` | 命名色 token：`grey` / `grey-100` / `grey-300` / `grey-500` / `blue` / `blue-300` / `neutral` | `#DEE0E3`、`rgba(0,0,0,0.05)` → `11310 collapsible panel border color is invalid` |
| `header.background_color` | 同一套命名色 token（`grey-50`…`grey-300`、`blue`、`wathet`、`yellow`、`orange`、`red`、`carmine`、`violet`、`indigo`、`green`、`lime`、`neutral` 全部通过） | hex / `rgba` → `11310 … header background color is invalid`；**对象** `{light,dark}` → `10002 expected string for background_color` |
| `border.corner_radius` | `4px` / `8px` / `0px` | `4`、`50%`、`4pt` → `10002 invalid corner radius` |
| `header.padding` | `4px`，或四个值 `4px 8px 4px 8px` | `4px 8px`、`4`、`{top,…}` 对象 → `10002 invalid panel header padding` |
| `padding`（面板级） | `4px`、`4px 8px`、`4px 8px 4px 8px` | `bogus` → `11310 padding invalid` |
| `expanded` | `true` / `false` | 字符串 `"yes"` → `10002 bad variable formmat: yes` |
| `header.icon` | `{tag:'standard_icon', token:…}`（**token 不校验**，乱写也过） | `{tag:'custom_icon', img_key:'img_v3_bogus'}` → `200570 card contains invalid image keys` |
| `text_color` / `icon_position` / `vertical_align` | 乱值也过 ⇒ **判不出真伪，故不用** | — |

⇒ 采用 `border: {color:'grey-300', corner_radius:'4px'}` + `header.background_color:'grey-100'`；`custom_icon` 需要真上传的 `img_key`（不能用标准图标冒充），标准图标 token 无从校验，**都不用**。

**同日第三个探针（`~/.dsh/probe-real-fold-cards.py` + `.ts`，端到端）**：手写探针能过不代表**产物**能过，所以把 `renderStepCard` / `renderCompactionCard` 的**真实输出**（zh/en 各一张步骤卡、压缩卡的 summary 与 done 两态）直接打给 `cardkit.card.create`：

| 用例 | 结果 |
|---|---|
| 步骤卡（zh，detailed，折叠推理面板 + 工具参数/结果 + 页脚） | `code=0` ✅ |
| 步骤卡（en） | `code=0` ✅ |
| 压缩卡（summary 态，详情行 + 折叠摘要） | `code=0` ✅ |
| 压缩卡（done 态、无摘要） | `code=0` ✅ |

四张卡的折叠元素都带上 `border={grey-300,4px}`、`header.background_color=grey-100`、标题结尾的 `（▸ 已折叠 · 点击展开）`——即**服务端接受的就是线上真正会发的那份 JSON**。

### 2.4 交互回调

所有交互组件的用户操作通过 `card.action.trigger` 事件回调：

- **WebSocket 长连接模式**：自动推送，**不需要额外事件订阅或权限**
- **回调数据**：`evt.action.value`（JSON 字符串）、`evt.action.tag`（组件类型）、`evt.chatId`、`evt.messageId`
- **SDK 处理**：`LarkChannel.on('cardAction', handler)` 监听

```js
// 按钮点击回调
channel.on('cardAction', (evt) => {
  const value = JSON.parse(evt.action.value) // { rpcId: '...', outcome: '...' }
  // 处理逻辑...
})

// 选择器回调
channel.on('cardAction', (evt) => {
  if (evt.action.tag === 'select_static') {
    const selected = evt.action.option // 选中的 value
  }
})
```

---

## 三、权限（Scopes）

### 3.1 当前已配置

| 权限 | 说明 | 用途 |
|---|---|---|
| `im:message.p2p_msg:readonly` | 读取私聊消息 | 接收用户消息 |
| `im:message.group_at_msg:readonly` | 读取群聊 @消息 | 接收群内 @机器人 |
| `im:message:send_as_bot` | 以机器人身份发消息 | 回复消息/发卡片 |
| `im:message.reaction` | 添加/删除表情回复 | 👍 消息表情反应 |
| `application:application:patch` | 更新应用配置 | 扫码流程专用（强制 WebSocket） |

### 3.2 可能需要的额外权限

| 权限 | 说明 | 触发场景 |
|---|---|---|
| `im:message` | 消息读写全量权限 | 替代上面三个细粒度权限（更简单） |
| `im:chat:readonly` | 读取群聊信息 | 获取群名称/成员数等 |
| `im:resource` | 下载消息中的资源 | 下载用户发送的图片/文件 |
| `contact:user.base:readonly` | 读取用户基本信息 | 显示用户名称 |

### 3.3 权限申请方式

- **扫码流程**：`provision.ts` 的 `FEISHU_PROVISION_SCOPES` 数组自动申请
- **手动配置**：飞书开发者后台 → 应用 → 权限管理 → 开通权限

---

## 四、事件订阅

### 4.1 当前已订阅

| 事件 | 说明 | 订阅方式 |
|---|---|---|
| `im.message.receive_v1` | 接收消息 | `add_events` 参数 |

### 4.2 SDK 自动处理（无需显式订阅）

| 事件 | 说明 | 备注 |
|---|---|---|
| `card.action.trigger` | 卡片按钮/选择器点击 | WebSocket 模式下自动推送 |
| `im.message.reaction.created_v1` | 表情回复添加 | SDK 有 handler，未使用 |
| `im.message.reaction.deleted_v1` | 表情回复删除 | SDK 有 handler，未使用 |
| `im.chat.member.bot.added_v1` | 机器人被添加到群 | SDK 有 handler，未使用 |

### 4.3 事件订阅注意事项

- `add_events` 参数（`applicationConfig.patch` API）**只接受 IM 事件类型**
- `card.action.trigger` 是卡片回调事件，**不是 IM 事件**，不能放在 `add_events` 里（会 400 报错）
- 卡片回调在 WebSocket 长连接模式下自动推送，无需额外配置
- 新建应用（扫码流程）自动订阅 `im.message.receive_v1`
- 已有应用需要在开发者后台手动添加事件订阅

---

## 五、卡片回调安全机制

SDK 的 `SafetyPipeline` 对卡片回调有完整的安全处理：

| 机制 | 说明 |
|---|---|
| **去重** | `card:${messageId}:${openId}:${actionId}` 键去重，防止同一按钮被重复处理 |
| **锁** | per-chat 锁，防止同一聊天的并发回调冲突 |
| **队列** | per-chat 队列，保证同一聊天的回调按序处理 |

---

## 六、功能规划建议

按投入产出比排序（状态更新于 2026-09-08）：

> **2026-09-23 复核**：P6 批次（插件详情页的连接/扫码三分贡献、后台任务卡、会话置顶、模型目录、清单本地化名与图标）**没有新增或移除任何飞书组件用法**——新增的卡仍然只用 `header` + `markdown`，详情页用的是 `button`（本节 P2 已标 ✅）。所以下表状态**未变**；唯一仍开着的组件类缺口是折叠组件（reasoning 与长工具输出折叠）。**2026-09-29 更正**：该组件的 tag 不是 `collapsible`（那是 1.0 时代的名字，`cardkit.card.create` 直接回 `10002 not support tag`），而是 **`collapsible_panel`**——已用探针实测，详见 2.3 节的新增说明。

### P0 — 优先实现

| 功能 | 组件 | 状态 | 说明 |
|---|---|---|---|
| `/model` 下拉选择 | `select_static` | ✅ 已实现 | `feishu-model-select.ts`：provider → model → reasoning 三步卡片 |
| Reasoning 可折叠 | `collapsible_panel` | ✅ **已实现**（2026-09-29，O5；2026-09-29 补「看得见」的外观） | 默认收起，头部带推理时长与思考 token 数；`detailed` 档正文 200 字、`verbose` 档给全文——折叠之后「只给开头」这条信息损失不再必要。收起态统一带 `border` + header 底色 + `（▸ 已折叠 · 点击展开）` 文案（`src/card-fold.ts`）：光秃秃的 header 没人看得出里面还有东西 |
| 长工具输出可折叠 | `collapsible_panel` | 🔲 未实现（组件已可用于此处） | bash/read 等工具的长输出仍走**截断预览**（`detailed` 1500 字符 / `verbose` 6000 字符）；折叠它需要一个能记住展开状态的写入策略，单独一批做 |

### P1 — 后续实现

| 功能 | 组件 | 状态 | 说明 |
|---|---|---|---|
| `/new` 工作区选择 | `interactive_container` | ✅ 已实现 | 最终用可点击整行（非 `select_static`），另含目录浏览器 |
| Step 卡片多列布局 | `column_set` | ⚠️ 部分 | `column_set` 已用于按钮行 / 目录浏览器布局；step 卡本身仍单列 |
| 溢出菜单 | `overflow` | 🔲 未实现 | 卡片右上角「更多操作」：查看 status/清空上下文/导出 |
| `/status` 卡片增强 | `table` | 🔲 未实现 | 目前用 markdown 表格，未用 `table` 组件 |

### P2 — 探索性

| 功能 | 组件 | 状态 | 说明 |
|---|---|---|---|
| 标签页多 step | `tab` | 🔲 未实现 | 多 step 结果分页查看 |
| 图表输出 | `chart` | 🔲 未实现 | 数据可视化（如果 agent 输出结构化数据） |
| 文本输入 | `input` | ✅ 已实现 | 问题卡片自定义回答、会话改名卡、新建工作区 |
| 文件导出 | `file` | ✅ 已实现 | `feishu_send_file` 模型工具（≤30MB） |

---

## 七、已知限制

| 限制 | 值 | 说明 |
|---|---|---|
| 消息发送频率 | 1000 次/分钟、50 次/秒 | 官方接口频率限制（应用维度）；早期文档里的「5 QPS」是社区经验值 |
| 卡片大小 | 30KB | 单张卡片 JSON 不超过 30KB |
| 组件数量 | 200 | 单张卡片最多 200 个组件 |
| 卡片实体有效期 | 14 天 | `cardkit.v1.card.*` 只能操作 14 天内创建的卡片实体 |
| 卡片实体只能发送一次 | — | 一个 `cardkit.card.create` 出来的实体只能被发出一次；要再发必须新建实体（与坑 11 同族）。接口说明原文：一个卡片实体，仅支持发送一次 |
| Card JSON 2.0 客户端要求 | 飞书 ≥ 7.20 | 低版本客户端标题可正常显示，正文显示升级提示 |
| 单个 markdown 元素内容 | ~10k 字符（隐式） | 超限可能返回 200 但静默截断，发送前应主动分段 |
| 卡片标题色带重绘 | — | 部分客户端在卡片更新后不重绘 `header.template`（白底），属客户端渲染问题 |
| 流式卡片自动关闭 | 10 分钟 | 本插件**未启用** `streaming_mode` |
| 文本流式频率 | 70ms/次 | 本插件**未启用** |

---

## 八、相关文档

- [飞书卡片 JSON 2.0 结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure.md)
- [卡片组件概述](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/component-json-v2-overview)
- [配置卡片交互](https://open.feishu.cn/document/feishu-cards/configuring-card-interactions.md)
- [发送消息 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create)
- [流式更新卡片概述](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview.md)
- [卡片回传交互回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication.md)
- [添加消息表情回复 API](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)
