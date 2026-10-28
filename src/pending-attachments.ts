/** Unsubmitted inbound attachments: durable refs only, never retained file bytes. */
import { AttachmentError, type ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { conversationKey, type ConversationMessage } from './conversation.ts'
import type { InboundMessage } from './harness.ts'

export const ATTACHMENT_NOTICE_DELAY_MS = 3_000
export interface ImageBudget { count: number; bytes: number; maxSingleBytes?: number }
export const EMPTY_IMAGE_BUDGET: Readonly<ImageBudget> = { count: 0, bytes: 0 }

/** Use source bytes, not the normalized ref's smaller `bytes` field. */
export function assertImageBudget(limits: ImageAttachmentLimits, budget: ImageBudget, singleBytes?: number): void {
  if (budget.count > limits.maxImagesPerMessage) {
    throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
  }
  if ((singleBytes ?? budget.maxSingleBytes ?? 0) > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured image-byte limit.', 'IMAGE_TOO_LARGE')
  }
  if (budget.bytes > limits.maxMessageImageBytes) {
    throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
  }
}

/** Remove ONLY SDK-generated placeholders for resources actually in this event.
 * `content` for a plain image is `![image](key)`, not an empty string. Unknown
 * links/tags and real captions stay intact, including batched text + images. */
export function attachmentMessageText(message: Pick<NormalizedMessage, 'content' | 'resources'>): string {
  let text = message.content
  for (const resource of message.resources ?? []) {
    if (resource.type === 'image') text = text.split(`![image](${resource.fileKey})`).join('')
    if (resource.type === 'file' || resource.type === 'video' || resource.type === 'audio') {
      text = text.replace(/<(file|video|audio)\b(?:[^>"']|"[^"]*"|'[^']*')*\/>/g, tag => {
        const key = /\bkey="([^"]*)"/.exec(tag)?.[1]
        return tag.startsWith(`<${resource.type} `) && key === resource.fileKey ? '' : tag
      })
    }
  }
  return text.trim()
}

export interface PendingAttachmentBatch {
  message: InboundMessage
  budget: ImageBudget
  /** User files, excluding full-resolution originals retained by image fitting. */
  files: number
  replyTo: string
  /** No owner until first-message onboarding has created a binding. */
  sessionId?: string
}
interface Entry extends PendingAttachmentBatch { timer?: ReturnType<typeof setTimeout>; generation: number; dueAt: number; notified: boolean }

/** Staging is transport-local. A text message takes the batch only when it is
 * actually submitted; onboarding/commands must not consume it prematurely. */
