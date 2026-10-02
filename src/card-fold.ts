/**
 * The one look shared by every folded panel this plugin sends.
 *
 * A `collapsible_panel` renders only its header while collapsed, and a bare
 * header reads as a heading — nothing about it says "there is more behind
 * this", which is how a folded reasoning block or a folded compaction summary
 * becomes invisible to anyone who did not write the card. Two remedies, both
 * probed against the live card API on 2026-09-29 (`cardkit.v1.card.create`,
 * the only card validator reachable from here — see
 * `docs/feishu-capabilities.md` §2.3.1):
 *
 * 1. **chrome** — a border around the panel plus a background on its header, so
 *    the header reads as a control rather than as a section title;
 * 2. **words** — the header title ends with {@link Translations.cardFoldTitle},
 *    the one signal no client can drop ("（▸ 已折叠 · 点击展开）").
 *
 * Every value here is a *validated* one. The server checks these fields, which
 * is the evidence that they exist at all: `border.color` /
 * `header.background_color` accept named colour tokens only (a hex or `rgba()`
 * value is refused with `11310`), `corner_radius` is px-only ("4" and "50%"
 * are refused), and `header.padding` takes one or four px values ("4px 8px" is
 * refused). Beware the inverse reading: unknown fields are **silently
 * tolerated** (a `bogus_xyz` key inside `header` creates fine), so "the server
 * accepted my card" alone proves nothing — only a rejected *value* does.
 *
 * @module @starxer/chatterbox4dsh/card-fold
 */

import type { Translations } from './i18n.ts'

/**
 * Border colour token. Named tokens only — hex and `rgba()` are refused with
 * `11310 collapsible panel border color is invalid`.
 */
export const FOLD_BORDER_COLOR = 'grey-300'

/** Header background token, same rule as {@link FOLD_BORDER_COLOR}. */
export const FOLD_HEADER_BACKGROUND = 'grey-100'

/** Corner radius — px only, `4` and `50%` are both refused. */
export const FOLD_CORNER_RADIUS = '4px'

/**
 * Build a folded panel: `title` is the markdown header, `elements` the hidden
 * body. The collapsed-by-default state is deliberate everywhere it is used —
 * the header is the summary, the body is one tap away.
 *
 * @param t - translations for the active locale (supplies the fold hint).
 * @param title - markdown header text, without the hint.
 * @param elements - the panel body, shown only once expanded.
 * @returns the `collapsible_panel` element.
 */
export function foldedPanel(t: Translations, title: string, elements: object[]): object {
  return {
    tag: 'collapsible_panel',
    // Verified against the live API 2026-09-29 — `collapsible_panel` is the
    // 2.0 tag and `collapsible` (the 1.0 name) is refused: `10002 not support
    // tag`. The field is `expanded`; a non-boolean is refused.
    expanded: false,
    border: { color: FOLD_BORDER_COLOR, corner_radius: FOLD_CORNER_RADIUS },
    header: {
      title: { tag: 'markdown', content: t.cardFoldTitle(title) },
      background_color: FOLD_HEADER_BACKGROUND,
    },
    elements,
  }
}
