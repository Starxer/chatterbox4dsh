/**
 * Feishu UI bridge for the `ask_user_question` tool: registers a prepended
 * `user-questions/request` waterfall listener so a Feishu-bound session renders
 * an interactive card with the question and options, and returns the user's
 * pick through the listener's resolved promise.
 *
 * The same request is also delegated to the WebUI answerer, so a question pops
 * on both surfaces; the first answer wins and the other card is retired
 * (`dual-answerer.ts` explains the mechanism).
 *
 * @module @starxer/chatterbox4dsh/feishu-questions
 */

import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionItem, AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionOption, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// Side-effect import: augments `@deepseek-ai/cordis` with `'user-questions/request'`.
import '@deepseek-ai/dsh-user-questions'

// Local module augmentation: dsh-user-questions itself does not extend
// cordis.Events with the waterfall key, so we do it here for type-safe
// `ctx.on('user-questions/request', ...)` access.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'user-questions/request'(this: Context, request: AskUserQuestionRequest, next?: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>
  }
}
import type { HarnessConversationService } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import { translationsFor } from './i18n.ts'
import { firstDefined, installSignalGate, type AnswererResult } from './dual-answerer.ts'
import { renderAnsweredElsewhereCard, renderSupersededCard } from './card-supersede.ts'

/** Minimal logger surface the listener needs; matches ctx.logger's call style. */
interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Source of the current bridge — recreated on every channel reconcile. */
interface BridgeHolder {
  current: HarnessConversationService | undefined
}

/** Per-question state for the card click handler. */
interface PendingCard {
  pendingId: string
  question: AskUserQuestionItem
  sessionId: string
  abortController: AbortController
  /** Resolves when the user picks an option (or the request is aborted). */
  resolve: (answer: AskUserQuestionAnswer | undefined) => void
  /** Message ID of the sent card, used to update it after selection. */
  cardMessageId?: string
  /** Where the question card was posted, so follow-up cards land in the same
   *  topic without ever inferring it from the group (hard rule 3 / pitfall 31). */
  chat: ConversationMessage
  /** Single-select row tap awaiting a confirmation card (one open at a time).
   *  `| undefined` is explicit because `exactOptionalPropertyTypes` is on. */
  confirm?: { label: string; messageId?: string; sending?: boolean } | undefined
}

/**
 * Channel adapter passed into the questions listener. The `currentChannel()`
 * accessor is read on every send so the listener transparently follows the
 * channel after a LarkRuntime reconcile. The `onCardAction()` helper attaches
 * a cardAction listener to whatever channel is currently active and rebinds
 * automatically on reconcile.
 */
