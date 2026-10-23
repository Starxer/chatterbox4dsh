/**
 * "This card is stale" marker for interactive card flows.
 *
 * Feishu stops delivering button callbacks on a message's card after only a
 * couple of in-place edits, so every interactive flow here posts a NEW card per
 * step instead of editing the previous one (see AGENTS.md 关键坑 11). The old
 * cards stay in the chat — the operator prefers that to a recalled card — but
 * they keep showing live-looking buttons that no longer lead anywhere.
 *
 * This module retires such a superseded card IN PLACE. Three shapes exist:
 *
 * - `replace` — the caller hands over the payload to paint. A card where the
 *   operator actually DECIDED something is rewritten into a settlement card
 *   that shows only the decision ("✅ 工作区已选定 / 📁 path"), the same way an
 *   answered question card is rewritten. Keeping the old content and appending
 *   one notice line (the previous behaviour) left the visible change at the
 *   bottom of a long list, so nobody could tell anything had happened.
 * - `keep` — the card's own content, with every callback binding stripped, a
 *   grey header and one localized notice line pointing at the newest card.
 * - the bare {@link renderSupersededCard} notice, for cards merely walked
 *   through (folder-browser pages).
 *
 * It is deliberately best-effort: failing to repaint the old card must never
 * break the flow that already succeeded.
 *
 * @module @starxer/chatterbox4dsh/card-supersede
 */

import type { Translations } from './i18n.ts'

/** Minimal logger surface. */
interface PluginLogger {
  warn(message: string): unknown
}

/** Channel surface needed to repaint a card that was already sent. */
export interface SupersedeChannel {
  /**
   * Repaint a CardKit card instance (cardkit.v1.card.update). Preferred, and
   * the only path that works for cards sent by reference.
   */
  updateCardInstance?(cardId: string, card: object, sequence: number): Promise<void>
  /** Fallback for inline-card messages: `im.v1.message.patch` by message id. */
  updateCard?(messageId: string, card: object): Promise<void>
}

/** Identity of a card that was posted to a chat. */
export interface CardRef {
  cardId: string
  messageId?: string | undefined
  /**
   * The card JSON exactly as posted. Hand it over whenever the payload is
   * still in hand: whether the retired card keeps its content or collapses to
   * the generic grey notice is decided by the retire MODE, never by dropping
   * this field.
   *
   * That matters because a card only walked through can still become the
   * decision card — a folder-browser page is "pure navigation" until the
   * operator taps "✅ 用这个目录" on it, and only a remembered payload can be
   * frozen on screen at that moment (see {@link renderStaleCard}). Dropping the
   * payload here used to silently downgrade that settled decision to an empty
   * notice.
   *
   * Omit it only when the caller genuinely no longer holds the payload: then
   * the card gets a generic grey notice.
   */
  card?: object | undefined
  /**
   * True for a card posted as a pure navigation step (folder-browser page,
   * "up one level", pager). Such a card is retired as the bare notice by
   * default, so a long `/new` browse does not leave a wall of listings behind
   * — but an explicit `mode: 'keep'` (the operator settled on that page) still
   * freezes it.
   */
  navigation?: boolean | undefined
}

/** Plain-object guard for the card JSON walk. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Drop every callback binding from a card payload, recursively.
 *
 * `behaviors` is the ONLY field that makes a Card JSON 2.0 element fire a
 * callback (buttons, `select_static`, `interactive_container`). Removing it
 * leaves the payload structurally valid but inert, so a retired card keeps its
 * text for the record while no tap can reach the plugin.
 */
function stripBehaviors(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripBehaviors)
  if (!isPlainObject(node)) return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'behaviors') continue
    out[key] = stripBehaviors(value)
  }
  return out
}

/**
 * Retire a posted card while KEEPING its content: the same payload with every
 * callback binding stripped, a grey header and one appended notice line.
 *
 * This is the "settled decision" shape: the card where the operator actually
 * made a choice stays in the chat as a readable, frozen record of that choice —
 * a `/new` flow otherwise destroys every card it walks through, and the
 * operator asked to keep the decision card and make it non-editable.
 *
 * @param card - the payload that was posted, verbatim.
 * @param t - strings for the active locale.
 * @param note - the notice line; defaults to the generic stale notice.
 */
export function renderStaleCard(card: object, t: Translations, note?: string): object {
  const retired = stripBehaviors(card) as Record<string, unknown>
  const header = isPlainObject(retired.header) ? retired.header : {}
  retired.header = { ...header, template: 'grey' }
  const notice = { tag: 'markdown', content: note ?? t.cardStaleNote, text_size: 'notation' }
  const body = retired.body
  if (isPlainObject(body) && Array.isArray(body.elements)) {
    body.elements = [...body.elements, { tag: 'hr' }, notice]
  } else if (Array.isArray(retired.elements)) {
    retired.elements = [...retired.elements, { tag: 'hr' }, notice]
  } else {
    retired.body = { elements: [notice] }
  }
  return retired
}

