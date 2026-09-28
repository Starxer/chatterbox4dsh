/**
 * The compaction card: one updatable card per compaction transaction.
 *
 * A DSH compaction writes three durable events around one replacement message
 * (`packages/compaction/compaction/lib/types/types.d.ts`):
 *
 * | event                | what the card does                                    |
 * |----------------------|-------------------------------------------------------|
 * | `compaction/start`   | opens the card: `🗜️ 正在压缩上下文…` + the trigger      |
 * | `compaction/summary` | details line (folded items / tokens / route) + a collapsed summary panel |
 * | `compaction/end`     | repaints green, or red with the failure reason when `error` is set |
 *
 * The same three writes also cover a `compaction/prune` (a model-free prune has
 * `start` → `prune` → `end` and no summary at all), which is why the card never
 * assumes a summary exists: only `compaction/summary` carries one, and the
 * failure path (`end.error`) never does.
 *
 * Everything the user sees was decided in `docs/transcript-parity-design.md`
 * §2.4: the details go ABOVE the fold, the summary is folded (`collapsible_panel`,
 * verified against the live API 2026-09-29), its body is capped at
 * {@link COMPACTION_SUMMARY_CAP} characters, and there is no "send the full
 * summary as a file" button.
 *
 * Writes are serialized per card and never reject. This card is not on any
 * critical path — a compaction happens BETWEEN steps — so a failed write only
 * costs the notice, and the fallback is a plain text line (never another card:
 * see key pitfall 40).
 *
 * @module @starxer/chatterbox4dsh/feishu-compaction
 */

import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import { errorText } from './error-text.ts'

/** Longest summary body carried into the folded panel, in characters. */
export const COMPACTION_SUMMARY_CAP = 200

/** Where the card currently is. */
export type CompactionPhase = 'start' | 'summary' | 'done' | 'failed'

/** The metering facts a `compaction/summary` reports. */
export interface CompactionFacts {
  /** How many history items the replacement shadows (`shadowedSeqs.length`). */
  foldedItems?: number
  /** Their heuristic token price (`shadowedTokenCount`). */
  foldedTokens?: number
  /** The route that WROTE the summary (not the session's model). */
  provider?: string
  model?: string
  /** The summary body, already flattened from its content blocks. */
  summary?: string
}

/** Everything one render needs. */
export interface CompactionRenderInput {
  phase: CompactionPhase
  /** Manual transactions carry a `sourceCommandId`. */
  manual: boolean
  facts?: CompactionFacts
  /** `compaction/end.error`, verbatim (a string, not an Error). */
  error?: string
}

/** The channel surface this module needs (structurally satisfied by the card channel). */
export interface CompactionCardChannel {
  send(
    to: string,
    input: { card?: object; text?: string },
    opts?: { replyInThread?: boolean; replyTo?: string },
  ): Promise<{ messageId?: string }>
  createCardInstance?(card: object): Promise<string>
  sendCardByReference?(
    to: string,
    cardId: string,
    opts?: { replyInThread?: boolean; replyTo?: string },
  ): Promise<{ messageId?: string }>
  updateCardInstance?(cardId: string, card: object, sequence: number): Promise<void>
  updateCard?(messageId: string, card: object): Promise<void>
}

