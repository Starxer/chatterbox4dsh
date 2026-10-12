/**
 * Feishu UI bridge for subagents: one PANEL card per chat listing every
 * subagent that conversation spawned, posted fresh whenever the roster
 * changes.
 *
 * The card is send-only — it is never patched in place (see `feishu-panel.ts`).
 *
 * ## Where the facts come from
 *
 * Two independent Host facts are correlated by CHILD SESSION ID, which is what
 * makes this module need no new dependency (neither `dsh-subagent` nor
 * `dsh-scope` is one of this plugin's peers):
 *
 * | fact | source | carries |
 * |---|---|---|
 * | a child was created | `session/event` `subagent/catalog` on the PARENT session | child id, mode, label, creation time |
 * | an epoch started / settled | `subagent/start` / `subagent/end` | child id, stop reason |
 *
 * The catalog event is appended by the Host *before* the run is published
 * (`packages/subagent/subagent/src/index.ts`: `establishCatalogChild` then
 * `observeRun`), so the row always exists by the time the lifecycle edges
 * arrive. Both lifecycle events are dispatched with the delegating parent's
 * scope carrier; this listener registers `{ global: true }` and therefore sees
 * every subagent regardless of which scope it was dispatched in.
 *
 * Attribution, in order:
 *
 * 1. the parent session is a session this plugin already knows as a CHILD →
 *    the new child is a grandchild, same chat, one level deeper;
 * 2. otherwise the parent session resolves to a Feishu chat → a direct child;
 * 3. otherwise the subagent belongs to a session no chat is bound to (a
 *    subagent's own child, before step 1 learned about it) → not rendered.
 *
 * A remote run (an out-of-process provider, `local: false`) appends no catalog
 * event for lack of a local child session and is therefore not listed; the
 * lifecycle event alone carries no chat attribution.
 *
 * ## The manual panel (`/subagents`)
 *
 * {@link startFeishuSubagents} also exposes an on-demand panel, which reads a
 * SECOND fact source: the Host's own subagent catalog service
 * (`ctx.get('subagents')`, read and NEVER injected — 关键坑 2). That catalog is
 * the authority on WHICH children exist and how they nest, while the in-process
 * roster is the only place run durations and settlement reasons live, so a row
 * is filled from both: id / label / mode / depth from the catalog, model /
 * duration / outcome from the roster, state from whichever knows it. A child
 * that existed before this process started (or whose catalog was the only
 * record left) therefore shows up in the manual panel too — with the duration
 * cell honestly blank, because a catalog records when a child was created, not
 * how long its runs took.
 *
 * @module @starxer/chatterbox4dsh/feishu-subagents
 */

import type { Context } from '@deepseek-ai/cordis'
import { conversationKey, type ConversationMessage } from './conversation.ts'
import { createPanelSender, formatDuration, PANEL_MAX_ROWS, PANEL_ROW_TTL_MS, renderTable, replyOptsForChat, tableCell, type PanelChannel, type PanelLogger, type PanelSnapshot } from './feishu-panel.ts'
import type { Translations } from './i18n.ts'
import { withTimeout } from './outbound-timeout.ts'

/** How a child was created, as recorded in the parent's catalog. */
export type SubagentMode = 'one-shot' | 'continuable' | 'unknown'

/** Whether the Host currently observes a resident session for a child. */
export type SubagentState = 'running' | 'inactive'

/** One roster row: the durable creation facts plus the last observed edge. */
export interface SubagentPanelRow {
  /** Durable child session id; the correlation key for every fact below. */
  id: string
  createdAt: number
  mode: SubagentMode
  /** Creation label (the delegation description); `''` when the tool passed none. */
  label: string
  /**
   * Model route the child's own session reported (`request/context`), or `''`
   * while unknown. The child's log is the only place this fact lives: neither
   * the parent's catalog entry nor the lifecycle edges carry it.
   */
  model: string
  /** Edge distance from the chat-bound session: a direct child is `1`. */
  depth: number
  /**
   * The parent's child-session id, or `undefined` for a direct child of the
   * chat-bound session. Kept so the card can draw a real tree (`└─ ` / `├─ `)
   * rather than invisible indentation, which Feishu renders as a flat list.
   */
  parentId: string | undefined
  state: SubagentState
  /** Start of the current epoch; the elapsed time of a running row. */
  epochStart: number
  /** Duration of the last CLOSED epoch; `undefined` before any settlement. */
  epochMs: number | undefined
  /** Host stop reason of the last closed epoch (`completed`, `error`, …). */
  stopReason: string | undefined
  /** Epoch ms the row last became inactive; drives roster pruning. */
  settledAt: number | undefined
  /**
   * True when the row exists only because the Host's catalog says so — this
   * process never observed one of its runs. Two cells differ then: the duration
   * is unknown (a catalog records creation, never run length) and "not running"
   * is the honest state. Rows the roster knows leave it undefined.
   */
  catalogOnly?: boolean
  /** Why the Host could not describe this catalog row (`corrupt` / `unsupported` / `unavailable`). */
  diagnostic?: string
}

