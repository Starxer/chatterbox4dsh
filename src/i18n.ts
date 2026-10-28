/**
 * Language / localization seam for the Feishu channel.
 *
 * The plugin registers an optional `locale` setting under its own namespace
 * (`lark-channel`). When that field is absent, the plugin falls back to the
 * DSH browser-language preference (the host `locale` namespace registered by
 * `@deepseek-ai/dsh-client-locale`); when that is also absent it defaults to
 * `zh`. This module owns that resolution and the zh/en string dictionaries the
 * command layer and every card renderer consume.
 *
 * The dictionaries are typed against a single `Translations` shape and each
 * locale object is checked with `satisfies`, so a missing key in either
 * language fails the typecheck rather than silently rendering a blank string.
 *
 * Terminology aligns with the DSH native UI (each client package's
 * `src/client/locales.ts` is the source of truth): `Agent 预设`, `会话`,
 * `工作区`, `推理等级`, `等待审批` / `允许一次` / `拒绝`, `分叉会话`,
 * `交付文件`, and the permission presets `仅可查看` / `工作区内修改` / `完全权限`.
 *
 * @module @starxer/chatterbox4dsh/i18n
 */

import type { TranscriptView } from './display-level.ts'

/** Locale identifiers the plugin ships. */
export const LOCALE_IDS = ['zh', 'en'] as const
export type LocaleId = (typeof LOCALE_IDS)[number]
/** Canonical plugin locale; `'auto'` means "follow the DSH preference". */
export type PluginLocale = LocaleId | 'auto'

export interface Translations {
  // ---- Card lifecycle (card-supersede.ts) ----
  cardSupersededTitle: string
  cardSupersededBody: string
  /** Appended to a retired card that keeps its original content. */
  cardStaleNote: string
  /** Appended to a DECISION card that is frozen on the choice it recorded. */
  cardSettledNote: (value: string) => string
  /** Shown on a card whose request was already answered in the DSH Web UI. */
  cardAnsweredElsewhereTitle: string
  cardAnsweredElsewhereBody: string

  // ---- Approval card (feishu-approvals.ts) ----
  approvalCardTitle: string
  /** Includes the bold markers and the trailing colon, e.g. `**Tool:**`. */
  approvalToolLabel: string
  /** Includes the bold markers and the trailing colon, e.g. `**Reason:**`. */
  approvalReasonLabel: string
  approvalLocationHint: (shortCode: string, inThread: boolean) => string
  approvalApproveOnce: string
  approvalReject: string
  approvalApprovedTitle: string
  approvalRejectedTitle: string
  approvalDecidedLine: (approved: boolean) => string
  /** Header/body of a card whose request ended with the turn (aborted). */
  approvalExpiredTitle: string
  approvalExpiredBody: string

  // ---- Session panel (feishu-session.ts) ----
  sessionPanelTitle: string
  sessionPanelIntro: string
  sessionListHeader: string
  sessionListEmpty: string
  sessionEntry: (index: number, title: string, id: string, lastActive: string, ownerLabel: string | undefined) => string
  sessionSwitch: string
  sessionDetach: string
  sessionArchive: string
  sessionFork: string
  sessionRename: string
  sessionPin: string
  sessionUnpin: string

  // ---- `/fork` turn picker (feishu-fork.ts) ----
  forkCardTitle: string
  forkCardHint: string
  forkRowTitle: (turn: number) => string
  forkRowNoPreview: string
  forkEmptyTurns: string
  forkUnsupported: string
  forkNoSession: string
  forkMoreTurns: (count: number) => string
  forkUnknownTurn: (turn: number) => string
  forkUsage: string
  forkSuccess: (turn: number, sessionId: string) => string
  forkFailed: (reason: string) => string
  sessionConfirmTitle: (action: string) => string
  sessionConfirmBody: (action: string, name: string) => string
  sessionConfirmOk: string
  sessionConfirmCancel: string
  /** Confirm button when archiving must stop the session's running work first. */
  sessionConfirmOkStopArchive: string
  /** Display label for one running-work family reported by `WorkspaceActiveSessionError`. */
  sessionActivityKind: (kind: string) => string
  sessionRenameTitle: string
  sessionRenamePlaceholder: string
  sessionRenameConfirm: string
  sessionRenameCancel: string
  sessionResultSwitched: (target: string) => string
  sessionResultDetached: (label: string) => string
  sessionResultArchived: () => string
  sessionResultForked: (id: string) => string
  sessionResultRenamed: (title: string) => string
  sessionResultPinned: (label: string) => string
  sessionResultUnpinned: (label: string) => string
  sessionResultPinArchived: (label: string) => string
  sessionResultPinFailed: (label: string) => string
  sessionErrorOccupied: string
  sessionErrorArchived: string
  sessionErrorInvalid: string
  sessionActionLabel: (action: string) => string

  // ---- Model select (feishu-model-select.ts) ----
  modelSelectTitle: (newSession: boolean) => string
  modelSelectCurrent: (provider: string, model: string, effort: string) => string
  modelSelectProviderHeader: string
  modelSelectProviderPlaceholder: string
  modelSelectModelHeader: string
  modelSelectModelEmpty: string
  modelSelectModelPlaceholder: (empty: boolean) => string
  modelSelectEffortHeader: string
  modelSelectEffortPlaceholder: string
  modelSelectConfirm: (newSession: boolean) => string
  modelSelectNewSessionTitle: string

  // ---- Permission (feishu-permission.ts) ----
  permissionTitle: string
  permissionCurrent: (mode: string) => string
  permissionHint: string
  permissionReadOnly: string
  permissionWorkspaceWrite: string
  permissionFullAccess: string

  // ---- Busy mode (feishu-busy.ts) ----
  busyTitle: string
  busyIntro: string
  busyQueueLabel: string
  busySteerLabel: string
  busyCurrentOption: (mode: string) => string

  // ---- Questions (feishu-questions.ts) ----
  questionSkip: string
  questionChoicePrefix: string

  // ---- Onboarding (feishu-onboarding.ts) ----
  onboardingTitle: string
  onboardingSubtitle: string
  onboardingSelectPreset: string
  onboardingPresetLabel: (id: string) => string
  onboardingNewSessionLabel: string
  onboardingStart: string

  // ---- Folded panels (card-fold.ts) ----
  /**
   * Append the "this is folded" hint to a panel header title. A function, not
   * a string: CJK wants no space before the bracket and Latin wants one.
   */
  cardFoldTitle: (title: string) => string

  // ---- Streaming / per-step + turn complete (feishu-streaming.ts) ----
  stepReasoningHeader: string
  stepMessageHeader: string
  stepToolHeader: string
  stepToolSuccess: string
  stepToolError: string
  stepToolRunning: string
  stepToolArgsHeader: string
  stepToolResultHeader: string
  stepCardTitleError: string
  stepCardTitleDone: string
  stepCardTitleCall: string
  stepCardTitleReply: string
  /** Title of the placeholder card posted the moment a step starts, before any output exists. */
  stepPlaceholderTitle: string
  /** Marks a step card belonging to a turn a background-job notice opened. */
  /**
   * Attribution line on a step card of a turn no human message opened: the
   * family of non-human message DSH let begin it (see `autoTurnTrigger`).
   */
  stepAutoTriggerNote: (trigger: string) => string
  /** Localized name of one non-human turn-trigger family (the Web UI's wording). */
  autoTurnTriggerName: (kind: string) => string
  /** Label of the browser surface, used when a turn came from the Web GUI. */
  surfaceLabelWebGui: string
  /** Label of any other non-Feishu surface. */
  surfaceLabelOther: string
  /** One-line body of that placeholder, telling the reader it updates in place. */
  stepPlaceholderBody: string
  /**
   * Title while the request is out but the model has not returned a token yet.
   * The live assistant stream's `start` frame is what moves the card here.
   */
  stepAwaitingTitle: string
  /** One-line body of the awaiting phase. */
  stepAwaitingBody: string
  /** Title once the FIRST reasoning delta arrives (the model really started thinking). */
  stepThinkingTitle: string
  /** One-line body of the thinking phase. */
  stepThinkingBody: string
  /** Title once the FIRST text delta arrives (the model started answering). */
  /** The model is EMITTING a tool call (live `tool-call-delta`), not thinking. */
  stepToolTitle: string
  stepToolBody: string
  stepReplyingTitle: string
  /** One-line body of the replying phase (text is streaming, not on the card yet). */
  stepReplyingBody: string
  /** Route line shown while a request is in flight, e.g. `📡 provider / model`. */
  stepRouteLine: (provider: string, model: string) => string
  /** Title of a step that ended without anything to show (the placeholder's terminal form). */
  stepEmptyTitle: string
  /** Body of that same terminal form. */
  stepEmptyBody: string
  /** Step position suffix on the card title, e.g. `第 2 轮 · 第 3 步`. */
  stepPosition: (turn: number, step: number) => string
  /**
   * Plain-text notice that one step card could not be updated any more and
   * therefore keeps rendering older content than the chat state.
   */
  stepCardStaleNotice: (turn: number, step: number, reason: string) => string
  /** One line of tool-call totals, shown by the `compact` detail level. */
  stepToolCount: (calls: number, failed: number) => string

  // ---- Turn progress card (feishu-progress.ts) ----
  // One card per turn, `compact` level only: the turn's tool activity merged
  // into a single card updated in place. Durations arrive already formatted
  // (`3.2s`) because they read the same in both languages.
  /**
   * Title while the turn is still running, e.g. `🐳 深度求索中 · 12.3s`.
   *
   * Deliberately NOT the settled title with a different word: this card is
   * scanned while the model works, and the tool count it used to carry is
   * already readable from the rows below (the running STEP's header carries the
   * live phase). What the title has to say is that the turn is still going, and
   * how long it has been going.
   */
  turnCardTitleRunning: (elapsed: string) => string
  /** Title once the turn ended normally. */
  turnCardTitleDone: (calls: number, failed: number, elapsed: string) => string
  /** Title when the turn ended in an error (the reason rides the failure card). */
  turnCardTitleFailed: (calls: number, elapsed: string) => string
  /**
   * Section header of one step, e.g. `**第 2 步** · 8.9s`. `light` is the live
   * phase of a step that is STILL RUNNING and is inserted between the step number
   * and the clock (`**第 2 步** · 🧠 思考中 · 8.9s…`); it is absent for a step that
   * ended, which is exactly what the callers pass.
   */
  turnCardStep: (step: number, elapsed: string, light?: string) => string
  /**
   * Suffix naming the step the turn DIED in, appended to {@link turnCardStep}:
   * `▸ **第 6 步** · 22.3s · ❌ 失败`. Carries its own icon because it is a status
   * mark, not a phase (`turnCardPhaseTool` already owns `🔧`).
   */
  turnCardStepFailed: string
  /**
   * One call that a failed model attempt streamed but never committed, so it
   * never ran: `⚠️ \`edit\` · 未执行`. `name` is the bare tool name — the row adds
   * the markup, like every other tool row does with its label.
   */
  turnCardCallUnrun: (name: string) => string
  /**
   * The step's own narration — the assistant text of a step that went on to call
   * tools, i.e. process rather than answer. Already collapsed to one line.
   */
  turnCardStepNote: (note: string) => string
  /** One tool call that has not returned yet; `label` is already in markup. */
  turnCardToolRunning: (label: string, elapsed: string) => string
  /**
   * What a call that has not been running for a measurable moment says instead of
   * a frozen `0ms` (`执行中` / `running`).
   */
  turnCardRunningLabel: string
  /** One tool call that returned successfully. */
  turnCardToolDone: (label: string, elapsed: string) => string
  /** One tool call that returned an error. */
  turnCardToolFailed: (label: string, elapsed: string) => string
  /** Header of the folded panel holding the rows that no longer fit. */
  turnCardOlderRows: (rows: number) => string
  /**
   * The live light on the step that is still running: what the model is doing
   * RIGHT NOW, as the step header's suffix (`▸ **第 2 步** · 🧠 思考中 · 4.8s…`).
   *
   * Three phases plus the tool state, one per line the stream can be in. The
   * wording deliberately reuses the content-free step card's placeholder titles
   * (`stepAwaitingTitle` / `stepThinkingTitle` / `stepReplyingTitle`), so one
   * phase of one turn never has two names in one chat.
   */
  turnCardPhaseAwaiting: string
  turnCardPhaseThinking: string
  turnCardPhaseReplying: string
  /** One of that step's tool calls has not returned yet (wins over the phase). */
  turnCardPhaseTool: string

  // ---- Context injections (injection-notice.ts) ----
  // One line per injected context message, carried at the TOP of the step card
  // that claims it. Only `source` metadata is ever rendered, never the injected
  // content (see docs/transcript-parity-design.md §1.5).
  /** Generic prefix, e.g. `📥 注入上下文`. */
  injectionContext: string
  injectionRecall: string
  injectionRelay: string
  injectionSubagent: string
  injectionGoal: string
  injectionSkillLoaded: string
  /** `（N 条）` suffix naming a skill catalog's entry count. */
  injectionSkillCatalog: (entries: number) => string
  /** Names the plugin package a `plugin` injection re-declared. */
  injectionPlugin: (name: string) => string
  injectionRuntimeSnapshot: string
  injectionApproval: string
  /** The four `agent-instructions` actions, worded as the WebUI words them. */
  injectionActionLoaded: string
  injectionActionAdded: string
  injectionActionUpdated: string
  injectionActionRemoved: string
  injectionFromSession: (sessionId: string) => string
  injectionRound: (round: number) => string

