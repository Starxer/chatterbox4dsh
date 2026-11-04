/**
 * Durable "Markdown file → Feishu document" registry for the online-document
 * tools.
 *
 * The document tools are meant to be used as a publish channel: a Markdown file
 * stays the source of truth and re-running the publish should update the SAME
 * Feishu document instead of piling up copies. That needs a small durable map
 * from a file's absolute path to the document it was published to, plus the
 * revision our own last write produced — so a later publish can tell "nobody
 * touched it since" from "someone edited the document in Feishu".
 *
 * The map lives under the Harness home (never in the repository, never in a
 * session log) and is written atomically (tmp + rename). A missing or corrupt
 * file only means an empty registry: publishing then creates a document, which
 * is exactly the behaviour before this module existed. Nothing here is
 * load-bearing for reading or writing a document the caller names explicitly.
 *
 * @module @starxer/chatterbox4dsh/doc-registry
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** One document a Markdown file was published to. */
export interface PublishedDoc {
  documentId: string
  /** Revision recorded after this plugin's own last write (absent when the
   *  revision could not be read). */
  revision?: number
  title?: string
  url?: string
  /** Millisecond timestamp of the last successful publish. */
  updatedAt: number
}

/** The registry surface the doc tools consume. */
export interface DocRegistry {
  /** Look one file up; the key is resolved the same way `record` resolves it. */
  get(path: string): PublishedDoc | undefined
  /** Remember (or refresh) the document a file was published to. */
  record(path: string, doc: PublishedDoc): Promise<void>
  /** Drop one entry (a stale document id, for example). */
  forget(path: string): Promise<void>
  /** Resolved absolute paths currently known, newest first. */
  list(): Array<{ path: string; doc: PublishedDoc }>
}

/** File name under the Harness home. */
export const DOC_REGISTRY_FILE = 'lark-doc-registry.json'

/** Keep the file small: the least recently published entries fall off. */
export const MAX_REGISTRY_ENTRIES = 300

interface RegistryFile {
  version?: number
  docs?: Record<string, unknown>
}

/** Resolve how a path is keyed in the file (absolute, stable across cwd changes). */
export function registryKey(path: string): string {
  return resolve(path)
}

function isValidDoc(value: unknown): value is PublishedDoc {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.documentId !== 'string' || record.documentId === '') return false
  if (record.revision !== undefined && typeof record.revision !== 'number') return false
  if (record.title !== undefined && typeof record.title !== 'string') return false
  if (record.url !== undefined && typeof record.url !== 'string') return false
  return true
}

function sanitizeEntry(value: unknown): PublishedDoc | undefined {
  if (!isValidDoc(value)) return undefined
  const updatedAt = typeof (value as { updatedAt?: unknown }).updatedAt === 'number'
    ? (value as { updatedAt: number }).updatedAt
    : 0
  return {
    documentId: (value as PublishedDoc).documentId,
    updatedAt,
    ...(typeof (value as PublishedDoc).revision === 'number' ? { revision: (value as PublishedDoc).revision as number } : {}),
    ...(typeof (value as PublishedDoc).title === 'string' ? { title: (value as PublishedDoc).title as string } : {}),
    ...(typeof (value as PublishedDoc).url === 'string' ? { url: (value as PublishedDoc).url as string } : {}),
  }
}

/**
 * Open the registry stored under `home`.
 *
 * The load is best-effort: a missing file, unreadable file or malformed entry
 * only produces a warning and an empty/short map, never a failed tool call.
 */
export async function createDocRegistry(options: {
  home: string
  logger?: { warn(message: string): unknown }
}): Promise<DocRegistry> {
  const file = join(options.home, DOC_REGISTRY_FILE)
  const logger = options.logger
  const docs = new Map<string, PublishedDoc>()

  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as RegistryFile
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.docs === 'object' && parsed.docs !== null) {
      for (const [path, value] of Object.entries(parsed.docs)) {
        const entry = sanitizeEntry(value)
        if (entry === undefined) continue
        docs.set(registryKey(path), entry)
      }
    }
  } catch (error: unknown) {
    const code = (error as { code?: unknown })?.code
    if (code !== 'ENOENT') {
      logger?.warn(`dsh-feishu: document registry unreadable (${error instanceof Error ? error.message : String(error)}); starting empty`)
    }
  }

  const persist = async (): Promise<void> => {
    const sorted = [...docs.entries()]
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_REGISTRY_ENTRIES)
    docs.clear()
    for (const [path, entry] of sorted) docs.set(path, entry)
    const payload: RegistryFile = { version: 1, docs: Object.fromEntries(docs) }
    const tmp = `${file}.tmp`
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(tmp, `${JSON.stringify(payload)}\n`, 'utf8')
      await rename(tmp, file)
    } catch (error: unknown) {
      logger?.warn(`dsh-feishu: document registry write failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  return {
    get(path) {
      return docs.get(registryKey(path))
    },
    async record(path, doc) {
      docs.set(registryKey(path), { ...doc })
      await persist()
    },
    async forget(path) {
      if (!docs.delete(registryKey(path))) return
      await persist()
    },
    list() {
      return [...docs.entries()]
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .map(([path, doc]) => ({ path, doc }))
    },
  }
}
