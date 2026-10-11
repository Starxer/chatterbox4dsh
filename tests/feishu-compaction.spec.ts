import { describe, expect, it, vi } from 'vitest'
import {
  COMPACTION_SUMMARY_BYTES, createCompactionCards, fitBytes, renderCompactionCard, summaryText,
} from '../src/feishu-compaction.ts'
import { translationsFor } from '../src/i18n.ts'
import type { ConversationMessage } from '../src/conversation.ts'

const t = translationsFor('zh')
const chat = { chatId: 'oc_1', chatType: 'p2p' } as unknown as ConversationMessage
const threaded = { chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', rootId: 'om_root' } as unknown as ConversationMessage

/** Every markdown string on a card, at any depth (the summary is folded). */
function mdOf(card: any): string {
  const out: string[] = []
  const walk = (elements: any[] | undefined): void => {
    for (const el of elements ?? []) {
      if (el.tag === 'markdown' && typeof el.content === 'string') out.push(el.content)
      if (typeof el.header?.title?.content === 'string') out.push(el.header.title.content)
      if (Array.isArray(el.elements)) walk(el.elements)
    }
  }
  walk(card.body.elements)
  return out.join('\n')
}

describe('renderCompactionCard', () => {
  it('opens grey and names the trigger', () => {
    const card: any = renderCompactionCard(t, { phase: 'start', manual: false })
    expect(card.header.title.content).toBe(t.compactionCardTitleStart)
    expect(card.header.template).toBe('grey')
    expect(mdOf(card)).toContain(t.compactionTriggerAuto)
    // Nothing to fold yet, so no panel.
    expect(card.body.elements.some((el: any) => el.tag === 'collapsible_panel')).toBe(false)
  })

  it('distinguishes a manual /compact transaction', () => {
    const start: any = renderCompactionCard(t, { phase: 'start', manual: true })
    expect(mdOf(start)).toContain('/compact')
    const done: any = renderCompactionCard(t, { phase: 'done', manual: true })
    expect(done.header.title.content).toBe(t.compactionCardTitleDoneManual)
  })

  it('puts the metering details ABOVE the folded summary', () => {
    const card: any = renderCompactionCard(t, {
      phase: 'summary',
      manual: false,
      facts: { foldedItems: 609, foldedTokens: 302_000, provider: 'deepseek-official', model: 'deepseek-v4-flash', summary: 'the summary' },
    })
    const elements = card.body.elements as any[]
    const detailIndex = elements.findIndex(el => el.tag === 'markdown' && String(el.content).includes('609'))
    const panelIndex = elements.findIndex(el => el.tag === 'collapsible_panel')
    expect(detailIndex).toBeGreaterThanOrEqual(0)
    expect(panelIndex).toBeGreaterThan(detailIndex)
    expect(String(elements[detailIndex].content)).toContain('302K tokens')
    expect(String(elements[detailIndex].content)).toContain('deepseek-official/deepseek-v4-flash')
    expect(card.header.template).toBe('green')
  })

  it('folds the summary with the 2.0 tag, collapsed, carrying what one card can hold', () => {
    const long = 'q'.repeat(COMPACTION_SUMMARY_BYTES + 50)
    const card: any = renderCompactionCard(t, { phase: 'summary', manual: false, facts: { summary: long } })
    const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
    // `collapsible` (the 1.0 name) is refused by CardKit with `10002 not
    // support tag`; only `collapsible_panel` is accepted (probe 2026-09-29).
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(false)
    // Same visible-fold treatment as the reasoning panel: the header says it is
    // folded and the block is bordered and tinted (card-fold.ts).
    expect(panel.header.title.content).toBe(t.cardFoldTitle(`**${t.compactionSummaryLabel}**`))
    expect(panel.header.title.content).toContain('已折叠')
    expect(panel.header.background_color).toBe('grey-100')
    expect(panel.border).toEqual({ color: 'grey-300', corner_radius: '4px' })
    // ASCII: the budget is bytes, so this carries COMPACTION_SUMMARY_BYTES of them.
    expect(panel.elements[0].content).toBe(`${'q'.repeat(COMPACTION_SUMMARY_BYTES)}…\n\n${t.compactionSummaryCut(COMPACTION_SUMMARY_BYTES, long.length)}`)
  })

  // Measured 2026-10-12 over 182 real summaries (65 session logs): min 1,338,
  // median 11,303, p90 15,478, max 21,127 characters — the old 200-character cap
  // showed under 2% of a typical one. A card is limited by its JSON SIZE (~30KB),
  // and Chinese costs three bytes per character there, so the cap is a byte
  // budget now: 22KB is the most one card can carry with headroom.
  it('carries a summary that used to be cut off after 200 characters', () => {
    const summary = '这一段是摘要正文，用来把卡片撑到真实规模。'.repeat(200).slice(0, 5_000)
    const card: any = renderCompactionCard(t, { phase: 'summary', manual: false, facts: { summary } })
    const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
    expect(panel.elements[0].content).toBe(summary)
  })

  it('keeps the card inside the ~30KB JSON limit even for the longest real summary', () => {
    // 21,127 characters is the longest summary measured across 65 session logs.
    const summary = '摘要正文'.repeat(6_000).slice(0, 21_127)
    const card: any = renderCompactionCard(t, { phase: 'summary', manual: false, facts: { foldedItems: 42, foldedTokens: 1_000, summary } })
    const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8')
    expect(bytes).toBeLessThan(30 * 1024)
    // …and it still says how much of the whole is on the card.
    const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
    expect(String(panel.elements[0].content)).toContain(t.compactionSummaryCut(fitBytes(summary, COMPACTION_SUMMARY_BYTES), 21_127))
  })

  it('counts bytes, not characters, so English fits more than Chinese', () => {
    const english = 'detail text '.repeat(1_000).slice(0, 20_000)
    const card: any = renderCompactionCard(t, { phase: 'summary', manual: false, facts: { summary: english } })
    const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
    expect(panel.elements[0].content).toBe(english)
  })

  // The user asked the right question about a byte budget: "can this produce
  // mojibake?". Swept over every byte budget of mixed text (2026-10-12): not one
  // lone surrogate, not one UTF-8 round-trip failure, never over budget — and no
  // cut inside a grapheme cluster either.
  it('never cuts mojibake, at any byte budget', () => {
    const text = '中文摘要😀👨‍👩‍👧e\u0301一𠀀二結束'
    const loneSurrogate = (value: string): boolean => {
      for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i)
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = value.charCodeAt(i + 1)
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true
          i += 1
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return true
      }
      return false
    }
    for (let budget = 1; budget <= Buffer.byteLength(text, 'utf8'); budget++) {
      const prefix = text.slice(0, fitBytes(text, budget))
      expect(loneSurrogate(prefix), `budget ${budget}`).toBe(false)
      expect(Buffer.from(prefix, 'utf8').toString('utf8')).toBe(prefix)
      expect(Buffer.byteLength(prefix, 'utf8')).toBeLessThanOrEqual(budget)
    }
  })

  it('stops before a grapheme cluster rather than showing half of it', () => {
    const family = '👨‍👩‍👧'
    const text = `中文摘要😀${family}`
    const cut = fitBytes(text, 20)                 // the budget lands inside the family
    expect(text.slice(0, cut)).toBe('中文摘要😀')   // …so the whole cluster is dropped
    // A cut that lands on a boundary keeps it.
    expect(text.slice(0, fitBytes(text, 16))).toBe('中文摘要😀')
  })

  it('cuts at a code point boundary even without a grapheme segmenter', () => {
    // The fallback path is what a runtime without ICU gets; it must still be
    // valid text. Asserted directly on the code-point cut by hiding Segmenter.
    const original = (Intl as any).Segmenter
    try {
      delete (Intl as any).Segmenter
      const emoji = '🀄'.repeat(100)      // 4 UTF-8 bytes each
      // `fitBytes` returns a SLICE index (UTF-16 units): two emoji are 4 units.
      expect(fitBytes(emoji, 9)).toBe(4)  // two code points fit, the third does not
      expect(emoji.slice(0, fitBytes(emoji, 9))).toBe('🀄🀄')
    } finally {
      ;(Intl as any).Segmenter = original
    }
  })

  it('says so when there is no summary at all (a prune)', () => {
    const card: any = renderCompactionCard(t, { phase: 'done', manual: false, facts: { foldedItems: 1, foldedTokens: 3032 } })
    const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
    expect(panel.elements[0].content).toBe(t.compactionSummaryUnavailable)
    expect(mdOf(card)).toContain('3K tokens')
  })

  it('paints a failure red, quotes the reason and states that nothing was replaced', () => {
    const card: any = renderCompactionCard(t, { phase: 'failed', manual: false, error: 'summary backend 500' })
    expect(card.header.title.content).toBe(t.compactionCardTitleFailed)
    expect(card.header.template).toBe('red')
    const md = mdOf(card)
    expect(md).toContain('summary backend 500')
    expect(md).toContain(t.compactionNoSummary)
    // A failed attempt never produced a summary, so no expander promises one.
    expect(card.body.elements.some((el: any) => el.tag === 'collapsible_panel')).toBe(false)
  })

  it('keeps the details line on a failure that did report metering facts', () => {
    const card: any = renderCompactionCard(t, {
      phase: 'failed', manual: false, error: 'boom', facts: { foldedItems: 12, foldedTokens: 900 },
    })
    expect(mdOf(card)).toContain('12 条历史记录')
  })
})

