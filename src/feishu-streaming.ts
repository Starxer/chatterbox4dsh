/**
 * Feishu UI bridge for per-step assistant cards: subscribes to the host's
 * `session/event` fan-out and renders ONE card per agent step, containing
 * reasoning, text, tool calls, and tool results.
 *
 * Architecture: one listener handles all event types for a unified per-step
 * card. No race conditions between separate listeners.
 *
 * Event flow per step:
 *   assistant/chunk (reasoning-delta, text-delta)  → accumulate
 *   assistant/message                              → send card with reasoning + text
 *   tool/call                                      → update card: append tool info
 *   tool/result                                    → update card: append tool result
 *
 * @module @starxer/chatterbox4dsh/feishu-streaming
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HarnessConversationService } from './harness.ts'
import { autoTurnTrigger, foldTurnTrigger, type AutoTurnTrigger, type TurnTriggerState } from './feishu-turn-origin.ts'
import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import { translationsFor } from './i18n.ts'
import type { DetachedJobNotice } from './feishu-jobs.ts'
import { expandAssistantStream, isTokenDelta, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { chunkText, truncateInline } from './text-chunk.ts'
import { OUTBOUND_TIMEOUT_MS, describeError, settleWithin, withTimeout } from './outbound-timeout.ts'
import { errorText } from './error-text.ts'
import type { CardImageHydrator } from './card-images.ts'
import {
  DETAILED_POLICY, REASONING_HEAD_CAP, REASONING_PREVIEW_CAP,
  resolveDisplayPolicy, type DisplayPolicy, type TranscriptView,
} from './display-level.ts'
import { injectionNotice } from './injection-notice.ts'
import { pendingProducedCall, producedArtifacts, settleProducedCall, type ProducedPath } from './produced-files.ts'
import { compactCompletionLines, compactCompletionTitle, appendCompletionFooter } from './turn-summary.ts'
import type { ProduceCardMode } from './config.ts'
import { foldedPanel } from './card-fold.ts'
import { createCompactionCards, summaryText, type CompactionFacts } from './feishu-compaction.ts'
import { createProgressCards, PROGRESS_MAX_DETAILS } from './feishu-progress.ts'
import { shellPrograms } from './shell-programs.ts'

// Re-exported for the callers that already import it from this module.
export { shellPrograms }
import type { CardInterleave } from './card-interleave.ts'

/** Minimal logger surface. */
interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Source of the current bridge. */
interface BridgeHolder {
  current: HarnessConversationService | undefined
}

/** Channel adapter for sending and updating cards. */
export interface FeishuStreamingChannel {
  send(to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  /**
   * CardKit instance path, preferred for step cards. `im.v1.message.patch`
   * (behind {@link updateCard}) caps at roughly 20 edits per message and then
   * silently disables the card, which a long tool-heavy step can exceed; a
   * card instance updated through `cardkit.v1.card.update` has no such cap.
   * Optional so tests and non-web deployments fall back to send + patch.
   */
  createCardInstance?(card: object): Promise<string>
  sendCardByReference?(to: string, cardId: string, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCardInstance?(cardId: string, card: object, sequence: number): Promise<void>
  /**
   * Register a callback the channel awaits before it posts any other card or
   * text to a chat. Streaming uses it to flush a step card that is still
   * inside its coalescing window, so a card raised by that step's own tool
   * call (question / approval) cannot overtake it. Optional so tests and
   * non-web deployments keep the plain send path.
   */
  registerPendingCardFlush?(flush: (chatId: string) => Promise<void>): void
  /**
   * Post a step card WITHOUT the pre-send flush registered above — the send
   * used for the step card's own message when no CardKit reference is
   * available. That flush ends by awaiting this chat's step-card send chain,
   * which holds the very promise this send is inside, so going through
   * {@link send} would make the card wait for itself (2026-09-24). Optional so
   * tests and non-web deployments keep the plain send path.
   */
  sendStepCard?(to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
}

/**
 * Identity of one sent step card. `cardId` is present only on the CardKit
 * instance path; otherwise the card is updated through `messageId` + patch.
 * `sequence` is the monotonic counter `cardkit.v1.card.update` requires.
 */
interface StepCardRef {
  /** Owning session, so confirmations can be attributed without a lookup. */
  sessionId: string
  messageId: Promise<string | undefined>
  cardId: Promise<string | undefined>
  sequence: number
  /**
   * Turn / step this card renders, captured at send time so a stale-card notice
   * can name the card without reading state that `resetStep` already cleared.
   */
  turn: number
  step: number
  /**
   * Reason the most recent write attempt failed. Cleared by the next successful
   * write — an error that a later update fixes is NOT a stale card.
   */
  staleReason: string | undefined
  /** Whether this card's staleness was already reported (one notice per card). */
  staleNotified: boolean
  /** Confirmation timer armed by a failed write; cancelled by a later success. */
  staleTimer: ReturnType<typeof setTimeout> | undefined
}

/**
 * How long a card may wait for the PREVIOUS card's message before giving up on
 * it and posting anyway.
 *
 * Waiting keeps the chat's card order intact, but an unbounded wait is what
 * used to freeze a whole chat (key pitfall 29). One full chained send is a
 * barrier wait plus an instance create plus a message create, so this bound is
 * deliberately wider than a single {@link OUTBOUND_TIMEOUT_MS}.
 */
const CHAIN_TIMEOUT_MS = OUTBOUND_TIMEOUT_MS * 2 + 5_000

/**
 * Last-resort bound on `flushed()`.
 *
 * It normally resolves when the turn's final card and its overflow cards are
 * on screen. It is only ever reached through a bug, and resolving late is far
 * better than never: the caller posts the Turn Complete footer afterwards.
 */
const FLUSH_TIMEOUT_MS = 120_000

/** Public deps for the unified per-step module. */
export interface FeishuStreamingDeps {
  ctx: Context
  channel: FeishuStreamingChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
  /** Whether to show reasoning content. */
  showReasoning?: () => boolean
  /** Whether to show tool calls at all; false hides the section and suppresses tool-only cards. */
  showToolCalls?: () => boolean
  /** Whether to show each tool call's arguments block. */
  showToolArgs?: () => boolean
  /** Whether to show each tool call's result preview. */
  showToolResults?: () => boolean
  /**
   * The work-detail level (`transcriptView`), read live. Together with the four
   * switches above it resolves to the {@link DisplayPolicy} every render uses
   * (see display-level.ts): the level sets the baseline and each switch can
   * only take detail away.
   */
  transcriptView?: () => TranscriptView
  /**
   * Live `produceCard` setting. `compact` prints the count of files the turn
   * produced without `present` in the summary it folds into the answer card
   * (`src/turn-summary.ts`); at every other level `channel.ts` owns that line.
   * Omitted (or `off`) keeps the count out of the summary.
   */
  produceCard?: () => ProduceCardMode
  /** Current translations for the user's language. */
  getTranslations?: () => Translations
  /**
   * Forward every tool result to the job mirror, which posts a card only for
   * the background jobs the model was handed a handle for (关键坑 37).
   * Optional: tests and deployments without the mirror simply never call it.
   */
  noteDetachedJob?: (notice: DetachedJobNotice) => void
  /**
   * Make the images a card's markdown points at render inline: resolve each
   * path inside the session's workspace, upload it, and substitute the returned
   * Feishu image key. Best-effort and bounded by the implementation — the card
   * is written with whatever came back, and references it could not resolve stay
   * text (see `card-images.ts`). Optional so tests need no filesystem.
   */
  hydrateImages?: CardImageHydrator
  /**
   * Resolve the media of the text being streamed WITHOUT writing a card, so the
   * uploads (image / video / audio) are already done when the card that carries
   * them is written. Fire-and-forget and safe to call on every delta: the
   * implementation debounces nothing, deduplicates in-flight uploads and never
   * rejects. Optional so tests need no filesystem.
   */
  warmImages?: (card: object, scope: { sessionId?: string }) => void
  /**
   * "Another module posted a card into this chat" (`src/card-interleave.ts`).
   * The compact turn card uses it to end one segment and continue in a new card
   * below the interruption. Optional: without it, that card just keeps updating
   * in place.
   */
  interleave?: CardInterleave | undefined
}

/** Per-step usage from assistant/message event. */
interface StepUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
  /** Full-call billed total (prompt + output) when the adapter reports it. */
  totalTokens?: number | undefined
  /** Reasoning (thinking) tokens, a subset of {@link outputTokens}, when reported. */
  reasoningTokens?: number | undefined
}

/**
 * One file the model declared as a deliverable through DSH's own `present`
 * tool (`deliverables/presented`). Paths arrive exactly as the model wrote
 * them — usually relative to the session cwd.
 */
export interface PresentedFile {
  path: string
  description?: string
}

/** Aggregated turn stats for the Turn Complete card. */
export interface TurnStats {
  turnStartTime: number
  stepCount: number
  toolCallCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  /** Sum of per-call billed totals (input + cache + output). Matches Web UI's "consumed". */
  totalBilledTokens: number
  firstStepTtftMs: number | null
  /** Sum of (firstToken → message) across steps — pure LLM decode time for throughput. */
  totalDecodeMs: number
  /**
   * Output tokens of the SAME steps counted in {@link totalDecodeMs}. Kept
   * separate from {@link totalOutputTokens}: a step whose first token could
   * not be timed (no token delta) has no decode time, and counting its tokens
   * in the throughput numerator without its decode time inflates tok/s. The
   * Web UI pairs the two the same way.
   */
  totalDecodeTokens: number
  /** Sum of (stepStart → assistant/message) across steps — LLM-only time. */
  totalStepMs: number
  /** Sum of tool elapsed times. */
  totalToolMs: number
  /** Full wall-clock turn duration (turnStart → turnEnd), includes LLM + tools + gaps. */
  totalTurnMs: number
  /**
   * Files this turn declared as final deliverables (DSH's `present` tool, via
   * the `deliverables/presented` event). Listed on the Turn Complete card and
   * deliberately NOT pushed to the chat: Feishu has no workspace browser, so
   * the list is the whole surface, and a file is sent only when the user
   * actually asks for it (`feishu_send_file`).
   */
  deliverables?: PresentedFile[]
  /**
   * Files this turn WROTE without declaring them (`write` / `edit` /
   * `str_replace_editor` whose result was not an error) — the host-side mirror
   * of the WebUI's `produced` set, in the order the results landed.
   *
   * The `produceCard` setting decides what happens to them
   * (`src/produced-files.ts`): nothing, a count line, or delivery of the
   * artifact-shaped subset through the `present` pipeline.
   */
  produced?: ProducedPath[]
}

/** One tool call tracked within a step. */
interface StepToolCall {
  toolName: string
  callId: string
  arguments?: unknown
  startedAt: number
  /** Set when tool/result arrives. */
  result?: { isError: boolean; content: string; elapsed: number }
  /** Tool presentation view from the mux frame (presentCall/presentResult). */
  callView?: { card?: string; title?: string; description?: string; workdir?: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resultView?: any
  /**
   * What this call would produce if it succeeds (`produced-files.ts`), computed
   * at `tool/call` time because the RESULT does not carry the arguments. Absent
   * for every call that is not a file mutation.
   */
  produced?: { path: string | undefined }
}

/** Per-session state for accumulating a step's content. */
/**
 * Narrow view of the transient assistant-stream publication. Declared locally
 * rather than imported so a minor DSH release that widens the payload type
 * cannot break this module's typecheck (the same reason the subagent roster
 * declares its lifecycle events locally).
 */
interface AssistantStreamSource {
  on(
    name: 'agent/assistant-stream',
    listener: (this: unknown, payload: unknown) => void,
    options: { global: true },
  ): () => void
}

/**
 * Live phase of one model call, driven by the TRANSIENT
 * `agent/assistant-stream` publication (O20).
 *
 * - `none` — only `step/start` has arrived: DSH has not dispatched a request
 *   yet, so anything that says "thinking" here is a lie.
 * - `awaiting` — the attempt's `start` frame landed: the request is out and the
 *   provider has not returned a token.
 * - `thinking` — the first `reasoning-delta` arrived; the model really started
 *   to reason.
 * - `replying` — the first `text-delta` arrived.
 *
 * Only a card with no visible content reads this (the placeholder), so a step
 * whose content already landed is unaffected by late frames.
 */
type StepLivePhase = 'none' | 'awaiting' | 'thinking' | 'replying'

interface SessionStepState {
  /**
   * The session this state belongs to. Kept on the state (not just passed
   * around) because `updateStepCard` runs from several event branches and must
   * be able to report "this session's text is on screen" — see
   * {@link noteStepCardText}.
   */
  sessionId: string
  /** Accumulated reasoning from reasoning-delta chunks. */
  reasoning: string
  /** Accumulated text from text-delta chunks. */
  text: string
  /** Tool calls in the current step (ordered). */
  toolCalls: StepToolCall[]
  /** Whether a step card has been sent for the current step. */
  stepCardSent: boolean
  /** Sent step card identity (message id + optional CardKit instance). */
  stepCardRef: StepCardRef | undefined
  /**
   * Whether this step's `step/end` already arrived. A card that never got any
   * visible content must stop claiming to think once the step is over.
   */
  stepEnded: boolean
  /**
   * Tick that refreshes the thinking placeholder's elapsed time. Cleared at
   * every step/turn boundary and on dispose, so it can never leak.
   */
  placeholderTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Debounced media warm-up for the current step's text (see
   * {@link warmStepMedia}). Cleared wherever the step's text is cleared, so a
   * stale timer can never upload for a step that is already over.
   */
  warmTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Debounced-but-not-yet-sent first card for the current step. While this is
   * set, `stepCardSent` is already true but `stepCardRef` is still undefined,
   * so later events skip the update path — the pending send rebuilds the card
   * from the latest state and posts it once (see `queueStepCardSend`).
   */
  pendingSend: {
    chat: ConversationMessage
    sessionId: string
    timer: ReturnType<typeof setTimeout>
  } | undefined
  /** Chat info for the current step. */
  chat: ConversationMessage | undefined
  /**
   * Offset into {@link text} where THIS card's segment starts, set when another
   * module posts a card after the one on screen (`src/card-interleave.ts`).
   * Under `compact` the answer card then stops growing: the next content opens a
   * new card carrying only what arrived after the interruption. `undefined`
   * means "this step has had no interruption".
   */
  supersededFrom: number | undefined
  /**
   * Context-injection notice lines claimed by the CURRENT step, rendered at the
   * very top of its card. Per-step: `resetStep` clears them, because an
   * injection belongs to the request it precedes (see §1.5 of the parity
   * design). Injections that arrive BEFORE `step/start` wait in
   * {@link pendingInjections} and are moved in here by the `step/start` branch.
   */
  injections: string[]
  /** Whether the last assistant/message sent a step card with content. */
  lastStepHadContent: boolean
  // --- Timing fields (event.time from mux stream) ---
  stepStartTime: number
  firstTokenTime: number
  /** 1-based turn / step numbers of the current step (from `step/start`). */
  turnNumber: number
  stepNumber: number
  /** First / last reasoning-delta timestamps of the current step. */
  reasoningStartTime: number
  reasoningEndTime: number
  /** Time of assistant/message event (LLM inference complete). */
  messageTime: number
  /** Time of last tool/result or assistant/message (step fully complete). */
  completedTime: number
  usage: StepUsage | undefined
  /** Context window info for the current session (fetched once per turn). */
  contextMeta: { contextWindow: number; lastInputTokens: number } | undefined
  /**
   * The Feishu-side equivalent of the Web UI's "turn triggered by"
   * attribution: DSH wakes an idle owner with `followup(notice)` (the notice is
   * the turn's trigger) and injects into a busy one instead, so the trigger is
   * decided from which messages the turn claimed (see `foldTurnTrigger`).
   */
  /** Family of non-human message that opened this turn, if any. */
  turnTrigger?: AutoTurnTrigger | undefined
  /** Whether a human message was claimed in this turn. */
  sawHumanMessage: boolean
  /**
   * Live phase of the current step's model call (see {@link StepLivePhase}).
   * Reset at every step boundary; only the content-free placeholder renders it.
   */
  livePhase: StepLivePhase
  /**
   * Last route this session reported (`request/context`), shown on the awaiting
   * card. Deliberately NOT cleared per step: DSH appends that event only when
   * the route changes, so clearing it would blank the route on every later step.
   */
  requestRoute: { provider: string; model: string } | undefined
  /**
   * Reasoning effort of the last request header this session reported. Turn
   * scope is enough: the compact completion footer names the effort of the
   * route that answered, and `request/header` is appended whenever the route is
   * established or changed.
   */
  requestEffort: string | undefined
  /**
   * The route this session is RECORDED to run (`bridge.getSessionMeta`, which
   * prefers the session log's latest `request/header` over any in-memory
   * default): the fallback the completion footer names when this plugin instance
   * never saw a `request/header` itself.
   *
   * That gap is real and was reported (2026-10-15): DSH appends `request/header`
   * only on initial / resume / change / new series, so a plugin that was re-mounted
   * mid-session (HMR reload, or any future reload) knows no route while the host
   * agent it mirrors never restarted — the footer then silently lost its
   * `🧠 model · 💡 effort` line. Session scope, refreshed at every `turn/start`.
   */
  sessionRoute: { model: string; reasoningEffort: string } | undefined
  /**
   * The compact completion summary to render into the answer card's footer at
   * `turn/end` (see `src/turn-summary.ts`). Set on the turn's last step, before
   * the final write is built, so that write carries it.
   */
  completionLines: string[] | undefined
  /**
   * The completion TITLE (`✅ 完成 · 2m14s`) that goes with those lines: this card
   * is the one that ends the turn, and the title is where a reader scrolling the
   * chat sees that — plus the clock, which the footer line therefore no longer
   * repeats. Set beside {@link completionLines}, cleared with it.
   */
  completionTitle: string | undefined
  /**
   * Every path this SESSION has ever declared through `present`.
   *
   * Not turn-scoped on purpose: the produced-artifact delivery must not hand a
   * file over a second time just because the model wrote it once more in a
   * later turn — the `present` declaration that already delivered it may be
   * arbitrarily far back, while a turn's own `deliverables` list starts empty.
   * Only ever consulted to SUPPRESS a delivery, so one entry per session is
   * enough and unbounded growth is not a concern (a presented path is rare, and
   * the session's own log holds the authoritative list anyway).
   */
  everPresentedPaths: Set<string>
  // --- Turn-level aggregation ---
  turnStats: TurnStats | undefined
}

export function startFeishuStreaming(deps: FeishuStreamingDeps): {
  stop: () => void
  consumeReasoning: (sessionId: string) => string | undefined
  consumeLastStepHadContent: (sessionId: string) => boolean
  flushed: (sessionId: string) => Promise<TurnStats | undefined>
} {
  const { ctx, channel, bridgeHolder, logger, showReasoning, showToolCalls, showToolArgs, showToolResults, transcriptView, getTranslations, noteDetachedJob, hydrateImages, warmImages, interleave, produceCard: produceCardMode } = deps
  console.log('dsh-feishu: startFeishuStreaming (unified per-step cards)')
  const sessionStates = new Map<string, SessionStepState>()

  /**
   * Injection notice lines that arrived BEFORE the step which will claim them.
   *
   * Session-scoped on purpose. `resetStep` runs at `step/start`, so a field on
   * the step state would be wiped by the very event that opens the card the
   * injection belongs on: 6.8% of injections (177/2589, measured) land in the
   * gap before `step/start` — they are the plugin/skill re-injections a
   * compaction transaction performs — and turning them into step state at the
   * wrong moment would silently drop exactly those.
   */
  const pendingInjections = new Map<string, string[]>()

  /**
   * The compaction card writer. A compaction happens BETWEEN steps, so it never
   * interleaves with a step card's own writes; it shares the channel only.
   */
  const compactionCards = createCompactionCards({
    channel,
    logger,
    getTranslations: () => getTranslations?.() ?? translationsFor('zh'),
    ...(interleave === undefined ? {} : { interleave }),
  })

  /**
   * The turn progress card (`compact` level only, see `feishu-progress.ts`).
   *
   * It is a SECOND card for the turn, not a replacement for the step cards: the
   * step cards still carry the answer, while this one carries the tool timeline
   * (names + durations per step) that `compact` otherwise reduces to a count.
   * It opens lazily on the first tool call, so a tool-free turn never shows it.
   */
  const progressCards = createProgressCards({
    channel,
    logger,
    getTranslations: () => getTranslations?.() ?? translationsFor('zh'),
    ...(interleave === undefined ? {} : { interleave }),
  })

  const getState = (sessionId: string): SessionStepState => {
    let state = sessionStates.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        reasoning: '',
        text: '',
        toolCalls: [],
        stepCardSent: false,
        stepCardRef: undefined,
        supersededFrom: undefined,
        stepEnded: false,
        placeholderTimer: undefined,
        warmTimer: undefined,
        pendingSend: undefined,
        chat: undefined,
        lastStepHadContent: false,
        stepStartTime: 0,
        firstTokenTime: 0,
        turnNumber: 0,
        stepNumber: 0,
        reasoningStartTime: 0,
        reasoningEndTime: 0,
        messageTime: 0,
        completedTime: 0,
        usage: undefined,
        contextMeta: undefined,
        injections: [],
        sawHumanMessage: false,
        turnTrigger: undefined,
        livePhase: 'none',
        requestRoute: undefined,
        requestEffort: undefined,
        sessionRoute: undefined,
        completionLines: undefined,
        completionTitle: undefined,
        everPresentedPaths: new Set<string>(),
        turnStats: undefined,
      }
      sessionStates.set(sessionId, state)
    }
    return state
  }

