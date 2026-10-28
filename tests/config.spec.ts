import { describe, expect, it } from 'vitest'
import {
  CARD_MEDIA_LIMIT, CARD_MEDIA_MAX_MB, DELIVER_DOC_MAX_MB, LARK_APP_SECRET_REF, clampCardMediaLimit, clampCardMediaMaxMb,
  clampDeliverDocMaxMb, connectionFingerprint, resolveRuntimeConfig, resolveSettingsConfig,
} from '../src/config.ts'
import type { ConfigInput } from '../src/config.ts'

describe('resolveSettingsConfig', () => {
  it('allows an installed plugin to remain unconfigured', () => {
    expect(resolveSettingsConfig({})).toMatchObject({
      appId: '', appSecretRef: LARK_APP_SECRET_REF, domain: 'feishu', requireMention: true, dmMode: 'open',
    })
  })

  it('applies safe conversational defaults', () => {
    expect(resolveSettingsConfig({ appId: 'id' })).toMatchObject({
      domain: 'feishu', requireMention: true, dmMode: 'open',
      errorMessage: '抱歉，处理这条消息时遇到了问题，请稍后重试。',
      reactEmoji: 'THUMBSUP',
    })
    expect(resolveSettingsConfig({ appId: 'id' })).not.toHaveProperty('workspace')
  })

  it('defaults the work-detail level to `detailed` and reads legacy values', () => {
    expect(resolveSettingsConfig({ appId: 'id' }).transcriptView).toBe('detailed')
    expect(resolveSettingsConfig({ appId: 'id', transcriptView: 'compact' }).transcriptView).toBe('compact')
    expect(resolveSettingsConfig({ appId: 'id', transcriptView: 'verbose' }).transcriptView).toBe('verbose')
    // 0.2.0 reads the two WebUI legacy spellings as `detailed` (a hand-edited
    // settings.yaml can still hold one) and anything unreadable as the default.
    expect(resolveSettingsConfig({ appId: 'id', transcriptView: 'normal' as any }).transcriptView).toBe('detailed')
    expect(resolveSettingsConfig({ appId: 'id', transcriptView: 'expanded' as any }).transcriptView).toBe('detailed')
    expect(resolveSettingsConfig({ appId: 'id', transcriptView: 'nope' as any }).transcriptView).toBe('detailed')
  })

  it('defaults elapsed refresh to five seconds and validates the four supported intervals', () => {
    expect(resolveSettingsConfig({}).elapsedRefreshSeconds).toBe(5)
    for (const seconds of [3, 5, 10, 30]) {
      expect(resolveSettingsConfig({ elapsedRefreshSeconds: seconds }).elapsedRefreshSeconds).toBe(seconds)
    }
    for (const value of [0, -1, 4, Infinity, NaN, '3', null]) {
      expect(resolveSettingsConfig({ elapsedRefreshSeconds: value as any }).elapsedRefreshSeconds).toBe(5)
    }
  })

  it('defaults and clamps the three preview caps', () => {
    const defaults = resolveSettingsConfig({ appId: 'id' })
    expect(defaults.reasoningPreviewChars).toBe(200)
    expect(defaults.resultPreviewChars).toBe(1500)
    expect(defaults.argsPreviewChars).toBe(2000)
    // Out-of-range values are clamped the way the Host schema would, and an
    // unreadable value falls back to the default rather than to the minimum.
    expect(resolveSettingsConfig({ appId: 'id', reasoningPreviewChars: 10 }).reasoningPreviewChars).toBe(80)
    expect(resolveSettingsConfig({ appId: 'id', reasoningPreviewChars: 99999 }).reasoningPreviewChars).toBe(4000)
    expect(resolveSettingsConfig({ appId: 'id', resultPreviewChars: 99999 }).resultPreviewChars).toBe(6000)
    expect(resolveSettingsConfig({ appId: 'id', argsPreviewChars: Number.NaN }).argsPreviewChars).toBe(2000)
    expect(resolveSettingsConfig({ appId: 'id', argsPreviewChars: 640 }).argsPreviewChars).toBe(640)
  })

  it('defaults the card image mode to workspace-only uploads', () => {
    expect(resolveSettingsConfig({ appId: 'id' }).cardImages).toBe('workspace')
    expect(resolveSettingsConfig({ appId: 'id', cardImages: 'text' }).cardImages).toBe('text')
    expect(resolveSettingsConfig({ appId: 'id', cardImages: 'any' }).cardImages).toBe('any')
  })

  it('defaults produced-file handling to delivery and reads the other two modes', () => {
    // TODO O3: the default delivers the artifact-shaped subset, because the gap
    // it closes is measured (21 turns wrote files, one called present).
    expect(resolveSettingsConfig({ appId: 'id' }).produceCard).toBe('delivery')
    expect(resolveSettingsConfig({ appId: 'id', produceCard: 'summary' }).produceCard).toBe('summary')
    expect(resolveSettingsConfig({ appId: 'id', produceCard: 'off' }).produceCard).toBe('off')
    // A hand-edited settings.yaml, or a value from a future release, must not
    // change behaviour silently: unknown falls back to the default.
    expect(resolveSettingsConfig({ appId: 'id', produceCard: 'nope' as any }).produceCard).toBe('delivery')
  })

  it('defaults the per-card media limit and keeps whatever the user picked', () => {
    expect(resolveSettingsConfig({ appId: 'id' }).cardMediaLimit).toBe(CARD_MEDIA_LIMIT.default)
    expect(resolveSettingsConfig({ appId: 'id', cardMediaLimit: 3 }).cardMediaLimit).toBe(3)
  })

  it('clamps a media limit that never went through the schema', () => {
    // `ConfigInput` also admits a plain object (tests, older hosts), so a value
    // out of range must be clamped rather than handed to the hydrator.
    expect(clampCardMediaLimit(0)).toBe(CARD_MEDIA_LIMIT.min)
    expect(clampCardMediaLimit(999)).toBe(CARD_MEDIA_LIMIT.max)
    expect(clampCardMediaLimit(3.7)).toBe(3)
    expect(clampCardMediaLimit(Number.NaN)).toBe(CARD_MEDIA_LIMIT.default)
    expect(clampCardMediaLimit(undefined)).toBe(CARD_MEDIA_LIMIT.default)
    expect(resolveSettingsConfig({ appId: 'id', cardMediaLimit: 0 }).cardMediaLimit).toBe(CARD_MEDIA_LIMIT.min)
    expect(resolveSettingsConfig({ appId: 'id', cardMediaLimit: 1e9 }).cardMediaLimit).toBe(CARD_MEDIA_LIMIT.max)
  })

  it('defaults the three inline size limits, one per media kind', () => {
    const resolved = resolveSettingsConfig({ appId: 'id' })
    expect(resolved.cardImageMaxMb).toBe(CARD_MEDIA_MAX_MB.image.default)
    expect(resolved.cardVideoMaxMb).toBe(CARD_MEDIA_MAX_MB.video.default)
    expect(resolved.cardAudioMaxMb).toBe(CARD_MEDIA_MAX_MB.audio.default)
    // The image default is Feishu's own ceiling: a larger number could never be
    // reached, because `im.v1.image.create` refuses anything above 10 MB.
    expect(CARD_MEDIA_MAX_MB.image.default).toBe(CARD_MEDIA_MAX_MB.image.max)
    expect(resolveSettingsConfig({ appId: 'id', cardVideoMaxMb: 25 }).cardVideoMaxMb).toBe(25)
  })

  it('clamps each size limit into its own kind bounds', () => {
    // Feishu's upload ceilings, not taste: 10 MB for images, 30 MB for files.
    expect(clampCardMediaMaxMb('image', 999)).toBe(CARD_MEDIA_MAX_MB.image.max)
    expect(clampCardMediaMaxMb('video', 999)).toBe(CARD_MEDIA_MAX_MB.video.max)
    expect(clampCardMediaMaxMb('audio', 999)).toBe(CARD_MEDIA_MAX_MB.audio.max)
    expect(clampCardMediaMaxMb('image', 0)).toBe(CARD_MEDIA_MAX_MB.image.min)
    expect(clampCardMediaMaxMb('video', 12.9)).toBe(12)
    expect(clampCardMediaMaxMb('audio', Number.NaN)).toBe(CARD_MEDIA_MAX_MB.audio.default)
    expect(clampCardMediaMaxMb('audio', undefined)).toBe(CARD_MEDIA_MAX_MB.audio.default)
    expect(resolveSettingsConfig({ appId: 'id', cardImageMaxMb: 40 }).cardImageMaxMb).toBe(10)
    expect(resolveSettingsConfig({ appId: 'id', cardAudioMaxMb: 0 }).cardAudioMaxMb).toBe(1)
  })

  it('defaults the document auto-delivery limit to Feishu\'s 30 MB ceiling', () => {
    expect(resolveSettingsConfig({ appId: 'id' }).deliverDocMaxMb).toBe(DELIVER_DOC_MAX_MB.default)
    expect(DELIVER_DOC_MAX_MB.default).toBe(DELIVER_DOC_MAX_MB.max)
    expect(resolveSettingsConfig({ appId: 'id', deliverDocMaxMb: 5 }).deliverDocMaxMb).toBe(5)
    expect(resolveSettingsConfig({ appId: 'id', deliverDocMaxMb: 40 }).deliverDocMaxMb).toBe(DELIVER_DOC_MAX_MB.max)
    expect(resolveSettingsConfig({ appId: 'id', deliverDocMaxMb: 0 }).deliverDocMaxMb).toBe(DELIVER_DOC_MAX_MB.min)
  })

  it('clamps a document auto-delivery limit that never went through the schema', () => {
    expect(clampDeliverDocMaxMb(undefined)).toBe(DELIVER_DOC_MAX_MB.default)
    expect(clampDeliverDocMaxMb(Number.NaN)).toBe(DELIVER_DOC_MAX_MB.default)
    expect(clampDeliverDocMaxMb(12.9)).toBe(12)
    expect(clampDeliverDocMaxMb(1e9)).toBe(DELIVER_DOC_MAX_MB.max)
  })

  it('preserves an empty reaction override that disables the acknowledgement', () => {
    expect(resolveSettingsConfig({ appId: 'id', reactEmoji: '' }).reactEmoji).toBe('')
  })

  it('preserves Lark and access-policy configuration', () => {
    expect(resolveSettingsConfig({
      appId: 'id', domain: 'lark', requireMention: false,
      dmMode: 'allowlist', groupAllowlist: ['oc_a'], dmAllowlist: ['ou_a'],
      provider: 'deepseek-official', model: 'deepseek-v4-flash', workspace: '/work', agentPreset: 'coding',
    })).toMatchObject({ domain: 'lark', dmMode: 'allowlist', groupAllowlist: ['oc_a'], dmAllowlist: ['ou_a'], workspace: '/work', agentPreset: 'coding' })
  })

  it('requires a POSIX credential reference', () => {
    expect(() => resolveSettingsConfig({ appSecretRef: 'not-valid-ref' })).toThrow(/appSecretRef/)
  })

  it('rejects an unbounded error response', () => {
    expect(() => resolveSettingsConfig({ appId: 'id', errorMessage: 'x'.repeat(501) })).toThrow(/errorMessage/)
  })
})

