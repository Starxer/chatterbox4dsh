/**
 * Number formatting shared by every surface this plugin prints to.
 *
 * These used to be private copies: `formatTokenCount` existed five times and the
 * duration formatter five times, all with the same algorithm. Nothing enforced
 * that they stay equal, and two of them had already drifted (the panel table
 * version zero-pads the seconds and guards non-finite input; the card clock pads
 * without a space). One module means one answer per number, and a change to the
 * wording lands everywhere at once.
 *
 * Not folded in here on purpose:
 *
 * - `formatProgressMs` (`feishu-progress.ts`) — the turn card's clock, which
 *   pads and clamps differently from a table cell on purpose;
 * - `formatMsShort` (`feishu-streaming.ts`) — a reasoning header that only ever
 *   sees short spans.
 *
 * @module @starxer/chatterbox4dsh/format
 */

/**
 * A token count as the cards and `/status` print it: `517` / `12.2K` / `1.2M`.
 *
 * One decimal, trailing `.0` trimmed by the division (`Math.round(n / 100) / 10`),
 * which is why 1,015 reads `1K` and 1,234 reads `1.2K`.
 *
 * @param n - the count (tokens or API calls; the function does not care).
 * @returns the compact label.
 */
export function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

/**
 * A span as the status lines print it: `850ms` / `12.3s` / `1m40s`.
 *
 * A negative or non-finite span renders `—`: these are differences of two
 * timestamps, and a missing clock once printed `NaNms` (2026-11-25, found while
 * deduplicating this helper).
 *
 * @param ms - milliseconds.
 * @returns the short label.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return `${minutes}m${seconds}s`
}

/**
 * The panel-table flavour of {@link formatDuration}: `850ms` / `12.3s` / `1m 40s`.
 *
 * Kept separate because the job and subagent tables align their duration column
 * on a zero-padded seconds field with a space before it; that is a layout
 * decision of those tables, not a wording one.
 *
 * @param ms - milliseconds.
 * @returns the short label.
 */
export function formatDurationPadded(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}
