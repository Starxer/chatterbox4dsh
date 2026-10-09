import { describe, expect, it, vi } from 'vitest'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { startFeishuQuestions } from '../src/feishu-questions.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('en')

const QUESTION: AskUserQuestionItem = {
  id: 'q1',
  question: 'Pick one',
  header: 'Choice',
  options: [
    { label: 'Yes', description: 'approve' },
    { label: 'No', description: 'decline' },
  ],
  multiSelect: false,
}

interface Harness {
  /** Resolved answers captured from listener return values. */
  answered: Array<{ sessionId: string; answer: AskUserQuestionAnswer }>
  sentCards: Array<{ to: string; card: { schema?: string; header?: { title?: { content?: string } }; body?: { elements?: unknown[] }; elements?: unknown[] } }>
  updatedCards: Array<{ messageId?: string; card: { body?: { elements?: Array<{ tag?: string; content?: string }> } } }>
  cardActionHandler: ((evt: unknown) => void | Promise<void>) | undefined
  resolveChatCalls: string[]
}

interface CtxHandle {
  ctx: Parameters<typeof startFeishuQuestions>[0]['ctx']
  /** Fire one user-questions request through the registered waterfall. */
  trigger: (
    sessionId: string,
    questions: AskUserQuestionItem[],
    agent?: { session: { id: string } },
    next?: () => Promise<AskUserQuestionAnswer>,
  ) => Promise<AskUserQuestionAnswer | undefined>
  /** The request object the listener received, for signal-gate assertions. */
  lastRequest: AskUserQuestionRequest | undefined
}

/**
 * Build a fake Context that records the `user-questions/request` listener
 * the plugin registers, and exposes a `trigger()` helper that invokes the
 * listener with a synthetic request. The listener's return value (or
 * undefined when it calls `next()`) is the resolved answer.
 */
