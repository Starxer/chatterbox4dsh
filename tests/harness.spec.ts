import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HarnessConversationService } from '../src/harness.ts'

function fixture() {
  let seq = 0
  const agents = new Map<string, any>()
  const createHandle = async (sessionId: string) => {
    const events: any[] = []
    const ctx = { on: vi.fn(() => () => undefined) } as any
    const agent = {
      ctx,
      session: { id: sessionId, get seq() { return seq }, events },
      whenIdle: vi.fn(async () => undefined),
      followup: vi.fn((message: any) => {
        events.push({ seq: seq++, type: 'turn/start', data: {} })
        const echoed = String(message.content[0]?.text ?? '')
        events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer:${echoed}` }] } } })
        events.push({ seq: seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
      }),
      steer: vi.fn((message: any) => {
        events.push({ seq: seq++, type: 'turn/start', data: {} })
        const echoed = String(message.content[0]?.text ?? '')
        events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer:${echoed}` }] } } })
        events.push({ seq: seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
      }),
      cancel: vi.fn(() => undefined),
      status: 'idle' as const,
    }
    agents.set(String(sessionId), agent)
    return { agent, dispose: vi.fn(async () => undefined) }
  }
  const create = vi.fn(async ({ sessionId }: { sessionId: string }) => createHandle(sessionId))
  const resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string; setup?: (ctx: unknown) => Promise<void> }) => createHandle(resumeSessionId))
  const flush = vi.fn(async () => true)
  const workspace = { path: '/first-workspace', attachSession: vi.fn(async () => undefined) }
  const mount = vi.fn(async () => undefined)
  const resolve = vi.fn(async (id?: string) => ({ id: id ?? 'default-preset' }))
  return { create, resume, flush, agents, workspace, mount, resolve }
}

function dependencies(f: ReturnType<typeof fixture>) {
  return {
    agents: { create: f.create, resume: f.resume, get: (id: string) => f.agents.get(id) },
    sessions: { flush: f.flush },
    sessionPersistence: { list: vi.fn(async () => []), readFrom: vi.fn() },
    selection: () => ({ provider: 'p', model: 'm' }),
    agentPresets: { resolve: f.resolve, mount: f.mount },
    workspaceRegistry: { list: () => [f.workspace], resolveByPath: vi.fn(async () => undefined), archivedSessionIds: [] },
  } as any
}

