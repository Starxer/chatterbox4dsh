import { afterEach, describe, expect, it, vi } from 'vitest'
import { startChannel } from '../src/channel.ts'
import { resolveConfig } from '../src/config.ts'
import { translationsFor } from '../src/i18n.ts'

const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
async function setup() {
  vi.useFakeTimers()
  const handlers = new Map<string, (event: any) => Promise<void>>()
  let session = 's1'
  let onboarding = false
  let binding: ((chat: any, id: string) => void) | undefined
  const channel = {
    on: vi.fn((name, fn) => { handlers.set(name, fn); return () => handlers.delete(name) }),
    connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    send: vi.fn(async (_to: string, _input: unknown, _opts?: unknown) => ({ messageId: 'sent' })), addReaction: vi.fn(async () => 'react'),
    rawClient: { im: { v1: { messageResource: { get: vi.fn(async () => bytes) } } } },
  }
  const bridge = {
    reply: vi.fn(async (_message: any, options: any) => { options?.onAccepted?.(); return undefined }),
    resolveSessionIdFor: vi.fn(() => session), noteTopic: vi.fn(),
    needsOnboarding: vi.fn(async () => onboarding), consumeIntermediateSent: vi.fn(() => false),
    dispose: vi.fn(async () => undefined),
  }
  const limits = { maxImageBytes: 20, maxImagesPerMessage: 3, maxMessageImageBytes: 10, maxImagePixels: 100, maxImageDimension: 100, mediaTypes: ['image/jpeg'] as const }
  const attachments = {
    imageLimits: limits,
    saveImages: vi.fn(async (inputs: any[]) => inputs.map(input => ({ attachmentId: 'image', bytes: 1, mediaType: input.mediaType, width: 1, height: 1 }))),
    saveFileStream: vi.fn(async () => ({ attachmentId: 'file', name: 'data.txt', bytes: 4 })),
    fileHostPath: vi.fn(() => '/work/data.txt'),
  }
  const slash = vi.fn(async (message: any) => message.content.startsWith('/') ? { kind: 'consumed' as const } : undefined)
  const factory = vi.fn(() => channel as any)
  const stopped = await startChannel(resolveConfig({ appId: 'id', appSecret: 'placeholder', reactEmoji: '' }), bridge as any, factory,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, slash, attachments as any,
    undefined, undefined, undefined, undefined, undefined,
    { needsOnboarding: bridge.needsOnboarding, sendOnboardingCard: vi.fn(async () => undefined) },
    () => translationsFor('zh'), undefined, undefined, undefined, undefined, undefined, undefined,
    listener => { binding = listener; return () => { binding = undefined } })
  const emit = async (content = '', resources: any[] = [], topic?: string) => handlers.get('message')!({
    messageId: 'incoming', chatId: 'chat', chatType: 'p2p', content, resources,
    ...(topic === undefined ? {} : { threadId: topic, rootId: `root-${topic}` }),
  })
  const image = (key = 'img') => ({ type: 'image', fileKey: key })
  return { ...stopped, channel, bridge, attachments, limits, emit, image, factory,
    binding: (id: string) => { session = id; binding?.({ chatId: 'chat', chatType: 'p2p' }, id) },
    onboarding: (value: boolean) => { onboarding = value },
  }
}
afterEach(() => vi.useRealTimers())

