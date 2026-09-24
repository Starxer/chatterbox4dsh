/**
 * The Lark settings page's staged form over the `lark-channel` settings
 * namespace, plus the one concern that has no native equivalent: the
 * application secret, which lives in the credentials domain and never in the
 * section.
 *
 * One save writes every edited field through a single revision-fenced
 * `ConfigForm.mutate`; the secret rides the credentials domain and is written
 * only when the user typed one. The revision fence, Host validation,
 * persistence and reload-on-refusal all belong to the native form controller,
 * so this class only stages edits and projects state.
 *
 * Everything about the live channel — connection state, the scan-to-configure
 * flow — belongs to {@link LarkChannelStatusController} and is rendered on the
 * Plugins detail page. This page points there instead of duplicating it.
 */

import type {
  ConfigForm, ConfigFormSnapshot, Observable, RemoteService, SettingsPathOpView, SnapshotSelectorHook,
} from './config-form-types.ts'
import { SnapshotStore } from './snapshot-store.ts'

/**
 * Namespace of this plugin's Host entry (`options.id`): the profile row id,
 * which is what `settings.describe()` keys every descriptor on. Spelled here
 * rather than imported — the client half must not depend on a Host module.
 */
export const LARK_SETTINGS_NAMESPACE = 'lark-channel'

/** Credential reference the plugin resolves when the section names none. */
export const LARK_APP_SECRET_REF = 'DSH_LARK_APP_SECRET'

/** Application domain. */
export type DomainName = 'feishu' | 'lark'
/** Direct-message access policy. */
export type DirectMessageMode = 'open' | 'allowlist' | 'disabled'
/** Plugin language; `auto` follows the DSH browser-language preference. */
export type PluginLocale = 'auto' | 'zh' | 'en'
/**
 * How an image the model references in card text is handled: never upload it,
 * upload only workspace files, or upload any readable image path. Mirrored here
 * because the client half must not import a Host module.
 */
export type CardImageMode = 'text' | 'workspace' | 'any'

/**
 * Bounds of the per-card media limit, mirroring `CARD_MEDIA_LIMIT` in
 * `src/config.ts`.
 *
 * Deliberately repeated: this bundle includes no Host module (it would drag the
 * config schema and zod into the browser), and the Host schema is what really
 * enforces them. These numbers only keep the input usable and the staged value
 * sane before it is written.
 */
export const CARD_MEDIA_LIMIT = { min: 1, max: 30, default: 12 } as const

/** Clamp a staged media limit the way the Host schema would. */
function clampCardMediaLimit(value: number): number {
  if (!Number.isFinite(value)) return CARD_MEDIA_LIMIT.default
  return Math.min(CARD_MEDIA_LIMIT.max, Math.max(CARD_MEDIA_LIMIT.min, Math.trunc(value)))
}

/**
 * The `lark-channel` fields this page reads. `provider`, `model`, `workspace`
 * and `agentPreset` exist in the schema but are deliberately not edited here.
 */
export interface LarkSettingsValues {
  appId?: string
  appSecretRef?: string
  domain?: DomainName
  requireMention?: boolean
  dmMode?: DirectMessageMode
  groupAllowlist?: string[]
  dmAllowlist?: string[]
  reactEmoji?: string
  showReasoning?: boolean
  showToolCalls?: boolean
  showToolArgs?: boolean
  showToolResults?: boolean
  locale?: PluginLocale
  cardImages?: CardImageMode
  cardMediaLimit?: number
}

/** The page's staged controls, after defaults and edits are folded together. */
export interface LarkFormValues {
  appId: string
  domain: DomainName
  requireMention: boolean
  dmMode: DirectMessageMode
  /** Textarea content: one id per line. */
  groupAllowlist: string
  /** Textarea content: one id per line. */
  dmAllowlist: string
  reactEmoji: string
  showReasoning: boolean
  showToolCalls: boolean
  showToolArgs: boolean
  showToolResults: boolean
  locale: PluginLocale
  /** How images the model references in card text are handled. */
  cardImages: CardImageMode
  /**
   * Most media one card may inline. Staged as the raw input text so a half-typed
   * or emptied field does not have to mean a number yet; {@link writeValue}
   * parses and clamps it on save.
   */
  cardMediaLimit: string
}

