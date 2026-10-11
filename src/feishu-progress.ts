/**
 * The turn progress card: ONE card per turn carrying the turn's tool activity.
 *
 * Active at the `compact` level only (`DisplayPolicy.turnCard`). It answers the
 * question `compact` step cards deliberately do not: WHICH tools ran, how long
 * each took, and how long each step took. The turn's steps become sections, each
 * tool call one line, and the whole card is updated in place from the first tool
 * call until `turn/end`.
 *
 * Design rules, all decided before the first line was written (2026-10-09):
 *
 * - **No arguments, no results, no reasoning.** That is what `compact` means;
 *   the detailed levels show the payloads inside their step cards.
 * - **A step's narration is a row, not a card.** Assistant text that is followed
 *   by tool calls in the SAME step is process narration, never the turn's answer
 *   (WebUI parity: only a reply-bearing message without tool calls is an answer).
 *   `compact` therefore renders it as one `💬 …` row under that step's header
 *   instead of posting a step card the user would read as a reply — the answer
 *   card stays the only card carrying prose.
 * - **No buttons and no `interactive_container` rows, ever.** A card carrying
 *   buttons stops delivering callbacks after ~2-3 in-place updates (关键坑 11)
 *   and a tapped `interactive_container` row stops delivering row callbacks
 *   (关键坑 55). This card's entire model is "one message, many updates", so
 *   anything tappable would break it.
 * - **One card per turn, per session.** A CardKit card entity may only be sent
 *   once and is only operable for 14 days, and this card's lifetime is one turn,
 *   so nothing here is reused across turns and nothing is persisted: after a
 *   restart the card simply stops updating (the stale-card text notice in
 *   `feishu-streaming.ts` is the fallback, never a second card).
 * - **Writes are coalesced and serialized.** A tool-heavy turn emits one tool
 *   event per call; Feishu answers a burst of edits to one message with
 *   `230020` (关键坑 45). So: leading-edge write, then at most one write per
 *   {@link PROGRESS_WRITE_GAP_MS}, one write in flight per card, always the
 *   NEWEST render (superseded renders are dropped, not replayed).
 *
 * @module @starxer/chatterbox4dsh/feishu-progress
 */

import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import type { CardInterleave } from './card-interleave.ts'
import { errorText } from './error-text.ts'
import { foldedPanel } from './card-fold.ts'
import { truncateInline } from './text-chunk.ts'

/** Tool lines kept visible before older ones fold away. */
export const PROGRESS_MAX_ROWS = 40

/**
 * Whole steps kept visible before older ones fold away.
 *
 * **The window is counted in STEPS, not rows** (2026-10-11, at the user's
 * request): three steps is what a glance needs — the newest one is what the
 * agent is doing, the two before it are how it got there — and it makes the
 * card's height predictable whatever a step happens to contain. Older steps are
 * one tap away inside the folded panel. {@link PROGRESS_MAX_ROWS} stays as the
 * outer bound, because one step can hold dozens of calls on its own.
 */
export const PROGRESS_MAX_STEPS = 3

/** Folded lines carried in the panel body (the panel is collapsed, not free). */
export const PROGRESS_MAX_FOLDED = 60

/**
 * How often a still-running tool repaints its elapsed clock. A tool that finishes
 * sooner never pays for a tick: the timer is dropped as soon as the last running
 * row settles, and what is left goes through the normal write throttle.
 */
export const PROGRESS_RUNNING_TICK_MS = 30_000

/**
 * Shortest gap between two writes to the same progress card. Measured against
 * the failure in 关键坑 45: edits to one message in the same second are refused
 * with `230020`.
 */
export const PROGRESS_WRITE_GAP_MS = 900

/**
 * Characters a step's narration keeps on its one card row. The row is a pointer,
 * not the text: the answer card (or the reply card) carries the prose.
 */
export const PROGRESS_NOTE_MAX = 80

/**
 * Spacing between two card elements. The measured default is visibly loose for a
 * list of one-line rows, and this card is nothing else: a tool-heavy turn renders
 * 40+ rows. `vertical_spacing` takes a size token or px (see 关键坑 58).
 */
export const PROGRESS_ELEMENT_SPACING = '4px'

/** One tool call as the card renders it. */
export interface ProgressTool {
  name: string
  /** The call's id, used only to settle the right row (never rendered). */
  callId?: string | undefined
  startedAt: number
  /** Absent while the call is still running. */
  elapsed?: number | undefined
  isError?: boolean | undefined
  /**
   * The short names this call touched, already derived by the streaming layer
   * (`progressToolDetails`): the file a read/write touches, or the programs a
   * shell command runs. A LIST, so a merged run names the first few across all
   * of its calls instead of repeating one call's whole list. Rendered right
   * after the tool name, so a row says what happened rather than only which tool
   * ran. Absent when the call has nothing short and useful to name.
   */
  detail?: readonly string[] | undefined
}

