import { describe, expect, it } from 'vitest'
import { ERROR_TEXT_CAP, errorText } from '../src/error-text.ts'

describe('errorText', () => {
  it('returns the Error message verbatim', () => {
    expect(errorText(new Error('File is 33934848 bytes, over Feishu limit'), 'fallback'))
      .toBe('File is 33934848 bytes, over Feishu limit')
  })

  it('appends a numeric error code when present', () => {
    const err = new Error('file is too large')
    ;(err as { code?: unknown }).code = 230021
    expect(errorText(err, 'fallback')).toBe('file is too large (code: 230021)')
  })

  it('appends a string error code when present', () => {
    const err = new Error('rate limited')
    ;(err as { code?: unknown }).code = '429'
    expect(errorText(err, 'fallback')).toBe('rate limited (code: 429)')
  })

  it('does not duplicate a code already inside the message', () => {
    const err = new Error('upstream reject code:230021')
    ;(err as { code?: unknown }).code = 230021
    expect(errorText(err, 'fallback')).toBe('upstream reject code:230021')
  })

  it('falls back when the error yields no detail', () => {
    expect(errorText(new Error('   '), '抱歉，处理这条消息时遇到了问题。')).toBe('抱歉，处理这条消息时遇到了问题。')
    expect(errorText(undefined, 'fallback')).toBe('fallback')
  })

  it('stringifies non-Error values', () => {
    expect(errorText('boom', 'fallback')).toBe('boom')
  })

  it('truncates very long messages to the documented cap', () => {
    const long = errorText(new Error('x'.repeat(ERROR_TEXT_CAP + 600)), 'fallback')
    expect(long).toHaveLength(ERROR_TEXT_CAP + 1)
    expect(long.endsWith('…')).toBe(true)
  })

  // A Feishu SDK failure is a WRAPPER: the message only says the HTTP status.
  // Without the two branches below the chat gets "Request failed with status
  // code 400" and the reader learns nothing (2026-09-23).
  it('appends the cause chain so a wrapper cannot hide the reason', () => {
    const err = new Error('Request failed with status code 400', { cause: new Error('socket hang up') })
    expect(errorText(err, 'fallback')).toBe('Request failed with status code 400 ← socket hang up')
  })

  it('walks nested causes outermost-first and stops at the depth cap', () => {
    // Four cause hops are rendered; `sixth` is beyond the cap and is dropped.
    const err = new Error('first', {
      cause: new Error('second', {
        cause: new Error('third', {
          cause: new Error('fourth', { cause: new Error('fifth', { cause: new Error('sixth') }) }),
        }),
      }),
    })
    expect(errorText(err, 'fallback')).toBe('first ← second ← third ← fourth ← fifth')
  })

  it('does not repeat a cause already spelled out in the message', () => {
    const err = new Error('failed: connection reset', { cause: new Error('connection reset') })
    expect(errorText(err, 'fallback')).toBe('failed: connection reset')
  })

  it("uses Feishu's own wording from response.data.msg", () => {
    // What the SDK throws for a rejected card: the informative sentence lives
    // in the response envelope, not in `message`.
    const err = Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: {
          code: 230099,
          msg: 'Failed to create card content, ext=ErrCode: 200570; ErrMsg: card contains invalid image keys; ',
        },
      },
    })
    expect(errorText(err, 'fallback')).toBe(
      'Request failed with status code 400 — '
      + 'Failed to create card content, ext=ErrCode: 200570; ErrMsg: card contains invalid image keys; (code: 230099)',
    )
  })

  it('takes the business code from the response envelope when the error has none', () => {
    const err = Object.assign(new Error('Request failed with status code 400'), {
      response: { data: { code: 230021, msg: 'file is too large' } },
    })
    expect(errorText(err, 'fallback')).toBe('Request failed with status code 400 — file is too large (code: 230021)')
  })

  it('survives a self-referential cause chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown }
    err.cause = err
    expect(errorText(err, 'fallback')).toBe('loop')
  })

  it('never reads the request config (it carries the request body)', () => {
    const err = Object.assign(new Error('Request failed with status code 400'), {
      config: { data: '{"app_secret":"should-never-appear"}' },
      response: { data: { msg: 'bad request' } },
    })
    expect(errorText(err, 'fallback')).not.toContain('should-never-appear')
  })
})
