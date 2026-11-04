import { describe, expect, it, vi } from 'vitest'
import { availablePermissionModes, renderPermissionAutoConfirmCard, renderPermissionCard, startFeishuPermission, PERMISSION_LABELS, SANDBOX_MODES } from '../src/feishu-permission.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('en')

function buttonsOf(card: any): any[] {
  return card.body.elements.filter((el: any) => el.tag === 'button')
}

describe('renderPermissionCard', () => {
  it('shows the current mode and marks the active button disabled', () => {
    const card = renderPermissionCard('workspace-write', t) as any
    const markdown = card.body.elements.filter((el: any) => el.tag === 'markdown').map((el: any) => el.content).join('\n')
    expect(markdown).toContain('**Access mode:** `workspace-write` Workspace Write')
    const buttons = buttonsOf(card)
    expect(buttons).toHaveLength(3)
    const active = buttons.find((b: any) => textOf(b).startsWith('✓ '))
    expect(textOf(active)).toBe('✓ Workspace Write')
    expect(active.disabled).toBe(true)
  })

  it('keeps every selectable button clearly clickable (no gray Read Only lookalike)', () => {
    // Read Only and Workspace Write share the blue primary so neither looks
    // like the grayed-out disabled current-mode button; only Full access is
    // red (a danger signal). No mode is `default` (gray) anymore.
    const card = renderPermissionCard('workspace-write', t) as any
    const buttons = buttonsOf(card)
    const readOnly = buttons.find((b: any) => textOf(b).includes('Read Only'))
    const full = buttons.find((b: any) => textOf(b).includes('Full access'))
    expect(readOnly.type).toBe('primary')
    expect(full.type).toBe('danger')
    // Only the active (current) button may be disabled.
    expect(buttons.filter((b: any) => b.disabled === true)).toHaveLength(1)
  })
})

