/**
 * Feishu UI bridge for background jobs: one PANEL card per chat listing every
 * background task of that conversation, posted fresh whenever the roster
 * changes.
 *
 * The card is send-only — it is never patched in place (see `feishu-panel.ts`
 * for why). Each trigger posts a snapshot of the current roster, so the chat
 * reads as a log of "what is running / what finished", and the newest card
 * always shows the current truth.
 *
 * ONLY jobs the model was actually handed a handle for are listed. DSH
 * registers every foreground `bash`/`pwsh` call (and every background terminal
 * send) as a job so the command stays visible, killable, and promotable, so
 * "the registry has a job" is NOT "there is background work" — a panel keyed on
 * registration alone listed every tool call (关键坑 37). The fact that separates
 * the two lives in the TOOL RESULT (`started background job <id>` and
 * friends), which reaches this module through
 * {@link FeishuJobsHandle.noteDetached}.
 *
 * The panel carries no buttons: kill / intervene stay with the model's own
 * `job_kill` / `job_output` tools (关键坑 11 does not even apply to a card that
 * is never updated, but leaving interactive controls out keeps the card a
 * pure notification).
 *
 * @module @starxer/chatterbox4dsh/feishu-jobs
 */

import { conversationKey, type ConversationMessage } from './conversation.ts'
import { createPanelSender, formatDuration, PANEL_MAX_ROWS, PANEL_ROW_TTL_MS, renderTable, tableCell, type PanelChannel, type PanelLogger, type PanelSnapshot } from './feishu-panel.ts'
import type { Translations } from './i18n.ts'

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
  /** Producer-supplied one-line label (the command / the delegation description). */
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
   * Only confirmed jobs ever reach a card.
   */
  noteDetached: (notice: DetachedJobNotice) => void
}

/** Public deps for the jobs module. */
export interface FeishuJobsDeps {
  jobs: JobsServiceLike
  channel: PanelChannel
  logger: PanelLogger
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
  /** Test seam: coalescing window. Production omits it. */
  debounceMs?: number
  /** Test seam: non-urgent refresh floor. Production omits it. */
  refreshMs?: number
}

/** One roster row: the latest projection plus when it settled. */
export interface JobPanelRow {
  view: JobViewLike
  /** Epoch ms the row reached a terminal state; absent while live. */
  settledAt: number | undefined
}

/** One chat's roster. */
interface JobRoster {
  /** Coordinates of the session this roster belongs to (关键坑 25/31). */
  chat: ConversationMessage
  /** job id → row. Insertion order is irrelevant: the card sorts by start time. */
  rows: Map<string, JobPanelRow>
}

/** Status presentation: header icon and the localized label key. */
function statusPresentation(status: JobStatus, t: Translations): { icon: string; text: string } {
  switch (status) {
    case 'running': return { icon: '🔄', text: t.jobStatusRunning }
    case 'stopping': return { icon: '⏹️', text: t.jobStatusStopping }
    case 'completed': return { icon: '✅', text: t.jobStatusCompleted }
    case 'failed': return { icon: '❌', text: t.jobStatusFailed }
    case 'killed': return { icon: '⛔', text: t.jobStatusKilled }
  }
}

/** Whether a status is terminal. */
function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
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
 * Structural fingerprint of a roster: everything the table shows EXCEPT the
 * clock-derived durations, so a mere clock tick can never justify a new card.
 *
 * @param rows - the rows to fingerprint.
 * @returns the fingerprint string.
 */
export function jobRosterSignature(rows: readonly JobPanelRow[]): string {
  return [...rows]
    .map(row => [row.view.id, row.view.status, row.view.label, row.view.progress ?? '', row.view.detail ?? ''].join('\u0001'))
    .sort()
    .join('\u0002')
}

/**
 * Render the background-task panel card: one row per known background task.
 *
 * @param rows - the roster's rows.
 * @param t - the active locale's strings.
 * @param now - epoch ms used for a live row's elapsed time, so the caller owns
 *   the clock and the output stays testable.
 * @returns the Card JSON 2.0 object.
 */
export function renderJobPanelCard(rows: readonly JobPanelRow[], t: Translations, now: number): object {
  const sorted = [...rows].sort((a, b) => a.view.startedAt - b.view.startedAt)
  const shown = sorted.slice(-PANEL_MAX_ROWS)
  const headers = [t.jobPanelColStatus, t.jobPanelColTask, t.jobPanelColId, t.jobPanelColDuration, t.jobPanelColProgress]
  const body = shown.map(({ view }) => {
    const status = statusPresentation(view.status, t)
    const end = view.finishedAt ?? now
    const dynamic = isTerminal(view.status) ? view.detail ?? '' : view.progress ?? ''
    const label = view.label.trim()
    return [
      `${status.icon} ${status.text}`,
      tableCell(label === '' ? t.jobUntitled : label, { code: true, max: 48 }),
      tableCell(view.id, { code: true }),
      formatDuration(end - view.startedAt),
      dynamic.trim() === '' ? '—' : tableCell(dynamic, { max: 48 }),
    ]
  })
  const running = sorted.filter(row => !isTerminal(row.view.status)).length
  const lines = [`**${t.jobPanelSummary(running, sorted.length)}**`, '', renderTable(headers, body)]
  if (sorted.length > shown.length) lines.push('', `_${t.panelMoreRows(sorted.length - shown.length)}_`)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.jobPanelTitle }, template: 'wathet' },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }] },
  }
}

