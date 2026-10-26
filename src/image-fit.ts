/**
 * Bring an inbound image within the attachment store's pixel limits.
 *
 * The store rejects an image whose WIDTH or HEIGHT exceeds `maxImageDimension`
 * (8192 px by default) or whose decoded pixel count exceeds `maxImagePixels`
 * (64 M) — `IMAGE_DIMENSION_TOO_LARGE` / `IMAGE_TOO_MANY_PIXELS`. A comic strip
 * is the case that surfaced it: 600×8745, i.e. 6.7 % over the per-side cap, so
 * every such message used to die in admission with a bare error line
 * (2026-10-27).
 *
 * A Feishu message cannot be refused as "too tall, send it smaller" — the
 * operator is holding a phone, not an editor. So the plugin fits the image
 * itself: it downsizes (aspect preserved, Lanczos) through `ffmpeg`, which the
 * deployment already needs for video covers, and returns JPEG bytes the store
 * accepts. Callers additionally keep the FULL-RESOLUTION original as a file
 * attachment, because a 3× reduction is fine for "what is in this picture" but
 * not for "crop the character out of panel 4".
 *
 * Everything here is best-effort: an unrecognised container or a missing
 * `ffmpeg` yields `undefined`, and the caller falls back to the original bytes
 * (the store then answers with its own, already-clear error).
 *
 * @module @starxer/chatterbox4dsh/image-fit
 */

import { execFile } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** One resize is a local, cheap operation; never let a stuck ffmpeg hold a turn. */
export const IMAGE_FIT_TIMEOUT_MS = 20_000

/** Intrinsic pixel size of one image. */
export interface ImageDimensions {
  width: number
  height: number
}

/** The subset of the attachment store's limits this module acts on. */
export interface ImageFitLimits {
  /** Per-side pixel cap (`maxImageDimension`). */
  maxDimension: number
  /** Decoded pixel cap (`maxImagePixels`). */
  maxPixels: number
}

/** What a resize seam has to produce (tests inject their own). */
export type ImageResizer = (input: {
  data: Uint8Array
  mediaType: string
  width: number
  height: number
}) => Promise<{ data: Uint8Array; mediaType: string } | undefined>

export interface ImageFitInput {
  data: Uint8Array
  /** Media type detected from the bytes (never guessed). */
  mediaType: string
  limits: ImageFitLimits
  /** Known dimensions (skips header parsing when the caller already has them). */
  dimensions?: ImageDimensions | undefined
  /** Resize seam; defaults to `ffmpeg`. */
  resize?: ImageResizer | undefined
}

export interface ImageFitResult {
  /** Bytes to hand the attachment store. */
  data: Uint8Array
  mediaType: string
  width: number
  height: number
  /** What the source was, for the note the caller tells the agent. */
  original: ImageDimensions
  /** `false` means the bytes were already within the limits and are unchanged. */
  scaled: boolean
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]!)
  return out
}

/** PNG: the IHDR chunk is the first one, straight after the 8-byte signature. */
function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 24) return undefined
  if (u32be(bytes, 0) !== 0x89504e47 || u32be(bytes, 4) !== 0x0d0a1a0a) return undefined
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** GIF: the logical screen descriptor packs both sides as little-endian u16. */
function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'GIF') return undefined
  const width = bytes[6]! | (bytes[7]! << 8)
  const height = bytes[8]! | (bytes[9]! << 8)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/**
 * JPEG: walk the segment chain to the first start-of-frame marker.
 *
 * `0xFFC0`–`0xFFCF` are SOF0…SOF15, but `C4` (Huffman tables), `C8` (reserved)
 * and `CC` (arithmetic coding tables) are not frames.
 */
function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]!
    if (marker === 0xff) { offset += 1; continue }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = u16be(bytes, offset + 2)
    if (length < 2) return undefined
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      if (offset + 9 >= bytes.length) return undefined
      const height = u16be(bytes, offset + 5)
      const width = u16be(bytes, offset + 7)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    offset += 2 + length
  }
  return undefined
}

