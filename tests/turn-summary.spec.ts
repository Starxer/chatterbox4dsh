import { describe, expect, it } from 'vitest'
import {
  appendCompletionFooter, compactCompletionElement, compactCompletionLines, compactCompletionTitle,
  renderCompactCompletionCard, renderDeliveryCard,
} from '../src/turn-summary.ts'
import { translationsFor } from '../src/i18n.ts'
import type { TurnStats } from '../src/feishu-streaming.ts'

const t = translationsFor('zh')
const en = translationsFor('en')

function stats(overrides: Partial<TurnStats> = {}): TurnStats {
  return {
    turnStartTime: 0,
    stepCount: 3,
    toolCallCount: 2,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalBilledTokens: 1500,
    firstStepTtftMs: 120,
    totalDecodeMs: 2000,
    totalDecodeTokens: 500,
    totalStepMs: 3000,
    totalToolMs: 1000,
    totalTurnMs: 5000,
    deliverables: [],
    produced: [],
    ...overrides,
  }
}

/** A minimal answer card, as `channel.ts` builds one before the footer lands. */
function answerCard(): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '回复' }, template: 'blue' },
    body: { elements: [{ tag: 'markdown', content: 'the answer' }] },
  }
}

const elementsOf = (value: object): Array<{ tag?: string; content?: string }> =>
  ((value as { body: { elements: Array<{ tag?: string; content?: string }> } }).body).elements
const titleOf = (value: object): string =>
  ((value as { header: { title: { content: string } } }).header).title.content
const templateOf = (value: object): string => (value as { header: { template: string } }).header.template

describe('compact completion title', () => {
  it('says the turn is done and how long it took — and nothing else', () => {
    expect(compactCompletionTitle(t, { stats: stats() })).toBe(`${t.turnSummaryTitle} · 5.0s`)
  })

  it('carries no turn/step position: the title is a state, not a coordinate', () => {
    const title = compactCompletionTitle(t, { stats: stats() })
    // The card's own position suffix (`· 第 1 轮 · 第 1 步`) is added by the step
    // card renderer for every OTHER card, and skipped for the final one.
    expect(title).not.toContain(t.stepPosition(1, 1))
    expect(title).not.toContain('第 1 轮')
  })

  it('marks a split reply card as the last fragment', () => {
    expect(compactCompletionTitle(t, { stats: stats() }, { part: 2, total: 3 }))
      .toBe(`${t.turnSummaryTitle} · ${t.turnContinuedPart(2, 3)} · 5.0s`)
  })

  it('falls back to the bare marker when the stats never arrived', () => {
    expect(compactCompletionTitle(t, {})).toBe(t.turnSummaryTitle)
  })

  it('never prints a zero-length clock', () => {
    expect(compactCompletionTitle(t, { stats: stats({ totalTurnMs: 0, totalStepMs: 0 }) }))
      .toBe(t.turnSummaryTitle)
  })

  it('localizes the marker', () => {
    expect(compactCompletionTitle(en, { stats: stats() })).toBe(`${en.turnSummaryTitle} · 5.0s`)
  })
})

describe('compact completion summary', () => {
  it('keeps the turn total and the cache hit rate, and drops the in/out split', () => {
    const lines = compactCompletionLines(t, {
      stats: stats({ totalCacheReadTokens: 3000, totalBilledTokens: 4500 }),
      model: 'deepseek-official/deepseek-flash',
      reasoningEffort: 'high',
    })
    // 4000 of the 4500 billed tokens were prompt, 3000 of those from cache.
    expect(lines[0]).toBe('📦 4.5K tokens · ♻️ 75%')
    // The route keeps only its model name: the provider prefix is noise here.
    expect(lines[1]).toBe('🧠 deepseek-flash · 💡 high')
  })

  it('prints the total even when nothing was served from cache', () => {
    expect(compactCompletionLines(t, { stats: stats() })).toEqual(['📦 1.5K tokens'])
  })

  it('does not repeat the clock nor the marker the title carries', () => {
    const lines = compactCompletionLines(t, { stats: stats() }).join('\n')
    expect(lines).not.toContain('5.0s')
    expect(lines).not.toContain('⏱')
    expect(lines).not.toContain(t.turnSummaryTitle)
  })

  it('returns nothing at all when the turn has no numbers to report', () => {
    expect(compactCompletionLines(t, {})).toEqual([])
    expect(compactCompletionElement(t, {})).toBeUndefined()
  })

  it('drops what the process card or the answer card already shows', () => {
    const md = compactCompletionElement(t, { stats: stats(), model: 'p/m', reasoningEffort: 'high' })
    const content = (md as { content: string }).content
    // LLM vs tool split, TTFT, step count and tok/s are all elsewhere (or noise).
    expect(content).not.toContain('LLM')
    expect(content).not.toContain('Tools')
    expect(content).not.toContain('TTFT')
    expect(content).not.toContain('steps')
    expect(content).not.toContain('tok/s')
    expect(content).not.toContain('📂')
    expect(content).not.toContain('Queue')
  })

  it('reports produced files as a count, and only when there are any', () => {
    const withFiles = compactCompletionLines(t, { stats: stats(), producedCount: 3 })
    expect(withFiles[1]).toContain(t.turnProducedLine(3))
    const without = compactCompletionLines(t, { stats: stats(), producedCount: 0 })
    expect(without).toHaveLength(1)
  })

  it('shows the context meter only when the caller passes it (fallback card)', () => {
    const withCtx = compactCompletionLines(t, { stats: stats(), contextWindow: 1000, lastInputTokens: 250 })
    expect(withCtx[1]).toContain('📊 250/1K (25%)')
    const without = compactCompletionLines(t, { stats: stats() })
    expect(without.join('\n')).not.toContain('📊')
  })

  it('renders one element with the lines joined, so the footer pays one spacing', () => {
    const element = compactCompletionElement(t, { stats: stats(), model: 'p/m', reasoningEffort: 'high' }) as { tag: string; content: string; text_size?: string }
    expect(element.tag).toBe('markdown')
    expect(element.text_size).toBe('notation')
    expect(element.content.split('\n')).toHaveLength(2)
  })
})

