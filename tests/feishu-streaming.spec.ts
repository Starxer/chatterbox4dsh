import { describe, expect, it, vi } from 'vitest'
import { deriveToolSummary, renderStepCard, startFeishuStreaming } from '../src/feishu-streaming.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

function codeBlocksOf(card: any): string[] {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    // A fenced block now carries a label line before the fence (e.g. "⚙️ 参数"),
    // so match on the fence presence rather than block start.
    .filter((c: string) => c.includes('```'))
}

function mdOf(card: any): string {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    .join('\n')
}

describe('renderStepCard tool result/args rendering', () => {
  it('falls back to the raw result when a matched card view has no content', () => {
    // bash terminal view without `output` → must still show the raw result.
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'bash', callId: 'c1', arguments: '{"command":"ls"}', startedAt: 0,
      result: { isError: false, content: 'out.txt\nin.txt', elapsed: 12 },
      resultView: { card: 'terminal' },
    }]) as any
    const blocks = codeBlocksOf(card)
    expect(blocks.some(b => b.includes('out.txt'))).toBe(true)
  })

  it('renders args in a fenced code block, tolerating backticks', () => {
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'bash', callId: 'c1', arguments: '{"command":"echo `x`"}', startedAt: 0,
      result: { isError: false, content: 'ok', elapsed: 5 },
      resultView: { card: 'terminal', output: 'ok' },
    }]) as any
    const blocks = codeBlocksOf(card)
    const argsBlock = blocks.find(b => b.includes('echo'))
    expect(argsBlock).toBeDefined()
    expect(argsBlock).toContain('echo `x`')
    // Each fenced block carries its own label so args and result are distinct.
    expect(argsBlock).toContain('**⚙️ 参数**')
  })

  it('labels both the args and result code blocks', () => {
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'bash', callId: 'c1', arguments: '{"command":"ls"}', startedAt: 0,
      result: { isError: false, content: 'out.txt\nin.txt', elapsed: 12 },
      resultView: { card: 'terminal', output: 'out.txt\nin.txt' },
    }]) as any
    const md = mdOf(card)
    expect(md).toContain('**⚙️ 参数**')
    expect(md).toContain('**📤 结果**')
    // Result label appears before the output text.
    expect(md.indexOf('**📤 结果**')).toBeLessThan(md.indexOf('out.txt'))
  })

  it('shows raw content when the tool meta carries no card/shape (the real bash case)', () => {
    // Real tool `meta` is `{ viewport, waitReason, sessionStatus, truncated }`
    // — no `card`, and the raw content is the authoritative display source.
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'bash', callId: 'c1', arguments: '{"command":"ls"}', startedAt: 0,
      result: { isError: false, content: 'out.txt\nin.txt', elapsed: 12 },
      resultView: { viewport: { rows: 24 }, waitReason: 'exited', sessionStatus: 0 },
    }]) as any
    const blocks = codeBlocksOf(card)
    expect(blocks.some(b => b.includes('out.txt'))).toBe(true)
  })

  it('renders a read-shaped meta as a line-numbered block', () => {
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'read', callId: 'c1', arguments: '{"path":"/a"}', startedAt: 0,
      result: { isError: false, content: '12│ b', elapsed: 1 },
      resultView: { path: '/a', lines: [{ number: 12, text: 'b' }], lang: 'ts' },
    }]) as any
    const blocks = codeBlocksOf(card)
    expect(blocks.some(b => b.includes('12│ b'))).toBe(true)
  })

  it('renders an edit-shaped meta as a before/after diff block', () => {
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'edit', callId: 'c1', arguments: '{"file_path":"/a"}', startedAt: 0,
      result: { isError: false, content: 'a -> b', elapsed: 1 },
      resultView: { diffs: [{ path: '/a', oldText: 'foo', newText: 'bar' }] },
    }]) as any
    const md = card.body.elements
      .filter((el: any) => el.tag === 'markdown')
      .map((el: any) => el.content)
      .join('\n')
    expect(md).toContain('- foo')
    expect(md).toContain('+ bar')
  })
})


describe('deriveToolSummary', () => {
  it('bash uses description, falling back to command', () => {
    expect(deriveToolSummary('bash', JSON.stringify({ description: 'List notes', command: 'ls' }))).toBe('List notes')
    expect(deriveToolSummary('bash', JSON.stringify({ command: 'pwd' }))).toBe('pwd')
  })

  it('maps pwsh to the bash summary keys', () => {
    expect(deriveToolSummary('pwsh', JSON.stringify({ command: 'Get-ChildItem' }))).toBe('Get-ChildItem')
  })

  it('search joins multiple queries', () => {
    expect(deriveToolSummary('web_search', JSON.stringify({ queries: ['foo', 'bar'] }))).toBe('foo, bar')
  })

  it('search falls back to a single query', () => {
    expect(deriveToolSummary('grep', JSON.stringify({ query: 'TODO' }))).toBe('TODO')
  })

  it('file tools use the path', () => {
    expect(deriveToolSummary('read', JSON.stringify({ path: 'src/index.ts' }))).toBe('src/index.ts')
    expect(deriveToolSummary('write', JSON.stringify({ file_path: 'a.txt' }))).toBe('a.txt')
    expect(deriveToolSummary('edit', JSON.stringify({ path: 'b.md' }))).toBe('b.md')
  })

  it('code uses description', () => {
    expect(deriveToolSummary('run_code', JSON.stringify({ code: 'console.log(1)', description: 'print one' }))).toBe('print one')
  })

  it('summarizes DSH present by its delivered paths, not the raw files array', () => {
    expect(deriveToolSummary('present', JSON.stringify({ files: [{ path: 'out/report.md' }] }))).toBe('交付文件：out/report.md')
    expect(deriveToolSummary('present', JSON.stringify({ files: [{ path: 'a.txt' }, { path: 'b.txt' }, { path: 'c.txt' }] }))).toBe('交付文件：a.txt +2')
    // Empty/garbled args fall back to the generic rule rather than throwing.
    expect(deriveToolSummary('present', JSON.stringify({ files: [] }))).toBe('交付文件：0')
    expect(deriveToolSummary('present', 'not-json')).toBe('present · not-json')
  })

  it('unknown tools prefix the tool name with the first string field', () => {
    expect(deriveToolSummary('my_custom_tool', JSON.stringify({ what: 'do the thing' }))).toBe('my_custom_tool · do the thing')
  })

  it('titled tools (e.g. cordis_run) do not prefix the tool name', () => {
    // `cordis_run` is a legacy name: the Web UI still maps it so tool calls
    // recorded by older sessions keep rendering, and this table mirrors that.
    expect(deriveToolSummary('cordis_run', JSON.stringify({ package: 'pkg' }))).toBe('pkg')
  })

  it('plugin_manager falls back to the generic tool-name prefix with its action', () => {
    // New in DSH 0.1.6-alpha.2 and not in the Web UI's variant map, so the
    // generic `others` rule (name · first string field) is the aligned render.
    expect(deriveToolSummary('plugin_manager', JSON.stringify({ action: 'list_bundles' }))).toBe('plugin_manager · list_bundles')
  })

  it('non-JSON args fall back to the first line of the raw string', () => {
    expect(deriveToolSummary('bash', 'not json\nsecond line')).toBe('not json')
  })

  it('todo_write yields task counts instead of raw JSON', () => {
    const args = JSON.stringify({ todos: [
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'completed' },
    ] })
    expect(deriveToolSummary('todo_write', args)).toBe('待办清单：4 项 · 进行中 2 · 待办 1 · 完成 1')
  })

  it('empty or non-string args fall back to the raw text', () => {
    expect(deriveToolSummary('bash', '')).toBe('')
    expect(deriveToolSummary('bash', '{"a":1}')).toBe('{"a":1}')
  })
})