/** One step as the card renders it. */
export interface ProgressStep {
  step: number
  startedAt: number
  /** Absent while the step is still running. */
  endedAt?: number | undefined
  tools: ProgressTool[]
  /**
   * The step's own narration, when it had one: the assistant text of a step that
   * went on to call tools, i.e. PROCESS rather than the turn's answer (WebUI
   * parity — only a reply-bearing message WITHOUT tool calls is an answer,
   * `ui-chat/src/client/conversation-nodes/turn-process.ts`). Already collapsed
   * to one line by {@link condenseStepNote}; absent when the step said nothing.
   */
  note?: string | undefined
  /**
   * Context-injection notice lines this step claimed (`📥 注入上下文 · …`).
   * Under `compact` they belong to the PROCESS, so they render here instead of
   * forcing a step card of their own — the card that used to say nothing but
   * "本步无输出" plus the notice. One line per injected message, in arrival order.
   */
  injections?: string[] | undefined
}

/** Everything one render needs. */
export interface ProgressFacts {
  steps: ProgressStep[]
  /** Exact number of tool calls (rows merge runs, so it cannot be derived). */
  calls: number
  failed: number
  /** When the turn started (`turn/start`). */
  turnStart: number
  /** Set once the turn ended. */
  endedAt?: number | undefined
  /** The turn ended in an error (`turn/end` → `reason.kind === 'error'`). */
  failedTurn: boolean
  /** The clock for the running labels; injected so renders are deterministic. */
  now: number
  /**
   * Index into {@link steps} where THIS card's content begins. Another module
   * posting a card into the chat ends the segment: the card that is on screen
   * above it stops growing and the next event opens a new one carrying only what
   * happened since (see `src/card-interleave.ts`).
   */
  segmentFrom?: number | undefined
}

/** The channel surface this module needs (structurally satisfied by the channel). */
export interface ProgressCardChannel {
  send(
    to: string,
    input: { card?: object; text?: string },
    opts?: { replyInThread?: boolean; replyTo?: string },
  ): Promise<{ messageId?: string }>
  createCardInstance?(card: object): Promise<string>
  sendCardByReference?(
    to: string,
    cardId: string,
    opts?: { replyInThread?: boolean; replyTo?: string },
  ): Promise<{ messageId?: string }>
  updateCardInstance?(cardId: string, card: object, sequence: number): Promise<void>
  updateCard?(messageId: string, card: object): Promise<void>
}

