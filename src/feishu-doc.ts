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

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import { withLinkTimeout } from './outbound-timeout.ts'
import { errorText } from './error-text.ts'
import { sniffImageMime } from './media-sniff.ts'
import type { HarnessConversationService } from './harness.ts'
import { createDocRegistry, type DocRegistry } from './doc-registry.ts'
import { applyFormulas, extractFormulas } from './doc-formula.ts'
import { resolveDshHome } from './dsh-home.ts'

/** Budget for one document API call (reads a whole body, so not the 20s send budget). */
const DOC_REQUEST_TIMEOUT_MS = 30_000
/** Blocks per insert request. Feishu's descendant create accepts around a
 *  thousand blocks; stay below that so one request never trips the cap. */
const MAX_INSERT_BLOCKS = 800
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
/** Budget for fetching one image that already has a signed URL. */
const IMAGE_SAVE_TIMEOUT_MS = 20_000
/** Most images one read will save; beyond this the URLs are still returned. */
const MAX_IMAGES_SAVED = 20
/**
 * `![alt](target "title")` — the target is what decides local vs remote.
 *
 * A target is either bare (`/a/b.png`) or wrapped in angle brackets
 * (`</a/my picture.png>`). The wrapped form is the only Markdown spelling that
 * allows spaces, and every Windows profile path has them, so both must parse.
 */
