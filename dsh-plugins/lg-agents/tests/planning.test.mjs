import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { createDocuments } from '../../lg-books/src/documents.js'
import { createPlanning } from '../../lg-planning/src/service.js'
import { createMemory } from '../../lg-memory/src/service.js'
import { createContext } from '../../lg-context/src/service.js'
import { Executor } from '../../lg-execution/src/run.js'
import { Ledger } from '../../lg-execution/src/ledger.js'
import { createAgents } from '../src/service.js'
const choices={options:[{title:'求证',content:'林澈去码头查名册，代价是错过约定。'},{title:'守候',content:'林澈守住灯塔，放弃追问送信人。'},{title:'交付',content:'林澈把信交给船长，以秘密换取停航。'}]}
function setup(output=choices,during=()=>{}) {
 const path=mkdtempSync(join(tmpdir(),'lg-planning-agent-'));createBook(path).db.close()
 const books={readState:(p,fn)=>accessState(p,false,fn),changeState:(p,fn)=>accessState(p,true,fn)}
 books.documents=createDocuments(books)
 const memory=createMemory(books)
 let context,verify=true
 const planning=createPlanning(books,(p,proof)=>{if(!verify)throw new Error('来源服务不可用');context.verify(p,proof.context)})
 context=createContext(books,memory,()=>planning)
 const ledger=new Ledger(join(path,'model-ledger.sqlite3'));let calls=0
 const llm={async prepareCall(){calls++;return {config:{},async *stream(){during({path,books,planning});yield {type:'block-end',index:0,block:{type:'text',text:typeof output==='string'?output:JSON.stringify(output)}};yield {type:'usage',usage:{inputTokens:100,outputTokens:200}};yield {type:'finish',reason:{kind:'stop'}}}}}}
 const execution=new Executor(llm,ledger,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:2,maxOutputTokens:4096,maxInputBytes:16000,budgetCny:1,timeoutMs:1000})
 execution.status=id=>ledger.get(id)
 const make=()=>createAgents(books,execution,{roles:[]},()=>undefined,()=>context,()=>planning)
 const input={task:'ideas',path,request:'三种不同的来信处理方式，保留作者选择。',target:{slug:'letter',title:'来信方向',topic:{scope:'chapter',document_id:1,key:'letter'},expected_version_id:0},context:{documents:[6]},operation:randomUUID()}
 const mutate=change=>{const p=planning.preview(path,change);return planning.apply(path,change,p.token,randomUUID())}
 const changePerson=()=>{const d=books.documents.read(path,6),change={action:'edit',id:6,expected_token:d.token,content:'林澈离开灯塔。',reason:'作者修改'};const p=books.documents.preview(path,change);return books.documents.apply(path,change,p.token,randomUUID())}
 return {path,input,books,planning,context,ledger,execution,agents:make(),make,mutate,changePerson,calls:()=>calls,disableVerification:()=>verify=false}
}
test('three alternatives remain unselected; exact replay survives agent recreation without model dispatch',async()=>{
 const s=setup();try {
  assert.equal(s.agents.roles().filter(role=>role.enabled).length,9)
  const preview=s.agents.preview(s.input);assert.match(preview.modelInput.input,/守灯人/)
  const input={...s.input,signature:preview.signature},result=await s.agents.run(input)
  assert.equal(result.status,'planning-ready');assert.equal(result.proposal.selection,null)
  assert.equal(result.proposal.options.length,3);assert.equal(s.calls(),1)
  const replay=await s.make().run(input);assert.equal(replay.replayed,true);assert.equal(replay.proposal.version_id,result.proposal.version_id);assert.equal(s.calls(),1)
  await assert.rejects(s.agents.run({...input,request:'换任务'}),/不能更换/)
  const choice=s.mutate({action:'decision.select',id:result.proposal.document_id,expected_version_id:result.proposal.version_id,options_version_number:1,option_id:'b'})
  assert.equal(choice.selection.option_id,'b')
 } finally {await s.execution.dispose();s.ledger.close()}
})
test('selected context changing before dispatch refuses billing and during generation preserves output only',async()=>{
 const s=setup();try {
  const preview=s.agents.preview(s.input);s.changePerson()
  await assert.rejects(s.agents.run({...s.input,signature:preview.signature}),/重新预览/);assert.equal(s.calls(),0)
 }finally{await s.execution.dispose();s.ledger.close()}
 const t=setup(choices,({books,path})=>{
  const current=books.documents.read(path,6),change={action:'edit',id:6,expected_token:current.token,content:'人物已改变',reason:'并发'}
  books.documents.apply(path,change,books.documents.preview(path,change).token,randomUUID())
 });try {
  const result=await t.agents.run({...t.input,signature:t.agents.preview(t.input).signature})
  assert.equal(result.status,'planning-pending');assert.equal(result.output.options.length,3)
  assert.equal(t.planning.list(t.path,'decisions').total,0);assert.equal(t.calls(),1)
 }finally{await t.execution.dispose();t.ledger.close()}
})
test('generation receipts block selecting stale ideas or approving a stale scene plan',async()=>{
 const s=setup();try {
  const result=await s.agents.run({...s.input,signature:s.agents.preview(s.input).signature});s.changePerson()
  assert.throws(()=>s.mutate({action:'decision.select',id:result.proposal.document_id,expected_version_id:result.proposal.version_id,options_version_number:1,option_id:'a'}),/来源|已变化/)
 }finally{await s.execution.dispose();s.ledger.close()}
 const t=setup({plan:'林澈请求查看名册，船长拒绝；她交出旧信，换得一个名字。'});try {
  let scene=t.mutate({action:'scene.create',slug:'gate',title:'码头入口',chapter_id:1,card:{goal:'找到送信人',conflict:'船长拒绝透露名册'}})
  scene=t.mutate({action:'scene.plan',id:scene.document_id,expected_token:scene.token,plan:'作者原计划'})
  scene=t.mutate({action:'scene.approve',id:scene.document_id,expected_token:scene.token})
  const input={...t.input,task:'scene-plan',target:{id:scene.document_id,expected_token:scene.token},context:{documents:[6]}}
  const result=await t.agents.run({...input,signature:t.agents.preview(input).signature})
  assert.equal(result.status,'planning-ready');assert.equal(result.proposal.plan,'作者原计划');assert.equal(result.proposal.plan_state,'approved')
  assert.match(result.proposal.metadata.lg_plan_proposal.plan,/名册/)
  t.disableVerification()
  assert.throws(()=>t.mutate({action:'scene.approve',id:scene.document_id,expected_token:result.proposal.token}),/服务不可用/)
 }finally{await t.execution.dispose();t.ledger.close()}
})
test('valid generated scene plan needs separate author approval and duplicate output never saves',async()=>{
 const s=setup({plan:'她开门，风吹灭灯；她用信封护住火苗，决定留下。'});try {
  const scene=s.mutate({action:'scene.create',slug:'door',title:'灯塔门前',chapter_id:1,card:{goal:'决定去留'}})
  const input={...s.input,task:'scene-plan',target:{id:scene.document_id,expected_token:scene.token}}
  const result=await s.agents.run({...input,signature:s.agents.preview(input).signature})
  assert.equal(result.status,'planning-ready');assert.equal(result.proposal.plan,'')
  const approved=s.mutate({action:'scene.approve',id:scene.document_id,expected_token:result.proposal.token})
  assert.match(approved.plan,/信封/);assert.equal(approved.metadata.lg_plan_generation.run,input.operation)
 }finally{await s.execution.dispose();s.ledger.close()}
 const t=setup({options:[choices.options[0],choices.options[0],choices.options[2]]});try {
  const result=await t.agents.run({...t.input,signature:t.agents.preview(t.input).signature})
  assert.equal(result.status,'invalid-output');assert.equal(t.planning.list(t.path,'decisions').total,0)
 }finally{await t.execution.dispose();t.ledger.close()}
})
test('historical generated alternatives keep their own source receipt after manual new options',async()=>{
 const s=setup();try {
  const first=await s.agents.run({...s.input,signature:s.agents.preview(s.input).signature})
  const newer=s.mutate({action:'decision.options',slug:'letter',title:'来信方向',topic:s.input.target.topic,expected_version_id:first.proposal.version_id,
   request:'作者新提案',sources:[{document_id:1,version_id:1}],options:choices.options.map((value,index)=>({...value,id:['a','b','c'][index],content:'新：'+value.content}))})
  s.changePerson()
  assert.throws(()=>s.mutate({action:'decision.select',id:newer.document_id,expected_version_id:newer.version_id,options_version_number:1,option_id:'a'}),/已变化/)
  assert.equal(s.mutate({action:'decision.select',id:newer.document_id,expected_version_id:newer.version_id,options_version_number:newer.options_version_number,option_id:'a'}).selection.options_version_id,newer.options_version_id)
 }finally{await s.execution.dispose();s.ledger.close()}
})
