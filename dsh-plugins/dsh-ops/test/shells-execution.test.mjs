import { bashToolDefinition } from '../lib/shells.js'
import { assert, report, test } from './lib/harness.mjs'

const empty = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }

await test('one execution handle shares settlement and independent output observers', async () => {
  const finished = Promise.withResolvers()
  let spawned = 0
  const definition = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: {
    spawn() {
      spawned++
      return { done: finished.promise, collected: {
        stdout: { readFrom: offset => ({ text: 'hello'.slice(offset), nextOffset: 5, lossy: false }) }, stderr: empty,
      } }
    },
  } })
  const execution = definition.start({ command: 'echo hello' })
  assert.equal(execution.observed.stdout.readFrom(0).text, 'hello')
  assert.equal(execution.observed.stdout.readFrom(2).text, 'llo')
  assert.equal(execution.observed.stdout.readFrom(0).text, 'hello')
  assert.equal(execution.result(), execution.result())
  finished.resolve({ exitCode: 0, signal: null })
  await execution.done
  assert.equal(execution.status, 'completed')
  assert.equal((await execution.result()).stdout.text, 'hello')
  assert.equal(spawned, 1)
})

await test('cancellation settles pending preparation and a late provider never spawns', async () => {
  const preparation = Promise.withResolvers()
  let spawned = 0
  const definition = bashToolDefinition({ file: process.execPath, source: 'config',
    prepareArgv: () => preparation.promise, subprocess: { spawn() { spawned++; throw new Error('unexpected spawn') } },
  })
  const execution = definition.start({ command: 'true' }, {}, { onExpiry: 'none' })
  execution.kill('job cancelled during preparation')
  const value = await execution.result()
  assert.equal(value.cancelled, true)
  assert.equal(value.timedOut, false)
  preparation.resolve([process.execPath, '-c', 'true'])
  await Promise.resolve()
  assert.equal(spawned, 0)
  assert.equal(execution.status, 'killed')
})

await test('job-owned execution has no deadline and retains its cancellation signal', async () => {
  const finished = Promise.withResolvers()
  const aborted = Promise.withResolvers()
  const definition = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: {
    spawn(spec) {
      spec.signal.addEventListener('abort', () => { aborted.resolve(); finished.resolve({ exitCode: null, signal: 'SIGTERM' }) })
      return { done: finished.promise, collected: { stdout: empty, stderr: empty } }
    },
  } })
  const execution = definition.start({ command: 'true', timeoutMs: 1 }, {}, { onExpiry: 'none' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(execution.status, 'running')
  execution.kill('stop job')
  await aborted.promise
  const value = await execution.result()
  assert.equal(value.timedOut, false)
  assert.equal(value.cancelled, true)
})

await test('the first stop cause wins when timeout and caller cancellation race', async () => {
  const timeout = Promise.withResolvers()
  const finished = Promise.withResolvers()
  const caller = new AbortController()
  const definition = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: {
    spawn(spec) {
      spec.signal.addEventListener('abort', () => timeout.resolve())
      return { done: finished.promise, collected: { stdout: empty, stderr: empty } }
    },
  } })
  const execution = definition.start({ command: 'true', timeoutMs: 1 }, { signal: caller.signal })
  const keepAlive = setTimeout(() => {}, 1000)
  await timeout.promise
  caller.abort(new Error('later cancellation'))
  finished.resolve({ exitCode: null, signal: 'SIGTERM' })
  const value = await execution.result()
  clearTimeout(keepAlive)
  assert.equal(value.timedOut, true)
  assert.equal(value.cancelled, undefined)
})

await test('an unavailable subprocess service settles without starting a command', async () => {
  const definition = bashToolDefinition({ file: process.execPath, source: 'config' })
  const execution = definition.start({ command: 'true' })
  const value = await execution.result()
  assert.equal(execution.started, false)
  assert.equal(value.status, 'failed')
  assert.match(value.error, /Host subprocess service is unavailable/)
})

report('shells-execution')
