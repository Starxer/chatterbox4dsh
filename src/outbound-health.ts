/**
 * Live health of the channel's OUTBOUND Feishu link.
 *
 * The channel's boot state is not health. `LarkRuntime` calls a channel
 * "connected" once the WebSocket handshake succeeds and never revisits that
 * verdict, so the Plugins detail page kept showing 已连接 through an outage in
 * which not one reply, card update or file could leave the machine
 * (2026-10-11, 16:48:29 → 16:56:50): the home gateway's transparent proxy
 * rejected every NEW TLS handshake to `open.feishu.cn` with
 * `SSL alert 112 (tlsv1 unrecognized name)` while the already-established
 * WebSocket — inbound — kept receiving events. Two directions, two different
 * fates, and only one of them was being watched.
 *
 * Outbound health is therefore read from the requests themselves. Every SDK
 * HTTP call the channel makes goes through the `HttpInstance` handed to
 * `createLarkChannel`, which is {@link wrapHttpInstance}'s proxy around the
 * SDK's own default instance: behaviour is unchanged, but each settled request
 * folds into one {@link OutboundHealth}.
 *
 * Three deliberate limits:
 *
 * 1. **Answered ≠ succeeded.** A rejection carrying `response` means the peer
 *    ANSWERED (a 400 over a bad card, a 429, an expired token) — the link is up
 *    and the plugin counts it as an answer. Only a rejection with no response
 *    at all (DNS, TLS, reset, refused) is a link failure. Without this split
 *    every rejected card would read as a broken connection.
 * 2. **A cancelled request is not a link fact.** Our own aborts produce
 *    `ERR_CANCELED`; they mean nothing about Feishu.
 * 3. **Unsettled requests are invisible here.** A socket that never answers
 *    leaves the request pending forever, so there is no outcome to record; the
 *    callers' own `withTimeout` bounds the wait (`src/outbound-timeout.ts`) but
 *    nothing reports that timeout. A request watchdog would close this, at the
 *    cost of mis-flagging a legitimately slow upload — see the module notes
 *    before adding one.
 *
 * The verdict changes only when a request settles, so an idle channel keeps its
 * last known verdict rather than inventing a fresh one. {@link
 * OutboundHealthSnapshot.observed} is what tells an untouched tracker ("nothing
 * has been asked yet") apart from a healthy one.
 *
 * @module @starxer/chatterbox4dsh/outbound-health
 */

import { errorText } from './error-text.ts'
import { truncateInline } from './text-chunk.ts'
import type { HttpInstance } from '@larksuiteoapi/node-sdk'

/**
 * Cap on a stored failure reason, in characters. The badge shows it beside a
 * live status, so a full OpenSSL dump (the 2026-10-11 failure carried the
 * routine, the file and the line) would bury the state it explains.
 */
export const OUTBOUND_REASON_CAP = 240

/** Axios/undici codes that mean "we aborted this", not "Feishu failed us". */
const CANCELLATION_CODES = new Set(['ERR_CANCELED'])

/** Whether the promise rejection means the peer ANSWERED the request. */
function answeredByPeer(error: unknown): boolean {
  const response = (error as { response?: unknown } | null | undefined)?.response
  return response !== undefined && response !== null
}

/** Whether this rejection is our own cancellation. */
function cancelled(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && CANCELLATION_CODES.has(code)
}

/**
 * What one settled outbound request says about the link.
 *
 * @param error - the rejected value from a request
 * @returns true when the link itself failed; false when the peer answered or
 *          the request was cancelled by us.
 */
export function isTransportFailure(error: unknown): boolean {
  if (cancelled(error)) return false
  return !answeredByPeer(error)
}

/** The outbound link as the status route reports it. */
export interface OutboundHealthSnapshot {
  /** `failing` from the first unanswered request until the next answer. */
  verdict: 'ok' | 'failing'
  /** Requests that settled at all — an untouched tracker reports 0. */
  observed: number
  /** Requests the peer answered, including API-level rejections. */
  answered: number
  /** Transport failures since the channel started. */
  failures: number
  /** Transport failures since the last answered request. */
  consecutiveFailures: number
  /** ms epoch of the most recent answered request. */
  lastAnsweredAt?: number
  /** ms epoch of the most recent transport failure. */
  lastFailureAt?: number
  /** Short reason from the most recent transport failure. */
  lastError?: string
}

