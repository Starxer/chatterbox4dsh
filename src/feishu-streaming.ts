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
import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import { translationsFor } from './i18n.ts'
import { expandAssistantStream, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { chunkText } from './text-chunk.ts'

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
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
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
}

/**
 * Identity of one sent step card. `cardId` is present only on the CardKit
 * instance path; otherwise the card is updated through `messageId` + patch.
 * `sequence` is the monotonic counter `cardkit.v1.card.update` requires.
 */
interface StepCardRef {
  messageId: Promise<string | undefined>
  cardId: Promise<string | undefined>
  sequence: number
}

/** Public deps for the unified per-step module. */
export interface FeishuStreamingDeps {
  ctx: Context
  channel: FeishuStreamingChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
  /** Whether to show reasoning content. */
  showReasoning?: () => boolean
  /** Current translations for the user's language. */
  getTranslations?: () => Translations
}

/** Per-step usage from assistant/message event. */
interface StepUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
  /** Full-call billed total (prompt + output) when the adapter reports it. */
  totalTokens?: number | undefined
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
  /** Sum of (stepStart → assistant/message) across steps — LLM-only time. */
  totalStepMs: number
  /** Sum of tool elapsed times. */
  totalToolMs: number
  /** Full wall-clock turn duration (turnStart → turnEnd), includes LLM + tools + gaps. */
  totalTurnMs: number
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
}

/** Per-session state for accumulating a step's content. */
interface SessionStepState {
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
  /** Whether the last assistant/message sent a step card with content. */
  lastStepHadContent: boolean
  // --- Timing fields (event.time from mux stream) ---
  stepStartTime: number
  firstTokenTime: number
  /** Time of assistant/message event (LLM inference complete). */
  messageTime: number
  /** Time of last tool/result or assistant/message (step fully complete). */
  completedTime: number
  usage: StepUsage | undefined
  /** Context window info for the current session (fetched once per turn). */
  contextMeta: { contextWindow: number; lastInputTokens: number } | undefined
  // --- Turn-level aggregation ---
  turnStats: TurnStats | undefined
}

/**
 * Subscribe to the apiproxy mux stream and render per-step assistant cards
 * in Feishu — one card per step containing reasoning, text, and tool calls.
 *
 * Returns a disposer, consumeReasoning, and consumeLastStepHadContent.
 */
