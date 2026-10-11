/**
 * Files a turn PRODUCED — the host-side mirror of the WebUI's `produced` set.
 *
 * The WebUI carries two independent delivery sources (`ui-deliverables`'s
 * `turn-deliverables.ts`), and they answer different questions:
 *
 * - **presented** — the model DECLARED these files for the user (DSH's `present`
 *   tool → the `deliverables/presented` event). That half is already wired here.
 * - **produced** — the turn actually WROTE these files: the arguments of a
 *   successful `write` / `edit` / `str_replace_editor` call, whether or not the
 *   model mentioned them anywhere.
 *
 * Feishu is a chat, not a file browser, so the full produced list is NOT
 * mirrored: in this repository it is overwhelmingly source files, tests and
 * `/tmp` scratch scripts the operator already owns (measured 2026-10-11: 69
 * produced paths against 3 presented ones in one session, every one of them a
 * workspace file). What a chat can actually use is the narrow slice that could
 * be *handed over* — media the card can inline and finished documents Feishu
 * can push as a file message — so {@link producedArtifacts} keeps only those and
 * the rest are dropped silently.
 *
 * Everything here is pure: the caller owns the session events, the file system
 * validation happens on the existing delivery path (`feishu-deliver.ts`), and
 * the mode switch is applied by the caller.
 *
 * @module @starxer/chatterbox4dsh/produced-files
 */

import { isAbsolute, resolve } from 'node:path'
import { classifyDeliverable, isMediaKind, type DeliverableKind } from './deliver-files.ts'

/**
 * The tools whose successful run means "this file was produced", with the same
 * argument rules as `ui-deliverables` so the two surfaces agree on what a
 * mutation is:
 *
 * - `write` needs a string `content` (a rejected call produces nothing);
 * - `edit` needs a non-empty `old_string` that actually differs from
 *   `new_string`, because that is what the tool itself requires;
 * - `str_replace_editor` counts only its mutating commands, validated the same
 *   way.
 *
 * A call missing its path, or malformed JSON, produces nothing rather than
 * throwing: these arguments come from a model.
 */
export const PRODUCED_FILE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'str_replace_editor'])

/** One file this turn wrote, in the order its result landed. */
export interface ProducedPath {
  path: string
  /** What the extension says it is; the delivery pipeline routes on this. */
  kind: DeliverableKind
}

/** A `tool/call` this module is waiting on a result for. */
export interface PendingProducedCall {
  /** The path the tool call is about to write, or `undefined` when it is not a mutation. */
  path: string | undefined
}

/** Narrow parsed JSON to an argument object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A non-blank path, kept exactly as the model spelled it. */
function pathOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * The path one tool call writes, or `undefined` when the call is not a file
 * mutation.
 *
 * @param name - wire tool name.
 * @param argsRaw - the call's raw `arguments` string.
 * @returns the path, or `undefined` when nothing is produced.
 */
export function mutationPathOf(name: string, argsRaw: unknown): string | undefined {
  if (!PRODUCED_FILE_TOOLS.has(name)) return undefined
  if (typeof argsRaw !== 'string' || argsRaw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw) as unknown
  } catch {
    return undefined
  }
  const args = asRecord(parsed)
  if (args === undefined) return undefined
  switch (name) {
    case 'write':
      return typeof args.content === 'string' ? pathOf(args.file_path) : undefined
    case 'edit':
      return typeof args.old_string === 'string'
        && args.old_string.length > 0
        && typeof args.new_string === 'string'
        && args.old_string !== args.new_string
        && (args.replace_all === undefined || typeof args.replace_all === 'boolean')
        ? pathOf(args.file_path)
        : undefined
    default: {
      const path = pathOf(args.path)
      if (path === undefined) return undefined
      switch (args.command) {
        case 'create':
          return typeof args.file_text === 'string' ? path : undefined
        case 'str_replace':
          return typeof args.old_str === 'string'
            && args.old_str.length > 0
            && (args.new_str === undefined || typeof args.new_str === 'string')
            ? path
            : undefined
        case 'insert':
          return typeof args.insert_line === 'number'
            && Number.isInteger(args.insert_line)
            && args.insert_line >= 0
            && typeof args.new_str === 'string'
            ? path
            : undefined
        default:
          return undefined
      }
    }
  }
}

