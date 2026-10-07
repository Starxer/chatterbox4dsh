/**
 * The Feishu surface announcement.
 *
 * DSH surfaces announce themselves through the system-prompt registry: the Web
 * bundle registers `app:web-surface` (one `systemPrompt.section` with a `text`
 * provider, behind its `surfaceContext` switch) and nothing announces Feishu —
 * so a Feishu-bound session was told it is "interacting with the user through
 * the DeepSeek Harness Web GUI" and that `present` produces "preview and
 * native-open actions", neither of which exists in a Feishu chat (关键坑 52).
 * This module adds the missing sentence, the same way upstream does.
 *
 * Two properties matter:
 *
 * - **Scoped by session, not global.** The provider returns `''` for every
 *   agent that is not bound to a Feishu chat, so a Web-GUI-only session's
 *   prompt is byte-for-byte what it was.
 * - **Per session, not per turn.** The text deliberately says nothing about
 *   where the running turn came from: the delivery card is posted for turns
 *   started outside Feishu too (`feishu-external-turns.ts`), so the sentence is
 *   true for every turn and the assembled prompt never changes while the
 *   binding holds. A changing system prompt appends a new `system/message`
 *   surface node and invalidates the cached prefix, which is exactly what a
 *   per-turn variant would do on every surface switch.
 *
 * @module @starxer/chatterbox4dsh/feishu-surface
 */

import type { Context } from '@deepseek-ai/cordis'

/** Prompt-registry name of this contribution. */
export const FEISHU_SURFACE_SECTION = 'channel:feishu-surface'

/**
 * What only this channel can tell the model. Deliberately free of any fact the
 * tool description already carries (`feishu_send_file` says what it sends and
 * within which limits); this states WHERE the user is and what the other
 * delivery path reaches them with on this surface.
 */
export const FEISHU_SURFACE_NOTICE = 'You are talking to the user in a Feishu chat, not the Web GUI: '
  + 'replies arrive there as Feishu cards and the user cannot open local paths. '
  + 'DSH\'s `present` tool surfaces on the Feishu delivery card at the end of every turn '
  + '(media inlined, whitelisted documents pushed as files, other files needing a tap). '
  + 'To hand the user the file itself — especially one they must save or forward, or one they '
  + 'need before the turn ends — call `feishu_send_file`.'

/**
 * The section text for one assembly.
 * @param isBound - whether that agent's session is bound to a Feishu chat.
 * @param enabled - the `surfaceContext` setting.
 * @returns the notice, or `''` to contribute nothing.
 */
export function feishuSurfaceText(isBound: boolean, enabled: boolean): string {
  return enabled && isBound ? FEISHU_SURFACE_NOTICE : ''
}

/** What this module needs from the host. */
export interface FeishuSurfaceDeps {
  /** Whether a session is bridged to a Feishu chat. */
  isBound: (sessionId: string) => boolean
  /** The `surfaceContext` setting, read live. */
  enabled: () => boolean
}

/**
 * Minimal structural view of the host `systemPrompt` service. A dependency on
 * `@deepseek-ai/dsh-system-prompt` only for these two members is not worth the
 * lockfile churn; the service is resolved by name at runtime.
 */
interface SystemPromptLike {
  section(input: { name: string; order: number; text: (assembly: unknown) => string }): () => void
  getSectionOrder(name: 'WEB_SURFACE'): number
}

interface PromptScope {
  systemPrompt: SystemPromptLike
}

interface InjectingHost {
  inject(services: string[], callback: (scope: PromptScope) => void): { dispose?: () => unknown } | undefined
}

/**
 * Register the Feishu surface section on the host prompt registry.
 *
 * `inject` (not `get`) is the point: the plugin may apply before the prompt
 * service exists, and the callback runs once it does. The returned disposer is
 * idempotent, so a plugin teardown cannot throw.
 *
 * @param ctx - the plugin context.
 * @param deps - binding test and live setting.
 * @returns the disposer.
 */
export function installFeishuSurfacePrompt(ctx: Context, deps: FeishuSurfaceDeps): () => void {
  const host = ctx as unknown as InjectingHost
  const fiber = host.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: FEISHU_SURFACE_SECTION,
      // The registry owns placement; `WEB_SURFACE` is the "which surface is the
      // user on" slot the Web bundle also uses (order 10100), which puts this
      // sentence AFTER `ui:deliverable-file-references` (9000) — the paragraph
      // that promises native-open — so it reads as the correction it is.
      order: scope.systemPrompt.getSectionOrder('WEB_SURFACE'),
      text: (assembly) => {
        const agentId = (assembly as { agent?: { id?: unknown } } | undefined)?.agent?.id
        if (typeof agentId !== 'string') return ''
        return feishuSurfaceText(deps.isBound(agentId), deps.enabled())
      },
    })
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try {
      void Promise.resolve(fiber?.dispose?.()).catch(() => undefined)
    } catch {
      // A fiber already disposed by the plugin scope: nothing left to do.
    }
  }
}
