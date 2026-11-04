/**
 * LaTeX formulas in Markdown → Feishu docx equation text elements.
 *
 * Feishu's Markdown→blocks converter (`docx.v1.document.convert`) does not
 * understand formulas: it silently drops `$…$` / `$$…$$` (leaving an empty
 * paragraph) and eats the backslashes of `\[…\]`. The docx API itself DOES
 * support formulas — as an inline text element (`{ equation: { content } }`)
 * inside any text-like block — so the tools pre-process the Markdown before
 * conversion and splice the equations back into the converted blocks:
 *
 * - `$…$` and `\(…\)` → an inline equation inside the surrounding paragraph.
 * - `$$…$$` / `\[…\]` on their own line(s) → a paragraph whose only element is
 *   the equation, centred, which reads as a display formula.
 * - Inside fenced code blocks and inline code spans nothing is touched, so a
 *   document about LaTeX keeps its examples literal.
 *
 * The converter is fed placeholder tokens (`DSHMFI0ZQ`, `DSHMFB0ZQ`) instead of
 * the formulas, and the tokens are swapped for equations before the blocks are
 * inserted. Any token that somehow survives is reported so the caller can log
 * it — a formula must never disappear silently again.
 *
 * @module @starxer/chatterbox4dsh/doc-formula
 */

/** Longest formula (in characters) accepted for either form. */
export const MAX_FORMULA_CHARS = 4000

/** Inline formula placeholder prefix (`DSHMFI<n>ZQ`). */
export const INLINE_TOKEN_PREFIX = 'DSHMFI'
/** Display/block formula placeholder prefix (`DSHMFB<n>ZQ`). */
export const BLOCK_TOKEN_PREFIX = 'DSHMFB'
const TOKEN_SUFFIX = 'ZQ'
const TOKEN_PATTERN = /(DSHMF[IB]\d+ZQ)/gu

/** Markdown rewritten with placeholders, plus the token → LaTeX maps. */
export interface FormulaPlaceholders {
  markdown: string
  inline: Map<string, string>
  block: Map<string, string>
}

/** Result of splicing the equations back into converted blocks. */
export interface FormulaApplication<T> {
  blocks: T[]
  /** Equations that made it into the blocks. */
  applied: number
  /** Placeholder tokens still present after the rewrite (should be empty). */
  unresolved: string[]
}

interface DisplayStart {
  close: '$$' | '\\]'
  /** Content after the opening marker on the same line. */
  rest: string
  /** Set when the whole formula sits on this one line. */
  single?: string
}

/** Recognise a display-formula opening marker at the start of a line. */
function matchDisplayStart(trimmed: string): DisplayStart | undefined {
  if (trimmed.startsWith('$$')) {
    const rest = trimmed.slice(2)
    if (rest.endsWith('$$') && !rest.slice(0, -2).includes('$$')) {
      return { close: '$$', rest: '', single: rest.slice(0, -2) }
    }
    return rest.includes('$$') ? undefined : { close: '$$', rest }
  }
  if (trimmed.startsWith('\\[')) {
    const rest = trimmed.slice(2)
    if (rest.endsWith('\\]') && !rest.slice(0, -2).includes('\\]')) {
      return { close: '\\]', rest: '', single: rest.slice(0, -2) }
    }
    return rest.includes('\\]') ? undefined : { close: '\\]', rest }
  }
  return undefined
}

/** Turn the raw lines of a display formula into one LaTeX string. */
export function normalizeDisplayLatex(raw: string): string {
  const lines = raw.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines.join(' \\\\ ').trim()
}

/** Index just past the closing marker named by `close`. */
function closeIndex(trimmed: string, close: DisplayStart['close']): number {
  return trimmed.indexOf(close)
}

/**
 * Replace `\(…\)` in one line with an inline placeholder.
 *
 * Only complete pairs are touched; an unterminated `\(` stays literal.
 */
function replaceInlineParen(line: string, make: (latex: string) => string): string {
  let out = line
  let searchFrom = 0
  for (;;) {
    const start = out.indexOf('\\(', searchFrom)
    if (start === -1) return out
    if (start > 0 && out[start - 1] === '\\') {
      searchFrom = start + 2
      continue
    }
    const end = out.indexOf('\\)', start + 2)
    if (end === -1) return out
    const latex = out.slice(start + 2, end).trim()
    if (latex === '' || latex.length > MAX_FORMULA_CHARS) {
      searchFrom = end + 2
      continue
    }
    out = `${out.slice(0, start)}${make(latex)}${out.slice(end + 2)}`
    searchFrom = start + 1
  }
}

