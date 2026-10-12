import { describe, expect, it, vi } from 'vitest'
import {
  parseSubagentLifecycle,
  renderSubagentPanelCard,
  startFeishuSubagents,
  subagentRosterSignature,
  treeOrder,
  treePrefixes,
  type SubagentPanelRow,
} from '../src/feishu-subagents.ts'
import { PANEL_MAX_ROWS } from '../src/feishu-panel.ts'
import type { ConversationMessage } from '../src/conversation.ts'
import { en, zh } from '../src/i18n.ts'

/** One roster row with only the fields a test cares about overridden. */
function row(overrides: Partial<SubagentPanelRow> = {}): SubagentPanelRow {
  return {
    id: 'child-1',
    createdAt: 1_000,
    mode: 'one-shot',
    label: 'audit the parser',
    model: '',
    depth: 1,
    parentId: undefined,
    state: 'running',
    epochStart: 1_000,
    epochMs: undefined,
    stopReason: undefined,
    settledAt: undefined,
    ...overrides,
  }
}

/** The card's markdown text, so assertions read like the rendered output. */
function markdownOf(card: any): string {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    .join('\n')
}

/** One catalog payload as the Host appends it. */
function catalog(childId: string, overrides: Record<string, unknown> = {}) {
  return { type: 'subagent/catalog', data: { childId, childCreatedAt: 1_000, mode: 'one-shot', label: `task ${childId}`, ...overrides } }
}

function buildHarness(options: { chats?: Record<string, ConversationMessage>; debounceMs?: number; refreshMs?: number; routes?: Record<string, { provider?: string; model?: string }> } = {}) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const optionsSeen: Array<{ name: string; options: unknown }> = []
  const sent: Array<{ to: string; card: any; opts: any }> = []
  const warns: string[] = []
  const chats = options.chats ?? {
    'session-1': { chatId: 'oc_1', chatType: 'p2p' as const, threadId: 'omt_1', rootId: 'om_root' },
  }
  const ctx = {
    on: (name: string, listener: (...args: any[]) => void, opts?: unknown) => {
      let set = listeners.get(name)
      if (set === undefined) {
        set = new Set()
        listeners.set(name, set)
      }
      set.add(listener)
      optionsSeen.push({ name, options: opts })
      return () => { set.delete(listener) }
    },
  }
  const stop = startFeishuSubagents({
    ctx: ctx as never,
    channel: {
      send: async (to, input, opts) => {
        sent.push({ to, card: input.card, opts })
        return { messageId: `m-${sent.length}` }
      },
    },
    bridgeHolder: { current: { resolveChat: sessionId => chats[sessionId] } },
    logger: {
      info: () => undefined,
      warn: (message: string) => { warns.push(message); return undefined },
      error: () => undefined,
    },
    getTranslations: () => zh,
    // The host's "what is this child actually running" reader. Tests pass a map;
    // production reads the live session's cached `request/context` fold.
    readChildRoute: id => options.routes?.[id],
    debounceMs: options.debounceMs ?? 0,
    refreshMs: options.refreshMs ?? 0,
  })
  return {
    stop,
    sent,
    warns,
    ctx,
    optionsSeen,
    sessionEvent: (sessionId: string, event: unknown) => {
      for (const listener of [...(listeners.get('session/event') ?? [])]) listener({ id: sessionId }, event)
    },
    lifecycle: (name: 'subagent/start' | 'subagent/end', info: unknown) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(info)
    },
    listenerCount: (name: string) => listeners.get(name)?.size ?? 0,
  }
}

describe('parseSubagentLifecycle', () => {
  it('reads the child id and the stop reason', () => {
    expect(parseSubagentLifecycle({ id: 'child-1', runId: 'r1', stopReason: 'completed' }))
      .toEqual({ id: 'child-1', stopReason: 'completed' })
    expect(parseSubagentLifecycle({ id: 'child-1' })).toEqual({ id: 'child-1', stopReason: undefined })
  })

  it('rejects a payload with no usable id', () => {
    expect(parseSubagentLifecycle(undefined)).toBeUndefined()
    expect(parseSubagentLifecycle(null)).toBeUndefined()
    expect(parseSubagentLifecycle('child-1')).toBeUndefined()
    expect(parseSubagentLifecycle({ id: '' })).toBeUndefined()
    expect(parseSubagentLifecycle({ id: 7 })).toBeUndefined()
  })
})

