import { describe, expect, it, vi } from 'vitest'
import { fetchThreadRootId } from '../src/topic-roots.ts'

function channelWith(list: (params: any) => Promise<any>) {
  const messageList = vi.fn(list)
  return {
    channel: { rawClient: { im: { v1: { message: { list: messageList } } } } } as any,
    messageList,
  }
}

describe('fetchThreadRootId', () => {
  it('asks for the thread in creation order and takes the first message', async () => {
    const { channel, messageList } = channelWith(async () => ({
      data: { items: [{ message_id: 'om_root' }] },
    }))
    await expect(fetchThreadRootId(channel, 'omt_1')).resolves.toBe('om_root')
    expect(messageList).toHaveBeenCalledWith({
      params: {
        container_id_type: 'thread',
        container_id: 'omt_1',
        sort_type: 'ByCreateTimeAsc',
        page_size: 1,
      },
    })
  })

  it('prefers root_id so a non-root first item still resolves the topic root', async () => {
    const { channel } = channelWith(async () => ({
      data: { items: [{ message_id: 'om_reply', root_id: 'om_root' }] },
    }))
    await expect(fetchThreadRootId(channel, 'omt_1')).resolves.toBe('om_root')
  })

  it('returns undefined for an empty thread, a missing root id and an empty argument', async () => {
    const empty = channelWith(async () => ({ data: { items: [] } }))
    await expect(fetchThreadRootId(empty.channel, 'omt_1')).resolves.toBeUndefined()
    const blank = channelWith(async () => ({ data: { items: [{ message_id: '' }] } }))
    await expect(fetchThreadRootId(blank.channel, 'omt_1')).resolves.toBeUndefined()
    const { channel, messageList } = channelWith(async () => ({ data: {} }))
    await expect(fetchThreadRootId(channel, '')).resolves.toBeUndefined()
    expect(messageList).not.toHaveBeenCalled()
  })

  it('degrades to undefined when the API rejects (missing read scope, deleted topic)', async () => {
    const { channel } = channelWith(async () => {
      throw new Error('permission denied')
    })
    await expect(fetchThreadRootId(channel, 'omt_1')).resolves.toBeUndefined()
  })
})
