import { describe, expect, it } from 'vitest'
import { collectRecentRoutes } from '../src/route-history.ts'

/** One request header event as the session log stores it. */
function header(seq: number, provider: string, model: string, reasoningEffort?: string): { seq: number; type: string; data: unknown } {
  return {
    seq,
    type: 'request/header',
    data: { header: { config: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } } },
  }
}

/** One explicit model selection event. */
function selection(seq: number, provider: string, model: string): { seq: number; type: string; data: unknown } {
  return { seq, type: 'model/selection', data: { provider, model } }
}

describe('collectRecentRoutes', () => {
  it('returns the routes the log recorded, newest first', () => {
    const routes = collectRecentRoutes([
      header(1, 'p', 'old'),
      selection(2, 'q', 'older'),
      header(3, 'q', 'older'),
      header(4, 'p', 'current'),
    ])
    expect(routes.map(route => `${route.provider}/${route.model}`)).toEqual(['p/current', 'q/older', 'p/old'])
    expect(routes[0]!.seq).toBe(4)
  })

  it('collapses consecutive duplicates (a header per request series)', () => {
    const routes = collectRecentRoutes([
      header(1, 'p', 'm'),
      header(2, 'p', 'm'),
      header(3, 'p', 'm'),
      header(4, 'q', 'n'),
    ])
    expect(routes.map(route => route.model)).toEqual(['n', 'm'])
  })

  it('keeps the reasoning effort and only the newest `limit` routes', () => {
    const routes = collectRecentRoutes([
      header(1, 'a', 'one'),
      header(2, 'b', 'two'),
      header(3, 'c', 'three', 'high'),
      header(4, 'd', 'four'),
    ], 2)
    expect(routes.map(route => route.model)).toEqual(['four', 'three'])
    expect(routes[1]!.reasoningEffort).toBe('high')
  })

  it('ignores events that name no usable route', () => {
    expect(collectRecentRoutes([
      { seq: 1, type: 'request/header', data: { header: {} } },
      { seq: 2, type: 'user/message', data: { content: [] } },
      { seq: 3, type: 'model/selection', data: { provider: '', model: 'm' } },
      header(4, 'p', 'm'),
    ]).map(route => route.model)).toEqual(['m'])
  })
})
