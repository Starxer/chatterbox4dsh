/**
 * Guards for the outbound half of the plugin: no Feishu call may be waited on
 * forever, and nothing we log may carry a credential. Both were violated on
 * 2026-09-21 (key pitfall 29): a request with no timeout wedged a whole chat,
 * and the SDK's default logger printed the `app_secret` into the journal.
 *
 * The third guard here is newer (TODO O26): a request that NEVER settles leaves
 * no outcome behind, so the connection indicator can only learn about that hang
 * from the bounded wait around it. `withLinkTimeout` is that report; the tests
 * below pin both its behaviour and which calls are allowed to use it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  OUTBOUND_TIMEOUT_MS,
  observeOutboundWaits,
  settleWithin,
  withLinkTimeout,
  withTimeout,
} from '../src/outbound-timeout.ts'
import { createSafeChannelLogger, redactSecrets } from '../src/log-redact.ts'

const SECRET = 's3cr3t-app-secret-value'

afterEach(() => {
  // The observer is process-wide by design; a leaked one would report into the
  // next test's spy.
  observeOutboundWaits(undefined)
  vi.useRealTimers()
})

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

describe('abandoned-wait reporting', () => {
  it('reports a link wait that gives up, with the site label and its own budget', async () => {
    vi.useFakeTimers()
    const observer = { abandoned: vi.fn() }
    observeOutboundWaits(observer)

    const pending = withLinkTimeout(new Promise(() => { /* never answers */ }), 'send message')
    const assertion = expect(pending).rejects.toThrow(/send message timed out/)
    await vi.advanceTimersByTimeAsync(OUTBOUND_TIMEOUT_MS + 1)
    await assertion

    expect(observer.abandoned).toHaveBeenCalledTimes(1)
    expect(observer.abandoned).toHaveBeenCalledWith('send message', OUTBOUND_TIMEOUT_MS)
  })

  it('honours the budget the call site chose, not a threshold of its own', async () => {
    vi.useFakeTimers()
    const observer = { abandoned: vi.fn() }
    observeOutboundWaits(observer)

    const pending = withLinkTimeout(new Promise(() => { /* never */ }), 'send file', 120_000)
    const assertion = expect(pending).rejects.toThrow(/send file timed out/)
    // A slow-but-legitimate request under its own budget must stay unreported.
    await vi.advanceTimersByTimeAsync(119_999)
    expect(observer.abandoned).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    await assertion
    expect(observer.abandoned).toHaveBeenCalledWith('send file', 120_000)
  })

  it('reports nothing for a request that answers in time', async () => {
    const observer = { abandoned: vi.fn() }
    observeOutboundWaits(observer)
    await expect(withLinkTimeout(Promise.resolve('ok'), 'send message')).resolves.toBe('ok')
    expect(observer.abandoned).not.toHaveBeenCalled()
  })

  it('does not report waits on our own pipeline', async () => {
    vi.useFakeTimers()
    const observer = { abandoned: vi.fn() }
    observeOutboundWaits(observer)

    // A card chain flushing and a previous card settling are not Feishu facts.
    const own = withTimeout(new Promise(() => { /* never */ }), 'step-card flush before send', 500)
    const ownSettled = settleWithin(new Promise(() => { /* never */ }), 'wait for the previous step card', 500)
    const assertions = Promise.all([
      expect(own).rejects.toThrow(/flush/),
      expect(ownSettled).resolves.toBeUndefined(),
    ])
    await vi.advanceTimersByTimeAsync(501)
    await assertions
    expect(observer.abandoned).not.toHaveBeenCalled()
  })

  it('stops reporting once the observer is detached', async () => {
    vi.useFakeTimers()
    const observer = { abandoned: vi.fn() }
    observeOutboundWaits(observer)
    observeOutboundWaits(undefined)

    const pending = withLinkTimeout(new Promise(() => { /* never */ }), 'send message', 100)
    const assertion = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(101)
    await assertion
    expect(observer.abandoned).not.toHaveBeenCalled()
  })

  it('survives an observer that throws, still rejecting with the same message', async () => {
    vi.useFakeTimers()
    observeOutboundWaits({ abandoned: () => { throw new Error('observer blew up') } })

    const pending = withLinkTimeout(new Promise(() => { /* never */ }), 'send message', 100)
    const assertion = expect(pending).rejects.toThrow(/send message timed out after 100ms/)
    await vi.advanceTimersByTimeAsync(101)
    await assertion
  })
})

describe('which waits are link waits', () => {
  const read = (name: string): Promise<string> =>
    readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')

  /** Every module whose bounded waits wrap a Feishu request. */
  const SENDERS = ['index.ts', 'channel.ts', 'media-upload.ts', 'card-images.ts', 'feishu-send-file.ts']

  it('bounds requests with the reporting wait in every sending module', async () => {
    for (const name of SENDERS) {
      const source = await read(name)
      // `withTimeout(` cannot match `withLinkTimeout(`: the identifier differs.
      expect(source, `${name} waits on a request without reporting it`).not.toContain('withTimeout(')
      expect(source, `${name} no longer bounds anything`).toContain('withLinkTimeout(')
    }
  })

  it('keeps our own pipeline out of the link channel', async () => {
    for (const name of ['card-send-barrier.ts', 'feishu-streaming.ts']) {
      const source = await read(name)
      expect(source, `${name} reports an internal wait as a link fact`).not.toContain('withLinkTimeout(')
    }
  })

  it('installs the observer and wraps the SDK instance the channel sends through', async () => {
    const source = await read('index.ts')
    expect(source).toContain('observeOutboundWaits(')
    expect(source).toContain('wrapHttpInstance(defaultHttpInstance')
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

  it('renders an ARRAY of axios errors with the status and Feishu msg, never config.data', () => {
    // What the SDK hands over on a failed pipeline task: [error, ...]. A cycle
    // in the object graph used to degrade the whole line to
    // "[object Object],[object Object]", which hid 234003 "File not in msg."
    // during the 2026-10-27 image investigation.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const error = Object.assign(new Error('Request failed with status code 400'), {
        code: 'ERR_BAD_REQUEST',
        config: { method: 'get', url: 'https://open.feishu.cn/open-apis/im/v1/messages/x/resources/y', data: JSON.stringify({ app_secret: SECRET }) },
      })
      // Self-reference: exactly what made JSON.stringify throw.
      ;(error as unknown as { self?: unknown }).self = error
      ;(error as unknown as { response?: unknown }).response = {
        status: 400,
        data: Buffer.from(JSON.stringify({ code: 234003, msg: 'File not in msg.' })),
        config: error,
      }
      createSafeChannelLogger([SECRET]).error([error, { note: 'safety: message handler threw' }])
      const printed = spy.mock.calls.flat().join(' ')
      expect(printed).not.toContain('[object Object]')
      expect(printed).toContain('234003')
      expect(printed).toContain('File not in msg.')
      expect(printed).toContain('resources/y')
      expect(printed).not.toContain(SECRET)
      expect(printed).not.toContain('app_secret')
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
