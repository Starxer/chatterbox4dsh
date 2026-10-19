/**
 * `/fork` turn picker: a one-shot card listing a session's completed turns with a
 * preview of each turn's opening text, plus the tap handler that forks at the
 * chosen turn's `turn/end` seq.
 *
 * Fork does not touch the current session — it copies the history prefix into a
 * NEW session (DSH `sessionController.fork`), which is the supported way to
 * "go back to before turn N and try again": the original log stays audit-proof,
 * the new session simply never inherits the turns after the pick.
 *
 * Card actions only carry `chatId` + `messageId`, so the picker remembers the
 * session and turn list it sent (关键坑 31: never infer the conversation from the
 * chat alone). Tapping a row is the whole interaction — one tap forks.
 *
 * @module @starxer/chatterbox4dsh/feishu-fork
 */

import { decodeCardValue } from './card-action.ts'
import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import { replyOptsForChat } from './feishu-panel.ts'
import type { CompletedTurn } from './turn-history.ts'

/** Callback value prefix that identifies one turn row of the picker card. */
export const FORK_ACTION = 'dsh-feishu:fork-turn'

/** Rows the picker shows (newest wins); the tail is summarised in one line. */
export const FORK_TURN_LIMIT = 12

/** How far back the picker looks to know how many older turns were omitted. */
const FORK_TURN_SCAN = 60

/** The channel surface the picker needs. */
export interface ForkChannel {
  send(
    to: string,
    input: { card: object } | { text: string },
    opts?: { replyInThread?: boolean; replyTo?: string },
  ): Promise<{ messageId?: string }>
  onCardAction?(handler: (event: ForkCardEvent) => void | Promise<void>): () => void
}

/** One card callback the picker subscribes to. */
export interface ForkCardEvent {
  chatId?: string
  messageId?: string
  action?: { value?: unknown }
}

/** Logger view (only warnings are produced here). */
export interface ForkLogger {
  warn(message: string): unknown
}

/** The slice of DSH's session controller this module uses. */
export interface ForkSessionControllerLike {
  fork?: (request: { sessionId: string; atSeq?: number }) => Promise<unknown>
}

/** The bridge slice used to resolve the bound session and read its turns. */
export interface ForkBridgeLike {
  resolveSessionIdFor(message: ConversationMessage): string
  listTurns(message: ConversationMessage, limit?: number): Promise<readonly CompletedTurn[]>
}

/** Dependencies of {@link startFeishuFork}. */
export interface FeishuForkDeps {
  channel: ForkChannel
  bridgeHolder: { current?: ForkBridgeLike | undefined }
  sessionController?: ForkSessionControllerLike | undefined
  logger: ForkLogger
  getTranslations: () => Translations
}

/** Handle returned by {@link startFeishuFork}. */
export interface FeishuForkHandle {
  /** Send the turn-picker card for `chat` (the `/fork` command with no argument). */
  openCard(chat: ConversationMessage): Promise<void>
  /** Fork `chat`'s session at the end of turn `turn` and send the outcome card. */
  forkAtTurn(chat: ConversationMessage, turn: number): Promise<{ kind: 'success' | 'error'; text: string }>
  /** Unsubscribe the card-action fan-out. */
  stop(): void
}

/** One turn row's callback payload. */
interface TurnRowPayload {
  p: string
  turn: number
}

/** One picker card the module still expects taps on. */
interface PickerCard {
  chat: ConversationMessage
  sessionId: string
  turns: readonly CompletedTurn[]
}

/**
 * Render the turn-picker card.
 *
 * @param turns - the turns to list, oldest first (rows are shown newest first
 *   so the common "just redo the last turn" pick is at the top).
 * @param t - active locale strings.
 * @param omitted - how many older completed turns were not listed.
 * @returns the Card JSON 2.0 object.
 */
export function renderForkTurnsCard(
  turns: readonly CompletedTurn[],
  t: Translations,
  omitted = 0,
): object {
  const elements: object[] = [{ tag: 'markdown', content: t.forkCardHint }]
  for (const turn of [...turns].reverse()) {
    elements.push({
      tag: 'interactive_container',
      width: 'fill',
      has_border: false,
      padding: '4px 12px 4px 12px',
      behaviors: [{ type: 'callback', value: { p: FORK_ACTION, turn: turn.turn } satisfies TurnRowPayload }],
      elements: [
        { tag: 'markdown', content: t.forkRowTitle(turn.turn) },
        { tag: 'markdown', content: turn.preview === '' ? t.forkRowNoPreview : turn.preview, text_size: 'notation' },
      ],
    })
  }
  if (omitted > 0) {
    elements.push({ tag: 'markdown', content: t.forkMoreTurns(omitted), text_size: 'notation' })
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.forkCardTitle }, template: 'turquoise' },
    body: { elements },
  }
}

/** Outcome card: green when the fork committed, red when it did not. */
export function renderForkResultCard(text: string, ok: boolean, t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.forkCardTitle }, template: ok ? 'green' : 'red' },
    body: { elements: [{ tag: 'markdown', content: text }] },
  }
}

