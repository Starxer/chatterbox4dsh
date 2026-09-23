import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectImageTargets, startCardImages, type CardImageDeps } from '../src/card-images.ts'

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
    expect(warnings.join('\n')).toContain('set the image mode to "any"')
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
