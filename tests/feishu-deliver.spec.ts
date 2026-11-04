import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DELIVER_CANCEL,
  DELIVER_OPEN,
  DELIVER_SEND,
  renderDeliverConfirmCard,
  renderDeliverableElements,
  startFeishuDeliverables,
  type DeliverCardEvent,
  type DeliverPlanInput,
  type FeishuDeliverChannel,
} from '../src/feishu-deliver.ts'
import {
  classifyDeliverable,
  formatFileSize,
  noteDeliveredFile,
  resetDeliveredFiles,
} from '../src/deliver-files.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

/** Minimal channel double: records sends/updates and exposes the action fan-out. */
function fakeChannel() {
  const handlers: Array<(event: DeliverCardEvent) => void | Promise<void>> = []
  const sent: Array<{ to: string; input: any; opts?: any }> = []
  const updated: Array<{ messageId: string; card: any }> = []
  let nextId = 0
  const channel: FeishuDeliverChannel & { sent: typeof sent; updated: typeof updated; tap: (event: DeliverCardEvent) => Promise<void> } = {
    sent,
    updated,
    send: vi.fn(async (to: string, input: any, opts?: any) => {
      sent.push({ to, input, opts })
      nextId += 1
      return { messageId: `m${nextId}` }
    }) as any,
    updateCard: vi.fn(async (messageId: string, card: any) => {
      updated.push({ messageId, card })
    }),
    onCardAction: (handler: (event: DeliverCardEvent) => void | Promise<void>) => {
      handlers.push(handler)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    tap: async (event: DeliverCardEvent) => {
      for (const handler of [...handlers]) await handler(event)
    },
  }
  return channel
}

/** One plan + a controller over a temp workspace. */
async function harness(overrides: { docMaxMb?: number; sendFile?: any } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
  const channel = fakeChannel()
  const sendFile = overrides.sendFile ?? vi.fn(async () => ({ sentAs: 'file', messageId: 'file-1' }))
  const handle = startFeishuDeliverables({
    channel,
    logger: { warn: vi.fn(), error: vi.fn() },
    getTranslations: () => t,
    docMaxMb: () => overrides.docMaxMb ?? 30,
    topicFor: () => ({}),
    sendFile,
  })
  return {
    root,
    channel,
    sendFile,
    handle,
    input: (files: Array<{ path: string; description?: string }>, workspace = root): DeliverPlanInput => ({
      sessionId: 'session-1',
      chatId: 'oc_1',
      workspace,
      files,
    }),
  }
}

/** A symlink escape: the token was registered for the file inside the workspace. */
async function swapForSymlink(path: string, target: string): Promise<void> {
  await rm(path, { force: true })
  await symlink(target, path)
}

beforeEach(() => {
  resetDeliveredFiles()
})

describe('deliverable classification', () => {
  it('treats the office documents as documents and everything else by family', () => {
    for (const ext of ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']) {
      expect(classifyDeliverable(`out/report.${ext}`)).toBe('document')
      expect(classifyDeliverable(`out/REPORT.${ext.toUpperCase()}`)).toBe('document')
    }
    expect(classifyDeliverable('runs/a.png')).toBe('image')
    expect(classifyDeliverable('runs/a.MP4')).toBe('video')
    expect(classifyDeliverable('runs/voice.opus')).toBe('audio')
    for (const ext of ['md', 'csv', 'ts', 'zip', 'sh', '']) {
      expect(classifyDeliverable(`out/file${ext === '' ? '' : `.${ext}`}`)).toBe('other')
    }
  })

  it('formats sizes for the card', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatFileSize(31 * 1024 * 1024)).toBe('31 MB')
  })
})

