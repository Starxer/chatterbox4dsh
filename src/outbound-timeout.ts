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

/** Message extraction that never throws on exotic thrown values. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Resolve with `promise`, but reject if it has not settled within `ms`.
 *
 * The underlying request keeps running; this only stops the caller waiting.
 */
export const withTimeout = <T>(
  promise: Promise<T>,
  what: string,
  ms: number = OUTBOUND_TIMEOUT_MS,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`dsh-feishu: ${what} timed out after ${ms}ms`))
    }, ms)
  })
  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

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
