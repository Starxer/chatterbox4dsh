/**
 * One-line notices for the context DSH injects into a running session.
 *
 * A DSH context injection is a durable `user/message` whose
 * `data.source.kind` is anything but `user` (the `MessageSourceMap` is
 * merge-extensible, so the set is open — 0.2.0-rc.1 has 17 real producers).
 * The WebUI renders each one as a collapsed row; this module reduces the same
 * metadata to a single line, which the owning step card carries at the very top
 * (see `docs/transcript-parity-design.md` §1.5).
 *
 * **The wording follows the WebUI's own row** (`ui-chat`'s
 * `ContextInjectionRow` + its `contextProducer` projection), because the same
 * event should read the same on both surfaces (operator's request, 2026-11-25):
 *
 * - title = the role the context plays — `上下文注入`, or `跨会话召回` for a
 *   `session-reference`;
 * - label = the producer: the recalled session labels for a recall, the changed
 *   paths for `agent-instructions`, the skill name for `skill-invocation`, and
 *   the durable `kind` for everything else (the WebUI deliberately keeps an
 *   unknown producer visible by its kind);
 * - a `form: 'notice'` producer's own one-line `summary` follows the label —
 *   that is the text the WebUI shows WITHOUT expanding the row.
 *
 * The injected CONTENT never reaches a card: it is model-facing text (6.2k
 * characters for one `AGENTS.md` baseline, measured 2026-09-28) and the user
 * asked for a notice, not a transcript. Every field read below is metadata
 * that DSH already puts in `source`.
 *
 * Three kinds are deliberately silent:
 *
 * - `user`               — the human's own message, not an injection;
 * - `compact-checkpoint` — the compaction transaction's replacement message,
 *                          which the compaction card already reports;
 * - `tool-jobs`          — already marked on the card as the turn's trigger
 *                          (关键坑 37 / O11), so it must not appear twice.
 *
 * Unknown kinds fall back to naming the kind, never to dumping fields: a
 * future producer must not be able to paste arbitrary text onto a card.
 *
 * @module @starxer/chatterbox4dsh/injection-notice
 */

import type { Translations } from './i18n.ts'

/** Kinds the notice line never renders (see the module doc). */
const SILENT_KINDS = new Set(['user', 'compact-checkpoint', 'tool-jobs'])

/** Longest `form: 'notice'` summary carried onto a card, in characters. */
const NOTICE_SUMMARY_CAP = 100

/** @returns the non-empty string fields of one record, in order. */
function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field !== '' ? field : undefined
}

/** @returns the distinct `path` values of an `agent-instructions` change list. */
function instructionPaths(source: Record<string, unknown>): string[] {
  if (!Array.isArray(source.changes)) return []
  const paths: string[] = []
  for (const change of source.changes) {
    const path = stringField(change, 'path')
    if (path !== undefined && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/** @returns the distinct `label` values of a `session-reference` list. */
function referenceLabels(source: Record<string, unknown>): string[] {
  if (!Array.isArray(source.references)) return []
  const labels: string[] = []
  for (const reference of source.references) {
    const label = stringField(reference, 'label') ?? stringField(reference, 'sessionId')
    if (label !== undefined && !labels.includes(label)) labels.push(label)
  }
  return labels
}

/** Cut a one-line summary to a card-friendly length. */
function clipSummary(summary: string): string {
  return summary.length > NOTICE_SUMMARY_CAP ? `${summary.slice(0, NOTICE_SUMMARY_CAP)}…` : summary
}

/**
 * The producer label, exactly as the WebUI's `contextProducer()` names it.
 *
 * `session-reference` names the recalled sessions, `agent-instructions` the
 * changed files, `skill-invocation` the skill — and every other kind keeps its
 * durable name. An unreadable label falls back to the kind for the same reason
 * the WebUI does: the producer must stay visible even when its details are not.
 */
function producerLabel(kind: string, source: Record<string, unknown>): string {
  switch (kind) {
    case 'session-reference': {
      const labels = referenceLabels(source)
      return labels.length === 0 ? kind : labels.join('、')
    }
    case 'agent-instructions': {
      const paths = instructionPaths(source)
      return paths.length === 0 ? kind : paths.join('、')
    }
    case 'skill-invocation': {
      const name = stringField(source, 'name')
      return name ?? kind
    }
    default:
      return kind
  }
}

/**
 * Render the notice line for one injected message.
 *
 * @param source - the event's `data.source` (any shape; nothing is trusted).
 * @param t - translations for the active locale, read at render time.
 * @returns the line to put at the top of the owning step card, or `undefined`
 *   when this message must not be announced.
 */
export function injectionNotice(source: unknown, t: Translations): string | undefined {
  if (source === null || typeof source !== 'object') return undefined
  const record = source as Record<string, unknown>
  const kind = record.kind
  if (typeof kind !== 'string' || kind === '' || SILENT_KINDS.has(kind)) return undefined

  const parts = [
    kind === 'session-reference' ? t.injectionRecall : t.injectionContext,
    producerLabel(kind, record),
  ]
  // A `form: 'notice'` producer (model-selection, plan-mode, a settled subagent,
  // …) ships the one line the WebUI shows without expanding the row. Metadata,
  // never content.
  const summary = stringField(record, 'summary')
  if (record.form === 'notice' && summary !== undefined) parts.push(clipSummary(summary))
  return parts.join(' · ')
}
