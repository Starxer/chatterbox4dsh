/**
 * "Another message just landed in this conversation" — the signal a long-lived
 * card needs to stop growing above it.
 *
 * A card updated in place keeps rendering NEW content at the position where it
 * already sits in the conversation. Once another message is posted after it — a
 * todo card, a job card, a subagent panel, a question card, a compaction card, a
 * busy notice, an error line — further updates read out of order: the newest
 * progress row appears ABOVE whatever the reader got later. So a long-lived card
 * is really a SEGMENT, and this registry is what ends one. The compact turn card
 * (`src/feishu-progress.ts`) subscribes and opens a NEW card after the
 * interruption, carrying only what happened since.
 *
 * It counts EVERY message, not only cards (user request, 2026-10-19): steering a
 * message into a running turn posts a notice in the chat, and progress written
 * above that notice was easy to miss. The module keeps its historical name; the
 * rule is "any other message".
 *
 * **Scope is the CONVERSATION, not the chat**: one Feishu topic is one DSH
 * session (user rule, 2026-10-19: "每个话题应该互不干扰"), so a message in topic A
 * must not cut the card of a turn running in topic B of the same group. A send
 * into a topic replies to that topic's ROOT message, so the root id is the
 * identity carried here; a message with no root id belongs to the chat's main
 * timeline. A topic send whose root id is unknown cannot be attributed — the
 * channel routes it to the top level anyway (关键坑 25) — and ending a segment for
 * it would be a guess, so it is ignored.
 *
 * @module @starxer/chatterbox4dsh/card-interleave
 */

/** Where an interrupting message landed. Absent `rootId` = the main chat timeline. */
export interface InterleaveTarget {
  readonly chatId: string
  /** Topic ROOT message id (the `replyTo` of a topic send). Absent = main chat. */
  readonly rootId?: string
}

/** Fan-out for "another message was posted into this conversation". */
export interface CardInterleave {
  /** Record that a message (card or text) was posted into `target`. */
  note(target: InterleaveTarget): void
  /** Observe notices. Returns the unsubscribe function. */
  onNotice(listener: (target: InterleaveTarget) => void): () => void
}

/**
 * Create the registry. One instance is shared by the whole plugin (created in
 * `src/index.ts` and handed to the modules that own long-lived cards).
 *
 * @returns the registry.
 */
export function createCardInterleave(): CardInterleave {
  const listeners = new Set<(target: InterleaveTarget) => void>()
  return {
    note(target: InterleaveTarget): void {
      for (const listener of [...listeners]) {
        try {
          listener(target)
        } catch {
          // A listener must never break the send that triggered it.
        }
      }
    },
    onNotice(listener: (target: InterleaveTarget) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * The conversation a `send` call lands in, reduced from its delivery options.
 *
 * @param chatId - the delivery target (`oc_…`).
 * @param opts - the send's topic coordinates.
 * @returns the target, or `undefined` for a topic send with no root id: the
 *   channel cannot land it inside the topic, so it must not cut any card.
 */
export function interleaveTargetOfSend(
  chatId: string,
  opts?: { replyInThread?: boolean; replyTo?: string },
): InterleaveTarget | undefined {
  if (opts?.replyInThread !== true) return { chatId }
  return opts.replyTo === undefined || opts.replyTo === '' ? undefined : { chatId, rootId: opts.replyTo }
}

/**
 * The conversation a long-lived card belongs to.
 *
 * @param chat - the card's conversation.
 * @returns the target, or `undefined` when the topic's root id is unknown: the
 *   card can then never be attributed, which is safer than matching every
 *   main-chat message.
 */
export function interleaveTargetOfChat(
  chat: { chatId: string; threadId?: string; rootId?: string },
): InterleaveTarget | undefined {
  if (chat.threadId === undefined) return { chatId: chat.chatId }
  return chat.rootId === undefined || chat.rootId === '' ? undefined : { chatId: chat.chatId, rootId: chat.rootId }
}

/**
 * Whether a notice for `target` interrupts the conversation `chat` belongs to.
 *
 * @returns `true` only for the SAME conversation — one topic never cuts another.
 */
export function interleaveHits(
  chat: { chatId: string; threadId?: string; rootId?: string },
  target: InterleaveTarget,
): boolean {
  const own = interleaveTargetOfChat(chat)
  return own !== undefined && own.chatId === target.chatId && own.rootId === target.rootId
}
