import { describe, expect, it, vi } from 'vitest'
import { DISPLAY_KEYS, renderDisplayCard, startFeishuDisplay } from '../src/feishu-display.ts'
import type { DisplayToggleKey } from '../src/commands.ts'
import type { TranscriptView } from '../src/display-level.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')
const tEn = translationsFor('en')

function buttonsOf(card: any): any[] {
  return card.body.elements.filter((el: any) => el.tag === 'button')
}

/** Only the four SWITCH buttons (the card also carries four level buttons). */
function switchesOf(card: any): any[] {
  return buttonsOf(card).filter((b: any) => b.behaviors?.[0]?.value?.key !== undefined)
}

/** Only the four LEVEL buttons. */
function levelsOf(card: any): any[] {
  return buttonsOf(card).filter((b: any) => b.behaviors?.[0]?.value?.level !== undefined)
}

/** The switch-card input for one set of switches at the default level. */
function cardFor(switches: Record<DisplayToggleKey, boolean>, level = 'detailed' as const): any {
  return { level, switches }
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
    const card = renderDisplayCard(cardFor(ALL_ON), t) as any
    expect(card.header.title.content).toBe('📇 卡片显示')
    expect(DISPLAY_KEYS).toEqual(['reasoning', 'tools', 'args', 'results'])
    // Four level buttons on top, then one button per switch.
    expect(levelsOf(card)).toHaveLength(4)
    expect(switchesOf(card)).toHaveLength(4)
    expect(buttonFor(card, 'tools').text.content).toBe('✅ 工具调用：开')
    expect(buttonFor(card, 'tools').type).toBe('primary')
  })

  it('declares the callback through behaviors, never a top-level value', () => {
    const card = renderDisplayCard(cardFor(ALL_ON), t) as any
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
    const card = renderDisplayCard(cardFor({ ...ALL_ON, reasoning: false, args: false }), t) as any
    const reasoning = buttonFor(card, 'reasoning')
    expect(reasoning.text.content).toBe('⬜ 思考过程：关')
    expect(reasoning.type).toBe('default')
    // Clicking an off switch turns it on.
    expect(payloadOf(card, 'reasoning')).toEqual({ p: 'display', key: 'reasoning', value: true })
    expect(payloadOf(card, 'tools')).toEqual({ p: 'display', key: 'tools', value: false })
  })

  it('localizes the card', () => {
    const card = renderDisplayCard(cardFor(ALL_ON), tEn) as any
    expect(card.header.title.content).toBe('📇 Card display')
    expect(buttonFor(card, 'results').text.content).toBe('✅ Results: on')
    expect(payloadOf(card, 'results')).toMatchObject({ p: 'display' })
    expect(behaviorsOf(card, 'results')).toHaveLength(1)
  })

  it('hides the argument and result switches while tool display is off', () => {
    const card = renderDisplayCard(cardFor({ ...ALL_ON, tools: false }), t) as any
    // Only the two switches that still do something remain.
    expect(switchesOf(card).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'tools'])
    expect(buttonFor(card, 'tools').text.content).toBe('⬜ 工具调用：关')
    // The card says why two switches are missing instead of just looking broken.
    const markdown = card.body.elements
      .filter((el: any) => el.tag === 'markdown')
      .map((el: any) => el.content)
      .join('\n')
    expect(markdown).toContain('随「工具调用」一起隐藏')
  })

  it('brings the hidden switches back when tool display is re-enabled', () => {
    const card = renderDisplayCard(cardFor({ ...ALL_ON, tools: true, args: false, results: false }), t) as any
    expect(switchesOf(card).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'tools', 'args', 'results'])
    // The stored off values are preserved, not silently forced on.
    expect(buttonFor(card, 'args').text.content).toBe('⬜ 参数：关')
    expect(buttonFor(card, 'results').text.content).toBe('⬜ 结果：关')
  })
})

