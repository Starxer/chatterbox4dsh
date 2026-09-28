import { describe, expect, it } from 'vitest'
import {
  FOLD_BORDER_COLOR,
  FOLD_CORNER_RADIUS,
  FOLD_HEADER_BACKGROUND,
  foldedPanel,
} from '../src/card-fold.ts'
import { translationsFor } from '../src/i18n.ts'

const zh = translationsFor('zh')
const en = translationsFor('en')

/**
 * The values below were probed against `cardkit.v1.card.create` on 2026-09-30:
 * the server validates these fields, and a rejected *value* is the only proof
 * that a field exists at all (unknown fields are silently tolerated — an
 * `expanded` typo still creates). These tests pin the values that survived.
 */
describe('foldedPanel', () => {
  it('gives the fold a visible affordance: border, tinted header and the words', () => {
    const panel: any = foldedPanel(zh, '**摘要**', [{ tag: 'markdown', content: '正文' }])
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(false)
    expect(panel.border).toEqual({ color: FOLD_BORDER_COLOR, corner_radius: FOLD_CORNER_RADIUS })
    expect(panel.header.background_color).toBe(FOLD_HEADER_BACKGROUND)
    // The hint is the one part of the affordance no client can drop.
    expect(panel.header.title).toEqual({ tag: 'markdown', content: '**摘要**（▸ 已折叠 · 点击展开）' })
    expect(panel.elements).toEqual([{ tag: 'markdown', content: '正文' }])
  })

  it('keeps the header title markdown intact, hint last', () => {
    const panel: any = foldedPanel(zh, '💬 **推理** · 1.9s · 1.2K tokens', [])
    expect(panel.header.title.content).toBe('💬 **推理** · 1.9s · 1.2K tokens（▸ 已折叠 · 点击展开）')
    expect(panel.elements).toEqual([])
  })

  it('separates the hint per locale, so Latin text is not glued to the bracket', () => {
    expect((foldedPanel(en, '**Summary**', []) as any).header.title.content)
      .toBe('**Summary** (▸ Collapsed · click to expand)')
    expect(zh.cardFoldTitle('x')).toBe('x（▸ 已折叠 · 点击展开）')
  })

  it('uses only values the card API accepted', () => {
    // Named colour tokens only: a hex or rgba() value is refused with `11310`.
    expect(FOLD_BORDER_COLOR).toMatch(/^[a-z]+(-\d+)?$/)
    expect(FOLD_HEADER_BACKGROUND).toMatch(/^[a-z]+(-\d+)?$/)
    // corner_radius is px-only: `4`, `50%` and `4pt` are all refused.
    expect(FOLD_CORNER_RADIUS).toMatch(/^\d+px$/)
  })

  it('returns a fresh object per call, so one card cannot mutate another', () => {
    const first: any = foldedPanel(zh, 'A', [])
    const second: any = foldedPanel(zh, 'B', [])
    first.elements.push({ tag: 'markdown', content: 'later' })
    first.border.color = 'red'
    expect(second.elements).toEqual([])
    expect(second.border.color).toBe(FOLD_BORDER_COLOR)
  })
})
