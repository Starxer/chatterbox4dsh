/**
 * One-line notices for the context DSH injects into a running session.
 *
 * A DSH context injection is a durable `user/message` whose
 * `data.source.kind` is anything but `user` (the `MessageSourceMap` is
 * merge-extensible, so the set is open — 0.2.0-rc.1 has 17 real producers).
 * The WebUI renders each one as a collapsed row titled by its producer; this
 * module reduces the same metadata to a single line, which the owning step card
 * carries at the very top (see `docs/transcript-parity-design.md` §1.5).
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

/**
 * The action label for an `agent-instructions` injection, using the WebUI's
 * own wording (`instructionAction(action, baseline)`).
 *
 * A `baseline` injection is the complete startup/resume set, so "已载入" is the
 * honest verb even though every change in it is a `set`.
 */
function instructionAction(t: Translations, source: Record<string, unknown>): string {
  if (source.baseline === true) return t.injectionActionLoaded
  const action = Array.isArray(source.changes)
    ? (source.changes[0] as { action?: unknown } | undefined)?.action
    : undefined
  switch (action) {
    case 'replace': return t.injectionActionUpdated
    case 'remove': return t.injectionActionRemoved
    case 'set': return t.injectionActionAdded
    // An unreadable action is reported as an update rather than a new file:
    // claiming "已新增" for a reconciliation we could not read would be wrong.
    default: return t.injectionActionUpdated
  }
}

/** @returns the non-empty string fields of one record, in order. */
function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field !== '' ? field : undefined
}

/** @returns a positive integer field, or undefined. */
function countField(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'number' && Number.isFinite(field) && field > 0 ? Math.trunc(field) : undefined
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

  // A `form: 'notice'` producer (model-selection, plan-mode, …) already ships a
  // one-line human summary — the same text the WebUI shows WITHOUT expanding the
  // row — so it is the right thing to print. This is metadata, not content.
  const form = record.form
  const summary = stringField(record, 'summary')

  switch (kind) {
    case 'agent-instructions': {
      const paths = instructionPaths(record)
      if (paths.length === 0) return t.injectionContext
      return `${t.injectionContext} · ${paths.join('、')}（${instructionAction(t, record)}）`
    }
    case 'skill-catalog': {
      const entries = Array.isArray(record.entries) ? record.entries.length : 0
      return `${t.injectionContext} · ${t.injectionSkillCatalog(entries)}`
    }
    case 'plugin': {
      const name = stringField(record, 'plugin')
      return name === undefined
        ? t.injectionContext
        : `${t.injectionContext} · ${t.injectionPlugin(name)}`
    }
    case 'runtime-context':
      return `${t.injectionContext} · ${t.injectionRuntimeSnapshot}`
    case 'session-reference': {
      const labels = referenceLabels(record)
      return labels.length === 0 ? t.injectionRecall : `${t.injectionRecall} · ${labels.join('、')}`
    }
    case 'skill-invocation': {
      const name = stringField(record, 'name')
      return name === undefined ? t.injectionSkillLoaded : `${t.injectionSkillLoaded} · ${name}`
    }
    case 'agent-message': {
      const sender = stringField(record, 'senderSessionId')
      return sender === undefined ? t.injectionRelay : `${t.injectionRelay} · ${t.injectionFromSession(sender)}`
    }
    case 'subagent-settled': {
      // Deliberately NOT the summary: it is a sentence about the subagent's work,
      // not an attribution, and the id is what identifies it.
      const sender = stringField(record, 'senderSessionId')
      return sender === undefined ? t.injectionSubagent : `${t.injectionSubagent} · ${t.injectionFromSession(sender)}`
    }
    case 'goal': {
      const round = countField(record, 'round')
      return round === undefined ? t.injectionGoal : `${t.injectionGoal} · ${t.injectionRound(round)}`
    }
    case 'user-approval':
      return `${t.injectionContext} · ${t.injectionApproval}`
    default:
      // Unknown producer: name the kind only. A `notice`-form producer's own
      // one-liner is safe to show (it is written for exactly this purpose) and
      // is far more useful than a bare kind name.
      if (form === 'notice' && summary !== undefined) {
        return `${t.injectionContext} · ${clipSummary(summary)}`
      }
      return `${t.injectionContext} · ${kind}`
  }
}
