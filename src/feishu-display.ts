/**
 * Interactive card-display switcher for the `/display` Feishu command.
 *
 * `/display` already has a text path (`/display <key> on|off`). This module
 * gives the no-argument form a card instead, so the four levels and four
 * switches (`showReasoning` / `showToolCalls` / `showToolArgs` /
 * `showToolResults`) can be flipped by tapping — no syntax to remember. It
 * writes exactly the same config fields the WebUI settings panel and the slash
 * command write, so all three surfaces always agree.
 *
 * **One card, updated in place** — the `/busy` and permission-card contract: the
 * card the operator is looking at IS the state, and every tap repaints THAT
 * message with the new state (`im.v1.message.patch` via `cardActions`'
 * `updateCard`). This replaced the older "post a new card, turn the old one into
 * a stale notice" flow on 2026-10-28, at the operator's request, so `/display`
 * behaves like the other setting cards instead of leaving a trail of `已失效`
 * cards behind it. Buttons carry the TARGET value rather than a "toggle" marker,
 * so a duplicated delivery of one click is idempotent.
 *
 * The known risk of in-place editing (关键坑 11: Feishu may stop delivering a
 * card's button callbacks after ~2-3 edits) is accepted rather than designed
 * around: `/busy`, the permission card and `/model` already live on in-place
 * updates, and this card's own edits only happen on a human tap. If its buttons
 * ever stop answering, `/display` posts a fresh card.
 *
 * @module @starxer/chatterbox4dsh/feishu-display
 */

import type { DisplayControl, DisplayToggleKey } from './commands.ts'
import {
  COMPACT_TOOL_ROW_STYLES, isCompactToolRowStyle, levelUsesSwitch, TRANSCRIPT_VIEWS,
  type CompactToolRowStyle, type TranscriptView,
} from './display-level.ts'
import type { DisplaySettings } from './display-level.ts'
import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import { decodeCardValue } from './card-action.ts'
import { ELAPSED_REFRESH_SECONDS, isElapsedRefreshSeconds, parseElapsedRefreshSeconds } from './config.ts'

/** The switches in card order (same order as the WebUI settings panel). */
export const DISPLAY_KEYS: readonly DisplayToggleKey[] = ['reasoning', 'tools', 'args', 'results']

/** Narrow card-action event surface the switcher consumes. */
export interface DisplayCardEvent {
  messageId?: string
  chatId?: string
  action?: { value?: unknown }
}

/** The shared cardChannel's minimal surface (send / card instances / subscribe). */
export interface DisplayCardChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  /** Repaint the SAME message in place (`im.v1.message.patch`), the `/busy` way. */
  updateCard(messageId: string, card: object): Promise<void>
  onCardAction(handler: (evt: DisplayCardEvent) => void | Promise<void>): () => void
}

export interface FeishuDisplayDeps {
  channel: DisplayCardChannel
  /** Read / write the same four config fields the WebUI panel uses. */
  display: DisplayControl
  logger: { warn(message: string): unknown; error(message: string): unknown }
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
}

export interface FeishuDisplayHandle {
  /**
   * Post the interactive switch card for one chat. Button clicks afterwards flip
   * a setting and repaint THAT message in place. Returns the sent message id.
   */
  open(chat: ConversationMessage): Promise<string | undefined>
  stop(): void
}

/** True when `value` is one of the four display switches. */
function isDisplayKey(value: unknown): value is DisplayToggleKey {
  return typeof value === 'string' && (DISPLAY_KEYS as readonly string[]).includes(value)
}

/** One render's inputs: the level's own state plus the four switches. */
export interface DisplayCardState {
  /** Card layout: one turn card (`compact`) or one card per step. */
  mode: 'compact' | 'detailed'
  /** Preset the current values match, or undefined ("自定义"). */
  preset: TranscriptView | undefined
  /** Effective settings (preset + explicit overrides). */
  settings: DisplaySettings
  /** The four legacy switches (now: reasoning / args / results / tools). */
  switches: Record<DisplayToggleKey, boolean>
  /** Whether the thinking block folds into a panel (default) or shows flat. */
  folded: boolean
  /** Live thinking preview switch. */
  preview: boolean
  /** Tool detail override (`auto` follows the preset). */
  toolDetail: 'auto' | 'off' | 'count' | 'summary' | 'full'
  /** Tool output truncation override (`auto` follows the preset). */
  outputChoice: 'auto' | 'cut' | 'full'
  /** What a compact turn card's tool row carries (compact-only section). */
  toolRow: CompactToolRowStyle
  /** Missing on older callers; rendered as the default five seconds. */
  elapsedRefreshSeconds?: number
}

