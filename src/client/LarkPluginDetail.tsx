/**
 * The Lark channel's contributions to a Plugins detail page: the connection
 * badge beside the page title, the scan-to-configure control in the page
 * header, and the section under the page's own content that shows the live
 * connection state and the QR code an authorization run produces.
 *
 * The settings page keeps configuration only; everything about the live
 * channel lives here. Each entry answers the page's subject, so it renders
 * nothing for another plugin's bundle or row.
 *
 * The control is deliberately "scan to configure", not "reconnect": a forced
 * reconnect is unreachable from the browser — the Host's
 * `LarkRuntime.reconcile()` is fingerprint-gated (an unchanged connection
 * fingerprint returns without touching the channel) and every call site is
 * Host-side. Driving the real authorization flow is the one channel action
 * this page can actually perform.
 *
 * Every entry is a guard around a body: the guard decides the subject before
 * any hook runs, and the body is the component that subscribes. Calling the
 * selector hook behind an early return would change the hook order when the
 * page switches subjects, so the subscription lives in a child that mounts
 * only for this plugin — which also keeps another plugin's detail page from
 * starting this page's status reads.
 */

import * as React from 'react'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { QRCodeSVG } from 'qrcode.react'
import {
  isProvisionActive,
  type LarkChannelStatusFace,
  type LarkChannelStatusState,
} from './LarkChannelStatusController.ts'
import { isLarkSubject, type PluginDetailProps } from './plugin-detail-contract.ts'
import type { SnapshotSelectorHook } from './config-form-types.ts'

/** The component-side props: the subject, the status face, and locale copy. */
export type LarkDetailProps = PluginDetailProps & Omit<LarkChannelStatusFace, 'hooks'> & {
  useChannelStatus: SnapshotSelectorHook<LarkChannelStatusState>
  /** Localized copy, injected by the slots renderer from the locale namespace. */
  t: (key: string) => string
}

/** The pill's palette; each tone names one shipped appearance. */
type StatusTone = 'connected' | 'pending' | 'error' | 'idle'

/**
 * Connection state beside a detail page's title.
 * @param props - the open subject, the status snapshot, and locale copy.
 * @returns the status pill, or null for a subject that is not this plugin's.
 */
export function LarkConnectionBadge(props: LarkDetailProps): JSX.Element | null {
  if (!isLarkSubject(props.subject)) return null
  return <LarkConnectionBadgeBody {...props} />
}

/**
 * Page header control: start — or re-run — the scan-to-configure flow.
 * @param props - the open subject, the status snapshot, and locale copy.
 * @returns the control, or null for a subject that is not this plugin's.
 */
export function LarkConnectionAction(props: LarkDetailProps): JSX.Element | null {
  if (!isLarkSubject(props.subject)) return null
  return <LarkConnectionActionBody {...props} />
}

/**
 * The section under a detail page's own content: connection state and the
 * authorization QR code. The flow is started from the header control, so this
 * section carries no second button for the same thing.
 * @param props - the open subject, the status snapshot, and locale copy.
 * @returns the section, or null for a subject that is not this plugin's.
 */
export function LarkChannelSection(props: LarkDetailProps): JSX.Element | null {
  if (!isLarkSubject(props.subject)) return null
  return <LarkChannelSectionBody {...props} />
}

/** @param props - the bound status face and locale copy. @returns the status pill. */
function LarkConnectionBadgeBody(props: LarkDetailProps): JSX.Element {
  const state = props.useChannelStatus(snapshot => snapshot)
  return <StatusPill t={props.t} state={state} />
}