  // ---- Compaction card (feishu-compaction.ts) ----
  compactionCardTitleStart: string
  compactionCardTitleDone: string
  /** Done title for a manual transaction, which the WebUI labels with the command. */
  compactionCardTitleDoneManual: string
  compactionCardTitleFailed: string
  compactionStartBody: (trigger: string) => string
  compactionTriggerAuto: string
  compactionTriggerManual: string
  /** Details line above the fold: how many history items were replaced. */
  compactionFoldedItems: (items: number) => string
  /** Details line above the fold: their token price. */
  compactionFoldedTokens: (tokens: string) => string
  compactionSummaryLabel: string
  compactionSummaryUnavailable: string
  /** Shown under a summary that did not fit the card's byte budget. */
  compactionSummaryCut: (shown: number, total: number) => string
  compactionFailedReason: (reason: string) => string
  compactionNoSummary: string
  turnCompleteTitle: string
  /**
   * Title of the card that ENDS a `compact` turn: the answer card carrying the
   * trimmed summary, or the reply card when the answer never reached a step card
   * (`src/turn-summary.ts`). It states the two facts a reader looks for while
   * scrolling history — the turn is over, and how long it took — because the
   * footer below is notation-sized and easy to miss. The clock is appended by
   * `compactCompletionTitle`; the title carries NO turn/step position (the user's
   * call, 2026-10-14: "完成 plus the time", it does not need to say which step).
   */
  turnSummaryTitle: string
  /**
   * Where a "continued" card sits in a split reply (`续 2/3` / `continued 2/3`):
   * used alone on a card that carries only part of the answer, and as a segment
   * of the completion title on the LAST fragment when the reply was split.
   */
  turnContinuedPart: (part: number, total: number) => string
  /**
   * The same marker for a reply that needed exactly ONE continuation card, where
   * `续 1/1` would be a number with nothing to count (`📄 续` / `📄 continued`).
   */
  turnContinuedTitle: string
  turnCompleteDetail: (duration: string, llm: string, tools: string) => string
  turnCompleteSteps: (steps: number, tokens: string, speed: string) => string
  /**
   * Footnote on a Turn Complete card for a turn that did not start from a Feishu
   * message, naming what it came from instead.
   */
  turnCompleteExternalTurn: (source: string) => string
  /** Prefix of a user message mirrored from the Web GUI. */
  externalMessageFromWebGui: string
  /** Prefix of a user message mirrored from another non-Feishu surface. */
  externalMessageFromOther: string
  /** Attachment summary appended to a mirrored message (phase one does not upload them). */
  externalMessageAttachments: (images: number, files: number) => string
  enterWhileBusy: string
  /** Plain-text notice sent when a busy-mode message is injected into the running turn. */
  busySteeredNotice: string
  /** Plain-text notice sent when a busy-mode message is queued behind the running turn. */
  busyQueuedNotice: string
  // ---- Turn failure (turn-failure.ts; mirrors DSH Web UI `message.turnError`
  // and `message.failure.auth` — the Web UI is the source of truth) ----
  /** Red-card title for a failed turn, e.g. `本轮运行失败`. */
  turnFailedTitle: string
  /** Body substituted for an `AUTH` failure whose message may echo a credential. */
  failureAuth: string

  // ---- Status (renderStatusCard in index.ts) ----
  statusRunWarning: string
  statusSessionLabel: string
  statusTitleLabel: string
  statusWorkspaceLabel: string
  statusPresetLabel: string
  statusModelLabel: string
  statusReasoningLabel: string
  statusPermissionLabel: string
  statusBusyLabel: string
  statusAgentLabel: string
  statusAgentRunning: string
  statusAgentIdle: string

  // ---- Misc shared ----
  cancel: string
  confirm: string
  back: string
  next: string

  // ---- Extra keys for the bilingual card renderers ----

  // Busy card body (feishu-busy.ts)
  busyCurrentLabel: string
  busyHint: string
  busyQueueWord: string
  busySteerWord: string
  busyQueueDesc: string
  busySteerDesc: string

  // Permission extras (feishu-permission.ts)
  permissionNoSession: string
  /** Warning line for a switch DSH refused; `reason` is the raw error text. */
  permissionSwitchFailed: (reason: string) => string
  /** One extra sentence shown when the refusal is DSH's persistent-shell fence. */
  permissionSwitchBusyShellHint: string

  // Turn Complete deliverables (channel.ts / feishu-deliver.ts, from
  // `deliverables/presented`)
  deliverablesTitle: (count: number) => string
  /**
   * Header of the standalone delivery card the `compact` level posts instead of
   * listing the rows on a Turn Complete card: the answer card is written in
   * place too often to carry clickable rows (关键坑 11 / 55).
   */
  deliverablesCardTitle: string
  deliverablesMore: (count: number) => string
  /**
   * One line reporting files the turn produced without `present`
   * (`src/produced-files.ts`). Deliberately a count and never a path list: a
   * chat is not a workspace browser, and the artifact-shaped files among them
   * are listed by the delivery rows above instead.
   */
  turnProducedLine: (count: number) => string
  /** Hint line above rows the operator can send with a tap. */
  deliverTapHint: string
  /** Suffix on a clickable row: tapping opens a confirmation. */
  deliverTapToSend: string
  /** Marker on a document this turn delivered by itself. */
  deliverAutoSent: string
  /** Link label that makes the card hydrator inline a media file. */
  deliverPreview: string
  /** Why a row cannot be sent by tapping. */
  deliverBlockedReason: (reason: 'too-large' | 'unreadable' | 'outside') => string
  /** Header shared by the confirmation and settlement cards. */
  deliverCardTitle: string
  /** Confirmation body: what would be sent, and how big it is. */
  deliverConfirmBody: (name: string, size: string) => string
  deliverSendButton: string
  deliverCancelButton: string
  deliverSent: (name: string) => string
  deliverCancelled: (name: string) => string
  deliverFailed: (name: string, reason: string) => string
  deliverAutoFailed: (name: string, reason: string) => string
  deliverExpired: string
  deliverFileGone: string
  deliverOutside: string
  deliverTooLarge: string

  // Display switch card (feishu-display.ts)
  displayCardTitle: string
  displayCardHint: string
  displayCardLabel: (key: 'reasoning' | 'tools' | 'args' | 'results') => string
  displayCardButton: (label: string, enabled: boolean) => string
  displayCardHiddenByTools: string
  displayCardNote: string
  displayCardTickTitle: string
  displayCardTickHint: string
  displayCardTickButton: (seconds: number, active: boolean) => string
  pendingAttachmentsNotice: (images: number, files: number) => string
  pendingAttachmentsDiscarded: string
  /** Section heading for the four detail levels on the card. */
  displayCardLevelTitle: string
  /** One level's own name, spelled as the WebUI settings page spells it. */
  displayLevelName: (level: TranscriptView) => string
  /** A level button, marked when it is the active one. */
  displayCardLevelButton: (name: string, active: boolean) => string
  /** What a level means, one line per level. */
  displayLevelHint: (level: TranscriptView) => string
  /** The level today's four switches add up to, when no level has been chosen. */
  displayLevelCustom: string
  /** Confirmation after `/display <level>`. */
  displayLevelSet: (name: string) => string

  // Model select extras (feishu-model-select.ts)
  modelSelectProviderLabel: (label: string) => string
  modelSelectBack: string
  modelSelectSwitchedHeader: string
  modelSelectSwitchedNext: string
  /** Button label for the quick "back to the previous route" action. Kept
   *  short because Feishu truncates button captions; the route itself goes in
   *  the card body. */
  modelSelectLastUsedButton: string
  /** Card-body line naming the route the button switches back to. */
  modelSelectLastUsed: (provider: string, model: string) => string
  /** The quick action succeeded — and changed only this session. */
  modelSelectLastUsedSwitched: string
  /** The quick action could not switch. */
  modelSelectLastUsedFailed: (reason: string) => string
  /** Section header above the GLOBAL recently-used models on the picker card. */
  modelSelectRecentHeader: string
  /** The row of the recently-used list that is the Session's current route. */
  modelSelectRecentCurrent: (provider: string, model: string) => string
  /** The `/new` flow's variant of the recent-models header: tapping a row picks
   *  the route for the session that is ABOUT TO be created — it does not switch
   *  the session that is running. */
  modelSelectRecentHeaderNewSession: string
  /** The `/new` flow's variant of the "back to last used" button. */
  modelSelectLastUsedButtonNewSession: string
  /** The `/new` flow's variant of the card-body line above that button. */
  modelSelectLastUsedNewSession: (provider: string, model: string) => string
  /** The `/new` flow's DEFAULT route as a tappable row: the default is a
   *  choice there (it is what the new session inherits), not just context. */
  modelSelectNewSessionDefault: (provider: string, model: string, effort: string) => string
  /** A quick pick in the `/new` flow names a route this Host no longer offers. */
  newSessionRouteUnavailable: string
  /** `/reasoning` quick-effort card. */
  reasoningCardTitle: string
  reasoningCardHint: string
  reasoningCardCurrent: (effort: string) => string
  reasoningCardDefault: string
  reasoningCardSwitched: (effort: string) => string
  reasoningCardOnlySession: string
  reasoningCardEmpty: string
  reasoningCardNoAgent: string
  reasoningCardUnsupported: string
  /** Confirmation that a recent-model row switched only this session. */
  modelSelectRecentSwitched: string
  /** Why the quick switch could not run (no live Session). */
  modelSelectLastUsedFailedNoSession: string
  /** Why the quick switch could not run (host has no request hooks). */
  modelSelectLastUsedFailedUnsupported: string
  modelSelectEffortLine: (effort: string) => string
  modelSelectFailHeader: string
  modelEffortDefault: string
  modelEffortOff: string
  modelEffortLow: string
  modelEffortHigh: string
  modelEffortMax: string

  // Session panel / confirm / result extras (feishu-session.ts)
  sessionPanelSelectLabel: string
  sessionPanelSelectPlaceholder: (empty: boolean) => string
  sessionPanelActionLabel: string
  sessionPanelCount: (total: number, locked: number) => string
  sessionPanelHint: string
  sessionListButton: string
  sessionRefreshButton: string
  sessionOpSwitch: string
  sessionOpDetach: string
  sessionOpArchive: string
  sessionOpFork: string
  sessionOpRename: string
  sessionOpPin: string
  sessionOpUnpin: string
  sessionConfirmDetailSwitch: (label: string) => string
  sessionConfirmDetailDetach: (label: string) => string
  sessionConfirmDetailArchive: (label: string) => string
  /** Shown when the session still has running work: archiving would stop it first. */
  sessionConfirmDetailArchiveActive: (label: string, activity: string) => string
  sessionConfirmDetailFork: (label: string) => string
  sessionConfirmDetailRename: (label: string) => string
  sessionResultEmptyTitle: string
  sessionResultEmptyBody: string
  sessionResultUnavailable: string
  sessionResultUnavailableRename: string
  sessionResultRenamedHeader: string
  sessionResultRenamedBody: (label: string) => string
  sessionResultRenameFailed: string
  sessionResultCancelled: string
  sessionResultCancelledBody: string
  sessionResultArchivedHeader: string
  sessionResultArchivedSwitchBody: (label: string) => string
  sessionResultSwitchedHeader: string
  sessionResultSwitchedBody: (label: string) => string
  sessionResultDetachHeader: string
  sessionResultDetachFree: (label: string) => string
  sessionResultDetachReleased: (label: string, owner: string) => string
  sessionResultArchivedOk: string
  sessionResultArchivedBody: (label: string) => string
  sessionResultForkHeader: string
  sessionResultForkBody: (label: string, id: string | undefined) => string
  sessionResultOpFailed: string
  sessionResultUnsupported: (name: string) => string
  sessionRenamePrompt: (label: string) => string
  sessionRenameButton: string
  sessionListTitle: string
  sessionListTableHeader: string
  sessionListNone: string
  sessionTimeJustNow: string
  sessionTimeMinute: string
  sessionTimeHour: string
  sessionTimeDay: string

  // Onboarding extras (feishu-onboarding.ts)
  onboardingAttachTitle: string
  onboardingSessionFallback: (index: number, id: string) => string
  onboardingInUse: (owner: string) => string
  onboardingNoSessions: string
  onboardingPickExisting: string
  onboardingSelectPlaceholder: string
  onboardingAttachButton: string
  onboardingNewButton: string
  onboardingIntro: (threadLabel: string) => string
  onboardingWorkspaceHeader: string
  onboardingNoWorkspaces: string
  onboardingNewWorkspaceHeader: string
  onboardingWorkspacePlaceholder: string
  onboardingCreateWorkspaceButton: string
  onboardingNewTitle: string
  onboardingPresetHeader: string
  onboardingNoPresets: string
  onboardingCreatedTitle: string
  onboardingCreatedBody: (sessionId: string, summary: string) => string
  /** Final confirmation card of the `/new` flow (all settings in one card). */
  newSessionConfirmTitle: string
  newSessionConfirmHint: string
  newSessionConfirmCreate: string
  newSessionConfirmCancel: string
  newSessionCancelledTitle: string
  newSessionCancelledBody: string
  /** Summary line parts of the confirmation card. */
  newSessionConfirmWorkspace: (path: string) => string
  /** Extra line when the chosen workspace will be created at this last step (O16). */
  newSessionConfirmWillCreate: (path: string) => string
  newSessionConfirmPreset: (preset: string) => string
  newSessionConfirmModel: (route: string) => string
  newSessionConfirmEffort: (effort: string) => string
  newSessionConfirmDefaults: string
  /** Step cards of the `/new` flow: the card where a choice was made is
   *  REWRITTEN into one of these settlement cards (title + the decision), the
   *  same way an answered question card is rewritten. */
  newSessionSettledWorkspaceTitle: string
  newSessionSettledWorkspace: (path: string) => string
  /** Extra line when that workspace does not exist yet (O16). */
  newSessionSettledWillCreate: string
  newSessionSettledPresetTitle: string
  newSessionSettledPreset: (preset: string) => string
  newSessionSettledModelTitle: string
  newSessionSettledModel: (provider: string, model: string) => string
  /** Footer of every settlement card: it is inert, continue below. */
  newSessionSettledHint: string
  onboardingAttachedTitle: string
  onboardingTakeover: (owner: string) => string
  onboardingAttachedBody: (sessionId: string, takeover: string) => string
  onboardingAttachArchivedTitle: string
  onboardingAttachArchivedBody: string
  onboardingCreateWorkspaceFailTitle: string
  onboardingCreateWorkspaceFailBody: (path: string, msg: string) => string
  onboardingCancelTitle: string
  onboardingCancelledBody: string
  onboardingBrowseButton: string
  onboardingBrowseTitle: string
  onboardingBrowseHeader: (path: string) => string
  onboardingBrowseUp: string
  onboardingBrowseHome: string
  onboardingBrowseShowHidden: string
  onboardingBrowseHideHidden: string
  onboardingBrowsePrev: string
  onboardingBrowseNext: string
  onboardingBrowsePage: (page: number, total: number) => string
  onboardingBrowseEmpty: string
  onboardingBrowseTruncated: string
  onboardingBrowsePick: string
  onboardingBrowseBack: string
  /** Confirming a workspace path that does not exist yet (O16). */
  onboardingCreateWorkspaceConfirmTitle: string
  onboardingCreateWorkspaceConfirmBody: (path: string) => string
  onboardingCreateWorkspaceConfirmButton: string
  onboardingCreateWorkspaceBackButton: string
  onboardingCreateWorkspaceSiblingHeader: (parent: string) => string
  onboardingCreateWorkspaceNotAbsolute: (path: string) => string
  onboardingCreateWorkspaceNotADirectory: string
  /** Creating a folder from the browser (O17). */
  onboardingBrowseNewFolder: string
  onboardingBrowseNewFolderPlaceholder: string
  onboardingBrowseNewFolderExists: (name: string) => string
  onboardingBrowseNewFolderInvalid: (name: string) => string
  onboardingBrowseNewFolderFailed: (msg: string) => string