describe('HarnessConversationService', () => {
  it('lazily creates and reuses one agent for the same conversation', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'one' })).resolves.toBe('answer:one')
    await expect(service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'two' })).resolves.toBe('answer:two')
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.flush).toHaveBeenCalledTimes(2)
  })

  it('resumes a persisted conversation instead of creating its session again', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'lark' })

    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'again' })).resolves.toBe('answer:again')

    expect(f.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: sessionId }))
    expect(f.create).not.toHaveBeenCalled()
  })

  it('resolves a live agent without re-creating the session', async () => {
    const f = fixture()
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    const liveHandle = await f.create({ sessionId })
    f.create.mockClear()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'lark' })
    const agent = await service.resolveAgentOrResume({ chatId: 'a', chatType: 'p2p' })
    expect(agent).toBeDefined()
    expect(f.create).not.toHaveBeenCalled()
    expect(liveHandle.agent).toBe(agent)
  })

  it('creates a brand-new session under the configured preset', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [])
    const service = new HarnessConversationService(deps, { domain: 'feishu', agentPreset: 'ptc' })

    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'one' })

    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.resolve).toHaveBeenCalledWith('ptc')
  })

  it('resumes a persisted session under the preset it recorded, not the bridge default', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    deps.sessionPersistence.readFrom = vi.fn(async () => ({ meta: { agentPreset: 'cordis' }, events: [] }))
    const service = new HarnessConversationService(deps, { domain: 'lark' })

    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'again' })

    // The mounted composition is built by `setup`; the creation header's preset
    // is the authority for a resumed session.
    const setup = f.resume.mock.calls[0]?.[0]?.setup as (ctx: unknown) => Promise<void>
    await setup?.({})
    expect(f.mount).toHaveBeenCalledWith({}, 'cordis')
    expect(f.resolve).toHaveBeenCalledWith('cordis')
  })

  it('prefers the latest agent-preset/selected over the creation header on resume', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    // A blank-session switch never rewrites the creation header, so the event
    // is the authority — the host's `agentPreset` projection does the same.
    deps.sessionPersistence.readFrom = vi.fn(async () => ({
      meta: { agentPreset: 'standard' },
      events: [
        { seq: 1, type: 'agent-preset/selected', data: { agentPreset: 'cordis' } },
        { seq: 2, type: 'turn/start', data: {} },
      ],
    }))
    const service = new HarnessConversationService(deps, { domain: 'lark' })

    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'again' })

    const setup = f.resume.mock.calls[0]?.[0]?.setup as (ctx: unknown) => Promise<void>
    await setup?.({})
    expect(f.mount).toHaveBeenCalledWith({}, 'cordis')
  })

  it('recovers the recorded preset from the head of a long session log, not the whole log', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    const read = vi.fn(async (_offset?: number, length?: number) => {
      const events = [
        { seq: 1, type: 'agent-preset/selected', data: { agentPreset: 'cordis' } },
        { seq: 2, type: 'turn/start', data: {} },
        ...Array.from({ length: 500 }, (_, index) => ({ seq: index + 3, type: 'assistant/message', data: {} })),
      ]
      return { events: events.slice(0, length ?? events.length) }
    })
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    deps.sessionPersistence.open = vi.fn(async () => ({
      header: { agentPreset: 'standard' },
      read,
      close: vi.fn(async () => undefined),
    }))
    const service = new HarnessConversationService(deps, { domain: 'lark' })

    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'again' })

    // One bounded read: the selection event can only be appended while the
    // session is blank, so it always sits in the log's head — a long history is
    // never pulled into memory just to remount a preset.
    expect(read.mock.calls).toEqual([[0, 64]])
    const setup = f.resume.mock.calls[0]?.[0]?.setup as (ctx: unknown) => Promise<void>
    await setup?.({})
    expect(f.mount).toHaveBeenCalledWith({}, 'cordis')
  })

  it('falls back to the configured preset when a resumed session records an unknown one', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    // `persistent` only ever existed as a scanned directory, which the 0.1.7
    // registry no longer discovers: the resume must still open the session.
    deps.sessionPersistence.readFrom = vi.fn(async () => ({ meta: { agentPreset: 'persistent' }, events: [] }))
    f.resolve.mockImplementation(async (id?: string) => {
      if (id === 'persistent') throw new Error('Unknown agent preset: persistent')
      return { id: id ?? 'default-preset' }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const service = new HarnessConversationService(deps, { domain: 'lark' })

    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'again' })).resolves.toBe('answer:again')

    const setup = f.resume.mock.calls[0]?.[0]?.setup as (ctx: unknown) => Promise<void>
    await setup?.({})
    expect(f.mount).toHaveBeenCalledWith({}, 'default-preset')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recorded agent preset "persistent"'))
    warn.mockRestore()
  })

  it('resolveAgentOrResume rehydrates a cold persisted session (commands work after restart)', async () => {
    const f = fixture()
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'lark' })
    const agent = await service.resolveAgentOrResume({ chatId: 'a', chatType: 'p2p' })
    expect(agent).toBeDefined()
    // Cold session → resumed (not freshly created).
    expect(f.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: sessionId }))
    expect(f.create).not.toHaveBeenCalled()
  })

  it('resolveAgentOrResume returns undefined when no conversation exists at all', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [])
    const service = new HarnessConversationService(deps, { domain: 'lark' })
    const agent = await service.resolveAgentOrResume({ chatId: 'never', chatType: 'p2p' })
    expect(agent).toBeUndefined()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
  })

  it('reuses a live agent without trying to resume the same session', async () => {
    const f = fixture()
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    const liveHandle = await f.create({ sessionId })
    f.create.mockClear()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'lark' })

    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'live' })).resolves.toBe('answer:live')
    await service.dispose()

    expect(f.resume).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(liveHandle.dispose).not.toHaveBeenCalled()
  })

  it('steers into a running turn instead of queueing a new one', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    agent.status = 'running'
    agent.followup.mockClear()
    agent.steer.mockClear()
    await service.steer({ chatId: 'oc_1', chatType: 'p2p', content: 'inject me' })
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).toHaveBeenCalledTimes(1)
    const msg = agent.steer.mock.calls[0]![0]
    expect(msg.content).toEqual([{ type: 'text', text: 'inject me' }])
    expect(msg.source).toEqual({ kind: 'user' })
  })

  it('rejects steer when no agent exists or it is not running', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    // No conversation started yet.
    await expect(service.steer({ chatId: 'oc_2', chatType: 'p2p', content: 'x' })).rejects.toThrow(/尚未开始会话/)
    // Agent exists but idle.
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    await expect(service.steer({ chatId: 'oc_1', chatType: 'p2p', content: 'x' })).rejects.toThrow(/没有运行中的 turn/)
  })

  it('persists a per-chat busy mode and reads it back (default queue)', () => {
    const f = fixture()
    const statePath = join(tmpdir(), `dsh-feishu-busy-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    expect(service.busyMode({ chatId: 'oc_1', chatType: 'p2p' })).toBe('queue')
    service.setBusyMode({ chatId: 'oc_1', chatType: 'p2p' }, 'steer')
    expect(service.busyMode({ chatId: 'oc_1', chatType: 'p2p' })).toBe('steer')
    expect(service.busyMode({ chatId: 'oc_2', chatType: 'p2p' })).toBe('queue')
    // Reload from disk: the choice survives a restart.
    const service2 = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    expect(service2.busyMode({ chatId: 'oc_1', chatType: 'p2p' })).toBe('steer')
    expect(service2.busyMode({ chatId: 'oc_2', chatType: 'p2p' })).toBe('queue')
  })

  it('steer-mode reply injects into a running turn without producing a second reply', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    service.setBusyMode({ chatId: 'oc_1', chatType: 'p2p' }, 'steer')
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    agent.followup.mockClear()
    agent.steer.mockClear()
    agent.status = 'running'
    const busy: string[] = []
    const out = await service.reply(
      { chatId: 'oc_1', chatType: 'p2p', content: 'inject' },
      { onBusy: mode => busy.push(mode) },
    )
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.followup).not.toHaveBeenCalled()
    // No reply of its own — the running turn's reply card already answers it.
    expect(out).toBeUndefined()
    expect(busy).toEqual(['steer'])
  })

  it('queue-mode reply reports onBusy while waiting for the running turn', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    agent.status = 'running'
    const busy: string[] = []
    const out = await service.reply(
      { chatId: 'oc_1', chatType: 'p2p', content: 'queued' },
      { onBusy: mode => busy.push(mode) },
    )
    expect(busy).toEqual(['queue'])
    expect(out).toBe('answer:queued')
  })

  it('forceQueue overrides steer mode for one reply (/queue)', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    service.setBusyMode({ chatId: 'oc_1', chatType: 'p2p' }, 'steer')
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    agent.followup.mockClear()
    agent.steer.mockClear()
    agent.status = 'running'
    // Even in steer mode, forceQueue routes to the queue path (followup), never steer.
    const out = await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'queued' }, { forceQueue: true })
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.steer).not.toHaveBeenCalled()
    const msg = agent.followup.mock.calls[0]![0]
    expect(msg.content).toEqual([{ type: 'text', text: 'queued' }])
    expect(out).toBe('answer:queued')
  })

  it('queue-mode reply drops (TurnDroppedError) when the session is stopped while waiting', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    // Simulate a `/stop` racing in during the queued message's idle wait.
    let stopped = false
    agent.whenIdle = vi.fn(async () => {
      if (!stopped) {
        stopped = true
        service.stopSession({ chatId: 'oc_1', chatType: 'p2p' })
      }
    })
    await expect(service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'queued' }))
      .rejects.toThrow(/session stopped while it was queued/)
  })

  it('stopSession cancels the live agent with keepInbox:false', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    agent.cancel.mockClear()
    expect(service.stopSession({ chatId: 'oc_1', chatType: 'p2p' })).toBe(true)
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  })

  // NOTE: /model selection mutation now goes through the session controller's
  // `selectModel` host API; the plugin no longer maintains a per-chat `selections`
  // map or installs `installModelSelection` against the agent ctx. That logic
  // moved upstream to `packages/api/session-controller`.

  it('isolates different chats and honors an explicit model route', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.selection = () => ({ provider: 'default', model: 'default' })
    const service = new HarnessConversationService(deps, { domain: 'lark', workspace: '/work', provider: 'custom', model: 'model' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    await service.reply({ chatId: 'b', chatType: 'p2p', content: 'two' })
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ agentOptions: { provider: 'custom', model: 'model' }, meta: { cwd: '/work', agentPreset: 'default-preset' } }))
  })

  it('uses the first registered workspace and mounts the default agent preset', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    const options = f.create.mock.calls[0]![0] as any
    expect(options.meta).toEqual({ cwd: '/first-workspace', agentPreset: 'default-preset' })
    const agentCtx = { on: vi.fn(() => () => undefined) } as any
    await options.setup(agentCtx)
    expect(f.resolve).toHaveBeenCalledWith(undefined)
    expect(f.mount).toHaveBeenCalledWith(agentCtx, 'default-preset')
    expect(f.workspace.attachSession).toHaveBeenCalledWith(options.sessionId)
  })

  it('uses and mounts an explicitly configured workspace and preset', async () => {
    const f = fixture()
    const explicit = { path: '/configured', attachSession: vi.fn(async () => undefined) }
    const deps = dependencies(f)
    deps.workspaceRegistry.resolveByPath = vi.fn(async () => explicit)
    const service = new HarnessConversationService(deps, { domain: 'feishu', workspace: '/configured', agentPreset: 'coding' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    const options = f.create.mock.calls[0]![0] as any
    await options.setup({ on: vi.fn(() => () => undefined) } as any)
    expect(f.resolve).toHaveBeenCalledWith('coding')
    expect(explicit.attachSession).toHaveBeenCalledWith(options.sessionId)
  })

  it('disposes a newly created agent when workspace attachment fails', async () => {
    const f = fixture()
    f.workspace.attachSession.mockRejectedValueOnce(new Error('attach failed'))
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).rejects.toThrow('attach failed')
    const handle = await f.create.mock.results[0]!.value
    expect(handle.dispose).toHaveBeenCalledOnce()
  })

  it('surfaces the structured turn failure instead of a generic sentence', async () => {
    const failure = { message: 'DeepSeek Messages request failed (413)', code: 'INVALID_REQUEST', status: 413 }
    const create = vi.fn(async ({ sessionId }: any) => ({ agent: { session: { id: sessionId, seq: 0, events: [{ seq: 0, type: 'turn/end', data: { reason: { kind: 'error', error: failure } } }] }, whenIdle: async () => undefined, followup() {}, steer() {}, cancel() {}, status: 'idle' as const }, dispose: async () => undefined }))
    const service = new HarnessConversationService({ agents: { create, resume: vi.fn(), get: () => undefined }, sessions: { flush: async () => true }, sessionPersistence: { list: async () => [] }, selection: () => ({ provider: 'p', model: 'm' }), agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => undefined }, workspaceRegistry: { list: () => [], resolveByPath: async () => undefined, archivedSessionIds: [] } }, { domain: 'feishu', workspace: '/work' })
    // The Web UI renders exactly these two facts; the error carries them intact
    // so the channel can mirror that rendering.
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).rejects.toMatchObject({
      name: 'TurnFailureError',
      failure: { message: failure.message, code: 'INVALID_REQUEST' },
    })
  })

  it('projects a detail-less error ending the same way the Web UI does', async () => {
    // Every real `error` ending carries a structured `error`; this pins the
    // projection for a payload without one to the Web UI's own rendering of the
    // raw value instead of an invented message.
    const create = vi.fn(async ({ sessionId }: any) => ({ agent: { session: { id: sessionId, seq: 0, events: [{ seq: 0, type: 'turn/end', data: { reason: { kind: 'error' } } }] }, whenIdle: async () => undefined, followup() {}, steer() {}, cancel() {}, status: 'idle' as const }, dispose: async () => undefined }))
    const service = new HarnessConversationService({ agents: { create, resume: vi.fn(), get: () => undefined }, sessions: { flush: async () => true }, sessionPersistence: { list: async () => [] }, selection: () => ({ provider: 'p', model: 'm' }), agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => undefined }, workspaceRegistry: { list: () => [], resolveByPath: async () => undefined, archivedSessionIds: [] } }, { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).rejects.toMatchObject({
      name: 'TurnFailureError',
      failure: { message: 'undefined' },
    })
  })

  it('does not report an aborted turn as a failure', async () => {
    // `/stop` (or an interrupting message) aborts the turn: the Web UI keeps the
    // streamed output and shows no error row, so reply() must not raise one.
    const create = vi.fn(async ({ sessionId }: any) => ({ agent: { session: { id: sessionId, seq: 0, events: [
      { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial answer' }] } } },
      { seq: 1, type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ] }, whenIdle: async () => undefined, followup() {}, steer() {}, cancel() {}, status: 'idle' as const }, dispose: async () => undefined }))
    const service = new HarnessConversationService({ agents: { create, resume: vi.fn(), get: () => undefined }, sessions: { flush: async () => true }, sessionPersistence: { list: async () => [] }, selection: () => ({ provider: 'p', model: 'm' }), agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => undefined }, workspaceRegistry: { list: () => [], resolveByPath: async () => undefined, archivedSessionIds: [] } }, { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).resolves.toBe('partial answer')
  })

  it('reply bounds the event snapshot to the current turn instead of the whole history', async () => {
    // The host-from-source Session exposes `snapshotEvents(fromSeq, toSeqExclusive)`
    // with a no-arg default that copies the ENTIRE log (and caches it). reply()
    // only summarises the current turn (events with `seq >= firstSeq`), so it must
    // pass `firstSeq` rather than snapshot everything — on a bloated session that
    // copy is the amplifier behind the "heap out of memory" crashes.
    const snapshotEvents = vi.fn((fromSeq?: number) => [
      { seq: 100, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
      { seq: 101, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ])
    const create = vi.fn(async ({ sessionId }: any) => ({
      agent: {
        session: { id: sessionId, seq: 100, snapshotEvents },
        whenIdle: async () => undefined,
        followup() {}, steer() {}, cancel() {}, status: 'idle' as const,
      },
      dispose: async () => undefined,
    }))
    const service = new HarnessConversationService({ agents: { create, resume: vi.fn(), get: () => undefined }, sessions: { flush: async () => true }, sessionPersistence: { list: async () => [] }, selection: () => ({ provider: 'p', model: 'm' }), agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => undefined }, workspaceRegistry: { list: () => [], resolveByPath: async () => undefined, archivedSessionIds: [] } }, { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).resolves.toBe('done')
    expect(snapshotEvents).toHaveBeenCalledWith(100)
    expect(snapshotEvents).not.toHaveBeenCalledWith()
  })

  it('listSessions filters out the workspace archive set', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [
      { id: 'kept-1' },
      { id: 'gone-1' },
      { id: 'kept-2' },
    ])
    deps.workspaceRegistry = { ...deps.workspaceRegistry, archivedSessionIds: ['gone-1'] }
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const sessions = await service.listSessions()
    expect(sessions.map(s => s.id)).toEqual(['kept-1', 'kept-2'])
  })

  it('listSessions filters out live blank sessions (no turn/start)', async () => {
    const f = fixture()
    const sessionId = 'lark-v2-test-blank'
    const blankHandle = await f.create({ sessionId: sessionId as never })
    blankHandle.agent.session.events.push(
      { seq: 0, type: 'session', data: {} },
      { seq: 1, type: 'session/end-seed', data: {} },
    )
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const sessions = await service.listSessions()
    expect(sessions.map(s => s.id)).toEqual([])
  })

  it('listSessions shows the agent preset display name', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const sessionId = 'lark-v2-test-preset'
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    deps.sessionPersistence.readFrom = vi.fn(async () => ({
      meta: { agentPreset: 'ptc', createdAt: 1000 },
      events: [
        { seq: 0, type: 'session', data: {}, time: 1000 },
        { seq: 1, type: 'turn/start', data: {}, time: 1000 },
        { seq: 2, type: 'session/title', data: { title: 'Preset session' }, time: 1000 },
      ],
    }))
    deps.agentPresets.list = vi.fn(async () => [{ id: 'ptc', name: 'PTC 模式' }])
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const sessions = await service.listSessions()
    expect(sessions).toHaveLength(1)
    const first = sessions[0]!
    expect(first.id).toBe(sessionId)
    expect(first.agentPreset).toBe('PTC 模式')
  })

  it('listSessions filters out subagent sessions (durable origin: subagent)', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const sessionId = 'lark-v2-test-subagent'
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    deps.sessionPersistence.readFrom = vi.fn(async () => ({
      meta: { origin: 'subagent', parentSession: 'lark-v2-parent', agentPreset: 'ptc', createdAt: 1000 },
      events: [
        { seq: 0, type: 'session', data: {}, time: 1000 },
        { seq: 1, type: 'turn/start', data: {}, time: 1000 },
        { seq: 2, type: 'session/title', data: { title: 'Child session' }, time: 1000 },
      ],
    }))
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const sessions = await service.listSessions()
    expect(sessions.map(s => s.id)).toEqual([])
  })

  it('listSessions keeps forked sessions that have a parentSession but no subagent origin', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const sessionId = 'lark-v2-test-fork'
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    deps.sessionPersistence.readFrom = vi.fn(async () => ({
      meta: { parentSession: 'lark-v2-parent', agentPreset: 'ptc', createdAt: 1000 },
      events: [
        { seq: 0, type: 'session', data: {}, time: 1000 },
        { seq: 1, type: 'turn/start', data: {}, time: 1000 },
        { seq: 2, type: 'session/title', data: { title: 'Forked session' }, time: 1000 },
      ],
    }))
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const sessions = await service.listSessions()
    expect(sessions.map(s => s.id)).toEqual([sessionId])
  })

  it('getSessionMeta follows the agent-preset/selected event over the creation header', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.sessionPersistence.readFrom = vi.fn(async () => ({
      meta: { cwd: '/w', agentPreset: 'standard', createdAt: 1000 },
      events: [
        { seq: 0, type: 'session', data: {}, time: 1000 },
        { seq: 1, type: 'turn/start', data: {}, time: 1000 },
        // Blank-session preset switch recorded after creation: the header still
        // says `standard`, but the effective preset is `cordis`.
        { seq: 2, type: 'agent-preset/selected', data: { agentPreset: 'cordis' }, time: 1000 },
      ],
    }))
    deps.agentPresets.list = vi.fn(async () => [{ id: 'cordis', name: '创造模式' }, { id: 'standard', name: '标准模式' }])
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const meta = await service.getSessionMeta({ chatId: 'a', chatType: 'p2p' })
    expect(meta.agentPreset).toBe('创造模式')
  })

  it('getSessionMeta falls back to the creation header preset when no switch event exists', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.sessionPersistence.readFrom = vi.fn(async () => ({
      meta: { cwd: '/w', agentPreset: 'standard', createdAt: 1000 },
      events: [
        { seq: 0, type: 'session', data: {}, time: 1000 },
        { seq: 1, type: 'turn/start', data: {}, time: 1000 },
      ],
    }))
    deps.agentPresets.list = vi.fn(async () => [{ id: 'standard', name: '标准模式' }])
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const meta = await service.getSessionMeta({ chatId: 'a', chatType: 'p2p' })
    expect(meta.agentPreset).toBe('标准模式')
  })

  it('switchToSession refuses to redirect a chat to an archived session', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.workspaceRegistry = { ...deps.workspaceRegistry, archivedSessionIds: ['gone-1'] }
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const chatMessage = { chatId: 'a', chatType: 'p2p' as const }
    expect(service.switchToSession(chatMessage, 'gone-1')).toBe('archived')
    expect(service.switchToSession(chatMessage, 'kept-1')).toBe('ok')
  })

  it('refuses to switch onto a session owned by another chat key', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    // Topic A runs /new, binding session-new to topic key thread:a:t1
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    const newId = service.startNewSession(topicA, 's1')
    // The main chat of the same group cannot /session onto it
    const main = { chatId: 'a', chatType: 'p2p' as const }
    expect(service.sessionOwnerKey(newId)).toBe('thread:a:t1')
    expect(service.switchToSession(main, newId)).toBe('occupied')
    // But switching the owning topic back to its own session is fine
    expect(service.switchToSession(topicA, newId)).toBe('ok')
  })

  it('derives default-derived session ownership (no explicit /new)', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    // Resolving the session id records the key in seenChatKeys
    const defaultId = service.resolveSessionIdFor(topicA)
    const main = { chatId: 'a', chatType: 'p2p' as const }
    expect(service.sessionOwnerKey(defaultId)).toBe('thread:a:t1')
    expect(service.switchToSession(main, defaultId)).toBe('occupied')
  })

  it('persists and restores seenChatKeys across restarts', async () => {
    const statePath = join(tmpdir(), `lark-map-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    const newId = service.startNewSession(topicA, 's1')
    expect(service.sessionOwnerKey(newId)).toBe('thread:a:t1')
    // New service instance reads the same file back
    const service2 = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    expect(service2.sessionOwnerKey(newId)).toBe('thread:a:t1')
  })

  it('records chat keys on first resolve so default ownership survives restarts', async () => {
    const statePath = join(tmpdir(), `lark-map-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    // Resolving without /new persists the key
    const defaultId = service.resolveSessionIdFor(topicA)
    const service2 = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    expect(service2.sessionOwnerKey(defaultId)).toBe('thread:a:t1')
  })

  it('resolveChat carries the topic root so WebUI-driven cards stay in the topic', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'group' as const, threadId: 't1' }
    const sessionId = service.startNewSession(topicA, 's1')
    // Before any inbound message in the topic the root is unknown: a send
    // built from these coordinates would fall back to a top-level message.
    expect(service.resolveChat(sessionId)).toEqual({ chatId: 'a', chatType: 'p2p', threadId: 't1' })
    service.noteTopic({ ...topicA, rootId: 'om_root' })
    expect(service.resolveChat(sessionId)).toEqual({ chatId: 'a', chatType: 'p2p', threadId: 't1', rootId: 'om_root' })
  })

  it('persists topic roots across restarts', async () => {
    const statePath = join(tmpdir(), `lark-topic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    const topicA = { chatId: 'a', chatType: 'group' as const, threadId: 't1' }
    const sessionId = service.startNewSession(topicA, 's1')
    service.noteTopic({ ...topicA, rootId: 'om_root' })
    // A restart (a fresh instance reading the same state file) must still know
    // where the topic is — this is what a WebUI-driven turn depends on.
    const restarted = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    expect(restarted.resolveChat(sessionId)).toEqual({ chatId: 'a', chatType: 'p2p', threadId: 't1', rootId: 'om_root' })
    expect(restarted.topicFor('a')).toEqual({ threadId: 't1', rootId: 'om_root' })
  })

  it('noteTopic ignores thread-less chats and empty roots', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    service.noteTopic({ chatId: 'a', chatType: 'p2p', rootId: 'om_root' })
    expect(service.topicFor('a')).toEqual({})
    service.noteTopic({ chatId: 'a', chatType: 'p2p', threadId: 't1' })
    expect(service.topicFor('a')).toEqual({})
  })

  it('topicFor returns the most recently used topic of a chat, and nothing without a root', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    service.noteTopic({ chatId: 'a', chatType: 'group', threadId: 't1', rootId: 'om_1' })
    service.noteTopic({ chatId: 'a', chatType: 'group', threadId: 't2', rootId: 'om_2' })
    expect(service.topicFor('a')).toEqual({ threadId: 't2', rootId: 'om_2' })
    // Going back to t1 makes it the current one again
    service.noteTopic({ chatId: 'a', chatType: 'group', threadId: 't1', rootId: 'om_1' })
    expect(service.topicFor('a')).toEqual({ threadId: 't1', rootId: 'om_1' })
    // Another chat's topics are not reported
    expect(service.topicFor('b')).toEqual({})
  })

  it('missingTopicRoots lists topics without a root and setTopicRoot fills them', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'group' as const, threadId: 't1' }
    const topicB = { chatId: 'a', chatType: 'group' as const, threadId: 't2' }
    service.resolveSessionIdFor(topicA)
    service.resolveSessionIdFor(topicB)
    service.noteTopic({ ...topicA, rootId: 'om_1' })
    expect(service.missingTopicRoots()).toEqual([{ chatId: 'a', threadId: 't2' }])
    service.setTopicRoot('a', 't2', 'om_2')
    expect(service.missingTopicRoots()).toEqual([])
    expect(service.topicFor('a')).toEqual({ threadId: 't2', rootId: 'om_2' })
  })

  it('detachSession resets the owner to a fresh session and frees the target', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    const newId = service.startNewSession(topicA, 's1')
    const outcome = service.detachSession(newId)
    expect(outcome).toEqual({ kind: 'released', ownerLabel: '话题(t1…)' })
    expect(service.sessionOwnerKey(newId)).toBeUndefined()
    // The owner's next message goes to a different (fresh) session
    expect(service.resolveSessionIdFor(topicA)).not.toBe(newId)
  })

  it('detachSession on a free session reports free', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    expect(service.detachSession('unowned-1')).toEqual({ kind: 'free' })
  })

  it('forwards image blocks into the user-turn content array', async () => {
    const f = fixture()
    let captured: any
    const original = f.create.getMockImplementation()
    f.create.mockImplementationOnce(async (input: any) => {
      const handle = await original!(input)
      handle.agent.followup = vi.fn((message: any) => {
        captured = message
        const seq = handle.agent.session.events.length
        handle.agent.session.events.push(
          { seq, type: 'turn/start', data: {} },
          { seq: seq + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer:${message.content[0].text}` }] } } },
          { seq: seq + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
        )
      })
      return handle
    })
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    const ref = {
      attachmentId: 'att_1' as never,
      mediaType: 'image/jpeg' as const,
      bytes: 4,
      width: 1,
      height: 1,
    }
    await expect(service.reply({
      chatId: 'oc_1', chatType: 'p2p',
      content: 'describe this',
      imageBlocks: [ref],
    })).resolves.toBe('answer:describe this')
    expect(captured).toMatchObject({
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', attachment: ref },
      ],
    })
  })

  it('submits image-only messages with no text block at all', async () => {
    const f = fixture()
    let captured: any
    const original = f.create.getMockImplementation()
    f.create.mockImplementationOnce(async (input: any) => {
      const handle = await original!(input)
      handle.agent.followup = vi.fn((message: any) => {
        captured = message
        const seq = handle.agent.session.events.length
        handle.agent.session.events.push(
          { seq, type: 'turn/start', data: {} },
          { seq: seq + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
          { seq: seq + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
        )
      })
      return handle
    })
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    const ref = {
      attachmentId: 'att_2' as never,
      mediaType: 'image/png' as const,
      bytes: 8,
      width: 2,
      height: 2,
    }
    await expect(service.reply({
      chatId: 'oc_2', chatType: 'p2p',
      content: '',
      imageBlocks: [ref, ref],
    })).resolves.toBe('ok')
    expect(captured.content).toEqual([
      { type: 'image', attachment: ref },
      { type: 'image', attachment: ref },
    ])
  })

  it('rejects an inbound message that carries neither text nor images', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'oc_3', chatType: 'p2p', content: '' })).rejects.toThrow(/empty user turn/)
  })

  it('sends the user text verbatim, with no channel prefix', async () => {
    const f = fixture()
    let captured: any
    const original = f.create.getMockImplementation()
    f.create.mockImplementationOnce(async (input: any) => {
      const handle = await original!(input)
      handle.agent.followup = vi.fn((message: any) => {
        captured = message
        const seq = handle.agent.session.events.length
        handle.agent.session.events.push(
          { seq, type: 'turn/start', data: {} },
          { seq: seq + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
          { seq: seq + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
        )
      })
      return handle
    })
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await service.reply({ chatId: 'oc_4', chatType: 'p2p', content: 'hello' })
    expect(captured.content[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('needsOnboarding is true for a chat with no session history and false after /new', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    expect(await service.needsOnboarding(topicA)).toBe(true)
    service.startNewSession(topicA, 's1')
    expect(await service.needsOnboarding(topicA)).toBe(false)
  })

  it('needsOnboarding is false when the default-derived session already exists', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: 'lark-v2-something' }])
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const main = { chatId: 'b', chatType: 'p2p' as const }
    // The default-derived session for chat:b is a deterministic hash; fabricate
    // it as existing so needsOnboarding resolves false.
    const defaultId = service.resolveSessionIdFor(main)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: defaultId }])
    expect(await service.needsOnboarding(main)).toBe(false)
  })

  it('attachSession force-takes over a session owned by another chat', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    const topicAId = service.startNewSession(topicA, 's1')
    expect(service.sessionOwnerKey(topicAId)).toBe('thread:a:t1')
    const main = { chatId: 'a', chatType: 'p2p' as const }
    // Force takeover from the main chat
    expect(service.attachSession(main, topicAId)).toBe('ok')
    expect(service.sessionOwnerKey(topicAId)).toBe('chat:a')
    // The previous owner (topic A) was reset to a fresh session
    expect(service.resolveSessionIdFor(topicA)).not.toBe(topicAId)
  })

  it('attachSession rebinds a chat and releases its previous session (no ghost push)', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const A = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    // A explicitly owns S1 via /new, then switches to S2.
    const S1 = service.startNewSession(A, 'orig')
    expect(service.resolveSessionIdFor(A)).toBe(S1)
    const S2 = service.startNewSession(A, 'switch-target')
    expect(service.attachSession(A, S2)).toBe('ok')
    // A now resolves to S2...
    expect(service.resolveSessionIdFor(A)).toBe(S2)
    // ...and the old S1 no longer resolves to A (no ghost cards to A after the switch).
    expect(service.resolveChat(S1)).toBeUndefined()
    expect(service.sessionOwnerKey(S1)).toBeUndefined()
  })

  it('startNewSession stores creation options and createAgent honors them', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    const sessionId = service.startNewSession(topicA, 's1', {
      workspace: '/other-ws',
      agentPreset: 'researcher',
      provider: 'openai',
      model: 'gpt-4o',
    })
    expect(sessionId).not.toBe('')
    // createAgent is exercised via reply(); the first create call carries the
    // sessionId and the meta should reflect the per-chat creation options.
    const f2 = fixture()
    const service2 = new HarnessConversationService(dependencies(f2), { domain: 'feishu', workspace: '/work' })
    service2.startNewSession(topicA, 's1', {
      workspace: '/other-ws',
      agentPreset: 'researcher',
      provider: 'openai',
      model: 'gpt-4o',
    })
    f2.create.mockImplementationOnce(async (input: any) => {
      const handle = await f2.create.getMockImplementation()!(input)
      return handle
    })
    await service2.reply({ chatId: 'a', chatType: 'p2p', threadId: 't1', content: 'hello' })
    const createCall = f2.create.mock.calls[0]![0] as any
    expect(createCall.sessionId).toBe(service2.resolveSessionIdFor(topicA))
    expect(createCall.agentOptions).toMatchObject({ provider: 'openai', model: 'gpt-4o' })
  })

  it('installs the /new route through the session controller so the first prompt keeps it', async () => {
    // Creating the agent with agentOptions is NOT enough: the session
    // controller's own selection listener overwrites the route with the global
    // default for a session without a request header. The creation route has to
    // go through selectModel, exactly like the Web UI model picker does.
    const f = fixture()
    const deps = dependencies(f)
    const selectModel = vi.fn(async (_request: any) => ({}))
    deps.sessionController = { selectModel }
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    service.startNewSession(topicA, 's1', { provider: 'minimax-cn', model: 'MiniMax-M3', reasoningEffort: 'low' as never })
    await service.reply({ chatId: 'a', chatType: 'p2p', threadId: 't1', content: 'hello' })
    expect(selectModel).toHaveBeenCalledTimes(1)
    expect(selectModel.mock.calls[0]![0]).toEqual({
      sessionId: service.resolveSessionIdFor(topicA),
      provider: 'minimax-cn',
      model: 'MiniMax-M3',
      reasoningEffort: 'low',
    })
  })

  it('does not touch the model route when /new carried no model', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const selectModel = vi.fn(async () => ({}))
    deps.sessionController = { selectModel }
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    service.startNewSession(topicA, 's1', { workspace: '/other-ws' })
    await service.reply({ chatId: 'a', chatType: 'p2p', threadId: 't1', content: 'hello' })
    expect(selectModel).not.toHaveBeenCalled()
  })

  it('keeps the session usable when installing the creation route fails', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    deps.sessionController = { selectModel: vi.fn(async () => { throw new Error('unknown model') }) }
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    service.startNewSession(topicA, 's1', { provider: 'p', model: 'does-not-exist' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', threadId: 't1', content: 'hello' })).resolves.toBe('answer:hello')
    expect(log.mock.calls.some(call => String(call[0]).includes('could not apply the /new model route'))).toBe(true)
    log.mockRestore()
  })
})
