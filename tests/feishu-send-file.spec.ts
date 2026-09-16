import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startFeishuSendFileTool } from '../src/feishu-send-file.ts'
import { mp4Bytes, oggBytes } from './stubs/media-bytes.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { HarnessConversationService } from '../src/harness.ts'

/** Minimal Cordis context exposing only tools.register. */
function fakeCtx() {
  const registered: Array<any> = []
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

function fakeChannel() {
  return {
    send: vi.fn(async () => ({ messageId: 'm' })),
    rawClient: {
      im: { v1: { image: { create: vi.fn(async () => ({ image_key: 'img_cover' })) } } },
    },
  } as unknown as LarkChannel
}

/** Fake bridge that binds every session to a main chat. */
function fakeBridge(): HarnessConversationService {
  return {
    resolveChat: (() => ({ chatId: 'oc_x', chatType: 'p2p' })) as any,
  } as unknown as HarnessConversationService
}

async function tempFile(contents: Buffer, name = 'f'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-send-'))
  const p = join(dir, name)
  await writeFile(p, contents)
  return p
}

function execCtx(): any {
  return {
    agent: { id: 'session-1' },
    signal: { throwIfAborted: () => undefined },
  }
}

// PNG magic: 89 50 4E 47 0D 0A 1A 0A ...
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00])
// Plain text → not an image
const TXT_BYTES = Buffer.from('hello world')
// A real (synthetic) MP4 header + H.264 video track → inline-playable video.
const MP4_BYTES = mp4Bytes()
// ProRes keeps the plain-file path: the codec is not one Feishu clients play.
const PRORES_BYTES = mp4Bytes({ codec: 'apcn' })
// Ogg/Opus → voice bubble.
const OPUS_BYTES = oggBytes('OpusHead')
const COVER_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

/** Register the tool over the given channel and return its execute(). */
function toolOver(ch: LarkChannel, overrides: Partial<Parameters<typeof startFeishuSendFileTool>[0]> = {}) {
  const fake = fakeCtx()
  startFeishuSendFileTool({
    ctx: fake as unknown as Context,
    bridgeHolder: { current: fakeBridge() },
    channelHolder: { current: ch },
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  })
  return fake.registered.find(t => t.name === 'feishu_send_file')!
}

