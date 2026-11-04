import { describe, expect, it } from 'vitest'
import { renderFooterCard } from '../src/channel.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('en')

function markdownOf(card: any): string {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    .join('\n')
}

const turnStats = {
  turnStartTime: 0,
  stepCount: 3,
  toolCallCount: 2,
  totalInputTokens: 10,
  totalOutputTokens: 20,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalBilledTokens: 30,
  firstStepTtftMs: 100,
  totalDecodeMs: 500,
  totalDecodeTokens: 20,
  totalStepMs: 600,
  totalToolMs: 300,
  totalTurnMs: 900,
}

describe('renderFooterCard (Turn Complete)', () => {
  it('shows the busy mode (queue) in the footer', () => {
    const card = renderFooterCard(t, { busyMode: 'queue' }, turnStats) as any
    expect(card.header.title.content).toBe('✅ Turn complete')
    expect(markdownOf(card)).toContain('**Send behavior while busy:** 📥 Queue')
  })

  it('shows the busy mode (steer) in the footer', () => {
    const card = renderFooterCard(t, { busyMode: 'steer' }, turnStats) as any
    expect(markdownOf(card)).toContain('**Send behavior while busy:** 🎯 Steer')
  })

  it('omits the busy line when busyMode is not provided', () => {
    const card = renderFooterCard(t, { model: 'm' }, turnStats) as any
    expect(markdownOf(card)).not.toContain('Send behavior while busy')
  })

  it('returns undefined when there is nothing to render', () => {
    expect(renderFooterCard(t, undefined, undefined)).toBeUndefined()
    expect(renderFooterCard(t, {}, undefined)).toBeUndefined()
  })

  it('computes tok/s from the paired decode tokens, not all output tokens', () => {
    const card = renderFooterCard(t, {}, turnStats) as any
    // 20 decode tokens / 0.5s — even though 20 output tokens were reported,
    // the numerator is the paired set, matching the Web UI.
    expect(markdownOf(card)).toContain('🚀 40 tok/s')

    // A step whose tokens could not be paired with decode time must not
    // contribute to throughput at all.
    const unpaired = renderFooterCard(t, {}, {
      ...turnStats,
      totalOutputTokens: 900,
      totalDecodeTokens: 0,
    }) as any
    expect(markdownOf(unpaired)).not.toContain('tok/s')
  })

  it('reports billed total and cache-inclusive input like the Web UI', () => {
    const cached = renderFooterCard(t, {}, {
      ...turnStats,
      totalInputTokens: 15,
      totalCacheReadTokens: 30,
      totalCacheWriteTokens: 5,
      totalBilledTokens: 100,
    }) as any
    const md = markdownOf(cached)
    // Headline total = billed (input + cache + output), matching "consumed".
    expect(md).toContain('📦 100 tokens')
    // in = billed prompt (uncached + cache read + cache write), NOT just uncached.
    expect(md).toContain('📥 50 in · 📤 20 out')
    expect(md).toContain('💾 cache 60%')
  })
})

