import { describe, expect, it } from 'vitest'
import { applyFormulas, extractFormulas, normalizeDisplayLatex } from '../src/doc-formula.ts'

function blocksFromContent(content: string) {
  // Mimic `document.convert`: one text block per paragraph, with the
  // placeholders left exactly where they were in the Markdown.
  return content.split('\n\n').filter(part => part.trim() !== '').map((part, index) => ({
    block_id: `b${index}`,
    block_type: 2,
    text: {
      elements: [{ text_run: { content: part } }],
      style: { align: 1, folded: false },
    },
  }))
}

describe('extractFormulas', () => {
  it('turns an inline $…$ into a token and records the LaTeX', () => {
    const result = extractFormulas('质心 $x^2 + y^2$ 结束')
    expect(result.markdown).toBe('质心 DSHMFI0ZQ 结束')
    expect([...result.inline.entries()]).toEqual([['DSHMFI0ZQ', 'x^2 + y^2']])
    expect(result.block.size).toBe(0)
  })

  it('turns a display formula on its own line into a block token', () => {
    const result = extractFormulas('前文\n\n$$E = mc^2$$\n\n后文')
    expect(result.markdown).toContain('DSHMFB0ZQ')
    expect(result.markdown).not.toContain('$$')
    expect(result.block.get('DSHMFB0ZQ')).toBe('E = mc^2')
    const spliced = applyFormulas(blocksFromContent(result.markdown), result)
    expect(spliced.applied).toBe(1)
    const equationBlock = spliced.blocks.find(block => JSON.stringify(block).includes('"equation"'))
    expect(equationBlock).toMatchObject({
      text: { elements: [{ equation: { content: 'E = mc^2' } }], style: { align: 2 } },
    })
  })

  it('joins a multi-line display formula with a LaTeX line break', () => {
    const result = extractFormulas('$$\na = 1\nb = 2\n$$')
    expect(result.block.get('DSHMFB0ZQ')).toBe('a = 1 \\\\ b = 2')
  })

  it('understands \\[ … \\] display and \\( … \\) inline delimiters', () => {
    const display = extractFormulas('\\[ x^2 + y^2 \\]')
    expect(display.block.get('DSHMFB0ZQ')).toBe('x^2 + y^2')
    const inline = extractFormulas('看 \\(a+b\\) 这里')
    expect(inline.markdown).toBe('看 DSHMFI0ZQ 这里')
    expect(inline.inline.get('DSHMFI0ZQ')).toBe('a+b')
  })

  it('leaves formulas inside code fences and inline code alone', () => {
    const fenced = extractFormulas('```math\n$$E = mc^2$$\n$x$\n```\n')
    expect(fenced.inline.size + fenced.block.size).toBe(0)
    expect(fenced.markdown).toContain('$$E = mc^2$$')
    const inlineCode = extractFormulas('写作 `$x$` 而不是公式')
    expect(inlineCode.inline.size + inlineCode.block.size).toBe(0)
    expect(inlineCode.markdown).toContain('`$x$`')
  })

  it('keeps currency and escaped dollars literal', () => {
    expect(extractFormulas('价格 $5 和 $10').inline.size).toBe(0)
    expect(extractFormulas('\\$x\\$ 不是公式').inline.size).toBe(0)
    expect(extractFormulas('$123.45$').inline.size).toBe(0)
  })
})

describe('applyFormulas', () => {
  it('splits inline equations out of surrounding text and keeps the run style', () => {
    const result = extractFormulas('前 **$a+b$** 后')
    expect(result.markdown).toBe('前 **DSHMFI0ZQ** 后')
    const blocks = [{
      block_id: 'b0',
      block_type: 2,
      text: {
        elements: [
          { text_run: { content: '前 ' } },
          { text_run: { content: 'DSHMFI0ZQ', text_element_style: { bold: true } } },
          { text_run: { content: ' 后' } },
        ],
      },
    }]
    const spliced = applyFormulas(blocks, result)
    expect(spliced.applied).toBe(1)
    expect(blocks[0]?.text.elements).toEqual([
      { text_run: { content: '前 ' } },
      { equation: { content: 'a+b', text_element_style: { bold: true } } },
      { text_run: { content: ' 后' } },
    ])
  })

  it('reports a placeholder token no map can resolve', () => {
    // Simulates a converter that changed a token (or a block shape this pass
    // does not inspect): the token must be surfaced instead of leaking silently.
    const spliced = applyFormulas([{
      block_id: 'b0',
      block_type: 2,
      text: { elements: [{ text_run: { content: 'DSHMFI9ZQ' } }] },
    }], { inline: new Map(), block: new Map() })
    expect(spliced.applied).toBe(0)
    expect(spliced.unresolved).toEqual(['DSHMFI9ZQ'])
  })

  it('turns a paragraph that is only a block token into a centred equation', () => {
    const result = extractFormulas('$$\\frac{a}{b}$$')
    const blocks = blocksFromContent(result.markdown)
    const spliced = applyFormulas(blocks, result)
    expect(spliced.applied).toBe(1)
    expect(JSON.stringify(spliced.blocks)).toContain('"align":2')
    expect(JSON.stringify(spliced.blocks)).toContain('\\\\frac{a}{b}')
  })
})

describe('normalizeDisplayLatex', () => {
  it('trims lines and joins them with a LaTeX line break', () => {
    expect(normalizeDisplayLatex('  a = 1 \n\n b = 2  ')).toBe('a = 1 \\\\ b = 2')
    expect(normalizeDisplayLatex('')).toBe('')
  })
})
