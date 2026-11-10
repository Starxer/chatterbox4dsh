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
 * The default level. `detailed` is deliberately the level that reproduces the
 * pre-level behavior exactly (all four switches default to on), so adding this
 * setting changes nobody's cards.
 */
export const DEFAULT_TRANSCRIPT_VIEW: TranscriptView = 'detailed'

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

/** The default style: the pre-existing compact row. */
export const DEFAULT_COMPACT_TOOL_ROW: CompactToolRowStyle = 'tool'

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
 * How much of a step's reasoning the card carries.
 *
 * - `off`     — no reasoning section, and reasoning alone does not make a step visible;
 * - `preview` — the section header plus the first line, nothing to expand (the WebUI's `settledReasoningPreview`);
 * - `head`    — a folded panel whose body is the first {@link REASONING_HEAD_CAP} characters;
 * - `full`    — a folded panel with the whole chain.
 */
export type ReasoningDetail = 'off' | 'preview' | 'head' | 'full'

/**
 * How much of a step's tool work the card carries.
 *
 * - `off`     — no tool section, and tool calls do not make a step visible;
 * - `count`   — one line of totals (`3 tool calls · 1 failed`);
 * - `summary` — one line per call (icon + name + status + elapsed), no args/results;
 * - `full`    — the current rendering: summary + args + result previews.
 */
export type ToolDetail = 'off' | 'count' | 'summary' | 'full'

/** Characters a folded `head` reasoning body keeps before it is cut. */
export const REASONING_HEAD_CAP = 200

/** Characters of the first reasoning line shown by the `preview` detail. */
export const REASONING_PREVIEW_CAP = 80

/** What one level means, before the four switches refine it. */
interface LevelSpec {
  reasoning: ReasoningDetail
  tools: ToolDetail
  toolArgs: boolean
  toolResults: boolean
  /** Render args and result previews without their preview caps (verbose only). */
  fullToolOutput: boolean
  /**
   * Merge the turn's tool activity into ONE turn-level card updated in place
   * (`feishu-progress.ts`). Compact only: it is the level whose whole point is
   * "tell me the turn happened, not how it happened".
   */
  turnCard: boolean
}

const LEVELS: Record<TranscriptView, LevelSpec> = {
  // 简洁: the step cards carry the ANSWER and nothing else — the turn's whole
  // tool activity lives on the one turn card (`feishu-progress.ts`), so a step
  // card renders no tool section and a step that only ran tools posts no card
  // at all. `tools: 'off'` is what makes both of those true.
  compact: { reasoning: 'off', tools: 'off', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: true },
  // 标准: every call is named, but no payloads; reasoning is one line.
  standard: { reasoning: 'preview', tools: 'summary', toolArgs: false, toolResults: false, fullToolOutput: false, turnCard: false },
  // 详细: the pre-level default — preview + args + results, folded reasoning.
  detailed: { reasoning: 'head', tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: false, turnCard: false },
  // 完全展开: everything the card can carry, nothing truncated.
  verbose: { reasoning: 'full', tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: true, turnCard: false },
}

/** The resolved axes the renderers read. */
export interface DisplayPolicy {
  reasoning: ReasoningDetail
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

/** The policy of the default level with every switch on (the pre-level behavior). */
export const DETAILED_POLICY: DisplayPolicy = resolveDisplayPolicyCompat()

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
 * Project a level plus the four switches onto the renderer's axes.
 *
 * The switches can only subtract: each one is ANDed with what the level already
 * allows, so no combination makes a card show something the level excluded.
 *
 * @param input - the level (any spelling) and the current switch values.
 * @returns the axes to render with.
 */
export function resolveDisplayPolicy(input: {
  transcriptView?: unknown
  showReasoning?: boolean | undefined
  showToolCalls?: boolean | undefined
  showToolArgs?: boolean | undefined
  showToolResults?: boolean | undefined
}): DisplayPolicy {
  const level = LEVELS[parseTranscriptView(input.transcriptView)]
  const reasoning = input.showReasoning === false ? 'off' : level.reasoning
  const tools = input.showToolCalls === false ? 'off' : level.tools
  return {
    reasoning,
    tools,
    toolArgs: tools === 'full' && level.toolArgs && input.showToolArgs !== false,
    toolResults: tools === 'full' && level.toolResults && input.showToolResults !== false,
    fullToolOutput: tools === 'full' && level.fullToolOutput,
    // Not gated by the four switches: they control what a STEP card shows, and
    // this axis controls a different card. `showToolCalls === false` does turn
    // it off, because a user who asked for no tool display at all must not get
    // a card that lists every tool.
    turnCard: level.turnCard && input.showToolCalls !== false,
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
    case 'reasoning': return level !== 'compact'
    // Tool display is always meaningful: at `compact` it removes the progress
    // card's tool rows, at the step levels it removes the tool section.
    case 'tools': return true
    case 'args':
    case 'results': return LEVELS[level].toolArgs
  }
}

/** {@link resolveDisplayPolicy} with every switch on and the default level. */
function resolveDisplayPolicyCompat(): DisplayPolicy {
  return resolveDisplayPolicy({ transcriptView: DEFAULT_TRANSCRIPT_VIEW, ...DEFAULT_SWITCHES })
}
