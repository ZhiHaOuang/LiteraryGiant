import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBook } from './fixture.mjs'
import { chapterFile } from '../src/chapter-files.js'
import { refreshFile, hash } from '../src/chapter-file-format.js'

function setup(t) {
  const path = realpathSync(mkdtempSync(join(tmpdir(),'lg-chapter-file-')))
  const {db} = createBook(path)
  t.after(() => db.close())
  const file = join(path,'manuscript','chapters','doc-1.md')
  const preview = () => chapterFile(path,{action:'chapter-file-preview',document:1})
  const input = (view = preview(), intent = view.action) => ({
    action:'chapter-file-apply',intent,token:view.token,operation:randomUUID(),document:1,
  })
  const apply = (value = input()) => chapterFile(path,value)
  const text = () => readFileSync(file,'utf8')
  const edit = (from, to) => writeFileSync(file,text().replace(from,to))
  const sceneChange = () => db.exec("INSERT INTO document_versions(document_id,version_number,state,content,reason,created_at) VALUES(2,2,'accepted','新场景','修订',''); UPDATE documents SET active_version_id=last_insert_rowid() WHERE id=2")
  return { path, db, file, preview, input, apply, text, edit, sceneChange }
}

test('new working copy round-trips two edits atomically and preserves scene status, FTS and candidate history', t => {
  const f=setup(t)
  f.db.exec("CREATE TABLE document_fts(slug,title,kind,content,tags); INSERT INTO scene_cards(document_id,chapter_id,status,created_at,updated_at) VALUES(2,1,'reviewed','','')")
  assert.equal(f.preview().state,'missing');f.apply()
  assert.equal(f.preview().state,'clean');assert.doesNotMatch(f.text(),/候选文本/)
  const edited=f.text().replace('关上灯','留下灯').replace('另一份正文','未来的证词').replace(/\n/gu,'\r\n').trimEnd()
  writeFileSync(f.file,edited)
  const v=f.preview(),input=f.input(v);assert.deepEqual(v.changes.map(c=>c.document),[1,2])
  const receipt=f.apply(input);assert.equal(receipt.versions.length,2)
  assert.equal(f.preview().state,'clean');assert.equal(f.text(),edited)
  assert.deepEqual(f.apply(input),receipt)
  assert.throws(()=>f.apply({...input,intent:'create'}),/编号/)
  assert.equal(f.db.prepare('SELECT status FROM scene_cards WHERE document_id=2').get().status,'reviewed')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM document_fts').get().n,2)
  assert.match(f.db.prepare('SELECT content FROM document_versions WHERE id=1').get().content,/关上灯/)
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM document_versions WHERE state='candidate'").get().n,1)
})

