/**
 * "Another message just landed in this chat" — the signal a long-lived card
 * needs to stop growing above it.
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
 * @module @starxer/chatterbox4dsh/card-interleave
 */

/** Fan-out for "another message was posted into this chat". */
export interface CardInterleave {
  /** Record that a message (card or text) was posted into `chatId`. */
  note(chatId: string): void
  /** Observe notices. Returns the unsubscribe function. */
  onNotice(listener: (chatId: string) => void): () => void
}

/**
 * Create the registry. One instance is shared by the whole plugin (created in
 * `src/index.ts` and handed to the modules that own long-lived cards).
 *
 * @returns the registry.
 */
export function createCardInterleave(): CardInterleave {
  const listeners = new Set<(chatId: string) => void>()
  return {
    note(chatId: string): void {
      for (const listener of [...listeners]) {
        try {
          listener(chatId)
        } catch {
          // A listener must never break the send that triggered it.
        }
      }
    },
    onNotice(listener: (chatId: string) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
