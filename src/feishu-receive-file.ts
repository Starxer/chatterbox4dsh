/**
 * `feishu_receive_file` model tool: lets the agent pull an inbound Feishu file
 * resource into the agent's native attachment store.
 *
 * The channel service auto-admits file resources carried on a normal message
 * (it downloads them and persists a durable `FileAttachmentRef`). But when a
 * file reference is NOT auto-admitted — e.g. a message whose resource key
 * never got pulled, or a downstream agent that wants the bytes on demand —
 * this tool lets the agent fetch it directly by its Feishu identifiers
 * (`message_id` + `file_key`, the pair `im.v1.messageResource.get` needs) and
 * persist it through the same native attachment store.
 *
 * Like `feishu_send_file`, this is the model-side counterpart to the channel's
 * inbound admission: send pushes a workspace file out; receive pulls a Feishu
 * file resource in. The download bypasses the SDK's normalized resources (it
 * operates on explicit ids), so it works even when the normalized message did
 * not surface the resource.
 *
 * @module @starxer/chatterbox4dsh/feishu-receive-file
 */

import { Readable } from 'node:stream'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { HarnessConversationService } from './harness.ts'

/** Feishu file-message ceiling (`resource.get` rejects > 30 MB upstream). */
const MAX_FILE_BYTES = 30 * 1024 * 1024

/**
 * Expose the SDK download wrapper as an `AsyncIterable<Uint8Array>` and reject
 * empty or over-limit bodies before `saveFileStream` commits them.
 */
async function* downloadStream(raw: unknown): AsyncGenerator<Uint8Array> {
  let total = 0
  const emit = (chunk: Uint8Array): Uint8Array => {
    total += chunk.byteLength
    if (total > MAX_FILE_BYTES) throw new Error(`File is over Feishu's 30 MB limit: ${total} bytes`)
    return chunk
  }
  const finish = () => {
    if (total === 0) throw new Error('Feishu returned an empty file — returning no local path.')
  }
  if (Buffer.isBuffer(raw)) { yield emit(raw); finish(); return }
  if (raw instanceof Uint8Array) { yield emit(raw); finish(); return }
  if (raw !== null && typeof raw === 'object' && typeof (raw as { getReadableStream?: () => unknown }).getReadableStream === 'function') {
    const stream = (raw as { getReadableStream: () => unknown }).getReadableStream()
    if (!(stream instanceof Readable)) throw new Error('dsh-feishu: unexpected stream type from messageResource.get')
    for await (const chunk of stream) yield emit(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    finish()
    return
  }
  throw new Error('dsh-feishu: unsupported download response shape')
}

/** Minimal logger surface; matches ctx.logger's call style. */
interface PluginLogger {
  warn(message: string): unknown
  error(message: string): unknown
}

/** Live references read lazily on every execution (channel/bridge reconcile). */
export interface FeishuReceiveFileDeps {
  ctx: Context
  /** Reverse lookup: sessionId → bound chat message. */
  bridgeHolder: { current: HarnessConversationService | undefined }
  channelHolder: { current: LarkChannel | undefined }
  /** Native attachment store: persist the pulled file via `saveFileStream` and
   *  return `fileHostPath`. Required on DSH 0.1.3. */
  attachments: {
    saveFileStream: (input: { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string }) => Promise<FileAttachmentRef>
    fileHostPath: (ref: FileAttachmentRef) => string | undefined
  }
  logger: PluginLogger
}

/**
 * Register the `feishu_receive_file` tool on the global host context (visible
 * to every agent). Unbound sessions fail at execution time with a clear error
 * instead of at registration.
 *
 * @param deps Live references to the host context, bridge, and channel.
 * @returns the exact disposer that unregisters the tool.
 */
export function startFeishuReceiveFileTool(deps: FeishuReceiveFileDeps): () => void {
  const { ctx, bridgeHolder, channelHolder, logger, attachments } = deps

  return ctx.tools.register(defineTool({
    name: 'feishu_receive_file',
    description:
      'Download an inbound Feishu file into the agent\'s native attachment '
      + 'store. Requires the message_id and file_key of the file (the pair '
      + 'shown in an incoming file reference). Returns the local path the '
      + 'agent can then open with its file tools. Only works when the current '
      + 'session is bound to a Feishu chat.',
    parameters: {
      message_id: {
        type: 'string',
        required: true,
        description: 'The Feishu message id that carries the file resource.',
      },
      file_key: {
        type: 'string',
        required: true,
        description: 'The Feishu file_key of the resource to download.',
      },
      file_name: {
        type: 'string',
        description: 'Optional display/file name (defaults to the file_key). Used only for the on-disk name.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_name: { type: 'string', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Received "${value.file_name}" into ${value.path}.`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('feishu_receive_file requires an agent-backed session')
      }
      exec.signal.throwIfAborted()

      const bridge = bridgeHolder.current
      if (bridge === undefined) {
        throw new Error('dsh-feishu: bridge not ready — try again after the channel connects')
      }
      const chat = bridge.resolveChat(agent.id)
      if (chat === undefined) {
        throw new Error(
          'This session is not bound to a Feishu chat, so there is no channel to pull the file from.',
        )
      }
      const ch = channelHolder.current
      if (ch === undefined) {
        throw new Error('dsh-feishu: channel not connected — try again later')
      }

      exec.signal.throwIfAborted()
      // `rawClient` reaches the real `im.v1.messageResource.get` endpoint,
      // which needs `(message_id, file_key)` together (the SDK's typed
      // `downloadResource` routes user-sent keys to the wrong endpoint). The
      // SDK returns `{ getReadableStream, ... }` rather than a Buffer.
      const raw: unknown = await (ch as unknown as { rawClient: any }).rawClient.im.v1.messageResource.get({
        params: { type: 'file' },
        path: { message_id: args.message_id, file_key: args.file_key },
      })

      const fileName = (args.file_name ?? args.file_key).replace(/[^a-zA-Z0-9._-]/g, '_') || args.file_key
      // Persist via the native attachment store (streamed, with backpressure)
      // and return its on-disk path for the agent's file tools.
      const fileRef = await attachments.saveFileStream({
        data: downloadStream(raw),
        signal: exec.signal,
        name: fileName,
      })
      const hostPath = attachments.fileHostPath(fileRef)
      if (hostPath === undefined) {
        throw new Error('dsh-feishu: the attachment store did not expose a host path for the received file')
      }
      logger.warn(`dsh-feishu: feishu_receive_file pulled "${fileName}" (message ${args.message_id}) into ${hostPath}`)

      return {
        file_name: fileName,
        path: hostPath,
      }
    },
  }))
}
