import z from '@deepseek-ai/schemastery'
import type { PluginLocale } from './i18n.ts'

export type DomainName = 'feishu' | 'lark'
export type DirectMessageMode = 'open' | 'allowlist' | 'disabled'

export const LARK_APP_SECRET_REF = 'DSH_LARK_APP_SECRET'
export const LARK_SETTINGS_NAMESPACE = 'lark-channel'
const DEFAULT_ERROR_MESSAGE = '抱歉，处理这条消息时遇到了问题，请稍后重试。'
const DEFAULT_REACTION_EMOJI = 'THUMBSUP'
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

export interface Config {
  appId?: string
  /** @deprecated Use appSecretRef with the Harness credentials service. */
  appSecret?: string
  appSecretRef?: string
  domain?: DomainName
  requireMention?: boolean
  dmMode?: DirectMessageMode
  groupAllowlist?: string[]
  dmAllowlist?: string[]
  provider?: string
  model?: string
  workspace?: string
  agentPreset?: string
  errorMessage?: string
  /** Emoji reaction the bot adds to every inbound message; empty string disables it. */
  reactEmoji?: string
  /** Show model reasoning/thinking content in tool call cards and final reply. */
  showReasoning?: boolean
  /** Show tool calls on step cards; when false a tool-only step sends no card. */
  showToolCalls?: boolean
  /** Show each tool call's arguments block (requires `showToolCalls`). */
  showToolArgs?: boolean
  /** Show each tool call's result preview (requires `showToolCalls`). */
  showToolResults?: boolean
  /** Plugin language; `auto` (default) follows the DSH browser-language preference. */
  locale?: PluginLocale
}

export interface SettingsConfig extends Required<Pick<Config,
  'appId' | 'appSecretRef' | 'domain' | 'requireMention' | 'dmMode' | 'groupAllowlist' |
  'dmAllowlist' | 'errorMessage' | 'reactEmoji' | 'showReasoning' | 'showToolCalls' |
  'showToolArgs' | 'showToolResults'>> {
  appSecret?: string
  provider?: string
  model?: string
  workspace?: string
  agentPreset?: string
  /** Plugin language; `auto` follows the DSH browser-language preference. */
  locale?: PluginLocale
}

export interface RuntimeConfig extends Omit<SettingsConfig, 'appSecretRef'> {
  appSecret: string
  appSecretRef: string
}

export const ConfigSchema: z<Config> = z.object({
  appId: z.string().default('').description('Feishu/Lark application ID'),
  appSecret: z.string().role('secret').description('Legacy literal application secret'),
  appSecretRef: z.string().role('credential-ref').default(LARK_APP_SECRET_REF).description('Harness credential reference for the application secret'),
  domain: z.union(['feishu', 'lark']).default('feishu'),
  requireMention: z.boolean().default(true),
  dmMode: z.union(['open', 'allowlist', 'disabled']).default('open'),
  groupAllowlist: z.array(z.string()).default([]),
  dmAllowlist: z.array(z.string()).default([]),
  provider: z.string(),
  model: z.string(),
  workspace: z.string(),
  agentPreset: z.string(),
  errorMessage: z.string().default(DEFAULT_ERROR_MESSAGE),
  reactEmoji: z.string().default(DEFAULT_REACTION_EMOJI).description('Emoji reaction added to each inbound message; empty string disables it'),
  showReasoning: z.boolean().default(true).description('Show model reasoning/thinking content in tool call cards and final reply'),
  showToolCalls: z.boolean().default(true).description('Show tool calls on step cards; when false a tool-only step sends no card'),
  showToolArgs: z.boolean().default(true).description('Show each tool call\'s arguments block'),
  showToolResults: z.boolean().default(true).description('Show each tool call\'s result preview'),
  locale: z.union(['auto', 'zh', 'en']).default('auto').description('Plugin language; auto follows the DSH browser-language preference'),
})

export function resolveSettingsConfig(config: Config): SettingsConfig {
  const appSecretRef = config.appSecretRef ?? LARK_APP_SECRET_REF
  if (!CREDENTIAL_REF_PATTERN.test(appSecretRef)) throw new TypeError('appSecretRef must be a POSIX environment variable name')
  const errorMessage = config.errorMessage ?? DEFAULT_ERROR_MESSAGE
  if (errorMessage.length > 500) throw new TypeError('errorMessage must not exceed 500 characters')
  return {
    appId: config.appId ?? '',
    appSecretRef,
    domain: config.domain ?? 'feishu',
    requireMention: config.requireMention ?? true,
    dmMode: config.dmMode ?? 'open',
    groupAllowlist: config.groupAllowlist ?? [],
    dmAllowlist: config.dmAllowlist ?? [],
    errorMessage,
    reactEmoji: config.reactEmoji ?? DEFAULT_REACTION_EMOJI,
    showReasoning: config.showReasoning ?? true,
    showToolCalls: config.showToolCalls ?? true,
    showToolArgs: config.showToolArgs ?? true,
    showToolResults: config.showToolResults ?? true,
    ...(config.appSecret === undefined ? {} : { appSecret: config.appSecret }),
    ...(config.provider === undefined ? {} : { provider: config.provider }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.workspace === undefined ? {} : { workspace: config.workspace }),
    ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }),
    ...(config.locale === undefined ? {} : { locale: config.locale }),
  }
}

export function resolveRuntimeConfig(config: SettingsConfig, resolvedSecret?: string): RuntimeConfig {
  if (config.appId.trim() === '') throw new TypeError('appId is required')
  const appSecret = resolvedSecret?.trim() || config.appSecret?.trim() || ''
  if (appSecret === '') throw new TypeError('appSecret is required')
  return { ...config, appSecret }
}

/**
 * Fingerprint of the fields that decide what the Feishu connection actually IS.
 * `LarkRuntime.reconcile()` compares it to decide whether the runtime must be
 * rebuilt, so it must cover exactly what the channel captures at construction
 * (credentials, domain, and the inbound access policy).
 *
 * Everything else in the settings section is deliberately absent. In
 * particular the card-display switches (`showReasoning` / `showToolCalls` /
 * `showToolArgs` / `showToolResults`), `locale`, and the new-session defaults
 * (`workspace` / `agentPreset` / `provider` / `model`) are read live by other
 * subsystems. Letting any of them into the fingerprint makes a `/display`,
 * `/reasoning show`, or `/lang` write look like a channel change: reconcile
 * then calls `stopCurrent()`, which disconnects the WebSocket and runs
 * `bridge.dispose()` — disposing EVERY live agent and closing its session write
 * handle. Landing that during a turn kills it with
 * `session "…": flush on a closed handle` (observed 2026-09-10, toggling the
 * display card while the agent was running).
 *
 * `errorMessage` is excluded too: it is only a fallback string, never worth a
 * reconnect, and the previous text simply stays until the next real restart.
 */
export function connectionFingerprint(config: RuntimeConfig): string {
  return JSON.stringify({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    requireMention: config.requireMention,
    dmMode: config.dmMode,
    groupAllowlist: config.groupAllowlist,
    dmAllowlist: config.dmAllowlist,
    reactEmoji: config.reactEmoji,
  })
}

/** @deprecated Use resolveSettingsConfig and resolveRuntimeConfig. */
export function resolveConfig(config: Config): RuntimeConfig {
  const settings = resolveSettingsConfig(config)
  return resolveRuntimeConfig(settings, settings.appSecret)
}
