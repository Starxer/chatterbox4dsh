import { describe, expect, it } from 'vitest'
import { renderStatusCard } from '../src/index.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')
const meta = {
  sessionId: 'lark-v2-90074f5e42e9606f0971be6a8f51157ee0ba7d70',
  workspace: '/workspace/project',
  agentPreset: 'standard',
  model: 'deepseek/chat',
  reasoningEffort: 'high',
  title: '测试会话',
  turns: 3,
  steps: 8,
  toolCalls: 5,
  inputTokens: 1000,
  outputTokens: 200,
  contextWindow: 200_000,
  lastInputTokens: 5_000,
}

const usage = {
  month: 350_911,
  today: 235_762,
  labels: [
    { label: 'update card instance', count: 348_740 },
    { label: 'send message', count: 81 },
  ],
}

/** Every markdown string on the card, at any depth. */
function markdownOf(card: any): string {
  const out: string[] = []
  const walk = (elements: any[] | undefined): void => {
    for (const el of elements ?? []) {
      if (typeof el?.content === 'string') out.push(el.content)
      if (Array.isArray(el?.elements)) walk(el.elements)
    }
  }
  walk(card.body?.elements)
  return out.join('\n')
}

describe('renderStatusCard', () => {
  it('shows the Feishu API counter: month vs quota, today, and the breakdown', () => {
    // Regression (2026-11-24): `/status` is answered by `executeSlashCommand`,
    // not by the command runtime, so it used to render WITHOUT the call counter —
    // the operator asked why the number I quoted was nowhere on the card.
    const md = markdownOf(renderStatusCard(meta, false, undefined, undefined, t, usage))
    expect(md).toContain(t.statusApiLine('350.9K', '235.8K', ' · update card instance 348740 · send message 81'))
    // No quota denominator: the counter only sees this plugin's calls while the
    // app's monthly quota is shared with other consumers (operator, 2026-11-24).
    expect(md).not.toContain('1M')
    expect(md).not.toMatch(/\(\d+%\)/)
    // The rest of the card is untouched.
    expect(md).toContain(t.statusContextLabel)
    expect(md).toContain(meta.model)
  })

  it('omits the counter when nothing has been counted yet', () => {
    const md = markdownOf(renderStatusCard(meta, false, undefined, undefined, t))
    expect(md).not.toContain('飞书 API')
  })
})
