/**
 * Serving the files a plugin ships beside its code: one static file per request,
 * and the content-hashed assets a build routed rather than inlined.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import type { DshContext, DshRequest, DshResponse } from './dsh'

/** The build's asset manifest inside the assets directory: which names exist, their type and their storage. */
const ASSETS_MANIFEST = 'manifest.json'

/**
 * @param ctx - host plugin context, for the warning an unreadable manifest leaves.
 * @param packageName - the plugin's name, which prefixes that warning.
 * @param assetsDir - the build output directory holding the routed assets and their manifest.
 */
export function createStaticFiles(ctx: DshContext, packageName: string, assetsDir: string) {
  /** The decompressed payload of each brotli-stored asset served to a client that cannot take it. */
  const unpressed = new Map<string, Buffer>()

  /**
   * Answer one request with a static file.
   * @param res - node response.
   * @param method - request method; HEAD sends headers only.
   * @param path - absolute file to read.
   * @param headers - content-type / cache-control pair for the payload.
   * @param body - the payload, when the caller already holds it.
   */
  function sendFile(res: DshResponse, method: string, path: string, headers: Record<string, string>, body: Buffer | null = null) {
    // An optional file the user never dropped in, or a name no build shipped,
    // is absent: 404.
    if (body === null && !existsSync(path)) {
      res.writeHead(404)
      res.end()
      return
    }
    // Read per request: the files are small, and an in-place edit then shows
    // up on reload without restarting the host.
    const payload = body ?? readFileSync(path)
    res.writeHead(200, {
      ...headers,
      'content-length': String(payload.byteLength),
    })
    res.end(method === 'HEAD' ? undefined : payload)
  }

  /** The build's asset manifest, or undefined when the build has not run. */
  function readManifest() {
    const path = join(assetsDir, ASSETS_MANIFEST)
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(readFileSync(path, 'utf8')).assets
    } catch (error) {
      // A manifest that cannot be read is a build that did not finish; say so
      // once per request and answer 404 rather than failing the route (D12).
      ctx.logger?.warn?.(`${packageName}: lib/assets/${ASSETS_MANIFEST} is unreadable: ${(error as { message?: string } | null)?.message ?? String(error)}`)
      return undefined
    }
  }

  /**
   * Answer one request for a routed asset.
   *
   * The manifest is read per request, like every other file here: the build
   * decides what exists, and a rebuild then shows up without restarting the
   * host. A name the manifest does not carry is a 404 — that is also what
   * keeps the directory unreachable by any other spelling.
   *
   * @param req - node request (its accept-encoding decides the payload).
   * @param res - node response.
   * @param name - the file name from the request path.
   * @returns whether the request was answered.
   */
  function sendAsset(req: DshRequest, res: DshResponse, name: string) {
    const asset = readManifest()?.[name]
    if (asset === undefined) return false
    const stored = join(assetsDir, asset.encoding === 'br' ? `${name}.br` : name)
    const headers = {
      'content-type': asset.type,
      'cache-control': 'public, max-age=31536000, immutable',
    }
    const method = req.method ?? 'GET'
    if (asset.encoding !== 'br') {
      sendFile(res, method, stored, headers)
      return true
    }
    if (/\bbr\b/.test(req.headers['accept-encoding'] ?? '')) {
      sendFile(res, method, stored, { ...headers, 'content-encoding': 'br' })
      return true
    }
    // A client that does not take brotli: the sheet is decompressed, so it
    // is served rather than missing. Cached: the same few sheets are asked
    // for again on every reload of a page that never got them compressed.
    const cached = unpressed.get(name)
    if (cached !== undefined) {
      sendFile(res, method, stored, headers, cached)
      return true
    }
    if (!existsSync(stored)) {
      res.writeHead(404)
      res.end()
      return true
    }
    const body = brotliDecompressSync(readFileSync(stored))
    unpressed.set(name, body)
    sendFile(res, method, stored, headers, body)
    return true
  }

  return { sendFile, sendAsset }
}
