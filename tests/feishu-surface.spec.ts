import { describe, expect, it } from 'vitest'
import {
  FEISHU_SURFACE_NOTICE,
  FEISHU_SURFACE_SECTION,
  feishuSurfaceText,
  installFeishuSurfacePrompt,
} from '../src/feishu-surface.ts'

interface Registered {
  name: string
  order: number
  text: (assembly: unknown) => string
}

interface Harness {
  ctx: Parameters<typeof installFeishuSurfacePrompt>[0]
  sections: Registered[]
  services: string[][]
  disposeCalls: number
  /**
   * Run one prompt assembly for a session id (`undefined` mimics a diagnostic
   * assembly with no agent).
   */
  assemble: (sessionId: string | undefined) => string
}

function buildHost(): Harness {
  const sections: Registered[] = []
  const services: string[][] = []
  let disposeCalls = 0
  const ctx = {
    inject: (requested: string[], callback: (scope: unknown) => void) => {
      services.push(requested)
      callback({
        systemPrompt: {
          section: (input: Registered) => {
            sections.push(input)
            return () => undefined
          },
          // The registry owns placement order; the test only checks that it was
          // asked for the surface slot rather than a hardcoded number.
          getSectionOrder: (name: string) => (name === 'WEB_SURFACE' ? 10100 : 0),
        },
      })
      return { dispose: () => { disposeCalls += 1; return Promise.resolve() } }
    },
  } as unknown as Parameters<typeof installFeishuSurfacePrompt>[0]
  return {
    ctx,
    sections,
    services,
    get disposeCalls() { return disposeCalls },
    assemble: sessionId => {
      const section = sections[0]
      if (section === undefined) throw new Error('no section registered')
      return section.text(sessionId === undefined ? {} : { agent: { id: sessionId } })
    },
  }
}

describe('the Feishu surface prompt section', () => {
  it('registers one section in the surface slot of the prompt registry', () => {
    const host = buildHost()
    installFeishuSurfacePrompt(host.ctx, { isBound: () => true, enabled: () => true })
    expect(host.services).toEqual([['systemPrompt']])
    expect(host.sections.map(section => section.name)).toEqual([FEISHU_SURFACE_SECTION])
    expect(host.sections[0]?.order).toBe(10100)
  })

  it('states the Feishu facts for a bound session', () => {
    const host = buildHost()
    installFeishuSurfacePrompt(host.ctx, { isBound: id => id === 'bound', enabled: () => true })
    expect(host.assemble('bound')).toBe(FEISHU_SURFACE_NOTICE)
    expect(FEISHU_SURFACE_NOTICE).toContain('Feishu chat')
    expect(FEISHU_SURFACE_NOTICE).toContain('feishu_send_file')
    // The Web bundle's promise that does not exist here must not be repeated.
    expect(FEISHU_SURFACE_NOTICE).not.toContain('native-open')
  })

  it('contributes nothing for every other session', () => {
    const host = buildHost()
    installFeishuSurfacePrompt(host.ctx, { isBound: id => id === 'bound', enabled: () => true })
    expect(host.assemble('unbound')).toBe('')
    expect(host.assemble(undefined)).toBe('')
  })

  it('contributes nothing when the setting is off', () => {
    const host = buildHost()
    installFeishuSurfacePrompt(host.ctx, { isBound: () => true, enabled: () => false })
    expect(host.assemble('bound')).toBe('')
  })

  it('reads the setting live instead of capturing it', () => {
    const host = buildHost()
    let enabled = false
    installFeishuSurfacePrompt(host.ctx, { isBound: () => true, enabled: () => enabled })
    expect(host.assemble('bound')).toBe('')
    enabled = true
    expect(host.assemble('bound')).toBe(FEISHU_SURFACE_NOTICE)
  })

  it('disposes once and tolerates a second call', () => {
    const host = buildHost()
    const dispose = installFeishuSurfacePrompt(host.ctx, { isBound: () => true, enabled: () => true })
    dispose()
    dispose()
    expect(host.disposeCalls).toBe(1)
  })
})

describe('feishuSurfaceText', () => {
  it('is the notice only when bound and enabled', () => {
    expect(feishuSurfaceText(true, true)).toBe(FEISHU_SURFACE_NOTICE)
    expect(feishuSurfaceText(true, false)).toBe('')
    expect(feishuSurfaceText(false, true)).toBe('')
  })
})
