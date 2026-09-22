/**
 * Feishu `/session` management panel.
 *
 * A single interactive card lets the user pick a session (by name) and run one
 * of five operations: switch (rebind this chat to the session — the plugin's
 * chat→session ownership), detach (plugin), rename / archive / fork (DSH
 * built-ins via `sessionController` / `workspaceRegistry`). Destructive ops
 * (switch-while-occupied, detach, archive, fork) ask for a confirm/cancel card
 * first; the outcome is a green result card.
 *
 * Blends the established Feishu card patterns: `select_static` + form submit
 * (like `feishu-model-select.ts`) to read the picked session and the rename
 * title, and the shared `cardChannel.onCardAction` dispatcher for every
 * callback — so buttons keep working across channel reconnects.
 *
 * @module @starxer/chatterbox4dsh/feishu-session
 */

import type { ConversationMessage } from './conversation.ts'
import { conversationKey } from './conversation.ts'
import type { HarnessConversationService } from './harness.ts'
import type { Translations } from './i18n.ts'
import { decodeCardValue } from './card-action.ts'

/** One session entry surfaced by the panel (bridge.listSessions shape). */
export interface SessionEntry {
  id: string
  updatedAt: number
  title: string
  ownedBy?: string
  /** Display name (or id) of the session's agent preset; absent when unknown. */
  agentPreset?: string
}

/** Narrow bridge surface the panel consumes. */
export interface SessionBridge {
  listSessions(): Promise<SessionEntry[]>
  attachSession(message: ConversationMessage, sessionId: string): 'ok' | 'archived'
  detachSession(sessionId: string): { kind: 'released'; ownerLabel: string } | { kind: 'free' }
  describeChatKey(key: string): string
}

/** DSH session rename/fork (optional — degrade gracefully when absent). */
export interface SessionControllerLike {
  rename?(request: { sessionId: string; title: string }): Promise<unknown>
  fork?(request: { sessionId: string; atSeq?: number }): Promise<unknown>
}

/** DSH archive (optional). */
export interface WorkspaceRegistryLike {
  /** 0.1.7 adds `options.stopActivity`: without it a session that still has
   *  running work is refused with `WorkspaceActiveSessionError`. */
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<unknown>
  /** Registry-global pin set, in pin order; read at render time. */
  readonly pinnedSessionIds?: readonly string[]
  /** Pin a session (idempotent). An archived session is refused with `WorkspaceArchivedSessionPinError`. */
  pinSession?(sessionId: string): Promise<unknown>
  /** Unpin a session (idempotent). */
  unpinSession?(sessionId: string): Promise<unknown>
}

/** Narrow card channel surface. */
export interface SessionCardChannel {
  send(to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  onCardAction(handler: (evt: SessionCardEvent) => void | Promise<void>): () => void
}

interface SessionCardEvent {
  messageId?: string
  chatId?: string
  action?: { value?: unknown; tag?: string; option?: string }
  raw?: { action?: { value?: unknown; form_value?: Record<string, unknown> } }
}

export interface FeishuSessionDeps {
  channel: SessionCardChannel
  bridge: () => HarnessConversationService | undefined
  sessionController?: SessionControllerLike
  workspaceRegistry?: WorkspaceRegistryLike
  logger: { warn(message: string): unknown; error(message: string): unknown }
  /** Return the strings for the ACTIVE locale, read at render time so language
   *  changes (/lang) apply to newly rendered cards without rebuilding. */
  getTranslations: () => Translations
}

export interface FeishuSessionHandle {
  /** Send the management panel card for one chat. */
  open(chat: ConversationMessage): Promise<string | undefined>
  stop(): void
}

type Op = 'switch' | 'detach' | 'rename' | 'archive' | 'fork' | 'pin' | 'unpin'

interface OpenState {
  chat: ConversationMessage
}

interface ConfirmState {
  token: string
  chat: ConversationMessage
  op: Op
  sessionId: string
  sessionLabel: string
  /** Archive only: the session still has running work, so archive must stop it. */
  stopActivity?: boolean
  /** Archive only: the running-work families reported by DSH, for the card text. */
  activity?: readonly string[]
}

/**
 * Read the running-work families off a `WorkspaceActiveSessionError`.
 *
 * Duck-typed on purpose: the error is thrown by the host, and this plugin can
 * hold its own copy of the class (`instanceof` across two module instances is
 * exactly the trap behind 关键坑 28). Returns `undefined` for any other error.
 * @param error - value thrown by `archiveSession`.
 * @returns the reported families, or `undefined` when this is not that error.
 */
export function activeSessionActivity(error: unknown): readonly string[] | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const candidate = error as { name?: unknown; activity?: unknown }
  if (candidate.name !== 'WorkspaceActiveSessionError') return undefined
  const kinds = (Array.isArray(candidate.activity) ? candidate.activity : [])
    .map(entry => (entry !== null && typeof entry === 'object' && typeof (entry as { kind?: unknown }).kind === 'string'
      ? (entry as { kind: string }).kind
      : undefined))
    .filter((kind): kind is string => kind !== undefined)
  // The error always carries at least one family; keep a usable card if not.
  return kinds.length > 0 ? kinds : ['active']
}

