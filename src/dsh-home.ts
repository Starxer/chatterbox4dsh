/**
 * Where the Harness keeps per-user state: `$DSH_HOME`, else `~/.dsh`.
 *
 * Ask the host first. `app-boot` provides `dshHomePath`, and that answer is the
 * one the rest of the Harness uses, so writing anywhere else silently forks the
 * state (关键坑 51): the plugin restarts with an empty session map while the old
 * one still sits on disk, and the chat quietly falls back to a hashed default
 * session. The environment/home pair stays only as a fallback for hosts that do
 * not expose the service.
 *
 * `ctx.get` rather than `inject`: a host without the service must still boot
 * (关键坑 2). Every path is joined with `node:path` — string-concatenating
 * `/.dsh` produces mixed separators on Windows.
 *
 * @module @starxer/chatterbox4dsh/dsh-home
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The one context method this module needs (never required at boot). */
export interface DshHomeContext {
  get?: (name: string) => unknown
}

/**
 * Resolve the Harness home directory.
 *
 * @param ctx - plugin context; `dshHomePath` is used when the host provides it.
 * @returns absolute path, with no trailing separator.
 */
export function resolveDshHome(ctx?: DshHomeContext): string {
  try {
    const provided = ctx?.get?.('dshHomePath')
    if (typeof provided === 'function') {
      const home = (provided as (...segments: string[]) => string)()
      if (typeof home === 'string' && home !== '') return home
    }
  } catch {
    // fall through to the env/home fallback
  }
  const env = process.env.DSH_HOME
  if (env !== undefined && env !== '') return env
  return join(homedir(), '.dsh')
}

/**
 * Resolve one of the plugin's state files under the Harness home.
 *
 * @param ctx - plugin context (see {@link resolveDshHome}).
 * @param name - file name, never a path.
 */
export function dshHomeFile(ctx: DshHomeContext | undefined, name: string): string {
  return join(resolveDshHome(ctx), name)
}
