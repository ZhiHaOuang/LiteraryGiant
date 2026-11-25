import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readBook, describeBook, containedFile } from '../src/read.js'
import { renameBook } from '../src/book-title.js'
import { wordCount } from '../src/summary.js'
import { createBook } from './fixture.mjs'

function setup() { const root = mkdtempSync(join(tmpdir(),'lg-books-test-')); return { root, ...createBook(root) } }
function digest(root) {
  return readdirSync(root,{recursive:true}).filter(name => statSync(join(root,name)).isFile())
    .map(name => [name,createHash('sha256').update(readFileSync(join(root,name))).digest('hex')])
}

test('counts Han, English and digits without treating punctuation as words', () => {
  assert.equal(wordCount('林澈说：“Hello world，2026年！”'), 7)
  assert.equal(wordCount('  …！\n'), 0)
})
test('reads actual legacy schema, excludes candidates and avoids chapter/scene double counting', () => {
  const {root,db}=setup(); db.close()
  const before=digest(root), view=readBook(root)
  assert.equal(view.chapters.length,3)
  assert.equal(view.written,2)
  assert.equal(view.words,wordCount('林澈关上灯。海风停了。潮水上涨，她没有回头。'))
  assert.equal(view.acceptedWords,wordCount('林澈关上灯。海风停了。'))
  assert.equal(view.counts.candidates,1)
  assert.equal(view.characters[0].title,'林澈')
  assert.equal(view.chapters[1].source,'scenes')
  assert.match(view.overview,/守灯人/)
  assert.deepEqual(digest(root),before,'reading must not change or add book files')
})
test('candidate-only active prose is not counted as manuscript', () => {
  const {root,db,document}=setup();document(9,'chapter','候选章','这不是正式正文','candidate');db.close()
  assert.equal(readBook(root).chapters.length,3)
})
test('refuses a database belonging to another project', () => {
  const {root,db}=setup();db.prepare("UPDATE project_meta SET value='other' WHERE key='project_id'").run();db.close()
  assert.throws(()=>readBook(root),/标识与数据库不一致/)
})
test('refuses an active version owned by a different document', () => {
  const {root,db}=setup();db.prepare('UPDATE documents SET active_version_id=4 WHERE id=1').run();db.close()
  assert.throws(()=>readBook(root),/版本引用损坏/)
})
test('rejects symlinks escaping the selected book', () => {
  const {root,db}=setup();db.close()
  const outside=mkdtempSync(join(tmpdir(),'lg-external-'));writeFileSync(join(outside,'x'),'external')
  symlinkSync(join(outside,'x'),join(root,'escape'))
  assert.throws(()=>containedFile(root,'escape'),/本作品目录内/)
})
test('missing overview falls back to a labelled outline, malformed overview stays visible as warning', () => {
  const {root,db}=setup();db.close()
  writeFileSync(join(root,'ReferenceLibrary/bible/book-overview.json'),'{invalid')
  const view=readBook(root)
  assert.match(view.overview,/来自未来/)
  assert.equal(view.warnings.length,1)
})
test('new content is reflected on refresh; no session or persistent cache is involved', () => {
  const {root,db}=setup();const first=readBook(root)
  db.prepare("UPDATE document_versions SET content='海风' WHERE id=1").run();db.close()
  assert.equal(readBook(root).words,first.words-wordCount('林澈关上灯。海风停了。')+2)
})
test('unrecognized paths cannot create a new database', () => {
  const root=mkdtempSync(join(tmpdir(),'lg-empty-'))
  assert.throws(()=>describeBook(root))
  assert.deepEqual(readdirSync(root),[])
})

test('renaming preserves book identity, chapter versions and unrelated manifest fields', () => {
  const {root,db}=setup(), file=join(root,'.literarygiant/project.json')
  const original=JSON.parse(readFileSync(file,'utf8'))
  writeFileSync(file,JSON.stringify({...original,authorNote:'保留'}))
  const before=readBook(root), input={projectId:before.id,expectedName:before.name,name:'  海上来信  '}
  try {
    for(const name of [' ', '名'.repeat(201)]) assert.throws(()=>renameBook(root,{...input,name}),/作品名称/)
    assert.throws(()=>renameBook(root,{...input,projectId:'other'}),/作品标识/)
    const saved=renameBook(root,input)
    assert.deepEqual(describeBook(root),{id:before.id,path:before.path,name:'海上来信'})
    assert.equal(JSON.parse(readFileSync(file,'utf8')).authorNote,'保留')
    assert.equal(readBook(root).revision,before.revision)
    assert.equal(db.prepare("SELECT value FROM project_meta WHERE key='project_name'").get().value,saved.name)
    assert.throws(()=>renameBook(root,{...input,name:'过期修改'}),/书名已变化/)
    db.prepare("UPDATE project_meta SET value=? WHERE key='project_name'").run(before.name)
    assert.deepEqual(renameBook(root,input),saved)
    assert.equal(db.prepare("SELECT value FROM project_meta WHERE key='project_name'").get().value,saved.name)
  } finally {db.close()}
})

test('a failed SQLite commit restores the original title and a retry succeeds', () => {
  const {root,db}=setup(), before=describeBook(root), file=join(root,'.literarygiant/project.json')
  const original=readFileSync(file,'utf8'), input={projectId:before.id,expectedName:before.name,name:'新书名'}
  try {
    db.exec('PRAGMA journal_mode=DELETE; BEGIN')
    db.prepare('SELECT value FROM project_meta').get()
    assert.throws(()=>renameBook(root,input),/locked|busy/i)
    assert.equal(readFileSync(file,'utf8'),original)
    db.exec('ROLLBACK')
    assert.equal(renameBook(root,input).name,input.name)
  } finally {db.close()}
})
