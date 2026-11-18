/** Replacement expansion is bounded before any file publication, including previews (#330). */
import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('replace-size')
const MAX_FILE_BYTES = 32 * 1024 * 1024
const call = async (root, args) => envelopeOf(await callTool('replace', {
  path: root, pattern: 'a', replacement: 'B'.repeat(1024), maxReplacements: 100_000, ...args,
}, { root }), assert)
const refused = value => {
  assert.equal(value.status, 'error', JSON.stringify(value))
  assert.equal(value.error.code, 'OUTPUT_LIMIT', JSON.stringify(value))
  assert.equal(value.error.effectState, 'none')
}

await test('exactly 32 MiB is accepted while one byte over is refused in preview and execution', () =>
  withTempDir('replace-size-boundary', async root => {
    const file = path.join(root, 'input.txt')
    for (const dryRun of [true, false]) {
      fs.writeFileSync(file, 'a'.repeat(32_768))
      const value = await call(root, { path: file, dryRun })
      assert.equal(value.status, 'completed', JSON.stringify(value))
      assert.equal(value.items[0].bytesAfter, MAX_FILE_BYTES)
      assert.equal(fs.statSync(file).size, dryRun ? 32_768 : MAX_FILE_BYTES)
      fs.writeFileSync(file, `!${'a'.repeat(32_768)}`)
      const before = fs.readFileSync(file)
      refused(await call(root, { path: file, dryRun }))
      assert.deepEqual(fs.readFileSync(file), before)
    }
  }))

await test('replacement limits use UTF-8 bytes rather than character counts', () =>
  withTempDir('replace-size-utf8', async root => {
    const file = path.join(root, 'input.txt'), before = 'a'.repeat(32_768)
    fs.writeFileSync(file, before)
    const replacement = '界'.repeat(342)
    assert.ok(replacement.length * before.length < MAX_FILE_BYTES)
    assert.ok(Buffer.byteLength(replacement) * before.length > MAX_FILE_BYTES)
    for (const dryRun of [true, false]) {
      refused(await call(root, { path: file, replacement, dryRun }))
      assert.equal(fs.readFileSync(file, 'utf8'), before)
    }
  }))

await test('a later over-limit file refuses the entire directory plan before earlier files change', () =>
  withTempDir('replace-size-directory', async root => {
    const first = path.join(root, 'a-small.txt'), later = path.join(root, 'z-large.txt')
    fs.writeFileSync(first, 'a')
    fs.writeFileSync(later, 'a'.repeat(40_000))
    const beforeFirst = fs.readFileSync(first), beforeLater = fs.readFileSync(later)
    for (const dryRun of [true, false]) {
      refused(await call(root, { dryRun }))
      assert.deepEqual(fs.readFileSync(first), beforeFirst)
      assert.deepEqual(fs.readFileSync(later), beforeLater)
      assert.deepEqual(fs.readdirSync(root).sort(), ['a-small.txt', 'z-large.txt'])
    }
  }))

report('replace-size')
