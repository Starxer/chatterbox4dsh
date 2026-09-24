/**
 * Inline local media in Feishu cards: images, video and audio.
 *
 * The model writes workspace paths in its Markdown because the DSH Web UI
 * resolves them (`[图](runs/a.png)`, `[clip](runs/a.mp4)`, `` `voice.opus` ``),
 * but a Feishu card can only render media Feishu itself handed out a key for:
 * an `img_v3_…` image key, a `file_v3_…` video key, or a `file_v3_…` Opus key.
 * This module closes that gap — the reference is resolved against the session's
 * own workspace, uploaded, and the card is rewritten:
 *
 * | model writes                       | Feishu gets                                  |
 * |------------------------------------|----------------------------------------------|
 * | `![alt](runs/a.png)` / `[alt](a.png)` | `![alt](img_v3_…)` (inline picture)        |
 * | `[clip](runs/a.mp4)`               | a sibling `{tag:'video'}` element + cover    |
 * | `[voice](runs/a.opus)`             | inline `<audio file_key='file_v3_…'>` player |
 * | anything else                      | untouched — the writer degrades it to text   |
 *
 * Cards that end up carrying video or audio also get `config.enable_forward =
 * false`, which Feishu REQUIRES for those components (the card otherwise fails
 * to send at all).
 *
 * Everything is best-effort and bounded, because the fallback already exists:
 * whatever cannot be uploaded stays text and the card still renders (never the
 * other way round — a picture must not cost a message). "Video/audio is a card
 * element, not markdown" is why the rewrite can split one markdown element into
 * several: `{tag:'video'}` cannot live inside a rich-text component.
 *
 * The bounds are OUR UX choices, not Feishu's (see {@link DEFAULT_MAX_PER_CARD}
 * for the measured card limits), and the cost they exist for is TIME. Three
 * things keep that cost off the card: uploads run with a small concurrency, the
 * per-call budget bounds the wait, and {@link CardImagesHandle.warm} fills the
 * cache from the streaming text so the write that needs the keys usually finds
 * them ready. A reference that still does not make it stays readable text.
 *
 * Privacy: uploading publishes the file to Feishu. The scope is deliberately
 * narrow — only paths written as a Markdown image/link destination, only files
 * that live inside the session's own workspace (checked on the REAL path, so a
 * symlink pointing out is refused), only recognised media formats, and only up
 * to the per-kind byte caps.
 *
 * The file keeps its historical name; it started as the L3 image work
 * (2026-09-23) and covers every card media kind as of 2026-09-24.
 *
 * @module @starxer/chatterbox4dsh/card-images
 */