const IMAGE_REF_PATTERN = /!\[[^\]]*\]\(\s*(?:<([^<>\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gu

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
 * Whether a Markdown image target names an absolute local path.
 *
 * `isAbsolute` answers for the host it runs on, but the Markdown being
 * converted is not platform-bound: on Windows a `C:\shots\a.png` is absolute
 * (and `isAbsolute` already says so), while on Linux the same text used to be
 * mistaken for a relative path — so a Windows operator lost every inline image
 * reference. A drive path or a UNC share is absolute everywhere; whether the
 * file exists is decided later by the read itself.
 *
 * @param target - the destination of one Markdown image reference.
 */
export function isLocalAbsolutePath(target: string): boolean {
  if (isAbsolute(target)) return true
  if (/^[A-Za-z]:[\\/]/u.test(target)) return true
  return /^\\\\[^\\]/u.test(target)
}

/**
 * Find every image reference in the Markdown, in order.
 *
 * Only absolute local paths can be uploaded: remote URLs would mean fetching
 * arbitrary URLs from the host (and silently pulling outside content into the
 * tenant's documents), and a relative path has no unambiguous base because the
 * Markdown arrives as text, not as a file on disk. "Absolute" includes Windows
 * drive and UNC paths — see {@link isLocalAbsolutePath}.
 *
 * @param markdown - the body about to be converted.
 * @returns one entry per reference, including the ones that will be skipped.
 */
export function imageRefsIn(markdown: string, baseDir?: string): ImageRef[] {
  const refs: ImageRef[] = []
  for (const match of markdown.matchAll(IMAGE_REF_PATTERN)) {
    const target = match[1] ?? match[2]
    if (target === undefined || target === '') continue
    if (/^https?:\/\//iu.test(target) || /^data:/iu.test(target)) {
      refs.push({ target, skipReason: 'remote image, not fetched' })
      continue
    }
    if (isLocalAbsolutePath(target)) {
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
        withRateLimitRetry(() => channel.rawClient.drive.v1.media.uploadAll({
          data: {
            file_name: image.fileName,
            parent_type: 'docx_image',
            parent_node: blockId,
            size: image.bytes.byteLength,
            file: image.bytes,
          },
        })),
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
        withRateLimitRetry(() => channel.rawClient.docx.v1.documentBlock.patch({
          path: { document_id: documentId, block_id: blockId },
          data: { replace_image: { token } },
        })),
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

/** File extension for the image types Feishu documents carry. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** One image block as the read tool reports it. */
interface ReadImage {
  block_id: string
  token: string
  url?: string
  path?: string
}

/**
 * Download the images a document contains to local files.
 *
 * A temporary URL is useless to an agent that cannot fetch it: with a local
 * path the model can open the picture like any other workspace file. Files go
 * under the OS temp directory, one directory per document, and a failure only
 * leaves that image without a path.
 */
async function saveImageFiles(
  channel: LarkChannel,
  images: ReadImage[],
  documentId: string,
): Promise<{ images: ReadImage[]; failures: number; scopeMissing: boolean }> {
  const candidates = images.filter(image => image.token !== '').slice(0, MAX_IMAGES_SAVED)
  if (candidates.length === 0) return { images, failures: 0, scopeMissing: false }
  const dir = join(tmpdir(), 'dsh-feishu-doc-images', documentId)
  const saved = new Map<string, string>()
  let failures = 0
  let scopeMissing = false
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    return { images, failures: candidates.length, scopeMissing: false }
  }
  for (const [index, image] of candidates.entries()) {
    try {
      // Download through the SDK (authenticated, same token the read already
      // used) rather than the signed URL: the URL is only a display artifact.
      const raw: unknown = await withLinkTimeout(
        channel.rawClient.drive.v1.media.download({ path: { file_token: image.token } }),
        'download document image',
        IMAGE_SAVE_TIMEOUT_MS,
      )
      const bytes = await collectMediaBytes(raw)
      if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) continue
      const mime = sniffImageMime(bytes)
      if (mime === undefined) continue
      const path = join(dir, `${index + 1}-${image.token}.${IMAGE_EXTENSIONS[mime] ?? 'bin'}`)
      await writeFile(path, bytes)
      saved.set(image.block_id, path)
    } catch (error: unknown) {
      // One unreachable image must not fail the read, but the reason is worth
      // reporting: the usual cause is a missing permission, and silently
      // returning images without paths reads like the document has no pictures
      // (2026-11-11 report: "没有下载权限" was invisible from the tool result).
      failures += 1
      if (/99991672|scope|No permission|no permission/iu.test(errorText(error, ''))) scopeMissing = true
    }
  }
  return {
    images: images.map(image => {
      const path = saved.get(image.block_id)
      return path === undefined ? image : { ...image, path }
    }),
    failures,
    scopeMissing,
  }
}

/** Normalize the SDK's media download response to a Buffer. */
async function collectMediaBytes(raw: unknown): Promise<Buffer | undefined> {
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  const wrapper = raw as { getReadableStream?: () => unknown } | null
  if (wrapper !== null && typeof wrapper === 'object' && typeof wrapper.getReadableStream === 'function') {
    const stream = wrapper.getReadableStream()
    if (stream === null || typeof stream !== 'object' || !(Symbol.asyncIterator in (stream as object))) return undefined
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.byteLength
      if (total > MAX_IMAGE_BYTES) return undefined
      chunks.push(buffer)
    }
    return Buffer.concat(chunks)
  }
  return undefined
}

/** True when a Feishu call was rejected by its rate limiter. */
function isRateLimited(error: unknown): boolean {
  const record = error as { response?: { status?: unknown, data?: { code?: unknown } } }
  return record.response?.data?.code === 99991400 || record.response?.status === 429
}

/**
 * Retry a WRITE call that Feishu rejected because of its rate limit.
 *
 * The rejection happens before the edit is applied (the per-app limit answers
 * 99991400, the per-document one 429), so retrying is safe. Two retries at
 * 600ms/1500ms cover a burst of image uploads without waiting forever.
 */
async function withRateLimitRetry<T>(run: () => Promise<T>): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await run()
    } catch (error: unknown) {
      if (!isRateLimited(error) || attempt >= 2) throw error
      attempt += 1
      await new Promise(resolveDelay => setTimeout(resolveDelay, attempt === 1 ? 600 : 1_500))
    }
  }
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
      withRateLimitRetry(() => channel.rawClient.docx.v1.documentBlockChildren.batchDelete({
        path: { document_id: documentId, block_id: documentId },
        data: { start_index: 0, end_index: count },
      })),
      'clear document body',
      DOC_REQUEST_TIMEOUT_MS,
    )
  } catch (error: unknown) {
    throw docError('clear the body of', error)
  }
}