/** One chat's roster. */
interface SubagentRoster {
  /** Coordinates of the session this roster belongs to (关键坑 25/31). */
  chat: ConversationMessage
  /** child id → row. */
  rows: Map<string, SubagentPanelRow>
}

/** Where one known child lives, so a grandchild can be attributed without a read. */
interface ChildRef {
  /** Roster key of the chat this child belongs to. */
  key: string
  /** The child's own depth, so its children are one deeper. */
  depth: number
}

/** Narrow bridge surface: the session → chat lookup (关键坑 31). */
export interface SubagentBridge {
  resolveChat(sessionId: string): ConversationMessage | undefined
}

/** Source of the current bridge. */
export interface SubagentBridgeHolder {
  current: SubagentBridge | undefined
}

/** Public deps for the subagents module. */
export interface FeishuSubagentsDeps {
  ctx: Context
  channel: PanelChannel
  bridgeHolder: SubagentBridgeHolder
  logger: PanelLogger
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
  /**
   * The route a child session is ACTUALLY running — its own cached fold of
   * `request/context`, or undefined when that session is not resident.
   *
   * Waiting for the live event is not enough: DSH appends `request/context` only
   * when the route CHANGES (`agent-loop/src/agent.ts` compares against the
   * session's previous context), so a RESUMED continuable subagent emits no such
   * event at all and its row stayed `—` forever even after it finished
   * (reported 2026-10-12). Pure memory, no I/O: `sessions.get(id)?.requestContext()`.
   */
  readChildRoute?: (sessionId: string) => { provider?: string; model?: string } | undefined
  /**
   * The live Agent registry, read the same way the Host's own `list_agents`
   * tool reads it: a child is running iff `agents.get(id)?.status` is. Used
   * only for rows the in-process roster never observed.
   */
  agents?: { get(id: string): { status?: string } | undefined }
  /** Test seam: budget for one Host catalog read. Production omits it. */
  catalogTimeoutMs?: number
  /** Test seam: coalescing window. Production omits it. */
  debounceMs?: number
  /** Test seam: non-urgent refresh floor. Production omits it. */
  refreshMs?: number
}

/** How much of the subtree one manual panel request covers. */
export type SubagentPanelScope = 'children' | 'tree'

/** One manual panel request: which chat, which session, how deep. */
export interface SubagentPanelRequest {
  scope: SubagentPanelScope
  /**
   * The session whose catalog is read. Resolved by the CALLER through the
   * bridge's own `resolveSessionIdFor`, so this module never grows a second
   * idea of what a chat's session is (关键坑 25/31).
   */
  sessionId: string
}

/** What a manual open did: a fresh card, or the text to echo instead. */
export type SubagentOpenResult =
  | { kind: 'card'; messageId?: string }
  | { kind: 'text'; text: string }

/** The handle returned by {@link startFeishuSubagents}. */
export interface SubagentPanelHandle {
  /**
   * Post this chat's subagent panel on demand. Never rejects for a missing
   * service or a failed catalog read — both fall back to the in-process roster.
   */
  open(chat: ConversationMessage, request: SubagentPanelRequest): Promise<SubagentOpenResult>
  /** Unsubscribe everything and drop the pending timers. */
  dispose(): void
}

/**
 * The Host's subagent catalog service, reduced to the two reads this module
 * makes. The payload stays `unknown`: the rows are normalized by
 * {@link parseHostSubagentEntries}, which is also where the shapes of the two
 * scopes are folded together.
 */
interface SubagentsServiceLike {
  listChildren(sessionId: string, signal?: AbortSignal): Promise<unknown>
  listDescendants(sessionId: string, signal?: AbortSignal): Promise<unknown>
}

