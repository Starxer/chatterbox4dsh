import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, expandAssistantStream, isTokenDelta, type ReasoningEffortId, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { conversationKey, parseChatKey, summarizeTurn, toSessionId } from './conversation.ts'
import type { ConversationMessage } from './conversation.ts'
import { collectCompletedTurns, type CompletedTurn, type TurnEventLike } from './turn-history.ts'
import { collectRecentRoutes, type RecentRoute, type RouteEntry } from './route-history.ts'
import { isRecentModelEntry, mergeRecentModels, rememberModel, topRecentModels, type ModelRoute, type RecentModelEntry } from './recent-models.ts'
import type { DomainName } from './config.ts'
import { TurnFailureError, displayFailure } from './turn-failure.ts'
import { noteDirectFeishuDispatch, noteFeishuPrompt } from './feishu-turn-origin.ts'

/** Events read from a cold session log when recovering its recorded preset.
 *  `agent-preset/selected` can only be appended while the session is blank, so
 *  it always sits in the log's head — this bound keeps that read off the path
 *  of a multi-megabyte history. */
const PRESET_SCAN_EVENTS = 64

/** Minimum surface of {@link Agent} the conversation service depends on. */
interface AgentLike {
  session: { id: unknown; seq: number; events?: readonly { seq: number; type: string; data: any }[] }
  /** Agent-scoped Cordis context; absent on older hosts that expose only the
   *  session surface (a quick model switch then reports "unsupported"). */
  ctx?: { on(event: string, handler: (...args: any[]) => unknown): () => void }
  whenIdle(): Promise<void>
  followup(message: ReturnType<typeof createUserMessage>): void
  steer(message: ReturnType<typeof createUserMessage>): void
  cancel(cause: { kind: 'user' }, opts?: { keepInbox?: boolean }): void
  status: 'idle' | 'running'
}

/** Thrown by the bridge when a queued message is dropped because the session
 *  was stopped (`/stop`) while it waited for the current turn to end. The
 *  channel treats it as a silent drop rather than a failure. */
export class TurnDroppedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TurnDroppedError'
  }
}

/** Busy behavior for a message sent while the agent is running. */
export type BusyMode = 'queue' | 'steer'

interface AgentHandleLike { agent: AgentLike; dispose(): Promise<void> }

interface WorkspaceLike {
  path: string
  attachSession(sessionId: unknown): Promise<void>
}

export interface HarnessDependencies {
  agents: {
    create: (options: any) => Promise<AgentHandleLike>
    resume: (options: any) => Promise<AgentHandleLike>
    get: (id: ReturnType<typeof toSessionId>) => Agent | undefined
  }
  sessions: { flush(session: AgentLike['session']): Promise<unknown> }
  sessionPersistence: {
    /** 0.1.3: list() returns SessionPersistenceSnapshot[] (id = .header.id).
     *  Older (alpha.4) returns elements with a top-level `.id`. The bridge
     *  resolves both via `persistedIdOf`. */
    list(): Promise<ReadonlyArray<{ id?: string; header: { id: string } }>>
    /** 0.1.3: read via open(id,'read') + handle.read(0) (SessionHandle).
     *  Older (alpha.4): readFrom(id, fromSeq). Optional so a deployment that
     *  hides the service still lists cold sessions with no title. */
    readFrom?(id: unknown, fromSeq: number): Promise<{ meta: unknown; events: ReadonlyArray<{ seq: number; type: string; data: any }> }>
    /** 0.1.3: open a session handle (read|write). Read-only usage for the
     *  bridge; must close() after use (write handles leak ownership if not).
     *  0.1.3-alpha.2: `handle.read()` returns a `SessionHandleReadResult`
     *  envelope `{ eventState, events }`; older alphas returned the event
     *  array directly. The bridge destructures `.events` to stay neutral. */
    open?(id: unknown, access: 'read' | 'write'): Promise<{ read(offset?: number, length?: number): Promise<{ eventState?: unknown; events: ReadonlyArray<{ seq: number; type: string; data: any; time?: number }> }>; header?: unknown; close(): Promise<void> }>
  }
  selection(): { provider: string; model: string; reasoningEffort?: ReasoningEffortId }
  /**
   * DSH's Session projection reader. Listing a live Session prefers this over
   * replaying its event log: `Session.snapshotEvents()` is deprecated for new
   * callers (the 2026-09-09 "deprecate synchronous reads of arbitrary Session
   * events" decision — state a domain needs should be read from a projection
   * rather than by looking back through history). Optional, and resolved with
   * `ctx.get`, so a host without the service still boots (关键坑 2).
   */
  sessionProjections?: {
    stateOf(session: unknown, key: string): unknown
  }
  agentPresets: {
    resolve(id?: string): Promise<{ id: string }>
    mount(agentCtx: import('@deepseek-ai/cordis').Context, id?: string): Promise<unknown>
    /** Optional roster so the session list can show a preset's display name. */
    list?(): Promise<Array<{ id: string; name?: string }>>
  }
  workspaceRegistry: {
    list(): WorkspaceLike[]
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>
    /** Session ids hidden from listing surfaces (e.g. `/session`); matches the
     *  workspace webui archive set so users see the same list in both places. */
    readonly archivedSessionIds: readonly string[]
  }
  /**
   * DSH's unified Agent prompt entry (`@deepseek-ai/dsh-api-session-controller`),
   * used to dispatch `/steer` and `/queue` messages through the native
   * `sessionController.prompt()` instead of a hand-built `agent.steer/followup`
   * state machine. Optional: when absent (or `prompt` missing) dispatch falls
   * back to the direct `agent.steer` / `agent.followup` calls, so the change is
   * safe on any DSH version. Present on the current 0.1.2-alpha.4 baseline and
   * unchanged in 0.1.3.
   */
  sessionController?: {
    prompt?: (
      request: { sessionId: unknown; requestId: string; mode: 'steer' | 'queue'; content: unknown },
      signal?: AbortSignal,
    ) => Promise<{ accepted: boolean }>
    /**
     * DSH's one-stop model route installer (agent-scoped selection ref +
     * `model/selection` session event + persisted default). Required for a
     * `/new` route to survive the first prompt — see {@link applyCreationRoute}.
     */
    selectModel?: (request: {
      sessionId: unknown
      provider: string
      model: string
      reasoningEffort?: string
    }) => Promise<unknown>
  }
}

export interface HarnessBridgeConfig {
  /** Transport drafts must not follow an established chat into another Session. */
  onBindingChanged?: (chat: ConversationMessage, sessionId: string) => void
  domain: DomainName
  workspace?: string
  agentPreset?: string
  provider?: string
  model?: string
  /** Path to persist the chat→session override map across restarts. */
  statePath?: string
}

export interface InboundMessage extends ConversationMessage {
  content: string
  imageBlocks?: readonly ImageAttachmentRef[]
  /** 0.1.3 durable file attachments (from `attachments.saveFileStream`), attached
   *  to the user message as `{ type:'file', attachment }` content blocks. Each
   *  carries the ref and its absolute on-disk host path. */
  fileBlocks?: readonly { attachment: any; hostPath?: string }[]
}

/** Per-chat creation options captured from the `/new` card flow or text
 *  command. Applied when the bridge creates the session agent, overriding
 *  the deployment-wide config defaults for workspace / preset / model. */
export interface ChatCreationOptions {
  workspace?: string
  agentPreset?: string
  provider?: string
  model?: string
  reasoningEffort?: ReasoningEffortId
}

/**
 * One live agent's pending model route, installed by `/model last`.
 *
 * `assembled` is captured by the system-prompt hook so the request hook only
 * overrides a request whose assembly actually saw the selection (the same
 * two-phase shape DSH's own `installModelSelection()` uses). The plugin spells
 * it out instead of importing the host module: a second evaluation of a host
 * package inside this process is the 关键坑 28 hazard.
 */
interface RouteOverride {
  current?: RouteEntry | undefined
  assembled?: RouteEntry | undefined
}

/** Per-agent override state, so repeated quick picks reuse the same hooks. */
const routeOverrides = new WeakMap<object, RouteOverride>()

/**
 * Install (once per agent) the hooks that make the next request use `route`;
 * later calls only update the pending selection.
 *
 * @param agent - live DSH agent owning the Session.
 * @param route - the model route to apply.
 */
