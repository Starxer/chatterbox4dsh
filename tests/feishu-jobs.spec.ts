import { describe, expect, it, vi } from 'vitest'
import { formatDuration, renderJobCard, startFeishuJobs, type JobEventLike, type JobViewLike } from '../src/feishu-jobs.ts'
import { en, zh } from '../src/i18n.ts'

/** One job projection with only the fields a test cares about overridden. */
function job(overrides: Partial<JobViewLike> = {}): JobViewLike {
  return {
    id: 'bash-1',
    kind: 'bash',
    label: 'npm run build',
    owner: 'session-1',
    status: 'running',
    startedAt: 1_000,
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

function buildHarness(options: { failFirstSend?: boolean; debounceMs?: number } = {}) {
  const listeners = new Set<(event: JobEventLike) => void>()
  const sent: Array<{ to: string; card: any; opts: any }> = []
  const updates: Array<{ messageId: string; card: any }> = []
  const warns: string[] = []
  let sendAttempts = 0
  // Topic coordinates: a card sent into a topic must carry replyTo (关键坑 25).
  const chat = { chatId: 'oc_1', chatType: 'p2p' as const, threadId: 'omt_1', rootId: 'om_root' }
  const stop = startFeishuJobs({
    jobs: {
      events: {
        subscribe: (_filter, listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    channel: {
      send: async (to, input, opts) => {
        sendAttempts += 1
        if (options.failFirstSend === true && sendAttempts === 1) throw new Error('feishu unreachable')
        sent.push({ to, card: input.card, opts })
        return { messageId: `m-${sent.length}` }
      },
      updateCard: async (messageId, card) => { updates.push({ messageId, card }) },
    },
    bridgeHolder: {
      current: { resolveChat: (id: string) => (id === 'session-1' ? chat : undefined) } as any,
    },
    logger: {
      info: () => undefined,
      warn: (message: string) => { warns.push(message); return undefined },
      error: () => undefined,
    },
    getTranslations: () => zh,
    // Zero by default: every event flushes on the microtask chain, so the tests
    // never race a timer. The coalescing tests below opt into a real window.
    debounceMs: options.debounceMs ?? 0,
  })
  return {
    stop,
    sent,
    updates,
    warns,
    chat,
    emit: (event: JobEventLike) => { for (const listener of [...listeners]) listener(event) },
    listenerCount: () => listeners.size,
  }
}

describe('renderJobCard', () => {
  it('titles the card with the producer label and shows kind, id and elapsed time', () => {
    const card = renderJobCard(job(), zh, 5_300) as any
    expect(card.header.title.content).toContain('npm run build')
    expect(card.header.template).toBe('wathet')
    expect(markdownOf(card)).toContain(zh.jobStatusRunning)
    expect(markdownOf(card)).toContain('`bash`')
    expect(markdownOf(card)).toContain('`bash-1`')
    expect(markdownOf(card)).toContain('4.3s')
  })

  it('falls back to the untitled label for a nameless job', () => {
    expect((renderJobCard(job({ label: '   ' }), en, 2_000) as any).header.title.content).toContain(en.jobUntitled)
  })

  it('renders the whole card in the active locale', () => {
    const card = renderJobCard(job({ status: 'failed', detail: 'exit code: 3', finishedAt: 3_000 }), en, 9_000) as any
    expect(card.header.template).toBe('red')
    expect(markdownOf(card)).toContain(en.jobStatusFailed)
    expect(markdownOf(card)).toContain(en.jobDetailLabel)
    expect(markdownOf(card)).not.toContain(zh.jobStatusFailed)
  })

  it('hides the progress line once the job settled', () => {
    const running = markdownOf(renderJobCard(job({ progress: '3/10' }), zh, 2_000) as any)
    expect(running).toContain('3/10')
    const settled = markdownOf(renderJobCard(job({ status: 'completed', progress: '3/10', finishedAt: 2_000 }), zh, 9_000) as any)
    expect(settled).not.toContain('3/10')
  })

  it('formats durations across the unit boundaries', () => {
    expect(formatDuration(820)).toBe('820ms')
    expect(formatDuration(4_300)).toBe('4.3s')
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatDuration(-1)).toBe('—')
  })
})

describe('startFeishuJobs', () => {
  it('posts one card into the owning chat when a job is registered', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    expect(h.sent[0]!.to).toBe('oc_1')
    expect(h.sent[0]!.card.header.title.content).toContain('npm run build')
    // Topic coordinates come from the bridge, never guessed from the chat (关键坑 31).
    expect(h.sent[0]!.opts).toEqual({ replyInThread: true, replyTo: 'om_root' })
    h.stop()
  })

  it('updates the same card on progress instead of posting another', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'progress', job: job({ progress: '3/10' }) })
    await vi.waitFor(() => { expect(h.updates).toHaveLength(1) })
    expect(h.sent).toHaveLength(1)
    expect(h.updates[0]!.messageId).toBe('m-1')
    expect(markdownOf(h.updates[0]!.card)).toContain('3/10')
    h.stop()
  })

  it.each([
    ['completed', 'green', zh.jobStatusCompleted],
    ['failed', 'red', zh.jobStatusFailed],
    ['killed', 'grey', zh.jobStatusKilled],
  ] as const)('renders the %s terminal state on the existing card', async (status, template, statusText) => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    const settled = status === 'failed'
      ? job({ status, detail: 'exit code: 3', finishedAt: 4_000 })
      : job({ status, finishedAt: 4_000 })
    h.emit({ type: 'settled', job: settled })
    await vi.waitFor(() => { expect(h.updates).toHaveLength(1) })
    expect(h.sent).toHaveLength(1)
    expect(h.updates[0]!.card.header.template).toBe(template)
    expect(markdownOf(h.updates[0]!.card)).toContain(statusText)
    if (status === 'failed') expect(markdownOf(h.updates[0]!.card)).toContain('exit code: 3')
    h.stop()
  })

  it('stays silent for a job whose session nobody talks to from Feishu', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job({ owner: 'session-2' }) })
    h.emit({ type: 'progress', job: job({ owner: 'session-2', progress: '1/2' }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
    h.stop()
  })

  it('stays silent for an unowned job', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: { id: 'bash-9', kind: 'bash', label: 'unowned', status: 'running', startedAt: 1 } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    h.stop()
  })

  it('does not post a second card when the registry repeats registered', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.updates).toHaveLength(1) })
    expect(h.sent).toHaveLength(1)
    h.stop()
  })

  it('retires the card when the job leaves the visible set', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'removed', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await vi.waitFor(() => { expect(h.updates).toHaveLength(1) })
    expect(h.updates[0]!.card.header.template).toBe('grey')
    expect(h.updates[0]!.card.header.title.content).toBe(zh.cardSupersededTitle)
    h.stop()
  })

  it('sends nothing after dispose', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.stop()
    expect(h.listenerCount()).toBe(0)
    h.emit({ type: 'progress', job: job({ progress: '9/9' }) })
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 5_000 }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.updates).toHaveLength(0)
  })

  it('survives a failed send and still posts on the next event', async () => {
    const h = buildHarness({ failFirstSend: true })
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.warns).toHaveLength(1) })
    expect(h.warns[0]).toContain('job card send failed')
    h.emit({ type: 'progress', job: job({ progress: '1/2' }) })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    expect(h.sent[0]!.card.header.title.content).toContain('npm run build')
    h.stop()
  })

  it('posts the first card without waiting for the coalescing window', async () => {
    // A job whose progress changes faster than the window resets the timer on
    // every event. If the first card were debounced too, such a job would stay
    // invisible until it went quiet — so the first send must bypass the window
    // while the update behind it still waits.
    const h = buildHarness({ debounceMs: 5_000 })
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'progress', job: job({ progress: '1/9' }) })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(h.updates).toHaveLength(0)
    h.stop()
  })

  it('coalesces a burst of progress into a single update', async () => {
    const h = buildHarness({ debounceMs: 30 })
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    for (let i = 1; i <= 20; i++) h.emit({ type: 'progress', job: job({ progress: `${i}/20` }) })
    await vi.waitFor(() => { expect(h.updates).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(h.updates).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
    h.stop()
  })
})
