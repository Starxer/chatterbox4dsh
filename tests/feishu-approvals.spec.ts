import { describe, expect, it, vi } from 'vitest'
import { renderApprovalCard, startFeishuApprovals } from '../src/feishu-approvals.ts'
import { en, zh } from '../src/i18n.ts'

function entry(overrides: Record<string, unknown> = {}) {
  return {
    pendingId: 'feishu-a-abc123',
    approvalId: 'feishu-a-abc123',
    sessionId: 'session-1',
    chat: { chatId: 'oc_1', chatType: 'p2p' as const },
    toolName: 'bash',
    shortCode: 'abc123',
    createdAt: Date.now(),
    resolve: () => undefined,
    ...overrides,
  } as any
}

function elementsOf(card: any): any[] {
  return card.body.elements
}

function buttonTexts(elements: any[]): string[] {
  return elements.filter(el => el.tag === 'button').map(el => el.text.content)
}

describe('renderApprovalCard', () => {
  it('shows the asker-provided reason on the card', () => {
    const card = renderApprovalCard(entry({ reason: 'Run npm build in the workspace' }), en)
    const content = elementsOf(card)
      .filter(el => el.tag === 'markdown')
      .map(el => el.content)
      .join('\n')
    expect(content).toContain('**Reason:** Run npm build in the workspace')
  })

  it('omits the reason line when none is provided', () => {
    const card = renderApprovalCard(entry(), en)
    const content = elementsOf(card)
      .filter(el => el.tag === 'markdown')
      .map(el => el.content)
      .join('\n')
    expect(content).not.toContain('**Reason:**')
    expect(content).toContain('**Tool:** `bash`')
  })

  it('orders Approve (primary) above Reject (danger)', () => {
    const card = renderApprovalCard(entry(), en)
    const buttons = elementsOf(card).filter(el => el.tag === 'button')
    expect(buttons[0].text.content).toBe(en.approvalApproveOnce)
    expect(buttons[0].type).toBe('primary')
    expect(buttons[1].text.content).toBe(en.approvalReject)
    expect(buttons[1].type).toBe('danger')
    expect(buttonTexts(elementsOf(card))).toEqual([en.approvalApproveOnce, en.approvalReject])
  })

  it('renders the whole card in the active locale', () => {
    const card = renderApprovalCard(entry({ reason: '执行 npm build' }), zh)
    expect((card as any).header.title.content).toBe(zh.approvalCardTitle)
    expect(buttonTexts(elementsOf(card))).toEqual([zh.approvalApproveOnce, zh.approvalReject])
    const content = elementsOf(card)
      .filter((el: any) => el.tag === 'markdown')
      .map((el: any) => el.content)
      .join('\n')
    expect(content).toContain(`${zh.approvalToolLabel} \`bash\``)
    expect(content).toContain(zh.approvalReasonLabel)
    expect(content).not.toContain('Approval')
  })
})

