/**
 * The session bash layer's two guards: a bad argument stays a refusal the caller
 * can read, and a relative workdir belongs to the calling session, not to the
 * helper process that evaluates this module (#235, #237).
 *
 * These are unit checks over the real tool definition, its registered output
 * contract, and the session layer's own resolution; the same behaviours run
 * through a real host and the machine's own bash in
 * `test/shells-session.test.mjs`.
 *
 * @module dsh-ops/test/shells-guards
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  bashToolDefinition,
  withBashStatus,
} from '../lib/shells.js'
import { BASH_OUTPUT_SCHEMA } from '../lib/shells/tool.js'
import { BASH_ARGUMENT_ERROR_CODE, BashArgumentError, isBashArgumentError } from '../lib/shells/argument-error.js'
import { bashRefusalValue, sessionWorkdir } from '../lib/session-shells.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { fakeSubprocess, makeExecutable } from './lib/shells-fixtures.mjs'

const signal = () => new AbortController().signal

await test('a bad argument is a typed refusal that names the field (#235)', async () => {
  const { service, specs } = fakeSubprocess()
  const definition = bashToolDefinition({ file: 'bash', source: 'config', subprocess: service })
  const exec = { signal: signal() }
  const cases = [
    [{ command: 'echo hi', graceMs: -1 }, /invalid graceMs: expected a positive finite number, got -1/, 'graceMs'],
    [{ command: 'echo hi', timeoutMs: 0 }, /invalid timeoutMs: expected a positive finite number/, 'timeoutMs'],
    [{ command: 'echo hi', timeoutMs: MAX_BASH_TIMEOUT_MS + 1 }, /invalid timeoutMs: must be no greater than/, 'timeoutMs'],
    [{ command: 'echo hi', includeDiagnostics: 'yes' }, /invalid includeDiagnostics: expected a boolean/, 'includeDiagnostics'],
    [{ command: 'echo hi', description: 5 }, /invalid description: expected a string/, 'description'],
    [{ command: 'echo hi', run_in_background: true }, /unknown key "run_in_background"/, 'run_in_background'],
    [[], /expected an object/, 'arguments'],
    [{}, /exactly one of command or script_path/, 'command'],
    [{ command: 'echo hi', script_path: 'x.sh' }, /exactly one of command or script_path/, 'script_path'],
    [{ command: 'echo hi', workdir: 'definitely-not-a-directory-xyz' }, /invalid workdir: must be an existing directory/, 'workdir'],
  ]
  for (const [args, pattern, argument] of cases) {
    await assert.rejects(() => definition.execute(args, exec), error => {
      assert.ok(error instanceof BashArgumentError, 'expected BashArgumentError, got ' + error?.name + ': ' + error?.message)
      assert.equal(error.code, BASH_ARGUMENT_ERROR_CODE)
      assert.equal(error.argument, argument, error.message)
      assert.match(error.message, pattern)
      return true
    })
  }
  assert.equal(specs.length, 0, 'a refusal must precede the spawn')
  // The type is the contract: a runtime failure is folded into a value, a bad
  // argument is not (#235). The `code` is honoured too, for a refusal that lost
  // its prototype on the way here.
  assert.equal(isBashArgumentError(new Error('runtime failure')), false)
  assert.equal(isBashArgumentError(Object.assign(new Error('gone'), { code: BASH_ARGUMENT_ERROR_CODE })), true)
})

await test('a workdir that is a file is refused by name, never spawned (#237)', async () => {
  await withTempDir('shells-guards-file', async dir => {
    const file = path.join(dir, 'a-file')
    fs.writeFileSync(file, 'placeholder')
    const { service, specs } = fakeSubprocess()
    const definition = bashToolDefinition({ file: path.join(dir, 'bash'), source: 'config', subprocess: service })
    await assert.rejects(() => definition.execute({ command: 'echo hi', workdir: file }, { signal: signal() }), error => {
      assert.ok(error instanceof BashArgumentError, error?.message)
      assert.equal(error.argument, 'workdir')
      assert.ok(error.message.includes(file), error.message)
      return true
    })
    assert.equal(specs.length, 0)
  })
})

await test('an ENOENT names the directory that is actually gone (#180)', async () => {
  await withTempDir('shells-guards-enoent', async dir => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const workdir = path.join(dir, 'workspace')
    fs.mkdirSync(workdir)
    // The race #180 reports: the directory passed the pre-spawn check and was removed before the
    // spawn, so the platform hands back one ENOENT for a gone cwd and a gone executable alike.
    const vanished = { spawn() {
      fs.rmSync(workdir, { recursive: true, force: true })
      throw Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' })
    } }
    const exec = { signal: signal() }
    const missingCwd = await bashToolDefinition({ file: bash, source: 'bundled', subprocess: vanished })
      .execute({ command: 'echo hi', workdir }, exec)
    assert.equal(missingCwd.status, 'failed')
    assert.match(missingCwd.error, /working directory is unavailable/)
    assert.ok(missingCwd.error.includes(workdir), missingCwd.error)
    assert.doesNotMatch(missingCwd.error, /bash executable|provision-shells/)

    // A gone executable with a workdir that is still there keeps the source-routed payload remedy.
    const goneBash = { spawn() { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) } }
    const missingBash = await bashToolDefinition({ file: path.join(dir, 'absent-bash'), source: 'bundled', subprocess: goneBash })
      .execute({ command: 'echo hi', workdir: dir }, exec)
    assert.match(missingBash.error, /bash executable is unavailable \(ENOENT\)/)
    assert.match(missingBash.error, /provision-shells --bash/)
    assert.doesNotMatch(missingBash.error, /working directory is unavailable/)
  })
})

await test('sessionWorkdir anchors a relative path at the session workspace (#237)', () => {
  const posix = { header: { cwd: '/session/cwd' } }
  for (const args of [{}, { workdir: undefined }, { workdir: null }, { workdir: '' }, { workdir: '   ' }]) {
    assert.equal(sessionWorkdir(args, posix), '/session/cwd')
  }
  for (const [workdir, expected] of [
    ['.', '/session/cwd'],
    ['sub', '/session/cwd/sub'],
    ['./sub', '/session/cwd/sub'],
    ['nested/../sub', '/session/cwd/sub'],
    [' child ', '/session/cwd/ child '],
    ['/chosen', '/chosen'],
  ]) {
    assert.equal(sessionWorkdir({ workdir }, posix), expected, JSON.stringify(workdir))
  }
  // A non-string is not coerced to the default; the executor is where it is refused.
  assert.equal(sessionWorkdir({ workdir: 5 }, posix), 5)
})

await test('a Windows workspace keeps Windows rules on every host (#237)', () => {
  const cwd = path.win32.join('C:', 'session', 'cwd')
  const session = { header: { cwd } }
  const other = path.win32.join('D:', 'chosen')
  assert.equal(sessionWorkdir({ workdir: other }, session), other, 'absolute paths stay absolute')
  assert.equal(sessionWorkdir({ workdir: 'sub' }, session), path.win32.join(cwd, 'sub'))
  // \child is rooted, and the session's drive is what roots it -- never a per-drive cwd.
  assert.equal(sessionWorkdir({ workdir: path.win32.sep + 'child' }, session), 'C:' + path.win32.sep + 'child')
  assert.equal(sessionWorkdir({ workdir: 'C:' + 'sub' }, session), path.win32.join(cwd, 'sub'))
  assert.throws(() => sessionWorkdir({ workdir: 'D:' + 'sub' }, session), error => {
    assert.ok(error instanceof BashArgumentError, error?.message)
    assert.equal(error.argument, 'workdir')
    assert.match(error.message, /names drive D:/)
    assert.match(error.message, /absolute path/)
    return true
  })
})

await test('a relative workdir with no absolute session workspace is refused (#237)', () => {
  for (const cwd of [undefined, '', 'relative-root', path.win32.sep + 'workspace']) {
    assert.throws(() => sessionWorkdir({ workdir: 'child' }, { header: { cwd } }), error => {
      assert.ok(error instanceof BashArgumentError, error?.message)
      assert.equal(error.argument, 'workdir')
      assert.match(error.message, /absolute session workspace/)
      return true
    }, 'cwd=' + JSON.stringify(cwd))
  }
})

await test('a refusal folded into a value satisfies the contract the host enforces (#235)', async () => {
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  const folded = withBashStatus(bashRefusalValue(new Error('EXECUTOR_UNAVAILABLE: probe')))
  assert.equal(folded.status, 'failed')
  assert.equal(folded.timedOut, false)
  assert.equal(folded.timeoutMs, DEFAULT_BASH_TIMEOUT_MS)
  assert.deepEqual(folded.stdout, { text: '', truncated: false })
  assert.deepEqual(folded.stderr, { text: '', truncated: false })
  assert.deepEqual(validateJsonSchemaValue(BASH_OUTPUT_SCHEMA, folded, 'value'), [])
  // The shape this replaced: a bare { error } is NOT a valid result, which the host reported as
  // "returned invalid output" -- losing the cause the refusal had just stated.
  assert.notEqual(validateJsonSchemaValue(BASH_OUTPUT_SCHEMA, withBashStatus({ error: 'boom' }), 'value').length, 0)
  // A settled run validates too, so this pin is not about the refusal path alone.
  const { service, settle } = fakeSubprocess({ exitCode: 0, stdout: 'ok' })
  const running = bashToolDefinition({ file: 'bash', source: 'config', subprocess: service }).execute({ command: 'true' }, {})
  settle()
  assert.deepEqual(validateJsonSchemaValue(BASH_OUTPUT_SCHEMA, await running, 'value'), [])
})

report('shells-guards')
