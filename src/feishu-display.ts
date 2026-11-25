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
  COMPACT_TOOL_ROW_STYLES, DISPLAY_MODES, isCompactToolRowStyle,
  type CompactToolRowStyle,
} from './display-level.ts'
import { PREVIEW_LENGTH_CHOICES, type DisplayMode, type DisplaySettings, type PreviewLengthField, type ToolDetail } from './display-level.ts'
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
  mode: DisplayMode
  /** Effective settings (mode + switches). */
  settings: DisplaySettings
  /** The four legacy switches (now: reasoning / args / results / tools). */
  switches: Record<DisplayToggleKey, boolean>
  /** Whether the thinking block folds into a panel (default) or shows flat. */
  folded: boolean
  /** Compact only: fold the turn card's earlier steps (default) or page every 10. */
  stepsFold: boolean
  /** What the tool section carries. */
  toolDetail: ToolDetail
  /** Whether tool payloads are carried untruncated. */
  outputFull: boolean
  /** Truncation lengths, in characters. */
  lengths: Record<PreviewLengthField, number>
  /** What a compact turn card's tool row carries (compact-only section). */
  toolRow: CompactToolRowStyle
  /** Missing on older callers; rendered as the default five seconds. */
  elapsedRefreshSeconds?: number
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
  const minimal = state.mode === 'minimal'
  /** A section heading plus the one line that explains what it controls. */
  const section = (title: string, hint: string): string => `${title}\n_${hint}_`
  /** A selectable option: `✓ ` marks the current value (blue, still clickable). */
  const choice = (name: string, active: boolean): string => t.displayCardChoice(name, active)
  /** One row of buttons; `payload` omits `p`, which every callback carries. */
  const row = (specs: Array<{ text: string; active: boolean; payload: object }>): object[] =>
    specs.map(spec => ({
      tag: 'button',
      text: { tag: 'plain_text', content: spec.text },
      type: spec.active ? 'primary' : 'default',
      behaviors: [{ type: 'callback', value: { p: 'display', ...spec.payload } }],
    }))

  const elements: object[] = [
    {
      tag: 'markdown',
      content: section(`${t.displayCardModeTitle}：${t.displayModeName(state.mode)}`, t.displayCardModeHint),
    },
  ]
  elements.push(buttonColumns(row(DISPLAY_MODES.map(mode => ({
    text: choice(t.displayModeName(mode), state.mode === mode),
    active: state.mode === mode,
    payload: { mode },
  })))))
  // Thinking is shown in BOTH modes (2026-11-25, the operator's request): under
  // `compact` each step's chain is a folded panel on the turn card, so the
  // display switch matters there too. The fold/flat choice stays a step-card
  // shape — compact always folds — hence its row is step-level only.
  if (!minimal) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: section(t.displayCardThinkingTitle, t.displayCardThinkingHint) })
    elements.push(buttonColumns(row([
      { text: choice(t.displayShow, settings.reasoning !== 'off'), active: settings.reasoning !== 'off', payload: { key: 'reasoning', value: true } },
      { text: choice(t.displayHide, settings.reasoning === 'off'), active: settings.reasoning === 'off', payload: { key: 'reasoning', value: false } },
    ])))
  }
  if (!compact && !minimal) {
    elements.push(buttonColumns(row([
      { text: choice(t.displayCardFoldName(true), state.folded), active: state.folded, payload: { folded: true } },
      { text: choice(t.displayCardFoldName(false), !state.folded), active: !state.folded, payload: { folded: false } },
    ])))
    // Compact keeps its tool activity on the turn card, so the tool-payload
    // switches below would change nothing there.
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: section(t.displayCardToolDetailTitle, t.displayCardToolDetailHint) })
    elements.push(buttonColumns(row((['off', 'summary', 'full'] as const).map(detail => ({
      text: choice(t.displayToolDetailName(detail), state.toolDetail === detail),
      active: state.toolDetail === detail,
      payload: { toolDetail: detail },
    })))))
    if (settings.tools === 'full') {
      elements.push({
        tag: 'markdown',
        content: `${t.displayCardLabel('args')}：${settings.toolArgs ? t.displayShow : t.displayHide}`
          + `　${t.displayCardLabel('results')}：${settings.toolResults ? t.displayShow : t.displayHide}`,
        text_size: 'notation',
      })
      elements.push(buttonColumns(row([
        { text: choice(`${t.displayCardLabel('args')}·${t.displayShow}`, settings.toolArgs), active: settings.toolArgs, payload: { key: 'args', value: true } },
        { text: choice(`${t.displayCardLabel('args')}·${t.displayHide}`, !settings.toolArgs), active: !settings.toolArgs, payload: { key: 'args', value: false } },
        { text: choice(`${t.displayCardLabel('results')}·${t.displayShow}`, settings.toolResults), active: settings.toolResults, payload: { key: 'results', value: true } },
        { text: choice(`${t.displayCardLabel('results')}·${t.displayHide}`, !settings.toolResults), active: !settings.toolResults, payload: { key: 'results', value: false } },
      ])))
    }
    elements.push({ tag: 'markdown', content: section(t.displayCardOutputTitle, t.displayCardOutputHint) })
    elements.push(buttonColumns(row(([false, true] as const).map(full => ({
      text: choice(t.displayOutputName(full), state.outputFull === full),
      active: state.outputFull === full,
      payload: { outputFull: full },
    })))))
  }
  // Truncation lengths: one row per field, the active choice marked.
  if (!minimal) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: section(t.displayCardLengthTitle, t.displayCardLengthHint) })
    for (const field of ['args', 'result'] as const) {
      elements.push({ tag: 'markdown', content: t.displayLengthName(field, state.lengths[field]), text_size: 'notation' })
      elements.push(buttonColumns(row(PREVIEW_LENGTH_CHOICES[field].map(chars => ({
        text: choice(String(chars), state.lengths[field] === chars),
        active: state.lengths[field] === chars,
        payload: { length: field, chars },
      })))))
    }
  }
  if (compact) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: section(t.displayCardToolRowTitle, t.displayCardToolRowHint) })
    elements.push(buttonColumns(row(COMPACT_TOOL_ROW_STYLES.map(style => ({
      text: choice(t.displayToolRowName(style), style === state.toolRow),
      active: style === state.toolRow,
      payload: { toolRow: style },
    })))))
    // What happens to a growing turn card's steps: fold the old ones away, or
    // page the card (nothing folds, a new card every 10 steps).
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: section(t.displayCardStepsFoldTitle, t.displayCardStepsFoldHint) })
    elements.push(buttonColumns(row(([true, false] as const).map(stepsFold => ({
      text: choice(t.displayCardStepsFoldName(stepsFold), state.stepsFold === stepsFold),
      active: state.stepsFold === stepsFold,
      payload: { stepsFold },
    })))))
  }
  elements.push({ tag: 'hr' })
  elements.push({ tag: 'markdown', content: section(t.displayCardTickTitle, t.displayCardTickHint) })
  const currentTick = parseElapsedRefreshSeconds(state.elapsedRefreshSeconds)
  elements.push(buttonColumns(row(ELAPSED_REFRESH_SECONDS.map(seconds => ({
    text: choice(`${seconds} ${t.displayCardTickUnit}`, seconds === currentTick),
    active: seconds === currentTick,
    payload: { tick: seconds },
  })))))
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
      settings,
      switches: display.get(),
      folded: settings.reasoningFold,
      stepsFold: display.getStepsFold(),
      toolDetail: display.getToolDetail(),
      outputFull: display.getOutputFull(),
      lengths: {
        args: display.getPreviewChars('args'),
        result: display.getPreviewChars('result'),
      },
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
      // The active choice is a STATE, not an action: re-clicking it is a no-op
      // (and each write is an HMR transaction, so refusing it is the cheap path).
      if (display.getElapsedRefreshSeconds() === parsed.tick) return
      try {
        await display.setElapsedRefreshSeconds(parsed.tick)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display refresh interval write failed: ${msg}`)
      }
      await repaint(messageId)
      return
    }
    if (typeof parsed.folded === 'boolean') {
      if (display.getFold() === parsed.folded) return
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
    if (typeof parsed.stepsFold === 'boolean') {
      if (display.getStepsFold() === parsed.stepsFold) return
      try {
        await display.setStepsFold(parsed.stepsFold)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display steps write failed: ${msg}`)
      }
      await repaint(messageId)
      console.log(`dsh-feishu: [display] stepsFold=${String(parsed.stepsFold)} card=${messageId}`)
      return
    }
    const toolRow = parsed.toolRow
    if (isCompactToolRowStyle(toolRow)) {
      if (display.getToolRow() === toolRow) return
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
    const mode = parsed.mode
    if (mode === 'minimal' || mode === 'compact' || mode === 'detailed') {
      if (display.getSettings().mode === mode) return
      try {
        await display.setLevel(mode)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display mode write failed: ${msg}`)
      }
      await repaint(messageId)
      console.log(`dsh-feishu: [display] mode=${mode} card=${messageId}`)
      return
    }
    const toolDetail = parsed.toolDetail
    if (toolDetail === 'off' || toolDetail === 'summary' || toolDetail === 'full') {
      if (display.getSettings().tools === toolDetail) return
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
    const outputFull = parsed.outputFull
    if (typeof outputFull === 'boolean') {
      if (display.getOutputFull() === outputFull) return
      try {
        await display.setOutputFull(outputFull)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display output write failed: ${msg}`)
      }
      await repaint(messageId)
      console.log(`dsh-feishu: [display] outputFull=${String(outputFull)} card=${messageId}`)
      return
    }
    const lengthField = parsed.length
    const lengthChars = parsed.chars
    if ((lengthField === 'args' || lengthField === 'result')
      && typeof lengthChars === 'number') {
      if (display.getPreviewChars(lengthField) === lengthChars) return
      try {
        await display.setPreviewChars(lengthField, lengthChars)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: display length write failed: ${msg}`)
      }
      await repaint(messageId)
      console.log(`dsh-feishu: [display] length=${lengthField}:${lengthChars} card=${messageId}`)
      return
    }
    if (!isDisplayKey(parsed.key) || typeof parsed.value !== 'boolean') {
      console.log(`dsh-feishu: [display] ignored malformed action key=${String(parsed.key)}`)
      return
    }
    if (display.get()[parsed.key] === parsed.value) return
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
