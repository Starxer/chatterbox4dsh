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
    flushed: async () => options.stats,
    sessionMeta: async () => ({ workspace: '/w', model: 'm' }),
    ...(options.withDeliver === false ? {} : { deliver: { plan, autoSend } }),
    noteCardTopic: (messageId, topic) => { topics.push({ messageId, topic }) },
    enabled: () => options.enabled !== false,
  })
  return {
    sent,
    topics,
    plan,
    autoSend,
    stop: controller.stop,
    fire: event => {
      for (const listener of listeners) listener({ id: SESSION }, event)
    },
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

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

  it('names the automation that woke the turn', async () => {
    const h = buildHarness()
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
