/**
 * The update sidecar is taken for writes that publish, and it is gone afterwards.
 *
 * `ops_replace` and the single-file tools serialize cooperating writers on a hidden
 * `.dsh-ops-update-<sha256 of the name>.lock` beside the target. The sidecar is
 * created on first use and removed by the writer that held it (#319), so a request
 * that publishes, and a request refused after the lock, both leave the directory
 * exactly as they found it.
 *
 * What this suite locks in:
 *
 * - Every single-file tool refuses a stale `expectedRevision` **before** the sidecar exists, and the
 *   target keeps its bytes.
 * - `EDIT_CONFLICT` — a pure function of the current bytes — also leaves no sidecar.
 * - A `copy`/`move` whose destination already exists leaves no destination sidecar.
 * - A dry run creates nothing: `write_file` and `edit_file` answer without a lock.
 * - A successful write leaves no sidecar behind: the guard removes the artifact it locked.
 *
 * Not asserted, and why: a writer killed between locking and release (`SIGKILL`, power
 * loss) cannot run a cleanup path, so it can leave a zero-byte sidecar. That residue is
 * not a stuck lock — the next writer of the same name binds to it, publishes under it
 * and removes it (`native/crates/ops-files/src/file_update_lock.rs`).
 *
 * @module dsh-ops/test/lock-sidecar
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('lock-sidecar')

/** The revision form the worker accepts: a lowercase SHA-256 of the bytes. */
const revisionOf = value => crypto.createHash('sha256').update(value).digest('hex')
/** The sidecar name for a target's base name, as the worker derives it. */
const sidecarOf = name => `.dsh-ops-update-${revisionOf(name.toLowerCase())}.lock`
/** The sidecars currently in a directory, sorted so a comparison is stable. */
const sidecars = directory => fs.readdirSync(directory).filter(entry => entry.endsWith('.lock')).sort()
/** A fixture written outside the worker, so the target starts without a sidecar. */
const fixture = (directory, name, content) => {
  const file = path.join(directory, name)
  fs.writeFileSync(file, content)
  return file
}

await test('a refused single-file request leaves no update sidecar', async () => {
  await withTempDir('lock-refused', async workspace => {
    const options = { root: workspace, writeRoots: [workspace] }
    const stale = revisionOf('not-the-current-bytes')
    const call = (tool, args) => callTool(tool, args, options)
    const assertRefused = (result, code, label) => {
      const body = envelopeOf(result, assert)
      assert.equal(body.status, 'error', `${label}: ${JSON.stringify(body)}`)
      assert.equal(body.error.code, code, `${label}: ${JSON.stringify(body)}`)
      return body
    }
    const assertNoNewSidecar = (name, before, label) => {
      assert.deepEqual(sidecars(workspace), before, `${label} must not create ${sidecarOf(name)}`)
      assert.equal(fs.existsSync(path.join(workspace, sidecarOf(name))), false, `${label} left a sidecar`)
    }

    // write_file: a stale revision is decided from the snapshot alone.
    const writeTarget = fixture(workspace, 'write.txt', 'original')
    assert.deepEqual(sidecars(workspace), [], 'the fixtures must start without a sidecar')
    assertRefused(await call('write_file', { path: writeTarget, content: 'next', expectedRevision: stale }), 'REVISION_CONFLICT', 'write stale revision')
    assert.equal(fs.readFileSync(writeTarget, 'utf8'), 'original', 'a refused write must keep the bytes')
    assertNoNewSidecar('write.txt', [], 'a refused write')

    // edit_file: the same pre-lock revision validation, then a pre-lock edit plan.
    const editTarget = fixture(workspace, 'edit.txt', 'alpha')
    assertRefused(await call('edit_file', { path: editTarget, edits: [{ oldText: 'alpha', newText: 'beta' }], expectedRevision: stale }), 'REVISION_CONFLICT', 'edit stale revision')
    assertNoNewSidecar('edit.txt', [], 'a refused edit')
    assertRefused(await call('edit_file', { path: editTarget, edits: [{ oldText: 'absent', newText: 'beta' }], expectedRevision: revisionOf('alpha') }), 'EDIT_CONFLICT', 'edit conflict')
    assertNoNewSidecar('edit.txt', [], 'an edit conflict')

    // copy: a stale source revision and an existing destination are both decided before the lock.
    const copySource = fixture(workspace, 'source.txt', 'payload')
    assertRefused(await call('copy', { path: copySource, to: path.join(workspace, 'copy.txt'), expectedRevision: stale }), 'REVISION_CONFLICT', 'copy stale revision')
    assertNoNewSidecar('copy.txt', [], 'a refused copy')
    fixture(workspace, 'existing.txt', 'already here')
    assertRefused(await call('copy', { path: copySource, to: path.join(workspace, 'existing.txt'), expectedRevision: revisionOf('payload') }), 'REVISION_CONFLICT', 'copy onto an existing destination')
    assertNoNewSidecar('existing.txt', [], 'a no-clobber copy')

    // move: a stale revision is refused before either sidecar (source or destination) exists.
    const moveSource = fixture(workspace, 'move-source.txt', 'payload')
    assertRefused(await call('move', { path: moveSource, to: path.join(workspace, 'move-dest.txt'), expectedRevision: stale }), 'REVISION_CONFLICT', 'move stale revision')
    assert.deepEqual(sidecars(workspace), [], 'a refused move must not create a source or destination sidecar')
    assert.equal(fs.existsSync(moveSource), true, 'a refused move must keep the source')

    // remove: a stale revision is refused before the lock and the file survives.
    const removeTarget = fixture(workspace, 'remove.txt', 'keep')
    assertRefused(await call('remove', { path: removeTarget, expectedRevision: stale }), 'REVISION_CONFLICT', 'remove stale revision')
    assert.deepEqual(sidecars(workspace), [], 'a refused remove must not create a sidecar')
    assert.equal(fs.existsSync(removeTarget), true, 'a refused remove must keep the file')
  })
})

