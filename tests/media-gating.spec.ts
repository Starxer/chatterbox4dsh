import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ hasMediaBinary: vi.fn() }))

vi.mock('../src/media-binaries.ts', () => ({
  hasMediaBinary: (...args: unknown[]) => mocks.hasMediaBinary(...args),
  resetMediaBinaryCache: () => undefined,
}))

import { fitImageToLimits } from '../src/image-fit.ts'

/** A real 1x1 PNG, so the header parser sees a genuine image. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

beforeEach(() => {
  mocks.hasMediaBinary.mockReset()
})

describe('ffmpeg-less degradation', () => {
  it('does not attempt the default image resize when ffmpeg is missing', async () => {
    mocks.hasMediaBinary.mockResolvedValue(false)
    // A limit below the image's intrinsic size forces the resize path, which is
    // now gated: without ffmpeg the bytes are left alone (the caller keeps the
    // original and the card sends the file instead).
    const fitted = await fitImageToLimits({
      data: new Uint8Array(PNG_1X1),
      mediaType: 'image/png',
      // Larger than the limits (the bytes are only a 1x1 header fixture), so the
      // resize path is genuinely entered.
      dimensions: { width: 4_000, height: 2_000 },
      limits: { maxDimension: 1_000, maxPixels: 1_000_000 },
      logger: { warn: vi.fn() },
    })
    expect(fitted).toBeUndefined()
    expect(mocks.hasMediaBinary).toHaveBeenCalledWith('ffmpeg', { warn: expect.any(Function) })
  })

  it('keeps an image that already fits, with no binary probe at all', async () => {
    const fitted = await fitImageToLimits({
      data: new Uint8Array(PNG_1X1),
      mediaType: 'image/png',
      limits: { maxDimension: 8000, maxPixels: 40_000_000 },
    })
    expect(fitted?.scaled).toBe(false)
    expect(mocks.hasMediaBinary).not.toHaveBeenCalled()
  })
})
