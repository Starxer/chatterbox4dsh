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

/**
 * Families of NON-HUMAN messages DSH lets begin a Turn.
 *
 * The list is the DSH Web UI's own switch (`ui-chat/src/client/chat/turn-trigger.ts`),
 * so the chat and the GUI name the same event the same way: `tool-jobs` (background
 * job settled), `schedule` (an automation / timed reminder), `subagent-settled`,
 * `agent-message`, `team-message`, `goal`, `webhook` (with a GitHub flavour),
 * `cordis-host-runner` (a plugin), and `request` as the generic fallback for any
 * other non-human source. The host-side wakers are the `followup()` call sites:
 * `jobs/tool-jobs`, `schedule/schedule/src/runtime.ts`, `subagent/subagent`,
 * `webhook/webhook/src/session.ts` and `goal/goal-round-driver`.
 */
export type AutoTurnTrigger =
  | 'job'
  | 'schedule'
  | 'subagent'
  | 'agent'
  | 'team'
  | 'goal'
  | 'webhook'
  | 'github'
  | 'plugin'
  | 'request'

/**
 * Classify one message source into a trigger family.
 * @param source - a `user/message` source.
 * @returns the family, or `undefined` for a human message (`kind: 'user'`).
 */
export function autoTurnTrigger(source: { kind?: unknown; provider?: unknown } | undefined): AutoTurnTrigger | undefined {
  const kind = source?.kind
  if (typeof kind !== 'string' || kind === 'user') return undefined
  switch (kind) {
    case 'tool-jobs': return 'job'
    case 'schedule': return 'schedule'
    case 'subagent-settled': return 'subagent'
    case 'agent-message': return 'agent'
    case 'team-message': return 'team'
    case 'goal': return 'goal'
    case 'webhook': return source?.provider === 'github' ? 'github' : 'webhook'
    case 'cordis-host-runner': return 'plugin'
    default:
      // Any other non-human source still woke the turn: name the family the way
      // the Web UI does, without pretending to know which producer it was.
      return 'request'
  }
}

/** Per-turn trigger attribution, folded from the messages the turn claimed. */
export interface TurnTriggerState {
  /** Family that opened the turn, once one is known. */
  trigger?: AutoTurnTrigger | undefined
  /** Whether a human message was claimed in this turn. */
  sawHuman: boolean
}

/**
 * Fold one message into a turn's trigger attribution.
 *
 * Two rules, both mirroring the Web UI: a human message owns the turn (so a
 * notice claimed later in the same turn is NOT its trigger), and a named family
 * is preferred over the generic `request` — a fresh session's first turn claims
 * its instruction injections before the notice that actually woke it.
 *
 * @param state - attribution so far.
 * @param source - the message's source.
 * @returns the next attribution (the same object when nothing changed).
 */
export function foldTurnTrigger(
  state: TurnTriggerState,
  source: { kind?: unknown; provider?: unknown } | undefined,
): TurnTriggerState {
  if (source?.kind === 'user') {
    if (state.sawHuman && state.trigger !== 'request') return state
    return { trigger: state.trigger === 'request' ? undefined : state.trigger, sawHuman: true }
  }
  if (state.sawHuman) return state
  const trigger = autoTurnTrigger(source)
  if (trigger === undefined) return state
  if (state.trigger === undefined || (state.trigger === 'request' && trigger !== 'request')) {
    return { ...state, trigger }
  }
  return state
}

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
/** Session → the facts of the turn that is running now. */
interface TurnFacts {
  /** Set by the turn's first human message. */
  origin?: TurnOrigin
  /** Which surface that message came from. */
  surface?: 'web' | 'other'
  /** Attribution folded from the turn's non-human messages. */
  trigger: TurnTriggerState
}
const turnOrigins = new Map<string, TurnFacts>()

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

/** The facts of the running turn, creating the (empty) entry on first use. */
function factsOf(sessionId: string): TurnFacts {
  let facts = turnOrigins.get(sessionId)
  if (facts === undefined) {
    facts = { trigger: { sawHuman: false } }
    turnOrigins.set(sessionId, facts)
  }
  return facts
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
  const facts = factsOf(sessionId)
  if (source === undefined || source.kind !== 'user') {
    // A non-human message: fold it into the turn's attribution. This is what
    // labels an automatically started turn (see `autoTurnTrigger`).
    facts.trigger = foldTurnTrigger(facts.trigger, source as { kind?: unknown; provider?: unknown })
    return 'host'
  }
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
  const web = typeof source.clientTimeZone === 'string' && source.clientTimeZone !== ''
  if (facts.origin === undefined) {
    facts.origin = fromFeishu ? 'feishu' : 'external'
    if (!fromFeishu) facts.surface = web ? 'web' : 'other'
  }
  facts.trigger = foldTurnTrigger(facts.trigger, source)
  if (fromFeishu) return 'feishu'
  return web ? 'external-web' : 'external-other'
}

/**
 * Which surface opened the running turn.
 * @param sessionId - session to read.
 * @returns `feishu`, `external`, or `undefined` for a turn no user message opened
 *   (a background-job wake-up or a schedule), which this plugin still completes.
 */
export function turnOrigin(sessionId: string): TurnOrigin | undefined {
  return turnOrigins.get(sessionId)?.origin
}

/**
 * Which surface a human message came from, when the turn has one.
 * @param sessionId - session to read.
 * @returns `web` (the browser sets `clientTimeZone`) or `other`.
 */
export function turnSurface(sessionId: string): 'web' | 'other' | undefined {
  return turnOrigins.get(sessionId)?.surface
}

/**
 * The family of non-human message that opened the running turn, if any.
 * @param sessionId - session to read.
 */
export function turnTrigger(sessionId: string): AutoTurnTrigger | undefined {
  return turnOrigins.get(sessionId)?.trigger.trigger
}

/** Drop every table. Tests call it so one case cannot leak into the next. */
export function resetTurnOrigins(): void {
  minted.clear()
  directPending.clear()
  turnOrigins.clear()
}