await test('a dry run answers without creating the update sidecar', async () => {
  await withTempDir('lock-dry-run', async workspace => {
    const options = { root: workspace, writeRoots: [workspace] }
    const target = fixture(workspace, 'dry.txt', 'original')

    const written = envelopeOf(await callTool('write_file', { path: target, content: 'next', expectedRevision: revisionOf('original'), dryRun: true }, options), assert)
    assert.equal(written.dryRun, true, JSON.stringify(written))
    assert.equal(written.changed, 0, JSON.stringify(written))

    const edited = envelopeOf(await callTool('edit_file', { path: target, edits: [{ oldText: 'original', newText: 'next' }], expectedRevision: revisionOf('original'), dryRun: true }, options), assert)
    assert.equal(edited.dryRun, true, JSON.stringify(edited))

    assert.deepEqual(sidecars(workspace), [], 'a dry run changes nothing on disk, including the lock sidecar')
    assert.equal(fs.readFileSync(target, 'utf8'), 'original')
  })
})

await test('a write that publishes leaves no sidecar behind', async () => {
  // #319: the sidecar used to be permanent, so every write left one file per target
  // name in the operator's directory. The guard that holds the exclusive lock now
  // removes it on release, in the same step that releases the lock.
  await withTempDir('lock-success', async workspace => {
    const options = { root: workspace, writeRoots: [workspace] }
    const target = fixture(workspace, 'publish.txt', 'original')
    const beforeEach = sidecars(workspace)
    assert.deepEqual(beforeEach, [], 'the fixture starts without a sidecar')
    const done = envelopeOf(await callTool('write_file', { path: target, content: 'next', expectedRevision: revisionOf('original') }, options), assert)
    assert.equal(done.status, 'completed', JSON.stringify(done))
    assert.equal(fs.readFileSync(target, 'utf8'), 'next')
    assert.deepEqual(sidecars(workspace), [], 'a published write must not leave its lock sidecar')
    assert.deepEqual(fs.readdirSync(workspace), ['publish.txt'], 'the directory holds nothing but the target')

    // A second write to the same name behaves the same: nothing accumulates.
    const again = envelopeOf(await callTool('write_file', { path: target, content: 'third', expectedRevision: revisionOf('next') }, options), assert)
    assert.equal(again.status, 'completed', JSON.stringify(again))
    assert.deepEqual(fs.readdirSync(workspace), ['publish.txt'], 'repeated writes leave no artifact either')
  })
})

await test('a leftover sidecar from a killed writer is reused and then removed', async () => {
  // A `SIGKILL` cannot run the cleanup path, so that residue — and only that — can
  // exist on disk. It must not block the next write, and the writer that finishes
  // under it removes it, so debris cannot accumulate across sessions.
  await withTempDir('lock-leftover', async workspace => {
    const options = { root: workspace, writeRoots: [workspace] }
    const target = fixture(workspace, 'orphan.txt', 'original')
    fs.writeFileSync(path.join(workspace, sidecarOf('orphan.txt')), '')

    const done = envelopeOf(await callTool('write_file', { path: target, content: 'next', expectedRevision: revisionOf('original') }, options), assert)
    assert.equal(done.status, 'completed', JSON.stringify(done))
    assert.equal(fs.readFileSync(target, 'utf8'), 'next')
    assert.deepEqual(sidecars(workspace), [], 'the writer that finished removes the leftover it reused')
  })
})

report('lock-sidecar')
