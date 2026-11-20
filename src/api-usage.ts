/**
 * How many Feishu API calls this plugin makes, kept per day and per month.
 *
 * The open platform bills a **monthly quota** of API calls per app (the
 * operator saw a six-figure month in the console), and every card send, card
 * update, file upload or document read spends from it. The plugin never saw
 * that number before: there was no counter, so a feature that multiplies calls
 * (a per-second streaming preview, say) could burn a month's quota unnoticed.
 *
 * This module is the counter, not the enforcer: it records one increment per
 * outbound call, persists a small JSON file under the Harness home, and hands a
 * snapshot to `/status`. A budget rule can be built on top later; keeping the
 * numbers first is what makes such a rule possible at all.
 *
 * Counting happens when a call STARTS (`withLinkTimeout`), because that is the
 * one chokepoint every real Feishu request passes through. The number is the
 * plugin's own view: the console counts everything the app does, including
 * calls made before this build existed, so the two will not match — the point is
 * the *trend* and the per-kind breakdown.
 *
 * @module @starxer/chatterbox4dsh/api-usage
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One month/day of counts plus the busiest call labels of that month. */
export interface ApiUsageSnapshot {
  /** `YYYY-MM` of the current month bucket. */
  monthKey: string
  /** Calls recorded this month. */
  month: number
  /** `YYYY-MM-DD` of the current day bucket. */
  dayKey: string
  /** Calls recorded today. */
  today: number
  /** Busiest labels this month, descending, at most {@link SNAPSHOT_LABELS}. */
  labels: ReadonlyArray<{ label: string; count: number }>
}

/** On-disk shape. Versioned so a future change can migrate instead of guessing. */
interface UsageFile {
  version: 1
  monthKey: string
  month: number
  dayKey: string
  today: number
  /** `YYYY-MM-DD` → calls that day; pruned to the last {@link MAX_DAY_BUCKETS}. */
  days: Record<string, number>
  /** Call label (the `what` a call site passes) → calls this month. */
  labels: Record<string, number>
}

const FILE_VERSION = 1
/** Days of history kept on disk (about six weeks: enough to spot a trend). */
const MAX_DAY_BUCKETS = 40
/** Distinct labels kept; the plugin has a few dozen call sites, so this is slack. */
const MAX_LABELS = 64
/** Labels shown in a snapshot (`/status` prints a line, not a table). */
const SNAPSHOT_LABELS = 3
/** Debounce for the on-disk write: cards can fire dozens of calls a second. */
const DEFAULT_FLUSH_DELAY_MS = 2_000

/** `YYYY-MM` for a timestamp, in local time (the console reports local months). */
export function monthKeyOf(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** `YYYY-MM-DD` for a timestamp, in local time. */
export function dayKeyOf(ms: number): string {
  const date = new Date(ms)
  return `${monthKeyOf(ms)}-${String(date.getDate()).padStart(2, '0')}`
}

/** What {@link createApiUsage} needs; every field has a production default. */
export interface ApiUsageOptions {
  /** Absolute path of the JSON file; omit for a purely in-memory counter. */
  file?: string
  /** Clock, injectable for tests. */
  now?: () => number
  /** Warning sink (a bad file, an unwritable path); never throws. */
  log?: (message: string) => void
  /** Write debounce; pass `0` to write on every flush call without a timer. */
  flushDelayMs?: number
}

/** The counter handle. */
export interface ApiUsage {
  /** Count one outbound call. Cheap, synchronous, never throws. */
  record(label: string): void
  /** Current counts (rolls the day/month buckets over first). */
  snapshot(): ApiUsageSnapshot
  /** Write now (also what the debounce timer calls). */
  flush(): void
  /** Stop the timer and write pending counts. */
  dispose(): void
}

function emptyState(ms: number): UsageFile {
  return {
    version: FILE_VERSION,
    monthKey: monthKeyOf(ms),
    month: 0,
    dayKey: dayKeyOf(ms),
    today: 0,
    days: {},
    labels: {},
  }
}

/** Read the file, or start fresh; a corrupt file is set aside, never fatal. */
function loadState(file: string | undefined, nowMs: number, log?: (m: string) => void): UsageFile {
  const fresh = emptyState(nowMs)
  if (file === undefined) return fresh
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return fresh
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UsageFile>
    if (parsed.version !== FILE_VERSION
      || typeof parsed.monthKey !== 'string'
      || typeof parsed.month !== 'number'
      || typeof parsed.dayKey !== 'string'
      || typeof parsed.today !== 'number'
      || typeof parsed.days !== 'object' || parsed.days === null
      || typeof parsed.labels !== 'object' || parsed.labels === null) {
      throw new Error('unexpected shape')
    }
    const days: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed.days)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) days[key] = value
    }
    const labels: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed.labels)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) labels[key] = value
    }
    return {
      version: FILE_VERSION,
      monthKey: parsed.monthKey,
      month: parsed.month,
      dayKey: parsed.dayKey,
      today: parsed.today,
      days,
      labels,
    }
  } catch {
    // Pitfall 41: never let a bad state file poison the next boot — move it
    // aside (best effort) and start clean rather than guessing at fields.
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // ignore: the fresh state below still works
    }
    log?.('dsh-feishu: feishu API usage file was unreadable; starting a fresh count')
    return fresh
  }
}