  const resetStep = (state: SessionStepState): void => {
    // A step can end inside the send debounce window (fast reasoning → tool →
    // result, then the next step/start). Post that card now, with the final
    // state, before clearing the fields it is built from.
    flushPendingSend(state)
    state.reasoning = ''
    state.text = ''
    state.toolCalls = []
    // An injection belongs to the request it precedes, so it dies with the step
    // that claimed it. The ones that arrived before `step/start` are held in
    // `pendingInjections` precisely so this clear cannot lose them.
    state.injections = []
    state.stepCardSent = false
    state.stepCardRef = undefined
    state.supersededFrom = undefined
    state.pendingSend = undefined
    state.stepEnded = false
    // The summary belongs to the turn, and the step that just ended has already
    // been written with it; a later step must not inherit it.
    state.completionLines = undefined
    state.completionTitle = undefined
    stopPlaceholderTick(state)
    stopWarmTimer(state)
    // NOTE: do NOT clear state.chat — it is session-level chat coordinates,
    // not per-step data. Clearing it prevents step 2+ from sending cards
    // when the step has only tool calls (no text/reasoning), causing tool
    // calls from different steps to appear merged on the previous step's card.
    state.stepStartTime = 0
    state.firstTokenTime = 0
    state.turnNumber = 0
    state.stepNumber = 0
    state.reasoningStartTime = 0
    state.reasoningEndTime = 0
    state.messageTime = 0
    state.completedTime = 0
    state.usage = undefined
    // The live phase belongs to ONE model call, not to the session: a step that
    // takes over must not inherit the previous call's phase.
    state.livePhase = 'none'
  }

  /**
   * The display policy in force right now: the work-detail level with the four
   * switches folded in (each switch can only take detail away).
   *
   * Read on every render rather than cached: every input is a `.volatile()`
   * settings reference, so a `/display` or WebUI change applies to the very next
   * card without remounting anything (关键坑 20 keeps them out of the connection
   * fingerprint for the same reason).
   */
  const displayPolicy = (): DisplayPolicy => resolveDisplayPolicy({
    transcriptView: transcriptView?.(),
    showReasoning: showReasoning?.(),
    showToolCalls: showToolCalls?.(),
    showToolArgs: showToolArgs?.(),
    showToolResults: showToolResults?.(),
  })

  /** Whether reasoning content is rendered on cards. */
  const reasoningShown = (): boolean => displayPolicy().reasoning !== 'off'

  /** Whether tool calls are rendered at all. */
  const toolsShown = (): boolean => displayPolicy().tools !== 'off'

  /**
   * Whether this step has anything visible to render. A step whose only
   * output is tool calls posts NO card while tool display is off — an empty
   * shell card would be pure noise. Text and reasoning always count when
   * their own toggle allows them.
   */
  const stepHasVisibleContent = (state: SessionStepState): boolean =>
    state.text.trim() !== ''
    || (reasoningShown() && state.reasoning.trim() !== '')
    || (toolsShown() && state.toolCalls.length > 0)

  /** Whether the step has nothing the card can render (yet, or at all). */
  const stepIsEmpty = (state: SessionStepState): boolean => !stepHasVisibleContent(state)

  /** Stop the placeholder's elapsed-time tick, if one is armed. */
  const stopPlaceholderTick = (state: SessionStepState): void => {
    if (state.placeholderTimer === undefined) return
    clearTimeout(state.placeholderTimer)
    state.placeholderTimer = undefined
  }

  /**
   * Keep a content-free step card's elapsed time honest: refresh it every
   * {@link PLACEHOLDER_TICK_MS} while the step still has nothing to show.
   *
   * The tick exists because DSH stopped publishing token deltas to the
   * persistent event bus (`assistant/chunk` is gone), so this module only sees
   * the reasoning once the whole message lands — without the tick a long
   * `high`/`max` thinking phase would sit on a frozen "0.2s". One chained
   * `setTimeout`, never `setInterval`, so a slow Feishu call cannot pile up
   * refreshes; every boundary (step/end, turn/end, resetStep, dispose) clears
   * it.
   */
  const startPlaceholderTick = (sessionId: string, state: SessionStepState): void => {
    if (state.placeholderTimer !== undefined) return
    const tick = (): void => {
      state.placeholderTimer = undefined
      const current = sessionStates.get(sessionId)
      if (current !== state || state.stepEnded || !stepIsEmpty(state)) return
      // While the first send is still in flight there is nothing to update:
      // the pending send rebuilds the card from this state anyway.
      if (state.stepCardRef !== undefined) updateStepCard(state)
      state.placeholderTimer = setTimeout(tick, PLACEHOLDER_TICK_MS)
    }
    state.placeholderTimer = setTimeout(tick, PLACEHOLDER_TICK_MS)
  }

  /** Build the unified card content for the current step state. */
  const buildStepCard = (state: SessionStepState): object => {
    // Attribution of an automatically started turn, named the way the Web UI
    // names it. Absent on a turn a human message opened.
    const turnTriggerNote = state.turnTrigger === undefined
      ? undefined
      : (getTranslations?.() ?? translationsFor('zh')).autoTurnTriggerName(state.turnTrigger)
    // Nothing to render yet (thinking placeholder) or ever (terminal empty
    // step): the card says so instead of showing a body with no content.
    const emptyPhase: 'thinking' | 'done' | undefined = stepHasVisibleContent(state)
      ? undefined
      : state.stepEnded ? 'done' : 'thinking'
    const showR = reasoningShown() && state.reasoning.trim() !== ''
    const reasoning = showR ? state.reasoning.trim() : undefined
    // An interruption ends this card's segment: the text up to `supersededFrom`
    // is already on the card above it (see `src/card-interleave.ts`).
    const visibleText = state.supersededFrom === undefined ? state.text : state.text.slice(state.supersededFrom)
    const text = visibleText.trim() !== '' ? visibleText.trim() : undefined
    // Hiding tool calls also drops the tool-derived title/status: a step that
    // only did tool work never renders, and a step with text renders as a
    // plain reply card with no trace of the tools behind it.
    const tools = toolsShown() ? state.toolCalls : []

    // Use real-time elapsed duration so the card always shows accurate time,
    // even while tools are still running.
    const stepDurationMs = state.stepStartTime > 0
      ? Date.now() - state.stepStartTime
      : undefined

    // Thinking time of this step: first reasoning delta → last reasoning
    // delta. Only shown once the reasoning has finished streaming (the card
    // is built after `assistant/message`, so that always holds).
    const reasoningMs = state.reasoningEndTime > state.reasoningStartTime
      ? state.reasoningEndTime - state.reasoningStartTime
      : undefined

    // Under `compact` the notices live on the turn card as soon as that card
    // exists, so this card carries them only when it does not (a turn with no
    // tool at all): a notice is shown exactly once, and no step card is ever
    // opened just to hold one.
    const shownInjections = state.injections.length === 0
      ? []
      : !displayPolicy().turnCard || !progressCards.hasCard(state.sessionId)
        ? state.injections
        : []

    return renderStepCard(
      getTranslations?.() ?? translationsFor('zh'),
      reasoning,
      text,
      tools,
      state.usage,
      stepDurationMs,
      computeStepTps(state),
      state.contextMeta,
      reasoningMs,
      state.turnNumber > 0 ? state.turnNumber : undefined,
      state.stepNumber > 0 ? state.stepNumber : undefined,
      {
        ...(emptyPhase !== undefined ? { empty: emptyPhase } : {}),
        // The resolved level+switches. No `showToolArgs`/`showToolResults` pair
        // is passed: those two are part of the policy now, and having two ways
        // to say the same thing is how a renderer starts disagreeing with the
        // settings page.
        display: displayPolicy(),
        ...(shownInjections.length > 0 ? { injections: shownInjections } : {}),
        ...(turnTriggerNote === undefined ? {} : { turnTriggerNote }),
        // The live phase only has meaning on the content-free form; passing it
        // alongside content would let a stale phase name a settled card.
        ...(emptyPhase === 'thinking' ? { phase: state.livePhase } : {}),
        ...(state.requestRoute !== undefined ? { route: state.requestRoute } : {}),
        // The turn's filtered summary, on the LAST write of the turn only
        // (`compact`; see the `turn/end` handler and `src/turn-summary.ts`).
        ...(state.completionLines === undefined ? {} : { completionLines: state.completionLines }),
        ...(state.completionTitle === undefined ? {} : { completionTitle: state.completionTitle }),
      },
    )
  }

  /**
   * Output speed of the current step: output tokens ÷ LLM decode time (first
   * token → assembled message). TTFT and tool time are excluded — the same
   * semantics as the Turn Complete card and /status. Only computed once the
   * assembled message's timestamp is known: falling back to Date.now() would
   * keep growing while tools run and show a misleadingly low tok/s on every
   * refresh. Returns undefined when the step has no usable timing (then the
   * card simply omits the speed).
   */
  const computeStepTps = (state: SessionStepState): number | undefined => {
    if (state.usage === undefined || state.usage.outputTokens <= 0) return undefined
    if (state.firstTokenTime <= 0 || state.messageTime <= state.firstTokenTime) return undefined
    const decodeMs = state.messageTime - state.firstTokenTime
    return decodeMs > 0 ? state.usage.outputTokens / (decodeMs / 1000) : undefined
  }

  /**
   * Per-chat chain of step-card message creations. Each card's message is
   * only created after the previous card's message exists, so step cards keep
   * their chat order even when Feishu's CardKit create/send takes longer than
   * the gap between two fast steps (observed 2026-09-09: a later card
   * overtaking an earlier one).
   */
  const lastCardSendByChat = new Map<string, Promise<unknown>>()

  /**
   * Mark the session's text as already on screen in a step card, so channel.ts
   * sends only the Turn Complete footer instead of a second card carrying the
   * same text.
   *
   * Called from BOTH card paths. A card is commonly opened by a `tool/call`
   * while the step's text is still empty (the tool runs for seconds), and the
   * text only reaches the screen through a later update — that case must count
   * exactly like a card posted with the text already present, otherwise
   * channel.ts takes its "nothing was shown" branch and posts a duplicate
   * reply card (and loses the Turn Complete card with its deliverables and
   * metrics along the way).
   *
   * The mark is OPTIMISTIC — it is set as soon as the card carrying the text
   * is handed to Feishu, not after Feishu confirms it. That is deliberate: the
   * confirmation could arrive arbitrarily late (or never), and channel.ts reads
   * the flag right after `flushed()`. The correction for a card that never
   * made it is {@link ../../channel.ts}'s pair of the delivered-text record +
   * `clearIntermediateSent`, applied at `flushed()` — see key pitfalls 29 and 45.
   */
  const noteStepCardText = (sessionId: string, state: SessionStepState): void => {
    if (state.text.trim() === '') return
    bridgeHolder.current?.markIntermediateSent(sessionId)
  }

  /**
   * Order of the writes that carried assistant text this turn, per session.
   *
   * Content order, not completion order: every card is stamped when it is BUILT
   * (a card built later renders newer text), and a stamp is only recorded once
   * that card's write actually ran. `flushed()` compares the newest stamp that
   * landed with the newest one that was refused — if a refused stamp is ahead,
   * the chat is rendering text older than the turn's answer and channel.ts must
   * post the reply itself.
   *
   * A plain "some text landed" boolean is not enough: a turn whose first step
   * landed and whose LAST step was refused used to look delivered, so
   * channel.ts sent the footer alone and the final answer was silently gone
   * while its card kept rendering "🧠 深度思考中" (2026-09-24, key pitfall 45).
   *
   * Turn-scoped on purpose: `resetStep` runs on every step, so a field on the
   * session state would be wiped mid-turn.
   */
  const turnTextOrder = new Map<string, { next: number; delivered: number; failed: number }>()

  /** Stamp a card that carries assistant text, in content order. */
  const stampTextCard = (sessionId: string): number => {
    const order = turnTextOrder.get(sessionId) ?? { next: 0, delivered: 0, failed: 0 }
    order.next += 1
    turnTextOrder.set(sessionId, order)
    return order.next
  }

  /**
   * Record that text from this turn genuinely reached the chat.
   *
   * Set on a CONFIRMED send (the message id came back) or a confirmed update —
   * never on the optimistic path (see {@link noteStepCardText}).
   */
  const noteTextDelivered = (sessionId: string, stamp: number): void => {
    const order = turnTextOrder.get(sessionId)
    if (order === undefined || stamp === 0) return
    order.delivered = Math.max(order.delivered, stamp)
  }

  /**
   * Record that a card carrying text was REFUSED, so what the chat renders is
   * older than that card. Only a later confirmed write can outrank it.
   */
  const noteTextWriteFailed = (sessionId: string, stamp: number): void => {
    const order = turnTextOrder.get(sessionId)
    if (order === undefined || stamp === 0) return
    order.failed = Math.max(order.failed, stamp)
  }

