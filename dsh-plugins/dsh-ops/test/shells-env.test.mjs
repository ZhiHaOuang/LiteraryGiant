/**
 * The environment invariants from PLAN §2.7, asserted as behavior and not as
 * prose: `resolveShells` must never throw, must never mutate `process.env`, and
 * must never change the working directory — the plugin may lose a rung, but it
 * must never fail to activate because of one.
 *
 * The shared fixtures live in `test/lib/shells-fixtures.mjs`.
 */

import { resolveShells } from '../lib/shells.js'
import { assert, TEST_HOME, report, test } from './lib/harness.mjs'
import { config } from './lib/shells-fixtures.mjs'

await test('resolveShells never throws, whatever it is handed', () => {
  const inputs = [
    undefined,
    null,
    {},
    { bashPath: '', publishBashTool: 'yes', allowSystemShellFallback: 'no' },
    { publishBashTool: false, allowSystemShellFallback: false },
    // Keys the plugin deliberately does not implement: still no throw.
    { pwshPath: 'C:\\pwsh.exe', overridePwshExecutor: true },
  ]
  for (const raw of inputs) {
    const resolved = resolveShells(raw)
    assert.equal(typeof resolved.bash.available, 'boolean')
    assert.equal(typeof resolved.pwsh.available, 'boolean')
    assert.equal(typeof resolved.bash.source, 'string')
    assert.equal(typeof resolved.pwsh.source, 'string')
  }
  // The option bag is a test seam, not a contract: a hostile one must not throw either. Resolution
  // follows the TARGET platform, so an unknown one takes the POSIX rung — what must hold is that a
  // definite answer comes back.
  const hostile = resolveShells(config(), { bundleRoot: '/nonexistent', env: { DSH_HOME: TEST_HOME }, platform: 'plan9', arch: 'x64' })
  assert.equal(typeof hostile.bash.available, 'boolean')
  assert.equal(typeof hostile.pwsh.available, 'boolean')
  // Windows is the platform where "no pinned payload" is the answer: nothing to fall back to, and
  // the flag that would allow it is off.
  const windows = resolveShells(config(), { bundleRoot: '/nonexistent', env: { DSH_HOME: TEST_HOME }, platform: 'win32', arch: 'x64' })
  assert.equal(windows.bash.available, false)
  assert.equal(windows.pwsh.available, false)
})

await test('resolveShells leaves process.env and the working directory untouched', () => {
  const before = { ...process.env }
  const cwd = process.cwd()
  for (let round = 0; round < 3; round += 1) {
    resolveShells(config({ bashPath: 'C:\\tools\\bash.exe', allowSystemShellFallback: false }))
    resolveShells(config({ bashPath: undefined, allowSystemShellFallback: true }))
    resolveShells(config({ publishBashTool: false }))
  }
  assert.deepEqual({ ...process.env }, before)
  assert.equal(process.cwd(), cwd)
})

report('shells-env')