describe('startFeishuSendFileTool', () => {
  it('registers a tool named feishu_send_file', async () => {
    const fake = fakeCtx()
    startFeishuSendFileTool({
      ctx: fake as unknown as Context,
      bridgeHolder: { current: fakeBridge() },
      channelHolder: { current: fakeChannel() },
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    expect(fake.registered.some(t => t.name === 'feishu_send_file')).toBe(true)
  })

  it('sends real image bytes as an inline-preview image message', async () => {
    const p = await tempFile(PNG_BYTES, 'pic.png')
    const ch = fakeChannel()
    const tool = toolOver(ch)
    const result: any = await tool.execute({ path: p }, execCtx())
    expect(ch.send).toHaveBeenCalledWith(
      'oc_x',
      expect.objectContaining({ image: expect.objectContaining({ source: expect.any(Buffer) }) }),
      {},
    )
    expect((ch.send as any).mock.calls[0][1].file).toBeUndefined()
    expect(result.file_name).toBe('pic.png')
    expect(result.sent_as).toBe('image')
  })

  it('sends non-image bytes as a file message', async () => {
    const p = await tempFile(TXT_BYTES, 'note.txt')
    const ch = fakeChannel()
    const tool = toolOver(ch)
    const result: any = await tool.execute({ path: p }, execCtx())
    expect(ch.send).toHaveBeenCalledWith(
      'oc_x',
      expect.objectContaining({ file: expect.objectContaining({ source: expect.any(Buffer), fileName: 'note.txt' }) }),
      {},
    )
    expect((ch.send as any).mock.calls[0][1].image).toBeUndefined()
    expect(result.sent_as).toBe('file')
  })

  it('sends a playable MP4 as a native video message with an ffmpeg cover', async () => {
    const p = await tempFile(MP4_BYTES, 'clip.mp4')
    const ch = fakeChannel()
    const extractCoverFrame = vi.fn(async () => COVER_JPEG)
    const tool = toolOver(ch, { extractCoverFrame })
    const result: any = await tool.execute({ path: p }, execCtx())

    expect(extractCoverFrame).toHaveBeenCalledWith(p)
    expect((ch.rawClient as any).im.v1.image.create).toHaveBeenCalledWith({
      data: { image_type: 'message', image: COVER_JPEG },
    })
    expect(ch.send).toHaveBeenCalledWith(
      'oc_x',
      expect.objectContaining({
        video: { source: expect.any(Buffer), coverImageKey: 'img_cover' },
      }),
      {},
    )
    expect((ch.send as any).mock.calls[0][1].file).toBeUndefined()
    expect(result.sent_as).toBe('video')
  })

  it('sends the video without a cover when none can be extracted', async () => {
    const p = await tempFile(MP4_BYTES, 'clip.mp4')
    const ch = fakeChannel()
    const tool = toolOver(ch, { extractCoverFrame: async () => undefined })
    const result: any = await tool.execute({ path: p }, execCtx())

    const payload = (ch.send as any).mock.calls[0][1]
    expect(payload.video).toEqual({ source: expect.any(Buffer) })
    expect(payload.video.coverImageKey).toBeUndefined()
    expect((ch.rawClient as any).im.v1.image.create).not.toHaveBeenCalled()
    expect(result.sent_as).toBe('video')
  })

  it('still sends the video when the cover upload fails', async () => {
    const p = await tempFile(MP4_BYTES, 'clip.mp4')
    const ch = fakeChannel()
    ;(ch.rawClient as any).im.v1.image.create = vi.fn(async () => { throw new Error('boom') })
    const tool = toolOver(ch, { extractCoverFrame: async () => COVER_JPEG })
    const result: any = await tool.execute({ path: p }, execCtx())

    expect((ch.send as any).mock.calls[0][1].video.coverImageKey).toBeUndefined()
    expect(result.sent_as).toBe('video')
  })

  it('falls back to a file when the inline video send fails', async () => {
    const p = await tempFile(MP4_BYTES, 'clip.mp4')
    const ch = fakeChannel()
    ;(ch.send as any).mockRejectedValueOnce(new Error('duration could not be determined for video'))
    const tool = toolOver(ch, { extractCoverFrame: async () => undefined })
    const result: any = await tool.execute({ path: p }, execCtx())

    expect((ch.send as any).mock.calls).toHaveLength(2)
    expect((ch.send as any).mock.calls[1][1]).toEqual(
      expect.objectContaining({ file: expect.objectContaining({ fileName: 'clip.mp4' }) }),
    )
    expect(result.sent_as).toBe('file')
    expect(result.message_id).toBe('m')
  })

  it('keeps an unplayable video codec (ProRes) on the file path', async () => {
    const p = await tempFile(PRORES_BYTES, 'graded.mov')
    const ch = fakeChannel()
    const tool = toolOver(ch, { extractCoverFrame: async () => COVER_JPEG })
    const result: any = await tool.execute({ path: p }, execCtx())

    expect((ch.send as any).mock.calls[0][1]).toEqual(
      expect.objectContaining({ file: expect.objectContaining({ fileName: 'graded.mov' }) }),
    )
    expect(result.sent_as).toBe('file')
  })

  it('sends Ogg/Opus audio as a voice message', async () => {
    const p = await tempFile(OPUS_BYTES, 'voice.opus')
    const ch = fakeChannel()
    const tool = toolOver(ch)
    const result: any = await tool.execute({ path: p }, execCtx())

    expect(ch.send).toHaveBeenCalledWith(
      'oc_x',
      expect.objectContaining({ audio: expect.objectContaining({ source: expect.any(Buffer) }) }),
      {},
    )
    expect(result.sent_as).toBe('audio')
  })

  it('falls back to a file when the voice send fails', async () => {
    const p = await tempFile(OPUS_BYTES, 'voice.opus')
    const ch = fakeChannel()
    ;(ch.send as any).mockRejectedValueOnce(new Error('duration could not be determined for audio'))
    const tool = toolOver(ch)
    const result: any = await tool.execute({ path: p }, execCtx())

    expect((ch.send as any).mock.calls[1][1]).toEqual(
      expect.objectContaining({ file: expect.objectContaining({ fileName: 'voice.opus' }) }),
    )
    expect(result.sent_as).toBe('file')
  })
})