  /**
   * Resolve the card's local image references into Feishu image keys before the
   * card is written, so a picture the model referenced actually shows up in the
   * chat instead of degrading to text. Bounded and best-effort by the hydrator:
   * it never rejects, and whatever it could not resolve stays text.
   */
  const prepareCard = async (card: object, sessionId: string): Promise<object> => {
    if (hydrateImages === undefined) return card
    return hydrateImages(card, { sessionId }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      console.log(`dsh-feishu: [img] hydration failed for session ${sessionId}: ${reason}`)
      return card
    })
  }

  /**
   * Start resolving the media references of the text being streamed, long
   * before the card that will carry them is written.
   *
   * Uploading a clip takes seconds (and an ffmpeg pass can precede it), and the
   * write that carries the answer is the one thing the operator is waiting for,
   * so the work is moved into the model's own decode time. The warmer runs the
   * SAME pipeline as the card write — same mode, workspace scope, byte caps and
   * element budget — so nothing can be inlined here that the card would not have
   * inlined anyway; it only arrives earlier, and the shared cache plus the
   * in-flight map means the later write either finds a key or awaits the very
   * same upload instead of starting a second one.
   *
   * Deliberately debounced and fire-and-forget: a card write never waits on this,
   * and a step whose text is cleared drops its pending warm-up with it.
   */
  const warmStepMedia = (state: SessionStepState): void => {
    if (warmImages === undefined) return
    // Cheap gate: only `[](...)` destinations are ever resolved, so text without
    // one never needs a card built (this runs on every token delta).
    if (!state.text.includes('](')) return
    if (state.warmTimer !== undefined) clearTimeout(state.warmTimer)
    state.warmTimer = setTimeout(() => {
      state.warmTimer = undefined
      const text = state.text.trim()
      if (text === '') return
      // A throwaway one-element card: the warmer only reads markdown content, and
      // the step card renders just its first TEXT_STEP_CAP characters while the
      // overflow cards carry the rest — warming the whole text covers both.
      const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } }
      warmImages(card, { sessionId: state.sessionId })
    }, MEDIA_WARM_DEBOUNCE_MS)
  }

  /** Drop a step's pending media warm-up (its text is gone). */
  const stopWarmTimer = (state: SessionStepState): void => {
    if (state.warmTimer === undefined) return
    clearTimeout(state.warmTimer)
    state.warmTimer = undefined
  }

  /**
   * Post the step card immediately, built from the CURRENT state, and track
   * its identity. Only `queueStepCardSend` / `flushPendingSend` call this —
   * never the event handlers directly.
   */
  const actuallySendStepCard = (chat: ConversationMessage, sessionId: string, state: SessionStepState): void => {
    const card = buildStepCard(state)
    state.stepCardSent = true
    state.chat = chat
    noteStepCardText(sessionId, state)
    // Captured now: `state.text` is cleared by resetStep before the send may
    // resolve, and the confirmation below must judge THIS card's content.
    const cardHasText = state.text.trim() !== ''
    const textStamp = cardHasText ? stampTextCard(sessionId) : 0
    const opts = chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {}
    // Prefer a CardKit card instance: its update API has no edit cap, unlike
    // im.v1.message.patch, so a long step cannot silently kill the card.
    const useInstance = channel.createCardInstance !== undefined && channel.sendCardByReference !== undefined
    // One hydration for both transports: the instance create and the plain
    // send must carry the SAME card, images resolved.
    const prepared = prepareCard(card, sessionId)
    const cardId: Promise<string | undefined> = useInstance
      ? prepared.then(payload => channel.createCardInstance!(payload)).then((id) => {
        console.log(`dsh-feishu: [send] instance card=${id}`)
        return id
      }).catch((error: unknown) => {
        console.log(`dsh-feishu: [send] card instance create failed: ${describeError(error)}`)
        return undefined
      })
      : Promise.resolve(undefined)
    const sendMessage = (id: string | undefined): Promise<string | undefined> => {
      // An empty id means "no usable reference", not a reference:
      // `sendCardByReference('')` fails with `cardid is invalid`, and because
      // that failure is caught below without retrying another shape, the step
      // card used to go unposted entirely (the 2026-09-23 11:27 journal line).
      // `createCardInstance` now rejects an empty id as well; this is the
      // belt-and-braces half, so the plain send still happens either way.
      if (id !== undefined && id !== '') {
        return channel.sendCardByReference!(chat.chatId, id, opts).then((r) => {
          console.log(`dsh-feishu: [send] message=${r.messageId ?? '-'} via card=${id}`)
          return r.messageId
        }).catch((error: unknown) => {
          console.log(`dsh-feishu: [send] send by reference failed: ${describeError(error)}`)
          return undefined
        })
      }
      // The fallback send is the step card's OWN message, so it must not run
      // the channel's pre-send flush: that flush awaits this chat's step-card
      // send chain, which holds the promise this send is inside. Waiting on it
      // deadlocks until the channel's barrier timeout (60s) — the card lands a
      // minute late, every update scheduled in between is released in one
      // burst, and Feishu's per-message edit rate limit (`230020`) then refuses
      // the write carrying the answer, leaving the card on "深度思考中" after
      // the Turn Complete card was already posted (2026-09-24, key pitfall 45).
      // Ordering against the PREVIOUS step card is unaffected: `previousSettled`
      // below already awaited it before this send started.
      const post = channel.sendStepCard ?? channel.send
      return prepared.then(payload => post(chat.chatId, { card: payload }, opts)).then((r) => {
        console.log(`dsh-feishu: [send] message=${r.messageId ?? '-'} via ${channel.sendStepCard === undefined ? 'send' : 'own step card send'}`)
        return r.messageId
      }).catch((error: unknown) => {
        console.log(`dsh-feishu: [send] step card send failed: ${describeError(error)}`)
        logger.warn(`dsh-feishu: step card send failed: ${describeError(error)}`)
        return undefined
      })
    }
    // Reserve this card's place in the chat BEFORE the message is created:
    // wait for the previous card's message, then await this card's instance
    // (created in parallel above) and send it. A failed earlier send must not
    // stall the chain, hence the catch.
    //
    // The wait is also BOUNDED. An unbounded one used to freeze the chat: one
    // predecessor whose send never settled meant every later card was created
    // (an orphan CardKit instance) and never sent, and the turn's answer —
    // which only reaches the user by updating those cards — was lost with it
    // (2026-09-21, key pitfall 29). Giving up on the predecessor costs card
    // order; not giving up costs the answer.
    const previousSend = lastCardSendByChat.get(chat.chatId) ?? Promise.resolve()
    const previousSettled = settleWithin(
      previousSend,
      'wait for the previous step card',
      CHAIN_TIMEOUT_MS,
      reason => console.log(`dsh-feishu: [send] previous step card did not settle (${reason}); sending anyway`),
    )
    const messageId = previousSettled.then(() => cardId).then(sendMessage)
    // Confirm delivery once the message id is known. Registered before
    // `flushed()` awaits the same promise, so the flag is always set before
    // channel.ts reads it.
    void messageId.then((id) => {
      if (id !== undefined && cardHasText) noteTextDelivered(sessionId, textStamp)
    }).catch(() => undefined)
    lastCardSendByChat.set(chat.chatId, messageId.catch(() => undefined))
    state.stepCardRef = {
      sessionId, messageId, cardId, sequence: 0,
      turn: state.turnNumber, step: state.stepNumber,
      staleReason: undefined, staleNotified: false, staleTimer: undefined,
    }
    // Track the send promise so flushed() can wait for the final step card's
    // message to be created before the Turn Complete footer is sent.
    lastStepSendPromises.set(sessionId, messageId)
  }

  /**
   * Queue the step's FIRST card, debounced.
   *
   * A fast model can emit reasoning → tool/call → tool/result within a few
   * milliseconds. Sending the card at the first event and then updating it
   * would render the step twice (and burn two CardKit calls) for no reason,
   * so the first send is coalesced over {@link STEP_CARD_DEBOUNCE_MS}: the
   * timer fires once, builds the card from the state accumulated so far, and
   * posts a single card. Events arriving during the window need no update —
   * `stepCardRef` is still undefined, so `updateStepCard` is a no-op and the
   * pending send already carries the latest state.
   *
   * Slow tools are unaffected in practice: the card still appears ~150ms
   * after the step starts, showing `⏳ running…`, and the result update lands
   * when the tool finishes.
   */
  const queueStepCardSend = (chat: ConversationMessage, sessionId: string, state: SessionStepState): void => {
    if (state.stepCardSent || state.pendingSend !== undefined) return
    // Reserve the step's card now so a second event cannot queue another one.
    state.stepCardSent = true
    state.chat = chat
    state.pendingSend = {
      chat,
      sessionId,
      timer: setTimeout(() => {
        const pending = state.pendingSend
        if (pending === undefined) return
        state.pendingSend = undefined
        actuallySendStepCard(pending.chat, pending.sessionId, state)
      }, STEP_CARD_DEBOUNCE_MS),
    }
  }

  /** Post a queued-but-unsent card immediately (step boundary / turn end). */
  const flushPendingSend = (state: SessionStepState): void => {
    const pending = state.pendingSend
    if (pending === undefined) return
    clearTimeout(pending.timer)
    state.pendingSend = undefined
    actuallySendStepCard(pending.chat, pending.sessionId, state)
  }

  /**
   * Flush every step card still inside its coalescing window for one chat and
   * resolve once those cards' messages exist.
   *
   * Registered on the channel so ANY other outbound card/text to that chat
   * (the question/approval card raised by the step's own tool call, the
   * overflow "continued" cards at turn/end, the Turn Complete footer) is
   * posted AFTER the step card it follows. Without this a step card whose
   * first send is still debounced (or whose CardKit create+send is still in
   * flight) is overtaken by the card that logically comes later — observed
   * 2026-09-09: the question card landed before the step card that called
   * `ask_user_question`.
   */
  const flushPendingSendsForBarrier = async (chatId: string): Promise<void> => {
    for (const state of sessionStates.values()) {
      if (state.pendingSend !== undefined && state.pendingSend.chat.chatId === chatId) {
        flushPendingSend(state)
      }
    }
    // Await the per-chat chain, not just the flush: an earlier card may still
    // be having its message created.
    await lastCardSendByChat.get(chatId)
  }
  channel.registerPendingCardFlush?.(flushPendingSendsForBarrier)

  /**
   * Pending debounce entries keyed by the card ref they belong to.
   *
   * Keying by ref (not by session state) matters: one state object serves
   * every step of a session, so a state-keyed map would let step N+1's
   * scheduled update cancel step N's still-pending one — the earlier card
   * would then never receive its tool result and stay stuck on "running".
   * Each entry stores the card captured at schedule time, so a later
   * `resetStep` cannot corrupt it.
   */
  const pendingUpdates = new Map<StepCardRef, {
    timer: ReturnType<typeof setTimeout>
    /**
     * The render to write, captured at schedule time: `state.text` may be
     * cleared by `resetStep` before the timer fires, and a confirmed update
     * that carries text is what proves the answer reached the chat.
     */
    write: PendingWrite
  }>()

  /** Flush promises: resolved by turn/end after the final card update. */
  const flushPromises = new Map<string, { promise: Promise<void>; resolve: () => void }>()

  /**
   * The most recent step-card `send` promise per session. `flushed()` awaits
   * it so the Turn Complete footer is only sent AFTER the final step card's
   * message was created — otherwise the footer can race ahead of the last
   * step card and appear before it in the chat.
   */
  const lastStepSendPromises = new Map<string, Promise<string | undefined>>()

  /**
   * Step-card UPDATE promises still in flight, per session.
   *
   * `flushed()` reads the delivered-text record to decide whether the turn's
   * answer is already on screen. That read is only meaningful once every write that could
   * carry the text has finished: a write that is still in flight would be judged
   * as "never reached Feishu", the optimistic mark would be withdrawn, and
   * channel.ts would post a full reply card next to the step card that is about
   * to receive exactly the same text.
   *
   * The window used to be sub-second (the debounce is 150ms), so the race was
   * theoretical; card media hydration (2026-09-24) made one write take SECONDS
   * (a video upload), and the duplicate reply became reproducible — observed as
   * "a second reply card after the reply" while the step card's own update
   * landed with the same text a moment later. `flushPendingUpdate` only covers
   * the write that is still INSIDE the debounce window; this covers the one
   * whose timer already fired.
   */
  const inFlightUpdates = new Map<string, Set<Promise<void>>>()

  /**
   * Run one step-card write, keeping it visible to {@link flushed} for as long
   * as it is in flight (and never rejecting: every caller is fire-and-forget).
   *
   * @param sessionId - the session whose turn is being written.
   * @param run - the write to perform.
   * @returns the tracked promise.
   */
  const trackUpdate = (sessionId: string, run: () => Promise<void>): Promise<void> => {
    const promise = run().catch(() => undefined)
    let set = inFlightUpdates.get(sessionId)
    if (set === undefined) {
      set = new Set()
      inFlightUpdates.set(sessionId, set)
    }
    set.add(promise)
    void promise.finally(() => {
      const current = inFlightUpdates.get(sessionId)
      if (current === undefined) return
      current.delete(promise)
      if (current.size === 0) inFlightUpdates.delete(sessionId)
    })
    return promise
  }

  /** Turn stats per session, stored independently of flush promise timing. */
  const turnStatsMap = new Map<string, TurnStats>()

  /**
   * Confirmation timers armed by a failed card write. Tracked so `stop()` can
   * cancel them: a notice must never be posted after the plugin is disposed.
   */
  const staleTimers = new Set<ReturnType<typeof setTimeout>>()

  /**
   * Report that a step card could not be updated any more: every write after the
   * failure was skipped or failed too, so the card keeps rendering content older
   * than this step's state — the "card stuck on 🧠 深度思考中 while the step is
   * long done" symptom reported 2026-09-23, whose only trace used to be a
   * journal line (`[update] failed`, 15 of them in the 7 days to 2026-09-23).
   *
   * Deliberately a PLAIN TEXT message, not a card:
   * - what is being reported is that a card could not be written, so answering
   *   with another card is the one shape that can fail the same way;
   * - a text message is not parsed as markdown, so no reason string can be
   *   rejected for carrying image/link syntax (key pitfall 39);
   * - text allows a 150 KB body, five times a card's 30 KB, so the reason can be
   *   kept raw instead of truncated to fit a card element.
   *
   * At most one notice per card: {@link noteWriteLanded} clears the pending
   * reason, and `staleNotified` makes this idempotent.
   */
  const noteStaleCard = (ref: StepCardRef, reason: string): void => {
    if (ref.staleNotified) return
    ref.staleNotified = true
    const chat = sessionStates.get(ref.sessionId)?.chat
    if (chat === undefined) return
    const t = getTranslations?.() ?? translationsFor('zh')
    const opts = chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {}
    void channel.send(chat.chatId, { text: t.stepCardStaleNotice(ref.turn, ref.step, reason) }, opts)
      .catch((error: unknown) => {
        // Nothing left to fall back to: log and let the journal carry it.
        console.log(`dsh-feishu: stale card notice failed: ${describeError(error)}`)
        logger.warn(`dsh-feishu: stale card notice failed: ${describeError(error)}`)
      })
  }

  /**
   * Note that one write for this card failed. The notice is DEFERRED: a
   * transient failure (a dropped socket, a lost race) is usually followed by a
   * successful write within the next debounce window, and reporting those would
   * turn recovery into chat noise. Only a card whose failures outlive the
   * confirmation window is reported.
   */
  const noteWriteFailed = (ref: StepCardRef, error: unknown): void => {
    ref.staleReason = errorText(error, 'unknown error')
    if (ref.staleTimer !== undefined) return
    const timer = setTimeout(() => {
      staleTimers.delete(timer)
      ref.staleTimer = undefined
      if (ref.staleReason !== undefined) noteStaleCard(ref, ref.staleReason)
    }, STALE_CARD_CONFIRM_MS)
    ref.staleTimer = timer
    staleTimers.add(timer)
  }

  /** Note that a write landed: this card caught up, so drop any pending notice. */
  const noteWriteLanded = (ref: StepCardRef): void => {
    ref.staleReason = undefined
    if (ref.staleTimer === undefined) return
    clearTimeout(ref.staleTimer)
    staleTimers.delete(ref.staleTimer)
    ref.staleTimer = undefined
  }

  /**
   * Execute a card update (shared by debounce timer and flush).
   *
   * Resolves `true` only when Feishu CONFIRMED the write, so callers can tell
   * "the answer is on screen" from "we tried".
   */
  const executeCardUpdate = (
    ref: StepCardRef,
    card: object,
  ): Promise<boolean> =>
    prepareCard(card, ref.sessionId).then(prepared => executePreparedUpdate(ref, prepared))

  /** {@link executeCardUpdate} after the card's images were resolved. */
  const executePreparedUpdate = (
    ref: StepCardRef,
    card: object,
  ): Promise<boolean> => {
    // CardKit instance path: no edit cap, so a long step keeps updating.
    if (channel.updateCardInstance !== undefined) {
      return ref.cardId.then((cardId) => {
        if (cardId !== undefined) {
          // Serialize behind the message send. Feishu snapshots the card
          // entity when the referencing message is created: an update issued
          // before that message exists is NOT reflected in it, so the card
          // would keep rendering its create-time content forever (observed
          // 2026-09-08 — reasoning-only step cards whose tool call was lost,
          // and "⏳ running…" cards whose result was lost). Every update must
          // therefore wait for `ref.messageId`, not just for the card id.
          return ref.messageId.then((messageId) => {
            if (messageId === undefined) {
              console.log('dsh-feishu: [update] message not sent yet, skipping instance update')
              return false
            }
            ref.sequence += 1
            console.log(`dsh-feishu: [update] card=${cardId} seq=${ref.sequence}`)
            return channel.updateCardInstance!(cardId, card, ref.sequence).then(() => true)
          })
        }
        console.log('dsh-feishu: [update] no card instance, falling back to patch')
        return patchByMessageId(ref, card)
      }).catch((error: unknown) => {
        console.log(`dsh-feishu: [update] failed: ${describeError(error)}`)
        logger.warn(`dsh-feishu: step card update failed: ${describeError(error)}`)
        noteWriteFailed(ref, error)
        return false
      })
    }
    return patchByMessageId(ref, card)
  }

  /**
   * Fallback update path: im.v1.message.patch on the sent message. Resolves
   * `true` only when Feishu confirmed the patch.
   */
  const patchByMessageId = (ref: StepCardRef, card: object): Promise<boolean> => {
    return ref.messageId.then((messageId) => {
      if (messageId !== undefined) {
        console.log(`dsh-feishu: [update] patch message=${messageId}`)
        return channel.updateCard(messageId, card).then(() => true)
      }
      console.log('dsh-feishu: [update] messageId is undefined, skipping')
      return false
    }).catch((error: unknown) => {
      console.log(`dsh-feishu: [update] failed: ${describeError(error)}`)
      logger.warn(`dsh-feishu: step card update failed: ${describeError(error)}`)
      noteWriteFailed(ref, error)
      return false
    })
  }

  /**
   * One card render waiting to be written: what to write, plus the turn-scoped
   * stamp of the text it carries (see {@link turnTextOrder}).
   */
  interface PendingWrite {
    card: object
    hasText: boolean
    /** {@link stampTextCard} of this card; 0 when it carries no text. */
    stamp: number
  }

  /**
   * Per-card write slots: at most ONE write per card may be in flight, and a
   * render that arrives while it runs only remembers the LATEST card.
   *
   * Feishu answers a burst of edits to one message with `230020 This operation
   * triggers the frequency limit`. Serializing alone would just move the burst
   * one step back, so superseded renders are DROPPED instead of replayed: their
   * content is older than the card replacing them, and the one the operator is
   * waiting for — the render carrying the finished answer — is the last one.
   * That is what makes the burst harmless (2026-09-24, key pitfall 45).
   */
  const writeSlots = new Map<StepCardRef, {
    running: boolean
    /** The render waiting for the slot; only the newest is kept. */
    queued: { write: PendingWrite; resolve: (landed: boolean) => void } | undefined
  }>()

  /**
   * Write one card render and, when it lands carrying text, record that the
   * turn's answer really is in the chat.
   *
   * Resolves `true` only when Feishu confirmed THIS render; a render dropped as
   * superseded resolves `false` because its content never reached the card.
   */
  const applyPendingUpdate = (ref: StepCardRef, write: PendingWrite): Promise<boolean> =>
    executeCardUpdate(ref, write.card).then((landed) => {
      if (landed) {
        noteWriteLanded(ref)
        if (write.hasText) noteTextDelivered(ref.sessionId, write.stamp)
      } else if (write.hasText) {
        // The card keeps rendering older content, so the turn's answer is NOT
        // fully on screen even if an earlier write landed (key pitfall 45).
        noteTextWriteFailed(ref.sessionId, write.stamp)
      }
      return landed
    }).catch((error: unknown) => {
      console.log(`dsh-feishu: [update] timer callback error: ${describeError(error)}`)
      return false
    })

  /** {@link applyPendingUpdate}, serialized per card with latest-wins coalescing. */
  const scheduleCardWrite = (ref: StepCardRef, write: PendingWrite): Promise<boolean> => {
    let slot = writeSlots.get(ref)
    if (slot === undefined) {
      slot = { running: false, queued: undefined }
      writeSlots.set(ref, slot)
    }
    const current = slot
    if (current.running) {
      // Superseded before it was ever attempted: drop it (nothing is lost, its
      // content is older) and tell its caller the truth.
      current.queued?.resolve(false)
      return new Promise<boolean>((resolve) => { current.queued = { write, resolve } })
    }
    current.running = true
    return (async (): Promise<boolean> => {
      let item: { write: PendingWrite; resolve?: (landed: boolean) => void } = { write }
      let landed = false
      try {
        for (;;) {
          landed = await applyPendingUpdate(ref, item.write)
          item.resolve?.(landed)
          const next = current.queued
          if (next === undefined) break
          current.queued = undefined
          item = next
        }
      } finally {
        current.running = false
        if (current.queued === undefined) writeSlots.delete(ref)
      }
      return landed
    })()
  }

  /** Flush the pending debounce timer for a state, executing the updateCard immediately. */
  const flushPendingUpdate = (state: SessionStepState): Promise<void> => {
    const ref = state.stepCardRef
    if (ref === undefined) return Promise.resolve()
    const entry = pendingUpdates.get(ref)
    if (entry === undefined) return Promise.resolve()
    clearTimeout(entry.timer)
    pendingUpdates.delete(ref)
    console.log('dsh-feishu: [update] flushing pending update for turn/end')
    return trackUpdate(ref.sessionId, () => scheduleCardWrite(ref, entry.write).then(() => undefined))
  }

  /**
   * Close a step card whose segment an interrupting card ended. The next content
   * opens a new card carrying only what arrived since; nothing is written to the
   * old one any more.
   */
  const retireStepCard = (state: SessionStepState): void => {
    const chat = state.chat
    state.stepCardSent = false
    state.stepCardRef = undefined
    state.pendingSend = undefined
    stopPlaceholderTick(state)
    if (chat === undefined) return
    // Nothing NEW arrived since the interruption: posting an empty card would be
    // worse than leaving the retired one as the record of that step.
    if (state.text.slice(state.supersededFrom ?? 0).trim() === '') return
    queueStepCardSend(chat, state.sessionId, state)
  }

  /** Update the existing step card with current state (debounced). */
  const updateStepCard = (state: SessionStepState): void => {
    if (!state.stepCardSent || state.stepCardRef === undefined) {
      console.log(`dsh-feishu: [update] skipped: sent=${state.stepCardSent} ref=${state.stepCardRef !== undefined}`)
      return
    }
    if (state.supersededFrom !== undefined) {
      // Another module posted a card after this one: writing here would put the
      // newest line ABOVE it. Retire this card and let the content since the
      // interruption go out as a NEW card below (see `src/card-interleave.ts`).
      retireStepCard(state)
      return
    }
    // This update may be the moment the step's text first reaches the screen
    // (a tool call often opened the card before any text existed), so the
    // "text is on screen" note belongs here as well as on the send path.
    noteStepCardText(state.sessionId, state)
    // Capture the ref and card NOW — resetStep may clear state before the timer fires
    const ref = state.stepCardRef
    const card = buildStepCard(state)
    // Captured now for the same reason as the card itself: the confirmation
    // must judge what THIS update carries, not whatever state holds later.
    const hasText = state.text.trim() !== ''
    // Stamped with the card, i.e. in content order: this render may be replaced
    // by a newer one before it is written, and only the newest content counts.
    const write = { card, hasText, stamp: hasText ? stampTextCard(state.sessionId) : 0 }
    // Clear previous pending update for THIS card (a different card's pending
    // update must survive — see the map's comment).
    const existing = pendingUpdates.get(ref)
    if (existing !== undefined) clearTimeout(existing.timer)
    // Debounce: merge rapid updates into one
    pendingUpdates.set(ref, {
      write,
      timer: setTimeout(() => {
        pendingUpdates.delete(ref)
        void trackUpdate(ref.sessionId, () => scheduleCardWrite(ref, write).then(() => undefined))
      }, STEP_CARD_DEBOUNCE_MS),
    })
  }

  // session/event is the host's host-to-host fan-out. Filter on event.type
  // for step / turn / assistant / tool / request / context events; the
  // (session, event) callback receives the full session object (no sessionId
  // hop) and the event object directly (no envelope wrapper). Per-event
  // errors are caught so one bad event cannot take down the listener.
  //
  // Note: `tool/call` does NOT carry a presentation `view` field on the
  // event in 0.1.2-alpha.1 (apiproxy's `frame.view` is gone with the
  // package's deletion). `tool/result` does carry a tool-private `meta`
  // payload which we use as the result view when present. `toolCall.callView`
  // is therefore always undefined; `toolCall.resultView` is `event.data.meta`
  // when the tool attaches one.
  const handleEvent = (session: { id: string }, event: { type: string; time?: number; data?: any }): void => {
    try {
      const sessionId = session.id
      const bridge = bridgeHolder.current
      if (bridge === undefined) return
      const chat = bridge.resolveChat(sessionId)
      if (chat === undefined) return

      const state = getState(sessionId)

      if (event.type === 'assistant/chunk') {
        // Accumulate reasoning-delta and text-delta chunks.
        const chunk = event.data?.chunk
        if (chunk !== undefined && chunk !== null) {
          if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            state.reasoning += chunk.text
            // Record first token time for reasoning (TTFT anchor).
            if (state.firstTokenTime === 0) {
              state.firstTokenTime = event.time ?? Date.now()
            }
            if (state.reasoningStartTime === 0) state.reasoningStartTime = event.time ?? Date.now()
            state.reasoningEndTime = event.time ?? Date.now()
          } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            state.text += chunk.text
            // Start resolving any media the sentence references now, so the card
            // that carries the answer does not pay for the upload (pitfall 44).
            warmStepMedia(state)
            // Record first token time for text (if no reasoning came first).
            if (state.firstTokenTime === 0) {
              state.firstTokenTime = event.time ?? Date.now()
            }
          } else if (state.firstTokenTime === 0 && isTokenDelta(chunk)) {
            // Tool-call-only step: anchor on the first tool-call delta.
            state.firstTokenTime = event.time ?? Date.now()
          }
        }
      } else if (event.type === 'assistant/message') {
        // 0.1.3: `assistant/chunk` was removed; `assistant/message` now carries
        // the lossless compact stream. Rebuild text/reasoning from it FIRST and
        // use the first timed chunk as the TTFT anchor — the turn-stats
        // timing math below reads `state.firstTokenTime`, and in 0.1.3 this
        // rebuild is the only thing that sets it (no `assistant/chunk` events
        // exist to populate it ahead of time). Guarded on the stream being
        // present so older DSH versions (alpha.4, where chunks already
        // populated the state via the `assistant/chunk` branch) are unaffected.
        const rawStream = Array.isArray((event.data as { stream?: unknown })?.stream)
          ? (event.data as { stream: readonly AssistantStreamRecord[] }).stream
          : undefined
        if (rawStream !== undefined && state.reasoning === '' && state.text === '') {
          try {
            for (const timed of expandAssistantStream(rawStream)) {
              const chunk = timed.chunk
              if (state.firstTokenTime === 0 && isTokenDelta(chunk)) state.firstTokenTime = timed.time
              if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                state.reasoning += chunk.text
                if (state.reasoningStartTime === 0) state.reasoningStartTime = timed.time
                state.reasoningEndTime = timed.time
              } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                state.text += chunk.text
              }
            }
            // This rebuild is the only place older DSH versions give us the
            // text, so the warm-up has to be started from here too.
            warmStepMedia(state)
          } catch (streamError: unknown) {
            console.log(`dsh-feishu: [message] expandAssistantStream failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`)
          }
        }

        // The assembled message arrived. Record usage and message time.
        state.messageTime = event.time ?? Date.now()
        state.completedTime = state.messageTime
        // The attempt COMMITTED: whatever an abandoned attempt of this step had
        // streamed is now either a real call row or no longer the step's state,
        // so the "never ran" marker goes (2026-10-14, `ProgressStep.unrun`).
        if (displayPolicy().turnCard) {
          progressCards.stepAttempt(sessionId, state.stepNumber, [], state.messageTime)
        }
        const usage = event.data?.usage
        if (usage !== undefined && usage !== null) {
          state.usage = {
            inputTokens: (usage.inputTokens as number) ?? 0,
            outputTokens: (usage.outputTokens as number) ?? 0,
            cacheReadTokens: (usage.cacheReadTokens as number | undefined),
            cacheWriteTokens: (usage.cacheWriteTokens as number | undefined),
            totalTokens: (usage.totalTokens as number | undefined),
            reasoningTokens: (usage.reasoningTokens as number | undefined),
          }
        }
        if (state.usage !== undefined) {
          const billed = state.usage.inputTokens + (state.usage.cacheReadTokens ?? 0) + (state.usage.cacheWriteTokens ?? 0)
          if (billed > 0) {
            state.contextMeta = {
              contextWindow: state.contextMeta?.contextWindow ?? 0,
              lastInputTokens: billed,
            }
          }
        }

        if (state.turnStats !== undefined) {
          const ts = state.turnStats
          ts.stepCount++
          ts.toolCallCount += state.toolCalls.length
          if (state.usage !== undefined) {
            ts.totalInputTokens += state.usage.inputTokens
            ts.totalOutputTokens += state.usage.outputTokens
            ts.totalCacheReadTokens += state.usage.cacheReadTokens ?? 0
            ts.totalCacheWriteTokens += state.usage.cacheWriteTokens ?? 0
            // Billed total per call: the adapter's exact total when reported,
            // else uncached input + cache read/write + output (what the Web UI
            // derives and shows as "consumed").
            ts.totalBilledTokens += state.usage.totalTokens
              ?? state.usage.inputTokens
              + (state.usage.cacheReadTokens ?? 0)
              + (state.usage.cacheWriteTokens ?? 0)
              + state.usage.outputTokens
          }
          if (ts.firstStepTtftMs === null && state.firstTokenTime > 0 && state.stepStartTime > 0) {
            ts.firstStepTtftMs = state.firstTokenTime - state.stepStartTime
          }
          if (state.firstTokenTime > 0 && state.messageTime > state.firstTokenTime) {
            ts.totalDecodeMs += state.messageTime - state.firstTokenTime
            // Pair the numerator with the denominator: only tokens from steps
            // that contributed decode time count toward tok/s.
            ts.totalDecodeTokens += state.usage?.outputTokens ?? 0
          }
          if (state.stepStartTime > 0 && state.messageTime > state.stepStartTime) {
            ts.totalStepMs += state.messageTime - state.stepStartTime
          }
        }

        const hasContent = state.reasoning.trim() !== '' || state.text.trim() !== ''
        // A step that rendered nothing visible posts no card (see
        // `stepHasVisibleContent`). `lastStepHadContent` stays raw so it keeps
        // meaning "the model produced something", independent of display.
        //
        // `compact` reads one more fact before deciding: a message that calls
        // tools is PROCESS, so its text is this step's narration, not the turn's
        // answer (WebUI parity, see `messageCallsTools`). Posting it as a step
        // card would put prose the user reads as a reply next to the real answer
        // — the "middle reply" that used to arrive as its own card. It goes on
        // the turn card as one row instead. Injection notices are process too and
        // live on that same card, so they no longer force a step card here: a
        // step card under `compact` is the ANSWER, or nothing.
        const narration = displayPolicy().turnCard
          && state.stepNumber > 0
          && state.text.trim() !== ''
          && messageCallsTools(event)
        if (narration) {
          progressCards.stepNote(sessionId, state.stepNumber, state.text, state.messageTime)
        }
        if (stepHasVisibleContent(state) && !narration) {
          // Reuse this step's existing card when one is already on screen (a
          // tool call can open the card before the assembled message arrives,
          // and a step can emit more than one assistant/message). Sending a
          // second card here stranded the first: its tool stayed "running…"
          // forever and only the newest ref kept receiving results.
          if (state.stepCardSent) {
            console.log('dsh-feishu: [message] card already sent for this step → updating')
            updateStepCard(state)
          } else {
            queueStepCardSend(chat, sessionId, state)
          }
        }
        state.lastStepHadContent = hasContent
      } else if (event.type === 'assistant/attempt') {
        // The attempt did NOT commit — DSH appends this instead of
        // `assistant/message` when the stream died or the retries ran out, and
        // the loop never runs the calls such an attempt had started streaming.
        // It is therefore the ONLY place a step that killed the turn says what
        // it was doing: without it the compact card shows a bare `▸ 第 N 步`
        // beside a red title (2026-10-14, the user's report). Names only — the
        // arguments and the partial reasoning stay off `compact`.
        //
        // The row set is REPLACED per attempt and cleared by a commit or a real
        // `tool/call` (see `ProgressStep.unrun`), so a retry that works leaves
        // nothing behind.
        if (displayPolicy().turnCard) {
          const stream = Array.isArray((event.data as { stream?: unknown } | undefined)?.stream)
            ? (event.data as { stream: readonly AssistantStreamRecord[] }).stream
            : undefined
          if (stream !== undefined) {
            progressCards.stepAttempt(
              sessionId,
              (event.data?.step as number | undefined) ?? state.stepNumber,
              uncommittedToolNames(stream),
              event.time ?? Date.now(),
            )
          }
        }
      } else if (event.type === 'tool/call') {
        const toolCallId = String(event.data?.callId ?? '')
        const toolName = (event.data?.name as string) ?? 'unknown'
        const args = event.data?.arguments
        console.log(`dsh-feishu: [call] tool=${toolName} callId=${toolCallId} stepCardSent=${state.stepCardSent}`)

        const toolCall: StepToolCall = {
          toolName,
          callId: toolCallId,
          arguments: args,
          startedAt: Date.now(),
          // Whether this call mutates a file is decided from its ARGUMENTS, so
          // it has to be captured here: `tool/result` carries no arguments, and
          // the turn's produced list is rebuilt from these two events
          // (`src/produced-files.ts`).
          produced: pendingProducedCall(toolName, args),
        }
        // tool/call no longer carries a presentation view on the session
        // event; callView stays undefined and renderStepCard falls back to
        // the tool name and arguments.
        state.toolCalls.push(toolCall)
        // Mirror the call onto the turn progress card (`compact` only). The
        // card opens on this first call and is updated in place from here on.
        if (displayPolicy().turnCard) {
          // A real call answers the question the unrun marker asks — this step is
          // RUNNING its calls, not dying on them — so the marker goes first.
          progressCards.stepAttempt(sessionId, state.stepNumber, [], toolCall.startedAt)
          progressCards.toolStarted(
            sessionId,
            toolName,
            toolCallId,
            toolCall.startedAt,
            // The row's "what" (file / shell programs) is derived HERE because
            // this is where the arguments are; the card module only renders it.
            progressToolDetails(toolName, typeof args === 'string' ? args : JSON.stringify(args ?? '')),
          )
        }

        // With tool display off a tool call changes nothing on screen, so it
        // neither opens a card nor refreshes one.
        if (toolsShown()) {
          if (state.stepCardSent) {
            updateStepCard(state)
          } else {
            queueStepCardSend(chat, sessionId, state)
          }
        }
      } else if (event.type === 'tool/result') {
        const message = event.data?.message
        const content = message?.content
        const toolCallId = String(message?.toolCallId ?? message?.source?.callId ?? '')
        const toolCall = state.toolCalls.find(t => t.callId === toolCallId)
        console.log(`dsh-feishu: [result] callId=${toolCallId} found=${toolCall !== undefined} toolsInState=${state.toolCalls.length} stepCardSent=${state.stepCardSent}`)

        if (toolCall !== undefined) {
          // DSH 0.1.7 flattened the tool result into the message itself:
          // `{ role: 'tool', toolCallId, content, isError }` with `content`
          // already the block list the model saw. Before that it was a
          // user-role message whose single `tool-result` block held the real
          // `content` and `isError`, and reading the outer array directly
          // yielded nothing — which is why tool output had once disappeared.
          // Mirror the Web UI: read the message's own fields.
          const isError = event.data?.error !== undefined || message?.isError === true
          const resultContent = content
          const result = Array.isArray(resultContent)
            ? resultContent.map((b: { type: string; text?: string }) => b.type === 'text' ? b.text ?? '' : '').filter(Boolean).join('\n')
            : resultContent
          // A result that hands the model a background job id is the ONLY fact
          // that separates real background work from the foreground calls DSH
          // also registers as jobs (关键坑 37). Forward it to the job mirror,
          // which owns the matching and the gate.
          try {
            noteDetachedJob?.({
              toolName: toolCall.toolName,
              resultText: typeof result === 'string' ? result : '',
              chat,
              sessionId,
            })
          } catch (error: unknown) {
            console.log(`dsh-feishu: [result] job notification failed: ${describeError(error)}`)
          }
          const elapsed = Date.now() - toolCall.startedAt

          if (displayPolicy().turnCard) {
            progressCards.toolFinished(sessionId, toolCallId, elapsed, isError, event.time ?? Date.now())
          }

          // The turn's produced list (host-side mirror of the WebUI's
          // `produced` set): a file mutation whose result did not fail. The
          // `produceCard` setting is applied later, when the cards are built —
          // collecting is free and keeps both decisions in one place.
          const produced = settleProducedCall(toolCall.produced, isError)
          if (produced !== undefined && state.turnStats?.produced !== undefined) {
            state.turnStats.produced.push(produced)
          }

          toolCall.result = {
            isError,
            content: summarizeValue(
              result,
              displayPolicy().fullToolOutput ? RESULT_CONTENT_CAP_FULL : RESULT_CONTENT_CAP,
            ) || '',
            elapsed,
          }
          // tool/result carries a tool-private `meta` payload — the
          // presentResult view on 0.1.2-alpha.1. Use it as the result view
          // when present so the rich card rendering kicks in.
          if (event.data?.meta !== undefined) {
            toolCall.resultView = event.data.meta
          }

          // Only refresh an existing card when the result is actually visible;
          // with tool display off this step's card (if any) is text/reasoning
          // only and the result changes nothing on it.
          if (toolsShown() && state.stepCardSent) {
            updateStepCard(state)
          }
          state.completedTime = event.time ?? Date.now()
          if (state.turnStats !== undefined) {
            state.turnStats.totalToolMs += elapsed
          }
        }
      } else if (event.type === 'step/start') {
        resetStep(state)
        state.stepStartTime = event.time ?? Date.now()
        state.turnNumber = (event.data?.turn as number | undefined) ?? 0
        state.stepNumber = (event.data?.step as number | undefined) ?? 0
        if (displayPolicy().turnCard) {
          progressCards.stepStarted(sessionId, state.stepNumber, state.stepStartTime)
        }
        // Injections that arrived before this `step/start` (a compaction's
        // re-injection, a session's opening baseline) belong to THIS step's
        // request, so they join the first render of its card. Moved after
        // `resetStep`, which is what cleared the per-step list.
        const buffered = pendingInjections.get(sessionId)
        if (buffered !== undefined && buffered.length > 0) {
          state.injections = buffered
          pendingInjections.delete(sessionId)
        }
        // Stage 1 of the step card: say "thinking" NOW instead of after the
        // output lands. `step/start` is appended before the model request is
        // sent, so it is the only event that predates the reasoning. The card
        // it opens is the SAME card every later stage updates in place —
        // `assistant/message` (reasoning/text) → `tool/call` → `tool/result`.
        //
        // `compact` is the exception, deliberately: its step cards carry the
        // answer only, while the whole turn's tool activity AND its injection
        // notices live on the one turn card (`feishu-progress.ts`). A step that
        // has produced nothing yet therefore opens NO card — not even for an
        // injection, which is process like everything else on that card.
        const stepPolicy = displayPolicy()
        if (stepPolicy.turnCard) {
          // Anything buffered before this `step/start` belongs to THIS step's
          // request, so it becomes a row of this step's section right away.
          for (const notice of state.injections) {
            progressCards.stepInjection(sessionId, state.stepNumber, notice, state.stepStartTime)
          }
        } else {
          queueStepCardSend(chat, sessionId, state)
          startPlaceholderTick(sessionId, state)
        }
      } else if (event.type === 'step/end') {
        // A step that never produced anything visible must not leave its
        // placeholder claiming to think forever: fold it into the terminal
        // "empty step" form. Rare (it needs no text, no visible reasoning and
        // no visible tool call).
        state.stepEnded = true
        stopPlaceholderTick(state)
        if (displayPolicy().turnCard) progressCards.stepEnded(sessionId, event.time ?? Date.now())
        if (state.stepCardSent && stepIsEmpty(state)) updateStepCard(state)
      } else if (event.type === 'turn/start') {
        resetStep(state)
        lastStepSendPromises.delete(sessionId)
        // New turn, new delivery question.
        turnTextOrder.delete(sessionId)
        // The trigger attribution belongs to one turn: re-decide it from this
        // turn's own messages (see `foldTurnTrigger`).
        state.sawHumanMessage = false
        state.turnTrigger = undefined
        // `compact` draws the turn's tool activity on one card; this turn owns a
        // new one (the previous card is a historical record — a card entity may
        // only be sent once).
        if (displayPolicy().turnCard) progressCards.beginTurn(chat, sessionId, event.time ?? Date.now())
        state.turnStats = {
          turnStartTime: event.time ?? Date.now(),
          stepCount: 0,
          toolCallCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalBilledTokens: 0,
          firstStepTtftMs: null,
          totalDecodeMs: 0,
          totalDecodeTokens: 0,
          totalStepMs: 0,
          totalToolMs: 0,
          totalTurnMs: 0,
          deliverables: [],
          produced: [],
        }
        let resolve!: () => void
        const promise = new Promise<void>((r) => { resolve = r })
        flushPromises.set(sessionId, { promise, resolve })
        bridge.getSessionMeta(chat).then((meta) => {
          state.contextMeta = {
            contextWindow: state.contextMeta?.contextWindow || meta.contextWindow,
            lastInputTokens: state.contextMeta?.lastInputTokens || meta.lastInputTokens,
          }
          // The session's RECORDED route, for the completion footer to fall back
          // on when this instance never saw a `request/header` (a reloaded plugin
          // inside a live host agent — see `sessionRoute`).
          state.sessionRoute = { model: meta.model, reasoningEffort: meta.reasoningEffort }
          if (state.stepCardSent) updateStepCard(state)
        }).catch(() => undefined)
      } else if (event.type === 'user/message') {
        // Attribute the turn to whatever opened it. Every DSH mechanism that
        // starts a turn without a human — a settled background job, a schedule,
        // a subagent, a webhook, a goal round, a plugin — announces itself as a
        // `user/message` with its own source family (the same table the Web UI
        // renders turn triggers from, see `autoTurnTrigger`). A human message
        // owns the turn, so a notice claimed later in it is not a trigger.
        const source = (event.data as { source?: unknown } | undefined)?.source as
          { kind?: unknown; provider?: unknown } | undefined
        const before: TurnTriggerState = { trigger: state.turnTrigger, sawHuman: state.sawHumanMessage }
        const after = foldTurnTrigger(before, source)
        if (after.trigger !== before.trigger) {
          state.turnTrigger = after.trigger
          // The placeholder card is already on screen (posted at step/start,
          // which precedes this message), so repaint it with the marker.
          if (state.stepCardSent) updateStepCard(state)
        }
        state.sawHumanMessage = after.sawHuman

        // Every other non-`user` source is an injected context message. It gets
        // ONE notice line at the top of the card for the step whose request
        // reads it — never its content (the user's call, 2026-09-28) and never
        // a card of its own.
        const notice = injectionNotice(source, getTranslations?.() ?? translationsFor('zh'))
        if (notice !== undefined) {
          /** The step whose request this injection precedes is already open. */
          const liveStep = state.stepStartTime > 0 && !state.stepEnded
          if (displayPolicy().turnCard && liveStep) {
            // `compact` keeps the process on the turn card, and an injection IS
            // process: it becomes a row of the section for the step that claims
            // it. Opening a step card for it (the old O21① exception) produced
            // cards that said nothing but "本步无输出" plus the notice, and — on
            // every turn's first step, which always claims the runtime context —
            // a stray card carrying the step's narration as if it were a reply.
            state.injections.push(notice)
            progressCards.stepInjection(sessionId, state.stepNumber, notice, event.time ?? Date.now())
          } else if (liveStep && state.stepCardSent) {
            // The step's card is on screen and the step is still running: this
            // injection precedes a request that has not been sent yet, so it
            // goes on top of the card the user is already looking at.
            state.injections.push(notice)
            updateStepCard(state)
          } else if (liveStep) {
            // Inside a step whose card is still inside its debounce window: the
            // pending send rebuilds from this state, so adding it here is enough.
            state.injections.push(notice)
          } else {
            // Between steps (or before the first one): DSH materializes an
            // injection when a step CLAIMS its inbox, so it belongs to the NEXT
            // step's request. Buffer it; `step/start` moves it in (and mirrors it
            // onto the turn card under `compact`).
            const buffered = pendingInjections.get(sessionId) ?? []
            buffered.push(notice)
            pendingInjections.set(sessionId, buffered)
          }
        }
      } else if (event.type === 'compaction/start') {
        // A compaction happens between steps: `start` opens a card, `summary`
        // fills it in, `end` closes it. The three branches share one card per
        // session (see feishu-compaction.ts).
        compactionCards.start(chat, sessionId, typeof event.data?.sourceCommandId === 'string')
      } else if (event.type === 'compaction/summary') {
        compactionCards.applySummary(chat, sessionId, compactionFacts(event.data))
      } else if (event.type === 'compaction/end') {
        const failure = event.data?.error
        compactionCards.end(chat, sessionId, typeof failure === 'string' && failure !== '' ? failure : undefined)
      } else if (event.type === 'deliverables/presented') {
        // DSH's `present` tool declares the turn's final deliverables (Web UI
        // renders them as a card row). Collect them for the Turn Complete
        // card. Re-declaring a path replaces its entry, so the LATEST
        // description wins — the same rule as `ui-deliverables`.
        const files = event.data?.files as Array<{ path?: unknown; description?: unknown }> | undefined
        const deliverables = state.turnStats?.deliverables
        if (Array.isArray(files) && deliverables !== undefined) {
          for (const file of files) {
            const path = typeof file?.path === 'string' ? file.path.trim() : ''
            if (path === '') continue
            // Remember it for the SESSION, not just this turn: the produced
            // artifacts of a later turn must not deliver a file the model
            // already handed over (`everPresentedPaths`).
            state.everPresentedPaths.add(path)
            const description = typeof file.description === 'string' && file.description.trim() !== ''
              ? file.description.trim()
              : undefined
            const entry: PresentedFile = description === undefined ? { path } : { path, description }
            const existing = deliverables.findIndex(item => item.path === path)
            if (existing >= 0) deliverables[existing] = entry
            else if (deliverables.length < DELIVERABLE_CAP) deliverables.push(entry)
          }
        }
      } else if (event.type === 'request/header') {
        // The route lives in the header's own config — the same field `/model`
        // reads back when it shows a session's current selection. DSH appends
        // this on initial / resume / change / new series, so it is the cheapest
        // source that is still authoritative; `request/context` below covers a
        // route change that ships without a header change.
        const cfg = event.data?.header?.config as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined
        const headerProvider = cfg?.provider
        const headerModel = cfg?.model
        if (typeof headerProvider === 'string' && headerProvider !== ''
          && typeof headerModel === 'string' && headerModel !== '') {
          state.requestRoute = { provider: headerProvider, model: headerModel }
        }
        if (typeof cfg?.reasoningEffort === 'string' && cfg.reasoningEffort !== '') {
          state.requestEffort = cfg.reasoningEffort
        }
      } else if (event.type === 'request/context') {
        const cw = event.data?.contextWindow as number | undefined
        // The route rides the same event (`request/context` is DSH's route
        // metadata) and is what the awaiting card names, so the reader can tell
        // WHICH model the request went to without opening /model.
        const provider = event.data?.provider
        const model = event.data?.model
        const routeKnown = typeof provider === 'string' && provider !== ''
          && typeof model === 'string' && model !== ''
        const routeChanged = routeKnown
          && (state.requestRoute?.provider !== provider || state.requestRoute?.model !== model)
        if (routeKnown) state.requestRoute = { provider, model }
        if (cw !== undefined && cw > 0) {
          state.contextMeta = {
            contextWindow: cw,
            lastInputTokens: state.contextMeta?.lastInputTokens ?? 0,
          }
        }
        // A context-window update always repainted (channel.ts relies on that
        // update to put already-arrived text on the card). A route-only change
        // repaints just the content-free card that is naming it.
        const repaint = (cw !== undefined && cw > 0) || (routeChanged && stepIsEmpty(state))
        if (state.stepCardSent && repaint) updateStepCard(state)
      } else if (event.type === 'turn/end') {
        const turnStats = state.turnStats
        const endTime = event.time ?? Date.now()
        if (turnStats !== undefined) {
          turnStats.totalTurnMs = endTime - turnStats.turnStartTime
          turnStatsMap.set(sessionId, turnStats)
        }
        // The `compact` progress card freezes here (green, or red when the turn
        // failed). A no-op when no card was opened, so a level change mid-turn
        // still closes whatever exists.
        void progressCards.finish(sessionId, endTime, event.data?.reason?.kind === 'error')

        // Capture the answer's segments BEFORE anything else: a single
        // block-aware split drives both the step card (segment 0) and the
        // continuation cards, and it has to read `state.text` before `resetStep`
        // clears it. Slicing at a fixed character offset used to cut tables and
        // code fences in half (2026-09-18) — the boundary always falls between
        // blocks.
        const fullText = state.text.trim()
        const textSegments = chunkText(fullText, TEXT_STEP_CAP, MAX_OVERFLOW_CARDS + 1)
        const overflowChunks = textSegments.slice(1)

        // `compact` has no Turn Complete card: its filtered summary is folded
        // into the footer of the card that carries the answer (see
        // `src/turn-summary.ts`). Set BEFORE the pending send/update is flushed
        // so that write already carries it; when the card is already on screen
        // the summary needs one extra write, captured here because `resetStep`
        // clears the ref and the text below.
        const compact = displayPolicy().turnCard
        const tr = getTranslations?.() ?? translationsFor('zh')
        // The turn's own request header wins (it names the request that answered);
        // the session's recorded route is the fallback, so the line survives a
        // plugin reload that outlived its `request/header` (2026-10-15).
        const footerModel = state.requestRoute !== undefined
          ? `${state.requestRoute.provider}/${state.requestRoute.model}`
          : state.sessionRoute?.model
        const footerEffort = state.requestEffort
          ?? (state.sessionRoute?.reasoningEffort === '' ? undefined : state.sessionRoute?.reasoningEffort)
        const completionFacts = compact
          ? {
              stats: turnStats,
              ...(footerModel === undefined || footerModel === '' ? {} : { model: footerModel }),
              ...(footerEffort === undefined ? {} : { reasoningEffort: footerEffort }),
              ...(produceCardMode === undefined || produceCardMode() === 'off'
                ? {}
                : { producedCount: producedArtifacts(turnStats?.produced ?? []).length }),
            }
          : undefined
        const completionLines = completionFacts === undefined
          ? undefined
          : compactCompletionLines(tr, completionFacts)
        const completionTitle = completionFacts === undefined
          ? undefined
          : compactCompletionTitle(tr, completionFacts)
        // A long answer ends on a "continued" card, and the summary belongs on
        // the LAST card of the reply, not on the one above it.
        const completionOnOverflow = completionLines !== undefined && overflowChunks.length > 0
        if (completionLines !== undefined && !completionOnOverflow) {
          state.completionLines = completionLines
          state.completionTitle = completionTitle
        }

        // A very short final step can end inside the send debounce window;
        // post its card before anything else so it precedes the overflow and
        // completion cards in the chat. It is built from the current state, so
        // it carries `completionLines` set just above.
        flushPendingSend(state)
        // The final step card's message may still be in flight (CardKit create
        // → send). Capture its promise now — resetStep clears the ref — and
        // await it before the overflow cards so they cannot be created first.
        const lastStepSend = lastStepSendPromises.get(sessionId)

        const overflowChat = state.chat
        const overflowOpts = overflowChat !== undefined
          ? overflowChat.threadId !== undefined
            ? { replyInThread: true, ...(overflowChat.rootId !== undefined ? { replyTo: overflowChat.rootId } : {}) }
            : {}
          : undefined

        // The continuation cards carry the same step's speed so every card in
        // the reply stream shows one.
        const overflowTps = computeStepTps(state)

        // The answer card is already on screen: it needs one more write for the
        // summary. Both the card and its ref are captured NOW because resetStep
        // wipes the state the card is built from.
        const summaryRef = completionLines === undefined || completionOnOverflow ? undefined : state.stepCardRef
        const summaryCard = summaryRef === undefined || completionLines === undefined
          ? undefined
          : buildStepCard(state)
        /**
         * The LAST continuation card is the card that ends the turn, so it gets
         * the completion treatment — title, rule and summary — through the same
         * helper the fallback reply path uses.
         */
        const withOverflowSummary = (cards: object[]): object[] =>
          completionOnOverflow && completionFacts !== undefined
            ? cards.map((card, i) => i === cards.length - 1
                ? appendCompletionFooter(card, tr, completionFacts, overflowChunks.length > 1
                  // `续 n/n` only when the reply really was split: a single
                  // continuation card is just the tail of the answer.
                  ? { part: { part: overflowChunks.length, total: overflowChunks.length } }
                  : {})
                : card)
            : cards

        flushPendingUpdate(state).then(async () => {
          // The step card is now on screen with the first TEXT_STEP_CAP chars.
          // Wait for its message before posting overflow, otherwise the
          // "continued" cards are created first and appear above the step card
          // (observed 2026-09-09). The barrier handles the real channel; this
          // await also covers channels that do not register one.
          if (lastStepSend !== undefined) await lastStepSend
          // Fold the turn summary into the answer card. Not a text write: it
          // must not touch the delivery record `flushed()` reads.
          if (summaryRef !== undefined && summaryCard !== undefined) {
            await trackUpdate(sessionId, () => scheduleCardWrite(summaryRef, {
              card: summaryCard,
              hasText: false,
              stamp: 0,
            }).then(() => undefined))
          }
          // Send overflow text as follow-up "continued" cards so the full
          // reply is delivered without silent truncation.
          //
          // These go through the same media hydrator as every other card: they
          // used to be handed to the raw channel, so a clip referenced past
          // TEXT_STEP_CAP never rendered (found 2026-09-24). They are all
          // resolved FIRST and sent in order afterwards: hydrating them one at a
          // time would let N cards pay N budgets, while in parallel the shared
          // cache bounds the whole batch by one budget per card at most.
          if (overflowChunks.length > 0 && overflowChat !== undefined && overflowOpts !== undefined) {
            const overflowCards = await Promise.all(overflowChunks.map((chunk, i) =>
              prepareCard(renderOverflowCard(chunk, i + 1, overflowChunks.length, tr, overflowTps), sessionId)))
            const cards = withOverflowSummary(overflowCards)
            for (const card of cards) {
              await channel.send(overflowChat.chatId, { card }, overflowOpts)
            }
          }
          const entry = flushPromises.get(sessionId)
          if (entry !== undefined) {
            entry.resolve()
            flushPromises.delete(sessionId)
          }
        }).catch((error: unknown) => {
          console.log(`dsh-feishu: turn/end flush error: ${error instanceof Error ? error.message : String(error)}`)
          const entry = flushPromises.get(sessionId)
          if (entry !== undefined) {
            entry.resolve()
            flushPromises.delete(sessionId)
          }
        })
        resetStep(state)
      }
    } catch (eventError: unknown) {
      console.log(`dsh-feishu: streaming event handler error: ${eventError instanceof Error ? eventError.message : String(eventError)}`)
    }
  }
  const disposeListener = ctx.on('session/event', handleEvent)

  /**
   * Advance one step's live phase from the transient assistant stream (O20).
   *
   * This is the only live signal this module gets: no token delta is a durable
   * session event any more (`assistant/chunk` was removed in 0.1.3), so the
   * card used to sit on its `step/start` wording until the WHOLE message
   * landed. Frames are `start → chunk… → end`, published per attempt:
   *
   * - `start` → `awaiting` (the request is out; nothing has come back yet);
   * - first `reasoning-delta` → `thinking`;
   * - first `text-delta` → `replying`;
   * - `end` with `outcome.kind === 'abandoned'` → back to `none`, because DSH is
   *   about to retry and the retry publishes its own `start`.
   *
   * Within one attempt the phase only moves FORWARD (a late reasoning delta
   * must not undo `replying`), and it only repaints a card that still has no
   * content, so a settled step is untouched. A `committed` end needs no action:
   * the durable `assistant/message` that follows settles the card.
   *
   * The same phase is handed to the turn progress card (`compact`), whose
   * running step shows it as its live light — that card always has content, so it
   * is NOT part of the "content-free only" rule above.
   */
  const handleAssistantStream = (rawPayload: unknown): void => {
    try {
      const payload = rawPayload as {
        agent?: { session?: { id?: unknown } }
        frame?: { type?: unknown; outcome?: { kind?: unknown }; chunk?: { type?: unknown } }
      } | null | undefined
      const sessionId = payload?.agent?.session?.id
      const frame = payload?.frame
      if (typeof sessionId !== 'string' || frame === null || frame === undefined) return
      const bridge = bridgeHolder.current
      if (bridge === undefined || bridge.resolveChat(sessionId) === undefined) return
      const state = sessionStates.get(sessionId)
      // No step open (yet): a frame for a step this module never saw has no card
      // to name. `sessionStates` entries are only created by durable events.
      if (state === undefined || state.stepEnded) return
      if (frame.type === 'start') {
        if (state.livePhase === 'awaiting') return
        state.livePhase = 'awaiting'
      } else if (frame.type === 'chunk') {
        const wanted: StepLivePhase | undefined = frame.chunk?.type === 'reasoning-delta'
          ? 'thinking'
          : frame.chunk?.type === 'text-delta' ? 'replying' : undefined
        if (wanted === undefined || state.livePhase === wanted || state.livePhase === 'replying') return
        state.livePhase = wanted
      } else if (frame.type === 'end') {
        if (frame.outcome?.kind !== 'abandoned' || state.livePhase === 'none') return
        state.livePhase = 'none'
      } else {
        return
      }
      // The same phase is what the COMPACT turn card's running step shows
      // (`stepPhase`): its header is the only line of that card about the
      // present, and this frame is the only live signal the module ever gets.
      // Pushed on transitions only — the branches above already return on a
      // repeat frame, and `stepPhase` drops an unchanged phase as well.
      if (displayPolicy().turnCard) {
        progressCards.stepPhase(
          sessionId,
          state.stepNumber,
          state.livePhase === 'none' ? undefined : state.livePhase,
          Date.now(),
        )
      }
      // Only a content-free card shows the phase, and only once it exists: while
      // the first send is still pending, that send rebuilds from state anyway.
      if (state.stepCardSent && state.stepCardRef !== undefined && stepIsEmpty(state)) updateStepCard(state)
    } catch (streamError: unknown) {
      console.log(`dsh-feishu: assistant-stream handler error: ${streamError instanceof Error ? streamError.message : String(streamError)}`)
    }
  }
  // `{ global: true }`: the publication is agent-scoped, so a scoped listener
  // would only see agents under this plugin's own scope. Same shape the subagent
  // roster subscribes with (see `feishu-subagents.ts`).
  const disposeStream = (ctx as unknown as AssistantStreamSource)
    .on('agent/assistant-stream', handleAssistantStream, { global: true })

  /** Consume accumulated reasoning for a session (used by channel.ts for the final reply card). */
  const consumeReasoning = (sessionId: string): string | undefined => {
    const state = sessionStates.get(sessionId)
    if (state === undefined || state.reasoning.trim() === '') return undefined
    const reasoning = state.reasoning.trim()
    state.reasoning = ''
    return reasoning
  }

  /** Check and consume whether the last step sent a card with content. */
  const consumeLastStepHadContent = (sessionId: string): boolean => {
    const state = sessionStates.get(sessionId)
    if (state === undefined) return false
    const had = state.lastStepHadContent
    state.lastStepHadContent = false
    return had
  }

  /** Wait for the final step card update to complete before sending footer. Returns turn stats. */
  /**
   * Wait for the turn's final card update to complete before sending footer.
   * Returns turn stats.
   *
   * Also the point where the optimistic "text is on screen" mark is either
   * allowed to stand or withdrawn: if no card carrying assistant text was
   * CONFIRMED delivered this turn, or the NEWEST such card was refused, the
   * mark is cleared so channel.ts posts the answer itself. Without this, a card
   * that Feishu never accepted silenced the whole reply (2026-09-21, key
   * pitfall 29), and a turn whose last step was refused ended with the footer
   * alone while that step's card kept rendering "🧠 深度思考中" (2026-09-24,
   * key pitfall 45).
   *
   * The wait is bounded as a last resort; running out of patience must not
   * become "no footer at all".
   */
  const flushed = async (sessionId: string): Promise<TurnStats | undefined> => {
    const entry = flushPromises.get(sessionId)
    const lastSend = lastStepSendPromises.get(sessionId)
    const flushReady = entry !== undefined ? entry.promise : Promise.resolve()
    const settled = await settleWithin(
      flushReady
        // Wait for the last step card's message to be created so the Turn
        // Complete footer never overtakes the final step card in the chat.
        .then(() => lastSend)
        // Then for every write that is still in flight: their confirmations are
        // what the delivery record below reports, and a write delayed by media
        // hydration used to be read as "nothing reached the chat" (duplicate
        // reply card, 2026-09-24). Read the map HERE, not before the awaits, so
        // a write registered by the turn/end flush is included.
        .then(() => Promise.all([...(inFlightUpdates.get(sessionId) ?? [])]))
        .then(() => turnStatsMap.get(sessionId)),
      'turn flush',
      FLUSH_TIMEOUT_MS,
      reason => console.log(`dsh-feishu: flushed(${sessionId}) gave up: ${reason}`),
    )
    // Read the delivery record only now: the confirmation for the final step
    // card is attached to the very promise awaited above, so it has run by the
    // time we get here.
    const order = turnTextOrder.get(sessionId)
    turnTextOrder.delete(sessionId)
    const delivered = order !== undefined && order.delivered > 0 && order.failed <= order.delivered
    if (!delivered) {
      // The turn's newest text never reached the chat: channel.ts must send the
      // real reply.
      bridgeHolder.current?.clearIntermediateSent(sessionId)
    }
    return settled
  }

  /**
   * Another module posted a card into a chat: under `compact` the answer card
   * that is on screen for a step of that chat is a closed segment from here on
   * (see `src/card-interleave.ts`). Nothing is written to it any more; the next
   * content of that step opens a new card below the interruption.
   */
  const unsubscribeInterleave = interleave?.onNotice((chatId: string) => {
    for (const state of sessionStates.values()) {
      if (state.chat?.chatId !== chatId) continue
      if (!displayPolicy().turnCard) continue
      if (state.stepEnded || !state.stepCardSent) continue
      state.supersededFrom = state.text.length
    }
  })

  return {
    stop: () => {
      disposeListener()
      disposeStream()
      unsubscribeInterleave?.()
      for (const entry of pendingUpdates.values()) clearTimeout(entry.timer)
      pendingUpdates.clear()
      for (const timer of staleTimers) clearTimeout(timer)
      staleTimers.clear()
      for (const state of sessionStates.values()) {
        if (state.pendingSend !== undefined) clearTimeout(state.pendingSend.timer)
        stopPlaceholderTick(state)
        stopWarmTimer(state)
      }
      sessionStates.clear()
      turnStatsMap.clear()
      lastStepSendPromises.clear()
      inFlightUpdates.clear()
      lastCardSendByChat.clear()
      turnTextOrder.clear()
      // Release a render still waiting for a slot: it will never be written,
      // and its caller (a tracked update) must not stay pending.
      for (const slot of writeSlots.values()) slot.queued?.resolve(false)
      writeSlots.clear()
      for (const entry of flushPromises.values()) entry.resolve()
      flushPromises.clear()
      pendingInjections.clear()
      compactionCards.stop()
      progressCards.stop()
    },
    consumeReasoning,
    consumeLastStepHadContent,
    flushed,
  }
}