/** The field order every save walks; also the only keys a save may write. */
const EDITABLE_FIELDS: readonly (keyof LarkFormValues)[] = [
  'appId', 'domain', 'requireMention', 'dmMode', 'groupAllowlist', 'dmAllowlist', 'reactEmoji',
  'showReasoning', 'showToolCalls', 'showToolArgs', 'showToolResults', 'locale', 'cardImages',
  'cardMediaLimit',
]

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  ref: string
  configured: boolean
  writable: boolean
  source?: string
}

/** What the Lark settings page renders. */
export interface LarkCardState {
  /** Native form sync state; `loading` until the first accepted section. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** The staged form values. */
  form: LarkFormValues
  /** The write-only secret control and the credential badge. */
  secret: {
    /** Staged literal, blank on every load and after every write. */
    value: string
    /** Whether the Host reports a credential configured for the referenced key. */
    configured: boolean
    /** Whether the credentials domain accepts a write; false disables the control. */
    writable: boolean
    /** Layer the Host reports the value coming from, when it names one. */
    source?: string
  }
  /** A settings/credential save is in flight. */
  busy: boolean
  /** Localized result line, already translated. */
  notice: string
}

/** The registration-side face the page's slot entry injects. */
export interface LarkCardFace {
  hooks: {
    /** Page snapshot bound by the renderer as `useLarkSettings`. */
    larkSettings: Observable<LarkCardState>
  }
  /** Stage one edited control. */
  edit: <K extends keyof LarkFormValues>(field: K, value: LarkFormValues[K]) => void
  /** Stage the secret literal; blank means "keep whatever the Host holds". */
  setSecret: (value: string) => void
  /** Write every edited field in one revision-fenced mutate, then the secret. */
  save: () => Promise<void>
  /** Clear the stored credential through the credentials domain. */
  removeSecret: () => Promise<void>
}

/** The component-side props: the face with its hooks compartment bound. */
export type LarkCardProps = Omit<LarkCardFace, 'hooks'> & {
  useLarkSettings: SnapshotSelectorHook<LarkCardState>
  /** Plugins-page view: the card one-liner or the settings page. */
  view?: 'summary' | 'page'
  /** Localized copy, injected by the slots renderer from the locale namespace. */
  t: (key: string) => string
}

/** The slice of the client context the controller reaches. */
export interface LarkCardHost {
  remote: RemoteService
}

/** Bridges the `lark-channel` form and the credentials domain onto the page. */
export class LarkSettingsCardController {
  private readonly store: SnapshotStore<LarkCardState>
  private readonly unsubscribeScope: () => void
  /** Fields the user edited since the last load; absent keys keep the Host value. */
  private edits: Partial<LarkFormValues> = {}
  /** Staged secret literal; blank means "keep whatever the Host holds". */
  private secretText = ''
  private credential: CredentialState = { ref: '', configured: false, writable: true }
  private busy = false
  private noticeKey: string | undefined
  private noticeDetail: string | undefined

