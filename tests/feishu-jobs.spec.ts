import { describe, expect, it, vi } from 'vitest'
import {
  detachedJobIdFromToolResult,
  jobRosterSignature,
  renderJobPanelCard,
  startFeishuJobs,
  type DetachedJobNotice,
  type JobEventLike,
  type JobPanelRow,
  type JobViewLike,
} from '../src/feishu-jobs.ts'
import { PANEL_MAX_ROWS } from '../src/feishu-panel.ts'
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

/** One roster row for the renderer tests. */
function row(overrides: Partial<JobViewLike> = {}, settledAt: number | undefined = undefined): JobPanelRow {
  return { view: job(overrides), settledAt }
}

/** The card's markdown text, so assertions read like the rendered output. */
function markdownOf(card: any): string {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    .join('\n')
}

function buildHarness(options: { failFirstSend?: boolean; debounceMs?: number; refreshMs?: number; withCardActions?: boolean } = {}) {
  const listeners = new Set<(event: JobEventLike) => void>()
  const cardActionHandlers = new Set<(event: any) => void | Promise<void>>()
  const sent: Array<{ to: string; card: any; text: string | undefined; opts: any }> = []
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
        sent.push({ to, card: 'card' in input ? input.card : undefined, text: 'text' in input ? input.text : undefined, opts })
        return { messageId: `m-${sent.length}` }
      },
      ...(options.withCardActions === true
        ? {
          onCardAction: (handler: (event: any) => void | Promise<void>) => {
            cardActionHandlers.add(handler)
            return () => { cardActionHandlers.delete(handler) }
          },
        }
        : {}),
    },
    logger: {
      info: (message: string) => { infos.push(message); return undefined },
      warn: (message: string) => { warns.push(message); return undefined },
      error: () => undefined,
    },
    getTranslations: () => zh,
    // Zero by default: every trigger flushes on the microtask chain, so the
    // tests never race a timer. The floor tests below opt into real windows.
    debounceMs: options.debounceMs ?? 0,
    refreshMs: options.refreshMs ?? 0,
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
    warns,
    infos,
    chat,
    emit: (event: JobEventLike) => { for (const listener of [...listeners]) listener(event) },
    confirm: (jobId: string, overrides: Partial<DetachedJobNotice> = {}) => mirror.noteDetached(notice(jobId, overrides)),
    click: async (evt: { messageId?: string; chatId?: string; action?: { value?: unknown } }) => {
      for (const handler of [...cardActionHandlers]) await handler(evt)
    },
    cardActionCount: () => cardActionHandlers.size,
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

describe('renderJobPanelCard', () => {
  it('titles the card with the fixed panel title, never with the command', () => {
    const card = renderJobPanelCard([row()], zh, 5_300) as any
    expect(card.header.title.content).toBe(zh.jobPanelTitle)
    expect(card.header.title.content).not.toContain('npm run build')
    expect(card.header.template).toBe('wathet')
  })

  it('lists status, command, id, duration and progress in one table row', () => {
    const text = markdownOf(renderJobPanelCard([row({ progress: '3/10' })], zh, 5_300) as any)
    expect(text).toContain(`| ${zh.jobPanelColStatus} |`)
    expect(text).toContain(zh.jobStatusRunning)
    expect(text).toContain('`npm run build`')
    expect(text).toContain('`bash-1`')
    expect(text).toContain('4.3s')
    expect(text).toContain('3/10')
    expect(text).toContain(zh.jobPanelSummary(1, 1))
  })

  it('shows the exit reason instead of the progress line once the job settled', () => {
    const settled = row({ status: 'failed', detail: 'exit code: 3', progress: '3/10', finishedAt: 3_000 }, 3_000)
    const text = markdownOf(renderJobPanelCard([settled], en, 9_000) as any)
    expect(text).toContain(en.jobStatusFailed)
    expect(text).toContain('exit code: 3')
    expect(text).not.toContain('3/10')
    expect(text).not.toContain(zh.jobStatusFailed)
  })

  it('renders one row per job, oldest first, and counts what is running', () => {
    const rows = [
      row({ id: 'bash-2', label: 'second', startedAt: 2_000 }),
      row({ id: 'bash-1', label: 'first', startedAt: 1_000, status: 'completed', finishedAt: 1_500 }, 1_500),
    ]
    const text = markdownOf(renderJobPanelCard(rows, zh, 5_000) as any)
    expect(text).toContain(zh.jobPanelSummary(1, 2))
    expect(text.indexOf('`first`')).toBeLessThan(text.indexOf('`second`'))
    const dataRows = text.split('\n').filter(line => line.startsWith('| ') && !line.includes('---') && !line.includes(zh.jobPanelColStatus))
    expect(dataRows).toHaveLength(2)
  })

  it('caps the table and says how many older rows it left out', () => {
    const rows = Array.from({ length: PANEL_MAX_ROWS + 3 }, (_, index) =>
      row({ id: `bash-${index + 1}`, label: `task ${index + 1}`, startedAt: 1_000 + index }))
    const text = markdownOf(renderJobPanelCard(rows, zh, 99_000) as any)
    expect(text).toContain(zh.panelMoreRows(3))
    const dataRows = text.split('\n').filter(line => line.startsWith('| ') && !line.includes('---') && !line.includes(zh.jobPanelColStatus))
    expect(dataRows).toHaveLength(PANEL_MAX_ROWS)
  })

  it('falls back to the untitled label and an em dash for a nameless job', () => {
    const text = markdownOf(renderJobPanelCard([row({ label: '   ' })], en, 2_000) as any)
    expect(text).toContain(en.jobUntitled)
    expect(text).toContain('| — |')
  })

  it('escapes a pipe in the command so the table keeps its columns', () => {
    const text = markdownOf(renderJobPanelCard([row({ label: 'grep a | wc -l' })], zh, 2_000) as any)
    // The fullwidth bar keeps the cell intact without a stray backslash.
    expect(text).toContain('`grep a ｜ wc -l`')
    expect(text.split('\n').find(line => line.includes('grep'))?.split('|')).toHaveLength(7)
  })
})