/** One catalog row, normalized across both scopes. */
export interface HostSubagentEntry {
  id: string
  mode: SubagentMode
  label: string
  /** Parent session id for a nested row; `undefined` for a direct child. */
  parentId: string | undefined
  /** Edge distance from the requested root; direct children are `1`. */
  depth: number
  /** Host diagnostic reason, when the row is a diagnostic rather than a child. */
  diagnostic: string | undefined
}

/**
 * Budget for one Host catalog read. The read walks parent catalogs through the
 * session query service, so it is a promise that could outlive the chat that
 * asked for it — bounded here (硬规则 2 / 关键坑 29). Generous: it exists to
 * break a hang, not to enforce a latency budget.
 */
export const CATALOG_READ_TIMEOUT_MS = 5_000

/**
 * One route as the model cell shows it: `provider/model`, or whichever half is
 * known. `''` when there is no model to name, which the card renders as `—`.
 */
export function formatChildRoute(provider: unknown, model: unknown): string {
  const name = typeof model === 'string' ? model.trim() : ''
  if (name === '') return ''
  const source = typeof provider === 'string' ? provider.trim() : ''
  return source === '' ? name : `${source}/${name}`
}

/**
 * The Host's subagent lifecycle fan-out. Declared locally for the same reason
 * `JobViewLike` is: `@deepseek-ai/dsh-subagent` is not one of this plugin's
 * peers, and matching its exact payload type would not survive a minor release.
 */
interface SubagentLifecycleEvents {
  on(
    name: 'subagent/start' | 'subagent/end',
    listener: (this: unknown, info: unknown) => void,
    options: { global: true },
  ): () => void
}

/** One lifecycle payload, reduced to the fields this module reads. */
interface SubagentLifecycleInfo {
  id: string
  stopReason: string | undefined
}

/**
 * Reduce a lifecycle payload to the fields the roster needs.
 *
 * @param raw - the event payload exactly as the Host dispatched it.
 * @returns the reduced info, or `undefined` when the payload is unusable.
 */
export function parseSubagentLifecycle(raw: unknown): SubagentLifecycleInfo | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as { id?: unknown; stopReason?: unknown }
  if (typeof record.id !== 'string' || record.id === '') return undefined
  return { id: record.id, stopReason: typeof record.stopReason === 'string' ? record.stopReason : undefined }
}

/** Narrow one catalog payload's `mode` to the known set. */
function toMode(value: unknown): SubagentMode {
  return value === 'one-shot' || value === 'continuable' ? value : 'unknown'
}

/**
 * Normalize one catalog read — children or descendants — into a single shape.
 *
 * Two deliberate differences from the Host's `list_agents` TOOL, which projects
 * the same service rows:
 *
 * 1. **No mode filtering.** That tool drops one-shot children because
 *    `send_message` cannot continue them; a read-only panel has no such
 *    constraint, so the RAW rows are read and one-shot children are listed too.
 * 2. **`activity` is not trusted.** The tool recomputes status from the live
 *    Agent registry (`agents.get(id)?.status`), because a descendant row's
 *    `activity` is only "a resident Session was observed during the walk".
 *    {@link mergeSubagentPanelRows} does the same, from the registry.
 *
 * @param raw - whatever the Host's service resolved to.
 * @returns the usable rows, in the order the Host returned them.
 */
export function parseHostSubagentEntries(raw: unknown): HostSubagentEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: HostSubagentEntry[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id === '') continue
    const parent = typeof record.parentId === 'string' && record.parentId !== '' ? record.parentId : undefined
    const depth = typeof record.depth === 'number' && Number.isFinite(record.depth) && record.depth > 0
      ? Math.floor(record.depth)
      : 1
    const diagnostic = record.kind === 'diagnostic' && typeof record.reason === 'string' ? record.reason : undefined
    entries.push({
      id: record.id,
      // A diagnostic row describes a child the Host could not read, so its
      // mode is by definition not one it could name.
      mode: diagnostic === undefined ? toMode(record.mode) : 'unknown',
      label: typeof record.label === 'string' ? record.label : '',
      parentId: parent,
      depth,
      diagnostic,
    })
  }
  return entries
}

/** The observation half of a roster row: what only this process can know. */
function observationOf(row: SubagentPanelRow): Pick<SubagentPanelRow, 'model' | 'state' | 'epochStart' | 'epochMs' | 'stopReason' | 'settledAt'> {
  return {
    model: row.model,
    state: row.state,
    epochStart: row.epochStart,
    epochMs: row.epochMs,
    stopReason: row.stopReason,
    settledAt: row.settledAt,
  }
}

