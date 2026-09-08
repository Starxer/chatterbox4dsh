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
import { opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

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
export interface OnboardingChannel {
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
  onModelStep: (chatMessage: ConversationMessage, messageId: string | undefined, flowState: { workspace?: string; agentPreset?: string }) => Promise<void>
}

/** A queued onboarding card action. */
interface QueuedAction {
  kind:
    | 'attach' | 'new' | 'pick-workspace' | 'pick-preset' | 'create-workspace' | 'cancel'
    | 'browse-open' | 'browse-enter' | 'browse-home' | 'browse-hidden' | 'browse-page'
    | 'browse-pick' | 'browse-back'
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

/** Middle-elide a long path so a button label never overflows: keep a head
 *  fragment and the trailing basename, join with an ellipsis. */
function elideMiddle(value: string, max: number): string {
  if (value.length <= max) return value
  const head = Math.max(4, Math.floor(max * 0.4))
  const tail = Math.max(4, Math.floor(max * 0.45))
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

/** Workspace picker card (step 1 of /new): choose an existing workspace or
 *  create a new one by absolute path or a `~`-relative path.
 *
 *  Long workspace paths do not fit a Feishu button's single-line label, so
 *  each row renders the FULL path as a wrapping `markdown` line (guaranteed
 *  readable) plus a compact button that carries a short label (a workspace
 *  name, or a middle-elided path when unnamed) and the full path in its
 *  `behavior` value. */
function renderWorkspacePicker(workspaces: readonly WorkspaceLike[], currentWorkspace: string | undefined, t: Translations): object {
  const elements: object[] = [
    { tag: 'markdown', content: t.onboardingWorkspaceHeader },
    { tag: 'hr' },
  ]
  if (workspaces.length === 0) {
    elements.push({ tag: 'markdown', content: t.onboardingNoWorkspaces })
  }
  for (const ws of workspaces) {
    const named = ws.name !== undefined && ws.name !== ''
    const buttonLabel = named ? (ws.name as string) : elideMiddle(ws.path, 28)
    const mark = ws.path === currentWorkspace ? ' ✅' : ''
    // Full path first (wraps freely, never clipped), then the pick button.
    elements.push({ tag: 'markdown', content: `📁 \`${ws.path}\`` })
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `选择：${buttonLabel}${mark}` },
      type: ws.path === currentWorkspace ? 'primary' : 'default',
      behaviors: [{ type: 'callback', value: { kind: 'pick-workspace', value: ws.path } }],
    })
  }
  elements.push({ tag: 'hr' })
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
    tag: 'markdown',
    content: t.onboardingNewWorkspaceHeader,
  })
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

/** Folder-browser card: navigate levels, toggle hidden entries, page a large
 *  level, and pick the listed directory as the new session's workspace.
 *
 *  Every entry is one button (tap = descend) and the current directory is
 *  committed by a single primary button at the bottom, so a level of N
 *  entries costs N + 6 elements instead of 2N. */
function renderWorkspaceBrowser(state: BrowseState, listing: DirectoryListing, t: Translations): object {
  const visible = listing.entries.filter(entry => state.hidden || !entry.hidden)
  const totalPages = Math.max(1, Math.ceil(visible.length / BROWSE_PAGE_SIZE))
  const page = Math.min(Math.max(state.page, 0), totalPages - 1)
  const slice = visible.slice(page * BROWSE_PAGE_SIZE, page * BROWSE_PAGE_SIZE + BROWSE_PAGE_SIZE)
  // crumbs is root→current inclusive, so the second-to-last crumb is the parent.
  const parent = listing.crumbs.length >= 2 ? listing.crumbs[listing.crumbs.length - 2] : undefined

  const elements: object[] = [
    { tag: 'markdown', content: t.onboardingBrowseHeader(listing.path) },
    { tag: 'hr' },
  ]
  if (parent !== undefined) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t.onboardingBrowseUp },
      type: 'default',
      behaviors: [{ type: 'callback', value: { kind: 'browse-enter', value: parent.path } }],
    })
  }
  if (listing.path !== listing.home) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t.onboardingBrowseHome },
      type: 'default',
      behaviors: [{ type: 'callback', value: { kind: 'browse-home' } }],
    })
  }
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: state.hidden ? t.onboardingBrowseHideHidden : t.onboardingBrowseShowHidden },
    type: 'default',
    behaviors: [{ type: 'callback', value: { kind: 'browse-hidden' } }],
  })
  elements.push({ tag: 'hr' })

  if (slice.length === 0) {
    elements.push({ tag: 'markdown', content: t.onboardingBrowseEmpty })
  } else {
    for (const entry of slice) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: `📁 ${elideMiddle(entry.name, 30)}` },
        type: 'default',
        behaviors: [{ type: 'callback', value: { kind: 'browse-enter', value: entry.path } }],
      })
    }
  }

  if (totalPages > 1) {
    elements.push({ tag: 'markdown', content: t.onboardingBrowsePage(page + 1, totalPages) })
    if (page > 0) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: t.onboardingBrowsePrev },
        type: 'default',
        behaviors: [{ type: 'callback', value: { kind: 'browse-page', value: String(page - 1) } }],
      })
    }
    if (page < totalPages - 1) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: t.onboardingBrowseNext },
        type: 'default',
        behaviors: [{ type: 'callback', value: { kind: 'browse-page', value: String(page + 1) } }],
      })
    }
  }
  if (listing.truncated) {
    elements.push({ tag: 'markdown', content: t.onboardingBrowseTruncated })
  }

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.onboardingBrowsePick },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { kind: 'browse-pick', value: listing.path } }],
  })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.onboardingBrowseBack },
    type: 'default',
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
  creationOptionsFor(chatId: string): { workspace?: string; agentPreset?: string }
  /** Topic reply context recorded for a chat (rootId/threadId), so the
   *  model-step card sent by the caller lands in the same topic. */
  topicFor(chatId: string): { rootId?: string; threadId?: string }
  /** Record topic context from an inbound message (e.g. a slash command in a
   *  topic) so later card actions from that chat recover their thread key. */
  noteTopic(chatMessage: ConversationMessage): void
}

