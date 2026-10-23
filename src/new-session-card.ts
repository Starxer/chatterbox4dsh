/**
 * The cards of the `/new` card flow that are not pickers.
 *
 * The flow used to create the session the moment the model step was confirmed,
 * so a mis-clicked workspace/preset/model silently produced a session nobody
 * had seen assembled. Instead every setting is collected, the operator confirms
 * once, and only then is the session created.
 *
 * It also owns the SETTLEMENT cards: each step's picker is rewritten in place
 * into a short "✅ chosen: X" card as soon as the choice is made (see
 * {@link renderWorkspaceSettledCard}), so the operator sees the tap land
 * instead of a notice appended below a long list of rows.
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
 *
 * @param willCreate - the chosen workspace does not exist yet and the operator
 *   confirmed creating it; the card then says so, because the folder appears
 *   only when the create button is pressed.
 */
export function renderNewSessionConfirmCard(options: ChatCreationOptions, t: Translations, willCreate = false): object {
  const lines: string[] = []
  if (options.workspace !== undefined) lines.push(t.newSessionConfirmWorkspace(options.workspace))
  // Say it here rather than surprising them later: the folder is created by the
  // button below, together with the workspace registration (O16 + O19).
  if (willCreate && options.workspace !== undefined) lines.push(t.newSessionConfirmWillCreate(options.workspace))
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

// ---------------------------------------------------------------------------
// Settlement cards: the card where a step was decided is rewritten into one of
// these, in place (see `card-supersede.ts` mode `'replace'`).
// ---------------------------------------------------------------------------

/**
 * The shared shape of a step settlement card.
 *
 * It replaces the step's picker card entirely — a green header naming the
 * decision, then the decision, then one notation line saying to continue on the
 * newest card. The old shape (keep the picker, append a notice line, grey the
 * header) drew the change at the BOTTOM of a long list of rows, so a tap looked
 * like it did nothing. An answered question card is rewritten the same way.
 *
 * These cards carry no `behaviors` at all: a card that was edited in place
 * stops delivering button callbacks (关键坑 11), and there is nothing left to
 * decide on it anyway.
 */
function settledCard(title: string, lines: readonly string[], t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'green' },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        { tag: 'markdown', content: t.newSessionSettledHint, text_size: 'notation' },
      ],
    },
  }
}

/**
 * "✅ Workspace chosen — 📁 path" — the workspace picker (or the folder browser,
 * or the "create this missing path?" card) turns into this.
 *
 * @param willCreate - the path does not exist yet and is created together with
 *   the session (O16); the card says so, because nothing is on disk yet.
 */
export function renderWorkspaceSettledCard(workspace: string, willCreate: boolean, t: Translations): object {
  const lines = [t.newSessionSettledWorkspace(workspace)]
  if (willCreate) lines.push(t.newSessionSettledWillCreate)
  return settledCard(t.newSessionSettledWorkspaceTitle, lines, t)
}

/** "✅ Agent preset chosen — 🧩 name" — the preset picker turns into this. */
export function renderPresetSettledCard(preset: string, t: Translations): object {
  return settledCard(t.newSessionSettledPresetTitle, [t.newSessionSettledPreset(preset)], t)
}

/** "✅ Model chosen — 🔹 provider/model" — the model card turns into this. */
export function renderModelSettledCard(
  provider: string,
  model: string,
  reasoningEffort: string | undefined,
  t: Translations,
): object {
  const lines = [t.newSessionSettledModel(provider, model)]
  if (reasoningEffort !== undefined && reasoningEffort !== '') lines.push(t.modelSelectEffortLine(reasoningEffort))
  return settledCard(t.newSessionSettledModelTitle, lines, t)
}