export interface CompactionCardsDeps {
  channel: CompactionCardChannel
  logger: { warn(message: string): unknown; error(message: string): unknown }
  /** Strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
}

/** `/3.0K`-style token counts, matching the rest of the card surface. */
function formatTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

/** Flatten a summary's content blocks to text. */
export function summaryText(blocks: unknown): string | undefined {
  if (typeof blocks === 'string') return blocks.trim() === '' ? undefined : blocks
  if (!Array.isArray(blocks)) return undefined
  const parts: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  const joined = parts.join('\n').trim()
  return joined === '' ? undefined : joined
}

/** @returns the details line: what was folded, then which route folded it. */
function detailsLine(t: Translations, facts: CompactionFacts | undefined): string | undefined {
  if (facts === undefined) return undefined
  const parts: string[] = []
  if (facts.foldedItems !== undefined && facts.foldedItems > 0) {
    parts.push(t.compactionFoldedItems(facts.foldedItems))
  }
  if (facts.foldedTokens !== undefined && facts.foldedTokens > 0) {
    parts.push(t.compactionFoldedTokens(formatTokens(facts.foldedTokens)))
  }
  if (facts.provider !== undefined && facts.model !== undefined) {
    parts.push(`${facts.provider}/${facts.model}`)
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/**
 * Render the card for one point in the transaction.
 *
 * @param t - translations for the active locale.
 * @param input - phase, trigger and whatever facts are known so far.
 * @returns the full card JSON.
 */
export function renderCompactionCard(t: Translations, input: CompactionRenderInput): object {
  const elements: object[] = []
  const details = detailsLine(t, input.facts)

  if (input.phase === 'start') {
    elements.push({
      tag: 'markdown',
      content: t.compactionStartBody(input.manual ? t.compactionTriggerManual : t.compactionTriggerAuto),
      text_size: 'notation',
    })
  } else {
    // The details line is deliberately ABOVE the fold: "how much history just
    // disappeared" is the fact worth seeing without a tap.
    if (details !== undefined) {
      elements.push({ tag: 'markdown', content: details })
    }
    if (input.phase === 'failed') {
      if (input.error !== undefined && input.error !== '') {
        elements.push({ tag: 'markdown', content: t.compactionFailedReason(input.error), text_size: 'notation' })
      }
      elements.push({ tag: 'markdown', content: t.compactionNoSummary, text_size: 'notation' })
    } else {
      // A prune (or a summary event we could not read) has no body. Say so
      // instead of showing an empty expander.
      const body = input.facts?.summary
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'markdown', content: `**${t.compactionSummaryLabel}**` } },
        elements: [{
          tag: 'markdown',
          content: body === undefined
            ? t.compactionSummaryUnavailable
            : body.length > COMPACTION_SUMMARY_CAP ? `${body.slice(0, COMPACTION_SUMMARY_CAP)}…` : body,
        }],
      })
    }
  }

  const title = input.phase === 'start'
    ? t.compactionCardTitleStart
    : input.phase === 'failed'
      ? t.compactionCardTitleFailed
      : input.manual ? t.compactionCardTitleDoneManual : t.compactionCardTitleDone
  const template = input.phase === 'start' ? 'grey' : input.phase === 'failed' ? 'red' : 'green'

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements },
  }
}

/** One live compaction card. */
interface CardEntry {
  sessionId: string
  chat: ConversationMessage
  cardId: Promise<string | undefined>
  messageId: Promise<string | undefined>
  sequence: number
  /** Serializes writes; never rejects. */
  chain: Promise<unknown>
  /** The send failed: stop trying to update and answer in text instead. */
  dead: boolean
  input: CompactionRenderInput
}

export interface CompactionCardsHandle {
  start(chat: ConversationMessage, sessionId: string, manual: boolean): void
  applySummary(chat: ConversationMessage, sessionId: string, facts: CompactionFacts): void
  end(chat: ConversationMessage, sessionId: string, error: string | undefined): void
  stop(): void
}

/**
 * Start the compaction-card writer.
 *
 * One card per session: `compaction/start` opens it and the summary/end events
 * update it in place. A second `start` while one is still open (a retried
 * transaction) opens a NEW card, because a card entity may only be sent once
 * and the previous card is already a historical record.
 */
