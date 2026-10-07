import { afterEach, describe, expect, it } from 'vitest'
import {
  beginTurn,
  noteDirectFeishuDispatch,
  noteFeishuPrompt,
  noteUserMessage,
  resetTurnOrigins,
  turnOrigin,
} from '../src/feishu-turn-origin.ts'

const SESSION = 'lark-v2-test-session'

afterEach(() => {
  resetTurnOrigins()
})

describe('turn origin from the native message source', () => {
  it('recognises the request id this plugin minted', () => {
    noteFeishuPrompt(SESSION, 'req-1')
    expect(noteUserMessage(SESSION, { kind: 'user', rpcId: 'req-1' })).toBe('feishu')
    expect(turnOrigin(SESSION)).toBe('feishu')
  })

  it('treats a foreign request id with a browser zone as the Web GUI', () => {
    noteFeishuPrompt(SESSION, 'req-1')
    expect(noteUserMessage(SESSION, { kind: 'user', rpcId: 'req-2', clientTimeZone: 'Asia/Shanghai' }))
      .toBe('external-web')
    expect(turnOrigin(SESSION)).toBe('external')
  })

  it('treats a foreign request id without a zone as another surface', () => {
    expect(noteUserMessage(SESSION, { kind: 'user', rpcId: 'req-2' })).toBe('external-other')
    expect(turnOrigin(SESSION)).toBe('external')
  })

  it('ignores DSH-injected sources instead of calling them external', () => {
    expect(noteUserMessage(SESSION, { kind: 'tool-jobs' })).toBe('host')
    expect(noteUserMessage(SESSION, { kind: 'schedule' })).toBe('host')
    expect(noteUserMessage(SESSION, undefined)).toBe('host')
    expect(turnOrigin(SESSION)).toBeUndefined()
  })

  it('never matches another session\'s request id', () => {
    noteFeishuPrompt('other-session', 'req-1')
    expect(noteUserMessage(SESSION, { kind: 'user', rpcId: 'req-1' })).toBe('external-other')
  })

  it('forgets a request id after its TTL', () => {
    const t0 = 1_000_000
    noteFeishuPrompt(SESSION, 'req-1', t0)
    expect(noteUserMessage(SESSION, { kind: 'user', rpcId: 'req-1' }, {}, t0 + 31 * 60_000))
      .toBe('external-other')
  })
})

describe('the turn keeps the surface that opened it', () => {
  it('does not relabel a running Feishu turn when the Web GUI steers it', () => {
    noteFeishuPrompt(SESSION, 'req-1')
    expect(noteUserMessage(SESSION, { kind: 'user', rpcId: 'req-1' })).toBe('feishu')
    // A steering message from the browser arrives mid-turn: it is echoed, but
    // the turn itself is still the Feishu one.
    expect(noteUserMessage(SESSION, { kind: 'user', rpcId: 'req-2', clientTimeZone: 'UTC' }))
      .toBe('external-web')
    expect(turnOrigin(SESSION)).toBe('feishu')
  })

  it('re-decides on the next turn', () => {
    noteFeishuPrompt(SESSION, 'req-1')
    noteUserMessage(SESSION, { kind: 'user', rpcId: 'req-1' })
    beginTurn(SESSION)
    noteUserMessage(SESSION, { kind: 'user', rpcId: 'req-2', clientTimeZone: 'UTC' })
    expect(turnOrigin(SESSION)).toBe('external')
  })
})

describe('direct dispatches carry no request id', () => {
  it('attributes the next attachment message to Feishu', () => {
    noteDirectFeishuDispatch(SESSION)
    expect(noteUserMessage(SESSION, { kind: 'user' }, { hasAttachment: true })).toBe('feishu')
    expect(turnOrigin(SESSION)).toBe('feishu')
  })

  it('is not consumed by a plain message from another surface', () => {
    noteDirectFeishuDispatch(SESSION)
    expect(noteUserMessage(SESSION, { kind: 'user', rpcId: 'web-1' }, { hasAttachment: false }))
      .toBe('external-other')
    // The marker is still there for the attachment the plugin actually pushed.
    expect(noteUserMessage(SESSION, { kind: 'user' }, { hasAttachment: true })).toBe('feishu')
  })

  it('expires', () => {
    const t0 = 5_000_000
    noteDirectFeishuDispatch(SESSION, t0)
    expect(noteUserMessage(SESSION, { kind: 'user' }, { hasAttachment: true }, t0 + 3 * 60_000))
      .toBe('external-other')
  })
})
