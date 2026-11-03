/**
 * `feishu_doc_comments` and `feishu_doc_blocks`: the collaboration half of the
 * Feishu online-document tools.
 *
 * `feishu_doc_read` / `feishu_doc_write` move a whole document in or out, which
 * is the wrong instrument for working *on* a document someone else is also
 * editing. These two tools add the two operations collaboration actually needs:
 *
 * - **comments** — read the document's comment threads (the reader's feedback)
 *   and post a whole-document comment. Feishu's comment-creation API only
 *   supports whole-document comments, and replying to such a comment is
 *   rejected by the platform (`1069302 The comment section does not allow
 *   replies`, measured 2026-11-04), so `create` is deliberately the only write
 *   action here.
 * - **blocks** — list the document's blocks with their ids and text, and
 *   rewrite one block's text in place. This is the surgical edit path: it
 *   leaves every other block (and every human-made structure the Markdown
 *   converter cannot reproduce) untouched.
 *
 * Both tools share the document resolution rules of `feishu-doc.ts` (docx and
 * wiki links) and the same bounded outbound calls.
 *
 * @module @starxer/chatterbox4dsh/feishu-doc-collab
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import { withLinkTimeout } from './outbound-timeout.ts'
import { errorText } from './error-text.ts'
import { parseDocTarget, resolveDoc } from './feishu-doc.ts'

/** Budget for one document API call. */
const DOC_REQUEST_TIMEOUT_MS = 30_000
/** Default page size for comments and blocks. */
const DEFAULT_PAGE_SIZE = 50
/** Hard cap on one page (both APIs accept up to 200). */
const MAX_PAGE_SIZE = 200
/** How much of one block's text a listing carries. */
const BLOCK_TEXT_CHARS = 200

/** Minimal logger surface; matches ctx.logger's call style. */
interface PluginLogger {
  warn(message: string): unknown
  error(message: string): unknown
}

/** Live references read lazily on every execution. */
export interface FeishuDocCollabDeps {
  ctx: Context
  channelHolder: { current: LarkChannel | undefined }
  logger: PluginLogger
}

/** Feishu block type numbers → names, for the tool surface. */
const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: 'page',
  2: 'text',
  3: 'heading1',
  4: 'heading2',
  5: 'heading3',
  6: 'heading4',
  7: 'heading5',
  8: 'heading6',
  9: 'heading7',
  10: 'heading8',
  11: 'heading9',
  12: 'bullet',
  13: 'ordered',
  14: 'code',
  15: 'quote',
  17: 'todo',
  18: 'bitable',
  19: 'callout',
  20: 'chat_card',
  21: 'diagram',
  22: 'divider',
  23: 'file',
  24: 'grid',
  25: 'grid_column',
  26: 'iframe',
  27: 'image',
  28: 'isv',
  29: 'mindnote',
  30: 'sheet',
  31: 'table',
  32: 'table_cell',
  33: 'view',
  34: 'quote_container',
  35: 'task',
  36: 'okr',
}

/** One text-bearing payload of a docx block, keyed by block type. */
const TEXT_PAYLOAD_KEYS = [
  'text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6',
  'heading7', 'heading8', 'heading9', 'bullet', 'ordered', 'code', 'quote', 'todo',
] as const

/** A text element as the comment API returns it. */
interface CommentElement {
  /** Comment replies carry `text`; docx block elements carry `content`. */
  text_run?: { text?: string, content?: string }
  docs_link?: { url?: string }
  person?: { user_id?: string }
}

/** Plain text of one rich-text element list. */
function elementsText(elements: readonly CommentElement[] | undefined): string {
  if (elements === undefined) return ''
  return elements.map(element => {
    if (typeof element.text_run?.text === 'string') return element.text_run.text
    if (typeof element.text_run?.content === 'string') return element.text_run.content
    if (typeof element.docs_link?.url === 'string') return element.docs_link.url
    if (typeof element.person?.user_id === 'string') return `@${element.person.user_id}`
    return ''
  }).join('')
}