function buildCtx(): CtxHandle {
  const listeners: Array<(request: AskUserQuestionRequest, next?: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer | undefined>> = []
  const handle: { lastRequest: AskUserQuestionRequest | undefined } = { lastRequest: undefined }
  const ctx = {
    on: (_event: string, listener: (request: AskUserQuestionRequest, next?: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer | undefined>) => {
      if (_event === 'user-questions/request') listeners.push(listener)
      return () => {
        const idx = listeners.indexOf(listener)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  } as unknown as Parameters<typeof startFeishuQuestions>[0]['ctx']

  return {
    ctx,
    get lastRequest() { return handle.lastRequest },
    trigger: async (sessionId, questions, agent, next) => {
      const listener = listeners[0]
      if (listener === undefined) return undefined
      const request: AskUserQuestionRequest = {
        questions,
        ...(agent !== undefined ? { agent: { session: { id: sessionId } } as never } : {}),
      }
      handle.lastRequest = request
      const result = await listener(request, next ?? (async () => {
        throw new Error('no fallback answerer in test')
      }))
      return result
    },
  }
}

interface ChannelHandle {
  channel: Parameters<typeof startFeishuQuestions>[0]['channel']
  cleanup: () => void
}

function buildChannel(harness: Harness): ChannelHandle {
  const cardUnsubFns: Array<() => void> = []
  let sent = 0
  const channel = {
    send: vi.fn(async (to: string, input: { card?: object; text?: string }) => {
      if (input.card !== undefined) {
        harness.sentCards.push({ to, card: input.card as Harness['sentCards'][0]['card'] })
      }
      sent += 1
      return { messageId: sent === 1 ? 'om_question_card' : `om_question_card_${sent}` }
    }),
    updateCard: vi.fn(async (messageId: string, card: any) => {
      harness.updatedCards.push({ messageId, card })
    }),
    onCardAction: (handler: (evt: unknown) => void | Promise<void>) => {
      harness.cardActionHandler = handler
      const unsub = () => { harness.cardActionHandler = undefined }
      cardUnsubFns.push(unsub)
      return unsub
    },
  } as unknown as Parameters<typeof startFeishuQuestions>[0]['channel']
  return {
    channel,
    cleanup: () => { for (const fn of cardUnsubFns) fn() },
  }
}

function buildBridgeHolder(resolveChat: (sessionId: string) => { chatId: string; chatType: 'p2p' } | undefined, harness: Harness) {
  const bridge = {
    resolveChat: vi.fn((sessionId: string) => {
      harness.resolveChatCalls.push(sessionId)
      return resolveChat(sessionId)
    }),
  }
  return { current: bridge as unknown as Parameters<typeof startFeishuQuestions>[0]['bridgeHolder']['current'] }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

/** Boot the listener against a fresh fake context/channel/bridge. */
function startHarness() {
  const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
  const ctxHandle = buildCtx()
  const { channel, cleanup } = buildChannel(harness)
  const bridgeHolder = buildBridgeHolder(
    () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
    harness,
  )
  const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
  return { harness, ctxHandle, channel, stop, cleanup }
}

/** Every markdown element's content in a rendered card, in document order. */
/**
 * The batch commits on its FINAL card (operator's 2026-10-09 redesign): after an
 * answer the last card on screen is the one carrying 确认提交.
 */
async function commitBatch(harness: Harness, questionId = 'q1'): Promise<void> {
  await clickValue(harness, { pendingId: extractPendingId(lastCard(harness)), questionId, type: 'batch-confirm' })
  await new Promise(resolve => setImmediate(resolve))
}

function cardMarkdown(card: Harness['sentCards'][0]['card']): string {
  const parts: string[] = []
  const walk = (els: unknown[]): void => {
    for (const el of els) {
      if (el === null || typeof el !== 'object') continue
      const obj = el as Record<string, unknown>
      if (obj.tag === 'markdown' && typeof obj.content === 'string') parts.push(obj.content)
      if (Array.isArray(obj.elements)) walk(obj.elements as unknown[])
    }
  }
  walk((card.body?.elements ?? []) as unknown[])
  return parts.join('\n')
}

/** Depth-first collect of every element whose tag matches. */
function elementsByTag(card: Harness['sentCards'][0]['card'], tag: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = []
  const walk = (els: unknown[]): void => {
    for (const el of els) {
      if (el === null || typeof el !== 'object') continue
      const obj = el as Record<string, unknown>
      if (obj.tag === tag) found.push(obj)
      if (Array.isArray(obj.elements)) walk(obj.elements as unknown[])
    }
  }
  walk((card.body?.elements ?? []) as unknown[])
  return found
}

/** Single-select option rows (workspace-picker style clickable containers). */
function optionRows(card: Harness['sentCards'][0]['card']): Array<Record<string, unknown>> {
  return elementsByTag(card, 'interactive_container').filter(row => {
    const behaviors = row.behaviors
    if (!Array.isArray(behaviors)) return false
    return behaviors.some(behavior => {
      const value = (behavior as Record<string, unknown>)?.value
      if (value === null || typeof value !== 'object') return false
      const selected = (value as Record<string, unknown>).selected
      return Array.isArray(selected) && selected.length > 0
    })
  })
}

/** Fire one card action carrying the given callback value. */
function clickValue(harness: Harness, value: unknown, messageId?: string): Promise<void> {
  return Promise.resolve(harness.cardActionHandler!({
    ...(messageId !== undefined ? { messageId } : {}),
    action: { tag: 'button', value },
  }))
}

/** The most recently sent card (the confirmation card after a row tap). */
function lastCard(harness: Harness): Harness['sentCards'][0]['card'] {
  return harness.sentCards[harness.sentCards.length - 1]!.card
}

/** True when the card carries a button whose callback `type` matches. */
function hasCallbackType(card: Harness['sentCards'][0]['card'], type: string): boolean {
  return elementsByTag(card, 'button').some(button => {
    const behaviors = button.behaviors
    if (!Array.isArray(behaviors)) return false
    return behaviors.some(behavior => {
      const value = (behavior as Record<string, unknown>)?.value
      return value !== null && typeof value === 'object' && (value as Record<string, unknown>).type === type
    })
  })
}

/** The callback value of a clickable row. */
function rowValue(row: Record<string, unknown>): unknown {
  const behaviors = row.behaviors as Array<{ value?: unknown }>
  return behaviors[0]?.value
}

/** Option-pick buttons: those whose callback carries a NON-EMPTY `selected` array. */
function optionButtons(card: Harness['sentCards'][0]['card']): Array<Record<string, unknown>> {
  return elementsByTag(card, 'button').filter(button => {
    const behaviors = button.behaviors
    if (!Array.isArray(behaviors)) return false
    return behaviors.some(behavior => {
      const value = (behavior as Record<string, unknown>)?.value
      if (value === null || typeof value !== 'object') return false
      const selected = (value as Record<string, unknown>).selected
      return Array.isArray(selected) && selected.length > 0
    })
  })
}

const MULTI_QUESTION: AskUserQuestionItem = {
  id: 'q1',
  question: 'Which parts?',
  header: 'Scope',
  multiSelect: true,
  options: [
    { label: 'db', description: '152G' },
    { label: 'work', description: '110G' },
    { label: 'neither' },
  ],
}

describe('startFeishuQuestions', () => {
  it('renders an interactive card and resolves when the user clicks an option', async () => {
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    try {
      // Fire the request; it will suspend waiting for a cardAction.
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.sentCards).toHaveLength(1)
      expect(harness.sentCards[0]!.to).toBe('oc_chat')
      expect(harness.sentCards[0]!.card.body?.elements).toBeDefined()
      // Simulate the user picking an option via cardAction.
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: extractPendingId(harness.sentCards[0]!.card), questionId: 'q1', selected: ['Yes'] }),
        },
      })
      await commitBatch(harness)
      const answer = await answerPromise
      expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['Yes'] }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('renders one card per question and commits the set on the final card', async () => {
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    const Q2: AskUserQuestionItem = { id: 'q2', question: 'Second?', options: [{ label: 'B' }, { label: 'C' }] }
    const tapRow = async (cardIndex: number, rowIndex: number): Promise<void> => {
      const rows = optionRows(harness.sentCards[cardIndex]!.card)
      await harness.cardActionHandler!({
        action: { tag: 'interactive_container', value: rowValue(rows[rowIndex]!) },
      })
      await new Promise(resolve => setImmediate(resolve))
    }
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION, Q2], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.sentCards).toHaveLength(1)
      // Tapping a row IS the answer: no confirmation tap, and a receipt goes out
      // recording it.
      await tapRow(0, 0)
      // Card 2 is the receipt for the answer; the loop goes straight on to the
      // next question, whose card is #3.
      expect(cardMarkdown(harness.sentCards[1]!.card)).toContain(t.questionReceiptAnswer('**Yes**'))
      expect(hasCallbackType(harness.sentCards[1]!.card, 'answer-back')).toBe(true)
      expect(harness.sentCards).toHaveLength(3)
      expect(cardMarkdown(harness.sentCards[2]!.card)).toContain('Second?')
      await tapRow(2, 0)
      // …and the LAST answer is recorded by the final card itself (no receipt).
      expect(harness.sentCards).toHaveLength(4)
      const batchCard = harness.sentCards[3]!.card
      const batchMarkdown = cardMarkdown(batchCard)
      expect(batchMarkdown).toContain('Yes')
      expect(batchMarkdown).toContain('B')
      expect(hasCallbackType(batchCard, 'batch-confirm')).toBe(true)
      expect(hasCallbackType(batchCard, 'batch-back')).toBe(true)
      await clickValue(harness, {
        pendingId: extractPendingId(batchCard), questionId: 'q1', type: 'batch-confirm',
      })
      const answer = await answerPromise
      expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['Yes'] }, { id: 'q2', selected: ['B'] }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('re-asks the last question when the final card goes back one', async () => {
    const { harness, ctxHandle, stop, cleanup } = startHarness()
    const Q2: AskUserQuestionItem = { id: 'q2', question: 'Second?', options: [{ label: 'B' }, { label: 'C' }] }
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION, Q2], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const tap = async (cardIndex: number, rowIndex: number): Promise<void> => {
        const rows = optionRows(harness.sentCards[cardIndex]!.card)
        await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(rows[rowIndex]!) } })
        await new Promise(resolve => setImmediate(resolve))
      }
      await tap(0, 0)   // q1 -> Yes
      await tap(2, 1)   // q2 -> C
      expect(harness.sentCards).toHaveLength(4)
      await clickValue(harness, {
        pendingId: extractPendingId(harness.sentCards[3]!.card), questionId: 'q2', type: 'batch-back',
      })
      await new Promise(resolve => setImmediate(resolve))
      // A FRESH card for the last question (a spent card never delivers another
      // row tap), and the old batch card is retired in place.
      expect(harness.sentCards).toHaveLength(5)
      const freshRows = optionRows(harness.sentCards[4]!.card)
      expect(freshRows).toHaveLength(2)
      await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(freshRows[0]!) } })
      await new Promise(resolve => setImmediate(resolve))
      // Answering it again posts a NEW final card, and that one commits.
      expect(harness.sentCards).toHaveLength(6)
      await clickValue(harness, {
        pendingId: extractPendingId(harness.sentCards[5]!.card), questionId: 'q1', type: 'batch-confirm',
      })
      await expect(answerPromise).resolves.toEqual({
        answers: [{ id: 'q1', selected: ['Yes'] }, { id: 'q2', selected: ['B'] }],
      })
    } finally {
      stop()
      cleanup()
    }
  })

  it('undoes one answer from its receipt and re-asks that question', async () => {
    const { harness, ctxHandle, stop, cleanup } = startHarness()
    const Q2: AskUserQuestionItem = { id: 'q2', question: 'Second?', options: [{ label: 'B' }, { label: 'C' }] }
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION, Q2], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const tap = async (cardIndex: number, rowIndex: number): Promise<void> => {
        const rows = optionRows(harness.sentCards[cardIndex]!.card)
        await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(rows[rowIndex]!) } })
        await new Promise(resolve => setImmediate(resolve))
      }
      await tap(0, 0)   // q1 -> Yes, receipt posted
      await tap(2, 0)   // q2 -> B, final card posted
      // Undo question 1 from its receipt: the receipt is retired and that
      // question comes back on a fresh card.
      const receipt = harness.sentCards[1]!.card
      await clickValue(harness, {
        pendingId: extractPendingId(receipt), questionId: 'q1', type: 'answer-back',
      }, 'om_question_card_2')
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.updatedCards.some(call => call.messageId === 'om_question_card_2'
        && cardMarkdown(call.card as Harness['sentCards'][0]['card']).includes(t.questionReceiptUndone))).toBe(true)
      const freshRows = optionRows(harness.sentCards[harness.sentCards.length - 1]!.card)
      expect(freshRows).toHaveLength(2)
      await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(freshRows[1]!) } })
      await new Promise(resolve => setImmediate(resolve))
      await clickValue(harness, {
        pendingId: extractPendingId(lastCard(harness)), questionId: 'q1', type: 'batch-confirm',
      })
      await expect(answerPromise).resolves.toEqual({
        answers: [{ id: 'q1', selected: ['No'] }, { id: 'q2', selected: ['B'] }],
      })
    } finally {
      stop()
      cleanup()
    }
  })

  it('resolves custom answer from form_value', async () => {
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.sentCards).toHaveLength(1)
      const pendingId = extractPendingId(harness.sentCards[0]!.card)
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId, questionId: 'q1', type: 'custom' }),
        },
        raw: {
          action: {
            value: JSON.stringify({ pendingId, questionId: 'q1', type: 'custom' }),
            form_value: { custom_text: '自定义回答' },
          },
        },
      })
      await commitBatch(harness)
      const answer = await answerPromise
      expect(answer).toEqual({ answers: [{ id: 'q1', selected: [], custom: '自定义回答' }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('ignores custom submit with empty input', async () => {
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const pendingId = extractPendingId(harness.sentCards[0]!.card)
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId, questionId: 'q1', type: 'custom' }),
        },
        raw: {
          action: {
            value: JSON.stringify({ pendingId, questionId: 'q1', type: 'custom' }),
            form_value: { custom_text: '' },
          },
        },
      })
      // The pending request is still outstanding (custom ignored because input empty).
      // Resolving it now so the test doesn't leak a promise.
      const stillPending = await Promise.race([
        answerPromise.then(() => 'done'),
        new Promise<string>(r => setTimeout(() => r('pending'), 20)),
      ])
      expect(stillPending).toBe('pending')
    } finally {
      stop()
      cleanup()
    }
  })

  it('ignores clicks that do not match any pending question', async () => {
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    try {
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: 'unknown', questionId: 'q1', selected: ['Yes'] }),
        },
      })
      // No pending question matches; nothing happens.
    } finally {
      stop()
      cleanup()
    }
  })

  it('skips rendering when the question targets a non-Feishu session', async () => {
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => undefined,
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    try {
      // Triggering with no agent means listener calls `next()` and rejects (no fallback).
      await expect(ctxHandle.trigger('webui-only-session', [QUESTION])).rejects.toThrow()
      // No card sent because no Feishu chat owns the session.
      expect(harness.sentCards).toEqual([])
      expect(harness.resolveChatCalls).toEqual([])
    } finally {
      stop()
      cleanup()
    }
  })

  it('clears the cardAction handler on dispose', async () => {
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    void ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } }).catch(() => undefined)
    await new Promise(resolve => setImmediate(resolve))
    stop()
    expect(harness.cardActionHandler).toBeUndefined()
    cleanup()
  })

  it('keeps the question detail in the settled card after a selection', async () => {
    const detailQuestion: AskUserQuestionItem = {
      id: 'd1',
      question: 'Pick one',
      header: 'Choice',
      detail: 'Here is the supporting description.',
      options: [{ label: 'Yes' }, { label: 'No' }],
    }
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [detailQuestion], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: extractPendingId(harness.sentCards[0]!.card), questionId: 'd1', selected: ['Yes'] }),
        },
      })
      await commitBatch(harness)
      await answerPromise
      expect(harness.updatedCards).toHaveLength(1)
      const body = harness.updatedCards[0]!.card.body
      const md = (body?.elements ?? [])
        .filter((el: any) => el.tag === 'markdown')
        .map((el: any) => el.content)
        .join('\n')
      expect(md).toContain('Here is the supporting description.')
      expect(md).toContain('✅ **Yes**')
    } finally {
      stop()
      cleanup()
    }
  })

  it('presents on both surfaces and lets the Web UI answer win', async () => {
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    let resolveWeb!: (answer: AskUserQuestionAnswer) => void
    const web = new Promise<AskUserQuestionAnswer>((resolve) => { resolveWeb = resolve })
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } }, () => web)
      await new Promise(resolve => setImmediate(resolve))
      // Both surfaces saw the request: the Feishu card is up, and the Web UI
      // answerer was invoked through `next`.
      expect(harness.sentCards).toHaveLength(1)

      resolveWeb({ answers: [{ id: 'q1', selected: ['No'] }] })
      await commitBatch(harness)
      await expect(answerPromise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['No'] }] })

      // The losing Feishu card must stop looking answerable — and still say
      // which option the Web UI picked.
      expect(harness.updatedCards).toHaveLength(1)
      const retired = JSON.stringify(harness.updatedCards[0]!.card)
      expect(retired).toContain(t.cardAnsweredElsewhereTitle)
      expect(retired).toContain('✅ **No**')
      expect(retired).not.toContain('behaviors')
    } finally {
      stop()
      cleanup()
    }
  })

  it('dismisses the Web UI surface when Feishu answers first', async () => {
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    try {
      // A Web UI that stays open and never answers.
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } }, () => new Promise(() => {}))
      await new Promise(resolve => setImmediate(resolve))
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: extractPendingId(harness.sentCards[0]!.card), questionId: 'q1', selected: ['Yes'] }),
        },
      })
      await commitBatch(harness)
      await expect(answerPromise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Yes'] }] })
      // The gate aborts the forwarded Web UI request, which is what makes the
      // browser dismiss its card.
      expect(ctxHandle.lastRequest?.signal?.aborted).toBe(true)
    } finally {
      stop()
      cleanup()
    }
  })

  it('keeps waiting on Feishu when the Web UI answerer gives up', async () => {
    const harness: Harness = { answered: [], sentCards: [], updatedCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger, getTranslations: () => t })
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } }, async () => {
        throw new Error('no Web UI client is connected')
      })
      await new Promise(resolve => setImmediate(resolve))
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: extractPendingId(harness.sentCards[0]!.card), questionId: 'q1', selected: ['Yes'] }),
        },
      })
      await commitBatch(harness)
      await expect(answerPromise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Yes'] }] })
      expect(ctxHandle.lastRequest?.signal?.aborted).toBe(true)
    } finally {
      stop()
      cleanup()
    }
  })

  it('renders each option as a directly clickable row (picker style, no buttons)', async () => {
    const { harness, ctxHandle, stop, cleanup } = startHarness()
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const card = harness.sentCards[0]!.card
      const rows = optionRows(card)
      expect(rows).toHaveLength(2)
      // Label and description live IN the row (no separate option list, no
      // option button): the row itself is the whole pick target.
      const topLevelMarkdown = ((card.body?.elements ?? []) as Array<Record<string, unknown>>)
        .filter(el => el.tag === 'markdown').map(el => String(el.content)).join('\n')
      expect(topLevelMarkdown).not.toContain('1. **Yes**')
      expect(JSON.stringify(rows[0])).toContain('1. **Yes**')
      expect(JSON.stringify(rows[0])).toContain('approve')
      expect(optionButtons(card)).toHaveLength(0)
      expect(elementsByTag(card, 'button')).toHaveLength(2) // custom submit + skip
      // One tap IS the answer (operator's 2026-10-09 redesign): the question card
      // is settled in place and a receipt card follows, carrying the undo.
      await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(rows[1]!) } })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.updatedCards[0]!.messageId).toBe('om_question_card')
      const settled = cardMarkdown(harness.updatedCards[0]!.card as Harness['sentCards'][0]['card'])
      expect(settled).toContain('2. ✅ **No**')
      expect(optionRows(harness.updatedCards[0]!.card as Harness['sentCards'][0]['card'])).toHaveLength(0)
      // The only question in the batch: its answer is recorded by the FINAL card
      // itself (a receipt would be the same card twice — see the two-question
      // test for the receipt shape).
      const finalCard = harness.sentCards[1]!.card
      expect(cardMarkdown(finalCard)).toContain('No')
      expect(hasCallbackType(finalCard, 'batch-confirm')).toBe(true)
      expect(hasCallbackType(finalCard, 'batch-back')).toBe(true)
      expect(hasCallbackType(finalCard, 'answer-confirm')).toBe(false)
      await commitBatch(harness)
      await expect(answerPromise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['No'] }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('keeps option descriptions in the settled card', async () => {
    const { harness, ctxHandle, stop, cleanup } = startHarness()
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: extractPendingId(harness.sentCards[0]!.card), questionId: 'q1', selected: ['Yes'] }),
        },
      })
      await commitBatch(harness)
      await answerPromise
      const settled = cardMarkdown(harness.updatedCards[0]!.card as Harness['sentCards'][0]['card'])
      expect(settled).toContain('1. ✅ **Yes** · approve')
      expect(settled).toContain('2. ⬜ **No** · decline')
    } finally {
      stop()
      cleanup()
    }
  })

  it('renders every option even past the old six-option cap', async () => {
    const { harness, ctxHandle, stop, cleanup } = startHarness()
    const many: AskUserQuestionItem = {
      id: 'q1',
      question: 'Pick one of eight',
      options: Array.from({ length: 8 }, (_, index) => ({ label: `Opt ${index + 1}` })),
    }
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [many], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const card = harness.sentCards[0]!.card
      const rows = optionRows(card)
      expect(rows).toHaveLength(8)
      expect(JSON.stringify(rows[7])).toContain('8. **Opt 8**')
      await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(rows[7]!) } })
      await commitBatch(harness)
      await expect(answerPromise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Opt 8'] }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('renders one checker per option plus a single submit for multi-select', async () => {
    const { harness, ctxHandle, stop, cleanup } = startHarness()
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [MULTI_QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const card = harness.sentCards[0]!.card
      const checkers = elementsByTag(card, 'checker')
      // Feishu's `checker` is a single checkbox: one per option, and it rejects
      // an `options` field (`200621 unknown property`), so names carry the index.
      expect(checkers).toHaveLength(3)
      expect(checkers.map(checker => checker.name)).toEqual(['opt_0', 'opt_1', 'opt_2'])
      expect(checkers[0]!.options).toBeUndefined()
      expect(checkers[0]!.checked).toBe(false)
      // The checkbox itself carries label + description, so the card never
      // spells the same options out twice (operator feedback 2026-10-07).
      expect(checkers[0]!.text).toEqual({ tag: 'lark_md', content: '1. **db**\n152G' })
      expect(checkers[2]!.text).toEqual({ tag: 'lark_md', content: '3. **neither**' })
      const topLevel = ((card.body?.elements ?? []) as Array<Record<string, unknown>>)
        .filter(el => el.tag === 'markdown').map(el => String(el.content)).join('\n')
      expect(topLevel).not.toContain('1. **db**')
      expect(topLevel).toContain(t.questionMultiHint)
      // No per-option buttons on the multi-select card: one submission carries all.
      expect(optionButtons(card)).toHaveLength(0)
      const pendingId = extractPendingId(card)
      await harness.cardActionHandler!({
        action: { tag: 'button', value: JSON.stringify({ pendingId, questionId: 'q1', type: 'multi-submit' }) },
        raw: {
          action: {
            value: JSON.stringify({ pendingId, questionId: 'q1', type: 'multi-submit' }),
            form_value: { opt_0: true, opt_1: 'true', opt_2: false },
          },
        },
      })
      await commitBatch(harness)
      await expect(answerPromise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['db', 'work'] }] })
      const settled = cardMarkdown(harness.updatedCards[0]!.card as Harness['sentCards'][0]['card'])
      expect(settled).toContain('1. ✅ **db** · 152G')
      expect(settled).toContain('2. ✅ **work** · 110G')
      expect(settled).toContain('3. ⬜ **neither**')
    } finally {
      stop()
      cleanup()
    }
  })

  it('ignores an all-unchecked multi-select submission and accepts a list-shaped value', async () => {
    const { harness, ctxHandle, stop, cleanup } = startHarness()
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [MULTI_QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const pendingId = extractPendingId(harness.sentCards[0]!.card)
      const submit = async (formValue: Record<string, unknown>): Promise<void> => {
        await harness.cardActionHandler!({
          action: { tag: 'button', value: JSON.stringify({ pendingId, questionId: 'q1', type: 'multi-submit' }) },
          raw: {
            action: {
              value: JSON.stringify({ pendingId, questionId: 'q1', type: 'multi-submit' }),
              form_value: formValue,
            },
          },
        })
      }
      // Nothing checked: the question stays open (both shapes of "unchecked").
      await submit({ selections: '' })
      expect(harness.updatedCards).toHaveLength(0)
      await submit({ opt_0: false, opt_1: 'false', opt_2: '0' })
      expect(harness.updatedCards).toHaveLength(0)
      // A JSON-encoded list is read too (shape tolerance).
      await submit({ selections: '["neither"]' })
      await commitBatch(harness)
      await expect(answerPromise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['neither'] }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('falls back to a single-pick card when the checker card is rejected', async () => {
    const { harness, ctxHandle, channel, stop, cleanup } = startHarness()
    const warnBefore = logger.warn.mock.calls.length
    ;(channel.send as unknown as { mockRejectedValueOnce: (error: unknown) => void })
      .mockRejectedValueOnce(new Error('rejected: not support tag checker'))
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [MULTI_QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.sentCards).toHaveLength(1)
      const card = harness.sentCards[0]!.card
      expect(elementsByTag(card, 'checker')).toHaveLength(0)
      expect(optionRows(card)).toHaveLength(3)
      expect(cardMarkdown(card)).not.toContain(t.questionMultiHint)
      const warnings = logger.warn.mock.calls.slice(warnBefore).map(call => String(call[0]))
      expect(warnings.some(line => line.includes('multi-select card rejected'))).toBe(true)
      await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(optionRows(card)[0]!) } })
      await commitBatch(harness)
      await expect(answerPromise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['db'] }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('ignores a repeated row tap on a question that is already answered', async () => {
    const { harness, ctxHandle, stop, cleanup } = startHarness()
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const rows = optionRows(harness.sentCards[0]!.card)
      await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(rows[0]!) } })
      await new Promise(resolve => setImmediate(resolve))
      const cardsAfterFirst = harness.sentCards.length
      // Same row again, and the other row too: neither may add a card or change
      // the recorded answer.
      await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(rows[0]!) } })
      await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(rows[1]!) } })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.sentCards).toHaveLength(cardsAfterFirst)
      await commitBatch(harness)
      await expect(answerPromise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Yes'] }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('submits directly when the confirmation card cannot be sent', async () => {
    const { harness, ctxHandle, channel, stop, cleanup } = startHarness()
    const warnBefore = logger.warn.mock.calls.length
    const sendMock = channel.send as unknown as {
      getMockImplementation: () => ((to: string, input: { card?: object }) => Promise<{ messageId?: string }>) | undefined
      mockImplementation: (fn: (to: string, input: { card?: object }) => Promise<{ messageId?: string }>) => void
    }
    const original = sendMock.getMockImplementation()!
    let sends = 0
    sendMock.mockImplementation(async (to, input) => {
      sends += 1
      if (sends === 2) throw new Error('send failed')
      return original(to, input)
    })
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const rows = optionRows(harness.sentCards[0]!.card)
      await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(rows[0]!) } })
      await commitBatch(harness)
      await expect(answerPromise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Yes'] }] })
      const warnings = logger.warn.mock.calls.slice(warnBefore).map(call => String(call[0]))
      expect(warnings.some(line => line.includes('confirmation card'))).toBe(true)
    } finally {
      stop()
      cleanup()
    }
  })

  it('retires every card of the batch when the question is answered elsewhere', async () => {
    const { harness, ctxHandle, stop, cleanup } = startHarness()
    const webAnswer = { answers: [{ id: 'q1', selected: ['No'] }] }
    let resolveWeb!: (answer: AskUserQuestionAnswer) => void
    const web = new Promise<AskUserQuestionAnswer>(resolve => { resolveWeb = resolve })
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } }, () => web)
      await new Promise(resolve => setImmediate(resolve))
      const rows = optionRows(harness.sentCards[0]!.card)
      await harness.cardActionHandler!({ action: { tag: 'interactive_container', value: rowValue(rows[0]!) } })
      await new Promise(resolve => setImmediate(resolve))
      // The question card is settled and the final card is up, waiting for 确认.
      expect(hasCallbackType(lastCard(harness), 'batch-confirm')).toBe(true)
      const updatesBefore = harness.updatedCards.length
      // The Web UI answers meanwhile: nothing of this batch may keep looking
      // answerable — the settled question card AND the final card are retired.
      resolveWeb(webAnswer)
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.updatedCards.length).toBe(updatesBefore + 2)
      await expect(answerPromise).resolves.toEqual(webAnswer)
    } finally {
      stop()
      cleanup()
    }
  })

  it('localizes the custom-answer controls instead of hardcoding Chinese', async () => {
    const { harness, ctxHandle, stop, cleanup } = startHarness()
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const markdown = cardMarkdown(harness.sentCards[0]!.card)
      expect(markdown).toContain(t.questionCustomHint(true))
      const buttonTexts = elementsByTag(harness.sentCards[0]!.card, 'button')
        .map(button => (button.text as { content?: string }).content)
      expect(buttonTexts).toContain(t.questionSubmitCustom)
      expect(buttonTexts).toContain(t.questionSkipButton)
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: extractPendingId(harness.sentCards[0]!.card), questionId: 'q1', selected: ['Yes'] }),
        },
      })
      await commitBatch(harness)
      await answerPromise
    } finally {
      stop()
      cleanup()
    }
  })
})

