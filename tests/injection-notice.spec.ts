import { describe, expect, it } from 'vitest'
import { injectionNotice } from '../src/injection-notice.ts'
import { translationsFor } from '../src/i18n.ts'

const zh = translationsFor('zh')
const en = translationsFor('en')

/**
 * The payloads below are REAL `data.source` objects copied out of this machine's
 * session logs (2026-09-29) rather than shapes invented from the type
 * declarations: a notice that only works for a guessed shape is worse than no
 * notice, because it renders a confident wrong line.
 */
describe('injectionNotice', () => {
  // 2026-11-25: the wording now follows the WebUI's own row (`contextProducer`):
  // title = 上下文注入 / 跨会话召回, label = paths / labels / skill name / kind.
  it('names the instruction files, without an action suffix (the WebUI does not add one)', () => {
    expect(injectionNotice({
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: '{"projectRoot":""}',
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: 'abc' }],
    }, zh)).toBe('📥 上下文注入 · AGENTS.md')

    expect(injectionNotice({
      kind: 'agent-instructions',
      form: 'instructions',
      changes: [{ action: 'replace', path: 'AGENTS.md' }, { action: 'replace', path: 'docs/AGENTS.md' }],
    }, zh)).toBe('📥 上下文注入 · AGENTS.md、docs/AGENTS.md')

    expect(injectionNotice({ kind: 'agent-instructions', changes: [{ action: 'remove', path: 'OLD.md' }] }, zh))
      .toBe('📥 上下文注入 · OLD.md')
  })

  it('does not repeat a path that appears twice', () => {
    expect(injectionNotice({
      kind: 'agent-instructions', changes: [{ action: 'set', path: 'A.md' }, { action: 'set', path: 'A.md' }],
    }, zh)).toBe('📥 上下文注入 · A.md')
  })

  it('falls back to the kind when an instruction payload has no paths', () => {
    expect(injectionNotice({ kind: 'agent-instructions' }, zh)).toBe('📥 上下文注入 · agent-instructions')
  })

  it('names a skill catalog by its durable kind, like the WebUI does', () => {
    expect(injectionNotice({
      kind: 'skill-catalog',
      form: 'catalog',
      entries: [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }],
    }, zh)).toBe('📥 上下文注入 · skill-catalog')
    expect(injectionNotice({ kind: 'skill-catalog', form: 'catalog', entries: [] }, en))
      .toBe('📥 Context injection · skill-catalog')
    // A catalog is a `catalog` form, not a `notice` one: no summary is appended.
    expect(injectionNotice({ kind: 'skill-catalog', form: 'catalog', summary: 'x' }, zh))
      .toBe('📥 上下文注入 · skill-catalog')
  })

  it('names a plugin re-injection by its kind, like the WebUI does', () => {
    // The most common re-injection after a compaction (measured: 1098
    // occurrences). The WebUI's label for this producer is the durable kind.
    expect(injectionNotice({
      kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot',
      compactionId: 'c1', sourceCommandId: 'cmd-1', sections: [{ name: 'x', text: 'y' }],
    }, zh)).toBe('📥 上下文注入 · plugin')
  })

  it('uses the recall title for a session reference and the inject title for the rest', () => {
    expect(injectionNotice({
      kind: 'session-reference', references: [{ label: 'audit session' }, { label: 'audit session' }],
    }, zh)).toBe('🔗 跨会话召回 · audit session')
    // The WebUI labels these producers by their durable kind; a relay/notice
    // summary is appended only for the `notice` form.
    expect(injectionNotice({ kind: 'agent-message', form: 'relay', senderSessionId: 'sub-1' }, zh))
      .toBe('📥 上下文注入 · agent-message')
    expect(injectionNotice({
      kind: 'subagent-settled', form: 'notice',
      summary: 'Background subagent sub-1 finished and will do no further work.', senderSessionId: 'sub-1',
    }, zh)).toBe('📥 上下文注入 · subagent-settled · Background subagent sub-1 finished and will do no further work.')
  })

  it('names a goal injection by its kind and never quotes the goal', () => {
    expect(injectionNotice({ kind: 'goal', goalId: 'goal-1', revision: 1, round: 3, objective: 'secret' }, zh))
      .toBe('📥 上下文注入 · goal')
  })

  it('appends a `notice` producer’s one-line summary after its label, clipped', () => {
    // The WebUI shows the label AND this summary without expanding the row, so
    // it is metadata rather than content.
    expect(injectionNotice({
      kind: 'model-selection', form: 'notice', summary: 'provider-a/m1 → provider-b/m2',
    }, zh)).toBe('📥 上下文注入 · model-selection · provider-a/m1 → provider-b/m2')

    const long = 'z'.repeat(400)
    const line = injectionNotice({ kind: 'plan-mode', form: 'notice', summary: long }, zh) ?? ''
    expect(line).toHaveLength('📥 上下文注入 · plan-mode · '.length + 101)
    expect(line.endsWith('…')).toBe(true)
  })

  it('never announces the human message, the compaction checkpoint or tool jobs', () => {
    expect(injectionNotice({ kind: 'user' }, zh)).toBeUndefined()
    expect(injectionNotice({ kind: 'compact-checkpoint', compactionId: 'c1' }, zh)).toBeUndefined()
    expect(injectionNotice({ kind: 'tool-jobs', form: 'notice', summary: 'bash …' }, zh)).toBeUndefined()
  })

  it('names an unknown kind and never dumps its fields', () => {
    expect(injectionNotice({ kind: 'brand-new-producer', secretField: 'leak me' }, zh))
      .toBe('📥 上下文注入 · brand-new-producer')
    expect(injectionNotice(undefined, zh)).toBeUndefined()
    expect(injectionNotice('a string', zh)).toBeUndefined()
    expect(injectionNotice({}, zh)).toBeUndefined()
    expect(injectionNotice({ kind: 42 }, zh)).toBeUndefined()
  })

  it('localizes the whole line', () => {
    expect(injectionNotice({ kind: 'runtime-context', form: 'snapshot' }, en))
      .toBe('📥 Context injection · runtime-context')
    expect(injectionNotice({ kind: 'user-approval' }, en)).toBe('📥 Context injection · user-approval')
    expect(injectionNotice({ kind: 'session-reference', references: [{ label: 'audit' }] }, en))
      .toBe('🔗 Session recall · audit')
  })
})
