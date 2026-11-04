/**
 * Inline Markdown → Feishu docx text elements.
 *
 * `feishu_doc_blocks` with `action: "update"` replaces a block's text elements
 * wholesale, so passing plain text there used to reset every bold word, inline
 * code span and link on the block to plain text. This module lets the same call
 * carry the inline Markdown the model already writes, mapping it onto the
 * styles the docx API accepts:
 * `bold`, `italic`, `strikethrough`, `inline_code` and `link`.
 *
 * Deliberately limited to styles Feishu's `text_element_style` actually has
 * (verified against the SDK: there is no `superscript` / `subscript` field, so
 * `H~2~O` and `10^5^` stay literal — a platform limit, not a parser gap).
 * Block-level Markdown (headings, lists, tables) is not handled here: use
 * `feishu_doc_write` for those.
 *
 * @module @starxer/chatterbox4dsh/inline-markdown
 */

/** Styles a run can carry, in the plugin's own vocabulary. */
export interface InlineStyle {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  inlineCode?: boolean
  /** Absolute or scheme-ful URL the run links to. */
  link?: string
  /** LaTeX of an inline equation; such a run carries no text. */
  equation?: string
}

/** One contiguous piece of text sharing a style. */
export interface InlineRun {
  text: string
  style: InlineStyle
}

/** The `text_run` object shape the docx API takes. */
export interface DocxTextElement {
  text_run: {
    content: string
    text_element_style?: {
      bold?: boolean
      italic?: boolean
      strikethrough?: boolean
      inline_code?: boolean
      link?: { url: string }
    }
  }
}

const TWO_CHAR_MARKERS: Array<{ token: string; key: 'bold' | 'strikethrough' }> = [
  { token: '**', key: 'bold' },
  { token: '__', key: 'bold' },
  { token: '~~', key: 'strikethrough' },
]

/** Word characters, used to keep `snake_case` from turning italic. */
function isWordChar(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value)
}

function styleSignature(style: InlineStyle): string {
  return JSON.stringify([
    style.bold === true,
    style.italic === true,
    style.strikethrough === true,
    style.inlineCode === true,
    style.link ?? '',
    style.equation ?? '',
  ])
}

/** Merge adjacent runs that ended up with the same style. */
function merge(runs: InlineRun[]): InlineRun[] {
  const out: InlineRun[] = []
  for (const run of runs) {
    // An equation run carries no text; never merge it away.
    if (run.style.equation !== undefined) {
      out.push({ text: '', style: { ...run.style } })
      continue
    }
    if (run.text === '') continue
    const previous = out[out.length - 1]
    if (previous !== undefined && previous.style.equation === undefined
      && styleSignature(previous.style) === styleSignature(run.style)) {
      previous.text += run.text
      continue
    }
    out.push({ text: run.text, style: { ...run.style } })
  }
  return out
}

/** Find the closing marker, ignoring escaped characters. */
function findClose(text: string, from: number, token: string): number {
  let index = from
  while (index <= text.length - token.length) {
    // Match before treating a backslash as an escape: `\)` and `\$` are
    // themselves closing tokens.
    if (text.startsWith(token, index)) return index
    if (text[index] === '\\') {
      index += 2
      continue
    }
    index += 1
  }
  return -1
}

