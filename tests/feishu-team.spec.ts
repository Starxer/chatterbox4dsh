import { describe, expect, it, vi } from 'vitest'
import {
  parseTeamProjection,
  renderTeamBoardCard,
  startFeishuTeam,
  teamBoardSignature,
  type TeamBoardView,
} from '../src/feishu-team.ts'
import { en, zh } from '../src/i18n.ts'
import type { ConversationMessage } from '../src/conversation.ts'

/** The one chat every test binds session-1 to. */
const chats: Record<string, ConversationMessage> = {
  'session-1': { chatId: 'oc_1', chatType: 'p2p', threadId: 'omt_1', rootId: 'om_root' },
}

/** One `agentTeam` projection payload with the fields the board reads. */
function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    members: [
      { id: 'session-1', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'child-1', name: 'alice', role: 'teammate', phase: 'active' },
    ],
    tasks: [
      {
        id: 'task-1',
        revision: 1,
        subject: 'Audit the parser',
        description: 'read-only audit',
        status: 'pending',
        blockedBy: [],
        writeScopes: [],
        ready: true,
        writeScopeWarnings: [],
      },
    ],
    ...overrides,
  }
}

/** All markdown text of one card, so assertions read like the rendered output. */
function markdownOf(card: any): string {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    .join('\n')
}

/** One board view with only the fields a test cares about overridden. */
function view(overrides: Partial<TeamBoardView> = {}): TeamBoardView {
  return {
    members: [
      { id: 'session-1', name: 'lead', role: 'lead', status: 'running' },
      { id: 'child-1', name: 'alice', role: 'teammate', status: 'running' },
    ],
    tasks: [
      { id: 'task-1', subject: 'Audit the parser', status: 'in_progress', blockedBy: [], ready: true, writeScopeWarnings: [] },
    ],
    ...overrides,
  }
}

describe('parseTeamProjection', () => {
  it('reads the durable roster and task board', () => {
    const board = parseTeamProjection(projection())!
    expect(board.members.map(member => [member.id, member.name, member.role])).toEqual([
      ['session-1', 'lead', 'lead'],
      ['child-1', 'alice', 'teammate'],
    ])
    expect(board.tasks).toHaveLength(1)
    expect(board.tasks[0]).toMatchObject({ id: 'task-1', subject: 'Audit the parser', status: 'pending', ready: true })
    expect(board.failure).toBeUndefined()
  })

  it('overlays a teammate phase with the live turn activity, and never invents the Lead\'s', () => {
    const running = { get: (id: string) => (id === 'child-1' ? { status: 'running' } : undefined) }
    const board = parseTeamProjection(projection(), running)!
    expect(board.members[0]!.status).toBe('running')
    expect(board.members[1]!.status).toBe('running')

    const idle = parseTeamProjection(projection(), { get: () => ({ status: 'idle' }) })!
    expect(idle.members[1]!.status).toBe('inactive')
  })

  it('keeps provisioning and failed teammates distinct, including the failure reason', () => {
    const board = parseTeamProjection(projection({
      members: [
        { id: 'session-1', name: 'lead', role: 'lead', phase: 'active' },
        { id: 'child-1', name: 'alice', role: 'teammate', phase: 'provisioning' },
        { id: 'child-2', name: 'bob', role: 'teammate', phase: 'failed', error: 'spawn timed out' },
      ],
    }))!
    expect(board.members.map(member => member.status)).toEqual(['running', 'provisioning', 'failed'])
    expect(board.members[2]!.error).toBe('spawn timed out')
  })

  it('drops deleted tombstones and unusable rows instead of rendering garbage', () => {
    const board = parseTeamProjection(projection({
      tasks: [
        { id: 'task-1', status: 'completed', subject: 'done', blockedBy: [], ready: true, writeScopeWarnings: [] },
        { id: 'task-2', status: 'deleted', subject: 'gone', blockedBy: [], ready: true, writeScopeWarnings: [] },
        { id: '', status: 'pending', subject: 'no id' },
        { id: 'task-3', status: 'weird', subject: 'bad status' },
        'not-an-object',
      ],
      members: [{ id: 'session-1', name: 'lead', role: 'lead', phase: 'active' }, 7],
    }))!
    expect(board.tasks.map(task => task.id)).toEqual(['task-1'])
    expect(board.members).toHaveLength(1)
  })

  it('returns undefined when the payload is not a Team projection', () => {
    for (const value of [undefined, null, 'x', {}, { members: [{}], tasks: [] }, { members: [], tasks: [] }]) {
      expect(parseTeamProjection(value)).toBeUndefined()
    }
  })

  it('carries the invalid-record failure to the card', () => {
    const board = parseTeamProjection(projection({ failure: 'team task "task-1" revision is not contiguous' }))!
    expect(board.failure).toContain('revision is not contiguous')
  })
})

