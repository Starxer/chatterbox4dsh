import { describe, expect, it } from 'vitest'
import {
  OUTBOUND_REASON_CAP,
  OutboundHealth,
  isTransportFailure,
  wrapHttpInstance,
} from '../src/outbound-health.ts'

/**
 * The outbound half of the connection indicator. What matters here is the
 * CLASSIFICATION: an outage must read as `failing` immediately, while a card
 * Feishu rejects with a 400 must not — that rejection means the peer answered,
 * so the link is healthy (2026-10-11, when every TLS handshake to
 * `open.feishu.cn` died with `SSL alert 112` while the badge read 已连接).
 */
describe('isTransportFailure', () => {
  it('counts a rejection with no response as a link failure', () => {
    const error = Object.assign(new Error('write EPROTO ... SSL alert number 112'), { code: 'EPROTO' })
    expect(isTransportFailure(error)).toBe(true)
  })

  it('does not count a rejection the peer answered', () => {
    const error = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { code: 230021, msg: 'file too large' } },
    })
    expect(isTransportFailure(error)).toBe(false)
  })

  it('ignores our own cancellation', () => {
    expect(isTransportFailure(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))).toBe(false)
  })

  it('counts a thrown non-error as a link failure', () => {
    expect(isTransportFailure('boom')).toBe(true)
  })
})

describe('OutboundHealth', () => {
  it('reports an untouched tracker as ok but unobserved', () => {
    expect(new OutboundHealth().snapshot()).toMatchObject({ verdict: 'ok', observed: 0, failures: 0 })
  })

  it('flips to failing on the first unanswered request and back on the next answer', () => {
    const health = new OutboundHealth()
    health.noteRejected(new Error('write EPROTO'), 1_000)
    expect(health.snapshot()).toMatchObject({ verdict: 'failing', failures: 1, consecutiveFailures: 1, lastFailureAt: 1_000 })

    health.noteAnswered(2_000)
    // The failure count stays as history; only the CURRENT verdict clears.
    expect(health.snapshot()).toMatchObject({ verdict: 'ok', observed: 2, answered: 1, failures: 1, consecutiveFailures: 0, lastAnsweredAt: 2_000 })
  })

  it('counts consecutive failures while the outage lasts', () => {
    const health = new OutboundHealth()
    for (let i = 0; i < 5; i++) health.noteRejected(new Error('write EPROTO'), i)
    expect(health.snapshot()).toMatchObject({ verdict: 'failing', failures: 5, consecutiveFailures: 5, observed: 5 })
  })

  it('does not count a request the peer answered as a failure', () => {
    const health = new OutboundHealth()
    health.noteAnswered()
    // A 500 is still an answer: the link carried the request and brought a
    // reply back. Only "no reply at all" is a link failure.
    health.noteRejected({ response: { status: 500 } })
    expect(health.snapshot()).toMatchObject({ verdict: 'ok', observed: 2, answered: 2, failures: 0 })
  })

  it('keeps the reason, capped', () => {
    const health = new OutboundHealth()
    health.noteRejected(Object.assign(new Error('x'.repeat(OUTBOUND_REASON_CAP * 2)), { code: 'EPROTO' }))
    const reason = health.snapshot().lastError ?? ''
    expect(reason.length).toBeLessThanOrEqual(OUTBOUND_REASON_CAP + 1)
    expect(reason.startsWith('xxx')).toBe(true)
  })

  it('survives an error that carries only a code', () => {
    // Not a shape axios produces, but the tracker is fed by a proxy: a thrown
    // non-Error must still count as a failure, and the code must reach the UI.
    const health = new OutboundHealth()
    health.noteRejected({ code: 'EPROTO' })
    expect(health.snapshot()).toMatchObject({ verdict: 'failing', failures: 1 })
    expect(health.snapshot().lastError).toContain('EPROTO')
  })

  // A request that never settles leaves no outcome for the wrapper to record:
  // the hang is only visible from the bounded wait around it (`noteAbandoned`),
  // which is what keeps a silent half-open connection from reading "healthy".
  it('treats a give-up as a failure, naming the budget and the call site', () => {
    const health = new OutboundHealth()
    health.noteAbandoned('send message', 20_000, 5_000)
    expect(health.snapshot()).toMatchObject({
      verdict: 'failing',
      observed: 1,
      failures: 1,
      consecutiveFailures: 1,
      lastFailureAt: 5_000,
      lastError: 'no answer within 20000ms: send message',
    })
  })

  it('lets a late answer clear a give-up, like any other failure', () => {
    const health = new OutboundHealth()
    health.noteAbandoned('send file', 120_000, 1_000)
    // A timeout is not a cancellation: the request may still come back.
    health.noteAnswered(2_000)
    const snapshot = health.snapshot()
    expect(snapshot).toMatchObject({ verdict: 'ok', consecutiveFailures: 0, failures: 1 })
    expect(snapshot.lastError).toBe('no answer within 120000ms: send file')
  })
})

