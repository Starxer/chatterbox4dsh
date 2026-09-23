/**
 * Feishu UI bridge for background jobs: subscribes to the Host's abstract job
 * registry (`ctx.jobs`) and keeps one card per job in the chat that owns the
 * job's session — created once the job is confirmed detached, updated in place
 * as it progresses, and left in place carrying its terminal state.
 *
 * ONLY jobs the model was actually handed a handle for are mirrored. DSH
 * registers every foreground `bash`/`pwsh` call (and every background terminal
 * send) as a job so the command stays visible, killable, and promotable, so
 * "the registry has a job" is NOT "there is background work" — a mirror keyed
 * on registration alone posted one extra card beside every tool call (关键坑
 * 37). The fact that separates the two lives in the TOOL RESULT
 * (`started background job <id>` and friends), which reaches this module
 * through {@link FeishuJobsHandle.noteDetached}.
 *
 * One card per job, never a new card per event: job cards carry no buttons, and
 * Feishu only stops delivering *button* callbacks after a few in-place edits
 * (关键坑 11), so updating the same message is both safe and the only way to keep
 * a chat readable. Interactive controls (kill) deliberately stay out of these
 * cards for that reason.
 *
 * @module @starxer/chatterbox4dsh/feishu-jobs
 */

import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'

/** Minimal logger surface. */
interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Channel adapter for sending and updating cards. */
export interface FeishuJobsChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
}

/** Current lifecycle state of one job. */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/**
 * Narrow structural view of one Host job.
 *
 * Declared locally instead of imported: `@deepseek-ai/dsh-jobs` is not one of
 * this plugin's peers, and matching the host's exact type would not survive a
 * minor release. Only the fields a card renders are listed.
 */
