import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { createDocuments } from '../../lg-books/src/documents.js'
import { accessState } from '../../lg-books/src/state.js'
import { readManuscript } from '../../lg-books/src/manuscript.js'
import { wordCount } from '../../lg-books/src/summary.js'
import { writeManuscript } from '../../lg-books/src/write.js'
import { createMemory } from '../../lg-memory/src/service.js'
import { createContext } from '../../lg-context/src/service.js'
import { createPlanning } from '../../lg-planning/src/service.js'
import { createReview } from '../../lg-review/src/service.js'
import { createAgents } from '../../lg-agents/src/service.js'
import { Executor } from '../../lg-execution/src/run.js'
import { createWorkflows } from '../src/service.js'

function setup({answer,during}={}) {
  const path=mkdtempSync(join(tmpdir(),'lg-workflow-'));createBook(path).db.close()
  const books={wordCount,readState:(p,fn)=>accessState(p,false,fn),changeState:(p,fn)=>accessState(p,true,fn),manuscript:readManuscript,candidate:(p,input,generation)=>writeManuscript(p,{...input,action:'candidate'},generation)}
  books.documents=createDocuments(books)
  const planning=createPlanning(books,(_path,proof)=>context.verify(path,proof.context)),context=createContext(books,createMemory(books),()=>planning),review=createReview(books,planning,context)
  const calls=new Map();let count=0
  const preview=new Executor(null,null,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:2,maxOutputTokens:1024,maxInputBytes:30000})
  const execution={preview:i=>preview.preview(i),status:id=>calls.get(id),cancel:()=>false,async run(id,input,signal){
    if(calls.has(id))return calls.get(id)
    count++;calls.set(id,{id,status:'reserved'});await during?.(signal)
    const payload=JSON.parse(input.input),raw=answer??(payload.units?JSON.stringify({issues:payload.units.some(unit=>unit.text.includes('仍亮'))?[{category:'因果',severity:'warning',evidence:[1,2],message:'关灯后仍亮。',suggestion:'灯应熄灭。'}]:[]}):payload.feedback?'<lg-replacement>\n林澈关上灯。灯灭了。\n</lg-replacement>':JSON.stringify({replacement:'林澈关上灯。灯仍亮着。',notes:'候选'}))
    const result={id,status:signal?.aborted?'cancelled':'succeeded',reservedCny:0.01,result:{text:typeof raw==='function'?raw(payload):raw,usage:{inputTokens:100,outputTokens:50},elapsedMs:1,estimatedCny:0.0002}};calls.set(id,result);return result
  }}
  const agents=createAgents(books,execution,{roles:[]},undefined,()=>context,()=>planning,()=>review)
  const workflows=createWorkflows(books,agents,()=>review,()=>planning),body=books.manuscript(path,1)
  const input={source:{document:1,version:1,token:body.token,start:0,end:body.selected.content.length},request:'改善句子衔接。',reviewRequest:'检查事件因果。',limits:{maxCalls:4,maxReservedCny:1}}
  const create=(value=input,id=randomUUID())=>workflows.create(path,value,workflows.preview(path,value).token,id)
  const advance=async(id,feedback)=>{const p=workflows.nextPreview(path,id,feedback);return workflows.advance(path,id,feedback,p.token)}
  const rewrite=fn=>books.changeState(path,db=>{const row=db.prepare('SELECT id,state FROM lg_workflow_runs LIMIT 1').get(),state=JSON.parse(row.state);fn(state);db.prepare('UPDATE lg_workflow_runs SET state=? WHERE id=?').run(JSON.stringify(state),row.id)})
  return {path,books,agents,review,planning,context,execution,workflows,input,body,create,advance,rewrite,calls,count:()=>count}
}
test('revision, candidate review, selected feedback and second review share one persisted scope and budget',async()=>{
  const s=setup(),flow=s.create();assert.equal(s.count(),0)
  let value=await s.advance(flow.id);assert.equal(value.status,'ready');assert.equal(value.steps[0].result.candidate.changesManuscript,false)
  const firstVersion=value.steps[0].result.candidate.version
  value=await s.advance(flow.id);assert.equal(value.status,'awaiting-author');assert.equal(value.steps[1].task.target.version_id,firstVersion)
  const report=s.review.read(s.path,value.steps[1].result.report.run);assert.equal(report.issues.length,1)
  assert.throws(()=>s.workflows.nextPreview(s.path,flow.id),/选择/)
  const feedback={issues:[report.issues[0].id],request:'仅修正灯的矛盾。'}
  value=await s.advance(flow.id,feedback);assert.equal(value.steps[2].task.version,firstVersion)
  value=await s.advance(flow.id);assert.equal(value.steps[3].result.report.issues,0);assert.equal(s.count(),4)
  assert.equal(s.books.manuscript(s.path,1).document.activeVersion,1);assert.equal(s.review.read(s.path,report.run).issues[0].status,'open')
  assert.throws(()=>s.workflows.nextPreview(s.path,flow.id,feedback),/调用上限/)
  assert.equal(s.workflows.close(s.path,flow.id,value.token).status,'closed')
  assert.equal(s.workflows.list(s.path).items[0].steps,4)
})
test('duplicate creation and concurrent advances cannot duplicate calls or reserve a step twice',async()=>{
  let release;const wait=new Promise(resolve=>release=resolve),s=setup({during:()=>wait}),flow=s.create(),p=s.workflows.nextPreview(s.path,flow.id)
  assert.equal(s.create(s.input,flow.id).id,flow.id)
  const pending=s.workflows.advance(s.path,flow.id,null,p.token)
  await new Promise(resolve=>setImmediate(resolve))
  const other=createWorkflows(s.books,s.agents,()=>s.review)
  const repeated=await other.advance(s.path,flow.id,null,p.token);assert.equal(repeated.steps.length,1)
  release();const completed=await pending;assert.equal(s.count(),1)
  assert.equal((await other.advance(s.path,flow.id,null,p.token)).reservedMicros,completed.reservedMicros)
  assert.equal(s.count(),1);assert.throws(()=>s.create({...s.input,request:'不同要求'},flow.id),/更换任务/)
})
test('restart recovery reuses a successful operation and leaves uncertain reservations inspect-only',async()=>{
  const s=setup(),flow=s.create(),result=await s.advance(flow.id),operation=result.steps[0].task.operation
  s.rewrite(state=>{state.status='running';state.steps[0].status='running';delete state.steps[0].result})
  const other=createWorkflows(s.books,s.agents,()=>s.review),recovered=await other.recover(s.path,flow.id)
  assert.equal(recovered.steps[0].result.candidate.version,result.steps[0].result.candidate.version);assert.equal(s.count(),1)
  s.rewrite(state=>{state.status='running';state.steps[0].status='running';delete state.steps[0].result})
  s.calls.set(operation,{id:operation,status:'reserved'})
  assert.match((await other.recover(s.path,flow.id)).recoveryMessage,/不重新/);assert.equal(s.count(),1)
  s.calls.delete(operation);assert.match((await other.recover(s.path,flow.id)).recoveryMessage,/不重新/);assert.equal(s.count(),1)
})
test('call and money ceilings survive reopening; changed sources cannot expand or restart work',async()=>{
  const s=setup(),first=s.workflows.preview(s.path,s.input).plan.reservedCny
  assert.throws(()=>s.workflows.preview(s.path,{...s.input,limits:{maxCalls:4,maxReservedCny:first/2}}),/预算/)
  const flow=s.create({...s.input,limits:{maxCalls:2,maxReservedCny:first+0.000001}});await s.advance(flow.id)
  assert.throws(()=>s.workflows.nextPreview(s.path,flow.id),/预算/)
  const reopened=createWorkflows(s.books,s.agents,()=>s.review)
  assert.throws(()=>reopened.nextPreview(s.path,flow.id),/预算/);assert.equal(s.count(),1)
  s.books.changeState(s.path,db=>db.prepare('UPDATE document_versions SET content=? WHERE id=1').run('来源被作者修改。'))
  assert.throws(()=>reopened.nextPreview(s.path,flow.id),/变化/);assert.equal(s.count(),1)
})
test('no textual progress and invalid output stop the chain without adopting prose',async()=>{
  const s=setup({answer:JSON.stringify({replacement:'林澈关上灯。海风停了。',notes:'未改'})}),flow=s.create(),result=await s.advance(flow.id)
  assert.equal(result.status,'stopped');assert.match(result.reason,/未产生文字变化/);assert.equal(s.count(),1)
  assert.throws(()=>s.workflows.nextPreview(s.path,flow.id),/不能开始/)
  const t=setup({answer:'invalid'}),bad=t.create(),failed=await t.advance(bad.id)
  assert.equal(failed.status,'stopped');assert.equal(failed.steps[0].result.status,'invalid-output');assert.equal(t.count(),1)
  assert.equal(t.books.manuscript(t.path,1).document.activeVersion,1)
})
test('author stop persists across completion and prevents dispatch of the review step',async()=>{
  let release;const wait=new Promise(resolve=>release=resolve),s=setup({during:()=>wait}),flow=s.create(),p=s.workflows.nextPreview(s.path,flow.id)
  const pending=s.workflows.advance(s.path,flow.id,null,p.token);await new Promise(resolve=>setImmediate(resolve))
  const current=s.workflows.read(s.path,flow.id);s.workflows.stop(s.path,flow.id,current.token,'作者停止。');release()
  const result=await pending;assert.equal(result.status,'stopped');assert.equal(result.steps[0].status,'completed')
  assert.throws(()=>s.workflows.nextPreview(s.path,flow.id),/不能开始/);assert.equal(s.count(),1)
})
test('plugin disposal aborts an in-flight model and does not start a following step',async()=>{
  const s=setup({during:signal=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))}),flow=s.create(),p=s.workflows.nextPreview(s.path,flow.id)
  const pending=s.workflows.advance(s.path,flow.id,null,p.token);await new Promise(resolve=>setImmediate(resolve));await s.workflows.dispose()
  assert.equal((await pending).status,'stopped');assert.equal(s.count(),1)
  assert.throws(()=>s.workflows.advance(s.path,flow.id,null,p.token),/停用/)
})
test('pending persistence recovers the same successful call, while an explicit stop remains effective',async()=>{
  for(const stopped of [false,true]){
    const s=setup();let first=true
    const agents={...s.agents,async run(...args){const value=await s.agents.run(...args);if(first){first=false;return {...value,status:'candidate-pending',candidate:undefined,candidateError:'暂时未保存'}}return value}}
    const service=createWorkflows(s.books,agents,()=>s.review),flow=service.create(s.path,s.input,service.preview(s.path,s.input).token,randomUUID()),plan=service.nextPreview(s.path,flow.id)
    const result=await service.advance(s.path,flow.id,null,plan.token);assert.equal(result.status,'stopped')
    if(stopped)service.stop(s.path,flow.id,result.token,'作者停止。')
    const recovered=await service.recover(s.path,flow.id)
    assert.equal(recovered.status,stopped?'stopped':'ready');assert.ok(recovered.steps[0].result.candidate);assert.equal(s.count(),1)
    assert.equal(recovered.reservedMicros,result.reservedMicros)
  }
})

