/**
 * The worker's response byte budget (report L4).
 *
 * `limit` bounds how many lines, rows or paths come back; nothing bounded how
 * *large* the response could be. A file whose single line was 200 KB produced
 * more stdout than the host collects — and the host, seeing a lossy read, reports
 * `OUTPUT_LIMIT` with `effectState: "unknown"`. So a pure read failed, and the
 * model was told the operation might have changed something. `grep` had the same
 * hole (a matching long line is emitted whole) and `glob` a wider one (100,000
 * entries x a path each).
 *
 * What this suite locks in:
 *
 * - The response never exceeds the host's `stdout: { maxBytes: 128 * 1024 }`
 *   collection cap, measured on the raw bytes the worker wrote. That is the
 *   property that keeps a read from being reported as an unknown effect, so it is
 *   asserted directly rather than inferred from the envelope fields.
 * - A single oversized line comes back as a bounded prefix with
 *   `truncatedInLine`, `bytesTotal` and `truncated: true`, instead of nothing or
 *   an error. `complete` is false, so the cut is never mistaken for the whole
 *   file.
 * - The budget is spent on the *encoded* size, not the payload. A NUL costs six
 *   bytes as `\u0000`, so a payload-only budget would still overflow on exactly
 *   the input that caused the original blow-up.
 * - Truncation lands on a character boundary: text comes back as valid UTF-8 with
 *   no replacement characters.
 * - `glob` and `grep` inherit the same ceiling through the shared result builder,
 *   and paging by `nextOffset` still reaches the end of a large file without any
 *   single page overflowing.
 *
 * The paging case also pinned down a second defect, found while writing it:
 * `inspect` declares a 1-based `offset` (like its hex rows) while `glob` and
 * `grep` count from zero, and the shared result builder derived the next page
 * from the *skipped* count — always one less. Feeding `nextOffset` back therefore
 * re-read the last returned line on every page, so a caller walking a large file
 * saw 4019 lines out of 4000. The builder now takes the resumption offset
 * explicitly instead of deriving it.
 *
 * Platform. Byte accounting in the native worker, so every case runs on win32 as
 * well.
 *
 * @module dsh-ops/test/output-budget
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('output-budget')

/** The host collects worker stdout with this ceiling (`lib/file/worker.js`). */
const HOST_CAP = 128 * 1024

/** Raw bytes the worker actually wrote. */
const written = result => Buffer.byteLength(result.stdout ?? '', 'utf8')

/** Every response must stay under the host cap, whatever else is asserted. */
const bounded = (result, label) => {
  assert.ok(written(result) < HOST_CAP, `${label}: wrote ${written(result)} bytes, over the ${HOST_CAP} host cap`)
}

await test('one oversized line comes back bounded instead of failing the read', async () => {
  await withTempDir('output-budget-line', async workspace => {
    const length = 200 * 1024
    const target = path.join(workspace, 'long.txt')
    fs.writeFileSync(target, 'A'.repeat(length))

    const result = await callTool('inspect_local_file', { path: target, limit: 1 }, { root: workspace })
    const body = envelopeOf(result, assert)
    bounded(result, 'long line')

    assert.equal(body.status, 'completed', 'a read must not fail because of its own output size')
    assert.equal(body.truncated, true)
    assert.equal(body.complete, false, 'a cut line is not the whole file')
    assert.equal(body.items.length, 1, 'the beginning of the line is still returned')
    assert.equal(body.items[0].truncatedInLine, true)
    assert.equal(body.items[0].bytesTotal, length)
    assert.ok(body.items[0].text.length > 0, 'the prefix must not be empty')
    assert.ok(body.items[0].text.length < length, 'the line must actually be cut')
    assert.ok(body.items[0].text.startsWith('A'))
  })
})

