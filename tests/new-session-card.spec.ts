import { describe, expect, it } from 'vitest'
import {
  renderNewSessionConfirmCard,
  renderNewSessionCancelledCard,
  NEW_SESSION_CONFIRM_ACTION,
  NEW_SESSION_CANCEL_ACTION,
} from '../src/new-session-card.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

describe('new-session confirmation card', () => {
  it('lists every setting that will be applied to the new session', () => {
    const card = renderNewSessionConfirmCard({
      workspace: '/ws/bio',
      agentPreset: 'standard',
      provider: 'minimax-cn',
      model: 'MiniMax-M3',
      reasoningEffort: 'low' as never,
    }, t)
    const text = JSON.stringify(card)
    expect(text).toContain('/ws/bio')
    expect(text).toContain('standard')
    expect(text).toContain('minimax-cn/MiniMax-M3')
    expect(text).toContain('low')
    expect(JSON.parse(text).header.template).toBe('blue')
  })

  it('carries both callbacks as behaviors so a CardKit instance can fire them', () => {
    const parsed = JSON.parse(JSON.stringify(renderNewSessionConfirmCard({ provider: 'p', model: 'm' }, t)))
    const buttons = parsed.body.elements.filter((e: any) => e.tag === 'button')
    expect(buttons).toHaveLength(2)
    expect(buttons.map((b: any) => b.behaviors[0].value.kind)).toEqual([
      NEW_SESSION_CONFIRM_ACTION,
      NEW_SESSION_CANCEL_ACTION,
    ])
    // The CardKit path drops a top-level `value`, so it must not be relied on.
    for (const button of buttons) expect(button.value).toBeUndefined()
  })

  it('says so when neither a workspace nor a preset was chosen', () => {
    const text = JSON.stringify(renderNewSessionConfirmCard({ provider: 'p', model: 'm' }, t))
    expect(text).toContain(t.newSessionConfirmDefaults)
  })

  it('renders a button-less cancelled card in the active locale', () => {
    const text = JSON.stringify(renderNewSessionCancelledCard(t))
    expect(text).toContain(t.newSessionCancelledTitle)
    expect(text).toContain(t.newSessionCancelledBody)
    expect(text).not.toContain('callback')
    expect(text).not.toContain('behaviors')
  })
})