/** Extract the plugin-generated pendingId from a rendered question card. */
function extractPendingId(card: Harness['sentCards'][0]['card']): string {
  // The plugin embeds `pendingId` in each button's `behaviors[*].value` object.
  // Walk the body elements recursively, looking for a `tag: 'button'` whose
  // first behavior has `value.pendingId`.
  const walk = (els: unknown[]): string | undefined => {
    for (const el of els) {
      if (el === null || typeof el !== 'object') continue
      const obj = el as Record<string, unknown>
      if (obj.tag === 'button') {
        const behaviors = obj.behaviors
        if (Array.isArray(behaviors)) {
          for (const b of behaviors) {
            if (b === null || typeof b !== 'object') continue
            const v = (b as Record<string, unknown>).value
            if (v !== null && typeof v === 'object') {
              const pid = (v as Record<string, unknown>).pendingId
              if (typeof pid === 'string') return pid
            }
          }
        }
      }
      // Recurse into form containers, columns, etc.
      if (Array.isArray(obj.elements)) {
        const found = walk(obj.elements as unknown[])
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  const elements = card.body?.elements as unknown[] | undefined
  if (elements === undefined) throw new Error('card has no body.elements')
  const found = walk(elements)
  if (found === undefined) throw new Error('card has no pendingId')
  return found
}
