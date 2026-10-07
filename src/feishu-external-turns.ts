/**
 * The Feishu side of a turn this plugin did not start.
 *
 * `channel.ts` only sees turns it dispatched itself: it receives the inbound
 * Feishu message, prompts the session and posts the reply / Turn Complete card
 * when the turn settles. Every other way a turn can start — the Web GUI, a
 * background-job wake-up, a schedule — reached the chat as step cards only, so
 * the Feishu reader saw a stream of process cards with no question above them
 * and no completion below (TODO O25's remaining half).
 *
 * This module closes that with the two native events every DSH surface already
 * renders from:
 *
 * - `user/message` from another surface is echoed into the chat (the Web GUI
 *   renders Feishu's user messages the same way, from the same event stream);
 * - `turn/end` for a turn that was NOT started on Feishu posts the same Turn
 *   Complete card plus the same `present` delivery the reply path runs, reusing
 *   streaming's `flushed()` (which is what orders the footer after the final
 *   step card) and channel.ts's own footer renderer and deliver controller.
 *
 * The turn's origin comes from `feishu-turn-origin.ts`, which reads the native
 * `source.rpcId` this plugin minted; a Feishu-started turn is left entirely to
 * `channel.ts`, so no turn can produce two footers.
 *
 * @module @starxer/chatterbox4dsh/feishu-external-turns
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConversationMessage } from './conversation.ts'
import type { HarnessConversationService } from './harness.ts'
import type { TurnStats } from './feishu-streaming.ts'
import type { ReplyCardMeta } from './channel.ts'
import { renderFooterCard } from './channel.ts'
import type { DeliverChat, DeliverPlan, DeliverPlanInput } from './feishu-deliver.ts'
import { hasDeliverables } from './feishu-deliver.ts'
import type { Translations } from './i18n.ts'
import { beginTurn, noteUserMessage, turnOrigin, turnSurface, turnTrigger, type UserMessageOrigin } from './feishu-turn-origin.ts'

/** Minimal logger surface; matches ctx.logger's call style. */
export interface ExternalTurnsLogger {
  info(message: string): unknown
  warn(message: string): unknown
}

/** Channel surface this module sends through (a subset of the card channel). */
export interface ExternalTurnsChannel {
  send(
    to: string,
    input: { card: object } | { text: string },
    opts?: { replyInThread?: boolean; replyTo?: string },
  ): Promise<{ messageId?: string }>
}

/** What this module needs from the plugin. */
export interface ExternalTurnsDeps {
  ctx: Context
  channel: ExternalTurnsChannel
  bridgeHolder: { current: HarnessConversationService | undefined }
  logger: ExternalTurnsLogger
  getTranslations: () => Translations
  /**
   * Streaming's `flushed()`: waits for the turn's step card and every in-flight
   * write, and returns the turn stats. Using it is what keeps the completion
   * card BELOW the final step card in the chat.
   */
  flushed: (sessionId: string) => Promise<TurnStats | undefined>
  /** Session metadata for the footer (the same values the reply card shows). */
  sessionMeta: (chat: ConversationMessage) => Promise<ReplyCardMeta>
  /** `present` delivery, planned here exactly as the reply path plans it. */
  deliver?: {
    plan(input: DeliverPlanInput): Promise<DeliverPlan>
    autoSend(plan: DeliverPlan, chat: DeliverChat): Promise<void>
  }
  /**
   * Register the topic of a card carrying clickable rows, so a later tap can be
   * traced back to it (关键坑 31). Optional: without it the rows fall back to
   * the chat-level topic guess.
   */
  noteCardTopic?: (messageId: string, topic: { threadId?: string; rootId?: string }) => void
  /** The `mirrorExternalTurns` setting, read live. */
  enabled: () => boolean
  /** Clock override for tests. */
  now?: () => number
}

/** Longest user text echoed into the chat before it is clipped. */
const ECHO_TEXT_CAP = 2000

/** One content part of a `user/message`, as far as this module reads it. */
type MessagePart = { type?: unknown; text?: unknown }

/** Topic coordinates for a reply in this chat. */
function replyOpts(chat: ConversationMessage): { replyInThread?: boolean; replyTo?: string } {
  if (chat.threadId === undefined) return {}
  return { replyInThread: true, ...(chat.rootId === undefined ? {} : { replyTo: chat.rootId }) }
}

/** Topic coordinates in the shape the card-topic registry stores. */
function topicOf(chat: ConversationMessage): { threadId?: string; rootId?: string } {
  return {
    ...(chat.threadId === undefined ? {} : { threadId: chat.threadId }),
    ...(chat.rootId === undefined ? {} : { rootId: chat.rootId }),
  }
}

/**
 * Render one message another surface sent, as a chat notice.
 *
 * Phase one deliberately does not upload the attached media: the parts are
 * counted and named instead, so the chat reader knows a picture exists and
 * where to look for it.
 *
 * @param parts - the message content parts.
 * @param origin - which surface sent it (`external-web` gets the browser label).
 * @param t - current translations.
 * @returns the notice text, or `''` when there is nothing to say.
 */
export function describeExternalMessage(
  parts: readonly MessagePart[],
  origin: UserMessageOrigin,
  t: Translations,
): string {
  const text = parts
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => String(part.text))
    .join('\n')
    .trim()
  const images = parts.filter(part => part.type === 'image').length
  const files = parts.filter(part => part.type !== 'text' && part.type !== 'image').length
  if (text === '' && images === 0 && files === 0) return ''
  const prefix = origin === 'external-web' ? t.externalMessageFromWebGui : t.externalMessageFromOther
  const clipped = text.length > ECHO_TEXT_CAP ? `${text.slice(0, ECHO_TEXT_CAP)}…` : text
  const attachmentNote = images + files > 0 ? t.externalMessageAttachments(images, files) : ''
  const head = clipped === '' ? prefix.trimEnd() : `${prefix}${clipped}`
  return [head, attachmentNote].filter(line => line !== '').join('\n')
}

