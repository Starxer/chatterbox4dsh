/**
 * Startup / restart notice: one plugin-authored message into the chat that was
 * active last, without involving the model.
 *
 * Why the plugin and not the agent: at boot there is no turn to run, and the
 * user still wants the one fact that matters — "DSH is up and Feishu is
 * connected". If the last turn never ended (DSH stopped or was restarted
 * mid-work), the same message also warns that the session may have been
 * interrupted and that sending a message resumes it.
 *
 * The state comes from the bridge, which records a `turn/start` and a
 * `turn/end` per session (persisted). A graceful stop mid-turn still leaves the
 * `turn/start` marker on disk, so "interrupted" is not limited to crashes.
 *
 * Called once per process from the plugin's first `onChannelChange`; a
 * module-level flag on `globalThis` keeps a hot reload in the same process from
 * repeating it.
 *
 * @module @starxer/chatterbox4dsh/feishu-startup-notice
 */

import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { Translations } from './i18n.ts'
import type { HarnessConversationService } from './harness.ts'
import { withLinkTimeout } from './outbound-timeout.ts'
import { errorText } from './error-text.ts'

/** One outbound text send; short budget because this is a best-effort notice. */
const STARTUP_NOTICE_TIMEOUT_MS = 15_000
/** How many recent sessions to consider when picking the chat to notify. */
const CANDIDATE_LIMIT = 20

/** Minimal logger surface; matches ctx.logger's call style. */
interface PluginLogger {
  warn(message: string): unknown
}

/** Live references for one notice attempt. */
export interface StartupNoticeDeps {
  bridgeHolder: { current: HarnessConversationService | undefined }
  channelHolder: { current: LarkChannel | undefined }
  getTranslations: () => Translations
  logger: PluginLogger
}

/** What the attempt did, for logging and tests. */
export interface StartupNoticeResult {
  sent: boolean
  /** Why nothing was sent: no bridge/channel, or no chat-bound session. */
  reason?: 'no-bridge' | 'no-channel' | 'no-bound-session' | 'send-failed'
  sessionId?: string
  chatId?: string
  interrupted?: boolean
}

/**
 * Send the startup notice to the most recently active session's chat.
 *
 * Picks the first recent session that still resolves to a Feishu chat, so a
 * Web-UI-only session cannot swallow the notice. Best-effort: every failure is
 * logged and reported, never thrown into the plugin's start path.
 *
 * @param deps - live bridge/channel plus the locale dictionary.
 * @returns whether a message was sent and what it covered.
 */
export async function sendStartupNotice(deps: StartupNoticeDeps): Promise<StartupNoticeResult> {
  const bridge = deps.bridgeHolder.current
  if (bridge === undefined) return { sent: false, reason: 'no-bridge' }
  const channel = deps.channelHolder.current
  if (channel === undefined) return { sent: false, reason: 'no-channel' }

  for (const candidate of bridge.recentActiveSessions(CANDIDATE_LIMIT)) {
    const chat = bridge.resolveChat(candidate.sessionId)
    if (chat === undefined) continue

    const t = deps.getTranslations()
    const text = candidate.interrupted
      ? `${t.startupNoticeConnected}\n${t.startupNoticeInterrupted}`
      : t.startupNoticeConnected
    const options = chat.threadId === undefined
      ? {}
      : { replyInThread: true as const, ...(chat.rootId === undefined ? {} : { replyTo: chat.rootId }) }

    try {
      await withLinkTimeout(
        channel.send(chat.chatId, { text }, options),
        'send startup notice',
        STARTUP_NOTICE_TIMEOUT_MS,
      )
    } catch (error: unknown) {
      deps.logger.warn(
        `dsh-feishu: startup notice to ${chat.chatId} failed: ${errorText(error, 'unknown Feishu error')}`,
      )
      return { sent: false, reason: 'send-failed', sessionId: candidate.sessionId, chatId: chat.chatId, interrupted: candidate.interrupted }
    }

    // Only clear the marker once the user was actually told about it.
    if (candidate.interrupted) bridge.clearInterrupted(candidate.sessionId)
    return {
      sent: true,
      sessionId: candidate.sessionId,
      chatId: chat.chatId,
      interrupted: candidate.interrupted,
    }
  }
  return { sent: false, reason: 'no-bound-session' }
}

/**
 * Run {@link sendStartupNotice} at most once per process, from the first
 * channel change.
 *
 * The `globalThis` flag (keyed by pid) survives a hot reload of the plugin in
 * the same process, so a reload does not spam the chat; a real restart has a
 * new pid and notifies again.
 *
 * @param deps - live bridge/channel plus the locale dictionary.
 * @returns a promise resolved after the attempt (never rejects).
 */
export function sendStartupNoticeOnce(deps: StartupNoticeDeps): Promise<void> {
  const flag = Symbol.for('dsh-feishu.startup-notice')
  const registry = globalThis as unknown as Record<symbol, unknown>
  if (registry[flag] === process.pid) return Promise.resolve()
  registry[flag] = process.pid
  return sendStartupNotice(deps)
    .then(result => {
      if (result.sent) {
        deps.logger.warn(
          `dsh-feishu: startup notice sent to ${result.chatId}`
          + `${result.interrupted === true ? ' (previous turn interrupted)' : ''}`,
        )
      }
    })
    .catch((error: unknown) => {
      deps.logger.warn(`dsh-feishu: startup notice failed: ${errorText(error, 'unknown error')}`)
    })
}
