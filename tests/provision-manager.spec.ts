import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ provisionApp: vi.fn() }))

vi.mock('../src/provision.ts', () => ({
  provisionApp: (...args: unknown[]) => mocks.provisionApp(...args),
}))

import { PROVISION_START_TIMEOUT_MS, ProvisionManager } from '../src/provision-manager.ts'
import type { ProvisionState } from '../src/provision.ts'

/** The slice of `provisionApp` options the manager hands over. */
interface OptionsLike {
  signal: AbortSignal
  onState(state: ProvisionState): void
}

function harness(timeoutMs?: number) {
  const states: ProvisionState[] = []
  const onProvisioned = vi.fn(async () => undefined)
  const manager = new ProvisionManager({
    domain: () => 'feishu',
    onState: state => { states.push(state) },
    onProvisioned,
    ...(timeoutMs === undefined ? {} : { startTimeoutMs: timeoutMs }),
  })
  return { manager, states, onProvisioned }
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.provisionApp.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ProvisionManager start deadline', () => {
  it('reports a start-timeout instead of waiting forever when no QR url arrives', async () => {
    // `registerApp`'s first request ignores the abort signal, so without this
    // deadline a machine that cannot reach open.feishu.cn hangs silently and
    // the panel shows nothing at all ("扫码窗口打不开").
    let signal: AbortSignal | undefined
    mocks.provisionApp.mockImplementation((options: OptionsLike) => {
      signal = options.signal
      return new Promise(() => undefined)
    })

    const { manager, states } = harness()
    manager.start()
    expect(states.at(-1)).toMatchObject({ phase: 'waiting' })
    expect(manager.isRunning()).toBe(true)

    await vi.advanceTimersByTimeAsync(PROVISION_START_TIMEOUT_MS)

    expect(states.at(-1)).toMatchObject({ phase: 'error', errorCode: 'start-timeout' })
    expect(states.at(-1)?.message).toMatch(/open\.feishu\.cn/u)
    expect(signal?.aborted).toBe(true)
    expect(manager.isRunning()).toBe(false)
  })

  it('cancels the deadline once the QR url arrives and still completes', async () => {
    let settle: (() => void) | undefined
    mocks.provisionApp.mockImplementation((options: OptionsLike) => {
      options.onState({ phase: 'waiting', qrUrl: 'https://scan.example/verify' })
      return new Promise(resolve => {
        settle = () => resolve({ appId: 'cli_test', appSecret: 'app-secret' })
      })
    })

    const { manager, states, onProvisioned } = harness()
    manager.start()
    expect(states.at(-1)).toMatchObject({ phase: 'waiting', qrUrl: 'https://scan.example/verify' })

    // Twice the deadline would have fired by now if the QR had not cleared it.
    await vi.advanceTimersByTimeAsync(PROVISION_START_TIMEOUT_MS * 2)
    expect(states.some(state => state.phase === 'error')).toBe(false)

    settle?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toEqual({ phase: 'done' })
    expect(onProvisioned).toHaveBeenCalledWith({ appId: 'cli_test', appSecret: 'app-secret' })
  })

  it('ignores a run that settles after it timed out', async () => {
    let settle: (() => void) | undefined
    mocks.provisionApp.mockImplementation(() => new Promise(resolve => {
      settle = () => resolve({ appId: 'cli_late', appSecret: 'late-secret' })
    }))

    const { manager, states, onProvisioned } = harness()
    manager.start()
    await vi.advanceTimersByTimeAsync(PROVISION_START_TIMEOUT_MS)
    expect(states.at(-1)).toMatchObject({ phase: 'error', errorCode: 'start-timeout' })

    settle?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toMatchObject({ phase: 'error', errorCode: 'start-timeout' })
    expect(onProvisioned).not.toHaveBeenCalled()
    expect(manager.isRunning()).toBe(false)
  })

  it('clears the deadline on dispose', async () => {
    mocks.provisionApp.mockImplementation(() => new Promise(() => undefined))
    const { manager, states } = harness()
    manager.start()
    manager.dispose()
    await vi.advanceTimersByTimeAsync(PROVISION_START_TIMEOUT_MS * 2)

    expect(states.at(-1)).toEqual({ phase: 'idle' })
    expect(states.some(state => state.phase === 'error')).toBe(false)
  })
})