describe('startFeishuPermission', () => {
  it('sends the card on open and switches on button click', async () => {
    const append = vi.fn()
    const session = { append }
    const send = vi.fn(async () => ({ messageId: 'om_card' }))
    const updateCard = vi.fn(async () => undefined)
    let actionHandler: ((evt: any) => unknown) | undefined
    const resolve = vi.fn(({ session }: any) => ({ mode: (session as any).events?.first ?? 'workspace-write' }))
    const sandbox = { resolve }
    const handle = startFeishuPermission({
      channel: { send, updateCard, onCardAction: (h: any) => { actionHandler = h; return () => undefined } },
      sandbox,
      sessionGetter: () => session,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    const mid = await handle.open({ chatId: 'oc_1', chatType: 'p2p' }, 'session-1')
    expect(mid).toBe('om_card')
    expect(send).toHaveBeenCalledTimes(1)
    // Click the "Full access" button.
    const card = ((send.mock.calls as any)[0][1] as any).card
    const full = buttonsOf(card).find((b: any) => textOf(b).includes('Full access'))
    await actionHandler!({ messageId: 'om_card', action: { value: full.value } })
    expect(append).toHaveBeenCalledWith('sandbox/mode', { mode: 'danger-full-access' })
    expect(updateCard).toHaveBeenCalledTimes(1)

    handle.stop()
  })

  it('switches through the DSH permissionPresets.set() write path when available', async () => {
    const set = vi.fn()
    const current = vi.fn(() => 'danger-full-access')
    const session = { append: vi.fn() }
    const send = vi.fn(async () => ({ messageId: 'om_card' }))
    const updateCard = vi.fn(async () => undefined)
    let actionHandler: ((evt: any) => unknown) | undefined
    const handle = startFeishuPermission({
      channel: {
        send,
        updateCard,
        onCardAction: (h: any) => { actionHandler = h; return () => undefined },
      },
      // sandbox left undefined: the preset service owns both the read and write.
      permissionPresets: { set, current },
      sessionGetter: () => session,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    const mid = await handle.open({ chatId: 'oc_1', chatType: 'p2p' }, 'session-1')
    expect(mid).toBe('om_card')
    // Opening reads the mode from the preset service, not from sandbox.
    expect(current).toHaveBeenCalledWith(session)
    const card = ((send.mock.calls as any)[0][1] as any).card
    const full = buttonsOf(card).find((b: any) => textOf(b).includes('Full access'))
    await actionHandler!({ messageId: 'om_card', action: { value: full.value } })
    // The full bundle is written through set(), never a bare sandbox/mode append.
    expect(set).toHaveBeenCalledWith(session, 'danger-full-access')
    expect(session.append).not.toHaveBeenCalled()
    expect(updateCard).toHaveBeenCalledTimes(1)

    handle.stop()
  })

  it('falls back to a bare sandbox/mode append when the preset service is absent', async () => {
    const append = vi.fn()
    const session = { append }
    const send = vi.fn(async () => ({ messageId: 'om_card' }))
    const updateCard = vi.fn(async () => undefined)
    let actionHandler: ((evt: any) => unknown) | undefined
    const handle = startFeishuPermission({
      channel: {
        send,
        updateCard,
        onCardAction: (h: any) => { actionHandler = h; return () => undefined },
      },
      sandbox: { resolve: () => ({ mode: 'workspace-write' }) },
      sessionGetter: () => session,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' }, 'session-1')
    const card = ((send.mock.calls as any)[0][1] as any).card
    const full = buttonsOf(card).find((b: any) => textOf(b).includes('Full access'))
    await actionHandler!({ messageId: 'om_card', action: { value: full.value } })
    expect(append).toHaveBeenCalledWith('sandbox/mode', { mode: 'danger-full-access' })
    handle.stop()
  })

  it('ignores unrelated card actions and stale cards', async () => {
    const append = vi.fn()
    const session = { append }
    let actionHandler: ((evt: any) => unknown) | undefined
    const handle = startFeishuPermission({
      channel: {
        send: vi.fn(async () => ({ messageId: 'om_card' })),
        updateCard: vi.fn(async () => undefined),
        onCardAction: (h: any) => { actionHandler = h; return () => undefined },
      },
      sandbox: { resolve: () => ({ mode: 'workspace-write' }) },
      sessionGetter: () => session,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    // Unrelated card (no p:'permission') must not switch.
    await actionHandler!({ messageId: 'om_card', action: { value: JSON.stringify({ p: 'other', mode: 'x' }) } })
    // Unknown card id must not switch.
    await actionHandler!({ messageId: 'om_unknown', action: { value: JSON.stringify({ p: 'permission', mode: 'read-only' }) } })
    expect(append).not.toHaveBeenCalled()
    handle.stop()
  })

  // 2026-09-14 outage: DSH's persistent-shell fence refuses a sandbox-mode
  // change while a PTY owned by the session is live. The throw used to escape
  // this `async` handler as an unhandled rejection, which DSH turns into
  // `fatal load failure` + exit(1). The click must now stay contained, keep
  // the card alive, and say why nothing changed.
  const busyShellRefusal = 'cannot change sandbox mode from "workspace-write" to "danger-full-access" while persistent terminal sessions are open or being created; wait for creation to settle and close them first'

  async function clickFullAccessWith(permissionPresets: any, sandbox?: any) {
    const session = { append: vi.fn() }
    const send = vi.fn(async () => ({ messageId: 'om_card' }))
    const updateCard = vi.fn(async () => undefined)
    let actionHandler: ((evt: any) => unknown) | undefined
    const handle = startFeishuPermission({
      channel: { send, updateCard, onCardAction: (h: any) => { actionHandler = h; return () => undefined } },
      ...(sandbox !== undefined ? { sandbox } : {}),
      ...(permissionPresets !== undefined ? { permissionPresets } : {}),
      sessionGetter: () => session,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' }, 'session-1')
    const card = ((send.mock.calls as any)[0][1] as any).card
    const full = buttonsOf(card).find((b: any) => textOf(b).includes('Full access'))
    // Must resolve, never reject: an escaping rejection is what killed dsh.
    await expect(actionHandler!({ messageId: 'om_card', action: { value: full.value } })).resolves.toBeUndefined()
    handle.stop()
    return { updateCard, session }
  }

  it('reports the DSH persistent-shell refusal on the card instead of throwing', async () => {
    const set = vi.fn(() => { throw new Error(busyShellRefusal) })
    const { updateCard, session } = await clickFullAccessWith({ set, current: () => 'workspace-write' })
    expect(set).toHaveBeenCalledWith(session, 'danger-full-access')
    expect(session.append).not.toHaveBeenCalled()
    expect(updateCard).toHaveBeenCalledTimes(1)
    const rendered = JSON.stringify((updateCard.mock.calls[0] as any)[1])
    // The card keeps its buttons (the state did not change) and explains why.
    expect(rendered).toContain('Switch not applied')
    expect(rendered).toContain('persistent terminal sessions are open')
    expect(rendered).toContain('preset without a persistent shell')
    expect(rendered).toContain('"disabled":true')
  })

  it('reports a refusal without the persistent-shell hint when that is not the cause', async () => {
    const set = vi.fn(() => { throw new Error('permission: unknown preset "danger-full-access"') })
    const { updateCard } = await clickFullAccessWith({ set, current: () => 'workspace-write' })
    const rendered = JSON.stringify((updateCard.mock.calls[0] as any)[1])
    expect(rendered).toContain('Switch not applied')
    expect(rendered).not.toContain('preset without a persistent shell')
  })

  it('still repaints the card when reading the mode back fails', async () => {
    const set = vi.fn()
    const current = vi.fn(() => { throw new Error('permissions projection is not registered') })
    const { updateCard } = await clickFullAccessWith(
      { set, current },
      { resolve: () => ({ mode: 'workspace-write' }) },
    )
    expect(set).toHaveBeenCalled()
    expect(updateCard).toHaveBeenCalledTimes(1)
    expect(JSON.stringify((updateCard.mock.calls[0] as any)[1])).toContain('Workspace Write')
  })
})

function textOf(button: any): string {
  return button?.text?.content ?? ''
}

// Keep SANDBOX_MODES / PERMISSION_LABELS referenced so tree-shaking keeps the
// alignment with the plugin's imported symbols obvious in this spec.
expect(SANDBOX_MODES).toContain('danger-full-access')
expect(PERMISSION_LABELS['danger-full-access']).toBe('Full access')

describe('catalog-driven presets (Auto review)', () => {
  const withAuto = {
    options: [
      { value: 'read-only', name: 'read-only' },
      { value: 'workspace-write', name: 'workspace-write' },
      { value: 'danger-full-access', name: 'danger-full-access' },
      { value: 'auto', name: 'auto' },
    ],
  }

  it('falls back to the shipped three presets without a catalog', () => {
    expect(availablePermissionModes(undefined)).toEqual([...SANDBOX_MODES])
    expect(availablePermissionModes({})).toEqual([...SANDBOX_MODES])
  })

  it('renders the catalog order, so a live auto integration adds one entry', () => {
    const modes = availablePermissionModes({ catalog: () => withAuto })
    expect(modes).toEqual(['read-only', 'workspace-write', 'danger-full-access', 'auto'])
  })

  it('treats a throwing or empty catalog as "the three shipped presets"', () => {
    expect(availablePermissionModes({ catalog: () => { throw new Error('no projection') } })).toEqual([...SANDBOX_MODES])
    expect(availablePermissionModes({ catalog: () => ({ options: [] }) })).toEqual([...SANDBOX_MODES])
  })

  it('offers Auto with its EXP badge and explanation when the catalog lists it', () => {
    const modes = ['read-only', 'workspace-write', 'danger-full-access', 'auto']
    const card = renderPermissionCard('workspace-write', t, undefined, { modes }) as any
    const text = card.body.elements.filter((el: any) => el.tag === 'markdown').map((el: any) => el.content).join('\n')
    expect(text).toContain(t.permissionAutoHint)
    const buttons = buttonsOf(card)
    expect(buttons).toHaveLength(4)
    const auto = buttons.find((b: any) => textOf(b).includes(t.permissionAuto))
    expect(textOf(auto)).toBe(`${t.permissionAuto} ${t.permissionAutoBadge}`)
    expect(auto.value).toBe(JSON.stringify({ p: 'permission', mode: 'auto' }))
    // The three shipped presets keep their labels and colors.
    expect(buttons.find((b: any) => textOf(b).includes('Full access')).type).toBe('danger')
  })

  it('stays exactly as before when the catalog does not list Auto', () => {
    const card = renderPermissionCard('workspace-write', t) as any
    const text = card.body.elements.filter((el: any) => el.tag === 'markdown').map((el: any) => el.content).join('\n')
    expect(text).not.toContain(t.permissionAutoHint)
    expect(buttonsOf(card)).toHaveLength(3)
  })

  it('asks for confirmation before switching, mirroring the Web UI risk dialog', () => {
    const confirm = renderPermissionAutoConfirmCard(t) as any
    expect(confirm.header.title.content).toBe(t.permissionAutoConfirmTitle)
    const buttons = buttonsOf(confirm)
    expect(buttons).toHaveLength(2)
    const enable = buttons.find((b: any) => textOf(b) === t.permissionAutoConfirmEnable)
    const cancel = buttons.find((b: any) => textOf(b) === t.permissionAutoCancel)
    expect(enable.value).toBe(JSON.stringify({ p: 'permission', mode: 'auto', confirm: true }))
    expect(cancel.value).toBe(JSON.stringify({ p: 'permission', mode: 'cancel' }))
  })

  function harness() {
    let mode = 'workspace-write'
    const set = vi.fn((_session: any, name: string) => { mode = name })
    const session = { append: vi.fn() }
    const send = vi.fn(async () => ({ messageId: 'om_card' }))
    const updateCard = vi.fn(async () => undefined)
    let actionHandler: ((evt: any) => unknown) | undefined
    const handle = startFeishuPermission({
      channel: { send, updateCard, onCardAction: (h: any) => { actionHandler = h; return () => undefined } },
      permissionPresets: {
        set,
        current: () => mode,
        catalog: () => withAuto,
      },
      sessionGetter: () => session,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    return { handle, set, session, send, updateCard, action: (evt: any) => actionHandler!(evt) }
  }

  it('opens with Auto and does not write anything until the confirmation', async () => {
    const h = harness()
    await h.handle.open({ chatId: 'oc_1', chatType: 'p2p' }, 'session-1')
    const opened = ((h.send.mock.calls as any)[0][1] as any).card
    const auto = buttonsOf(opened).find((b: any) => textOf(b).includes(t.permissionAuto))
    expect(auto).toBeDefined()

    await h.action({ messageId: 'om_card', action: { value: auto.value } })
    expect(h.set).not.toHaveBeenCalled()
    expect(h.updateCard).toHaveBeenCalledTimes(1)
    const confirm = (h.updateCard.mock.calls[0] as any)[1]
    expect(confirm.header.title.content).toBe(t.permissionAutoConfirmTitle)

    const enable = buttonsOf(confirm).find((b: any) => textOf(b) === t.permissionAutoConfirmEnable)
    await h.action({ messageId: 'om_card', action: { value: enable.value } })
    expect(h.set).toHaveBeenCalledWith(h.session, 'auto')
    // The picker comes back with Auto marked as the current, disabled button.
    expect(h.updateCard).toHaveBeenCalledTimes(2)
    const repainted = (h.updateCard.mock.calls[1] as any)[1]
    const activeAuto = buttonsOf(repainted).find((b: any) => b.disabled === true)
    expect(textOf(activeAuto)).toBe(`✓ ${t.permissionAuto} ${t.permissionAutoBadge}`)
    h.handle.stop()
  })

  it('cancelling repaints the picker and writes nothing', async () => {
    const h = harness()
    await h.handle.open({ chatId: 'oc_1', chatType: 'p2p' }, 'session-1')
    await h.action({ messageId: 'om_card', action: { value: JSON.stringify({ p: 'permission', mode: 'auto' }) } })
    expect(h.updateCard).toHaveBeenCalledTimes(1)
    await h.action({ messageId: 'om_card', action: { value: JSON.stringify({ p: 'permission', mode: 'cancel' }) } })
    expect(h.set).not.toHaveBeenCalled()
    expect(h.updateCard).toHaveBeenCalledTimes(2)
    const repainted = (h.updateCard.mock.calls[1] as any)[1]
    expect(buttonsOf(repainted)).toHaveLength(4)
    expect(buttonsOf(repainted).find((b: any) => b.disabled === true)).toBeDefined()
    h.handle.stop()
  })

  it('ignores a stale Auto click once the catalog no longer lists it', async () => {
    const session = { append: vi.fn() }
    const set = vi.fn()
    const updateCard = vi.fn(async () => undefined)
    let actionHandler: ((evt: any) => unknown) | undefined
    const handle = startFeishuPermission({
      channel: { send: vi.fn(async () => ({ messageId: 'om_card' })), updateCard, onCardAction: (h: any) => { actionHandler = h; return () => undefined } },
      permissionPresets: { set, current: () => 'workspace-write', catalog: () => ({ options: [...SANDBOX_MODES].map(value => ({ value })) }) },
      sessionGetter: () => session,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' }, 'session-1')
    await actionHandler!({ messageId: 'om_card', action: { value: JSON.stringify({ p: 'permission', mode: 'auto' }) } })
    expect(set).not.toHaveBeenCalled()
    expect(updateCard).not.toHaveBeenCalled()
    handle.stop()
  })

  it('reports a refused Auto switch on the card instead of throwing', async () => {
    const set = vi.fn(() => { throw new Error('permission: cannot restore preset "auto" without its active integration') })
    const session = { append: vi.fn() }
    const updateCard = vi.fn(async () => undefined)
    let actionHandler: ((evt: any) => unknown) | undefined
    const handle = startFeishuPermission({
      channel: { send: vi.fn(async () => ({ messageId: 'om_card' })), updateCard, onCardAction: (h: any) => { actionHandler = h; return () => undefined } },
      permissionPresets: { set, current: () => 'workspace-write', catalog: () => withAuto },
      sessionGetter: () => session,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    await handle.open({ chatId: 'oc_1', chatType: 'p2p' }, 'session-1')
    await actionHandler!({ messageId: 'om_card', action: { value: JSON.stringify({ p: 'permission', mode: 'auto' }) } })
    await expect(actionHandler!({ messageId: 'om_card', action: { value: JSON.stringify({ p: 'permission', mode: 'auto', confirm: true }) } }))
      .resolves.toBeUndefined()
    expect(updateCard).toHaveBeenCalledTimes(2)
    expect(JSON.stringify((updateCard.mock.calls[1] as any)[1])).toContain('Switch not applied')
    handle.stop()
  })
})
