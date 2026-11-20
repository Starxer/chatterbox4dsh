/**
 * The four display levels, mirroring the WebUI's `ui-chat.transcriptView`.
 *
 * The WebUI has exactly one setting with four values (`compact` / `standard` /
 * `detailed` / `verbose`) and it never compares the enum while rendering: it
 * projects the level onto a small policy table and the renderers only read the
 * axes (see `docs/transcript-parity-design.md` §3). This module is the same
 * design on the Feishu side, so the two settings pages can be read side by
 * side.
 *
 * Two deliberate differences from the WebUI, both forced by this surface:
 *
 * 1. **A level is a BASELINE, not an overriding authority.** The four existing
 *    switches (`showReasoning` / `showToolCalls` / `showToolArgs` /
 *    `showToolResults`) still work and are combined with the level using AND:
 *    a level can only ever show LESS than the level's own table, never more.
 *    That keeps every upgrade non-surprising (a deployment that had turned tool
 *    args off does not get them back because the level happens to be
 *    `detailed`) and avoids a `custom` pseudo-level whose state would have to
 *    be reconstructed from four booleans.
 * 2. **A level changes what a step card says; only `compact` changes whether a
 *    step gets one.** The WebUI's `foldCompletedTurns` / `stepGrouping` axes
 *    have no visual equivalent for a step (关键坑 12), so a step that produced
 *    text always keeps its own card. `compact` turns on
 *    {@link DisplayPolicy.turnCard}: the turn's TOOL activity is merged into ONE
 *    turn-level card updated in place (see `feishu-progress.ts`), and with it
 *    the step cards lose their tool section entirely — a step that only ran
 *    tools posts no card at all. That is the one place where the WebUI's
 *    "collapse the process" idea translates, because a tool timeline is not a
 *    step's answer.
 *
 * @module @starxer/chatterbox4dsh/display-level
 */

/** One of the four work-detail levels, named exactly as the WebUI names it. */
export type TranscriptView = 'compact' | 'standard' | 'detailed' | 'verbose'

/** The levels in ascending detail; the order the settings UIs list them in. */
export const TRANSCRIPT_VIEWS: readonly TranscriptView[] = ['compact', 'standard', 'detailed', 'verbose']

/**
 * The default level: `compact`.
 *
 * This is a deliberate divergence from the DSH WebUI's own default
 * (`detailed`). The WebUI is a screen with room to scroll; this channel is a
 * chat bubble, and the user asked (2026-11-12) for the short form by default —
 * one turn card that counts tool calls, with the answer card beside it, instead
 * of a step card per call. Anything more detailed stays one tap away on
 * `/display` (and an explicit stored level always wins over this default).
 *
 * `detailed` remains the level that reproduces the pre-level behavior exactly
 * (all four switches on), so a user who wants the old cards can pick it.
 */
export const DEFAULT_TRANSCRIPT_VIEW: TranscriptView = 'compact'

/**
 * What one tool row of the COMPACT turn card carries:
 *
 * - `tool` — the pre-existing row: the tool name plus the short "what" it
 *   touched (a bare file name / the programs a shell command ran);
 * - `tool-description` — the model's own one-line `description` FIRST, then the
 *   tool row;
 * - `description` — the description only. A call that wrote none keeps just its
 *   tool name: there is deliberately no fallback to the derived "what".
 *
 * Only `compact` has these rows; the step cards at the other levels show their
 * own summary line (see `deriveToolSummary` in `src/feishu-streaming.ts`).
 */
export type CompactToolRowStyle = 'tool' | 'tool-description' | 'description'

/** The styles in the order the settings UIs list them. */
export const COMPACT_TOOL_ROW_STYLES: readonly CompactToolRowStyle[] = ['tool', 'tool-description', 'description']

/**
 * The default style: the model's one-line description FIRST, then the tool row
 * (the operator's choice, 2026-11-11 — it reads as "what and where" in one row).
 * A call that wrote no description keeps the plain tool row, since style 2 only
 * prepends one when it exists.
 */
