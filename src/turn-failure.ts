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
 * Card action kind carried by the "continue" button a failed-turn card may
 * show. The value also carries the session id, so the click handler never has
 * to guess which session a topic belongs to.
 */
export const TURN_CONTINUE_ACTION = 'turn-continue'

/** Extra affordances one failed-turn card may carry. */
export interface TurnFailureCardOptions {
  /**
   * Session id the continue button targets. Absent (or empty) hides the
   * button — e.g. when the Host will not let this failed turn be continued.
   */
  readonly continueSessionId?: string | undefined
}

/**
 * Whether this failure is the provider refusing on content-safety grounds.
 *
 * DSH 0.2.2-rc.4 maps the Anthropic `refusal` stop reason onto the
 * `CONTENT_REFUSED` code; the older runtime reported the same event as
 * `MALFORMED_RESPONSE` with the message `… unsupported stop reason refusal`,
 * which is why the message is matched too (a rollback must keep explaining it).
 *
 * @param failure structured facts from {@link displayFailure}
 * @returns true when the provider's own review declined the answer
 */
export function isContentRefusal(failure: TurnFailure): boolean {
  if (failure.code === 'CONTENT_REFUSED') return true
  return failure.code === 'MALFORMED_RESPONSE' && /unsupported stop reason refusal/iu.test(failure.message)
}

/**
 * Render the failure as a Feishu card shaped like the Web UI's turn-error row:
 * red header carrying `message.turnError`, the provider message as the body,
 * and the machine code as an inline-code line.
 *
 * On top of the Web UI shape it may add two things the chat format needs:
 * a localized explanation for a content-safety refusal (the Web UI has no
 * such row), and a "continue" button when the Host says the failed turn is
 * continuable.
 *
 * @param t active translations (the same ones the Web UI's locale provides)
 * @param failure structured facts from {@link displayFailure}
 * @param options continue affordance (see {@link TurnFailureCardOptions})
 * @returns a Card JSON 2.0 payload
 */
export function renderTurnFailureCard(
  t: Translations,
  failure: TurnFailure,
  options: TurnFailureCardOptions = {},
): object {
  // Mirrors `failureMessage()`: only AUTH replaces the provider text.
  const message = failure.code === 'AUTH' ? t.failureAuth : failure.message
  const elements: object[] = []
  if (message.trim() !== '') elements.push({ tag: 'markdown', content: message })
  if (failure.code !== undefined) elements.push({ tag: 'markdown', content: `\`${failure.code}\`` })
  // Not a fallback sentence: the fact stays the provider's message and code
  // above; this line only explains a code the reader cannot be expected to
  // know, and says what usually helps.
  if (isContentRefusal(failure)) elements.push({ tag: 'markdown', content: t.failureRefusedHint })
  if (options.continueSessionId !== undefined && options.continueSessionId !== '') {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t.turnContinueButton },
      type: 'primary',
      // Card 2.0 only honours `behaviors` (关键坑 4). The card is sent once and
      // never updated, so the button keeps delivering callbacks (关键坑 11).
      behaviors: [{ type: 'callback', value: { kind: TURN_CONTINUE_ACTION, sessionId: options.continueSessionId } }],
    })
  }
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
  const text = `${t.turnFailedTitle}：${parts.join(' ')}`
  return isContentRefusal(failure) ? `${text}\n${t.failureRefusedHint}` : text
}
