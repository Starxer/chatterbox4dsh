import { describe, expect, it } from 'vitest'
import {
  createPanelSender,
  formatDuration,
  PANEL_MAX_ROWS,
  PANEL_ROW_TTL_MS,
  renderTable,
  replyOptsForChat,
  tableCell,
  type PanelSnapshot,
} from '../src/feishu-panel.ts'

/** A snapshot whose fingerprint and chat the test controls. */
function snapshot(overrides: Partial<PanelSnapshot> = {}): PanelSnapshot {
  return {
    card: { schema: '2.0', header: { title: { tag: 'plain_text', content: 'panel' } } },
    signature: 'sig-1',
    chat: { chatId: 'oc_1', chatType: 'p2p' as const },
    ...overrides,
  }
}

function harness(options: {
  build?: (key: string) => PanelSnapshot | undefined
  debounceMs?: number
  refreshMs?: number
  failSends?: number[]
} = {}) {
  const sent: Array<{ to: string; card: any; opts: any }> = []
  const warns: string[] = []
  let attempts = 0
  const failSends = new Set(options.failSends ?? [])
  const sender = createPanelSender({
    channel: {
      send: async (to, input, opts) => {
        attempts += 1
        if (failSends.has(attempts)) throw new Error('feishu unreachable')
        sent.push({ to, card: input.card, opts })
        return { messageId: `m-${sent.length}` }
      },
    },
    logger: {
      info: () => undefined,
      warn: (message: string) => { warns.push(message); return undefined },
      error: () => undefined,
    },
    build: options.build ?? (() => snapshot()),
    debounceMs: options.debounceMs ?? 0,
    refreshMs: options.refreshMs ?? 0,
  })
  return { sender, sent, warns, attempts: () => attempts }
}

describe('tableCell', () => {
  it('collapses whitespace and caps the length', () => {
    expect(tableCell('a\n  b\tc')).toBe('a b c')
    expect(tableCell('abcdef', { max: 4 })).toBe('abc…')
    expect(tableCell('ab', { max: 4 })).toBe('ab')
  })

  it('escapes a pipe outside a code span and swaps it inside one', () => {
    // A backslash escape is right in prose, but markdown does not process it
    // inside a code span — hence the fullwidth bar there.
    expect(tableCell('a|b')).toBe('a\\|b')
    expect(tableCell('a|b', { code: true })).toBe('`a｜b`')
  })

  it('uses a double-backtick span when the text itself has a backtick', () => {
    expect(tableCell('say `hi`', { code: true })).toBe('`` say `hi` ``')
  })
})

describe('renderTable', () => {
  it('renders headers, the separator, and every row', () => {
    expect(renderTable(['a', 'b'], [['1', '2'], ['3', '4']])).toBe([
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '| 3 | 4 |',
    ].join('\n'))
  })
})

