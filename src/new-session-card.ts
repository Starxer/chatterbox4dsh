/**
 * The final confirmation card of the `/new` card flow.
 *
 * The flow used to create the session the moment the model step was confirmed,
 * so a mis-clicked workspace/preset/model silently produced a session nobody
 * had seen assembled. Instead every setting is collected here, the operator
 * confirms once, and only then is the session created.
 *
 * @module @starxer/chatterbox4dsh/new-session-card
 */

import type { ChatCreationOptions } from './harness.ts'
import type { Translations } from './i18n.ts'

/** Card action kinds carried by this card's buttons. */
export const NEW_SESSION_CONFIRM_ACTION = 'new-session-create'
export const NEW_SESSION_CANCEL_ACTION = 'new-session-cancel'

/**
 * Build the confirmation card: every setting that will be applied, plus the two
 * callbacks that settle it.
 *
 * The buttons carry `behaviors` (not a top-level `value`) because the card is
 * posted as a CardKit instance, and only `behaviors` survives that path (see
 * AGENTS.md 关键坑 4).
 */
export function renderNewSessionConfirmCard(options: ChatCreationOptions, t: Translations): object {
  const lines: string[] = []
  if (options.workspace !== undefined) lines.push(t.newSessionConfirmWorkspace(options.workspace))
  if (options.agentPreset !== undefined) lines.push(t.newSessionConfirmPreset(options.agentPreset))
  if (options.provider !== undefined && options.model !== undefined) {
    lines.push(t.newSessionConfirmModel(`${options.provider}/${options.model}`))
  }
  if (options.reasoningEffort !== undefined) lines.push(t.newSessionConfirmEffort(String(options.reasoningEffort)))
  if (options.workspace === undefined && options.agentPreset === undefined) lines.push(t.newSessionConfirmDefaults)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.newSessionConfirmTitle }, template: 'blue' },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        { tag: 'markdown', content: t.newSessionConfirmHint, text_size: 'notation' },
        { tag: 'hr' },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t.newSessionConfirmCreate },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { kind: NEW_SESSION_CONFIRM_ACTION } }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t.newSessionConfirmCancel },
          type: 'default',
          behaviors: [{ type: 'callback', value: { kind: NEW_SESSION_CANCEL_ACTION } }],
        },
      ],
    },
  }
}

/** The card a cancelled `/new` confirmation turns into (no buttons, no session). */
export function renderNewSessionCancelledCard(t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t.newSessionCancelledTitle }, template: 'grey' },
    body: { elements: [{ tag: 'markdown', content: t.newSessionCancelledBody }] },
  }
}