function parseSegment(text: string, inherited: InlineStyle): InlineRun[] {
  const runs: InlineRun[] = []
  let buffer = ''
  let index = 0

  const flush = (): void => {
    if (buffer === '') return
    runs.push({ text: buffer, style: inherited })
    buffer = ''
  }

  while (index < text.length) {
    const char = text[index] as string

    // Inline code spans do not nest: everything inside is literal.
    if (char === '`') {
      const close = findClose(text, index + 1, '`')
      if (close > index + 1) {
        flush()
        runs.push({ text: text.slice(index + 1, close), style: { ...inherited, inlineCode: true } })
        index = close + 1
        continue
      }
    }

    // `$…$` / `\(…\)`: an inline Feishu equation. Same conservative rules as
    // the document writer: no escaped opener, no whitespace at either edge, and
    // a digit-only body is treated as currency, not math.
    if (char === '$' || (char === '\\' && text[index + 1] === '(')) {
      const openLength = char === '$' ? 1 : 2
      const closeToken = char === '$' ? '$' : '\\)'
      const bodyStart = index + openLength
      const first = text[bodyStart]
      if (first !== undefined && !/\s/u.test(first)) {
        const close = findClose(text, bodyStart + 1, closeToken)
        if (close > bodyStart) {
          const latex = text.slice(bodyStart, close).trim()
          const previous = text[close - 1]
          const tight = previous !== undefined && !/\s/u.test(previous)
          const currency = /^\d[\d.,]*$/u.test(latex)
          if (tight && latex !== '' && !currency) {
            flush()
            runs.push({ text: '', style: { ...inherited, equation: latex } })
            index = close + closeToken.length
            continue
          }
        }
      }
    }

    // Backslash escapes any next character (CommonMark's punctuation escapes).
    if (char === '\\' && index + 1 < text.length) {
      buffer += text[index + 1] as string
      index += 2
      continue
    }

    // `[label](url)` — the label keeps its own inline formatting.
    if (char === '[') {
      const match = /^\[([^\]\n]+)\]\(([^)\s]+)\)/u.exec(text.slice(index))
      if (match !== null && match[1] !== undefined && match[2] !== undefined) {
        flush()
        runs.push(...parseSegment(match[1], { ...inherited, link: match[2] }))
        index += match[0].length
        continue
      }
    }

    // Two-character emphasis markers first, so `**` never parses as `*`.
    let matched = false
    for (const marker of TWO_CHAR_MARKERS) {
      if (!text.startsWith(marker.token, index)) continue
      if (inherited[marker.key] === true) continue
      const close = findClose(text, index + marker.token.length, marker.token)
      if (close <= index + marker.token.length) continue
      flush()
      runs.push(...parseSegment(text.slice(index + marker.token.length, close), { ...inherited, [marker.key]: true }))
      index = close + marker.token.length
      matched = true
      break
    }
    if (matched) continue

    // Single-character emphasis: `*italic*` and `_italic_`. A `_` inside a word
    // (`snake_case_name`) is left alone, matching CommonMark's intraword rule.
    if (char === '*' || char === '_') {
      const intraword = char === '_' && isWordChar(text[index - 1]) && isWordChar(text[index + 1])
      if (!intraword && inherited.italic !== true) {
        const close = findClose(text, index + 1, char)
        const closesWord = close > 0 && char === '_' && isWordChar(text[close + 1])
        if (close > index + 1 && !closesWord) {
          flush()
          runs.push(...parseSegment(text.slice(index + 1, close), { ...inherited, italic: true }))
          index = close + 1
          continue
        }
      }
    }

    buffer += char
    index += 1
  }

  flush()
  return runs
}

/**
 * Parse inline Markdown into styled runs.
 *
 * Unterminated markers are left as literal text; adjacent runs with identical
 * styles are merged so a block with one bold word still produces three runs at
 * most (`before`, `bold`, `after`).
 */
export function parseInlineMarkdown(text: string): InlineRun[] {
  return merge(parseSegment(text, {}))
}

function toElementStyle(style: InlineStyle): DocxTextElement['text_run']['text_element_style'] | undefined {
  const out: NonNullable<DocxTextElement['text_run']['text_element_style']> = {}
  if (style.bold === true) out.bold = true
  if (style.italic === true) out.italic = true
  if (style.strikethrough === true) out.strikethrough = true
  if (style.inlineCode === true) out.inline_code = true
  if (style.link !== undefined) out.link = { url: style.link }
  return Object.keys(out).length === 0 ? undefined : out
}

/** Convert inline Markdown into the `elements` array `documentBlock.patch` accepts. */
export function textElementsFromMarkdown(text: string): Array<DocxTextElement | { equation: { content: string } }> {
  return parseInlineMarkdown(text).map(run => {
    if (run.style.equation !== undefined) return { equation: { content: run.style.equation } }
    const text_element_style = toElementStyle(run.style)
    return { text_run: { content: run.text, ...(text_element_style === undefined ? {} : { text_element_style }) } }
  })
}
