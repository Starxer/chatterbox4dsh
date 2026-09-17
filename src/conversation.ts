import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { DomainName } from './config.ts'
import { displayFailure, type TurnFailure } from './turn-failure.ts'

export interface ConversationMessage {
  chatId: string
  chatType: 'p2p' | 'group'
  threadId?: string
  /** Topic root message id — the correct `replyTo` target when replying into a Feishu topic. */
  rootId?: string
  replyToMessageId?: string
}

export function conversationKey(message: ConversationMessage): string {
  return message.threadId === undefined
    ? `chat:${message.chatId}`
    : `thread:${message.chatId}:${message.threadId}`
}

/** Chat key for a Feishu topic: one DSH session per (chat, thread) pair. */
export function threadChatKey(chatId: string, threadId: string): string {
  return `thread:${chatId}:${threadId}`
}

/**
 * Inverse of {@link conversationKey}. Topic thread ids contain no `:`, but the
 * `rest.join(':')` keeps a malformed key from silently truncating the id.
 */
export function parseChatKey(key: string): { chatId: string; threadId?: string } {
  if (!key.startsWith('thread:')) return { chatId: key.slice('chat:'.length) }
  const [, chatId, ...rest] = key.split(':')
  return { chatId: chatId ?? '', threadId: rest.join(':') }
}

export function toSessionId(domain: DomainName, key: string): SessionId {
  const digest = createHash('sha256').update(`${domain}\0${key}`).digest('hex').slice(0, 40)
  // v2 sessions include the Harness workspace and agent-preset composition.
  // Keep them separate from sessions created by releases that lacked it.
  return SessionId(`lark-v2-${digest}`)
}

interface EventLike {
  seq: number
  type: string
  data: any
}

export interface TurnSummary {
  text: string
  ok: boolean
  /** `turn/end` reason kind for the summarised turn, when one was in range. */
  ended?: string
  /**
   * Structured failure carried by an `error` ending, projected the way the DSH
   * Web UI projects it (`turn-failure.ts`). The Web UI renders exactly these
   * facts; the channel must not replace them with a generic sentence.
   */
  failure?: TurnFailure
}

export function summarizeTurn(events: readonly EventLike[], firstSeq: number): TurnSummary {
  let text = ''
  let completed = false
  let failed = false
  let hasAssistantMessage = false
  let ended: string | undefined
  let failure: TurnFailure | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      hasAssistantMessage = true
      const message = event.data?.message
      if (message !== undefined && message !== null) {
        const content = message.content
        if (Array.isArray(content)) {
          const next = content
            .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
            .map((block: any) => block.text)
            .join('')
          if (next !== '') text = next
        }
      }
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason !== undefined && reason !== null) {
        completed = reason.kind === 'completed'
        failed = reason.kind === 'error'
        ended = typeof reason.kind === 'string' ? reason.kind : undefined
        // The failure facts ride on the ending itself; keep them intact so the
        // channel can render what the Web UI renders.
        failure = reason.kind === 'error' ? displayFailure(reason.error) : undefined
      }
    }
  }
  if (completed && !failed && text === '' && hasAssistantMessage) {
    return { text: '(no text response)', ok: true, ...ended === undefined ? {} : { ended } }
  }
  return {
    text,
    ok: completed && !failed && text !== '',
    ...ended === undefined ? {} : { ended },
    ...failure === undefined ? {} : { failure },
  }
}
