import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {accessState} from '../../lg-books/src/state.js'
import {wordCount} from '../../lg-books/src/summary.js'
import {createReview} from '../src/service.js'
import {consistencySnapshot} from '../src/consistency.js'
import * as plugin from '../index.js'

function setup() {
 const path=mkdtempSync(join(tmpdir(),'lg-consistency-'));createBook(path).db.close()
 const books={readState:(p,fn)=>accessState(p,false,fn),changeState:(p,fn)=>accessState(p,true,fn),wordCount},target={section:'consistency',id:0}
 const change=fn=>books.changeState(path,fn),read=fn=>books.readState(path,fn)
 const addFact=(category,key,value,state='canonical',source=null,version=null,tags=[])=>change(db=>Number(db.prepare('INSERT INTO story_facts(category,fact_key,value,state,source_document_id,source_version_id,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,?)').run(category,key,value,state,source,version,JSON.stringify(tags),'now','now').lastInsertRowid))
 const review=createReview(books,{},{}),run=(scope=target,id=randomUUID())=>review.consistency(path,scope,id)
 return {path,books,target,change,read,addFact,review,run}
}
function seed(s) {
 const a=s.addFact('location','灯塔','南', 'canonical',1,1),b=s.addFact('location','灯塔','北')
 s.addFact('forbidden','魔法限制','A.B');s.addFact('character-status','林澈','死亡');s.addFact('location','灯塔','东','idea')
 s.change(db=>{
  db.prepare("UPDATE document_versions SET content='林澈说：这里没有 a.b。' WHERE id=1").run()
  db.prepare("INSERT INTO scene_cards(document_id,chapter_id,status,word_min,word_max,created_at,updated_at) VALUES (2,1,'approved',100,200,'now','now')").run()
  for(const event of ['船离港','钟声响'])db.prepare("INSERT INTO timeline_entries(label,sort_key,event,state,created_at,updated_at) VALUES ('午时','010',?,'canonical','now','now')").run(event)
  for(let i=0;i<13;i++)db.prepare("INSERT INTO foreshadowing(title,setup_note,state,created_at,updated_at) VALUES (?,'待回收','open','now','now')").run('伏笔'+i)
 })
 return {a,b}
}
test('all six legacy rule families retain concrete evidence; lexical/simultaneous events are hints, not verdicts',()=>{
 const s=setup();seed(s);const report=s.run(),categories=report.issues.map(item=>item.category)
 for(const category of ['canonical-conflict','scene-plan','scene-length','forbidden-content','character-availability','timeline','foreshadowing'])assert.ok(categories.includes(category),category)
 for(const category of ['forbidden-content','character-availability','timeline','foreshadowing'])assert.equal(report.issues.find(item=>item.category===category).severity,'info')
 const hit=report.issues.find(item=>item.category==='forbidden-content').evidence[1]
 assert.equal(hit.quote,'a.b');assert.deepEqual([hit.anchor.document,hit.anchor.version,hit.anchor.start,hit.anchor.end],[1,1,9,12])
 assert.equal(s.read(db=>db.prepare('SELECT content FROM document_versions WHERE id=1').get().content).slice(hit.anchor.start,hit.anchor.end),hit.quote)
 assert.equal(report.summary.facts,4);assert.equal(report.summary.openForeshadowing,13);assert.equal(report.stale,false)
 assert.equal(report.issues.find(item=>item.category==='foreshadowing').evidence.length,10)
})
test('unadopted/stale/unavailable facts produce source warnings and cannot create false current conflicts',()=>{
 const s=setup();s.addFact('place','钥匙','抽屉','canonical',1,1);s.addFact('place','钥匙','屋外','canonical',1,8)
 const stale=s.addFact('place','钥匙','河中','canonical',2,2)
 s.change(db=>db.prepare('UPDATE documents SET active_version_id=NULL WHERE id=2').run())
 // A broken manuscript reference is a hard error, not a silently incomplete report.
 assert.throws(()=>s.run(),/版本引用损坏/)
 s.change(db=>db.prepare("UPDATE documents SET active_version_id=2,state='archived' WHERE id=2").run())
 const report=s.run();assert.equal(report.issues.filter(i=>i.category==='fact-source').length,2)
 assert.equal(report.summary.currentFacts,1);assert.ok(!report.issues.some(i=>i.category==='canonical-conflict'))
 assert.ok(report.issues.some(i=>i.evidence[0].anchor.id===stale))
})
test('single chapter scope includes its current scenes, global facts/timeline, excludes other prose and unchosen candidates',()=>{
 const s=setup();seed(s)
 s.change(db=>db.prepare("UPDATE document_versions SET content='A.B 林澈' WHERE id=8").run())
 const report=s.run({section:'consistency',id:3})
 assert.equal(report.summary.documents,2);assert.equal(report.summary.openForeshadowing,null)
 assert.ok(report.issues.some(i=>i.category==='canonical-conflict'));assert.ok(report.issues.some(i=>i.category==='timeline'))
 assert.ok(!report.issues.some(i=>['forbidden-content','character-availability','scene-plan','foreshadowing'].includes(i.category)))
 assert.throws(()=>s.run({section:'consistency',id:6}),/章节或场景/)
 assert.throws(()=>s.run({section:'consistency',id:1,version:8}),/目标无效/)
})
test('saved reports are idempotent, version-sensitive and keep author decisions without changing story state',()=>{
 const s=setup();seed(s);const original=s.read(db=>db.prepare('SELECT * FROM document_versions ORDER BY id').all())
 const operation=randomUUID(),report=s.run(s.target,operation),count=s.read(db=>db.prepare('SELECT count(*) AS n FROM review_issues').get().n)
 assert.deepEqual(s.run(s.target,operation),report);assert.equal(s.read(db=>db.prepare('SELECT count(*) AS n FROM review_issues').get().n),count)
 const item=report.issues.find(i=>i.category==='character-availability'),change={id:item.id,expected_token:item.token,status:'dismissed',reason:'此处是对往事的回忆'},preview=s.review.preview(s.path,change)
 s.review.apply(s.path,change,preview.token,randomUUID());assert.equal(s.review.read(s.path,report.run).stale,false)
 assert.equal(s.review.history(s.path,item.id)[0].reason,change.reason)
 assert.deepEqual(s.read(db=>db.prepare('SELECT * FROM document_versions ORDER BY id').all()),original)
 s.change(db=>db.prepare("UPDATE story_facts SET value='西' WHERE id=1").run())
 assert.equal(s.review.read(s.path,report.run).stale,true);assert.equal(s.run(s.target,operation).stale,true)
 assert.throws(()=>s.run({section:'consistency',id:1},operation),/更换请求/)
 const second=s.run();assert.notEqual(second.run,report.run);assert.equal(s.review.read(s.path,report.run).issues.find(i=>i.id===item.id).status,'dismissed')
 assert.equal(s.review.list(s.path,s.target).items.length,2)
})
test('report source guards detect a manuscript/scene/timeline/foreshadow change and block stale saving',()=>{
 for(const sql of ["UPDATE document_versions SET content='new' WHERE id=1","UPDATE scene_cards SET plan='new' WHERE document_id=2","UPDATE timeline_entries SET event='new' WHERE id=1","UPDATE foreshadowing SET state='paid' WHERE id=1"]){
  const s=setup();seed(s);const {issues,...source}=consistencySnapshot(s.books,s.path,s.target)
  s.change(db=>db.exec(sql));assert.throws(()=>s.review.save(s.path,randomUUID(),'request','signature',source,{issues}),/来源已变化/)
  assert.equal(s.read(db=>db.prepare('SELECT count(*) AS n FROM review_issues').get().n),0)
 }
})
test('oversized scans fail visibly instead of saving incomplete or clean reports',()=>{
 const s=setup();s.change(db=>{for(let i=0;i<1001;i++)db.prepare("INSERT INTO story_facts(category,fact_key,value,state,created_at,updated_at) VALUES ('x',?,'v','canonical','now','now')").run(String(i))})
 assert.throws(()=>s.run(),/1000 条/);assert.equal(s.read(db=>db.prepare('SELECT count(*) AS n FROM review_issues').get().n),0)
 const other=setup();for(let i=0;i<51;i++)other.addFact('forbidden',String(i),'禁词'+i)
 other.change(db=>db.prepare('UPDATE document_versions SET content=? WHERE id=1').run('文'.repeat(400000)))
 assert.throws(()=>other.run(),/匹配量/)
})
test('bounded evidence never splits an emoji surrogate pair and its range still selects the exact source quote',()=>{
 const s=setup(),term='甲'.repeat(499)+'😀末';s.addFact('forbidden','字面约束',term)
 s.change(db=>db.prepare('UPDATE document_versions SET content=? WHERE id=1').run(term))
 const report=s.run(),hit=report.issues.find(item=>item.category==='forbidden-content').evidence[1]
 assert.equal(hit.quote.isWellFormed(),true);assert.equal(hit.quote.length,499)
 assert.equal(term.slice(hit.anchor.start,hit.anchor.end),hit.quote)
})
test('real Cordis API saves deterministic reports and exposes history with no model executor',async()=>{
 const s=setup();seed(s);const ctx=new Context(),routes=new Map()
 const deps=ctx.plugin(c=>{c.provide('literaryBooks',s.books);c.provide('literaryPlanning',{});c.provide('literaryContext',{});c.provide('connection',{fetch:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path)}}})});await deps.await()
 const fiber=ctx.plugin(plugin);await fiber.await()
 try{
  const response=await routes.get('/api/lg/review').fetch(new Request('http://localhost/api/lg/review',{method:'POST',body:JSON.stringify({action:'consistency',path:s.path,target:s.target,operation:randomUUID()})}))
  assert.equal(response.status,200);const result=await response.json();assert.ok(result.value.issues.length>=7)
  assert.equal(ctx.get('literaryExecution'),undefined);assert.equal(ctx.get('literaryReview').list(s.path,s.target).items.length,1)
 }finally{await fiber.dispose();assert.equal(routes.size,0);await deps.dispose()}
})
