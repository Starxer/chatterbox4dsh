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

/**
 * Render one log argument without ever expanding a request config.
 *
 * `Error` → `name: message` plus stack; strings pass through; everything else
 * is JSON-serialized so the output stays bounded and greppable. Objects that
 * cannot be serialized (cycles) degrade to `String(value)`.
 */
const renderArg = (value: unknown): string => {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
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
