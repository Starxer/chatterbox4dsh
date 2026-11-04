import { describe, expect, it, vi } from 'vitest'
import { startFeishuDocCollabTools } from '../src/feishu-doc-collab.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'

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
  docx: { v1: { documentBlock: { list: ReturnType<typeof vi.fn>, patch: ReturnType<typeof vi.fn> } } }
  wiki: { v2: { space: { getNode: ReturnType<typeof vi.fn> } } }
  drive: { v1: { fileComment: { list: ReturnType<typeof vi.fn>, create: ReturnType<typeof vi.fn> } } }
  contact: { v3: { user: { get: ReturnType<typeof vi.fn> } } }
}

function fakeChannel(overrides: Partial<FakeClient> = {}): { channel: LarkChannel, client: FakeClient } {
  const client: FakeClient = {
    docx: {
      v1: {
        documentBlock: {
          list: vi.fn(async () => ({
            data: {
              items: [
                { block_id: 'b-heading', block_type: 3, heading1: { elements: [{ text_run: { content: '标题' } }] } },
                { block_id: 'b-text', block_type: 2, text: { elements: [{ text_run: { content: '正文' } }] } },
                { block_id: 'b-image', block_type: 27, image: { token: 'img_v3_x' } },
              ],
              has_more: false,
            },
          })),
          patch: vi.fn(async () => ({ code: 0 })),
        },
      },
    },
    contact: { v3: { user: { get: vi.fn(async () => ({ data: { user: { name: '张三' } } })) } } },
    wiki: { v2: { space: { getNode: vi.fn() } } },
    drive: {
      v1: {
        fileComment: {
          list: vi.fn(async () => ({
            data: {
              items: [
                {
                  comment_id: 'c1',
                  user_id: 'ou_author',
                  is_whole: true,
                  is_solved: false,
                  reply_list: {
                    replies: [{
                      reply_id: 'r1',
                      user_id: 'ou_author',
                      content: { elements: [{ type: 'text_run', text_run: { text: '请补充数据' } }] },
                    }],
                  },
                },
              ],
              has_more: true,
              page_token: 'next',
            },
          })),
          create: vi.fn(async () => ({ data: { comment_id: 'c-new' } })),
        },
      },
    },
    ...overrides,
  }
  return { channel: { rawClient: client } as unknown as LarkChannel, client }
}

function toolsOver(channel: LarkChannel) {
  const fake = fakeCtx()
  startFeishuDocCollabTools({
    ctx: fake as unknown as Context,
    channelHolder: { current: channel },
    logger: { warn: vi.fn(), error: vi.fn() },
  })
  const byName = (name: string) => fake.registered.find(tool => tool.name === name)
  return { comments: byName('feishu_doc_comments'), blocks: byName('feishu_doc_blocks') }
}

function execCtx(): any {
  return { signal: { throwIfAborted: () => undefined } }
}

describe('feishu_doc_comments', () => {
  it('lists comment threads with their replies', async () => {
    const { channel } = fakeChannel()
    const tool = toolsOver(channel).comments!
    const value = await tool.execute({ target: 'doxcnDoc', action: 'list' }, execCtx())

    expect(value.document_id).toBe('doxcnDoc')
    expect(value.comments).toEqual([
      {
        comment_id: 'c1',
        is_whole: true,
        solved: false,
        user_id: 'ou_author',
        user_name: '张三',
        text: '请补充数据',
        replies: [{ reply_id: 'r1', user_id: 'ou_author', user_name: '张三', text: '请补充数据' }],
      },
    ])
    expect(value.has_more).toBe(true)
    expect(value.next_page_token).toBe('next')
  })

  it('creates a whole-document comment', async () => {
    const { channel, client } = fakeChannel()
    const tool = toolsOver(channel).comments!
    const value = await tool.execute({ target: 'doxcnDoc', action: 'create', text: '已经补上' }, execCtx())

    expect(client.drive.v1.fileComment.create).toHaveBeenCalledWith({
      path: { file_token: 'doxcnDoc' },
      params: { file_type: 'docx' },
      data: { reply_list: { replies: [{ content: { elements: [{ type: 'text_run', text_run: { text: '已经补上' } }] } }] } },
    })
    expect(value).toEqual({ document_id: 'doxcnDoc', comment_id: 'c-new' })
  })

  it('requires text when creating', async () => {
    const { channel } = fakeChannel()
    const tool = toolsOver(channel).comments!
    await expect(tool.execute({ target: 'doxcnDoc', action: 'create' }, execCtx())).rejects.toThrow(/text is required/)
  })
})

describe('feishu_doc_blocks', () => {
  it('lists blocks with type, preview and image token', async () => {
    const { channel } = fakeChannel()
    const tool = toolsOver(channel).blocks!
    const value = await tool.execute({ target: 'doxcnDoc', action: 'list' }, execCtx())

    expect(value.blocks).toEqual([
      { block_id: 'b-heading', type: 'heading1', text: '标题' },
      { block_id: 'b-text', type: 'text', text: '正文' },
      { block_id: 'b-image', type: 'image', image_token: 'img_v3_x' },
    ])
    expect(value.has_more).toBe(false)
  })

  it('updates one block in place, keeping inline Markdown formatting', async () => {
    const { channel, client } = fakeChannel()
    const tool = toolsOver(channel).blocks!
    const value = await tool.execute({
      target: 'doxcnDoc',
      action: 'update',
      block_id: 'b-text',
      text: '新**正文**与 `code`',
    }, execCtx())

    expect(client.docx.v1.documentBlock.patch).toHaveBeenCalledWith({
      path: { document_id: 'doxcnDoc', block_id: 'b-text' },
      data: {
        update_text_elements: {
          elements: [
            { text_run: { content: '新' } },
            { text_run: { content: '正文', text_element_style: { bold: true } } },
            { text_run: { content: '与 ' } },
            { text_run: { content: 'code', text_element_style: { inline_code: true } } },
          ],
        },
      },
    })
    expect(value).toEqual({ document_id: 'doxcnDoc', updated: true })
  })

  it('requires block_id and text when updating', async () => {
    const { channel } = fakeChannel()
    const tool = toolsOver(channel).blocks!
    await expect(tool.execute({ target: 'doxcnDoc', action: 'update', text: 'x' }, execCtx())).rejects.toThrow(/block_id is required/)
    await expect(tool.execute({ target: 'doxcnDoc', action: 'update', block_id: 'b1' }, execCtx())).rejects.toThrow(/text is required/)
  })
})
