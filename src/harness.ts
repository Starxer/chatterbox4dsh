import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { conversationKey, summarizeTurn, toSessionId } from './conversation.ts'
import type { ConversationMessage } from './conversation.ts'
import type { DomainName } from './config.ts'

/** Minimum surface of {@link Agent} the conversation service depends on. */
interface AgentLike {
  session: { id: unknown; seq: number; events?: readonly { seq: number; type: string; data: any }[] }
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
     *  bridge; must close() after use (write handles leak ownership if not). */
    open?(id: unknown, access: 'read' | 'write'): Promise<{ read(offset?: number, length?: number): Promise<ReadonlyArray<{ seq: number; type: string; data: any; time?: number }>>; header?: unknown; close(): Promise<void> }>
  }
  selection(): { provider: string; model: string; reasoningEffort?: ReasoningEffortId }
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
  }
}

export interface HarnessBridgeConfig {
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
  /** 0.1.3 durable file attachments (from `attachments.saveFile`), attached to
   *  the user message as `{ type:'file', attachment }` content blocks. Each
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
   * topic message does not reliably land in the topic. Keyed by the same
   * chat key as `chatToSession`.
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
   * Sessions for which intermediate assistant message cards were sent during
   * the current turn. The channel skips the final reply card for these
   * sessions to avoid duplication.
   */
  private readonly intermediateSent = new Set<string>()

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
        | { chatToSession?: Record<string, string>; seenChatKeys?: string[]; busyMode?: Record<string, string> }
      // Legacy format (pre-ownership): a flat record keyed by chat key.
      const legacy = Array.isArray(data) ? undefined
        : (data as Record<string, string>).chatToSession === undefined && !Array.isArray((data as any).seenChatKeys)
          ? data as Record<string, string>
          : undefined
      if (legacy !== undefined) {
        for (const [k, v] of Object.entries(legacy)) this.chatToSession.set(k, v)
        for (const k of Object.keys(legacy)) this.seenChatKeys.add(k)
        return
      }
      const parsed = data as { chatToSession?: Record<string, string>; seenChatKeys?: string[]; busyMode?: Record<string, string> }
      for (const [k, v] of Object.entries(parsed.chatToSession ?? {})) this.chatToSession.set(k, v)
      for (const k of parsed.seenChatKeys ?? []) this.seenChatKeys.add(k)
      for (const [k, v] of Object.entries(parsed.busyMode ?? {})) {
        if (v === 'queue' || v === 'steer') this.chatToBusyMode.set(k, v)
      }
    } catch (error: unknown) {
      // ENOENT is expected on first run; log other errors
      if ((error as { code?: string }).code !== 'ENOENT') {
        console.error('dsh-feishu: loadSessionMap failed:', error instanceof Error ? error.message : String(error))
      }
    }
  }

  /** Persist the current chat→session map to disk (best-effort). */
  private saveSessionMap(): void {
    const path = this.config.statePath
    if (path === undefined || path === '') return
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({
        chatToSession: Object.fromEntries(this.chatToSession),
        seenChatKeys: [...this.seenChatKeys],
        busyMode: Object.fromEntries(this.chatToBusyMode),
      }), 'utf-8')
    } catch (error: unknown) {
      console.error('dsh-feishu: saveSessionMap failed:', error instanceof Error ? error.message : String(error))
    }
  }

  async reply(message: InboundMessage, opts?: { forceQueue?: boolean }): Promise<string> {
    const key = conversationKey(message)
    // Capture the topic root id so streaming/question/approval/todo cards
    // can reply into the same Feishu topic instead of the main chat stream.
    if (message.threadId !== undefined && message.rootId !== undefined) {
      this.chatToRootId.set(key, message.rootId)
    }
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
    // Tag every Feishu user turn with a leading `[Feishu] ` marker so the
    // model and any later session-log reader can tell the message originated
    // from the Lark channel rather than the webui composer. Image/file-only
    // messages get the tag as a standalone text block because there is no
    // caption to attach it to.
    const tag = '[Feishu] '
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef } | { type: 'file'; attachment: any }> = []
    if (hasText) content.push({ type: 'text', text: `${tag}${text}` })
    else content.push({ type: 'text', text: tag })
    for (const attachment of imageBlocks) content.push({ type: 'image', attachment })
    for (const file of fileBlocks) content.push({ type: 'file', attachment: file.attachment })

    // Steer mode + running: inject into the live turn immediately (no wait),
    // then wait for the running turn (including the steered step) to finish.
    if (runBusyMode === 'steer' && running) {
      const firstSeq = agent.session.seq
      if (!(await this.dispatchPrompt(agent, 'steer', content))) {
        agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
      }
      await agent.whenIdle()
      await this.deps.sessions.flush(agent.session)
      const result = summarizeTurn(this.readSessionEvents(agent, firstSeq), firstSeq)
      if (!result.ok) throw new Error('Harness turn did not produce a successful assistant response')
      return result.text
    }

    // Queue path (default): wait for the current turn to end, then followup as
    // a new turn. A `/stop` during the wait bumps the generation, so drop the
    // message instead of submitting it — this is what actually discards a
    // message queued while the agent was running.
    await agent.whenIdle()
    if (this.generationOf(key) !== gen) {
      throw new TurnDroppedError('message dropped: session stopped while it was queued')
    }
    const firstSeq = agent.session.seq
    if (!(await this.dispatchPrompt(agent, 'queue', content))) {
      agent.followup(createUserMessage({
        content,
        source: { kind: 'user' },
      }))
    }
    await agent.whenIdle()
    await this.deps.sessions.flush(agent.session)
    const result = summarizeTurn(this.readSessionEvents(agent, firstSeq), firstSeq)
    if (!result.ok) throw new Error('Harness turn did not produce a successful assistant response')
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

  /** Resolve the durable session id from a `sessionPersistence.list()` row.
   *  0.1.3 rows are `SessionPersistenceSnapshot` (id = `.header.id`); older
   *  versions expose a top-level `.id`. Either shape resolves here. */
  private persistedIdOf(item: { id?: string; header?: { id: string } }): string {
    return item.id ?? item.header?.id ?? ''
  }

  /** Read a cold session's header + events from persistence across DSH
   *  versions. 0.1.3 uses `open(id,'read') + handle.read(0)`; alpha.4 uses
   *  `readFrom(id, 0)`. Returns `undefined` when the service (or backend) is
   *  absent so callers can fall back to live-session data. */
  private async readColdSession(
    sessionId: unknown,
  ): Promise<{ meta: unknown; events: ReadonlyArray<{ seq: number; type: string; data: any; time?: number }> } | undefined> {
    const persistence = this.deps.sessionPersistence
    // 0.1.3: SessionHandle seam.
    if (typeof persistence.open === 'function') {
      try {
        const handle = await persistence.open(sessionId as never, 'read')
        try {
          const events = await handle.read(0)
          return { meta: handle.header, events: events as ReadonlyArray<{ seq: number; type: string; data: any; time?: number }> }
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
        return await persistence.readFrom.call(persistence, sessionId as never, 0)
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
    await this.deps.sessionController.prompt(
      { sessionId: agent.session.id, requestId: randomUUID(), mode, content },
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
    // Same `[Feishu] ` marker as reply() so the model and session log can tell
    // the injection came from the Lark channel rather than the webui composer.
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef } | { type: 'file'; attachment: any }> = []
    content.push({ type: 'text', text: `[Feishu] ${text}` })
    for (const attachment of (message.imageBlocks ?? [])) content.push({ type: 'image', attachment })
    for (const file of (message.fileBlocks ?? [])) content.push({ type: 'file', attachment: file.attachment })
    if (!(await this.dispatchPrompt(agent, 'steer', content))) {
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
    const handles = await Promise.allSettled(this.handles.values())
    await Promise.all(handles.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []))
    this.handles.clear()
    this.chatToSession.clear()
    this.chatToRootId.clear()
    this.seenChatKeys.clear()
    this.chatToCreation.clear()
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
    if (previous !== undefined && previous !== sessionId) {
      this.releaseSessionForChat(previous, key, sessionId)
    }
    this.chatToSession.set(key, sessionId)
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

  /** Attach the stored topic root id (if any) to a reconstructed chat message. */
  private attachRootId(key: string, message: ConversationMessage): ConversationMessage {
    const rootId = this.chatToRootId.get(key)
    return rootId === undefined ? message : { ...message, rootId }
  }

  /**
   * Reconstruct a {@link ConversationMessage} from the chat key produced by
   * {@link conversationKey}. The key is sufficient for `resolveSessionId`
   * because only `chatId` and (optionally) `threadId` participate in the
   * hash; `chatType` is irrelevant for the session id and is filled with the
   * harmless `'p2p'` default.
   */
  private messageFromKey(key: string): ConversationMessage {
    if (key.startsWith('thread:')) {
      const [, chatId, threadId] = key.split(':')
      return { chatId: chatId ?? '', chatType: 'p2p', threadId: threadId ?? '' }
    }
    return { chatId: key.slice('chat:'.length), chatType: 'p2p' }
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
    this.chatToSession.set(key, sessionId)
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
        events = this.readSessionEvents(live as unknown as AgentLike)
        // The live session's in-memory log has no header, so read the on-disk
        // meta for the creation preset (also catches the docs getSessionMeta path).
        const result = await this.readColdSession(itemId)
        if (result !== undefined) {
          const meta = result.meta as { agentPreset?: string; origin?: unknown } | undefined
          presetId = meta?.agentPreset ?? ''
          subagent = meta?.origin === 'subagent'
        } else {
          // No persistence seam: fall back to the live session header. A DSH
          // subagent session carries `origin: 'subagent'` on its durable
          // header, so detection does not depend on the persistence service.
          const header = (live as unknown as { session?: { header?: { origin?: unknown } } })?.session?.header
          subagent = header?.origin === 'subagent'
        }
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
    const fallback = this.deps.selection()
    const initial = {
      provider: creation?.provider ?? this.config.provider ?? fallback.provider,
      model: creation?.model ?? this.config.model ?? fallback.model,
      ...(creation?.reasoningEffort !== undefined
        ? { reasoningEffort: creation.reasoningEffort }
        : fallback.reasoningEffort !== undefined
          ? { reasoningEffort: fallback.reasoningEffort }
          : {}),
    } satisfies ModelSelection
    const configuredWorkspace = creation?.workspace ?? this.config.workspace
    const workspace = configuredWorkspace === undefined
      ? this.deps.workspaceRegistry.list()[0]
      : await this.deps.workspaceRegistry.resolveByPath(configuredWorkspace)
    // Use the workspace's actual path as cwd to ensure consistency
    // When no workspace is configured, use the first workspace's path
    const cwd = workspace?.path ?? configuredWorkspace ?? process.cwd()
    const agentPreset = (await this.deps.agentPresets.resolve(creation?.agentPreset ?? this.config.agentPreset)).id
    const setup = async (agentCtx: import('@deepseek-ai/cordis').Context) => {
      await this.deps.agentPresets.mount(agentCtx, agentPreset)
    }
    const persisted = (await this.deps.sessionPersistence.list()).some(item => this.persistedIdOf(item) === sessionId)
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
    }
    return handle
  }
}
