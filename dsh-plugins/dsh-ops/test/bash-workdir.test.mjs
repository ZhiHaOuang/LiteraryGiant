/** #180/#113: a tool call's directory belongs to its session, not the host process. */
import path from 'node:path'
import { assert, report, test } from './lib/harness.mjs'
import { sessionWorkdir } from '../lib/session-shells.js'

const cwd = path.resolve('session workspace')
const session = { header: { cwd } }

await test('relative workdirs resolve against the session workspace', () => {
  for (const workdir of ['.', 'retest-dir', './retest-dir', 'nested/../retest-dir', ' child ']) {
    assert.equal(sessionWorkdir({ workdir }, session), path.resolve(cwd, workdir), workdir)
  }
})

await test('omitted and blank workdirs retain the session default', () => {
  for (const workdir of [undefined, null, '', '   ']) {
    assert.equal(sessionWorkdir({ workdir }, session), cwd)
  }
})

await test('absolute paths and invalid argument types retain their existing handling', () => {
  const absolute = path.resolve('chosen directory')
  assert.equal(sessionWorkdir({ workdir: absolute }, session), absolute)
  assert.equal(sessionWorkdir({ workdir: 5 }, session), 5)
})

await test('rooted paths use the session root without an ambient Windows drive cwd', () => {
  const rooted = `${path.sep}child`
  assert.equal(sessionWorkdir({ workdir: rooted }, session), path.join(path.parse(cwd).root, 'child'))
  if (process.platform === 'win32') {
    const session = { header: { cwd: 'D:\\session\\workspace' } }
    assert.equal(sessionWorkdir({ workdir: '\\child' }, session), 'D:\\child')
    assert.equal(sessionWorkdir({ workdir: 'D:child' }, session), 'D:\\session\\workspace\\child')
    assert.throws(() => sessionWorkdir({ workdir: 'C:child' }, session), /invalid workdir:.*absolute path/)
    assert.throws(() => sessionWorkdir({ workdir: 'child' }, { header: { cwd: '\\workspace' } }), /absolute session/)
  }
})

await test('a relative workdir cannot fall back to the process cwd without a valid session root', () => {
  for (const cwd of [undefined, '', 'relative-session-root']) {
    assert.throws(() => sessionWorkdir({ workdir: 'child' }, { header: { cwd } }), /invalid workdir:.*absolute session/)
  }
})

await test('a POSIX-style drive workdir maps onto the Windows form on a Windows session (#318)', () => {
  // No host-platform guard: the flavour comes from the session workspace's
  // spelling (`windowsFlavoured`), so these assertions hold on every platform
  // the gate runs — a guard would let two of the three CI legs skip them.
  const session = { header: { cwd: 'D:\\session\\workspace' } }
  // The raw `/d/…` string must never reach the executor: before #318 it did,
  // and Node's `fs` read it against the *host process's* current drive, where
  // a decoy directory made the command run in the wrong tree with exit 0.
  const mapped = sessionWorkdir({ workdir: '/d/global/x' }, session)
  assert.equal(mapped, 'D:\\global\\x')
  assert.equal(mapped.includes('/'), false, 'the normalized form carries no POSIX separators')
  assert.equal(sessionWorkdir({ workdir: '/D/global/x' }, session), 'D:\\global\\x')
  assert.equal(sessionWorkdir({ workdir: '/d' }, session), 'D:\\')
  // A different drive stays an absolute path, like `E:\x` today: existence is
  // the executor's check, the session drive only governs *relative* forms.
  assert.equal(sessionWorkdir({ workdir: '/e/x' }, session), 'E:\\x')
  // Forward-slash UNC keeps its existing passthrough.
  assert.equal(sessionWorkdir({ workdir: '//server/share/x' }, session), '//server/share/x')
})

await test('a drive-less POSIX absolute workdir is refused, never drive-guessed (#318)', () => {
  const session = { header: { cwd: 'D:\\session\\workspace' } }
  for (const workdir of ['/', '/tmp/x', '/d-global', '/d:/x']) {
    assert.throws(() => sessionWorkdir({ workdir }, session), /invalid workdir:.*drive/, workdir)
  }
})

await test('POSIX-style workdirs keep their meaning on a POSIX session', () => {
  const session = { header: { cwd: '/home/u/ws' } }
  assert.equal(sessionWorkdir({ workdir: '/d/x' }, session), '/d/x')
  assert.equal(sessionWorkdir({ workdir: '/tmp/x' }, session), '/tmp/x')
})

report('bash-workdir')