/** True when `value` is one of the four levels. */
function isLevel(value: unknown): value is TranscriptView {
  return typeof value === 'string' && (TRANSCRIPT_VIEWS as readonly string[]).includes(value)
}

/**
 * Lay short choice buttons out in ONE card row.
 *
 * The same shape `feishu-onboarding.ts` / `feishu-deliver.ts` use for their
 * control rows: `width: 'auto'` columns hug the button, and `flex_mode:
 * 'stretch'` makes Feishu stack the row vertically on a narrow (mobile) screen
 * instead of clipping the labels. One `column_set` is one element, so a row of
 * four choices costs one element instead of four — the card used to be one
 * full-width button per choice, which made it unnecessarily tall (关键坑 58/63).
 */
function buttonColumns(buttons: readonly object[]): object {
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    horizontal_spacing: 'small',
    columns: buttons.map(button => ({
      tag: 'column',
      width: 'auto',
      vertical_align: 'top',
      elements: [button],
    })),
  }
}

/** Split choice buttons into rows of at most `size`, one element per row. */
function buttonRows(buttons: readonly object[], size = 2): object[] {
  const rows: object[] = []
  for (let index = 0; index < buttons.length; index += size) {
    rows.push(buttonColumns(buttons.slice(index, index + size)))
  }
  return rows
}

/**
 * Render the display card: the work-detail level, then (only at `compact`) the
 * tool-row style, then the switches the active level can still use, then the
 * elapsed-clock interval.
 *
 * Every choice is a button carrying the TARGET value (never a "toggle"), and
 * every tap repaints the SAME card, so a payload is idempotent under a
 * duplicated click. Choices are laid out in rows (`buttonColumns`) instead of
 * one full-width button per line, which is what makes the card fit a phone
 * without a long scroll.
 */
