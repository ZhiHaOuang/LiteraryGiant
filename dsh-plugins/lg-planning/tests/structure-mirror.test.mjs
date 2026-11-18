import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import * as booksPlugin from '../../lg-books/index.js'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { chapterFile, retryChapterMirror } from '../../lg-books/src/chapter-files.js'
import { createPlanning } from '../src/service.js'

async function setup(t) {
  const path=mkdtempSync(join(tmpdir(),'lg-structure-mirror-')), {db}=createBook(path)
  const ctx=new Context(), deps=ctx.plugin(c=>c.provide('configEditor',{}))
  await deps.await(); const host=ctx.plugin(booksPlugin,{projects:[path]});await host.await()
  t.after(async()=>{await host.dispose();await deps.dispose();db.close()})
  const service=createPlanning(ctx.get('literaryBooks'))
  const apply=change=>service.apply(path,change,service.preview(path,change).token,randomUUID())
  const file=slug=>join(path,'manuscript','chapters',slug+'.md')
  const scene=(chapter_id,sequence=8)=>apply({action:'scene.create',slug:randomUUID(),title:'新场景',chapter_id,sequence})
  const move=(id,chapter_id,sequence=1)=>({action:'scene.move',id,expected_token:service.read(path,'scenes',id).token,chapter_id,sequence})
  return {path,db,books:ctx.get('literaryBooks'),service,apply,file,scene,move}
}

