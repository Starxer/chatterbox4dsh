import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeExternalMessage, startFeishuExternalTurns } from '../src/feishu-external-turns.ts'
import { noteFeishuPrompt, resetTurnOrigins } from '../src/feishu-turn-origin.ts'
import { translationsFor } from '../src/i18n.ts'
import type { TurnStats } from '../src/feishu-streaming.ts'

const t = translationsFor('en')
const SESSION = 'lark-v2-external-session'
const CHAT = { chatId: 'oc_test', chatType: 'p2p' as const, threadId: 'omt_1', rootId: 'om_root' }

interface Sent {
  to: string
  input: { card?: unknown; text?: string }
  opts?: { replyInThread?: boolean; replyTo?: string }
}

interface Harness {
  sent: Sent[]
  topics: Array<{ messageId: string; topic: { threadId?: string; rootId?: string } }>
  plan: ReturnType<typeof vi.fn>
  autoSend: ReturnType<typeof vi.fn>
  /**
   * The live `flushed()` holder the module reads. Tests swap `.current` to prove
   * the module reads it at completion time instead of capturing a value.
   */
  flushRef: { current: (sessionId: string) => Promise<TurnStats | undefined> }
  /** Fire one session event through the module's listener. */
  fire: (event: { type: string; time?: number; data?: unknown }) => void
  stop: () => void
}

interface Options {
  bound?: boolean
  enabled?: boolean
  stats?: TurnStats | undefined
  withDeliver?: boolean
  planRows?: boolean
  produceCard?: 'off' | 'summary' | 'delivery'
  compact?: boolean
  /** Whether a step card really carried the turn's text (streaming's flag). */
  textDelivered?: boolean
  hydrateCard?: (card: object, workspace?: string) => Promise<object>
}

