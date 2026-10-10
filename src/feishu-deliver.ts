/**
 * Feishu delivery for the files DSH's `present` tool declared.
 *
 * The WebUI renders `deliverables/presented` as a card row the operator can
 * open; a Feishu chat has no workspace browser, so this module turns the same
 * event into three outcomes, in this order of optimism:
 *
 * | what the file is | what happens |
 * |---|---|
 * | media (image / video / audio) | stays on the Turn Complete card, inlined by the card hydrator, with the FILE NAME written next to it |
 * | document (pdf / doc / docx / ppt / pptx / xls / xlsx) under `deliverDocMaxMb` | pushed as a native file message right after the card — no tap needed |
 * | anything else (and any document over the setting) | the row is CLICKABLE: one tap opens a confirmation card, and only its 发送 button pushes the file |
 *
 * Why the split (decided 2026-10-06): the operator asked for finished documents
 * to arrive by themselves while source files, archives and everything else stay
 * one tap away, because a chat message cannot be taken back. Media is different
 * again — it renders IN the card, which is a better surface than a bubble, and
 * the card hydrator already does the upload.
 *
 * Two invariants hold everywhere:
 *
 * - **Nothing trusts a path from the wire.** A callback carries an opaque
 *   token, never a path; the registry entry behind it was written when the
 *   PLANNER resolved the file inside the session's own workspace (checked on
 *   the real path, so a symlink pointing out is refused), and it is re-checked
 *   on every tap — a path that escaped or vanished between the card and the tap
 *   is refused, not sent.
 * - **Nothing is unbounded.** Every send is bounded by the caller-supplied
 *   sender/card adapter (关键坑 29), the registry is TTL'd and capped, and a
 *   failure only ever produces a text notice — a button tap must never be able
 *   to stop the daemon (see `card-dispatch.ts`).
 *
 * The card itself is sent ONCE and never updated, so Feishu's "2-3 in-place
 * updates kill button callbacks" rule (关键坑 11) does not apply to it.
 * Confirmation cards are updated exactly once, when they settle.
 *
 * @module @starxer/chatterbox4dsh/feishu-deliver
 */

import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve, sep } from 'node:path'
import { decodeCardValue } from './card-action.ts'
import {
  FEISHU_MAX_FILE_BYTES,
  classifyDeliverable,
  deliverableIcon,
  formatFileSize,
  isMediaKind,
  noteDeliveredFile,
  wasDeliveredFile,
  type DeliverableKind,
} from './deliver-files.ts'
import type { PluginLogger } from './feishu-send-file.ts'
import type { Translations } from './i18n.ts'
import { truncateInline } from './text-chunk.ts'

/** Callback namespace: a deliverable row was tapped. */
export const DELIVER_OPEN = 'deliver-open'
/** Callback namespace: the confirmation card's "send" button. */
export const DELIVER_SEND = 'deliver-send'
/** Callback namespace: the confirmation card's "cancel" button. */
export const DELIVER_CANCEL = 'deliver-cancel'

/** Most deliverable rows one Turn Complete card lists; the rest are counted. */
export const DELIVERABLE_ROW_CAP = 10
/**
 * Most documents one turn may push WITHOUT asking.
 *
 * A chat message cannot be taken back, and DSH's `present` already allows a
 * long list of files, so an unbounded auto-send could post a burst of
 * attachments nobody asked for (and each send is a whole upload). Documents
 * past this become ordinary click-to-send rows, which is the same treatment
 * every other file gets.
 */
export const DELIVER_AUTO_CAP = 8
/** A registered token stops working this long after the card was built. */
export const DELIVER_TOKEN_TTL_MS = 30 * 60_000
/** Most live tokens kept; oldest are dropped once this is exceeded. */
export const DELIVER_TOKEN_MAX = 200
/** Cap on one row's description text on the card. */
const ROW_NOTE_CAP = 60

/** One file on the Turn Complete card, after the planner looked at it. */
export interface DeliverRow {
  /** The path exactly as the model wrote it — what the card shows. */
  path: string
  /** File name (basename), always shown so the operator knows what arrived. */
  name: string
  kind: DeliverableKind
  description?: string
  /** Bytes, when the file could be stat-ed. */
  size?: number
  /** Click-to-send token; present only on rows the operator can ask for. */
  token?: string
  /** A whitelisted document this turn sends by itself. */
  auto?: boolean
  /** Why the row cannot be sent by tapping. */
  blocked?: 'too-large' | 'unreadable' | 'outside'
}

