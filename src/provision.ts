import { Client, Domain, registerApp } from '@larksuiteoapi/node-sdk'
import qrcode from 'qrcode-terminal'
import type { DomainName } from './config.ts'

export type ProvisionPhase = 'idle' | 'waiting' | 'configuring' | 'done' | 'error'

export interface ProvisionState {
  phase: ProvisionPhase
  /** Verification URL to render as a QR code while waiting for the user to scan. */
  qrUrl?: string
  /** Seconds until the verification URL expires. */
  expireIn?: number
  message?: string
}

export interface ProvisionResult {
  appId: string
  appSecret: string
}

export interface ProvisionOptions {
  domain: DomainName
  source?: string
  signal: AbortSignal
  onState(state: ProvisionState): void
}

/** Permissions a Feishu/Lark bot needs to receive DMs, group @mentions, and reply. */
export const FEISHU_BOT_SCOPES = [
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  /** Receive ALL group user messages without requiring @mention. The official
   *  scope for the im.message.receive_v1 push is `im:message.group_msg`
   *  (获取群组中所有消息) — NOT `im:message.group_msg:readonly` (that one only
   *  covers reading chat history via the message APIs). It is marked 敏感权限,
   *  so the one-click scan registration may still refuse to pre-grant it; it
   *  must then be opened in 权限管理 + 创建版本发布. */
  'im:message.group_msg',
  'im:message:send_as_bot',
  /** Needed for addReaction (emoji reaction on inbound messages). */
  'im:message.reaction',
]

/**
 * Scopes the online-document tools need (see `src/feishu-doc.ts`).
 *
 * The platform template already grants `docx:document:readonly`,
 * `docx:document:write_only`, `docx:document.block:convert` and
 * `wiki:node:read`, so reading a document, editing an existing one and
 * resolving wiki links work out of the box. What the template does NOT grant:
 *
 * - `docx:document:create` — `docx.v1.document.create` refuses to run without
 *   `docx:document` or this scope (verified 2026-11-03: `99991672`).
 * - `docs:document.content:read` — `docs.v1.content.get` is the only endpoint
 *   that returns Markdown; without it reads fall back to plain text.
 * - `docs:document.media:upload` — upload a local image and attach it to an
 *   image block (`drive.v1.media.uploadAll` with `parent_type: docx_image`).
 * - `docs:permission.member:create` — share the created document with the user
 *   who asked for it (`drive.v1.permissionMember.create`). Without it a
 *   tenant-token document stays owned by the bot and the user cannot open it.
 *
 * All four are requested here so a freshly scanned app can use the document
 * tools immediately. The app is still limited to documents it is a
 * collaborator on.
 */
export const FEISHU_DOC_SCOPES = [
  'docx:document:create',
  'docs:document.content:read',
  'docs:document.media:upload',
  'docs:permission.member:create',
]

/**
 * Maintenance scopes: ONLY needed to inspect and clean up documents the app
 * itself created (the document tools never delete anything).
 *
 * Deliberately NOT part of {@link FEISHU_PROVISION_SCOPES}: `space:document:delete`
 * lets the app delete documents, and neither scope is needed for normal
 * document work. Grant them explicitly when a cleanup is actually wanted — the
 * current deployment did it with `applicationConfig.patch` →
 * `scope.add_scopes` (free-review, effective immediately):
 *
 * ```json
 * { "scope": { "add_scopes": [
 *   { "scope_name": "space:document:retrieve", "token_type": "tenant" },
 *   { "scope_name": "space:document:delete",   "token_type": "tenant" }
 * ] } }
 * ```
 *
 * They are exported so the docs and any future maintenance command use one
 * source of truth.
 */
export const FEISHU_DOC_MAINTENANCE_SCOPES = [
  'space:document:retrieve',
  'space:document:delete',
]

/**
 * Scope required to call the "update application config" OpenAPI, which the
 * scan flow uses to force the WebSocket long connection (the subscription
 * transport is a sensitive manifest field that `addons` cannot preset).
 */
export const FEISHU_APP_CONFIG_SCOPE = 'application:application:patch'

/** Every tenant scope the scan flow pre-fills so the created app works end-to-end. */
export const FEISHU_PROVISION_SCOPES = [
  ...FEISHU_BOT_SCOPES,
  ...FEISHU_DOC_SCOPES,
  FEISHU_APP_CONFIG_SCOPE,
]

export const FEISHU_MESSAGE_EVENT = 'im.message.receive_v1'

export interface ProvisionLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/**
 * Scan-to-configure flow backed by the official SDK's `registerApp` (RFC 8628
 * Device Authorization Grant). Emits a verification URL through `onState` for
 * the caller to render as a QR code; resolves with the created app credentials
 * once the user scans and authorizes.
 */
export async function provisionApp(options: ProvisionOptions): Promise<ProvisionResult> {
  const registered = await registerApp({
    source: options.source ?? 'dsh-feishu-scan',
    signal: options.signal,
    appPreset: {
      name: 'DSH 助手',
      desc: 'DeepSeek Harness 飞书入口',
    },
    addons: {
      scopes: { tenant: FEISHU_PROVISION_SCOPES },
      events: { items: { tenant: [FEISHU_MESSAGE_EVENT] } },
    },
    onQRCodeReady: info => options.onState({ phase: 'waiting', qrUrl: info.url, expireIn: info.expireIn }),
    onStatusChange: () => undefined,
  })

  options.onState({ phase: 'configuring' })
  await enableWebsocketLongConnection(registered.client_id, registered.client_secret, options.domain)
  await enableCardCallbacks(registered.client_id, registered.client_secret, options.domain)

  return { appId: registered.client_id, appSecret: registered.client_secret }
}

/**
 * The scan flow cannot preset the event subscription transport (it is a
 * sensitive manifest field). Force WebSocket long connection and subscribe the
 * message event through the "update application config" OpenAPI.
 */
export async function enableWebsocketLongConnection(appId: string, appSecret: string, domain: DomainName): Promise<void> {
  const client = new Client({
    appId,
    appSecret,
    domain: domain === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'dsh-feishu-scan',
  })
  const response = await client.application.v7.applicationConfig.patch({
    data: {
      event: {
        subscription_type: 'websocket',
        add_events: [FEISHU_MESSAGE_EVENT],
      },
    },
    path: { app_id: appId },
  })
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`飞书应用配置更新失败: ${response.code} ${response.msg ?? ''}`)
  }
}

/**
 * Enable card action callbacks via the applicationAbility.patch API.
 * Without this, interactive card buttons/selectors do not fire
 * `card.action.trigger` events and appear unresponsive.
 */
export async function enableCardCallbacks(appId: string, appSecret: string, domain: DomainName): Promise<void> {
  const client = new Client({
    appId,
    appSecret,
    domain: domain === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'dsh-feishu-scan',
  })
  const response = await client.application.v7.applicationAbility.patch({
    path: { app_id: appId },
    data: {
      card_action_callback: {
        enable: true,
      },
    } as any,
  })
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`飞书卡片回调配置失败: ${response.code} ${response.msg ?? ''}`)
  }
}

/** Print the verification URL as an ASCII QR code plus a fallback link. */
export function renderTerminalQr(url: string, logger: ProvisionLogger): void {
  logger.info('请用飞书 App 扫描下方二维码完成配置:')
  qrcode.generate(url, { small: true }, qrcodeText => logger.info(qrcodeText))
  logger.info(`如果二维码无法扫描,请在飞书中打开链接: ${url}`)
}
