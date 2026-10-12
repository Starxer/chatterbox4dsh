/**
 * Feishu onboarding cards.
 *
 * 1. First-message onboarding: a chat (main chat or topic) that has no
 *    session history gets a card listing every persisted session (occupied
 *    ones carry a lock marker) plus a "create new" action, instead of
 *    silently auto-creating a session. Selecting an occupied session
 *    force-takes it over: the previous owner is released (reset to a fresh
 *    session) and the session is rebound to this chat.
 *
 * 2. `/new` card flow: workspace picker → agent preset picker → model
 *    picker (reusing the model-select cards) → session creation. The
 *    defaults come from the latest active session's settings when
 *    available, falling back to deployment-wide config.
 *
 * @module @starxer/chatterbox4dsh/feishu-onboarding
 */

import type { HarnessConversationService, ChatCreationOptions } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker'
import { mkdir, opendir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createCardSuperseder, type SupersedeChannel } from './card-supersede.ts'
import { createCardTopicRegistry, type CardTopicRegistry } from './card-topics.ts'

/** Minimal logger surface. */
interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Source of the current bridge — recreated on every channel reconcile. */
interface BridgeHolder {
  current: HarnessConversationService | undefined
}

/** Subset of the cardAction event the onboarding cards consume. */
interface CardActionLike {
  messageId?: string
  chatId?: string
  operator?: { openId?: string }
  action?: { value?: unknown; tag?: string; option?: string }
  raw?: { action?: { value?: unknown; tag?: string; option?: string; form_value?: Record<string, unknown> } }
}

/**
 * Channel adapter — same surface as feishu-model-select.ts.
 *
 * Only the card-instance send path is used: every flow step posts a NEW card
 * (see {@link startFeishuOnboarding}'s `sendCard`), because in-place updates
 * stop delivering button callbacks after a couple of edits.
 */
export interface OnboardingChannel extends SupersedeChannel {
  onCardAction(handler: (evt: CardActionLike) => void | Promise<void>): () => void
  createCardInstance(card: object): Promise<string>
  sendCardByReference(to: string, cardId: string, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
}

/** Narrow workspace registry view. */
interface WorkspaceLike {
  path: string
  name?: string
}

/** Workspace registry surface the onboarding flow needs: list existing
 *  workspaces and create new ones by path. */
interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
  create(path: string, title?: string): Promise<unknown>
}

/**
 * Narrow view of DSH's `ctx.directoryPicker` browse capability. The service is
 * read lazily (see {@link FeishuOnboardingDeps.getDirectoryPicker}) because the
 * `directory-picker-auto` row mounts its backend asynchronously during boot —
 * a plain `ctx.get` at apply time may still be undefined. Only the `browse`
 * backend carries `list`/`createDirectory`; a `native` backend renders an OS
 * chooser on the host display, which is useless for a remote Feishu user, so
 * the browse affordance is hidden unless the kind matches.
 */
