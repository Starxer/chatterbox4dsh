/**
 * Ordering barrier for cards posted to one chat.
 *
 * A step card is the context for whatever its own step posts next — the
 * question / approval card raised by the step's tool call, an overflow
 * "continued" card, or the Turn Complete footer. Those come from other modules
 * and would otherwise overtake the step card, which may still be inside its
 * coalescing window or still have its message in flight. The step card must
 * land first.
 *
 * The first implementation of this guarantee had two flaws, both of which
 * turned one chat's bad luck into a silent, process-wide regression (observed
 * 2026-09-09, and again 2026-09-21 after a wedged send):
 *
 * - the re-entrancy guard was a single global counter, incremented before
 *   awaiting the flush and decremented in a `finally`. A flush that never
 *   settled left the counter at 1 forever, and every later send in EVERY chat
 *   then skipped its step-card flush — the ordering guarantee was gone with no
 *   error anywhere. The guard is per chat instead.
 * - the flush wait was unbounded, so the `finally` above could not run at all.
 *   The wait is bounded now: giving up costs card order, never the card.
 *
 * Both properties are covered by `tests/card-send-barrier.spec.ts`.
 *
 * @module @starxer/chatterbox4dsh/card-send-barrier
 */

import { describeError, withTimeout } from './outbound-timeout.ts'

/** Dependencies for {@link createCardSendBarrier}. */
export interface CardSendBarrierDeps {
  /** How long a card may wait for the step card that logically precedes it. */
  timeoutMs: number
  /** Called when that wait is given up; the send then proceeds anyway. */
  onTimeout?: (reason: string) => void
}

/** The barrier itself. */
export interface CardSendBarrier {
  /**
   * Post a card, first letting `flush` put any debounced step card for that
   * chat on screen.
   *
   * `flush` is skipped while another send for the SAME chat is inside it (the
   * step card's own fallback send goes through the same channel and must not
   * wait on the flush that is producing it). `send` always runs.
   */
  run<T>(
    chatId: string,
    flush: ((chatId: string) => Promise<void>) | undefined,
    send: () => Promise<T>,
  ): Promise<T>
}

export const createCardSendBarrier = (deps: CardSendBarrierDeps): CardSendBarrier => {
  /** Chats whose step-card flush is currently running. */
  const flushing = new Set<string>()

  return {
    async run<T>(
      chatId: string,
      flush: ((chatId: string) => Promise<void>) | undefined,
      send: () => Promise<T>,
    ): Promise<T> {
      if (flush !== undefined && !flushing.has(chatId)) {
        flushing.add(chatId)
        try {
          await withTimeout(flush(chatId), 'step-card flush before send', deps.timeoutMs)
        } catch (error: unknown) {
          // Ordering is best-effort: a failed or stuck flush must not block the
          // card the user is actually waiting for.
          deps.onTimeout?.(describeError(error))
        } finally {
          flushing.delete(chatId)
        }
      }
      return send()
    },
  }
}
