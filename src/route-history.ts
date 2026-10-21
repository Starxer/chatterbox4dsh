/**
 * Recent model routes of one session, newest first — the data behind `/model
 * last`, the quick "switch back to the model I used before this one" action.
 *
 * A route counts as used when the session log recorded a request header for it;
 * a `model/selection` event (a pick that has not run a request yet) also counts,
 * so switching twice in a row still walks the visible history. Consecutive
 * duplicates are one entry — the log appends a header per request series, not an
 * event per request.
 *
 * @module @starxer/chatterbox4dsh/route-history
 */

/** One model route as the session recorded it. */
export interface RouteEntry {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** A route plus the seq of the event that last named it. */
export interface RecentRoute extends RouteEntry {
  readonly seq: number
}

/** Structural view of one session event (only the fields this module reads). */
export interface RouteEventLike {
  readonly seq: number
  readonly type: string
  readonly data?: unknown
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Reduce one selection-shaped object to a route, or `undefined` when incomplete. */
function routeOf(value: unknown): RouteEntry | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const provider = record.provider
  const model = record.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  const effort = record.reasoningEffort
  return {
    provider,
    model,
    ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}),
  }
}

function sameRoute(a: RouteEntry, b: RouteEntry): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/**
 * Collect the distinct recent routes of one event window, newest first.
 *
 * @param events - a contiguous event window (oldest first), typically the tail
 *   of the session log.
 * @param limit - how many distinct routes to keep (default 6).
 * @returns the routes, newest first; `[]` when the window has none.
 */
export function collectRecentRoutes(events: readonly RouteEventLike[], limit = 6): RecentRoute[] {
  const ordered: RecentRoute[] = []
  for (const event of events) {
    let route: RouteEntry | undefined
    if (event.type === 'request/header') {
      route = routeOf(recordOf(event.data)?.header === undefined
        ? undefined
        : recordOf(recordOf(event.data)!.header)!.config)
    } else if (event.type === 'model/selection') {
      route = routeOf(event.data)
    }
    if (route === undefined) continue
    const previous = ordered[ordered.length - 1]
    if (previous !== undefined && sameRoute(previous, route)) continue
    ordered.push({ ...route, seq: event.seq })
  }
  return ordered.slice(-Math.max(1, limit)).reverse()
}
