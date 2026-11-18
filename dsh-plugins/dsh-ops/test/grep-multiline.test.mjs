/**
 * `multiline` matches across lines (report L6).
 *
 * The flag turned on the regex engine's `multi_line` mode, which only changes what
 * `^` and `$` anchor to, and then the search ran one line at a time. So a pattern
 * containing `\n` could never match anything, and `multiline: true` did not do the
 * one thing its name promises. The result was not an error: it was `matched: 0`, a
 * confident answer to a question the caller never asked.
 *
 * What this suite locks in:
 *
 * - With `multiline`, a pattern reaches across line breaks and is reported at the
 *   line where the match starts, however many lines it covers.
 * - Without it, the same pattern still has to fit on one line — the flag is the
 *   only thing that changes, so the two modes are visibly different rather than
 *   both broken.
 * - `beforeContext`/`afterContext` still surround a cross-line match with the lines
 *   around it, so context did not have to be given up to get cross-line matching.
 * - `count` counts matches, not matching lines, in multiline mode, and a pattern
 *   whose pieces are not adjacent still finds nothing (no accidental "search the
 *   whole file" behaviour).
 * - `^` and `$` keep their per-line meaning, because turning on cross-line matching
 *   must not quietly turn `^delta$` into an end-of-file anchor.
 * - Paging still reports the honest total and continues correctly.
 *
 * `test/linux-args.test.mjs` carries the two-line case; this suite covers the rest
 * of the contract. Neither asserts a defect as expected behaviour.
 *
 * Platform. Pure matching, no filesystem semantics beyond a temp file, so every
 * case runs on win32 as well.
 *
 * @module dsh-ops/test/grep-multiline
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('grep-multiline')

const LINES = ['alpha', 'bravo', 'charlie', 'delta', 'echo']

const grep = (workspace, target, args) => callTool('grep', { path: target, ...args }, { root: workspace })

await test('a cross-line match is reported where it starts, however many lines it covers', async () => {
  await withTempDir('grep-multiline-span', async workspace => {
    const target = path.join(workspace, 'lines.txt')
    fs.writeFileSync(target, `${LINES.join('\n')}\n`)

    const two = envelopeOf(await grep(workspace, target, { pattern: 'bravo\\ncharlie', multiline: true }), assert)
    assert.equal(two.matched, 1)
    assert.equal(two.items[0].line, 2, 'the match starts on line 2')
    assert.equal(two.items[0].text, 'bravo\ncharlie')

    const three = envelopeOf(await grep(workspace, target, { pattern: 'alpha\\nbravo\\ncharlie', multiline: true }), assert)
    assert.equal(three.matched, 1)
    assert.equal(three.items[0].line, 1)
    assert.equal(three.items[0].text, 'alpha\nbravo\ncharlie')

    const later = envelopeOf(await grep(workspace, target, { pattern: 'charlie\\ndelta', multiline: true }), assert)
    assert.equal(later.items[0].line, 3, 'a match later in the file reports its own start line')

    // Pieces that are not adjacent must not match.
    const apart = envelopeOf(await grep(workspace, target, { pattern: 'alpha\\ndelta', multiline: true }), assert)
    assert.equal(apart.matched, 0)
  })
})

await test('context still surrounds a cross-line match, and the flag is the only difference', async () => {
  await withTempDir('grep-multiline-context', async workspace => {
    const target = path.join(workspace, 'lines.txt')
    fs.writeFileSync(target, `${LINES.join('\n')}\n`)

    const withContext = envelopeOf(await grep(workspace, target, { pattern: 'bravo\\ncharlie', multiline: true, beforeContext: 1, afterContext: 1 }), assert)
    assert.equal(withContext.matched, 1)
    assert.equal(withContext.items[0].text, 'alpha\nbravo\ncharlie\ndelta', 'context lines still surround the match')

    // Same request, no flag: line-oriented, so the pattern cannot match at all.
    const withoutFlag = envelopeOf(await grep(workspace, target, { pattern: 'bravo\\ncharlie' }), assert)
    assert.equal(withoutFlag.matched, 0, 'without multiline the pattern must fit on one line')

    // A pattern that does fit is unaffected by the flag.
    const plain = envelopeOf(await grep(workspace, target, { pattern: 'charlie' }), assert)
    assert.equal(plain.matched, 1)
    assert.equal(plain.items[0].line, 3)
  })
})

await test('count counts matches, and ^ and $ stay per line', async () => {
  await withTempDir('grep-multiline-count', async workspace => {
    const target = path.join(workspace, 'lines.txt')
    fs.writeFileSync(target, `${LINES.join('\n')}\n`)

    const counted = envelopeOf(await grep(workspace, target, { pattern: '(bravo|delta)\\n\\w+', multiline: true, outputMode: 'count' }), assert)
    assert.equal(counted.matched, 2, 'two cross-line matches, not five lines')
    assert.equal(counted.items[0].count, 2)

    const anchored = envelopeOf(await grep(workspace, target, { pattern: '^delta$', multiline: true }), assert)
    assert.equal(anchored.matched, 1, '^ and $ must not become whole-file anchors')
    assert.equal(anchored.items[0].line, 4)

    // A pattern that spans the whole file, with paging on top of it. Matches are
    // non-overlapping, so five lines hold two adjacent pairs, not four.
    const paged = envelopeOf(await grep(workspace, target, { pattern: '\\w+\\n\\w+', multiline: true, limit: 1 }), assert)
    assert.equal(paged.matched, 2)
    assert.equal(paged.items.length, 1)
    assert.equal(paged.complete, false)
    assert.equal(paged.nextOffset, 1, 'paging resumes where it left off')
  })
})

await test('a cross-line match reports matched: 1 even when the file has no trailing newline', async () => {
  await withTempDir('grep-multiline-eof', async workspace => {
    const target = path.join(workspace, 'no-newline.txt')
    fs.writeFileSync(target, 'alpha\nbravo')

    const match = envelopeOf(await grep(workspace, target, { pattern: 'alpha\\nbravo', multiline: true }), assert)
    assert.equal(match.matched, 1, 'the last line without a newline is still matchable')
    assert.equal(match.items[0].line, 1)
    assert.equal(match.items[0].text, 'alpha\nbravo')
  })
})

await test('no match is ever reported on a line the file does not have', async () => {
  await withTempDir('grep-multiline-phantom', async workspace => {
    const target = path.join(workspace, 'lines.txt')
    fs.writeFileSync(target, `${LINES.join('\n')}\n`) // five lines, trailing newline

    // Matching the whole file at once makes `$` and `^` match once more, at the
    // position after the final newline. That position is not a line: reporting it
    // invented line 6 of a five-line file, with empty text, so `$` answered six
    // times for five lines. Found by an independent verification pass against the
    // first version of this feature.
    const dollars = envelopeOf(await grep(workspace, target, { pattern: '$', multiline: true }), assert)
    assert.equal(dollars.matched, LINES.length, 'one match per line, and no sixth line')
    assert.deepEqual(dollars.items.map(item => item.line), [1, 2, 3, 4, 5])
    assert.ok(dollars.items.every(item => item.text !== ''), 'a reported line must carry content')

    const carets = envelopeOf(await grep(workspace, target, { pattern: '^', multiline: true }), assert)
    assert.deepEqual(carets.items.map(item => item.line), [1, 2, 3, 4, 5])

    // The property that matters generally: every reported line exists, whatever the
    // pattern matches. `a*` matches empty at every offset, so it is the strongest
    // form of this check.
    const star = envelopeOf(await grep(workspace, target, { pattern: 'a*', multiline: true }), assert)
    assert.ok(star.items.length > 0)
    assert.ok(star.items.every(item => item.line >= 1 && item.line <= LINES.length), 'no match may land past the last line')

    // A file with no trailing newline keeps its final match, because there the end
    // of the file really is the end of a line.
    const bare = path.join(workspace, 'bare.txt')
    fs.writeFileSync(bare, 'alpha\nbravo')
    const bareDollars = envelopeOf(await grep(workspace, bare, { pattern: '$', multiline: true }), assert)
    assert.deepEqual(bareDollars.items.map(item => item.line), [1, 2])
  })
})

await test('one enormous line is materialized once, not once per match', async () => {
  // Reported by @Haoming9527 in review of #81: the content path built a text item per match *before*
  // `limit` was consulted, so a 32 KiB line matched by `pattern: "a"` copied that line 32 768 times.
  // The bound is the page: the old shape needed roughly `line length x matches` bytes here — this
  // case's 256 KiB line has 262 144 matches, i.e. ~64 GiB — and the worker aborted under a memory cap
  // instead of answering. Counting stays exact, because `matched` reports every match.
  await withTempDir('grep-page-bound', async workspace => {
    const target = path.join(workspace, 'one-line.txt')
    const line = 'a'.repeat(256 * 1024)
    fs.writeFileSync(target, `${line}\n`)

    const page = envelopeOf(await callTool('grep', { path: target, pattern: 'a', multiline: true, limit: 1 }, { root: workspace, timeoutMs: 120_000 }), assert)
    assert.equal(page.items.length, 1, 'the page is one item wide')
    assert.equal(page.matched, line.length, 'every match is still counted')
    assert.equal(page.total, line.length, 'and the envelope still knows how many items there are')
    assert.equal(page.omitted, line.length, 'a partial line remains omitted until its suffix is recovered')
    assert.equal(page.nextOffset, 0, 'never skip the partially displayed match')
    assert.equal(page.complete, false)
    // The item is the line, cut to the response budget: the host collects 128 KiB of stdout, so the
    // envelope reports how much text the line had rather than pretending it fits.
    const [item] = page.items
    assert.equal(item.line, 1)
    assert.equal(item.bytesTotal, line.length)
    assert.equal(item.truncatedInLine, true)
    assert.equal(item.text.startsWith('aaaa'), true)
    assert.equal(item.text.length < line.length, true)
  })
})

report('grep-multiline')