test('chapter workflow drafts the whole chapter, reviews that candidate and revises only author-selected issues',async()=>{
  const s=setup(),flow=s.create({...s.input,kind:'chapter'})
  assert.equal(flow.definition.schema,'lg.chapter-workflow.v1')
  assert.equal(flow.definition.task.task,'draft-chapter');assert.equal(flow.definition.task.role,'chapter-writer')
  let result=await s.advance(flow.id),candidate=result.steps[0].result.candidate.version
  assert.deepEqual(result.steps[0].result.range,{start:0,end:'林澈关上灯。灯仍亮着。'.length})
  result=await s.advance(flow.id)
  const report=s.review.read(s.path,result.steps[1].result.report.run)
  assert.equal(result.steps[1].task.target.version_id,candidate)
  const feedback={issues:[report.issues[0].id],request:'只修正灯的矛盾。'}
  const next=s.workflows.nextPreview(s.path,flow.id,feedback)
  assert.equal(next.task.task,'polish');assert.equal(next.task.role,'manuscript-editor')
  result=await s.workflows.advance(s.path,flow.id,feedback,next.token)
  result=await s.advance(flow.id)
  assert.equal(result.steps[3].result.report.issues,0);assert.equal(s.count(),4)
  assert.equal(s.books.manuscript(s.path,1).document.activeVersion,1)
  assert.equal(s.review.read(s.path,report.run).issues[0].status,'open')
})