describe('renderStepCard reasoning + args budgets', () => {
  it('caps reasoning to a short preview window (200 chars)', () => {
    const reasoning = 'x'.repeat(500)
    const card = renderStepCard(t, reasoning, undefined, []) as any
    const md = mdOf(card)
    expect(md).toContain(`${'x'.repeat(200)}\n…(truncated)`)
    expect(md).not.toContain('x'.repeat(201))
  })

  it('shows JSON args pretty-printed (not a one-line digest) up to an expanded cap', () => {
    const args = '{"command":"echo hello","flags":["-l","-a"],"path":"/tmp/file.txt"}'
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'bash', callId: 'c1', arguments: args, startedAt: 0,
      result: { isError: false, content: 'ok', elapsed: 5 },
      resultView: { card: 'terminal', output: 'ok' },
    }]) as any
    const md = mdOf(card)
    // The args block carries each key on its own line (pretty JSON), not `…`.
    expect(md).toContain('"command": "echo hello"')
    expect(md).toContain('"flags"')
    expect(md).toContain('"path": "/tmp/file.txt"')
    expect(md).not.toContain('…(truncated)')
  })

  it('caps step card text at 3000 chars without a truncation marker (overflow goes to follow-up cards)', () => {
    const longText = 'a'.repeat(5000)
    const card = renderStepCard(t, undefined, longText, []) as any
    const md = mdOf(card)
    // First 3000 chars are present, remainder is not.
    expect(md).toContain('a'.repeat(3000))
    expect(md).not.toContain('a'.repeat(3001))
    // No truncation marker — overflow is handled by separate cards.
    expect(md).not.toContain('…(truncated)')
  })

  it('moves a table to the next card instead of cutting it at the character cap', () => {
    // 2990 chars of filler puts the old fixed slice (3000) eight characters into
    // the table, which rendered it as two broken halves (2026-09-18 report).
    const filler = 'x'.repeat(2990)
    const table = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const card = renderStepCard(t, undefined, `${filler}\n\n${table}`, []) as any
    const md = mdOf(card)
    expect(md).toContain(filler)
    expect(md).not.toContain('| a | b |')
    expect(md).not.toContain('| --- | --- |')
  })

  it('renders the step text in full when it fits the budget', () => {
    const text = ['short paragraph', '', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const card = renderStepCard(t, undefined, text, []) as any
    expect(mdOf(card)).toContain('| --- | --- |')
  })

  it('renders the step footer as two notation lines (timing/tokens, then speed/context)', () => {
    const card = renderStepCard(
      t, undefined, undefined, [],
      { inputTokens: 10, outputTokens: 100 },
      2000,
      300,
      { contextWindow: 1000, lastInputTokens: 500 },
    ) as any
    const footers = card.body.elements
      .filter((el: any) => el.tag === 'markdown' && el.text_size === 'notation')
      .map((el: any) => el.content)
    expect(footers).toHaveLength(2)
    expect(footers[0]).toContain('⏱ 2.0s')
    expect(footers[0]).toContain('📥 10 → 📤 100')
    expect(footers[0]).not.toContain('tok/s')
    expect(footers[1]).toContain('🚀 300 tok/s')
    expect(footers[1]).toContain('📊 500/1K (50%)')
  })

  it('reports new input (uncached + cache write) with a reuse rate, never the whole prompt', () => {
    const footerOf = (usage: object): string => {
      const card = renderStepCard(t, undefined, undefined, [], usage as any) as any
      return card.body.elements
        .filter((el: any) => el.tag === 'markdown' && el.text_size === 'notation')
        .map((el: any) => el.content)[0]
    }
    // DeepSeek-style route: no cache-write bucket, so 📥 is the cache miss and
    // the rest of the 50K prompt is reuse.
    expect(footerOf({ inputTokens: 800, outputTokens: 320, cacheReadTokens: 49200 }))
      .toContain('📥 800 (♻️ 98%) → 📤 320')
    // Anthropic-style route: cache writes are new work too and must be counted.
    expect(footerOf({ inputTokens: 100, outputTokens: 10, cacheWriteTokens: 900, cacheReadTokens: 9000 }))
      .toContain('📥 1K (♻️ 90%) → 📤 10')
    // No cache activity at all: plain arrow, no reuse marker.
    expect(footerOf({ inputTokens: 700, outputTokens: 100, cacheWriteTokens: 100 }))
      .toContain('📥 800 → 📤 100')
    expect(footerOf({ inputTokens: 700, outputTokens: 100, cacheWriteTokens: 100 }))
      .not.toContain('♻️')
  })

  it('shows the reasoning duration, thinking tokens and the turn/step position', () => {
    const card = renderStepCard(
      t, 'thinking', undefined, [],
      { inputTokens: 10, outputTokens: 2000, reasoningTokens: 1200 }, undefined, undefined, undefined,
      3200, 2, 3,
    ) as any
    expect(mdOf(card)).toContain('3.2s · 1.2K tokens')
    expect(card.header.title.content).toBe('回复 · 第 2 轮 · 第 3 步')

    // Without timing/position/usage the header stays plain.
    const plain = renderStepCard(t, 'thinking', undefined, []) as any
    expect(plain.header.title.content).toBe('回复')
    expect(mdOf(plain)).not.toContain('3.2s')
    expect(mdOf(plain)).not.toContain('tokens')
  })
})

