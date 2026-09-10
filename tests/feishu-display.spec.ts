import { describe, expect, it, vi } from 'vitest'
import { DISPLAY_KEYS, renderDisplayCard, startFeishuDisplay } from '../src/feishu-display.ts'
import type { DisplayToggleKey } from '../src/commands.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')
const tEn = translationsFor('en')

function buttonsOf(card: any): any[] {
  return card.body.elements.filter((el: any) => el.tag === 'button')
}

/**
 * The callback payload of one switch's button. CardKit cards deliver it via
 * `behaviors`; a top-level `value` is ignored by Feishu on those cards, which
 * silently turned every click into a no-op — hence the dedicated assertions.
 */
function payloadOf(card: any, key: DisplayToggleKey): any {
  return behaviorsOf(card, key)?.[0]?.value
}

function behaviorsOf(card: any, key: DisplayToggleKey): any[] | undefined {
  return buttonsOf(card).find((b: any) => b.behaviors?.[0]?.value?.key === key)?.behaviors
}

function buttonFor(card: any, key: DisplayToggleKey): any {
  return buttonsOf(card).find((b: any) => b.behaviors?.[0]?.value?.key === key)
}

const ALL_ON: Record<DisplayToggleKey, boolean> = { reasoning: true, tools: true, args: true, results: true }

describe('renderDisplayCard', () => {
  it('renders one button per switch with its state', () => {
    const card = renderDisplayCard(ALL_ON, t) as any
    expect(card.header.title.content).toBe('📇 卡片显示')
    expect(DISPLAY_KEYS).toEqual(['reasoning', 'tools', 'args', 'results'])
    const buttons = buttonsOf(card)
    expect(buttons).toHaveLength(4)
    expect(buttonFor(card, 'tools').text.content).toBe('✅ 工具调用：开')
    expect(buttonFor(card, 'tools').type).toBe('primary')
  })

  it('declares the callback through behaviors, never a top-level value', () => {
    const card = renderDisplayCard(ALL_ON, t) as any
    for (const button of buttonsOf(card)) {
      // A CardKit card instance only honours `behaviors`; a top-level `value`
      // is dropped and the button does nothing when clicked.
      expect(button.value).toBeUndefined()
      expect(button.behaviors).toHaveLength(1)
      expect(button.behaviors[0].type).toBe('callback')
      expect(button.behaviors[0].value).toMatchObject({ p: 'display' })
    }
  })

  it('marks a disabled switch and carries the TARGET value, not a toggle marker', () => {
    const card = renderDisplayCard({ ...ALL_ON, reasoning: false, args: false }, t) as any
    const reasoning = buttonFor(card, 'reasoning')
    expect(reasoning.text.content).toBe('⬜ 思考过程：关')
    expect(reasoning.type).toBe('default')
    // Clicking an off switch turns it on.
    expect(payloadOf(card, 'reasoning')).toEqual({ p: 'display', key: 'reasoning', value: true })
    expect(payloadOf(card, 'tools')).toEqual({ p: 'display', key: 'tools', value: false })
  })

  it('localizes the card', () => {
    const card = renderDisplayCard(ALL_ON, tEn) as any
    expect(card.header.title.content).toBe('📇 Card display')
    expect(buttonFor(card, 'results').text.content).toBe('✅ Results: on')
    expect(payloadOf(card, 'results')).toMatchObject({ p: 'display' })
    expect(behaviorsOf(card, 'results')).toHaveLength(1)
  })

  it('hides the argument and result switches while tool display is off', () => {
    const card = renderDisplayCard({ ...ALL_ON, tools: false }, t) as any
    // Only the two switches that still do something remain.
    expect(buttonsOf(card).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'tools'])
    expect(buttonFor(card, 'tools').text.content).toBe('⬜ 工具调用：关')
    // The card says why two switches are missing instead of just looking broken.
    const markdown = card.body.elements
      .filter((el: any) => el.tag === 'markdown')
      .map((el: any) => el.content)
      .join('\n')
    expect(markdown).toContain('随「工具调用」一起隐藏')
  })

  it('brings the hidden switches back when tool display is re-enabled', () => {
    const card = renderDisplayCard({ ...ALL_ON, tools: true, args: false, results: false }, t) as any
    expect(buttonsOf(card).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'tools', 'args', 'results'])
    // The stored off values are preserved, not silently forced on.
    expect(buttonFor(card, 'args').text.content).toBe('⬜ 参数：关')
    expect(buttonFor(card, 'results').text.content).toBe('⬜ 结果：关')
  })
})

/** Mutable display control stub: the setter records the call AND updates state. */
function makeDisplay(state: Record<DisplayToggleKey, boolean>) {
  const spy = vi.fn()
  return {
    spy,
    control: {
      get: () => state,
      set: (key: DisplayToggleKey, value: boolean): void => {
        spy(key, value)
        state[key] = value
      },
    },
  }
}

function makeChannel() {
  let actionHandler: ((evt: any) => unknown) | undefined
  let nextCard = 0
  let nextMessage = 0
  const channel = {
    send: vi.fn(async () => ({ messageId: `om_fallback_${++nextMessage}` })),
    createCardInstance: vi.fn(async (_card: object) => `card_${++nextCard}`),
    sendCardByReference: vi.fn(async () => ({ messageId: `om_${++nextMessage}` })),
    updateCardInstance: vi.fn(async (_cardId: string, _card: object, _sequence: number) => undefined),
    updateCard: vi.fn(async (_messageId: string, _card: object) => undefined),
    onCardAction: vi.fn((handler: any) => { actionHandler = handler; return () => { actionHandler = undefined } }),
  }
  return {
    channel,
    click: (evt: any) => actionHandler!(evt),
    getHandler: () => actionHandler,
    lastCard: (index: number): any => channel.createCardInstance.mock.calls[index]![0],
  }
}

