import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { htmlTablesToMarkdown, imageRefsIn, parseDocTarget, prepareBlocks, startFeishuDocTools } from '../src/feishu-doc.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { HarnessConversationService } from '../src/harness.ts'

/** Real 1x1 PNG so the image sniffing path is exercised, not mocked. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function tempImage(name = 'pic.png', bytes: Buffer = PNG_1X1): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-doc-'))
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

/** Minimal Cordis context exposing only tools.register. */
function fakeCtx() {
  const registered: Array<any> = []
  return {
    registered,
    tools: {
      register: (tool: any) => {
        registered.push(tool)
        return () => undefined
      },
    },
  }
}

interface FakeClient {
  docs: { v1: { content: { get: ReturnType<typeof vi.fn> } } }
  docx: {
    v1: {
      document: { get: ReturnType<typeof vi.fn>, create: ReturnType<typeof vi.fn>, convert: ReturnType<typeof vi.fn>, rawContent: ReturnType<typeof vi.fn> }
      documentBlock: { get: ReturnType<typeof vi.fn>, list: ReturnType<typeof vi.fn>, patch: ReturnType<typeof vi.fn> }
      documentBlockChildren: { batchDelete: ReturnType<typeof vi.fn> }
      documentBlockDescendant: { create: ReturnType<typeof vi.fn> }
    }
  }
  wiki: { v2: { space: { getNode: ReturnType<typeof vi.fn> } } }
  drive: {
    v1: {
      meta: { batchQuery: ReturnType<typeof vi.fn> }
      media: { uploadAll: ReturnType<typeof vi.fn>, batchGetTmpDownloadUrl: ReturnType<typeof vi.fn> }
      permissionMember: { create: ReturnType<typeof vi.fn> }
    }
  }
}

function fakeChannel(overrides: Partial<FakeClient> = {}): { channel: LarkChannel, client: FakeClient } {
  const client: FakeClient = {
    docs: { v1: { content: { get: vi.fn(async () => ({ data: { content: '# Hello\n\nworld' } })) } } },
    docx: {
      v1: {
        document: {
          get: vi.fn(async () => ({ data: { document: { title: 'Test Doc' } } })),
          create: vi.fn(async () => ({ data: { document: { document_id: 'doxcnNEW' } } })),
          rawContent: vi.fn(async () => ({ data: { content: 'plain text body' } })),
          convert: vi.fn(async () => ({
            data: {
              first_level_block_ids: ['b1', 'b2'],
              blocks: [
                { block_id: 'b1', block_type: 3, heading1: { elements: [] } },
                { block_id: 'b2', block_type: 27, image: {} },
                { block_id: 'b3', block_type: 2, text: { elements: [], merge_info: { a: 1 } } },
              ],
            },
          })),
        },
        documentBlock: {
          get: vi.fn(async () => ({ data: { block: { children: ['x', 'y'] } } })),
          list: vi.fn(async () => ({ data: { items: [], has_more: false } })),
          patch: vi.fn(async () => ({ code: 0 })),
        },
        documentBlockChildren: { batchDelete: vi.fn(async () => ({ data: {} })) },
        documentBlockDescendant: { create: vi.fn(async () => ({ data: {} })) },
      },
    },
    wiki: { v2: { space: { getNode: vi.fn(async () => ({ data: { node: { obj_token: 'doxcnWIKI', obj_type: 'docx', url: 'https://x.feishu.cn/wiki/NODE', title: 'Wiki Doc' } } })) } } },
    drive: {
      v1: {
        meta: { batchQuery: vi.fn(async () => ({ data: { metas: [{ url: 'https://x.feishu.cn/docx/doxcnNEW' }] } })) },
        media: {
          uploadAll: vi.fn(async () => ({ file_token: 'img_v3_test' })),
          batchGetTmpDownloadUrl: vi.fn(async () => ({
            data: { tmp_download_urls: [{ file_token: 'img_v3_x', tmp_download_url: 'https://x/img' }] },
          })),
        },
        permissionMember: { create: vi.fn(async () => ({ code: 0 })) },
      },
    },
    ...overrides,
  }
  return { channel: { rawClient: client } as unknown as LarkChannel, client }
}

