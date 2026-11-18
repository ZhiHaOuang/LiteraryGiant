/**
 * `dsh-ops panel`: serve the shipped viewer and one capture directory on the
 * loopback interface.
 *
 * The viewer itself stays a static page that inlines no data. Opening it from
 * `file://` requires dragging a report in because browsers refuse same-directory
 * `fetch`; this command exists so the ordinary path is one command instead of a
 * drag or a hand-written static server. It serves:
 *
 * - `/` → the viewer, with the newest valid report selected;
 * - `/panel.html` → the viewer shipped in this package (never a stale copy in
 *   the capture directory);
 * - `/api/sessions` → the valid reports in the directory, for the page's
 *   session picker;
 * - `/<sessionId>.json` → one report in that directory.
 *
 * It binds `127.0.0.1` only, reads only the named directory, refuses to follow a
 * path or symlink outside it, and never writes anything. Reports that do not
 * parse as panel documents are skipped with their reason instead of making the
 * newest valid report unusable.
 *
 * @module dsh-ops/cli/panel
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { PANEL_FORMAT } from '../panel/collect.js'
import { renderPanelHtml } from '../panel/render.js'

/** The only interface this command binds. */
export const PANEL_SERVE_HOST = '127.0.0.1'
/** A report file name this server will serve; it cannot contain a separator. */
const REPORT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/
/** A session id as the collector accepts it; used to name a file-less fallback. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** One valid report found in a capture directory. */
export interface PanelSession {
  /** File name inside the capture directory. */
  file: string
  /** Session id from the document's `meta`, or the file name without `.json`. */
  sessionId: string
  /** File modification time, milliseconds since the epoch. */
  mtimeMs: number
  /** File size in bytes. */
  bytes: number
}

/** The parsed state of one capture directory. */
export interface PanelDirectory {
  /** Absolute capture directory. */
  dir: string
  /** Valid reports, newest first. */
  sessions: PanelSession[]
  /** Files that look like reports but are not valid panel documents. */
  invalid: { file: string, reason: string }[]
  /** The newest valid report, when there is one. */
  latest?: PanelSession
}

/** The report index the viewer fetches from a live server. */
export interface PanelSessionIndex {
  sessions: PanelSession[]
  latest: PanelSession['file'] | null
  invalid: { file: string, reason: string }[]
}

/** Options for {@link commandPanel}. */
export interface PanelCommandOptions {
  /** Capture directory; defaults to `<cwd>/.dsh-ops/panel`. */
  dir?: string
  /** Loopback port; 0 (default) lets the kernel choose one. */
  port?: number
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

/**
 * The capture directory used when the command line names none.
 * @param {string} [cwd] - the working directory to anchor it to.
 * @returns {string} the absolute default path.
 */
export function defaultPanelDirectory(cwd = process.cwd()): string {
  return path.join(path.resolve(cwd), '.dsh-ops', 'panel')
}

/** Whether one parsed document is a panel report this viewer understands. */
function panelDocument(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.format === PANEL_FORMAT && record.schemaVersion === 1
}

/**
 * Read one capture directory without changing it: valid reports, their order,
 * and the files that look like reports but cannot be used.
 * @param {string} [raw] - the directory to inspect; defaults to {@link defaultPanelDirectory}.
 * @returns {PanelDirectory} what the directory currently holds.
 * @throws {Error} when the directory is absent, unreadable, or not a directory.
 */
export function inspectPanelDirectory(raw?: string): PanelDirectory {
  const dir = path.resolve(raw ?? defaultPanelDirectory())
  let stat
  try {
    stat = fs.statSync(dir)
  } catch (error) {
    throw new Error(`No panel capture directory at ${dir} (${errorMessage(error)}). Enable the dsh-ops/panel row and run a session in this workspace, or pass the capture directory explicitly: dsh-ops panel <dir>`)
  }
  if (!stat.isDirectory()) throw new Error(`The panel capture path is not a directory: ${dir}`)
  const sessions: PanelSession[] = []
  const invalid: PanelDirectory['invalid'] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !REPORT_FILE.test(entry.name)) continue
    const file = path.join(dir, entry.name)
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!panelDocument(value)) throw new Error(`not a ${PANEL_FORMAT} document`)
      const meta = value.meta !== null && typeof value.meta === 'object' && !Array.isArray(value.meta)
        ? value.meta as Record<string, unknown> : undefined
      const id = typeof meta?.sessionId === 'string' && SESSION_ID.test(meta.sessionId)
        ? meta.sessionId : entry.name.slice(0, -'.json'.length)
      const size = fs.statSync(file).size
      sessions.push({ file: entry.name, sessionId: id, mtimeMs: statMtimeMs(file), bytes: size })
    } catch (error) {
      invalid.push({ file: entry.name, reason: errorMessage(error) })
    }
  }
  sessions.sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file))
  return { dir, sessions, invalid, ...(sessions.length > 0 ? { latest: sessions[0] } : {}) }
}

