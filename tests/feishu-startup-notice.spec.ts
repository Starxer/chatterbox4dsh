import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendStartupNotice, sendStartupNoticeOnce } from '../src/feishu-startup-notice.ts'
import type { Translations } from '../src/i18n.ts'
import type { HarnessConversationService } from '../src/harness.ts'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'

const t = {
  startupNoticeConnected: 'CONNECTED',
  startupNoticeInterrupted: 'INTERRUPTED',
} as unknown as Translations

const NOTICE_FLAG = Symbol.for('dsh-feishu.startup-notice')

interface FakeBridge {
  recentActiveSessions(sessionId?: number): Array<{ sessionId: string, interrupted: boolean }>
  resolveChat(sessionId: string): { chatId: string, chatType: 'p2p', threadId?: string, rootId?: string } | undefined
  clearInterrupted(sessionId: string): void
}

function fakeBridge(
  sessions: Array<{ sessionId: string, interrupted: boolean }>,
  chats: Record<string, { chatId: string, chatType: 'p2p', threadId?: string, rootId?: string } | undefined> = {},
): { bridge: HarnessConversationService, clearInterrupted: ReturnType<typeof vi.fn> } {
  const clearInterrupted = vi.fn()
  const bridge: FakeBridge = {
    recentActiveSessions: () => sessions,
    // A key present with `undefined` explicitly means "bound to no chat".
    resolveChat: sessionId => Object.hasOwn(chats, sessionId)
      ? chats[sessionId]
      : { chatId: `chat-${sessionId}`, chatType: 'p2p' },
    clearInterrupted,
  }
  return { bridge: bridge as unknown as HarnessConversationService, clearInterrupted }
}

function fakeChannel(send = vi.fn(async () => ({ messageId: 'm' }))): { channel: LarkChannel, send: ReturnType<typeof vi.fn> } {
  return { channel: { send } as unknown as LarkChannel, send }
}

function deps(bridge: HarnessConversationService | undefined, channel: LarkChannel | undefined) {
  return {
    bridgeHolder: { current: bridge },
    channelHolder: { current: channel },
    getTranslations: () => t,
    logger: { warn: vi.fn() },
  }
}

beforeEach(() => {
  // The once-per-process guard is keyed by pid; tests must start clean.
  delete (globalThis as unknown as Record<symbol, unknown>)[NOTICE_FLAG]
})

describe('sendStartupNotice', () => {
  it('notifies the most recent chat-bound session and warns when its turn was interrupted', async () => {
    const { bridge, clearInterrupted } = fakeBridge([
      { sessionId: 'web-only', interrupted: false },
      { sessionId: 'bound', interrupted: true },
    ], { 'web-only': undefined })
    const { channel, send } = fakeChannel()

    const result = await sendStartupNotice(deps(bridge, channel))
    expect(result).toEqual({ sent: true, sessionId: 'bound', chatId: 'chat-bound', interrupted: true })
    expect(send).toHaveBeenCalledWith('chat-bound', { text: 'CONNECTED\nINTERRUPTED' }, {})
    expect(clearInterrupted).toHaveBeenCalledWith('bound')
  })

  it('sends only the connected line when the turn ended normally', async () => {
    const { bridge, clearInterrupted } = fakeBridge([{ sessionId: 'bound', interrupted: false }])
    const { channel, send } = fakeChannel()

    const result = await sendStartupNotice(deps(bridge, channel))
    expect(result.sent).toBe(true)
    expect(send).toHaveBeenCalledWith('chat-bound', { text: 'CONNECTED' }, {})
    expect(clearInterrupted).not.toHaveBeenCalled()
  })

  it('keeps a topic reply inside its topic', async () => {
    const { bridge } = fakeBridge([{ sessionId: 'topic', interrupted: false }], {
      topic: { chatId: 'oc_x', chatType: 'p2p', threadId: 'omt_x', rootId: 'om_root' },
    })
    const { channel, send } = fakeChannel()

    await sendStartupNotice(deps(bridge, channel))
    expect(send).toHaveBeenCalledWith('oc_x', { text: 'CONNECTED' }, { replyInThread: true, replyTo: 'om_root' })
  })

  it('stays silent when no chat-bound session exists', async () => {
    const { bridge } = fakeBridge([{ sessionId: 'web', interrupted: false }], { web: undefined })
    const { channel, send } = fakeChannel()

    const result = await sendStartupNotice(deps(bridge, channel))
    expect(result).toEqual({ sent: false, reason: 'no-bound-session' })
    expect(send).not.toHaveBeenCalled()
  })

  it('reports a failed send and keeps the interrupted marker', async () => {
    const { bridge, clearInterrupted } = fakeBridge([{ sessionId: 'bound', interrupted: true }])
    const send = vi.fn(async () => { throw new Error('boom') })
    const result = await sendStartupNotice(deps(bridge, fakeChannel(send).channel))

    expect(result.sent).toBe(false)
    expect(result.reason).toBe('send-failed')
    expect(clearInterrupted).not.toHaveBeenCalled()
  })

  it('does nothing without a bridge or channel', async () => {
    expect(await sendStartupNotice(deps(undefined, fakeChannel().channel))).toEqual({ sent: false, reason: 'no-bridge' })
    expect(await sendStartupNotice(deps(fakeBridge([]).bridge, undefined))).toEqual({ sent: false, reason: 'no-channel' })
  })
})

describe('sendStartupNoticeOnce', () => {
  it('notifies only once per process', async () => {
    const { bridge } = fakeBridge([{ sessionId: 'bound', interrupted: false }])
    const { channel, send } = fakeChannel()
    const d = deps(bridge, channel)

    await sendStartupNoticeOnce(d)
    await sendStartupNoticeOnce(d)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