function toolsOver(channel: LarkChannel, bridge?: HarnessConversationService) {
  const fake = fakeCtx()
  startFeishuDocTools({
    ctx: fake as unknown as Context,
    channelHolder: { current: channel },
    ...(bridge === undefined ? {} : { bridgeHolder: { current: bridge } }),
    logger: { warn: vi.fn(), error: vi.fn() },
  })
  const byName = (name: string) => fake.registered.find(tool => tool.name === name)
  return { read: byName('feishu_doc_read'), write: byName('feishu_doc_write') }
}

function execCtx(): any {
  return { agent: { id: 'session-1' }, signal: { throwIfAborted: () => undefined } }
}

describe('parseDocTarget', () => {
  it('parses docx and wiki links and bare tokens', () => {
    expect(parseDocTarget('https://acme.feishu.cn/docx/doxcnAbCdEf')).toMatchObject({ kind: 'docx', token: 'doxcnAbCdEf' })
    expect(parseDocTarget('https://acme.feishu.cn/wiki/wikcn12345?from=share')).toMatchObject({ kind: 'wiki', token: 'wikcn12345' })
    expect(parseDocTarget('doxcn12345678')).toMatchObject({ kind: 'docx', token: 'doxcn12345678' })
  })

  it('rejects legacy docs, sheets and junk', () => {
    expect(() => parseDocTarget('https://acme.feishu.cn/docs/doccn123456')).toThrow(/legacy/i)
    expect(() => parseDocTarget('https://acme.feishu.cn/sheets/shtcn123456')).toThrow(/not a document/i)
    expect(() => parseDocTarget('not a link')).toThrow(/document URL/)
    expect(() => parseDocTarget('   ')).toThrow(/empty/)
  })
})

describe('prepareBlocks', () => {
  it('drops image blocks and read-only fields', () => {
    const prepared = prepareBlocks(
      [
        { block_id: 'a', block_type: 2, parent_id: 'root', text: { elements: [{ text_run: { content: 'hi', text_element_style: { comment_ids: ['c'] } } }] } },
        { block_id: 'img', block_type: 27, image: {} },
        { block_id: 'b', block_type: 31, children: ['c1'], table: { merge_info: [1] } },
        { block_id: 'c1', block_type: 32, parent_id: 'b', children: [] },
      ],
      ['a', 'img', 'b'],
    )
    expect(prepared.skippedImages).toBe(1)
    expect(prepared.firstLevel).toEqual(['a', 'b'])
    expect(prepared.blocks.map(block => block.block_id)).toEqual(['a', 'b', 'c1'])
    expect(prepared.blocks.every(block => block.parent_id === undefined)).toBe(true)
    expect(JSON.stringify(prepared.blocks)).not.toContain('merge_info')
    expect(JSON.stringify(prepared.blocks)).not.toContain('comment_ids')
  })
})

describe('htmlTablesToMarkdown', () => {
  it('rewrites the HTML tables Feishu returns into Markdown tables', () => {
    const html = '<table><tbody><tr><td>列 A</td><td>列 B</td></tr><tr><td>1</td><td>2</td></tr></tbody></table>'
    expect(htmlTablesToMarkdown(html)).toBe('| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |')
    // Non-table content is left alone.
    expect(htmlTablesToMarkdown('plain **text**')).toBe('plain **text**')
  })
})

describe('imageRefsIn', () => {
  it('classifies local, remote and relative targets', () => {
    const refs = imageRefsIn('![a](/tmp/a.png) ![b](https://x/y.png) ![c](./c.png)')
    expect(refs.map(ref => ref.local !== undefined)).toEqual([true, false, false])
    expect(refs[1]?.skipReason).toMatch(/remote/i)
    expect(refs[2]?.skipReason).toMatch(/relative/i)
  })
})

