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

/**
 * What the retired LEVEL NAMES mean now.
 *
 * The four levels are gone: the operator sets the mode (card topology) and the
 * switches directly. These values are read ONCE from whatever a stored
 * `transcriptView` still says, so an existing configuration keeps its look
 * without a migration — nothing here is written back.
 */
const LEGACY_DEFAULTS: Record<TranscriptView, { tools: ToolDetail; outputFull: boolean }> = {
  compact: { tools: 'off', outputFull: false },
  standard: { tools: 'summary', outputFull: false },
  detailed: { tools: 'full', outputFull: false },
  verbose: { tools: 'full', outputFull: true },
}

/** The numeric choices offered by the truncation-length rows on `/display`. */
export const PREVIEW_LENGTH_CHOICES = {
  args: [500, 1000, 2000, 4000],
  result: [500, 1000, 1500, 3000],
} as const

/** A truncation length the card and `/display length` can set. */
export type PreviewLengthField = keyof typeof PREVIEW_LENGTH_CHOICES

/** One resolved set of display choices — what the renderers and the card read. */
export interface DisplaySettings {
  /** `compact` is a card TOPOLOGY (one turn card); `detailed` is per-step. */
  mode: DisplayMode
  reasoning: ReasoningDetail
  reasoningFold: boolean
  tools: ToolDetail
  toolArgs: boolean
  toolResults: boolean
  toolOutputFull: boolean
}

/** The resolved axes the renderers read. */
export interface DisplayPolicy {
  reasoning: ReasoningDetail
  /** Render the whole chain inside a collapsed panel instead of flat on the card. */
  reasoningFold: boolean
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
 * There are no presets any more: the operator picks the mode and every switch
 * directly. The only thing still read from the old level name is its historical
 * default (`standard` used to mean summary lines, `verbose` untruncated
 * payloads, and so on), applied when the corresponding switch has never been
 * stored — so an upgrade keeps the look it had without rewriting anything.
 *
 * The legacy `show*` switches can still SUBTRACT (they never add); everything
 * else is stored explicitly.
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
  toolDetail?: unknown
  toolOutputFull?: unknown
}): DisplaySettings {
  const legacyName = parseTranscriptView(input.transcriptView)
  const legacy = LEGACY_DEFAULTS[legacyName]
  const explicitTools = typeof input.toolDetail === 'string'
    && (['off', 'count', 'summary', 'full'] as readonly string[]).includes(input.toolDetail)
    ? input.toolDetail as ToolDetail
    : undefined
  const tools = input.showToolCalls === false ? 'off' : (explicitTools ?? legacy.tools)
  const reasoning = input.showReasoning === false ? 'off' : 'on'
  return {
    mode: legacyName === 'compact' ? 'compact' : 'detailed',
    reasoning,
    reasoningFold: input.reasoningFold ?? true,
    tools,
    toolArgs: input.showToolArgs !== false,
    toolResults: input.showToolResults !== false,
    toolOutputFull: tools === 'full'
      && (typeof input.toolOutputFull === 'boolean' ? input.toolOutputFull : legacy.outputFull),
  }
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
  // Payloads exist only inside the full tool section: `summary`/`count` name the
  // calls and carry nothing to render, so the switches must not add them back.
  const full = !compact && settings.tools === 'full'
  return {
    reasoning: compact ? 'off' : settings.reasoning,
    reasoningFold: settings.reasoningFold,
    tools: compact ? 'off' : settings.tools,
    toolArgs: full && settings.toolArgs,
    toolResults: full && settings.toolResults,
    fullToolOutput: full && settings.toolOutputFull,
    turnCard: compact,
  }
}

/** {@link resolveDisplayPolicy} with every switch on and the default level. */