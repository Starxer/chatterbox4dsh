/**
 * Shared Feishu resource download.
 *
 * `im.v1.messageResource.get?type=…` is the only endpoint that serves a
 * resource the *user* sent, and it accepts just two values: `image` and
 * `file`. Anything else is rejected outright (`234001 Invalid request
 * param`), and a video/audio resource inside a media message is not
 * addressable as `file` either — it answers `234003 File not in msg.` So the
 * message-scoped endpoint is tried first and the standalone `im.v1.file.get`
 * endpoint (by `file_key`) is the fallback.
 *
 * # The (message_id, file_key) pair is not always the message we were handed
 *
 * The SDK BATCHES inbound messages per chat: everything that arrives within
 * ~600 ms (up to 8 messages / 4000 chars) is merged into one normalized
 * message whose `messageId` is the **last** message's while `resources` is the
 * **union** of every image/file in the batch
 * (`node_modules/@larksuiteoapi/node-sdk`, `mergeBatch` /
 * `SafetyPipeline.pushMessage`). Downloading resource[0] with that id asks
 * Feishu for a key that message does not own:
 *
 *   400 {"code":234003,"msg":"File not in msg."}
 *
 * which is what broke 「图片处理出错」 on 2026-10-27 (two images sent
 * together, one event, resource of message A fetched with message B's id).
 * Real batches are common: multi-image albums, or an image followed by a text
 * message within the debounce window.
 *
 * The SDK drops the batch's per-message ids (it calls the handler with
 * `batch.message` only), so the owner is recovered here: on a rejected pair,
 * ONE bounded listing of the same chat/thread is scanned for the message whose
 * body still contains that file key, and the download is retried with it.
 *
 * @module @starxer/chatterbox4dsh/feishu-resource
 */

import type { LarkChannel } from '@larksuiteoapi/node-sdk'

/** The two resource kinds `im.v1.messageResource.get` accepts. */
export type MessageResourceType = 'image' | 'file'

/**
 * Everything the owner lookup needs about the message the resource arrived on.
 * `chatId`/`threadId` are only used on the failure path.
 */
export interface ResourceScope {
  messageId: string
  chatId?: string
  threadId?: string
}

/** Feishu business code for "that file key does not belong to that message". */
export const RESOURCE_NOT_IN_MESSAGE = 234003

/** How many recent messages the owner lookup reads (one page, no paging). */
export const OWNER_LOOKUP_PAGE_SIZE = 30

/** A parsed JSON body, when the response carries one. */
function jsonBody(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object' && !Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) {
    return value as Record<string, unknown>
  }
  let text: string | undefined
  if (typeof value === 'string') text = value
  else if (Buffer.isBuffer(value)) text = value.toString('utf8')
  if (text === undefined || text.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * Is this the "file not in msg" rejection (or a bare 400 from the
 * message-scoped download, whose streamed body hides the business code)?
 *
 * The download endpoint answers with a stream, so on a 400 the SDK's error
 * often carries no parsed body at all — there `response.data` is a Buffer or
 * Readable and the only usable signal is the status. A 400 from THIS endpoint
 * in practice means a bad pair, so the lookup is worth one attempt either way.
 */
export function isResourceNotInMessage(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const response = (error as { response?: { status?: unknown; data?: unknown } }).response
  if (response?.status !== 400) return false
  const code = jsonBody(response.data)?.code
  // Unknown business code: a streamed body we cannot read. Treat it as this
  // case — the caller only spends one bounded listing on the sniff.
  return code === undefined || code === RESOURCE_NOT_IN_MESSAGE
}

/** One page of recent messages in the resource's chat/thread. */
async function findResourceOwner(
  channel: LarkChannel,
  scope: ResourceScope,
  fileKey: string,
): Promise<string | undefined> {
  const container = scope.threadId !== undefined && scope.threadId !== ''
    ? { container_id_type: 'thread' as const, container_id: scope.threadId }
    : scope.chatId !== undefined && scope.chatId !== ''
      ? { container_id_type: 'chat' as const, container_id: scope.chatId }
      : undefined
  if (container === undefined) return undefined
  try {
    const listed = await channel.rawClient.im.v1.message.list({
      params: { ...container, sort_type: 'ByCreateTimeDesc', page_size: OWNER_LOOKUP_PAGE_SIZE },
    }) as { data?: { items?: Array<{ message_id?: unknown; body?: { content?: unknown } }> } }
    for (const item of listed?.data?.items ?? []) {
      const content = typeof item.body?.content === 'string' ? item.body.content : ''
      if (typeof item.message_id === 'string' && item.message_id !== '' && content.includes(fileKey)) {
        return item.message_id
      }
    }
  } catch {
    // The lookup is best-effort: its failure must not hide the download error.
  }
  return undefined
}

/** The message-scoped download call for one resource kind. */
function fetchScoped(
  channel: LarkChannel,
  type: MessageResourceType,
  messageId: string,
  fileKey: string,
): Promise<unknown> {
  return channel.rawClient.im.v1.messageResource.get({
    params: { type },
    path: { message_id: messageId, file_key: fileKey },
  })
}

/**
 * Download one inbound resource, resolving the message that actually OWNS the
 * file key when a batched dispatch handed us a different message's id.
 *
 * Order: the message-scoped endpoint with our id → (on a 400) the same endpoint
 * with the owner found by a bounded listing → for `type: 'file'`, the
 * standalone `im.v1.file.get` fallback (videos/audio inside a media message are
 * not addressable as `file` at all). The original error is rethrown when
 * nothing works, because it is the most informative one.
 *
 * @param channel - the live Lark channel.
 * @param scope - the message the resource arrived on, plus its chat/thread.
 * @param fileKey - the `image_key`/`file_key` to download.
 * @param type - which endpoint dialect to use.
 */
export async function downloadInboundResource(
  channel: LarkChannel,
  scope: ResourceScope,
  fileKey: string,
  type: MessageResourceType,
): Promise<unknown> {
  let first: unknown
  try {
    return await fetchScoped(channel, type, scope.messageId, fileKey)
  } catch (error: unknown) {
    first = error
  }
  if (isResourceNotInMessage(first)) {
    const owner = await findResourceOwner(channel, scope, fileKey)
    if (owner !== undefined && owner !== scope.messageId) {
      try {
        return await fetchScoped(channel, type, owner, fileKey)
      } catch {
        // Keep the first failure: it names our own message id.
      }
    }
  }
  if (type === 'file') {
    try {
      return await channel.rawClient.im.v1.file.get({ path: { file_key: fileKey } })
    } catch {
      // Report the message-scoped failure below.
    }
  }
  throw first
}

/**
 * Download {@link fileKey} from {@link messageId}, returning the SDK's
 * download wrapper (`{ getReadableStream, writeFile, headers }`, or a Buffer
 * for some transports). Callers stream it — never buffer it wholesale.
 *
 * Kept for callers that hold only a message id (the `feishu_receive_file` tool
 * path, where the id comes from the model, not from a batched dispatch).
 */
export async function downloadMessageResource(
  channel: LarkChannel,
  messageId: string,
  fileKey: string,
): Promise<unknown> {
  return downloadInboundResource(channel, { messageId }, fileKey, 'file')
}
