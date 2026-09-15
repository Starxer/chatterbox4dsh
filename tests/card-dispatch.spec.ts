import { describe, expect, it, vi } from 'vitest'
import { dispatchCardAction } from '../src/card-dispatch.ts'

/**
 * Regression guard for the 2026-09-14 outage: a card handler that throws used
 * to escape the fan-out as an `unhandledRejection`, which DSH's
 * `installFailLoud` escalates to `fatal load failure` + exit(1) — one button
 * tap killed the whole service. Dispatch must contain every handler failure.
 */
describe('dispatchCardAction', () => {
  it('delivers the event to every handler', () => {
    const a = vi.fn()
    const b = vi.fn()
    dispatchCardAction([a, b], { messageId: 'om_1' }, vi.fn())
    expect(a).toHaveBeenCalledWith({ messageId: 'om_1' })
    expect(b).toHaveBeenCalledWith({ messageId: 'om_1' })
  })

  it('contains a rejected async handler and keeps dispatching the rest', async () => {
    const onError = vi.fn()
    const rejected = vi.fn(async () => { throw new Error('boom') })
    const later = vi.fn()
    dispatchCardAction([rejected, later], { messageId: 'om_1' }, onError)
    // The remaining handler is not skipped.
    expect(later).toHaveBeenCalledTimes(1)
    // Containment is asynchronous for the promise path.
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('boom')
  })

  it('contains a synchronous throw without unwinding the fan-out', () => {
    const onError = vi.fn()
    const throws = vi.fn(() => { throw new Error('sync boom') })
    const later = vi.fn()
    expect(() => dispatchCardAction([throws, later], { messageId: 'om_1' }, onError)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('leaves nothing unhandled when a handler rejects', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      dispatchCardAction([async () => { throw new Error('boom') }], { messageId: 'om_1' }, vi.fn())
      // Let the rejection settle: without containment Node emits it here.
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })

  it('does not report healthy handlers', () => {
    const onError = vi.fn()
    dispatchCardAction([() => undefined, async () => undefined], { messageId: 'om_1' }, onError)
    expect(onError).not.toHaveBeenCalled()
  })
})
