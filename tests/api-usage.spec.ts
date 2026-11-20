import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiUsage, dayKeyOf, monthKeyOf } from '../src/api-usage.ts'
import { observeOutboundCalls, withLinkTimeout, withTimeout } from '../src/outbound-timeout.ts'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-usage-'))
  dirs.push(dir)
  return join(dir, 'feishu-api-usage.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A clock the test can move. */
function clock(start: string) {
  let current = Date.parse(start)
  return {
    now: () => current,
    advance(ms: number): void { current += ms },
  }
}

describe('api usage counter', () => {
  it('starts empty and counts one increment per call', () => {
    const usage = createApiUsage({ now: () => Date.parse('2026-11-20T10:00:00+08:00'), flushDelayMs: 0 })
    expect(usage.snapshot()).toMatchObject({ month: 0, today: 0, labels: [] })
    usage.record('send message')
    usage.record('send message')
    usage.record('cardkit.card.update')
    expect(usage.snapshot()).toMatchObject({
      monthKey: '2026-11',
      dayKey: '2026-11-20',
      month: 3,
      today: 3,
    })
    expect(usage.snapshot().labels[0]).toEqual({ label: 'send message', count: 2 })
    usage.dispose()
  })

  it('keeps at most three labels in a snapshot, busiest first', () => {
    const usage = createApiUsage({ now: () => Date.parse('2026-11-20T10:00:00+08:00'), flushDelayMs: 0 })
    for (const [label, times] of [['a', 5], ['b', 3], ['c', 2], ['d', 1]] as const) {
      for (let index = 0; index < times; index += 1) usage.record(label)
    }
    expect(usage.snapshot().labels.map(item => item.label)).toEqual(['a', 'b', 'c'])
    usage.dispose()
  })

  it('rolls the day bucket over without touching the month', () => {
    const time = clock('2026-11-20T23:59:00+08:00')
    const usage = createApiUsage({ now: time.now, flushDelayMs: 0 })
    usage.record('send message')
    time.advance(2 * 60_000)
    expect(usage.snapshot()).toMatchObject({ dayKey: '2026-11-21', month: 1, today: 0 })
    usage.record('send message')
    expect(usage.snapshot()).toMatchObject({ month: 2, today: 1 })
    usage.dispose()
  })

  it('resets the month (and its labels) when the month changes', () => {
    const time = clock('2026-11-30T23:00:00+08:00')
    const usage = createApiUsage({ now: time.now, flushDelayMs: 0 })
    usage.record('send message')
    time.advance(2 * 60 * 60_000)
    expect(usage.snapshot()).toMatchObject({ monthKey: '2026-12', month: 0, today: 0, labels: [] })
    usage.dispose()
  })

  it('persists across instances, including the day history', () => {
    const file = tempFile()
    const first = createApiUsage({ file, now: () => Date.parse('2026-11-20T10:00:00+08:00'), flushDelayMs: 0 })
    first.record('send message')
    first.record('upload card image')
    first.dispose()

    const second = createApiUsage({ file, now: () => Date.parse('2026-11-20T11:00:00+08:00'), flushDelayMs: 0 })
    expect(second.snapshot()).toMatchObject({ month: 2, today: 2 })
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { days: Record<string, number>; labels: Record<string, number> }
    expect(stored.days['2026-11-20']).toBe(2)
    expect(stored.labels['send message']).toBe(1)
    second.dispose()
  })

  it('writes pending counts on dispose even with a pending debounce', async () => {
    const file = tempFile()
    const usage = createApiUsage({ file, now: () => Date.parse('2026-11-20T10:00:00+08:00') })
    usage.record('send message')
    // The debounce has not fired yet; dispose must not lose the count.
    usage.dispose()
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { month: number }
    expect(stored.month).toBe(1)
    // The timer must not resurrect the file with a second write.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((JSON.parse(readFileSync(file, 'utf8')) as { month: number }).month).toBe(1)
  })

  it('sets a corrupt file aside and starts a fresh count', () => {
    const file = tempFile()
    writeFileSync(file, '{not json', 'utf8')
    const log = vi.fn()
    const usage = createApiUsage({ file, now: () => Date.parse('2026-11-20T10:00:00+08:00'), log, flushDelayMs: 0 })
    expect(usage.snapshot()).toMatchObject({ month: 0, today: 0 })
    expect(log).toHaveBeenCalledTimes(1)
    expect(readdirSync(join(file, '..')).some(name => name.includes('.corrupt-'))).toBe(true)
    usage.record('send message')
    usage.dispose()
    expect(existsSync(file)).toBe(true)
  })

  it('prunes day buckets past the retention window', () => {
    const file = tempFile()
    const days: Record<string, number> = {}
    for (let index = 0; index < 60; index += 1) {
      const date = new Date(Date.parse('2026-11-20T00:00:00Z') - index * 86_400_000)
      days[`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`] = 1
    }
    writeFileSync(file, JSON.stringify({
      version: 1, monthKey: '2026-11', month: 60, dayKey: '2026-11-20', today: 1, days, labels: {},
    }), 'utf8')
    const usage = createApiUsage({ file, now: () => Date.parse('2026-11-20T10:00:00+08:00'), flushDelayMs: 0 })
    usage.record('send message')
    usage.dispose()
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { days: Record<string, number> }
    expect(Object.keys(stored.days).length).toBeLessThanOrEqual(40)
  })

  it('formats local-time keys', () => {
    const at = Date.parse('2026-11-20T09:30:00+08:00')
    expect(monthKeyOf(at)).toBe('2026-11')
    expect(dayKeyOf(at)).toBe('2026-11-20')
  })
})

describe('outbound call observer', () => {
  afterEach(() => observeOutboundCalls(undefined))

  it('reports one call per withLinkTimeout, with the call site label', async () => {
    const started = vi.fn()
    observeOutboundCalls({ started })
    await withLinkTimeout(Promise.resolve('ok'), 'send message')
    await withLinkTimeout(Promise.resolve('ok'), 'upload card image')
    expect(started.mock.calls.map(call => call[0])).toEqual(['send message', 'upload card image'])
  })

  it('does not report a wait on our own pipeline', async () => {
    const started = vi.fn()
    observeOutboundCalls({ started })
    await withTimeout(Promise.resolve('ok'), 'card chain flush')
    expect(started).not.toHaveBeenCalled()
  })

  it('still resolves the request when the observer throws', async () => {
    observeOutboundCalls({ started: () => { throw new Error('boom') } })
    await expect(withLinkTimeout(Promise.resolve('ok'), 'send message')).resolves.toBe('ok')
  })
})
