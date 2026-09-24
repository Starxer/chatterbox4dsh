import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { PluginLocale } from './i18n.ts'

export type DomainName = 'feishu' | 'lark'
export type DirectMessageMode = 'open' | 'allowlist' | 'disabled'
/**
 * How far the plugin may go to make media the model referenced in card text
 * render inline (关键坑 39's L3, extended to video/audio):
 *
 * - `text`      — never upload: the reference stays readable text (`🖼 alt · path`).
 * - `workspace` — upload only files inside the session's own workspace (default).
 * - `any`       — upload any readable media path, including outside the workspace.
 *
 * Images become card pictures, MP4/H.264 video becomes a card `video` element
 * (QuickTime is remuxed first), and audio becomes an inline `<audio>` player
 * (Opus only, so other containers are transcoded when ffmpeg is available).
 * `text` is the most conservative and `any` the most permissive; the
 * neutralization that keeps Feishu from rejecting the card is NOT optional, so
 * there is no "off".
 */
export type CardImageMode = 'text' | 'workspace' | 'any'

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
  /** How media (image / video / audio) referenced in card text is handled; see {@link CardImageMode}. */
  cardImages?: CardImageMode
  /** Most media (image / video / audio) one card may inline; see {@link CARD_MEDIA_LIMIT}. */
  cardMediaLimit?: number
}

/**
 * Bounds of the `cardMediaLimit` setting.
 *
 * Feishu's own ceiling is far above this — a card holds 200 elements or
 * components, and a `video` carrying `cover` + `fallback` spends three of them,
 * so it accepts 66 videos (measured 2026-09-24; 67 are refused with `300305`).
 * The setting exists because a message with thirty players is unreadable, not
 * because the platform would refuse it: 30 videos cost 90 counted elements plus
 * the text segments around them, still well inside the 200-element budget.
 */
export const CARD_MEDIA_LIMIT = { min: 1, max: 30, default: 12 } as const

/** Clamp a user-supplied per-card media limit into {@link CARD_MEDIA_LIMIT}. */
export function clampCardMediaLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CARD_MEDIA_LIMIT.default
  return Math.min(CARD_MEDIA_LIMIT.max, Math.max(CARD_MEDIA_LIMIT.min, Math.trunc(value)))
}

/**
 * The live configuration the Cordis loader hands to `apply()` (DSH 0.1.7+).
 *
 * Every field is a `Volatile` reference: a settings write is committed into
 * the running reference instead of remounting the plugin, so `get()` is the
 * only way to read the value that is in force right now. A plain object is
 * still accepted — see {@link ConfigInput} — which keeps unit tests (and any
 * host that passes resolved values directly) working unchanged.
 */
export type LiveConfig = { readonly [K in keyof Config]-?: Volatile<Config[K]> }

/** Either shape a host may hand to `apply()`. */
export type ConfigInput = LiveConfig | Config

/**
 * Read one configuration field.
 *
 * DSH declares every editable field `.volatile()` so a write updates the
 * reference in place; anything else (a plain value, or the `undefined` of an
 * absent field) is returned as it is. Duck-typing `get` instead of importing
 * the reference protocol keeps this working for both shapes.
 */
export function readField<T>(field: Volatile<T> | T | undefined): T | undefined {
  if (field !== null && typeof field === 'object' && typeof (field as Volatile<T>).get === 'function') {
    return (field as Volatile<T>).get() as unknown as T
  }
  return field as T | undefined
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
  /**
   * Image handling for card text. Optional in the type (like `locale`) because
   * callers may pass a partial config; {@link resolveSettingsConfig} always
   * fills it in, so a live read never sees `undefined`.
   */
  cardImages?: CardImageMode
  /** Most media one card may inline (images, video and audio share the number). */
  cardMediaLimit?: number
}

export interface RuntimeConfig extends Omit<SettingsConfig, 'appSecretRef'> {
  appSecret: string
  appSecretRef: string
}

/**
 * Every field is `.volatile()`: DSH 0.1.7 refuses to write a field that is not
 * volatile, and a volatile field is committed into the running Config
 * reference — which is exactly the contract this plugin had under
 * `settings.register(..., { applies: 'live' })`: a settings write takes effect
 * without remounting the plugin, and `currentSettings()` re-reads it.
 */