describe('jobRosterSignature', () => {
  it('ignores the clock but follows every visible fact', () => {
    const base = [row({ progress: '1/2' })]
    expect(jobRosterSignature(base)).toBe(jobRosterSignature([row({ progress: '1/2', startedAt: 9_000 })]))
    expect(jobRosterSignature(base)).not.toBe(jobRosterSignature([row({ progress: '2/2' })]))
    expect(jobRosterSignature(base)).not.toBe(jobRosterSignature([row({ status: 'completed', progress: '1/2' })]))
  })
})

describe('startFeishuJobs', () => {
  it('posts nothing for a foreground call, which DSH also registers as a job', async () => {
    // The regression that motivated the gate (关键坑 37): every foreground
    // `bash` call is a job, and listing those put every tool call in the panel.
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.emit({ type: 'progress', job: job({ progress: '1/2' }) })
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 4_000 }) })
    h.emit({ type: 'removed', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(0)
    expect(h.warns).toHaveLength(0)
    h.mirror.dispose()
  })

  it('posts one panel card into the announced chat once the result confirms a job', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    expect(h.sent[0]!.to).toBe('oc_1')
    expect(h.sent[0]!.card.header.title.content).toBe(zh.jobPanelTitle)
    expect(markdownOf(h.sent[0]!.card)).toContain('`npm run build`')
    // Topic coordinates come from the session that saw the tool result (关键坑 25/31).
    expect(h.sent[0]!.opts).toEqual({ replyInThread: true, replyTo: 'om_root' })
    h.mirror.dispose()
  })

  it('builds the first card from the projection cached before the confirmation', async () => {
    // The result lands after `registered` and possibly after `progress`, so the
    // card must render the LATEST known projection.
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.emit({ type: 'progress', job: job({ progress: '3/10' }) })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    expect(markdownOf(h.sent[0]!.card)).toContain('3/10')
    h.mirror.dispose()
  })

  it('lists every background task of the chat in ONE table and posts it again as the roster grows', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'registered', job: job({ id: 'bash-2', label: 'sleep 30', startedAt: 2_000 }) })
    h.confirm('bash-2')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(2) })
    // A NEW card carries both rows; nothing was patched in place.
    const text = markdownOf(h.sent[1]!.card)
    expect(text).toContain('`npm run build`')
    expect(text).toContain('`sleep 30`')
    expect(text).toContain(zh.jobPanelSummary(2, 2))
    h.mirror.dispose()
  })

  it.each([
    ['completed', zh.jobStatusCompleted],
    ['failed', zh.jobStatusFailed],
    ['killed', zh.jobStatusKilled],
  ] as const)('posts a fresh card when the job reaches %s', async (status, statusText) => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'settled', job: job({ status, finishedAt: 4_000 }) })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(2) })
    const text = markdownOf(h.sent[1]!.card)
    expect(text).toContain(statusText)
    expect(text).toContain(zh.jobPanelSummary(0, 1))
    h.mirror.dispose()
  })

  it('keeps a settled row after the job leaves the visible set', async () => {
    // `removed` follows `settled`: the row must survive so a later card still
    // records the outcome (the per-job version destroyed it, 2026-09-23).
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(2) })
    h.emit({ type: 'removed', job: job({ status: 'completed', finishedAt: 4_000 }) })
    h.emit({ type: 'registered', job: job({ id: 'bash-2', label: 'sleep 30', startedAt: 5_000 }) })
    h.confirm('bash-2')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(3) })
    const text = markdownOf(h.sent[2]!.card)
    expect(text).toContain('`npm run build`')
    expect(text).toContain(zh.jobStatusCompleted)
    expect(text).toContain('`sleep 30`')
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

  it('does not post again when the same result is seen twice', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(1)
    h.mirror.dispose()
  })

  it('does not post again when nothing visible changed', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    // Same status, same progress: a repeat event must not spawn a card whose
    // only difference is the elapsed time.
    h.emit({ type: 'registered', job: job() })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(1)
    h.mirror.dispose()
  })

  it('routes each chat to its own panel', async () => {
    const h = buildHarness()
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    const other = { chatId: 'oc_2', chatType: 'p2p' as const }
    h.emit({ type: 'registered', job: job({ id: 'bash-2', owner: 'session-9', label: 'other task' }) })
    h.mirror.noteDetached({ toolName: 'bash', resultText: 'started background job bash-2', chat: other, sessionId: 'session-9' })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(2) })
    expect(h.sent[1]!.to).toBe('oc_2')
    expect(markdownOf(h.sent[1]!.card)).not.toContain('npm run build')
    expect(markdownOf(h.sent[0]!.card)).not.toContain('other task')
    h.mirror.dispose()
  })

  it('throttles a progress-only change but not a status change', async () => {
    const h = buildHarness({ refreshMs: 60_000 })
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'progress', job: job({ progress: '1/9' }) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.sent).toHaveLength(1)
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(2) })
    expect(markdownOf(h.sent[1]!.card)).toContain(zh.jobStatusCompleted)
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
    expect(h.sent).toHaveLength(1)
  })

  it('survives a failed send and still posts on the next event', async () => {
    const h = buildHarness({ failFirstSend: true })
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.warns).toHaveLength(1) })
    expect(h.warns[0]).toContain('panel card send failed')
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    expect(markdownOf(h.sent[0]!.card)).toContain(zh.jobStatusCompleted)
    h.mirror.dispose()
  })
})

