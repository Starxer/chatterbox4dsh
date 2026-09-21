/**
 * Which Feishu topic a card message was posted into.
 *
 * A Feishu card action event carries only `chatId` + `messageId` — never the
 * thread. Restoring the topic from the *chat* is ambiguous in a group with
 * several topics: one group has one `chatId` and many topics, so any
 * `chatId`-keyed map can only remember the LAST topic seen for that group.
 * With two topics active at once (very common: an older session keeps posting
 * step cards while a `/new` flow runs in a freshly created topic), that guess
 * flips and the flow's later cards — the model card and the final confirm
 * card — land in the wrong topic. Observed 2026-09-21: an inbound message in
 * an old topic moved it to the front of the bridge's most-recent list, and the
 * `/new` flow's model/confirm cards were sent into that old topic while its
 * picker/preset cards had correctly landed in the new one.
 *
 * `messageId` IS unambiguous: it identifies the exact card the operator
 * clicked, and the sender knows the topic it posted that card into. So every
 * card send records `messageId → topic` here, and every card action resolves
 * through this map first. The chat-level lookup stays as a last resort (a card
 * sent before this registry existed, or one that outlived a plugin reload).
 *
 * @module @starxer/chatterbox4dsh/card-topics
 */

/**
 * Topic coordinates: the thread id plus its root message id (`replyTo`).
 *
 * `| undefined` is explicit because the project compiles with
 * `exactOptionalPropertyTypes`: callers pass coordinates copied straight off a
 * `ConversationMessage`, where both fields are themselves optional.
 */
export interface TopicCoords {
  rootId?: string
  threadId?: string
}

export interface CardTopicRegistry {
  /** Remember that a card message was posted into `topic`. No-op unless the
   *  message id AND both topic coordinates are known. */
  note(messageId: string | undefined, topic: TopicCoords): void
  /** The topic a card message was posted into, `{}` when unknown. */
  for(messageId: string | undefined): TopicCoords
  clear(): void
}

/** Cards are short-lived flow steps; this many is far more than a chat keeps
 *  alive, and bounds the map in a long-running process. */
const DEFAULT_MAX_ENTRIES = 500

export function createCardTopicRegistry(maxEntries: number = DEFAULT_MAX_ENTRIES): CardTopicRegistry {
  // Map iteration order is insertion order; re-noting moves an entry to the
  // end, so the first key is always the oldest and can be evicted.
  const byMessage = new Map<string, { rootId: string; threadId: string }>()
  return {
    note(messageId: string | undefined, topic: TopicCoords): void {
      if (messageId === undefined || messageId === '') return
      const { rootId, threadId } = topic
      // Half-known coordinates are worse than none: handing a caller a
      // `threadId` with no `rootId` only lets it build `{ replyInThread: true }`
      // with no `replyTo`, which Feishu silently turns into a NEW top-level
      // message — a brand-new topic in a topic group.
      if (rootId === undefined || rootId === '' || threadId === undefined || threadId === '') return
      byMessage.delete(messageId)
      byMessage.set(messageId, { rootId, threadId })
      while (byMessage.size > maxEntries) {
        const oldest = byMessage.keys().next()
        if (oldest.done === true) break
        byMessage.delete(oldest.value)
      }
    },
    for(messageId: string | undefined): TopicCoords {
      if (messageId === undefined || messageId === '') return {}
      return byMessage.get(messageId) ?? {}
    },
    clear(): void {
      byMessage.clear()
    },
  }
}

/**
 * Resolve which topic a card-driven send belongs to, most reliable source
 * first:
 *
 * 1. the coordinates already carried by the message (a topic reply that came
 *    in through the channel, or a card action the caller already restored);
 * 2. the topic this exact card message was sent into;
 * 3. `chatFallback` — the caller's chat-level guess (the bridge's most recently
 *    used topic for that group). Correct while a group only ever uses one
 *    topic; ambiguous the moment a second one is in play, which is why it is
 *    the LAST resort.
 */
export function resolveCardTopic(input: {
  cardTopics: CardTopicRegistry
  message: { chatId: string; messageId?: string; threadId?: string; rootId?: string }
  chatFallback: () => TopicCoords
}): TopicCoords {
  const { message } = input
  if (message.threadId !== undefined && message.threadId !== '' && message.rootId !== undefined && message.rootId !== '') {
    return { threadId: message.threadId, rootId: message.rootId }
  }
  const exact = input.cardTopics.for(message.messageId)
  if (exact.threadId !== undefined && exact.rootId !== undefined) return exact
  return input.chatFallback()
}
