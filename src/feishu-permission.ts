/**
 * Interactive Permission picker card for the `/permission` Feishu command.
 *
 * DSH's Web UI exposes the per-session permission mode through the
 * `permission-presets` picker decorating the `/permission` command. This
 * module renders the Feishu equivalent: a card showing the current mode with
 * one button per selectable preset. Clicking a button switches the session
 * through DSH's `permissionPresets.set()` write path — it records the
 * `permission/preset` intent and writes BOTH the `sandbox/mode` and
 * `approval/policy` knobs, so the session's effective bundle keeps matching a
 * real preset instead of degrading to "custom" — and updates the card in place
 * so the active mode is re-marked.
 *
 * ## Where the selectable list comes from
 *
 * `permissionPresets.catalog()` is the process catalog DSH's own UI renders:
 * the configured presets in table order, followed by `auto` while the
 * experimental auto-review integration is live. The picker therefore renders
 * whatever the Host advertises instead of a hardcoded three-button table: a
 * deployment without the auto-review plugin gets exactly the buttons it always
 * had, and one with it gets the extra "Auto review" entry — including the
 * human gate the Web UI puts in front of it, because Auto runs without a
 * sandbox and is experimental. Selecting `auto` first repaints the card as a
 * risk confirmation (the card is clicked by a human, so this is the Feishu
 * counterpart of the Web UI's confirm dialog); only the confirm button writes
 * the preset. DSH itself refuses the switch when the integration is no longer
 * live, and that refusal is shown on the card like any other failed write.
 *
 * The cardAction dispatcher is shared via the plugin's `cardChannel` adapter,
 * which rebinds handlers across channel reconnects; button clicks therefore
 * keep working even after a channel swap.
 *
 * @module @starxer/chatterbox4dsh/feishu-permission
 */

import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import { decodeCardValue } from './card-action.ts'

/** DSH file-sandbox / permission preset vocabulary (mirrors `dsh-sandbox-policy`). */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** Canonical id of DSH's experimental Auto review preset (`permission-presets`). */
export const AUTO_PRESET = 'auto'

/** Action value of the confirm card's cancel button (not a preset id). */
export const PERMISSION_CANCEL = 'cancel'

/** User-facing labels matching the DSH WebUI `ui-permission-presets` plugin. */
export const PERMISSION_LABELS: Record<string, string> = {
  'read-only': 'Read Only',
  'workspace-write': 'Workspace Write',
  'danger-full-access': 'Full access',
  auto: 'Auto review',
}

const MODE_ICON: Record<string, string> = {
  'read-only': '📖',
  'workspace-write': '✍️',
  'danger-full-access': '🔓',
  auto: '🧪',
}

/** One selectable entry from the Host's process catalog (`permissionPresets.catalog()`). */
export interface PermissionCatalogOption {
  /** Preset id: a configured preset key or the reserved `auto`. */
  value?: unknown
  /** Host-supplied display name (raw key when the preset has none). */
  name?: unknown
  /** One user-facing sentence, when the preset configures one. */
  description?: unknown
}

/** Locale-aware label for a preset (falls back to the id). */
export function permissionModeLabel(mode: string, t: Translations): string {
  switch (mode) {
    case 'read-only': return t.permissionReadOnly
    case 'workspace-write': return t.permissionWorkspaceWrite
    case 'danger-full-access': return t.permissionFullAccess
    case AUTO_PRESET: return t.permissionAuto
    default: return mode
  }
}

/** Icon for a preset id; empty when the id is not one the plugin knows. */
export function permissionModeIcon(mode: string): string {
  return MODE_ICON[mode] ?? ''
}

/**
 * The selectable preset ids, in Host order.
 *
 * Reads the process catalog so a plugin composition that adds presets (the
 * auto-review bundle adds `auto`) is reflected here with no code change. A
 * composition without the catalog — or a catalog read that throws — falls back
 * to the three shipped presets, i.e. exactly the pre-Auto behaviour.
 * @param presets - the narrow `permissionPresets` service, when present.
 * @returns the selectable ids in catalog order.
 */
export function availablePermissionModes(presets: PermissionCatalogSource | undefined): readonly string[] {
  try {
    const options = presets?.catalog?.()?.options
    if (Array.isArray(options)) {
      const values = options
        .map(option => option?.value)
        .filter((value): value is string => typeof value === 'string' && value !== '')
      if (values.length > 0) return values
    }
  } catch {
    // A catalog read is a UI nicety: never let it break the picker.
  }
  return SANDBOX_MODES
}

