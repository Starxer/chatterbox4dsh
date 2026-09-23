/**
 * Card-write safety net for Feishu (key pitfall 39).
 *
 * Two facts shape this module, both verified against the live API on
 * 2026-09-23:
 *
 * 1. Feishu rejects the WHOLE card when its markdown carries an image reference
 *    that is not an uploaded `img_v3_…` key (`200570`, wrapped as `230099
 *    Failed to create card content`). `card-markdown.ts` neutralizes those
 *    before writing; the retry here is for whatever that did not anticipate —
 *    a rejected card must never turn into a lost answer.
 * 2. CardKit requires a monotonically increasing `sequence` per card instance,
 *    while a retry repeats a write the caller already counted. The floor kept
 *    here raises the number instead of reusing it, so a retry cannot collide
 *    with the caller's own counter.
 *
 * @module @starxer/chatterbox4dsh/card-write
 */

import { isCardContentRejection, neutralizeCard } from './card-markdown.ts'

/** Default number of card instances whose bookkeeping is kept. */
export const CARD_WRITE_TRACKED = 512

export interface CardWriteDeps {
  /** Only `warn` is used — the retry itself is reported on stdout. */
  logger: { warn(message: string): unknown }
  /** Cap on the per-card bookkeeping maps. */
  tracked?: number
}

export interface CardWriter {
  /**
   * Write a card, neutralizing image references first and retrying once with
   * EVERY image reference stripped if Feishu still refuses the payload.
   * Non-content failures (transport, auth, rate limit) are not retried.
   */
  write<T>(card: object, write: (card: object) => Promise<T>): Promise<T>
  /** Monotonic CardKit `sequence` for one card instance. */
  nextSequence(cardId: string, requested: number): number
  /** Record which message renders a card instance (for the patch fallback). */
  noteCardMessage(cardId: string, messageId: string | undefined): void
  /** The message rendering that card instance, when it is known. */
  messageIdFor(cardId: string): string | undefined
}

/**
 * Create the writer used by the channel adapter. One instance per plugin: the
 * sequence floors must be shared by every caller that updates the same card.
 *
 * @param deps - logger plus an optional bookkeeping cap.
 */
export function createCardWriter(deps: CardWriteDeps): CardWriter {
  const tracked = deps.tracked ?? CARD_WRITE_TRACKED
  const sequenceFloor = new Map<string, number>()
  const messageIdByCard = new Map<string, string>()

  /** Drop the oldest entry once a map is over its cap (insertion order). */
  const bound = (map: Map<string, unknown>): void => {
    while (map.size > tracked) {
      const oldest = map.keys().next().value
      if (oldest === undefined) return
      map.delete(oldest)
    }
  }

  return {
    async write<T>(card: object, write: (card: object) => Promise<T>): Promise<T> {
      try {
        return await write(neutralizeCard(card))
      } catch (error: unknown) {
        if (!isCardContentRejection(error)) throw error
        const reason = error instanceof Error ? error.message : String(error)
        console.log(`dsh-feishu: [card] Feishu rejected the payload (${reason})`
          + ' — retrying with every image reference stripped')
        try {
          return await write(neutralizeCard(card, { aggressive: true }))
        } catch (retryError: unknown) {
          const retryReason = retryError instanceof Error ? retryError.message : String(retryError)
          deps.logger.warn(`dsh-feishu: card rejected even after stripping image references: ${retryReason}`)
          throw retryError
        }
      }
    },
    nextSequence(cardId: string, requested: number): number {
      const next = Math.max(requested, (sequenceFloor.get(cardId) ?? 0) + 1)
      sequenceFloor.set(cardId, next)
      bound(sequenceFloor)
      return next
    },
    noteCardMessage(cardId: string, messageId: string | undefined): void {
      if (messageId === undefined || messageId === '') return
      messageIdByCard.set(cardId, messageId)
      bound(messageIdByCard)
    },
    messageIdFor(cardId: string): string | undefined {
      return messageIdByCard.get(cardId)
    },
  }
}

/** The slice of a LarkChannel this wrapper needs. */
export interface CardSendChannel {
  send(
    to: string,
    input: { card: object } | { text: string },
    opts?: { replyInThread?: boolean; replyTo?: string },
  ): Promise<{ messageId?: string }>
}

/**
 * Wrap a channel so EVERY card it posts goes through the writer.
 *
 * `channel.ts` (the reply/footer/overflow cards — the path that carries the
 * answer) talks to the SDK channel directly, so the adapter's protection never
 * sees those cards. Wrapping the channel itself covers both the direct sends and
 * the adapter without asking either of them to remember.
 *
 * @param channel - the channel to wrap; every other member is passed through.
 * @param writer - shared writer, so the sequence floors stay in one place.
 * @returns a channel with the same surface and card-safe `send`.
 */
export function withCardSafety<T extends CardSendChannel>(channel: T, writer: CardWriter): T {
  return new Proxy(channel, {
    get(target, property, receiver) {
      if (property !== 'send') return Reflect.get(target, property, receiver)
      return (
        to: string,
        input: { card: object } | { text: string },
        opts?: { replyInThread?: boolean; replyTo?: string },
      ): Promise<{ messageId?: string }> => {
        if (!('card' in input)) return target.send(to, input, opts)
        return writer.write(input.card, card => target.send(to, { card }, opts))
      }
    },
  })
}
