/**
 * Repair a `**strong**` span whose closing marker Feishu's renderer refuses.
 *
 * Measured on this deployment 2026-10-10 with two numbered probe cards (each
 * line its own `markdown` element; a second card held all lines in one element
 * plus a table cell). Feishu renders the markers LITERALLY when a closing `**`
 * sits between trailing punctuation and a following word:
 *
 * | source                        | rendered        |
 * |-------------------------------|-----------------|
 * | `**加粗。**后面`              | literal `**` ✗  |
 * | `**加粗：**后面`              | literal `**` ✗  |
 * | `**带括号（说明）**后面`      | literal `**` ✗  |
 * | `**加粗…**后面`               | literal `**` ✗  |
 * | `**加粗**。后面`              | bold ✓          |
 * | `**加粗**：后面`              | bold ✓          |
 * | `**加粗**，后面`              | bold ✓          |
 * | `前缀**加粗**后缀`            | bold ✓          |
 *
 * So the author's punctuation must move OUTSIDE the emphasis — the visible text
 * is unchanged, only the bold extent changes by one punctuation mark. This is
 * CommonMark's delimiter-run rule (a closing delimiter may not be followed by a
 * word when it is preceded by punctuation), and the same repair is what a
 * downstream Lark integration arrived at independently
 * (loopx-project/loopx#5352). Our own model output carried that shape in
 * 66 of 8 998 assistant texts (0.7%).
 *
 * Deliberately NOT a Markdown parser: fenced code, inline code spans, escaped
 * characters, link destinations and `***` runs stay opaque, because guessing
 * their meaning is how a formatter starts corrupting code samples. Unmatched
 * markers are left alone too — an unterminated `**` is the author's (or a
 * truncation's) problem, not this pass's.
 *
 * @module @starxer/chatterbox4dsh/card-emphasis
 */

/** A line that opens or closes a fenced code block (up to 3 spaces of indent). */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/

/** Punctuation or a symbol — the code points CommonMark calls `P…` / `S…`. */
const PUNCTUATION = /[\p{P}\p{S}]/u

/** A letter or a digit: Python's `str.isalnum()`, which CJK satisfies. */
const WORD = /[\p{L}\p{N}]/u

/** Markers that stay opaque even when they are punctuation. */
const OPAQUE_PUNCTUATION = '`*_\\'

/** One replacement: `[start, end)` of the source line becomes `replacement`. */
interface EmphasisEdit {
  start: number
  end: number
  replacement: string
}

/**
 * Move the trailing punctuation of one `**…punct**word` span outside it.
 * @param line - one source line (may include its newline, which never matches).
 * @returns the line with every repairable span rewritten.
 */
function repairStrongLine(line: string): string {
  const edits: EmphasisEdit[] = []
  let opening: number | undefined
  let ticks = 0
  let opaqueEnd = 0
  let cursor = 0

  while (cursor < line.length) {
    const character = line[cursor]!
    if (character === '\\' && ticks === 0) {
      cursor += 2
      continue
    }
    if (character === '`') {
      let end = cursor + 1
      while (end < line.length && line[end] === '`') end += 1
      const run = end - cursor
      if (ticks === 0) ticks = run
      else if (run === ticks) {
        ticks = 0
        opaqueEnd = end
      }
      cursor = end
      continue
    }
    // A link destination is opaque; emphasis inside a link LABEL is not.
    if (ticks === 0 && line.startsWith('](', cursor)) {
      let depth = 1
      cursor += 2
      while (cursor < line.length && depth > 0) {
        if (line[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (line[cursor] === '(') depth += 1
        else if (line[cursor] === ')') depth -= 1
        cursor += 1
      }
      opaqueEnd = cursor
      continue
    }
    if (ticks !== 0 || character !== '*') {
      cursor += 1
      continue
    }
    let end = cursor + 1
    while (end < line.length && line[end] === '*') end += 1
    // Only a run of exactly two is a strong delimiter; `***` stays untouched.
    if (end - cursor !== 2) {
      cursor = end
      continue
    }
    if (opening === undefined) {
      // An opener must be followed by content; `** word**` is not emphasis.
      if (end < line.length && !/\s/u.test(line[end]!)) opening = end
    } else if (cursor > opening && !/\s/u.test(line[cursor - 1]!)) {
      let suffix = cursor
      while (
        suffix > Math.max(opening, opaqueEnd)
        && PUNCTUATION.test(line[suffix - 1]!)
        && !OPAQUE_PUNCTUATION.includes(line[suffix - 1]!)
      ) suffix -= 1
      if (
        suffix < cursor
        && suffix > opening
        && !/\s/u.test(line[suffix - 1]!)
        && end < line.length
        && WORD.test(line[end]!)
      ) {
        edits.push({ start: suffix, end, replacement: `**${line.slice(suffix, cursor)}` })
      }
      opening = undefined
    }
    cursor = end
  }

  if (edits.length === 0) return line
  let result = ''
  let last = 0
  for (const edit of edits) {
    result += line.slice(last, edit.start) + edit.replacement
    last = edit.end
  }
  return result + line.slice(last)
}

/**
 * Repair every `**…punct**word` span in card markdown, outside fenced code.
 *
 * Idempotent: the repair moves the punctuation out of the emphasis, so the
 * closing marker is no longer preceded by punctuation and a second pass finds
 * nothing. Pure — the caller decides where the result goes.
 *
 * @param text - card markdown source.
 * @returns the same text with repairable strong spans normalized.
 */
export function normalizeCardEmphasis(text: string): string {
  if (!text.includes('**') || text === '') return text
  const lines = text.split(/(?<=\n)/u)
  let fence: { character: string; length: number } | undefined
  for (const [index, line] of lines.entries()) {
    const marker = FENCE_PATTERN.exec(line)
    if (fence !== undefined) {
      // Inside a fence only the matching closer ends it, and it must end the line.
      if (marker !== null && marker[1]![0] === fence.character && marker[1]!.length >= fence.length
        && line.slice(marker[0].length).trim() === '') {
        fence = undefined
      }
      continue
    }
    if (marker !== null) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length }
      continue
    }
    lines[index] = repairStrongLine(line)
  }
  return lines.join('')
}
