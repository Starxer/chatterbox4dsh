// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h, useSyncExternalStore } from 'react'
import { apply } from '../src/client/index.ts'
import {
  DELIVER_DOC_MAX_MB as CLIENT_DELIVER_DOC_MAX_MB,
  LARK_SETTINGS_NAMESPACE,
  type LarkCardFace,
  type LarkCardState,
  type LarkSettingsValues,
} from '../src/client/LarkSettingsCardController.ts'
import { DELIVER_DOC_MAX_MB as HOST_DELIVER_DOC_MAX_MB } from '../src/config.ts'
import type { LarkChannelStatusFace, LarkChannelStatusState, ProvisionPhase, ProvisionState, RuntimeStatus } from '../src/client/LarkChannelStatusController.ts'
import { LarkChannelStatusController } from '../src/client/LarkChannelStatusController.ts'
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
      transcriptView: 'detailed',
      locale: 'auto',
      cardImages: 'workspace',
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

  it('renders the work-detail level with the WebUI\'s four names', async () => {
    stubStatus()
    const harness = mount(createForm())
    renderSettings(harness)

    await screen.findByDisplayValue('cli_existing')
    const level = screen.getByLabelText('transcriptView') as HTMLSelectElement
    expect(level.value).toBe('detailed')
    // Same four values and the same order as the DSH WebUI's own setting.
    expect([...level.options].map(option => option.value)).toEqual(['compact', 'standard', 'detailed', 'verbose'])
  })

  it('writes the level it was given, including the legacy spellings', async () => {
    stubStatus()
    const form = createForm({ transcriptView: 'compact' })
    renderSettings(mount(form))

    await screen.findByDisplayValue('cli_existing')
    expect((screen.getByLabelText('transcriptView') as HTMLSelectElement).value).toBe('compact')
    // A stored `expanded` (0.1.x) reads as `detailed` in 0.2.0; the page must
    // show that, not silently render the first option.
    renderSettings(mount(createForm({ transcriptView: 'expanded' as any })))
    expect((await screen.findAllByLabelText('transcriptView'))[1] as HTMLSelectElement)
      .toHaveProperty('value', 'detailed')
  })

  it('renders every display toggle, the image mode and the plugin language selector', async () => {
    stubStatus()
    const harness = mount(createForm())
    renderSettings(harness)

    await screen.findByDisplayValue('cli_existing')
    for (const name of ['showReasoning', 'showToolCalls', 'showToolArgs', 'showToolResults']) {
      expect(screen.getByRole('switch', { name })).toBeTruthy()
    }
    expect((screen.getByLabelText('locale') as HTMLSelectElement).value).toBe('auto')
    const imageMode = screen.getByLabelText('cardImages') as HTMLSelectElement
    expect(imageMode.value).toBe('workspace')
    expect([...imageMode.options].map(option => option.value)).toEqual(['workspace', 'text', 'any'])
  })

  it('stages the image mode so a save writes it', async () => {
    stubStatus()
    const form = createForm({ cardImages: 'text' })
    const harness = mount(form)
    renderSettings(harness)

    await screen.findByDisplayValue('cli_existing')
    const select = screen.getByLabelText('cardImages') as HTMLSelectElement
    expect(select.value).toBe('text')
    fireEvent.change(select, { target: { value: 'any' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => { expect(form.mutate).toHaveBeenCalledTimes(1) })
    const [ops] = form.mutate.mock.calls[0] as [SettingsPathOpView[], number]
    expect(ops).toEqual([{ op: 'set', path: ['cardImages'], value: 'any' }])
  })

  it('stages the per-card media limit as a number, clamped to the allowed range', async () => {
    stubStatus()
    const form = createForm({ cardMediaLimit: 20 })
    const harness = mount(form)
    renderSettings(harness)

    await screen.findByDisplayValue('cli_existing')
    const input = screen.getByLabelText('cardMediaLimit') as HTMLInputElement
    expect(input.value).toBe('20')
    expect(input.getAttribute('min')).toBe('1')
    expect(input.getAttribute('max')).toBe('30')

    // A typed value is written as a NUMBER, not as the raw input text.
    fireEvent.change(input, { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => { expect(form.mutate).toHaveBeenCalledTimes(1) })
    const [ops] = form.mutate.mock.calls[0] as [SettingsPathOpView[]]
    expect(ops).toEqual([{ op: 'set', path: ['cardMediaLimit'], value: 8 }])
  })

  it('labels and explains the per-card media limit on the settings page', async () => {
    stubStatus()
    renderSettings(mount(createForm()))

    await screen.findByDisplayValue('cli_existing')
    const input = screen.getByLabelText('cardMediaLimit') as HTMLInputElement
    expect(input.type).toBe('number')
    // Labelled AND explained: the number is meaningless without saying what it
    // counts (images on one side, video/audio on the other) and that it is our
    // readability bound rather than Feishu's ceiling.
    expect(screen.getByText('cardMediaLimit')).toBeTruthy()
    const hint = screen.getByText('cardMediaLimitHint')
    expect(hint.className).toContain('dsh-feishu-toggle-hint')
  })

  it('renders the three inline size limits with their own bounds', async () => {
    stubStatus()
    renderSettings(mount(createForm()))

    await screen.findByDisplayValue('cli_existing')
    // Bounds come from the shared table, and they are Feishu's upload ceilings:
    // an image over 10 MB can never be inlined, a file over 30 MB either.
    for (const [field, min, max, value] of [
      ['cardImageMaxMb', '1', '10', '10'],
      ['cardVideoMaxMb', '1', '30', '15'],
      ['cardAudioMaxMb', '1', '30', '15'],
    ] as const) {
      const input = screen.getByLabelText(field) as HTMLInputElement
      expect(input.type).toBe('number')
      expect(input.getAttribute('min')).toBe(min)
      expect(input.getAttribute('max')).toBe(max)
      expect(input.value).toBe(value)
      expect(screen.getByText(`${field}Hint`)).toBeTruthy()
    }
  })

  it('writes the three sizes as numbers, clamped to their own bounds', async () => {
    stubStatus()
    const form = createForm()
    const harness = mount(form)
    renderSettings(harness)
    const props = settingsProps(harness)

    await screen.findByDisplayValue('cli_existing')
    fireEvent.change(screen.getByLabelText('cardVideoMaxMb'), { target: { value: '8' } })
    props.edit('cardImageMaxMb', '999')
    props.edit('cardAudioMaxMb', '')
    await props.save()

    expect(form.mutate).toHaveBeenCalledTimes(1)
    // Ops follow EDITABLE_FIELDS order (image, video, audio).
    expect(form.mutate.mock.calls[0]![0]).toEqual([
      { op: 'set', path: ['cardImageMaxMb'], value: 10 },
      { op: 'set', path: ['cardVideoMaxMb'], value: 8 },
      { op: 'set', path: ['cardAudioMaxMb'], value: 15 },
    ])
  })

  it('renders the document auto-send limit with the Host schema\'s own bounds', async () => {
    stubStatus()
    const form = createForm()
    const harness = mount(form)
    renderSettings(harness)
    const props = settingsProps(harness)

    await screen.findByDisplayValue('cli_existing')
    const input = screen.getByLabelText('deliverDocMaxMb') as HTMLInputElement
    expect(input.type).toBe('number')
    expect(input.getAttribute('min')).toBe('1')
    expect(input.getAttribute('max')).toBe('30')
    expect(input.value).toBe('30')
    expect(screen.getByText('deliverDocMaxMbHint')).toBeTruthy()
    // The page's bounds must equal the Host schema's: 30 MB is Feishu's file
    // ceiling, and a client-side range that drifted would let a save write a
    // value the Host then clamps silently.
    expect(CLIENT_DELIVER_DOC_MAX_MB).toEqual(HOST_DELIVER_DOC_MAX_MB)

    props.edit('deliverDocMaxMb', '999')
    await props.save()
    expect(form.mutate.mock.calls[0]![0]).toContainEqual({ op: 'set', path: ['deliverDocMaxMb'], value: 30 })
  })

  it('clamps a media limit that reaches the controller out of range', async () => {
    stubStatus()
    const form = createForm()
    const harness = mount(form)
    const props = settingsProps(harness)
    // A number input refuses to hand over a value above `max`, so the clamp is
    // exercised the way such a value can still arrive: staged directly (the Host
    // schema is the second line of defence).
    props.edit('cardMediaLimit', '999')
    await props.save()
    expect(form.mutate).toHaveBeenCalledTimes(1)
    expect(form.mutate.mock.calls[0]![0]).toEqual([{ op: 'set', path: ['cardMediaLimit'], value: 30 }])

    // An emptied field falls back to the default instead of writing the minimum.
    props.edit('cardMediaLimit', '')
    await props.save()
    expect(form.mutate).toHaveBeenCalledTimes(2)
    expect(form.mutate.mock.calls[1]![0]).toEqual([{ op: 'set', path: ['cardMediaLimit'], value: 12 }])
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

  // The badge used to be a boot verdict: `connected` once the WebSocket
  // handshake succeeded, forever. On 2026-10-11 that read 已连接 for eight
  // minutes while every outbound TLS handshake died (SSL alert 112), so the one
  // surface an operator would check said the channel was fine.
  it('reports a failing outbound link instead of a plain connected channel', async () => {
    stubStatus({
      state: 'connected',
      outbound: {
        verdict: 'failing',
        observed: 6,
        answered: 0,
        failures: 6,
        consecutiveFailures: 4,
        lastError: 'write EPROTO … SSL alert number 112',
      },
    })
    const harness = mount(createForm())

    renderDetail(harness, 'plugins.detail.badge', BUNDLE)
    expect(await screen.findByText('statusOutboundFailing')).toBeTruthy()
    cleanup()

    renderDetail(harness, 'plugins.detail.section', BUNDLE)
    const detail = await screen.findByText(/outboundFailures/)
    expect(detail.textContent).toContain('4')
    expect(detail.textContent).toContain('SSL alert number 112')
  })

  it('reports a dropped long connection instead of a plain connected channel', async () => {
    stubStatus({ state: 'connected', inbound: { state: 'reconnecting', reconnectAttempts: 3 } })
    const harness = mount(createForm())

    renderDetail(harness, 'plugins.detail.badge', BUNDLE)
    expect(await screen.findByText('statusInboundFailing')).toBeTruthy()
    cleanup()

    renderDetail(harness, 'plugins.detail.section', BUNDLE)
    const detail = await screen.findByText(/inboundState/)
    expect(detail.textContent).toContain('3')
  })

  it('leaves a healthy link reported as connected', async () => {
    stubStatus({
      state: 'connected',
      inbound: { state: 'connected', reconnectAttempts: 0 },
      outbound: { verdict: 'ok', observed: 12, answered: 12, failures: 0, consecutiveFailures: 0 },
    })
    const harness = mount(createForm())
    renderDetail(harness, 'plugins.detail.section', BUNDLE)

    expect(await screen.findByText('statusConnected')).toBeTruthy()
    expect(screen.queryByText(/outboundFailures/)).toBeNull()
    expect(screen.queryByText('outboundUnobserved')).toBeNull()
  })

  it('reports an unexercised link as unobserved rather than healthy', async () => {
    stubStatus({
      state: 'connected',
      inbound: { state: 'connected', reconnectAttempts: 0 },
      outbound: { verdict: 'ok', observed: 0, answered: 0, failures: 0, consecutiveFailures: 0 },
    })
    const harness = mount(createForm())
    renderDetail(harness, 'plugins.detail.section', BUNDLE)

    // The pill still carries the boot verdict; the section says what is missing.
    expect(await screen.findByText('statusConnected')).toBeTruthy()
    expect(screen.getByText('outboundUnobserved')).toBeTruthy()
  })

  it('does not let a stale outbound failure repaint a connecting channel', async () => {
    stubStatus({ state: 'connecting', outbound: { verdict: 'failing', observed: 3, answered: 0, failures: 3, consecutiveFailures: 3 } })
    const harness = mount(createForm())
    renderDetail(harness, 'plugins.detail.badge', BUNDLE)

    expect(await screen.findByText('statusConnecting')).toBeTruthy()
    expect(screen.queryByText('statusOutboundFailing')).toBeNull()
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

  it('shows a preparing hint while the QR request is still pending', async () => {
    // Regression: `waiting` without a `qrUrl` used to render NOTHING, so a
    // blocked request to open.feishu.cn looked like a dead button.
    stubStatus({ state: 'unconfigured' }, { phase: 'waiting' })
    const harness = mount(createForm())
    const mounted = renderDetail(harness, 'plugins.detail.section', BUNDLE)

    await waitFor(() => { expect(mounted.container.textContent).toContain('provisionPreparing') })
  })

  it('localizes a start timeout instead of dumping the raw diagnostic', async () => {
    stubStatus({ state: 'unconfigured' }, {
      phase: 'error',
      errorCode: 'start-timeout',
      message: 'no QR code from the Feishu authorization service within 30s',
    })
    const harness = mount(createForm())
    const mounted = renderDetail(harness, 'plugins.detail.section', BUNDLE)

    await waitFor(() => { expect(mounted.container.textContent).toContain('provisionTimeout') })
    expect(mounted.container.textContent).not.toContain('no QR code from')
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

/**
 * The status route used to be read ONCE per page mount, so an outage that
 * started while the detail page was open stayed invisible (2026-10-11). These
 * cases pin the cadence, its bound (the mounted entries), and the one callback
 * whose "fires once" guarantee used to come from stopping the poll.
 */
describe('LarkChannelStatusController polling', () => {
  /** Stub the route with a provision state the test can move between reads. */
  function stubMutableStatus(runtime: RuntimeStatus, provision: () => ProvisionState) {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      void init
      return new Response(JSON.stringify({ runtime, provision: provision() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('keeps re-reading the status while an entry is mounted, and stops when it leaves', async () => {
    vi.useFakeTimers()
    const fetch = stubMutableStatus({ state: 'connected' }, () => ({ phase: 'idle' }))
    const controller = new LarkChannelStatusController(t)
    const release = controller.face().hooks.channelStatus.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)

    const afterFirst = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch.mock.calls.length).toBeGreaterThan(afterFirst)

    release()
    const afterRelease = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch.mock.calls.length).toBe(afterRelease)
    controller.dispose()
  })

  it('polls a moving scan-to-configure run faster than an idle channel', async () => {
    vi.useFakeTimers()
    let phase: ProvisionPhase = 'waiting'
    const fetch = stubMutableStatus({ state: 'unconfigured' }, () => ({ phase }))
    const controller = new LarkChannelStatusController(t)
    const release = controller.face().hooks.channelStatus.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)

    const afterFirst = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(4_000)
    const duringRun = fetch.mock.calls.length - afterFirst
    expect(duringRun).toBe(2)

    // A finished run drops back to the slow cadence rather than staying at 2s.
    phase = 'done'
    await vi.advanceTimersByTimeAsync(2_000)
    const afterFinish = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch.mock.calls.length).toBe(afterFinish + 1)

    release()
    controller.dispose()
  })

  it('reports a finished scan-to-configure run exactly once', async () => {
    vi.useFakeTimers()
    let phase: ProvisionPhase = 'waiting'
    stubMutableStatus({ state: 'connected' }, () => ({ phase }))
    const completed = vi.fn()
    const controller = new LarkChannelStatusController(t, { onProvisionCompleted: completed })
    const release = controller.face().hooks.channelStatus.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)

    phase = 'done'
    await vi.advanceTimersByTimeAsync(2_000)
    expect(completed).toHaveBeenCalledTimes(1)

    // Every later poll keeps reading the same terminal phase: the callback
    // re-reads the credential badge, so it must not fire again.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(completed).toHaveBeenCalledTimes(1)

    release()
    controller.dispose()
  })
})