export interface DirectoryPickerLike {
  capability(): {
    kind: string
    list?(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
    createDirectory?(path: string, name: string): Promise<string>
  }
}

/** Narrow agentPresets view. */
interface AgentPresetsLike {
  list(): Promise<Array<{ id: string; title?: string }>>
  defaultId: string
}

/**
 * The `/new` flow's per-chat state, filled in one step at a time.
 *
 * Nothing here has happened in the world yet: the workspace is only REGISTERED
 * (and, for a path that did not exist, created) at the very last step, so
 * cancelling the flow leaves nothing behind (关键坑 O19).
 */
export interface NewSessionFlowState {
  /** Chosen workspace path. A `~` was already expanded by the form. */
  workspace?: string
  agentPreset?: string
  /**
   * The chosen workspace does not exist yet and the operator confirmed on the
   * "create it?" card that it should be. The final step runs `mkdir -p` before
   * registering it (O16).
   */
  workspaceMissing?: boolean
}

/** Narrow agentDefaultModel view. */
interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

/** Deployment-wide config fallbacks for the `/new` flow. */
export interface OnboardingConfig {
  workspace: string | undefined
  agentPreset: string | undefined
  provider: string | undefined
  model: string | undefined
}

export interface FeishuOnboardingDeps {
  bridgeHolder: BridgeHolder
  channel: OnboardingChannel
  logger: PluginLogger
  workspaceRegistry: WorkspaceRegistryLike
  agentPresets: AgentPresetsLike
  agentDefaultModel: AgentDefaultModelLike
  config: OnboardingConfig
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
  /**
   * Lazily read DSH's `directoryPicker` service. Absent (or a non-`browse`
   * capability) hides the folder-browsing affordance; the manual path form
   * keeps working either way.
   */
  getDirectoryPicker?: () => DirectoryPickerLike | undefined
  /** Advance the `/new` flow to the model step. The caller renders the
   *  model-select provider card (reusing feishu-model-select with flow
   *  `new-session`); the model-select handle's onNewSessionConfirm callback
   *  then commits the selection to session creation. */
  onModelStep: (chatMessage: ConversationMessage, messageId: string | undefined, flowState: NewSessionFlowState) => Promise<void>
  /**
   * Shared `messageId → topic` registry (see `card-topics.ts`). The caller
   * passes the same instance to the model-select flow so a card sent by one
   * module and clicked in another still resolves to its own topic. Omitted in
   * tests, which get a private one.
   */
  cardTopics?: CardTopicRegistry
}

/** A queued onboarding card action. */
interface QueuedAction {
  kind:
    | 'attach' | 'new' | 'pick-workspace' | 'pick-preset' | 'create-workspace' | 'cancel'
    | 'create-workspace-confirm' | 'workspace-back'
    | 'browse-open' | 'browse-enter' | 'browse-home' | 'browse-hidden' | 'browse-page'
    | 'browse-pick' | 'browse-back' | 'browse-mkdir'
  chatMessage: ConversationMessage
  messageId: string | undefined
  sessionId?: string
  value?: string
}

/** Parse the onboarding card action value (same JSON unwrap as model-select). */
function parseOnboardingAction(evt: CardActionLike): QueuedAction | undefined {
  // --- Form submission: attach form (session dropdown) / workspace form ---
  const formValue = evt.raw?.action?.form_value
  if (formValue !== undefined) {
    const raw = evt.action?.value
    let valueObj: Record<string, unknown> | undefined
    if (typeof raw === 'string') {
      try {
        let result: unknown = JSON.parse(raw)
        let depth = 0
        while (typeof result === 'string' && depth < 4) {
          try { result = JSON.parse(result) } catch { break }
          depth++
        }
        if (typeof result === 'object' && result !== null) valueObj = result as Record<string, unknown>
      } catch { /* not JSON */ }
    } else if (typeof raw === 'object' && raw !== null) {
      valueObj = raw as Record<string, unknown>
    }
    const kind = valueObj !== undefined && typeof valueObj.kind === 'string' ? valueObj.kind : undefined
    const chatId = evt.chatId
    if (chatId === undefined) return undefined
    const chatMessage: ConversationMessage = { chatId, chatType: 'p2p' }
    if (kind === 'attach') {
      const sessionId = typeof formValue.session === 'string' && formValue.session !== '' ? formValue.session : undefined
      if (sessionId !== undefined) return { kind: 'attach', chatMessage, messageId: evt.messageId, sessionId }
      return undefined
    }
    if (kind === 'create-workspace') {
      const path = typeof formValue.workspace_path === 'string' && formValue.workspace_path.trim() !== ''
        ? formValue.workspace_path.trim()
        : undefined
      if (path !== undefined) return { kind: 'create-workspace', chatMessage, messageId: evt.messageId, value: path }
      return undefined
    }
    if (kind === 'pick-workspace') {
      // Submitted by the workspace dropdown's "use this workspace" button.
      const path = typeof formValue.workspace === 'string' && formValue.workspace.trim() !== ''
        ? formValue.workspace.trim()
        : undefined
      if (path !== undefined) return { kind: 'pick-workspace', chatMessage, messageId: evt.messageId, value: path }
      return undefined
    }
    if (kind === 'browse-mkdir') {
      // Submitted by the folder browser's "new folder" form: one path segment.
      const name = typeof formValue.new_folder === 'string' ? formValue.new_folder.trim() : ''
      if (name !== '') return { kind: 'browse-mkdir', chatMessage, messageId: evt.messageId, value: name }
      return undefined
    }
    return undefined
  }

  const raw = evt.action?.value
  let valueObj: Record<string, unknown> | undefined
  if (typeof raw === 'string') {
    try {
      let result: unknown = JSON.parse(raw)
      let depth = 0
      while (typeof result === 'string' && depth < 4) {
        try { result = JSON.parse(result) } catch { break }
        depth++
      }
      if (typeof result === 'object' && result !== null) valueObj = result as Record<string, unknown>
    } catch { /* not JSON */ }
  } else if (typeof raw === 'object' && raw !== null) {
    valueObj = raw as Record<string, unknown>
  }
  if (valueObj === undefined) return undefined
  const kind = typeof valueObj.kind === 'string' ? valueObj.kind : undefined
  const sessionId = typeof valueObj.sessionId === 'string' ? valueObj.sessionId : undefined
  const value = typeof valueObj.value === 'string' ? valueObj.value : undefined
  const chatId = evt.chatId
  if (chatId === undefined) return undefined
  const chatMessage: ConversationMessage = { chatId, chatType: 'p2p' }
  if (kind === 'attach' && sessionId !== undefined) return { kind: 'attach', chatMessage, messageId: evt.messageId, sessionId }
  if (kind === 'new') return { kind: 'new', chatMessage, messageId: evt.messageId }
  if (kind === 'pick-workspace' && value !== undefined) return { kind: 'pick-workspace', chatMessage, messageId: evt.messageId, value }
  if (kind === 'pick-preset' && value !== undefined) return { kind: 'pick-preset', chatMessage, messageId: evt.messageId, value }
  if (kind === 'cancel') return { kind: 'cancel', chatMessage, messageId: evt.messageId }
  if (kind === 'browse-open') return { kind: 'browse-open', chatMessage, messageId: evt.messageId }
  if (kind === 'browse-enter' && value !== undefined) return { kind: 'browse-enter', chatMessage, messageId: evt.messageId, value }
  if (kind === 'browse-home') return { kind: 'browse-home', chatMessage, messageId: evt.messageId }
  if (kind === 'browse-hidden') return { kind: 'browse-hidden', chatMessage, messageId: evt.messageId }
  if (kind === 'browse-page' && value !== undefined) return { kind: 'browse-page', chatMessage, messageId: evt.messageId, value }
  if (kind === 'browse-pick' && value !== undefined) return { kind: 'browse-pick', chatMessage, messageId: evt.messageId, value }
  if (kind === 'browse-back') return { kind: 'browse-back', chatMessage, messageId: evt.messageId }
  if (kind === 'create-workspace-confirm' && value !== undefined) {
    return { kind: 'create-workspace-confirm', chatMessage, messageId: evt.messageId, value }
  }
  if (kind === 'workspace-back') return { kind: 'workspace-back', chatMessage, messageId: evt.messageId }
  return undefined
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

/** First-message onboarding card: attach a persisted session or create new. */
function renderOnboardingCard(
  sessions: Array<{ id: string; title: string; ownedBy?: string }>,
  describeChatKey: (key: string) => string,
  threadLabel: string,
  t: Translations,
): object {
  const sessionOptions = sessions.map((session, index) => {
    const title = session.title === '' ? t.onboardingSessionFallback(index + 1, session.id.slice(-12)) : session.title.replace(/\s+/g, ' ').slice(0, 40)
    const lock = session.ownedBy === undefined ? '' : t.onboardingInUse(describeChatKey(session.ownedBy))
    return {
      text: { tag: 'plain_text', content: `📎 ${title}${lock}` },
      value: session.id,
    }
  })
  const formElements: object[] = []
  if (sessions.length === 0) {
    formElements.push({
      tag: 'markdown',
      content: t.onboardingNoSessions,
    })
  } else {
    formElements.push(
      { tag: 'markdown', content: t.onboardingPickExisting },
      {
        tag: 'select_static',
        name: 'session',
        placeholder: { tag: 'plain_text', content: t.onboardingSelectPlaceholder },
        options: sessionOptions,
        value: sessions[0]!.id,
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t.onboardingAttachButton },
        type: 'primary',
        name: 'attach',
        form_action_type: 'submit',
        behaviors: [{ type: 'callback', value: { kind: 'attach' } }],
      },
    )
  }
  formElements.push({ tag: 'hr' })
  formElements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.onboardingNewButton },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { kind: 'new' } }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingAttachTitle },
      template: 'turquoise',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: t.onboardingIntro(threadLabel),
        },
        { tag: 'hr' },
        { tag: 'form', name: 'onboarding_attach_form', elements: formElements },
      ],
    },
  }
}

/**
 * One workspace as a borderless clickable row — the same `interactive_container`
 * shape the folder browser uses.
 *
 * A `select_static` option is a single clipped line, so a long path there is
 * unreadable no matter how it is shortened. As a clickable row the path is
 * markdown (wraps, never elided) and the whole row is the pick target, so no
 * "select then submit" step is needed. The current workspace gets a ✅.
 */