  // Questions extras (feishu-questions.ts)
  questionSelectedSuffix: string
  questionCustomAnswerLabel: string
  questionSkippedLabel: string
  questionSelectedLabel: string
  questionDefaultTitle: string
  questionCustomHint: (hasOptions: boolean) => string
  questionCustomPlaceholder: string
  questionSubmitCustom: string
  questionSkipButton: string
  /** Hint above a multi-select question's checkboxes. */
  questionMultiHint: string
  /** Submit button of a multi-select question (one submission for all checks). */
  questionSubmitButton: string
  /** Hint above a single-select question's clickable option rows. */
  questionTapHint: string
  /** Confirmation card shown after a clickable single-select row is tapped. */
  /** Receipt card posted straight after an answer (`✅ 已提交`). */
  questionReceiptTitle: string
  /** `已选：**Yes**` — the answer the receipt records. */
  questionReceiptAnswer: (answer: string) => string
  /** One line telling the user this answer can still be redone. */
  questionReceiptNote: string
  /** The receipt's undo button. */
  questionReceiptBack: string
  /** Grey notice replacing a receipt whose answer was undone. */
  questionReceiptUndone: string
  /** Final batch card: title, one row per question, and its two buttons. */
  questionBatchTitle: string
  questionBatchRow: (question: string, answer: string) => string
  questionBatchUnanswered: string
  questionBatchNote: string
  questionBatchConfirm: string
  questionBatchBack: string
  /**
   * What the commit card becomes once 确认提交 landed: green header, the same
   * answer rows, no buttons. Without it the card keeps offering 确认 / 返回 and
   * the operator cannot tell the tap was accepted.
   */
  questionBatchSubmittedTitle: string
  /** The line that replaces the commit card's buttons after the commit. */
  questionBatchSubmittedNote: string
  /** Stand-in card left behind when a spent question card is re-sent fresh. */
  questionCardRetiredTitle: string
  questionCardRetired: string
  /** The question card while it waits on the confirmation card. */
  /** Stand-in card left behind when the result was posted as a new card. */
  // Background-task panel (feishu-jobs.ts)
  jobPanelTitle: string
  jobPanelSummary: (running: number, total: number) => string
  jobPanelColStatus: string
  jobPanelColTask: string
  jobPanelColId: string
  jobPanelColDuration: string
  jobPanelColProgress: string
  jobPanelClearButton: string
  jobPanelCleared: (count: number) => string
  /** Heading above the full-command blocks printed below the table. */
  jobPanelFullCommands: string
  /** Note under a command block that had to be shortened to fit one card. */
  jobPanelCommandTruncated: (total: number) => string
  jobUntitled: string
  jobStatusRunning: string
  jobStatusStopping: string
  jobStatusCompleted: string
  jobStatusFailed: string
  jobStatusKilled: string

  // Subagent panel (feishu-subagents.ts)
  subagentPanelTitle: string
  subagentPanelSummary: (running: number, total: number) => string
  subagentPanelColStatus: string
  subagentPanelColAgent: string
  subagentPanelColModel: string
  subagentPanelColSession: string
  subagentPanelColMode: string
  subagentPanelColDuration: string
  subagentUntitled: string
  subagentStatusRunning: string
  subagentStatusCompleted: string
  subagentStatusFailed: string
  subagentStatusAborted: string
  subagentStatusRefused: string
  subagentStatusMaxTokens: string
  subagentStatusInactive: string
  subagentModeOneShot: string
  subagentModeContinuable: string
  subagentModeUnknown: string
  /**
   * A child known only from the Host catalog: nobody in this process ever saw
   * it settle, so "not running" is the fact and "ended" would invent one.
   */
  subagentStatusNotRunning: string
  /** Why the Host could not describe a catalog row (`corrupt` / `unsupported` / `unavailable`). */
  subagentDiagnostic: (reason: string) => string
  /** `/subagents`: the command's own description, as `/help` lists it. */
  subagentsCommandDescription: string
  subagentCommandUsage: string
  subagentCommandEmpty: string
  /** The snapshot matches the one this chat was last shown — no second card. */
  subagentCommandUnchanged: string
  subagentCommandFailed: string
  /** Source line under the header of a manually opened panel. */
  subagentPanelSource: string

  /** Shared by both panels: how many older roster entries a card left out. */
  panelMoreRows: (count: number) => string
}