describe('renderStepCard display toggles', () => {
  const tool = {
    toolName: 'bash', callId: 'c1', arguments: '{"command":"ls"}', startedAt: 0,
    result: { isError: false, content: 'out.txt', inline: 'out.txt', elapsed: 5 },
    resultView: { card: 'terminal', output: 'out.txt' },
  }

  it('renders args and result blocks by default', () => {
    const md = mdOf(renderStepCard(t, undefined, undefined, [tool]) as any)
    expect(md).toContain('**⚙️ 参数**')
    expect(md).toContain('**📤 结果**')
  })

  it('drops only the args block when showToolArgs is false', () => {
    const md = mdOf(renderStepCard(
      t, undefined, undefined, [tool], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { showToolArgs: false },
    ) as any)
    expect(md).not.toContain('**⚙️ 参数**')
    expect(md).toContain('**📤 结果**')
  })

  it('drops only the result block when showToolResults is false', () => {
    const md = mdOf(renderStepCard(
      t, undefined, undefined, [tool], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { showToolResults: false },
    ) as any)
    expect(md).toContain('**⚙️ 参数**')
    expect(md).not.toContain('**📤 结果**')
  })
})

// ---------------------------------------------------------------------------
// Step-card delivery path: CardKit instance (no edit cap) vs send + patch
// ---------------------------------------------------------------------------

interface StepChannel {
  send: ReturnType<typeof vi.fn>
  updateCard: ReturnType<typeof vi.fn>
  createCardInstance?: ReturnType<typeof vi.fn>
  sendCardByReference?: ReturnType<typeof vi.fn>
  updateCardInstance?: ReturnType<typeof vi.fn>
  registerPendingCardFlush?: ReturnType<typeof vi.fn>
}

function stepHarness(
  channel: StepChannel,
  display: {
    showReasoning?: () => boolean
    showToolCalls?: () => boolean
    showToolArgs?: () => boolean
    showToolResults?: () => boolean
  } = {},
  extra: {
    noteDetachedJob?: (notice: any) => void
    /** Card media hydrator the streaming side prepares cards with. */
    hydrateImages?: (card: any, scope: any, options?: any) => Promise<any>
    /** Card media warmer the streaming side fires at the text being streamed. */
    warmImages?: (card: any, scope: any) => void
  } = {},
) {
  const listeners: Array<(session: any, event: any) => void> = []
  const bridge = {
    resolveChat: () => ({ chatId: 'oc_1', chatType: 'p2p' }),
    getSessionMeta: async () => ({ contextWindow: 4096, lastInputTokens: 12 }),
    markIntermediateSent: vi.fn(),
    clearIntermediateSent: vi.fn(),
  }
  const streaming = startFeishuStreaming({
    ctx: { on: (_name: string, handler: any) => { listeners.push(handler); return () => undefined } } as any,
    channel: channel as any,
    bridgeHolder: { current: bridge as any },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getTranslations: () => t,
    ...display,
    ...extra,
  })
  const emit = (type: string, data?: any): void => {
    for (const handler of listeners) handler({ id: 's-1' }, { type, time: Date.now(), data })
  }
  return { streaming, emit, bridge }
}

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('step card delivery', () => {
  it('uses a CardKit card instance for send and update when the channel offers it', async () => {
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
      updateCardInstance: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    emit('turn/start')
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'hello' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(200)
    expect(channel.createCardInstance).toHaveBeenCalledOnce()
    expect(channel.sendCardByReference).toHaveBeenCalledWith('oc_1', 'card-1', {})
    expect(channel.send).not.toHaveBeenCalled()

    // A tool call re-renders the SAME card instance with a bumped sequence.
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    await tick(200)
    expect(channel.updateCardInstance).toHaveBeenCalled()
    expect(channel.updateCard).not.toHaveBeenCalled()
    expect(channel.updateCardInstance!.mock.calls.at(-1)![2]).toBe(1)
    streaming.stop()
  })

  it('falls back to a plain send when the card instance has no usable id', async () => {
    // Feishu answers `card.create` for unacceptable content with code=200570 and
    // an EMPTY card_id instead of throwing. Referencing that id fails with
    // `cardid is invalid` and used to leave the step card unposted.
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => ''),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
      updateCardInstance: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    emit('step/start', { turn: 1, step: 1 })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'hello' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(200)
    expect(channel.sendCardByReference).not.toHaveBeenCalled()
    expect(channel.send).toHaveBeenCalledOnce()
    streaming.stop()
  })

  it('falls back to send + im.v1.message.patch when the channel has no CardKit methods', async () => {
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    emit('turn/start')
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'hello' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(200)
    expect(channel.send).toHaveBeenCalledOnce()

    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    await tick(200)
    expect(channel.updateCard).toHaveBeenCalledWith('m-plain', expect.anything())
    streaming.stop()
  })

  it('updates the existing card when assistant/message arrives after a tool call', async () => {
    // A tool call can open the step card before the assembled message lands.
    // Sending a SECOND card there stranded the first one with a tool stuck on
    // "running…", because only the newest ref kept receiving results.
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
      updateCardInstance: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    await tick(200)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)

    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'thinking' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(200)
    // Still exactly one card — the message updated it instead of posting another.
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    expect(channel.updateCardInstance).toHaveBeenCalled()
    streaming.stop()
  })

  it('coalesces a fast step into a single card (no send + update pair)', async () => {
    // Fast model: reasoning → tool/call → tool/result all land inside the
    // coalescing window. The step must post ONE card carrying the final
    // state, not a card plus a follow-up update.
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
      updateCardInstance: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    emit('turn/start')
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'thinking' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    emit('tool/result', { message: { toolCallId: 'c1', source: { callId: 'c1' }, content: [{ type: 'text', text: 'out.txt' }] } })
    await tick(250)
    expect(channel.createCardInstance).toHaveBeenCalledOnce()
    expect(channel.sendCardByReference).toHaveBeenCalledOnce()
    // The single card already carries the tool result.
    expect(mdOf(channel.createCardInstance!.mock.calls[0]![0])).toContain('out.txt')
    expect(channel.updateCardInstance).not.toHaveBeenCalled()
    streaming.stop()
  })

  it('reads a failed tool result from the flattened message', async () => {
    // DSH 0.1.7 flattens the result onto the message
    // (`{ role: 'tool', toolCallId, content, isError }`). Reading the removed
    // nested `tool-result` block yielded no content and no error flag, so every
    // failure was silently rendered as a success.
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
      updateCardInstance: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"false"}' })
    emit('tool/result', {
      message: { toolCallId: 'c1', source: { callId: 'c1' }, isError: true, content: [{ type: 'text', text: 'boom' }] },
    })
    await tick(250)
    const markdown = mdOf(channel.createCardInstance!.mock.calls[0]![0])
    expect(markdown).toContain('boom')
    expect(markdown).toContain('❌')
    expect(markdown).not.toContain('✅')
    streaming.stop()
  })

  it('waits for the card message to be sent before an update', async () => {
    // Feishu snapshots the card entity when the referencing message is created:
    // an update issued BEFORE the send is dropped and the message keeps showing
    // the create-time content (reasoning-only card, or a tool stuck on
    // "running…"). Every instance update must be serialized behind the send.
    let resolveSend!: (value: { messageId: string }) => void
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(() => new Promise<{ messageId: string }>((resolve) => { resolveSend = resolve })),
      updateCardInstance: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    // Let the coalescing window elapse so the card is created and the send is
    // in flight — then the result arrives and schedules an update.
    await tick(200)
    expect(channel.sendCardByReference).toHaveBeenCalledOnce()
    emit('tool/result', { message: { toolCallId: 'c1', source: { callId: 'c1' }, content: [{ type: 'text', text: 'out.txt' }] } })
    await tick(250)
    expect(channel.updateCardInstance).not.toHaveBeenCalled()

    resolveSend({ messageId: 'm-ref' })
    await tick(0)
    expect(channel.updateCardInstance).toHaveBeenCalledOnce()
    expect(channel.updateCardInstance!.mock.calls[0]![0]).toBe('card-1')
    expect(channel.updateCardInstance!.mock.calls[0]![2]).toBe(1)
    // The deferred update carries the tool result, not the create-time snapshot.
    expect(mdOf(channel.updateCardInstance!.mock.calls[0]![1])).toContain('out.txt')
    streaming.stop()
  })

  it('does not let the next step cancel the previous card\'s pending update', async () => {
    let instances = 0
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => `card-${++instances}`),
      sendCardByReference: vi.fn(async () => ({ messageId: `m-${instances}` })),
      updateCardInstance: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' })
    await tick(200)
    emit('tool/result', { message: { toolCallId: 'c1', source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } })
    // Next step starts (and schedules its own update) BEFORE the previous
    // step's 150ms debounce has fired.
    emit('step/start')
    emit('tool/call', { callId: 'c2', name: 'read', arguments: '{}' })
    await tick(200)
    emit('tool/result', { message: { toolCallId: 'c2', source: { callId: 'c2' }, content: [{ type: 'text', text: 'ok' }] } })
    await tick(250)
    // Both step cards were updated — neither debounce cancelled the other.
    const cardIds = channel.updateCardInstance!.mock.calls.map(call => call[0])
    expect(new Set(cardIds).size).toBe(2)
    streaming.stop()
  })
})

