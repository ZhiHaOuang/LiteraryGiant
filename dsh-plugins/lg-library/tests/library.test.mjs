import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { search, readCitation, catalog } from '../src/search.js'
import { createLibrary } from '../src/service.js'
import { digest } from '../src/records.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lg-reference-')), book = join(root, 'book'), shared = join(root, 'shared')
  mkdirSync(book); mkdirSync(shared)
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
  const jsonl = (path, values) => put(path, values.map(value => JSON.stringify(value)).join('\n') + '\n')
  return { root, book, shared, put, jsonl, config: { libraryRoot: shared } }
}
test('abstract/custom/bridge tiers, source redaction and citation round trip', async () => {
  const f = fixture()
  f.jsonl(join(f.shared, 'AbstractLibrary/pattern_index.jsonl'), [{ pattern_id: 'pattern', summary: '身份揭露引发信任冲突', raw_text: 'SECRET RAW', content: 'SECRET CONTENT' }])
  f.jsonl(join(f.book, 'ReferenceLibrary/ref.jsonl'), [{ id: 'ref', summary: '身份揭露', quality_score: 1 }])
  f.jsonl(join(f.shared, 'BridgeIndex/books/book.jsonl'), [{ book_id: 'bridge', summary: '身份揭露' }])
  f.put(join(f.shared, 'TaciturnRaw/raw.txt'), '身份揭露 SECRET RAW')
  f.put(join(f.shared, 'Bridges/full.txt'), '身份揭露 SECRET RAW')
  for (const dir of ['plans', 'bible', 'reviews', 'drafts', 'analyses', 'archive', 'research/stages']) f.put(join(f.book, 'ReferenceLibrary', dir, 'ignored.txt'), '身份揭露')
  const result = await search(f.book, { query: '身份揭露', limit: 3 }, f.config)
  assert.deepEqual(result.hits.map(hit => hit.tier), ['abstract', 'custom', 'bridge'])
  assert.equal(result.stats.files, 3)
  const reference = readCitation(f.book, result.hits[0].citation, f.config)
  assert.match(reference.text, /信任冲突/); assert.doesNotMatch(JSON.stringify(reference), /SECRET/)
  assert.equal((await search(f.book, { query: '身份揭露', limit: 2 }, f.config)).stats.files, 2)
  assert.equal((await search(f.book, { query: 'SECRET', limit: 3 }, f.config)).hits.length, 0)
})
test('changed sources and cross-book citations are rejected', async () => {
  const f = fixture(), file = join(f.book, 'ReferenceLibrary/ref.json')
  f.put(file, JSON.stringify([{ id: 'a', summary: '信任冲突' }]))
  const result = await search(f.book, { query: '信任冲突' }, f.config), citation = result.hits[0].citation
  const other = join(f.root, 'other'); mkdirSync(other)
  assert.throws(() => readCitation(other, citation, f.config), /不属于/)
  f.put(file, JSON.stringify([{ id: 'a', summary: '信任恢复' }]))
  assert.throws(() => readCitation(f.book, citation, f.config), /已变化/)
})
test('forged locator cannot extract protected JSON fields or traverse paths', async () => {
  const f = fixture(), file = join(f.book, 'ReferenceLibrary/ref.jsonl')
  f.jsonl(file, [{ summary: '信任冲突', content: 'SECRET' }])
  const hit = (await search(f.book, { query: '信任冲突' }, f.config)).hits[0]
  const ref = JSON.parse(Buffer.from(hit.citation, 'base64url').toString())
  const token = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  assert.throws(() => readCitation(f.book, token({ ...ref, file: '../hidden.txt' }), f.config), /无效|不属于/)
  assert.throws(() => readCitation(f.book, token({ ...ref, locator: { ...ref.locator, format: 'text' } }), f.config), /格式/)
  const raw = readFileSync(file), part = Buffer.from('"SECRET"')
  assert.throws(() => readCitation(f.book, token({ ...ref, sha256: digest(part), locator: { format: 'jsonl', offset: raw.indexOf(part), length: part.length } }), f.config), /完整/)
})
test('default Library and custom references do not follow symlinks', async () => {
  const f = fixture()
  f.jsonl(join(f.shared, 'AbstractLibrary/pattern_index.jsonl'), [{ summary: '信任冲突' }])
  symlinkSync(f.shared, join(f.book, 'Library'))
  mkdirSync(join(f.book, 'ReferenceLibrary'))
  symlinkSync(join(f.shared, 'AbstractLibrary/pattern_index.jsonl'), join(f.book, 'ReferenceLibrary/link.jsonl'))
  assert.equal((await search(f.book, { query: '信任冲突' })).hits.length, 0)
  assert.equal((await search(f.book, { query: '信任冲突' }, f.config)).hits.length, 1)
})
test('organized references use sources only and fail closed during migration', async () => {
  const f = fixture()
  f.put(join(f.book, 'ReferenceLibrary/old.txt'), '信任冲突 old')
  f.put(join(f.book, 'ReferenceLibrary/sources/new.txt'), '信任冲突 new')
  f.put(join(f.book, '.literarygiant/assets.json'), JSON.stringify({ schema: 'lg.assets.v1', status: 'complete' }))
  const result = await search(f.book, { query: '信任冲突' })
  assert.equal(result.hits.length, 1); assert.match(result.hits[0].excerpt, /new/)
  f.put(join(f.book, '.literarygiant/assets.json'), JSON.stringify({ schema: 'lg.assets.v1', status: 'pending' }))
  await assert.rejects(search(f.book, { query: '信任冲突' }), /迁移未完成/)
})
test('malformed lines consume the record budget; byte and file budgets report truncation', async () => {
  const f = fixture(), file = join(f.book, 'ReferenceLibrary/ref.jsonl')
  f.put(file, 'invalid\ninvalid\n' + JSON.stringify({ summary: '信任冲突' }) + '\n')
  const limited = await search(f.book, { query: '信任冲突' }, { maxRecords: 2 })
  assert.equal(limited.stats.records, 2); assert.equal(limited.stats.malformed, 2); assert.equal(limited.stats.truncated, true)
  assert.equal(limited.hits.length, 0)
  assert.equal((await search(f.book, { query: '信任冲突' }, { maxBytes: 5 })).stats.truncated, true)
  f.put(join(f.book, 'ReferenceLibrary/other.txt'), '信任冲突')
  assert.equal((await search(f.book, { query: '信任冲突' }, { maxFiles: 1 })).stats.files, 1)
})
test('cancelled retrieval fails without returning partial results', async () => {
  const f = fixture(); f.put(join(f.book, 'ReferenceLibrary/ref.txt'), '信任冲突')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(search(f.book, { query: '信任冲突' }, {}, controller.signal), { name: 'AbortError' })
})
test('catalog reports fixed indexes; service scopes tools to registered book directories', async () => {
  const f = fixture(); mkdirSync(join(f.book, 'chapters'))
  const library = createLibrary({ list: () => [{ path: f.book }] }, {})
  assert.equal(library.forDirectory(join(f.book, 'chapters')), f.book)
  assert.throws(() => library.forDirectory(f.shared), /工作目录/)
  assert.throws(() => library.catalog(f.shared), /添加/)
  assert.equal(catalog(f.book).abstract.some(index => index.available), false)
  await assert.rejects(search(f.book, { query: '小说' }), /具体/)
})