/** Compact duration label (`3.2s` / `850ms` / `1m05s`), same as the other cards. */
export function formatProgressMs(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

/** One rendered line plus the step it belongs to. */
interface Line {
  text: string
  /** The step section header line, which must stay with its first visible row. */
  header: boolean
  step: number
  /**
   * A step's narration: MODEL text. It may join its step's element only when its
   * own inline markup is balanced — see {@link inlineMarkupBalanced}.
   */
  note?: boolean
}

/**
 * Distinct details one merged run may name.
 *
 * A run of same-named calls (a `bash` run, a `read` run) is one row, and the row
 * can only carry so much: the first three are what tells the run apart ("it ran
 * npm, then node, then git") without turning the row into a command line.
 */
export const PROGRESS_MAX_DETAILS = 3

/**
 * Whether one line's inline markup may share a multi-line markdown element.
 *
 * Feishu pairs `**` / backticks across the whole element, so a note carrying an
 * ODD number of them would pair with the next line's markup and render the wrong
 * thing as bold (关键坑 60). Such a note keeps an element of its own; every other
 * line on this card is machine-generated and safe to join.
 *
 * @param text - one rendered line.
 * @returns true when the line can be joined with its neighbours.
 */
export function inlineMarkupBalanced(text: string): boolean {
  const count = (token: string): number => text.split(token).length - 1
  return count('**') % 2 === 0 && count('`') % 2 === 0
}

/**
 * Collapse a step's narration into the single row the progress card carries.
 *
 * First non-empty line only (a narration is a sentence, not a document),
 * whitespace runs squeezed, cut at {@link PROGRESS_NOTE_MAX}. Pure so the render
 * tests can pin the shape; the caller passes raw assistant text.
 *
 * @param text - the step's accumulated assistant text.
 * @returns the row body, or `''` when there is nothing worth a row.
 */
export function condenseStepNote(text: string): string {
  const first = text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  const squeezed = first.replace(/\s+/g, ' ').trim()
  // `truncateInline`, not `slice`: a cut inside `**加粗…**` left the row showing
  // a literal `**` on the card (2026-10-10).
  return squeezed.length > PROGRESS_NOTE_MAX ? truncateInline(squeezed, PROGRESS_NOTE_MAX) : squeezed
}

/** How a merged run of consecutive same-named calls reads. */
type RunStatus = 'running' | 'error' | 'done'

/** Status of one tool call. */
function statusOf(tool: ProgressTool): RunStatus {
  if (tool.elapsed === undefined) return 'running'
  return tool.isError === true ? 'error' : 'done'
}

/**
 * One line for a run of `count` consecutive same-named calls in the same state.
 *
 * The row's "what" rides on the label (`✅ \`read\` · src/x.ts · 40ms`) rather
 * than needing its own template: the templates only take a label and a duration,
 * and every locale already prints them as `icon label · duration`.
 */
function toolLine(
  t: Translations,
  name: string,
  status: RunStatus,
  elapsed: number,
  count: number,
  now: number,
  details: readonly string[],
): string {
  const what = details.length === 0 ? '' : ` · ${details.join(' / ')}`
  const label = `\`${name}\`${count > 1 ? ` ×${count}` : ''}${what}`
  const ms = status === 'running' ? Math.max(0, now - elapsed) : elapsed
  if (status !== 'running') {
    return status === 'error' ? t.turnCardToolFailed(label, formatProgressMs(ms)) : t.turnCardToolDone(label, formatProgressMs(ms))
  }
  // A call that has not been running for a measurable moment says so instead of
  // printing a frozen `0ms` — and once a tick has passed, the elapsed time it
  // shows is real (the card repaints every PROGRESS_RUNNING_TICK_MS while
  // anything is still running).
  const text = ms < 1_000 ? t.turnCardRunningLabel : formatProgressMs(ms)
  return t.turnCardToolRunning(label, text)
}

/**
 * Markdown the card's rows carry, so the shape is one decision in one place
 * (chosen by the user on a rendered card, 2026-10-12).
 *
 * - a tool call is an ITEM of an unordered list: the run of calls under one step
 *   reads as one list, which is what makes them belong to that step;
 * - a step's narration ("reply") is a QUOTE: it is the model talking BETWEEN the
 *   calls, and a quote separates it from the tool lines without another heading;
 * - the step's own line is the list's title, marked by the icon in
 *   `Translations.turnCardStep`.
 */
export const PROGRESS_TOOL_MARKER = '- '
export const PROGRESS_QUOTE_MARKER = '> '

/** Flatten the facts into ordered lines. */
function buildLines(t: Translations, facts: ProgressFacts): Line[] {
  const lines: Line[] = []
  for (const step of facts.steps) {
    const end = step.endedAt ?? facts.now
    const stepElapsed = `${formatProgressMs(end - step.startedAt)}${step.endedAt === undefined ? '…' : ''}`
    lines.push({ text: t.turnCardStep(step.step, stepElapsed), header: true, step: step.step })
    // Injection notices are the preamble of the request this step sends, so they
    // read first — above the narration and above the tool rows.
    for (const notice of step.injections ?? []) {
      if (notice === '') continue
      lines.push({ text: notice, header: false, step: step.step })
    }
    // The step's narration (if it had one) sits directly under its header: it is
    // what the step said BEFORE it decided to call tools, so it reads as the
    // section's preamble rather than as another tool row.
    if (step.note !== undefined && step.note !== '') {
      lines.push({ text: `${PROGRESS_QUOTE_MARKER}${t.turnCardStepNote(step.note)}`, header: false, step: step.step, note: true })
    }
    // Merge consecutive calls with the same name AND the same state: a `read`
    // run is one row, not ten. A run's elapsed is its own total (sum for
    // finished calls, `now - first start` for a running one), and so is its
    // "what": a `bash` run that ran three programs names the first three (the
    // distinct ones — the same file twice is one name).
    let index = 0
    while (index < step.tools.length) {
      const first = step.tools[index]!
      const status = statusOf(first)
      let count = 1
      let elapsed = first.elapsed ?? 0
      const details: string[] = []
      // At most PROGRESS_MAX_DETAILS NAMES on the row, first come first served:
      // a run of three commands that each ran two programs reads `npm / tail /
      // git`, not the five it happened to touch.
      const addDetails = (names: readonly string[] | undefined): void => {
        for (const name of names ?? []) {
          if (details.length >= PROGRESS_MAX_DETAILS) return
          if (name !== '' && !details.includes(name)) details.push(name)
        }
      }
      addDetails(first.detail)
      while (index + count < step.tools.length) {
        const next = step.tools[index + count]!
        if (next.name !== first.name || statusOf(next) !== status) break
        elapsed += next.elapsed ?? 0
        count += 1
        addDetails(next.detail)
      }
      lines.push({
        text: `${PROGRESS_TOOL_MARKER}${toolLine(t, first.name, status, status === 'running' ? first.startedAt : elapsed, count, facts.now, details)}`,
        header: false,
        step: step.step,
      })
      index += count
    }
  }
  return lines
}

/**
 * Render the card for the facts known so far.
 *
 * `now` is a parameter (not `Date.now()`) so the running labels are testable.
 *
 * @param t - translations for the active locale.
 * @param facts - the turn's steps, counters and clock.
 * @returns the full card JSON.
 */
export function renderProgressCard(t: Translations, facts: ProgressFacts): object {
  const running = facts.endedAt === undefined
  const end = facts.endedAt ?? facts.now
  const total = formatProgressMs(end - facts.turnStart)
  const title = running
    ? t.turnCardTitleRunning(facts.calls, total)
    : facts.failedTurn
      ? t.turnCardTitleFailed(facts.calls, total)
      : t.turnCardTitleDone(facts.calls, facts.failed, total)
  const template = running ? 'grey' : facts.failedTurn ? 'red' : 'green'

  // This card owns the turn from `segmentFrom` on: an earlier card — one that is
  // now above a card some other module posted — carries everything before it.
  const lines = buildLines(t, { ...facts, steps: facts.steps.slice(facts.segmentFrom ?? 0) })
  // Keep the NEWEST rows: a live process card is about what is happening now.
  // Rows are grouped into whole STEP blocks, because a section's rows without
  // their header read as belonging to the section above them.
  const blocks: Line[][] = []
  for (const line of lines) {
    const last = blocks[blocks.length - 1]
    if (last !== undefined && last[0]!.step === line.step) last.push(line)
    else blocks.push([line])
  }
  let visible: Line[] = []
  let steps = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!
    if (steps >= PROGRESS_MAX_STEPS) break
    if (visible.length > 0 && visible.length + block.length > PROGRESS_MAX_ROWS) break
    visible = block.concat(visible)
    steps += 1
  }
  // A single step larger than the whole budget still keeps its header plus its
  // newest rows; the dropped ones join the folded part.
  if (visible.length > PROGRESS_MAX_ROWS) {
    const header = visible.find(line => line.header)
    const rows = visible.filter(line => !line.header)
    visible = header === undefined
      ? rows.slice(rows.length - PROGRESS_MAX_ROWS)
      : [header, ...rows.slice(Math.max(0, rows.length - (PROGRESS_MAX_ROWS - 1)))]
  }
  const shown = new Set(visible)
  const hidden = lines.filter(line => !shown.has(line))

  const elements: object[] = []
  if (hidden.length > 0) {
    // The count is honest even when the body itself is capped: the folded panel
    // may carry at most PROGRESS_MAX_FOLDED lines (its JSON still ships with the
    // card, and a whole turn of rows is not worth a 30KB rejection).
    const body = hidden.slice(Math.max(0, hidden.length - PROGRESS_MAX_FOLDED))
    const truncated = body.length < hidden.length
    const content = `${truncated ? '…\n' : ''}${body.map(line => line.text).join('\n')}`
    elements.push(foldedPanel(t, t.turnCardOlderRows(hidden.length), [{ tag: 'markdown', content }]))
  }
  // One element per STEP, not one per row (2026-10-11).
  //
  // Every Feishu element is its own block and pays `vertical_spacing` on both
  // sides (关键坑 58), and this card used to render 40 single-line elements: a
  // measured turn spent 64px of pure spacing on 327 characters of text. Lines
  // inside ONE element are separated by an ordinary newline instead, so a step
  // costs one block — and the boundary BETWEEN steps keeps its spacing, which is
  // what makes the sections readable.
  //
  // A step's narration is model text and joins the block only when its inline
  // markup is balanced; an odd `**` would pair with the next line's (关键坑 60).
  // It keeps its own element in that case, which costs one block, not a lie.
  let block: string[] = []
  let blockStep: number | undefined
  const flush = (): void => {
    if (block.length === 0) return
    elements.push({ tag: 'markdown', content: block.join('\n') })
    block = []
    blockStep = undefined
  }
  for (const line of visible) {
    const loneNote = line.note === true && !inlineMarkupBalanced(line.text)
    if (loneNote || (blockStep !== undefined && line.step !== blockStep)) flush()
    if (loneNote) {
      elements.push({ tag: 'markdown', content: line.text })
      continue
    }
    blockStep = line.step
    block.push(line.text)
  }
  flush()

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { vertical_spacing: PROGRESS_ELEMENT_SPACING, elements },
  }
}