/**
 * Read a `compaction/summary` payload into the card's own facts.
 *
 * Every field is optional in practice: a provider that reports no usage, a
 * summary whose blocks carry no text, or a prune (which has no summary event at
 * all) must all still render something honest rather than a hole.
 *
 * @param data - the event's `data`.
 * @returns the facts the compaction card can state; absent fields stay absent.
 */
function compactionFacts(data: unknown): CompactionFacts {
  const record = (data ?? {}) as Record<string, unknown>
  const seqs = Array.isArray(record.shadowedSeqs) ? record.shadowedSeqs.length : undefined
  const tokens = typeof record.shadowedTokenCount === 'number' ? record.shadowedTokenCount : undefined
  const provider = typeof record.provider === 'string' && record.provider !== '' ? record.provider : undefined
  const model = typeof record.model === 'string' && record.model !== '' ? record.model : undefined
  const summary = summaryText(record.summary)
  return {
    ...(seqs !== undefined ? { foldedItems: seqs } : {}),
    ...(tokens !== undefined ? { foldedTokens: tokens } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(summary !== undefined ? { summary } : {}),
  }
}

/**
 * Cap for one tool call's KEPT raw result content (characters).
 *
 * What is remembered, not what is rendered: a card can only render what was
 * kept, so the `verbose` level keeps four times as much (below) instead of
 * re-reading a result the event will never carry again.
 */
const RESULT_CONTENT_CAP = 1500

/** Kept-result cap for the `verbose` level (see {@link RESULT_CONTENT_CAP}). */
const RESULT_CONTENT_CAP_FULL = 6000

/**
 * Cap on remembered deliverables per turn. DSH's `present` tool already caps a
 * single call at 8 files; this bounds the total when the model calls it more
 * than once so the Turn Complete card cannot grow without limit.
 */
const DELIVERABLE_CAP = 16

/**
 * Coalescing window (ms) for step-card work.
 *
 * Used for both the first send and later updates: a fast model can finish
 * reasoning → tool/call → tool/result inside this window, and one card is
 * then posted with the final state instead of send + update. Slow tools are
 * unaffected — the card is still posted (with `⏳ running…`) shortly after
 * the step starts, and updated when the tool finishes.
 */
const STEP_CARD_DEBOUNCE_MS = 150

/**
 * Coalescing window (ms) for the media warm-up that runs while the model is
 * still streaming its text.
 *
 * Deliberately much longer than the card debounce: the warmer is not on any
 * critical path, it only has to start the uploads well before the card that
 * needs their keys is written, so a couple of rebuilds per sentence is enough
 * and a per-token upload storm is what this avoids. It also coalesces the
 * partial references of a token stream into one hydrate per (short) pause.
 */
const MEDIA_WARM_DEBOUNCE_MS = 400

/**
 * How long a failed card write must stay unfixed before it is reported as a
 * stale card.
 *
 * Comfortably longer than one debounce window plus one outbound round trip, so
 * a failure the next update repairs is never reported. The report is a chat
 * message, and a card that recovered is not worth interrupting the user for.
 */
const STALE_CARD_CONFIRM_MS = 2_000

/**
 * How often a content-free step card refreshes its elapsed time while the model
 * is thinking. Deliberately slow: the card exists to prove the step is alive,
 * not to animate — DSH publishes no token deltas on the persistent event bus,
 * so there is nothing more frequent to show.
 */
const PLACEHOLDER_TICK_MS = 5_000

/** Cap for one tool result preview rendered into the card (characters). */
const RESULT_PREVIEW_CAP = 1500

/**
 * Cap for one tool result under the `verbose` level (characters).
 *
 * Four times the normal cap rather than "no cap": a card is refused whole when
 * its JSON passes ~30 KB (关键坑 42), and a refused card shows NOTHING — so the
 * honest meaning of "untruncated" here is "four times as much, still inside the
 * card's own budget", never "whatever the tool returned".
 */
const RESULT_PREVIEW_CAP_FULL = 6000

/** Cap for one tool call's args rendered in the fenced code block (characters). */
const ARGS_DISPLAY_CAP = 2000

/** Cap for one tool call's args under the `verbose` level (characters). */
const ARGS_DISPLAY_CAP_FULL = 6000

/** Cap for the text section of a step card (characters). Overflow is sent as
 *  follow-up "continued" cards so no content is silently dropped. The cap is a
 *  *budget*, not a slice offset: `chunkText` picks the boundary so no table,
 *  code fence or list is ever cut in half (see src/text-chunk.ts). */
const TEXT_STEP_CAP = 3000

/** Upper bound on the follow-up "continued" cards for one step's text. */
const MAX_OVERFLOW_CARDS = 30

/**
 * Element spacing of a `compact` step card (the answer card). The default is
 * visibly loose when a card is a paragraph plus one footer line; 4px keeps the
 * two apart without the empty-line look. `vertical_spacing` takes a size token
 * or px — see 关键坑 58 for the measured field behaviour.
 */
const STEP_CARD_ELEMENT_SPACING = '4px'

/**
 * Truncate a value to a readable summary for card display.
 */
function summarizeValue(value: unknown, maxLen: number = 200): string {
  if (value === undefined || value === null) return ''
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '…'
}

/**
 * Format a tool call's arguments for the fenced code block, showing as much
 * detail as the budget allows. JSON objects are stringified in a compact (but
 * indented) form when they parse, so the reader sees the real parameters
 * instead of one line; passes through plain strings unchanged. Capped at
 * `ARGS_DISPLAY_CAP` characters so a single args block never blows the card.
 */
function formatToolArgs(value: unknown, full = false): string {
  if (value === undefined || value === null) return ''
  const cap = full ? ARGS_DISPLAY_CAP_FULL : ARGS_DISPLAY_CAP
  let str: string
  if (typeof value === 'string') {
    // Try to pretty-print a JSON string so multi-arg calls stay legible.
    try {
      const parsed: unknown = JSON.parse(value)
      str = JSON.stringify(parsed, null, 2)
    } catch {
      str = value
    }
  } else {
    str = JSON.stringify(value, null, 2)
  }
  return str.length > cap ? str.slice(0, cap) + '\n…' : str
}

/** Sanitize raw content for embedding in a fenced code block: collapse any
 *  run of backticks (which would close the fence) and strip control chars. */
function sanitizeCodeblock(text: string): string {
  return text
    .replace(/`+/g, '`')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
}

/**
 * Whether an assembled assistant message asked for tools.
 *
 * The tool-call BLOCKS are the authority: they arrive inside the assembled
 * `assistant/message` (the separate `tool/call` session events come after it), so
 * this is the only fact available at the moment the card would be sent. The Web
 * UI draws the same line — a reply-bearing message that also calls tools is
 * process narration, never a Turn's final answer
 * (`ui-chat/src/client/conversation-nodes/turn-process.ts` → `latestAnswer`
 * refuses any message whose blocks contain a tool call).
 *
 * @param event - the `assistant/message` session event.
 * @returns whether the message carries a tool-call block.
 */
function messageCallsTools(event: { data?: any }): boolean {
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return false
  return content.some((block: { type?: unknown }) => block?.type === 'tool-call')
}

/**
 * Render a follow-up "continued" card for overflow text that exceeded the step
 * card's TEXT_STEP_CAP. No reasoning (already shown on the step card) and no
 * full footer (that is sent separately by channel.ts), but the step's output
 * speed is repeated so every card in the reply stream shows one.
 *
 * The title was hardcoded English (`Reply (continued 1/2)`) until 2026-10-14 —
 * visible at every level, in a zh chat included. It is localized now: the part
 * count when there is more than one fragment, and the bare marker when the reply
 * needed exactly one continuation card (`续 1/1` would count nothing). The LAST
 * continuation card then replaces the title with the completion one
 * (`appendCompletionFooter`) — it is the card that ends the turn.
 */
function renderOverflowCard(text: string, part: number, total: number, t: Translations, tps?: number): object {
  const elements: object[] = [{ tag: 'markdown', content: text }]
  if (tps !== undefined && tps > 0) {
    elements.push({ tag: 'markdown', content: `🚀 ${tps.toFixed(0)} tok/s`, text_size: 'notation' })
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: total > 1 ? `📄 ${t.turnContinuedPart(part, total)}` : t.turnContinuedTitle,
      },
      template: 'blue',
    },
    body: { elements },
  }
}

