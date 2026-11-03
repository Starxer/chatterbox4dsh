# Feishu / Lark 应用配置

> 当前配置与排查指南。安装前先确认发布包的兼容范围；仓库主线与已发布版本的区别见 [项目首页](<../README.md>)。完整入口见 [文档导航](<./README.md>)，数据上传边界见 [媒体与隐私](<./privacy.md>)。

## 扫码一键配置（推荐）

插件内置了飞书官方 `registerApp` 扫码建应用能力：

1. 启动 DSH Web Profile，打开 **Plugins → 飞书与 Lark** 详情页。
2. 点页面右上角的 **扫码配置**，用飞书 App 扫码并确认授权——二维码显示在该页的「连接与扫码」区块里。
3. 插件自动获取 `appId` 和应用凭据，配置权限和事件，建立连接。App ID 会写回配置，可在 **Settings → 飞书与 Lark** 查看。

> **扫码不是网络修复**：详情页没有独立的“强制重连”入口；`LarkRuntime.reconcile()` 按连接指纹门控，重复保存相同配置不重建通道，日常断线由 SDK 重连。凭据、平台、访问策略或表情设置变化会重建通道，**可能中断活动回合**。TLS/DNS/代理故障先修链路，不要通过改配置或重新扫码去碰碰运气。

## 手动创建应用

### 1. 创建自建应用

1. 打开飞书或 Lark 开发者后台。
2. 创建企业自建应用，填写名称、描述和图标。
3. 记录 `appId` 和应用凭据，勿贴进聊天或公共文件。

### 2. 启用机器人

1. 进入"添加应用能力"。
2. 添加"机器人"能力。

### 3. 添加权限

必需权限：

| 权限标识 | 用途 |
|---|---|
| `im:message.p2p_msg:readonly` | 接收单聊消息 |
| `im:message.group_at_msg:readonly` | 接收群聊 @机器人消息 |
| `im:message.group_msg` | 接收群聊全部消息（关闭 @机器人 限制时必需，通常需管理员审批） |
| `im:message:send_as_bot` | 以机器人身份发消息 |
| `im:message.reaction` | 收到消息时添加表情回应（`reactEmoji`） |
| `application:application:patch` | 扫码建应用流程专用（写入长连接等配置） |

> 扫码一键配置会自动申请以上全部权限（`src/provision.ts` 的 `FEISHU_PROVISION_SCOPES`）。

在线文档工具（`feishu_doc_read` / `feishu_doc_write`）需要的权限：

| 权限标识 | 用途 | 来源 |
|---|---|---|
| `docx:document:readonly` / `docx:document:write_only` / `docx:document.block:convert` / `wiki:node:read` / `drive:drive.metadata:readonly` | 读文档、改已存在文档、转换 Markdown、解析 wiki 链接、取文档 URL | **平台模板默认自带**，无需申请 |
| `docx:document:create` | 新建文档（`feishu_doc_write` 的 `create`） | 扫码流程自动申请（`FEISHU_DOC_SCOPES`） |
| `docs:document.content:read` | 以 **Markdown** 读取；未开通时退回纯文本 | 同上 |
| `docs:document.media:upload` | 把 Markdown 里的本地图片上传并内嵌到文档 | 扫码流程自动申请（`FEISHU_DOC_SCOPES`） |
| `docs:permission.member:create` | 把新建文档共享给发起请求的用户（应用身份建出的文档归机器人所有，不加协作者用户打不开） | 同上 |

**已有应用怎么补**（不用重新扫码建应用）：

1. 开发者后台 → 权限管理，勾选上面的权限，然后创建版本并发布；或
2. 用应用自身凭证调 `application.v7.applicationConfig.patch` 的 `data.scope.add_scopes`（需要 `application:application:patch`，扫码建的应用已有）。**免审权限立即生效**，其余仍需发布审核；本部署 2026-11-04 就是用它补齐的。

> 应用身份（tenant access token）只能操作**已把应用添加为协作者**的文档：打开文档 → 分享 → 添加协作者 → 搜索应用名。新建文档归应用所有，用户要看到它需要另行授权，或在 `create` 时给一个应用有写权限的 `folder_token`。

> 应用身份（tenant access token）只能操作**已把应用添加为协作者**的文档：打开文档 → 分享 → 添加协作者 → 搜索应用名。新建文档归应用所有，用户要看到它需要另行授权，或在 `create` 时给一个应用有写权限的 `folder_token`。

### 4. 配置事件

