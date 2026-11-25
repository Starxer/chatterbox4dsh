/**
 * The `description` argument every tool this plugin registers carries.
 *
 * Same contract the host's own `bash` / `subagent` tools use: a short caption the
 * UI shows on the tool row. On the Feishu side the minimal and compact turn cards
 * print it verbatim, so it has to read like a LABEL rather than like chat — the
 * operator's complaint on 2026-11-25 was that model prose such as "跑 typecheck 与
 * 单测" is too colloquial for a card, and a row without one fell back to a generic
 * action name that said even less.
 *
 * `required: true` on purpose: an optional caption is exactly the one the model
 * skips, and the card then has nothing to show but `读取`. The wording guidance is
 * in the parameter's own `description`, because that is the only place the model
 * reads when it decides what to write.
 *
 * @module @starxer/chatterbox4dsh/tool-caption
 */

/** Shared schema entry for the tool-row caption (spread into `parameters`). */
export const TOOL_CAPTION_PARAM = {
  type: 'string',
  required: true,
  description: 'Clear, concise description of what this call does, in active voice, 5-10 words '
    + '(shown in the chat UI). Use the language of the current conversation and neutral wording: '
    + 'no first person, no filler such as "just" / "quickly" / "basically", and no trailing punctuation. '
    + 'Examples: "Read the release notes" → "Read release notes"; '
    + '"Send the checklist to the user" → "Send test checklist".',
} as const