/** Format a token count for display (e.g. 1234 → "1.2K"). */
function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

// ─── Tool-call summary (recovered) ─────────────────────────────────────────
// The old per-step cards got the tool summary from `presentCall` views carried
// on the apiproxy mux frame (`<frame>.view.for === 'call'`). DSH 0.1.2-alpha.1
// no longer emits `presentCall` anywhere, so that source is gone. The current
// Web UI recovers the same "what the model wants to do" line by deriving it
// from the call `arguments` (packages/client/ui-tool/.../tool-call-model.ts:
// `classifyTool` + `deriveSummary`). We replicate that derivation here so the
// Feishu tool rows show the same short summary.
//
// Tool-row variants as the generic atomic renderer classifies them.
type ToolSummaryVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'todo' | 'others'

/** Known tool name → variant (mirrors Web UI `TOOL_VARIANTS`). */
const TOOL_SUMMARY_VARIANTS: Record<string, ToolSummaryVariant> = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  todo_write: 'todo',
  // Legacy Cordis names kept on purpose: this table mirrors the Web UI's
  // `TOOL_VARIANTS`, which still maps them so tool calls recorded by older
  // sessions re-render with the same summary. They are deliberately NOT
  // "cleaned up" to match the currently registered tool set.
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
}

/** Tools with an owned title: the `others`-prefix rule does not apply to them. */
const TOOL_SUMMARY_TITLED: ReadonlySet<string> = new Set([
  'cordis_package_inspect', 'cordis_runtime_inspect', 'cordis_run', 'cordis_stop',
  'cordis_undefine', 'pwsh',
])

