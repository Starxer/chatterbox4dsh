/**
 * Interactive card-display switcher for the `/display` Feishu command.
 *
 * `/display` already has a text path (`/display <key> on|off`). This module
 * gives the no-argument form a card instead, so the four switches
 * (`showReasoning` / `showToolCalls` / `showToolArgs` / `showToolResults`) can
 * be flipped by tapping — no syntax to remember. It writes exactly the same
 * config fields the WebUI settings panel and the slash command write, so all
 * three surfaces always agree.
 *
 * Every tap posts a NEW card and repaints the previous one as a stale-card
 * notice. That is deliberate: Feishu stops delivering button callbacks on a
 * message's card after only ~2-3 in-place edits — true for
 * `im.v1.message.patch` and `cardkit.v1.card.update` alike (see AGENTS.md
 * 关键坑 11) — and this card invites four taps in a row. Buttons carry the
 * TARGET value rather than a "toggle" marker, so a duplicated delivery of one
 * click is idempotent.
 *
 * @module @starxer/chatterbox4dsh/feishu-display
 */

import type { DisplayControl, DisplayToggleKey } from './commands.ts'
import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import { decodeCardValue } from './card-action.ts'
import { createCardSuperseder } from './card-supersede.ts'

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
  createCardInstance(card: object): Promise<string>
  sendCardByReference(to: string, cardId: string, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCardInstance?(cardId: string, card: object, sequence: number): Promise<void>
  updateCard?(messageId: string, card: object): Promise<void>
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
   * Send the interactive switch card for one chat and remember it so button
   * clicks can flip a switch and post the refreshed card. Returns the sent
   * message id.
   */
  open(chat: ConversationMessage): Promise<string | undefined>
  stop(): void
}

/** True when `value` is one of the four display switches. */
function isDisplayKey(value: unknown): value is DisplayToggleKey {
  return typeof value === 'string' && (DISPLAY_KEYS as readonly string[]).includes(value)
}

/** Render the switch card with every switch's current state marked. */
export function renderDisplayCard(state: Record<DisplayToggleKey, boolean>, t: Translations): object {
  const elements: object[] = [{ tag: 'markdown', content: t.displayCardHint }]
  for (const key of DISPLAY_KEYS) {
    // Arguments and results only describe tool calls, so with tool display off
    // they have nothing to act on. Hide their switches rather than offer a
    // toggle that cannot change anything; the stored values are left untouched
    // and the switches come back with tool display.
    if (!state.tools && (key === 'args' || key === 'results')) continue
    const enabled = state[key]
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t.displayCardButton(t.displayCardLabel(key), enabled) },
      // Primary = on, default (grey) = off, so the state reads at a glance.
      type: enabled ? 'primary' : 'default',
      // A CardKit card instance — this card is sent by reference — only honours
      // `behaviors`; a top-level `value` is silently dropped and the click does
      // nothing. Embedded cards accept either form, so `behaviors` is the safe
      // one for both (same as `feishu-session.ts` / `feishu-onboarding.ts`).
      //
      // The payload carries the TARGET value, not a "toggle" marker, so a
      // re-delivered click cannot flip the switch twice.
      behaviors: [{ type: 'callback', value: { p: 'display', key, value: !enabled } }],
    })
  }
  // Say why two switches are missing, so the card does not just look broken.
  if (!state.tools) {
    elements.push({ tag: 'markdown', content: t.displayCardHiddenByTools, text_size: 'notation' })
  }
  elements.push({ tag: 'markdown', content: t.displayCardNote, text_size: 'notation' })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.displayCardTitle }, template: 'turquoise' },
    body: { elements },
  }
}

/** Start the display switcher: post cards on demand and handle button clicks. */
export function startFeishuDisplay(deps: FeishuDisplayDeps): FeishuDisplayHandle {
  const { channel, display, logger, getTranslations } = deps
  /** Topic coordinates per card message, so a refreshed card stays in-topic
   *  (cardAction events carry no thread information). */
  const byCard = new Map<string, ConversationMessage>()
  /** Shared with the superseder so a stale repaint never reuses a sequence. */
  const sequenceByCard = new Map<string, number>()
  const superseder = createCardSuperseder({ channel, logger, getTranslations, sequenceByCard })

  /** Send opts that land in the chat's topic when it has one. */
  const topicOpts = (chat: ConversationMessage): { replyInThread?: boolean; replyTo?: string } =>
    chat.threadId !== undefined && chat.rootId !== undefined
      ? { replyInThread: true, replyTo: chat.rootId }
      : {}

  /**
   * Post the card as a NEW message, retire the previous one, and remember the
   * new coordinates. Returns the new message id.
   *
   * @param supersededMessageId - the card the user just clicked; dropped from
   *   the lookup so a stale entry cannot be clicked again later.
   */
  const post = async (chat: ConversationMessage, supersededMessageId?: string): Promise<string | undefined> => {
    const card = renderDisplayCard(display.get(), getTranslations())
    const opts = topicOpts(chat)
    const cardId = await channel.createCardInstance(card)
    const result = await channel.sendCardByReference(chat.chatId, cardId, opts)
    // Repaint the previous card only AFTER the new one is on screen (no gap),
    // and before noting the new card — supersedePrevious consumes the note.
    await superseder.supersedePrevious(chat.chatId)
    superseder.note(chat.chatId, { cardId, messageId: result.messageId })
    if (supersededMessageId !== undefined) byCard.delete(supersededMessageId)
    if (result.messageId !== undefined) byCard.set(result.messageId, chat)
    return result.messageId
  }

  const onCardAction = async (evt: DisplayCardEvent): Promise<void> => {
    const messageId = evt.messageId
    if (messageId === undefined) return
    // Embedded cards double-encode `action.value`; CardKit `behaviors` deliver
    // a plain object. `decodeCardValue` accepts either.
    const parsed = decodeCardValue(evt.action?.value)
    if (parsed === undefined || parsed.p !== 'display') return
    // Past this point the payload is ours, so a rejection is worth a log line:
    // a silently ignored click is exactly how this card first failed.
    if (!isDisplayKey(parsed.key) || typeof parsed.value !== 'boolean') {
      console.log(`dsh-feishu: [display] ignored malformed action key=${String(parsed.key)} value=${String(parsed.value)}`)
      return
    }
    const chat = byCard.get(messageId)
    if (chat === undefined) {
      console.log(`dsh-feishu: [display] action for unknown card message=${messageId}`)
      return
    }
    // The settings write commits asynchronously (the scope's snapshot is only
    // replaced after it persists), so it MUST be awaited before re-reading —
    // otherwise the refreshed card repaints the OLD state.
    try {
      await display.set(parsed.key, parsed.value)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: display switch write failed: ${msg}`)
    }
    // Repaint either way: after a failed write the card honestly shows the
    // unchanged state instead of going silent.
    try {
      await post(chat, messageId)
      console.log(`dsh-feishu: [display] ${parsed.key}=${String(parsed.value)} card=${messageId}`)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: display card refresh failed: ${msg}`)
    }
  }
  const unsubscribe = channel.onCardAction(onCardAction)

  const open = async (chat: ConversationMessage): Promise<string | undefined> => post(chat)

  const stop = (): void => {
    unsubscribe()
    byCard.clear()
    superseder.clear()
  }

  return { open, stop }
}
