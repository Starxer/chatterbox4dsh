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
  it('names the instruction files and what happened to them', () => {
    expect(injectionNotice({
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: '{"projectRoot":""}',
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: 'abc' }],
    }, zh)).toBe('📥 上下文注入 · AGENTS.md（已载入）')

    expect(injectionNotice({
      kind: 'agent-instructions',
      form: 'instructions',
      changes: [{ action: 'replace', path: 'AGENTS.md' }, { action: 'replace', path: 'docs/AGENTS.md' }],
    }, zh)).toBe('📥 上下文注入 · AGENTS.md、docs/AGENTS.md（已更新）')

    expect(injectionNotice({ kind: 'agent-instructions', changes: [{ action: 'remove', path: 'OLD.md' }] }, zh))
      .toBe('📥 上下文注入 · OLD.md（已移除）')
  })

  it('does not repeat a path that appears twice', () => {
    expect(injectionNotice({
      kind: 'agent-instructions', changes: [{ action: 'set', path: 'A.md' }, { action: 'set', path: 'A.md' }],
    }, zh)).toBe('📥 上下文注入 · A.md（已新增）')
  })

  it('falls back to the bare prefix when an instruction payload has no paths', () => {
    expect(injectionNotice({ kind: 'agent-instructions' }, zh)).toBe('📥 上下文注入')
  })

  it('counts a skill catalog instead of listing it', () => {
    expect(injectionNotice({
      kind: 'skill-catalog',
      form: 'catalog',
      entries: [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }],
    }, zh)).toBe('📥 上下文注入 · 技能目录（2 条）')
    expect(injectionNotice({ kind: 'skill-catalog', form: 'catalog', entries: [] }, en))
      .toBe('📥 Context injection · skill catalog (0)')
  })

  it('names the plugin package of a re-injection', () => {
    // The most common re-injection after a compaction; the payload carries ONE
    // package name, not a list (measured: 1098 occurrences).
    expect(injectionNotice({
      kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot',
      compactionId: 'c1', sourceCommandId: 'cmd-1', sections: [{ name: 'x', text: 'y' }],
    }, zh)).toBe('📥 上下文注入 · 插件 @deepseek-ai/dsh-system-prompt')
  })

  it('attributes cross-session recall, inter-session messages and settled subagents', () => {
    expect(injectionNotice({
      kind: 'session-reference', references: [{ label: 'audit session' }, { label: 'audit session' }],
    }, zh)).toBe('🔗 跨会话召回 · audit session')
    expect(injectionNotice({ kind: 'agent-message', form: 'relay', senderSessionId: 'sub-1' }, zh))
      .toBe('✉️ 会话间消息 · 来自会话 sub-1')
    // The subagent's own summary is a sentence about its work, not an
    // attribution: the notice deliberately keeps only the id.
    expect(injectionNotice({
      kind: 'subagent-settled', form: 'notice',
      summary: 'Background subagent sub-1 finished and will do no further work.', senderSessionId: 'sub-1',
    }, zh)).toBe('🤖 子智能体已结算 · 来自会话 sub-1')
  })

  it('reports a goal round without quoting the goal', () => {
    expect(injectionNotice({ kind: 'goal', goalId: 'goal-1', revision: 1, round: 3 }, zh))
      .toBe('🎯 目标更新 · 第 3 轮')
  })

  it('uses a `notice` producer’s own one-line summary, clipped', () => {
    // `model-selection` / `plan-mode` ship exactly the line the WebUI shows
    // without expanding the row, so it is metadata rather than content.
    expect(injectionNotice({
      kind: 'model-selection', form: 'notice', summary: 'provider-a/m1 → provider-b/m2',
    }, zh)).toBe('📥 上下文注入 · provider-a/m1 → provider-b/m2')

    const long = 'z'.repeat(400)
    const line = injectionNotice({ kind: 'plan-mode', form: 'notice', summary: long }, zh) ?? ''
    expect(line).toHaveLength('📥 上下文注入 · '.length + 101)
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
      .toBe('📥 Context injection · runtime snapshot')
    expect(injectionNotice({ kind: 'user-approval' }, en)).toBe('📥 Context injection · approval result')
  })
})
