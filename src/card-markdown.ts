/**
 * Feishu card markdown can only reference an image that was UPLOADED to Feishu
 * first: the rich-text component's image syntax is `![hover_text](image_key)`,
 * and that slot takes an `img_v3_…` key from the image-upload API — not a URL
 * and not a path. Anything else makes Feishu reject the WHOLE card
 * (`200570 card contains invalid image keys`, wrapped as `230099 Failed to
 * create card content`), it does not merely drop the picture.
 *
 * Verified against the live API on 2026-09-23 (CardKit `card.create` +
 * `card.update`, no message sent):
 *
 * | payload                                        | result            |
 * |------------------------------------------------|-------------------|
 * | `![](runs/a.png)`                              | rejected (200570) |
 * | `![](https://example.com/a.png)`               | rejected (200570) |
 * | `![](img_v3_0215q_…)` (a real uploaded key)     | accepted          |
 * | `[a](runs/a.png)` (plain link, no `!`)          | accepted          |
 * | `![]()` inside a fence or a closed code span    | accepted (literal) |
 * | `` `![x](runs/a.png) `` (UNTERMINATED span)     | rejected (200570) |
 * | `> ![x](runs/a.png)` (blockquote)               | rejected (200570) |
 * | `\| ![x](runs/a.png) \|` (table cell)           | rejected (200570) |
 * | `![a](runs/a.png "title")`                      | rejected (200570) |
 *
 * That last group shapes this module: only a *closed* code span protects the
 * syntax, so a scanner that skips code must treat an unterminated span as
 * ordinary text; and tables/quotes/annotated images all need rewriting.
 *
 * Why the model writes it at all: in the DSH Web UI a workspace path is
 * meaningful — the UI resolves it and can open the file — so `![](runs/x.png)`
 * is a legitimate thing for the model to emit. There is exactly ONE model
 * output and two renderers, so the Feishu renderer adapts here instead of
 * asking the model to stop (decided 2026-09-23). A reference that cannot render
 * becomes readable text that still names the path, so the operator can see what
 * was meant and ask for the file through `feishu_send_file`.
 *
 * @module @starxer/chatterbox4dsh/card-markdown
 */

import { normalizeCardEmphasis } from './card-emphasis.ts'

/** An uploaded-image key, e.g. `img_v3_0215q_0a59b5e6-4758-41de-95a5-…`. */
const IMAGE_KEY_PATTERN = /^img_[A-Za-z0-9]+_[A-Za-z0-9_-]+$/

/** An uploaded-file key, e.g. `file_v3_00or_f2c1276b-9f24-463d-8911-…`. */
const FILE_KEY_PATTERN = /^file_[A-Za-z0-9]+_[A-Za-z0-9_-]+$/

/** A real URI scheme (`https:`, `mailto:`, `tel:`, `data:`, …). */
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/

/** A fenced code block opener: up to 3 spaces of indent, then ``` or ~~~. */
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/

/**
 * One markdown reference outside any code span. `raw` is the exact source text
 * so a caller can return it unchanged.
 */
export interface CardMarkdownReference {
  /** `true` for `![alt](target)` (Feishu parses this as an image element). */
  image: boolean
  /** Link label / image hover text (may be empty). */
  alt: string
  /** Image key, URL or path — whatever sits in the parentheses. */
  target: string
  /** The reference as written, for identity comparisons. */
  raw: string
}

/** Options for {@link neutralizeCardMarkdown}. */
export interface NeutralizeOptions {
  /**
   * Rewrite EVERY image reference, valid image key or not. Used as the
   * last-resort retry when Feishu rejected a card anyway: at that point a
   * rendered picture is worth less than a delivered card.
   */
  aggressive?: boolean
}

/** Whether a string is a key Feishu itself handed out (`img_v3_…`). */
export function isFeishuImageKey(source: string): boolean {
  return IMAGE_KEY_PATTERN.test(source.trim())
}

/** Whether a string is a file key Feishu itself handed out (`file_v3_…`). */
export function isFeishuFileKey(source: string): boolean {
  return FILE_KEY_PATTERN.test(source.trim())
}

/**
 * Whether Feishu would be able to open this link target. A workspace-relative
 * or absolute filesystem path is not a URL: Feishu renders it as a link that
 * does nothing when clicked, which is why those are downgraded too.
 */
function isOpenableTarget(target: string): boolean {
  const value = target.trim()
  if (value === '' || value.startsWith('#')) return false
  // Protocol-relative (`//host/path`) is a real URL in a browser context.
  if (value.startsWith('//')) return true
  return URI_SCHEME_PATTERN.test(value)
}

/** Wrap text in an inline code span, widening the fence if it contains one. */
function codeSpan(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
}

/** What an un-renderable image reference becomes. */
export function imageFallback(alt: string, target: string): string {
  const label = alt.trim()
  const path = target.trim()
  if (path === '') return label === '' ? '🖼' : `🖼 ${label}`
  if (label === '' || label === path) return `🖼 ${codeSpan(path)}`
  return `🖼 ${label} · ${codeSpan(path)}`
}