export function renderDisplayCard(state: DisplayCardState, t: Translations): object {
  const settings = state.settings
  const compact = state.mode === 'compact'
  const elements: object[] = [
    {
      tag: 'markdown',
      content: `${t.displayCardModeTitle}${t.displayModeName(state.mode)} · ${t.displayCardPresetTitle}${t.displayPresetName(state.preset)}`,
    },
  ]
  // Mode: two layouts. `compact` is the one that changes which cards exist.
  elements.push(buttonColumns((['compact', 'detailed'] as const).map(mode => {
    const active = mode === state.mode
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: t.displayCardLevelButton(t.displayModeName(mode), active) },
      type: active ? 'primary' : 'default',
      ...(active ? { disabled: true } : {}),
      behaviors: [{ type: 'callback', value: { p: 'display', preset: mode, row: 'mode' } }],
    }
  })))
  // Presets: named bundles of the switches below; a tap resets the overrides.
  elements.push(...buttonRows((['standard', 'detailed', 'verbose'] as const).map(preset => {
    const active = state.preset === preset
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: t.displayCardLevelButton(t.displayPresetName(preset), active) },
      type: active ? 'primary' : 'default',
      ...(active ? { disabled: true } : {}),
      behaviors: [{ type: 'callback', value: { p: 'display', preset, row: 'preset' } }],
    }
  })))
  elements.push({ tag: 'hr' })
  if (!compact) elements.push({ tag: 'markdown', content: `${t.displayCardThinkingTitle}\n${t.displayLevelHint(state.preset ?? 'detailed')}` })
  // Reasoning: content on/off, fold/flat, live preview on/off. Compact forces
  // reasoning off (its card carries the answer), so the switches are not offered
  // there — a toggle that cannot change anything reads as a broken card.
  if (!compact) elements.push(buttonColumns([
    {
      tag: 'button',
      text: { tag: 'plain_text', content: t.displayCardButton(t.displayCardLabel('reasoning'), settings.reasoning !== 'off') },
      type: settings.reasoning !== 'off' ? 'primary' : 'default',
      behaviors: [{ type: 'callback', value: { p: 'display', key: 'reasoning', value: settings.reasoning === 'off' } }],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: t.displayCardButton(t.displayCardFoldName(state.folded), true) },
      type: 'primary',
      behaviors: [{ type: 'callback', value: { p: 'display', folded: !state.folded } }],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: t.displayCardPreviewButton(t.displayPreviewName(state.preview), state.preview) },
      type: state.preview ? 'primary' : 'default',
      behaviors: [{ type: 'callback', value: { p: 'display', preview: !state.preview } }],
    },
  ]))
  if (!compact) elements.push({ tag: 'hr' })
  if (!compact) elements.push({ tag: 'markdown', content: t.displayCardToolDetailTitle })
  if (!compact) elements.push(buttonColumns((['off', 'count', 'summary', 'full'] as const).map(detail => {
    const active = state.toolDetail !== 'auto' ? state.toolDetail === detail : settings.tools === detail
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: t.displayCardFoldButton(t.displayToolDetailName(detail), active) },
      type: active ? 'primary' : 'default',
      ...(active ? { disabled: true } : {}),
      behaviors: [{ type: 'callback', value: { p: 'display', toolDetail: detail } }],
    }
  })))
  if (!compact) elements.push({ tag: 'markdown', content: t.displayCardOutputTitle })
  if (!compact) elements.push(buttonColumns((['auto', 'cut', 'full'] as const).map(choice => {
    const active = state.outputChoice === choice
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: t.displayCardFoldButton(t.displayOutputName(choice), active) },
      type: active ? 'primary' : 'default',
      ...(active ? { disabled: true } : {}),
      behaviors: [{ type: 'callback', value: { p: 'display', output: choice } }],
    }
  })))
  if (settings.tools === 'full') {
    elements.push(...buttonRows((['args', 'results'] as const).map(key => {
      const enabled = settings[key === 'args' ? 'toolArgs' : 'toolResults']
      return {
        tag: 'button',
        text: { tag: 'plain_text', content: t.displayCardButton(t.displayCardLabel(key), enabled) },
        type: enabled ? 'primary' : 'default',
        behaviors: [{ type: 'callback', value: { p: 'display', key, value: !enabled } }],
      }
    })))
  }
  if (compact) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `${t.displayCardToolRowTitle}\n${t.displayCardToolRowHint}` })
    elements.push(buttonColumns(COMPACT_TOOL_ROW_STYLES.map(style => {
      const active = style === state.toolRow
      return {
        tag: 'button',
        text: { tag: 'plain_text', content: t.displayCardToolRowButton(t.displayToolRowName(style), active) },
        type: active ? 'primary' : 'default',
        ...(active ? { disabled: true } : {}),
        behaviors: [{ type: 'callback', value: { p: 'display', toolRow: style } }],
      }
    })))
  }
  elements.push({ tag: 'hr' })
  elements.push({ tag: 'markdown', content: `${t.displayCardTickTitle}\n${t.displayCardTickHint}` })
  const currentTick = parseElapsedRefreshSeconds(state.elapsedRefreshSeconds)
  elements.push(buttonColumns(ELAPSED_REFRESH_SECONDS.map(seconds => {
    const active = seconds === currentTick
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: t.displayCardTickButton(seconds, active) },
      type: active ? 'primary' : 'default',
      ...(active ? { disabled: true } : {}),
      behaviors: [{ type: 'callback', value: { p: 'display', tick: seconds } }],
    }
  })))
  elements.push({ tag: 'markdown', content: t.displayCardNote, text_size: 'notation' })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.displayCardTitle }, template: 'turquoise' },
    body: { elements },
  }
}

/**
 * Start the display switcher: post the card on demand, then repaint it in place.
 *
 * The card is NOT remembered per message: a click is handled by the payload it
 * carries, and the repaint targets the very message the click came from. That
 * also means a card posted before a plugin restart keeps working after it — its
 * payload is enough to write the setting, and the message id is enough to
 * repaint it.
 */
