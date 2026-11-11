/**
 * Local-path classification shared by the renderers and the document tools.
 *
 * The plugin runs on Linux, macOS and Windows, and the TEXT it classifies does
 * not: a model may write a POSIX path (`/tmp/a.png`) or a Windows one
 * (`C:\\shots\\a.png`, `\\\\server\\share\\a.png`) in the same message, and the
 * Markdown being converted is not bound to the host. `node:path`'s
 * `isAbsolute` only answers for the platform it runs on, so the drive/UNC half
 * is checked explicitly and every caller gets the same rule.
 *
 * @module @starxer/chatterbox4dsh/local-path
 */

import { isAbsolute } from 'node:path'

/** `C:\…` or `C:/…` — an absolute path on a Windows drive. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u
/** `\\server\share\…` — a UNC share (also covers the `\\?\` long-path prefix). */
const WINDOWS_UNC_PATH = /^\\\\[^\\]/u

/**
 * Whether a target is an absolute Windows path, on any host.
 *
 * `C:foo` (drive-relative) is deliberately not absolute, matching
 * `path.win32.isAbsolute`.
 *
 * @param target - a path-like string, as written by the model or the caller.
 */
export function isWindowsAbsolutePath(target: string): boolean {
  return WINDOWS_DRIVE_PATH.test(target) || WINDOWS_UNC_PATH.test(target)
}

/**
 * Whether a target names an absolute local path on any platform.
 *
 * @param target - a path-like string, as written by the model or the caller.
 */
export function isLocalAbsolutePath(target: string): boolean {
  return isAbsolute(target) || isWindowsAbsolutePath(target)
}
