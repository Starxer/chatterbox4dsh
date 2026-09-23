/**
 * Feishu uploads for card media (images, video, audio) plus the two ffmpeg /
 * ffprobe helpers the card path needs.
 *
 * A card can only reference media Feishu itself handed out a key for: images
 * take an `img_v3_…` key from `im.v1.image.create`, video and audio take a
 * `file_v3_…` key from `im.v1.file.create` with `file_type: 'mp4'` / `'opus'`
 * (verified against the component docs, 2026-09-24). Everything here is
 * best-effort: a file that cannot be measured, transcoded or uploaded returns
 * `undefined`, and the caller leaves the model's reference as readable text —
 * a media upload must never cost the message.
 *
 * Two conversions are deliberately confined to this module:
 *
 *  - `mov` → `mp4` remux (`-c copy`): the card video component accepts the MP4
 *    container only, while the model's screen recordings are usually QuickTime.
 *  - `wav` / `mp3` / `m4a` / `flac` → Ogg/Opus: the card audio component plays
 *    Opus only.
 *
 * Both need `ffmpeg` on PATH; without it the reference stays text, exactly like
 * the poster-frame path in `feishu-send-file.ts`.
 *
 * @module @starxer/chatterbox4dsh/media-upload
 */

import { execFile } from 'node:child_process'
import { readFile, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { AudioFormatId } from './media-sniff.ts'
import { withTimeout } from './outbound-timeout.ts'

const execFileAsync = promisify(execFile)

/** ffmpeg/ffprobe work is a nicety: never let a slow child hold the card back. */
export const MEDIA_TOOL_TIMEOUT_MS = 20_000
/** One upload's hard bound (the card-level budget is usually tighter). */
export const MEDIA_UPLOAD_TIMEOUT_MS = 30_000

/** Minimal logger surface; matches ctx.logger's call style. */
export interface MediaUploadLogger {
  warn(message: string): unknown
}

/** A video uploaded for the card's `video` element. */
export interface UploadedVideo {
  /** `file_v3_…` key for the card element. */
  fileKey: string
  /** Cover image key, when ffmpeg could extract and upload one. */
  coverKey?: string
  /** Duration in milliseconds, when the file could be measured. */
  durationMs?: number
}

/** An audio file uploaded for a card `<audio>` element. */
export interface UploadedAudio {
  /** `file_v3_…` key for the card element. */
  fileKey: string
  /** Duration in milliseconds, when the file could be measured. */
  durationMs?: number
}

/** What the card hydrator needs from Feishu. */
export interface MediaUploader {
  /** Upload one image and return its `img_v3_…` key. */
  image(path: string): Promise<string | undefined>
  /** Upload (remuxing QuickTime to MP4 when needed) and return the video keys. */
  video(path: string, container: 'mp4' | 'mov'): Promise<UploadedVideo | undefined>
  /** Upload one audio file, transcoding it to Opus unless it already is. */
  audio(path: string, format: AudioFormatId): Promise<UploadedAudio | undefined>
}

export interface MediaUploaderDeps {
  /** Live channel accessor; `undefined` before the connection is up. */
  channel: () => LarkChannel | undefined
  logger: MediaUploadLogger
  /** Test seam for the ffprobe-backed duration reader. */
  probeDurationMs?: (path: string) => Promise<number | undefined>
  /** Test seam for the `mov` → `mp4` remux. */
  remuxToMp4?: (path: string) => Promise<string | undefined>
  /** Test seam for the audio → Opus transcode. */
  transcodeToOpus?: (path: string) => Promise<string | undefined>
  /** Test seam for the poster-frame extractor. */
  extractCoverFrame?: (path: string) => Promise<Buffer | undefined>
}

/** One temp path that never collides with a concurrent extraction. */
function tempPath(suffix: string): string {
  return join(tmpdir(), `dsh-feishu-media-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`)
}

/** Read a media duration with ffprobe; `undefined` when it cannot be measured. */
async function probeDurationWithFfprobe(path: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
      { timeout: MEDIA_TOOL_TIMEOUT_MS, windowsHide: true },
    )
    const seconds = Number.parseFloat(String(stdout).trim())
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined
    return Math.round(seconds * 1000)
  } catch {
    return undefined
  }
}

/** One ffmpeg conversion into a temp file; `undefined` when it did not run. */
async function convertWithFfmpeg(
  input: string,
  suffix: string,
  args: string[],
): Promise<string | undefined> {
  const out = tempPath(suffix)
  try {
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, ...args, out],
      { timeout: MEDIA_TOOL_TIMEOUT_MS, windowsHide: true })
    const info = await stat(out).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.size === 0) {
      await unlink(out).catch(() => undefined)
      return undefined
    }
    return out
  } catch {
    await unlink(out).catch(() => undefined)
    return undefined
  }
}

/**
 * One frame as a JPEG cover. Feishu's video card element does not derive a
 * cover from the file, so the sender supplies one or the cover stays black.
 * The 1s mark is tried first (a black first frame is common), the very first
 * frame is the fallback for clips shorter than that.
 */
