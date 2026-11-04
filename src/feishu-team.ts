/**
 * Feishu UI bridge for DSH Agent Teams: one send-only board card per Feishu
 * chat whenever the Team rooted at that chat's session changes.
 *
 * The board is a NOTIFICATION, not a control surface: it is never patched in
 * place. Every change posts a fresh snapshot into the chat, exactly like the
 * subagent and background-job panels (`feishu-panel.ts` owns the coalescing,
 * fingerprint de-duplication and per-chat send ordering). That is also what
 * keeps it clear of the in-place-update callback limit (关键坑 11).
 *
 * ## Where the facts come from
 *
 * Team activity is recorded as Session events on the LEAD session
 * (`team/member`, `team/task`) and the Host projects them into that session's
 * `agentTeam` projection. This module subscribes to the global `session/event`
 * fan-out only as a TRIGGER, then reads the projection at flush time: the
 * projection already owns event versioning, the derived view (owner names,
 * readiness, write-scope warnings) and the invalid-record `failure`. So the
 * plugin needs no new peer dependency — the Agent Teams packages are
 * experimental and optional — and does not re-implement the Team state machine.
 *
 * Member *activity* is not in the durable projection (a member row has a
 * durable phase only). It comes from the live Agent registry, read through an
 * optional reader, and a teammate's `turn/start` / `turn/end` events refresh
 * the board. The Lead row deliberately shows its role instead of a running
 * state: the Lead is the chat-bound session itself, so a per-turn state flip
 * would repost the whole board on every message.
 *
 * ## When nothing happens
 *
 * A composition without the Agent Teams plugin appends no team events at all,
 * so this module never renders a board; without the projection it reads
 * nothing and stays silent (关键坑 2: no hard dependency, no boot failure).
 *
 * @module @starxer/chatterbox4dsh/feishu-team
 */

import type { Context } from '@deepseek-ai/cordis'
import { conversationKey, type ConversationMessage } from './conversation.ts'
import { createPanelSender, renderTable, tableCell, type PanelChannel, type PanelLogger, type PanelSnapshot } from './feishu-panel.ts'
import type { Translations } from './i18n.ts'

/** The Session projection key owned by `@deepseek-ai/dsh-experimental-agent-team`. */
const TEAM_PROJECTION_KEY = 'agentTeam'

/** How many chats may hold board state at once; the oldest is dropped. */
const TEAM_CHAT_LIMIT = 32

/** How many task rows one board card lists before the rest become a count. */
const TEAM_TASK_ROWS = 12

/** Longest subject cell rendered for one task. */
const TEAM_SUBJECT_MAX = 48

/** Longest diagnostic/owner cell rendered on one row. */
const TEAM_TEXT_MAX = 60

/** Whole durable member lifecycle as the projection publishes it. */
type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** Durable task lifecycle as the projection publishes it. */
type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** One roster row as the board renders it. */
export interface TeamBoardMember {
  /** Durable member session id. */
  id: string
  /** Model-facing name (`lead` for the Lead pseudo-row). */
  name: string
  role: 'lead' | 'teammate'
  /** Durable phase overlaid with the member session's live turn activity. */
  status: 'running' | 'inactive' | 'provisioning' | 'failed'
  /** Why provisioning failed, when the Host recorded a reason. */
  error?: string
}

/** One task row as the board renders it (deleted tombstones are excluded). */
export interface TeamBoardTask {
  id: string
  subject: string
  status: Exclude<TeamTaskStatus, 'deleted'>
  /** Resolved owner name; absent while the task is unowned. */
  ownerName?: string
  blockedBy: string[]
  ready: boolean
  writeScopeWarnings: string[]
}

/** Everything one board card shows. */
export interface TeamBoardView {
  members: TeamBoardMember[]
  tasks: TeamBoardTask[]
  /** The projection refused a persisted Team record; board is the last valid state. */
  failure?: string
}

/** Narrow projection read face the module consumes (`sessionProjections`). */
export interface TeamProjectionReader {
  snapshot(session: unknown, keys?: readonly string[]): { values: Readonly<Record<string, unknown>> }
}

/** Narrow Agent registry surface used for live member activity. */
export interface TeamAgentReader {
  get(id: string): { status?: string } | undefined
}