function workspaceRow(workspace: WorkspaceLike, currentWorkspace: string | undefined): object {
  const mark = workspace.path === currentWorkspace ? ' ✅' : ''
  const name = workspace.name !== undefined && workspace.name !== '' ? workspace.name : undefined
  const content = name === undefined
    ? `📁 \`${workspace.path}\`${mark}`
    : `📁 **${name}**\n\`${workspace.path}\`${mark}`
  return {
    tag: 'interactive_container',
    width: 'fill',
    has_border: false,
    padding: '4px 12px 4px 12px',
    behaviors: [{ type: 'callback', value: { kind: 'pick-workspace', value: workspace.path } }],
    elements: [{ tag: 'markdown', content }],
  }
}

/** Workspace picker card (step 1 of /new): pick an existing workspace with one
 *  tap, or create a new one by absolute path or a `~`-relative path.
 *
 *  Existing workspaces render as clickable rows (`interactive_container`, same
 *  as the folder browser) — the earlier numbered dropdown needed two steps
 *  (choose a number, then submit) and its options clipped long paths. The
 *  manual-path input and its create button stay in their own form; a form
 *  submit button must belong to its container. */
function renderWorkspacePicker(workspaces: readonly WorkspaceLike[], currentWorkspace: string | undefined, t: Translations): object {
  const elements: object[] = [
    { tag: 'markdown', content: t.onboardingWorkspaceHeader },
    { tag: 'hr' },
  ]
  if (workspaces.length === 0) {
    elements.push({ tag: 'markdown', content: t.onboardingNoWorkspaces })
  } else {
    for (const workspace of workspaces) elements.push(workspaceRow(workspace, currentWorkspace))
  }
  elements.push({ tag: 'hr' })
  elements.push({ tag: 'markdown', content: t.onboardingNewWorkspaceHeader })
  elements.push({
    tag: 'form',
    name: 'onboarding_workspace_form',
    elements: [
      {
        tag: 'input',
        name: 'workspace_path',
        placeholder: { tag: 'plain_text', content: t.onboardingWorkspacePlaceholder },
        value: { tag: 'plain_text', content: '' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t.onboardingCreateWorkspaceButton },
        type: 'primary',
        name: 'create_ws',
        form_action_type: 'submit',
        behaviors: [{ type: 'callback', value: { kind: 'create-workspace' } }],
      },
    ],
  })
  // Folder browsing — the only way to reach a path the operator cannot recall
  // while away from the host. Backed by DSH's `browse` capability when it is
  // mounted, otherwise by the plugin's own read-only listing.
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.onboardingBrowseButton },
    type: 'default',
    behaviors: [{ type: 'callback', value: { kind: 'browse-open' } }],
  })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: `← ${t.cancel}` },
    type: 'default',
    behaviors: [{ type: 'callback', value: { kind: 'cancel' } }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingNewTitle },
      template: 'blue',
    },
    body: { elements },
  }
}

/** Entries per browser page. One card element per entry keeps the card far
 *  below Feishu's component (200) and 30 KB body limits; larger levels page.
 *  Sized generously (30) because every navigation step posts a NEW card —
 *  fewer pages means fewer messages left in the chat. */
const BROWSE_PAGE_SIZE = 30

/** Complete-result bound of one listing level, mirroring the DSH browse
 *  backend's default so a huge directory never materializes unbounded. */
const BROWSE_MAX_ENTRIES = 1000

/**
 * Read-only one-level directory listing used when DSH's `directoryPicker`
 * cannot serve a remote operator.
 *
 * `directory-picker-auto` resolves to the `native` backend whenever the host
 * looks attended (loopback bind, no SSH, a display session, a chooser binary
 * on PATH) — the common case for a workstation running `dsh web` locally.
 * That backend opens an OS chooser on the host display, which is useless for
 * someone driving the agent from Feishu, so the plugin lists the filesystem
 * itself with the same shape the `browse` backend reports: absolute child
 * directories, name-sorted, each flagged hidden by the dot convention, plus
 * the ancestor chain the card renders as breadcrumbs.
 *
 * @param path - absolute directory to list; absent lists the home directory.
 */
async function listDirectoryLocally(path?: string): Promise<DirectoryListing> {
  const home = homedir()
  const target = path === undefined ? home : resolve(path)
  const entries: DirectoryEntry[] = []
  const handle = await opendir(target)
  for await (const dirent of handle) {
    let isDirectory = dirent.isDirectory()
    if (!isDirectory && dirent.isSymbolicLink()) {
      // A symlink counts as a row only when it resolves to a directory.
      try {
        isDirectory = (await stat(join(target, dirent.name))).isDirectory()
      } catch {
        isDirectory = false
      }
    }
    if (!isDirectory) continue
    entries.push({
      name: dirent.name,
      path: join(target, dirent.name),
      hidden: dirent.name.startsWith('.'),
    })
    if (entries.length > BROWSE_MAX_ENTRIES) break
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const truncated = entries.length > BROWSE_MAX_ENTRIES
  const crumbs: DirectoryEntry[] = []
  for (let current = target; ;) {
    const parent = dirname(current)
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) break
    current = parent
  }
  return {
    path: target,
    home,
    crumbs,
    entries: truncated ? entries.slice(0, BROWSE_MAX_ENTRIES) : entries,
    truncated,
  }
}

/** Per-chat folder-browser position. */
interface BrowseState {
  /** Absolute path of the level currently listed. */
  path: string
  /** Whether dot-prefixed entries are shown. */
  hidden: boolean
  /** 0-based page index within the filtered entry list. */
  page: number
}

/** One browser entry as a borderless, fully clickable row.
 *
 *  Card 2.0's `interactive_container` is a whole clickable region ("适合卡片内
 *  的列表项"): it carries `behaviors` like a button but renders its child
 *  markdown, so the entry looks like a list row instead of a button and its
 *  name is never elided. A plain button could not do this — buttons inside a
 *  `column_set` ignore `width: 'fill'`, and one full-width button per row adds
 *  button chrome around every name. */
function browseEntryRow(entry: DirectoryEntry, kind: 'browse-enter' | 'browse-pick' = 'browse-enter'): object {
  return {
    tag: 'interactive_container',
    width: 'fill',
    has_border: false,
    padding: '4px 12px 4px 12px',
    behaviors: [{ type: 'callback', value: { kind, value: entry.path } }],
    elements: [{ tag: 'markdown', content: `📁 ${entry.name}` }],
  }
}

/** A plain card button (navigation controls, pager). */
function controlButton(label: string, value: unknown, type: 'default' | 'primary' = 'default'): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value }],
  }
}

