/**
 * The request handling every private route shares: the fence in front of the
 * user's own data, the method check, the bounded body read and the JSON answer.
 */
import type { DshContext, DshRequest, DshResponse } from './dsh'

/**
 * Why a request to a route reading the user's own data must be refused, or
 * undefined when it may proceed.
 *
 * `webServer.register()` hands a plugin route raw requests: the host's own
 * `/api` sits behind a Host/Origin fence and the browser-session cookie, but
 * nothing puts a plugin route there, and these routes read the OS user and the
 * reader's files. So they borrow the host's own check,
 * `connection.requestRejection()` — the fence and authentication `/api`
 * applies. The browser passes it with a same-origin request that carries the
 * session cookie; the desktop shell passes it because it forwards to a loopback
 * Host, drops the page's Origin and attaches the cookie itself. A host without
 * that service cannot authenticate anyone, so the stand-in below serves
 * loopback only: a peer on the loopback interface, a loopback Host (which also
 * defeats DNS rebinding), no cross-site marker, and an Origin, when sent,
 * naming that Host. The peer address is the part of the request the caller
 * cannot write, so it is the one that has to hold.
 *
 * @param ctx - host plugin context.
 * @param req - node request.
 * @returns 401 / 403, or undefined when the request may proceed.
 */
export function refusalOf(ctx: DshContext, req: DshRequest) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req)
  if (!isLoopbackPeer(req.socket.remoteAddress)) return 403
  const host = req.headers.host
  if (host !== undefined) {
    // A Host header that is no host name at all is refused.
    if (!URL.canParse(`http://${host}`)) return 403
    const name = new URL(`http://${host}`).hostname
    if (name !== 'localhost' && name !== '[::1]' && !/^127\.\d+\.\d+\.\d+$/.test(name)) return 403
  }
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 403
  const origin = req.headers.origin
  if (origin === undefined) return undefined
  if (!URL.canParse(origin)) return 403
  return new URL(origin).host === host ? undefined : 403
}

/**
 * Whether a socket address is this machine: IPv4 `127/8`, IPv6 `::1`, or the
 * IPv4-mapped spelling Node reports for a v4 peer on a dual-stack socket.
 */
function isLoopbackPeer(address: string | undefined) {
  if (address === undefined) return false
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return plain === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain)
}

/** Send one JSON response. */
export function sendJson(res: DshResponse, status: number, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Answer 405 for a request whose method the route does not take.
 * @returns whether the request was turned away.
 */
export function methodRefused(req: DshRequest, res: DshResponse, methods: string[]) {
  if (req.method !== undefined && methods.includes(req.method)) return false
  res.writeHead(405, { allow: methods.join(', ') })
  res.end()
  return true
}

/**
 * The fence every route that reads the user's own data runs first: the
 * host's own check where that service exists, the loopback stand-in
 * otherwise (see refusalOf).
 * @returns whether the request was turned away.
 */
export function fenceRefused(ctx: DshContext, req: DshRequest, res: DshResponse) {
  const refused = refusalOf(ctx, req)
  if (refused === undefined) return false
  sendJson(res, refused, { ok: false, error: refused === 401 ? 'unauthorized' : 'forbidden' })
  return true
}

/**
 * One bounded request body, or null when it is oversized or unreadable.
 *
 * Over the limit the rest of the body is dropped and the promise answers null:
 * the answer (400 / 413) still has to reach the client, so the socket is not
 * cut here — the caller ends it once the answer has gone out.
 */
export function readRequestBody(req: DshRequest, limit: number): Promise<Buffer | null> {
  return new Promise<Buffer | null>((settle) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer | string) => {
      if (over) return
      size += chunk.length
      if (size > limit) {
        over = true
        settle(null)
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => { if (!over) settle(Buffer.concat(chunks)) })
    req.on('error', () => { if (!over) settle(null) })
  })
}