// ---------------------------------------------------------------------------
// Chat ordering: step cards must precede the cards that logically follow them
// ---------------------------------------------------------------------------

describe('step card chat ordering', () => {
  it('flushes a debounced step card before another card is posted (barrier)', async () => {
    // The step's first card sits in the 150ms coalescing window. A question
    // card raised by the step's own tool call used to be posted first because
    // the channel had no way to flush the pending step card.
    let flush: ((chatId: string) => Promise<void>) | undefined
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
      updateCardInstance: vi.fn(async () => undefined),
      registerPendingCardFlush: vi.fn((fn: (chatId: string) => Promise<void>) => { flush = fn }),
    }
    const { streaming, emit } = stepHarness(channel)
    expect(channel.registerPendingCardFlush).toHaveBeenCalledOnce()
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'ask_user_question', arguments: '{}' })
    // Still inside the coalescing window: no card yet.
    expect(channel.sendCardByReference).not.toHaveBeenCalled()
    await flush!('oc_1')
    // The barrier posted the step card and waited for its message.
    expect(channel.sendCardByReference).toHaveBeenCalledOnce()
    streaming.stop()
  })

  it('serializes step-card messages per chat so a fast next step cannot overtake', async () => {
    let instances = 0
    let resolveFirst!: (value: { messageId: string }) => void
    const sends: string[] = []
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => `card-${++instances}`),
      sendCardByReference: vi.fn((_to: string, cardId: string) => {
        sends.push(cardId)
        if (cardId === 'card-1') return new Promise<{ messageId: string }>((resolve) => { resolveFirst = resolve })
        return Promise.resolve({ messageId: 'm-2' })
      }),
      updateCardInstance: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' })
    await tick(200)
    expect(sends).toEqual(['card-1'])
    // Next step opens its card while card-1's message is still in flight.
    emit('step/start')
    emit('tool/call', { callId: 'c2', name: 'bash', arguments: '{}' })
    await tick(200)
    // card-2's instance is created, but its message must wait for card-1.
    expect(channel.createCardInstance).toHaveBeenCalledTimes(2)
    expect(sends).toEqual(['card-1'])
    resolveFirst({ messageId: 'm-1' })
    await tick(0)
    expect(sends).toEqual(['card-1', 'card-2'])
    streaming.stop()
  })

  it('posts overflow continuation cards only after the last step card message exists', async () => {
    const sent: any[] = []
    let resolveSend!: (value: { messageId: string }) => void
    const channel: StepChannel = {
      send: vi.fn(async (_to: string, input: any) => { sent.push(input.card); return { messageId: 'm-plain' } }),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(() => new Promise<{ messageId: string }>((resolve) => { resolveSend = resolve })),
      updateCardInstance: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    const startedAt = Date.now() - 500
    emit('turn/start')
    emit('assistant/message', {
      usage: { inputTokens: 10, outputTokens: 100 },
      stream: [{ type: 'text-chunks', time0: startedAt, index: 0, dt: [], texts: ['a'.repeat(7000)] }],
    })
    await tick(200)
    expect(channel.sendCardByReference).toHaveBeenCalledOnce()
    emit('turn/end')
    await tick(50)
    // The step card's message is still being created — no overflow yet.
    expect(sent).toHaveLength(0)
    resolveSend({ messageId: 'm-1' })
    await tick(50)
    expect(sent.length).toBeGreaterThan(0)
    streaming.stop()
  })
})