function installRouteSelection(agent: AgentLike, route: RouteEntry): void {
  const ctx = agent.ctx
  if (ctx === undefined) return
  const existing = routeOverrides.get(agent)
  if (existing !== undefined) {
    existing.current = route
    return
  }
  const state: RouteOverride = { current: route }
  routeOverrides.set(agent, state)
  ctx.on('system-prompt/assemble', async (_assembly: unknown, _context: unknown, next: () => Promise<any>) => {
    const selected = state.current
    const assembled = await next()
    state.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...(assembled?.variables ?? {}),
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  ctx.on('agent/request', async (_payload: unknown, next: () => Promise<any>) => {
    const resolved = await next()
    const selected = state.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inherited, ...rest } = resolved as Record<string, unknown>
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })
}

export class HarnessConversationService {
  private readonly handles = new Map<string, Promise<AgentHandleLike>>()
  /**
   * Per-chat session override. `/new` and `/session` redirect the chat's next
   * messages to a session that is not the deterministic hash of the chat
   * coordinates, so the user can start a fresh conversation or pick an old one
   * without spinning a new chat in Feishu.
   */
  private readonly chatToSession = new Map<string, string>()
  /**
   * Per-chat topic root message id (`rootId`), captured from inbound topic
   * messages. Feishu topic replies must target the topic ROOT message
   * (`replyTo: rootId` + `reply_in_thread: true`); replying to a non-root
   * topic message does not reliably land in the topic, and omitting `replyTo`
   * makes the SDK fall back to `im.v1.message.create` — a brand-new top-level
   * message, i.e. a *new topic* in a topic group. Keyed by the same chat key
   * as `chatToSession`.
   *
   * Persisted (unlike the earlier in-memory-only version): a turn driven from
   * the WebUI has no inbound message of its own, so this map is the only thing
   * that can place its cards inside the topic — and it must survive the
   * restart that follows every plugin update. Entries are re-appended on use,
   * so the persisted order doubles as a recency list for {@link topicFor}.
   */
  private readonly chatToRootId = new Map<string, string>()
  /**
   * Every chat key this bridge has ever seen (persisted). Together with
   * `chatToSession` it derives session ownership: a session is owned by the
   * chat key that maps to it explicitly, or — when that key has no explicit
   * override — by the chat key whose deterministic hash equals the session id.
   * `/session` refuses to redirect a chat onto a session owned by another chat
   * so two dialog surfaces (main chat + topics) never share one session.
   */
  private readonly seenChatKeys = new Set<string>()
  /**
   * Per-chat busy behavior: how a message sent while the agent is running is
   * handled — `queue` (default; waits for the current turn then runs as a new
   * turn) or `steer` (injects into the running turn). Persisted like
   * `chatToSession` so the choice survives restarts.
   */
  private readonly chatToBusyMode = new Map<string, BusyMode>()
  /**
   * Set by {@link dispose}. Persisting after that is never right: `dispose`
   * empties the maps above on purpose, so a save from an async task still
   * running on the disposed instance would write an EMPTY binding table over a
   * good one — every chat would silently fall back to its default session
   * (observed 2026-09-23: a restart landing mid-turn wiped the DM binding plus
   * ten topic bindings and their roots, and the only surviving field was
   * `busyMode`, which `dispose` forgot to clear).
   */
  private disposed = false
  /**
   * How many chat→session bindings the state file held at boot. Guards
   * {@link saveSessionMap} against overwriting a populated file with an empty
   * table — see the guard there.
   */
  private loadedBindings = 0
  /** Per-chat stop generation. `/stop` bumps it; a queued `reply` that was
   *  waiting for idle detects the bump and drops instead of submitting. This
   *  is what makes `/stop` actually discard a message queued while running. */
  private readonly generations = new Map<string, number>()
  /**
   * Per-chat creation options (workspace / preset / model) captured by the
   * `/new` card flow or the `/new <workspace> <preset> [model]` text command.
   * `createAgent` reads them when it spins up the session agent so a session
   * created through the card lands in the chosen workspace with the chosen
   * preset and model instead of the deployment-wide defaults. Keyed by the
   * same chat key as `chatToSession`.
   */
  private readonly chatToCreation = new Map<string, ChatCreationOptions>()
  /**
   * Workspace (cwd) per session, read once from its creation header. An empty
   * string means "asked and there is none", so a missing header is not re-read.
   * See {@link workspaceOf}.
   */
  private readonly workspaceCache = new Map<string, string>()
  /**
   * `chatId → open_id` of the most recent inbound sender. Used to share a
   * document the bot created (tenant-token documents are owned by the bot, so
   * without an explicit collaborator grant the asking user cannot open them).
   * Persisted (unlike the first version): a restart must not silently turn the
   * next document create into an unshared one.
   */
  private readonly chatToSender = new Map<string, string>()
  /**
   * Sessions for which intermediate assistant message cards were sent during
   * the current turn. The channel skips the final reply card for these
   * sessions to avoid duplication.
   */
  private readonly intermediateSent = new Set<string>()
  /** Global (across Feishu sessions) recently used models, newest first. */
  private recentModels: RecentModelEntry[] = []

  constructor(private readonly deps: HarnessDependencies, private readonly config: HarnessBridgeConfig) {
    this.loadSessionMap()
  }

  /** Load persisted chat→session map from disk (if the file exists). */
  private loadSessionMap(): void {
    const path = this.config.statePath
    if (path === undefined || path === '') return
    try {
      const raw = readFileSync(path, 'utf-8')
      const data = JSON.parse(raw) as
        | Record<string, string>                 // legacy: { chatKey: sessionId }
        | {
          chatToSession?: Record<string, string>
          seenChatKeys?: string[]
          busyMode?: Record<string, string>
          chatToRootId?: Record<string, string>
          chatToSender?: Record<string, string>
        }
      // Legacy format (pre-ownership): a flat record keyed by chat key.
      const legacy = Array.isArray(data) ? undefined
        : (data as Record<string, string>).chatToSession === undefined && !Array.isArray((data as any).seenChatKeys)
          ? data as Record<string, string>
          : undefined
      if (legacy !== undefined) {
        for (const [k, v] of Object.entries(legacy)) this.chatToSession.set(k, v)
        for (const k of Object.keys(legacy)) this.seenChatKeys.add(k)
        this.loadedBindings = this.chatToSession.size
        return
      }
      const parsed = data as {
        chatToSession?: Record<string, string>
        seenChatKeys?: string[]
        busyMode?: Record<string, string>
        chatToRootId?: Record<string, string>
        chatToSender?: Record<string, string>
        recentModels?: unknown[]
      }
      for (const [k, v] of Object.entries(parsed.chatToSession ?? {})) this.chatToSession.set(k, v)
      for (const k of parsed.seenChatKeys ?? []) this.seenChatKeys.add(k)
      for (const [k, v] of Object.entries(parsed.busyMode ?? {})) {
        if (v === 'queue' || v === 'steer') this.chatToBusyMode.set(k, v)
      }
      // Insertion order is preserved by JSON, so the topic recency order
      // written by `noteTopic` survives the restart.
      for (const [k, v] of Object.entries(parsed.chatToRootId ?? {})) this.chatToRootId.set(k, v)
      // The last inbound sender per chat is persisted too: a restart must not
      // turn a Feishu-driven document create into an unshared (unopenable) one.
      for (const [k, v] of Object.entries(parsed.chatToSender ?? {})) {
        if (typeof v === 'string' && v.startsWith('ou_')) this.chatToSender.set(k, v)
      }
      if (Array.isArray(parsed.recentModels)) {
        this.recentModels = parsed.recentModels.filter(isRecentModelEntry)
      }
      this.loadedBindings = this.chatToSession.size
      // Logged because a binding that silently fails to load is indistinguishable
      // from one that was never made — the 2026-09-23 wipe had to be
      // reconstructed from an unrelated upgrade backup before this line existed.
      console.log('dsh-feishu: session map loaded:'
        + ` ${this.chatToSession.size} bound, ${this.seenChatKeys.size} seen,`
        + ` ${this.chatToRootId.size} topic roots, ${this.chatToBusyMode.size} busy modes`)
    } catch (error: unknown) {
      // ENOENT is expected on first run; log other errors
      if ((error as { code?: string }).code !== 'ENOENT') {
        const detail = error instanceof Error ? error.message : String(error)
        console.error('dsh-feishu: loadSessionMap failed:', detail)
        // Quarantine the unreadable file instead of letting the next save
        // overwrite it: the bindings in it are the only copy, and a torn write
        // (SIGKILL mid-save) must be recoverable by hand.
        try {
          const quarantine = `${path}.corrupt-${Date.now()}`
          renameSync(path, quarantine)
          console.error(`dsh-feishu: unreadable session map moved to ${quarantine}`)
        } catch { /* keep going: the map will simply be rebuilt */ }
      }
    }
  }

  /**
   * Persist the current chat→session map to disk (best-effort).
   *
   * Two refusals, both of which only ever SKIP a write (so a legitimate first
   * save, when no file exists yet, is unaffected):
   *
   * 1. after {@link dispose} emptied the tables — see the `disposed` field;
   * 2. an empty table over a file that held bindings at boot — an unknown path
   *    that empties the maps must not destroy the only copy of the bindings.
   *
   * The write itself is atomic (temp + rename): a restart landing mid-write
   * must not leave a truncated file, which the next boot would have to discard
   * wholesale.
   */
  private saveSessionMap(): void {
    const path = this.config.statePath
    if (path === undefined || path === '') return
    if (this.disposed) {
      console.log('dsh-feishu: refusing to persist the session map: the bridge was disposed')
      return
    }
    // A map that lost every binding while disk still held one means some caller
    // emptied the tables without disposing — writing here would destroy the only
    // copy of the bindings. Loud on purpose: this line firing is the signal that
    // a second wipe path exists.
    if (this.loadedBindings > 0 && this.chatToSession.size === 0 && this.seenChatKeys.size === 0) {
      console.log('dsh-feishu: refusing to persist the session map:'
        + ` an empty table would replace the ${this.loadedBindings} bindings loaded from disk`)
      return
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      const body = JSON.stringify({
        chatToSession: Object.fromEntries(this.chatToSession),
        seenChatKeys: [...this.seenChatKeys],
        busyMode: Object.fromEntries(this.chatToBusyMode),
        chatToRootId: Object.fromEntries(this.chatToRootId),
        chatToSender: Object.fromEntries(this.chatToSender),
        recentModels: this.recentModels,
      })
      // Atomic: a restart (or SIGKILL) landing mid-write must never leave a
      // truncated JSON behind, because the next boot would then lose EVERY
      // binding rather than the ones changed since the last good save.
      const tmp = `${path}.tmp`
      writeFileSync(tmp, body, 'utf-8')
      renameSync(tmp, path)
    } catch (error: unknown) {
      console.error('dsh-feishu: saveSessionMap failed:', error instanceof Error ? error.message : String(error))
    }
  }

  async reply(message: InboundMessage, opts?: { forceQueue?: boolean; onBusy?: (mode: BusyMode) => void; onAccepted?: () => void }): Promise<string | undefined> {
    const key = conversationKey(message)
    // Capture the topic root id so streaming/question/approval/todo cards
    // can reply into the same Feishu topic instead of the main chat stream.
    this.noteTopic(message)
    const handle = await this.getOrCreate(key)
    const agent = handle.agent
    const gen = this.generationOf(key)
    // `forceQueue` overrides the per-chat busy mode for one message: the
    // `/queue` command uses it to send a message as a queued new turn even
    // when the chat is in steer mode (the conjugate of `/steer`, which forces
    // an injection regardless of the mode).
    const runBusyMode = opts?.forceQueue === true ? 'queue' as const : this.busyModeFor(key)
    const running = agent.status === 'running'
    const text = message.content
    const imageBlocks = message.imageBlocks ?? []
    const fileBlocks = message.fileBlocks ?? []
    const hasText = text.length > 0
    const hasImages = imageBlocks.length > 0
    const hasFiles = fileBlocks.length > 0
    if (!hasText && !hasImages && !hasFiles) {
      // An inbound message must carry either text or at least one image/file;
      // the channel layer filters empties out, so this is defensive.
      throw new Error('dsh-feishu: cannot submit an empty user turn')
    }
    // The user's text reaches the model verbatim — no channel prefix. The
    // Feishu channel is already recorded by the session↔chat binding, so a
    // `[Feishu] ` marker would only pollute every turn's model context and
    // session log, and would leave a stray empty text block on image/file-only
    // turns (which carry no caption to attach it to).
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef } | { type: 'file'; attachment: any }> = []
    if (hasText) content.push({ type: 'text', text })
    for (const attachment of imageBlocks) content.push({ type: 'image', attachment })
    for (const file of fileBlocks) content.push({ type: 'file', attachment: file.attachment })

    // Steer mode + running: inject into the live turn immediately. The
    // running turn's OWN reply card answers this message, so we must not wait
    // and must not produce a second reply — doing so used to send two reply
    // cards for one turn (the original message's and this one's). Report the
    // injection through `onBusy` so the caller can acknowledge it in plain
    // text instead.
    if (runBusyMode === 'steer' && running) {
      if (!(await this.dispatchPrompt(agent, 'steer', content))) {
        // Direct injection carries no `rpcId`; remember the dispatch so the
        // matching message event is still attributed to Feishu.
        noteDirectFeishuDispatch(String(agent.session.id))
        agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
      }
      opts?.onAccepted?.()
      opts?.onBusy?.('steer')
      return undefined
    }

    // Queue path (default): wait for the current turn to end, then followup as
    // a new turn. A `/stop` during the wait bumps the generation, so drop the
    // message instead of submitting it — this is what actually discards a
    // message queued while the agent was running.
    if (running) opts?.onBusy?.('queue')
    await agent.whenIdle()
    if (this.generationOf(key) !== gen) {
      throw new TurnDroppedError('message dropped: session stopped while it was queued')
    }
    const firstSeq = agent.session.seq
    if (!(await this.dispatchPrompt(agent, 'queue', content))) {
      noteDirectFeishuDispatch(String(agent.session.id))
      agent.followup(createUserMessage({
        content,
        source: { kind: 'user' },
      }))
    }
    opts?.onAccepted?.()
    await agent.whenIdle()
    await this.deps.sessions.flush(agent.session)
    const result = summarizeTurn(this.readSessionEvents(agent, firstSeq), firstSeq)
    if (!result.ok) {
      // A turn that ended `error` carries the provider's structured facts on
      // its `turn/end` reason, and the DSH Web UI renders exactly those facts
      // (message + code + the localized turn-error title). Re-throw them intact
      // so the channel can mirror that rendering; replacing them with a
      // hardcoded sentence is what made one failure look different on each side.
      if (result.failure !== undefined) throw new TurnFailureError(result.failure)
      if (result.ended === 'error') throw new TurnFailureError(displayFailure(undefined))
      // Aborted / interrupted / blocked / max-tokens endings are not failures:
      // the Web UI keeps the streamed output and shows no error row, so deliver
      // whatever text the turn produced (the step cards already showed it) and
      // never raise a bogus "turn failed" notice.
      return result.text === '' ? undefined : result.text
    }
    return result.text
  }

  /**
   * The live session's event log, tolerant of the two Session API surfaces
   * DSH's `Session` has shipped. The host running from source exposes
   * `snapshotEvents()` while the published `dsh-session` package exposes a
   * plain `events` getter; reading the wrong one makes a downstream `for..of`
   * throw "events is not iterable". Prefer the plain array, fall back to the
   * snapshot method, and never fail just because neither is present.
   *
   * When `fromSeq` is given, bound the snapshot to events at or after that
   * sequence instead of copying the entire history. `snapshotEvents()` with no
   * range defaults to `(0, session.seq)` and caches a frozen copy of the WHOLE
   * log (`eventsSnapshot`); for a long-lived session that is hundreds of MB.
   * `reply()` only summarises the current turn (`summarizeTurn` drops anything
   * with `seq < firstSeq`), so snapshotting the full history is pure overhead
   * and was the amplifier behind the "JavaScript heap out of memory" crashes on
   * bloated sessions.
   *
   * **Status against DSH's deprecation** (`snapshotEvents` / `eventAt` /
   * `ownEvents`, 2026-09-09 Agent Note: "existing logic may remain unmigrated
   * for now, but new calls are prohibited"): the session-list path no longer
   * calls this — live sessions read the host's `title` / `agentPreset` /
   * `sessionListMetadata` projections instead. The remaining caller is
   * `summarizeTurn`, which needs one turn's **raw** events (per-step
   * `step/start`, assistant streams, tool/result pairs, event times) to
   * reproduce the Web UI's turn metrics; no registered projection exposes
   * per-step timing, so this read stays until one does. It adds no new event
   * dependency beyond what the turn card already needed.
   */
  private readSessionEvents(
    agent: AgentLike,
    fromSeq?: number,
  ): readonly { seq: number; type: string; data: any }[] {
    const session = agent.session as unknown as {
      events?: readonly { seq: number; type: string; data: any }[]
      snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly { seq: number; type: string; data: any }[]
    }
    if (Array.isArray(session.events)) return session.events
    if (typeof session.snapshotEvents === 'function') {
      return fromSeq === undefined ? session.snapshotEvents() : session.snapshotEvents(fromSeq)
    }
    return []
  }

  /**
   * Completed turns of one chat's session, oldest first, each with the seq a
   * `/fork` should cut at and a short preview for the picker card.
   *
   * Reads a live session's log through BOUNDED windows (`snapshotEvents(from,
   * to)`); the host deprecates unbounded synchronous reads and an unbounded
   * snapshot caches a copy of the whole log (关键坑 8). A session that is not
   * live (first message after a restart, or a cold binding) is read from
   * persistence instead.
   *
   * @param message - chat coordinates; the bound session is resolved from them.
   * @param limit - how many completed turns to keep (newest last).
   * @returns the completed turns, `[]` when the session cannot be read.
   */
  async listTurns(message: ConversationMessage, limit = 12): Promise<readonly CompletedTurn[]> {
    const sessionId = this.resolveSessionIdFor(message)
    if (sessionId === '') return []
    const events = await this.readWindowedEvents(sessionId, window => collectCompletedTurns(window, { limit }).length >= limit)
    return collectCompletedTurns(events, { limit })
  }

  /**
   * Remember a model route the plugin just applied — the GLOBAL recency list
   * (across Feishu sessions), persisted with the chat→session map.
   *
   * @param route - the route that was used or selected.
   */
  rememberModelRoute(route: ModelRoute): void {
    const next = rememberModel(this.recentModels, route, Date.now())
    // Headers repeat for a route that is already at the front (every request
    // series appends one); rewriting the state file for those would be pure
    // disk churn. Compare route identity, not `usedAt`.
    const unchanged = next.length === this.recentModels.length && next.every((entry, index) => {
      const previous = this.recentModels[index]
      return previous !== undefined
        && previous.provider === entry.provider
        && previous.model === entry.model
        && (previous.reasoningEffort ?? '') === (entry.reasoningEffort ?? '')
    })
    this.recentModels = next
    if (!unchanged) this.saveSessionMap()
  }

  /**
   * The picker shortlist for one chat: the GLOBAL list merged with the routes
   * this Session's own log shows (newest first, de-duplicated, current route
   * included so a single known route still renders), and the session-only
   * routes pushed into the global memory so later opens (in any chat) see them.
   *
   * @param message - chat coordinates.
   * @param limit - how many entries to return (default 3).
   * @returns up to `limit` distinct routes, newest first.
   */
  async recentModelChoices(message: ConversationMessage, limit = 3): Promise<readonly RecentModelEntry[]> {
    const sessionRoutes = await this.recentRoutes(message, 6).catch(() => [] as readonly RecentRoute[])
    const merged = mergeRecentModels(this.recentModels, sessionRoutes, limit)
    // Backfill: the global memory only knows routes the plugin applied itself,
    // so the first open after a restart would otherwise show nothing at all.
    for (const route of sessionRoutes) {
      if (this.recentModels.some(entry => entry.provider === route.provider && entry.model === route.model)) continue
      this.rememberModelRoute(route)
    }
    return merged
  }

  /**
   * The GLOBAL recently used models, newest first, de-duplicated by
   * provider+model, excluding the route this Session already runs.
   *
   * @param exclude - current route of the Session asking (omitted = no filter).
   * @param limit - how many entries to return (default 3).
   * @returns up to `limit` distinct routes.
   */
  recentModelRoutes(exclude?: ModelRoute, limit = 3): readonly RecentModelEntry[] {
    return topRecentModels(this.recentModels, exclude, limit)
  }

  /**
   * Recent model routes of this chat's Session, newest first (`/model last`).
   *
   * @param message - chat coordinates.
   * @param limit - how many distinct routes to return.
   * @returns the routes; `[]` when the session cannot be read.
   */
  async recentRoutes(message: ConversationMessage, limit = 6): Promise<readonly RecentRoute[]> {
    const sessionId = this.resolveSessionIdFor(message)
    if (sessionId === '') return []
    const events = await this.readWindowedEvents(sessionId, window => collectRecentRoutes(window, limit).length >= limit)
    return collectRecentRoutes(events, limit)
  }

  /**
   * Switch THIS Session to `route`.
   *
   * The primary path is the Host's own `sessionController.selectModel` — the
   * exact entry the WebUI and this plugin's `/model` card confirm use. That
   * matters: the Host installs its own request-routing hooks when it commits a
   * selection, and a second set of hooks registered here (the pre-2026-10-29
   * implementation) was silently overridden by them, so a "switched" card could
   * leave the session on its previous model forever.
   *
   * Consequences, matching a normal switch: the Session records
   * `model/selection`, and the global default follows the pick — which is only
   * a seed for Sessions created later (a Session with history resolves its own
   * logged route first), so other conversations keep their models.
   *
   * The local-hook path remains only as a fallback for a Host without
   * `selectModel`.
   *
   * @param message - chat coordinates (resolves the bound Session).
   * @param route - the model route to install for the next request.
   * @returns `ok`, or why the switch could not be applied.
   */
  async switchRoute(
    message: ConversationMessage,
    route: RouteEntry,
  ): Promise<{ ok: true } | { ok: false; reason: 'no-agent' | 'unsupported' | 'rejected'; detail?: string }> {
    const sessionId = this.resolveSessionIdFor(message)
    if (sessionId === '') return { ok: false, reason: 'no-agent' }
    const controller = this.deps.sessionController
    const selectModel = controller?.selectModel
    if (selectModel !== undefined) {
      try {
        await selectModel.call(controller, {
          sessionId,
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        })
        this.rememberModelRoute(route)
        return { ok: true }
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        console.log(`dsh-feishu: model switch rejected by the session controller: ${detail}`)
        return { ok: false, reason: 'rejected', detail }
      }
    }
    const agent = this.deps.agents.get(sessionId as never) as unknown as AgentLike | undefined
    if (agent === undefined) return { ok: false, reason: 'no-agent' }
    if (agent.ctx === undefined || typeof agent.ctx.on !== 'function') return { ok: false, reason: 'unsupported' }
    installRouteSelection(agent, route)
    this.rememberModelRoute(route)
    return { ok: true }
  }

  /**
   * Read a bounded event window of one Session, widening it until `enough`
   * accepts the window or the log start is reached.
   *
   * @param sessionId - durable Session identity.
   * @param enough - acceptance test over a candidate window.
   * @returns the window (oldest first); `[]` when nothing can be read.
   */
  private async readWindowedEvents(
    sessionId: string,
    enough: (events: readonly TurnEventLike[]) => boolean,
  ): Promise<readonly TurnEventLike[]> {
    const agent = this.deps.agents.get(sessionId as never) as unknown as AgentLike | undefined
    const session = agent?.session as unknown as {
      readonly seq?: number
      events?: readonly TurnEventLike[]
      snapshotEvents?: (from?: number, to?: number) => readonly TurnEventLike[]
    } | undefined
    if (session !== undefined) {
      if (Array.isArray(session.events)) return session.events
      const snapshot = session.snapshotEvents
      const total = session.seq
      if (typeof snapshot === 'function' && typeof total === 'number' && total > 0) {
        let windowSize = 2_000
        while (true) {
          const from = Math.max(0, total - windowSize)
          const events = snapshot(from, total)
          if (from === 0 || enough(events) || windowSize > 200_000) return events
          windowSize *= 4
        }
      }
    }
    const cold = await this.readColdSession(sessionId)
    return cold?.events ?? []
  }

  /** Resolve the durable session id from a `sessionPersistence.list()` row.
   *  0.1.3 rows are `SessionPersistenceSnapshot` (id = `.header.id`); older
   *  versions expose a top-level `.id`. Either shape resolves here. */
  private persistedIdOf(item: { id?: string; header?: { id: string } }): string {
    return item.id ?? item.header?.id ?? ''
  }

  /** Read a cold session's header + events from persistence across DSH
   *  versions. 0.1.3 uses `open(id,'read') + handle.read(0)`; alpha.4 uses
   *  `readFrom(id, 0)`. Returns `undefined` when the service (or backend) is
   *  absent so callers can fall back to live-session data.
   *  @param maxEvents - cap the events returned (a perf bound for callers that
   *    only need the log's head); the alpha.4 `readFrom` fallback has no length
   *    argument and can only truncate after reading. */
  private async readColdSession(
    sessionId: unknown,
    maxEvents?: number,
  ): Promise<{ meta: unknown; events: ReadonlyArray<{ seq: number; type: string; data: any; time?: number }> } | undefined> {
    const persistence = this.deps.sessionPersistence
    // 0.1.3: SessionHandle seam.
    if (typeof persistence.open === 'function') {
      try {
        const handle = await persistence.open(sessionId as never, 'read')
        try {
          // 0.1.3-alpha.2: `read()` returns `{ eventState, events }`. Older
          //  alphas returned the event array directly — those arrays are
          //  structurally compatible with the envelope (each element has
          //  seq/type/data/time), so a single destructure is safe to call
          //  on either. `result?.events ?? result` covers the alpha.4 path
          //  without an extra branch.
          const result = maxEvents === undefined ? await handle.read(0) : await handle.read(0, maxEvents)
          const events = (result as { events?: ReadonlyArray<{ seq: number; type: string; data: any; time?: number }> })?.events
            ?? (result as unknown as ReadonlyArray<{ seq: number; type: string; data: any; time?: number }>)
          return { meta: handle.header, events }
        } finally {
          // Read handles are safe to close; always release to avoid leaking
          // (write handles would not, but this bridge only reads).
          await handle.close().catch(() => undefined)
        }
      } catch {
        return undefined
      }
    }
    // alpha.4: readFrom primitive.
    if (typeof persistence.readFrom === 'function') {
      try {
        const result = await persistence.readFrom.call(persistence, sessionId as never, 0)
        if (result === undefined || maxEvents === undefined) return result
        return { meta: result.meta, events: result.events.slice(0, maxEvents) }
      } catch {
        return undefined
      }
    }
    return undefined
  }

  /**
   * Dispatch one user turn through DSH's native `sessionController.prompt()`
   * when it is available AND the content is text-only. The native entry gives
   * us the same `agent.steer` / `agent.followup` endpoint plus route-served
   * validation and request-id tracing, while the caller keeps its `whenIdle` /
   * running-guard / generation-drop wrappers around it.
   *
   * Image content is deliberately NOT routed here: `prompt()` re-admits the
   * content via `admitPromptContent`, but this plugin already pre-admits images
   * through `attachments.saveImage` and hands the durable `ImageAttachmentRef`
   * straight to the agent — re-admitting that path is an untested regression
   * risk. Calling this with a mixed/image content always returns `false` so the
   * caller falls back to the direct `agent.steer` / `agent.followup`.
   *
   * @returns `true` when the turn was dispatched through `sessionController.prompt()`.
   */
  private async dispatchPrompt(
    agent: AgentLike,
    mode: 'steer' | 'queue',
    content: ReadonlyArray<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef } | { type: 'file'; attachment: any }>,
  ): Promise<boolean> {
    if (this.deps.sessionController?.prompt === undefined) return false
    if (content.some(part => part.type === 'image' || part.type === 'file')) return false
    // `prompt()` must be invoked as a METHOD (`this` bound to the
    // sessionController) — its internals read `this.commands.prompt`, so
    // calling it as a detached bare function leaves `this` undefined and
    // crashes with "Cannot read properties of undefined (reading 'commands')".
    // It also dereferences the AbortSignal unconditionally
    // (`signal.throwIfAborted()` in the adapter), so the signal must be real —
    // passing `undefined` crashed with "...reading 'throwIfAborted')".
    const controller = new AbortController()
    const requestId = randomUUID()
    // Remember the id BEFORE dispatching: the session controller writes it
    // verbatim into the message's `source.rpcId`, which is how
    // `feishu-turn-origin.ts` recognises the message as one this plugin
    // dispatched on Feishu's behalf. A failed dispatch only leaves an unused
    // record that expires.
    noteFeishuPrompt(String(agent.session.id), requestId)
    await this.deps.sessionController.prompt(
      { sessionId: agent.session.id, requestId, mode, content },
      controller.signal,
    )
    return true
  }

  /**
   * Resolve one agent preset id to its display name via the roster, matching
   * what `/session list` and the WebUI show. Falls back to the raw id when the
   * roster is unavailable or the id is unknown / empty.
   */
  private async resolvePresetDisplayName(id: string): Promise<string> {
    if (id === '') return ''
    if (typeof this.deps.agentPresets.list !== 'function') return id
    try {
      for (const row of await this.deps.agentPresets.list()) {
        if (row.id === id) return row.name !== undefined && row.name !== '' ? row.name : row.id
      }
    } catch {
      // Roster read failure: fall back to the id below.
    }
    return id
  }

  /** Per-chat busy mode for a message sent while the agent is running. */
  busyMode(message: ConversationMessage): BusyMode {
    return this.busyModeFor(conversationKey(message))
  }

  /** Set (and persist) the per-chat busy mode. */
  setBusyMode(message: ConversationMessage, mode: BusyMode): void {
    this.chatToBusyMode.set(conversationKey(message), mode)
    this.saveSessionMap()
  }

  /**
   * Stop one chat's agent run and drop any message still queued behind it.
   * Bumps the per-chat generation (so a waiting {@link reply} drops instead of
   * submitting) and cancels the live agent with `keepInbox:false`.
   * @returns whether a live agent was found and cancelled.
   */
  stopSession(message: ConversationMessage): boolean {
    const key = conversationKey(message)
    this.generations.set(key, this.generationOf(key) + 1)
    const sessionId = this.resolveSessionId(message)
    const agent = this.deps.agents.get(sessionId as never) as unknown as AgentLike | undefined
    if (agent === undefined) return false
    agent.cancel({ kind: 'user' }, { keepInbox: false })
    return true
  }

  private generationOf(key: string): number {
    return this.generations.get(key) ?? 0
  }

  private busyModeFor(key: string): BusyMode {
    return this.chatToBusyMode.get(key) ?? 'queue'
  }

  /**
   * Steer one message into a RUNNING agent turn (the DSH `next-step` inbox),
   * instead of queueing it as a new turn. Unlike {@link reply} this does not
   * wait for the agent to become idle — it injects into the live turn so the
   * model reacts immediately (matching the WebUI's steer gesture while busy).
   *
   * The target agent must already exist and be running; otherwise no turn can
   * receive the injection and the call throws a clear error.
   */
  async steer(message: InboundMessage): Promise<void> {
    const agent = await this.resolveAgent(message)
    if (agent === undefined) {
      throw new Error('没有运行中的 turn 可注入（该聊天尚未开始会话，请先发一条消息）')
    }
    if ((agent as unknown as AgentLike).status !== 'running') {
      throw new Error('当前没有运行中的 turn 可注入 —— 请直接发新消息（会排队为新轮），或用 /steer 在它运行时注入')
    }
    const text = message.content
    if (text.trim() === '') {
      throw new Error('steer 内容为空')
    }
    // Same verbatim-text contract as reply(): no channel prefix. The injection
    // came from the Lark channel, which the session↔chat binding already says.
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef } | { type: 'file'; attachment: any }> = []
    content.push({ type: 'text', text })
    for (const attachment of (message.imageBlocks ?? [])) content.push({ type: 'image', attachment })
    for (const file of (message.fileBlocks ?? [])) content.push({ type: 'file', attachment: file.attachment })
    if (!(await this.dispatchPrompt(agent, 'steer', content))) {
      noteDirectFeishuDispatch(String(agent.session.id))
      ;(agent as unknown as AgentLike).steer(createUserMessage({
        content,
        source: { kind: 'user' },
      }))
    }
    // Do NOT `await whenIdle()`: steering injects into the running turn and
    // returns immediately. The steered step renders through feishu-streaming.
  }

  /**
   * Resolve the agent backing one inbound message without creating one.
   * Slash-command handlers need a live agent to attach lifecycle events to;
   * silently spawning one would let the user run `/compact` against an empty
   * session and report "no compactable history yet" instead of an error.
   * @param message - inbound chat coordinates used to derive the session id.
   * @returns the existing agent for this chat, or `undefined` when no
   *   conversation has been started yet.
   */
  async resolveAgent(message: ConversationMessage): Promise<Agent | undefined> {
    const key = conversationKey(message)
    const sessionId = this.resolveSessionId(message)
    const live = this.deps.agents.get(sessionId as never)
    if (live !== undefined) return live
    const pending = this.handles.get(key)
    if (pending === undefined) return undefined
    try {
      // The handle's agent is the bridge's narrowed AgentLike; the command
      // runtime needs every Agent member, so cast through the structural
      // shape that the bridge already accepts.
      return (await pending).agent as unknown as Agent
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the agent backing one inbound message for commands that genuinely
   * need a session, WITHOUT requiring the user to send a regular message
   * first. Unlike {@link resolveAgent} this rehydrates a persisted-but-cold
   * session (e.g. right after a restart, before any new message) so session
   * commands like `/help`, `/model`, `/reasoning`, `/approvals` and `/compact`
   * work immediately on the existing conversation. Returns `undefined` only
   * when no conversation exists at all (nothing live AND nothing persisted) —
   * commands signal "send a regular message first" in that case.
   */
  async resolveAgentOrResume(message: ConversationMessage): Promise<Agent | undefined> {
    const key = conversationKey(message)
    const sessionId = this.resolveSessionId(message)
    const live = this.deps.agents.get(sessionId as never)
    if (live !== undefined) return live as unknown as Agent
    const pending = this.handles.get(key)
    if (pending !== undefined) {
      try {
        return (await pending).agent as unknown as Agent
      } catch {
        return undefined
      }
    }
    // Cold session: rehydrate it (resume) only if it actually has persisted
    // history; do not silently create a brand-new session for a reference
    // command. `getOrCreate` takes the `resume` branch because `createAgent`
    // checks `sessionPersistence.list()`.
    const persisted = (await this.deps.sessionPersistence.list()).some(item => this.persistedIdOf(item) === sessionId)
    if (!persisted) return undefined
    try {
      return (await this.getOrCreate(key)).agent as unknown as Agent
    } catch {
      return undefined
    }
  }

  /**
   * Check if the agent for a chat is currently running (processing a turn).
   * Does NOT create an agent — returns false if no agent exists yet.
   */
  isAgentRunning(message: ConversationMessage): boolean {
    const sessionId = this.resolveSessionId(message)
    const live = this.deps.agents.get(sessionId as never)
    if (live === undefined) return false
    return (live as unknown as AgentLike).status === 'running'
  }

  async dispose(): Promise<void> {
    // First, so every later save from an in-flight task is refused: the maps
    // below are about to be emptied, and persisting that state would wipe the
    // chat→session bindings on disk (2026-09-23).
    this.disposed = true
    const handles = await Promise.allSettled(this.handles.values())
    await Promise.all(handles.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []))
    this.handles.clear()
    this.chatToSession.clear()
    this.chatToRootId.clear()
    this.seenChatKeys.clear()
    this.chatToCreation.clear()
    // Cleared for consistency with the rest: leaving it out is what made the
    // wiped file look like a partial, almost-plausible state file.
    this.chatToBusyMode.clear()
    this.chatToSender.clear()
  }

  /**
   * Resolve the session id for one chat, honoring any `/new` or `/session`
   * override before falling back to the deterministic hash. Centralizing the
   * lookup keeps `createAgent` / `setCurrentSelection` consistent.
   */
  /** Record a chat key and persist it on first sight, so default-derived
   *  session ownership survives restarts even when the chat never ran
   *  `/new` or `/session`. */
  private recordChatKey(key: string): void {
    if (this.seenChatKeys.has(key)) return
    this.seenChatKeys.add(key)
    this.saveSessionMap()
  }

  private resolveSessionId(message: ConversationMessage): string {
    const key = conversationKey(message)
    this.recordChatKey(key)
    return this.chatToSession.get(key) ?? toSessionId(this.config.domain, key)
  }

  /**
   * Derive the chat key that owns one session id, or `undefined` when the
   * session is not owned by any chat this bridge knows about. Ownership has
   * two sources:
   *
   * 1. An explicit `/new` or `/session` override in `chatToSession`.
   * 2. A chat key with no override whose deterministic hash equals the
   *    session id — i.e. the session the chat lands on by default. This is
   *    the subtle case: a topic that never ran `/new` still owns its
   *    default-derived session, so the main chat cannot `/session` onto it and
   *    silently share it.
   *
   * Explicit overrides win over default derivation, so a chat that ran
   * `/new` no longer owns its old default session.
   */
  sessionOwnerKey(sessionId: string): string | undefined {
    for (const [key, mapped] of this.chatToSession) {
      if (mapped === sessionId) return key
    }
    for (const key of this.seenChatKeys) {
      if (!this.chatToSession.has(key) && toSessionId(this.config.domain, key) === sessionId) return key
    }
    return undefined
  }

  /**
   * Human-readable label for a chat key (used in ownership warnings).
   * `chat:<chatId>` is the main chat; `thread:<chatId>:<threadId>` is a topic.
   */
  describeChatKey(key: string): string {
    if (key.startsWith('thread:')) {
      const threadId = key.split(':')[2] ?? ''
      return threadId === '' ? '一个话题' : `话题(${threadId.slice(0, 8)}…)`
    }
    return '主聊天'
  }

  /**
   * Force-release one session so any dialog can `/session` onto it. The
   * previous owner (if any) is reset to a brand-new session — the same
   * effect as running `/new` in that dialog — so it can never immediately
   * re-own the released session (including the default-derived case, where
   * merely deleting the override would let the chat re-own it on its next
   * message).
   *
   * @returns `{ kind: 'released', ownerLabel }` when a chat owned the
   *   session and was reset, or `{ kind: 'free' }` when no chat owned it.
   */
  detachSession(sessionId: string): { kind: 'released'; ownerLabel: string } | { kind: 'free' } {
    const owner = this.sessionOwnerKey(sessionId)
    if (owner === undefined) return { kind: 'free' }
    const ownerLabel = this.describeChatKey(owner)
    const newSessionId = toSessionId(this.config.domain, `${owner}\0detach-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
    this.chatToSession.set(owner, newSessionId)
    this.config.onBindingChanged?.(this.messageFromKey(owner), newSessionId)
    this.seenChatKeys.add(owner)
    this.saveSessionMap()
    this.handles.delete(owner)
    return { kind: 'released', ownerLabel }
  }

  /**
   * Attach this chat to an existing session, force-taking it over when
   * another dialog currently owns it. Used by the first-message onboarding
   * card: the user picks a session from the full list (occupied ones carry a
   * lock marker) and the previous owner is released via {@link detachSession}
   * before the session is rebound to this chat.
   *
   * @returns `'ok'` when bound, `'archived'` when the session is archived.
   */
  attachSession(message: ConversationMessage, sessionId: string): 'ok' | 'archived' {
    if (this.deps.workspaceRegistry.archivedSessionIds.includes(sessionId)) return 'archived'
    const key = conversationKey(message)
    const owner = this.sessionOwnerKey(sessionId)
    if (owner !== undefined && owner !== key) {
      // Force takeover: release the previous owner first.
      this.detachSession(sessionId)
    }
    // Leaving the chat's previous session: if this chat was explicitly bound
    // to a different session, release it so it no longer resolves to this chat
    // (otherwise a lingering "old session" could still push question/step
    // cards here after the switch).
    const previous = this.chatToSession.get(key)
    const changed = (previous ?? toSessionId(this.config.domain, key)) !== sessionId
    if (previous !== undefined && previous !== sessionId) {
      this.releaseSessionForChat(previous, key, sessionId)
    }
    this.chatToSession.set(key, sessionId)
    if (changed) this.config.onBindingChanged?.(message, sessionId)
    this.seenChatKeys.add(key)
    this.saveSessionMap()
    this.handles.delete(key)
    return 'ok'
  }

  /**
   * Release a session that a chat is leaving (its previous binding) when that
   * session is owned by nobody else. The chat is about to be rebound to
   * `nextSessionId`, so we only need to sever the old session→chat association
   * and drop any live handle so the old session never routes cards back to
   * this chat. Does NOT reset the chat (unlike {@link detachSession}, which
   * reassigns the owner) — that would clobber the pending rebind.
   */
  private releaseSessionForChat(sessionId: string, chatKey: string, nextSessionId: string): void {
    if (this.deps.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
      // An archived session is already out of rotation; nothing to sever.
      return
    }
    // Remove any handle keyed by this chat that still points at the old
    // session's live agent, so a fresh one is built for the new session.
    this.handles.delete(chatKey)
    this.saveSessionMap()
    console.log(`dsh-feishu: released previous session ${sessionId} for ${chatKey} → next ${nextSessionId}`)
  }

  /**
   * Whether this chat needs the first-message onboarding card (attach an
   * existing session or create a new one) instead of auto-creating a session.
   * A chat needs onboarding when it has no explicit `/new`/`/session`/attach
   * override AND its default-derived session has no persisted history yet —
   * i.e. the dialog (or a fresh install) has never run a real conversation.
   */
  async needsOnboarding(message: ConversationMessage): Promise<boolean> {
    const key = conversationKey(message)
    if (this.chatToSession.has(key)) return false
    const defaultId = toSessionId(this.config.domain, key)
    const persisted = await this.deps.sessionPersistence.list()
    return !persisted.some(item => this.persistedIdOf(item) === defaultId)
  }

  /** Read the creation options captured for one chat (if any). */
  creationOptionsFor(message: ConversationMessage): ChatCreationOptions | undefined {
    return this.chatToCreation.get(conversationKey(message))
  }

  /**
   * Reverse-lookup: given a session id, return the chat coordinates that own
   * it (honoring any active `/new` or `/session` override). Used by the
   * Feishu questions listener, which receives session-keyed `question/requested`
   * frames from the apiproxy mux stream and needs to know which chat to render
   * the option card in. Returns `undefined` when the session is owned by no
   * chat — for example, a session created by the WebUI directly, which the
   * Lark channel has no business messaging.
   */
  resolveChat(sessionId: string): ConversationMessage | undefined {
    for (const [key, mapped] of this.chatToSession) {
      if (mapped === sessionId) return this.attachRootId(key, this.messageFromKey(key))
    }
    // No override: the session id is the deterministic hash of some chat key.
    // Hash prefixes are `lark-v2-<domain>:<key-hash>` (see `toSessionId`); we
    // cannot reverse the hash, but we can iterate the currently live agents
    // this bridge manages and find the one whose deterministic session id
    // matches. The bridge's `handles` keys are the chat keys themselves, so
    // we read them directly.
    for (const key of this.handles.keys()) {
      const derived = toSessionId(this.config.domain, key)
      if (derived === sessionId) return this.attachRootId(key, this.messageFromKey(key))
    }
    return undefined
  }

  /**
   * Remember who last spoke in a chat.
   *
   * Only a Feishu user open id (`ou_…`) is accepted: the value is used to grant
   * a document collaborator permission, and an app/bot id there would be
   * meaningless. The channel calls this on every inbound message.
   *
   * @param chatId - the chat the message arrived in.
   * @param senderId - the normalized message's sender id (may be absent).
   */
  noteInboundSender(chatId: string, senderId?: string): void {
    if (typeof senderId !== 'string' || !senderId.startsWith('ou_')) return
    if (this.chatToSender.get(chatId) === senderId) return
    this.chatToSender.set(chatId, senderId)
    // Persist on change only: a chat usually has one speaker, so this is one
    // write per new participant rather than one per message.
    this.saveSessionMap()
  }

  /**
   * The most recent inbound sender's open id for a chat, if one was seen.
   *
   * @param chatId - the chat to look up.
   * @returns the open id, or undefined for a chat no user message has reached.
   */
  lastSenderFor(chatId: string): string | undefined {
    return this.chatToSender.get(chatId)
  }

  /** Attach the stored topic root id (if any) to a reconstructed chat message. */
  private attachRootId(key: string, message: ConversationMessage): ConversationMessage {
    const rootId = this.chatToRootId.get(key)
    return rootId === undefined ? message : { ...message, rootId }
  }

  /**
   * Record the topic root message id of an inbound topic message. Must be
   * called for EVERY inbound message — agent turns and slash commands alike —
   * because this map is the only topic bookkeeping that outlives a restart:
   * a turn driven from the WebUI (or from a Feishu card button) has no inbound
   * message of its own, so `resolveChat` has to supply the coordinates from
   * here. Without a root the send path degrades to `im.v1.message.create`,
   * which posts a new top-level message — in a topic group that is a brand-new
   * topic, i.e. the bot's cards leak out of the topic they belong to.
   *
   * Re-recording re-appends the key, so map (and file) order tracks recency;
   * {@link topicFor} relies on that.
   */
  noteTopic(message: ConversationMessage): void {
    if (message.threadId === undefined) return
    const rootId = message.rootId
    if (rootId === undefined || rootId === '') return
    const key = conversationKey(message)
    const known = this.chatToRootId.get(key)
    const firstSight = !this.seenChatKeys.has(key)
    // delete() + set() moves an existing key to the end of the map.
    this.chatToRootId.delete(key)
    this.chatToRootId.set(key, rootId)
    if (known === rootId && !firstSight) return
    this.seenChatKeys.add(key)
    this.saveSessionMap()
  }

  /**
   * The topic this chat most recently used, for flows whose card-action
   * callbacks carry only `chatId` + `messageId` (never the thread). Restored
   * from disk, so a card left over from before a restart still replies into
   * its own topic.
   *
   * Returns `{}` — not a half-known topic — when the root is missing: handing
   * callers a `threadId` without its `rootId` only lets them build
   * `{ replyInThread: true }` with no `replyTo`, which is the silent top-level
   * fallback {@link noteTopic} exists to prevent.
   */
  topicFor(chatId: string): { rootId?: string; threadId?: string } {
    // Iterate most-recent-last and keep the final hit.
    let found: { rootId: string; threadId: string } | undefined
    for (const [key, rootId] of this.chatToRootId) {
      const parts = parseChatKey(key)
      if (parts.chatId !== chatId) continue
      if (parts.threadId === undefined || parts.threadId === '') continue
      found = { threadId: parts.threadId, rootId }
    }
    return found ?? {}
  }

  /**
   * Topics this bridge knows about but has no root message id for. A binding
   * restored from an older state file (written before roots were persisted) or
   * one that only ever saw slash commands lands here; the caller resolves each
   * root through the Feishu API once (see `fetchThreadRootId`) and feeds it
   * back via {@link setTopicRoot}.
   */
  missingTopicRoots(): Array<{ chatId: string; threadId: string }> {
    const missing: Array<{ chatId: string; threadId: string }> = []
    const seen = new Set<string>()
    for (const key of this.allChatKeys()) {
      if (this.chatToRootId.has(key)) continue
      const parts = parseChatKey(key)
      if (parts.threadId === undefined || parts.threadId === '') continue
      const threadKey = `${parts.chatId}\0${parts.threadId}`
      if (seen.has(threadKey)) continue
      seen.add(threadKey)
      missing.push({ chatId: parts.chatId, threadId: parts.threadId })
    }
    return missing
  }

  /** Record a topic root resolved outside Feishu's push stream. */
  setTopicRoot(chatId: string, threadId: string, rootId: string): void {
    this.noteTopic({ chatId, chatType: 'p2p', threadId, rootId })
  }

  /** Every chat key this bridge knows: explicit bindings plus seen chats. */
  private allChatKeys(): string[] {
    const keys = new Set<string>(this.chatToSession.keys())
    for (const key of this.seenChatKeys) keys.add(key)
    return [...keys]
  }

  /**
   * Reconstruct a {@link ConversationMessage} from the chat key produced by
   * {@link conversationKey}. The key is sufficient for `resolveSessionId`
   * because only `chatId` and (optionally) `threadId` participate in the
   * hash; `chatType` is irrelevant for the session id and is filled with the
   * harmless `'p2p'` default.
   */
  private messageFromKey(key: string): ConversationMessage {
    const parts = parseChatKey(key)
    return parts.threadId === undefined
      ? { chatId: parts.chatId, chatType: 'p2p' }
      : { chatId: parts.chatId, chatType: 'p2p', threadId: parts.threadId }
  }

  /**
   * Direct the chat to a fresh, never-used session id so the next regular
   * message starts a brand-new conversation. The previously bound session,
   * if any, is left untouched in the agents registry; the bridge just
   * forgets it. Returns the new session id.
   *
   * The new id is the deterministic hash of the chat key plus a
   * caller-supplied salt so two consecutive `/new` calls in the same chat
   * produce different sessions.
   */
  startNewSession(message: ConversationMessage, salt: string, options?: ChatCreationOptions): string {
    const key = conversationKey(message)
    const newSessionId = toSessionId(this.config.domain, `${key}\0${salt}`)
    this.chatToSession.set(key, newSessionId)
    this.config.onBindingChanged?.(message, newSessionId)
    this.seenChatKeys.add(key)
    if (options !== undefined) this.chatToCreation.set(key, options)
    this.saveSessionMap()
    this.handles.delete(key)
    return newSessionId
  }

  /**
   * Redirect the chat to an existing persisted session so the next regular
   * message resumes it. The session id must already exist in
   * `sessionPersistence` and must not be in the workspace archive set;
   * archived sessions are hidden from `/session` so switching to one would
   * silently strand the next message on a session the user can no longer see.
   *
   * Refuses to redirect onto a session owned by a DIFFERENT chat key so two
   * dialog surfaces (main chat + topics) never share one session. Switching
   * back to a session the same chat already owns is a no-op success.
   *
   * @returns `'ok'` when the override was applied, `'archived'` when the
   *   session is archived (caller surfaces a translated rejection), and
   *   `'occupied'` when another chat key currently owns the session.
   */
  switchToSession(message: ConversationMessage, sessionId: string): 'ok' | 'archived' | 'occupied' {
    if (this.deps.workspaceRegistry.archivedSessionIds.includes(sessionId)) return 'archived'
    const key = conversationKey(message)
    const owner = this.sessionOwnerKey(sessionId)
    if (owner !== undefined && owner !== key) return 'occupied'
    const changed = (this.chatToSession.get(key) ?? toSessionId(this.config.domain, key)) !== sessionId
    this.chatToSession.set(key, sessionId)
    if (changed) this.config.onBindingChanged?.(message, sessionId)
    this.seenChatKeys.add(key)
    this.saveSessionMap()
    this.handles.delete(key)
    return 'ok'
  }

  /**
   * List every persisted session for this bridge's domain, newest first. The
   * session title comes from the latest `session/title` event on the live
   * agent's log when one is attached; cold sessions have no in-memory log to
   * read from so the title falls back to a short id-derived hint. The
   * `updatedAt` is the latest event timestamp.
   *
   * Sessions in the workspace archive set are filtered out so the chat listing
   * matches what the webui hides from its session tree. Live blank sessions
   * (DSH-created placeholders with no user turn yet) are also filtered. Cold
   * blank sessions remain visible because the bridge has no projection service
   * to read their `blank` bit.
   */
  async listSessions(): Promise<Array<{ id: string; updatedAt: number; title: string; ownedBy?: string; agentPreset?: string }>> {
    const persisted = await this.deps.sessionPersistence.list()
    const archived = new Set(this.deps.workspaceRegistry.archivedSessionIds)
    // Resolve preset ids to display names once, when the roster is available.
    const presetDisplay: Record<string, string> = {}
    if (typeof this.deps.agentPresets.list === 'function') {
      try {
        for (const row of await this.deps.agentPresets.list()) {
          presetDisplay[row.id] = row.name !== undefined && row.name !== '' ? row.name : row.id
        }
      } catch {
        // Roster read failure: fall back to showing preset ids below.
      }
    }
    const entries: Array<{ id: string; updatedAt: number; title: string; ownedBy?: string; agentPreset?: string }> = []
    for (const item of persisted) {
      const itemId = this.persistedIdOf(item)
      if (archived.has(itemId)) continue
      const live = this.deps.agents.get(itemId as never)
      let updatedAt = 0
      let title = ''
      let blank = false
      let presetId = ''
      let subagent = false
      let events: ReadonlyArray<{ seq: number; type: string; data: any; time?: number }> | undefined
      if (live !== undefined) {
        // A live session's facts come from the host's maintained projection
        // state (`title`, `agentPreset`, and the list metadata's blank bit and
        // last-prompt time). That is the intended replacement for the
        // deprecated in-memory event snapshot, and it is what the Web UI's own
        // list reads — so `/session` cannot disagree with it.
        const projected = this.liveListState(live)
        if (projected !== undefined) {
          title = projected.title
          presetId = projected.agentPreset
          blank = projected.blank
          updatedAt = projected.updatedAt
        } else {
          // No projection service (older host): keep the existing replay.
          // `snapshotEvents` may stay unmigrated, but this adds no new caller.
          events = this.readSessionEvents(live as unknown as AgentLike)
          const header = item.header as { agentPreset?: unknown } | undefined
          presetId = typeof header?.agentPreset === 'string' ? header.agentPreset : ''
        }
        // `origin` is a durable-header fact in both paths.
        subagent = (item.header as { origin?: unknown } | undefined)?.origin === 'subagent'
      } else {
        // Cold session: ask SessionPersistence for the on-disk log (0.1.3
        // `open(id,'read')`/alpha.4 `readFrom`) so cold sessions still expose
        // their latest `session/title` event and `turn/start` bit.
        const result = await this.readColdSession(itemId)
        if (result !== undefined) {
          events = result.events as ReadonlyArray<{ seq: number; type: string; data: any; time?: number }>
          const meta = result.meta as { agentPreset?: string; createdAt?: number; origin?: unknown } | undefined
          presetId = meta?.agentPreset ?? ''
          subagent = meta?.origin === 'subagent'
          const metaTime = Number(meta?.createdAt ?? 0)
          if (metaTime > updatedAt) updatedAt = metaTime
        }
      }
      // Subagent-routed sessions live under their parent's delegation tree and
      // are surfaced there, not in the main session list. Hide them here so
      // `/session` matches the webui's tree (which shows only non-child
      // sessions); a fork is a user-facing session (parentSession without
      // `origin:'subagent'`) and stays visible.
      if (subagent) continue
      if (events !== undefined) {
        for (const event of events) {
          const seqTime = Number((event as { time?: number }).time ?? 0)
          if (seqTime > updatedAt) updatedAt = seqTime
          if (event.type === 'session/title') {
            const next = (event as { data?: { title?: unknown } }).data?.title
            if (typeof next === 'string' && next !== '') title = next
          }
          if (event.type === 'agent-preset/selected') {
            const next = (event as { data?: { agentPreset?: unknown } }).data?.agentPreset
            if (typeof next === 'string' && next !== '') presetId = next
          }
        }
        blank = !events.some(event => event.type === 'turn/start')
      }
      if (blank) continue
      const ownerKey = this.sessionOwnerKey(itemId)
      const agentPreset = presetId === '' ? undefined : (presetDisplay[presetId] ?? presetId)
      entries.push({
        id: itemId,
        updatedAt,
        title,
        ...(ownerKey === undefined ? {} : { ownedBy: ownerKey }),
        ...(agentPreset === undefined ? {} : { agentPreset }),
      })
    }
    entries.sort((left, right) => right.updatedAt - left.updatedAt)
    return entries
  }

  /**
   * The workspace (cwd) a session runs in, read from its creation header.
   *
   * Cached per session — the header is written once and cannot change — and read
   * with `maxEvents: 1`, so learning a session's cwd never replays its whole
   * log. Used by the card-image hydrator to resolve the relative paths a model
   * writes (`![图](runs/a.png)`) without trusting anything outside that root.
   *
   * @param sessionId - the DSH session id.
   * @returns the workspace path, or the configured default when the header has none.
   */
  async workspaceOf(sessionId: string): Promise<string | undefined> {
    const cached = this.workspaceCache.get(sessionId)
    if (cached !== undefined) return cached === '' ? undefined : cached
    let workspace: string | undefined
    const cold = await this.readColdSession(sessionId, 1)
    const header = cold?.meta as { cwd?: string } | undefined
    if (typeof header?.cwd === 'string' && header.cwd !== '') workspace = header.cwd
    else if (this.config.workspace !== undefined && this.config.workspace !== '') workspace = this.config.workspace
    this.workspaceCache.set(sessionId, workspace ?? '')
    return workspace
  }

  /**
   * Read the live metadata for one chat's current session: workspace path,
   * agent preset id, and current model selection. Used by the reply-card
   * footer and the `/status` command.
   *
   * Reads from the live agent's session events (persisted sessions) or
   * from the bridge's in-memory creation metadata. Returns empty strings
   * when the session has not been created yet.
   */
  async getSessionMeta(message: ConversationMessage): Promise<{
    sessionId: string; workspace: string; agentPreset: string; model: string; reasoningEffort: string; title: string
    turns: number; steps: number; toolCalls: number; inputTokens: number; outputTokens: number
    contextWindow: number; lastInputTokens: number
    cacheHitRate: number; ttftAvgMs: number; tokensPerSecond: number; llmDurationMs: number; toolDurationMs: number
  }> {
    const sessionId = this.resolveSessionId(message)
    let model = this.deps.selection()
    let reasoningEffort = model.reasoningEffort ? String(model.reasoningEffort) : ''
    const empty = { title: '', turns: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, contextWindow: 0, lastInputTokens: 0, cacheHitRate: 0, ttftAvgMs: 0, tokensPerSecond: 0, llmDurationMs: 0, toolDurationMs: 0 }
    // Try reading the session header + events from persistence (0.1.3
    // `open(id,'read')` / alpha.4 `readFrom`).
    const cold = await this.readColdSession(sessionId)
    if (cold !== undefined) {
      try {
        const header = cold.meta as { cwd?: string; agentPreset?: string } | undefined
        const ws = header?.cwd ?? this.config.workspace ?? ''
        let preset = header?.agentPreset ?? this.config.agentPreset ?? ''
        const events = cold.events as ReadonlyArray<{ type: string; data: any }>
        const stats = this.deriveSessionStats(events)
        // Prefer the latest request header recorded in the session log over the
        // bridge's in-memory selection ref: a WebUI model switch updates
        // apiProxy's selectionFor(agent).current without touching bridge.selections,
        // so the ref here can lag behind the model actually used in the last turn.
        let latestConfig: { provider?: string; model?: string; reasoningEffort?: string } | undefined
        for (const event of events) {
          if (event?.type === 'agent-preset/selected' && typeof event?.data?.agentPreset === 'string' && event.data.agentPreset !== '') {
            // A blank-session preset switch records `agent-preset/selected` but
            // never rewrites the creation header, so the event — not
            // `header.agentPreset` — is the authority for the effective preset.
            // The WebUI projection reads it; mirror that here so `/status`
            // matches the webui and `/session list` instead of showing the
            // stale creation preset.
            preset = event.data.agentPreset
          }
          if (event?.type === 'request/header' && event.data?.header?.config) {
            latestConfig = event.data.header.config
          }
        }
        if (latestConfig?.provider !== undefined && latestConfig?.model !== undefined) {
          const effort = latestConfig.reasoningEffort
          model = {
            provider: latestConfig.provider,
            model: latestConfig.model,
            ...(effort === undefined ? {} : { reasoningEffort: effort as ReasoningEffortId }),
          }
          reasoningEffort = effort ? String(effort) : ''
        }
        const agentPreset = await this.resolvePresetDisplayName(preset)
        return { sessionId, workspace: ws, agentPreset, model: `${model.provider}/${model.model}`, reasoningEffort, ...stats }
      } catch { /* fall through to config defaults */ }
    }
    const agentPreset = await this.resolvePresetDisplayName(this.config.agentPreset ?? '')
    return { sessionId, workspace: this.config.workspace ?? '', agentPreset, model: `${model.provider}/${model.model}`, reasoningEffort, ...empty }
  }

  /**
   * Resolve the model that THIS session actually runs, read from its persisted
   * log. `agentDefaultModel.currentSelection()` is only the global default for
   * agents without a session-specific selection — a WebUI switch or session
   * creation can set a per-session model that never touches that default, so
   * the default alone is NOT the authority. The `request/header` config is
   * what each turn was actually dispatched with, so the latest one is the
   * authoritative "current". Returns `undefined` when the session has no
   * recorded model (fresh/uncreated) so callers fall back to the default.
   */
  async sessionCurrentSelection(message: ConversationMessage): Promise<ModelSelection | undefined> {
    const sessionId = this.resolveSessionIdFor(message)
    if (sessionId === '') return undefined
    const cold = await this.readColdSession(sessionId)
    if (cold === undefined) return undefined
    let selection: ModelSelection | undefined
    for (const event of cold.events) {
      if (event?.type === 'request/header' && event.data?.header?.config) {
        const c = event.data.header.config as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined
        if (typeof c?.provider === 'string' && typeof c?.model === 'string') {
          selection = {
            provider: c.provider,
            model: c.model,
            ...(typeof c.reasoningEffort === 'string' && c.reasoningEffort !== ''
              ? { reasoningEffort: c.reasoningEffort as ReasoningEffortId }
              : {}),
          }
        }
      }
    }
    return selection
  }

  /**
   * Derive session statistics from event log, mirroring the WebUI's
   * tokenUsage + contextPressure projections.
   *
   * Token accounting uses last-wins per turn/step (matching the WebUI's
   * `tokenUsageProjectionDefinition`): when an LLM step retries (same
   * turn+step), the later usage replaces the earlier one rather than
   * double-counting. `outputTokens` accumulates across all unique steps.
   * `inputTokens` = billed input (uncached + cacheRead + cacheWrite).
   *
   * Also processes `assistant/chunk` events with `chunk.type === 'usage'`
   * for early usage samples (same last-wins semantics per turn/step).
   */
  private deriveSessionStats(events: ReadonlyArray<{ type: string; data: any; time?: number }>): {
    title: string; turns: number; steps: number; toolCalls: number; inputTokens: number; outputTokens: number
    contextWindow: number; lastInputTokens: number
    cacheHitRate: number; ttftAvgMs: number; tokensPerSecond: number; llmDurationMs: number; toolDurationMs: number
  } {
    const turns = new Set<number>()
    let steps = 0
    let toolCalls = 0
    let title = ''
    let contextWindow = 0

    // Last-wins per turn/step for input tokens (matches WebUI projection).
    // key = `${turn}:${step}` → billed input tokens for that step.
    const stepInput = new Map<string, number>()
    let totalOutput = 0
    let totalCacheRead = 0
    let totalUncachedInput = 0

    // Track the latest usage sample for context % display.
    let lastInputTokens = 0

    // Timing: track per-step anchors for TTFT and decode.
    let stepStartTime = 0
    let firstTokenTime = 0
    let ttftSum = 0
    let ttftCount = 0
    let decodeMsSum = 0
    let outputForDecode = 0

    // Tool call timing: callId → startTime.
    const toolStarts = new Map<string, number>()
    let toolDurationMs = 0

    for (const event of events) {
      const t = event.time ?? 0
      if (event.type === 'turn/start') {
        turns.add((event.data?.turn as number | undefined) ?? turns.size)
      } else if (event.type === 'step/start') {
        steps++
        stepStartTime = t
        firstTokenTime = 0
      } else if (event.type === 'assistant/chunk') {
        const chunk = event.data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0 && firstTokenTime === 0) {
          firstTokenTime = t
        } else if (firstTokenTime === 0 && chunk !== undefined && chunk !== null && isTokenDelta(chunk)) {
          firstTokenTime = t
        }
      } else if (event.type === 'tool/call') {
        toolCalls++
        const callId = event.data?.callId as string | undefined
        if (callId !== undefined) toolStarts.set(callId, t)
      } else if (event.type === 'tool/result') {
        const callId = event.data?.message?.source?.callId as string | undefined
        if (callId !== undefined) {
          const start = toolStarts.get(callId)
          if (start !== undefined && t > start) {
            toolDurationMs += t - start
            toolStarts.delete(callId)
          }
        }
      } else if (event.type === 'assistant/message' || (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage')) {
        const turn = event.data?.turn as number | undefined
        const step = event.data?.step as number | undefined
        // For assistant/message, usage is at data.usage; for assistant/chunk, at data.chunk.usage
        const usage = event.type === 'assistant/message'
          ? event.data?.usage
          : event.data?.chunk?.usage
        if (usage !== undefined && usage !== null) {
          const iTokens = usage.inputTokens as number | undefined
          const oTokens = usage.outputTokens as number | undefined
          const crTokens = (usage.cacheReadTokens ?? 0) as number
          const cwTokens = (usage.cacheWriteTokens ?? 0) as number
          if (turn !== undefined && step !== undefined && iTokens !== undefined) {
            // Last-wins: replace previous value for same turn+step.
            const key = `${turn}:${step}`
            const billed = iTokens + crTokens + cwTokens
            stepInput.set(key, billed)
          }
          if (oTokens !== undefined) totalOutput += oTokens
          if (iTokens !== undefined) {
            lastInputTokens = iTokens + crTokens + cwTokens
            totalUncachedInput += iTokens
            totalCacheRead += crTokens
          }
        }
        // TTFT and decode time for assistant/message events.
        if (event.type === 'assistant/message' && stepStartTime > 0) {
          // 0.1.3: `assistant/chunk` events no longer exist, so firstTokenTime
          // was never set here. Recover it from the message's lossless compact
          // stream (the only surviving source of first-token timing).
          if (firstTokenTime === 0) {
            const rawStream = Array.isArray(event.data?.stream)
              ? event.data.stream as readonly AssistantStreamRecord[]
              : undefined
            if (rawStream !== undefined) {
              try {
                for (const timed of expandAssistantStream(rawStream)) {
                  const chunk = timed.chunk
                  if (isTokenDelta(chunk)) {
                    firstTokenTime = timed.time
                    break
                  }
                }
              } catch {
                // leave firstTokenTime at 0 — TTFT/decode simply not shown
              }
            }
          }
          if (firstTokenTime > 0 && firstTokenTime >= stepStartTime) {
            ttftSum += firstTokenTime - stepStartTime
            ttftCount++
          }
          if (firstTokenTime > 0 && t > firstTokenTime) {
            decodeMsSum += t - firstTokenTime
            const oTokens = usage?.outputTokens as number | undefined
            if (oTokens !== undefined) outputForDecode += oTokens
          }
        }
      } else if (event.type === 'session/title') {
        const next = event.data?.title
        if (typeof next === 'string' && next !== '') title = next
      } else if (event.type === 'request/context') {
        const cw = event.data?.contextWindow as number | undefined
        if (cw !== undefined && cw > 0) contextWindow = cw
      }
    }

    // Sum the surviving (non-replaced) per-step input tokens.
    let inputTokens = 0
    for (const v of stepInput.values()) inputTokens += v

    // Derived metrics.
    const totalInputForCache = totalUncachedInput + totalCacheRead
    const cacheHitRate = totalInputForCache > 0 ? Math.round(totalCacheRead / totalInputForCache * 100) : 0
    const ttftAvgMs = ttftCount > 0 ? Math.round(ttftSum / ttftCount) : 0
    const tokensPerSecond = decodeMsSum > 0 && outputForDecode > 0
      ? Math.round(outputForDecode / (decodeMsSum / 1000))
      : 0
    const llmDurationMs = decodeMsSum + ttftSum


    return { title, turns: turns.size, steps, toolCalls, inputTokens, outputTokens: totalOutput, contextWindow, lastInputTokens, cacheHitRate, ttftAvgMs, tokensPerSecond, llmDurationMs, toolDurationMs }
  }

  /** Mark a session as having sent intermediate assistant message cards. */
  markIntermediateSent(sessionId: string): void {
    this.intermediateSent.add(sessionId)
  }

  /** Check and consume the intermediate-sent flag for a session. Returns true if intermediate cards were sent. */
  consumeIntermediateSent(sessionId: string): boolean {
    if (!this.intermediateSent.has(sessionId)) return false
    this.intermediateSent.delete(sessionId)
    return true
  }

  /**
   * Withdraw the intermediate-sent flag without consuming it.
   *
   * Streaming marks the flag optimistically when it hands a text-carrying card
   * to Feishu, then calls this from `flushed()` when no such card was ever
   * confirmed delivered. Without it, one failed card send made channel.ts skip
   * its own reply and the answer disappeared entirely (2026-09-21, key pitfall
   * 29).
   */
  clearIntermediateSent(sessionId: string): void {
    this.intermediateSent.delete(sessionId)
  }

  /** Resolve the session id for a chat message (used by streaming module). */
  resolveSessionIdFor(message: ConversationMessage): string {
    return this.resolveSessionId(message)
  }

  /** Marker kept to silence trailing whitespace edits. */
  private getOrCreate(key: string): Promise<AgentHandleLike> {
    let pending = this.handles.get(key)
    if (pending !== undefined) return pending
    pending = this.createAgent(key).catch((error: unknown) => {
      this.handles.delete(key)
      throw error
    })
    this.handles.set(key, pending)
    return pending
  }

  private async createAgent(key: string): Promise<AgentHandleLike> {
    // The chat key is `chat:<chatId>` or `thread:<chatId>:<threadId>`; build a
    // minimal ConversationMessage so `resolveSessionId` can honor the chat→session
    // override populated by `/new` or `/session`.
    const creation = this.chatToCreation.get(key)
    const sessionId = this.resolveSessionId(this.messageFromKey(key))
    const liveAgent = this.deps.agents.get(sessionId as never)
    if (liveAgent !== undefined) {
      // The session controller maintains its own WeakMap<Agent, InstalledSelection>
      // via the apiproxy replacement; live agent selection is owned upstream.
      // The plugin just hands the live agent back.
      return { agent: liveAgent as unknown as AgentLike, dispose: async () => undefined }
    }
    const configuredWorkspace = creation?.workspace ?? this.config.workspace
    const workspace = configuredWorkspace === undefined
      ? this.deps.workspaceRegistry.list()[0]
      : await this.deps.workspaceRegistry.resolveByPath(configuredWorkspace)
    // Use the workspace's actual path as cwd to ensure consistency
    // When no workspace is configured, use the first workspace's path
    const cwd = workspace?.path ?? configuredWorkspace ?? process.cwd()
    const persisted = (await this.deps.sessionPersistence.list()).some(item => this.persistedIdOf(item) === sessionId)
    // A resumed session must run on the model route it recorded, not on
    // whatever the deployment default happens to be right now — see
    // {@link recordedRoute} (关键坑 59). Creation still wins: `/new <model>` and
    // the new-session card carry an explicit route.
    const recorded = persisted ? await this.recordedRoute(sessionId) : undefined
    const fallback = this.deps.selection()
    const initial = {
      provider: creation?.provider ?? recorded?.provider ?? this.config.provider ?? fallback.provider,
      model: creation?.model ?? recorded?.model ?? this.config.model ?? fallback.model,
      ...(creation?.reasoningEffort !== undefined
        ? { reasoningEffort: creation.reasoningEffort }
        : recorded?.reasoningEffort !== undefined
          ? { reasoningEffort: recorded.reasoningEffort }
          : fallback.reasoningEffort !== undefined
            ? { reasoningEffort: fallback.reasoningEffort }
            : {}),
    } satisfies ModelSelection
    // A rehydrated session must run under the preset it recorded, not under the
    // bridge's configured default. The creation header is only a creation fact
    // (a blank-session switch records `agent-preset/selected` instead), and the
    // host recomposes from its `agentPreset` Session projection; mounting
    // `configuredPreset` here silently swapped every resumed chat onto
    // `agentPresets.defaultId` — the header kept saying `cordis` while the
    // toolset and skill catalog were `standard`'s.
    const configuredPreset = creation?.agentPreset ?? this.config.agentPreset
    const agentPreset = persisted
      ? await this.resumePreset(sessionId, configuredPreset)
      : (await this.deps.agentPresets.resolve(configuredPreset)).id
    const setup = async (agentCtx: import('@deepseek-ai/cordis').Context) => {
      await this.deps.agentPresets.mount(agentCtx, agentPreset)
    }
    const handle = persisted
      ? await this.deps.agents.resume({ resumeSessionId: sessionId, agentOptions: initial, setup })
      : await this.deps.agents.create({
        sessionId,
        meta: { cwd, agentPreset },
        agentOptions: initial,
        setup,
      })
    // Only attach workspace for newly created sessions. Persisted sessions
    // are already attached to their original workspace and re-attaching
    // fails when the cwd stored in the session header doesn't match the
    // current config's workspace path.
    if (!persisted) {
      try {
        await workspace?.attachSession(sessionId)
      } catch (error: unknown) {
        await handle.dispose()
        throw error
      }
      await this.applyCreationRoute(sessionId, creation)
    }
    return handle
  }

  /**
   * Read the model route a persisted session last ran on.
   *
   * The upstream loop takes a live Agent's route from the `agentOptions` its
   * creator passed: the session's own logged `request/header` only donates a
   * reasoning effort, and only when provider and model already match
   * (`agent-loop`). The session controller normally installs a selection
   * listener that prefers the session's own route, but this bridge creates and
   * resumes its agents through `agents` directly, so no listener exists and
   * `agentOptions` decides. Without this read every re-created chat came back on
   * the deployment default — i.e. on whatever model was picked last anywhere,
   * because `selectModel` persists that pick as the default — which silently
   * switched long-lived chats (关键坑 59).
   *
   * Precedence inside the log: the last explicit `model/selection` (the user or
   * this plugin chose it), else the last `request/header` that is not a
   * `resume` (the route the session last ran on under its own process), else the
   * first `request/header`. The log is scanned in bounded chunks and never
   * cached, so a route changed while the agent was live still wins.
   * @param sessionId - persisted session to inspect.
   * @returns the recorded route, or `undefined` when the log records none (the
   *   caller then falls back to configuration and the deployment default).
   */
  private async recordedRoute(sessionId: string): Promise<ModelSelection | undefined> {
    const persistence = this.deps.sessionPersistence
    const open = typeof persistence.open === 'function' ? persistence.open.bind(persistence) : undefined
    const readFrom = typeof persistence.readFrom === 'function' ? persistence.readFrom.bind(persistence) : undefined
    if (open === undefined && readFrom === undefined) return undefined
    const CHUNK = 512
    let chosen: ModelSelection | undefined
    let owned: ModelSelection | undefined
    let first: ModelSelection | undefined
    const routeOf = (raw: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined): ModelSelection | undefined => {
      if (typeof raw?.provider !== 'string' || typeof raw.model !== 'string') return undefined
      return {
        provider: raw.provider,
        model: raw.model,
        ...(typeof raw.reasoningEffort === 'string' ? { reasoningEffort: raw.reasoningEffort as never } : {}),
      }
    }
    try {
      const handle = open === undefined ? undefined : await open(sessionId as never, 'read')
      try {
        let offset = 0
        for (;;) {
          const result = handle !== undefined
            ? await handle.read(offset, CHUNK)
            : readFrom === undefined ? undefined : await readFrom(sessionId as never, offset)
          if (result === undefined) break
          const events = (result as { events?: ReadonlyArray<unknown> })?.events
            ?? (result as unknown as ReadonlyArray<unknown>)
          if (!Array.isArray(events) || events.length === 0) break
          for (const event of events) {
            const row = event as { type?: unknown; data?: any }
            if (row.type === 'model/selection') {
              chosen = routeOf(row.data) ?? chosen
            } else if (row.type === 'request/header') {
              const route = routeOf(row.data?.header?.config)
              if (route !== undefined) {
                first ??= route
                if (row.data?.reason !== 'resume') owned = route
              }
            }
          }
          offset += events.length
          // `readFrom` returns the whole tail per call, so one pass is enough.
          if (handle === undefined || events.length < CHUNK) break
        }
      } finally {
        await handle?.close().catch(() => undefined)
      }
    } catch {
      // An unreadable log must never block the chat: fall back to configuration.
      return undefined
    }
    return chosen ?? owned ?? first
  }

  /**
   * Resolve the preset to mount when rehydrating a persisted session.
   *
   * The preset the session actually ran under wins over the bridge's configured
   * default. A stored id the running install cannot resolve (for example a
   * preset that only existed as a scanned directory, which 0.1.7's registry no
   * longer discovers) must not block the resume: fall back to the configured
   * preset and say so, instead of failing every message in the chat.
   * @param sessionId - persisted session being rehydrated.
   * @param configuredPreset - bridge-configured preset, used for new sessions and as the fallback.
   * @returns the resolved preset id to mount.
   */
  private async resumePreset(sessionId: string, configuredPreset: string | undefined): Promise<string> {
    const stored = await this.storedAgentPreset(sessionId)
    if (stored === undefined) return (await this.deps.agentPresets.resolve(configuredPreset)).id
    try {
      return (await this.deps.agentPresets.resolve(stored)).id
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`dsh-feishu: session ${sessionId} recorded agent preset "${stored}", which this install cannot resolve; resuming with ${configuredPreset ?? 'the default preset'} instead: ${message}`)
      return (await this.deps.agentPresets.resolve(configuredPreset)).id
    }
  }

  /**
   * Read one live Session's list facts from the host's projection state.
   *
   * `title` and `agentPreset` are the units the host maintains for exactly this
   * purpose, and `sessionListMetadata` is what the Web UI's session list uses
   * for its blank bit and recency (`updatedAt = max(header.createdAt,
   * lastPromptAt)`), so the chat list and the Web UI list agree by
   * construction instead of by two independent log scans.
   * @param agent - live agent whose session is read.
   * @returns the list facts, or `undefined` when the projection service or the
   *   list-metadata unit is unavailable (the caller then replays the log).
   */
  private liveListState(agent: AgentLike): { title: string; agentPreset: string; blank: boolean; updatedAt: number } | undefined {
    const projections = this.deps.sessionProjections
    if (projections === undefined) return undefined
    try {
      const session = (agent as unknown as { session: unknown }).session
      const metadata = projections.stateOf(session, 'sessionListMetadata') as { blank?: unknown; lastPromptAt?: unknown } | undefined
      // The blank bit decides whether the session is listed at all, so without
      // it there is nothing worth projecting.
      if (metadata === undefined) return undefined
      const title = projections.stateOf(session, 'title')
      const preset = projections.stateOf(session, 'agentPreset')
      const createdAt = Number((session as { header?: { createdAt?: unknown } })?.header?.createdAt ?? 0)
      const lastPromptAt = Number(metadata.lastPromptAt ?? 0)
      return {
        title: typeof title === 'string' ? title : '',
        agentPreset: typeof preset === 'string' ? preset : '',
        blank: metadata.blank === true,
        updatedAt: Math.max(Number.isFinite(createdAt) ? createdAt : 0, Number.isFinite(lastPromptAt) ? lastPromptAt : 0),
      }
    } catch {
      // A projection read must never break the session list.
      return undefined
    }
  }

  /**
   * Read the preset a persisted session actually ran under: its durable header,
   * overridden by the latest committed `agent-preset/selected`. This mirrors the
   * host's `agentPreset` Session projection — the same rule
   * {@link getSessionMeta} follows for display — so what a card prints and what
   * the agent mounts cannot disagree.
   * @param sessionId - persisted session to read.
   * @returns the recorded preset id, or `undefined` when persistence has no seam.
   */
  private async storedAgentPreset(sessionId: string): Promise<string | undefined> {
    // `agent-preset/selected` is only ever appended while the session is blank
    // (the registry guards it with the `turnBoundary` projection), so it always
    // precedes the first `turn/start`. Reading the log's head is therefore
    // enough, and keeps a resume from pulling a 100 MB session log into memory.
    let cold = await this.readColdSession(sessionId, PRESET_SCAN_EVENTS)
    if (cold === undefined) return undefined
    if (cold.events.length >= PRESET_SCAN_EVENTS && !cold.events.some(event => event.type === 'turn/start')) {
      // Truncated without reaching a turn boundary: only then read it all.
      cold = await this.readColdSession(sessionId) ?? cold
    }
    const header = cold.meta as { agentPreset?: unknown } | undefined
    let preset = typeof header?.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : undefined
    for (const event of cold.events) {
      const row = event as { type?: string; data?: { agentPreset?: unknown } }
      if (row.type === 'agent-preset/selected' && typeof row.data?.agentPreset === 'string' && row.data.agentPreset !== '') {
        preset = row.data.agentPreset
      }
    }
    return preset
  }

  /**
   * Install the `/new` route through DSH's own model-selection path.
   *
   * Creating an agent with `agentOptions.provider/model` is NOT enough on its
   * own. The first prompt dispatched through `sessionController.prompt()` calls
   * `ApiSessionAgentController.selectionFor(agent)`, which installs an
   * `agent/request` listener whose selection is `agentDefaultModel
   * .currentSelection()` whenever the session has no logged request header yet.
   * That listener runs after the loop's own route resolution and overwrites the
   * provider/model/reasoning effort of the first request — so a `/new` route
   * silently degraded to the global default model (verified on 0.1.5-rc.2:
   * session log carried no `model/selection` event and the first
   * `request/header` held the default route).
   *
   * `selectModel` appends the durable `model/selection` event and sets the
   * agent-scoped ref, which is exactly what the Web UI does when a model is
   * picked, so the route survives the first prompt. Like the Web UI, it also
   * persists the choice as the default selection.
   */
  private async applyCreationRoute(sessionId: string, creation: ChatCreationOptions | undefined): Promise<void> {
    const selectModel = this.deps.sessionController?.selectModel
    if (selectModel === undefined) return
    if (creation?.provider === undefined || creation.model === undefined) return
    try {
      await selectModel.call(this.deps.sessionController, {
        sessionId,
        provider: creation.provider,
        model: creation.model,
        ...(creation.reasoningEffort !== undefined ? { reasoningEffort: creation.reasoningEffort } : {}),
      })
      this.rememberModelRoute({
        provider: creation.provider,
        model: creation.model,
        ...(creation.reasoningEffort !== undefined ? { reasoningEffort: creation.reasoningEffort } : {}),
      })
    } catch (error: unknown) {
      // Non-fatal: the session still exists and runs on the default route.
      const message = error instanceof Error ? error.message : String(error)
      console.log(`dsh-feishu: could not apply the /new model route for ${sessionId}: ${message}`)
    }
  }
}
