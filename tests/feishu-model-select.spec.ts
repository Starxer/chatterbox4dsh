import { describe, expect, it, vi } from 'vitest'
import { sendModelCardV2, startFeishuModelSelect } from '../src/feishu-model-select.ts'
import { createCardTopicRegistry } from '../src/card-topics.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

/**
 * The model selector had no test at all, and it silently swallowed its own
 * failures: an action it could not parse returned `undefined` with no log, so a
 * dead confirm button left no trace anywhere. These cases pin down both the
 * parsing contract and the dropdown/staleness bug behind
 * 「点了确认没反应，也没有最后的确认卡」.
 */
function harness(overrides: {
  models?: unknown
  sessionController?: unknown
  topicFor?: (message: { chatId: string; messageId?: string }) => { rootId?: string; threadId?: string }
  onNewSessionConfirm?: (chatMessage: any, selection: any, messageId: string | undefined) => Promise<void>
} = {}) {
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
    listProviders: vi.fn(() => [{ id: 'provA', name: 'A' }, { id: 'provB', name: 'B' }]),
    listModels: vi.fn(async (provider: string) => models[provider] ?? []),
    resolveModelInfo: vi.fn(async () => ({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } })),
  } as any
  const bridgeHolder = {
    current: {
      sessionCurrentSelection: async () => ({ provider: 'provA', model: 'a1' }),
      resolveSessionIdFor: () => 'sess-1',
    },
  } as any
  const onNewSessionConfirm = overrides.onNewSessionConfirm ?? vi.fn(async () => undefined)
  const handle = startFeishuModelSelect({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'provA', model: 'a1' }) } as any,
    bridgeHolder,
    sessionController: (overrides.sessionController ?? {}) as any,
    channel,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    getTranslations: () => t,
    onNewSessionConfirm,
    topicFor: overrides.topicFor ?? (() => ({})),
  })
  const fire = (evt: any) => Promise.all(handlers.map(h => h(evt)))
  return { channel, cards, fire, handle, onNewSessionConfirm, llm }
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
    const [chatMessage, selection, messageId] = (onNewSessionConfirm as unknown as { mock: { calls: any[][] } }).mock.calls[0] as [any, any, string]
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

  /**
   * 2026-09-21 regression: the topic of a card-driven send was resolved from
   * the CHAT alone, so in a group with two topics the model card of a `/new`
   * flow ended up in whichever topic had been used most recently. The clicked
   * card's message id is the only unambiguous key — the caller must receive it.
   */
  it('resolves the topic from the clicked card, not from the group', async () => {
    const seen: Array<{ chatId: string; messageId?: string }> = []
    const { fire, handle } = harness({
      topicFor: message => {
        seen.push(message)
        // Stand-in for the message-id → topic registry: only the card that was
        // actually posted into the new topic resolves to it.
        return message.messageId === 'm-new-topic'
          ? { threadId: 'omt_new', rootId: 'om_root_new' }
          : { threadId: 'omt_old', rootId: 'om_root_old' }
      },
    })
    await fire({
      chatId: 'oc_grp',
      messageId: 'm-new-topic',
      action: { value: { action: 'confirm-select', provider: 'provB', flow: 'new-session' } },
      raw: { action: { form_value: { model: 'b2' } } },
    })
    expect(seen).toEqual([{ chatId: 'oc_grp', messageId: 'm-new-topic' }])
    handle.dispose()
  })

  it('restores the clicked card\u2019s topic onto the forwarded chatMessage', async () => {
    const onNewSessionConfirm = vi.fn(async () => undefined)
    const { fire, handle } = harness({
      onNewSessionConfirm,
      topicFor: () => ({ threadId: 'omt_new', rootId: 'om_root_new' }),
    })
    await fire({
      chatId: 'oc_grp',
      messageId: 'm-new-topic',
      action: { value: { action: 'confirm-select', provider: 'provB', flow: 'new-session' } },
      raw: { action: { form_value: { model: 'b2' } } },
    })
    const [chatMessage] = onNewSessionConfirm.mock.calls[0] as unknown as [any]
    expect(chatMessage.threadId).toBe('omt_new')
    expect(chatMessage.rootId).toBe('om_root_new')
    handle.dispose()
  })
})

