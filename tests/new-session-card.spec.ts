import { describe, expect, it } from 'vitest'
import {
  renderNewSessionConfirmCard,
  renderNewSessionCancelledCard,
  renderWorkspaceSettledCard,
  renderPresetSettledCard,
  renderModelSettledCard,
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

describe('new-session settlement cards', () => {
  // These are what a step's PICKER is rewritten into the moment the choice is
  // made (card-supersede mode 'replace'). They must read as the decision itself:
  // a distinct title, the chosen value, and no way to act on them.
  const shapes: Array<[string, () => object]> = [
    ['workspace', () => renderWorkspaceSettledCard('/ws/bio', false, t)],
    ['workspace to create', () => renderWorkspaceSettledCard('/ws/new', true, t)],
    ['preset', () => renderPresetSettledCard('standard', t)],
    ['model', () => renderModelSettledCard('minimax-cn', 'MiniMax-M3', 'low', t)],
  ]

  it('names the decision in the header, in green', () => {
    for (const [label, build] of shapes) {
      const card = JSON.parse(JSON.stringify(build()))
      expect(card.header.template, label).toBe('green')
      expect(card.header.title.content.startsWith('✅'), label).toBe(true)
    }
    expect((JSON.parse(JSON.stringify(renderWorkspaceSettledCard('/ws/bio', false, t)))).header.title.content)
      .toBe(t.newSessionSettledWorkspaceTitle)
    expect((JSON.parse(JSON.stringify(renderPresetSettledCard('standard', t)))).header.title.content)
      .toBe(t.newSessionSettledPresetTitle)
    expect((JSON.parse(JSON.stringify(renderModelSettledCard('p', 'm', undefined, t)))).header.title.content)
      .toBe(t.newSessionSettledModelTitle)
  })

  it('shows the chosen value and says to continue below', () => {
    const workspace = JSON.stringify(renderWorkspaceSettledCard('/ws/bio', false, t))
    expect(workspace).toContain('/ws/bio')
    expect(workspace).not.toContain(t.newSessionSettledWillCreate)
    const model = JSON.stringify(renderModelSettledCard('minimax-cn', 'MiniMax-M3', 'low', t))
    expect(model).toContain('minimax-cn/MiniMax-M3')
    expect(model).toContain(t.modelSelectEffortLine('low'))
    for (const [, build] of shapes) expect(JSON.stringify(build())).toContain(t.newSessionSettledHint)
  })

  it('says the missing directory will be created with the session', () => {
    const card = JSON.stringify(renderWorkspaceSettledCard('/ws/new', true, t))
    expect(card).toContain(t.newSessionSettledWillCreate)
  })

  it('is inert: no buttons and no callback value can survive on it', () => {
    for (const [label, build] of shapes) {
      const card = JSON.stringify(build())
      expect(card, label).not.toContain('behaviors')
      expect(card, label).not.toContain('callback')
    }
  })
})
