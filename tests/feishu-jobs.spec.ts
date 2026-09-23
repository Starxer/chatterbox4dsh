import { describe, expect, it, vi } from 'vitest'
import {
  detachedJobIdFromToolResult,
  formatDuration,
  renderJobCard,
  startFeishuJobs,
  type DetachedJobNotice,
  type JobEventLike,
  type JobViewLike,
} from '../src/feishu-jobs.ts'
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
  const infos: string[] = []
  let sendAttempts = 0
  // Topic coordinates: a card sent into a topic must carry replyTo (关键坑 25).
  const chat = { chatId: 'oc_1', chatType: 'p2p' as const, threadId: 'omt_1', rootId: 'om_root' }
  const mirror = startFeishuJobs({
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
    logger: {
      info: (message: string) => { infos.push(message); return undefined },
      warn: (message: string) => { warns.push(message); return undefined },
      error: () => undefined,
    },
    getTranslations: () => zh,
    // Zero by default: every event flushes on the microtask chain, so the tests
    // never race a timer. The coalescing tests below opt into a real window.
    debounceMs: options.debounceMs ?? 0,
  })
  /** The tool result that hands the model a background job handle. */
  const notice = (jobId: string, overrides: Partial<DetachedJobNotice> = {}): DetachedJobNotice => ({
    toolName: 'bash',
    resultText: `started background job ${jobId}`,
    chat,
    sessionId: 'session-1',
    ...overrides,
  })
  return {
    mirror,
    sent,
    updates,
    warns,
    infos,
    chat,
    emit: (event: JobEventLike) => { for (const listener of [...listeners]) listener(event) },
    confirm: (jobId: string, overrides: Partial<DetachedJobNotice> = {}) => mirror.noteDetached(notice(jobId, overrides)),
    listenerCount: () => listeners.size,
  }
}

