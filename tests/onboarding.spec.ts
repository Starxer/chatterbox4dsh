import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFeishuOnboarding, type FeishuOnboardingDeps } from '../src/feishu-onboarding.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

interface FakeChannel {
  send: ReturnType<typeof vi.fn>
  updateCard: ReturnType<typeof vi.fn>
  onCardAction: ReturnType<typeof vi.fn>
  createCardInstance: ReturnType<typeof vi.fn>
  sendCardByReference: ReturnType<typeof vi.fn>
  updateCardInstance: ReturnType<typeof vi.fn>
}

function fakeChannel(): { channel: FakeChannel; handlers: Array<(evt: any) => void | Promise<void>> } {
  const handlers: Array<(evt: any) => void | Promise<void>> = []
  let instances = 0
  const channel: FakeChannel = {
    send: vi.fn(async () => ({ messageId: 'm-1' })),
    updateCard: vi.fn(async () => undefined),
    onCardAction: vi.fn((h: (evt: any) => void | Promise<void>) => {
      handlers.push(h)
      return () => {
        const i = handlers.indexOf(h)
        if (i >= 0) handlers.splice(i, 1)
      }
    }),
    createCardInstance: vi.fn(async () => `card-${++instances}`),
    sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
    updateCardInstance: vi.fn(async () => undefined),
  }
  return { channel, handlers }
}

function fakeBridge() {
  const sessions: Array<{ id: string; updatedAt: number; title: string; ownedBy?: string }> = []
  return {
    sessions,
    current: {
      listSessions: vi.fn(async () => sessions),
      describeChatKey: (key: string) => (key.startsWith('thread:') ? `话题(${key.slice(7, 15)})` : '主聊天'),
      attachSession: vi.fn(() => 'ok' as const),
      sessionOwnerKey: vi.fn(() => undefined),
      currentSelectionFor: vi.fn(() => undefined),
      startNewSession: vi.fn(() => 'new-session-id'),
    },
  }
}

function deps(channel: FakeChannel, bridgeHolder: { current: any }): FeishuOnboardingDeps {
  return {
    bridgeHolder,
    channel: channel as unknown as FeishuOnboardingDeps['channel'],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    workspaceRegistry: { list: () => [{ path: '/ws-1', name: 'Workspace One' }, { path: '/ws-2' }], create: vi.fn(async () => undefined) },
    agentPresets: {
      list: async () => [{ id: 'default', title: 'Default' }, { id: 'researcher', title: 'Researcher' }],
      defaultId: 'default',
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'openai', model: 'gpt-4o' }) },
    config: { workspace: '/ws-1', agentPreset: 'default', provider: 'openai', model: 'gpt-4o' },
    onModelStep: vi.fn(async () => undefined),
    getTranslations: () => t,
  }
}

function fire(handlers: Array<(evt: any) => void | Promise<void>>, evt: any): Promise<void[]> {
  return Promise.all(handlers.map(h => h(evt)))
}

/** Fake DSH `directoryPicker` browse backend over a tiny fixed tree. */
function fakeDirectoryPicker() {
  const listings: Record<string, any> = {
    '/home/me': {
      path: '/home/me',
      home: '/home/me',
      crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'me', path: '/home/me', hidden: false }],
      entries: [
        { name: 'projects', path: '/home/me/projects', hidden: false },
        { name: '.cache', path: '/home/me/.cache', hidden: true },
      ],
      truncated: false,
    },
    '/home/me/projects': {
      path: '/home/me/projects',
      home: '/home/me',
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'me', path: '/home/me', hidden: false },
        { name: 'projects', path: '/home/me/projects', hidden: false },
      ],
      entries: [{ name: 'my-app', path: '/home/me/projects/my-app', hidden: false }],
      truncated: false,
    },
  }
  const list = vi.fn(async (path?: string) => {
    const listing = listings[path ?? '/home/me']
    if (listing === undefined) throw new Error(`ENOENT: ${path}`)
    return listing
  })
  return { list, picker: { capability: () => ({ kind: 'browse', list }) } }
}

