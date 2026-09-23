import { describe, expect, it } from 'vitest'
import {
  imageFallback,
  isCardContentRejection,
  isFeishuImageKey,
  mapCardMarkdownReferences,
  neutralizeCard,
  neutralizeCardMarkdown,
} from '../src/card-markdown.ts'

const KEY = 'img_v3_0215q_0a59b5e6-4758-41de-95a5-a1b2c3d4'

describe('isFeishuImageKey', () => {
  it('accepts the keys Feishu hands out', () => {
    expect(isFeishuImageKey(KEY)).toBe(true)
    expect(isFeishuImageKey('img_v2_38811724')).toBe(true)
    expect(isFeishuImageKey(`  ${KEY}  `)).toBe(true)
  })

  it('rejects paths, URLs and lookalikes', () => {
    expect(isFeishuImageKey('runs/band_gray/x.png')).toBe(false)
    expect(isFeishuImageKey('/abs/x.png')).toBe(false)
    expect(isFeishuImageKey('https://example.com/a.png')).toBe(false)
    expect(isFeishuImageKey('image_key')).toBe(false)
    expect(isFeishuImageKey('')).toBe(false)
  })
})

describe('neutralizeCardMarkdown', () => {
  it('turns a local-path image into text that still names the path', () => {
    expect(neutralizeCardMarkdown('![常用 5 波段](runs/band_gray/montage.png)'))
      .toBe('🖼 常用 5 波段 · `runs/band_gray/montage.png`')
  })

  it('keeps a real uploaded image key untouched', () => {
    const source = `![真图](${KEY})`
    expect(neutralizeCardMarkdown(source)).toBe(source)
  })

  it('neutralizes an image whose src is a public URL', () => {
    // Feishu does not fetch external images: this is rejected exactly like a
    // path is (verified 2026-09-23), so it must not survive either.
    expect(neutralizeCardMarkdown('![a](https://example.com/a.png)'))
      .toBe('🖼 a · `https://example.com/a.png`')
  })

  it('drops a duplicate label, and handles an empty alt', () => {
    expect(neutralizeCardMarkdown('![](runs/a.png)')).toBe('🖼 `runs/a.png`')
    expect(neutralizeCardMarkdown('![runs/a.png](runs/a.png)')).toBe('🖼 `runs/a.png`')
  })

  it('handles the angle-bracket and "title" forms', () => {
    expect(neutralizeCardMarkdown('![a](<runs/a b.png>)')).toBe('🖼 a · `runs/a b.png`')
    expect(neutralizeCardMarkdown('![a](runs/a.png "标题")')).toBe('🖼 a · `runs/a.png`')
  })

  it('downgrades a link Feishu cannot open, but keeps real URLs', () => {
    expect(neutralizeCardMarkdown('[总览图](runs/montage.png)')).toBe('总览图 · `runs/montage.png`')
    expect(neutralizeCardMarkdown('[文档](https://open.feishu.cn/doc)')).toBe('[文档](https://open.feishu.cn/doc)')
    expect(neutralizeCardMarkdown('[mail](mailto:a@b.c)')).toBe('[mail](mailto:a@b.c)')
    expect(neutralizeCardMarkdown('[top](#section)')).toBe('top · `#section`')
  })

  it('leaves closed code spans and fences verbatim', () => {
    const inline = 'run `![x](runs/a.png)` to embed'
    expect(neutralizeCardMarkdown(inline)).toBe(inline)
    const fenced = '```bash\n![x](runs/a.png)\n```'
    expect(neutralizeCardMarkdown(fenced)).toBe(fenced)
    const tildes = '~~~\n![x](runs/a.png)\n~~~'
    expect(neutralizeCardMarkdown(tildes)).toBe(tildes)
  })

  it('rewrites after an UNTERMINATED code span (Feishu still parses it)', () => {
    // Verified: a lone backtick does not protect the image syntax, and the card
    // was rejected. Protecting it here would let the card die.
    expect(neutralizeCardMarkdown('`![x](runs/a.png)')).toBe('`🖼 x · `runs/a.png`')
  })

  it('rewrites a target that itself contains a backtick', () => {
    // Also verified against the API: `![a](runs/a`b.png)` came back as
    // `200570 invalid image keys; ErrorValue: image key runs/a`b.png` — so the
    // backtick does not make it a code span either.
    expect(neutralizeCardMarkdown('![a](runs/a`b.png)')).toBe('🖼 a · `` runs/a`b.png ``')
  })

  it('rewrites inside tables and blockquotes', () => {
    expect(neutralizeCardMarkdown('| a |\n|---|\n| ![x](runs/a.png) |'))
      .toBe('| a |\n|---|\n| 🖼 x · `runs/a.png` |')
    expect(neutralizeCardMarkdown('> ![x](runs/a.png)')).toBe('> 🖼 x · `runs/a.png`')
  })

  it('keeps the fence state across lines', () => {
    const text = '```\n![x](runs/a.png)\n```\n![y](runs/b.png)'
    expect(neutralizeCardMarkdown(text)).toBe('```\n![x](runs/a.png)\n```\n🖼 y · `runs/b.png`')
  })

  it('is idempotent: the fallbacks contain no reference syntax', () => {
    const once = neutralizeCardMarkdown('![a](runs/a.png) and [b](runs/b.png)')
    expect(neutralizeCardMarkdown(once)).toBe(once)
  })

  it('aggressive mode also strips a valid image key', () => {
    const source = `![真图](${KEY})`
    expect(neutralizeCardMarkdown(source, { aggressive: true })).toBe('🖼 真图 · `' + KEY + '`')
  })

  it('leaves text without references alone', () => {
    expect(neutralizeCardMarkdown('no references here')).toBe('no references here')
    expect(neutralizeCardMarkdown('')).toBe('')
  })})

