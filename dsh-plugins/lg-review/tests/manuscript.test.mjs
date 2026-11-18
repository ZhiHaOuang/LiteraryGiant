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
import { createPlanning } from '../../lg-planning/src/service.js'
import { createMemory } from '../../lg-memory/src/service.js'
import { createContext } from '../../lg-context/src/service.js'
import { createAgents } from '../../lg-agents/src/service.js'
import { parseResult } from '../../lg-agents/src/tasks.js'
import { Executor } from '../../lg-execution/src/run.js'
import { createReview } from '../src/service.js'
function setup(during=()=>{}) {
 const path=mkdtempSync(join(tmpdir(),'lg-manuscript-review-'));createBook(path).db.close()
 const books={readState:(p,f)=>accessState(p,false,f),changeState:(p,f)=>accessState(p,true,f),manuscript:readManuscript,
  candidate:(p,i,g)=>writeManuscript(p,{...i,action:'candidate'},g)}
 books.changeState(path,db=>db.prepare("UPDATE document_versions SET content='开场😀。林澈关上灯。灯仍亮着。余声。' WHERE id=1").run())
 const planning=createPlanning(books),context=createContext(books,createMemory(books),()=>planning),review=createReview(books,planning,context)
 const body=books.manuscript(path,1),start=body.selected.content.indexOf('林澈'),end=body.selected.content.indexOf('余声')
 const target={section:'manuscript',id:1,version_id:1,token:body.token,start,end}
 const input={task:'manuscript-review',path,target,context:{documents:[6]},request:'检查灯的状态前后矛盾，保留措辞偏好给作者判断。',operation:randomUUID()}
 const raw={issues:[{severity:'warning',category:'因果',evidence:[1,2],message:'关灯后灯仍亮，动作与结果矛盾。',suggestion:'把关灯改成调低灯焰。'}]}
 const runs=new Map();let calls=0
 const execution={preview:i=>new Executor(null,null,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:2,maxOutputTokens:4096,maxInputBytes:16000}).preview(i),
  async run(id,i){if(runs.has(id))return runs.get(id);calls++;during({path,books,review});const payload=JSON.parse(i.input),result={id,status:'succeeded',result:{text:payload.feedback?'<lg-replacement>\n林澈调低灯焰。灯仍亮着。\n</lg-replacement>':JSON.stringify(payload.units?raw:{replacement:'林澈调低灯焰。灯仍亮着。',notes:'只修正灯的状态衔接。'})}};runs.set(id,result);return result},status:id=>runs.get(id)}
 const agents=createAgents(books,execution,{roles:[]},undefined,()=>context,()=>planning,()=>review)
 const save=()=>{const source=review.snapshot(path,target,input.context);return review.save(path,randomUUID(),'request','signature',source,review.validate(JSON.stringify(raw),source))}
 const revision=report=>({task:'polish',path,...report.revisionTarget,context:{documents:[]},feedback:{run:report.run,issues:[report.issues[0].id]},request:'仅修正选定矛盾。',operation:randomUUID()})
 const decide=(report,status='dismissed')=>{const issue=review.read(path,report.run).issues[0],change={id:issue.id,expected_token:issue.token,status,reason:'作者判断'};return review.apply(path,change,review.preview(path,change).token,randomUUID())}
 const accept=(version,feedback=true)=>writeManuscript(path,{action:'accept',document:1,version,token:body.token,operation:randomUUID()},null,null,r=>context.verify(path,r),null,feedback?r=>review.verifyFeedback(path,r):null)
 return {path,books,context,review,agents,input,target,body,save,revision,decide,accept,calls:()=>calls,
  changeSource:()=>books.changeState(path,db=>db.prepare("UPDATE document_versions SET content='新人物设定。' WHERE id=6").run())}
}
test('manuscript review persists absolute evidence and selected-issue revision preserves outside text',async()=>{
 const s=setup(),preview=s.agents.preview(s.input),result=await s.agents.run({...s.input,signature:preview.signature})
 assert.equal(result.status,'review-ready');assert.equal(result.report.target.section,'manuscript')
 const evidence=result.report.issues[0].evidence[0]
 assert.equal(evidence.quote,s.body.selected.content.slice(evidence.anchor.start,evidence.anchor.end));assert.equal(evidence.anchor.start,s.target.start)
 const repeat=await s.agents.run({...s.input,signature:preview.signature});assert.equal(repeat.replayed,true);assert.equal(s.calls(),1)
 const input=s.revision(result.report),plan=s.agents.preview(input);assert.match(plan.modelInput.input,/关灯后灯仍亮/)
 const revised=await s.agents.run({...input,signature:plan.signature});assert.equal(revised.status,'candidate-ready')
 const candidate=s.books.manuscript(s.path,1,revised.candidate.version)
 assert.equal(candidate.selected.content,'开场😀。林澈调低灯焰。灯仍亮着。余声。');assert.equal(candidate.document.content,s.body.document.content)
 assert.equal(candidate.selected.metadata.generation.feedback.run,result.report.run)
 const replay=await s.agents.run({...input,signature:plan.signature});assert.equal(replay.candidate.version,revised.candidate.version);assert.equal(s.calls(),2)
 assert.throws(()=>s.accept(revised.candidate.version,false),/lg-review/)
 assert.equal(s.accept(revised.candidate.version).changesManuscript,true)
 const historic=s.review.read(s.path,result.report.run);assert.equal(historic.stale,true);assert.equal(historic.issues[0].status,'open')
 const old=await s.agents.run({...s.input,signature:preview.signature});assert.equal(old.replayed,true);assert.equal(old.report.stale,true);assert.equal(s.calls(),2)
})
test('review refuses split surrogate ranges, wrong task classification, rejected version and changed revision range',()=>{
 const s=setup()
 assert.throws(()=>s.agents.preview({...s.input,target:{...s.target,start:3}}),/选区/)
 assert.throws(()=>s.agents.preview({...s.input,task:'plan-review'}),/分类/)
 const report=s.save(),input=s.revision(report)
 assert.throws(()=>s.agents.preview({...input,end:input.end-1}),/不一致/)
 s.books.changeState(s.path,db=>db.prepare("UPDATE document_versions SET state='rejected' WHERE id=1").run())
 assert.throws(()=>s.agents.preview(s.input),/状态/);assert.equal(s.review.read(s.path,report.run).stale,true)
})
test('dismissal before dispatch and during generation prevents new candidate without closing findings automatically',async()=>{
 const s=setup(),report=s.save(),input=s.revision(report),preview=s.agents.preview(input);s.decide(report)
 await assert.rejects(s.agents.run({...input,signature:preview.signature}),/已经处理/);assert.equal(s.calls(),0)
 let dismiss;const t=setup(()=>dismiss()),other=t.save(),revision=t.revision(other);dismiss=()=>t.decide(other)
 const result=await t.agents.run({...revision,signature:t.agents.preview(revision).signature})
 assert.equal(result.status,'candidate-pending');assert.ok(result.output.replacement);assert.equal(result.candidate,undefined)
 assert.equal(t.books.manuscript(t.path,1).versions.length,2)
})
test('adoption verifies selected review context even when revision chooses different context',async()=>{
 const s=setup(),report=s.save(),input=s.revision(report),result=await s.agents.run({...input,signature:s.agents.preview(input).signature})
 s.changeSource();assert.throws(()=>s.accept(result.candidate.version),/审阅来源/)
 assert.equal(s.books.manuscript(s.path,1).document.activeVersion,1)
 const t=setup(),other=t.save(),rev=t.revision(other),candidate=await t.agents.run({...rev,signature:t.agents.preview(rev).signature});t.decide(other,'resolved')
 assert.throws(()=>t.accept(candidate.candidate.version),/已经处理/)
})
test('candidate revision retains source candidate approval checks and legacy approval candidates fail before dispatch',async()=>{
 const s=setup(),material=s.context.build(s.path,{documents:[6]})
 const parent=s.books.candidate(s.path,{document:1,sourceVersion:1,token:s.body.token,content:s.body.document.content,reason:'合成模型候选',operation:randomUUID()},{context:material.receipt})
 const input={task:'polish',path:s.path,document:1,version:parent.version,token:s.body.token,start:s.target.start,end:s.target.end,request:'修正灯的矛盾',operation:randomUUID()}
 const result=await s.agents.run({...input,signature:s.agents.preview(input).signature});assert.equal(result.status,'candidate-ready')
 s.changeSource();assert.throws(()=>s.accept(result.candidate.version),/已变化/)
 s.books.changeState(s.path,db=>{const row=db.prepare('SELECT metadata_json FROM document_versions WHERE id=?').get(parent.version);db.prepare('UPDATE document_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.metadata_json),required_decision:{legacy:true}}),parent.version)})
 assert.throws(()=>s.agents.preview(input),/旧审批/)
})
test('reviewing an unadopted candidate supports revision while leaving its source and manuscript intact',async()=>{
 const s=setup(),parent=s.books.candidate(s.path,{document:1,sourceVersion:1,token:s.body.token,content:s.body.document.content,reason:'作者候选',operation:randomUUID()})
 const input={...s.input,target:{...s.target,version_id:parent.version}},result=await s.agents.run({...input,signature:s.agents.preview(input).signature})
 assert.equal(result.report.revisionTarget.version,parent.version)
 const revision=s.revision(result.report),updated=await s.agents.run({...revision,signature:s.agents.preview(revision).signature})
 assert.equal(updated.status,'candidate-ready');assert.equal(s.books.manuscript(s.path,1,parent.version).selected.content,s.body.document.content)
 assert.equal(s.books.manuscript(s.path,1).document.activeVersion,1)
 assert.equal(s.accept(updated.candidate.version).changesManuscript,true)
})

test('feedback prose block preserves quotes and rejects missing, duplicated or explanatory boundaries',()=>{
 const text='她说："灯还亮着。"\n\n窗外只有雨声。'
 assert.equal(parseResult('polish','<lg-replacement>\n'+text+'\n</lg-replacement>',{},'replacement-block-v1').replacement,text)
 for(const raw of [text,'说明\n<lg-replacement>\n正文\n</lg-replacement>','<lg-replacement>\n正文\n</lg-replacement>\n说明','<lg-replacement>\n正文\n</lg-replacement>\n<lg-replacement>\n另文\n</lg-replacement>'])assert.throws(()=>parseResult('polish',raw,{},'replacement-block-v1'),/边界/)
 assert.throws(()=>parseResult('polish','{"replacement":"正文","notes":"改了"引号""}',{}))
})
test('legacy approval markers block model revision but do not block read-only evidence review',()=>{
 const s=setup(),parent=s.books.candidate(s.path,{document:1,sourceVersion:1,token:s.body.token,content:s.body.document.content,reason:'合成旧候选',operation:randomUUID()})
 s.books.changeState(s.path,db=>{const row=db.prepare('SELECT metadata_json FROM document_versions WHERE id=?').get(parent.version);db.prepare('UPDATE document_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.metadata_json),required_decision:{legacy:true}}),parent.version)})
 const input={task:'review',path:s.path,document:1,version:parent.version,token:s.body.token,start:s.target.start,end:s.target.end,request:'只审阅',operation:randomUUID()}
 assert.ok(s.agents.preview(input).signature);assert.throws(()=>s.agents.preview({...input,task:'polish'}),/旧审批/)
})
