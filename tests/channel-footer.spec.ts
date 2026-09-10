import { describe, expect, it } from 'vitest'
import { renderFooterCard } from '../src/channel.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('en')

function markdownOf(card: any): string {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    .join('\n')
}

const turnStats = {
  turnStartTime: 0,
  stepCount: 3,
  toolCallCount: 2,
  totalInputTokens: 10,
  totalOutputTokens: 20,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalBilledTokens: 30,
  firstStepTtftMs: 100,
  totalDecodeMs: 500,
  totalDecodeTokens: 20,
  totalStepMs: 600,
  totalToolMs: 300,
  totalTurnMs: 900,
}

describe('renderFooterCard (Turn Complete)', () => {
  it('shows the busy mode (queue) in the footer', () => {
    const card = renderFooterCard(t, { busyMode: 'queue' }, turnStats) as any
    expect(card.header.title.content).toBe('✅ Turn complete')
    expect(markdownOf(card)).toContain('**Enter while busy:** 📥 Queue')
  })

  it('shows the busy mode (steer) in the footer', () => {
    const card = renderFooterCard(t, { busyMode: 'steer' }, turnStats) as any
    expect(markdownOf(card)).toContain('**Enter while busy:** 🎯 Steer')
  })

  it('omits the busy line when busyMode is not provided', () => {
    const card = renderFooterCard(t, { model: 'm' }, turnStats) as any
    expect(markdownOf(card)).not.toContain('Enter while busy')
  })

  it('returns undefined when there is nothing to render', () => {
    expect(renderFooterCard(t, undefined, undefined)).toBeUndefined()
    expect(renderFooterCard(t, {}, undefined)).toBeUndefined()
  })

  it('computes tok/s from the paired decode tokens, not all output tokens', () => {
    const card = renderFooterCard(t, {}, turnStats) as any
    // 20 decode tokens / 0.5s — even though 20 output tokens were reported,
    // the numerator is the paired set, matching the Web UI.
    expect(markdownOf(card)).toContain('🚀 40 tok/s')

    // A step whose tokens could not be paired with decode time must not
    // contribute to throughput at all.
    const unpaired = renderFooterCard(t, {}, {
      ...turnStats,
      totalOutputTokens: 900,
      totalDecodeTokens: 0,
    }) as any
    expect(markdownOf(unpaired)).not.toContain('tok/s')
  })

  it('reports billed total and cache-inclusive input like the Web UI', () => {
    const cached = renderFooterCard(t, {}, {
      ...turnStats,
      totalInputTokens: 15,
      totalCacheReadTokens: 30,
      totalCacheWriteTokens: 5,
      totalBilledTokens: 100,
    }) as any
    const md = markdownOf(cached)
    // Headline total = billed (input + cache + output), matching "consumed".
    expect(md).toContain('📦 100 tokens')
    // in = billed prompt (uncached + cache read + cache write), NOT just uncached.
    expect(md).toContain('📥 50 in · 📤 20 out')
    expect(md).toContain('💾 cache 60%')
  })
})

describe('renderFooterCard deliverables', () => {
  it('lists the paths and descriptions DSH declared through present', () => {
    const card = renderFooterCard(t, {}, {
      ...turnStats,
      deliverables: [
        { path: 'reports/summary.md', description: 'Monthly rollup' },
        { path: 'assets/chart.png' },
      ],
    }) as any
    const md = markdownOf(card)
    expect(md).toContain('📦 **Deliverables** (2)')
    expect(md).toContain('• `reports/summary.md` — Monthly rollup')
    expect(md).toContain('• `assets/chart.png`')
  })

  it('omits the section when nothing was declared', () => {
    expect(markdownOf(renderFooterCard(t, {}, turnStats) as any)).not.toContain('Deliverables')
    expect(markdownOf(renderFooterCard(t, {}, { ...turnStats, deliverables: [] }) as any)).not.toContain('Deliverables')
  })

  it('leads the card, with a divider before the metrics', () => {
    const card = renderFooterCard(t, {}, {
      ...turnStats,
      deliverables: [{ path: 'reports/summary.md', description: 'Monthly rollup' }],
    }) as any
    const elements = card.body.elements
    // First element is the deliverable list, second is the divider that
    // separates it from the turn stats.
    expect(elements[0].tag).toBe('markdown')
    expect(elements[0].content).toContain('📦 **Deliverables**')
    expect(elements[1].tag).toBe('hr')
    // The stats lines follow the divider, not the other way round.
    const firstStat = elements.findIndex((el: any) => el.tag === 'markdown' && el.text_size === 'notation')
    expect(firstStat).toBeGreaterThan(1)
  })

  it('caps the list and reports the remainder', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ path: `out/file-${index}.txt` }))
    const md = markdownOf(renderFooterCard(t, {}, { ...turnStats, deliverables: many }) as any)
    // Headline keeps the real total; the body shows the cap.
    expect(md).toContain('📦 **Deliverables** (9)')
    expect(md).toContain('• `out/file-5.txt`')
    expect(md).not.toContain('file-6.txt')
    expect(md).toContain('…and 3 more')
  })

  it('keeps a backtick inside a path from breaking the surrounding markdown', () => {
    const md = markdownOf(renderFooterCard(t, {}, {
      ...turnStats,
      deliverables: [{ path: 'we`ird/name.txt' }],
    }) as any)
    expect(md).toContain("• `we'ird/name.txt`")
  })
})