/** Plain text of one docx block, or '' when the block carries no text. */
function blockText(block: Record<string, unknown>): string {
  for (const key of TEXT_PAYLOAD_KEYS) {
    const payload = block[key] as { elements?: CommentElement[] } | undefined
    if (payload?.elements !== undefined) return elementsText(payload.elements)
  }
  return ''
}

/** Clamp a numeric argument into a sane range. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Wrap a Feishu failure with the actionable next step. */
function docError(action: string, error: unknown): Error {
  const reason = errorText(error, `unknown Feishu error while trying to ${action} the document`)
  return new Error(
    `Failed to ${action} the Feishu document: ${reason}. `
    + 'If this is a permission error, add the app as a collaborator on the document '
    + '(文档「…」→ 分享 → 添加协作者 → 搜索应用) and make sure the app has the docx scopes.',
  )
}

/** Read the live channel or explain why the tool cannot run yet. */
function requireChannel(deps: FeishuDocCollabDeps): LarkChannel {
  const channel = deps.channelHolder.current
  if (channel === undefined) {
    throw new Error('dsh-feishu: channel not connected — try again once the Feishu link is up')
  }
  return channel
}

/** Resolve a docx/wiki link or token to a document id (plus url/title hints). */
async function resolveTarget(
  deps: FeishuDocCollabDeps,
  target: string,
): Promise<{ channel: LarkChannel, documentId: string }> {
  const channel = requireChannel(deps)
  const resolved = await resolveDoc(channel, parseDocTarget(target))
  return { channel, documentId: resolved.documentId }
}

/**
 * Register `feishu_doc_comments` and `feishu_doc_blocks` on the global host
 * context.
 *
 * @param deps - the host context plus live channel access.
 * @returns a disposer that unregisters both tools.
 */
