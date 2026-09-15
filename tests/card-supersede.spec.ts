import { describe, expect, it, vi } from 'vitest'
import { createCardSuperseder, renderStaleCard, renderSupersededCard } from '../src/card-supersede.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

function logger() {
  return { warn: vi.fn() }
}

/** A posted card payload shaped like the onboarding/display cards. */
function pickerCard(): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📁 选择工作区' }, template: 'turquoise' },
    body: {
      elements: [
        { tag: 'markdown', content: '当前工作区：`/ws-1`' },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '使用' },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { kind: 'pick-workspace', value: '/ws-2' } }],
        },
      ],
    },
  }
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

  it('keeps the card content and only strips the callbacks when retiring', () => {
    const retired = JSON.stringify(renderStaleCard(pickerCard(), t))
    // The record survives: original title, body text and button label.
    expect(retired).toContain('选择工作区')
    expect(retired).toContain('/ws-1')
    expect(retired).toContain('使用')
    // ...but nothing can call back any more, and the header turns grey.
    expect(retired).not.toContain('behaviors')
    expect(retired).not.toContain('pick-workspace')
    expect(JSON.parse(retired).header.template).toBe('grey')
    expect(retired).toContain(t.cardStaleNote)
  })

  it('does not mutate the card it was given', () => {
    const original = pickerCard()
    const before = JSON.stringify(original)
    renderStaleCard(original, t)
    expect(JSON.stringify(original)).toBe(before)
  })

  it('repaints the noted card instance with a monotonic sequence', async () => {
    const updateCardInstance = vi.fn(async () => undefined)
    const sequenceByCard = new Map<string, number>([['card-1', 2]])
    const superseder = createCardSuperseder({ channel: { updateCardInstance }, logger: logger(), getTranslations: () => t, sequenceByCard })
    superseder.note('oc_1', { cardId: 'card-1', messageId: 'm-1', card: pickerCard() })
    await superseder.supersedePrevious('oc_1')
    expect(updateCardInstance).toHaveBeenCalledWith('card-1', expect.any(Object), 3)
    // The repaint carries the original content, not a bare notice.
    const painted = JSON.stringify((updateCardInstance.mock.calls[0] as unknown[])[1])
    expect(painted).toContain('选择工作区')
    expect(sequenceByCard.get('card-1')).toBe(3)
    // The note is consumed: a second call is a no-op.
    await superseder.supersedePrevious('oc_1')
    expect(updateCardInstance).toHaveBeenCalledTimes(1)
  })

  it('falls back to the generic notice when the payload was not handed over', async () => {
    const updateCardInstance = vi.fn(async () => undefined)
    const superseder = createCardSuperseder({ channel: { updateCardInstance }, logger: logger(), getTranslations: () => t, sequenceByCard: new Map() })
    superseder.note('oc_1', { cardId: 'card-1', messageId: 'm-1' })
    await superseder.supersedePrevious('oc_1')
    const painted = JSON.stringify((updateCardInstance.mock.calls[0] as unknown[])[1])
    expect(painted).toContain(t.cardSupersededTitle)
    expect(painted).toContain(t.cardSupersededBody)
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

  it("mode 'notice' drops the content even when the payload is available", async () => {
    // Wizard steps that merely carry the flow forward do not deserve a record.
    const updateCardInstance = vi.fn(async () => undefined)
    const superseder = createCardSuperseder({ channel: { updateCardInstance }, logger: logger(), getTranslations: () => t, sequenceByCard: new Map() })
    superseder.note('oc_1', { cardId: 'card-1', messageId: 'm-1', card: pickerCard() })
    await superseder.supersedePrevious('oc_1', { mode: 'notice' })
    const painted = JSON.stringify((updateCardInstance.mock.calls[0] as unknown[])[1])
    expect(painted).toContain(t.cardSupersededTitle)
    expect(painted).not.toContain('选择工作区')
    expect(painted).not.toContain('behaviors')
  })

  it('a settled decision carries the chosen value instead of the stale note', async () => {
    const updateCardInstance = vi.fn(async () => undefined)
    const superseder = createCardSuperseder({ channel: { updateCardInstance }, logger: logger(), getTranslations: () => t, sequenceByCard: new Map() })
    superseder.note('oc_1', { cardId: 'card-1', messageId: 'm-1', card: pickerCard() })
    await superseder.supersedePrevious('oc_1', { mode: 'keep', note: t.cardSettledNote('/ws-2') })
    const painted = JSON.stringify((updateCardInstance.mock.calls[0] as unknown[])[1])
    expect(painted).toContain(t.cardSettledNote('/ws-2'))
    expect(painted).not.toContain(t.cardStaleNote)
    // Content kept, callbacks gone: readable but frozen.
    expect(painted).toContain('选择工作区')
    expect(painted).not.toContain('behaviors')
  })

  it('collapses a navigation card to the notice when nothing settled on it', async () => {
    // A folder-browser page is walked through, not decided on: keep the
    // payload out of the chat even though the ref still carries it.
    const updateCardInstance = vi.fn(async () => undefined)
    const superseder = createCardSuperseder({ channel: { updateCardInstance }, logger: logger(), getTranslations: () => t, sequenceByCard: new Map() })
    superseder.note('oc_1', { cardId: 'card-1', messageId: 'm-1', card: pickerCard(), navigation: true })
    await superseder.supersedePrevious('oc_1')
    const painted = JSON.stringify((updateCardInstance.mock.calls[0] as unknown[])[1])
    expect(painted).toContain(t.cardSupersededTitle)
    expect(painted).not.toContain('选择工作区')
  })

  it('still freezes a navigation card the operator settled on', async () => {
    // Regression: the browser page IS the decision card once the operator taps
    // "use this directory". An explicit keep must win over the navigation
    // default, otherwise the chosen path is never recorded on screen.
    const updateCardInstance = vi.fn(async () => undefined)
    const superseder = createCardSuperseder({ channel: { updateCardInstance }, logger: logger(), getTranslations: () => t, sequenceByCard: new Map() })
    superseder.note('oc_1', { cardId: 'card-1', messageId: 'm-1', card: pickerCard(), navigation: true })
    await superseder.supersedePrevious('oc_1', { mode: 'keep', note: t.cardSettledNote('/ws-2') })
    const painted = JSON.stringify((updateCardInstance.mock.calls[0] as unknown[])[1])
    expect(painted).toContain(t.cardSettledNote('/ws-2'))
    expect(painted).toContain('选择工作区')
    expect(painted).not.toContain('behaviors')
  })
})
