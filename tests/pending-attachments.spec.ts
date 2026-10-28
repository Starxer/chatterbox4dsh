import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertImageBudget, attachmentMessageText, createPendingAttachments } from '../src/pending-attachments.ts'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'

const chat = { chatId: 'chat', chatType: 'p2p' as const }
const limits: ImageAttachmentLimits = { maxImageBytes: 10, maxImagesPerMessage: 2, maxMessageImageBytes: 15, maxImagePixels: 100, maxImageDimension: 10, mediaTypes: ['image/png'] }
function setup() {
  vi.useFakeTimers()
  let session = 's1'
  const notice = vi.fn(async (_batch: unknown, _valid: () => boolean) => undefined)
  const pending = createPendingAttachments({ sessionId: () => session, notice, warn: vi.fn() })
  const stash = (target = chat, bytes = 5) => pending.stash(target, {
    message: { ...target, content: 'image metadata', imageBlocks: [{ attachmentId: 'image' as any, bytes: 1, width: 1, height: 1, mediaType: 'image/png' }] },
    budget: { count: 1, bytes }, files: 0, replyTo: 'root', sessionId: session,
  })
  return { pending, notice, stash, session: (next: string) => { session = next } }
}
afterEach(() => vi.useRealTimers())

describe('attachmentMessageText', () => {
  it('removes SDK image placeholders but keeps captions and unrelated links', () => {
    expect(attachmentMessageText({ content: '![image](img)\n\ncaption ![other](else)', resources: [{ type: 'image', fileKey: 'img' }] })).toBe('caption ![other](else)')
    expect(attachmentMessageText({ content: '![image](img)', resources: [{ type: 'image', fileKey: 'img' }] })).toBe('')
  })
  it('removes file/video/audio metadata, even a > inside the quoted filename', () => {
    for (const type of ['file', 'video', 'audio'] as const) {
      expect(attachmentMessageText({ content: `<${type} key="f" name="a>b.txt"/>`, resources: [{ type, fileKey: 'f' }] })).toBe('')
      expect(attachmentMessageText({ content: `<${type} key="other"/>`, resources: [{ type, fileKey: 'f' }] })).not.toBe('')
    }
  })
  it('does not swallow a real command after an SDK placeholder', () => {
    expect(attachmentMessageText({ content: '<file key="f"/>\n\n/status', resources: [{ type: 'file', fileKey: 'f' }] })).toBe('/status')
  })
})

describe('host image budget', () => {
  it('allows equality, rejects count/aggregate/single-byte overruns with native codes', () => {
    expect(() => assertImageBudget(limits, { count: 2, bytes: 15 }, 10)).not.toThrow()
    for (const [budget, single, code] of [
      [{ count: 3, bytes: 1 }, 1, 'TOO_MANY_IMAGES'],
      [{ count: 2, bytes: 16 }, 1, 'IMAGES_TOO_LARGE'],
      [{ count: 1, bytes: 11 }, 11, 'IMAGE_TOO_LARGE'],
    ] as const) {
      try { assertImageBudget(limits, budget, single); expect.fail('not rejected') }
      catch (error) { expect(error).toHaveProperty('code', code) }
    }
  })
})

describe('pending attachments', () => {
  it('waits 3 seconds after the LAST successful addition and reports again after another', async () => {
    const { pending, stash, notice } = setup()
    stash()
    await vi.advanceTimersByTimeAsync(2_000)
    stash()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(notice).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(notice).toHaveBeenCalledTimes(1)
    expect(notice.mock.calls[0]![0]).toMatchObject({ budget: { count: 2, bytes: 10 } })
    stash()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(notice).toHaveBeenCalledTimes(2)
    pending.stop()
  })
  it('cancels a pending notice when text consumes the draft and merges in order', async () => {
    const { pending, stash, notice } = setup()
    stash()
    const merged = pending.merge(chat, { ...chat, content: 'explain', fileBlocks: [{ attachment: { name: 'new.txt' } }] })
    expect(merged.content).toBe('image metadata\n\nexplain')
    expect(merged.imageBlocks).toHaveLength(1)
    expect(merged.fileBlocks).toHaveLength(1)
    pending.reserve(chat)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(notice).not.toHaveBeenCalled()
    pending.stop()
  })
  it('isolates topics and cancels notice while a new download is in flight', async () => {
    const { pending, stash, notice } = setup()
    const topic = { ...chat, threadId: 't1' }
    stash(topic)
    expect(pending.peek(chat)).toBeUndefined()
    pending.defer(topic)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(notice).not.toHaveBeenCalled()
    pending.resume(topic)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(notice).toHaveBeenCalledOnce()
    pending.stop()
  })
  it('clears an old bound draft but lets first-message onboarding adopt the initial binding', () => {
    const { pending, stash, session } = setup()
    stash()
    session('s2')
    pending.bindingChanged(chat, 's2')
    expect(pending.peek(chat)).toBeUndefined()
    pending.stash(chat, { message: { ...chat, content: '' }, budget: { count: 1, bytes: 5 }, files: 0, replyTo: 'root' })
    pending.bindingChanged(chat, 's2')
    expect(pending.peek(chat)?.sessionId).toBe('s2')
    pending.stop()
  })
  it('restores a failed submission ahead of newer uploads, without erasing the new batch', () => {
    const { pending, stash } = setup()
    stash(chat, 8)
    const reservation = pending.reserve(chat)!
    expect(pending.budget(chat)).toMatchObject({ count: 1, bytes: 8 })
    stash(chat, 9)
    reservation.restore()
    expect(pending.peek(chat)?.budget).toMatchObject({ count: 2, bytes: 17 })
    expect(pending.peek(chat)?.message.imageBlocks).toHaveLength(2)
    pending.stop()
  })
  it('does not let a late old-session acceptance erase the new reserved budget', () => {
    const { pending, stash, session } = setup()
    stash(chat, 4)
    const old = pending.reserve(chat)!
    session('s2')
    pending.bindingChanged(chat, 's2')
    stash(chat, 7)
    const next = pending.reserve(chat)!
    old.accept()
    expect(pending.budget(chat)).toMatchObject({ count: 1, bytes: 7 })
    next.accept()
    expect(pending.budget(chat).count).toBe(0)
    pending.stop()
  })
  it('does not repeat an already sent notice after a refused upload', async () => {
    const { pending, stash, notice } = setup()
    stash()
    await vi.advanceTimersByTimeAsync(3_000)
    pending.defer(chat)
    pending.resume(chat)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(notice).toHaveBeenCalledOnce()
    pending.stop()
  })
  it('does not resurrect a draft after binding change or stop', async () => {
    const { pending, stash, session, notice } = setup()
    stash()
    const reservation = pending.reserve(chat)!
    session('new-session')
    reservation.restore()
    expect(pending.peek(chat)).toBeUndefined()
    stash()
    pending.stop()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(notice).not.toHaveBeenCalled()
  })
})
