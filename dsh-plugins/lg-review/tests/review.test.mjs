import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'
import { createReview } from '../src/service.js'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { createDocuments } from '../../lg-books/src/documents.js'
import { readManuscript } from '../../lg-books/src/manuscript.js'
import { createPlanning } from '../../lg-planning/src/service.js'
import { createMemory } from '../../lg-memory/src/service.js'
import { createContext } from '../../lg-context/src/service.js'
import { createAgents } from '../../lg-agents/src/service.js'
import { parsePlanning } from '../../lg-agents/src/planning.js'
import { Executor } from '../../lg-execution/src/run.js'
function setup() {
 const path=mkdtempSync(join(tmpdir(),'lg-review-'));createBook(path).db.close()
 const books={readState:(p,fn)=>accessState(p,false,fn),changeState:(p,fn)=>accessState(p,true,fn),manuscript:readManuscript}
 books.documents=createDocuments(books)
 let context;const planning=createPlanning(books,(p,g)=>{context.verify(p,g.context);if(g.feedback?.context)context.verify(p,g.feedback.context)});context=createContext(books,createMemory(books),()=>planning)
 const review=createReview(books,planning,context)
 const mutate=change=>planning.apply(path,change,planning.preview(path,change).token,randomUUID())
 let scene=mutate({action:'scene.create',slug:'review-scene',title:'停航之前',chapter_id:1,card:{goal:'阻止妹妹登船',required_information:'妹妹不知道信件内容'}})
 scene=mutate({action:'scene.plan',id:scene.document_id,expected_token:scene.token,plan:'林澈让妹妹立刻登船。妹妹读完信却假装不知道。'})
 const target={section:'scenes',id:scene.document_id,token:scene.token},source=review.snapshot(path,target,{documents:[6]})
 const raw={issues:[{severity:'warning',category:'约束',evidence:[1,3],message:'行动背离阻止登船目标。',suggestion:'改为要求暂缓登船，并承担延误代价。'}]}
 const save=()=>review.save(path,randomUUID(),'request','signature',source,review.validate(JSON.stringify(raw),source))
 let calls=0;const runs=new Map()
 const execution={preview:input=>new Executor(null,null,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:2,maxOutputTokens:4096,maxInputBytes:16000}).preview(input),
  async run(id,input){if(runs.has(id))return runs.get(id);calls++;const payload=JSON.parse(input.input),result={id,status:'succeeded',result:{text:JSON.stringify(payload.units?raw:{plan:'林澈提出自己承担延误费用，换取妹妹暂不上船。'})}};runs.set(id,result);return result},status:id=>runs.get(id)}
 const agents=createAgents(books,execution,{roles:[]},()=>undefined,()=>context,()=>planning,()=>review)
 const editPerson=()=>{const d=books.documents.read(path,6),change={action:'edit',id:6,expected_token:d.token,content:'人物新设定。',reason:'作者更改'};books.documents.apply(path,change,books.documents.preview(path,change).token,randomUUID())}
 return {path,books,planning,context,review,target,source,raw,save,mutate,editPerson,agents,calls:()=>calls}
}
test('review quotes come from numbered material; missing target evidence and fabricated ids fail',()=>{
 const s=setup(),output=s.review.validate(JSON.stringify(s.raw),s.source)
 assert.equal(output.issues[0].evidence[0].quote,'林澈让妹妹立刻登船。')
 assert.equal(output.issues[0].evidence[0].anchor.token,s.target.token)
 for(const evidence of [[999],[3],[]])assert.throws(()=>s.review.validate(JSON.stringify({issues:[{...s.raw.issues[0],evidence}]}),s.source),/编号|引用|格式/)
})
test('stored reports preserve older findings; author decisions use exact preview and keep an audit',()=>{
 const s=setup(),first=s.save(),second=s.save();assert.notEqual(first.run,second.run)
 assert.equal(s.review.list(s.path,s.target).items.length,2)
 const item=first.issues[0],change={id:item.id,expected_token:item.token,status:'dismissed',reason:'作者认为此处是有意反转'},preview=s.review.preview(s.path,change),operation=randomUUID()
 const result=s.review.apply(s.path,change,preview.token,operation)
 assert.equal(result.issue.status,'dismissed');assert.equal(result.previous,'open');assert.equal(s.review.history(s.path,item.id)[0].reason,change.reason)
 assert.deepEqual(s.review.apply(s.path,change,preview.token,operation),result)
 assert.throws(()=>s.review.apply(s.path,{...change,reason:'另一理由'},preview.token,operation),/内容已变化/)
 assert.equal(s.review.read(s.path,second.run).issues[0].status,'open')
 assert.throws(()=>s.review.feedback(s.path,{run:first.run,issues:[item.id]},'scene-plan',first.revisionTarget),/已经处理/)
})
test('source changes mark historic reports stale and prevent registering stale findings or using them for revision',()=>{
 const s=setup(),report=s.save();s.editPerson()
 assert.equal(s.review.read(s.path,report.run).stale,true)
 assert.throws(()=>s.save(),/已变化/)
 assert.throws(()=>s.review.feedback(s.path,{run:report.run,issues:[report.issues[0].id]},'scene-plan',report.revisionTarget),/重新审阅/)
 assert.equal(s.review.list(s.path,s.target).items.length,1)
})
test('review and selected-issue revision are separate bounded tasks; revision never closes issues or approves plan',async()=>{
 const s=setup(),input={task:'plan-review',path:s.path,target:s.target,context:{documents:[6]},request:'检查目标和信息边界。',operation:randomUUID()}
 const preview=s.agents.preview(input),reviewed=await s.agents.run({...input,signature:preview.signature})
 assert.equal(reviewed.status,'review-ready');assert.equal(s.calls(),1)
 const replay=await s.agents.run({...input,signature:preview.signature});assert.equal(replay.replayed,true);assert.equal(s.calls(),1)
 const report=reviewed.report,revision={task:'scene-plan',path:s.path,target:report.revisionTarget,request:'只修正选中的目标冲突，保留无关部分。',context:{audience:'author',documents:[]},feedback:{run:report.run,issues:[report.issues[0].id]},operation:randomUUID()}
 const planned=s.agents.preview(revision);assert.match(planned.modelInput.input,/目标冲突|背离/);assert.match(planned.modelInput.input,/让妹妹立刻登船/)
 const result=await s.agents.run({...revision,signature:planned.signature});assert.equal(result.status,'planning-ready');assert.equal(s.calls(),2)
 assert.equal(result.proposal.plan,'');assert.equal(result.proposal.plan_state,'empty');assert.match(result.proposal.metadata.lg_plan_proposal.plan,/延误费用/)
 assert.equal(result.proposal.generation.feedback.run,report.run)
 assert.equal(s.review.read(s.path,report.run).issues[0].status,'open');assert.equal(s.review.read(s.path,report.run).stale,true)
 s.editPerson();assert.throws(()=>s.mutate({action:'scene.approve',id:result.proposal.document_id,expected_token:result.proposal.token}),/已变化/)
})
test('unrelated target and newly dismissed selected issue refuse revision before a model call',async()=>{
 const s=setup(),report=s.save(),feedback={run:report.run,issues:[report.issues[0].id]},input={task:'scene-plan',path:s.path,target:report.revisionTarget,feedback,request:'修改',operation:randomUUID()}
 assert.throws(()=>s.agents.preview({...input,target:{...input.target,id:999}}),/不一致/)
 const preview=s.agents.preview(input),issue=report.issues[0],change={id:issue.id,expected_token:issue.token,status:'dismissed',reason:'不要求修改'}
 s.review.apply(s.path,change,s.review.preview(s.path,change).token,randomUUID())
 await assert.rejects(s.agents.run({...input,signature:preview.signature}),/已经处理/);assert.equal(s.calls(),0)
})
test('Cordis owns review API; clients cannot directly insert model findings',async()=>{
 const s=setup(),ctx=new Context(),routes=new Map()
 const deps=ctx.plugin(c=>{c.provide('literaryBooks',s.books);c.provide('literaryPlanning',s.planning);c.provide('literaryContext',s.context);c.provide('connection',{fetch:{register(route){routes.set(route.path,route);return ()=>routes.delete(route.path)}}})});await deps.await()
 const fiber=ctx.plugin(plugin);await fiber.await()
 const call=body=>routes.get('/api/lg/review').fetch(new Request('http://localhost/api/lg/review',{method:'POST',body:JSON.stringify({path:s.path,...body})}))
 assert.equal((await call({action:'save',output:s.raw})).status,400)
 assert.equal((await (await call({action:'list',target:s.target})).json()).ok,true)
 await fiber.dispose();assert.equal(ctx.get('literaryReview'),undefined);assert.equal(routes.size,0);await deps.dispose()
})

test('partly invalid model reviews retain valid findings with explicit rejection diagnostics',()=>{
 const s=setup(),bad={...s.raw.issues[0],evidence:[3]},output=s.review.validate(JSON.stringify({issues:[bad,...s.raw.issues]}),s.source)
 assert.equal(output.issues.length,1);assert.equal(output.rejected[0].index,1)
 const report=s.review.save(s.path,randomUUID(),'request','signature',s.source,output)
 assert.equal(report.rejected.length,1);assert.match(report.rejected[0].error,/被审阅内容/)
})
test('feedback revisions preserve unselected options byte for byte and reject identity changes',()=>{
 const previousOptions=['x','y','z'].map(id=>({id,title:id,content:'原方案'+id})),plan={editableOptions:['z'],previousOptions}
 const raw={options:previousOptions.map(option=>({...option,title:'改标题'+option.id,content:'模型重写'+option.id}))}
 const output=parsePlanning('ideas',JSON.stringify(raw),plan)
 assert.deepEqual(output.options.slice(0,2),previousOptions.slice(0,2));assert.equal(output.options[2].content,'模型重写z')
 raw.options[2].id='new';assert.throws(()=>parsePlanning('ideas',JSON.stringify(raw),plan),/原方案/)
})
