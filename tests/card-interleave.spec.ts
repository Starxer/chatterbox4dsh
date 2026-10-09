import { describe, expect, it, vi } from 'vitest'
import { createCardInterleave } from '../src/card-interleave.ts'

describe('createCardInterleave', () => {
  it('hands every notice to every listener', () => {
    const registry = createCardInterleave()
    const first = vi.fn()
    const second = vi.fn()
    registry.onNotice(first)
    registry.onNotice(second)
    registry.note('oc_1')
    expect(first).toHaveBeenCalledWith('oc_1')
    expect(second).toHaveBeenCalledWith('oc_1')
  })

  it('stops delivering after the unsubscribe function runs', () => {
    const registry = createCardInterleave()
    const listener = vi.fn()
    const off = registry.onNotice(listener)
    registry.note('oc_1')
    off()
    registry.note('oc_2')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('contains a throwing listener so the send that fired it still lands', () => {
    const registry = createCardInterleave()
    const healthy = vi.fn()
    registry.onNotice(() => { throw new Error('listener down') })
    registry.onNotice(healthy)
    expect(() => registry.note('oc_1')).not.toThrow()
    expect(healthy).toHaveBeenCalledWith('oc_1')
  })
})
