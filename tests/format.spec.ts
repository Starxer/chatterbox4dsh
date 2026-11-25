import { describe, expect, it } from 'vitest'
import { formatDuration, formatDurationPadded, formatTokenCount } from '../src/format.ts'

// One module now owns the three formatters that used to exist five times each;
// these cases pin the exact wording every surface prints (2026-11-25).
describe('formatTokenCount', () => {
  it('keeps sub-thousand counts exact and compacts the rest', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(517)).toBe('517')
    expect(formatTokenCount(1_015)).toBe('1K')
    expect(formatTokenCount(12_340)).toBe('12.3K')
    expect(formatTokenCount(1_240_000)).toBe('1.2M')
  })
})

describe('formatDuration', () => {
  it('formats across the unit boundaries', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(820)).toBe('820ms')
    expect(formatDuration(4_300)).toBe('4.3s')
    expect(formatDuration(60_000)).toBe('1m0s')
    expect(formatDuration(125_000)).toBe('2m5s')
  })

  it('says nothing rather than printing a broken number', () => {
    // These are differences of two timestamps: a missing clock used to render
    // `NaNms` (found while deduplicating, 2026-11-25).
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('formatDurationPadded', () => {
  it('keeps the panel tables aligned on a two-digit seconds field', () => {
    expect(formatDurationPadded(820)).toBe('820ms')
    expect(formatDurationPadded(4_300)).toBe('4.3s')
    expect(formatDurationPadded(125_000)).toBe('2m 05s')
  })

  it('says nothing rather than printing a broken number', () => {
    expect(formatDurationPadded(-1)).toBe('—')
    expect(formatDurationPadded(Number.NaN)).toBe('—')
  })
})