/**
 * Merge the Host catalog with this process's roster into the rows one panel
 * card shows, keyed by child session id.
 *
 * One rule per fact, and no guessing: the catalog owns identity (id, label,
 * mode, depth, parent) because it is the only source that survives a restart;
 * the roster owns the run (model, duration, stop reason, state) because a
 * catalog records WHEN a child was created and never how long it ran. A row
 * only the catalog knows gets its state computed from the live Agent registry —
 * the same reading the Host's own tool uses — and is marked `catalogOnly` so
 * the card renders an honest `—` and "not running" instead of inventing a
 * duration. A row only the roster knows is kept verbatim, so the panel still
 * answers when the catalog service is absent or its read fails.
 *
 * @param host - normalized catalog rows (possibly empty).
 * @param roster - this chat's roster rows.
 * @param isRunning - reads the live Agent registry for one child id.
 * @returns the merged rows, catalog order first.
 */
export function mergeSubagentPanelRows(
  host: readonly HostSubagentEntry[],
  roster: readonly SubagentPanelRow[],
  isRunning: (id: string) => boolean,
): SubagentPanelRow[] {
  const known = new Map(roster.map(row => [row.id, row]))
  const merged: SubagentPanelRow[] = []
  const listed = new Set<string>()
  for (const entry of host) {
    const observed = known.get(entry.id)
    listed.add(entry.id)
    const identity = {
      id: entry.id,
      // Descendant rows carry no creation time; 0 keeps the Host's own
      // pre-order, which is stable under the tree's sort.
      createdAt: observed?.createdAt ?? 0,
      mode: entry.mode,
      label: entry.label,
      depth: entry.depth,
      parentId: entry.parentId,
      ...entry.diagnostic === undefined ? {} : { diagnostic: entry.diagnostic },
    }
    merged.push(observed === undefined
      ? {
          ...identity,
          // No run was ever observed: no route, no duration, no outcome. The
          // state comes from the registry; everything else stays empty so the
          // card renders `—` rather than a fabricated number.
          model: '',
          state: isRunning(entry.id) ? 'running' : 'inactive',
          epochStart: 0,
          epochMs: undefined,
          stopReason: undefined,
          settledAt: undefined,
          catalogOnly: true,
        }
      : { ...identity, ...observationOf(observed) })
  }
  for (const row of roster) {
    if (!listed.has(row.id)) merged.push(row)
  }
  return merged
}

/** Status icon and localized label for one row. */
function subagentPresentation(row: SubagentPanelRow, t: Translations): { icon: string; text: string } {
  if (row.state === 'running') return { icon: '🔄', text: t.subagentStatusRunning }
  // Nobody in this process watched this child settle, so "ended" would claim
  // an outcome nobody reported: the honest state is "not running".
  if (row.catalogOnly === true) return { icon: '⏹️', text: t.subagentStatusNotRunning }
  switch (row.stopReason) {
    case 'completed': return { icon: '✅', text: t.subagentStatusCompleted }
    case 'max-tokens': return { icon: '⚠️', text: t.subagentStatusMaxTokens }
    case 'aborted': return { icon: '⛔', text: t.subagentStatusAborted }
    case 'refusal': return { icon: '🚫', text: t.subagentStatusRefused }
    case 'error': return { icon: '❌', text: t.subagentStatusFailed }
    default: return { icon: '⏹️', text: t.subagentStatusInactive }
  }
}

/** Localized mode label. */
function modePresentation(mode: SubagentMode, t: Translations): string {
  switch (mode) {
    case 'one-shot': return t.subagentModeOneShot
    case 'continuable': return t.subagentModeContinuable
    case 'unknown': return t.subagentModeUnknown
  }
}

/**
 * Group rows by their parent, oldest child first. A row whose parent is not in
 * `rows` (pruned, or never known) is treated as a root, so pruning can never
 * push a row out of the table.
 */
function childrenByParent(rows: readonly SubagentPanelRow[]): Map<string | undefined, SubagentPanelRow[]> {
  const ids = new Set(rows.map(row => row.id))
  const byParent = new Map<string | undefined, SubagentPanelRow[]>()
  for (const row of rows) {
    const parent = row.parentId !== undefined && ids.has(row.parentId) ? row.parentId : undefined
    const siblings = byParent.get(parent)
    if (siblings === undefined) byParent.set(parent, [row])
    else siblings.push(row)
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.createdAt - b.createdAt)
  return byParent
}