/** One `descendant.create` request: a set of top-level ids plus their subtree. */
export interface InsertBatch {
  firstLevel: string[]
  blocks: DocBlock[]
}

/**
 * Split a converted block tree into requests Feishu will accept.
 *
 * A long Markdown file can convert into well over the ~1000-block limit of one
 * `documentBlockDescendant.create`. Batching must therefore split by TOP-LEVEL
 * block: a subtree is never broken apart (its children reference their parent
 * id), and each batch carries exactly the descendants reachable from its own
 * top-level ids. A single subtree larger than the limit still goes out alone —
 * there is nothing finer to split.
 */
export function splitInsertBatches(
  firstLevel: string[],
  blocks: DocBlock[],
  limit: number = MAX_INSERT_BLOCKS,
): InsertBatch[] {
  const byId = new Map<string, DocBlock>()
  for (const block of blocks) {
    if (typeof block.block_id === 'string') byId.set(block.block_id, block)
  }
  const subtree = (id: string, into: Set<string>): number => {
    if (into.has(id)) return 0
    into.add(id)
    const block = byId.get(id)
    if (block?.children === undefined || block.children.length === 0) return 1
    let size = 1
    for (const child of block.children) size += subtree(child, into)
    return size
  }

  const batches: InsertBatch[] = []
  let ids: string[] = []
  let members = new Set<string>()
  let size = 0
  const flush = (): void => {
    if (ids.length === 0) return
    // Preserve the converter's block order inside each request.
    batches.push({
      firstLevel: ids,
      blocks: blocks.filter(block => typeof block.block_id === 'string' && members.has(block.block_id)),
    })
    ids = []
    members = new Set<string>()
    size = 0
  }
  for (const id of firstLevel) {
    const contained = new Set<string>()
    const count = subtree(id, contained)
    if (ids.length > 0 && size + count > limit) flush()
    ids.push(id)
    for (const member of contained) members.add(member)
    size += count
  }
  flush()
  return batches.length === 0 ? [{ firstLevel, blocks }] : batches
}

/** Insert a converted block tree at `index` under the document root. */
async function insertBlocks(
  channel: LarkChannel,
  documentId: string,
  firstLevel: string[],
  blocks: DocBlock[],
  index: number,
): Promise<void> {
  let offset = index
  for (const batch of splitInsertBatches(firstLevel, blocks)) {
    try {
      await withLinkTimeout(
        withRateLimitRetry(() => channel.rawClient.docx.v1.documentBlockDescendant.create({
          path: { document_id: documentId, block_id: documentId },
          data: { children_id: batch.firstLevel, index: offset, descendants: batch.blocks },
        })),
        'write document blocks',
        DOC_REQUEST_TIMEOUT_MS,
      )
    } catch (error: unknown) {
      throw docError('write', error)
    }
    offset += batch.firstLevel.length
  }
}

/**
 * Pick the document title and drop a body H1 that would duplicate it.
 *
 * The title is a document-level property, so a leading `# Heading` in the body
 * shows up as a second heading even when it repeats the title. Strip it when
 * the title comes FROM that heading, and also when an explicit title is the
 * same text — both cases would otherwise render the line twice. An explicit
 * title that differs from the H1 is kept: the caller asked for that section.
 */
