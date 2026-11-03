/**
 * `feishu_doc_read` / `feishu_doc_write` model tools: let the agent read and
 * edit Feishu/Lark online documents (docx) as Markdown.
 *
 * Why these exist: chat is the only Feishu surface the channel maps so far, and
 * a Feishu document is where the user's real work already lives. Reading one is
 * one API call (`docs.v1.content.get` returns Markdown for a docx); writing one
 * is the documented Markdown pipeline — `docx.v1.document.convert` turns
 * Markdown into docx blocks, then `documentBlockDescendant.create` inserts
 * them, optionally after clearing the body with `documentBlockChildren.batchDelete`.
 *
 * Identity: the plugin only holds application credentials, so every call runs
 * as the app (tenant access token). Reading or editing a user's document
 * therefore requires the app to be a collaborator on that document; a missing
 * grant surfaces as a permission error from Feishu and the tools explain what
 * to fix. Documents the app creates belong to the app.
 *
 * Not supported on purpose (fail with a clear message instead of guessing):
 * legacy `doc` documents, sheets and bitables. wiki links ARE supported — they
 * are resolved to the underlying docx first.
 *
 * @module @starxer/chatterbox4dsh/feishu-doc
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import { withLinkTimeout } from './outbound-timeout.ts'
import { errorText } from './error-text.ts'

/** Budget for one document API call (reads a whole body, so not the 20s send budget). */
const DOC_REQUEST_TIMEOUT_MS = 30_000
/** Budget for the best-effort metadata lookup that produces the document URL. */
const DOC_META_TIMEOUT_MS = 15_000
/** Characters returned by default; long bodies are truncated with a `next_offset`. */
const DEFAULT_READ_CHARS = 20_000
/** Hard cap for one read, so a huge document cannot flood the context in one call. */
const MAX_READ_CHARS = 60_000
/** docx block type for an image; those need a media upload we do not do yet. */
const IMAGE_BLOCK_TYPE = 27

/** How a target string was interpreted. */
export interface FeishuDocTarget {
  kind: 'docx' | 'wiki'
  token: string
  /** The original link, when the caller passed one (echoed back as the URL). */
  url?: string
}

/** A resolved docx document: whatever a URL or token ultimately points at. */
interface ResolvedDoc {
  documentId: string
  url?: string
  title?: string
}

/** The minimal SDK block shape this module reads and writes back. */
interface DocBlock {
  block_id?: string
  parent_id?: string
  children?: string[]
  block_type: number
  [key: string]: unknown
}

/** Minimal logger surface; matches ctx.logger's call style. */
interface PluginLogger {
  warn(message: string): unknown
  error(message: string): unknown
}

/** Live references read lazily on every execution. */
export interface FeishuDocToolsDeps {
  ctx: Context
  channelHolder: { current: LarkChannel | undefined }
  logger: PluginLogger
}

const DOC_URL_PATTERN = /^https?:\/\/[^/\s]+\/(docx|wiki|docs|doc|sheets|base)\/([A-Za-z0-9_-]+)/u
const BARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/u

/**
 * Interpret a document URL or a bare token.
 *
 * @param input - what the model passed as `target`.
 * @returns the token plus whether it needs wiki resolution.
 * @throws when the input is not a document reference or names an unsupported kind.
 */
export function parseDocTarget(input: string): FeishuDocTarget {
  const text = input.trim()
  if (text === '') throw new Error('target is empty — pass a Feishu document URL or token.')
  const match = DOC_URL_PATTERN.exec(text)
  if (match !== null) {
    const kind = match[1]
    const token = match[2] as string
    if (kind === 'docx') return { kind: 'docx', token, url: text }
    if (kind === 'wiki') return { kind: 'wiki', token, url: text }
    if (kind === 'docs' || kind === 'doc') {
      throw new Error(
        'This is a legacy Feishu document (`doc`) link. These tools only support the new document type (`docx`) — '
        + 'open the document in Feishu once and copy the `docx` link, or ask the user to upgrade it.',
      )
    }
    throw new Error(
      `This link points to a Feishu ${kind} file, not a document. These tools read and write docx documents only; `
      + 'a sheet or bitable needs its own integration.',
    )
  }
  if (BARE_TOKEN_PATTERN.test(text)) return { kind: 'docx', token: text }
  throw new Error(
    'target must be a Feishu document URL (…/docx/<token> or …/wiki/<token>) or a bare document token.',
  )
}