/**
 * Subscribe to the Host job registry and keep one background-task panel per
 * chat, listing every CONFIRMED background job whose session is bound there.
 *
 * @param deps - the registry, channel, logger, and locale reader.
 * @returns the handle: a disposer plus the confirmation entry point.
 */
export function startFeishuJobs(deps: FeishuJobsDeps): FeishuJobsHandle {
  const { jobs, channel, logger, getTranslations } = deps
  const rosters = new Map<string, JobRoster>()
  /**
   * Latest projection of every job the registry announced, confirmed or not. A
   * background job is confirmed by its TOOL RESULT, which arrives after
   * `registered` and normally before `settled`, so the first card is built from
   * the projection cached here. Foreground calls are cached too and dropped on
   * `removed`, which the registry issues the moment the tool collects them.
   */
  const pendingViews = new Map<string, JobViewLike>()
  /** Jobs confirmed as detached: id → the chat and session that claimed them. */
  const confirmed = new Map<string, { key: string; sessionId: string }>()

  const warn = (message: string, error: unknown): void => {
    // Never log the error object itself: the SDK's errors carry the request
    // body, which holds the app secret (硬规则 2).
    logger.warn(`dsh-feishu: ${message}: ${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * Drop roster rows a later card should no longer carry: settled long ago, or
   * pushed out by {@link PANEL_MAX_ROWS} newer ones. Live rows are never
   * dropped, and the cards already posted keep the history.
   */
  const prune = (roster: JobRoster, now: number): void => {
    for (const [id, row] of roster.rows) {
      if (row.settledAt !== undefined && now - row.settledAt > PANEL_ROW_TTL_MS) roster.rows.delete(id)
    }
    if (roster.rows.size <= PANEL_MAX_ROWS) return
    const byStart = [...roster.rows.entries()].sort((a, b) => a[1].view.startedAt - b[1].view.startedAt)
    for (const [id] of byStart.slice(0, roster.rows.size - PANEL_MAX_ROWS)) roster.rows.delete(id)
  }

  const panel = createPanelSender({
    channel,
    logger,
    ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
    ...(deps.refreshMs === undefined ? {} : { refreshMs: deps.refreshMs }),
    build: (key): PanelSnapshot | undefined => {
      const roster = rosters.get(key)
      if (roster === undefined) return undefined
      const now = Date.now()
      prune(roster, now)
      const rows = [...roster.rows.values()]
      if (rows.length === 0) {
        rosters.delete(key)
        return undefined
      }
      return { card: renderJobPanelCard(rows, getTranslations(), now), signature: jobRosterSignature(rows), chat: roster.chat }
    },
  })

  /** Queue a snapshot for the chat this roster belongs to. */
  const refresh = (key: string, urgent: boolean): void => {
    if (!rosters.has(key)) return
    panel.refresh(key, urgent)
  }

  /** Registry listeners are synchronous and contained — this must not throw. */
  const handle = (event: JobEventLike): void => {
    try {
      const job = event.job
      if (job === undefined || typeof job.id !== 'string') return
      if (event.type === 'removed') {
        // The registry only removes settled records: drop the bookkeeping and
        // KEEP the roster row, because the card that carried its outcome has
        // already been posted and later cards should still list it briefly.
        pendingViews.delete(job.id)
        confirmed.delete(job.id)
        return
      }
      // Cache every projection first, then ignore everything that was never
      // confirmed as detached: a foreground `bash` call is a job too, and
      // listing it put every tool call in the panel (关键坑 37).
      pendingViews.set(job.id, job)
      const claim = confirmed.get(job.id)
      if (claim === undefined) return
      // The row goes to the chat that saw THIS session's tool result, never to
      // a chat resolved from an id we did not verify (关键坑 31).
      if (job.owner !== undefined && job.owner !== claim.sessionId) {
        warn(`job ${job.id} is owned by ${job.owner}, not ${claim.sessionId}`, new Error('job owner mismatch'))
        return
      }
      const roster = rosters.get(claim.key)
      if (roster === undefined) return
      const row = roster.rows.get(job.id)
      if (row === undefined) return
      const before = row.view.status
      row.view = job
      if (isTerminal(job.status)) row.settledAt = Date.now()
      // A status flip is what a reader must not miss; a progress line is only
      // detail, so it waits behind the refresh floor.
      refresh(claim.key, before !== job.status)
    } catch (error: unknown) {
      warn('job event handling failed', error)
    }
  }

  /**
   * The model was handed background job `notice` names — that is the gate.
   * The snapshot goes out at once: the task is already running, and for most
   * jobs this is the only event before it settles.
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
      const key = conversationKey(notice.chat)
      confirmed.set(jobId, { key, sessionId: notice.sessionId })
      let roster = rosters.get(key)
      if (roster === undefined) {
        roster = { chat: notice.chat, rows: new Map() }
        rosters.set(key, roster)
      } else {
        // Keep the freshest topic coordinates (a root id may only be known
        // after the first card; 关键坑 25).
        roster.chat = notice.chat
      }
      roster.rows.set(jobId, { view, settledAt: isTerminal(view.status) ? Date.now() : undefined })
      refresh(key, true)
    } catch (error: unknown) {
      warn('job confirmation handling failed', error)
    }
  }

  const unsubscribe = jobs.events.subscribe({ owners: 'all' }, handle)

  return {
    dispose: () => {
      unsubscribe()
      panel.dispose()
      rosters.clear()
      pendingViews.clear()
      confirmed.clear()
    },
    noteDetached,
  }
}
