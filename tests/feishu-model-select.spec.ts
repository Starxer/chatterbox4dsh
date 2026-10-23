import { describe, expect, it, vi } from 'vitest'
import { renderProviderSelectCard, renderReasoningCard, sendModelCardV2, startFeishuModelSelect } from '../src/feishu-model-select.ts'
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
  bridge?: Record<string, unknown>
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
  const sessionController = (overrides.sessionController ?? { selectModel: vi.fn(async () => undefined), fork: undefined }) as any
  const bridgeHolder = {
    current: {
      sessionCurrentSelection: async () => ({ provider: 'provA', model: 'a1' }),
      resolveSessionIdFor: () => 'sess-1',
      recentRoutes: async () => [],
      switchRoute: async () => ({ ok: true }),
      recentModelRoutes: () => [],
      rememberModelRoute: vi.fn(),
      recentModelChoices: async () => [],
      ...(overrides.bridge ?? {}),
    },
  } as any
  const onNewSessionConfirm = overrides.onNewSessionConfirm ?? vi.fn(async () => undefined)
  const handle = startFeishuModelSelect({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'provA', model: 'a1' }) } as any,
    bridgeHolder,
    sessionController,
    channel,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    getTranslations: () => t,
    onNewSessionConfirm,
    topicFor: overrides.topicFor ?? (() => ({})),
  })
  const fire = (evt: any) => Promise.all(handlers.map(h => h(evt)))
  return { channel, cards, fire, handle, onNewSessionConfirm, llm, bridgeHolder, sessionController }
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


