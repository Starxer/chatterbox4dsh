import { describe, expect, it } from 'vitest'
import {
  RECENT_MODEL_MEMORY,
  isRecentModelEntry,
  mergeRecentModels,
  rememberModel,
  topRecentModels,
  type RecentModelEntry,
} from '../src/recent-models.ts'

function entry(provider: string, model: string, usedAt: number, reasoningEffort?: string): RecentModelEntry {
  return { provider, model, usedAt, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

describe('rememberModel', () => {
  it('puts the newest route first and keeps the effort of that use', () => {
    const list = rememberModel([entry('p', 'old', 1)], { provider: 'q', model: 'new', reasoningEffort: 'high' }, 2)
    expect(list).toEqual([
      { provider: 'q', model: 'new', reasoningEffort: 'high', usedAt: 2 },
      { provider: 'p', model: 'old', usedAt: 1 },
    ])
  })

  it('de-duplicates by provider+model, ignoring the effort', () => {
    const list = rememberModel([
      entry('p', 'm', 1, 'low'),
      entry('q', 'n', 2),
    ], { provider: 'p', model: 'm', reasoningEffort: 'high' }, 3)
    expect(list.map(item => `${item.provider}/${item.model}`)).toEqual(['p/m', 'q/n'])
    expect(list[0]!.reasoningEffort).toBe('high')
  })

  it('bounds the memory', () => {
    let list: readonly RecentModelEntry[] = []
    for (let index = 0; index < RECENT_MODEL_MEMORY + 5; index++) {
      list = rememberModel(list, { provider: 'p', model: `m${index}` }, index)
    }
    expect(list).toHaveLength(RECENT_MODEL_MEMORY)
    expect(list[0]!.model).toBe(`m${RECENT_MODEL_MEMORY + 4}`)
  })
})

describe('topRecentModels', () => {
  it('returns at most three de-duplicated routes, newest first', () => {
    const list = [
      entry('p', 'm1', 4),
      entry('q', 'm2', 3),
      entry('p', 'm1', 2),
      entry('r', 'm3', 1),
    ]
    expect(topRecentModels(list, undefined, 3).map(item => item.model)).toEqual(['m1', 'm2', 'm3'])
  })

  it('leaves out the route the session already runs', () => {
    const list = [entry('p', 'm1', 2), entry('q', 'm2', 1)]
    expect(topRecentModels(list, { provider: 'p', model: 'm1' }, 3).map(item => item.model)).toEqual(['m2'])
  })

  it('returns nothing when only the current route is remembered', () => {
    expect(topRecentModels([entry('p', 'm1', 1)], { provider: 'p', model: 'm1' }, 3)).toEqual([])
  })
})

describe('isRecentModelEntry', () => {
  it('rejects values a corrupted state file might hold', () => {
    expect(isRecentModelEntry(entry('p', 'm', 1))).toBe(true)
    expect(isRecentModelEntry({ provider: 'p', model: '' , usedAt: 1 })).toBe(false)
    expect(isRecentModelEntry({ provider: 'p', model: 'm' })).toBe(false)
    expect(isRecentModelEntry(null)).toBe(false)
    expect(isRecentModelEntry('p/m')).toBe(false)
  })
})


describe('mergeRecentModels', () => {
  it('puts global entries first, then session-only ones, de-duplicated', () => {
    const globals = [entry('p', 'm1', 5), entry('q', 'm2', 4)]
    const merged = mergeRecentModels(globals, [
      { provider: 'q', model: 'm2' },
      { provider: 'r', model: 'm3' },
      { provider: 'r', model: 'm3' },
    ])
    expect(merged.map(item => item.model)).toEqual(['m1', 'm2', 'm3'])
  })

  it('keeps the current route (it is a recent use too) and honours the limit', () => {
    const merged = mergeRecentModels([entry('p', 'current', 1)], [
      { provider: 'q', model: 'other' },
      { provider: 'r', model: 'third' },
    ], 3)
    expect(merged.map(item => item.model)).toEqual(['current', 'other', 'third'])
  })
})
