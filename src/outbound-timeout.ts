/**
 * Bounded waits for outbound Feishu calls.
 *
 * The Lark Node SDK builds its HTTP client with `timeout: 0`, so a request the
 * peer never answers — a half-open TLS socket behind a proxy, observed
 * 2026-09-21 — leaves its promise pending FOREVER. Anything that awaits such a
 * promise waits forever too: the per-chat step-card send chain, the Turn
 * Complete footer, the reply handler. One hung request therefore silenced a
 * whole Feishu topic while the Web UI kept showing the answers (key pitfall 29).
 *
 * Every outbound call we own must be bounded. A timeout is NOT a cancellation:
 * the request may still complete server-side, so callers must treat a timeout
 * as "outcome unknown" rather than "did not happen", and must never blindly
 * retry a send.
 *
 * @module @starxer/chatterbox4dsh/outbound-timeout
 */

/**
 * How long one outbound Feishu call may stay unresolved before it counts as
 * failed. Generous on purpose: it exists to break a permanent hang, not to
 * enforce a latency budget.
 */
export const OUTBOUND_TIMEOUT_MS = 20_000

/**
 * Told when a bounded wait around a call that LEAVES THE MACHINE gives up.
 *
 * This is the only place a hang is visible. A request the peer never answers
 * leaves its promise pending forever, so a tracker of request outcomes
 * (`src/outbound-health.ts`) sees nothing at all — no rejection, no answer, no
 * fact — and would keep reporting a healthy link while nothing is delivered.
 * The bounded wait around the request is what notices, and it notices with the
 * budget the CALL SITE chose for that kind of request (20s for a send, 120s for
 * a file), which is exactly why the threshold is not guessed here.
 *
 * Waiting on our own pipeline (a card chain flushing, a previous card settling)
 * says nothing about Feishu, so those waits stay out of this channel — see
 * {@link withLinkTimeout}.
 */
export interface OutboundWaitObserver {
  /**
   * @param what - the label the call site gave the wait.
   * @param ms - the budget it gave up after.
   */
  abandoned(what: string, ms: number): void
}

/** One plugin instance per process owns this; the last install wins. */
let waitObserver: OutboundWaitObserver | undefined

/**
 * Install (or clear) the abandoned-wait observer.
 * @param next - the observer, or undefined to detach it.
 */
export function observeOutboundWaits(next: OutboundWaitObserver | undefined): void {
  waitObserver = next
}

/** Message extraction that never throws on exotic thrown values. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Resolve with `promise`, but reject if it has not settled within `ms`.
 *
 * The underlying request keeps running; this only stops the caller waiting.
 *
 * @param link - true when the awaited call leaves the machine, so that giving up
 *               is reported through {@link observeOutboundWaits}. Keep it false
 *               for waits on our own pipeline.
 */
export const withTimeout = <T>(
  promise: Promise<T>,
  what: string,
  ms: number = OUTBOUND_TIMEOUT_MS,
  link = false,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (link) {
        // Reporting is best-effort: if the observer throws, the wait must STILL
        // end. Letting it escape here would leave this promise pending forever,
        // which is the very failure this module exists to prevent.
        try {
          waitObserver?.abandoned(what, ms)
        } catch {
          // Swallowed on purpose; the observer is the plugin's own tracker.
        }
      }
      reject(new Error(`dsh-feishu: ${what} timed out after ${ms}ms`))
    }, ms)
  })
  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * {@link withTimeout} for a call that leaves the machine — a Feishu request.
 *
 * Giving up on one of these is a fact about the link: the reply the user is
 * waiting for did not arrive inside the budget this call site knows is
 * reasonable for this kind of request. Reporting it is what closes the last way
 * the connection indicator could stay green while nothing at all was delivered
 * (key pitfall 29's silent hang; TODO O26).
 */
export const withLinkTimeout = <T>(
  promise: Promise<T>,
  what: string,
  ms: number = OUTBOUND_TIMEOUT_MS,
): Promise<T> => withTimeout(promise, what, ms, true)

/**
 * Like {@link withTimeout}, but resolves `undefined` instead of rejecting, and
 * reports the reason through `onTimeout`.
 *
 * Used where carrying on beats failing: a chained send that waited too long for
 * its predecessor should still be attempted.
 */
export const settleWithin = <T>(
  promise: Promise<T>,
  what: string,
  ms: number,
  onTimeout?: (reason: string) => void,
): Promise<T | undefined> =>
  withTimeout(promise, what, ms).catch((error: unknown) => {
    onTimeout?.(describeError(error))
    return undefined
  })