/** One live progress card. */
interface CardEntry {
  sessionId: string
  chat: ConversationMessage
  cardId: Promise<string | undefined>
  messageId: Promise<string | undefined>
  sequence: number
  /** Serializes writes per card; never rejects. */
  chain: Promise<unknown>
  /** A write is in flight right now. */
  writing: boolean
  /** Changes arrived while writing: re-render once the write lands. */
  dirty: boolean
  /** Timer implementing the trailing edge of the write throttle. */
  timer: ReturnType<typeof setTimeout> | undefined
  /**
   * Timer that repaints the elapsed clock of a tool that has been running for a
   * while. Armed only while something runs, dropped as soon as it settles, so a
   * fast call never costs an extra write.
   */
  runningTick: ReturnType<typeof setTimeout> | undefined
  /** The send itself failed: stop updating and answer in text at the end. */
  dead: boolean
  /**
   * Another module posted a card after this one: it is a closed segment. Writes
   * already in flight may land; nothing new is scheduled.
   */
  superseded: boolean
  facts: ProgressFacts
}

/** The controller's public surface, driven by the streaming module. */
export interface ProgressCardsHandle {
  /** `turn/start`: forget the previous turn's card and start a new row set. */
  beginTurn(chat: ConversationMessage, sessionId: string, at: number): void
  /** `step/start`: open a new section. */
  stepStarted(sessionId: string, step: number, at: number): void
  /**
   * Assistant text of a step that went on to call tools: the step's narration,
   * rendered as one row under its header instead of as a card of its own.
   */
  stepNote(sessionId: string, step: number, text: string, at: number): void
  /**
   * An injection notice this step claimed. It is process, so it renders on this
   * card rather than opening a step card (which used to appear as an empty card
   * carrying nothing but the notice).
   */
  stepInjection(sessionId: string, step: number, notice: string, at: number): void
  /** Whether this turn has a card on screen (used to decide who shows injections). */
  hasCard(sessionId: string): boolean
  /**
   * `tool/call`: append a running row (and open the card on the first one).
   * @param detail - the row's short "what" (`progressToolDetail`); omit when the
   *                 call has nothing short and useful to name.
   */
  toolStarted(sessionId: string, toolName: string, callId: string, at: number, detail?: readonly string[]): void
  /** `tool/result`: settle the row with that call id (fallback: oldest running). */
  toolFinished(sessionId: string, callId: string, elapsed: number, isError: boolean, at: number): void
  /** `step/end`: close the current section's clock. */
  stepEnded(sessionId: string, at: number): void
  /** `turn/end`: final render (green, or red when the turn failed). */
  finish(sessionId: string, at: number, failedTurn: boolean): Promise<void>
  /** Dispose: no late event may re-open a card. */
  stop(): void
}