/** Build a fake host context plus the synthesized request shape. */
function buildCtx() {
  const listeners: Array<(request: any, next?: () => Promise<any>) => Promise<any>> = []
  const handle: { lastRequest: any } = { lastRequest: undefined }
  const ctx = {
    on: (event: string, listener: (request: any, next?: () => Promise<any>) => Promise<any>) => {
      if (event === 'approval/request') listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  } as any
  return {
    ctx,
    get lastRequest() { return handle.lastRequest },
    async trigger(sessionId: string, next?: () => Promise<any>, signal?: AbortSignal) {
      const listener = listeners[0]
      if (listener === undefined) return undefined
      const request = {
        agent: { session: { id: sessionId } },
        toolName: 'bash',
        ...(signal === undefined ? {} : { signal }),
      }
      handle.lastRequest = request
      return await listener(request, next ?? (async () => 'unavailable'))
    },
  }
}

/** Extract the plugin's pendingId from the rendered approval card. */
function pendingIdOf(card: any): string {
  const button = elementsOf(card).find((el: any) => el.tag === 'button')
  return JSON.parse(button.value).pendingId
}

function buildApprovalsHarness() {
  const ctxHandle = buildCtx()
  const sent: Array<{ to: string; card: any }> = []
  const updated: Array<{ messageId: string; card: any }> = []
  let cardActionHandler: ((evt: any) => void | Promise<void>) | undefined
  const channel = {
    send: vi.fn(async (to: string, input: { card: object }) => {
      sent.push({ to, card: input.card })
      return { messageId: 'om_approval' }
    }),
    updateCard: vi.fn(async (messageId: string, card: object) => {
      updated.push({ messageId, card })
    }),
    onCardAction: (handler: (evt: any) => void | Promise<void>) => {
      cardActionHandler = handler
      return () => { cardActionHandler = undefined }
    },
  } as any
  const bridgeHolder = {
    current: { resolveChat: () => ({ chatId: 'oc_1', chatType: 'p2p' as const }) },
  } as any
  const handle = startFeishuApprovals({
    ctx: ctxHandle.ctx,
    channel,
    bridgeHolder,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    getTranslations: () => zh,
  })
  return { ctxHandle, sent, updated, channel, handle, action: () => cardActionHandler }
}

describe('startFeishuApprovals', () => {
  it('settles on Feishu and releases the forwarded Web UI surface', async () => {
    const h = buildApprovalsHarness()
    try {
      const answer = h.ctxHandle.trigger('session-1', () => new Promise(() => {}))
      await new Promise(resolve => setImmediate(resolve))
      expect(h.sent).toHaveLength(1)
      await h.action()!({
        action: { tag: 'button', value: JSON.stringify({ pendingId: pendingIdOf(h.sent[0]!.card) }) },
      })
      await expect(answer).resolves.toBe('allowed-once')
      // Aborting the gate is what makes the browser drop its approval card.
      expect(h.ctxHandle.lastRequest?.signal?.aborted).toBe(true)
    } finally {
      h.handle.stop()
    }
  })

  it('takes the Web UI outcome and retires the Feishu card', async () => {
    const h = buildApprovalsHarness()
    try {
      const answer = h.ctxHandle.trigger('session-1', async () => 'rejected')
      await expect(answer).resolves.toBe('rejected')
      expect(h.sent).toHaveLength(1)
      expect(h.updated).toHaveLength(1)
      const retired = JSON.stringify(h.updated[0]!.card)
      expect(retired).toContain(zh.cardAnsweredElsewhereTitle)
      // The retired card still reports what the Web UI decided.
      expect(retired).toContain('bash')
      expect(retired).toContain('已拒绝')
    } finally {
      h.handle.stop()
    }
  })

  it('keeps waiting on Feishu when the Web UI answerer gives up', async () => {
    const h = buildApprovalsHarness()
    try {
      const answer = h.ctxHandle.trigger('session-1', async () => 'unavailable')
      await new Promise(resolve => setImmediate(resolve))
      await h.action()!({
        action: { tag: 'button', value: JSON.stringify({ pendingId: pendingIdOf(h.sent[0]!.card), outcome: 'rejected' }) },
      })
      await expect(answer).resolves.toBe('rejected')
      expect(h.ctxHandle.lastRequest?.signal?.aborted).toBe(true)
    } finally {
      h.handle.stop()
    }
  })

  it('retires the card when the turn is aborted before an answer', async () => {
    const h = buildApprovalsHarness()
    try {
      const turn = new AbortController()
      const answer = h.ctxHandle.trigger('session-1', async () => 'unavailable', turn.signal)
      await new Promise(resolve => setImmediate(resolve))
      expect(h.sent).toHaveLength(1)
      turn.abort(new Error('turn stopped'))
      await expect(answer).resolves.toBe('unavailable')
      // The card must stop looking answerable once its pending entry is gone.
      expect(h.updated).toHaveLength(1)
      expect(JSON.stringify(h.updated[0]!.card)).toContain(zh.approvalExpiredTitle)
      expect(JSON.stringify(h.updated[0]!.card)).not.toContain('button')
    } finally {
      h.handle.stop()
    }
  })

  it('accepts an object-shaped button value, not only Feishu\'s double-encoded string', async () => {
    const h = buildApprovalsHarness()
    try {
      const answer = h.ctxHandle.trigger('session-1', () => new Promise(() => {}))
      await new Promise(resolve => setImmediate(resolve))
      await h.action()!({
        action: { tag: 'button', value: { pendingId: pendingIdOf(h.sent[0]!.card) } },
      })
      await expect(answer).resolves.toBe('allowed-once')
    } finally {
      h.handle.stop()
    }
  })
})