export function deriveTitleAndBody(
  markdown: string,
  sourcePath: string | undefined,
  explicitTitle: string | undefined,
): { title: string, markdown: string } {
  const headingMatch = /^#\s+(.+)$/mu.exec(markdown)
  const heading = headingMatch?.[1]?.trim()
  const fileTitle = sourcePath === undefined ? undefined : basename(sourcePath).replace(/\.md$/iu, '')
  const wanted = explicitTitle === undefined ? '' : explicitTitle.trim()
  const titleFromBody = wanted === ''
  const title = titleFromBody ? (heading ?? fileTitle ?? '未命名文档') : wanted
  if (headingMatch !== null && (titleFromBody || heading === title)) {
    return { title, markdown: markdown.replace(/^#\s+.+\r?\n?/mu, '') }
  }
  return { title, markdown }
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
  // Opened on first publish/create so hosts that never use the doc tools never
  // touch the registry file.
  let registryPromise: Promise<DocRegistry> | undefined
  const docsRegistry = (): Promise<DocRegistry> => {
    registryPromise ??= createDocRegistry({ home: resolveDshHome(ctx), logger })
    return registryPromise
  }

  const readTool = ctx.tools.register(defineTool({
    name: 'feishu_doc_read',
    description:
      'Read a Feishu/Lark online document (docx) as Markdown. Pass the document URL — a `…/docx/<token>` '
      + 'or `…/wiki/<token>` link — or its token. Returns the title, the Markdown body and the document id '
      + 'needed by `feishu_doc_write`. Long bodies are truncated and give a `next_offset` to continue. '
      + 'When the app only has the plain-text scope the body comes back unformatted and `format` says `text`. '
      + 'Formulas in the document come back as `$…$` inside the Markdown body. Also returns the current '
      + '`revision_id` (pass it to `feishu_doc_write` to avoid overwriting newer edits) and the image blocks, '
      + 'which the Markdown body never includes. '
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
      download_images: {
        type: 'boolean',
        description: 'Save the document\'s images to local files and return their paths '
          + `(at most ${MAX_IMAGES_SAVED}; each ≤10 MB). Off by default.`,
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
                path: { type: 'string', description: 'Local file path when `download_images` was set.' },
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
        const imageCount = value.images === undefined || value.images.length === 0
          ? ''
          : ` · ${value.images.length} image block(s) not shown in the body`
        lines.push('', `[document_id: ${value.document_id}${title}${revision}${imageCount}${value.url === undefined ? '' : ` · ${value.url}`}]`)
        // The image URLs are only in the value; without printing them the model
        // cannot actually see the pictures the document contains.
        for (const image of value.images ?? []) {
          const target = image.path ?? image.url
          lines.push(target === undefined
            ? `[image ${image.block_id}${image.token === undefined || image.token === '' ? '' : ` · ${image.token}`}]`
            : `[image ${image.block_id}: ${target}]`)
        }
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
      const withUrls: ReadImage[] = imageBlocks.map(image => ({
        ...image,
        ...(urls.get(image.token) === undefined ? {} : { url: urls.get(image.token) as string }),
      }))
      const saved = args.download_images === true
        ? await saveImageFiles(channel, withUrls, resolved.documentId)
        : undefined
      const images = saved?.images ?? withUrls
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
        ...(saved === undefined || saved.failures === 0 ? {} : { images_download_failed: saved.failures }),
        ...(saved === undefined || saved.failures === 0 ? {} : {
          images_note: saved.scopeMissing
            ? '图片下载失败：应用缺少 drive:file:download（或 drive:drive:readonly）权限。扫码建的应用请按 docs/feishu-setup.md 补齐后重启；也可能是该文档没有给应用下载权限。'
            : '图片下载失败：应用对该文档没有下载权限，请把应用加为文档协作者并允许下载/导出。',
        }),
      }
    },
  }))

  const writeTool = ctx.tools.register(defineTool({
    name: 'feishu_doc_write',
    description:
      'Create or edit a Feishu/Lark online document (docx) from Markdown. Modes: `create` makes a new '
      + 'document from `title` + `markdown`; `publish` is create-or-replace for a Markdown FILE — the '
      + 'first run creates a document, later runs replace that same document, so rerunning a publish '
      + 'never piles up copies; `append` adds `markdown` at the end of the document given by `target`; '
      + '`replace` deletes the whole existing body and writes `markdown` instead. Markdown is converted '
      + 'to native document blocks (headings, lists, tables, code, checkboxes). LaTeX formulas are supported: '
      + '`$…$` / `\(…\)` become inline equations, and `$$…$$` / `\[…\]` on their own line become display '
      + 'equations (Feishu-native and editable); formulas inside code fences stay literal. Images are uploaded and '
      + 'embedded when the reference points at a local png/jpeg/webp/gif under 10 MB (relative image '
      + 'paths are resolved against `path` when the body comes from a file); remote URLs are never '
      + 'fetched — save the image locally first. The body comes from `path` (an ABSOLUTE path to a '
      + 'Markdown file — preferred for long documents and required by `publish`) or inline `markdown`. '
      + 'A body converted to more than ~800 blocks is inserted in several requests automatically. With '
      + '`create`/`publish`, a new document is shared with the user who asked for it. `append` and '
      + '`replace` REQUIRE the `revision_id` from `feishu_doc_read`, so a stale copy cannot silently '
      + 'overwrite newer edits; `replace` (and a publishing update) additionally refuses to run when '
      + 'the document contains blocks Markdown cannot reproduce (pass `allow_format_loss: true` to '
      + 'accept that). The Feishu app must be able to edit the target document. Prefer `append`, or '
      + '`publish` when a Markdown file is the source of truth.',
    parameters: {
      mode: {
        type: 'string',
        enum: ['create', 'append', 'replace', 'publish'],
        required: true,
        description: 'create a new document; publish a Markdown file (create on first run, update the '
          + 'same document on later runs; needs `path`); append to the end; or replace the whole body '
          + '(append/replace require `revision`).',
      },
      markdown: {
        type: 'string',
        description: 'Document body as Markdown (inline). Use `path` instead for long documents; pass exactly one of the two.',
      },
      path: {
        type: 'string',
        description: 'Absolute path of a Markdown file in the workspace to read the body from (relative '
          + 'paths are rejected — no workspace base is known here). Required for `publish`, which keys '
          + 'the document it updates by this path. Images referenced relatively are resolved against '
          + 'this file\'s directory.',
      },
      target: {
        type: 'string',
        description: 'Existing document URL or token. Required for `append` and `replace`; unused for `create`.',
      },
      title: {
        type: 'string',
        description: 'Title for a new document (`create`, or the first `publish`). Defaults to the '
          + 'body\'s first H1, else the file name, else 未命名文档. When the body opens with an H1 '
          + 'that duplicates this title, that H1 is dropped so the heading does not appear twice.',
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
        description: '`replace` (and a publishing update) only. Set true to overwrite a document that '
          + 'contains blocks Markdown cannot reproduce (callouts, grids, embeds, …); those blocks are destroyed.',
      },
      allow_foreign_edits: {
        type: 'boolean',
        description: '`publish` only. Set true to replace a published document that someone edited in '
          + 'Feishu since this plugin last wrote it (the default is to refuse and ask for a fresh '
          + '`revision` instead).',
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
          /** `publish`: true when this run created the document, false when it updated one. */
          created: { type: 'boolean' },
          images_uploaded: { type: 'number', required: true },
          images_skipped: { type: 'number', required: true },
          /** LaTeX formulas embedded as Feishu equation elements. */
          formulas: { type: 'number' },
          shared: { type: 'boolean', required: true },
          content_chars: { type: 'number', required: true },
        },
      },
      render: (_args, value) => {
        const action = value.mode === 'publish'
          ? (value.created === true
              ? 'Published the Markdown file as a new Feishu document'
              : 'Re-published the Markdown file into the same Feishu document')
          : `${value.mode === 'create' ? 'Created' : value.mode === 'append' ? 'Appended to' : 'Replaced the body of'} the Feishu document`
        return [{
          type: 'text',
          text: `${action}${value.title === undefined ? '' : ` "${value.title}"`} (document_id: ${value.document_id})`
            + `${value.url === undefined ? '' : ` ${value.url}`}. `
            + `Wrote ${value.blocks} block(s) from ${value.content_chars} characters; `
            + `${value.images_uploaded} image(s) embedded`
            + `${value.images_skipped === 0 ? '' : `, ${value.images_skipped} skipped`}`
            + `${value.formulas === undefined || value.formulas === 0 ? '' : `, ${value.formulas} formula(s) as equations`}.`
            + (value.shared
              ? ' The document was shared with the requesting user.'
              : ' It was not shared — the requesting user may not be able to open it.'),
        }]
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const channel = requireChannel(deps)
      const mode = args.mode
      // `publish` keeps its own concurrency guard (the registry remembers the
      // revision of this plugin's last write); a plain append/replace needs an
      // explicit `revision_id` from the caller.
      if ((mode === 'append' || mode === 'replace') && args.revision === undefined) {
        throw new Error(
          `mode "${mode}" needs the \`revision_id\` from feishu_doc_read: without it the write could `
          + 'overwrite edits made after the copy was read. Read the document first, then pass its '
          + 'revision_id. (`create` and `publish` do not edit a document the caller did not name.)',
        )
      }

      if ((args.markdown === undefined) === (args.path === undefined)) {
        throw new Error('pass exactly one of `path` (a Markdown file) or `markdown` (inline text).')
      }
      if (mode === 'publish' && args.path === undefined) {
        throw new Error('`publish` needs `path`: the Markdown file is the key its document is remembered by.')
      }
      let markdown: string
      let baseDir: string | undefined
      const sourcePath = args.path === undefined ? undefined : resolve(args.path)
      if (args.path !== undefined) {
        try {
          markdown = await readFile(args.path, 'utf8')
        } catch (error: unknown) {
          const relative = !isAbsolute(args.path)
          throw new Error(
            `Cannot read the Markdown file ${JSON.stringify(args.path)}: ${errorText(error, 'unknown file error')}.`
            + (relative
              ? ' That is a relative path and this tool does not resolve one (no workspace base is known here) — pass the absolute path.'
              : ''),
          )
        }
        baseDir = dirname(args.path)
      } else {
        markdown = args.markdown as string
      }
      if (markdown.trim() === '') throw new Error('the Markdown body is empty — nothing to write.')

      // Where this write lands. For `publish` the file's absolute path is the
      // key: the first run creates a document and records it, later runs
      // replace THAT document so rerunning a publish never piles up copies.
      const registry = sourcePath === undefined ? undefined : await docsRegistry()
      const registryEntry = sourcePath === undefined ? undefined : registry?.get(sourcePath)
      let effectiveMode: 'create' | 'append' | 'replace' =
        mode === 'append' || mode === 'replace' ? mode : 'create'
      let created = effectiveMode === 'create'
      let publishedTarget: { documentId: string, recordedRevision?: number } | undefined

      if (mode === 'publish') {
        const entry = registryEntry
        if (entry !== undefined) {
          const current = await documentRevision(channel, entry.documentId)
          if (current === undefined) {
            // The document is gone (deleted, or the app lost access). Drop the
            // stale entry and create a fresh document below.
            await registry?.forget(sourcePath as string)
            logger.warn(`dsh-feishu: feishu_doc_write publish dropped a stale registry entry for ${JSON.stringify(args.path)}`)
          } else {
            publishedTarget = {
              documentId: entry.documentId,
              ...(entry.revision === undefined ? {} : { recordedRevision: entry.revision }),
            }
          }
        }
        if (publishedTarget === undefined && args.target !== undefined && args.target.trim() !== '') {
          // First publish of an existing document: adopt it.
          const resolved = await resolveDoc(channel, parseDocTarget(args.target))
          publishedTarget = { documentId: resolved.documentId }
        }
        if (publishedTarget !== undefined) {
          effectiveMode = 'replace'
          created = false
          const current = await documentRevision(channel, publishedTarget.documentId)
          // A caller that just read the document can vouch for the newer
          // revision explicitly; otherwise the registry's record of our own
          // last write is the baseline.
          const lastKnown = args.revision ?? publishedTarget.recordedRevision
          const unchanged = current === undefined || lastKnown === undefined || lastKnown === current
          if (!unchanged && args.allow_foreign_edits !== true) {
            throw new Error(
              'The published document changed since this plugin last wrote it '
              + `(recorded revision ${String(lastKnown)}, it is now ${String(current)}) — someone edited it in Feishu. `
              + 'Read it with feishu_doc_read and pass that revision_id to accept the newer edits, '
              + 'or pass `allow_foreign_edits: true` to replace them anyway.',
            )
          }
        }
      }

      if (mode === 'create' && registryEntry !== undefined) {
        const current = await documentRevision(channel, registryEntry.documentId)
        if (current !== undefined) {
          throw new Error(
            `This Markdown file is already published as document ${registryEntry.documentId}`
            + `${registryEntry.url === undefined ? '' : ` (${registryEntry.url})`}. `
            + 'Use mode "publish" to update that same document; if a second copy is really wanted, '
            + 'pass the body inline via `markdown` or read from a differently named file.',
          )
        }
      }

      let documentId: string
      let url: string | undefined
      let title: string | undefined
      if (effectiveMode === 'create') {
        const derived = deriveTitleAndBody(markdown, args.path, args.title)
        title = derived.title
        markdown = derived.markdown
        documentId = await createDocument(channel, title, args.folder_token)
        url = await documentUrl(channel, documentId)
      } else if (publishedTarget !== undefined) {
        documentId = publishedTarget.documentId
        url = await documentUrl(channel, documentId)
        title = await documentTitle(channel, documentId)
      } else {
        if (args.target === undefined || args.target.trim() === '') {
          throw new Error(`target is required for mode "${mode}" — pass the document URL or token.`)
        }
        const resolved = await resolveDoc(channel, parseDocTarget(args.target))
        documentId = resolved.documentId
        url = resolved.url
        title = resolved.title
      }

      if (effectiveMode === 'replace' && args.allow_format_loss !== true) {
        const lossy = await lossyBlockTypes(channel, documentId)
        if (lossy.length > 0) {
          throw new Error(
            `This document contains blocks Markdown cannot reproduce (${lossy.join(', ')}), so `
            + '`replace` would destroy them. Use `feishu_doc_blocks` to edit the affected blocks, '
            + '`append` to add content, or pass `allow_format_loss: true` to accept the loss.',
          )
        }
      }

      // Feishu's Markdown→blocks converter does not understand formulas (it
      // drops `$…$`/`$$…$$` and eats `\[…\]`), while the docx API does support
      // them as inline equation elements. Swap formulas for placeholder tokens
      // first, then splice the real equations into the converted blocks below.
      const sourceChars = markdown.length
      const formulas = extractFormulas(markdown)
      markdown = formulas.markdown

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
      const spliced = applyFormulas(converted.blocks, formulas)
      if (spliced.unresolved.length > 0) {
        logger.warn(
          `dsh-feishu: feishu_doc_write left ${spliced.unresolved.length} formula placeholder(s) in the `
          + 'converted blocks — the formulas may appear as raw tokens',
        )
      }
      const prepared = prepareBlocks(spliced.blocks, converted.firstLevel, index => keep[index] === true)
      if (prepared.firstLevel.length === 0) {
        throw new Error('The Markdown produced no insertable blocks — add some text content.')
      }

      if (effectiveMode === 'create') {
        await insertBlocks(channel, documentId, prepared.firstLevel, prepared.blocks, 0)
      } else {
        const children = await bodyChildIds(channel, documentId)
        if (effectiveMode === 'replace') {
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
      if (created) {
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
      // Remember which document this file publishes to. `append`/`replace` do
      // not re-point the registry: the caller edited a document it named, and
      // silently binding the file to it would make a later publish replace that
      // whole document with just this file.
      if (registry !== undefined && sourcePath !== undefined && (mode === 'publish' || created)) {
        await registry.record(sourcePath, {
          documentId,
          updatedAt: Date.now(),
          ...(revision === undefined ? {} : { revision }),
          ...(title === undefined ? {} : { title }),
          ...(url === undefined ? {} : { url }),
        })
      }
      logger.warn(
        `dsh-feishu: feishu_doc_write ${mode} ${prepared.blocks.length} block(s) into ${documentId}`
        + ` (${filled.uploaded}/${loaded.length} image(s) embedded, shared=${shared})`,
      )
      return {
        mode,
        created,
        document_id: documentId,
        ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }),
        blocks: prepared.blocks.length,
        ...(revision === undefined ? {} : { revision }),
        images_uploaded: filled.uploaded,
        images_skipped: refs.length - filled.uploaded,
        shared,
        content_chars: sourceChars,
        formulas: spliced.applied,
      }
    },
  }))

  return () => {
    readTool()
    writeTool()
  }
}