/**
 * Resolve a parsed target to a docx document id.
 *
 * @param channel - live Lark channel (its `rawClient` is the SDK client).
 * @param target - parsed target.
 * @returns document id plus the canonical URL/title when Feishu supplies them.
 */
async function resolveDoc(channel: LarkChannel, target: FeishuDocTarget): Promise<ResolvedDoc> {
  if (target.kind === 'docx') {
    return { documentId: target.token, ...(target.url === undefined ? {} : { url: target.url }) }
  }
  let response: Awaited<ReturnType<LarkChannel['rawClient']['wiki']['v2']['space']['getNode']>>
  try {
    response = await withLinkTimeout(
      channel.rawClient.wiki.v2.space.getNode({ params: { token: target.token } }),
      'resolve wiki node',
      DOC_REQUEST_TIMEOUT_MS,
    )
  } catch (error: unknown) {
    throw docError('resolve the wiki link', error)
  }
  const node = response?.data?.node
  if (node === undefined || node.obj_token === undefined || node.obj_token === '') {
    throw new Error('Feishu did not return a wiki node for that link — check the link or the app\'s wiki permission.')
  }
  if (node.obj_type !== 'docx') {
    throw new Error(
      `That wiki node points to a ${node.obj_type}, not a document. These tools read and write docx documents only.`,
    )
  }
  return {
    documentId: node.obj_token,
    ...(node.url === undefined ? {} : { url: node.url }),
    ...(node.title === undefined ? {} : { title: node.title }),
  }
}

/** What a read returned, and whether formatting survived. */
interface DocBody {
  content: string
  format: 'markdown' | 'text'
}

/**
 * Read the document body, preferring Markdown.
 *
 * `docs.v1.content.get` is the only endpoint that returns Markdown, but it
 * needs its own scope (`docs:document.content:read`). When that scope is
 * missing the docx endpoint `document.rawContent` still returns the plain text
 * (headings and lists collapse to bare lines), so a read degrades instead of
 * failing: the caller is told which format it got.
 */
async function readBody(channel: LarkChannel, documentId: string): Promise<DocBody> {
  try {
    const response = await withLinkTimeout(
      channel.rawClient.docs.v1.content.get({
        params: { doc_token: documentId, doc_type: 'docx', content_type: 'markdown' },
      }),
      'read document',
      DOC_REQUEST_TIMEOUT_MS,
    )
    const content = response?.data?.content
    if (typeof content === 'string') return { content, format: 'markdown' }
  } catch {
    // Fall through to the plain-text endpoint; if that fails too, its error
    // (or the one below) is what the caller should see.
  }
  try {
    const response = await withLinkTimeout(
      channel.rawClient.docx.v1.document.rawContent({ path: { document_id: documentId } }),
      'read document text',
      DOC_REQUEST_TIMEOUT_MS,
    )
    const content = response?.data?.content
    if (typeof content === 'string') return { content, format: 'text' }
  } catch (error: unknown) {
    throw docError('read', error)
  }
  throw new Error('Feishu returned no document content — the token may point to something that is not a document.')
}

/** Best-effort title lookup; a missing title must never fail a read or a write. */
async function documentTitle(channel: LarkChannel, documentId: string): Promise<string | undefined> {
  try {
    const response = await withLinkTimeout(
      channel.rawClient.docx.v1.document.get({ path: { document_id: documentId } }),
      'read document title',
      DOC_META_TIMEOUT_MS,
    )
    const title = response?.data?.document?.title
    return typeof title === 'string' && title !== '' ? title : undefined
  } catch {
    return undefined
  }
}

/** Best-effort canonical URL via `drive.v1.meta.batchQuery(with_url)`. */
async function documentUrl(channel: LarkChannel, documentId: string): Promise<string | undefined> {
  try {
    const response = await withLinkTimeout(
      channel.rawClient.drive.v1.meta.batchQuery({
        data: { request_docs: [{ doc_token: documentId, doc_type: 'docx' }], with_url: true },
      }),
      'read document url',
      DOC_META_TIMEOUT_MS,
    )
    const url = response?.data?.metas?.[0]?.url
    return typeof url === 'string' && url !== '' ? url : undefined
  } catch {
    return undefined
  }
}

