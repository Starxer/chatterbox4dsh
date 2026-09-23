/**
 * Shared plumbing for the roster panels: the background-task panel
 * (`feishu-jobs.ts`) and the subagent panel (`feishu-subagents.ts`).
 *
 * A panel card is SEND-ONLY. It is not a live view that gets patched in place:
 * every ROSTER change posts a fresh snapshot into the chat, and the card is
 * never edited again (2026-09-23, the operator's call — both panels describe
 * detached background work, so a card is a notification, not a control
 * surface). That removes the whole class of in-place-update problems the
 * per-job cards carried: no message id bookkeeping, no update cap, and no
 * "stale card" rewrite that destroyed the terminal record (关键坑 11).
 *
 * What IS shared therefore shrinks to four rules, all implemented here:
 *
 * 1. **Coalescing** — triggers that land in the same tick (a step that starts
 *    three background jobs) produce ONE card listing all three, not three
 *    cards. The flush renders the roster at fire time, so the card always
 *    shows the latest state.
 * 2. **A refresh floor for non-urgent triggers** — a job whose progress line
 *    changes every second must not post a card every second. Roster changes
 *    (a row appears, a state flips, a row settles) are urgent and bypass the
 *    floor; text-only refreshes wait for it.
 * 3. **Fingerprint de-duplication** — a snapshot whose structural fingerprint
 *    equals the last one SENT for that chat is dropped. Elapsed times are
 *    rendered but deliberately excluded from the fingerprint, so a clock tick
 *    can never justify a card.
 * 4. **Per-chat serialization** — sends for one chat run in order, so a chat
 *    never shows a later snapshot above an earlier one.
 *
 * The first card of a chat is never delayed or de-duplicated away: a brand new
 * roster must become visible immediately (关键坑 12 — a debounce that only
 * ever sees new triggers would otherwise leave the roster invisible).
 *
 * Topic discipline is the caller's: the snapshot carries the coordinates of
 * the session the row belongs to, and {@link replyOptsForChat} turns them into
 * `replyTo` + `reply_in_thread` (关键坑 25/31). Ordering against the session's
 * own step cards is already handled by the channel adapter's card barrier, so
 * this module needs no barrier of its own.
 *
 * @module @starxer/chatterbox4dsh/feishu-panel
 */

import type { ConversationMessage } from './conversation.ts'

/** Minimal logger surface. */
export interface PanelLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Channel adapter for sending cards. */
export interface PanelChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
}

/** One chat's rendered roster, built at flush time from the latest state. */
export interface PanelSnapshot {
  /** The Card JSON 2.0 object to post. */
  card: object
  /**
   * Structural fingerprint of the rows (state, label, id, progress, …).
   * Elapsed times and other clock-derived text must NOT be part of it: they
   * change on their own and would defeat the de-duplication.
   */
  signature: string
  /** Coordinates of the session this roster belongs to (关键坑 25). */
  chat: ConversationMessage
}

/** Public deps for {@link createPanelSender}. */
export interface PanelDeps {
  channel: PanelChannel
  logger: PanelLogger
  /**
   * Render one chat's current snapshot. Called at flush time, not at trigger
   * time, so a coalesced burst renders once with every row it produced.
   * `undefined` means "nothing to show" and sends nothing.
   */
  build: (key: string) => PanelSnapshot | undefined
  /**
   * Coalescing window for triggers that arrive in the same burst. Test seam;
   * production callers omit it and get {@link PANEL_DEBOUNCE_MS}.
   */
  debounceMs?: number
  /**
   * Minimum spacing between two NON-urgent snapshots of one chat. Test seam;
   * production callers omit it and get {@link PANEL_REFRESH_MS}.
   */
  refreshMs?: number
}

/** Handle returned by {@link createPanelSender}. */
export interface PanelSender {
  /**
   * A trigger fired for this chat.
   *
   * @param key - roster key (see `conversationKey`).
   * @param urgent - the roster itself changed (row added, state changed, row
   *   settled). Non-urgent means only rendered detail changed (a progress
   *   line), which is throttled by the refresh floor.
   */
  refresh(key: string, urgent: boolean): void
  /** Drop every pending timer. In-flight sends are left to settle. */
  dispose(): void
}

/** Coalescing window for a burst of triggers. */
const PANEL_DEBOUNCE_MS = 300

/** Minimum spacing between two non-urgent snapshots of one chat. */
const PANEL_REFRESH_MS = 30_000

/**
 * How many rows one panel card lists. Older rows are dropped from the ROSTER
 * (not from the chat: the cards already posted stay), so a long-lived chat
 * cannot grow the table — or this process's memory — without bound.
 */
export const PANEL_MAX_ROWS = 8

/**
 * How long a settled row stays in the roster. A background task's outcome is
 * delivered by the card posted at settlement; keeping the row longer only
 * makes later cards longer.
 */
export const PANEL_ROW_TTL_MS = 30 * 60_000