import { open, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { CardImageMode } from './config.ts'
import { classifyMedia, sniffAudioFormat, sniffImageMime, sniffVideoContainer, type AudioFormatId } from './media-sniff.ts'
import { isFeishuImageKey, mapCardMarkdownReferences } from './card-markdown.ts'
import { withTimeout } from './outbound-timeout.ts'

/** Feishu's image-message limit; a card reference larger than this is pointless. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
/** Feishu's file limit (`im.v1.file.create`); card video/audio share it. */
export const DEFAULT_MAX_FILE_BYTES = 30 * 1024 * 1024
/**
 * Most images one card may pull in — a runaway answer must not upload forever.
 *
 * These caps are OUR UX bound, not Feishu's. Measured against the live API on
 * 2026-09-24 (`cardkit.v1.card.create`, negative control included): a card may
 * hold **200 elements or components**, and a `video` element carrying `cover` +
 * `fallback` spends THREE of them, so Feishu itself accepted **66 videos** in
 * one card and refused 67 with `300305 element exceeds the limit` (198 videos
 * without a cover, 199 inline `<audio>` tags, 200 plain elements: all fine).
 * The second Feishu bound is ~30 KB of card JSON (`200860`), which 66 videos
 * (19.8 KB) do not reach. So a card could carry ~5x this cap; 12 is where a
 * chat message stays readable, and the wall-clock budget still bounds the work.
 */
export const DEFAULT_MAX_PER_CARD = 12
/**
 * Most video/audio items one card may pull in. Every one is a whole file upload
 * (and possibly an ffmpeg remux/transcode), which is why this stayed at 2 until
 * the caps were measured: the cost is TIME, and time is handled by uploading
 * concurrently and by warming the cache while the model is still typing — not
 * by refusing the file and printing its path instead.
 */
export const DEFAULT_MAX_MEDIA_PER_CARD = 12
/**
 * How many uploads one card may have in flight. Each one reads its whole file
 * into memory (`im.v1.file.create` takes a buffer), so this also bounds the
 * peak: 3 x 30 MB worst case. Feishu's own limit is 50 requests/second, so the
 * concurrency is ours to choose and 3 keeps a six-clip answer to one round trip
 * instead of six.
 */
export const UPLOAD_CONCURRENCY = 3
/** How many resolved paths keep their key / failure. */
export const DEFAULT_MAX_CACHED = 256
/** A path that failed is retried after this long (the file may appear later). */
export const NEGATIVE_TTL_MS = 60_000
/**
 * Total time one card may spend uploading IMAGES. A step card carries the
 * answer, so a slow upload must never hold the message back — whatever is left
 * over simply stays text (and the next card update picks it up from the cache).
 */
export const DEFAULT_BUDGET_MS = 6_000
/**
 * Total time one card may spend on video/audio. Larger than the image budget
 * because a media reference is usually the point of the message and the file
 * may need remuxing/transcoding first; still bounded, and the in-flight upload
 * keeps running to fill the cache for the next card update either way.
 */
export const DEFAULT_MEDIA_BUDGET_MS = 15_000
/** Bytes read for the head sniff (enough for every magic number we look for). */
const SNIFF_BYTES = 64

/** A video/audio item resolved into Feishu keys. */
export type ResolvedMedia =
  | { kind: 'image'; key: string }
  | { kind: 'audio'; key: string }
  | { kind: 'video'; key: string; coverKey?: string }

/** What a file's bytes turned out to be, from {@link inspect}. */
type Inspected =
  | { kind: 'image' }
  | { kind: 'video'; container: 'mp4' | 'mov' }
  | { kind: 'audio'; format: AudioFormatId }

/** A target resolved onto a real file inside the workspace. */
interface Located {
  /** The REAL path (symlinks already resolved). */
  path: string
  /** `mtimeMs:size`, the cache key that invalidates an upload. */
  stamp: string
  size: number
}

export interface CardImageDeps {
  /** The workspace a session runs in; relative paths resolve against it. */
  resolveWorkspace: (sessionId: string) => Promise<string | undefined>
  /** Upload one local image and return its Feishu image key. */
  upload: (absolutePath: string) => Promise<string | undefined>
  /**
   * Upload one video for a card `video` element. `container` is what the bytes
   * sniffed as, so the uploader knows whether an MP4 remux is needed.
   */
  uploadVideo?: (absolutePath: string, container: 'mp4' | 'mov') => Promise<{ fileKey: string; coverKey?: string } | undefined>
  /** Upload one audio file (transcoding to Opus when needed) for `<audio>`. */
  uploadAudio?: (absolutePath: string, format: AudioFormatId) => Promise<{ fileKey: string } | undefined>
  logger: { warn(message: string): unknown }
  maxBytes?: number
  maxFileBytes?: number
  maxPerCard?: number
  maxMediaPerCard?: number
  maxCached?: number
  /**
   * Read the CURRENT image mode (live, so a settings write applies without a
   * restart). Defaults to `workspace`.
   */
  mode?: () => CardImageMode | undefined
  /** Wall-clock budget for one `hydrate` call's images. */
  budgetMs?: number
  /** Wall-clock budget for one `hydrate` call's video/audio. */
  mediaBudgetMs?: number
  /** How long a failed path is remembered before it is retried. */
  negativeTtlMs?: number
}

/** Where the card's paths should be resolved. `workspace` wins when known. */
export interface CardImageScope {
  sessionId?: string
  workspace?: string
}

/** Per-call overrides for one hydration run. */
export interface CardImageHydrateOptions {
  /**
   * Whether a path that cannot be resolved is remembered as a failure for
   * {@link NEGATIVE_TTL_MS}. Warm-up runs pass `false`: a path seen in streaming
   * text may name a file the running tool has not written yet, and teaching the
   * real card write that it is missing would cost the media for a whole minute
   * (key pitfall 44).
   */
  recordFailure?: boolean
  /** Wall-clock budget for this call's images (default: the instance's). */
  budgetMs?: number
  /** Wall-clock budget for this call's video/audio (default: the instance's). */
  mediaBudgetMs?: number
}

/**
 * What callers receive: rewrite a card so its local media references render.
 * Never rejects — a reference that cannot be resolved is left for the writer to
 * degrade to text.
 */
export type CardImageHydrator = (
  card: object,
  scope: CardImageScope,
  options?: CardImageHydrateOptions,
) => Promise<object>

export interface CardImagesHandle {
  /**
   * Rewrite every inlinable media reference of a card to a Feishu key / element.
   * Never rejects; on any failure the card is returned with the reference
   * unchanged, which the writer turns into readable text.
   */
  hydrate: CardImageHydrator
  /**
   * Resolve the card's media WITHOUT rewriting it, to have the uploads (and the
   * Feishu keys they produce) ready before the card that needs them is written.
   *
   * Called while the model is still streaming, so the card write that follows
   * finds a warm cache instead of paying the upload itself. Fire-and-forget by
   * design: the result is discarded, failures are already handled inside, and
   * nothing here may reject.
   */
  warm(card: object, scope: CardImageScope): void
  dispose(): void
}

interface CachedMedia {
  /** `mtimeMs:size` of the file the entry was inspected for. */
  stamp: string
  /** `undefined` means "inspected, not inline-able" — the negative fast path. */
  media?: ResolvedMedia
}

/** One reference found in the card's markdown. */
export interface CardMediaTarget {
  /** The destination exactly as written. */
  target: string
  /** `true` for `![alt](target)`, `false` for `[label](target)`. */
  image: boolean
}

/** A local path to inline: not an image key and not a URL. */
function isLocalCandidate(target: string): boolean {
  const value = target.trim()
  if (value === '' || isFeishuImageKey(value)) return false
  if (value.startsWith('#')) return false
  if (value.startsWith('//')) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false
  return true
}

/** Decode one URL escape sequence, leaving a malformed target as written. */
function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/** The spellings of one destination worth trying as a path, most specific first. */
function pathCandidates(target: string): string[] {
  const decoded = decodeTarget(target.trim())
  const withoutFragment = decoded.split('#')[0] ?? decoded
  return [...new Set([decoded, withoutFragment].filter(value => value !== ''))]
}

/**
 * Collect the distinct local media targets of a card's markdown, in order.
 * Images first is not guaranteed — the writer's order is kept so the rendered
 * card reads like the model wrote it.
 */
export function collectMediaTargets(card: object, limit: number): CardMediaTarget[] {
  const targets: CardMediaTarget[] = []
  const seen = new Set<string>()
  const walk = (node: unknown): void => {
    if (targets.length >= limit) return
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry)
      return
    }
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (record.tag === 'markdown' && typeof record.content === 'string') {
      mapCardMarkdownReferences(record.content, (reference) => {
        if (isLocalCandidate(reference.target) && !seen.has(reference.target)) {
          seen.add(reference.target)
          targets.push({ target: reference.target, image: reference.image })
        }
        return reference.raw
      })
    }
    for (const value of Object.values(record)) walk(value)
  }
  walk(card)
  return targets.slice(0, limit)
}