describe('startFeishuDisplay', () => {
  it('opens the card and records it for later clicks', async () => {
    const { channel } = makeChannel()
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: makeDisplay({ ...ALL_ON }).control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    const messageId = await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    expect(messageId).toBe('om_1')
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    expect(channel.sendCardByReference).toHaveBeenCalledWith('oc_1', 'card_1', {})
    handle.stop()
  })

  it('flips a switch, posts a NEW card and retires the old one', async () => {
    const { channel, click, lastCard } = makeChannel()
    const { control, spy } = makeDisplay({ ...ALL_ON })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    await click({ messageId: 'om_1', action: { value: payloadOf(lastCard(0), 'tools') } })

    expect(spy).toHaveBeenCalledWith('tools', false)
    // A brand-new card, never an in-place edit of the clicked one (Feishu stops
    // delivering button callbacks after ~2-3 edits).
    expect(channel.createCardInstance).toHaveBeenCalledTimes(2)
    expect(channel.sendCardByReference).toHaveBeenLastCalledWith('oc_1', 'card_2', {})
    // The clicked card is repainted as the stale notice.
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    expect(channel.updateCardInstance.mock.calls[0]![0]).toBe('card_1')
    expect(channel.updateCardInstance.mock.calls[0]![2]).toBe(1)
    // The refreshed card reflects the persisted value.
    expect(buttonFor(lastCard(1), 'tools').text.content).toBe('⬜ 工具调用：关')
    // ...and drops the switches that no longer do anything.
    expect(buttonsOf(lastCard(1)).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'tools'])
    handle.stop()
  })

  it('repaints only after the persisted write lands (no stale repaint)', async () => {
    const { channel, click, lastCard } = makeChannel()
    const state = { ...ALL_ON }
    let release!: () => void
    const persisted = new Promise<void>((resolve) => { release = resolve })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: {
        get: () => state,
        // Persisting is asynchronous: the readable snapshot only changes at the
        // end, exactly like `settings.mutate` / `settingsScope.get()`.
        set: (key: DisplayToggleKey, value: boolean) => persisted.then(() => { state[key] = value }),
      },
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    const clicked = click({ messageId: 'om_1', action: { value: payloadOf(lastCard(0), 'tools') } })
    await new Promise(resolve => setTimeout(resolve, 0))
    // While the write is in flight nothing may be repainted — a repaint here
    // would render the PRE-write state, which is the bug this guards.
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)

    release()
    await clicked
    expect(channel.createCardInstance).toHaveBeenCalledTimes(2)
    expect(buttonFor(lastCard(1), 'tools').text.content).toBe('⬜ 工具调用：关')
    handle.stop()
  })

  it('keeps the refreshed card inside the originating topic', async () => {
    const { channel, click, lastCard } = makeChannel()
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: makeDisplay({ ...ALL_ON }).control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    const chat = { chatId: 'oc_1', chatType: 'group' as const, threadId: 'omt_1', rootId: 'om_root' }
    await handle.open(chat)
    expect(channel.sendCardByReference).toHaveBeenCalledWith('oc_1', 'card_1', { replyInThread: true, replyTo: 'om_root' })

    // cardAction events carry no thread info — the remembered coordinates must
    // put the refreshed card back in the same topic.
    await click({ messageId: 'om_1', action: { value: payloadOf(lastCard(0), 'args') } })
    expect(channel.sendCardByReference).toHaveBeenLastCalledWith('oc_1', 'card_2', { replyInThread: true, replyTo: 'om_root' })
    handle.stop()
  })

  it('ignores clicks from unknown cards and malformed values', async () => {
    const { channel, click, lastCard } = makeChannel()
    const { control, spy } = makeDisplay({ ...ALL_ON })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })

    // Unknown message id.
    await click({ messageId: 'om_nope', action: { value: JSON.stringify({ p: 'display', key: 'tools', value: false }) } })
    // Unrelated payload.
    await click({ messageId: 'om_1', action: { value: JSON.stringify({ p: 'busy', mode: 'steer' }) } })
    // Unknown switch key.
    await click({ messageId: 'om_1', action: { value: JSON.stringify({ p: 'display', key: 'nope', value: false }) } })
    // Non-boolean target.
    await click({ messageId: 'om_1', action: { value: JSON.stringify({ p: 'display', key: 'tools', value: 'off' }) } })
    // Not JSON at all.
    await click({ messageId: 'om_1', action: { value: 'not json' } })

    expect(spy).not.toHaveBeenCalled()
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    expect(lastCard(0)).toBeDefined()
    handle.stop()
  })

  it('stops responding after stop()', async () => {
    const { channel, getHandler, lastCard } = makeChannel()
    const { control, spy } = makeDisplay({ ...ALL_ON })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    const handler = getHandler()
    handle.stop()

    // The channel subscription is dropped and the remembered card is forgotten,
    // so even a click already in flight is ignored.
    expect(getHandler()).toBeUndefined()
    await handler!({ messageId: 'om_1', action: { value: payloadOf(lastCard(0), 'tools') } })
    expect(spy).not.toHaveBeenCalled()
  })

  it('swallows a send failure instead of breaking the click', async () => {
    const { channel, click, lastCard } = makeChannel()
    const state = { ...ALL_ON }
    const warn = vi.fn()
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: makeDisplay(state).control,
      logger: { warn, error: vi.fn() },
      getTranslations: () => t,
    } as any)
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    channel.createCardInstance.mockRejectedValueOnce(new Error('boom'))

    await click({ messageId: 'om_1', action: { value: payloadOf(lastCard(0), 'tools') } })
    // The setting still changed; only the card refresh failed.
    expect(state.tools).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    handle.stop()
  })
})