describe('feishu-onboarding', () => {
  it('sends the onboarding card with a session dropdown for every session', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    bridge.sessions.push({ id: 's-1', updatedAt: 1, title: 'First' })
    bridge.sessions.push({ id: 's-2', updatedAt: 2, title: 'Occupied', ownedBy: 'thread:oc_9:t_123' })
    const handle = startFeishuOnboarding(deps(channel, bridge))
    await handle.sendOnboardingCard({ chatId: 'oc_1', chatType: 'p2p' }, '这个对话框')
    expect(channel.createCardInstance).toHaveBeenCalledOnce()
    const card = channel.createCardInstance.mock.calls[0]![0] as any
    expect(card.schema).toBe('2.0')
    const contents = JSON.stringify(card)
    expect(contents).toContain('First')
    expect(contents).toContain('Occupied')
    expect(contents).toContain('🔒')
    expect(contents).toContain('select_static')
    expect(contents).toContain('新建会话')
    expect(handlers.length).toBe(1)
    handle.dispose()
  })

  it('attach form submission force-takes over the chosen session', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const handle = startFeishuOnboarding(deps(channel, bridge))
    await fire(handlers, {
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { value: JSON.stringify({ kind: 'attach' }) },
      raw: { action: { form_value: { session: 's-1' } } },
    })
    expect(bridge.current.attachSession).toHaveBeenCalledWith({ chatId: 'oc_1', chatType: 'p2p' }, 's-1')
    expect(channel.createCardInstance).toHaveBeenCalled()
    handle.dispose()
  })

  it('new action starts the workspace → preset → model flow', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const onModelStep = vi.fn(async () => undefined)
    const handle = startFeishuOnboarding({ ...deps(channel, bridge), onModelStep })
    // "new" → workspace picker (fresh card)
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    let card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('选择工作区')
    // pick workspace → preset picker (updates the referenced card instance)
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-workspace', value: '/ws-2' }) } })
    expect(channel.createCardInstance).toHaveBeenCalled()
    card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('选择 Agent 预设')
    // pick preset → model step
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-preset', value: 'researcher' }) } })
    expect(onModelStep).toHaveBeenCalledWith(
      { chatId: 'oc_1', chatType: 'p2p' },
      'm-ref',
      { workspace: '/ws-2', agentPreset: 'researcher' },
    )
    handle.dispose()
  })

  it('renders workspaces as a numbered dropdown plus the full paths in the body', async () => {
    const { channel, handlers } = fakeChannel()
    const d = deps(channel, fakeBridge())
    d.workspaceRegistry = {
      list: () => [
        { path: '/srv/one/two/three' },
        { path: '/srv/one/two/four' },
        { path: '/opt/a/b/c/d/e' },
      ],
      create: vi.fn(async () => undefined),
    }
    const handle = startFeishuOnboarding(d)
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    const form = card.body.elements.find((el: any) => el.tag === 'form')
    const select = form.elements.find((el: any) => el.tag === 'select_static')
    // Dropdown options are only the row numbers — a clipped single line can
    // never show a long path; the full path stays the option value.
    expect(select.options.map((o: any) => o.text.content)).toEqual(['1', '2', '3'])
    expect(select.options.map((o: any) => o.value)).toEqual(['/srv/one/two/three', '/srv/one/two/four', '/opt/a/b/c/d/e'])
    // The body lists every full path, so nothing is truncated.
    const body = JSON.stringify(card.body.elements)
    expect(body).toContain('/srv/one/two/three')
    expect(body).toContain('/opt/a/b/c/d/e')
    // One dropdown + submit, one manual-path submit — no per-workspace buttons.
    expect(form.elements.filter((el: any) => el.tag === 'button')).toHaveLength(2)
    handle.dispose()
  })

  it('submits the dropdown selection through the workspace form', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const onModelStep = vi.fn(async () => undefined)
    const handle = startFeishuOnboarding({ ...deps(channel, bridge), onModelStep })
    await fire(handlers, {
      chatId: 'oc_1',
      messageId: 'm-ref',
      action: { value: JSON.stringify({ kind: 'pick-workspace' }) },
      raw: { action: { form_value: { workspace: '/ws-2' } } },
    })
    expect(JSON.stringify(channel.createCardInstance.mock.calls.at(-1)![0])).toContain('选择 Agent 预设')
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-preset', value: 'researcher' }) } })
    expect(onModelStep).toHaveBeenCalledWith(
      { chatId: 'oc_1', chatType: 'p2p' },
      'm-ref',
      { workspace: '/ws-2', agentPreset: 'researcher' },
    )
    handle.dispose()
  })

  it('lists long workspace paths in full instead of clipping the dropdown option', async () => {
    const { channel, handlers } = fakeChannel()
    const d = deps(channel, fakeBridge())
    d.workspaceRegistry = {
      list: () => [
        { path: '/srv/a/verylongprojectdirectoryname' },
        { path: '/srv/b/anotherverylongprojectname' },
      ],
      create: vi.fn(async () => undefined),
    }
    const handle = startFeishuOnboarding(d)
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    const select = card.body.elements
      .find((el: any) => el.tag === 'form').elements.find((el: any) => el.tag === 'select_static')
    expect(select.options.map((o: any) => o.text.content)).toEqual(['1', '2'])
    // The body carries both full paths verbatim — no elision anywhere.
    const body = JSON.stringify(card.body.elements)
    expect(body).toContain('/srv/a/verylongprojectdirectoryname')
    expect(body).toContain('/srv/b/anotherverylongprojectname')
    handle.dispose()
  })

  it('flows browser buttons at their natural width without eliding names', async () => {
    const { channel, handlers } = fakeChannel()
    const d = deps(channel, fakeBridge())
    const entries = Array.from({ length: 7 }, (_, index) => ({
      name: `entry-${index}-somewhat-long`,
      path: `/g/entry-${index}`,
      hidden: false,
    }))
    d.getDirectoryPicker = () => ({
      capability: () => ({
        kind: 'browse',
        list: async () => ({
          path: '/g',
          home: '/g',
          crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'g', path: '/g', hidden: false }],
          entries,
          truncated: false,
        }),
      }),
    })
    const handle = startFeishuOnboarding(d)
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-open' }) } })
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    const rows = card.body.elements.filter((el: any) => el.tag === 'column_set')
    // Controls row + one flowing row for all 7 entries (no manual row packing).
    expect(rows).toHaveLength(2)
    const entriesRow = rows[1]
    expect(entriesRow.flex_mode).toBe('flow')
    expect(entriesRow.columns).toHaveLength(7)
    expect(entriesRow.columns.every((col: any) => col.width === 'auto')).toBe(true)
    const buttons = entriesRow.columns.map((col: any) => col.elements[0])
    // Names are shown in full — no ellipsis, no fixed-width clipping.
    expect(buttons.map((b: any) => b.text.content)).toEqual(entries.map(entry => `📁 ${entry.name}`))
    expect(buttons.every((b: any) => b.width === undefined)).toBe(true)
    expect(buttons[0].behaviors[0].value).toEqual({ kind: 'browse-enter', value: '/g/entry-0' })
    handle.dispose()
  })

  it('create-workspace form creates the workspace and advances to preset picker', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const create = vi.fn(async () => undefined)
    const d = deps(channel, bridge)
    d.workspaceRegistry = { list: () => [], create }
    const handle = startFeishuOnboarding(d)
    await fire(handlers, {
      chatId: 'oc_1',
      messageId: 'm-ref',
      action: { value: JSON.stringify({ kind: 'create-workspace' }) },
      raw: { action: { form_value: { workspace_path: '~/projects/my-app' } } },
    })
    expect(create).toHaveBeenCalledWith(expect.stringMatching(/\/projects\/my-app$/))
    expect(channel.createCardInstance).toHaveBeenCalled()
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('选择 Agent 预设')
    handle.dispose()
  })

  it('attach form submitted from a topic card binds the THREAD key, not the main chat key', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const handle = startFeishuOnboarding(deps(channel, bridge))
    // First-message onboarding card in a topic records the topic context.
    await handle.sendOnboardingCard(
      { chatId: 'oc_1', chatType: 'group', threadId: 'omt_9', rootId: 'om_root' },
      '这个话题',
    )
    // Attach form submitted from the topic's card. Card action events carry
    // only chatId + messageId, so the handler must restore threadId/rootId
    // from the recorded topic context or the binding would land on
    // `chat:oc_1` (main chat) instead of `thread:oc_1:omt_9`.
    await fire(handlers, {
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { value: JSON.stringify({ kind: 'attach' }) },
      raw: { action: { form_value: { session: 's-1' } } },
    })
    expect(bridge.current.attachSession).toHaveBeenCalledWith(
      { chatId: 'oc_1', chatType: 'p2p', threadId: 'omt_9', rootId: 'om_root' },
      's-1',
    )
    // The success card is sent as a topic reply to the root message.
    expect(channel.sendCardByReference).toHaveBeenCalledWith(
      'oc_1',
      expect.any(String),
      { replyInThread: true, replyTo: 'om_root' },
    )
    handle.dispose()
  })

  it('noteTopic records slash-command topic context for later card actions', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const onModelStep = vi.fn(async () => undefined)
    const handle = startFeishuOnboarding({ ...deps(channel, bridge), onModelStep })
    // A slash command (`/new`) in a topic records the thread key.
    handle.noteTopic({ chatId: 'oc_1', chatType: 'group', threadId: 'omt_9', rootId: 'om_root' })
    // The workspace picker card clicked in the topic advances the flow with
    // topic context restored on the chatMessage.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-workspace', value: '/ws-2' }) } })
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-preset', value: 'researcher' }) } })
    expect(onModelStep).toHaveBeenCalledWith(
      { chatId: 'oc_1', chatType: 'p2p', threadId: 'omt_9', rootId: 'om_root' },
      'm-ref',
      { workspace: '/ws-2', agentPreset: 'researcher' },
    )
    handle.dispose()
  })

  it('always offers the browse entry point in the workspace picker', async () => {
    const { channel, handlers } = fakeChannel()
    const handle = startFeishuOnboarding(deps(channel, fakeBridge()))
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('浏览目录')
    handle.dispose()
  })

  it('falls back to its own filesystem listing when directoryPicker is a native backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-browse-'))
    try {
      await mkdir(join(root, 'alpha'))
      await mkdir(join(root, 'beta'))
      await mkdir(join(root, '.hidden'))
      await writeFile(join(root, 'file.txt'), 'x')
      const { channel, handlers } = fakeChannel()
      const d = deps(channel, fakeBridge())
      // A `native` picker opens an OS chooser on the host display, which a
      // remote Feishu user can never see — the plugin must list the fs itself.
      d.getDirectoryPicker = () => ({ capability: () => ({ kind: 'native' }) })
      const handle = startFeishuOnboarding(d)
      // `browse-open` starts at the home directory; navigate to the temp root.
      await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-open' }) } })
      await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-enter', value: root }) } })
      const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
      const text = JSON.stringify(card)
      expect(text).toContain('alpha')
      expect(text).toContain('beta')
      expect(text).not.toContain('.hidden')
      // Files are not rows — only directories are browsable.
      expect(text).not.toContain('file.txt')
      handle.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('browses from home, filters hidden entries, and picks the listed directory', async () => {
    const { channel, handlers } = fakeChannel()
    const create = vi.fn(async () => undefined)
    const d = deps(channel, fakeBridge())
    const picker = fakeDirectoryPicker()
    d.workspaceRegistry = { list: () => [], create }
    d.getDirectoryPicker = () => picker.picker
    const handle = startFeishuOnboarding(d)

    // Workspace picker offers the browse entry point.
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    expect(JSON.stringify(channel.createCardInstance.mock.calls.at(-1)![0])).toContain('浏览目录')

    // Open the browser at the host home directory.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-open' }) } })
    expect(picker.list).toHaveBeenLastCalledWith(undefined)
    let card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    let text = JSON.stringify(card)
    expect(text).toContain('/home/me')
    expect(text).toContain('projects')
    expect(text).not.toContain('.cache')

    // Toggle hidden entries on → the dot directory appears.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-hidden' }) } })
    expect(picker.list).toHaveBeenLastCalledWith('/home/me')
    card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('.cache')

    // Descend into a child directory.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-enter', value: '/home/me/projects' }) } })
    expect(picker.list).toHaveBeenLastCalledWith('/home/me/projects')
    card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('my-app')

    // Commit the listed directory as the workspace → preset picker.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-pick', value: '/home/me/projects' }) } })
    expect(create).toHaveBeenCalledWith('/home/me/projects')
    card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('选择 Agent 预设')
    handle.dispose()
  })

  it('browse-back returns to the workspace picker', async () => {
    const { channel, handlers } = fakeChannel()
    const d = deps(channel, fakeBridge())
    d.getDirectoryPicker = () => fakeDirectoryPicker().picker
    const handle = startFeishuOnboarding(d)
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-open' }) } })
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-back' }) } })
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('选择工作区')
    handle.dispose()
  })

  it('repaints the replaced card as a stale-card notice when a new card is posted', async () => {
    const { channel, handlers } = fakeChannel()
    const handle = startFeishuOnboarding(deps(channel, fakeBridge()))
    // First card (workspace picker) — nothing to supersede yet.
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    expect(channel.updateCardInstance).not.toHaveBeenCalled()

    // Second card (preset picker) — the workspace picker must be retired so its
    // now-dead buttons are not mistaken for live ones.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-workspace', value: '/ws-2' }) } })
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    const [cardId, card, sequence] = channel.updateCardInstance.mock.calls[0]! as [string, any, number]
    expect(cardId).toBe('card-1')
    expect(sequence).toBe(1)
    const text = JSON.stringify(card)
    expect(text).toContain(t.cardSupersededTitle)
    expect(text).toContain('最新的卡片')
    // The notice must not keep any live button around.
    expect(text).not.toContain('callback')

    // A third card retires the second one.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-back' }) } })
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(2)
    expect((channel.updateCardInstance.mock.calls[1]! as [string, any, number])[0]).toBe('card-2')
    handle.dispose()
  })

  it('uses the active locale for the stale-card notice', async () => {
    const { channel, handlers } = fakeChannel()
    const handle = startFeishuOnboarding({ ...deps(channel, fakeBridge()), getTranslations: () => translationsFor('en') })
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-workspace', value: '/ws-2' }) } })
    const text = JSON.stringify((channel.updateCardInstance.mock.calls[0]! as [string, any, number])[1])
    expect(text).toContain(translationsFor('en').cardSupersededTitle)
    expect(text).toContain('newest card')
    handle.dispose()
  })

  it('does not repaint a terminal result card from a later flow', async () => {
    const { channel, handlers } = fakeChannel()
    const handle = startFeishuOnboarding(deps(channel, fakeBridge()))
    // Cancel ends the flow with a terminal card.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'cancel' }) } })
    channel.updateCardInstance.mockClear()
    // A later flow must leave the "cancelled" card readable.
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    expect(channel.updateCardInstance).not.toHaveBeenCalled()
    handle.dispose()
  })

  it('keeps the flow alive when repainting the stale card fails', async () => {
    const { channel, handlers } = fakeChannel()
    const warn = vi.fn()
    const d = { ...deps(channel, fakeBridge()), logger: { info: vi.fn(), warn, error: vi.fn() } }
    channel.updateCardInstance.mockRejectedValue(new Error('card expired'))
    const handle = startFeishuOnboarding(d)
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-workspace', value: '/ws-2' }) } })
    // The preset card still went out; only the retire attempt was logged.
    const last = JSON.stringify(channel.createCardInstance.mock.calls.at(-1)![0])
    expect(last).toContain('选择 Agent 预设')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('card expired'))
    handle.dispose()
  })

  it('reports a browse failure with the specific reason instead of a blank card', async () => {
    const { channel, handlers } = fakeChannel()
    const d = deps(channel, fakeBridge())
    d.getDirectoryPicker = () => fakeDirectoryPicker().picker
    const handle = startFeishuOnboarding(d)
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-enter', value: '/nope' }) } })
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('ENOENT')
    handle.dispose()
  })

  it('pages a large level by posting a fresh card for every page', async () => {
    const { channel, handlers } = fakeChannel()
    const d = deps(channel, fakeBridge())
    const entries = Array.from({ length: 100 }, (_, index) => ({
      name: `dir-${String(index).padStart(3, '0')}`,
      path: `/big/dir-${String(index).padStart(3, '0')}`,
      hidden: false,
    }))
    d.getDirectoryPicker = () => ({
      capability: () => ({
        kind: 'browse',
        list: async (path?: string) => ({
          path: path ?? '/big',
          home: '/big',
          crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'big', path: '/big', hidden: false }],
          entries,
          truncated: false,
        }),
      }),
    })
    const handle = startFeishuOnboarding(d)
    const cardsBefore = channel.createCardInstance.mock.calls.length
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-open' }) } })
    let card = JSON.stringify(channel.createCardInstance.mock.calls.at(-1)![0])
    expect(card).toContain('dir-000')
    expect(card).not.toContain('dir-030')

    // Page 2, 3, 4 — every step must produce a NEW card message whose buttons
    // work (in-place edits stop delivering callbacks after a couple of edits).
    for (const [pageValue, first, absent] of [['1', 'dir-030', 'dir-000'], ['2', 'dir-060', 'dir-030'], ['3', 'dir-090', 'dir-060']] as const) {
      await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-page', value: pageValue }) } })
      card = JSON.stringify(channel.createCardInstance.mock.calls.at(-1)![0])
      expect(card).toContain(first)
      expect(card).not.toContain(absent)
    }
    // Last page carries no "next page" button.
    expect(card).not.toContain('下一页')
    expect(channel.createCardInstance.mock.calls.length).toBe(cardsBefore + 4)
    handle.dispose()
  })
})
