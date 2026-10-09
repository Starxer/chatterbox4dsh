import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROGRESS_ELEMENT_SPACING, PROGRESS_MAX_FOLDED, PROGRESS_MAX_ROWS, PROGRESS_NOTE_MAX, PROGRESS_WRITE_GAP_MS,
  condenseStepNote, createProgressCards, formatProgressMs, renderProgressCard, type ProgressFacts,
} from '../src/feishu-progress.ts'
import { translationsFor } from '../src/i18n.ts'
import type { ConversationMessage } from '../src/conversation.ts'

const t = translationsFor('zh')
const chat = { chatId: 'oc_1', chatType: 'p2p' } as unknown as ConversationMessage
const threaded = { chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', rootId: 'om_root' } as unknown as ConversationMessage

/** Every markdown string on the card, at any depth (folded rows included). */
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

/** Visible markdown lines (inside the folded panel, when there is one). */
function visibleLines(card: any): string[] {
  const elements = card.body.elements as any[]
  const panel = elements.find(el => el.tag === 'collapsible_panel')
  const visible = panel === undefined ? elements : elements.slice(elements.indexOf(panel) + 1)
  return visible.filter(el => el.tag === 'markdown').map(el => el.content)
}

/** Every tag in the card JSON, at any depth. */
function tagsOf(card: any): string[] {
  const out: string[] = []
  const walk = (value: any): void => {
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (value === null || typeof value !== 'object') return
    if (typeof value.tag === 'string') out.push(value.tag)
    Object.values(value).forEach(walk)
  }
  walk(card)
  return out
}

/** Facts for a single step holding the given tools. */
function facts(overrides: Partial<ProgressFacts> = {}): ProgressFacts {
  return {
    steps: [{ step: 1, startedAt: 0, endedAt: 5_000, tools: [{ name: 'read', startedAt: 100, elapsed: 400 }] }],
    calls: 1,
    failed: 0,
    turnStart: 0,
    endedAt: 5_000,
    now: 5_000,
    failedTurn: false,
    ...overrides,
  }
}

describe('formatProgressMs', () => {
  it('stays in ms below a second, then switches to seconds and minutes', () => {
    expect(formatProgressMs(400)).toBe('400ms')
    expect(formatProgressMs(1_250)).toBe('1.3s')
    expect(formatProgressMs(65_000)).toBe('1m05s')
  })
})

describe('condenseStepNote', () => {
  it('keeps the first non-empty line, squeezing whitespace runs', () => {
    expect(condenseStepNote('\n\n  我先看一下   `src/a.ts`\n第二行不进来')).toBe('我先看一下 `src/a.ts`')
  })

  it('caps the row and marks the cut', () => {
    const long = 'x'.repeat(PROGRESS_NOTE_MAX + 30)
    expect(condenseStepNote(long)).toBe(`${'x'.repeat(PROGRESS_NOTE_MAX)}…`)
  })

  it('returns an empty string for whitespace-only text', () => {
    expect(condenseStepNote('   \n\n ')).toBe('')
  })
})

describe('renderProgressCard', () => {
  it('opens grey while the turn runs and names the step and its tool', () => {
    const card: any = renderProgressCard(t, facts({ endedAt: undefined, now: 5_000 }))
    expect(card.header.template).toBe('grey')
    expect(card.header.title.content).toBe(t.turnCardTitleRunning(1, '5.0s'))
    const md = mdOf(card)
    expect(md).toContain(t.turnCardStep(1, '5.0s'))
    expect(md).toContain(t.turnCardToolDone('`read`', '400ms'))
  })

  it('freezes green with the totals once the turn ended', () => {
    const card: any = renderProgressCard(t, facts())
    expect(card.header.template).toBe('green')
    expect(card.header.title.content).toBe(t.turnCardTitleDone(1, 0, '5.0s'))
  })

  it('freezes red when the turn failed (the reason rides the failure card)', () => {
    const card: any = renderProgressCard(t, facts({ failedTurn: true }))
    expect(card.header.template).toBe('red')
    expect(card.header.title.content).toBe(t.turnCardTitleFailed(1, '5.0s'))
  })

  it('merges consecutive same-named calls into one row with a summed duration', () => {
    const card: any = renderProgressCard(t, facts({
      steps: [{
        step: 2,
        startedAt: 0,
        endedAt: 3_000,
        tools: [
          { name: 'read', startedAt: 0, elapsed: 400 },
          { name: 'read', startedAt: 400, elapsed: 800 },
          { name: 'bash', startedAt: 1_200, elapsed: 100 },
        ],
      }],
      calls: 3,
      now: 3_000,
    }))
    const md = mdOf(card)
    expect(md).toContain(t.turnCardToolDone('`read` ×2', '1.2s'))
    expect(md).toContain(t.turnCardToolDone('`bash`', '100ms'))
  })

  it('marks a running call with its own elapsed clock and a failure with ❌', () => {
    const card: any = renderProgressCard(t, facts({
      steps: [{
        step: 1,
        startedAt: 0,
        tools: [
          { name: 'bash', startedAt: 1_000 },
          { name: 'edit', startedAt: 0, elapsed: 50, isError: true },
        ],
      }],
      calls: 2,
      failed: 1,
      turnStart: 0,
      now: 3_400,
    }))
    const md = mdOf(card)
    expect(md).toContain(t.turnCardToolRunning('`bash`', '2.4s'))
    expect(md).toContain(t.turnCardToolFailed('`edit`', '50ms'))
    // The section header of a step that is still running carries the same `…`.
    expect(md).toContain(t.turnCardStep(1, '3.4s…'))
  })

  it('shows the newest rows and folds the older ones, keeping the step headers', () => {
    const steps = [0, 1, 2].map(i => ({
      step: i + 1,
      startedAt: 0,
      endedAt: 100,
      tools: Array.from({ length: 20 }, (_, j) => ({ name: `tool${i}${j}`, startedAt: 0, elapsed: 10 })),
    }))
    const card: any = renderProgressCard(t, { steps, calls: 60, failed: 0, turnStart: 0, now: 200, failedTurn: false })
    const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
    expect(panel).toBeDefined()
    expect(panel.expanded).toBe(false)
    // Whole steps stay together, so 21 newest lines stay visible and the other
    // 42 (two complete steps) fold away — and the panel says so honestly.
    expect(panel.header.title.content).toBe(t.cardFoldTitle(t.turnCardOlderRows(42)))
    // The visible part never starts mid-step: the first line is a section header.
    const visible = visibleLines(card)
    expect(visible.length).toBeLessThanOrEqual(PROGRESS_MAX_ROWS)
    expect(visible[0]).toBe(t.turnCardStep(3, '100ms'))
  })

  it('caps the folded body so a huge turn cannot blow the card size', () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({
      step: i + 1,
      startedAt: 0,
      endedAt: 100,
      tools: Array.from({ length: 30 }, (_, j) => ({ name: `t${i}_${j}`, startedAt: 0, elapsed: 10 })),
    }))
    const card: any = renderProgressCard(t, { steps, calls: 180, failed: 0, turnStart: 0, now: 200, failedTurn: false })
    const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
    const body = panel.elements[0].content as string
    expect(body.startsWith('…\n')).toBe(true)
    expect(body.split('\n').length).toBeLessThanOrEqual(PROGRESS_MAX_FOLDED + 1)
  })

  it('carries no button and no tappable row (the card must stay updatable)', () => {    // 关键坑 11: a card carrying buttons stops delivering callbacks after 2-3
    // in-place updates; 关键坑 55: a tapped `interactive_container` row stops
    // delivering row callbacks. This card's whole model is "one message, many
    // updates", so anything tappable would break it.
    const card: any = renderProgressCard(t, facts({ failedTurn: true }))
    const tags = tagsOf(card)
    expect(tags).not.toContain('button')
    expect(tags).not.toContain('interactive_container')
    expect(tags).not.toContain('form')
    expect(tags).not.toContain('checker')
  })

  it("renders a step's narration as one row under that step's header", () => {
    const card: any = renderProgressCard(t, facts({
      steps: [{
        step: 2,
        startedAt: 0,
        endedAt: 3_000,
        tools: [{ name: 'read', startedAt: 1_000, elapsed: 200 }],
        note: '我先看一下流式卡片那段代码',
      }],
      calls: 1,
      now: 3_000,
    }))
    const lines = visibleLines(card)
    expect(lines).toEqual([
      t.turnCardStep(2, '3.0s'),
      t.turnCardStepNote('我先看一下流式卡片那段代码'),
      t.turnCardToolDone('`read`', '200ms'),
    ])
  })

  it('omits the narration row for a step that said nothing', () => {
    const card: any = renderProgressCard(t, facts())
    expect(mdOf(card)).not.toContain('💬')
  })

  it('keeps the rows close together (measured spacing, not the loose default)', () => {
    const card: any = renderProgressCard(t, facts())
    expect(card.body.vertical_spacing).toBe(PROGRESS_ELEMENT_SPACING)
  })
})