export const DEFAULT_COMPACT_TOOL_ROW: CompactToolRowStyle = 'tool-description'

/** Read one stored row style; anything unknown is the default. */
export function parseCompactToolRow(value: unknown): CompactToolRowStyle {
  return typeof value === 'string' && (COMPACT_TOOL_ROW_STYLES as readonly string[]).includes(value)
    ? value as CompactToolRowStyle
    : DEFAULT_COMPACT_TOOL_ROW
}

/** True when `value` is a valid row style (card payload validation). */
export function isCompactToolRowStyle(value: unknown): value is CompactToolRowStyle {
  return typeof value === 'string' && (COMPACT_TOOL_ROW_STYLES as readonly string[]).includes(value)
}

/**
 * Whether a step's reasoning block is rendered at all.
 *
 * The "how much" axis is gone (2026-11-20): the block always carries the WHOLE
 * chain, and the only shape question left is {@link DisplayPolicy.reasoningFold}
 * (folded panel vs. flat). A chain that exceeds one card travels as follow-up
 * "continued" cards instead of being cut — the same rule the answer text
 * already follows.
 */
export type ReasoningDetail = 'off' | 'on'

/**
 * How much of a step's tool work the card carries.
 *
 * - `off`     — no tool section, and tool calls do not make a step visible;
 * - `count`   — one line of totals (`3 tool calls · 1 failed`);
 * - `summary` — one line per call (icon + name + status + elapsed), no args/results;
 * - `full`    — the current rendering: summary + args + result previews.
 */
export type ToolDetail = 'off' | 'count' | 'summary' | 'full'

/**
 * Default length of the live reasoning preview (characters) shown while the
 * model is thinking. Not a truncation of the settled block: the finished block
 * always carries the whole chain.
 */
export const REASONING_PREVIEW_CHARS = 200

/** The two card layouts: one turn card, or one card per step. */
export type DisplayMode = 'compact' | 'detailed'

/** `auto` follows the active preset; the rest are explicit overrides. */
export type ToolDetailChoice = 'auto' | ToolDetail

/** `auto` follows the active preset; `cut`/`full` are explicit overrides. */
export type ToolOutputChoice = 'auto' | 'cut' | 'full'

/**
 * The switches a preset sets, before any explicit override is applied.
 *
 * A preset is a NAMED BUNDLE of these values (`standard` / `detailed` /
 * `verbose` / `compact`), not an independent display axis — the card and the
 * command let the operator pick values directly, and the preset name is only a
 * shortcut plus a label ("custom" when the values match none).
 */
interface PresetSpec {
  mode: DisplayMode
  reasoning: ReasoningDetail
  reasoningFold: boolean
  reasoningPreview: boolean
  tools: ToolDetail
  toolArgs: boolean
  toolResults: boolean
  toolOutputFull: boolean
}

/**
 * One resolved set of display choices — what the renderers and the `/display`
 * card actually read. `compact` is a MODE (it changes which cards exist), the
 * other three names are presets over the same switches.
 */
export interface DisplaySettings {
  mode: DisplayMode
  reasoning: ReasoningDetail
  reasoningFold: boolean
  reasoningPreview: boolean
  tools: ToolDetail
  toolArgs: boolean
  toolResults: boolean
  toolOutputFull: boolean
}

const PRESETS: Record<TranscriptView, PresetSpec> = {
  // 简洁: one turn card + one answer card. The step cards carry the answer and
  // nothing else, and a step that only ran tools posts no card at all.
  compact: {
    mode: 'compact', reasoning: 'off', reasoningFold: true, reasoningPreview: false,
    tools: 'off', toolArgs: false, toolResults: false, toolOutputFull: false,
  },
  // 标准: every call is named, but no payloads; the whole chain is folded.
  standard: {
    mode: 'detailed', reasoning: 'on', reasoningFold: true, reasoningPreview: true,
    tools: 'summary', toolArgs: false, toolResults: false, toolOutputFull: false,
  },
  // 详细: the pre-level default — args + results, the whole chain folded.
  detailed: {
    mode: 'detailed', reasoning: 'on', reasoningFold: true, reasoningPreview: true,
    tools: 'full', toolArgs: true, toolResults: true, toolOutputFull: false,
  },
  // 完全展开: everything the card can carry, tool payloads untruncated.
  verbose: {
    mode: 'detailed', reasoning: 'on', reasoningFold: true, reasoningPreview: true,
    tools: 'full', toolArgs: true, toolResults: true, toolOutputFull: true,
  },
}