/** Summary key preference per variant (mirrors Web UI `SUMMARY_KEYS`). */
const TOOL_SUMMARY_KEYS: Record<ToolSummaryVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  todo: [],
  others: [],
}

/** Classify a tool name into its summary variant (defaults to `others`). */
function classifyToolSummary(toolName: string): ToolSummaryVariant {
  return TOOL_SUMMARY_VARIANTS[toolName] ?? 'others'
}

/** Parse a tool-call `arguments` JSON string; `undefined` when it is not JSON. */
function parseToolArgs(argsRaw: string): unknown {
  try { return JSON.parse(argsRaw) } catch { return undefined }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** Pick the first non-empty string among `keys` from an args object. */
function pickToolArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Derive the short one-line summary from a variant and the raw args JSON. */
function deriveToolSummaryValue(variant: ToolSummaryVariant, argsRaw: string): string {
  const parsed = parseToolArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw)
  const args = parsed as Record<string, unknown>
  if (variant === 'todo' && Array.isArray(args.todos)) {
    const items = args.todos.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    const pending = items.filter((item) => item.status === 'pending').length
    const inProgress = items.filter((item) => item.status === 'in_progress').length
    const completed = items.filter((item) => item.status === 'completed').length
    return `待办清单：${items.length} 项 · 进行中 ${inProgress} · 待办 ${pending} · 完成 ${completed}`
  }
  if (variant === 'search' && Array.isArray(args.queries)) {
    const queries = args.queries
      .filter((query): query is string => typeof query === 'string' && query !== '')
      .map(firstLine)
    if (queries.length > 0) return queries.join(', ')
  }
  const picked = pickToolArg(args, TOOL_SUMMARY_KEYS[variant])
  if (picked !== undefined) return firstLine(picked)
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '') return firstLine(value)
  }
  return firstLine(argsRaw)
}

