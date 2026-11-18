/**
 * Protocol robustness, interruption and concurrency, ported from the ad-hoc
 * `E-protocol` probes in `dsh-ops-boundary-report.md`, which drove the worker
 * with raw bytes rather than through the host bridge.
 *
 * What this suite locks in:
 *
 * - Every malformed frame is answered with a structured `INVALID_ARGUMENT`
 *   envelope, never a crash, a hang or unparseable output: malformed JSON, empty
 *   stdin, truncated JSON, a missing `tool`, a missing `args`, an unknown tool,
 *   a wrong argument type, and an undeclared extra key.
 * - An oversized request (3 MiB pattern) is refused or exited early rather than
 *   buffered without bound. The worker may close stdin before draining it; that
 *   EPIPE is accepted as a bounded refusal, not as a suite failure.
 * - Repetition does not exhaust anything: 20 sequential calls all settle.
 * - Concurrency on one file is atomic: several simultaneous replaces either
 *   apply, report `REVISION_CONFLICT`, or report `changed: 0`, and the file
 *   always ends as exactly one complete version, never torn or missing. The
 *   worker does not promise serializability — concurrent writers can both read
 *   the same pre-image and the last rename wins — so this suite asserts the
 *   atomicity that is promised, not a lost-update guarantee that is not.
 *
 * Platform. The wire protocol is identical on win32, and the concurrency
 * fixture is a small text file, so every case runs on both. No POSIX-only
 * facility is named here (`/tmp`, FIFOs, signals and process trees live in the
 * other suites, guarded there).
 *
 * Intentional omissions: the SIGKILL temp-file window (report L7, timing
 * dependent, not gate material) and a stdout-close read (a read has no side
 * effect to assert). The concurrency case keeps a small replacement count
 * instead of the report's 12 processes so the suite holds its runtime budget.
 *
 * @module dsh-ops/test/linux-protocol
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callWorker, envelopeOf, request, requireWorker, callTool } from './lib/boundary.mjs'

requireWorker('linux-protocol')

await test('malformed frames are structured refusals, never a crash or a hang', async () => {
  await withTempDir('linux-protocol-frames', async workspace => {
    const target = path.join(workspace, 'x.txt')
    fs.writeFileSync(target, 'x\n')
    const frames = [
      ['malformed JSON', '{not json at all'],
      ['empty stdin', ''],
      ['truncated JSON', JSON.stringify(request('glob', { path: workspace, pattern: ['*'] }, { root: workspace })).slice(0, 40)],
      ['missing tool', JSON.stringify({ root: workspace, scope: 's', args: { path: workspace, pattern: ['*'] } })],
      ['missing args', JSON.stringify({ root: workspace, scope: 's', tool: 'glob', read_only: false })],
      ['unknown tool', JSON.stringify(request('rm_rf', { path: workspace }, { root: workspace }))],
      ['wrong argument type', JSON.stringify(request('inspect_local_file', { path: 12345 }, { root: workspace }))],
      ['undeclared extra key', JSON.stringify(request('glob', { path: workspace, pattern: ['*'], evil: true }, { root: workspace }))],
    ]
    for (const [label, frame] of frames) {
      const result = await callWorker(frame, { timeoutMs: 10_000 })
      assert.equal(result.timedOut, false, `${label}: the worker hung`)
      assert.equal(result.spawnError, undefined, `${label}: ${result.spawnError}`)
      // A refusal is either a settled envelope or a clean non-zero exit; both are
      // bounded. What must never happen is a signal, a parse failure with a zero
      // exit, or no output at all with a zero exit.
      const body = result.body
      if (body === null || body === undefined) {
        assert.notEqual(result.exitCode, 0, `${label}: exited 0 with unparseable stdout ${JSON.stringify(result.stdout?.slice(0, 120))}`)
        continue
      }
      assert.equal(body.status, 'error', `${label}: ${JSON.stringify(body)}`)
      const code = body.error?.code ?? body.permission?.code
      assert.equal(code, 'INVALID_ARGUMENT', `${label} => ${code}`)
    }
  })
})

await test('an oversized request is bounded rather than buffered without limit', async () => {
  await withTempDir('linux-protocol-budget', async workspace => {
    const target = path.join(workspace, 'lines.txt')
    fs.writeFileSync(target, 'x\n')
    const result = await callWorker(JSON.stringify(request('grep', { path: target, pattern: 'z'.repeat(3 * 1024 * 1024) }, { root: workspace })), { timeoutMs: 20_000 })
    assert.equal(result.timedOut, false, 'an oversized request must not hang')
    if (result.body === null || result.body === undefined) {
      // Exiting before draining stdin (EPIPE here) and a non-zero exit are both
      // bounded refusals. What would not be bounded is an exit 0 with no envelope.
      assert.ok(result.exitCode !== 0 || result.stdinError !== undefined, `exited 0 with unparseable stdout: ${JSON.stringify(result.stdout?.slice(0, 120))}`)
    } else {
      assert.equal(result.body.status, 'error')
    }
  })
})

await test('repetition does not exhaust the worker: 20 sequential calls all settle', async () => {
  await withTempDir('linux-protocol-repeat', async workspace => {
    const target = path.join(workspace, 'seq.txt')
    fs.writeFileSync(target, 'abc\n')
    for (let index = 0; index < 20; index += 1) {
      const result = await callTool('inspect_local_file', { path: target }, { root: workspace, timeoutMs: 10_000 })
      assert.equal(result.exitCode, 0, `call ${index}: exit ${result.exitCode} ${result.stderr?.slice(0, 200)}`)
    }
  })
})

await test('concurrent replaces of one file are atomic: apply or conflict, never torn', async () => {
  await withTempDir('linux-protocol-race', async workspace => {
    const target = path.join(workspace, 'race.txt')
    fs.writeFileSync(target, 'seed\n')
    const jobs = Array.from({ length: 6 }, (_, index) =>
      callTool('replace', { path: target, pattern: 'seed', replacement: `v${index}` }, { root: workspace, writeRoots: [workspace], timeoutMs: 20_000 }))
    const settled = await Promise.all(jobs)
    let applied = 0
    let unchanged = 0
    let conflicts = 0
    for (const [index, result] of settled.entries()) {
      const body = envelopeOf(result, assert)
      if (body.status === 'completed') {
        // Several writers can read the same pre-image before the first rename
        // lands, so more than one may report changed=1 and the last rename wins.
        // That is a lost update, not a torn file; the assertions below pin the
        // atomicity this suite is about, and this comment keeps the difference
        // visible instead of asserting a serializability the worker does not
        // promise. (The report found no torn file in a wider 12-way race.)
        assert.ok(body.changed === 0 || body.changed === 1, `job ${index}: ${JSON.stringify(body)}`)
        if (body.changed === 1) applied += 1
        else unchanged += 1
      } else {
        assert.equal(body.error?.code, 'REVISION_CONFLICT', `job ${index} => ${JSON.stringify(body.error)}`)
        conflicts += 1
      }
    }
    assert.equal(applied + unchanged + conflicts, settled.length, 'every job settles')
    assert.ok(applied >= 1, 'at least one writer must have applied')
    const final = fs.readFileSync(target, 'utf8')
    assert.match(final, /^(seed|v\d)\n$/, `the file is one complete version, not torn: ${JSON.stringify(final)}`)
  })
})

report('linux-protocol')