describe('clear-finished button', () => {
  /** The button element of a card, when it carries one. */
  const clearButton = (card: any): any => card.body.elements.find((el: any) => el.tag === 'button')

  it('offers no button while every listed job is still running', () => {
    const card = renderJobPanelCard([row()], zh, 2_000) as any
    expect(clearButton(card)).toBeUndefined()
  })

  it('offers a clear button once a listed job has settled', () => {
    const settled = row({ status: 'completed', finishedAt: 2_000 }, 2_000)
    const button = clearButton(renderJobPanelCard([row(), settled], en, 9_000))
    expect(button.text.content).toBe(en.jobPanelClearButton)
    // Card 2.0 buttons only honour `behaviors` (关键坑 4).
    expect(button.behaviors).toEqual([{ type: 'callback', value: { p: 'jobs-clear' } }])
  })

  it('drops the finished rows and reposts the panel with the live ones', async () => {
    const h = buildHarness({ withCardActions: true })
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'registered', job: job({ id: 'bash-2', label: 'sleep 30', startedAt: 2_000 }) })
    h.confirm('bash-2')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(2) })
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(3) })
    const buttons = h.sent[2]!.card.body.elements.filter((el: any) => el.tag === 'button')
    expect(buttons).toHaveLength(1)

    await h.click({ chatId: 'oc_1', messageId: 'm-3', action: { value: { p: 'jobs-clear' } } })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(4) })
    const text = markdownOf(h.sent[3]!.card)
    expect(text).toContain('`sleep 30`')
    expect(text).not.toContain('npm run build')
    expect(text).toContain(zh.jobPanelSummary(1, 1))
    h.mirror.dispose()
  })

  it('acknowledges with a text message when nothing is left to list', async () => {
    const h = buildHarness({ withCardActions: true })
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(2) })
    await h.click({ chatId: 'oc_1', messageId: 'm-2', action: { value: { p: 'jobs-clear' } } })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(3) })
    expect(h.sent[2]!.card).toBeUndefined()
    expect(h.sent[2]!.text).toBe(zh.jobPanelCleared(1))
    expect(h.sent[2]!.opts).toEqual({ replyInThread: true, replyTo: 'om_root' })
    // A later task starts from an empty panel: only the new row is listed.
    h.emit({ type: 'registered', job: job({ id: 'bash-2', label: 'sleep 30', startedAt: 5_000 }) })
    h.confirm('bash-2')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(4) })
    const text = markdownOf(h.sent[3]!.card)
    expect(text).toContain('`sleep 30`')
    expect(text).not.toContain('npm run build')
    h.mirror.dispose()
  })

  it('ignores a click on a card it does not track, and any foreign payload', async () => {
    const h = buildHarness({ withCardActions: true })
    h.emit({ type: 'registered', job: job() })
    h.confirm('bash-1')
    await vi.waitFor(() => { expect(h.sent).toHaveLength(1) })
    h.emit({ type: 'settled', job: job({ status: 'completed', finishedAt: 4_000 }) })
    await vi.waitFor(() => { expect(h.sent).toHaveLength(2) })
    await h.click({ chatId: 'oc_1', messageId: 'm-unknown', action: { value: { p: 'jobs-clear' } } })
    await h.click({ chatId: 'oc_1', messageId: 'm-2', action: { value: { p: 'display', key: 'tools', value: true } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent).toHaveLength(2)
    expect(h.infos.some(line => line.includes('untracked card'))).toBe(true)
    h.mirror.dispose()
  })

  it('unsubscribes the card action on dispose', async () => {
    const h = buildHarness({ withCardActions: true })
    expect(h.cardActionCount()).toBe(1)
    h.mirror.dispose()
    expect(h.cardActionCount()).toBe(0)
  })
})