export function startFeishuOnboarding(deps: FeishuOnboardingDeps): FeishuOnboardingHandle {
  const { bridgeHolder, channel, logger, workspaceRegistry, agentPresets, agentDefaultModel, config, getTranslations, onModelStep, getDirectoryPicker } = deps

  /** Per-chat in-flight `/new` flow state. */
  const newFlow = new Map<string, { workspace?: string; agentPreset?: string }>()
  /** Per-chat folder-browser position (kept only while the browser is open). */
  const browseState = new Map<string, BrowseState>()
  /** Topic reply context per chat, so cards sent from button callbacks land
   *  in the same Feishu topic the user clicked from. Keyed by chatId. */
  const chatTopic = new Map<string, { rootId?: string; threadId?: string }>()

  /** Send opts that land in the chat's topic when it has one. */
  function topicOpts(chatMessage: ConversationMessage): { replyInThread?: boolean; replyTo?: string } {
    const rootId = chatMessage.rootId ?? chatTopic.get(chatMessage.chatId)?.rootId
    const threadId = chatMessage.threadId ?? chatTopic.get(chatMessage.chatId)?.threadId
    if (threadId === undefined || rootId === undefined) return {}
    return { replyInThread: true, replyTo: rootId }
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
   */
  async function sendCard(
    chatMessage: ConversationMessage,
    card: object,
  ): Promise<void> {
    const opts = topicOpts(chatMessage)
    const cardId = await channel.createCardInstance(card)
    await channel.sendCardByReference(chatMessage.chatId, cardId, opts)
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
   * Render (or re-render) the folder browser at `path` (absent = the host
   * home directory) and record the position for later navigation actions.
   */
  async function showBrowser(
    action: QueuedAction,
    path: string | undefined,
    overrides?: { hidden?: boolean; page?: number },
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
      await sendCard(action.chatMessage, card)
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
    await sendCard(action.chatMessage, renderWorkspaceBrowser(state, listing, getTranslations()))
  }

  /** Re-list the current level with updated display options (hidden/page). */
  async function refreshBrowser(action: QueuedAction, overrides: { hidden?: boolean; page?: number }): Promise<void> {
    const state = browseState.get(action.chatMessage.chatId)
    if (state === undefined) {
      await showBrowser(action, undefined)
      return
    }
    await showBrowser(action, state.path, overrides)
  }

  /** Register `path` as a workspace and advance to the preset picker. */
  async function commitWorkspace(action: QueuedAction, path: string): Promise<void> {
    const chatKey = action.chatMessage.chatId
    try {
      await workspaceRegistry.create(path)
      logger.info(`dsh-feishu: created workspace ${path}`)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: getTranslations().onboardingCreateWorkspaceFailTitle }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: getTranslations().onboardingCreateWorkspaceFailBody(path, msg) }] },
      }
      await sendCard(action.chatMessage, card)
      return
    }
    browseState.delete(chatKey)
    const flowState = newFlow.get(chatKey) ?? {}
    flowState.workspace = path
    newFlow.set(chatKey, flowState)
    const presets = await agentPresets.list()
    const card = renderPresetPicker(presets, flowState.agentPreset ?? agentPresets.defaultId, getTranslations())
    await sendCard(action.chatMessage, card)
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
      await sendCard(action.chatMessage, card)
      return
    }
    const ownerKey = bridge.sessionOwnerKey(sessionId)
    const ownerLabel = ownerKey === undefined ? undefined : bridge.describeChatKey(ownerKey)
    const card = renderAttachedCard(sessionId, ownerLabel, getTranslations())
    await sendCard(action.chatMessage, card)
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
    await sendCard(action.chatMessage, card)
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
    await sendCard(action.chatMessage, card)
  }

  /** Card action events carry only chatId + messageId — never the thread id.
   *  Restore the topic context recorded when the card was sent so binding and
   *  flow cards target the topic's key (`thread:<chatId>:<threadId>`) instead
   *  of the main chat key (`chat:<chatId>`). */
  function withTopicContext(action: QueuedAction): QueuedAction {
    const ctx = chatTopic.get(action.chatMessage.chatId)
    if (ctx?.threadId === undefined || action.chatMessage.threadId !== undefined) return action
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
    creationOptionsFor: (chatId: string): { workspace?: string; agentPreset?: string } => {
      return newFlow.get(chatId) ?? {}
    },
    topicFor: (chatId: string): { rootId?: string; threadId?: string } => {
      return chatTopic.get(chatId) ?? {}
    },
    noteTopic: (chatMessage: ConversationMessage): void => {
      recordTopic(chatMessage)
    },
  }
}
