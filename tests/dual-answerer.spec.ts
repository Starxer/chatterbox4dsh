import { describe, expect, it } from 'vitest'
import { firstDefined, installSignalGate } from '../src/dual-answerer.ts'

describe('firstDefined', () => {
  it('resolves with the first surface that produces an answer', async () => {
    const slow = new Promise<string | undefined>(() => {})
    await expect(firstDefined([Promise.resolve('feishu'), slow])).resolves.toBe('feishu')
  })

  it('ignores surfaces that gave up and waits for a real answer', async () => {
    const later = new Promise<string | undefined>(resolve => setTimeout(() => resolve('web'), 1))
    await expect(firstDefined([Promise.resolve(undefined), later])).resolves.toBe('web')
  })

  it('treats a rejection as giving up rather than failing the race', async () => {
    const answer = new Promise<string | undefined>(resolve => setTimeout(() => resolve('feishu'), 1))
    await expect(firstDefined([Promise.reject(new Error('no Web UI client')), answer])).resolves.toBe('feishu')
  })

  it('resolves undefined only once every surface has given up', async () => {
    await expect(firstDefined([Promise.resolve(undefined), Promise.resolve(undefined)])).resolves.toBeUndefined()
    await expect(firstDefined([])).resolves.toBeUndefined()
  })
})

describe('installSignalGate', () => {
  it('lets the forwarded surface be aborted without touching the caller signal', () => {
    const upstream = new AbortController()
    const request: { signal?: AbortSignal } = { signal: upstream.signal }
    const gate = installSignalGate(request, upstream.signal)
    expect(request.signal).not.toBe(upstream.signal)
    expect(request.signal?.aborted).toBe(false)
    gate.release()
    expect(request.signal?.aborted).toBe(true)
    // Releasing the gate must not abort the caller's own signal.
    expect(upstream.signal.aborted).toBe(false)
  })

  it('still follows the caller signal', () => {
    const upstream = new AbortController()
    const request: { signal?: AbortSignal } = { signal: upstream.signal }
    installSignalGate(request, upstream.signal)
    upstream.abort(new Error('turn cancelled'))
    expect(request.signal?.aborted).toBe(true)
  })

  it('works when the request carried no signal at all', () => {
    const request: { signal?: AbortSignal } = {}
    const gate = installSignalGate(request, undefined)
    expect(request.signal).toBeDefined()
    gate.release()
    expect(request.signal?.aborted).toBe(true)
  })

  it('degrades gracefully when the request cannot be re-pointed', () => {
    const frozen = Object.freeze({})
    expect(() => installSignalGate(frozen, undefined)).not.toThrow()
    const gate = installSignalGate(frozen, undefined)
    expect(() => gate.release()).not.toThrow()
  })
})
