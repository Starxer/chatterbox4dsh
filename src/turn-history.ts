/**
 * Turn history for `/fork`: reduce one session's event log to the COMPLETED
 * turns, each with the seq a fork should cut at and a one-line preview of what
 * the turn began with.
 *
 * Pure and event-shaped only, so the host's event log can be fed straight in
 * (live session window or a cold-persistence read) and the rules stay testable
 * without a running DSH.
 *
 * @module @starxer/chatterbox4dsh/turn-history
 */

/** Structural view of one session event (only the fields this module reads). */
export interface TurnEventLike {
  readonly seq: number
  readonly type: string
  readonly data?: unknown
}

/** One completed turn, reduced to what a fork list needs. */
export interface CompletedTurn {
  /** Turn number as the host numbers turns (`turn/start` → `data.turn`). */
  readonly turn: number
  /** Inclusive seq of the turn's `turn/end`: forking here keeps this turn. */
  readonly endSeq: number
  /** First visible text of the turn, one line, truncated for a card row. */
  readonly preview: string
}

/** Longest preview a card row shows (the full text is not kept). */
export const TURN_PREVIEW_MAX = 80

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Text of one message `content` value: a string, or text parts of a list. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const part of value) {
    const record = recordOf(part)
    if (record === undefined) continue
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join(' ')
}

/** Text of a `user/message` event (the event data IS the message). */
function userText(data: unknown): string {
  const record = recordOf(data)
  if (record === undefined) return ''
  if (typeof record.text === 'string' && record.text.trim() !== '') return record.text
  return contentText(record.content)
}

/** Text of an `assistant/message` event (`data.message` holds the message). */
function assistantText(data: unknown): string {
  const message = recordOf(recordOf(data)?.message)
  return message === undefined ? '' : contentText(message.content)
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** The turn number carried by a `turn/start` / `turn/end` event. */
function turnOf(data: unknown): number | undefined {
  const turn = recordOf(data)?.turn
  return typeof turn === 'number' && Number.isInteger(turn) && turn >= 1 ? turn : undefined
}

/**
 * Extract the completed turns of a (bounded) event window, oldest first.
 *
 * A turn counts only when its `turn/end` is inside `events`; the trailing
 * in-progress turn is deliberately absent so `/fork` can never cut mid-turn.
 * The preview prefers the turn's first user text and falls back to its first
 * assistant text (a turn resumed from a queue can open without a user message).
 *
 * @param events - a contiguous event window, typically the tail of the log.
 * @param options - `limit` (default 12) keeps the newest N turns; `previewMax`
 *   caps the preview length.
 * @returns the completed turns, newest last.
 */
export function collectCompletedTurns(
  events: readonly TurnEventLike[],
  options: { limit?: number; previewMax?: number } = {},
): CompletedTurn[] {
  const limit = Math.max(1, options.limit ?? 12)
  const previewMax = Math.max(8, options.previewMax ?? TURN_PREVIEW_MAX)
  const turns: CompletedTurn[] = []
  let open: { turn: number; preview: string; fallback: string } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      const turn = turnOf(event.data)
      open = turn === undefined ? undefined : { turn, preview: '', fallback: '' }
      continue
    }
    if (open === undefined) continue
    if (open.preview === '' && event.type === 'user/message') {
      const text = collapse(userText(event.data))
      if (text !== '') open.preview = text
    }
    if (open.fallback === '' && event.type === 'assistant/message') {
      const text = collapse(assistantText(event.data))
      if (text !== '') open.fallback = text
    }
    if (event.type !== 'turn/end') continue
    if (turnOf(event.data) !== open.turn) continue
    turns.push({
      turn: open.turn,
      endSeq: event.seq,
      preview: truncate(open.preview !== '' ? open.preview : open.fallback, previewMax),
    })
    open = undefined
  }
  return turns.slice(-limit)
}
