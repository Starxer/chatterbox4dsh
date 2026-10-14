import { describe, expect, it, vi } from 'vitest'
import { createCardSendBarrier } from '../src/card-send-barrier.ts'
import { deriveToolSummary, progressToolDetails, renderStepCard, startFeishuStreaming, uncommittedToolNames } from '../src/feishu-streaming.ts'
import { PROGRESS_MAX_DETAILS } from '../src/feishu-progress.ts'
import { translationsFor } from '../src/i18n.ts'
import type { TranscriptView } from '../src/display-level.ts'
import { createCardInterleave, type CardInterleave } from '../src/card-interleave.ts'

const t = translationsFor('zh')
/**
 * The running compact turn progress card, told apart from a step card by its
 * title: `🐳 深度求索中 · 1.2s` while running, `⚙️ 本回合 · …` once settled.
 */
const TURN_RUNNING = t.turnCardTitleRunning('')
const isTurnCardTitle = (title: string): boolean => title.includes(TURN_RUNNING) || title.includes('本回合')

function codeBlocksOf(card: any): string[] {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    // A fenced block now carries a label line before the fence (e.g. "⚙️ 参数"),
    // so match on the fence presence rather than block start.
    .filter((c: string) => c.includes('```'))
}

/**
 * Every markdown string a card renders, at any depth.
 *
 * Depth matters since the reasoning section became a `collapsible_panel`: its
 * header title and its body are markdown, but nested one level down, and a
 * shallow collector would report the card as having no reasoning at all.
 */
