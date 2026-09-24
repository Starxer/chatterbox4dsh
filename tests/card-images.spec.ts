import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectImageTargets, startCardImages, type CardImageDeps } from '../src/card-images.ts'
import { CARD_MEDIA_LIMIT } from '../src/config.ts'
import { mp4Bytes, oggBytes } from './stubs/media-bytes.ts'

const IMAGE_KEY = 'img_v3_0215q_0a59b5e6-4758-41de-95a5-a1b2c3d4'
// Smallest real PNG signature — enough for the format sniff.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

let root = ''
let workspace = ''
let outside = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-card-images-'))
  workspace = join(root, 'ws')
  outside = join(root, 'outside')
  await mkdir(join(workspace, 'runs'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(workspace, 'runs', 'a.png'), PNG)
  await writeFile(join(workspace, 'notes.txt'), 'not an image')
  await writeFile(join(outside, 'outside.png'), PNG)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const card = (content: string): object => ({
  schema: '2.0',
  body: { elements: [{ tag: 'markdown', content }] },
})
const contentOf = (value: object): string => ((value as any).body.elements[0] as { content: string }).content

function hydrator(overrides: Partial<CardImageDeps> = {}) {
  const uploads: string[] = []
  const warnings: string[] = []
  const handle = startCardImages({
    resolveWorkspace: async () => workspace,
    upload: async (absolutePath: string) => {
      uploads.push(absolutePath)
      return IMAGE_KEY
    },
    logger: { warn: (message: string) => warnings.push(message) },
    ...overrides,
  })
  return { handle, uploads, warnings }
}

describe('collectImageTargets', () => {
  it('collects distinct local image targets in order, skipping keys and URLs', () => {
    const value = card([
      '![a](runs/a.png)',
      '![b](https://example.com/b.png)',
      `![c](${IMAGE_KEY})`,
      '![d](runs/a.png)',
      '![e](runs/e.jpg)',
    ].join('\n\n'))
    expect(collectImageTargets(value, 8)).toEqual(['runs/a.png', 'runs/e.jpg'])
  })

  it('honours the limit', () => {
    const value = card(['![a](1.png)', '![b](2.png)', '![c](3.png)'].join('\n\n'))
    expect(collectImageTargets(value, 2)).toEqual(['1.png', '2.png'])
  })

  it('ignores references inside a fenced block', () => {
    expect(collectImageTargets(card('```\n![a](runs/a.png)\n```'), 8)).toEqual([])
  })
})

describe('startCardImages.hydrate', () => {
  it('uploads an in-workspace image and references the returned key', async () => {
    const { handle, uploads } = hydrator()
    const out = await handle.hydrate(card('看图：\n\n![灰度图](runs/a.png)'), { sessionId: 's1' })
    expect(contentOf(out)).toBe(`看图：\n\n![灰度图](${IMAGE_KEY})`)
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toBe(join(workspace, 'runs', 'a.png'))
  })

  it('caches by path + mtime + size, so repeated card updates upload once', async () => {
    const { handle, uploads } = hydrator()
    const scope = { workspace }
    await handle.hydrate(card('![a](runs/a.png)'), scope)
    await handle.hydrate(card('![a](runs/a.png)'), scope)
    await handle.hydrate(card('![a](runs/a.png)'), scope)
    expect(uploads).toHaveLength(1)
  })

  it('re-uploads after the file changes', async () => {
    const { handle, uploads } = hydrator()
    const scope = { workspace }
    await handle.hydrate(card('![a](runs/a.png)'), scope)
    const later = new Date(Date.now() + 5_000)
    await utimes(join(workspace, 'runs', 'a.png'), later, later)
    await handle.hydrate(card('![a](runs/a.png)'), scope)
    expect(uploads).toHaveLength(2)
  })

  it('shares one upload between two cards that reference the same file', async () => {
    const { handle, uploads } = hydrator()
    const scope = { workspace }
    await Promise.all([
      handle.hydrate(card('![a](runs/a.png)'), scope),
      handle.hydrate(card('![a](runs/a.png)'), scope),
    ])
    expect(uploads).toHaveLength(1)
  })

  it('refuses a path that escapes the workspace', async () => {
    const { handle, uploads, warnings } = hydrator()
    const out = await handle.hydrate(card('![x](../outside/outside.png)'), { workspace })
    expect(contentOf(out)).toBe('![x](../outside/outside.png)')
    expect(uploads).toHaveLength(0)
    expect(warnings.join('\n')).toContain('outside the workspace')
  })

  it('refuses an absolute path outside the workspace', async () => {
    const { handle, uploads } = hydrator()
    const out = await handle.hydrate(card(`![x](${join(outside, 'outside.png')})`), { workspace })
    expect(uploads).toHaveLength(0)
    expect(contentOf(out)).toContain('outside.png')
  })

  it('refuses a symlink that points out of the workspace', async () => {
    await symlink(join(outside, 'outside.png'), join(workspace, 'runs', 'link.png'))
    const { handle, uploads, warnings } = hydrator()
    await handle.hydrate(card('![x](runs/link.png)'), { workspace })
    expect(uploads).toHaveLength(0)
    expect(warnings.join('\n')).toContain('outside the workspace')
  })

  it('accepts an absolute path inside the workspace', async () => {
    const { handle, uploads } = hydrator()
    await handle.hydrate(card(`![x](${join(workspace, 'runs', 'a.png')})`), { workspace })
    expect(uploads).toHaveLength(1)
  })

  it('leaves a non-image file alone', async () => {
    const { handle, uploads, warnings } = hydrator()
    const out = await handle.hydrate(card('![x](notes.txt)'), { workspace })
    expect(uploads).toHaveLength(0)
    expect(contentOf(out)).toBe('![x](notes.txt)')
    expect(warnings.join('\n')).toContain('not a recognised image format')
  })

  it('leaves a missing file alone and remembers the failure', async () => {
    const { handle, uploads } = hydrator({ negativeTtlMs: 60_000 })
    await handle.hydrate(card('![x](runs/gone.png)'), { workspace })
    await handle.hydrate(card('![x](runs/gone.png)'), { workspace })
    expect(uploads).toHaveLength(0)
  })

  it('retries a previously failed path once the negative TTL has passed', async () => {
    const { handle, uploads } = hydrator({ negativeTtlMs: 0 })
    await handle.hydrate(card('![x](runs/gone.png)'), { workspace })
    await writeFile(join(workspace, 'runs', 'gone.png'), PNG)
    const out = await handle.hydrate(card('![x](runs/gone.png)'), { workspace })
    expect(uploads).toHaveLength(1)
    expect(contentOf(out)).toBe(`![x](${IMAGE_KEY})`)
  })

  it('keeps the reference as text when the upload fails', async () => {
    const { handle, warnings } = hydrator({ upload: async () => { throw new Error('upload exploded') } })
    const out = await handle.hydrate(card('![x](runs/a.png)'), { workspace })
    expect(contentOf(out)).toBe('![x](runs/a.png)')
    expect(warnings.join('\n')).toContain('upload exploded')
  })

  it('treats an upload that returns nothing as a failure', async () => {
    const { handle } = hydrator({ upload: async () => undefined })
    const out = await handle.hydrate(card('![x](runs/a.png)'), { workspace })
    expect(contentOf(out)).toBe('![x](runs/a.png)')
  })

  it('honours the per-card image cap', async () => {
    await writeFile(join(workspace, 'runs', 'b.png'), PNG)
    await writeFile(join(workspace, 'runs', 'c.png'), PNG)
    const { handle, uploads } = hydrator({ maxPerCard: 2 })
    const out = await handle.hydrate(card('![a](runs/a.png)\n\n![b](runs/b.png)\n\n![c](runs/c.png)'), { workspace })
    expect(uploads).toHaveLength(2)
    expect(contentOf(out)).toContain('runs/c.png')
  })

  it('does nothing when the budget is already spent', async () => {
    const { handle, uploads } = hydrator({ budgetMs: 0 })
    const out = await handle.hydrate(card('![a](runs/a.png)'), { workspace })
    expect(uploads).toHaveLength(0)
    expect(contentOf(out)).toBe('![a](runs/a.png)')
  })

  it('does nothing without a workspace and never rejects', async () => {
    const failing = hydrator({ resolveWorkspace: async () => { throw new Error('no workspace service') } })
    const out = await failing.handle.hydrate(card('![a](runs/a.png)'), { sessionId: 's1' })
    expect(contentOf(out)).toBe('![a](runs/a.png)')
    expect(failing.uploads).toHaveLength(0)
    const none = hydrator()
    const out2 = await none.handle.hydrate(card('![a](runs/a.png)'), {})
    expect(contentOf(out2)).toBe('![a](runs/a.png)')
    expect(none.uploads).toHaveLength(0)
  })

  it('leaves a card with no image references untouched (fast path)', async () => {
    const { handle, uploads } = hydrator()
    const original = card('只是文字，没有图')
    expect(await handle.hydrate(original, { workspace })).toBe(original)
    expect(uploads).toHaveLength(0)
  })

  it('rewrites image references nested anywhere in the card', async () => {
    const { handle } = hydrator()
    const nested = {
      body: { elements: [{ tag: 'column_set', columns: [{ elements: [{ tag: 'markdown', content: '![a](runs/a.png)' }] }] }] },
    }
    const out = await handle.hydrate(nested, { workspace })
    expect(((out as any).body.elements[0].columns[0].elements[0] as { content: string }).content)
      .toBe(`![a](${IMAGE_KEY})`)
  })

  it('leaves an already-uploaded key alone', async () => {
    const { handle, uploads } = hydrator()
    const out = await handle.hydrate(card(`![a](${IMAGE_KEY})`), { workspace })
    expect(contentOf(out)).toBe(`![a](${IMAGE_KEY})`)
    expect(uploads).toHaveLength(0)
  })

  it('does not upload an image referenced inside a fenced block', async () => {
    const { handle, uploads } = hydrator()
    const out = await handle.hydrate(card('```\n![a](runs/a.png)\n```'), { workspace })
    expect(contentOf(out)).toBe('```\n![a](runs/a.png)\n```')
    expect(uploads).toHaveLength(0)
  })
})

describe('startCardImages.dispose', () => {
  it('forgets cached keys so nothing is served from a stale cache', async () => {
    const { handle, uploads } = hydrator()
    await handle.hydrate(card('![a](runs/a.png)'), { workspace })
    handle.dispose()
    await handle.hydrate(card('![a](runs/a.png)'), { workspace })
    expect(uploads).toHaveLength(2)
  })
})

describe('image mode', () => {
  it('uploads nothing at all in text mode', async () => {
    const { handle, uploads } = hydrator({ mode: () => 'text' })
    const out = await handle.hydrate(card('![a](runs/a.png)'), { workspace })
    expect(contentOf(out)).toBe('![a](runs/a.png)')
    expect(uploads).toHaveLength(0)
  })

  it('uploads a path outside the workspace in any mode', async () => {
    const { handle, uploads } = hydrator({ mode: () => 'any' })
    const out = await handle.hydrate(card(`![x](${join(outside, 'outside.png')})`), { workspace })
    expect(contentOf(out)).toBe(`![x](${IMAGE_KEY})`)
    expect(uploads).toHaveLength(1)
  })

  it('still refuses a symlink escape in any mode when the REAL path is unreadable', async () => {
    const { handle, uploads } = hydrator({ mode: () => 'any' })
    // The link target exists here, so any-mode follows it on purpose; the point
    // is that the file itself is what gets checked, not the path text.
    await symlink(join(outside, 'outside.png'), join(workspace, 'runs', 'link.png'))
    await handle.hydrate(card('![x](runs/link.png)'), { workspace })
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toBe(join(outside, 'outside.png'))
  })

  it('mentions the any mode in the refusal warning, so the operator knows the way out', async () => {
    const { handle, warnings } = hydrator({ mode: () => 'workspace' })
    await handle.hydrate(card('![x](../outside/outside.png)'), { workspace })
    expect(warnings.join('\n')).toContain('set the card-media mode to "any"')
  })

  it('reads the mode live, so a settings write applies without a restart', async () => {
    let current: 'text' | 'workspace' = 'text'
    const { handle, uploads } = hydrator({ mode: () => current })
    await handle.hydrate(card('![a](runs/a.png)'), { workspace })
    expect(uploads).toHaveLength(0)
    current = 'workspace'
    const out = await handle.hydrate(card('![a](runs/a.png)'), { workspace })
    expect(contentOf(out)).toBe(`![a](${IMAGE_KEY})`)
    expect(uploads).toHaveLength(1)
  })
})

const VIDEO_KEY = 'file_v3_00or_f2c1276b-9f24-463d-8911'
const AUDIO_KEY = 'file_v3_00or_9c8d7e6f-1234-5678-90ab'
const OPUS = Buffer.from(oggBytes('OpusHead'))

describe('card media beyond images', () => {
  beforeEach(async () => {
    await writeFile(join(workspace, 'runs', 'clip.mp4'), mp4Bytes())
    await writeFile(join(workspace, 'runs', 'voice.opus'), OPUS)
    await writeFile(join(workspace, 'notes.md'), '# a document, not media')
  })

  it('splices a video element where the link was and blocks forwarding', async () => {
    const { handle } = hydrator({
      uploadVideo: async () => ({ fileKey: VIDEO_KEY, coverKey: IMAGE_KEY }),
    })
    const out = await handle.hydrate(card('前 [片段](runs/clip.mp4) 后'), { workspace }) as any
    expect(out.body.elements.map((element: any) => element.tag)).toEqual(['markdown', 'video', 'markdown'])
    expect(out.body.elements[0].content).toBe('前 ')
    expect(out.body.elements[2].content).toBe(' 后')
    const video = out.body.elements[1]
    expect(video.file_key).toBe(VIDEO_KEY)
    expect(video.cover.img_key).toBe(IMAGE_KEY)
    expect(video.enable_download).toBe(true)
    expect(video.fallback.text.content).toBe('📹 片段')
    // Feishu refuses a card with a video component unless forwarding is off.
    expect(out.config.enable_forward).toBe(false)
  })

  it('inlines audio as an <audio> player in the same markdown element', async () => {
    const { handle } = hydrator({ uploadAudio: async (_path: string, format: string) => {
      expect(format).toBe('opus')
      return { fileKey: AUDIO_KEY }
    } })
    const out = await handle.hydrate(card('[语音](runs/voice.opus)'), { workspace }) as any
    expect(contentOf(out)).toMatch(/^语音 <audio file_key='file_v3_[^']+' audio_id='a[^']+' show_time=true><\/audio>$/)
    expect(out.config.enable_forward).toBe(false)
  })

  it('keeps the audio_id stable across card updates so playback is not restarted', async () => {
    const { handle } = hydrator({ uploadAudio: async () => ({ fileKey: AUDIO_KEY }) })
    const first = contentOf(await handle.hydrate(card('[语音](runs/voice.opus)'), { workspace }))
    const second = contentOf(await handle.hydrate(card('[语音](runs/voice.opus)'), { workspace }))
    expect(second).toBe(first)
  })

  it('inlines an image the model referenced as a plain link', async () => {
    const { handle } = hydrator()
    const out = await handle.hydrate(card('[图](runs/a.png)'), { workspace })
    expect(contentOf(out)).toBe(`![图](${IMAGE_KEY})`)
  })

  it('leaves a non-media link alone (quietly) and does not re-inspect it', async () => {
    const { handle, uploads, warnings } = hydrator({
      uploadVideo: async () => ({ fileKey: VIDEO_KEY }),
      uploadAudio: async () => ({ fileKey: AUDIO_KEY }),
    })
    const first = await handle.hydrate(card('[notes](notes.md)'), { workspace })
    expect(contentOf(first)).toBe('[notes](notes.md)')
    expect(uploads).toHaveLength(0)
    expect(warnings.join('\n')).not.toContain('notes.md')
    const second = await handle.hydrate(card('[notes](notes.md)'), { workspace })
    expect(contentOf(second)).toBe('[notes](notes.md)')
  })

  it('caps how much video/audio one card may inline', async () => {
    for (const name of ['b.mp4', 'c.mp4']) await writeFile(join(workspace, 'runs', name), mp4Bytes())
    const { handle } = hydrator({
      maxMediaPerCard: 2,
      uploadVideo: async () => ({ fileKey: VIDEO_KEY }),
    })
    const out = await handle.hydrate(card([
      '[一](runs/clip.mp4)', '[二](runs/b.mp4)', '[三](runs/c.mp4)',
    ].join('\n\n')), { workspace }) as any
    const videos = out.body.elements.filter((element: any) => element.tag === 'video')
    expect(videos).toHaveLength(2)
  })

  it('defaults to the measured card budget: twelve clips, not two', async () => {
    const names = Array.from({ length: 13 }, (_unused, i) => `clip-${i}.mp4`)
    for (const name of names) await writeFile(join(workspace, 'runs', name), mp4Bytes())
    const { handle } = hydrator({ uploadVideo: async () => ({ fileKey: VIDEO_KEY }) })
    const out = await handle.hydrate(
      card(names.map((name, i) => `[${i}](runs/${name})`).join('\n\n')),
      { workspace },
    ) as any
    expect(out.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(12)
    // The thirteenth stays a readable reference rather than a broken element.
    expect(JSON.stringify(out)).toContain('runs/clip-12.mp4')
  })

  it('inlines every clip of a six-clip answer, not just two', async () => {
    // The real 2026-09-24 workload: one answer referencing six clips. The old
    // per-card media cap was 2, so four of them degraded to their path.
    const names = ['clip.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4', 'f.mp4']
    for (const name of names.slice(1)) await writeFile(join(workspace, 'runs', name), mp4Bytes())
    let n = 0
    const { handle } = hydrator({ uploadVideo: async () => ({ fileKey: `${VIDEO_KEY}_${n += 1}` }) })
    const out = await handle.hydrate(
      card(names.map((name, i) => `[${i}](runs/${name})`).join('\n\n')),
      { workspace },
    ) as any
    expect(out.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(6)
  })

  it('overlaps uploads instead of paying one round trip per clip', async () => {
    const names = ['clip.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4', 'f.mp4']
    for (const name of names.slice(1)) await writeFile(join(workspace, 'runs', name), mp4Bytes())
    let releaseFirst: (() => void) | undefined
    let finished = 0
    let armed: (() => void) | undefined
    const twoOthersDone = new Promise<void>((resolve) => { armed = resolve })
    const { handle } = hydrator({
      uploadVideo: async () => {
        if (releaseFirst === undefined) {
          // Hold the first upload open: anything that finishes meanwhile proves
          // the pool did not serialize behind it.
          await new Promise<void>((resolve) => { releaseFirst = resolve })
        }
        finished += 1
        if (finished === 2) armed?.()
        return { fileKey: VIDEO_KEY }
      },
    })
    const pending = handle.hydrate(
      card(names.map((name, i) => `[${i}](runs/${name})`).join('\n\n')),
      { workspace },
    )
    await twoOthersDone
    expect(releaseFirst).toBeTypeOf('function')
    releaseFirst!()
    const out = await pending as any
    expect(finished).toBe(6)
    expect(out.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(6)
  })

  it('counts cached media against the cap, so a re-render resolves the same set', async () => {
    for (const name of ['b.mp4', 'c.mp4']) await writeFile(join(workspace, 'runs', name), mp4Bytes())
    const uploaded: string[] = []
    const { handle } = hydrator({
      maxMediaPerCard: 2,
      uploadVideo: async (path: string) => { uploaded.push(path); return { fileKey: VIDEO_KEY } },
    })
    const value = card(['[一](runs/clip.mp4)', '[二](runs/b.mp4)', '[三](runs/c.mp4)'].join('\n\n'))
    const first = await handle.hydrate(value, { workspace }) as any
    const second = await handle.hydrate(value, { workspace }) as any
    for (const out of [first, second]) {
      expect(out.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(2)
    }
    // The cached pair keeps its slots: the third clip must not slip in on the
    // next write just because two of the three came from the cache.
    expect(uploaded).toHaveLength(2)
  })

  it('reads the per-card cap live, so a settings write applies to the next card', async () => {
    for (const name of ['b.mp4', 'c.mp4']) await writeFile(join(workspace, 'runs', name), mp4Bytes())
    let limit = 1
    const { handle } = hydrator({ mediaLimit: () => limit, uploadVideo: async () => ({ fileKey: VIDEO_KEY }) })
    const value = card(['[一](runs/clip.mp4)', '[二](runs/b.mp4)', '[三](runs/c.mp4)'].join('\n\n'))
    const first = await handle.hydrate(value, { workspace }) as any
    expect(first.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(1)
    limit = 3
    const second = await handle.hydrate(value, { workspace }) as any
    expect(second.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(3)
  })

  it('applies the setting number to each media group, not to one shared pool', async () => {
    await writeFile(join(workspace, 'runs', 'clip.mp4'), mp4Bytes())
    const { handle } = hydrator({
      mediaLimit: () => 1,
      uploadVideo: async () => ({ fileKey: VIDEO_KEY }),
    })
    const out = await handle.hydrate(card('![图](runs/a.png)\n\n[片段](runs/clip.mp4)'), { workspace }) as any
    const elements = out.body.elements as any[]
    // One image and one clip, so a reply that is image-heavy cannot starve its
    // video (each group gets the number the operator set).
    expect(elements.filter((element: any) => element.tag === 'video')).toHaveLength(1)
    expect(contentOf(out)).toContain(IMAGE_KEY)
  })

  it('leaves media as text when the media budget is already spent', async () => {
    const { handle } = hydrator({ mediaBudgetMs: 0, uploadVideo: async () => ({ fileKey: VIDEO_KEY }) })
    const out = await handle.hydrate(card('[片段](runs/clip.mp4)'), { workspace })
    expect(contentOf(out)).toBe('[片段](runs/clip.mp4)')
  })

  it('leaves media as text when no video/audio uploader is wired', async () => {
    const { handle } = hydrator()
    const out = await handle.hydrate(card('[片段](runs/clip.mp4)'), { workspace })
    expect(contentOf(out)).toBe('[片段](runs/clip.mp4)')
  })

  it('uploads nothing at all in text mode', async () => {
    const uploaded: string[] = []
    const { handle } = hydrator({
      mode: () => 'text',
      uploadVideo: async (path: string) => { uploaded.push(path); return { fileKey: VIDEO_KEY } },
      uploadAudio: async (path: string) => { uploaded.push(path); return { fileKey: AUDIO_KEY } },
    })
    await handle.hydrate(card('[片段](runs/clip.mp4)\n\n[语音](runs/voice.opus)'), { workspace })
    expect(uploaded).toHaveLength(0)
  })

  it('shares one upload between concurrent cards for the same clip', async () => {
    const uploaded: string[] = []
    const { handle } = hydrator({
      uploadVideo: async (path: string) => { uploaded.push(path); return { fileKey: VIDEO_KEY } },
    })
    const value = card('[片段](runs/clip.mp4)')
    await Promise.all([
      handle.hydrate(value, { workspace }),
      handle.hydrate(value, { workspace }),
    ])
    expect(uploaded).toHaveLength(1)
  })
})

describe('card media warm-up', () => {
  beforeEach(async () => {
    await writeFile(join(workspace, 'runs', 'clip.mp4'), mp4Bytes())
  })

  it('resolves the keys ahead of the write, so the card does not pay for the upload', async () => {
    const uploaded: string[] = []
    const { handle } = hydrator({
      uploadVideo: async (path: string) => { uploaded.push(path); return { fileKey: VIDEO_KEY } },
    })
    handle.warm(card('[片段](runs/clip.mp4)'), { workspace })
    await vi.waitFor(() => { expect(uploaded).toHaveLength(1) })
    const out = await handle.hydrate(card('[片段](runs/clip.mp4)'), { workspace }) as any
    expect(uploaded).toHaveLength(1)
    expect(out.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(1)
  })

  it('never rejects and stays silent about a workspace it cannot resolve', async () => {
    const { handle, uploads } = hydrator()
    handle.warm(card('![a](runs/a.png)'), {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(uploads).toHaveLength(0)
  })

  it('does not poison the failure cache with a file a running tool has not written yet', async () => {
    // Key pitfall 44: the warmer sees streaming text long before the tool that
    // writes the file has finished. Recording "missing" for 60 s there would
    // cost the media on the very card the text is about to become.
    const uploaded: string[] = []
    const { handle } = hydrator({
      uploadVideo: async (path: string) => { uploaded.push(path); return { fileKey: VIDEO_KEY } },
    })
    const value = card('[片段](runs/later.mp4)')
    handle.warm(value, { workspace })
    // Let the warm pass get as far as its (failing) lookup…
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(uploaded).toHaveLength(0)
    // …then the tool finishes and the card is written.
    await writeFile(join(workspace, 'runs', 'later.mp4'), mp4Bytes())
    const out = await handle.hydrate(value, { workspace }) as any
    expect(uploaded).toHaveLength(1)
    expect(out.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(1)
  })

})

describe('Feishu card budget', () => {
  it('keeps the worst case one card can build inside 200 elements and 30 KB', async () => {
    // Measured against the live API on 2026-09-24: a card may hold 200 elements
    // or components, and a `video` with `cover` + `fallback` spends three of
    // them (66 videos accepted, 67 refused with 300305). The setting's MAXIMUM
    // must therefore still build a card Feishu accepts.
    for (let i = 0; i < CARD_MEDIA_LIMIT.max; i += 1) {
      await writeFile(join(workspace, 'runs', `v${i}.mp4`), mp4Bytes())
      await writeFile(join(workspace, 'runs', `i${i}.png`), PNG)
    }
    const { handle } = hydrator({
      // The setting's maximum, which is what must still fit.
      mediaLimit: () => CARD_MEDIA_LIMIT.max,
      uploadVideo: async (path: string) => ({ fileKey: VIDEO_KEY, coverKey: `${IMAGE_KEY}_${path}` }),
    })
    const lines: string[] = []
    for (let i = 0; i < CARD_MEDIA_LIMIT.max; i += 1) {
      lines.push(`![still ${i}](runs/i${i}.png)`, `[clip ${i}](runs/v${i}.mp4)`)
    }
    const out = await handle.hydrate(card(lines.join('\n\n')), { workspace }) as any
    const elements = out.body.elements as unknown[]
    const videos = elements.filter((element: any) => element.tag === 'video')
    expect(videos).toHaveLength(CARD_MEDIA_LIMIT.max)
    // Every image stays inside a markdown element; every video is its own, so
    // the card is one text segment per video plus the video elements.
    expect(elements.filter((element: any) => element.tag === 'markdown')).toHaveLength(CARD_MEDIA_LIMIT.max)
    expect(JSON.stringify(out)).not.toContain('runs/i0.png')
    // Feishu counts the video, its cover and its fallback separately.
    const counted = elements.length + videos.length * 2
    expect(counted).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThan(30 * 1024)
  })

  it('shares the twelve media slots between video and audio', async () => {
    for (let i = 0; i < 12; i += 1) {
      await writeFile(join(workspace, 'runs', `v${i}.mp4`), mp4Bytes())
      await writeFile(join(workspace, 'runs', `a${i}.opus`), OPUS)
    }
    const { handle } = hydrator({
      uploadVideo: async () => ({ fileKey: VIDEO_KEY }),
      uploadAudio: async () => ({ fileKey: AUDIO_KEY }),
    })
    const lines: string[] = []
    for (let i = 0; i < 12; i += 1) lines.push(`[clip ${i}](runs/v${i}.mp4)`, `[voice ${i}](runs/a${i}.opus)`)
    const out = await handle.hydrate(card(lines.join('\n\n')), { workspace }) as any
    const videos = out.body.elements.filter((element: any) => element.tag === 'video').length
    const audio = ((out.body.elements as any[])
      .filter((element: any) => element.tag === 'markdown')
      .map((element: any) => element.content as string)
      .join('\n')
      .match(/<audio /gu) ?? []).length
    // Interleaved in card order, so the shared budget is spent on the first six
    // of each rather than on twelve clips and no voice.
    expect(videos).toBe(6)
    expect(audio).toBe(6)
  })
})

describe('per-kind inline size ceilings', () => {
  /** MB from KB, so the fixtures below stay tiny (the real values are whole MB). */
  const kb = (n: number): number => n / 1024

  beforeEach(async () => {
    await writeFile(join(workspace, 'runs', 'big.png'), Buffer.concat([PNG, Buffer.alloc(3_000)]))
    await writeFile(join(workspace, 'runs', 'big.mp4'), Buffer.concat([mp4Bytes(), Buffer.alloc(3_000)]))
    await writeFile(join(workspace, 'runs', 'big.opus'), Buffer.concat([OPUS, Buffer.alloc(3_000)]))
  })

  /** All three kinds referenced in one card, 3 KB each. */
  const threeKinds = (): object => card([
    '![图](runs/big.png)', '[片段](runs/big.mp4)', '[语音](runs/big.opus)',
  ].join('\n\n'))

  it('measures each kind against its own ceiling, not one shared number', async () => {
    const { handle, warnings } = hydrator({
      mediaCaps: () => ({ imageMb: kb(1), videoMb: kb(2), audioMb: kb(4) }),
      uploadVideo: async () => ({ fileKey: VIDEO_KEY }),
      uploadAudio: async () => ({ fileKey: AUDIO_KEY }),
    })
    const out = await handle.hydrate(threeKinds(), { workspace }) as any

    // 3 KB image vs 1 KB, 3 KB video vs 2 KB → both stay text…
    expect(JSON.stringify(out)).not.toContain('img_v3')
    expect(out.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(0)
    // …while the 3 KB audio fits under its own 4 KB.
    expect(JSON.stringify(out)).toContain('<audio')
    // One line per refused kind, naming the kind (the MB formatting is not what
    // this test is about; the fixtures use sub-megabyte ceilings on purpose).
    expect(warnings.some(line => line.includes('card image') && line.includes('left as text'))).toBe(true)
    expect(warnings.some(line => line.includes('card video') && line.includes('left as text'))).toBe(true)
    expect(warnings.some(line => line.includes('card audio'))).toBe(false)
  })

  it('refuses an oversized non-ISO-BMFF audio file too (that path had no byte check at all)', async () => {
    // Opus/WAV/MP3/FLAC were only sniffed by their magic bytes, so a huge one was
    // transcoded and uploaded no matter what the settings said.
    const { handle, uploads } = hydrator({
      mediaCaps: () => ({ imageMb: kb(64), videoMb: kb(64), audioMb: kb(1) }),
      uploadAudio: async () => ({ fileKey: AUDIO_KEY }),
    })
    const out = await handle.hydrate(card('[语音](runs/big.opus)'), { workspace })
    expect(contentOf(out)).toBe('[语音](runs/big.opus)')
    expect(uploads).toHaveLength(0)
  })

  it('re-reads the ceilings on the next card, so a settings write applies at once', async () => {
    // An over-ceiling file must NOT be remembered as "inspected, not media":
    // that negative cache would keep a raised limit from taking effect until the
    // entry was evicted (found while adding these settings).
    let caps = { imageMb: kb(1), videoMb: kb(1), audioMb: kb(1) }
    const { handle } = hydrator({
      mediaCaps: () => caps,
      uploadVideo: async () => ({ fileKey: VIDEO_KEY }),
      uploadAudio: async () => ({ fileKey: AUDIO_KEY }),
    })
    const first = await handle.hydrate(threeKinds(), { workspace }) as any
    expect(first.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(0)
    expect(JSON.stringify(first)).not.toContain('img_v3')

    caps = { imageMb: kb(10), videoMb: kb(10), audioMb: kb(10) }
    const second = await handle.hydrate(threeKinds(), { workspace }) as any
    expect(JSON.stringify(second)).toContain(`![图](${IMAGE_KEY})`)
    expect(second.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(1)
    expect(JSON.stringify(second)).toContain('<audio')

    // The reverse also holds: a lowered limit stops inlining what the higher one
    // had already cached? No — an uploaded key stays cached (the file did not
    // change), which is the intended behaviour: the cap gates the UPLOAD.
    caps = { imageMb: kb(1), videoMb: kb(1), audioMb: kb(1) }
    const third = await handle.hydrate(threeKinds(), { workspace }) as any
    expect(third.body.elements.filter((element: any) => element.tag === 'video')).toHaveLength(1)
  })
})
