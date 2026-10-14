/**
 * The trimmed completion summary the `compact` level shows.
 *
 * `compact` deliberately has no Turn Complete card: the level exists to keep a
 * turn to the answer plus one process card, and a third card whose body is four
 * lines of metrics works against that. So the summary is folded into the footer
 * of the card that already carries the answer, and the few rows a reader may
 * have to ACT on (the delivered files) move to their own small card.
 *
 * What is kept here is decided by "where else can the reader see it":
 *
 * | fact | shown elsewhere at `compact` | here |
 * |---|---|---|
 * | turn done | nowhere (no Turn Complete card) | ✅ + wall clock |
 * | tools / step timings | the process card's own timeline and header | dropped |
 * | LLM vs tool split, TTFT | nowhere (and low value in a chat) | dropped |
 * | tok/s, context occupancy | the answer card's existing footer | left there |
 * | tokens consumed | nowhere at turn scope | one line |
 * | model + effort | nowhere (`/status` only) | one line |
 * | files produced without `present` | nowhere | count, in that same line |
 * | workspace, busy mode | `/status`, `/busy` | dropped |
 * | trigger of an auto turn | the `⚡ 本回合由…` note already on the card | dropped |
 *
 * The two surfaces that post the answer card (streaming's step card and
 * `channel.ts`'s fallback reply) call {@link compactCompletionLines} /
 * {@link appendCompletionFooter}; a mirrored turn that has no card at all (the
 * text never reached Feishu) falls back to
 * {@link renderCompactCompletionCard}, so a completed turn can never end with
 * nothing saying so.
 *
 * @module @starxer/chatterbox4dsh/turn-summary
 */

import type { Translations } from './i18n.ts'
import type { TurnStats } from './feishu-streaming.ts'
import { renderDeliverableElements, type DeliverRow } from './feishu-deliver.ts'

/** Everything the compact summary can state; every field is optional. */
export interface CompletionFacts {
  /** The turn's aggregated stats. Absent only when streaming never saw it. */
  stats?: TurnStats | undefined
  /** `provider/model`, as the turn's request header named it. */
  model?: string | undefined
  /** Reasoning effort of that request, when the route declared one. */
  reasoningEffort?: string | undefined
  /**
   * Artifacts this turn produced without `present` (`produceCard` ≠ `off`).
   * Rendered as a count; the files themselves are delivery rows.
   */
  producedCount?: number | undefined
  /**
   * Context window facts, for the fallback card only: the answer card's own
   * footer already prints `📊` from the live step state, and passing them here
   * as well would print it twice.
   */
  contextWindow?: number | undefined
  lastInputTokens?: number | undefined
  /**
   * What opened a turn that had no Feishu message (fallback card only): the
   * `⚡`/`💬` attribution the answer card would otherwise carry.
   */
  source?: string | undefined
}

/** `12.3s` / `1m40s` / `850ms` — the footer's own wording, kept local. */
function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

/** `517` / `12.2K` / `1.2M`, the same compaction the other cards use. */
function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

/** Last path segment of a `provider/model` route. */
function shortModel(model: string): string {
  return model.includes('/') ? model.split('/').pop() ?? model : model
}

/**
 * The summary as plain lines, in the order they render.
 *
 * The completion marker and the wall clock are deliberately NOT here: they live
 * in the card TITLE ({@link compactCompletionTitle}), which is what a reader sees
 * first — a title saying `✅ 完成 · 2m14s` and a footer repeating the same clock
 * one line below would be the same number twice on one card.
 *
 * @param t - current translations.
 * @param facts - what the turn produced.
 * @returns zero to two lines; EMPTY when the turn left nothing to report, in
 *          which case the caller keeps whatever footer the card already had.
 */
