import { describe, expect, it, vi } from 'vitest'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import { LarkRuntime, type LarkRuntimeStart } from '../src/runtime.ts'
import { resolveSettingsConfig } from '../src/config.ts'

function fakeStart(stop: () => Promise<void>): LarkRuntimeStart {
  // The channel field is opaque to LarkRuntime; tests never read it. Returning
  // an empty stub keeps the surface narrow while satisfying the type.
  return { stop, channel: {} as LarkChannel }
}

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
  })

  it('moves to an error state when credential resolution fails', async () => {
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({ appId: 'id' }),
      resolveSecret: async () => { throw new Error('credential backend unavailable') },
      start: vi.fn(),
    })
    await runtime.reconcile()
    expect(runtime.status()).toEqual({ state: 'error', message: 'credential backend unavailable' })
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
