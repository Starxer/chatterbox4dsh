import { describe, expect, it } from 'vitest'
import {
  CARD_MEDIA_LIMIT, CARD_MEDIA_MAX_MB, LARK_APP_SECRET_REF, clampCardMediaLimit, clampCardMediaMaxMb,
  connectionFingerprint, resolveRuntimeConfig, resolveSettingsConfig,
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

  it('defaults the card image mode to workspace-only uploads', () => {
    expect(resolveSettingsConfig({ appId: 'id' }).cardImages).toBe('workspace')
    expect(resolveSettingsConfig({ appId: 'id', cardImages: 'text' }).cardImages).toBe('text')
    expect(resolveSettingsConfig({ appId: 'id', cardImages: 'any' }).cardImages).toBe('any')
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