/**
 * Convert `$…$` / `$$…$$` / `\(…\)` spans in one line.
 *
 * Inline code spans (`` `…` ``) are copied verbatim. A `$` pair is only a
 * formula when it is not escaped, its content is non-empty, and it neither
 * starts nor ends with whitespace — which keeps ordinary prose such as
 * `$5 and $10` literal (the space before the closing `$` disqualifies it).
 */
function replaceInlineDollars(line: string, make: (latex: string) => string): string {
  let out = ''
  let index = 0
  while (index < line.length) {
    const char = line[index] as string
    if (char === '\\' && (line[index + 1] === '$' || line[index + 1] === '\\')) {
      out += char + (line[index + 1] as string)
      index += 2
      continue
    }
    // Inline code span: leave it alone.
    if (char === '`') {
      let width = 1
      while (line[index + width] === '`') width += 1
      const fence = '`'.repeat(width)
      const close = line.indexOf(fence, index + width)
      if (close === -1) {
        out += line.slice(index)
        break
      }
      out += line.slice(index, close + width)
      index = close + width
      continue
    }
    if (char !== '$') {
      out += char
      index += 1
      continue
    }
    // Escaped dollar.
    if (index > 0 && line[index - 1] === '\\') {
      out += char
      index += 1
      continue
    }
    if (line[index + 1] === '$') {
      const close = line.indexOf('$$', index + 2)
      if (close !== -1) {
        const latex = normalizeDisplayLatex(line.slice(index + 2, close))
        if (latex !== '' && latex.length <= MAX_FORMULA_CHARS) {
          out += make(latex)
          index = close + 2
          continue
        }
      }
      out += char
      index += 1
      continue
    }
    const first = line[index + 1]
    if (first === undefined || /\s/u.test(first)) {
      out += char
      index += 1
      continue
    }
    let close = -1
    for (let scan = index + 2; scan < line.length; scan += 1) {
      if (line[scan] === '\\') {
        scan += 1
        continue
      }
      if (line[scan] !== '$') continue
      const previous = line[scan - 1]
      if (previous === undefined || /\s/u.test(previous)) break
      close = scan
      break
    }
    if (close === -1) {
      out += char
      index += 1
      continue
    }
    const latex = line.slice(index + 1, close).trim()
    // `$5 USD` and similar currency amounts stay literal.
    const currency = /^\d[\d.,]*$/u.test(latex)
    if (latex === '' || currency || latex.length > MAX_FORMULA_CHARS) {
      out += char
      index += 1
      continue
    }
    out += make(latex)
    index = close + 1
  }
  return out
}