/**
 * Mutable display control stub: the setters record the call AND update state
 * (and the `state` object is the same reference `get`/`getLevel` read, so a
 * repaint after a write sees the new value — exactly like the volatile config
 * references in production).
 */
function makeDisplay(state: Record<DisplayToggleKey, boolean>, level: TranscriptView = 'detailed') {
  const spy = vi.fn()
  const levelSpy = vi.fn()
  return {
    spy,
    levelSpy,
    control: {
      get: () => state,
      set: (key: DisplayToggleKey, value: boolean): void => {
        spy(key, value)
        state[key] = value
      },
      getLevel: () => level,
      setLevel: (next: TranscriptView): void => {
        levelSpy(next)
        level = next
      },
    },
  }
}

function makeChannel() {
  let actionHandler: ((evt: any) => unknown) | undefined
  let nextMessage = 0
  const channel = {
    send: vi.fn(async (_to: string, _input: { card: object }, _opts?: unknown) => ({ messageId: `om_${++nextMessage}` })),
    updateCard: vi.fn(async (_messageId: string, _card: object) => undefined),
    onCardAction: vi.fn((handler: any) => { actionHandler = handler; return () => { actionHandler = undefined } }),
  }
  return {
    channel,
    click: (evt: any) => actionHandler!(evt),
    getHandler: () => actionHandler,
    sentCard: (index: number): any => channel.send.mock.calls[index]![1].card,
    repainted: (index: number): any => channel.updateCard.mock.calls[index]![1],
  }
}

