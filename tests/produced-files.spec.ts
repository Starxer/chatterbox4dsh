import { describe, expect, it } from 'vitest'
import { mergeProducedArtifacts, mutationPathOf, pendingProducedCall, producedArtifacts, settleProducedCall, type ProducedPath } from '../src/produced-files.ts'

/**
 * The produced-file derivation must agree with the WebUI's
 * (`ui-deliverables/src/client/turn-deliverables.ts`): same tools, same
 * argument rules, and only successful results count. These cases pin the rules
 * that were copied from it.
 */
describe('mutationPathOf', () => {
  it('accepts a write that carries string content', () => {
    expect(mutationPathOf('write', JSON.stringify({ file_path: 'out/report.md', content: 'hi' }))).toBe('out/report.md')
  })

  it('rejects a write without content', () => {
    expect(mutationPathOf('write', JSON.stringify({ file_path: 'out/report.md' }))).toBeUndefined()
  })

  it('accepts an edit whose replacement actually changes something', () => {
    expect(mutationPathOf('edit', JSON.stringify({ file_path: 'a.ts', old_string: 'a', new_string: 'b' }))).toBe('a.ts')
  })

  it('rejects an edit whose old and new strings are identical', () => {
    expect(mutationPathOf('edit', JSON.stringify({ file_path: 'a.ts', old_string: 'a', new_string: 'a' }))).toBeUndefined()
  })

  it('rejects an edit with an empty old_string', () => {
    expect(mutationPathOf('edit', JSON.stringify({ file_path: 'a.ts', old_string: '', new_string: 'b' }))).toBeUndefined()
  })

  it('accepts the three mutating str_replace_editor commands', () => {
    expect(mutationPathOf('str_replace_editor', JSON.stringify({ command: 'create', path: 'n.txt', file_text: 'x' }))).toBe('n.txt')
    expect(mutationPathOf('str_replace_editor', JSON.stringify({ command: 'str_replace', path: 'n.txt', old_str: 'x', new_str: 'y' }))).toBe('n.txt')
    expect(mutationPathOf('str_replace_editor', JSON.stringify({ command: 'insert', path: 'n.txt', insert_line: 0, new_str: 'z' }))).toBe('n.txt')
  })

  it('rejects non-mutating str_replace_editor commands', () => {
    expect(mutationPathOf('str_replace_editor', JSON.stringify({ command: 'view', path: 'n.txt' }))).toBeUndefined()
    expect(mutationPathOf('str_replace_editor', JSON.stringify({ command: 'create', path: 'n.txt' }))).toBeUndefined()
  })

  it('ignores tools that do not write files, and malformed arguments', () => {
    expect(mutationPathOf('bash', JSON.stringify({ command: 'echo hi > x' }))).toBeUndefined()
    expect(mutationPathOf('read', JSON.stringify({ file_path: 'a.ts' }))).toBeUndefined()
    expect(mutationPathOf('write', '{not json')).toBeUndefined()
    expect(mutationPathOf('write', undefined)).toBeUndefined()
  })

  it('rejects a blank path', () => {
    expect(mutationPathOf('write', JSON.stringify({ file_path: '   ', content: 'x' }))).toBeUndefined()
  })
})

describe('settleProducedCall', () => {
  it('produces the file only when the call mutated one and did not fail', () => {
    const pending = pendingProducedCall('write', JSON.stringify({ file_path: 'shots/grid.png', content: 'x' }))
    expect(settleProducedCall(pending, false)).toEqual({ path: 'shots/grid.png', kind: 'image' })
    expect(settleProducedCall(pending, true)).toBeUndefined()
  })

  it('produces nothing for a call that never mutated a file', () => {
    expect(settleProducedCall(pendingProducedCall('bash', '{"command":"ls"}'), false)).toBeUndefined()
  })

  it('classifies by extension, the same classifier the delivery planner uses', () => {
    const of = (path: string): string | undefined =>
      settleProducedCall(pendingProducedCall('write', JSON.stringify({ file_path: path, content: 'x' })), false)?.kind
    expect(of('clip.mp4')).toBe('video')
    expect(of('voice.opus')).toBe('audio')
    expect(of('deck.pptx')).toBe('document')
    expect(of('src/index.ts')).toBe('other')
  })
})

/**
 * The artifact filter is the whole reason the produced list can be mirrored into
 * a chat at all: without it, a coding turn would list the source files it just
 * edited (`/tmp` scripts included) instead of the things worth handing over.
 */
describe('producedArtifacts', () => {
  const produced: ProducedPath[] = [
    { path: 'src/index.ts', kind: 'other' },
    { path: 'shots/a.png', kind: 'image' },
    { path: 'out/report.pdf', kind: 'document' },
    { path: 'tmp/probe.py', kind: 'other' },
    { path: 'clip.mp4', kind: 'video' },
  ]

  it('keeps media and documents, drops everything else, preserving order', () => {
    expect(producedArtifacts(produced).map(file => file.path)).toEqual(['shots/a.png', 'out/report.pdf', 'clip.mp4'])
  })

  it('returns an empty list for a turn that produced only code', () => {
    expect(producedArtifacts([{ path: 'src/a.ts', kind: 'other' }])).toEqual([])
  })
})

/**
 * Merging into the presented list is what gives produced artifacts the exact
 * treatment presented ones already get. Dedup must compare RESOLVED paths: the
 * model writes `out.png` in one turn and `/abs/ws/out.png` in another.
 */
describe('mergeProducedArtifacts', () => {
  it('appends artifacts after the presented files', () => {
    const merged = mergeProducedArtifacts(
      [{ path: 'declared.md', description: 'the note' }],
      [{ path: 'shots/a.png', kind: 'image' }],
      '/ws',
    )
    expect(merged).toEqual([{ path: 'declared.md', description: 'the note' }, { path: 'shots/a.png' }])
  })

  it('drops an artifact the same turn already presented, in either spelling', () => {
    const merged = mergeProducedArtifacts(
      [{ path: '/ws/shots/a.png' }],
      [
        { path: 'shots/a.png', kind: 'image' },
        { path: '/ws/out/report.pdf', kind: 'document' },
      ],
      '/ws',
    )
    expect(merged.map(file => file.path)).toEqual(['/ws/shots/a.png', '/ws/out/report.pdf'])
  })

  it('does not touch the presented list when nothing was produced', () => {
    const presented = [{ path: 'a.md' }]
    expect(mergeProducedArtifacts(presented, [], '/ws')).toBe(presented)
  })

  it('without a workspace only the identical spelling is deduplicated', () => {
    const merged = mergeProducedArtifacts(
      [{ path: 'shots/a.png' }],
      [
        { path: 'shots/a.png', kind: 'image' },
        { path: 'shots/b.png', kind: 'image' },
      ],
      undefined,
    )
    expect(merged.map(file => file.path)).toEqual(['shots/a.png', 'shots/b.png'])
  })
})