/**
 * Depth-first order: a parent immediately precedes its own children, which is
 * what makes {@link treePrefixes} readable.
 *
 * @param rows - the roster.
 * @returns the rows in tree order.
 */
export function treeOrder(rows: readonly SubagentPanelRow[]): SubagentPanelRow[] {
  const byParent = childrenByParent(rows)
  const ordered: SubagentPanelRow[] = []
  const visit = (parent: string | undefined): void => {
    for (const row of byParent.get(parent) ?? []) {
      ordered.push(row)
      visit(row.id)
    }
  }
  visit(undefined)
  return ordered
}

/**
 * Tree connector for each row's label cell: `└─ ` for a last child, `├─ ` for
 * one with a following sibling, prefixed by `│  ` / `   ` per ancestor that
 * still has siblings below it. Roots get no connector.
 *
 * @param rows - the roster.
 * @returns row id → connector prefix.
 */
export function treePrefixes(rows: readonly SubagentPanelRow[]): Map<string, string> {
  const byParent = childrenByParent(rows)
  const prefixes = new Map<string, string>()
  const visit = (parent: string | undefined, bars: readonly boolean[]): void => {
    const siblings = byParent.get(parent) ?? []
    siblings.forEach((row, index) => {
      const last = index === siblings.length - 1
      prefixes.set(row.id, parent === undefined
        ? ''
        : `${bars.map(more => (more ? '│  ' : '   ')).join('')}${last ? '└─ ' : '├─ '}`)
      visit(row.id, parent === undefined ? [] : [...bars, !last])
    })
  }
  visit(undefined, [])
  return prefixes
}

/**
 * Structural fingerprint of a roster: everything the table shows EXCEPT the
 * clock-derived durations, so a mere clock tick can never justify a new card.
 *
 * @param rows - the rows to fingerprint.
 * @returns the fingerprint string.
 */
export function subagentRosterSignature(rows: readonly SubagentPanelRow[]): string {
  return [...rows]
    .map(row => [row.id, row.state, row.mode, row.label, row.model, String(row.depth), row.stopReason ?? ''].join('\u0001'))
    .sort()
    .join('\u0002')
}

/** Optional, caller-owned decoration of the panel card. */
export interface SubagentPanelCardOptions {
  /**
   * One notation line under the header naming where the rows came from. Only
   * the MANUAL panel passes it: it merges two sources, and an automatic card
   * is posted from one.
   */
  source?: string
}

/**
 * Render the subagent panel card: one row per known subagent.
 *
 * @param rows - the roster's rows.
 * @param t - the active locale's strings.
 * @param now - epoch ms used for a running row's elapsed time, so the caller
 *   owns the clock and the output stays testable.
 * @param options - optional header decoration; omitted by the automatic panel,
 *   whose card is byte-identical to what it always rendered.
 * @returns the Card JSON 2.0 object.
 */
export function renderSubagentPanelCard(rows: readonly SubagentPanelRow[], t: Translations, now: number, options: SubagentPanelCardOptions = {}): object {
  // Depth-first order puts every child directly under its parent, which is what
  // makes the connectors below mean something.
  const ordered = treeOrder(rows)
  const prefixes = treePrefixes(rows)
  const shown = ordered.slice(-PANEL_MAX_ROWS)
  const headers = [t.subagentPanelColStatus, t.subagentPanelColAgent, t.subagentPanelColModel, t.subagentPanelColSession, t.subagentPanelColMode, t.subagentPanelColDuration]
  const body = shown.map(row => {
    const status = subagentPresentation(row, t)
    // A drawn connector instead of leading spaces: Feishu collapses or hides
    // whitespace inside a table cell, so an indent-only tree read as a flat
    // list (operator feedback 2026-09-23). Box-drawing glyphs survive, and
    // inside the code span they also align in a monospace face.
    const prefix = prefixes.get(row.id) ?? ''
    const elapsed = row.state === 'running'
      ? now - row.epochStart
      : row.epochMs ?? (row.settledAt ?? now) - row.epochStart
    // A catalog-only row has no run to measure: the catalog records when the
    // child was created, never how long an epoch took. `—` is the truth.
    const duration = row.catalogOnly === true ? '—' : formatDuration(elapsed)
    const label = row.diagnostic !== undefined ? t.subagentDiagnostic(row.diagnostic) : row.label.trim()
    return [
      `${status.icon} ${status.text}`,
      // The connector stays OUTSIDE the code span: `tableCell` collapses all
      // whitespace, which would flatten `│  ` (two spaces) to `│ ` and break
      // the tree's alignment.
      `${prefix}${tableCell(label === '' ? t.subagentUntitled : label, { code: true, max: 40 })}`,
      row.model === '' ? '—' : tableCell(row.model, { code: true, max: 32 }),
      tableCell(row.id, { code: true, max: 14 }),
      modePresentation(row.mode, t),
      duration,
    ]
  })
  const running = ordered.filter(row => row.state === 'running').length
  // The source line lives INSIDE the one markdown element: a second element
  // would pay another round of container spacing for one line (关键坑 58).
  const lines = [
    `**${t.subagentPanelSummary(running, ordered.length)}**`,
    ...options.source === undefined ? [] : [`_${options.source}_`],
    '',
    renderTable(headers, body),
  ]
  if (ordered.length > shown.length) lines.push('', `_${t.panelMoreRows(ordered.length - shown.length)}_`)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.subagentPanelTitle }, template: 'turquoise' },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }] },
  }
}

