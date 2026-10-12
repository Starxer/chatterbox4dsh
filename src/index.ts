import type { Context } from '@deepseek-ai/cordis'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import type {} from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { CommandRuntime, CommandResult, CommandExecution } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-directory-picker'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { createLarkChannel, defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { CARD_MEDIA_LIMIT, CARD_MEDIA_MAX_MB, ConfigSchema, DEFAULT_PRODUCE_CARD, DELIVER_DOC_MAX_MB, LARK_SETTINGS_NAMESPACE, resolveSettingsConfig } from './config.ts'
import type { Config as PluginConfig, SettingsConfig } from './config.ts'
import { HarnessConversationService, TurnDroppedError, type BusyMode } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'
import { startChannel, type ReplyCardMeta, type SlashCommandHandler } from './channel.ts'
import { LarkRuntime } from './runtime.ts'
import { OutboundHealth, wrapHttpInstance } from './outbound-health.ts'
import { observeOutboundWaits } from './outbound-timeout.ts'
import { renderTerminalQr } from './provision.ts'
import { ProvisionManager } from './provision-manager.ts'
import { registerLarkCommands, formatRelativeTime, handleDisplayCommand, handleHelpCommand, handleModelCommand, handleReasoningCommand, handleApprovalCommand, handleListApprovalsCommand, renderFeishuCommandsOnly, type ApprovalControl, type CommandTranslations, type DisplayControl } from './commands.ts'
import { commandTranslationsFor } from './commands-i18n.ts'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { handleProvisionRequest, PROVISION_PATH } from './web.ts'
import { startFeishuApprovals, type PendingApprovalView } from './feishu-approvals.ts'
import { createCardInterleave } from './card-interleave.ts'
import { startFeishuTodos } from './feishu-todos.ts'
import { startFeishuJobs, type DetachedJobNotice, type JobsServiceLike } from './feishu-jobs.ts'
import { startFeishuSubagents } from './feishu-subagents.ts'
import { startFeishuStreaming } from './feishu-streaming.ts'
import { installFeishuSurfacePrompt } from './feishu-surface.ts'
import { startFeishuExternalTurns } from './feishu-external-turns.ts'
import { startFeishuDeliverables, type DeliverFileSender, type FeishuDeliverHandle } from './feishu-deliver.ts'
import type { TurnStats } from './feishu-streaming.ts'
import { resolveLocale, translationsFor, type LocaleId, type Translations } from './i18n.ts'
import { dispatchCardAction } from './card-dispatch.ts'
import { createCardSendBarrier } from './card-send-barrier.ts'
import { isCardContentRejection } from './card-markdown.ts'
import { createCardInstanceWithRetry, createCardWriter, withCardSafety } from './card-write.ts'
import { startCardImages } from './card-images.ts'
import { createMediaUploader } from './media-upload.ts'
import { OUTBOUND_TIMEOUT_MS, withLinkTimeout } from './outbound-timeout.ts'

export const name = 'lark-channel'
export const inject = [
  'agents', 'sessions', 'sessionPersistence', 'agentDefaultModel', 'agentPresets', 'workspaceRegistry',
  'settings', 'credentials', 'webServer', 'commands', 'llm', 'attachments', 'tools',
  'sessionController', 'userQuestions', 'approval',
]
export const Config = ConfigSchema
export type { PluginConfig }
export { ConfigSchema } from './config.ts'

/**
 * How long a card may wait for the step card that logically precedes it before
 * the ordering guarantee is abandoned.
 *
 * That wait can legitimately include a full step-card send (CardKit instance
 * then message), so it is generous — it exists to release the barrier's guard,
 * not to police latency.
 */
const CARD_BARRIER_TIMEOUT_MS = 60_000

/** The barrier wait plus the HTTP call it precedes. */
const CARD_SEND_TIMEOUT_MS = CARD_BARRIER_TIMEOUT_MS + OUTBOUND_TIMEOUT_MS

import { startFeishuQuestions } from './feishu-questions.ts'
import { startFeishuSendFileTool, sendWorkspaceFile } from './feishu-send-file.ts'
import { startFeishuReceiveFileTool } from './feishu-receive-file.ts'
import { startFeishuModelSelect, renderProviderSelectCard, sendModelCardV2, type ModelSelectChannel } from './feishu-model-select.ts'
import { renderSupersededCard } from './card-supersede.ts'
import { decodeCardValue } from './card-action.ts'
import { renderNewSessionConfirmCard, renderNewSessionCancelledCard, NEW_SESSION_CONFIRM_ACTION, NEW_SESSION_CANCEL_ACTION } from './new-session-card.ts'
import { startFeishuPermission, SANDBOX_MODES, PERMISSION_LABELS, describePermissionSwitchFailure, type FeishuPermissionHandle } from './feishu-permission.ts'
import { startFeishuBusy, type FeishuBusyHandle } from './feishu-busy.ts'
import { startFeishuDisplay, type FeishuDisplayHandle } from './feishu-display.ts'
import { startFeishuSession, renderSessionListCard, renderSessionResultCard, type FeishuSessionHandle } from './feishu-session.ts'
import { startFeishuOnboarding, type FeishuOnboardingHandle } from './feishu-onboarding.ts'
import { createCardTopicRegistry, resolveCardTopic, type CardTopicRegistry, type TopicCoords } from './card-topics.ts'
import { fetchThreadRootId } from './topic-roots.ts'
import type { ChatCreationOptions } from './harness.ts'

