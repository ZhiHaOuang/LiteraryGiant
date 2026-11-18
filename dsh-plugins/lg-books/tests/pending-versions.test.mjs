import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBook } from './fixture.mjs'
import { readBook } from '../src/read.js'
import { readManuscript } from '../src/manuscript.js'
import { pendingVersions } from '../src/pending-versions.js'

function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'lg-dashboard-candidates-')),{db}=createBook(root)
  t.after(()=>db.close())
  const add=(document,n)=>Number(db.prepare("INSERT INTO document_versions(document_id,version_number,state,content,reason,created_at) VALUES (?,?,'candidate','候选秘密正文','改稿','today')").run(document,n).lastInsertRowid)
  return {root,db,add}
}
test('chapter rows count chapter and attached scene candidates without counting candidate prose or unrelated records',t=>{
  const {root,db,add}=setup(t),before=readBook(root)
  const scene=add(2,2);add(4,2);add(6,2)
  assert.equal(readBook(root).counts.candidates,4)
  assert.deepEqual(readBook(root).chapters.map(x=>x.pendingVersions),[2,1,0])
  const page=pendingVersions(db,1)
  assert.deepEqual(page.items.map(x=>[x.document,x.number]),[[2,2],[1,2]])
  assert.ok(!JSON.stringify(page).includes('候选秘密正文'));assert.equal(readBook(root).words,before.words)
  db.prepare('UPDATE documents SET parent_id=3 WHERE id=2').run()
  assert.deepEqual(readBook(root).chapters.map(x=>x.pendingVersions),[1,2,0])
  db.prepare("UPDATE document_versions SET state='rejected' WHERE id=?").run(scene)
  assert.deepEqual(readBook(root).chapters.map(x=>x.pendingVersions),[1,1,0])
  db.exec("UPDATE documents SET state='archived' WHERE id=4")
  assert.equal(pendingVersions(db,3).items.length,0)
})
test('a pending list cursor stays on the older versions when newer candidates arrive or the cursor row is decided',t=>{
  const {db,add}=setup(t)
  for(let n=2;n<26;n++)add(2,n)
  const first=pendingVersions(db,1);assert.equal(first.items.length,20)
  add(2,26);db.prepare("UPDATE document_versions SET state='rejected' WHERE id=?").run(first.before)
  const rest=pendingVersions(db,1,first.before)
  assert.equal(rest.items.length,5);assert.equal(rest.before,null)
  assert.ok(rest.items.every(row=>row.version<first.before))
  assert.throws(()=>pendingVersions(db,1,-1),/分页/);assert.throws(()=>pendingVersions(db,'1'),/章节/)
})
test('opening an older pending version includes it in the editor selector beyond the recent hundred',t=>{
  const {db,root,add}=setup(t)
  for(let n=3;n<105;n++)add(1,n)
  const {selected,versions}=readManuscript(root,1,8)
  assert.equal(selected.id,8);assert.equal(versions.length,101);assert.equal(versions.at(-1).id,8)
  assert.equal(readManuscript(root,1).document.activeVersion,1)
  db.exec("UPDATE documents SET state='archived' WHERE id=1");assert.deepEqual(pendingVersions(db,1).items,[])
})
