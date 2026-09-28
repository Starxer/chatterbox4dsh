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
 * 2. **A level changes how much a card says, never how many cards are sent.**
 *    The WebUI's `foldCompletedTurns` / `stepGrouping` axes have no visual
 *    equivalent here — one step is one card, always (关键坑 12) — so `compact`
 *    does not merge a turn into a single card. It only strips the cards down to
 *    a status line. Merging cards would make deliverable text ambiguous and is
 *    not worth the risk.
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
}

const LEVELS: Record<TranscriptView, LevelSpec> = {
  // 简洁: the card proves the step happened and says what it touched, nothing more.
  compact: { reasoning: 'off', tools: 'count', toolArgs: false, toolResults: false, fullToolOutput: false },
  // 标准: every call is named, but no payloads; reasoning is one line.
  standard: { reasoning: 'preview', tools: 'summary', toolArgs: false, toolResults: false, fullToolOutput: false },
  // 详细: the pre-level default — preview + args + results, folded reasoning.
  detailed: { reasoning: 'head', tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: false },
  // 完全展开: everything the card can carry, nothing truncated.
  verbose: { reasoning: 'full', tools: 'full', toolArgs: true, toolResults: true, fullToolOutput: true },
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
  }
}

/** {@link resolveDisplayPolicy} with every switch on and the default level. */
function resolveDisplayPolicyCompat(): DisplayPolicy {
  return resolveDisplayPolicy({ transcriptView: DEFAULT_TRANSCRIPT_VIEW, ...DEFAULT_SWITCHES })
}