/** What a link Feishu cannot open becomes. */
export function linkFallback(label: string, target: string): string {
  const text = label.trim()
  const path = target.trim()
  if (path === '') return text
  if (text === '' || text === path) return codeSpan(path)
  return `${text} · ${codeSpan(path)}`
}

/**
 * `![alt](target)`, `[label](target)`, the `<target>` form and the optional
 * `"title"` suffix — all in one pass so `!` decides the kind. Tried against the
 * WHOLE line (not per code-free segment): a target that itself contains a
 * backtick (`![a](runs/a`b.png)`) is still an image element to Feishu — verified,
 * it was rejected with exactly that image key — so the reference must be matched
 * before any code-span reasoning, and the span check only decides afterwards
 * whether it is protected.
 */
const REFERENCE_SOURCE = '(!?)\\[([^\\]]*)\\]\\(\\s*(?:<([^>\\n]*)>|([^)\\s]*))(?:\\s+"[^"]*")?\\s*\\)'

/** Index of a run of exactly `run` backticks at or after `from`, else -1. */
function findClosingRun(line: string, from: number, run: number): number {
  let index = from
  while (index < line.length) {
    if (line[index] !== '`') {
      index += 1
      continue
    }
    let end = index
    while (end < line.length && line[end] === '`') end += 1
    if (end - index === run) return index
    index = end
  }
  return -1
}

/**
 * The CLOSED code spans of one line, as `[start, end)` ranges.
 *
 * A run of N backticks is only a delimiter when a later run of exactly N closes
 * it. An unterminated run therefore protects nothing — which matches Feishu: a
 * lone backtick did not stop it from rejecting the card (verified with
 * `` `![x](runs/a.png) ``, which came back as `200570`).
 */
function closedCodeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let index = 0
  while (index < line.length) {
    if (line[index] !== '`') {
      index += 1
      continue
    }
    let runEnd = index
    while (runEnd < line.length && line[runEnd] === '`') runEnd += 1
    const close = findClosingRun(line, runEnd, runEnd - index)
    if (close === -1) {
      index = runEnd
      continue
    }
    spans.push([index, close + (runEnd - index)])
    index = close + (runEnd - index)
  }
  return spans
}

/**
 * Rewrite every reference on one line whose START is not inside a closed code
 * span. Fenced blocks and closed spans keep their literal `![]()` — Feishu
 * treats them as text too, so protecting them is both correct and necessary for
 * code samples.
 */
function rewriteLine(
  line: string,
  pattern: RegExp,
  map: (reference: CardMarkdownReference) => string,
): string {
  if (!line.includes('](')) return line
  const spans = closedCodeSpans(line)
  pattern.lastIndex = 0
  let result = ''
  let last = 0
  let match = pattern.exec(line)
  while (match !== null) {
    const start = match.index
    const end = start + match[0].length
    const protectedByCode = spans.some(([spanStart, spanEnd]) => start >= spanStart && start < spanEnd)
    if (!protectedByCode) {
      const target = (match[3] ?? match[4] ?? '').trim()
      result += line.slice(last, start) + map({
        image: match[1] === '!',
        alt: match[2] ?? '',
        target,
        raw: match[0],
      })
      last = end
    }
    match = pattern.exec(line)
  }
  return last === 0 ? line : result + line.slice(last)
}

/**
 * Apply `mapLine` to every line that is NOT inside a fenced code block. Shared
 * by the reference and the audio markup passes: both must leave code samples
 * literal, and both need the same fence bookkeeping.
 */
function mapOutsideFences(text: string, mapLine: (line: string) => string): string {
  const lines = text.split('\n')
  let fenceChar: string | undefined
  let fenceLength = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const fence = FENCE_PATTERN.exec(line)
    if (fenceChar === undefined) {
      if (fence !== null) {
        fenceChar = fence[1]![0]!
        fenceLength = fence[1]!.length
        continue
      }
      lines[index] = mapLine(line)
      continue
    }
    // Inside a fence only the closing marker matters; content stays literal.
    if (fence !== null && fence[1]![0] === fenceChar && fence[1]!.length >= fenceLength) {
      fenceChar = undefined
      fenceLength = 0
    }
  }
  return lines.join('\n')
}

/**
 * Apply `map` to every markdown reference in `text` that Feishu would parse as
 * an element — i.e. everything outside a fenced code block and outside a CLOSED
 * inline code span. Fences and code spans are copied through untouched, so code
 * samples keep their literal `![]()`.
 *
 * @param text - card markdown source.
 * @param map - returns the replacement for one reference (return `raw` to keep).
 * @returns the rewritten markdown.
 */
export function mapCardMarkdownReferences(
  text: string,
  map: (reference: CardMarkdownReference) => string,
): string {
  if (text === '' || !text.includes('](')) return text
  const pattern = new RegExp(REFERENCE_SOURCE, 'g')
  return mapOutsideFences(text, line => rewriteLine(line, pattern, map))
}

