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

import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import { withLinkTimeout } from './outbound-timeout.ts'
import { errorText } from './error-text.ts'
import { sniffImageMime } from './media-sniff.ts'
import type { HarnessConversationService } from './harness.ts'

/** Budget for one document API call (reads a whole body, so not the 20s send budget). */
const DOC_REQUEST_TIMEOUT_MS = 30_000
/** Budget for the best-effort metadata lookup that produces the document URL. */
const DOC_META_TIMEOUT_MS = 15_000
/** Characters returned by default; long bodies are truncated with a `next_offset`. */
const DEFAULT_READ_CHARS = 20_000
/** Hard cap for one read, so a huge document cannot flood the context in one call. */
const MAX_READ_CHARS = 60_000
/** docx block type for an image (filled in after insert by a media upload). */
const IMAGE_BLOCK_TYPE = 27
/** Largest image the document writer will upload; Feishu's own image upload ceiling. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** Budget for one media upload (much more than a metadata call). */
const MEDIA_UPLOAD_TIMEOUT_MS = 60_000
/** `![alt](target "title")` — the target is what decides local vs remote. */
const IMAGE_REF_PATTERN = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu

/** How a target string was interpreted. */
export interface FeishuDocTarget {
  kind: 'docx' | 'wiki'
  token: string
  /** The original link, when the caller passed one (echoed back as the URL). */
  url?: string
}

/** A resolved docx document: whatever a URL or token ultimately points at. */
export interface ResolvedDoc {
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
  /** Chat binding service: used to find the open id of the asking user so a
   *  newly created (bot-owned) document can be shared with them. */
  bridgeHolder?: { current: HarnessConversationService | undefined }
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
export async function resolveDoc(channel: LarkChannel, target: FeishuDocTarget): Promise<ResolvedDoc> {
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
  keepImage: (index: number) => boolean = () => false,
): { firstLevel: string[], blocks: DocBlock[], skippedImages: number, keptImages: number } {
  // Image blocks are numbered in document order so the caller can keep exactly
  // the ones it has a local file for; every other image block is dropped
  // together with the references to it.
  const imageIds = new Set<string>()
  let imageIndex = 0
  let keptImages = 0
  for (const block of blocks) {
    if (block.block_type !== IMAGE_BLOCK_TYPE) continue
    if (keepImage(imageIndex)) keptImages += 1
    else if (typeof block.block_id === 'string') imageIds.add(block.block_id)
    imageIndex += 1
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
    keptImages,
  }
}

/** One `![](…)` reference found in the Markdown, in document order. */
interface ImageRef {
  target: string
  /** Absolute local path when the target names a readable local file. */
  local?: string
  /** Why this one will not be uploaded. */
  skipReason?: string
}

/**
 * Find every image reference in the Markdown, in order.
 *
 * Only absolute local paths can be uploaded: remote URLs would mean fetching
 * arbitrary URLs from the host (and silently pulling outside content into the
 * tenant's documents), and a relative path has no unambiguous base because the
 * Markdown arrives as text, not as a file on disk.
 *
 * @param markdown - the body about to be converted.
 * @returns one entry per reference, including the ones that will be skipped.
 */
export function imageRefsIn(markdown: string, baseDir?: string): ImageRef[] {
  const refs: ImageRef[] = []
  for (const match of markdown.matchAll(IMAGE_REF_PATTERN)) {
    const target = match[1]
    if (target === undefined || target === '') continue
    if (/^https?:\/\//iu.test(target) || /^data:/iu.test(target)) {
      refs.push({ target, skipReason: 'remote image, not fetched' })
      continue
    }
    if (target.startsWith('/')) {
      refs.push({ target, local: target })
      continue
    }
    // A relative path is only meaningful when we know the Markdown file it is
    // relative to (the `path` input); with inline Markdown there is no base.
    if (baseDir === undefined) {
      refs.push({ target, skipReason: 'relative path — pass `path` so it can be resolved' })
      continue
    }
    refs.push({ target, local: resolve(baseDir, target) })
  }
  return refs
}

/** A local file that passed the size/type checks and can be uploaded. */
interface LoadedImage {
  bytes: Buffer
  fileName: string
}

/** Read one local image, or explain why it cannot be used. */
async function loadImage(path: string): Promise<LoadedImage | { skipReason: string }> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { skipReason: 'not a regular file' }
    if (info.size === 0) return { skipReason: 'empty file' }
    if (info.size > MAX_IMAGE_BYTES) return { skipReason: `larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` }
    const bytes = await readFile(path)
    if (sniffImageMime(bytes) === undefined) return { skipReason: 'not a png/jpeg/webp/gif image' }
    return { bytes, fileName: basename(path) }
  } catch {
    return { skipReason: 'cannot read the file' }
  }
}