/** Anything that can answer the process catalog; the picker only needs this. */
export interface PermissionCatalogSource {
  catalog?: PermissionPresets['catalog']
}

/** Locate a catalog entry by preset id. */
function catalogOptionOf(presets: PermissionPresets | undefined, value: string): PermissionCatalogOption | undefined {
  try {
    return presets?.catalog?.()?.options?.find(option => option?.value === value)
  } catch {
    return undefined
  }
}

/** Display name for a preset the plugin's own dictionary does not translate. */
function permissionDisplayName(mode: string, t: Translations, presets: PermissionPresets | undefined): string {
  const known = permissionModeLabel(mode, t)
  if (known !== mode) return known
  const name = catalogOptionOf(presets, mode)?.name
  return typeof name === 'string' && name !== '' ? name : mode
}

/** Narrow card-action event surface the picker consumes. */
export interface PermissionCardEvent {
  messageId?: string
  chatId?: string
  action?: { value?: unknown }
}

/** The shared cardChannel's minimal surface (send / update / subscribe). */
export interface PermissionCardChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  onCardAction(handler: (evt: PermissionCardEvent) => void | Promise<void>): () => void
}

/** Narrow live-session surface the picker switches on. */
export interface PermissionSession {
  append(type: string, data: object): void
}

/**
 * Narrow DSH `permissionPresets` service surface. A preset bundles BOTH the
 * sandbox mode and the approval policy; using the service's `set()` write path
 * keeps both knobs (plus the `permission/preset` intent event) consistent so
 * DSH recognizes the mode as a real preset instead of "custom". Without it the
 * picker falls back to appending only the `sandbox/mode` knob, which DSH can
 * never match against a preset.
 */
export interface PermissionPresets {
  /** The effective preset name for the session (`read-only` /
   *  `workspace-write` / `danger-full-access` / `auto` / `custom`). */
  current(session: PermissionSession): string
  /** Switch the session to a preset, writing every changed knob. */
  set(session: PermissionSession, name: string): void
  /**
   * The process-level catalog of selectable presets. Optional so the picker
   * still works against a Host that predates the remote read; absent means
   * "the three shipped presets", i.e. no Auto option.
   */
  catalog?(): { options?: readonly PermissionCatalogOption[]; defaultOptions?: readonly PermissionCatalogOption[]; defaultPreset?: string } | undefined
}

/** Narrow `ctx.sandboxPolicy` surface used to read the effective mode. */
export interface PermissionSandbox {
  resolve?(req: { session?: PermissionSession }): { mode: string; workspaceRoot?: string }
}

export interface FeishuPermissionDeps {
  channel: PermissionCardChannel
  sandbox: PermissionSandbox | undefined
  /** DSH `permissionPresets` service; preferred for both the read and the write
   *  path (it keeps the sandbox + approval bundle in sync). */
  permissionPresets?: PermissionPresets | undefined
  sessionGetter: (id: string) => PermissionSession | undefined
  logger: { warn(message: string): unknown; error(message: string): unknown }
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
}

export interface FeishuPermissionHandle {
  /** Send the interactive picker card for one chat/session and remember it so
   *  button clicks can switch the session. Returns the sent message id. */
  open(chat: ConversationMessage, sessionId: string): Promise<string | undefined>
  stop(): void
}

/** Extra rendering inputs for {@link renderPermissionCard}. */
export interface PermissionCardOptions {
  /** Selectable preset ids in display order; defaults to {@link SANDBOX_MODES}. */
  modes?: readonly string[]
  /** The Host service, used only to name presets this plugin does not translate. */
  presets?: PermissionPresets | undefined
}

/** Render the permission picker card with the active mode marked.
 *  @param failure - already-localized failure text (see
 *  {@link describePermissionSwitchFailure}); when present it is shown as a
 *  warning line so a click that did not take effect says why.
 *  @param options - the catalog-derived preset list and its display names.
 *  Rendering stays identical to the pre-Auto card while the catalog lists only
 *  the three shipped presets. */