export const ConfigSchema = z.object({
  appId: z.string().default('').volatile().description('Feishu/Lark application ID'),
  appSecret: z.string().role('secret').volatile().description('Legacy literal application secret'),
  appSecretRef: z.string().role('credential-ref').default(LARK_APP_SECRET_REF).volatile().description('Harness credential reference for the application secret'),
  domain: z.union(['feishu', 'lark']).default('feishu').volatile(),
  requireMention: z.boolean().default(true).volatile(),
  dmMode: z.union(['open', 'allowlist', 'disabled']).default('open').volatile(),
  groupAllowlist: z.array(z.string()).default([]).volatile(),
  dmAllowlist: z.array(z.string()).default([]).volatile(),
  provider: z.string().volatile(),
  model: z.string().volatile(),
  workspace: z.string().volatile(),
  agentPreset: z.string().volatile(),
  errorMessage: z.string().default(DEFAULT_ERROR_MESSAGE).volatile(),
  reactEmoji: z.string().default(DEFAULT_REACTION_EMOJI).volatile().description('Emoji reaction added to each inbound message; empty string disables it'),
  showReasoning: z.boolean().default(true).volatile().description('Show model reasoning/thinking content in tool call cards and final reply'),
  showToolCalls: z.boolean().default(true).volatile().description('Show tool calls on step cards; when false a tool-only step sends no card'),
  showToolArgs: z.boolean().default(true).volatile().description('Show each tool call\'s arguments block'),
  showToolResults: z.boolean().default(true).volatile().description('Show each tool call\'s result preview'),
  locale: z.union(['auto', 'zh', 'en']).default('auto').volatile().description('Plugin language; auto follows the DSH browser-language preference'),
  cardImages: z.union(['text', 'workspace', 'any']).default('workspace').volatile().description('Media the model references in card text (image / video / audio): text leaves the path as readable text and never uploads, workspace uploads only files inside the session workspace, any uploads any readable media path'),
  cardMediaLimit: z.number().min(CARD_MEDIA_LIMIT.min).max(CARD_MEDIA_LIMIT.max).default(CARD_MEDIA_LIMIT.default).volatile().description('Most media (image / video / audio) one card may inline; anything past the limit stays readable text. Feishu itself allows about 66 videos per card.'),
})

export function resolveSettingsConfig(config: ConfigInput): SettingsConfig {
  const appSecretRef = readField(config.appSecretRef) ?? LARK_APP_SECRET_REF
  if (!CREDENTIAL_REF_PATTERN.test(appSecretRef)) throw new TypeError('appSecretRef must be a POSIX environment variable name')
  const errorMessage = readField(config.errorMessage) ?? DEFAULT_ERROR_MESSAGE
  if (errorMessage.length > 500) throw new TypeError('errorMessage must not exceed 500 characters')
  const appSecret = readField(config.appSecret)
  const provider = readField(config.provider)
  const model = readField(config.model)
  const workspace = readField(config.workspace)
  const agentPreset = readField(config.agentPreset)
  const locale = readField(config.locale)
  return {
    appId: readField(config.appId) ?? '',
    appSecretRef,
    domain: readField(config.domain) ?? 'feishu',
    requireMention: readField(config.requireMention) ?? true,
    dmMode: readField(config.dmMode) ?? 'open',
    groupAllowlist: [...(readField(config.groupAllowlist) ?? [])],
    dmAllowlist: [...(readField(config.dmAllowlist) ?? [])],
    errorMessage,
    reactEmoji: readField(config.reactEmoji) ?? DEFAULT_REACTION_EMOJI,
    showReasoning: readField(config.showReasoning) ?? true,
    showToolCalls: readField(config.showToolCalls) ?? true,
    showToolArgs: readField(config.showToolArgs) ?? true,
    showToolResults: readField(config.showToolResults) ?? true,
    cardImages: readField(config.cardImages) ?? 'workspace',
    // Clamped rather than trusted: `ConfigInput` also admits a plain object, so
    // a value that never went through the schema must not reach the hydrator.
    cardMediaLimit: clampCardMediaLimit(readField(config.cardMediaLimit)),
    ...(appSecret === undefined ? {} : { appSecret }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(locale === undefined ? {} : { locale }),
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
export function resolveConfig(config: ConfigInput): RuntimeConfig {
  const settings = resolveSettingsConfig(config)
  return resolveRuntimeConfig(settings, settings.appSecret)
}
