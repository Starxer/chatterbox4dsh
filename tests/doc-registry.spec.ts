import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDocRegistry, DOC_REGISTRY_FILE, MAX_REGISTRY_ENTRIES } from '../src/doc-registry.ts'

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-doc-reg-'))
}

function entry(documentId: string, updatedAt = Date.now()) {
  return { documentId, updatedAt }
}

describe('createDocRegistry', () => {
  it('starts empty when no file exists and persists records atomically', async () => {
    const home = await tempHome()
    const registry = await createDocRegistry({ home })
    expect(registry.get('/tmp/a.md')).toBeUndefined()

    await registry.record('/tmp/a.md', entry('doxcnA'))
    const reopened = await createDocRegistry({ home })
    expect(reopened.get('/tmp/a.md')).toMatchObject({ documentId: 'doxcnA' })
    // No temporary file is left behind.
    await expect(readFile(join(home, `${DOC_REGISTRY_FILE}.tmp`), 'utf8')).rejects.toThrow()
  })

  it('keys entries by the resolved absolute path', async () => {
    const home = await tempHome()
    const registry = await createDocRegistry({ home })
    await registry.record('relative/dir/note.md', entry('doxcnR'))
    expect(registry.get(resolve('relative/dir/note.md'))).toMatchObject({ documentId: 'doxcnR' })
  })

  it('forgets one entry without touching the others', async () => {
    const home = await tempHome()
    const registry = await createDocRegistry({ home })
    await registry.record('/tmp/a.md', entry('doxcnA'))
    await registry.record('/tmp/b.md', entry('doxcnB'))
    await registry.forget('/tmp/a.md')
    const reopened = await createDocRegistry({ home })
    expect(reopened.get('/tmp/a.md')).toBeUndefined()
    expect(reopened.get('/tmp/b.md')).toMatchObject({ documentId: 'doxcnB' })
  })

  it('survives a corrupt file and keeps the warning to one line', async () => {
    const home = await tempHome()
    await writeFile(join(home, DOC_REGISTRY_FILE), '{not json', 'utf8')
    const warn = vi.fn()
    const registry = await createDocRegistry({ home, logger: { warn } })
    expect(registry.list()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    // Recording still works after the bad load.
    await registry.record('/tmp/a.md', entry('doxcnA'))
    expect((await createDocRegistry({ home })).get('/tmp/a.md')).toMatchObject({ documentId: 'doxcnA' })
  })

  it('drops entries that do not look like documents', async () => {
    const home = await tempHome()
    await writeFile(join(home, DOC_REGISTRY_FILE), JSON.stringify({
      version: 1,
      docs: {
        '/tmp/good.md': { documentId: 'doxcnG', revision: 3, updatedAt: 2 },
        '/tmp/bad.md': { documentId: 42 },
        '/tmp/none.md': null,
      },
    }), 'utf8')
    const registry = await createDocRegistry({ home })
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ path: '/tmp/good.md', doc: { documentId: 'doxcnG', revision: 3 } })
  })

  it('caps the file at MAX_REGISTRY_ENTRIES, keeping the newest', async () => {
    const home = await tempHome()
    const registry = await createDocRegistry({ home })
    for (let index = 0; index < MAX_REGISTRY_ENTRIES + 5; index += 1) {
      await registry.record(`/tmp/${index}.md`, entry(`doxcn${index}`, index))
    }
    const kept = registry.list()
    expect(kept).toHaveLength(MAX_REGISTRY_ENTRIES)
    // The newest five pushed the oldest five out.
    expect(kept[0]?.path).toBe(`/tmp/${MAX_REGISTRY_ENTRIES + 4}.md`)
    expect(kept.some(item => item.path === '/tmp/0.md')).toBe(false)
    expect(kept.some(item => item.path === '/tmp/5.md')).toBe(true)
    const reopened = await createDocRegistry({ home })
    expect(reopened.list()).toHaveLength(MAX_REGISTRY_ENTRIES)
  })
})