export function compactCompletionLines(t: Translations, facts: CompletionFacts): string[] {
  const stats = facts.stats
  const head: string[] = []
  if (stats !== undefined) {
    // ONE number for what the turn consumed, plus how much of that prompt the
    // provider served from cache. The in/out split used to ride here beside a
    // total that is exactly their sum, and the `📥` it printed meant the WHOLE
    // prompt while the line below prints `📥` for new input alone — three ways to
    // say one thing, two meanings for one icon (the user's call, 2026-10-14).
    const billedIn = stats.totalInputTokens + stats.totalCacheReadTokens + stats.totalCacheWriteTokens
    const totalBilled = stats.totalBilledTokens > 0 ? stats.totalBilledTokens : billedIn + stats.totalOutputTokens
    if (totalBilled > 0) head.push(`📦 ${formatTokenCount(totalBilled)} tokens`)
    if (billedIn > 0 && stats.totalCacheReadTokens > 0) {
      head.push(`♻️ ${Math.round(stats.totalCacheReadTokens / billedIn * 100)}%`)
    }
  }
  const lines = head.length === 0 ? [] : [head.join(' · ')]

  // Second line: who answered, how hard it thought, what it left behind. Every
  // part is optional, and the line disappears when the turn has none of them.
  const second: string[] = []
  if (facts.model !== undefined && facts.model !== '') second.push(`🧠 ${shortModel(facts.model)}`)
  if (facts.reasoningEffort !== undefined && facts.reasoningEffort !== '') {
    second.push(`💡 ${facts.reasoningEffort}`)
  }
  if (facts.producedCount !== undefined && facts.producedCount > 0) {
    second.push(t.turnProducedLine(facts.producedCount))
  }
  if (facts.contextWindow !== undefined && facts.contextWindow > 0 && facts.lastInputTokens !== undefined && facts.lastInputTokens > 0) {
    const pct = Math.min(100, Math.round(facts.lastInputTokens / facts.contextWindow * 100))
    second.push(`📊 ${formatTokenCount(facts.lastInputTokens)}/${formatTokenCount(facts.contextWindow)} (${pct}%)`)
  }
  if (second.length > 0) lines.push(second.join(' · '))
  return lines
}

/**
 * The title of the card that ends the turn: `✅ 完成 · 2m14s`.
 *
 * The clock is the turn's wall clock and lives HERE instead of in the footer line
 * so one card never prints the same duration twice. It carries no turn/step
 * position (the user's call, 2026-10-14: 完成 plus the time is the whole title).
 * A turn whose stats never arrived gets the bare completion marker: the title is
 * the one thing that has to survive every degraded path, since it is now the only
 * place that says the turn is over.
 *
 * @param t - current translations.
 * @param facts - the turn's completion facts.
 * @param part - when this card is one fragment of a split reply, its position
 *               (`续 2/3`), inserted between the marker and the clock.
 * @returns the title text.
 */
export function compactCompletionTitle(
  t: Translations,
  facts: CompletionFacts,
  part?: { part: number; total: number } | undefined,
): string {
  const segments: string[] = [t.turnSummaryTitle]
  if (part !== undefined) segments.push(t.turnContinuedPart(part.part, part.total))
  const stats = facts.stats
  const ms = stats === undefined ? 0 : stats.totalTurnMs > 0 ? stats.totalTurnMs : stats.totalStepMs
  if (ms > 0) segments.push(formatMs(ms))
  return segments.join(' · ')
}

/**
 * Retitle a card as the turn's final card: the completion title, and a green
 * header. Every other header field is kept.
 */
function withCompletionTitle(card: object, title: string): object {
  const header = (card as { header?: Record<string, unknown> }).header ?? {}
  return { ...card, header: { ...header, title: { tag: 'plain_text', content: title }, template: 'green' } }
}

/** The summary as card elements (one notation line each). */
export function compactCompletionElements(t: Translations, facts: CompletionFacts): object[] {
  return compactCompletionLines(t, facts).map(line => ({
    tag: 'markdown',
    content: line,
    text_size: 'notation',
  }))
}

/**
 * The summary as ONE element, its lines separated by newlines.
 *
 * `compact` uses this: a card element costs its own vertical spacing on both
 * sides (关键坑 58 / 63), so three single-line elements read as three separate
 * blocks where one tightly packed element reads as a footer.
 *
 * @param t - current translations.
 * @param facts - the turn's completion facts.
 * @returns the element to append to a card body, or undefined when the turn left
 *          nothing to report (an empty markdown element is not valid content).
 */