describe('turn stats token speed', () => {
  const channel: StepChannel = {
    send: vi.fn(async () => ({ messageId: 'm-plain' })),
    updateCard: vi.fn(async () => undefined),
  }

  it('anchors a tool-call-only step and pairs its tokens with its decode time', async () => {
    // No text and no reasoning: without anchoring on the first tool-call delta
    // the step's output tokens were counted while its decode time was not,
    // which inflated the reported tok/s (observed up to 2x on real turns).
    const { streaming, emit } = stepHarness({ ...channel })
    const startedAt = Date.now() - 500
    emit('turn/start')
    emit('assistant/message', {
      usage: { inputTokens: 10, outputTokens: 100 },
      stream: [{ type: 'tool-call-chunks', time0: startedAt, index: 0, dt: [], id: 'c1', name: 'bash', args: ['{"command":"ls"}'] }],
    })
    emit('turn/end')
    const stats = await streaming.flushed('s-1')
    expect(stats?.totalOutputTokens).toBe(100)
    expect(stats?.totalDecodeTokens).toBe(100)
    expect(stats?.totalDecodeMs).toBeGreaterThan(0)
    streaming.stop()
  })

  it('does not count output tokens that have no recorded decode time', async () => {
    const { streaming, emit } = stepHarness({ ...channel })
    emit('turn/start')
    // No token deltas at all → no first-token anchor, no decode time.
    emit('assistant/message', { usage: { inputTokens: 10, outputTokens: 100 }, stream: [] })
    emit('turn/end')
    const stats = await streaming.flushed('s-1')
    expect(stats?.totalOutputTokens).toBe(100)
    expect(stats?.totalDecodeTokens).toBe(0)
    expect(stats?.totalDecodeMs).toBe(0)
    streaming.stop()
  })

  it('puts the step tok/s on every overflow continuation card too', async () => {
    const sent: any[] = []
    const { streaming, emit } = stepHarness({
      send: vi.fn(async (_to: string, input: any) => { sent.push(input.card); return { messageId: 'm' } }),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-1' })),
      updateCardInstance: vi.fn(async () => undefined),
    })
    const startedAt = Date.now() - 500
    emit('turn/start')
    emit('assistant/message', {
      usage: { inputTokens: 10, outputTokens: 100 },
      stream: [{ type: 'text-chunks', time0: startedAt, index: 0, dt: [], texts: ['a'.repeat(7000)] }],
    })
    await tick(200)
    emit('turn/end')
    await tick(50)
    expect(sent.length).toBeGreaterThan(0)
    for (const card of sent) expect(mdOf(card)).toContain('tok/s')
    streaming.stop()
  })

  it('labels a step card with its turn/step position and reasoning time', async () => {
    const cards: any[] = []
    const { streaming, emit } = stepHarness({
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async (card: any) => { cards.push(card); return 'card-1' }),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-1' })),
      updateCardInstance: vi.fn(async () => undefined),
    })
    const startedAt = Date.now() - 5000
    emit('turn/start')
    emit('step/start', { turn: 2, step: 3 })
    emit('assistant/message', {
      usage: { inputTokens: 10, outputTokens: 100, reasoningTokens: 42 },
      stream: [{ type: 'reasoning-chunks', time0: startedAt, index: 0, dt: [1000], texts: ['think ', 'more'] }],
    })
    await tick(200)
    expect(cards.length).toBeGreaterThan(0)
    expect(cards[0].header.title.content).toContain('第 2 轮 · 第 3 步')
    expect(mdOf(cards[0])).toContain('1.0s · 42 tokens')
    streaming.stop()
  })
})

describe('display toggles', () => {
  function cardKitChannel() {
    const cards: any[] = []
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async (card: any) => { cards.push(card); return 'card-1' }),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-1' })),
      updateCardInstance: vi.fn(async () => undefined),
    }
    return { channel, cards }
  }

  it('posts no card for a tool-only step while tool calls are hidden', async () => {
    const { channel, cards } = cardKitChannel()
    const { streaming, emit } = stepHarness(channel, { showToolCalls: () => false })
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    emit('tool/result', {
      message: { toolCallId: 'c1', source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] },
    })
    await tick(250)
    expect(cards).toHaveLength(0)
    expect(channel.send).not.toHaveBeenCalled()
    streaming.stop()
  })

  it('still renders a step that has text, but with no tool trace', async () => {
    const { channel, cards } = cardKitChannel()
    const { streaming, emit } = stepHarness(channel, { showToolCalls: () => false })
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'done' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(250)
    expect(cards).toHaveLength(1)
    expect(mdOf(cards[0])).toContain('done')
    expect(mdOf(cards[0])).not.toContain('bash')
    streaming.stop()
  })

  it('hides reasoning while keeping the step text', async () => {
    const { channel, cards } = cardKitChannel()
    const { streaming, emit } = stepHarness(channel, { showReasoning: () => false })
    emit('turn/start')
    emit('assistant/chunk', { chunk: { type: 'reasoning-delta', text: 'secret-thought' } })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'answer' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(250)
    expect(cards).toHaveLength(1)
    expect(mdOf(cards[0])).not.toContain('secret-thought')
    expect(mdOf(cards[0])).toContain('answer')
    streaming.stop()
  })
})

describe('turn deliverables (DSH present tool)', () => {
  const channel: StepChannel = {
    send: vi.fn(async () => ({ messageId: 'm-plain' })),
    updateCard: vi.fn(async () => undefined),
  }

  it('collects declared deliverables for the Turn Complete card', async () => {
    const { streaming, emit } = stepHarness({ ...channel })
    emit('turn/start')
    emit('deliverables/presented', { turn: 1, callId: 'p1', files: [{ path: 'out/a.txt', description: ' first ' }, { path: 'out/b.png' }] })
    emit('turn/end')
    const stats = await streaming.flushed('s-1')
    expect(stats?.deliverables).toEqual([
      { path: 'out/a.txt', description: 'first' },
      { path: 'out/b.png' },
    ])
    streaming.stop()
  })

  it('keeps the latest description when a path is declared twice', async () => {
    const { streaming, emit } = stepHarness({ ...channel })
    emit('turn/start')
    emit('deliverables/presented', { turn: 1, callId: 'p1', files: [{ path: 'out/a.txt', description: 'draft' }] })
    emit('deliverables/presented', { turn: 1, callId: 'p2', files: [{ path: 'out/a.txt', description: 'final' }] })
    emit('turn/end')
    const stats = await streaming.flushed('s-1')
    expect(stats?.deliverables).toEqual([{ path: 'out/a.txt', description: 'final' }])
    streaming.stop()
  })

  it('ignores malformed payloads and starts each turn clean', async () => {
    const { streaming, emit } = stepHarness({ ...channel })
    emit('turn/start')
    emit('deliverables/presented', { turn: 1, callId: 'p1', files: [{ description: 'no path' }, { path: '' }, null] })
    emit('deliverables/presented', { turn: 1, callId: 'p2', files: 'nope' })
    emit('turn/end')
    expect((await streaming.flushed('s-1'))?.deliverables).toEqual([])

    emit('turn/start')
    emit('turn/end')
    expect((await streaming.flushed('s-1'))?.deliverables).toEqual([])
    streaming.stop()
  })
})

