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

  it('renders each workspace as a clickable row with its full path', async () => {
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
    const rows = card.body.elements
      .filter((el: any) => el.tag === 'interactive_container' && el.behaviors[0].value.kind === 'pick-workspace')
    // Each workspace is one clickable row carrying its FULL path (never a
    // clipped dropdown option), and the row itself is the pick target.
    expect(rows.map((row: any) => row.elements[0].content)).toEqual([
      '📁 `/srv/one/two/three`',
      '📁 `/srv/one/two/four`',
      '📁 `/opt/a/b/c/d/e`',
    ])
    expect(rows.map((row: any) => row.behaviors[0].value.value))
      .toEqual(['/srv/one/two/three', '/srv/one/two/four', '/opt/a/b/c/d/e'])
    expect(rows.every((row: any) => row.width === 'fill' && row.has_border === false)).toBe(true)
    // No dropdown anymore; the manual-path form still has its input.
    expect(JSON.stringify(card.body.elements)).not.toContain('select_static')
    const form = card.body.elements.find((el: any) => el.tag === 'form')
    expect(form.elements.some((el: any) => el.tag === 'input')).toBe(true)
    handle.dispose()
  })

  it('still accepts a legacy dropdown form submission from an already-sent card', async () => {
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

  it('lists long workspace paths in full in the clickable rows', async () => {
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
    const rows = card.body.elements
      .filter((el: any) => el.tag === 'interactive_container' && el.behaviors[0].value.kind === 'pick-workspace')
    // Both full paths are shown verbatim in their rows — no elision anywhere.
    expect(rows.map((row: any) => row.elements[0].content)).toEqual([
      '📁 `/srv/a/verylongprojectdirectoryname`',
      '📁 `/srv/b/anotherverylongprojectname`',
    ])
    handle.dispose()
  })

  it('renders every browser entry as a clickable borderless row, not a button', async () => {
    const { channel, handlers } = fakeChannel()
    const d = deps(channel, fakeBridge())
    const entries = [
      ...Array.from({ length: 6 }, (_, index) => ({ name: `dir-${index}`, path: `/g/dir-${index}`, hidden: false })),
      { name: 'a-really-quite-long-directory-name', path: '/g/long', hidden: false },
    ]
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
    // No dropdown / form, and the entries are not buttons: each row is a
    // borderless interactive_container whose markdown shows the full name.
    expect(card.body.elements.some((el: any) => el.tag === 'form')).toBe(false)
    const rows = card.body.elements
      .filter((el: any) => el.tag === 'interactive_container' && el.behaviors[0].value.kind === 'browse-enter'
        && String(el.behaviors[0].value.value).startsWith('/g/'))
    expect(rows.map((row: any) => row.elements[0].content)).toEqual(entries.map(entry => `📁 ${entry.name}`))
    expect(rows.every((row: any) => row.width === 'fill' && row.has_border === false)).toBe(true)
    expect(rows.map((row: any) => row.behaviors[0].value.value)).toEqual(entries.map(entry => entry.path))
    // The top controls stack vertically on a narrow (mobile) screen instead of
    // squeezing their labels until they clip.
    const controlRow = card.body.elements.find((el: any) => el.tag === 'column_set')
    expect(controlRow.flex_mode).toBe('stretch')
    handle.dispose()
  })

  it('enters the folder clicked in the browser list', async () => {
    const { channel, handlers } = fakeChannel()
    const picker = fakeDirectoryPicker()
    const d = deps(channel, fakeBridge())
    d.getDirectoryPicker = () => picker.picker
    const handle = startFeishuOnboarding(d)
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-open' }) } })
    await fire(handlers, {
      chatId: 'oc_1',
      messageId: 'm-ref',
      action: { value: JSON.stringify({ kind: 'browse-enter', value: '/home/me/projects' }) },
    })
    expect(picker.list).toHaveBeenCalledWith('/home/me/projects')
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('/home/me/projects')
    expect(JSON.stringify(card)).toContain('my-app')
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

  /**
   * 2026-09-21 regression. The `/new` flow ran in a topic the operator had
   * just created, while an older topic of the SAME group kept producing
   * traffic. The per-chat topic map can only hold one topic per group, so once
   * the old topic's message was seen the flow's later cards (the model card and
   * the final confirm card) were posted into that old topic.
   *
   * The card's own message id is what disambiguates: the operator clicked a
   * card this module posted into a known topic, so that topic wins over the
   * group-wide "most recent" guess.
   */
  it('keeps a flow card in its own topic after another topic of the group got traffic', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const onModelStep = vi.fn(async () => undefined)
    const handle = startFeishuOnboarding({ ...deps(channel, bridge), onModelStep })
    // The first-message card of the NEWLY created topic (`omt_new`).
    await handle.sendOnboardingCard(
      { chatId: 'oc_grp', chatType: 'group', threadId: 'omt_new', rootId: 'om_root_new' },
      '这个话题',
    )
    // ...and the onboarding card is the one that got sent last.
    expect(channel.sendCardByReference).toHaveBeenLastCalledWith(
      'oc_grp',
      expect.any(String),
      { replyInThread: true, replyTo: 'om_root_new' },
    )
    // An unrelated inbound message in an OLDER topic of the same group: the
    // per-chat map now points at `omt_old`.
    handle.noteTopic({ chatId: 'oc_grp', chatType: 'group', threadId: 'omt_old', rootId: 'om_root_old' })
    // The operator clicks "new" on the card that lives in the NEW topic.
    await fire(handlers, {
      chatId: 'oc_grp',
      messageId: 'm-ref',
      action: { value: JSON.stringify({ kind: 'new' }) },
    })
    // The workspace picker must follow the clicked card into `omt_new`, not the
    // group's most recently used topic.
    expect(channel.sendCardByReference).toHaveBeenLastCalledWith(
      'oc_grp',
      expect.any(String),
      { replyInThread: true, replyTo: 'om_root_new' },
    )
    handle.dispose()
  })

  it('still restores topic context from the per-chat map for an unknown card', async () => {
    // Cards sent before a plugin reload are not in the message-id registry; the
    // chat-level map (persisted by the bridge) has to keep working for them.
    const { channel, handlers } = fakeChannel()
    const onModelStep = vi.fn(async () => undefined)
    const handle = startFeishuOnboarding({ ...deps(channel, fakeBridge()), onModelStep })
    handle.noteTopic({ chatId: 'oc_1', chatType: 'group', threadId: 'omt_9', rootId: 'om_root' })
    await fire(handlers, {
      chatId: 'oc_1',
      messageId: 'm-not-registered',
      action: { value: JSON.stringify({ kind: 'pick-preset', value: 'researcher' }) },
    })
    expect(onModelStep).toHaveBeenCalledWith(
      { chatId: 'oc_1', chatType: 'p2p', threadId: 'omt_9', rootId: 'om_root' },
      'm-not-registered',
      { agentPreset: 'researcher' },
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

  /**
   * The topic fix must not change DM or a group with topic mode OFF: there is
   * no thread to resolve, so every card of the flow is a plain top-level
   * message (`{}` reply opts), exactly as before.
   */
  it('sends every card of a DM flow as a plain message', async () => {
    const { channel, handlers } = fakeChannel()
    const onModelStep = vi.fn(async () => undefined)
    const handle = startFeishuOnboarding({ ...deps(channel, fakeBridge()), onModelStep })
    await handle.sendOnboardingCard({ chatId: 'oc_dm', chatType: 'p2p' }, '这个对话框')
    expect(channel.sendCardByReference).toHaveBeenLastCalledWith('oc_dm', expect.any(String), {})
    // Clicking through the flow (card actions carry no thread either) must keep
    // sending plain messages rather than invent a topic.
    await fire(handlers, { chatId: 'oc_dm', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'new' }) } })
    expect(channel.sendCardByReference).toHaveBeenLastCalledWith('oc_dm', expect.any(String), {})
    await fire(handlers, { chatId: 'oc_dm', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-workspace', value: '/ws-2' }) } })
    await fire(handlers, { chatId: 'oc_dm', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-preset', value: 'researcher' }) } })
    expect(channel.sendCardByReference).toHaveBeenLastCalledWith('oc_dm', expect.any(String), {})
    // No thread is restored onto the chatMessage the model step receives.
    expect(onModelStep).toHaveBeenLastCalledWith(
      { chatId: 'oc_dm', chatType: 'p2p' },
      'm-ref',
      { workspace: '/ws-2', agentPreset: 'researcher' },
    )
    handle.dispose()
  })

  it('sends every card of a plain group flow as a plain message', async () => {
    const { channel, handlers } = fakeChannel()
    const handle = startFeishuOnboarding(deps(channel, fakeBridge()))
    await handle.sendOnboardingCard({ chatId: 'oc_grp', chatType: 'group' }, '这个对话框')
    expect(channel.sendCardByReference).toHaveBeenLastCalledWith('oc_grp', expect.any(String), {})
    await fire(handlers, { chatId: 'oc_grp', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'new' }) } })
    expect(channel.sendCardByReference).toHaveBeenLastCalledWith('oc_grp', expect.any(String), {})
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

  it('freezes the workspace decision card on the chosen value, non-editable', async () => {
    const { channel, handlers } = fakeChannel()
    const handle = startFeishuOnboarding(deps(channel, fakeBridge()))
    // First card (workspace picker) — nothing to supersede yet.
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    expect(channel.updateCardInstance).not.toHaveBeenCalled()

    // Second card (preset picker) — the card the operator decided on keeps its
    // content, is marked with the chosen workspace and stops being editable.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-workspace', value: '/ws-2' }) } })
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    const [cardId, card, sequence] = channel.updateCardInstance.mock.calls[0]! as [string, any, number]
    expect(cardId).toBe('card-1')
    expect(sequence).toBe(1)
    const text = JSON.stringify(card)
    expect(text).toContain(t.cardSettledNote('/ws-2'))
    // The record survives: the original picker body is still there...
    expect(text).toContain('选择工作区')
    // ...but no callback binding does.
    expect(text).not.toContain('behaviors')
    expect(text).not.toContain('callback')

    // A third card retires the preset picker with the plain stale notice.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-back' }) } })
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(2)
    const second = channel.updateCardInstance.mock.calls[1]! as [string, any, number]
    expect(second[0]).toBe('card-2')
    expect(JSON.stringify(second[1])).toContain(t.cardStaleNote)
    handle.dispose()
  })

  it('retires a folder-browser page with the generic notice instead of its listing', async () => {
    // Only cards that carried a real choice stay readable after retirement;
    // a `/new` browse can span a dozen pages, whose listings are dead weight.
    const { channel, handlers } = fakeChannel()
    const d = deps(channel, fakeBridge())
    d.getDirectoryPicker = () => fakeDirectoryPicker().picker
    const handle = startFeishuOnboarding(d)
    // First page (home) — nothing to retire yet.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-open' }) } })
    expect(channel.updateCardInstance).not.toHaveBeenCalled()
    // Descending posts page 2 and repaints page 1 as the bare stale notice.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-enter', value: '/home/me/projects' }) } })
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    const [cardId, painted] = channel.updateCardInstance.mock.calls[0]! as [string, any, number]
    expect(cardId).toBe('card-1')
    const text = JSON.stringify(painted)
    expect(text).toContain(t.cardSupersededTitle)
    expect(text).toContain(t.cardSupersededBody)
    // The listing (directory rows) is gone, and so is every callback binding.
    expect(text).not.toContain('projects')
    expect(text).not.toContain('behaviors')
    handle.dispose()
  })

  it('freezes the folder-browser page the operator settled on, not a bare notice', async () => {
    // Regression: a browser page is posted as "pure navigation", and its
    // payload used to be dropped from the remembered ref. Tapping
    // "✅ 用这个目录" on that very page then silently degraded to the generic
    // notice, losing the record of the directory that was chosen.
    const { channel, handlers } = fakeChannel()
    const d = deps(channel, fakeBridge())
    d.getDirectoryPicker = () => fakeDirectoryPicker().picker
    const handle = startFeishuOnboarding(d)
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-open' }) } })
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-enter', value: '/home/me/projects' }) } })
    // Ignore the retirement of the home page; only the settled page matters.
    channel.updateCardInstance.mockClear()

    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'browse-pick', value: '/home/me/projects' }) } })
    expect(channel.updateCardInstance).toHaveBeenCalledTimes(1)
    const [cardId, painted] = channel.updateCardInstance.mock.calls[0]! as [string, any, number]
    // card-1 = home page, card-2 = the projects page the operator settled on.
    expect(cardId).toBe('card-2')
    const text = JSON.stringify(painted)
    expect(text).toContain(t.cardSettledNote('/home/me/projects'))
    // The listing stays as the readable record of the decision...
    expect(text).toContain('my-app')
    // ...but nothing on it can be tapped any more.
    expect(text).not.toContain('behaviors')
    expect(text).not.toContain('callback')
    handle.dispose()
  })

  it('uses the active locale for the settled-decision notice', async () => {
    const { channel, handlers } = fakeChannel()
    const handle = startFeishuOnboarding({ ...deps(channel, fakeBridge()), getTranslations: () => translationsFor('en') })
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-workspace', value: '/ws-2' }) } })
    const text = JSON.stringify((channel.updateCardInstance.mock.calls[0]! as [string, any, number])[1])
    expect(text).toContain(translationsFor('en').cardSettledNote('/ws-2'))
    expect(text).toContain('locked')
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