test('chapter creation and rename project the current header, retaining an exact backup; parts do not create mirrors',async t=>{
  const f=await setup(t)
  const part=f.apply({action:'structure.create',kind:'part',slug:'volume',title:'卷一'})
  assert.equal(part.chapterFiles,undefined);assert.ok(!existsSync(f.file('volume')))
  const c=f.apply({action:'structure.create',kind:'chapter',slug:'port',title:'港口',parent_id:part.id,sequence:1})
  assert.equal(c.chapterFiles[0].sync,'synchronized')
  const original=readFileSync(f.file('port'));assert.match(original.toString(),/^# 港口/)
  const renamed=f.apply({action:'structure.update',id:c.id,title:'港口来信',parent_id:part.id,sequence:1,expected_token:c.token})
  assert.equal(renamed.active_version_id,c.active_version_id)
  assert.match(readFileSync(f.file('port'),'utf8'),/^# 港口来信/);assert.deepEqual(readFileSync(renamed.chapterFiles[0].backup),original)
  const noop=f.apply({action:'structure.update',id:c.id,title:'港口来信',parent_id:part.id,sequence:1,expected_token:renamed.token})
  assert.equal(noop.chapterFiles,undefined)
})

test('moving across chapters projects both sides; replay preserves later external edits without another move',async t=>{
  const f=await setup(t),scene=f.scene(1),id=scene.document_id,marker='<!-- lg:document '+id+' -->'
  assert.ok(readFileSync(f.file('doc-1'),'utf8').includes(marker))
  const change=f.move(id,3),op=randomUUID(),token=f.service.preview(f.path,change).token
  const moved=f.service.apply(f.path,change,token,op)
  assert.deepEqual(moved.chapterFiles.map(x=>[x.chapter,x.sync]),[[1,'synchronized'],[3,'synchronized']])
  assert.ok(!readFileSync(f.file('doc-1'),'utf8').includes(marker));assert.ok(readFileSync(f.file('doc-3'),'utf8').includes(marker))
  assert.equal(f.service.read(f.path,'scenes',id).active_version_id,scene.active_version_id)
  writeFileSync(f.file('doc-3'),'外部修改')
  assert.deepEqual(f.service.apply(f.path,change,token,op),moved);assert.equal(readFileSync(f.file('doc-3'),'utf8'),'外部修改')
})

test('same-chapter reordering targets once, unattached scenes acquire or release only the actual chapter',async t=>{
  const f=await setup(t),scene=f.scene(null),id=scene.document_id
  assert.equal(scene.chapterFiles,undefined)
  f.apply(f.move(id,1,9))
  const order=f.apply(f.move(id,1,0));assert.deepEqual(order.chapterFiles.map(x=>x.chapter),[1])
  const body=readFileSync(f.file('doc-1'),'utf8');assert.ok(body.indexOf('document '+id+' -->')<body.indexOf('document 2 -->'))
  assert.equal(f.apply(f.move(id,1,0)).chapterFiles,undefined)
  const detached=f.apply(f.move(id,null));assert.deepEqual(detached.chapterFiles.map(x=>x.chapter),[1])
  assert.ok(!readFileSync(f.file('doc-1'),'utf8').includes('document '+id+' -->'))
})

test('an external edit on the old chapter is preserved independently of destination publication',async t=>{
  const f=await setup(t),scene=f.scene(1),file=f.file('doc-1')
  const edited=readFileSync(file,'utf8').replace('关上灯','留下灯');writeFileSync(file,edited)
  const result=f.apply(f.move(scene.document_id,3))
  assert.deepEqual(result.chapterFiles.map(x=>x.sync),['mirror-review','synchronized'])
  assert.equal(readFileSync(file,'utf8'),edited)
  assert.ok(readFileSync(f.file('doc-3'),'utf8').includes('document '+scene.document_id+' -->'))
})

test('failed file publication can retry via the workbench after commit without adding a planning operation',async t=>{
  const f=await setup(t),scene=f.scene(1),id=scene.document_id
  // A directory at the exact destination makes file reads fail without affecting the other chapter.
  const dst=f.file('doc-3')
  mkdirSync(dst)
  const result=f.apply(f.move(id,3));assert.deepEqual(result.chapterFiles.map(x=>x.sync),['synchronized','mirror-pending'])
  const n=f.db.prepare('SELECT COUNT(*) AS n FROM lg_planning_operations').get().n
  renameSync(dst,dst+'.obstruction')
  const reopened=createPlanning(f.books)
  const history=()=>reopened.history(f.path,id).operations.find(op=>op.action==='scene.move').result.chapterFiles
  assert.deepEqual(history().map(x=>x.sync),['synchronized','mirror-pending'])
  assert.ok(!existsSync(dst))
  const pending=chapterFile(f.path,{action:'chapter-file-preview',document:3}).pendingOperation
  assert.equal(pending,result.chapterFiles[1].operation)
  assert.equal(retryChapterMirror(f.path,3,pending).sync,'synchronized')
  assert.deepEqual(history().map(x=>x.sync),['synchronized','synchronized'])
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lg_planning_operations').get().n,n)
  assert.ok(readFileSync(dst,'utf8').includes('document '+id+' -->'))
})

test('a later structure revision supersedes a pending ticket; failed queue insertion rolls back the move',async t=>{
  const f=await setup(t),scene=f.scene(1),id=scene.document_id
  f.db.exec("CREATE TRIGGER fail_destination BEFORE INSERT ON lg_plugin_operations WHEN json_extract(NEW.result,'$.chapter')=3 BEGIN SELECT RAISE(ABORT,'queue failure'); END")
  assert.throws(()=>f.apply(f.move(id,3)),/queue failure/)
  assert.equal(f.service.read(f.path,'scenes',id).chapter_id,1)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lg_planning_operations').get().n,1)
  assert.ok(!existsSync(f.file('doc-3')));f.db.exec('DROP TRIGGER fail_destination')
  const dst=f.file('doc-3');mkdirSync(dst)
  const moved=f.apply(f.move(id,3));const ticket=moved.chapterFiles[1].operation
  f.apply(f.move(id,5));renameSync(dst,dst+'.obstruction')
  assert.equal(retryChapterMirror(f.path,3,ticket).sync,'superseded')
  assert.ok(!existsSync(dst));assert.ok(readFileSync(f.file('doc-5'),'utf8').includes('document '+id+' -->'))
})

test('card design and candidate plan changes do not trigger file work',async t=>{
  const f=await setup(t),scene=f.scene(1),external='作者在磁盘修改的原稿'
  writeFileSync(f.file('doc-1'),external)
  const card=f.apply({action:'scene.update',id:scene.document_id,expected_token:scene.token,card:{goal:'换一个目标'}})
  const proposal=f.apply({action:'scene.plan',id:scene.document_id,expected_token:card.token,plan:'候选场景计划'})
  assert.equal(card.chapterFiles,undefined);assert.equal(proposal.chapterFiles,undefined)
  assert.equal(readFileSync(f.file('doc-1'),'utf8'),external)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lg_plugin_operations').get().n,1)
})