export function createPendingAttachments(deps: {
  sessionId(chat: ConversationMessage): string
  notice(batch: PendingAttachmentBatch, valid: () => boolean): Promise<void>
  warn(message: string): void
}) {
  const entries = new Map<string, Entry>()
  const reservations = new Map<string, Set<Entry>>()
  let stopped = false
  const cancel = (entry: Entry): void => {
    entry.generation++
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    delete entry.timer
  }
  const peek = (chat: ConversationMessage): Entry | undefined => {
    const key = conversationKey(chat)
    const entry = entries.get(key)
    if (entry?.sessionId !== undefined && entry.sessionId !== deps.sessionId(chat)) {
      cancel(entry)
      entries.delete(key)
      return undefined
    }
    return entry
  }
  const defer = (chat: ConversationMessage): boolean => {
    const entry = peek(chat)
    const armed = entry?.timer !== undefined
    if (entry !== undefined) cancel(entry)
    return armed
  }
  const resume = (chat: ConversationMessage): void => {
    const entry = peek(chat)
    if (entry === undefined || stopped || entry.notified) return
    cancel(entry)
    const generation = entry.generation
    entry.timer = setTimeout(() => {
      delete entry.timer
      const valid = (): boolean => !stopped && peek(chat) === entry && entry.generation === generation
      if (!valid()) return
      entry.notified = true
      void deps.notice(entry, valid).catch(error => {
        deps.warn(`dsh-feishu: attachment waiting notice failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, Math.max(0, entry.dueAt - Date.now()))
    entry.timer.unref?.()
  }
  const clear = (chat: ConversationMessage): void => {
    const key = conversationKey(chat)
    const entry = entries.get(key)
    if (entry !== undefined) cancel(entry)
    entries.delete(key)
  }
  const merge = (chat: ConversationMessage, message: InboundMessage): InboundMessage => {
    const previous = peek(chat)
    if (previous === undefined) return message
    return {
      ...message,
      content: [previous.message.content, message.content].filter(Boolean).join('\n\n'),
      imageBlocks: [...previous.message.imageBlocks ?? [], ...message.imageBlocks ?? []],
      fileBlocks: [...previous.message.fileBlocks ?? [], ...message.fileBlocks ?? []],
    }
  }
  const stash = (chat: ConversationMessage, batch: PendingAttachmentBatch): void => {
    if (stopped) return
    const previous = peek(chat)
    const message = merge(chat, batch.message)
    const next: Entry = {
      ...batch, message,
      budget: { count: (previous?.budget.count ?? 0) + batch.budget.count, bytes: (previous?.budget.bytes ?? 0) + batch.budget.bytes,
        maxSingleBytes: Math.max(previous?.budget.maxSingleBytes ?? 0, batch.budget.maxSingleBytes ?? 0) },
      files: (previous?.files ?? 0) + batch.files,
      generation: 0, dueAt: Date.now() + ATTACHMENT_NOTICE_DELAY_MS, notified: false,
    }
    if (previous !== undefined) cancel(previous)
    entries.set(conversationKey(chat), next)
    resume(chat)
  }
  return {
    peek, defer, resume, merge, stash, clear,
    /** Remove a draft synchronously to reserve it for one submission. Restore
     * only if native admission failed, prepending it to any newer uploads. */
    budget(chat: ConversationMessage): ImageBudget {
      const draft = peek(chat)?.budget ?? EMPTY_IMAGE_BUDGET
      const budget = { ...draft }
      for (const entry of reservations.get(conversationKey(chat)) ?? []) {
        budget.count += entry.budget.count
        budget.bytes += entry.budget.bytes
        budget.maxSingleBytes = Math.max(budget.maxSingleBytes ?? 0, entry.budget.maxSingleBytes ?? 0)
      }
      return budget
    },
    reserve(chat: ConversationMessage, addition?: PendingAttachmentBatch): { accept(): void; restore(): void } | undefined {
      const previous = peek(chat)
      const entry: Entry | undefined = addition === undefined ? previous : {
        ...addition,
        message: merge(chat, addition.message),
        budget: {
          count: (previous?.budget.count ?? 0) + addition.budget.count,
          bytes: (previous?.budget.bytes ?? 0) + addition.budget.bytes,
          maxSingleBytes: Math.max(previous?.budget.maxSingleBytes ?? 0, addition.budget.maxSingleBytes ?? 0),
        },
        files: (previous?.files ?? 0) + addition.files,
        generation: 0, dueAt: Date.now() + ATTACHMENT_NOTICE_DELAY_MS, notified: false,
      }
      if (entry === undefined) return undefined
      clear(chat)
      const key = conversationKey(chat)
      const reserved = reservations.get(key) ?? new Set<Entry>()
      reservations.set(key, reserved)
      reserved.add(entry)
      let settled = false
      const accept = (): void => {
        settled = true
        reserved.delete(entry)
        if (reserved.size === 0 && reservations.get(key) === reserved) reservations.delete(key)
      }
      const restore = (): void => {
        if (settled) return
        accept()
        if (stopped || (entry.sessionId !== undefined && entry.sessionId !== deps.sessionId(chat))) return
        const newer = peek(chat)
        if (newer === undefined) {
          entry.notified = false
          entry.dueAt = Date.now() + ATTACHMENT_NOTICE_DELAY_MS
          entries.set(conversationKey(chat), entry)
        } else {
          const message: InboundMessage = {
            ...newer.message,
            content: [entry.message.content, newer.message.content].filter(Boolean).join('\n\n'),
            imageBlocks: [...entry.message.imageBlocks ?? [], ...newer.message.imageBlocks ?? []],
            fileBlocks: [...entry.message.fileBlocks ?? [], ...newer.message.fileBlocks ?? []],
          }
          cancel(newer)
          entries.set(conversationKey(chat), {
            ...newer, message,
            budget: { count: entry.budget.count + newer.budget.count, bytes: entry.budget.bytes + newer.budget.bytes,
              maxSingleBytes: Math.max(entry.budget.maxSingleBytes ?? 0, newer.budget.maxSingleBytes ?? 0) },
            files: entry.files + newer.files,
          })
        }
        resume(chat)
      }
      return { accept, restore }
    },
    /** Bind first-message uploads once onboarding has picked its first Session;
     * later binding changes discard the old draft rather than moving it. */
    bindingChanged(chat: ConversationMessage, sessionId: string): void {
      const key = conversationKey(chat)
      reservations.delete(key)
      const entry = entries.get(key)
      if (entry === undefined) return
      if (entry.sessionId === undefined) entry.sessionId = sessionId
      else if (entry.sessionId !== sessionId) clear(chat)
    },
    stop(): void {
      stopped = true
      for (const entry of entries.values()) cancel(entry)
      entries.clear()
      reservations.clear()
    },
  }
}