async function extractCoverWithFfmpeg(path: string): Promise<Buffer | undefined> {
  for (const seek of [['-ss', '1'], []]) {
    const out = tempPath('.jpg')
    try {
      await execFileAsync('ffmpeg',
        ['-y', '-loglevel', 'error', ...seek, '-i', path, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2', out],
        { timeout: MEDIA_TOOL_TIMEOUT_MS, windowsHide: true })
      const frame = await readFile(out).catch(() => undefined)
      if (frame !== undefined && frame.length > 0) return frame
    } catch {
      // Try the next seek position.
    } finally {
      await unlink(out).catch(() => undefined)
    }
  }
  return undefined
}

/**
 * Build the uploader the card hydrator uses. One instance per plugin: the
 * channel reference is live (reconnects swap it) while the seams stay fixed.
 *
 * @param deps - channel accessor, logger and optional test seams.
 */
export function createMediaUploader(deps: MediaUploaderDeps): MediaUploader {
  const probe = deps.probeDurationMs ?? probeDurationWithFfprobe
  const remux = deps.remuxToMp4 ?? ((path: string) => convertWithFfmpeg(path, '.mp4', ['-c', 'copy', '-movflags', '+faststart']))
  const transcode = deps.transcodeToOpus ?? ((path: string) => convertWithFfmpeg(path, '.opus', ['-vn', '-c:a', 'libopus', '-b:a', '96k']))
  const cover = deps.extractCoverFrame ?? extractCoverWithFfmpeg

  const warn = (message: string): void => {
    deps.logger.warn(`dsh-feishu: ${message}`)
  }

  const client = (): LarkChannel => {
    const channel = deps.channel()
    if (channel === undefined) throw new Error('channel not connected')
    return channel
  }

  /** Upload one image buffer as a message image and return its key. */
  const uploadImageBuffer = async (image: Buffer): Promise<string | undefined> => {
    const uploaded = await withTimeout(
      client().rawClient.im.v1.image.create({ data: { image_type: 'message', image } }),
      'upload card image',
      MEDIA_UPLOAD_TIMEOUT_MS,
    ) as { image_key?: string } | undefined
    const key = uploaded?.image_key
    return key === undefined || key === '' ? undefined : key
  }

  return {
    async image(path: string): Promise<string | undefined> {
      try {
        return await uploadImageBuffer(await readFile(path))
      } catch (error: unknown) {
        warn(`card image upload failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    },

    async video(path: string, container: 'mp4' | 'mov'): Promise<UploadedVideo | undefined> {
      let uploadPath = path
      let temp: string | undefined
      try {
        if (container === 'mov') {
          temp = await remux(path)
          if (temp === undefined) {
            warn(`card video ${path} is QuickTime and could not be remuxed to MP4; left as text`)
            return undefined
          }
          uploadPath = temp
        }
        const durationMs = await probe(uploadPath)
        const uploaded = await withTimeout(
          client().rawClient.im.v1.file.create({
            data: {
              file_type: 'mp4',
              file_name: `${basename(path).replace(/\.[^.]*$/u, '')}.mp4`,
              ...(durationMs === undefined ? {} : { duration: durationMs }),
              file: await readFile(uploadPath),
            },
          }),
          'upload card video',
          MEDIA_UPLOAD_TIMEOUT_MS,
        ) as { file_key?: string } | undefined
        const fileKey = uploaded?.file_key
        if (fileKey === undefined || fileKey === '') {
          warn(`card video upload returned no file_key for ${path}; left as text`)
          return undefined
        }
        let coverKey: string | undefined
        try {
          const frame = await cover(uploadPath)
          if (frame !== undefined) coverKey = await uploadImageBuffer(frame)
        } catch (error: unknown) {
          warn(`card video cover failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
        }
        return { fileKey, ...(coverKey === undefined ? {} : { coverKey }), ...(durationMs === undefined ? {} : { durationMs }) }
      } catch (error: unknown) {
        warn(`card video upload failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      } finally {
        if (temp !== undefined) await unlink(temp).catch(() => undefined)
      }
    },

    async audio(path: string, format: AudioFormatId): Promise<UploadedAudio | undefined> {
      let uploadPath = path
      let temp: string | undefined
      try {
        if (format !== 'opus') {
          temp = await transcode(path)
          if (temp === undefined) {
            warn(`card audio ${path} is ${format} and could not be transcoded to Opus; left as text`)
            return undefined
          }
          uploadPath = temp
        }
        const durationMs = await probe(uploadPath)
        const uploaded = await withTimeout(
          client().rawClient.im.v1.file.create({
            data: {
              file_type: 'opus',
              file_name: `${basename(path).replace(/\.[^.]*$/u, '')}.opus`,
              ...(durationMs === undefined ? {} : { duration: durationMs }),
              file: await readFile(uploadPath),
            },
          }),
          'upload card audio',
          MEDIA_UPLOAD_TIMEOUT_MS,
        ) as { file_key?: string } | undefined
        const fileKey = uploaded?.file_key
        if (fileKey === undefined || fileKey === '') {
          warn(`card audio upload returned no file_key for ${path}; left as text`)
          return undefined
        }
        return { fileKey, ...(durationMs === undefined ? {} : { durationMs }) }
      } catch (error: unknown) {
        warn(`card audio upload failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      } finally {
        if (temp !== undefined) await unlink(temp).catch(() => undefined)
      }
    },
  }
}
