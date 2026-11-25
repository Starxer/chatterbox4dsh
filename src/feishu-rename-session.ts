import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HarnessConversationService } from './harness.ts'
import { TOOL_CAPTION_PARAM } from './tool-caption.ts'

interface SessionTitleWriter {
  rename(session: Session, title: string): { readonly title: string }
}

/** Register on-demand renaming for the caller's own Feishu-bound session. */
export function startFeishuRenameSessionTool(
  ctx: Context,
  bridgeHolder: { current: Pick<HarnessConversationService, 'sessionOwnerKey'> | undefined },
): () => void {
  const isBound = (session: Session): boolean => bridgeHolder.current?.sessionOwnerKey(session.id) !== undefined
  const titleWriter = (): SessionTitleWriter | undefined => {
    const service = ctx.get('sessionTitle') as SessionTitleWriter | undefined
    return typeof service?.rename === 'function' ? service : undefined
  }

  return ctx.tools.register(defineTool({
    name: 'feishu_rename_session',
    description: 'Rename the current Feishu-bound DSH session when the user explicitly asks to change its title. '
      + 'This sets a manual title that automatic naming will not overwrite. It does not rename the Feishu topic.',
    parameters: {
      description: TOOL_CAPTION_PARAM,
      title: {
        type: 'string',
        required: true,
        description: 'New session title: concise, plain text on one line.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Session renamed to ${JSON.stringify(value.title)}.` }],
    },
    async execute({ title }, exec) {
      const session = exec.agent?.session
      if (session === undefined || !isBound(session)) {
        throw new Error('The current DSH session is not bound to a Feishu chat.')
      }
      const writer = titleWriter()
      if (writer === undefined) throw new Error('The host does not support renaming sessions.')
      exec.signal.throwIfAborted()
      // Use the live session directly: there is no target argument or resume path.
      return { title: writer.rename(session, title).title }
    },
  }), { when: ({ agent }) => isBound(agent.session) && titleWriter() !== undefined })
}