/** Pair `documentBlock.list` pages with the images awaiting a media token. */
async function emptyImageBlockIds(channel: LarkChannel, documentId: string): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const response = await withLinkTimeout(
      channel.rawClient.docx.v1.documentBlock.list({
        path: { document_id: documentId },
        params: { page_size: 200, ...(pageToken === undefined ? {} : { page_token: pageToken }) },
      }),
      'list document blocks',
      DOC_REQUEST_TIMEOUT_MS,
    )
    for (const block of response?.data?.items ?? []) {
      if (block.block_type !== IMAGE_BLOCK_TYPE) continue
      const token = (block as { image?: { token?: string } }).image?.token
      if (typeof token === 'string' && token !== '') continue
      if (typeof block.block_id === 'string') ids.push(block.block_id)
    }
    if (response?.data?.has_more !== true) break
    pageToken = response?.data?.page_token
    if (pageToken === undefined || pageToken === '') break
  }
  return ids
}

/**
 * Upload the local images and attach each one to its (already inserted) image
 * block: `media.uploadAll` with `parent_type: docx_image` and the image block
 * id as `parent_node`, then `documentBlock.patch` with `replace_image`.
 *
 * Failures are per image and never abort the write: the block simply stays
 * empty and the count is reported.
 */
async function fillDocumentImages(
  channel: LarkChannel,
  documentId: string,
  images: LoadedImage[],
): Promise<{ uploaded: number, failed: number }> {
  if (images.length === 0) return { uploaded: 0, failed: 0 }
  let blocks: string[]
  try {
    blocks = await emptyImageBlockIds(channel, documentId)
  } catch {
    return { uploaded: 0, failed: images.length }
  }
  let uploaded = 0
  let failed = 0
  for (let index = 0; index < images.length; index++) {
    const blockId = blocks[index]
    const image = images[index]
    if (blockId === undefined || image === undefined) {
      failed += 1
      continue
    }
    try {
      const uploaded_ = await withLinkTimeout(
        channel.rawClient.drive.v1.media.uploadAll({
          data: {
            file_name: image.fileName,
            parent_type: 'docx_image',
            parent_node: blockId,
            size: image.bytes.byteLength,
            file: image.bytes,
          },
        }),
        'upload document image',
        MEDIA_UPLOAD_TIMEOUT_MS,
      )
      const token = (uploaded_ as { file_token?: string } | null)?.file_token
        ?? (uploaded_ as { data?: { file_token?: string } } | null)?.data?.file_token
      if (typeof token !== 'string' || token === '') {
        failed += 1
        continue
      }
      await withLinkTimeout(
        channel.rawClient.docx.v1.documentBlock.patch({
          path: { document_id: documentId, block_id: blockId },
          data: { replace_image: { token } },
        }),
        'attach document image',
        DOC_REQUEST_TIMEOUT_MS,
      )
      uploaded += 1
    } catch {
      failed += 1
    }
  }
  return { uploaded, failed }
}

/**
 * Grant the asking user edit access to a document the bot owns.
 *
 * A tenant-token document is owned by the bot, so without this the user gets a
 * link they cannot open. A failure here is reported (not thrown): the document
 * itself was written fine.
 */
async function shareDocument(channel: LarkChannel, documentId: string, openId: string): Promise<boolean> {
  try {
    const response = await withLinkTimeout(
      channel.rawClient.drive.v1.permissionMember.create({
        path: { token: documentId },
        params: { type: 'docx', need_notification: true },
        data: { member_type: 'openid', member_id: openId, perm: 'edit', type: 'user' },
      }),
      'share document',
      DOC_META_TIMEOUT_MS,
    )
    return response?.code === undefined || response.code === 0
  } catch {
    return false
  }
}

/**
 * Rewrite the `<table>` HTML that `docs.v1.content.get` emits inside its
 * Markdown into GitHub-style Markdown tables.
 *
 * Feishu returns table BLOCKS as raw HTML even in `content_type: markdown`.
 * Left as-is, a read→edit→replace round trip turns a table into a literal HTML
 * dump; converting it back keeps tables editable.
 *
 * @param markdown - document body as returned by Feishu.
 * @returns the body with every simple table rewritten as a Markdown table.
 */
