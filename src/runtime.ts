import { connectionFingerprint, resolveRuntimeConfig } from './config.ts'
import type { RuntimeConfig, SettingsConfig } from './config.ts'
import type { LarkChannel, WSConnectionState } from '@larksuiteoapi/node-sdk'

/**
 * The inbound half of the link, read live from the channel.
 *
 * The snapshot below is a BOOT verdict: it says the WebSocket handshake
 * succeeded once, and nothing about now. A dropped long connection leaves it at
 * `connected` forever, which is the same lie the outbound half told during the
 * 2026-10-11 TLS outage — so both halves are reported, and the surface decides
 * what a mismatch means.
 */
export interface InboundStatus {
  /** WebSocket lifecycle as the channel reports it. */
  state: WSConnectionState
  /** Consecutive reconnect attempts in the current loop; 0 while connected. */
  reconnectAttempts: number
  /** ms epoch of the most recent connect attempt. */
  lastConnectTime?: number
  /** ms epoch of the next scheduled reconnect attempt. */
  nextConnectTime?: number
}

export type RuntimeStatus =
  | { state: 'unconfigured'; message: string; inbound?: InboundStatus }
  | { state: 'connecting'; inbound?: InboundStatus }
  | { state: 'connected'; inbound?: InboundStatus }
  | { state: 'error'; message: string; inbound?: InboundStatus }
  | { state: 'stopped'; inbound?: InboundStatus }

export interface LarkRuntimeStart {
  stop: () => Promise<void>
  channel: LarkChannel
}

/**
 * Backoff for a channel START that failed (ms).
 *
 * This is NOT the WebSocket dropping — the SDK reconnects that itself. It is
 * `start()` returning no channel at all: no bot identity, no DNS, credentials
 * briefly unreachable. Without a retry such a failure left the bot SILENTLY
 * offline until someone restarted the process. Real case (2026-10-23): the
 * host lost DNS, the 15:03 startup failed with `getaddrinfo ENOTFOUND
 * open.feishu.cn`, the network came back at 15:12, and the channel stayed dead
 * for 2 h 55 m — the plugin logged not one line in between — until a manual
 * restart at 17:58.
 *
 * The last entry is the steady-state interval. Retrying forever is deliberate:
 * the conditions this recovers from (no network, host suspended, link down)
 * are fixed by time, not by us.
 */
/**
 * Backoff before each channel start retry, in milliseconds.
 *
 * The first two slots are short on purpose: a boot-time WebSocket handshake
 * failure is usually a transient DNS/TLS hiccup right after the process starts,
 * and the operator experiences the whole window as "Feishu is dead". With a
 * 15 s handshake timeout a 5 s + 10 s backoff put recovery ~50 s out
 * (2026-11-20: two failed attempts, then `channel start recovered after 2
 * failed attempt(s)`); 2 s + 5 s brings the same recovery well under half a
 * minute. Later slots keep the long-exponential shape for real outages.
 */
export const CHANNEL_RETRY_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000] as const

/**
 * How long the inbound side may stay silent while the outbound side is busy
 * before the channel is presumed half-open.
 *
 * A half-open socket is the one failure the SDK cannot see: the TCP connection
 * stays ESTABLISHED, no FIN/RST arrives, and the server simply stops pushing
 * events — while our own HTTP calls (each one a fresh connection) keep working.
 * On a TCP-only transparent proxy this is the normal failure shape
 * (2026-11-20: `channel up` at 18:28:45, then zero inbound for 4.5 minutes
 * while `ss` showed three ESTABLISHED sockets and curl was fine).
 *
 * Five minutes is long enough that an ordinary "the user has not replied yet"
 * pause is not mistaken for death, and short enough that the operator does not
 * conclude the bot is gone.
 */
export const CHANNEL_HALF_OPEN_SILENCE_MS = 5 * 60_000

/** Only suspect half-open while we were OUTBOUND-active recently (someone is engaged). */
export const CHANNEL_HALF_OPEN_ACTIVE_WINDOW_MS = 10 * 60_000

/** Never rebuild more often than this, so a genuinely idle chat cannot churn. */
export const CHANNEL_HALF_OPEN_COOLDOWN_MS = 15 * 60_000

