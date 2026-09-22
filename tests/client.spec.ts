// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h, useSyncExternalStore } from 'react'
import { apply } from '../src/client/index.ts'
import {
  LARK_SETTINGS_NAMESPACE,
  type LarkCardFace,
  type LarkCardState,
  type LarkSettingsValues,
  type ProvisionState,
  type RuntimeStatus,
} from '../src/client/LarkSettingsCardController.ts'
import type { ConfigForm, ConfigFormSnapshot, CredentialInfo, RemoteResult, SettingsPathOpView } from '../src/client/config-form-types.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The translate stub keeps every assertion on the dictionary key. */
const t = (key: string): string => key

interface FormHarness {
  form: ConfigForm<LarkSettingsValues>
  mutate: ReturnType<typeof vi.fn>
  snapshot: ConfigFormSnapshot<LarkSettingsValues>
}

function createForm(overrides: Partial<LarkSettingsValues> = {}): FormHarness {
  const snapshot: ConfigFormSnapshot<LarkSettingsValues> = {
    status: 'ready',
    value: {
      appId: 'cli_existing',
      appSecretRef: 'DSH_LARK_APP_SECRET',
      domain: 'feishu',
      requireMention: true,
      dmMode: 'open',
      groupAllowlist: [],
      dmAllowlist: [],
      reactEmoji: 'THUMBSUP',
      showReasoning: true,
      showToolCalls: true,
      showToolArgs: true,
      showToolResults: true,
      locale: 'auto',
      ...overrides,
    },
    base: undefined,
    user: undefined,
    revision: 12,
    writable: true,
    mode: 'host',
  }
  const mutate = vi.fn(async () => true)
  return {
    mutate,
    snapshot,
    form: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      mutate,
      set: vi.fn(async () => true),
      unset: vi.fn(async () => true),
    },
  }
}

function createCredentials(initial: CredentialInfo = { configured: true, writable: true, source: 'file' }) {
  let info = initial
  return {
    setInfo: (next: CredentialInfo) => { info = next },
    describe: vi.fn(async (refs: readonly string[]) => ({
      ok: true as const,
      value: Object.fromEntries(refs.map(ref => [ref, info])),
    })),
    set: vi.fn(async (): Promise<RemoteResult<unknown>> => {
      info = { configured: true, writable: true, source: 'file' }
      return { ok: true, value: undefined }
    }),
    unset: vi.fn(async (): Promise<RemoteResult<unknown>> => {
      info = { configured: false, writable: true }
      return { ok: true, value: undefined }
    }),
  }
}

/** Stub the plugin's bounded channel-status route. */
function stubStatus(runtime: RuntimeStatus = { state: 'connected' }, provision: ProvisionState = { phase: 'idle' }) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
    runtime,
    provision: init?.method === 'POST' ? { phase: 'waiting', qrUrl: 'https://scan.example/verify' } : provision,
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

interface Harness {
  ctx: any
  face: () => LarkCardFace
  meta: () => Record<string, unknown> | undefined
  component: () => ((props: any) => unknown) | undefined
}

/** Mount the client plugin against fake native services and capture its page registration. */
function mount(form: FormHarness, credentials = createCredentials()): Harness {
  let meta: Record<string, unknown> | undefined
  let component: ((props: any) => unknown) | undefined
  const ctx = {
    effect: vi.fn((callback: () => unknown) => { callback() }),
    locale: { register: vi.fn(), bind: vi.fn(() => t) },
    slots: {
      inject: vi.fn((_slot: string, callback: () => unknown) => callback()),
      register: vi.fn((nextMeta: Record<string, unknown>, nextComponent: (props: any) => unknown) => {
        if (nextMeta.name === 'settings.section') {
          meta = nextMeta
          component = nextComponent
        }
        return () => {}
      }),
    },
    configForms: {
      get: vi.fn(() => form.form),
      whileServed: vi.fn((namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
        const dispose = register(new Set(namespaces))
        return () => { dispose() }
      }),
    },
    remote: { credentials, $on: vi.fn(() => () => {}) },
  }
  apply(ctx as any)
  return { ctx, meta: () => meta, component: () => component, face: () => (meta!.inject as () => LarkCardFace)() }
}

/** Bind the inject face the way the slots renderer does: `hooks` becomes a `use<Name>` hook. */
function boundProps(face: LarkCardFace) {
  const store = face.hooks.larkSettings
  const useLarkSettings = (selector: (state: LarkCardState) => unknown): unknown =>
    useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
  const { hooks, ...rest } = face
  void hooks
  return { ...rest, t, view: 'page' as const, useLarkSettings }
}

function renderPage(harness: Harness) {
  return render(h(harness.component()!, boundProps(harness.face())))
}