test('empty chapter workflow restores its original successful draft across restart without another model call',async()=>{
  const s=setup();s.books.changeState(s.path,db=>db.prepare('UPDATE document_versions SET content=? WHERE id=1').run(''))
  const body=s.books.manuscript(s.path,1),input={...s.input,kind:'chapter',source:{document:1,version:body.selected.id,token:body.token,start:0,end:0}}
  const flow=s.create(input),result=await s.advance(flow.id)
  assert.equal(result.status,'ready');assert.equal(s.count(),1)
  s.rewrite(state=>{state.status='running';state.steps[0].status='running';delete state.steps[0].result})
  const restored=createWorkflows(s.books,s.agents,()=>s.review)
  const current=await restored.recover(s.path,flow.id)
  assert.equal(current.steps[0].result.candidate.version,result.steps[0].result.candidate.version)
  assert.equal(s.count(),1);assert.equal(s.books.manuscript(s.path,1).document.content,'')
  assert.equal(restored.nextPreview(s.path,flow.id).task.task,'manuscript-review')
  assert.throws(()=>s.workflows.preview(s.path,{...input,kind:'automatic'}),/未知/)
})

test('workflow review keeps original creation requirements through initial and feedback candidates',async()=>{
  const s=setup(),flow=s.create({...s.input,kind:'chapter',request:'只写林澈可感知的内容，以他离开结束。'})
  await s.advance(flow.id)
  const preview=s.workflows.nextPreview(s.path,flow.id),payload=JSON.parse(preview.plan.modelInput.input)
  assert.equal(payload.requirements,flow.definition.task.request);assert.equal(payload.request,s.input.reviewRequest)
  let value=await s.advance(flow.id);const report=s.review.read(s.path,value.steps[1].result.report.run)
  await s.advance(flow.id,{issues:[report.issues[0].id],request:'只修正灯的矛盾。'})
  const second=s.workflows.nextPreview(s.path,flow.id)
  assert.equal(JSON.parse(second.plan.modelInput.input).requirements,flow.definition.task.request)
  value=await s.advance(flow.id);assert.equal(value.steps.length,4)
})