/** Public deps for {@link startFeishuTeam}. */
export interface FeishuTeamDeps {
  ctx: Context
  channel: PanelChannel
  /** The bridge, read through a holder: the channel may reconnect later. */
  bridgeHolder: { current: { resolveChat(sessionId: string): ConversationMessage | undefined } | undefined }
  logger: PanelLogger
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
  /** Host session projections (`ctx.get('sessionProjections')`), optional. */
  projections?: TeamProjectionReader | undefined
  /** Live Agent registry (`ctx.get('agents')`), used for member activity. */
  agents?: TeamAgentReader | undefined
  /** Coalescing window; test seam (production default lives in feishu-panel). */
  debounceMs?: number
  /** Non-urgent refresh floor; test seam. */
  refreshMs?: number
}

/** Handle returned by {@link startFeishuTeam}. */
export interface FeishuTeamHandle {
  dispose(): void
}

/** Plain-object guard for projection payloads. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read the projection service off the Context, tolerating a missing accessor. */
function readProjectionService(ctx: Context): TeamProjectionReader | undefined {
  try {
    const holder = ctx as unknown as { get?: (name: string) => unknown }
    return holder.get?.('sessionProjections') as TeamProjectionReader | undefined
  } catch {
    return undefined
  }
}

/** Is one member session in a turn right now? Reads the live registry, never throws. */
function memberIsRunning(agents: TeamAgentReader | undefined, id: string): boolean {
  try {
    return agents?.get(id)?.status === 'running'
  } catch {
    return false
  }
}

/**
 * Validate one `agentTeam` projection payload and project it onto the board's
 * row types. Unknown row shapes are dropped rather than rendered as garbage;
 * a payload that is not the projection at all yields `undefined` (no card).
 * @param value - the raw projection value (`snapshot.values.agentTeam`).
 * @param agents - live Agent registry for member activity, optional.
 * @returns the board view, or `undefined` when there is no usable Team state.
 */
export function parseTeamProjection(value: unknown, agents?: TeamAgentReader): TeamBoardView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const rawMembers = record['members']
  const rawTasks = record['tasks']
  if (!Array.isArray(rawMembers) || !Array.isArray(rawTasks)) return undefined

  const members: TeamBoardMember[] = []
  for (const raw of rawMembers) {
    const member = asRecord(raw)
    if (member === undefined) continue
    const id = typeof member['id'] === 'string' ? member['id'] : ''
    if (id === '') continue
    const role = member['role'] === 'lead' ? 'lead' : member['role'] === 'teammate' ? 'teammate' : undefined
    if (role === undefined) continue
    const name = typeof member['name'] === 'string' && member['name'] !== '' ? member['name'] : id
    const phase = member['phase'] as TeamMemberPhase | undefined
    // The Lead is the chat-bound session itself; its role is the useful fact,
    // and its per-turn activity must not repost the board.
    const status: TeamBoardMember['status'] = role === 'lead'
      ? 'running'
      : phase === 'provisioning'
        ? 'provisioning'
        : phase === 'failed'
          ? 'failed'
          : memberIsRunning(agents, id) ? 'running' : 'inactive'
    members.push({
      id,
      name,
      role,
      status,
      ...typeof member['error'] === 'string' && member['error'] !== '' ? { error: member['error'] } : {},
    })
  }
  if (members.length === 0) return undefined

  const tasks: TeamBoardTask[] = []
  for (const raw of rawTasks) {
    const task = asRecord(raw)
    if (task === undefined) continue
    const id = typeof task['id'] === 'string' ? task['id'] : ''
    const status = task['status']
    if (id === '' || status === 'deleted') continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    const subject = typeof task['subject'] === 'string' ? task['subject'] : ''
    const blockedBy = Array.isArray(task['blockedBy'])
      ? task['blockedBy'].filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      : []
    const warnings = Array.isArray(task['writeScopeWarnings'])
      ? task['writeScopeWarnings'].filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      : []
    tasks.push({
      id,
      subject,
      status,
      ...typeof task['ownerName'] === 'string' && task['ownerName'] !== '' ? { ownerName: task['ownerName'] } : {},
      blockedBy,
      ready: task['ready'] === true,
      writeScopeWarnings: warnings,
    })
  }

  return {
    members,
    tasks,
    ...typeof record['failure'] === 'string' && record['failure'] !== '' ? { failure: record['failure'] } : {},
  }
}

/** Icon for one live member status. */
function memberStatusIcon(status: TeamBoardMember['status']): string {
  switch (status) {
    case 'running': return '🟢'
    case 'inactive': return '⚪'
    case 'provisioning': return '⏳'
    case 'failed': return '🔴'
  }
}