/** @param props - the bound status face and locale copy. @returns the scan control. */
function LarkConnectionActionBody(props: LarkDetailProps): JSX.Element {
  const { t } = props
  const state = props.useChannelStatus(snapshot => snapshot)
  const provision = state.provision
  // "Scan to configure" until a run has finished or the channel is already up;
  // after that the same control re-runs the flow.
  const repeated = provision.phase === 'done' || provision.phase === 'error' || state.runtime.state === 'connected'
  return <Button
    variant="outline"
    size="sm"
    disabled={state.provisioning || isProvisionActive(provision.phase)}
    onClick={() => { void props.startProvision() }}
  >
    {state.provisioning ? t('provisionStarting') : repeated ? t('rescan') : t('scanToConfigure')}
  </Button>
}

/** @param props - the bound status face and locale copy. @returns the connection section. */
function LarkChannelSectionBody(props: LarkDetailProps): JSX.Element {
  const { t } = props
  const state = props.useChannelStatus(snapshot => snapshot)
  const provision = state.provision
  return <section className="dsh-feishu-detail-section" aria-labelledby="dsh-feishu-connection-title">
    <div className="dsh-feishu-detail-head">
      <h4 id="dsh-feishu-connection-title">{t('connectionTitle')}</h4>
      <StatusPill t={t} state={state} />
    </div>
    <p className="dsh-feishu-detail-hint">{t('connectionHint')}</p>
    {provision.phase === 'waiting' && provision.qrUrl !== undefined ? (
      <div className="dsh-feishu-qr">
        <QRCodeSVG value={provision.qrUrl} size={220} marginSize={1} />
        <p>{t('scanHint')}</p>
        <code className="dsh-feishu-qr-link">{provision.qrUrl}</code>
      </div>
    ) : null}
    {provision.phase === 'configuring' ? <p className="dsh-feishu-detail">{t('provisioning')}</p> : null}
    {provision.phase === 'done' ? <p className="dsh-feishu-detail">{t('provisionDone')}</p> : null}
    {provision.phase === 'error'
      ? <p className="dsh-feishu-detail dsh-feishu-error">{t('provisionFailed')}{provision.message !== undefined ? `: ${provision.message}` : ''}</p>
      : null}
    {state.runtime.message !== undefined ? <p className="dsh-feishu-detail">{state.runtime.message}</p> : null}
    {state.notice !== '' ? <p className="dsh-feishu-detail dsh-feishu-error" role="status">{state.notice}</p> : null}
  </section>
}

/** One read-only status pill: a tone dot plus its localized label. */
function StatusPill({ t, state }: { t: (key: string) => string; state: LarkChannelStatusState }): JSX.Element {
  const label = t(statusLabelKey(state))
  return <span className="dsh-feishu-status" data-state={statusTone(state)} aria-label={label}>
    <StateDot state={statusDot(state)} size={8} />
    <span>{label}</span>
  </span>
}

/**
 * @param state - channel status. @returns the dictionary key for its label.
 *
 * `loading` wins over the reported state: before the first read settles the
 * runtime still holds its initial `connecting`, and claiming the channel is
 * connecting while nothing has been asked would be a guess.
 */
function statusLabelKey(state: LarkChannelStatusState): string {
  if (state.loading) return 'statusReading'
  switch (state.runtime.state) {
    case 'connected': return 'statusConnected'
    case 'connecting': return 'statusConnecting'
    case 'unconfigured': return 'statusUnconfigured'
    case 'stopped': return 'statusStopped'
    default: return 'statusOffline'
  }
}

/** @param state - channel status. @returns the pill's palette. */
function statusTone(state: LarkChannelStatusState): StatusTone {
  if (state.loading || state.runtime.state === 'connecting') return 'pending'
  switch (state.runtime.state) {
    case 'connected': return 'connected'
    case 'error': return 'error'
    default: return 'idle'
  }
}

/** @param state - channel status. @returns the state dot's tone. */
function statusDot(state: LarkChannelStatusState): StateDotState {
  if (state.loading) return 'ongoing'
  switch (state.runtime.state) {
    case 'connected': return 'done'
    case 'connecting': return 'ongoing'
    case 'error': return 'error'
    case 'unconfigured': return 'warning'
    default: return 'idle'
  }
}