describe('formatDuration', () => {
  it('formats across the unit boundaries', () => {
    expect(formatDuration(820)).toBe('820ms')
    expect(formatDuration(4_300)).toBe('4.3s')
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})

describe('replyOptsForChat', () => {
  it('replies into the topic root when the chat is a topic', () => {
    expect(replyOptsForChat({ chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', rootId: 'om_root' }))
      .toEqual({ replyInThread: true, replyTo: 'om_root' })
    expect(replyOptsForChat({ chatId: 'oc_1', chatType: 'group', threadId: 'omt_1' }))
      .toEqual({ replyInThread: true })
  })

  it('sends a plain message for a chat without topics', () => {
    expect(replyOptsForChat({ chatId: 'oc_1', chatType: 'p2p' })).toEqual({})
  })
})

describe('createPanelSender', () => {
  it('sends the first snapshot of a chat without waiting for any window', async () => {
    const h = harness({ debounceMs: 5_000, refreshMs: 5_000 })
    h.sender.refresh('chat:oc_1', false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(1)
    h.sender.dispose()
  })

  it('coalesces a burst of triggers into one card that shows every row', async () => {
    let rows = 0
    const h = harness({
      debounceMs: 20,
      build: () => snapshot({ signature: `rows-${rows}`, card: { schema: '2.0', rows } }),
    })
    // The first trigger is immediate; the next three land inside the window
    // and must render ONCE, at flush time, with all four rows.
    h.sender.refresh('chat:oc_1', true)
    await new Promise(resolve => setTimeout(resolve, 30))
    for (let i = 0; i < 3; i++) {
      rows += 1
      h.sender.refresh('chat:oc_1', true)
    }
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]!.card.rows).toBe(3)
    h.sender.dispose()
  })

  it('never pushes a pending flush later, so a chatty source still gets a card', async () => {
    // The regression a resetting debounce causes (关键坑 12): triggers arriving
    // faster than the window would move the deadline forever.
    let rows = 0
    const h = harness({ debounceMs: 40, build: () => snapshot({ signature: `s-${rows}`, card: { schema: '2.0', rows } }) })
    h.sender.refresh('chat:oc_1', true)
    await new Promise(resolve => setTimeout(resolve, 60))
    const keepTicking = setInterval(() => {
      rows += 1
      h.sender.refresh('chat:oc_1', false)
    }, 5)
    await new Promise(resolve => setTimeout(resolve, 120))
    clearInterval(keepTicking)
    expect(h.sent.length).toBeGreaterThanOrEqual(2)
    h.sender.dispose()
  })

  it('holds a non-urgent snapshot behind the refresh floor but lets an urgent one through', async () => {
    let signature = 'sig-1'
    const h = harness({ debounceMs: 0, refreshMs: 60_000, build: () => snapshot({ signature, card: { schema: '2.0', sig: signature } }) })
    h.sender.refresh('chat:oc_1', true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.sent).toHaveLength(1)
    // A progress-only change must wait for the floor…
    signature = 'sig-2'
    h.sender.refresh('chat:oc_1', false)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(h.sent).toHaveLength(1)
    // …while a roster change is not throttled.
    signature = 'sig-3'
    h.sender.refresh('chat:oc_1', true)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(h.sent).toHaveLength(2)
    expect((h.sent[1]!.card as any).sig).toBe('sig-3')
    h.sender.dispose()
  })

  it('drops a snapshot whose fingerprint was already delivered', async () => {
    let builds = 0
    const h = harness({ build: () => { builds += 1; return snapshot() } })
    h.sender.refresh('chat:oc_1', true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(1)
    h.sender.refresh('chat:oc_1', true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(1)
    expect(builds).toBe(2)
    h.sender.dispose()
  })

  it('sends nothing when the roster has nothing to show', async () => {
    const h = harness({ build: () => undefined })
    h.sender.refresh('chat:oc_1', true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    h.sender.dispose()
  })

  it('retries a failed send on the next trigger and warns once', async () => {
    const h = harness({ failSends: [1] })
    h.sender.refresh('chat:oc_1', true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    expect(h.warns.some(line => line.includes('panel card send failed'))).toBe(true)
    // The fingerprint was never recorded, so the same snapshot is retried.
    h.sender.refresh('chat:oc_1', true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(1)
    h.sender.dispose()
  })

  it('contains a throwing renderer instead of taking the panel down', async () => {
    const h = harness({ build: () => { throw new Error('render exploded') } })
    h.sender.refresh('chat:oc_1', true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    expect(h.warns.some(line => line.includes('panel snapshot build failed'))).toBe(true)
    h.sender.dispose()
  })

  it('keeps one chat’s sends in order and independent from another chat', async () => {
    const order: string[] = []
    let version = 0
    const sender = createPanelSender({
      channel: {
        send: async (to, input) => {
          order.push(`${to}:${(input.card as any).version}`)
          await new Promise(resolve => setTimeout(resolve, 5))
          return {}
        },
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      build: key => snapshot({
        signature: `${key}-${version}`,
        chat: { chatId: key === 'a' ? 'oc_a' : 'oc_b', chatType: 'p2p' },
        card: { schema: '2.0', version },
      }),
      debounceMs: 0,
      refreshMs: 0,
    })
    sender.refresh('a', true)
    await new Promise(resolve => setTimeout(resolve, 30))
    version = 1
    sender.refresh('a', true)
    sender.refresh('b', true)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(order.filter(entry => entry.startsWith('oc_a'))).toEqual(['oc_a:0', 'oc_a:1'])
    expect(order).toContain('oc_b:1')
    sender.dispose()
  })

  it('stops sending after dispose', async () => {
    const h = harness({ debounceMs: 50 })
    h.sender.refresh('chat:oc_1', false)
    h.sender.dispose()
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(h.sent).toHaveLength(0)
  })
})

describe('panel constants', () => {
  it('bound the roster a card and this process carry', () => {
    expect(PANEL_MAX_ROWS).toBeGreaterThan(0)
    expect(PANEL_ROW_TTL_MS).toBeGreaterThan(PANEL_MAX_ROWS)
  })
})