function mdOf(card: any): string {
  const out: string[] = []
  const walk = (elements: any[] | undefined): void => {
    for (const el of elements ?? []) {
      if (el.tag === 'markdown' && typeof el.content === 'string') out.push(el.content)
      if (typeof el.header?.title?.content === 'string') out.push(el.header.title.content)
      if (Array.isArray(el.elements)) walk(el.elements)
    }
  }
  walk(card.body.elements)
  return out.join('\n')
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


describe('progressToolDetails', () => {
  // The compact turn card names what a row actually touched: a file for the
  // file tools, the programs for a shell command (2026-10-11).
  it('names the BARE file of a read / write / edit, with no directory', () => {
    // 2026-10-12, the user's call: `…/src/feishu-progress.ts` spent the row's
    // width on a directory; the file is what changed.
    expect(progressToolDetails('read', JSON.stringify({ path: '/w/repo/src/feishu-progress.ts' }))).toEqual(['feishu-progress.ts'])
    expect(progressToolDetails('write', JSON.stringify({ file_path: 'docs/architecture.md' }))).toEqual(['architecture.md'])
    expect(progressToolDetails('edit', JSON.stringify({ path: 'notes/pitfalls.md' }))).toEqual(['pitfalls.md'])
    // A same-named file in another directory reads the same: the row points at a
    // call, it does not identify the file on disk.
    expect(progressToolDetails('edit', JSON.stringify({ path: 'src/client/client.ts' }))).toEqual(['client.ts'])
  })

  it('takes the bare name from a Windows path too', () => {
    expect(progressToolDetails('read', JSON.stringify({ path: 'C:\\w\\repo\\src\\index.ts' }))).toEqual(['index.ts'])
  })

  it('keeps a single-segment path untouched', () => {
    expect(progressToolDetails('read', JSON.stringify({ path: 'README.md' }))).toEqual(['README.md'])
  })

  it('says nothing for a path that names no file', () => {
    expect(progressToolDetails('read', JSON.stringify({ path: 'src/' }))).toBeUndefined()
    expect(progressToolDetails('read', JSON.stringify({ path: '   ' }))).toBeUndefined()
  })

  it('names the programs a bash command runs, in order', () => {
    expect(progressToolDetails('bash', JSON.stringify({ command: 'npm run typecheck 2>&1 | tail -5' }))).toEqual(['npm', 'tail'])
    expect(progressToolDetails('bash', JSON.stringify({ command: 'cd /w && git status --short' }))).toEqual(['git'])
  })

  it('keeps at most three programs', () => {
    expect(progressToolDetails('bash', JSON.stringify({ command: 'a; b; c; d; e' }))).toEqual(['a', 'b', 'c'])
  })

  it('prefers the command over the model description (which the detailed card uses)', () => {
    expect(progressToolDetails('bash', JSON.stringify({ description: '跑测试', command: 'npm test' }))).toEqual(['npm'])
  })

  it('says nothing for a tool whose name is the whole story', () => {
    expect(progressToolDetails('present', JSON.stringify({ files: [{ path: 'a.png' }] }))).toBeUndefined()
    expect(progressToolDetails('todo_write', JSON.stringify({ todos: [] }))).toBeUndefined()
    expect(progressToolDetails('bash', JSON.stringify({ command: '' }))).toBeUndefined()
    expect(progressToolDetails('read', 'not json')).toBeUndefined()
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
  sendStepCard?: ReturnType<typeof vi.fn>
}

function stepHarness(
  channel: StepChannel,
  display: {
    showReasoning?: () => boolean
    showToolCalls?: () => boolean
    showToolArgs?: () => boolean
    showToolResults?: () => boolean
    /** Work-detail level; omitted means the `detailed` default. */
    transcriptView?: () => TranscriptView
  } = {},
  extra: {
    noteDetachedJob?: (notice: any) => void
    /** Card media hydrator the streaming side prepares cards with. */
    hydrateImages?: (card: any, scope: any, options?: any) => Promise<any>
    /** Card media warmer the streaming side fires at the text being streamed. */
    warmImages?: (card: any, scope: any) => void
    /** Registry another module announces its cards through (card-interleave). */
    interleave?: CardInterleave
    /**
     * What `bridge.getSessionMeta` reports — the session's RECORDED route among
     * the rest. Omitted keeps the bare context-window fixture.
     */
    sessionMeta?: () => Record<string, unknown> | Promise<Record<string, unknown>>
    /**
     * Suppress the harness's automatic `turn/start` (see `emit`), so a test can
     * exercise the module's own turn-ownership guard.
     */
    noTurnStart?: boolean
  } = {},
) {
  // Listeners are keyed by EVENT NAME: the streaming module also subscribes to
  // the transient `agent/assistant-stream` publication (O20), whose payload is
  // not `(session, event)` and must not be fed to the session handlers.
  const listeners = new Map<string, Array<(a: any, b?: any) => void>>()
  const on = (name: string, handler: any): (() => void) => {
    const list = listeners.get(name)
    if (list === undefined) listeners.set(name, [handler])
    else list.push(handler)
    return () => {
      const current = listeners.get(name)
      const index = current?.indexOf(handler) ?? -1
      if (current !== undefined && index >= 0) current.splice(index, 1)
    }
  }
  const bridge = {
    resolveChat: () => ({ chatId: 'oc_1', chatType: 'p2p' }),
    getSessionMeta: async () => ({ contextWindow: 4096, lastInputTokens: 12, ...(await extra.sessionMeta?.() ?? {}) }),
    markIntermediateSent: vi.fn(),
    clearIntermediateSent: vi.fn(),
  }
  const streaming = startFeishuStreaming({
    ctx: { on } as any,
    channel: channel as any,
    bridgeHolder: { current: bridge as any },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getTranslations: () => t,
    ...display,
    ...extra,
  })
  /**
   * Turn-scoped events, mirroring the module's own gate: the host always appends
   * `turn/start` before any of them, so the harness opens the turn for the first
   * one it sees. Without that, every card test would be asserting on a turn the
   * module (correctly) refuses to render — the case a re-mounted plugin hits.
   */
  const TURN_SCOPED = new Set([
    'assistant/chunk', 'assistant/message', 'assistant/attempt',
    'tool/call', 'tool/result', 'step/start', 'step/end', 'turn/end',
    'deliverables/presented', 'user/message',
  ])
  let turnOpen = false
  const fire = (type: string, data?: any): void => {
    for (const handler of listeners.get('session/event') ?? []) handler({ id: 's-1' }, { type, time: Date.now(), data })
  }
  const emit = (type: string, data?: any): void => {
    if (type === 'turn/start') turnOpen = true
    else if (!extra.noTurnStart && !turnOpen && TURN_SCOPED.has(type)) {
      turnOpen = true
      fire('turn/start')
    }
    fire(type, data)
    if (type === 'turn/end') turnOpen = false
  }
  /**
   * Publish one transient assistant-stream frame in its real shape: the payload
   * carries the AGENT, which is how the listener learns which session it is for.
   */
  const emitStream = (frame: any, sessionId = 's-1'): void => {
    for (const handler of listeners.get('agent/assistant-stream') ?? []) {
      handler({ agent: { session: { id: sessionId } }, frame })
    }
  }
  return { streaming, emit, emitStream, bridge }
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

/**
 * The PRODUCED half (TODO O3): files a turn wrote with `write`/`edit` without
 * declaring them through `present`. Collection has to pair the call's arguments
 * with the result's success flag — `tool/result` carries no arguments, so a
 * result arriving without its call tells us nothing.
 */
describe('produced files (a turn wrote but never presented)', () => {
  const channel: StepChannel = {
    send: vi.fn(async () => ({ messageId: 'm-plain' })),
    updateCard: vi.fn(async () => undefined),
  }
  const ok = (callId: string) => ({ message: { toolCallId: callId, source: { callId }, content: [{ type: 'text', text: 'ok' }] } })
  const failed = (callId: string) => ({
    message: { toolCallId: callId, source: { callId }, isError: true, content: [{ type: 'text', text: 'boom' }] },
  })
  const writeArgs = (path: string): string => JSON.stringify({ file_path: path, content: 'x' })

  it('records a file whose write succeeded, with its kind', async () => {
    const { streaming, emit } = stepHarness({ ...channel })
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'write', arguments: writeArgs('shots/grid.png') })
    emit('tool/result', ok('c1'))
    emit('turn/end')
    expect((await streaming.flushed('s-1'))?.produced).toEqual([{ path: 'shots/grid.png', kind: 'image' }])
    streaming.stop()
  })

  it('records nothing for a failed write, a read, or a bash redirect', async () => {
    const { streaming, emit } = stepHarness({ ...channel })
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'write', arguments: writeArgs('a.png') })
    emit('tool/result', failed('c1'))
    emit('tool/call', { callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'b.png' }) })
    emit('tool/result', ok('c2'))
    emit('tool/call', { callId: 'c3', name: 'bash', arguments: JSON.stringify({ command: 'echo x > c.png' }) })
    emit('tool/result', ok('c3'))
    emit('turn/end')
    expect((await streaming.flushed('s-1'))?.produced).toEqual([])
    streaming.stop()
  })

  it('keeps every produced file of the turn in order, duplicates included', async () => {
    const { streaming, emit } = stepHarness({ ...channel })
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'write', arguments: writeArgs('a.png') })
    emit('tool/result', ok('c1'))
    emit('tool/call', { callId: 'c2', name: 'edit', arguments: JSON.stringify({ file_path: 'a.png', old_string: 'x', new_string: 'y' }) })
    emit('tool/result', ok('c2'))
    emit('tool/call', { callId: 'c3', name: 'write', arguments: writeArgs('doc.pdf') })
    emit('tool/result', ok('c3'))
    emit('turn/end')
    // Two writes of the same path stay two entries: dedup is the delivery
    // planner's job (it resolves paths), not the collector's.
    expect((await streaming.flushed('s-1'))?.produced).toEqual([
      { path: 'a.png', kind: 'image' },
      { path: 'a.png', kind: 'image' },
      { path: 'doc.pdf', kind: 'document' },
    ])
    streaming.stop()
  })

  it('drops the previous turn\'s produced list', async () => {
    const { streaming, emit } = stepHarness({ ...channel })
    emit('turn/start')
    emit('tool/call', { callId: 'c1', name: 'write', arguments: writeArgs('a.png') })
    emit('tool/result', ok('c1'))
    emit('turn/end')
    expect((await streaming.flushed('s-1'))?.produced).toHaveLength(1)

    emit('turn/start')
    emit('turn/end')
    expect((await streaming.flushed('s-1'))?.produced).toEqual([])
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

  /** A timed reminder / automation waking an idle owner (schedule runtime). */
  const scheduleNotice = (): { content: Array<{ type: string; text: string }>; source: { kind: string } } => ({
    content: [{ type: 'text', text: '自动化任务：检查构建' }],
    source: { kind: 'schedule' },
  })

  /** A subagent settlement notice delivered to its parent. */
  const subagentNotice = (): { content: Array<{ type: string; text: string }>; source: { kind: string } } => ({
    content: [{ type: 'text', text: 'child session finished' }],
    source: { kind: 'subagent-settled' },
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
    expect(mdOf(lastCard(channel))).not.toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('job')))

    h.emit('user/message', jobNotice())
    await vi.waitFor(() => { expect(mdOf(lastCard(channel))).toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('job'))) })
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
    expect(mdOf(lastCard(channel))).toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('job')))
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
    expect(mdOf(lastCard(channel))).not.toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('job')))
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
    expect(mdOf(lastCard(channel))).not.toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('job')))

    // Step 2 of the same turn claims the notice: the human still owns the turn.
    h.emit('step/start', { turn: 1, step: 2 })
    h.emit('user/message', jobNotice())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '继续' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(2) })
    expect(mdOf(lastCard(channel))).not.toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('job')))
    h.streaming.stop()
  })

  it('names the automation that opened the turn, not just "a background job"', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('turn/start', { turn: 9 })
    h.emit('step/start', { turn: 9, step: 1 })
    h.emit('user/message', scheduleNotice())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '开始检查' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    const card = mdOf(lastCard(channel))
    expect(card).toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('schedule')))
    expect(card).not.toContain(t.autoTurnTriggerName('job'))
    h.streaming.stop()
  })

  it('names a subagent settlement, and prefers it over the generic family', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('turn/start', { turn: 10 })
    h.emit('step/start', { turn: 10, step: 1 })
    // A fresh session's first turn claims its instruction injections before the
    // notice that actually woke it: the generic family must lose to the named one.
    h.emit('user/message', { content: [{ type: 'text', text: 'AGENTS.md' }], source: { kind: 'agent-instructions' } })
    h.emit('user/message', subagentNotice())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '汇总' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    const card = mdOf(lastCard(channel))
    expect(card).toContain(t.autoTurnTriggerName('subagent'))
    expect(card).not.toContain(t.autoTurnTriggerName('request'))
    h.streaming.stop()
  })

  it('drops the generic family once a human message claims the turn', async () => {
    const channel = plainChannel()
    const h = stepHarness(channel)
    h.emit('turn/start', { turn: 11 })
    h.emit('step/start', { turn: 11, step: 1 })
    // Instruction injection first (generic), then the human who actually asked:
    // the turn is the human's, so no attribution line may survive.
    h.emit('user/message', { content: [{ type: 'text', text: 'AGENTS.md' }], source: { kind: 'agent-instructions' } })
    h.emit('user/message', humanMessage())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '你好' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(1) })
    expect(mdOf(lastCard(channel))).not.toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('request')))
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
    expect(mdOf(lastCard(channel))).toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('job')))

    // Step 2 of the same turn: the attribution is turn-level, so it repeats.
    h.emit('step/start', { turn: 7, step: 2 })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'b' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(2) })
    expect(mdOf(lastCard(channel))).toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('job')))

    // The next turn belongs to its own trigger.
    h.emit('turn/end', { turn: 7, reason: { kind: 'completed' } })
    h.emit('turn/start', { turn: 8 })
    h.emit('step/start', { turn: 8, step: 1 })
    h.emit('user/message', humanMessage())
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'c' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledTimes(3) })
    expect(mdOf(lastCard(channel))).not.toContain(t.stepAutoTriggerNote(t.autoTurnTriggerName('job')))
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
    // The continuation card's title is localized since 2026-10-14 (it used to be
    // a hardcoded English `Reply (continued n/m)`, shown even in a zh chat).
    const overflow = cards.filter((card: any) => String(card.header?.title?.content).startsWith('📄'))
    expect(overflow.length).toBeGreaterThan(0)
    expect(JSON.stringify(overflow)).toContain('HYDRATED')
    streaming.stop()
  })
})

// ---------------------------------------------------------------------------
// The step card's own send and the chat's ordering barrier (2026-09-24)
// ---------------------------------------------------------------------------