describe('imageFallback', () => {
  it('degrades gracefully for an empty label and target', () => {
    expect(imageFallback('', '')).toBe('🖼')
    expect(imageFallback('图', '')).toBe('🖼 图')
  })
})

describe('mapCardMarkdownReferences', () => {
  it('visits every reference outside code and can keep them', () => {
    const seen: string[] = []
    const text = '![a](runs/a.png) `![b](runs/b.png)` [c](https://x.y)'
    const out = mapCardMarkdownReferences(text, (reference) => {
      seen.push(`${reference.image ? 'img' : 'link'}:${reference.target}`)
      return reference.raw
    })
    expect(out).toBe(text)
    expect(seen).toEqual(['img:runs/a.png', 'link:https://x.y'])
  })
})

describe('neutralizeCard', () => {
  it('rewrites markdown elements anywhere in the tree and copies the rest', () => {
    const card = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '![a](runs/a.png)' } },
      body: {
        elements: [
          { tag: 'markdown', content: '![a](runs/a.png)' },
          { tag: 'hr' },
          { tag: 'img', img_key: KEY },
          {
            tag: 'column_set',
            columns: [{ tag: 'column', elements: [{ tag: 'markdown', content: '![b](runs/b.png)' }] }],
          },
        ],
      },
    }
    const out = neutralizeCard(card) as typeof card
    expect(out.body.elements[0]).toEqual({ tag: 'markdown', content: '🖼 a · `runs/a.png`' })
    expect(((out.body.elements[3] as any).columns[0].elements[0] as any).content).toBe('🖼 b · `runs/b.png`')
    // A plain_text title is not markdown: left alone, and the img key survives.
    expect(out.header.title.content).toBe('![a](runs/a.png)')
    expect(out.body.elements[2]).toEqual({ tag: 'img', img_key: KEY })
  })

  it('does not mutate the input card', () => {
    const card = { body: { elements: [{ tag: 'markdown', content: '![a](runs/a.png)' }] } }
    neutralizeCard(card)
    expect(card.body.elements[0]!.content).toBe('![a](runs/a.png)')
  })
})

describe('isCardContentRejection', () => {
  it('recognises the image-key rejection in the shapes the SDK produces', () => {
    expect(isCardContentRejection(new Error(
      'dsh-feishu: cardkit.card.update failed: code=200570 msg=ErrMsg: card contains invalid image keys')))
      .toBe(true)
    expect(isCardContentRejection(new Error(
      'Failed to create card content, ext=ErrCode: 200570; ErrMsg: card contains invalid image keys')))
      .toBe(true)
    expect(isCardContentRejection('ErrCode: 11310; ErrMsg: card contains invalid image keys')).toBe(true)
    expect(isCardContentRejection(new Error('Failed to create card content, ext=ErrCode: 99999'))).toBe(true)
  })

  it('does not fire for transport, auth or rate-limit failures', () => {
    expect(isCardContentRejection(new Error('Request failed with status code 500'))).toBe(false)
    expect(isCardContentRejection(new Error('dsh-feishu: channel not connected'))).toBe(false)
    expect(isCardContentRejection('rate limit exceeded')).toBe(false)
    expect(isCardContentRejection(undefined)).toBe(false)
  })
})
