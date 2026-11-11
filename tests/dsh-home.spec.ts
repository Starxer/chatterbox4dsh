import { afterEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHomeFile, resolveDshHome } from '../src/dsh-home.ts'

const savedEnv = process.env.DSH_HOME

afterEach(() => {
  if (savedEnv === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedEnv
})

/** A context that answers only `dshHomePath`, like the Host does. */
function hostContext(home: string) {
  return { get: (name: string) => (name === 'dshHomePath' ? () => home : undefined) }
}

describe('resolveDshHome', () => {
  it('prefers the path the Host provides', () => {
    process.env.DSH_HOME = '/env/home'
    expect(resolveDshHome(hostContext('/host/home'))).toBe('/host/home')
  })

  it('falls back to DSH_HOME, then to the user home', () => {
    delete process.env.DSH_HOME
    expect(resolveDshHome({ get: () => undefined })).toBe(join(homedir(), '.dsh'))

    process.env.DSH_HOME = '/env/home'
    expect(resolveDshHome(undefined)).toBe('/env/home')
  })

  it('survives a host lookup that throws or answers with a non-string', () => {
    process.env.DSH_HOME = '/env/home'
    expect(resolveDshHome({ get: () => { throw new Error('no such service') } })).toBe('/env/home')
    expect(resolveDshHome({ get: () => () => 42 as unknown as string })).toBe('/env/home')
  })

  it('joins state file names with the platform separator', () => {
    // The regression this guards is Windows: the old code concatenated
    // `${dshHome}/lark-session-map.json`, which mixes separators there.
    expect(dshHomeFile(hostContext('/host/home'), 'lark-session-map.json'))
      .toBe(join('/host/home', 'lark-session-map.json'))
  })
})