/** Convert Markdown into docx blocks via Feishu's own converter. */
async function convertMarkdown(
  channel: LarkChannel,
  markdown: string,
): Promise<{ firstLevel: string[], blocks: DocBlock[] }> {
  let response: Awaited<ReturnType<LarkChannel['rawClient']['docx']['v1']['document']['convert']>>
  try {
    response = await withLinkTimeout(
      channel.rawClient.docx.v1.document.convert({ data: { content_type: 'markdown', content: markdown } }),
      'convert markdown',
      DOC_REQUEST_TIMEOUT_MS,
    )
  } catch (error: unknown) {
    throw docError('convert the Markdown for', error)
  }
  const firstLevel = response?.data?.first_level_block_ids
  const blocks = response?.data?.blocks
  if (!Array.isArray(blocks) || blocks.length === 0) return { firstLevel: [], blocks: [] }
  return {
    firstLevel: Array.isArray(firstLevel) ? firstLevel.filter((id): id is string => typeof id === 'string') : [],
    blocks: blocks as DocBlock[],
  }
}

/** Remove read-only fields Feishu rejects on insert (recursively). */
function stripReadOnlyFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) stripReadOnlyFields(entry)
    return
  }
  if (value === null || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  delete record.merge_info
  delete record.comment_ids
  for (const entry of Object.values(record)) stripReadOnlyFields(entry)
}

/**
 * Turn converter output into an insert request body.
 *
 * Feishu's converter emits image blocks with no media token, and inserting one
 * fails the whole request, so image blocks are dropped together with every
 * reference to them. `merge_info` is read-only and must not be sent back.
 */
export function prepareBlocks(
  blocks: DocBlock[],
  firstLevel: string[],
): { firstLevel: string[], blocks: DocBlock[], skippedImages: number } {
  const imageIds = new Set<string>()
  for (const block of blocks) {
    if (block.block_type === IMAGE_BLOCK_TYPE && typeof block.block_id === 'string') imageIds.add(block.block_id)
  }
  const kept: DocBlock[] = []
  for (const block of blocks) {
    if (typeof block.block_id === 'string' && imageIds.has(block.block_id)) continue
    const copy: DocBlock = { ...block }
    delete copy.parent_id
    if (Array.isArray(copy.children)) copy.children = copy.children.filter(id => !imageIds.has(id))
    stripReadOnlyFields(copy)
    kept.push(copy)
  }
  return {
    firstLevel: firstLevel.filter(id => !imageIds.has(id)),
    blocks: kept,
    skippedImages: imageIds.size,
  }
}

/** The document root block's children — used to append at the end / clear the body. */
async function bodyChildIds(channel: LarkChannel, documentId: string): Promise<string[]> {
  let response: Awaited<ReturnType<LarkChannel['rawClient']['docx']['v1']['documentBlock']['get']>>
  try {
    response = await withLinkTimeout(
      channel.rawClient.docx.v1.documentBlock.get({
        path: { document_id: documentId, block_id: documentId },
      }),
      'read document body',
      DOC_REQUEST_TIMEOUT_MS,
    )
  } catch (error: unknown) {
    throw docError('read the body of', error)
  }
  const children = response?.data?.block?.children
  return Array.isArray(children) ? children.filter((id): id is string => typeof id === 'string') : []
}

/** Delete every top-level block (used by `mode: replace`). */
async function clearBody(channel: LarkChannel, documentId: string, count: number): Promise<void> {
  if (count === 0) return
  try {
    await withLinkTimeout(
      channel.rawClient.docx.v1.documentBlockChildren.batchDelete({
        path: { document_id: documentId, block_id: documentId },
        data: { start_index: 0, end_index: count },
      }),
      'clear document body',
      DOC_REQUEST_TIMEOUT_MS,
    )
  } catch (error: unknown) {
    throw docError('clear the body of', error)
  }
}

/** Insert a converted block tree at `index` under the document root. */
async function insertBlocks(
  channel: LarkChannel,
  documentId: string,
  firstLevel: string[],
  blocks: DocBlock[],
  index: number,
): Promise<void> {
  try {
    await withLinkTimeout(
      channel.rawClient.docx.v1.documentBlockDescendant.create({
        path: { document_id: documentId, block_id: documentId },
        data: { children_id: firstLevel, index, descendants: blocks },
      }),
      'write document blocks',
      DOC_REQUEST_TIMEOUT_MS,
    )
  } catch (error: unknown) {
    throw docError('write', error)
  }
}

/** Create an empty docx document (owned by the app when no folder is given). */
async function createDocument(
  channel: LarkChannel,
  title: string,
  folderToken: string | undefined,
): Promise<string> {
  let response: Awaited<ReturnType<LarkChannel['rawClient']['docx']['v1']['document']['create']>>
  try {
    response = await withLinkTimeout(
      channel.rawClient.docx.v1.document.create({
        data: { title, ...(folderToken === undefined ? {} : { folder_token: folderToken }) },
      }),
      'create document',
      DOC_REQUEST_TIMEOUT_MS,
    )
  } catch (error: unknown) {
    throw docError('create', error)
  }
  const documentId = response?.data?.document?.document_id
  if (typeof documentId !== 'string' || documentId === '') {
    throw new Error('Feishu created no document (no document_id returned) — check the create-document permission.')
  }
  return documentId
}