export function startFeishuDocCollabTools(deps: FeishuDocCollabDeps): () => void {
  const { ctx, logger } = deps

  const commentsTool = ctx.tools.register(defineTool({
    name: 'feishu_doc_comments',
    description:
      'Read or post comments on a Feishu/Lark online document (docx). `action: list` returns the '
      + 'comment threads (id, whole-document or anchored quote, solved state, replies) so the agent '
      + 'can see the reader\'s feedback; `action: create` posts a new whole-document comment with '
      + '`text`. Feishu only supports whole-document comments for API creation, and replies to such '
      + 'comments are rejected by the platform, so this tool does not reply inside a thread.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'Feishu document URL (docx or wiki link) or a bare document token.',
      },
      action: {
        type: 'string',
        enum: ['list', 'create'],
        required: true,
        description: 'list comments, or create one whole-document comment.',
      },
      text: {
        type: 'string',
        description: 'Comment text (`create` only). Plain text.',
      },
      solved: {
        type: 'boolean',
        description: 'Only resolved (`true`) or only unresolved (`false`) comments (`list` only).',
      },
      page_size: {
        type: 'number',
        description: `Comments per page (default ${DEFAULT_PAGE_SIZE}, cap ${MAX_PAGE_SIZE}).`,
      },
      page_token: {
        type: 'string',
        description: 'Page token from a previous result (`list` only).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          document_id: { type: 'string', required: true },
          comment_id: { type: 'string' },
          comments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                comment_id: { type: 'string', required: true },
                is_whole: { type: 'boolean', required: true },
                solved: { type: 'boolean', required: true },
                quote: { type: 'string' },
                text: { type: 'string' },
                replies: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      reply_id: { type: 'string' },
                      text: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          next_page_token: { type: 'string' },
          has_more: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        if (value.comment_id !== undefined) {
          return [{ type: 'text', text: `Created a whole-document comment on ${value.document_id} (comment_id: ${value.comment_id}).` }]
        }
        const comments = value.comments ?? []
        if (comments.length === 0) {
          return [{ type: 'text', text: `No comments on ${value.document_id}.` }]
        }
        const lines = comments.map((comment, index) => {
          const state = `${comment.is_whole ? 'whole-document' : 'anchored'}${comment.solved ? ', solved' : ''}`
          const quote = comment.quote === undefined || comment.quote === '' ? '' : ` (quote: ${comment.quote})`
          const replies = comment.replies === undefined || comment.replies.length === 0
            ? ''
            : `\n${comment.replies.map(reply => `    - ${reply.text ?? ''}`).join('\n')}`
          return `${index + 1}. [${comment.comment_id}] ${state}${quote}\n   ${comment.text ?? ''}${replies}`
        })
        const paging = value.has_more === true && value.next_page_token !== undefined
          ? `\n\n[more comments: page_token=${value.next_page_token}]`
          : ''
        return [{ type: 'text', text: `Comments on ${value.document_id}:\n\n${lines.join('\n')}${paging}` }]
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const { channel, documentId } = await resolveTarget(deps, args.target)

      if (args.action === 'create') {
        const text = args.text?.trim() ?? ''
        if (text === '') throw new Error('text is required for action "create".')
        try {
          const response = await withLinkTimeout(
            channel.rawClient.drive.v1.fileComment.create({
              path: { file_token: documentId },
              params: { file_type: 'docx' },
              data: {
                reply_list: {
                  replies: [{ content: { elements: [{ type: 'text_run', text_run: { text } }] } }],
                },
              },
            }),
            'create document comment',
            DOC_REQUEST_TIMEOUT_MS,
          )
          const commentId = response?.data?.comment_id
          if (typeof commentId !== 'string' || commentId === '') {
            throw new Error('Feishu created no comment id — check the document comment permission.')
          }
          logger.warn(`dsh-feishu: feishu_doc_comments created ${commentId} on ${documentId}`)
          return { document_id: documentId, comment_id: commentId }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.startsWith('Feishu created no comment')) throw error
          throw docError('comment on', error)
        }
      }

      const pageSize = clamp(args.page_size ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
      let response: Awaited<ReturnType<LarkChannel['rawClient']['drive']['v1']['fileComment']['list']>>
      try {
        response = await withLinkTimeout(
          channel.rawClient.drive.v1.fileComment.list({
            path: { file_token: documentId },
            params: {
              file_type: 'docx',
              page_size: pageSize,
              ...(args.solved === undefined ? {} : { is_solved: args.solved }),
              ...(args.page_token === undefined ? {} : { page_token: args.page_token }),
            },
          }),
          'list document comments',
          DOC_REQUEST_TIMEOUT_MS,
        )
      } catch (error: unknown) {
        throw docError('read comments of', error)
      }

      const comments = (response?.data?.items ?? []).map(item => {
        const replies = (item.reply_list?.replies ?? []).map(reply => ({
          ...(typeof reply.reply_id === 'string' ? { reply_id: reply.reply_id } : {}),
          text: elementsText(reply.content?.elements),
        }))
        return {
          comment_id: typeof item.comment_id === 'string' ? item.comment_id : '',
          is_whole: item.is_whole === true,
          solved: item.is_solved === true,
          ...(typeof item.quote === 'string' && item.quote !== '' ? { quote: item.quote } : {}),
          ...(replies[0]?.text === undefined ? {} : { text: replies[0].text }),
          ...(replies.length === 0 ? {} : { replies }),
        }
      }).filter(comment => comment.comment_id !== '')

      return {
        document_id: documentId,
        comments,
        has_more: response?.data?.has_more === true,
        ...(typeof response?.data?.page_token === 'string' && response.data.page_token !== ''
          ? { next_page_token: response.data.page_token }
          : {}),
      }
    },
  }))

  const blocksTool = ctx.tools.register(defineTool({
    name: 'feishu_doc_blocks',
    description:
      'List or rewrite blocks of a Feishu/Lark online document (docx). `action: list` returns block '
      + 'ids with their type and a text preview — use it to find the block to change. `action: update` '
      + 'replaces one block\'s text in place (`block_id` + `text`), leaving every other block and the '
      + 'document\'s human-made structure untouched; the block keeps its type, but its inline formatting '
      + 'is reset to plain text.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'Feishu document URL (docx or wiki link) or a bare document token.',
      },
      action: {
        type: 'string',
        enum: ['list', 'update'],
        required: true,
        description: 'list blocks, or update one block\'s text.',
      },
      block_id: {
        type: 'string',
        description: 'The block to rewrite (`update` only). Take it from `action: list`.',
      },
      text: {
        type: 'string',
        description: 'New plain text for the block (`update` only).',
      },
      page_size: {
        type: 'number',
        description: `Blocks per page (default ${DEFAULT_PAGE_SIZE}, cap ${MAX_PAGE_SIZE}).`,
      },
      page_token: {
        type: 'string',
        description: 'Page token from a previous result (`list` only).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          document_id: { type: 'string', required: true },
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                block_id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                text: { type: 'string' },
                image_token: { type: 'string' },
              },
            },
          },
          next_page_token: { type: 'string' },
          has_more: { type: 'boolean' },
          updated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        if (value.updated === true) {
          return [{ type: 'text', text: `Updated one block of ${value.document_id}.` }]
        }
        const blocks = value.blocks ?? []
        if (blocks.length === 0) return [{ type: 'text', text: `No blocks returned for ${value.document_id}.` }]
        const lines = blocks.map((block, index) => {
          const preview = block.text === undefined || block.text === '' ? '' : ` ${block.text}`
          const image = block.image_token === undefined ? '' : ` [image ${block.image_token}]`
          return `${index + 1}. [${block.block_id}] ${block.type}${image}${preview}`
        })
        return [{ type: 'text', text: `Blocks of ${value.document_id}:\n\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const { channel, documentId } = await resolveTarget(deps, args.target)

      if (args.action === 'update') {
        if (args.block_id === undefined || args.block_id.trim() === '') {
          throw new Error('block_id is required for action "update" — list the blocks first.')
        }
        if (args.text === undefined) throw new Error('text is required for action "update".')
        try {
          await withLinkTimeout(
            channel.rawClient.docx.v1.documentBlock.patch({
              path: { document_id: documentId, block_id: args.block_id },
              data: { update_text_elements: { elements: [{ text_run: { content: args.text } }] } },
            }),
            'update document block',
            DOC_REQUEST_TIMEOUT_MS,
          )
        } catch (error: unknown) {
          throw docError('update a block of', error)
        }
        logger.warn(`dsh-feishu: feishu_doc_blocks updated ${args.block_id} in ${documentId}`)
        return { document_id: documentId, updated: true }
      }

      const pageSize = clamp(args.page_size ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
      let response: Awaited<ReturnType<LarkChannel['rawClient']['docx']['v1']['documentBlock']['list']>>
      try {
        response = await withLinkTimeout(
          channel.rawClient.docx.v1.documentBlock.list({
            path: { document_id: documentId },
            params: {
              page_size: pageSize,
              ...(args.page_token === undefined ? {} : { page_token: args.page_token }),
            },
          }),
          'list document blocks',
          DOC_REQUEST_TIMEOUT_MS,
        )
      } catch (error: unknown) {
        throw docError('read blocks of', error)
      }

      const blocks = (response?.data?.items ?? []).map(block => {
        const record = block as unknown as Record<string, unknown>
        const text = blockText(record).slice(0, BLOCK_TEXT_CHARS)
        const imageToken = block.block_type === 27
          ? (record.image as { token?: string } | undefined)?.token
          : undefined
        return {
          block_id: typeof block.block_id === 'string' ? block.block_id : '',
          type: BLOCK_TYPE_NAMES[block.block_type] ?? String(block.block_type),
          ...(text === '' ? {} : { text }),
          ...(typeof imageToken === 'string' && imageToken !== '' ? { image_token: imageToken } : {}),
        }
      }).filter(block => block.block_id !== '')

      return {
        document_id: documentId,
        blocks,
        has_more: response?.data?.has_more === true,
        ...(typeof response?.data?.page_token === 'string' && response.data.page_token !== ''
          ? { next_page_token: response.data.page_token }
          : {}),
      }
    },
  }))

  return () => {
    commentsTool()
    blocksTool()
  }
}