/** Lay a handful of short control buttons out in one row.
 *
 *  `width: 'auto'` columns hug their button, and `flex_mode: 'stretch'` makes
 *  Feishu stack them vertically on a narrow (mobile) screen instead of
 *  squeezing them until the labels clip — `none` compressed the three top
 *  controls until they were unreadable on a phone. Folder names never go
 *  through this path — each entry is its own full-width `interactive_container`
 *  row. */
function buttonRow(buttons: readonly object[]): object {
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    horizontal_spacing: 'small',
    columns: buttons.map(button => ({
      tag: 'column',
      width: 'auto',
      vertical_align: 'top',
      elements: [button],
    })),
  }
}

/** Folder-browser card: navigate levels, toggle hidden entries, page a large
 *  level, create a folder in this level (when the mounted backend can), and pick
 *  the listed directory as the new session's workspace.
 *
 *  Every entry is a borderless `interactive_container` row, so the list is
 *  directly clickable, looks like text rather than buttons, and never elides a
 *  name. Short control labels (up / home / hidden / pager) share an auto-width
 *  row. */
function renderWorkspaceBrowser(
  state: BrowseState,
  listing: DirectoryListing,
  t: Translations,
  options?: { notice?: string },
): object {
  const visible = listing.entries.filter(entry => state.hidden || !entry.hidden)
  const totalPages = Math.max(1, Math.ceil(visible.length / BROWSE_PAGE_SIZE))
  const page = Math.min(Math.max(state.page, 0), totalPages - 1)
  const slice = visible.slice(page * BROWSE_PAGE_SIZE, page * BROWSE_PAGE_SIZE + BROWSE_PAGE_SIZE)
  // crumbs is root→current inclusive, so the second-to-last crumb is the parent.
  const parent = listing.crumbs.length >= 2 ? listing.crumbs[listing.crumbs.length - 2] : undefined

  const elements: object[] = [
    { tag: 'markdown', content: t.onboardingBrowseHeader(listing.path) },
  ]
  // A failed action reports ON the browser it happened on, so the level stays
  // visible and the operator can retry without re-navigating.
  if (options?.notice !== undefined && options.notice !== '') {
    elements.push({ tag: 'markdown', content: options.notice })
  }
  elements.push({ tag: 'hr' })
  // Up / home / hidden are a handful of short labels, so one row always fits.
  const controls: object[] = []
  if (parent !== undefined) {
    controls.push(controlButton(t.onboardingBrowseUp, { kind: 'browse-enter', value: parent.path }))
  }
  if (listing.path !== listing.home) {
    controls.push(controlButton(t.onboardingBrowseHome, { kind: 'browse-home' }))
  }
  controls.push(controlButton(
    state.hidden ? t.onboardingBrowseHideHidden : t.onboardingBrowseShowHidden,
    { kind: 'browse-hidden' },
  ))
  elements.push(buttonRow(controls))
  elements.push({ tag: 'hr' })

  if (slice.length === 0) {
    elements.push({ tag: 'markdown', content: t.onboardingBrowseEmpty })
  } else {
    for (const entry of slice) elements.push(browseEntryRow(entry))
  }

  if (totalPages > 1) {
    elements.push({ tag: 'markdown', content: t.onboardingBrowsePage(page + 1, totalPages) })
    const pager: object[] = []
    if (page > 0) {
      pager.push(controlButton(t.onboardingBrowsePrev, { kind: 'browse-page', value: String(page - 1) }))
    }
    if (page < totalPages - 1) {
      pager.push(controlButton(t.onboardingBrowseNext, { kind: 'browse-page', value: String(page + 1) }))
    }
    elements.push(buttonRow(pager))
  }
  if (listing.truncated) {
    elements.push({ tag: 'markdown', content: t.onboardingBrowseTruncated })
  }

  // Create a folder in THIS level. No gate: `resolveDirectoryCreator` uses DSH's
  // `browse` backend when it is mounted and the plugin's own `mkdir` otherwise,
  // so the button works whatever the mounted CHOOSER is (the `native` one only
  // means the OS dialog is unavailable — not that the filesystem is read-only).
  // The form shape is the one the workspace picker already proved: `input` +
  // a `form_action_type: 'submit'` button, no label field (a card input cannot
  // be prefilled and has no completion — docs/feishu-capabilities.md §2.2.2).
  elements.push({
    tag: 'form',
    name: 'browse_new_folder',
      elements: [
        {
          tag: 'input',
          name: 'new_folder',
          placeholder: { tag: 'plain_text', content: t.onboardingBrowseNewFolderPlaceholder },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t.onboardingBrowseNewFolder },
          type: 'default',
          name: 'mkdir',
          form_action_type: 'submit',
        behaviors: [{ type: 'callback', value: { kind: 'browse-mkdir' } }],
      },
    ],
  })

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.onboardingBrowsePick },
    type: 'primary',
    width: 'fill',
    behaviors: [{ type: 'callback', value: { kind: 'browse-pick', value: listing.path } }],
  })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.onboardingBrowseBack },
    type: 'default',
    width: 'fill',
    behaviors: [{ type: 'callback', value: { kind: 'browse-back' } }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingBrowseTitle },
      template: 'blue',
    },
    body: { elements },
  }
}

/** How many "next door" rows the missing-path card offers. */
const BROWSE_SIBLING_LIMIT = 8

/** Does `path` exist, and is it a directory?
 *
 *  Only `ENOENT` means "it is not there": anything else (a permission problem,
 *  a broken symlink on the way) is rethrown so the operator gets the real
 *  message instead of a guess. */
async function inspectDirectory(path: string): Promise<{ exists: boolean; isDirectory: boolean }> {
  try {
    const info = await stat(path)
    return { exists: true, isDirectory: info.isDirectory() }
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { exists: false, isDirectory: false }
    }
    throw error
  }
}

/** The child directories of one level, sorted, hidden ones excluded. */
async function listChildDirectories(dir: string): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = []
  try {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
      entries.push({ name: dirent.name, path: join(dir, dirent.name), hidden: false })
    }
  } catch {
    return []
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries.slice(0, BROWSE_SIBLING_LIMIT)
}

/**
 * The child directories of the deepest ancestor of `path` that exists.
 *
 * This is the cheap stand-in for path completion: a card input cannot complete
 * as the operator types — no candidate field, and Feishu sends no keystroke
 * events (`docs/feishu-capabilities.md` §2.2.2) — so the "that path does not
 * exist" card shows what is actually next door, and one tap commits the right
 * directory instead of retyping the whole path.
 */
async function siblingDirectories(path: string): Promise<DirectoryEntry[]> {
  let dir = dirname(path)
  for (let hops = 0; hops < 32; hops += 1) {
    const parent = dirname(dir)
    try {
      if ((await stat(dir)).isDirectory()) return await listChildDirectories(dir)
    } catch {
      // Not there (or not readable): keep walking up.
    }
    if (parent === dir) return []
    dir = parent
  }
  return []
}

