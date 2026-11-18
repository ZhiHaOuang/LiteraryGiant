/** Real-worker spill boundaries: exact recovery, coverage, effects, and independent cache authority. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callWorker, request, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('result-spill')
const tools = ['inspect_local_file', 'read_files', 'grep', 'glob', 'diff', 'replace', 'result']
const fixture = body => withTempDir('spill', async root => {
  const cache = path.join(root, 'cache'); const work = path.join(root, 'work')
  fs.mkdirSync(cache, { mode: 0o700 }); fs.mkdirSync(work); await body(work, cache)
})
const input = (root, cache, tool, args, options = {}) => ({ version: 1, requestId: 'spill-test', component: 'file',
  budget: { timeoutMs: 30000, maxBytes: options.maxBytes ?? 4096 },
  storage: { root: cache, authorityId: 'a'.repeat(64), allowedTools: tools },
  request: { ...request(tool, args, { root, scope: 'spill-session', writeRoots: [root], readOnly: options.readOnly }), ...options.authority } })
async function send(value) {
  const raw = await callWorker(JSON.stringify(value)); const output = envelopeOf(raw, assert)
  assert.ok(Buffer.byteLength(raw.stdout) <= value.budget.maxBytes, raw.stdout.slice(0, 256)); return output
}
const call = (root, cache, tool, args, options) => send(input(root, cache, tool, args, options))
function reconstruct(records) {
  const items = []; let chunks = [], bytes = 0
  for (const row of records) {
    assert.equal(row.index, items.length, 'logical index is contiguous')
    if (row.kind === 'item') { assert.equal(chunks.length, 0); items.push(row.value); continue }
    assert.equal(row.kind, 'item-json-chunk'); assert.equal(row.chunk, chunks.length)
    assert.equal(row.byteOffset, bytes); chunks.push(row.text); bytes += Buffer.byteLength(row.text)
    if (row.complete) { items.push(JSON.parse(chunks.join(''))); chunks = []; bytes = 0 }
  }
  assert.equal(chunks.length, 0, 'no unfinished logical JSON item can be stored'); return items
}
async function collect(root, cache, handle, options = {}) {
  assert.match(handle.reference?.refId ?? '', /^ref:\/\/spill-session\//)
  assert.equal(fs.realpathSync.native(handle.referenceRoot), fs.realpathSync.native(root))
  const records = []; let offset = 0, source
  do {
    const page = await call(handle.referenceRoot, cache, 'result', { action: 'page', id: handle.reference.refId, offset, limit: 512, maxBytes: 65536 }, { maxBytes: 131072, ...options })
    assert.equal(page.storageError, undefined); assert.ok(page.items?.length > 0, JSON.stringify(page))
    assert.equal(page.source.itemEncoding, 'tagged-json-v1'); assert.equal(page.reference.refId, handle.reference.refId)
    assert.equal(page.nextOffset, offset + page.items.length); records.push(...page.items); offset = page.nextOffset
    if (source) assert.deepEqual(page.source, source); source = page.source
    if (page.complete) break
    assert.ok(offset < handle.reference.totalItems)
  } while (true)
  assert.equal(records.length, handle.reference.totalItems)
  const items = reconstruct(records); assert.equal(items.length, source.capturedItems)
  return { items, source, records }
}
await test('oversized escaped UTF-8 lines recover every byte after inline clipping, including readonly paging', async () => {
  await fixture(async (root, cache) => {
    const text = '中😀\0"\\'.repeat(12000) + 'LAST-SUFFIX'
    const file = path.join(root, 'large.txt'); fs.writeFileSync(file, text)
    const head = await call(root, cache, 'inspect_local_file', { path: file })
    assert.equal(head.status, 'completed'); assert.equal(head.complete, false); assert.equal(head.truncated, true)
    assert.ok(head.items[0].text.length > 0); assert.equal(head.items[0].truncatedInLine, true)
    assert.equal(head.nextOffset, 1); assert.equal(head.storageError, undefined)
    const page = await collect(root, cache, head, { readOnly: true })
    assert.equal(page.source.complete, true); assert.equal(page.source.captureComplete, true)
    assert.equal(page.items.length, 1); assert.equal(page.items[0].text, text)
    assert.ok(page.records.length > 1); assert.equal(page.items[0].truncatedInLine, undefined)
    const other = path.join(root, 'other'); fs.mkdirSync(other)
    const wrong = await call(other, cache, 'result', { action: 'page', id: head.reference.refId })
    assert.equal(wrong.error.code, 'POLICY_DENIED')
    const narrowed = input(root, cache, 'result', { action: 'page', id: head.reference.refId }); narrowed.storage.allowedTools = ['result']
    assert.equal((await send(narrowed)).error.code, 'POLICY_DENIED')
  })
})
await test('read_files captures all canonical files and failures beyond the inline prefix', async () => {
  await fixture(async (root, cache) => {
    const contents = ['huge'.repeat(40000), 'one\r\ntwo\nthree', '', null]
    const files = contents.map((text, index) => { const file = path.join(root, `${index}.txt`); if (text !== null) fs.writeFileSync(file, text); return { path: file, ...(index === 1 ? { offset: 2, limit: 1 } : {}) } })
    const head = await call(root, cache, 'read_files', { files }); const page = await collect(root, cache, head)
    assert.equal(head.failed, 1); assert.equal(head.matched, 3)
    assert.equal(page.items.length, 4); assert.equal(page.source.failed, 1); assert.equal(page.source.pending, 0)
    assert.equal(page.source.status, 'partial'); assert.equal(page.source.complete, false); assert.equal(page.source.captureComplete, true)
    assert.equal(page.items[0].items[0].text, contents[0]); assert.equal(page.items[0].complete, true)
    assert.equal(page.items[1].items[0].text, 'two'); assert.equal(page.items[1].items[0].line, 2)
    assert.equal(page.items[1].nextOffset, 3); assert.equal(page.items[1].complete, false)
    assert.equal(page.items[2].lineCount, 0); assert.equal(page.items[2].complete, true)
    assert.equal(page.items[3].error.code, 'NOT_FOUND'); assert.equal(page.items[3].complete, false)
  })
})
await test('search snapshots preserve incomplete traversal facts and stay frozen after file changes', async () => {
  await fixture(async (root, cache) => {
    const text = 'needle '.repeat(20000); const file = path.join(root, 'a.txt'); fs.writeFileSync(file, text)
    fs.writeFileSync(path.join(root, 'bad.bin'), Buffer.from([0xff]))
    const head = await call(root, cache, 'grep', { path: root, pattern: 'needle', limit: 10 })
    assert.equal(head.scanComplete, false); assert.equal(head.matchedTotal, undefined)
    fs.writeFileSync(file, 'changed after observation')
    const page = await collect(root, cache, head)
    assert.equal(page.source.scanComplete, false); assert.equal(page.source.matchedTotal, undefined)
    assert.equal(page.source.skipReasons['invalid-encoding'], 1); assert.equal(page.source.captureComplete, true)
    assert.equal(page.items[0].text, text); assert.match(page.source.nextAction, /Narrow/)
  })
})
await test('a complete search spills only its requested page and retains honest row-limit continuation', async () => {
  await fixture(async (root, cache) => {
    fs.writeFileSync(path.join(root, 'many.txt'), Array.from({ length: 8 }, (_, i) => `needle${i} ${'x'.repeat(2500)}`).join('\n'))
    const head = await call(root, cache, 'grep', { path: root, pattern: 'needle', offset: 2, limit: 3 })
    const page = await collect(root, cache, head)
    assert.equal(head.truncatedBy, 'output-budget'); assert.equal(head.pageComplete, false)
    assert.equal(page.source.scanComplete, true); assert.equal(page.source.matchedTotal, 8)
    assert.equal(page.source.complete, false); assert.equal(page.source.pageComplete, true)
    assert.equal(page.source.nextOffset, 5); assert.equal(page.source.truncatedBy, 'row-limit')
    assert.ok(page.source.continuation); assert.deepEqual(page.items.map(item => item.line), [3, 4, 5])
  })
})
await test('10 MiB capture quota keeps preceding complete items and never stores a partial JSON item', async () => {
  await fixture(async (root, cache) => {
    fs.writeFileSync(path.join(root, 'huge.txt'), `prefix\n${'q'.repeat(11 * 1024 * 1024)}\nafter`)
    const head = await call(root, cache, 'inspect_local_file', { path: path.join(root, 'huge.txt') })
    assert.equal(head.storageError.code, 'QUOTA_EXCEEDED'); assert.equal(head.storageError.effectState, 'applied')
    assert.ok(head.reference.totalBytes < 10 * 1024 * 1024)
    const page = await collect(root, cache, head)
    assert.equal(page.source.captureComplete, false); assert.equal(page.source.complete, true)
    assert.equal(page.items.length, 1); assert.equal(page.items[0].text, 'prefix')
    assert.equal(page.records.length, 1)
  })
})
await test('readonly and credential-refused cache spills return bounded heads without creating artifacts', async () => {
  await fixture(async (root, cache) => {
    const file = path.join(root, 'large.txt'); fs.writeFileSync(file, 'data'.repeat(40000))
    for (const options of [{ readOnly: true }, { authority: { deny_roots: [cache] } }]) {
      const head = await call(root, cache, 'inspect_local_file', { path: file }, options)
      assert.equal(head.status, 'completed'); assert.equal(head.complete, false); assert.equal(head.reference, undefined)
      assert.ok(['POLICY_DENIED', 'CREDENTIAL_DENIED'].includes(head.storageError.code))
      assert.equal(head.storageError.effectState, 'none'); assert.ok(head.items[0].text.length > 0)
      assert.deepEqual(fs.readdirSync(cache), [])
    }
  })
})
await test('a metadata-starved budget creates no unreachable reference and reports incomplete output', async () => {
  await fixture(async (root, cache) => {
    const file = path.join(root, 'long.txt'); fs.writeFileSync(file, 'z'.repeat(30000))
    const payload = input(root, cache, 'inspect_local_file', { path: file }, { maxBytes: 1024 }); payload.request.scope = 'long-session-'.repeat(19)
    const head = await send(payload)
    assert.equal(head.status, 'completed'); assert.equal(head.complete, false); assert.equal(head.reference, undefined)
    assert.equal(head.storageError.code, 'OUTPUT_LIMIT'); assert.deepEqual(fs.readdirSync(cache), [])
  })
})
await test('result pages never spill a second handle and unchanged small observations create no cache', async () => {
  await fixture(async (root, cache) => {
    const file = path.join(root, 'small.txt'); fs.writeFileSync(file, 'one\ntwo')
    const small = await call(root, cache, 'inspect_local_file', { path: file })
    assert.equal(small.complete, true); assert.equal(small.reference, undefined); assert.deepEqual(fs.readdirSync(cache), [])
    const put = await call(root, cache, 'result', { action: 'put', items: [{ text: 'x'.repeat(80000) }] }, { maxBytes: 131072 })
    const page = await call(root, cache, 'result', { action: 'page', id: put.id, maxBytes: 65536 }, { maxBytes: 131072 })
    assert.equal(page.error.code, 'OUTPUT_LIMIT'); assert.equal(page.reference, undefined)
    assert.equal(fs.readdirSync(cache, { recursive: true }).filter(name => name.endsWith('.json')).length, 1)
  })
})
await test('cache failure after replacement preserves successful mutation receipts and never advises repeating the write', async () => {
  await fixture(async (root, cache) => {
    const files = Array.from({ length: 20 }, (_, i) => path.join(root, `target-${i}.txt`))
    for (const file of files) fs.writeFileSync(file, 'replace this marker')
    const head = await call(root, cache, 'replace', { path: root, pattern: 'marker', replacement: 'changed' }, { authority: { deny_roots: [cache] } })
    assert.equal(head.status, 'completed'); assert.equal(head.changed, 20); assert.equal(head.matched, 20)
    assert.equal(head.complete, false); assert.equal(head.storageError.code, 'CREDENTIAL_DENIED')
    assert.equal(head.storageError.effectState, 'none'); assert.equal(head.reference, undefined)
    assert.match(head.nextAction, /do not repeat mutations/)
    for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'replace this changed')
    assert.deepEqual(fs.readdirSync(cache), [])
  })
})
await test('spilled mutation source retains final changed counts and per-file postconditions', async () => {
  await fixture(async (root, cache) => {
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `target-${i}.txt`), 'marker')
    const head = await call(root, cache, 'replace', { path: root, pattern: 'marker', replacement: 'published' })
    const page = await collect(root, cache, head)
    assert.equal(head.changed, 20); assert.equal(page.source.changed, 20); assert.equal(page.source.complete, true)
    assert.equal(page.items.length, 20); assert.ok(page.items.every(item => item.replacements === 1 && /^[a-f0-9]{64}$/.test(item.revisionAfter)))
    assert.ok(page.items.every(item => fs.readFileSync(item.path, 'utf8') === 'published'))
  })
})
await test('hex spill retains 1-based row resumption and exact requested bytes', async () => {
  await fixture(async (root, cache) => {
    const file = path.join(root, 'binary.bin'); const bytes = Buffer.alloc(32000, 0xaa); fs.writeFileSync(file, bytes)
    const head = await call(root, cache, 'inspect_local_file', { path: file, view: 'hex', offset: 3, limit: 1000 })
    assert.equal(head.nextOffset, 3); assert.equal(head.complete, false)
    const page = await collect(root, cache, head)
    assert.equal(page.source.nextOffset, 1003); assert.equal(page.source.complete, false)
    assert.equal(page.items[0].offset, 32); assert.equal(page.items[0].text.replaceAll(' ', ''), bytes.subarray(32, 16032).toString('hex'))
  })
})
await test('glob string rows and display omitted counts survive a smaller transport budget', async () => {
  await fixture(async (root, cache) => {
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, `${String(i).padStart(2, '0')}-${'longname'.repeat(8)}.txt`), '')
    const head = await call(root, cache, 'glob', { path: root, pattern: ['*.txt'] })
    assert.equal(head.omitted, 40); assert.equal(head.nextOffset, 0)
    const page = await collect(root, cache, head)
    assert.equal(page.source.complete, true); assert.equal(page.source.omitted, 0)
    assert.equal(page.items.length, 40); assert.ok(page.items.every(item => typeof item === 'string'))
  })
})
report("result-spill")
