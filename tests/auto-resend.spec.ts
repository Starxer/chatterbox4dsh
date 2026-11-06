import { afterEach, describe, expect, it, vi } from 'vitest'
import { startChannel } from '../src/channel.ts'
import { resolveConfig } from '../src/config.ts'
import { translationsFor } from '../src/i18n.ts'
import type { PendingTurn, PendingTurnClaim } from '../src/harness.ts'

const t = translationsFor('zh')

/** A pending turn as the harness would hand it back from `claimPendingTurns`. */
function pendingTurn(overrides: Partial<PendingTurn> = {}): PendingTurn {
  return {
    key: 'chat:chat',
    sessionId: 's1',
    chatId: 'chat',
    chatType: 'p2p',
    messageId: 'incoming',
    senderId: 'ou_1',
    content: 'GTDB 已经完成，对现有 MAG 数据做个报告',
    attachments: false,
    at: Date.now(),
    attempts: 1,
    ...overrides,
  }
}

async function setup(claim: PendingTurnClaim = { retry: [], giveUp: [] }) {
  vi.useFakeTimers()
  const handlers = new Map<string, (event: any) => Promise<void>>()
  const channel = {
    on: vi.fn((name: string, fn: (event: any) => Promise<void>) => { handlers.set(name, fn); return () => handlers.delete(name) }),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    send: vi.fn(async (_to: string, _input: unknown, _opts?: unknown) => ({ messageId: 'sent' })),
    addReaction: vi.fn(async () => 'react'),
    rawClient: { im: { v1: { messageResource: { get: vi.fn(async () => Buffer.alloc(0)) } } } },
  }
  const bridge = {
    reply: vi.fn(async (_message: any, options: any) => { options?.onAccepted?.(); return undefined }),
    resolveSessionIdFor: vi.fn(() => 's1'),
    noteTopic: vi.fn(),
    needsOnboarding: vi.fn(async () => false),
    consumeIntermediateSent: vi.fn(() => false),
    dispose: vi.fn(async () => undefined),
    notePendingTurn: vi.fn(),
    clearPendingTurn: vi.fn(),
    claimPendingTurns: vi.fn(() => claim),
  }
  const factory = vi.fn(() => channel as any)
  const stopped = await startChannel(
    resolveConfig({ appId: 'id', appSecret: 'placeholder', reactEmoji: '' }),
    bridge as any,
    factory,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    undefined,
    async () => undefined,
    undefined,
    undefined, undefined, undefined, undefined, undefined,
    { needsOnboarding: bridge.needsOnboarding, sendOnboardingCard: vi.fn(async () => undefined) },
    () => t,
    undefined, undefined, undefined, undefined, undefined,
    undefined,
  )
  const emit = async (content = 'hello') => handlers.get('message')!({
    messageId: 'incoming', chatId: 'chat', chatType: 'p2p', content, resources: [],
  })
  return { ...stopped, channel, bridge, emit }
}
afterEach(() => vi.useRealTimers())

describe('automatic resend of an interrupted turn', () => {
  it('waits for the fresh instance to settle, then replays the message through the normal pipeline', async () => {
    const s = await setup({ retry: [pendingTurn()], giveUp: [] })
    // Not before the delay: the unloaded instance's session handles are still closing.
    await vi.advanceTimersByTimeAsync(1_999)
    expect(s.channel.send).not.toHaveBeenCalled()
    expect(s.bridge.reply).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(s.channel.send).toHaveBeenCalledTimes(1)
    expect(s.channel.send.mock.calls[0]![1]).toEqual({ text: t.pendingTurnResendNotice })
    // The replayed message goes through the same dispatch path as real inbound
    // traffic — same session resolution, same cards.
    expect(s.bridge.reply).toHaveBeenCalledTimes(1)
    expect(s.bridge.reply.mock.calls[0]![0]).toMatchObject({
      chatId: 'chat',
      content: pendingTurn().content,
    })
    expect(s.bridge.notePendingTurn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'chat:chat', content: pendingTurn().content }),
      { keepAttempts: true },
    )
    // The replayed turn settles, so the record does not survive another reload.
    await vi.advanceTimersByTimeAsync(0)
    expect(s.bridge.clearPendingTurn).toHaveBeenCalledWith('chat:chat')
    await s.stop()
  })

  it('never replays a message whose attachments cannot be rebuilt — it asks for a manual resend', async () => {
    const s = await setup({ retry: [], giveUp: [{ turn: pendingTurn({ attachments: true }), reason: 'attachments' }] })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(s.bridge.reply).not.toHaveBeenCalled()
    expect(s.channel.send).toHaveBeenCalledTimes(1)
    expect(s.channel.send.mock.calls[0]![1]).toEqual({ text: t.pendingTurnAttachmentsNotice })
    await s.stop()
  })

  it('stays quiet for records too old to claim (the startup notice covers those)', async () => {
    const s = await setup({ retry: [], giveUp: [{ turn: pendingTurn({ at: Date.now() - 60 * 60_000, attempts: 0 }), reason: 'expired' }] })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(s.channel.send).not.toHaveBeenCalled()
    expect(s.bridge.reply).not.toHaveBeenCalled()
    await s.stop()
  })

  it('leaves the record for the next instance and posts no raw error when this instance is unloading', async () => {
    const s = await setup()
    let rejectReply: ((error: Error) => void) | undefined
    s.bridge.reply.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectReply = reject }))
    await s.emit('a message whose turn the reload kills')

    const stopping = s.stop()
    rejectReply!(new Error('session "s1": flush on a closed handle'))
    await stopping
    await vi.advanceTimersByTimeAsync(0)

    // No "处理这条消息时出错：… flush on a closed handle" text: the next start
    // resends it instead.
    for (const call of s.channel.send.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain('flush on a closed handle')
    }
    // And the pending record is deliberately NOT cleared on the way down.
    expect(s.bridge.clearPendingTurn).not.toHaveBeenCalled()
  })
})