describe('the step card must not wait on the ordering barrier it belongs to', () => {
  /**
   * The real composition (see `index.ts`): every `channel.send` goes through
   * `createCardSendBarrier`, and the barrier's flush is the streaming module's
   * own "flush this chat's debounced step card, then await its send chain".
   *
   * That makes the step card's OWN send the one case the flush must not wait
   * for: the chat chain holds the very promise this send is inside, so awaiting
   * it is a self-deadlock that only the barrier timeout ends. Observed live on
   * 2026-09-24 19:30: the CardKit instance create dropped its socket, the
   * fallback send wedged for the full 60s, every update scheduled in between
   * was released in one burst, Feishu's per-message edit rate limit (230020)
   * killed the write carrying the answer, and the card kept rendering
   * "🧠 深度思考中" after the Turn Complete card had already been posted.
   */
  const barrieredChannel = (rawSend: ReturnType<typeof vi.fn>): {
    channel: StepChannel
    gaveUp: string[]
  } => {
    let pendingFlush: ((chatId: string) => Promise<void>) | undefined
    const gaveUp: string[] = []
    const barrier = createCardSendBarrier({
      timeoutMs: 60_000,
      onTimeout: reason => gaveUp.push(reason),
    })
    const channel: StepChannel = {
      // The raw half: producing the message id is what the chat waits for.
      send: vi.fn((to: string, input: unknown, opts?: unknown) =>
        barrier.run(to, pendingFlush, () => rawSend(to, input, opts))),
      // The step card's own send: the same HTTP call, without the flush.
      sendStepCard: vi.fn((to: string, input: unknown, opts?: unknown) => rawSend(to, input, opts)),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => {
        throw new Error('Client network socket disconnected before secure TLS connection was established')
      }),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
      updateCardInstance: vi.fn(async () => undefined),
      registerPendingCardFlush: vi.fn((flush: (chatId: string) => Promise<void>) => { pendingFlush = flush }),
    }
    return { channel, gaveUp }
  }

  it('posts the card at once when CardKit is unavailable, instead of timing out on its own flush', async () => {
    vi.useFakeTimers()
    try {
      const rawSend = vi.fn(async () => ({ messageId: 'm-plain' }))
      const { channel, gaveUp } = barrieredChannel(rawSend)
      const h = stepHarness(channel)
      h.emit('step/start', { turn: 1, step: 1 })
      await vi.advanceTimersByTimeAsync(500)
      expect(rawSend).toHaveBeenCalledOnce()
      expect(gaveUp).toEqual([])
      h.streaming.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps one write per card in flight and supersedes the rest, so updates cannot burst', async () => {
    vi.useFakeTimers()
    try {
      const written: string[] = []
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      const channel: StepChannel = {
        send: vi.fn(async () => ({ messageId: 'm-plain' })),
        updateCard: vi.fn(async () => undefined),
        createCardInstance: vi.fn(async () => 'card-1'),
        sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
        updateCardInstance: vi.fn(async (_cardId: string, card: any) => {
          written.push(mdOf(card))
          // The first write is as slow as a hydrated card (a video upload).
          if (written.length === 1) await gate
        }),
      }
      const h = stepHarness(channel)
      h.emit('step/start', { turn: 1, step: 1 })
      await vi.advanceTimersByTimeAsync(200)
      h.emit('tool/call', { callId: 'c1', name: 'first-tool', arguments: '{}' })
      await vi.advanceTimersByTimeAsync(200)
      expect(written).toHaveLength(1)

      // Three more renders while that write is stuck: with no serialization
      // each one becomes its own call, and Feishu answers 230020 for the burst.
      h.emit('tool/call', { callId: 'c2', name: 'second-tool', arguments: '{}' })
      await vi.advanceTimersByTimeAsync(200)
      h.emit('tool/call', { callId: 'c3', name: 'third-tool', arguments: '{}' })
      await vi.advanceTimersByTimeAsync(200)
      h.emit('tool/call', { callId: 'c4', name: 'fourth-tool', arguments: '{}' })
      await vi.advanceTimersByTimeAsync(200)
      expect(written).toHaveLength(1)

      release()
      await vi.advanceTimersByTimeAsync(50)
      // Only the newest card was worth writing; the three superseded ones were
      // dropped instead of being replayed into a rate limit.
      expect(written).toHaveLength(2)
      expect(written.at(-1)).toContain('fourth-tool')
      h.streaming.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * Two steps of one turn: step 1's text lands on its card, step 2's text is
   * only ever carried by an update — which is the write the operator is waiting
   * for. Refusing THAT write while step 1's text already landed is the case
   * that used to end the turn with "a step card carried the text → footer
   * only": the mark stood, no reply card was posted, and step 2's answer was
   * silently gone with a card left on "🧠 深度思考中".
   */
  const twoStepTurn = async (failSecondStep: boolean) => {
    const channel: StepChannel = {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async (_messageId: string, card: any) => {
        if (failSecondStep && mdOf(card).includes('第二段')) {
          // A transport answer, not a content rejection: the card writer does
          // not retry it (see `isCardContentRejection`).
          throw new Error('Request failed with status code 400')
        }
      }),
    }
    const h = stepHarness(channel)
    h.emit('turn/start')
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '第一段' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(250)
    h.emit('step/start', { turn: 1, step: 2 })
    // The card is posted bare first (a step opens its card before any text),
    // so step 2's text can only reach the screen through an update.
    await tick(250)
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '第二段' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await tick(250)
    expect(h.bridge.markIntermediateSent).toHaveBeenCalledWith('s-1')
    h.emit('turn/end')
    await h.streaming.flushed('s-1')
    h.streaming.stop()
    return h
  }

  it('withdraws the delivery note when the newest text write failed', async () => {
    const h = await twoStepTurn(true)
    expect(h.bridge.clearIntermediateSent).toHaveBeenCalledWith('s-1')
  })

  it('keeps the delivery note when the newest text write landed', async () => {
    const h = await twoStepTurn(false)
    expect(h.bridge.clearIntermediateSent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// O20: the card distinguishes "request not sent yet" from "model is thinking".
// The live phase comes from the TRANSIENT `agent/assistant-stream` publication,
// because no token delta is a durable session event any more.
// ---------------------------------------------------------------------------

/** Card title, which is where the phase is named. */
function titleOf(card: any): string {
  return card.header.title.content
}

describe('step card live phases (O20)', () => {
  const build = (phase: any, route?: { provider: string; model: string }, text?: string): any => renderStepCard(
    t, undefined, text, [], undefined, undefined, undefined, undefined, undefined, 1, 1,
    {
      ...(text === undefined ? { empty: 'thinking' as const } : {}),
      phase,
      ...(route === undefined ? {} : { route }),
    },
  )

  it('names each phase instead of calling every wait "thinking"', () => {
    expect(titleOf(build('none'))).toContain(t.stepPlaceholderTitle)
    expect(titleOf(build('awaiting'))).toContain(t.stepAwaitingTitle)
    expect(titleOf(build('thinking'))).toContain(t.stepThinkingTitle)
    expect(titleOf(build('replying'))).toContain(t.stepReplyingTitle)
    // The pre-request phase must not claim the model is reasoning.
    expect(titleOf(build('none'))).not.toContain('思考')
    expect(mdOf(build('none'))).toContain(t.stepPlaceholderBody)
    expect(mdOf(build('awaiting'))).toContain(t.stepAwaitingBody)
    expect(mdOf(build('thinking'))).toContain(t.stepThinkingBody)
    expect(mdOf(build('replying'))).toContain(t.stepReplyingBody)
  })

  it('shows the route only while waiting for the first token', () => {
    const route = { provider: 'deepseek-official', model: 'deepseek-flash' }
    expect(mdOf(build('awaiting', route))).toContain(t.stepRouteLine(route.provider, route.model))
    // Other phases have better things to say than the route.
    expect(mdOf(build('thinking', route))).not.toContain(t.stepRouteLine(route.provider, route.model))
    expect(mdOf(build('none', route))).not.toContain(t.stepRouteLine(route.provider, route.model))
  })

  it('ignores the phase once the card carries content', () => {
    expect(titleOf(build('awaiting', undefined, '答案已到'))).toContain(t.stepCardTitleReply)
    expect(titleOf(build('thinking', undefined, '答案已到'))).toContain(t.stepCardTitleReply)
  })
})

describe('live phase wiring from agent/assistant-stream (O20)', () => {
  const channel = (): StepChannel => ({
    send: vi.fn(async () => ({ messageId: 'm-1' })),
    updateCard: vi.fn(async () => undefined),
  })
  const lastCard = (ch: StepChannel): any => {
    const updates = (ch.updateCard as any).mock.calls
    if (updates.length > 0) return updates.at(-1)![1]
    return (ch.send as any).mock.calls.at(-1)![1].card
  }

  it('walks placeholder → awaiting → thinking → replying on ONE card', async () => {
    const ch = channel()
    const h = stepHarness(ch)
    h.emit('turn/start', { turn: 1 })
    h.emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(ch.send).toHaveBeenCalledTimes(1) })
    expect(titleOf(lastCard(ch))).toContain(t.stepPlaceholderTitle)

    h.emit('request/context', { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 4096 })
    h.emitStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    await vi.waitFor(() => { expect(titleOf(lastCard(ch))).toContain(t.stepAwaitingTitle) })
    expect(mdOf(lastCard(ch))).toContain('deepseek-flash')

    h.emitStream({
      type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: Date.now(),
      chunk: { type: 'reasoning-delta', text: '让我想想' },
    })
    await vi.waitFor(() => { expect(titleOf(lastCard(ch))).toContain(t.stepThinkingTitle) })

    h.emitStream({
      type: 'chunk', attemptId: 'a1', revision: 3, index: 1, time: Date.now(),
      chunk: { type: 'text-delta', text: '答案是' },
    })
    await vi.waitFor(() => { expect(titleOf(lastCard(ch))).toContain(t.stepReplyingTitle) })

    // Every phase repainted the SAME card: the step never posted a second one.
    expect(ch.send).toHaveBeenCalledTimes(1)
    h.streaming.stop()
  })

  it('never walks backwards when a late reasoning delta follows text', async () => {
    const ch = channel()
    const h = stepHarness(ch)
    h.emit('turn/start', { turn: 1 })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emitStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    h.emitStream({
      type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: Date.now(),
      chunk: { type: 'text-delta', text: '答案' },
    })
    await vi.waitFor(() => { expect(ch.send).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(titleOf(lastCard(ch))).toContain(t.stepReplyingTitle) })
    h.emitStream({
      type: 'chunk', attemptId: 'a1', revision: 3, index: 1, time: Date.now(),
      chunk: { type: 'reasoning-delta', text: '迟到的推理' },
    })
    await tick(200)
    expect(titleOf(lastCard(ch))).toContain(t.stepReplyingTitle)
    h.streaming.stop()
  })

  it('falls back to the placeholder when the attempt was abandoned', async () => {
    const ch = channel()
    const h = stepHarness(ch)
    h.emit('turn/start', { turn: 1 })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emitStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    await vi.waitFor(() => { expect(ch.send).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(titleOf(lastCard(ch))).toContain(t.stepAwaitingTitle) })

    // DSH abandons the attempt and retries: the retry publishes its own start.
    h.emitStream({ type: 'end', attemptId: 'a1', revision: 2, index: 3, outcome: { kind: 'abandoned' } })
    await vi.waitFor(() => { expect(titleOf(lastCard(ch))).toContain(t.stepPlaceholderTitle) })
    h.emitStream({ type: 'start', attemptId: 'a2', revision: 3, turn: 1, step: 1 })
    await vi.waitFor(() => { expect(titleOf(lastCard(ch))).toContain(t.stepAwaitingTitle) })
    h.streaming.stop()
  })

  it('ignores frames for a session no chat is bound to', async () => {
    const ch = channel()
    const h = stepHarness(ch)
    h.emit('turn/start', { turn: 1 })
    h.emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(ch.send).toHaveBeenCalledTimes(1) })
    const before = (ch.updateCard as any).mock.calls.length
    h.emitStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 }, 's-other')
    h.emitStream({ type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: Date.now(), chunk: { type: 'text-delta', text: 'x' } }, 's-other')
    await tick(200)
    expect((ch.updateCard as any).mock.calls.length).toBe(before)
    h.streaming.stop()
  })

  it('stops listening once the step ended', async () => {
    const ch = channel()
    const h = stepHarness(ch)
    h.emit('turn/start', { turn: 1 })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('step/end', { turn: 1, step: 1 })
    await tick(200)
    const before = (ch.updateCard as any).mock.calls.length
    h.emitStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    h.emitStream({ type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: Date.now(), chunk: { type: 'reasoning-delta', text: 'x' } })
    await tick(200)
    expect((ch.updateCard as any).mock.calls.length).toBe(before)
    h.streaming.stop()
  })

  it('unsubscribes from the stream publication on stop', () => {
    const ch = channel()
    const listeners = new Map<string, Array<(a: any, b?: any) => void>>()
    const removals: string[] = []
    const streaming = startFeishuStreaming({
      ctx: {
        on: (name: string, handler: any) => {
          const list = listeners.get(name)
          if (list === undefined) listeners.set(name, [handler])
          else list.push(handler)
          return () => { removals.push(name) }
        },
      } as any,
      channel: ch as any,
      bridgeHolder: { current: { resolveChat: () => ({ chatId: 'oc_1', chatType: 'p2p' }) } as any },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    })
    expect(listeners.get('agent/assistant-stream')).toHaveLength(1)
    streaming.stop()
    expect(removals).toContain('agent/assistant-stream')
  })
})

// ---------------------------------------------------------------------------
// O20 follow-up: the awaiting card names the route. `request/context` only
// fires when the route changes, so the durable `request/header` (whose config
// carries provider/model, exactly what /model reads back) is the primary source.
// ---------------------------------------------------------------------------

describe('awaiting card route line (O20)', () => {
  const channel = (): StepChannel => ({
    send: vi.fn(async () => ({ messageId: 'm-1' })),
    updateCard: vi.fn(async () => undefined),
  })
  const lastCardOf = (ch: StepChannel): any => {
    const updates = (ch.updateCard as any).mock.calls
    if (updates.length > 0) return updates.at(-1)![1]
    return (ch.send as any).mock.calls.at(-1)![1].card
  }

  it('takes the route from request/header and shows it while awaiting', async () => {
    const ch = channel()
    const h = stepHarness(ch)
    h.emit('turn/start', { turn: 1 })
    h.emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(ch.send).toHaveBeenCalledTimes(1) })
    // Only a header is emitted for this request — no request/context at all.
    h.emit('request/header', { header: { config: { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview' } }, reason: 'series' })
    h.emitStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    await vi.waitFor(() => { expect(titleOf(lastCardOf(ch))).toContain(t.stepAwaitingTitle) })
    expect(mdOf(lastCardOf(ch))).toContain(t.stepRouteLine('minimax-cn', 'MiniMax-M3.1-Flash-Preview'))
    h.streaming.stop()
  })

  it('keeps the last known route across steps', async () => {
    const ch = channel()
    const h = stepHarness(ch)
    h.emit('turn/start', { turn: 1 })
    h.emit('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, reason: 'initial' })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emitStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    await vi.waitFor(() => { expect(titleOf(lastCardOf(ch))).toContain(t.stepAwaitingTitle) })
    expect(mdOf(lastCardOf(ch))).toContain('deepseek-flash')
    // A second step whose request emitted no header still names the route.
    h.emit('step/end', { turn: 1, step: 1 })
    h.emit('step/start', { turn: 1, step: 2 })
    h.emitStream({ type: 'start', attemptId: 'a2', revision: 2, turn: 1, step: 2 })
    await vi.waitFor(() => { expect(mdOf(lastCardOf(ch))).toContain('deepseek-flash') })
    h.streaming.stop()
  })
})

describe('display levels on the step card (O22/O5)', () => {
  /** A card whose reasoning was rendered as a folded panel, or undefined. */
  const panelOf = (card: any): any =>
    (card.body.elements as any[]).find(el => el.tag === 'collapsible_panel')

  it('folds the reasoning into a collapsed panel at the default level', () => {
    const card = renderStepCard(t, 'step one\nstep two', undefined, []) as any
    const panel = panelOf(card)
    expect(panel).toBeDefined()
    // Collapsed by default: the header is the summary, the chain is one tap away.
    expect(panel.expanded).toBe(false)
    // The fold must be visible: the header says so in words, and the panel is
    // drawn as a bordered, tinted block so it reads as a control (see
    // card-fold.ts — a bare header looks like a heading).
    expect(panel.header.title.content).toBe(t.cardFoldTitle(t.stepReasoningHeader))
    expect(panel.header.title.content).toContain('已折叠')
    expect(panel.header.background_color).toBe('grey-100')
    expect(panel.border).toEqual({ color: 'grey-300', corner_radius: '4px' })
    // The body is a fenced block inside the panel, not a top-level markdown.
    expect(panel.elements[0].content).toContain('step one\nstep two')
    expect((card.body.elements as any[]).some(el => el.tag === 'markdown'
      && String(el.content).includes('step one'))).toBe(false)
  })

  it('gives the verbose level the whole chain, still folded', () => {
    const long = 'y'.repeat(900)
    const card = renderStepCard(t, long, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { display: { reasoning: 'full', tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: true, turnCard: false } }) as any
    const panel = panelOf(card)
    expect(panel.expanded).toBe(false)
    expect(panel.elements[0].content).toContain(long)
    expect(panel.elements[0].content).not.toContain('truncated')
  })

  it('shows only the first line and nothing to expand at the standard level', () => {
    const card = renderStepCard(t, 'first line\nsecond line', undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { display: { reasoning: 'preview', tools: 'summary', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: false } }) as any
    expect(panelOf(card)).toBeUndefined()
    const md = mdOf(card)
    expect(md).toContain('first line')
    expect(md).not.toContain('second line')
  })

  it('drops the reasoning entirely at the compact level', () => {
    const card = renderStepCard(t, 'hidden chain', undefined, []) as any
    expect(mdOf(card)).toContain('hidden chain')
    const compact = renderStepCard(t, 'hidden chain', undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { display: { reasoning: 'off', tools: 'count', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: true } }) as any
    expect(mdOf(compact)).not.toContain('hidden chain')
    expect(panelOf(compact)).toBeUndefined()
  })

  const tool = {
    toolName: 'bash',
    callId: 'c1',
    arguments: '{"command":"ls"}',
    result: { isError: false, content: 'a\nb', elapsed: 1200 },
  } as any

  it('collapses tools to one count line at the compact level', () => {
    const card = renderStepCard(t, undefined, undefined, [tool, { ...tool, callId: 'c2', result: { ...tool.result, isError: true } }], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { display: { reasoning: 'off', tools: 'count', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: true } }) as any
    const md = mdOf(card)
    expect(md).toContain(t.stepToolCount(2, 1))
    // No per-call lines, no args, no result blocks.
    expect(md).not.toContain('`bash`')
    expect(md).not.toContain(t.stepToolArgsHeader)
    expect(md).not.toContain(t.stepToolResultHeader)
  })

  it('names each call but carries no payload at the standard level', () => {
    const card = renderStepCard(t, undefined, undefined, [tool], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { display: { reasoning: 'preview', tools: 'summary', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: false } }) as any
    const md = mdOf(card)
    expect(md).toContain('bash')
    expect(md).not.toContain(t.stepToolArgsHeader)
    expect(md).not.toContain(t.stepToolResultHeader)
  })

  it('renders args and results at the detailed level (the pre-level default)', () => {
    const card = renderStepCard(t, undefined, undefined, [tool]) as any
    const md = mdOf(card)
    expect(md).toContain(t.stepToolArgsHeader)
    expect(md).toContain(t.stepToolResultHeader)
  })

  it('puts injection notices above everything else on the card', () => {
    const card = renderStepCard(t, 'the answer', undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { injections: ['📥 注入上下文 · AGENTS.md（已更新）', '🔗 跨会话召回 · other'] }) as any
    const markdown = (card.body.elements as any[]).filter(el => el.tag === 'markdown')
    expect(markdown[0].content).toBe('📥 注入上下文 · AGENTS.md（已更新）')
    expect(markdown[1].content).toBe('🔗 跨会话召回 · other')
    // Marked as notation so attributions never compete with the content.
    expect(markdown[0].text_size).toBe('notation')
  })
})

describe('level + injection wiring through session events', () => {
  const levelChannel = (): StepChannel => ({
    send: vi.fn(async () => ({ messageId: 'm-plain' })),
    updateCard: vi.fn(async () => undefined),
    createCardInstance: vi.fn(async () => 'card-1'),
    sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
    updateCardInstance: vi.fn(async () => undefined),
  })
  const lastCard = (ch: StepChannel): any => {
    const updates = (ch.updateCardInstance as any).mock.calls
    if (updates.length > 0) return updates.at(-1)![1]
    return (ch.createCardInstance as any).mock.calls.at(-1)![0]
  }

  it('folds a live step card according to the level the settings hold', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('assistant/chunk', { chunk: { type: 'reasoning-delta', text: 'private chain' } })
    // A compact step opens its card on TEXT, not at `step/start`: the step cards
    // carry the answer, and reasoning alone is invisible at this level.
    expect(ch.createCardInstance).not.toHaveBeenCalled()
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 1 } })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalled() })
    await tick(250)
    expect(mdOf(lastCard(ch))).toContain('the answer')
    expect(mdOf(lastCard(ch))).not.toContain('private chain')
    h.streaming.stop()
  })

  it('takes the mid-turn reply off its own card and onto the turn card', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    h.emit('turn/start')
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '我先看一下那段代码' } })
    // The same message that carries the prose also asks for a tool — WebUI
    // parity: that text is process narration, never the turn's answer.
    h.emit('assistant/message', {
      message: {
        content: [
          { type: 'text', text: '我先看一下那段代码' },
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    h.emit('tool/call', { callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' })
    await tick(300)
    // ONE card only: the turn progress card, whose step section carries the
    // narration as a row. No step card was posted for the narration.
    expect(ch.createCardInstance).toHaveBeenCalledTimes(1)
    const card = lastCard(ch)
    expect(isTurnCardTitle(String(card.header.title.content))).toBe(true)
    expect(mdOf(card)).toContain(t.turnCardStepNote('我先看一下那段代码'))
    h.streaming.stop()
  })

  it('merges an injection notice and the step narration onto the turn card', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    h.emit('turn/start')
    // The runtime context lands on EVERY turn's first step, so this is the shape
    // that used to post a stray step card carrying the narration as a reply.
    h.emit('user/message', { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'narration' } })
    h.emit('assistant/message', {
      message: { content: [{ type: 'text', text: 'narration' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalled() })
    // The narration reaches an ALREADY OPEN card through the write throttle, so
    // give the coalescing window time to elapse.
    await tick(1_100)
    // ONE card: the turn card. It carries both the notice (process) and the
    // narration (process) — no step card, and nothing is dropped (O21① survives
    // as a row instead of as a card).
    expect(ch.createCardInstance).toHaveBeenCalledTimes(1)
    const card = lastCard(ch)
    const md = mdOf(card)
    expect(isTurnCardTitle(String(card.header.title.content))).toBe(true)
    expect(md).toContain('@deepseek-ai/dsh-system-prompt')
    expect(md).toContain(t.turnCardStepNote('narration'))
    h.streaming.stop()
  })

  it('keeps the injection notice on the step card at the other levels', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch)
    h.emit('turn/start')
    h.emit('user/message', { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'answer' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalled() })
    await tick(250)
    const md = mdOf(lastCard(ch))
    expect(md).toContain('@deepseek-ai/dsh-system-prompt')
    expect(md).toContain('answer')
    h.streaming.stop()
  })

  it('keeps the mid-turn reply on its own card for the non-compact levels', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch)
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'narration' } })
    h.emit('assistant/message', {
      message: { content: [{ type: 'text', text: 'narration' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalled() })
    await tick(250)
    const card = lastCard(ch)
    expect(String(card.header.title.content)).toContain('第 1 轮')
    expect(mdOf(card)).toContain('narration')
    h.streaming.stop()
  })

  it('renders the compact answer card without the section chrome', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalled() })
    await tick(250)
    const card = lastCard(ch)
    const elements = card.body.elements as any[]
    // No `📝 消息` label (the card has one section), and both footer lines share
    // ONE element so the card pays its element spacing once. The single `hr` is
    // the rule the user asked for between the answer and its footer (2026-10-14).
    expect(mdOf(card)).toContain('the answer')
    expect(mdOf(card)).not.toContain(t.stepMessageHeader)
    expect(elements.filter((el: any) => el.tag === 'hr')).toHaveLength(1)
    expect(elements.filter((el: any) => el.tag === 'markdown' && el.text_size === 'notation')).toHaveLength(1)
    expect(card.body.vertical_spacing).toBe('4px')
    h.streaming.stop()
  })

  it('opens a NEW compact answer card after another module posts one', async () => {
    const interleave = createCardInterleave()
    const ch = levelChannel()
    const h = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView }, { interleave })
    h.emit('turn/start')
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'part one' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalledTimes(1) })
    // A todo card (or any other card this plugin posts) lands in the chat.
    interleave.note('oc_1')
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: ' part two' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalledTimes(2) })
    const fresh = (ch.createCardInstance as any).mock.calls[1]![0]
    // The new card carries only what arrived after the interruption; the part
    // already on the retired card stays there.
    expect(mdOf(fresh)).toContain('part two')
    expect(mdOf(fresh)).not.toContain('part one')
    h.streaming.stop()
  })

  it('shows the stream phase on the running step of the turn card (compact)', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    h.emit('turn/start')
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalled() })
    h.emit('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } })
    // The phase signal is the transient stream; the turn card's running step is
    // the only place the user can see it (the step card is not posted at all
    // under `compact`).
    h.emitStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    await tick(1_100)
    expect(mdOf(lastCard(ch))).toContain(t.turnCardPhaseAwaiting)
    h.emitStream({
      type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: Date.now(),
      chunk: { type: 'reasoning-delta', text: '让我想想' },
    })
    await tick(1_100)
    const md = mdOf(lastCard(ch))
    expect(md).toContain(t.turnCardPhaseThinking)
    expect(md).not.toContain(t.turnCardPhaseAwaiting)
    h.streaming.stop()
  })

  it('keeps the turn card untouched by stream frames at the other levels', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch)
    h.emit('turn/start')
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    h.emit('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } })
    h.emitStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    h.emitStream({
      type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: Date.now(),
      chunk: { type: 'reasoning-delta', text: 'chain' },
    })
    await tick(1_100)
    // No turn card exists at this level, so the phase has nowhere to land: the
    // step card's own placeholder is the only thing that names it.
    const cards = (ch.createCardInstance as any).mock.calls.map((call: any[]) => JSON.stringify(call[0]))
    expect(cards.some((json: string) => json.includes(t.turnCardPhaseAwaiting))).toBe(false)
    expect(cards.some((json: string) => json.includes(t.turnCardPhaseThinking))).toBe(false)
    h.streaming.stop()
  })

  it('keeps the section chrome on the detailed step card', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch)
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalled() })
    await tick(250)
    const card = lastCard(ch)
    expect(mdOf(card)).toContain(t.stepMessageHeader)
    expect((card.body.elements as any[]).some((el: any) => el.tag === 'hr')).toBe(true)
    expect(card.body.vertical_spacing).toBeUndefined()
    h.streaming.stop()
  })

  it('posts no card for a compact step that only ran tools', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    h.emit('turn/start')
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    h.emit('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } })
    h.emit('step/end')
    await tick(300)
    // Exactly ONE card in the whole step: the turn progress card. The step's tool
    // work never opens a step card of its own under `compact`.
    expect(ch.createCardInstance).toHaveBeenCalledTimes(1)
    const card = lastCard(ch)
    expect(isTurnCardTitle(String(card.header.title.content))).toBe(true)
    h.streaming.stop()
  })

  it('attaches an injection notice to the card of the step it precedes', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch)
    h.emit('step/start', { turn: 1, step: 1 })
    await tick(250)
    h.emit('user/message', { source: { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'replace', path: 'AGENTS.md' }] } })
    await tick(250)
    expect(mdOf(lastCard(ch))).toContain('AGENTS.md（已更新）')
    h.streaming.stop()
  })

  it('buffers an injection that arrives before step/start and lands on that step card', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch)
    // A compaction transaction re-injects the plugin list BEFORE the step opens;
    // putting it in step state at that moment would be wiped by `resetStep`.
    h.emit('user/message', { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } })
    h.emit('step/start', { turn: 1, step: 1 })
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'answer' } })
    h.emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalled() })
    await tick(250)
    const md = mdOf(lastCard(ch))
    expect(md).toContain('@deepseek-ai/dsh-system-prompt')
    // Still first: the injection belongs to the request this step sends.
    const markdown = (lastCard(ch).body.elements as any[]).filter(el => el.tag === 'markdown')
    expect(String(markdown[0].content)).toContain('@deepseek-ai/dsh-system-prompt')
    h.streaming.stop()
  })

  it('never shows the human trigger message or the compaction checkpoint as an injection', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch)
    h.emit('step/start', { turn: 1, step: 1 })
    await tick(250)
    const before = mdOf(lastCard(ch))
    h.emit('user/message', { source: { kind: 'user' } })
    h.emit('user/message', { source: { kind: 'compact-checkpoint', compactionId: 'x' } })
    await tick(250)
    expect(mdOf(lastCard(ch))).toBe(before)
    h.streaming.stop()
  })

  it('opens a compaction card on compaction/start and closes it on compaction/end', async () => {
    const ch = levelChannel()
    const h = stepHarness(ch)
    h.emit('compaction/start', { compactionId: 'c1', turn: null })
    await vi.waitFor(() => { expect(ch.createCardInstance).toHaveBeenCalledTimes(1) })
    expect(String((ch.createCardInstance as any).mock.calls[0]![0].header.title.content)).toContain('压缩上下文')
    h.emit('compaction/summary', {
      compactionId: 'c1',
      summary: [{ type: 'text', text: 'a long summary' }],
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 302000,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    await vi.waitFor(() => { expect(ch.updateCardInstance).toHaveBeenCalled() })
    const updated = (ch.updateCardInstance as any).mock.calls.at(-1)![1]
    const md = mdOf(updated)
    expect(md).toContain('3 条历史记录')
    expect(md).toContain('302K tokens')
    const panel = (updated.body.elements as any[]).find((el: any) => el.tag === 'collapsible_panel')
    expect(panel.elements[0].content).toBe('a long summary')
    h.emit('compaction/end', { compactionId: 'c1', turn: null })
    await tick(50)
    h.streaming.stop()
  })
})

