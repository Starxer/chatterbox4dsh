import { describe, expect, it, vi } from 'vitest'
import { createCardWriter, withCardSafety } from '../src/card-write.ts'

const imageKey = 'img_v3_0215q_0a59b5e6-4758-41de-95a5-a1b2c3d4'
const warnings: string[] = []
const writer = (tracked?: number) => createCardWriter({
  logger: { warn: (message: string) => warnings.push(message) },
  ...(tracked === undefined ? {} : { tracked }),
})

const card = (content: string): object => ({
  schema: '2.0',
  body: { elements: [{ tag: 'markdown', content }] },
})
const contentOf = (written: object): string =>
  ((written as any).body.elements[0] as { content: string }).content

describe('createCardWriter.write', () => {
  it('neutralizes un-renderable image references before writing', async () => {
    const seen: string[] = []
    await writer().write(card('![图](runs/a.png)'), async (payload) => {
      seen.push(contentOf(payload))
    })
    expect(seen[0]).toBe('🖼 图 · `runs/a.png`')
  })

  it('keeps a real uploaded image key', async () => {
    const seen: string[] = []
    await writer().write(card(`![图](${imageKey})`), async (payload) => {
      seen.push(contentOf(payload))
    })
    expect(seen[0]).toBe(`![图](${imageKey})`)
  })

  it('retries once with every image reference stripped when Feishu refuses the payload', async () => {
    const seen: string[] = []
    let attempt = 0
    await writer().write(card(`![图](${imageKey}) 后面还有正文`), async (payload) => {
      seen.push(contentOf(payload))
      attempt += 1
      if (attempt === 1) throw new Error('cardkit.card.update failed: code=200570 msg=card contains invalid image keys')
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(`![图](${imageKey}) 后面还有正文`)
    // Aggressive pass: the key goes too, so no image element can survive; the
    // text that came with it is still delivered.
    expect(seen[1]).toBe(`🖼 图 · \`${imageKey}\` 后面还有正文`)
  })

  it('does not retry a transport, auth or rate-limit failure', async () => {
    const write = vi.fn(async () => { throw new Error('Request failed with status code 500') })
    await expect(writer().write(card('x'), write)).rejects.toThrow('status code 500')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('throws the retry error and warns when the stripped payload is refused too', async () => {
    warnings.length = 0
    const write = vi.fn(async () => {
      throw new Error('Failed to create card content, ext=ErrCode: 200570; ErrMsg: card contains invalid image keys')
    })
    await expect(writer().write(card('x'), write)).rejects.toThrow('Failed to create card content')
    expect(write).toHaveBeenCalledTimes(2)
    expect(warnings.join('\n')).toContain('card rejected even after stripping image references')
  })

  it('does not mutate the caller´s card', async () => {
    const original = card('![图](runs/a.png)')
    await writer().write(original, async () => undefined)
    expect(contentOf(original)).toBe('![图](runs/a.png)')
  })
})

describe('createCardWriter.nextSequence', () => {
  it('keeps a monotonic sequence per card even when a caller repeats a number', () => {
    const w = writer()
    expect(w.nextSequence('c1', 1)).toBe(1)
    expect(w.nextSequence('c1', 2)).toBe(2)
    // A retry repeats the caller's number: the floor must move past it.
    expect(w.nextSequence('c1', 2)).toBe(3)
    // The caller's own next write skips a number rather than colliding.
    expect(w.nextSequence('c1', 3)).toBe(4)
    // A different card instance has its own counter.
    expect(w.nextSequence('c2', 1)).toBe(1)
  })

  it('bounds its bookkeeping', () => {
    const w = writer(2)
    expect(w.nextSequence('c1', 1)).toBe(1)
    expect(w.nextSequence('c2', 1)).toBe(1)
    expect(w.nextSequence('c3', 1)).toBe(1)
    // c1 was evicted, so its floor starts over instead of growing forever.
    expect(w.nextSequence('c1', 1)).toBe(1)
  })
})

describe('createCardWriter.noteCardMessage / messageIdFor', () => {
  it('remembers which message renders a card instance', () => {
    const w = writer()
    w.noteCardMessage('c1', 'om_1')
    expect(w.messageIdFor('c1')).toBe('om_1')
    expect(w.messageIdFor('c2')).toBeUndefined()
  })

  it('ignores an empty message id and bounds the map', () => {
    const w = writer(1)
    w.noteCardMessage('c1', undefined)
    w.noteCardMessage('c1', '')
    expect(w.messageIdFor('c1')).toBeUndefined()
    w.noteCardMessage('c1', 'om_1')
    w.noteCardMessage('c2', 'om_2')
    expect(w.messageIdFor('c1')).toBeUndefined()
    expect(w.messageIdFor('c2')).toBe('om_2')
  })
})

describe('withCardSafety', () => {
  const channel = (send: (to: string, input: any, opts?: any) => Promise<{ messageId?: string }>) => ({
    send,
    rawClient: { marker: true },
    updateCard: async () => undefined,
    aFlag: 42,
  })

  it('neutralizes and retries a card sent straight through the channel', async () => {
    const seen: string[] = []
    let attempt = 0
    const wrapped = withCardSafety(channel(async (_to, input) => {
      seen.push(contentOf(input.card))
      attempt += 1
      if (attempt === 1) throw new Error('ErrCode: 200570; ErrMsg: card contains invalid image keys')
      return { messageId: 'om_1' }
    }), writer())

    await expect(wrapped.send('oc_1', { card: card(`![图](${imageKey}) 正文`) })).resolves.toEqual({ messageId: 'om_1' })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(`🖼 图 · \`${imageKey}\` 正文`)
  })

  it('passes text sends and every other member through untouched', async () => {
    const calls: unknown[] = []
    const base = channel(async (to, input, opts) => { calls.push([to, input, opts]); return { messageId: 'om_2' } })
    const wrapped = withCardSafety(base, writer())
    await expect(wrapped.send('oc_1', { text: 'hi' })).resolves.toEqual({ messageId: 'om_2' })
    expect(calls).toEqual([['oc_1', { text: 'hi' }, undefined]])
    expect(wrapped.rawClient).toBe(base.rawClient)
    expect(wrapped.aFlag).toBe(42)
    await expect(wrapped.updateCard()).resolves.toBeUndefined()
  })
})