/**
 * "That path does not exist — create it, or use one of its neighbours?"
 *
 * The rows are the SAME clickable rows the browser uses, but they commit the
 * directory (`browse-pick`) instead of navigating into it, so a typo is one tap
 * to fix. This card creates nothing: the confirm button only records the
 * intent, and the directory itself appears at the last step.
 */
function renderNewWorkspaceConfirmCard(path: string, siblings: readonly DirectoryEntry[], t: Translations): object {
  const elements: object[] = [{ tag: 'markdown', content: t.onboardingCreateWorkspaceConfirmBody(path) }]
  if (siblings.length > 0) {
    elements.push({ tag: 'markdown', content: t.onboardingCreateWorkspaceSiblingHeader(dirname(path)) })
    for (const entry of siblings) elements.push(browseEntryRow(entry, 'browse-pick'))
  }
  elements.push({ tag: 'hr' })
  elements.push(controlButton(
    t.onboardingCreateWorkspaceConfirmButton,
    { kind: 'create-workspace-confirm', value: path },
    'primary',
  ))
  elements.push(controlButton(t.onboardingCreateWorkspaceBackButton, { kind: 'workspace-back' }))
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.onboardingCreateWorkspaceConfirmTitle }, template: 'orange' },
    body: { elements },
  }
}

/** Turn a `createDirectory` failure into something the operator can act on: the
 *  backend's own messages are English and code-shaped. */
function describeCreateFailure(name: string, message: string, t: Translations): string {
  if (/already exists|EEXIST/u.test(message)) return t.onboardingBrowseNewFolderExists(name)
  if (/single path segment|fully qualified/u.test(message)) return t.onboardingBrowseNewFolderInvalid(name)
  return t.onboardingBrowseNewFolderFailed(message)
}

/** Agent preset picker card (step 2 of /new). */
function renderPresetPicker(presets: readonly { id: string; name?: string }[], currentPreset: string | undefined, t: Translations): object {
  const elements: object[] = [
    { tag: 'markdown', content: t.onboardingPresetHeader },
    { tag: 'hr' },
  ]
  if (presets.length === 0) {
    elements.push({ tag: 'markdown', content: t.onboardingNoPresets })
  }
  for (const preset of presets) {
    const label = preset.name !== undefined && preset.name !== '' ? preset.name : preset.id
    const mark = preset.id === currentPreset ? ' ✅' : ''
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `🧩 ${label}${mark}` },
      type: preset.id === currentPreset ? 'primary' : 'default',
      behaviors: [{ type: 'callback', value: { kind: 'pick-preset', value: preset.id } }],
    })
  }
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: `← ${t.cancel}` },
    type: 'default',
    behaviors: [{ type: 'callback', value: { kind: 'cancel' } }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingNewTitle },
      template: 'blue',
    },
    body: { elements },
  }
}

/** Session-created success card. */
function renderCreatedCard(sessionId: string, summary: string, t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingCreatedTitle },
      template: 'green',
    },
    body: {
      elements: [
        { tag: 'markdown', content: t.onboardingCreatedBody(sessionId, summary) },
      ],
    },
  }
}