/** Keep the newest {@link MAX_DAY_BUCKETS} day buckets. */
function pruneDays(days: Record<string, number>): Record<string, number> {
  const keys = Object.keys(days).sort()
  if (keys.length <= MAX_DAY_BUCKETS) return days
  const keep = keys.slice(keys.length - MAX_DAY_BUCKETS)
  const pruned: Record<string, number> = {}
  for (const key of keep) pruned[key] = days[key]!
  return pruned
}

/** Keep the busiest {@link MAX_LABELS} labels (drop the long tail). */
function pruneLabels(labels: Record<string, number>): Record<string, number> {
  const entries = Object.entries(labels)
  if (entries.length <= MAX_LABELS) return labels
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, MAX_LABELS))
}

/**
 * Create the counter.
 *
 * @param options - file path, clock, logger and flush debounce.
 * @returns the handle; {@link ApiUsage.dispose} must be called on plugin stop.
 */
export function createApiUsage(options: ApiUsageOptions = {}): ApiUsage {
  const now = options.now ?? (() => Date.now())
  const log = options.log
  const flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS
  const file = options.file
  const state = loadState(file, now(), log)
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false

  /** Move the month/day buckets to `ms` (called before every read and write). */
  const roll = (ms: number): void => {
    const monthKey = monthKeyOf(ms)
    if (monthKey !== state.monthKey) {
      state.monthKey = monthKey
      state.month = 0
      state.labels = {}
    }
    const dayKey = dayKeyOf(ms)
    if (dayKey !== state.dayKey) {
      state.dayKey = dayKey
      // A bucket loaded from disk may already hold calls for this day (the
      // process restarted mid-day), so resume from it instead of zeroing.
      state.today = state.days[dayKey] ?? 0
    }
    state.days[state.dayKey] = state.today
  }

  const writeNow = (): void => {
    if (!dirty) return
    dirty = false
    // Flush the in-memory day bucket into `days` before serializing: without
    // this the last recorded call would be missing from the persisted history
    // (the bucket is only synced on the NEXT record).
    rollToNow()
    if (file === undefined) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const payload: UsageFile = {
        ...state,
        days: pruneDays(state.days),
        labels: pruneLabels(state.labels),
      }
      const temporary = `${file}.tmp-${process.pid}`
      writeFileSync(temporary, `${JSON.stringify(payload)}\n`, 'utf8')
      renameSync(temporary, file)
    } catch (error: unknown) {
      log?.(`dsh-feishu: could not persist API usage: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const scheduleFlush = (): void => {
    dirty = true
    if (flushDelayMs <= 0) {
      writeNow()
      return
    }
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      writeNow()
    }, flushDelayMs)
    // Never hold the process open just to persist a counter.
    ;(timer as { unref?: () => void }).unref?.()
  }

  const rollToNow = (): void => {
    roll(now())
    state.days[state.dayKey] = state.today
  }

  return {
    record(label: string): void {
      rollToNow()
      state.month += 1
      state.today = (state.days[state.dayKey] ?? 0) + 1
      state.days[state.dayKey] = state.today
      state.labels[label] = (state.labels[label] ?? 0) + 1
      scheduleFlush()
    },
    snapshot(): ApiUsageSnapshot {
      rollToNow()
      const labels = Object.entries(state.labels)
        .sort((a, b) => b[1] - a[1])
        .slice(0, SNAPSHOT_LABELS)
        .map(([label, count]) => ({ label, count }))
      return { monthKey: state.monthKey, month: state.month, dayKey: state.dayKey, today: state.today, labels }
    },
    flush(): void {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      writeNow()
    },
    dispose(): void {
      // A dispose-time write is the last chance: the plugin is going away and
      // the timer would never fire. Kept synchronous on purpose — a debounce
      // timer in a shutting-down process loses the counts.
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      dirty = true
      writeNow()
    },
  }
}
