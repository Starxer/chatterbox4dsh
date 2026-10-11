/**
 * The Lark settings page: the application credentials (with the write-only
 * secret), the access policy, and the card display.
 *
 * It is driven entirely by {@link LarkSettingsCardController}'s snapshot; the
 * component owns no state of its own and never talks to the Host directly.
 * The live channel — connection state and the scan-to-configure flow — is on
 * the Plugins detail page, which this page points at.
 */

import * as React from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { CARD_MEDIA_LIMIT, CARD_MEDIA_MAX_MB, DELIVER_DOC_MAX_MB, type CardMediaMaxField } from './LarkSettingsCardController.ts'
import type { LarkCardProps, LarkFormValues } from './LarkSettingsCardController.ts'

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

  /**
   * One numeric row of the three inline size limits. Bounds come from the
   * shared table so a field cannot drift from what the Host schema accepts.
   */
  const mediaMaxRow = (field: CardMediaMaxField, label: string, hint: string) => <label>
    <span>{label}</span>
    <Input aria-label={field} type="number" min={CARD_MEDIA_MAX_MB[field].min} max={CARD_MEDIA_MAX_MB[field].max} step={1} inputMode="numeric" disabled={blocked} value={form[field]} onChange={event => { props.edit(field, event.target.value) }} />
    <span className="dsh-feishu-toggle-hint">{hint}</span>
  </label>

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
        <p className="dsh-feishu-pointer">{t('connectionMoved')}</p>
      </div>
    </header>

    {state.status === 'loading' ? <p className="dsh-feishu-loading">{t('loading')}</p> : null}
    {state.status !== 'loading' ? <form onSubmit={event => { event.preventDefault(); void props.save() }}>
      <div className="dsh-feishu-card">
        <h3>{t('application')}</h3>
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
        {/* The work-detail level comes FIRST: it is the baseline the four
            switches below refine, so reading the block top-down matches how it
            is applied (level sets the ceiling, switches can only take away). */}
        <label><span>{t('transcriptView')}</span><select aria-label="transcriptView" disabled={blocked} value={form.transcriptView} onChange={event => { props.edit('transcriptView', event.target.value as LarkFormValues['transcriptView']) }}>
          <option value="compact">{t('transcriptViewCompact')}</option>
          <option value="standard">{t('transcriptViewStandard')}</option>
          <option value="detailed">{t('transcriptViewDetailed')}</option>
          <option value="verbose">{t('transcriptViewVerbose')}</option>
        </select><span className="dsh-feishu-toggle-hint">{t('transcriptViewHint')}</span></label>
        <label><span>{t('cardImages')}</span><select aria-label="cardImages" disabled={blocked} value={form.cardImages} onChange={event => { props.edit('cardImages', event.target.value as LarkFormValues['cardImages']) }}>
          <option value="workspace">{t('cardImagesWorkspace')}</option>
          <option value="text">{t('cardImagesText')}</option>
          <option value="any">{t('cardImagesAny')}</option>
        </select><span className="dsh-feishu-toggle-hint">{t('cardImagesHint')}</span></label>
        <label><span>{t('cardMediaLimit')}</span><Input aria-label="cardMediaLimit" type="number" min={CARD_MEDIA_LIMIT.min} max={CARD_MEDIA_LIMIT.max} step={1} inputMode="numeric" disabled={blocked} value={form.cardMediaLimit} onChange={event => { props.edit('cardMediaLimit', event.target.value) }} /><span className="dsh-feishu-toggle-hint">{t('cardMediaLimitHint')}</span></label>
        {mediaMaxRow('cardImageMaxMb', t('cardImageMaxMb'), t('cardImageMaxMbHint'))}
        {mediaMaxRow('cardVideoMaxMb', t('cardVideoMaxMb'), t('cardVideoMaxMbHint'))}
        {mediaMaxRow('cardAudioMaxMb', t('cardAudioMaxMb'), t('cardAudioMaxMbHint'))}
        <label><span>{t('deliverDocMaxMb')}</span><Input aria-label="deliverDocMaxMb" type="number" min={DELIVER_DOC_MAX_MB.min} max={DELIVER_DOC_MAX_MB.max} step={1} inputMode="numeric" disabled={blocked} value={form.deliverDocMaxMb} onChange={event => { props.edit('deliverDocMaxMb', event.target.value) }} /><span className="dsh-feishu-toggle-hint">{t('deliverDocMaxMbHint')}</span></label>
        <label><span>{t('produceCard')}</span><select aria-label="produceCard" disabled={blocked} value={form.produceCard} onChange={event => { props.edit('produceCard', event.target.value as LarkFormValues['produceCard']) }}>
          <option value="delivery">{t('produceCardDelivery')}</option>
          <option value="summary">{t('produceCardSummary')}</option>
          <option value="off">{t('produceCardOff')}</option>
        </select><span className="dsh-feishu-toggle-hint">{t('produceCardHint')}</span></label>
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
    </form> : null}
  </section>
}
