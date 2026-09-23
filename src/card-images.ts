/**
 * Inline local images in Feishu cards (L3 of the 2026-09-23 card-image work).
 *
 * Feishu renders `![alt](image_key)` as a real inline picture, but ONLY for a key
 * it handed out through the image-upload API. The DSH Web UI, by contrast,
 * resolves workspace paths — so a model that writes `![图](runs/a.png)` is
 * being useful there and impossible here. `card-markdown.ts` degrades those
 * references to text; this module goes one step further and makes them render:
 * a path that resolves to a real image INSIDE the session's workspace is
 * uploaded first, and the card is rewritten to reference the returned key.
 *
 * Everything here is best-effort and bounded, because the fallback already
 * exists: whatever cannot be uploaded simply stays text and the card still
 * renders (never the other way round — a picture must not cost a message).
 *
 * Privacy: uploading publishes the file to Feishu. The scope is deliberately
 * narrow — only paths written in `![alt](path)` syntax, only files that live
 * inside the session's own workspace (checked on the REAL path, so a symlink
 * pointing out is refused), only real image formats, and only up to
 * {@link DEFAULT_MAX_BYTES}.
 *
 * @module @starxer/chatterbox4dsh/card-images
 */

import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { CardImageMode } from './config.ts'
import { isFeishuImageKey, mapCardMarkdownReferences } from './card-markdown.ts'
import { sniffImageMime } from './media-sniff.ts'
import { withTimeout } from './outbound-timeout.ts'

/** Feishu's image-message limit; a card reference larger than this is pointless. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
/** Most images one card may pull in — a runaway answer must not upload forever. */
export const DEFAULT_MAX_PER_CARD = 8
/** How many resolved paths keep their key / failure. */
export const DEFAULT_MAX_CACHED = 256
/** A path that failed is retried after this long (the file may appear later). */
export const NEGATIVE_TTL_MS = 60_000
/**
 * Total time one card may spend uploading. A step card carries the answer, so a
 * slow upload must never hold the message back — whatever is left over simply
 * stays text (and the next card update picks it up from the cache).
 */
export const DEFAULT_BUDGET_MS = 6_000
/** Bytes read for the format sniff. */
const SNIFF_BYTES = 64

export interface CardImageDeps {
  /** The workspace a session runs in; relative paths resolve against it. */
  resolveWorkspace: (sessionId: string) => Promise<string | undefined>
  /** Upload one local image and return its Feishu image key. */
  upload: (absolutePath: string) => Promise<string | undefined>
  logger: { warn(message: string): unknown }
  maxBytes?: number
  maxPerCard?: number
  maxCached?: number
  /**
   * Read the CURRENT image mode (live, so a settings write applies without a
   * restart). Defaults to `workspace`.
   */
  mode?: () => CardImageMode | undefined
  /** Wall-clock budget for one `hydrate` call. */
  budgetMs?: number
  /** How long a failed path is remembered before it is retried. */
  negativeTtlMs?: number
}

/** Where the card's paths should be resolved. `workspace` wins when known. */
export interface CardImageScope {
  sessionId?: string
  workspace?: string
}

/**
 * What callers receive: rewrite a card so its local image references render.
 * Never rejects — a reference that cannot be resolved is left for the writer to
 * degrade to text.
 */
export type CardImageHydrator = (card: object, scope: CardImageScope) => Promise<object>

export interface CardImagesHandle {
  /**
   * Rewrite every inlinable image reference of a card to a Feishu image key.
   * Never rejects; on any failure the card is returned with the reference
   * unchanged, which the writer turns into readable text.
   */
  hydrate: CardImageHydrator
  dispose(): void
}

interface CachedKey {
  /** `mtimeMs:size` of the file the key was uploaded for. */
  stamp: string
  key: string
}

/** A local path to inline: not an image key and not a URL. */
function isLocalCandidate(target: string): boolean {
  const value = target.trim()
  if (value === '' || isFeishuImageKey(value)) return false
  if (value.startsWith('//')) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false
  return true
}

