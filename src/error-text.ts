/**
 * Convert a caught `unknown` error into a user-facing reason that can be sent
 * back into a Feishu chat. The plugin's default behaviour is to send a unified
 * apology (`errorMessage`) with no detail, which makes the user guess. This
 * extracts the actionable message and, when the error carries one, a numeric
 * error code (e.g. Feishu API business codes like 230021 for a file that is too
 * large), so the message tells the user exactly what went wrong.
 *
 * Three facts shape what "the reason" is, all measured on this deployment:
 *
 * 1. The thrown error is often a WRAPPER. A Feishu SDK failure reads
 *    `Request failed with status code 400` while the sentence that says what
 *    Feishu actually objected to sits in `response.data.msg` — or, when we
 *    wrapped it ourselves, in the `cause` chain. Rendering only `.message`
 *    throws away the only informative part.
 * 2. Errors are SHORT in practice: across 23 session logs (21 645 tool
 *    results, 734 failures) the longest failure text was 344 chars. The cap
 *    below therefore almost never binds; it exists so a pathological payload
 *    cannot flood the chat.
 * 3. The chat budget is NOT the constraint here: a Feishu text message allows a
 *    150 KB request body, five times a card's 30 KB. Text is also not parsed as
 *    markdown, so no error text can be rejected for carrying image/link syntax
 *    (key pitfall 39). That is why every caller of this function posts text.
 *
 * @module @starxer/chatterbox4dsh/error-text
 */

import { truncateInline } from './text-chunk.ts'

/**
 * Cap on the rendered reason, in characters. Generous on purpose: raising it
 * costs nothing on the text-message path and the cause chain is worth keeping.
 */
export const ERROR_TEXT_CAP = 1000

/** Deepest `cause` hop rendered; a cycle or a runaway chain stops here. */
const MAX_CAUSE_DEPTH = 4

/** Distinct `cause` messages, outermost first, deduplicated and bounded. */
function causeChain(error: unknown): string[] {
  const out: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = isObject(error) ? (error as { cause?: unknown }).cause : undefined
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!isObject(current) && typeof current !== 'string') break
    if (seen.has(current)) break
    seen.add(current)
    const text = messageOf(current)
    if (text !== '') out.push(text)
    current = isObject(current) ? (current as { cause?: unknown }).cause : undefined
  }
  return out
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * The Feishu/axios response envelope, when there is one.
 *
 * A DOWNLOAD endpoint answers with a stream, so on a 400 the SDK's error
 * carries the body as a Buffer (or a JSON string) instead of a parsed object —
 * which is exactly the case where the business code (`234003 File not in msg.`)
 * is the only thing that explains the failure. Parse those shapes too; only
 * `code`/`msg` are ever read from the result.
 */
function responseEnvelope(error: unknown): Record<string, unknown> | undefined {
  if (!isObject(error)) return undefined
  const data = (error as { response?: { data?: unknown } }).response?.data
  if (data === undefined || data === null) return undefined
  if (isObject(data) && !Buffer.isBuffer(data)) return data
  let text: string | undefined
  if (typeof data === 'string') text = data
  else if (Buffer.isBuffer(data)) text = data.toString('utf8')
  if (text === undefined || text.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The error's own message, trimmed; `''` when there is nothing to show. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.trim()
  if (error === undefined || error === null) return ''
  return String(error).trim()
}

/**
 * The machine code, from the error itself or from a Feishu/axios response
 * envelope (where the SDK puts the business code).
 */
function codeOf(error: unknown): string | undefined {
  if (!isObject(error)) return undefined
  // The BUSINESS code wins: an axios error's own `code` is the useless
  // `ERR_BAD_REQUEST`, while Feishu's `234003` is what says "file not in msg".
  const envelope = responseEnvelope(error)?.code
  if (typeof envelope === 'number') return String(envelope)
  if (typeof envelope === 'string' && envelope.trim() !== '') return envelope.trim()
  const own = error.code
  if (typeof own === 'number') return String(own)
  if (typeof own === 'string' && own.trim() !== '') return own.trim()
  return undefined
}

/**
 * Feishu's own wording from an SDK/axios error envelope. Deliberately reads only
 * `response.data.msg` — never `config`/`request`, which carry the request body
 * (and, on the token endpoint, the app secret; key pitfall 29).
 */
function responseReasonOf(error: unknown): string {
  const message = responseEnvelope(error)?.msg
  return typeof message === 'string' ? message.trim() : ''
}

/**
 * Render a caught error as a short single-line reason for user display.
 *
 * - Uses `error.message` when the error is an `Error`; otherwise `String(error)`.
 * - Adds Feishu's own `response.data.msg` when the error carries one.
 * - Walks the `cause` chain (up to {@link MAX_CAUSE_DEPTH} hops) and appends
 *   every distinct cause as ` ← <cause>`, so a wrapper never hides the reason.
 * - Appends the error's numeric `code` (or string `code`) as `(code: N)` unless
 *   it already appears inside the message (avoiding "code:230021 (code: 230021)").
 * - Falls back to `fallback` when there is nothing useful to show.
 * - Truncates at {@link ERROR_TEXT_CAP} chars.
 *
 * @param error the thrown value
 * @param fallback user-facing text used when no reason can be extracted
 * @returns a concise reason, never a stack trace
 */
export function errorText(error: unknown, fallback: string): string {
  const reason = messageOf(error)
  let code = codeOf(error)
  if (code !== undefined && reason.includes(code)) code = undefined

  let detail = reason
  const responseReason = responseReasonOf(error)
  if (responseReason !== '' && !detail.includes(responseReason)) {
    detail = detail === '' ? responseReason : `${detail} — ${responseReason}`
  }
  for (const cause of causeChain(error)) {
    if (detail.includes(cause)) continue
    detail = detail === '' ? cause : `${detail} ← ${cause}`
  }
  if (code !== undefined) detail = detail === '' ? `error code ${code}` : `${detail} (code: ${code})`
  if (detail === '') return fallback
  return detail.length > ERROR_TEXT_CAP ? truncateInline(detail, ERROR_TEXT_CAP) : detail
}