/**
 * The image-only subset, kept for callers that reason about pictures alone
 * (and for the original L3 test surface).
 */
export function collectImageTargets(card: object, limit: number): string[] {
  return collectMediaTargets(card, limit).filter(entry => entry.image).map(entry => entry.target)
}

/** Whether the first bytes start an ISO-BMFF box (`ftyp`), i.e. MP4/MOV/M4A. */
function isIsoBmffHead(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
}

/**
 * Create the media hydrator. One instance per plugin: the key cache must be
 * shared, because the same file is referenced by several cards of a turn (and
 * re-rendered on every card update).
 *
 * @param deps - workspace resolver, uploaders, logger and the bounds.
 */
export function startCardImages(deps: CardImageDeps): CardImagesHandle {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxPerCard = deps.maxPerCard ?? DEFAULT_MAX_PER_CARD
  const maxMediaPerCard = deps.maxMediaPerCard ?? DEFAULT_MAX_MEDIA_PER_CARD
  const maxCached = deps.maxCached ?? DEFAULT_MAX_CACHED
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS
  const mediaBudgetMs = deps.mediaBudgetMs ?? DEFAULT_MEDIA_BUDGET_MS
  const mode = (): CardImageMode => deps.mode?.() ?? 'workspace'
  const negativeTtlMs = deps.negativeTtlMs ?? NEGATIVE_TTL_MS
  /** abs path → what it resolved to, invalidated when the file's stamp changes. */
  const entries = new Map<string, CachedMedia>()
  /** request → when it failed, so a missing file is not re-stat-ed every update. */
  const failed = new Map<string, number>()
  /** `kind\0path` → in-flight upload, so two cards do not upload the same file twice. */
  const pending = new Map<string, Promise<ResolvedMedia | undefined>>()

  const bound = (map: Map<string, unknown>): void => {
    while (map.size > maxCached) {
      const oldest = map.keys().next().value
      if (oldest === undefined) return
      map.delete(oldest)
    }
  }

  /**
   * Resolve one target to a real file inside the workspace. Checked on the REAL
   * path so a symlink inside the workspace cannot publish something outside it.
   */
  const locate = async (
    workspace: string,
    target: string,
    allowOutside: boolean,
  ): Promise<Located | undefined> => {
    const root = await realpath(workspace).catch(() => undefined)
    if (root === undefined) return undefined
    for (const candidateTarget of pathCandidates(target)) {
      const candidate: string = isAbsolute(candidateTarget) ? resolve(candidateTarget) : resolve(root, candidateTarget)
      const real: string | undefined = await realpath(candidate).catch(() => undefined)
      if (real === undefined) continue
      if (!allowOutside && real !== root && !real.startsWith(root + sep)) {
        deps.logger.warn(`dsh-feishu: card media ${target} is outside the workspace; left as text`
          + ' (set the card-media mode to "any" to allow it)')
        return undefined
      }
      const info = await stat(real).catch(() => undefined)
      if (info === undefined || !info.isFile() || info.size === 0) continue
      return { path: real, stamp: `${info.mtimeMs}:${info.size}`, size: info.size }
    }
    return undefined
  }

  /** The first {@link SNIFF_BYTES} bytes of a file, or `undefined` when unreadable. */
  const readHead = async (absolutePath: string): Promise<Uint8Array | undefined> => {
    const handle = await open(absolutePath, 'r').catch(() => undefined)
    if (handle === undefined) return undefined
    try {
      const buffer = Buffer.alloc(SNIFF_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /**
   * Work out what a file is. The head is enough for images and the non-ISO-BMFF
   * audio formats; an ISO-BMFF file needs the whole buffer because `moov` may
   * sit at the end, which is also why a large non-media file is refused before
   * it is read.
   */
  const inspect = async (
    absolutePath: string,
    size: number,
  ): Promise<Inspected | undefined> => {
    const head = await readHead(absolutePath)
    if (head === undefined) return undefined
    if (sniffImageMime(head) !== undefined) {
      if (size > maxBytes) {
        deps.logger.warn(`dsh-feishu: card image ${absolutePath} is ${size} bytes (limit ${maxBytes}); left as text`)
        return undefined
      }
      return { kind: 'image' }
    }
    const audioHead = sniffAudioFormat(head)
    if (audioHead !== undefined && audioHead !== 'm4a') return { kind: 'audio', format: audioHead }
    if (!isIsoBmffHead(head)) return undefined
    if (size > maxFileBytes) {
      deps.logger.warn(`dsh-feishu: card media ${absolutePath} is ${size} bytes (limit ${maxFileBytes}); left as text`)
      return undefined
    }
    const bytes = await readFile(absolutePath).catch(() => undefined)
    if (bytes === undefined) return undefined
    const video = sniffVideoContainer(bytes)
    if (video !== undefined) return { kind: 'video', container: video.container }
    const classification = classifyMedia(bytes)
    if (classification?.kind === 'audio') return { kind: 'audio', format: classification.audio ?? 'opus' }
    return undefined
  }

  /**
   * Upload one already-classified file once, sharing the promise between
   * concurrent cards: the same clip is often referenced by a step card and the
   * final reply card at the same moment.
   */
  const uploadOnce = async (
    kind: Inspected,
    located: Located,
    budget: () => number,
  ): Promise<ResolvedMedia | undefined> => {
    const absolutePath = located.path
    // Re-check the cache here, synchronously: a caller that missed it before an
    // `await` must not upload a file another card finished uploading meanwhile.
    const cached = entries.get(absolutePath)
    if (cached !== undefined && cached.stamp === located.stamp) return cached.media
    const key = `${kind.kind}\u0000${absolutePath}`
    const inFlight = pending.get(key)
    if (inFlight !== undefined) return inFlight
    const label = kind.kind === 'image' ? 'card image' : 'card media'
    const task = (async (): Promise<ResolvedMedia | undefined> => {
      if (kind.kind === 'image') {
        const uploaded = await withTimeout(deps.upload(absolutePath), 'upload card image', budget())
        return uploaded === undefined ? undefined : { kind: 'image', key: uploaded }
      }
      if (kind.kind === 'video') {
        if (deps.uploadVideo === undefined) return undefined
        const uploaded = await withTimeout(deps.uploadVideo(absolutePath, kind.container), 'upload card video', budget())
        return uploaded === undefined
          ? undefined
          : { kind: 'video', key: uploaded.fileKey, ...(uploaded.coverKey === undefined ? {} : { coverKey: uploaded.coverKey }) }
      }
      if (deps.uploadAudio === undefined) return undefined
      const uploaded = await withTimeout(deps.uploadAudio(absolutePath, kind.format), 'upload card audio', budget())
      return uploaded === undefined ? undefined : { kind: 'audio', key: uploaded.fileKey }
    })()
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        deps.logger.warn(`dsh-feishu: ${label} upload failed for ${absolutePath}: ${reason}`)
        return undefined
      })
      // Cache inside the shared task, BEFORE the in-flight entry is dropped: a
      // card that missed both would otherwise upload the same file twice.
      .then((inlined) => {
        if (inlined !== undefined) {
          entries.set(located.path, { stamp: located.stamp, media: inlined })
          bound(entries)
        }
        return inlined
      })
      .finally(() => { pending.delete(key) })
    pending.set(key, task)
    const inlined = await task
    if (inlined !== undefined) {
      console.log(`dsh-feishu: [media] uploaded ${absolutePath} → ${inlined.kind} ${inlined.key}`)
    }
    return inlined
  }

  const hydrate: CardImageHydrator = async (card, scope, options = {}) => {
    try {
      // `text` means "never upload": nothing to resolve, and the reference is
      // left for the writer to turn into readable text.
      if (mode() === 'text') return card
      // Over-collect on purpose: the per-kind caps are enforced below, and a
      // reply that lists ten pictures must still have its clip considered.
      const targets = collectMediaTargets(card, (maxPerCard + maxMediaPerCard) * 2)
      if (targets.length === 0) return card
      const workspace = scope.workspace !== undefined && scope.workspace !== ''
        ? scope.workspace
        : scope.sessionId === undefined ? undefined : await deps.resolveWorkspace(scope.sessionId)
      if (workspace === undefined || workspace === '') return card
      const recordFailure = options.recordFailure !== false
      const now = Date.now()
      const imageDeadline = now + (options.budgetMs ?? budgetMs)
      const mediaDeadline = now + (options.mediaBudgetMs ?? mediaBudgetMs)
      const allowOutside = mode() === 'any'
      const resolved = new Map<string, ResolvedMedia>()
      /**
       * Classified files whose slot is already reserved, in card order. The slot
       * is claimed before the upload starts so the cap is decided by the card's
       * own order rather than by which upload happens to finish first.
       */
      const claimed: Array<{ kind: Inspected; located: Located; target: string; requestKey: string }> = []
      let images = 0
      let media = 0
      /**
       * Reserve one place on this card. The counters cover EVERY media the card
       * will render, cached hits included: with the old "fresh uploads only"
       * accounting a card could render three clips while the cap said two, and
       * whether the third made it depended on cache timing.
       */
      const claim = (kind: Inspected['kind']): boolean => {
        if (kind === 'image') {
          if (maxPerCard - images <= 0) return false
          images += 1
          return true
        }
        if (maxMediaPerCard - media <= 0) return false
        media += 1
        return true
      }
      for (const entry of targets) {
        const requestKey = `${workspace}\u0000${entry.target}`
        const failedAt = failed.get(requestKey)
        if (failedAt !== undefined && now - failedAt < negativeTtlMs) continue
        const located = await locate(workspace, entry.target, allowOutside)
        if (located === undefined) {
          if (recordFailure) {
            failed.set(requestKey, now)
            bound(failed)
          }
          continue
        }
        const cached = entries.get(located.path)
        if (cached !== undefined && cached.stamp === located.stamp) {
          if (cached.media !== undefined && claim(cached.media.kind)) resolved.set(entry.target, cached.media)
          continue
        }
        const kind = await inspect(located.path, located.size)
        if (kind === undefined) {
          // Quiet for a plain link (most links point at source files, and
          // warning about each one would drown the journal); an explicit
          // image reference that is not an image is worth a line.
          if (entry.image) {
            deps.logger.warn(`dsh-feishu: card image ${entry.target} is not a recognised image format; left as text`)
          }
          entries.set(located.path, { stamp: located.stamp })
          bound(entries)
          continue
        }
        if (claim(kind.kind)) claimed.push({ kind, located, target: entry.target, requestKey })
      }
      // Uploads overlap: six clips must cost one round trip, not six. Each one
      // keeps the remaining budget as its own bound, so the card's total wait is
      // still bounded by the budget rather than by the number of clips.
      await mapLimit(claimed, UPLOAD_CONCURRENCY, async (job) => {
        const isImage = job.kind.kind === 'image'
        const remaining = (): number => Math.max(0, (isImage ? imageDeadline : mediaDeadline) - Date.now())
        if (remaining() <= 0) return
        const inlined = await uploadOnce(job.kind, job.located, remaining)
        if (inlined === undefined) {
          // Classification succeeded but the upload did not: do NOT cache a
          // negative (the file is fine, the transport was not), retry later.
          if (recordFailure) {
            failed.set(job.requestKey, Date.now())
            bound(failed)
          }
          return
        }
        failed.delete(job.requestKey)
        resolved.set(job.target, inlined)
      })
      if (resolved.size === 0) return card
      return rewriteCardMedia(card, resolved)
    } catch (error: unknown) {
      // Hydration is an enhancement: never let it cost the card.
      const reason = error instanceof Error ? error.message : String(error)
      deps.logger.warn(`dsh-feishu: card media hydration failed: ${reason}`)
      return card
    }
  }

  return {
    hydrate,
    warm(card: object, scope: CardImageScope): void {
      // Same pipeline, result discarded: the point is a warm key cache (and an
      // in-flight promise the real write can await) while the model is still
      // typing. `recordFailure: false` is the one difference — a path may name a
      // file the running tool has not written yet (key pitfall 44).
      void hydrate(card, scope, { recordFailure: false }).catch(() => undefined)
    },
    dispose(): void {
      entries.clear()
      failed.clear()
      pending.clear()
    },
  }
}

/**
 * Run `task` for every item with at most `limit` in flight. Results keep the
 * input order; a rejection becomes `undefined` so one broken job cannot strand
 * its siblings (every caller here already handles `undefined`).
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const item = items[index]
      if (index >= items.length || item === undefined) return
      try {
        results[index] = await task(item)
      } catch {
        results[index] = undefined
      }
    }
  }
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: width }, worker))
  return results
}

/** Placeholder that marks where one video element must be spliced in. */
const VIDEO_MARKER = '\u0000dsh-video-'
const VIDEO_MARKER_PATTERN = /\u0000dsh-video-(\d+)\u0000/g

/** Stable `audio_id`, so a card update does not restart the player. */
function audioId(key: string): string {
  return `a${key.replace(/[^A-Za-z0-9_]/gu, '').slice(0, 18)}`
}

/** The inline `<audio>` player markup for one uploaded Opus file. */
export function audioMarkup(key: string, label?: string): string {
  const player = `<audio file_key='${key}' audio_id='${audioId(key)}' show_time=true></audio>`
  return label === undefined || label.trim() === '' ? player : `${label} ${player}`
}

/** One card `video` element for an uploaded MP4. */
function videoElement(media: { key: string; coverKey?: string }, label: string): object {
  return {
    tag: 'video',
    file_key: media.key,
    enable_download: true,
    show_time: true,
    ...(media.coverKey === undefined ? {} : { cover: { img_key: media.coverKey } }),
    // Shown on clients older than V7.56 instead of the generic upgrade notice:
    // naming the file keeps the message useful there too.
    fallback: { tag: 'fallback_text', text: { tag: 'plain_text', content: `📹 ${label}` } },
  }
}

/** What one markdown element's references turned into. */
interface RewrittenMarkdown {
  /** Rewritten content, with video markers still in place. */
  content: string
  /** Marker id → the video that goes there (in first-seen order). */
  videos: Map<string, { media: { key: string; coverKey?: string }; label: string }>
}

/** Rewrite every inlinable reference of one markdown string. */
function rewriteMarkdown(
  content: string,
  resolved: ReadonlyMap<string, ResolvedMedia>,
): RewrittenMarkdown {
  const videos = new Map<string, { media: { key: string; coverKey?: string }; label: string }>()
  const rewritten = mapCardMarkdownReferences(content, (reference) => {
    const media = resolved.get(reference.target)
    if (media === undefined) return reference.raw
    const label = reference.alt.trim() === '' ? reference.target : reference.alt.trim()
    if (media.kind === 'image') return `![${label}](${media.key})`
    if (media.kind === 'audio') return audioMarkup(media.key, reference.alt.trim() === '' ? undefined : label)
    const marker = `${VIDEO_MARKER}${videos.size}\u0000`
    videos.set(marker, { media, label })
    return marker
  })
  return { content: rewritten, videos }
}

/** Split one markdown element into markdown segments and video elements. */
function splitMarkdownElement(
  element: Record<string, unknown>,
  rewritten: RewrittenMarkdown,
): unknown[] | undefined {
  if (rewritten.videos.size === 0 || !rewritten.content.includes(VIDEO_MARKER)) return undefined
  const parts: unknown[] = []
  const pushText = (text: string): void => {
    if (text.trim() === '') return
    parts.push({ ...element, content: text })
  }
  VIDEO_MARKER_PATTERN.lastIndex = 0
  let last = 0
  let match = VIDEO_MARKER_PATTERN.exec(rewritten.content)
  while (match !== null) {
    pushText(rewritten.content.slice(last, match.index))
    const video = rewritten.videos.get(match[0])
    if (video !== undefined) parts.push(videoElement(video.media, video.label))
    last = match.index + match[0].length
    match = VIDEO_MARKER_PATTERN.exec(rewritten.content)
  }
  pushText(rewritten.content.slice(last))
  return parts
}

/**
 * Copy of the card with each resolved reference replaced: images become
 * `img_v3_…` references, audio becomes an inline `<audio>` player, and video
 * becomes a sibling element (splitting its markdown element when needed).
 * A card that carries video or audio also gets `enable_forward: false`.
 */
export function rewriteCardMedia(
  card: object,
  resolved: ReadonlyMap<string, ResolvedMedia>,
): object {
  let forwardBlocked = false
  for (const media of resolved.values()) {
    if (media.kind !== 'image') forwardBlocked = true
  }

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const out: unknown[] = []
      for (const entry of node) {
        const parts = markdownParts(entry)
        if (parts === undefined) out.push(walk(entry))
        else out.push(...parts)
      }
      return out
    }
    if (node === null || typeof node !== 'object') return node
    const record = node as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      result[key] = key === 'content' && record.tag === 'markdown' && typeof value === 'string'
        ? rewriteMarkdown(value, resolved).content
        : walk(value)
    }
    return result
  }

  /** The split parts of a markdown element, or `undefined` when it stays whole. */
  const markdownParts = (entry: unknown): unknown[] | undefined => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const record = entry as Record<string, unknown>
    if (record.tag !== 'markdown' || typeof record.content !== 'string') return undefined
    return splitMarkdownElement(record, rewriteMarkdown(record.content, resolved))
  }

  const rewritten = walk(card) as Record<string, unknown>
  if (!forwardBlocked) return rewritten
  const config = rewritten.config
  const merged = config !== null && typeof config === 'object' && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {}
  merged.enable_forward = false
  return { ...rewritten, config: merged }
}
