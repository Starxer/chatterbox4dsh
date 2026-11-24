import { describe, expect, it, vi } from 'vitest'
import { DISPLAY_KEYS, renderDisplayCard, startFeishuDisplay } from '../src/feishu-display.ts'
import type { DisplayToggleKey } from '../src/commands.ts'
import type { TranscriptView } from '../src/display-level.ts'
import { resolveDisplaySettings, type ToolDetail } from '../src/display-level.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')
const tEn = translationsFor('en')

/** Every button at any depth (choices are laid out inside `column_set` rows). */
function buttonsOf(card: any): any[] {
  const out: any[] = []
  const walk = (elements: any[] | undefined): void => {
    for (const el of elements ?? []) {
      if (el.tag === 'button') out.push(el)
      if (Array.isArray(el.elements)) walk(el.elements)
      if (Array.isArray(el.columns)) for (const column of el.columns) walk(column.elements)
    }
  }
  walk(card.body.elements)
  return out
}

/** Every markdown string at any depth. */
function markdownsOf(card: any): string[] {
  const out: string[] = []
  const walk = (elements: any[] | undefined): void => {
    for (const el of elements ?? []) {
      if (el.tag === 'markdown' && typeof el.content === 'string') out.push(el.content)
      if (Array.isArray(el.elements)) walk(el.elements)
      if (Array.isArray(el.columns)) for (const column of el.columns) walk(column.elements)
    }
  }
  walk(card.body.elements)
  return out
}

/** Only the four SWITCH buttons (the card also carries four level buttons). */
function switchesOf(card: any): any[] {
  return buttonsOf(card).filter((b: any) => b.behaviors?.[0]?.value?.key !== undefined)
}

/**
 * Card input for one set of switches at a level/preset.
 *
 * The card reads EFFECTIVE settings (preset + explicit overrides), so build them
 * through the same resolver the plugin uses rather than hand-writing an object.
 */
function cardFor(
  switches: Record<DisplayToggleKey, boolean>,
  level: TranscriptView = 'detailed',
  toolRow: 'tool' | 'tool-description' | 'description' = 'tool',
  overrides: {
    toolDetail?: ToolDetail
    outputFull?: boolean
    folded?: boolean
    preview?: boolean
    lengths?: Partial<Record<'args' | 'result', number>>
  } = {},
): any {
  const settings = resolveDisplaySettings({
    transcriptView: level,
    showReasoning: switches.reasoning,
    showToolCalls: switches.tools,
    showToolArgs: switches.args,
    showToolResults: switches.results,
    reasoningFold: overrides.folded ?? true,
    ...(overrides.toolDetail === undefined ? {} : { toolDetail: overrides.toolDetail }),
    ...(overrides.outputFull === undefined ? {} : { toolOutputFull: overrides.outputFull }),
  })
  return {
    mode: settings.mode,
    settings,
    switches,
    folded: settings.reasoningFold,
    toolDetail: settings.tools,
    outputFull: settings.toolOutputFull,
    lengths: { args: 2000, result: 1500, ...overrides.lengths },
    toolRow,
  }
}

/** Mode buttons (compact / detailed). */
const modesOf = (card: any): any[] =>
  buttonsOf(card).filter((b: any) => b.behaviors?.[0]?.value?.mode !== undefined)

/** Tool-detail buttons (off / count / summary / full). */
const toolDetailOf = (card: any): any[] =>
  buttonsOf(card).filter((b: any) => b.behaviors?.[0]?.value?.toolDetail !== undefined)

/** Tool-output buttons (cut / full). */
const outputOf = (card: any): any[] =>
  buttonsOf(card).filter((b: any) => b.behaviors?.[0]?.value?.outputFull !== undefined)

/** Truncation-length buttons. */
const lengthsOf = (card: any): any[] =>
  buttonsOf(card).filter((b: any) => b.behaviors?.[0]?.value?.length !== undefined)

/** Every button controlling one boolean switch, in render order (show, hide). */
function switchButtonsOf(card: any, key: DisplayToggleKey): any[] {
  return buttonsOf(card).filter((b: any) => b.behaviors?.[0]?.value?.key === key)
}