export function createCompactionCards(deps: CompactionCardsDeps): CompactionCardsHandle {
  const { channel, logger, getTranslations } = deps
  const cards = new Map<string, CardEntry>()
  /** Set by {@link stop}: every entry point becomes a no-op. */
  let stopped = false

  /** Send opts that land in the chat's topic when it has one. */
  const topicOpts = (chat: ConversationMessage): { replyInThread?: boolean; replyTo?: string } =>
    chat.threadId !== undefined && chat.rootId !== undefined
      ? { replyInThread: true, replyTo: chat.rootId }
      : {}

  /** Plain-text fallback for a card that could not be created or sent at all. */
  const textFallback = (entry: CardEntry, line: string): void => {
    entry.dead = true
    void channel.send(entry.chat.chatId, { text: line }, topicOpts(entry.chat))
      .catch((error: unknown) => {
        logger.warn(`dsh-feishu: compaction notice failed: ${errorText(error, 'unknown error')}`)
      })
  }

  /** Write one render, serialized behind the card's previous write. */
  const write = (entry: CardEntry): void => {
    entry.chain = entry.chain.then(async () => {
      if (entry.dead) return
      const card = renderCompactionCard(getTranslations(), entry.input)
      const cardId = await entry.cardId
      const messageId = await entry.messageId
      // CardKit instance first: its update API has no edit cap, unlike
      // im.v1.message.patch (关键坑 11).
      if (cardId !== undefined && cardId !== '' && channel.updateCardInstance !== undefined) {
        entry.sequence += 1
        await channel.updateCardInstance(cardId, card, entry.sequence)
        return
      }
      if (messageId !== undefined && channel.updateCard !== undefined) {
        await channel.updateCard(messageId, card)
        return
      }
      // Neither an instance nor a message id: nothing can ever be updated.
      entry.dead = true
    }).catch((error: unknown) => {
      logger.warn(`dsh-feishu: compaction card update failed: ${errorText(error, 'unknown error')}`)
    })
  }

  /**
   * Open a card, from whatever render the caller already has.
   *
   * The FIRST render is what `createCardInstance` sends, so the caller passes
   * the phase it is actually in: a `compaction/end` that failed without a
   * `start` (a resumed session, a lost frame) must not flash a grey "running"
   * card before turning red.
   */
  const open = (chat: ConversationMessage, sessionId: string, first: CompactionRenderInput): void => {
    const opts = topicOpts(chat)
    const render = (): object => renderCompactionCard(getTranslations(), first)
    const useInstance = channel.createCardInstance !== undefined && channel.sendCardByReference !== undefined
    const cardId: Promise<string | undefined> = useInstance
      ? channel.createCardInstance!(render())
        .then(id => (id === '' ? undefined : id))
        .catch((error: unknown) => {
          logger.warn(`dsh-feishu: compaction card create failed: ${errorText(error, 'unknown error')}`)
          return undefined
        })
      : Promise.resolve(undefined)
    const entry: CardEntry = {
      sessionId,
      chat,
      cardId,
      messageId: Promise.resolve(undefined),
      sequence: 0,
      chain: Promise.resolve(),
      dead: false,
      input: first,
    }
    entry.messageId = cardId.then(async (id): Promise<string | undefined> => {
      if (id !== undefined) {
        return channel.sendCardByReference!(chat.chatId, id, opts).then(r => r.messageId)
      }
      return channel.send(chat.chatId, { card: render() }, opts).then(r => r.messageId)
    }).catch((error: unknown) => {
      logger.warn(`dsh-feishu: compaction card send failed: ${errorText(error, 'unknown error')}`)
      textFallback(entry, textLine(getTranslations(), first))
      return undefined
    })
    cards.set(sessionId, entry)
  }

  /** Open the card for a transaction that has just begun. */
  const start = (chat: ConversationMessage, sessionId: string, manual: boolean): void => {
    if (stopped) return
    // A second `start` while one is already open is a new transaction (a retry):
    // the previous card is a historical record and a card entity may only be
    // sent once, so it is replaced rather than reused.
    open(chat, sessionId, { phase: 'start', manual })
  }

  /** `compaction/summary`: the details line and the folded summary. */
  const applySummary = (chat: ConversationMessage, sessionId: string, facts: CompactionFacts): void => {
    if (stopped) return
    const entry = cards.get(sessionId)
    if (entry === undefined) {
      // A summary without a start (a resumed session, a lost frame): open the
      // card already carrying the facts rather than dropping the notice.
      open(chat, sessionId, { phase: 'summary', manual: false, facts })
      return
    }
    entry.input = { ...entry.input, phase: 'summary', facts }
    write(entry)
  }

  /** `compaction/end`: green finish, or red with the reason. */
  const end = (chat: ConversationMessage, sessionId: string, error: string | undefined): void => {
    if (stopped) return
    const entry = cards.get(sessionId)
    if (entry === undefined) {
      // No start and no summary: only worth a card when it FAILED (a silent
      // success would be a card announcing that nothing happened).
      if (error === undefined) return
      open(chat, sessionId, { phase: 'failed', manual: false, error })
      return
    }
    entry.input = error === undefined
      ? { ...entry.input, phase: 'done' }
      : { ...entry.input, phase: 'failed', error }
    write(entry)
    cards.delete(sessionId)
  }

  const stop = (): void => {
    // A late event must not re-open a card: this module is disposed with the
    // listener, but an event already queued can still be delivered.
    stopped = true
    cards.clear()
  }

  return { start, applySummary, end, stop }
}

/**
 * @param input - the render that could not be delivered as a card.
 * @returns the plain-text line that replaces it (key pitfall 40: the report of a
 *   failed write must not be another card, and text is not parsed as markdown).
 */
function textLine(t: Translations, input: CompactionRenderInput): string {
  const title = input.phase === 'failed'
    ? t.compactionCardTitleFailed
    : input.phase === 'start' ? t.compactionCardTitleStart : t.compactionCardTitleDone
  return input.error === undefined ? title : `${title}\n${t.compactionFailedReason(input.error)}`
}