describe('renderFooterCard deliverables', () => {
  it('lists the paths and descriptions DSH declared through present', () => {
    const card = renderFooterCard(t, {}, {
      ...turnStats,
      deliverables: [
        { path: 'reports/summary.md', description: 'Monthly rollup' },
        { path: 'assets/chart.png' },
      ],
    }) as any
    const md = markdownOf(card)
    expect(md).toContain(t.deliverablesTitle(2))
    // Deliverables are LINKS, not code spans: the card writer resolves those
    // against the session workspace, so a delivered clip or still renders
    // inline here exactly like one referenced in the answer text.
    expect(md).toContain('• [Monthly rollup](reports/summary.md)')
    expect(md).toContain('• [assets/chart.png](assets/chart.png)')
  })

  it('omits the section when nothing was declared', () => {
    expect(markdownOf(renderFooterCard(t, {}, turnStats) as any)).not.toContain('Present files')
    expect(markdownOf(renderFooterCard(t, {}, { ...turnStats, deliverables: [] }) as any)).not.toContain('Present files')
  })

  it('reports the produced-artifact count in one line when the setting asks for it', () => {
    // TODO O3: a turn that wrote an image or a document without calling
    // `present` used to leave the chat silent about it.
    const card = renderFooterCard(t, {}, turnStats, undefined, undefined, 2) as any
    expect(markdownOf(card)).toContain(t.turnProducedLine(2))
    // Count only — never the paths: the artifact files themselves reach the
    // card through the delivery rows, and a chat is not a workspace browser.
    expect(markdownOf(card)).not.toContain('/tmp/')
  })

  it('omits the produced line when the setting is off or nothing was produced', () => {
    // `off` passes undefined; a turn that produced nothing passes 0.
    expect(markdownOf(renderFooterCard(t, {}, turnStats, undefined, undefined, undefined) as any))
      .not.toContain(t.turnProducedLine(1))
    expect(markdownOf(renderFooterCard(t, {}, turnStats, undefined, undefined, 0) as any))
      .not.toContain(t.turnProducedLine(1))
  })

  it('renders the planned rows when the deliver controller supplied them', () => {
    const card = renderFooterCard(t, {}, {
      ...turnStats,
      deliverables: [
        { path: 'out/still.png', description: 'Final still' },
        { path: 'out/notes.md' },
      ],
    }, [
      { path: 'out/still.png', name: 'still.png', kind: 'image', description: 'Final still' },
      { path: 'out/notes.md', name: 'notes.md', kind: 'other', size: 2048, token: 'tok-1' },
    ]) as any
    const elements = card.body.elements
    const contents = elements.filter((element: any) => element.tag === 'markdown').map((element: any) => element.content)
    // Media keeps the file name as plain text AND a link for the hydrator: the
    // inlined picture's alt text is only a hover tooltip.
    expect(contents[0]).toContain(t.deliverablesTitle(2))
    expect(contents.some((content: string) => content.includes('still.png'))).toBe(true)
    expect(contents.some((content: string) => content.includes('](out/still.png)'))).toBe(true)
    // The file the operator can ask for is a clickable row, and the row — not
    // the header — is what the divider follows.
    const row = elements.find((element: any) => element.tag === 'interactive_container') as any
    expect(row.behaviors).toEqual([{ type: 'callback', value: { p: 'deliver-open', token: 'tok-1' } }])
    expect(elements.find((element: any) => element.tag === 'hr')).toBeDefined()
  })

  it('leads the card, with a divider before the metrics', () => {
    const card = renderFooterCard(t, {}, {
      ...turnStats,
      deliverables: [{ path: 'reports/summary.md', description: 'Monthly rollup' }],
    }) as any
    const elements = card.body.elements
    // First element is the deliverable list, second is the divider that
    // separates it from the turn stats.
    expect(elements[0].tag).toBe('markdown')
    expect(elements[0].content).toContain(t.deliverablesTitle(1))
    expect(elements[1].tag).toBe('hr')
    // The stats lines follow the divider, not the other way round.
    const firstStat = elements.findIndex((el: any) => el.tag === 'markdown' && el.text_size === 'notation')
    expect(firstStat).toBeGreaterThan(1)
  })

  it('caps the list and reports the remainder', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ path: `out/file-${index}.txt` }))
    const md = markdownOf(renderFooterCard(t, {}, { ...turnStats, deliverables: many }) as any)
    // Headline keeps the real total; the body shows the cap.
    expect(md).toContain(t.deliverablesTitle(9))
    expect(md).toContain('• [out/file-5.txt](out/file-5.txt)')
    expect(md).not.toContain('file-6.txt')
    expect(md).toContain('…and 3 more')
  })

  it('keeps a backtick inside a path from breaking the surrounding markdown', () => {
    const md = markdownOf(renderFooterCard(t, {}, {
      ...turnStats,
      deliverables: [{ path: 'we`ird/name.txt' }],
    }) as any)
    // The label is cleaned (a stray backtick would open a code span), and the
    // target stays verbatim so the file still resolves.
    expect(md).toContain("• [we'ird/name.txt](we`ird/name.txt)")
  })

  it('escapes a description that would otherwise close the link early', () => {
    const md = markdownOf(renderFooterCard(t, {}, {
      ...turnStats,
      deliverables: [{ path: 'out/a.mp4', description: 'v6a [保短裙] 第 1 张' }],
    }) as any)
    expect(md).toContain('• [v6a 保短裙 第 1 张](out/a.mp4)')
  })

  it('wraps a path with spaces so the reference scanner still sees a target', () => {
    const md = markdownOf(renderFooterCard(t, {}, {
      ...turnStats,
      deliverables: [{ path: 'out/my clip.mp4' }],
    }) as any)
    expect(md).toContain('• [out/my clip.mp4](<out/my clip.mp4>)')
  })
})