/** State for an in-flight rename card (name input + confirm). */
interface RenameState {
  chat: ConversationMessage
  sessionId: string
  sessionLabel: string
}

/** Locale-aware verb for an operation (used in confirm titles). */
function opWord(op: Op, t: Translations): string {
  switch (op) {
    case 'switch': return t.sessionOpSwitch
    case 'detach': return t.sessionOpDetach
    case 'archive': return t.sessionOpArchive
    case 'fork': return t.sessionOpFork
    case 'rename': return t.sessionOpRename
    case 'pin': return t.sessionOpPin
    case 'unpin': return t.sessionOpUnpin
  }
}

/** Short display name for a session entry. */
function sessionLabel(entry: SessionEntry): string {
  const title = entry.title === '' ? entry.id.slice(-12) : entry.title.replace(/\s+/g, ' ').slice(0, 60)
  return title
}

/** Build the session dropdown options (name → id). */
function sessionOptions(sessions: readonly SessionEntry[], pinned?: ReadonlySet<string>): Array<{ text: object; value: string }> {
  return sessions.map(entry => ({
    text: { tag: 'plain_text', content: pinned?.has(entry.id) === true ? `📌 ${sessionLabel(entry)}` : sessionLabel(entry) },
    value: entry.id,
  }))
}

/** Render the management panel card. */
export function renderSessionPanelCard(
  sessions: readonly SessionEntry[],
  currentChatKey: string,
  t: Translations,
  pinned?: ReadonlySet<string>,
): object {
  const options = sessionOptions(sessions, pinned)
  const formElements: object[] = [
    { tag: 'markdown', content: t.sessionPanelSelectLabel },
    {
      tag: 'select_static',
      name: 'session',
      placeholder: { tag: 'plain_text', content: t.sessionPanelSelectPlaceholder(options.length === 0) },
      options,
    },
    { tag: 'hr' },
    { tag: 'markdown', content: t.sessionPanelActionLabel },
    ...buildOpButtons(t),
  ]
  const locked = sessions.filter(s => s.ownedBy !== undefined && s.ownedBy !== currentChatKey).length
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.sessionPanelTitle },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `${t.sessionPanelCount(sessions.length, locked)}\n${t.sessionPanelHint}`,
        },
        { tag: 'hr' },
        { tag: 'form', name: 'session_panel', elements: formElements },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t.sessionListButton },
          type: 'default',
          behaviors: [{ type: 'callback', value: { action: 'list' } }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t.sessionRefreshButton },
          type: 'default',
          behaviors: [{ type: 'callback', value: { action: 'refresh' } }],
        },
      ],
    },
  }
}

/** Build the operation submit buttons (each carries its op). */
function buildOpButtons(t: Translations): object[] {
  const ops: Array<{ op: Op; label: string; type?: 'primary' | 'danger' }> = [
    { op: 'switch', label: t.sessionSwitch, type: 'primary' },
    { op: 'detach', label: t.sessionDetach },
    { op: 'archive', label: t.sessionArchive },
    { op: 'fork', label: t.sessionFork },
    { op: 'rename', label: t.sessionRename },
    { op: 'pin', label: t.sessionPin },
    { op: 'unpin', label: t.sessionUnpin },
  ]
  return ops.map(({ op, label, type }) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: type ?? 'default',
    name: `op_${op}`,
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value: { action: op } }],
  }))
}