/**
 * Recover the "what the model wants to do" summary line for a tool call,
 * mirroring the Web UI's `toolRowModel().summary`. Unknown tools render as
 * `toolName · <first field>` unless the tool owns a title.
 */
export function deriveToolSummary(toolName: string, argsRaw: string): string {
  // DSH's `present` takes a `files` array, so the generic "first field" rule
  // would render `present · files`. Summarize by the delivered paths instead.
  if (toolName === 'present') {
    const parsed = parseToolArgs(argsRaw)
    const files = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { files?: unknown }).files)
      ? (parsed as { files: unknown[] }).files
      : undefined
    if (files !== undefined) {
      const first = files.find((item): item is { path: string } =>
        typeof (item as { path?: unknown } | null)?.path === 'string')
      const named = first === undefined ? `${files.length}` : firstLine(first.path)
      const extra = files.length > 1 ? ` +${files.length - 1}` : ''
      return `交付文件：${named}${extra}`
    }
  }
  const variant = classifyToolSummary(toolName)
  const base = deriveToolSummaryValue(variant, argsRaw)
  const titled = TOOL_SUMMARY_TITLED.has(toolName)
  return variant === 'others' && toolName !== '' && !titled
    ? `${toolName} · ${base}`
    : base
}

/**
 * A file path reduced to its BARE file name: what the call touched, not where
 * it lives.
 *
 * The user's call (2026-10-12): the compact row is read by scanning, and the
 * directory in `…/src/feishu-progress.ts` is width spent on a fact the row is
 * not about. A path that names no file — empty, or ending in a separator —
 * yields `''`, so the row says nothing rather than naming a directory.
 */
function bareFileName(path: string): string {
  if (path === '' || /[\\/]$/u.test(path)) return ''
  const parts = path.split(/[\\/]/u).filter(part => part !== '')
  return parts.length === 0 ? '' : parts[parts.length - 1]!
}

/**
 * The short "what" a COMPACT tool row carries (`feishu-progress.ts`) — as a LIST,
 * so a merged run can name the first few across all of its calls rather than
 * repeating one call's whole list (`npm / tail / git`, not `npm / tail / git /
 * node / tail`).
 *
 * Two kinds, because those are the two where a name alone says nothing:
 *
 * - **a file** (read / write / edit): the file's BARE name (`feishu-progress.ts`).
 *   The detailed card keeps the model's own description and the whole path; this
 *   row is one line on a card read by scanning, and the directory is not the
 *   part that changed. Two files of the same name in different directories
 *   therefore read the same here — the row is a pointer to the call, not an
 *   identity for the file.
 * - **a shell command** (`bash`, `pwsh`): the programs it ran, at most
 *   {@link shellPrograms}' own limit.
 *
 * Everything else returns undefined: a row that repeats its own tool name is
 * noise, and the compact card is short on room.
 *
 * @param toolName - the tool the call ran.
 * @param argsRaw - the call's raw arguments JSON.
 * @returns the names, or undefined when there is nothing short and useful.
 */
export function progressToolDetails(toolName: string, argsRaw: string): string[] | undefined {
  const parsed = parseToolArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const args = parsed as Record<string, unknown>
  const variant = classifyToolSummary(toolName)
  if (variant === 'read' || variant === 'write' || variant === 'edit') {
    const path = pickToolArg(args, TOOL_SUMMARY_KEYS[variant])
    if (path === undefined) return undefined
    const short = bareFileName(firstLine(path).trim())
    return short === '' ? undefined : [short]
  }
  if (variant === 'bash' || toolName === 'pwsh') {
    const programs = shellPrograms(typeof args.command === 'string' ? args.command : '')
    return programs.length === 0 ? undefined : programs
  }
  return undefined
}

/**
 * The tool calls a FAILED model attempt streamed but never committed.
 *
 * `assistant/attempt` is appended exactly when an attempt did not commit, and its
 * `stream` is the same lossless record list a committed `assistant/message`
 * carries. A tool call reaches it as a packed `tool-call-chunks` run (which names
 * the tool) — older writers could leave a raw `tool-call-delta` chunk, so that
 * shape is read too — and because the attempt died, no `tool/call` event ever
 * follows it: the call never ran.
 *
 * Deduplicated (a message may stream one call in several runs) and capped at
 * {@link PROGRESS_MAX_DETAILS}, the same budget a merged tool row has: the row is
 * a pointer to what the step was doing, not an inventory.
 *
 * @param stream - the attempt's record list.
 * @returns the distinct tool names, in stream order; empty when the attempt never
 *          got as far as a call (a step that died while thinking names no tool).
 */
export function uncommittedToolNames(stream: readonly AssistantStreamRecord[]): string[] {
  const names: string[] = []
  for (const record of stream) {
    const name = record.type === 'tool-call-chunks'
      ? record.name
      : record.type === 'chunk' && record.chunk.type === 'tool-call-delta' ? record.chunk.name : undefined
    if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name)
    if (names.length >= PROGRESS_MAX_DETAILS) break
  }
  return names
}

/**
 * Render a unified per-step card with reasoning, text, and tool calls.
 * `options.showToolArgs` / `options.showToolResults` only gate the per-tool
 * detail blocks; the tool section itself is omitted upstream by passing an
 * empty `tools` array when tool display is off.
 *
 * `options.phase` names which live phase a CONTENT-FREE card is in (O20): the
 * request may not even be out yet (`step/start`), it may be out with nothing
 * back (`awaiting`), the model may be reasoning (`thinking`), or writing
 * (`replying`). It is ignored once the card has content — the settled titles
 * (reply / tool states / empty step) own that case.
 */
