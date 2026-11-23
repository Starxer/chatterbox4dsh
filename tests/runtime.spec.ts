import { describe, expect, it, vi } from 'vitest'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import {
  CHANNEL_HALF_OPEN_ACTIVE_WINDOW_MS, CHANNEL_HALF_OPEN_COOLDOWN_MS, CHANNEL_HALF_OPEN_SILENCE_MS,
  CHANNEL_RETRY_BACKOFF_MS, LarkRuntime, halfOpenRebuildDue, type LarkRuntimeStart,
} from '../src/runtime.ts'
import { resolveSettingsConfig } from '../src/config.ts'

function fakeStart(stop: () => Promise<void>): LarkRuntimeStart {
  // The channel field is opaque to LarkRuntime; tests never read it. Returning
  // an empty stub keeps the surface narrow while satisfying the type.
  return { stop, channel: {} as LarkChannel }
}

describe('halfOpenRebuildDue', () => {
  const now = 10_000_000
  it('rebuilds when outbound was recent but inbound has been silent', () => {
    expect(halfOpenRebuildDue({
      now,
      lastInboundAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 1,
      lastOutboundAt: now - 60_000,
      lastRebuildAt: 0,
      lastConnectedAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 10_000,
    })).toBe(true)
  })

  it('stays put right after connecting, even with no inbound yet', () => {
    // 2026-11-20: a fresh process sent its startup notice and the detector
    // rebuilt the channel 59 s later — "never received anything" was read as
    // "silent for five minutes", and that rebuild displaced the message handler.
    expect(halfOpenRebuildDue({
      now,
      lastInboundAt: 0,
      lastOutboundAt: now - 30_000,
      lastRebuildAt: 0,
      lastConnectedAt: now - 60_000,
    })).toBe(false)
    // Once the connection itself is older than the silence window, the same
    // facts DO read as half-open.
    expect(halfOpenRebuildDue({
      now,
      lastInboundAt: 0,
      lastOutboundAt: now - 30_000,
      lastRebuildAt: 0,
      lastConnectedAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 1_000,
    })).toBe(true)
  })

  it('stays put while inbound is still moving', () => {
    expect(halfOpenRebuildDue({
      now,
      lastInboundAt: now - 1_000,
      lastOutboundAt: now - 60_000,
      lastRebuildAt: 0,
      lastConnectedAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 10_000,
    })).toBe(false)
  })

  it('stays put when the bot answered a message and nobody spoke again', () => {
    // 2026-11-23 20:47:05: the detector rebuilt a HEALTHY channel because the
    // last card went out 48 s after the user's message and the chat was then
    // quiet for five minutes. That is the normal shape of "answered, then
    // idle", not a half-open socket.
    expect(halfOpenRebuildDue({
      now,
      lastInboundAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 6_000,
      lastOutboundAt: now - CHANNEL_HALF_OPEN_SILENCE_MS + 48_000,
      lastRebuildAt: 0,
      lastConnectedAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 20_000,
    })).toBe(false)
  })

  it('rebuilds when outbound activity kept happening inside the silence', () => {
    // The half-open signature: the bot keeps writing for minutes while nothing
    // comes back (a running turn's card updates, ticks, notices).
    expect(halfOpenRebuildDue({
      now,
      lastInboundAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 21_000,
      lastOutboundAt: now - 60_000,
      lastRebuildAt: 0,
      lastConnectedAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 20_000,
    })).toBe(true)
  })

  it('stays put with no outbound activity at all (an idle night is not a fault)', () => {
    expect(halfOpenRebuildDue({ now, lastInboundAt: 0, lastOutboundAt: 0, lastRebuildAt: 0, lastConnectedAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 10_000 })).toBe(false)
  })

  it('stays put once outbound has been idle for longer than the active window', () => {
    expect(halfOpenRebuildDue({
      now,
      lastInboundAt: 0,
      lastOutboundAt: now - CHANNEL_HALF_OPEN_ACTIVE_WINDOW_MS - 1,
      lastRebuildAt: 0,
      lastConnectedAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 10_000,
    })).toBe(false)
  })

  it('respects the cooldown so an idle chat cannot churn', () => {
    expect(halfOpenRebuildDue({
      now,
      lastInboundAt: 0,
      lastOutboundAt: now - 60_000,
      lastRebuildAt: now - CHANNEL_HALF_OPEN_COOLDOWN_MS + 1,
      lastConnectedAt: now - CHANNEL_HALF_OPEN_SILENCE_MS - 10_000,
    })).toBe(false)
  })
})