/** Only the compact tool-row style buttons. */
function toolRowsOf(card: any): any[] {
  return buttonsOf(card).filter((b: any) => b.behaviors?.[0]?.value?.toolRow !== undefined)
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

it('localizes pending-attachment notices and omits zero-count kinds', () => {
  expect(t.pendingAttachmentsNotice(2, 0)).toContain('2 张图片，')
  expect(t.pendingAttachmentsNotice(2, 0)).not.toContain('0 个文件')
  expect(t.pendingAttachmentsNotice(0, 1)).toContain('1 个文件，')
  expect(t.pendingAttachmentsNotice(2, 1)).toContain('2 张图片、1 个文件')
  expect(tEn.pendingAttachmentsNotice(1, 0)).toContain('1 image,')
  expect(tEn.pendingAttachmentsNotice(0, 2)).toContain('2 files,')
  expect(tEn.pendingAttachmentsNotice(1, 1)).toContain('1 image and 1 file,')
  expect(t.pendingAttachmentsDiscarded).toBe('已清除上一会话暂存的附件。')
})

describe('renderDisplayCard', () => {
  it('shows the four refresh options with the current option disabled, in both locales', () => {
    for (const strings of [t, tEn]) {
      const card = renderDisplayCard({ ...cardFor(ALL_ON), elapsedRefreshSeconds: 10 }, strings)
      const ticks = buttonsOf(card).filter(b => b.behaviors[0].value.tick !== undefined)
      expect(ticks.map(b => b.behaviors[0].value.tick)).toEqual([3, 5, 10, 30])
      expect(ticks.find(b => b.behaviors[0].value.tick === 10)).toMatchObject({ type: 'primary' })
      expect(ticks.find(b => b.behaviors[0].value.tick === 10).disabled).toBeUndefined()
      expect(ticks.find(b => b.behaviors[0].value.tick === 3).disabled).toBeUndefined()
    }
  })

  it('renders the mode, thinking, tool and length rows', () => {
    const card = renderDisplayCard(cardFor(ALL_ON), t) as any
    expect(card.header.title.content).toBe('📇 卡片显示')
    // Two modes, no presets: the retired level names are gone from the card.
    expect(modesOf(card).map((b: any) => b.behaviors[0].value.mode)).toEqual(['compact', 'detailed'])
    expect(markdownsOf(card).join('\n')).not.toContain('预设')
    // The detailed mode offers the thinking switches and the tool rows.
    // Each boolean switch is a SHOW / HIDE pair (state, not a greyed-out toggle).
    expect(switchesOf(card).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'reasoning', 'args', 'args', 'results', 'results'])
    expect(toolDetailOf(card)).toHaveLength(3)
    expect(outputOf(card)).toHaveLength(2)
    expect(lengthsOf(card)).toHaveLength(8)
  })

  it('offers no inert rows in the compact mode', () => {
    const card = renderDisplayCard(cardFor(ALL_ON, 'compact'), t) as any
    expect(modesOf(card)).toHaveLength(2)
    // Compact DOES show the thinking switch now (2026-11-25): its turn card
    // carries each step's chain as a folded panel. Everything else stays hidden
    // because compact's card carries the answer and the tool timeline:
    // - the fold/flat choice cannot apply (compact always folds),
    // - the tool-detail switches, the payload switches and the output switch
    //   would change nothing.
    const switches = switchesOf(card)
    expect(switches).toHaveLength(2)
    expect(switches.every(button => button.behaviors[0].value.key === 'reasoning')).toBe(true)
    expect(buttonsOf(card).filter(button => button.behaviors?.[0]?.value?.folded !== undefined)).toHaveLength(0)
    expect(toolDetailOf(card)).toHaveLength(0)
    expect(outputOf(card)).toHaveLength(0)
    expect(toolRowsOf(card)).toHaveLength(3)
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

  it('marks the active choices and carries TARGET values, not toggle markers', () => {
    const card = renderDisplayCard(cardFor({ ...ALL_ON, reasoning: false, args: false }), t) as any
    const [showReasoning, hideReasoning] = switchButtonsOf(card, 'reasoning')
    expect(showReasoning.text.content).toBe('显示')
    expect(showReasoning.type).toBe('default')
    // The current value carries a check mark and the blue highlight.
    expect(hideReasoning.text.content).toBe('✓ 隐藏')
    expect(hideReasoning.type).toBe('primary')
    // Clicking an off switch turns it on.
    expect(payloadOf(card, 'reasoning')).toEqual({ p: 'display', key: 'reasoning', value: true })
    expect(payloadOf(card, 'args')).toEqual({ p: 'display', key: 'args', value: true })
    // The preset/preset buttons mark the ACTIVE one as primary + disabled.
    const activeMode = modesOf(card).find((b: any) => b.behaviors[0].value.mode === 'detailed')
    expect(activeMode).toMatchObject({ type: 'primary' })
    expect(activeMode.disabled).toBeUndefined()
    expect(activeMode.text.content).toBe('✓ 详细')
  })

  it('localizes the card', () => {
    const card = renderDisplayCard(cardFor(ALL_ON), tEn) as any
    expect(card.header.title.content).toBe('📇 Card display')
    const [showResults, hideResults] = switchButtonsOf(card, 'results')
    expect(showResults.text.content).toBe('✓ Results·Show')
    expect(hideResults.text.content).toBe('Results·Hide')
    expect(payloadOf(card, 'results')).toMatchObject({ p: 'display' })
    expect(behaviorsOf(card, 'results')).toHaveLength(1)
    expect(markdownsOf(card).join('\n')).toContain('Mode')
  })

  it('offers the compact tool-row styles only in the compact mode', () => {
    const compact = renderDisplayCard(cardFor(ALL_ON, 'compact', 'tool-description'), t) as any
    const rows = toolRowsOf(compact)
    expect(rows.map((b: any) => b.behaviors[0].value.toolRow)).toEqual(['tool', 'tool-description', 'description'])
    const activeRow = rows.find((b: any) => b.behaviors[0].value.toolRow === 'tool-description')
    expect(activeRow).toMatchObject({ type: 'primary' })
    expect(activeRow.disabled).toBeUndefined()
    expect(toolRowsOf(renderDisplayCard(cardFor(ALL_ON, 'detailed'), t))).toHaveLength(0)
  })

  it('marks the active tool detail and flips it with one tap', () => {
    const summary = renderDisplayCard(cardFor(ALL_ON, 'standard'), t) as any
    const activeDetail = toolDetailOf(summary).find((b: any) => b.behaviors[0].value.toolDetail === 'summary')
    expect(activeDetail).toMatchObject({ type: 'primary' })
    expect(activeDetail.disabled).toBeUndefined()
    expect(switchesOf(summary).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'reasoning'])

    const full = renderDisplayCard(cardFor(ALL_ON, 'detailed'), t) as any
    expect(toolDetailOf(full).find((b: any) => b.behaviors[0].value.toolDetail === 'full')).toMatchObject({ type: 'primary' })
    // `full` brings the argument/result switches back.
    expect(switchesOf(full).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'reasoning', 'args', 'args', 'results', 'results'])
  })

  it('marks the active truncation lengths', () => {
    const card = renderDisplayCard(cardFor(ALL_ON, 'detailed', 'tool', { lengths: { result: 3000 } }), t) as any
    expect(lengthsOf(card).filter((b: any) => b.behaviors[0].value.length === 'result').map((b: any) => b.behaviors[0].value.chars)).toEqual([500, 1000, 1500, 3000])
    expect(lengthsOf(card).find((b: any) => b.behaviors[0].value.length === 'result' && b.behaviors[0].value.chars === 3000)).toMatchObject({ type: 'primary' })
  })

  it('keeps the compact-only note out of the detailed mode', () => {
    const detailed = renderDisplayCard(cardFor(ALL_ON, 'detailed'), t) as any
    expect(markdownsOf(detailed).join('\n')).not.toContain('工具行')
  })

  it('hides the argument and result switches unless the tool section is full', () => {
    const off = renderDisplayCard(cardFor({ ...ALL_ON, tools: false }), t) as any
    expect(switchesOf(off).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'reasoning'])
    const summary = renderDisplayCard(cardFor(ALL_ON, 'standard'), t) as any
    expect(switchesOf(summary).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'reasoning'])
    const full = renderDisplayCard(cardFor(ALL_ON, 'detailed'), t) as any
    expect(switchesOf(full).map((b: any) => b.behaviors[0].value.key)).toEqual(['reasoning', 'reasoning', 'args', 'args', 'results', 'results'])
  })

  it('preserves stored off values when the switches come back', () => {
    const card = renderDisplayCard(cardFor({ ...ALL_ON, args: false, results: false }, 'verbose'), t) as any
    // Both are stored off: the HIDE side carries the check mark, and the stored
    // value is preserved (not silently turned back on).
    const [, hideArgs] = switchButtonsOf(card, 'args')
    expect(hideArgs.text.content).toBe('✓ 参数·隐藏')
    const [, hideResults] = switchButtonsOf(card, 'results')
    expect(hideResults.text.content).toBe('✓ 结果·隐藏')
  })

})

