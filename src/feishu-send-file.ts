/**
 * Native file delivery to a Feishu chat.
 *
 * DSH itself has no "agent pushes a binary file to the client" primitive — the
 * agent writes files into the workspace, and the WebUI's `ui-deliverables`
 * plugin auto-links them. Feishu has no equivalent, so this module owns BOTH
 * ways a produced file reaches the chat:
 *
 * - {@link startFeishuSendFileTool} registers the `feishu_send_file` model tool,
 *   the explicit path the agent chooses;
 * - {@link sendWorkspaceFile} is the reusable sender, which `feishu-deliver.ts`
 *   calls for the files DSH's `present` tool declared (the automatic path).
 *
 * Sending goes through the SDK's `LarkChannel.send` path, which already knows
 * every Feishu media message shape we want — no hand-rolled upload + send
 * dance is needed:
 *   • real image bytes (magic-sniffed) → `{ image }` → `msg_type:'image'`,
 *     the picture renders inline;
 *   • MP4/QuickTime video with a playable codec (sniffed from `ftyp` + the
 *     video sample entry) → `{ video }` → `file_type:'mp4'` + `msg_type:'media'`,
 *     a native, playable video bubble. Feishu never derives the bubble's cover
 *     from the video, so a poster frame is extracted with `ffmpeg` **when it is
 *     on PATH** and uploaded as `image_key` (best-effort: no ffmpeg, no cover);
 *   • Ogg/Opus audio → `{ audio }` → `file_type:'opus'` + `msg_type:'audio'`,
 *     a voice bubble.
 * Everything else — or an image over Feishu's 10 MB image cap, an exotic video
 * container/codec, or a video whose duration the SDK cannot parse — falls back
 * to a `{ file }` message (`file_type:'stream'`), which still lands but
 * requires opening. Refusing the inline path early is deliberate: uploading a
 * container the client cannot play produces a broken bubble, which is worse
 * than an attachment. Thread replies reuse the same `replyTo`/`replyInThread`
 * options the question/approval cards use.
 *
 * @module @starxer/chatterbox4dsh/feishu-send-file
 */

