import type { Context } from '@deepseek-ai/cordis'
import type { ToolActivationContext, ToolDefinition, ToolRegistrationOptions, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { startFeishuRenameSessionTool } from '../src/feishu-rename-session.ts'

const args = { description: '修改当前会话标题', title: '  会话标题  ' }

function setup() {
  const session = { id: 'current' }
  const agent = { session }
  const rename = vi.fn((_session, title: string) => ({ title: title.trim() }))
  const host = { current: { rename } as { rename?: typeof rename } | undefined }
  const bridge = { sessionOwnerKey: vi.fn((id: string) => id === session.id ? 'thread:chat:topic' : undefined) }
  const bridgeHolder = { current: bridge as typeof bridge | undefined }
  const dispose = vi.fn()
  const register = vi.fn((_tool: ToolDefinition, _options: ToolRegistrationOptions) => dispose)
  const ctx = { get: (key: string) => key === 'sessionTitle' ? host.current : undefined, tools: { register } }
  const stop = startFeishuRenameSessionTool(ctx as unknown as Context, bridgeHolder)
  const [tool, options] = register.mock.calls[0]!
  const when = (target: { session: { id: string } } = agent) => options.when!({ agent: target } as ToolActivationContext)
  const execute = (
    input: unknown = args,
    target: { session: { id: string } } | null = agent,
    signal: AbortSignal = new AbortController().signal,
  ) => tool.execute(input, { agent: target ?? undefined, signal } as ToolRunContext)
  return { session, rename, host, bridgeHolder, dispose, stop, tool, when, execute }
}

describe('feishu_rename_session', () => {
  it('registers only title and caption arguments and returns the tool disposer', () => {
    const { tool, stop, dispose } = setup()
    expect(tool.name).toBe('feishu_rename_session')
    expect(tool.parameters).toMatchObject({
      required: expect.arrayContaining(['title', 'description']),
    })
    expect(Object.keys(tool.parameters.properties as object).sort()).toEqual(['description', 'title'])
    stop()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('renames the exact live caller session and returns the title accepted by the host', async () => {
    const { session, rename, execute, tool } = setup()
    const result = await execute({ ...args, session_id: 'another-session' })
    expect(result).toEqual({ title: '会话标题' })
    expect(rename).toHaveBeenCalledExactlyOnceWith(session, args.title)
    expect(rename.mock.calls[0]![0]).toBe(session)
    expect(tool.output.render(args, { title: '会话标题' })).toEqual([
      { type: 'text', text: 'Session renamed to "会话标题".' },
    ])
  })

  it('advertises the tool only when the current session is bound and the host supports rename', () => {
    const { when, host, bridgeHolder } = setup()
    expect(when()).toBe(true)
    expect(when({ session: { id: 'unbound' } })).toBe(false)
    const service = host.current
    host.current = undefined
    expect(when()).toBe(false)
    host.current = service
    bridgeHolder.current = undefined
    expect(when()).toBe(false)
  })

  it('rechecks binding and capability at execution before writing', async () => {
    const { when, host, bridgeHolder, rename, execute } = setup()
    expect(when()).toBe(true)
    const bridge = bridgeHolder.current
    bridgeHolder.current = undefined
    await expect(execute()).rejects.toThrow('not bound')
    bridgeHolder.current = bridge
    await expect(execute(args, null)).rejects.toThrow('not bound')
    await expect(execute(args, { session: { id: 'unbound' } })).rejects.toThrow('not bound')
    host.current = {}
    await expect(execute()).rejects.toThrow('does not support renaming')
    expect(rename).not.toHaveBeenCalled()
  })

  it('does not write on cancellation and propagates host validation errors', async () => {
    const { rename, execute } = setup()
    await expect(execute(args, undefined, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
    expect(rename).not.toHaveBeenCalled()
    rename.mockImplementationOnce(() => { throw new Error('session title must contain visible characters') })
    await expect(execute({ ...args, title: '   ' })).rejects.toThrow('must contain visible characters')
  })
})