test('review requirement bounds and changed requirement signatures refuse dispatch and replay',async()=>{
  const s=setup(),flow=s.create();await s.advance(flow.id)
  const next=s.workflows.nextPreview(s.path,flow.id),input=next.task
  assert.throws(()=>s.agents.preview({...input,requirements:'x'.repeat(2001)}),/2000/)
  const altered={...input,requirements:'不同原始要求'}
  assert.notEqual(s.agents.preview(altered).signature,next.plan.signature)
  await assert.rejects(s.agents.run(altered),/变化/);assert.equal(s.count(),1)
  await s.agents.run(input);assert.equal(s.count(),2)
  await assert.rejects(s.agents.run(altered),/更换/);assert.equal(s.count(),2)
  const legacy=s.agents.preview({...input,requirements:undefined})
  assert.equal(JSON.parse(legacy.modelInput.input).requirements,undefined)
})

function sequenceSetup() {
  const s=setup({answer:JSON.stringify({content:'林澈把旧信折好，压在铜灯下。',notes:'合成候选'})})
  const plan=change=>s.planning.apply(s.path,change,s.planning.preview(s.path,change).token,randomUUID())
  function addScene(slug,chapter=3) {
    let item=plan({action:'scene.create',slug,title:slug,chapter_id:chapter,card:{goal:slug}})
    item=plan({action:'scene.plan',id:item.document_id,expected_token:item.token,plan:'通过一个可见动作完成'+slug})
    return plan({action:'scene.approve',id:item.document_id,expected_token:item.token})
  }
  const scenes=['开灯','读信','离开'].map(slug=>addScene(slug).document_id)
  const chapter=s.books.manuscript(s.path,3)
  const input={kind:'scenes',source:{document:3,version:chapter.selected.id,token:chapter.token},request:'保持动作连续。',scenes:scenes.slice(0,2),limits:{maxCalls:3,maxReservedCny:1}}
  function decide(id,version,action='accept') {
    const current=s.books.manuscript(s.path,id,version)
    return writeManuscript(s.path,{action,document:id,version,token:current.token,operation:randomUUID()},null,null,
      proof=>s.context.verify(s.path,proof),proof=>s.planning.verifyDraft(s.path,proof))
  }
  return {...s,plan,scenes,input,addScene,decide}
}
test('ordered scenes wait for the author and carry only the adopted text into the next actual input',async()=>{
  const s=sequenceSetup(),order=[s.scenes[1],s.scenes[0]],flow=s.create({...s.input,scenes:order})
  assert.equal(s.count(),0)
  let value=await s.advance(flow.id)
  assert.equal(value.status,'awaiting-scene');assert.equal(value.steps[0].task.document,order[0])
  const first=value.steps[0].result.candidate.version
  assert.throws(()=>s.workflows.nextPreview(s.path,flow.id),/采用或拒绝/)
  s.decide(order[0],first)
  const next=s.workflows.nextPreview(s.path,flow.id)
  assert.equal(next.task.document,order[1]);assert.equal(next.plan.context.receipt.sources.find(item=>item.kind==='document').identity.version,first)
  assert.match(next.plan.modelInput.input,/旧信折好/)
  value=await s.workflows.advance(s.path,flow.id,null,next.token)
  assert.equal(value.steps.length,2);assert.equal(s.count(),2)
  assert.equal(s.books.manuscript(s.path,order[1]).selected.content,'')
  assert.equal(s.books.manuscript(s.path,3).document.content,'')
  assert.throws(()=>s.workflows.nextPreview(s.path,flow.id),/已完成|上限/)
})
test('a saved scene remains reviewable when its original execution ledger is unavailable',async()=>{
  const s=sequenceSetup(),flow=s.create(s.input),first=await s.advance(flow.id)
  const offline=createWorkflows(s.books,{...s.agents,status(){throw new Error('账本不可用')}},()=>s.review)
  const result=offline.read(s.path,flow.id)
  assert.deepEqual(result.steps,first.steps);assert.equal(result.token,first.token)
  assert.equal(result.currentCallError,'账本不可用');assert.equal(s.count(),1)
  assert.equal((await offline.recover(s.path,flow.id)).status,'awaiting-scene')
})
test('rejecting a scene skips it and never passes that candidate as prior prose',async()=>{
  const s=sequenceSetup(),flow=s.create(s.input),first=await s.advance(flow.id)
  s.decide(s.scenes[0],first.steps[0].result.candidate.version,'reject')
  const next=s.workflows.nextPreview(s.path,flow.id)
  assert.ok(!next.plan.context.receipt.sources.some(item=>item.kind==='document'))
  assert.doesNotMatch(next.plan.modelInput.input,/旧信折好/)
  assert.equal((await s.workflows.advance(s.path,flow.id,null,next.token)).steps.length,2)
})
test('the next scene uses an author-revised descendant and detects retroactive edits to an already consumed scene',async()=>{
  const s=sequenceSetup(),flow=s.create({...s.input,scenes:s.scenes}),first=await s.advance(flow.id)
  const id=s.scenes[0],v=first.steps[0].result.candidate.version,body=s.books.manuscript(s.path,id)
  const revised=writeManuscript(s.path,{action:'candidate',document:id,sourceVersion:v,token:body.token,content:'作者改为收起铜钥匙。',reason:'修改动作',operation:randomUUID()})
  s.decide(id,revised.version)
  assert.match(s.workflows.nextPreview(s.path,flow.id).plan.modelInput.input,/收起铜钥匙/)
  const second=await s.advance(flow.id);s.decide(s.scenes[1],second.steps[1].result.candidate.version)
  const current=s.books.manuscript(s.path,id)
  writeManuscript(s.path,{action:'edit',document:id,sourceVersion:current.selected.id,token:current.token,content:'再次修改。',reason:'作者调整',operation:randomUUID()})
  assert.throws(()=>s.workflows.nextPreview(s.path,flow.id),/先前步骤|快照/)
  assert.equal(s.count(),2)
})
test('outdated plans, duplicate scenes, other chapters and inadequate cost limits fail before the next call',async()=>{
  const s=sequenceSetup()
  for(const input of [{...s.input,scenes:[s.scenes[0],s.scenes[0]]},{...s.input,scenes:[s.scenes[0],2]},{...s.input,context:{audience:'reader',position:1}}]) {
    assert.throws(()=>s.workflows.preview(s.path,input))
  }
  const firstCost=s.workflows.preview(s.path,s.input).plan.reservedCny
  const limited=s.create({...s.input,limits:{maxCalls:2,maxReservedCny:firstCost+0.000002}})
  const other=s.create(s.input);const v=await s.advance(limited.id);s.decide(s.scenes[0],v.steps[0].result.candidate.version)
  assert.throws(()=>s.workflows.nextPreview(s.path,limited.id),/预算上限/)
  assert.throws(()=>s.workflows.nextPreview(s.path,other.id),/变化/)
  let scene=s.planning.read(s.path,'scenes',s.scenes[1])
  scene=s.plan({action:'scene.plan',id:scene.document_id,expected_token:scene.token,plan:'改变批准的计划。'})
  s.plan({action:'scene.approve',id:scene.document_id,expected_token:scene.token})
  assert.throws(()=>s.workflows.nextPreview(s.path,limited.id),/计划/)
  assert.equal(s.count(),1)
})
test('recovery can reattach a paid saved scene after the author already adopted it',async()=>{
  const s=sequenceSetup(),flow=s.create(s.input),first=await s.advance(flow.id)
  s.decide(s.scenes[0],first.steps[0].result.candidate.version)
  s.rewrite(state=>{state.status='running';state.steps[0].status='running';delete state.steps[0].result})
  const restarted=createWorkflows(s.books,s.agents,()=>s.review)
  const recovered=await restarted.recover(s.path,flow.id)
  assert.equal(recovered.status,'awaiting-scene');assert.deepEqual(recovered.steps[0].result.candidate,first.steps[0].result.candidate)
  assert.equal(recovered.reservedMicros,first.reservedMicros);assert.equal(s.count(),1)
  assert.equal(restarted.nextPreview(s.path,flow.id).task.document,s.scenes[1])
})
test('sequence creation checks room for prior prose before charging for the first scene',()=>{
  const s=sequenceSetup(),documents=[1,2,3,4,5,6,7,s.scenes[2]]
  const input={...s.input,context:{documents}}
  assert.throws(()=>s.workflows.preview(s.path,input),/前场.*8/)
  assert.equal(s.workflows.preview(s.path,{...input,carryPrevious:false}).definition.carryPrevious,false)
  documents[7]=s.scenes[0]
  assert.equal(s.workflows.preview(s.path,input).definition.carryPrevious,true)
  assert.equal(s.count(),0)
})

