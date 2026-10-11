import { Readable } from 'node:stream'
import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk'
import type { LarkChannel, LarkChannelOptions, NormalizedMessage, ResourceDescriptor } from '@larksuiteoapi/node-sdk'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { RuntimeConfig, ProduceCardMode } from './config.ts'
import type { HarnessConversationService, InboundMessage } from './harness.ts'
import type { BusyMode } from './harness.ts'
import { translationsFor, type Translations } from './i18n.ts'
import { TurnDroppedError } from './harness.ts'
import type { TurnStats } from './feishu-streaming.ts'
import { errorText } from './error-text.ts'
import { TurnFailureError, renderTurnFailureCard, turnFailureText } from './turn-failure.ts'
import { chunkText, truncateInline, CARD_TEXT_MAX } from './text-chunk.ts'
import { sniffImageMime, type ImageMediaTypeId } from './media-sniff.ts'
import { downloadMessageResource } from './feishu-resource.ts'
import { createSafeChannelLogger } from './log-redact.ts'
import { OUTBOUND_TIMEOUT_MS, withTimeout } from './outbound-timeout.ts'
import type { CardImageHydrator } from './card-images.ts'
import { hasDeliverables, renderDeliverableElements, type DeliverChat, type DeliverPlan, type DeliverPlanInput, type DeliverRow } from './feishu-deliver.ts'
import { mergeProducedArtifacts, producedArtifacts } from './produced-files.ts'

// Re-exported for callers that historically reached the sniffer through this
// module; the implementation now lives in `media-sniff.ts` next to the video
// and audio sniffers.
export { sniffImageMime } from './media-sniff.ts'
export type { ImageMediaTypeId } from './media-sniff.ts'

export type ChannelFactory = (options: LarkChannelOptions) => LarkChannel
export interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Max reasoning characters shown on a reply/thinking card (preview only). */
const REASONING_CAP = 200

/**
 * Dispatch a parsed slash command against the receiving chat.
 * Returning `undefined` means the message is not a command; the bridge
 * falls back to its ordinary agent reply.  When `card` is present the
 * channel sends it as an interactive card instead of plain text.
 * Returning `{ kind: 'consumed' }` means the command was handled directly
 * (e.g. a V2 card instance already sent via cardkit) — the channel sends
 * no follow-up message and does NOT fall through to the agent loop.
 */
export type SlashCommandHandler = (
  message: NormalizedMessage,
) => Promise<
  | { kind: 'success' | 'error'; text: string; card?: object }
  | { kind: 'consumed' }
  | undefined
>

/** Narrow attachment-store view needed for image + file admission. The file
 *  verbs are required: this plugin targets DSH 0.1.3, whose `AttachmentStore`
 *  always provides streamed verbatim file storage (`saveFileStream`) and a
 *  host path (`fileHostPath`). No alpha.4 `.feishu-inbox` fallback is kept. */
type AttachmentLike = Pick<AttachmentStore, 'saveImage' | 'imageLimits'> & {
  saveFileStream: (input: { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string }) => Promise<FileAttachmentRef>
  fileHostPath: (ref: FileAttachmentRef) => string | undefined
}

/** Extension hint as a fallback when magic bytes are inconclusive. */
function pickImageMimeByExt(descriptor: ResourceDescriptor): ImageMediaTypeId | undefined {
  const hint = descriptor.fileName?.toLowerCase() ?? ''
  if (hint.endsWith('.png')) return 'image/png'
  if (hint.endsWith('.jpg') || hint.endsWith('.jpeg')) return 'image/jpeg'
  if (hint.endsWith('.webp')) return 'image/webp'
  if (hint.endsWith('.gif')) return 'image/gif'
  return undefined
}

/**
 * Resolve the real media type for an image: magic bytes take priority (the
 * attachment store validates against actual bytes), the filename extension is
 * only a fallback when the header is unrecognizable. Never guesses JPEG.
 */
function pickImageMime(bytes: Uint8Array, descriptor: ResourceDescriptor): ImageMediaTypeId | undefined {
  return sniffImageMime(bytes) ?? pickImageMimeByExt(descriptor)
}

/**
 * Read the SDK download wrapper (which exposes its body as a Readable) into
 * a single buffer. `im.v1.image.get` and `im.v1.messageResource.get` both
 * return `{ writeFile, getReadableStream, headers }`, not a raw Buffer.
 */
async function readDownloadStream(raw: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  if (raw !== null && typeof raw === 'object' && typeof (raw as { getReadableStream?: () => unknown }).getReadableStream === 'function') {
    const stream = (raw as { getReadableStream: () => unknown }).getReadableStream()
    if (!(stream instanceof Readable)) throw new Error('dsh-feishu: unexpected stream type from messageResource.get')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
  }
  throw new Error('dsh-feishu: unsupported download response shape')
}

/**
 * Expose the SDK download wrapper as an `AsyncIterable<Uint8Array>` so the
 * native attachment stream (`saveFileStream`) can pull bounded chunks with
 * backpressure instead of buffering the whole file in memory.
 */
async function* downloadStream(raw: unknown): AsyncGenerator<Uint8Array> {
  if (Buffer.isBuffer(raw)) { yield raw; return }
  if (raw instanceof Uint8Array) { yield raw; return }
  if (raw !== null && typeof raw === 'object' && typeof (raw as { getReadableStream?: () => unknown }).getReadableStream === 'function') {
    const stream = (raw as { getReadableStream: () => unknown }).getReadableStream()
    if (!(stream instanceof Readable)) throw new Error('dsh-feishu: unexpected stream type from messageResource.get')
    for await (const chunk of stream) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    return
  }
  throw new Error('dsh-feishu: unsupported download response shape')
}

