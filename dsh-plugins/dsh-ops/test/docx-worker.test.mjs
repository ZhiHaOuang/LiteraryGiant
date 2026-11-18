/** Real one-shot DOCX reads: bounded ZIP/XML, honest scope and durable spill recovery. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callWorker, request, envelopeOf, requireWorker } from './lib/boundary.mjs'
import { docx, zip, parts, document, paragraph, word, types, rels } from './lib/document-fixture.mjs'
requireWorker('docx-worker')
const fileAt = (root, bytes, name = 'document.docx') => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file }
async function run(root, args, options = {}) {
  const payload = { version: 1, requestId: 'docx-test', component: 'file', budget: { timeoutMs: 30000, maxBytes: options.maxBytes ?? 131072 },
    ...(options.cache ? { storage: { root: options.cache, authorityId: 'a'.repeat(64), allowedTools: ['read_docx', 'result'] } } : {}),
    request: { ...request(options.tool ?? 'read_docx', args, { root, readOnly: options.readOnly, writeRoots: [] }), ...options.authority } }
  const raw = await callWorker(JSON.stringify(payload)); assert.ok(Buffer.byteLength(raw.stdout) <= payload.budget.maxBytes)
  return envelopeOf(raw, assert)
}
function failure(body, code) { assert.equal(body.error.code, code, JSON.stringify(body)); assert.equal(body.error.effectState, 'none'); assert.notEqual(body.complete, true); assert.equal(body.revision, undefined); assert.equal(body.total, undefined) }
await test('stored and deflated DOCX preserve lexical Unicode paragraphs, controls and table coordinates', async () => {
  await withTempDir('docx-text', async root => {
    const content = paragraph('  中😀 &amp; &lt; &#65;  ') + '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t><w:noBreakHyphen/><w:softHyphen/></w:r></w:p>' + '<w:tbl><w:tr><w:tc>' + paragraph('one') + paragraph('two') + '</w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>'
    for (const deflate of [false, true]) {
      const bytes = docx(content, { deflate }), body = await run(root, { path: fileAt(root, bytes) })
      assert.equal(body.status, 'completed'); assert.equal(body.complete, true); assert.equal(body.scanComplete, true)
      assert.equal(body.scope, 'main-body-paragraphs'); assert.ok(body.excludedContent.includes('headers and footers'))
      assert.deepEqual(body.items, [{ block: 1, type: 'paragraph', text: '  中😀 & < A  ' }, { block: 2, type: 'paragraph', text: 'A\tB\nC\u2011\u00ad' },
        { block: 3, type: 'paragraph', text: 'one', table: 1, row: 1, cell: 1 }, { block: 4, type: 'paragraph', text: 'two', table: 1, row: 1, cell: 1 }, { block: 5, type: 'paragraph', text: '', table: 1, row: 1, cell: 2 }])
      assert.equal(body.total, 5); assert.equal(body.revision, createHash('sha256').update(bytes).digest('hex')); assert.equal(body.nextOffset, 6)
    }
  })
})
await test('namespace prefixes, strict Word namespace and BOM-marked UTF-16 remain exact', async () => {
  await withTempDir('docx-encoding', async root => {
    for (const be of [false, true]) {
      const xml = '\ufeff' + document(paragraph('中😀')).replaceAll('UTF-8', 'UTF-16').replaceAll('w:', 'x:').replace('xmlns:w', 'xmlns:x').replaceAll(word, 'http://purl.oclc.org/ooxml/wordprocessingml/main')
      const bytes = Buffer.from(xml, 'utf16le'); if (be) bytes.swap16()
      const body = await run(root, { path: fileAt(root, zip(parts(bytes))) }); assert.equal(body.complete, true); assert.equal(body.items[0].text, '中😀')
    }
    for (const xml of [Buffer.concat([Buffer.from(document(paragraph('ok'))), Buffer.from([0xff])]), Buffer.from(document(paragraph('ok')).replace('UTF-8', 'UTF-16')), Buffer.from([0xff, 0xfe, 0, 0xd8])]) {
      failure(await run(root, { path: fileAt(root, zip(parts(xml))) }), 'ERR_INVALID_ENCODING')
    }
  })
})
await test('paragraph paging reports full totals separately and empty documents have no phantom item', async () => {
  await withTempDir('docx-pages', async root => {
    const file = fileAt(root, docx(Array.from({ length: 205 }, (_, i) => paragraph(String(i + 1))).join('')))
    const first = await run(root, { path: file }); assert.equal(first.items.length, 200); assert.equal(first.nextOffset, 201); assert.equal(first.total, 205); assert.equal(first.scanComplete, true); assert.equal(first.pageComplete, true); assert.equal(first.complete, false)
    const last = await run(root, { path: file, offset: 201, limit: 5 }); assert.deepEqual(last.items.map(i => i.text), ['201', '202', '203', '204', '205']); assert.equal(last.complete, true)
    const beyond = await run(root, { path: file, offset: 999 }); assert.equal(beyond.skipped, 205); assert.deepEqual(beyond.items, []); assert.equal(beyond.complete, true)
    const empty = await run(root, { path: fileAt(root, docx('')) }); assert.equal(empty.total, 0); assert.deepEqual(empty.items, []); assert.equal(empty.complete, true)
    for (const args of [{ offset: 0 }, { offset: 100001 }, { limit: 0 }, { limit: 1001 }, { unknown: true }]) failure(await run(root, { path: file, ...args }), 'INVALID_ARGUMENT')
  })
})
await test('unsupported body content and malformed suffix preserve only safe preceding paragraphs without totals', async () => {
  await withTempDir('docx-partial', async root => {
    for (const suffix of ['<w:p><w:r><w:drawing/></w:r></w:p>', '<w:ins>' + paragraph('revision') + '</w:ins>', '<w:p><w:r><w:fldChar/></w:r></w:p>', '<w:unknown/>', '<w:altChunk/>']) {
      const body = await run(root, { path: fileAt(root, docx(paragraph('safe') + suffix)), limit: 1 }); failure(body, 'UNSUPPORTED_DOCUMENT'); assert.equal(body.status, 'partial'); assert.equal(body.scanComplete, false); assert.equal(body.pageComplete, true); assert.equal(body.items[0].text, 'safe')
    }
    const body = await run(root, { path: fileAt(root, zip(parts(document(paragraph('safe')).replace('</w:body>', '<w:p>')))) })
    failure(body, 'DOCUMENT_PARSE_ERROR'); assert.deepEqual(body.items.map(i => i.text), ['safe'])
  })
})
await test('DTD, custom entities, invalid numeric references and XML roots/depth/attributes cannot claim completeness', async () => {
  await withTempDir('docx-xml', async root => {
    for (const xml of [document(paragraph('&unknown;')), '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///never-read">]>' + document(paragraph('&secret;')).replace(/^<\?xml.*?\?>/, ''), document(paragraph('&#0;')), document('') + document(''), document(paragraph('x')).replace('<w:t ', '<w:t missing:attr="x" '), ' ' + document('').replace('UTF-8', 'UTF-16')]) {
      failure(await run(root, { path: fileAt(root, zip(parts(xml))) }), 'DOCUMENT_PARSE_ERROR')
    }
    failure(await run(root, { path: fileAt(root, docx('<w:pPr>'.repeat(129) + '</w:pPr>'.repeat(129))) }), 'OUTPUT_LIMIT')
    failure(await run(root, { path: fileAt(root, docx('<w:p ' + Array.from({ length: 65 }, (_, i) => `a${i}="x"`).join(' ') + '/>')) }), 'OUTPUT_LIMIT')
  })
})
await test('ZIP preflight rejects counts, overlapping/duplicate identities, ZIP64, encryption and bad offsets', async () => {
  await withTempDir('docx-zip', async root => {
    const source = docx(paragraph('safe')); const mutations = [bytes => { bytes.writeUInt16LE(4097, bytes.length - 14); bytes.writeUInt16LE(4097, bytes.length - 12) }, bytes => bytes.writeUInt32LE(0xffffffff, bytes.length - 6), bytes => bytes.writeUInt32LE(0, bytes.length - 6), bytes => bytes.writeUInt16LE(1, 6)]
    for (const mutate of mutations) { const bytes = Buffer.from(source); mutate(bytes); const body = await run(root, { path: fileAt(root, bytes) }); assert.ok(body.error); assert.equal(body.error.effectState, 'none'); assert.equal(body.items, undefined) }
    failure(await run(root, { path: fileAt(root, zip([...parts(document('')), ['word/document.xml', document('')]])) }), 'DOCUMENT_PARSE_ERROR')
    const corrupt = Buffer.from(source); corrupt[corrupt.indexOf(Buffer.from('safe'))] = 120
    failure(await run(root, { path: fileAt(root, corrupt) }), 'DOCUMENT_PARSE_ERROR')
  })
})
await test('legacy DOC, macros, external or nonstandard main relationships are explicitly refused', async () => {
  await withTempDir('docx-types', async root => {
    failure(await run(root, { path: fileAt(root, Buffer.from('d0cf11e0a1b11ae1', 'hex')) }), 'UNSUPPORTED_DOCUMENT')
    for (const list of [[['[Content_Types].xml', types.replace('wordprocessingml.document', 'wordprocessingml.macroEnabled')], ...parts(document('')).slice(1)], [parts(document(''))[0], ['_rels/.rels', rels.replace('Target="word/document.xml"', 'Target="https://example.invalid/file" TargetMode="External"')], parts(document(''))[2]]]) {
      failure(await run(root, { path: fileAt(root, zip(list)) }), 'UNSUPPORTED_DOCUMENT')
    }
  })
})
await test('archive, decompressed XML and paragraph limits are bounded with honest gaps', async () => {
  await withTempDir('docx-bounds', async root => {
    failure(await run(root, { path: fileAt(root, Buffer.alloc(32 * 1024 * 1024 + 1)) }), 'OUTPUT_LIMIT')
    failure(await run(root, { path: fileAt(root, docx(paragraph('x'.repeat(8 * 1024 * 1024)), { deflate: true })) }), 'OUTPUT_LIMIT')
    const body = await run(root, { path: fileAt(root, docx(paragraph('safe') + paragraph('x'.repeat(1024 * 1024 + 1)), { deflate: true })) })
    failure(body, 'OUTPUT_LIMIT'); assert.equal(body.scanComplete, false); assert.deepEqual(body.items.map(i => i.text), ['safe'])
  })
})
await test('read-only DOCX reads create nothing and repeat credential and no-follow checks', async () => {
  await withTempDir('docx-authority', async root => {
    const file = fileAt(root, docx(paragraph('safe'))); const before = fs.readdirSync(root)
    assert.equal((await run(root, { path: file }, { readOnly: true })).complete, true); assert.deepEqual(fs.readdirSync(root), before)
    failure(await run(root, { path: file }, { authority: { deny_roots: [root] } }), 'CREDENTIAL_DENIED')
    const target = path.join(root, 'target'); fs.mkdirSync(target); const hidden = fileAt(target, docx(paragraph('secret')))
    const alias = path.join(root, 'alias'); fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const denied = await run(root, { path: path.join(alias, path.basename(hidden)) }); assert.ok(denied.error); assert.equal(denied.error.effectState, 'none'); assert.equal(denied.items, undefined)
  })
})
await test('large paragraph spill reconstructs every Unicode byte and retains main-body scope', async () => {
  await withTempDir('docx-spill', async root => {
    const cache = path.join(root, 'cache'); fs.mkdirSync(cache, { mode: 0o700 }); const text = '中😀'.repeat(20000)
    const file = fileAt(root, docx(paragraph(text) + paragraph('last'), { deflate: true })); const head = await run(root, { path: file }, { cache, maxBytes: 4096 })
    assert.ok(head.reference); assert.equal(head.nextOffset, 1); assert.equal(head.referenceRoot, process.platform === 'win32' ? path.toNamespacedPath(fs.realpathSync.native(root)) : fs.realpathSync(root)); assert.equal(head.complete, false)
    let offset = 0, source; const records = []
    for (;;) { const page = await run(head.referenceRoot, { action: 'page', id: head.reference.refId, offset, limit: 512, maxBytes: 65536 }, { cache, tool: 'result', readOnly: true }); assert.equal(page.error, undefined); records.push(...page.items); source = page.source; assert.ok(page.nextOffset > offset); offset = page.nextOffset; if (page.complete) break }
    assert.equal(source.scope, 'main-body-paragraphs'); assert.equal(source.captureComplete, true); assert.equal(source.scanComplete, true); assert.equal(source.total, 2)
    const rows = []; let chunks = [], byteOffset = 0
    for (const item of records) { assert.equal(item.index, rows.length); if (item.kind === 'item') { rows.push(item.value); continue } assert.equal(item.chunk, chunks.length); assert.equal(item.byteOffset, byteOffset); chunks.push(item.text); byteOffset += Buffer.byteLength(item.text); if (item.complete) { rows.push(JSON.parse(chunks.join(''))); chunks = []; byteOffset = 0 } }
    assert.equal(chunks.length, 0); assert.deepEqual(rows.map(row => row.text), [text, 'last'])
    const noCache = await run(root, { path: file }, { maxBytes: 4096, cache, readOnly: true }); assert.equal(noCache.reference, undefined); assert.equal(noCache.storageError.code, 'POLICY_DENIED'); assert.equal(noCache.complete, false)
  })
})
await test('DOCX transport overflow remains read-only even in writable sessions', async () => {
  await withTempDir('docx-transport', async root => { const body = await run(root, { path: fileAt(root, docx(paragraph('x'.repeat(40000)))) }, { maxBytes: 1024 }); failure(body, 'OUTPUT_LIMIT') })
})

await test('DOCX count limits and malformed package/content placement never invent complete observations', async () => {
  await withTempDir('docx-structure', async root => {
    const capped = await run(root, { path: fileAt(root, docx('<w:p/>'.repeat(100001), { deflate: true })), limit: 1 })
    failure(capped, 'OUTPUT_LIMIT'); assert.equal(capped.blocksObserved, 100000); assert.equal(capped.items.length, 1)
    for (const xml of [document('<w:pPr><w:t>hidden</w:t></w:pPr>'), document('<w:softHyphen/>'), document('').replace('<w:body>', '<w:body/>' + paragraph('outside') + '<w:body>')]) {
      const bad = await run(root, { path: fileAt(root, zip(parts(xml))) }); assert.ok(bad.error); assert.notEqual(bad.complete, true); assert.equal(bad.total, undefined)
    }
    const malformed = [['[Content_Types].xml', types.replace('<Types ', '<Wrong ').replace('</Types>', '</Wrong>')], ...parts(document('')).slice(1)]
    failure(await run(root, { path: fileAt(root, zip(malformed)) }), 'DOCUMENT_PARSE_ERROR')
  })
})

await test('alternate ZIP footers and macro Default content types are refused before archive construction', async () => {
  await withTempDir('docx-footer', async root => {
    for (const magic of [0x06064b50, 0x07064b50, 0x06054b50]) {
      const source = docx(paragraph('safe')); const end = source.length - 22
      const comment = Buffer.alloc(30, 120); comment.writeUInt32LE(magic, 2)
      source.writeUInt16LE(comment.length, end + 20)
      failure(await run(root, { path: fileAt(root, Buffer.concat([source, comment])) }), 'UNSUPPORTED_DOCUMENT')
    }
    const source = docx(paragraph('safe')), end = source.length - 22, footer = Buffer.alloc(76)
    footer.writeUInt32LE(0x06064b50); footer.writeBigUInt64LE(44n, 4); footer.writeUInt32LE(0x07064b50, 56)
    // Classic fields remain ordinary values: this still cannot open a ZIP64 interpretation.
    failure(await run(root, { path: fileAt(root, Buffer.concat([source.subarray(0, end), footer, source.subarray(end)])) }), 'UNSUPPORTED_DOCUMENT')
    const macro = types.replace('</Types>', '<Default Extension="bin" ContentType="application/vnd.MS-Office.VbaProject"/></Types>')
    failure(await run(root, { path: fileAt(root, zip([['[Content_Types].xml', macro], ...parts(document('')).slice(1)])) }), 'UNSUPPORTED_DOCUMENT')
  })
})

report('docx-worker')