/**
 * Whether the channel looks half-open and should be rebuilt from scratch.
 *
 * The judgement uses only facts the plugin has: when it last sent something
 * (outbound activity) and when it last received anything (inbound activity).
 * Rebuilding on pure silence would churn on an idle night, so it is gated on
 * recent outbound activity — the operator replied to, or asked, something, and
 * then nothing came back.
 *
 * @param input - milliseconds timestamps; `0` means "never".
 * @returns whether a rebuild is due.
 */
export function halfOpenRebuildDue(input: {
  now: number
  lastInboundAt: number
  lastOutboundAt: number
  lastRebuildAt: number
  /**
   * When the CURRENT connection came up. A freshly connected socket has not had
   * time to receive anything, so "no inbound yet" must not be read as "silent
   * for five minutes" — without this, a bot that starts up and sends its notice
   * looked half-open one minute later (2026-11-20: a rebuild 59 s after
   * `channel up`, which then displaced the message handler).
   */
  lastConnectedAt: number
}): boolean {
  const { now, lastInboundAt, lastOutboundAt, lastRebuildAt, lastConnectedAt } = input
  // Nothing was sent yet: an idle channel is not evidence of anything.
  if (lastOutboundAt === 0) return false
  // Nobody is engaged; silence is expected rather than suspicious.
  if (now - lastOutboundAt > CHANNEL_HALF_OPEN_ACTIVE_WINDOW_MS) return false
  // Inbound is still moving (or moved recently enough). The clock starts at the
  // LATEST of "last inbound" and "connection came up".
  const silenceStart = Math.max(lastInboundAt, lastConnectedAt)
  if (now - silenceStart < CHANNEL_HALF_OPEN_SILENCE_MS) return false
  // Outbound activity has to be INSIDE the silence, not merely recent.
  //
  // A bot that answered a message and was then left alone is the common case,
  // not a fault: on 2026-11-23 the detector fired on exactly that (its 20:47:05
  // rebuild came 48 s after the last card and 5 min after the user's message —
  // a healthy channel, rebuilt for nothing). Half-open looks different: the
  // bot keeps talking (card writes, ticks) for minutes while nothing comes
  // back. Requiring the last outbound write to be at least halfway into the
  // silence keeps that signature and drops the "replied, then quiet" one.
  if (lastOutboundAt - silenceStart < CHANNEL_HALF_OPEN_SILENCE_MS / 2) return false
  if (lastRebuildAt !== 0 && now - lastRebuildAt < CHANNEL_HALF_OPEN_COOLDOWN_MS) return false
  return true
}

export interface LarkRuntimeDependencies {
  settings(): SettingsConfig
  resolveSecret(ref: string): Promise<string | undefined>
  start(config: RuntimeConfig): Promise<LarkRuntimeStart>
}

export class LarkRuntime {
  private current: { fingerprint: string; start: LarkRuntimeStart } | undefined
  private snapshot: RuntimeStatus = { state: 'unconfigured', message: 'App ID and App Secret are required' }
  private operations = Promise.resolve()
  private disposed = false
  /** Pending start-retry timer; at most one at a time. */
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  /** How many start retries failed in a row (0 while healthy). */
  private retryAttempt = 0
  /** Notified whenever the active Lark channel changes (initial connect or
   *  post-reconcile reconnect). The Feishu questions listener subscribes
   *  here so it always uses the channel's card send + cardAction handler. */
  onChannelChange?: (channel: LarkChannel) => void

  constructor(private readonly deps: LarkRuntimeDependencies) {}

  /**
   * The current status, plus the live inbound state of the channel it names.
   *
   * The inbound read is optional by construction: a stub channel in a test (or
   * an SDK that stops exposing the getter) must not break `/status` — the boot
   * verdict is still returned, just without the second half.
   */
  status(): RuntimeStatus {
    const base: RuntimeStatus = { ...this.snapshot }
    const status = this.current?.start.channel.getConnectionStatus?.()
    if (status === undefined) return base
    return {
      ...base,
      inbound: {
        state: status.state,
        reconnectAttempts: status.reconnectAttempts,
        ...status.lastConnectTime === undefined ? {} : { lastConnectTime: status.lastConnectTime },
        ...status.nextConnectTime === undefined ? {} : { nextConnectTime: status.nextConnectTime },
      },
    }
  }

