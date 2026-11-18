/**
 * Downloads: HTTP(S) with an optional CONNECT proxy, and the pin downloader.
 *
 * A configured proxy is used for every request: a direct connection that
 * happens to work would be a silent bypass of the proxy the environment
 * requires. Nothing here is imported for its side effects.
 *
 * @module dsh-ops/build/lib/download
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import tls from 'node:tls'
import { log, sha256File, size, writeJson } from './util.js'

/**
 * The proxy to tunnel downloads through, when the environment names one.
 * @param {string|undefined} explicit - `--proxy`, when given.
 * @param {boolean} disabled - `--no-proxy`, when given.
 * @returns {{host: string, port: number, authorization?: string}|undefined} the proxy.
 */
export function resolveProxy(explicit, disabled) {
  if (disabled) return undefined
  const raw = explicit ?? process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? ''
  if (raw.trim() === '') return undefined
  const url = new URL(raw)
  return {
    host: url.hostname,
    port: Number(url.port === '' ? 8080 : url.port),
    ...url.username === ''
      ? {}
      : { authorization: `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}` },
  }
}

/**
 * Open one HTTP(S) response, following redirects, through the proxy when there is one.
 *
 * A configured proxy is used for every request: a direct connection that
 * happens to work would be a silent bypass of the proxy the environment
 * requires. HTTPS goes through a CONNECT tunnel whose socket is handed to
 * `http.request` (which does not add TLS of its own), so a redirect to another
 * host re-tunnels rather than reusing the first socket.
 *
 * @param {string} url - the URL to fetch.
 * @param {{host: string, port: number, authorization?: string}|undefined} proxy - the proxy.
 * @param {number} redirectsLeft - how many redirects remain.
 * @returns {Promise<{stream: NodeJS.ReadableStream, url: string}>} the response body.
 */