/** One file that will be pushed without asking. */
export interface DeliverAutoFile {
  /** Absolute, containment-checked real path. */
  path: string
  name: string
  sessionId: string
}

/** What the planner decided for one turn's deliverables. */
export interface DeliverPlan {
  rows: DeliverRow[]
  auto: DeliverAutoFile[]
}

/** One turn's deliverables, as the event carried them. */
export interface DeliverPlanInput {
  /** Session whose turn declared these files (used for the duplicate guard). */
  sessionId: string
  /** Chat the card will go to; the clickable rows belong to it. */
  chatId: string
  /**
   * Topic the Turn Complete card is being posted into. Stored with every token
   * so a later tap reproduces the SAME topic instead of asking the chat-level
   * fallback, which flips as soon as another topic sees traffic (关键坑 31).
   */
  topic?: DeliverTopic
  /** The session's workspace; without it nothing can be validated, so only display rows are produced. */
  workspace?: string
  files: ReadonlyArray<{ path: string; description?: string }>
}

/** Where a delivery-related send belongs (chat + topic). */
export interface DeliverChat {
  chatId: string
  threadId?: string
  rootId?: string
}

/** Topic coordinates of one chat/card. */
export interface DeliverTopic {
  threadId?: string
  rootId?: string
}

/** One card action, as the channel fans it out. */
export interface DeliverCardEvent {
  chatId?: string
  messageId?: string
  action?: { value?: unknown }
}

/** Sends one already-validated file; production wires the bounded sender. */
export type DeliverFileSender = (input: {
  path: string
  chatId: string
  opts?: { replyInThread?: boolean; replyTo?: string }
}) => Promise<{ sentAs: string; messageId: string }>

/** Channel surface this module uses. */
export interface FeishuDeliverChannel {
  send(
    to: string,
    input: { card: object } | { text: string },
    opts?: { replyInThread?: boolean; replyTo?: string },
  ): Promise<{ messageId?: string }>
  updateCard?: (messageId: string, card: object) => Promise<void>
  onCardAction?: (handler: (event: DeliverCardEvent) => void | Promise<void>) => () => void
}

export interface FeishuDeliverDeps {
  channel: FeishuDeliverChannel
  logger: PluginLogger
  /** Strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
  /** Live `deliverDocMaxMb`; read on every plan so a settings write applies at once. */
  docMaxMb: () => number
  /**
   * Topic coordinates for a card-driven send. MUST resolve through the clicked
   * card's message id (关键坑 31); the callback is built by the caller because
   * only it owns the card-topic registry.
   */
  topicFor: (message: { chatId: string; messageId?: string }) => DeliverTopic
  /** The bounded file sender (`sendWorkspaceFile` in production). */
  sendFile: DeliverFileSender
  /** Test seam: clock. */
  now?: () => number
  /** Test seam: token TTL. */
  ttlMs?: number
  /** Test seam: token cap. */
  maxTokens?: number
}

/** What a caller gets back. */
export interface FeishuDeliverHandle {
  /** Resolve and classify one turn's deliverables (registers clickable tokens). */
  plan(input: DeliverPlanInput): Promise<DeliverPlan>
  /** Push the plan's auto files, in order. Never throws. */
  autoSend(plan: DeliverPlan, chat: DeliverChat): Promise<void>
  /** Drop every token and unregister the card-action listener. */
  dispose: () => void
}

/** One live click-to-send token. */
export interface DeliverEntry {
  token: string
  chatId: string
  sessionId: string
  /** Real workspace root the file was validated against at plan time. */
  root: string
  /** Real absolute path at plan time (already containment-checked). */
  abs: string
  /** Path as written, for display. */
  display: string
  name: string
  description?: string
  size: number
  createdAt: number
  sent: boolean
  /** Set SYNCHRONOUSLY before the send is awaited, so a double tap cannot send twice. */
  sending?: boolean
  /** Topic of the Turn Complete card, known when the card was planned. */
  topic?: DeliverTopic
}