/** One `<audio …></audio>` / `<audio … />` tag: the markup and its `file_key`. */
const AUDIO_SOURCE = /<audio\b[^>]*>(?:<\/audio>)?/gi
/** The `file_key` attribute of an audio tag, in either quote style. */
const AUDIO_FILE_KEY = /\bfile_key\s*=\s*(['"])([^'"]*)\1/i

/** What an audio player that cannot render becomes. */
export function audioFallback(fileKey: string, raw: string): string {
  const label = fileKey.trim() === '' ? raw : fileKey.trim()
  return `🔊 ${codeSpan(label)}`
}

/**
 * Rewrite every `<audio …>` player markup outside code. The rich-text component
 * plays OPUS only when `file_key` is a key Feishu handed out (`file_v3_…`);
 * anything else is either rejected or silently dead, so it becomes readable
 * text. Closed code spans and fences keep their literal markup.
 *
 * @param text - card markdown source.
 * @param map - returns the replacement for one tag (return `raw` to keep).
 * @returns the rewritten markdown.
 */
export function mapCardMarkdownAudio(
  text: string,
  map: (fileKey: string, raw: string) => string,
): string {
  if (text === '' || !text.includes('<audio')) return text
  const pattern = new RegExp(AUDIO_SOURCE)
  return mapOutsideFences(text, (line) => {
    if (!line.includes('<audio')) return line
    const spans = closedCodeSpans(line)
    pattern.lastIndex = 0
    let result = ''
    let last = 0
    let match = pattern.exec(line)
    while (match !== null) {
      const start = match.index
      const end = start + match[0].length
      const protectedByCode = spans.some(([spanStart, spanEnd]) => start >= spanStart && start < spanEnd)
      if (!protectedByCode) {
        const fileKey = AUDIO_FILE_KEY.exec(match[0])?.[2] ?? ''
        result += line.slice(last, start) + map(fileKey, match[0])
        last = end
      }
      match = pattern.exec(line)
    }
    return last === 0 ? line : result + line.slice(last)
  })
}

/**
 * Make card markdown safe for Feishu: every image reference that is not an
 * uploaded image key becomes text, every link Feishu cannot open keeps its
 * label but shows the path in a code span, and every `<audio>` player whose
 * `file_key` is not an uploaded file key degrades to text. Idempotent — the
 * fallbacks contain no `](` and no `<audio`, so a second pass is a no-op.
 *
 * @param text - card markdown source.
 * @param options - see {@link NeutralizeOptions}.
 * @returns markdown Feishu will accept.
 */
export function neutralizeCardMarkdown(text: string, options: NeutralizeOptions = {}): string {
  const withReferences = mapCardMarkdownReferences(text, (reference) => {
    if (reference.image) {
      if (options.aggressive !== true && isFeishuImageKey(reference.target)) return reference.raw
      return imageFallback(reference.alt, reference.target)
    }
    // A plain link never makes Feishu reject a card; it is only downgraded when
    // clicking it could not possibly do anything.
    if (options.aggressive === true || isOpenableTarget(reference.target)) return reference.raw
    return linkFallback(reference.alt, reference.target)
  })
  const withAudio = mapCardMarkdownAudio(withReferences, (fileKey, raw) =>
    options.aggressive !== true && isFeishuFileKey(fileKey) ? raw : audioFallback(fileKey, raw))
  // Emphasis LAST: it must judge the markdown Feishu actually receives, code
  // spans the fallbacks inserted included (see card-emphasis.ts).
  return normalizeCardEmphasis(withAudio)
}

/** Rewrite every `markdown` element of a card tree; everything else is copied. */
export function neutralizeCard(card: object, options: NeutralizeOptions = {}): object {
  return rewriteNode(card, options) as object
}

/** What a card media element that has to be dropped becomes. */
function mediaElementFallback(record: Record<string, unknown>): Record<string, unknown> {
  const key = typeof record.file_key === 'string' ? record.file_key : ''
  const icon = record.tag === 'audio' ? '🔊' : '📹'
  return { tag: 'markdown', content: `${icon} ${codeSpan(key)}` }
}

function rewriteNode(node: unknown, options: NeutralizeOptions): unknown {
  if (Array.isArray(node)) return node.map((entry) => rewriteNode(entry, options))
  if (node === null || typeof node !== 'object') return node
  const record = node as Record<string, unknown>
  // The last-resort retry drops the media elements our hydrator inserted: if the
  // card was refused with them, a delivered card beats an inline clip.
  if (options.aggressive === true && (record.tag === 'video' || record.tag === 'audio')) {
    return mediaElementFallback(record)
  }
  const isMarkdown = record.tag === 'markdown'
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = isMarkdown && key === 'content' && typeof value === 'string'
      ? neutralizeCardMarkdown(value, options)
      : rewriteNode(value, options)
  }
  return result
}

/**
 * Whether a Feishu write failed because of the card's CONTENT (an invalid image
 * key or another content-level rejection) rather than transport, auth or rate
 * limiting. Only these are worth retrying with a blunter payload.
 */
export function isCardContentRejection(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('invalid image keys')) return true
  if (text.includes('Failed to create card content')) return true
  return /\b(?:200570|11310)\b/.test(text)
}