describe('intermediate-sent note (the duplicate-reply guard channel.ts reads)', () => {
  const plainChannel = (): StepChannel => ({
    send: vi.fn(async () => ({ messageId: 'm-plain' })),
    updateCard: vi.fn(async () => undefined),
  })

  it('notes the session when the step text reaches an already-posted card', async () => {
    const channel = plainChannel()
    const { emit, bridge } = stepHarness(channel)
    emit('turn/start')
    // A tool call opens the card while the step still has no text: the tool
    // runs for seconds, so the card is posted bare.
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    await tick(200)
    expect(bridge.markIntermediateSent).not.toHaveBeenCalled()

    // The step's text arrives afterwards and only reaches the screen through
    // an update. channel.ts must still treat the text as already shown,
    // otherwise it posts a second card with the same text.
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    emit('request/context', { contextWindow: 8192 })
    await tick(200)

    const card = (channel.updateCard as any).mock.calls.at(-1)?.[1]
    expect(mdOf(card)).toContain('the answer')
    expect(bridge.markIntermediateSent).toHaveBeenCalledWith('s-1')
  })

  it('still notes the session when the card is posted with the text already present', async () => {
    const channel = plainChannel()
    const { emit, bridge } = stepHarness(channel)
    emit('turn/start')
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'hi' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(200)
    expect(bridge.markIntermediateSent).toHaveBeenCalledWith('s-1')
  })

  it('does not note the session while the card carries no text', async () => {
    const channel = plainChannel()
    const { emit, bridge } = stepHarness(channel)
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    await tick(200)
    emit('request/context', { contextWindow: 8192 })
    await tick(200)
    // The update ran, but nothing textual was on the card to report.
    expect(channel.updateCard).toHaveBeenCalled()
    expect(bridge.markIntermediateSent).not.toHaveBeenCalled()
  })

  it('withdraws the note when the card carrying the text never reached Feishu', async () => {
    // The send resolves WITHOUT a message id, i.e. Feishu never created the
    // card's message. The answer is therefore NOT on screen and channel.ts has
    // to post it itself — the failure that used to swallow whole replies
    // (2026-09-21, key pitfall 29).
    const channel: StepChannel = {
      send: vi.fn(async () => ({})),
      updateCard: vi.fn(async () => undefined),
    }
    const { streaming, emit, bridge } = stepHarness(channel)
    emit('turn/start')
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(200)
    expect(bridge.markIntermediateSent).toHaveBeenCalledWith('s-1')

    emit('turn/end')
    await streaming.flushed('s-1')
    expect(bridge.clearIntermediateSent).toHaveBeenCalledWith('s-1')
    streaming.stop()
  })

  it('keeps the note when the card really was delivered', async () => {
    const channel = plainChannel()
    const { streaming, emit, bridge } = stepHarness(channel)
    emit('turn/start')
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(200)
    emit('turn/end')
    await streaming.flushed('s-1')
    expect(bridge.markIntermediateSent).toHaveBeenCalledWith('s-1')
    expect(bridge.clearIntermediateSent).not.toHaveBeenCalled()
    streaming.stop()
  })

  it('waits for a text-carrying write that is still in flight instead of withdrawing the note', async () => {
    // Media hydration makes one card write take seconds (a video upload). The
    // debounce entry is already gone when turn/end arrives, so `flushed()` used
    // to read `turnTextDelivered === false` while the write was still on its
    // way: it withdrew the note and channel.ts posted a full reply card next to
    // the step card that then received the same text — the duplicate reply
    // reported on 2026-09-24.
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async (_messageId: string, card: any) => {
        // Only the write carrying the answer is slow, like a hydrated card.
        if (mdOf(card).includes('the answer')) await gate
      }),
    }
    const { streaming, emit, bridge } = stepHarness(channel)
    emit('turn/start')
    // A tool call opens the card bare; the answer only arrives later, so it can
    // only reach the screen through an update.
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    await tick(200)
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    // Let the 150ms debounce fire: the write is now in flight and gated.
    await tick(250)
    expect(bridge.markIntermediateSent).toHaveBeenCalledWith('s-1')

    emit('turn/end')
    let flushed = false
    const done = streaming.flushed('s-1').then(() => { flushed = true })
    await tick(50)
    expect(flushed).toBe(false)

    release()
    await done
    expect(bridge.clearIntermediateSent).not.toHaveBeenCalled()
    streaming.stop()
  })

  it('does not carry the delivery note over into the next turn', async () => {
    // Turn 1 delivers, turn 2's card never leaves: the stale mark from turn 1
    // must not make channel.ts skip turn 2's reply.
    const channel: StepChannel = {
      send: vi.fn()
        .mockResolvedValueOnce({ messageId: 'm-1' })
        .mockResolvedValueOnce({}),
      updateCard: vi.fn(async () => undefined),
    }
    const { streaming, emit, bridge } = stepHarness(channel)
    emit('turn/start')
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'first' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(200)
    emit('turn/end')
    await streaming.flushed('s-1')
    expect(bridge.clearIntermediateSent).not.toHaveBeenCalled()

    emit('turn/start')
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'second' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(200)
    emit('turn/end')
    await streaming.flushed('s-1')
    expect(bridge.clearIntermediateSent).toHaveBeenCalledWith('s-1')
    streaming.stop()
  })
})

describe('a stuck card send must not wedge the chat', () => {
  const neverSettles = new Promise<{ messageId?: string }>(() => { /* never */ })

  it('gives up on a predecessor that never settles and still posts the next card', async () => {
    vi.useFakeTimers()
    try {
      let instances = 0
      const channel: StepChannel = {
        send: vi.fn(async () => ({ messageId: 'm-plain' })),
        updateCard: vi.fn(async () => undefined),
        createCardInstance: vi.fn(async () => `card-${++instances}`),
        sendCardByReference: vi.fn()
          .mockReturnValueOnce(neverSettles)
          .mockResolvedValue({ messageId: 'm-2' }),
        updateCardInstance: vi.fn(async () => undefined),
      }
      const { streaming, emit } = stepHarness(channel)
      emit('turn/start')
      emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'first' } })
      emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
      await vi.advanceTimersByTimeAsync(200)
      expect(channel.sendCardByReference).toHaveBeenCalledTimes(1)

      // Second step: its instance is created, but its message waits for the
      // first card's message — which never arrives.
      emit('step/start')
      emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'second' } })
      emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
      await vi.advanceTimersByTimeAsync(300)
      expect(channel.sendCardByReference).toHaveBeenCalledTimes(1)

      // The wait is bounded, so the second card is posted rather than being
      // stranded like the first (the 2026-09-21 outage: 8 orphaned instances).
      await vi.advanceTimersByTimeAsync(60_000)
      expect(channel.sendCardByReference).toHaveBeenCalledTimes(2)
      streaming.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Thinking placeholder (O1): the step card opens at `step/start`, before the