/** Strip the markdown constructs a description or name must not carry. */
function cardText(value: string): string {
  const flat = value.replace(/`/gu, "'").replace(/[[\]]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return flat.length <= ROW_NOTE_CAP ? flat : truncateInline(flat, ROW_NOTE_CAP - 1)
}

/** Wrap a link destination the way `card-markdown.ts`'s scanner accepts it. */
function markdownTarget(path: string): string {
  return /[\s()]/u.test(path) ? `<${path.replace(/[<>]/gu, '')}>` : path
}

/** Whether `real` (itself resolved) is the workspace root or lives under it. */
function isInside(real: string, root: string): boolean {
  if (real === root) return true
  // A root that already ends in the separator (the filesystem root) must not
  // produce a `//` prefix, which no real path could ever match.
  const prefix = root.endsWith(sep) ? root : root + sep
  return real.startsWith(prefix)
}

/**
 * A path shown inside an inline code span. A backtick in a path would close the
 * span early and hand the rest of the line to Feishu as markup — the card
 * writer neutralizes image syntax but not a broken code span.
 */
function codeText(path: string): string {
  return path.replace(/[`\r\n]/gu, "'")
}

/** The topic options for a chat: a topic reply needs its ROOT message id. */
function replyOpts(chat: DeliverChat): { replyInThread?: boolean; replyTo?: string } {
  if (chat.threadId === undefined) return {}
  return { replyInThread: true, ...(chat.rootId === undefined ? {} : { replyTo: chat.rootId }) }
}

/** Whether topic options would actually target a topic. */
function hasTopic(opts: { replyInThread?: boolean; replyTo?: string }): boolean {
  return Object.keys(opts).length > 0
}

/** A plain card button (Card 2.0 only honours `behaviors` — 关键坑 4). */
function cardButton(label: string, type: 'default' | 'primary', value: object): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value }],
  }
}

/** Lay two short buttons out side by side, stacking on a narrow screen. */
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

/** The one-line body of a settled confirmation card. */
function settledCard(text: string, t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.deliverCardTitle }, template: 'grey' },
    body: { elements: [{ tag: 'markdown', content: text }] },
  }
}

/**
 * Render the deliverable block of a Turn Complete card.
 *
 * Media rows stay Markdown links so the card hydrator inlines them, and they
 * name the file in plain text first — an inlined picture's alt text is only a
 * hover tooltip, so without the name the operator cannot tell which file
 * arrived. Rows that can be sent by hand are `interactive_container`s (the same
 * clickable-list-item shape the workspace picker uses) carrying an opaque
 * token; a blocked row says why instead of offering a dead tap.
 *
 * @param rows - the planner's rows.
 * @param t - strings for the active locale.
 * @returns elements to append to the card body, header first.
 */
export function renderDeliverableElements(rows: readonly DeliverRow[], t: Translations): object[] {
  const shown = rows.slice(0, DELIVERABLE_ROW_CAP)
  const elements: object[] = [{ tag: 'markdown', content: t.deliverablesTitle(rows.length) }]
  if (shown.some(row => row.token !== undefined)) {
    elements.push({ tag: 'markdown', content: t.deliverTapHint, text_size: 'notation' })
  }
  for (const row of shown) {
    const note = row.description === undefined ? '' : ` · ${cardText(row.description)}`
    const label = `**${cardText(row.name)}**${note}`
    const size = row.size === undefined ? '' : ` · ${formatFileSize(row.size)}`
    if (isMediaKind(row.kind)) {
      // The reference is what the hydrator turns into the picture / player;
      // the name written above it is what makes it identifiable.
      elements.push({
        tag: 'markdown',
        content: `• ${deliverableIcon(row.kind)} ${label} · [${t.deliverPreview}](${markdownTarget(row.path)})`,
      })
      continue
    }
    if (row.blocked !== undefined) {
      elements.push({
        tag: 'markdown',
        content: `• ⚠️ ${label} · \`${codeText(row.path)}\`${size} · ${t.deliverBlockedReason(row.blocked)}`,
      })
      continue
    }
    if (row.auto === true) {
      elements.push({
        tag: 'markdown',
        // Deliberately no "sent" checkmark: this row is rendered BEFORE the
        // push happens, and a failure is reported by its own notice.
        content: `• ${deliverableIcon(row.kind)} ${label} · \`${codeText(row.path)}\`${size} · ${t.deliverAutoSent}`,
      })
      continue
    }
    elements.push({
      tag: 'interactive_container',
      width: 'fill',
      has_border: false,
      padding: '4px 12px 4px 12px',
      behaviors: [{ type: 'callback', value: { p: DELIVER_OPEN, token: row.token } }],
      elements: [
        { tag: 'markdown', content: `• ${deliverableIcon(row.kind)} ${label}` },
        { tag: 'markdown', content: `\`${codeText(row.path)}\`${size} · ${t.deliverTapToSend}`, text_size: 'notation' },
      ],
    })
  }
  if (rows.length > shown.length) {
    elements.push({ tag: 'markdown', content: t.deliverablesMore(rows.length - shown.length), text_size: 'notation' })
  }
  return elements
}

