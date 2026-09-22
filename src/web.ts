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
      return send(res, 403, { error: 'untrusted origin' })
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

function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const requestUrl = new URL(`http://${host}`)
    const hostname = requestUrl.hostname.toLowerCase()
    if (hostname !== '127.0.0.1' && hostname !== '[::1]' && hostname !== 'localhost') return false
    return new URL(origin).host === host
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
