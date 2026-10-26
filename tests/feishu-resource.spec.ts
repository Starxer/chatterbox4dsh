import { describe, expect, it, vi } from 'vitest'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import {
  OWNER_LOOKUP_PAGE_SIZE,
  RESOURCE_NOT_IN_MESSAGE,
  downloadInboundResource,
  isResourceNotInMessage,
} from '../src/feishu-resource.ts'

/**
 * 2026-10-27: two images sent together merged into ONE dispatch whose
 * `messageId` was the LAST message's while `resources` held both images, so the
 * plugin asked for `(message_id_B, image_key_A)` and Feishu answered
 * `400 {"code":234003,"msg":"File not in msg."}` — 「图片处理出错」. The owner
 * lookup below is what turns that dead end back into a download.
 */

/** An axios-style rejection carrying the streamed Feishu body. */
function rejection(code = RESOURCE_NOT_IN_MESSAGE, status = 400): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    code: 'ERR_BAD_REQUEST',
    response: { status, data: Buffer.from(JSON.stringify({ code, msg: 'File not in msg.' })) },
  })
}

interface Calls {
  get: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  file: ReturnType<typeof vi.fn>
}

function fakeChannel(options: {
  download: (messageId: string, fileKey: string) => Promise<unknown>
  messages?: Array<{ message_id: string; body: { content: string } }>
  listThrows?: boolean
  fileGet?: () => Promise<unknown>
}): { channel: LarkChannel; calls: Calls } {
  const calls: Calls = {
    get: vi.fn(async (payload: { path?: { message_id?: string; file_key?: string } }) =>
      options.download(payload.path?.message_id ?? '', payload.path?.file_key ?? '')),
    list: vi.fn(async () => {
      if (options.listThrows === true) throw new Error('list failed')
      return { code: 0, data: { items: options.messages ?? [] } }
    }),
    file: vi.fn(options.fileGet ?? (async () => ({ getReadableStream: () => undefined }))),
  }
  const channel = {
    rawClient: {
      im: {
        v1: {
          messageResource: { get: calls.get },
          message: { list: calls.list },
          file: { get: calls.file },
        },
      },
    },
  } as unknown as LarkChannel
  return { channel, calls }
}

describe('downloadInboundResource', () => {
  it('downloads straight away when the pair is right (no lookup)', async () => {
    const { channel, calls } = fakeChannel({ download: async () => 'RAW' })
    const raw = await downloadInboundResource(channel, { messageId: 'om_1', chatId: 'oc_1' }, 'img_1', 'image')
    expect(raw).toBe('RAW')
    expect(calls.get).toHaveBeenCalledWith({ params: { type: 'image' }, path: { message_id: 'om_1', file_key: 'img_1' } })
    expect(calls.list).not.toHaveBeenCalled()
  })

  it('recovers the OWNING message of a batched resource and retries there', async () => {
    // The merged dispatch names the last message; the resource belongs to the
    // first one. One bounded listing in the same thread finds it.
    const { channel, calls } = fakeChannel({
      download: async (messageId) => {
        if (messageId === 'om_last') throw rejection()
        return 'RAW-OWNED'
      },
      messages: [
        { message_id: 'om_last', body: { content: '{"image_key":"img_other"}' } },
        { message_id: 'om_owner', body: { content: '{"image_key":"img_1"}' } },
      ],
    })
    const raw = await downloadInboundResource(
      channel,
      { messageId: 'om_last', chatId: 'oc_1', threadId: 'omt_1' },
      'img_1',
      'image',
    )
    expect(raw).toBe('RAW-OWNED')
    expect(calls.list).toHaveBeenCalledWith({
      params: { container_id_type: 'thread', container_id: 'omt_1', sort_type: 'ByCreateTimeDesc', page_size: OWNER_LOOKUP_PAGE_SIZE },
    })
    expect(calls.get).toHaveBeenLastCalledWith({ params: { type: 'image' }, path: { message_id: 'om_owner', file_key: 'img_1' } })
  })

  it('falls back to the chat container when the message is not in a topic', async () => {
    const { channel, calls } = fakeChannel({
      download: async (messageId) => {
        if (messageId === 'om_last') throw rejection()
        return 'RAW'
      },
      messages: [{ message_id: 'om_owner', body: { content: '{"image_key":"img_1"}' } }],
    })
    await downloadInboundResource(channel, { messageId: 'om_last', chatId: 'oc_main' }, 'img_1', 'image')
    expect(calls.list).toHaveBeenCalledWith({
      params: { container_id_type: 'chat', container_id: 'oc_main', sort_type: 'ByCreateTimeDesc', page_size: OWNER_LOOKUP_PAGE_SIZE },
    })
  })

  it('rethrows the original failure when nothing owns the key', async () => {
    const { channel, calls } = fakeChannel({
      download: async () => { throw rejection() },
      messages: [{ message_id: 'om_other', body: { content: '{"image_key":"img_other"}' } }],
    })
    await expect(downloadInboundResource(channel, { messageId: 'om_last', chatId: 'oc_1' }, 'img_1', 'image'))
      .rejects.toThrow('Request failed with status code 400')
    expect(calls.list).toHaveBeenCalledOnce()
    expect(calls.file).not.toHaveBeenCalled()
  })

  it('does not look up the owner for a non-400 failure', async () => {
    const { channel, calls } = fakeChannel({ download: async () => { throw new Error('getaddrinfo ENOTFOUND') } })
    await expect(downloadInboundResource(channel, { messageId: 'om_1', chatId: 'oc_1' }, 'img_1', 'image'))
      .rejects.toThrow('ENOTFOUND')
    expect(calls.list).not.toHaveBeenCalled()
  })

  it('falls back to im.v1.file.get for file resources when the owner is unknown', async () => {
    const { channel, calls } = fakeChannel({
      download: async () => { throw rejection() },
      messages: [],
      fileGet: async () => 'RAW-FILE',
    })
    const raw = await downloadInboundResource(channel, { messageId: 'om_1', chatId: 'oc_1' }, 'file_v2_x', 'file')
    expect(raw).toBe('RAW-FILE')
    expect(calls.file).toHaveBeenCalledWith({ path: { file_key: 'file_v2_x' } })
  })

  it('survives a failing listing (the download error is what surfaces)', async () => {
    const { channel } = fakeChannel({ download: async () => { throw rejection() }, listThrows: true })
    await expect(downloadInboundResource(channel, { messageId: 'om_1', chatId: 'oc_1' }, 'img_1', 'image'))
      .rejects.toThrow('Request failed with status code 400')
  })
})

describe('isResourceNotInMessage', () => {
  it('recognises the business code', () => {
    expect(isResourceNotInMessage(rejection())).toBe(true)
  })

  it('treats a bare 400 as the same case (streamed body, no parsed code)', () => {
    const bare = Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: {} } })
    expect(isResourceNotInMessage(bare)).toBe(true)
  })

  it('ignores other statuses and other business codes', () => {
    expect(isResourceNotInMessage(rejection(230002, 403))).toBe(false)
    expect(isResourceNotInMessage(new Error('boom'))).toBe(false)
  })
})