/** A finished turn with the numbers the Turn Complete card renders. */
function turnStats(overrides: Partial<TurnStats> = {}): TurnStats {
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

function buildHarness(options: Options = {}): Harness {
  const sent: Sent[] = []
  const topics: Array<{ messageId: string; topic: { threadId?: string; rootId?: string } }> = []
  const listeners: Array<(session: unknown, event: unknown) => void> = []
  const plan = vi.fn(async () => ({
    rows: options.planRows === true
      ? [{ path: 'notes.md', name: 'notes.md', kind: 'other' as const }]
      : [],
    auto: [],
  }))
  const autoSend = vi.fn(async () => undefined)
  const flushRef: { current: (sessionId: string) => Promise<TurnStats | undefined> } = {
    current: async () => options.stats,
  }
  const ctx = {
    on: (_event: string, listener: (session: unknown, event: unknown) => void) => {
      listeners.push(listener)
      return () => {
        const idx = listeners.indexOf(listener)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  }
  const bridgeHolder = {
    current: {
      resolveChat: (sessionId: string) => (options.bound === false ? undefined : sessionId === SESSION ? CHAT : undefined),
      getSessionMeta: async () => ({ workspace: '/w', agentPreset: 'standard', model: 'm', reasoningEffort: 'high', contextWindow: 1000, lastInputTokens: 10 }),
      busyMode: () => 'queue' as const,
      consumeIntermediateSent: () => options.textDelivered === true,
    },
  }
  const controller = startFeishuExternalTurns({
    ctx: ctx as never,
    channel: {
      send: async (to, input, opts) => {
        sent.push({ to, input: input as { card?: unknown; text?: string }, ...(opts === undefined ? {} : { opts }) })
        return { messageId: `om_${sent.length}` }
      },
    },
    bridgeHolder: bridgeHolder as never,
    logger: { info: () => undefined, warn: () => undefined },
    getTranslations: () => t,
    flushed: flushRef,
    sessionMeta: async () => ({
      workspace: '/w',
      model: 'm',
      reasoningEffort: 'high',
      contextWindow: 1000,
      lastInputTokens: 10,
    }),
    ...(options.produceCard === undefined ? {} : { produceCard: () => options.produceCard! }),
    ...(options.withDeliver === false ? {} : { deliver: { plan, autoSend } }),
    noteCardTopic: (messageId, topic) => { topics.push({ messageId, topic }) },
    enabled: () => options.enabled !== false,
    ...(options.compact === true ? { compact: () => true } : {}),
    ...(options.hydrateCard === undefined ? {} : { hydrateCard: options.hydrateCard }),
  })
  return {
    sent,
    topics,
    plan,
    autoSend,
    flushRef,
    stop: controller.stop,
    fire: event => {
      for (const listener of listeners) listener({ id: SESSION }, event)
    },
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/** All markdown the card carries, joined — content assertions read this. */
function markdownOf(sent: Sent | undefined): string {
  const elements = (sent?.input.card as { body?: { elements?: Array<{ content?: string }> } })?.body?.elements ?? []
  return elements.map(element => element.content ?? '').join('\n')
}

afterEach(() => {
  resetTurnOrigins()
})

describe('mirroring user messages from another surface', () => {
  it('echoes a Web GUI message with its text into the chat topic', async () => {
    const h = buildHarness()
    h.fire({
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'please also send me the deck' }], source: { kind: 'user', rpcId: 'web-1', clientTimeZone: 'Asia/Shanghai' } },
    })
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.to).toBe('oc_test')
    expect(h.sent[0]?.input.text).toBe(`${t.externalMessageFromWebGui}please also send me the deck`)
    expect(h.sent[0]?.opts).toEqual({ replyInThread: true, replyTo: 'om_root' })
    h.stop()
  })

  it('labels a message from a surface that is not the browser', async () => {
    const h = buildHarness()
    h.fire({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', rpcId: 'x' } } })
    await flush()
    expect(h.sent[0]?.input.text).toBe(`${t.externalMessageFromOther}hi`)
    h.stop()
  })

  it('names attachments instead of uploading them', async () => {
    const h = buildHarness()
    h.fire({
      type: 'user/message',
      data: { content: [{ type: 'image' }, { type: 'image' }, { type: 'file' }], source: { kind: 'user', rpcId: 'web-2', clientTimeZone: 'UTC' } },
    })
    await flush()
    expect(h.sent[0]?.input.text).toBe(`${t.externalMessageFromWebGui.trimEnd()}\n${t.externalMessageAttachments(2, 1)}`)
    h.stop()
  })

  it('does not echo the message this plugin dispatched itself', async () => {
    const h = buildHarness()
    noteFeishuPrompt(SESSION, 'req-mine')
    h.fire({ type: 'user/message', data: { content: [{ type: 'text', text: 'from feishu' }], source: { kind: 'user', rpcId: 'req-mine' } } })
    await flush()
    expect(h.sent).toEqual([])
    h.stop()
  })

  it('does not echo DSH-injected context', async () => {
    const h = buildHarness()
    h.fire({ type: 'user/message', data: { content: [{ type: 'text', text: 'job done' }], source: { kind: 'tool-jobs', summary: 'x' } } })
    await flush()
    expect(h.sent).toEqual([])
    h.stop()
  })

  it('stays quiet when the setting is off or the session is unbound', async () => {
    const off = buildHarness({ enabled: false })
    off.fire({ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId: 'w' } } })
    await flush()
    expect(off.sent).toEqual([])
    off.stop()

    const unbound = buildHarness({ bound: false })
    unbound.fire({ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId: 'w' } } })
    await flush()
    expect(unbound.sent).toEqual([])
    unbound.stop()
  })
})