/**
 * Keep one subagent panel per chat: subscribe to the parent sessions' catalog
 * events and to the subagent lifecycle fan-out, and expose the on-demand panel
 * behind `/subagents`.
 *
 * @param deps - context, channel, bridge, logger, and locale reader.
 * @returns the panel handle; `dispose()` unsubscribes everything and drops the
 *   pending timers.
 */
export function startFeishuSubagents(deps: FeishuSubagentsDeps): SubagentPanelHandle {
  const { ctx, channel, bridgeHolder, logger, getTranslations } = deps
  const rosters = new Map<string, SubagentRoster>()
  /** child id → where it lives; also the attribution table for grandchildren. */
  const children = new Map<string, ChildRef>()
  /** chat → signature of the snapshot its last MANUAL open posted. */
  const manualSignatures = new Map<string, string>()
  /** Whether the absent-catalog-service note was already logged. */
  let missingCatalogNoted = false

  const warn = (message: string, error: unknown): void => {
    // Never log the error object itself: the SDK's errors carry the request
    // body, which holds the app secret (硬规则 2).
    logger.warn(`dsh-feishu: ${message}: ${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * Ask the host for a child's current route, best-effort.
   *
   * This is the fallback for the case the live event cannot cover: DSH only
   * appends `request/context` when the route changes, so a resumed child that
   * kept its route never produces one. A throw here must not cost the card, and
   * the accessor is a memory lookup, so failures are swallowed.
   */
  const childRoute = (sessionId: string): string => {
    try {
      const route = deps.readChildRoute?.(sessionId)
      return route === undefined ? '' : formatChildRoute(route.provider, route.model)
    } catch {
      return ''
    }
  }

  /**
   * Drop roster rows a later card should no longer carry: settled long ago, or
   * pushed out by {@link PANEL_MAX_ROWS} newer ones. Live rows are never
   * dropped, but their roster entry (and therefore their chat attribution) is
   * only dropped together with the row.
   */
  const prune = (roster: SubagentRoster, now: number): void => {
    for (const [id, row] of roster.rows) {
      if (row.settledAt !== undefined && now - row.settledAt > PANEL_ROW_TTL_MS) {
        roster.rows.delete(id)
        children.delete(id)
      }
    }
    if (roster.rows.size <= PANEL_MAX_ROWS) return
    const byCreated = [...roster.rows.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (const [id] of byCreated.slice(0, roster.rows.size - PANEL_MAX_ROWS)) {
      roster.rows.delete(id)
      children.delete(id)
    }
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
      // A row created before its session was resident has no route yet: ask
      // again here, so the first card that CAN carry the model does.
      for (const row of rows) {
        if (row.model !== '') continue
        const route = childRoute(row.id)
        if (route !== '') row.model = route
      }
      if (rows.length === 0) {
        rosters.delete(key)
        return undefined
      }
      return { card: renderSubagentPanelCard(rows, getTranslations(), now), signature: subagentRosterSignature(rows), chat: roster.chat }
    },
  })

  /** Record a child's catalog entry. Returns the roster key it landed in. */
  const noteCatalog = (parentSessionId: string, data: { childId: string; childCreatedAt: number; mode: SubagentMode; label: string }): void => {
    if (children.has(data.childId)) return
    const parent = children.get(parentSessionId)
    let key: string
    let depth: number
    let chat: ConversationMessage | undefined
    if (parent !== undefined) {
      key = parent.key
      depth = parent.depth + 1
    } else {
      const resolved = bridgeHolder.current?.resolveChat(parentSessionId)
      if (resolved === undefined) return
      key = conversationKey(resolved)
      depth = 1
      chat = resolved
    }
    let roster = rosters.get(key)
    if (roster === undefined) {
      if (chat === undefined) return
      roster = { chat, rows: new Map() }
      rosters.set(key, roster)
    } else if (chat !== undefined) {
      // Keep the freshest topic coordinates (关键坑 25).
      roster.chat = chat
    }
    roster.rows.set(data.childId, {
      id: data.childId,
      createdAt: data.childCreatedAt,
      mode: data.mode,
      label: data.label,
      // Ask the host straight away: a resumed child keeps the route it already
      // had, so no `request/context` event is coming (see the dep's doc).
      model: childRoute(data.childId),
      depth,
      parentId: parent === undefined ? undefined : parentSessionId,
      state: 'running',
      epochStart: data.childCreatedAt,
      epochMs: undefined,
      stopReason: undefined,
      settledAt: undefined,
    })
    children.set(data.childId, { key, depth })
    panel.refresh(key, true)
  }

  /** The Host recorded a child in its parent's catalog. */
  const disposeCatalog = ctx.on('session/event', (session, rawEvent) => {
    try {
      const event = rawEvent as {
        type?: string
        data?: { childId?: unknown; childCreatedAt?: unknown; mode?: unknown; label?: unknown; provider?: unknown; model?: unknown } | null
      }
      // The child's own route metadata (`request/context`) is the only place its
      // model is stated: the parent's catalog entry and the lifecycle edges both
      // omit it. Children are just sessions, so these events arrive here too.
      if (event.type === 'request/context') {
        const ref = children.get(session.id)
        if (ref === undefined) return
        const route = formatChildRoute(event.data?.provider, event.data?.model)
        if (route === '') return
        const row = rosters.get(ref.key)?.rows.get(session.id)
        if (row === undefined || row.model === route) return
        row.model = route
        // A detail-only change, so it rides the panel's refresh floor — and it
        // is skipped entirely while a snapshot is being built, because that
        // build already renders the model.
        if (!panel.hasPending(ref.key)) panel.refresh(ref.key, false)
        return
      }
      if (event.type !== 'subagent/catalog') return
      const data = event.data
      if (data === undefined || data === null || typeof data.childId !== 'string' || data.childId === '') return
      noteCatalog(session.id, {
        childId: data.childId,
        childCreatedAt: typeof data.childCreatedAt === 'number' ? data.childCreatedAt : Date.now(),
        mode: toMode(data.mode),
        label: typeof data.label === 'string' ? data.label : '',
      })
    } catch (error: unknown) {
      warn('subagent session event handling failed', error)
    }
  })

  /** A published child became resident (a new epoch for a continuable child). */
  const handleStart = (info: SubagentLifecycleInfo): void => {
    const ref = children.get(info.id)
    if (ref === undefined) return
    const row = rosters.get(ref.key)?.rows.get(info.id)
    if (row === undefined) return
    if (row.state === 'running') {
      // The usual case right after `subagent/catalog`: refine the anchor only.
      // The card's fingerprint ignores durations, so this posts nothing.
      row.epochStart = Date.now()
      return
    }
    row.state = 'running'
    row.epochStart = Date.now()
    row.epochMs = undefined
    row.stopReason = undefined
    row.settledAt = undefined
    panel.refresh(ref.key, true)
  }

  /** A published child settled: record the outcome and repaint the panel. */
  const handleEnd = (info: SubagentLifecycleInfo): void => {
    const ref = children.get(info.id)
    if (ref === undefined) return
    const row = rosters.get(ref.key)?.rows.get(info.id)
    if (row === undefined) return
    const now = Date.now()
    row.state = 'inactive'
    row.epochMs = Math.max(0, now - row.epochStart)
    row.stopReason = info.stopReason ?? 'error'
    row.settledAt = now
    panel.refresh(ref.key, true)
  }

  /**
   * The Host's lifecycle fan-out is registered `{ global: true }`: the events
   * are dispatched with the delegating parent's scope carrier, and this plugin
   * wants every subagent, not only those of a scope it happens to sit under.
   */
  const lifecycle = ctx as unknown as SubagentLifecycleEvents
  const disposeStart = lifecycle.on('subagent/start', raw => {
    const info = parseSubagentLifecycle(raw)
    if (info === undefined) return
    try {
      handleStart(info)
    } catch (error: unknown) {
      warn('subagent start handling failed', error)
    }
  }, { global: true })
  const disposeEnd = lifecycle.on('subagent/end', raw => {
    const info = parseSubagentLifecycle(raw)
    if (info === undefined) return
    try {
      handleEnd(info)
    } catch (error: unknown) {
      warn('subagent end handling failed', error)
    }
  }, { global: true })

  /**
   * The Host's subagent catalog service, read through `ctx.get` and NEVER added
   * to `inject`: a composition without `@deepseek-ai/dsh-subagent` must still
   * boot (关键坑 2) — it just gets the roster-only panel. `get` is called
   * optionally so a context that does not carry the accessor at all degrades
   * the same way instead of throwing.
   */
  const catalogService = (): SubagentsServiceLike | undefined => {
    const holder = ctx as unknown as { get?: (name: string) => unknown }
    const service = holder.get?.('subagents')
    if (service === undefined || service === null) {
      if (!missingCatalogNoted) {
        missingCatalogNoted = true
        logger.info('dsh-feishu: no subagent catalog service in this composition; /subagents falls back to this process\'s roster')
      }
      return undefined
    }
    return service as SubagentsServiceLike
  }

  /**
   * Read the catalog for one scope, bounded (硬规则 2 / 关键坑 29) and
   * best-effort: an absent service, a throw, and a read that never settles all
   * end the same way — an empty catalog, so the caller falls back to the
   * in-process roster instead of failing the command.
   */
  const readCatalog = async (scope: SubagentPanelScope, sessionId: string): Promise<HostSubagentEntry[]> => {
    const service = catalogService()
    if (service === undefined) return []
    const budget = deps.catalogTimeoutMs ?? CATALOG_READ_TIMEOUT_MS
    // Forward the signal so a read abandoned by the budget below also stops
    // inside the Host rather than walking catalogs nobody is waiting for.
    const controller = new AbortController()
    try {
      const pending = scope === 'tree'
        ? service.listDescendants(sessionId, controller.signal)
        : service.listChildren(sessionId, controller.signal)
      return parseHostSubagentEntries(await withTimeout(pending, `subagent ${scope} catalog read`, budget))
    } catch (error: unknown) {
      controller.abort()
      warn(`subagent ${scope} catalog read failed`, error)
      return []
    }
  }

  /** Is this child working right now? Read the way the Host's tool reads it. */
  const childIsRunning = (id: string): boolean => {
    try {
      return deps.agents?.get(id)?.status === 'running'
    } catch {
      return false
    }
  }

  /**
   * Post this chat's panel on demand (`/subagents`).
   *
   * Merges the Host catalog (authoritative on identity, and the only source
   * for a child that started before this process did) with this process's
   * roster (the only source for a run's model, duration and outcome). Both
   * paths answer: an empty result is a one-line text, never an empty table
   * card, and a snapshot identical to the one this chat was last shown answers
   * with a line instead of a duplicate card. The automatic panel's own
   * de-duplication is untouched — this is a separate table.
   */
  const open = async (chat: ConversationMessage, request: SubagentPanelRequest): Promise<SubagentOpenResult> => {
    const t = getTranslations()
    const key = conversationKey(chat)
    const rosterRows = [...(rosters.get(key)?.rows.values() ?? [])]
    const host = await readCatalog(request.scope, request.sessionId)
    const rows = mergeSubagentPanelRows(host, rosterRows, childIsRunning)
    if (rows.length === 0) return { kind: 'text', text: t.subagentCommandEmpty }
    const signature = subagentRosterSignature(rows)
    if (manualSignatures.get(key) === signature) {
      return { kind: 'text', text: t.subagentCommandUnchanged }
    }
    manualSignatures.set(key, signature)
    const card = renderSubagentPanelCard(rows, t, Date.now(), { source: t.subagentPanelSource })
    // Same topic discipline as the automatic panel: the coordinates come from
    // the chat the command ran in (关键坑 25/31).
    const sent = await channel.send(chat.chatId, { card }, replyOptsForChat(chat))
    return sent.messageId === undefined
      ? { kind: 'card' }
      : { kind: 'card', messageId: sent.messageId }
  }

  return {
    open,
    dispose: () => {
      disposeCatalog()
      disposeStart()
      disposeEnd()
      panel.dispose()
      rosters.clear()
      children.clear()
      manualSignatures.clear()
    },
  }
}