export interface FeishuQuestionsChannel {
  /** Send a card or text to the chat. */
  send(to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  /** Subscribe to interactive-card button clicks. The handler is invoked on
   *  every channel that connects for the lifetime of this subscription. */
  onCardAction(handler: (evt: CardActionLike) => void | Promise<void>): () => void
}

/** Subset of CardActionEvent the listener consumes. */
interface CardActionLike {
  messageId?: string
  chatId?: string
  operator?: { openId?: string }
  action?: { value?: unknown; tag?: string; option?: string }
  /** Raw event from Feishu (available when includeRawEvent is true).
   *  Contains action.form_value for form container submissions. */
  raw?: { action?: { value?: unknown; tag?: string; option?: string; form_value?: Record<string, unknown> } }
}

/** Public surface the questions module reads. */
export interface FeishuQuestionsDeps {
  ctx: Context
  channel: FeishuQuestionsChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
}

/**
 * Register a `user-questions/request` waterfall listener on the host context.
 * The listener is invoked for every `ask_user_question` call, claims the
 * request by returning an answer (skipping the default tool-ask-user
 * provider), and detaches its cardAction subscription on dispose.
 *
 * @param deps Live references to the host context, the Lark channel, and
 *   the current bridge. The bridge is read lazily because `runtime.reconcile()`
 *   replaces it; re-resolving on every question handles that case naturally.
 * @returns a disposer that detaches the listener and the cardAction handler.
 */
export function startFeishuQuestions(deps: FeishuQuestionsDeps): () => void {
  const { ctx, channel, bridgeHolder, logger, getTranslations } = deps
  const pendingCards = new Map<string, PendingCard>()

  // Build an answer from a card click and resolve the matching pending
  // promise. The listener is what returns the answer to the waterfall; this
  // helper is purely the cardAction → deferred bridge.
  const settlePending = (pending: PendingCard, selected: readonly string[], custom: string | undefined): AskUserQuestionAnswer => {
    pendingCards.delete(pending.pendingId)
    return {
      answers: [{
        id: pending.question.id,
        selected: [...selected],
        ...custom === undefined ? {} : { custom },
      }],
    }
  }

  /** Update a card, logging (never throwing) when the patch fails. */
  const updateCardQuiet = async (messageId: string, card: object): Promise<void> => {
    await channel.updateCard(messageId, card).catch((error: unknown) => {
      logger.warn(`dsh-feishu: failed to update question card: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Post a card into the same chat/topic the question card went to. */
  const postInChat = async (chat: ConversationMessage, card: object): Promise<string | undefined> => {
    const result = await channel.send(chat.chatId, { card }, chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {})
    return (result as { messageId?: string })?.messageId
  }

  /**
   * Finish a single-select answer: mark the question card settled, close the
   * confirmation card, and resolve the pending promise. Each card is written at
   * most once here (pitfall 11).
   */
  const submitAnswer = async (pending: PendingCard, labels: readonly string[]): Promise<void> => {
    const t = getTranslations()
    const questionCardId = pending.cardMessageId
    // The result is posted as a NEW card and the (frozen) question card turns
    // into a grey pointer to it — the same shape as "Back", so the end state of
    // either branch is identical (operator's 2026-10-07 decision).
    let posted: string | undefined
    try {
      posted = await postInChat(pending.chat, renderSettledQuestionCard(pending.question, labels, t))
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: failed to post the answer result card: ${reason}`)
    }
    if (questionCardId !== undefined) {
      // Without the new card the result has to live somewhere: fall back to
      // writing it into the question card itself.
      await updateCardQuiet(questionCardId, posted === undefined
        ? renderSettledQuestionCard(pending.question, labels, t)
        : renderSubmittedQuestionCard(t))
    }
    const confirmId = pending.confirm?.messageId
    pending.confirm = undefined
    if (confirmId !== undefined) await updateCardQuiet(confirmId, renderConfirmDoneCard(labels, t))
    pending.resolve(settlePending(pending, labels, undefined))
  }

  /**
   * A card that already delivered one tap may stop sending callbacks for its
   * clickable rows (the client keeps the tapped row "consumed"; its plain
   * buttons still work — measured 2026-10-07 15:37–15:38: the row tap after
   * Back never reached the plugin, while Skip on the same card did). So a spent
   * question card is replaced instead of patched: every re-pick happens on a
   * freshly sent card, and callbacks from any other card are ignored.
   */
  const isCurrentQuestionCard = (pending: PendingCard, messageId: string | undefined): boolean =>
    messageId === undefined || pending.cardMessageId === undefined || messageId === pending.cardMessageId

  const isCurrentConfirmCard = (pending: PendingCard, messageId: string | undefined): boolean =>
    messageId === undefined || pending.confirm?.messageId === undefined || messageId === pending.confirm.messageId

  /** Post a fresh, fully interactive question card for the same pending question. */
  const reopenQuestionCard = async (pending: PendingCard): Promise<string | undefined> => {
    const options = pending.question.options ?? []
    const card = renderQuestionCard(
      pending.question,
      options,
      pending.pendingId,
      getTranslations(),
      pending.question.multiSelect === true && options.length > 0,
    )
    return postInChat(pending.chat, card)
  }

  /** The message id of the confirmation card the tap came from. */
  const confirmMessageId = (pending: PendingCard, evt: CardActionLike): string | undefined =>
    evt.messageId ?? pending.confirm?.messageId

  const onCardAction = async (evt: CardActionLike): Promise<void> => {
    const action = evt.action
    let raw = action?.value
    let parsed: { pendingId?: unknown; questionId?: unknown; selected?: unknown; custom?: unknown; type?: unknown; probe?: unknown }
    if (typeof raw === 'string') {
      try {
        let result = JSON.parse(raw)
        if (typeof result === 'string') result = JSON.parse(result)
        parsed = result as typeof parsed
      } catch {
        return
      }
    } else if (typeof raw === 'object' && raw !== null) {
      parsed = raw as typeof parsed
    } else {
      return
    }
    const formValue = (evt.raw?.action?.form_value ?? {}) as Record<string, unknown>
    if (typeof parsed.probe === 'string') {
      // Probe cards (see `~/.dsh/probe-checker-card.py`) carry no pendingId.
      // Logging the raw form_value is the only way to learn a control's
      // submission shape: `cardkit.card.create` validates tags but not fields.
      console.log(`dsh-feishu: [q] probe=${parsed.probe} form_value=${JSON.stringify(formValue)}`)
      return
    }
    const pendingId = typeof parsed.pendingId === 'string' ? parsed.pendingId : ''
    const questionId = typeof parsed.questionId === 'string' ? parsed.questionId : ''
    if (pendingId === '' || questionId === '') return
    const pending = pendingCards.get(pendingId)
    if (pending === undefined) return

    // Confirmations come from the confirmation card; everything else comes from
    // the current question card. Taps on a retired card are ignored.
    const fromConfirmCard = parsed.type === 'answer-confirm' || parsed.type === 'answer-back'
    if (fromConfirmCard) {
      if (!isCurrentConfirmCard(pending, evt.messageId)) return
    } else if (!isCurrentQuestionCard(pending, evt.messageId)) {
      return
    }

    if (parsed.type === 'multi-submit') {
      // One submission for every checked box (`checker` elements in a form).
      console.log(`dsh-feishu: [q] multi-submit form_value=${JSON.stringify(formValue)}`)
      const selected = readMultiSelection(formValue, pending.question.options ?? [])
      if (selected.length === 0) {
        console.log('dsh-feishu: [q] multi-submit with nothing checked')
        return
      }
      if (pending.cardMessageId !== undefined) {
        const settledCard = renderSettledQuestionCard(pending.question, selected, getTranslations())
        await channel.updateCard(pending.cardMessageId, settledCard).catch((error: unknown) => {
          logger.warn(`dsh-feishu: failed to update question card: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      pending.resolve(settlePending(pending, selected, undefined))
      return
    }

    if (parsed.type === 'skip') {
      const answer = settlePending(pending, [], undefined)
      if (pending.cardMessageId !== undefined) {
        const settledCard = renderSettledQuestionCard(pending.question, [`⏭️ ${getTranslations().questionSkippedLabel}`], getTranslations())
        await channel.updateCard(pending.cardMessageId, settledCard).catch((error: unknown) => {
          logger.warn(`dsh-feishu: failed to update question card: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      pending.resolve(answer)
      return
    }

    if (parsed.type === 'answer-open') {
      // A clickable row answers on the first tap, so a mis-tap must be
      // recoverable: show what would be submitted and let the user confirm.
      const picked = Array.isArray(parsed.selected)
        ? parsed.selected.filter((item: unknown): item is string => typeof item === 'string')
        : []
      const label = picked[0]
      if (label === undefined) return
      const option = (pending.question.options ?? []).find(candidate => candidate.label === label)
      if (option === undefined) return
      if (pending.confirm !== undefined && pending.confirm.label === label) return
      const previous = pending.confirm
      pending.confirm = { label, sending: true }
      if (previous?.messageId !== undefined) {
        await updateCardQuiet(previous.messageId, renderConfirmBackCard(getTranslations()))
      }
      try {
        const t = getTranslations()
        const messageId = await postInChat(pending.chat, renderConfirmAnswerCard(pending.question, option, pendingId, t))
        if (pending.confirm?.label === label) {
          pending.confirm = { label, ...(messageId !== undefined ? { messageId } : {}) }
        }
        // Freeze the question card: a spent card keeps looking answerable, and
        // the client silently swallows any further row tap on it.
        if (pending.cardMessageId !== undefined) {
          await updateCardQuiet(pending.cardMessageId, renderFrozenQuestionCard(pending.question, option, t))
        }
      } catch (error: unknown) {
        // No confirmation card means the tap would be a dead end; answer
        // straight away instead (the behaviour before confirmations existed).
        const reason = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: failed to post the answer confirmation card, submitting directly: ${reason}`)
        pending.confirm = undefined
        await submitAnswer(pending, [label])
      }
      return
    }

    if (parsed.type === 'answer-confirm') {
      const picked = Array.isArray(parsed.selected)
        ? parsed.selected.filter((item: unknown): item is string => typeof item === 'string')
        : []
      if (picked.length === 0) return
      await submitAnswer(pending, picked)
      return
    }

    if (parsed.type === 'answer-back') {
      // The spent question card can no longer deliver row taps, so "Back" hands
      // the user a NEW question card and retires the old one as a grey notice
      // (pitfall 11's rule: one step, one card).
      const t = getTranslations()
      const spentMessageId = pending.cardMessageId
      const confirmId = confirmMessageId(pending, evt)
      let reopened: string | undefined
      try {
        reopened = await reopenQuestionCard(pending)
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: failed to reopen the question card after Back: ${reason}`)
      }
      if (reopened === undefined) {
        // Nothing to pick on: keep the confirmation card actionable so the
        // tapped answer is still reachable.
        logger.warn('dsh-feishu: question card could not be reopened; keeping the confirmation card open')
        return
      }
      pending.cardMessageId = reopened
      pending.confirm = undefined
      if (confirmId !== undefined) await updateCardQuiet(confirmId, renderConfirmBackCard(t))
      if (spentMessageId !== undefined && spentMessageId !== reopened) {
        await updateCardQuiet(spentMessageId, renderRetiredQuestionCard(t))
      }
      return
    }

    if (parsed.type === 'custom') {
      const customText = typeof formValue.custom_text === 'string' ? formValue.custom_text.trim() : ''
      if (customText === '') return
      const answer = settlePending(pending, [], customText)
      if (pending.cardMessageId !== undefined) {
        const settledCard = renderSettledQuestionCard(pending.question, [`✏️ ${customText}`], getTranslations())
        await channel.updateCard(pending.cardMessageId, settledCard).catch((error: unknown) => {
          logger.warn(`dsh-feishu: failed to update question card: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      pending.resolve(answer)
      return
    }

    const selected = Array.isArray(parsed.selected)
      ? parsed.selected.filter((item: unknown): item is string => typeof item === 'string')
      : action?.option !== undefined ? [action.option] : []
    const custom = typeof parsed.custom === 'string' && parsed.custom !== '' ? parsed.custom : undefined
    const selectedLabels = selected.length > 0 ? selected : (action?.option !== undefined ? [action.option] : [])
    if (pending.cardMessageId !== undefined && selectedLabels.length > 0) {
      const settledCard = renderSettledQuestionCard(pending.question, selectedLabels, getTranslations())
      await channel.updateCard(pending.cardMessageId, settledCard).catch((error: unknown) => {
        logger.warn(`dsh-feishu: failed to update question card: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    if (selected.length === 0 && custom === undefined) return
    const answer = settlePending(pending, selected, custom)
    pending.resolve(answer)
  }
  const unsubscribeCardAction = channel.onCardAction(onCardAction)

  const handleRequest = async (
    request: AskUserQuestionRequest,
    next?: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> => {
    console.log(`dsh-feishu: [q] handleRequest entered agentDefined=${request.agent !== undefined}`)
    if (request.agent === undefined) {
      console.log('dsh-feishu: [q] no agent, falling to next')
      return next !== undefined ? await next() : Promise.reject(new Error('no user-questions answerer'))
    }
    const sessionId = request.agent.session.id
    const bridge = bridgeHolder.current
    console.log(`dsh-feishu: [q] sessionId=${sessionId} bridge=${bridge !== undefined}`)
    if (bridge === undefined) {
      console.log('dsh-feishu: [q] no bridge, falling to next')
      return next !== undefined ? await next() : Promise.reject(new Error('no bridge'))
    }
    const chat = bridge.resolveChat(sessionId)
    console.log(`dsh-feishu: [q] resolveChat=${chat === undefined ? 'MISSING' : chat.chatId}`)
    if (chat === undefined) {
      console.log('dsh-feishu: [q] session not bound to chat, falling to next')
      return next !== undefined ? await next() : Promise.reject(new Error('session not bound to chat'))
    }

    const upstream = request.signal
    const abortController = new AbortController()
    // One cancellation source for the Feishu batch: the caller's turn/step
    // signal aborts it, and so does a Web UI answer (see the race below).
    const onUpstreamAbort = (): void => { abortController.abort(upstream?.reason) }
    if (upstream?.aborted === true) onUpstreamAbort()
    else upstream?.addEventListener('abort', onUpstreamAbort, { once: true })

    // What to paint over an abandoned card: the generic stale card for a turn
    // abort, or — when the Web UI won — a card that still shows which option
    // the Web UI picked, so the chat isn't left guessing.
    let webAnswer: AskUserQuestionAnswer | undefined
    const cancelCard = (question: AskUserQuestionItem): object => {
      const t = getTranslations()
      if (webAnswer === undefined) return renderSupersededCard(t)
      const item = webAnswer.answers.find(answer => answer.id === question.id)
      if (item === undefined) return renderAnsweredElsewhereCard(t)
      const labels = [...item.selected]
      if (item.custom !== undefined && item.custom !== '') labels.push(`✏️ ${item.custom}`)
      else if (labels.length === 0) labels.push('⏭️')
      return renderSettledQuestionCard(question, labels, t, {
        title: t.cardAnsweredElsewhereTitle,
        template: 'grey',
        note: t.cardAnsweredElsewhereBody,
      })
    }

    try {
      const feishu = presentQuestions(
        chat, channel, pendingCards, request.questions, abortController, logger, getTranslations(), cancelCard,
      ).then((answer): AnswererResult<AskUserQuestionAnswer, 'feishu'> | undefined =>
        answer.answers.length > 0 ? { via: 'feishu', value: answer } : undefined)

      if (next === undefined) {
        return (await feishu)?.value ?? { answers: [] }
      }

      // Present on BOTH surfaces: delegate to the inner Web UI answerer
      // (api-remotes forwards the request to the browser) while the Feishu card
      // is already up, then let whichever answers first settle the waterfall.
      // The gate is installed before delegating so the gateway binds the
      // forwarded card to a signal this module can abort once Feishu wins —
      // that abort is what makes the browser dismiss its card.
      const gate = installSignalGate(request, upstream)
      let webFailure: unknown
      const web = Promise.resolve().then(next).then(
        (value): AnswererResult<AskUserQuestionAnswer, 'web'> | undefined => ({ via: 'web', value }),
        (error: unknown) => { webFailure = error; return undefined },
      )
      const winner = await firstDefined<AnswererResult<AskUserQuestionAnswer, 'feishu' | 'web'>>([feishu, web])
      if (winner === undefined) {
        if (upstream?.aborted === true) {
          throw upstream.reason instanceof Error
            ? upstream.reason
            : new Error('the question was aborted before an answer arrived')
        }
        throw webFailure instanceof Error
          ? webFailure
          : new Error('no user-questions answerer accepted the request')
      }
      if (winner.via === 'feishu') {
        gate.release(new Error('answered on Feishu'))
      } else {
        webAnswer = winner.value
        abortController.abort(new Error('answered in the Web UI'))
      }
      return winner.value
    } finally {
      upstream?.removeEventListener('abort', onUpstreamAbort)
    }
  }
  // Prepended so this answerer runs BEFORE api-remotes' forwarding listener.
  // That ordering is what lets one request reach BOTH surfaces: Feishu renders
  // its card, then delegates with `next()` so the WebUI renders too, and the
  // first answer settles the waterfall (see handleRequest). Unbound sessions
  // never reach that path — they fall straight through to `next()`.
  const disposeListener = ctx.on('user-questions/request', handleRequest, { prepend: true })

  return () => {
    disposeListener()
    unsubscribeCardAction()
    for (const pending of pendingCards.values()) {
      pending.resolve(undefined)
      pending.abortController.abort()
    }
    pendingCards.clear()
  }
}

/**
 * Render each question as its own card and present the batch sequentially:
 * one card at a time, awaiting that card's answer before sending the next
 * question. A skipped question still yields an (empty-selection) answer item,
 * so the returned batch always has one item per question unless the request is
 * aborted or a card fails to send. This matches the WebUI's whole-batch answer
 * encoding while keeping Feishu's one-card-at-a-time chat UX.
 */
async function presentQuestions(
  chat: ConversationMessage,
  channel: FeishuQuestionsChannel,
  pendingCards: Map<string, PendingCard>,
  questions: readonly AskUserQuestionItem[],
  abortController: AbortController,
  logger?: PluginLogger,
  t?: Translations,
  cancelCard?: (question: AskUserQuestionItem) => object,
): Promise<AskUserQuestionAnswer> {
  if (questions.length === 0) {
    return { answers: [] }
  }
  console.log(`dsh-feishu: [q] presenting ${questions.length} question(s) to chat=${chat.chatId} thread=${chat.threadId ?? '-'}`)
  const answers: AskUserQuestionAnswerItem[] = []
  for (const question of questions) {
    const item = await presentOneQuestion(chat, channel, pendingCards, question, abortController, logger, t, cancelCard)
    if (item === undefined) break
    answers.push(item)
  }
  if (answers.length === 0) {
    return { answers: [] }
  }
  return { answers }
}

/**
 * Render one question card and wait for its answer. Returns the single
 * `{ id, selected, custom }` answer item, or `undefined` when the card could
 * not be sent or the request is aborted (the caller stops the batch).
 */
async function presentOneQuestion(
  chat: ConversationMessage,
  channel: FeishuQuestionsChannel,
  pendingCards: Map<string, PendingCard>,
  question: AskUserQuestionItem,
  abortController: AbortController,
  logger?: PluginLogger,
  t?: Translations,
  cancelCard?: (question: AskUserQuestionItem) => object,
): Promise<AskUserQuestionAnswerItem | undefined> {
  const pendingId = `feishu-q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const options = question.options ?? []
  // The cardAction -> deferred bridge carries the whole `{ answers: [item] }`
  // settle value; extract the single item here so the batch loop can accumulate.
  const deferred = new Promise<AskUserQuestionAnswerItem | undefined>((resolve) => {
    const pending: PendingCard = {
      pendingId,
      question,
      sessionId: '',
      abortController,
      chat,
      resolve: (answer) => resolve(answer?.answers?.[0]),
    }
    pendingCards.set(pendingId, pending)
  })
  // Abandoning this card (turn abort, or the Web UI answered first) must stop
  // it looking answerable: drop it from the pending map, settle the deferred,
  // and repaint it with whichever stale notice the caller selected.
  const onCancel = (): void => {
    const pending = pendingCards.get(pendingId)
    if (pending === undefined) return
    pendingCards.delete(pendingId)
    pending.resolve(undefined)
    const confirmId = pending.confirm?.messageId
    pending.confirm = undefined
    if (confirmId !== undefined && cancelCard !== undefined) {
      // An open confirmation card answers a question that is now settled or
      // superseded — it must not stay looking actionable.
      void channel.updateCard(confirmId, cancelCard(question)).catch((error: unknown) => {
        logger?.warn(`dsh-feishu: failed to retire cancelled confirmation card: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    if (pending.cardMessageId !== undefined && cancelCard !== undefined) {
      void channel.updateCard(pending.cardMessageId, cancelCard(question)).catch((error: unknown) => {
        logger?.warn(`dsh-feishu: failed to retire cancelled question card: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
  if (abortController.signal.aborted) onCancel()
  else abortController.signal.addEventListener('abort', onCancel, { once: true })
  const translations = t ?? translationsFor('zh')
  const sendQuestionCard = async (payload: object): Promise<void> => {
    console.log(`dsh-feishu: [q] sending card to chat=${chat.chatId} thread=${chat.threadId ?? '-'}`)
    const result = await channel.send(chat.chatId, { card: payload }, chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {})
    const mid = (result as { messageId?: string })?.messageId
    console.log(`dsh-feishu: [q] card sent messageId=${mid ?? 'none'}`)
    const pending = pendingCards.get(pendingId)
    if (pending !== undefined && mid !== undefined) {
      pending.cardMessageId = mid
    } else if (mid !== undefined && cancelCard !== undefined) {
      // Cancelled while the send was in flight: retire the card now that we
      // finally know its message id.
      void channel.updateCard(mid, cancelCard(question)).catch((error: unknown) => {
        logger?.warn(`dsh-feishu: failed to retire cancelled question card: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
  const wantsMulti = question.multiSelect === true && options.length > 0
  let card = renderQuestionCard(question, options, pendingId, translations, wantsMulti)
  try {
    await sendQuestionCard(card)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    if (!wantsMulti || abortController.signal.aborted) {
      console.log(`dsh-feishu: [q] card send failed: ${reason}`)
      logger?.warn(`dsh-feishu: [q] card send failed: ${reason}`)
      pendingCards.delete(pendingId)
      return undefined
    }
    // A tenant/client that rejects the `checker` control must not cost the user
    // the question at all: retry once as a single-pick card (index buttons).
    logger?.warn(`dsh-feishu: [q] multi-select card rejected, retrying as single-pick: ${reason}`)
    card = renderQuestionCard(question, options, pendingId, translations, false)
    try {
      await sendQuestionCard(card)
    } catch (retryError: unknown) {
      const retryReason = retryError instanceof Error ? retryError.message : String(retryError)
      console.log(`dsh-feishu: [q] card send failed: ${retryReason}`)
      logger?.warn(`dsh-feishu: [q] card send failed: ${retryReason}`)
      pendingCards.delete(pendingId)
      return undefined
    }
  }
  try {
    return await deferred
  } finally {
    abortController.signal.removeEventListener('abort', onCancel)
  }
}

/**
 * Form field names of the multi-select controls. Feishu's `checker` is a
 * SINGLE checkbox (`text` + `checked`, and **no `options` field** — sending one
 * is rejected by `im.v1.message.create` with `200621 unknown property`), so a
 * multi-select question renders one checker per option, named `opt_<index>`.
 * `MULTI_SELECT_FIELD` covers a list-shaped control (`multi_select_static`)
 * should this ever be switched over.
 */
const MULTI_SELECT_PREFIX = 'opt_'
const MULTI_SELECT_FIELD = 'selections'

/** Truthy values a checkbox may report, across Feishu payload shapes. */
function isChecked(value: unknown): boolean {
  if (value === true || value === 1) return true
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    return text !== '' && text !== 'false' && text !== '0' && text !== 'off'
  }
  return false
}

/**
 * Map a multi-select form submission back to option labels: either a list under
 * `selections`, or one `opt_<index>` checkbox per option (the shape Feishu
 * posts for `checker` elements).
 */
function readMultiSelection(
  formValue: Record<string, unknown>,
  options: readonly AskUserQuestionOption[],
): string[] {
  const listed = readFormSelections(formValue[MULTI_SELECT_FIELD])
  if (listed.length > 0) return listed
  const picked: string[] = []
  options.forEach((option, index) => {
    // Accept the index key and the label key: the exact name is confirmed by
    // the `[q] multi-submit` log line on the first live submission.
    if (isChecked(formValue[`${MULTI_SELECT_PREFIX}${index}`]) || isChecked(formValue[option.label])) {
      picked.push(option.label)
    }
  })
  return picked
}

/** Collapse a model-authored description to one line (they may contain newlines). */
function inlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Numbered option list shared by the question card body and the settled card.
 * Upstream (and the WebUI) render `index + label + description`; Feishu collapses
 * leading whitespace, so the description rides on the same line after a `·`.
 */
function optionLines(
  options: readonly AskUserQuestionOption[],
  marks?: ReadonlySet<string>,
  selectedSuffix?: string,
): string[] {
  return options.map((option, index) => {
    const picked = marks?.has(option.label) === true
    const prefix = marks === undefined ? '' : picked ? '✅ ' : '⬜ '
    const description = option.description !== undefined && option.description !== ''
      ? ` · ${inlineText(option.description)}`
      : ''
    const suffix = picked && selectedSuffix !== undefined && selectedSuffix !== ''
      ? ` — *${selectedSuffix}*`
      : ''
    return `${index + 1}. ${prefix}**${option.label}**${description}${suffix}`
  })
}

/**
 * Read a multi-value form field. Feishu hands form values back as an array, a
 * JSON string or a plain string depending on the control, so accept all three
 * instead of losing a `checker` submission to a shape we guessed wrong.
 */
function readFormSelections(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return []
    if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (Array.isArray(parsed)) {
          return parsed.filter((item): item is string => typeof item === 'string')
        }
      } catch {
        // Not JSON after all — fall through and treat it as one label.
      }
    }
    return [text]
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return readFormSelections(record.selected ?? record.value ?? record.checked)
  }
  return []
}

/**
 * Build a settled question card — shows all options with the selected one
 * highlighted, buttons removed. Uses turquoise header to distinguish from
 * the original blue question card.
 */
function renderSettledQuestionCard(
  question: AskUserQuestionItem,
  selected: readonly string[],
  t: Translations,
  variant?: { title?: string; template?: string; note?: string },
): object {
  const options = question.options ?? []
  const selectedSet = new Set(selected)
  const mdParts: string[] = []
  if (question.header !== undefined && question.header !== '') {
    mdParts.push(`**${question.header}**`)
  }
  mdParts.push(question.question)
  if (question.detail !== undefined && question.detail !== '') {
    mdParts.push(question.detail)
  }
  mdParts.push('')
  if (options.length > 0) {
    // Check if the answer is a custom text (prefixed with ✏️) or skip (prefixed with ⏭️).
    const customAnswer = selected.find(s => s.startsWith('✏️ '))
    const skipped = selected.some(s => s.startsWith('⏭️ '))
    mdParts.push(...optionLines(options, selectedSet, t.questionSelectedSuffix))
    if (customAnswer !== undefined) {
      mdParts.push(`\n✅ **${t.questionCustomAnswerLabel}** ${customAnswer.slice(3)}`)
    } else if (skipped) {
      mdParts.push(`\n⏭️ *${t.questionSkippedLabel}*`)
    }
  } else {
    mdParts.push(`✅ **${t.questionSelectedLabel}** ${selected.join(', ')}`)
  }
  if (variant?.note !== undefined && variant.note !== '') {
    mdParts.push(`\n${variant.note}`)
  }
  // Use Card JSON 2.0 format (schema + body.elements) for the settled card.
  // This is necessary because im.v1.message.patch only supports v2 format.
  // The original question card uses old format (top-level elements) because
  // v2 does not support the 'action' tag (buttons).
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: variant?.title ?? question.header ?? t.questionDefaultTitle },
      template: variant?.template ?? 'turquoise',
    },
    body: {
      elements: [{ tag: 'markdown', content: mdParts.join('\n') }],
    },
  }
}

/**
 * Confirmation card for a single-select row tap. A clickable row answers on the
 * first tap, so a mis-tap has to be recoverable BEFORE the answer leaves the
 * chat: this card shows exactly what would be submitted, and only its
 * `answer-confirm` callback settles the question. It carries buttons, so it is
 * written at most once — a different pick gets a NEW card and the previous one
 * is retired as a no-button card (pitfall 11).
 */
function renderConfirmAnswerCard(
  question: AskUserQuestionItem,
  option: AskUserQuestionOption,
  pendingId: string,
  t: Translations,
): object {
  const elements: object[] = [{ tag: 'markdown', content: t.questionConfirmBody(`**${option.label}**`) }]
  if (option.description !== undefined && option.description !== '') {
    elements.push({ tag: 'markdown', content: inlineText(option.description), text_size: 'notation' })
  }
  elements.push({ tag: 'markdown', content: t.questionConfirmNote, text_size: 'notation' })
  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.questionConfirmSend },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { pendingId, questionId: question.id, selected: [option.label], type: 'answer-confirm' } }],
  })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.questionConfirmBack },
    type: 'default',
    behaviors: [{ type: 'callback', value: { pendingId, questionId: question.id, type: 'answer-back' } }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.questionConfirmTitle }, template: 'orange' },
    body: { elements },
  }
}

