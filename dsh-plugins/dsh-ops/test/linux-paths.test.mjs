/**
 * Path and filename boundaries, ported from the ad-hoc `A-paths` probes in
 * `dsh-ops-boundary-report.md`.
 *
 * What this suite locks in (all documented behaviour, not accidents):
 *
 * - Awkward and CJK names round-trip byte-for-byte, and multibyte text does not
 *   shift a reported line number.
 * - The traversal budget and the name budget are both honest: 60 levels of
 *   nesting are traversable, a basename at the 255-byte POSIX limit is
 *   readable, and one over the limit is a structured `IO_ERROR`, never a crash.
 * - `.` / `..` segments and a trailing separator are refused: the worker takes
 *   exactly one absolute host-resolved path, and normalizing a spelling is the
 *   host bridge's job (`lib/file/worker.js` does it before spawning).
 * - Symlinks are refused everywhere — an explicit path, a dangling one, and one
 *   that never leaves the root. Report section 5.1 records that the original
 *   probe expected the in-root symlink to resolve; that expectation was wrong,
 *   and the refusal below is the boundary, asserted on purpose.
 * - Hidden entries and `.git` are skipped by traversal but reachable by an
 *   explicit path.
 *
 * Platform. Everything except the 255-byte basename rule, the non-UTF-8 name
 * and the NUL byte is platform-neutral and runs on win32 too. Those three are
 * POSIX-only and guarded per case: NTFS uses UTF-16 code units for its name
 * budget, Node cannot materialise a lone 0xff byte on win32, and win32 rejects
 * NUL in a path before the worker sees it.
 *
 * Intentional omission: none of the defects this suite once skipped are open.
 * The hex-view offset defect (report L2) is fixed and covered by
 * `test/inspect-hex.test.mjs`, and `limit`-bounds-lines (L4) by
 * `test/output-budget.test.mjs`.
 *
 * @module dsh-ops/test/linux-paths
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('linux-paths')

const POSIX = process.platform !== 'win32'

/** A directory under the runner's throwaway home is the session root. */
const fixture = workspace => ({
  at: (...segments) => path.join(workspace, ...segments),
  write: (name, text = `${name}\n`) => {
    const target = path.join(workspace, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
    return target
  },
})

/** Glob returns bare path strings; accept one regardless of the envelope shape. */
const globPaths = (envelope, workspace) => envelope.items.map(item => (typeof item === 'string' ? item : path.resolve(workspace, item.path)))

await test('every awkward filename round-trips through glob and an explicit read', async () => {
  await withTempDir('linux-paths-names', async workspace => {
    const { at, write } = fixture(workspace)
    const names = [
      '中文文件名.txt',
      'emoji-😀-🎉.txt',
      'with space.txt',
      ...(POSIX ? ['tab\there.txt', "quote'and\"double.txt", 'semi;colon&amp|pipe.txt', 'star*and?glob.txt'] : []),
      'dollar$and`backtick`.txt',
      '--looks-like-a-flag.txt',
      'bracket[1]{2}.txt',
    ]
    for (const name of names) write(name)
    // A literal newline in a name is legal on POSIX and impossible on win32.
    if (POSIX) names.push('newline\nhere.txt')
    for (const name of names) write(name)
    const globbed = envelopeOf(await callTool('glob', { path: workspace, pattern: ['**/*'] }, { root: workspace }), assert)
    assert.equal(globbed.status, 'completed')
    const returned = globPaths(globbed, workspace)
    for (const name of names) {
      assert.ok(
        returned.some(item => item.endsWith(name)),
        `${JSON.stringify(name)} missing from ${JSON.stringify(returned)}`,
      )
    }
    for (const name of names) {
      const read = envelopeOf(await callTool('inspect_local_file', { path: at(name) }, { root: workspace }), assert)
      assert.equal(read.status, 'completed', JSON.stringify(read))
      // Content defaults to the name plus a newline, so the first line is the
      // name itself even for the one name that contains a newline.
      assert.equal(read.items[0].text, name.split('\n')[0], 'the file matches the name it was written for')
    }
  })
})

await test('CJK content survives read, replace and grep without shifting a line number', async () => {
  await withTempDir('linux-paths-cjk', async workspace => {
    const { at, write } = fixture(workspace)
    const target = write('中文内容.txt', '你好，世界\n第二行\n')
    const read = envelopeOf(await callTool('inspect_local_file', { path: target }, { root: workspace }), assert)
    assert.equal(read.items.map(item => item.text).join('\n'), '你好，世界\n第二行')

    write('grep.txt', 'line one\n关键词在第二行\nline three\n')
    const grepped = envelopeOf(await callTool('grep', { path: workspace, pattern: '关键词', lineNumbers: true }, { root: workspace }), assert)
    assert.equal(grepped.matched, 1)
    assert.equal(grepped.items[0].line, 2, 'a multibyte line must not shift the count')

    // An empty write-root list refuses every write; a declared root lets the CJK
    // pattern and replacement both apply to the CJK filename. (An absent
    // `write_roots` key means "unrestricted", which is the host lane's job to
    // never send; the sandbox suite pins the empty-list refusal.)
    write('待改.txt', '旧值\n')
    const refused = envelopeOf(await callTool('replace', { path: at('待改.txt'), pattern: '旧值', replacement: '新值' }, { root: workspace, writeRoots: [] }), assert)
    assert.equal(refused.error?.code, 'POLICY_DENIED', JSON.stringify(refused))
    assert.equal(fs.readFileSync(at('待改.txt'), 'utf8'), '旧值\n', 'the refused write changed nothing')
    const applied = envelopeOf(await callTool('replace', { path: at('待改.txt'), pattern: '旧值', replacement: '新值' }, { root: workspace, writeRoots: [workspace] }), assert)
    assert.equal(applied.changed, 1)
    assert.equal(fs.readFileSync(at('待改.txt'), 'utf8'), '新值\n')
  })
})

await test('60 levels of nesting and dot segments resolve to the same file', async () => {
  await withTempDir('linux-paths-depth', async workspace => {
    const deep = Array.from({ length: 60 }, (_, index) => `d${index}`).reduce((base, name) => path.join(base, name), workspace)
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, 'deep.txt'), 'deep\n')
    const globbed = envelopeOf(await callTool('glob', { path: workspace, pattern: ['**/deep.txt'] }, { root: workspace }), assert)
    assert.equal(globbed.matched, 1)
    const direct = envelopeOf(await callTool('inspect_local_file', { path: path.join(deep, 'deep.txt') }, { root: workspace }), assert)
    assert.equal(direct.status, 'completed')

    fs.writeFileSync(path.join(workspace, 'norm.txt'), 'n\n')
    // The native worker accepts exactly one absolute, host-resolved path. The
    // host bridge normalizes `.` and `..` before it spawns the worker, so the
    // worker's refusal here is the boundary, not a failure to normalize.
    const normalized = path.join(workspace, 'sub', '..', 'norm.txt')
    assert.equal(normalized, path.join(workspace, 'norm.txt'), 'the host normalizes before the call')
    assert.equal(envelopeOf(await callTool('inspect_local_file', { path: normalized }, { root: workspace }), assert).status, 'completed')
    for (const spelling of ['./norm.txt', 'sub/../norm.txt']) {
      const refused = envelopeOf(await callTool('inspect_local_file', { path: spelling }, { root: workspace }), assert)
      assert.equal(refused.error?.code, 'INVALID_ARGUMENT', `${spelling} was accepted: ${JSON.stringify(refused)}`)
    }
    const trailing = await callTool('inspect_local_file', { path: path.join(workspace, 'norm.txt') + '/' }, { root: workspace })
    assert.equal(trailing.body.error?.code, 'INVALID_ARGUMENT', 'a trailing separator is refused, not silently trimmed')
  })
})