/** The card shown in place of a superseded one when its payload is unknown. No
 *  buttons: an abandoned card must not keep accepting taps. */
export function renderSupersededCard(t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.cardSupersededTitle },
      template: 'grey',
    },
    body: {
      elements: [{ tag: 'markdown', content: t.cardSupersededBody }],
    },
  }
}

/** The card shown when the same request was answered on the other surface
 *  (the DSH Web UI), so this one must stop looking answerable.
 *
 *  @param detail - Optional line naming what the other surface chose, so the
 *    stale card still tells the reader the outcome instead of just "void". */
export function renderAnsweredElsewhereCard(t: Translations, detail?: string): object {
  const elements: object[] = [{ tag: 'markdown', content: t.cardAnsweredElsewhereBody }]
  if (detail !== undefined && detail !== '') {
    elements.push({ tag: 'markdown', content: detail })
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.cardAnsweredElsewhereTitle },
      template: 'grey',
    },
    body: { elements },
  }
}

export interface CardSupersederDeps {
  channel: SupersedeChannel
  logger: PluginLogger
  /** Strings for the ACTIVE locale, read at repaint time. */
  getTranslations: () => Translations
  /**
   * Monotonic sequence per card instance (CardKit requires it). Shared with the
   * caller so an in-place update and a later supersede notice never reuse a
   * number — a lower sequence is rejected by Feishu.
   */
  sequenceByCard: Map<string, number>
}

/**
 * How a superseded card is repainted.
 *
 * @property mode - `'replace'` paints {@link card} verbatim (minus callback
 *   bindings) — the settlement shape; `'keep'` freezes the card's own content
 *   with a notice line; `'notice'` replaces it with the bare generic notice.
 * @property note - notice line for the `'keep'` shape.
 * @property card - payload for the `'replace'` shape. Omitted (or with no
 *   `mode`) it falls back to the default shape.
 */
export interface SupersedeOptions {
  mode?: 'keep' | 'notice' | 'replace'
  note?: string
  card?: object
}

export interface CardSuperseder {
  /** Remember the card most recently posted in this chat. */
  note(chatId: string, ref: CardRef): void
  /**
   * Repaint the previously noted card for this chat.
   *
   * Call it AFTER the new card has been posted so the user never sees a gap,
   * and BEFORE {@link note}-ing the new card.
   *
   * @param options - see {@link SupersedeOptions}. Omit it to get `'keep'`,
   *   except for a card noted with `navigation: true` (a folder-browser page),
   *   which then collapses to the notice.
   */
  supersedePrevious(chatId: string, options?: SupersedeOptions): Promise<void>
  /** Drop the remembered card without repainting it (terminal result cards
   *  such as "session created" stay readable). */
  forget(chatId: string): void
  /** Drop every remembered card (dispose). */
  clear(): void
}

export function createCardSuperseder(deps: CardSupersederDeps): CardSuperseder {
  const lastByChat = new Map<string, CardRef>()
  return {
    note: (chatId, ref) => {
      lastByChat.set(chatId, ref)
    },
    forget: (chatId) => {
      lastByChat.delete(chatId)
    },
    clear: () => {
      lastByChat.clear()
    },
    supersedePrevious: async (chatId, options) => {
      const previous = lastByChat.get(chatId)
      if (previous === undefined) return
      lastByChat.delete(chatId)
      const t = deps.getTranslations()
      // A settle payload is painted as-is (minus callback bindings): it is the
      // WHOLE card now, so the decision is the first thing on screen. Otherwise
      // freeze the payload as a settled record when the caller asked for it
      // (and handed one over); with no explicit mode, a card that was only a
      // navigation step collapses to the bare notice, while an explicit keep
      // still wins, because that page may be exactly where the operator decided.
      const settled = options?.mode === 'replace' ? options.card : undefined
      const keep = options?.mode === 'notice'
        ? false
        : options?.mode === 'keep'
          ? previous.card !== undefined
          : previous.navigation !== true && previous.card !== undefined
      const card = settled !== undefined
        ? stripBehaviors(settled) as object
        : keep
          ? renderStaleCard(previous.card!, t, options?.note)
          : renderSupersededCard(t)
      try {
        if (deps.channel.updateCardInstance !== undefined) {
          const sequence = (deps.sequenceByCard.get(previous.cardId) ?? 0) + 1
          deps.sequenceByCard.set(previous.cardId, sequence)
          await deps.channel.updateCardInstance(previous.cardId, card, sequence)
          return
        }
        if (previous.messageId !== undefined && deps.channel.updateCard !== undefined) {
          await deps.channel.updateCard(previous.messageId, card)
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        deps.logger.warn(`dsh-feishu: could not mark card ${previous.cardId} as superseded: ${msg}`)
      }
    },
  }
}
