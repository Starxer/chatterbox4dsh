import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mocks.execFile(...args),
}))

import { RECHECK_AFTER_MS, hasMediaBinary, resetMediaBinaryCache } from '../src/media-binaries.ts'

/** Make the next probe resolve successfully. */
function probeSucceeds(): void {
  mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout?: string) => void) => {
    done(null, 'ffmpeg version 7')
  })
}

/** Make the next probe fail the way a missing binary does. */
function probeMisses(): void {
  mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, done: (error: Error) => void) => {
    done(new Error('spawn ffmpeg ENOENT'))
  })
}

beforeEach(() => {
  resetMediaBinaryCache()
  mocks.execFile.mockReset()
})

describe('hasMediaBinary', () => {
  it('reports a present binary and asks only once', async () => {
    probeSucceeds()
    expect(await hasMediaBinary('ffmpeg')).toBe(true)
    expect(await hasMediaBinary('ffmpeg')).toBe(true)
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(mocks.execFile.mock.calls[0]?.[0]).toBe('ffmpeg')
    expect(mocks.execFile.mock.calls[0]?.[1]).toEqual(['-version'])
  })

  it('reports a missing binary, logs the notice once, and remembers it', async () => {
    probeMisses()
    const warn = vi.fn()
    expect(await hasMediaBinary('ffmpeg', { warn })).toBe(false)
    expect(await hasMediaBinary('ffmpeg', { warn })).toBe(false)
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('ffmpeg was not found')
  })

  it('checks a missing binary again after the re-check window', async () => {
    vi.useFakeTimers()
    try {
      probeMisses()
      expect(await hasMediaBinary('ffprobe')).toBe(false)
      probeSucceeds()
      vi.setSystemTime(Date.now() + RECHECK_AFTER_MS + 1)
      expect(await hasMediaBinary('ffprobe')).toBe(true)
      expect(mocks.execFile).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the two binaries independent', async () => {
    mocks.execFile.mockImplementation((file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout?: string) => void) => {
      if (file === 'ffmpeg') done(null, 'ffmpeg version 7')
      else done(new Error('spawn ffprobe ENOENT'))
    })
    expect(await hasMediaBinary('ffmpeg')).toBe(true)
    expect(await hasMediaBinary('ffprobe')).toBe(false)
  })
})
