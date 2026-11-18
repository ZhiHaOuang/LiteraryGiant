/**
 * Sandbox authority and special-object boundaries, ported from the ad-hoc
 * `C-sandbox` probes in `dsh-ops-boundary-report.md`.
 *
 * What this suite locks in (all documented refusals):
 *
 * - `read_only: true` refuses `replace` with `POLICY_DENIED` and leaves the file
 *   byte-identical.
 * - `write_roots` is the containment fence: a declared root admits the write, an
 *   absent target root is `POLICY_DENIED` with the file untouched, and an empty
 *   list refuses every write.
 * - Nothing that lives behind a link is traversed: a symlink is refused whether
 *   it points outside the root or back inside it (report section 5.1 records
 *   that the original probe expected in-root links to resolve; the refusal is
 *   the intended policy and is asserted here).
 * - Special objects (`/dev/null`, `/dev/zero`, `/proc/self/status`, a FIFO, a
 *   unix socket) are refused in single-digit milliseconds. Refusing before the
 *   open is what makes `/dev/zero` safe: an implementation that opened it first
 *   would consume memory without bound, and this suite would time out.
 * - A read-only directory fails `ACCESS_DENIED` and leaves no `.dsh-ops-` temp
 *   file behind.
 *
 * Platform. `write_roots` is by definition never what a Windows run exercises
 * (the POSIX root list is empty there), so every case that names a root is
 * guarded: the authority cases run only where the fixture path can be a real
 * containment root. Special objects and 0555 directories are POSIX-only and are
 * guarded behind one check each.
 *
 * Intentional omission: the absolute-path read escape (upstream issue #75). It
 * is a known open security gap, not a boundary; on this lane it is also
 * host-owned (the native worker is handed a resolved path and is not the
 * component that decides read confinement), so there is nothing here to
 * assert on either side of the gap.
 *
 * @module dsh-ops/test/linux-sandbox
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('linux-sandbox')

const POSIX = process.platform !== 'win32'

/** Write a one-line file and return its path. */
const seed = (workspace, name, text = 'a\n') => {
  const target = path.join(workspace, name)
  fs.writeFileSync(target, text)
  return target
}

await test('read_only and an empty write-root list both refuse a replace and change nothing', async () => {
  await withTempDir('linux-sandbox-authority', async workspace => {
    const target = seed(workspace, 'ro.txt')

    const readOnly = envelopeOf(await callTool('replace', { path: target, pattern: 'a', replacement: 'b' }, { root: workspace, readOnly: true, writeRoots: [workspace] }), assert)
    assert.equal(readOnly.status, 'error')
    assert.equal(readOnly.error.code, 'POLICY_DENIED')
    assert.equal(fs.readFileSync(target, 'utf8'), 'a\n', 'a refused write must not touch the file')

    const noRoot = envelopeOf(await callTool('replace', { path: target, pattern: 'a', replacement: 'b' }, { root: workspace, writeRoots: [] }), assert)
    assert.equal(noRoot.error?.code, 'POLICY_DENIED')
    assert.equal(fs.readFileSync(target, 'utf8'), 'a\n')

    const admitted = envelopeOf(await callTool('replace', { path: target, pattern: 'a', replacement: 'b' }, { root: workspace, writeRoots: [workspace] }), assert)
    assert.equal(admitted.status, 'completed')
    assert.equal(admitted.changed, 1)
    assert.equal(fs.readFileSync(target, 'utf8'), 'b\n')
  })
})

await test('write_roots containment: a target outside every root is refused, a target inside one is applied', async () => {
  await withTempDir('linux-sandbox-roots', async workspace => {
    const inside = path.join(workspace, 'inside')
    const outside = path.join(workspace, 'outside')
    fs.mkdirSync(inside)
    fs.mkdirSync(outside)
    const insideFile = seed(inside, 'in.txt')
    const outsideFile = seed(outside, 'out.txt')

    const refused = envelopeOf(await callTool('replace', { path: outsideFile, pattern: 'a', replacement: 'b' }, { root: workspace, writeRoots: [inside] }), assert)
    assert.equal(refused.error?.code, 'POLICY_DENIED', JSON.stringify(refused))
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'a\n', 'the refused target is untouched')

    const applied = envelopeOf(await callTool('replace', { path: insideFile, pattern: 'a', replacement: 'b' }, { root: workspace, writeRoots: [inside] }), assert)
    assert.equal(applied.status, 'completed')
    assert.equal(fs.readFileSync(insideFile, 'utf8'), 'b\n')
  })
})