/**
 * Accumulates the outbound link's recent history.
 *
 * Mutable and process-lifetime: the Web UI's status poll reads {@link snapshot}
 * while requests settle concurrently, so every method is synchronous and every
 * read returns a copy.
 */
export class OutboundHealth {
  private observed = 0
  private answered = 0
  private failures = 0
  private consecutive = 0
  private lastAnsweredAt: number | undefined
  private lastFailureAt: number | undefined
  private lastError: string | undefined

  /**
   * Record a request the peer answered, whatever its business outcome.
   * @param now - ms epoch of the answer; injectable for tests.
   */
  noteAnswered(now: number = Date.now()): void {
    this.observed += 1
    this.answered += 1
    this.consecutive = 0
    this.lastAnsweredAt = now
  }

  /**
   * Record a rejected request.
   *
   * The split lives here because it is the whole point of the module: a
   * rejection the peer answered (a 400 over a bad card, a 429) is an ANSWER —
   * the link works — while a rejection with nothing behind it is the link
   * failing. Our own cancellations are recorded as neither.
   *
   * @param error - the rejected value.
   * @param now - ms epoch of the failure; injectable for tests.
   */
  noteRejected(error: unknown, now: number = Date.now()): void {
    if (cancelled(error)) return
    if (!isTransportFailure(error)) {
      this.noteAnswered(now)
      return
    }
    this.observed += 1
    this.failures += 1
    this.consecutive += 1
    this.lastFailureAt = now
    const reason = errorText(error, '').trim()
    this.lastError = reason === '' ? undefined : truncateInline(reason, OUTBOUND_REASON_CAP)
  }

  /** @returns a copy of the current history, with the verdict derived from it. */
  snapshot(): OutboundHealthSnapshot {
    return {
      verdict: this.consecutive > 0 ? 'failing' : 'ok',
      observed: this.observed,
      answered: this.answered,
      failures: this.failures,
      consecutiveFailures: this.consecutive,
      ...this.lastAnsweredAt === undefined ? {} : { lastAnsweredAt: this.lastAnsweredAt },
      ...this.lastFailureAt === undefined ? {} : { lastFailureAt: this.lastFailureAt },
      ...this.lastError === undefined ? {} : { lastError: this.lastError },
    }
  }
}

/**
 * Wrap an `HttpInstance` so every settled request updates `health`.
 *
 * A Proxy rather than eight delegating methods: the SDK's interface can grow,
 * and a method we forgot to wrap would be a silent hole in the very
 * observation this module exists to provide. Non-function properties (axios
 * `defaults`, `interceptors`) are handed through untouched, and every call is
 * applied with the ORIGINAL instance as its receiver, so a wrapped axios
 * instance behaves exactly like itself.
 *
 * `inner` is deliberately typed `unknown`. The SDK declares `httpInstance?:
 * HttpInstance` while defaulting that same option to an axios `AxiosInstance`
 * (lib/index.js: `params.httpInstance || defaultHttpInstance`), and the two are
 * not structurally assignable — the axios `request` promises a wrapper object
 * that the SDK's own response interceptor has already unwrapped. The runtime
 * requirement is only that the value exposes the HTTP methods the SDK calls; it
 * calls nothing but `request` on it.
 *
 * @param inner - the instance the SDK would have used on its own.
 * @param health - the tracker to feed.
 * @returns an instance to hand to `createLarkChannel` as `httpInstance`.
 */
export function wrapHttpInstance(inner: unknown, health: OutboundHealth): HttpInstance {
  const record = <T>(call: () => Promise<T>): Promise<T> => {
    let pending: Promise<T>
    try {
      pending = call()
    } catch (error) {
      // A synchronous throw means the request never left; report it the same
      // way and keep the throw synchronous so callers see what they always saw.
      health.noteRejected(error)
      throw error
    }
    return pending.then(
      value => { health.noteAnswered(); return value },
      (error: unknown) => { health.noteRejected(error); throw error },
    )
  }
  return new Proxy(inner as HttpInstance, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => Promise<unknown>
      return (...args: unknown[]) => record(() => method.apply(target, args))
    },
  })
}