export function renderStepCard(
  t: Translations,
  reasoning: string | undefined,
  text: string | undefined,
  tools: StepToolCall[],
  usage?: StepUsage,
  stepDurationMs?: number,
  tps?: number,
  contextMeta?: { contextWindow: number; lastInputTokens: number },
  reasoningMs?: number,
  turn?: number,
  step?: number,
  options?: {
    showToolArgs?: boolean
    showToolResults?: boolean
    empty?: 'thinking' | 'done'
    /** Localized family name of the non-human message that opened this turn. */
    turnTriggerNote?: string
    phase?: StepLivePhase
    /** Route of the request in flight, named on the awaiting card. */
    route?: { provider: string; model: string }
    /**
     * Resolved display policy (level + switches). Omitted only by direct
     * callers such as tests; the default is the `detailed` level with both
     * tool-output switches on, which is exactly the pre-level behavior. The
     * legacy `showToolArgs` / `showToolResults` booleans are still honoured
     * when no policy is passed.
     */
    display?: DisplayPolicy
    /**
     * Context-injection notice lines for THIS step, one per injected message,
     * rendered before everything else. Metadata only — never the injected text.
     */
    injections?: readonly string[]
    /**
     * The turn's filtered completion summary (`compact` only), rendered as the
     * footer's first lines in place of the per-step timing line. Present on the
     * LAST write of a turn: the level has no Turn Complete card, so this is
     * where the turn's totals, model and produced-file count appear.
     */
    completionLines?: readonly string[]
    /**
     * The completion title that goes with {@link completionLines}
     * (`✅ 完成 · 2m14s`): this card ends the turn, and the header is where a
     * reader sees that. Present exactly when `completionLines` is.
     */
    completionTitle?: string
  },
): object {
  const elements: object[] = []
  // One policy for the whole render: reading it per section could show a card
  // built from two different settings if the user tapped `/display` mid-render.
  const display: DisplayPolicy = options?.display ?? {
    ...DETAILED_POLICY,
    toolArgs: options?.showToolArgs !== false,
    toolResults: options?.showToolResults !== false,
  }
  /**
   * `compact`'s step card is a different animal: it carries the answer and
   * nothing else, so the chrome that separates sections at the other levels (the
   * `📝 消息` label, the `hr` rules, one element per footer line, the default
   * element spacing) only adds emptiness. See 关键坑 58 for the spacing fields.
   */
  const tight = display.turnCard

  // Context-injection notices, FIRST: they are why this request carries what it
  // carries, so they read as the preamble of the step rather than as one more
  // detail inside it (§1.5 of the parity design).
  if (options?.injections !== undefined) {
    for (const notice of options.injections) {
      if (notice === '') continue
      elements.push({ tag: 'markdown', content: notice, text_size: 'notation' })
    }
  }

  // Attribution line, first so it reads as the reason this card exists at all.
  // A non-human notice opens its own turn (DSH wakes an idle owner), which is
  // otherwise invisible in the chat: the notice is a context message, not
  // something the human wrote. The family comes from `autoTurnTrigger`, i.e.
  // the same names the Web UI uses for turn triggers.
  if (options?.turnTriggerNote !== undefined) {
    elements.push({ tag: 'markdown', content: t.stepAutoTriggerNote(options.turnTriggerNote), text_size: 'notation' })
  }

  // A step with nothing to render still needs a body: name what the step is
  // doing (by live phase) or that it produced nothing, rather than leaving the
  // card blank. `thinking` is the placeholder opened at `step/start`; `done` is
  // its terminal form when the step ends without ever producing visible content.
  const emptyPhase = options?.empty
  const phase: StepLivePhase = options?.phase ?? 'none'
  if (emptyPhase !== undefined) {
    elements.push({
      tag: 'markdown',
      content: emptyPhase === 'done'
        ? t.stepEmptyBody
        : phase === 'awaiting' ? t.stepAwaitingBody
          : phase === 'thinking' ? t.stepThinkingBody
            : phase === 'replying' ? t.stepReplyingBody
              : t.stepPlaceholderBody,
      text_size: 'notation',
    })
    // The route belongs to the wait: it answers "which model is this request
    // sitting at" while there is nothing else on the card. Shown for `awaiting`
    // only — once output exists, the card has more useful things to say.
    if (emptyPhase === 'thinking' && phase === 'awaiting' && options?.route !== undefined) {
      elements.push({
        tag: 'markdown',
        content: t.stepRouteLine(options.route.provider, options.route.model),
        text_size: 'notation',
      })
    }
  }

  // Reasoning section. The level decides HOW MUCH and whether it folds:
  //
  //   preview — the header plus the first line (the WebUI's `settledReasoningPreview`);
  //   head    — a folded panel whose body is the first REASONING_HEAD_CAP characters;
  //   full    — a folded panel with the whole chain.
  //
  // Folding is what makes `full` affordable: the panel is collapsed by default,
  // so a long chain no longer eats the card, and the CAP that used to exist only
  // to protect the layout is no longer needed for `full`. Use 4 backticks inside
  // the panel to avoid colliding with a code fence in the reasoning itself.
  if (reasoning !== undefined && reasoning !== '' && display.reasoning !== 'off') {
    const meta: string[] = []
    if (reasoningMs !== undefined && reasoningMs > 0) meta.push(formatMsShort(reasoningMs))
    const reasoningTokens = usage?.reasoningTokens
    if (reasoningTokens !== undefined && reasoningTokens > 0) {
      meta.push(`${formatTokenCount(reasoningTokens)} tokens`)
    }
    const header = meta.length > 0 ? `${t.stepReasoningHeader} · ${meta.join(' · ')}` : t.stepReasoningHeader
    if (display.reasoning === 'preview') {
      const firstLine = reasoning.split('\n').find(line => line.trim() !== '') ?? reasoning
      // `truncateInline`: the preview renders as a blockquote (live markdown), so
      // a cut inside `**…**` would print the markers to the reader.
      const preview = firstLine.trim().length > REASONING_PREVIEW_CAP
        ? truncateInline(firstLine.trim(), REASONING_PREVIEW_CAP)
        : firstLine.trim()
      elements.push({
        tag: 'markdown',
        content: preview === '' ? header : `${header}\n> ${preview}`,
      })
    } else {
      const body = display.reasoning === 'full'
        ? reasoning
        : reasoning.length > REASONING_HEAD_CAP
          ? `${reasoning.slice(0, REASONING_HEAD_CAP)}\n…(truncated)`
          : reasoning
      // Collapsed by default: the header (with its duration and token count)
      // is the summary, the chain is one tap away. `foldedPanel` gives every
      // fold the same visible chrome and the "已折叠 · 点击展开" hint — without
      // it a reader has no way to tell there is anything behind the header.
      elements.push(foldedPanel(t, header, [
        { tag: 'markdown', content: `\`\`\`\`\`\n${body}\n\`\`\`\`\`` },
      ]))
    }
  }

  // Text section — with a title, mirroring the Reasoning / Tool Call sections.
  // Overflow beyond TEXT_STEP_CAP is sent as follow-up "continued" cards in
  // the turn/end handler; the step card shows segment 0 of that same split, so
  // the two always agree and neither can cut a block in half.
  if (text !== undefined && text !== '') {
    const displayText = text.length > TEXT_STEP_CAP
      ? chunkText(text, TEXT_STEP_CAP, MAX_OVERFLOW_CARDS + 1)[0] ?? text
      : text
    // `compact` has exactly one section, so a label naming it ("📝 消息") labels
    // nothing and costs a paragraph break. At the other levels the label is what
    // tells this section apart from reasoning and tool calls.
    if (!tight && elements.length > 0) elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: tight ? displayText : `${t.stepMessageHeader}\n\n${displayText}` })
  }

  // Tool calls section. `count` collapses the whole section to one line of
  // totals (the `compact` level); `summary` names each call but carries no
  // payloads (the `standard` level); `full` is the original rendering.
  if (tools.length > 0 && display.tools === 'count') {
    if (elements.length > 0) elements.push({ tag: 'hr' })
    const failed = tools.filter(tool => tool.result?.isError === true).length
    elements.push({ tag: 'markdown', content: t.stepToolCount(tools.length, failed) })
  } else if (tools.length > 0) {
    if (elements.length > 0) {
      elements.push({ tag: 'hr' })
      elements.push({ tag: 'markdown', content: t.stepToolHeader })
    }
    for (const tool of tools) {
      const toolLines: string[] = []

      // Description BEFORE title. Prefer a presentCall view when one is ever
      // attached (the DSH 0.1.2-alpha.1 seam does not emit it), else restore
      // the summary by deriving it from the call arguments (Web UI behavior).
      const description = tool.callView?.description
        ?? tool.callView?.title
        ?? deriveToolSummary(tool.toolName, typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments ?? ''))
      if (description !== undefined && description !== '') {
        toolLines.push(`> ${description}`)
      }

      // Always show the tool function name (read, bash, web_search, etc.) as inline code
      if (tool.result !== undefined) {
        const icon = tool.result.isError ? '❌' : '✅'
        const status = tool.result.isError ? t.stepToolError : t.stepToolSuccess
        toolLines.push(`${icon} \`${tool.toolName}\` — ${status} ${tool.result.elapsed >= 1000 ? `${(tool.result.elapsed / 1000).toFixed(1)}s` : `${tool.result.elapsed}ms`}`)
      } else {
        toolLines.push(`⏳ \`${tool.toolName}\` — running…`)
      }

      elements.push({ tag: 'markdown', content: toolLines.join('\n') })

      // Args in a dedicated fenced code block: it wraps/scrolls instead of
      // overflowing, and tolerates backticks/newlines that would otherwise
      // break the inline `...` formatting. Label it so it is not confused
      // with the tool result block below. Args are shown in full detail
      // (pretty-printed JSON) up to a generous cap so the reader can see the
      // actual parameters, not an ellipsized digest. Suppressed unless the
      // resolved policy allows argument blocks (level `detailed`/`verbose` AND
      // the `showToolArgs` switch on).
      if (display.toolArgs) {
        const argsCode = sanitizeCodeblock(formatToolArgs(tool.arguments, display.fullToolOutput))
        if (argsCode !== '') {
          elements.push({ tag: 'markdown', content: `${t.stepToolArgsHeader}\n\`\`\`\n${argsCode}\n\`\`\`` })
        }
      }

      // Result preview: dispatch on resultView.card type. Label the emitted
      // block(s) as the tool result so it is not confused with the args block.
      // Suppressed unless the resolved policy allows result previews.
      if (tool.result !== undefined && display.toolResults) {
        const resultElements = renderResultPreview(tool, display.fullToolOutput)
        if (resultElements.length > 0) {
          elements.push({ tag: 'markdown', content: t.stepToolResultHeader })
          elements.push(...resultElements)
        }
      }
    }
  }

  // Fallback
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: '*(empty)*' })
  }

  // Step footer: two notation lines — timing/tokens, then speed/context.
  const timingParts: string[] = []
  const speedParts: string[] = []
  if (stepDurationMs !== undefined && stepDurationMs > 0) {
    timingParts.push(stepDurationMs >= 1000
      ? `⏱ ${(stepDurationMs / 1000).toFixed(1)}s`
      : `⏱ ${stepDurationMs}ms`)
  }
  if (usage !== undefined) {
    // 📥 is the work THIS step did: the uncached prompt plus whatever was
    // written into the provider cache. Cache READS are excluded on purpose —
    // they are reused rather than processed again, and adding them back would
    // only restate the context occupancy on the next line (the full prompt is
    // the context). The Web UI shows the same three buckets in its trajectory
    // usage panel (input / cached / cache created); a card cannot afford the
    // full breakdown, so this collapses it to "new + reuse rate".
    //
    // DeepSeek reports no cache-write bucket, so there `📥` is exactly the
    // adapter's `inputTokens` (its cache misses); OpenAI-compatible routes
    // behave the same. Anthropic-style explicit caching reports writes
    // separately, and those are real work too, hence the addition above.
    const cacheRead = usage.cacheReadTokens ?? 0
    const freshIn = usage.inputTokens + (usage.cacheWriteTokens ?? 0)
    const promptTotal = freshIn + cacheRead
    const hitRate = cacheRead > 0 && promptTotal > 0 ? Math.round(cacheRead / promptTotal * 100) : undefined
    const output = formatTokenCount(usage.outputTokens)
    timingParts.push(hitRate === undefined
      ? `📥 ${formatTokenCount(freshIn)} → 📤 ${output}`
      : `📥 ${formatTokenCount(freshIn)} (♻️ ${hitRate}%) → 📤 ${output}`)
  }
  if (tps !== undefined && tps > 0) {
    speedParts.push(`🚀 ${tps.toFixed(0)} tok/s`)
  }
  if (contextMeta !== undefined && contextMeta.contextWindow > 0 && contextMeta.lastInputTokens > 0) {
    // The ONLY place the full prompt size appears: with `📥` now reporting the
    // step's new input, this line owns "how big is the context and how full is
    // the window". The numerator is the last request's billed prompt (uncached
    // + cache reads + cache writes), which is exactly what the provider was
    // sent — the Web UI's context meter reads the same quantity from the
    // token-meter projection.
    const pct = Math.min(100, Math.round(contextMeta.lastInputTokens / contextMeta.contextWindow * 100))
    speedParts.push(`📊 ${formatTokenCount(contextMeta.lastInputTokens)}/${formatTokenCount(contextMeta.contextWindow)} (${pct}%)`)
  }
  if (timingParts.length > 0 || speedParts.length > 0) {
    // `compact`: the footer is a rule plus ONE element — each element costs its
    // own vertical spacing, and a two-line footer was paying it twice. The rule
    // was dropped when this footer was introduced; the user asked for it back
    // (2026-10-14): without it the footer reads as one more sentence of the
    // answer. It only appears when there IS an answer above it.
    if (tight) {
      // On the turn's last step the summary REPLACES the per-step timing line:
      // the turn totals are the same facts at turn scope, and printing both
      // would restate the same numbers one line apart (see `src/turn-summary.ts`
      // for what `compact` keeps). The speed line stays where it was. A summary
      // that came out EMPTY (the turn's stats never arrived) falls back to the
      // step's own timing line rather than leaving the footer to the speed line
      // alone.
      const completion = options?.completionLines
      const head = completion === undefined || completion.length === 0
        ? timingParts.join(' · ')
        : completion.join('\n')
      const footer = [head, speedParts.join(' · ')].filter(part => part !== '')
      if (elements.length > 0) elements.push({ tag: 'hr' })
      elements.push({ tag: 'markdown', content: footer.join('\n'), text_size: 'notation' })
    } else {
      elements.push({ tag: 'hr' })
      if (timingParts.length > 0) {
        elements.push({ tag: 'markdown', content: timingParts.join(' · '), text_size: 'notation' })
      }
      if (speedParts.length > 0) {
        elements.push({ tag: 'markdown', content: speedParts.join(' · '), text_size: 'notation' })
      }
    }
  }

  // Card title and color: determined only by tool status, not thinking content
  const hasTools = tools.length > 0
  const allToolsDone = hasTools && tools.every(t => t.result !== undefined)
  const anyToolError = hasTools && tools.some(t => t.result?.isError === true)

  let title: string
  let template: string
  /** This card ends the turn (the level has no Turn Complete card). */
  const finalCard = options?.completionTitle !== undefined
  if (finalCard) {
    // A finished turn's last card says so in its header, with the wall clock, and
    // goes green. Checked FIRST because the alternative — the card that ends the
    // turn still reading `回复` — is what the user reported (2026-10-14).
    title = options!.completionTitle!
    template = 'green'
  } else if (emptyPhase === 'thinking') {
    // Placeholder: the step exists but has produced nothing yet. WHICH phase it
    // is in decides the wording — `step/start` alone means DSH has not even
    // dispatched the request, so only `awaiting` and later may claim the model
    // is doing anything (O20).
    title = phase === 'awaiting' ? t.stepAwaitingTitle
      : phase === 'thinking' ? t.stepThinkingTitle
        : phase === 'replying' ? t.stepReplyingTitle
          : t.stepPlaceholderTitle
    template = phase === 'replying' ? 'blue' : phase === 'awaiting' ? 'wathet' : 'violet'
  } else if (emptyPhase === 'done') {
    title = t.stepEmptyTitle
    template = 'grey'
  } else if (hasTools && allToolsDone && anyToolError) {
    title = t.stepCardTitleError
    template = 'red'
  } else if (hasTools && allToolsDone) {
    title = t.stepCardTitleDone
    template = 'green'
  } else if (hasTools) {
    title = t.stepCardTitleCall
    template = 'wathet'
  } else {
    title = t.stepCardTitleReply
    template = 'blue'
  }

  // Append the step's position in the conversation so consecutive step cards
  // can be told apart at a glance (both numbers are 1-based in DSH). The final
  // card is the exception: its title is a state (`✅ 完成 · 2m14s`), and a
  // coordinate would dilute what the user asked it to say.
  const titleWithPosition = finalCard || turn === undefined || step === undefined
    ? title
    : `${title} · ${t.stepPosition(turn, step)}`

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: titleWithPosition },
      template,
    },
    body: {
      // The measured default element spacing reads as an empty line between
      // rows at `compact`, whose card is answer + one footer line. See 关键坑 58.
      ...(tight ? { vertical_spacing: STEP_CARD_ELEMENT_SPACING } : {}),
      elements,
    },
  }
}

/** Compact duration label for the reasoning header (`3.2s` / `850ms`). */
function formatMsShort(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/**
 * Render one tool result's raw text as a fenced code block, capped.
 */
function renderRawCode(content: string, lang = '', full = false): object[] {
  if (content === '') return []
  const cap = full ? RESULT_PREVIEW_CAP_FULL : RESULT_PREVIEW_CAP
  const output = content.length > cap ? content.slice(0, cap) + '…' : content
  return [{ tag: 'markdown', content: `\`\`\`${lang}\n${sanitizeCodeblock(output)}\n\`\`\`` }]
}

/**
 * Render a tool result preview. DSH 0.1.2-alpha.2 tools put a tool-private
 * `presentationMeta` JSON payload on `tool/result` (`event.data.meta`) whose
 * shape is OWNED BY THE TOOL — the `card: 'terminal' | 'read' | 'diff' | …`
 * vocabulary from the removed `presentResult` view does NOT appear on it.
 * Both the Web UI and this bridge therefore treat `meta` as opaque structured
 * data and recover the rich card by shape, falling back to the raw result text
 * when the shape is unknown. Every branch ends in `finish`, which guarantees
 * the raw content is shown when a matched shape renders nothing.
 */
function renderResultPreview(tool: StepToolCall, full = false): object[] {
  const rv = tool.resultView
  const elements: object[] = []
  const finish = (els: object[]): object[] => {
    if (els.length === 0 && tool.result !== undefined && tool.result.content !== '') {
      els.push(...renderRawCode(tool.result.content, '', full))
    }
    return els
  }

  // Search (grep/glob): `{ shape: 'paths', paths }` or `{ shape: 'matches', files }`.
  if (rv?.shape === 'paths' && Array.isArray(rv.paths)) {
    const paths = rv.paths.slice(0, 20)
    const lines = paths.map((p: string) => `- \`${p}\``)
    if (rv.truncated) lines.push(`*(showing ${paths.length} of ${rv.total})*`)
    if (lines.length > 0) elements.push({ tag: 'markdown', content: lines.join('\n') })
    return finish(elements)
  }
  if (rv?.shape === 'matches' && Array.isArray(rv.files)) {
    const lines: string[] = []
    for (const file of rv.files.slice(0, 5)) {
      lines.push(`**${file.path}**`)
      if (Array.isArray(file.matches)) {
        for (const m of file.matches.slice(0, 3)) {
          const line = typeof m.line === 'string' ? m.line : String(m.line ?? '')
          lines.push(`  ${m.lineNumber}: \`${line.trim()}\``)
        }
      }
    }
    if (rv.truncated) lines.push(`*(showing ${rv.files.length} files of ${rv.total} matches)*`)
    if (lines.length > 0) elements.push({ tag: 'markdown', content: lines.join('\n') })
    return finish(elements)
  }

  // Read (fs/read): `{ path, lines: [{ number, text }], lang }`.
  if (Array.isArray(rv?.lines) && rv.lines.length > 0 && typeof rv.lines[0]?.number === 'number') {
    const content = rv.lines
      .map((l: any) => `${String(l.number).padStart(4)}│ ${l.text}`)
      .slice(0, 30)
      .join('\n')
    elements.push({ tag: 'markdown', content: `\`\`\`${rv.lang ?? ''}\n${content}\n\`\`\`` })
    return finish(elements)
  }

  // Edit (fs/edit): `{ diffs: [{ path, oldText, newText }] }`.
  if (Array.isArray(rv?.diffs) && rv.diffs.length > 0 && rv.diffs.some((d: any) => d.oldText !== undefined || d.newText !== undefined)) {
    for (const diff of rv.diffs.slice(0, 3)) {
      const lines: string[] = []
      if (typeof diff.oldText === 'string' && typeof diff.newText === 'string') {
        const oldFirst = diff.oldText.split('\n').slice(0, 8)
        const newFirst = diff.newText.split('\n').slice(0, 8)
        for (const l of oldFirst) lines.push(`- ${l}`)
        for (const l of newFirst) lines.push(`+ ${l}`)
      }
      if (lines.length > 0) {
        elements.push({ tag: 'markdown', content: `**${diff.path}**\n\`\`\`diff\n${lines.join('\n')}\n\`\`\`` })
      }
    }
    return finish(elements)
  }

  // Legacy/fallback: a `card`-style view (no longer emitted by DSH tools, but
  // kept so any future view presentation still renders). Read-shape note: the
  // read branch is disambiguated above by `lines[0].number`; this safety net
  // only catches a card-typed sub-message.
  if (rv?.card === 'terminal' || rv?.card === 'web' || rv?.card === 'search'
    || rv?.card === 'read' || rv?.card === 'diff' || rv?.card === 'generic') {
    // These generally carry no renderable text by themselves (the real tools
    // export the model-facing text via `content`), so fall through to content.
    return finish(elements)
  }

  // Last resort: the raw result text is the authoritative source.
  if (tool.result !== undefined && tool.result.content !== '') {
    elements.push(...renderRawCode(tool.result.content, '', full))
  }

  return elements
}