  /**
   * Rebuild the live channel even though the configuration did not change.
   *
   * `reconcile()` short-circuits on an unchanged fingerprint, which is right for
   * settings writes but useless for a half-open socket: the connection is dead,
   * the config is not. Dropping `current` first makes the normal start path run
   * again (fresh handshake, fresh socket).
   *
   * @param reason - why, for the log line and the operator's journal.
   * @returns resolved once the new start settled (or failed and scheduled a retry).
   */
  restartChannel(reason: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return
      console.warn(`dsh-feishu: rebuilding the channel: ${reason}`)
      try {
        await this.stopCurrent()
      } catch {
        // A channel that cannot even stop is exactly the one worth replacing.
      }
      this.current = undefined
      this.snapshot = { state: 'connecting' }
      this.clearRetryTimer()
      this.retryAttempt = 0
    }).then(() => this.reconcile()).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('dsh-feishu: channel rebuild failed:', message)
    })
  }

  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return
      let secret: string | undefined
      let invalidConfig = false
      try {
        const settings = this.deps.settings()
        secret = await this.deps.resolveSecret(settings.appSecretRef) ?? settings.appSecret
        let config: RuntimeConfig
        try {
          config = resolveRuntimeConfig(settings, secret)
        } catch (error) {
          invalidConfig = true
          throw error
        }
        const fingerprint = connectionFingerprint(config)
        if (this.current?.fingerprint === fingerprint) return
        await this.stopCurrent()
        this.snapshot = { state: 'connecting' }
        const start = await this.deps.start(config)
        if (this.disposed) {
          await start.stop()
          return
        }
        this.current = { fingerprint, start }
        this.snapshot = { state: 'connected' }
        // Healthy again: a retry that was scheduled by an earlier failure must
        // not fire on top of a live channel, and the backoff restarts from the
        // shortest step if it ever fails again.
        this.clearRetryTimer()
        if (this.retryAttempt > 0) {
          console.warn(`dsh-feishu: channel start recovered after ${this.retryAttempt} failed attempt(s)`)
          this.retryAttempt = 0
        }
        this.onChannelChange?.(start.channel)
      } catch (error) {
        let failure = error
        if (invalidConfig) {
          try {
            await this.stopCurrent()
          } catch (stopError) {
            invalidConfig = false
            failure = stopError
          }
        }
        const message = failure instanceof Error ? failure.message : String(failure)
        const redacted = secret === undefined || secret === '' ? message : message.split(secret).join('[redacted]')
        console.error('dsh-feishu: reconcile failed:', redacted)
        if (invalidConfig) {
          // A missing/blank configuration cannot be fixed by waiting; retrying
          // it only floods the log.
          this.clearRetryTimer()
          this.retryAttempt = 0
          this.snapshot = { state: 'unconfigured', message: redacted }
          return
        }
        this.snapshot = { state: 'error', message: redacted }
        this.scheduleRetry()
      }
    })
  }

  /**
   * Schedule the next start attempt after a failed one.
   *
   * Single-flight by construction: a timer already pending is never replaced,
   * and a disposed runtime schedules nothing. The timer is `unref`ed so a
   * pending retry never keeps the process (or a test worker) alive.
   */
  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer !== undefined) return
    const attempt = this.retryAttempt + 1
    this.retryAttempt = attempt
    const index = Math.min(attempt - 1, CHANNEL_RETRY_BACKOFF_MS.length - 1)
    const delay = CHANNEL_RETRY_BACKOFF_MS[index]!
    console.warn(`dsh-feishu: channel start failed; retrying in ${delay}ms (attempt ${attempt})`)
    const timer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.disposed) return
      void this.reconcile()
    }, delay)
    timer.unref?.()
    this.retryTimer = timer
  }

  /** Drop a pending retry timer without touching the attempt counter. */
  private clearRetryTimer(): void {
    const timer = this.retryTimer
    this.retryTimer = undefined
    if (timer !== undefined) clearTimeout(timer)
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.clearRetryTimer()
    return this.enqueue(async () => {
      await this.stopCurrent()
      this.snapshot = { state: 'stopped' }
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation, operation)
    this.operations = result.catch(() => undefined)
    return result
  }

  private async stopCurrent(): Promise<void> {
    const current = this.current
    this.current = undefined
    if (current !== undefined) await current.start.stop()
  }
}
