import type { IncomingMessage, ServerResponse } from 'node:http'

export const PROVISION_PATH = '/dsh-feishu/provision'

/**
 * The two channel facts with no native configuration equivalent: the live
 * provisioning state and the Feishu connection state. Both ride the plugin's
 * single bounded HTTP route; every settings/credential write goes through the
 * native form and credentials services instead.
 */
export interface ProvisionApiLike {
  provision(): unknown
  provisionStatus(): unknown
  runtimeStatus(): unknown
}

export async function handleProvisionRequest(req: IncomingMessage, res: ServerResponse, api: ProvisionApiLike): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: 'DSH Lark provisioning is available only from localhost' })
  try {
    if (req.method === 'GET') return send(res, 200, { runtime: api.runtimeStatus(), provision: api.provisionStatus() })
    if (req.method === 'POST' && !isSameOrigin(req)) {
      // Echo the two headers back: the card shows this line, and "untrusted
      // origin" alone left an operator on Windows with nothing to report.
      return send(res, 403, {
        error: `untrusted origin (origin=${String(req.headers.origin ?? 'absent')} host=${String(req.headers.host ?? 'absent')})`,
      })
    }
    if (req.method === 'POST') return send(res, 200, { runtime: api.runtimeStatus(), provision: api.provision() })
    res.setHeader('allow', 'GET, POST')
    send(res, 405, { error: 'method not allowed' })
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

function isLoopback(address?: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** The desktop shell's application origin (`SCHEME://app` in its main process). */
const DESKTOP_APP_ORIGIN = 'dsh-app://app'

/** Whether a `Host` header names this machine's loopback authority. */
function isLoopbackAuthority(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase()
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Whether a mutation comes from the page that is allowed to start provisioning.
 *
 * Three accepted shapes, all of them same-machine (the socket check ran first):
 *
 * 1. A normal browser request: `Origin` and `Host` name the same loopback
 *    authority.
 * 2. The DSH desktop shell: it proxies the application origin's requests to the
 *    Host and **strips `origin`/`host`/`cookie`/`sec-fetch-*`** on the way
 *    (`apps/desktop/src/web-document.ts`), so a POST it forwards has no
 *    `Origin` at all. Every browser sends one for POST, so "absent" identifies
 *    the shell rather than a web page — this is what made the scan button show
 *    "untrusted origin" on Windows, where the desktop app is the common shell.
 * 3. The desktop origin itself, should a future shell forward it unmodified.
 *
 * Everything else is refused, including a POST addressed through a foreign
 * `Host` (a DNS-rebinding shape regardless of `Origin`) and a browser request
 * whose `Sec-Fetch-Site` says cross-site.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || !isLoopbackAuthority(host)) return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (origin === DESKTOP_APP_ORIGIN) return true
  try {
    const originUrl = new URL(origin)
    return originUrl.protocol.startsWith('http') && originUrl.host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}