/**
 * Mutable display control stub: the setters record the call AND update state
 * (and the `state` object is the same reference `get`/`getLevel` read, so a
 * repaint after a write sees the new value — exactly like the volatile config
 * references in production).
 */
function makeDisplay(
  state: Record<DisplayToggleKey, boolean>,
  level: TranscriptView = 'detailed',
  toolRow: 'tool' | 'tool-description' | 'description' = 'tool',
) {
  const spy = vi.fn()
  const levelSpy = vi.fn()
  const tickSpy = vi.fn()
  const toolRowSpy = vi.fn()
  const foldSpy = vi.fn()
  const lengthSpy = vi.fn()
  let seconds = 5
  let folded = true
  let preview = true
  let toolDetail: ToolDetail | undefined
  let outputFull: boolean | undefined
  const lengths = { args: 2000, result: 1500 }
  const settings = () => resolveDisplaySettings({
    transcriptView: level,
    showReasoning: state.reasoning,
    showToolCalls: state.tools,
    showToolArgs: state.args,
    showToolResults: state.results,
    reasoningFold: folded,
    ...(toolDetail === undefined ? {} : { toolDetail }),
    ...(outputFull === undefined ? {} : { toolOutputFull: outputFull }),
  })
  return {
    spy,
    levelSpy,
    tickSpy,
    toolRowSpy,
    foldSpy,
    lengthSpy,
    control: {
      getSettings: settings,
      getToolDetail: () => settings().tools,
      setToolDetail: (next: ToolDetail): void => { toolDetail = next },
      getOutputFull: () => settings().toolOutputFull,
      setOutputFull: (next: boolean): void => { outputFull = next },
      getPreviewChars: (field: 'args' | 'result'): number => lengths[field],
      setPreviewChars: (field: 'args' | 'result', chars: number): void => {
        lengthSpy(field, chars)
        lengths[field] = chars
      },
      getPreview: () => preview,
      setPreview: (next: boolean): void => { preview = next },
      getFold: () => folded,
      setFold: (next: boolean): void => {
        foldSpy(next)
        folded = next
      },
      getToolRow: () => toolRow,
      setToolRow: (next: 'tool' | 'tool-description' | 'description'): void => {
        toolRowSpy(next)
        toolRow = next
      },
      getElapsedRefreshSeconds: () => seconds,
      setElapsedRefreshSeconds: (next: number): void | Promise<void> => { tickSpy(next); seconds = next },
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
  it('persists a tool-row style tap then repaints the SAME card', async () => {
    const { channel, click, sentCard, repainted } = makeChannel()
    const { control, toolRowSpy } = makeDisplay(ALL_ON, 'compact')
    const handle = startFeishuDisplay({ channel, display: control, logger: { warn: vi.fn(), error: vi.fn() }, getTranslations: () => t })
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    const target = toolRowsOf(sentCard(0))
      .find((b: any) => b.behaviors[0].value.toolRow === 'description')
    await click({ messageId: 'om_1', action: { value: target.behaviors[0].value } })
    expect(toolRowSpy).toHaveBeenCalledWith('description')
    // In place: the same message is repainted, and the new style is the state.
    expect(channel.updateCard.mock.calls[0]![0]).toBe('om_1')
    const activeRow = toolRowsOf(repainted(0)).find((b: any) => b.behaviors[0].value.toolRow === 'description')
    expect(activeRow).toMatchObject({ type: 'primary' })
    expect(activeRow.disabled).toBeUndefined()
    handle.stop()
  })

  it('persists a refresh tap then repaints the SAME card, ignoring invalid intervals', async () => {
    const { channel, click, repainted } = makeChannel()
    const { control, tickSpy } = makeDisplay({ ...ALL_ON })
    let release!: () => void
    const persisted = new Promise<void>(resolve => { release = resolve })
    const setTick = control.setElapsedRefreshSeconds
    control.setElapsedRefreshSeconds = next => persisted.then(() => setTick(next))
    const handle = startFeishuDisplay({ channel, display: control, logger: { warn: vi.fn(), error: vi.fn() }, getTranslations: () => t })
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    const pending = click({ messageId: 'om_1', action: { value: { p: 'display', tick: 3 } } })
    await Promise.resolve()
    expect(channel.updateCard).not.toHaveBeenCalled()
    release()
    await pending
    expect(tickSpy).toHaveBeenCalledWith(3)
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.updateCard.mock.calls[0]![0]).toBe('om_1')
    expect(buttonsOf(repainted(0)).find(b => b.behaviors[0].value.tick === 3).disabled).toBeUndefined()
    for (const tick of [0, 4, 5000, '3', null]) {
      await click({ messageId: 'om_1', action: { value: { p: 'display', tick } } })
    }
    expect(tickSpy).toHaveBeenCalledTimes(1)
    handle.stop()
  })

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
    // The SHOW side carries the current value (a no-op), so a real switch taps
    // the HIDE side.
    const hide = switchButtonsOf(sentCard(0), 'reasoning').find((b: any) => b.behaviors[0].value.value === false)
    await click({ messageId: 'om_1', action: { value: hide.behaviors[0].value } })

    expect(spy).toHaveBeenCalledWith('reasoning', false)
    // ONE message for the whole interaction: no second card, no stale notice.
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.updateCard).toHaveBeenCalledTimes(1)
    expect(channel.updateCard.mock.calls[0]![0]).toBe('om_1')
    // The repainted card reflects the persisted value.
    const [, hideAfter] = switchButtonsOf(repainted(0), 'reasoning')
    expect(hideAfter.text.content).toBe('✓ 隐藏')
    handle.stop()
  })

  it('repaints a mode tap in place too, and marks the chosen mode disabled', async () => {
    const { channel, click, sentCard, repainted } = makeChannel()
    const { control, levelSpy } = makeDisplay({ ...ALL_ON })
    const handle = startFeishuDisplay({
      channel: channel as any,
      display: control,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    const compact = modesOf(sentCard(0)).find((b: any) => b.behaviors[0].value.mode === 'compact')
    await click({ messageId: 'om_1', action: { value: compact.behaviors[0].value } })

    expect(levelSpy).toHaveBeenCalledWith('compact')
    expect(channel.updateCard).toHaveBeenCalledTimes(1)
    const chosen = modesOf(repainted(0)).find((b: any) => b.behaviors[0].value.mode === 'compact')
    expect(chosen.disabled).toBeUndefined()
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
        getSettings: () => resolveDisplaySettings({
          transcriptView: 'detailed',
          showReasoning: state.reasoning,
          showToolCalls: state.tools,
          showToolArgs: state.args,
          showToolResults: state.results,
        }),
        getToolDetail: () => 'full' as const,
        setToolDetail: () => undefined,
        getOutputFull: () => false,
        setOutputFull: () => undefined,
        getPreviewChars: () => 200,
        setPreviewChars: () => undefined,
        getFold: () => true,
        setFold: () => undefined,
        getPreview: () => true,
        setPreview: () => undefined,
        getLevel: () => 'detailed' as const,
        setLevel: () => undefined,
        getElapsedRefreshSeconds: () => 5,
        setElapsedRefreshSeconds: () => undefined,
        getToolRow: () => 'tool' as const,
        setToolRow: () => undefined,
        // Persisting is asynchronous: the readable snapshot only changes at the
        // end, exactly like `settings.mutate` / `settingsScope.get()`.
        set: (key: DisplayToggleKey, value: boolean) => persisted.then(() => { state[key] = value }),
      },
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    const hide = switchButtonsOf(sentCard(0), 'reasoning').find((b: any) => b.behaviors[0].value.value === false)
    const clicked = click({ messageId: 'om_1', action: { value: hide.behaviors[0].value } })
    await new Promise(resolve => setTimeout(resolve, 0))
    // While the write is in flight nothing may be repainted — a repaint here
    // would render the PRE-write state, which is the bug this guards.
    expect(channel.updateCard).not.toHaveBeenCalled()

    release()
    await clicked
    const [, hideAfter] = switchButtonsOf(repainted(0), 'reasoning')
    expect(hideAfter.text.content).toBe('✓ 隐藏')
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

    const hide = switchButtonsOf(sentCard(0), 'reasoning').find((b: any) => b.behaviors[0].value.value === false)
    await click({ messageId: 'om_1', action: { value: hide.behaviors[0].value } })
    // The setting still changed; only the card refresh failed.
    expect(state.reasoning).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    handle.stop()
  })
})
