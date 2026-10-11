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

/** One card tap, as the batch loop sees it. */
type BatchEvent =
  | { kind: 'answered'; labels: string[]; custom: string | undefined }
  | { kind: 'undo'; questionId: string }
  | { kind: 'confirm' }
  | { kind: 'abandoned' }

/**
 * One live `ask_user_question` batch.
 *
 * Questions are still asked one card at a time, but an answer is no longer
 * gated by a second "confirm" tap (operator's 2026-10-09 redesign): tapping a
 * row IS the answer, the card posted after it is a RECEIPT that carries 返回 so
 * a mis-tap is one tap from being redone, and the whole set is committed by the
 * final batch card (确认 / 返回上一题). A single-question batch is committed by
 * its receipt — there is no "all the cards" to confirm.
 */
interface PendingBatch {
  pendingId: string
  chat: ConversationMessage
  questions: readonly AskUserQuestionItem[]
  abortController: AbortController
  /** Answers so far, keyed by question id; the reply rebuilds question order. */
  answers: Map<string, { labels: string[]; custom: string | undefined }>
  /** The question whose interactive card is on screen right now. */
  currentQuestionId: string | undefined
  /** That card's message id (only its taps count). */
  questionCardId: string | undefined
  /** Receipt card per answered question (`✅ 已提交` + 返回). */
  receipts: Map<string, string>
  /** The final card that commits the whole batch. */
  batchCardId: string | undefined
  /** Set once the batch is dead (aborted, or a card could not be sent). */
  abandoned: boolean
  /** The loop parks here; a tap resumes it. */
  settle: ((event: BatchEvent) => void) | undefined
  /** A tap that arrived while the loop was between cards. */
  queued: BatchEvent | undefined
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
  const batches = new Map<string, PendingBatch>()

  /** Options that keep a follow-up card in the topic the question card used. */
  const chatOpts = (chat: ConversationMessage): { replyInThread?: boolean; replyTo?: string } =>
    chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {}