/** Modification time as a stable number, or 0 when it cannot be read. */
function statMtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch { return 0 }
}

/** The JSON index the page fetches for its session picker. */
export function sessionIndex(directory: PanelDirectory): PanelSessionIndex {
  return { sessions: directory.sessions, latest: directory.latest?.file ?? null, invalid: directory.invalid }
}

/** Send one body with the headers every response here carries. */
function send(response: http.ServerResponse, status: number, contentType: string, body: string | Buffer, headOnly = false): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (headOnly) { response.end(); return }
  response.end(body)
}

const sendText = (response: http.ServerResponse, status: number, body: string) =>
  send(response, status, 'text/plain; charset=utf-8', `${body}\n`)

/** Resolve one report path inside `root`, refusing every path or symlink that leaves it. */
function reportPath(root: string, name: string): string | undefined {
  if (!REPORT_FILE.test(name)) return undefined
  const target = path.resolve(root, name)
  if (target !== root && !target.startsWith(root + path.sep)) return undefined
  try {
    const realRoot = fs.realpathSync(root)
    const realTarget = fs.realpathSync(target)
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return undefined
    if (!fs.statSync(realTarget).isFile()) return undefined
    return realTarget
  } catch { return undefined }
}

/** A report index for one request, with the read race reported as JSON rather than a crash. */
function sendIndex(response: http.ServerResponse, dir: string, headOnly: boolean): void {
  try {
    send(response, 200, 'application/json; charset=utf-8', JSON.stringify(sessionIndex(inspectPanelDirectory(dir))), headOnly)
  } catch (error) {
    send(response, 500, 'application/json; charset=utf-8', JSON.stringify({ error: errorMessage(error) }), headOnly)
  }
}

/**
 * Create the read-only server for one capture directory. It starts listening
 * only when the caller calls `listen`; {@link listenPanel} is the helper.
 * @param {object} options - the directory to serve.
 * @param {string} options.dir - absolute or relative capture directory.
 * @returns {http.Server} the server, not listening yet.
 * @throws {Error} when the directory is missing or not a directory.
 */
