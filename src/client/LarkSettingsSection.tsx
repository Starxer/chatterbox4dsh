import * as React from 'react'
import { Button, Input, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { QRCodeSVG } from 'qrcode.react'

type Translate = (key: string) => string
type RuntimeState = 'unconfigured' | 'connecting' | 'connected' | 'error' | 'stopped'
type ProvisionPhase = 'idle' | 'waiting' | 'configuring' | 'done' | 'error'
type PluginLocale = 'auto' | 'zh' | 'en'

interface ProvisionState {
  phase: ProvisionPhase
  qrUrl?: string
  expireIn?: number
  message?: string
}

interface SettingsPayload {
  revision: number
  settings: {
    appId: string
    domain: 'feishu' | 'lark'
    requireMention: boolean
    dmMode: 'open' | 'allowlist' | 'disabled'
    groupAllowlist: string[]
    dmAllowlist: string[]
    reactEmoji: string
    showReasoning: boolean
    showToolCalls: boolean
    showToolArgs: boolean
    showToolResults: boolean
    locale: PluginLocale
  }
  credential: { configured: boolean; source?: string; writable: boolean }
  runtime: { state: RuntimeState; message?: string }
  provision: ProvisionState
}

interface FormState {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  requireMention: boolean
  dmMode: 'open' | 'allowlist' | 'disabled'
  groupAllowlist: string
  dmAllowlist: string
  reactEmoji: string
  showReasoning: boolean
  showToolCalls: boolean
  showToolArgs: boolean
  showToolResults: boolean
  locale: PluginLocale
}

interface LarkSettingsSectionProps {
  t: Translate
}

const EMPTY_FORM: FormState = {
  appId: '', appSecret: '', domain: 'feishu', requireMention: true, dmMode: 'open',
  groupAllowlist: '', dmAllowlist: '', reactEmoji: '',
  showReasoning: true, showToolCalls: true, showToolArgs: true, showToolResults: true, locale: 'auto',
}

export function LarkSettingsSection({ t }: LarkSettingsSectionProps): JSX.Element {
  const [payload, setPayload] = React.useState<SettingsPayload | null>(null)
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [provision, setProvision] = React.useState<ProvisionState | null>(null)
  const [provisionBusy, setProvisionBusy] = React.useState(false)
  const provisionPoll = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = React.useCallback(() => {
    if (provisionPoll.current !== null) {
      clearInterval(provisionPoll.current)
      provisionPoll.current = null
    }
  }, [])

  const adopt = React.useCallback((next: SettingsPayload) => {
    setPayload(next)
    setProvision(next.provision)
    setForm({
      appId: next.settings.appId,
      appSecret: '',
      domain: next.settings.domain,
      requireMention: next.settings.requireMention,
      dmMode: next.settings.dmMode,
      groupAllowlist: next.settings.groupAllowlist.join('\n'),
      dmAllowlist: next.settings.dmAllowlist.join('\n'),
      reactEmoji: next.settings.reactEmoji,
      showReasoning: next.settings.showReasoning ?? true,
      showToolCalls: next.settings.showToolCalls ?? true,
      showToolArgs: next.settings.showToolArgs ?? true,
      showToolResults: next.settings.showToolResults ?? true,
      locale: next.settings.locale ?? 'auto',
    })
  }, [])

  const loadSettings = React.useCallback(async () => {
    try {
      const response = await fetch('/dsh-feishu/settings', { headers: { accept: 'application/json' }, cache: 'no-store' })
      const value = await response.json() as SettingsPayload & { error?: string }
      if (!response.ok) throw new Error(value.error ?? t('loadFailed'))
      adopt(value)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [adopt, t])

  React.useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  React.useEffect(() => () => stopPolling(), [stopPolling])

  const beginPolling = React.useCallback(() => {
    stopPolling()
    provisionPoll.current = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch('/dsh-feishu/provision', { headers: { accept: 'application/json' }, cache: 'no-store' })
          const value = await response.json() as ProvisionState & { error?: string }
          if (!response.ok) throw new Error(value.error ?? t('provisionFailed'))
          setProvision(value)
          if (value.phase === 'done' || value.phase === 'error' || value.phase === 'idle') {
            stopPolling()
            if (value.phase === 'done') void loadSettings()
          }
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        }
      })()
    }, 2000)
  }, [stopPolling, loadSettings, t])

  const startProvision = async () => {
    setProvisionBusy(true)
    setNotice('')
    try {
      const response = await fetch('/dsh-feishu/provision', { method: 'POST', headers: { accept: 'application/json' } })
      const value = await response.json() as ProvisionState & { error?: string }
      if (!response.ok) throw new Error(value.error ?? t('provisionFailed'))
      setProvision(value)
      beginPolling()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setProvisionBusy(false)
    }
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm(current => ({ ...current, [key]: value }))
  const lines = (value: string) => value.split(/\n/u).map(item => item.trim()).filter(Boolean)

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setNotice(t('saving'))
    const body: Record<string, unknown> = {
      expectedRevision: payload?.revision,
      appId: form.appId.trim(), domain: form.domain, requireMention: form.requireMention, dmMode: form.dmMode,
      groupAllowlist: lines(form.groupAllowlist), dmAllowlist: lines(form.dmAllowlist), reactEmoji: form.reactEmoji,
      showReasoning: form.showReasoning, showToolCalls: form.showToolCalls,
      showToolArgs: form.showToolArgs, showToolResults: form.showToolResults, locale: form.locale,
    }
    if (form.appSecret !== '') body.appSecret = form.appSecret
    try {
      const response = await fetch('/dsh-feishu/settings', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const value = await response.json() as SettingsPayload & { error?: string }
      if (!response.ok) throw new Error(value.error ?? t('saveFailed'))
      adopt(value)
      setNotice(t('saved'))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const removeSecret = async () => {
    setBusy(true)
    setNotice(t('removing'))
    try {
      const response = await fetch('/dsh-feishu/settings', { method: 'DELETE', headers: { accept: 'application/json' } })
      const value = await response.json() as SettingsPayload & { error?: string }
      if (!response.ok) throw new Error(value.error ?? t('removeFailed'))
      adopt(value)
      setNotice(t('removed'))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const runtimeState = payload?.runtime.state ?? 'connecting'
  const dotState = runtimeState === 'connected' ? 'done' : runtimeState === 'error' ? 'error' : runtimeState === 'connecting' ? 'ongoing' : 'warning'
  const toolsOff = !form.showToolCalls

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
      {...options.disabled === true ? { disabled: true, title: t('requiresToolCalls') } : {}}
    />
  </div>

  return <section className="dsh-feishu-settings" aria-labelledby="dsh-feishu-title">
    <header className="dsh-feishu-header">
      <div>
        <h2 id="dsh-feishu-title">{t('title')}</h2>
        <p>{t('subtitle')}</p>
      </div>
      <div className="dsh-feishu-runtime" aria-label={t('runtimeStatus')}>
        <StateDot state={dotState} size={8} />
        <span>{runtimeState}</span>
      </div>
    </header>

    {payload === null && notice === '' ? <p className="dsh-feishu-loading">{t('loading')}</p> : null}
    {payload !== null ? <form onSubmit={save}>
      <div className="dsh-feishu-card">
        <h3>{t('application')}</h3>
        <div className="dsh-feishu-provision">
          <Button variant="outline" type="button" disabled={provisionBusy || provision?.phase === 'waiting' || provision?.phase === 'configuring'} onClick={startProvision}>
            {provisionBusy ? t('provisionStarting') : t('scanToConfigure')}
          </Button>
          {provision?.phase === 'waiting' && provision.qrUrl !== undefined ? (
            <div className="dsh-feishu-qr">
              <QRCodeSVG value={provision.qrUrl} size={220} marginSize={1} />
              <p>{t('scanHint')}</p>
              <code className="dsh-feishu-qr-link">{provision.qrUrl}</code>
            </div>
          ) : null}
          {provision?.phase === 'configuring' ? <p className="dsh-feishu-detail">{t('provisioning')}</p> : null}
          {provision?.phase === 'error' ? <p className="dsh-feishu-detail dsh-feishu-error">{t('provisionFailed')}{provision.message !== undefined ? `: ${provision.message}` : ''}</p> : null}
        </div>
        <div className="dsh-feishu-grid">
          <label><span>{t('appId')}</span><Input aria-label="appId" value={form.appId} onChange={event => update('appId', event.target.value)} autoComplete="off" /></label>
          <label><span>{t('domain')}</span><select aria-label="domain" value={form.domain} onChange={event => update('domain', event.target.value as FormState['domain'])}><option value="feishu">Feishu</option><option value="lark">Lark</option></select></label>
        </div>
        <label><span>{t('appSecret')}</span><Input aria-label="appSecret" type="password" disabled={!payload.credential.writable} value={form.appSecret} onChange={event => update('appSecret', event.target.value)} autoComplete="new-password" placeholder={t('secretPlaceholder')} /></label>
        <div
          className="dsh-feishu-credential"
          aria-label={payload.credential.configured ? t('credentialConfigured') : t('credentialMissing')}
          data-state={payload.credential.configured ? 'configured' : 'missing'}
        >
          <span className="dsh-feishu-credential-badge">
            <span className="dsh-feishu-credential-dot" aria-hidden="true" />
            {payload.credential.configured ? t('credentialConfigured') : t('credentialMissing')}
          </span>
          {payload.credential.source !== undefined ? <code>{payload.credential.source}</code> : null}
          {!payload.credential.writable ? <span>{t('readOnly')}</span> : null}
        </div>
      </div>

      <div className="dsh-feishu-card">
        <h3>{t('access')}</h3>
        {toggleRow({
          label: t('requireMention'),
          hint: t('requireMentionHint'),
          checked: form.requireMention,
          onToggle: next => update('requireMention', next),
        })}
        <label><span>{t('dmMode')}</span><select value={form.dmMode} onChange={event => update('dmMode', event.target.value as FormState['dmMode'])}><option value="open">{t('open')}</option><option value="allowlist">{t('allowlist')}</option><option value="disabled">{t('disabled')}</option></select></label>
        <div className="dsh-feishu-grid">
          <label><span>{t('groupAllowlist')}</span><textarea value={form.groupAllowlist} onChange={event => update('groupAllowlist', event.target.value)} placeholder={t('onePerLine')} /></label>
          <label><span>{t('dmAllowlist')}</span><textarea value={form.dmAllowlist} onChange={event => update('dmAllowlist', event.target.value)} placeholder={t('onePerLine')} /></label>
        </div>
        <label><span>{t('reactEmoji')}</span><Input aria-label="reactEmoji" value={form.reactEmoji} onChange={event => update('reactEmoji', event.target.value)} placeholder={t('reactEmojiHint')} /></label>
      </div>

      <div className="dsh-feishu-card">
        <h3>{t('display')}</h3>
        {toggleRow({
          label: t('showReasoning'),
          hint: t('showReasoningHint'),
          checked: form.showReasoning,
          onToggle: next => update('showReasoning', next),
        })}
        {toggleRow({
          label: t('showToolCalls'),
          hint: t('showToolCallsHint'),
          checked: form.showToolCalls,
          onToggle: next => update('showToolCalls', next),
        })}
        {toggleRow({
          label: t('showToolArgs'),
          hint: t('showToolArgsHint'),
          checked: form.showToolArgs,
          onToggle: next => update('showToolArgs', next),
          disabled: toolsOff,
          nested: true,
        })}
        {toggleRow({
          label: t('showToolResults'),
          hint: t('showToolResultsHint'),
          checked: form.showToolResults,
          onToggle: next => update('showToolResults', next),
          disabled: toolsOff,
          nested: true,
        })}
        <label><span>{t('locale')}</span><select aria-label={t('locale')} value={form.locale} onChange={event => update('locale', event.target.value as PluginLocale)}>
          <option value="auto">{t('localeAuto')}</option>
          <option value="zh">{t('localeZh')}</option>
          <option value="en">{t('localeEn')}</option>
        </select></label>
      </div>

      <footer className="dsh-feishu-actions">
        <Button variant="primary" type="submit" disabled={busy}>{busy ? t('saving') : t('save')}</Button>
        <Button variant="outline" type="button" disabled={busy || !payload.credential.configured || !payload.credential.writable} onClick={removeSecret}>{t('removeSecret')}</Button>
        <span role="status" aria-live="polite">{notice}</span>
      </footer>
      {payload.runtime.message !== undefined ? <p className="dsh-feishu-detail">{payload.runtime.message}</p> : null}
    </form> : null}
  </section>
}