describe('feishu_doc_read', () => {
  it('reads a docx link as markdown with its title', async () => {
    const { channel } = fakeChannel()
    const tool = toolsOver(channel).read!
    const value = await tool.execute({ target: 'https://acme.feishu.cn/docx/doxcnAbCdEf' }, execCtx())
    expect(value.document_id).toBe('doxcnAbCdEf')
    expect(value.title).toBe('Test Doc')
    expect(value.content).toBe('# Hello\n\nworld')
    expect(value.format).toBe('markdown')
    expect(value.truncated).toBe(false)
  })

  it('resolves a wiki link to the underlying document', async () => {
    const { channel, client } = fakeChannel()
    const tool = toolsOver(channel).read!
    const value = await tool.execute({ target: 'https://acme.feishu.cn/wiki/wikcn12345' }, execCtx())
    expect(client.wiki.v2.space.getNode).toHaveBeenCalledWith({ params: { token: 'wikcn12345' } })
    expect(client.docs.v1.content.get).toHaveBeenCalledWith({
      params: { doc_token: 'doxcnWIKI', doc_type: 'docx', content_type: 'markdown' },
    })
    expect(value.title).toBe('Wiki Doc')
    expect(value.url).toBe('https://x.feishu.cn/wiki/NODE')
  })

  it('falls back to plain text when the Markdown read is not permitted', async () => {
    const { channel, client } = fakeChannel({
      docs: { v1: { content: { get: vi.fn(async () => { throw new Error('Access denied') }) } } },
    })
    const tool = toolsOver(channel).read!
    const value = await tool.execute({ target: 'doxcn12345678' }, execCtx())
    expect(client.docx.v1.document.rawContent).toHaveBeenCalledWith({ path: { document_id: 'doxcn12345678' } })
    expect(value.content).toBe('plain text body')
    expect(value.format).toBe('text')
  })

  it('reports the revision and the image blocks the body omits', async () => {
    const { channel, client } = fakeChannel({
      docs: { v1: { content: { get: vi.fn(async () => ({ data: { content: 'body' } })) } } },
    })
    client.docx.v1.document.get = vi.fn(async () => ({ data: { document: { title: 'T', revision_id: 7 } } }))
    client.docx.v1.documentBlock.list = vi.fn(async () => ({
      data: { items: [{ block_id: 'imgblk', block_type: 27, image: { token: 'img_v3_x' } }], has_more: false },
    }))
    const tool = toolsOver(channel).read!
    const value = await tool.execute({ target: 'doxcn12345678' }, execCtx())

    expect(value.revision_id).toBe(7)
    expect(value.images).toEqual([{ block_id: 'imgblk', token: 'img_v3_x', url: 'https://x/img' }])
  })

  it('truncates long bodies and reports the next offset', async () => {
    const { channel } = fakeChannel({
      docs: { v1: { content: { get: vi.fn(async () => ({ data: { content: 'abcdefghij' } })) } } },
    })
    const tool = toolsOver(channel).read!
    const first = await tool.execute({ target: 'doxcn12345678', max_chars: 4 }, execCtx())
    expect(first.content).toBe('abcd')
    expect(first.total_chars).toBe(10)
    expect(first.truncated).toBe(true)
    expect(first.next_offset).toBe(4)
    const second = await tool.execute({ target: 'doxcn12345678', offset: first.next_offset, max_chars: 100 }, execCtx())
    expect(second.content).toBe('efghij')
    expect(second.truncated).toBe(false)
  })
})

