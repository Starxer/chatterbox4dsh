/**
 * Present one host interaction on two surfaces at once.
 *
 * `user-questions/request` and `approval/request` are Agent-scoped Cordis
 * waterfalls. The WebUI answerer is an *inner* listener installed by
 * `api-remotes`, which forwards the request to the browser and waits there;
 * the Feishu plugin prepends itself so it can also render a card. Only the
 * outer listener's return value settles the waterfall, so when Feishu answers
 * first the forwarded WebUI request is simply abandoned — and the browser has
 * no way to learn that, leaving a live-looking card behind.
 *
 * Two small pieces make "both surfaces, first answer wins" behave:
 *
 * - {@link installSignalGate} swaps the request's `signal` for one this module
 *   can abort. `api-gateway` ties a forwarded waterfall's lifetime to that
 *   signal and pushes a `cancel` frame to the browser when it aborts, which is
 *   what removes the WebUI card. The gate keeps following the caller's own
 *   signal so a turn abort still cancels both surfaces.
 * - {@link firstDefined} races the answerers and picks the first real answer,
 *   ignoring surfaces that merely gave up (no browser connected, the client
 *   delegated, the card failed to render).
 *
 * The gate mutates the caller-owned request object because DSH exposes no
 * other handle on a forwarded interaction. If a future DSH freezes the
 * request, `installSignalGate` degrades to "the WebUI card lingers until the
 * turn's own signal aborts" instead of breaking the interaction.
 *
 * @module @starxer/chatterbox4dsh/dual-answerer
 */

/** One surface's answer, tagged with where it came from. */
export interface AnswererResult<T, Via extends string> {
  via: Via
  value: T
}

/** Handle on the forwarded (WebUI) surface. */
export interface SignalGate {
  /**
   * Abort the forwarded surface so the browser dismisses its card. A no-op
   * once it is already aborted, so the answer and abort paths can race safely.
   */
  release(reason?: unknown): void
}

/**
 * Detach the forwarded interaction's lifetime from the caller's signal alone.
 *
 * @param request - The waterfall request whose `signal` the gateway reads.
 * @param upstream - The caller's own signal, if any.
 * @returns A gate whose {@link SignalGate.release} aborts the forwarded surface.
 */
export function installSignalGate(
  request: { signal?: AbortSignal },
  upstream: AbortSignal | undefined,
): SignalGate {
  const gate = new AbortController()
  const combined = upstream === undefined ? gate.signal : AbortSignal.any([upstream, gate.signal])
  try {
    Object.defineProperty(request, 'signal', {
      value: combined,
      writable: true,
      configurable: true,
      enumerable: true,
    })
  } catch {
    // A frozen request cannot be re-pointed; the caller's signal stays in
    // charge and only the "dismiss on Feishu answer" shortcut is lost.
  }
  return {
    release: (reason?: unknown): void => {
      if (!gate.signal.aborted) {
        gate.abort(reason ?? new Error('answered on the other surface'))
      }
    },
  }
}

/**
 * Resolve with the first candidate that produced a real answer.
 *
 * Candidates must map "this surface cannot answer" to `undefined` rather than
 * rejecting; a rejection is treated the same way. The promise resolves with
 * `undefined` only once every candidate has given up.
 *
 * @param candidates - One promise per surface, already normalized.
 * @returns The first defined answer, or `undefined` when none arrives.
 */
export function firstDefined<T>(
  candidates: readonly Promise<T | undefined>[],
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let remaining = candidates.length
    let settled = false
    if (remaining === 0) {
      resolve(undefined)
      return
    }
    const giveUp = (): void => {
      remaining -= 1
      if (!settled && remaining === 0) {
        settled = true
        resolve(undefined)
      }
    }
    for (const candidate of candidates) {
      candidate.then((value) => {
        if (settled) return
        if (value === undefined) {
          giveUp()
          return
        }
        settled = true
        resolve(value)
      }, giveUp)
    }
  })
}
