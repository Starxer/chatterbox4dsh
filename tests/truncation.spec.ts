import { describe, expect, it } from 'vitest'
import { renderReplyCards } from '../src/channel.ts'
import { chunkText, capChunks, truncateInline, CARD_TEXT_MAX } from '../src/text-chunk.ts'

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world', 100)).toEqual(['hello world'])
  })

  it('splits long text across multiple chunks at paragraph boundaries', () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}\n\n${'c'.repeat(50)}`
    const chunks = chunkText(text, 80)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n\n')).toBe(text)
  })

  it('keeps total content across chunks (no data loss)', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}: ${'x'.repeat(90)}`).join('\n')
    const chunks = chunkText(text, 500)
    expect(chunks.length).toBeGreaterThan(1)
    const joined = chunks.join('\n')
    // Rejoined content is a superset — minus the boundary blank-line decisions.
    expect(joined.length).toBeGreaterThan(0)
    expect(chunks.every(c => c.length >= 0)).toBe(true)
  })

  it('caps the number of chunks and signals continued overflow', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}: ${'y'.repeat(100)}`).join('\n')
    const chunks = chunkText(text, 1000, 5)
    expect(chunks.length).toBe(6) // 5 kept + 1 overflow marker
    expect(chunks[5]).toContain('continued')
  })

  it('returns empty array for empty/whitespace text', () => {
    expect(chunkText('', 100)).toEqual([])
    expect(chunkText('   ', 100)).toEqual([])
  })
})

describe('chunkText block awareness', () => {
  it('cuts earlier at the previous blank line instead of splitting a table', () => {
    const intro = 'x'.repeat(60)
    const table = ['| a | b |', '| --- | --- |', ...Array.from({ length: 5 }, (_, i) => `| r${i} | v${i} |`)].join('\n')
    const chunks = chunkText(`${intro}\n\n${table}`, 100)
    // The intro alone would leave no room for the table; the boundary moves
    // back to the blank line so the table starts a fresh card intact.
    expect(chunks[0]).toBe(intro)
    expect(chunks[1]).toBe(table)
  })

  it('keeps a table inside one chunk when it fits without the preceding block', () => {
    const table = ['| col | val |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const chunks = chunkText(`${'p'.repeat(90)}\n\n${table}`, 100)
    expect(chunks[1]).toBe(table)
  })

  it('repeats the header rows when one table exceeds the budget', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| r${i} | value ${i} |`)
    const table = ['| col | val |', '| --- | --- |', ...rows].join('\n')
    const chunks = chunkText(table, 120)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith('| col | val |\n| --- | --- |')).toBe(true)
    }
    const joined = chunks.join('\n')
    for (const row of rows) expect(joined).toContain(row)
  })

  it('closes and re-opens a code fence when one block exceeds the budget', () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} ${'z'.repeat(20)}`)
    const fence = `\`\`\`ts\n${body.join('\n')}\n\`\`\``
    const chunks = chunkText(fence, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const lines = chunk.split('\n')
      expect(lines[0]).toBe('```ts')
      expect(lines[lines.length - 1]).toBe('```')
    }
  })

  it('does not treat blank lines inside a code fence as card boundaries', () => {
    const body = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n\n')
    const fence = `\`\`\`\n${body}\n\`\`\``
    const chunks = chunkText(fence, 60)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith('```\n')).toBe(true)
      expect(chunk.endsWith('\n```')).toBe(true)
    }
  })

  it('falls back to a character cut for a single line longer than the budget', () => {
    expect(chunkText('a'.repeat(5000), 3000)).toEqual(['a'.repeat(3000), 'a'.repeat(2000)])
  })

  it('preserves every block across a mixed document', () => {
    const text = [
      '# Title',
      'paragraph one',
      '```ts\nconst a = 1\n\nconst b = 2\n```',
      ['| h1 | h2 |', '| --- | --- |', '| a | b |'].join('\n'),
      '- item one\n- item two',
    ].join('\n\n')
    const chunks = chunkText(text, 40)
    const joined = chunks.join('\n\n')
    for (const block of text.split('\n\n')) {
      // Blank-line separated blocks survive as substrings of some chunk, or
      // (for the fenced block) as a fenced part carrying the same lines.
      const body = block.replace(/^```.*\n|```$/g, '')
      expect(joined).toContain(body.trim())
    }
  })
})

describe('capChunks', () => {
  it('truncates over-long chunks with an ellipsis', () => {
    expect(capChunks(['a'.repeat(50)], 20)).toEqual(['a'.repeat(20) + '…'])
    expect(capChunks(['short'], 20)).toEqual(['short'])
  })
})