  /**
   * @param scope - the bound `lark-channel` settings form.
   * @param host - the page plugin's context slice owning `remote.credentials`.
   * @param t - the plugin's dictionary translator.
   */
  constructor(
    private readonly scope: ConfigForm<LarkSettingsValues>,
    private readonly host: LarkCardHost,
    private readonly t: (key: string) => string,
  ) {
    this.store = new SnapshotStore(this.projection())
    this.unsubscribeScope = scope.subscribe(() => { void this.onScopeChange() })
    void this.onScopeChange()
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot observable and its actions.
   */
  inject(): LarkCardFace {
    return {
      hooks: { larkSettings: this.store },
      edit: (field, value) => { this.edit(field, value) },
      setSecret: value => { this.setSecret(value) },
      save: () => this.save(),
      removeSecret: () => this.removeSecret(),
    }
  }

  /**
   * Stage one edited control.
   * @param field - control key.
   * @param value - staged value.
   */
  edit<K extends keyof LarkFormValues>(field: K, value: LarkFormValues[K]): void {
    const edits: Partial<LarkFormValues> = { ...this.edits }
    edits[field] = value
    this.edits = edits
    this.clearNotice()
    this.publish()
  }

  /**
   * Stage the secret literal. Leaving it blank never clears a stored secret;
   * the separate remove control is the only way to clear one.
   * @param value - staged literal.
   */
  setSecret(value: string): void {
    this.secretText = value
    this.clearNotice()
    this.publish()
  }

  /**
   * Write every edited field in one revision-fenced mutate, then the staged
   * secret when the user typed one. A refused mutate leaves the edits staged
   * for a retry and does not write the secret.
   * @returns a promise settling when the save attempt is reported.
   */
  async save(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.noticeKey = 'saving'
    this.noticeDetail = undefined
    this.publish()
    try {
      const ops = this.buildOps()
      const accepted = ops.length === 0
        ? true
        : await this.scope.mutate(ops, this.scope.getSnapshot().revision)
      let secretWritten = true
      if (accepted && this.secretText !== '') secretWritten = await this.writeSecret()
      if (accepted && secretWritten) {
        this.edits = {}
        this.secretText = ''
        this.noticeKey = 'saved'
        this.noticeDetail = undefined
      } else {
        this.noticeKey = 'saveFailed'
      }
    } catch (error) {
      this.noticeKey = 'saveFailed'
      this.noticeDetail = messageOf(error)
    } finally {
      this.busy = false
      this.publish()
    }
  }

  /**
   * Clear the stored credential through the credentials domain, then re-read
   * whether the Host still holds one.
   * @returns a promise settling when the attempt is reported.
   */
  async removeSecret(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.noticeKey = 'removing'
    this.noticeDetail = undefined
    this.publish()
    try {
      const response = await this.host.remote.credentials.unset(this.credentialRef())
      if (!response.ok) throw new Error(response.error.message)
      await this.readCredential()
      this.noticeKey = 'removed'
    } catch (error) {
      this.noticeKey = 'removeFailed'
      this.noticeDetail = messageOf(error)
    } finally {
      this.busy = false
      this.publish()
    }
  }

  /**
   * Re-read after the Host reports a change to the reference this page watches.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  /**
   * Re-read the credential the section currently names.
   *
   * The scan-to-configure flow completes on another surface (the Plugins detail
   * page) and the Host writes the secret there, so the badge has to be told.
   */
  rereadCredential(): void {
    void this.readCredential()
  }

  /** Release the form subscription. */
  dispose(): void {
    this.unsubscribeScope()
  }

  /** Re-read the credential when the reference the section names changes. */
  private async onScopeChange(): Promise<void> {
    const ref = this.credentialRef()
    if (ref !== this.credential.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim
      // the key is configured under a name nobody has checked.
      this.credential = { ref, configured: false, writable: true }
      this.publish()
      await this.readCredential()
      return
    }
    this.publish()
  }

  /**
   * Ask the credentials domain about the reference the section currently
   * names. The answer is stored with the reference it describes, so a stale
   * response for another reference is dropped.
   */
  private async readCredential(): Promise<void> {
    const ref = this.credentialRef()
    try {
      const response = await this.host.remote.credentials.describe([ref])
      if (!response.ok || ref !== this.credentialRef()) return
      const view = response.value[ref]
      const source = view?.source
      this.credential = {
        ref,
        configured: view?.configured ?? false,
        // An unknown reference is treated as writable: the control stays
        // usable and the Host is what refuses, rather than the page guessing.
        writable: view?.writable ?? true,
        ...(source !== undefined ? { source } : {}),
      }
      this.publish()
    } catch {
      // A transport failure leaves the last answer standing; the badge is a
      // report, not an authority, and must never break the page.
    }
  }

  /** @returns the credential reference the section names, or the plugin default. */
  private credentialRef(): string {
    const declared = this.scope.getSnapshot().value?.appSecretRef
    return declared !== undefined && declared.length > 0 ? declared : LARK_APP_SECRET_REF
  }

  /** @returns the operations for exactly the fields the user edited. */
  private buildOps(): SettingsPathOpView[] {
    const form = this.formValues()
    const ops: SettingsPathOpView[] = []
    for (const field of EDITABLE_FIELDS) {
      if (!Object.hasOwn(this.edits, field)) continue
      ops.push({ op: 'set', path: [field], value: writeValue(field, form) })
    }
    return ops
  }

  /**
   * Write the staged secret, then re-read whether the Host now holds one.
   * @returns whether the credentials domain accepted the write.
   */
  private async writeSecret(): Promise<boolean> {
    const response = await this.host.remote.credentials.set(this.credentialRef(), this.secretText)
    await this.readCredential()
    if (!response.ok) {
      this.noticeDetail = response.error.message
      return false
    }
    return this.credential.configured
  }

  /** @returns the staged form values, defaults and Host values folded under the edits. */
  private formValues(): LarkFormValues {
    const value = this.scope.getSnapshot().value
    const base: LarkFormValues = {
      appId: value?.appId ?? '',
      domain: value?.domain ?? 'feishu',
      requireMention: value?.requireMention ?? true,
      dmMode: value?.dmMode ?? 'open',
      groupAllowlist: (value?.groupAllowlist ?? []).join('\n'),
      dmAllowlist: (value?.dmAllowlist ?? []).join('\n'),
      reactEmoji: value?.reactEmoji ?? '',
      showReasoning: value?.showReasoning ?? true,
      showToolCalls: value?.showToolCalls ?? true,
      showToolArgs: value?.showToolArgs ?? true,
      showToolResults: value?.showToolResults ?? true,
      locale: value?.locale ?? 'auto',
      cardImages: value?.cardImages ?? 'workspace',
      cardMediaLimit: String(value?.cardMediaLimit ?? CARD_MEDIA_LIMIT.default),
    }
    return { ...base, ...this.edits }
  }

  /** @returns the published page state. */
  private projection(): LarkCardState {
    const snapshot: ConfigFormSnapshot<LarkSettingsValues> = this.scope.getSnapshot()
    const source = this.credential.source
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      form: this.formValues(),
      secret: {
        value: this.secretText,
        configured: this.credential.configured,
        writable: this.credential.writable,
        ...(source !== undefined ? { source } : {}),
      },
      busy: this.busy,
      notice: this.noticeText(),
    }
  }

