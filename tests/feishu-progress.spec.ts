import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROGRESS_ELEMENT_SPACING, PROGRESS_MAX_FOLDED, PROGRESS_MAX_ROWS, PROGRESS_MAX_STEPS, PROGRESS_NOTE_MAX,
  PROGRESS_RUNNING_TICK_MS, PROGRESS_WRITE_GAP_MS,
  PROGRESS_QUOTE_MARKER, PROGRESS_TOOL_MARKER,
  condenseStepNote, createProgressCards, formatProgressMs, inlineMarkupBalanced, renderProgressCard, type ProgressFacts,
} from '../src/feishu-progress.ts'
import { createCardInterleave, type CardInterleave } from '../src/card-interleave.ts'
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

/**
 * The visible ROWS, flattened: since 2026-10-11 a step's rows share ONE markdown
 * element (each element pays `vertical_spacing`, 关键坑 58), so an element's
 * content may hold several lines.
 */
function visibleLines(card: any): string[] {
  const elements = card.body.elements as any[]
  const panel = elements.find(el => el.tag === 'collapsible_panel')
  const visible = panel === undefined ? elements : elements.slice(elements.indexOf(panel) + 1)
  return visible.filter(el => el.tag === 'markdown').flatMap(el => String(el.content).split('\n'))
}