describe('startFeishuDisplay', () => {
  it('posts the card as one message and returns its id', async () => {
    const { channel, sentCard } = makeChannel()
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: makeDisplay({ ...ALL_ON }).control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    const messageId = await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    expect(messageId).toBe('om_1')
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.send.mock.calls[0]![0]).toBe('oc_1')
    expect(sentCard(0).header.title.content).toBe('📇 卡片显示')
    handle.stop()
  })

  it('repaints the SAME message in place after a tap (the /busy contract)', async () => {
    const { channel, click, sentCard, repainted } = makeChannel()
    const { control, spy } = makeDisplay({ ...ALL_ON })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    await click({ messageId: 'om_1', action: { value: payloadOf(sentCard(0), 'tools') } })

    expect(spy).toHaveBeenCalledWith('tools', false)
    // ONE message for the whole interaction: no second card, no stale notice.
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.updateCard).toHaveBeenCalledTimes(1)
    expect(channel.updateCard.mock.calls[0]![0]).toBe('om_1')
    // The repainted card reflects the persisted value...
    expect(buttonFor(repainted(0), 'tools').text.content).toBe('⬜ 工具调用：关')
    // ...and drops the switches that no longer do anything.
    expect(switchesOf(repainted(0)).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'tools'])
    handle.stop()
  })

  it('repaints a level tap in place too, and marks the chosen level disabled', async () => {
    const { channel, click, sentCard, repainted } = makeChannel()
    const { control, levelSpy } = makeDisplay({ ...ALL_ON })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    const compact = levelsOf(sentCard(0)).find((b: any) => b.behaviors[0].value.level === 'compact')
    await click({ messageId: 'om_1', action: { value: compact.behaviors[0].value } })

    expect(levelSpy).toHaveBeenCalledWith('compact')
    expect(channel.updateCard).toHaveBeenCalledTimes(1)
    const chosen = levelsOf(repainted(0)).find((b: any) => b.behaviors[0].value.level === 'compact')
    expect(chosen.disabled).toBe(true)
    expect(chosen.type).toBe('primary')
    handle.stop()
  })

  it('repaints only after the persisted write lands (no stale repaint)', async () => {
    const { channel, click, sentCard, repainted } = makeChannel()
    const state = { ...ALL_ON }
    let release!: () => void
    const persisted = new Promise<void>((resolve) => { release = resolve })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: {
        get: () => state,
        getLevel: () => 'detailed' as const,
        setLevel: () => undefined,
        // Persisting is asynchronous: the readable snapshot only changes at the
        // end, exactly like `settings.mutate` / `settingsScope.get()`.
        set: (key: DisplayToggleKey, value: boolean) => persisted.then(() => { state[key] = value }),
      },
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    const clicked = click({ messageId: 'om_1', action: { value: payloadOf(sentCard(0), 'tools') } })
    await new Promise(resolve => setTimeout(resolve, 0))
    // While the write is in flight nothing may be repainted — a repaint here
    // would render the PRE-write state, which is the bug this guards.
    expect(channel.updateCard).not.toHaveBeenCalled()

    release()
    await clicked
    expect(buttonFor(repainted(0), 'tools').text.content).toBe('⬜ 工具调用：关')
    handle.stop()
  })

  it('posts the card inside the originating topic', async () => {
    const { channel } = makeChannel()
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: makeDisplay({ ...ALL_ON }).control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    await handle.open({ chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', rootId: 'om_root' })
    expect(channel.send.mock.calls[0]![2]).toEqual({ replyInThread: true, replyTo: 'om_root' })
    handle.stop()
  })

  it('honours a click on a card this instance never posted (e.g. from before a restart)', async () => {
    // The payload is enough to write the setting and the message id is enough to
    // repaint that very message, so a card outliving a plugin restart still works
    // — the old flow needed a remembered message→chat map and ignored such clicks.
    const { channel, click } = makeChannel()
    const { control, spy } = makeDisplay({ ...ALL_ON })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    await click({ messageId: 'om_from_before', action: { value: JSON.stringify({ p: 'display', key: 'tools', value: false }) } })
    expect(spy).toHaveBeenCalledWith('tools', false)
    expect(channel.updateCard).toHaveBeenCalledWith('om_from_before', expect.anything())
    handle.stop()
  })

  it('ignores unrelated and malformed payloads', async () => {
    const { channel, click } = makeChannel()
    const { control, spy } = makeDisplay({ ...ALL_ON })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    // No message id at all.
    await click({ action: { value: JSON.stringify({ p: 'display', key: 'tools', value: false }) } })
    // Unrelated card (the /busy picker).
    await click({ messageId: 'om_1', action: { value: JSON.stringify({ p: 'busy', mode: 'steer' }) } })
    // Unknown switch key.
    await click({ messageId: 'om_1', action: { value: JSON.stringify({ p: 'display', key: 'nope', value: false }) } })
    // Non-boolean target.
    await click({ messageId: 'om_1', action: { value: JSON.stringify({ p: 'display', key: 'tools', value: 'off' }) } })
    // Not JSON at all.
    await click({ messageId: 'om_1', action: { value: 'not json' } })

    expect(spy).not.toHaveBeenCalled()
    expect(channel.updateCard).not.toHaveBeenCalled()
    handle.stop()
  })

  it('stops responding after stop(), including a click already queued', async () => {
    const { channel, getHandler, sentCard } = makeChannel()
    const { control, spy } = makeDisplay({ ...ALL_ON })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    const handler = getHandler()
    const payload = payloadOf(sentCard(0), 'tools')
    handle.stop()

    expect(getHandler()).toBeUndefined()
    await handler!({ messageId: 'om_1', action: { value: payload } })
    expect(spy).not.toHaveBeenCalled()
  })

  it('swallows a repaint failure instead of breaking the click', async () => {
    const { channel, click, sentCard } = makeChannel()
    const state = { ...ALL_ON }
    const warn = vi.fn()
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: makeDisplay(state).control,
      logger: { warn, error: vi.fn() },
      getTranslations: () => t,
    } as any)
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    channel.updateCard.mockRejectedValueOnce(new Error('boom'))

    await click({ messageId: 'om_1', action: { value: payloadOf(sentCard(0), 'tools') } })
    // The setting still changed; only the card refresh failed.
    expect(state.tools).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    handle.stop()
  })
})
