import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { startChannel } from '../src/channel.ts'
import { TurnFailureError } from '../src/turn-failure.ts'
import { translationsFor } from '../src/i18n.ts'
import type { InterleaveTarget } from '../src/card-interleave.ts'
import type { AttachmentId, FileAttachmentRef, ImageAttachmentRef, ImageMediaType, ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'

/** Flush the microtask queue so fire-and-forget promises settle. */
const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 10_000_000,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100_000_000,
  maxImagePixels: 40_000_000,
  maxImageDimension: 4096,
  mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const,
}

function fakeImageRef(input: { data: Uint8Array; mediaType: string; name?: string }): ImageAttachmentRef {
  return {
    attachmentId: `att_${input.data.byteLength}` as AttachmentId,
    mediaType: input.mediaType as ImageMediaType,
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
    ...input.name === undefined ? {} : { name: input.name },
  }
}

async function fakeFileHost(overrides: { saveFileStream?: (input: { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string }) => Promise<FileAttachmentRef> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-file-'))
  const captured: Buffer[] = []
  return {
    root,
    saveImages: vi.fn(async (inputs: any[]) => inputs.map(input => fakeImageRef(input))),
    imageLimits: IMAGE_LIMITS,
    saveFileStream: vi.fn(overrides.saveFileStream ?? (async (input: { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string }) => {
      const chunks: Buffer[] = []
      for await (const chunk of input.data) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      captured.push(bytes)
      const hostPath = join(root, input.name ?? 'file')
      await writeFile(hostPath, bytes)
      return {
        attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as AttachmentId,
        name: input.name ?? 'file',
        bytes: bytes.byteLength,
      }
    })),
    captured,
    fileHostPath: vi.fn((ref: FileAttachmentRef) => join(root, ref.name)),
  }
}

function fakeAttachments(overrides: { saveImage?: (input: any) => Promise<ImageAttachmentRef> } = {}) {
  return {
    saveImages: vi.fn(async (inputs: any[]) => Promise.all(inputs.map(overrides.saveImage ?? (async input => fakeImageRef(input))))),
    imageLimits: IMAGE_LIMITS,
    saveFileStream: vi.fn(),
    fileHostPath: vi.fn(),
  }
}

function fakeChannel(imageBytes?: Buffer) {
  const handlers = new Map<string, Function>()
  // Minimal SDK download-response shape: the wrapper exposes a readable stream.
  const fakeReadable = (bytes: Buffer): { getReadableStream: () => unknown; writeFile: unknown; headers: unknown } => ({
    getReadableStream: () => {
      const { Readable } = require('node:stream') as typeof import('node:stream')
      return Readable.from(bytes)
    },
    writeFile: vi.fn(async () => undefined),
    headers: {},
  })
  return {
    handlers,
    connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ messageId: 'out' })),
    addReaction: vi.fn(async () => 'reaction-id'),
    rawClient: {
      im: {
        v1: {
          messageResource: {
            get: vi.fn(async () => fakeReadable(imageBytes ?? Buffer.from([0xff, 0xd8, 0xff, 0xe0]))),
          },
        },
      },
    },
    on: vi.fn((name: string, handler: Function) => { handlers.set(name, handler); return () => handlers.delete(name) }),
  }
}