/**
 * Wrap a Feishu failure with the actionable next step. The permission case is
 * by far the most common one: the app is authenticated but is not a
 * collaborator on the document.
 */
function docError(action: string, error: unknown): Error {
  const reason = errorText(error, `unknown Feishu error while trying to ${action} the document`)
  return new Error(
    `Failed to ${action} the Feishu document: ${reason}. `
    + 'If this is a permission error, add the app as a collaborator on the document '
    + '(文档「…」→ 分享 → 添加协作者 → 搜索应用) and make sure the app has the docx read/write scopes.',
  )
}

/** Read the live channel or explain why the tool cannot run yet. */
function requireChannel(deps: FeishuDocToolsDeps): LarkChannel {
  const channel = deps.channelHolder.current
  if (channel === undefined) {
    throw new Error('dsh-feishu: channel not connected — try again once the Feishu link is up')
  }
  return channel
}

/** Clamp a numeric argument into a sane range. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * Register `feishu_doc_read` and `feishu_doc_write` on the global host context.
 *
 * Both tools work from any agent session (the document API is app-scoped, not
 * chat-scoped); only a live channel is required.
 *
 * @param deps - the host context plus live channel access.
 * @returns a disposer that unregisters both tools.
 */
export function startFeishuDocTools(deps: FeishuDocToolsDeps): () => void {
  const { ctx, logger } = deps

  const readTool = ctx.tools.register(defineTool({
    name: 'feishu_doc_read',
    description:
      'Read a Feishu/Lark online document (docx) as Markdown. Pass the document URL — a `…/docx/<token>` '
      + 'or `…/wiki/<token>` link — or its token. Returns the title, the Markdown body and the document id '
      + 'needed by `feishu_doc_write`. Long bodies are truncated and give a `next_offset` to continue. '
      + 'When the app only has the plain-text scope the body comes back unformatted and `format` says `text`. '
      + 'The Feishu app must be able to read the document, otherwise the call fails and says what to fix.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'Feishu document URL (docx or wiki link) or a bare document token.',
      },
      offset: {
        type: 'number',
        description: 'Character offset to start reading from. Defaults to 0; use the previous result\'s next_offset.',
      },
      max_chars: {
        type: 'number',
        description: `Maximum characters to return (default ${DEFAULT_READ_CHARS}, cap ${MAX_READ_CHARS}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          document_id: { type: 'string', required: true },
          url: { type: 'string' },
          content: { type: 'string', required: true },
          format: { type: 'string', required: true, description: 'markdown, or text when the Markdown read was not permitted.' },
          total_chars: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          next_offset: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const lines: string[] = []
        if (value.title !== undefined && value.title !== '') lines.push(`# ${value.title}`, '')
        lines.push(value.content)
        if (value.format === 'text') {
          lines.push('', '[read as plain text: headings, lists and table structure are not preserved]')
        }
        if (value.truncated) {
          lines.push('', `[truncated: showing ${value.content.length} of ${value.total_chars} characters — continue with offset=${value.next_offset ?? 0}]`)
        }
        lines.push('', `[document_id: ${value.document_id}${value.url === undefined ? '' : ` · ${value.url}`}]`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const channel = requireChannel(deps)
      const target = parseDocTarget(args.target)
      const resolved = await resolveDoc(channel, target)
      const offset = Math.max(0, clamp(args.offset ?? 0, 0, Number.MAX_SAFE_INTEGER))
      const maxChars = clamp(args.max_chars ?? DEFAULT_READ_CHARS, 1, MAX_READ_CHARS)
      const body = await readBody(channel, resolved.documentId)
      const title = resolved.title ?? await documentTitle(channel, resolved.documentId)
      const slice = body.content.slice(offset, offset + maxChars)
      const truncated = offset + slice.length < body.content.length
      const url = resolved.url ?? await documentUrl(channel, resolved.documentId)
      logger.warn(
        `dsh-feishu: feishu_doc_read read ${slice.length}/${body.content.length} chars of `
        + `${resolved.documentId} as ${body.format}`,
      )
      return {
        ...(title === undefined ? {} : { title }),
        document_id: resolved.documentId,
        ...(url === undefined ? {} : { url }),
        content: slice,
        format: body.format,
        total_chars: body.content.length,
        truncated,
        ...(truncated ? { next_offset: offset + slice.length } : {}),
      }
    },
  }))

  const writeTool = ctx.tools.register(defineTool({
    name: 'feishu_doc_write',
    description:
      'Create or edit a Feishu/Lark online document (docx) from Markdown. Modes: `create` makes a new '
      + 'document from `title` + `markdown`; `append` adds `markdown` at the end of the document given by '
      + '`target`; `replace` deletes the whole existing body and writes `markdown` instead. Markdown is '
      + 'converted to native document blocks (headings, lists, tables, code, checkboxes); images are '
      + 'skipped. The Feishu app must be able to edit the target document. Prefer `append` — `replace` '
      + 'destroys content and cannot be undone.',
    parameters: {
      mode: {
        type: 'string',
        enum: ['create', 'append', 'replace'],
        required: true,
        description: 'create a new document, append to the end, or replace the whole body.',
      },
      markdown: {
        type: 'string',
        required: true,
        description: 'Document body as Markdown. Images are skipped; tables and checkboxes are supported.',
      },
      target: {
        type: 'string',
        description: 'Existing document URL or token. Required for `append` and `replace`; unused for `create`.',
      },
      title: {
        type: 'string',
        description: 'Title for the new document (`create` only). Defaults to 未命名文档.',
      },
      folder_token: {
        type: 'string',
        description: 'Folder token to create the document in (`create` only). Defaults to the app\'s own space.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          document_id: { type: 'string', required: true },
          title: { type: 'string' },
          url: { type: 'string' },
          blocks: { type: 'number', required: true },
          skipped_images: { type: 'number', required: true },
          content_chars: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.mode === 'create' ? 'Created' : value.mode === 'append' ? 'Appended to' : 'Replaced the body of'} `
          + `the Feishu document${value.title === undefined ? '' : ` "${value.title}"`} (document_id: ${value.document_id})`
          + `${value.url === undefined ? '' : ` ${value.url}`}. `
          + `Wrote ${value.blocks} block(s) from ${value.content_chars} characters`
          + `${value.skipped_images === 0 ? '' : `; skipped ${value.skipped_images} image(s)`}.`,
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const channel = requireChannel(deps)
      const markdown = args.markdown
      if (markdown.trim() === '') throw new Error('markdown is empty — nothing to write.')

      const mode = args.mode
      let documentId: string
      let url: string | undefined
      let title: string | undefined

      if (mode === 'create') {
        title = args.title?.trim() === '' || args.title === undefined ? '未命名文档' : args.title.trim()
        documentId = await createDocument(channel, title, args.folder_token)
        url = await documentUrl(channel, documentId)
      } else {
        if (args.target === undefined || args.target.trim() === '') {
          throw new Error(`target is required for mode "${mode}" — pass the document URL or token.`)
        }
        const resolved = await resolveDoc(channel, parseDocTarget(args.target))
        documentId = resolved.documentId
        url = resolved.url
        title = resolved.title
      }

      const converted = await convertMarkdown(channel, markdown)
      const prepared = prepareBlocks(converted.blocks, converted.firstLevel)
      if (prepared.firstLevel.length === 0) {
        throw new Error('The Markdown produced no insertable blocks (images are skipped) — add some text content.')
      }

      if (mode === 'create') {
        await insertBlocks(channel, documentId, prepared.firstLevel, prepared.blocks, 0)
      } else {
        const children = await bodyChildIds(channel, documentId)
        if (mode === 'replace') {
          await clearBody(channel, documentId, children.length)
          await insertBlocks(channel, documentId, prepared.firstLevel, prepared.blocks, 0)
        } else {
          await insertBlocks(channel, documentId, prepared.firstLevel, prepared.blocks, children.length)
        }
      }

      if (title === undefined) title = await documentTitle(channel, documentId)
      if (url === undefined) url = await documentUrl(channel, documentId)
      logger.warn(
        `dsh-feishu: feishu_doc_write ${mode} ${prepared.blocks.length} block(s) into ${documentId}`
        + ` (${prepared.skippedImages} image block(s) skipped)`,
      )
      return {
        mode,
        document_id: documentId,
        ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }),
        blocks: prepared.blocks.length,
        skipped_images: prepared.skippedImages,
        content_chars: markdown.length,
      }
    },
  }))

  return () => {
    readTool()
    writeTool()
  }
}
