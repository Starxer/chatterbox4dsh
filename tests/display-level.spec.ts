import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRANSCRIPT_VIEW, DETAILED_POLICY, parseTranscriptView, resolveDisplayPolicy, TRANSCRIPT_VIEWS,
} from '../src/display-level.ts'

describe('parseTranscriptView', () => {
  it('accepts the four levels', () => {
    for (const level of TRANSCRIPT_VIEWS) expect(parseTranscriptView(level)).toBe(level)
  })

  it('reads the WebUI legacy spellings as `detailed`', () => {
    // 0.2.0 reads a stored `normal` (the two-level era) and a stored `expanded`
    // (the 0.1.x name) as `detailed`; a hand-edited settings.yaml may still hold
    // one, and guessing any other level would change what the user sees.
    expect(parseTranscriptView('normal')).toBe('detailed')
    expect(parseTranscriptView('expanded')).toBe('detailed')
  })

  it('falls back to the default for anything unknown', () => {
    expect(parseTranscriptView(undefined)).toBe(DEFAULT_TRANSCRIPT_VIEW)
    expect(parseTranscriptView('')).toBe(DEFAULT_TRANSCRIPT_VIEW)
    expect(parseTranscriptView('verbose ')).toBe(DEFAULT_TRANSCRIPT_VIEW)
    expect(parseTranscriptView(7)).toBe(DEFAULT_TRANSCRIPT_VIEW)
  })
})

describe('resolveDisplayPolicy', () => {
  it('maps each level onto the axes the renderer reads', () => {
    expect(resolveDisplayPolicy({ transcriptView: 'compact' })).toEqual({
      reasoning: 'off', tools: 'count', toolArgs: false, toolResults: false, fullToolOutput: false,
    })
    expect(resolveDisplayPolicy({ transcriptView: 'standard' })).toEqual({
      reasoning: 'preview', tools: 'summary', toolArgs: false, toolResults: false, fullToolOutput: false,
    })
    expect(resolveDisplayPolicy({ transcriptView: 'detailed' })).toEqual(DETAILED_POLICY)
    expect(resolveDisplayPolicy({ transcriptView: 'verbose' })).toEqual({
      reasoning: 'full', tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: true,
    })
  })

  it('is behavior-identical to the pre-level defaults at `detailed`', () => {
    // The point of the default: every switch on, at `detailed`, must be exactly
    // what the plugin did before a level existed.
    expect(resolveDisplayPolicy({})).toEqual(DETAILED_POLICY)
    expect(DETAILED_POLICY).toEqual({
      reasoning: 'head', tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: false,
    })
  })

  it('lets a switch only ever show LESS than the level allows', () => {
    // Level is a baseline, not an override: turning a switch off must remove
    // detail even at the most detailed level…
    expect(resolveDisplayPolicy({ transcriptView: 'verbose', showReasoning: false }).reasoning).toBe('off')
    expect(resolveDisplayPolicy({ transcriptView: 'verbose', showToolCalls: false }).tools).toBe('off')
    expect(resolveDisplayPolicy({ transcriptView: 'verbose', showToolArgs: false }).toolArgs).toBe(false)
    expect(resolveDisplayPolicy({ transcriptView: 'verbose', showToolResults: false }).toolResults).toBe(false)
    // …and turning one ON must not add detail the level excluded.
    expect(resolveDisplayPolicy({ transcriptView: 'compact', showReasoning: true }).reasoning).toBe('off')
    expect(resolveDisplayPolicy({ transcriptView: 'compact', showToolArgs: true }).toolArgs).toBe(false)
    expect(resolveDisplayPolicy({ transcriptView: 'standard', showToolResults: true }).toolResults).toBe(false)
  })

  it('keeps tool payloads impossible whenever the tool section is not full', () => {
    for (const level of ['compact', 'standard'] as const) {
      const policy = resolveDisplayPolicy({ transcriptView: level })
      expect(policy.tools).not.toBe('full')
      expect(policy.toolArgs).toBe(false)
      expect(policy.toolResults).toBe(false)
      expect(policy.fullToolOutput).toBe(false)
    }
  })

  it('reads an unreadable stored level the way the WebUI would', () => {
    expect(resolveDisplayPolicy({ transcriptView: 'expanded' }).reasoning).toBe('head')
  })
})