/**
 * Mirror other surfaces' user messages into the chat and complete the turns
 * they start.
 *
 * @param deps - channel, bridge, live setting and the streaming/deliver seams.
 * @returns the disposer.
 */
export function startFeishuExternalTurns(deps: ExternalTurnsDeps): { stop: () => void } {
  const now = deps.now ?? (() => Date.now())
  const boundChat = (sessionId: string): ConversationMessage | undefined =>
    deps.bridgeHolder.current?.resolveChat(sessionId)

  const echo = async (sessionId: string, parts: readonly MessagePart[], origin: UserMessageOrigin): Promise<void> => {
    const chat = boundChat(sessionId)
    if (chat === undefined) return
    const text = describeExternalMessage(parts, origin, deps.getTranslations())
    if (text === '') return
    await deps.channel.send(chat.chatId, { text }, replyOpts(chat))
  }

  const complete = async (sessionId: string, chat: ConversationMessage): Promise<void> => {
    const t = deps.getTranslations()
    // Ordering first: `flushed()` only resolves once the final step card's
    // message exists, so the footer cannot overtake the answer it belongs to.
    const turnStats = await deps.flushed(sessionId).catch((error: unknown) => {
      deps.logger.warn(`dsh-feishu: external turn flush failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
    const meta = await deps.sessionMeta(chat).catch(() => undefined)
    const plan = deps.deliver === undefined
      ? undefined
      : await deps.deliver.plan({
          sessionId,
          chatId: chat.chatId,
          ...(chat.threadId === undefined ? {} : { topic: topicOf(chat) }),
          ...(meta?.workspace === undefined ? {} : { workspace: meta.workspace }),
          files: turnStats?.deliverables ?? [],
        }).catch((error: unknown) => {
          deps.logger.warn(`dsh-feishu: deliverable planning failed: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        })
    // Name what opened the turn: another human surface, or the family of
    // automation DSH woke the agent with (the Web UI's own names — a settled
    // job, a schedule, a subagent, a team message, a webhook, a goal round, a
    // plugin). A turn with no message at all still gets the generic family.
    const source = turnOrigin(sessionId) === 'external'
      ? (turnSurface(sessionId) === 'web' ? t.surfaceLabelWebGui : t.surfaceLabelOther)
      : t.autoTurnTriggerName(turnTrigger(sessionId) ?? 'request')
    const card = renderFooterCard(t, meta, turnStats, plan?.rows, source)
    try {
      if (card !== undefined) {
        const sent = await deps.channel.send(chat.chatId, { card }, replyOpts(chat))
        if (sent.messageId !== undefined) {
          const topic = topicOf(chat)
          if (topic.threadId !== undefined) deps.noteCardTopic?.(sent.messageId, topic)
        }
      }
    } finally {
      // Files are what the operator asked for: a failed card must not swallow
      // the auto-delivery (same rule the reply path follows).
      if (plan !== undefined && hasDeliverables(plan)) {
        await deps.deliver?.autoSend(plan, deliverChatOf(chat)).catch((error: unknown) => {
          deps.logger.warn(`dsh-feishu: external deliverable send failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }
  }

  const handle = (session: unknown, event: { type?: unknown; data?: unknown }): void => {
    try {
      const sessionId = (session as { id?: unknown } | undefined)?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (event.type === 'turn/start') {
        beginTurn(sessionId)
        return
      }
      if (event.type === 'user/message') {
        const data = event.data as { content?: unknown; source?: unknown } | undefined
        const parts = Array.isArray(data?.content) ? data.content as MessagePart[] : []
        const hasAttachment = parts.some(part => part.type === 'image' || part.type === 'file')
        const origin = noteUserMessage(
          sessionId,
          data?.source as { kind?: unknown; rpcId?: unknown; clientTimeZone?: unknown } | undefined,
          { hasAttachment },
          now(),
        )
        if (origin !== 'external-web' && origin !== 'external-other') return
        if (!deps.enabled()) return
        void echo(sessionId, parts, origin).catch((error: unknown) => {
          deps.logger.warn(`dsh-feishu: could not mirror an external message: ${error instanceof Error ? error.message : String(error)}`)
        })
        return
      }
      if (event.type === 'turn/end') {
        if (!deps.enabled()) return
        // A turn this plugin started is channel.ts's: it posts the reply and the
        // footer itself, and only it knows whether the text reached the chat.
        if (turnOrigin(sessionId) === 'feishu') return
        const chat = boundChat(sessionId)
        if (chat === undefined) return
        void complete(sessionId, chat).catch((error: unknown) => {
          deps.logger.warn(`dsh-feishu: external turn completion failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    } catch (error: unknown) {
      deps.logger.warn(`dsh-feishu: external turn handler error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const dispose = deps.ctx.on('session/event', handle)
  return { stop: dispose }
}

/** Chat coordinates for the deliver controller (topic included). */
function deliverChatOf(chat: ConversationMessage): DeliverChat {
  return {
    chatId: chat.chatId,
    ...(chat.threadId === undefined ? {} : { threadId: chat.threadId }),
    ...(chat.rootId === undefined ? {} : { rootId: chat.rootId }),
  }
}