test('frozen chapter rules reach the writer and selected failures can be revised without a paid review',async()=>{
  const s=setup({answer:payload=>JSON.stringify({replacement:payload.request.includes('仅修正以下规则')?'海风停了。':'海风仍亮。',notes:'合成'})})
  const rules={required:['海风','铜钥匙'],forbidden:['仍亮'],ending:'停了。'}
  const flow=s.create({...s.input,kind:'chapter',rules,limits:{maxCalls:2,maxReservedCny:1}})
  const first=s.workflows.nextPreview(s.path,flow.id)
  assert.match(JSON.parse(first.plan.modelInput.input).request,/铜钥匙/)
  assert.equal(s.count(),0)
  const saved=await s.advance(flow.id)
  const restarted=createWorkflows(s.books,s.agents,()=>s.review)
  const checks=restarted.checks(s.path,flow.id),version=saved.steps[0].result.candidate.version
  assert.equal(checks.target.version,version)
  assert.deepEqual(checks.checks.map(c=>c.passed),[true,false,false,false])
  const feedback={version,checks:[2,3]},plan=restarted.nextPreview(s.path,flow.id,feedback)
  const material=JSON.parse(plan.plan.modelInput.input)
  assert.match(material.request,/仍亮/);assert.doesNotMatch(material.request,/铜钥匙/)
  assert.ok(material.request.includes(s.input.request))
  assert.equal(material.source.version,version);assert.equal(material.source.text,'海风仍亮。')
  assert.equal(restarted.nextPreview(s.path,flow.id).task.task,'manuscript-review')
  assert.equal(s.count(),1)
  const updated=await restarted.advance(s.path,flow.id,feedback,plan.token)
  assert.deepEqual(updated.steps.map(step=>step.task.task),['draft-chapter','polish'])
  assert.deepEqual(restarted.checks(s.path,flow.id).checks.map(c=>c.passed),[true,false,true,true])
  await restarted.advance(s.path,flow.id,feedback,plan.token)
  assert.equal(s.count(),2);assert.equal(s.books.manuscript(s.path,1).document.activeVersion,1)
  assert.throws(()=>restarted.nextPreview(s.path,flow.id),/调用上限/)
})
test('rule selection validates scope, version and immutable failed items before spending',async()=>{
  const s=setup(),rules={required:['林澈'],forbidden:['仍亮']}
  assert.throws(()=>s.create({...s.input,rules}),/整章/)
  assert.throws(()=>s.create({...s.input,kind:'chapter',rules:{}}),/至少/)
  assert.throws(()=>s.create({...s.input,kind:'chapter',rules:{required:['风'],forbidden:['风']}}),/同时/)
  const flow=s.create({...s.input,kind:'chapter',rules})
  assert.throws(()=>s.workflows.checks(s.path,flow.id),/尚无/)
  const v=(await s.advance(flow.id)).steps[0].result.candidate.version
  for(const f of [{version:v-1,checks:[1]},{version:v,checks:[0]},{version:v,checks:[2]},{version:v,checks:[]},{version:v,checks:[1,1]}]){
    assert.throws(()=>s.workflows.nextPreview(s.path,flow.id,f),/勾选/)
  }
  const feedback={version:v,checks:[1]},p=s.workflows.nextPreview(s.path,flow.id,feedback)
  writeManuscript(s.path,{action:'edit',document:1,sourceVersion:1,token:s.body.token,content:'海面起了风。',reason:'作者编辑',operation:randomUUID()})
  assert.throws(()=>s.workflows.checks(s.path,flow.id),/快照/)
  await assert.rejects(s.workflows.advance(s.path,flow.id,feedback,p.token),/变化/)
  assert.equal(s.count(),1)
})
test('length repair sends the measured deficit or surplus and the exact rules already satisfied',async()=>{
  for (const [minHan,maxHan,difference] of [[140,160,'至少增加 56'],[50,60,'至少减少 24']]) {
    const ending='她把钥匙留在窗台上。',draft='风'.repeat(70)+'半张潮汐表'+ending
    const s=setup({answer:JSON.stringify({replacement:draft,notes:'规则回归'})})
    const rules={minHan,maxHan,required:['半张潮汐表'],forbidden:['仿佛'],ending}
    const flow=s.create({...s.input,kind:'chapter',rules})
    const v=(await s.advance(flow.id)).steps[0].result.candidate.version
    const p=s.workflows.nextPreview(s.path,flow.id,{version:v,checks:[0]})
    const material=JSON.parse(p.plan.modelInput.input)
    assert.equal(material.source.text,draft);assert.match(material.requirements,/当前 84 个汉字/)
    for(const term of [ending,'半张潮汐表','仿佛',difference])assert.ok(material.requirements.includes(term))
    assert.notEqual(s.agents.preview({...p.task,requirements:'改稿条件变化'}).signature,p.plan.signature)
    assert.throws(()=>s.agents.preview({...p.task,requirements:'风'.repeat(3001)}),/3000/)
  }
})

