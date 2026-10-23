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
export const CHANNEL_RETRY_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000] as const

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