export interface JobViewLike {
  readonly id: string
  /** Producer kind; an open string, so consumers must not enumerate it. */
  readonly kind: string
  /** Producer-supplied one-line label. */
  readonly label: string
  /** Owning session; absent for an unowned job, which every caller can see. */
  readonly owner?: string
  readonly status: JobStatus
  /** Live progress line, cleared at settlement. */
  readonly progress?: string
  /** Terminal reason (`exit code: 3`). */
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** One registry event. `settled` carries the terminal projection. */
export type JobEventLike =
  | { readonly type: 'registered' | 'progress' | 'stopping' | 'removed'; readonly job: JobViewLike }
  | { readonly type: 'settled'; readonly job: JobViewLike }

/** Narrow view of the registry's event fan-out. */
export interface JobEventsLike {
  /**
   * @param filter - which owners' events to deliver.
   * @param listener - receives each matching event; the registry contains it
   *   and never awaits it, so it must not throw.
   * @returns disposer that unregisters the listener.
   */
  subscribe(
    filter: { readonly owners: 'all' },
    listener: (event: JobEventLike) => void,
  ): () => void
}

/** The slice of the Host's `jobs` service this module uses. */
export interface JobsServiceLike {
  readonly events: JobEventsLike
}

/**
 * A tool result that handed the model a background job id. This is the ONLY
 * fact that separates real background work from the foreground calls DSH also
 * registers as jobs (关键坑 37); its text is matched literally inside
 * {@link detachedJobIdFromToolResult}.
 */
export interface DetachedJobNotice {
  /** Tool that produced the result; only job-producing tools are matched. */
  toolName: string
  /** The result text exactly as the model saw it. */
  resultText: string
  /** Chat bound to the session that made the call — never guessed (关键坑 31). */
  chat: ConversationMessage
  /** Session whose tool result this is, used as an ownership guard. */
  sessionId: string
}

/** Handle returned by {@link startFeishuJobs}. */
export interface FeishuJobsHandle {
  /** Unsubscribe and drop every pending timer. */
  dispose: () => void
  /**
   * Confirm that the model was handed the background job this notice names.
   * Only confirmed jobs ever get a card.
   */
  noteDetached: (notice: DetachedJobNotice) => void
}

/** Public deps for the jobs module. */
export interface FeishuJobsDeps {
  jobs: JobsServiceLike
  channel: FeishuJobsChannel
  logger: PluginLogger
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
  /**
   * Coalescing window for non-terminal updates. Test seam: production callers
   * omit it and get {@link JOB_CARD_DEBOUNCE_MS}.
   */
  debounceMs?: number
}

/** Coalescing window for a job's in-place updates. It never delays the first card. */
const JOB_CARD_DEBOUNCE_MS = 300

/**
 * How long a settled job's bookkeeping is kept without a `removed` event.
 * `removed` deletes it outright; this only bounds hosts whose retention never
 * announces one.
 */
const JOB_CARD_TTL_MS = 30 * 60_000

/** One job's card bookkeeping. */
interface JobCardState {
  /** Topic coordinates captured when the job was first seen (关键坑 25/31). */
  readonly chat: ConversationMessage
  /** Latest known projection; the card always renders this. */
  view: JobViewLike
  /** Set once the first send resolved; absent while unsent or after a failure. */
  messageId: string | undefined
  /** Pending coalescing timer. */
  timer: ReturnType<typeof setTimeout> | undefined
  /**
   * Serializes this job's sends and updates. Without it a slow first send lets
   * a later update run first, and the card would then be patched by id before
   * that id is known — or, worse, a second card would be posted (关键坑 12).
   */
  chain: Promise<void>
  /** Epoch ms the card reached a terminal state; absent while live. */
  settledAt: number | undefined
  /**
   * Progress of this card's FIRST send. `idle` means none was queued yet, so
   * the next flush posts the card at once — a job whose progress changes faster
   * than the coalescing window must not stay invisible. Every later state
   * (`queued`, `sent`, `failed`) coalesces, which also caps how often a failed
   * send is retried.
   */
  sendState: 'idle' | 'queued' | 'sent' | 'failed'
}

/** Status presentation: header icon, template, and the localized label key. */
function statusPresentation(status: JobStatus, t: Translations): { icon: string; template: string; text: string } {
  switch (status) {
    case 'running': return { icon: '🔄', template: 'wathet', text: t.jobStatusRunning }
    case 'stopping': return { icon: '⏹️', template: 'orange', text: t.jobStatusStopping }
    case 'completed': return { icon: '✅', template: 'green', text: t.jobStatusCompleted }
    case 'failed': return { icon: '❌', template: 'red', text: t.jobStatusFailed }
    case 'killed': return { icon: '⛔', template: 'grey', text: t.jobStatusKilled }
  }
}

/** Whether a status is terminal. */
function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

/** Collapse a producer string into one markdown-safe line. */
function oneLine(value: string | undefined): string {
  return value === undefined ? '' : value.replace(/\s+/g, ' ').trim()
}

/** Compact duration: `820ms`, `4.3s`, `2m 05s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}

/**
 * One producer sentence that hands the model a background job id, plus where in
 * a result it may appear.
 */
interface DetachedJobSentence {
  readonly pattern: RegExp
  /**
   * `first` — only the FIRST non-empty line may carry it. A `bash` result can
   * echo arbitrary text (a log, a source file), so the plain announcement is
   * trusted only at the top, where every producer puts it.
   * `any` — a self-labelled bracket line a producer appends after the output it
   * already produced (a foreground call promoted to the background).
   */
  readonly scope: 'first' | 'any'
}

/** `tool-bash` / `tool-pwsh` / `tool-terminal` with `run_in_background: true`. */
const ANNOUNCEMENT_AT_TOP: DetachedJobSentence = {
  pattern: /^started background job ([a-z][a-z0-9-]*-\d+)$/,
  scope: 'first',
}

/** A foreground `bash`/`pwsh` call promoted after its deadline passed. */
const PROMOTED_ANYWHERE: DetachedJobSentence = {
  pattern: /^\[still running after \d+ms; moved to background job ([a-z][a-z0-9-]*-\d+)\]$/,
  scope: 'any',
}

/** `tool-subagent` (background one-shot child). */
const SUBAGENT_ANNOUNCEMENT: DetachedJobSentence = {
  pattern: /^started background subagent job ([a-z][a-z0-9-]*-\d+)$/,
  scope: 'first',
}

/** `tool-workflow` (always detached). */
const WORKFLOW_ANNOUNCEMENT: DetachedJobSentence = {
  pattern: /^workflow .* started in the background as job ([a-z][a-z0-9-]*-\d+)\./,
  scope: 'first',
}

/**
 * Tools whose result can hand the model a background job id, each pinned to the
 * exact sentences its producer renders. Owned by the tools, so they are matched
 * literally and pinned by `tests/feishu-jobs.spec.ts` — a rewording must be
 * noticed, not silently swallowed. Keying by tool name also keeps one tool's
 * sentence from being credited to another (a `bash` result echoing
 * `started background subagent job …` must not claim that job).
 */
const DETACHED_JOB_SENTENCES: ReadonlyMap<string, readonly DetachedJobSentence[]> = new Map([
  ['bash', [ANNOUNCEMENT_AT_TOP, PROMOTED_ANYWHERE]],
  ['pwsh', [ANNOUNCEMENT_AT_TOP, PROMOTED_ANYWHERE]],
  ['terminal_send', [ANNOUNCEMENT_AT_TOP]],
  ['subagent', [SUBAGENT_ANNOUNCEMENT]],
  ['subagent_fork', [SUBAGENT_ANNOUNCEMENT]],
  ['workflow', [WORKFLOW_ANNOUNCEMENT]],
])

/**
 * Recover the background job id a tool result announced, if any.
 *
 * @param toolName - the tool that produced the result.
 * @param resultText - the result text exactly as the model saw it.
 * @returns the job id, or `undefined` when this result is not a job handle.
 */
export function detachedJobIdFromToolResult(toolName: string, resultText: string): string | undefined {
  const sentences = DETACHED_JOB_SENTENCES.get(toolName)
  if (sentences === undefined) return undefined
  const lines = resultText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const firstLine = lines[0]
  if (firstLine === undefined) return undefined
  for (const sentence of sentences) {
    for (const line of sentence.scope === 'first' ? [firstLine] : lines) {
      const id = sentence.pattern.exec(line)?.[1]
      if (id !== undefined) return id
    }
  }
  return undefined
}

/**
 * Render one job's card.
 *
 * @param view - the job projection to render.
 * @param t - the active locale's strings.
 * @param now - epoch ms used for a live job's elapsed time, so the caller owns
 *   the clock and the output stays testable.
 * @returns the Card JSON 2.0 object.
 */
export function renderJobCard(view: JobViewLike, t: Translations, now: number): object {
  const status = statusPresentation(view.status, t)
  const label = oneLine(view.label)
  const progress = oneLine(view.progress)
  const detail = oneLine(view.detail)
  const end = view.finishedAt ?? now
  const lines: string[] = [
    `${status.icon} **${status.text}**`,
    `${t.jobKindLabel} \`${oneLine(view.kind)}\` · ${t.jobIdLabel} \`${oneLine(view.id)}\``,
  ]
  if (!isTerminal(view.status) && progress !== '') lines.push(`${t.jobProgressLabel} ${progress}`)
  if (detail !== '') lines.push(`${t.jobDetailLabel} ${detail}`)
  lines.push(`${t.jobDurationLabel} ${formatDuration(end - view.startedAt)}`)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${status.icon} ${label === '' ? t.jobUntitled : label}` },
      template: status.template,
    },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }] },
  }
}

/**
 * Subscribe to the Host job registry and mirror every CONFIRMED background job
 * that belongs to a Feishu-bound session as a card in that chat.
 *
 * @param deps - the registry, channel, logger, and locale reader.
 * @returns the handle: a disposer plus the confirmation entry point.
 */
export function startFeishuJobs(deps: FeishuJobsDeps): FeishuJobsHandle {
  const { jobs, channel, logger, getTranslations } = deps
  const debounceMs = deps.debounceMs ?? JOB_CARD_DEBOUNCE_MS
  const states = new Map<string, JobCardState>()
  /**
   * Latest projection of every job the registry announced, confirmed or not. A
   * background job is confirmed by its TOOL RESULT, which arrives after
   * `registered` and normally before `settled`, so the card is built from the
   * projection cached here. Foreground calls are cached too and dropped on
   * `removed`, which the registry issues the moment the tool collects them.
   */
  const pendingViews = new Map<string, JobViewLike>()
  /** Jobs confirmed as detached: id → the chat and session that claimed them. */
  const confirmed = new Map<string, { chat: ConversationMessage; sessionId: string }>()

  const warn = (message: string, error: unknown): void => {
    // Never log the error object itself: the SDK's errors carry the request
    // body, which holds the app secret (硬规则 2).
    logger.warn(`dsh-feishu: ${message}: ${error instanceof Error ? error.message : String(error)}`)
  }

  /** Topic reply context for a chat, mirroring feishu-todos (关键坑 25). */
  const replyOpts = (chat: ConversationMessage): { replyInThread?: boolean; replyTo?: string } =>
    chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {}

  /**
   * Drop settled bookkeeping the registry never announced as removed. Called on
   * every settlement and on the first sight of a new job, so a host that stops
   * starting jobs still sheds them: an entry is removed by whichever of those
   * two events next arrives after it has been settled for {@link JOB_CARD_TTL_MS}.
   */
  const sweep = (now: number): void => {
    for (const [id, state] of states) {
      if (state.settledAt !== undefined && now - state.settledAt > JOB_CARD_TTL_MS) states.delete(id)
    }
    // Unconfirmed projections are bookkeeping only. A live one must survive
    // (its result may still be in flight); a settled one this old belongs to a
    // host that never announced its removal.
    for (const [id, view] of pendingViews) {
      if (confirmed.has(id)) continue
      if (view.finishedAt !== undefined && now - view.finishedAt > JOB_CARD_TTL_MS) pendingViews.delete(id)
    }
  }

  /** Send or update this job's card. Never rejects; the chain depends on that. */
  const flush = async (state: JobCardState): Promise<void> => {
    const card = renderJobCard(state.view, getTranslations(), Date.now())
    if (state.messageId === undefined) {
      try {
        const sent = await channel.send(state.chat.chatId, { card }, replyOpts(state.chat))
        if (sent.messageId !== undefined) {
          state.messageId = sent.messageId
          state.sendState = 'sent'
        } else {
          // No id means the card can never be updated, so treat it as a failure
          // and let a later event try again.
          state.sendState = 'failed'
          warn('job card sent without a message id', new Error('no messageId'))
        }
      } catch (error: unknown) {
        // Leave `messageId` unset: the next event retries the send. The card is
        // best-effort and must never take the subscription down.
        state.sendState = 'failed'
        warn('job card send failed', error)
      }
      return
    }
    try {
      await channel.updateCard(state.messageId, card)
    } catch (error: unknown) {
      warn('job card update failed', error)
    }
  }

  /** Queue one send/update behind this job's previous one. */
  const enqueue = (state: JobCardState): void => {
    state.chain = state.chain.then(() => flush(state))
  }

  const schedule = (state: JobCardState, immediate: boolean): void => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    // The FIRST card is never debounced: a job whose progress line changes
    // faster than the coalescing window resets the timer forever, so a debounced
    // first send would leave a chatty long job invisible until it went quiet —
    // exactly backwards. Only in-place updates coalesce, and a failed send
    // retries no sooner than the window.
    const firstCard = state.sendState === 'idle'
    if (firstCard) state.sendState = 'queued'
    if (immediate || debounceMs <= 0 || firstCard) {
      enqueue(state)
      return
    }
    state.timer = setTimeout(() => {
      state.timer = undefined
      enqueue(state)
    }, debounceMs)
  }

  /**
   * A job left the registry's visible set: drop the bookkeeping and KEEP the
   * card. `settled` always precedes `removed` (the registry only removes
   * settled records, and the producing tool removes its own once it has
   * collected the terminal state), so the card already carries the outcome.
   * Rewriting it into a grey "this card is stale" shell threw away exactly the
   * information the human came for, and the shell's text pointed at a newer
   * card that never existed (2026-09-23).
   */
  const forget = (jobId: string): void => {
    const state = states.get(jobId)
    if (state?.timer !== undefined) clearTimeout(state.timer)
    states.delete(jobId)
    pendingViews.delete(jobId)
    confirmed.delete(jobId)
  }

  /** Registry listeners are synchronous and contained — this must not throw. */
  const handle = (event: JobEventLike): void => {
    try {
      const job = event.job
      if (job === undefined || typeof job.id !== 'string') return
      if (event.type === 'removed') {
        forget(job.id)
        return
      }
      // Cache every projection first, then ignore everything that was never
      // confirmed as detached: a foreground `bash` call is a job too, and
      // mirroring it put one extra card beside every tool call (关键坑 37).
      pendingViews.set(job.id, job)
      const claim = confirmed.get(job.id)
      if (claim === undefined) return
      // The card goes to the chat that saw THIS session's tool result, never to
      // a chat resolved from an id we did not verify (关键坑 31).
      if (job.owner !== undefined && job.owner !== claim.sessionId) {
        warn(`job ${job.id} is owned by ${job.owner}, not ${claim.sessionId}`, new Error('job owner mismatch'))
        return
      }
      let state = states.get(job.id)
      if (state === undefined) {
        sweep(Date.now())
        state = {
          chat: claim.chat,
          view: job,
          messageId: undefined,
          timer: undefined,
          chain: Promise.resolve(),
          settledAt: undefined,
          sendState: 'idle',
        }
        states.set(job.id, state)
      }
      state.view = job
      if (isTerminal(job.status)) {
        state.settledAt = Date.now()
        // Settlement is terminal and rare, so this is where a host that goes
        // quiet actually sheds settled bookkeeping — sweeping only on the next
        // registration would keep it until some job is started again.
        sweep(Date.now())
      }
      // Terminal states flush at once so the card never sits on "running" after
      // the job is done; progress bursts coalesce instead.
      schedule(state, event.type === 'settled')
    } catch (error: unknown) {
      warn('job event handling failed', error)
    }
  }

  /**
   * The model was handed background job `notice` names — that is the gate.
   * The card goes out at once: a confirmed job may already be running, and for
   * most jobs this is the only event before it settles.
   */
  const noteDetached = (notice: DetachedJobNotice): void => {
    try {
      const jobId = detachedJobIdFromToolResult(notice.toolName, notice.resultText)
      if (jobId === undefined || confirmed.has(jobId)) return
      const view = pendingViews.get(jobId)
      if (view === undefined) {
        // Nothing to render from. Say so instead of staying silent: a host that
        // reorders or renames its events must not turn into a card-less
        // deployment without a trace.
        logger.info(`dsh-feishu: background job ${jobId} announced by ${notice.toolName} but not in the registry; no card`)
        return
      }
      if (view.owner !== undefined && view.owner !== notice.sessionId) {
        warn(`job ${jobId} announced by ${notice.toolName} belongs to ${view.owner}, not ${notice.sessionId}`, new Error('job owner mismatch'))
        return
      }
      confirmed.set(jobId, { chat: notice.chat, sessionId: notice.sessionId })
      const now = Date.now()
      sweep(now)
      const state: JobCardState = {
        chat: notice.chat,
        view,
        messageId: undefined,
        timer: undefined,
        chain: Promise.resolve(),
        settledAt: isTerminal(view.status) ? now : undefined,
        sendState: 'idle',
      }
      states.set(jobId, state)
      schedule(state, true)
    } catch (error: unknown) {
      warn('job confirmation handling failed', error)
    }
  }

  const unsubscribe = jobs.events.subscribe({ owners: 'all' }, handle)

  return {
    dispose: () => {
      unsubscribe()
      for (const state of states.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      states.clear()
      pendingViews.clear()
      confirmed.clear()
    },
    noteDetached,
  }
}