describe('summaryText', () => {
  it('joins text blocks and ignores everything else', () => {
    expect(summaryText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })

  it('returns undefined for empty or unusable input', () => {
    expect(summaryText([])).toBeUndefined()
    expect(summaryText([{ type: 'text', text: '  ' }])).toBeUndefined()
    expect(summaryText(undefined)).toBeUndefined()
    expect(summaryText([1, 'x'])).toBeUndefined()
  })
})

describe('createCompactionCards', () => {
  function harness(options: { instance?: boolean; failSend?: boolean } = {}) {
    const channel = {
      // `failSend` breaks the CARD transports only: the text fallback must still
      // be able to land, which is the whole point of having one.
      send: vi.fn(async (_to: string, input: { card?: object; text?: string }) =>
        input.card !== undefined && options.failSend
          ? Promise.reject(new Error('card send down'))
          : { messageId: 'm-plain' }),
      updateCard: vi.fn(async () => undefined),
      ...(options.instance === false ? {} : {
        createCardInstance: vi.fn(async () => 'card-1'),
        sendCardByReference: vi.fn(async () => (options.failSend
          ? Promise.reject(new Error('reference send down'))
          : { messageId: 'm-ref' })),
        updateCardInstance: vi.fn(async () => undefined),
      }),
    }
    const logger = { warn: vi.fn(), error: vi.fn() }
    const cards = createCompactionCards({ channel: channel as any, logger, getTranslations: () => t })
    return { channel, logger, cards }
  }
  const tick = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

  it('writes start → summary → end into ONE card instance, in sequence', async () => {
    const { channel, cards } = harness()
    cards.start(chat, 's-1', false)
    await tick(0)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    expect(channel.sendCardByReference).toHaveBeenCalledWith('oc_1', 'card-1', {})

    cards.applySummary(chat, 's-1', { foldedItems: 3, summary: 'sum' })
    await tick(0)
    cards.end(chat, 's-1', undefined)
    await tick(0)

    // Every write is an instance update with a strictly increasing sequence —
    // never a second card.
    const sequences = (channel.updateCardInstance as any).mock.calls.map((call: any[]) => call[2])
    expect(sequences).toEqual([1, 2])
    expect(channel.sendCardByReference).toHaveBeenCalledTimes(1)
    expect(channel.updateCard).not.toHaveBeenCalled()
  })

  it('keeps the card inside the chat’s topic', async () => {
    const { channel, cards } = harness()
    cards.start(threaded, 's-1', false)
    await tick(0)
    expect(channel.sendCardByReference).toHaveBeenCalledWith('oc_1', 'card-1', { replyInThread: true, replyTo: 'om_root' })
  })

  it('falls back to a plain send when there is no CardKit instance path', async () => {
    const { channel, cards } = harness({ instance: false })
    cards.start(chat, 's-1', false)
    cards.applySummary(chat, 's-1', { summary: 'sum' })
    await tick(0)
    expect(channel.createCardInstance).toBeUndefined()
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.updateCard).toHaveBeenCalledTimes(1)
  })

  it('answers in TEXT when no card could be sent at all', async () => {
    // Key pitfall 40: a failure whose report is another card can fail the same
    // way, and a text message is not parsed as markdown, so it cannot be
    // rejected for image/link syntax either.
    const { channel, logger, cards } = harness({ failSend: true })
    cards.start(chat, 's-1', false)
    await tick(0)
    expect(logger.warn).toHaveBeenCalled()
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect((channel.send as any).mock.calls[0]![1].text).toContain(t.compactionCardTitleStart)
  })

  it('opens a card for a failure that arrived with neither start nor summary', async () => {
    const { channel, cards } = harness()
    cards.end(chat, 's-1', 'late failure')
    await tick(0)
    // The failure render is what the card is CREATED with: no grey "running"
    // flash for a transaction that was already over when we first saw it.
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    expect((channel.createCardInstance as any).mock.calls[0]![0].header.template).toBe('red')
    expect((channel.createCardInstance as any).mock.calls[0]![0].header.title.content)
      .toBe(t.compactionCardTitleFailed)
  })

  it('stays silent for an end with no start when nothing failed', async () => {
    const { channel, cards } = harness()
    cards.end(chat, 's-1', undefined)
    await tick(0)
    expect(channel.createCardInstance).not.toHaveBeenCalled()
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('drops buffered cards on stop()', async () => {
    const { channel, cards } = harness()
    cards.start(chat, 's-1', false)
    await tick(0)
    cards.stop()
    cards.applySummary(chat, 's-1', { summary: 'after stop' })
    await tick(0)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    expect(channel.updateCardInstance).not.toHaveBeenCalled()
  })
})