describe('feishu_doc_write', () => {
  it('appends converted blocks at the end of an existing document', async () => {
    const { channel, client } = fakeChannel()
    const tool = toolsOver(channel).write!
    const value = await tool.execute({
      mode: 'append',
      target: 'https://acme.feishu.cn/docx/doxcnAbCdEf',
      markdown: '# Title\n\nbody',
      revision: 1,
    }, execCtx())

    expect(client.docx.v1.document.convert).toHaveBeenCalledWith({
      data: { content_type: 'markdown', content: '# Title\n\nbody' },
    })
    expect(client.docx.v1.documentBlockDescendant.create).toHaveBeenCalledWith({
      path: { document_id: 'doxcnAbCdEf', block_id: 'doxcnAbCdEf' },
      data: {
        children_id: ['b1'],
        index: 2,
        descendants: expect.any(Array),
      },
    })
    expect(value.mode).toBe('append')
    expect(value.document_id).toBe('doxcnAbCdEf')
    expect(value.blocks).toBe(2)
    expect(value.images_uploaded).toBe(0)
    expect(value.images_skipped).toBe(0)
  })

  it('clears the body before writing in replace mode', async () => {
    const { channel, client } = fakeChannel()
    client.docx.v1.document.get = vi.fn(async () => ({ data: { document: { title: 'T', revision_id: 2 } } }))
    const tool = toolsOver(channel).write!
    await tool.execute({ mode: 'replace', target: 'doxcnAbCdEf', markdown: 'new body', revision: 2 }, execCtx())

    expect(client.docx.v1.documentBlockChildren.batchDelete).toHaveBeenCalledWith({
      path: { document_id: 'doxcnAbCdEf', block_id: 'doxcnAbCdEf' },
      data: { start_index: 0, end_index: 2 },
    })
    expect(client.docx.v1.documentBlockDescendant.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ index: 0 }),
    }))
  })

  it('creates a document and returns its url', async () => {
    const { channel, client } = fakeChannel()
    const tool = toolsOver(channel).write!
    const value = await tool.execute({ mode: 'create', title: 'New Doc', markdown: 'hello' }, execCtx())

    expect(client.docx.v1.document.create).toHaveBeenCalledWith({ data: { title: 'New Doc' } })
    expect(client.docs.v1.content.get).not.toHaveBeenCalled()
    expect(value.document_id).toBe('doxcnNEW')
    expect(value.url).toBe('https://x.feishu.cn/docx/doxcnNEW')
    expect(value.title).toBe('New Doc')
  })

  it('uploads a local image and attaches it to the inserted image block', async () => {
    const path = await tempImage()
    const { channel, client } = fakeChannel()
    client.docx.v1.documentBlock.list = vi.fn(async () => ({
      data: { items: [{ block_id: 'imgblk', block_type: 27, image: { token: '' } }], has_more: false },
    }))
    const tool = toolsOver(channel).write!
    const value = await tool.execute({ mode: 'append', target: 'doxcnAbCdEf', markdown: `![pic](${path})`, revision: 1 }, execCtx())

    expect(client.drive.v1.media.uploadAll).toHaveBeenCalledWith({
      data: expect.objectContaining({ parent_node: 'imgblk', parent_type: 'docx_image', file: expect.any(Buffer) }),
    })
    expect(client.docx.v1.documentBlock.patch).toHaveBeenCalledWith({
      path: { document_id: 'doxcnAbCdEf', block_id: 'imgblk' },
      data: { replace_image: { token: 'img_v3_test' } },
    })
    expect(value.images_uploaded).toBe(1)
    expect(value.images_skipped).toBe(0)
  })

  it('skips remote images without fetching them', async () => {
    const { channel, client } = fakeChannel()
    const tool = toolsOver(channel).write!
    const value = await tool.execute({
      mode: 'append',
      target: 'doxcnAbCdEf',
      markdown: '![x](https://example.com/a.png)',
      revision: 1,
    }, execCtx())

    expect(client.drive.v1.media.uploadAll).not.toHaveBeenCalled()
    expect(value.images_uploaded).toBe(0)
    expect(value.images_skipped).toBe(1)
  })

  it('shares a newly created document with the asking user', async () => {
    const { channel, client } = fakeChannel()
    const bridge = {
      resolveChat: () => ({ chatId: 'oc_x', chatType: 'p2p' }),
      lastSenderFor: () => 'ou_requester',
    } as unknown as HarnessConversationService
    const tool = toolsOver(channel, bridge).write!
    const value = await tool.execute({ mode: 'create', markdown: 'hello' }, execCtx())

    expect(client.drive.v1.permissionMember.create).toHaveBeenCalledWith({
      path: { token: 'doxcnNEW' },
      params: { type: 'docx', need_notification: true },
      data: { member_type: 'openid', member_id: 'ou_requester', perm: 'edit', type: 'user' },
    })
    expect(value.shared).toBe(true)
  })

  it('sticks to create-only sharing', async () => {
    const { channel, client } = fakeChannel()
    const bridge = {
      resolveChat: () => ({ chatId: 'oc_x', chatType: 'p2p' }),
      lastSenderFor: () => 'ou_requester',
    } as unknown as HarnessConversationService
    const tool = toolsOver(channel, bridge).write!
    const value = await tool.execute({ mode: 'append', target: 'doxcnAbCdEf', markdown: 'x', revision: 1 }, execCtx())

    expect(client.drive.v1.permissionMember.create).not.toHaveBeenCalled()
    expect(value.shared).toBe(false)
  })

  it('refuses to write when the document moved past the expected revision', async () => {
    const { channel, client } = fakeChannel()
    client.docx.v1.document.get = vi.fn(async () => ({ data: { document: { title: 'T', revision_id: 9 } } }))
    const tool = toolsOver(channel).write!
    await expect(tool.execute({ mode: 'append', target: 'doxcnAbCdEf', markdown: 'x', revision: 8 }, execCtx()))
      .rejects.toThrow(/changed since it was read/)
    expect(client.docx.v1.documentBlockDescendant.create).not.toHaveBeenCalled()
  })

  it('requires a revision for replace mode', async () => {
    const { channel } = fakeChannel()
    const tool = toolsOver(channel).write!
    await expect(tool.execute({ mode: 'replace', target: 'doxcnAbCdEf', markdown: 'x' }, execCtx()))
      .rejects.toThrow(/needs the `revision_id`/)
  })

  it('reads the body from a Markdown file and resolves relative images', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-doc-md-'))
    const imagePath = join(dir, 'pic.png')
    await writeFile(imagePath, PNG_1X1)
    const mdPath = join(dir, 'doc.md')
    await writeFile(mdPath, '# 文件标题\n\n![图](pic.png)\n')

    const { channel, client } = fakeChannel()
    client.docx.v1.documentBlock.list = vi.fn(async () => ({
      data: { items: [{ block_id: 'imgblk', block_type: 27, image: { token: '' } }], has_more: false },
    }))
    const tool = toolsOver(channel).write!
    const value = await tool.execute({ mode: 'create', path: mdPath }, execCtx())

    expect(client.drive.v1.media.uploadAll).toHaveBeenCalledWith({
      data: expect.objectContaining({ parent_node: 'imgblk', parent_type: 'docx_image' }),
    })
    expect(value.title).toBe('文件标题')
    expect(value.images_uploaded).toBe(1)
  })

  it('refuses append without a revision', async () => {
    const { channel } = fakeChannel()
    const tool = toolsOver(channel).write!
    await expect(tool.execute({ mode: 'append', target: 'doxcnAbCdEf', markdown: 'x' }, execCtx()))
      .rejects.toThrow(/needs the `revision_id`/)
  })

  it('refuses replace when the document has blocks Markdown cannot reproduce', async () => {
    const { channel, client } = fakeChannel()
    client.docx.v1.documentBlock.list = vi.fn(async () => ({
      data: { items: [{ block_id: 'cb', block_type: 19, callout: {} }], has_more: false },
    }))
    const tool = toolsOver(channel).write!
    await expect(tool.execute({
      mode: 'replace', target: 'doxcnAbCdEf', markdown: 'x', revision: 1,
    }, execCtx())).rejects.toThrow(/Markdown cannot reproduce \(callout\)/)
    expect(client.docx.v1.documentBlockChildren.batchDelete).not.toHaveBeenCalled()

    const value = await tool.execute({
      mode: 'replace', target: 'doxcnAbCdEf', markdown: 'x', revision: 1, allow_format_loss: true,
    }, execCtx())
    expect(value.mode).toBe('replace')
    expect(client.docx.v1.documentBlockChildren.batchDelete).toHaveBeenCalled()
  })

  it('requires a target outside create mode', async () => {
    const { channel } = fakeChannel()
    const tool = toolsOver(channel).write!
    await expect(tool.execute({ mode: 'append', markdown: 'x', revision: 1 }, execCtx())).rejects.toThrow(/target is required/)
  })
})