export function renderPermissionCard(
  current: string,
  t: Translations,
  failure?: string,
  options: PermissionCardOptions = {},
): object {
  const modes = options.modes ?? SANDBOX_MODES
  const elements: object[] = [
    { tag: 'markdown', content: `${t.permissionCurrent(current)} ${permissionDisplayName(current, t, options.presets)} ${MODE_ICON[current] ?? ''}` },
    { tag: 'markdown', content: t.permissionHint },
  ]
  if (failure !== undefined && failure !== '') elements.push({ tag: 'markdown', content: failure })
  // Explain the experimental preset — but only while the Host actually offers
  // it. A composition without the auto-review plugin must look exactly as it
  // did before this option existed.
  if (modes.includes(AUTO_PRESET)) elements.push({ tag: 'markdown', content: t.permissionAutoHint })
  for (const mode of modes) {
    const active = mode === current
    // Color language: keep every selectable button clearly clickable. "Full
    // access" and the experimental "Auto review" preset BOTH run without a
    // sandbox (Auto's fixed bundle is Full access + the ask approval policy),
    // so they share the red danger tint; Read Only and Workspace Write share
    // the blue primary so none of them look like the grayed-out (disabled)
    // current-mode button. The current mode is the ONE disabled + gray + ✓
    // button, so it is never confusable with Read Only.
    const type = mode === 'danger-full-access' || mode === AUTO_PRESET ? 'danger' : 'primary'
    const badge = mode === AUTO_PRESET ? ` ${t.permissionAutoBadge}` : ''
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `${active ? '✓ ' : ''}${permissionDisplayName(mode, t, options.presets)}${badge}` },
      type,
      value: JSON.stringify({ p: 'permission', mode }),
      ...(active ? { disabled: true } : {}),
    })
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.permissionTitle }, template: 'turquoise' },
    body: { elements },
  }
}

/**
 * The risk confirmation Feishu shows before switching to Auto.
 *
 * Auto review runs without a sandbox, so the Web UI gates the selection behind
 * a confirmation dialog. The card is the Feishu equivalent: nothing is written
 * until the operator taps the confirm button, and cancelling repaints the
 * original picker unchanged.
 * @param t - strings for the active locale.
 * @returns the confirmation card JSON.
 */
export function renderPermissionAutoConfirmCard(t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.permissionAutoConfirmTitle }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: t.permissionAutoConfirmBody },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t.permissionAutoConfirmEnable },
          type: 'danger',
          value: JSON.stringify({ p: 'permission', mode: AUTO_PRESET, confirm: true }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t.permissionAutoCancel },
          type: 'default',
          value: JSON.stringify({ p: 'permission', mode: PERMISSION_CANCEL }),
        },
      ],
    },
  }
}

/**
 * Explain a failed permission switch in the active locale.
 *
 * The switch is a normal DSH write (`permissionPresets.set()`) whose failure
 * is a legitimate refusal, not a plugin fault — DSH's persistent-shell fence
 * rejects a sandbox-mode change while a PTY owned by the session is live, and
 * the permission service refuses `auto` once its integration has unloaded.
 * Those messages are precise but bare and English, so add the one sentence
 * that makes the shell refusal actionable when that is what fired.
 * @param error - whatever the write path threw.
 * @param t - strings for the active locale.
 * @returns the warning line to show on the card (or as command error text).
 */
export function describePermissionSwitchFailure(error: unknown, t: Translations): string {
  const reason = error instanceof Error ? error.message : String(error)
  // Match on DSH's wording, which is the only signal available to a caller;
  // if upstream rewords it the hint is merely dropped, never wrong.
  const busyShell = /persistent terminal/i.test(reason)
  return `${t.permissionSwitchFailed(reason)}${busyShell ? `\n${t.permissionSwitchBusyShellHint}` : ''}`
}

