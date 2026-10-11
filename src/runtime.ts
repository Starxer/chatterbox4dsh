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
        this.snapshot = invalidConfig
          ? { state: 'unconfigured', message: redacted }
          : { state: 'error', message: redacted }
      }
    })
  }

  dispose(): Promise<void> {
    this.disposed = true
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
