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

  it('unknown tools prefix the tool name with the first string field', () => {
    expect(deriveToolSummary('my_custom_tool', JSON.stringify({ what: 'do the thing' }))).toBe('my_custom_tool · do the thing')
  })

  it('titled tools (e.g. cordis_run) do not prefix the tool name', () => {
    expect(deriveToolSummary('cordis_run', JSON.stringify({ package: 'pkg' }))).toBe('pkg')
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
}

function stepHarness(channel: StepChannel) {
  const listeners: Array<(session: any, event: any) => void> = []
  const bridge = {
    resolveChat: () => ({ chatId: 'oc_1', chatType: 'p2p' }),
    getSessionMeta: async () => ({ contextWindow: 4096, lastInputTokens: 12 }),
    markIntermediateSent: vi.fn(),
  }
  const streaming = startFeishuStreaming({
    ctx: { on: (_name: string, handler: any) => { listeners.push(handler); return () => undefined } } as any,
    channel: channel as any,
    bridgeHolder: { current: bridge as any },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getTranslations: () => t,
  })
  const emit = (type: string, data?: any): void => {
    for (const handler of listeners) handler({ id: 's-1' }, { type, time: Date.now(), data })
  }
  return { streaming, emit }
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
    await tick(0)
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

  it('falls back to send + im.v1.message.patch when the channel has no CardKit methods', async () => {
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
    }
    const { streaming, emit } = stepHarness(channel)
    emit('turn/start')
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'hello' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(0)
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
    await tick(0)
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)

    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'thinking' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(200)
    // Still exactly one card — the message updated it instead of posting another.
    expect(channel.createCardInstance).toHaveBeenCalledTimes(1)
    expect(channel.updateCardInstance).toHaveBeenCalled()
    streaming.stop()
  })

  it('waits for the card message to be sent before the first instance update', async () => {
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
    emit('tool/result', { message: { source: { callId: 'c1' }, content: [{ content: 'out.txt' }] } })
    // The debounce fires while the send is still in flight.
    await tick(250)
    expect(channel.sendCardByReference).toHaveBeenCalledOnce()
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
    await tick(0)
    emit('tool/result', { message: { source: { callId: 'c1' }, content: [{ content: 'ok' }] } })
    // Next step starts (and schedules its own update) BEFORE the previous
    // step's 150ms debounce has fired.
    emit('step/start')
    emit('tool/call', { callId: 'c2', name: 'read', arguments: '{}' })
    await tick(0)
    emit('tool/result', { message: { source: { callId: 'c2' }, content: [{ content: 'ok' }] } })
    await tick(250)
    // Both step cards were updated — neither debounce cancelled the other.
    const cardIds = channel.updateCardInstance!.mock.calls.map(call => call[0])
    expect(new Set(cardIds).size).toBe(2)
    streaming.stop()
  })
})