/** Start the permission picker: send cards on demand and handle button clicks. */
export function startFeishuPermission(deps: FeishuPermissionDeps): FeishuPermissionHandle {
  const { channel, sandbox, permissionPresets, sessionGetter, logger, getTranslations } = deps
  const byCard = new Map<string, { sessionId: string }>()

  /** Current catalog-derived preset ids for this render. */
  const modes = (): readonly string[] => availablePermissionModes(permissionPresets)

  /** Read the effective mode, never letting a read failure mask the switch. */
  const currentModeOf = (session: PermissionSession): string => {
    try {
      return permissionPresets?.current(session) ?? sandbox?.resolve?.({ session })?.mode ?? ''
    } catch (error: unknown) {
      logger.warn(`dsh-feishu: permission read failed: ${error instanceof Error ? error.message : String(error)}`)
      try {
        return sandbox?.resolve?.({ session })?.mode ?? ''
      } catch {
        return ''
      }
    }
  }

  /** Write one preset, containing the legitimate refusals (`undefined` = success). */
  const applyMode = (session: PermissionSession, mode: string): string | undefined => {
    // Switch through DSH's preset write path when available: a preset bundles
    // the sandbox mode AND the approval policy, so writing only the sandbox
    // knob leaves the bundle unmatched and DSH reports it as "custom". Fall
    // back to the single-knob `sandbox/mode` append when the service is absent.
    //
    // The write can legitimately refuse (DSH's persistent-shell fence for a
    // sandbox-mode change, and `auto` once its integration is unloaded), so
    // contain it and say why on the card: an exception escaping here used to
    // become an `unhandledRejection`, which DSH escalates to `fatal load
    // failure` + exit(1).
    try {
      if (permissionPresets !== undefined) {
        permissionPresets.set(session, mode)
      } else {
        session.append('sandbox/mode', { mode })
      }
      return undefined
    } catch (error: unknown) {
      logger.warn(`dsh-feishu: permission switch failed: ${error instanceof Error ? error.message : String(error)}`)
      return describePermissionSwitchFailure(error, getTranslations())
    }
  }

  /** Repaint one card, logging (never throwing) when the patch fails. */
  const repaint = async (messageId: string, card: object): Promise<void> => {
    await channel.updateCard(messageId, card).catch((error: unknown) => {
      logger.warn(`dsh-feishu: permission card update failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const paintPicker = (messageId: string, session: PermissionSession, failure?: string): Promise<void> => {
    const current = currentModeOf(session)
    return repaint(messageId, renderPermissionCard(
      current,
      getTranslations(),
      failure,
      { modes: modes(), ...(permissionPresets === undefined ? {} : { presets: permissionPresets }) },
    ))
  }

  const onCardAction = async (evt: PermissionCardEvent): Promise<void> => {
    const messageId = evt.messageId
    if (messageId === undefined) return
    const rec = byCard.get(messageId)
    if (rec === undefined) return
    // `action.value` is double-encoded (see card-action.ts); unwrap it.
    const parsed = decodeCardValue(evt.action?.value)
    if (parsed === undefined) return
    if (parsed.p !== 'permission' || typeof parsed.mode !== 'string') return
    const session = sessionGetter(rec.sessionId)
    if (session === undefined) return

    // Cancel: repaint the picker exactly as it was, writing nothing.
    if (parsed.mode === PERMISSION_CANCEL) {
      await paintPicker(messageId, session)
      return
    }

    // The confirm button of the Auto risk card: the ONLY write path into Auto.
    if (parsed.confirm === true) {
      if (parsed.mode !== AUTO_PRESET) return
      const failure = applyMode(session, AUTO_PRESET)
      await paintPicker(messageId, session, failure)
      return
    }

    // An unknown id means a stale card (the catalog changed since it was
    // painted): ignore rather than switching the session to a phantom preset.
    if (!modes().includes(parsed.mode)) return

    // Auto is gated behind the confirmation card, mirroring the Web UI dialog.
    if (parsed.mode === AUTO_PRESET) {
      await repaint(messageId, renderPermissionAutoConfirmCard(getTranslations()))
      return
    }

    const failure = applyMode(session, parsed.mode)
    // Prefer the effective preset name now that the write landed; fall back to
    // the clicked id when the read fails (a broken read must not hide the click).
    await paintPicker(messageId, session, failure)
  }
  const unsubscribe = channel.onCardAction(onCardAction)

  const open = async (chat: ConversationMessage, sessionId: string): Promise<string | undefined> => {
    const session = sessionGetter(sessionId)
    if (session === undefined) throw new Error(getTranslations().permissionNoSession)
    const current = currentModeOf(session)
    const opts = chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {}
    const card = renderPermissionCard(current, getTranslations(), undefined, {
      modes: modes(),
      ...(permissionPresets === undefined ? {} : { presets: permissionPresets }),
    })
    const result = await channel.send(chat.chatId, { card }, opts)
    const messageId = (result as { messageId?: string })?.messageId
    if (messageId !== undefined) byCard.set(messageId, { sessionId })
    return messageId
  }

  const stop = (): void => {
    unsubscribe()
    byCard.clear()
  }

  return { open, stop }
}
