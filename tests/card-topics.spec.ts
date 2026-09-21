import { describe, expect, it, vi } from 'vitest'
import { createCardTopicRegistry, resolveCardTopic } from '../src/card-topics.ts'

describe('card topic registry', () => {
  it('round-trips the topic of a card message', () => {
    const topics = createCardTopicRegistry()
    topics.note('om_card', { threadId: 'omt_a', rootId: 'om_root_a' })
    expect(topics.for('om_card')).toEqual({ threadId: 'omt_a', rootId: 'om_root_a' })
  })

  it('keeps the LAST topic for a message id that is somehow reused', () => {
    const topics = createCardTopicRegistry()
    topics.note('om_card', { threadId: 'omt_a', rootId: 'om_root_a' })
    topics.note('om_card', { threadId: 'omt_b', rootId: 'om_root_b' })
    expect(topics.for('om_card')).toEqual({ threadId: 'omt_b', rootId: 'om_root_b' })
  })

  it('refuses half-known coordinates instead of storing them', () => {
    // `{ replyInThread: true }` with no `replyTo` is the silent top-level
    // fallback that turns a card into a brand-new topic in a topic group.
    const topics = createCardTopicRegistry()
    topics.note('om_1', { threadId: 'omt_a' })
    topics.note('om_2', { rootId: 'om_root_a' })
    topics.note('om_3', { threadId: '', rootId: 'om_root_a' })
    topics.note(undefined, { threadId: 'omt_a', rootId: 'om_root_a' })
    topics.note('', { threadId: 'omt_a', rootId: 'om_root_a' })
    expect(topics.for('om_1')).toEqual({})
    expect(topics.for('om_2')).toEqual({})
    expect(topics.for('om_3')).toEqual({})
    expect(topics.for(undefined)).toEqual({})
    expect(topics.for('')).toEqual({})
  })

  it('evicts the oldest cards once the cap is reached', () => {
    const topics = createCardTopicRegistry(2)
    topics.note('om_1', { threadId: 'omt_a', rootId: 'om_root_a' })
    topics.note('om_2', { threadId: 'omt_b', rootId: 'om_root_b' })
    topics.note('om_3', { threadId: 'omt_c', rootId: 'om_root_c' })
    expect(topics.for('om_1')).toEqual({})
    expect(topics.for('om_2')).toEqual({ threadId: 'omt_b', rootId: 'om_root_b' })
    expect(topics.for('om_3')).toEqual({ threadId: 'omt_c', rootId: 'om_root_c' })
  })

  it('clear() forgets everything', () => {
    const topics = createCardTopicRegistry()
    topics.note('om_1', { threadId: 'omt_a', rootId: 'om_root_a' })
    topics.clear()
    expect(topics.for('om_1')).toEqual({})
  })
})

describe('resolveCardTopic', () => {
  it('prefers the coordinates the clicked message already carries', () => {
    const chatFallback = vi.fn(() => ({ threadId: 'omt_guess', rootId: 'om_root_guess' }))
    const topics = createCardTopicRegistry()
    topics.note('om_card', { threadId: 'omt_from_card', rootId: 'om_root_from_card' })
    expect(resolveCardTopic({
      cardTopics: topics,
      message: { chatId: 'oc_1', messageId: 'om_card', threadId: 'omt_direct', rootId: 'om_root_direct' },
      chatFallback,
    })).toEqual({ threadId: 'omt_direct', rootId: 'om_root_direct' })
    expect(chatFallback).not.toHaveBeenCalled()
  })

  it('uses the topic the clicked CARD was sent into when the message has none', () => {
    const chatFallback = vi.fn(() => ({ threadId: 'omt_guess', rootId: 'om_root_guess' }))
    const topics = createCardTopicRegistry()
    topics.note('om_card', { threadId: 'omt_from_card', rootId: 'om_root_from_card' })
    expect(resolveCardTopic({
      cardTopics: topics,
      message: { chatId: 'oc_1', messageId: 'om_card' },
      chatFallback,
    })).toEqual({ threadId: 'omt_from_card', rootId: 'om_root_from_card' })
    expect(chatFallback).not.toHaveBeenCalled()
  })

  /**
   * The 2026-09-21 incident: a group had an old topic and a freshly created
   * one. The `/new` flow's picker/preset cards went into the new topic, then an
   * unrelated inbound message in the OLD topic made it the group's
   * most-recently-used topic — and the flow's model + confirm cards were posted
   * into that old topic. The chat-level guess is exactly what flipped; the
   * card's own message id is what must win.
   */
  it('ignores the group-wide "most recent topic" guess when the card is known', () => {
    const topics = createCardTopicRegistry()
    topics.note('om_preset_card', { threadId: 'omt_new', rootId: 'om_root_new' })
    const chatFallback = vi.fn(() => ({ threadId: 'omt_old', rootId: 'om_root_old' }))
    expect(resolveCardTopic({
      cardTopics: topics,
      message: { chatId: 'oc_group', messageId: 'om_preset_card' },
      chatFallback,
    })).toEqual({ threadId: 'omt_new', rootId: 'om_root_new' })
    expect(chatFallback).not.toHaveBeenCalled()
  })

  it('falls back to the chat-level guess for an unknown card (or none at all)', () => {
    const topics = createCardTopicRegistry()
    const chatFallback = () => ({ threadId: 'omt_only', rootId: 'om_root_only' })
    expect(resolveCardTopic({ cardTopics: topics, message: { chatId: 'oc_1', messageId: 'om_unknown' }, chatFallback }))
      .toEqual({ threadId: 'omt_only', rootId: 'om_root_only' })
    expect(resolveCardTopic({ cardTopics: topics, message: { chatId: 'oc_1' }, chatFallback }))
      .toEqual({ threadId: 'omt_only', rootId: 'om_root_only' })
  })

  it('does not treat half-known message coordinates as a topic', () => {
    const topics = createCardTopicRegistry()
    expect(resolveCardTopic({
      cardTopics: topics,
      message: { chatId: 'oc_1', threadId: 'omt_a' },
      chatFallback: () => ({ threadId: 'omt_only', rootId: 'om_root_only' }),
    })).toEqual({ threadId: 'omt_only', rootId: 'om_root_only' })
  })

  /**
   * DM (`p2p`) and a group with topic mode OFF have no thread at all: no
   * coordinates on the message, nothing in the registry (a card send with no
   * topic records nothing), and the chat-level sources are empty too. The
   * result must be "no topic", i.e. a plain top-level message — exactly what
   * the pre-fix code did.
   */
  it('resolves to no topic at all for a DM or a plain group', () => {
    const topics = createCardTopicRegistry()
    const empty = (): { threadId?: string; rootId?: string } => ({})
    expect(resolveCardTopic({ cardTopics: topics, message: { chatId: 'oc_dm' }, chatFallback: empty })).toEqual({})
    expect(resolveCardTopic({ cardTopics: topics, message: { chatId: 'oc_dm', messageId: 'om_card' }, chatFallback: empty })).toEqual({})
  })
})