describe('teamBoardSignature', () => {
  it('is stable for the same board and changes with any real change', () => {
    const base = view()
    expect(teamBoardSignature(base)).toBe(teamBoardSignature(view()))
    expect(teamBoardSignature(base)).not.toBe(teamBoardSignature(view({
      tasks: [{ id: 'task-1', subject: 'Audit the parser', status: 'completed', blockedBy: [], ready: true, writeScopeWarnings: [] }],
    })))
    expect(teamBoardSignature(base)).not.toBe(teamBoardSignature(view({
      members: [
        { id: 'session-1', name: 'lead', role: 'lead', status: 'running' },
        { id: 'child-1', name: 'alice', role: 'teammate', status: 'inactive' },
      ],
    })))
  })

  it('ignores the Lead\'s own turn activity, which would repost on every message', () => {
    const idleLead = view({
      members: [
        { id: 'session-1', name: 'lead', role: 'lead', status: 'inactive' },
        { id: 'child-1', name: 'alice', role: 'teammate', status: 'running' },
      ],
    })
    expect(teamBoardSignature(view())).toBe(teamBoardSignature(idleLead))
  })
})

describe('renderTeamBoardCard', () => {
  it('titles the card and summarizes the board', () => {
    const card = renderTeamBoardCard(view(), zh) as any
    expect(card.header.title.content).toBe(zh.teamBoardTitle)
    expect(card.header.template).toBe('turquoise')
    expect(markdownOf(card)).toContain(zh.teamBoardSummary(1, 1, 2))
  })

  it('draws the Lead as the role and every teammate by its live status', () => {
    const text = markdownOf(renderTeamBoardCard(view(), en) as any)
    expect(text).toContain(`👑 **lead**${en.teamBoardLeadTag}`)
    expect(text).toContain(`🟢 **alice** · ${en.teamMemberRunning}`)
    expect(text).toContain(en.teamBoardMembersHeader)
  })

  it('renders the shared task table with owner, readiness and dependencies', () => {
    const board = view({
      tasks: [
        { id: 'task-1', subject: 'Audit the parser', status: 'in_progress', ownerName: 'alice', blockedBy: [], ready: true, writeScopeWarnings: [] },
        { id: 'task-2', subject: 'Merge the fix', status: 'pending', blockedBy: ['task-1'], ready: false, writeScopeWarnings: [] },
      ],
    })
    const text = markdownOf(renderTeamBoardCard(board, en) as any)
    expect(text).toContain(en.teamBoardTasksHeader(2))
    expect(text).toContain(`| ${en.teamBoardColTask} | ${en.teamBoardColStatus} | ${en.teamBoardColOwner} | ${en.teamBoardColDependencies} |`)
    expect(text).toContain('task-1 Audit the parser')
    expect(text).toContain(`🔄 ${en.teamTaskInProgress}`)
    expect(text).toContain('alice')
    // An unowned, blocked task says both facts on its row.
    expect(text).toContain('task-2 Merge the fix')
    expect(text).toContain(en.teamBoardUnowned)
    expect(text).toContain(en.teamBoardBlockedNote)
    expect(text).toContain('task-1 |')
    const dataRows = text.split('\n').filter(line => line.startsWith('| ') && !line.includes('---') && !line.includes(en.teamBoardColTask))
    expect(dataRows).toHaveLength(2)
  })

  it('says there is no shared task yet instead of printing an empty table', () => {
    const text = markdownOf(renderTeamBoardCard(view({ tasks: [] }), en) as any)
    expect(text).toContain(en.teamBoardEmpty)
    expect(text).not.toContain('| ---')
  })

  it('caps the rows and counts the rest', () => {
    const tasks = Array.from({ length: 15 }, (_, index) => ({
      id: `task-${index + 1}`,
      subject: `task ${index + 1}`,
      status: 'pending' as const,
      blockedBy: [],
      ready: true,
      writeScopeWarnings: [],
    }))
    const text = markdownOf(renderTeamBoardCard(view({ tasks }), en) as any)
    expect(text).toContain(en.teamBoardMore(3))
    const dataRows = text.split('\n').filter(line => line.startsWith('| ') && !line.includes('---') && !line.includes(en.teamBoardColTask))
    expect(dataRows).toHaveLength(12)
  })

  it('surfaces write-scope warnings and an invalid persisted record', () => {
    const board = view({
      tasks: [{
        id: 'task-1', subject: 'x', status: 'in_progress', blockedBy: [], ready: true, writeScopeWarnings: ['overlaps src/index.ts'],
      }],
      failure: 'team member name "alice" is reused',
    })
    const text = markdownOf(renderTeamBoardCard(board, en) as any)
    expect(text).toContain('overlaps src/index.ts')
    expect(text).toContain(en.teamBoardFailure('team member name "alice" is reused'))
  })
})

