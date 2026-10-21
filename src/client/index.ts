import { LarkSettingsCard } from './LarkSettingsCard.tsx'
import { LarkSettingsCardController, LARK_SETTINGS_NAMESPACE } from './LarkSettingsCardController.ts'
import { LarkChannelStatusController } from './LarkChannelStatusController.ts'
import { LarkChannelSection, LarkConnectionAction, LarkConnectionBadge } from './LarkPluginDetail.tsx'
import type { ConfigFormsService, RemoteService } from './config-form-types.ts'
import { CLIENT_CSS } from './styles.ts'

const NS = 'dsh-feishu'

/**
 * Entry id every surface this plugin registers under. The Settings tab and the
 * three Plugins-detail contributions live in different slots, so one id is
 * unambiguous; it matches the profile row whose client half this is.
 */
const LARK_ENTRY_ID = 'lark-channel'

const dictionaries = {
  zh: {
    nav: '飞书与 Lark', title: '飞书与 Lark', subtitle: '配置消息渠道与卡片显示，保存后无需重启 Harness',
    connectionMoved: '连接状态与扫码配置在「插件 → 飞书与 Lark」详情页。',
    connectionTitle: '连接与扫码', connectionHint: '扫码授权由飞书 App 完成：点本页右上角的「扫码配置」，二维码会显示在这里。',
    rescan: '重新扫码', provisionDone: '授权已完成',
    statusReading: '读取中', statusConnected: '已连接', statusConnecting: '连接中', statusUnconfigured: '未配置', statusOffline: '未连接', statusStopped: '已停止',
    statusOutboundFailing: '已连接 · 出站异常', statusInboundFailing: '已连接 · 长连接断开',
    outboundFailures: '出站请求连续失败', outboundUnobserved: '尚未观测到出站请求', inboundState: '长连接', inboundRetries: '重连次数',
    application: '应用凭据', appId: 'App ID', domain: '平台', appSecret: 'App Secret', secretPlaceholder: '留空表示保留现有 Secret', credentialConfigured: 'Secret 已配置', credentialMissing: 'Secret 未配置', readOnly: '由配置或启动环境提供，只读',
    scanToConfigure: '扫码配置', provisionStarting: '正在生成二维码……', scanHint: '请用飞书 App 扫描二维码完成授权', provisioning: '正在配置应用……', provisionFailed: '配置失败',
    access: '访问策略', requireMention: '群聊中必须 @机器人', requireMentionHint: '关闭后群聊里任何消息都会触发', dmMode: '单聊策略', open: '开放', allowlist: '仅白名单', disabled: '关闭', groupAllowlist: '群聊白名单', dmAllowlist: '用户白名单', onePerLine: '每行一个 ID', reactEmoji: '表情回应', reactEmojiHint: '留空表示不添加（默认 THUMBSUP）',
    display: '卡片显示', transcriptView: '工作步骤展示', transcriptViewHint: '对齐 DSH WebUI 的四档：简洁只报工具调用计数、标准每个工具一行摘要（推理只给首行）、详细（默认）带参数与结果、完全展开给出推理全文且不截断。下面四个开关只能在此基础上再关掉内容，不会让卡片比档位更详细。', transcriptViewCompact: '简洁', transcriptViewStandard: '标准', transcriptViewDetailed: '详细（默认）', transcriptViewVerbose: '完全展开', showReasoning: '显示思考过程', showReasoningHint: '步骤卡上展示模型的 reasoning 预览（最多 200 字）', showToolCalls: '显示工具调用', showToolCallsHint: '关闭后步骤卡不显示任何工具信息，只有工具的步骤不再发卡', showToolArgs: '显示参数', showToolArgsHint: '展示每个工具调用的入参 JSON', showToolResults: '显示结果', showToolResultsHint: '展示每个工具调用的结果预览', reasoningPreviewChars: '推理预览长度（字）', reasoningPreviewCharsHint: '详细档里折叠的推理只保留前 N 个字（默认 200，范围 80–4000）；完全展开档显示全文，不受此限。', resultPreviewChars: '工具结果预览长度（字）', resultPreviewCharsHint: '单个工具结果预览的字数上限（默认 1500，范围 200–6000）；完全展开档最多显示 4 倍（封顶 6000，卡片整体约 30KB 会被拒收）。', argsPreviewChars: '工具参数预览长度（字）', argsPreviewCharsHint: '单个工具调用参数块的字符上限（默认 2000，范围 200–6000）；完全展开档最多 4 倍（封顶 6000）。', requiresToolCalls: '需先开启「显示工具调用」', cardImages: '正文里的媒体', cardImagesHint: '飞书卡片只能显示上传过的媒体：这里决定正文里 ![图](路径)、[视频](路径)、[语音](路径) 这类引用怎么处理。图片与 MP4 视频直接内联，音频转成 Opus 播放器（需要 ffmpeg）；无论选哪档，卡片都不会因为媒体语法被拒收。', cardImagesWorkspace: '仅工作区内（默认）：自动上传并内联显示', cardImagesText: '不上传：只显示路径文字', cardImagesAny: '任意可读路径：工作区外的媒体也上传', produceCardDelivery: '自动投递（默认）', produceCardSummary: '只在卡上报个数', produceCardOff: '不处理',
    cardMediaLimit: '单卡媒体上限', cardMediaLimitHint: '一张卡里最多内联几个：图片算一处、视频与音频合起来算一处（各按这个数），1–30，默认 12；超出的一律退回可读路径文字。飞书本身能放更多（一张卡 200 个元素/组件，带封面的视频一个占 3 个名额、约 66 个），这个数字只是为了让消息别太长。',
    cardImageMaxMb: '图片内联上限（MB）', cardImageMaxMbHint: '超过这个大小的图片不上传、只留路径文字。范围 1–10，默认 10 —— 飞书的图片上传接口硬上限就是 10MB，写更大也不会生效。', cardVideoMaxMb: '视频内联上限（MB）', cardVideoMaxMbHint: '超过这个大小的视频不上传、只留路径文字。范围 1–30，默认 15；飞书文件接口硬上限 30MB。数字越大，卡片等上传的时间越长（已有预热与并发，但大文件仍会慢）。', cardAudioMaxMb: '音频内联上限（MB）', cardAudioMaxMbHint: '超过这个大小的音频不上传、只留路径文字。范围 1–30，默认 15；飞书文件接口硬上限 30MB。非 Opus 的音频还要先转码，另受 ffmpeg 是否可用的影响。',
    deliverDocMaxMb: '文档自动投递上限（MB）', deliverDocMaxMbHint: '`present` 声明的 pdf / doc / docx / ppt / pptx / xls / xlsx 不超过这个大小就直接发成飞书文件消息；超过它的文档、以及所有其他文件（源码、压缩包等）都变成交付清单里可点的一行，点一下弹确认卡，确认后才发送。范围 1–30，默认 30（飞书文件接口硬上限）。',
    produceCard: '本轮产出物', produceCardHint: '一轮里模型用 write/edit 写过、但没有用 `present` 声明的文件：源码、测试、临时脚本这类**永不投递**（这里是聊天，不是文件浏览器）；只有图片/视频/音频与 pdf/office 文档会被当成交付物。选「自动投递」（默认）会把这些产出物走和 `present` 完全一样的路：媒体内联在卡上、文档不超过上限就发成文件消息、其余给可点的一行；选「只在卡上报个数」只加一行「本回合新生成 N 个文件」；选「不处理」则完全静默。',
    locale: '插件语言', localeAuto: '跟随 Harness', localeZh: '中文', localeEn: 'English',
    save: '保存并重新连接', saving: '正在保存......', saved: '已保存', saveFailed: '保存失败', loadFailed: '读取失败', removeSecret: '删除已保存的 Secret', removing: '正在删除......', removed: 'Secret 已删除', removeFailed: '删除失败',
  },
  en: {
    nav: 'Lark', title: 'Feishu & Lark', subtitle: 'Configure the message channel and card display without restarting Harness',
    connectionMoved: 'Connection status and scan-to-configure live on the Plugins → Lark detail page.',
    connectionTitle: 'Connection & scan', connectionHint: 'Authorization happens in the Feishu app: use Scan to configure in this page\'s header and the QR code appears here.',
    rescan: 'Scan again', provisionDone: 'Authorization complete',
    statusReading: 'Reading...', statusConnected: 'Connected', statusConnecting: 'Connecting', statusUnconfigured: 'Not configured', statusOffline: 'Not connected', statusStopped: 'Stopped',
    statusOutboundFailing: 'Connected · outbound failing', statusInboundFailing: 'Connected · long connection down',
    outboundFailures: 'Consecutive outbound failures', outboundUnobserved: 'No outbound request observed yet', inboundState: 'Long connection', inboundRetries: 'Reconnect attempts',
    application: 'Application credentials', appId: 'App ID', domain: 'Platform', appSecret: 'App Secret', secretPlaceholder: 'Leave blank to keep the stored secret', credentialConfigured: 'Secret configured', credentialMissing: 'Secret missing', readOnly: 'Provided by config or launch environment; read-only',
    scanToConfigure: 'Scan to configure', provisionStarting: 'Generating QR code...', scanHint: 'Scan the QR code with the Feishu app to authorize', provisioning: 'Configuring app...', provisionFailed: 'Configuration failed',
    access: 'Access policy', requireMention: 'Require @mention in group chats', requireMentionHint: 'When off, any group message triggers the bot', dmMode: 'Direct messages', open: 'Open', allowlist: 'Allowlist only', disabled: 'Disabled', groupAllowlist: 'Group allowlist', dmAllowlist: 'User allowlist', onePerLine: 'One ID per line', reactEmoji: 'Emoji reaction', reactEmojiHint: 'Leave empty to disable (default THUMBSUP)',
    display: 'Card display', transcriptView: 'Work details', transcriptViewHint: 'The DSH WebUI\'s four levels: Compact counts tool calls only, Standard gives each call one summary line (reasoning first line only), Detailed (default) adds arguments and result previews, Verbose shows the whole reasoning untruncated. The four switches below can only remove detail from the level, never add.', transcriptViewCompact: 'Compact', transcriptViewStandard: 'Standard', transcriptViewDetailed: 'Detailed (default)', transcriptViewVerbose: 'Verbose', showReasoning: 'Show reasoning', showReasoningHint: 'Show the model reasoning preview on step cards', showToolCalls: 'Show tool calls', showToolCallsHint: 'When off, step cards show no tool details and tool-only steps post no card', showToolArgs: 'Show arguments', showToolArgsHint: 'Show each tool call\'s argument JSON', showToolResults: 'Show results', showToolResultsHint: 'Show each tool call\'s result preview', reasoningPreviewChars: 'Reasoning preview length (chars)', reasoningPreviewCharsHint: 'The folded reasoning head at the detailed level keeps this many characters (default 200, range 80-4000); the verbose level shows the whole chain and ignores it.', resultPreviewChars: 'Tool result preview length (chars)', resultPreviewCharsHint: 'Character cap for one tool result preview (default 1500, range 200-6000). The verbose level shows up to 4x, capped at 6000 because a card near 30 KB is refused whole.', argsPreviewChars: 'Tool arguments length (chars)', argsPreviewCharsHint: 'Character cap for one tool call\'s arguments block (default 2000, range 200-6000). The verbose level shows up to 4x, capped at 6000.', requiresToolCalls: 'Enable "Show tool calls" first', cardImages: 'Media in card text', cardImagesHint: 'A Feishu card can only render media it uploaded itself: this decides what happens to `![alt](path)`, `[clip](path)` and `[voice](path)` references in the model\'s text. Images and MP4 video are inlined, audio becomes an Opus player (needs ffmpeg). Whichever mode you pick, a card is never rejected over media syntax.', cardImagesWorkspace: 'Workspace only (default): upload and show inline', cardImagesText: 'Never upload: show the path as text', cardImagesAny: 'Any readable path: upload media outside the workspace too', produceCardDelivery: 'Deliver (default)', produceCardSummary: 'Count only', produceCardOff: 'Ignore',
    cardMediaLimit: 'Media per card', cardMediaLimitHint: 'How many media one card may inline, counted per group: images on the one hand, video and audio together on the other, 1-30, default 12; anything past it stays a readable path. Feishu itself allows far more (200 elements/components per card, and a video with a cover spends three, so about 66 videos) — this number is here to keep a message readable.',
    cardImageMaxMb: 'Image inline limit (MB)', cardImageMaxMbHint: 'An image larger than this is not uploaded — its path stays as text. Range 1-10, default 10: Feishu\'s image upload API caps at 10 MB, so a larger value could never take effect.', cardVideoMaxMb: 'Video inline limit (MB)', cardVideoMaxMbHint: 'A video larger than this is not uploaded — its path stays as text. Range 1-30, default 15; Feishu\'s file API caps at 30 MB. Bigger files only cost wait: the upload happens on the card-write path (warming and concurrency help, but a large file is still slow).', cardAudioMaxMb: 'Audio inline limit (MB)', cardAudioMaxMbHint: 'Audio larger than this is not uploaded — its path stays as text. Range 1-30, default 15; Feishu\'s file API caps at 30 MB. Non-Opus audio is transcoded first, so ffmpeg has to be available.',
    deliverDocMaxMb: 'Document auto-send limit (MB)', deliverDocMaxMbHint: 'A pdf / doc / docx / ppt / pptx / xls / xlsx declared by `present` under this size is pushed as a Feishu file message by itself. Larger documents — and every other file (source code, archives, …) — become a tappable row on the Turn Complete card: one tap opens a confirmation, and only that sends. Range 1-30, default 30 (Feishu\'s file API cap).',
    produceCard: 'Produced files', produceCardHint: 'Files a turn wrote with write/edit but never declared through `present`: source code, tests and scratch scripts are NEVER delivered (this is a chat, not a file browser) - only images/video/audio and pdf/office documents count as artifacts. "Deliver" (default) sends those through exactly the same path as `present`: media inline on the card, documents under the size limit as file messages, the rest as a tappable row. "Count only" adds one line ("N file(s) produced this turn"). "Ignore" stays silent.',
    locale: 'Plugin language', localeAuto: 'Follow Harness', localeZh: '中文', localeEn: 'English',
    save: 'Save and reconnect', saving: 'Saving...', saved: 'Saved', saveFailed: 'Save failed', loadFailed: 'Unable to read status', removeSecret: 'Remove stored secret', removing: 'Removing...', removed: 'Secret removed', removeFailed: 'Remove failed',
  },
}

interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: {
    register(namespace: string, dicts: typeof dictionaries): unknown
    bind(namespace: string): (key: string) => string
  }
  slots: {
    inject(slot: string, register: () => unknown): () => void
    register(meta: Record<string, unknown>, component: (props: any) => unknown): unknown
  }
  /** Native configuration forms, one per Host entry, from ui-settings' client half. */
  configForms: ConfigFormsService
  /** Forwarded Remote namespaces; `credentials` addresses the secret by reference. */
  remote: RemoteService
}

export const name = 'dsh-feishu'
// `remote.credentials` carries the write-only secret; `configForms` carries the
// revision-fenced section writes. Both are browser-side services, so the host
// half keeps working on a Harness that lacks either.
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

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
  // This plugin used to shadow the shell's `settings.action` cell — the same
  // `name` + `id` (`open-document`) at `priority: -1` — with a component that
  // renders nothing. Removed 2026-09-23, after the audit the old comment asked
  // for, because its reach was wider than it looked and the intent was never
  // ours: the registration came verbatim from the upstream dsh-lark release
  // with no rationale in any comment or commit message, and `settings.action`
  // is a ROOT-scoped list slot whose cells shadow by `name` + `id` with the
  // LOWEST `priority` winning. Our `-1` therefore replaced the shell's "open
  // configuration file" button on EVERY settings page, not just this section.
  // The shell's action is a legitimate affordance — the Host reports
  // `hasDocument: true` unconditionally and `prepareDocument()` creates the
  // file before opening it — and this plugin's configuration lived in exactly
  // that document before DSH 0.1.7. Do not re-add this without a reason that
  // names the shell's own behaviour as the problem.
  //
  // Two controllers, one concern each: the settings page owns the form and the
  // credential badge, the Plugins detail page owns the live channel.
  const card = new LarkSettingsCardController(ctx.configForms.get(LARK_SETTINGS_NAMESPACE), ctx, t)
  ctx.effect(() => () => { card.dispose() }, 'dsh-feishu: settings form subscription')
  // A provisioning run completes on the detail page and the Host writes the
  // secret there, so the settings page's badge is told to re-read rather than
  // waiting for the forwarded credential event to arrive.
  const status = new LarkChannelStatusController(t, {
    onProvisionCompleted: () => { card.rereadCredential() },
  })
  ctx.effect(() => () => { status.dispose() }, 'dsh-feishu: channel status lifetime')
  // A secret written on another surface changes no settings section, so its
  // scope publishes nothing; this is the only signal that the Host replaced it.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', ref => { card.refreshCredential(ref) }),
    'dsh-feishu: credential invalidations',
  )
  // One gate for every surface this plugin adds: the Host serves the
  // `lark-channel` entry, and then the Settings tab keeps configuration while
  // the Plugins detail page owns connection state and the scan flow.
  //
  // `settings.section` takes the same `inject` face as the Plugins page's items
  // — `ui-settings-account` and `ui-settings-models` register their sections
  // exactly this way — and the three `plugins.detail.*` slots are root-scoped
  // list slots whose entries render the open page's subject.
  ctx.effect(() => ctx.configForms.whileServed([LARK_SETTINGS_NAMESPACE], () => {
    const off: (() => void)[] = []
    off.push(ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'lark',
      order: 45,
      label: () => t('nav'),
      locale: NS,
      inject: () => card.inject(),
    }, LarkSettingsCard)))
    for (const [slot, component] of [
      ['plugins.detail.badge', LarkConnectionBadge],
      ['plugins.detail.actions', LarkConnectionAction],
      ['plugins.detail.section', LarkChannelSection],
    ] as const) {
      off.push(ctx.slots.inject(slot, () => ctx.slots.register({
        name: slot,
        id: LARK_ENTRY_ID,
        order: 60,
        label: () => t('nav'),
        locale: NS,
        inject: () => status.face(),
      }, component)))
    }
    return () => { for (const dispose of off) dispose() }
  }), 'dsh-feishu: settings page and plugin detail')
}