describe('deliverable planning', () => {
  it('auto-delivers a whitelisted document under the limit, without a token', async () => {
    const { root, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'report.pdf'), Buffer.alloc(2048, 1))
      const plan = await handle.plan(input([{ path: 'out/report.pdf', description: 'Monthly report' }]))
      expect(plan.rows).toHaveLength(1)
      expect(plan.rows[0]).toMatchObject({ name: 'report.pdf', kind: 'document', auto: true, size: 2048 })
      expect(plan.rows[0]!.token).toBeUndefined()
      expect(plan.rows[0]!.blocked).toBeUndefined()
      expect(plan.auto).toHaveLength(1)
      expect(plan.auto[0]).toMatchObject({ name: 'report.pdf', sessionId: 'session-1' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('offers a document over `deliverDocMaxMb` as a clickable row', async () => {
    const { root, handle, input } = await harness({ docMaxMb: 1 })
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'deck.pptx'), Buffer.alloc(2 * 1024 * 1024, 1))
      const plan = await handle.plan(input([{ path: 'out/deck.pptx' }]))
      expect(plan.auto).toHaveLength(0)
      expect(plan.rows[0]!.token).toEqual(expect.any(String))
      expect(plan.rows[0]!.auto).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('offers every other file as a clickable row', async () => {
    const { root, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      const plan = await handle.plan(input([{ path: 'out/notes.md', description: 'Read me' }]))
      expect(plan.rows[0]).toMatchObject({ name: 'notes.md', kind: 'other', description: 'Read me' })
      expect(plan.rows[0]!.token).toEqual(expect.any(String))
      expect(plan.auto).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('caps how many documents one turn may push by itself', async () => {
    const { root, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      const files: Array<{ path: string }> = []
      for (let index = 0; index < 9; index += 1) {
        const path = `out/doc${index}.pdf`
        await writeFile(join(root, path), 'x')
        files.push({ path })
      }
      const plan = await handle.plan(input(files))
      expect(plan.auto).toHaveLength(8)
      // The ninth is still deliverable — the operator just has to tap for it.
      expect(plan.rows.filter(row => row.auto === true)).toHaveLength(8)
      expect(plan.rows.filter(row => row.token !== undefined)).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps media on the card: no token and no separate message', async () => {
    const { root, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'still.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const plan = await handle.plan(input([{ path: 'out/still.png' }]))
      expect(plan.rows[0]).toMatchObject({ kind: 'image', name: 'still.png' })
      expect(plan.rows[0]!.token).toBeUndefined()
      expect(plan.rows[0]!.blocked).toBeUndefined()
      expect(plan.auto).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a path outside the session workspace', async () => {
    const { root, handle, input } = await harness()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-deliver-outside-'))
    try {
      await writeFile(join(outside, 'secret.pdf'), 'x')
      const plan = await handle.plan(input([{ path: join(outside, 'secret.pdf') }]))
      expect(plan.rows[0]!.blocked).toBe('outside')
      expect(plan.rows[0]!.token).toBeUndefined()
      expect(plan.auto).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses a file over Feishu\'s 30 MB ceiling and a missing file', async () => {
    const { root, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'huge.zip'), '')
      await truncate(join(root, 'out', 'huge.zip'), 31 * 1024 * 1024)
      const plan = await handle.plan(input([{ path: 'out/huge.zip' }, { path: 'out/missing.md' }]))
      expect(plan.rows[0]!.blocked).toBe('too-large')
      expect(plan.rows[1]!.blocked).toBe('unreadable')
      expect(plan.rows.every(row => row.token === undefined)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats an empty file as undeliverable and reports it as such', async () => {
    const { root, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'empty.md'), '')
      const plan = await handle.plan(input([{ path: 'out/empty.md' }]))
      expect(plan.rows[0]!.blocked).toBe('unreadable')
      expect(plan.rows[0]!.token).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('evicts the oldest token once the registry is over its cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const channel = fakeChannel()
    const sendFile = vi.fn(async () => ({ sentAs: 'file', messageId: 'file-1' }))
    const handle = startFeishuDeliverables({
      channel,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
      docMaxMb: () => 30,
      topicFor: () => ({}),
      sendFile,
      maxTokens: 1,
    })
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'a.md'), 'a')
      await writeFile(join(root, 'out', 'b.md'), 'b')
      await writeFile(join(root, 'out', 'c.md'), 'c')
      const first = await handle.plan({ sessionId: 's', chatId: 'oc_1', workspace: root, files: [{ path: 'out/a.md' }] })
      await handle.plan({ sessionId: 's', chatId: 'oc_1', workspace: root, files: [{ path: 'out/b.md' }] })
      // The third plan prunes: with a cap of 1 the oldest token is dropped.
      const third = await handle.plan({ sessionId: 's', chatId: 'oc_1', workspace: root, files: [{ path: 'out/c.md' }] })
      const staleToken = first.rows[0]!.token!
      await channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token: staleToken } } })
      expect(sendFile).not.toHaveBeenCalled()
      await channel.tap({ chatId: 'oc_1', messageId: 'confirm-2', action: { value: { p: DELIVER_SEND, token: third.rows[0]!.token! } } })
      expect(sendFile).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks every row as outside when the session has no workspace', async () => {
    const { root, handle, input } = await harness()
    try {
      await writeFile(join(root, 'a.md'), 'x')
      const plan = await handle.plan({ sessionId: 's', chatId: 'oc_1', files: [{ path: 'a.md' }] })
      expect(plan.rows[0]!.blocked).toBe('outside')
      expect(plan.rows[0]!.token).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deliverable rendering', () => {
  it('names media in plain text and links the path for the hydrator', () => {
    const elements = renderDeliverableElements([
      { path: 'out/still.png', name: 'still.png', kind: 'image', description: 'Final still' },
    ], t) as any[]
    const markdown = elements.filter(element => element.tag === 'markdown').map(element => element.content).join('\n')
    expect(markdown).toContain('**still.png**')
    expect(markdown).toContain('Final still')
    expect(markdown).toContain('](out/still.png)')
    expect(elements.some(element => element.tag === 'interactive_container')).toBe(false)
  })

  it('makes a file the operator can ask for a clickable row carrying an opaque token', () => {
    const elements = renderDeliverableElements([
      { path: 'out/notes.md', name: 'notes.md', kind: 'other', size: 2048, token: 'tok-1' },
    ], t) as any[]
    const row = elements.find(element => element.tag === 'interactive_container') as any
    expect(row.behaviors).toEqual([{ type: 'callback', value: { p: DELIVER_OPEN, token: 'tok-1' } }])
    const rowText = row.elements.map((element: any) => element.content).join('\n')
    expect(rowText).toContain('**notes.md**')
    expect(rowText).toContain('2.0 KB')
    // The token is the only thing the callback carries — never the path.
    expect(JSON.stringify(row.behaviors)).not.toContain('out/notes.md')
  })

  it('marks an auto-sent document and explains a blocked one', () => {
    const elements = renderDeliverableElements([
      { path: 'out/report.pdf', name: 'report.pdf', kind: 'document', size: 4096, auto: true },
      { path: 'out/huge.zip', name: 'huge.zip', kind: 'other', size: 31 * 1024 * 1024, blocked: 'too-large' },
    ], t) as any[]
    const markdown = elements.filter(element => element.tag === 'markdown').map(element => element.content).join('\n')
    expect(markdown).toContain('自动投递')
    expect(markdown).toContain('超过飞书 30MB 上限')
  })

  it('caps the rows it shows and counts the rest', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      path: `out/f${index}.md`,
      name: `f${index}.md`,
      kind: 'other' as const,
      token: `tok-${index}`,
    }))
    const elements = renderDeliverableElements(rows, t) as any[]
    expect(elements.filter(element => element.tag === 'interactive_container')).toHaveLength(10)
    expect(elements.some(element => element.tag === 'markdown' && element.content.includes('另有 2 个'))).toBe(true)
  })
})

describe('automatic delivery', () => {
  it('sends the planned documents in order and does not send them twice', async () => {
    const { root, channel, sendFile, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'a.pdf'), 'a')
      await writeFile(join(root, 'out', 'b.docx'), 'b')
      const plan = await handle.plan(input([{ path: 'out/a.pdf' }, { path: 'out/b.docx' }]))
      await handle.autoSend(plan, { chatId: 'oc_1' })
      expect(sendFile).toHaveBeenCalledTimes(2)
      expect((sendFile as any).mock.calls[0]![0]).toMatchObject({ chatId: 'oc_1', path: join(root, 'out', 'a.pdf') })
      expect((sendFile as any).mock.calls[1]![0]).toMatchObject({ chatId: 'oc_1', path: join(root, 'out', 'b.docx') })
      await handle.autoSend(plan, { chatId: 'oc_1' })
      expect(sendFile).toHaveBeenCalledTimes(2)
      expect(channel.sent).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not re-send a file the model already pushed with feishu_send_file', async () => {
    const { root, sendFile, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'a.pdf'), 'a')
      const plan = await handle.plan(input([{ path: 'out/a.pdf' }]))
      noteDeliveredFile('session-1', join(root, 'out', 'a.pdf'))
      await handle.autoSend(plan, { chatId: 'oc_1' })
      expect(sendFile).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a failed auto-send as a text message instead of throwing', async () => {
    const sendFile = vi.fn(async () => { throw new Error('Failed to send "a.pdf" via Feishu: 230021') })
    const { root, channel, handle, input } = await harness({ sendFile })
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'a.pdf'), 'a')
      const plan = await handle.plan(input([{ path: 'out/a.pdf' }]))
      await expect(handle.autoSend(plan, { chatId: 'oc_1' })).resolves.toBeUndefined()
      expect(channel.sent).toHaveLength(1)
      expect(channel.sent[0]!.input.text).toContain('自动发送')
      expect(channel.sent[0]!.input.text).toContain('a.pdf')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('tap → confirm → send', () => {
  it('posts a confirmation card carrying the token, and a confirm sends the file', async () => {
    const { root, channel, sendFile, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      const plan = await handle.plan(input([{ path: 'out/notes.md', description: 'Read me' }]))
      const token = plan.rows[0]!.token!
      await channel.tap({ chatId: 'oc_1', messageId: 'card-1', action: { value: { p: DELIVER_OPEN, token } } })
      expect(channel.sent).toHaveLength(1)
      const confirm = channel.sent[0]!.input.card
      expect(JSON.stringify(confirm)).toContain('notes.md')
      expect(JSON.stringify(confirm)).toContain(DELIVER_SEND)
      expect(JSON.stringify(confirm)).toContain(token)

      await channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token } } })
      expect(sendFile).toHaveBeenCalledTimes(1)
      expect((sendFile as any).mock.calls[0]![0]).toMatchObject({ chatId: 'oc_1', path: join(root, 'out', 'notes.md') })
      expect(channel.updated).toHaveLength(1)
      expect(channel.updated[0]!.messageId).toBe('confirm-1')
      expect(JSON.stringify(channel.updated[0]!.card)).toContain('已发送')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cancelling sends nothing and settles the card', async () => {
    const { root, channel, sendFile, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      const plan = await handle.plan(input([{ path: 'out/notes.md' }]))
      const token = plan.rows[0]!.token!
      await channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_CANCEL, token } } })
      expect(sendFile).not.toHaveBeenCalled()
      expect(JSON.stringify(channel.updated[0]!.card)).toContain('已取消')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a tap that comes from another chat', async () => {
    const { root, channel, sendFile, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      const plan = await handle.plan(input([{ path: 'out/notes.md' }]))
      const token = plan.rows[0]!.token!
      await channel.tap({ chatId: 'oc_OTHER', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token } } })
      expect(sendFile).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-checks the file on every tap: a vanished file is refused', async () => {
    const { root, channel, sendFile, handle, input } = await harness()
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      const plan = await handle.plan(input([{ path: 'out/notes.md' }]))
      const token = plan.rows[0]!.token!
      await rm(join(root, 'out', 'notes.md'))
      await channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token } } })
      expect(sendFile).not.toHaveBeenCalled()
      expect(JSON.stringify(channel.updated[0]!.card)).toContain('不存在')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-checks containment on every tap: a symlink swapped in later is refused', async () => {
    const { root, channel, sendFile, handle, input } = await harness()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-deliver-target-'))
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      await writeFile(join(outside, 'secret.md'), 'secret')
      const plan = await handle.plan(input([{ path: 'out/notes.md' }]))
      const token = plan.rows[0]!.token!
      await swapForSymlink(join(root, 'out', 'notes.md'), join(outside, 'secret.md'))
      await channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token } } })
      expect(sendFile).not.toHaveBeenCalled()
      expect(JSON.stringify(channel.updated[0]!.card)).toContain('工作区')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses an unknown or expired token without sending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const channel = fakeChannel()
    const sendFile = vi.fn(async () => ({ sentAs: 'file', messageId: 'file-1' }))
    let clock = 1_000_000
    const handle = startFeishuDeliverables({
      channel,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
      docMaxMb: () => 30,
      topicFor: () => ({}),
      sendFile,
      now: () => clock,
    })
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      const plan = await handle.plan({ sessionId: 's', chatId: 'oc_1', workspace: root, files: [{ path: 'out/notes.md' }] })
      const token = plan.rows[0]!.token!
      // Past the 30-minute token TTL: the file is still there, the token is not.
      clock += 31 * 60_000
      await channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token } } })
      expect(sendFile).not.toHaveBeenCalled()
      expect(JSON.stringify(channel.updated.at(-1)!.card)).toContain('失效')
      await channel.tap({ chatId: 'oc_1', messageId: 'card-1', action: { value: { p: DELIVER_OPEN, token: 'nope' } } })
      expect(sendFile).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the topic of the card that was tapped for the confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const channel = fakeChannel()
    const sendFile = vi.fn(async () => ({ sentAs: 'file', messageId: 'file-1' }))
    const topicFor = vi.fn(() => ({ threadId: 'th_1', rootId: 'om_root' }))
    const handle = startFeishuDeliverables({
      channel,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
      docMaxMb: () => 30,
      topicFor,
      sendFile,
    })
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      const plan = await handle.plan({ sessionId: 's', chatId: 'oc_1', workspace: root, files: [{ path: 'out/notes.md' }] })
      const token = plan.rows[0]!.token!
      await channel.tap({ chatId: 'oc_1', messageId: 'card-1', action: { value: { p: DELIVER_OPEN, token } } })
      expect(topicFor).toHaveBeenCalledWith({ chatId: 'oc_1', messageId: 'card-1' })
      expect(channel.sent[0]!.opts).toEqual({ replyInThread: true, replyTo: 'om_root' })
      await channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token } } })
      expect((sendFile as any).mock.calls[0]![0].opts).toEqual({ replyInThread: true, replyTo: 'om_root' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prefers the topic recorded at plan time over the chat-level lookup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const channel = fakeChannel()
    const sendFile = vi.fn(async () => ({ sentAs: 'file', messageId: 'file-1' }))
    // The registry lookup would land in the WRONG topic — the plan's own
    // coordinates must win (关键坑 31).
    const topicFor = vi.fn(() => ({ threadId: 'th_WRONG', rootId: 'om_WRONG' }))
    const handle = startFeishuDeliverables({
      channel,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
      docMaxMb: () => 30,
      topicFor,
      sendFile,
    })
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      const plan = await handle.plan({
        sessionId: 's', chatId: 'oc_1', workspace: root,
        topic: { threadId: 'th_PLAN', rootId: 'om_PLAN' },
        files: [{ path: 'out/notes.md' }],
      })
      const token = plan.rows[0]!.token!
      await channel.tap({ chatId: 'oc_1', messageId: 'card-1', action: { value: { p: DELIVER_OPEN, token } } })
      expect(channel.sent[0]!.opts).toEqual({ replyInThread: true, replyTo: 'om_PLAN' })
      await channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token } } })
      expect((sendFile as any).mock.calls[0]![0].opts).toEqual({ replyInThread: true, replyTo: 'om_PLAN' })
      expect(topicFor).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('sends once when Send is tapped twice before the first send lands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const channel = fakeChannel()
    let release: (() => void) | undefined
    const sendFile = vi.fn(() => new Promise<{ sentAs: string; messageId: string }>((resolve) => {
      release = () => resolve({ sentAs: 'file', messageId: 'file-1' })
    }))
    const handle = startFeishuDeliverables({
      channel,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
      docMaxMb: () => 30,
      topicFor: () => ({}),
      sendFile,
    })
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      const plan = await handle.plan({ sessionId: 's', chatId: 'oc_1', workspace: root, files: [{ path: 'out/notes.md' }] })
      const token = plan.rows[0]!.token!
      const first = channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token } } })
      // Wait until the first tap has actually reached the still-pending send,
      // which is exactly the window the `sending` guard covers. A bare
      // `setTimeout(0)` used to be enough locally but can fire before the tap's
      // async path gets there under load, leaving `release` undefined and
      // hanging the test until its 5s timeout (seen on CI).
      await vi.waitFor(() => expect(sendFile).toHaveBeenCalledTimes(1), { timeout: 2000 })
      const second = channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token } } })
      release!()
      await Promise.all([first, second])
      expect(sendFile).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers a stale row tap in a message instead of editing the row card', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const channel = fakeChannel()
    const handle = startFeishuDeliverables({
      channel,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
      docMaxMb: () => 30,
      topicFor: () => ({}),
      sendFile: vi.fn(async () => ({ sentAs: 'file', messageId: 'file-1' })),
    })
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      await handle.plan({ sessionId: 's', chatId: 'oc_1', workspace: root, files: [{ path: 'out/notes.md' }] })
      await channel.tap({ chatId: 'oc_1', messageId: 'card-1', action: { value: { p: DELIVER_OPEN, token: 'gone' } } })
      // A notice message, and crucially NO edit of the row card (an in-place
      // edit would kill every row's callback — 关键坑 11).
      expect(channel.sent).toHaveLength(1)
      expect(channel.sent[0]!.input.text).toContain('失效')
      expect(channel.updated).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops every token and stops listening on dispose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const channel = fakeChannel()
    const sendFile = vi.fn(async () => ({ sentAs: 'file', messageId: 'file-1' }))
    const handle = startFeishuDeliverables({
      channel,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
      docMaxMb: () => 30,
      topicFor: () => ({}),
      sendFile,
    })
    try {
      await mkdir(join(root, 'out'))
      await writeFile(join(root, 'out', 'notes.md'), '# notes')
      const plan = await handle.plan({ sessionId: 's', chatId: 'oc_1', workspace: root, files: [{ path: 'out/notes.md' }] })
      const token = plan.rows[0]!.token!
      handle.dispose()
      await channel.tap({ chatId: 'oc_1', messageId: 'confirm-1', action: { value: { p: DELIVER_SEND, token } } })
      expect(sendFile).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('renderDeliverConfirmCard', () => {
  it('carries both buttons and the token, and strips markdown from the name', () => {
    const card = renderDeliverConfirmCard({
      token: 'tok-9',
      chatId: 'oc_1',
      sessionId: 's',
      root: '/w',
      abs: '/w/a.md',
      display: 'out/a.md',
      name: 'a`[](x).md',
      size: 1024,
      createdAt: 0,
      sent: false,
    }, t) as any
    const json = JSON.stringify(card)
    expect(json).toContain(DELIVER_SEND)
    expect(json).toContain(DELIVER_CANCEL)
    expect(json).toContain('tok-9')
    // A name the model (or a file system) made hostile must not smuggle card
    // markdown into the confirmation.
    expect(json).not.toContain('[](x)')
  })
})