/** The confirmation card for one click-to-send file. */
export function renderDeliverConfirmCard(entry: DeliverEntry, t: Translations): object {
  const elements: object[] = [
    { tag: 'markdown', content: t.deliverConfirmBody(cardText(entry.name), formatFileSize(entry.size)) },
    { tag: 'markdown', content: `\`${codeText(entry.display)}\``, text_size: 'notation' },
  ]
  if (entry.description !== undefined && entry.description.trim() !== '') {
    elements.push({ tag: 'markdown', content: cardText(entry.description) })
  }
  elements.push(buttonRow([
    cardButton(t.deliverSendButton, 'primary', { p: DELIVER_SEND, token: entry.token }),
    cardButton(t.deliverCancelButton, 'default', { p: DELIVER_CANCEL, token: entry.token }),
  ]))
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.deliverCardTitle }, template: 'blue' },
    body: { elements },
  }
}

/**
 * Build the delivery controller: the planner behind the Turn Complete card, the
 * auto-send that follows it, and the tap → confirm → send flow.
 *
 * @param deps - channel, logger, locale reader, size setting and topic resolver.
 * @returns the handle used by `channel.ts` (plan + autoSend) and by disposal.
 */
export function startFeishuDeliverables(deps: FeishuDeliverDeps): FeishuDeliverHandle {
  const { channel, logger, getTranslations, sendFile } = deps
  const now = deps.now ?? ((): number => Date.now())
  const ttlMs = deps.ttlMs ?? DELIVER_TOKEN_TTL_MS
  const maxTokens = deps.maxTokens ?? DELIVER_TOKEN_MAX
  /** token → the file it stands for. */
  const tokens = new Map<string, DeliverEntry>()
  const warn = (message: string, error: unknown): void => {
    // Never log the error object itself: SDK errors carry the request body,
    // which holds the app secret (硬规则 2).
    logger.warn(`dsh-feishu: ${message}: ${error instanceof Error ? error.message : String(error)}`)
  }

  /** Drop expired tokens, then the oldest if still over the cap. */
  const prune = (): void => {
    const at = now()
    for (const [token, entry] of tokens) {
      if (at - entry.createdAt > ttlMs) tokens.delete(token)
    }
    while (tokens.size > maxTokens) {
      const oldest = tokens.keys().next().value
      if (oldest === undefined) return
      tokens.delete(oldest)
    }
  }

  /** Update a settled confirmation card, tolerating channels without updates. */
  const settle = async (messageId: string | undefined, card: object): Promise<void> => {
    if (messageId === undefined || channel.updateCard === undefined) return
    await channel.updateCard(messageId, card).catch(() => undefined)
  }

  /** Send a text notice; failures are logged, never thrown. */
  const notify = async (chat: DeliverChat, text: string): Promise<void> => {
    await channel.send(chat.chatId, { text }, replyOpts(chat)).catch((error: unknown) => {
      warn('deliverable notice failed', error)
    })
  }

  /**
   * Re-check one token before acting on it. The registry entry is not a
   * permission: the file system changes between the card and the tap, so
   * existence, regular-file-ness, size and workspace containment are all
   * re-decided here.
   *
   * @returns `undefined` when the file is deliverable, else the localized reason.
   */
  const refusal = async (entry: DeliverEntry, t: Translations): Promise<string | undefined> => {
    let real: string
    try {
      real = await realpath(entry.abs)
    } catch {
      return t.deliverFileGone
    }
    if (!isInside(real, entry.root)) return t.deliverOutside
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size === 0) return t.deliverFileGone
      if (info.size > FEISHU_MAX_FILE_BYTES) return t.deliverTooLarge
    } catch {
      return t.deliverFileGone
    }
    return undefined
  }

  /** Look one token up, refusing unknown and expired ones. */
  const liveEntry = (token: string): DeliverEntry | undefined => {
    const entry = tokens.get(token)
    if (entry === undefined) return undefined
    if (now() - entry.createdAt > ttlMs) {
      tokens.delete(token)
      return undefined
    }
    return entry
  }

  /**
   * Resolve and classify one turn's deliverables.
   *
   * Media needs no checks here (the card hydrator already owns that path), so
   * only files that could become a MESSAGE are stat-ed and containment-checked.
   * Without a workspace nothing can be validated — the rows still render, marked
   * as outside, so the operator sees the file names instead of a silent gap.
   */
  const plan = async (input: DeliverPlanInput): Promise<DeliverPlan> => {
    prune()
    const rows: DeliverRow[] = []
    const auto: DeliverAutoFile[] = []
    const docLimitBytes = Math.max(1, Math.trunc(deps.docMaxMb())) * 1024 * 1024
    let root: string | undefined
    if (input.workspace !== undefined && input.workspace !== '') {
      root = await realpath(input.workspace).catch(() => undefined)
    }
    for (const file of input.files) {
      const display = file.path.trim()
      if (display === '') continue
      const description = file.description === undefined ? {} : { description: file.description }
      const name = basename(display)
      const kind = classifyDeliverable(display)
      const base: DeliverRow = { path: display, name, kind, ...description }
      if (isMediaKind(kind)) {
        rows.push(base)
        continue
      }
      if (root === undefined) {
        rows.push({ ...base, blocked: 'outside' })
        continue
      }
      const candidate = isAbsolute(display) ? display : resolve(root, display)
      let real: string
      try {
        real = await realpath(candidate)
      } catch {
        rows.push({ ...base, blocked: 'unreadable' })
        continue
      }
      if (!isInside(real, root)) {
        rows.push({ ...base, blocked: 'outside' })
        continue
      }
      let info
      try {
        info = await stat(real)
      } catch {
        rows.push({ ...base, blocked: 'unreadable' })
        continue
      }
      if (!info.isFile() || info.size === 0) {
        rows.push({ ...base, blocked: 'unreadable' })
        continue
      }
      if (info.size > FEISHU_MAX_FILE_BYTES) {
        rows.push({ ...base, blocked: 'too-large', size: info.size })
        continue
      }
      if (kind === 'document' && info.size <= docLimitBytes && auto.length < DELIVER_AUTO_CAP) {
        rows.push({ ...base, size: info.size, auto: true })
        auto.push({ path: real, name, sessionId: input.sessionId })
        continue
      }
      // A token is only minted for a row the card will actually RENDER: past
      // the display cap the row is invisible, and a token nobody can tap would
      // just sit in the registry.
      if (rows.length >= DELIVERABLE_ROW_CAP) {
        rows.push({ ...base, size: info.size })
        continue
      }
      const token = randomUUID()
      tokens.set(token, {
        token,
        chatId: input.chatId,
        sessionId: input.sessionId,
        root,
        abs: real,
        display,
        name,
        ...description,
        size: info.size,
        createdAt: now(),
        sent: false,
        ...(input.topic === undefined ? {} : { topic: input.topic }),
      })
      rows.push({ ...base, size: info.size, token })
    }
    return { rows, auto }
  }

  /**
   * Push the files the plan decided to send by itself. Ordered, sequential and
   * never throwing: the Turn Complete card has already been posted, so a failure
   * here is a notice, not an error state.
   */
  const autoSend = async (deliveryPlan: DeliverPlan, chat: DeliverChat): Promise<void> => {
    for (const file of deliveryPlan.auto) {
      // The whole body is contained, not just the send: this promise is awaited
      // on the reply path, and anything escaping here would make `channel.ts`
      // post a bogus failure card for a turn that actually succeeded.
      try {
        // A model that already called `feishu_send_file` for this path must not
        // have the same file pushed twice.
        if (wasDeliveredFile(file.sessionId, file.path, now())) continue
        const opts = replyOpts(chat)
        await sendFile({ path: file.path, chatId: chat.chatId, ...(hasTopic(opts) ? { opts } : {}) })
        noteDeliveredFile(file.sessionId, file.path, now())
        logger.warn(`dsh-feishu: [deliver] auto-sent "${file.name}" to chat ${chat.chatId}`)
      } catch (error: unknown) {
        const t = getTranslations()
        const reason = error instanceof Error ? error.message : String(error)
        warn(`auto-send of "${file.name}" failed`, error)
        await notify(chat, t.deliverAutoFailed(file.name, reason))
      }
    }
  }

  const onCardAction = async (event: DeliverCardEvent): Promise<void> => {
    try {
      const parsed = decodeCardValue(event.action?.value)
      const action = typeof parsed?.p === 'string' ? parsed.p : undefined
      if (action !== DELIVER_OPEN && action !== DELIVER_SEND && action !== DELIVER_CANCEL) return
      const token = typeof parsed?.token === 'string' ? parsed.token : ''
      const t = getTranslations()
      const entry = token === '' ? undefined : liveEntry(token)
      // Strict on both sides: Feishu always sends `chat_id`, and a missing one
      // is not a reason to skip the binding check (defence in depth).
      if (entry === undefined || event.chatId !== entry.chatId) {
        // A tap on a card older than the TTL, or one from a previous process.
        // A ROW tap must not be "answered" by updating the card: that card
        // carries the rows themselves, and an in-place edit would kill every
        // one of them (关键坑 11). Say it in a message instead.
        if (action === DELIVER_OPEN) {
          const chatId = event.chatId ?? ''
          if (chatId !== '') await notify({ chatId, ...deps.topicFor({ chatId, ...(event.messageId === undefined ? {} : { messageId: event.messageId }) }) }, t.deliverExpired)
        } else {
          await settle(event.messageId, settledCard(t.deliverExpired, t))
        }
        return
      }
      if (action === DELIVER_CANCEL) {
        await settle(event.messageId, settledCard(t.deliverCancelled(entry.name), t))
        return
      }
      const blocked = await refusal(entry, t)
      // The topic the row's card was posted into is remembered at plan time;
      // the registry lookup is the fallback for a card planned before this
      // field existed (关键坑 31).
      const topic = entry.topic
        ?? deps.topicFor({ chatId: entry.chatId, ...(event.messageId === undefined ? {} : { messageId: event.messageId }) })
      if (action === DELIVER_OPEN) {
        if (blocked !== undefined) {
          await notify({ chatId: entry.chatId, ...topic }, `${cardText(entry.name)}：${blocked}`)
          return
        }
        // Remember the topic the confirmation card landed in, so the file
        // message that follows it cannot escape into another topic (关键坑 31).
        entry.topic = topic
        const sent = await channel.send(
          entry.chatId,
          { card: renderDeliverConfirmCard(entry, t) },
          replyOpts({ chatId: entry.chatId, ...topic }),
        )
        logger.warn(`dsh-feishu: [deliver] confirmation card for "${entry.name}" → ${sent.messageId ?? '-'}`)
        return
      }
      // DELIVER_SEND
      if (entry.sent) {
        await settle(event.messageId, settledCard(t.deliverSent(entry.name), t))
        return
      }
      if (blocked !== undefined) {
        await settle(event.messageId, settledCard(blocked, t))
        return
      }
      // Claim the entry SYNCHRONOUSLY, before the first await: two taps inside
      // the upload window would otherwise both reach the send and deliver the
      // same file twice.
      if (entry.sending === true) return
      entry.sending = true
      try {
        const opts = replyOpts({ chatId: entry.chatId, ...(entry.topic ?? {}) })
        const outcome = await sendFile({ path: entry.abs, chatId: entry.chatId, ...(hasTopic(opts) ? { opts } : {}) })
        entry.sent = true
        noteDeliveredFile(entry.sessionId, entry.abs, now())
        logger.warn(`dsh-feishu: [deliver] sent "${entry.name}" (${outcome.sentAs}) to chat ${entry.chatId}`)
        await settle(event.messageId, settledCard(t.deliverSent(entry.name), t))
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        warn(`manual send of "${entry.name}" failed`, error)
        await settle(event.messageId, settledCard(t.deliverFailed(entry.name, cardText(reason)), t))
      } finally {
        entry.sending = false
      }
    } catch (error: unknown) {
      // Card handlers have no owner: an escaping rejection is fatal for the
      // whole daemon (see `card-dispatch.ts`).
      warn('deliverable card action failed', error)
    }
  }

  const unsubscribe = channel.onCardAction?.((event: DeliverCardEvent) => onCardAction(event))

  return {
    plan,
    autoSend,
    dispose: () => {
      unsubscribe?.()
      tokens.clear()
    },
  }
}

/** Whether a delivery plan has anything for the card to carry. */
export function hasDeliverables(plan: DeliverPlan | undefined): plan is DeliverPlan {
  return plan !== undefined && plan.rows.length > 0
}
