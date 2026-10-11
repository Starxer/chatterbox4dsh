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
 * {@link COMPACTION_SUMMARY_BYTES} of UTF-8 (a card is limited by JSON size, and
 * Chinese costs three bytes a character), and there is no "send the full summary
 * as a file" button — a summary longer than one card can carry says so in place.
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
import { foldedPanel } from './card-fold.ts'
import { truncateInline } from './text-chunk.ts'
import type { CardInterleave } from './card-interleave.ts'

/**
 * How many UTF-8 bytes of summary the folded panel may carry.
 *
 * A character cap was the wrong unit: a Feishu card is limited by its JSON SIZE
 * (~30KB), and Chinese text costs THREE bytes per character in that JSON. The
 * old cap of 200 characters showed under 2% of a real summary — measured over
 * 182 summaries in 65 session logs: min 1,338, median 11,303, p90 15,478, max
 * 21,127 characters. Measured against the limit with the real card chrome:
 *
 * | summary | card JSON |
 * |---|---|
 * | 5,000 chars | 13.3KB (43%) |
 * | 8,000 chars | 21.0KB (68%) |
 * | 11,303 chars (the real median) | 29.4KB (96%) — at the wall |
 * | 15,478 chars (p90) | 40.1KB — the send would be REFUSED |
 *
 * So 22,000 bytes (≈7,300 Chinese characters, or ~22,000 characters of English)
 * is the most one card can carry with headroom for the rest of the card and for
 * JSON escaping — a 36× increase on the character count the card used to show.
 * Anything longer still truncates, and the card SAYS SO rather than ending in a
 * bare ellipsis: a summary the user cannot see the end of is worth a note.
 */
export const COMPACTION_SUMMARY_BYTES = 22_000

/** UTF-8 length of one code point, without encoding it. */
function utf8Size(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

/**
 * The longest prefix of `text` that fits in `maxBytes` of UTF-8, ending on a
 * GRAPHEME boundary.
 *
 * Two levels of safety, both measured rather than argued (2026-10-12: every byte
 * budget swept over CJK + astral emoji + a ZWJ family + a combining mark — 53
 * budgets):
 *
 * 1. **Never mojibake.** The walk is by CODE POINT (`for…of` + `codePointAt`), so
 *    a cut cannot split a surrogate pair or a multi-byte sequence: zero lone
 *    surrogates, zero UTF-8 round-trip failures, zero over-budget results. A
 *    naive `slice(0, maxBytes)` on the string would have produced garbage.
 * 2. **Not even inside a grapheme cluster.** A code-point cut is valid text but
 *    can still land inside `👨‍👩‍👧` (ZWJ) or `e` + U+0301, which renders as that
 *    cluster's FIRST member alone — 16 of the 53 budgets did. So the cut walks
 *    back to the nearest cluster boundary: a few characters are dropped instead
 *    of showing a half-built emoji where the text stops.
 *
 * @param text - the summary body.
 * @param maxBytes - the byte budget.
 * @returns the character index to cut at (0 when even one character is too big).
 */
export function fitBytes(text: string, maxBytes: number): number {
  let bytes = 0
  let cut = 0
  for (const char of text) {
    const size = utf8Size(char)
    if (bytes + size > maxBytes) break
    bytes += size
    cut += char.length
  }
  return snapToGrapheme(text, cut)
}

/** Walk back to the last grapheme boundary at or before `cut`. */
function snapToGrapheme(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut
  const Segmenter = (Intl as typeof Intl & { Segmenter?: typeof Intl.Segmenter }).Segmenter
  // A runtime without ICU keeps the code-point cut: still valid text, at worst a
  // partial emoji at the very end of the truncation point.
  if (Segmenter === undefined) return cut
  let snapped = 0
  for (const part of new Segmenter('und', { granularity: 'grapheme' }).segment(text)) {
    const next = part.index + part.segment.length
    if (next > cut) break
    snapped = next
  }
  return snapped
}

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
  /**
   * "Another module posted a card into this chat" (`src/card-interleave.ts`):
   * the compact turn card ends its current segment on this notice. Optional.
   */
  interleave?: CardInterleave | undefined
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
      // instead of showing an empty expander. `foldedPanel` adds the chrome and
      // the "已折叠 · 点击展开" hint: a folded summary nobody notices is a
      // summary nobody reads.
      const body = input.facts?.summary
      // `truncateInline`, not a slice: a cut inside `**…**` would leave a literal
      // `**` on the card (关键坑 60). The byte budget gives the character index to
      // hand it, so the safe cut and the byte limit agree.
      const cut = body === undefined ? 0 : fitBytes(body, COMPACTION_SUMMARY_BYTES)
      const content = body === undefined
        ? t.compactionSummaryUnavailable
        : body.length > cut
          ? `${truncateInline(body, cut)}\n\n${t.compactionSummaryCut(cut, body.length)}`
          : body
      elements.push(foldedPanel(t, `**${t.compactionSummaryLabel}**`, [{ tag: 'markdown', content }]))
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
  const { channel, logger, getTranslations, interleave } = deps
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
    }).then((messageId) => {
      // A compaction card lands BETWEEN steps of a running turn, so it ends the
      // compact turn card's segment: what comes after must read BELOW this card.
      if (messageId !== undefined) interleave?.note(chat.chatId)
      return messageId
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