describe('LarkRuntime.restartChannel', () => {
  it('rebuilds the channel even though the configuration did not change', async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = []
    const start = vi.fn(async () => {
      const stop = vi.fn(async () => undefined)
      stops.push(stop)
      return fakeStart(stop)
    })
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({ appId: 'id' }),
      resolveSecret: async () => 'secret',
      start,
    })
    await runtime.reconcile()
    expect(start).toHaveBeenCalledOnce()

    // A half-open socket: reconcile() would short-circuit on the unchanged
    // fingerprint, so the rebuild path must drop the current channel itself.
    await runtime.restartChannel('test: half-open socket')
    expect(stops[0]).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledTimes(2)
    expect(runtime.status()).toMatchObject({ state: 'connected' })
  })
})

describe('LarkRuntime', () => {
  it('stays idle until both application credentials are configured', async () => {
    const start = vi.fn()
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({}),
      resolveSecret: vi.fn(async () => undefined),
      start,
    })
    await runtime.reconcile()
    expect(start).not.toHaveBeenCalled()
    expect(runtime.status()).toMatchObject({ state: 'unconfigured' })
  })

  it('replaces the active channel when effective configuration changes', async () => {
    let config = resolveSettingsConfig({ appId: 'id' })
    const stops: Array<ReturnType<typeof vi.fn>> = []
    const start = vi.fn(async () => {
      const stop = vi.fn(async () => undefined)
      stops.push(stop)
      return fakeStart(stop)
    })
    const runtime = new LarkRuntime({ settings: () => config, resolveSecret: async () => 'secret', start })
    await runtime.reconcile()
    await runtime.reconcile()
    expect(start).toHaveBeenCalledOnce()
    config = { ...config, requireMention: false }
    await runtime.reconcile()
    expect(stops[0]).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledTimes(2)
    expect(runtime.status()).toMatchObject({ state: 'connected' })
  })

  it('keeps the live channel when only a non-connection setting changes', async () => {
    // Toggling a card-display switch must NOT rebuild the runtime: rebuilding
    // disconnects the WebSocket and disposes every live agent session. Doing
    // that mid-turn killed the turn with "flush on a closed handle"
    // (2026-09-10, /display while the agent was running).
    let config = resolveSettingsConfig({ appId: 'id' })
    const stops: Array<ReturnType<typeof vi.fn>> = []
    const start = vi.fn(async () => {
      const stop = vi.fn(async () => undefined)
      stops.push(stop)
      return fakeStart(stop)
    })
    const runtime = new LarkRuntime({ settings: () => config, resolveSecret: async () => 'secret', start })
    await runtime.reconcile()

    config = { ...config, showToolCalls: false, showReasoning: false, showToolArgs: false, showToolResults: false }
    await runtime.reconcile()
    config = { ...config, locale: 'en', errorMessage: 'nope' }
    await runtime.reconcile()
    config = { ...config, workspace: '/other', agentPreset: 'other', provider: 'p', model: 'm' }
    await runtime.reconcile()

    expect(start).toHaveBeenCalledOnce()
    // The one started runtime is still the live one: nothing stopped it.
    expect(stops).toHaveLength(1)
    expect(stops[0]).not.toHaveBeenCalled()
    expect(runtime.status()).toMatchObject({ state: 'connected' })
  })

  it('replaces the channel after the credential value changes', async () => {
    let secret = 'first'
    const stop = vi.fn(async () => undefined)
    const start = vi.fn(async () => fakeStart(stop))
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({ appId: 'id' }),
      resolveSecret: async () => secret,
      start,
    })
    await runtime.reconcile()
    secret = 'second'
    await runtime.reconcile()
    expect(stop).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('disposes the current channel', async () => {
    const stop = vi.fn(async () => undefined)
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({ appId: 'id' }),
      resolveSecret: async () => 'secret',
      start: async () => fakeStart(stop),
    })
    await runtime.reconcile()
    await runtime.dispose()
    expect(stop).toHaveBeenCalledOnce()
    expect(runtime.status()).toMatchObject({ state: 'stopped' })
  })

  it('never exposes the resolved secret in connection errors', async () => {
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({ appId: 'id' }),
      resolveSecret: async () => 'actual-secret',
      start: async () => { throw new Error('authentication failed for actual-secret') },
    })
    await runtime.reconcile()
    expect(JSON.stringify(runtime.status())).not.toContain('actual-secret')
    expect(runtime.status()).toMatchObject({ state: 'error' })
    // A failed start schedules a retry; dispose clears it so the test leaves no
    // timer behind.
    await runtime.dispose()
  })

  it('moves to an error state when credential resolution fails', async () => {
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({ appId: 'id' }),
      resolveSecret: async () => { throw new Error('credential backend unavailable') },
      start: vi.fn(),
    })
    await runtime.reconcile()
    expect(runtime.status()).toEqual({ state: 'error', message: 'credential backend unavailable' })
    await runtime.dispose()
  })

  it('moves to an error state when stopping the old channel fails', async () => {
    let config = resolveSettingsConfig({ appId: 'id' })
    const runtime = new LarkRuntime({
      settings: () => config,
      resolveSecret: async () => 'secret',
      start: async () => fakeStart(async () => { throw new Error('disconnect failed') }),
    })
    await runtime.reconcile()
    config = { ...config, requireMention: false }
    await runtime.reconcile()
    expect(runtime.status()).toEqual({ state: 'error', message: 'disconnect failed' })
    await runtime.dispose()
  })

  // The snapshot is a BOOT verdict: it says the WebSocket handshake succeeded
  // once and never revisits that. A dropped long connection therefore keeps
  // reading `connected` unless the live state is reported beside it — the same
  // blind spot the outbound half had during the 2026-10-11 TLS outage.
  describe('live inbound state', () => {
    function runtimeWithInbound(getConnectionStatus: () => unknown): LarkRuntime {
      return new LarkRuntime({
        settings: () => resolveSettingsConfig({ appId: 'id' }),
        resolveSecret: async () => 'secret',
        start: async () => ({
          stop: async () => undefined,
          channel: { getConnectionStatus } as unknown as LarkChannel,
        }),
      })
    }

    it('reports the channel lifecycle beside the boot verdict', async () => {
      const runtime = runtimeWithInbound(() => ({
        state: 'reconnecting',
        reconnectAttempts: 3,
        lastConnectTime: 1_700_000_000_000,
        nextConnectTime: 1_700_000_030_000,
      }))
      await runtime.reconcile()

      expect(runtime.status()).toMatchObject({
        state: 'connected',
        inbound: {
          state: 'reconnecting',
          reconnectAttempts: 3,
          lastConnectTime: 1_700_000_000_000,
          nextConnectTime: 1_700_000_030_000,
        },
      })
    })

    it('reads the state on every call rather than caching the first one', async () => {
      let state = 'connected'
      const runtime = runtimeWithInbound(() => ({ state, reconnectAttempts: 0 }))
      await runtime.reconcile()
      expect(runtime.status().inbound?.state).toBe('connected')

      state = 'failed'
      expect(runtime.status().inbound?.state).toBe('failed')
    })

    it('omits the optional timestamps the channel did not report', async () => {
      const runtime = runtimeWithInbound(() => ({ state: 'connected', reconnectAttempts: 0 }))
      await runtime.reconcile()
      expect(runtime.status().inbound).toEqual({ state: 'connected', reconnectAttempts: 0 })
    })

    it('keeps the boot verdict when the channel exposes no getter', async () => {
      // A stub channel, or an SDK that stops offering the getter, must not take
      // `/status` down with it.
      const runtime = new LarkRuntime({
        settings: () => resolveSettingsConfig({ appId: 'id' }),
        resolveSecret: async () => 'secret',
        start: async () => fakeStart(async () => undefined),
      })
      await runtime.reconcile()
      expect(runtime.status()).toEqual({ state: 'connected' })
    })

    it('drops the inbound half once the channel is gone', async () => {
      const runtime = runtimeWithInbound(() => ({ state: 'connected', reconnectAttempts: 0 }))
      await runtime.reconcile()
      await runtime.dispose()
      expect(runtime.status()).toEqual({ state: 'stopped' })
    })
  })
})

