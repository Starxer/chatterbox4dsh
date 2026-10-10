import { describe, expect, it } from 'vitest'
import { normalizeCardEmphasis } from '../src/card-emphasis.ts'
import { neutralizeCardMarkdown } from '../src/card-markdown.ts'

/**
 * Every case in the two tables was confirmed against a real card send on
 * 2026-10-10 (two numbered probe cards). `fail` shapes are the ones Feishu
 * printed with literal `**`; `ok` shapes rendered bold as written.
 */
describe('normalizeCardEmphasis', () => {
  it('moves punctuation out of a strong span followed by a word (probe 2 / 4 / 9 / 11)', () => {
    expect(normalizeCardEmphasis('**加粗。**后面')).toBe('**加粗**。后面')
    expect(normalizeCardEmphasis('**加粗：**后面')).toBe('**加粗**：后面')
    expect(normalizeCardEmphasis('**带括号（说明）**后面')).toBe('**带括号（说明）**后面'.replace('）**', '**）'))
    expect(normalizeCardEmphasis('**加粗…**后面')).toBe('**加粗**…后面')
  })

  it('keeps the visible text identical (only the bold extent moves)', () => {
    for (const source of ['**加粗。**后面', '**加粗：**后面', '**带括号（说明）**后面', '**加粗…**后面']) {
      const fixed = normalizeCardEmphasis(source)
      expect(fixed.replace(/\*\*/gu, '')).toBe(source.replace(/\*\*/gu, ''))
    }
  })

  it('leaves the shapes that already render (probe 1 / 3 / 5 / 6 / 7 / 8 / 10 / 12 / 14)', () => {
    const rendered = [
      ' **加粗** 前后有空格',
      ' **加粗**。后面直接跟字',
      ' **加粗**：后面直接跟字',
      ' **加粗**，后面直接跟字',
      ' 前缀**加粗**后缀无空格',
      ' **整行只有加粗**',
      ' **两处加粗**和**第二处**紧挨',
      ' 行内代码 `a.ts` 与 **加粗** 混排',
      ' **加粗**：`code` 紧跟',
      '**Tablet**\n\n| A | **加粗**。后面 |',
    ]
    for (const source of rendered) expect(normalizeCardEmphasis(source)).toBe(source)
  })

  it('leaves punctuation with no following word alone', () => {
    // The closing marker is the last thing on the line, so nothing follows it.
    expect(normalizeCardEmphasis('**加粗。**')).toBe('**加粗。**')
    expect(normalizeCardEmphasis('**加粗。** 空格后是字')).toBe('**加粗。** 空格后是字')
    expect(normalizeCardEmphasis('**加粗。**，还是标点')).toBe('**加粗。**，还是标点')
  })

  it('leaves an unterminated marker alone (probe 13, the control)', () => {
    expect(normalizeCardEmphasis('**加粗内容被截断')).toBe('**加粗内容被截断')
  })

  it('is idempotent', () => {
    const once = normalizeCardEmphasis('**加粗。**后面')
    expect(normalizeCardEmphasis(once)).toBe(once)
  })

  it('keeps fenced code opaque', () => {
    const fenced = '```\n**加粗。**后面\n```'
    expect(normalizeCardEmphasis(fenced)).toBe(fenced)
    // A four-backtick fence and a tilde fence behave the same way.
    expect(normalizeCardEmphasis('````\n**加粗。**后面\n````')).toBe('````\n**加粗。**后面\n````')
    expect(normalizeCardEmphasis('~~~\n**加粗。**后面\n~~~')).toBe('~~~\n**加粗。**后面\n~~~')
  })

  it('keeps inline code spans and link destinations opaque', () => {
    expect(normalizeCardEmphasis('`**加粗。**`后面')).toBe('`**加粗。**`后面')
    expect(normalizeCardEmphasis('[文字](https://x.test/a**)后面')).toBe('[文字](https://x.test/a**)后面')
  })

  it('repairs a span inside a link label but not its destination', () => {
    expect(normalizeCardEmphasis('[**加粗。**后面](https://x.test/a)'))
      .toBe('[**加粗**。后面](https://x.test/a)')
  })

  it('ignores escaped markers and triple-star runs', () => {
    expect(normalizeCardEmphasis('\\**加粗。**后面')).toBe('\\**加粗。**后面')
    expect(normalizeCardEmphasis('***加粗。***后面')).toBe('***加粗。***后面')
  })

  it('handles several spans on one line and several lines at once', () => {
    expect(normalizeCardEmphasis('**一。**后面 **二！**还有')).toBe('**一**。后面 **二**！还有')
    expect(normalizeCardEmphasis('**一。**后\n**二：**面')).toBe('**一**。后\n**二**：面')
  })

  it('does nothing to text without strong markers', () => {
    expect(normalizeCardEmphasis('普通文本')).toBe('普通文本')
    expect(normalizeCardEmphasis('')).toBe('')
  })
})

describe('neutralizeCardMarkdown emphasis pass', () => {
  it('repairs the probe-2 shape on the way out', () => {
    expect(neutralizeCardMarkdown('**加粗。**后面')).toBe('**加粗**。后面')
  })

  it('still neutralizes unopenable image and link targets', () => {
    expect(neutralizeCardMarkdown('![alt](runs/a.png)')).toBe('🖼 alt · `runs/a.png`')
    expect(neutralizeCardMarkdown('[label](runs/b.ts)')).toBe('label · `runs/b.ts`')
  })

  it('leaves a real uploaded image key and its emphasis alone', () => {
    const key = 'img_v3_0215q_0a59b5e6-4758-41de-95a5-6f0f2be2a3ag'
    expect(neutralizeCardMarkdown(`**图**：![shot](${key})`)).toBe(`**图**：![shot](${key})`)
  })

  it('leaves the fallback code spans it just created intact', () => {
    const out = neutralizeCardMarkdown('看这张图 **原图**：![a](runs/a.png)')
    expect(out).toBe('看这张图 **原图**：🖼 a · `runs/a.png`')
  })

  it('leaves a span followed by an emoji alone (not verified against Feishu)', () => {
    // CommonMark counts only P* as punctuation, so a symbol after the closer is
    // the one adjacent shape the probe did not cover; the pass stays out of it.
    expect(normalizeCardEmphasis('**看这张图。**🖼 后续')).toBe('**看这张图。**🖼 后续')
  })
})
