import { describe, expect, it } from 'vitest'
import { compactCompletionElement, compactCompletionLines, renderCompactCompletionCard, renderDeliveryCard } from '../src/turn-summary.ts'
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

describe('compact completion summary', () => {
  it('keeps the completion marker, wall clock, totals, model and effort', () => {
    const lines = compactCompletionLines(t, { stats: stats(), model: 'deepseek-official/deepseek-flash', reasoningEffort: 'high' })
    expect(lines[0]).toBe(`✅ ${t.turnSummaryDone} · ⏱ 5.0s · 📦 1.5K tokens · 📥 1K → 📤 500`)
    // The route keeps only its model name: the provider prefix is noise here.
    expect(lines[1]).toBe('🧠 deepseek-flash · 💡 high')
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

  it('still marks the turn done when the stats never arrived', () => {
    expect(compactCompletionLines(t, {})).toEqual([`✅ ${t.turnSummaryDone}`])
  })

  it('renders one element with the lines joined, so the footer pays one spacing', () => {
    const element = compactCompletionElement(t, { stats: stats(), model: 'p/m', reasoningEffort: 'high' }) as { tag: string; content: string; text_size?: string }
    expect(element.tag).toBe('markdown')
    expect(element.text_size).toBe('notation')
    expect(element.content.split('\n')).toHaveLength(2)
  })

  it('localizes the completion marker', () => {
    expect(compactCompletionLines(en, {})[0]).toBe(`✅ ${en.turnSummaryDone}`)
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
    expect(card.header.title.content).toBe(t.turnCompleteTitle)
    const body = card.body.elements.map(element => element.content ?? '').join('\n')
    expect(body).toContain(t.turnCompleteExternalTurn(t.autoTurnTriggerName('schedule')))
    expect(body).toContain(`✅ ${t.turnSummaryDone}`)
  })
})
