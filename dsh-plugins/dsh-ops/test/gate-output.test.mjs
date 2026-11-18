import { spawn } from 'node:child_process'
import { assert, test, report } from './lib/harness.mjs'
import { collectProcessOutput } from '../scripts/lib/gate-output.mjs'

await test('gate drains saturated stderr and stdout concurrently and preserves a failing exit', async () => {
  const size = 4 * 1024 * 1024
  const child = spawn(process.execPath, ['-e', `
    process.stderr.write('e'.repeat(${size}));
    process.stdout.write('o'.repeat(${size}));
    process.exitCode = 7;
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 10000)
  let stdout = '', stderr = ''
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  try {
    const [output, code] = await Promise.all([
      collectProcessOutput(child, {
        stdout: { write(chunk) { stdout += chunk } },
        stderr: { write(chunk) { stderr += chunk } },
      }),
      finished,
    ])
    assert.equal(timedOut, false, 'the stderr pipe must be drained before stdout closes')
    assert.equal(code, 7, 'collecting output must not turn a failing step into success')
    assert.equal(stdout, 'o'.repeat(size))
    assert.equal(stderr, 'e'.repeat(size))
    assert.equal(output.length, size * 2)
    assert.equal(output.replaceAll('e', '').length, size)
    assert.equal(output.replaceAll('o', '').length, size)
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill() }
})
report('gate-output')