/** The visible markdown ELEMENTS (not rows), which is what the spacing pays for. */
function visibleElements(card: any): string[] {
  const elements = card.body.elements as any[]
  const panel = elements.find(el => el.tag === 'collapsible_panel')
  const visible = panel === undefined ? elements : elements.slice(elements.indexOf(panel) + 1)
  return visible.filter(el => el.tag === 'markdown').map(el => String(el.content))
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

  it('never leaves a bold opener dangling at the cut', () => {
    // The cut used to land inside `**…**`, so the row rendered a literal `**`.
    const long = `先说结论：**${'x'.repeat(PROGRESS_NOTE_MAX)}**收尾`
    const row = condenseStepNote(long)
    expect(row.endsWith('…')).toBe(true)
    expect(row).not.toContain('**')
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
      `${PROGRESS_QUOTE_MARKER}${t.turnCardStepNote('我先看一下流式卡片那段代码')}`,
      `${PROGRESS_TOOL_MARKER}${t.turnCardToolDone('`read`', '200ms')}`,
    ])
  })

  it('omits the narration row for a step that said nothing', () => {
    const card: any = renderProgressCard(t, facts())
    expect(mdOf(card)).not.toContain('💬')
  })

  it('renders injection notices as rows of the step that claimed them', () => {
    const card: any = renderProgressCard(t, facts({
      steps: [{
        step: 1,
        startedAt: 0,
        endedAt: 2_000,
        tools: [{ name: 'bash', startedAt: 500, elapsed: 100 }],
        injections: ['📥 注入上下文 · AGENTS.md（已更新）'],
        note: '我看一下',
      }],
      calls: 1,
      now: 2_000,
    }))
    // Preamble first (the notice is why the request carries what it carries),
    // then the narration, then the tool rows.
    expect(visibleLines(card)).toEqual([
      t.turnCardStep(1, '2.0s'),
      '📥 注入上下文 · AGENTS.md（已更新）',
      `${PROGRESS_QUOTE_MARKER}${t.turnCardStepNote('我看一下')}`,
      `${PROGRESS_TOOL_MARKER}${t.turnCardToolDone('`bash`', '100ms')}`,
    ])
  })

  it('keeps only the newest three STEPS visible and folds the older ones', () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      step: i + 1,
      startedAt: 0,
      endedAt: 100,
      tools: [
        { name: `t${i}a`, startedAt: 0, elapsed: 10 },
        { name: `t${i}b`, startedAt: 0, elapsed: 10 },
      ],
    }))
    const card: any = renderProgressCard(t, { steps, calls: 16, failed: 0, turnStart: 0, now: 200, failedTurn: false })
    const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
    // The window counts STEPS (2026-10-11): steps 6-8 stay, steps 1-5 fold away
    // with their headers — 5 headers + 10 rows.
    expect(panel.header.title.content).toBe(t.cardFoldTitle(t.turnCardOlderRows(15)))
    const visible = visibleLines(card)
    expect(visible[0]).toBe(t.turnCardStep(6, '100ms'))
    const titles = [6, 7, 8].map(n => t.turnCardStep(n, '100ms'))
    expect(visible.filter(line => titles.includes(line))).toHaveLength(3)
  })

  it('renders only the rows of this segment when one was cut short', () => {
    const card: any = renderProgressCard(t, facts({
      steps: [
        { step: 1, startedAt: 0, endedAt: 100, tools: [{ name: 'old', startedAt: 0, elapsed: 10 }] },
        { step: 2, startedAt: 100, endedAt: 200, tools: [{ name: 'fresh', startedAt: 100, elapsed: 10 }] },
      ],
      calls: 2,
      now: 200,
      endedAt: 200,
      segmentFrom: 1,
    }))
    const md = mdOf(card)
    expect(md).not.toContain('`old`')
    expect(md).toContain('`fresh`')
    // The counters stay turn-wide: the title counts the whole turn's calls.
    expect(card.header.title.content).toBe(t.turnCardTitleDone(2, 0, '200ms'))
  })

  it('keeps the rows close together (measured spacing, not the loose default)', () => {
    const card: any = renderProgressCard(t, facts())
    expect(card.body.vertical_spacing).toBe(PROGRESS_ELEMENT_SPACING)
  })

  // 2026-10-11: every element is its own block and pays `vertical_spacing` on
  // both sides (关键坑 58), so a step's rows became ONE element. A measured turn
  // spent 64px of pure spacing on 327 characters of text.
  describe('one element per step (②)', () => {
    it('puts a step header and all of its rows in a single element', () => {
      const card: any = renderProgressCard(t, facts({
        steps: [{
          step: 3,
          startedAt: 0,
          endedAt: 3_000,
          tools: [
            { name: 'read', startedAt: 0, elapsed: 100 },
            { name: 'bash', startedAt: 100, elapsed: 200 },
            { name: 'bash', startedAt: 300, elapsed: 200 },
          ],
        }],
        calls: 3,
        now: 3_000,
      }))
      expect(visibleElements(card)).toEqual([
        [
          t.turnCardStep(3, '3.0s'),
          `${PROGRESS_TOOL_MARKER}${t.turnCardToolDone('`read`', '100ms')}`,
          `${PROGRESS_TOOL_MARKER}${t.turnCardToolDone('`bash` ×2', '400ms')}`,
        ].join('\n'),
      ])
      // The rows are still separate LINES: only the element boundary changed.
      expect(visibleLines(card)).toHaveLength(3)
    })

    it('gives each step its own element, so only step boundaries pay spacing', () => {
      const card: any = renderProgressCard(t, {
        steps: [0, 1, 2].map(i => ({
          step: i + 1,
          startedAt: 0,
          endedAt: 100,
          tools: Array.from({ length: 4 }, (_, j) => ({ name: `t${i}_${j}`, startedAt: 0, elapsed: 10 })),
        })),
        calls: 12, failed: 0, turnStart: 0, now: 200, failedTurn: false,
      })
      expect(visibleElements(card)).toHaveLength(3)
      expect(visibleLines(card)).toHaveLength(15)
    })

    it('joins a narration into the step element when its markup is balanced', () => {
      const card: any = renderProgressCard(t, facts({
        steps: [{ step: 1, startedAt: 0, endedAt: 1_000, tools: [{ name: 'read', startedAt: 0, elapsed: 10 }], note: '先看 `card-write.ts` 那段' }],
        calls: 1, now: 1_000,
      }))
      expect(visibleElements(card)).toHaveLength(1)
    })

    it('keeps a narration with unbalanced markup in its own element', () => {
      // An odd `**` would pair with the NEXT line's bold run once both live in
      // one element, rendering the wrong text as bold (关键坑 60).
      const card: any = renderProgressCard(t, facts({
        steps: [{ step: 1, startedAt: 0, endedAt: 1_000, tools: [{ name: 'read', startedAt: 0, elapsed: 10 }], note: '这条**没闭合' }],
        calls: 1, now: 1_000,
      }))
      expect(visibleElements(card)).toHaveLength(3)
      expect(visibleLines(card)).toContain(`${PROGRESS_QUOTE_MARKER}${t.turnCardStepNote('这条**没闭合')}`)
    })
  })

  describe('the row names what the call touched', () => {
    it('renders the file after the tool name', () => {
      const card: any = renderProgressCard(t, facts({
        steps: [{ step: 1, startedAt: 0, endedAt: 1_000, tools: [{ name: 'read', startedAt: 0, elapsed: 400, detail: ['…/src/feishu-progress.ts'] }] }],
        calls: 1, now: 1_000,
      }))
      expect(mdOf(card)).toContain(t.turnCardToolDone('`read` · …/src/feishu-progress.ts', '400ms'))
    })

    it('names at most three distinct details of a merged run', () => {
      const card: any = renderProgressCard(t, facts({
        steps: [{
          step: 1,
          startedAt: 0,
          endedAt: 1_000,
          tools: [
            { name: 'bash', startedAt: 0, elapsed: 10, detail: ['npm'] },
            { name: 'bash', startedAt: 10, elapsed: 10, detail: ['node'] },
            { name: 'bash', startedAt: 20, elapsed: 10, detail: ['git'] },
            { name: 'bash', startedAt: 30, elapsed: 10, detail: ['tail'] },
            { name: 'bash', startedAt: 40, elapsed: 10, detail: ['npm'] },
          ],
        }],
        calls: 5, now: 1_000,
      }))
      expect(mdOf(card)).toContain(t.turnCardToolDone('`bash` ×5 · npm / node / git', '50ms'))
    })

    it('omits the detail entirely when a call has none', () => {
      const card: any = renderProgressCard(t, facts())
      expect(mdOf(card)).toContain(t.turnCardToolDone('`read`', '400ms'))
    })

    it('accumulates names across a run and stops at three', () => {
      // A single command may name several programs, and a run merges several
      // commands: the row keeps the FIRST THREE names overall. The first cut of
      // this capped per call instead, and a three-command run printed five
      // (`npm / tail / git / node / tail`) — caught by rendering a sample.
      const card: any = renderProgressCard(t, facts({
        steps: [{
          step: 1,
          startedAt: 0,
          endedAt: 1_000,
          tools: [
            { name: 'bash', startedAt: 0, elapsed: 10, detail: ['npm', 'tail'] },
            { name: 'bash', startedAt: 10, elapsed: 10, detail: ['git'] },
            { name: 'bash', startedAt: 20, elapsed: 10, detail: ['node', 'tail'] },
          ],
        }],
        calls: 3, now: 1_000,
      }))
      expect(mdOf(card)).toContain(t.turnCardToolDone('`bash` ×3 · npm / tail / git', '30ms'))
    })
  })

  describe('step separators', () => {
    it('draws one rule BETWEEN steps, and none before the first', () => {
      const card: any = renderProgressCard(t, {
        steps: [
          { step: 1, startedAt: 0, endedAt: 100, tools: [{ name: 'a', startedAt: 0, elapsed: 10 }] },
          { step: 2, startedAt: 100, endedAt: 200, tools: [{ name: 'b', startedAt: 100, elapsed: 10 }] },
        ],
        calls: 2, failed: 0, turnStart: 0, endedAt: 200, now: 200, failedTurn: false,
      })
      expect((card.body.elements as any[]).map(el => el.tag)).toEqual(['markdown', 'hr', 'markdown'])
    })

    it('puts the rule after the folded panel, not between it and the first step', () => {
      const steps = [0, 1, 2, 3].map(i => ({
        step: i + 1,
        startedAt: 0,
        endedAt: 100,
        tools: Array.from({ length: 4 }, (_, j) => ({ name: `t${i}_${j}`, startedAt: 0, elapsed: 10 })),
      }))
      const card: any = renderProgressCard(t, { steps, calls: 16, failed: 0, turnStart: 0, now: 200, failedTurn: false })
      const elements = card.body.elements as any[]
      expect(elements[0].tag).toBe('collapsible_panel')
      expect(elements[1].tag).toBe('markdown')
      // Steps 2-4 stay visible -> two rules, both BETWEEN step blocks.
      expect(elements.filter(el => el.tag === 'hr')).toHaveLength(2)
    })

    it('does not split a step that needed two elements of its own', () => {
      // An unbalanced narration gets its own element; that is still ONE step, so
      // no rule may land between its header and its rows.
      const card: any = renderProgressCard(t, facts({
        steps: [{
          step: 1,
          startedAt: 0,
          endedAt: 1_000,
          tools: [{ name: 'read', startedAt: 0, elapsed: 10 }],
          note: '这条**没闭合',
        }],
        calls: 1, now: 1_000,
      }))
      expect((card.body.elements as any[]).filter(el => el.tag === 'hr')).toHaveLength(0)
    })
  })

  describe('inlineMarkupBalanced', () => {
    it('accepts plain text and balanced runs', () => {
      expect(inlineMarkupBalanced('普通一句话')).toBe(true)
      expect(inlineMarkupBalanced('有 `代码` 和 **加粗**')).toBe(true)
    })

    it('rejects a line that would pair with its neighbour', () => {
      expect(inlineMarkupBalanced('没闭合的**加粗')).toBe(false)
      expect(inlineMarkupBalanced('没闭合的 `代码')).toBe(false)
    })
  })
})