/** Every preset name, for the `/display` card's preset row. */
export const PRESET_NAMES: readonly TranscriptView[] = TRANSCRIPT_VIEWS

/** The resolved axes the renderers read. */
export interface DisplayPolicy {
  reasoning: ReasoningDetail
  /** Render the whole chain inside a collapsed panel instead of flat on the card. */
  reasoningFold: boolean
  /**
   * Show a live tail of the chain while the model is still thinking. Off only
   * removes the transient preview; the settled block is unaffected.
   */
  reasoningPreview: boolean
  tools: ToolDetail
  /** Whether tool ARGUMENT blocks are rendered at all. */
  toolArgs: boolean
  /** Whether tool RESULT previews are rendered at all. */
  toolResults: boolean
  /** Skip the args/result preview caps, so long output is carried whole. */
  fullToolOutput: boolean
  /**
   * Whether this turn's tool activity is mirrored onto one turn-level progress
   * card (created on the first tool call, updated in place until `turn/end`).
   */
  turnCard: boolean
}

/** The baseline switch values a resolved policy assumes. */
export const DEFAULT_SWITCHES = {
  showReasoning: true,
  showToolCalls: true,
  showToolArgs: true,
  showToolResults: true,
} as const

/** The policy of the `detailed` level with every switch on (the pre-level behavior). */
export const DETAILED_POLICY: DisplayPolicy = resolveDisplayPolicy({ transcriptView: 'detailed', ...DEFAULT_SWITCHES })

/**
 * Read one stored level, tolerating the WebUI's two legacy spellings.
 *
 * `normal` and `expanded` are what a 0.1.x WebUI wrote; 0.2.0 reads both as
 * `detailed` and no longer offers them (`LEGACY_TRANSCRIPT_VIEW_MODE` /
 * `LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE`). A hand-edited `settings.yaml` may
 * still carry one, so they must not throw or silently fall back to the default
 * — they mean `detailed` exactly.
 *
 * @param value - whatever the settings store holds.
 * @returns a valid level; anything unknown (including `undefined`) is the default.
 */
export function parseTranscriptView(value: unknown): TranscriptView {
  if (value === 'normal' || value === 'expanded') return 'detailed'
  return typeof value === 'string' && (TRANSCRIPT_VIEWS as readonly string[]).includes(value)
    ? value as TranscriptView
    : DEFAULT_TRANSCRIPT_VIEW
}

/**
 * Project the stored settings onto one {@link DisplaySettings}.
 *
 * Precedence, highest first:
 * 1. the legacy `show*` switches can still SUBTRACT (they never add);
 * 2. explicit overrides (`reasoningFold`, `reasoningPreview`, `toolDetail`,
 *    `toolOutputFull`) beat the preset;
 * 3. the preset named by `transcriptView` supplies whatever is left.
 *
 * That is what makes "standard tools + the whole reasoning chain" reachable:
 * pick a preset for the baseline, then set one switch.
 *
 * @param input - raw setting values (any may be missing).
 * @returns the resolved choices.
 */