describe('live config references (DSH 0.1.7)', () => {
  /** Stand-in for the loader's volatile reference: stable identity, committed value. */
  const live = <T>(value: T) => {
    let current = value
    return { get: (): T => current, commit: (next: T): void => { current = next } }
  }

  it('reads each field through its reference, so a committed write is visible immediately', () => {
    // 0.1.7 commits a settings write into the running reference instead of
    // remounting the plugin, so reading the raw field would freeze the value
    // the plugin started with.
    const appId = live('id')
    const config = { appId } as unknown as ConfigInput
    expect(resolveSettingsConfig(config).appId).toBe('id')
    appId.commit('other')
    expect(resolveSettingsConfig(config).appId).toBe('other')
  })

  it('reads elapsed refresh changes from the same live reference', () => {
    const elapsedRefreshSeconds = live(5)
    const config = { elapsedRefreshSeconds } as unknown as ConfigInput
    expect(resolveSettingsConfig(config).elapsedRefreshSeconds).toBe(5)
    elapsedRefreshSeconds.commit(3)
    expect(resolveSettingsConfig(config).elapsedRefreshSeconds).toBe(3)
  })

  it('copies array fields instead of handing out the read-only snapshot', () => {
    const groupAllowlist = live(['oc_a'] as readonly string[])
    expect(resolveSettingsConfig({ groupAllowlist } as unknown as ConfigInput).groupAllowlist).toEqual(['oc_a'])
  })
})