/**
 * The question card once a row has been tapped and its answer is waiting on the
 * confirmation card: the rows are gone, so the card cannot take another pick
 * (which the client would swallow anyway) and the user can see the tap landed.
 */
function renderFrozenQuestionCard(question: AskUserQuestionItem, option: AskUserQuestionOption, t: Translations): object {
  const elements: object[] = [{ tag: 'markdown', content: t.questionFrozen(`**${option.label}**`) }]
  if (option.description !== undefined && option.description !== '') {
    elements.push({ tag: 'markdown', content: inlineText(option.description), text_size: 'notation' })
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: question.header ?? t.questionDefaultTitle }, template: 'grey' },
    body: { elements },
  }
}

/**
 * The grey notice left where a spent question card was: the client stops
 * delivering row taps from a card that already took one, so the live question
 * is re-sent as a new message and this one says where to look.
 */
function renderRetiredQuestionCard(t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.questionCardRetiredTitle }, template: 'grey' },
    body: { elements: [{ tag: 'markdown', content: t.questionCardRetired }] },
  }
}

/** Grey notice left where the question card was once its answer was submitted. */
function renderSubmittedQuestionCard(t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.questionCardRetiredTitle }, template: 'grey' },
    body: { elements: [{ tag: 'markdown', content: t.questionCardSubmitted }] },
  }
}

