/**
 * Loose local views of the DSH client services this plugin consumes.
 *
 * The plugin declares its own structural types for every injected service
 * (see the minimal `ClientContext` in `./index.ts`) instead of importing the
 * DSH client packages' declarations: those packages are DSH's own build
 * artifacts, they are not dependencies of this plugin, and the browser bundle
 * must not pull them in. The shapes below mirror the published contracts
 * field-for-field:
 *
 * - `ConfigForm` / `ConfigFormSnapshot` / `SettingsPathOpView` mirror
 *   `@deepseek-ai/dsh-client-ui-settings`'s `config-form-types.ts` and
 *   `@deepseek-ai/dsh-settings`'s `types.ts`.
 * - `CredentialsResult` / `CredentialInfo` mirror the credentials Remote
 *   namespace (`describe` / `set` / `unset`), whose calls answer a tagged
 *   result instead of throwing.
 * - `Observable` is the bare `getSnapshot` + `subscribe` pair the slots
 *   renderer binds from an entry's `hooks` compartment.
 */

/** One namespace field operation, copied as it is queued for the Host. */
export type SettingsPathOpView =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** Client-side sync state of one settings namespace. */
export interface ConfigFormSnapshot<T> {
  /** `loading` until the first accepted section, `ready` while one stands, `unavailable` when not exposed. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted schema-resolved section; undefined before the first acceptance. */
  value: T | undefined
  /** Composition layer the Host resolved the value over. */
  base: unknown
  /** Raw user layer as stored, when one exists. */
  user: unknown
  /** Namespace revision fencing the next write; undefined before the first Host view. */
  revision: number | undefined
  /** Whether the Host document accepts writes; memory mode never does. */
  writable: boolean
  /** `host` syncs with the Host document; `memory` keeps a remote browser process-local. */
  mode: 'host' | 'memory'
}

/** Accepted values and serialized writes shared by editors of one Host entry. */
export interface ConfigForm<T> {
  /** @returns the current sync snapshot. */
  getSnapshot(): ConfigFormSnapshot<T>
  /** @param listener - invoked after each snapshot change. @returns the disposer. */
  subscribe(listener: () => void): () => void
  /**
   * Queue one atomic namespace mutation; all operations share one revision
   * fence, Host validation and persistence decision.
   * @param ops - ordered field operations.
   * @param expectedRevision - optional fixed revision read by the editor.
   * @returns true for Host acceptance, false for refusal, after any recovery read.
   */
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean>
  /** Queue one field write against the latest known revision. */
  set(field: string, value: unknown): Promise<boolean>
  /** Queue one field clear so it re-inherits the composition layer. */
  unset(field: string): Promise<boolean>
}

/** The settings domain's base service: shared forms plus served-namespace watching. */
export interface ConfigFormsService {
  /** @param namespace - Host plugin entry id. @returns that entry's form. */
  get<T>(namespace: string): ConfigForm<T>
  /**
   * Keep a registration alive while the Host serves any of some namespaces.
   * @param namespaces - namespaces the registration follows.
   * @param register - registers the contribution, given every served namespace; returns its disposer.
   * @returns the disposer ending the watch and any live registration.
   */
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

/** Credential state the credentials domain reports (never the value). */
export interface CredentialInfo {
  /** Whether any layer supplies a value for the reference. */
  configured: boolean
  /** Where the value comes from, when the Host names a layer. */
  source?: string
  /** Whether the credentials domain accepts a write; false disables the control. */
  writable: boolean
}

/** Tagged result every Remote call answers with instead of throwing. */
export type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

/** The credentials Remote namespace. */
export interface CredentialsRemote {
  /** @param refs - references to look up. @returns state per reference, never a value. */
  describe(refs: readonly string[]): Promise<RemoteResult<Record<string, CredentialInfo>>>
  /** @param ref - credential reference. @param value - literal to store. */
  set(ref: string, value: string): Promise<RemoteResult<unknown>>
  /** @param ref - credential reference to clear. */
  unset(ref: string): Promise<RemoteResult<unknown>>
}

/** The forwarded Remote namespace the page subscribes its invalidations through. */
export interface RemoteService {
  credentials: CredentialsRemote
  /**
   * Subscribe a forwarded Host event.
   * @param event - forwarded event name.
   * @param handler - invoked with the event payload.
   * @returns the disposer removing the listener.
   */
  $on(event: string, handler: (payload: any) => void): () => void
}

/** A bare observable source: the slots renderer binds it as a `use<Name>` selector hook. */
export interface Observable<T> {
  /** @returns the current snapshot, stable until the next change. */
  getSnapshot(): T
  /** @param listener - invoked after each snapshot change. @returns the disposer. */
  subscribe(listener: () => void): () => void
}

/** The component-side selector hook the renderer synthesizes from a `hooks` member. */
export type SnapshotSelectorHook<T> = <R>(selector: (value: T) => R) => R