describe('wrapHttpInstance', () => {
  /** A stand-in for the SDK's axios instance: one method plus a plain property. */
  function inner(behaviour: () => Promise<unknown>, calls: Array<{ url: string; self: unknown }> = []) {
    const instance = {
      defaults: { baseURL: 'https://open.feishu.cn' },
      request(opts: { url: string }) {
        calls.push({ url: opts.url, self: this })
        return behaviour()
      },
    }
    return { instance, calls }
  }

  it('passes a request through and records the answer', async () => {
    const { instance, calls } = inner(async () => ({ ok: true }))
    const health = new OutboundHealth()
    const wrapped = wrapHttpInstance(instance, health)

    await expect(wrapped.request({ url: '/a' })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([{ url: '/a', self: instance }])
    expect(health.snapshot()).toMatchObject({ verdict: 'ok', observed: 1, answered: 1 })
  })

  it('keeps the original instance as the receiver and its properties intact', async () => {
    // Axios methods read `this` (defaults, interceptors); a wrapper that lost
    // the receiver would break the very client it is observing.
    const { instance, calls } = inner(async () => 'ok')
    const wrapped = wrapHttpInstance(instance, new OutboundHealth())
    await wrapped.request({ url: '/a' })
    expect(calls[0]?.self).toBe(instance)
    expect((wrapped as unknown as { defaults: unknown }).defaults).toBe(instance.defaults)
  })

  it('records a rejection and rethrows it untouched', async () => {
    const failure = Object.assign(new Error('write EPROTO'), { code: 'EPROTO' })
    const { instance } = inner(async () => { throw failure })
    const health = new OutboundHealth()

    await expect(wrapHttpInstance(instance, health).request({ url: '/a' })).rejects.toBe(failure)
    expect(health.snapshot()).toMatchObject({ verdict: 'failing', consecutiveFailures: 1 })
  })

  it('records an answered error response as an answer, not a failure', async () => {
    const { instance } = inner(async () => {
      throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } })
    })
    const health = new OutboundHealth()

    await expect(wrapHttpInstance(instance, health).request({ url: '/a' })).rejects.toBeInstanceOf(Error)
    expect(health.snapshot()).toMatchObject({ verdict: 'ok', answered: 1, failures: 0 })
  })

  it('covers every method the instance exposes, not a fixed list', async () => {
    const calls: string[] = []
    const instance = {
      get: async (url: string) => { calls.push(`get:${url}`); return 'g' },
      post: async (url: string) => { calls.push(`post:${url}`); return 'p' },
      // A method the SDK adds later is observed too: the proxy is generic.
      upload: async (url: string) => { calls.push(`upload:${url}`); return 'u' },
    }
    const health = new OutboundHealth()
    const wrapped = wrapHttpInstance(instance, health) as unknown as {
      get: (url: string) => Promise<string>
      post: (url: string) => Promise<string>
      upload: (url: string) => Promise<string>
    }

    await expect(wrapped.get('/a')).resolves.toBe('g')
    await expect(wrapped.post('/b')).resolves.toBe('p')
    await expect(wrapped.upload('/c')).resolves.toBe('u')
    expect(calls).toEqual(['get:/a', 'post:/b', 'upload:/c'])
    expect(health.snapshot()).toMatchObject({ observed: 3, answered: 3 })
  })

  it('counts a request once even when the instance calls itself internally', async () => {
    // Axios's `get`/`post` delegate to its own `request` on the RAW instance.
    // Because the proxy applies methods with the original instance as the
    // receiver, that internal call bypasses the recorder — one SDK call must
    // stay one observation, or a single outage would look several times worse.
    const instance = {
      async request(opts: { url: string }) { return `body:${opts.url}` },
      async get(url: string) { return this.request({ url }) },
    }
    const health = new OutboundHealth()
    const wrapped = wrapHttpInstance(instance, health) as unknown as { get: (url: string) => Promise<string> }

    await expect(wrapped.get('/a')).resolves.toBe('body:/a')
    expect(health.snapshot()).toMatchObject({ observed: 1, answered: 1, failures: 0 })
  })

  it('ignores a cancelled request', async () => {
    const { instance } = inner(async () => {
      throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })
    })
    const health = new OutboundHealth()
    const wrapped = wrapHttpInstance(instance, health)

    await expect(wrapped.request({ url: '/a' })).rejects.toBeInstanceOf(Error)
    expect(health.snapshot()).toMatchObject({ observed: 0, failures: 0, verdict: 'ok' })
  })

  it('records a synchronous throw from the instance, and keeps it synchronous', () => {
    const health = new OutboundHealth()
    const wrapped = wrapHttpInstance({ request: () => { throw new Error('sync') } }, health)
    expect(() => wrapped.request({})).toThrow('sync')
    expect(health.snapshot().failures).toBe(1)
  })
})
