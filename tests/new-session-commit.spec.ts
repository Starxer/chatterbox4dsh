import { describe, expect, it, vi } from 'vitest'
import { commitNewSession } from '../src/index.ts'

/**
 * O19: the workspace is registered at the flow's LAST step, and — for a path the
 * operator confirmed creating — `mkdir -p` runs immediately before the session
 * that needs it. These two tests pin that ORDER, which is the whole point of
 * moving registration out of the picker step.
 */
function harness() {
  const order: string[] = []
  const bridge = {
    startNewSession: vi.fn(() => {
      order.push('startNewSession')
      return 'session-1'
    }),
  }
  const cardChannel = {
    createCardInstance: vi.fn(async () => 'card-1'),
    sendCardByReference: vi.fn(async () => ({ messageId: 'm-1' })),
    updateCard: vi.fn(async () => undefined),
  }
  return { order, bridge, cardChannel }
}

const chat = { chatId: 'oc_1', chatType: 'p2p' } as never

describe('commitNewSession: workspace preparation (O19)', () => {
  it('prepares the workspace before the session is created', async () => {
    const { order, bridge, cardChannel } = harness()
    await commitNewSession(
      bridge as never, cardChannel as never, chat, { workspace: '/w/new-app' } as never,
      undefined, undefined, undefined,
      {
        prepareWorkspace: async () => {
          order.push('mkdir')
          order.push('register')
        },
      },
    )
    expect(order).toEqual(['mkdir', 'register', 'startNewSession'])
    expect(bridge.startNewSession).toHaveBeenCalledOnce()
  })

  it('does not create a session when the workspace cannot be prepared', async () => {
    const { bridge, cardChannel } = harness()
    let painted: object | undefined
    await commitNewSession(
      bridge as never, cardChannel as never, chat, { workspace: '/w/broken' } as never,
      undefined, undefined,
      { cardId: 'card-1', paint: async (card: object) => { painted = card } },
      { prepareWorkspace: async () => { throw new Error('EACCES: permission denied') } },
    )
    // No session, and the operator is told why on the card they pressed.
    expect(bridge.startNewSession).not.toHaveBeenCalled()
    expect(JSON.stringify(painted)).toContain('EACCES')
    expect(JSON.stringify(painted)).toContain('会话没有创建')
  })

  it('keeps working when no preparation hook is given (slash-command path)', async () => {
    const { bridge, cardChannel } = harness()
    const paint = vi.fn(async () => undefined)
    await commitNewSession(
      bridge as never, cardChannel as never, chat, { workspace: '/w' } as never,
      undefined, undefined, { cardId: 'card-1', paint },
    )
    expect(bridge.startNewSession).toHaveBeenCalledOnce()
    expect(paint).toHaveBeenCalledOnce()
  })
})
