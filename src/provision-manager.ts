import { provisionApp } from './provision.ts'
import type { ProvisionResult, ProvisionState } from './provision.ts'
import type { DomainName } from './config.ts'

/**
 * How long the authorization service may take to hand back the QR URL.
 *
 * `registerApp`'s first request (`begin`) has **no timeout of its own** — the
 * AbortSignal we pass only reaches the polling half — so a machine that cannot
 * reach `open.feishu.cn` (proxy, VPN, firewall) leaves the promise pending
 * forever. Until this deadline existed the panel rendered nothing while that
 * happened: no QR, no spinner, no error (the state was `waiting` without a
 * `qrUrl`), which reads exactly like "扫码窗口打不开". Fail loudly instead —
 * the retry control is usable again as soon as the state is `error`.
 */
export const PROVISION_START_TIMEOUT_MS = 30_000

export interface ProvisionManagerDeps {
  domain(): DomainName
  onState(state: ProvisionState): void
  onProvisioned(result: ProvisionResult): Promise<void>
  /** Override the QR deadline; tests use a short one. */
  startTimeoutMs?: number
}

/**
 * Owns the scan-to-configure lifecycle: at most one in-flight flow, cancellable
 * via {@link dispose}, reporting each transition through {@link onState} and
 * writing credentials back through {@link onProvisioned}.
 */
export class ProvisionManager {
  private controller: AbortController | undefined
  private state: ProvisionState = { phase: 'idle' }
  private startTimer: ReturnType<typeof setTimeout> | undefined
  /** Identifies the current run, so a timer or a late settle from an older one is ignored. */
  private attempt = 0
  private readonly startTimeoutMs: number

  constructor(private readonly deps: ProvisionManagerDeps) {
    this.startTimeoutMs = deps.startTimeoutMs ?? PROVISION_START_TIMEOUT_MS
  }

  status(): ProvisionState {
    return { ...this.state }
  }

  isRunning(): boolean {
    return this.controller !== undefined
  }

  start(): ProvisionState {
    if (this.controller !== undefined) return this.status()
    const controller = new AbortController()
    this.controller = controller
    this.attempt += 1
    this.setState({ phase: 'waiting' })
    this.armStartDeadline(this.attempt, controller)
    void this.run(controller, this.attempt)
    return this.status()
  }

  dispose(): void {
    this.cancelStartDeadline()
    this.attempt += 1
    this.controller?.abort()
    this.controller = undefined
    if (this.state.phase !== 'idle') this.setState({ phase: 'idle' })
  }

  private armStartDeadline(attempt: number, controller: AbortController): void {
    this.cancelStartDeadline()
    const timer = setTimeout(() => {
      this.startTimer = undefined
      // Only the run that armed this timer may be timed out.
      if (this.attempt !== attempt || this.controller !== controller) return
      this.attempt += 1
      this.controller = undefined
      controller.abort()
      this.setState({
        phase: 'error',
        errorCode: 'start-timeout',
        message: `no QR code from the Feishu authorization service within ${Math.round(this.startTimeoutMs / 1000)}s`
          + ' — check that this machine can reach open.feishu.cn (proxy/VPN/firewall), then retry',
      })
    }, this.startTimeoutMs)
    // Never keep the process alive for a deadline that only matters while a
    // browser page is open.
    timer.unref?.()
    this.startTimer = timer
  }

  private cancelStartDeadline(): void {
    if (this.startTimer === undefined) return
    clearTimeout(this.startTimer)
    this.startTimer = undefined
  }

  private setState(next: ProvisionState): void {
    this.state = next
    this.deps.onState(next)
  }

  private async run(controller: AbortController, attempt: number): Promise<void> {
    try {
      const result = await provisionApp({
        domain: this.deps.domain(),
        signal: controller.signal,
        onState: state => {
          if (this.attempt !== attempt) return
          // A QR URL means the service answered; only the pre-QR wait is timed.
          if (state.qrUrl !== undefined || state.phase !== 'waiting') this.cancelStartDeadline()
          this.setState(state)
        },
      })
      // A timed-out or disposed run must not resurrect itself when the SDK
      // finally settles (the `begin` request ignores the abort signal).
      if (this.attempt !== attempt) return
      this.cancelStartDeadline()
      this.controller = undefined
      this.setState({ phase: 'done' })
      await this.deps.onProvisioned(result)
    } catch (error) {
      if (this.attempt !== attempt) return
      this.cancelStartDeadline()
      const aborted = controller.signal.aborted
      this.controller = undefined
      if (aborted) {
        this.setState({ phase: 'idle' })
      } else {
        this.setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
