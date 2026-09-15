import { describe, expect, it, vi } from 'vitest'
import { startFeishuModelSelect } from '../src/feishu-model-select.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

/**
 * The model selector had no test at all, and it silently swallowed its own
 * failures: an action it could not parse returned `undefined` with no log, so a
 * dead confirm button left no trace anywhere. These cases pin down both the
 * parsing contract and the dropdown/staleness bug behind
 * 「点了确认没反应，也没有最后的确认卡」.
 */
function harness(overrides: { models?: unknown } = {}) {
  const handlers: Array<(evt: any) => void | Promise<void>> = []
  const cards: any[] = []
  let instances = 0
  const channel = {
    onCardAction: vi.fn((h: (evt: any) => void | Promise<void>) => {
      handlers.push(h)
      return () => {
        const i = handlers.indexOf(h)
        if (i >= 0) handlers.splice(i, 1)
      }
    }),
    createCardInstance: vi.fn(async (card: object) => {
      cards.push(card)
      return `card-${++instances}`
    }),
    sendCardByReference: vi.fn(async () => ({ messageId: `m-${instances}` })),
    updateCardInstance: vi.fn(async (_id: string, card: object) => {
      cards.push(card)
    }),
    updateCard: vi.fn(async (_id: string, card: object) => {
      cards.push(card)
    }),
    send: vi.fn(async () => ({ messageId: `m-${instances}` })),
  } as any
  const models: Record<string, any[]> = (overrides.models as any) ?? {
    provA: [{ id: 'a1' }, { id: 'a2' }],
    provB: [{ id: 'b1' }, { id: 'b2' }],
  }
  const llm = {
    listProviders: () => [{ id: 'provA', name: 'A' }, { id: 'provB', name: 'B' }],
    listModels: async (provider: string) => models[provider] ?? [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }),
  } as any
  const bridgeHolder = {
    current: { sessionCurrentSelection: async () => ({ provider: 'provA', model: 'a1' }) },
  } as any
  const onNewSessionConfirm = vi.fn(async () => undefined)
  const handle = startFeishuModelSelect({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'provA', model: 'a1' }) } as any,
    bridgeHolder,
    sessionController: {} as any,
    channel,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    getTranslations: () => t,
    onNewSessionConfirm,
    topicFor: () => ({}),
  })
  const fire = (evt: any) => Promise.all(handlers.map(h => h(evt)))
  return { channel, cards, fire, handle, onNewSessionConfirm }
}

/** The `model` <select_static> of the most recently rendered card. */
function modelSelect(cards: any[]): any {
  for (const card of [...cards].reverse()) {
    const form = (card.body?.elements ?? []).find((e: any) => e.tag === 'form')
    const select = (form?.elements ?? []).find((e: any) => e.tag === 'select_static' && e.name === 'model')
    if (select !== undefined) return select
  }
  throw new Error('no model dropdown was rendered')
}

describe('feishu-model-select', () => {
  it('opens the dropdown on a model that belongs to the provider just picked', async () => {
    // Regression: the session's current model was handed to the freshly picked
    // provider's dropdown. When it was not in that provider's list the select
    // rendered empty, the form submitted no `model`, and the confirm became a
    // no-op — the `/new` flow died one step before its confirmation card.
    const { fire, cards, handle } = harness()
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { tag: 'button', option: 'provB', value: { action: 'select-provider' } },
    })
    const select = modelSelect(cards)
    expect(select.value).toBe('b1')
    // The initial value MUST be one of the offered options, or Feishu shows an
    // empty dropdown and submits nothing.
    expect(select.options.map((o: any) => o.value)).toContain(select.value)
    handle.dispose()
  })

  it('keeps the current model when it does belong to the picked provider', async () => {
    const { fire, cards, handle } = harness()
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { tag: 'button', option: 'provA', value: { action: 'select-provider' } },
    })
    expect(modelSelect(cards).value).toBe('a1')
    handle.dispose()
  })

  it('forwards a valid new-session confirm to onNewSessionConfirm with the flow marker', async () => {
    // This is the hop `/new` depends on to show its final confirmation card; it
    // silently did nothing when the form carried no model.
    const { fire, handle, onNewSessionConfirm } = harness()
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: {
        value: { action: 'confirm-select', provider: 'provB', flow: 'new-session' },
      },
      raw: { action: { form_value: { model: 'b2', reasoning_effort: 'low' } } },
    })
    expect(onNewSessionConfirm).toHaveBeenCalledTimes(1)
    const [chatMessage, selection, messageId] = onNewSessionConfirm.mock.calls[0] as unknown as [any, any, string]
    expect(chatMessage.chatId).toBe('oc_1')
    expect(selection).toEqual({ provider: 'provB', model: 'b2', reasoningEffort: 'low' })
    expect(messageId).toBe('m-1')
    handle.dispose()
  })

  it('never drops a confirm in silence when the form submits no model', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { fire, handle, onNewSessionConfirm } = harness()
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { value: { action: 'confirm-select', provider: 'provB', flow: 'new-session' } },
      raw: { action: { form_value: {} } },
    })
    expect(onNewSessionConfirm).not.toHaveBeenCalled()
    // ...but it leaves a trace explaining why nothing happened.
    expect(log.mock.calls.flat().join(' ')).toContain('confirm-select ignored')
    log.mockRestore()
    handle.dispose()
  })
})