test('chapter draft and review receive the selected route; a switch blocks further dispatch and adoption of the old candidate',async()=>{
  const s=setup(),apply=change=>s.planning.apply(s.path,change,s.planning.preview(s.path,change).token,randomUUID())
  const opts=apply({action:'decision.options',slug:'letter-route',title:'信件去向',expected_version_id:0,topic:{scope:'chapter',document_id:1,key:'letter'},
    request:'选择信件去向',sources:[{document_id:1,version_id:1}],options:[
      {id:'a',title:'送还',content:'林澈把信送还给船长。'},{id:'b',title:'留下',content:'未选路线，藏起信。'},{id:'c',title:'销毁',content:'未选路线，烧毁信。'}]})
  const choose=(current,id)=>apply({action:'decision.select',id:opts.document_id,expected_version_id:current.version_id,options_version_number:1,option_id:id})
  const picked=choose(opts,'a'),context={chapter:1,direction:{document_id:opts.document_id,options_version_id:opts.options_version_id,option_id:'a'}}
  const flow=s.create({...s.input,kind:'chapter',context}),preview=()=>s.workflows.nextPreview(s.path,flow.id)
  const check=p=>{const text=p.plan.modelInput.input;assert.match(text,/林澈把信送还给船长/);assert.doesNotMatch(text,/未选路线/)}
  check(preview());const initial=await s.advance(flow.id),version=initial.steps[0].result.candidate.version
  check(preview())
  const review=await s.advance(flow.id);assert.equal(review.status,'awaiting-author')
  const target={action:'accept',document:1,version,token:s.body.token,operation:randomUUID()}
  const verify=receipt=>s.context.verify(s.path,receipt)
  choose(picked,'b')
  assert.throws(preview,/方向已变化/)
  assert.throws(()=>writeManuscript(s.path,target,null,null,verify),/方向已变化/)
  assert.equal(s.count(),2);assert.equal(s.books.manuscript(s.path,1).document.activeVersion,1)
})

