/**
 * Secret-safe logging for the Feishu SDK.
 *
 * The SDK's default logger prints whatever it is handed, verbatim:
 * `console.log('[error]:', ...msg)`. Its HTTP layer reports failures by passing
 * the whole axios error, whose `config.data` is the token request body — the
 * `app_secret` in clear text. That is how the app secret ended up in the system
 * journal on 2026-09-21 (key pitfall 29, secondary finding).
 *
 * We therefore hand the SDK our own logger. Errors are reduced to their message
 * and stack (neither carries a request body), other values go through
 * `JSON.stringify`, and every produced line is scrubbed of the configured
 * secrets as a second line of defence.
 *
 * @module @starxer/chatterbox4dsh/log-redact
 */

/**
 * Structural twin of the SDK's `Logger`. Kept local so we do not depend on the
 * SDK re-exporting the type.
 */
export interface SafeChannelLogger {
  error(...msg: unknown[]): void
  warn(...msg: unknown[]): void
  info(...msg: unknown[]): void
  debug(...msg: unknown[]): void
  trace(...msg: unknown[]): void
}

/** Longest single rendered argument; a pathologically nested error must not flood the journal. */
const MAX_ARG_CHARS = 900

/** One JSON body, parsed out of a string/Buffer envelope (download endpoints stream theirs). */
function parsedBody(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object' && !Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) {
    return value as Record<string, unknown>
  }
  let text: string | undefined
  if (typeof value === 'string') text = value
  else if (Buffer.isBuffer(value)) text = value.toString('utf8')
  if (text === undefined || text.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * The fields of an axios-style error that are worth logging — and NOTHING
 * else.
 *
 * `config.data` is the request body: on the tenant-token call it is the
 * `app_secret` in clear text, and that is how the secret reached the journal on
 * 2026-09-21 (key pitfall 29). `request` is an http.ClientRequest whose socket
 * closes the object graph into a cycle. What a reader actually needs is the
 * method/url, the status, and Feishu's own `{code, msg}` — that trio is what
 * 2026-10-27's `234003 File not in msg.` required and the old renderer turned
 * into `[object Object],[object Object]`.
 */
function axiosSummary(value: Record<string, unknown>): string | undefined {
  const config = value.config
  const response = value.response
  if (config === undefined && response === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const key of ['name', 'message', 'code'] as const) {
    const field = value[key]
    if (typeof field === 'string' || typeof field === 'number') out[key] = field
  }
  if (config !== null && typeof config === 'object') {
    const c = config as Record<string, unknown>
    out.request = {
      ...(typeof c.method === 'string' ? { method: c.method } : {}),
      ...(typeof c.url === 'string' ? { url: c.url } : {}),
    }
  }
  if (response !== null && typeof response === 'object') {
    const r = response as Record<string, unknown>
    const body = parsedBody(r.data)
    out.response = {
      ...(typeof r.status === 'number' ? { status: r.status } : {}),
      ...(typeof r.statusText === 'string' && r.statusText !== '' ? { statusText: r.statusText } : {}),
      ...(body === undefined ? {} : { data: { ...(body.code === undefined ? {} : { code: body.code }), ...(typeof body.msg === 'string' ? { msg: body.msg } : {}) } }),
    }
  }
  const cause = value.cause
  if (cause instanceof Error) out.cause = `${cause.name}: ${cause.message}`
  else if (cause !== undefined && cause !== null) out.cause = String(cause)
  return JSON.stringify(out)
}

/** Cycle-safe JSON; falls back to a bounded String() render. */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[circular]'
        seen.add(item)
      }
      return item
    })
    if (text === undefined) return String(value)
    return text.length > MAX_ARG_CHARS ? `${text.slice(0, MAX_ARG_CHARS)}…` : text
  } catch {
    return String(value)
  }
}

/**
 * Render one log argument without ever expanding a request config.
 *
 * `Error` → its stack (no `config`); arrays are rendered element by element
 * (the SDK hands the pipeline failure over as an ARRAY, and the old `String()`
 * fallback collapsed the whole thing to `[object Object],[object Object]`);
 * axios-shaped objects are reduced by {@link axiosSummary}; anything else is
 * JSON-serialized cycle-safely.
 */
const renderArg = (value: unknown): string => {
  if (value instanceof Error) {
    const summary = axiosSummary(value as unknown as Record<string, unknown>)
    return summary ?? value.stack ?? `${value.name}: ${value.message}`
  }
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return String(value)
  if (Array.isArray(value)) return value.map(renderArg).join(' ')
  if (typeof value === 'object') {
    const summary = axiosSummary(value as Record<string, unknown>)
    if (summary !== undefined) return summary
  }
  return safeJson(value)
}

/**
 * Scrub every known secret value, plus any bearer token, from one line.
 *
 * The value-based scrub is what actually protects us: it works no matter how
 * deeply a secret is nested in whatever the SDK decided to print.
 */
export const redactSecrets = (text: string, secrets: readonly string[]): string => {
  let out = text
  for (const secret of secrets) {
    if (secret === '') continue
    out = out.split(secret).join('***')
  }
  return out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***')
}

/** Build a logger that scrubs `secrets` from everything the SDK prints. */
export const createSafeChannelLogger = (secrets: readonly string[]): SafeChannelLogger => {
  const emit = (
    sink: (...args: unknown[]) => void,
    level: string,
    msg: readonly unknown[],
  ): void => {
    sink(`dsh-feishu: [sdk ${level}]`, redactSecrets(msg.map(renderArg).join(' '), secrets))
  }
  return {
    error: (...msg) => emit(console.log, 'error', msg),
    warn: (...msg) => emit(console.warn, 'warn', msg),
    info: (...msg) => emit(console.info, 'info', msg),
    debug: (...msg) => emit(console.debug, 'debug', msg),
    trace: (...msg) => emit(console.trace, 'trace', msg),
  }
}
