import { describe, expect, it } from 'vitest'
import {
  COMPACT_TOOL_ROW_STYLES, DEFAULT_COMPACT_TOOL_ROW, DEFAULT_TRANSCRIPT_VIEW, DETAILED_POLICY,
  isCompactToolRowStyle, levelUsesSwitch, parseCompactToolRow, parseTranscriptView,
  presetOf, resolveDisplayPolicy, resolveDisplaySettings, TRANSCRIPT_VIEWS,
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

describe('resolveDisplaySettings', () => {
  it('turns an explicit override into a preset-plus-switch combination', () => {
    // standard = one summary line per call; asking for the full tool section
    // keeps the standard reasoning block and adds the payloads.
    const settings = resolveDisplaySettings({ transcriptView: 'standard', toolDetail: 'full' })
    expect(settings.tools).toBe('full')
    expect(settings.toolArgs).toBe(false)
    expect(settings.toolResults).toBe(false)
    expect(settings.reasoning).toBe('on')
    expect(resolveDisplayPolicy({ transcriptView: 'standard', toolDetail: 'full' }).tools).toBe('full')
    // `toolOutputFull` is an override on its own.
    expect(resolveDisplaySettings({ transcriptView: 'detailed', toolOutputFull: 'full' }).toolOutputFull).toBe(true)
    expect(resolveDisplaySettings({ transcriptView: 'verbose', toolOutputFull: 'cut' }).toolOutputFull).toBe(false)
  })

  it('recognizes the preset a combination equals, and calls anything else custom', () => {
    expect(presetOf(resolveDisplaySettings({ transcriptView: 'verbose' }))).toBe('verbose')
    expect(presetOf(resolveDisplaySettings({ transcriptView: 'standard', toolDetail: 'summary' }))).toBe('standard')
    expect(presetOf(resolveDisplaySettings({ transcriptView: 'standard', toolDetail: 'full' }))).toBeUndefined()
    // The legacy switches still subtract, so a preset with one switch off is custom.
    expect(presetOf(resolveDisplaySettings({ transcriptView: 'detailed', showReasoning: false }))).toBeUndefined()
  })

  it('keeps the legacy switches subtract-only on top of a preset', () => {
    const settings = resolveDisplaySettings({ transcriptView: 'verbose', showToolCalls: false, showReasoning: false })
    expect(settings.tools).toBe('off')
    expect(settings.reasoning).toBe('off')
    expect(settings.reasoningPreview).toBe(false)
  })

  it('rejects an unknown tool detail by falling back to the preset', () => {
    expect(resolveDisplaySettings({ transcriptView: 'standard', toolDetail: 'bogus' }).tools).toBe('summary')
  })
})

describe('resolveDisplayPolicy', () => {
  it('maps each level onto the axes the renderer reads', () => {
    expect(resolveDisplayPolicy({ transcriptView: 'compact' })).toEqual({
      reasoning: 'off', reasoningFold: true, reasoningPreview: false, tools: 'off', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: true,
    })
    expect(resolveDisplayPolicy({ transcriptView: 'standard' })).toEqual({
      reasoning: 'on', reasoningFold: true, reasoningPreview: true, tools: 'summary', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: false,
    })
    expect(resolveDisplayPolicy({ transcriptView: 'detailed' })).toEqual(DETAILED_POLICY)
    expect(resolveDisplayPolicy({ transcriptView: 'verbose' })).toEqual({
      reasoning: 'on', reasoningFold: true, reasoningPreview: true, tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: true, turnCard: false,
    })
  })

  it('defaults to the compact level', () => {
    // 2026-11-12: the chat surface defaults to the short form (one turn card
    // counting tool calls) instead of the WebUI's `detailed`.
    expect(DEFAULT_TRANSCRIPT_VIEW).toBe('compact')
    expect(resolveDisplayPolicy({})).toEqual({
      reasoning: 'off', reasoningFold: true, reasoningPreview: false, tools: 'off', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: true,
    })
  })

  it('keeps `detailed` as the level that reproduces the pre-level behavior', () => {
    // Anyone who wants the old cards picks `detailed` explicitly; nothing about
    // that level changed.
    expect(resolveDisplayPolicy({ transcriptView: 'detailed' })).toEqual(DETAILED_POLICY)
    expect(DETAILED_POLICY).toEqual({
      reasoning: 'on', reasoningFold: true, reasoningPreview: true, tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: false, turnCard: false,
    })
  })

  it('replaces the compact step card\'s tool section with the turn card', () => {
    // `compact` shows tools on the ONE turn card (`feishu-progress.ts`), so the
    // step cards carry no tool section at all — and a step that only ran tools
    // stops being "visible", which is what keeps it from posting a card.
    const compact = resolveDisplayPolicy({ transcriptView: 'compact' })
    expect(compact.tools).toBe('off')
    expect(compact.turnCard).toBe(true)
  })

  it('turns the turn progress card on at `compact` only', () => {
    // `compact` merges the turn's tool activity onto one card (feishu-progress.ts);
    // the other three levels keep the per-step rendering they always had.
    expect(resolveDisplayPolicy({ transcriptView: 'compact' }).turnCard).toBe(true)
    for (const level of ['standard', 'detailed', 'verbose'] as const) {
      expect(resolveDisplayPolicy({ transcriptView: level }).turnCard).toBe(false)
    }
    // `compact` is the MODE that decides the topology, so the turn card stays
    // even with tool display off — it is also the answer card for a pure-answer
    // turn, which has nothing to do with showing tools.
    expect(resolveDisplayPolicy({ transcriptView: 'compact', showToolCalls: false }).turnCard).toBe(true)
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
    expect(resolveDisplayPolicy({ transcriptView: 'expanded' }).reasoning).toBe('on')
  })
})

describe('compact tool-row style', () => {
  it('accepts exactly the three styles and defaults anything else', () => {
    expect(COMPACT_TOOL_ROW_STYLES).toEqual(['tool', 'tool-description', 'description'])
    for (const style of COMPACT_TOOL_ROW_STYLES) {
      expect(parseCompactToolRow(style)).toBe(style)
      expect(isCompactToolRowStyle(style)).toBe(true)
    }
    expect(DEFAULT_COMPACT_TOOL_ROW).toBe('tool-description')
    for (const raw of ['nope', '', undefined, null, 1, {}]) {
      expect(parseCompactToolRow(raw)).toBe('tool-description')
      expect(isCompactToolRowStyle(raw)).toBe(false)
    }
  })

  it('knows which switches the active level can still use', () => {
    // compact forces reasoning off and renders no payloads.
    expect(levelUsesSwitch('compact', 'reasoning')).toBe(false)
    expect(levelUsesSwitch('compact', 'tools')).toBe(true)
    expect(levelUsesSwitch('compact', 'args')).toBe(false)
    expect(levelUsesSwitch('compact', 'results')).toBe(false)
    // standard has reasoning + tools but still no payloads.
    expect(levelUsesSwitch('standard', 'reasoning')).toBe(true)
    expect(levelUsesSwitch('standard', 'args')).toBe(false)
    // detailed / verbose render everything the four switches control.
    for (const level of ['detailed', 'verbose'] as const) {
      for (const key of ['reasoning', 'tools', 'args', 'results'] as const) {
        expect(levelUsesSwitch(level, key)).toBe(true)
      }
    }
  })
})
