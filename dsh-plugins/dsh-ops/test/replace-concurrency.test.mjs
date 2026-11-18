/**
 * Concurrent replacement must not lose an update (report L14).
 *
 * `replace` observes first and publishes second: it records each file's revision,
 * then re-checks that revision immediately before writing. The check alone is
 * check-then-act. Every caller that observes the same pre-image passes it, so
 * several callers report `changed: 1` describing the same edit while only the
 * last rename covers the file — the others' work is gone, and they said it
 * succeeded. Nothing in the envelope contradicts them, which is what makes it a
 * silent loss rather than a visible failure.
 *
 * What this suite locks in, with several writers started on one file at once:
 *
 * - Exactly one caller reports a change, and it is the caller whose replacement is
 *   the one actually present afterwards. A caller may not report a change that is
 *   not in the file.
 * - Every other caller either refuses with an error or reports `changed: 0` having
 *   found its pattern already gone. Both are honest; claiming success is not.
 * - The survivor count is exactly one, so no interleaving quietly merged or
 *   dropped a write, and the file is never left with the pattern half-replaced.
 *
 * The writers use distinct replacements on the same single pattern, so a lost
 * update is directly visible: more than one replacement string in the file, or a
 * caller whose string is absent, is the defect showing through.
 *
 * `test/linux-args.test.mjs` covers the paging and pattern semantics of `replace`;
 * this suite is only about ordering. Advisory locking is POSIX `flock` on Linux
 * and `LockFileEx` on Windows — see `docs/windows-verification.md` for what the
 * Windows behaviour still needs to answer.
 *
 * @module dsh-ops/test/replace-concurrency
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('replace-concurrency')

const WRITERS = 6
const TRIALS = process.platform === 'darwin' ? 10 : 3
const FILLER = 1024 * 1024

/** Read one call's outcome without throwing on any of them. */
const outcome = result => {
  const body = envelopeOf(result, assert)
  if (body.status === 'error') {
    assert.equal(body.error?.code, 'REVISION_CONFLICT', JSON.stringify(body))
    assert.equal(body.error.effectState, 'none', JSON.stringify(body))
    return { kind: 'refused', detail: body.error.code }
  }
  assert.equal(body.status, 'completed', JSON.stringify(body))
  assert.ok(body.changed === 0 || body.changed === 1, JSON.stringify(body))
  return { kind: 'reported', changed: body.changed, detail: body.status }
}

await test('concurrent replaces never claim a change that did not survive', async () => {
  await withTempDir('replace-concurrency', async workspace => {
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const target = path.join(workspace, `trial-${trial}.txt`)
      const filler = 'filler line for the copy\n'.repeat(Math.ceil(FILLER / 25))
      fs.writeFileSync(target, `${filler}TOKEN\n${filler}`)

      const results = await Promise.all(
        Array.from({ length: WRITERS }, (_, index) =>
          callTool('replace', { path: target, pattern: 'TOKEN', replacement: `WRITER-${index + 1}` }, { root: workspace, timeoutMs: 60_000 }),
        ),
      )

      const final = fs.readFileSync(target, 'utf8')
      const present = []
      for (let writer = 1; writer <= WRITERS; writer += 1) if (final.includes(`WRITER-${writer}`)) present.push(writer)

      const claims = []
      const details = []
      results.forEach((result, index) => {
        const settled = outcome(result)
        details.push(`writer ${index + 1}: ${settled.kind}${settled.kind === 'reported' ? ` changed=${settled.changed}` : ` (${settled.detail})`}`)
        if (settled.kind === 'reported' && settled.changed > 0) claims.push(index + 1)
      })

      assert.equal(
        present.length,
        1,
        `trial ${trial}: exactly one replacement may survive, the file holds [${present.join(', ') || 'none'}] — ${details.join('; ')}`,
      )
      assert.deepEqual(
        claims,
        present,
        `trial ${trial}: the callers reporting a change must be the ones whose change is in the file — ${details.join('; ')}`,
      )
      assert.ok(final.includes('WRITER-'), `trial ${trial}: the surviving replacement must be present`)
      assert.ok(!final.includes('\nTOKEN\n'), `trial ${trial}: the original pattern must be gone, not half-replaced`)
      assert.equal(final.startsWith('filler line'), true, `trial ${trial}: the untouched prefix must survive intact`)
    }
  })
})

await test('debris cleanup removes only this file\'s own temporary names', async () => {
  // Reported by @Haoming9527 in review of #81. The sweep used to match a prefix, so it deleted files
  // that merely began the same way: an operator's own backup, and — for a target named `foo` — the
  // *live* temporary file of a different target (`foo.dsh-ops-bar`), whose writer holds a lock on that
  // other file and not on this one. The lock makes this file's leftovers safe to remove; it says
  // nothing at all about those.
  await withTempDir('replace-debris', async workspace => {
    const target = path.join(workspace, 'notes.txt')
    fs.writeFileSync(target, 'one two\n')
    const operator = path.join(workspace, '.notes.txt.dsh-ops-personal-backup')
    const otherTarget = path.join(workspace, `.foo.dsh-ops-bar.dsh-ops-${randomUUID()}`)
    const own = path.join(workspace, `.notes.txt.dsh-ops-${randomUUID()}`)
    for (const [file, text] of [[operator, 'operator backup'], [otherTarget, "another target's live temporary"], [own, 'this writer was killed']]) fs.writeFileSync(file, text)

    const result = await callTool('replace', { path: target, pattern: 'two', replacement: 'three' }, { root: workspace, timeoutMs: 60_000 })
    assert.equal(result.body?.status, 'completed', JSON.stringify(result.body ?? result.stdout))
    assert.equal(fs.readFileSync(target, 'utf8'), 'one three\n')
    for (const [file, text] of [[operator, 'operator backup'], [otherTarget, "another target's live temporary"]]) {
      assert.equal(fs.existsSync(file), true, `${path.basename(file)} does not have this writer\'s shape and must survive`)
      assert.equal(fs.readFileSync(file, 'utf8'), text)
    }
    assert.equal(fs.existsSync(own), false, 'a leftover of this very file must still be swept')
  })
})

report('replace-concurrency')
