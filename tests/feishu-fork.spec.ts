import { describe, expect, it, vi } from 'vitest'
import { FORK_ACTION, renderForkTurnsCard, startFeishuFork } from '../src/feishu-fork.ts'
import { translationsFor } from '../src/i18n.ts'
import type { CompletedTurn } from '../src/turn-history.ts'
import type { ConversationMessage } from '../src/conversation.ts'

const zh = translationsFor('zh')
const chat = { chatId: 'oc_1', chatType: 'p2p' } as unknown as ConversationMessage
const turns: CompletedTurn[] = [
  { turn: 1, endSeq: 3, preview: 'first question' },
  { turn: 2, endSeq: 8, preview: 'second question' },
]

type Sent = { to: string; card?: object; text?: string }

function harness(options: { turns?: readonly CompletedTurn[] | undefined; sessionController?: any } = {}) {
  const sent: Sent[] = []
  const handlers = new Set<(event: any) => void | Promise<void>>()
  const channel = {
    send: vi.fn(async (to: string, input: { card?: object; text?: string }) => {
      sent.push({ to, ...input })
      return { messageId: `m-${sent.length}` }
    }),
    onCardAction: vi.fn((handler: (event: any) => void | Promise<void>) => {
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    }),
  }
  const bridge = {
    resolveSessionIdFor: vi.fn(() => 'session-1'),
    listTurns: vi.fn(async () => options.turns ?? turns),
  }
  const sessionController = options.sessionController ?? { fork: vi.fn(async () => ({ sessionId: 'new-1' })) }
  const logger = { warn: vi.fn() }
  const handle = startFeishuFork({
    channel: channel as any,
    bridgeHolder: { current: bridge },
    sessionController,
    logger,
    getTranslations: () => zh,
  })
  const click = async (event: unknown): Promise<void> => {
    for (const handler of [...handlers]) await handler(event)
  }
  return { sent, channel, bridge, sessionController, handle, click, logger }
}

describe('renderForkTurnsCard', () => {
  it('lists newest first with previews and summarises the omitted older turns', () => {
    const card = renderForkTurnsCard(turns, zh, 3) as any
    const collect = (elements: any[]): string[] => elements.flatMap((element: any) =>
      element.tag === 'markdown'
        ? [String(element.content ?? '')]
        : Array.isArray(element.elements) ? collect(element.elements) : [])
    const markdown = collect(card.body.elements).join('\n')
    expect(markdown).toContain(zh.forkCardHint)
    expect(markdown).toContain('first question')
    expect(markdown).toContain('second question')
    expect(markdown.indexOf('second question')).toBeLessThan(markdown.indexOf('first question'))
    expect(markdown).toContain(zh.forkMoreTurns(3))
    const rows = card.body.elements.filter((element: any) => element.tag === 'interactive_container')
    expect(rows).toHaveLength(2)
    expect(rows[0].behaviors[0].value).toEqual({ p: FORK_ACTION, turn: 2 })
  })
})

describe('startFeishuFork', () => {
  it('opens a picker for the chat bound session', async () => {
    const h = harness()
    await h.handle.openCard(chat)
    expect(h.bridge.resolveSessionIdFor).toHaveBeenCalledWith(chat)
    expect(h.bridge.listTurns).toHaveBeenCalled()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.to).toBe('oc_1')
    expect(h.sent[0]!.card).toBeDefined()
  })

  it('forks at the tapped turn and reports the new session id', async () => {
    const h = harness()
    await h.handle.openCard(chat)
    await h.click({ chatId: 'oc_1', messageId: 'm-1', action: { value: { p: FORK_ACTION, turn: 1 } } })
    expect(h.sessionController.fork).toHaveBeenCalledWith({ sessionId: 'session-1', atSeq: 3 })
    const payload = JSON.stringify(h.sent.at(-1)!.card)
    expect(payload).toContain(JSON.stringify(zh.forkSuccess(1, 'new-1')).slice(1, -1))
  })

  it('forks a direct `/fork <turn>` without a card', async () => {
    const h = harness()
    const result = await h.handle.forkAtTurn(chat, 2)
    expect(result.kind).toBe('success')
    expect(h.sessionController.fork).toHaveBeenCalledWith({ sessionId: 'session-1', atSeq: 8 })
    expect(result.text).toContain('new-1')
  })

  it('reports an unknown turn instead of forking', async () => {
    const h = harness()
    const result = await h.handle.forkAtTurn(chat, 9)
    expect(result.kind).toBe('error')
    expect(h.sessionController.fork).not.toHaveBeenCalled()
  })

  it('degrades when the deployment exposes no fork', async () => {
    const h = harness({ sessionController: {} })
    const result = await h.handle.forkAtTurn(chat, 1)
    expect(result.kind).toBe('error')
    expect(result.text).toBe(zh.forkUnsupported)
  })

  it('tells the chat when no session is bound yet', async () => {
    const h = harness()
    h.bridge.resolveSessionIdFor.mockReturnValue('')
    await h.handle.openCard(chat)
    expect(h.sent[0]!.text).toBe(zh.forkNoSession)
  })

  it('ignores taps on cards it did not send', async () => {
    const h = harness()
    await h.click({ chatId: 'oc_1', messageId: 'someone-else', action: { value: { p: FORK_ACTION, turn: 1 } } })
    expect(h.sessionController.fork).not.toHaveBeenCalled()
  })
})
