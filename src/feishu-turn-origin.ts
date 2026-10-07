/**
 * Which surface started the turn an event belongs to.
 *
 * This plugin is a Feishu surface, but a session bound to a Feishu chat can also
 * be driven by the Web GUI, by a background-job wake-up, or by a schedule. DSH
 * has no client-identity field on a prompt (`SessionPromptRequest` carries only
 * `requestId`, `mode`, `content` and an optional `clientTimeZone`), so the
 * origin is read from the native `user/message` source instead:
 *
 * - this plugin mints the `requestId` it hands to `sessionController.prompt()`,
 *   and the session controller writes it verbatim into `source.rpcId`
 *   (`session-controller/src/commands.ts`) — so a message whose `rpcId` is one
 *   of OURS was dispatched on Feishu's behalf;
 * - a direct `agent.steer` / `agent.followup` (the image / file messages, which
 *   deliberately bypass `sessionController.prompt`) carries no `rpcId`, so that
 *   dispatch is remembered per session and consumed by the next message that
 *   actually HAS an attachment — a plain-text message from another surface in
 *   between cannot eat the marker;
 * - anything else with `kind: 'user'` came from another client (in this
 *   deployment: the Web GUI). `source.clientTimeZone` is set by the browser
 *   client and never by this plugin, so it only LABELS the message; it never
 *   decides the origin, because a client that cannot resolve its zone omits it.
 *
 * The origin is decided per TURN from that turn's first user message: a steering
 * message from the Web GUI must not relabel the Feishu turn that is already
 * running. Everything else this plugin renders from the session stream is
 * origin-independent, so nothing here changes how a Feishu-started turn behaves.
 *
 * @module @starxer/chatterbox4dsh/feishu-turn-origin
 */

/** Where one user message came from, as far as this plugin can tell. */
export type UserMessageOrigin = 'feishu' | 'external-web' | 'external-other' | 'host'

/** Which surface opened the turn currently running in a session. */
export type TurnOrigin = 'feishu' | 'external'

/** How long a request id this plugin minted is remembered (a turn is far shorter). */
const PROMPT_TTL_MS = 30 * 60_000
/** Hard cap on remembered request ids, so a long-lived process cannot grow. */
const PROMPT_MAX = 200
/** How long a direct `steer` / `followup` dispatch waits for its own message event. */
const DIRECT_TTL_MS = 2 * 60_000

interface MintedPrompt {
  sessionId: string
  at: number
}

/** `requestId` this plugin minted → the session it was dispatched for. */
const minted = new Map<string, MintedPrompt>()
/** Session → when this plugin pushed a message that bypasses `sessionController`. */
const directPending = new Map<string, number>()
/** Session → which surface opened the turn that is running now. */
const turnOrigins = new Map<string, TurnOrigin>()

function prune(now: number): void {
  for (const [id, record] of minted) {
    if (now - record.at > PROMPT_TTL_MS) minted.delete(id)
  }
  for (const [sessionId, at] of directPending) {
    if (now - at > DIRECT_TTL_MS) directPending.delete(sessionId)
  }
  while (minted.size > PROMPT_MAX) {
    const oldest = minted.keys().next().value
    if (oldest === undefined) return
    minted.delete(oldest)
  }
}

/**
 * Remember a prompt this plugin dispatched through `sessionController.prompt()`.
 * @param sessionId - session the prompt entered.
 * @param requestId - the id passed as `SessionPromptRequest.requestId`.
 * @param now - clock override for tests.
 */
export function noteFeishuPrompt(sessionId: string, requestId: string, now: number = Date.now()): void {
  if (sessionId === '' || requestId === '') return
  prune(now)
  minted.delete(requestId)
  minted.set(requestId, { sessionId, at: now })
}

/**
 * Remember a message this plugin pushed straight into the agent (no `rpcId`),
 * so the next message carrying an attachment is attributed to Feishu.
 * @param sessionId - session the message entered.
 * @param now - clock override for tests.
 */
export function noteDirectFeishuDispatch(sessionId: string, now: number = Date.now()): void {
  if (sessionId === '') return
  prune(now)
  directPending.set(sessionId, now)
}

/**
 * Open a new turn: the next user message decides where it came from.
 * @param sessionId - session whose turn started.
 */
export function beginTurn(sessionId: string): void {
  if (sessionId === '') return
  turnOrigins.delete(sessionId)
}

/**
 * Classify one `user/message` event and, when it is the turn's first, record
 * which surface opened the turn.
 *
 * @param sessionId - session that received the message.
 * @param source - the event's native `message.source`.
 * @param options - `hasAttachment` matters only for the direct-dispatch marker.
 * @param now - clock override for tests.
 * @returns where the message came from; `host` for DSH's own injections.
 */
export function noteUserMessage(
  sessionId: string,
  source: { kind?: unknown; rpcId?: unknown; clientTimeZone?: unknown } | undefined,
  options: { hasAttachment?: boolean } = {},
  now: number = Date.now(),
): UserMessageOrigin {
  if (source === undefined || source.kind !== 'user') return 'host'
  prune(now)
  const rpcId = typeof source.rpcId === 'string' ? source.rpcId : undefined
  let fromFeishu = rpcId !== undefined && minted.get(rpcId)?.sessionId === sessionId
  if (!fromFeishu && options.hasAttachment === true) {
    const dispatchedAt = directPending.get(sessionId)
    if (dispatchedAt !== undefined && now - dispatchedAt <= DIRECT_TTL_MS) {
      directPending.delete(sessionId)
      fromFeishu = true
    }
  }
  if (turnOrigins.get(sessionId) === undefined) {
    turnOrigins.set(sessionId, fromFeishu ? 'feishu' : 'external')
  }
  if (fromFeishu) return 'feishu'
  return typeof source.clientTimeZone === 'string' && source.clientTimeZone !== ''
    ? 'external-web'
    : 'external-other'
}

/**
 * Which surface opened the running turn.
 * @param sessionId - session to read.
 * @returns `feishu`, `external`, or `undefined` for a turn no user message opened
 *   (a background-job wake-up or a schedule), which this plugin still completes.
 */
export function turnOrigin(sessionId: string): TurnOrigin | undefined {
  return turnOrigins.get(sessionId)
}

/** Drop every table. Tests call it so one case cannot leak into the next. */
export function resetTurnOrigins(): void {
  minted.clear()
  directPending.clear()
  turnOrigins.clear()
}