  /** Update a card, logging (never throwing) when the patch fails. */
  const updateCardQuiet = async (messageId: string, card: object): Promise<void> => {
    await channel.updateCard(messageId, card).catch((error: unknown) => {
      logger.warn(`dsh-feishu: failed to update question card: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Post a card into the same chat/topic the question card went to. */
  const postInChat = async (chat: ConversationMessage, card: object): Promise<string | undefined> => {
    const result = await channel.send(chat.chatId, { card }, chatOpts(chat))
    return (result as { messageId?: string } | undefined)?.messageId
  }

  /**
   * Hand a tap to the loop parked on this batch, or hold it until the loop parks
   * again — a tap legitimately arrives while the next card is being posted (the
   * receipt of question N is tappable while question N+1 goes out).
   */
  const dispatch = (batch: PendingBatch, event: BatchEvent): void => {
    if (batch.abandoned) return
    const settle = batch.settle
    if (settle === undefined) {
      batch.queued = event
      return
    }
    batch.settle = undefined
    settle(event)
  }

  /** Wait for this batch's next tap. */
  const nextEvent = (batch: PendingBatch): Promise<BatchEvent> => {
    if (batch.abandoned) return Promise.resolve<BatchEvent>({ kind: 'abandoned' })
    const queued = batch.queued
    if (queued !== undefined) {
      batch.queued = undefined
      return Promise.resolve(queued)
    }
    return new Promise<BatchEvent>((resolve) => { batch.settle = resolve })
  }

  /** Kill a batch: no card of it may accept another tap, and the loop unwinds. */
  const abandonBatch = (batch: PendingBatch): void => {
    if (batch.abandoned) return
    batch.abandoned = true
    const settle = batch.settle
    batch.settle = undefined
    settle?.({ kind: 'abandoned' })
  }

  /**
   * Post the interactive card of ONE question and wait for its tap.
   *
   * A row tap (`answer-open`) resolves as ANSWERED: it IS the decision, and the
   * receipt card that follows carries the undo. Nothing is asked twice, so a
   * mis-tap costs one tap instead of a whole confirmation step.
   */
  const askQuestion = async (
    batch: PendingBatch,
    question: AskUserQuestionItem,
    cancelCard: (question: AskUserQuestionItem) => object,
  ): Promise<BatchEvent> => {
    const t = getTranslations()
    const options = question.options ?? []
    const wantsMulti = question.multiSelect === true && options.length > 0
    batch.questionCardId = undefined
    batch.currentQuestionId = question.id
    const send = async (card: object): Promise<string | undefined> => {
      console.log(`dsh-feishu: [q] sending card to chat=${batch.chat.chatId} thread=${batch.chat.threadId ?? '-'}`)
      const result = await channel.send(batch.chat.chatId, { card }, chatOpts(batch.chat))
      const mid = (result as { messageId?: string } | undefined)?.messageId
      console.log(`dsh-feishu: [q] card sent messageId=${mid ?? 'none'}`)
      return mid
    }
    let messageId: string | undefined
    try {
      messageId = await send(renderQuestionCard(question, options, batch.pendingId, t, wantsMulti))
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      if (!wantsMulti || batch.abortController.signal.aborted) {
        console.log(`dsh-feishu: [q] card send failed: ${reason}`)
        logger.warn(`dsh-feishu: [q] card send failed: ${reason}`)
        return { kind: 'abandoned' }
      }
      // A tenant/client that rejects the `checker` control must not cost the user
      // the question at all: retry once as a single-pick card.
      logger.warn(`dsh-feishu: [q] multi-select card rejected, retrying as single-pick: ${reason}`)
      try {
        messageId = await send(renderQuestionCard(question, options, batch.pendingId, t, false))
      } catch (retryError: unknown) {
        const retryReason = retryError instanceof Error ? retryError.message : String(retryError)
        console.log(`dsh-feishu: [q] card send failed: ${retryReason}`)
        logger.warn(`dsh-feishu: [q] card send failed: ${retryReason}`)
        return { kind: 'abandoned' }
      }
    }
    if (batch.abandoned) {
      // Cancelled while the send was in flight: retire the card now that its id
      // is finally known.
      if (messageId !== undefined) {
        void channel.updateCard(messageId, cancelCard(question)).catch((error: unknown) => {
          logger.warn(`dsh-feishu: failed to retire cancelled question card: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      return { kind: 'abandoned' }
    }
    batch.questionCardId = messageId
    return await nextEvent(batch)
  }

  /** The question card keeps the settled record of what the answer was. */
  const settleQuestionCard = async (
    batch: PendingBatch,
    question: AskUserQuestionItem,
    labels: readonly string[],
    custom: string | undefined,
  ): Promise<void> => {
    if (batch.questionCardId === undefined) return
    const t = getTranslations()
    await updateCardQuiet(
      batch.questionCardId,
      renderSettledQuestionCard(question, settledLabels(labels, custom, t), t),
    )
  }

  /**
   * The receipt card posted after an answer: what was submitted, with 返回 to
   * redo this one question.
   */
  const postReceipt = async (
    batch: PendingBatch,
    question: AskUserQuestionItem,
    labels: readonly string[],
    custom: string | undefined,
  ): Promise<void> => {
    const t = getTranslations()
    try {
      const messageId = await postInChat(
        batch.chat,
        renderReceiptCard(question, answerText(labels, custom, t), batch.pendingId, t),
      )
      if (messageId !== undefined) batch.receipts.set(question.id, messageId)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: failed to post the answer receipt card: ${reason}`)
    }
  }

  /**
   * Post the card that commits the whole batch: it lists every answer, 确认 hands
   * them to the model, 返回上一题 drops the last one and asks it again.
   */
  const askBatchConfirm = async (batch: PendingBatch): Promise<BatchEvent> => {
    const t = getTranslations()
    let messageId: string | undefined
    try {
      messageId = await postInChat(
        batch.chat,
        renderBatchConfirmCard(batch.questions, batch.answers, batch.pendingId, t),
      )
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: failed to post the batch confirmation card: ${reason}`)
      // Without that card the answers could never be committed: hand them over
      // now rather than leaving the turn hanging on a card that is not there.
      return { kind: 'confirm' }
    }
    batch.batchCardId = messageId
    if (batch.abandoned) return { kind: 'abandoned' }
    return await nextEvent(batch)
  }

  /**
   * Present every question, one card at a time, and return the answers in
   * question order.
   */
  const presentQuestions = async (
    chat: ConversationMessage,
    questions: readonly AskUserQuestionItem[],
    abortController: AbortController,
    cancelCard: (question: AskUserQuestionItem) => object,
  ): Promise<AskUserQuestionAnswer> => {
    if (questions.length === 0) return { answers: [] }
    console.log(`dsh-feishu: [q] presenting ${questions.length} question(s) to chat=${chat.chatId} thread=${chat.threadId ?? '-'}`)
    const batch: PendingBatch = {
      pendingId: `feishu-q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat,
      questions,
      abortController,
      answers: new Map(),
      currentQuestionId: undefined,
      questionCardId: undefined,
      receipts: new Map(),
      batchCardId: undefined,
      abandoned: false,
      settle: undefined,
      queued: undefined,
    }
    batches.set(batch.pendingId, batch)
    /** Repaint one card of this batch with a stale notice. */
    const retire = (messageId: string | undefined, card: object): void => {
      if (messageId === undefined) return
      void channel.updateCard(messageId, card).catch((error: unknown) => {
        logger.warn(`dsh-feishu: failed to retire a question card: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    // Abandoning the batch (a turn abort, or the Web UI answered first) must stop
    // every card of it looking answerable.
    const onCancel = (): void => {
      abandonBatch(batch)
      const current = questions.find(question => question.id === batch.currentQuestionId) ?? questions[0]
      if (current !== undefined) retire(batch.questionCardId, cancelCard(current))
      for (const question of questions) retire(batch.receipts.get(question.id), cancelCard(question))
      retire(batch.batchCardId, renderSupersededCard(getTranslations()))
      batches.delete(batch.pendingId)
    }
    if (abortController.signal.aborted) onCancel()
    else abortController.signal.addEventListener('abort', onCancel, { once: true })
    let index = 0
    /** A receipt's 返回: forget that answer and ask that question again. */
    const applyUndo = (questionId: string): void => {
      batch.answers.delete(questionId)
      const at = questions.findIndex(question => question.id === questionId)
      index = at >= 0 ? at : 0
    }
    try {
      while (!batch.abandoned) {
        // An undo re-asks exactly ONE question; every other answer stays, so
        // skip the questions that already have one.
        while (index < questions.length && batch.answers.has(questions[index]!.id)) index += 1
        if (index < questions.length) {
          const question = questions[index]!
          const event = await askQuestion(batch, question, cancelCard)
          if (event.kind === 'abandoned') break
          if (event.kind === 'undo') {
            // The card of the question we were asking is not the live one any
            // more: it must not keep looking answerable.
            if (event.questionId !== question.id) retire(batch.questionCardId, renderSupersededCard(getTranslations()))
            applyUndo(event.questionId)
            continue
          }
          if (event.kind === 'confirm') continue
          batch.answers.set(question.id, { labels: [...event.labels], custom: event.custom })
          await settleQuestionCard(batch, question, event.labels, event.custom)
          // The card posted after an answer is the receipt — except for the LAST
          // answer, where the batch card takes its place (it lists every answer,
          // including this one) so a batch of N costs N question cards, N-1
          // receipts and one commit card.
          if (!questions.every(candidate => batch.answers.has(candidate.id))) {
            await postReceipt(batch, question, event.labels, event.custom)
          }
          index += 1
          continue
        }
        // Every question has an answer: the batch card is the ONLY commit point,
        // so a receipt's 返回 stays meaningful for as long as the user needs it
        // (a batch of one included — the operator asked for the final card after
        // "all the cards", and there is nothing else left to ask).
        const event = await askBatchConfirm(batch)
        if (event.kind === 'abandoned') break
        if (event.kind === 'undo') {
          retire(batch.batchCardId, renderSupersededCard(getTranslations()))
          applyUndo(event.questionId)
          continue
        }
        break
      }
    } finally {
      abortController.signal.removeEventListener('abort', onCancel)
      batches.delete(batch.pendingId)
    }
    const answers: AskUserQuestionAnswerItem[] = []
    for (const question of questions) {
      const answer = batch.answers.get(question.id)
      if (answer === undefined) continue
      answers.push({
        id: question.id,
        selected: [...answer.labels],
        ...(answer.custom === undefined ? {} : { custom: answer.custom }),
      })
    }
    return { answers }
  }

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
    if (pendingId === '') return
    const batch = batches.get(pendingId)
    if (batch === undefined) return
    const t = getTranslations()
    /**
     * A tap only counts on the card THIS batch posted for that role. A retired or
     * superseded card keeps its old callback value, and tapping it must be a
     * no-op (pitfall 55).
     */
    const fromCard = (expected: string | undefined): boolean =>
      evt.messageId === undefined || expected === undefined || evt.messageId === expected

    if (parsed.type === 'batch-confirm' || parsed.type === 'batch-back') {
      if (!fromCard(batch.batchCardId)) return
      console.log(`dsh-feishu: [q] batch card tap type=${String(parsed.type)}`)
      if (parsed.type === 'batch-confirm') {
        // The commit is invisible unless the card says so: repaint it into the
        // submitted shape (green header, no buttons) BEFORE the answers are
        // handed over, so "did my tap land?" has an answer on screen even if the
        // turn that follows is slow to start. A failed repaint only logs — the
        // commit itself must never depend on a card write (pitfall 29).
        if (batch.batchCardId !== undefined) {
          await updateCardQuiet(
            batch.batchCardId,
            renderBatchSubmittedCard(batch.questions, batch.answers, t),
          )
        }
        dispatch(batch, { kind: 'confirm' })
        return
      }
      dispatch(batch, { kind: 'undo', questionId })
      return
    }

    if (parsed.type === 'answer-back') {
      // A receipt's 返回: forget that answer and ask it again on a FRESH card —
      // a card whose option row was already tapped never delivers another row
      // tap (measured 2026-10-07, pitfall 55).
      if (questionId === '' || !fromCard(batch.receipts.get(questionId))) return
      const receiptId = batch.receipts.get(questionId)
      batch.receipts.delete(questionId)
      if (receiptId !== undefined) await updateCardQuiet(receiptId, renderReceiptUndoneCard(t))
      console.log(`dsh-feishu: [q] undo the answer for ${questionId}`)
      dispatch(batch, { kind: 'undo', questionId })
      return
    }

    // Everything else can only come from the interactive card of the question
    // that is on screen right now.
    if (questionId === '' || questionId !== batch.currentQuestionId) return
    if (!fromCard(batch.questionCardId)) return
    const question = batch.questions.find(candidate => candidate.id === questionId)
    if (question === undefined) return

    if (parsed.type === 'multi-submit') {
      // One submission for every checked box (`checker` elements in a form).
      console.log(`dsh-feishu: [q] multi-submit form_value=${JSON.stringify(formValue)}`)
      const selected = readMultiSelection(formValue, question.options ?? [])
      if (selected.length === 0) {
        console.log('dsh-feishu: [q] multi-submit with nothing checked')
        return
      }
      dispatch(batch, { kind: 'answered', labels: selected, custom: undefined })
      return
    }

    if (parsed.type === 'skip') {
      dispatch(batch, { kind: 'answered', labels: [], custom: undefined })
      return
    }

    if (parsed.type === 'custom') {
      const customText = typeof formValue.custom_text === 'string' ? formValue.custom_text.trim() : ''
      if (customText === '') return
      dispatch(batch, { kind: 'answered', labels: [], custom: customText })
      return
    }

    // A row tap (`answer-open`) IS the answer — no second confirmation step
    // (operator's 2026-10-09 redesign); the receipt card is the undo path.
    const picked = Array.isArray(parsed.selected)
      ? parsed.selected.filter((item: unknown): item is string => typeof item === 'string')
      : action?.option !== undefined ? [action.option] : []
    const custom = typeof parsed.custom === 'string' && parsed.custom !== '' ? parsed.custom : undefined
    if (picked.length === 0 && custom === undefined) return
    dispatch(batch, { kind: 'answered', labels: picked, custom })
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
      const feishu = presentQuestions(chat, request.questions, abortController, cancelCard)
        .then((answer): AnswererResult<AskUserQuestionAnswer, 'feishu'> | undefined =>
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
    for (const batch of batches.values()) {
      abandonBatch(batch)
      batch.abortController.abort()
    }
    batches.clear()
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

/** The answer line a receipt and the batch card show. */
function answerText(labels: readonly string[], custom: string | undefined, t: Translations): string {
  if (custom !== undefined && custom !== '') return `✏️ ${custom}`
  if (labels.length === 0) return `⏭️ ${t.questionSkippedLabel}`
  return labels.join('、')
}

/** The settled card's label list for one answer (custom/skip encoded as before). */
function settledLabels(labels: readonly string[], custom: string | undefined, t: Translations): string[] {
  if (custom !== undefined && custom !== '') return [`✏️ ${custom}`]
  if (labels.length === 0) return [`⏭️ ${t.questionSkippedLabel}`]
  return [...labels]
}

/**
 * The RECEIPT posted right after an answer: the answer is already submitted
 * (a row tap is the decision — operator's 2026-10-09 redesign), so this card
 * records what went through and carries 返回 to redo this one question. Its
 * button is written once and never repainted (pitfall 11).
 */
function renderReceiptCard(
  question: AskUserQuestionItem,
  answer: string,
  pendingId: string,
  t: Translations,
): object {
  const elements: object[] = [
    { tag: 'markdown', content: `**${question.header ?? question.question}**` },
    { tag: 'markdown', content: t.questionReceiptAnswer(`**${answer}**`) },
    { tag: 'markdown', content: t.questionReceiptNote, text_size: 'notation' },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: t.questionReceiptBack },
      type: 'default',
      behaviors: [{ type: 'callback', value: { pendingId, questionId: question.id, type: 'answer-back' } }],
    },
  ]
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.questionReceiptTitle }, template: 'green' },
    body: { elements },
  }
}

