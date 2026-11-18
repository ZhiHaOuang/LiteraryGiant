/** Bounded table parsing through the real one-shot worker, including reference recovery. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callWorker, request, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('table-worker')
const hash = value => createHash('sha256').update(value).digest('hex')
const snapshot = root => fs.readdirSync(root, { recursive: true }).sort()
const quoted = text => `"${text.replaceAll('"', '""')}"`
const payload = (root, args, options = {}) => ({ version: 1, requestId: 'table-test', component: 'file',
  budget: { timeoutMs: 30000, maxBytes: options.maxBytes ?? 131072 },
  ...(options.cache ? { storage: { root: options.cache, authorityId: 'a'.repeat(64), allowedTools: ['read_table', 'result'] } } : {}),
  request: { ...request(options.tool ?? 'read_table', args, { root, readOnly: options.readOnly, writeRoots: [] }), ...options.authority } })
async function send(value) {
  const raw = await callWorker(JSON.stringify(value)); const output = envelopeOf(raw, assert)
  assert.ok(Buffer.byteLength(raw.stdout) <= value.budget.maxBytes); return output
}
const run = (root, args, options) => send(payload(root, args, options))
const fileAt = (root, name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file }
function gap(body, code) {
  assert.equal(body.status, 'partial'); assert.equal(body.error.code, code); assert.equal(body.error.effectState, 'none')
  assert.equal(body.scanComplete, false); assert.equal(body.complete, false)
  for (const field of ['total', 'rowCount', 'revision']) assert.equal(body[field], undefined, `${field} requires a complete scan`)
}
await test('CSV preserves lexical cells, duplicate/empty headers, quoted commas, escaped quotes and physical LF ranges', async () => {
  await withTempDir('table-csv', async root => {
    const text = '\ufeffname,name,,value\r\n"alpha,beta","q""q",,"two\r\nlines"\r\n0001,TRUE,,2026-10-19\r\n'
    const file = fileAt(root, 'values.csv', text); const body = await run(root, { path: file })
    assert.equal(body.status, 'completed'); assert.equal(body.complete, true); assert.equal(body.scanComplete, true)
    assert.deepEqual(body.columns, ['name', 'name', '', 'value']); assert.equal(body.columnCount, 4)
    assert.deepEqual(body.items, [{ row: 1, cells: ['alpha,beta', 'q"q', '', 'two\r\nlines'], lineStart: 2, lineEnd: 3 },
      { row: 2, cells: ['0001', 'TRUE', '', '2026-10-19'], lineStart: 4, lineEnd: 4 }])
    assert.equal(body.rowCount, 2); assert.equal(body.revision, hash(text)); assert.equal(body.bytesRead, Buffer.byteLength(text))
    assert.equal(body.encoding, 'utf-8'); assert.equal(body.format, 'csv'); assert.equal(body.nextOffset, 3)
  })
})
await test('TSV inference and headerless/empty records have no phantom trailing row', async () => {
  await withTempDir('table-tsv', async root => {
    const file = fileAt(root, 'values.TSV', 'a\t"b\tc"\t\nx\t""\tz\n')
    const body = await run(root, { path: file, header: false })
    assert.equal(body.format, 'tsv'); assert.deepEqual(body.columns, []); assert.equal(body.columnCount, 3)
    assert.deepEqual(body.items.map(item => item.cells), [['a', 'b\tc', ''], ['x', '', 'z']]); assert.equal(body.total, 2)
    for (const [text, count] of [['', 0], ['\ufeff', 0], ['\n\n', 2], ['a,\n', 1]]) {
      const observed = await run(root, { path: fileAt(root, 'empty.csv', text), header: false })
      assert.equal(observed.total, count); assert.equal(observed.complete, true)
    }
    const headerOnly = await run(root, { path: fileAt(root, 'header.csv', 'a,b\n') })
    assert.equal(headerOnly.total, 0); assert.deepEqual(headerOnly.columns, ['a', 'b']); assert.deepEqual(headerOnly.items, [])
  })
})
await test('bounded row pages keep full observed totals separate from page completeness', async () => {
  await withTempDir('table-pages', async root => {
    const file = fileAt(root, 'rows.csv', 'id\n' + Array.from({ length: 500 }, (_, i) => i + 1).join('\n'))
    const first = await run(root, { path: file })
    assert.equal(first.items.length, 200); assert.equal(first.nextOffset, 201); assert.equal(first.complete, false)
    assert.equal(first.pageComplete, true); assert.equal(first.rowCount, 500); assert.equal(first.rowsObserved, 500)
    assert.equal(first.omitted, 300); assert.equal(first.truncatedBy, 'row-limit')
    const tail = await run(root, { path: file, offset: 499, limit: 2 })
    assert.deepEqual(tail.items.map(item => item.cells), [['499'], ['500']]); assert.equal(tail.complete, true); assert.equal(tail.nextOffset, 501)
    const after = await run(root, { path: file, offset: 999 })
    assert.equal(after.complete, true); assert.deepEqual(after.items, []); assert.equal(after.nextOffset, 999)
    assert.equal(after.skipped, 500, "skipped counts observed rows, not the requested offset")
    const empty = await run(root, { path: fileAt(root, "empty.csv", "id\n"), offset: 999 })
    assert.equal(empty.skipped, 0); assert.equal(empty.rowsObserved, 0)
  })
})
await test('UTF-16 byte orders decode strictly and all conflicting BOMs are refused', async () => {
  await withTempDir('table-encoding', async root => {
    const text = '\ufeffname,value\n中,😀\n'; const le = Buffer.from(text, 'utf16le'); const be = Buffer.from(le).swap16()
    for (const [encoding, bytes] of [['utf-16le', le], ['utf-16be', be]]) {
      const file = fileAt(root, `${encoding}.csv`, bytes); const body = await run(root, { path: file, encoding })
      assert.equal(body.encoding, encoding); assert.deepEqual(body.items[0].cells, ['中', '😀']); assert.equal(body.revision, hash(bytes))
    }
    const cases = [[le, 'utf-8'], [le, 'utf-16be'], [be, 'utf-8'], [be, 'utf-16le'], [Buffer.from(text), 'utf-16be'], [Buffer.from(text), 'utf-16le']]
    for (const [bytes, encoding] of cases) {
      const body = await run(root, { path: fileAt(root, 'mismatch.csv', bytes), encoding })
      assert.equal(body.error.code, 'ERR_INVALID_ENCODING'); assert.equal(body.error.effectState, 'none'); assert.equal(body.items, undefined)
    }
  })
})
await test('malformed encoding after safe rows never emits replacement characters or a full total', async () => {
  await withTempDir('table-invalid', async root => {
    const cases = [
      [Buffer.concat([Buffer.from('v\nsafe\n'), Buffer.from([0xff])]), 'utf-8'],
      [Buffer.concat([Buffer.from('v\nsafe\n'), Buffer.from([0xf0, 0x9f])]), 'utf-8'],
      [Buffer.concat([Buffer.from('v\nsafe\n', 'utf16le'), Buffer.from([0, 0xd8])]), 'utf-16le'],
      [Buffer.concat([Buffer.from('v\nsafe\n', 'utf16le'), Buffer.from([0, 0xdc])]), 'utf-16le'],
      [Buffer.concat([Buffer.from('v\nsafe\n', 'utf16le'), Buffer.from([1])]), 'utf-16le'],
    ]
    for (const [bytes, encoding] of cases) {
      const body = await run(root, { path: fileAt(root, 'bad.csv', bytes), encoding, limit: 1 })
      gap(body, 'ERR_INVALID_ENCODING'); assert.equal(body.truncatedBy, 'encoding'); assert.equal(body.pageComplete, true)
      assert.deepEqual(body.items.map(item => item.cells), [['safe']]); assert.doesNotMatch(JSON.stringify(body.items), /�/)
    }
  })
})
await test('malformed quote/column records preserve only preceding complete rows', async () => {
  await withTempDir('table-malformed', async root => {
    for (const suffix of ['"unfinished', 'un"quoted', '"closed" suffix', 'x,y', 'bare\rnext']) {
      const body = await run(root, { path: fileAt(root, 'bad.csv', 'v\nsafe\n' + suffix) })
      gap(body, 'TABLE_PARSE_ERROR'); assert.equal(body.truncatedBy, 'parse-error')
      assert.deepEqual(body.items.map(item => item.cells), [['safe']]); assert.equal(body.rowsObserved, 1)
    }
  })
})
await test('strict argument errors happen before reads and do not create artifacts', async () => {
  await withTempDir('table-args', async root => {
    const file = fileAt(root, 'data.csv', 'a\nb'); const before = snapshot(root)
    for (const bad of [{ offset: 0 }, { offset: 100001 }, { limit: 0 }, { limit: 1001 }, { format: 'auto' }, { header: 'yes' }, { unknown: true }]) {
      const body = await run(root, { path: file, ...bad }); assert.equal(body.error.code, 'INVALID_ARGUMENT'); assert.equal(body.error.effectState, 'none')
    }
    assert.equal((await run(root, { path: file, encoding: 'latin1' })).error.code, 'ERR_INVALID_ENCODING')
    assert.deepEqual(snapshot(root), before)
  })
})
await test('readonly observations retain credential/no-follow checks and create no audit/cache files', async () => {
  await withTempDir('table-authority', async root => {
    const good = fileAt(root, 'good.csv', 'v\nsafe'); const secret = path.join(root, 'vault'); fs.mkdirSync(secret)
    const privateFile = fileAt(secret, 'secret.csv', 'v\nDO_NOT_DISCLOSE'); const credential = fileAt(root, '.env', 'v\nSECRET')
    const linked = path.join(root, 'linked'); fs.symlinkSync(secret, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const before = snapshot(root)
    const options = { readOnly: true, authority: { deny_roots: [secret], deny_credential_names: true } }
    assert.equal((await run(root, { path: good }, options)).items[0].cells[0], 'safe')
    for (const [file, code] of [[privateFile, 'CREDENTIAL_DENIED'], [credential, 'CREDENTIAL_DENIED'], [path.join(linked, 'secret.csv'), 'PATH_RESTRICTED'], [root, 'IS_DIRECTORY']]) {
      const body = await run(root, { path: file }, options); assert.equal(body.error.code, code); assert.equal(body.error.effectState, 'none')
      assert.doesNotMatch(JSON.stringify(body), /DO_NOT_DISCLOSE|SECRET/)
    }
    assert.deepEqual(snapshot(root), before)
  })
})
await test('record, header, column and scan-record caps never label an unobserved suffix complete', async () => {
  await withTempDir('table-caps', async root => {
    for (const text of ['v\nsafe\n' + 'x'.repeat(1024 * 1024 + 1), 'v\nsafe\n' + Array(1025).fill('x').join(','), 'x'.repeat(9000) + '\nvalue']) {
      const body = await run(root, { path: fileAt(root, 'capped.csv', text) }); gap(body, 'OUTPUT_LIMIT')
      assert.equal(body.truncatedBy, 'scan-budget'); assert.match(body.nextAction, /does not bypass physical scan limits/)
    }
    const exact = await run(root, { path: fileAt(root, 'exact.csv', 'v\n' + 'x\n'.repeat(100000)), offset: 100000, limit: 1 })
    assert.equal(exact.scanComplete, true); assert.equal(exact.rowCount, 100000); assert.equal(exact.complete, true)
    const cap = await run(root, { path: fileAt(root, 'over.csv', 'v\n' + 'x\n'.repeat(100001)), offset: 100000, limit: 1 })
    gap(cap, 'OUTPUT_LIMIT'); assert.equal(cap.rowsObserved, 100000); assert.equal(cap.items[0].row, 100000)
  })
})
await test('32 MiB streamed scan cap retains safe rows without fabricating a revision', async () => {
  await withTempDir('table-byte-cap', async root => {
    const file = fileAt(root, 'large.csv', 'v\n' + ('x'.repeat(4096) + '\n').repeat(8193))
    const body = await run(root, { path: file, limit: 1 }); gap(body, 'OUTPUT_LIMIT')
    assert.equal(body.items.length, 1); assert.ok(body.rowsObserved > 0 && body.rowsObserved < 10000)
    assert.ok(body.bytesRead <= 32 * 1024 * 1024 + 1); assert.equal(body.pageComplete, true)
  })
})
await test('large table cells spill before clipping and recover as exact typed records', async () => {
  await withTempDir('table-spill', async root => {
    const cache = path.join(root, 'cache'); fs.mkdirSync(cache, { mode: 0o700 })
    const text = '中😀\0"\\'.repeat(10000); const file = fileAt(root, 'large.csv', `value\n${quoted(text)}\nlast`)
    const head = await run(root, { path: file }, { cache, maxBytes: 4096 })
    assert.ok(head.reference); assert.equal(head.nextOffset, 1); assert.equal(head.complete, false)
    const records = []; let offset = 0, source
    do {
      const page = await run(head.referenceRoot, { action: 'page', id: head.reference.refId, offset, limit: 512, maxBytes: 65536 }, { cache, tool: 'result', readOnly: true })
      assert.equal(page.error, undefined); source = page.source; records.push(...page.items)
      assert.ok(page.nextOffset > offset); offset = page.nextOffset; if (page.complete) break
    } while (true)
    assert.equal(source.rowCount, 2); assert.equal(source.captureComplete, true); assert.equal(source.itemEncoding, 'tagged-json-v1')
    const rows = []; let chunks = [], byteOffset = 0
    for (const record of records) {
      assert.equal(record.index, rows.length)
      if (record.kind === 'item') { assert.equal(chunks.length, 0); rows.push(record.value); continue }
      assert.equal(record.chunk, chunks.length); assert.equal(record.byteOffset, byteOffset)
      chunks.push(record.text); byteOffset += Buffer.byteLength(record.text)
      if (record.complete) { rows.push(JSON.parse(chunks.join(''))); chunks = []; byteOffset = 0 }
    }
    assert.equal(chunks.length, 0); assert.deepEqual(rows.map(row => row.cells), [[text], ['last']])
    const empty = path.join(root, 'empty-cache'); fs.mkdirSync(empty, { mode: 0o700 })
    const readonly = await run(root, { path: file }, { cache: empty, maxBytes: 4096, readOnly: true })
    assert.equal(readonly.reference, undefined); assert.equal(readonly.storageError.code, 'POLICY_DENIED'); assert.deepEqual(fs.readdirSync(empty), [])
  })
})
await test('read_table transport overflow remains a read-only operation in writable sessions', async () => {
  await withTempDir('table-transport', async root => {
    const file = fileAt(root, 'large.csv', 'v\n' + 'x'.repeat(40000)); const before = snapshot(root)
    const body = await run(root, { path: file }, { maxBytes: 1024 })
    assert.equal(body.error.code, 'OUTPUT_LIMIT'); assert.equal(body.error.effectState, 'none'); assert.deepEqual(snapshot(root), before)
  })
})
report('table-worker')