/** A retired confirmation card (the pick was replaced, or the user pressed Back). */
function renderConfirmBackCard(t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.questionConfirmTitle }, template: 'grey' },
    body: { elements: [{ tag: 'markdown', content: t.questionConfirmBacked }] },
  }
}

/** A confirmation card whose answer was submitted (no buttons left). */
function renderConfirmDoneCard(labels: readonly string[], t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.questionConfirmTitle }, template: 'turquoise' },
    body: { elements: [{ tag: 'markdown', content: t.questionConfirmDone(labels.join('、')) }] },
  }
}

/**
 * Build a Feishu interactive-card payload for a single question. The schema
 * follows the v2 card template (`config/schema`): `header.title`, `body`
 * blocks (markdown + actions), `config`: { wide_screen_mode: true }.
 */
function renderQuestionCard(
  question: AskUserQuestionItem,
  options: readonly AskUserQuestionOption[],
  pendingId: string,
  t: Translations,
  multiSelect = question.multiSelect === true,
): object {
  const mdParts: string[] = []
  if (question.header !== undefined && question.header !== '') {
    mdParts.push(`**${question.header}**`)
  }
  mdParts.push(question.question)
  if (question.detail !== undefined && question.detail !== '') {
    mdParts.push(question.detail)
  }
  const body: object[] = [{ tag: 'markdown', content: mdParts.join('\n') }]
  if (multiSelect && options.length > 0) {
    // Multi-select: the checkboxes ARE the option list — each carries its own
    // `1. **label**` plus the description on the next line, so the card no
    // longer spells the same options out twice (operator feedback 2026-10-07).
    // `checker.text` accepts `lark_md` (verified against the send validator).
    body.push({ tag: 'markdown', content: t.questionMultiHint })
  } else if (options.length > 0) {
    // Single-select: each option IS the pick target, a whole clickable row —
    // the same `interactive_container` shape the workspace picker and the
    // delivery list use, so one tap answers (no index→label mapping, no
    // button row). Text lives in the row, so the body needs no option list.
    body.push({ tag: 'markdown', content: t.questionTapHint, text_size: 'notation' })
    options.forEach((option, index) => {
      const lines: object[] = [{ tag: 'markdown', content: `${index + 1}. **${option.label}**` }]
      if (option.description !== undefined && option.description !== '') {
        lines.push({ tag: 'markdown', content: inlineText(option.description), text_size: 'notation' })
      }
      body.push({
        tag: 'interactive_container',
        width: 'fill',
        has_border: false,
        padding: '4px 12px 4px 12px',
        behaviors: [{ type: 'callback', value: { pendingId, questionId: question.id, selected: [option.label], type: 'answer-open' } }],
        elements: lines,
      })
    })
  }
  if (multiSelect && options.length > 0) {
    // One `checker` + one submit: the client collects every check locally and
    // the callback arrives ONCE, so this card is never written twice — the fix
    // for pitfall 11 (a card with buttons stops delivering callbacks after 2-3
    // in-place updates) and the only way to express multi-select at all.
    body.push({
      tag: 'form',
      name: `answer_form_${pendingId}`,
      elements: [
        // One `checker` per option (Feishu's checker is a single checkbox),
        // each carrying its label AND its description.
        ...options.map((option, index) => ({
          tag: 'checker',
          name: `${MULTI_SELECT_PREFIX}${index}`,
          text: {
            tag: 'lark_md',
            content: option.description !== undefined && option.description !== ''
              ? `${index + 1}. **${option.label}**\n${inlineText(option.description)}`
              : `${index + 1}. **${option.label}**`,
          },
          checked: false,
        })),
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t.questionSubmitButton },
          type: 'primary',
          name: 'submit_multi',
          form_action_type: 'submit',
          behaviors: [{ type: 'callback', value: { pendingId, questionId: question.id, type: 'multi-submit' } }],
        },
      ],
    })
  }
  // Custom input section: form container with input + submit button.
  // The form collects custom_text from the input when submit is clicked.
  // Form buttons use form_action_type + name instead of behaviors.
  body.push({ tag: 'hr' })
  body.push({
    tag: 'form',
    name: `custom_form_${pendingId}`,
    elements: [
      { tag: 'markdown', content: t.questionCustomHint(options.length > 0) },
      {
        tag: 'input',
        name: 'custom_text',
        placeholder: { tag: 'plain_text', content: t.questionCustomPlaceholder },
        max_length: 500,
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t.questionSubmitCustom },
        type: 'primary',
        name: 'submit_custom',
        form_action_type: 'submit',
        behaviors: [{ type: 'callback', value: { pendingId, questionId: question.id, type: 'custom' } }],
      },
    ],
  })
  // Skip button at the bottom.
  body.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.questionSkipButton },
    type: 'default',
    behaviors: [{ type: 'callback', value: { pendingId, questionId: question.id, selected: [], type: 'skip' } }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: question.header ?? 'Question' },
      template: options.length > 0 ? 'blue' : 'grey',
    },
    body: {
      elements: body,
    },
  }
}
