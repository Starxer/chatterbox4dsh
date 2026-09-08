/**
 * "This card is stale" marker for interactive card flows.
 *
 * Feishu stops delivering button callbacks on a message's card after only a
 * couple of in-place edits, so every interactive flow here posts a NEW card per
 * step instead of editing the previous one (see AGENTS.md 关键坑 11). The old
 * cards stay in the chat — the operator prefers that to a recalled card — but
 * they keep showing live-looking buttons that no longer lead anywhere.
 *
 * This module replaces such a superseded card with a short localized notice
 * pointing at the newest card. It is deliberately best-effort: failing to
 * repaint the old card must never break the flow that already succeeded.
 *
 * @module @starxer/chatterbox4dsh/card-supersede
 */

import type { Translations } from './i18n.ts'

/** Minimal logger surface. */
interface PluginLogger {
  warn(message: string): unknown
}

/** Channel surface needed to repaint a card that was already sent. */
export interface SupersedeChannel {
  /**
   * Repaint a CardKit card instance (cardkit.v1.card.update). Preferred, and
   * the only path that works for cards sent by reference.
   */
  updateCardInstance?(cardId: string, card: object, sequence: number): Promise<void>
  /** Fallback for inline-card messages: `im.v1.message.patch` by message id. */
  updateCard?(messageId: string, card: object): Promise<void>
}

/** Identity of a card that was posted to a chat. */
export interface CardRef {
  cardId: string
  messageId?: string | undefined
}

/** The card shown in place of a superseded one. No buttons: an abandoned card
 *  must not keep accepting taps. */
export function renderSupersededCard(t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.cardSupersededTitle },
      template: 'grey',
    },
    body: {
      elements: [{ tag: 'markdown', content: t.cardSupersededBody }],
    },
  }
}

export interface CardSupersederDeps {
  channel: SupersedeChannel
  logger: PluginLogger
  /** Strings for the ACTIVE locale, read at repaint time. */
  getTranslations: () => Translations
  /**
   * Monotonic sequence per card instance (CardKit requires it). Shared with the
   * caller so an in-place update and a later supersede notice never reuse a
   * number — a lower sequence is rejected by Feishu.
   */
  sequenceByCard: Map<string, number>
}

export interface CardSuperseder {
  /** Remember the card most recently posted in this chat. */
  note(chatId: string, ref: CardRef): void
  /**
   * Repaint the previously noted card for this chat as a stale-card notice.
   *
   * Call it AFTER the new card has been posted so the user never sees a gap,
   * and BEFORE {@link note}-ing the new card.
   */
  supersedePrevious(chatId: string): Promise<void>
  /** Drop the remembered card without repainting it (terminal result cards
   *  such as "session created" stay readable). */
  forget(chatId: string): void
  /** Drop every remembered card (dispose). */
  clear(): void
}

export function createCardSuperseder(deps: CardSupersederDeps): CardSuperseder {
  const lastByChat = new Map<string, CardRef>()
  return {
    note: (chatId, ref) => {
      lastByChat.set(chatId, ref)
    },
    forget: (chatId) => {
      lastByChat.delete(chatId)
    },
    clear: () => {
      lastByChat.clear()
    },
    supersedePrevious: async (chatId) => {
      const previous = lastByChat.get(chatId)
      if (previous === undefined) return
      lastByChat.delete(chatId)
      const card = renderSupersededCard(deps.getTranslations())
      try {
        if (deps.channel.updateCardInstance !== undefined) {
          const sequence = (deps.sequenceByCard.get(previous.cardId) ?? 0) + 1
          deps.sequenceByCard.set(previous.cardId, sequence)
          await deps.channel.updateCardInstance(previous.cardId, card, sequence)
          return
        }
        if (previous.messageId !== undefined && deps.channel.updateCard !== undefined) {
          await deps.channel.updateCard(previous.messageId, card)
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        deps.logger.warn(`dsh-feishu: could not mark card ${previous.cardId} as superseded: ${msg}`)
      }
    },
  }
}
