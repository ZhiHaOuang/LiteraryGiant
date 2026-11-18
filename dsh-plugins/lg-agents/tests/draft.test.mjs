import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { readManuscript } from '../../lg-books/src/manuscript.js'
import { writeManuscript } from '../../lg-books/src/write.js'
import { wordCount } from '../../lg-books/src/summary.js'
import { createPlanning } from '../../lg-planning/src/service.js'
import { createMemory } from '../../lg-memory/src/service.js'
import { createContext } from '../../lg-context/src/service.js'
import { createAgents } from '../src/service.js'
import { Executor } from '../../lg-execution/src/run.js'
function setup(during=()=>{}, output={content:'林澈扣住门闩，风把灯焰压低。她捧起信封，遮住那一点火。',notes:'留下守灯。'}) {
 const path=mkdtempSync(join(tmpdir(),'lg-draft-agent-'));createBook(path).db.close()
 const books={readState:(p,f)=>accessState(p,false,f),changeState:(p,f)=>accessState(p,true,f),manuscript:readManuscript,wordCount,
  candidate:(p,i,g)=>writeManuscript(p,{...i,action:'candidate'},g)}
 let context
 const planning=createPlanning(books,(p,proof,id)=>id?context.verifyPlanSources(p,proof.context,id):context.verify(p,proof.context))
 context=createContext(books,createMemory(books),()=>planning)
 const mutate=change=>planning.apply(path,change,planning.preview(path,change).token,randomUUID())
 let scene=mutate({action:'scene.create',slug:'door',title:'灯塔门前',chapter_id:1,card:{goal:'留下守灯',word_min:100,word_max:200}})
 const id=scene.document_id
 const change=(action,extra={})=>mutate({action,id,expected_token:planning.read(path,'scenes',id).token,...extra})
 change('scene.plan',{plan:'她关门，风压低灯焰；她用信封护住火苗，留下守灯。'});change('scene.approve')
 let calls=0;const saved=new Map()
 const execution={preview:input=>new Executor(null,null,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:2,maxOutputTokens:4096,maxInputBytes:16000}).preview(input),
  async run(operation){if(saved.has(operation))return saved.get(operation);calls++;during({path,books,planning,change});const result={id:operation,status:'succeeded',result:{text:typeof output==='string'?output:JSON.stringify(output)}};saved.set(operation,result);return result}}
 const agents=createAgents(books,execution,{roles:[]},undefined,()=>context,()=>planning),body=books.manuscript(path,id)
 const input={task:'draft-scene',path,document:id,version:body.selected.id,token:body.token,request:'保持近距离视角。',context:{documents:[6]},operation:randomUUID()}
 const run=()=>agents.run({...input,signature:agents.preview(input).signature})
 const accept=version=>writeManuscript(path,{action:'accept',document:id,version,token:input.token,operation:randomUUID()},null,null,r=>context.verify(path,r),r=>planning.verifyDraft(path,r))
 return {path,id,books,planning,context,agents,input,run,accept,change,calls:()=>calls,
  changeSource:()=>books.changeState(path,db=>db.prepare("UPDATE document_versions SET content='人物已改变' WHERE id=6").run())}
}
test('approved empty scene produces a candidate, word-range warning and replay without additional dispatch',async()=>{
 const s=setup(),result=await s.run()
 assert.equal(result.status,'candidate-ready');assert.equal(s.calls(),1)
 assert.equal(result.output.inRange,false);assert.ok(result.output.words>0)
 assert.equal(s.books.manuscript(s.path,s.id).document.content,'')
 const replay=await s.run();assert.equal(replay.candidate.version,result.candidate.version);assert.equal(s.calls(),1)
 assert.equal(s.accept(result.candidate.version).changesManuscript,true)
 assert.match(s.books.manuscript(s.path,s.id).document.content,/信封/)
 assert.throws(()=>s.agents.preview({...s.input,...{token:s.books.manuscript(s.path,s.id).token,version:result.candidate.version}}),/已有正文/)
})
test('unapproved and pending replacement plans refuse dispatch; changed context invalidates preview',async()=>{
 const s=setup();s.change('scene.update',{card:{goal:'追船'}})
 assert.throws(()=>s.agents.preview(s.input),/批准/);assert.equal(s.calls(),0)
 const t=setup();t.change('scene.plan',{plan:'新的待审计划'})
 assert.throws(()=>t.agents.preview(t.input),/待审/);assert.equal(t.calls(),0)
 const u=setup(),preview=u.agents.preview(u.input);u.changeSource()
 await assert.rejects(u.agents.run({...u.input,signature:preview.signature}),/重新预览/);assert.equal(u.calls(),0)
})
test('plan changing during generation retains output without candidate; malformed output does not save',async()=>{
 const s=setup(({change})=>change('scene.plan',{plan:'并发修改'})),result=await s.run()
 assert.equal(result.status,'candidate-pending');assert.ok(result.output.content);assert.equal(result.candidate,undefined)
 assert.equal(s.books.manuscript(s.path,s.id).versions.length,1)
 const t=setup(()=>{},'{invalid');assert.equal((await t.run()).status,'invalid-output')
 assert.equal(t.books.manuscript(t.path,t.id).versions.length,1)
})
test('adoption requires planning service and refuses changed approved plans or external context',async()=>{
 const s=setup(),result=await s.run()
 const input={action:'accept',document:s.id,version:result.candidate.version,token:s.input.token,operation:randomUUID()}
 assert.throws(()=>writeManuscript(s.path,input,null,null,r=>s.context.verify(s.path,r)),/lg-planning/)
 s.change('scene.plan',{plan:'换个结局'});s.change('scene.approve')
 assert.throws(()=>s.accept(result.candidate.version),/已变化/)
 assert.equal(s.books.manuscript(s.path,s.id).document.content,'')
 const t=setup(),candidate=await t.run();t.changeSource()
 assert.throws(()=>t.accept(candidate.candidate.version),/已变化/)
})
test('generated plan survives its own approval but still binds external source versions',()=>{
 const s=setup(),context=s.context.build(s.path,{documents:[6],scene:s.id})
 const before=s.planning.read(s.path,'scenes',s.id)
 const proposal=s.planning.propose(s.path,{action:'scene.plan',id:s.id,expected_token:before.token,plan:'风吹灭灯，她重新点亮。'},randomUUID(),
  {schema:'lg.planning-generation.v1',run:randomUUID(),task:'scene-plan',context:context.receipt})
 assert.ok(proposal.metadata.lg_plan_proposal.generation)
 s.change('scene.approve')
 assert.throws(()=>s.context.verify(s.path,context.receipt),/已变化/)
 assert.equal(s.planning.approved(s.path,s.id).item.plan,'风吹灭灯，她重新点亮。')
 assert.ok(s.agents.preview(s.input).draft)
 s.changeSource();assert.throws(()=>s.planning.approved(s.path,s.id),/外部材料已变化/)
})
