import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fitDimensions,
  fitImageToLimits,
  readImageDimensions,
  type ImageFitLimits,
} from '../src/image-fit.ts'

const execFileAsync = promisify(execFile)

/** 8192 px per side / 64 M pixels — the attachment store's defaults. */
const LIMITS: ImageFitLimits = { maxDimension: 8192, maxPixels: 64_000_000 }

/** Minimal PNG header: signature + IHDR length/type + width/height. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16)
  bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20)
  return bytes
}

/** Minimal GIF87a header with a logical screen descriptor. */
function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13)
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x37, 0x61], 0)
  bytes.set([width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff], 6)
  return bytes
}

/** Minimal JPEG: SOI, an APP0 segment to skip, then SOF0 with the size. */
function jpegHeader(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03]
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof0])
}

describe('readImageDimensions', () => {
  it('reads PNG / JPEG / GIF headers', () => {
    expect(readImageDimensions(pngHeader(600, 8745))).toEqual({ width: 600, height: 8745 })
    expect(readImageDimensions(jpegHeader(600, 8745))).toEqual({ width: 600, height: 8745 })
    expect(readImageDimensions(gifHeader(320, 240))).toEqual({ width: 320, height: 240 })
  })

  it('reads a WebP extended (VP8X) header', () => {
    const bytes = new Uint8Array(30)
    bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
    bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
    bytes.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
    // Canvas size is stored minus one, little-endian 24-bit.
    const store = (value: number, at: number): void => {
      const v = value - 1
      bytes.set([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff], at)
    }
    store(600, 24)
    store(8745, 27)
    expect(readImageDimensions(bytes)).toEqual({ width: 600, height: 8745 })
  })

  it('returns undefined for data it cannot recognise', () => {
    expect(readImageDimensions(Uint8Array.from([1, 2, 3, 4]))).toBeUndefined()
    expect(readImageDimensions(new TextEncoder().encode('not an image at all'))).toBeUndefined()
  })
})

describe('fitDimensions', () => {
  it('scales a long comic strip down to the per-side cap, keeping the aspect', () => {
    expect(fitDimensions({ width: 600, height: 8745 }, LIMITS)).toEqual({ width: 562, height: 8192 })
  })

  it('leaves an image that already fits untouched', () => {
    expect(fitDimensions({ width: 600, height: 5031 }, LIMITS)).toBeUndefined()
    // Exactly at the per-side cap, far under the pixel budget: nothing to do.
    expect(fitDimensions({ width: 8192, height: 100 }, { maxDimension: 8192, maxPixels: 64_000_000 })).toBeUndefined()
  })

  it('also respects the decoded-pixel cap for a big square image', () => {
    // 8192×8192 = 67.1 M pixels, over the 64 M budget: the per-side fit alone
    // would still be refused, so the pixel cap wins.
    const fitted = fitDimensions({ width: 8192, height: 8192 }, LIMITS)
    expect(fitted).toBeDefined()
    expect(fitted!.width * fitted!.height).toBeLessThanOrEqual(LIMITS.maxPixels)
    expect(fitted!.width).toBe(fitted!.height)
  })
})

describe('fitImageToLimits', () => {
  it('returns the original bytes when they already fit', async () => {
    const data = jpegHeader(600, 5031)
    const result = await fitImageToLimits({ data, mediaType: 'image/jpeg', limits: LIMITS })
    expect(result).toMatchObject({ scaled: false, width: 600, height: 5031, mediaType: 'image/jpeg' })
    expect(result!.data).toBe(data)
  })

  it('resizes through the injected seam and reports the target size', async () => {
    const resized = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
    const result = await fitImageToLimits({
      data: jpegHeader(600, 8745),
      mediaType: 'image/png',
      limits: LIMITS,
      resize: async input => {
        expect(input).toMatchObject({ width: 562, height: 8192, mediaType: 'image/png' })
        return { data: resized, mediaType: 'image/jpeg' }
      },
    })
    expect(result).toMatchObject({ scaled: true, width: 562, height: 8192, mediaType: 'image/jpeg' })
    expect(result!.original).toEqual({ width: 600, height: 8745 })
    expect(result!.data).toBe(resized)
  })

  it('gives up (undefined) when the resize cannot run, leaving the store error', async () => {
    const result = await fitImageToLimits({
      data: jpegHeader(600, 8745),
      mediaType: 'image/jpeg',
      limits: LIMITS,
      resize: async () => undefined,
    })
    expect(result).toBeUndefined()
  })

  it('gives up when the dimensions are unknown', async () => {
    const result = await fitImageToLimits({ data: Uint8Array.from([1, 2, 3]), mediaType: 'image/jpeg', limits: LIMITS })
    expect(result).toBeUndefined()
  })
})

/**
 * The default resize really shells out to ffmpeg; on a machine without it the
 * code path degrades to `undefined`, so this case is skipped rather than failed.
 */
const ffmpegAvailable = await execFileAsync('ffmpeg', ['-version']).then(() => true, () => false)

describe.skipIf(!ffmpegAvailable)('fitImageToLimits (real ffmpeg)', () => {
  it('turns a 600×9000 JPEG into a store-legal 546×8192 one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-fit-'))
    try {
      // A tall solid-colour source: the same shape as the comic strips that
      // were refused with IMAGE_DIMENSION_TOO_LARGE on 2026-10-27.
      const source = join(dir, 'tall.jpg')
      await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=600x9000', '-frames:v', '1', source])
      const original = await readFile(source)
      const originalSize = readImageDimensions(original)!
      expect(originalSize).toEqual({ width: 600, height: 9000 })
      const target = fitDimensions(originalSize, LIMITS)!
      expect(target.height).toBe(8192)
      const result = await fitImageToLimits({ data: new Uint8Array(original), mediaType: 'image/jpeg', limits: LIMITS })
      expect(result?.scaled).toBe(true)
      expect(result).toMatchObject({ ...target, mediaType: 'image/jpeg' })
      // The produced bytes are a real image of the promised size.
      expect(readImageDimensions(result!.data)).toEqual(target)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