/** Locale-aware label for one live member status. */
function memberStatusLabel(status: TeamBoardMember['status'], t: Translations): string {
  switch (status) {
    case 'running': return t.teamMemberRunning
    case 'inactive': return t.teamMemberInactive
    case 'provisioning': return t.teamMemberProvisioning
    case 'failed': return t.teamMemberFailed
  }
}

/** Icon for one task status. */
function taskStatusIcon(status: TeamBoardTask['status']): string {
  switch (status) {
    case 'pending': return '⬜'
    case 'in_progress': return '🔄'
    case 'completed': return '✅'
  }
}

/** Locale-aware label for one task status. */
function taskStatusLabel(status: TeamBoardTask['status'], t: Translations): string {
  switch (status) {
    case 'pending': return t.teamTaskPending
    case 'in_progress': return t.teamTaskInProgress
    case 'completed': return t.teamTaskCompleted
  }
}

/**
 * Structural fingerprint of one board. Clock-derived cells never enter it, so
 * a timer tick cannot justify a new card; any real change does.
 * @param view - the rendered board view.
 * @returns the stable signature the panel sender de-duplicates on.
 */
export function teamBoardSignature(view: TeamBoardView): string {
  return JSON.stringify({
    members: view.members.map(member => [
      member.id,
      member.name,
      member.role,
      // The Lead's status is deliberately not part of the board's identity.
      member.role === 'lead' ? '' : member.status,
      member.error ?? '',
    ]),
    tasks: view.tasks.map(task => [
      task.id,
      task.subject,
      task.status,
      task.ownerName ?? '',
      task.blockedBy,
      task.ready ? 1 : 0,
      task.writeScopeWarnings,
    ]),
    ...view.failure === undefined ? {} : { failure: view.failure },
  })
}

/**
 * Render one Team board card: a compact summary line, the roster, the shared
 * task table, and any invalid-record/warning notice.
 * @param view - board rows to render.
 * @param t - strings for the active locale.
 * @returns the Card JSON 2.0 object to post.
 */
export function renderTeamBoardCard(view: TeamBoardView, t: Translations): object {
  const active = view.tasks.filter(task => task.status === 'in_progress').length
  const memberLines = view.members.map((member) => {
    const icon = member.role === 'lead' ? '👑' : memberStatusIcon(member.status)
    const detail = member.role === 'lead'
      ? t.teamBoardLeadTag
      : ` · ${memberStatusLabel(member.status, t)}`
    const error = member.error === undefined ? '' : ` · ${tableCell(member.error, { max: TEAM_TEXT_MAX })}`
    return `${icon} **${tableCell(member.name, { max: 40 })}**${detail}${error}`
  })
  const elements: object[] = [
    { tag: 'markdown', content: t.teamBoardSummary(view.tasks.length, active, view.members.length) },
    { tag: 'markdown', content: `${t.teamBoardMembersHeader}\n${memberLines.join('\n')}` },
  ]
  if (view.tasks.length === 0) {
    elements.push({ tag: 'markdown', content: t.teamBoardEmpty })
  } else {
    const shown = view.tasks.slice(0, TEAM_TASK_ROWS)
    const rows = shown.map(task => [
      tableCell(`${task.id} ${task.subject}`.trim(), { max: TEAM_SUBJECT_MAX + 8 }),
      `${taskStatusIcon(task.status)} ${taskStatusLabel(task.status, t)}${task.status === 'pending' && !task.ready ? ` · ${t.teamBoardBlockedNote}` : ''}`,
      tableCell(task.ownerName ?? t.teamBoardUnowned, { max: 24 }),
      tableCell(task.blockedBy.length === 0 ? '—' : task.blockedBy.join(', '), { max: 32 }),
    ])
    elements.push({
      tag: 'markdown',
      content: `${t.teamBoardTasksHeader(view.tasks.length)}\n${renderTable(
        [t.teamBoardColTask, t.teamBoardColStatus, t.teamBoardColOwner, t.teamBoardColDependencies],
        rows,
      )}`,
    })
    if (view.tasks.length > shown.length) {
      elements.push({ tag: 'markdown', content: t.teamBoardMore(view.tasks.length - shown.length) })
    }
  }
  const warnings = view.tasks.flatMap(task => task.writeScopeWarnings).slice(0, 3)
  if (warnings.length > 0) {
    elements.push({ tag: 'markdown', content: warnings.map(warning => `⚠️ ${tableCell(warning, { max: 80 })}`).join('\n') })
  }
  if (view.failure !== undefined) {
    elements.push({ tag: 'markdown', content: t.teamBoardFailure(view.failure) })
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.teamBoardTitle }, template: 'turquoise' },
    body: { elements },
  }
}