/** Render a confirm/cancel card for a destructive op. */
export function renderSessionConfirmCard(state: ConfirmState, t: Translations): object {
  const stoppingArchive = state.op === 'archive' && state.stopActivity === true
  const detail: Record<Op, string> = {
    switch: t.sessionConfirmDetailSwitch(state.sessionLabel),
    detach: t.sessionConfirmDetailDetach(state.sessionLabel),
    archive: stoppingArchive
      ? t.sessionConfirmDetailArchiveActive(state.sessionLabel, activityText(state.activity, t))
      : t.sessionConfirmDetailArchive(state.sessionLabel),
    fork: t.sessionConfirmDetailFork(state.sessionLabel),
    rename: t.sessionConfirmDetailRename(state.sessionLabel),
    // Unreachable: pin/unpin are idempotent and never open a confirm card.
    pin: t.sessionOpPin,
    unpin: t.sessionOpUnpin,
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.sessionConfirmTitle(opWord(state.op, t)) },
      template: 'orange',
    },
    body: {
      elements: [
        { tag: 'markdown', content: detail[state.op] },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: `✅ ${stoppingArchive ? t.sessionConfirmOkStopArchive : t.sessionConfirmOk}` },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { action: 'confirm-ok', token: state.token } }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: `❌ ${t.sessionConfirmCancel}` },
          type: 'default',
          behaviors: [{ type: 'callback', value: { action: 'confirm-cancel', token: state.token } }],
        },
      ],
    },
  }
}

/** Render running-work families as one localized, comma-joined phrase. */
function activityText(activity: readonly string[] | undefined, t: Translations): string {
  const kinds = activity === undefined || activity.length === 0 ? ['active'] : activity
  return kinds.map(kind => t.sessionActivityKind(kind)).join(' / ')
}

/** Render a green result card. */
export function renderSessionResultCard(title: string, lines: readonly string[]): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'green' },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }] },
  }
}

/** Render a rename card: text input + confirm submit (self-contained). */
export function renderSessionRenameCard(sessionLabel: string, t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.sessionRenameTitle }, template: 'blue' },
    body: {
      elements: [
        { tag: 'markdown', content: t.sessionRenamePrompt(sessionLabel) },
        {
          tag: 'form',
          name: 'rename_form',
          elements: [
            { tag: 'input', name: 'new_title', placeholder: { tag: 'plain_text', content: t.sessionRenamePlaceholder }, max_length: 200 },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: t.sessionRenameButton },
              type: 'primary',
              name: 'confirm_rename',
              form_action_type: 'submit',
              behaviors: [{ type: 'callback', value: { action: 'rename-confirm' } }],
            },
          ],
        },
      ],
    },
  }
}

/** Render the `/session list` table card. */
export function renderSessionListCard(sessions: readonly SessionEntry[], t: Translations, pinned?: ReadonlySet<string>): object {
  const rows = sessions.map(entry => {
    const owned = entry.ownedBy === undefined ? '-' : '🔒'
    const name = pinned?.has(entry.id) === true ? `📌 ${sessionLabel(entry)}` : sessionLabel(entry)
    const preset = entry.agentPreset === undefined || entry.agentPreset === '' ? '-' : entry.agentPreset
    return `| ${name} | \`${entry.id.slice(-12)}\` | ${preset} | ${owned} | ${formatRelative(entry.updatedAt, t)} |`
  })
  const body = rows.length > 0
    ? `${t.sessionListTableHeader}\n|---|---|---|---|---|\n${rows.join('\n')}`
    : t.sessionListNone
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.sessionListTitle }, template: 'blue' },
    body: { elements: [{ tag: 'markdown', content: body }] },
  }
}