// ---------------------------------------------------------------------------
// Turn progress card (`compact` level): the turn's tool activity on ONE card
// ---------------------------------------------------------------------------

describe('turn progress card wiring', () => {
  function channel(): StepChannel {
    return {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
      updateCardInstance: vi.fn(async () => undefined),
    }
  }
  /** Titles of every card instance the streaming module created for a turn. */
  const titles = (ch: StepChannel): string[] =>
    (ch.createCardInstance?.mock.calls ?? []).map(call => String((call[0] as any).header.title.content))
  /** The progress card among the updated renders (its title names the turn). */
  const progressRenders = (ch: StepChannel): any[] =>
    (ch.updateCardInstance?.mock.calls ?? [])
      .map(call => call[1] as any)
      .filter(card => isTurnCardTitle(String(card.header?.title?.content ?? '')))

  it('mirrors the whole turn onto one card at the compact level', async () => {
    const ch = channel()
    const { streaming, emit } = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    await tick(300)
    // The ONE card so far is the progress card: a tool-only step posts no step
    // card at this level (the whole point of the merge).
    expect(titles(ch).some(isTurnCardTitle)).toBe(true)
    expect(titles(ch).filter(title => !isTurnCardTitle(title))).toEqual([])
    const opened = (ch.createCardInstance!.mock.calls.map(call => call[0] as any))
      .find(card => isTurnCardTitle(String(card.header.title.content)))
    expect(mdOf(opened)).toContain('⏳ `bash`')
    // The elapsed time is read from the clock, so pinning it to `0ms` made this
    // assertion fail whenever the render crossed a millisecond boundary
    // (observed flaky 2026-10-14). Assert the row's shape instead.
    expect(mdOf(opened)).toMatch(/▸ \*\*第 1 步\*\* · 🔧 工具调用中 · \d+ms…/)

    emit('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } })
    // The answer opens a step card of its own — carrying the text and NOTHING
    // about the tools, which live on the turn card.
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(titles(ch).some(title => !isTurnCardTitle(title))).toBe(true) })
    const answer = (ch.createCardInstance!.mock.calls.map(call => call[0] as any))
      .find(card => !isTurnCardTitle(String(card.header.title.content)))
    expect(mdOf(answer)).toContain('the answer')
    expect(mdOf(answer)).not.toContain('工具调用')
    expect(mdOf(answer)).not.toContain('`bash`')

    emit('turn/end', { reason: { kind: 'completed' } })
    // Wait for the FINISHED render, not merely for some render: `finish()` is
    // fire-and-forget, so asserting on the last render right after the first
    // one appears raced the green repaint (observed flaky 2026-10-14).
    await vi.waitFor(() => {
      expect(progressRenders(ch).at(-1)?.header.template).toBe('green')
    })
    const last = progressRenders(ch).at(-1)!
    expect(mdOf(last)).toContain('✅ `bash`')
    streaming.stop()
  })

  it('folds the turn summary into the compact answer card instead of a Turn Complete card', async () => {
    const ch = channel()
    const { streaming, emit } = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    emit('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } } })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    emit('assistant/message', { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } })
    await vi.waitFor(() => { expect(titles(ch).some(title => !isTurnCardTitle(title))).toBe(true) })
    emit('turn/end', { reason: { kind: 'completed' } })

    // The summary is written INTO the answer card: an update, not a new card.
    const answerWrites = (): any[] => [
      ...ch.updateCardInstance!.mock.calls.map(call => call[1] as any),
      ...ch.updateCard!.mock.calls.map(call => call[1] as any),
    ]
      .filter(card => !isTurnCardTitle(String((card as any)?.header?.title?.content ?? '')))
    await vi.waitFor(() => {
      expect(answerWrites().some(card => (card.header?.title?.content ?? '').startsWith(t.turnSummaryTitle))).toBe(true)
    })
    const final = answerWrites().find(card => (card.header?.title?.content ?? '').startsWith(t.turnSummaryTitle))!
    // The card that ends the turn SAYS so, with the clock, and reads green. No
    // turn/step position: `完成 · 时间` is the whole title (2026-10-14).
    expect(String(final.header.title.content)).toMatch(new RegExp(`^${t.turnSummaryTitle} · \\d+ms$|^${t.turnSummaryTitle} · \\d+\\.\\d+s$`))
    expect(final.header.template).toBe('green')
    expect(final.header.title.content).not.toContain(t.stepPosition(1, 1))
    const md = mdOf(final)
    expect(md).toContain('the answer')
    expect(md).toContain('🧠 deepseek-flash · 💡 high')
    expect(md).toContain('📦')
    // The footer is ruled off from the body, and no longer repeats the clock the
    // title carries.
    const tags = (final.body.elements as any[]).map(element => element.tag)
    expect(tags).toEqual(['markdown', 'hr', 'markdown'])
    expect(md).not.toContain('⏱')
    // Nothing opened a second card for the summary: the level has no Turn
    // Complete card.
    expect(titles(ch).filter(title => !isTurnCardTitle(title))).toHaveLength(1)
    streaming.stop()
  })

  it('puts the compact summary on the last overflow card when the answer is split', async () => {
    const ch = channel()
    const { streaming, emit } = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    // Three block-sized paragraphs: the step card takes the first, and the reply
    // needs TWO continuation cards, which is the only case where `续 n/n` counts
    // something (a single continuation card is just the tail of the answer).
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: ['x', 'y', 'z'].map(c => c.repeat(3000)).join('\n\n') } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(titles(ch).some(title => !isTurnCardTitle(title))).toBe(true) })
    emit('turn/end', { reason: { kind: 'completed' } })

    // The "continued" cards are sent, and the summary rides the LAST one — the
    // card the reader's eye ends on — rather than the step card above it.
    await vi.waitFor(() => { expect(ch.send.mock.calls.length).toBeGreaterThan(1) })
    const sentCards = ch.send.mock.calls.map(call => (call[1] as any).card)
    expect(sentCards).toHaveLength(2)
    // A card that only carries part of the answer names its position…
    expect(String(sentCards[0]!.header.title.content)).toBe(`📄 ${t.turnContinuedPart(1, 2)}`)
    expect(sentCards[0]!.header.template).toBe('blue')
    // …and the LAST fragment is the card that ends the turn: completion, its
    // position, the clock, green, and a ruled-off footer.
    const last = sentCards.at(-1) as any
    expect(String(last.header.title.content)).toMatch(new RegExp(`^${t.turnSummaryTitle} · ${t.turnContinuedPart(2, 2)} · `))
    expect(last.header.template).toBe('green')
    expect(mdOf(last)).toContain('📦')
    expect((last.body.elements as any[]).map(element => element.tag)).toContain('hr')
    streaming.stop()
  })

  it('counts nothing on a reply that needed exactly one continuation card', async () => {
    const ch = channel()
    const { streaming, emit } = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: '正文\n\n'.repeat(200) + 'x'.repeat(3500) } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => { expect(titles(ch).some(title => !isTurnCardTitle(title))).toBe(true) })
    emit('turn/end', { reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(ch.send.mock.calls.length).toBeGreaterThan(0) })
    const last = ch.send.mock.calls.map(call => (call[1] as any).card).at(-1) as any
    // One continuation card: no `续 1/1`, just the completion title.
    expect(String(last.header.title.content)).toMatch(new RegExp(`^${t.turnSummaryTitle} · `))
    expect(String(last.header.title.content)).not.toContain(t.turnContinuedPart(1, 1))
    streaming.stop()
  })

  it('names the model and effort from the session record when no request header was seen', async () => {
    // A plugin that was re-mounted inside a live host agent (HMR reload) never
    // sees a `request/header` — DSH appends one only on initial / resume / change
    // — so the footer must fall back to the route the SESSION LOG records.
    // Without it the line vanished from every card until the next route change
    // (reported 2026-10-15).
    const ch = channel()
    const { streaming, emit } = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView }, {
      sessionMeta: () => ({ model: 'deepseek-official/deepseek-flash', reasoningEffort: 'high' }),
    })
    /** The answer card (not the progress card): a text-only turn opens no other. */
    const answerCards = (): any[] => [
      ...ch.createCardInstance!.mock.calls.map(call => call[0] as any),
      ...ch.updateCardInstance!.mock.calls.map(call => call[1] as any),
    ].filter(card => !isTurnCardTitle(String(card.header?.title?.content ?? '')))
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    emit('assistant/message', { usage: { inputTokens: 100, outputTokens: 20 } })
    await vi.waitFor(() => { expect(answerCards().length).toBeGreaterThan(0) })
    // `getSessionMeta` reads the session log, so its answer lands a tick later —
    // and it is captured at `turn/start`, seconds before the turn ends in
    // production.
    await tick(20)
    emit('turn/end', { reason: { kind: 'completed' } })

    const finalOf = (needle: string): any | undefined =>
      answerCards().filter(card => String(card.header.title.content).startsWith(t.turnSummaryTitle))
        .find(card => mdOf(card).includes(needle))
    await vi.waitFor(() => { expect(finalOf('💡 high')).toBeDefined() })
    const final = finalOf('💡 high')!
    // On its OWN line, under the summary: the provider prefix is dropped, and the
    // pair is not appended to the token line above it.
    const footer = (final.body.elements as any[]).filter(el => el.tag === 'markdown').at(-1)
    const lines = String(footer.content).split('\n')
    expect(lines).toContain('🧠 deepseek-flash · 💡 high')
    expect(lines[0]).toContain('📦')
    streaming.stop()
  })

  it("prefers the turn's own request header over the session record", async () => {
    const ch = channel()
    const { streaming, emit } = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView }, {
      sessionMeta: () => ({ model: 'stale-provider/stale-model', reasoningEffort: 'low' }),
    })
    const answerCards = (): any[] => [
      ...ch.createCardInstance!.mock.calls.map(call => call[0] as any),
      ...ch.updateCardInstance!.mock.calls.map(call => call[1] as any),
    ].filter(card => !isTurnCardTitle(String(card.header?.title?.content ?? '')))
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    emit('request/header', { header: { config: { provider: 'cpa-codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' } } })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the answer' } })
    emit('assistant/message', { usage: { inputTokens: 100, outputTokens: 20 } })
    await vi.waitFor(() => { expect(answerCards().length).toBeGreaterThan(0) })
    await tick(20)
    emit('turn/end', { reason: { kind: 'completed' } })

    await vi.waitFor(() => {
      expect(answerCards().some(card => mdOf(card).includes('💡 xhigh'))).toBe(true)
    })
    const final = answerCards().filter(card => mdOf(card).includes('💡 xhigh')).at(-1)!
    expect(mdOf(final)).toContain('🧠 gpt-6.1-sol · 💡 xhigh')
    expect(mdOf(final)).not.toContain('stale-model')
    streaming.stop()
  })

  it('leaves the turn alone at the detailed level', async () => {
    const ch = channel()
    const { streaming, emit } = stepHarness(ch)
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    await tick(200)
    expect(titles(ch).some(isTurnCardTitle)).toBe(false)
    streaming.stop()
  })

  it('respects the tool-display switch: no progress card when tools are off', async () => {
    const ch = channel()
    const { streaming, emit } = stepHarness(ch, {
      transcriptView: () => 'compact' as TranscriptView,
      showToolCalls: () => false,
    })
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    emit('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
    await tick(200)
    expect(titles(ch).some(isTurnCardTitle)).toBe(false)
    streaming.stop()
  })

  it('sends no progress card for a turn that calls no tool', async () => {
    const ch = channel()
    const { streaming, emit } = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'no tools here' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    emit('step/end', {})
    emit('turn/end', { reason: { kind: 'completed' } })
    await tick(200)
    expect(titles(ch).some(isTurnCardTitle)).toBe(false)
    streaming.stop()
  })

  /**
   * The stream of an attempt that DIED mid-call, copied from a real session log
   * (2026-10-14): the model streamed reasoning, opened a tool-call block, and the
   * connection dropped before DSH ever ran `edit` — so no `tool/call` follows.
   */
  const DYING_ATTEMPT = [
    { type: 'chunk', time: 100, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'reasoning-chunks', time0: 200, index: 0, dt: [10], texts: ['让我想想'] },
    { type: 'chunk', time: 300, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
    { type: 'tool-call-chunks', time0: 400, index: 1, dt: [], id: 'call_dying', name: 'edit', args: ['{"file_path":"a.ts"}'] },
    { type: 'chunk', time: 500, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
    { type: 'chunk', time: 600, chunk: { type: 'finish', reason: 'stop' } },
  ]

  it('names the step the turn died in and the call it never ran (compact)', async () => {
    const ch = channel()
    const { streaming, emit } = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    emit('tool/call', { callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' })
    emit('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } })
    emit('step/end', { turn: 1, step: 1 })
    // The dying step: it never committed a message, so no `tool/call` ever names
    // the call it was making.
    emit('step/start', { turn: 1, step: 2 })
    emit('assistant/attempt', { turn: 1, step: 2, stream: DYING_ATTEMPT })
    emit('step/end', { turn: 1, step: 2 })
    emit('turn/end', { reason: { kind: 'error', error: { message: 'stream closed before response.completed', code: 'PI_AI_ERROR' } } })

    await vi.waitFor(() => { expect(progressRenders(ch).at(-1)?.header.template).toBe('red') })
    const last = progressRenders(ch).at(-1)!
    const md = mdOf(last)
    // The failing step is named, and the call it was making is visible even
    // though it never ran (the user's report, 2026-10-14).
    expect(md).toMatch(/▸ \*\*第 2 步\*\* · [\d.]+m?s · ❌ 失败/)
    expect(md).toContain(t.turnCardCallUnrun('edit'))
    // It is not a tool row and not a tool count: only `read` ran.
    expect(md).not.toContain('`edit` · 4')
    expect(last.header.title.content).toMatch(/^⚙️ 本回合失败 · 1 个工具 · /)
    expect(last.header.title.content).not.toContain('2 个工具')
    streaming.stop()
  })

  it('drops the never-ran row when a retry commits and the call really runs (compact)', async () => {
    const ch = channel()
    const { streaming, emit } = stepHarness(ch, { transcriptView: () => 'compact' as TranscriptView })
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    // Attempt 1 streamed a call to `edit` and died…
    emit('assistant/attempt', { turn: 1, step: 1, stream: DYING_ATTEMPT })
    // …attempt 2 committed, and the step went on to run a real call.
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 }, message: { role: 'assistant', content: [] } })
    emit('tool/call', { callId: 'c2', name: 'read', arguments: '{"file_path":"a.ts"}' })
    emit('tool/result', { message: { toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }] } })
    emit('turn/end', { reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(progressRenders(ch).at(-1)?.header.template).toBe('green') })
    const md = mdOf(progressRenders(ch).at(-1)!)
    expect(md).toContain('✅ `read`')
    expect(md).not.toContain(t.turnCardCallUnrun('edit'))
    expect(md).not.toContain(t.turnCardStepFailed)
    streaming.stop()
  })
})

