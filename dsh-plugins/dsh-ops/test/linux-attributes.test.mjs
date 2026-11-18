/**
 * Filesystem attributes across an atomic replace, ported from the ad-hoc
 * `F-attrs` / `F2-mechanism` probes in `dsh-ops-boundary-report.md`.
 *
 * This suite is POSIX-only by construction and skips as a whole on win32:
 * every case here reasons about inode identity (`nlink`, `blocks`), permission
 * bits, or an atomic `rename` over a read-only inode, and none of those mean the
 * same thing on NTFS. A Windows run must not report a Linux-only check as
 * passed, and it must not fail for a Linux-only reason, so it skips visibly.
 *
 * What this suite locks in (each is real behaviour, observed and stable):
 *
 * - A successful replace writes the new content, advances `mtime`, and strands
 *   no `.<name>.dsh-ops-<uuid>` temp file.
 * - A replace is a rename of a new inode. Two visible consequences are asserted
 *   rather than treated as surprises: a hardlink sibling keeps the old content,
 *   and a sparse hole is materialised into real blocks. The second is report L8
 *   (a resource cost, not a correctness bug) and is asserted as the current
 *   contract so that adding hole preservation is a deliberate change.
 * - A `0444` target is replaced anyway: the directory write permission is what
 *   the rename needs, and the file mode is not a barrier. This is report F8.
 *
 * Intentional omissions, and why, in one place: the attribute loss itself was
 * report L1/L9 — a `0600` `.env` becoming world-readable, a `0755` script losing
 * its execute bit, POSIX ACLs and user xattrs disappearing. That is now **fixed**
 * and asserted by `test/file-metadata.test.mjs`, which owns the preservation
 * contract; this suite keeps owning inode identity and allocation.
 *
 * Two things are still not asserted here. L7 used to be one of them — a hard kill
 * stranding a hidden partial copy — and is now only half of one: the kill window is
 * still timing-dependent, so the *stranding* is not in a gate, but the recovery is,
 * in `test/linux-args.test.mjs`, which asserts that the next writer of the same file
 * reclaims the debris. The post-publication sync failure (L13) is not asserted
 * either: it needs a directory whose `fsync` fails after a rename that succeeded,
 * which no filesystem in this gate provides. Its contract — the failure reports
 * `effectState: "applied"` rather than the default `"none"` — is held by reading.
 *
 * @module dsh-ops/test/linux-attributes
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, skipSuite, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('linux-attributes')
if (process.platform === 'win32') {
  skipSuite('linux-attributes', 'inode identity, POSIX mode bits and sparse allocation are POSIX-only concepts')
}

/** Replace `OLD` with `NEW` through the native worker with write authority. */
const replace = (workspace, target) => callTool('replace', { path: target, pattern: 'OLD', replacement: 'NEW' }, { root: workspace, writeRoots: [workspace] })

await test('a successful replace writes the content, advances mtime and strands no temp file', async () => {
  await withTempDir('linux-attributes-basic', async workspace => {
    const target = path.join(workspace, 'clean.txt')
    fs.writeFileSync(target, 'OLD\n')
    const before = fs.statSync(target)
    await new Promise(resolve => setTimeout(resolve, 20))

    const applied = envelopeOf(await replace(workspace, target), assert)
    assert.equal(applied.status, 'completed', JSON.stringify(applied))
    assert.equal(applied.changed, 1)
    assert.equal(fs.readFileSync(target, 'utf8'), 'NEW\n')
    const after = fs.statSync(target)
    assert.ok(after.mtimeMs >= before.mtimeMs, `mtime must not go backwards: ${before.mtimeMs} -> ${after.mtimeMs}`)

    const debris = fs.readdirSync(workspace).filter(name => /^\..+\.dsh-ops-[0-9a-f-]+$/.test(name))
    assert.deepEqual(debris, [], 'a successful replace leaves no temp file')
  })
})

await test('a hardlink sibling keeps the old content because the replace renames a new inode', async () => {
  await withTempDir('linux-attributes-hardlink', async workspace => {
    const first = path.join(workspace, 'hard-a.txt')
    const second = path.join(workspace, 'hard-b.txt')
    fs.writeFileSync(first, 'OLD\n')
    fs.linkSync(first, second)
    assert.equal(fs.statSync(first).nlink, 2)

    const applied = envelopeOf(await replace(workspace, first), assert)
    assert.equal(applied.changed, 1)
    assert.equal(fs.readFileSync(first, 'utf8'), 'NEW\n')
    assert.equal(fs.readFileSync(second, 'utf8'), 'OLD\n', 'the sibling inode is not touched')
    assert.equal(fs.statSync(first).nlink, 1, 'the replaced name now points at a fresh inode')
  })
})

await test('a read-only file is replaced through the rename, and a sparse hole is materialised', async () => {
  await withTempDir('linux-attributes-inode', async workspace => {
    const readOnly = path.join(workspace, 'ro444.txt')
    fs.writeFileSync(readOnly, 'OLD\n')
    fs.chmodSync(readOnly, 0o444)
    const replaced = envelopeOf(await replace(workspace, readOnly), assert)
    assert.equal(replaced.changed, 1)
    assert.equal(fs.readFileSync(readOnly, 'utf8'), 'NEW\n', 'the rename is what needs write permission, not the inode')

    const sparse = path.join(workspace, 'sparse.bin')
    const handle = fs.openSync(sparse, 'w')
    fs.writeSync(handle, 'OLD\n')
    fs.ftruncateSync(handle, 1024 * 1024)
    fs.closeSync(handle)
    const before = fs.statSync(sparse)
    assert.ok(before.blocks * 512 < before.size, 'the fixture must start sparse')

    const rewritten = envelopeOf(await replace(workspace, sparse), assert)
    assert.equal(rewritten.status, 'completed', JSON.stringify(rewritten))
    const after = fs.statSync(sparse)
    assert.equal(after.size, before.size, 'apparent size is preserved')
    assert.ok(after.blocks * 512 >= after.size, `the hole became real blocks: ${before.blocks} -> ${after.blocks}`)
  })
})

report('linux-attributes')