  /** @returns the localized notice line. */
  private noticeText(): string {
    const head = this.noticeKey === undefined ? '' : this.t(this.noticeKey)
    if (this.noticeDetail === undefined || this.noticeDetail === '') return head
    return head === '' ? this.noticeDetail : `${head}: ${this.noticeDetail}`
  }

  /** Drop any staged notice (edits and discards invalidate it). */
  private clearNotice(): void {
    this.noticeKey = undefined
    this.noticeDetail = undefined
  }

  /** Publish a fresh projection. */
  private publish(): void { this.store.set(this.projection()) }
}

/** @param value - one staged form value. @returns its wire shape for a `set` op. */
function writeValue(field: keyof LarkFormValues, form: LarkFormValues): unknown {
  switch (field) {
    case 'appId': return form.appId.trim()
    case 'cardMediaLimit': {
      // A blank field means "the user cleared it", not zero: fall back to the
      // default rather than writing the minimum.
      const raw = form.cardMediaLimit.trim()
      return raw === '' ? CARD_MEDIA_LIMIT.default : clampCardMediaLimit(Number(raw))
    }
    case 'groupAllowlist': return lines(form.groupAllowlist)
    case 'dmAllowlist': return lines(form.dmAllowlist)
    default: return form[field]
  }
}

/** @param value - textarea content. @returns trimmed non-empty lines. */
function lines(value: string): string[] {
  return value.split(/\n/u).map(item => item.trim()).filter(Boolean)
}

/** @param error - a thrown value. @returns its message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