/** Collect the distinct local image targets of a card's markdown, in order. */
export function collectImageTargets(card: object, limit: number): string[] {
  const targets: string[] = []
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
        if (reference.image && isLocalCandidate(reference.target) && !seen.has(reference.target)) {
          seen.add(reference.target)
          targets.push(reference.target)
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
 * Create the image hydrator. One instance per plugin: the key cache must be
 * shared, because the same picture is referenced by several cards of a turn
 * (and re-rendered on every card update).
 *
 * @param deps - workspace resolver, uploader, logger and the bounds.
 */
export function startCardImages(deps: CardImageDeps): CardImagesHandle {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  const maxPerCard = deps.maxPerCard ?? DEFAULT_MAX_PER_CARD
  const maxCached = deps.maxCached ?? DEFAULT_MAX_CACHED
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS
  const mode = (): CardImageMode => deps.mode?.() ?? 'workspace'
  const negativeTtlMs = deps.negativeTtlMs ?? NEGATIVE_TTL_MS
  /** abs path → key, invalidated when the file's stamp changes. */
  const keys = new Map<string, CachedKey>()
  /** request → when it failed, so a missing file is not re-stat-ed every update. */
  const failed = new Map<string, number>()
  /** abs path → in-flight upload, so two cards do not upload the same file twice. */
  const pending = new Map<string, Promise<string | undefined>>()

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
  ): Promise<{ path: string; stamp: string } | undefined> => {
    const root = await realpath(workspace).catch(() => undefined)
    if (root === undefined) return undefined
    const candidate = isAbsolute(target) ? resolve(target) : resolve(root, target)
    const real = await realpath(candidate).catch(() => undefined)
    if (real === undefined) return undefined
    if (!allowOutside && real !== root && !real.startsWith(root + sep)) {
      deps.logger.warn(`dsh-feishu: card image ${target} is outside the workspace; left as text`
        + ' (set the image mode to "any" to allow it)')
      return undefined
    }
    const info = await stat(real).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.size === 0) return undefined
    if (info.size > maxBytes) {
      deps.logger.warn(`dsh-feishu: card image ${target} is ${info.size} bytes (limit ${maxBytes}); left as text`)
      return undefined
    }
    const handle = await open(real, 'r').catch(() => undefined)
    if (handle === undefined) return undefined
    try {
      const buffer = Buffer.alloc(SNIFF_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0)
      if (sniffImageMime(buffer.subarray(0, bytesRead)) === undefined) {
        deps.logger.warn(`dsh-feishu: card image ${target} is not a recognised image format; left as text`)
        return undefined
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
    return { path: real, stamp: `${info.mtimeMs}:${info.size}` }
  }

  const uploadOnce = async (absolutePath: string): Promise<string | undefined> => {
    const inFlight = pending.get(absolutePath)
    if (inFlight !== undefined) return inFlight
    const task = withTimeout(deps.upload(absolutePath), 'upload card image')
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        deps.logger.warn(`dsh-feishu: card image upload failed for ${absolutePath}: ${reason}`)
        return undefined
      })
      .finally(() => { pending.delete(absolutePath) })
    pending.set(absolutePath, task)
    return task
  }

  /** Key for one target, from the cache or freshly uploaded. */
  const keyFor = async (
    workspace: string,
    target: string,
    budgetLeft: number,
    allowOutside: boolean,
  ): Promise<string | undefined> => {
    const located = await locate(workspace, target, allowOutside)
    if (located === undefined) return undefined
    const cached = keys.get(located.path)
    if (cached !== undefined && cached.stamp === located.stamp) return cached.key
    // The outer bound keeps ONE card inside its budget even when the upload
    // itself is still allowed its own (larger) hard limit: the shared in-flight
    // promise keeps running and caches the key for the next card update.
    const key = await withTimeout(uploadOnce(located.path), 'upload card image', budgetLeft)
      .catch(() => undefined)
    if (key === undefined) return undefined
    keys.set(located.path, { stamp: located.stamp, key })
    bound(keys)
    console.log(`dsh-feishu: [img] uploaded ${target} → ${key}`)
    return key
  }

  return {
    async hydrate(card: object, scope: CardImageScope): Promise<object> {
      try {
        // `text` means "never upload": nothing to resolve, and the reference is
        // left for the writer to turn into readable text.
        if (mode() === 'text') return card
        const targets = collectImageTargets(card, maxPerCard)
        if (targets.length === 0) return card
        const workspace = scope.workspace !== undefined && scope.workspace !== ''
          ? scope.workspace
          : scope.sessionId === undefined ? undefined : await deps.resolveWorkspace(scope.sessionId)
        if (workspace === undefined || workspace === '') return card
        const now = Date.now()
        const deadline = now + budgetMs
        const resolved = new Map<string, string>()
        for (const target of targets) {
          const budgetLeft = deadline - Date.now()
          if (budgetLeft <= 0) break
          const requestKey = `${workspace}\u0000${target}`
          const failedAt = failed.get(requestKey)
          if (failedAt !== undefined && now - failedAt < negativeTtlMs) continue
          const key = await keyFor(workspace, target, budgetLeft, mode() === 'any')
          if (key === undefined) {
            failed.set(requestKey, now)
            bound(failed)
            continue
          }
          failed.delete(requestKey)
          resolved.set(target, key)
        }
        if (resolved.size === 0) return card
        return rewriteWithKeys(card, resolved)
      } catch (error: unknown) {
        // Hydration is an enhancement: never let it cost the card.
        const reason = error instanceof Error ? error.message : String(error)
        deps.logger.warn(`dsh-feishu: card image hydration failed: ${reason}`)
        return card
      }
    },
    dispose(): void {
      keys.clear()
      failed.clear()
      pending.clear()
    },
  }
}

/** Copy of the card with the resolved targets replaced by their image keys. */
function rewriteWithKeys(card: object, resolved: ReadonlyMap<string, string>): object {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node === null || typeof node !== 'object') return node
    const record = node as Record<string, unknown>
    const isMarkdown = record.tag === 'markdown'
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (isMarkdown && key === 'content' && typeof value === 'string') {
        result[key] = mapCardMarkdownReferences(value, (reference) => {
          if (!reference.image) return reference.raw
          const imageKey = resolved.get(reference.target)
          return imageKey === undefined ? reference.raw : `![${reference.alt}](${imageKey})`
        })
      } else {
        result[key] = walk(value)
      }
    }
    return result
  }
  return walk(card) as object
}
