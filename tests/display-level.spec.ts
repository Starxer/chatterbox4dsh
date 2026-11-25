import { describe, expect, it } from 'vitest'
import {
  COMPACT_TOOL_ROW_STYLES, DEFAULT_COMPACT_TOOL_ROW, DEFAULT_TRANSCRIPT_VIEW, DETAILED_POLICY,
  isCompactToolRowStyle, parseCompactToolRow, parseTranscriptView, PREVIEW_LENGTH_CHOICES,
  resolveDisplayPolicy, resolveDisplaySettings, TRANSCRIPT_VIEWS,
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
  it('reads the retired level name only for its historical defaults', () => {
    // `standard` used to mean one summary line per call; nothing writes it any
    // more, but an upgraded configuration must keep that look.
    expect(resolveDisplaySettings({ transcriptView: 'standard' }).tools).toBe('summary')
    expect(resolveDisplaySettings({ transcriptView: 'verbose' }).toolOutputFull).toBe(true)
    expect(resolveDisplaySettings({ transcriptView: 'verbose' }).tools).toBe('full')
    expect(resolveDisplaySettings({ transcriptView: 'detailed' }).toolOutputFull).toBe(false)
    expect(resolveDisplaySettings({ transcriptView: 'compact' }).mode).toBe('compact')
    expect(resolveDisplaySettings({ transcriptView: 'detailed' }).mode).toBe('detailed')
  })

  it('lets an explicit switch win over the retired default', () => {
    const settings = resolveDisplaySettings({ transcriptView: 'standard', toolDetail: 'full', toolOutputFull: true })
    expect(settings.tools).toBe('full')
    expect(settings.toolOutputFull).toBe(true)
    expect(settings.reasoning).toBe('on')
    expect(settings.toolArgs).toBe(true)
  })

  it('keeps the legacy switches subtract-only', () => {
    const settings = resolveDisplaySettings({ transcriptView: 'verbose', showToolCalls: false, showReasoning: false })
    expect(settings.tools).toBe('off')
    expect(settings.reasoning).toBe('off')
    expect(resolveDisplaySettings({ transcriptView: 'detailed', showToolArgs: false }).toolArgs).toBe(false)
  })

  it('carries the output setting only while the tool section is full', () => {
    expect(resolveDisplaySettings({ transcriptView: 'detailed', toolDetail: 'summary', toolOutputFull: true }).toolOutputFull).toBe(false)
    expect(resolveDisplaySettings({ transcriptView: 'detailed', toolDetail: 'full', toolOutputFull: true }).toolOutputFull).toBe(true)
  })

  it('ignores an unknown tool detail instead of inventing one', () => {
    expect(resolveDisplaySettings({ transcriptView: 'standard', toolDetail: 'bogus' }).tools).toBe('summary')
    expect(resolveDisplaySettings({ transcriptView: 'detailed', toolDetail: 'bogus' }).tools).toBe('full')
  })

  it('offers a bounded ladder of truncation lengths', () => {
    expect(PREVIEW_LENGTH_CHOICES.args).toContain(2000)
    expect(PREVIEW_LENGTH_CHOICES.result).toContain(1500)
  })
})

describe('resolveDisplayPolicy', () => {
  it('maps each level onto the axes the renderer reads', () => {
    // `compact` honours the thinking switch too (2026-11-25): its turn card can
    // carry each step's chain as a folded panel. Only the TOOL axes are forced
    // off there, and the fold is forced ON (compact has no step card to give a
    // flat chain).
    expect(resolveDisplayPolicy({ transcriptView: 'compact' })).toEqual({
      reasoning: 'on', reasoningFold: true, stepsFold: true, tools: 'off', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: true,
    })
    expect(resolveDisplayPolicy({ transcriptView: 'compact', showReasoning: false }).reasoning).toBe('off')
    // A stored flat fold cannot un-fold the compact panel.
    expect(resolveDisplayPolicy({ transcriptView: 'compact', reasoningFold: false }).reasoningFold).toBe(true)
    expect(resolveDisplayPolicy({ transcriptView: 'standard' })).toEqual({
      reasoning: 'on', reasoningFold: true, stepsFold: true, tools: 'summary', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: false,
    })
    expect(resolveDisplayPolicy({ transcriptView: 'detailed' })).toEqual(DETAILED_POLICY)
    expect(resolveDisplayPolicy({ transcriptView: 'verbose' })).toEqual({
      reasoning: 'on', reasoningFold: true, stepsFold: true, tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: true, turnCard: false,
    })
  })

  it('defaults to the compact level', () => {
    // 2026-11-12: the chat surface defaults to the short form (one turn card
    // counting tool calls) instead of the WebUI's `detailed`.
    expect(DEFAULT_TRANSCRIPT_VIEW).toBe('compact')
    expect(resolveDisplayPolicy({})).toEqual({
      reasoning: 'on', reasoningFold: true, stepsFold: true, tools: 'off', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: true,
    })
  })

  it('keeps `detailed` as the level that reproduces the pre-level behavior', () => {
    // Anyone who wants the old cards picks `detailed` explicitly; nothing about
    // that level changed.
    expect(resolveDisplayPolicy({ transcriptView: 'detailed' })).toEqual(DETAILED_POLICY)
    expect(DETAILED_POLICY).toEqual({
      reasoning: 'on', reasoningFold: true, stepsFold: true, tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: false, turnCard: false,
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
    // …and turning one ON must not add detail the level excluded. Reasoning is
    // the one axis compact lets through (folded), so the "less" rule is checked
    // with the switches it still owns: TOOLS and the tool payloads.
    expect(resolveDisplayPolicy({ transcriptView: 'compact', showToolCalls: true }).tools).toBe('off')
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

describe('turn-card step fold', () => {
  it('defaults to folding and keeps an explicit choice', () => {
    expect(resolveDisplaySettings({}).stepsFold).toBe(true)
    expect(resolveDisplayPolicy({}).stepsFold).toBe(true)
    expect(resolveDisplaySettings({ stepsFold: false }).stepsFold).toBe(false)
    expect(resolveDisplayPolicy({ stepsFold: false }).stepsFold).toBe(false)
    // The switch is compact-only in effect, but the resolved value is carried in
    // both modes so the settings UI can read one source.
    expect(resolveDisplayPolicy({ transcriptView: 'detailed', stepsFold: false }).stepsFold).toBe(false)
    expect(DETAILED_POLICY.stepsFold).toBe(true)
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

})
