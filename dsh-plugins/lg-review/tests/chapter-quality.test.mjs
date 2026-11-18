import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { createReview } from '../src/service.js'

function setup() {
  const path=mkdtempSync(join(tmpdir(),'lg-chapter-quality-'))
  createBook(path).db.close()
  const books={readState:(p,fn)=>accessState(p,false,fn),changeState:(p,fn)=>accessState(p,true,fn)}
  const service=createReview(books,{},{}),target={section:'quality',id:1}
  return {path,service,target,change:fn=>books.changeState(path,fn),preview:()=>service.qualityPreview(path,target),
    run:(id=randomUUID())=>service.quality(path,target,id)}
}
const insertCard=(db,id,status)=>db.prepare("INSERT INTO scene_cards(document_id,chapter_id,status,created_at,updated_at) VALUES (?,1,?,'now','now')").run(id,status)
test('chapter quality uses card order and only adopted scene prose, attributes the exact final excerpt',()=>{
  const s=setup()
  s.change(db=>{
    db.exec("UPDATE documents SET parent_id=1,sequence=0 WHERE id=4")
    insertCard(db,2,'accepted');insertCard(db,4,'planned')
    db.prepare('UPDATE document_versions SET content=? WHERE id=1').run('  “风”\r\nA-B-C  ')
    db.prepare('UPDATE document_versions SET content=? WHERE id=2').run('  😀回头。  ')
  })
  const {summary,issues}=s.preview()
  assert.deepEqual([summary.wordCount,summary.paragraphCount,summary.sceneCount,summary.acceptedSceneCount],[5,3,2,1])
  assert.deepEqual(summary.sources,[{document:1,version:1},{document:2,version:2}])
  assert.equal(summary.excerpt.quote,'😀回头。');assert.equal(summary.excerpt.anchor.start,2)
  assert.deepEqual(issues.map(x=>x.category),['length','hook'])
  s.change(db=>db.exec("UPDATE scene_cards SET status='accepted' WHERE document_id=4; UPDATE documents SET state='accepted' WHERE id=4; UPDATE document_versions SET state='accepted',content='门外？' WHERE id=4"))
  assert.equal(s.preview().summary.excerpt.quote,'门外？')
  s.change(db=>db.exec("UPDATE documents SET sequence=1 WHERE id=4"))
  assert.equal(s.preview().summary.excerpt.quote,'😀回头。')
})
test('legacy estimates handle empty planned chapters, quote limits, Unicode paragraphs and half-even rounding',()=>{
  const s=setup()
  s.change(db=>{db.exec("UPDATE document_versions SET content='' WHERE id=1");insertCard(db,2,'planned')})
  assert.deepEqual(s.preview().issues.map(x=>x.category),['workflow'])
  const text=value=>s.change(db=>db.prepare('UPDATE document_versions SET content=? WHERE id=1').run(value))
  text('"a"'+'z'.repeat(45));assert.equal(s.preview().summary.dialogueRatio,0.062)
  text('“'+'甲'.repeat(301)+'”\u0085Suddenly');assert.equal(s.preview().summary.dialogueRatio,0);assert.equal(s.preview().summary.endingHookSignal,true)
  text('“😀”\u2028𠀀');assert.equal(s.preview().summary.dialogueRatio,0.6);assert.equal(s.preview().summary.wordCount,0)
})
test('quality report replay, author decisions and history survive reopening; candidate-only edits leave source current',()=>{
  const s=setup(),id=randomUUID();let old=s.run(id)
  const issue=old.issues[0],change={id:issue.id,expected_token:issue.token,status:'dismissed',reason:'作者选择短章。'}
  s.service.apply(s.path,change,s.service.preview(s.path,change).token,randomUUID())
  s.change(db=>db.exec("UPDATE document_versions SET content='候选' WHERE state='candidate'"))
  old=s.run(id);assert.equal(old.stale,false);assert.equal(old.issues[0].status,'dismissed')
  s.change(db=>db.exec("UPDATE document_versions SET content='本章改写了。' WHERE id=1"))
  const reopened=createReview({readState:(p,fn)=>accessState(p,false,fn)}, {}, {})
  assert.equal(reopened.read(s.path,id).stale,true)
  assert.equal(reopened.history(s.path,issue.id)[0].reason,'作者选择短章。')
  s.run();assert.equal(reopened.list(s.path,s.target).items.length,2)
})
test('malformed identities, inconsistent scene approval and oversized sources cannot persist a partial report',()=>{
  const s=setup()
  assert.throws(()=>s.service.qualityPreview(s.path,{section:'quality',id:2}),/章节/)
  s.change(db=>{insertCard(db,2,'accepted');db.exec("UPDATE document_versions SET state='candidate' WHERE id=2")})
  assert.throws(()=>s.run(),/采用状态/)
  s.change(db=>{db.exec("UPDATE scene_cards SET status='planned'");db.prepare('UPDATE document_versions SET content=? WHERE id=1').run('a'.repeat(400001))})
  assert.throws(()=>s.run(),/上限/)
  assert.equal(s.service.list(s.path,s.target).items.length,0)
})
test('moving identical prose between a chapter and a scene invalidates the saved source location',()=>{
  const s=setup()
  s.change(db=>{insertCard(db,2,'accepted');db.exec("UPDATE document_versions SET content='' WHERE id=1; UPDATE document_versions SET content='相同原文。' WHERE id=2")})
  const old=s.run();assert.equal(old.summary.excerpt.anchor.document,2)
  s.change(db=>db.exec("UPDATE document_versions SET content='相同原文。' WHERE id=1; UPDATE document_versions SET content='' WHERE id=2"))
  assert.equal(s.service.read(s.path,old.run).stale,true)
  assert.equal(s.preview().summary.excerpt.anchor.document,1)
})
