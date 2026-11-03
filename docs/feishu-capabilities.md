# 飞书能力调研

> 这是**平台能力与实测证据参考**，不是第二份待办台账。当前行为见 [项目首页](<../README.md>) 与 [架构](<./architecture.md>)，开放事项以 [项目待办](<https://github.com/Starxer/chatterbox4dsh/blob/main/TODO.md>) 为准。
> 文档整理：2026-10-13；探针结论保留各自发生日期与验证范围，未在本轮重新请求飞书 API。媒体可见性与数据流见 [隐私说明](<./privacy.md>)。
> 服务端接受结构、真发送属性校验、人眼确认渲染是三种证据，不能互相替代；未使用的组件不是已经验收的能力。

> 文中 `probe-*.py` / `.ts` 是历史取证脚本名，**不随源码仓库或 npm 分发，也不是阅读前置**；保留的是用例与结果，不让维护者去寻找本机文件。

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
> **媒体类只有三种：图片 / 视频 / 音频**。**没有任何"文件/附件"组件**（`file` / `attachment` / `media` / `cloud-doc` / `file-preview` 文档路径全 404；富文本的 HTML 白名单里也没有 `<file>`，且 `<video>` 只能作独立元素、写不进富文本）——PDF / Office / 压缩包等只能走原生文件消息。详情与实测见 [变更记录](<../CHANGELOG.md>)“卡片内联媒体”。

### 2.1 内容组件（Content）

| 组件 | tag | 说明 | dsh-feishu 现状 |
|---|---|---|---|
| 普通文本 | `plain_text` | 无格式文本 | ✅ 卡片 header |
| Markdown | `markdown` | 表格/标题/内联代码/链接/粗体/斜体 | ✅ 主要使用 |
| Lark Markdown | `lark_md` | 文本对象格式（标签、控件文本等） | ✅ 如 checker 标签；Card 2.0 不使用旧 note 容器 |
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
| **多选下拉** | `multi_select_static` | 下拉多选（`options` 字段） | ❌ 未使用 | 批量操作选项（若要把勾选组换成下拉，可改用它） |
| **复选框** | `checker` | **单个复选框**（`text` + `checked`；**没有 `options` 字段**，见 2.2.1） | ✅ **多选题卡片**（2026-10-07：每个选项一个 `checker` + 一次「提交」） | 一次性提交多开关（`/display` 的备选方案，见 [`display-card-design.md`](<https://github.com/Starxer/chatterbox4dsh/blob/main/docs/display-card-design.md>)） |
| **日期选择** | `date_picker` | 日期选择器 | ❌ 未使用 | — |
| **时间选择** | `time_picker` | 时间选择器 | ❌ 未使用 | — |
| **人员选择** | `select_person` | 选择人员 | ❌ 未使用 | 多人协作 |
| **文本输入** | `input` | 文本输入框（**不能预填、不能补全**，见 §2.2.2） | ✅ 问题卡片自定义回答、会话改名卡、新建工作区 | 带占位符的输入（替代部分斜杠命令） |
| **溢出菜单** | `overflow` | 更多操作菜单；2026-10-12 真发送接受 | ❌ 产品未使用 | 查看上下文/清空/导出 |

#### 2.2.1 `checker` 实测：它是**单个复选框**，字段名只能靠「真发一次」判定（2026-10-07）

多选题（[项目待办](<https://github.com/Starxer/chatterbox4dsh/blob/main/TODO.md>) O24）要在飞书侧表达「勾选多项后一次提交」，候选控件是 `checker` 与 `multi_select_static`。`cardkit.card.create` 对两者都回 `code=0`，而伪造 tag `checker_bogus` 被拒（`10002 not support tag`）⇒ **tag 确实存在且被服务端校验**；但**字段名判不出来**（同 §2.3.2 的口径：create 静默容忍未知字段）。

**判字段的另一个办法（本次发现，比 create 强得多）**：走真正的发送路径 `im.v1.message.create`。它**严格校验**卡片 JSON，而且**被拒的卡根本不会发出去**（聊天里不留痕迹）⇒「真发一次」就是一个**免费的字段探针**：

| 尝试 | 结果 |
|---|---|
| `checker` + `options:[{value,text,checked}]` | `230099` / ext `200621`：**`unknown property, property: options, path: … (tag: checker)`** ⇒ `checker` **没有** `options` 字段 |
| `checker` + `text` + `checked`（一个选项一个 checker，各自 `name`） | **发送成功** ⇒ 这才是它的形状 |

**结论**：`checker` 是**单个复选框**（`text` + `checked`），**多选 = 每个选项一个 `checker` 元素**（`name` 各异）；提交时 `form_value` 是 **`{name: true/false}`**——真机点击三个复选框读回 `{"c1":true,"c2":true,"c3":true}`。**一次提交带回全部勾选**，过程中完全没有卡片重绘，天然避开「带按钮的卡改 2–3 次后回调失效」（关键坑 11）。探针脚本：`probe-checker-card.py`（带 `--send` 时真发一张到绑定聊天）。

#### 2.2.2 `input` 实测：**不能预填、也不能补全**（2026-10-12）

起因：使用者问「输入框能不能预填 home，能不能像 Linux 的 tab 那样一边输入一边补全路径」。

**候选字段名逐个真发**（`im.v1.message.create` 严格校验属性名；对照组 `bogus_xyz` 同样被拒，口径见 §2.3.2）：

| 尝试（`input` 元素上） | 结果 |
|---|---|
| `bogus_xyz: 1`（对照） | ❌ `230099 · 200621 unknown property` |
| `value: {tag:'plain_text', content:'~/proj'}` | ✅ **接受** |
| `default_value` / `initial_value` / `default` / `preset_text` / `prefill` / `text` | ❌ 全部 `unknown property` |
| form 级 `value` / form 级 `initial_value` | ❌ `unknown property` |
| `options: [{text,value}]`（候选列表） | ❌ `unknown property` |
| `autocomplete` / `suggestions` / `datasource`（元素级与 form 级） | ❌ 全部 `unknown property` |

**三条结论**：

1. **预填做不到**：唯一被接受的 `value` **发出去后输入框仍是空的**（2026-10-12 发过 A/B 对照样板，使用者目视确认）——它只是被服务端容忍的字段，客户端不用它渲染初值。
2. **补全做不到**，而且不只是「没有字段」：飞书**不会把按键事件回传给机器人**——卡片是静态 JSON，输入过程只发生在客户端，**只有「提交」才产生一次回调**。没有事件源就没有实时补全。
3. **能做的是候选选择，不是输入框预填**：输入一个前缀 → 提交 → 发候选行 → 点一行把选中路径写入**插件流程状态**，再用文本展示/确认，不声称新卡输入框能预填。已实现的近似是在“路径不存在”确认卡列出**最深的已存在父目录**下的候选目录，点一下改用该路径。

### 2.3 容器/布局组件（Container）

| 组件 | tag | 说明 | dsh-feishu 现状 | 潜在场景 |
|---|---|---|---|---|
| **可折叠面板** | `collapsible_panel` | 折叠/展开内容块（**这是唯一的折叠机制**；markdown 没有 `lines` / 展开全文字段，见 §2.3.3） | ✅ **已用于真机**（2026-09-29：推理段与压缩摘要；2026-09-29：加边框+底色+「已折叠 · 点击展开」文案，收起态才看得出来；2026-10-12：确认它可以**只包住一部分内容**，前后元素照常显示；探针见下） | 🔥 压缩摘要、长 reasoning、长工具输出 |
| **标签页** | `tab` + `tab_content` | 多标签页切换 | ❌ 未使用 | 多 step 结果分页查看 |
| 分割线 | `hr` | 水平分割线 | ✅ 已使用 | — |
| 注释 | `note` | 底部注释（Card JSON 1.0） | ⚠️ 2.0 不支持 | 用 `markdown` + `text_size: 'notation'` 替代 |

#### 2.3.1 折叠组件探针实测（2026-09-29）

以下保留当时的探针记录：2026-09-29 开始调查时尚未使用折叠组件，文档抓取受限，因此用 API 取证；这不是当前“未使用”的结论。做法是**只建卡片实体、不发送**的 `cardkit.card.create` 探针（脚本 `probe-collapsible-card.py`），并带一个**伪造 tag 的对照**来证明判据有区分力：

| 用例 | 结果 |
|---|---|
| `collapsible_panel` + `expanded: false` + `header.title` + `elements` | `code=0`，拿到 `card_id` ✅ |
| `collapsible_panel` + `default_expanded` | `code=0`（未知字段被容忍，据此判不出正确字段名） |
| `collapsible`（1.0 名字） | `code=10002 ErrMsg: not support tag` ❌ |
| 对照：伪造 tag `collapsible_bogus` | `code=10002 not support tag` ❌（对照有效 ⇒ 上面的成功有意义） |

结论：**tag 必须写 `collapsible_panel`**；初始展开态的字段名（`expanded` vs `default_expanded`）用 create 分不出来，按 `expanded` 实现、真机再校（纯外观，不影响结构，也不会让卡片发不出去）。

**2026-09-29 起已在产品里使用**：步骤卡的推理段（`src/feishu-streaming.ts` 的 `renderStepCard`）与压缩卡的摘要（`src/feishu-compaction.ts`）都用 `collapsible_panel` + `expanded:false` + `header.title` + `elements`，是把上面这份探针 JSON 原样搬进渲染器的。

**同日的第二个探针（`probe-step-card-panel.py`）**：上面验的是面板**自己**，这里再验**整张卡**——因为真实卡片是 markdown + `hr` + `text_size: notation` + 面板混排，而 `cardkit.card.create` 会对整份 JSON 做服务端校验。三个用例（只建实体、不发送）：

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

⇒ 回读确认 `expanded:false`、注入提示位于正文最前面且无注入正文、默认详细档结构完整。**证据范围**：这是服务端当前卡片结构，不等于所有客户端的目视结果；后来真实折叠样板已确认默认收起，字段使用 `expanded`，不要因早期备选说明盲目切换 `default_expanded`。

#### 2.3.2 「折叠要看得出来」实测（2026-09-29）

使用者反馈：**收起态的面板看不出来是折叠的**（"不了解的人不知道这个东西已经折叠了"）。原因是结构性的事实——收起时面板只渲染 `header`，而光秃秃的 header 长得就像一个小标题，飞书客户端不一定会画（或画得很淡）任何 chevron。WebUI 的同类行有 chevron，飞书这张卡必须自己想办法。

修法是两条一起上：**文案**（`cardFoldTitle`，任何客户端都丢不掉）+ **外观**（`border` 与 `header.background_color`，让 header 像一块可点的东西）。外观字段能不能用，只能靠服务端校验来判定，而这里有一个**必须写下来的取证口径**：

> `cardkit.card.create` **静默容忍未知字段**——在 `collapsible_panel` 的 `header` 里塞一个 `bogus_xyz` 照样 `code=0`。所以「建卡成功」**不能**证明字段存在；只有「某个**值**被拒」才是证据。

`probe-panel-affordance.py` 的逐个字段实测（手写卡片；对照组是「合法值 vs 明显非法的值」）：

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

**同日第三个探针（`probe-real-fold-cards.py` + `.ts`，端到端）**：手写探针能过不代表**产物**能过，所以把 `renderStepCard` / `renderCompactionCard` 的**真实输出**（zh/en 各一张步骤卡、压缩卡的 summary 与 done 两态）直接打给 `cardkit.card.create`：

| 用例 | 结果 |
|---|---|
| 步骤卡（zh，detailed，折叠推理面板 + 工具参数/结果 + 页脚） | `code=0` ✅ |
| 步骤卡（en） | `code=0` ✅ |
| 压缩卡（summary 态，详情行 + 折叠摘要） | `code=0` ✅ |
| 压缩卡（done 态、无摘要） | `code=0` ✅ |

四张卡的折叠元素都带上 `border={grey-300,4px}`、`header.background_color=grey-100`、标题结尾的 `（▸ 已折叠 · 点击展开）`——即**服务端接受的就是线上真正会发的那份 JSON**。

#### 2.3.3 「只折叠一部分内容」只有一种做法：markdown 没有折叠 / 展开全文字段（2026-10-12）

使用者问：「除了折叠卡片，feishu 是否还支持**折叠部分内容、点击展示全部内容**」。官方文档在本机**仍然读不到**（抓取工具对解析地址的安全检查拒绝访问；这与 TLS 失败是不同层面的事实，不能把 fake-IP 本身当成故障根因），所以又走**真发一次当探针**。

**判据（这次的对照组特别重要）**：`im.v1.message.create` 严格校验的是**属性名是否存在**，不是值 —— 「已知名字 + 明显非法的值」（`text_size: 'gigantic'`）会被**接受**，而「不存在的名字」（`bogus_xyz`）以 `230099 / 200621 unknown property` **整卡被拒**。所以「被拒」是可信的否定证据。全部用例发到一次性测试群并**随即撤回**。

| 用例（markdown 元素上） | 结果 |
|---|---|
| `bogus_xyz: 1`（对照：不存在的名字） | ❌ `230099 · 200621 unknown property` |
| `text_size: 'gigantic'`（对照：存在的名字、非法值） | ✅ 接受 ⇒ 值不校验 |
| `lines: 2` / `lines: "2"` | ❌ `unknown property` |
| `max_lines: 2` | ❌ `unknown property` |
| `collapsed: true` / `fold: true` | ❌ `unknown property` |
| `tooltip: {…}` | ❌ `unknown property` |
| `overflow` **元素**（`options: [{text, value}]`） | ✅ 接受 —— 但它是**动作菜单**（"更多"），不是内容折叠 |
| `collapsible_panel` **只包住中间一段元素**（前后各留一行） | ✅ 接受（见下） |

**结论**：

1. **没有**「markdown 显示前 N 行 + 点击展开全文」这种局部折叠 —— `lines` / `max_lines` / `collapsed` / `fold` / `tooltip` 五个名字全部不存在，服务端拒绝整卡。
2. **但「折叠部分内容」本身支持**：`collapsible_panel` 可以只包住你选中的那几个元素，**面板前后的元素照常显示**（2026-10-12 发过真机样板：`markdown` + 面板 + `markdown` 三个元素，只有中间那段折起来，`expanded:false`，点标题展开）。
3. **折叠粒度 = 整个元素/整行**：面板是**块级容器**，不能折进一段文本中间（做不到「这句话只显示前半截」）。
4. 「点击看到全部内容」的等价做法只有两条：**① 面板展开**（原生、唯一）；**② 自己发一张带按钮的卡，点了之后重发一张展开的卡** —— 后者要注意坑 11（同卡就地更新 2–3 次后按钮回调失效 ⇒ 必须发新卡），代价是对话里多一张卡。`overflow` 只能挂动作，不能就地揭示内容。
5. 两条不变的硬限制：**折叠只省屏不省字节**（面板正文照样进卡片 JSON，坑 42 ⇒ 30KB 上限不因折叠放宽）、**卡片实体只能发送一次、有效期 14 天**（坑 57）。

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

### 3.1 扫码流程声明的权限

| 权限 | 说明 | 用途 |
|---|---|---|
| `im:message.p2p_msg:readonly` | 读取私聊消息 | 接收用户消息 |
| `im:message.group_at_msg:readonly` | 读取群聊 @消息 | 接收群内 @机器人 |
| `im:message.group_msg` | 接收群聊全部消息 | 关闭 @限制时需要；扫码申请不保证管理员已批准 |
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

- **扫码流程**：[扫码流程](<https://github.com/Starxer/chatterbox4dsh/blob/main/src/provision.ts>) 的 `FEISHU_PROVISION_SCOPES` 数组自动申请
- **手动配置**：飞书开发者后台 → 应用 → 权限管理 → 开通权限

---

## 四、事件订阅

### 4.1 扫码流程订阅

| 事件 | 说明 | 订阅方式 |
|---|---|---|
| `im.message.receive_v1` | 接收消息 | `add_events` 参数 |

### 4.2 卡片回调与可选 SDK 事件

| 事件 | 说明 | 备注 |
|---|---|---|
| `card.action.trigger` | 卡片按钮/选择器点击 | WebSocket 模式下自动推送 |
| `im.message.reaction.created_v1` | 表情回复添加 | SDK 支持处理，插件未使用；不保证应用已订阅 |
| `im.message.reaction.deleted_v1` | 表情回复删除 | SDK 支持处理，插件未使用；不保证应用已订阅 |
| `im.chat.member.bot.added_v1` | 机器人被添加到群 | SDK 支持处理，插件未使用；不保证应用已订阅 |

### 4.3 事件订阅注意事项

- `add_events` 参数（`applicationConfig.patch` API）**只接受 IM 事件类型**
- `card.action.trigger` 是卡片回调事件，**不是 IM 事件**，不能放在 `add_events` 里（会 400 报错）
- 卡片回调在 WebSocket 长连接模式下自动推送，无需额外配置
- 新建应用（扫码流程）自动订阅 `im.message.receive_v1`
- 已有应用需要在开发者后台手动添加事件订阅

---

## 五、卡片回调安全机制

SDK 的 `SafetyPipeline` 提供去重与串行保障；这些是并发机制，**不是资源权限或文件围栏的完整安全证明**：

| 机制 | 说明 |
|---|---|
| **去重** | `card:${messageId}:${openId}:${actionId}` 键去重，防止同一按钮被重复处理 |
| **锁** | per-chat 锁，防止同一聊天的并发回调冲突 |
| **队列** | per-chat 队列，保证同一聊天的回调按序处理 |

---

## 六、组件落地状态（不是待办优先级）

| 能力 | 当前状态 | 边界 |
|---|---|---|
| 模型选择 | ✅ `select_static` 等组件组成向导 | 仍有 O4 的带按钮就地更新风险 |
| 推理折叠 | ✅ `collapsible_panel`，默认收起 | detailed 200 字预览、verbose 面板保留全文；没有上游思考 token 就只显示耗时 |
| 压缩摘要 | ✅ 事务卡 + 折叠摘要 | 正文预算 22,000 UTF-8 字节，超限有说明；不是旧的 200 字 |
| compact 过程折叠 | ✅ 只折更早步骤 | 可见/折叠共用按步元素，步头在 quote 外；最多最新 5 步/40 行，折叠最多 60 行 |
| 工作区选择 | ✅ `interactive_container` 行与目录浏览 | 输入框不能预填/实时补全；新建文件夹为独立提交动作 |
| `present` 交付 | ✅ 媒体、自动文档、其他文件可点确认 | 回调只有不透明 token，每次点击重验路径；原生文件不是卡片附件组件 |
| 单选问答 | ✅ 点选即记答案，结算问题卡 | 非最后题发回执可重答，全部答完最终确认才交模型；回调认当前 message id，重答需新问题卡 |
| 多选问答 | ✅ 每个选项一个 `checker` | 一次提交全部勾选，中途不重绘，不用一个 checker 的 options |
| 后台任务/子代理 | ✅ 原生 table 快照 | 变化发新卡，不逐任务就地更新；前台 jobs 不列，模型从事件与会话事实双源读取 |
| 长工具输出折叠 | 🔲 未实现 | 当前仍有界预览，不能由“折叠组件可用”推成已经落地 |
| 多 step 标签页 / 图表 / 更多动作菜单 | 🔲 未作为产品能力实现 | 候选 tag 的存在不等于本插件已验收；是否做以项目待办/需求为准 |

具体优先级只维护在 [项目待办](<https://github.com/Starxer/chatterbox4dsh/blob/main/TODO.md>)，本表仅说明平台组件如何用于当前产品。

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
| 单个 markdown 元素内容 | 社区报告约 ~10k 字符 | 非本项目逐边界实测，不作为稳定平台契约；发送前仍应主动分段 |
| 卡片标题色带重绘 | — | 部分客户端在卡片更新后不重绘 `header.template`（白底），属客户端渲染问题 |
| 流式卡片自动关闭 | 10 分钟 | 本插件**未启用** `streaming_mode` |
| markdown 加粗：关闭 `**` 前有标点、后紧跟字 | — | **飞书按字面渲染星号**（2026-10-10 真机探针）：`**加粗。**后面` / `**加粗：**后面` / `**带括号（说明）**后面` / `**加粗…**后面` 都失败；把标点移到加粗外（`**加粗**。后面`）正常，可见文字不变。`src/card-emphasis.ts` 在每次写卡前自动改写（关键坑 60）。**未验证的边界**：关闭 `**` 后面跟的是**符号 / emoji** 而不是字 |
| markdown 加粗：`**` 未闭合（含被截断） | — | 同样按字面渲染。一行式预览过去用固定字数硬切，切口落在 `**…**` 里就会留下悬空 marker；现统一走 `src/text-chunk.ts` 的 `truncateInline()`（关键坑 60） |
| 文本流式频率 | 历史资料示例 70ms/次 | 非无限 QPS 保证，本插件**未启用** |

---

## 八、在线文档读写（docx）

`src/feishu-doc.ts` 提供两个模型工具，让 agent 把飞书文档当工作对象，而不是只在聊天里贴链接。

| 步骤 | 接口 | 说明 |
|---|---|---|
| 解析 wiki 链接 | `wiki.v2.space.getNode` | `…/wiki/<node_token>` → `obj_token` + `obj_type`；不是 docx 直接报错 |
| 读 Markdown | `docs.v1.content.get`（`doc_type: docx`、`content_type: markdown`） | 目前唯一返回 Markdown 的接口；需要 `docs:document.content:read` |
| 读纯文本（回退） | `docx.v1.document.rawContent` | Markdown 读取权限缺失时降级，标题/列表结构丢失，结果里 `format: text` |
| Markdown → 块 | `docx.v1.document.convert` | 支持文本、1–6 级标题、有序/无序列表、代码块、引用、待办、图片、表格、单元格（逐项实测见下） |
| 插入块 | `docx.v1.documentBlockDescendant.create` | 单次上限 1000 块；`children_id` 用转换结果的 `first_level_block_ids` |
| 清空正文 | `docx.v1.documentBlockChildren.batchDelete` | `replace` 模式先删 `0..N`，N 取根块 `children` 长度 |
| 新建文档 | `docx.v1.document.create` | 归应用所有；`folder_token` 可指定落点 |
| 取链接 | `drive.v1.meta.batchQuery`（`with_url`） | 只用于回显 URL，失败不影响读写 |

**权限现状（2026-11-04 实测，应用身份）**：

- 平台模板已给到 `docx:document:readonly`、`docx:document:write_only`、`docx:document.block:convert`、`wiki:node:read`、`drive:drive.metadata:readonly`、`docs:document.comment:*` —— 所以**读、改已存在文档、解析 wiki 链接、取 URL 本来就通**。
- 缺的四项：`docx:document:create`（新建）、`docs:document.content:read`（Markdown 读取）、`docs:document.media:upload`（图片素材上传）、`docs:permission.member:create`（加协作者）。**2026-11-04 已通过 `applicationConfig.patch` 的 `scope.add_scopes` 给当前应用补上**：两次 `code=0`、权限数 38→42、`application.scope.list` 均 `grant_status=1`，随即 `document.create`、`media.uploadAll`、`permissionMember.create` 全部成功（免审权限，立即生效）。
- 其余链路（`document.get`、`documentBlock.*`、`documentChild create/batchDelete`、`document.convert`、`wiki.space.getNode`、`drive.meta.batchQuery`）从一开始就没有权限码，假 token 时报的是资源级 `1770002` / `131005`。
- 删除文档需要 `drive:drive` 或 `space:document:delete`（未申请），所以探测产生的**应用自建文档无法用 API 删除**；应用自建文档对普通用户默认不可见。

**端到端回环（2026-11-04，`feishu_doc_write` → `feishu_doc_read`）**：新建 → `convert`（27 块 / 18 个一级块）→ 插入 → Markdown 读回，全部成功。回读侧观察到的差异（写进去的块是对的，读回文本是飞书的口径）：

- 文档标题本身是正文第一块（H1），`docs.v1.content.get` 会把它一并返回；
- 表格回读成 HTML `<table>`，单元格文本各占一行；
- 代码块语言被规范化（`js` → `JavaScript`）；
- 已完成的待办回读时带删除线（`* [x] ~~已完成~~`）；
- 行内样式（加粗/斜体/删除线/行内代码/链接/`<u>`）完整保留；`#`…`######` 保留；`#######` 起是正文。

**`feishu_doc_write` 实际能写的 Markdown（2026-11-04 `document.convert` 实测，不需要文档权限）**：

| Markdown | 转换结果 |
|---|---|
| 普通段落 | `text` 块 |
| `#` … `######` | `heading1` … `heading6`；**`#######` 起降级成普通文本**（文档写 1–9 级，实测只有 1–6） |
| `-` / `1.` 列表 | `bullet` / `ordered` 块；**嵌套靠 `children` 保留**，缩进层级是真实父子结构 |
| `- [ ]` / `- [x]` | `todo` 块，`done` 状态正确 |
| `>` 引用 | `quote` 块，多行合并为一个块；**嵌套引用会被拍平** |
| 围栏 ```` ```js ```` / 四空格缩进 | `code` 块（代码块语言随块携带） |
| `\| A \| B \|` + 分隔行 | `table` + `table_cell` + 子 `text`；**没有分隔行就退化成普通文本** |
| `---` | `divider` 块 |
| `**粗**`、`*斜*`、`~~删~~`、`` `code` ``、`[链接](url)`、`<u>下划线</u>` | 都是 `text_run` 的行内样式（`bold`/`italic`/`strikethrough`/`inline_code`/`link`/`underline`） |
| `![图](url)` | 生成 `image` 块，但**本插件丢弃**（见下） |
| `<video>` / 裸 HTML 块 | 不支持，被忽略 |
| `content_type: html` | 接口支持（`<h2>/<p>/<ul>` 可转块），但**工具只暴露 Markdown** |

**图片写入管线（2026-11-04 实测）**：

1. `document.convert` 会为每个 `![](…)` 产出一个 image 块（带 `block_id`，`image.token` 为空，宽高默认 240）；
2. 插入块后 `drive.v1.media.uploadAll`（`parent_type: docx_image`、`parent_node` = image 块的 `block_id`）拿到素材 `file_token`；
3. 再 `documentBlock.patch` 的 `replace_image: { token }` 把素材挂到该块 —— 实测 `code=0`。
- **只支持绝对路径的本地图片**（png/jpeg/webp/gif、≤10 MB）：远端 URL 不抓（避免让模型触发任意出站请求、也避免把外网内容静默带进租户文档），相对路径没有可靠基准（Markdown 是文本不是文件）。
- **文档共享**：`drive.v1.permissionMember.create`（`member_type: openid`、`perm: edit`）实测 `code=0`；`create` 模式会把新文档共享给对话里最后一个发言的用户（open_id 由入站消息的 `senderId` 记在 bridge 内存里，重启丢失则跳过共享并如实上报）。
- **读回不含图片**：`docs.v1.content.get` 的 Markdown 输出里没有图片引用（实测），图片是否嵌入要看块本身，不能靠读回判断。

**协作能力（2026-11-04 实测，`feishu_doc_comments` / `feishu_doc_blocks`）**：

| 能力 | 接口 | 实测结论 |
|---|---|---|
| 版本号 | `docx.v1.document.get` | `revision_id` 可用（新建后 1，每次编辑 +1） |
| 乐观锁 | 编辑接口的 `document_revision_id` | **过期 revision 不会被拒绝**：用旧版本调 `documentBlockDescendant.create` 仍 `code=0` 并写入 ⇒ 只能在应用层「写前比对」，`feishu_doc_write` 的 `revision` 参数即此实现（剩余竞争窗口毫秒级） |
| 列块 | `docx.v1.documentBlock.list` | 返回块 id / 类型 / 文本 / image token |
| 改块 | `docx.v1.documentBlock.patch`（`update_text_elements`） | `code=0`，读回文本已更新；块类型保留，行内样式重置为纯文本 |
| 读评论 | `drive.v1.fileComment.list` | `code=0`，含 `is_whole` / `is_solved` / `quote` / `reply_list` |
| 发评论 | `drive.v1.fileComment.create` | 只能建**全文评论**（接口明确不支持局部评论），`code=0` |
| 回评论 | `drive.v1.fileCommentReply.create` | 对全文评论返回 `1069302 The comment section does not allow replies` ⇒ 工具不提供回复动作 |

**已知取舍**：

- **图片写入是尽力而为**：每张图单独失败（读不到/超限/上传失败）只记跳过、不中断整篇；被跳过的 image 块仍留在文档里，表现为空图片占位。
- 表格的 `merge_info` 是只读字段，写回前递归剥掉（官方文档明确要求）。
- 只支持新版文档（`docx`）；旧版 `doc`、`sheets`、`bitable` 明确报错，不猜。
- 单篇文档并发编辑上限 3 次/秒（官方），一次写入通常是 2–3 个串行请求。
- 应用身份新建的文档属于应用；用户要直接打开需要另行加协作者。

---

## 九、相关文档

- [飞书卡片 JSON 2.0 结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure.md)
- [卡片组件概述](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/component-json-v2-overview)
- [配置卡片交互](https://open.feishu.cn/document/feishu-cards/configuring-card-interactions.md)
- [发送消息 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create)
- [流式更新卡片概述](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview.md)
- [卡片回传交互回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication.md)
- [添加消息表情回复 API](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)
