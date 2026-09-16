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
 * @module @starxer/chatterbox4dsh/feishu-resource
 */

import type { LarkChannel } from '@larksuiteoapi/node-sdk'

/**
 * Download {@link fileKey} from {@link messageId}, returning the SDK's
 * download wrapper (`{ getReadableStream, writeFile, headers }`, or a Buffer
 * for some transports). Callers stream it — never buffer it wholesale.
 */
export async function downloadMessageResource(
  channel: LarkChannel,
  messageId: string,
  fileKey: string,
): Promise<unknown> {
  try {
    return await channel.rawClient.im.v1.messageResource.get({
      params: { type: 'file' },
      path: { message_id: messageId, file_key: fileKey },
    })
  } catch (first: unknown) {
    try {
      return await channel.rawClient.im.v1.file.get({ path: { file_key: fileKey } })
    } catch {
      // Report the message-scoped failure: it is the more informative one.
      throw first
    }
  }
}