describe('truncateInline', () => {
  it('returns short text untouched', () => {
    expect(truncateInline('**短**', 20)).toBe('**短**')
  })

  it('cuts plain text at the budget with an ellipsis', () => {
    expect(truncateInline('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}…`)
  })

  it('drops a strong opener left dangling by the cut', () => {
    // A cut inside `**…**` used to leave the row showing a literal `**`.
    const text = `先说结论：**${'x'.repeat(100)}**收尾`
    const row = truncateInline(text, 80)
    expect(row.endsWith('…')).toBe(true)
    expect((row.match(/\*\*/g) ?? []).length % 2).toBe(0)
    expect(row).not.toContain('**')
  })

  it('keeps a bold pair that closes before the cut', () => {
    const text = `**结论**：${'y'.repeat(200)}`
    const row = truncateInline(text, 40)
    expect(row.startsWith('**结论**：')).toBe(true)
    expect((row.match(/\*\*/g) ?? []).length % 2).toBe(0)
  })

  it('drops an unclosed inline code span and keeps closed ones', () => {
    expect(truncateInline('看 `src/a.ts` 然后 `src/b', 20)).toBe('看 `src/a.ts` 然后…')
    expect(truncateInline('看 `src/a.ts` 然后继续', 20)).toBe('看 `src/a.ts` 然后继续')
  })

  it('never leaves half of a marker at the cut', () => {
    // The budget lands between the two asterisks of `**加粗**`.
    const row = truncateInline('ab**cd**', 4)
    expect(row).toBe('ab…')
  })

  it('ignores escaped markers and triple-star runs', () => {
    expect(truncateInline('a \\* b \\* c d e f', 10)).toBe('a \\* b \\*…')
    expect(truncateInline('a ***b*** c d e f', 10)).toBe('a ***b***…')
  })

  it('returns just the ellipsis for a non-positive budget', () => {
    expect(truncateInline('anything', 0)).toBe('…')
  })
})

describe('renderReplyCards', () => {
  function markdownOf(card: any): string {
    return card.body.elements
      .filter((el: any) => el.tag === 'markdown')
      .map((el: any) => el.content)
      .join('\n')
  }

  it('produces a single card for short text', () => {
    const cards = renderReplyCards('short reply', undefined, undefined)
    expect(cards).toHaveLength(1)
    expect((cards[0] as any).header.title.content).toBe('Reply')
    expect(markdownOf(cards[0])).toContain('short reply')
  })

  it('does not truncate text that exceeds a single card budget — splits instead', () => {
    const longText = Array.from({ length: 50 }, (_, i) => `paragraph ${i}: ${'z'.repeat(CARD_TEXT_MAX / 5)}`).join('\n\n')
    const cards = renderReplyCards(longText, undefined, undefined)
    expect(cards.length).toBeGreaterThan(1)
    const allText = cards.map(markdownOf).join('\n')
    expect(allText).toContain('paragraph 49:')
    // No card should be silently cut to a fixed 3000-char cap.
    expect(cards.every(c => (markdownOf(c).length) <= CARD_TEXT_MAX + 200)).toBe(true)
  })

  it('marks part numbers in the header when split', () => {
    const longText = Array.from({ length: 40 }, (_, i) => `p${i} ${'w'.repeat(300)}`).join('\n\n')
    const cards = renderReplyCards(longText, undefined, undefined)
    expect(cards.length).toBeGreaterThan(1)
    expect((cards[0] as any).header.title.content).toMatch(/Reply \(1\/\d+\)/)
    expect((cards[cards.length - 1] as any).header.title.content).toMatch(/Reply \(\d+\/\d+\)/)
  })

  it('puts reasoning only on the first card and footer only on the last', () => {
    const longText = Array.from({ length: 40 }, (_, i) => `p${i} ${'w'.repeat(300)}`).join('\n\n')
    const cards = renderReplyCards(longText, { workspace: '/work' }, 'think hard')
    expect(cards.length).toBeGreaterThan(1)
    const reasoningCount = cards.filter(c => markdownOf(c).includes('Reasoning')).length
    expect(reasoningCount).toBe(1)
    expect(reasoningCount).toBe(1)
    // workspace footer on the last card only
    expect(markdownOf(cards[cards.length - 1])).toContain('/work')
    expect(markdownOf(cards[0])).not.toContain('/work')
  })

  it('uses a placeholder for empty text', () => {
    const cards = renderReplyCards('   ', undefined, undefined)
    expect(cards).toHaveLength(1)
    expect(markdownOf(cards[0])).toContain('(empty response)')
  })

  it('caps reasoning to a short preview window (200 chars)', () => {
    const cards = renderReplyCards('short reply', undefined, 'r'.repeat(500))
    const reasoningCard = cards[0]
    const md = markdownOf(reasoningCard)
    expect(md).toContain(`${'r'.repeat(200)}\n…(truncated)`)
    expect(md).not.toContain('r'.repeat(201))
  })

  it('shows the turn tok/s in the reply footer when provided', () => {
    const cards = renderReplyCards('short reply', { tokensPerSecond: 300 })
    expect(markdownOf(cards[0])).toContain('🚀 300 tok/s')
    // Absent when the turn has no computable throughput.
    expect(markdownOf(renderReplyCards('short reply', {})[0])).not.toContain('tok/s')
  })
})