/** A fenced code block opener/closer, e.g. ``` or ~~~. */
function fenceAt(trimmed: string): string | undefined {
  const match = /^(`{3,}|~{3,})/u.exec(trimmed)
  return match?.[1]
}

/**
 * Rewrite Markdown so formulas become placeholders.
 *
 * Returns the rewritten Markdown and both token maps; pass the result to
 * {@link applyFormulas} after `document.convert`.
 */
export function extractFormulas(markdown: string): FormulaPlaceholders {
  const inline = new Map<string, string>()
  const block = new Map<string, string>()
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence: string | undefined

  const makeInline = (latex: string): string => {
    const token = `${INLINE_TOKEN_PREFIX}${inline.size}${TOKEN_SUFFIX}`
    inline.set(token, latex)
    return token
  }
  const makeBlock = (latex: string): string => {
    const token = `${BLOCK_TOKEN_PREFIX}${block.size}${TOKEN_SUFFIX}`
    block.set(token, latex)
    return token
  }
  const pushBlockToken = (latex: string): void => {
    if (out.length > 0 && out[out.length - 1]?.trim() !== '') out.push('')
    out.push(makeBlock(latex))
    out.push('')
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    const trimmed = line.trim()

    if (fence !== undefined) {
      out.push(line)
      if (trimmed.startsWith(fence)) fence = undefined
      continue
    }
    const opened = fenceAt(trimmed)
    if (opened !== undefined) {
      fence = opened
      out.push(line)
      continue
    }

    const display = matchDisplayStart(trimmed)
    if (display !== undefined) {
      if (display.single !== undefined) {
        const latex = normalizeDisplayLatex(display.single)
        if (latex !== '' && latex.length <= MAX_FORMULA_CHARS) {
          pushBlockToken(latex)
          continue
        }
      } else {
        const collected = [display.rest]
        let closed = false
        let cursor = index + 1
        for (; cursor < lines.length; cursor += 1) {
          const candidate = lines[cursor] as string
          const at = closeIndex(candidate.trim(), display.close)
          if (at !== -1) {
            collected.push(candidate.trim().slice(0, at))
            closed = true
            break
          }
          collected.push(candidate)
        }
        if (closed) {
          const latex = normalizeDisplayLatex(collected.join('\n'))
          if (latex !== '' && latex.length <= MAX_FORMULA_CHARS) {
            pushBlockToken(latex)
            index = cursor
            continue
          }
        }
      }
    }

    out.push(replaceInlineDollars(replaceInlineParen(line, makeInline), makeInline))
  }

  return { markdown: out.join('\n'), inline, block }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The text elements of a block payload, or undefined when it has none. */
function elementsOf(container: unknown): unknown[] | undefined {
  if (!isRecord(container)) return undefined
  const elements = container.elements
  return Array.isArray(elements) ? elements : undefined
}

/** Copy inline formatting onto an equation element (Feishu accepts the same style). */
function equationElement(latex: string, style: unknown): Record<string, unknown> {
  return {
    equation: {
      content: latex,
      ...(isRecord(style) ? { text_element_style: style } : {}),
    },
  }
}

function splitContent(
  content: string,
  inline: Map<string, string>,
  block: Map<string, string>,
): Array<{ text?: string, latex?: string }> {
  const parts: Array<{ text?: string, latex?: string }> = []
  let last = 0
  for (const match of content.matchAll(TOKEN_PATTERN)) {
    const token = match[1] as string
    const latex = inline.get(token) ?? block.get(token)
    const start = match.index ?? 0
    if (latex === undefined) continue
    if (start > last) parts.push({ text: content.slice(last, start) })
    parts.push({ latex })
    last = start + token.length
  }
  if (last < content.length) parts.push({ text: content.slice(last) })
  return parts
}

/**
 * Splice equations into converted blocks, in place.
 *
 * A block whose whole text is a display placeholder becomes a centred
 * equation-only paragraph; inline placeholders are split out of the surrounding
 * `text_run`s. Blocks the converter produced for anything else are untouched.
 */
export function applyFormulas<T extends Record<string, unknown>>(
  blocks: T[],
  placeholders: Pick<FormulaPlaceholders, 'inline' | 'block'>,
): FormulaApplication<T> {
  const { inline, block } = placeholders
  let applied = 0

  for (const raw of blocks) {
    if (!isRecord(raw)) continue
    const record = raw as Record<string, unknown>
    for (const [key, container] of Object.entries(record)) {
      if (key === 'equation') continue
      const elements = elementsOf(container)
      if (elements === undefined) continue

      const rewritten: unknown[] = []
      for (const element of elements) {
        if (!isRecord(element)) {
          rewritten.push(element)
          continue
        }
        const run = element.text_run
        if (!isRecord(run) || typeof run.content !== 'string') {
          rewritten.push(element)
          continue
        }
        const content = run.content
        const style = run.text_element_style
        const asBlock = content.trim()
        if (block.has(asBlock) && content.trim() === asBlock) {
          rewritten.push(equationElement(block.get(asBlock) as string, style))
          applied += 1
          const styleObject = isRecord((container as { style?: unknown }).style)
            ? { ...(container as { style: Record<string, unknown> }).style }
            : {}
          styleObject.align = 2
          ;(container as { style?: unknown }).style = styleObject
          continue
        }
        const parts = splitContent(content, inline, block)
        if (parts.length === 0) {
          rewritten.push(element)
          continue
        }
        for (const part of parts) {
          if (part.latex !== undefined) {
            rewritten.push(equationElement(part.latex, style))
            applied += 1
            continue
          }
          if (part.text !== undefined && part.text !== '') {
            rewritten.push({ text_run: { ...run, content: part.text } })
          }
        }
      }
      if (rewritten.length !== elements.length || rewritten.some((element, index) => element !== elements[index])) {
        ;(container as { elements: unknown[] }).elements = rewritten
      }
    }
  }

  const serialized = JSON.stringify(blocks)
  const unresolved = [...new Set([...serialized.matchAll(TOKEN_PATTERN)].map(match => match[1] as string))]
  return { blocks, applied, unresolved }
}