describe('createProgressCards', () => {
  function harness(options: { failCardSend?: boolean } = {}) {
    const channel = {
      send: vi.fn(async (_to: string, input: { card?: object; text?: string }) =>
        input.card !== undefined && options.failCardSend
          ? Promise.reject(new Error('card send down'))
          : { messageId: 'm-plain' }),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(async () => (options.failCardSend
        ? Promise.reject(new Error('reference send down'))
        : { messageId: 'm-ref' })),
      updateCardInstance: vi.fn(async () => undefined),
    }
    const logger = { warn: vi.fn() }
    const cards = createProgressCards({ channel: channel as any, logger, getTranslations: () => t })
    return { channel, logger, cards }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('carries a step narration into the FIRST render of the card', async () => {
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    // The narration precedes the tool call that opens the card, as it does in a
    // real step (`assistant/message` → `tool/call`).
    cards.stepNote('s1', 1, '我先读一下 streaming 那段', 50)
    await Promise.resolve()
    expect(channel.createCardInstance).not.toHaveBeenCalled()
    cards.toolStarted('s1', 'read', 'c1', 100)
    await vi.waitFor(() => expect(channel.sendCardByReference).toHaveBeenCalledTimes(1))
    const card = (channel.createCardInstance.mock.calls[0] as any)[0]
    expect(mdOf(card)).toContain(t.turnCardStepNote('我先读一下 streaming 那段'))
  })

  it('updates the narration row in place and never repeats an unchanged one', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.sendCardByReference).toHaveBeenCalledTimes(1)
    cards.stepNote('s1', 1, '第一句', 100)
    cards.stepNote('s1', 1, '第一句', 120)
    cards.stepNote('s1', 1, '第二句', 140)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    const card = (channel.updateCardInstance.mock.calls[0] as any)[1]
    expect(mdOf(card)).toContain(t.turnCardStepNote('第二句'))
    expect(mdOf(card)).not.toContain('第一句')
  })

  it('opens the card lazily on the first tool call, not on step/start', async () => {
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    await Promise.resolve()
    expect(channel.createCardInstance).not.toHaveBeenCalled()
    cards.toolStarted('s1', 'read', 'c1', 100)
    await vi.waitFor(() => expect(channel.sendCardByReference).toHaveBeenCalledTimes(1))
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    const card = (channel.createCardInstance.mock.calls[0] as any)[0]
    expect(card.header.title.content).toBe(t.turnCardTitleRunning(1, '100ms'))
  })

  it('opens a NEW card for the next turn and never reuses the entity', async () => {
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.waitFor(() => expect(channel.createCardInstance).toHaveBeenCalledTimes(1))
    await cards.finish('s1', 1_000, false)
    cards.beginTurn(chat, 's1', 2_000)
    cards.toolStarted('s1', 'bash', 'c2', 2_010)
    await vi.waitFor(() => expect(channel.createCardInstance).toHaveBeenCalledTimes(2))
  })

  it('sends no card at all for a turn that calls no tool', async () => {
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.stepEnded('s1', 900)
    await cards.finish('s1', 1_000, false)
    expect(channel.send).not.toHaveBeenCalled()
    expect(channel.createCardInstance).not.toHaveBeenCalled()
  })

  it('coalesces a burst of tool events into one in-place update', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.sendCardByReference).toHaveBeenCalledTimes(1)
    cards.toolFinished('s1', 'c1', 400, false, 500)
    cards.toolStarted('s1', 'bash', 'c2', 600)
    cards.toolFinished('s1', 'c2', 100, true, 700)
    expect(channel.updateCardInstance).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    // Nothing changed since, so no second write appears out of nowhere.
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS * 3)
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    // The single write carried the LATEST state, not the first event.
    const card = (channel.updateCardInstance.mock.calls[0] as any)[1]
    expect(card.header.title.content).toBe(t.turnCardTitleRunning(2, '700ms'))
    expect(mdOf(card)).toContain(t.turnCardToolFailed('`bash`', '100ms'))
    // CardKit needs a monotonically increasing sequence per card instance.
    expect((channel.updateCardInstance.mock.calls[0] as any)[2]).toBe(1)
  })

  it('keeps one write in flight and renders the newest state afterwards', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    let release!: () => void
    channel.updateCardInstance.mockImplementationOnce(
      (() => new Promise<void>((resolve) => { release = resolve })) as any,
    )
    cards.beginTurn(chat, 's1', 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.advanceTimersByTimeAsync(0)
    cards.toolFinished('s1', 'c1', 400, false, 500)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    // A change while that write is in flight is remembered, not queued blindly.
    cards.toolStarted('s1', 'bash', 'c2', 600)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS * 2)
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(2)
    const card = (channel.updateCardInstance.mock.calls[1] as any)[1]
    expect(mdOf(card)).toContain(t.turnCardToolRunning('`bash`', '0ms'))
  })

  it('finishes with a green render and ignores anything after turn/end', async () => {
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.waitFor(() => expect(channel.sendCardByReference).toHaveBeenCalledTimes(1))
    await cards.finish('s1', 1_000, false)
    const card = (channel.updateCardInstance.mock.calls.at(-1) as any)[1]
    expect(card.header.template).toBe('green')
    expect(card.header.title.content).toBe(t.turnCardTitleDone(1, 0, '1.0s'))
    cards.toolStarted('s1', 'bash', 'c2', 1_100)
    await Promise.resolve()
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
  })

  it('sends ONE plain-text summary when the card never made it', async () => {
    const { channel, cards } = harness({ failCardSend: true })
    cards.beginTurn(chat, 's1', 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    cards.toolFinished('s1', 'c1', 400, false, 500)
    await cards.finish('s1', 1_000, false)
    const texts = channel.send.mock.calls.filter(call => (call[1] as any).text !== undefined)
    expect(texts).toHaveLength(1)
    const body = (texts[0] as any)[1].text as string
    expect(body).toContain(t.turnCardTitleDone(1, 0, '1.0s'))
    expect(body).toContain(t.turnCardToolDone('`read`', '400ms'))
  })

  it('keeps every write in the chat topic when the chat has one', async () => {
    const { channel, cards } = harness()
    cards.beginTurn(threaded, 's1', 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.waitFor(() => expect(channel.sendCardByReference).toHaveBeenCalledTimes(1))
    expect((channel.sendCardByReference.mock.calls[0] as any)[2]).toEqual({ replyInThread: true, replyTo: 'om_root' })
  })

  it('stops writing after stop()', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.advanceTimersByTimeAsync(0)
    cards.toolFinished('s1', 'c1', 400, false, 500)
    cards.stop()
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS * 3)
    expect(channel.updateCardInstance).not.toHaveBeenCalled()
  })
})
