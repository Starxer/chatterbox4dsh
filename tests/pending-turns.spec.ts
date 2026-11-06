import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  HarnessConversationService,
  PENDING_TURN_MAX_AGE_MS,
  PENDING_TURN_START_GRACE_MS,
  type PendingTurn,
} from '../src/harness.ts'

function dependencies() {
  return {
    agents: {
      create: async () => { throw new Error('not used') },
      resume: async () => { throw new Error('not used') },
      get: () => undefined,
    },
    sessions: { flush: async () => true },
    sessionPersistence: { list: async () => [] },
    selection: () => ({ provider: 'p', model: 'm' }),
  } as any
}

function statePath(): string {
  return join(tmpdir(), `dsh-feishu-pending-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function record(overrides: Partial<PendingTurn> = {}): Omit<PendingTurn, 'at' | 'attempts'> {
  return {
    key: 'chat:c1',
    sessionId: 's1',
    chatId: 'c1',
    chatType: 'p2p',
    messageId: 'm1',
    senderId: 'ou_1',
    content: 'hello',
    attachments: false,
    ...overrides,
  }
}

function service(path?: string): HarnessConversationService {
  return new HarnessConversationService(dependencies(), path === undefined ? { domain: 'feishu' } : { domain: 'feishu', statePath: path })
}

describe('pending turn bookkeeping', () => {
  it('resends a turn whose session is still marked interrupted', () => {
    const bridge = service()
    bridge.noteSessionTurnStart('s1')
    bridge.notePendingTurn(record())

    const claim = bridge.claimPendingTurns()
    expect(claim.retry).toHaveLength(1)
    expect(claim.retry[0]).toMatchObject({ content: 'hello', attempts: 1 })
    expect(claim.giveUp).toEqual([])
  })

  it('resends at most once, then gives up with a reason to announce', () => {
    const bridge = service()
    bridge.noteSessionTurnStart('s1')
    bridge.notePendingTurn(record())
    expect(bridge.claimPendingTurns().retry).toHaveLength(1)

    // The resend itself died with the next unload: the record survived.
    bridge.notePendingTurn(record(), { keepAttempts: true })
    const second = bridge.claimPendingTurns()
    expect(second.retry).toEqual([])
    expect(second.giveUp.map(entry => entry.reason)).toEqual(['exhausted'])
  })

  it('drops a record whose turn ended (no interrupted marker) after the grace window', () => {
    const bridge = service()
    bridge.notePendingTurn(record())
    const claim = bridge.claimPendingTurns(Date.now() + PENDING_TURN_START_GRACE_MS + 1)
    expect(claim.retry).toEqual([])
    expect(claim.giveUp).toEqual([])
  })

  it('still resends inside the pre-turn grace window when no marker exists', () => {
    const bridge = service()
    bridge.notePendingTurn(record())
    const claim = bridge.claimPendingTurns(Date.now() + 1_000)
    expect(claim.retry).toHaveLength(1)
  })

  it('drops an expired record without announcing it (the startup notice covers it)', () => {
    const bridge = service()
    bridge.noteSessionTurnStart('s1')
    bridge.notePendingTurn(record())
    const claim = bridge.claimPendingTurns(Date.now() + PENDING_TURN_MAX_AGE_MS + 1)
    expect(claim.retry).toEqual([])
    expect(claim.giveUp.map(entry => entry.reason)).toEqual(['expired'])
  })

  it('never resends a message whose attachments a text-only resend cannot rebuild', () => {
    const bridge = service()
    bridge.noteSessionTurnStart('s1')
    bridge.notePendingTurn(record({ attachments: true }))
    const claim = bridge.claimPendingTurns()
    expect(claim.retry).toEqual([])
    expect(claim.giveUp.map(entry => entry.reason)).toEqual(['attachments'])
  })

  it('survives a restart: the next instance loads and claims the record', () => {
    const path = statePath()
    const first = service(path)
    first.noteSessionTurnStart('s1')
    first.notePendingTurn(record({ content: 'survive me' }))

    const second = service(path)
    const claim = second.claimPendingTurns()
    expect(claim.retry).toHaveLength(1)
    expect(claim.retry[0]).toMatchObject({ content: 'survive me', attempts: 1, chatId: 'c1' })
    // Persisted: the claim is visible to a third instance too (and it gives up).
    const third = service(path)
    expect(third.claimPendingTurns().retry).toEqual([])
  })

  it('forgets the record once the reply settles', () => {
    const bridge = service()
    bridge.noteSessionTurnStart('s1')
    bridge.notePendingTurn(record())
    bridge.clearPendingTurn('chat:c1')
    expect(bridge.claimPendingTurns().retry).toEqual([])
  })

  it('keeps the resend budget when the channel replays a claimed record', () => {
    const bridge = service()
    bridge.noteSessionTurnStart('s1')
    bridge.notePendingTurn(record())
    const claimed = bridge.claimPendingTurns().retry[0]!
    bridge.notePendingTurn({ ...claimed, content: 'replayed' }, { keepAttempts: true })
    // A claimed record keeps `attempts: 1`, so a second claim cannot loop.
    expect(bridge.claimPendingTurns().giveUp.map(entry => entry.reason)).toEqual(['exhausted'])
  })
})