/**
 * Pull every image resource off one normalized message, download it via the
 * correct `im.v1.messageResource` endpoint (user-sent images, NOT `im.v1.image`
 * which only serves bot-uploaded keys), and durably commit the bytes via the
 * attachment store. Returns an empty array when the message carries no images.
 */
async function admitImagesForMessage(
  channel: LarkChannel,
  message: NormalizedMessage,
  attachments: AttachmentLike,
  signal: AbortSignal,
): Promise<readonly ImageAttachmentRef[]> {
  const resources = (message.resources ?? []).filter(resource => resource.type === 'image')
  if (resources.length === 0) return []
  const accepted = attachments.imageLimits.mediaTypes
  const inputs: SaveImageAttachment[] = []
  for (const resource of resources) {
    if (signal.aborted) throw new Error('dsh-feishu: image admission aborted')
    // `LarkChannel.downloadResource(fileKey, 'image')` resolves the wrong
    // endpoint (`im.v1.image.get`) which 400s for user-sent keys. The
    // `im.v1.messageResource.get` endpoint takes the message id plus the file
    // key, so reach into the raw HTTP client directly.
    const raw = await channel.rawClient.im.v1.messageResource.get({
      params: { type: 'image' },
      path: { message_id: message.messageId, file_key: resource.fileKey },
    })
    if (signal.aborted) throw new Error('dsh-feishu: image admission aborted')
    const bytes = await readDownloadStream(raw)
    // Resolve the media type FROM THE BYTES, not a guessed MIME. The
    // attachment store rejects declared-vs-actual mismatches, so a filename
    // hint is only a fallback and JPEG is never assumed.
    const mediaType = pickImageMime(bytes, resource)
    if (mediaType === undefined || !accepted.includes(mediaType)) {
      throw new Error(`dsh-feishu: image type "${mediaType ?? 'unknown'}" is not accepted by the deployment`)
    }
    inputs.push({
      data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      mediaType,
      ...resource.fileName === undefined ? {} : { name: resource.fileName },
    })
  }
  const refs: ImageAttachmentRef[] = []
  for (const input of inputs) refs.push(await attachments.saveImage(input))
  return refs
}

/** One admitted inbound file. The bytes are persisted via the native
 *  attachment store (`attachments.saveFileStream`) and `fileRef` is the durable
 *  ref to attach as a `{ type:'file', attachment }` content block; `hostPath`
 *  is its absolute on-disk path (the agent reads the file there). */
export interface FileAdmission {
  fileRef: FileAttachmentRef
  hostPath?: string
  fileName: string
}

/**
 * Resource kinds that carry a downloadable attachment. The SDK normalizes a
 * user-sent video as `{ type: 'video' }` and a voice message as
 * `{ type: 'audio' }` — neither is `'file'`, so filtering on `'file'` alone
 * used to drop them and the agent only ever saw a bare `<video key="…"/>` tag.
 */
const ADMITTED_RESOURCE_TYPES = new Set(['file', 'video', 'audio'])

/**
 * Download every file/video/audio resource off one normalized message and
 * persist the bytes through DSH's native attachment store
 * (`saveFileStream`), so each is attached to the user message as a durable
 * `{ type:'file', attachment }` content block whose `hostPath` the agent can
 * open with its file tools. Returns an empty array when the message carries
 * no such resources.
 */
async function admitFilesForMessage(
  channel: LarkChannel,
  message: NormalizedMessage,
  signal: AbortSignal,
  attachments: AttachmentLike,
): Promise<readonly FileAdmission[]> {
  const resources = (message.resources ?? []).filter(resource => ADMITTED_RESOURCE_TYPES.has(resource.type))
  if (resources.length === 0) return []
  const results: FileAdmission[] = []
  for (const resource of resources) {
    if (signal.aborted) throw new Error('dsh-feishu: file admission aborted')
    const raw = await downloadMessageResource(channel, message.messageId, resource.fileKey)
    if (signal.aborted) throw new Error('dsh-feishu: file admission aborted')
    const rawName = resource.fileName ?? resource.fileKey
    // A video/audio resource sometimes arrives without a file_name; keep a
    // usable extension so the agent's file tools see what it is.
    const fileName = rawName.includes('.') || resource.type === 'file'
      ? rawName
      : `${rawName}.${resource.type === 'video' ? 'mp4' : 'opus'}`
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const fileRef = await attachments.saveFileStream({
      data: downloadStream(raw),
      signal,
      name: safeName,
    })
    const hostPath = attachments.fileHostPath(fileRef)
    results.push(hostPath === undefined ? { fileRef, fileName } : { fileRef, hostPath, fileName })
  }
  return results
}

/** Metadata for the reply card footer. */
export interface ReplyCardMeta {
  workspace?: string
  agentPreset?: string
  model?: string
  reasoningEffort?: string
  contextWindow?: number
  lastInputTokens?: number
  /** Paired decode throughput of the turn (output tokens ÷ decode time). */
  tokensPerSecond?: number
  /** Per-chat Enter-behavior-while-busy mode (Queue / Steer), shown in the Turn Complete footer. */
  busyMode?: BusyMode
}

/** Chat coordinates passed to the footer callback for session lookup. */
export interface ChatCoordinates {
  chatId: string
  chatType: 'p2p' | 'group'
  threadId?: string
}