describe('inbound attachment waiting', () => {
  it('preserves SDK message identity by disabling its chat-level batch merge', async () => {
    const s = await setup()
    expect(s.factory).toHaveBeenCalledWith(expect.objectContaining({ safety: expect.objectContaining({ chatQueue: { enabled: true }, batch: { text: { delayMs: 0 } } }) }))
    await s.stop()
  })
  it('collects pictures without a turn and sends 3s debounced cumulative notices', async () => {
    const s = await setup()
    await s.emit('![image](a)', [s.image('a')])
    await vi.advanceTimersByTimeAsync(2_000)
    await s.emit('![image](b)', [s.image('b')])
    await vi.advanceTimersByTimeAsync(2_999)
    expect(s.channel.send).not.toHaveBeenCalled()
    expect(s.bridge.reply).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(s.channel.send).toHaveBeenCalledTimes(1)
    expect(s.channel.send.mock.calls[0]![1]).toEqual({ text: expect.stringContaining('2 张图片') })
    await s.emit('![image](c)', [s.image('c')]) // exceeds aggregate source-byte limit
    await vi.advanceTimersByTimeAsync(3_000)
    expect(s.channel.send).toHaveBeenCalledTimes(2) // rejection only, no repeated old notice
    await s.emit('解释这些图片')
    expect(s.bridge.reply).toHaveBeenCalledTimes(1)
    expect(s.bridge.reply.mock.calls[0]![0].imageBlocks).toHaveLength(2)
    expect(s.bridge.reply.mock.calls[0]![0].content).toContain('解释这些图片')
    await s.stop()
  })
  it('cancels the notice if text arrives first; text plus new images is one turn', async () => {
    const s = await setup()
    await s.emit('![image](a)', [s.image('a')])
    await s.emit('这两张有什么区别 ![image](b)', [s.image('b')])
    await vi.advanceTimersByTimeAsync(4_000)
    expect(s.channel.send).not.toHaveBeenCalled()
    expect(s.bridge.reply).toHaveBeenCalledTimes(1)
    expect(s.bridge.reply.mock.calls[0]![0].imageBlocks).toHaveLength(2)
    await s.emit('next')
    expect(s.bridge.reply.mock.calls[1]![0].imageBlocks).toBeUndefined()
    await s.stop()
  })
  it('waits for files/video/audio and leaves them intact through ordinary slash commands', async () => {
    const s = await setup()
    for (const type of ['file', 'video', 'audio']) {
      await s.emit(`<${type} key="${type}" name="a>b.txt"/>`, [{ type, fileKey: type }])
    }
    await s.emit('/status')
    expect(s.bridge.reply).not.toHaveBeenCalled()
    await s.emit('use these')
    expect(s.bridge.reply.mock.calls[0]![0].fileBlocks).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(s.channel.send).not.toHaveBeenCalled()
    await s.stop()
  })
  it('isolates topics, replies to the topic root, and never flushes on stop', async () => {
    const s = await setup()
    await s.emit('![image](a)', [s.image('a')], 'one')
    await s.emit('text in another topic', [], 'two')
    expect(s.bridge.reply.mock.calls[0]![0].imageBlocks).toBeUndefined()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(s.channel.send).toHaveBeenCalledWith('chat', expect.anything(), { replyTo: 'root-one', replyInThread: true })
    await s.emit('![image](b)', [s.image('b')], 'one')
    await s.stop()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(s.channel.send).toHaveBeenCalledTimes(1)
  })
  it('uses original source bytes rather than normalized ref bytes for the total limit', async () => {
    const s = await setup()
    s.limits.maxMessageImageBytes = 7
    await s.emit('', [s.image('a')])
    await s.emit('', [s.image('b')])
    expect(s.attachments.saveImages).toHaveBeenCalledTimes(1)
    await s.emit('go')
    expect(s.bridge.reply.mock.calls[0]![0].imageBlocks).toHaveLength(1)
    await s.stop()
  })
  it('rechecks current single-image limits before consuming a pending draft', async () => {
    const s = await setup()
    await s.emit('', [s.image()])
    s.limits.maxImageBytes = 3
    await s.emit('go')
    expect(s.bridge.reply).not.toHaveBeenCalled()
    s.limits.maxImageBytes = 20
    await s.emit('retry')
    expect(s.bridge.reply.mock.calls[0]![0].imageBlocks).toHaveLength(1)
    await s.stop()
  })
  it('does not carry an established draft across a successful binding change', async () => {
    const s = await setup()
    await s.emit('', [s.image()])
    s.binding('s2')
    await s.emit('go')
    expect(s.bridge.reply.mock.calls[0]![0].imageBlocks).toBeUndefined()
    await s.stop()
  })
  it('keeps initial onboarding attachments until the first binding and text', async () => {
    const s = await setup()
    s.onboarding(true)
    await s.emit('', [s.image()])
    s.binding('first-session')
    s.onboarding(false)
    await s.emit('go')
    expect(s.bridge.reply.mock.calls[0]![0].imageBlocks).toHaveLength(1)
    await s.stop()
  })
  it('rejects an in-flight old-session upload after a card-driven switch', async () => {
    const s = await setup()
    let release!: (value: typeof bytes) => void
    s.channel.rawClient.im.v1.messageResource.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const incoming = s.emit('', [s.image()])
    for (let n = 0; n < 8; n++) await Promise.resolve()
    s.binding('s2')
    release(bytes)
    await incoming
    await s.emit('go')
    expect(s.bridge.reply.mock.calls[0]![0].imageBlocks).toBeUndefined()
    await s.stop()
  })
  it('counts reserved uploads until native acceptance while later uploads arrive', async () => {
    const s = await setup()
    s.limits.maxMessageImageBytes = 7
    await s.emit('', [s.image('a')])
    let reject!: (error: Error) => void
    s.bridge.reply.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    await s.emit('submit first')
    await s.emit('', [s.image('b')])
    expect(s.attachments.saveImages).toHaveBeenCalledTimes(1) // reserved source bytes also count before saving
    reject(new Error('admission failed'))
    for (let n = 0; n < 8; n++) await Promise.resolve()
    await s.emit('retry')
    expect(s.bridge.reply.mock.calls[1]![0].imageBlocks).toHaveLength(1)
    await s.stop()
  })
  it('restores attachments when native prompt admission fails, including new caption images', async () => {
    const s = await setup()
    await s.emit('', [s.image('a')])
    s.bridge.reply.mockRejectedValueOnce(new Error('failed before acceptance'))
    await s.emit('caption ![image](b)', [s.image('b')])
    for (let n = 0; n < 8; n++) await Promise.resolve()
    await s.emit('retry')
    expect(s.bridge.reply.mock.calls[1]![0].imageBlocks).toHaveLength(2)
    expect(s.bridge.reply.mock.calls[1]![0].content).not.toContain('caption')
    await s.stop()
  })
})