export function htmlTablesToMarkdown(markdown: string): string {
  return markdown.replace(/<table[^>]*>([\s\S]*?)<\/table>/giu, (whole, body: string) => {
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/giu)]
      .map(row => [...(row[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/giu)]
        .map(cell => (cell[1] ?? '')
          .replace(/<[^>]+>/gu, ' ')
          .replace(/&nbsp;/giu, ' ')
          .replace(/&amp;/giu, '&')
          .replace(/&lt;/giu, '<')
          .replace(/&gt;/giu, '>')
          .replace(/&quot;/giu, '"')
          .replace(/&#39;/gu, "'")
          .replace(/\s+/gu, ' ')
          .replace(/\|/gu, '\\|')
          .trim()))
    if (rows.length === 0 || rows[0] === undefined || rows[0].length === 0) return whole
    const width = rows[0].length
    const lines = rows.map(cells => `| ${Array.from({ length: width }, (_v, index) => cells[index] ?? '').join(' | ')} |`)
    lines.splice(1, 0, `| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
    return lines.join('\n')
  })
}

/** docx block types the Markdown converter can produce; everything else is lost by `replace`. */
const CONVERTIBLE_BLOCK_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 17, 22, 27, 31, 32])

/** Human names for the block types the converter cannot reproduce. */
const LOSSY_BLOCK_NAMES: Record<number, string> = {
  18: 'bitable', 19: 'callout', 20: 'chat card', 21: 'diagram', 23: 'file attachment',
  24: 'grid (columns)', 25: 'grid column', 26: 'iframe', 28: 'isv block', 29: 'mindnote',
  30: 'sheet embed', 33: 'view', 34: 'quote container', 35: 'task', 36: 'okr', 37: 'add-on',
  38: 'jira issue', 39: 'wiki catalog', 40: 'board', 45: 'link preview', 47: 'sub-page list',
}

/**
 * Block types present in the document that a Markdown rewrite would destroy.
 *
 * `replace` deletes the body and re-inserts converted Markdown, which cannot
 * express callouts, grids, embeds and similar blocks. This scan lets the tool
 * refuse that trade (unless the caller explicitly accepts the loss).
 */
async function lossyBlockTypes(channel: LarkChannel, documentId: string): Promise<string[]> {
  const found = new Map<number, string>()
  try {
    let pageToken: string | undefined
    for (let page = 0; page < 5; page++) {
      const response = await withLinkTimeout(
        channel.rawClient.docx.v1.documentBlock.list({
          path: { document_id: documentId },
          params: { page_size: 200, ...(pageToken === undefined ? {} : { page_token: pageToken }) },
        }),
        'scan document blocks',
        DOC_REQUEST_TIMEOUT_MS,
      )
      for (const block of response?.data?.items ?? []) {
        if (CONVERTIBLE_BLOCK_TYPES.has(block.block_type)) continue
        found.set(block.block_type, BLOCK_NAMES_FOR_LOSSY.get(block.block_type) ?? `block type ${block.block_type}`)
      }
      if (response?.data?.has_more !== true) break
      pageToken = response?.data?.page_token
      if (pageToken === undefined || pageToken === '') break
    }
  } catch {
    return []
  }
  return [...found.values()]
}

const BLOCK_NAMES_FOR_LOSSY = new Map(Object.entries(LOSSY_BLOCK_NAMES).map(([key, value]) => [Number(key), value]))

/**
 * Temporary download URLs for image materials, keyed by media token.
 *
 * Markdown never contains images, so a reader otherwise knows only that a
 * picture exists. Best-effort: a failure leaves the URLs out.
 */
async function imageDownloadUrls(
  channel: LarkChannel,
  tokens: string[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  if (tokens.length === 0) return urls
  try {
    const response = await withLinkTimeout(
      channel.rawClient.drive.v1.media.batchGetTmpDownloadUrl({ params: { file_tokens: tokens } }),
      'get document image urls',
      DOC_META_TIMEOUT_MS,
    )
    for (const entry of response?.data?.tmp_download_urls ?? []) {
      if (typeof entry.file_token === 'string' && typeof entry.tmp_download_url === 'string') {
        urls.set(entry.file_token, entry.tmp_download_url)
      }
    }
  } catch {
    return urls
  }
  return urls
}

/** Current document revision id (used as an optimistic-concurrency token). */
async function documentRevision(channel: LarkChannel, documentId: string): Promise<number | undefined> {
  try {
    const response = await withLinkTimeout(
      channel.rawClient.docx.v1.document.get({ path: { document_id: documentId } }),
      'read document revision',
      DOC_META_TIMEOUT_MS,
    )
    const revision = response?.data?.document?.revision_id
    return typeof revision === 'number' ? revision : undefined
  } catch {
    return undefined
  }
}

/**
 * Image blocks in the document, in order, with their media tokens.
 *
 * The Markdown reader (`docs.v1.content.get`) omits images entirely, so this
 * block scan is the only way to tell a reader that the document contains
 * pictures. Bounded and best-effort: a listing failure must not fail a read.
 */
async function documentImages(
  channel: LarkChannel,
  documentId: string,
): Promise<Array<{ block_id: string, token: string }>> {
  const images: Array<{ block_id: string, token: string }> = []
  try {
    let pageToken: string | undefined
    for (let page = 0; page < 5; page++) {
      const response = await withLinkTimeout(
        channel.rawClient.docx.v1.documentBlock.list({
          path: { document_id: documentId },
          params: { page_size: 200, ...(pageToken === undefined ? {} : { page_token: pageToken }) },
        }),
        'list document blocks',
        DOC_REQUEST_TIMEOUT_MS,
      )
      for (const block of response?.data?.items ?? []) {
        if (block.block_type !== IMAGE_BLOCK_TYPE) continue
        if (typeof block.block_id !== 'string') continue
        const token = (block as { image?: { token?: string } }).image?.token
        images.push({ block_id: block.block_id, token: typeof token === 'string' ? token : '' })
      }
      if (response?.data?.has_more !== true) break
      pageToken = response?.data?.page_token
      if (pageToken === undefined || pageToken === '') break
    }
  } catch {
    return images
  }
  return images
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
      + 'Also returns the current `revision_id` (pass it to `feishu_doc_write` to avoid overwriting newer '
      + 'edits) and the image blocks, which the Markdown body never includes. '
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
          revision_id: { type: 'number', description: 'Current revision; pass it to feishu_doc_write to refuse overwriting newer edits.' },
          images: {
            type: 'array',
            description: 'Image blocks found outside the Markdown body (the body never includes them).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                block_id: { type: 'string', required: true },
                token: { type: 'string' },
                url: { type: 'string', description: 'Temporary download URL (expires; best-effort).' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        // The body already opens with the document's title as a heading (the
        // title block is part of the document), so the title belongs in the
        // metadata line rather than in a second heading above it.
        const lines: string[] = [value.content]
        if (value.format === 'text') {
          lines.push('', '[read as plain text: headings, lists and table structure are not preserved]')
        }
        if (value.truncated) {
          lines.push('', `[truncated: showing ${value.content.length} of ${value.total_chars} characters — continue with offset=${value.next_offset ?? 0}]`)
        }
        const title = value.title === undefined || value.title === '' ? '' : ` · title: ${value.title}`
        const revision = value.revision_id === undefined ? '' : ` · revision: ${value.revision_id}`
        const images = value.images === undefined || value.images.length === 0
          ? ''
          : ` · ${value.images.length} image block(s) not shown in the body`
        lines.push('', `[document_id: ${value.document_id}${title}${revision}${images}${value.url === undefined ? '' : ` · ${value.url}`}]`)
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
      const content = body.format === 'markdown' ? htmlTablesToMarkdown(body.content) : body.content
      const title = resolved.title ?? await documentTitle(channel, resolved.documentId)
      const revisionId = await documentRevision(channel, resolved.documentId)
      const imageBlocks = await documentImages(channel, resolved.documentId)
      const urls = await imageDownloadUrls(channel, imageBlocks.map(image => image.token).filter(token => token !== ''))
      const images = imageBlocks.map(image => ({
        ...image,
        ...(urls.get(image.token) === undefined ? {} : { url: urls.get(image.token) as string }),
      }))
      const slice = content.slice(offset, offset + maxChars)
      const truncated = offset + slice.length < content.length
      const url = resolved.url ?? await documentUrl(channel, resolved.documentId)
      logger.warn(
        `dsh-feishu: feishu_doc_read read ${slice.length}/${content.length} chars of `
        + `${resolved.documentId} as ${body.format}`,
      )
      return {
        ...(title === undefined ? {} : { title }),
        document_id: resolved.documentId,
        ...(url === undefined ? {} : { url }),
        content: slice,
        format: body.format,
        total_chars: content.length,
        truncated,
        ...(truncated ? { next_offset: offset + slice.length } : {}),
        ...(revisionId === undefined ? {} : { revision_id: revisionId }),
        ...(images.length === 0 ? {} : { images }),
      }
    },
  }))

  const writeTool = ctx.tools.register(defineTool({
    name: 'feishu_doc_write',
    description:
      'Create or edit a Feishu/Lark online document (docx) from Markdown. Modes: `create` makes a new '
      + 'document from `title` + `markdown`; `append` adds `markdown` at the end of the document given by '
      + '`target`; `replace` deletes the whole existing body and writes `markdown` instead. Markdown is '
      + 'converted to native document blocks (headings, lists, tables, code, checkboxes). Images are '
      + 'uploaded and embedded when the reference points at a local png/jpeg/webp/gif under 10 MB '
      + '(relative paths are resolved against `path` when the body comes from a file); remote URLs '
      + 'are never fetched. The body comes from `path` (a Markdown file — preferred for long '
      + 'documents) or inline `markdown`. With `create`, the new document is shared with the user '
      + 'who asked for it. `append` and `replace` REQUIRE the `revision_id` from `feishu_doc_read`, '
      + 'so a stale copy cannot silently overwrite newer edits; `replace` additionally refuses to '
      + 'run when the document contains blocks Markdown cannot reproduce (pass '
      + '`allow_format_loss: true` to accept that). The Feishu app must be able to edit the target '
      + 'document. Prefer `append`.',
    parameters: {
      mode: {
        type: 'string',
        enum: ['create', 'append', 'replace'],
        required: true,
        description: 'create a new document, append to the end, or replace the whole body (replace requires `revision`).',
      },
      markdown: {
        type: 'string',
        description: 'Document body as Markdown (inline). Use `path` instead for long documents; pass exactly one of the two.',
      },
      path: {
        type: 'string',
        description: 'Absolute path of a Markdown file in the workspace to read the body from. Images '
          + 'referenced relatively are resolved against this file\'s directory.',
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
      revision: {
        type: 'number',
        description: 'The `revision_id` a previous `feishu_doc_read` returned. Required for `append` '
          + 'and `replace`: the write is refused if the document has changed since then. Ignored for '
          + '`create`.',
      },
      allow_format_loss: {
        type: 'boolean',
        description: '`replace` only. Set true to overwrite a document that contains blocks Markdown '
          + 'cannot reproduce (callouts, grids, embeds, …); those blocks are destroyed.',
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
          revision: { type: 'number' },
          images_uploaded: { type: 'number', required: true },
          images_skipped: { type: 'number', required: true },
          shared: { type: 'boolean', required: true },
          content_chars: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.mode === 'create' ? 'Created' : value.mode === 'append' ? 'Appended to' : 'Replaced the body of'} `
          + `the Feishu document${value.title === undefined ? '' : ` "${value.title}"`} (document_id: ${value.document_id})`
          + `${value.url === undefined ? '' : ` ${value.url}`}. `
          + `Wrote ${value.blocks} block(s) from ${value.content_chars} characters; `
          + `${value.images_uploaded} image(s) embedded`
          + `${value.images_skipped === 0 ? '' : `, ${value.images_skipped} skipped`}.`
          + (value.shared
            ? ' The document was shared with the requesting user.'
            : ' It was not shared — the requesting user may not be able to open it.'),
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const channel = requireChannel(deps)
      const mode = args.mode
      if (mode !== 'create' && args.revision === undefined) {
        throw new Error(
          `mode "${mode}" needs the \`revision_id\` from feishu_doc_read: without it the write could `
          + 'overwrite edits made after the copy was read. Read the document first, then pass its '
          + 'revision_id. (`create` is the only mode that does not edit an existing document.)',
        )
      }

      if ((args.markdown === undefined) === (args.path === undefined)) {
        throw new Error('pass exactly one of `path` (a Markdown file) or `markdown` (inline text).')
      }
      let markdown: string
      let baseDir: string | undefined
      if (args.path !== undefined) {
        try {
          markdown = await readFile(args.path, 'utf8')
        } catch (error: unknown) {
          throw new Error(`Cannot read the Markdown file ${JSON.stringify(args.path)}: ${errorText(error, 'unknown file error')}`)
        }
        baseDir = dirname(args.path)
      } else {
        markdown = args.markdown as string
      }
      if (markdown.trim() === '') throw new Error('the Markdown body is empty — nothing to write.')
      let documentId: string
      let url: string | undefined
      let title: string | undefined

      if (mode === 'create') {
        const heading = /^#\s+(.+)$/mu.exec(markdown)?.[1]?.trim()
        const fileTitle = args.path === undefined ? undefined : basename(args.path).replace(/\.md$/iu, '')
        title = args.title === undefined || args.title.trim() === ''
          ? (heading ?? fileTitle ?? '未命名文档')
          : args.title.trim()
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

      if (mode === 'replace' && args.allow_format_loss !== true) {
        const lossy = await lossyBlockTypes(channel, documentId)
        if (lossy.length > 0) {
          throw new Error(
            `This document contains blocks Markdown cannot reproduce (${lossy.join(', ')}), so `
            + '`replace` would destroy them. Use `feishu_doc_blocks` to edit the affected blocks, '
            + '`append` to add content, or pass `allow_format_loss: true` to accept the loss.',
          )
        }
      }

      // Decide per image reference whether it can be uploaded. The converter
      // emits one image block per reference in the same order, so the flags
      // line up with the blocks `prepareBlocks` is about to see.
      const refs = imageRefsIn(markdown, baseDir)
      const loaded: LoadedImage[] = []
      const keep: boolean[] = []
      for (const ref of refs) {
        if (ref.local === undefined) {
          keep.push(false)
          logger.warn(`dsh-feishu: feishu_doc_write skips image ${ref.target} (${ref.skipReason ?? 'unsupported'})`)
          continue
        }
        const image = await loadImage(ref.local)
        if ('skipReason' in image) {
          keep.push(false)
          logger.warn(`dsh-feishu: feishu_doc_write skips image ${ref.local} (${image.skipReason})`)
          continue
        }
        keep.push(true)
        loaded.push(image)
      }

      // Optimistic concurrency: the edit APIs accept a revision but do NOT
      // reject a stale one (verified 2026-11-04), so the guard has to be a
      // check-before-write here. The remaining race window is milliseconds.
      if (args.revision !== undefined) {
        const current = await documentRevision(channel, documentId)
        if (current !== undefined && current !== args.revision) {
          throw new Error(
            `The document changed since it was read (expected revision ${args.revision}, it is now ${current}). `
            + 'Read it again with feishu_doc_read and merge the newer edits before writing — '
            + 'writing now would overwrite them.',
          )
        }
      }

      const converted = await convertMarkdown(channel, markdown)
      const prepared = prepareBlocks(converted.blocks, converted.firstLevel, index => keep[index] === true)
      if (prepared.firstLevel.length === 0) {
        throw new Error('The Markdown produced no insertable blocks — add some text content.')
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

      // Image blocks are only placeholders until `fillDocumentImages` attaches
      // the uploaded material, so this runs after the blocks exist.
      const filled = await fillDocumentImages(channel, documentId, loaded)

      // A tenant-token document is owned by the bot; grant the asking user
      // access so the link they get is actually openable.
      let shared = false
      if (mode === 'create') {
        const bridge = deps.bridgeHolder?.current
        const agent = exec.agent
        if (bridge !== undefined && agent !== undefined) {
          const chat = bridge.resolveChat(agent.id)
          const openId = chat === undefined ? undefined : bridge.lastSenderFor(chat.chatId)
          if (openId !== undefined) shared = await shareDocument(channel, documentId, openId)
        }
      }

      if (title === undefined) title = await documentTitle(channel, documentId)
      if (url === undefined) url = await documentUrl(channel, documentId)
      const revision = await documentRevision(channel, documentId)
      logger.warn(
        `dsh-feishu: feishu_doc_write ${mode} ${prepared.blocks.length} block(s) into ${documentId}`
        + ` (${filled.uploaded}/${loaded.length} image(s) embedded, shared=${shared})`,
      )
      return {
        mode,
        document_id: documentId,
        ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }),
        blocks: prepared.blocks.length,
        ...(revision === undefined ? {} : { revision }),
        images_uploaded: filled.uploaded,
        images_skipped: refs.length - filled.uploaded,
        shared,
        content_chars: markdown.length,
      }
    },
  }))

  return () => {
    readTool()
    writeTool()
  }
}