export function resolveDisplaySettings(input: {
  transcriptView?: unknown
  showReasoning?: boolean | undefined
  showToolCalls?: boolean | undefined
  showToolArgs?: boolean | undefined
  showToolResults?: boolean | undefined
  reasoningFold?: boolean | undefined
  reasoningPreview?: boolean | undefined
  toolDetail?: unknown
  toolOutputFull?: unknown
}): DisplaySettings {
  const preset = PRESETS[parseTranscriptView(input.transcriptView)]
  const explicitTools = typeof input.toolDetail === 'string'
    && input.toolDetail !== 'auto'
    && (['off', 'count', 'summary', 'full'] as readonly string[]).includes(input.toolDetail)
    ? input.toolDetail as ToolDetail
    : undefined
  const output = input.toolOutputFull === 'cut' ? false
    : input.toolOutputFull === 'full' ? true
      : typeof input.toolOutputFull === 'boolean' ? input.toolOutputFull
        : preset.toolOutputFull
  const tools = input.showToolCalls === false ? 'off' : (explicitTools ?? preset.tools)
  const reasoning = input.showReasoning === false ? 'off' : preset.reasoning
  return {
    mode: preset.mode,
    reasoning,
    reasoningFold: input.reasoningFold ?? preset.reasoningFold,
    reasoningPreview: reasoning !== 'off' && (input.reasoningPreview ?? preset.reasoningPreview),
    tools,
    toolArgs: tools === 'full' && preset.toolArgs && input.showToolArgs !== false,
    toolResults: tools === 'full' && preset.toolResults && input.showToolResults !== false,
    toolOutputFull: tools === 'full' && output,
  }
}

/** Which preset name these settings match exactly, or undefined ("custom"). */
export function presetOf(settings: DisplaySettings): TranscriptView | undefined {
  for (const name of TRANSCRIPT_VIEWS) {
    const preset = PRESETS[name]
    if (settings.mode === preset.mode
      && settings.reasoning === preset.reasoning
      && settings.reasoningFold === preset.reasoningFold
      && settings.reasoningPreview === preset.reasoningPreview
      && settings.tools === preset.tools
      && settings.toolArgs === preset.toolArgs
      && settings.toolResults === preset.toolResults
      && settings.toolOutputFull === preset.toolOutputFull) {
      return name
    }
  }
  return undefined
}

/**
 * Project settings onto the renderer's axes.
 *
 * `compact` is the one mode that CHANGES the topology (one turn card, no tool
 * section on step cards, tool-only steps post nothing), so it forces the tool
 * and reasoning axes off; the step levels render whatever the switches say.
 *
 * @param input - raw setting values (see {@link resolveDisplaySettings}).
 * @returns the axes to render with.
 */
export function resolveDisplayPolicy(input: Parameters<typeof resolveDisplaySettings>[0]): DisplayPolicy {
  const settings = resolveDisplaySettings(input)
  const compact = settings.mode === 'compact'
  return {
    reasoning: compact ? 'off' : settings.reasoning,
    reasoningFold: settings.reasoningFold,
    reasoningPreview: !compact && settings.reasoningPreview,
    tools: compact ? 'off' : settings.tools,
    toolArgs: compact ? false : settings.toolArgs,
    toolResults: compact ? false : settings.toolResults,
    fullToolOutput: compact ? false : settings.toolOutputFull,
    turnCard: compact,
  }
}

/**
 * Whether one of the four switches can still change anything at this level.
 *
 * The `/display` card hides the ones it cannot: offering a toggle that does
 * nothing is what made the card feel unsuited to `compact` (its reasoning is
 * forced off, and `standard`/`compact` carry no argument/result payloads at
 * all). Stored values are left untouched, so a switch comes back when the level
 * changes — the same rule the card already used when tool calls were off.
 *
 * @param level - the active level.
 * @param key - one of the four switch keys.
 * @returns whether the switch is functional at that level.
 */
export function levelUsesSwitch(
  level: TranscriptView,
  key: 'reasoning' | 'tools' | 'args' | 'results',
): boolean {
  switch (key) {
    case 'reasoning': return PRESETS[level].reasoning !== 'off'
    // Tool display is always meaningful: at `compact` it removes the progress
    // card's tool rows, at the step levels it removes the tool section.
    case 'tools': return true
    case 'args':
    case 'results': return PRESETS[level].toolArgs
  }
}

/** {@link resolveDisplayPolicy} with every switch on and the default level. */