test('second-part failure rolls back all versions and file remains independently retryable',t=>{
  const f=setup(t);f.apply();f.edit('关上灯','留着灯');f.edit('另一份正文','另一条线索')
  f.db.exec("CREATE TRIGGER block_scene BEFORE INSERT ON document_versions WHEN NEW.document_id=2 BEGIN SELECT RAISE(ABORT,'scene failure'); END")
  const input=f.input();assert.throws(()=>f.apply(input),/scene failure/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM document_versions').get().n,8)
  assert.equal(f.preview().state,'file-edited');f.db.exec('DROP TRIGGER block_scene')
  assert.equal(f.apply(input).versions.length,2)
})

test('preview is bound to both sides and conflict resolution preserves the discarded side',t=>{
  for (const intent of ['keep-file','keep-database']) {
    const f=setup(t);f.apply();f.edit('另一份正文','一段外部编辑')
    const stale=f.input();f.sceneChange()
    const before=f.text();assert.throws(()=>f.apply(stale),/重新比较/)
    const v=f.preview();assert.equal(v.state,'conflict');assert.equal(v.action,null)
    assert.deepEqual(v.resolutions,['keep-file','keep-database'])
    const receipt=f.apply(f.input(v,intent));assert.equal(f.preview().state,'clean')
    if(intent==='keep-database') {
      assert.equal(readFileSync(receipt.backup,'utf8'),before);assert.match(f.text(),/新场景/)
    } else {
      assert.equal(f.text(),before);assert.equal(receipt.versions.length,1)
      assert.equal(f.db.prepare('SELECT content FROM document_versions WHERE document_id=2 AND version_number=2').get().content,'新场景')
    }
  }
})

test('outbound update preserves old bytes, including a chapter rename',t=>{
  const f=setup(t);f.apply();const old=f.text()
  f.db.exec("UPDATE documents SET title='新标题' WHERE id=1")
  const v=f.preview();assert.equal(v.state,'database-changed');assert.equal(v.action,'refresh')
  const receipt=f.apply();assert.equal(readFileSync(receipt.backup,'utf8'),old)
  assert.match(f.text(),/^# 新标题/);assert.equal(f.preview().state,'clean')
})

test('late editor write aborts refresh and restores its exact inode contents',t=>{
  const f=setup(t);f.apply();const before=f.text();f.edit('关上灯','最新编辑')
  assert.throws(()=>refreshFile(f.path,1,f.file,before,'替换'),/再次保存/)
  assert.match(f.text(),/最新编辑/)
})

test('untracked, damaged markers and stale file previews preserve external contents',t=>{
  const f=setup(t);const wanted=f.preview().databaseText
  mkdirSync(join(f.path,'manuscript/chapters'),{recursive:true})
  writeFileSync(f.file,'作者手写文件');assert.equal(f.preview().action,null)
  writeFileSync(f.file,wanted);assert.equal(f.preview().action,'track');f.apply()
  f.edit('关上灯','第一处编辑');const old=f.input();f.edit('第一处编辑','后来保存')
  assert.throws(()=>f.apply(old),/重新比较/)
  f.edit('lg:document 2','lg:document 9');assert.equal(f.preview().action,null)
  assert.ok(f.preview().problem);assert.match(f.text(),/后来保存/)
})

test('native status reads a legacy baseline and refuses foreign, pending and damaged records',t=>{
  const f=setup(t);const doc=f.preview().databaseText
  mkdirSync(join(f.path,'manuscript/chapters'),{recursive:true});writeFileSync(f.file,doc)
  const folder=join(f.path,'.literarygiant/chapter-sync');mkdirSync(folder)
  const baseline={schema:1,project_id:'test-book',file_hash:hash(doc),documents:f.db.prepare('SELECT id,active_version_id AS version,title,state,sequence FROM documents WHERE id IN (1,2) ORDER BY id').all()}
  const record=join(folder,'1.json');writeFileSync(record,JSON.stringify(baseline))
  assert.equal(f.preview().state,'clean')
  writeFileSync(record,JSON.stringify({...baseline,project_id:'different'}));assert.throws(f.preview,/不符/)
  writeFileSync(record,JSON.stringify(baseline));f.edit('关上灯','作者改稿');f.apply()
  assert.equal(f.preview().state,'clean')
  writeFileSync(join(folder,'1.import.json'),JSON.stringify({schema:1,project_id:'test-book',chapter_id:1,state:'pending'}))
  assert.throws(f.preview,/待恢复/)
})

test('a crash after new file publication before database commit can be recovered without replacement',t=>{
  const f=setup(t)
  f.db.exec("CREATE TABLE lg_chapter_file_receipts(id TEXT PRIMARY KEY, signature TEXT,result TEXT); CREATE TRIGGER fail_receipt BEFORE INSERT ON lg_chapter_file_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END")
  assert.throws(()=>f.apply(),/receipt failure/);assert.ok(existsSync(f.file))
  assert.equal(f.preview().action,'track');f.db.exec('DROP TRIGGER fail_receipt')
  f.apply();assert.equal(f.preview().state,'clean')
})

test('rejects directory escapes, linked files and invalid UTF-8',t=>{
  const f=setup(t);f.db.exec("UPDATE documents SET slug='../escape' WHERE id=1");assert.throws(f.preview,/文件名/)
  f.db.exec("UPDATE documents SET slug='doc-1' WHERE id=1");mkdirSync(join(f.path,'manuscript/chapters'),{recursive:true})
  writeFileSync(f.file,Buffer.from([255]));assert.throws(f.preview,/encoded|encoding/iu)
  const other=setup(t);symlinkSync(f.path,join(other.path,'manuscript'));assert.throws(other.preview,/符号链接/)
})

test('large malformed marker sequences refuse import without scanning each possible document body', t => {
  const f = setup(t)
  f.apply()
  writeFileSync(f.file, '# 第一章 旧码头\n\n' + '<!-- lg:document 1 -->\n'.repeat(20_000))
  const preview = f.preview()
  assert.equal(preview.action, null)
  assert.match(preview.problem, /标记/)
})

function interrupted(t, committed) {
  const f = setup(t)
  f.apply()
  const original = f.text()
  const rows = f.db.prepare(`SELECT d.id,d.active_version_id AS version,d.title,d.state,d.sequence,v.content
    FROM documents d JOIN document_versions v ON v.id=d.active_version_id WHERE d.id IN (1,2) ORDER BY d.id`).all()
  const before = rows.map(({content,...head}) => head)
  const folder = join(f.path,'.literarygiant/chapter-sync')
  mkdirSync(folder)
  writeFileSync(join(folder,'1.json'), JSON.stringify({schema:1,project_id:'test-book',documents:before,file_hash:hash(original)}))
  const changed = [2], after = '来自外部文件的新场景。'
  f.edit(rows[1].content,after)
  const entry = {schema:1,project_id:'test-book',chapter_id:1,state:'pending',origin:'chapter-file:' + 'a'.repeat(32),
    before,changed,file_hash:hash(f.text()),contents:{1:hash(rows[0].content),2:hash(after)}}
  const journal = join(folder,'1.import.json')
  writeFileSync(journal,JSON.stringify(entry))
  if (committed) {
    const id = f.db.prepare(`INSERT INTO document_versions(document_id,version_number,state,content,reason,metadata_json,created_at)
      VALUES(2,2,'accepted',?,'Imported author edits',?,'')`).run(after,JSON.stringify({origin:entry.origin,previous_version_id:2})).lastInsertRowid
    f.db.prepare('UPDATE documents SET active_version_id=? WHERE id=2').run(id)
  }
  return {...f, journal,entry,after,count:()=>f.db.prepare('SELECT count(*) AS n FROM document_versions').get().n}
}

test('finish an already committed legacy import without a new version and preserve later external edits', t => {
  const f = interrupted(t,true), count = f.count(), originalJournal = readFileSync(f.journal,'utf8')
  f.db.exec('CREATE TABLE document_fts(slug,title,kind,content,tags)')
  f.edit(f.after,'稍后又保存的文字')
  const view = f.preview(), retry = f.input(view)
  assert.equal(view.action,'recover-committed');assert.deepEqual(view.changes,[])
  const receipt = f.apply(retry)
  assert.deepEqual(receipt.versions,[]);assert.deepEqual(f.apply(retry),receipt)
  assert.equal(f.count(),count);assert.equal(f.preview().state,'file-edited')
  assert.match(f.text(),/稍后又保存/);assert.equal(readFileSync(f.journal,'utf8'),originalJournal)
  assert.equal(f.db.prepare('SELECT content FROM document_fts WHERE rowid=2').get().content,f.after)
  assert.equal(f.apply().versions.length,1);assert.equal(f.preview().state,'clean')
})

test('resume an uncommitted legacy import under its original identity and roll back recovery receipts on failure', t => {
  const f = interrupted(t,false), initial=f.count(), preview=f.preview(), input=f.input(preview)
  assert.equal(preview.action,'recover-import');assert.equal(preview.changes.length,1)
  f.db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON lg_chapter_file_receipts BEGIN SELECT RAISE(ABORT,'recovery rollback'); END")
  assert.throws(()=>f.apply(input),/recovery rollback/);assert.equal(f.count(),initial)
  assert.equal(f.preview().action,'recover-import');f.db.exec('DROP TRIGGER fail_recovery')
  const receipt = f.apply(input), id=receipt.versions[0].version
  assert.equal(f.count(),initial+1);assert.equal(f.preview().state,'clean');assert.deepEqual(f.apply(input),receipt)
  const meta=JSON.parse(f.db.prepare('SELECT metadata_json FROM document_versions WHERE id=?').get(id).metadata_json)
  assert.equal(meta.origin,f.entry.origin);assert.equal(meta.previous_version_id,2)
})

test('recovery rejects changed files, partial or restored database heads and unproven prior origins', t => {
  const uncommitted = interrupted(t,false)
  uncommitted.edit(uncommitted.after,'更晚的文件内容');assert.throws(uncommitted.preview,/中断后/)
  const restored = interrupted(t,true)
  restored.db.exec('UPDATE documents SET active_version_id=2 WHERE id=2')
  assert.throws(restored.preview,/不符/);assert.equal(restored.count(),9)
  const invalid = interrupted(t,true)
  invalid.db.exec("UPDATE document_versions SET metadata_json='{}' WHERE document_id=2 AND version_number=2")
  assert.throws(invalid.preview,/中断后|不符/)
})

test('recovery binds the original state, exact changed set, journal identity and per-document contents', t => {
  const f = interrupted(t,true)
  const original={...f.entry}
  for(const patch of [{project_id:'another'}, {chapter_id:2}, {changed:[2,2]}, {changed:[]},
    {file_hash:[f.entry.file_hash]}, {origin:'chapter-file:'+'b'.repeat(32)}, {contents:{1:hash('foreign'),2:hash(f.after)}},
    {before:[f.entry.before[1],f.entry.before[0]]}]) {
    writeFileSync(f.journal,JSON.stringify({...original,...patch}))
    assert.throws(f.preview);assert.equal(f.count(),9)
  }
  writeFileSync(f.journal,JSON.stringify(original));f.apply()
  writeFileSync(f.journal,JSON.stringify({...original,file_hash:'0'.repeat(64)}))
  assert.throws(f.preview,/不符/)
})

test('mixed legacy heads are refused and a published post-commit legacy baseline is recognized', t => {
  const mixed = interrupted(t,true)
  mixed.edit('关上灯','熄掉灯')
  const entry = mixed.entry
  entry.changed = [1,2]
  entry.contents[1] = hash('林澈熄掉灯。海风停了。')
  entry.file_hash = hash(mixed.text())
  writeFileSync(mixed.journal,JSON.stringify(entry))
  assert.throws(mixed.preview,/中断后/);assert.equal(mixed.count(),9)

  const published = interrupted(t,true), savedHeads=published.db.prepare(
    'SELECT id,active_version_id AS version,title,state,sequence FROM documents WHERE id IN (1,2) ORDER BY id').all()
  writeFileSync(join(published.path,'.literarygiant/chapter-sync/1.json'),JSON.stringify({
    schema:1,project_id:'test-book',documents:savedHeads,file_hash:published.entry.file_hash,
  }))
  assert.equal(published.preview().action,'recover-committed')
  assert.equal(published.apply().versions.length,0);assert.equal(published.preview().state,'clean')
})