function ideaWorkflow() {
  const options=['留下旧信','寄出旧信','烧掉旧信'].map(title=>({title,content:'林澈决定'+title+'。'}))
  const s=setup({answer:p=>JSON.stringify(p.target?{options}:p.units?{issues:[]}:{replacement:'林澈把旧信投入邮筒。',notes:'寄出'})})
  const input={...s.input,kind:'chapter',ideas:{id:randomUUID(),request:'提出三条行动路线。'}}
  const restart=()=>createWorkflows(s.books,s.agents,()=>s.review,()=>s.planning)
  return {...s,input,restart}
}
test('original idea options, author choice, chapter draft and review share one recoverable workflow budget',async()=>{
  const s=ideaWorkflow(),flow=s.create(s.input);assert.equal(s.count(),0)
  const first=s.workflows.nextPreview(s.path,flow.id);assert.equal(first.task.task,'ideas')
  const ready=await s.workflows.advance(s.path,flow.id,null,first.token);assert.equal(ready.status,'awaiting-direction')
  assert.equal(ready.steps[0].result.proposal.options.length,3)
  // Simulate a crash after the planning receipt was saved and before step completion.
  s.rewrite(state=>{state.status='running';state.steps[0].status='running';delete state.steps[0].result})
  const next=s.restart()
  const restored=await next.recover(s.path,flow.id);assert.deepEqual(restored.steps[0].result.proposal,ready.steps[0].result.proposal)
  assert.equal(s.count(),1);assert.throws(()=>next.nextPreview(s.path,flow.id),/请先确认/)
  const choose=option=>{const p=next.choicePreview(s.path,flow.id,option);return next.choose(s.path,flow.id,option,p.token,randomUUID())}
  const p=next.choicePreview(s.path,flow.id,'a'),op=randomUUID()
  assert.throws(()=>next.choose(s.path,flow.id,'a','invalid',op),/重新预览/)
  const selected=next.choose(s.path,flow.id,'a',p.token,op)
  assert.deepEqual(next.choose(s.path,flow.id,'a',p.token,op),selected)
  const stale=next.nextPreview(s.path,flow.id)
  choose('b');await assert.rejects(next.advance(s.path,flow.id,null,stale.token),/变化/);assert.equal(s.count(),1)
  const draft=next.nextPreview(s.path,flow.id)
  assert.match(draft.plan.modelInput.input,/寄出旧信/);assert.doesNotMatch(draft.plan.modelInput.input,/烧掉旧信|留下旧信/)
  const drafted=await next.advance(s.path,flow.id,null,draft.token)
  assert.equal(drafted.steps[1].result.candidate.changesManuscript,false)
  const review=next.nextPreview(s.path,flow.id);assert.match(review.plan.modelInput.input,/寄出旧信/)
  const done=await next.advance(s.path,flow.id,null,review.token)
  assert.equal(done.status,'awaiting-author');assert.equal(s.count(),3)
  assert.equal(done.reservedMicros,done.steps.reduce((sum,step)=>sum+step.reservedMicros,0))
  assert.equal(s.books.manuscript(s.path,1).document.activeVersion,1)
})
test('closing an idea workflow prevents a pending choice from changing the book',async()=>{
  const s=ideaWorkflow(),flow=s.create(s.input),state=await s.advance(flow.id)
  const before=s.workflows.choicePreview(s.path,flow.id,'c')
  s.workflows.close(s.path,flow.id,state.token)
  assert.throws(()=>s.workflows.choose(s.path,flow.id,'c',before.token,randomUUID()),/待确认/)
  assert.equal(s.planning.read(s.path,'decisions',state.steps[0].result.proposal.document_id).selection,null)
  assert.throws(()=>s.create({...s.input,limits:{maxCalls:2,maxReservedCny:1}}),/三次/)
  assert.equal(s.count(),1)
})