describe('last-used quick action', () => {
  it('renders the quick button only when a different earlier route exists', () => {
    const providers = [{ id: 'provA', name: 'A' }] as never
    const current = { provider: 'provA', model: 'a1' }
    const withLast = renderProviderSelectCard(providers, current, undefined, t, {
      lastUsed: { provider: 'provB', model: 'b1' },
    }) as any
    const buttons = withLast.body.elements.filter((element: any) => element.tag === 'button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].behaviors[0].value).toEqual({ action: 'switch-last' })
    // Short caption: Feishu truncates buttons, so the route must live in the
    // card body instead.
    expect(buttons[0].text.content).toBe(t.modelSelectLastUsedButton)
    expect(buttons[0].text.content).not.toContain('b1')
    const body = JSON.stringify(withLast.body.elements)
    expect(body).toContain('b1')
    expect(body).toContain(t.modelSelectLastUsed('provB', 'b1'))

    const same = renderProviderSelectCard(providers, current, undefined, t, { lastUsed: current }) as any
    expect(same.body.elements.filter((element: any) => element.tag === 'button')).toHaveLength(0)
  })

  it('switches this session locally and says the global default is untouched', async () => {
    const switchRoute = vi.fn(async () => ({ ok: true }))
    const { fire, cards, handle, sessionController } = harness({
      bridge: { recentRoutes: async () => [{ provider: 'provB', model: 'b1' }], switchRoute },
    })
    await fire({ chatId: 'oc_1', messageId: 'm-1', action: { value: { action: 'switch-last' } } })
    expect(switchRoute).toHaveBeenCalledWith(expect.anything(), { provider: 'provB', model: 'b1' })
    // The old bug: a quick pick persisted as the global default. This path must
    // never call the session controller.
    expect(sessionController.selectModel).not.toHaveBeenCalled()
    const last = cards.at(-1)
    expect(last.header.template).toBe('green')
    expect(JSON.stringify(last)).toContain(t.modelSelectLastUsedSwitched)
    handle.dispose()
  })

  it('reports an unloaded session instead of pretending to switch', async () => {
    const { fire, cards, handle } = harness({
      bridge: { recentRoutes: async () => [{ provider: 'provB', model: 'b1' }], switchRoute: async () => ({ ok: false, reason: 'no-agent' }) },
    })
    await fire({ chatId: 'oc_1', messageId: 'm-1', action: { value: { action: 'switch-last' } } })
    const last = cards.at(-1)
    expect(last.header.template).toBe('red')
    expect(JSON.stringify(last)).toContain(t.modelSelectLastUsedFailedNoSession)
    handle.dispose()
  })
})


describe('global recent-model rows', () => {
  it('renders one tappable row per remembered route', () => {
    const providers = [{ id: 'provA', name: 'A' }] as never
    const current = { provider: 'provA', model: 'a1' }
    const card = renderProviderSelectCard(providers, current, undefined, t, {
      recent: [
        { provider: 'provB', model: 'b1', reasoningEffort: 'high', usedAt: 2 },
        { provider: 'provC', model: 'c1', usedAt: 1 },
      ],
    }) as any
    const rows = card.body.elements.filter((element: any) => element.tag === 'interactive_container')
    expect(rows).toHaveLength(2)
    expect(rows[0].behaviors[0].value).toEqual({ action: 'switch-recent', provider: 'provB', model: 'b1', effort: 'high' })
    expect(rows[1].behaviors[0].value).toEqual({ action: 'switch-recent', provider: 'provC', model: 'c1' })
    expect(JSON.stringify(card)).toContain(t.modelSelectRecentHeader)
    // `/new` reuses the card and offers the SAME rows (the model step must not
    // drift from `/model`), but each click carries the flow marker so it picks
    // the route of the session about to be created instead of switching the
    // running one.
    const newSession = renderProviderSelectCard(providers, current, 'new-session', t, { recent: [
      { provider: 'provA', model: 'a1', usedAt: 3 },
      { provider: 'provB', model: 'b1', usedAt: 2 },
    ] }) as any
    const newRows = newSession.body.elements.filter((element: any) => element.tag === 'interactive_container')
    // The default route gets its own row (so it can be CHOSEN, not just read),
    // and it is not repeated in the recent list.
    expect(newRows).toHaveLength(2)
    expect(newRows[0].behaviors[0].value).toEqual({ action: 'switch-recent', provider: 'provA', model: 'a1', flow: 'new-session' })
    expect(newRows[1].behaviors[0].value).toEqual({ action: 'switch-recent', provider: 'provB', model: 'b1', flow: 'new-session' })
    const text = JSON.stringify(newSession)
    expect(text).toContain(t.modelSelectRecentHeaderNewSession)
    expect(text).toContain(t.modelSelectNewSessionTitle)
  })

  it('offers the previous-model quick action on the /new card too, with its own wording', () => {
    const providers = [{ id: 'provA', name: 'A' }, { id: 'provB', name: 'B' }] as never
    const current = { provider: 'provA', model: 'a1' }
    const card = renderProviderSelectCard(providers, current, 'new-session', t, {
      lastUsed: { provider: 'provB', model: 'b1', reasoningEffort: 'high' },
    }) as any
    const text = JSON.stringify(card)
    expect(text).toContain(t.modelSelectLastUsedNewSession('provB', 'b1'))
    expect(text).toContain(t.modelSelectLastUsedButtonNewSession)
    // A `/new` card must not borrow the "switch back (this session only)" words.
    expect(text).not.toContain(t.modelSelectLastUsedSwitched)
    const button = card.body.elements.find((element: any) => element.tag === 'button')
    expect(button.behaviors[0].value).toEqual({ action: 'switch-last', flow: 'new-session' })
  })

  it('marks the current route instead of dropping it (single-route memory still renders)', () => {
    const providers = [{ id: 'provA', name: 'A' }] as never
    const current = { provider: 'provA', model: 'a1' }
    const card = renderProviderSelectCard(providers, current, undefined, t, {
      recent: [{ provider: 'provA', model: 'a1', usedAt: 1 }],
    }) as any
    const rows = card.body.elements.filter((element: any) => element.tag === 'interactive_container')
    expect(rows).toHaveLength(0)
    const text = JSON.stringify(card)
    expect(text).toContain(t.modelSelectRecentHeader)
    expect(text).toContain(t.modelSelectRecentCurrent('provA', 'a1'))
  })

  it('switches the session locally when a row is tapped', async () => {
    const switchRoute = vi.fn(async () => ({ ok: true }))
    const { fire, cards, handle, sessionController } = harness({
      bridge: { recentModelRoutes: () => [{ provider: 'provB', model: 'b1', usedAt: 2 }], switchRoute },
    })
    await fire({ chatId: 'oc_1', messageId: 'm-1', action: { value: { action: 'switch-recent', provider: 'provB', model: 'b1', effort: 'high' } } })
    expect(switchRoute).toHaveBeenCalledWith(expect.anything(), { provider: 'provB', model: 'b1', reasoningEffort: 'high' })
    expect(sessionController.selectModel).not.toHaveBeenCalled()
    const last = cards.at(-1)
    expect(last.header.template).toBe('green')
    expect(JSON.stringify(last)).toContain(t.modelSelectRecentSwitched)
    handle.dispose()
  })
})


describe('new-session model step', () => {
  it('sends a provider card that carries the /model sections', async () => {
    const { handle, channel } = harness({
      bridge: {
        recentRoutes: async () => [{ provider: 'provB', model: 'b1', reasoningEffort: 'high' }],
        recentModelChoices: async () => [{ provider: 'provB', model: 'b1', usedAt: 3 }],
      },
    })
    const sent = await handle.sendNewSessionProviderCard({ chatId: 'oc_1', chatType: 'p2p' })
    expect(sent.messageId).not.toBe('')
    // Registered like any other model card, so a later in-place update (go back)
    // and the settlement repaint can find the CardKit instance.
    expect(handle.cardByMessage.get(sent.messageId)).toBe(sent.cardId)
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    const text = JSON.stringify(card)
    expect(text).toContain(t.modelSelectNewSessionTitle)
    // The same three sections `/model` renders.
    // The default route is a tappable choice here (not just context), so the
    // line is named "默认模型" rather than "当前模型".
    expect(text).toContain('**默认模型**')
    expect(text).toContain('`provA/a1`')
    expect(text).toContain('新会话将继承')
    expect(text).toContain(t.modelSelectLastUsedNewSession('provB', 'b1'))
    expect(text).toContain(t.modelSelectRecentHeaderNewSession)
    expect(text).toContain(`\`provB/b1\``)
    handle.dispose()
  })

  it('always offers the default route as a tappable row, even with no history at all', async () => {
    // The regression the operator reported: the only route on the `/new` card
    // was the default, rendered as a dead `✅ 当前` line — "还是没法点击选择默认
    // 模型". It is a real choice for a new session, so it must be tappable.
    const { handle, channel } = harness({ bridge: { recentRoutes: async () => [], recentModelChoices: async () => [] } })
    const sent = await handle.sendNewSessionProviderCard({ chatId: 'oc_1', chatType: 'p2p' })
    expect(sent.messageId).not.toBe('')
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    const rows = card.body.elements.filter((element: any) => element.tag === 'interactive_container')
    expect(rows).toHaveLength(1)
    expect(rows[0].behaviors[0].value).toEqual({ action: 'switch-recent', provider: 'provA', model: 'a1', flow: 'new-session' })
    // (the line has embedded newlines, which JSON escapes — match its parts)
    expect(JSON.stringify(card)).toContain('**默认模型**')
    expect(JSON.stringify(card)).toContain('新会话将继承')
    handle.dispose()
  })

  it('accepts the default model with one tap and creates nothing by itself', async () => {
    const switchRoute = vi.fn(async () => ({ ok: true }))
    const { fire, handle, onNewSessionConfirm, sessionController } = harness({ bridge: { switchRoute } })
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { value: { action: 'switch-recent', provider: 'provA', model: 'a1', flow: 'new-session' } },
    })
    expect(onNewSessionConfirm).toHaveBeenCalledTimes(1)
    const [, selection, messageId] = (onNewSessionConfirm as any).mock.calls[0]
    expect(selection).toEqual({ provider: 'provA', model: 'a1' })
    expect(messageId).toBe('m-1')
    expect(switchRoute).not.toHaveBeenCalled()
    expect(sessionController.selectModel).not.toHaveBeenCalled()
    handle.dispose()
  })

  it('keeps the flow marker on the back button of the model card', async () => {
    // Without it, going back from the `/new` model card re-rendered the card as
    // the standalone `/model` one (wrong wording) and its rows would switch the
    // RUNNING session instead of choosing the new session's route.
    const { fire, cards, handle } = harness()
    await fire({ chatId: 'oc_1', messageId: 'm-1', action: { tag: 'button', option: 'provB', value: { action: 'select-provider', flow: 'new-session' } } })
    const modelCard = cards.at(-1) as any
    const back = modelCard.body.elements.find((element: any) => element.tag === 'button')
    expect(back.behaviors[0].value).toEqual({ action: 'go-back', flow: 'new-session' })
    await fire({ chatId: 'oc_1', messageId: 'm-1', action: { value: { action: 'go-back', flow: 'new-session' } } })
    const providerCard = cards.at(-1) as any
    expect(providerCard.header.title.content).toBe(t.modelSelectNewSessionTitle)
    expect(JSON.stringify(providerCard)).toContain('**默认模型**')
    const rows = providerCard.body.elements.filter((element: any) => element.tag === 'interactive_container')
    expect(rows[0].behaviors[0].value.flow).toBe('new-session')
    handle.dispose()
  })

  it('picks the route for the NEW session from a recent row, touching nothing running', async () => {
    const switchRoute = vi.fn(async () => ({ ok: true }))
    const { fire, handle, onNewSessionConfirm, sessionController } = harness({ bridge: { switchRoute } })
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { value: { action: 'switch-recent', provider: 'provB', model: 'b1', effort: 'high', flow: 'new-session' } },
    })
    expect(onNewSessionConfirm).toHaveBeenCalledTimes(1)
    const [, selection, messageId] = (onNewSessionConfirm as any).mock.calls[0]
    expect(selection).toEqual({ provider: 'provB', model: 'b1', reasoningEffort: 'high' })
    expect(messageId).toBe('m-1')
    // A `/new` pick is not a switch: neither the session-local override nor the
    // global default may move here (`关键坑 59`).
    expect(switchRoute).not.toHaveBeenCalled()
    expect(sessionController.selectModel).not.toHaveBeenCalled()
    handle.dispose()
  })

  it('picks the previous model for the new session from the quick action', async () => {
    const switchRoute = vi.fn(async () => ({ ok: true }))
    const { fire, handle, onNewSessionConfirm } = harness({
      bridge: {
        switchRoute,
        recentRoutes: async () => [{ provider: 'provB', model: 'b1' }],
        recentModelChoices: async () => [],
      },
    })
    await fire({ chatId: 'oc_1', messageId: 'm-1', action: { value: { action: 'switch-last', flow: 'new-session' } } })
    expect(onNewSessionConfirm).toHaveBeenCalledTimes(1)
    const [, selection] = (onNewSessionConfirm as any).mock.calls[0]
    expect(selection).toEqual({ provider: 'provB', model: 'b1' })
    expect(switchRoute).not.toHaveBeenCalled()
    handle.dispose()
  })

  it('says so when a remembered route is no longer offered, instead of doing nothing', async () => {
    const { fire, cards, handle, onNewSessionConfirm } = harness()
    await fire({
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { value: { action: 'switch-recent', provider: 'gone-provider', model: 'x1', flow: 'new-session' } },
    })
    expect(onNewSessionConfirm).not.toHaveBeenCalled()
    const last = cards.at(-1)
    expect(last.header.template).toBe('red')
    expect(JSON.stringify(last)).toContain(t.newSessionRouteUnavailable)
    handle.dispose()
  })
})