describe('sendModelCardV2 topic bookkeeping', () => {
  it('records the topic of the card it sent, so a later click resolves exactly', async () => {
    const topics = createCardTopicRegistry()
    const channel = {
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-card' })),
    } as any
    await sendModelCardV2(
      channel,
      { chatId: 'oc_grp', chatType: 'group', threadId: 'omt_new', rootId: 'om_root_new' },
      {},
      new Map(),
      new Map(),
      topics,
    )
    expect(channel.sendCardByReference).toHaveBeenCalledWith(
      'oc_grp',
      'card-1',
      { replyInThread: true, replyTo: 'om_root_new' },
    )
    expect(topics.for('m-card')).toEqual({ threadId: 'omt_new', rootId: 'om_root_new' })
  })
})

/**
 * Model discovery now asks the Session Controller's own catalog first
 * (`sessionController.modelCatalog()`): one read answers every provider, its
 * models with human-readable names, and each model's reasoning efforts. The llm
 * directory stays as the fallback for a Host that has no catalog or whose read
 * fails — the path every pre-existing case in this file still exercises, since
 * the default harness injects `{}` as the session controller.
 */
describe('feishu-model-select model catalog discovery', () => {
  const catalog = {
    groups: [
      {
        id: 'provA',
        name: 'Provider A',
        models: [
          { id: 'a1', name: 'Alpha One', reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' } },
        ],
      },
    ],
  }

  it('renders the catalog provider and model names without touching the llm directory', async () => {
    const { fire, cards, handle, llm } = harness({
      sessionController: { modelCatalog: vi.fn(async () => catalog) },
    })
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { tag: 'button', option: 'provA', value: { action: 'select-provider' } },
    })
    const select = modelSelect(cards)
    expect(select.value).toBe('a1')
    // The readable name is the whole point of preferring the catalog.
    expect(select.options).toEqual([{ text: { tag: 'plain_text', content: 'Alpha One (a1)' }, value: 'a1' }])
    expect(llm.listModels).not.toHaveBeenCalled()
    expect(llm.resolveModelInfo).not.toHaveBeenCalled()
    handle.dispose()
  })

  it('drops to the llm directory, with a warning, when the catalog read fails', async () => {
    const { fire, cards, handle, llm } = harness({
      sessionController: {
        modelCatalog: vi.fn(async () => { throw new Error('catalog offline') }),
      },
    })
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { tag: 'button', option: 'provB', value: { action: 'select-provider' } },
    })
    expect(modelSelect(cards).value).toBe('b1')
    expect(llm.listModels).toHaveBeenCalledWith('provB')
    handle.dispose()
  })

  it('uses the llm directory when the Host exposes no catalog at all', async () => {
    const { fire, cards, handle, llm } = harness()
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { tag: 'button', option: 'provB', value: { action: 'select-provider' } },
    })
    expect(modelSelect(cards).value).toBe('b1')
    expect(llm.listModels).toHaveBeenCalledWith('provB')
    expect(llm.listProviders).toHaveBeenCalled()
    handle.dispose()
  })

  it('auto-downgrades an unsupported effort to the catalog default on confirm', async () => {
    const selectModel = vi.fn(async () => undefined)
    const { fire, handle } = harness({
      sessionController: { modelCatalog: vi.fn(async () => catalog), selectModel },
    })
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { value: { action: 'confirm-select', provider: 'provA' } },
      raw: { action: { form_value: { model: 'a1', reasoning_effort: 'low' } } },
    })
    // `low` is not in the catalog's effort set, so the catalog's default wins.
    expect(selectModel).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      provider: 'provA',
      model: 'a1',
      reasoningEffort: 'high',
    })
    handle.dispose()
  })
})
