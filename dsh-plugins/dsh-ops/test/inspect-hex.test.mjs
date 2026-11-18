/**
 * The hex view's row semantics (report L2).
 *
 * `offset` is one parameter with one meaning: the 1-based unit to start from.
 * For `view: "text"` that unit is a line, for `view: "hex"` a 16-byte row. It
 * used to count rows from zero in the hex branch while the text branch counted
 * lines from one, so the declared default `offset: 1` skipped the first row — and
 * because the schema declares `minimum: 1`, a caller following the documentation
 * had no way to ask for those bytes back. The visible symptom: a file of at most
 * 16 bytes read back as an empty string while the envelope still said
 * `status: "completed"`, `complete: true`.
 *
 * What this suite locks in:
 *
 * - The default offset reads byte 0. The 8-byte repro from the report returns its
 *   8 bytes, not `""`.
 * - A 40-byte file shows its first row, the one the old code dropped.
 * - `offset: n` starts at byte `(n - 1) * 16`, matching the way the text view
 *   numbers lines, and `offset: 0` keeps the text view's tolerance (it reads the
 *   first unit) rather than refusing.
 * - `skipped` and the item `offset` are byte counts in this view, and
 *   `bytesTotal` lets a caller page without first guessing the file size.
 * - Reading past the end stays honest: empty text, `bytesTotal` still reported,
 *   `complete: true` — the same shape the text view already had.
 *
 * Platform. The subject is byte slicing in the native worker, so every case runs
 * on win32 as well.
 *
 * @module dsh-ops/test/inspect-hex
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('inspect-hex')

/** Write a byte array under the workspace and return its path. */
const binary = (workspace, name, bytes) => {
  const target = path.join(workspace, name)
  fs.writeFileSync(target, Buffer.from(bytes))
  return target
}

/** Render bytes the way the worker's hex view does. */
const hexOf = bytes => bytes.map(byte => byte.toString(16).padStart(2, '0')).join(' ')

/** The 8 bytes from the report's repro. */
const EIGHT = [0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33]

await test('the default offset reads the first row instead of skipping it', async () => {
  await withTempDir('inspect-hex-default', async workspace => {
    const read = target => callTool('inspect_local_file', { path: target, view: 'hex' }, { root: workspace })

    const eight = envelopeOf(await read(binary(workspace, 'eight.bin', EIGHT)), assert)
    assert.equal(eight.status, 'completed')
    assert.equal(eight.items[0].view, 'hex')
    assert.equal(eight.items[0].text, hexOf(EIGHT), 'the first 16 bytes must not be dropped')
    assert.equal(eight.skipped, 0)
    assert.equal(eight.items[0].offset, 0)
    assert.equal(eight.bytesTotal, 8)
    assert.equal(eight.complete, true)
    assert.equal(eight.omitted, 0)

    // The default limit is 200 rows, so a small file comes back whole — and it
    // must start at byte 0x41. The old code started at 0x51, one row in.
    const alpha = Array.from({ length: 40 }, (_, index) => index + 0x41)
    const forty = binary(workspace, 'forty.bin', alpha)

    const whole = envelopeOf(await read(forty), assert)
    assert.equal(whole.items[0].text, hexOf(alpha), 'the read must start at byte 0')
    assert.equal(whole.skipped, 0)
    assert.equal(whole.bytesTotal, 40)
    assert.equal(whole.complete, true)
    assert.equal(whole.omitted, 0)

    // Bounded to a single row, the row still begins at byte 0.
    const oneRow = envelopeOf(
      await callTool('inspect_local_file', { path: forty, view: 'hex', limit: 1 }, { root: workspace }),
      assert,
    )
    assert.equal(oneRow.items[0].text, hexOf(alpha.slice(0, 16)), 'row 1 is bytes 0..15')
    assert.equal(oneRow.items[0].offset, 0)
    assert.equal(oneRow.complete, false)
    assert.equal(oneRow.omitted, 24)
  })
})

await test('offset counts 16-byte rows the way text counts lines', async () => {
  await withTempDir('inspect-hex-offset', async workspace => {
    const all = Array.from({ length: 48 }, (_, index) => index)
    const target = binary(workspace, 'rows.bin', all)
    const row = async offset => envelopeOf(
      await callTool('inspect_local_file', { path: target, view: 'hex', offset, limit: 1 }, { root: workspace }),
      assert,
    )

    const first = await row(1)
    assert.equal(first.items[0].offset, 0)
    assert.equal(first.skipped, 0)
    assert.equal(first.items[0].text, hexOf(all.slice(0, 16)))

    const second = await row(2)
    assert.equal(second.items[0].offset, 16)
    assert.equal(second.skipped, 16)
    assert.equal(second.items[0].text, hexOf(all.slice(16, 32)))

    const third = await row(3)
    assert.equal(third.items[0].offset, 32)
    assert.equal(third.items[0].text, hexOf(all.slice(32, 48)))
    assert.equal(third.complete, true)
    assert.equal(third.omitted, 0)

    // The text view tolerates a zero offset and reads the first unit. Hex keeps
    // that tolerance instead of refusing, and likewise reads from byte 0.
    const zero = await row(0)
    assert.equal(zero.status, 'completed')
    assert.equal(zero.items[0].offset, 0)
    assert.equal(zero.items[0].text, first.items[0].text)

    // Past the end mirrors the text view: nothing to return, but the file facts
    // stay truthful rather than the read pretending to have completed a search.
    const past = envelopeOf(
      await callTool('inspect_local_file', { path: target, view: 'hex', offset: 100 }, { root: workspace }),
      assert,
    )
    assert.equal(past.status, 'completed')
    assert.equal(past.items[0].text, '')
    assert.equal(past.bytesTotal, 48)
    assert.equal(past.complete, true)
  })
})

report('inspect-hex')
