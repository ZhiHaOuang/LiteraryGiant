/** Real-worker read_files observations and exact single-file edit_file semantics. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, callWorker, request, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('file-batching-worker')
const hash = value => createHash('sha256').update(value).digest('hex')
const run = async (root, tool, args, options = {}) => envelopeOf(await callTool(tool, args, { root, ...options }), assert)
const send = async input => envelopeOf(await callWorker(JSON.stringify(input)), assert)
const snapshot = root => fs.readdirSync(root, { recursive: true }).sort()
const noEffects = body => {
  assert.equal(body.status, 'error', JSON.stringify(body))
  assert.equal(body.error.effectState, 'none')
  assert.equal(body.error.retryable, false)
}

await test('four files retain exact ranges, LF facts, revisions, and empty-file completeness', async () => {
  await withTempDir('many-ranges', async root => {
    const texts = ['one\r\ntwo\rthree\nlast\n', '', '\n', 'first\nsecond\nthird']
    const files = texts.map((text, index) => {
      const file = path.join(root, `${index}.txt`); fs.writeFileSync(file, text); return { path: file }
    })
    const body = await run(root, 'read_files', { files: [{ ...files[0], offset: 2, limit: 1 }, files[1], files[2], { ...files[3], offset: 2 }] }, { readOnly: true })
    assert.equal(body.status, 'partial'); assert.equal(body.complete, false)
    assert.equal(body.items.length, 4); assert.equal(body.nextIndex, 4); assert.equal(body.pending, 0)
    assert.equal(body.failed, 0); assert.equal(body.effectState, 'none')
    for (let index = 0; index < 4; index++) {
      const file = body.items[index]
      assert.equal(file.path, files[index].path)
      assert.equal(file.revision, hash(texts[index])); assert.equal(file.bytes, Buffer.byteLength(texts[index]))
      assert.equal(file.lineCount, [3, 0, 1, 3][index])
    }
    assert.deepEqual(body.items[0].items.map(({ line, text }) => ({ line, text })), [{ line: 2, text: 'two\rthree' }])
    assert.equal(body.items[0].complete, false); assert.equal(body.items[0].nextOffset, 3)
    assert.deepEqual(body.items[1].items, []); assert.equal(body.items[1].complete, true)
    assert.deepEqual(body.items[2].items.map(item => item.text), [''])
    assert.deepEqual(body.items[3].items.map(item => item.line), [2, 3]); assert.equal(body.items[3].complete, true)
    const complete = await run(root, 'read_files', { files })
    assert.equal(complete.status, 'completed'); assert.equal(complete.complete, true)
    assert.equal(complete.pending, 0); assert.equal(complete.nextAction, undefined)
    assert.deepEqual(snapshot(root), ['0.txt', '1.txt', '2.txt', '3.txt'])
  })
})

await test('descriptors are strict and bounded before observations, with a 200-line default', async () => {
  await withTempDir('many-bounds', async root => {
    const file = path.join(root, 'file.txt'); fs.writeFileSync(file, `${'line\n'.repeat(201)}`)
    const first = await run(root, 'read_files', { files: [{ path: file }] })
    assert.equal(first.items[0].items.length, 200); assert.equal(first.items[0].nextOffset, 201)
    assert.equal(first.complete, false)
    const last = await run(root, 'read_files', { files: [{ path: file, offset: 201 }] })
    assert.equal(last.complete, true); assert.equal(last.items[0].items.length, 1)
    const cases = [
      { files: [] }, { files: Array(33).fill({ path: file }) }, { files: [{ path: file }], unknown: true },
      ...[0, -1, 1.5].map(offset => ({ files: [{ path: file }, { path: file, offset }] })),
      ...[0, -1, 10001, 1.5].map(limit => ({ files: [{ path: file }, { path: file, limit }] })),
      ...['encoding', 'view', 'unknown'].map(key => ({ files: [{ path: file, [key]: 'text' }] })),
    ]
    for (const args of cases) {
      const value = await run(root, 'read_files', args)
      noEffects(value); assert.equal(value.error.code, 'INVALID_ARGUMENT'); assert.equal(value.items, undefined)
    }
    const maximum = await run(root, 'read_files', { files: Array(32).fill({ path: file, offset: 201, limit: 10000 }) })
    assert.equal(maximum.complete, true); assert.equal(maximum.items.length, 32)
    assert.deepEqual(snapshot(root), ['file.txt'])
  })
})

await test('per-file missing, directory, UTF-8, and size failures preserve successful neighbors', async () => {
  await withTempDir('many-errors', async root => {
    const good = path.join(root, 'good.txt'); fs.writeFileSync(good, 'visible\n')
    const binary = path.join(root, 'binary'); fs.writeFileSync(binary, Buffer.from([255, 254]))
    const large = path.join(root, 'large'); const fd = fs.openSync(large, 'w')
    try { fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1) } finally { fs.closeSync(fd) }
    const paths = [good, path.join(root, 'missing'), root, binary, large, good]
    const before = snapshot(root)
    const body = await run(root, 'read_files', { files: paths.map(path => ({ path })) }, { readOnly: true })
    assert.equal(body.status, 'partial'); assert.equal(body.complete, false)
    assert.equal(body.items.length, 6); assert.equal(body.failed, 4); assert.equal(body.pending, 0)
    assert.equal(body.items[0].items[0].text, 'visible'); assert.equal(body.items[5].revision, hash('visible\n'))
    for (let index = 1; index <= 4; index++) {
      const item = body.items[index]; noEffects(item)
      assert.equal(item.path, paths[index]); assert.equal(item.complete, false); assert.deepEqual(item.items, [])
      assert.equal(item.error.code, ['NOT_FOUND', 'INVALID_ARGUMENT', 'ERR_INVALID_ENCODING', 'OUTPUT_LIMIT'][index - 1])
    }
    assert.match(body.items[3].error.nextAction, /hex/)
    assert.deepEqual(snapshot(root), before)
  })
})

await test('each batched file rechecks credential roots, names, and no-follow without read artifacts', async () => {
  await withTempDir('many-authority', async root => {
    const good = path.join(root, 'good.txt'); fs.writeFileSync(good, 'safe')
    const secret = path.join(root, 'vault'); fs.mkdirSync(secret)
    fs.writeFileSync(path.join(secret, 'token'), 'DO_NOT_DISCLOSE')
    const credential = path.join(root, '.env'); fs.writeFileSync(credential, 'SECRET')
    const link = path.join(root, 'linked'); fs.symlinkSync(secret, link, process.platform === 'win32' ? 'junction' : 'dir')
    const files = [good, path.join(secret, 'token'), credential, path.join(link, 'token')].map(path => ({ path }))
    const before = snapshot(root)
    for (const readOnly of [false, true]) {
      const input = request('read_files', { files }, { root, readOnly, writeRoots: [] })
      input.deny_roots = [secret]; input.deny_credential_names = true
      const body = await send(input)
      assert.equal(body.items[0].items[0].text, 'safe')
      assert.equal(body.items[1].error.code, 'CREDENTIAL_DENIED')
      assert.equal(body.items[2].error.code, 'CREDENTIAL_DENIED')
      assert.equal(body.items[3].error.code, 'PATH_RESTRICTED')
      assert.equal(body.complete, false); assert.equal(body.failed, 3)
      assert.doesNotMatch(JSON.stringify(body), /DO_NOT_DISCLOSE|SECRET/)
      for (const item of body.items.slice(1)) noEffects(item)
      assert.deepEqual(snapshot(root), before)
    }
  })
})

await test('one escaped huge line retains its prefix and receipts within the aggregate 96KiB cap', async () => {
  await withTempDir('many-budget', async root => {
    // The long directory/path is part of the encoded budget, not an assumed 96-byte header.
    const directory = path.join(root, 'p'.repeat(90)); fs.mkdirSync(directory)
    const file = path.join(directory, `${'f'.repeat(90)}.txt`)
    const text = '\0"\\中'.repeat(100000); fs.writeFileSync(file, text)
    const files = [file, file, file, file].map(path => ({ path }))
    for (const tool of ['read_files', 'inspect_local_file']) {
      const raw = await callTool(tool, tool === 'read_files' ? { files } : { path: file }, { root })
      assert.ok(Buffer.byteLength(raw.stdout) <= 96 * 1024, `${tool}: ${Buffer.byteLength(raw.stdout)} bytes`)
      const body = envelopeOf(raw, assert)
      const observed = tool === 'read_files' ? body.items[0] : body
      assert.equal(observed.complete, false); assert.equal(observed.truncated, true)
      assert.equal(observed.nextOffset, 1, 'a partial line is not consumed')
      assert.equal(observed.omitted, 1)
      assert.equal(observed.revision, hash(text)); assert.equal(observed.bytes, Buffer.byteLength(text)); assert.equal(observed.lineCount, 1)
      assert.equal(observed.items.length, 1)
      const item = observed.items[0]
      assert.equal(item.truncatedInLine, true); assert.ok(item.text.length > 0)
      assert.ok(text.startsWith(item.text)); assert.equal(item.bytesTotal, Buffer.byteLength(text))
      assert.equal(item.bytesOmitted, Buffer.byteLength(text) - Buffer.byteLength(item.text))
      assert.match(observed.nextAction, /view=hex/)
      if (tool === 'read_files') {
        assert.equal(body.status, 'partial'); assert.equal(body.nextIndex, 1); assert.equal(body.pending, 3)
        assert.equal(body.items.length, 1); assert.equal(body.complete, false)
      }
    }
    const tail = path.join(root, 'tail.txt'); fs.writeFileSync(tail, 'remaining')
    const mixedRaw = await callTool('read_files', { files: [{ path: tail }, { path: file }, { path: tail }] }, { root })
    assert.ok(Buffer.byteLength(mixedRaw.stdout) <= 96 * 1024)
    const mixed = envelopeOf(mixedRaw, assert)
    assert.equal(mixed.items[0].complete, true); assert.equal(mixed.items[0].items[0].text, 'remaining')
    assert.equal(mixed.items[1].items[0].truncatedInLine, true)
    assert.equal(mixed.nextIndex, 2); assert.equal(mixed.pending, 1); assert.equal(mixed.complete, false)
    const resumed = await run(root, 'read_files', { files: [{ path: tail }] })
    assert.equal(resumed.complete, true); assert.equal(resumed.items[0].items[0].text, 'remaining')
  })
})

await test('transport clipping identifies read_files as read-only even in a writable session', async () => {
  await withTempDir('many-transport', async root => {
    const file = path.join(root, 'large.txt'); fs.writeFileSync(file, 'x'.repeat(2000))
    const raw = await callWorker(JSON.stringify({ version: 1, requestId: 'many-output', component: 'file', budget: { timeoutMs: 30000, maxBytes: 1024 }, request: request('read_files', { files: [{ path: file }] }, { root, readOnly: false }) }))
    const body = envelopeOf(raw, assert)
    assert.ok(Buffer.byteLength(raw.stdout) <= 1024)
    noEffects(body); assert.equal(body.error.code, 'OUTPUT_LIMIT')
    assert.deepEqual(snapshot(root), ['large.txt'])
  })
})

await test('edit_file applies unique nonoverlapping edits once and shares edit_file dry-run receipts', async () => {
  await withTempDir('many-edits', async root => {
    const file = path.join(root, 'file.txt'); const text = 'alpha\nbeta\ngamma\n'; fs.writeFileSync(file, text)
    const args = { path: file, expectedRevision: hash(text), edits: [{ oldText: 'alpha', newText: 'A' }, { oldText: 'gamma', newText: 'G' }] }
    const before = snapshot(root)
    const dry = await run(root, 'edit_file', { ...args, dryRun: true })
    const legacy = await run(root, 'edit_file', { ...args, dryRun: true })
    assert.deepEqual(dry, legacy); assert.equal(dry.complete, true)
    assert.equal(fs.readFileSync(file, 'utf8'), text); assert.deepEqual(snapshot(root), before)
    const value = await run(root, 'edit_file', args)
    assert.equal(value.status, 'completed'); assert.equal(value.changed, 1); assert.equal(value.complete, true)
    assert.equal(value.items[0].revisionBefore, hash(text)); assert.equal(value.revision, hash('A\nbeta\nG\n'))
    assert.equal(fs.readFileSync(file, 'utf8'), 'A\nbeta\nG\n')
    assert.equal(value.items.length, 1)
    assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false)
  })
})

await test('edit_file CAS, ambiguity, overlap, and authority refusals leave no effects or sidecars', async () => {
  await withTempDir('many-edits-refused', async root => {
    const file = path.join(root, 'file.txt'); const text = 'alpha beta gamma alpha'; fs.writeFileSync(file, text)
    const args = { path: file, expectedRevision: hash(text), edits: [{ oldText: 'beta', newText: 'B' }, { oldText: 'gamma', newText: 'G' }] }
    const before = snapshot(root)
    const cases = [
      [{ ...args, expectedRevision: '0'.repeat(64) }, {}, 'REVISION_CONFLICT'],
      [{ ...args, edits: [...args.edits, { oldText: 'missing', newText: 'M' }] }, {}, 'EDIT_CONFLICT'],
      [{ ...args, edits: [...args.edits, { oldText: 'alpha', newText: 'A' }] }, {}, 'EDIT_CONFLICT'],
      [{ ...args, edits: [args.edits[0], { oldText: 'beta gamma', newText: 'BG' }] }, {}, 'EDIT_CONFLICT'],
      [args, { readOnly: true }, 'POLICY_DENIED'], [args, { writeRoots: [] }, 'POLICY_DENIED'],
      [{ files: [args] }, {}, 'INVALID_ARGUMENT'],
    ]
    for (const [input, options, code] of cases) {
      const value = await run(root, 'edit_file', input, options)
      noEffects(value); assert.equal(value.error.code, code)
      assert.equal(fs.readFileSync(file, 'utf8'), text); assert.deepEqual(snapshot(root), before)
    }
    const denied = request('edit_file', args, { root }); denied.deny_roots = [file]
    const refusal = await send(denied); noEffects(refusal); assert.equal(refusal.error.code, 'CREDENTIAL_DENIED')
    assert.deepEqual(snapshot(root), before)
  })
})
report('file-batching-worker')