export async function startChannel(
  config: Omit<RuntimeConfig, 'appSecretRef'>,
  bridge: Pick<HarnessConversationService, 'reply' | 'dispose' | 'consumeIntermediateSent' | 'resolveSessionIdFor' | 'needsOnboarding' | 'noteTopic'>,
  factory: ChannelFactory = createLarkChannel,
  logger: PluginLogger = console,
  terminalLogger?: Pick<PluginLogger, 'error'>,
  slashCommand?: SlashCommandHandler,
  attachments?: AttachmentLike,
  replyCardMeta?: (coords: ChatCoordinates) => ReplyCardMeta | Promise<ReplyCardMeta>,
  consumeReasoning?: (sessionId: string) => string | undefined,
  consumeLastStepHadContent?: (sessionId: string) => boolean,
  flushed?: (sessionId: string) => Promise<TurnStats | undefined>,
  messageInterceptor?: (msg: NormalizedMessage) => boolean | Promise<boolean>,
  onboarding?: {
    needsOnboarding(msg: NormalizedMessage): Promise<boolean>
    sendOnboardingCard(msg: NormalizedMessage): Promise<void>
  },
  getTranslations?: () => Translations,
  /**
   * Resolve the images a reply card references into Feishu image keys, so a
   * picture the model pointed at renders instead of degrading to text. Optional
   * and best-effort: `card-markdown.ts` already keeps the card valid without it.
   */
  hydrateImages?: CardImageHydrator,
  /**
   * Deliver the files DSH's `present` tool declared (see `feishu-deliver.ts`):
   * plan them for the Turn Complete card, then push the ones that need no
   * confirmation. Optional — without it the card keeps the plain list.
   */
  deliver?: {
    plan(input: DeliverPlanInput): Promise<DeliverPlan>
    autoSend(plan: DeliverPlan, chat: DeliverChat): Promise<void>
  },
  /**
   * Remember which topic a card message landed in, so a later tap on it can be
   * traced back (关键坑 31). Optional: without it the deliverable rows fall
   * back to the chat-level topic guess.
   */
  noteCardTopic?: (messageId: string, topic: { threadId?: string; rootId?: string }) => void,
  /**
   * Live `produceCard` setting: what to do with files this turn produced without
   * declaring them through `present` (`src/produced-files.ts`). `off` (and an
   * omitted callback) keeps them invisible, `summary` adds the count line,
   * `delivery` also routes the artifact-shaped ones through the delivery plan.
   */
  produceCardMode?: () => ProduceCardMode,
): Promise<{ stop: () => Promise<void>; channel: LarkChannel }> {
  const logError = (message: string) => {
    logger.error(message)
    terminalLogger?.error(message)
  }
  /**
   * Report a failed request back into the chat.
   *
   * A terminal *turn* failure arrives as a {@link TurnFailureError} carrying the
   * same structured facts the DSH Web UI renders (`reason.error.message` +
   * `.code`); it is rendered with {@link renderTurnFailureCard} so both surfaces
   * show the same reason. Everything else is a plugin-side error (Feishu API,
   * slash command, media admission) and keeps the concrete `errorText()` reason.
   */
  const sendFailure = async (
    chatId: string,
    error: unknown,
    opts: { replyTo: string; replyInThread: boolean },
  ): Promise<void> => {
    const deliver = async (payload: { text: string } | { card: object }): Promise<boolean> => {
      try {
        await sendOutbound(chatId, payload, opts)
        return true
      } catch (sendError: unknown) {
        logError(`dsh-feishu: failure reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
        return false
      }
    }
    if (error instanceof TurnFailureError) {
      const t = getTranslations?.() ?? translationsFor('zh')
      if (await deliver({ card: renderTurnFailureCard(t, error.failure) })) return
      // The card is the richer shape, not the only one: if Feishu rejects it,
      // fall back to plain text carrying the same reason and code.
      await deliver({ text: turnFailureText(t, error.failure) })
      return
    }
    await deliver({ text: `处理这条消息时出错：${errorText(error, config.errorMessage)}` })
  }
  const channel = factory({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    domain: config.domain === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'dsh-feishu',
    loggerLevel: LoggerLevel.info,
    // The SDK's own logger dumps the whole axios error on a failed request,
    // and that error carries the token request body — app_secret in clear text.
    // Ours reduces errors to message + stack and scrubs known secrets (key
    // pitfall 29, secondary finding).
    logger: createSafeChannelLogger([config.appSecret]),
    handshakeTimeoutMs: 15_000,
    includeRawEvent: true,
    // Self-healing inbound: on a silent network partition (TCP half-open) the
    // socket never emits a clean `close`, so the SDK's auto-reconnect never
    // fires and inbound messages stop while outbound (new HTTP connections per
    // send) still works. The SDK's liveness watchdog (no inbound frame within
    // `pingTimeout` of the last ping) terminates the dead socket to trigger a
    // reconnect — but it is DISABLED unless `wsConfig.pingTimeout` is set
    // (defaults to 0). Enabling it restores inbound self-healing.
    wsConfig: { pingTimeout: 60 },
    policy: {
      requireMention: config.requireMention,
      dmMode: config.dmMode,
      groupAllowlist: config.groupAllowlist,
      dmAllowlist: config.dmAllowlist,
      respondToMentionAll: false,
    },
    safety: {
      chatQueue: { enabled: true },
      staleMessageWindowMs: 5 * 60_000,
      dedup: { ttl: 10 * 60_000, maxEntries: 10_000 },
    },
  })

  /**
   * Every outbound message this module posts goes through here so the wait is
   * bounded.
   *
   * The SDK builds its HTTP client with `timeout: 0`, so a request the peer
   * never answers (half-open TLS socket behind a proxy — observed 2026-09-21)
   * stays pending forever. A handler that awaits it is stuck forever too, and
   * the user's reply never arrives (key pitfall 29).
   */
  const sendOutbound = (
    to: string,
    input: { card: object } | { text: string },
    opts?: { replyInThread?: boolean; replyTo?: string },
  ): Promise<{ messageId?: string }> =>
    withTimeout(channel.send(to, input, opts), 'send message', OUTBOUND_TIMEOUT_MS)

  /**
   * Send a card, first letting the image hydrator inline whatever local paths it
   * references. Hydration is bounded and never rejects; a card that cannot be
   * hydrated is still sent (its references then render as text).
   *
   * Returns the message id so the caller can register which topic the card
   * landed in (关键坑 31): a card that carries clickable rows must be findable
   * from the tap that follows.
   */
  const sendCard = async (
    to: string,
    card: object,
    opts: { replyInThread?: boolean; replyTo?: string },
    workspace?: string,
  ): Promise<{ messageId?: string }> => {
    let prepared = card
    if (hydrateImages !== undefined) {
      prepared = await hydrateImages(card, workspace === undefined ? {} : { workspace }).catch(() => card)
    }
    return sendOutbound(to, { card: prepared }, opts)
  }

  const unsubscribers = [
    channel.on('message', async (message: NormalizedMessage) => {
      // Message interceptor (e.g., for question custom-input collection).
      // If the interceptor returns true, the message is consumed.
      if (messageInterceptor !== undefined) {
        try {
          const consumed = await messageInterceptor(message)
          if (consumed) return
        } catch (error: unknown) {
          logger.warn(`dsh-feishu: message interceptor error: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const replyInThread = message.threadId !== undefined
      // Feishu topic replies must target the topic ROOT message: replying to a
      // non-root topic message with `reply_in_thread` does not reliably land in
      // the topic. Root messages (no root_id) reply to themselves.
      const replyToId = message.rootId ?? message.messageId
      console.log(`dsh-feishu: [msg] chatId=${message.chatId} threadId=${message.threadId ?? '-'} rootId=${message.rootId ?? '-'} replyInThread=${replyInThread} replyTo=${replyToId}`)
      // Remember the topic's root for EVERY inbound message — slash commands
      // included, before they can return early. A WebUI-driven turn has no
      // inbound message of its own, so this persisted map is the only thing
      // that can keep its cards inside the topic.
      if (message.threadId !== undefined) {
        bridge.noteTopic({
          chatId: message.chatId,
          chatType: message.chatType,
          threadId: message.threadId,
          rootId: replyToId,
        })
      }
      if (config.reactEmoji !== '') {
        try {
          await channel.addReaction(message.messageId, config.reactEmoji)
        } catch (error: unknown) {
          logger.warn(`dsh-feishu: reaction failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // Slash commands bypass the agent loop entirely; the registered
      // command handler resolves the chat's session and produces a direct
      // textual result.
      if (slashCommand !== undefined) {
        try {
          const commandResult = await slashCommand(message)
          if (commandResult !== undefined) {
            if (commandResult.kind === 'consumed') {
              // The handler already sent its response directly (e.g. a V2
              // card instance via cardkit). Do not send a follow-up and do
              // not fall through into the agent loop.
              return
            }
            const payload = commandResult.card !== undefined ? { card: commandResult.card } : { text: commandResult.text }
            await sendOutbound(message.chatId, payload, {
              replyTo: replyToId,
              replyInThread,
            })
            return
          }
        } catch (error: unknown) {
          logError(`dsh-feishu: slash command failed: ${error instanceof Error ? error.message : String(error)}`)
          await sendOutbound(message.chatId, { text: `命令执行出错：${errorText(error, config.errorMessage)}` }, {
            replyTo: replyToId,
            replyInThread,
          }).catch((sendError: unknown) => {
            logError(`dsh-feishu: fallback reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
          })
          return
        }
      }
      // Admit any image resources on the inbound message through the
      // attachment store so the bridge can attach durable ImageBlocks to
      // the user turn. Without an attachment service we reject image-bearing
      // messages so the bridge never falls back to a text-only user turn
      // that would silently drop the image.
      let inboundMessage: InboundMessage = {
        chatId: message.chatId,
        chatType: message.chatType,
        ...message.threadId === undefined ? {} : { threadId: message.threadId },
        ...message.threadId === undefined ? {} : { rootId: replyToId },
        content: message.content,
      }
      if ((message.resources ?? []).some(resource => resource.type === 'image')) {
        if (attachments === undefined) {
          await sendOutbound(message.chatId, {
            text: 'Image messages are not supported because the deployment has no attachment service composed.',
          }, { replyTo: replyToId, replyInThread }).catch(() => undefined)
          return
        }
        try {
          const imageBlocks = await admitImagesForMessage(channel, message, attachments, new AbortController().signal)
          inboundMessage = { ...inboundMessage, imageBlocks }
        } catch (error: unknown) {
          logError(`dsh-feishu: image admission failed: ${error instanceof Error ? error.message : String(error)}`)
          await sendOutbound(message.chatId, { text: `图片处理出错：${errorText(error, config.errorMessage)}` }, {
            replyTo: replyToId,
            replyInThread,
          }).catch(() => undefined)
          return
        }
      }
      // Admit file/video/audio resources: persist the bytes through the native
      // attachment store (`saveFileStream`) and attach each durable ref to the
      // user turn so the agent can read the file at `hostPath`.
      if ((message.resources ?? []).some(resource => ADMITTED_RESOURCE_TYPES.has(resource.type))) {
        if (attachments === undefined) {
          await sendOutbound(message.chatId, {
            text: 'File messages are not supported because the deployment has no attachment service composed.',
          }, { replyTo: replyToId, replyInThread }).catch(() => undefined)
          return
        }
        try {
          const files = await admitFilesForMessage(channel, message, new AbortController().signal, attachments)
          if (files.length > 0) {
            inboundMessage = {
              ...inboundMessage,
              fileBlocks: [
                ...(inboundMessage.fileBlocks ?? []),
                ...files.map(f => f.hostPath === undefined
                  ? { attachment: f.fileRef }
                  : { attachment: f.fileRef, hostPath: f.hostPath }),
              ],
            }
          }
        } catch (error: unknown) {
          logError(`dsh-feishu: file admission failed: ${error instanceof Error ? error.message : String(error)}`)
          // Non-fatal: continue with the message even if file download fails.
          // The agent will see the raw <file .../> tag and can report the issue.
        }
      }
      try {
        // First-message onboarding: a chat with no session history gets a
        // card (attach an existing session or create a new one) instead of
        // silently auto-creating a session. Only non-command messages reach
        // this point — slash commands (including `/new`) are handled above.
        if (onboarding !== undefined) {
          const needsOnboarding = await onboarding.needsOnboarding(message)
          if (needsOnboarding) {
            await onboarding.sendOnboardingCard(message)
            return
          }
        }
        // Fire-and-forget: submit the message to the agent and return
        // immediately so the chatQueue can deliver the next message (e.g.
        // a slash command) without waiting for the agent turn to finish.
        // The reply card is sent asynchronously when the agent completes.
        const chatId = message.chatId
        const chatType = message.chatType
        const threadId = message.threadId
        void bridge.reply(inboundMessage, {
          // Plain-text acknowledgement when the agent is busy: steer injects
          // into the running turn, queue waits for it. Deliberately a text
          // message, not a card — it is transient feedback, not a result.
          onBusy: (mode) => {
            const t = getTranslations?.() ?? translationsFor('zh')
            const notice = mode === 'steer' ? t.busySteeredNotice : t.busyQueuedNotice
            void sendOutbound(chatId, { text: notice }, {
              replyTo: replyToId,
              replyInThread,
            }).catch((error: unknown) => {
              logError(`dsh-feishu: busy notice failed: ${error instanceof Error ? error.message : String(error)}`)
            })
          },
        }).then(async (text) => {
          // A steered message produces no reply of its own: the running turn's
          // reply card already answers it (otherwise the user gets two cards
          // for one turn).
          if (text === undefined) return
          const sessionId = bridge.resolveSessionIdFor(inboundMessage)
          const meta = await replyCardMeta?.({ chatId, chatType, ...(threadId !== undefined ? { threadId } : {}) })
          // Read the "the text is already on screen" flag AFTER flushed().
          // Streaming clears it there when the turn's cards never actually
          // reached Feishu, so that the branch below still posts the answer;
          // reading it earlier would miss that correction (key pitfall 29).
          const turnStats = await flushed?.(sessionId)
          const intermediateSent = bridge.consumeIntermediateSent(sessionId)
          // What this turn produced without declaring it through `present`
          // (TODO O3). `off` keeps the pre-2026-10-11 silence; `summary` only
          // announces the count; `delivery` also folds the artifact-shaped files
          // into the delivery plan below, so they get the SAME treatment a
          // presented file gets — media inlined, documents auto-sent, the rest a
          // tap-to-send row. Source files and scratch scripts are never part of
          // it (`producedArtifacts`), because a chat is not a file browser.
          const produceMode = produceCardMode?.() ?? 'off'
          const produced = produceMode === 'off' ? [] : producedArtifacts(turnStats?.produced ?? [])
          const producedCount = produceMode === 'off' ? undefined : produced.length
          const deliverChat: DeliverChat = {
            chatId,
            ...(threadId === undefined ? {} : { threadId }),
            rootId: replyToId,
          }
          // Plan the turn's `present` deliverables before the cards are built:
          // the plan decides which rows are clickable and which documents go out
          // by themselves (see `feishu-deliver.ts`). A planning failure must not
          // cost the answer, so it is contained here.
          const deliverPlan = deliver === undefined
            ? undefined
            : await deliver.plan({
                sessionId,
                chatId,
                ...(threadId === undefined ? {} : { topic: { threadId, rootId: replyToId } }),
                ...(meta?.workspace === undefined ? {} : { workspace: meta.workspace }),
                files: produceMode === 'delivery'
                  ? mergeProducedArtifacts(turnStats?.deliverables ?? [], produced, meta?.workspace)
                  : turnStats?.deliverables ?? [],
              }).catch((error: unknown) => {
                logError(`dsh-feishu: deliverable planning failed: ${error instanceof Error ? error.message : String(error)}`)
                return undefined
              })
          /** Remember the topic of a card that carries clickable rows. */
          const noteTopic = (messageId: string | undefined): void => {
            if (messageId === undefined || threadId === undefined || noteCardTopic === undefined) return
            noteCardTopic(messageId, { threadId, rootId: replyToId })
          }
          const autoDeliver = async (): Promise<void> => {
            if (deliver === undefined || deliverPlan === undefined) return
            await deliver.autoSend(deliverPlan, deliverChat)
          }

          if (intermediateSent) {
            // Streaming already sent a step card with the text content:
            // send only the Turn Complete footer.
            console.log('dsh-feishu: [reply] a step card carried the text → footer only')
            const footerCard = renderFooterCard(getTranslations?.() ?? translationsFor('zh'), meta, turnStats, deliverPlan?.rows, undefined, producedCount)
            // The auto-send runs even if posting the footer failed: the files
            // are what the operator asked for, and swallowing them behind a
            // card-send error would be the worse failure.
            try {
              if (footerCard !== undefined) {
                const sent = await sendCard(chatId, footerCard, {
                  replyTo: replyToId,
                  replyInThread,
                }, meta?.workspace)
                noteTopic(sent.messageId)
              }
            } finally {
              await autoDeliver()
            }
          } else {
            // No intermediate card made it to the chat — send the full reply,
            // split across multiple cards if the output exceeds one card's
            // content budget. This is the safety net that keeps a failed step
            // card from swallowing the whole answer.
            // Carry the turn's decode throughput so this fallback card shows a
            // tok/s line like every other assistant card.
            const tps = turnTokensPerSecond(turnStats)
            const cards = renderReplyCards(text, tps === undefined ? meta : { ...meta, tokensPerSecond: tps })
            console.log(`dsh-feishu: [reply] no step card carried the text → posting ${cards.length} reply card(s)`)
            for (const card of cards) {
              await sendCard(chatId, card, {
                replyTo: replyToId,
                replyInThread,
              }, meta?.workspace)
            }
            // This path builds no footer of its own, so a turn that declared
            // deliverables would lose both the list and the auto-delivery. The
            // footer is only posted when there IS something to deliver.
            try {
              if (hasDeliverables(deliverPlan)) {
                const footerCard = renderFooterCard(getTranslations?.() ?? translationsFor('zh'), meta, turnStats, deliverPlan.rows, undefined, producedCount)
                if (footerCard !== undefined) {
                  const sent = await sendCard(chatId, footerCard, {
                    replyTo: replyToId,
                    replyInThread,
                  }, meta?.workspace)
                  noteTopic(sent.messageId)
                }
              }
            } finally {
              await autoDeliver()
            }
          }
        }).catch((error: unknown) => {
          if (error instanceof TurnDroppedError) {
            // Message intentionally dropped because the session was stopped
            // while it waited for the current turn — no error card needed.
            logError(`dsh-feishu: message dropped (session stopped): ${error.message}`)
            return
          }
          logError(`dsh-feishu: message handling failed: ${error instanceof Error ? error.message : String(error)}`)
          void sendFailure(chatId, error, { replyTo: replyToId, replyInThread })
        })
      } catch (error: unknown) {
        // Synchronous errors from bridge.reply() setup (rare)
        logError(`dsh-feishu: message dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
        await sendFailure(message.chatId, error, { replyTo: replyToId, replyInThread })
      }
    }),
    channel.on('reconnecting', () => { logger.warn('dsh-feishu: WebSocket reconnecting') }),
    channel.on('reconnected', () => { logger.info('dsh-feishu: WebSocket reconnected') }),
    channel.on('error', (error) => { logError(`dsh-feishu: channel error: ${String(error)}`) }),
  ]
  try {
    await channel.connect()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const redacted = config.appSecret === '' ? detail : detail.split(config.appSecret).join('[redacted]')
    logError(`dsh-feishu: WebSocket connection failed: ${redacted}`)
    for (const unsubscribe of unsubscribers) unsubscribe()
    await bridge.dispose()
    throw error
  }
  logger.info('dsh-feishu: WebSocket connected')

  return {
    channel,
    stop: async () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      try {
        await channel.disconnect()
        logger.info('dsh-feishu: WebSocket disconnected')
      } finally {
        await bridge.dispose()
      }
    },
  }
}

/** Compact token count display: 517 / 12.2K / 1.2M */
function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

/**
 * Render a reasoning-only card for the two-phase reply pattern.
 * Shown first, then updated with the full reply content.
 */
function renderReasoningForReply(reasoning: string): object {
  // Reasoning is a preview only: keep a short window, never the full chain.
  const displayReasoning = reasoning.length > REASONING_CAP ? reasoning.slice(0, REASONING_CAP) + '\n…(truncated)' : reasoning
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Thinking' },
      template: 'violet',
    },
    body: { elements: [{ tag: 'markdown', content: `\`\`\`\n${displayReasoning}\n\`\`\`` }] },
  }
}

/**
 * Render an assistant reply as one or more Feishu interactive cards with
 * optional workspace/preset footer metadata. Card JSON 2.0 supports full
 * markdown (tables, headings, inline code) natively.
 *
 * Long model output is partitioned into multiple cards so none of them is
 * silently truncated by the card renderer. Reasoning is only drawn on the
 * first card; the footer metadata is only drawn on the last card.
 */
export function renderReplyCards(text: string, meta?: ReplyCardMeta, reasoning?: string): object[] {
  // Ensure content is never empty - use a placeholder if needed
  const displayText = text.trim() === '' ? '(empty response)' : text
  const reasonForHeader = (reasoning !== undefined && reasoning !== '') ? reasoning : undefined

  const textChunks = chunkText(displayText, CARD_TEXT_MAX)
  const total = textChunks.length
  const cards: object[] = []

  for (let i = 0; i < total; i++) {
    const isFirst = i === 0
    const isLast = i === total - 1
    const elements: object[] = []

    if (isFirst && reasonForHeader !== undefined) {
      // Reasoning is a preview only: keep a short window, never the full chain.
      const displayReasoning = reasonForHeader.length > REASONING_CAP ? reasonForHeader.slice(0, REASONING_CAP) + '\n…(truncated)' : reasonForHeader
      elements.push({
        tag: 'markdown',
        content: `🧠 **Reasoning**\n\`\`\`\n${displayReasoning}\n\`\`\``,
      })
      elements.push({ tag: 'hr' })
    }

    // A short continuation header helps the reader see a card is a fragment of
    // a longer reply instead of thinking the answer ended abruptly.
    if (total > 1) {
      elements.push({ tag: 'markdown', content: `*(${tReplyPart(i + 1, total)})*`, text_size: 'notation' })
    }
    elements.push({
      tag: 'markdown',
      content: textChunks[i],
    })

    if (isLast) {
      elements.push(...buildReplyFooter(meta))
    }

    cards.push({
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: total > 1 ? `Reply (${i + 1}/${total})` : 'Reply' },
        template: 'blue',
      },
      body: { elements },
    })
  }
  return cards
}