describe('createProgressCards', () => {
  function harness(options: { failCardSend?: boolean; interleave?: CardInterleave } = {}) {
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
    const cards = createProgressCards({
      channel: channel as any,
      logger,
      getTranslations: () => t,
      ...(options.interleave === undefined ? {} : { interleave: options.interleave }),
    })
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
    // A call that has just started says `执行中`, never a frozen `0ms`.
    expect(mdOf(card)).toContain(t.turnCardToolRunning('`bash`', t.turnCardRunningLabel))
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

  it('says 执行中 at first, then repaints the elapsed clock every 30s', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', Date.now())
    // The tick measures against the wall clock, so the call has to be anchored
    // on it as well (fake timers keep the real epoch as their origin).
    cards.toolStarted('s1', 'bash', 'c1', Date.now())
    await vi.advanceTimersByTimeAsync(0)
    expect(mdOf((channel.createCardInstance.mock.calls[0] as any)[0]))
      .toContain(t.turnCardToolRunning('`bash`', t.turnCardRunningLabel))
    // Nothing is written before the tick: a fast call must not pay for one.
    await vi.advanceTimersByTimeAsync(PROGRESS_RUNNING_TICK_MS - 1)
    expect(channel.updateCardInstance).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    const card = (channel.updateCardInstance.mock.calls.at(-1) as any)[1]
    expect(mdOf(card)).toContain(t.turnCardToolRunning('`bash`', '30.0s'))
  })

  it('drops the running tick as soon as the call settles', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', Date.now())
    cards.toolStarted('s1', 'bash', 'c1', Date.now())
    await vi.advanceTimersByTimeAsync(0)
    cards.toolFinished('s1', 'c1', 400, false, Date.now())
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    const writes = channel.updateCardInstance.mock.calls.length
    await vi.advanceTimersByTimeAsync(PROGRESS_RUNNING_TICK_MS * 3)
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(writes)
  })

  it('opens a NEW card after another module posts one, showing only new rows', async () => {
    const interleave = createCardInterleave()
    const { channel, cards } = harness({ interleave })
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.waitFor(() => expect(channel.createCardInstance).toHaveBeenCalledTimes(1))
    cards.toolFinished('s1', 'c1', 100, false, 120)
    cards.stepEnded('s1', 200)
    // A todo card (or a job card, a question card, a compaction card) lands in
    // the chat: the card above it must stop growing.
    interleave.note('oc_1')
    cards.stepStarted('s1', 2, 300)
    cards.toolStarted('s1', 'bash', 'c2', 400)
    await vi.waitFor(() => expect(channel.createCardInstance).toHaveBeenCalledTimes(2))
    const fresh = (channel.createCardInstance.mock.calls[1] as any)[0]
    expect(mdOf(fresh)).not.toContain('`read`')
    expect(String(mdOf(fresh))).toContain('`bash`')
    // The first card was left exactly as it was.
    expect(channel.updateCardInstance).not.toHaveBeenCalled()
    // …and the turn's totals still count everything.
    expect(fresh.header.title.content).toBe(t.turnCardTitleRunning(2, '400ms'))
  })

  it('keeps a running step in the new segment so its later rows still show', async () => {
    vi.useFakeTimers()
    const interleave = createCardInterleave()
    const { channel, cards } = harness({ interleave })
    const t0 = Date.now()
    cards.beginTurn(chat, 's1', t0)
    cards.stepStarted('s1', 1, t0)
    cards.toolStarted('s1', 'read', 'c1', t0)
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    // The interruption arrives mid-step (the step has not ended). The segment is
    // closed but NOT re-opened: nothing new has happened yet.
    await vi.advanceTimersByTimeAsync(120)
    interleave.note('oc_1')
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    // The next call does have something new to say, so the new segment opens
    // with its step (and its header), below the interrupting card.
    cards.toolStarted('s1', 'bash', 'c2', Date.now())
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(2)
    const fresh = (channel.createCardInstance.mock.calls[1] as any)[0]
    expect(String(mdOf(fresh))).toContain(t.turnCardStep(1, '1.0s…'))
    expect(String(mdOf(fresh))).toContain('`read`')
    expect(String(mdOf(fresh))).toContain('`bash`')
  })

  it('keeps a closed segment\'s clock alive without adding rows to it', async () => {
    vi.useFakeTimers()
    const interleave = createCardInterleave()
    const { channel, cards } = harness({ interleave })
    cards.beginTurn(chat, 's1', Date.now())
    cards.stepStarted('s1', 1, Date.now())
    cards.toolStarted('s1', 'ask_user_question', 'c1', Date.now())
    await vi.advanceTimersByTimeAsync(0)
    interleave.note('oc_1')
    await vi.advanceTimersByTimeAsync(PROGRESS_RUNNING_TICK_MS)
    // Same card, same rows — only the elapsed clock moved on.
    const card = (channel.updateCardInstance.mock.calls.at(-1) as any)[1]
    expect(mdOf(card)).toContain(t.turnCardToolRunning('`ask_user_question`', '30.0s'))
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(PROGRESS_RUNNING_TICK_MS)
    expect(mdOf((channel.updateCardInstance.mock.calls.at(-1) as any)[1]))
      .toContain(t.turnCardToolRunning('`ask_user_question`', '1m00s'))
  })

  it('closes the turn on the card above the interruption when no new row arrived', async () => {
    const interleave = createCardInterleave()
    const { channel, cards } = harness({ interleave })
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.toolStarted('s1', 'ask_user_question', 'c1', 10)
    await vi.waitFor(() => expect(channel.createCardInstance).toHaveBeenCalledTimes(1))
    // A question card, then its confirmation card, then a retirement notice: the
    // three of them used to spawn three identical cards.
    interleave.note('oc_1')
    interleave.note('oc_1')
    interleave.note('oc_1')
    await cards.finish('s1', 900_000, false)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    const updated = (channel.updateCardInstance.mock.calls.at(-1) as any)[1]
    expect(updated.header.template).toBe('green')
    expect(updated.header.title.content).toBe(t.turnCardTitleDone(1, 0, '15m00s'))
    // The body is the frozen one: the turn's own rows, unchanged.
    expect(mdOf(updated)).toContain('⏳ `ask_user_question`')
  })
})