describe('renderSubagentPanelCard', () => {
  it('titles the card with the fixed panel title and lists the agent', () => {
    const card = renderSubagentPanelCard([row()], zh, 4_000) as any
    expect(card.header.title.content).toBe(zh.subagentPanelTitle)
    expect(card.header.template).toBe('turquoise')
    const text = markdownOf(card)
    expect(text).toContain(zh.subagentPanelSummary(1, 1))
    expect(text).toContain(zh.subagentStatusRunning)
    expect(text).toContain('`audit the parser`')
    expect(text).toContain('`child-1`')
    expect(text).toContain(zh.subagentModeOneShot)
    expect(text).toContain('3.0s')
  })

  it('maps every terminal stop reason to its own state', () => {
    const cases = [
      ['completed', en.subagentStatusCompleted],
      ['error', en.subagentStatusFailed],
      ['aborted', en.subagentStatusAborted],
      ['refusal', en.subagentStatusRefused],
      ['max-tokens', en.subagentStatusMaxTokens],
      ['something-new', en.subagentStatusInactive],
    ] as const
    for (const [stopReason, text] of cases) {
      const settled = row({ state: 'inactive', stopReason, epochMs: 2_000, settledAt: 3_000 })
      expect(markdownOf(renderSubagentPanelCard([settled], en, 9_000) as any)).toContain(text)
    }
  })

  it('draws a grandchild as a tree child of the row above it', () => {
    const text = markdownOf(renderSubagentPanelCard([
      row(),
      row({ id: 'child-2', createdAt: 2_000, depth: 2, parentId: 'child-1' }),
    ], zh, 5_000) as any)
    // A drawn connector, not leading spaces: Feishu collapsed the indent.
    expect(text).toContain('└─ `audit the parser`')
    expect(text).not.toContain('　')
    const dataRows = text.split('\n').filter(line => line.startsWith('| ') && !line.includes('---') && !line.includes(zh.subagentPanelColStatus))
    expect(dataRows).toHaveLength(2)
    // The parent comes first, the child directly under it.
    expect(dataRows[0]!.indexOf('audit the parser')).toBeGreaterThan(-1)
    expect(dataRows[1]!.indexOf('└─ ')).toBeGreaterThan(-1)
  })

  it('nests siblings and deeper levels with the right connectors', () => {
    const rows = [
      row({ id: 'root-1', label: 'root one', createdAt: 1_000 }),
      row({ id: 'root-2', label: 'root two', createdAt: 1_100 }),
      row({ id: 'kid-a', label: 'kid a', createdAt: 2_000, depth: 2, parentId: 'root-1' }),
      row({ id: 'kid-b', label: 'kid b', createdAt: 2_100, depth: 2, parentId: 'root-1' }),
      row({ id: 'grand-1', label: 'grand one', createdAt: 3_000, depth: 3, parentId: 'kid-a' }),
    ]
    const text = markdownOf(renderSubagentPanelCard(rows, en, 9_000) as any)
    const cell = (label: string): string => text.split('\n').find(line => line.includes(label)) ?? ''
    expect(cell('root one')).toContain('| `root one` |')
    expect(cell('kid a')).toContain('├─ `kid a`')
    expect(cell('grand one')).toContain('│  └─ `grand one`')
    expect(cell('kid b')).toContain('└─ `kid b`')
    expect(cell('root two')).toContain('| `root two` |')
    // Tree order: parent, its subtree, then the next root.
    const order = ['root one', 'kid a', 'grand one', 'kid b', 'root two']
      .map(label => text.split('\n').findIndex(line => line.includes(label)))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('treats a row whose parent left the roster as a root', () => {
    const text = markdownOf(renderSubagentPanelCard([
      row({ id: 'kid-a', label: 'orphan', depth: 2, parentId: 'gone' }),
    ], en, 9_000) as any)
    expect(text).toContain('| `orphan` |')
    expect(text).not.toContain('└─')
  })

  it('falls back to the untitled label and the unknown mode', () => {
    const text = markdownOf(renderSubagentPanelCard([row({ label: '  ', mode: 'unknown' })], en, 2_000) as any)
    expect(text).toContain(en.subagentUntitled)
    expect(text).toContain(en.subagentModeUnknown)
  })

  it('caps the table and says how many older rows it left out', () => {
    const rows = Array.from({ length: PANEL_MAX_ROWS + 2 }, (_, index) =>
      row({ id: `child-${index + 1}`, createdAt: 1_000 + index }))
    const text = markdownOf(renderSubagentPanelCard(rows, zh, 99_000) as any)
    expect(text).toContain(zh.panelMoreRows(2))
    expect(text.split('\n').filter(line => line.startsWith('| ') && !line.includes('---') && !line.includes(zh.subagentPanelColStatus))).toHaveLength(PANEL_MAX_ROWS)
  })

  it('truncates a long session id so the table keeps its shape', () => {
    const long = 'lark-v2-0123456789abcdef0123456789abcdef01234567'
    const text = markdownOf(renderSubagentPanelCard([row({ id: long })], zh, 2_000) as any)
    expect(text).toContain('`lark-v2-01234…`')
    expect(text).not.toContain(long)
  })
})

describe('subagentRosterSignature', () => {
  it('ignores the clock but follows every visible fact', () => {
    expect(subagentRosterSignature([row()])).toBe(subagentRosterSignature([row({ epochStart: 9_999 })]))
    expect(subagentRosterSignature([row()])).not.toBe(subagentRosterSignature([row({ state: 'inactive' })]))
    expect(subagentRosterSignature([row()])).not.toBe(subagentRosterSignature([row({ label: 'other' })]))
  })
})

describe('startFeishuSubagents', () => {
  it('posts one panel card when a chat-bound parent registers a child', async () => {
    const h = buildHarness()
    h.sessionEvent('session-1', catalog('child-1', { label: 'audit the parser' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.to).toBe('oc_1')
    // Topic coordinates come from the parent session (关键坑 25/31).
    expect(h.sent[0]!.opts).toEqual({ replyInThread: true, replyTo: 'om_root' })
    expect(h.sent[0]!.card.header.title.content).toBe(zh.subagentPanelTitle)
    expect(markdownOf(h.sent[0]!.card)).toContain('`audit the parser`')
    h.stop()
  })

  it('ignores a catalog event for a session no chat is bound to', async () => {
    const h = buildHarness()
    h.sessionEvent('session-unknown', catalog('child-1'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    h.stop()
  })

  it('attributes a grandchild to the same chat, one level deeper', async () => {
    const h = buildHarness()
    h.sessionEvent('session-1', catalog('child-1'))
    await new Promise(resolve => setTimeout(resolve, 20))
    // The child session itself is not bound to a chat, but it is a known child.
    h.sessionEvent('child-1', catalog('grandchild-1', { label: 'verify the fix' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]!.to).toBe('oc_1')
    const text = markdownOf(h.sent[1]!.card)
    expect(text).toContain('└─ `verify the fix`')
    expect(text).toContain('└─ ')
    expect(text).toContain(zh.subagentPanelSummary(2, 2))
    h.stop()
  })

  it('posts a fresh card when the run settles, with the outcome and the duration', async () => {
    const h = buildHarness()
    h.sessionEvent('session-1', catalog('child-1'))
    await new Promise(resolve => setTimeout(resolve, 20))
    h.lifecycle('subagent/start', { id: 'child-1', runId: 'r1', provider: 'in-process' })
    h.lifecycle('subagent/end', { id: 'child-1', runId: 'r1', provider: 'in-process', stopReason: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(2)
    const text = markdownOf(h.sent[1]!.card)
    expect(text).toContain(zh.subagentStatusCompleted)
    expect(text).toContain(zh.subagentPanelSummary(0, 1))
    h.stop()
  })

  it('shows a continuable child running again when a new epoch starts', async () => {
    const h = buildHarness()
    h.sessionEvent('session-1', catalog('child-1', { mode: 'continuable' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    h.lifecycle('subagent/start', { id: 'child-1', runId: 'r1' })
    h.lifecycle('subagent/end', { id: 'child-1', runId: 'r1', stopReason: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(markdownOf(h.sent[1]!.card)).toContain(zh.subagentStatusCompleted)
    h.lifecycle('subagent/start', { id: 'child-1', runId: 'r2' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(3)
    const text = markdownOf(h.sent[2]!.card)
    expect(text).toContain(zh.subagentStatusRunning)
    expect(text).toContain(zh.subagentModeContinuable)
    h.stop()
  })

  it('ignores a lifecycle edge for a child it never saw registered', async () => {
    // A remote run appends no catalog event, so there is no chat to place it in.
    const h = buildHarness()
    h.lifecycle('subagent/start', { id: 'remote-1', runId: 'r1' })
    h.lifecycle('subagent/end', { id: 'remote-1', runId: 'r1', stopReason: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    h.stop()
  })

  it('does not duplicate a row when the catalog event repeats', async () => {
    const h = buildHarness()
    h.sessionEvent('session-1', catalog('child-1'))
    await new Promise(resolve => setTimeout(resolve, 20))
    h.sessionEvent('session-1', catalog('child-1'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(1)
    h.stop()
  })

  it('does not post again when nothing visible changed', async () => {
    const h = buildHarness()
    h.sessionEvent('session-1', catalog('child-1'))
    await new Promise(resolve => setTimeout(resolve, 20))
    // The start edge only refines the timing anchor, which the fingerprint
    // deliberately ignores.
    h.lifecycle('subagent/start', { id: 'child-1', runId: 'r1' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(1)
    h.stop()
  })

  it('keeps one panel per chat', async () => {
    const h = buildHarness({
      chats: {
        'session-1': { chatId: 'oc_1', chatType: 'p2p' as const },
        'session-2': { chatId: 'oc_2', chatType: 'p2p' as const },
      },
    })
    h.sessionEvent('session-1', catalog('child-1', { label: 'first task' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    h.sessionEvent('session-2', catalog('child-2', { label: 'second task' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]!.to).toBe('oc_2')
    expect(markdownOf(h.sent[1]!.card)).not.toContain('first task')
    expect(markdownOf(h.sent[0]!.card)).not.toContain('second task')
    h.stop()
  })

  it('subscribes to the lifecycle fan-out globally, so no scope filters it out', () => {
    const h = buildHarness()
    const lifecycle = h.optionsSeen.filter(entry => entry.name.startsWith('subagent/'))
    expect(lifecycle.map(entry => entry.name).sort()).toEqual(['subagent/end', 'subagent/start'])
    for (const entry of lifecycle) expect(entry.options).toEqual({ global: true })
    h.stop()
  })

  it('survives a malformed event instead of taking the fan-out down', async () => {
    const h = buildHarness()
    h.sessionEvent('session-1', { type: 'subagent/catalog', data: null })
    h.sessionEvent('session-1', { type: 'subagent/catalog' })
    h.lifecycle('subagent/start', null)
    h.lifecycle('subagent/end', 'nonsense')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    expect(h.warns).toHaveLength(0)
    h.stop()
  })

  it('shows the model the child session reported, and leaves it blank until then', async () => {
    const h = buildHarness()
    h.sessionEvent('session-1', catalog('child-1'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(markdownOf(h.sent[0]!.card)).toContain('| — |')
    // The child's own route metadata states the model.
    h.sessionEvent('child-1', { type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } })
    h.lifecycle('subagent/end', { id: 'child-1', runId: 'r1', stopReason: 'completed' })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(2) })
    const text = markdownOf(h.sent[1]!.card)
    // Provider and model travel together, so two children on different routes to
    // the same model are still tellable apart.
    expect(text).toContain('`deepseek/deepseek-chat`')
    expect(text).toContain(zh.subagentPanelColModel)
    h.stop()
  })

  it('shows the route of a RESUMED child that emits no request/context at all', async () => {
    // 关键坑 67: DSH appends `request/context` only when the route CHANGES, so a
    // continuable subagent that is resumed on the same route never emits one —
    // the row used to sit at `—` forever, even after the run finished. The host
    // can be asked directly, so it is asked when the row is created.
    const h = buildHarness({ routes: { 'child-1': { provider: 'cpa-codex', model: 'gpt-6.1-sol' } } })
    h.sessionEvent('session-1', catalog('child-1'))
    h.lifecycle('subagent/end', { id: 'child-1', runId: 'r1', stopReason: 'completed' })
    // Both events coalesce into ONE card, and that first card already names the
    // route: the row was seeded when it was created, not patched up later.
    await vi.waitFor(() => { expect(h.sent.length).toBeGreaterThan(0) })
    const text = markdownOf(h.sent.at(-1)!.card)
    expect(text).toContain('`cpa-codex/gpt-6.1-sol`')
    expect(text).not.toContain('| — |')
    h.stop()
  })

  it('waits for the session to become resident before giving up on the route', async () => {
    // The catalog can arrive before the host can answer for the child; the next
    // card that CAN carry the route must carry it.
    const routes: Record<string, { provider?: string; model?: string }> = {}
    const h = buildHarness({ routes })
    h.sessionEvent('session-1', catalog('child-1'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(markdownOf(h.sent[0]!.card)).toContain('| — |')
    routes['child-1'] = { provider: 'minimax-cn', model: 'MiniMax-M3' }
    h.lifecycle('subagent/end', { id: 'child-1', runId: 'r1', stopReason: 'completed' })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(2) })
    expect(markdownOf(h.sent.at(-1)!.card)).toContain('`minimax-cn/MiniMax-M3`')
    h.stop()
  })

  it('ignores route metadata for a session it does not track, and malformed payloads', async () => {
    const h = buildHarness()
    h.sessionEvent('session-1', catalog('child-1'))
    await new Promise(resolve => setTimeout(resolve, 20))
    h.sessionEvent('stranger', { type: 'request/context', data: { provider: 'x', model: 'other-model' } })
    h.sessionEvent('child-1', { type: 'request/context', data: null })
    h.sessionEvent('child-1', { type: 'request/context', data: { model: 42 } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(1)
    expect(markdownOf(h.sent[0]!.card)).not.toContain('other-model')
    expect(h.warns).toHaveLength(0)
    h.stop()
  })

  it('unsubscribes everything on dispose', async () => {
    const h = buildHarness()
    h.stop()
    expect(h.listenerCount('session/event')).toBe(0)
    expect(h.listenerCount('subagent/start')).toBe(0)
    expect(h.listenerCount('subagent/end')).toBe(0)
    h.sessionEvent('session-1', catalog('child-1'))
    h.lifecycle('subagent/end', { id: 'child-1', runId: 'r1', stopReason: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
  })
})
