/**
 * The card-ordering barrier, and specifically the two properties whose absence
 * let the 2026-09-09 step-card / question-card inversion come back on
 * 2026-09-21: the re-entrancy guard must be PER CHAT, and the flush wait must
 * be BOUNDED so one stuck flush cannot silently disable ordering everywhere
 * (key pitfall 30).
 */
import { describe, expect, it, vi } from 'vitest'
import { createCardSendBarrier } from '../src/card-send-barrier.ts'

describe('card send barrier', () => {
  it('flushes the step card before posting the card that follows it', async () => {
    const barrier = createCardSendBarrier({ timeoutMs: 1_000 })
    const order: string[] = []
    const result = await barrier.run(
      'oc_1',
      async () => { await new Promise(r => setTimeout(r, 5)); order.push('step-card') },
      async () => { order.push('question-card'); return 'sent' },
    )
    expect(result).toBe('sent')
    expect(order).toEqual(['step-card', 'question-card'])
  })

  it('does not re-enter the flush for a send made from inside it', async () => {
    // The step card's own fallback send goes through the same channel; waiting
    // on the flush that is producing it would deadlock.
    const barrier = createCardSendBarrier({ timeoutMs: 1_000 })
    let flushes = 0
    let nestedResult = ''
    const outer = await barrier.run(
      'oc_1',
      async () => {
        flushes += 1
        nestedResult = await barrier.run('oc_1', async () => { flushes += 1 }, async () => 'nested')
      },
      async () => 'outer',
    )
    expect(outer).toBe('outer')
    expect(nestedResult).toBe('nested')
    expect(flushes).toBe(1)
  })

  it('sends anyway when the flush never settles, and reports why', async () => {
    vi.useFakeTimers()
    try {
      const onTimeout = vi.fn()
      const barrier = createCardSendBarrier({ timeoutMs: 500, onTimeout })
      const pending = barrier.run('oc_1', () => new Promise(() => { /* never */ }), async () => 'sent')
      await vi.advanceTimersByTimeAsync(501)
      await expect(pending).resolves.toBe('sent')
      expect(onTimeout).toHaveBeenCalledOnce()
      expect(onTimeout.mock.calls[0]![0]).toMatch(/step-card flush before send timed out/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the guard after a stuck flush instead of skipping every later flush', async () => {
    vi.useFakeTimers()
    try {
      const barrier = createCardSendBarrier({ timeoutMs: 500 })
      let flushes = 0
      const first = barrier.run('oc_1', () => { flushes += 1; return new Promise(() => { /* never */ }) }, async () => 'first')
      await vi.advanceTimersByTimeAsync(501)
      await first
      expect(flushes).toBe(1)

      const second = await barrier.run('oc_1', async () => { flushes += 1 }, async () => 'second')
      expect(second).toBe('second')
      // A permanently held guard (the old global counter) would leave this at 1.
      expect(flushes).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stuck flush in one chat does not disable the barrier for another chat', async () => {
    // THE regression: the guard used to be one process-wide counter, so a
    // single wedged send turned ordering off for every chat, which is exactly
    // how the inversion returned on 2026-09-21.
    const barrier = createCardSendBarrier({ timeoutMs: 60_000 })
    const flushes: string[] = []
    const stuck = barrier.run(
      'oc_stuck',
      async () => { flushes.push('stuck'); await new Promise(() => { /* never */ }) },
      async () => 'stuck',
    )
    const other = await barrier.run(
      'oc_healthy',
      async () => { flushes.push('healthy') },
      async () => 'healthy',
    )
    expect(other).toBe('healthy')
    expect(flushes).toEqual(['stuck', 'healthy'])
    void stuck // deliberately never awaited: it is still inside its own barrier
  })

  it('sends without a flush when the streaming module registered none', async () => {
    const barrier = createCardSendBarrier({ timeoutMs: 1_000 })
    await expect(barrier.run('oc_1', undefined, async () => 'sent')).resolves.toBe('sent')
  })
})