describe('Lark settings client plugin', () => {
  it('registers the Settings tab while the Host serves the lark-channel namespace', async () => {
    stubStatus()
    const form = createForm()
    const harness = mount(form)

    expect(harness.ctx.configForms.whileServed).toHaveBeenCalledWith(
      [LARK_SETTINGS_NAMESPACE], expect.any(Function),
    )
    expect(harness.ctx.configForms.get).toHaveBeenCalledWith(LARK_SETTINGS_NAMESPACE)
    expect(harness.meta()).toMatchObject({ name: 'settings.section', id: 'lark', order: 45 })
    expect(harness.meta()?.label).toBeTypeOf('function')
    expect(harness.meta()?.locale).toBe('dsh-feishu')
    expect(harness.component()).toBeTypeOf('function')

    const face = harness.face()
    expect(typeof face.save).toBe('function')
    expect(typeof face.removeSecret).toBe('function')
    expect(face.hooks.larkSettings.getSnapshot().form.appId).toBe('cli_existing')
  })

  it('renders the three cards with labeled controls and the credential badge', async () => {
    stubStatus()
    const harness = mount(createForm())
    renderPage(harness)

    expect(await screen.findByDisplayValue('cli_existing')).toBeTruthy()
    expect(screen.getByLabelText('appSecret').getAttribute('type')).toBe('password')
    expect(screen.getByLabelText('domain')).toBeTruthy()
    expect(screen.getByLabelText('dmMode')).toBeTruthy()
    expect(screen.getByLabelText('groupAllowlist')).toBeTruthy()
    expect(screen.getByLabelText('dmAllowlist')).toBeTruthy()
    expect(screen.getByLabelText('reactEmoji')).toBeTruthy()
    expect(await screen.findByText('connected')).toBeTruthy()
    expect((await screen.findByLabelText('credentialConfigured')).getAttribute('data-state')).toBe('configured')
  })

  it('renders every display toggle and the plugin language selector', async () => {
    stubStatus()
    const harness = mount(createForm())
    renderPage(harness)

    await screen.findByDisplayValue('cli_existing')
    for (const name of ['showReasoning', 'showToolCalls', 'showToolArgs', 'showToolResults']) {
      expect(screen.getByRole('switch', { name })).toBeTruthy()
    }
    expect((screen.getByLabelText('locale') as HTMLSelectElement).value).toBe('auto')
  })

  it('disables the tool args and result toggles while tool calls are hidden', async () => {
    stubStatus()
    const harness = mount(createForm({ showToolCalls: false }))
    renderPage(harness)

    await screen.findByDisplayValue('cli_existing')
    expect((screen.getByRole('switch', { name: 'showToolArgs' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: 'showToolResults' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: 'showToolCalls' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('renders the missing credential state as an explicit status badge', async () => {
    stubStatus()
    const harness = mount(createForm(), createCredentials({ configured: false, writable: true }))
    renderPage(harness)

    const status = await screen.findByLabelText('credentialMissing')
    expect(status.getAttribute('data-state')).toBe('missing')
  })

  it('saves every edited field in one mutate fenced on the current revision', async () => {
    stubStatus()
    const form = createForm()
    const credentials = createCredentials()
    const harness = mount(form, credentials)
    renderPage(harness)

    const appId = await screen.findByLabelText('appId')
    fireEvent.change(appId, { target: { value: 'cli_next' } })
    fireEvent.click(screen.getByRole('switch', { name: 'requireMention' }))
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => { expect(form.mutate).toHaveBeenCalledTimes(1) })
    const [ops, revision] = form.mutate.mock.calls[0] as [SettingsPathOpView[], number]
    expect(ops).toEqual([
      { op: 'set', path: ['appId'], value: 'cli_next' },
      { op: 'set', path: ['requireMention'], value: false },
    ])
    expect(revision).toBe(12)
    expect(credentials.set).not.toHaveBeenCalled()
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('saved') })
  })

  it('never writes the fields this page deliberately does not edit', async () => {
    stubStatus()
    const form = createForm()
    const harness = mount(form)
    renderPage(harness)

    await screen.findByDisplayValue('cli_existing')
    fireEvent.change(screen.getByLabelText('appId'), { target: { value: 'cli_next' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => { expect(form.mutate).toHaveBeenCalledTimes(1) })

    const [ops] = form.mutate.mock.calls[0] as [SettingsPathOpView[]]
    const paths = ops.map(op => op.path[0])
    for (const key of ['appSecret', 'appSecretRef', 'provider', 'model', 'workspace', 'agentPreset', 'errorMessage']) {
      expect(paths).not.toContain(key)
    }
  })

  it('does not write a secret the user left blank', async () => {
    stubStatus()
    const form = createForm()
    const credentials = createCredentials()
    const harness = mount(form, credentials)
    renderPage(harness)

    await screen.findByDisplayValue('cli_existing')
    fireEvent.change(screen.getByLabelText('appId'), { target: { value: 'cli_next' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => { expect(form.mutate).toHaveBeenCalledTimes(1) })

    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('writes a typed secret through the credentials domain, addressed by the configured reference', async () => {
    stubStatus()
    const form = createForm()
    const credentials = createCredentials()
    const harness = mount(form, credentials)
    renderPage(harness)

    const secret = await screen.findByLabelText('appSecret')
    fireEvent.change(secret, { target: { value: 'placeholder-not-a-real-value' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => { expect(credentials.set).toHaveBeenCalledTimes(1) })
    expect(credentials.set).toHaveBeenCalledWith('DSH_LARK_APP_SECRET', 'placeholder-not-a-real-value')
    expect(form.mutate).not.toHaveBeenCalled()
    await waitFor(() => { expect((screen.getByLabelText('appSecret') as HTMLInputElement).value).toBe('') })
  })

  it('clears the stored secret with the separate remove control', async () => {
    stubStatus()
    const form = createForm()
    const credentials = createCredentials()
    const harness = mount(form, credentials)
    renderPage(harness)

    await screen.findByLabelText('credentialConfigured')
    fireEvent.click(screen.getByRole('button', { name: 'removeSecret' }))

    await waitFor(() => { expect(credentials.unset).toHaveBeenCalledWith('DSH_LARK_APP_SECRET') })
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('removed') })
    expect(form.mutate).not.toHaveBeenCalled()
  })

  it('renders the runtime pill and the scan-to-configure QR flow', async () => {
    stubStatus({ state: 'connecting' }, { phase: 'waiting', qrUrl: 'https://scan.example/verify' })
    const harness = mount(createForm())
    renderPage(harness)

    expect(await screen.findByText('connecting')).toBeTruthy()
    expect(await screen.findByText('https://scan.example/verify')).toBeTruthy()
    expect(screen.getByText('scanHint')).toBeTruthy()
  })
})
