import type { LarkChannel } from '@larksuiteoapi/node-sdk'

/**
 * Resolve the ROOT message id of a Feishu topic (thread).
 *
 * The root is the message that started the topic and the only reliable
 * `replyTo` target for a reply that must land INSIDE the topic. Replying to a
 * non-root message of the thread does not reliably stay in the topic, and
 * omitting `replyTo` makes the SDK fall back to `im.v1.message.create` — a new
 * top-level message, which in a topic group shows up as a topic of its own.
 *
 * The id arrives on inbound events, but an existing binding persisted before
 * topic roots were stored (or one that only ever saw slash commands) has none,
 * so ask Feishu directly: `im.v1.message.list` with `container_id_type:
 * 'thread'` returns the thread in creation order, so the first item is the
 * root itself (`root_id` empty, `parent_id` empty). A non-root reply would
 * carry `root_id`, so preferring it keeps the result correct even if the
 * order were ever to change.
 *
 * Best-effort by design: a missing read scope, a deleted topic or a network
 * failure all resolve to `undefined` so the caller can leave the topic
 * unresolved instead of failing the connection.
 */
export async function fetchThreadRootId(channel: LarkChannel, threadId: string): Promise<string | undefined> {
  if (threadId === '') return undefined
  try {
    const response = await channel.rawClient.im.v1.message.list({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        sort_type: 'ByCreateTimeAsc',
        page_size: 1,
      },
    })
    const first = response.data?.items?.[0]
    if (first === undefined) return undefined
    const rootId = first.root_id ?? first.message_id
    return rootId === undefined || rootId === '' ? undefined : rootId
  } catch (error: unknown) {
    // Not fatal: the topic stays unresolved (its cards fall back to the main
    // chat) until an inbound message records the root, which always works.
    console.log(
      `dsh-feishu: could not resolve the topic root for thread ${threadId.slice(0, 8)}…: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}