/** WebP: three container flavours; only the lossy/lossless/extended headers are read. */
function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return undefined
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
    return { width, height }
  }
  if (chunk === 'VP8 ') {
    // Lossy: the frame header sits after the 3-byte start code at offset 23.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff
    const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return undefined
}

/**
 * Intrinsic size from the container header, or `undefined` when the format is
 * not one of the four the deployment accepts. No third-party parser: a wrong
 * guess here would resize untouched images.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  return pngDimensions(bytes) ?? jpegDimensions(bytes) ?? gifDimensions(bytes) ?? webpDimensions(bytes)
}

/**
 * The size that fits both limits, or `undefined` when the source already does.
 *
 * Aspect ratio is preserved; sides are rounded down to even numbers because the
 * `mjpeg` encoder used for the output wants even dimensions.
 */
export function fitDimensions(
  dimensions: ImageDimensions,
  limits: ImageFitLimits,
): ImageDimensions | undefined {
  const { width, height } = dimensions
  if (width <= 0 || height <= 0) return undefined
  const sideScale = limits.maxDimension > 0 ? limits.maxDimension / Math.max(width, height) : 1
  const pixelScale = limits.maxPixels > 0 ? Math.sqrt(limits.maxPixels / (width * height)) : 1
  const scale = Math.min(1, sideScale, pixelScale)
  if (!(scale < 1)) return undefined
  const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2)
  return { width: even(width * scale), height: even(height * scale) }
}

/** Extension used for the temporary ffmpeg input, by detected media type. */
function extensionOf(mediaType: string): string {
  if (mediaType === 'image/png') return 'png'
  if (mediaType === 'image/webp') return 'webp'
  if (mediaType === 'image/gif') return 'gif'
  return 'jpg'
}

/**
 * Default resize: one ffmpeg pass through a temp file, output JPEG.
 *
 * A temp file (not a pipe) because `ffmpeg` needs a seekable input for every
 * format it sniffs; the plugin already depends on `ffmpeg` for video covers, so
 * this adds no new deployment requirement. A missing binary or a failed run is
 * `undefined`, never a throw: the store's own refusal remains the error the
 * caller reports.
 */
const resizeWithFfmpeg: ImageResizer = async ({ data, mediaType, width, height }) => {
  const base = join(tmpdir(), `dsh-feishu-fit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const input = `${base}.${extensionOf(mediaType)}`
  const output = `${base}.jpg`
  try {
    await writeFile(input, data)
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', input,
      '-frames:v', '1',
      '-vf', `scale=${width}:${height}:flags=lanczos`,
      '-q:v', '3',
      '-f', 'image2', output,
    ], { timeout: IMAGE_FIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 })
    const resized = await readFile(output)
    return resized.length === 0 ? undefined : { data: new Uint8Array(resized), mediaType: 'image/jpeg' }
  } catch {
    return undefined
  } finally {
    await unlink(input).catch(() => undefined)
    await unlink(output).catch(() => undefined)
  }
}

/**
 * Fit one inbound image to the store's limits.
 *
 * @returns the bytes to store (unchanged when they already fit), or `undefined`
 *   when the size cannot be known or the resize failed — the caller then hands
 *   the original bytes over and lets the store report its own reason.
 */
export async function fitImageToLimits(input: ImageFitInput): Promise<ImageFitResult | undefined> {
  const original = input.dimensions ?? readImageDimensions(input.data)
  if (original === undefined) return undefined
  const target = fitDimensions(original, input.limits)
  if (target === undefined) {
    return { data: input.data, mediaType: input.mediaType, width: original.width, height: original.height, original, scaled: false }
  }
  const resized = await (input.resize ?? resizeWithFfmpeg)({
    data: input.data,
    mediaType: input.mediaType,
    width: target.width,
    height: target.height,
  })
  if (resized === undefined) return undefined
  return {
    data: resized.data,
    mediaType: resized.mediaType,
    width: target.width,
    height: target.height,
    original,
    scaled: true,
  }
}