export function openResponse(url, proxy, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const secure = target.protocol === 'https:'
    const port = Number(target.port === '' ? (secure ? 443 : 80) : target.port)
    const headers = {
      host: target.host,
      'user-agent': 'dsh-ops-release-script',
      accept: '*/*',
      'accept-encoding': 'identity',
    }
    /**
     * Handle one response: follow it, or resolve with the body.
     * @param {http.IncomingMessage} response - the response.
     * @returns {void}
     */
    const onResponse = (response) => {
      const code = response.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(code)) {
        response.resume()
        if (redirectsLeft <= 0) {
          reject(new Error(`${url} redirected more than the allowed number of times`))
          return
        }
        const next = new URL(response.headers.location ?? '', url).toString()
        openResponse(next, proxy, redirectsLeft - 1).then(resolve, reject)
        return
      }
      if (code !== 200) {
        response.resume()
        reject(new Error(`${url} answered HTTP ${code}`))
        return
      }
      resolve({ stream: response, url })
    }

    /**
     * Send the plain GET over an already-secured (or plain) socket.
     * @param {import('node:net').Socket} socket - the tunnel socket.
     * @returns {void}
     */
    const send = (socket) => {
      const request = http.request(
        {
          host: target.hostname,
          port,
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers,
          createConnection: () => socket,
        },
        onResponse,
      )
      request.on('error', reject)
      request.end()
    }

    if (proxy === undefined) {
      const request = (secure ? https : http).request(
        { host: target.hostname, port, method: 'GET', path: `${target.pathname}${target.search}`, headers },
        onResponse,
      )
      request.on('error', reject)
      request.end()
      return
    }

    const connect = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: {
        host: `${target.hostname}:${port}`,
        ...proxy.authorization === undefined ? {} : { 'proxy-authorization': proxy.authorization },
      },
    })
    connect.on('error', (error) => reject(new Error(`proxy ${proxy.host}:${proxy.port} failed: ${String(error.message ?? error)}`)))
    connect.on('connect', (response, socket) => {
      if ((response.statusCode ?? 0) !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT ${target.hostname}:${port} answered HTTP ${String(response.statusCode)}`))
        return
      }
      if (!secure) {
        send(socket)
        return
      }
      const secured = tls.connect({ socket, servername: target.hostname })
      secured.once('secureConnect', () => send(secured))
      secured.once('error', (error) => reject(new Error(`TLS to ${target.hostname} failed: ${String(error.message ?? error)}`)))
    })
    connect.end()
  })
}

/**
 * Download one URL to a file, returning the byte count and digest.
 * @param {string} url - the URL.
 * @param {string} destination - where to write it.
 * @param {object} options - download options.
 * @param {{host: string, port: number, authorization?: string}|undefined} options.proxy - the proxy.
 * @param {number} options.expectedBytes - the size the upstream release reports.
 * @returns {Promise<{bytes: number, sha256: string}>} the facts about what arrived.
 */
export async function download(url, destination, { proxy, expectedBytes }) {
  const partial = `${destination}.part`
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.rmSync(partial, { force: true })
  const { stream } = await openResponse(url, proxy, 5)
  const hash = crypto.createHash('sha256')
  let bytes = 0
  let reported = 0
  const output = fs.createWriteStream(partial)
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      hash.update(chunk)
      bytes += chunk.length
      if (bytes - reported >= 32 * 1024 * 1024) {
        reported = bytes
        log('fetch', `  ... ${size(bytes)}`)
      }
    })
    stream.on('error', reject)
    output.on('error', reject)
    output.on('finish', resolve)
    stream.pipe(output)
  })
  if (expectedBytes !== undefined && bytes !== expectedBytes) {
    fs.rmSync(partial, { force: true })
    throw new Error(`${url} delivered ${bytes} bytes, but the pin records ${expectedBytes}`)
  }
  fs.rmSync(destination, { force: true })
  fs.renameSync(partial, destination)
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * Download the pinned upstream assets, verifying each against its pin.
 * @param {object} context - the run context.
 * @param {object} options - what to do with them.
 * @param {boolean} options.keep - keep the archives on disk, or delete them again.
 * @returns {Promise<object[]>} one verdict per pinned asset.
 */
export async function downloadPins(context, { keep }) {
  const directory = path.join(context.dist, 'downloads')
  fs.mkdirSync(directory, { recursive: true })
  const verdicts = []
  for (const pkg of context.packages) {
    if (pkg.payload.type !== 'archive') continue
    const pin = pkg.payload.pin
    const file = path.join(directory, pin.assetName)
    let digest = null
    let bytes = null
    if (!context.force && fs.existsSync(file)) {
      digest = await sha256File(file)
      bytes = fs.statSync(file).size
      log('fetch', `reusing ${pin.assetName} (${bytes} bytes, sha256 ${digest})`)
    } else {
      log('fetch', `downloading ${pin.assetUrl}`)
      const result = await download(pin.assetUrl, file, { proxy: context.proxy, expectedBytes: pin.assetBytes })
      digest = result.sha256
      bytes = result.bytes
      log('fetch', `downloaded ${pin.assetName} (${bytes} bytes, sha256 ${digest})`)
    }
    const matches = digest === pin.assetSha256 && bytes === pin.assetBytes
    verdicts.push({ package: pkg.name, pin, file, digest, bytes, matches })
    if (!matches) {
      throw new Error(`${pin.assetName} does not match its pin: expected sha256 ${pin.assetSha256} and `
        + `${pin.assetBytes} bytes, got sha256 ${digest} and ${bytes} bytes`)
    }
    log(keep ? 'fetch' : 'verify-upstream', `${pin.assetName} matches its pin (sha256 ${digest}, ${bytes} bytes)`)
    if (!keep) {
      fs.rmSync(file, { force: true })
      log('verify-upstream', `deleted ${pin.assetName}; this pipeline keeps no upstream bytes`)
    }
  }
  if (keep) {
    writeJson(path.join(directory, 'sources.json'), {
      verifiedAt: new Date().toISOString(),
      assets: verdicts.map((verdict) => ({
        package: verdict.package,
        url: verdict.pin.assetUrl,
        file: verdict.pin.assetName,
        sha256: verdict.digest,
        bytes: verdict.bytes,
        matchesPin: verdict.matches,
      })),
    })
  }
  return verdicts
}
