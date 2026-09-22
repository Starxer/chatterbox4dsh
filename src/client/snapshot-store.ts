/**
 * The `getSnapshot` + `subscribe` store the slots renderer binds as a
 * `use<Name>` selector hook.
 *
 * Both of this plugin's published surfaces need exactly this: the settings
 * form's snapshot and the channel-status snapshot. The store is generic and
 * shared rather than copied because the two controllers must publish on the
 * same terms — a stable snapshot reference between publishes, and a listener
 * list iterated over a copy so a listener that unsubscribes mid-notify cannot
 * skip its neighbours.
 *
 * Why not the platform's own store: `@deepseek-ai/dsh-client-store` is a
 * browser platform module (`PLATFORM_MODULES` in `@deepseek-ai/dsh-client-web`)
 * exporting `createSnapshotStore`, and the running Host would answer it. But
 * adopting it is not one import: the package is absent from this plugin's tree,
 * so it needs a devDependency, an entry in the client bundle's `external` list
 * (or tsdown tries to bundle it), and — because the client suite runs in jsdom
 * without the platform — a vitest alias or stub. That is the same triad key
 * pitfall 18 ended up needing for `@deepseek-ai/dsh-client-ui-primitives`, spent
 * here on a three-method, dependency-free state holder whose contract this
 * plugin already publishes as `Observable`. Revisit if the platform store grows
 * behaviour worth inheriting; until then the client bundle asks the platform for
 * exactly one module (`@deepseek-ai/dsh-client-ui-primitives`).
 *
 * One trap for whoever revisits that trade: `@deepseek-ai/dsh-client-store`'s
 * `latest` dist-tag is stale — it reads `0.1.2-alpha.2` while `0.1.7-alpha.2` is
 * published. A bare `npm view <pkg> version` therefore reports five releases
 * behind the Host; check `versions` before concluding the package is
 * unavailable, since an explicit `^0.1.7-alpha.1` range resolves to the current
 * one. This package is not special in that respect — `dsh-client-ui-primitives`
 * has the same stale `latest` (`0.0.1-rc.1`) while 0.1.7-alpha.2 is installed.
 */

import type { Observable } from './config-form-types.ts'

/** One published snapshot plus its listener set. */
export class SnapshotStore<T> implements Observable<T> {
  private readonly listeners = new Set<() => void>()
  private snapshot: T

  /** @param initial - first published state. */
  constructor(initial: T) { this.snapshot = initial }

  /** @returns the current snapshot, stable until the next publish. */
  getSnapshot = (): T => this.snapshot

  /** @param listener - invoked after each publish. @returns the disposer. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @param next - replacement state; notifies only when the reference changes. */
  set(next: T): void {
    if (next === this.snapshot) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
