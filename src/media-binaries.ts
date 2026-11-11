/**
 * Availability of the optional external media tools (`ffmpeg` / `ffprobe`).
 *
 * They are **optional** on purpose: a deployment that does not install them
 * still receives and sends images, files and MP4 video, it only loses video
 * covers, MOV→MP4 remuxing, non-Opus audio inline and oversized-image
 * downscaling. Those are exactly the paths that must stay quiet when the tools
 * are absent, so the plugin asks here once instead of spawning the binary (and
 * logging a failure) for every file.
 *
 * The check itself is a `-version` spawn: cheap, but still a process, so results
 * are cached. A positive answer is kept for the life of the process (a removed
 * binary is not worth re-checking); a negative one is retried after
 * {@link RECHECK_AFTER_MS}, so installing ffmpeg while DSH runs starts working
 * without a restart.
 *
 * @module @starxer/chatterbox4dsh/media-binaries
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The two external tools this plugin may use. */
export type MediaBinary = 'ffmpeg' | 'ffprobe'

/** One probe is a local process start; never let a stuck one linger. */
const DETECT_TIMEOUT_MS = 5_000
/** How long a "not installed" answer is trusted before it is checked again. */
export const RECHECK_AFTER_MS = 5 * 60_000

export interface MediaBinaryLogger {
  warn(message: string): unknown
}

interface Availability {
  available: boolean
  checkedAt: number
}

const cache = new Map<MediaBinary, Availability>()
const inFlight = new Map<MediaBinary, Promise<boolean>>()
const warned = new Set<MediaBinary>()

/** Run `name -version` and report whether it started at all. */
async function probe(name: MediaBinary): Promise<boolean> {
  try {
    await execFileAsync(name, ['-version'], { timeout: DETECT_TIMEOUT_MS, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * Whether one media tool is on `PATH`, deduplicating concurrent probes.
 *
 * @param name - the binary to look for.
 * @param logger - optional sink for the one-time "not installed" notice.
 * @returns `true` when `name -version` exited successfully.
 */
export async function hasMediaBinary(name: MediaBinary, logger?: MediaBinaryLogger): Promise<boolean> {
  const known = cache.get(name)
  const now = Date.now()
  if (known !== undefined && (known.available || now - known.checkedAt < RECHECK_AFTER_MS)) {
    if (!known.available) warnMissing(name, logger)
    return known.available
  }
  let pending = inFlight.get(name)
  if (pending === undefined) {
    pending = probe(name)
      .then((available) => {
        cache.set(name, { available, checkedAt: Date.now() })
        return available
      })
      .finally(() => { inFlight.delete(name) })
    inFlight.set(name, pending)
  }
  const available = await pending
  if (!available) warnMissing(name, logger)
  return available
}

/** Forget every cached answer (tests, or a manual re-check). */
export function resetMediaBinaryCache(): void {
  cache.clear()
  inFlight.clear()
  warned.clear()
}

function warnMissing(name: MediaBinary, logger: MediaBinaryLogger | undefined): void {
  if (logger === undefined || warned.has(name)) return
  warned.add(name)
  if (name === 'ffmpeg') {
    logger.warn('dsh-feishu: ffmpeg was not found on PATH — video covers, MOV→MP4 remuxing, non-Opus audio inline and oversized-image downscaling are off;'
      + ' media that cannot be inlined is still delivered as a file. Install ffmpeg to re-enable them (the check is retried in 5 minutes).')
    return
  }
  logger.warn('dsh-feishu: ffprobe was not found on PATH — media durations are sent empty (Feishu then derives or omits them);'
    + ' the rest of the media pipeline is unaffected. The check is retried in 5 minutes.')
}
