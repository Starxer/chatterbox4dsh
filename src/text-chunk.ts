/**
 * Split long text into card-sized chunks. Feishu interactive cards truncate
 * content that overflows, so callers partition the model output into multiple
 * cards when it exceeds a per-card length budget.
 *
 * The splitter is **block aware**: a card boundary may only ever fall on a
 * blank line between two blocks, never inside one. When the next block would
 * not fit in the remaining budget, the current chunk is closed *early* — at
 * the previous boundary — instead of letting that block straddle two cards.
 * This is what keeps tables, fenced code blocks, lists and block quotes
 * renderable on every card.
 *
 * A block that alone exceeds the budget still has to be split; each kind gets
 * the least destructive split available:
 *   - fenced code: close the fence at the end of a part and re-open it on the
 *     next one, so both parts stay valid code blocks;
 *   - table: repeat the header and separator rows on every part, so both parts
 *     stay valid tables;
 *   - anything else (long list, block quote, paragraph): fall back to line
 *     boundaries, and to a character boundary for a single over-long line,
 *     which is the only case where no structural boundary exists at all.
 *
 * Content is preserved across chunks (no dropped characters); only a cap on
 * the number of chunks can collapse the tail into a "... (continued)" marker.
 *
 * @module @starxer/chatterbox4dsh/text-chunk
 */

/** One unit that must not be split across cards whenever it can fit at all. */
interface Block {
  readonly text: string
  readonly kind: 'fence' | 'table' | 'other'
}

/** A line that opens a fenced code block (CommonMark: up to 3 leading spaces). */
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/

/** A line that closes a fenced code block (nothing but the fence marker). */
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/

/** The `|---|---|` separator row that turns the previous line into a table header. */
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/

/** True when the first two lines form a markdown table header + separator. */
function isTable(lines: readonly string[]): boolean {
  const head = lines[0]
  const separator = lines[1]
  if (head === undefined || separator === undefined) return false
  return head.includes('|') && separator.includes('-') && TABLE_SEPARATOR.test(separator)
}

/**
 * Partition markdown into blocks separated by blank lines, keeping a fenced
 * code block together even when it contains blank lines of its own.
 */
function segmentBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let buffer: string[] = []
  let fence: string | undefined
  let startsFence = false

  const flush = (): void => {
    if (buffer.length === 0) return
    const body = buffer.join('\n')
    if (body.trim() !== '') {
      const closed = FENCE_CLOSE.test(buffer[buffer.length - 1] ?? '')
      const kind: Block['kind'] = startsFence && closed ? 'fence' : isTable(buffer) ? 'table' : 'other'
      blocks.push({ text: body, kind })
    }
    buffer = []
    startsFence = false
  }

  for (const line of text.split('\n')) {
    if (fence === undefined) {
      if (line.trim() === '') {
        flush()
        continue
      }
      if (buffer.length === 0) {
        const open = FENCE_OPEN.exec(line)
        if (open !== null) {
          fence = open[1]!
          startsFence = true
        }
      }
      buffer.push(line)
      continue
    }
    buffer.push(line)
    if (FENCE_CLOSE.test(line)) {
      const marker = FENCE_OPEN.exec(line)![1]!
      if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
    }
  }
  flush()
  return blocks
}

/** Pack whole lines into groups of at most `budget` characters each. */
function packLines(lines: readonly string[], budget: number): string[] {
  const groups: string[] = []
  let buffer: string[] = []
  let length = 0

  const flush = (): void => {
    if (buffer.length === 0) return
    groups.push(buffer.join('\n'))
    buffer = []
    length = 0
  }

  for (const line of lines) {
    if (length + line.length + 1 > budget && buffer.length > 0) flush()
    buffer.push(line)
    length += line.length + 1
  }
  flush()
  return groups
}

/**
 * Split an over-long run of lines at line boundaries. A single line longer than
 * the budget has no structural boundary to use, so it is cut by characters.
 */
function splitLines(text: string, maxLen: number): string[] {
  const parts: string[] = []
  let buffer: string[] = []
  let length = 0

  const flush = (): void => {
    if (buffer.length === 0) return
    parts.push(buffer.join('\n'))
    buffer = []
    length = 0
  }

  for (const line of text.split('\n')) {
    if (line.length > maxLen) {
      flush()
      for (let offset = 0; offset < line.length; offset += maxLen) {
        parts.push(line.slice(offset, offset + maxLen))
      }
      continue
    }
    if (length + line.length + 1 > maxLen && buffer.length > 0) flush()
    buffer.push(line)
    length += line.length + 1
  }
  flush()
  return parts.length > 0 ? parts : [text]
}

/** Split a fenced code block, re-opening and closing the fence on every part. */
function splitFence(text: string, maxLen: number): string[] {
  const lines = text.split('\n')
  const open = lines[0]!
  const closed = FENCE_CLOSE.test(lines[lines.length - 1] ?? '')
  const inner = closed ? lines.slice(1, -1) : lines.slice(1)
  const close = closed ? lines[lines.length - 1]! : open
  const budget = Math.max(1, maxLen - open.length - close.length - 2)
  const parts = packLines(inner, budget).map(group => `${open}\n${group}\n${close}`)
  return parts.length > 0 ? parts : [text]
}

/** Split a table, repeating its header and separator rows on every part. */
function splitTable(text: string, maxLen: number): string[] {
  const lines = text.split('\n')
  const header = lines.slice(0, 2)
  if (header.length < 2) return [text]
  const budget = Math.max(1, maxLen - header.join('\n').length - 1)
  const parts = packLines(lines.slice(2), budget).map(group => [...header, group].join('\n'))
  return parts.length > 0 ? parts : [text]
}

