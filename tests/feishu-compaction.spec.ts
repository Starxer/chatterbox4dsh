import { describe, expect, it, vi } from 'vitest'
import {
  COMPACTION_SUMMARY_CAP, createCompactionCards, renderCompactionCard, summaryText,
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

  it('folds the summary with the 2.0 tag, collapsed, and caps its body at 200 characters', () => {
    const long = 'q'.repeat(COMPACTION_SUMMARY_CAP + 50)
    const card: any = renderCompactionCard(t, { phase: 'summary', manual: false, facts: { summary: long } })
    const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
    // `collapsible` (the 1.0 name) is refused by CardKit with `10002 not
    // support tag`; only `collapsible_panel` is accepted (probe 2026-09-29).
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(false)
    expect(panel.header.title.content).toContain(t.compactionSummaryLabel)
    expect(panel.elements[0].content).toBe(`${'q'.repeat(COMPACTION_SUMMARY_CAP)}…`)
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
