import { describe, expect, it } from 'vitest'
import { parseInlineMarkdown, textElementsFromMarkdown } from '../src/inline-markdown.ts'

describe('parseInlineMarkdown', () => {
  it('returns one plain run for plain text', () => {
    expect(parseInlineMarkdown('普通文本')).toEqual([{ text: '普通文本', style: {} }])
  })

  it('parses bold, italic, strikethrough, inline code and links', () => {
    expect(parseInlineMarkdown('前 **粗** 中 *斜* 后')).toEqual([
      { text: '前 ', style: {} },
      { text: '粗', style: { bold: true } },
      { text: ' 中 ', style: {} },
      { text: '斜', style: { italic: true } },
      { text: ' 后', style: {} },
    ])
    expect(parseInlineMarkdown('~~删~~')).toEqual([{ text: '删', style: { strikethrough: true } }])
    expect(parseInlineMarkdown('看 `a*b*c` 就行')).toEqual([
      { text: '看 ', style: {} },
      { text: 'a*b*c', style: { inlineCode: true } },
      { text: ' 就行', style: {} },
    ])
    expect(parseInlineMarkdown('[飞书](https://x.feishu.cn)')).toEqual([
      { text: '飞书', style: { link: 'https://x.feishu.cn' } },
    ])
  })

  it('nests emphasis and keeps link labels formatted', () => {
    expect(parseInlineMarkdown('**粗 *斜* 粗**')).toEqual([
      { text: '粗 ', style: { bold: true } },
      { text: '斜', style: { bold: true, italic: true } },
      { text: ' 粗', style: { bold: true } },
    ])
    expect(parseInlineMarkdown('[**重要**链接](https://x)')).toEqual([
      { text: '重要', style: { bold: true, link: 'https://x' } },
      { text: '链接', style: { link: 'https://x' } },
    ])
  })

  it('honours escapes and leaves unterminated markers literal', () => {
    expect(parseInlineMarkdown('\\*不是斜体\\*')).toEqual([{ text: '*不是斜体*', style: {} }])
    expect(parseInlineMarkdown('未闭合 **粗')).toEqual([{ text: '未闭合 **粗', style: {} }])
    expect(parseInlineMarkdown('单个 ` 反引号')).toEqual([{ text: '单个 ` 反引号', style: {} }])
  })

  it('does not italicise intraword underscores', () => {
    expect(parseInlineMarkdown('snake_case_name')).toEqual([{ text: 'snake_case_name', style: {} }])
  })

  it('merges adjacent runs with the same style', () => {
    expect(parseInlineMarkdown('**a****b**')).toEqual([{ text: 'ab', style: { bold: true } }])
  })
})

describe('textElementsFromMarkdown', () => {
  it('maps the parsed runs onto docx text elements', () => {
    expect(textElementsFromMarkdown('a **b** `c` [d](https://x)')).toEqual([
      { text_run: { content: 'a ' } },
      { text_run: { content: 'b', text_element_style: { bold: true } } },
      { text_run: { content: ' ' } },
      { text_run: { content: 'c', text_element_style: { inline_code: true } } },
      { text_run: { content: ' ' } },
      { text_run: { content: 'd', text_element_style: { link: { url: 'https://x' } } } },
    ])
  })

  it('returns a single plain element for plain text', () => {
    expect(textElementsFromMarkdown('新正文')).toEqual([{ text_run: { content: '新正文' } }])
  })
})
