/**
 * The two channel facts that have no native configuration equivalent: the live
 * Feishu connection state and the scan-to-configure flow. Both ride the
 * plugin's own bounded HTTP route, which is the only self-built surface left
 * now that every settings and credential write goes through DSH's native form
 * and credentials services.
 *
 * The Plugins detail page owns this controller; the settings page shows
 * configuration only. Reads are lazy and bounded by the viewers:
 *
 * - the first subscriber starts the status read, so a browser that never opens
 *   the plugin's detail page never touches the route;
 * - a provisioning run polls on a fixed cadence until it reaches a terminal
 *   phase, and the last subscriber leaving stops the poll as well;
 * - {@link dispose} stops it unconditionally.
 */

import type { Observable } from './config-form-types.ts'
import { SnapshotStore } from './snapshot-store.ts'

/** The plugin's bounded HTTP route: channel runtime state plus provisioning. */
export const CHANNEL_STATUS_PATH = '/dsh-feishu/provision'

/** Poll interval while the scan-to-configure flow is in flight. */
const PROVISION_POLL_MS = 2_000

/** Bound on one channel-status request; a hung request must not pin a pending promise. */
const CHANNEL_STATUS_TIMEOUT_MS = 10_000

/** Feishu connection state. */
export type RuntimeState = 'unconfigured' | 'connecting' | 'connected' | 'error' | 'stopped'
/** Scan-to-configure lifecycle. */
export type ProvisionPhase = 'idle' | 'waiting' | 'configuring' | 'done' | 'error'

/** Feishu connection state as the runtime reports it. */
export interface RuntimeStatus {
  state: RuntimeState
  message?: string
}

/** Scan-to-configure state as the provision manager reports it. */
export interface ProvisionState {
  phase: ProvisionPhase
  qrUrl?: string
  expireIn?: number
  message?: string
}

/** One channel status payload from the plugin's bounded HTTP route. */
export interface ChannelStatusPayload {
  runtime?: RuntimeStatus
  provision?: ProvisionState
  error?: string
}

/** Whether a provisioning run is still moving and therefore worth polling. */
export function isProvisionActive(phase: ProvisionPhase): boolean {
  return phase === 'waiting' || phase === 'configuring'
}

/** What the connection badge, the re-check control and the section render. */
export interface LarkChannelStatusState {
  /** True until the first status read settles, whatever its outcome. */
  loading: boolean
  /** Feishu connection state. */
  runtime: RuntimeStatus
  /** Scan-to-configure state. */
  provision: ProvisionState
  /** A provisioning start request is in flight. */
  provisioning: boolean
  /** Localized failure line, already translated; empty while the last read succeeded. */
  notice: string
}

/** The registration-side face the detail entries inject. */
export interface LarkChannelStatusFace {
  hooks: {
    /** Channel-status snapshot bound by the renderers as `useChannelStatus`. */
    channelStatus: Observable<LarkChannelStatusState>
  }
  /**
   * Start the scan-to-configure flow. The only action this plugin exposes for
   * the live channel: a forced reconnect is unreachable from the browser (the
   * Host's `LarkRuntime.reconcile()` is fingerprint-gated and every call site
   * is Host-side), so driving the real authorization flow is what a control
   * here can actually do.
   */
  startProvision: () => Promise<void>
}

/** Plugin-side collaborators the status controller cannot create itself. */
export interface LarkChannelStatusDeps {
  /**
   * Invoked once when a provisioning run reaches `done`. The Host writes the
   * secret at that moment, so the settings page re-reads its credential badge
   * rather than waiting for the forwarded credential event to arrive.
   */
  onProvisionCompleted?: () => void
}

/** Publishes the live channel status and drives the scan-to-configure flow. */
export class LarkChannelStatusController {
  private readonly store: SnapshotStore<LarkChannelStatusState>
  private readonly view: Observable<LarkChannelStatusState>
  private runtime: RuntimeStatus = { state: 'connecting' }
  private provision: ProvisionState = { phase: 'idle' }
  private loading = true
  private provisioning = false
  private statusFailed = false
  private noticeKey: string | undefined
  private noticeDetail: string | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private subscribers = 0
  private disposed = false

  /**
   * @param t - the plugin's dictionary translator.
   * @param deps - plugin-side collaborators; every one is optional.
   */
  constructor(
    private readonly t: (key: string) => string,
    private readonly deps: LarkChannelStatusDeps = {},
  ) {
    this.store = new SnapshotStore(this.projection())
    this.view = { getSnapshot: this.store.getSnapshot, subscribe: this.subscribe }
  }

  /**
   * Build the face the detail entries inject.
   * @returns the status observable and its actions.
   */
  face(): LarkChannelStatusFace {
    return {
      hooks: { channelStatus: this.view },
      startProvision: () => this.startProvision(),
    }
  }