/**
 * A start failure is not the WebSocket dropping (the SDK reconnects that): it is
 * `start()` returning no channel at all — no bot identity, no DNS, credentials
 * briefly unreachable. On 2026-10-23 the host lost DNS, the 15:03 startup failed
 * with `getaddrinfo ENOTFOUND`, the network returned at 15:12, and the channel
 * stayed dead for 2 h 55 m — silently, because nothing retried — until a manual
 * restart. These cases pin the retry loop down.
 */
describe('retrying a failed channel start', () => {
  it('retries with backoff until the start succeeds, then stops', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      const start = vi.fn(async () => {
        attempt += 1
        if (attempt < 3) throw new Error('getaddrinfo ENOTFOUND open.feishu.cn')
        return fakeStart(async () => undefined)
      })
      const runtime = new LarkRuntime({
        settings: () => resolveSettingsConfig({ appId: 'id' }),
        resolveSecret: async () => 'secret',
        start,
      })
      await runtime.reconcile()
      expect(runtime.status()).toMatchObject({ state: 'error' })
      expect(start).toHaveBeenCalledTimes(1)

      // Nothing before the first backoff step elapses.
      await vi.advanceTimersByTimeAsync(CHANNEL_RETRY_BACKOFF_MS[0]! - 1)
      expect(start).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(start).toHaveBeenCalledTimes(2)
      expect(runtime.status()).toMatchObject({ state: 'error' })

      // Second failure waits one step longer.
      await vi.advanceTimersByTimeAsync(CHANNEL_RETRY_BACKOFF_MS[1]!)
      expect(start).toHaveBeenCalledTimes(3)
      expect(runtime.status()).toMatchObject({ state: 'connected' })

      // Healthy again: the loop is over, however long we wait.
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(start).toHaveBeenCalledTimes(3)
      await runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps the backoff at the steady interval instead of growing forever', async () => {
    vi.useFakeTimers()
    try {
      const start = vi.fn(async () => { throw new Error('offline') })
      const runtime = new LarkRuntime({
        settings: () => resolveSettingsConfig({ appId: 'id' }),
        resolveSecret: async () => 'secret',
        start,
      })
      await runtime.reconcile()
      expect(start).toHaveBeenCalledTimes(1)
      const steady = CHANNEL_RETRY_BACKOFF_MS[CHANNEL_RETRY_BACKOFF_MS.length - 1]!
      // One failing attempt per scheduled step, including the capped ones.
      for (let index = 0; index < CHANNEL_RETRY_BACKOFF_MS.length; index += 1) {
        const delay = CHANNEL_RETRY_BACKOFF_MS[Math.min(index, CHANNEL_RETRY_BACKOFF_MS.length - 1)]!
        await vi.advanceTimersByTimeAsync(delay)
        expect(start).toHaveBeenCalledTimes(index + 2)
      }
      // The next wait is the capped interval, not a larger one.
      await vi.advanceTimersByTimeAsync(steady - 1)
      expect(start).toHaveBeenCalledTimes(CHANNEL_RETRY_BACKOFF_MS.length + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(start).toHaveBeenCalledTimes(CHANNEL_RETRY_BACKOFF_MS.length + 2)
      await runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a configuration that cannot start the channel', async () => {
    vi.useFakeTimers()
    try {
      const start = vi.fn()
      const runtime = new LarkRuntime({
        settings: () => resolveSettingsConfig({}),
        resolveSecret: async () => undefined,
        start,
      })
      await runtime.reconcile()
      expect(runtime.status()).toMatchObject({ state: 'unconfigured' })
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(start).not.toHaveBeenCalled()
      await runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending retry when the runtime is disposed', async () => {
    vi.useFakeTimers()
    try {
      const start = vi.fn(async () => { throw new Error('offline') })
      const runtime = new LarkRuntime({
        settings: () => resolveSettingsConfig({ appId: 'id' }),
        resolveSecret: async () => 'secret',
        start,
      })
      await runtime.reconcile()
      expect(start).toHaveBeenCalledTimes(1)
      await runtime.dispose()
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(start).toHaveBeenCalledTimes(1)
      expect(runtime.status()).toMatchObject({ state: 'stopped' })
    } finally {
      vi.useRealTimers()
    }
  })
})