describe('resolveRuntimeConfig', () => {
  it('requires the application id and resolved secret only at activation', () => {
    const config = resolveSettingsConfig({})
    expect(() => resolveRuntimeConfig(config, 'secret')).toThrow(/appId/)
    expect(() => resolveRuntimeConfig({ ...config, appId: 'id' }, '')).toThrow(/appSecret/)
    expect(resolveRuntimeConfig({ ...config, appId: 'id' }, 'secret')).toMatchObject({ appId: 'id', appSecret: 'secret' })
  })
})

describe('connectionFingerprint', () => {
  const base = resolveRuntimeConfig({ ...resolveSettingsConfig({ appId: 'id' }), appSecret: 'secret' })

  it('ignores settings that do not describe the connection', () => {
    // A `/display`, `/lang`, or session-default write must not look like a
    // channel change — reconcile would then tear down every live agent session.
    const same = connectionFingerprint({
      ...base,
      showReasoning: false, showToolCalls: false, showToolArgs: false, showToolResults: false,
      transcriptView: 'verbose',
      elapsedRefreshSeconds: 30,
      locale: 'en',
      errorMessage: 'changed',
      workspace: '/other', agentPreset: 'other', provider: 'p', model: 'm',
    })
    expect(same).toBe(connectionFingerprint(base))
  })

  it('changes when anything the channel captures at construction changes', () => {
    const baseline = connectionFingerprint(base)
    expect(connectionFingerprint({ ...base, appId: 'other' })).not.toBe(baseline)
    expect(connectionFingerprint({ ...base, appSecret: 'other' })).not.toBe(baseline)
    expect(connectionFingerprint({ ...base, domain: 'lark' })).not.toBe(baseline)
    expect(connectionFingerprint({ ...base, requireMention: false })).not.toBe(baseline)
    expect(connectionFingerprint({ ...base, dmMode: 'disabled' })).not.toBe(baseline)
    expect(connectionFingerprint({ ...base, groupAllowlist: ['oc_a'] })).not.toBe(baseline)
    expect(connectionFingerprint({ ...base, dmAllowlist: ['ou_a'] })).not.toBe(baseline)
    expect(connectionFingerprint({ ...base, reactEmoji: '' })).not.toBe(baseline)
  })
})