/** Attach success card. */
function renderAttachedCard(sessionId: string, ownerLabel: string | undefined, t: Translations): object {
  const takeover = ownerLabel === undefined ? '' : t.onboardingTakeover(ownerLabel)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingAttachedTitle },
      template: 'green',
    },
    body: {
      elements: [
        { tag: 'markdown', content: t.onboardingAttachedBody(sessionId, takeover) },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface FeishuOnboardingHandle {
  dispose(): void
  /** Send the first-message onboarding card (attach or create). */
  sendOnboardingCard(chatMessage: ConversationMessage, threadLabel: string): Promise<void>
  /** Start the `/new` card flow: workspace → preset → model → create. */
  startNewFlow(chatMessage: ConversationMessage): Promise<void>
  /** The workspace/preset captured so far by this chat's `/new` flow. */
  creationOptionsFor(chatId: string): NewSessionFlowState
  /** Topic reply context recorded for a chat (rootId/threadId), so the
   *  model-step card sent by the caller lands in the same topic. */
  topicFor(chatId: string): { rootId?: string; threadId?: string }
  /** Record topic context from an inbound message (e.g. a slash command in a
   *  topic) so later card actions from that chat recover their thread key. */
  noteTopic(chatMessage: ConversationMessage): void
  /**
   * Repaint this chat's last onboarding card. Used by the caller when it posts
   * the model card (which is rendered by feishu-model-select, not by this
   * module) so the preset card does not keep showing live-looking buttons.
   *
   * @param options - same shape as the internal superseder: `keep` freezes the
   *   card with its content (optionally with a settled note), `notice` replaces
   *   it with the bare stale notice.
   */
  supersedePrevious(chatId: string, options?: { mode?: 'keep' | 'notice'; note?: string }): Promise<void>
}

export function startFeishuOnboarding(deps: FeishuOnboardingDeps): FeishuOnboardingHandle {
  const { bridgeHolder, channel, logger, workspaceRegistry, agentPresets, agentDefaultModel, config, getTranslations, onModelStep, getDirectoryPicker } = deps
  const cardTopics = deps.cardTopics ?? createCardTopicRegistry()

  /** Per-chat in-flight `/new` flow state. */
  const newFlow = new Map<string, NewSessionFlowState>()
  /** Per-chat folder-browser position (kept only while the browser is open). */
  const browseState = new Map<string, BrowseState>()
  /** Topic reply context per chat, so cards sent from button callbacks land
   *  in the same Feishu topic the user clicked from. Keyed by chatId. */
  const chatTopic = new Map<string, { rootId?: string; threadId?: string }>()
  /** Monotonic CardKit sequence per card instance, shared with the superseder
   *  so a stale-card repaint never reuses a number. */
  const sequenceByCard = new Map<string, number>()
  const superseder = createCardSuperseder({ channel, logger, getTranslations, sequenceByCard })

  /** The topic a card for `chatMessage` must be sent into: the message's own
   *  coordinates when it has them, else this chat's last recorded topic. */
  function topicOf(chatMessage: ConversationMessage): { rootId?: string; threadId?: string } {
    const known = chatTopic.get(chatMessage.chatId)
    const rootId = chatMessage.rootId ?? known?.rootId
    const threadId = chatMessage.threadId ?? known?.threadId
    if (threadId === undefined || rootId === undefined) return {}
    return { rootId, threadId }
  }

  /** Reply options that land a send inside `topic`; `{}` when it has none. */
  function replyOpts(topic: { rootId?: string; threadId?: string }): { replyInThread?: boolean; replyTo?: string } {
    return topic.rootId === undefined ? {} : { replyInThread: true, replyTo: topic.rootId }
  }

  /** Record topic context from an inbound chat message (first message or
   *  slash command) so later card callbacks keep replying in-topic. */
  function recordTopic(chatMessage: ConversationMessage): void {
    if (chatMessage.threadId === undefined) return
    chatTopic.set(chatMessage.chatId, {
      ...(chatMessage.rootId !== undefined ? { rootId: chatMessage.rootId } : {}),
      threadId: chatMessage.threadId,
    })
  }

  /**
   * Send one flow card as a NEW message.
   *
   * Every step deliberately sends a fresh card instead of editing the previous
   * one. Feishu stops delivering button callbacks on a card after only a
   * couple of in-place edits — this is true for `im.v1.message.patch` *and*
   * for CardKit card instances, so the folder browser died after a few pages
   * even though it used `cardkit.v1.card.update`. The repository learned this
   * once already in the V1 model selector (`feishu-model-select.ts`), whose
   * fix was exactly this: one fresh card per navigation step, old cards left
   * in the chat (the operator prefers that to a recalled card).
   *
   * Once the new card is posted, the previous card for this chat is repainted
   * as a stale-card notice so its now-dead buttons are visibly retired.
   *
   * @param terminal - true for a result/error card that ends a flow; it is not
   *   remembered, so a later flow will not repaint it.
   * @param navigation - true for a pure navigation card (a folder-browser page
   *   or "up one level"). Such a card, and the page it replaces, collapse to
   *   the bare notice — unless the operator settles on that very page, whose
   *   `settlePrevious` freezes it instead.
   * @param settlePrevious - set when the card being retired is the one the
   *   operator just used to COMMIT a value (picking a workspace, confirming a
   *   directory). It is frozen on screen with that value and stops being
   *   editable — the readable record of the decision.
   */
  async function sendCard(
    chatMessage: ConversationMessage,
    card: object,
    options?: { terminal?: boolean; navigation?: boolean; settlePrevious?: string },
  ): Promise<void> {
    const topic = topicOf(chatMessage)
    const cardId = await channel.createCardInstance(card)
    const result = await channel.sendCardByReference(chatMessage.chatId, cardId, replyOpts(topic))
    // Remember which topic THIS card went into, keyed by its message id: the
    // click that comes back for it carries no thread, and the per-chat map
    // cannot tell two topics of the same group apart (see `card-topics.ts`).
    cardTopics.note(result.messageId, topic)
    // Repaint the previous card only AFTER the new one is on screen, and
    // before remembering the new card (supersedePrevious consumes the note).
    const t = getTranslations()
    await superseder.supersedePrevious(chatMessage.chatId, options?.settlePrevious !== undefined
      ? { mode: 'keep', note: t.cardSettledNote(options.settlePrevious) }
      : options?.navigation === true ? { mode: 'notice' } : {})
    if (options?.terminal === true) {
      superseder.forget(chatMessage.chatId)
      return
    }
    superseder.note(chatMessage.chatId, {
      cardId,
      messageId: result.messageId,
      // Always remember the payload: this card can be the one the operator
      // settles on (a folder page's "✅ 用这个目录"), and only a remembered
      // payload can be frozen on screen afterwards. `navigation` alone decides
      // that an un-settled page collapses to the bare notice.
      card,
      ...(options?.navigation === true ? { navigation: true } : {}),
    })
  }

  /** Build the workspace picker with the default = deployment config. */
  async function buildWorkspacePicker(_chatMessage: ConversationMessage): Promise<object> {
    return renderWorkspacePicker(workspaceRegistry.list(), config.workspace, getTranslations())
  }

  /**
   * A one-level directory lister. DSH's `browse` capability is preferred when
   * it is the mounted backend; the `native` backend (an OS chooser on the host
   * display) and a deployment without the service both fall back to the
   * plugin's own read-only listing, because neither can serve a remote user.
   */
  function resolveDirectoryLister(): (path?: string) => Promise<DirectoryListing> {
    const picker = getDirectoryPicker?.()
    const capability = picker?.capability()
    if (capability !== undefined && capability.kind === 'browse' && capability.list !== undefined) {
      const list = capability.list
      return (path?: string) => list.call(capability, path)
    }
    return (path?: string) => listDirectoryLocally(path)
  }

  /**
   * How to create a child folder of the level being browsed.
   *
   * DSH's `browse` backend owns `createDirectory` (single segment, non-recursive,
   * `directory-exists`), so it is used when it is mounted. The `native` backend
   * (an OS chooser on the host display) has no such method — but that says
   * something about the CHOOSER, not about the filesystem: this plugin already
   * lists levels itself when `browse` is absent ({@link resolveDirectoryLister})
   * and already creates directories itself for the `/new` flow, so hiding the
   * button there only removed the feature (reported 2026-10-12 on a host whose
   * `DISPLAY` is set). The fallback mirrors the backend's contract exactly: one
   * non-blank path segment, non-recursive `mkdir`, `EEXIST` = "already there".
   */
  function resolveDirectoryCreator(): (path: string, name: string) => Promise<string> {
    const capability = getDirectoryPicker?.()?.capability()
    if (capability !== undefined && capability.kind === 'browse' && capability.createDirectory !== undefined) {
      const create = capability.createDirectory
      return (path: string, name: string) => create.call(capability, path, name)
    }
    return async (path: string, name: string) => {
      const target = join(path, name)
      await mkdir(target)
      return target
    }
  }

  /** A usable folder name: one non-blank path segment, no separators. Mirrors
   *  the fence DSH's own `createDirectory` puts on the wire. */
  function isUsableFolderName(name: string): boolean {
    return name.trim() !== '' && name !== '.' && name !== '..' && !/[/\\]/u.test(name)
  }

  /**
   * Render (or re-render) the folder browser at `path` (absent = the host
   * home directory) and record the position for later navigation actions.
   */
  async function showBrowser(
    action: QueuedAction,
    path: string | undefined,
    overrides?: { hidden?: boolean; page?: number; notice?: string },
  ): Promise<void> {
    const list = resolveDirectoryLister()
    let listing: DirectoryListing
    try {
      listing = await list(path)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: directory listing failed: ${msg}`)
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: getTranslations().onboardingBrowseTitle }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: getTranslations().onboardingCreateWorkspaceFailBody(path ?? '~', msg) }] },
      }
      await sendCard(action.chatMessage, card, { terminal: true })
      return
    }
    const previous = browseState.get(action.chatMessage.chatId)
    const state: BrowseState = {
      path: listing.path,
      hidden: overrides?.hidden ?? previous?.hidden ?? false,
      page: overrides?.page ?? 0,
    }
    browseState.set(action.chatMessage.chatId, state)
    logger.info(`dsh-feishu: browse ${action.kind} → ${state.path} page=${state.page} entries=${listing.entries.length} hidden=${state.hidden}`)
    await sendCard(action.chatMessage, renderWorkspaceBrowser(state, listing, getTranslations(), {
      ...(overrides?.notice !== undefined ? { notice: overrides.notice } : {}),
    }), { navigation: true })
  }

  /** Re-list the current level with updated display options (hidden/page/notice). */
  async function refreshBrowser(
    action: QueuedAction,
    overrides: { hidden?: boolean; page?: number; notice?: string },
  ): Promise<void> {
    const state = browseState.get(action.chatMessage.chatId)
    if (state === undefined) {
      await showBrowser(action, undefined)
      return
    }
    await showBrowser(action, state.path, overrides)
  }

  /** Freeze the chosen directory on the card that decided it and move to the
   *  preset step. Nothing is registered here — see {@link commitWorkspace}. */
  async function advanceToPresets(action: QueuedAction, path: string, options?: { missing?: boolean }): Promise<void> {
    const chatKey = action.chatMessage.chatId
    browseState.delete(chatKey)
    const flowState = newFlow.get(chatKey) ?? {}
    flowState.workspace = path
    if (options?.missing === true) flowState.workspaceMissing = true
    else delete flowState.workspaceMissing
    newFlow.set(chatKey, flowState)
    const presets = await agentPresets.list()
    const card = renderPresetPicker(presets, flowState.agentPreset ?? agentPresets.defaultId, getTranslations())
    await sendCard(action.chatMessage, card, { settlePrevious: path })
  }

  /** The red card for a path the operator cannot use as a workspace. */
  async function sendWorkspaceError(action: QueuedAction, path: string, detail: string): Promise<void> {
    const t = getTranslations()
    await sendCard(action.chatMessage, {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: t.onboardingCreateWorkspaceFailTitle }, template: 'red' },
      body: { elements: [{ tag: 'markdown', content: t.onboardingCreateWorkspaceFailBody(path, detail) }] },
    }, { terminal: true })
  }

  /**
   * The operator chose a workspace path (typed form, browser pick, or one of the
   * "what is next door" rows).
   *
   * Nothing is created and nothing is registered here. The path is validated,
   * a path that does not exist yet ASKS FIRST (O16 — the old code went straight
   * to `workspaceRegistry.create`, so a typo produced a red card that said
   * `ENOENT`, and the ledger's "just mkdir it" alternative would have planted a
   * directory nobody asked for), and registration itself waits for the last
   * step of the flow (O19 — cancelling leaves nothing behind).
   */
  async function commitWorkspace(action: QueuedAction, path: string): Promise<void> {
    const t = getTranslations()
    if (path === '' || !isAbsolute(path)) {
      await sendCard(action.chatMessage, {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: t.onboardingCreateWorkspaceFailTitle }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: t.onboardingCreateWorkspaceNotAbsolute(path) }] },
      }, { terminal: true })
      return
    }
    let info: { exists: boolean; isDirectory: boolean }
    try {
      info = await inspectDirectory(path)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      // The old failure branch only painted a card: a silent failure is the most
      // expensive kind (关键坑 6 / the O16 note).
      logger.warn(`dsh-feishu: workspace path check failed for ${path}: ${msg}`)
      await sendWorkspaceError(action, path, msg)
      return
    }
    if (info.exists && !info.isDirectory) {
      logger.warn(`dsh-feishu: workspace path is not a directory: ${path}`)
      await sendWorkspaceError(action, path, t.onboardingCreateWorkspaceNotADirectory)
      return
    }
    if (!info.exists) {
      const chatKey = action.chatMessage.chatId
      const flowState = newFlow.get(chatKey) ?? {}
      flowState.workspace = path
      flowState.workspaceMissing = true
      newFlow.set(chatKey, flowState)
      browseState.delete(chatKey)
      const siblings = await siblingDirectories(path)
      logger.info(`dsh-feishu: workspace ${path} does not exist; asked before creating (${siblings.length} neighbours offered)`)
      await sendCard(action.chatMessage, renderNewWorkspaceConfirmCard(path, siblings, t), { settlePrevious: path })
      return
    }
    await advanceToPresets(action, path)
  }

  async function handleAttach(action: QueuedAction): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    const sessionId = action.sessionId!
    const result = bridge.attachSession(action.chatMessage, sessionId)
    if (result === 'archived') {
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: getTranslations().onboardingAttachArchivedTitle }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: getTranslations().onboardingAttachArchivedBody }] },
      }
      await sendCard(action.chatMessage, card, { terminal: true })
      return
    }
    const ownerKey = bridge.sessionOwnerKey(sessionId)
    const ownerLabel = ownerKey === undefined ? undefined : bridge.describeChatKey(ownerKey)
    const card = renderAttachedCard(sessionId, ownerLabel, getTranslations())
    await sendCard(action.chatMessage, card, { terminal: true })
  }

  async function handleNew(action: QueuedAction): Promise<void> {
    const card = await buildWorkspacePicker(action.chatMessage)
    await sendCard(action.chatMessage, card)
  }

  async function handlePickWorkspace(action: QueuedAction): Promise<void> {
    const chatKey = action.chatMessage.chatId
    const flowState = newFlow.get(chatKey) ?? {}
    if (action.value !== undefined) flowState.workspace = action.value
    newFlow.set(chatKey, flowState)
    const presets = await agentPresets.list()
    const defaultPreset = flowState.agentPreset ?? agentPresets.defaultId
    const card = renderPresetPicker(presets, defaultPreset, getTranslations())
    // The workspace picker is the card the operator just decided on: freeze it
    // on that choice instead of turning it into a dead grey notice.
    await sendCard(action.chatMessage, card, {
      settlePrevious: flowState.workspace ?? action.value ?? '',
    })
  }

  async function handlePickPreset(action: QueuedAction): Promise<void> {
    const chatKey = action.chatMessage.chatId
    const flowState = newFlow.get(chatKey) ?? {}
    if (action.value !== undefined) flowState.agentPreset = action.value
    newFlow.set(chatKey, flowState)
    await onModelStep(action.chatMessage, action.messageId, flowState)
  }

  /** Expand `~`-relative paths to absolute against the user's home dir. */
  function expandHomePath(input: string): string {
    const trimmed = input.trim()
    if (trimmed === '~') return homedir()
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
      return join(homedir(), trimmed.slice(2))
    }
    return trimmed
  }

  async function handleCreateWorkspace(action: QueuedAction): Promise<void> {
    await commitWorkspace(action, expandHomePath(action.value ?? ''))
  }

  async function handleCancel(action: QueuedAction): Promise<void> {
    newFlow.delete(action.chatMessage.chatId)
    browseState.delete(action.chatMessage.chatId)
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: getTranslations().onboardingCancelTitle }, template: 'grey' },
      body: { elements: [{ tag: 'markdown', content: getTranslations().onboardingCancelledBody }] },
    }
    await sendCard(action.chatMessage, card, { terminal: true })
  }

  /** Card action events carry only chatId + messageId — never the thread id.
   *  Restore the topic context so binding and flow cards target the topic's
   *  key (`thread:<chatId>:<threadId>`) instead of the main chat key
   *  (`chat:<chatId>`).
   *
   *  The card's OWN message id decides which topic that is: the operator
   *  clicked a card, and this module remembers the topic it posted that exact
   *  card into. The per-chat map is only the fallback — it can hold just one
   *  topic per group, so with two topics active it hands the click the other
   *  topic's coordinates and every later card of the flow lands there. */
  function withTopicContext(action: QueuedAction): QueuedAction {
    if (action.chatMessage.threadId !== undefined) return action
    const own = cardTopics.for(action.messageId)
    if (own.threadId !== undefined && own.rootId !== undefined) {
      return {
        ...action,
        chatMessage: { ...action.chatMessage, threadId: own.threadId, rootId: own.rootId },
      }
    }
    const ctx = chatTopic.get(action.chatMessage.chatId)
    if (ctx?.threadId === undefined) return action
    return {
      ...action,
      chatMessage: {
        ...action.chatMessage,
        threadId: ctx.threadId,
        ...(ctx.rootId !== undefined ? { rootId: ctx.rootId } : {}),
      },
    }
  }

  const onCardAction = async (evt: CardActionLike): Promise<void> => {
    const parsed = parseOnboardingAction(evt)
    if (parsed === undefined) return
    const action = withTopicContext(parsed)
    try {
      switch (action.kind) {
        case 'attach':
          await handleAttach(action)
          break
        case 'new':
          await handleNew(action)
          break
        case 'pick-workspace':
          await handlePickWorkspace(action)
          break
        case 'pick-preset':
          await handlePickPreset(action)
          break
        case 'create-workspace':
          await handleCreateWorkspace(action)
          break
        case 'create-workspace-confirm': {
          // O16: the operator confirmed that a path which does not exist should
          // be created. Record the intent only — the directory and the registry
          // entry both happen at the flow's last step (O19). A stale card (the
          // typed path changed in the meantime) must not commit the old one.
          const chatKey = action.chatMessage.chatId
          const flowState = newFlow.get(chatKey)
          if (flowState?.workspace === undefined || flowState.workspace !== action.value) break
          await advanceToPresets(action, flowState.workspace, { missing: true })
          break
        }
        case 'workspace-back': {
          // "Enter another path": drop the workspace decision and hand back the
          // picker. The preset choice (if any) survives.
          const chatKey = action.chatMessage.chatId
          const flowState = newFlow.get(chatKey)
          if (flowState !== undefined) {
            delete flowState.workspace
            delete flowState.workspaceMissing
            newFlow.set(chatKey, flowState)
          }
          await sendCard(action.chatMessage, await buildWorkspacePicker(action.chatMessage))
          break
        }
        case 'browse-mkdir': {
          // O17: create one folder inside the level being browsed. The backend
          // (DSH's `browse` capability) does the work: a single path segment,
          // non-recursive, `directory-exists` when it is already there.
          const state = browseState.get(action.chatMessage.chatId)
          const create = resolveDirectoryCreator()
          if (state === undefined || action.value === undefined) break
          if (!isUsableFolderName(action.value)) {
            await refreshBrowser(action, { notice: getTranslations().onboardingBrowseNewFolderInvalid(action.value) })
            break
          }
          try {
            const created = await create(state.path, action.value)
            logger.info(`dsh-feishu: created directory ${created}`)
            await showBrowser(action, created)
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error)
            logger.warn(`dsh-feishu: could not create a folder under ${state.path}: ${msg}`)
            await refreshBrowser(action, { notice: describeCreateFailure(action.value, msg, getTranslations()) })
          }
          break
        }
        case 'browse-open':
          await showBrowser(action, undefined)
          break
        case 'browse-enter':
          await showBrowser(action, action.value)
          break
        case 'browse-home':
          await showBrowser(action, undefined)
          break
        case 'browse-hidden': {
          const state = browseState.get(action.chatMessage.chatId)
          await refreshBrowser(action, { hidden: !(state?.hidden ?? false) })
          break
        }
        case 'browse-page':
          await refreshBrowser(action, { page: Number(action.value) || 0 })
          break
        case 'browse-pick':
          await commitWorkspace(action, action.value ?? '')
          break
        case 'browse-back':
          browseState.delete(action.chatMessage.chatId)
          await sendCard(action.chatMessage, await buildWorkspacePicker(action.chatMessage))
          break
        case 'cancel':
          await handleCancel(action)
          break
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(`dsh-feishu: onboarding action failed: ${msg}`)
    }
  }

  const unsubscribe = channel.onCardAction(onCardAction)

  return {
    dispose: () => {
      unsubscribe()
      newFlow.clear()
      browseState.clear()
      chatTopic.clear()
      superseder.clear()
      sequenceByCard.clear()
    },
    sendOnboardingCard: async (chatMessage: ConversationMessage, threadLabel: string): Promise<void> => {
      const bridge = bridgeHolder.current
      if (bridge === undefined) return
      recordTopic(chatMessage)
      const sessions = await bridge.listSessions()
      const card = renderOnboardingCard(sessions, key => bridge.describeChatKey(key), threadLabel, getTranslations())
      await sendCard(chatMessage, card)
    },
    startNewFlow: async (chatMessage: ConversationMessage): Promise<void> => {
      recordTopic(chatMessage)
      const card = await buildWorkspacePicker(chatMessage)
      await sendCard(chatMessage, card)
    },
    creationOptionsFor: (chatId: string): NewSessionFlowState => {
      return newFlow.get(chatId) ?? {}
    },
    topicFor: (chatId: string): { rootId?: string; threadId?: string } => {
      return chatTopic.get(chatId) ?? {}
    },
    noteTopic: (chatMessage: ConversationMessage): void => {
      recordTopic(chatMessage)
    },
    supersedePrevious: (chatId: string, options?: { mode?: 'keep' | 'notice'; note?: string }): Promise<void> =>
      superseder.supersedePrevious(chatId, options),
  }
}
