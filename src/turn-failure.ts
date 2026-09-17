/**
 * Web-UI-aligned projection of a terminal turn failure.
 *
 * The DSH Web UI renders a failed turn from the `turn/end` event alone
 * (`reason.kind === 'error'` → `reason.error`): the failure's `message` becomes
 * the body, its string `code` becomes a chip, and the row is titled with the
 * localized `message.turnError` string. When the code is `AUTH` the provider's
 * message (which may echo a masked credential) is dropped entirely and the
 * localized `message.failure.auth` sentence is shown instead.
 *
 * This module ports that projection verbatim so the Feishu side never invents
 * its own reading of an error: it renders exactly what the Web UI renders, from
 * the same structured facts, instead of collapsing the reason into a generic
 * apology sentence.
 *
 * Ported from DSH:
 * - `packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts`
 *   (`displayFailure`)
 * - `packages/client/ui-chat/src/client/chat/MessageItem.tsx`
 *   (`TurnErrorItem` / `failureMessage`)
 * - `packages/client/ui-chat/src/client/locale.ts`
 *   (`message.turnError`, `message.failure.auth` — mirrored in `./i18n.ts`)
 *
 * @module @starxer/chatterbox4dsh/turn-failure
 */

import type { Translations } from './i18n.ts'

/** Structured failure facts the Web UI renders for a failed turn. */
export interface TurnFailure {
  /** Provider/agent message shown as the body; empty when the AUTH sentence substitutes it. */
  readonly message: string
  /** Stable machine code shown as a chip; absent when the failure carried none. */
  readonly code?: string
}

/**
 * Project an unknown `turn/end` failure payload into the two facts the Web UI
 * keeps. Mirrors `displayFailure` in DSH's ui-chat conversation nodes: a
 * non-object payload renders as its string form, a non-string `code` is
 * dropped, a non-string `message` falls back to the serialized payload, and an
 * `AUTH` code keeps only the code (its message may echo a credential).
 *
 * @param failure the raw `reason.error` value from a `turn/end` event
 * @returns the message/code pair the Web UI would render
 */
export function displayFailure(failure: unknown): TurnFailure {
  if (failure === null || typeof failure !== 'object') return { message: String(failure) }
  const record = failure as { code?: unknown; message?: unknown }
  const code = typeof record.code === 'string' ? record.code : undefined
  if (code === 'AUTH') return { code, message: '' }
  return {
    ...code === undefined ? {} : { code },
    message: typeof record.message === 'string' ? record.message : stringify(failure),
  }
}

/** `JSON.stringify` that never throws on a circular or unserializable payload. */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Carries a terminal turn failure out of the conversation service without
 * flattening it. The channel recognises this type and renders
 * {@link renderTurnFailureCard} instead of the generic "处理这条消息时出错" text.
 */
export class TurnFailureError extends Error {
  /** The structured facts to render — never re-derived from this error. */
  readonly failure: TurnFailure

  constructor(failure: TurnFailure) {
    super(failure.message === '' ? `turn failed (${failure.code ?? 'UNKNOWN'})` : failure.message)
    this.name = 'TurnFailureError'
    this.failure = failure
  }
}

/**
 * Render the failure as a Feishu card shaped like the Web UI's turn-error row:
 * red header carrying `message.turnError`, the provider message as the body,
 * and the machine code as an inline-code line.
 *
 * @param t active translations (the same ones the Web UI's locale provides)
 * @param failure structured facts from {@link displayFailure}
 * @returns a Card JSON 2.0 payload
 */
export function renderTurnFailureCard(t: Translations, failure: TurnFailure): object {
  // Mirrors `failureMessage()`: only AUTH replaces the provider text.
  const message = failure.code === 'AUTH' ? t.failureAuth : failure.message
  const elements: object[] = []
  if (message.trim() !== '') elements.push({ tag: 'markdown', content: message })
  if (failure.code !== undefined) elements.push({ tag: 'markdown', content: `\`${failure.code}\`` })
  if (elements.length === 0) elements.push({ tag: 'markdown', content: t.turnFailedTitle })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.turnFailedTitle },
      template: 'red',
    },
    body: { elements },
  }
}

/**
 * Plain-text form of the same facts, used only when Feishu rejects the card.
 * Carries the identical message and code — the reason must never be lost just
 * because one delivery shape failed.
 *
 * @param t active translations
 * @param failure structured facts from {@link displayFailure}
 * @returns a single-line reason prefixed with the turn-error title
 */
export function turnFailureText(t: Translations, failure: TurnFailure): string {
  const message = failure.code === 'AUTH' ? t.failureAuth : failure.message
  const parts = [message.trim(), failure.code === undefined ? '' : `[${failure.code}]`].filter(part => part !== '')
  return `${t.turnFailedTitle}：${parts.join(' ')}`
}
