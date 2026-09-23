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
 * @module @starxer/chatterbox4dsh/feishu-subagents
 */

import type { Context } from '@deepseek-ai/cordis'
import { conversationKey, type ConversationMessage } from './conversation.ts'
import { createPanelSender, formatDuration, PANEL_MAX_ROWS, PANEL_ROW_TTL_MS, renderTable, tableCell, type PanelChannel, type PanelLogger, type PanelSnapshot } from './feishu-panel.ts'
import type { Translations } from './i18n.ts'

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
  state: SubagentState
  /** Start of the current epoch; the elapsed time of a running row. */
  epochStart: number
  /** Duration of the last CLOSED epoch; `undefined` before any settlement. */
  epochMs: number | undefined
  /** Host stop reason of the last closed epoch (`completed`, `error`, …). */
  stopReason: string | undefined
  /** Epoch ms the row last became inactive; drives roster pruning. */
  settledAt: number | undefined
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
  /** Test seam: coalescing window. Production omits it. */
  debounceMs?: number
  /** Test seam: non-urgent refresh floor. Production omits it. */
  refreshMs?: number
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

/** Status icon and localized label for one row. */
function subagentPresentation(row: SubagentPanelRow, t: Translations): { icon: string; text: string } {
  if (row.state === 'running') return { icon: '🔄', text: t.subagentStatusRunning }
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

/**
 * Render the subagent panel card: one row per known subagent.
 *
 * @param rows - the roster's rows.
 * @param t - the active locale's strings.
 * @param now - epoch ms used for a running row's elapsed time, so the caller
 *   owns the clock and the output stays testable.
 * @returns the Card JSON 2.0 object.
 */
export function renderSubagentPanelCard(rows: readonly SubagentPanelRow[], t: Translations, now: number): object {
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt)
  const shown = sorted.slice(-PANEL_MAX_ROWS)
  const headers = [t.subagentPanelColStatus, t.subagentPanelColAgent, t.subagentPanelColModel, t.subagentPanelColSession, t.subagentPanelColMode, t.subagentPanelColDuration]
  const body = shown.map(row => {
    const status = subagentPresentation(row, t)
    // Nesting reads as indentation instead of a sixth column: the card has no
    // room for a one-digit depth, and the tree is what the reader needs.
    const indent = '　'.repeat(Math.max(0, row.depth - 1))
    const elapsed = row.state === 'running'
      ? now - row.epochStart
      : row.epochMs ?? (row.settledAt ?? now) - row.epochStart
    const label = row.label.trim()
    return [
      `${status.icon} ${status.text}`,
      `${indent}${tableCell(label === '' ? t.subagentUntitled : label, { code: true, max: 40 })}`,
      row.model === '' ? '—' : tableCell(row.model, { code: true, max: 24 }),
      tableCell(row.id, { code: true, max: 14 }),
      modePresentation(row.mode, t),
      formatDuration(elapsed),
    ]
  })
  const running = sorted.filter(row => row.state === 'running').length
  const lines = [`**${t.subagentPanelSummary(running, sorted.length)}**`, '', renderTable(headers, body)]
  if (sorted.length > shown.length) lines.push('', `_${t.panelMoreRows(sorted.length - shown.length)}_`)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.subagentPanelTitle }, template: 'turquoise' },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }] },
  }
}

/**
 * Keep one subagent panel per chat: subscribe to the parent sessions' catalog
 * events and to the subagent lifecycle fan-out.
 *
 * @param deps - context, channel, bridge, logger, and locale reader.
 * @returns a disposer that unsubscribes everything and drops pending timers.
 */
export function startFeishuSubagents(deps: FeishuSubagentsDeps): () => void {
  const { ctx, channel, bridgeHolder, logger, getTranslations } = deps
  const rosters = new Map<string, SubagentRoster>()
  /** child id → where it lives; also the attribution table for grandchildren. */
  const children = new Map<string, ChildRef>()

  const warn = (message: string, error: unknown): void => {
    // Never log the error object itself: the SDK's errors carry the request
    // body, which holds the app secret (硬规则 2).
    logger.warn(`dsh-feishu: ${message}: ${error instanceof Error ? error.message : String(error)}`)
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
      model: '',
      depth,
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
        data?: { childId?: unknown; childCreatedAt?: unknown; mode?: unknown; label?: unknown; model?: unknown } | null
      }
      // The child's own route metadata (`request/context`) is the only place its
      // model is stated: the parent's catalog entry and the lifecycle edges both
      // omit it. Children are just sessions, so these events arrive here too.
      if (event.type === 'request/context') {
        const ref = children.get(session.id)
        if (ref === undefined) return
        const model = event.data?.model
        if (typeof model !== 'string' || model === '') return
        const row = rosters.get(ref.key)?.rows.get(session.id)
        if (row === undefined || row.model === model) return
        row.model = model
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

  return () => {
    disposeCatalog()
    disposeStart()
    disposeEnd()
    panel.dispose()
    rosters.clear()
    children.clear()
  }
}
