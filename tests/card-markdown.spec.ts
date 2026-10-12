import { describe, expect, it } from 'vitest'
import {
  imageFallback,
  isCardContentRejection,
  isFeishuImageKey,
  mapCardMarkdownReferences,
  neutralizeCard,
  neutralizeCardMarkdown,
  repairGluedFenceClosers,
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

describe('repairGluedFenceClosers: a closer the model glued to its code line', () => {
  /**
   * The real thing (2026-10-12, an assistant message reporting an ERO script's
   * options): the closing fence is stuck to the end of the only code line, so
   * the block never closes and everything below renders as code.
   */
  const REAL = [
    '找到两个关键点,先跟你确认再跑:',
    '',
    '## ① ERO 没有 `--width/--height` 参数',
    '',
    '```',
    '--size {draft, draft-v, quality, quality-v}   ← 只有这四个写死档```',
    '',
    'SIZES = `draft 896×512` / `quality 1152×640`。',
  ].join('\n')

  it('moves the glued run onto its own line, so the prose below stays prose', () => {
    expect(repairGluedFenceClosers(REAL)).toBe([
      '找到两个关键点,先跟你确认再跑:',
      '',
      '## ① ERO 没有 `--width/--height` 参数',
      '',
      '```',
      '--size {draft, draft-v, quality, quality-v}   ← 只有这四个写死档',
      '```',
      '',
      'SIZES = `draft 896×512` / `quality 1152×640`。',
    ].join('\n'))
  })

  it('does it on the send path too, before the passes that skip code', () => {
    // The card gate is where every element passes, and the repair has to run
    // first: `![x](…)` below the glued line used to be skipped as "inside code".
    const text = '```\ncode```\n![x](runs/a.png)'
    expect(neutralizeCardMarkdown(text)).toBe('```\ncode\n```\n🖼 x · `runs/a.png`')
  })

  it('leaves a BALANCED element alone, even when code ends with a fence run', () => {
    // Documenting fences inside a fence is legitimate: this one closes later, so
    // the trailing run is content rather than a closer.
    const documented = ['```md', '代码块以 ``` 结束', '写一行 ```', '```'].join('\n')
    expect(repairGluedFenceClosers(documented)).toBe(documented)
  })

  it('leaves an unterminated element with no glued run alone (nothing safe to do)', () => {
    const missing = ['```', 'echo hi', '正文再也没关'].join('\n')
    expect(repairGluedFenceClosers(missing)).toBe(missing)
  })

  it('only counts a run at least as long as the OPENER', () => {
    // Inside a four-backtick fence a three-backtick line is content, not a
    // closer — that is how nesting is written.
    const nested = ['````', '```', 'inner', '正文'].join('\n')
    expect(repairGluedFenceClosers(nested)).toBe(nested)
  })

  it('handles tildes and trailing spaces, and stays idempotent', () => {
    const tildes = '~~~\nconfig~~~   \nbelow'
    expect(repairGluedFenceClosers(tildes)).toBe('~~~\nconfig\n~~~\nbelow')
    const once = repairGluedFenceClosers(REAL)
    expect(repairGluedFenceClosers(once)).toBe(once)
    expect(neutralizeCardMarkdown(once)).toBe(neutralizeCardMarkdown(neutralizeCardMarkdown(once)))
  })
})

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

  it('drops our media elements on the last-resort retry', () => {
    const card = {
      body: {
        elements: [
          { tag: 'markdown', content: '前' },
          { tag: 'video', file_key: 'file_v3_x_y', cover: { img_key: KEY } },
          { tag: 'markdown', content: '后' },
        ],
      },
    }
    const gentle = neutralizeCard(card) as typeof card
    // Nothing is dropped unless Feishu actually refused the card.
    expect(gentle.body.elements[1]).toMatchObject({ tag: 'video' })
    const out = neutralizeCard(card, { aggressive: true }) as typeof card
    expect(out.body.elements[1]).toEqual({ tag: 'markdown', content: '📹 `file_v3_x_y`' })
  })
})

describe('audio markup neutralization', () => {
  const FILE_KEY = 'file_v3_00or_f2c1276b-9f24-463d-8911'

  it('keeps a player whose file_key Feishu handed out', () => {
    const text = `[听]<audio file_key='${FILE_KEY}' audio_id='a1' show_time=true></audio>`
    expect(neutralizeCardMarkdown(text)).toBe(text)
  })

  it('degrades a player with a path or a bogus key to readable text', () => {
    expect(neutralizeCardMarkdown("<audio file_key='runs/a.opus'></audio>"))
      .toBe('🔊 `runs/a.opus`')
    expect(neutralizeCardMarkdown('<audio file_key=""></audio>'))
      .toBe('🔊 `<audio file_key=""></audio>`')
  })

  it('leaves the markup literal inside a fence or a closed code span', () => {
    const fenced = "```\n<audio file_key='x'></audio>\n```"
    expect(neutralizeCardMarkdown(fenced)).toBe(fenced)
    const spanned = "`<audio file_key='x'></audio>`"
    expect(neutralizeCardMarkdown(spanned)).toBe(spanned)
  })

  it('is idempotent, so a retry does not mangle the fallback', () => {
    const once = neutralizeCardMarkdown("<audio file_key='runs/a.opus'></audio>")
    expect(neutralizeCardMarkdown(once)).toBe(once)
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