describe('startChannel', () => {
  it('uses WebSocket policy defaults and replies to the inbound message', async () => {
    const channel = fakeChannel()
    const factory = vi.fn(() => channel as any)
    const bridge = { reply: vi.fn(async () => 'Hello **Lark**'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, factory, logger)
    expect(logger.info).toHaveBeenCalledWith('dsh-feishu: WebSocket connected')
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ transport: 'websocket', policy: expect.objectContaining({ requireMention: true, dmMode: 'open' }), wsConfig: expect.objectContaining({ pingTimeout: expect.any(Number) }) }))
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    expect(channel.addReaction).toHaveBeenCalledWith('om_1', 'THUMBSUP')
    expect(bridge.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hi' }),
      expect.objectContaining({ onBusy: expect.any(Function) }),
    )
    // Reply card is no longer sent separately — step cards from feishu-streaming handle it.
    await stop()
    expect(channel.disconnect).toHaveBeenCalledOnce()
    expect(bridge.dispose).toHaveBeenCalledOnce()
    expect(logger.info).toHaveBeenCalledWith('dsh-feishu: WebSocket disconnected')
  })

  it('records the topic root of every inbound topic message', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger)
    // A topic reply carries the topic root.
    await channel.handlers.get('message')!({ messageId: 'om_2', chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', rootId: 'om_root', content: 'hi' })
    expect(bridge.noteTopic).toHaveBeenCalledWith({ chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', rootId: 'om_root' })
    // The topic's ROOT message has no root_id and is its own reply target —
    // dropping it here is what left WebUI-driven cards outside the topic.
    await channel.handlers.get('message')!({ messageId: 'om_3', chatId: 'oc_1', chatType: 'group', threadId: 'omt_2', content: 'hi' })
    expect(bridge.noteTopic).toHaveBeenLastCalledWith({ chatId: 'oc_1', chatType: 'group', threadId: 'omt_2', rootId: 'om_3' })
    // A main-chat message has no topic to record.
    expect(bridge.noteTopic).toHaveBeenCalledTimes(2)
    await stop()
  })

  it('records the topic even for a slash command that returns before the agent loop', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const slashCommand = vi.fn(async () => ({ kind: 'success' as const, text: 'status' }))
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger, undefined, slashCommand)
    await channel.handlers.get('message')!({ messageId: 'om_9', chatId: 'oc_1', chatType: 'group', threadId: 'omt_3', content: '/status' })
    expect(bridge.noteTopic).toHaveBeenCalledWith({ chatId: 'oc_1', chatType: 'group', threadId: 'omt_3', rootId: 'om_9' })
    expect(bridge.reply).not.toHaveBeenCalled()
    await stop()
  })

  it('announces the busy notice a steer posts, so the running card starts a new segment', async () => {
    // The 2026-10-19 user report: steering a message into a running turn posts a
    // notice, but the compact step card kept writing IN PLACE above it, so new
    // progress was easy to miss. `noteMessagePosted` is the signal that ends the
    // card's segment — it must fire for TEXT, not only for cards.
    const channel = fakeChannel()
    const notes: InterleaveTarget[] = []
    const bridge = {
      reply: vi.fn(async (_message: unknown, options?: { onBusy?: (mode: 'steer' | 'queue') => void }) => {
        options?.onBusy?.('steer')
        return undefined
      }),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => false),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '', showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'compact',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (target: InterleaveTarget) => notes.push(target))
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: '插一句' })
    await flushAsync()
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: translationsFor('zh').busySteeredNotice }, expect.anything())
    expect(notes).toEqual([{ chatId: 'oc_1' }])
    await stop()
  })

  it('reports a steer notice in a TOPIC against that topic, not the whole chat', async () => {
    // One Feishu topic is one DSH session (user rule, 2026-10-19): the notice's
    // target must carry the topic root, so the running card of another topic in
    // the same group is not cut.
    const channel = fakeChannel()
    const notes: InterleaveTarget[] = []
    const bridge = {
      reply: vi.fn(async (_message: unknown, options?: { onBusy?: (mode: 'steer' | 'queue') => void }) => {
        options?.onBusy?.('steer')
        return undefined
      }),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => false),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '', showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'compact',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (target: InterleaveTarget) => notes.push(target))
    await channel.handlers.get('message')!({ messageId: 'om_2', chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', rootId: 'om_root', content: '插一句' })
    await flushAsync()
    expect(notes).toEqual([{ chatId: 'oc_1', rootId: 'om_root' }])
    await stop()
  })

  it('announces a reply it posts, so no progress is written above it', async () => {
    const channel = fakeChannel()
    const notes: InterleaveTarget[] = []
    const bridge = {
      reply: vi.fn(async () => 'the answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => false),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '', showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'compact',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (target: InterleaveTarget) => notes.push(target))
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await vi.waitFor(() => { expect(notes).toContainEqual({ chatId: 'oc_1' }) })
    await stop()
  })

  it('posts the full reply when no step card was confirmed delivered', async () => {
    // The 2026-09-21 failure: streaming marked the text as "on screen", the
    // card never reached Feishu, and streaming withdrew the mark from
    // flushed(). channel.ts must therefore read the flag AFTER flushed() —
    // reading it earlier leaves the user with no answer at all.
    const channel = fakeChannel()
    let intermediate = true
    const bridge = {
      reply: vi.fn(async () => 'the full answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => { const had = intermediate; intermediate = false; return had }),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const flushed = vi.fn(async () => { intermediate = false; return undefined })
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined, undefined, undefined, undefined, flushed)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    const sent = (channel.send.mock.calls as any[]).map(call => JSON.stringify(call[1])).join(' ')
    expect(sent).toContain('the full answer')
    await stop()
  })

  it('sends only the footer when a step card really carried the text', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async () => 'the full answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => true),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const flushed = vi.fn(async () => undefined)
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined, undefined, undefined, undefined, flushed)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    const sent = (channel.send.mock.calls as any[]).map(call => JSON.stringify(call[1])).join(' ')
    expect(sent).not.toContain('the full answer')
    await stop()
  })

  it('at compact, folds the summary into the reply card and posts no Turn Complete card', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async () => 'the full answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => false),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const turnStats = {
      turnStartTime: 0, stepCount: 1, toolCallCount: 0, totalInputTokens: 1, totalOutputTokens: 2,
      totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalBilledTokens: 3, firstStepTtftMs: 10,
      totalDecodeMs: 100, totalDecodeTokens: 2, totalStepMs: 100, totalToolMs: 0, totalTurnMs: 200,
      deliverables: [],
    }
    const flushed = vi.fn(async () => turnStats as any)
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'compact',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined, undefined, undefined, undefined, flushed, undefined, undefined,
    () => translationsFor('zh'), undefined, undefined, undefined, undefined,
    () => true)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    const sent = (channel.send.mock.calls as any[]).map(call => JSON.stringify(call[1])).join(' ')
    // No step card carried the text, so this fallback posts the answer — and at
    // `compact` the answer card is what carries the turn summary.
    expect(sent).toContain('the full answer')
    // The card that carries the summary is titled as the turn's last card:
    // completion plus the wall clock, no turn/step position.
    expect(sent).toContain(translationsFor('zh').turnSummaryTitle)
    expect(sent).toContain('tokens')
    // The level has no Turn Complete card at all.
    expect(sent).not.toContain(translationsFor('zh').turnCompleteTitle)
    await stop()
  })

  it('at compact, puts delivered rows on their own titled card', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async () => 'the full answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => true),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const turnStats = {
      turnStartTime: 0, stepCount: 1, toolCallCount: 0, totalInputTokens: 1, totalOutputTokens: 2,
      totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalBilledTokens: 3, firstStepTtftMs: 10,
      totalDecodeMs: 100, totalDecodeTokens: 2, totalStepMs: 100, totalToolMs: 0, totalTurnMs: 200,
      deliverables: [{ path: 'out/report.pdf', description: 'Monthly report' }],
    }
    const flushed = vi.fn(async () => turnStats as any)
    const plan = {
      rows: [{ path: 'out/report.pdf', name: 'report.pdf', kind: 'document', size: 2048, auto: true }],
      auto: [{ path: '/work/out/report.pdf', name: 'report.pdf', sessionId: 'test-session' }],
    }
    const deliver = { plan: vi.fn(async () => plan), autoSend: vi.fn(async () => undefined) }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'compact',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined,
    async () => ({ workspace: '/work' }),
    undefined, undefined, flushed, undefined, undefined,
    () => translationsFor('zh'),
    undefined,
    deliver as any,
    undefined,
    undefined,
    () => true)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    const sent = (channel.send.mock.calls as any[]).map(call => JSON.stringify(call[1])).join(' ')
    expect(sent).toContain(translationsFor('zh').deliverablesCardTitle)
    expect(sent).toContain('report.pdf')
    expect(sent).toContain('自动投递')
    // The title is in the card header, so the body does not repeat it.
    expect(sent).not.toContain('交付文件')
    // Nothing about a Turn Complete card, and the answer was not re-posted.
    expect(sent).not.toContain(translationsFor('zh').turnCompleteTitle)
    expect(sent).not.toContain('the full answer')
    expect(deliver.autoSend).toHaveBeenCalledWith(plan, { chatId: 'oc_1', rootId: 'om_1' })
    await stop()
  })

  it('plans the present deliverables for the footer and auto-delivers them', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async () => 'the full answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => true),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const turnStats = {
      turnStartTime: 0, stepCount: 1, toolCallCount: 0, totalInputTokens: 1, totalOutputTokens: 2,
      totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalBilledTokens: 3, firstStepTtftMs: 10,
      totalDecodeMs: 100, totalDecodeTokens: 2, totalStepMs: 100, totalToolMs: 0, totalTurnMs: 200,
      deliverables: [{ path: 'out/report.pdf', description: 'Monthly report' }],
    }
    const flushed = vi.fn(async () => turnStats as any)
    const plan = {
      rows: [{ path: 'out/report.pdf', name: 'report.pdf', kind: 'document', size: 2048, auto: true }],
      auto: [{ path: '/work/out/report.pdf', name: 'report.pdf', sessionId: 'test-session' }],
    }
    const deliver = { plan: vi.fn(async () => plan), autoSend: vi.fn(async () => undefined) }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined,
    async () => ({ workspace: '/work' }),
    undefined, undefined, flushed, undefined, undefined,
    () => translationsFor('zh'),
    undefined,
    deliver as any)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    expect(deliver.plan).toHaveBeenCalledWith({
      sessionId: 'test-session', chatId: 'oc_1', workspace: '/work',
      files: [{ path: 'out/report.pdf', description: 'Monthly report' }],
    })
    const sent = (channel.send.mock.calls as any[]).map(call => JSON.stringify(call[1])).join(' ')
    expect(sent).toContain('交付文件')
    expect(sent).toContain('report.pdf')
    expect(sent).toContain('自动投递')
    expect(deliver.autoSend).toHaveBeenCalledWith(plan, { chatId: 'oc_1', rootId: 'om_1' })
    await stop()
  })

  it('posts a deliverable footer on the fallback reply path too', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async () => 'the full answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => false),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const flushed = vi.fn(async () => ({
      turnStartTime: 0, stepCount: 1, toolCallCount: 0, totalInputTokens: 1, totalOutputTokens: 2,
      totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalBilledTokens: 3, firstStepTtftMs: 10,
      totalDecodeMs: 100, totalDecodeTokens: 2, totalStepMs: 100, totalToolMs: 0, totalTurnMs: 200,
      deliverables: [{ path: 'out/notes.md' }],
    }) as any)
    const plan = {
      rows: [{ path: 'out/notes.md', name: 'notes.md', kind: 'other', size: 10, token: 'tok-1' }],
      auto: [],
    }
    const deliver = { plan: vi.fn(async () => plan), autoSend: vi.fn(async () => undefined) }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined,
    async () => ({ workspace: '/work' }),
    undefined, undefined, flushed, undefined, undefined,
    () => translationsFor('zh'),
    undefined,
    deliver as any)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    const sent = (channel.send.mock.calls as any[]).map(call => JSON.stringify(call[1])).join(' ')
    expect(sent).toContain('the full answer')
    expect(sent).toContain('交付文件')
    expect(sent).toContain('tok-1')
    expect(deliver.autoSend).toHaveBeenCalledOnce()
    await stop()
  })

  /**
   * TODO O3 — the produced half. A turn that wrote a chart and a report but
   * never called `present` used to leave the chat silent; with the default
   * `delivery` mode those artifacts go through the SAME plan as presented
   * files, and the footer says how many were produced.
   */
  it('folds produced artifacts into the delivery plan and reports the count', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async () => 'the full answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => true),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const flushed = vi.fn(async () => ({
      turnStartTime: 0, stepCount: 1, toolCallCount: 0, totalInputTokens: 1, totalOutputTokens: 2,
      totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalBilledTokens: 3, firstStepTtftMs: 10,
      totalDecodeMs: 100, totalDecodeTokens: 2, totalStepMs: 100, totalToolMs: 0, totalTurnMs: 200,
      deliverables: [{ path: 'out/report.pdf', description: 'Monthly report' }],
      produced: [
        // Already handed over through `present` — must not be planned twice.
        { path: '/work/out/report.pdf', kind: 'document' },
        // Written only: this is the one the artifact path adds.
        { path: 'shots/chart.png', kind: 'image' },
        // Source code is never an artifact, whatever the settings say.
        { path: 'src/index.ts', kind: 'other' },
      ],
    }) as any)
    const deliver = { plan: vi.fn(async () => ({ rows: [], auto: [] })), autoSend: vi.fn(async () => undefined) }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined,
    async () => ({ workspace: '/work' }),
    undefined, undefined, flushed, undefined, undefined,
    () => translationsFor('zh'),
    undefined,  // hydrateImages
    deliver as any,  // noteCardTopic comes next; deliver is position 15
    undefined,  // noteCardTopic
    () => 'delivery')
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    expect(deliver.plan).toHaveBeenCalledWith(expect.objectContaining({
      files: [{ path: 'out/report.pdf', description: 'Monthly report' }, { path: 'shots/chart.png' }],
    }))
    const sent = (channel.send.mock.calls as any[]).map(call => JSON.stringify(call[1])).join(' ')
    expect(sent).toContain('本回合新生成 2 个文件')
    await stop()
  })

  /**
   * `summary` announces the count and hands nothing over, so the plan must see
   * the presented files only — the switch has to be able to hold a chat back
   * from receiving files the operator never asked for.
   */
  it('keeps produced artifacts out of the plan in summary mode', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async () => 'the full answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => true),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const flushed = vi.fn(async () => ({
      turnStartTime: 0, stepCount: 1, toolCallCount: 0, totalInputTokens: 1, totalOutputTokens: 2,
      totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalBilledTokens: 3, firstStepTtftMs: 10,
      totalDecodeMs: 100, totalDecodeTokens: 2, totalStepMs: 100, totalToolMs: 0, totalTurnMs: 200,
      deliverables: [],
      produced: [{ path: 'shots/chart.png', kind: 'image' }],
    }) as any)
    const deliver = { plan: vi.fn(async () => ({ rows: [], auto: [] })), autoSend: vi.fn(async () => undefined) }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined,
    async () => ({ workspace: '/work' }),
    undefined, undefined, flushed, undefined, undefined,
    () => translationsFor('zh'),
    undefined,  // hydrateImages
    deliver as any,  // position 15
    undefined,  // noteCardTopic
    () => 'summary')
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    expect(deliver.plan).toHaveBeenCalledWith(expect.objectContaining({ files: [] }))
    const sent = (channel.send.mock.calls as any[]).map(call => JSON.stringify(call[1])).join(' ')
    expect(sent).toContain('本回合新生成 1 个文件')
    await stop()
  })

  it('registers the topic of a deliverable footer so its rows stay traceable', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async () => 'the full answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => true),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const flushed = vi.fn(async () => ({
      turnStartTime: 0, stepCount: 1, toolCallCount: 0, totalInputTokens: 1, totalOutputTokens: 2,
      totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalBilledTokens: 3, firstStepTtftMs: 10,
      totalDecodeMs: 100, totalDecodeTokens: 2, totalStepMs: 100, totalToolMs: 0, totalTurnMs: 200,
      deliverables: [{ path: 'out/notes.md' }],
    }) as any)
    const plan = {
      rows: [{ path: 'out/notes.md', name: 'notes.md', kind: 'other', size: 10, token: 'tok-1' }],
      auto: [],
    }
    const deliver = { plan: vi.fn(async () => plan), autoSend: vi.fn(async () => undefined) }
    const noteCardTopic = vi.fn()
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined,
    async () => ({ workspace: '/work' }),
    undefined, undefined, flushed, undefined, undefined,
    () => translationsFor('zh'),
    undefined,
    deliver as any,
    noteCardTopic)
    await channel.handlers.get('message')!({
      messageId: 'om_1', chatId: 'oc_1', chatType: 'group', threadId: 'th_1', rootId: 'om_root', content: 'hi',
    })
    await flushAsync()
    // The footer that carries the clickable rows is the card a later tap will
    // arrive from, so its message id must resolve back to THIS topic — never to
    // a chat-level "most recent topic" guess (关键坑 31).
    expect(noteCardTopic).toHaveBeenCalledWith('out', { threadId: 'th_1', rootId: 'om_root' })
    expect(deliver.plan).toHaveBeenCalledWith(expect.objectContaining({
      topic: { threadId: 'th_1', rootId: 'om_root' },
    }))
    await stop()
  })

  it('does not post a footer on the fallback path when the plan carries no rows', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async () => 'the full answer'),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => false),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const flushed = vi.fn(async () => ({
      turnStartTime: 0, stepCount: 1, toolCallCount: 0, totalInputTokens: 1, totalOutputTokens: 2,
      totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalBilledTokens: 3, firstStepTtftMs: 10,
      totalDecodeMs: 100, totalDecodeTokens: 2, totalStepMs: 100, totalToolMs: 0, totalTurnMs: 200,
      deliverables: [{ path: 'out/notes.md' }],
    }) as any)
    const deliver = {
      plan: vi.fn(async () => ({ rows: [], auto: [] })),
      autoSend: vi.fn(async () => undefined),
    }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger,
    undefined, undefined, undefined,
    async () => ({ workspace: '/work' }),
    undefined, undefined, flushed, undefined, undefined,
    () => translationsFor('zh'),
    undefined,
    deliver as any,
    undefined)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    // One card: the reply itself. An empty footer would be noise on every
    // fallback reply that happened to declare nothing sendable.
    expect(channel.send.mock.calls).toHaveLength(1)
    expect(deliver.autoSend).toHaveBeenCalledOnce()
    await stop()
  })

  it('skips the reaction when reactEmoji is empty', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    expect(channel.addReaction).not.toHaveBeenCalled()
    // Reply card is no longer sent separately — step cards from feishu-streaming handle it.
    await stop()
  })

  it('logs a warning but still replies when the reaction fails', async () => {
    const channel = fakeChannel()
    channel.addReaction.mockRejectedValueOnce(new Error('reaction denied'))
    const bridge = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    expect(logger.warn).toHaveBeenCalledWith('dsh-feishu: reaction failed: reaction denied')
    // Reply card is no longer sent separately — step cards from feishu-streaming handle it.
    await stop()
  })

  it('surfaces the turn failure reason instead of a bare apology', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => { throw new Error('secret stack') }), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const terminal = { error: vi.fn() }
    await startChannel({ appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open', groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed' }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, terminal)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', content: 'hi' })
    await flushAsync()
    expect(terminal.error).toHaveBeenCalledWith('dsh-feishu: message handling failed: secret stack')
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: '处理这条消息时出错：secret stack' }, { replyTo: 'om_1', replyInThread: true })
  })

  it('renders a DSH turn failure exactly the way the Web UI renders it', async () => {
    const channel = fakeChannel()
    // Same structured facts the Web UI reads off `turn/end`'s `reason.error`.
    const bridge = { reply: vi.fn(async () => { throw new TurnFailureError({ message: 'DeepSeek Messages request failed (413)', code: 'INVALID_REQUEST' }) }), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    await startChannel({ appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open', groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed' }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', content: 'hi' })
    await flushAsync()
    const payload = (channel.send as any).mock.calls.at(-1)![1] as any
    expect(payload.card.header.title.content).toBe(translationsFor('zh').turnFailedTitle)
    expect(payload.card.header.template).toBe('red')
    expect(payload.card.body.elements).toEqual([
      { tag: 'markdown', content: 'DeepSeek Messages request failed (413)' },
      { tag: 'markdown', content: '`INVALID_REQUEST`' },
    ])
    expect(channel.send).toHaveBeenCalledWith('oc_1', payload, { replyTo: 'om_1', replyInThread: true })
  })

  it('falls back to text carrying the same failure when the card is rejected', async () => {
    const channel = fakeChannel()
    // First send (the card) is refused by Feishu; the reason must still arrive.
    channel.send.mockRejectedValueOnce(new Error('invalid card json'))
    const bridge = { reply: vi.fn(async () => { throw new TurnFailureError({ message: 'boom', code: 'TRANSPORT' }) }), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    await startChannel({ appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open', groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed' }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', content: 'hi' })
    await flushAsync()
    await flushAsync()
    expect((channel.send as any).mock.calls.at(-1)![1]).toEqual({ text: '本轮运行失败：boom [TRANSPORT]' })
  })

  it('disposes conversation resources when channel disconnect fails', async () => {
    const channel = fakeChannel()
    channel.disconnect.mockRejectedValueOnce(new Error('disconnect failed'))
    const bridge = { reply: vi.fn(async () => ''), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await expect(stop()).rejects.toThrow('disconnect failed')
    expect(bridge.dispose).toHaveBeenCalledOnce()
  })

  it('logs an initial connection failure to the Harness logger and terminal without exposing the secret', async () => {
    const channel = fakeChannel()
    channel.connect.mockRejectedValueOnce(new Error('authentication failed for secret'))
    const bridge = { reply: vi.fn(async () => ''), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const terminal = { error: vi.fn() }

    await expect(startChannel({
      appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger, terminal)).rejects.toThrow('authentication failed for secret')

    expect(logger.error).toHaveBeenCalledWith('dsh-feishu: WebSocket connection failed: authentication failed for [redacted]')
    expect(terminal.error).toHaveBeenCalledWith('dsh-feishu: WebSocket connection failed: authentication failed for [redacted]')
    expect(bridge.dispose).toHaveBeenCalledOnce()
  })

  it('routes a slash command through the handler instead of the bridge', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'agent answer'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const slashCommand = vi.fn(async () => ({ kind: 'success' as const, text: 'command answer' }))
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger, undefined, slashCommand)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: '/model list' })
    expect(slashCommand).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_1', content: '/model list' }))
    expect(bridge.reply).not.toHaveBeenCalled()
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: 'command answer' }, { replyTo: 'om_1', replyInThread: false })
    await stop()
  })

  it('falls back to the bridge reply when the slash handler returns undefined', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'agent answer'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const slashCommand = vi.fn(async () => undefined)
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, logger, undefined, slashCommand)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hello world' })
    await flushAsync()
    expect(slashCommand).toHaveBeenCalledOnce()
    expect(bridge.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hello world' }),
      expect.objectContaining({ onBusy: expect.any(Function) }),
    )
    // Reply card is no longer sent separately — step cards from feishu-streaming handle it.
  })

  it('acknowledges a queued message in plain text (no card) while the agent is busy', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async (_message: any, opts?: any) => { opts?.onBusy?.('queue'); return 'agent answer' }),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => false),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'queued' })
    await flushAsync()
    // The busy notice is a plain text message, not a card.
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: expect.stringContaining('已排队') }, expect.anything())
  })

  it('does not send a second reply for a message steered into the running turn', async () => {
    const channel = fakeChannel()
    const bridge = {
      reply: vi.fn(async (_message: any, opts?: any) => { opts?.onBusy?.('steer'); return undefined }),
      dispose: vi.fn(async () => undefined),
      consumeIntermediateSent: vi.fn(() => false),
      resolveSessionIdFor: vi.fn(() => 'test-session'),
      needsOnboarding: vi.fn(async () => false),
      noteTopic: vi.fn(),
    }
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'inject' })
    await flushAsync()
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: expect.stringContaining('已插入') }, expect.anything())
    // No reply card of its own — the running turn's reply already answers it.
    expect(channel.send.mock.calls.some((call: any[]) => call[1]?.card !== undefined)).toBe(false)
  })

  it('reports a slash-command failure with the safe fallback and skips the bridge', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'agent answer'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const terminal = { error: vi.fn() }
    const slashCommand = vi.fn(async () => { throw new Error('boom') })
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, terminal, slashCommand)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: '/model' })
    expect(bridge.reply).not.toHaveBeenCalled()
    expect(terminal.error).toHaveBeenCalledWith('dsh-feishu: slash command failed: boom')
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: '命令执行出错：boom' }, { replyTo: 'om_1', replyInThread: false })
  })

  it('downloads image resources and attaches ImageBlocks to the bridge call', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'described image'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const attachments = fakeAttachments()
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined, attachments)
    await channel.handlers.get('message')!({
      messageId: 'om_2', chatId: 'oc_2', chatType: 'p2p', content: 'describe this',
      resources: [{ type: 'image', fileKey: 'img_abc' }],
    })
    await flushAsync()
    expect(channel.rawClient.im.v1.messageResource.get).toHaveBeenCalledWith({
      params: { type: 'image' },
      path: { message_id: 'om_2', file_key: 'img_abc' },
    })
    expect(attachments.saveImages).toHaveBeenCalledOnce()
    expect(bridge.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'describe this',
      imageBlocks: [expect.objectContaining({ mediaType: 'image/jpeg', bytes: 4 })],
    }), expect.objectContaining({ onBusy: expect.any(Function) }))
    // Reply card is no longer sent separately — step cards from feishu-streaming handle it.
    await stop()
  })

  it('derives image media type from the downloaded bytes, not a guessed MIME (PNG)', async () => {
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A ...
    const channel = fakeChannel(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]))
    const bridge = { reply: vi.fn(async () => 'described image'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const attachments = fakeAttachments()
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined, attachments)
    await channel.handlers.get('message')!({
      messageId: 'om_png', chatId: 'oc_png', chatType: 'p2p', content: 'describe PNG',
      resources: [{ type: 'image', fileKey: 'img_png' }],
    })
    await flushAsync()
    expect(attachments.saveImages).toHaveBeenCalledWith([expect.objectContaining({ mediaType: 'image/png' })])
    expect(bridge.reply).toHaveBeenCalledWith(expect.objectContaining({
      imageBlocks: [expect.objectContaining({ mediaType: 'image/png' })],
    }), expect.objectContaining({ onBusy: expect.any(Function) }))
    await stop()
  })

  it('rejects image-bearing messages when no attachment service is composed', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'should not happen'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await channel.handlers.get('message')!({
      messageId: 'om_3', chatId: 'oc_3', chatType: 'p2p', content: '',
      resources: [{ type: 'image', fileKey: 'img_no_store' }],
    })
    expect(channel.send).toHaveBeenCalledWith(
      'oc_3',
      { text: 'Image messages are not supported because the deployment has no attachment service composed.' },
      { replyTo: 'om_3', replyInThread: false },
    )
    expect(bridge.reply).not.toHaveBeenCalled()
  })

  it('reports image-admission failures with the safe fallback and skips the bridge', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'should not happen'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const terminal = { error: vi.fn() }
    const attachments = fakeAttachments({
      saveImage: async () => { throw new Error('storage full') },
    })
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, terminal, undefined, attachments)
    await channel.handlers.get('message')!({
      messageId: 'om_4', chatId: 'oc_4', chatType: 'p2p', content: '',
      resources: [{ type: 'image', fileKey: 'img_fail' }],
    })
    expect(terminal.error).toHaveBeenCalledWith('dsh-feishu: image admission failed: storage full')
    expect(bridge.reply).not.toHaveBeenCalled()
    expect(channel.send).toHaveBeenCalledWith('oc_4', { text: '图片处理出错：storage full' }, { replyTo: 'om_4', replyInThread: false })
  })

  it('streams files into the native attachment store and attaches durable file blocks', async () => {
    const channel = fakeChannel(Buffer.from('pdf payload'))
    const bridge: any = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const attachments = await fakeFileHost()
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined, attachments)
    await channel.handlers.get('message')!({
      messageId: 'om_file', chatId: 'oc_file', chatType: 'p2p', content: 'read this file',
      resources: [{ type: 'file', fileKey: 'file_abc', fileName: 'report.pdf' }],
    })
    await flushAsync()
    expect(channel.rawClient.im.v1.messageResource.get).toHaveBeenCalledWith({
      params: { type: 'file' },
      path: { message_id: 'om_file', file_key: 'file_abc' },
    })
    // The file is streamed into the native store (not buffered into `.feishu-inbox`).
    expect(attachments.saveFileStream).toHaveBeenCalledOnce()
    const callInput = attachments.saveFileStream.mock.calls[0]![0] as { data: AsyncIterable<Uint8Array>; name: string }
    expect(callInput.name).toBe('report.pdf')
    expect(attachments.captured).toHaveLength(1)
    expect(attachments.captured[0]!.toString()).toBe('pdf payload')
    // The durable file block is attached to the user turn with its host path.
    const replied = bridge.reply.mock.calls[0]![0] as { fileBlocks: Array<{ attachment: { name: string; bytes: number }; hostPath: string }> }
    expect(replied.fileBlocks).toHaveLength(1)
    expect(replied.fileBlocks[0]!.attachment.name).toBe('report.pdf')
    expect(replied.fileBlocks[0]!.hostPath).toContain('report.pdf')
    // No `.feishu-inbox` text injection remains.
    expect((bridge.reply.mock.calls[0]![0] as { content: string }).content).not.toContain('[文件:')
    await stop()
  })

  it('admits an inbound video resource, which the SDK normalizes as type "video"', async () => {
    const channel = fakeChannel(Buffer.from('mp4 payload'))
    const bridge: any = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const attachments = await fakeFileHost()
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined, attachments)
    await channel.handlers.get('message')!({
      messageId: 'om_video', chatId: 'oc_video', chatType: 'p2p',
      content: 'watch this <video key="file_vid" name="clip.mp4"/>',
      resources: [{ type: 'video', fileKey: 'file_vid', fileName: 'clip.mp4', durationMs: 5167 }],
    })
    await flushAsync()
    expect(channel.rawClient.im.v1.messageResource.get).toHaveBeenCalledWith({
      params: { type: 'file' },
      path: { message_id: 'om_video', file_key: 'file_vid' },
    })
    expect(attachments.saveFileStream).toHaveBeenCalledOnce()
    const replied = bridge.reply.mock.calls[0]![0] as { fileBlocks: Array<{ attachment: { name: string }; hostPath: string }> }
    expect(replied.fileBlocks).toHaveLength(1)
    expect(replied.fileBlocks[0]!.attachment.name).toBe('clip.mp4')
    expect(replied.fileBlocks[0]!.hostPath).toContain('clip.mp4')
    expect(attachments.captured[0]!.toString()).toBe('mp4 payload')
    await stop()
  })

  it('names a nameless voice resource with an .opus extension', async () => {
    const channel = fakeChannel(Buffer.from('opus payload'))
    const bridge: any = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const attachments = await fakeFileHost()
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined, attachments)
    await channel.handlers.get('message')!({
      messageId: 'om_voice', chatId: 'oc_voice', chatType: 'p2p', content: 'listen <audio key="file_voice"/>',
      resources: [{ type: 'audio', fileKey: 'file_voice' }],
    })
    await flushAsync()
    const replied = bridge.reply.mock.calls[0]![0] as { fileBlocks: Array<{ attachment: { name: string } }> }
    expect(replied.fileBlocks[0]!.attachment.name).toBe('file_voice.opus')
    await stop()
  })

  it('falls back to im.v1.file.get when a media resource is not addressable as a message file', async () => {
    // Real behaviour: `messageResource.get?type=file` answers 234003
    // "File not in msg." for a media message, while `file.get` serves the bytes.
    const channel = fakeChannel()
    ;(channel.rawClient.im.v1.messageResource.get as any).mockRejectedValueOnce(
      Object.assign(new Error('File not in msg.'), { code: 234003 }),
    )
    ;(channel.rawClient.im.v1 as any).file = { get: vi.fn(async () => Buffer.from('via file.get')) }
    const bridge: any = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false), noteTopic: vi.fn() }
    const attachments = await fakeFileHost()
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, transcriptView: 'detailed',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined, attachments)
    await channel.handlers.get('message')!({
      messageId: 'om_video2', chatId: 'oc_video2', chatType: 'p2p', content: 'watch this',
      resources: [{ type: 'video', fileKey: 'file_vid2', fileName: 'clip.mp4' }],
    })
    await flushAsync()
    expect((channel.rawClient.im.v1 as any).file.get).toHaveBeenCalledWith({ path: { file_key: 'file_vid2' } })
    expect(attachments.captured[0]!.toString()).toBe('via file.get')
    await stop()
  })
})