describe('appendCompletionFooter', () => {
  it('retitles the card, goes green, rules off the body and appends the summary', () => {
    const card = appendCompletionFooter(answerCard(), t, { stats: stats() })
    expect(titleOf(card)).toBe(`${t.turnSummaryTitle} · 5.0s`)
    expect(templateOf(card)).toBe('green')
    const elements = elementsOf(card)
    expect(elements.map(element => element.tag)).toEqual(['markdown', 'hr', 'markdown'])
    expect(elements[0]!.content).toBe('the answer')
    expect(elements[2]!.content).toBe('📦 1.5K tokens')
  })

  it('keeps a split reply position in the title of the LAST fragment', () => {
    const card = appendCompletionFooter(answerCard(), t, { stats: stats() }, { part: { part: 2, total: 2 } })
    expect(titleOf(card)).toBe(`${t.turnSummaryTitle} · ${t.turnContinuedPart(2, 2)} · 5.0s`)
  })

  it('still marks the turn done when there is no summary to append', () => {
    const card = appendCompletionFooter(answerCard(), t, {})
    expect(titleOf(card)).toBe(t.turnSummaryTitle)
    expect(templateOf(card)).toBe('green')
    // No footer lines, so no dangling rule either.
    expect(elementsOf(card).map(element => element.tag)).toEqual(['markdown'])
  })

  it('leaves the original card untouched', () => {
    const source = answerCard()
    appendCompletionFooter(source, t, { stats: stats() })
    expect(titleOf(source)).toBe('回复')
    expect(elementsOf(source)).toHaveLength(1)
  })
})

describe('compact delivery card', () => {
  it('names the file list in its header instead of repeating it in the body', () => {
    const card = renderDeliveryCard(t, [
      { path: 'out/report.pdf', name: 'report.pdf', kind: 'document', size: 2048, auto: true },
    ]) as { header: { title: { content: string } }; body: { elements: Array<{ content?: string }> } }
    expect(card.header.title.content).toBe(t.deliverablesCardTitle)
    const body = card.body.elements.map(element => element.content ?? '').join('\n')
    expect(body).toContain('report.pdf')
    expect(body).not.toContain('交付文件')
  })
})

describe('compact fallback completion card', () => {
  it('leads with the trigger of an auto turn and carries the summary', () => {
    const card = renderCompactCompletionCard(t, {
      stats: stats(),
      model: 'p/m',
      source: t.autoTurnTriggerName('schedule'),
    }) as { header: { title: { content: string } }; body: { elements: Array<{ content?: string }> } }
    // The same title every other compact card that ends a turn carries.
    expect(card.header.title.content).toBe(`${t.turnSummaryTitle} · 5.0s`)
    const body = card.body.elements.map(element => element.content ?? '').join('\n')
    expect(body).toContain(t.turnCompleteExternalTurn(t.autoTurnTriggerName('schedule')))
    expect(body).toContain('📦 1.5K tokens')
  })

  it('never posts an empty body when there is no summary and no trigger', () => {
    const card = renderCompactCompletionCard(t, {}) as { body: { elements: Array<{ content?: string }> } }
    expect(card.body.elements).toHaveLength(1)
    expect(card.body.elements[0]!.content).toBe(t.turnSummaryTitle)
  })
})
