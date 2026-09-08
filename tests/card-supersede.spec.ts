import { describe, expect, it, vi } from 'vitest'
import { createCardSuperseder, renderSupersededCard } from '../src/card-supersede.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

function logger() {
  return { warn: vi.fn() }
}

describe('card-supersede', () => {
  it('renders a button-less notice in the active locale', () => {
    const card = JSON.stringify(renderSupersededCard(t))
    expect(card).toContain(t.cardSupersededTitle)
    expect(card).toContain(t.cardSupersededBody)
    expect(card).not.toContain('callback')
    const en = JSON.stringify(renderSupersededCard(translationsFor('en')))
    expect(en).toContain('stale')
  })

  it('repaints the noted card instance with a monotonic sequence', async () => {
    const updateCardInstance = vi.fn(async () => undefined)
    const sequenceByCard = new Map<string, number>([['card-1', 2]])
    const superseder = createCardSuperseder({ channel: { updateCardInstance }, logger: logger(), getTranslations: () => t, sequenceByCard })
    superseder.note('oc_1', { cardId: 'card-1', messageId: 'm-1' })
    await superseder.supersedePrevious('oc_1')
    expect(updateCardInstance).toHaveBeenCalledWith('card-1', expect.any(Object), 3)
    expect(sequenceByCard.get('card-1')).toBe(3)
    // The note is consumed: a second call is a no-op.
    await superseder.supersedePrevious('oc_1')
    expect(updateCardInstance).toHaveBeenCalledTimes(1)
  })

  it('falls back to message patch when card instances are unavailable', async () => {
    const updateCard = vi.fn(async () => undefined)
    const superseder = createCardSuperseder({ channel: { updateCard }, logger: logger(), getTranslations: () => t, sequenceByCard: new Map() })
    superseder.note('oc_1', { cardId: 'card-1', messageId: 'm-1' })
    await superseder.supersedePrevious('oc_1')
    expect(updateCard).toHaveBeenCalledWith('m-1', expect.any(Object))
  })

  it('logs instead of throwing when the repaint fails', async () => {
    const warn = vi.fn()
    const superseder = createCardSuperseder({
      channel: { updateCardInstance: vi.fn(async () => { throw new Error('expired') }) },
      logger: { warn },
      getTranslations: () => t,
      sequenceByCard: new Map(),
    })
    superseder.note('oc_1', { cardId: 'card-1' })
    await expect(superseder.supersedePrevious('oc_1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expired'))
  })

  it('forget drops the note without repainting', async () => {
    const updateCardInstance = vi.fn(async () => undefined)
    const superseder = createCardSuperseder({ channel: { updateCardInstance }, logger: logger(), getTranslations: () => t, sequenceByCard: new Map() })
    superseder.note('oc_1', { cardId: 'card-1' })
    superseder.forget('oc_1')
    await superseder.supersedePrevious('oc_1')
    expect(updateCardInstance).not.toHaveBeenCalled()
  })
})
