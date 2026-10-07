/**
 * Shared facts about the files DSH's `present` tool declared as deliverables.
 *
 * `deliverables/presented` hands us bare paths; three questions have to be
 * answered before anything can be sent to a chat, and all three are pure:
 *
 * 1. **What is it?** — {@link classifyDeliverable} maps the extension to one of
 *    image / video / audio / document / other. Media rides the existing card
 *    hydrator (it renders inline in the Turn Complete card), documents are the
 *    one family we push as native file messages on our own, and everything else
 *    is offered as a click-to-send row.
 * 2. **How big is it?** — Feishu's own ceilings ({@link FEISHU_MAX_FILE_BYTES}
 *    for `im.v1.file.create`, {@link FEISHU_MAX_IMAGE_BYTES} for
 *    `im.v1.image.create`) decide what can be delivered at all;
 *    {@link formatFileSize} is for the card text.
 * 3. **Was it already sent this turn?** — a model that calls `feishu_send_file`
 *    AND `present` for the same file must not deliver it twice
 *    ({@link noteDeliveredFile} / {@link wasDeliveredFile}). The tracker is a
 *    TTL map, not a turn-scoped one: the auto-send runs after the turn's events,
 *    and a stale entry can only ever suppress a duplicate of the same path in
 *    the same session.
 *
 * @module @starxer/chatterbox4dsh/deliver-files
 */

import { extname, resolve } from 'node:path'

/** What a presented file IS, decided by its extension. */
export type DeliverableKind = 'image' | 'video' | 'audio' | 'document' | 'other'

/**
 * Extensions treated as media: these are the ones the card hydrator
 * (`card-images.ts`) can inline, so they are delivered ON THE CARD rather than
 * as a separate message. The list is generous on purpose — the hydrator sniffs
 * the BYTES and leaves anything it cannot render as text, so a wrong guess here
 * only changes which icon the row shows.
 *
 * `.ts` is deliberately NOT here even though MPEG-TS is a real video container:
 * in a coding workspace it is TypeScript, and misreading it as media would both
 * hide the delivery row and send the file down the hydrator's upload path
 * (which refuses it anyway). A `.ts` the model really means is reachable through
 * `feishu_send_file`.
 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpeg', 'mpg'])
const AUDIO_EXTENSIONS = new Set(['opus', 'ogg', 'oga', 'mp3', 'wav', 'm4a', 'flac', 'aac', 'wma', 'amr'])

/**
 * Extensions auto-delivered as native file messages when they are under the
 * `deliverDocMaxMb` setting: finished documents the operator asked for by name
 * (decided 2026-10-06 — pdf / doc / docx / ppt / pptx / xls / xlsx).
 *
 * Source files, archives and everything else deliberately stay out: those are
 * the ones worth a confirmation tap, because a workspace holds many of them and
 * a chat message is hard to take back (关键坑 11 has no undo).
 */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
])

/** Feishu's file-message ceiling (`im.v1.file.create` rejects > 30 MB). */
export const FEISHU_MAX_FILE_BYTES = 30 * 1024 * 1024
/** Feishu's image-message ceiling (`im.v1.image.create` rejects > 10 MB). */
export const FEISHU_MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Lower-cased extension of a path or key, without the dot ('' when none). */
export function deliverableExtension(path: string): string {
  const ext = extname(path.trim()).toLowerCase()
  return ext.startsWith('.') ? ext.slice(1) : ext
}

/** Classify one presented path by its extension. */
export function classifyDeliverable(path: string): DeliverableKind {
  const ext = deliverableExtension(path)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document'
  return 'other'
}

/** Whether a kind is rendered by the card media hydrator instead of a message. */
export function isMediaKind(kind: DeliverableKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}

/** The row icon for one kind. */
export function deliverableIcon(kind: DeliverableKind): string {
  switch (kind) {
    case 'image': return '🖼'
    case 'video': return '🎬'
    case 'audio': return '🎵'
    case 'document': return '📄'
    case 'other': return '📎'
  }
}

/** Compact, localized-independent byte size for card text (`12.3 MB`). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** How long a "already delivered" note suppresses a second send. */
export const DELIVERED_TTL_MS = 10 * 60_000
/** Most session+path pairs the tracker remembers. */
export const DELIVERED_MAX_ENTRIES = 500

/** `sessionId\0resolvedPath` → when the file was sent. */
const delivered = new Map<string, number>()

/** Normalize a path the same way on both sides of the tracker. */
function deliveryKey(sessionId: string, path: string): string {
  return `${sessionId}\u0000${resolve(path.trim())}`
}

/**
 * Record that `sessionId` already pushed `path` to its chat, so the
 * deliverable auto-send does not send it again in the same beat.
 */
export function noteDeliveredFile(sessionId: string, path: string, now: number = Date.now()): void {
  if (sessionId === '' || path.trim() === '') return
  const key = deliveryKey(sessionId, path)
  delivered.delete(key)
  delivered.set(key, now)
  while (delivered.size > DELIVERED_MAX_ENTRIES) {
    const oldest = delivered.keys().next().value
    if (oldest === undefined) return
    delivered.delete(oldest)
  }
}

/** Whether `sessionId` sent `path` within {@link DELIVERED_TTL_MS}. */
export function wasDeliveredFile(sessionId: string, path: string, now: number = Date.now()): boolean {
  if (sessionId === '' || path.trim() === '') return false
  const key = deliveryKey(sessionId, path)
  const at = delivered.get(key)
  if (at === undefined) return false
  if (now - at > DELIVERED_TTL_MS) {
    delivered.delete(key)
    return false
  }
  return true
}

/**
 * Drop the tracker. Tests call it so one case cannot leak into the next.
 *
 * Deliberately NOT called by `dispose()`: the map is module-global, and a
 * plugin reload within the TTL window should keep suppressing a file the
 * previous instance already pushed.
 */
export function resetDeliveredFiles(): void {
  delivered.clear()
}
