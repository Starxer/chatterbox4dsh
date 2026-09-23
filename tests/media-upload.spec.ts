import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMediaUploader, type MediaUploaderDeps } from '../src/media-upload.ts'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'

const IMAGE_KEY = 'img_v3_0215q_0a59b5e6-4758-41de-95a5'
const FILE_KEY = 'file_v3_00or_f2c1276b-9f24-463d-8911'

let dir = ''
let warnings: string[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-media-upload-'))
  warnings = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Minimal channel exposing only the two upload endpoints the uploader uses. */
function fakeChannel(overrides: { image?: (...args: any[]) => any; file?: (...args: any[]) => any } = {}) {
  const image = vi.fn(overrides.image ?? (async () => ({ image_key: IMAGE_KEY })))
  const file = vi.fn(overrides.file ?? (async () => ({ file_key: FILE_KEY })))
  const channel = {
    rawClient: { im: { v1: { image: { create: image }, file: { create: file } } } },
  } as unknown as LarkChannel
  return { channel, image, file }
}

function uploader(channel: LarkChannel | undefined, seams: Partial<MediaUploaderDeps> = {}) {
  return createMediaUploader({
    channel: () => channel,
    logger: { warn: (message: string) => warnings.push(message) },
    probeDurationMs: async () => 4200,
    remuxToMp4: async (path: string) => `${path}.remuxed.mp4`,
    transcodeToOpus: async (path: string) => `${path}.transcoded.opus`,
    extractCoverFrame: async () => Buffer.from([1, 2, 3]),
    ...seams,
  })
}

async function file(name: string, contents = 'bytes'): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, contents)
  return path
}

describe('createMediaUploader.image', () => {
  it('uploads the bytes and returns the key', async () => {
    const { channel, image } = fakeChannel()
    const path = await file('a.png')
    await expect(uploader(channel).image(path)).resolves.toBe(IMAGE_KEY)
    expect(image).toHaveBeenCalledOnce()
    expect((image.mock.calls[0]![0] as any).data.image_type).toBe('message')
  })

  it('reports a missing key as a failure instead of sending an empty one', async () => {
    const { channel } = fakeChannel({ image: async () => ({ image_key: '' }) })
    const path = await file('a.png')
    await expect(uploader(channel).image(path)).resolves.toBeUndefined()
  })

  it('never throws when the channel is not connected', async () => {
    await expect(uploader(undefined).image(await file('a.png'))).resolves.toBeUndefined()
    expect(warnings.join('\n')).toContain('channel not connected')
  })
})

describe('createMediaUploader.video', () => {
  it('uploads an MP4 with its measured duration and no cover when extraction fails', async () => {
    const { channel, file: create } = fakeChannel()
    const path = await file('clip.mp4')
    await expect(uploader(channel, { extractCoverFrame: async () => undefined })
      .video(path, 'mp4')).resolves.toEqual({ fileKey: FILE_KEY, durationMs: 4200 })
    const payload = create.mock.calls[0]![0] as any
    expect(payload.data.file_type).toBe('mp4')
    expect(payload.data.duration).toBe(4200)
    expect(payload.data.file_name).toBe('clip.mp4')
  })

  it('remuxes QuickTime to MP4 before uploading (the card only plays MP4)', async () => {
    const { channel, file: create } = fakeChannel()
    const path = await file('screen.mov')
    const remux = vi.fn(async (source: string) => {
      const target = await file('screen.remuxed.mp4', 'remuxed bytes')
      void source
      return target
    })
    await expect(uploader(channel, { remuxToMp4: remux }).video(path, 'mov'))
      .resolves.toEqual({ fileKey: FILE_KEY, coverKey: IMAGE_KEY, durationMs: 4200 })
    expect(remux).toHaveBeenCalledWith(path)
    expect((create.mock.calls[0]![0] as any).data.file_name).toBe('screen.mp4')
  })

  it('leaves the reference as text when the remux cannot run (no ffmpeg)', async () => {
    const { channel, file: create } = fakeChannel()
    const path = await file('screen.mov')
    await expect(uploader(channel, { remuxToMp4: async () => undefined }).video(path, 'mov'))
      .resolves.toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    expect(warnings.join('\n')).toContain('could not be remuxed')
  })

  it('uploads the extracted cover as an image key', async () => {
    const { channel, image } = fakeChannel()
    const path = await file('clip.mp4')
    await expect(uploader(channel).video(path, 'mp4'))
      .resolves.toEqual({ fileKey: FILE_KEY, coverKey: IMAGE_KEY, durationMs: 4200 })
    expect(image).toHaveBeenCalledOnce()
  })

  it('returns undefined (never throws) when Feishu rejects the upload', async () => {
    const { channel } = fakeChannel({ file: async () => { throw new Error('file too large') } })
    const path = await file('clip.mp4')
    await expect(uploader(channel).video(path, 'mp4')).resolves.toBeUndefined()
    expect(warnings.join('\n')).toContain('file too large')
  })
})

describe('createMediaUploader.audio', () => {
  it('uploads Opus as-is', async () => {
    const { channel, file: create } = fakeChannel()
    const path = await file('voice.opus')
    const transcode = vi.fn(async () => 'should not run')
    await expect(uploader(channel, { transcodeToOpus: transcode }).audio(path, 'opus'))
      .resolves.toEqual({ fileKey: FILE_KEY, durationMs: 4200 })
    expect(transcode).not.toHaveBeenCalled()
    expect((create.mock.calls[0]![0] as any).data.file_type).toBe('opus')
  })

  it('transcodes wav/mp3/m4a/flac to Opus before uploading', async () => {
    const { channel, file: create } = fakeChannel()
    const path = await file('voice.wav')
    const transcode = vi.fn(async () => file('voice.transcoded.opus', 'opus bytes'))
    await expect(uploader(channel, { transcodeToOpus: transcode }).audio(path, 'wav'))
      .resolves.toEqual({ fileKey: FILE_KEY, durationMs: 4200 })
    expect(transcode).toHaveBeenCalledWith(path)
    expect((create.mock.calls[0]![0] as any).data.file_name).toBe('voice.opus')
  })

  it('leaves the reference as text when the transcode cannot run', async () => {
    const { channel, file: create } = fakeChannel()
    const path = await file('voice.wav')
    await expect(uploader(channel, { transcodeToOpus: async () => undefined }).audio(path, 'wav'))
      .resolves.toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    expect(warnings.join('\n')).toContain('could not be transcoded')
  })
})

describe('createMediaUploader temp files', () => {
  it('removes the remuxed copy after the upload', async () => {
    const { channel } = fakeChannel()
    let temp = ''
    const path = await file('screen.mov')
    await uploader(channel, {
      remuxToMp4: async () => {
        temp = await file('screen.remuxed.mp4', 'remuxed bytes')
        return temp
      },
    }).video(path, 'mov')
    await expect(readFile(temp)).rejects.toThrow()
  })
})