  /**
   * Start the scan-to-configure flow and begin polling its progress.
   * @returns a promise settling when the start request is reported.
   */
  async startProvision(): Promise<void> {
    if (this.disposed) return
    this.provisioning = true
    this.clearNotice()
    this.publish()
    try {
      const response = await fetchChannelStatus({ method: 'POST', headers: { accept: 'application/json' } })
      const value = await response.json() as ChannelStatusPayload
      if (!response.ok) throw new Error(value.error ?? this.t('provisionFailed'))
      this.adoptStatus(value)
      this.loading = false
      this.beginPolling()
    } catch (error) {
      this.noticeDetail = messageOf(error)
      this.noticeKey = undefined
    } finally {
      this.provisioning = false
      this.publish()
    }
  }

  /** Stop the provisioning poll; the route reads carry their own abort deadline. */
  dispose(): void {
    this.disposed = true
    this.stopPolling()
  }

  /**
   * The view's `subscribe`: the first subscriber starts the read, the last one
   * ends the poll. Both halves are needed — the read keeps a page that never
   * polls fresh, and the poll must not outlive the page that asked for it.
   */
  private readonly subscribe = (listener: () => void): (() => void) => {
    const release = this.store.subscribe(listener)
    this.subscribers += 1
    if (this.subscribers === 1) void this.activate()
    return () => {
      release()
      this.subscribers -= 1
      if (this.subscribers === 0) this.stopPolling()
    }
  }

  /** Read the status once, then resume polling when a run is already in flight. */
  private async activate(): Promise<void> {
    await this.refreshStatus(false)
    if (!this.disposed && isProvisionActive(this.provision.phase)) this.beginPolling()
  }

  /**
   * Read the channel status route once.
   * @param polling - true for a poll tick, false for an on-demand read.
   */
  private async refreshStatus(polling: boolean): Promise<void> {
    if (this.disposed) return
    try {
      const response = await fetchChannelStatus({ headers: { accept: 'application/json' }, cache: 'no-store' })
      const value = await response.json() as ChannelStatusPayload
      if (!response.ok) throw new Error(value.error ?? this.t('loadFailed'))
      this.adoptStatus(value)
      if (this.statusFailed) {
        this.statusFailed = false
        this.noticeKey = undefined
        this.noticeDetail = undefined
      }
      // A notice raised by a refused provisioning *start* is deliberately kept:
      // only a new attempt or a successful run replaces it.
      const phase = this.provision.phase
      if (polling && !isProvisionActive(phase)) {
        this.stopPolling()
        if (phase === 'done') this.deps.onProvisionCompleted?.()
      }
    } catch (error) {
      this.statusFailed = true
      this.noticeKey = 'loadFailed'
      this.noticeDetail = messageOf(error)
    } finally {
      this.loading = false
      this.publish()
    }
  }

  /** @param value - a channel status payload; absent halves keep their last state. */
  private adoptStatus(value: ChannelStatusPayload): void {
    if (value.runtime !== undefined) this.runtime = value.runtime
    if (value.provision !== undefined) this.provision = value.provision
    this.publish()
  }

  /** Begin polling the channel status route on the fixed cadence. */
  private beginPolling(): void {
    if (this.disposed) return
    this.stopPolling()
    this.timer = setInterval(() => { void this.refreshStatus(true) }, PROVISION_POLL_MS)
  }

  /** Stop any provisioning poll. */
  private stopPolling(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Drop any staged notice (a new attempt invalidates the previous one). */
  private clearNotice(): void {
    this.noticeKey = undefined
    this.noticeDetail = undefined
    this.statusFailed = false
  }

  /** @returns the published status state. */
  private projection(): LarkChannelStatusState {
    return {
      loading: this.loading,
      runtime: this.runtime,
      provision: this.provision,
      provisioning: this.provisioning,
      notice: this.noticeText(),
    }
  }

  /** @returns the localized notice line. */
  private noticeText(): string {
    const head = this.noticeKey === undefined ? '' : this.t(this.noticeKey)
    if (this.noticeDetail === undefined || this.noticeDetail === '') return head
    return head === '' ? this.noticeDetail : `${head}: ${this.noticeDetail}`
  }

  /** Publish a fresh projection. */
  private publish(): void { this.store.set(this.projection()) }
}

/** @param error - a thrown value. @returns its message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One bounded request to the plugin's channel-status route. The route is
 * loopback-only, but a request that never settles would still leave a pending
 * promise behind, so every read carries its own abort deadline.
 * @param init - request init merged over the abort signal.
 * @returns the response.
 */
async function fetchChannelStatus(init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, CHANNEL_STATUS_TIMEOUT_MS)
  try {
    return await fetch(CHANNEL_STATUS_PATH, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