// model has produced anything, and every later stage updates that same card.
// ---------------------------------------------------------------------------

describe('background-job turn trigger', () => {
  const plainChannel = (): StepChannel => ({
    send: vi.fn(async () => ({ messageId: 'm-1' })),
    updateCard: vi.fn(async () => undefined),
  })

  /** The notice DSH injects when a background job settles (source.kind tool-jobs). */
  const jobNotice = (): { content: Array<{ type: string; text: string }>; source: { kind: string; form: string } } => ({
    content: [{ type: 'text', text: 'background job bash-1 completed' }],
    source: { kind: 'tool-jobs', form: 'notice' },
  })

  const humanMessage = (): { content: Array<{ type: string; text: string }>; source: { kind: string } } => ({
    content: [{ type: 'text', text: '你好' }],
    source: { kind: 'user' },
  })

  /** The newest card rendered for this step: the last update, else the last send. */
  const lastCard = (channel: StepChannel): any => {
    const updates = (channel.updateCard as any).mock.calls
    if (updates.length > 0) return updates.at(-1)![1]
    return (channel.send as any).mock.calls.at(-1)![1].card
  }

  it('repaints the placeholder with the mark when a notice opened the turn', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('turn/start', { turn: 5 })
    h.emit('step/start', { turn: 5, step: 1 })
    // `step/start` precedes the message that opened the turn, so wait for the
    // placeholder to be on screen first (the real ordering is milliseconds
    // later; a notice landing inside the send window is absorbed by the send).
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    expect(mdOf(lastCard(channel))).not.toContain(t.stepJobTriggerNote)

    h.emit('user/message', jobNotice())
    await vi.waitFor(() => { expect(mdOf(lastCard(channel))).toContain(t.stepJobTriggerNote) })
    // One card per step: the placeholder was updated, never re-posted.
    expect(channel.send).toHaveBeenCalledTimes(1)
    h.streaming.stop()
  })

  it('marks a step whose card opens after the notice landed', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('turn/start', { turn: 6 })
    // Notice arrives inside the 150ms send window: the first card is built at
    // flush time and must already carry the mark.
    h.emit('step/start', { turn: 6, step: 1 })
    h.emit('user/message', jobNotice())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '干活' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    expect(mdOf(lastCard(channel))).toContain(t.stepJobTriggerNote)
    expect(mdOf(lastCard(channel))).toContain('干活')
    h.streaming.stop()
  })

  it('leaves a human-opened turn unmarked', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('turn/start', { turn: 1 })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('user/message', humanMessage())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '你好' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    expect(mdOf(lastCard(channel))).not.toContain(t.stepJobTriggerNote)
    h.streaming.stop()
  })

  it('does not attribute a notice injected into an already-running turn', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('turn/start', { turn: 1 })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('user/message', humanMessage())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '第一步' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    expect(mdOf(lastCard(channel))).not.toContain(t.stepJobTriggerNote)

    // Step 2 of the same turn claims the notice: the human still owns the turn.
    h.emit('step/start', { turn: 1, step: 2 })
    h.emit('user/message', jobNotice())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '继续' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(2) })
    expect(mdOf(lastCard(channel))).not.toContain(t.stepJobTriggerNote)
    h.streaming.stop()
  })

  it('keeps the mark on every step of that turn and drops it on the next turn', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('turn/start', { turn: 7 })
    h.emit('step/start', { turn: 7, step: 1 })
    h.emit('user/message', jobNotice())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'a' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    expect(mdOf(lastCard(channel))).toContain(t.stepJobTriggerNote)

    // Step 2 of the same turn: the attribution is turn-level, so it repeats.
    h.emit('step/start', { turn: 7, step: 2 })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'b' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(2) })
    expect(mdOf(lastCard(channel))).toContain(t.stepJobTriggerNote)

    // The next turn belongs to its own trigger.
    h.emit('turn/end', { turn: 7, reason: { kind: 'completed' } })
    h.emit('turn/start', { turn: 8 })
    h.emit('step/start', { turn: 8, step: 1 })
    h.emit('user/message', humanMessage())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'c' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(3) })
    expect(mdOf(lastCard(channel))).not.toContain(t.stepJobTriggerNote)
    h.streaming.stop()
  })
})

describe('thinking placeholder', () => {
  const plainChannel = (): StepChannel => ({
    send: vi.fn(async () => ({ messageId: 'm-1' })),
    updateCard: vi.fn(async () => undefined),
  })

  it('opens a thinking card the moment the step starts', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('step/start', { turn: 2, step: 3 })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    const card = channel.send.mock.calls[0]![1].card as any
    expect(card.header.title.content).toBe(`${t.stepPlaceholderTitle} · ${t.stepPosition(2, 3)}`)
    expect(mdOf(card)).toContain(t.stepPlaceholderBody)
    h.streaming.stop()
  })

  it('turns that same card into the step card when the message lands', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '你好' } })
    h.emit('assistant/message', {
      usage: { inputTokens: 5, outputTokens: 2 },
    })
    await vi.waitFor(() => { expect(channel.updateCard).toHaveBeenCalled() })
    const card = channel.updateCard.mock.calls.at(-1)![1] as any
    // One card per step: the placeholder was updated, never re-posted.
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(card.header.title.content).toBe(`${t.stepCardTitleReply} · ${t.stepPosition(1, 1)}`)
    expect(mdOf(card)).toContain('你好')
    expect(mdOf(card)).not.toContain(t.stepPlaceholderBody)
    h.streaming.stop()
  })

  it('folds a step that ends with nothing to show instead of leaving it thinking', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('step/start', { turn: 1, step: 2 })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    h.emit('step/end', { turn: 1, step: 2 })
    await vi.waitFor(() => { expect(channel.updateCard).toHaveBeenCalled() })
    const card = channel.updateCard.mock.calls.at(-1)![1] as any
    expect(card.header.title.content).toBe(`${t.stepEmptyTitle} · ${t.stepPosition(1, 2)}`)
    expect(mdOf(card)).toContain(t.stepEmptyBody)
    h.streaming.stop()
  })

  it('refreshes the placeholder while the model is still thinking', async () => {
    vi.useFakeTimers()
    try {
      const channel = plainChannel()
      const h = stepHarness(channel)
      h.emit('step/start', { turn: 1, step: 1 })
      await vi.advanceTimersByTimeAsync(200)
      expect(channel.send).toHaveBeenCalledTimes(1)
      // No output yet → the tick keeps the elapsed time (and liveness) honest.
      await vi.advanceTimersByTimeAsync(5_200)
      expect(channel.updateCard.mock.calls.length).toBeGreaterThanOrEqual(1)
      const card = channel.updateCard.mock.calls.at(-1)![1] as any
      expect(card.header.title.content).toContain(t.stepPlaceholderTitle)
      h.streaming.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards every tool result to the background-job mirror', () => {
    const noteDetachedJob = vi.fn()
    const channel = plainChannel()
    const h = stepHarness(channel, {}, { noteDetachedJob })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"x","run_in_background":true}' })
    h.emit('tool/result', {
      message: { toolCallId: 'c1', content: [{ type: 'text', text: 'started background job bash-9' }], isError: false },
    })
    expect(noteDetachedJob).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'bash',
      resultText: 'started background job bash-9',
      sessionId: 's-1',
    }))
    h.streaming.stop()
  })
})