export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  console.log('dsh-feishu: apply() called, sessionController=', ctx.get('sessionController') !== undefined ? 'available' : 'UNDEFINED', 'userQuestions=', ctx.get('userQuestions') !== undefined ? 'available' : 'UNDEFINED', 'approval=', ctx.get('approval') !== undefined ? 'available' : 'UNDEFINED')
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const sessionPersistence = ctx.get('sessionPersistence')
  const defaultModel = ctx.get('agentDefaultModel')
  const agentPresets = ctx.get('agentPresets')
  const sessionController = ctx.get('sessionController')
  const sandboxPolicy = ctx.get('sandboxPolicy') as { resolve?: (r: { session?: any }) => { mode: string; workspaceRoot?: string } } | undefined
  const permissionPresets = ctx.get('permissionPresets') as { current: (session: any) => string; set: (session: any, name: string) => void } | undefined
  const userQuestions = ctx.get('userQuestions')
  const approval = ctx.get('approval')
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  const webServer = ctx.get('webServer')
  const commands = ctx.get('commands')
  const llm = ctx.get('llm') as LlmRuntime | undefined
  const attachments = ctx.get('attachments')
  if (agents === undefined || sessions === undefined || sessionPersistence === undefined || defaultModel === undefined || agentPresets === undefined || workspaceRegistry === undefined || settings === undefined || credentials === undefined || webServer === undefined) {
    throw new Error('dsh-feishu requires Harness agent, settings, credentials, workspace, and webServer services')
  }
  if (commands === undefined || llm === undefined) {
    throw new Error('dsh-feishu requires commands and llm services for /model support')
  }
  if (attachments === undefined) {
    throw new Error('dsh-feishu requires the attachments service for inbound image messages')
  }
  // All three capability seams (session controller, user questions, approval)
  // must be present for the streaming, question, and approval listeners to
  // register. Without them the plugin still binds to Lark but the per-step
  // cards, question cards, and approval cards are disabled.
  const seamNames: Array<[string, unknown]> = [
    ['sessionController', sessionController],
    ['userQuestions', userQuestions],
    ['approval', approval],
  ]
  const missing = seamNames.filter(([, v]) => v === undefined).map(([n]) => n)
  if (missing.length > 0) {
    ctx.logger('dsh-feishu').warn(`dsh-feishu: missing services ${missing.join(', ')} — streaming/questions/approvals/toolcalls/todos will not work`)
  } else {
    ctx.logger('dsh-feishu').info('dsh-feishu: all capability seams present — will start streaming/questions/approvals listeners')
  }

  // DSH 0.1.7 addresses a settings namespace by its PROFILE ROW id — every
  // descriptor is keyed on `entry.options.id` — so the plugin reads its own
  // entry instead of assuming the id its bundle patch happens to ship. The
  // write paths below use the same id.
  const namespace = String(ctx.fiber.entry?.options.id ?? LARK_SETTINGS_NAMESPACE)
  // The plugin ships its own settings page (`settings.section` id `lark`), so
  // it opts out of an auto-generated one — the convention documented for a
  // plugin that owns its page. It does not remove config reads or writes.
  ctx.effect(() => settings.configure({ auto: false }, ctx.fiber), 'dsh-feishu: settings presentation')
  // `rawConfig` is the live Config the loader handed to `apply()`: DSH commits
  // a settings write into its volatile references, so this reads whatever is
  // in force right now and needs no re-registration after a write.
  const currentSettings = (): SettingsConfig => resolveSettingsConfig(rawConfig)
  const currentRevision = () => settings.describe({ redactSecrets: true }).find(item => item.ns === namespace)?.revision ?? 0
  let apiUpdateDepth = 0

  /**
   * The DSH browser-language preference (`locale` namespace, owned by the
   * client-locale plugin).
   *
   * 0.1.7 removed the direct namespace readout (`settings.get`) and every
   * `describe()` rebuilds each entry's form from the profile document, so the
   * value is cached: `currentLocale()` runs on every card repaint and must not
   * touch the disk. The entry expires after a second, and any settings write
   * drops it outright, so a language switch shows up on the next repaint.
   */
  let dshLocale: { value: string | undefined; readAt: number } | undefined
  const DSH_LOCALE_TTL_MS = 1_000
  const dshLocaleValue = (): string | undefined => {
    const now = Date.now()
    if (dshLocale === undefined || now - dshLocale.readAt >= DSH_LOCALE_TTL_MS) {
      let value: string | undefined
      try {
        const row = settings.describe({ redactSecrets: true }).find(item => item.ns === 'locale')
        value = (row?.value as { preference?: string } | undefined)?.preference
      } catch {
        // A host without the locale plugin (or an unreadable projection) just
        // leaves the plugin on its `zh` fallback; localization must never be
        // able to break card rendering.
        value = undefined
      }
      dshLocale = { value, readAt: now }
    }
    return dshLocale.value
  }

  // Active plugin language. The plugin `locale` field wins; `auto` (default)
  // follows the DSH browser-language preference (the host `locale` namespace
  // registered by `@deepseek-ai/dsh-client-locale`). When DSH does not expose
  // a preference, fall back to `zh`.
  const currentLocale = (): { id: LocaleId; plugin: 'zh' | 'en' | 'auto'; dsh: string | undefined } => {
    const plugin = currentSettings().locale ?? 'auto'
    const dsh = dshLocaleValue()
    return { id: resolveLocale(plugin, dsh), plugin, dsh }
  }
  // Keep the module-level command translations in sync with the resolved
  // locale. Called at apply time and whenever `/lang` changes the plugin's
  // `locale` field.
  const refreshLocale = (): void => setActiveCommandTranslations(currentLocale().id)
  refreshLocale()

  // The bridge is recreated every time the Lark channel reconciles; hold it
  // in a single-cell so the `/model` command always reaches the bridge that
  // is currently serving the inbound message. `lastChatMessage` is overwritten
  // on every inbound message under `chatQueue.enabled: true`, so a synchronous
  // command dispatch sees its own chat coordinates; concurrent chats in
  // different sessions are serialized by the queue and the race never happens.
  const bridgeHolder: {
    current: HarnessConversationService | undefined
    lastChatMessage: { chatId: string; chatType: 'p2p' | 'group'; threadId?: string } | undefined
  } = { current: undefined, lastChatMessage: undefined }
  // Channel adapter and listener registry live above `registerLarkCommands`
  // so the approval-control adapter they produce is available when the
  // command handlers register. The actual SSE iteration starts only after
  // the runtime reconnects (see the `runtime.onChannelChange` hook).
  let stopQuestions: () => void = () => undefined
  let stopApprovals: () => void = () => undefined
  let stopStreaming: () => void = () => undefined
  let stopExternalTurns: () => void = () => undefined
  let stopSurface: () => void = () => undefined
  let consumeReasoning: (sessionId: string) => string | undefined = () => undefined
  let consumeLastStepHadContent: (sessionId: string) => boolean = () => false
  let flushed: (sessionId: string) => Promise<TurnStats | undefined> = () => Promise.resolve(undefined)
  let stopTodos: () => void = () => undefined
  let stopJobs: () => void = () => undefined
  let stopSubagents: () => void = () => undefined
  let stopSendFileTool: () => void = () => undefined
  let stopReceiveFileTool: () => void = () => undefined
  let modelSelectHandle: { dispose: () => void; cardByMessage: Map<string, string>; sequenceByCard: Map<string, number> } | undefined = undefined
  let onboardingHandle: FeishuOnboardingHandle | undefined = undefined
  let permissionHandle: FeishuPermissionHandle | undefined = undefined
  let busyHandle: FeishuBusyHandle | undefined = undefined
  let displayHandle: FeishuDisplayHandle | undefined = undefined
  let sessionHandle: FeishuSessionHandle | undefined = undefined
  /** `present` deliverable delivery (planning + auto-send + confirm taps). */
  let deliverHandle: FeishuDeliverHandle | undefined = undefined
  /** Card-action subscription that settles the `/new` confirmation card. */
  let stopNewSessionConfirmer: (() => void) | undefined = undefined
  /**
   * The `/new` flow's final confirmation. Its model step no longer creates the
   * session directly: everything is collected into one summary card, and the
   * session is created only when the operator presses "create" on it.
   */
  const pendingNewSession = new Map<string, {
    chatMessage: ConversationMessage
    options: ChatCreationOptions
    cardId: string
    messageId?: string
    topic: { rootId?: string; threadId?: string }
  }>()
  /** Monotonic CardKit sequence for the confirmation cards. */
  const newSessionSequenceByCard = new Map<string, number>()
  /** In-place repaint helper for a confirmation card (create / cancel / result). */
  const paintNewSessionCard = async (cardId: string, card: object): Promise<void> => {
    const sequence = (newSessionSequenceByCard.get(cardId) ?? 0) + 1
    newSessionSequenceByCard.set(cardId, sequence)
    await cardChannel.updateCardInstance(cardId, card, sequence)
  }
  const channelHolder: { current: LarkChannel | undefined } = { current: undefined }
  // The approvals handle IS the ApprovalControl surface; the new
  // approval/request waterfall listener inside startFeishuApprovals owns the
  // request fan-out and the settle() closes the listener's deferred promise.
  // The actual startFeishuApprovals call is deferred until cardChannel is
  // declared below.
  const buildApprovalControl = (): ApprovalControl => {
    const approvalsHandle = startFeishuApprovals({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
      getTranslations: () => translationsFor(currentLocale().id),
    })
    stopApprovals = approvalsHandle.stop
    return {
      pendingForSession: approvalsHandle.pendingForSession,
      findPending: approvalsHandle.findPending,
      async settle(view: PendingApprovalView, outcome: 'allowed-once' | 'rejected') {
        await approvalsHandle.settle(view.pendingId, outcome)
      },
    }
  }
  type CardActionEvent = {
    messageId?: string
    chatId?: string
    operator?: { openId?: string }
    action?: { value?: unknown; tag?: string; option?: string }
  }
  const cardActionHandlers = new Set<(evt: CardActionEvent) => void | Promise<void>>()
  const attachedChannels = new Set<LarkChannel>()
  // ── Outbound card ordering barrier ───────────────────────────────────────
  // A step card is posted after a 150ms coalescing window and, on the CardKit
  // path, via two calls (create instance → send message referencing it). Any
  // other card sent in that window — the question/approval card raised by the
  // step's own tool call, or the overflow "continued" cards at turn/end —
  // would be created first and appear above the step card it follows
  // (observed 2026-09-09). Streaming registers a flush here; every card/text
  // send first lets it post any debounced step card for that chat and waits
  // until its message exists.
  //
  // The guard and the wait live in `card-send-barrier.ts`: they are PER CHAT
  // and BOUNDED. The first version of this used one global counter and an
  // unbounded wait, so a single stuck flush silently disabled the ordering
  // guarantee for every chat — which is exactly how the 2026-09-09 inversion
  // came back on 2026-09-21 (key pitfall 30).
  let pendingCardFlush: ((chatId: string) => Promise<void>) | undefined
  const cardBarrier = createCardSendBarrier({
    timeoutMs: CARD_BARRIER_TIMEOUT_MS,
    onTimeout: reason => console.log(`dsh-feishu: pending card flush gave up: ${reason}`),
  })
  /**
   * "Another module posted a card into this chat" (`src/card-interleave.ts`).
   * One instance for the whole plugin: the modules that post interrupting cards
   * (todos, jobs, panels, questions, compactions) are not the module that owns
   * the long-lived compact card, so the notice travels through here.
   */
  const cardInterleave = createCardInterleave()
  /**
   * Shared `messageId → topic` registry for every card the plugin sends (see
   * `card-topics.ts`). One instance for the whole plugin because a card sent
   * by one module is clicked in another: the `/new` flow's model card is sent
   * by this file while the preset card that leads to it comes from
   * `feishu-onboarding`. Declared here — before the channel handler — so the
   * slash-command path (`/model`) can record its card too.
   */
  const cardTopics = createCardTopicRegistry()
  // ── Card payload safety (key pitfall 39) ─────────────────────────────────
  // Feishu parses a card's markdown `![alt](src)` as an IMAGE element whose src
  // must be an uploaded `img_v3_…` key, and rejects the WHOLE card otherwise
  // (`200570` / `230099`, verified 2026-09-23). The model writes
  // `![](runs/x.png)` because the Web UI resolves workspace paths, so the fix
  // belongs at this chokepoint — every card passes through it — rather than at
  // the ~90 places that build markdown, or in the model's instructions.
  const cardWriter = createCardWriter({ logger: ctx.logger('dsh-feishu') })
  /**
   * Inline the media a card's markdown points at (see `card-images.ts`).
   *
   * A model writes `![图](runs/a.png)` / `[clip](runs/a.mp4)` because the Web UI
   * resolves workspace paths; in Feishu those references need an UPLOADED key
   * (image) or an actual card element (video/audio). Rather than asking the
   * model to stop (one output, two renderers), the path is resolved inside the
   * session's own workspace, uploaded, and the card is rewritten. Anything that
   * does not resolve stays text, which the writer guarantees Feishu will accept.
   */
  const mediaUploader = createMediaUploader({
    channel: () => channelHolder.current,
    logger: ctx.logger('dsh-feishu'),
  })
  const cardImages = startCardImages({
    resolveWorkspace: sessionId => bridgeHolder.current?.workspaceOf(sessionId) ?? Promise.resolve(undefined),
    // Live read: a settings write changes this without a restart (every field
    // is `.volatile()`), including the "never upload" mode and the per-card cap.
    mode: () => currentSettings().cardImages,
    mediaLimit: () => currentSettings().cardMediaLimit ?? CARD_MEDIA_LIMIT.default,
    // The three size ceilings are read live for the same reason: the settings
    // page owns them, and the next card must use the value just saved.
    mediaCaps: () => {
      const settings = currentSettings()
      return {
        imageMb: settings.cardImageMaxMb ?? CARD_MEDIA_MAX_MB.image.default,
        videoMb: settings.cardVideoMaxMb ?? CARD_MEDIA_MAX_MB.video.default,
        audioMb: settings.cardAudioMaxMb ?? CARD_MEDIA_MAX_MB.audio.default,
      }
    },
    upload: async (absolutePath: string) => {
      const key = await mediaUploader.image(absolutePath)
      if (key === undefined) throw new Error('dsh-feishu: image upload returned no image_key')
      return key
    },
    uploadVideo: (absolutePath, container) => mediaUploader.video(absolutePath, container),
    uploadAudio: (absolutePath, format) => mediaUploader.audio(absolutePath, format),
    logger: ctx.logger('dsh-feishu'),
  })
  /**
   * The unbarriered half of {@link cardChannel.send}: the HTTP call itself,
   * against the current channel (which is already card-safe — see
   * `withCardSafety` at the factory).
   */
  const rawChannelSend = (to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }> => {
    const ch = channelHolder.current
    if (ch === undefined) throw new Error('dsh-feishu: channel not connected')
    return ch.send(to, input, opts) as Promise<{ messageId?: string }>
  }
  /**
   * Reply/footer metadata for one chat. Shared by the reply card `channel.ts`
   * posts for a Feishu-started turn and the completion card this plugin posts
   * for a turn started elsewhere, so both show the same workspace/model facts.
   */
  const replyCardMeta = async (coords: ConversationMessage): Promise<ReplyCardMeta> => {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return {}
    const meta = await bridge.getSessionMeta(coords)
    return {
      workspace: meta.workspace,
      agentPreset: meta.agentPreset,
      model: meta.model,
      reasoningEffort: meta.reasoningEffort,
      contextWindow: meta.contextWindow,
      lastInputTokens: meta.lastInputTokens,
      busyMode: bridge.busyMode(coords) ?? 'queue',
    }
  }
  const cardChannel = {
    // Every method below is bounded. The SDK's HTTP client has no request
    // timeout, so without this a single unanswered request leaves the promise
    // pending forever and everything chained behind it — the per-chat
    // step-card chain above all — waits forever too (key pitfall 29).
    send: async (to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }> => {
      // The bound covers the barrier plus the HTTP call it precedes.
      const sent = await withLinkTimeout(cardBarrier.run(to, pendingCardFlush, () => rawChannelSend(to, input, opts)), 'send card or text', CARD_SEND_TIMEOUT_MS)
      // This path is what every OTHER module posts a card through (todos, jobs,
      // subagent panels, questions). A card that lands here sits after the
      // long-lived compact cards, so their next content must not be written
      // above it: announce it (see `src/card-interleave.ts`). Text messages are
      // not announced — a busy notice or an error line does not reorder cards,
      // and treating those as interruptions would multiply cards for nothing.
      if ('card' in input && input.card !== undefined) cardInterleave.note(to)
      return sent
    },
    /**
     * Post a step card WITHOUT the pre-send flush — the send the streaming
     * module uses for the step card's own message when no CardKit reference is
     * available.
     *
     * The barrier's flush exists to put a debounced step card in front of
     * whatever ANOTHER module is about to post, and it ends by awaiting this
     * chat's step-card send chain. When the card being posted IS that step
     * card, the chain holds the very promise this send is inside, so waiting on
     * it is a self-deadlock that only the barrier timeout ends (60s). Observed
     * live 2026-09-24 19:30: the CardKit create dropped its socket, the
     * fallback send wedged for exactly 60.0s, seven updates scheduled in
     * between were released in one burst, Feishu refused the burst with `230020`
     * (per-message edit frequency), and the card kept rendering "🧠 深度思考中"
     * while the Turn Complete card had already been posted — the write carrying
     * the answer never landed. Ordering between step cards is unaffected: the
     * caller awaited the previous card's chain before calling this (key
     * pitfall 45).
     */
    sendStepCard: (to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }> =>
      withLinkTimeout(rawChannelSend(to, input, opts), 'send step card', OUTBOUND_TIMEOUT_MS),
    /**
     * Register the streaming module's step-card flush. Called once at boot;
     * absent in tests and deployments that do not run the streaming module.
     */
    registerPendingCardFlush: (flush: (chatId: string) => Promise<void>): void => {
      pendingCardFlush = flush
    },
    /**
     * Create a Feishu card instance (cardkit.v1.card.create) and return its
     * `card_id`. The instance can be referenced from messages and updated via
     * {@link updateCardInstance}.
     *
     * Beware the in-place update limit: Feishu stops delivering button
     * callbacks on a message's card after only ~2-3 edits, and that applies to
     * `cardkit.v1.card.update` just as it does to `im.v1.message.patch`
     * (verified 2026-09-08 — the folder browser went dead after a few pages
     * even though it used card instances). Cards WITHOUT buttons (step cards)
     * are unaffected and may be updated repeatedly. Interactive cards must
     * post a NEW card per step instead; see `feishu-onboarding.ts` `sendCard`.
     *
     * A TRANSPORT failure (a dropped socket) is retried once — see
     * `createCardInstanceWithRetry`; content rejections are not.
     */
    createCardInstance: async (card: object): Promise<string> => {
      const ch = channelHolder.current
      if (ch === undefined) throw new Error('dsh-feishu: channel not connected')
      return createCardInstanceWithRetry(() => cardWriter.write(card, payload => withLinkTimeout(ch.rawClient.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(payload) },
      }).then((r: any) => {
        const cardId = r.data?.card_id as string | undefined
        // A non-zero business code with an EMPTY card_id is how Feishu reports
        // content it will not accept (verified 2026-09-23: `card.create` for a
        // card whose markdown carries a bad image key answers `code=200570`,
        // `card_id: ''` — it does not throw). Throwing with the code and message
        // in the text lets `cardWriter`'s rejection retry and the patch fallback
        // recognize it, and keeps an empty id from ever reaching
        // `sendCardByReference`, which would fail with `cardid is invalid` and
        // leave the step card unposted (that was the 11:27 journal line).
        if (r.code !== undefined && r.code !== 0) {
          throw new Error(`dsh-feishu: cardkit.card.create rejected the content: code=${r.code} msg=${r.msg ?? 'unknown'}`)
        }
        if (cardId === undefined || cardId === '') {
          throw new Error('dsh-feishu: cardkit.card.create returned no card_id')
        }
        return cardId
      }), 'create card instance')), {
        onRetry: reason => console.log(`dsh-feishu: [send] card instance create failed (${reason}); retrying once`),
      })
    },
    /**
     * Send a message that references a card instance by `card_id` instead of
     * embedding the card JSON. Used together with {@link createCardInstance}
     * and {@link updateCardInstance} for the V2 card flow.
     *
     * When `replyTo` is set (a topic root message id), the message goes
     * through `im.v1.message.reply` with `reply_in_thread` — the only SDK
     * path that lands inside a Feishu topic. Without it, `message.create` is
     * used (main-chat fallback).
     */
    sendCardByReference: (to: string, cardId: string, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } })
      if (opts?.replyInThread === true && (opts.replyTo === undefined || opts.replyTo === '')) {
        // The topic's root message id was never recorded (see
        // `HarnessConversationService.noteTopic`): `reply_in_thread` alone is
        // meaningless to `message.create`, so this card lands at the top level
        // of the chat — a new topic in a topic group. Logged so the leak is
        // visible instead of silent.
        console.log(`dsh-feishu: [send] topic reply without a root id for chat=${to} — falling back to a top-level message`)
      }
      if (opts?.replyTo !== undefined && opts.replyTo !== '') {
        return withLinkTimeout(ch.rawClient.im.v1.message.reply({
          path: { message_id: opts.replyTo },
          data: {
            content,
            msg_type: 'interactive',
            reply_in_thread: opts.replyInThread === true,
          },
        }).then((r: any) => {
          const id = r.data?.message_id as string | undefined
          cardWriter.noteCardMessage(cardId, id)
          return id === undefined ? {} : { messageId: id }
        }), 'send card by reference')
      }
      // Infer receive_id_type from the target id prefix (same logic as the
      // SDK's detectReceiveIdType): oc_→chat_id, ou_→open_id, on_→union_id.
      const receiveIdType = to.startsWith('oc_') ? 'chat_id'
        : to.startsWith('ou_') ? 'open_id'
        : to.startsWith('on_') ? 'union_id'
        : to.includes('@') ? 'email' : 'user_id'
      return withLinkTimeout(ch.rawClient.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: to,
          msg_type: 'interactive',
          // The SDK's `im.v1.message.create` expects `content` to be a JSON
          // string. The content object follows the same format as the
          // SDK's rawSend: { type: 'card', data: { card_id: cardId } }.
          content,
        },
      }).then((r: any) => {
        const id = r.data?.message_id as string | undefined
        cardWriter.noteCardMessage(cardId, id)
        return id === undefined ? {} : { messageId: id }
      }), 'send card by reference')
    },
    /**
     * Full-update a card instance (cardkit.v1.card.update). The message that
     * references this card_id reflects the new content — no
     * `im.v1.message.patch` needed.
     *
     * `sequence` must be monotonically increasing per card instance.
     *
     * This does NOT lift the button-callback limit described on
     * {@link createCardInstance}: a card carrying buttons stops delivering
     * clicks after ~2-3 in-place updates either way.
     */
    updateCardInstance: (cardId: string, card: object, sequence: number): Promise<void> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      const write = (payload: object): Promise<void> => withLinkTimeout(ch.rawClient.cardkit.v1.card.update({
        path: { card_id: cardId },
        data: {
          card: { type: 'card_json', data: JSON.stringify(payload) },
          // The floor, not the caller's number: the retry inside the writer
          // repeats the write and must still move the sequence forward.
          sequence: cardWriter.nextSequence(cardId, sequence),
        },
      }).then((r: any) => {
        if (r.code !== undefined && r.code !== 0) {
          throw new Error(`dsh-feishu: cardkit.card.update failed: code=${r.code} msg=${r.msg ?? 'unknown'}`)
        }
      }), 'update card instance')
      return cardWriter.write(card, write).catch(async (error: unknown) => {
        // Still refused: patch the message instead, so the card cannot keep
        // rendering stale content (the "stuck on 深度思考中" incident).
        const messageId = cardWriter.messageIdFor(cardId)
        if (!isCardContentRejection(error) || messageId === undefined) throw error
        console.log(`dsh-feishu: [update] card instance ${cardId} refused; patching message ${messageId} instead`
          + ' so the card does not keep stale content')
        return cardWriter.write(card, payload => withLinkTimeout(ch.updateCard(messageId, payload), 'patch card'))
      })
    },
    updateCard: (messageId: string, card: object): Promise<void> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      return cardWriter.write(card, payload => withLinkTimeout(ch.updateCard(messageId, payload), 'patch card'))
    },
    recallMessage: (messageId: string): Promise<void> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      return ch.recallMessage(messageId)
    },
    onCardAction: (handler: (evt: CardActionEvent) => void | Promise<void>): (() => void) => {
      cardActionHandlers.add(handler)
      const attach = (ch: LarkChannel): (() => void) => {
        if (attachedChannels.has(ch)) return () => undefined
        attachedChannels.add(ch)
        return ch.on('cardAction', (...args) => {
          const evt = args[0] as CardActionEvent & { raw?: { action?: { form_value?: unknown } } }
          // Card callbacks reach neither the journal nor any other log, which
          // makes "I pressed the button and nothing happened" impossible to
          // diagnose from outside. One line per tap is cheap and pins down the
          // exact payload shape when a flow stalls.
          console.log(
            `dsh-feishu: [card] chatId=${evt.chatId ?? '-'} messageId=${evt.messageId ?? '-'}` +
            ` value=${JSON.stringify(evt.action?.value)?.slice(0, 240) ?? '-'}` +
            ` form=${JSON.stringify(evt.raw?.action?.form_value)?.slice(0, 240) ?? '-'}`,
          )
          // Contain each handler's failure: an escaping rejection here has no
          // owner, and DSH's `installFailLoud` turns an `unhandledRejection`
          // into `fatal load failure` + exit(1) — one button tap could stop
          // the whole daemon (2026-09-14: the /permission sandbox fence).
          dispatchCardAction(cardActionHandlers, evt, (error: unknown) => {
            console.log(`dsh-feishu: [card] handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
          })
        })
      }
      const unsubList: Array<() => void> = []
      if (channelHolder.current !== undefined) {
        const u = attach(channelHolder.current)
        if (u !== undefined) unsubList.push(u)
      }
      const previous = runtime.onChannelChange
      runtime.onChannelChange = (ch) => {
        previous?.(ch)
        const u = attach(ch)
        if (u !== undefined) unsubList.push(u)
      }
      return () => {
        cardActionHandlers.delete(handler)
        for (const u of unsubList) u()
      }
    },
  }
  // The questions listener is paired with the approvals listener: they share
  // the cardChannel adapter so a single cardAction dispatcher feeds both.
  // When apiProxy is missing, both no-op (slash commands fall back to
  // errors explaining no pending approvals / questions).
  // The outbound link's own history — the half a boot verdict cannot see. The
  // status route reports it beside `runtime.status()`, and it is fed from both
  // ends of a request: the channel's HTTP instance records everything that
  // settles (`src/outbound-health.ts`), and the bounded waits around calls that
  // leave the machine report the ones that never settle at all. The second half
  // is the only way a silent half-open connection becomes visible; see
  // `src/outbound-timeout.ts` for why the budget comes from the call site
  // rather than a threshold guessed in either module.
  const outboundHealth = new OutboundHealth()
  observeOutboundWaits({ abandoned: (what, ms) => outboundHealth.noteAbandoned(what, ms) })
  const runtime = new LarkRuntime({
    settings: currentSettings,
    resolveSecret: async ref => (await credentials.resolve(credentialRef(ref)))?.value,
    start: async config => {
      const dshHome = process.env.DSH_HOME || `${homedir()}/.dsh`
      const statePath = `${dshHome}/lark-session-map.json`
      // Read optional: listing sessions prefers the host's maintained
      // projection state over replaying the live log (`snapshotEvents` is
      // deprecated for new callers). `ctx.get` keeps this out of `inject`, so a
      // host without the service still boots (关键坑 2 的教训).
      const projectionsReader = ctx.get('sessionProjections') as { stateOf(session: unknown, key: string): unknown } | undefined
      const bridge = new HarnessConversationService({
        agents,
        sessions,
        sessionPersistence,
        selection: () => defaultModel.currentSelection(),
        agentPresets,
        workspaceRegistry,
        sessionController,
        // Read optional: listing sessions prefers the host's maintained
        // projection state over replaying the live log (`snapshotEvents` is
        // deprecated for new callers). `ctx.get` keeps this out of `inject`,
        // so a host without the service still boots (关键坑 2 的教训).
        ...(projectionsReader === undefined ? {} : { sessionProjections: projectionsReader }),
      }, { ...config, statePath })
      bridgeHolder.current = bridge
      return startChannel(
        config,
        bridge,
        // Every card `channel.ts` posts (the reply, the overflow continuations,
        // the Turn Complete footer) goes straight to the SDK channel, so the
        // card adapter never sees it. Wrapping the factory puts the payload
        // safety in front of those too — see `card-write.ts`.
        //
        // `httpInstance` is the SDK's own default instance behind a recording
        // proxy: passing the default explicitly is what makes the outbound
        // health reading depend on an instance we instrumented rather than on
        // the SDK's fallback staying the same object.
        options => withCardSafety(createLarkChannel({
          ...options,
          httpInstance: wrapHttpInstance(defaultHttpInstance, outboundHealth),
        }), cardWriter),
        ctx.logger,
        console,
        message => executeSlashCommand(message, bridge, commands, bridgeHolder, sessionController, agents, sandboxPolicy, permissionHandle, llm, defaultModel, cardChannel,
        busyHandle,
        modelSelectHandle !== undefined ? { cardByMessage: modelSelectHandle.cardByMessage, sequenceByCard: modelSelectHandle.sequenceByCard } : undefined,
        onboardingHandle, workspaceRegistry, agentPresets, approvalControl, showReasoningControl, displayControl, displayHandle, sessionHandle,
        { current: currentLocale, set: setPluginLocale },
        permissionPresets, cardTopics),
        attachments,
        replyCardMeta,
        undefined,  // consumeReasoning (unused; bridge handles intermediate tracking)
        undefined,  // consumeLastStepHadContent (unused)
        flushed,
        undefined,  // messageInterceptor (unused here)
        onboardingHandle === undefined ? undefined : {
          needsOnboarding: async (message) => {
            const bridge = bridgeHolder.current
            if (bridge === undefined) return false
            const coords: ConversationMessage = {
              chatId: message.chatId,
              chatType: message.chatType,
              ...message.threadId === undefined ? {} : { threadId: message.threadId },
            }
            return bridge.needsOnboarding(coords)
          },
          sendOnboardingCard: async (message) => {
            const threadLabel = message.threadId === undefined ? '这个对话框' : '这个话题'
            // Feishu topic replies must target the topic ROOT message; for the
            // root message itself rootId is absent and the message is its own
            // reply target (same rule as channel.ts's replyToId).
            const replyToId = message.rootId ?? message.messageId
            const coords: ConversationMessage = {
              chatId: message.chatId,
              chatType: message.chatType,
              ...message.threadId === undefined ? {} : { threadId: message.threadId },
              ...message.threadId === undefined ? {} : { rootId: replyToId },
            }
            await onboardingHandle?.sendOnboardingCard(coords, threadLabel)
          },
        },
      () => translationsFor(currentLocale().id),
        cardImages.hydrate,
        deliverHandle,
        // Register the topic of every deliverable-carrying footer card, so a
        // tap on one of its rows can be traced back to the right topic instead
        // of the chat-level guess (关键坑 31).
        (messageId, topic) => cardTopics.note(messageId, topic),
        // Live `produceCard` setting: files a turn wrote without declaring them
        // through `present` (TODO O3). Read per turn so a settings write applies
        // to the very next turn without a remount.
        () => currentSettings().produceCard ?? DEFAULT_PRODUCE_CARD,
      )
    },
  })
  /**
   * Fill in the topic roots the bridge is missing, one Feishu lookup each.
   *
   * Every send that must land inside a Feishu topic needs the topic's ROOT
   * message id (`replyTo` + `reply_in_thread`); without it the SDK posts a new
   * top-level message and the bot's cards escape the topic. Roots normally
   * arrive on inbound messages, but a binding restored from an older state
   * file — or one that only ever saw slash commands — has none, and a turn
   * driven from the WebUI has no inbound message to supply one. Resolving them
   * once at connect makes those topics behave like freshly-bound ones.
   *
   * Runs in the background: sequential (only a handful of topics), tolerant of
   * failures (see `fetchThreadRootId`), and it never blocks the connection.
   */
  async function recoverTopicRoots(channel: LarkChannel): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    const missing = bridge.missingTopicRoots()
    if (missing.length === 0) return
    let recovered = 0
    for (const topic of missing) {
      const rootId = await fetchThreadRootId(channel, topic.threadId)
      if (rootId === undefined) continue
      bridge.setTopicRoot(topic.chatId, topic.threadId, rootId)
      recovered += 1
    }
    console.log(`dsh-feishu: topic roots — ${recovered}/${missing.length} resolved via the Feishu API`)
  }

  // Pin the channel holder so the card adapter's `send`/`onCardAction` always
  // reach the live channel. The questions/approvals listeners wrap this
  // callback to also attach their cardAction handlers on reconnect.
  runtime.onChannelChange = channel => {
    channelHolder.current = channel
    // Topics the bridge knows but has no root message id for (bindings carried
    // over from before roots were persisted). Resolve them once, in the
    // background, so a WebUI-driven turn in those topics does not leak its
    // cards into the main chat. Best-effort: never blocks the connection.
    void recoverTopicRoots(channel).catch((error: unknown) => {
      console.log(`dsh-feishu: topic root recovery failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  // `feishu_send_file` is independent of the questions/approvals seams: it only
  // needs the live channel + the session→chat reverse lookup, so it registers
  // unconditionally. Unbound sessions fail at execution time with a clear error.
  stopSendFileTool = startFeishuSendFileTool({
    ctx,
    bridgeHolder,
    channelHolder,
    logger: ctx.logger('dsh-feishu'),
  })
  // `feishu_receive_file` mirrors the send tool: pull an inbound Feishu file
  // resource into the native attachment store on demand. Registers
  // unconditionally; unbound sessions fail at execution time.
  stopReceiveFileTool = startFeishuReceiveFileTool({
    ctx,
    bridgeHolder,
    channelHolder,
    logger: ctx.logger('dsh-feishu'),
    // 0.1.3: persist pulled files via the native attachment store (`attachments`
    // is guaranteed present — index.ts rejects the plugin without it).
    attachments,
  })
  // Interactive `/permission` picker card. Independent of the questions/
  // approvals seams; only needs the live card channel + the sandbox policy.
  permissionHandle = startFeishuPermission({
    channel: cardChannel,
    sandbox: sandboxPolicy,
    permissionPresets,
    sessionGetter: (id: string) => (agents as any)?.get?.(id)?.session,
    logger: ctx.logger('dsh-feishu'),
    getTranslations: () => translationsFor(currentLocale().id),
  })
  // Interactive `/busy` picker card. Independent of the questions/approvals
  // seams; only needs the live card channel + the bridge's per-chat busy mode.
  busyHandle = startFeishuBusy({
    channel: cardChannel,
    getMode: chat => bridgeHolder.current?.busyMode(chat) ?? 'queue',
    setMode: (chat, mode) => bridgeHolder.current?.setBusyMode(chat, mode),
    logger: ctx.logger('dsh-feishu'),
    getTranslations: () => translationsFor(currentLocale().id),
  })
  // Interactive `/session` management panel (switch / detach / rename /
  // archive / fork). Independent of the questions/approvals seams; only needs
  // the live card channel + the bridge + optional DSH session/workspace APIs.
  sessionHandle = startFeishuSession({
    channel: cardChannel,
    bridge: () => bridgeHolder.current,
    sessionController,
    workspaceRegistry,
    logger: ctx.logger('dsh-feishu'),
    getTranslations: () => translationsFor(currentLocale().id),
  })
  // `present` deliverable delivery (key pitfall 52 / TODO O25). The module is
  // independent of the questions/approvals seams: it needs the live card
  // channel, the session's workspace (which `channel.ts` passes in), the
  // `deliverDocMaxMb` setting and a topic resolver — a confirmation card must
  // land in the topic of the card that was tapped, never in a topic guessed
  // from the chat (关键坑 31).
  const sendDeliverFile: DeliverFileSender = async (input) => {
    const ch = channelHolder.current
    if (ch === undefined) throw new Error('dsh-feishu: channel not connected — try again later')
    const result = await sendWorkspaceFile({
      channel: ch,
      chatId: input.chatId,
      path: input.path,
      ...(input.opts === undefined ? {} : { opts: input.opts }),
      logger: ctx.logger('dsh-feishu'),
    })
    return { sentAs: result.sentAs, messageId: result.messageId }
  }
  deliverHandle = startFeishuDeliverables({
    channel: cardChannel,
    logger: ctx.logger('dsh-feishu'),
    getTranslations: () => translationsFor(currentLocale().id),
    docMaxMb: () => currentSettings().deliverDocMaxMb ?? DELIVER_DOC_MAX_MB.default,
    topicFor: message => resolveCardTopic({
      cardTopics,
      message,
      chatFallback: () => {
        const fromBridge = bridgeHolder.current?.topicFor(message.chatId) ?? {}
        if (fromBridge.rootId !== undefined) return fromBridge
        return onboardingHandle?.topicFor(message.chatId) ?? {}
      },
    }),
    sendFile: sendDeliverFile,
  })
  if (sessionController !== undefined && userQuestions !== undefined && approval !== undefined) {
    /**
     * Topic coordinates for a card-driven send. Three sources, best first:
     * the coordinates the clicked message already carries, the topic this very
     * card message was sent into, and only then the chat-level guess.
     *
     * The chat-level guess (the bridge's most recently used topic for that
     * group, then onboarding's per-chat copy) is correct only while a group
     * uses one topic. With two topics live at once it hands the flow the WRONG
     * topic — observed 2026-09-21: an unrelated inbound message in an old topic
     * moved it to the front of the bridge's recency list, and the `/new` flow's
     * model + confirm cards were posted into that old topic while its earlier
     * cards sat in the newly created one. The bridge copy is still preferred
     * over onboarding's for cards that outlived a restart (it is persisted).
     */
    const chatTopicFor = (message: { chatId: string; messageId?: string; threadId?: string; rootId?: string }): TopicCoords =>
      resolveCardTopic({
        cardTopics,
        message,
        chatFallback: () => {
          const fromBridge = bridgeHolder.current?.topicFor(message.chatId) ?? {}
          if (fromBridge.rootId !== undefined) return fromBridge
          return onboardingHandle?.topicFor(message.chatId) ?? {}
        },
      })
    stopQuestions = startFeishuQuestions({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
      getTranslations: () => translationsFor(currentLocale().id),
    })
    stopTodos = startFeishuTodos({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
    })
    // The subagent roster panel. Independent of the questions/approvals seams:
    // it needs the session-event fan-out (parent catalogs), the Host's
    // subagent lifecycle events, and the bridge's session → chat lookup.
    stopSubagents = startFeishuSubagents({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
      getTranslations: () => translationsFor(currentLocale().id),
      // The live session's own cached fold of its `request/context` events. DSH
      // appends that event only when the route CHANGES, so a resumed subagent
      // emits none and the panel would otherwise show `—` forever (关键坑 67).
      readChildRoute: (sessionId) => {
        const route = sessions?.get(sessionId as never)?.requestContext?.()
        return route === undefined ? undefined : { provider: route.provider, model: route.model }
      },
    })
    // Read optional: the abstract background-job registry. `ctx.get` keeps it
    // out of `inject`, so a composition without it still boots (关键坑 2) — it
    // just gets no job cards. Only jobs whose owning session is bound to a
    // Feishu chat are mirrored, and the module filters on `resolveChat`.
    const jobs = ctx.get('jobs') as JobsServiceLike | undefined
    // The job mirror only cards jobs the MODEL was handed a handle for, and the
    // handle is announced in the tool result — so it starts first, and streaming
    // feeds it every result it sees (关键坑 37).
    let noteDetachedJob: ((notice: DetachedJobNotice) => void) | undefined
    if (jobs === undefined) {
      ctx.logger('dsh-feishu').info('dsh-feishu: no background-job registry in this composition; job cards stay off')
    } else {
      const jobsMirror = startFeishuJobs({
        jobs,
        channel: cardChannel,
        logger: ctx.logger('dsh-feishu'),
        getTranslations: () => translationsFor(currentLocale().id),
      })
      stopJobs = jobsMirror.dispose
      noteDetachedJob = jobsMirror.noteDetached
    }
    const streamingResult = startFeishuStreaming({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
      showReasoning: () => currentSettings().showReasoning,
      showToolCalls: () => currentSettings().showToolCalls,
      showToolArgs: () => currentSettings().showToolArgs,
      showToolResults: () => currentSettings().showToolResults,
      transcriptView: () => currentSettings().transcriptView,
      getTranslations: () => translationsFor(currentLocale().id),
      interleave: cardInterleave,
      ...(noteDetachedJob !== undefined ? { noteDetachedJob } : {}),
      hydrateImages: cardImages.hydrate,
      // Warming resolves the same media against the text still being streamed,
      // so the card that finally carries it does not pay for the uploads.
      warmImages: cardImages.warm,
    })
    stopStreaming = streamingResult.stop
    // The Feishu surface sentence (same shape as the Web bundle's
    // `app:web-surface`): one prompt section whose provider contributes nothing
    // for a session that is not bound to a Feishu chat.
    stopSurface = installFeishuSurfacePrompt(ctx, {
      isBound: sessionId => bridgeHolder.current?.resolveChat(sessionId) !== undefined,
      enabled: () => currentSettings().surfaceContext ?? true,
    })
    // Turns the user starts outside Feishu (Web GUI, background-job wake-up,
    // schedule) rendered from the same native events every other DSH surface
    // uses: the user message is echoed and the turn is completed with the same
    // card and the same `present` delivery as a Feishu-started turn.
    const externalTurns = startFeishuExternalTurns({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
      getTranslations: () => translationsFor(currentLocale().id),
      flushed,
      sessionMeta: replyCardMeta,
      ...(deliverHandle === undefined ? {} : { deliver: deliverHandle }),
      noteCardTopic: (messageId, topic) => cardTopics.note(messageId, topic),
      enabled: () => currentSettings().mirrorExternalTurns ?? true,
    })
    stopExternalTurns = externalTurns.stop
    consumeReasoning = streamingResult.consumeReasoning
    consumeLastStepHadContent = streamingResult.consumeLastStepHadContent
    flushed = streamingResult.flushed
    /**
     * Retire the model card once the final confirmation card carries every
     * setting. Unlike the cards that recorded a decision, this one is a mere
     * step of the wizard, so it is repainted as the bare stale notice.
     */
    const retireModelCard = async (messageId: string | undefined, t: Translations): Promise<void> => {
      if (messageId === undefined || modelSelectHandle === undefined) return
      const cardId = modelSelectHandle.cardByMessage.get(messageId)
      if (cardId === undefined) return
      const sequence = (modelSelectHandle.sequenceByCard.get(cardId) ?? 0) + 1
      modelSelectHandle.sequenceByCard.set(cardId, sequence)
      await cardChannel.updateCardInstance(cardId, renderSupersededCard(t), sequence).catch((error: unknown) => {
        console.log(`dsh-feishu: could not retire the model card: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    modelSelectHandle = startFeishuModelSelect({
      llm,
      agentDefaultModel: defaultModel,
      bridgeHolder,
      sessionController,
      channel: cardChannel,
      logger: ctx.logger('dsh-feishu'),
      topicFor: chatTopicFor,
      cardTopics,
      getTranslations: () => translationsFor(currentLocale().id),
      onNewSessionConfirm: async (chatMessage, selection, messageId) => {
        // The `/new` card flow's model step confirmed. Do NOT create the
        // session yet: collect every setting into one final confirmation card
        // (workspace · preset · model · effort) and create it only after the
        // operator confirms. The model card itself is retired so the chat does
        // not keep two live-looking steps.
        const t = translationsFor(currentLocale().id)
        const flowOptions = onboardingHandle?.creationOptionsFor(chatMessage.chatId) ?? {}
        const options: ChatCreationOptions = {
          ...(flowOptions.workspace !== undefined ? { workspace: flowOptions.workspace } : {}),
          ...(flowOptions.agentPreset !== undefined ? { agentPreset: flowOptions.agentPreset } : {}),
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort as never } : {}),
        }
        await retireModelCard(messageId, t)
        const card = renderNewSessionConfirmCard(options, t, flowOptions.workspaceMissing === true)
        const topic = chatTopicFor(chatMessage)
        const opts = topic.threadId !== undefined && topic.rootId !== undefined
          ? { replyInThread: true, replyTo: topic.rootId }
          : {}
        const cardId = await cardChannel.createCardInstance(card)
        newSessionSequenceByCard.set(cardId, 0)
        const result = await cardChannel.sendCardByReference(chatMessage.chatId, cardId, opts)
        const confirmMessageId = result.messageId
        cardTopics.note(confirmMessageId, topic)
        pendingNewSession.set(chatMessage.chatId, {
          chatMessage,
          options,
          cardId,
          ...(confirmMessageId !== undefined ? { messageId: confirmMessageId } : {}),
          topic,
        })
      },
    })
    onboardingHandle = startFeishuOnboarding({
      bridgeHolder,
      channel: cardChannel,
      logger: ctx.logger('dsh-feishu'),
      workspaceRegistry,
      agentPresets,
      agentDefaultModel: defaultModel,
      getTranslations: () => translationsFor(currentLocale().id),
      cardTopics,
      // Read lazily: directory-picker-auto mounts its backend (native or
      // browse) asynchronously during boot, so the service may not exist yet
      // when this plugin applies. A missing/native capability just hides the
      // folder-browsing button; the manual path form keeps working.
      getDirectoryPicker: () => ctx.get('directoryPicker'),
      config: {
        workspace: currentSettings().workspace,
        agentPreset: currentSettings().agentPreset,
        provider: currentSettings().provider,
        model: currentSettings().model,
      },
      onModelStep: async (chatMessage, messageId, flowState) => {
        // Advance the `/new` flow to the model card, reusing the
        // model-select provider card with the `new-session` flow marker.
        const bridge = bridgeHolder.current
        if (bridge === undefined || modelSelectHandle === undefined) return
        const current = defaultModel.currentSelection()
        const card = renderProviderSelectCard(llm.listProviders(), current, 'new-session', translationsFor(currentLocale().id))
        const cardId = await cardChannel.createCardInstance(card)
        const topic = chatTopicFor(chatMessage)
        const opts = topic.threadId !== undefined && topic.rootId !== undefined
          ? { replyInThread: true, replyTo: topic.rootId }
          : {}
        const result = await cardChannel.sendCardByReference(chatMessage.chatId, cardId, opts)
        const sentId = result.messageId ?? ''
        cardTopics.note(sentId, topic)
        if (sentId !== '') {
          modelSelectHandle.cardByMessage.set(sentId, cardId)
          modelSelectHandle.sequenceByCard.set(cardId, 0)
        }
        // The preset picker recorded a real decision — which mode the session
        // gets — so freeze it on that choice instead of collapsing it into the
        // bare grey notice (the operator must still be able to read back what
        // was picked). Only cards that were walked through are discarded.
        const presetId = flowState?.agentPreset ?? agentPresets.defaultId
        const presetRow = (await agentPresets.list()).find(p => p.id === presetId)
        const presetLabel = presetRow !== undefined && presetRow.name !== undefined && presetRow.name !== ''
          ? presetRow.name
          : presetId
        await onboardingHandle?.supersedePrevious(chatMessage.chatId, {
          mode: 'keep',
          note: translationsFor(currentLocale().id).cardSettledNote(presetLabel),
        })
      },
    })

    // The `/new` flow's last step: settle the final confirmation card.
    const stopNewSessionConfirm = cardChannel.onCardAction(async (evt: { chatId?: string; messageId?: string; action?: { value?: unknown } }): Promise<void> => {
      const parsed = decodeCardValue(evt.action?.value)
      const kind = parsed?.kind
      if (kind !== NEW_SESSION_CONFIRM_ACTION && kind !== NEW_SESSION_CANCEL_ACTION) return
      const chatId = evt.chatId
      if (chatId === undefined) return
      const pending = pendingNewSession.get(chatId)
      if (pending === undefined) return
      pendingNewSession.delete(chatId)
      const t = translationsFor(currentLocale().id)
      if (kind === NEW_SESSION_CANCEL_ACTION) {
        await paintNewSessionCard(pending.cardId, renderNewSessionCancelledCard(t)).catch((error: unknown) => {
          console.log(`dsh-feishu: could not paint the cancelled session card: ${error instanceof Error ? error.message : String(error)}`)
        })
        return
      }
      const bridge = bridgeHolder.current
      if (bridge === undefined) return
      // O19: the workspace is registered HERE, at the flow's last step, not back
      // when it was picked — cancelling `/new` therefore leaves nothing behind.
      // A path the operator confirmed creating does not exist yet, so it is
      // created (`mkdir -p`, missing parents included) immediately before the
      // session that needs it (O16).
      const flow = onboardingHandle?.creationOptionsFor(chatId) ?? {}
      await commitNewSession(bridge, cardChannel, pending.chatMessage, pending.options, pending.messageId, pending.topic, {
        cardId: pending.cardId,
        paint: (card: object) => paintNewSessionCard(pending.cardId, card),
      }, {
        prepareWorkspace: pending.options.workspace === undefined
          ? undefined
          : async () => {
            const path = pending.options.workspace as string
            if (flow.workspaceMissing === true) await mkdir(path, { recursive: true })
            await workspaceRegistry.create(path)
          },
      })
    })
    stopNewSessionConfirmer = stopNewSessionConfirm
  }
  // Approval control (the Feishu waterfall listener) and the reasoning-display
  // toggle are shared by the command runtime and the same-session standalone
  // dispatches in executeSlashCommand (which must not require a live agent).
  const approvalControl = buildApprovalControl()
  const showReasoningControl = {
    get: () => currentSettings().showReasoning,
    toggle: () => {
      const current = currentSettings().showReasoning
      void settings.mutate(namespace, [{ op: 'set', path: ['showReasoning'], value: !current }], currentRevision())
    },
  }
  // `/display` reads and writes the same five config fields the WebUI settings
  // panel uses (`transcriptView` plus the four switches), so both surfaces stay
  // in sync. `showReasoning` keeps its own `/reasoning show on|off` alias for
  // backwards compatibility.
  const displayControl: DisplayControl = {
    get: () => {
      const current = currentSettings()
      return {
        reasoning: current.showReasoning,
        tools: current.showToolCalls,
        args: current.showToolArgs,
        results: current.showToolResults,
      }
    },
    getLevel: () => currentSettings().transcriptView,
    setLevel: (level) => {
      const write = settings.mutate(namespace, [{ op: 'set', path: ['transcriptView'], value: level }], currentRevision())
      write.catch((error: unknown) => {
        console.log(`dsh-feishu: /display level write failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return write
    },
    set: (key, value) => {
      const field = key === 'reasoning'
        ? 'showReasoning'
        : key === 'tools' ? 'showToolCalls' : key === 'args' ? 'showToolArgs' : 'showToolResults'
      // Return the promise (not `void`): the interactive card repaints from a
      // re-read, and `settings` only publishes the new snapshot once the write
      // has persisted. The text path ignores the result, so keep a detached
      // catch to avoid an unhandled rejection there.
      const write = settings.mutate(namespace, [{ op: 'set', path: [field], value }], currentRevision())
      write.catch((error: unknown) => {
        console.log(`dsh-feishu: /display write failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return write
    },
  }
  // Interactive `/display` switch card. Independent of the questions/approvals
  // seams; only needs the live card channel + the display control it writes.
  displayHandle = startFeishuDisplay({
    channel: cardChannel,
    display: displayControl,
    logger: ctx.logger('dsh-feishu'),
    getTranslations: () => translationsFor(currentLocale().id),
  })
  registerLarkCommands(
    ctx,
    llm,
    defaultModel,
    {
      startNewSession: (chatMessage, salt) => bridgeHolder.current?.startNewSession(chatMessage, salt) ?? '',
      switchToSession: (chatMessage, sessionId) => bridgeHolder.current?.switchToSession(chatMessage, sessionId) ?? 'archived',
      detachSession: sessionId => bridgeHolder.current?.detachSession(sessionId) ?? { kind: 'free' as const },
      describeChatKey: key => bridgeHolder.current?.describeChatKey(key) ?? key,
      listSessions: async () => bridgeHolder.current?.listSessions() ?? [],
      getSessionMeta: async (chatMessage) => bridgeHolder.current?.getSessionMeta(chatMessage) ?? { sessionId: '', workspace: '', agentPreset: '', model: '', reasoningEffort: '', title: '', turns: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, contextWindow: 0, lastInputTokens: 0, cacheHitRate: 0, ttftAvgMs: 0, tokensPerSecond: 0, llmDurationMs: 0, toolDurationMs: 0 },
      sessionCurrentSelection: async (chatMessage) => bridgeHolder.current?.sessionCurrentSelection(chatMessage),
      resolveAgent: async (chatMessage) => bridgeHolder.current?.resolveAgent(chatMessage),
      resolveSessionIdFor: (chatMessage) => bridgeHolder.current?.resolveSessionIdFor(chatMessage) ?? '',
    },
    () => {
      const last = bridgeHolder.lastChatMessage
      if (last === undefined) {
        throw new Error('dsh-feishu: chat coordinates missing for /model command — send a regular message first')
      }
      return last
    },
    activeCommandTranslations,
    commands,
    approvalControl,
    showReasoningControl,
    displayControl,
    sessionController,
  )
  ctx.effect(() => () => {
    stopQuestions()
    stopApprovals()
    stopTodos()
    stopJobs()
    stopSubagents()
    stopStreaming()
    stopExternalTurns()
    stopSurface()
    cardImages.dispose()
    stopSendFileTool()
    stopReceiveFileTool()
    modelSelectHandle?.dispose()
    permissionHandle?.stop()
    busyHandle?.stop()
    displayHandle?.stop()
    sessionHandle?.stop()
    deliverHandle?.dispose()
    stopNewSessionConfirmer?.()
  }, 'dsh-feishu: feishu questions + approvals + todos + jobs + streaming + external turns + surface prompt + send-file + model-select + permission + busy + display + session + new-session-confirm listeners')

  let lastPrintedQrUrl: string | undefined
  const provisionManager = new ProvisionManager({
    domain: () => currentSettings().domain,
    onState: state => {
      if (state.phase === 'waiting' && state.qrUrl !== undefined && state.qrUrl !== lastPrintedQrUrl) {
        lastPrintedQrUrl = state.qrUrl
        renderTerminalQr(state.qrUrl, ctx.logger)
      }
    },
    onProvisioned: async result => {
      const ref = currentSettings().appSecretRef
      apiUpdateDepth += 1
      try {
        await credentials.set(credentialRef(ref), result.appSecret)
        await settings.mutate(namespace, [{ op: 'set', path: ['appId'], value: result.appId }], currentRevision())
      } finally {
        apiUpdateDepth -= 1
      }
      await runtime.reconcile()
    },
  })

  // Settings and credential writes go through DSH's native settings form and
  // credentials services (the client page uses `ctx.configForms` and
  // `remote.credentials`); the plugin's own HTTP route carries only the two
  // facts with no native equivalent — live provisioning and connection state.
  //
  // Connection state is BOTH halves: `runtime.status()` carries the boot
  // verdict plus the live inbound WebSocket state, and `outbound` carries what
  // the requests themselves have been doing since.
  const provisionApi = {
    provision: () => provisionManager.start(),
    provisionStatus: () => provisionManager.status(),
    runtimeStatus: () => ({ ...runtime.status(), outbound: outboundHealth.snapshot() }),
  }

  // Persist the plugin's `locale` field (used by `/lang`). Passing `'auto'`
  // unsets the field so the plugin again follows the DSH preference.
  const setPluginLocale = (value: 'zh' | 'en' | 'auto'): Promise<void> => {
    const expected = currentRevision()
    const ops = value === 'auto'
      ? [{ op: 'unset' as const, path: ['locale'] }]
      : [{ op: 'set' as const, path: ['locale'], value }]
    return settings.mutate(namespace, ops, expected).then(() => refreshLocale())
  }

  // Credentials-change event was renamed `credentials/updated` →
  // `credentials/reference-updated` in a newer Harness. Register under BOTH
  // names via a loose cast so `tsc` typechecks against either version; the
  // name a given Harness never emits simply never fires (a no-op there). The
  // ref are credential-reference names, so `=== appSecretRef` matches.
  const onCredentialRefUpdated = (ref: string): void => {
    if (apiUpdateDepth === 0 && ref === currentSettings().appSecretRef) void runtime.reconcile()
  }
  const looseOn = (name: string, handler: (ref: string) => void): void => {
    ;(ctx as unknown as { on(name: string, handler: (ref: string) => void): unknown }).on(name, handler)
  }
  // DSH 0.1.7 dropped the namespace watcher (`settings.register(...).watch`):
  // a config write is committed into the live Config references and the OWNING
  // fiber is notified through `loader/volatile-update` (a fiber-local event, so
  // this fires for this plugin's own row only). Values are committed before the
  // event, so re-reading them here is safe. `/display`, `/lang`, and the
  // settings page write through `settings.mutate` and land here too, but they
  // already reconcile themselves — `reconcile()` is fingerprint-gated, so the
  // repeat is a no-op.
  ctx.on('loader/volatile-update', () => {
    refreshLocale()
    if (apiUpdateDepth > 0) return
    void runtime.reconcile()
  })
  // A settings write anywhere invalidates the cached DSH language so the next
  // repaint re-reads it. Deliberately does NOT call `describe()` here: this
  // handler runs inside the `describe()` that emitted the event.
  ctx.on('settings/document-updated', (ns) => {
    if (ns === 'locale') dshLocale = undefined
  })
  looseOn('credentials/updated', onCredentialRefUpdated)
  looseOn('credentials/reference-updated', onCredentialRefUpdated)
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: PROVISION_PATH,
    handler: (req, res) => handleProvisionRequest(req, res, provisionApi),
  }), 'dsh-feishu: provision endpoint')
  ctx.effect(() => () => {
    provisionManager.dispose()
    return runtime.dispose()
  }, 'dsh-feishu: runtime')
  await runtime.reconcile()
}

/**
 * Localized strings for the `/model` command. Keeping these inline (rather
 * than registering a locale namespace) keeps the dependency surface small —
 * the strings are owned by the Feishu-facing command handler and rarely
 * change.
 */

/** Compact token count display: 517 / 12.2K / 1.2M */
function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

// Active command-layer translations. Kept in sync with the resolved locale by
// the apply closure (see `setActiveCommandTranslations`); module-level command
// handlers read this single cell so they render in the user's language without
// threading a `t` through every call site.
let activeCommandTranslations: CommandTranslations = commandTranslationsFor('zh')
function setActiveCommandTranslations(locale: 'zh' | 'en'): void {
  activeCommandTranslations = commandTranslationsFor(locale)
}

/** Render the /status result as a Feishu interactive card. */
function renderStatusCard(meta: {
  sessionId: string; workspace: string; agentPreset: string; model: string; reasoningEffort: string; title: string
  turns: number; steps: number; toolCalls: number; inputTokens: number; outputTokens: number
  contextWindow: number; lastInputTokens: number
}, agentRunning: boolean, sandboxMode?: string, busyMode?: string, t: Translations = translationsFor('zh')): object {
  const fields: string[] = []
  fields.push(`**${t.statusSessionLabel}:** \`${meta.sessionId}\``)
  if (meta.title !== '') fields.push(`**${t.statusTitleLabel}:** ${meta.title}`)
  fields.push(`**${t.statusWorkspaceLabel}:** \`${meta.workspace || '(default)'}\``)
  fields.push(`**${t.statusPresetLabel}:** \`${meta.agentPreset || '(default)'}\``)
  fields.push(`**${t.statusModelLabel}:** \`${meta.model}\``)
  if (meta.reasoningEffort !== '') fields.push(`**${t.statusReasoningLabel}:** \`${meta.reasoningEffort}\``)
  if (sandboxMode !== undefined) {
    const label = PERMISSION_LABELS[sandboxMode] ?? sandboxMode
    const icon = sandboxMode === 'workspace-write' ? ' ✍️' : sandboxMode === 'danger-full-access' ? ' 🔓' : sandboxMode === 'read-only' ? ' 📖' : ''
    fields.push(`**${t.statusPermissionLabel}:** \`${sandboxMode}\` ${label}${icon}`)
  }
  if (busyMode !== undefined) {
    // WebUI names this "Enter behavior while busy"; options Queue / Steer.
    const label = busyMode === 'steer' ? 'Steer' : 'Queue'
    const icon = busyMode === 'steer' ? '🎯' : '📥'
    fields.push(`**${t.statusBusyLabel}:** ${icon} ${label}`)
  }
  fields.push(`**${t.statusAgentLabel}:** ${agentRunning ? t.statusAgentRunning : t.statusAgentIdle}`)
  if (meta.turns > 0 || meta.steps > 0) {
    const parts: string[] = [`${meta.turns} turns`, `${meta.steps} steps`]
    if (meta.toolCalls > 0) parts.push(`${meta.toolCalls} tool calls`)
    fields.push(`**Activity:** ${parts.join(' · ')}`)
    if (meta.inputTokens > 0 || meta.outputTokens > 0) {
      fields.push(`**Tokens:** ${formatTokenCount(meta.inputTokens)} in · ${formatTokenCount(meta.outputTokens)} out`)
    }
  }
  if (meta.contextWindow > 0) {
    const pct = Math.min(100, Math.round(meta.lastInputTokens / meta.contextWindow * 100))
    fields.push(`**Context:** ${formatTokenCount(meta.lastInputTokens)} / ${formatTokenCount(meta.contextWindow)} (${pct}%)`)
  }
  if (agentRunning) {
    fields.push('')
    fields.push(t.statusRunWarning)
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📊 Session Status' },
      template: 'turquoise',
    },
    body: { elements: [{ tag: 'markdown', content: fields.join('\n') }] },
  }
}

/** Handle /detach directly: force-release a session so any dialog can switch to it. */
async function handleDetachDirect(
  rawInput: string,
  bridge: HarnessConversationService,
): Promise<{ kind: 'success' | 'error'; text: string }> {
  const t = activeCommandTranslations
  const index = Number.parseInt(rawInput.trim(), 10)
  if (!Number.isInteger(index) || index < 1) {
    return { kind: 'error', text: `${t.detachInvalidIndex}\n${t.detachUsage}` }
  }
  const sessions = await bridge.listSessions()
  const entry = sessions[index - 1]
  if (entry === undefined) {
    return { kind: 'error', text: `${t.detachInvalidIndex}\n${t.detachUsage}` }
  }
  const outcome = bridge.detachSession(entry.id)
  if (outcome.kind === 'free') {
    return { kind: 'success', text: t.detachFree }
  }
  return { kind: 'success', text: t.detachReleased(index, entry.id, outcome.ownerLabel) }
}

/** Parse `provider/model` or `provider/model:reasoning-effort` for the
 *  optional model argument of the `/new` text command. */
function parseNewModelRoute(rawInput: string): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const trimmed = rawInput.trim()
  if (trimmed === '') return undefined
  const segments = trimmed.split('/')
  if (segments.length !== 2) return undefined
  const provider = segments[0]?.trim() ?? ''
  const modelSegment = segments[1]?.trim() ?? ''
  if (provider === '' || modelSegment === '') return undefined
  const modelParts = modelSegment.split(':')
  const model = modelParts[0]?.trim() ?? ''
  const reasoningEffort = modelParts[1]?.trim()
  if (model === '') return undefined
  return reasoningEffort === undefined || reasoningEffort === ''
    ? { provider, model }
    : { provider, model, reasoningEffort }
}

/** Create a fresh session for a chat with explicit creation options, and
 *  render the confirmation card. Shared by the `/new` card flow (model step
 *  confirmed) and the `/new <workspace> <preset> [model]` text command. */
export async function commitNewSession(
  bridge: HarnessConversationService,
  cardChannel: ModelSelectChannel,
  chatMessage: ConversationMessage,
  options: ChatCreationOptions,
  messageId?: string,
  topic?: { rootId?: string; threadId?: string },
  repaint?: { cardId: string; paint: (card: object) => Promise<void> },
  hooks?: { prepareWorkspace?: (() => Promise<void>) | undefined },
): Promise<{ messageId?: string }> {
  // The workspace must exist (and be registered) before the session that lives
  // in it is created: this is the one place where the `/new` flow touches the
  // world, which is what makes "cancel leaves nothing behind" true (O19).
  if (hooks?.prepareWorkspace !== undefined) {
    try {
      await hooks.prepareWorkspace()
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.log(`dsh-feishu: could not prepare the workspace: ${msg}`)
      const failed = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '📁 工作区' }, template: 'red' },
        body: {
          elements: [{
            tag: 'markdown',
            content: `⚠️ **无法创建工作区**\n\n\`${options.workspace ?? ''}\`\n\n${msg}\n\n会话没有创建。`,
          }],
        },
      }
      if (repaint !== undefined) {
        await repaint.paint(failed)
        return {}
      }
    }
  }
  const salt = `new-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const sessionId = bridge.startNewSession(chatMessage, salt, options)
  const parts: string[] = []
  if (options.workspace !== undefined) parts.push(`📁 \`${options.workspace}\``)
  if (options.agentPreset !== undefined) parts.push(`🧩 \`${options.agentPreset}\``)
  if (options.provider !== undefined && options.model !== undefined) {
    parts.push(`🤖 \`${options.provider}/${options.model}\``)
  }
  const summary = parts.length > 0 ? parts.join(' · ') : '使用默认设置'
  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '✅ 会话已创建' }, template: 'green' },
    body: {
      elements: [
        { tag: 'markdown', content: `**Session** \`${sessionId}\`\n\n${summary}\n\n现在可以发送消息开始对话了。` },
      ],
    },
  }
  const opts = topic?.threadId !== undefined && topic.rootId !== undefined
    ? { replyInThread: true, replyTo: topic.rootId }
    : {}
  // A confirmation card turns into the result in place — it already shows the
  // settings that were just committed.
  if (repaint !== undefined) {
    await repaint.paint(card)
    return {}
  }
  if (messageId === undefined) {
    const cardId = await cardChannel.createCardInstance(card)
    return cardChannel.sendCardByReference(chatMessage.chatId, cardId, opts)
  }
  await cardChannel.updateCard(messageId, card)
  return {}
}

/**
 * Detect a slash command in an inbound chat message and dispatch it through
 * the Harness command runtime, returning the textual result so the channel
 * can echo it back to the user. A `undefined` return signals that the
 * message is not a command and should fall through to the agent reply.
 */
async function executeSlashCommand(
  message: NormalizedMessage,
  bridge: HarnessConversationService,
  commands: CommandRuntime,
  bridgeHolder: { lastChatMessage: { chatId: string; chatType: 'p2p' | 'group'; threadId?: string } | undefined },
  sessionController?: { selectModel?: (r: any) => Promise<any>; cancel?: (r: any) => Promise<any>; prompt?: (req: any, signal?: AbortSignal) => Promise<{ accepted: boolean }> },
  agents?: { get: (id: any) => { cancel: (cause: { kind: 'user' }, opts: { keepInbox?: boolean }) => void; session?: any } | undefined },
  sandboxPolicy?: { resolve?: (r: { session?: any }) => { mode: string; workspaceRoot?: string } },
  permissionCard?: { open: (chat: ConversationMessage, sessionId: string) => Promise<string | undefined> },
  llm?: LlmRuntime,
  agentDefaultModel?: AgentDefaultModelConfig,
  cardChannel?: ModelSelectChannel,
  busyCard?: { open: (chat: ConversationMessage) => Promise<string | undefined> },
  modelSelectMaps?: { cardByMessage: Map<string, string>; sequenceByCard: Map<string, number> },
  onboardingHandle?: FeishuOnboardingHandle,
  workspaceRegistry?: { list(): { path: string; name?: string }[]; readonly pinnedSessionIds?: readonly string[] },
  agentPresets?: { list(): Promise<Array<{ id: string; title?: string }>> },
  approvals?: ApprovalControl,
  showReasoning?: { get: () => boolean; toggle: () => void },
  display?: DisplayControl,
  displayCard?: FeishuDisplayHandle,
  sessionCard?: FeishuSessionHandle,
  localeControl?: {
    current: () => { id: LocaleId; plugin: 'zh' | 'en' | 'auto'; dsh: string | undefined }
    set: (value: 'zh' | 'en' | 'auto') => Promise<void>
  },
  permissionPresets?: { current?: (session: any) => string; set?: (session: any, name: string) => void },
  cardTopics?: CardTopicRegistry,
): Promise<
  | { kind: 'success' | 'error'; text: string; card?: object }
  | { kind: 'consumed' }
  | undefined
> {
  const parsed = parseCommand(message.content)
  if (parsed === undefined) return undefined
  const chatMessage = {
    chatId: message.chatId,
    chatType: message.chatType,
    ...message.threadId === undefined ? {} : { threadId: message.threadId },
    // Topic root id (fallback: the message itself is the root) so cards sent
    // from slash commands land inside the topic and `recordTopic` captures it.
    ...message.threadId === undefined ? {} : { rootId: message.rootId ?? message.messageId },
  }
  // Record topic context so later card actions (model selector, onboarding)
  // can recover the thread key even though card action events carry no
  // thread id.
  if (message.threadId !== undefined) {
    onboardingHandle?.noteTopic(chatMessage)
  }
  // /status, /new, /session are handled directly — they don't need a live agent.
  if (parsed.name === 'status') {
    const meta = await bridge.getSessionMeta(chatMessage)
    const agentRunning = bridge.isAgentRunning(chatMessage)
    const sessionId = meta.sessionId
    const session = agents?.get(sessionId)?.session as any
    const sandboxMode = sandboxPolicy?.resolve?.({ session })?.mode
    const busyMode = bridge.busyMode(chatMessage)
    return { kind: 'success', text: '', card: renderStatusCard(meta, agentRunning, sandboxMode, busyMode, translationsFor(localeControl?.current().id ?? 'zh')) }
  }
  if (parsed.name === 'lang') {
    const arg = parsed.rawInput.trim().toLowerCase()
    const current = localeControl?.current() ?? { id: 'zh' as LocaleId, plugin: 'auto' as const, dsh: undefined }
    const LANG_STRS: Record<string, string> = { zh: '中文', en: 'English', auto: 'auto' }
    const describe = (): string => {
      const label = LANG_STRS[current.id] ?? current.id
      const source = current.plugin === 'auto'
        ? (current.dsh === undefined
            ? '跟随 DSH 优先 / 默认中文'
            : `跟随 DSH（\`${current.dsh}\`）`)
        : `由插件锁定（\`${current.plugin}\`）`
      return `当前语言：**${label}**（${source}）`
    }
    if (arg === '' || arg === 'show') {
      return { kind: 'success', text: describe() }
    }
    if (arg === 'zh' || arg === 'en') {
      await localeControl?.set(arg)
      const after = localeControl?.current()
      return { kind: 'success', text: after === undefined ? '已切换。' : `已切换为 **${LANG_STRS[after.id]}**。${describe()}` }
    }
    if (arg === 'auto') {
      await localeControl?.set('auto')
      return { kind: 'success', text: `已切换为跟随 DSH 语言。${describe()}` }
    }
    return { kind: 'error', text: `用法：\`/lang [zh|en|auto]\`\n- \`zh\` 中文 · \`en\` English · \`auto\` 跟随 DSH\n当前：**${LANG_STRS[current.id] ?? current.id}**` }
  }
  if (parsed.name === 'new') {
    const args = parsed.rawInput.trim().split(/\s+/).filter(s => s !== '')
    if (args.length === 0) {
      // Card flow: workspace → preset → model → create. Consumed so the
      // channel does not send a text follow-up.
      if (onboardingHandle === undefined) {
        return { kind: 'error', text: '⚠️ 新建会话卡片不可用。' }
      }
      await onboardingHandle.startNewFlow(chatMessage)
      return { kind: 'consumed' }
    }
    // Text form: /new <workspace> <agentPreset> [provider/model[:reasoning]]
    if (args.length < 2) {
      return { kind: 'error', text: activeCommandTranslations.newUsage }
    }
    const [workspaceArg, presetArg, modelArg] = args
    if (workspaceArg === undefined || presetArg === undefined) {
      return { kind: 'error', text: activeCommandTranslations.newUsage }
    }
    // Validate workspace exists
    if (workspaceRegistry === undefined) {
      return { kind: 'error', text: '⚠️ 工作区服务不可用。' }
    }
    const workspaces = workspaceRegistry.list()
    const workspace = workspaces.find(w => w.path === workspaceArg || w.name === workspaceArg)
    if (workspace === undefined) {
      const names = workspaces.map(w => w.name !== undefined && w.name !== '' ? w.name : w.path).join('`, `')
      return { kind: 'error', text: `⚠️ 未知工作区 \`${workspaceArg}\`。可用：\`${names}\`` }
    }
    // Validate preset exists
    if (agentPresets === undefined) {
      return { kind: 'error', text: '⚠️ Agent 模板服务不可用。' }
    }
    const presets = await agentPresets.list()
    if (!presets.some(p => p.id === presetArg)) {
      const ids = presets.map(p => p.id).join('`, `')
      return { kind: 'error', text: `⚠️ 未知 Agent 模板 \`${presetArg}\`。可用：\`${ids}\`` }
    }
    // Optional model route: provider/model[:reasoning]
    let modelOptions: ChatCreationOptions = {}
    if (modelArg !== undefined && modelArg !== '') {
      const route = parseNewModelRoute(modelArg)
      if (route === undefined) {
        return { kind: 'error', text: `⚠️ 无法解析模型参数 \`${modelArg}\`，格式：\`provider/model\` 或 \`provider/model:reasoning\`` }
      }
      modelOptions = {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort as never } : {}),
      }
    }
    const options: ChatCreationOptions = {
      workspace: workspace.path,
      agentPreset: presetArg,
      ...(modelOptions.provider !== undefined ? { provider: modelOptions.provider } : {}),
      ...(modelOptions.model !== undefined ? { model: modelOptions.model } : {}),
      ...(modelOptions.reasoningEffort !== undefined ? { reasoningEffort: modelOptions.reasoningEffort } : {}),
    }
    if (options.agentPreset === undefined) {
      return { kind: 'error', text: activeCommandTranslations.newUsage }
    }
    if (cardChannel === undefined) {
      return { kind: 'error', text: '⚠️ 卡片通道不可用。' }
    }
    await commitNewSession(bridge, cardChannel, chatMessage, options, undefined, {
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      ...(message.threadId === undefined ? {} : { rootId: message.rootId ?? message.messageId }),
    })
    return { kind: 'consumed' }
  }
  if (parsed.name === 'session') {
    const input = parsed.rawInput.trim()
    if (input === '') {
      // Interactive management panel (switch / detach / rename / archive / fork).
      if (sessionCard === undefined) {
        return { kind: 'error', text: '⚠️ 会话管理卡片不可用。' }
      }
      await sessionCard.open(chatMessage)
      return { kind: 'consumed' }
    }
    if (input === 'list') {
      const sessions = await bridge.listSessions()
      const pinned = new Set(workspaceRegistry?.pinnedSessionIds ?? [])
      return { kind: 'success', text: '', card: renderSessionListCard(sessions, translationsFor(localeControl?.current().id ?? 'zh'), pinned) }
    }
    const index = Number.parseInt(input, 10)
    if (!Number.isInteger(index) || index < 1) {
      return { kind: 'error', text: `${activeCommandTranslations.threadInvalidIndex}\n${activeCommandTranslations.threadUsage}` }
    }
    const sessions = await bridge.listSessions()
    const entry = sessions[index - 1]
    if (entry === undefined) {
      return { kind: 'error', text: `${activeCommandTranslations.threadInvalidIndex}\n${activeCommandTranslations.threadUsage}` }
    }
    // Quick switch with the same detach+attach semantics as the panel.
    const outcome = bridge.attachSession(chatMessage, entry.id)
    if (outcome === 'archived') {
      return { kind: 'error', text: activeCommandTranslations.threadArchived }
    }
    return { kind: 'success', text: activeCommandTranslations.threadSwitched(index, entry.id) }
  }
  if (parsed.name === 'detach') {
    return await handleDetachDirect(parsed.rawInput.trim(), bridge)
  }
  // /stop cancels the running agent — mirrors the WebUI stop button. The
  // bridge both bumps the per-chat stop generation (so a message queued behind
  // the running turn is DROPPED instead of auto-restarting) and cancels the
  // live agent with `keepInbox:false` (aborting the turn and clearing the inbox).
  if (parsed.name === 'stop') {
    if (!bridge.stopSession(chatMessage)) {
      return { kind: 'error', text: '⚠️ 该 session 当前没有运行中的 agent，无需停止。' }
    }
    return { kind: 'success', text: '⏹️ Agent 已停止，排队中的消息已丢弃。当前 turn 的工具执行将尽快终止。' }
  }
  // /busy [queue|steer] sets the per-chat behavior for messages sent while the
  // agent is running: queue (wait for the turn, then run as a new turn) or
  // steer (inject into the running turn). Persisted across restarts. With no
  // argument it opens the interactive picker card (buttons switch the mode);
  // `/busy <mode>` still switches directly by text. The one-off `/steer <text>`
  // remains for a temporary injection.
  if (parsed.name === 'busy') {
    const raw = parsed.rawInput.trim()
    if (raw === '') {
      // Interactive picker card: clicking a button switches the mode and the
      // card re-marks the active one. Fall back to a text listing when the
      // picker handle is unavailable.
      if (busyCard !== undefined) {
        try {
          await busyCard.open(chatMessage)
          return { kind: 'consumed' }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: `⚠️ /busy 卡片失败：${msg}` }
        }
      }
      const current = bridge.busyMode(chatMessage)
      const icon = current === 'steer' ? ' 🎯' : ' 📥'
      const label = current === 'steer' ? 'Steer' : 'Queue'
      return { kind: 'success', text: [
        `**运行中（busy）的 Enter 行为：** \`${current}\` ${label}${icon}`,
        '',
        '仅运行中生效：',
        '- `queue`：排队发送，当前轮结束后作为新轮运行（默认）',
        '- `steer`：插话发送，把消息注入当前运行轮立即响应',
        '',
        '**切换：** `/busy queue` 或 `/busy steer`（持久化）',
        '_一次性插话用 `/steer <内容>`_',
      ].join('\n') }
    }
    if (raw !== 'queue' && raw !== 'steer') {
      return { kind: 'error', text: '⚠️ 未知 busy 模式。可选：queue | steer' }
    }
    bridge.setBusyMode(chatMessage, raw)
    const desc = raw === 'steer' ? '插话发送（注入当前轮）' : '排队发送（当前轮结束后开新轮）'
    return { kind: 'success', text: `✅ 已把本聊天运行中（busy）的 Enter 行为切为 \`${raw}\`（${desc}）。已持久化。` }
  }
  // /queue <text> is the conjugate of /steer: it forces a message onto the
  // QUEUE path even when the chat is in steer mode, so it runs as a new turn
  // after the current one instead of being injected into the running turn.
  // When the chat is ALREADY in queue mode this is redundant (a plain message
  // queues anyway), so short-circuit with a hint instead of submitting.
  if (parsed.name === 'queue') {
    const text = parsed.rawInput.trim()
    if (text === '') {
      return { kind: 'error', text: '⚠️ 用法：/queue <内容> —— 在 steer 模式下也强制把一条消息排队为新轮（/steer 的共轭）。' }
    }
    // Idle fallback: nothing is running, so "queue behind a live turn" is moot —
    // just send the content as a new message (the Feishu default) instead of
    // erroring, and say so explicitly.
    if (!bridge.isAgentRunning(chatMessage)) {
      void bridge.reply({ ...chatMessage, content: text }).catch((error: unknown) => {
        if (error instanceof TurnDroppedError) return
        console.error('dsh-feishu: /queue idle-fallback reply failed:', error instanceof Error ? error.message : String(error))
      })
      return {
        kind: 'success',
        text: `💬 Agent 当前空闲，已把内容作为新消息发送：\`${text}\``,
      }
    }
    if (bridge.busyMode(chatMessage) === 'queue') {
      return { kind: 'error', text: '⚠️ 本聊天已在 queue 模式：直接发送消息即会排队为新轮，无需 /queue。\n\n若想注入当前运行轮，用 `/steer <内容>` 或改用 `/busy steer`。' }
    }
    // Submit in the background so the command can acknowledge immediately; the
    // queue path waits for the current turn then runs it as a new turn. A
    // `TurnDroppedError` (user ran /stop while queued) is a silent drop, not a
    // failure — the acknowledgment already told them they can /stop.
    void bridge.reply({ ...chatMessage, content: text }, { forceQueue: true }).catch((error: unknown) => {
      if (error instanceof TurnDroppedError) return
      console.error('dsh-feishu: /queue background reply failed:', error instanceof Error ? error.message : String(error))
    })
    return {
      kind: 'success',
      text: `📥 已把消息排队为该聊天下一轮运行：\`${text}\`\n\n当前 turn 结束后会自动生成本次回答。排队期间可用 \`/stop\` 丢弃。`,
    }
  }
  // /steer <text> injects a message into the RUNNING agent turn (DSH next-step
  // inbox) instead of queueing it as a new turn — the Feishu equivalent of the
  // WebUI's steer gesture while busy. When the chat is ALREADY in steer mode
  // this is redundant (a plain message injects anyway), so short-circuit with a
  // hint instead of submitting. The bridge does not wait for idle, so we
  // acknowledge immediately with a confirmation text (the steered content
  // itself still renders through the per-step streaming cards as the turn
  // continues) — otherwise the injection would be silent with no feedback.
  if (parsed.name === 'steer') {
    const text = parsed.rawInput.trim()
    if (text === '') {
      return { kind: 'error', text: '⚠️ 用法：/steer <内容> —— 在 agent 运行中把一条消息注入当前 turn。' }
    }
    // Idle fallback: nothing is running (no agent or agent not in a turn), so an
    // injection cannot apply. Instead of erroring, send the content as a new
    // message (the Feishu default) and say so explicitly. The reply() call never
    // steers when not running, so this is always a fresh turn.
    if (!bridge.isAgentRunning(chatMessage)) {
      void bridge.reply({ ...chatMessage, content: text }).catch((error: unknown) => {
        if (error instanceof TurnDroppedError) return
        console.error('dsh-feishu: /steer idle-fallback reply failed:', error instanceof Error ? error.message : String(error))
      })
      return {
        kind: 'success',
        text: `💬 Agent 当前空闲，已把内容作为新消息发送：\`${text}\`\n\n若要在 agent 运行中插话，请等本轮结束后用它再发一条普通消息即可（或改用 \`/busy steer\` 常开插话）。`,
      }
    }
    if (bridge.busyMode(chatMessage) === 'steer') {
      return { kind: 'error', text: '⚠️ 本聊天已在 steer 模式：直接发送消息即会注入当前运行轮，无需 /steer。\n\n若想排队为新轮，用 `/queue <内容>` 或改用 `/busy queue`。' }
    }
    try {
      await bridge.steer({ ...chatMessage, content: text })
      return {
        kind: 'success',
        text: `🎯 已注入运行中的 turn：\`${text}\`\n\nAgent 会把它作为下一步指令继续执行。若想中止，发送 \`/stop\`。`,
      }
    } catch (error: unknown) {
      return { kind: 'error', text: `⚠️ /steer 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  // /permission [preset] shows / switches the session file-permission mode.
  // Naming and labels match the DSH WebUI's `ui-permission-presets` plugin
  // (the `/permission` command; presets read-only / workspace-write /
  // danger-full-access shown as Read Only / Workspace Write / Full access).
  // The switch mirrors `dsh-sandbox-policy`'s per-session override: one
  // log-only `sandbox/mode` event (the `setSandboxMode` write path) that takes
  // effect on the session's next confined call. Reading uses the policy
  // service's resolve (explicit grant > session override > deployment default).
  // `/sandbox` is kept as a hidden alias for anyone already using the old name.
  if (parsed.name === 'permission' || parsed.name === 'sandbox') {
    if (sandboxPolicy?.resolve === undefined) {
      return { kind: 'error', text: '⚠️ dsh-sandbox-policy 服务不可用，无法管理权限模式。' }
    }
    const sessionId = bridge.resolveSessionIdFor(chatMessage)
    const session = agents?.get(sessionId)?.session as any
    if (session === undefined) {
      return { kind: 'error', text: '⚠️ 当前 chat 还没有会话，请先发一条消息再执行 /permission。' }
    }
    const raw = parsed.rawInput.trim()
    const current = sandboxPolicy.resolve({ session }).mode
    const currentLabel = PERMISSION_LABELS[current] ?? current
    if (raw === '') {
      // Interactive picker card: clicking a button switches the mode and the
      // card re-marks the active preset. Fall back to a text listing when the
      // picker handle is unavailable.
      if (permissionCard !== undefined) {
        try {
          await permissionCard.open(chatMessage, sessionId)
          return { kind: 'consumed' }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: `⚠️ /permission 卡片失败：${msg}` }
        }
      }
      const lines = [
        '**当前权限模式：**',
        `- \`${current}\` ${currentLabel}${current === 'danger-full-access' ? ' 🔓' : current === 'workspace-write' ? ' ✍️' : ' 📖'}`,
        '',
        '**切换方法：** `/permission <模式>`',
        '',
        '**可选模式：**',
        ...SANDBOX_MODES.map(m => `- \`${m}\` ${PERMISSION_LABELS[m] ?? m}${m === current ? ' （当前）' : ''}`),
        '',
        '_切换写入会话日志，下一次受限调用（bash / 文件系统）即生效。_',
      ]
      return { kind: 'success', text: lines.join('\n') }
    }
    if (!(SANDBOX_MODES as readonly string[]).includes(raw)) {
      return { kind: 'error', text: `⚠️ 未知权限模式 \`${raw}\`。可选：${SANDBOX_MODES.join(' | ')}（对应 Read Only / Workspace Write / Full access）` }
    }
    // Switch through DSH's preset write path when available: a preset bundles
    // the sandbox mode AND the approval policy, so writing only the sandbox
    // knob leaves the bundle unmatched and DSH shows it as "custom". Fall back
    // to the single-knob `sandbox/mode` append when the service is absent.
    // The write can legitimately refuse (the persistent-shell fence), so
    // report the reason here instead of letting it surface as a bare
    // `命令执行出错` from the channel's catch-all.
    try {
      if (permissionPresets?.set !== undefined) {
        permissionPresets.set(session, raw)
      } else {
        session.append('sandbox/mode', { mode: raw })
      }
    } catch (error: unknown) {
      return { kind: 'error', text: describePermissionSwitchFailure(error, translationsFor(localeControl?.current().id ?? 'zh')) }
    }
    return { kind: 'success', text: `✅ 权限模式已切换为 \`${raw}\`（${PERMISSION_LABELS[raw] ?? raw}）。将从下一次受限调用起生效。` }
  }
  // /model with no arguments renders the model selector card (V2 card
  // instance) instead of falling through to commands.execute. The card's
  // dropdowns drive the feishu-model-select flow; `/model provider/model`
  // and `/model list` still go through commands.execute as before.
  if (parsed.name === 'model' && parsed.rawInput.trim() === '') {
    if (agentDefaultModel === undefined) {
      return { kind: 'error', text: '⚠️ Agent default model service is not available.' }
    }
    if (llm === undefined) {
      return { kind: 'error', text: '⚠️ LLM service is not available.' }
    }
    // Show the model THIS session actually runs, not the global default:
    // `agentDefaultModel.currentSelection()` is only the default for agents
    // without a session-specific selection, and a WebUI switch / session
    // creation can set a per-session model that never touches it. Fall back to
    // the default only when the session has no recorded model yet.
    const defaultCurrent = agentDefaultModel.currentSelection()
    const sessionCurrent = await bridge.sessionCurrentSelection(chatMessage).catch(() => undefined)
    const current = sessionCurrent ?? {
      provider: defaultCurrent.provider,
      model: defaultCurrent.model,
      ...(defaultCurrent.reasoningEffort !== undefined ? { reasoningEffort: String(defaultCurrent.reasoningEffort) } : {}),
    }
    if (cardChannel === undefined || modelSelectMaps === undefined) {
      // Fallback: return the card in the old format (embedded JSON).
      const providers = llm.listProviders()
      return { kind: 'success', text: '', card: renderProviderSelectCard(providers, {
        provider: current.provider,
        model: current.model,
        ...(current.reasoningEffort !== undefined ? { reasoningEffort: String(current.reasoningEffort) } : {}),
      }, undefined, translationsFor(localeControl?.current().id ?? 'zh')) }
    }
    // V2 flow: create card instance + send by card_id reference.
    const providers = llm.listProviders()
    const card = renderProviderSelectCard(providers, {
      provider: current.provider,
      model: current.model,
      ...(current.reasoningEffort !== undefined ? { reasoningEffort: String(current.reasoningEffort) } : {}),
    }, undefined, translationsFor(localeControl?.current().id ?? 'zh'))
    try {
      await sendModelCardV2(cardChannel, chatMessage, card, modelSelectMaps.cardByMessage, modelSelectMaps.sequenceByCard, cardTopics)
      // V2 card was sent directly via cardkit. Signal "consumed" so channel.ts
      // sends no follow-up message AND does not fall through into the agent
      // loop (returning `undefined` would treat `/model` as a regular message).
      return { kind: 'consumed' }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      // Fallback: send as embedded card (old format).
      return { kind: 'success', text: '', card }
    }
  }
  // ── Conversation-free slash commands ────────────────────────────────
  // These only need deployment config and/or a derived session id — not a live
  // agent — so they work right after a restart (before any new message) and on
  // a brand-new chat. Commands that genuinely need an existing/running session
  // (`steer`, `permission`, and DSH-native `compact`/`goal`/…) are NOT listed
  // here: they fall through to the resolveAgent gate below.
  bridgeHolder.lastChatMessage = chatMessage
  const freeSessionId = bridge.resolveSessionIdFor(chatMessage)
  const freeInvocation = (rawInput: string, agentOverride?: unknown) =>
    ({ name: parsed.name, rawInput, agent: agentOverride ?? { session: { id: freeSessionId } } }) as unknown as CommandInvocation
  const freeChatMessageFor = () => chatMessage as ConversationMessage
  // CommandResult has an optional `text`; normalize to the handler's echo shape.
  const toEcho = (r: CommandResult) =>
    ({ kind: r.kind, text: r.text ?? `Command /${parsed.name} produced no output.` } as const) as unknown as { kind: 'success' | 'error'; text: string; card?: object }
  if (parsed.name === 'model' && parsed.rawInput.trim() !== '' && llm !== undefined && agentDefaultModel !== undefined) {
    return toEcho(await handleModelCommand(freeInvocation(parsed.rawInput), llm, agentDefaultModel, bridge, freeChatMessageFor, activeCommandTranslations, (sessionController ?? {}) as never))
  }
  if (parsed.name === 'reasoning' && agentDefaultModel !== undefined && llm !== undefined) {
    return toEcho(await handleReasoningCommand(freeInvocation(parsed.rawInput), llm, agentDefaultModel, bridge, freeChatMessageFor, activeCommandTranslations, showReasoning ?? { get: () => false, toggle: () => {} }, (sessionController ?? {}) as never))
  }
  if (parsed.name === 'display' && display !== undefined) {
    // No argument → interactive switch card (tap instead of remembering the
    // syntax). Any failure falls back to the text listing, so `/display` always
    // answers.
    if (parsed.rawInput.trim() === '' && displayCard !== undefined) {
      try {
        await displayCard.open(chatMessage)
        return { kind: 'consumed' }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        console.log(`dsh-feishu: /display card failed, falling back to text: ${msg}`)
      }
    }
    return toEcho(handleDisplayCommand(freeInvocation(parsed.rawInput), activeCommandTranslations, display))
  }
  if (parsed.name === 'approvals' && approvals !== undefined) {
    return toEcho(await handleListApprovalsCommand(freeInvocation(parsed.rawInput), approvals, activeCommandTranslations))
  }
  if ((parsed.name === 'approve' || parsed.name === 'deny') && approvals !== undefined) {
    return toEcho(await handleApprovalCommand(freeInvocation(parsed.rawInput), approvals, parsed.name === 'approve' ? 'allowed-once' : 'rejected', activeCommandTranslations))
  }
  if (parsed.name === 'help') {
    // Prefer the full scoped command list when a session/agent exists (a
    // persisted cold session is resumed here); otherwise fall back to listing
    // the commands this plugin contributes so /help always works. Rendered as
    // a card so markdown (headers / code) renders — a plain text message does
    // not.
    const scoped = await bridge.resolveAgentOrResume(chatMessage)
    const helpText = scoped !== undefined
      ? ((await handleHelpCommand(freeInvocation(parsed.rawInput, scoped), commands, activeCommandTranslations))?.text ?? '')
      : renderFeishuCommandsOnly(activeCommandTranslations)
    return { kind: 'success', text: '', card: renderSessionResultCard('🧭 帮助', [helpText]) }
  }
  // Stash the chat coordinates so the registered handler can find them
  // without holding per-invocation state on the agent. The bridge serializes
  // inbound messages per chat, so a synchronous dispatch always sees its own
  // chat context here.
  const agent = await bridge.resolveAgentOrResume(chatMessage)
  if (agent === undefined) {
    return {
      kind: 'error',
      text: 'Slash commands need an existing conversation in this chat — send a regular message first.',
    }
  }
  const controller = new AbortController()
  const line = `/${parsed.name}${parsed.rawInput}`
  // `commands.execute` is reached through Cordis's traceable Proxy, which
  // shadows every method call's `thisArg` (see vendor/cordis `createShadowMethod`).
  // Extracting it to a local `execute` and invoking as a free function would
  // detach `this`, causing `this.view(agent)` inside the runtime to throw
  // "Cannot read properties of undefined (reading 'view')". Call it as a
  // method on `commands` so the proxy sees the correct receiver.
  //
  // The 4-arg shape `(agent, line, images, signal)` matches `^0.1.0-rc.7`
  // and later; the plugin has no image-attachment path so we pass `[]`.
  const execution = await commands.execute(agent, line, [], controller.signal) as CommandExecution | undefined
  if (execution === undefined) return undefined
  const result: CommandResult = execution.result
  return { kind: result.kind, text: result.text ?? `Command /${parsed.name} produced no output.` }
}

// Keep the SlashCommandHandler import live for callers that prefer the type
// alias without reaching into `./channel.ts`.
export type { SlashCommandHandler }