import { readFile, realpath, stat, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { HarnessConversationService } from './harness.ts'
import { errorText } from './error-text.ts'
import { sniffAudioContainer, sniffImageMime, sniffVideoContainer } from './media-sniff.ts'
import { withLinkTimeout } from './outbound-timeout.ts'
import { FEISHU_MAX_FILE_BYTES, FEISHU_MAX_IMAGE_BYTES, noteDeliveredFile } from './deliver-files.ts'

const execFileAsync = promisify(execFile)

/** Cover extraction is a nicety — never let a slow ffmpeg hold up the send. */
const COVER_EXTRACT_TIMEOUT_MS = 15_000
/**
 * How long ONE file send may stay unresolved before it counts as failed.
 *
 * Much larger than the 20 s protocol timeout: the upload reads the whole
 * (possibly 30 MB) file into memory and Feishu's own processing runs before the
 * message id comes back, so this exists to break a permanent hang rather than
 * to enforce a latency budget. The SDK builds its HTTP client with
 * `timeout: 0`, so without this a half-open TLS socket would hang the caller
 * forever (关键坑 29).
 */
export const FILE_SEND_TIMEOUT_MS = 120_000

/** Minimal logger surface; matches ctx.logger's call style. */
export interface PluginLogger {
  warn(message: string): unknown
  error(message: string): unknown
}

/**
 * Produce a poster frame for a video, or `undefined` when that is not possible
 * (no ffmpeg on PATH, unreadable/degenerate video). Never throws: a missing
 * cover must not fail the send.
 */
export type CoverFrameExtractor = (path: string) => Promise<Buffer | undefined>

/**
 * Default cover extractor: one frame via `ffmpeg`, falling back to the very
 * first frame for clips shorter than the 1s mark. Returns `undefined` when
 * ffmpeg is absent (`ENOENT`) or produced nothing.
 */
async function extractCoverFrameWithFfmpeg(filePath: string): Promise<Buffer | undefined> {
  const out = join(tmpdir(), `dsh-feishu-cover-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`)
  try {
    for (const args of [
      ['-ss', '1', '-i', filePath, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2', out],
      ['-i', filePath, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2', out],
    ]) {
      try {
        await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', ...args],
          { timeout: COVER_EXTRACT_TIMEOUT_MS, windowsHide: true })
      } catch {
        continue
      }
      const frame = await readFile(out).catch(() => undefined)
      if (frame !== undefined && frame.length > 0) return frame
    }
    return undefined
  } finally {
    await unlink(out).catch(() => undefined)
  }
}

/** Live references read lazily on every execution (channel/bridge reconcile). */
export interface FeishuSendFileDeps {
  ctx: Context
  bridgeHolder: { current: HarnessConversationService | undefined }
  channelHolder: { current: LarkChannel | undefined }
  logger: PluginLogger
  /** Override for tests; defaults to the ffmpeg-backed extractor. */
  extractCoverFrame?: CoverFrameExtractor
}

/** The SDK's own outbound payload union (image / file / audio / video / …). */
type SendInput = Parameters<LarkChannel['send']>[1]

/**
 * Upload a poster frame for a video, if one can be produced.
 *
 * Feishu never derives a bubble cover from the video itself — `image_key` is
 * optional in the `media` content, and leaving it out yields a bubble with no
 * thumbnail. So the cover is ours to supply. This is never fatal: extraction
 * that cannot run (no ffmpeg on PATH) or an upload that fails only warns, and
 * the video is sent without a cover.
 */
async function uploadCoverFrame(
  channel: LarkChannel,
  filePath: string,
  logger: PluginLogger,
  extract: CoverFrameExtractor,
): Promise<string | undefined> {
  let frame: Buffer | undefined
  try {
    frame = await extract(filePath)
  } catch (error: unknown) {
    logger.warn(`dsh-feishu: cover frame extraction failed (${errorText(error, 'unknown error')})`)
    return undefined
  }
  if (frame === undefined || frame.length === 0) return undefined
  try {
    // Bounded like every other outbound call: the SDK's HTTP client is built
    // with `timeout: 0`, so a half-open socket would otherwise hang the whole
    // send (关键坑 29). The catch below already degrades to "no cover".
    const uploaded = await withLinkTimeout(channel.rawClient.im.v1.image.create({
      data: { image_type: 'message', image: frame },
    }), 'upload cover frame', FILE_SEND_TIMEOUT_MS)
    const key = uploaded?.image_key
    if (key === undefined) {
      logger.warn('dsh-feishu: cover frame upload returned no image_key; sending the video without a cover')
    }
    return key
  } catch (error: unknown) {
    logger.warn(`dsh-feishu: cover frame upload failed (${errorText(error, 'unknown Feishu error')}); `
      + 'sending the video without a cover')
    return undefined
  }
}

/** One file to push into a chat, with the coordinates of that chat. */
export interface SendWorkspaceFileDeps {
  channel: LarkChannel
  /** Target chat id. */
  chatId: string
  /** Path as the caller knows it (absolute or relative to the process cwd). */
  path: string
  /** Topic coordinates; omitted for a plain top-level reply. */
  opts?: { replyInThread?: boolean; replyTo?: string }
  logger: PluginLogger
  /** Override for tests; defaults to the ffmpeg-backed extractor. */
  extractCoverFrame?: CoverFrameExtractor
  /** Abort check run before reading and before each send. */
  signal?: { throwIfAborted(): void }
  /**
   * Run after the file passed validation and before anything is sent. The
   * `feishu_send_file` tool uses it for the optional caption, so a bad path
   * cannot leave a stray caption in the chat.
   */
  beforeSend?: () => Promise<void>
  /** Test/live override for the bounded wait around one send. */
  timeoutMs?: number
}

/** What one delivered file turned into. */
export interface SendWorkspaceFileResult {
  fileName: string
  /** How Feishu rendered it: image, video, audio or file. */
  sentAs: string
  messageId: string
  bytes: number
}

/**
 * Validate one local file and send it into a Feishu chat, in the richest form
 * the platform will render (see the module doc). Throws with an actionable
 * reason for anything that cannot be delivered: a missing/empty/oversized file
 * is reported before a single request goes out, and a refused upload is
 * reported with Feishu's own code.
 *
 * Every send is bounded ({@link FILE_SEND_TIMEOUT_MS}) because the SDK's HTTP
 * client never gives up on its own.
 *
 * @param deps - the live channel, target chat, file and hooks.
 * @returns the file name, the rendering Feishu chose and the message id.
 */
export async function sendWorkspaceFile(deps: SendWorkspaceFileDeps): Promise<SendWorkspaceFileResult> {
  const { channel, chatId, logger } = deps
  const extractCoverFrame = deps.extractCoverFrame ?? extractCoverFrameWithFfmpeg
  const timeoutMs = deps.timeoutMs ?? FILE_SEND_TIMEOUT_MS
  const send = (input: SendInput) =>
    withLinkTimeout(channel.send(chatId, input, deps.opts), 'send file', timeoutMs)

  deps.signal?.throwIfAborted()

  // Validate locally so failures carry actionable messages rather than a
  // Feishu API error (empty file, > 30 MB, missing path).
  let fileStat
  try {
    fileStat = await stat(deps.path)
  } catch {
    throw new Error(`File not found or unreadable: ${deps.path}`)
  }
  if (!fileStat.isFile()) {
    throw new Error(`Not a regular file: ${deps.path}`)
  }
  if (fileStat.size === 0) {
    throw new Error(`File is empty (Feishu rejects empty files): ${deps.path}`)
  }
  if (fileStat.size > FEISHU_MAX_FILE_BYTES) {
    throw new Error(`File is ${fileStat.size} bytes, over Feishu's 30 MB limit: ${deps.path}`)
  }

  deps.signal?.throwIfAborted()
  const bytes = await readFile(deps.path)
  const fileName = basename(deps.path)

  if (deps.beforeSend !== undefined) await deps.beforeSend()

  deps.signal?.throwIfAborted()
  // Sniff from the BYTES, never the filename: sending a container the
  // Feishu client cannot play produces a broken bubble, which is worse
  // than the click-to-open attachment an unknown file gets.
  const sendAsImage = sniffImageMime(bytes) !== undefined && bytes.length <= FEISHU_MAX_IMAGE_BYTES
  const video = sendAsImage ? undefined : sniffVideoContainer(bytes)
  const audio = sendAsImage || video !== undefined ? undefined : sniffAudioContainer(bytes)

  const sendAsFile = async (): Promise<string> =>
    (await send({ file: { source: bytes, fileName } })).messageId ?? ''

  // The SDK throws when it cannot derive a media duration from the bytes
  // (`duration could not be determined for video`), and Feishu can reject
  // an upload it cannot play. Neither may cost the user the file.
  //
  // Images belong here too, which is why the union is not just video/audio:
  // `im.v1.image.create` refuses a picture over 10 MB or over its
  // resolution ceiling (GIF > 2000x2000, anything else > 12000x12000,
  // `234039` — the API docs' own advice for such a picture is to upload it
  // as a file). Without this fallback a long screenshot under 10 MB but
  // over 12000 px failed the whole call and delivered nothing.
  const sendWithFileFallback = async (
    kind: 'image' | 'video' | 'audio',
    input: SendInput,
  ): Promise<{ id: string; sentAs: string }> => {
    try {
      const sent = await send(input)
      return { id: sent.messageId ?? '', sentAs: kind }
    } catch (inlineError: unknown) {
      const reason = errorText(inlineError, 'unknown Feishu error')
      // A TIMEOUT is not a rejection: `withTimeout` only stops the caller from
      // waiting, and the request may still complete server-side. Retrying it as
      // a file would therefore deliver the same file twice (关键坑 29).
      if (/timed out after/u.test(reason)) throw inlineError
      logger.warn(`dsh-feishu: inline ${kind} send of "${fileName}" failed `
        + `(${reason}); falling back to a file attachment`)
      return { id: await sendAsFile(), sentAs: 'file' }
    }
  }

  let sentAs: string
  let messageId: string
  try {
    if (sendAsImage) {
      const outcome = await sendWithFileFallback('image', { image: { source: bytes } })
      sentAs = outcome.sentAs
      messageId = outcome.id
    } else if (video !== undefined) {
      const coverImageKey = await uploadCoverFrame(channel, deps.path, logger, extractCoverFrame)
      const outcome = await sendWithFileFallback('video', {
        video: { source: bytes, ...(coverImageKey === undefined ? {} : { coverImageKey }) },
      })
      sentAs = outcome.sentAs
      messageId = outcome.id
    } else if (audio !== undefined) {
      const outcome = await sendWithFileFallback('audio', { audio: { source: bytes } })
      sentAs = outcome.sentAs
      messageId = outcome.id
    } else {
      sentAs = 'file'
      messageId = await sendAsFile()
    }
  } catch (error: unknown) {
    // Surfacing the specific reason (and Feishu API code, e.g. 230021 for
    // an oversized file) lets the caller report exactly why the send failed
    // instead of a generic "send failed".
    throw new Error(`Failed to send "${fileName}" via Feishu: ${errorText(error, 'unknown Feishu error')}`)
  }

  return { fileName, sentAs, messageId, bytes: bytes.length }
}

/**
 * Register the `feishu_send_file` tool on the global host context (visible to
 * every agent). Unbound sessions — e.g. a session created directly in the
 * WebUI — fail at execution time with a clear error instead of at registration.
 *
 * @param deps Live references to the host context, bridge, and channel.
 * @returns the exact disposer that unregisters the tool.
 */
export function startFeishuSendFileTool(deps: FeishuSendFileDeps): () => void {
  const { ctx, bridgeHolder, channelHolder, logger } = deps
  const extractCoverFrame = deps.extractCoverFrame ?? extractCoverFrameWithFfmpeg

  return ctx.tools.register(defineTool({
    name: 'feishu_send_file',
    description:
      'Send a file from the workspace to the user via Feishu chat. Pass the absolute filesystem '
      + 'path of the file you produced. The file must exist, be a regular non-empty file, and be '
      + 'under 30 MB. Images are sent as inline-preview image messages; MP4/MOV video with an '
      + 'H.264/HEVC/MPEG-4 codec is sent as a playable video message (with a cover frame when '
      + 'ffmpeg is available); Ogg/Opus audio is sent as a voice message; anything else — or an '
      + 'image over 10 MB or over Feishu\'s resolution limit, or a video in a container/codec Feishu '
      + 'cannot play — is sent as a file the user opens. Only works when the current session is bound to a Feishu chat; otherwise '
      + 'it fails with a clear error and you should just tell the user the file path instead.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute filesystem path of the file to send (e.g. the path a write/edit tool returned).',
      },
      caption: {
        type: 'string',
        description: 'Optional short note sent as a text message just before the file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_name: { type: 'string', required: true },
          message_id: { type: 'string', required: true },
          chat_id: { type: 'string', required: true },
          caption_sent: { type: 'boolean', required: true },
          sent_as: {
            type: 'string',
            required: true,
            description: 'How Feishu rendered it: image, video, audio or file.',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Sent "${value.file_name}" to Feishu chat ${value.chat_id} as a ${value.sent_as} (message ${value.message_id}).`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('feishu_send_file requires an agent-backed session')
      }
      exec.signal.throwIfAborted()

      const bridge = bridgeHolder.current
      if (bridge === undefined) {
        throw new Error('dsh-feishu: bridge not ready — try again after the channel connects')
      }
      const chat = bridge.resolveChat(agent.id)
      if (chat === undefined) {
        throw new Error(
          'This session is not bound to a Feishu chat, so there is no chat to send the file to. '
          + `Tell the user the file is at ${JSON.stringify(args.path)} instead.`,
        )
      }
      const ch = channelHolder.current
      if (ch === undefined) {
        throw new Error('dsh-feishu: channel not connected — try again later')
      }

      const opts = chat.threadId !== undefined
        ? { replyInThread: true as const, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
        : {}

      // The optional caption goes after validation (see `beforeSend`), so the
      // explanation precedes the attachment and a bad path leaves no apology.
      let captionSent = false
      const result = await sendWorkspaceFile({
        channel: ch,
        chatId: chat.chatId,
        path: args.path,
        opts,
        logger,
        extractCoverFrame,
        signal: exec.signal,
        beforeSend: async () => {
          if (args.caption === undefined || args.caption.trim() === '') return
          try {
            await withLinkTimeout(ch.send(chat.chatId, { text: args.caption }, opts), 'send caption', FILE_SEND_TIMEOUT_MS)
            captionSent = true
          } catch (error: unknown) {
            throw new Error(`Failed to send caption via Feishu: ${errorText(error, 'unknown Feishu error')}`)
          }
        },
      })
      // Remember the explicit send so the same turn's `present` auto-delivery
      // does not push the identical file a second time. Keyed on the REAL path,
      // which is what the delivery planner validates and records.
      noteDeliveredFile(agent.id, await realpath(args.path).catch(() => args.path))
      logger.warn(`dsh-feishu: feishu_send_file sent "${result.fileName}" to chat ${chat.chatId} (${result.sentAs})`)

      return {
        file_name: result.fileName,
        message_id: result.messageId,
        chat_id: chat.chatId,
        caption_sent: captionSent,
        sent_as: result.sentAs,
      }
    },
  }))
}
