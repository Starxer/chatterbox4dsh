import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROGRESS_ELEMENT_SPACING, PROGRESS_MAX_FOLDED, PROGRESS_MAX_ROWS, PROGRESS_MAX_STEPS, PROGRESS_NOTE_MAX,
  PROGRESS_RUNNING_TICK_MS, PROGRESS_WRITE_GAP_MS,
  PROGRESS_QUOTE_MARKER,
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

/** The folded panel's markdown ELEMENTS: one per folded step since 2026-10-12. */
function foldedElements(card: any): string[] {
  const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
  return (panel?.elements ?? []).filter((el: any) => el.tag === 'markdown').map((el: any) => String(el.content))
}

/** The folded panel's rows, flattened. */
function foldedLines(card: any): string[] {
  return foldedElements(card).flatMap(content => content.split('\n'))
}

/**
 * A step's CONTENT row: since 2026-10-12 every line under the `▸` heading is one
 * quote block, and the heading itself stays outside it (the user's rule: frame
 * what the step did, not its title).
 */
function row(text: string): string {
  return `${PROGRESS_QUOTE_MARKER}${text}`
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
    expect(card.header.title.content).toBe(t.turnCardTitleRunning('5.0s'))
    const md = mdOf(card)
    expect(md).toContain(t.turnCardStep(1, '5.0s'))
    expect(md).toContain(t.turnCardToolDone('`read`', '400ms'))
  })

  it('titles a running turn with the live wording, and without the tool count', () => {
    const card: any = renderProgressCard(t, facts({ calls: 3, endedAt: undefined, now: 3_400 }))
    // The count is readable from the rows below, and the running step's header
    // carries the live phase: the title only has to say the turn is still going.
    expect(card.header.title.content).toBe('🐳 深度求索中 · 3.4s')
    expect(card.header.title.content).not.toContain('3 个工具')
  })

  it('names the live phase in the running title, keeping the thinking wording for thinking', () => {
    // A running tool: the header must stop claiming the model is thinking.
    const runningTool = renderProgressCard(t, facts({
      endedAt: undefined,
      now: 12_300,
      steps: [{ step: 1, startedAt: 0, endedAt: undefined, tools: [{ name: 'bash', startedAt: 3_000 }] }],
    })) as any
    expect(runningTool.header.title.content).toBe(`${t.turnCardPhaseTool} · 12.3s`)

    // Emitting prose: reply wording.
    const replying = renderProgressCard(t, facts({
      endedAt: undefined,
      now: 2_000,
      steps: [{ step: 1, startedAt: 0, endedAt: undefined, phase: 'replying', tools: [] }],
    })) as any
    expect(replying.header.title.content).toBe(`${t.turnCardPhaseReplying} · 2.0s`)

    // Really thinking: keep the product wording.
    const thinking = renderProgressCard(t, facts({
      endedAt: undefined,
      now: 4_000,
      steps: [{ step: 1, startedAt: 0, endedAt: undefined, phase: 'thinking', tools: [] }],
    })) as any
    expect(thinking.header.title.content).toBe(t.turnCardTitleRunning('4.0s'))

    // No live phase reported (lost frame): never invent one.
    const unknown = renderProgressCard(t, facts({
      endedAt: undefined,
      now: 1_000,
      steps: [{ step: 1, startedAt: 0, endedAt: undefined, tools: [] }],
    })) as any
    expect(unknown.header.title.content).toBe(t.turnCardTitleRunning('1.0s'))

    // The turn ending wins over any phase: no live phase after `turn/end`.
    const done = renderProgressCard(t, facts()) as any
    expect(done.header.title.content).toBe(t.turnCardTitleDone(1, 0, '5.0s'))
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

  it('names the step the turn died in, and the call it never got to run', () => {
    // The real shape (session log, 2026-10-14): the model streamed reasoning and
    // then started a call to `edit`; the attempt died before DSH ran it, so there
    // is no tool row for it — only this marker. Without it the dying step reads
    // as a step that did nothing.
    const card: any = renderProgressCard(t, facts({
      steps: [
        { step: 5, startedAt: 0, endedAt: 1_000, tools: [{ name: 'ssh_exec', startedAt: 0, elapsed: 3 }] },
        { step: 6, startedAt: 1_000, endedAt: 2_000, tools: [], failed: true, unrun: ['edit'] },
      ],
      calls: 1,
      endedAt: 2_000,
      now: 2_000,
      failedTurn: true,
    }))
    expect(visibleLines(card)).toContain(`${t.turnCardStep(6, '1.0s')} · ${t.turnCardStepFailed}`)
    expect(visibleLines(card)).toContain(row(t.turnCardCallUnrun('edit')))
    // Only step 6 died: the step above it keeps its ordinary header.
    expect(visibleLines(card)).toContain(t.turnCardStep(5, '1.0s'))
    // A call that never ran is NOT one of the turn's tool calls: the title still
    // counts the one that did.
    expect(card.header.title.content).toBe(t.turnCardTitleFailed(1, '2.0s'))
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
    // The section header of a step that is still running carries the same `…`,
    // and the running call lights it (`🔧 工具调用中`).
    expect(md).toContain(t.turnCardStep(1, '3.4s…', t.turnCardPhaseTool))
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
    const lines = foldedLines(card)
    expect(lines[0]).toBe('…')
    expect(lines.length).toBeLessThanOrEqual(PROGRESS_MAX_FOLDED + 1)
  })

  it('gives every folded step its own element, so no quote block can run past its step', () => {
    // The reported bug (2026-10-12): the folded body was ONE element, so the
    // blockquote that opened on the first content row continued through every
    // later step heading (CommonMark lazy continuation, 关键坑 65) and the frame
    // ran to the last line of the panel.
    const total = 8
    const steps = Array.from({ length: total }, (_, i) => ({
      step: i + 1,
      startedAt: 0,
      endedAt: 100,
      tools: [
        { name: `t${i}a`, startedAt: 0, elapsed: 10 },
        { name: `t${i}b`, startedAt: 0, elapsed: 10 },
      ],
    }))
    const card: any = renderProgressCard(t, { steps, calls: total * 2, failed: 0, turnStart: 0, now: 200, failedTurn: false })
    const folded = foldedElements(card)
    const dropped = total - PROGRESS_MAX_STEPS
    // One element per folded step.
    expect(folded).toHaveLength(dropped)
    for (let i = 0; i < dropped; i++) {
      const lines = folded[i]!.split('\n')
      // The heading is the element's FIRST line and stays outside the frame…
      expect(lines[0]).toBe(t.turnCardStep(i + 1, '100ms'))
      expect(lines[0]!.startsWith(PROGRESS_QUOTE_MARKER)).toBe(false)
      // …and every other line is quoted, so the frame ends with this step.
      for (const line of lines.slice(1)) expect(line.startsWith(PROGRESS_QUOTE_MARKER)).toBe(true)
    }
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
      row(t.turnCardStepNote('我先看一下流式卡片那段代码')),
      row(t.turnCardToolDone('`read`', '200ms')),
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
    // then the narration, then the tool rows — all of them inside the step's one
    // quote block, with the heading left outside it.
    expect(visibleLines(card)).toEqual([
      t.turnCardStep(1, '2.0s'),
      row('📥 注入上下文 · AGENTS.md（已更新）'),
      row(t.turnCardStepNote('我看一下')),
      row(t.turnCardToolDone('`bash`', '100ms')),
    ])
  })

  it("quotes every content row and leaves the step's heading outside the block", () => {
    const card: any = renderProgressCard(t, facts({
      steps: [
        {
          step: 1,
          startedAt: 0,
          endedAt: 2_000,
          tools: [{ name: 'bash', startedAt: 500, elapsed: 100 }],
          injections: ['📥 注入上下文 · AGENTS.md（已更新）'],
          note: '我看一下',
        },
        { step: 2, startedAt: 2_000, endedAt: 3_000, tools: [{ name: 'read', startedAt: 2_100, elapsed: 50 }] },
      ],
      calls: 2,
      now: 3_000,
    }))
    const lines = visibleLines(card)
    const headings = lines.filter(line => line === t.turnCardStep(1, '2.0s') || line === t.turnCardStep(2, '1.0s'))
    expect(headings).toHaveLength(2)
    for (const line of lines) {
      // The two headings are the ONLY unquoted rows on the card: a step's title
      // is a title, and everything under it is what the step did.
      expect(line.startsWith(PROGRESS_QUOTE_MARKER)).toBe(!headings.includes(line))
    }
  })

  it('keeps only the newest PROGRESS_MAX_STEPS steps visible and folds the older ones', () => {
    // Eight steps of two calls each: the window is counted in STEPS, so the
    // cutoff lands on a step boundary whatever the constant happens to be.
    const total = 8
    const steps = Array.from({ length: total }, (_, i) => ({
      step: i + 1,
      startedAt: 0,
      endedAt: 100,
      tools: [
        { name: `t${i}a`, startedAt: 0, elapsed: 10 },
        { name: `t${i}b`, startedAt: 0, elapsed: 10 },
      ],
    }))
    const card: any = renderProgressCard(t, { steps, calls: total * 2, failed: 0, turnStart: 0, now: 200, failedTurn: false })
    const panel = (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')
    const dropped = total - PROGRESS_MAX_STEPS
    // A dropped step takes its header and both rows with it.
    expect(panel.header.title.content).toBe(t.cardFoldTitle(t.turnCardOlderRows(dropped * 3)))
    const visible = visibleLines(card)
    const first = total - PROGRESS_MAX_STEPS + 1
    expect(visible[0]).toBe(t.turnCardStep(first, '100ms'))
    const titles = Array.from({ length: PROGRESS_MAX_STEPS }, (_, i) => t.turnCardStep(first + i, '100ms'))
    expect(visible.filter(line => titles.includes(line))).toHaveLength(PROGRESS_MAX_STEPS)
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
          row(t.turnCardToolDone('`read`', '100ms')),
          row(t.turnCardToolDone('`bash` ×2', '400ms')),
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

  describe('the live light on the step that is still running', () => {
    it('names what the model is doing, between the step number and the clock', () => {
      const card: any = renderProgressCard(t, facts({
        steps: [{ step: 1, startedAt: 0, tools: [], phase: 'thinking' }],
        calls: 0, endedAt: undefined, now: 4_800,
      }))
      expect(visibleLines(card)).toContain(t.turnCardStep(1, '4.8s…', t.turnCardPhaseThinking))
      // The heading stays plain: the light rides the title line, never its own row.
      expect(visibleLines(card).filter(line => line.includes(t.turnCardPhaseThinking))).toHaveLength(1)
    })

    it('has one word per phase the stream can be in', () => {
      const light = (phase: 'awaiting' | 'thinking' | 'replying'): string => visibleLines(renderProgressCard(t, facts({
        steps: [{ step: 1, startedAt: 0, tools: [], phase }],
        calls: 0, endedAt: undefined, now: 0,
      })))[0]!
      expect(light('awaiting')).toContain(t.turnCardPhaseAwaiting)
      expect(light('thinking')).toContain(t.turnCardPhaseThinking)
      expect(light('replying')).toContain(t.turnCardPhaseReplying)
    })

    it('drops the light as soon as the step ended, whatever phase it reached', () => {
      const card: any = renderProgressCard(t, facts({
        steps: [{ step: 1, startedAt: 0, endedAt: 4_000, tools: [], phase: 'replying' }],
        calls: 0, now: 4_500,
      }))
      expect(visibleLines(card)).toContain(t.turnCardStep(1, '4.0s'))
      expect(mdOf(card)).not.toContain(t.turnCardPhaseReplying)
    })

    it('lets a tool that has not returned outrank the phase the stream last reported', () => {
      // The deltas that carry a tool call report `replying`; saying so for the
      // whole tool run would name a phase this step already left.
      const card: any = renderProgressCard(t, facts({
        steps: [{ step: 1, startedAt: 0, tools: [{ name: 'bash', startedAt: 100 }], phase: 'replying' }],
        calls: 1, endedAt: undefined, now: 1_100,
      }))
      const header = visibleLines(card)[0]!
      expect(header).toContain(t.turnCardPhaseTool)
      expect(header).not.toContain(t.turnCardPhaseReplying)
    })

    it('shows no light at all before the first frame of the step', () => {
      const card: any = renderProgressCard(t, facts({
        steps: [{ step: 1, startedAt: 0, tools: [] }],
        calls: 0, endedAt: undefined, now: 10,
      }))
      expect(visibleLines(card)).toEqual([t.turnCardStep(1, '10ms…')])
    })
  })

  describe('the row names what the call touched', () => {
    it('renders the file after the tool name', () => {
      const card: any = renderProgressCard(t, facts({
        steps: [{ step: 1, startedAt: 0, endedAt: 1_000, tools: [{ name: 'read', startedAt: 0, elapsed: 400, detail: ['feishu-progress.ts'] }] }],
        calls: 1, now: 1_000,
      }))
      expect(mdOf(card)).toContain(t.turnCardToolDone('`read` · feishu-progress.ts', '400ms'))
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
      // Enough steps that the window provably drops some, whatever it is set to.
      const total = PROGRESS_MAX_STEPS + 3
      const steps = Array.from({ length: total }, (_, i) => ({
        step: i + 1,
        startedAt: 0,
        endedAt: 100,
        tools: Array.from({ length: 4 }, (_, j) => ({ name: `t${i}_${j}`, startedAt: 0, elapsed: 10 })),
      }))
      const card: any = renderProgressCard(t, { steps, calls: total * 4, failed: 0, turnStart: 0, now: 200, failedTurn: false })
      const elements = card.body.elements as any[]
      expect(elements[0].tag).toBe('collapsible_panel')
      expect(elements[1].tag).toBe('markdown')
      // One rule between each pair of visible steps, and none before the first.
      expect(elements.filter(el => el.tag === 'hr')).toHaveLength(PROGRESS_MAX_STEPS - 1)
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

  it('records the live phase before any card exists, and renders it into the first one', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.stepPhase('s1', 1, 'thinking', 20)
    await vi.advanceTimersByTimeAsync(0)
    // A phase is not a reason to open a card (it says nothing on its own).
    expect(channel.createCardInstance).not.toHaveBeenCalled()
    cards.toolStarted('s1', 'read', 'c1', 100)
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    // While the call runs the tool outranks the phase; once it settles, the
    // phase recorded before the card existed is what the header shows.
    cards.toolFinished('s1', 'c1', 400, false, 500)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    const card = (channel.updateCardInstance.mock.calls[0] as any)[1]
    expect(mdOf(card)).toContain(t.turnCardStep(1, '500ms…', t.turnCardPhaseThinking))
  })

  it('repaints once per phase CHANGE, and clears the light when the step ends', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    cards.toolFinished('s1', 'c1', 400, false, 500)
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.sendCardByReference).toHaveBeenCalledTimes(1)
    // Frames arrive per token; only a transition is worth a write.
    cards.stepPhase('s1', 1, 'awaiting', 600)
    cards.stepPhase('s1', 1, 'awaiting', 610)
    cards.stepPhase('s1', 1, 'thinking', 700)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    expect(mdOf((channel.updateCardInstance.mock.calls[0] as any)[1]))
      .toContain(t.turnCardStep(1, '700ms…', t.turnCardPhaseThinking))

    cards.stepEnded('s1', 800)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    const settled = mdOf((channel.updateCardInstance.mock.calls.at(-1) as any)[1])
    expect(settled).toContain(t.turnCardStep(1, '800ms'))
    expect(settled).not.toContain(t.turnCardPhaseThinking)
  })

  it('ignores a phase for a step that already ended, or one it never saw', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.advanceTimersByTimeAsync(0)
    const before = channel.updateCardInstance.mock.calls.length
    cards.stepEnded('s1', 500)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    const settled = channel.updateCardInstance.mock.calls.length
    // A late frame must not relight a settled header, and a step number this
    // turn never opened must not conjure a section out of a phase.
    cards.stepPhase('s1', 1, 'replying', 600)
    cards.stepPhase('s1', 9, 'thinking', 610)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS * 2)
    expect(channel.updateCardInstance.mock.calls.length).toBe(settled)
    expect(settled).toBeGreaterThan(before)
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
    // The header names what is happening NOW (the tool is running), not the
    // constant "thinking" wording the operator reported as wrong (2026-10-27).
    expect(card.header.title.content).toBe(`${t.turnCardPhaseTool} · 100ms`)
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
    // Both calls settled before the write: no tool is running, and the step
    // reported no other phase, so the header keeps the thinking wording.
    expect(card.header.title.content).toBe(t.turnCardTitleRunning('700ms'))
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
    interleave.note({ chatId: 'oc_1' })
    cards.stepStarted('s1', 2, 300)
    cards.toolStarted('s1', 'bash', 'c2', 400)
    await vi.waitFor(() => expect(channel.createCardInstance).toHaveBeenCalledTimes(2))
    const fresh = (channel.createCardInstance.mock.calls[1] as any)[0]
    expect(mdOf(fresh)).not.toContain('`read`')
    expect(String(mdOf(fresh))).toContain('`bash`')
    // The first card was left exactly as it was.
    expect(channel.updateCardInstance).not.toHaveBeenCalled()
    // …and the turn's totals still count everything, with the NEW card naming
    // the tool that is running right now.
    expect(fresh.header.title.content).toBe(`${t.turnCardPhaseTool} · 400ms`)
  })

  it('never cuts a topic\'s card because another topic of the same chat got a message', async () => {
    // One Feishu topic is one DSH session (user rule, 2026-10-19). A busy notice
    // or a job card in topic B must not end the segment of the turn in topic A.
    const interleave = createCardInterleave()
    const { channel, cards } = harness({ interleave })
    cards.beginTurn(threaded, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.waitFor(() => expect(channel.createCardInstance).toHaveBeenCalledTimes(1))
    cards.toolFinished('s1', 'c1', 100, false, 120)
    cards.stepEnded('s1', 200)
    // A message landed in ANOTHER topic of the same chat.
    interleave.note({ chatId: 'oc_1', rootId: 'om_other_topic' })
    // …and a main-chat message must not cut it either.
    interleave.note({ chatId: 'oc_1' })
    cards.stepStarted('s1', 2, 300)
    cards.toolStarted('s1', 'bash', 'c2', 400)
    await vi.waitFor(() => expect(channel.updateCardInstance).toHaveBeenCalled())
    // Still ONE card: the same topic's card keeps growing in place.
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    const last = (channel.updateCardInstance.mock.calls.at(-1) as any)[1]
    expect(String(mdOf(last))).toContain('`bash`')
  })

  it('cut a topic\'s card when the message lands in that SAME topic', async () => {
    const interleave = createCardInterleave()
    const { channel, cards } = harness({ interleave })
    cards.beginTurn(threaded, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.toolStarted('s1', 'read', 'c1', 10)
    await vi.waitFor(() => expect(channel.createCardInstance).toHaveBeenCalledTimes(1))
    cards.toolFinished('s1', 'c1', 100, false, 120)
    cards.stepEnded('s1', 200)
    // The steer notice (or any other message) replies to THIS topic's root.
    interleave.note({ chatId: 'oc_1', rootId: 'om_root' })
    cards.stepStarted('s1', 2, 300)
    cards.toolStarted('s1', 'bash', 'c2', 400)
    await vi.waitFor(() => expect(channel.createCardInstance).toHaveBeenCalledTimes(2))
    const fresh = (channel.createCardInstance.mock.calls[1] as any)[0]
    expect(String(mdOf(fresh))).not.toContain('`read`')
    expect(String(mdOf(fresh))).toContain('`bash`')
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
    interleave.note({ chatId: 'oc_1' })
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    // The next call does have something new to say, so the new segment opens
    // with its step (and its header), below the interrupting card.
    cards.toolStarted('s1', 'bash', 'c2', Date.now())
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(2)
    const fresh = (channel.createCardInstance.mock.calls[1] as any)[0]
    expect(String(mdOf(fresh))).toContain(t.turnCardStep(1, '1.0s…', t.turnCardPhaseTool))
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
    interleave.note({ chatId: 'oc_1' })
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
    interleave.note({ chatId: 'oc_1' })
    interleave.note({ chatId: 'oc_1' })
    interleave.note({ chatId: 'oc_1' })
    await cards.finish('s1', 900_000, false)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    const updated = (channel.updateCardInstance.mock.calls.at(-1) as any)[1]
    expect(updated.header.template).toBe('green')
    expect(updated.header.title.content).toBe(t.turnCardTitleDone(1, 0, '15m00s'))
    // The body is the frozen one: the turn's own rows, unchanged.
    expect(mdOf(updated)).toContain('⏳ `ask_user_question`')
  })

  it('shows the call a dying attempt streamed, and clears it when the step moves on', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.toolStarted('s1', 'read', 'c1', 100)
    cards.toolFinished('s1', 'c1', 400, false, 500)
    await vi.advanceTimersByTimeAsync(0)
    // The attempt that died had streamed a call to `edit` before the stream broke.
    cards.stepAttempt('s1', 1, ['edit'], 600)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    expect(String(mdOf((channel.updateCardInstance.mock.calls.at(-1) as any)[1])))
      .toContain(t.turnCardCallUnrun('edit'))
    // The retry committed and a REAL call followed: the marker must go, or a step
    // that recovered would keep claiming it never ran anything.
    cards.stepAttempt('s1', 1, [], 700)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    expect(String(mdOf((channel.updateCardInstance.mock.calls.at(-1) as any)[1])))
      .not.toContain(t.turnCardCallUnrun('edit'))
  })

  it('records an unrun call before the card exists, and marks the newest step at turn/end', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.toolStarted('s1', 'bash', 'c1', 10)
    cards.toolFinished('s1', 'c1', 400, false, 500)
    // Step 2 dies on an attempt that had streamed a call: no card is opened by the
    // attempt itself, so the marker has to survive on the facts until the failure
    // render at `turn/end`.
    cards.stepStarted('s1', 2, 1_000)
    cards.stepAttempt('s1', 2, ['todo_write'], 1_100)
    await cards.finish('s1', 2_000, true)
    const card = (channel.updateCardInstance.mock.calls.at(-1) as any)[1]
    expect(card.header.template).toBe('red')
    expect(String(mdOf(card))).toContain(`${t.turnCardStep(2, '1.0s')} · ${t.turnCardStepFailed}`)
    expect(String(mdOf(card))).toContain(t.turnCardCallUnrun('todo_write'))
    // Only the newest step is named as the one that failed.
    expect(String(mdOf(card))).toContain(t.turnCardStep(1, '2.0s…'))
    expect(String(mdOf(card))).not.toContain(`${t.turnCardStep(1, '2.0s…')} · ${t.turnCardStepFailed}`)
  })

  it('ignores an attempt for a step this module never saw', async () => {
    vi.useFakeTimers()
    const { channel, cards } = harness()
    cards.beginTurn(chat, 's1', 0)
    cards.stepStarted('s1', 1, 0)
    cards.toolStarted('s1', 'read', 'c1', 100)
    await vi.advanceTimersByTimeAsync(0)
    // A frame for a step that never had a section must not invent one: the row
    // would name a step the turn never ran.
    cards.stepAttempt('s1', 7, ['edit'], 200)
    await vi.advanceTimersByTimeAsync(PROGRESS_WRITE_GAP_MS)
    expect(channel.updateCardInstance).not.toHaveBeenCalled()
    expect(String(mdOf((channel.createCardInstance.mock.calls[0] as any)[0]))).not.toContain(t.turnCardCallUnrun('edit'))
  })
})
