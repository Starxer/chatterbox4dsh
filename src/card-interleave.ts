/**
 * "Another card just landed in this chat" — the signal a long-lived card needs
 * to stop growing above it.
 *
 * A card updated in place keeps rendering NEW content at the position where it
 * already sits in the conversation. Once another module posts a card after it —
 * the todo list, a job card, a subagent panel, a question card, a compaction
 * card — further updates read out of order: the newest line appears ABOVE the
 * card that was posted later. So a long-lived card is really a SEGMENT, and this
 * registry is what ends one. The compact turn card (`src/feishu-progress.ts`)
 * subscribes and opens a NEW card after the interruption, carrying only what
 * happened since.
 *
 * Notices fire for CARDS only. A plain text message (a busy notice, an error
 * reason, an external-turn echo) does not reorder card content the same way, and
 * treating those as interruptions would multiply cards for no gain.
 *
 * @module @starxer/chatterbox4dsh/card-interleave
 */

/** Fan-out for "another module posted a card into this chat". */
export interface CardInterleave {
  /** Record that a card was posted into `chatId` by another module. */
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