/** One chat's send bookkeeping. */
interface ChatSendState {
  /** Pending flush timer. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** Absolute epoch ms {@link timer} fires at; used to keep the earliest one. */
  timerDeadline: number
  /** Serializes this chat's sends so cards can never appear out of order. */
  chain: Promise<void>
  /** Fingerprint of the last snapshot that was actually DELIVERED. */
  sentSignature: string | undefined
  /** Successful sends so far; `0` means the next flush is the first card. */
  sentCount: number
  /** Epoch ms of the last successful send, for the non-urgent refresh floor. */
  lastSentAt: number
}

/**
 * Topic reply options for a chat. A topic card must target the topic ROOT
 * message id with `reply_in_thread`; without the root it would land as a new
 * top-level message in the chat (关键坑 25).
 *
 * @param chat - coordinates captured from the session that owns the row.
 * @returns the send options for {@link PanelChannel.send}.
 */
export function replyOptsForChat(chat: ConversationMessage): { replyInThread?: boolean; replyTo?: string } {
  return chat.threadId !== undefined
    ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
    : {}
}

/**
 * Collapse a multi-line producer string into one table-safe cell.
 *
 * @param value - raw producer text.
 * @param options - `code` wraps the cell in an inline code span; `max` caps the
 *   rendered length (one ellipsis character replaces the overflow).
 * @returns the cell text.
 */
export function tableCell(value: string, options: { code?: boolean; max?: number } = {}): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  const max = options.max
  const capped = max !== undefined && collapsed.length > max
    ? `${collapsed.slice(0, Math.max(1, max - 1))}…`
    : collapsed
  if (options.code !== true) {
    // Outside a code span a backslash escape is the correct way to keep a pipe
    // from splitting the cell.
    return capped.replace(/\|/g, '\\|')
  }
  // Inside a code span markdown does NOT process backslash escapes, so an
  // escaped pipe would render as a literal `\|`. Swap in the fullwidth bar
  // instead: visually the same character, structurally harmless.
  const safe = capped.replace(/\|/g, '｜')
  return safe.includes('`') ? `\`\` ${safe} \`\`` : `\`${safe}\``
}

/**
 * Render a markdown table.
 *
 * @param headers - column titles, already localized.
 * @param rows - cells per row; every row must have the same length as `headers`.
 * @returns the table text, including its separator line.
 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ]
  return lines.join('\n')
}

/**
 * Compact duration: `820ms`, `4.3s`, `2m 05s`.
 *
 * @param ms - elapsed milliseconds; a non-finite or negative value renders `—`.
 * @returns the display string.
 */
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
 * Create the send-only snapshot sender shared by both panels.
 *
 * @param deps - channel, logger, renderer, and the optional timing seams.
 * @returns the sender handle.
 */
export function createPanelSender(deps: PanelDeps): PanelSender {
  const { channel, logger, build } = deps
  const debounceMs = deps.debounceMs ?? PANEL_DEBOUNCE_MS
  const refreshMs = deps.refreshMs ?? PANEL_REFRESH_MS
  const states = new Map<string, ChatSendState>()
  let disposed = false

  const stateOf = (key: string): ChatSendState => {
    let state = states.get(key)
    if (state === undefined) {
      state = {
        timer: undefined,
        timerDeadline: 0,
        chain: Promise.resolve(),
        sentSignature: undefined,
        sentCount: 0,
        lastSentAt: 0,
      }
      states.set(key, state)
    }
    return state
  }

  /** Send this chat's current snapshot. Never rejects; the chain depends on that. */
  const flush = async (key: string, state: ChatSendState): Promise<void> => {
    if (disposed) return
    let snapshot: PanelSnapshot | undefined
    try {
      snapshot = build(key)
    } catch (error: unknown) {
      logger.warn(`dsh-feishu: panel snapshot build failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (snapshot === undefined) return
    if (snapshot.signature === state.sentSignature) return
    try {
      await channel.send(snapshot.chat.chatId, { card: snapshot.card }, replyOptsForChat(snapshot.chat))
      state.sentSignature = snapshot.signature
      state.sentCount += 1
      state.lastSentAt = Date.now()
    } catch (error: unknown) {
      // Leave `sentSignature` untouched so the next trigger retries the send.
      // The card is best-effort: a failing chat must never take the panel down.
      logger.warn(`dsh-feishu: panel card send failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const refresh = (key: string, urgent: boolean): void => {
    if (disposed) return
    const state = stateOf(key)
    const now = Date.now()
    const delay = urgent || state.sentCount === 0
      ? 0
      : Math.max(debounceMs, refreshMs - (now - state.lastSentAt))
    const deadline = now + delay
    if (state.timer !== undefined) {
      // Keep the EARLIEST pending flush: pushing it back on every trigger is
      // exactly the resetting debounce that once left a chatty job invisible
      // until it went quiet (关键坑 12).
      if (state.timerDeadline <= deadline) return
      clearTimeout(state.timer)
    }
    state.timerDeadline = deadline
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.chain = state.chain.then(() => flush(key, state))
    }, delay)
  }

  return {
    refresh,
    dispose: () => {
      disposed = true
      for (const state of states.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
        state.timer = undefined
      }
      states.clear()
    },
  }
}
