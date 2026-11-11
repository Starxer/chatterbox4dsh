import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { isLocalAbsolutePath, isWindowsAbsolutePath } from '../src/local-path.ts'

describe('isWindowsAbsolutePath', () => {
  it('accepts drive paths in both separators and UNC shares', () => {
    expect(isWindowsAbsolutePath('C:\\shots\\a.png')).toBe(true)
    expect(isWindowsAbsolutePath('c:/shots/a.png')).toBe(true)
    expect(isWindowsAbsolutePath('\\\\server\\share\\a.png')).toBe(true)
    // Long-path prefix form.
    expect(isWindowsAbsolutePath('\\\\?\\C:\\shots\\a.png')).toBe(true)
  })

  it('rejects a drive-relative path, matching path.win32 semantics', () => {
    expect(isWindowsAbsolutePath('C:shots\\a.png')).toBe(false)
    expect(isWindowsAbsolutePath('shots\\a.png')).toBe(false)
    expect(isWindowsAbsolutePath('/tmp/a.png')).toBe(false)
    expect(isWindowsAbsolutePath('https://example.com/a.png')).toBe(false)
  })
})

describe('isLocalAbsolutePath', () => {
  it('covers the host platform and Windows alike', () => {
    expect(isLocalAbsolutePath(join('/tmp', 'a.png'))).toBe(true)
    expect(isLocalAbsolutePath('C:\\shots\\a.png')).toBe(true)
    expect(isLocalAbsolutePath('\\\\server\\share\\a.png')).toBe(true)
    expect(isLocalAbsolutePath('shots/a.png')).toBe(false)
    expect(isLocalAbsolutePath('https://example.com/a.png')).toBe(false)
  })
})
