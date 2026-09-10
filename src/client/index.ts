import { createElement as h } from 'react'
import { LarkSettingsSection } from './LarkSettingsSection.tsx'
import { CLIENT_CSS } from './styles.ts'

const NS = 'dsh-feishu'
const dictionaries = {
  zh: {
    nav: '飞书与 Lark', title: '飞书与 Lark', subtitle: '配置消息渠道与卡片显示，保存后无需重启 Harness', runtimeStatus: '运行状态', loading: '正在读取配置......',
    application: '应用凭据', appId: 'App ID', domain: '平台', appSecret: 'App Secret', secretPlaceholder: '留空表示保留现有 Secret', credentialConfigured: 'Secret 已配置', credentialMissing: 'Secret 未配置', readOnly: '由配置或启动环境提供，只读',
    scanToConfigure: '扫码配置', provisionStarting: '正在生成二维码……', scanHint: '请用飞书 App 扫描二维码完成授权', provisioning: '正在配置应用……', provisionFailed: '配置失败',
    access: '访问策略', requireMention: '群聊中必须 @机器人', requireMentionHint: '关闭后群聊里任何消息都会触发', dmMode: '单聊策略', open: '开放', allowlist: '仅白名单', disabled: '关闭', groupAllowlist: '群聊白名单', dmAllowlist: '用户白名单', onePerLine: '每行一个 ID', reactEmoji: '表情回应', reactEmojiHint: '留空表示不添加（默认 THUMBSUP）',
    display: '卡片显示', showReasoning: '显示思考过程', showReasoningHint: '步骤卡上展示模型的 reasoning 预览（最多 200 字）', showToolCalls: '显示工具调用', showToolCallsHint: '关闭后步骤卡不显示任何工具信息，只有工具的步骤不再发卡', showToolArgs: '显示参数', showToolArgsHint: '展示每个工具调用的入参 JSON', showToolResults: '显示结果', showToolResultsHint: '展示每个工具调用的结果预览', requiresToolCalls: '需先开启「显示工具调用」',
    locale: '插件语言', localeAuto: '跟随 Harness', localeZh: '中文', localeEn: 'English',
    save: '保存并重新连接', saving: '正在保存......', saved: '已保存', saveFailed: '保存失败', loadFailed: '配置读取失败', removeSecret: '删除已保存的 Secret', removing: '正在删除......', removed: 'Secret 已删除', removeFailed: '删除失败',
  },
  en: {
    nav: 'Lark', title: 'Feishu & Lark', subtitle: 'Configure the message channel and card display without restarting Harness', runtimeStatus: 'Runtime status', loading: 'Loading settings...',
    application: 'Application credentials', appId: 'App ID', domain: 'Platform', appSecret: 'App Secret', secretPlaceholder: 'Leave blank to keep the stored secret', credentialConfigured: 'Secret configured', credentialMissing: 'Secret missing', readOnly: 'Provided by config or launch environment; read-only',
    scanToConfigure: 'Scan to configure', provisionStarting: 'Generating QR code...', scanHint: 'Scan the QR code with the Feishu app to authorize', provisioning: 'Configuring app...', provisionFailed: 'Configuration failed',
    access: 'Access policy', requireMention: 'Require @mention in group chats', requireMentionHint: 'When off, any group message triggers the bot', dmMode: 'Direct messages', open: 'Open', allowlist: 'Allowlist only', disabled: 'Disabled', groupAllowlist: 'Group allowlist', dmAllowlist: 'User allowlist', onePerLine: 'One ID per line', reactEmoji: 'Emoji reaction', reactEmojiHint: 'Leave empty to disable (default THUMBSUP)',
    display: 'Card display', showReasoning: 'Show reasoning', showReasoningHint: 'Show the model reasoning preview on step cards (up to 200 chars)', showToolCalls: 'Show tool calls', showToolCallsHint: 'When off, step cards show no tool details and tool-only steps post no card', showToolArgs: 'Show arguments', showToolArgsHint: 'Show each tool call\'s argument JSON', showToolResults: 'Show results', showToolResultsHint: 'Show each tool call\'s result preview', requiresToolCalls: 'Enable "Show tool calls" first',
    locale: 'Plugin language', localeAuto: 'Follow Harness', localeZh: '中文', localeEn: 'English',
    save: 'Save and reconnect', saving: 'Saving...', saved: 'Saved', saveFailed: 'Save failed', loadFailed: 'Unable to load settings', removeSecret: 'Remove stored secret', removing: 'Removing...', removed: 'Secret removed', removeFailed: 'Remove failed',
  },
}

interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: {
    register(namespace: string, dicts: typeof dictionaries): unknown
    bind(namespace: string): (key: string) => string
  }
  slots: {
    inject(slot: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: () => unknown): unknown
  }
}

export const name = 'dsh-feishu'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-feishu: client dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = NS
    style.textContent = CLIENT_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-feishu: client styles')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.action', () => ctx.slots.register({
    name: 'settings.action',
    id: 'open-document',
    priority: -1,
  }, () => null))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'lark',
    order: 45,
    label: () => t('nav'),
    locale: NS,
  }, () => h(LarkSettingsSection, { t })))
}
