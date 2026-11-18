/**
 * One native-worker boundary call, shared by the `linux-*.test.mjs` suites.
 *
 * The boundary suites drive the shipped worker directly rather than through
 * `lib/file/worker.js`, because their subject is the worker's own edge
 * behaviour — the exact refusal code, the exact envelope fields, the exact
 * bytes on stdout — and the host bridge would rewrite several of those into
 * its own policy vocabulary. `test/permissions.test.mjs` covers the host lane.
 *
 * The worker is chosen exactly as `test/ptc.test.mjs` chooses it, so a checkout
 * runs against its own build and an explicit `DSH_OPS_WORKER_BIN` still wins.
 * A suite that needs the worker resolves it at load time and calls `skipSuite`
 * when it is absent, which is what lets `DSH_OPS_REQUIRE_RUNTIME=1` turn "this
 * machine has no native build" into a gate failure instead of a green pass.
 *
 * @module dsh-ops/test/lib/boundary
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { PACKAGE_ROOT, skipSuite } from './harness.mjs'

/** The worker under test, resolved the way `test/ptc.test.mjs` resolves it. */
export const WORKER = process.env.DSH_OPS_WORKER_BIN
  ?? path.resolve(PACKAGE_ROOT, 'native', 'target', 'release', process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker')

/**
 * Refuse to run at all without the native worker, visibly.
 *
 * A skip is not a pass: `test/run.mjs` counts it apart, and
 * `DSH_OPS_REQUIRE_RUNTIME=1` turns it into a failure at both layers.
 * @param {string} label - the suite label used in the summary.
 * @returns {void}
 */
export function requireWorker(label) {
  if (!fs.existsSync(WORKER)) skipSuite(label, `no native worker at ${path.relative(PACKAGE_ROOT, WORKER)}; run npm run build:ptc`)
}

/** The transient worker request appended to raw payloads. */
const DEFAULT_WORKSPACE = { root: process.cwd(), scope: 'boundary' }

/**
 * Spawn the worker once and collect everything it did.
 *
 * Never throws: a spawn error, an exit before stdin is drained (EPIPE), a
 * timeout and malformed stdout are all data. The returned `body` is the parsed
 * JSON envelope when there is one, else `null`.
 * @param {string} input - the exact bytes to write to stdin.
 * @param {object} [options] - call inputs.
 * @param {number} [options.timeoutMs] - how long to wait before killing it.
 * @returns {Promise<object>} the call facts.
 */
export function callWorker(input, { timeoutMs = 20_000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now()
    let child
    try {
      child = spawn(WORKER, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ spawnError: String(error?.message ?? error), elapsedMs: Date.now() - started })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ elapsedMs: Date.now() - started, stdout, stderr, timedOut, ...value })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
      finish({ exitCode: null, signal: 'SIGKILL' })
    }, timeoutMs)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => finish({ spawnError: String(error?.message ?? error) }))
    // The worker exits before draining stdin when it refuses an oversized
    // request, which surfaces here as EPIPE. That is data, not a harness crash.
    child.stdin.on('error', error => finish({ stdinError: error?.code ?? String(error) }))
    child.on('close', (exitCode, signal) => {
      let body = null
      let parseError = null
      try { body = JSON.parse(stdout) } catch (error) { parseError = String(error?.message ?? error) }
      finish({ exitCode, signal, body, parseError })
    })
    try { child.stdin.end(input) } catch (error) { finish({ spawnError: String(error?.message ?? error) }) }
  })
}

/**
 * Build an explicit legacy v0 payload for worker boundary and compatibility tests.
 * Current host bridges wrap this payload in the versioned transport envelope.
 * @param {string} tool - the tool name.
 * @param {object} args - the tool arguments.
 * @param {object} [options] - transient request fields.
 * @param {string} [options.root] - the session root.
 * @param {string} [options.scope] - the session id.
 * @param {boolean} [options.readOnly] - set `read_only`.
 * @param {string[]} [options.writeRoots] - set `write_roots` when present; an
 *   empty array is meaningful (it means "no write root at all"), so presence is
 *   tested against `undefined` rather than truthiness.
 * @returns {object} the request object.
 */
export function request(tool, args, { root, scope = 'boundary', readOnly = false, writeRoots } = {}) {
  return {
    root: root ?? DEFAULT_WORKSPACE.root,
    scope,
    tool,
    args,
    read_only: readOnly,
    ...(writeRoots === undefined ? {} : { write_roots: writeRoots }),
  }
}

/**
 * Run one tool against the worker and return the call facts.
 * @param {string} tool - the tool name.
 * @param {object} args - the tool arguments.
 * @param {object} [options] - same fields as {@link request}, plus `timeoutMs`.
 * @returns {Promise<object>} the call facts.
 */
export function callTool(tool, args, options = {}) {
  return callWorker(JSON.stringify(request(tool, args, options)), { timeoutMs: options.timeoutMs })
}

/**
 * Assert that a call settled into a real JSON envelope and hand back the body.
 * @param {object} result - a {@link callTool} result.
 * @param {import('node:assert/strict')} assert - the suite's assertion library.
 * @returns {object} the parsed envelope.
 */
export function envelopeOf(result, assert) {
  assert.equal(result.spawnError, undefined, `worker failed to start: ${result.spawnError}`)
  assert.equal(result.timedOut, false, `worker did not answer within the deadline (stdout ${result.stdout?.length ?? 0} bytes)`)
  assert.equal(result.stdinError, undefined, `worker closed stdin early: ${result.stdinError}`)
  assert.equal(result.exitCode, 0, `worker exited ${result.exitCode}: ${result.stderr?.slice(0, 300)}`)
  assert.ok(result.body, `worker stdout was not JSON: ${result.parseError} :: ${result.stdout?.slice(0, 200)}`)
  return result.body
}