describe('detachedJobIdFromToolResult', () => {
  it('recovers the id from every producer sentence', () => {
    // The literal texts each tool renders (packages/*/src/index.ts).
    expect(detachedJobIdFromToolResult('bash', 'started background job bash-7')).toBe('bash-7')
    expect(detachedJobIdFromToolResult('pwsh', 'started background job pwsh-2')).toBe('pwsh-2')
    expect(detachedJobIdFromToolResult('terminal_send', 'started background job pty-send-3')).toBe('pty-send-3')
    expect(detachedJobIdFromToolResult('subagent', 'started background subagent job subagent-2')).toBe('subagent-2')
    expect(detachedJobIdFromToolResult(
      'workflow',
      'workflow "audit" started in the background as job workflow-1. Its return value arrives with the completion notice; check on it with job_output, stop it with job_kill.',
    )).toBe('workflow-1')
  })

  it('recovers the id from a foreground call promoted to the background', () => {
    // tool-bash / tool-pwsh append this bracket line AFTER the output produced
    // so far, so it is the one sentence allowed below the first line.
    const promoted = 'building…\n12 tests passed\n'
      + '[still running after 30000ms; moved to background job bash-8]\n'
      + 'The command keeps running in the background. You will be notified when it finishes; '
      + 'read newer output with job_output, stop it with job_kill.'
    expect(detachedJobIdFromToolResult('bash', promoted)).toBe('bash-8')
    expect(detachedJobIdFromToolResult('pwsh', promoted)).toBe('bash-8')
    // Only a whole line counts.
    expect(detachedJobIdFromToolResult('bash', 'see [still running after 30ms; moved to background job bash-8] above')).toBeUndefined()
    // A tool that cannot promote must not claim it.
    expect(detachedJobIdFromToolResult('terminal_send', promoted)).toBeUndefined()
  })

  it('ignores an ordinary foreground result', () => {
    expect(detachedJobIdFromToolResult('bash', 'total 12\ndrwxr-xr-x 2 user user 4096')).toBeUndefined()
    expect(detachedJobIdFromToolResult('bash', 'exit code: 0')).toBeUndefined()
    expect(detachedJobIdFromToolResult('bash', '')).toBeUndefined()
  })

  it('ignores the sentence coming from a tool that cannot start a job', () => {
    // `job_output` prints a job's own output, which can quote the announcement.
    expect(detachedJobIdFromToolResult('job_output', 'started background job bash-7')).toBeUndefined()
  })

  it('only reads the first non-empty line', () => {
    expect(detachedJobIdFromToolResult('bash', '\n\nstarted background job bash-7')).toBe('bash-7')
    // A file catted by bash may contain the sentence further down.
    expect(detachedJobIdFromToolResult('bash', 'build log:\nstarted background job bash-7')).toBeUndefined()
  })

  it('requires the whole line to be the announcement', () => {
    expect(detachedJobIdFromToolResult('bash', 'started background job bash-7 (promoted)')).toBeUndefined()
    expect(detachedJobIdFromToolResult('bash', 'started background job not-an-id')).toBeUndefined()
    expect(detachedJobIdFromToolResult('bash', 'started background subagent job bash-7')).toBeUndefined()
  })
})

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
  it('posts nothing for a foreground call, which DSH also registers as a job', async () => {
    // The regression that motivated the gate (关键坑 37): every foreground
    // `bash` call is a job, and mirroring those put one extra card beside every
    // tool call. No tool result announced a handle here, so nothing may appear.
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.emit({ type: 'progress', job: job({ progress: '1/2' }) })
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 4_000 }) })
    h.emit({ type: 'removed', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
    expect(h.warns).toHaveLength(0)
    h.mirror.dispose()
  })

  it('posts one card into the announced chat once the result confirms a detached job', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    expect(h.sent[0]!.to).toBe('oc_1')
    expect(h.sent[0]!.card.header.title.content).toContain('npm run build')
    // Topic coordinates come from the session that saw the tool result (关键坑 25/31).
    expect(h.sent[0]!.opts).toEqual({ replyInThread: true, replyTo: 'om_root' })
    h.mirror.dispose()
  })

  it('builds the first card from the projection cached before the confirmation', async () => {
    // The result lands after `registered` and possibly after `progress`, so the
    // card must render the LATEST known projection, not the registration one.
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.emit({ type: 'progress', job: job({ progress: '3/10' }) })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    expect(markdownOf(h.sent[0]!.card)).toContain('3/10')
    h.mirror.dispose()
  })

  it('updates the same card on progress instead of posting another', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'progress', job: job({ progress: '3/10' }) })
    await vi.waitFor(() => { expect(h.updates).toHaveLength(1) })
    expect(h.sent).toHaveLength(1)
    expect(h.updates[0]!.messageId).toBe('m-1')
    expect(markdownOf(h.updates[0]!.card)).toContain('3/10')
    h.mirror.dispose()
  })

  it.each([
    ['completed', 'green', zh.jobStatusCompleted],
    ['failed', 'red', zh.jobStatusFailed],
    ['killed', 'grey', zh.jobStatusKilled],
  ] as const)('renders the %s terminal state on the existing card', async (status, template, statusText) => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
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
    h.mirror.dispose()
  })

  it('keeps the terminal card when the job leaves the visible set', async () => {
    // `removed` follows `settled`, so the card already carries the outcome.
    // Rewriting it into a grey "stale" shell destroyed that record and pointed
    // at a newer card that never existed (2026-09-23).
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await vi.waitFor(() => { expect(h.updates).toHaveLength(1) })
    h.emit({ type: 'removed', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]!.card.header.template).toBe('green')
    expect(markdownOf(h.updates[0]!.card)).toContain(zh.jobStatusCompleted)
    h.mirror.dispose()
  })

  it('stays silent when a result names a job the registry never announced', async () => {
    const h = buildHarness()
    h.confirm('bash-404')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    expect(h.infos.some(line => line.includes('bash-404'))).toBe(true)
    h.mirror.dispose()
  })

  it('refuses a job whose owner is not the session that announced it', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job({ owner: 'session-2' }) })
    h.confirm('bash-1', { sessionId: 'session-1' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    expect(h.warns.some(line => line.includes('belongs to session-2'))).toBe(true)
    h.mirror.dispose()
  })

  it('does not post a second card when the same result is seen twice or registered repeats', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'registered', job: job() })
    await vi.waitFor(() => { expect(h.updates).toHaveLength(1) })
    expect(h.sent).toHaveLength(1)
    h.mirror.dispose()
  })

  it('sends nothing after dispose', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.mirror.dispose()
    expect(h.listenerCount()).toBe(0)
    h.emit({ type: 'progress', job: job({ progress: '9/9' }) })
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 5_000 }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.updates).toHaveLength(0)
  })

  it('survives a failed send and still posts on the next event', async () => {
    const h = buildHarness({ failFirstSend: true })
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.warns).toHaveLength(1) })
    expect(h.warns[0]).toContain('job card send failed')
    h.emit({ type: 'progress', job: job({ progress: '1/2' }) })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    expect(h.sent[0]!.card.header.title.content).toContain('npm run build')
    h.mirror.dispose()
  })

  it('posts the confirming card without waiting for the coalescing window', async () => {
    // A job whose progress changes faster than the window resets the timer on
    // every event. If the first card were debounced too, such a job would stay
    // invisible until it went quiet — so the first send must bypass the window
    // while the update behind it still waits.
    const h = buildHarness({ debounceMs: 5_000 })
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'progress', job: job({ progress: '1/9' }) })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(h.updates).toHaveLength(0)
    h.mirror.dispose()
  })

  it('coalesces a burst of progress into a single update', async () => {
    const h = buildHarness({ debounceMs: 30 })
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    for (let i = 1; i <= 20; i++) h.emit({ type: 'progress', job: job({ progress: `${i}/20` }) })
    await vi.waitFor(() => { expect(h.updates).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(h.updates).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
    h.mirror.dispose()
  })
})
