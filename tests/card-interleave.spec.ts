import { describe, expect, it, vi } from 'vitest'
import {
  createCardInterleave,
  interleaveHits,
  interleaveTargetOfChat,
  interleaveTargetOfSend,
} from '../src/card-interleave.ts'

describe('createCardInterleave', () => {
  it('hands every notice to every listener', () => {
    const registry = createCardInterleave()
    const first = vi.fn()
    const second = vi.fn()
    registry.onNotice(first)
    registry.onNotice(second)
    registry.note({ chatId: 'oc_1', rootId: 'om_root' })
    expect(first).toHaveBeenCalledWith({ chatId: 'oc_1', rootId: 'om_root' })
    expect(second).toHaveBeenCalledWith({ chatId: 'oc_1', rootId: 'om_root' })
  })

  it('stops delivering after the unsubscribe function runs', () => {
    const registry = createCardInterleave()
    const listener = vi.fn()
    const off = registry.onNotice(listener)
    registry.note({ chatId: 'oc_1' })
    off()
    registry.note({ chatId: 'oc_2' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('contains a throwing listener so the send that fired it still lands', () => {
    const registry = createCardInterleave()
    const healthy = vi.fn()
    registry.onNotice(() => { throw new Error('listener down') })
    registry.onNotice(healthy)
    expect(() => registry.note({ chatId: 'oc_1' })).not.toThrow()
    expect(healthy).toHaveBeenCalledWith({ chatId: 'oc_1' })
  })
})

describe('interleaveTargetOfSend', () => {
  it('maps a main-timeline send to the chat', () => {
    expect(interleaveTargetOfSend('oc_1')).toEqual({ chatId: 'oc_1' })
    expect(interleaveTargetOfSend('oc_1', {})).toEqual({ chatId: 'oc_1' })
  })

  it('maps a topic send to the chat plus that topic root', () => {
    expect(interleaveTargetOfSend('oc_1', { replyInThread: true, replyTo: 'om_root' }))
      .toEqual({ chatId: 'oc_1', rootId: 'om_root' })
  })

  it('drops a topic send whose root id is unknown — it lands at the top level anyway', () => {
    // 关键坑 25: without a root id `reply_in_thread` cannot target the topic, so
    // attributing the message to a conversation would be a guess.
    expect(interleaveTargetOfSend('oc_1', { replyInThread: true })).toBeUndefined()
    expect(interleaveTargetOfSend('oc_1', { replyInThread: true, replyTo: '' })).toBeUndefined()
  })
})

describe('interleaveHits', () => {
  const mainChat = { chatId: 'oc_1' }
  const topicChat = { chatId: 'oc_1', threadId: 'omt_1', rootId: 'om_root' }

  it('keeps the main timeline and a topic apart', () => {
    expect(interleaveTargetOfChat(mainChat)).toEqual({ chatId: 'oc_1' })
    expect(interleaveTargetOfChat(topicChat)).toEqual({ chatId: 'oc_1', rootId: 'om_root' })
    expect(interleaveHits(topicChat, { chatId: 'oc_1' })).toBe(false)
    expect(interleaveHits(mainChat, { chatId: 'oc_1', rootId: 'om_root' })).toBe(false)
  })

  it('matches only the SAME topic root (one topic never cuts another)', () => {
    expect(interleaveHits(topicChat, { chatId: 'oc_1', rootId: 'om_root' })).toBe(true)
    expect(interleaveHits(topicChat, { chatId: 'oc_1', rootId: 'om_other' })).toBe(false)
    expect(interleaveHits(topicChat, { chatId: 'oc_2', rootId: 'om_root' })).toBe(false)
    expect(interleaveHits(mainChat, { chatId: 'oc_1' })).toBe(true)
    expect(interleaveHits(mainChat, { chatId: 'oc_2' })).toBe(false)
  })

  it('never segments a topic turn whose root id is unknown', () => {
    const unknownRoot = { chatId: 'oc_1', threadId: 'omt_1' }
    expect(interleaveTargetOfChat(unknownRoot)).toBeUndefined()
    expect(interleaveHits(unknownRoot, { chatId: 'oc_1' })).toBe(false)
    expect(interleaveHits(unknownRoot, { chatId: 'oc_1', rootId: 'om_root' })).toBe(false)
  })
})