/** Split one block that cannot fit in a card on its own. */
function splitOversized(block: Block, maxLen: number): string[] {
  if (block.kind === 'fence') return splitFence(block.text, maxLen)
  if (block.kind === 'table') return splitTable(block.text, maxLen)
  return splitLines(block.text, maxLen)
}

/**
 * Split `text` into up to `maxChunks` chunks each `contentLength` <= `maxLen`.
 * Returns `[]` for empty/whitespace text.
 *
 * Boundaries only ever fall between blocks (blank lines). A block longer than
 * `maxLen` on its own becomes one or more structurally valid chunks — see the
 * module comment for the per-kind strategy.
 *
 * @param text      The content to partition (already trimmed).
 * @param maxLen    Maximum characters per chunk (soft — see the module comment
 *                  for the single oversized block case).
 * @param maxChunks Hard cap on chunks; overflow collapses into a final
 *                  "... (continued)" marker so total cards stay bounded.
 */
export function chunkText(text: string, maxLen: number, maxChunks = 30): string[] {
  if (text.trim() === '') return []
  const blocks = segmentBlocks(text)
  if (blocks.length === 0) return [text]

  const chunks: string[] = []
  let current: string[] = []
  let currentLen = 0

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push(current.join('\n\n'))
    current = []
    currentLen = 0
  }

  for (const block of blocks) {
    if (block.text.length > maxLen) {
      // Close the current chunk early so the oversized block starts a fresh
      // card instead of being cut in half at the budget line.
      flush()
      chunks.push(...splitOversized(block, maxLen))
      continue
    }
    const blockLen = block.text.length + 2 // `\n\n` joiner
    if (currentLen + blockLen > maxLen) flush()
    current.push(block.text)
    currentLen += blockLen
  }
  flush()

  // Collapse overflow so the number of cards stays bounded.
  if (chunks.length > maxChunks) {
    const kept = chunks.slice(0, maxChunks)
    const overflowChars = chunks.slice(maxChunks).reduce((n, c) => n + c.length, 0)
    kept.push(`... (continued, ${overflowChars} more chars)`)
    return kept
  }
  return chunks
}

/**
 * Apply a hard per-card cap to a chunked list: truncate any chunk longer than
 * `maxLen` with an ellipsis (used when a single unbreakable token exceeds the
 * budget).
 */
export function capChunks(chunks: string[], maxLen: number): string[] {
  return chunks.map(c => (c.length > maxLen ? c.slice(0, maxLen) + '…' : c))
}

/**
 * Index of the earliest inline construct left OPEN at the end of `text`, or
 * `undefined` when every inline code span and every `**` pair closes.
 *
 * Feishu renders an unpaired marker literally, so a card row that was cut
 * inside `**加粗…` shows the two asterisks to the reader. Escaped characters are
 * skipped and a run of three or more asterisks is left alone (it is not a
 * strong-emphasis pair); a run of N backticks only counts while it is the run
 * that opened the current code span.
 */
function danglingInlineStart(text: string): number | undefined {
  let strong = -1
  let code = -1
  let ticks = 0
  let cursor = 0
  while (cursor < text.length) {
    const character = text[cursor]!
    if (character === '\\') {
      cursor += 2
      continue
    }
    if (character === '`') {
      let end = cursor + 1
      while (end < text.length && text[end] === '`') end += 1
      const run = end - cursor
      if (ticks === 0) {
        ticks = run
        code = cursor
      } else if (run === ticks) {
        ticks = 0
        code = -1
      }
      cursor = end
      continue
    }
    if (ticks === 0 && character === '*') {
      let end = cursor + 1
      while (end < text.length && text[end] === '*') end += 1
      if (end - cursor === 2) strong = strong === -1 ? cursor : -1
      cursor = end
      continue
    }
    cursor += 1
  }
  const open = [strong, code].filter(index => index >= 0)
  return open.length === 0 ? undefined : Math.min(...open)
}

/**
 * Cut `text` to at most `maxLen` characters without leaving an inline construct
 * open, then append `ellipsis`.
 *
 * A plain `slice` is what puts a literal `**` on a card: `condenseStepNote` and
 * the other one-line previews cut model prose at a fixed width, and when the
 * cut lands inside `**重要：…**` the reader sees the asterisks instead of bold
 * (2026-10-10). The dangling opener is dropped rather than auto-closed: closing
 * it would bold text the author may not have finished, and a dropped `**`
 * changes nothing the reader can see beyond losing that emphasis.
 *
 * @param text - source text (one line is the expected use; newlines are kept).
 * @param maxLen - maximum characters to keep, before the ellipsis.
 * @param ellipsis - suffix appended when something was dropped.
 * @returns the original text when it fits, otherwise a balanced prefix.
 */
export function truncateInline(text: string, maxLen: number, ellipsis = '…'): string {
  if (maxLen <= 0) return ellipsis
  if (text.length <= maxLen) return text
  const head = text.slice(0, maxLen)
  const open = danglingInlineStart(head)
  const kept = (open === undefined ? head : head.slice(0, open)).replace(/[*`]+$/u, '').trimEnd()
  return `${kept}${ellipsis}`
}

/** Default per-card character budget for Feishu markdown content. */
export const CARD_TEXT_MAX = 4000
