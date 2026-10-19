import { describe, expect, it } from 'vitest'
import { collectCompletedTurns, TURN_PREVIEW_MAX } from '../src/turn-history.ts'

/** A user message event with one text part. */
function user(seq: number, text: string): { seq: number; type: string; data: unknown } {
  return { seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } }
}

/** An assistant message event with one text part. */
function assistant(seq: number, text: string): { seq: number; type: string; data: unknown } {
  return { seq, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

describe('collectCompletedTurns', () => {
  it('collects completed turns with the turn end seq and the opening user text', () => {
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      user(1, 'first question'),
      assistant(2, 'first answer'),
      { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'success' } } },
      { seq: 4, type: 'turn/start', data: { turn: 2 } },
      user(5, 'second question'),
      { seq: 6, type: 'turn/end', data: { turn: 2, reason: { kind: 'success' } } },
    ]
    const turns = collectCompletedTurns(events)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ turn: 1, endSeq: 3, preview: 'first question' })
    expect(turns[1]).toMatchObject({ turn: 2, endSeq: 6, preview: 'second question' })
  })

  it('never includes an in-progress turn', () => {
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      user(1, 'done'),
      { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'success' } } },
      { seq: 3, type: 'turn/start', data: { turn: 2 } },
      user(4, 'still running'),
    ]
    expect(collectCompletedTurns(events).map(turn => turn.turn)).toEqual([1])
  })

  it('falls back to the assistant text when the turn has no user text', () => {
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      assistant(1, 'only the model spoke'),
      { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'success' } } },
    ]
    expect(collectCompletedTurns(events)[0]?.preview).toBe('only the model spoke')
  })

  it('collapses whitespace and truncates the preview', () => {
    const long = `${'word '.repeat(40)}tail`
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      user(1, `line one\n\nline two ${long}`),
      { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'success' } } },
    ]
    const preview = collectCompletedTurns(events)[0]!.preview
    expect(preview).not.toContain('\n')
    expect(preview.length).toBeLessThanOrEqual(TURN_PREVIEW_MAX)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('keeps only the newest `limit` turns', () => {
    const events = Array.from({ length: 6 }, (_, index) => [
      { seq: index * 3, type: 'turn/start', data: { turn: index + 1 } },
      user(index * 3 + 1, `q${index + 1}`),
      { seq: index * 3 + 2, type: 'turn/end', data: { turn: index + 1, reason: { kind: 'success' } } },
    ]).flat()
    const turns = collectCompletedTurns(events, { limit: 2 })
    expect(turns.map(turn => turn.turn)).toEqual([5, 6])
  })

  it('ignores a turn/end that does not close the open turn', () => {
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 3 } },
      { seq: 1, type: 'turn/end', data: { turn: 2, reason: { kind: 'success' } } },
      user(2, 'q3'),
      { seq: 3, type: 'turn/end', data: { turn: 3, reason: { kind: 'success' } } },
    ]
    expect(collectCompletedTurns(events)).toHaveLength(1)
  })
})
