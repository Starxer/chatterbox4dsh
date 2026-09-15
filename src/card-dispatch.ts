/**
 * Fan-out for inbound Feishu card actions.
 *
 * Every interactive module (`feishu-permission`, `feishu-session`,
 * `feishu-display`, the `/new` wizard, question/approval cards) registers its
 * click handler through the shared `channel.onCardAction()` set, and the
 * channel dispatches one tap to all of them. Card handlers run straight off
 * the Lark WebSocket callback: nothing awaits them and nothing owns their
 * failure, so a rejected handler promise becomes an `unhandledRejection`.
 *
 * DSH treats an unhandled rejection as fatal — `installFailLoud` (boot) prints
 * `fatal load failure: …` and calls `process.exit(1)`. A card handler that
 * throws can therefore kill the whole dsh service, taking every running turn
 * with it. This actually happened (2026-09-14): `/permission` → Full access
 * tripped DSH's sandbox-mode fence ("cannot change sandbox mode while
 * persistent terminal sessions are open"), the throw escaped an `async`
 * handler, and dsh exited with status 1.
 *
 * Dispatch every handler with per-handler containment and report the failure
 * to the caller instead; a button tap may fail, but it must never be able to
 * stop the daemon.
 *
 * @module @starxer/chatterbox4dsh/card-dispatch
 */

/** A card-action handler: synchronous, or asynchronous with its own errors. */
export type CardActionHandler<Event> = (evt: Event) => void | Promise<void>

/**
 * Invoke every handler for one card action, containing each handler's failure.
 *
 * Handlers are called in iteration order and independently: one failing handler
 * never skips the remaining handlers. Both failure shapes are contained — a
 * rejected promise from an `async` handler and a synchronous `throw`.
 *
 * @param handlers - every handler currently registered for card actions.
 * @param evt - the decoded card-action event to fan out.
 * @param onError - sink for one handler's failure; called at most once per
 *   handler. It must not throw (a throw here escapes dispatch entirely).
 */
export function dispatchCardAction<Event>(
  handlers: Iterable<CardActionHandler<Event>>,
  evt: Event,
  onError: (error: unknown) => void,
): void {
  for (const handler of handlers) {
    try {
      // `Promise.resolve(...)` normalizes both shapes into one rejection path
      // without changing how a plain synchronous handler runs.
      void Promise.resolve(handler(evt)).catch(onError)
    } catch (error: unknown) {
      onError(error)
    }
  }
}