1. 进入"事件与回调" → "事件订阅"。
2. 选择"使用长连接接收事件"。
3. 添加事件 `im.message.receive_v1`。

### 5. 发布并安装

1. 创建应用版本并发布。
2. 安装到企业。
3. 在飞书中找到机器人发起单聊，或加入测试群。

## 配置凭据

### 通过 Settings 页面（推荐）

在 DSH **Settings → 飞书与 Lark** 中填写 `appId` 和 `appSecret`。凭据保存到 `$DSH_HOME/.credentials.yaml`，不会回显到浏览器。

该页只管**配置**（凭据、访问策略、卡片显示）；**连接状态与扫码**在 **Plugins → 飞书与 Lark** 详情页。

### 通过环境变量

```sh
export DSH_LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
npx @deepseek-ai/dsh web
```

### 通过 Profile Patch

```yaml
- id: lark-channel
  config:
    appId: cli_xxxxxxxxxxxxxxxx
    appSecretRef: DSH_LARK_APP_SECRET
    domain: feishu
```

## 常见问题

| 问题 | 排查 |
|---|---|
| 启动鉴权失败 | `appId` 和应用凭据是否匹配 |
| 收不到消息 | 应用是否已发布安装、是否订阅 `im.message.receive_v1`、是否为长连接模式 |
| 群消息被忽略 | 是否 @了机器人、权限是否审批、`groupAllowlist` 是否允许 |
| 不能回复 | 检查 `im:message:send_as_bot` 权限和终端 API 错误 |
| 单聊被拒绝 | 检查 `dmMode` 和 `dmAllowlist` |
| 没有表情回应，但 agent 收到了消息 | 先确认 `reactEmoji` 非空与 `im:message.reaction` 权限；再查 `reaction failed`。表情失败会记警告但继续处理消息，当前不自动重试 |
| 能收消息，所有回复/卡片却发不出去 | 入站 WebSocket 可能仍活着，但新建出站 HTTP/TLS 已失败；分开查两个方向，见下 |
| 详情页显示“出站异常” | 查最近请求的具体错误；收到业务错误响应说明对端应答，不应与 DNS/TLS 链路失败混为一谈 |
| 详情页显示“尚未观测到出站请求” | 尚无请求事实，不是已经验证健康 |
| 反复重连 | 检查网络/代理/防火墙，确保只有一个实例使用该应用 |

### 能收不能发：先查链路，不先重启

入站长连接与出站 OpenAPI 是两条路径。已经建立的 WebSocket 可继续收事件，而新建 TLS 握手可能被网关/代理拒绝；旧连接也断开时，入站才一起停止。

1. 看 **Plugins → 飞书与 Lark** 的入站状态与出站观测，以及宿主日志的原始错误。`SSL_ERROR_SYSCALL`、握手前断连、`EPROTO`、`ENOTFOUND` 是链路证据；API 的权限/业务码是另一类问题。
2. 飞书中国版可用不带凭据的有界请求检查 HTTPS：

   ```sh
   curl --connect-timeout 5 --max-time 10 -sS -o /dev/null \
     -w 'HTTP %{http_code}\n' https://open.feishu.cn/open-apis/
   ```

   该路径通常返回 `404`，表示 HTTPS 对端有响应，**不证明 token、权限或发消息功能正常**。`000` 表示没有拿到 HTTP 响应，需看 stderr；不能仅凭状态码猜是哪一层。国际版改测对应 Lark 域名。
3. 若域名走 fake-IP/透明代理，检查网关连接日志里的**实际命中规则与出站**，对比普通飞书站点和 OpenAPI 域名。fake-IP 本身是代理机制，**不是故障证明**；也不能仅凭十几毫秒断连就认定 REJECT、节点坏了或缓存冲突。
4. 先修已确认的网关/路由/DNS/TLS 问题，再发下一条正常消息验证。链路恢复通常不需要重启 DSH；此前失败的表情/消息不会因此自动补发。超时发送可能结果未知，**不要盲目重放整批消息**。

不要把应用凭据、代理管理口令或完整 SDK 请求对象贴到公开日志/问题里。分享排查材料只保留错误码、原因与脱敏域名路径。

**English:** An existing inbound WebSocket can survive while new outbound TLS connections fail. Inspect both directions and separate API permission/business errors from transport failures. An unauthenticated HTTPS response proves connectivity only, not message delivery. Check the proxy's actual rule/outbound rather than guessing from fake-IP or latency; repair the link before restarting. Failed reactions/messages are not automatically replayed, and timed-out sends can have unknown outcomes.
