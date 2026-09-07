import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFeishuReceiveFileTool } from '../src/feishu-receive-file.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { HarnessConversationService } from '../src/harness.ts'

/** Minimal Cordis context exposing only tools.register. */
function fakeCtx() {
  const registered: Array<{ name: string; exec: (args: any) => Promise<unknown> }> = []
  return {
    registered,
    scope: { fork: undefined },
    tools: {
      register: (tool: any) => {
        registered.push(tool)
        return () => undefined
      },
    },
  }
}

/** Minimal channel exposing the raw resource client + a curlable download. */
function fakeChannel(downloadBytes: Buffer) {
  const { Readable } = require('node:stream') as typeof import('node:stream')
  return {
    send: vi.fn(async () => ({ messageId: 'm' })),
    rawClient: {
      im: {
        v1: {
          messageResource: {
            get: vi.fn(async () => ({
              getReadableStream: () => Readable.from(downloadBytes),
              writeFile: undefined,
              headers: {},
            })),
          },
        },
      },
    },
  } as unknown as LarkChannel
}

/** Fake native attachment store: persist bytes to a temp dir and answer a host path. */
async function fakeAttachments() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rx-'))
  const captured: Buffer[] = []
  return {
    root,
    captured,
    saveFileStream: vi.fn(async (input: { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string }): Promise<FileAttachmentRef> => {
      const chunks: Buffer[] = []
      for await (const chunk of input.data) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      captured.push(bytes)
      const hostPath = join(root, input.name ?? 'file')
      await writeFile(hostPath, bytes)
      return {
        attachmentId: `att_${bytes.byteLength}` as FileAttachmentRef['attachmentId'],
        name: input.name ?? 'file',
        bytes: bytes.byteLength,
      }
    }),
    fileHostPath: vi.fn((ref: FileAttachmentRef) => join(root, ref.name)),
  }
}

describe('startFeishuReceiveFileTool', () => {
  it('registers a tool named feishu_receive_file', async () => {
    const attachments = await fakeAttachments()
    const fake = fakeCtx()
    const ctx = fake as unknown as Context
    const channelHolder = { current: fakeChannel(Buffer.from('hi')) }
    const bridgeHolder = { current: {} as HarnessConversationService }
    const disposer = startFeishuReceiveFileTool({
      ctx,
      bridgeHolder,
      channelHolder,
      attachments,
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    expect(fake.registered.some(t => t.name === 'feishu_receive_file')).toBe(true)
    disposer()
  })

  it('downloads by message_id + file_key into the native store and returns the host path', async () => {
    const attachments = await fakeAttachments()
    const fake = fakeCtx()
    const ctx = fake as unknown as Context
    const bytes = Buffer.from('pdf payload bytes')
    const channel = fakeChannel(bytes)
    const channelHolder = { current: channel }
    const bridge = {
      resolveChat: vi.fn(() => ({ chatId: 'oc_1', chatType: 'p2p' as const, threadId: undefined })),
    } as unknown as HarnessConversationService
    const bridgeHolder = { current: bridge }
    startFeishuReceiveFileTool({
      ctx,
      bridgeHolder,
      channelHolder,
      attachments,
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const tool = fake.registered.find((t: any) => t.name === 'feishu_receive_file') as any
    const agent = { id: 'sess_1' }
    const result = await tool.execute(
      { message_id: 'om_9', file_key: 'fkey_x', file_name: 'paper.pdf' },
      { agent, signal: { throwIfAborted: () => undefined } },
    )

    expect(channel.rawClient.im.v1.messageResource.get).toHaveBeenCalledWith({
      params: { type: 'file' },
      path: { message_id: 'om_9', file_key: 'fkey_x' },
    })
    expect(bridge.resolveChat).toHaveBeenCalledWith('sess_1')
    expect(attachments.saveFileStream).toHaveBeenCalledOnce()
    const input = attachments.saveFileStream.mock.calls[0]![0] as { data: AsyncIterable<Uint8Array>; name: string }
    expect(input.name).toBe('paper.pdf')
    expect(attachments.captured).toHaveLength(1)
    expect(attachments.captured[0]!.toString()).toBe('pdf payload bytes')
    expect(result.file_name).toBe('paper.pdf')
    expect(result.path).toBe(join(attachments.root, 'paper.pdf'))
  })

  it('fails with a clear error for an unbound session', async () => {
    const attachments = await fakeAttachments()
    const fake = fakeCtx()
    const ctx = fake as unknown as Context
    const channelHolder = { current: fakeChannel(Buffer.from('hi')) }
    const bridgeHolder = { current: { resolveChat: vi.fn(() => undefined) } as unknown as HarnessConversationService }
    startFeishuReceiveFileTool({
      ctx,
      bridgeHolder,
      channelHolder,
      attachments,
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    const tool = fake.registered.find((t: any) => t.name === 'feishu_receive_file') as any
    await expect(tool.execute(
      { message_id: 'om', file_key: 'fk' },
      { agent: { id: 'sess_x' }, signal: { throwIfAborted: () => undefined } },
    )).rejects.toThrow('not bound to a Feishu chat')
  })

  it('rejects empty downloads', async () => {
    const attachments = await fakeAttachments()
    const fake = fakeCtx()
    const ctx = fake as unknown as Context
    const channelHolder = { current: fakeChannel(Buffer.alloc(0)) }
    const bridgeHolder = { current: { resolveChat: vi.fn(() => ({ chatId: 'oc', chatType: 'p2p' as const })) } as unknown as HarnessConversationService }
    startFeishuReceiveFileTool({
      ctx,
      bridgeHolder,
      channelHolder,
      attachments,
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    const tool = fake.registered.find((t: any) => t.name === 'feishu_receive_file') as any
    await expect(tool.execute(
      { message_id: 'om', file_key: 'fk' },
      { agent: { id: 'sess_x' }, signal: { throwIfAborted: () => undefined } },
    )).rejects.toThrow('empty file')
  })
})
