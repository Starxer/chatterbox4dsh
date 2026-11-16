import { describe, expect, it } from 'vitest'
import { admissionFailureText } from '../src/channel.ts'

describe('admissionFailureText', () => {
  it('names the network/DNS problem and says the message did not reach the agent', () => {
    const text = admissionFailureText('图片', new Error('getaddrinfo ENOTFOUND open.feishu.cn'), 'safe error')
    expect(text).toContain('图片下载失败')
    expect(text).toContain('open.feishu.cn')
    expect(text).toContain('DNS')
    expect(text).toContain('本条消息没有进入 agent')
    expect(text).toContain('ENOTFOUND')
  })

  it('keeps the old wording for a non-network admission failure, plus the no-dispatch note', () => {
    const text = admissionFailureText('文件', new Error('file is too large'), 'safe error')
    expect(text).toBe('文件处理出错：file is too large\n本条消息没有进入 agent。')
    expect(text).not.toContain('open.feishu.cn')
  })

  it('falls back to the configured apology when the error carries no reason', () => {
    expect(admissionFailureText('图片', undefined, '处理消息失败'))
      .toBe('图片处理出错：处理消息失败\n本条消息没有进入 agent。')
  })
})