describe('completing a turn that did not start on Feishu', () => {
  it('posts the Turn Complete card and runs the delivery, naming the surface', async () => {
    const h = buildHarness({ withDeliver: true, planRows: true })
    h.fire({ type: 'user/message', data: { content: [{ type: 'text', text: 'from the browser' }], source: { kind: 'user', rpcId: 'web-9', clientTimeZone: 'UTC' } } })
    await flush()
    h.sent.length = 0
    h.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()

    const card = h.sent.at(-1)
    expect(card?.input.card).toBeDefined()
    const elements = (card?.input.card as { body?: { elements?: Array<{ content?: string }> } })?.body?.elements ?? []
    expect(elements.some(element => element.content === t.turnCompleteExternalTurn(t.surfaceLabelWebGui))).toBe(true)
    expect(h.plan).toHaveBeenCalledTimes(1)
    expect(h.plan.mock.calls[0]?.[0]).toMatchObject({ sessionId: SESSION, chatId: 'oc_test', topic: { threadId: 'omt_1', rootId: 'om_root' } })
    expect(h.autoSend).toHaveBeenCalledTimes(1)
    expect(h.topics.map(entry => entry.messageId)).toEqual(['om_1'])
    h.stop()
  })

  it('renders the turn stats block on an auto-triggered completion', async () => {
    const h = buildHarness({ stats: turnStats() })
    // A schedule notice opened the turn: no human message anywhere.
    h.fire({ type: 'user/message', data: { content: [{ type: 'text', text: 'ETA reminder' }], source: { kind: 'schedule' } } })
    await flush()
    h.sent.length = 0
    h.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    const md = markdownOf(h.sent.at(-1))
    // The three stat lines a Feishu-started turn prints. They all vanished when
    // the module captured streaming's `flushed()` before it existed.
    expect(md).toContain('⏱ 5.0s')
    expect(md).toContain('🔄 3 steps')
    expect(md).toContain('📦 1.5K tokens')
    h.stop()
  })

  it('reads flushed at completion time, so a late-wired streaming module still reports', async () => {
    const h = buildHarness()
    const stats = turnStats({ totalTurnMs: 9000, stepCount: 7 })
    const flushed = vi.fn(async () => stats)
    // What `index.ts` does after this module is constructed: the real function
    // arrives later. Capturing the value at wiring time is the bug this locks.
    h.flushRef.current = flushed
    h.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    expect(flushed).toHaveBeenCalledWith(SESSION)
    expect(markdownOf(h.sent.at(-1))).toContain('🔄 7 steps')
    h.stop()
  })

  it('folds produced artifacts into the plan and the count line, like the reply path', async () => {
    const h = buildHarness({
      produceCard: 'delivery',
      stats: turnStats({
        deliverables: [{ path: 'notes/deck.pdf' }],
        produced: [
          { path: 'runs/chart.png', kind: 'image' },
          { path: 'src/helper.ts', kind: 'other' },
        ],
      }),
    })
    h.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    // Only the artifact-shaped write joins the plan; the source file stays out.
    const planned = h.plan.mock.calls[0]?.[0] as { files?: Array<{ path: string }> }
    expect(planned.files?.map(file => file.path)).toEqual(['notes/deck.pdf', 'runs/chart.png'])
    expect(markdownOf(h.sent.at(-1))).toContain(t.turnProducedLine(1))
    h.stop()
  })

  it('at compact, posts no Turn Complete card and mirrors the turn facts onto the answer card', async () => {
    // The answer card carries the summary (streaming wrote it), so the only
    // thing this module may still post is the delivery card for its rows.
    const h = buildHarness({ compact: true, stats: turnStats(), withDeliver: true, planRows: true, textDelivered: true })
    h.fire({ type: 'user/message', data: { content: [{ type: 'text', text: 'ETA reminder' }], source: { kind: 'schedule' } } })
    await flush()
    h.sent.length = 0
    h.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    const cards = h.sent.map(sent => sent.input.card).filter(Boolean) as Array<{ header?: { title?: { content?: string } } }>
    // One card: the delivery card. No Turn Complete card at this level.
    expect(cards.map(card => card.header?.title?.content)).toEqual([t.deliverablesCardTitle])
    h.stop()
  })

  it('at compact, posts a minimal completion card when no card carried the answer', async () => {
    // A mirrored turn whose step card never reached Feishu would otherwise end
    // with nothing on screen saying the turn is over.
    const h = buildHarness({ compact: true, stats: turnStats(), textDelivered: false })
    h.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    expect(h.sent).toHaveLength(1)
    const card = h.sent[0]?.input.card as { header?: { title?: { content?: string } } }
    expect(card.header?.title?.content).toBe(t.turnCompleteTitle)
    const md = markdownOf(h.sent[0])
    // Who woke the turn, that it is over, and the filtered facts.
    expect(md).toContain(t.turnCompleteExternalTurn(t.autoTurnTriggerName('request')))
    expect(md).toContain(`✅ ${t.turnSummaryDone}`)
    expect(md).toContain('🧠 m · 💡 high')
    expect(md).toContain('📊 10/1K (1%)')
    // The facts the level drops stay dropped.
    expect(md).not.toContain('🧠 LLM')
    expect(md).not.toContain('TTFT')
    h.stop()
  })

  it('hydrates the compact delivery card before sending it', async () => {
    const hydrateCard = vi.fn(async (card: object) => ({ ...card, hydrated: true }))
    const h = buildHarness({ compact: true, stats: turnStats(), withDeliver: true, planRows: true, textDelivered: true, hydrateCard })
    h.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    expect(hydrateCard).toHaveBeenCalledWith(expect.objectContaining({ schema: '2.0' }), '/w')
    expect((h.sent[0]?.input.card as { hydrated?: boolean }).hydrated).toBe(true)
    h.stop()
  })

  it('names the automation that woke the turn', async () => {    const h = buildHarness()
    // No human message at all: the schedule notice is what opened the turn.
    h.fire({ type: 'user/message', data: { content: [{ type: 'text', text: '自动化任务' }], source: { kind: 'schedule' } } })
    await flush()
    h.sent.length = 0
    h.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    const elements = (h.sent.at(-1)?.input.card as { body?: { elements?: Array<{ content?: string }> } })?.body?.elements ?? []
    expect(elements.some(element => element.content === t.turnCompleteExternalTurn(t.autoTurnTriggerName('schedule')))).toBe(true)
    h.stop()
  })

  it('falls back to the generic family for an unnamed non-human source', async () => {
    const h = buildHarness()
    h.fire({ type: 'user/message', data: { content: [{ type: 'text', text: 'something' }], source: { kind: 'some-future-producer' } } })
    await flush()
    h.sent.length = 0
    h.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    const elements = (h.sent.at(-1)?.input.card as { body?: { elements?: Array<{ content?: string }> } })?.body?.elements ?? []
    expect(elements.some(element => element.content === t.turnCompleteExternalTurn(t.autoTurnTriggerName('request')))).toBe(true)
    h.stop()
  })

  it('leaves a Feishu-started turn to the reply path (no second footer)', async () => {
    const h = buildHarness()
    noteFeishuPrompt(SESSION, 'req-mine')
    h.fire({ type: 'user/message', data: { content: [{ type: 'text', text: 'from feishu' }], source: { kind: 'user', rpcId: 'req-mine' } } })
    await flush()
    h.sent.length = 0
    h.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    expect(h.sent).toEqual([])
    h.stop()
  })

  it('completes a turn whose trigger family is unknown', async () => {
    const h = buildHarness()
    h.fire({ type: 'turn/start', data: { turn: 2 } })
    h.fire({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.input.card).toBeDefined()
    h.stop()
  })

  it('sends nothing when the setting is off, and wires the disposer', async () => {
    const off = buildHarness({ enabled: false })
    off.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    expect(off.sent).toEqual([])
    // The disposer is the listener removals the fake ctx handed back.
    expect(() => off.stop()).not.toThrow()

    const unbound = buildHarness({ bound: false })
    unbound.fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
    expect(unbound.sent).toEqual([])
    unbound.stop()
  })
})

describe('describeExternalMessage', () => {
  it('says nothing for an empty message', () => {
    expect(describeExternalMessage([], 'external-web', t)).toBe('')
    expect(describeExternalMessage([{ type: 'text', text: '   ' }], 'external-web', t)).toBe('')
  })

  it('clips a very long message', () => {
    const long = 'x'.repeat(2500)
    const out = describeExternalMessage([{ type: 'text', text: long }], 'external-other', t)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThan(2100)
  })
})