// ---------------------------------------------------------------------------
// Stale step card: a card whose updates all failed keeps rendering old content
// and used to be visible only as a journal line ([update] failed).
// ---------------------------------------------------------------------------

describe('stale step card notice', () => {
  const instanceChannel = (updateCardInstance: ReturnType<typeof vi.fn>): StepChannel => ({
    send: vi.fn(async () => ({ messageId: 'm-plain' })),
    updateCard: vi.fn(async () => undefined),
    createCardInstance: vi.fn(async () => 'card-1'),
    sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
    updateCardInstance,
  })

  /** Position of the step card every test in this block opens. */
  const TURN = 3
  const STEP = 2

  it('reports a card whose writes keep failing, once, as plain text', async () => {
    vi.useFakeTimers()
    try {
      // A wrapper error: the useful sentence is in the cause chain, and the
      // notice must carry it to the chat (see error-text.ts).
      const failure = new Error('Request failed with status code 400', {
        cause: new Error('card contains invalid image keys'),
      })
      const channel = instanceChannel(vi.fn(async () => { throw failure }))
      const h = stepHarness(channel)
      h.emit('step/start', { turn: TURN, step: STEP })
      await vi.advanceTimersByTimeAsync(200)
      expect(channel.sendCardByReference).toHaveBeenCalledOnce()

      // Two separate failed updates: the notice is still posted only once.
      h.emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
      await vi.advanceTimersByTimeAsync(200)
      h.emit('tool/call', { callId: 'c2', name: 'bash', arguments: '{"command":"pwd"}' })
      await vi.advanceTimersByTimeAsync(200)
      // Nothing yet: a failure the next write repairs must stay silent.
      expect(channel.send).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_200)
      expect(channel.send).toHaveBeenCalledTimes(1)
      const notice = channel.send.mock.calls[0]![1] as any
      // Text, not a card: the report is "this card could not be written".
      expect(notice.card).toBeUndefined()
      expect(notice.text).toBe(t.stepCardStaleNotice(
        TURN, STEP, 'Request failed with status code 400 ← card contains invalid image keys',
      ))
      expect(notice.text).toContain('card contains invalid image keys')
      h.streaming.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays silent when a later write repairs the card', async () => {
    vi.useFakeTimers()
    try {
      const channel = instanceChannel(
        vi.fn().mockRejectedValueOnce(new Error('read ECONNRESET')).mockResolvedValue(undefined),
      )
      const h = stepHarness(channel)
      h.emit('step/start', { turn: TURN, step: STEP })
      await vi.advanceTimersByTimeAsync(200)

      h.emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
      await vi.advanceTimersByTimeAsync(200)
      expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
      // Second update lands → the card is up to date again.
      h.emit('tool/call', { callId: 'c2', name: 'bash', arguments: '{"command":"pwd"}' })
      await vi.advanceTimersByTimeAsync(2_500)
      expect(channel.updateCardInstance).toHaveBeenCalledTimes(2)
      expect(channel.send).not.toHaveBeenCalled()
      h.streaming.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never posts the notice after the plugin was disposed', async () => {
    vi.useFakeTimers()
    try {
      const channel = instanceChannel(vi.fn(async () => { throw new Error('boom') }))
      const h = stepHarness(channel)
      h.emit('step/start', { turn: TURN, step: STEP })
      await vi.advanceTimersByTimeAsync(200)
      h.emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
      await vi.advanceTimersByTimeAsync(200)
      // Failure recorded, confirmation timer armed → dispose cancels it.
      h.streaming.stop()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(channel.send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('card media hydration hooks', () => {
  const plainChannel = (): StepChannel => ({
    send: vi.fn(async () => ({ messageId: 'm-plain' })),
    updateCard: vi.fn(async () => undefined),
  })

  it('warms the media cache from the streaming text, without touching the card', async () => {
    const warmImages = vi.fn()
    const channel = plainChannel()
    const { streaming, emit } = stepHarness(channel, {}, { warmImages })
    emit('turn/start')
    // Plain prose never triggers a warm-up: only `[](...)` destinations can be
    // resolved, and this runs on every token delta.
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: '正在生成，稍等' } })
    await tick(600)
    expect(warmImages).not.toHaveBeenCalled()

    emit('assistant/chunk', { chunk: { type: 'text-delta', text: '看这里 [片段](runs/a.mp4)' } })
    await tick(600)
    expect(warmImages).toHaveBeenCalledTimes(1)
    const [card, scope] = warmImages.mock.calls[0]! as unknown as [any, any]
    expect(JSON.stringify(card)).toContain('runs/a.mp4')
    expect(scope).toEqual({ sessionId: 's-1' })
    // Warming is not a card write: no send may happen just because of it.
    expect(channel.send).not.toHaveBeenCalled()
    streaming.stop()
  })

  it('hydrates the overflow "continued" cards too, not just the step card', async () => {
    // Media referenced past TEXT_STEP_CAP live on the overflow cards; those used
    // to be handed to the raw channel, so their clips never rendered.
    const hydrateImages = vi.fn(async (card: any) => ({
      ...card,
      body: { elements: [...card.body.elements, { tag: 'markdown', content: 'HYDRATED' }] },
    }))
    const channel = plainChannel()
    const { streaming, emit } = stepHarness(channel, {}, { hydrateImages })
    emit('turn/start')
    emit('assistant/chunk', {
      chunk: { type: 'text-delta', text: `${'x'.repeat(3_500)}\n\n[尾](runs/tail.mp4)` },
    })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(300)
    emit('turn/end', {})
    await tick(500)

    const cards = channel.send.mock.calls.map((call: any[]) => call[1].card)
    const overflow = cards.filter((card: any) => String(card.header?.title?.content).startsWith('Reply (continued'))
    expect(overflow.length).toBeGreaterThan(0)
    expect(JSON.stringify(overflow)).toContain('HYDRATED')
    streaming.stop()
  })
})