/**
 * Start the `/fork` surface.
 *
 * @param deps - channel, bridge/resolver, session controller and locale reader.
 * @returns the handle the command runtime and the disposer use.
 */
export function startFeishuFork(deps: FeishuForkDeps): FeishuForkHandle {
  const { channel, bridgeHolder, sessionController, logger, getTranslations } = deps
  const cards = new Map<string, PickerCard>()

  const sendCard = async (chat: ConversationMessage, card: object): Promise<void> => {
    await channel.send(chat.chatId, { card }, replyOptsForChat(chat)).catch((error: unknown) => {
      logger.warn(`dsh-feishu: fork card send failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const sendText = async (chat: ConversationMessage, text: string): Promise<void> => {
    await channel.send(chat.chatId, { text }, replyOptsForChat(chat)).catch((error: unknown) => {
      logger.warn(`dsh-feishu: fork notice send failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Fork at `turn` on screen, then report the new session id. */
  const commit = async (
    chat: ConversationMessage,
    sessionId: string,
    turn: CompletedTurn,
  ): Promise<{ ok: boolean; text: string }> => {
    const t = getTranslations()
    if (sessionController?.fork === undefined) return { ok: false, text: t.forkUnsupported }
    try {
      const result = await sessionController.fork({ sessionId, atSeq: turn.endSeq }) as { sessionId?: string } | undefined
      const newSessionId = typeof result?.sessionId === 'string' ? result.sessionId : ''
      return { ok: true, text: newSessionId === '' ? t.forkSuccess(turn.turn, '—') : t.forkSuccess(turn.turn, newSessionId) }
    } catch (error: unknown) {
      return { ok: false, text: t.forkFailed(error instanceof Error ? error.message : String(error)) }
    }
  }

  const onCardAction = async (event: ForkCardEvent): Promise<void> => {
    if (event.messageId === undefined) return
    const picker = cards.get(event.messageId)
    if (picker === undefined) return
    if (event.chatId !== undefined && event.chatId !== picker.chat.chatId) return
    const value = decodeCardValue(event.action?.value)
    if (value === undefined || value.p !== FORK_ACTION) return
    const turnNumber = value.turn
    if (typeof turnNumber !== 'number' || !Number.isInteger(turnNumber)) return
    const turn = picker.turns.find(candidate => candidate.turn === turnNumber)
    if (turn === undefined) {
      await sendText(picker.chat, getTranslations().forkFailed(getTranslations().forkUnknownTurn(turnNumber)))
      return
    }
    // One picker card accepts one pick: Feishu stops reporting row taps on a
    // card after the first one (关键坑 55).
    cards.delete(event.messageId)
    const outcome = await commit(picker.chat, picker.sessionId, turn)
    await sendCard(picker.chat, renderForkResultCard(outcome.text, outcome.ok, getTranslations()))
  }

  const unsubscribe = channel.onCardAction?.(onCardAction)

  const openCard = async (chat: ConversationMessage): Promise<void> => {
    const t = getTranslations()
    const bridge = bridgeHolder.current
    if (bridge === undefined) {
      await sendText(chat, t.forkNoSession)
      return
    }
    const sessionId = bridge.resolveSessionIdFor(chat)
    if (sessionId === '') {
      await sendText(chat, t.forkNoSession)
      return
    }
    const scanned = await bridge.listTurns(chat, FORK_TURN_SCAN).catch((error: unknown) => {
      logger.warn(`dsh-feishu: fork turn scan failed: ${error instanceof Error ? error.message : String(error)}`)
      return [] as readonly CompletedTurn[]
    })
    if (scanned.length === 0) {
      await sendText(chat, t.forkEmptyTurns)
      return
    }
    const turns = scanned.slice(-FORK_TURN_LIMIT)
    const omitted = Math.max(0, scanned.length - turns.length)
    const sent = await channel.send(chat.chatId, { card: renderForkTurnsCard(turns, t, omitted) }, replyOptsForChat(chat))
    if (sent.messageId !== undefined) cards.set(sent.messageId, { chat, sessionId, turns })
  }

  const forkAtTurn = async (
    chat: ConversationMessage,
    turn: number,
  ): Promise<{ kind: 'success' | 'error'; text: string }> => {
    const t = getTranslations()
    const bridge = bridgeHolder.current
    if (bridge === undefined) return { kind: 'error', text: t.forkNoSession }
    const sessionId = bridge.resolveSessionIdFor(chat)
    if (sessionId === '') return { kind: 'error', text: t.forkNoSession }
    if (sessionController?.fork === undefined) return { kind: 'error', text: t.forkUnsupported }
    const turns = await bridge.listTurns(chat, FORK_TURN_SCAN)
    const chosen = turns.find(candidate => candidate.turn === turn)
    if (chosen === undefined) return { kind: 'error', text: t.forkFailed(t.forkUnknownTurn(turn)) }
    const outcome = await commit(chat, sessionId, chosen)
    return { kind: outcome.ok ? 'success' : 'error', text: outcome.text }
  }

  return {
    openCard,
    forkAtTurn,
    stop: () => {
      cards.clear()
      unsubscribe?.()
    },
  }
}
