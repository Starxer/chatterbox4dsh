/**
 * The plugin's GLOBAL "recently used models" list — not a per-session log and
 * not DSH's global default.
 *
 * DSH has no cross-session recent-models service (only `agentDefaultModel`,
 * which is the single default), so the plugin keeps this list itself: one entry
 * per model route, newest first, persisted beside the chat→session map and
 * bounded. It is fed by every route the plugin actually applies (a `/model`
 * switch, a card pick, a `/new` creation, a quick "back to last used") and by
 * the `request/header` a bound Session records, so a model used in one Feishu
 * session also shows up in another's picker.
 *
 * Identity is `provider + model`: the reasoning effort is a property of the
 * most recent use, not a separate "recent model", otherwise three efforts of
 * the same model would fill the whole shortlist.
 *
 * @module @starxer/chatterbox4dsh/recent-models
 */

/** One remembered model route. */
export interface RecentModelEntry {
  readonly provider: string
  readonly model: string
  /** Effort that came with the most recent use of this model, when it had one. */
  readonly reasoningEffort?: string
  /** Epoch ms of the most recent use, used for ordering diagnostics only. */
  readonly usedAt: number
}

/** A route without its bookkeeping fields. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** How many entries the persisted list keeps (the card shows the top 3). */
export const RECENT_MODEL_MEMORY = 12

/** How many entries the picker card offers. */
export const RECENT_MODEL_PICKS = 3

/** A persisted value is only used when it still has a usable route. */
export function isRecentModelEntry(value: unknown): value is RecentModelEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.provider !== 'string' || record.provider === '') return false
  if (typeof record.model !== 'string' || record.model === '') return false
  if (typeof record.usedAt !== 'number' || !Number.isFinite(record.usedAt)) return false
  return record.reasoningEffort === undefined || typeof record.reasoningEffort === 'string'
}

/**
 * Put `route` at the front of the list, dropping any earlier entry for the same
 * provider+model and trimming the tail to `limit`.
 *
 * @param list - the current list, newest first.
 * @param route - the route that was just used.
 * @param now - epoch ms for `usedAt`.
 * @param limit - maximum entries kept (default {@link RECENT_MODEL_MEMORY}).
 * @returns a new list; never mutates the input.
 */
export function rememberModel(
  list: readonly RecentModelEntry[],
  route: ModelRoute,
  now: number,
  limit = RECENT_MODEL_MEMORY,
): RecentModelEntry[] {
  const front: RecentModelEntry = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined || route.reasoningEffort === ''
      ? {}
      : { reasoningEffort: route.reasoningEffort }),
    usedAt: now,
  }
  const next: RecentModelEntry[] = [front]
  for (const entry of list) {
    if (entry.provider === route.provider && entry.model === route.model) continue
    next.push(entry)
    if (next.length >= Math.max(1, limit)) break
  }
  return next
}

/**
 * Merge the global list with routes read from one Session's own log, newest
 * first, de-duplicated by provider+model.
 *
 * The Session's log is what makes the first picker open after a restart useful:
 * the global memory only contains routes the plugin applied itself, while the
 * log still holds what this chat actually ran. The merged entries are NOT
 * filtered against the current route — the current model is a recent use too,
 * so the card shows it marked instead of dropping it (with a single known route
 * filtering it out left the whole section empty).
 *
 * @param globals - globally remembered routes, newest first.
 * @param sessionRoutes - routes read from this Session's log, newest first.
 * @param limit - how many entries to return (default {@link RECENT_MODEL_PICKS}).
 * @returns up to `limit` distinct routes.
 */
export function mergeRecentModels(
  globals: readonly RecentModelEntry[],
  sessionRoutes: readonly ModelRoute[],
  limit = RECENT_MODEL_PICKS,
): RecentModelEntry[] {
  const picked: RecentModelEntry[] = []
  const seen = new Set<string>()
  const push = (route: ModelRoute, usedAt: number): void => {
    const key = `${route.provider}/${route.model}`
    if (seen.has(key)) return
    seen.add(key)
    picked.push({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined || route.reasoningEffort === ''
        ? {}
        : { reasoningEffort: route.reasoningEffort }),
      usedAt,
    })
  }
  for (const entry of globals) push(entry, entry.usedAt)
  // Session-log routes carry no timestamp of their own; order them after the
  // global entries, which are already newest-first.
  for (const route of sessionRoutes) push(route, 0)
  return picked.slice(0, Math.max(1, limit))
}

/**
 * The shortlist for the picker: newest first, de-duplicated by provider+model,
 * with the route the Session already runs left out.
 *
 * @param list - the remembered list, newest first.
 * @param exclude - the Session's current route (it must not be offered again).
 * @param limit - how many entries to return (default {@link RECENT_MODEL_PICKS}).
 * @returns up to `limit` distinct routes; `[]` when nothing is left.
 */
export function topRecentModels(
  list: readonly RecentModelEntry[],
  exclude: ModelRoute | undefined,
  limit = RECENT_MODEL_PICKS,
): RecentModelEntry[] {
  const picked: RecentModelEntry[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (exclude !== undefined && entry.provider === exclude.provider && entry.model === exclude.model) continue
    const key = `${entry.provider}/${entry.model}`
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(entry)
    if (picked.length >= Math.max(1, limit)) break
  }
  return picked
}