export interface ProgressCardsDeps {
  channel: ProgressCardChannel
  logger: { warn(message: string): unknown }
  /** Strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
  /**
   * "Another module posted a card into this chat" (`src/card-interleave.ts`).
   * Ends the current segment: this card stops growing, the next event opens a
   * new one below the interruption.
   */
  interleave?: CardInterleave | undefined
}

/**
 * Start the turn progress-card writer.
 *
 * One card per session per turn. The card is opened LAZILY by the first tool
 * call: a turn that calls no tool has nothing to show here and gets no card
 * (which is also what keeps this feature invisible outside `compact` tool work).
 *
 * @param deps - channel, logger and the live translations.
 * @returns the handle the streaming module drives.
 */
export function createProgressCards(deps: ProgressCardsDeps): ProgressCardsHandle {
  const { channel, logger, getTranslations } = deps
  const cards = new Map<string, CardEntry>()
  /**
   * Cards whose segment an interrupting card closed. They never grow again but
   * still have to render the turn's outcome at `finish` (see {@link endSegment}).
   */
  const closedSegments = new Map<string, CardEntry[]>()
  /** Per-turn row state, kept for sessions whose card never opened. */
  const turns = new Map<string, { chat: ConversationMessage; facts: ProgressFacts }>()
  /** Set by {@link stop}: every entry point becomes a no-op. */
  let stopped = false

  /** Send opts that land in the chat's topic when it has one. */
  const topicOpts = (chat: ConversationMessage): { replyInThread?: boolean; replyTo?: string } =>
    chat.threadId !== undefined && chat.rootId !== undefined
      ? { replyInThread: true, replyTo: chat.rootId }
      : {}

  /**
   * Plain text the card can never carry: the summary plus every row, as one
   * text message. Text (not another card) is deliberate — the reason this runs
   * is that card writes are failing (关键坑 40).
   */
  const sendTextFallback = (entry: CardEntry): void => {
    const t = getTranslations()
    const lines = buildLines(t, entry.facts).map(line => line.text)
    void channel.send(entry.chat.chatId, { text: [renderTitle(t, entry.facts), ...lines].join('\n') }, topicOpts(entry.chat))
      .catch((error: unknown) => {
        logger.warn(`dsh-feishu: progress card notice failed: ${errorText(error, 'unknown error')}`)
      })
  }

  /** Whether any row of these facts is still waiting for its result. */
  const hasRunningTool = (facts: ProgressFacts): boolean =>
    facts.steps.some(step => step.tools.some(tool => tool.elapsed === undefined))

  /**
   * Repaint while a tool is still running. Without it the card keeps whatever
   * elapsed time the row had when it was written — usually `0ms`, because the
   * card is written the moment the call starts. A call that settles before the
   * first tick clears the timer, so fast tools cost nothing.
   */
  const armRunningTick = (entry: CardEntry): void => {
    if (entry.runningTick !== undefined || entry.dead) return
    entry.runningTick = setTimeout(() => {
      entry.runningTick = undefined
      if (stopped || entry.dead) return
      if (!hasRunningTool(entry.facts)) return
      entry.facts.now = Date.now()
      // Straight to the write: this repaint is the point of the timer, so it
      // must not wait for another event to trigger the throttle.
      writeNow(entry)
      armRunningTick(entry)
    }, PROGRESS_RUNNING_TICK_MS)
  }

  /** Cancel the running tick once nothing is running any more. */
  const disarmRunningTick = (entry: CardEntry): void => {
    if (entry.runningTick === undefined) return
    if (hasRunningTool(entry.facts)) return
    clearTimeout(entry.runningTick)
    entry.runningTick = undefined
  }

  /** Render one write, serialized behind the card's previous write. */
  const writeNow = (entry: CardEntry): void => {
    entry.writing = true
    entry.chain = entry.chain.then(async () => {
      if (entry.dead) return
      const card = renderProgressCard(getTranslations(), entry.facts)
      const cardId = await entry.cardId
      const messageId = await entry.messageId
      // CardKit instance first: its update API has no edit cap, unlike
      // im.v1.message.patch (关键坑 11 / 45).
      if (cardId !== undefined && cardId !== '' && channel.updateCardInstance !== undefined) {
        entry.sequence += 1
        await channel.updateCardInstance(cardId, card, entry.sequence)
        return
      }
      if (messageId !== undefined && channel.updateCard !== undefined) {
        await channel.updateCard(messageId, card)
        return
      }
      // Neither an instance nor a message id: nothing can ever be updated.
      entry.dead = true
    }).catch((error: unknown) => {
      logger.warn(`dsh-feishu: progress card update failed: ${errorText(error, 'unknown error')}`)
    }).then(() => {
      entry.writing = false
      // Coalesced changes: render the LATEST state, never replay the ones that
      // were superseded (their content is older than what is on the card).
      if (entry.dirty && !entry.dead && !entry.superseded) {
        entry.dirty = false
        writeNow(entry)
      }
    })
  }

  /** Leading-edge throttled write: first change writes now, the rest coalesce. */
  const schedule = (entry: CardEntry): void => {
    if (entry.superseded || entry.dead) return
    if (entry.writing) {
      entry.dirty = true
      return
    }
    if (entry.timer !== undefined) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (!stopped && !entry.dead && !entry.superseded) writeNow(entry)
    }, PROGRESS_WRITE_GAP_MS)
  }

  /** Open the card with the render the caller already has. */
  const open = (entry: CardEntry): void => {
    const opts = topicOpts(entry.chat)
    const render = (): object => renderProgressCard(getTranslations(), entry.facts)
    const useInstance = channel.createCardInstance !== undefined && channel.sendCardByReference !== undefined
    entry.cardId = useInstance
      ? channel.createCardInstance!(render())
        .then(id => (id === '' ? undefined : id))
        .catch((error: unknown) => {
          logger.warn(`dsh-feishu: progress card create failed: ${errorText(error, 'unknown error')}`)
          return undefined
        })
      : Promise.resolve(undefined)
    entry.messageId = entry.cardId.then(async (id): Promise<string | undefined> => {
      if (id !== undefined) {
        return channel.sendCardByReference!(entry.chat.chatId, id, opts).then(r => r.messageId)
      }
      return channel.send(entry.chat.chatId, { card: render() }, opts).then(r => r.messageId)
    }).catch((error: unknown) => {
      logger.warn(`dsh-feishu: progress card send failed: ${errorText(error, 'unknown error')}`)
      // No card exists any more: the turn's summary goes out as ONE text message
      // when it ends (a text line per tool event would be worse than silence).
      entry.dead = true
      return undefined
    })
    cards.set(entry.sessionId, entry)
  }

  const beginTurn = (chat: ConversationMessage, sessionId: string, at: number): void => {
    if (stopped) return
    // A new turn owns a new card: the previous one is a historical record and a
    // card entity may only be sent once, so it is simply forgotten here.
    cards.delete(sessionId)
    closedSegments.delete(sessionId)
    turns.set(sessionId, {
      chat,
      facts: { steps: [], calls: 0, failed: 0, turnStart: at, failedTurn: false, now: at },
    })
  }

  const stepStarted = (sessionId: string, step: number, at: number): void => {
    if (stopped) return
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    turn.facts.steps.push({ step, startedAt: at, tools: [] })
    turn.facts.now = at
  }

  /**
   * Record a step's narration. It lands on the step's own section, so it is
   * stored on the facts even when no card exists yet — the first tool call opens
   * the card from these very facts and renders the note with it.
   */
  const stepNote = (sessionId: string, step: number, text: string, at: number): void => {
    if (stopped) return
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    const note = condenseStepNote(text)
    if (note === '') return
    const facts = turn.facts
    // `step/start` normally opened the section already; a lost frame falls back
    // to opening it here rather than dropping the narration.
    let target = facts.steps.find(candidate => candidate.step === step)
    if (target === undefined) {
      target = { step, startedAt: at, tools: [] }
      facts.steps.push(target)
    }
    if (target.note === note) return
    target.note = note
    facts.now = at
    const entry = cards.get(sessionId)
    if (entry !== undefined) {
      entry.facts = facts
      schedule(entry)
    }
  }

  const toolStarted = (sessionId: string, toolName: string, callId: string, at: number, detail?: readonly string[]): void => {
    if (stopped) return
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    const facts = turn.facts
    // A tool call outside any step (a lost frame, a resumed session) still gets
    // a section rather than being dropped.
    let current = facts.steps[facts.steps.length - 1]
    if (current === undefined || current.endedAt !== undefined) {
      current = { step: facts.steps.length + 1, startedAt: at, tools: [] }
      facts.steps.push(current)
    }
    current.tools.push({ name: toolName, callId, startedAt: at, ...detail === undefined || detail.length === 0 ? {} : { detail } })
    facts.calls += 1
    facts.now = at
    const entry = cards.get(sessionId)
    if (entry === undefined) {
      const opened: CardEntry = {
        sessionId,
        chat: turn.chat,
        cardId: Promise.resolve(undefined),
        messageId: Promise.resolve(undefined),
        sequence: 0,
        chain: Promise.resolve(),
        writing: false,
        dirty: false,
        timer: undefined,
        runningTick: undefined,
        dead: false,
        superseded: false,
        facts,
      }
      open(opened)
      // The card that was just opened already shows this call as running, so the
      // elapsed-time tick has to start with it (not with the NEXT call).
      armRunningTick(opened)
      return
    }
    entry.facts = facts
    schedule(entry)
    armRunningTick(entry)
  }

  const toolFinished = (sessionId: string, callId: string, elapsed: number, isError: boolean, at: number): void => {
    if (stopped) return
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    const facts = turn.facts
    facts.now = at
    // Settle by call id. A result whose call id was never seen (a lost frame)
    // settles the oldest running row instead of being dropped.
    const running = (tool: ProgressTool): boolean => tool.elapsed === undefined
    let row: ProgressTool | undefined
    for (const step of facts.steps) {
      row = step.tools.find(tool => running(tool) && tool.callId === callId)
      if (row !== undefined) break
    }
    if (row === undefined) {
      for (const step of facts.steps) {
        row = step.tools.find(running)
        if (row !== undefined) break
      }
    }
    if (row !== undefined) {
      row.elapsed = elapsed
      if (isError) {
        row.isError = true
        facts.failed += 1
      }
    }
    const entry = cards.get(sessionId)
    if (entry !== undefined) {
      entry.facts = facts
      schedule(entry)
      // The last running row just settled: no repaint is worth scheduling any
      // more (this is what makes a fast tool cost nothing).
      disarmRunningTick(entry)
    }
  }

  const stepEnded = (sessionId: string, at: number): void => {
    if (stopped) return
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    const facts = turn.facts
    facts.now = at
    const current = facts.steps[facts.steps.length - 1]
    if (current !== undefined && current.endedAt === undefined) current.endedAt = at
    const entry = cards.get(sessionId)
    if (entry !== undefined) {
      entry.facts = facts
      schedule(entry)
    }
  }

  const finish = async (sessionId: string, at: number, failedTurn: boolean): Promise<void> => {
    if (stopped) return
    const turn = turns.get(sessionId)
    turns.delete(sessionId)
    const entry = cards.get(sessionId)
    cards.delete(sessionId)
    const closed = closedSegments.get(sessionId) ?? []
    closedSegments.delete(sessionId)
    if (turn === undefined) return
    const facts = turn.facts
    facts.now = at
    facts.endedAt = at
    facts.failedTurn = failedTurn
    const current = facts.steps[facts.steps.length - 1]
    if (current !== undefined && current.endedAt === undefined) current.endedAt = at
    // A closed segment still has to say how the turn ended: its body is frozen
    // (it is not the newest card any more, so new rows must not appear in it),
    // but a card claiming "进行中" after the turn ended is a lie. Counters come
    // from the live facts; the steps stay the snapshot.
    for (const frozen of closed) {
      if (frozen.timer !== undefined) clearTimeout(frozen.timer)
      if (frozen.runningTick !== undefined) clearTimeout(frozen.runningTick)
      frozen.facts = { ...frozen.facts, calls: facts.calls, failed: facts.failed, endedAt: at, failedTurn, now: at }
      frozen.dirty = false
      writeNow(frozen)
    }
    if (entry === undefined) {
      // Nothing is on screen for the newest segment: the closed card above the
      // interruption already carries this turn's outcome.
      await Promise.all(closed.map(frozen => frozen.chain))
      return
    }
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (entry.runningTick !== undefined) {
      clearTimeout(entry.runningTick)
      entry.runningTick = undefined
    }
    entry.facts = facts
    // The final render bypasses the throttle: a card that stays grey after the
    // turn ended is a lie, and one extra write is affordable here. Nothing is
    // dirty any more — this render already carries the final facts.
    entry.dirty = false
    writeNow(entry)
    await Promise.all([...closed.map(frozen => frozen.chain), entry.chain])
    if (entry.dead) sendTextFallback(entry)
  }

  /**
   * Record an injection notice on the step that claimed it, so it renders as a
   * row of this card instead of opening a step card of its own.
   */
  const stepInjection = (sessionId: string, step: number, notice: string, at: number): void => {
    if (stopped || notice === '') return
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    const facts = turn.facts
    let target = facts.steps.find(candidate => candidate.step === step)
    if (target === undefined) {
      target = { step, startedAt: at, tools: [] }
      facts.steps.push(target)
    }
    const list = target.injections ?? (target.injections = [])
    // The same notice can arrive twice for one step (a re-injection, a retried
    // frame); one row is enough.
    if (list[list.length - 1] === notice) return
    list.push(notice)
    facts.now = at
    const entry = cards.get(sessionId)
    if (entry !== undefined) {
      entry.facts = facts
      schedule(entry)
    }
  }

  /** Whether this turn already has a card on screen. */
  const hasCard = (sessionId: string): boolean => cards.has(sessionId)

  /**
   * Another module posted a card into this chat: close this segment. What is on
   * screen stays as it is (it now sits above the interruption), and the next
   * event that really has something new — a tool call, a step — opens a new card
   * below it. Nothing is opened here on purpose: a question card, its
   * confirmation card and its retirement notice are three interruptions in a
   * row, and opening one card each produced exactly the "碎卡片" the user
   * reported (2026-10-09): several identical cards carrying the same running
   * step and no new row at all.
   */
  const endSegment = (chatId: string, at: number): void => {
    for (const [sessionId, turn] of turns) {
      if (turn.chat.chatId !== chatId) continue
      const facts = turn.facts
      const entry = cards.get(sessionId)
      if (entry !== undefined) {
        // Freeze what THIS card has already rendered: a write still in flight
        // must not suddenly switch the old card to the new segment's content.
        entry.facts = { ...facts, steps: [...facts.steps] }
        entry.superseded = true
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer)
          entry.timer = undefined
        }
        // The running tick is deliberately left alone: a call that is still
        // running keeps its elapsed clock on the closed card (that is a status
        // write, not a new row — new rows only ever go to the new segment).
        // Keep the entry as the turn's closed segment: it still has to show the
        // turn's outcome (a card that says "进行中" forever is a lie), but it
        // never grows again.
        const closed = closedSegments.get(sessionId) ?? []
        closed.push(entry)
        closedSegments.set(sessionId, closed)
        // Forget it as the CURRENT card: the next real event opens a new one (a
        // card entity may be sent once, and updating in place is exactly what
        // would read out of order once another card sits below it).
        cards.delete(sessionId)
      }
      const last = facts.steps[facts.steps.length - 1]
      // A step that is still running stays in the next segment (with its header),
      // otherwise its remaining tools would land in a card that never shows them.
      facts.segmentFrom = Math.max(0, last !== undefined && last.endedAt === undefined
        ? facts.steps.length - 1
        : facts.steps.length)
      facts.now = at
    }
  }

  const unsubscribe = deps.interleave?.onNotice(chatId => endSegment(chatId, Date.now()))

  const stop = (): void => {
    // A late event must not re-open a card: this module is disposed with the
    // listener, but an event already queued can still be delivered.
    stopped = true
    unsubscribe?.()
    for (const entry of [...cards.values(), ...[...closedSegments.values()].flat()]) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      if (entry.runningTick !== undefined) clearTimeout(entry.runningTick)
    }
    cards.clear()
    closedSegments.clear()
    turns.clear()
  }

  return { beginTurn, stepStarted, stepNote, stepInjection, hasCard, toolStarted, toolFinished, stepEnded, finish, stop }
}

/** The card's title, for the plain-text fallback. */
function renderTitle(t: Translations, facts: ProgressFacts): string {
  const end = facts.endedAt ?? facts.now
  const total = formatProgressMs(end - facts.turnStart)
  if (facts.endedAt === undefined) return t.turnCardTitleRunning(facts.calls, total)
  if (facts.failedTurn) return t.turnCardTitleFailed(facts.calls, total)
  return t.turnCardTitleDone(facts.calls, facts.failed, total)
}