/**
 * Record one `tool/call` so its result can be paired with it.
 *
 * @param name - wire tool name.
 * @param argsRaw - the call's raw `arguments` string.
 * @returns what to remember until `tool/result`.
 */
export function pendingProducedCall(name: string, argsRaw: unknown): PendingProducedCall {
  return { path: mutationPathOf(name, argsRaw) }
}

/**
 * Resolve one `tool/result` against its pending call.
 *
 * @param pending - the entry {@link pendingProducedCall} returned, if any.
 * @param isError - whether the tool reported a failure.
 * @returns the produced file, or `undefined` when this result produced nothing.
 */
export function settleProducedCall(
  pending: PendingProducedCall | undefined,
  isError: boolean,
): ProducedPath | undefined {
  if (pending === undefined || pending.path === undefined || isError) return undefined
  return { path: pending.path, kind: classifyDeliverable(pending.path) }
}

/**
 * The produced files a chat can actually use: media and documents, which are
 * the two families the delivery pipeline knows how to hand over. Source files,
 * tests, archives and everything else stay out — a chat message is the wrong
 * place for them and the operator already owns the workspace.
 *
 * The kind decision comes from the file name only; whether the file EXISTS,
 * sits inside the workspace and is small enough is decided by the delivery
 * planner, which is where the file system is touched.
 *
 * @param produced - every produced file of the turn, in order.
 * @returns the artifact subset, order preserved.
 */
export function producedArtifacts(produced: readonly ProducedPath[]): readonly ProducedPath[] {
  return produced.filter(file => isMediaKind(file.kind) || file.kind === 'document')
}

/**
 * Fold this turn's produced artifacts into the files the delivery pipeline
 * plans, so a produced-but-never-`present`ed artifact gets exactly the
 * treatment a presented one gets: media inlined on the card, documents under
 * `deliverDocMaxMb` pushed as native file messages, everything else offered as a
 * tap-to-send row.
 *
 * Deduplication compares RESOLVED paths, because the model writes a path the
 * way it likes (`out.png` vs `/abs/ws/out.png`) while `present` resolves to an
 * absolute one — comparing the raw strings would deliver the same file twice,
 * which is the whole reason `deliver-files.ts` keeps a sent-file tracker.
 *
 * @param presented - the turn's `present` declarations, as collected so far.
 * @param artifacts - {@link producedArtifacts} of the same turn.
 * @param workspace - the session workspace, used to resolve relative paths.
 * @returns the merged list; `presented` order first, then the new artifacts.
 */
export function mergeProducedArtifacts(
  presented: readonly { path: string; description?: string }[],
  artifacts: readonly ProducedPath[],
  workspace: string | undefined,
): readonly { path: string; description?: string }[] {
  if (artifacts.length === 0) return presented
  const root = workspace === undefined || workspace === '' ? undefined : workspace
  const seen = new Set<string>()
  for (const file of presented) seen.add(resolveKey(file.path, root))
  const merged = [...presented]
  for (const artifact of artifacts) {
    const key = resolveKey(artifact.path, root)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ path: artifact.path })
  }
  return merged
}

/**
 * The key two paths are compared by. Without a workspace a relative path cannot
 * be resolved, so it is only ever deduplicated against the identical string —
 * guessing a root would be worse than delivering one file twice.
 */
function resolveKey(path: string, root: string | undefined): string {
  if (isAbsolute(path)) return resolve(path)
  return root === undefined ? path : resolve(root, path)
}