function buildHarness(options: {
  chats?: Record<string, ConversationMessage>
  state?: () => unknown
  running?: Record<string, boolean>
  projections?: unknown
  debounceMs?: number
  refreshMs?: number
} = {}) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const sent: Array<{ to: string; card: any; opts: any }> = []
  const warns: string[] = []
  const infos: string[] = []
  const chatsMap = options.chats ?? chats
  const ctx = {
    on: (name: string, listener: (...args: any[]) => void) => {
      let set = listeners.get(name)
      if (set === undefined) {
        set = new Set()
        listeners.set(name, set)
      }
      set.add(listener)
      return () => { set.delete(listener) }
    },
  }
  const running = options.running ?? {}
  const handle = startFeishuTeam({
    ctx: ctx as never,
    channel: {
      send: async (to, input, opts) => {
        sent.push({ to, card: input.card, opts })
        return { messageId: `m-${sent.length}` }
      },
    },
    bridgeHolder: { current: { resolveChat: sessionId => chatsMap[sessionId] } },
    logger: {
      info: (message: string) => { infos.push(message); return undefined },
      warn: (message: string) => { warns.push(message); return undefined },
      error: () => undefined,
    },
    getTranslations: () => zh,
    projections: options.projections === undefined
      ? {
          snapshot: (_session: unknown, keys?: readonly string[]) => ({
            values: keys?.includes('agentTeam') === true ? { agentTeam: options.state?.() } : {},
          }),
        } as never
      : options.projections as never,
    agents: { get: (id: string) => (id in running ? { status: running[id] ? 'running' : 'idle' } : undefined) },
    debounceMs: options.debounceMs ?? 0,
    refreshMs: options.refreshMs ?? 0,
  })
  return {
    handle,
    sent,
    warns,
    infos,
    sessionEvent: (sessionId: string, event: unknown) => {
      for (const listener of [...(listeners.get('session/event') ?? [])]) listener({ id: sessionId }, event)
    },
    listenerCount: (name: string) => listeners.get(name)?.size ?? 0,
  }
}

