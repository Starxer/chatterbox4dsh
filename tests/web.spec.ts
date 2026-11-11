import { describe, expect, it, vi } from 'vitest'
import { handleProvisionRequest } from '../src/web.ts'

function response() {
  const headers = new Map<string, string>()
  let body = ''
  return {
    statusCode: 200,
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
    end: vi.fn((value = '') => { body = value }),
    get body() { return body },
    headers,
  }
}

describe('provision web route', () => {
  it('rejects non-loopback requests', async () => {
    const res = response()
    // TEST-NET-3 (RFC 5737): a documentation address, so the public repo never
    // carries a real private-network literal.
    await handleProvisionRequest({ method: 'GET', headers: {}, socket: { remoteAddress: '203.0.113.7' } } as any, res as any, {} as any)
    expect(res.statusCode).toBe(403)
  })

  it('serves runtime and provision status on GET and starts on same-origin POST', async () => {
    const api = {
      provisionStatus: vi.fn(() => ({ phase: 'waiting', qrUrl: 'https://scan.example/verify' })),
      provision: vi.fn(() => ({ phase: 'waiting', qrUrl: 'https://scan.example/verify' })),
      runtimeStatus: vi.fn(() => ({ state: 'connecting' })),
    }
    const getRes = response()
    await handleProvisionRequest({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any, getRes as any, api as any)
    expect(api.provisionStatus).toHaveBeenCalledOnce()
    expect(api.runtimeStatus).toHaveBeenCalledOnce()
    expect(getRes.body).toContain('scan.example')
    expect(JSON.parse(getRes.body)).toMatchObject({ runtime: { state: 'connecting' }, provision: { phase: 'waiting' } })

    const postRes = response()
    await handleProvisionRequest({ method: 'POST', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, socket: { remoteAddress: '::1' } } as any, postRes as any, api as any)
    expect(api.provision).toHaveBeenCalledOnce()
  })

  it('accepts a POST the DSH desktop shell forwarded (it strips Origin)', async () => {
    // `apps/desktop/src/web-document.ts` deletes `origin`/`host`/`cookie`
    // before forwarding to the Host, so the shell's own POST arrives with no
    // Origin at all. Every browser sends one for POST, so treating "absent"
    // as trusted is what the scan button needs on Windows.
    const api = {
      provisionStatus: vi.fn(),
      provision: vi.fn(() => ({ phase: 'waiting', qrUrl: 'https://scan.example/verify' })),
      runtimeStatus: vi.fn(() => ({ state: 'connecting' })),
    }
    const res = response()
    await handleProvisionRequest({ method: 'POST', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } } as any, res as any, api as any)
    expect(res.statusCode).toBe(200)
    expect(api.provision).toHaveBeenCalledOnce()
  })

  it('accepts the desktop application origin when a shell forwards it anyway', async () => {
    const api = { provisionStatus: vi.fn(), provision: vi.fn(() => ({ phase: 'waiting' })), runtimeStatus: vi.fn(() => ({})) }
    const res = response()
    await handleProvisionRequest({
      method: 'POST',
      headers: { origin: 'dsh-app://app', host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    } as any, res as any, api as any)
    expect(res.statusCode).toBe(200)
    expect(api.provision).toHaveBeenCalledOnce()
  })

  it('rejects a POST with no Origin addressed through a foreign Host', async () => {
    const api = { provisionStatus: vi.fn(), provision: vi.fn(), runtimeStatus: vi.fn() }
    const res = response()
    await handleProvisionRequest({ method: 'POST', headers: { host: 'attacker.example' }, socket: { remoteAddress: '127.0.0.1' } } as any, res as any, api as any)
    expect(res.statusCode).toBe(403)
    expect(api.provision).not.toHaveBeenCalled()
  })

  it('rejects a same-origin POST the browser marks cross-site', async () => {
    const api = { provisionStatus: vi.fn(), provision: vi.fn(), runtimeStatus: vi.fn() }
    const res = response()
    await handleProvisionRequest({
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
      socket: { remoteAddress: '127.0.0.1' },
    } as any, res as any, api as any)
    expect(res.statusCode).toBe(403)
    expect(api.provision).not.toHaveBeenCalled()
  })

  it('rejects cross-origin provisioning', async () => {
    const api = { provisionStatus: vi.fn(), provision: vi.fn(), runtimeStatus: vi.fn() }
    const res = response()
    await handleProvisionRequest({ method: 'POST', headers: { origin: 'https://attacker.example', host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } } as any, res as any, api as any)
    expect(res.statusCode).toBe(403)
    expect(api.provision).not.toHaveBeenCalled()
  })

  it('rejects mutations addressed through a non-loopback Host', async () => {
    const api = { provisionStatus: vi.fn(), provision: vi.fn(), runtimeStatus: vi.fn() }
    const res = response()
    await handleProvisionRequest({ method: 'POST', headers: { origin: 'https://attacker.example', host: 'attacker.example' }, socket: { remoteAddress: '127.0.0.1' } } as any, res as any, api as any)
    expect(res.statusCode).toBe(403)
    expect(api.provision).not.toHaveBeenCalled()
  })
})