await test('a symlink is refused before any open, inside or outside the root', async () => {
  await withTempDir('linux-sandbox-links', async workspace => {
    if (!POSIX) return
    const real = seed(workspace, 'real.txt', 'real\n')
    const outside = fs.mkdtempSync(path.join(workspace, '..', 'sandbox-outside-'))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-CONTENT\n')
    try {
      const escaping = path.join(workspace, 'escaping.txt')
      const inside = path.join(workspace, 'inside.txt')
      fs.symlinkSync(path.join(outside, 'secret.txt'), escaping)
      fs.symlinkSync(real, inside)
      for (const [label, target] of [['escaping', escaping], ['in-root', inside]]) {
        const refused = envelopeOf(await callTool('inspect_local_file', { path: target }, { root: workspace }), assert)
        assert.equal(refused.status, 'error', `${label}: ${JSON.stringify(refused)}`)
        assert.equal(refused.error.code, 'PATH_RESTRICTED', `${label} => ${refused.error.code}`)
        assert.match(refused.error.message, /not traversed/)
      }
      // The link target itself is still readable by its real name, so the refusal
      // is about the link, not about the file behind it.
      assert.equal(envelopeOf(await callTool('inspect_local_file', { path: real }, { root: workspace }), assert).status, 'completed')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

await test('special objects are refused in milliseconds rather than opened', async () => {
  if (!POSIX) return
  await withTempDir('linux-sandbox-special', async workspace => {
    const fifo = path.join(workspace, 'pipe.fifo')
    const { execFileSync } = await import('node:child_process')
    execFileSync('mkfifo', [fifo])

    const socketRoot = process.platform === 'darwin' ? fs.mkdtempSync('/private/tmp/dsh-sock-') : workspace
    const socketPath = path.join(socketRoot, 's.sock')
    const server = net.createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      for (const target of ['/dev/null', '/dev/zero', ...(process.platform === 'linux' ? ['/proc/self/status'] : []), fifo, socketPath]) {
        const started = Date.now()
        const refused = envelopeOf(await callTool('inspect_local_file', { path: target }, { root: workspace, timeoutMs: 8_000 }), assert)
        assert.equal(refused.status, 'error', `${target} was opened: ${JSON.stringify(refused)}`)
        assert.equal(refused.error.code, 'PATH_RESTRICTED', `${target} => ${refused.error.code}`)
        assert.match(refused.error.message, /not traversed/)
        assert.ok(Date.now() - started < 5_000, `${target} took ${Date.now() - started} ms; it must be refused before the open`)
      }
    } finally {
      await new Promise(resolve => server.close(resolve))
      if (socketRoot !== workspace) fs.rmSync(socketRoot, { recursive: true, force: true })
    }
  })
})

await test('a read-only directory fails with ACCESS_DENIED and leaves no temp file behind', async () => {
  if (!POSIX) return
  await withTempDir('linux-sandbox-rodir', async workspace => {
    const directory = path.join(workspace, 'rodir')
    fs.mkdirSync(directory)
    const target = path.join(directory, 'f.txt')
    fs.writeFileSync(target, 'a\n')
    fs.chmodSync(directory, 0o555)
    try {
      const refused = envelopeOf(await callTool('replace', { path: target, pattern: 'a', replacement: 'b' }, { root: workspace, writeRoots: [workspace] }), assert)
      assert.equal(refused.status, 'error', JSON.stringify(refused))
      assert.equal(refused.error.code, 'ACCESS_DENIED')
      assert.equal(fs.readFileSync(target, 'utf8'), 'a\n')
      assert.deepEqual(fs.readdirSync(directory), ['f.txt'], 'a failed write must not strand a temp file')
    } finally {
      fs.chmodSync(directory, 0o755)
    }
  })
})

report('linux-sandbox')