export function createPanelServer({ dir }: { dir: string }): http.Server {
  if (typeof dir !== 'string' || dir === '') throw new Error('createPanelServer needs a capture directory')
  const root = path.resolve(dir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a panel capture directory: ${root}`)
  return http.createServer((request, response) => {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('method not allowed: this server is read-only\n')
      return
    }
    const headOnly = method === 'HEAD'
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${PANEL_SERVE_HOST}`).pathname)
    } catch {
      sendText(response, 400, 'bad request target')
      return
    }
    if (pathname.includes('\0')) { sendText(response, 400, 'bad path'); return }
    if (pathname === '/') {
      let index: PanelDirectory
      try { index = inspectPanelDirectory(root) } catch { index = { dir: root, sessions: [], invalid: [] } }
      const target = index.latest === undefined ? '/panel.html' : `/panel.html?data=${encodeURIComponent(index.latest.file)}`
      response.writeHead(302, { Location: target, 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    if (pathname === '/panel.html') {
      let html: string
      try { html = renderPanelHtml() } catch (error) {
        sendText(response, 500, `the shipped panel viewer is missing: ${errorMessage(error)}`)
        return
      }
      send(response, 200, 'text/html; charset=utf-8', html, headOnly)
      return
    }
    if (pathname === '/api/sessions') { sendIndex(response, root, headOnly); return }
    const name = pathname.startsWith('/') ? pathname.slice(1) : pathname
    const file = reportPath(root, name)
    if (file === undefined) {
      // A missing report and an attempted traversal are both "no such file here":
      // the response never confirms what exists outside the served directory.
      sendText(response, pathname.includes('..') ? 403 : 404, pathname.includes('..') ? 'refused: outside the served directory' : `not in this capture directory: ${pathname}`)
      return
    }
    let body: Buffer
    try { body = fs.readFileSync(file) } catch (error) {
      sendText(response, 404, `not readable: ${errorMessage(error)}`)
      return
    }
    let value: unknown
    try { value = JSON.parse(body.toString('utf8')) } catch (error) {
      sendText(response, 422, `not a valid panel report: ${errorMessage(error)}`)
      return
    }
    if (!panelDocument(value)) {
      sendText(response, 422, `not a valid ${PANEL_FORMAT} report`)
      return
    }
    send(response, 200, 'application/json; charset=utf-8', body, headOnly)
  })
}

/**
 * Listen on loopback and report the port the kernel chose (`0` = ephemeral).
 * @param {http.Server} server - the server from {@link createPanelServer}.
 * @param {{host?: string, port?: number}} [options] - interface and port; the host is loopback by contract.
 * @returns {Promise<number>} the bound port.
 */
export async function listenPanel(server: http.Server, { host = PANEL_SERVE_HOST, port = 0 }: { host?: string, port?: number } = {}): Promise<number> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be an integer from 0 to 65535, got ${port}`)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('error', onError); reject(error) }
    server.once('error', onError)
    server.listen({ host, port }, () => { server.off('error', onError); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the panel server did not report a TCP address')
  return address.port
}

/**
 * `dsh-ops panel`: print the loopback URL and serve until the process is stopped.
 * A directory without a report is still served: the page keeps its drag/select
 * flow, and the command says why it is empty instead of failing.
 * @param {PanelCommandOptions} [options] - directory and port.
 * @returns {Promise<number>} never resolves while the server is running; rejects when it cannot start.
 */
export async function commandPanel({ dir, port }: PanelCommandOptions = {}): Promise<number> {
  const index = inspectPanelDirectory(dir)
  if (index.sessions.length === 0) {
    console.log(`dsh-ops panel: no valid session report in ${index.dir} yet; serving the empty viewer. Enable capture and run a session, or drop a JSON onto the page.`)
  }
  if (index.invalid.length > 0) {
    console.log(`dsh-ops panel: skipped ${index.invalid.length} file(s) that are not panel documents: ${index.invalid.map(entry => entry.file).join(', ')}`)
  }
  const server = createPanelServer({ dir: index.dir })
  let bound: number
  try {
    bound = await listenPanel(server, { port })
  } catch (error) {
    server.close()
    throw new Error(`cannot listen on ${PANEL_SERVE_HOST}:${port ?? 0}: ${errorMessage(error)}`)
  }
  console.log(`dsh-ops panel: serving ${index.dir}`)
  console.log(index.latest === undefined ? 'Default session: (none yet)' : `Default session: ${index.latest.file}`)
  console.log(`  http://${PANEL_SERVE_HOST}:${bound}/`)
  console.log('Loopback only; reads the capture directory and writes nothing. Press Ctrl+C to stop.')
  await new Promise<void>(() => { /* the listening server keeps the process alive */ })
  return 0
}