await test('hidden entries and .git are skipped by traversal but readable by exact path', async () => {
  await withTempDir('linux-paths-hidden', async workspace => {
    const { at, write } = fixture(workspace)
    write('.hidden.txt', 'h\n')
    write('.git/config', 'g\n')
    const globbed = envelopeOf(await callTool('glob', { path: workspace, pattern: ['**/*'] }, { root: workspace }), assert)
    const traversed = globPaths(globbed, workspace)
    assert.equal(traversed.some(item => item.includes(`${path.sep}.git${path.sep}`) || item.includes('/.git/')), false, JSON.stringify(traversed))
    assert.equal(traversed.some(item => item.endsWith('.hidden.txt')), false)
    const direct = envelopeOf(await callTool('inspect_local_file', { path: at('.hidden.txt') }, { root: workspace }), assert)
    assert.equal(direct.items[0].text, 'h')
    const deep = envelopeOf(await callTool('inspect_local_file', { path: at('.git/config') }, { root: workspace }), assert)
    assert.equal(deep.items[0].text, 'g')
  })
})

await test('a symlink is refused even when it stays inside the root', async () => {
  await withTempDir('linux-paths-links', async workspace => {
    if (!POSIX) return
    const { at, write } = fixture(workspace)
    const real = write('real.txt', 'real\n')
    const outside = fs.mkdtempSync(path.join(workspace, '..', 'boundary-outside-'))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-CONTENT\n')
    try {
      fs.symlinkSync(real, at('in-root.txt'))
      fs.symlinkSync(path.join(outside, 'secret.txt'), at('escaping.txt'))
      fs.symlinkSync(at('does-not-exist.txt'), at('dangling.txt'))
      fs.mkdirSync(at('linked-dir'))
      fs.symlinkSync(outside, at('linked-dir/alias'))

      for (const name of ['in-root.txt', 'escaping.txt', 'dangling.txt']) {
        const refused = envelopeOf(await callTool('inspect_local_file', { path: at(name) }, { root: workspace }), assert)
        assert.equal(refused.status, 'error', `${name} was traversed: ${JSON.stringify(refused)}`)
        assert.equal(refused.error.code, 'PATH_RESTRICTED', `${name} => ${refused.error.code}`)
        assert.match(refused.error.message, /not traversed/)
      }
      const globbed = envelopeOf(await callTool('glob', { path: workspace, pattern: ['**/*'] }, { root: workspace }), assert)
      assert.equal(globPaths(globbed, workspace).some(item => item.includes('secret.txt')), false, 'a symlinked directory was traversed')
      // The plain file beside the links is still readable: refusal is about links,
      // not about the directory that holds them.
      assert.equal(envelopeOf(await callTool('inspect_local_file', { path: real }, { root: workspace }), assert).status, 'completed')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

await test('a basename at the POSIX 255-byte limit is readable; a longer one is a structured error', async () => {
  if (!POSIX) return
  await withTempDir('linux-paths-basename', async workspace => {
    const { at, write } = fixture(workspace)
    const name = `${'a'.repeat(251)}.txt`
    assert.equal(Buffer.byteLength(name), 255)
    write(name, 'limit\n')
    assert.equal(envelopeOf(await callTool('inspect_local_file', { path: at(name) }, { root: workspace }), assert).status, 'completed')

    const tooLong = `${'b'.repeat(300)}.txt`
    let created = true
    try { fs.writeFileSync(at(tooLong), 'x') } catch { created = false }
    // Either the filesystem refuses the name itself (ENAMETOOLONG) or it accepts
    // it and the worker refuses the open; both answers are the same structured
    // error and neither may be a crash or a hang.
    const refused = envelopeOf(await callTool('inspect_local_file', { path: at(tooLong) }, { root: workspace }), assert)
    assert.equal(refused.status, 'error', `created=${created} ${JSON.stringify(refused)}`)
    assert.equal(refused.error.code, 'IO_ERROR')
    assert.match(refused.error.message, /File name too long/)
  })
})

await test('a directory, a missing file and a NUL path each get a structured refusal', async () => {
  await withTempDir('linux-paths-errors', async workspace => {
    const { at } = fixture(workspace)
    const directory = envelopeOf(await callTool('inspect_local_file', { path: workspace }, { root: workspace }), assert)
    assert.equal(directory.status, 'error')
    assert.equal(directory.error.code, 'INVALID_ARGUMENT')
    assert.match(directory.error.message, /path is a directory/)

    const missing = envelopeOf(await callTool('inspect_local_file', { path: at('definitely-missing.txt') }, { root: workspace }), assert)
    assert.equal(missing.status, 'error')
    assert.equal(missing.error.code, 'NOT_FOUND')

    if (POSIX) {
      // win32 rejects a NUL in a path before Node can hand it to the worker.
      const nul = envelopeOf(await callTool('inspect_local_file', { path: at('a\u0000b.txt') }, { root: workspace }), assert)
      assert.equal(nul.status, 'error')
      assert.equal(nul.error.code, 'INVALID_ARGUMENT')
    }
  })
})

await test('a non-UTF-8 filename survives without a protocol failure', async () => {
  if (process.platform !== 'linux') return // APFS rejects invalid UTF-8 names before they reach the worker.
  await withTempDir('linux-paths-bytes', async workspace => {
    const raw = Buffer.concat([Buffer.from(`${workspace}/`), Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74])])
    let created = true
    try { fs.writeFileSync(raw, 'latin\n') } catch { created = false }
    assert.equal(created, true, 'this host cannot create a non-UTF-8 name')
    const globbed = envelopeOf(await callTool('glob', { path: workspace, pattern: ['**/*'] }, { root: workspace }), assert)
    assert.equal(globbed.status, 'completed')
    const read = await callTool('inspect_local_file', { path: raw.toString('utf8') }, { root: workspace })
    assert.ok(read.body !== null || read.exitCode !== null, 'the worker neither answered nor exited')
    assert.equal(read.timedOut, false)
  })
})

report('linux-paths')
