/**
 * Loose local views of the Plugins page's detail-slot contract.
 *
 * `@deepseek-ai/dsh-client-ui-plugin-manager` declares `plugins.detail.badge`,
 * `plugins.detail.actions` and `plugins.detail.section` — all root-scoped list
 * slots whose entries are rendered with the open page's subject. The plugin
 * mirrors the subject here instead of importing that package's declarations:
 * it is a DSH build artifact, it is not a dependency of this plugin, and the
 * browser bundle must not pull it in. The shapes below mirror
 * `ui-plugin-manager`'s `src/client/slot-contract.ts` field-for-field.
 */

/** One row of a bundle as a detail contribution sees it. */
export interface PluginRowRef {
  /** The row id as the bundle's patch declares it. */
  readonly rowId: string
  /** The module the row names. */
  readonly moduleName: string
  /** Whether the row's entry runs. */
  readonly enabled: boolean
}

/** One bundle as a detail contribution sees it. */
export interface PluginPackageRef {
  /** The package name. */
  readonly name: string
  /** The installed version, when the Host reports one. */
  readonly version?: string
  /** Whether the profile's own dependencies hold the package. */
  readonly installed: boolean
  /** Whether the bundle is switched on. */
  readonly enabled: boolean
  /** The rows the bundle declares. */
  readonly rows: readonly PluginRowRef[]
}

/**
 * What a detail page is about: a bundle, one row of a bundle, or an official
 * plugin listed by its `plugins.item` id.
 */
export type PluginsSubject =
  | { readonly kind: 'bundle'; readonly pkg: PluginPackageRef }
  | { readonly kind: 'row'; readonly pkg: PluginPackageRef; readonly row: PluginRowRef }
  | { readonly kind: 'item'; readonly id: string }

/** The owner props every detail contribution is rendered with. */
export interface PluginDetailProps {
  /** The subject of the open page; an entry renders null for a subject it has nothing for. */
  readonly subject: PluginsSubject
}

/** This plugin's npm package name: the subject every entry here answers to. */
export const LARK_PLUGIN_PACKAGE = '@starxer/chatterbox4dsh'

/**
 * Whether one opened detail page is about this plugin.
 *
 * This bundle declares a single row, so its own page and that row's page are
 * the only two subjects it has anything to show for. An official item is never
 * ours: this plugin occupies no `plugins.item` entry.
 * @param subject - the open page's subject, when the owner supplies one.
 * @returns true for this bundle and its rows.
 */
export function isLarkSubject(subject: PluginsSubject | undefined): boolean {
  if (subject === undefined) return false
  return (subject.kind === 'bundle' || subject.kind === 'row') && subject.pkg.name === LARK_PLUGIN_PACKAGE
}