/** The zh dictionary: terminology aligned with the DSH native UI. */
export const zh = {
  cardSupersededTitle: '⬆️ 此卡片已失效',
  cardSupersededBody: '此卡片已被后续操作替换，请使用下方**最新的卡片**继续。',
  cardStaleNote: '⬆️ 此卡片已失效，请使用下方**最新的卡片**继续。',
  cardSettledNote: value => `✅ 已选择：${value} —— 这张卡片已锁定，不能再修改。`,
  cardAnsweredElsewhereTitle: '✅ 已在网页端处理',
  cardAnsweredElsewhereBody: '这个请求已在 **DSH Web UI** 中处理，此卡片作废。',
  approvalCardTitle: '🔐 等待审批',
  approvalToolLabel: '**工具：**',
  approvalReasonLabel: '**原因：**',
  approvalLocationHint: (shortCode, inThread) => `_id \`${shortCode}\` · 待处理（${inThread ? '本话题' : '本聊天'}）_`,
  approvalApproveOnce: '允许一次',
  approvalReject: '拒绝',
  approvalApprovedTitle: '✅ 已允许',
  approvalRejectedTitle: '❌ 已拒绝',
  approvalDecidedLine: approved => approved ? '✅ 已允许一次' : '❌ 已拒绝',
  approvalExpiredTitle: '⏹️ 审批已失效',
  approvalExpiredBody: '这次审批请求已随本轮结束，此卡片作废。',
  sessionPanelTitle: '📋 会话管理',
  sessionPanelIntro: '选择会话并执行操作。',
  sessionListHeader: '可用会话：',
  sessionListEmpty: '当前还没有持久化的会话。',
  sessionEntry: (index: number, title: string, id: string, lastActive: string, ownerLabel: string | undefined) =>
    `${index}. ${title} — ${lastActive}${ownerLabel === undefined ? '' : ` — 🔒 ${ownerLabel} 正在使用`} (\`${id}\`)`,
  sessionSwitch: '🔀 切换',
  sessionDetach: '🔓 Detach',
  sessionArchive: '🗄️ 归档',
  sessionFork: '🍴 分叉',
  sessionRename: '✏️ 改名',
  sessionPin: '📌 置顶',
  sessionUnpin: '📍 取消置顶',
  forkCardTitle: '🍴 分叉会话',
  forkCardHint: '点选一个分叉点：新会话会复制到**这一轮结束**为止的历史，当前会话不受影响。只列出已完成的轮次。',
  forkRowTitle: turn => `**第 ${turn} 轮**`,
  forkRowNoPreview: '（这一轮没有可见文字）',
  forkEmptyTurns: '当前会话还没有已完成的轮次，暂时没法分叉。',
  forkUnsupported: '这个 DSH 部署没有提供分叉能力（sessionController.fork 缺失）。',
  forkNoSession: '这个聊天还没有绑定会话，先发一条普通消息再试。',
  forkMoreTurns: count => `…更早的 ${count} 轮没有列出。`,
  forkUnknownTurn: turn => `第 ${turn} 轮不存在，或还没有完成。`,
  forkUsage: '用法：`/fork` 打开轮次选择卡片；`/fork <轮次>` 直接以该轮结束为界分叉。',
  forkSuccess: (turn, sessionId) => `🍴 已分叉：新会话包含到第 ${turn} 轮为止的历史。\n新会话 ID：\`${sessionId}\``,
  forkFailed: reason => `⚠️ 分叉失败：${reason}`,
  sessionConfirmTitle: action => `确认${action}？`,
  sessionConfirmBody: (action, name) => `确定要${action}「${name}」吗？`,
  sessionConfirmOk: '确认',
  sessionConfirmCancel: '取消',
  sessionConfirmOkStopArchive: '停止并归档',
  sessionActivityKind: kind => ({ turn: '正在运行的一轮', subagent: '子代理', job: '后台任务', schedule: '定时任务' })[kind] ?? kind,
  sessionRenameTitle: '✏️ 重命名会话',
  sessionRenamePlaceholder: '输入新的会话标题…',
  sessionRenameConfirm: '确认',
  sessionRenameCancel: '取消',
  sessionResultSwitched: target => `已切换到会话「${target}」。`,
  sessionResultDetached: label => `🔓 已释放会话。${label} 已重置为全新会话。`,
  sessionResultArchived: () => '会话已归档。可在工作区 WebUI 中取消归档。',
  sessionResultForked: id => `已分叉出新会话 \`${id}\`。`,
  sessionResultRenamed: title => `会话已重命名为「${title}」。`,
  sessionResultPinned: label => `已置顶会话「${label}」。`,
  sessionResultUnpinned: label => `已取消置顶「${label}」。`,
  sessionResultPinArchived: label => `「${label}」已归档，无法置顶——请先取消归档。`,
  sessionResultPinFailed: label => `「${label}」置顶失败，请看日志。`,
  sessionErrorOccupied: '该会话正被占用，请先 detach 再切换。',
  sessionErrorArchived: '该会话已归档，请先在 WebUI 取消归档。',
  sessionErrorInvalid: '无效的会话。',
  sessionActionLabel: action => `操作「${action}」`,

  modelSelectTitle: newSession => newSession ? '🤖 模型选择（新建会话）' : '🤖 模型选择',
  modelSelectCurrent: (provider, model, effort) =>
    `**当前模型**　\`${provider}/${model}\`\n🧭 思考强度：\`${effort}\``,
  modelSelectProviderHeader: '**选择 Provider**',
  modelSelectProviderPlaceholder: '选择 Provider…',
  modelSelectModelHeader: '**选择模型**',
  modelSelectModelEmpty: '该 Provider 下暂无可用模型。',
  modelSelectModelPlaceholder: empty => empty ? '该 Provider 下暂无可用模型…' : '选择模型…',
  modelSelectEffortHeader: '**思考强度**',
  modelSelectEffortPlaceholder: '选择思考强度…',
  modelSelectConfirm: newSession => newSession ? '✅ 确认并创建会话' : '✅ 确认切换',
  modelSelectNewSessionTitle: '🤖 模型选择（新建会话）',

  permissionTitle: 'Permission',
  permissionCurrent: mode => `**当前权限模式：** \`${mode}\``,
  permissionHint: '_点击下方按钮切换本会话的权限（沙箱）模式。切换写入会话日志，下一次受限调用即生效。_',
  permissionReadOnly: '仅可查看',
  permissionWorkspaceWrite: '工作区内修改',
  permissionFullAccess: '完全权限',

  busyTitle: '⏳ 忙碌行为',
  busyIntro: 'Agent 运行时收到的新消息如何进入？',
  busyQueueLabel: '📥 Queue',
  busySteerLabel: '🎯 Steer',
  busyCurrentOption: mode => `当前：${mode === 'steer' ? 'Steer' : 'Queue'}`,

  questionSkip: '跳过',
  questionChoicePrefix: '选项',

  onboardingTitle: '🤖 新建会话',
  onboardingSubtitle: '选择一个工作区与 Agent 预设开始。',
  onboardingSelectPreset: '选择 Agent 预设',
  onboardingPresetLabel: id => id,
  onboardingNewSessionLabel: '开始会话',
  onboardingStart: '🚀 开始会话',

  // The trailing arrow is the point of the whole hint: a collapsed panel must
  // look collapsed, and no client draws anything for us that a reader notices.
  cardFoldTitle: title => `${title}（▸ 已折叠 · 点击展开）`,

  stepReasoningHeader: '💬 **推理**',
  stepMessageHeader: '📝 **消息**',
  stepToolHeader: '🔧 **工具调用**',
  stepToolSuccess: '成功',
  stepToolError: '失败',
  stepToolRunning: '运行中…',
  stepToolArgsHeader: '**⚙️ 参数**',
  stepToolResultHeader: '**📤 结果**',
  stepCardTitleError: '工具出错',
  stepCardTitleDone: '工具完成',
  stepCardTitleCall: '工具调用',
  stepCardTitleReply: '回复',
  stepPlaceholderTitle: '⏳ 正在分析请求',
  stepAutoTriggerNote: trigger => `⚡ 本回合由**${trigger}**自动触发`,
  autoTurnTriggerName: kind => {
    switch (kind) {
      case 'job': return '后台任务状态更新'
      case 'schedule': return '自动化任务'
      case 'subagent': return '子任务状态更新'
      case 'agent': return '收到任务消息'
      case 'team': return '收到团队消息'
      case 'goal': return '继续执行目标'
      case 'github': return '收到 GitHub 事件'
      case 'webhook': return '收到外部事件'
      case 'plugin': return '插件状态更新'
      case 'request': return '收到执行请求'
      // An unseen producer is named, never quoted (关键坑 50).
      default: return kind
    }
  },
  surfaceLabelWebGui: 'Web GUI',
  surfaceLabelOther: '其它入口',
  stepPlaceholderBody: '请求还没发出，模型尚未收到这一轮的内容',
  stepAwaitingTitle: '📡 已发出请求，等待输出…',
  stepAwaitingBody: '模型还没返回首个 token，输出会就地更新在这张卡上',
  stepThinkingTitle: '🧠 思考中…',
  stepThinkingBody: '模型正在推理，输出会就地更新在这张卡上',
  stepToolTitle: '🔧 工具调用中…',
  stepToolBody: '模型正在生成工具调用，执行结果会就地更新在这张卡上',
  stepReplyingTitle: '✍️ 回复中',
  stepReplyingBody: '模型正在写回复，完成后会就地显示在这张卡上',
  stepRouteLine: (provider, model) => `📡 ${provider} / ${model}`,
  stepEmptyTitle: '本步无输出',
  stepEmptyBody: '（本步没有可显示的内容）',
  stepPosition: (turn, step) => `第 ${turn} 轮 · 第 ${step} 步`,
  stepCardStaleNotice: (turn, step, reason) =>
    `⚠️ ${turn > 0 && step > 0 ? `第 ${turn} 轮第 ${step} 步的卡片` : '这张卡片'}没能更新，已停在旧内容。\n原因：${reason}`,
  stepToolCount: (calls, failed) =>
    `🔧 ${calls} 个工具调用${failed > 0 ? ` · ${failed} 个失败` : ''}`,

  // 回合过程卡（feishu-progress.ts）：简洁档把整轮的工具活动合并到一张卡上。
  turnCardTitleRunning: elapsed => `🐳 深度求索中 · ${elapsed}`,
  turnCardTitleDone: (calls, failed, elapsed) =>
    `⚙️ 本回合 · ${calls} 个工具${failed > 0 ? ` · ${failed} 个失败` : ''} · ${elapsed}`,
  turnCardTitleFailed: (calls, elapsed) => `⚙️ 本回合失败 · ${calls} 个工具 · ${elapsed}`,
  turnCardStep: (step, elapsed, light) => `▸ **第 ${step} 步**${light === undefined ? '' : ` · ${light}`} · ${elapsed}`,
  turnCardStepFailed: '❌ 失败',
  turnCardCallUnrun: name => `⚠️ \`${name}\` · 未执行`,
  turnCardStepNote: note => `💬 ${note}`,
  turnCardToolRunning: (label, elapsed) => `⏳ ${label} · ${elapsed}…`,
  turnCardRunningLabel: '执行中',
  turnCardToolDone: (label, elapsed) => `✅ ${label} · ${elapsed}`,
  turnCardToolFailed: (label, elapsed) => `❌ ${label} · ${elapsed}`,
  turnCardOlderRows: rows => `**更早的 ${rows} 行**`,
  turnCardPhaseAwaiting: '📡 等待输出',
  turnCardPhaseThinking: '🧠 思考中',
  turnCardPhaseReplying: '✍️ 回复中',
  turnCardPhaseTool: '🔧 工具调用中',

  // 上下文注入提示行（injection-notice.ts）：只报来源，不显示注入内容。
  injectionContext: '📥 注入上下文',
  injectionRecall: '🔗 跨会话召回',
  injectionRelay: '✉️ 会话间消息',
  injectionSubagent: '🤖 子代理已结算',
  injectionGoal: '🎯 目标更新',
  injectionSkillLoaded: '📥 已载入技能',
  injectionSkillCatalog: entries => `技能目录（${entries} 条）`,
  injectionPlugin: name => `插件 ${name}`,
  injectionRuntimeSnapshot: '运行时快照',
  injectionApproval: '审批结果',
  injectionActionLoaded: '已载入',
  injectionActionAdded: '已新增',
  injectionActionUpdated: '已更新',
  injectionActionRemoved: '已移除',
  injectionFromSession: sessionId => `来自会话 ${sessionId}`,
  injectionRound: round => `第 ${round} 轮`,

  // 压缩卡（feishu-compaction.ts）
  compactionCardTitleStart: '🗜️ 正在压缩上下文…',
  compactionCardTitleDone: '🗜️ 上下文已压缩',
  compactionCardTitleDoneManual: '🗜️ 上下文已压缩（/compact）',
  compactionCardTitleFailed: '⚠️ 上下文压缩失败',
  compactionStartBody: trigger => `触发方式：${trigger}`,
  compactionTriggerAuto: '自动（上下文压力）',
  compactionTriggerManual: '/compact',
  compactionFoldedItems: items => `已折叠 ${items} 条历史记录`,
  compactionFoldedTokens: tokens => `约 ${tokens} tokens`,
  compactionSummaryLabel: '摘要',
  compactionSummaryUnavailable: '（这次压缩没有摘要内容）',
  compactionSummaryCut: (shown, total) => `⚠️ 单张卡片装不下整份摘要：上面是前约 ${shown} 字，全文 ${total} 字`,
  compactionFailedReason: reason => `原因：${reason}`,
  compactionNoSummary: '本次没有产生摘要，会话历史没有被替换。',
  turnCompleteTitle: '✅ Turn 已完成',
  turnSummaryTitle: '✅ 完成',
  turnContinuedPart: (part, total) => `续 ${part}/${total}`,
  turnContinuedTitle: '📄 续',
  turnCompleteDetail: (duration, llm, tools) => `总时长 ${duration} · LLM ${llm} · 工具 ${tools}`,
  turnCompleteSteps: (steps, tokens, speed) => `${steps} 步 · ${tokens} · ${speed}`,
  turnCompleteExternalTurn: source => `💬 本回合的来源是**${source}**（不是飞书这边发的消息），过程与交付一并同步到这里`,
  externalMessageFromWebGui: '💬 Web GUI：',
  externalMessageFromOther: '💬 其它入口：',
  externalMessageAttachments: (images, files) => {
    const parts: string[] = []
    if (images > 0) parts.push(`${images} 张图片`)
    if (files > 0) parts.push(`${files} 个文件`)
    return `（附件：${parts.join('、')}，未镜像到飞书）`
  },
  enterWhileBusy: '忙碌时进入',
  busySteeredNotice: '🎯 已插入当前运行轮，模型会在下一步看到这条消息。',
  busyQueuedNotice: '📥 已排队，当前轮结束后会自动执行这条消息（排队期间可用 /stop 丢弃）。',
  turnFailedTitle: '本轮运行失败',
  failureAuth: 'API 密钥无效',

  statusRunWarning: '> ⚠️ Agent 正在运行中，以上信息可能并非最新。请在 Agent 运行结束后再次发送 `/status` 获取准确信息。',
  statusSessionLabel: '会话',
  statusTitleLabel: '标题',
  statusWorkspaceLabel: '工作区',
  statusPresetLabel: '预设',
  statusModelLabel: '模型',
  statusReasoningLabel: '推理',
  statusPermissionLabel: '权限',
  statusBusyLabel: '忙碌时进入',
  statusAgentRunning: '🔄 运行中',
  statusAgentIdle: '⏸️ 空闲',
  statusAgentLabel: 'Agent',

  cancel: '取消',
  confirm: '确认',
  back: '返回',
  next: '继续',

  // ---- Extra keys for the bilingual card renderers ----
  busyCurrentLabel: '运行中（busy）的 Enter 行为',
  busyHint: '_点击下方按钮切换本聊天在 agent 运行中收到消息时的处理方式（对齐 WebUI「Enter behavior while busy」）。已持久化，重启后保留。_',
  busyQueueWord: 'Queue',
  busySteerWord: 'Steer',
  busyQueueDesc: '当前轮结束后作为新轮运行（默认）',
  busySteerDesc: '注入当前运行轮立即响应',

  // Turn Complete 交付文件清单（channel.ts / feishu-deliver.ts；来自 DSH `present`
  // 工具的 `deliverables/presented` 事件）。媒体在卡内内联；白名单文档按大小自动
  // 发原生文件消息；其余文件点行 → 确认卡 → 才发送。
  deliverablesTitle: (count: number) => `📦 **交付文件**（${count}）`,
  deliverablesCardTitle: '📦 交付物',
  deliverablesMore: (count: number) => `_…另有 ${count} 个未显示（可以让模型用 \`feishu_send_file\` 单独发）_`,
  turnProducedLine: (count: number) => `📦 本回合新生成 ${count} 个文件`,
  deliverTapHint: '_标着「点击发送」的文件点一下即可发送，发送前还会再确认一次。_',
  deliverTapToSend: '点击发送',
  deliverAutoSent: '自动投递',
  deliverPreview: '预览',
  deliverBlockedReason: reason => ({
    'too-large': '超过飞书 30MB 上限，无法发送',
    unreadable: '文件不存在、为空或无法读取',
    outside: '不在本会话工作区内，无法发送',
  })[reason],
  deliverCardTitle: '📤 文件投递',
  deliverConfirmBody: (name, size) => `确认把 **${name}**（${size}）发送到本聊天？`,
  deliverSendButton: '📤 发送',
  deliverCancelButton: '取消',
  deliverSent: name => `✅ 已发送 **${name}**。`,
  deliverCancelled: name => `已取消发送 **${name}**。`,
  deliverFailed: (name, reason) => `❌ 发送 **${name}** 失败：${reason}`,
  deliverAutoFailed: (name, reason) => `⚠️ 自动发送 **${name}** 失败：${reason}（需要的话说一声我重发）`,
  deliverExpired: '⌛ 这张文件卡已失效（超过 30 分钟，或来自上一次运行）。可以让模型重新列一遍交付文件。',
  deliverFileGone: '文件已不存在或无法读取',
  deliverOutside: '不在本会话工作区内',
  deliverTooLarge: '超过飞书 30MB 上限',

  // 卡片显示开关卡片（feishu-display.ts）
  displayCardTitle: '📇 卡片显示',
  displayCardHint: '_点击按钮切换，立即持久化，与 WebUI 设置面板同源。_',
  displayCardLabel: (key: 'reasoning' | 'tools' | 'args' | 'results') =>
    ({ reasoning: '思考过程', tools: '工具调用', args: '参数', results: '结果' })[key],
  displayCardButton: (label: string, enabled: boolean) => `${enabled ? '✅' : '⬜'} ${label}：${enabled ? '开' : '关'}`,
  displayCardHiddenByTools: '_「参数」「结果」随「工具调用」一起隐藏；重新开启工具调用后会回来。_',
  displayCardNote: '也支持 `/display <开关> on|off` 和 `/display tick 3|5|10|30`。',
  displayCardTickTitle: '**耗时刷新**',
  displayCardTickHint: '简洁过程卡与其他档位的等待卡共用；只影响计时刷新，不延迟新事件。',
  displayCardTickButton: (seconds, active) => `${active ? '🔘' : '⚪'} ${seconds} 秒`,
  pendingAttachmentsNotice: (images, files) => `📥 已暂存 ${[images > 0 ? `${images} 张图片` : '', files > 0 ? `${files} 个文件` : ''].filter(Boolean).join('、')}，等待你的文字说明；发送文字后会一起交给 Agent。`,
  pendingAttachmentsDiscarded: '已清除上一会话暂存的附件。',
  displayCardLevelTitle: '**工作步骤展示**（对齐 WebUI 的四档）',
  displayLevelName: level => ({ compact: '简洁', standard: '标准', detailed: '详细', verbose: '完全展开' })[level],
  displayCardLevelButton: (name, active) => `${active ? '🔘' : '⚪'} ${name}`,
  displayLevelHint: level => ({
    compact: '只报工具调用计数与状态，不显示推理内容',
    standard: '每个工具一行摘要，推理只给首行；无参数、无结果',
    detailed: '推理可展开，工具带参数与结果（默认）',
    verbose: '推理给出全文，参数与结果不截断',
  })[level],
  displayLevelCustom: '当前四个开关的组合不等于任何一档',
  displayLevelSet: name => `✅ 已切换到「${name}」。`,

  permissionNoSession: '当前 chat 还没有会话，请先发一条消息再执行 /permission',
  permissionSwitchFailed: reason => `⚠️ **切换未生效**：${reason}`,
  permissionSwitchBusyShellHint: '_原因：该会话的常驻终端仍在运行，DSH 不允许此刻切换沙箱模式（会影响正在执行的命令）。请新建一个会话，或换用不含常驻终端的预设后再切换。_',

  modelSelectProviderLabel: label => `**Provider**　\`${label}\``,
  modelSelectBack: '← 返回选择 Provider',
  modelSelectSwitchedHeader: '✅ **已切换**',
  modelSelectSwitchedNext: '下一轮对话将使用新模型。',
  modelSelectLastUsedButton: '↺ 切回上次使用',
  modelSelectLastUsed: (provider, model) => `↺ 上次使用：\`${provider}/${model}\`（点下方按钮切回，**只改本会话**）`,
  modelSelectLastUsedSwitched: '已切回本会话上次使用的模型（**只改本会话**，没有改全局默认）。',
  modelSelectLastUsedFailed: reason => `⚠️ 切回上次模型失败：${reason}`,
  modelSelectRecentHeader: '🕘 **最近使用（全局）** — 点一行直接切换（只改本会话）',
  modelSelectRecentCurrent: (provider, model) => `✅ 当前：\`${provider}/${model}\``,
  modelSelectRecentHeaderNewSession: '🕘 **最近使用（全局）** — 点一行直接选中，作为新会话的模型',
  modelSelectLastUsedButtonNewSession: '↺ 用上次的模型',
  modelSelectLastUsedNewSession: (provider, model) => `↺ 上次使用：\`${provider}/${model}\`（点下方按钮，作为新会话的模型）`,
  modelSelectNewSessionDefault: (provider, model, effort) =>
    `⭐ **默认模型**　\`${provider}/${model}\`\n🧭 思考强度：\`${effort}\`\n点这一行就直接用它（新会话将继承这个默认模型）`,
  newSessionRouteUnavailable: '⚠️ 这个模型已经不在可选列表里了，请用下方列表重新选择。',
  reasoningCardTitle: '🧠 推理强度',
  reasoningCardHint: '点一行直接切换（只改本会话，不动全局默认）',
  reasoningCardCurrent: effort => `✅ 当前：**${effort}**`,
  reasoningCardDefault: 'provider 默认',
  reasoningCardSwitched: effort => `🧠 本会话推理强度已切到 **${effort}**（只改本会话，没有改全局默认）。`,
  reasoningCardOnlySession: '只改本会话',
  reasoningCardEmpty: '这个模型的 provider 没有声明可调推理档位。',
  reasoningCardNoAgent: '这个会话当前没有加载（重启后还没收过消息）。先发一条普通消息让它恢复。',
  reasoningCardUnsupported: '这个宿主的 agent 不支持会话内切换。',
  modelSelectRecentSwitched: '本会话已切到该模型（**只改本会话**，没有改全局默认）。',
  modelSelectLastUsedFailedNoSession: '这个会话当前没有加载（重启后还没收过消息）。先发一条普通消息让它恢复。',
  modelSelectLastUsedFailedUnsupported: '这个宿主的 agent 不支持会话内切换模型。',
  modelSelectEffortLine: effort => `🧠 思考强度：\`${effort}\``,
  modelSelectFailHeader: '⚠️ **切换失败**',
  modelEffortDefault: 'default（不指定）',
  modelEffortOff: 'off（关闭思考）',
  modelEffortLow: 'low（轻度思考）',
  modelEffortHigh: 'high（深度思考）',
  modelEffortMax: 'max（最大思考）',

  sessionPanelSelectLabel: '**选择会话**',
  sessionPanelSelectPlaceholder: empty => empty ? '暂无会话' : '选择会话…',
  sessionPanelActionLabel: '**执行操作**',
  sessionPanelCount: (total, locked) => `共 ${total} 个会话${locked > 0 ? ` · ${locked} 个被占用` : ''}`,
  sessionPanelHint: '_选择会话后点下方按钮执行对应操作。_',
  sessionListButton: '📋 列表',
  sessionRefreshButton: '🔄 刷新',
  sessionOpSwitch: '切换',
  sessionOpDetach: '释放',
  sessionOpArchive: '归档',
  sessionOpFork: '分叉',
  sessionOpRename: '改名',
  sessionOpPin: '置顶',
  sessionOpUnpin: '取消置顶',
  sessionConfirmDetailSwitch: label => `将把这个对话切换到会话 \`${label}\`，若它被其它对话占用会先接管。`,
  sessionConfirmDetailDetach: label => `将释放会话 \`${label}\` 的占用（原持有者重置为新会话）。`,
  sessionConfirmDetailArchive: label => `将归档会话 \`${label}\`。`,
  sessionConfirmDetailArchiveActive: (label, activity) => `会话 \`${label}\` **仍在运行**（${activity}）。\n\n继续归档会**先停止**它当前的活动，然后归档该会话。`,
  sessionConfirmDetailFork: label => `将从会话 \`${label}\` 分叉出一个新会话（保留到当前事件的对话）。`,
  sessionConfirmDetailRename: label => `将把会话 \`${label}\` 改成新的标题。`,
  sessionResultEmptyTitle: '⚠️ 标题为空',
  sessionResultEmptyBody: '请输入新的会话标题后再确认。',
  sessionResultUnavailable: '⚠️ 暂不可用',
  sessionResultUnavailableRename: '本部署未启用「改名」能力。',
  sessionResultRenamedHeader: '✅ 已改名',
  sessionResultRenamedBody: label => `会话 \`${label}\` 已改名为：`,
  sessionResultRenameFailed: '❌ 改名失败',
  sessionResultCancelled: '已取消',
  sessionResultCancelledBody: '本次操作已取消。',
  sessionResultArchivedHeader: '⚠️ 已归档',
  sessionResultArchivedSwitchBody: label => `会话 \`${label}\` 已归档，无法切换。`,
  sessionResultSwitchedHeader: '✅ 已切换',
  sessionResultSwitchedBody: label => `这个对话已切换到会话 \`${label}\`。下一轮对话将使用它。`,
  sessionResultDetachHeader: '🔓 已 detach',
  sessionResultDetachFree: label => `会话 \`${label}\` 本就空闲。`,
  sessionResultDetachReleased: (label, owner) => `已释放会话 \`${label}\`（原持有者：${owner}）。`,
  sessionResultArchivedOk: '🗄️ 已归档',
  sessionResultArchivedBody: label => `会话 \`${label}\` 已归档。`,
  sessionResultForkHeader: '🍴 已分叉',
  sessionResultForkBody: (label, id) => `已从 \`${label}\` 分叉出新会话${id !== undefined ? ` \`${id}\`` : ''}。可用「/new」或在本面板中切换。`,
  sessionResultOpFailed: '❌ 操作失败',
  sessionResultUnsupported: name => `本部署未启用「${name}」能力。`,
  sessionRenamePrompt: label => `为会话 \`${label}\` 输入新标题：`,
  sessionRenameButton: '✅ 确认改名',
  sessionListTitle: '📋 会话列表',
  sessionListTableHeader: '| 会话 | ID | 预设 | 占用 | 最近活跃 |',
  sessionListNone: '暂无会话。',
  sessionTimeJustNow: '刚刚',
  sessionTimeMinute: 'm 前',
  sessionTimeHour: 'h 前',
  sessionTimeDay: 'd 前',

  onboardingAttachTitle: '🚀 选择会话',
  onboardingSessionFallback: (index, id) => `会话 ${index + 1} (${id})`,
  onboardingInUse: owner => ` 🔒 ${owner} 正在使用`,
  onboardingNoSessions: '当前没有任何历史会话，请点击下方按钮新建一个会话。',
  onboardingPickExisting: '**📚 选择已有会话**',
  onboardingSelectPlaceholder: '选择会话...',
  onboardingAttachButton: '📎 绑定到该会话',
  onboardingNewButton: '✨ 新建会话',
  onboardingIntro: threadLabel => `**👋 开始使用**\n\n${threadLabel} 还没有绑定任何会话。从下方选择一个已有会话继续，或新建一个会话。`,
  onboardingWorkspaceHeader: '**📁 选择工作区**\n\n新建会话将在这个工作区中运行。',
  onboardingNoWorkspaces: '还没有工作区，请在下方输入路径新建一个。',
  onboardingNewWorkspaceHeader: '**🆕 新建工作区**\n\n输入绝对路径，或 `~` 开头的家目录相对路径。',
  onboardingWorkspacePlaceholder: '如 ~/projects/my-app 或 /绝对/路径',
  onboardingCreateWorkspaceButton: '✅ 确认新建工作区',
  onboardingNewTitle: '🆕 新建会话',
  onboardingPresetHeader: '**🧩 选择 Agent 预设**\n\n模板决定这个会话拥有哪些能力。',
  onboardingNoPresets: '没有可用模板，将使用默认模板。',
  onboardingCreatedTitle: '✅ 会话已创建',
  onboardingCreatedBody: (sessionId, summary) => `**Session** \`${sessionId}\`\n\n${summary}\n\n现在可以发送消息开始对话了。`,
  newSessionConfirmTitle: '🧩 新建会话 · 请确认',
  newSessionConfirmHint: '确认后立即按以下设置创建会话。',
  newSessionConfirmCreate: '✅ 创建会话',
  newSessionConfirmCancel: '✖️ 取消',
  newSessionCancelledTitle: '✖️ 已取消新建会话',
  newSessionCancelledBody: '没有创建会话，可以重新发起 `/new`。',
  newSessionConfirmWorkspace: path => `📁 **工作区**：\`${path}\``,
  newSessionConfirmWillCreate: path => `🆕 **将新建目录**：\`${path}\`（含缺失的上级目录）`,
  newSessionConfirmPreset: preset => `🧩 **Agent 预设**：\`${preset}\``,
  newSessionConfirmModel: route => `🤖 **模型**：\`${route}\``,
  newSessionConfirmEffort: effort => `🧠 **推理等级**：\`${effort}\``,
  newSessionConfirmDefaults: '_未指定工作区/预设，将使用默认值。_',
  newSessionSettledWorkspaceTitle: '✅ 工作区已选定',
  newSessionSettledWorkspace: path => `📁 \`${path}\``,
  newSessionSettledWillCreate: '🧱 这个目录还不存在，点「创建会话」时会一并创建。',
  newSessionSettledPresetTitle: '✅ Agent 模式已选定',
  newSessionSettledPreset: preset => `🧩 **${preset}**`,
  newSessionSettledModelTitle: '✅ 模型已选定',
  newSessionSettledModel: (provider, model) => `🔹 \`${provider}/${model}\``,
  newSessionSettledHint: '这张卡片已锁定 · 继续请用下方最新的卡片。',
  onboardingAttachedTitle: '📎 会话已绑定',
  onboardingTakeover: owner => `\n\n🔓 已从 ${owner} 接管该会话（原占用者已被重置为新会话）。`,
  onboardingAttachedBody: (sessionId, takeover) => `已绑定到会话 \`${sessionId}\`。${takeover}\n\n现在可以发送消息继续对话了。`,
  onboardingAttachArchivedTitle: '📎 绑定会话',
  onboardingAttachArchivedBody: '⚠️ 该会话已被归档，无法绑定。',
  onboardingCreateWorkspaceFailTitle: '📁 新建工作区',
  onboardingCreateWorkspaceFailBody: (path, msg) => `⚠️ **创建工作区失败**\n\n\`${path}\`\n\n${msg}`,
  onboardingCancelTitle: '🚀 新建会话',
  onboardingCancelledBody: '已取消新建会话。',
  onboardingCreateWorkspaceConfirmTitle: '📁 这个目录还不存在',
  onboardingCreateWorkspaceConfirmBody: path => `⚠️ **这个目录还不存在**\n\n\`${path}\`\n\n创建会话时会**新建它**（含缺失的上级目录）。确认之前不会在磁盘上留下任何东西。`,
  onboardingCreateWorkspaceConfirmButton: '✅ 就建这个目录',
  onboardingCreateWorkspaceBackButton: '← 返回重输',
  onboardingCreateWorkspaceSiblingHeader: parent => `**旁边有什么**（点一行改用它，\`${parent}\` 下）`,
  onboardingCreateWorkspaceNotAbsolute: path => `⚠️ **需要一个绝对路径**\n\n\`${path || '（空）'}\`\n\n请以 \`/\` 开头，或用 \`~\` 表示家目录。`,
  onboardingCreateWorkspaceNotADirectory: '这个路径已经存在，但它不是一个目录（是个文件）。',
  onboardingBrowseNewFolder: '📁＋ 新建文件夹',
  onboardingBrowseNewFolderPlaceholder: '新文件夹名（单段，不含 /）',
  onboardingBrowseNewFolderExists: name => `⚠️ 已经有一个叫“${name}”的文件夹了。`,
  onboardingBrowseNewFolderInvalid: name => `⚠️ “${name}”不是合法的文件夹名（只能一段，且不含 / 或 \\）。`,
  onboardingBrowseNewFolderFailed: msg => `⚠️ 新建文件夹失败：${msg}`,
  onboardingBrowseButton: '📂 浏览目录…',
  onboardingBrowseTitle: '📂 选择工作区目录',
  onboardingBrowseHeader: path => `**📁 当前目录**\n\n\`${path}\``,
  onboardingBrowseUp: '⬆️ 上一级',
  onboardingBrowseHome: '🏠 家目录',
  onboardingBrowseShowHidden: '👁 显示隐藏目录',
  onboardingBrowseHideHidden: '🙈 隐藏隐藏目录',
  onboardingBrowsePrev: '← 上一页',
  onboardingBrowseNext: '下一页 →',
  onboardingBrowsePage: (page, total) => `第 ${page} / ${total} 页`,
  onboardingBrowseEmpty: '（这个目录下没有子目录）',
  onboardingBrowseTruncated: '…目录项过多，仅列出前一部分，请进入更具体的目录继续浏览。',
  onboardingBrowsePick: '✅ 用这个目录',
  onboardingBrowseBack: '← 返回工作区列表',

  questionSelectedSuffix: '已选择',
  questionCustomAnswerLabel: '自定义回答：',
  questionSkippedLabel: '已跳过',
  questionSelectedLabel: '已选择：',
  questionDefaultTitle: '问题',
  questionCustomHint: hasOptions => hasOptions ? '以上选项都不满意？在下方输入你的自定义回答：' : '请输入你的回答：',
  questionCustomPlaceholder: '在此输入...',
  questionSubmitCustom: '✏️ 提交自定义回答',
  questionSkipButton: '⏭️ 跳过本题',
  questionMultiHint: '可勾选多个，选好后按「提交」：',
  questionSubmitButton: '✅ 提交',
  questionTapHint: '点下面任意一项即可作答：',
  questionReceiptTitle: '✅ 已提交',
  questionReceiptAnswer: answer => `已选：${answer}`,
  questionReceiptNote: '这一题已经记下了，选错了就点下面的「返回」重答本题。',
  questionReceiptBack: '↩️ 返回重答',
  questionReceiptUndone: '这次作答已撤销，请在下方新发的问题卡上重答本题。',
  questionBatchTitle: '📝 确认全部回答',
  questionBatchRow: (question, answer) => `**${question}**\n${answer}`,
  questionBatchUnanswered: '（未作答）',
  questionBatchNote: '全部答完了。点「确认提交」把这组回答交给模型；想改最后一题就点「返回上一题」。',
  questionBatchConfirm: '✅ 确认提交',
  questionBatchBack: '↩️ 返回上一题',
  questionBatchSubmittedTitle: '✅ 已提交',
  questionBatchSubmittedNote: '这组回答已经交给模型，这张卡片不再接受修改。要改请在下面直接回复。',
  questionCardRetiredTitle: '已作废',
  questionCardRetired: '这张卡片已用过一次，飞书不再投递它上面的选项点击。**请使用下方新发的同一张问题卡继续作答。**',
  // Background-task panel (feishu-jobs.ts)
  jobPanelTitle: '🧩 后台任务',
  jobPanelSummary: (running, total) => `运行中 ${running} · 共 ${total} 个`,
  jobPanelColStatus: '状态',
  jobPanelColTask: '任务',
  jobPanelColId: '编号',
  jobPanelColDuration: '耗时',
  jobPanelColProgress: '进度 / 结果',
  jobPanelClearButton: '🧹 清理已完成',
  jobPanelCleared: count => `🧹 已清理 ${count} 个已完成的后台任务`,
  jobPanelFullCommands: '📜 完整命令',
  jobPanelCommandTruncated: total => `（完整命令共 ${total} 字符，单卡放不下，已截断）`,
  jobUntitled: '未命名任务',
  jobStatusRunning: '运行中',
  jobStatusStopping: '正在停止',
  jobStatusCompleted: '已完成',
  jobStatusFailed: '失败',
  jobStatusKilled: '已停止',

  // Subagent panel (feishu-subagents.ts)
  subagentPanelTitle: '🤖 子代理',
  subagentPanelSummary: (running, total) => `运行中 ${running} · 共 ${total} 个`,
  subagentPanelColStatus: '状态',
  subagentPanelColAgent: '子代理',
  subagentPanelColModel: '模型',
  subagentPanelColSession: '子会话',
  subagentPanelColMode: '模式',
  subagentPanelColDuration: '耗时',
  subagentUntitled: '未命名子代理',
  subagentStatusRunning: '运行中',
  subagentStatusCompleted: '已完成',
  subagentStatusFailed: '失败',
  subagentStatusAborted: '已中止',
  subagentStatusRefused: '已拒绝',
  subagentStatusMaxTokens: '超出 token 上限',
  subagentStatusInactive: '已结束',
  subagentModeOneShot: '一次性',
  subagentModeContinuable: '可续谈',
  subagentModeUnknown: '未知',
  subagentStatusNotRunning: '未运行',
  subagentDiagnostic: reason => ({ corrupt: '目录损坏', unsupported: '模式不支持', unavailable: '目录不可读' })[reason] ?? '目录异常',
  subagentsCommandDescription: '查看本会话的子代理面板（加 `tree` 看整棵子树）',
  subagentCommandUsage: '⚠️ 用法：`/subagents [tree]`',
  subagentCommandEmpty: '当前没有子代理',
  subagentCommandUnchanged: '面板没有变化',
  subagentCommandFailed: '子代理面板失败',
  subagentPanelSource: '来源：宿主目录 + 本进程事件',

  panelMoreRows: count => `另有 ${count} 条更早的记录未列出`,
} as const satisfies Translations

