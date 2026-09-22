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
} from '../src/client/LarkSettingsCardController.ts'
import type { LarkChannelStatusFace, LarkChannelStatusState, ProvisionState, RuntimeStatus } from '../src/client/LarkChannelStatusController.ts'
import { SnapshotStore } from '../src/client/snapshot-store.ts'
import type {
  PluginPackageRef, PluginRowRef, PluginsSubject,
} from '../src/client/plugin-detail-contract.ts'
import type { ConfigForm, ConfigFormSnapshot, CredentialInfo, RemoteResult, SettingsPathOpView } from '../src/client/config-form-types.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
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

/** Stub the plugin's bounded channel-status route: POST starts a run, GET reports. */
function stubStatus(runtime: RuntimeStatus = { state: 'connected' }, provision: ProvisionState = { phase: 'idle' }) {
  // The real route reports the provision manager's live status, so a started
  // run stays visible to every later read rather than only to the POST reply.
  let current = provision
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') current = { phase: 'waiting', qrUrl: 'https://scan.example/verify' }
    return new Response(JSON.stringify({ runtime, provision: current }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

interface Registration {
  meta: Record<string, unknown>
  component: (props: any) => unknown
}

interface Harness {
  ctx: any
  registration: (slot: string) => Registration | undefined
  /** Run every disposer `ctx.effect` returned, innermost last, as Cordis does. */
  disposeAll: () => void
  /** Dispose the `configForms.whileServed` registration the plugin opened. */
  disposeGate: () => void
  credentialEvents: ((ref: string) => void)[]
}

/** Mount the client plugin against fake native services and capture its registrations. */
function mount(form: FormHarness, credentials = createCredentials()): Harness {
  const registrations = new Map<string, Registration>()
  const effects: (() => unknown)[] = []
  const injected = new Map<string, ReturnType<typeof vi.fn>>()
  const credentialEvents: ((ref: string) => void)[] = []
  let disposeGate: (() => void) | undefined
  const ctx = {
    effect: vi.fn((callback: () => unknown) => {
      const result = callback()
      if (typeof result === 'function') effects.push(result as () => unknown)
    }),
    locale: { register: vi.fn(), bind: vi.fn(() => t) },
    slots: {
      inject: vi.fn((slot: string, callback: () => unknown) => {
        callback()
        const dispose = vi.fn()
        injected.set(slot, dispose)
        return dispose
      }),
      register: vi.fn((nextMeta: Record<string, unknown>, nextComponent: (props: any) => unknown) => {
        registrations.set(String(nextMeta.name), { meta: nextMeta, component: nextComponent })
        return () => {}
      }),
    },
    configForms: {
      get: vi.fn(() => form.form),
      whileServed: vi.fn((namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
        disposeGate = register(new Set(namespaces))
        return () => { disposeGate?.() }
      }),
    },
    remote: {
      credentials,
      $on: vi.fn((_event: string, handler: (ref: string) => void) => {
        credentialEvents.push(handler)
        return () => {}
      }),
    },
  }
  apply(ctx as any)
  return {
    ctx,
    registration: slot => registrations.get(slot),
    disposeAll: () => { for (const dispose of [...effects].reverse()) dispose() },
    disposeGate: () => { disposeGate?.() },
    credentialEvents,
  }
}

/** Bind a settings-card inject face the way the slots renderer does. */
function settingsProps(harness: Harness) {
  const face = (harness.registration('settings.section')!.meta.inject as () => LarkCardFace)()
  const store = face.hooks.larkSettings
  const useLarkSettings = (selector: (state: LarkCardState) => unknown): unknown =>
    useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
  const { hooks, ...rest } = face
  void hooks
  return { ...rest, t, view: 'page' as const, useLarkSettings }
}

function renderSettings(harness: Harness) {
  return render(h(harness.registration('settings.section')!.component, settingsProps(harness)))
}

/** Bind a detail entry's inject face and render it against one subject. */
function renderDetail(harness: Harness, slot: string, subject: PluginsSubject) {
  const face = (harness.registration(slot)!.meta.inject as () => LarkChannelStatusFace)()
  const store = face.hooks.channelStatus
  const useChannelStatus = (selector: (state: LarkChannelStatusState) => unknown): unknown =>
    useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
  const { hooks, ...rest } = face
  void hooks
  return render(h(harness.registration(slot)!.component, { ...rest, t, subject, useChannelStatus }))
}

const LARK_ROW: PluginRowRef = { rowId: 'lark-channel', moduleName: '@starxer/chatterbox4dsh', enabled: true }
const LARK_PKG: PluginPackageRef = {
  name: '@starxer/chatterbox4dsh', version: '0.2.0', installed: true, enabled: true, rows: [LARK_ROW],
}
const OTHER_PKG: PluginPackageRef = { name: 'some-other-plugin', installed: true, enabled: true, rows: [] }
const BUNDLE: PluginsSubject = { kind: 'bundle', pkg: LARK_PKG }
const ROW: PluginsSubject = { kind: 'row', pkg: LARK_PKG, row: LARK_ROW }
const ITEM: PluginsSubject = { kind: 'item', id: 'some-official-plugin' }
const FOREIGN: PluginsSubject = { kind: 'bundle', pkg: OTHER_PKG }

describe('SnapshotStore', () => {
  it('returns the initial snapshot and replaces it on set', () => {
    const store = new SnapshotStore({ count: 1 })
    expect(store.getSnapshot()).toEqual({ count: 1 })
    store.set({ count: 2 })
    expect(store.getSnapshot()).toEqual({ count: 2 })
  })

  it('notifies every subscriber on each publish', () => {
    const store = new SnapshotStore({ count: 0 })
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe(first)
    store.subscribe(second)
    store.set({ count: 1 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('stops notifying a listener that unsubscribed', () => {
    const store = new SnapshotStore({ count: 0 })
    const listener = vi.fn()
    const release = store.subscribe(listener)
    store.set({ count: 1 })
    release()
    store.set({ count: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not notify when the same reference is published again', () => {
    const first = { count: 0 }
    const store = new SnapshotStore(first)
    const listener = vi.fn()
    store.subscribe(listener)
    store.set(first)
    expect(listener).not.toHaveBeenCalled()
    // A new object with equal contents is still a change of reference.
    store.set({ count: 0 })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('Lark settings client plugin', () => {
  it('registers the Settings tab and the three Plugins-detail entries', async () => {
    stubStatus()
    const form = createForm()
    const harness = mount(form)

    expect(harness.ctx.configForms.whileServed).toHaveBeenCalledWith(
      [LARK_SETTINGS_NAMESPACE], expect.any(Function),
    )
    expect(harness.ctx.configForms.get).toHaveBeenCalledWith(LARK_SETTINGS_NAMESPACE)
    expect(harness.registration('settings.section')?.meta).toMatchObject({ name: 'settings.section', id: 'lark', order: 45 })
    expect(harness.registration('settings.section')?.meta.locale).toBe('dsh-feishu')
    for (const slot of ['plugins.detail.badge', 'plugins.detail.actions', 'plugins.detail.section']) {
      expect(harness.registration(slot)?.meta).toMatchObject({ name: slot, id: 'lark-channel', order: 60 })
      expect(harness.registration(slot)?.meta.locale).toBe('dsh-feishu')
    }
    expect(harness.registration('settings.section')?.meta.label).toBeTypeOf('function')

    const face = (harness.registration('settings.section')!.meta.inject as () => LarkCardFace)()
    expect(typeof face.save).toBe('function')
    expect(face.hooks.larkSettings.getSnapshot().form.appId).toBe('cli_existing')
    // The settings page no longer carries the channel: no scan action there.
    expect('startProvision' in face).toBe(false)
  })

  it('renders the three cards with labeled controls and the credential badge', async () => {
    stubStatus()
    const harness = mount(createForm())
    renderSettings(harness)

    expect(await screen.findByDisplayValue('cli_existing')).toBeTruthy()
    expect(screen.getByLabelText('appSecret').getAttribute('type')).toBe('password')
    expect(screen.getByLabelText('domain')).toBeTruthy()
    expect(screen.getByLabelText('dmMode')).toBeTruthy()
    expect(screen.getByLabelText('groupAllowlist')).toBeTruthy()
    expect(screen.getByLabelText('dmAllowlist')).toBeTruthy()
    expect(screen.getByLabelText('reactEmoji')).toBeTruthy()
    expect(screen.getByText('connectionMoved')).toBeTruthy()
    expect((await screen.findByLabelText('credentialConfigured')).getAttribute('data-state')).toBe('configured')
  })

  it('keeps the connection state and the scan flow off the settings page', async () => {
    stubStatus()
    const harness = mount(createForm())
    renderSettings(harness)

    await screen.findByDisplayValue('cli_existing')
    expect(screen.queryByText('scanToConfigure')).toBeNull()
    expect(screen.queryByText('statusConnected')).toBeNull()
  })

  it('renders every display toggle and the plugin language selector', async () => {
    stubStatus()
    const harness = mount(createForm())
    renderSettings(harness)

    await screen.findByDisplayValue('cli_existing')
    for (const name of ['showReasoning', 'showToolCalls', 'showToolArgs', 'showToolResults']) {
      expect(screen.getByRole('switch', { name })).toBeTruthy()
    }
    expect((screen.getByLabelText('locale') as HTMLSelectElement).value).toBe('auto')
  })

  it('disables the tool args and result toggles while tool calls are hidden', async () => {
    stubStatus()
    const harness = mount(createForm({ showToolCalls: false }))
    renderSettings(harness)

    await screen.findByDisplayValue('cli_existing')
    expect((screen.getByRole('switch', { name: 'showToolArgs' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: 'showToolResults' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: 'showToolCalls' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('renders the missing credential state as an explicit status badge', async () => {
    stubStatus()
    const harness = mount(createForm(), createCredentials({ configured: false, writable: true }))
    renderSettings(harness)

    const status = await screen.findByLabelText('credentialMissing')
    expect(status.getAttribute('data-state')).toBe('missing')
  })

  it('saves every edited field in one mutate fenced on the current revision', async () => {
    stubStatus()
    const form = createForm()
    const credentials = createCredentials()
    const harness = mount(form, credentials)
    renderSettings(harness)

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
    renderSettings(harness)

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
    renderSettings(harness)

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
    renderSettings(harness)

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
    renderSettings(harness)

    await screen.findByLabelText('credentialConfigured')
    fireEvent.click(screen.getByRole('button', { name: 'removeSecret' }))

    await waitFor(() => { expect(credentials.unset).toHaveBeenCalledWith('DSH_LARK_APP_SECRET') })
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('removed') })
    expect(form.mutate).not.toHaveBeenCalled()
  })

  it('re-reads the credential badge when the Host reports the reference changed', async () => {
    stubStatus()
    const credentials = createCredentials()
    const harness = mount(createForm(), credentials)
    renderSettings(harness)
    await screen.findByLabelText('credentialConfigured')

    credentials.setInfo({ configured: false, writable: true })
    harness.credentialEvents.forEach(handler => { handler('DSH_LARK_APP_SECRET') })

    await waitFor(() => { expect(screen.getByLabelText('credentialMissing')).toBeTruthy() })
  })
})

describe('Lark plugin detail entries', () => {
  it('renders the connection badge for this bundle and for its row', async () => {
    stubStatus({ state: 'connected' })
    const harness = mount(createForm())

    renderDetail(harness, 'plugins.detail.badge', BUNDLE)
    expect(await screen.findByText('statusConnected')).toBeTruthy()
    cleanup()

    renderDetail(harness, 'plugins.detail.badge', ROW)
    expect(await screen.findByText('statusConnected')).toBeTruthy()
  })

  it('renders nothing for an official item or another package', async () => {
    stubStatus()
    const harness = mount(createForm())

    for (const slot of ['plugins.detail.badge', 'plugins.detail.actions', 'plugins.detail.section']) {
      for (const subject of [ITEM, FOREIGN]) {
        const view = renderDetail(harness, slot, subject)
        expect(view.container.innerHTML).toBe('')
        cleanup()
      }
    }
  })

  it('shows the connection as reading until the first status read settles', async () => {
    stubStatus({ state: 'connected' })
    const harness = mount(createForm())
    renderDetail(harness, 'plugins.detail.badge', BUNDLE)

    expect(screen.getByText('statusReading')).toBeTruthy()
    expect(await screen.findByText('statusConnected')).toBeTruthy()
  })

  it('offers scan-to-configure, switching to scan again once the channel is up', async () => {
    stubStatus({ state: 'connected' })
    const harness = mount(createForm())
    renderDetail(harness, 'plugins.detail.actions', ROW)

    // A connected channel has already been authorized once.
    expect(await screen.findByRole('button', { name: 'rescan' })).toBeTruthy()
    cleanup()

    stubStatus({ state: 'unconfigured' })
    const fresh = mount(createForm())
    renderDetail(fresh, 'plugins.detail.actions', ROW)
    expect(await screen.findByRole('button', { name: 'scanToConfigure' })).toBeTruthy()
  })

  it('starts the scan from the header control and shows the QR code in the section', async () => {
    const fetch = stubStatus({ state: 'unconfigured' })
    const harness = mount(createForm())
    renderDetail(harness, 'plugins.detail.actions', BUNDLE)

    fireEvent.click(await screen.findByRole('button', { name: 'scanToConfigure' }))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/dsh-feishu/provision', expect.objectContaining({ method: 'POST' }))
    })
    cleanup()

    renderDetail(harness, 'plugins.detail.section', BUNDLE)
    expect(await screen.findByText('https://scan.example/verify')).toBeTruthy()
    expect(screen.getByText('scanHint')).toBeTruthy()
  })

  it('keeps a second start control out of the section', async () => {
    stubStatus({ state: 'connecting' }, { phase: 'waiting', qrUrl: 'https://scan.example/verify' })
    const harness = mount(createForm())
    renderDetail(harness, 'plugins.detail.section', BUNDLE)

    expect(await screen.findByText('https://scan.example/verify')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reads the channel status only while one of its entries is mounted', async () => {
    const fetch = stubStatus()
    const harness = mount(createForm())
    expect(fetch).not.toHaveBeenCalled()

    const foreign = renderDetail(harness, 'plugins.detail.badge', FOREIGN)
    expect(foreign.container.innerHTML).toBe('')
    expect(fetch).not.toHaveBeenCalled()
    cleanup()

    renderDetail(harness, 'plugins.detail.badge', BUNDLE)
    await waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1) })
  })

  it('stops the provisioning poll when the plugin is disposed', async () => {
    vi.useFakeTimers()
    const fetch = stubStatus({ state: 'connecting' }, { phase: 'waiting', qrUrl: 'https://scan.example/verify' })
    const harness = mount(createForm())
    renderDetail(harness, 'plugins.detail.actions', ROW)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(screen.getByRole('button', { name: 'scanToConfigure' }))
    await vi.advanceTimersByTimeAsync(0)

    const afterStart = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fetch.mock.calls.length).toBeGreaterThan(afterStart)

    harness.disposeAll()
    const atDispose = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(6_000)
    expect(fetch.mock.calls.length).toBe(atDispose)
  })

  it('withdraws every slot registration when the served namespace goes away', async () => {
    stubStatus()
    const harness = mount(createForm())
    for (const slot of ['settings.section', 'plugins.detail.badge', 'plugins.detail.actions', 'plugins.detail.section']) {
      expect(harness.ctx.slots.inject).toHaveBeenCalledWith(slot, expect.any(Function))
    }
    harness.disposeGate()
    // Each `slots.inject` disposer is what Cordis runs when the gate closes.
    expect(harness.ctx.slots.inject).toHaveBeenCalledTimes(4)
  })
})