/** Local "part i/total" label used in the reply card continuation header. */
function tReplyPart(i: number, total: number): string {
  return `Part ${i}/${total}`
}

/** Build the footer metadata elements (workspace/preset/model/context). */
function buildReplyFooter(meta?: ReplyCardMeta): object[] {
  const elements: object[] = []
  const line1: string[] = []
  const line2: string[] = []
  if (meta?.workspace !== undefined && meta.workspace !== '') {
    line1.push(`📂 ${meta.workspace}`)
  }
  if (meta?.agentPreset !== undefined && meta.agentPreset !== '') {
    line1.push(`⚙️ ${meta.agentPreset}`)
  }
  if (meta?.model !== undefined && meta.model !== '') {
    line2.push(`🧠 ${meta.model}`)
  }
  if (meta?.reasoningEffort !== undefined && meta.reasoningEffort !== '') {
    line2.push(`💡 ${meta.reasoningEffort}`)
  }
  if (meta?.contextWindow !== undefined && meta.contextWindow > 0 && meta?.lastInputTokens !== undefined) {
    const pct = Math.min(100, Math.round(meta.lastInputTokens / meta.contextWindow * 100))
    line2.push(`📊 ${formatTokenCount(meta.lastInputTokens)}/${formatTokenCount(meta.contextWindow)} (${pct}%)`)
  }
  if (meta?.tokensPerSecond !== undefined && meta.tokensPerSecond > 0) {
    line2.push(`🚀 ${meta.tokensPerSecond.toFixed(0)} tok/s`)
  }
  const noteElements: object[] = []
  if (line1.length > 0) noteElements.push({ tag: 'lark_md', content: line1.join(' · ') })
  if (line2.length > 0) noteElements.push({ tag: 'lark_md', content: line2.join(' · ') })
  if (noteElements.length > 0) {
    elements.push({ tag: 'hr' })
    // Card JSON 2.0 doesn't support 'note' tag — use markdown with notation text size
    const footerContent = (noteElements as Array<{ tag: string; content?: string }>)
      .filter((e) => e.tag === 'lark_md')
      .map((e) => e.content ?? '')
      .filter(Boolean)
      .join('\n')
    if (footerContent !== '') {
      elements.push({ tag: 'markdown', content: footerContent, text_size: 'notation' })
    }
  }
  return elements
}