/** Let the panel's zero-delay coalescing timer flush. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

describe('startFeishuTeam', () => {
  it('posts one board card when a Team appears in a Feishu-bound session', async () => {
    const h = buildHarness({ state: () => projection() })
    h.sessionEvent('session-1', { type: 'team/member' })
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.to).toBe('oc_1')
    // Cards land in the topic of the session they describe (关键坑 25/31).
    expect(h.sent[0]!.opts).toEqual({ replyInThread: true, replyTo: 'om_root' })
    const text = markdownOf(h.sent[0]!.card)
    expect(text).toContain('alice')
    expect(text).toContain('Audit the parser')
    h.handle.dispose()
  })

  it('ignores Teams rooted outside Feishu (no chat is bound)', async () => {
    const h = buildHarness({ state: () => projection() })
    h.sessionEvent('session-unbound', { type: 'team/member' })
    await settle()
    expect(h.sent).toHaveLength(0)
    h.handle.dispose()
  })

  it('does not repost when nothing changed', async () => {
    const h = buildHarness({ state: () => projection() })
    h.sessionEvent('session-1', { type: 'team/member' })
    await settle()
    expect(h.sent).toHaveLength(1)
    h.sessionEvent('session-1', { type: 'team/task' })
    await settle()
    expect(h.sent).toHaveLength(1)
    h.handle.dispose()
  })

  it('posts a fresh card when a task changes', async () => {
    let state: Record<string, unknown> = projection()
    const h = buildHarness({ state: () => state })
    h.sessionEvent('session-1', { type: 'team/task' })
    await settle()
    expect(h.sent).toHaveLength(1)
    state = projection({
      tasks: [{
        id: 'task-1', revision: 2, subject: 'Audit the parser', status: 'completed',
        blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [],
      }],
    })
    h.sessionEvent('session-1', { type: 'team/task' })
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(markdownOf(h.sent[1]!.card)).toContain('✅')
    h.handle.dispose()
  })

  it('repaints a teammate turn edge but not the Lead\'s own turns', async () => {
    const running: Record<string, boolean> = { 'child-1': true }
    const h = buildHarness({ state: () => projection(), running })
    h.sessionEvent('session-1', { type: 'team/member' })
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(markdownOf(h.sent[0]!.card)).toContain(zh.teamMemberRunning)

    // A Lead turn is the chat's own turn: its row shows the role, not activity.
    h.sessionEvent('session-1', { type: 'turn/start' })
    await settle()
    expect(h.sent).toHaveLength(1)

    // The teammate finished its turn: the activity column changed.
    running['child-1'] = false
    h.sessionEvent('child-1', { type: 'turn/end' })
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(markdownOf(h.sent[1]!.card)).toContain(zh.teamMemberInactive)
    h.handle.dispose()
  })

  it('stays silent when the Team projection is unavailable or unreadable', async () => {
    const unreadable = buildHarness({
      projections: { snapshot: () => { throw new Error('projection registry is disposing') } },
    })
    unreadable.sessionEvent('session-1', { type: 'team/member' })
    await settle()
    expect(unreadable.sent).toHaveLength(0)
    expect(unreadable.warns.join('\n')).toContain('team projection read failed')
    unreadable.handle.dispose()

    const missing = buildHarness({
      projections: { snapshot: () => ({ values: {} }) },
    })
    missing.sessionEvent('session-1', { type: 'team/member' })
    await settle()
    expect(missing.sent).toHaveLength(0)
    missing.handle.dispose()

    const noService = buildHarness({})
    noService.handle.dispose()
  })

  it('reads no projection at all when the composition has none', async () => {
    const listeners = new Map<string, Set<(...args: any[]) => void>>()
    const sent: unknown[] = []
    const infos: string[] = []
    const handle = startFeishuTeam({
      ctx: {
        on: (name: string, listener: (...args: any[]) => void) => {
          let set = listeners.get(name)
          if (set === undefined) { set = new Set(); listeners.set(name, set) }
          set.add(listener)
          return () => { set.delete(listener) }
        },
      } as never,
      channel: { send: async (_to, input) => { sent.push(input.card); return {} } },
      bridgeHolder: { current: { resolveChat: () => chats['session-1']! } },
      logger: {
        info: (message: string) => { infos.push(message); return undefined },
        warn: () => undefined,
        error: () => undefined,
      },
      getTranslations: () => zh,
    })
    for (const listener of [...(listeners.get('session/event') ?? [])]) listener({ id: 'session-1' }, { type: 'team/member' })
    await settle()
    expect(sent).toHaveLength(0)
    expect(infos.join('\n')).toContain('the Agent Teams board stays off')
    handle.dispose()
  })

  it('never posts a board for a lone Lead', async () => {
    const h = buildHarness({
      state: () => ({ members: [{ id: 'session-1', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] }),
    })
    h.sessionEvent('session-1', { type: 'team/member' })
    await settle()
    expect(h.sent).toHaveLength(0)
    h.handle.dispose()
  })

  it('stops listening and posting after dispose', async () => {
    const h = buildHarness({ state: () => projection() })
    h.handle.dispose()
    expect(h.listenerCount('session/event')).toBe(0)
    h.sessionEvent('session-1', { type: 'team/member' })
    await settle()
    expect(h.sent).toHaveLength(0)
  })
})
