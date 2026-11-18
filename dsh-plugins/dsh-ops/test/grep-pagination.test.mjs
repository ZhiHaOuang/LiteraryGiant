/** Real-worker regressions for complete multi-file pagination and SDK bounds. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('grep-pagination')
const run = async (root, args) => envelopeOf(await callTool('grep', { path: root, pattern: 'hit', ...args }, { root }), assert)

await test('120 files retain exact global totals beyond the default 100-file page', async () => {
  await withTempDir('grep-pages', async root => {
    for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(root, `${String(i).padStart(3, '0')}.txt`), 'hit\nhit\n')
    fs.writeFileSync(path.join(root, 'zzz-no-hit.txt'), 'nothing\n')
    for (const outputMode of ['count', 'files_with_matches']) {
      const first = await run(root, { outputMode })
      assert.equal(first.items.length, 100)
      assert.equal(first.total, 120)
      assert.equal(first.matched, 240)
      assert.equal(first.complete, false)
      assert.equal(first.omitted, 20)
      assert.equal(first.nextOffset, 100)
      const last = await run(root, { outputMode, offset: first.nextOffset })
      assert.equal(last.items.length, 20)
      assert.equal(last.total, 120)
      assert.equal(last.matched, 240)
      assert.equal(last.complete, true)
      assert.equal(last.omitted, 0)
      assert.equal(new Set([...first.items, ...last.items].map(x => x.path)).size, 120)
      if (outputMode === 'count') assert.ok([...first.items, ...last.items].every(x => x.count === 2))
    }
    const summary = await run(root, { outputMode: 'summary' })
    assert.equal(summary.files, 120)
    assert.equal(summary.matches, 240)
    assert.equal(summary.complete, true)
    const first = await run(root, { outputMode: 'content', limit: 2 })
    assert.equal(first.total, 240)
    assert.equal(first.complete, false)
    assert.equal(first.omitted, 238)
  })
})

await test('content pages inside and across files do not build or return the skipped prefix', async () => {
  await withTempDir('grep-content-pages', async root => {
    for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, `${name}.txt`), 'hit one\nhit two\nhit three\n')
    for (const multiline of [false, true]) {
      const items = []
      let offset = 0
      for (let n = 0; n < 5; n++) {
        const page = await run(root, { multiline, offset, limit: 2 })
        assert.equal(page.total, 9)
        assert.equal(page.matched, 9)
        items.push(...page.items)
        assert.equal(page.nextOffset, offset + page.items.length)
        offset = page.nextOffset
        if (page.complete) break
      }
      assert.equal(items.length, 9)
      assert.equal(new Set(items.map(x => `${x.path}:${x.line}`)).size, 9)
      const empty = await run(root, { multiline, offset: 99, limit: 2 })
      assert.equal(empty.total, 9)
      assert.deepEqual(empty.items, [])
      assert.equal(empty.complete, true)
    }
    const exact = await run(root, { outputMode: 'count', limit: 3 })
    assert.equal(exact.complete, true, 'an exact page boundary is complete after the scan')
    const none = await run(root, { pattern: 'absent' })
    assert.equal(none.total, 0)
    assert.equal(none.complete, true)
    fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([255, 254]))
    const skipped = await run(root, { outputMode: 'summary' })
    assert.equal(skipped.skippedFiles, 1)
    assert.equal(skipped.matches, 9)
  })
})

await test('oversized grep files leave explicit coverage gaps without read failures', async () => {
  await withTempDir('grep-oversized', async root => {
    fs.writeFileSync(path.join(root, 'small.txt'), 'hit\nhit\n')
    const fd = fs.openSync(path.join(root, 'oversized.txt'), 'w')
    try { fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1) } finally { fs.closeSync(fd) }
    for (const outputMode of ['summary', 'count']) {
      const page = await run(root, { outputMode })
      assert.equal(page.skippedFiles, 1)
      assert.equal(page.failed, 0)
      assert.equal(page.matched, 2)
      assert.equal(page.complete, false)
      assert.equal(page.scanComplete, false)
      assert.equal(page.truncated, true)
      assert.equal(page.matchedTotal, undefined)
      assert.equal(page.skipReasons.oversized, 1)
      if (outputMode === 'summary') assert.equal(page.files, 1)
      else {
        assert.equal(page.total, undefined)
        assert.equal(page.items.length, 1)
        assert.equal(page.items[0].count, 2)
      }
    }
  })
})

await test('raw worker enforces bounds now described rather than unsupported schema keywords', async () => {
  await withTempDir('file-sdk-bounds', async root => {
    const target = path.join(root, 'file.txt')
    fs.writeFileSync(target, 'hit\n')
    const cases = [
      ['inspect_local_file', { path: target, offset: -1 }],
      ['inspect_local_file', { path: target, limit: 10001 }],
      ['glob', { path: root, pattern: ['**/*'], limit: 0 }],
      ['glob', { path: root, pattern: ['**/*'], limit: 10001 }],
      ['glob', { path: root, pattern: [] }],
      ['grep', { path: root, pattern: 'hit', beforeContext: 33 }],
      ['grep', { path: root, pattern: 'hit', afterContext: 33 }],
      ['grep', { path: root, pattern: 'hit', limit: 0 }],
      ['grep', { path: root, pattern: 'hit', outputMode: 'typo' }],
      ['diff', { path: target, content: 'x', limit: 1001 }],
      ['replace', { path: root, pattern: 'hit', replacement: 'x', maxReplacements: 100001 }],
      ['write_file', { path: target, content: 'x', expectedRevision: 'bad' }],
      ['edit_file', { path: target, expectedRevision: 'a'.repeat(64), edits: [] }],
      ['edit_file', { path: target, expectedRevision: 'a'.repeat(64), edits: [{ oldText: '', newText: 'x' }] }],
      ['edit_file', { path: target, expectedRevision: 'a'.repeat(64), edits: Array.from({ length: 101 }, () => ({ oldText: 'hit', newText: 'x' })) }],
    ]
    // Obtain the real revision so edit-bound tests reach planning rather than CAS rejection.
    const stat = envelopeOf(await callTool('stat', { path: target }, { root }), assert)
    for (const [tool, args] of cases) {
      if (tool === 'edit_file') args.expectedRevision = stat.revision
      const result = envelopeOf(await callTool(tool, args, { root }), assert)
      assert.equal(result.error?.code, 'INVALID_ARGUMENT', `${tool}: ${JSON.stringify(result)}`)
    }
    assert.equal(fs.readFileSync(target, 'utf8'), 'hit\n')
  })
})
report('grep-pagination')