function formatRelative(updatedAt: number, t: Translations): string {
  const diff = Date.now() - updatedAt
  const m = Math.round(diff / 60_000)
  if (m < 1) return t.sessionTimeJustNow
  if (m < 60) return `${m}${t.sessionTimeMinute}`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}${t.sessionTimeHour}`
  return `${Math.round(h / 24)}${t.sessionTimeDay}`
}

/** Start the session panel: handle the panel + confirm card callbacks. */
export function startFeishuSession(deps: FeishuSessionDeps): FeishuSessionHandle {
  /** The registry's pin set, read fresh so each render reflects the latest write. */
  const pinnedIds = (): ReadonlySet<string> => new Set(deps.workspaceRegistry?.pinnedSessionIds ?? [])
  const { channel, bridge, sessionController, workspaceRegistry, logger, getTranslations } = deps
  const openCards = new Map<string, OpenState>()
  const confirmCards = new Map<string, ConfirmState>()
  const renameCards = new Map<string, RenameState>()

  const onCardAction = async (evt: SessionCardEvent): Promise<void> => {
    const messageId = evt.messageId
    if (messageId === undefined) return
    // Priority: a rename card overrides a confirm card overrides a panel card.
    // Await the inner handler instead of discarding it with `void`: a rejection
    // from a dropped promise has no owner, and DSH escalates an unhandled
    // rejection to `fatal load failure` + exit(1) (see `card-dispatch.ts`).
    const rename = renameCards.get(messageId)
    if (rename !== undefined) return handleRename(evt, rename)
    const confirm = confirmCards.get(messageId)
    if (confirm !== undefined) return handleConfirm(evt, confirm)
    const openState = openCards.get(messageId)
    if (openState !== undefined) return handlePanel(evt, openState)
  }

  const handlePanel = async (evt: SessionCardEvent, state: OpenState): Promise<void> => {
    const brid = bridge()
    if (brid === undefined) return
    const parsed = decodeCardValue(evt.action?.value) ?? {}
    const action = typeof parsed.action === 'string' ? parsed.action : ''
    const formValue = (evt.raw?.action?.form_value ?? {}) as Record<string, unknown>
    const sessionId = typeof formValue.session === 'string' ? formValue.session : ''

    if (action === 'list') {
      const sessions = await brid.listSessions()
      await channel.send(state.chat.chatId, { card: renderSessionListCard(sessions, getTranslations(), pinnedIds()) }, replyOpts(state.chat)).catch(() => undefined)
      return
    }
    if (action === 'refresh') {
      const sessions = await brid.listSessions()
      const key = conversationKey(state.chat)
      await channel.updateCard(evt.messageId!, renderSessionPanelCard(sessions, key, getTranslations(), pinnedIds())).catch((e: unknown) => {
        logger.warn(`dsh-feishu: session panel refresh failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      return
    }
    if (sessionId === '') return
    const sessions = await brid.listSessions()
    const entry = sessions.find(s => s.id === sessionId)
    const label = entry === undefined ? sessionId.slice(-12) : sessionLabel(entry)
    const op = action as Op
    if (op !== 'switch' && op !== 'detach' && op !== 'rename' && op !== 'fork' && op !== 'archive'
      && op !== 'pin' && op !== 'unpin') return

    if (op === 'pin' || op === 'unpin') {
      const registry = deps.workspaceRegistry
      const call = op === 'pin' ? registry?.pinSession : registry?.unpinSession
      if (call === undefined) {
        logger.warn(`dsh-feishu: session panel ${op} requested but the workspace registry exposes no ${op}Session`)
        return
      }
      const strings = getTranslations()
      try {
        // Bound to the registry: these are service methods, not free functions.
        await call.call(registry, sessionId)
        await channel.send(state.chat.chatId, {
          text: op === 'pin' ? strings.sessionResultPinned(label) : strings.sessionResultUnpinned(label),
        }, replyOpts(state.chat)).catch(() => undefined)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        // Pinning is refused for an archived session; name the blocking state
        // instead of a generic failure. Duck-typed by `name` because the Host may
        // hand us another copy of the class (key pitfall 28).
        const name = (error as { name?: string } | null)?.name
        logger.warn(`dsh-feishu: session ${op} failed: ${message}`)
        await channel.send(state.chat.chatId, {
          text: name === 'WorkspaceArchivedSessionPinError'
            ? strings.sessionResultPinArchived(label)
            : strings.sessionResultPinFailed(label),
        }, replyOpts(state.chat)).catch(() => undefined)
      }
      // Re-render the panel so the pin marks follow the registry.
      const after = await brid.listSessions()
      await channel.updateCard(evt.messageId!, renderSessionPanelCard(after, conversationKey(state.chat), getTranslations(), pinnedIds())).catch((e: unknown) => {
        logger.warn(`dsh-feishu: session panel refresh after ${op} failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      return
    }

    if (op === 'rename') {
      // Rename pops its own dedicated input card instead of a confirm card.
      await openRename(state.chat, { sessionId, sessionLabel: label })
      return
    }
    if (op === 'switch') {
      // Always confirm before switching — the chat is leaving its current
      // session and rebinding to another, so a stray tap could otherwise
      // silently drop the active conversation. The target may be free or
      // occupied; confirm covers both (see handleConfirm → execOp).
      await openConfirm(state.chat, { op: 'switch', sessionId, sessionLabel: label })
      return
    }
    await openConfirm(state.chat, { op, sessionId, sessionLabel: label })
  }

  const openRename = async (chat: ConversationMessage, state: Omit<RenameState, 'chat'>): Promise<void> => {
    const result = await channel.send(chat.chatId, { card: renderSessionRenameCard(state.sessionLabel, getTranslations()) }, replyOpts(chat))
    const mid = result?.messageId
    if (mid !== undefined) renameCards.set(mid, { chat, ...state })
  }

  const handleRename = async (evt: SessionCardEvent, state: RenameState): Promise<void> => {
    renameCards.delete(evt.messageId!)
    const formValue = (evt.raw?.action?.form_value ?? {}) as Record<string, unknown>
    const title = typeof formValue.new_title === 'string' ? formValue.new_title.trim() : ''
    if (title === '') {
      await channel.updateCard(evt.messageId!, renderSessionResultCard(getTranslations().sessionResultEmptyTitle, [getTranslations().sessionResultEmptyBody])).catch((e: unknown) => {
        logger.warn(`dsh-feishu: session rename title empty: ${e instanceof Error ? e.message : String(e)}`)
      })
      return
    }
    if (sessionController?.rename === undefined) {
      await channel.send(state.chat.chatId, { card: renderSessionResultCard(getTranslations().sessionResultUnavailable, [getTranslations().sessionResultUnavailableRename]) }, replyOpts(state.chat)).catch(() => undefined)
      return
    }
    try {
      await sessionController.rename({ sessionId: state.sessionId, title })
      await channel.send(state.chat.chatId, { card: renderSessionResultCard(getTranslations().sessionResultRenamedHeader, [`${getTranslations().sessionResultRenamedBody(state.sessionLabel)}\n\`\`\`\n${title}\n\`\`\``]) }, replyOpts(state.chat)).catch(() => undefined)
    } catch (e: unknown) {
      logger.error(`dsh-feishu: session rename failed: ${e instanceof Error ? e.message : String(e)}`)
      await channel.send(state.chat.chatId, { card: renderSessionResultCard(getTranslations().sessionResultRenameFailed, [String(e instanceof Error ? e.message : e)]) }, replyOpts(state.chat)).catch(() => undefined)
    }
  }

  const openConfirm = async (chat: ConversationMessage, state: Omit<ConfirmState, 'token' | 'chat'>): Promise<void> => {
    const token = `session-c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const st: ConfirmState = { token, chat, ...state }
    const result = await channel.send(chat.chatId, { card: renderSessionConfirmCard(st, getTranslations()) }, replyOpts(chat))
    const mid = result?.messageId
    if (mid !== undefined) confirmCards.set(mid, st)
  }

  const handleConfirm = async (evt: SessionCardEvent, state: ConfirmState): Promise<void> => {
    const parsed = decodeCardValue(evt.action?.value) ?? {}
    const confirm = parsed.action === 'confirm-ok'
    if (!confirm) {
      confirmCards.delete(evt.messageId!)
      await channel.updateCard(evt.messageId!, renderSessionResultCard(getTranslations().sessionResultCancelled, [getTranslations().sessionResultCancelledBody])).catch((e: unknown) => {
        logger.warn(`dsh-feishu: session cancel update failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      return
    }
    confirmCards.delete(evt.messageId!)
    await execOp(state.chat, {
      op: state.op,
      sessionId: state.sessionId,
      sessionLabel: state.sessionLabel,
      ...(state.stopActivity === undefined ? {} : { stopActivity: state.stopActivity }),
    })
  }

  const execOp = async (chat: ConversationMessage, st: { op: Op; sessionId: string; sessionLabel: string; stopActivity?: boolean }): Promise<void> => {
    const brid = bridge()
    if (brid === undefined) return
    try {
      if (st.op === 'switch') {
        const outcome = brid.attachSession(chat, st.sessionId)
        if (outcome === 'archived') {
          await channel.send(chat.chatId, { card: renderSessionResultCard(getTranslations().sessionResultArchivedHeader, [getTranslations().sessionResultArchivedSwitchBody(st.sessionLabel)]) }, replyOpts(chat)).catch(() => undefined)
          return
        }
        await channel.send(chat.chatId, { card: renderSessionResultCard(getTranslations().sessionResultSwitchedHeader, [getTranslations().sessionResultSwitchedBody(st.sessionLabel)]) }, replyOpts(chat)).catch(() => undefined)
        return
      }
      if (st.op === 'detach') {
        const outcome = brid.detachSession(st.sessionId)
        const line = outcome.kind === 'free'
          ? getTranslations().sessionResultDetachFree(st.sessionLabel)
          : getTranslations().sessionResultDetachReleased(st.sessionLabel, outcome.ownerLabel)
        await channel.send(chat.chatId, { card: renderSessionResultCard(getTranslations().sessionResultDetachHeader, [line]) }, replyOpts(chat)).catch(() => undefined)
        return
      }
      if (st.op === 'archive') {
        if (workspaceRegistry?.archiveSession === undefined) { await unsupported(chat, getTranslations().sessionOpArchive); return }
        try {
          // DSH 0.1.7 refuses to archive a Session that still has running work
          // (`WorkspaceActiveSessionError`) unless the caller passes
          // `{ stopActivity: true }`. We mirror the Web UI's "ask before you
          // stop": the first attempt never stops anything — if the session is
          // active we come back with a second card that names what would stop,
          // and only that card's confirm passes `stopActivity`.
          await workspaceRegistry.archiveSession(st.sessionId, st.stopActivity === true ? { stopActivity: true } : undefined)
        } catch (error: unknown) {
          const activity = st.stopActivity === true ? undefined : activeSessionActivity(error)
          if (activity === undefined) throw error
          logger.warn(`dsh-feishu: session ${st.sessionId} is still active (${activity.join(', ')}); asking before stopping it`)
          await openConfirm(chat, { op: 'archive', sessionId: st.sessionId, sessionLabel: st.sessionLabel, stopActivity: true, activity })
          return
        }
        await channel.send(chat.chatId, { card: renderSessionResultCard(getTranslations().sessionResultArchivedOk, [getTranslations().sessionResultArchivedBody(st.sessionLabel)]) }, replyOpts(chat)).catch(() => undefined)
        return
      }
      if (st.op === 'fork') {
        if (sessionController?.fork === undefined) { await unsupported(chat, getTranslations().sessionOpFork); return }
        const res = await sessionController.fork({ sessionId: st.sessionId }) as { sessionId?: string } | undefined
        await channel.send(chat.chatId, { card: renderSessionResultCard(getTranslations().sessionResultForkHeader, [getTranslations().sessionResultForkBody(st.sessionLabel, res?.sessionId)]) }, replyOpts(chat)).catch(() => undefined)
        return
      }
    } catch (e: unknown) {
      logger.error(`dsh-feishu: session op ${st.op} failed: ${e instanceof Error ? e.message : String(e)}`)
      await channel.send(chat.chatId, { card: renderSessionResultCard(getTranslations().sessionResultOpFailed, [String(e instanceof Error ? e.message : e)]) }, replyOpts(chat)).catch(() => undefined)
    }
  }

  const unsupported = async (chat: ConversationMessage, name: string): Promise<void> => {
    await channel.send(chat.chatId, { card: renderSessionResultCard(getTranslations().sessionResultUnavailable, [getTranslations().sessionResultUnsupported(name)]) }, replyOpts(chat)).catch(() => undefined)
  }

  const unsubscribe = channel.onCardAction(onCardAction)
  const open = async (chat: ConversationMessage): Promise<string | undefined> => {
    const brid = bridge()
    if (brid === undefined) return undefined
    const sessions = await brid.listSessions()
    const key = conversationKey(chat)
    const result = await channel.send(chat.chatId, { card: renderSessionPanelCard(sessions, key, getTranslations()) }, replyOpts(chat))
    const mid = result?.messageId
    if (mid !== undefined) openCards.set(mid, { chat })
    return mid
  }
  const stop = (): void => {
    unsubscribe()
    openCards.clear()
    confirmCards.clear()
  }
  return { open, stop }
}

/** Reply options for a chat (topic-aware). */
function replyOpts(chat: ConversationMessage): { replyInThread?: boolean; replyTo?: string } {
  return chat.threadId !== undefined
    ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
    : {}
}
