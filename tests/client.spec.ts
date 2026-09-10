// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import { apply } from '../src/client/index.ts'
import { LarkSettingsSection } from '../src/client/LarkSettingsSection.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Lark settings client plugin', () => {
  it('registers an embedded Harness settings section', () => {
    let meta: Record<string, unknown> | undefined
    let component: (() => unknown) | undefined
    const ctx = {
      effect: vi.fn((callback: () => unknown) => callback()),
      locale: {
        register: vi.fn(),
        bind: vi.fn(() => (key: string) => ({ nav: 'Lark', subtitle: 'Feishu/Lark channel' })[key] ?? key),
      },
      slots: {
        inject: vi.fn((_slot: string, callback: () => unknown) => callback()),
        register: vi.fn((nextMeta: Record<string, unknown>, nextComponent: () => unknown) => {
          meta = nextMeta
          component = nextComponent
        }),
      },
    }
    apply(ctx as any)
    expect(ctx.slots.inject).toHaveBeenCalledWith('settings.action', expect.any(Function))
    expect(ctx.slots.register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'settings.action', id: 'open-document', priority: -1,
    }), expect.any(Function))
    expect(ctx.slots.inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(meta).toMatchObject({ name: 'settings.section', id: 'lark', order: 45 })
    expect(meta?.label).toBeTypeOf('function')
    expect(component).toBeTypeOf('function')
  })

  it('renders the settings section without a model catalog dependency', async () => {
    const payload = {
      revision: 1,
      settings: {
        appId: 'cli_existing', domain: 'feishu', requireMention: true, dmMode: 'open',
        groupAllowlist: [], dmAllowlist: [], reactEmoji: 'THUMBSUP',
        showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, locale: 'auto',
      },
      credential: { configured: true, source: 'file', writable: true },
      runtime: { state: 'connected' },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    let component: (() => unknown) | undefined
    const ctx = {
      effect: vi.fn((callback: () => unknown) => callback()),
      locale: { register: vi.fn(), bind: vi.fn(() => (key: string) => key) },
      slots: {
        inject: vi.fn((_slot: string, callback: () => unknown) => callback()),
        register: vi.fn((_meta: Record<string, unknown>, nextComponent: () => unknown) => { component = nextComponent }),
      },
    }

    apply(ctx as any)
    render(component!() as React.ReactElement)

    expect(await screen.findByDisplayValue('cli_existing')).toBeTruthy()
    expect(screen.getByLabelText('appSecret').getAttribute('type')).toBe('password')
  })
})

describe('LarkSettingsSection', () => {
  const payload = {
    revision: 12,
    settings: {
      appId: 'cli_existing', appSecretRef: 'DSH_LARK_APP_SECRET', domain: 'feishu', requireMention: true,
      dmMode: 'open', groupAllowlist: [], dmAllowlist: [], reactEmoji: 'THUMBSUP',
      showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, locale: 'auto' as const,
    },
    credential: { configured: true, source: 'file', writable: true },
    runtime: { state: 'connected' },
  }

  it('loads value-free settings and renders labeled controls with textual status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    render(h(LarkSettingsSection, { t: (key: string) => key }))
    expect(await screen.findByDisplayValue('cli_existing')).toBeTruthy()
    expect(screen.getByLabelText('appSecret').getAttribute('type')).toBe('password')
    expect(screen.getByLabelText('reactEmoji')).toBeTruthy()
    expect(screen.getByText('connected')).toBeTruthy()
    expect(screen.getByText('credentialConfigured')).toBeTruthy()
  })

  it('renders every display toggle and the plugin language selector', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    render(h(LarkSettingsSection, { t: (key: string) => key }))
    await screen.findByDisplayValue('cli_existing')
    for (const name of ['showReasoning', 'showToolCalls', 'showToolArgs', 'showToolResults']) {
      expect(screen.getByRole('switch', { name })).toBeTruthy()
    }
    expect((screen.getByLabelText('locale') as HTMLSelectElement).value).toBe('auto')
  })

  it('disables the tool args and result toggles while tool calls are hidden', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ...payload,
      settings: { ...payload.settings, showToolCalls: false },
    }), { status: 200 })))
    render(h(LarkSettingsSection, { t: (key: string) => key }))
    await screen.findByDisplayValue('cli_existing')
    expect((screen.getByRole('switch', { name: 'showToolArgs' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: 'showToolResults' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: 'showToolCalls' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('submits changed settings and announces success', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...payload, settings: { ...payload.settings, appId: 'cli_next' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    render(h(LarkSettingsSection, { t: (key: string) => key }))
    const appId = await screen.findByLabelText('appId')
    fireEvent.change(appId, { target: { value: 'cli_next' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const init = fetch.mock.calls[1]![1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toMatchObject({
      appId: 'cli_next', expectedRevision: 12, showReasoning: true, showToolCalls: true,
      showToolArgs: true, showToolResults: true, locale: 'auto',
    })
    expect((await screen.findByRole('status')).textContent).toContain('saved')
  })

  it('never sends the removed new-session defaults from the panel', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    render(h(LarkSettingsSection, { t: (key: string) => key }))
    await screen.findByDisplayValue('cli_existing')
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const body = JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>
    for (const key of ['provider', 'model', 'workspace', 'agentPreset', 'errorMessage']) {
      expect(body).not.toHaveProperty(key)
    }
  })

  it('preserves the loaded App ID and omits App Secret when only another setting changes', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...payload, settings: { ...payload.settings, requireMention: false } }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    render(h(LarkSettingsSection, { t: (key: string) => key }))

    await screen.findByDisplayValue('cli_existing')
    fireEvent.click(screen.getByRole('switch', { name: 'requireMention' }))
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const body = JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>
    expect(body.appId).toBe('cli_existing')
    expect(body.requireMention).toBe(false)
    expect(body).not.toHaveProperty('appSecret')
  })

  it('renders the configured credential state as an explicit status badge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    render(h(LarkSettingsSection, { t: (key: string) => key }))

    const status = await screen.findByLabelText('credentialConfigured')
    expect(status.getAttribute('data-state')).toBe('configured')
  })

  it('renders the missing credential state as an explicit status badge', async () => {
    const missing = { ...payload, credential: { configured: false, writable: true } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(missing), { status: 200 })))
    render(h(LarkSettingsSection, { t: (key: string) => key }))

    const status = await screen.findByLabelText('credentialMissing')
    expect(status.getAttribute('data-state')).toBe('missing')
  })
})