export function compactCompletionElement(t: Translations, facts: CompletionFacts): object | undefined {
  const lines = compactCompletionLines(t, facts)
  return lines.length === 0 ? undefined : { tag: 'markdown', content: lines.join('\n'), text_size: 'notation' }
}

/**
 * Append one element to a card's body.
 *
 * @param card - the card to extend.
 * @param element - the element to append.
 * @returns a new card object; the input is untouched.
 */
export function appendCardElement(card: object, element: object): object {
  const body = (card as { body?: { elements?: object[] } }).body
  if (body === undefined) return card
  const existing = Array.isArray(body.elements) ? body.elements : []
  return { ...card, body: { ...body, elements: [...existing, element] } }
}

/**
 * Turn a card into the turn's FINAL card (`channel.ts`'s fallback reply cards, and
 * the last "continued" card of a split answer): it gains the completion title, a
 * green header, a rule separating body from footer, and the summary lines.
 *
 * Retitling here rather than at each call site is deliberate — the rule of this
 * level is "the card carrying the summary announces completion", and a card that
 * carries the summary while still titled `Reply` is exactly the state the user
 * reported (2026-10-14).
 *
 * @param card - the card to extend.
 * @param t - current translations.
 * @param facts - the turn's completion facts.
 * @param options - `part` when this card is fragment `n` of a split reply.
 * @returns a new card object; the input is untouched.
 */
export function appendCompletionFooter(
  card: object,
  t: Translations,
  facts: CompletionFacts,
  options: { part?: { part: number; total: number } | undefined } = {},
): object {
  const titled = withCompletionTitle(card, compactCompletionTitle(t, facts, options.part))
  const element = compactCompletionElement(t, facts)
  // The rule is the user's request (2026-10-14): the footer has to read as a
  // footer, not as one more sentence of the answer. It only makes sense with a
  // body above it, and only when there is a footer to separate.
  if (element === undefined) return titled
  return appendCardElement(appendCardElement(titled, { tag: 'hr' }), element)
}

/**
 * The one card `compact` posts for files: a titled delivery surface, sent once
 * and never updated.
 *
 * That "never updated" part is the reason it exists as its own card instead of
 * riding the answer card's footer: a card carrying clickable rows stops
 * delivering their callbacks after two or three in-place writes (关键坑 11 /
 * 55), and the answer card is written in place throughout the turn.
 *
 * @param t - current translations.
 * @param rows - the planned delivery rows (media / documents / tap-to-send).
 * @returns the card.
 */
export function renderDeliveryCard(t: Translations, rows: readonly DeliverRow[]): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.deliverablesCardTitle },
      template: 'blue',
    },
    body: {
      vertical_spacing: '4px',
      elements: renderDeliverableElements(rows, t, { omitTitle: true }),
    },
  }
}

/**
 * The fallback completion card: what a `compact` turn posts when no card
 * carried its answer, so nothing on screen would otherwise mark the turn as
 * over (a mirrored turn whose step card never reached Feishu).
 *
 * @param t - current translations.
 * @param facts - the turn's completion facts, `source` included when the turn
 *   did not start from a Feishu message.
 * @returns the card.
 */
export function renderCompactCompletionCard(t: Translations, facts: CompletionFacts): object {
  const elements: object[] = []
  if (facts.source !== undefined && facts.source !== '') {
    elements.push({ tag: 'markdown', content: t.turnCompleteExternalTurn(facts.source), text_size: 'notation' })
  }
  elements.push(...compactCompletionElements(t, facts))
  // A card body with no element at all is not renderable. The completion title
  // already says the turn is over, so the last resort is to repeat it as body
  // text rather than post an empty card.
  if (elements.length === 0) elements.push({ tag: 'markdown', content: t.turnSummaryTitle })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      // Same title as the answer card's final write: at this level "the turn is
      // over" reads the same way on every card that says it.
      title: { tag: 'plain_text', content: compactCompletionTitle(t, facts) },
      template: 'green',
    },
    body: { elements },
  }
}