function chaptersSetup(){
  const ending='林澈把钥匙交给守灯人。',long='潮涨了。'.repeat(200)+ending
  const s=setup({answer:p=>JSON.stringify({replacement:p.request.includes('开篇')?long:'守灯人握紧钥匙，关上灯塔的门。',notes:'测试候选'})})
  const input={kind:'chapters',request:'保持情节连续。',chapters:[{document:1,request:'开篇，交接钥匙。'},{document:3,request:'交接之后关门。'},{document:5,request:'灯塔清晨。'}],limits:{maxCalls:3,maxReservedCny:1}}
  const decide=(document,version,action)=>writeManuscript(s.path,{action,document,version,token:s.books.manuscript(s.path,document).token,operation:randomUUID()},null,null,receipt=>s.context.verify(s.path,receipt))
  return {...s,input,ending,decide}
}
test('chapter sequence waits for approved prose and carries the Unicode ending, detecting changes before adoption and later steps',async()=>{
  const s=chaptersSetup(),flow=s.create(s.input),first=await s.advance(flow.id)
  assert.equal(first.status,'awaiting-chapter');const v=first.steps[0].result.candidate.version
  assert.throws(()=>s.workflows.nextPreview(s.path,flow.id),/采用或拒绝前章/)
  s.decide(1,v,'accept')
  const next=s.workflows.nextPreview(s.path,flow.id),p=JSON.parse(next.plan.modelInput.input),tail=p.context.items[0]
  assert.equal(tail.kind,'chapter-ending');assert.ok(tail.truncated);assert.ok(tail.text.endsWith(s.ending));assert.ok(!tail.text.includes('�'))
  const second=await s.workflows.advance(s.path,flow.id,null,next.token),v2=second.steps[1].result.candidate.version
  const accepted=s.books.manuscript(s.path,1)
  writeManuscript(s.path,{action:'edit',document:1,sourceVersion:v,token:accepted.token,operation:randomUUID(),reason:'作者改写前章结尾',content:'林澈独自保管钥匙。'})
  assert.throws(()=>s.decide(3,v2,'accept'),/版本已变化/)
  s.decide(3,v2,'reject')
  assert.throws(()=>s.workflows.nextPreview(s.path,flow.id),/引用的章末已变化/);assert.equal(s.count(),2)
})
test('chapter sequence skips rejected drafts, carries an adopted revision and recovers an already saved chapter exactly once',async()=>{
  const s=chaptersSetup(),flow=s.create(s.input),first=await s.advance(flow.id)
  const v=first.steps[0].result.candidate.version,token=s.books.manuscript(s.path,1).token
  const revised=writeManuscript(s.path,{action:'candidate',document:1,sourceVersion:v,token,operation:randomUUID(),reason:'作者调整',content:'铜钥匙留在红色信封中。'})
  s.decide(1,revised.version,'accept')
  s.rewrite(state=>{state.status='running';state.steps[0].status='running';delete state.steps[0].result})
  const restarted=createWorkflows(s.books,s.agents,()=>s.review)
  const recovered=await restarted.recover(s.path,flow.id);assert.equal(s.count(),1);assert.equal(recovered.status,'awaiting-chapter')
  const next=restarted.nextPreview(s.path,flow.id)
  assert.equal(next.task.context.previousChapter.version,revised.version)
  assert.match(next.plan.modelInput.input,/红色信封/);assert.doesNotMatch(next.plan.modelInput.input,/潮涨了/)
  const second=await restarted.advance(s.path,flow.id,null,next.token);s.decide(3,second.steps[1].result.candidate.version,'reject')
  const third=restarted.nextPreview(s.path,flow.id);assert.equal(third.task.context.previousChapter.version,revised.version);assert.equal(third.task.document,5)
  assert.deepEqual((await restarted.advance(s.path,flow.id,null,next.token)).steps,second.steps);assert.equal(s.count(),2)
})
test('chapter sequence rejects invalid scope and insufficient budget before dispatch; edited target requires a new preview',async()=>{
  const s=chaptersSetup()
  for(const bad of [{chapters:[s.input.chapters[0],s.input.chapters[0]]},{chapters:[s.input.chapters[0],{document:2,request:'场景'}]},
    {limits:{maxCalls:3,maxReservedCny:0.00001}},{context:{audience:'reader',position:1}}])assert.throws(()=>s.create({...s.input,...bad}))
  const flow=s.create(s.input);const first=await s.advance(flow.id);s.decide(1,first.steps[0].result.candidate.version,'reject')
  const n=s.workflows.nextPreview(s.path,flow.id);assert.equal(n.task.context,undefined)
  writeManuscript(s.path,{action:'edit',document:3,token:s.books.manuscript(s.path,3).token,operation:randomUUID(),content:'作者先写了一段。',reason:'试稿'})
  await assert.rejects(s.workflows.advance(s.path,flow.id,null,n.token),/已变化/);assert.equal(s.count(),1)
})