/**
 * Paired decode throughput of a turn: output tokens ÷ decode time over the
 * SAME steps (a step with no timed first token contributes neither). Mirrors
 * the Web UI's `deriveTurnMetrics`; returns undefined when not computable.
 */
export function turnTokensPerSecond(turnStats?: TurnStats): number | undefined {
  if (turnStats === undefined || turnStats.totalDecodeMs <= 0 || turnStats.totalDecodeTokens <= 0) return undefined
  return turnStats.totalDecodeTokens / (turnStats.totalDecodeMs / 1000)
}

/** How many deliverables the Turn Complete card lists before collapsing. */
const DELIVERABLE_DISPLAY_CAP = 6

/** Cap for one deliverable's description on the card (characters). */
const DELIVERABLE_NOTE_CAP = 60

/** Shorten a deliverable description so one long note cannot dominate the card. */
function capDeliverableNote(value: string): string {
  const flat = value.replace(/[\r\n]+/gu, ' ').trim()
  return flat.length <= DELIVERABLE_NOTE_CAP ? flat : truncateInline(flat, DELIVERABLE_NOTE_CAP - 1)
}

/**
 * One deliverable as a Markdown LINK rather than a code span.
 *
 * The list is the one place where the operator is being handed files, so it has
 * to go through the same media hydrator as the reply text: `channel.ts`'s card
 * writer resolves `[label](path)` destinations against the session workspace, so
 * a delivered clip or still renders inline here exactly like one referenced in
 * the answer. A file the hydrator cannot inline degrades to `label · \`path\`` —
 * still naming the path, which is what the code span did before.
 *
 * Two escapes matter, both for the SCANNER (`card-markdown.ts`), which only
 * recognises `[label](target)` with a bracket-free label and a whitespace-free
 * target: a description may contain `[`/`]`/backticks, and a path may contain
 * spaces or parentheses → those targets use the `[label](<target>)` form.
 */
