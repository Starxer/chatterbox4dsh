/**
 * Guards for the outbound half of the plugin: no Feishu call may be waited on
 * forever, and nothing we log may carry a credential. Both were violated on
 * 2026-09-21 (key pitfall 29): a request with no timeout wedged a whole chat,
 * and the SDK's default logger printed the `app_secret` into the journal.
 */
import { describe, expect, it, vi } from 'vitest'
import { OUTBOUND_TIMEOUT_MS, settleWithin, withTimeout } from '../src/outbound-timeout.ts'
import { createSafeChannelLogger, redactSecrets } from '../src/log-redact.ts'

const SECRET = 's3cr3t-app-secret-value'

describe('withTimeout', () => {
  it('passes a settled value straight through', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 'thing')).resolves.toBe('ok')
  })

  it('propagates the original rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 'thing')).rejects.toThrow('boom')
  })

  it('rejects instead of waiting forever, naming what timed out', async () => {
    vi.useFakeTimers()
    try {
      const pending = withTimeout(new Promise(() => { /* never */ }), 'send message')
      const assertion = expect(pending).rejects.toThrow(/send message timed out/)
      await vi.advanceTimersByTimeAsync(OUTBOUND_TIMEOUT_MS + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults to a generous, non-zero budget', () => {
    expect(OUTBOUND_TIMEOUT_MS).toBeGreaterThan(1_000)
  })
})

describe('settleWithin', () => {
  it('resolves the value when it arrives in time', async () => {
    await expect(settleWithin(Promise.resolve(7), 'thing', 1_000)).resolves.toBe(7)
  })

  it('reports the timeout and resolves undefined so the caller can carry on', async () => {
    vi.useFakeTimers()
    try {
      const reasons: string[] = []
      const pending = settleWithin(new Promise(() => { /* never */ }), 'wait for card', 500, r => reasons.push(r))
      await vi.advanceTimersByTimeAsync(501)
      await expect(pending).resolves.toBeUndefined()
      expect(reasons).toHaveLength(1)
      expect(reasons[0]).toMatch(/wait for card timed out/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('redactSecrets', () => {
  it('blanks out every occurrence of a known secret', () => {
    expect(redactSecrets(`a=${SECRET} b=${SECRET}`, [SECRET])).toBe('a=*** b=***')
  })

  it('blanks bearer tokens regardless of the configured secrets', () => {
    expect(redactSecrets('Authorization: Bearer t-1234567890abcdef', []))
      .toBe('Authorization: Bearer ***')
  })

  it('ignores empty secrets instead of matching everything', () => {
    expect(redactSecrets('plain text', [''])).toBe('plain text')
  })
})

describe('createSafeChannelLogger', () => {
  it('reduces an axios-style error to its message without its request config', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const error = new Error('read ECONNRESET')
      // The shape the SDK hands its logger: the whole axios error, whose
      // `config.data` is the tenant-token request body.
      Object.assign(error, { config: { data: JSON.stringify({ app_id: 'cli_x', app_secret: SECRET }) } })
      createSafeChannelLogger([SECRET]).error(error)
      const printed = spy.mock.calls.flat().join(' ')
      expect(printed).toContain('read ECONNRESET')
      expect(printed).not.toContain(SECRET)
      expect(printed).not.toContain('cli_x')
    } finally {
      spy.mockRestore()
    }
  })

  it('scrubs a secret that survives into a serialized object', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      createSafeChannelLogger([SECRET]).error({ note: `token=${SECRET}` })
      const printed = spy.mock.calls.flat().join(' ')
      expect(printed).toContain('token=***')
      expect(printed).not.toContain(SECRET)
    } finally {
      spy.mockRestore()
    }
  })
})