describe('uncommittedToolNames', () => {
  const records = (value: unknown): any => value

  it('reads the packed run that names the call, deduplicated and in order', () => {
    expect(uncommittedToolNames(records([
      { type: 'reasoning-chunks', time0: 0, index: 0, dt: [], texts: ['hi'] },
      { type: 'tool-call-chunks', time0: 0, index: 1, dt: [], id: 'c1', name: 'edit', args: ['{}'] },
      { type: 'tool-call-chunks', time0: 0, index: 2, dt: [], id: 'c2', name: 'edit', args: ['{}'] },
      { type: 'tool-call-chunks', time0: 0, index: 3, dt: [], id: 'c3', name: 'bash', args: ['{}'] },
    ]))).toEqual(['edit', 'bash'])
  })

  it('reads the raw delta shape too, and skips records that name nothing', () => {
    expect(uncommittedToolNames(records([
      { type: 'chunk', time: 0, chunk: { type: 'tool-call-delta', index: 0, id: 'c1', name: 'todo_write', argumentsDelta: '{}' } },
      { type: 'tool-call-chunks', time0: 0, index: 1, dt: [], id: 'c2', args: ['{}'] },
      { type: 'chunk', time: 0, chunk: { type: 'finish', reason: 'stop' } },
    ]))).toEqual(['todo_write'])
  })

  it('caps the row set at the same budget a merged tool row has', () => {
    const stream = ['a', 'b', 'c', 'd'].map((name, i) => (
      { type: 'tool-call-chunks', time0: 0, index: i, dt: [], id: `c${i}`, name, args: ['{}'] }
    ))
    expect(uncommittedToolNames(records(stream))).toHaveLength(PROGRESS_MAX_DETAILS)
  })

  it('returns nothing for an attempt that died before naming a tool', () => {
    expect(uncommittedToolNames(records([
      { type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
      { type: 'chunk', time: 0, chunk: { type: 'finish', reason: 'stop' } },
    ]))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Turn ownership: a plugin re-mounted mid-turn must not render that turn's tail
// ---------------------------------------------------------------------------

describe('turn ownership across a plugin re-mount', () => {
  function channel(): StepChannel {
    return {
      send: vi.fn(async () => ({ messageId: 'm-plain' })),
      updateCard: vi.fn(async () => undefined),
      createCardInstance: vi.fn(async () => 'card-1'),
      sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
      updateCardInstance: vi.fn(async () => undefined),
      sendStepCard: vi.fn(async () => ({ messageId: 'm-step' })),
    }
  }

  it('ignores the tail of a turn it never saw start, then renders its own turn', async () => {
    // 2026-10-15 01:19: an HMR reload split ONE turn between two instances. The
    // new instance rendered the tail the old one was still answering, so the chat
    // received two identical completion cards. `noTurnStart` makes the harness
    // behave like that re-mounted instance.
    const ch = channel()
    const { streaming, emit } = stepHarness(
      ch,
      { transcriptView: () => 'compact' as TranscriptView },
      { noTurnStart: true },
    )
    emit('step/start', { turn: 1, step: 1 })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'the tail of someone else’s turn' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    emit('turn/end', { reason: { kind: 'completed' } })
    await tick(300)
    // Nothing: not a step card, not an overflow card, not a progress card.
    expect(ch.createCardInstance).not.toHaveBeenCalled()
    expect(ch.send).not.toHaveBeenCalled()
    expect(ch.sendStepCard).not.toHaveBeenCalled()

    // The turn this instance DOES open renders exactly as before.
    emit('turn/start')
    emit('step/start', { turn: 2, step: 1 })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'mine' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => expect(ch.createCardInstance).toHaveBeenCalledTimes(1))
    expect(mdOf((ch.createCardInstance!.mock.calls[0] as any)[0])).toContain('mine')
    streaming.stop()
  })

  it('keeps the session route reported while it was not rendering a turn', async () => {
    // The route events are deliberately NOT gated: they describe the session and
    // stay useful for the turns that follow.
    const ch = channel()
    const { streaming, emit } = stepHarness(
      ch,
      { transcriptView: () => 'compact' as TranscriptView },
      { noTurnStart: true, sessionMeta: () => ({ model: 'p/m', reasoningEffort: 'high' }) },
    )
    emit('request/header', { header: { config: { provider: 'cpa-codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' } } })
    emit('turn/start')
    emit('step/start', { turn: 1, step: 1 })
    emit('assistant/chunk', { chunk: { type: 'text-delta', text: 'answer' } })
    emit('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } })
    await vi.waitFor(() => expect(ch.createCardInstance).toHaveBeenCalled())
    await tick(20)
    emit('turn/end', { reason: { kind: 'completed' } })
    await vi.waitFor(() => {
      const writes = [
        ...ch.createCardInstance!.mock.calls.map(call => call[0] as any),
        ...ch.updateCardInstance!.mock.calls.map(call => call[1] as any),
      ]
      expect(writes.some(card => mdOf(card).includes('💡 xhigh'))).toBe(true)
    })
    streaming.stop()
  })
})