await test('the budget counts encoded bytes, so escaping cannot blow past it', async () => {
  await withTempDir('output-budget-escape', async workspace => {
    // Each NUL is one payload byte and six encoded bytes.
    const target = path.join(workspace, 'nuls.bin')
    fs.writeFileSync(target, Buffer.alloc(1024 * 1024, 0))

    const result = await callTool('inspect_local_file', { path: target, limit: 1 }, { root: workspace })
    const body = envelopeOf(result, assert)
    bounded(result, 'nul payload')

    assert.equal(body.status, 'completed')
    assert.equal(body.truncated, true)
    assert.equal(body.items.length, 1)
    assert.ok(body.items[0].text.length > 0)
    assert.ok(body.items[0].text.length < 1024 * 1024, 'a payload-byte budget would have kept far more')

    // CJK is three bytes per character and must be cut on a boundary.
    const cjk = path.join(workspace, 'cjk.txt')
    fs.writeFileSync(cjk, '中'.repeat(100_000))
    const wide = await callTool('inspect_local_file', { path: cjk, limit: 1 }, { root: workspace })
    const wideBody = envelopeOf(wide, assert)
    bounded(wide, 'cjk line')
    assert.equal(wideBody.truncated, true)
    assert.equal(wideBody.items.length, 1)
    assert.ok(wideBody.items[0].text.length > 0)
    assert.ok(!wideBody.items[0].text.includes('\uFFFD'), 'the cut must land on a character boundary')
    assert.ok(/^中+$/.test(wideBody.items[0].text), 'only whole characters are returned')
  })
})

await test('glob and grep inherit the same ceiling', async () => {
  await withTempDir('output-budget-glob', async workspace => {
    const dir = path.join(workspace, 'wide')
    fs.mkdirSync(dir)
    const stem = 'x'.repeat(100)
    for (let index = 0; index < 1500; index += 1) fs.writeFileSync(path.join(dir, `${stem}${String(index).padStart(5, '0')}.txt`), '')

    const listed = await callTool('glob', { path: dir, pattern: ['*.txt'], limit: 10_000 }, { root: workspace })
    const listing = envelopeOf(listed, assert)
    bounded(listed, 'glob')
    assert.equal(listing.status, 'completed')
    assert.equal(listing.truncated, true)
    assert.ok(listing.items.length < 1500, 'the listing must be cut by size, not only by limit')
    assert.ok(listing.omitted > 0)

    const long = path.join(workspace, 'match.txt')
    fs.writeFileSync(long, `needle ${'B'.repeat(200 * 1024)}`)
    const grepped = await callTool('grep', { path: long, pattern: 'needle', limit: 10 }, { root: workspace })
    const matches = envelopeOf(grepped, assert)
    bounded(grepped, 'grep')
    assert.equal(matches.status, 'completed')
    assert.equal(matches.truncated, true)
    assert.ok(matches.items.length <= 1)
    if (matches.items.length === 1) assert.equal(matches.items[0].truncatedInLine, true)
  })
})

await test('paging a large file still reaches the end without overflowing a page', async () => {
  await withTempDir('output-budget-page', async workspace => {
    const target = path.join(workspace, 'lines.txt')
    const total = 4000
    fs.writeFileSync(target, `${Array.from({ length: total }, (_, index) => `line ${index + 1} ${'p'.repeat(200)}`).join('\n')}\n`)

    let offset = 1
    let seen = 0
    let pages = 0
    for (; pages < 200; pages += 1) {
      const result = await callTool('inspect_local_file', { path: target, offset, limit: 200 }, { root: workspace })
      const body = envelopeOf(result, assert)
      bounded(result, `page at offset ${offset}`)
      assert.equal(body.status, 'completed')
      seen += body.items.length
      if (body.complete) break
      assert.ok(body.nextOffset > offset, 'paging must advance')
      offset = body.nextOffset
    }
    assert.ok(pages < 200, 'paging must terminate')
    assert.equal(seen, total, 'every line must still be reachable through nextOffset')
  })
})

report('output-budget')
