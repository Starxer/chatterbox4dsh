import { describe, expect, it } from 'vitest'
import { TURN_CONTINUE_ACTION, TurnFailureError, displayFailure, renderTurnFailureCard, turnFailureText } from '../src/turn-failure.ts'
import { translationsFor } from '../src/i18n.ts'

const zh = translationsFor('zh')
const en = translationsFor('en')

describe('displayFailure', () => {
  it('keeps the provider message and string code (the Web UI projection)', () => {
    expect(displayFailure({ message: 'DeepSeek Messages request failed (413)', code: 'INVALID_REQUEST', status: 413 }))
      .toEqual({ message: 'DeepSeek Messages request failed (413)', code: 'INVALID_REQUEST' })
  })

  it('omits a non-string code and serializes a non-string message', () => {
    expect(displayFailure({ message: 'boom', code: 42 })).toEqual({ message: 'boom' })
    expect(displayFailure({ code: 'TRANSPORT' })).toEqual({ message: '{"code":"TRANSPORT"}', code: 'TRANSPORT' })
  })

  it('renders a non-object payload as its string form', () => {
    expect(displayFailure('nope')).toEqual({ message: 'nope' })
    expect(displayFailure(undefined)).toEqual({ message: 'undefined' })
  })

  it('keeps only the code of an AUTH failure so a credential echo is never shown', () => {
    expect(displayFailure({ message: 'invalid key sk-secret', code: 'AUTH' })).toEqual({ message: '', code: 'AUTH' })
  })
})

describe('renderTurnFailureCard', () => {
  it('mirrors the Web UI turn-error row: red title, message body, code chip', () => {
    const card = renderTurnFailureCard(zh, { message: 'DeepSeek Messages request failed (413)', code: 'INVALID_REQUEST' }) as any
    expect(card.header.title.content).toBe('本轮运行失败')
    expect(card.header.template).toBe('red')
    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: 'DeepSeek Messages request failed (413)' },
      { tag: 'markdown', content: '`INVALID_REQUEST`' },
    ])
  })

  it('substitutes the localized AUTH sentence for the provider message', () => {
    const card = renderTurnFailureCard(zh, { message: '', code: 'AUTH' }) as any
    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: 'API 密钥无效' },
      { tag: 'markdown', content: '`AUTH`' },
    ])
    const uk = renderTurnFailureCard(en, { message: '', code: 'AUTH' }) as any
    expect(uk.header.title.content).toBe('This turn failed')
    expect(uk.body.elements[0]).toEqual({ tag: 'markdown', content: 'API key is invalid' })
  })

  it('explains a content-safety refusal without replacing the provider facts', () => {
    const card = renderTurnFailureCard(zh, { message: 'DeepSeek refused to answer under its content safety review', code: 'CONTENT_REFUSED' }) as any
    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: 'DeepSeek refused to answer under its content safety review' },
      { tag: 'markdown', content: '`CONTENT_REFUSED`' },
      { tag: 'markdown', content: zh.failureRefusedHint },
    ])
    // The pre-rc.4 shape (still possible after a rollback to rc.1) reads the same.
    const legacy = renderTurnFailureCard(zh, { message: 'DeepSeek Messages stream: unsupported stop reason refusal', code: 'MALFORMED_RESPONSE' }) as any
    expect(legacy.body.elements.at(-1)).toEqual({ tag: 'markdown', content: zh.failureRefusedHint })
    // Any other failure gains no hint — it stays exactly the Web UI's row.
    const other = renderTurnFailureCard(zh, { message: 'boom', code: 'TRANSPORT' }) as any
    expect(other.body.elements.some((el: any) => el.content === zh.failureRefusedHint)).toBe(false)
  })

  it('offers a continue button that names the session, and only when asked', () => {
    const card = renderTurnFailureCard(zh, { message: 'boom', code: 'TRANSPORT' }, { continueSessionId: 'lark-v2-abc' }) as any
    expect(card.body.elements.at(-1)).toEqual({
      tag: 'button',
      text: { tag: 'plain_text', content: zh.turnContinueButton },
      type: 'primary',
      behaviors: [{ type: 'callback', value: { kind: TURN_CONTINUE_ACTION, sessionId: 'lark-v2-abc' } }],
    })
    const plain = renderTurnFailureCard(zh, { message: 'boom', code: 'TRANSPORT' }) as any
    expect(plain.body.elements.some((el: any) => el.tag === 'button')).toBe(false)
  })

  it('never renders an empty body', () => {
    const card = renderTurnFailureCard(zh, { message: '' }) as any
    expect(card.body.elements).toEqual([{ tag: 'markdown', content: '本轮运行失败' }])
  })

  it('renders the same facts as one text line when the card cannot be delivered', () => {
    expect(turnFailureText(zh, { message: 'DeepSeek Messages request failed (413)', code: 'INVALID_REQUEST' }))
      .toBe('本轮运行失败：DeepSeek Messages request failed (413) [INVALID_REQUEST]')
    expect(turnFailureText(zh, { message: '', code: 'AUTH' })).toBe('本轮运行失败：API 密钥无效 [AUTH]')
    expect(turnFailureText(en, { message: 'boom' })).toBe('This turn failed：boom')
  })

  it('carries the refusal hint in the text fallback too', () => {
    expect(turnFailureText(zh, { message: 'x', code: 'CONTENT_REFUSED' })).toContain(zh.failureRefusedHint)
    expect(turnFailureText(zh, { message: 'x', code: 'TRANSPORT' })).not.toContain(zh.failureRefusedHint)
  })

  it('exposes the failure on the thrown error so the channel needs no re-derivation', () => {
    const error = new TurnFailureError({ message: 'boom', code: 'TRANSPORT' })
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('boom')
    expect(error.failure).toEqual({ message: 'boom', code: 'TRANSPORT' })
  })
})