/** Grey notice left where a receipt was once its answer was undone. */
function renderReceiptUndoneCard(t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.questionCardRetiredTitle }, template: 'grey' },
    body: { elements: [{ tag: 'markdown', content: t.questionReceiptUndone }] },
  }
}

/** One row per question, showing the answer it got (or that it has none). */
function batchAnswerRows(
  questions: readonly AskUserQuestionItem[],
  answers: ReadonlyMap<string, { labels: string[]; custom: string | undefined }>,
  t: Translations,
): object[] {
  const rows: object[] = []
  for (const question of questions) {
    const answer = answers.get(question.id)
    rows.push({
      tag: 'markdown',
      content: t.questionBatchRow(
        question.header ?? question.question,
        answer === undefined ? t.questionBatchUnanswered : answerText(answer.labels, answer.custom, t),
      ),
    })
  }
  return rows
}

/**
 * The FINAL card of a batch: every question with the answer it got, 确认提交 to
 * hand the set to the model, 返回上一题 to change the last one.
 */
function renderBatchConfirmCard(
  questions: readonly AskUserQuestionItem[],
  answers: ReadonlyMap<string, { labels: string[]; custom: string | undefined }>,
  pendingId: string,
  t: Translations,
): object {
  const elements = batchAnswerRows(questions, answers, t)
  elements.push({ tag: 'markdown', content: t.questionBatchNote, text_size: 'notation' })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.questionBatchConfirm },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { pendingId, questionId: questions[0]?.id ?? '', type: 'batch-confirm' } }],
  })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.questionBatchBack },
    type: 'default',
    behaviors: [{
      type: 'callback',
      value: { pendingId, questionId: questions[questions.length - 1]?.id ?? '', type: 'batch-back' },
    }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.questionBatchTitle }, template: 'blue' },
    body: { elements },
  }
}

/**
 * What the commit card becomes once 确认提交 was accepted.
 *
 * Measured 2026-10-11: this card used to be left untouched after the commit tap
 * (nothing on the confirm path ever wrote to it), so it kept its blue header and
 * both buttons and the operator could not tell whether the answers had gone
 * through. The submitted shape mirrors the receipt card — green header, the
 * answer rows, and no controls — and is written ONLY on a tap that actually
 * committed, so a tap on a stale card (ignored by `fromCard`) leaves no false
 * receipt behind.
 */
function renderBatchSubmittedCard(
  questions: readonly AskUserQuestionItem[],
  answers: ReadonlyMap<string, { labels: string[]; custom: string | undefined }>,
  t: Translations,
): object {
  const elements = batchAnswerRows(questions, answers, t)
  elements.push({ tag: 'markdown', content: t.questionBatchSubmittedNote, text_size: 'notation' })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.questionBatchSubmittedTitle }, template: 'green' },
    body: { elements },
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