describe('Turn Complete media (deliverables go through the hydrator)', () => {
  it('renders a delivered clip inline instead of leaving its path as text', async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { startCardImages } = await import('../src/card-images.ts')
    const { mp4Bytes } = await import('./stubs/media-bytes.ts')

    const root = await mkdtemp(join(tmpdir(), 'dsh-footer-media-'))
    try {
      await mkdir(join(root, 'out'), { recursive: true })
      await writeFile(join(root, 'out', 'clip.mp4'), mp4Bytes())
      const handle = startCardImages({
        resolveWorkspace: async () => root,
        upload: async () => 'img_v3_probe',
        uploadVideo: async () => ({ fileKey: 'file_v3_00or_probe' }),
        logger: { warn: () => undefined },
      })
      // Exactly the shape the walking skeleton in channel.ts writes: the card is
      // rendered first, then handed to the hydrator the same way `sendCard` does.
      const card = renderFooterCard(t, { workspace: root }, {
        ...turnStats,
        deliverables: [{ path: 'out/clip.mp4', description: 'Draft clip' }],
      }) as any
      const out = await handle.hydrate(card, { workspace: root }) as any
      const videos = out.body.elements.filter((element: any) => element.tag === 'video')
      expect(videos).toHaveLength(1)
      expect(videos[0].file_key).toBe('file_v3_00or_probe')
      expect(videos[0].fallback.text.content).toBe('📹 Draft clip')
      expect(JSON.stringify(out)).not.toContain('](out/clip.mp4)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('inlines a planned media row and keeps its file name visible', async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { startCardImages } = await import('../src/card-images.ts')

    const root = await mkdtemp(join(tmpdir(), 'dsh-footer-plan-'))
    try {
      await mkdir(join(root, 'out'), { recursive: true })
      await writeFile(join(root, 'out', 'still.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      const handle = startCardImages({
        resolveWorkspace: async () => root,
        upload: async () => 'img_v3_plan_probe',
        logger: { warn: () => undefined },
      })
      const card = renderFooterCard(t, { workspace: root }, {
        ...turnStats,
        deliverables: [{ path: 'out/still.png', description: 'Final still' }],
      }, [
        { path: 'out/still.png', name: 'still.png', kind: 'image', description: 'Final still' },
      ]) as any
      const out = await handle.hydrate(card, { workspace: root }) as any
      const json = JSON.stringify(out)
      // The picture is a real card image, and the file NAME survives as text
      // (an inlined image's alt text is only a hover tooltip).
      expect(json).toContain('img_v3_plan_probe')
      expect(json).not.toContain('](out/still.png)')
      const contents = out.body.elements
        .filter((element: any) => element.tag === 'markdown')
        .map((element: any) => element.content)
        .join('\n')
      expect(contents).toContain('still.png')
      expect(contents).toContain('Final still')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('degrades a non-media deliverable to label plus path, not to a dead link', async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { startCardImages } = await import('../src/card-images.ts')
    const { neutralizeCard } = await import('../src/card-markdown.ts')

    const root = await mkdtemp(join(tmpdir(), 'dsh-footer-media-'))
    try {
      await mkdir(join(root, 'out'), { recursive: true })
      await writeFile(join(root, 'out', 'summary.md'), '# report')
      const handle = startCardImages({
        resolveWorkspace: async () => root,
        upload: async () => 'img_v3_probe',
        logger: { warn: () => undefined },
      })
      const card = renderFooterCard(t, { workspace: root }, {
        ...turnStats,
        deliverables: [{ path: 'out/summary.md', description: 'Monthly rollup' }],
      }) as any
      const out = await handle.hydrate(card, { workspace: root })
      // The writer neutralizes what the hydrator left alone: label first, path
      // in a code span (the pre-2026-09-24 text), never a link Feishu cannot open.
      const md = markdownOf(neutralizeCard(out as any) as any)
      expect(md).toContain('Monthly rollup · `out/summary.md`')
      expect(md).not.toContain('](out/summary.md)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