/** Start the Team board: subscribe to the event trigger, post on change. */
export function startFeishuTeam(deps: FeishuTeamDeps): FeishuTeamHandle {
  const { ctx, channel, bridgeHolder, logger, getTranslations } = deps
  const states = new Map<string, { chat: ConversationMessage; session: unknown; memberIds: Set<string> }>()
  let missingProjectionNoted = false

  /** Read the Team projection for one session; never throws. */
  const readBoard = (session: unknown): TeamBoardView | undefined => {
    // Prefer the service handed in at wiring time, but fall back to a live
    // `ctx.get` so a Host whose composition order registers the projections
    // after this plugin still gets a board (关键坑 2: never a hard dependency).
    const projections = deps.projections ?? readProjectionService(ctx)
    if (projections === undefined) {
      if (!missingProjectionNoted) {
        missingProjectionNoted = true
        logger.info('dsh-feishu: no session projections in this composition; the Agent Teams board stays off')
      }
      return undefined
    }
    try {
      const snapshot = projections.snapshot(session, [TEAM_PROJECTION_KEY])
      const raw = snapshot.values[TEAM_PROJECTION_KEY]
      if (raw === undefined) return undefined
      return parseTeamProjection(raw, deps.agents)
    } catch (error: unknown) {
      logger.warn(`dsh-feishu: team projection read failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  const panel = createPanelSender({
    channel,
    logger,
    ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
    ...(deps.refreshMs === undefined ? {} : { refreshMs: deps.refreshMs }),
    build: (key): PanelSnapshot | undefined => {
      const state = states.get(key)
      if (state === undefined) return undefined
      const view = readBoard(state.session)
      if (view === undefined) return undefined
      // A lone Lead is not a Team: no events mean no board, but guard anyway so
      // a stray projection read cannot post an empty board.
      if (view.members.length <= 1 && view.tasks.length === 0) return undefined
      // Teammate ids drive the turn-activity refresh below; the Lead's own
      // turns are the chat's own turns and must stay out of it.
      state.memberIds = new Set(view.members.filter(member => member.role === 'teammate').map(member => member.id))
      return { card: renderTeamBoardCard(view, getTranslations()), signature: teamBoardSignature(view), chat: state.chat }
    },
  })

  /** Attribute one Team event's session to a chat and refresh that board. */
  const noteTeamChange = (sessionId: string, session: unknown): void => {
    const bridge = bridgeHolder.current
    const chat = bridge?.resolveChat(sessionId)
    if (chat === undefined) return
    const key = conversationKey(chat)
    let state = states.get(key)
    if (state === undefined) {
      if (states.size >= TEAM_CHAT_LIMIT) {
        const oldest = states.keys().next()
        if (!oldest.done) states.delete(oldest.value)
      }
      state = { chat, session, memberIds: new Set() }
      states.set(key, state)
    } else {
      // Keep the freshest topic coordinates and the live Session object the
      // projection read needs (关键坑 25).
      state.chat = chat
      state.session = session
    }
    panel.refresh(key, true)
  }

  // `session/event` is the host-to-host fan-out; this plugin already consumes
  // it elsewhere, and a second listener is cheap. Team events are appended to
  // the LEAD session only, which is also the session a Feishu chat binds to.
  const disposeSession = ctx.on('session/event', (session, rawEvent) => {
    try {
      const event = rawEvent as { type?: unknown } | undefined
      const type = event?.type
      if (typeof type !== 'string') return
      const sessionId = (session as { id?: unknown } | undefined)?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (type === 'team/member' || type === 'team/task') {
        noteTeamChange(sessionId, session)
        return
      }
      // A teammate started or finished a turn: the roster's activity column
      // changed. Only sessions already listed on some board can matter. This is
      // the ONE non-urgent trigger: a continuable teammate flips
      // running/inactive on every turn, so posting per turn would let the
      // activity column dominate the chat. The panel's 30s refresh floor
      // coalesces these with the next real roster/task change (the same lever
      // the job panel uses for progress-only updates).
      if (type === 'turn/start' || type === 'turn/end') {
        for (const [key, state] of states) {
          if (!state.memberIds.has(sessionId)) continue
          panel.refresh(key, false)
          return
        }
      }
    } catch (error: unknown) {
      logger.warn(`dsh-feishu: team event handling failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  return {
    dispose: () => {
      disposeSession()
      panel.dispose()
      states.clear()
    },
  }
}
