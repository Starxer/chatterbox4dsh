/**
 * The Lark settings page: application credentials (with the write-only secret
 * and the scan-to-configure flow), the access policy, and the card display.
 * It is driven entirely by {@link LarkSettingsCardController}'s snapshot; the
 * component owns no state of its own and never talks to the Host directly.
 */

import * as React from 'react'
import { Button, Input, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { QRCodeSVG } from 'qrcode.react'
import type { LarkCardProps, LarkFormValues, RuntimeState } from './LarkSettingsCardController.ts'

/**
 * Render the plugin's one-liner or its settings page, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the settings page.
 */
export function LarkSettingsCard(props: LarkCardProps): JSX.Element | string {
  const { t } = props
  const state = props.useLarkSettings(snapshot => snapshot)
  if (props.view === 'summary') return t('subtitle')

  const form = state.form
  const blocked = !state.writable
  const toolsOff = !form.showToolCalls
  const provisionActive = state.provision.phase === 'waiting' || state.provision.phase === 'configuring'

  /** One labelled toggle row: title + one-line hint, control on the right. */
  const toggleRow = (options: {
    label: string
    hint: string
    checked: boolean
    onToggle: (next: boolean) => void
    disabled?: boolean
    nested?: boolean
  }) => <div className={options.nested === true ? 'dsh-feishu-toggle dsh-feishu-toggle-nested' : 'dsh-feishu-toggle'}>
    <span className="dsh-feishu-toggle-text">
      <span className="dsh-feishu-toggle-label">{options.label}</span>
      <span className="dsh-feishu-toggle-hint">{options.hint}</span>
    </span>
    <Switch
      checked={options.checked}
      onChange={options.onToggle}
      label={options.label}
      {...options.disabled === true
        // Only the args/results rows are gated by another switch, so only they
        // carry the "enable tool calls first" hint; a read-only page just
        // disables the control.
        ? { disabled: true, ...(options.nested === true ? { title: t('requiresToolCalls') } : {}) }
        : {}}
    />
  </div>

  return <section className="dsh-feishu-settings" aria-labelledby="dsh-feishu-title">
    <header className="dsh-feishu-header">
      <div>
        <h2 id="dsh-feishu-title">{t('title')}</h2>
        <p>{t('subtitle')}</p>
      </div>
      <div className="dsh-feishu-runtime" aria-label={t('runtimeStatus')}>
        <StateDot state={dotState(state.runtime.state)} size={8} />
        <span>{state.runtime.state}</span>
      </div>
    </header>

    {state.status === 'loading' ? <p className="dsh-feishu-loading">{t('loading')}</p> : null}
    {state.status !== 'loading' ? <form onSubmit={event => { event.preventDefault(); void props.save() }}>
      <div className="dsh-feishu-card">
        <h3>{t('application')}</h3>
        <div className="dsh-feishu-provision">
          <Button
            variant="outline"
            type="button"
            disabled={state.provisionBusy || provisionActive || blocked}
            onClick={() => { void props.startProvision() }}
          >
            {state.provisionBusy ? t('provisionStarting') : t('scanToConfigure')}
          </Button>
          {state.provision.phase === 'waiting' && state.provision.qrUrl !== undefined ? (
            <div className="dsh-feishu-qr">
              <QRCodeSVG value={state.provision.qrUrl} size={220} marginSize={1} />
              <p>{t('scanHint')}</p>
              <code className="dsh-feishu-qr-link">{state.provision.qrUrl}</code>
            </div>
          ) : null}
          {state.provision.phase === 'configuring' ? <p className="dsh-feishu-detail">{t('provisioning')}</p> : null}
          {state.provision.phase === 'error' ? <p className="dsh-feishu-detail dsh-feishu-error">{t('provisionFailed')}{state.provision.message !== undefined ? `: ${state.provision.message}` : ''}</p> : null}
        </div>
        <div className="dsh-feishu-grid">
          <label><span>{t('appId')}</span><Input aria-label="appId" disabled={blocked} value={form.appId} onChange={event => { props.edit('appId', event.target.value) }} autoComplete="off" /></label>
          <label><span>{t('domain')}</span><select aria-label="domain" disabled={blocked} value={form.domain} onChange={event => { props.edit('domain', event.target.value as LarkFormValues['domain']) }}><option value="feishu">Feishu</option><option value="lark">Lark</option></select></label>
        </div>
        <label><span>{t('appSecret')}</span><Input aria-label="appSecret" type="password" disabled={blocked || !state.secret.writable} value={state.secret.value} onChange={event => { props.setSecret(event.target.value) }} autoComplete="new-password" placeholder={t('secretPlaceholder')} /></label>
        <div
          className="dsh-feishu-credential"
          aria-label={state.secret.configured ? t('credentialConfigured') : t('credentialMissing')}
          data-state={state.secret.configured ? 'configured' : 'missing'}
        >
          <span className="dsh-feishu-credential-badge">
            <span className="dsh-feishu-credential-dot" aria-hidden="true" />
            {state.secret.configured ? t('credentialConfigured') : t('credentialMissing')}
          </span>
          {state.secret.source !== undefined ? <code>{state.secret.source}</code> : null}
          {!state.secret.writable ? <span>{t('readOnly')}</span> : null}
        </div>
      </div>

      <div className="dsh-feishu-card">
        <h3>{t('access')}</h3>
        {toggleRow({
          label: t('requireMention'),
          hint: t('requireMentionHint'),
          checked: form.requireMention,
          onToggle: next => { props.edit('requireMention', next) },
          disabled: blocked,
        })}
        <label><span>{t('dmMode')}</span><select aria-label="dmMode" disabled={blocked} value={form.dmMode} onChange={event => { props.edit('dmMode', event.target.value as LarkFormValues['dmMode']) }}><option value="open">{t('open')}</option><option value="allowlist">{t('allowlist')}</option><option value="disabled">{t('disabled')}</option></select></label>
        <div className="dsh-feishu-grid">
          <label><span>{t('groupAllowlist')}</span><textarea aria-label="groupAllowlist" disabled={blocked} value={form.groupAllowlist} onChange={event => { props.edit('groupAllowlist', event.target.value) }} placeholder={t('onePerLine')} /></label>
          <label><span>{t('dmAllowlist')}</span><textarea aria-label="dmAllowlist" disabled={blocked} value={form.dmAllowlist} onChange={event => { props.edit('dmAllowlist', event.target.value) }} placeholder={t('onePerLine')} /></label>
        </div>
        <label><span>{t('reactEmoji')}</span><Input aria-label="reactEmoji" disabled={blocked} value={form.reactEmoji} onChange={event => { props.edit('reactEmoji', event.target.value) }} placeholder={t('reactEmojiHint')} /></label>
      </div>

      <div className="dsh-feishu-card">
        <h3>{t('display')}</h3>
        {toggleRow({
          label: t('showReasoning'),
          hint: t('showReasoningHint'),
          checked: form.showReasoning,
          onToggle: next => { props.edit('showReasoning', next) },
          disabled: blocked,
        })}
        {toggleRow({
          label: t('showToolCalls'),
          hint: t('showToolCallsHint'),
          checked: form.showToolCalls,
          onToggle: next => { props.edit('showToolCalls', next) },
          disabled: blocked,
        })}
        {toggleRow({
          label: t('showToolArgs'),
          hint: t('showToolArgsHint'),
          checked: form.showToolArgs,
          onToggle: next => { props.edit('showToolArgs', next) },
          disabled: blocked || toolsOff,
          nested: true,
        })}
        {toggleRow({
          label: t('showToolResults'),
          hint: t('showToolResultsHint'),
          checked: form.showToolResults,
          onToggle: next => { props.edit('showToolResults', next) },
          disabled: blocked || toolsOff,
          nested: true,
        })}
        <label><span>{t('locale')}</span><select aria-label="locale" disabled={blocked} value={form.locale} onChange={event => { props.edit('locale', event.target.value as LarkFormValues['locale']) }}>
          <option value="auto">{t('localeAuto')}</option>
          <option value="zh">{t('localeZh')}</option>
          <option value="en">{t('localeEn')}</option>
        </select></label>
      </div>

      <footer className="dsh-feishu-actions">
        <Button variant="primary" type="submit" disabled={state.busy || blocked}>{state.busy ? t('saving') : t('save')}</Button>
        <Button variant="outline" type="button" disabled={state.busy || blocked || !state.secret.configured || !state.secret.writable} onClick={() => { void props.removeSecret() }}>{t('removeSecret')}</Button>
        <span role="status" aria-live="polite">{state.notice}</span>
      </footer>
      {state.runtime.message !== undefined ? <p className="dsh-feishu-detail">{state.runtime.message}</p> : null}
    </form> : null}
  </section>
}

/** @param state - Feishu connection state. @returns the state dot's tone. */
function dotState(state: RuntimeState): 'done' | 'error' | 'ongoing' | 'warning' {
  switch (state) {
    case 'connected': return 'done'
    case 'error': return 'error'
    case 'connecting': return 'ongoing'
    default: return 'warning'
  }
}