/** The en dictionary, keyed identically to the zh dictionary. */
export const en: Translations = {
  cardSupersededTitle: '⬆️ This card is stale',
  cardSupersededBody: 'This card was replaced by a later step. Use the **newest card** below instead.',
  cardStaleNote: '⬆️ This card is stale — use the **newest card** below.',
  cardSettledNote: value => `✅ Selected: ${value} — this card is locked and can no longer be changed.`,
  cardAnsweredElsewhereTitle: '✅ Handled in the Web UI',
  cardAnsweredElsewhereBody: 'This request was already handled in the **DSH Web UI**, so this card is void.',
  approvalCardTitle: '🔐 Waiting for approval',
  approvalToolLabel: '**Tool:**',
  approvalReasonLabel: '**Reason:**',
  approvalLocationHint: (shortCode, inThread) => `_id \`${shortCode}\` · pending in ${inThread ? 'this thread' : 'this chat'}_`,
  approvalApproveOnce: 'Allow once',
  approvalReject: 'Reject',
  approvalApprovedTitle: '✅ Allowed once',
  approvalRejectedTitle: '❌ Rejected',
  approvalDecidedLine: approved => approved ? '✅ Allowed once' : '❌ Rejected',
  approvalExpiredTitle: '⏹️ Approval expired',
  approvalExpiredBody: 'This approval request ended with the turn, so the card is void.',
  sessionPanelTitle: '📋 Session',
  sessionPanelIntro: 'Pick a session and run an action.',
  sessionListHeader: 'Available sessions:',
  sessionListEmpty: 'No persisted sessions yet.',
  sessionEntry: (index, title, id, lastActive, ownerLabel) =>
    `${index}. ${title} — ${lastActive}${ownerLabel === undefined ? '' : ` — 🔒 in use by ${ownerLabel}`} (\`${id}\`)`,
  sessionSwitch: '🔀 Switch',
  sessionDetach: '🔓 Detach',
  sessionArchive: '🗄️ Archive',
  sessionFork: '🍴 Fork',
  sessionRename: '✏️ Rename',
  sessionPin: '📌 Pin',
  sessionUnpin: '📍 Unpin',
  forkCardTitle: '🍴 Fork session',
  forkCardHint: 'Pick a fork point: the new session copies history up to the END of that turn; the current session is untouched. Only completed turns are listed.',
  forkRowTitle: turn => `**Turn ${turn}**`,
  forkRowNoPreview: '(no visible text in this turn)',
  forkEmptyTurns: 'This session has no completed turns yet, so there is nothing to fork.',
  forkUnsupported: 'This DSH deployment exposes no fork capability (sessionController.fork is missing).',
  forkNoSession: 'This chat has no bound session yet — send a normal message first.',
  forkMoreTurns: count => `…${count} older turn${count === 1 ? '' : 's'} not shown.`,
  forkUnknownTurn: turn => `Turn ${turn} does not exist or has not completed.`,
  forkUsage: 'Usage: `/fork` opens the turn picker; `/fork <turn>` forks at the end of that turn.',
  forkSuccess: (turn, sessionId) => `🍴 Forked: the new session contains history through turn ${turn}.\nNew session ID: \`${sessionId}\``,
  forkFailed: reason => `⚠️ Fork failed: ${reason}`,
  sessionConfirmTitle: action => `Confirm ${action}?`,
  sessionConfirmBody: (action, name) => `Are you sure you want to ${action} "${name}"?`,
  sessionConfirmOk: 'Confirm',
  sessionConfirmCancel: 'Cancel',
  sessionConfirmOkStopArchive: 'Stop and archive',
  sessionActivityKind: kind => ({ turn: 'a running turn', subagent: 'subagents', job: 'background jobs', schedule: 'schedules' })[kind] ?? kind,
  sessionRenameTitle: '✏️ Rename session',
  sessionRenamePlaceholder: 'Enter a new session title…',
  sessionRenameConfirm: 'Confirm',
  sessionRenameCancel: 'Cancel',
  sessionResultSwitched: target => `Switched to session "${target}".`,
  sessionResultDetached: label => `🔓 Released the session. ${label} was reset to a brand-new session.`,
  sessionResultArchived: () => 'Session archived. Unarchive it from the workspace webui first.',
  sessionResultForked: id => `Forked a new session \`${id}\`.`,
  sessionResultRenamed: title => `Renamed session to "${title}".`,
  sessionResultPinned: label => `Pinned "${label}".`,
  sessionResultUnpinned: label => `Unpinned "${label}".`,
  sessionResultPinArchived: label => `"${label}" is archived, so it cannot be pinned - unarchive it first.`,
  sessionResultPinFailed: label => `Could not pin "${label}" - see the log.`,
  sessionErrorOccupied: 'That session is already occupied — detach it first.',
  sessionErrorArchived: 'That session is archived — unarchive it from the workspace webui first.',
  sessionErrorInvalid: 'Invalid session.',
  sessionActionLabel: action => `Action "${action}"`,

  modelSelectTitle: newSession => newSession ? '🤖 Model selection (new session)' : '🤖 Model selection',
  modelSelectCurrent: (provider, model, effort) =>
    `**Current model**　\`${provider}/${model}\`\n🧭 Reasoning effort: \`${effort}\``,
  modelSelectProviderHeader: '**Select provider**',
  modelSelectProviderPlaceholder: 'Select provider…',
  modelSelectModelHeader: '**Select model**',
  modelSelectModelEmpty: 'No models available under this provider.',
  modelSelectModelPlaceholder: empty => empty ? 'No models available under this provider…' : 'Select model…',
  modelSelectEffortHeader: '**Reasoning effort**',
  modelSelectEffortPlaceholder: 'Select reasoning effort…',
  modelSelectConfirm: newSession => newSession ? '✅ Confirm and create session' : '✅ Confirm switch',
  modelSelectNewSessionTitle: '🤖 Model selection (new session)',

  permissionTitle: 'Permission',
  permissionCurrent: mode => `**Current permission mode:** \`${mode}\``,
  permissionHint: '_Click below to switch this session\'s permission (sandbox) mode. The change is written to the session log and applies on the next restricted call._',
  permissionReadOnly: 'Read Only',
  permissionWorkspaceWrite: 'Workspace Write',
  permissionFullAccess: 'Full access',

  busyTitle: '⏳ Busy behavior',
  busyIntro: 'How should a new message enter while the agent is running?',
  busyQueueLabel: '📥 Queue',
  busySteerLabel: '🎯 Steer',
  busyCurrentOption: mode => `Current: ${mode === 'steer' ? 'Steer' : 'Queue'}`,

  questionSkip: 'Skip',
  questionChoicePrefix: 'Option',

  onboardingTitle: '🤖 New session',
  onboardingSubtitle: 'Pick a workspace and agent preset to start.',
  onboardingSelectPreset: 'Select agent preset',
  onboardingPresetLabel: id => id,
  onboardingNewSessionLabel: 'Start session',
  onboardingStart: '🚀 Start session',

  cardFoldTitle: title => `${title} (▸ Collapsed · click to expand)`,

  stepReasoningHeader: '💬 **Reasoning**',
  stepMessageHeader: '📝 **Message**',
  stepToolHeader: '🔧 **Tool Call**',
  stepToolSuccess: 'ok',
  stepToolError: 'failed',
  stepToolRunning: 'running…',
  stepToolArgsHeader: '**⚙️ Args**',
  stepToolResultHeader: '**📤 Result**',
  stepCardTitleError: 'Tool Error',
  stepCardTitleDone: 'Tool Done',
  stepCardTitleCall: 'Tool Call',
  stepCardTitleReply: 'Reply',
  stepPlaceholderTitle: '⏳ Analyzing request',
  stepAutoTriggerNote: trigger => `⚡ This turn was started automatically: **${trigger}**`,
  autoTurnTriggerName: kind => {
    switch (kind) {
      case 'job': return 'Background task updated'
      case 'schedule': return 'Automation task'
      case 'subagent': return 'Subtask status updated'
      case 'agent': return 'Task message received'
      case 'team': return 'Team message received'
      case 'goal': return 'Continuing goal'
      case 'github': return 'GitHub event received'
      case 'webhook': return 'External event received'
      case 'plugin': return 'Plugin status updated'
      case 'request': return 'Execution requested'
      // An unseen producer is named, never quoted (key pitfall 50).
      default: return kind
    }
  },
  surfaceLabelWebGui: 'Web GUI',
  surfaceLabelOther: 'another surface',
  stepPlaceholderBody: 'The request has not been sent — the model has nothing from this turn yet',
  stepAwaitingTitle: '📡 Request sent, awaiting output…',
  stepAwaitingBody: 'No token yet — output updates this card in place',
  stepThinkingTitle: '🧠 Thinking…',
  stepThinkingBody: 'Reasoning — output updates this card in place',
  stepToolTitle: '🔧 Calling a tool…',
  stepToolBody: 'The model is building a tool call — the result lands on this card when it runs',
  stepReplyingTitle: '✍️ Replying',
  stepReplyingBody: 'The model is writing — the reply lands on this card when it settles',
  stepRouteLine: (provider, model) => `📡 ${provider} / ${model}`,
  stepEmptyTitle: 'Empty step',
  stepEmptyBody: '(nothing to show for this step)',
  stepPosition: (turn, step) => `Turn ${turn} · Step ${step}`,
  stepCardStaleNotice: (turn, step, reason) =>
    `⚠️ ${turn > 0 && step > 0 ? `The card for turn ${turn}, step ${step}` : 'A card'} could not be updated and is stuck on its old content.\nReason: ${reason}`,
  stepToolCount: (calls, failed) =>
    `🔧 ${calls} tool ${calls === 1 ? 'call' : 'calls'}${failed > 0 ? ` · ${failed} failed` : ''}`,

  // Turn progress card (feishu-progress.ts): `compact` merges the whole turn's
  // tool activity onto one card.
  // `深度求索中` is the Chinese name of DeepSeek read as "DeepSeek is at work";
  // the English locale keeps the same pun in verb form.
  turnCardTitleRunning: elapsed => `🐳 DeepSeeking · ${elapsed}`,
  turnCardTitleDone: (calls, failed, elapsed) =>
    `⚙️ This turn · ${calls} tool ${calls === 1 ? 'call' : 'calls'}${failed > 0 ? ` · ${failed} failed` : ''} · ${elapsed}`,
  turnCardTitleFailed: (calls, elapsed) =>
    `⚙️ This turn failed · ${calls} tool ${calls === 1 ? 'call' : 'calls'} · ${elapsed}`,
  turnCardStep: (step, elapsed, light) => `▸ **Step ${step}**${light === undefined ? '' : ` · ${light}`} · ${elapsed}`,
  turnCardStepFailed: '❌ failed',
  turnCardCallUnrun: name => `⚠️ \`${name}\` · not run`,
  turnCardStepNote: note => `💬 ${note}`,
  turnCardToolRunning: (label, elapsed) => `⏳ ${label} · ${elapsed}…`,
  turnCardRunningLabel: 'running',
  turnCardToolDone: (label, elapsed) => `✅ ${label} · ${elapsed}`,
  turnCardToolFailed: (label, elapsed) => `❌ ${label} · ${elapsed}`,
  turnCardOlderRows: rows => `**${rows} earlier ${rows === 1 ? 'row' : 'rows'}**`,
  turnCardPhaseAwaiting: '📡 awaiting output',
  turnCardPhaseThinking: '🧠 thinking',
  turnCardPhaseReplying: '✍️ replying',
  turnCardPhaseTool: '🔧 calling tools',

  // Context-injection notices (injection-notice.ts): attribution only, never the
  // injected content.
  injectionContext: '📥 Context injected',
  injectionRecall: '🔗 Cross-session recall',
  injectionRelay: '✉️ Inter-session message',
  injectionSubagent: '🤖 Subagent settled',
  injectionGoal: '🎯 Goal updated',
  injectionSkillLoaded: '📥 Skill loaded',
  injectionSkillCatalog: entries => `skill catalog (${entries})`,
  injectionPlugin: name => `plugin ${name}`,
  injectionRuntimeSnapshot: 'runtime snapshot',
  injectionApproval: 'approval result',
  injectionActionLoaded: 'loaded',
  injectionActionAdded: 'added',
  injectionActionUpdated: 'updated',
  injectionActionRemoved: 'removed',
  injectionFromSession: sessionId => `from session ${sessionId}`,
  injectionRound: round => `round ${round}`,

  // Compaction card (feishu-compaction.ts)
  compactionCardTitleStart: '🗜️ Compacting context…',
  compactionCardTitleDone: '🗜️ Context compacted',
  compactionCardTitleDoneManual: '🗜️ Context compacted (/compact)',
  compactionCardTitleFailed: '⚠️ Context compaction failed',
  compactionStartBody: trigger => `Triggered by: ${trigger}`,
  compactionTriggerAuto: 'automatic (context pressure)',
  compactionTriggerManual: '/compact',
  compactionFoldedItems: items => `folded ${items} history ${items === 1 ? 'item' : 'items'}`,
  compactionFoldedTokens: tokens => `about ${tokens} tokens`,
  compactionSummaryLabel: 'Summary',
  compactionSummaryUnavailable: '(this compaction carried no summary)',
  compactionSummaryCut: (shown, total) => `⚠️ One card cannot carry the whole summary: the text above is the first ~${shown} characters of ${total}`,
  compactionFailedReason: reason => `Reason: ${reason}`,
  compactionNoSummary: 'No summary was produced, so the session history was left unchanged.',
  turnCompleteTitle: '✅ Turn complete',
  turnSummaryTitle: '✅ Done',
  turnContinuedPart: (part, total) => `continued ${part}/${total}`,
  turnContinuedTitle: '📄 continued',
  turnCompleteDetail: (duration, llm, tools) => `Total ${duration} · LLM ${llm} · Tools ${tools}`,
  turnCompleteSteps: (steps, tokens, speed) => `${steps} steps · ${tokens} · ${speed}`,
  turnCompleteExternalTurn: source => `💬 This turn came from **${source}**, not from a Feishu message; its process and deliverables are mirrored here`,
  externalMessageFromWebGui: '💬 Web GUI: ',
  externalMessageFromOther: '💬 Another surface: ',
  externalMessageAttachments: (images, files) => {
    const parts: string[] = []
    if (images > 0) parts.push(`${images} image${images === 1 ? '' : 's'}`)
    if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`)
    return `(attachments: ${parts.join(', ')} — not mirrored into Feishu)`
  },
  enterWhileBusy: 'Enter while busy',
  busySteeredNotice: '🎯 Injected into the running turn — the model will see it on the next step.',
  busyQueuedNotice: '📥 Queued — it will run after the current turn finishes (send /stop while waiting to discard it).',
  turnFailedTitle: 'This turn failed',
  failureAuth: 'API key is invalid',

  statusRunWarning: '> ⚠️ The agent is running; this may be stale. Send `/status` again after it finishes.',
  statusSessionLabel: 'Session',
  statusTitleLabel: 'Title',
  statusWorkspaceLabel: 'Workspace',
  statusPresetLabel: 'Preset',
  statusModelLabel: 'Model',
  statusReasoningLabel: 'Reasoning',
  statusPermissionLabel: 'Permission',
  statusBusyLabel: 'Enter while busy',
  statusAgentRunning: '🔄 Running',
  statusAgentIdle: '⏸️ Idle',
  statusAgentLabel: 'Agent',

  cancel: 'Cancel',
  confirm: 'Confirm',
  back: 'Back',
  next: 'Continue',

  // ---- Extra keys for the bilingual card renderers ----
  busyCurrentLabel: 'Enter behavior while running (busy)',
  busyHint: '_Click below to switch how this chat handles a message received while the agent is running (aligned with the WebUI "Enter behavior while busy"). Persisted and kept across restarts._',
  busyQueueWord: 'Queue',
  busySteerWord: 'Steer',
  busyQueueDesc: 'Runs as a new round after the current one (default)',
  busySteerDesc: 'Injects into the current running round to respond immediately',

  // Turn Complete deliverables list (channel.ts / feishu-deliver.ts; from DSH's
  // `present` tool via `deliverables/presented`). Media renders in the card;
  // whitelisted documents under the size setting are pushed as native file
  // messages; every other file is a click → confirm → send row.
  deliverablesTitle: (count: number) => `📦 **Present files** (${count})`,
  deliverablesCardTitle: '📦 Deliverables',
  deliverablesMore: (count: number) => `_…and ${count} more (not shown; ask the model to send one with \`feishu_send_file\`)_`,
  turnProducedLine: (count: number) => `📦 ${count} file(s) produced this turn`,
  deliverTapHint: '_Files marked "tap to send" go out with one tap, after a confirmation._',
  deliverTapToSend: 'tap to send',
  deliverAutoSent: 'auto-delivery',
  deliverPreview: 'preview',
  deliverBlockedReason: reason => ({
    'too-large': 'over Feishu\'s 30 MB limit — cannot be sent',
    unreadable: 'the file is missing, empty, or unreadable',
    outside: 'outside this session\'s workspace — cannot be sent',
  })[reason],
  deliverCardTitle: '📤 File delivery',
  deliverConfirmBody: (name, size) => `Send **${name}** (${size}) to this chat?`,
  deliverSendButton: '📤 Send',
  deliverCancelButton: 'Cancel',
  deliverSent: name => `✅ Sent **${name}**.`,
  deliverCancelled: name => `Cancelled sending **${name}**.`,
  deliverFailed: (name, reason) => `❌ Could not send **${name}**: ${reason}`,
  deliverAutoFailed: (name, reason) => `⚠️ Automatic delivery of **${name}** failed: ${reason} (ask me to resend it)`,
  deliverExpired: '⌛ This file card has expired (older than 30 minutes, or from a previous run). Ask the model to list the files again.',
  deliverFileGone: 'the file no longer exists or cannot be read',
  deliverOutside: 'it is outside this session\'s workspace',
  deliverTooLarge: 'it is over Feishu\'s 30 MB limit',

  // Display switch card (feishu-display.ts)
  displayCardTitle: '📇 Card display',
  displayCardHint: '_Click a button to toggle; saved immediately and shared with the WebUI settings panel._',
  displayCardLabel: (key: 'reasoning' | 'tools' | 'args' | 'results') =>
    ({ reasoning: 'Reasoning', tools: 'Tool calls', args: 'Arguments', results: 'Results' })[key],
  displayCardButton: (label: string, enabled: boolean) => `${enabled ? '✅' : '⬜'} ${label}: ${enabled ? 'on' : 'off'}`,
  displayCardHiddenByTools: '_Arguments and results are hidden together with tool calls; they come back when tool calls are re-enabled._',
  displayCardNote: 'Also available as `/display <switch> on|off` and `/display tick 3|5|10|30`.',
  displayCardTickTitle: '**Elapsed-time refresh**',
  displayCardTickHint: 'Shared by compact progress and other levels’ waiting cards; new events are not delayed.',
  displayCardTickButton: (seconds, active) => `${active ? '🔘' : '⚪'} ${seconds}s`,
  pendingAttachmentsNotice: (images, files) => `📥 Saved ${[images > 0 ? `${images} image${images === 1 ? '' : 's'}` : '', files > 0 ? `${files} file${files === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}, waiting for your text instructions; your next text message will send them to the Agent together.`,
  pendingAttachmentsDiscarded: 'Cleared the attachments saved for the previous session.',
  displayCardLevelTitle: '**Work details** (the WebUI\'s four levels)',
  displayLevelName: level => ({ compact: 'Compact', standard: 'Standard', detailed: 'Detailed', verbose: 'Verbose' })[level],
  displayCardLevelButton: (name, active) => `${active ? '🔘' : '⚪'} ${name}`,
  displayLevelHint: level => ({
    compact: 'Tool-call counts and status only; no reasoning text',
    standard: 'One summary line per call, reasoning first line only; no arguments or results',
    detailed: 'Reasoning expandable, tools with arguments and results (default)',
    verbose: 'Full reasoning, arguments and results untruncated',
  })[level],
  displayLevelCustom: 'The four switches below no longer add up to any single level',
  displayLevelSet: name => `✅ Detail level set to "${name}".`,

  permissionNoSession: 'This chat has no session yet — send a message first, then run /permission',
  permissionSwitchFailed: reason => `⚠️ **Switch not applied**: ${reason}`,
  permissionSwitchBusyShellHint: '_Why: this session still has a persistent terminal running, and DSH refuses a sandbox-mode change while one is live (it would affect running commands). Start a new session, or use a preset without a persistent shell._',

  modelSelectProviderLabel: label => `**Provider**　\`${label}\``,
  modelSelectBack: '← Back to choose provider',
  modelSelectSwitchedHeader: '✅ **Switched**',
  modelSelectSwitchedNext: 'The next round will use the new model.',
  modelSelectLastUsedButton: '↺ Back to last used',
  modelSelectLastUsed: (provider, model) => `↺ Last used: \`${provider}/${model}\` (tap below to switch back — **this session only**)`,
  modelSelectLastUsedSwitched: 'Switched back to this session\'s last used model (**this session only** — the global default is untouched).',
  modelSelectLastUsedFailed: reason => `⚠️ Could not switch back: ${reason}`,
  modelSelectRecentHeader: '🕘 **Recently used (global)** — tap a row to switch (this session only)',
  modelSelectRecentCurrent: (provider, model) => `✅ Current: \`${provider}/${model}\``,
  modelSelectRecentHeaderNewSession: '🕘 **Recently used (global)** — tap a row to use it for the new session',
  modelSelectLastUsedButtonNewSession: '↺ Use previous model',
  modelSelectLastUsedNewSession: (provider, model) => `↺ Last used: \`${provider}/${model}\` (tap below to use it for the new session)`,
  modelSelectNewSessionDefault: (provider, model, effort) =>
    `⭐ **Default model**　\`${provider}/${model}\`\n🧭 Reasoning effort: \`${effort}\`\nTap this row to use it for the new session`,
  newSessionRouteUnavailable: '⚠️ That model is no longer offered — pick one from the list below.',
  reasoningCardTitle: '🧠 Reasoning effort',
  reasoningCardHint: 'Tap a row to switch (this session only — the global default is untouched)',
  reasoningCardCurrent: effort => `✅ Current: **${effort}**`,
  reasoningCardDefault: 'provider default',
  reasoningCardSwitched: effort => `🧠 This session now uses **${effort}** (this session only — the global default is untouched).`,
  reasoningCardOnlySession: 'this session only',
  reasoningCardEmpty: 'This model\'s provider declares no selectable reasoning efforts.',
  reasoningCardNoAgent: 'This session is not loaded right now (nothing since the restart). Send a normal message first.',
  reasoningCardUnsupported: 'The agent of this host exposes no in-session switch.',
  modelSelectRecentSwitched: 'This session switched to that model (**this session only** — the global default is untouched).',
  modelSelectLastUsedFailedNoSession: 'This session is not loaded right now (nothing since the restart). Send a normal message first.',
  modelSelectLastUsedFailedUnsupported: 'The agent of this host exposes no in-session model switch.',
  modelSelectEffortLine: effort => `🧠 Reasoning effort: \`${effort}\``,
  modelSelectFailHeader: '⚠️ **Switch failed**',
  modelEffortDefault: 'default (not specified)',
  modelEffortOff: 'off (thinking off)',
  modelEffortLow: 'low (light reasoning)',
  modelEffortHigh: 'high (deep reasoning)',
  modelEffortMax: 'max (max reasoning)',

  sessionPanelSelectLabel: '**Select session**',
  sessionPanelSelectPlaceholder: empty => empty ? 'No sessions' : 'Select session…',
  sessionPanelActionLabel: '**Run an action**',
  sessionPanelCount: (total, locked) => `${total} sessions${locked > 0 ? ` · ${locked} in use` : ''}`,
  sessionPanelHint: '_Pick a session, then tap a button below to run it._',
  sessionListButton: '📋 List',
  sessionRefreshButton: '🔄 Refresh',
  sessionOpSwitch: 'Switch',
  sessionOpDetach: 'detach',
  sessionOpArchive: 'archive',
  sessionOpFork: 'fork',
  sessionOpRename: 'rename',
  sessionOpPin: 'pin',
  sessionOpUnpin: 'unpin',
  sessionConfirmDetailSwitch: label => `This chat will be switched to session \`${label}\`; if another chat owns it, the switch will take it over.`,
  sessionConfirmDetailDetach: label => `This will release session \`${label}\` (the current owner resets to a brand-new session).`,
  sessionConfirmDetailArchive: label => `This will archive session \`${label}\`.`,
  sessionConfirmDetailArchiveActive: (label, activity) => `Session \`${label}\` is **still running** (${activity}).\n\nArchiving will **stop** that work first, then archive the session.`,
  sessionConfirmDetailFork: label => `This will fork a new session from \`${label}\` (keeps the conversation up to the current event).`,
  sessionConfirmDetailRename: label => `This will rename session \`${label}\` to a new title.`,
  sessionResultEmptyTitle: '⚠️ Empty title',
  sessionResultEmptyBody: 'Please enter a session title first, then confirm.',
  sessionResultUnavailable: '⚠️ Unavailable',
  sessionResultUnavailableRename: 'Rename is not enabled in this deployment.',
  sessionResultRenamedHeader: '✅ Renamed',
  sessionResultRenamedBody: label => `Renamed session \`${label}\` to:`,
  sessionResultRenameFailed: '❌ Rename failed',
  sessionResultCancelled: 'Cancelled',
  sessionResultCancelledBody: 'This operation was cancelled.',
  sessionResultArchivedHeader: '⚠️ Archived',
  sessionResultArchivedSwitchBody: label => `Session \`${label}\` is archived and cannot be switched to.`,
  sessionResultSwitchedHeader: '✅ Switched',
  sessionResultSwitchedBody: label => `This chat is now switched to session \`${label}\`. The next round will use it.`,
  sessionResultDetachHeader: '🔓 Detached',
  sessionResultDetachFree: label => `Session \`${label}\` was already free.`,
  sessionResultDetachReleased: (label, owner) => `Released session \`${label}\` (previous owner: ${owner}).`,
  sessionResultArchivedOk: '🗄️ Archived',
  sessionResultArchivedBody: label => `Session \`${label}\` was archived.`,
  sessionResultForkHeader: '🍴 Forked',
  sessionResultForkBody: (label, id) => `Forked a new session from \`${label}\`${id !== undefined ? ` \`${id}\`` : ''}. Use /new or switch to it in this panel.`,
  sessionResultOpFailed: '❌ Operation failed',
  sessionResultUnsupported: name => `${name} is not enabled in this deployment.`,
  sessionRenamePrompt: label => `Enter a new title for session \`${label}\`:` ,
  sessionRenameButton: '✅ Confirm rename',
  sessionListTitle: '📋 Session list',
  sessionListTableHeader: '| Session | ID | Preset | In use | Last active |',
  sessionListNone: 'No sessions.',
  sessionTimeJustNow: 'just now',
  sessionTimeMinute: 'm ago',
  sessionTimeHour: 'h ago',
  sessionTimeDay: 'd ago',

  onboardingAttachTitle: '🚀 Pick a session',
  onboardingSessionFallback: (index, id) => `Session ${index + 1} (${id})`,
  onboardingInUse: owner => ` 🔒 in use by ${owner}`,
  onboardingNoSessions: 'There are no persisted sessions yet. Tap the button below to create a new one.',
  onboardingPickExisting: '**📚 Pick an existing session**',
  onboardingSelectPlaceholder: 'Select session…',
  onboardingAttachButton: '📎 Attach to this session',
  onboardingNewButton: '✨ New session',
  onboardingIntro: threadLabel => `**👋 Getting started**\n\n${threadLabel} is not bound to any session yet. Pick an existing session below to continue, or create a new one.`,
  onboardingWorkspaceHeader: '**📁 Pick a workspace**\n\nThe new session will run in this workspace.',
  onboardingNoWorkspaces: 'No workspaces yet — enter a path below to create one.',
  onboardingNewWorkspaceHeader: '**🆕 New workspace**\n\nEnter an absolute path, or a `~`-relative home path.',
  onboardingWorkspacePlaceholder: 'e.g. ~/projects/my-app or an absolute path',
  onboardingCreateWorkspaceButton: '✅ Confirm and create workspace',
  onboardingNewTitle: '🆕 New session',
  onboardingPresetHeader: '**🧩 Choose an agent preset**\n\nThe preset decides which capabilities this session has.',
  onboardingNoPresets: 'No presets available; the default preset will be used.',
  onboardingCreatedTitle: '✅ Session created',
  onboardingCreatedBody: (sessionId, summary) => `**Session** \`${sessionId}\`\n\n${summary}\n\nYou can now send a message to start chatting.`,
  newSessionConfirmTitle: '🧩 New session · please confirm',
  newSessionConfirmHint: 'Confirming creates the session with the settings below.',
  newSessionConfirmCreate: '✅ Create session',
  newSessionConfirmCancel: '✖️ Cancel',
  newSessionCancelledTitle: '✖️ New session cancelled',
  newSessionCancelledBody: 'No session was created. Run `/new` again to retry.',
  newSessionConfirmWorkspace: path => `📁 **Workspace**: \`${path}\``,
  newSessionConfirmWillCreate: path => `🆕 **Will create the folder**: \`${path}\` (missing parents included)`,
  newSessionConfirmPreset: preset => `🧩 **Agent preset**: \`${preset}\``,
  newSessionConfirmModel: route => `🤖 **Model**: \`${route}\``,
  newSessionConfirmEffort: effort => `🧠 **Reasoning effort**: \`${effort}\``,
  newSessionConfirmDefaults: '_No workspace/preset chosen; the defaults will be used._',
  newSessionSettledWorkspaceTitle: '✅ Workspace chosen',
  newSessionSettledWorkspace: path => `📁 \`${path}\``,
  newSessionSettledWillCreate: '🧱 This directory does not exist yet; it is created together with the session.',
  newSessionSettledPresetTitle: '✅ Agent preset chosen',
  newSessionSettledPreset: preset => `🧩 **${preset}**`,
  newSessionSettledModelTitle: '✅ Model chosen',
  newSessionSettledModel: (provider, model) => `🔹 \`${provider}/${model}\``,
  newSessionSettledHint: 'This card is locked · continue with the newest card below.',
  onboardingAttachedTitle: '📎 Session attached',
  onboardingTakeover: owner => `\n\n🔓 Took over this session from ${owner} (the previous owner was reset to a brand-new session).`,
  onboardingAttachedBody: (sessionId, takeover) => `Attached to session \`${sessionId}\`.${takeover}\n\nYou can now send a message to continue chatting.`,
  onboardingAttachArchivedTitle: '📎 Attach session',
  onboardingAttachArchivedBody: '⚠️ This session is archived and cannot be attached.',
  onboardingCreateWorkspaceFailTitle: '📁 New workspace',
  onboardingCreateWorkspaceFailBody: (path, msg) => `⚠️ **Failed to create workspace**\n\n\`${path}\`\n\n${msg}`,
  onboardingCancelTitle: '🚀 New session',
  onboardingCancelledBody: 'New session creation was cancelled.',
  onboardingCreateWorkspaceConfirmTitle: '📁 That folder does not exist yet',
  onboardingCreateWorkspaceConfirmBody: path => `⚠️ **That folder does not exist yet**\n\n\`${path}\`\n\nCreating the session will **create it** (missing parents included). Nothing is written to disk until you confirm.`,
  onboardingCreateWorkspaceConfirmButton: '✅ Create this folder',
  onboardingCreateWorkspaceBackButton: '← Enter another path',
  onboardingCreateWorkspaceSiblingHeader: parent => `**What is next door** (tap a row to use it instead, under \`${parent}\`)`,
  onboardingCreateWorkspaceNotAbsolute: path => `⚠️ **An absolute path is required**\n\n\`${path || '(empty)'}\`\n\nStart with \`/\`, or use \`~\` for your home directory.`,
  onboardingCreateWorkspaceNotADirectory: 'That path already exists, but it is a file, not a directory.',
  onboardingBrowseNewFolder: '📁＋ New folder',
  onboardingBrowseNewFolderPlaceholder: 'New folder name (one segment, no /)',
  onboardingBrowseNewFolderExists: name => `⚠️ A folder named “${name}” is already there.`,
  onboardingBrowseNewFolderInvalid: name => `⚠️ “${name}” is not a usable folder name (one segment, no / or \\).`,
  onboardingBrowseNewFolderFailed: msg => `⚠️ Could not create the folder: ${msg}`,
  onboardingBrowseButton: '📂 Browse folders…',
  onboardingBrowseTitle: '📂 Pick a workspace folder',
  onboardingBrowseHeader: path => `**📁 Current folder**\n\n\`${path}\``,
  onboardingBrowseUp: '⬆️ Up one level',
  onboardingBrowseHome: '🏠 Home',
  onboardingBrowseShowHidden: '👁 Show hidden folders',
  onboardingBrowseHideHidden: '🙈 Hide hidden folders',
  onboardingBrowsePrev: '← Previous page',
  onboardingBrowseNext: 'Next page →',
  onboardingBrowsePage: (page, total) => `Page ${page} / ${total}`,
  onboardingBrowseEmpty: '(No subfolders here)',
  onboardingBrowseTruncated: '…Too many entries; only the first part is listed. Enter a more specific folder to continue.',
  onboardingBrowsePick: '✅ Use this folder',
  onboardingBrowseBack: '← Back to workspace list',

  questionSelectedSuffix: 'selected',
  questionCustomAnswerLabel: 'Custom answer:',
  questionSkippedLabel: 'skipped',
  questionSelectedLabel: 'Selected:',
  questionDefaultTitle: 'Question',
  questionCustomHint: hasOptions => hasOptions ? 'None of the options fit? Type your custom answer below:' : 'Type your answer below:',
  questionCustomPlaceholder: 'Type here…',
  questionSubmitCustom: '✏️ Submit custom answer',
  questionSkipButton: '⏭️ Skip this question',
  questionMultiHint: 'Select one or more, then press Submit:',
  questionSubmitButton: '✅ Submit',
  questionTapHint: 'Tap an option to answer:',
  questionReceiptTitle: '✅ Submitted',
  questionReceiptAnswer: answer => `Selected: ${answer}`,
  questionReceiptNote: 'Recorded. Tapped the wrong one? Use 返回 below to answer this question again.',
  questionReceiptBack: '↩️ Redo this one',
  questionReceiptUndone: 'That answer was undone — answer this question on the fresh card below.',
  questionBatchTitle: '📝 Confirm all answers',
  questionBatchRow: (question, answer) => `**${question}**\n${answer}`,
  questionBatchUnanswered: '(unanswered)',
  questionBatchNote: 'All answered. Confirm hands the set to the model; back one question lets you change the last one.',
  questionBatchConfirm: '✅ Confirm',
  questionBatchBack: '↩️ Back one question',
  questionBatchSubmittedTitle: '✅ Submitted',
  questionBatchSubmittedNote: 'The set has been handed to the model; this card no longer accepts changes. Reply below to change it.',
  questionCardRetiredTitle: 'Superseded',
  questionCardRetired: 'This card already delivered one tap, so Feishu no longer reports taps on its option rows. **Please answer on the fresh copy of the question below.**',

  // Background-task panel (feishu-jobs.ts)
  jobPanelTitle: '🧩 Background jobs',
  jobPanelSummary: (running, total) => `${running} running · ${total} total`,
  jobPanelColStatus: 'State',
  jobPanelColTask: 'Task',
  jobPanelColId: 'ID',
  jobPanelColDuration: 'Duration',
  jobPanelColProgress: 'Progress / result',
  jobPanelClearButton: '🧹 Clear finished',
  jobPanelCleared: count => `🧹 Cleared ${count} finished background job${count === 1 ? '' : 's'}`,
  jobPanelFullCommands: '📜 Full commands',
  jobPanelCommandTruncated: total => `(full command is ${total} characters — truncated to fit one card)`,
  jobUntitled: 'Untitled job',
  jobStatusRunning: 'Running',
  jobStatusStopping: 'Stopping',
  jobStatusCompleted: 'Completed',
  jobStatusFailed: 'Failed',
  jobStatusKilled: 'Stopped',

  // Subagent panel (feishu-subagents.ts)
  subagentPanelTitle: '🤖 Subagents',
  subagentPanelSummary: (running, total) => `${running} running · ${total} total`,
  subagentPanelColStatus: 'State',
  subagentPanelColAgent: 'Subagent',
  subagentPanelColModel: 'Model',
  subagentPanelColSession: 'Session',
  subagentPanelColMode: 'Mode',
  subagentPanelColDuration: 'Duration',
  subagentUntitled: 'Untitled subagent',
  subagentStatusRunning: 'Running',
  subagentStatusCompleted: 'Completed',
  subagentStatusFailed: 'Failed',
  subagentStatusAborted: 'Aborted',
  subagentStatusRefused: 'Refused',
  subagentStatusMaxTokens: 'Token limit',
  subagentStatusInactive: 'Ended',
  subagentModeOneShot: 'one-shot',
  subagentModeContinuable: 'continuable',
  subagentModeUnknown: 'unknown',
  subagentStatusNotRunning: 'Not running',
  subagentDiagnostic: reason => ({ corrupt: 'corrupt catalog', unsupported: 'unsupported mode', unavailable: 'catalog unreadable' })[reason] ?? 'catalog anomaly',
  subagentsCommandDescription: 'Show this session\'s subagent panel (`tree` for the whole subtree)',
  subagentCommandUsage: '⚠️ Usage: `/subagents [tree]`',
  subagentCommandEmpty: 'No subagents',
  subagentCommandUnchanged: 'The panel has not changed',
  subagentCommandFailed: 'subagent panel failed',
  subagentPanelSource: 'Sources: host catalog + this process\'s events',

  panelMoreRows: count => `${count} older entries not shown`,
}

/**
 * Normalise an arbitrary DSH locale preference (BCP 47-ish, e.g. `zh-CN`,
 * `en-US`, `zh`, `en`) into one of the plugin locale ids.
 */
export function toLocaleId(value: string | undefined): LocaleId | undefined {
  if (value === undefined) return undefined
  const base = value.split('-')[0]?.toLowerCase() ?? ''
  if (base === 'zh') return 'zh'
  if (base === 'en') return 'en'
  return undefined
}

/**
 * Resolve the active plugin locale.
 *
 * @param pluginLocale - the plugin's own `locale` setting (`auto` = follow DSH).
 * @param dshPreference - the DSH browser-language preference, if readable.
 * @returns the locale to render with; defaults to `zh`.
 */
export function resolveLocale(pluginLocale: PluginLocale | undefined, dshPreference: string | undefined): LocaleId {
  if (pluginLocale === 'zh' || pluginLocale === 'en') return pluginLocale
  const dsh = toLocaleId(dshPreference)
  if (dsh !== undefined) return dsh
  return 'zh'
}

/** Return the dictionary for a locale. */
export function translationsFor(locale: LocaleId): Translations {
  return locale === 'en' ? en : zh
}