function deliverableLink(path: string, description?: string): string {
  const label = (description === undefined ? path : capDeliverableNote(description))
    .replace(/`/gu, "'")
    .replace(/[[\]]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const target = /[\s()]/u.test(path) ? `<${path.replace(/[<>]/gu, '')}>` : path
  return `[${label === '' ? path : label}](${target})`
}

/**
 * Render a Turn Complete card with turn stats and optional session metadata.
 * Returns undefined when there's nothing to show.
 *
 * `deliverRows` (from `feishu-deliver.ts`) replaces the plain deliverable list
 * when the caller planned one: media is named and inlined, whitelisted
 * documents are marked as auto-sent, and everything else becomes a clickable
 * row carrying an opaque token. Omitting it keeps the pre-2026-10-06 rendering
 * (a plain list) — tests and any deployment without the deliver controller.
 */
export function renderFooterCard(
  t: Translations,
  meta?: ReplyCardMeta,
  turnStats?: TurnStats,
  deliverRows?: readonly DeliverRow[],
  /**
   * What started a turn that did NOT come from a Feishu message — the other
   * human surface, or the family of automation DSH woke the agent with. Set,
   * the card leads with a line naming it, because nothing else in the chat
   * announced that turn (see `feishu-external-turns.ts`). Omitted for a
   * Feishu-started turn.
   */
  externalSource?: string,
  /**
   * How many artifact-shaped files this turn produced without `present`, or
   * `undefined` when the `produceCard` setting is `off` (see
   * `src/produced-files.ts`). Rendered as one notation line under the metrics.
   */
  producedCount?: number,
): object | undefined {
  const elements: object[] = []
  if (externalSource !== undefined) {
    elements.push({ tag: 'markdown', content: t.turnCompleteExternalTurn(externalSource), text_size: 'notation' })
  }

  // Deliverables lead the card: they are the one part the user may want to act
  // on, so they must not sit underneath the metrics. A divider separates them
  // from the stats that follow. The list IS the Feishu deliverable surface:
  // media renders in the card itself, whitelisted documents are pushed right
  // after this card, and the remaining files are one confirmation away.
  const deliverables = turnStats?.deliverables ?? []
  if (deliverRows !== undefined && deliverRows.length > 0) {
    elements.push(...renderDeliverableElements(deliverRows, t))
    elements.push({ tag: 'hr' })
  } else if (deliverables.length > 0) {
    const shown = deliverables.slice(0, DELIVERABLE_DISPLAY_CAP)
    const lines = shown.map((file) => `• ${deliverableLink(file.path, file.description)}`)
    if (deliverables.length > shown.length) {
      lines.push(t.deliverablesMore(deliverables.length - shown.length))
    }
    elements.push({ tag: 'markdown', content: `${t.deliverablesTitle(deliverables.length)}\n${lines.join('\n')}` })
    elements.push({ tag: 'hr' })
  }

  // Turn stats section — all notation size
  if (turnStats !== undefined) {
    // Duration: total (wall-clock) / LLM / tools
    const totalMs = turnStats.totalTurnMs || turnStats.totalStepMs
    const llmMs = turnStats.totalStepMs
    const toolMs = turnStats.totalToolMs
    const durParts: string[] = [
      `⏱ ${formatMs(totalMs)}`,
      `🧠 LLM ${formatMs(llmMs)}`,
      `🔧 Tools ${formatMs(toolMs)}`,
    ]
    elements.push({ tag: 'markdown', content: durParts.join(' · '), text_size: 'notation' })

    // What the turn PRODUCED beyond what `present` declared (TODO O3). One line,
    // no paths and no buttons: a chat is not a workspace browser, and this is
    // the count the WebUI's produced row carries — the artifact-shaped files
    // themselves are delivered through the row list above. Absent when the
    // `produceCard` setting is `off` (the caller passes nothing then).
    if (producedCount !== undefined && producedCount > 0) {
      elements.push({ tag: 'markdown', content: t.turnProducedLine(producedCount), text_size: 'notation' })
    }

    // Performance: TTFT · tok/s · steps
    const perfParts: string[] = []
    if (turnStats.firstStepTtftMs !== null && turnStats.firstStepTtftMs > 0) {
      perfParts.push(`⚡ TTFT ${formatMs(turnStats.firstStepTtftMs)}`)
    }
    if (turnStats.totalDecodeMs > 0 && turnStats.totalDecodeTokens > 0) {
      // Pair tokens and decode time over the SAME steps (the Web UI does the
      // same): a step with no timed first token contributes neither, otherwise
      // tok/s is inflated.
      const tps = turnTokensPerSecond(turnStats)
      if (tps !== undefined) perfParts.push(`🚀 ${tps.toFixed(0)} tok/s`)
    }
    if (turnStats.stepCount > 0) {
      perfParts.push(`🔄 ${turnStats.stepCount} steps`)
    }
    if (perfParts.length > 0) {
      elements.push({ tag: 'markdown', content: perfParts.join(' · '), text_size: 'notation' })
    }

    // Tokens: total consumed (matches Web UI "consumed") · in/out · cache
    const tokenParts: string[] = []
    const billedIn = turnStats.totalInputTokens + turnStats.totalCacheReadTokens + turnStats.totalCacheWriteTokens
    const totalBilled = turnStats.totalBilledTokens > 0
      ? turnStats.totalBilledTokens
      : billedIn + turnStats.totalOutputTokens
    if (totalBilled > 0) {
      tokenParts.push(`📦 ${formatTokenCount(totalBilled)} tokens`)
    }
    if (billedIn > 0 || turnStats.totalOutputTokens > 0) {
      tokenParts.push(`📥 ${formatTokenCount(billedIn)} in · 📤 ${formatTokenCount(turnStats.totalOutputTokens)} out`)
    }
    if (billedIn > 0 && turnStats.totalCacheReadTokens > 0) {
      const cacheHitPct = Math.round(turnStats.totalCacheReadTokens / billedIn * 100)
      tokenParts.push(`💾 cache ${cacheHitPct}%`)
    }
    if (tokenParts.length > 0) {
      elements.push({ tag: 'markdown', content: tokenParts.join(' · '), text_size: 'notation' })
    }
  }

  // Metadata section — simplified (short names only)
  const metaParts: string[] = []
  if (meta?.workspace !== undefined && meta.workspace !== '') {
    // Show only the last directory name, not the full path.
    const short = meta.workspace.includes('/') ? meta.workspace.split('/').pop()! : meta.workspace
    metaParts.push(`📂 ${short}`)
  }
  if (meta?.model !== undefined && meta.model !== '') {
    // Show only the model name, not the provider prefix.
    const short = meta.model.includes('/') ? meta.model.split('/').pop()! : meta.model
    metaParts.push(`🧠 ${short}`)
  }
  if (meta?.reasoningEffort !== undefined && meta.reasoningEffort !== '') {
    metaParts.push(`💡 ${meta.reasoningEffort}`)
  }
  if (meta?.contextWindow !== undefined && meta.contextWindow > 0 && meta?.lastInputTokens !== undefined) {
    const pct = Math.min(100, Math.round(meta.lastInputTokens / meta.contextWindow * 100))
    metaParts.push(`📊 ${formatTokenCount(meta.lastInputTokens)}/${formatTokenCount(meta.contextWindow)} (${pct}%)`)
  }
  if (meta?.busyMode !== undefined) {
    const label = meta.busyMode === 'steer' ? 'Steer' : 'Queue'
    const icon = meta.busyMode === 'steer' ? '🎯' : '📥'
    metaParts.push(`**${t.enterWhileBusy}:** ${icon} ${label}`)
  }

  // If nothing to show, return undefined.
  if (elements.length === 0 && metaParts.length === 0) return undefined

  // Append metadata with divider if both stats and metadata exist.
  if (metaParts.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' })
    // Two items per line for mobile readability.
    const line1 = metaParts.slice(0, 2).join(' · ')
    const line2 = metaParts.slice(2).join(' · ')
    const metaContent = [line1, line2].filter(Boolean).join('\n')
    elements.push({ tag: 'markdown', content: metaContent, text_size: 'notation' })
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.turnCompleteTitle },
      template: 'green',
    },
    body: { elements },
  }
}