export function startFeishuStreaming(deps: FeishuStreamingDeps): {
  stop: () => void
  consumeReasoning: (sessionId: string) => string | undefined
  consumeLastStepHadContent: (sessionId: string) => boolean
  flushed: (sessionId: string) => Promise<TurnStats | undefined>
} {
  const { ctx, channel, bridgeHolder, logger, showReasoning, getTranslations } = deps
  console.log('dsh-feishu: startFeishuStreaming (unified per-step cards)')
  const sessionStates = new Map<string, SessionStepState>()

  const getState = (sessionId: string): SessionStepState => {
    let state = sessionStates.get(sessionId)
    if (state === undefined) {
      state = {
        reasoning: '',
        text: '',
        toolCalls: [],
        stepCardSent: false,
        stepCardRef: undefined,
        pendingSend: undefined,
        chat: undefined,
        lastStepHadContent: false,
        stepStartTime: 0,
        firstTokenTime: 0,
        messageTime: 0,
        completedTime: 0,
        usage: undefined,
        contextMeta: undefined,
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
    state.stepCardSent = false
    state.stepCardRef = undefined
    state.pendingSend = undefined
    // NOTE: do NOT clear state.chat — it is session-level chat coordinates,
    // not per-step data. Clearing it prevents step 2+ from sending cards
    // when the step has only tool calls (no text/reasoning), causing tool
    // calls from different steps to appear merged on the previous step's card.
    state.stepStartTime = 0
    state.firstTokenTime = 0
    state.messageTime = 0
    state.completedTime = 0
    state.usage = undefined
  }

  /** Build the unified card content for the current step state. */
  const buildStepCard = (state: SessionStepState): object => {
    const showR = showReasoning?.() !== false && state.reasoning.trim() !== ''
    const reasoning = showR ? state.reasoning.trim() : undefined
    const text = state.text.trim() !== '' ? state.text.trim() : undefined
    const tools = state.toolCalls

    // Use real-time elapsed duration so the card always shows accurate time,
    // even while tools are still running.
    const stepDurationMs = state.stepStartTime > 0
      ? Date.now() - state.stepStartTime
      : undefined

    // Token output speed: output tokens ÷ LLM decode time (first token →
    // assembled message). TTFT and tool time are excluded — the same
    // semantics as the Turn Complete card and /status. Only computed once
    // the assembled message's timestamp is known: falling back to Date.now()
    // here would keep growing while tools run and show a misleadingly low
    // tok/s on every refresh.
    let tps: number | undefined
    if (state.usage !== undefined && state.usage.outputTokens > 0 && state.firstTokenTime > 0 && state.messageTime > state.firstTokenTime) {
      const decodeMs = state.messageTime - state.firstTokenTime
      if (decodeMs > 0) tps = state.usage.outputTokens / (decodeMs / 1000)
    }

    return renderStepCard(getTranslations?.() ?? translationsFor('zh'), reasoning, text, tools, state.usage, stepDurationMs, tps, state.contextMeta)
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
    // Mark this session as having sent intermediate content so channel.ts
    // can skip the duplicate reply card and only send the footer.
    const hasText = state.text.trim() !== ''
    if (hasText) {
      bridgeHolder.current?.markIntermediateSent(sessionId)
    }
    const opts = chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {}
    // Prefer a CardKit card instance: its update API has no edit cap, unlike
    // im.v1.message.patch, so a long step cannot silently kill the card.
    const useInstance = channel.createCardInstance !== undefined && channel.sendCardByReference !== undefined
    const cardId: Promise<string | undefined> = useInstance
      ? channel.createCardInstance!(card).then((id) => {
        console.log(`dsh-feishu: [send] instance card=${id}`)
        return id
      }).catch((error: unknown) => {
        console.log(`dsh-feishu: [send] card instance create failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
      : Promise.resolve(undefined)
    const messageId = cardId.then((id) => {
      if (id !== undefined) {
        return channel.sendCardByReference!(chat.chatId, id, opts).then((r) => {
          console.log(`dsh-feishu: [send] message=${r.messageId ?? '-'} via card=${id}`)
          return r.messageId
        }).catch((error: unknown) => {
          console.log(`dsh-feishu: [send] send by reference failed: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        })
      }
      return channel.send(chat.chatId, { card }, opts).then((r) => {
        console.log(`dsh-feishu: [send] message=${r.messageId ?? '-'} via send`)
        return r.messageId
      }).catch((error: unknown) => {
        console.log(`dsh-feishu: [send] step card send failed: ${error instanceof Error ? error.message : String(error)}`)
        logger.warn(`dsh-feishu: step card send failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
    })
    state.stepCardRef = { messageId, cardId, sequence: 0 }
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
    card: object
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

  /** Turn stats per session, stored independently of flush promise timing. */
  const turnStatsMap = new Map<string, TurnStats>()

  /** Execute a card update (shared by debounce timer and flush). */
  const executeCardUpdate = (
    ref: StepCardRef,
    card: object,
  ): Promise<void> => {
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
              return
            }
            ref.sequence += 1
            console.log(`dsh-feishu: [update] card=${cardId} seq=${ref.sequence}`)
            return channel.updateCardInstance!(cardId, card, ref.sequence)
          })
        }
        console.log('dsh-feishu: [update] no card instance, falling back to patch')
        return patchByMessageId(ref, card)
      }).catch((error: unknown) => {
        console.log(`dsh-feishu: [update] failed: ${error instanceof Error ? error.message : String(error)}`)
        logger.warn(`dsh-feishu: step card update failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return patchByMessageId(ref, card)
  }

  /** Fallback update path: im.v1.message.patch on the sent message. */
  const patchByMessageId = (ref: StepCardRef, card: object): Promise<void> => {
    return ref.messageId.then((messageId) => {
      if (messageId !== undefined) {
        console.log(`dsh-feishu: [update] patch message=${messageId}`)
        return channel.updateCard(messageId, card)
      }
      console.log('dsh-feishu: [update] messageId is undefined, skipping')
    }).catch((error: unknown) => {
      console.log(`dsh-feishu: [update] failed: ${error instanceof Error ? error.message : String(error)}`)
      logger.warn(`dsh-feishu: step card update failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Flush the pending debounce timer for a state, executing the updateCard immediately. */
  const flushPendingUpdate = (state: SessionStepState): Promise<void> => {
    const ref = state.stepCardRef
    if (ref === undefined) return Promise.resolve()
    const entry = pendingUpdates.get(ref)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      pendingUpdates.delete(ref)
      console.log('dsh-feishu: [update] flushing pending update for turn/end')
      return executeCardUpdate(ref, entry.card)
    }
    return Promise.resolve()
  }

  /** Update the existing step card with current state (debounced). */
  const updateStepCard = (state: SessionStepState): void => {
    if (!state.stepCardSent || state.stepCardRef === undefined) {
      console.log(`dsh-feishu: [update] skipped: sent=${state.stepCardSent} ref=${state.stepCardRef !== undefined}`)
      return
    }
    // Capture the ref and card NOW — resetStep may clear state before the timer fires
    const ref = state.stepCardRef
    const card = buildStepCard(state)
    // Clear previous pending update for THIS card (a different card's pending
    // update must survive — see the map's comment).
    const existing = pendingUpdates.get(ref)
    if (existing !== undefined) clearTimeout(existing.timer)
    // Debounce: merge rapid updates into one
    pendingUpdates.set(ref, {
      card,
      timer: setTimeout(() => {
        pendingUpdates.delete(ref)
        executeCardUpdate(ref, card).catch((error: unknown) => {
          console.log(`dsh-feishu: [update] timer callback error: ${error instanceof Error ? error.message : String(error)}`)
        })
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
          } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            state.text += chunk.text
            // Record first token time for text (if no reasoning came first).
            if (state.firstTokenTime === 0) {
              state.firstTokenTime = event.time ?? Date.now()
            }
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
              if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                state.reasoning += chunk.text
                if (state.firstTokenTime === 0) state.firstTokenTime = timed.time
              } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                state.text += chunk.text
                if (state.firstTokenTime === 0) state.firstTokenTime = timed.time
              }
            }
          } catch (streamError: unknown) {
            console.log(`dsh-feishu: [message] expandAssistantStream failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`)
          }
        }

        // The assembled message arrived. Record usage and message time.
        state.messageTime = event.time ?? Date.now()
        state.completedTime = state.messageTime
        const usage = event.data?.usage
        if (usage !== undefined && usage !== null) {
          state.usage = {
            inputTokens: (usage.inputTokens as number) ?? 0,
            outputTokens: (usage.outputTokens as number) ?? 0,
            cacheReadTokens: (usage.cacheReadTokens as number | undefined),
            cacheWriteTokens: (usage.cacheWriteTokens as number | undefined),
            totalTokens: (usage.totalTokens as number | undefined),
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
          }
          if (state.stepStartTime > 0 && state.messageTime > state.stepStartTime) {
            ts.totalStepMs += state.messageTime - state.stepStartTime
          }
        }

        const hasContent = state.reasoning.trim() !== '' || state.text.trim() !== ''
        if (hasContent) {
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
        }
        // tool/call no longer carries a presentation view on the session
        // event; callView stays undefined and renderStepCard falls back to
        // the tool name and arguments.
        state.toolCalls.push(toolCall)

        if (state.stepCardSent) {
          updateStepCard(state)
        } else {
          queueStepCardSend(chat, sessionId, state)
        }
      } else if (event.type === 'tool/result') {
        const toolCallId = String(event.data?.message?.source?.callId ?? '')
        const toolCall = state.toolCalls.find(t => t.callId === toolCallId)
        console.log(`dsh-feishu: [result] callId=${toolCallId} found=${toolCall !== undefined} toolsInState=${state.toolCalls.length} stepCardSent=${state.stepCardSent}`)

        if (toolCall !== undefined) {
          // `ToolResultMessage.content` is `[ToolResultBlock]` whose real
          // content blocks nest at `.content[0].content`. Reading the outer
          // array directly yielded nothing (its block type is `tool-result`,
          // not `text`), which is why tool output had disappeared. Mirror the
          // Web UI, which reads `message.content[0]` → `{ content, isError }`.
          const resultBlock = Array.isArray(event.data?.message?.content)
            ? event.data.message.content[0]
            : undefined
          const isError = event.data?.error !== undefined
            || resultBlock?.isError === true
            || event.data?.message?.content?.[0]?.isError === true
          const resultContent = resultBlock?.content ?? event.data?.message?.content
          const result = Array.isArray(resultContent)
            ? resultContent.map((b: { type: string; text?: string }) => b.type === 'text' ? b.text ?? '' : '').filter(Boolean).join('\n')
            : resultContent
          const elapsed = Date.now() - toolCall.startedAt

          toolCall.result = {
            isError,
            content: summarizeValue(result, RESULT_CONTENT_CAP) || '',
            elapsed,
          }
          // tool/result carries a tool-private `meta` payload — the
          // presentResult view on 0.1.2-alpha.1. Use it as the result view
          // when present so the rich card rendering kicks in.
          if (event.data?.meta !== undefined) {
            toolCall.resultView = event.data.meta
          }

          if (state.stepCardSent) {
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
      } else if (event.type === 'turn/start') {
        resetStep(state)
        lastStepSendPromises.delete(sessionId)
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
          totalStepMs: 0,
          totalToolMs: 0,
          totalTurnMs: 0,
        }
        let resolve!: () => void
        const promise = new Promise<void>((r) => { resolve = r })
        flushPromises.set(sessionId, { promise, resolve })
        bridge.getSessionMeta(chat).then((meta) => {
          state.contextMeta = {
            contextWindow: state.contextMeta?.contextWindow || meta.contextWindow,
            lastInputTokens: state.contextMeta?.lastInputTokens || meta.lastInputTokens,
          }
          if (state.stepCardSent) updateStepCard(state)
        }).catch(() => undefined)
      } else if (event.type === 'request/context') {
        const cw = event.data?.contextWindow as number | undefined
        if (cw !== undefined && cw > 0) {
          state.contextMeta = {
            contextWindow: cw,
            lastInputTokens: state.contextMeta?.lastInputTokens ?? 0,
          }
          if (state.stepCardSent) updateStepCard(state)
        }
      } else if (event.type === 'turn/end') {
        const turnStats = state.turnStats
        if (turnStats !== undefined) {
          const now = event.time ?? Date.now()
          turnStats.totalTurnMs = now - turnStats.turnStartTime
          turnStatsMap.set(sessionId, turnStats)
        }

        // A very short final step can end inside the send debounce window;
        // post its card before anything else so it precedes the overflow and
        // Turn Complete cards in the chat.
        flushPendingSend(state)

        // Capture overflow data BEFORE resetStep clears state.
        const fullText = state.text.trim()
        const overflowText = fullText.length > TEXT_STEP_CAP ? fullText.slice(TEXT_STEP_CAP).trim() : undefined
        const overflowChat = state.chat
        const overflowOpts = overflowChat !== undefined
          ? overflowChat.threadId !== undefined
            ? { replyInThread: true, ...(overflowChat.rootId !== undefined ? { replyTo: overflowChat.rootId } : {}) }
            : {}
          : undefined

        const hasOverflow = overflowText !== undefined && overflowText !== '' && overflowChat !== undefined && overflowOpts !== undefined
        const overflowChunks = hasOverflow ? chunkText(overflowText!, TEXT_STEP_CAP) : []

        flushPendingUpdate(state).then(async () => {
          // Step card is now on screen with the first TEXT_STEP_CAP chars.
          // Send overflow text as follow-up "continued" cards so the full
          // reply is delivered without silent truncation.
          if (overflowChunks.length > 0 && overflowChat !== undefined && overflowOpts !== undefined) {
            for (let i = 0; i < overflowChunks.length; i++) {
              await channel.send(overflowChat.chatId, { card: renderOverflowCard(overflowChunks[i]!, i + 1, overflowChunks.length) }, overflowOpts)
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
  const flushed = (sessionId: string): Promise<TurnStats | undefined> => {
    const entry = flushPromises.get(sessionId)
    const lastSend = lastStepSendPromises.get(sessionId)
    const flushReady = entry !== undefined ? entry.promise : Promise.resolve()
    return flushReady
      // Wait for the last step card's message to be created so the Turn
      // Complete footer never overtakes the final step card in the chat.
      .then(() => lastSend)
      .then(() => turnStatsMap.get(sessionId))
  }

  return {
    stop: () => {
      disposeListener()
      for (const entry of pendingUpdates.values()) clearTimeout(entry.timer)
      pendingUpdates.clear()
      for (const state of sessionStates.values()) {
        if (state.pendingSend !== undefined) clearTimeout(state.pendingSend.timer)
      }
      sessionStates.clear()
      turnStatsMap.clear()
      lastStepSendPromises.clear()
      for (const entry of flushPromises.values()) entry.resolve()
      flushPromises.clear()
    },
    consumeReasoning,
    consumeLastStepHadContent,
    flushed,
  }
}

/** Cap for one tool call's kept raw result content (characters). */
const RESULT_CONTENT_CAP = 1500

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

/** Cap for one tool result preview rendered into the card (characters). */
const RESULT_PREVIEW_CAP = 1500

/** Max reasoning characters shown on a step card (preview only). */
const REASONING_CAP = 200

/** Cap for one tool call's args rendered in the fenced code block (characters). */
const ARGS_DISPLAY_CAP = 2000

/** Cap for the text section of a step card (characters). Overflow is sent as
 *  follow-up "continued" cards so no content is silently dropped. */
const TEXT_STEP_CAP = 3000

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
function formatToolArgs(value: unknown): string {
  if (value === undefined || value === null) return ''
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
  return str.length > ARGS_DISPLAY_CAP ? str.slice(0, ARGS_DISPLAY_CAP) + '\n…' : str
}

/** Sanitize raw content for embedding in a fenced code block: collapse any
 *  run of backticks (which would close the fence) and strip control chars. */
function sanitizeCodeblock(text: string): string {
  return text
    .replace(/`+/g, '`')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
}

/**
 * Render a follow-up "continued" card for overflow text that exceeded the step
 * card's TEXT_STEP_CAP. No reasoning (already shown on the step card), no
 * footer (footer is sent separately by channel.ts).
 */
function renderOverflowCard(text: string, part: number, total: number): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: total > 1 ? `Reply (continued ${part}/${total})` : 'Reply (continued)' },
      template: 'blue',
    },
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
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
  const variant = classifyToolSummary(toolName)
  const base = deriveToolSummaryValue(variant, argsRaw)
  const titled = TOOL_SUMMARY_TITLED.has(toolName)
  return variant === 'others' && toolName !== '' && !titled
    ? `${toolName} · ${base}`
    : base
}

/**
 * Render a unified per-step card with reasoning, text, and tool calls.
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
): object {
  const elements: object[] = []

  // Reasoning section (use 4 backticks to avoid collision with code blocks in reasoning).
  // Reasoning is a preview only: keep a short window, never the full chain.
  if (reasoning !== undefined && reasoning !== '') {
    const displayReasoning = reasoning.length > REASONING_CAP ? reasoning.slice(0, REASONING_CAP) + '\n…(truncated)' : reasoning
    elements.push({
      tag: 'markdown',
      content: `${t.stepReasoningHeader}\n\`\`\`\`\`\n${displayReasoning}\n\`\`\`\`\``,
    })
  }

  // Text section — with a title, mirroring the Reasoning / Tool Call sections.
  // Overflow beyond TEXT_STEP_CAP is sent as follow-up "continued" cards in
  // the turn/end handler; the step card itself shows only the first segment.
  if (text !== undefined && text !== '') {
    const displayText = text.length > TEXT_STEP_CAP ? text.slice(0, TEXT_STEP_CAP) : text
    if (elements.length > 0) elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `${t.stepMessageHeader}\n\n${displayText}` })
  }

  // Tool calls section
  if (tools.length > 0) {
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
      // actual parameters, not an ellipsized digest.
      const argsCode = sanitizeCodeblock(formatToolArgs(tool.arguments))
      if (argsCode !== '') {
        elements.push({ tag: 'markdown', content: `${t.stepToolArgsHeader}\n\`\`\`\n${argsCode}\n\`\`\`` })
      }

      // Result preview: dispatch on resultView.card type. Label the emitted
      // block(s) as the tool result so it is not confused with the args block.
      if (tool.result !== undefined) {
        const resultElements = renderResultPreview(tool)
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

  // Step footer: duration + token counts + output speed + context %
  const footerParts: string[] = []
  if (stepDurationMs !== undefined && stepDurationMs > 0) {
    footerParts.push(stepDurationMs >= 1000
      ? `⏱ ${(stepDurationMs / 1000).toFixed(1)}s`
      : `⏱ ${stepDurationMs}ms`)
  }
  if (usage !== undefined) {
    const billedIn = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    footerParts.push(`📥 ${formatTokenCount(billedIn)} → 📤 ${formatTokenCount(usage.outputTokens)}`)
  }
  if (tps !== undefined && tps > 0) {
    footerParts.push(`🚀 ${tps.toFixed(0)} tok/s`)
  }
  if (contextMeta !== undefined && contextMeta.contextWindow > 0 && contextMeta.lastInputTokens > 0) {
    const pct = Math.min(100, Math.round(contextMeta.lastInputTokens / contextMeta.contextWindow * 100))
    footerParts.push(`📊 ${formatTokenCount(contextMeta.lastInputTokens)}/${formatTokenCount(contextMeta.contextWindow)} (${pct}%)`)
  }
  if (footerParts.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: footerParts.join(' · '), text_size: 'notation' })
  }

  // Card title and color: determined only by tool status, not thinking content
  const hasTools = tools.length > 0
  const allToolsDone = hasTools && tools.every(t => t.result !== undefined)
  const anyToolError = hasTools && tools.some(t => t.result?.isError === true)

  let title: string
  let template: string
  if (hasTools && allToolsDone && anyToolError) {
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

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    body: { elements },
  }
}

/**
 * Render one tool result's raw text as a fenced code block, capped.
 */
function renderRawCode(content: string, lang = ''): object[] {
  if (content === '') return []
  const output = content.length > RESULT_PREVIEW_CAP ? content.slice(0, RESULT_PREVIEW_CAP) + '…' : content
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
function renderResultPreview(tool: StepToolCall): object[] {
  const rv = tool.resultView
  const elements: object[] = []
  const finish = (els: object[]): object[] => {
    if (els.length === 0 && tool.result !== undefined && tool.result.content !== '') {
      els.push(...renderRawCode(tool.result.content))
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
    elements.push(...renderRawCode(tool.result.content))
  }

  return elements
}