export function startFeishuDisplay(deps: FeishuDisplayDeps): FeishuDisplayHandle {
  const { channel, display, logger, getTranslations } = deps
  /** Set by {@link stop}: a click already queued must not write settings. */
  let stopped = false

  /** Send opts that land in the chat's topic when it has one. */
  const topicOpts = (chat: ConversationMessage): { replyInThread?: boolean; replyTo?: string } =>
    chat.threadId !== undefined && chat.rootId !== undefined
      ? { replyInThread: true, replyTo: chat.rootId }
      : {}

  /** The card as the CURRENT settings read right now. */
  const currentCard = (): object => {
    const settings = display.getSettings()
    return renderDisplayCard({
      mode: settings.mode,
      preset: display.getPreset(),
      settings,
      switches: display.get(),
      folded: settings.reasoningFold,
      preview: settings.reasoningPreview,
      toolDetail: display.getToolDetail(),
      outputChoice: display.getOutputChoice(),
      toolRow: display.getToolRow(),
      elapsedRefreshSeconds: display.getElapsedRefreshSeconds(),
    }, getTranslations())
  }

  /**
   * Repaint the clicked card from the persisted settings — in place, the way
   * `/busy` and the permission card do it. The write has already landed (the
   * caller awaits it), so this render carries the new state; a failed repaint
   * leaves the previous render on screen, which is honest about the write that
   * DID succeed.
   */
  const repaint = async (messageId: string): Promise<void> => {
    try {
      await channel.updateCard(messageId, currentCard())
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: display card refresh failed: ${msg}`)
    }
  }

  const onCardAction = async (evt: DisplayCardEvent): Promise<void> => {
    if (stopped) return
    const messageId = evt.messageId
    if (messageId === undefined) return
    // Embedded cards double-encode `action.value`; CardKit `behaviors` deliver
    // a plain object. `decodeCardValue` accepts either.
    const parsed = decodeCardValue(evt.action?.value)
    if (parsed === undefined || parsed.p !== 'display') return
    // The settings write commits asynchronously (the scope's snapshot is only
    // replaced after it persists), so it MUST be awaited before re-reading —
    // otherwise the repaint renders the OLD state.
    //
    // Past this point the payload is ours, so a rejection is worth a log line:
    // a silently ignored click is exactly how this card first failed.
    if (parsed.tick !== undefined) {
      if (!isElapsedRefreshSeconds(parsed.tick)) return
      try {
        await display.setElapsedRefreshSeconds(parsed.tick)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display refresh interval write failed: ${msg}`)
      }
      await repaint(messageId)
      return
    }
    if (typeof parsed.preview === 'boolean') {
      try {
        await display.setPreview(parsed.preview)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display preview write failed: ${msg}`)
      }
      await repaint(messageId)
      console.log(`dsh-feishu: [display] preview=${String(parsed.preview)} card=${messageId}`)
      return
    }
    if (typeof parsed.folded === 'boolean') {
      try {
        await display.setFold(parsed.folded)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display fold write failed: ${msg}`)
      }
      await repaint(messageId)
      console.log(`dsh-feishu: [display] folded=${String(parsed.folded)} card=${messageId}`)
      return
    }
    const toolRow = parsed.toolRow
    if (isCompactToolRowStyle(toolRow)) {
      try {
        await display.setToolRow(toolRow)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display tool-row write failed: ${msg}`)
      }
      await repaint(messageId)
      console.log(`dsh-feishu: [display] toolRow=${toolRow} card=${messageId}`)
      return
    }
    const preset = parsed.preset
    if (isLevel(preset)) {
      try {
        await display.applyPreset(preset)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display preset write failed: ${msg}`)
      }
      await repaint(messageId)
      console.log(`dsh-feishu: [display] preset=${preset} card=${messageId}`)
      return
    }
    const toolDetail = parsed.toolDetail
    if (toolDetail === 'off' || toolDetail === 'count' || toolDetail === 'summary' || toolDetail === 'full') {
      try {
        await display.setToolDetail(toolDetail)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display tool-detail write failed: ${msg}`)
      }
      await repaint(messageId)
      console.log(`dsh-feishu: [display] toolDetail=${toolDetail} card=${messageId}`)
      return
    }
    const output = parsed.output
    if (output === 'auto' || output === 'cut' || output === 'full') {
      try {
        await display.setOutputChoice(output)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display output write failed: ${msg}`)
      }
      await repaint(messageId)
      console.log(`dsh-feishu: [display] output=${output} card=${messageId}`)
      return
    }
    if (!isDisplayKey(parsed.key) || typeof parsed.value !== 'boolean') {
      console.log(`dsh-feishu: [display] ignored malformed action key=${String(parsed.key)} level=${String(parsed.level)}`)
      return
    }
    try {
      await display.set(parsed.key, parsed.value)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: display switch write failed: ${msg}`)
    }
    await repaint(messageId)
    console.log(`dsh-feishu: [display] ${parsed.key}=${String(parsed.value)} card=${messageId}`)
  }
  const unsubscribe = channel.onCardAction(onCardAction)

  const open = async (chat: ConversationMessage): Promise<string | undefined> => {
    const result = await channel.send(chat.chatId, { card: currentCard() }, topicOpts(chat))
    return result.messageId
  }

  const stop = (): void => {
    stopped = true
    unsubscribe()
  }

  return { open, stop }
}