describe('reasoning quick card', () => {
  it('renders one tappable row per effort and marks the current one', () => {
    const card = renderReasoningCard({ provider: 'p1', model: 'm1' }, [{ id: 'low' }, { id: 'high' }, { id: 'max' }], 'high', t) as any
    const rows = card.body.elements.filter((element: any) => element.tag === 'interactive_container')
    expect(rows.map((row: any) => row.behaviors[0].value.effort)).toEqual(['low', 'max'])
    expect(JSON.stringify(card)).toContain(t.reasoningCardCurrent('high'))
  })

  it('switches the effort for this session only', async () => {
    const switchRoute = vi.fn(async () => ({ ok: true }))
    const { fire, cards, handle, sessionController } = harness({ bridge: { switchRoute } })
    await fire({ chatId: 'oc_1', messageId: 'm-1', action: { value: { action: 'switch-effort', effort: 'low' } } })
    expect(switchRoute).toHaveBeenCalledWith(expect.anything(), { provider: 'provA', model: 'a1', reasoningEffort: 'low' })
    expect(sessionController.selectModel).not.toHaveBeenCalled()
    const last = cards.at(-1)
    expect(last.header.template).toBe('green')
    expect(JSON.stringify(last)).toContain(t.reasoningCardSwitched('low'))
    handle.dispose()
  })
})
