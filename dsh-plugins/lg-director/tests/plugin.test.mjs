import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolsService,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import * as books from '../../lg-books/index.js'
import * as agents from '../../lg-agents/index.js'
import * as director from '../index.js'
import {listMethods,selectMethod} from '../../lg-skills/methods.js'
import {Executor} from '../../lg-execution/src/run.js'
test('native tools bind working book, propose only and release tools/API/service on Cordis disposal',async()=>{
 const path=realpathSync(mkdtempSync(join(tmpdir(),'lg-director-host-')));createBook(path).db.close()
 const ctx=new Context(),routes=new Map();let calls=0
 const preview=new Executor(null,null,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:2,maxInputBytes:100000,maxOutputTokens:1024})
 const deps=ctx.plugin(c=>{
  c.provide('systemPrompt',{tools(){return ()=>{}}});c.provide('workingDirectory',{ensure:async()=>path})
  c.provide('literaryMethods',{list:listMethods,select:selectMethod})
  c.provide('configEditor',{edit(){throw new Error('Unexpected registration')}})
  c.provide('connection',{fetch:{register(route){routes.set(route.path,route);return ()=>routes.delete(route.path)}}})
  c.provide('literaryExecution',{preview:input=>preview.preview(input),status:()=>null,cancel:()=>false,async run(){calls++;throw new Error('Unexpected model call')}})
 });await deps.await()
 const tools=ctx.plugin(ToolsService,{});await tools.await();const b=ctx.plugin(books,{projects:[path]});await b.await();const a=ctx.plugin(agents,{roles:[]});await a.await();let d=ctx.plugin(director);await d.await()
 const api=async input=>(await routes.get('/api/lg/director').fetch(new Request('http://localhost/api/lg/director',{method:'POST',body:JSON.stringify({path,...input})}))).json()
 try{
  const registry=ctx.get('tools'),exec={agent:{id:'synthetic-session'},signal:new AbortController().signal}
  assert.deepEqual(registry.schemas().map(s=>s.name).sort(),['literary_propose_task','literary_tasks'])
  const source=await registry.get('literary_tasks').execute({action:'source',document:1},exec)
  assert.deepEqual(validateJsonSchemaValue({type:'object'},source),[])
  const input={task:'polish',document:1,version:source.version,token:source.token,start:source.start,end:source.end,request:'简化表达。'},id=randomUUID()
  const value=await registry.get('literary_propose_task').execute({id,input},exec);assert.equal(value.status,'proposed');assert.equal(value.origin,'synthetic-session');assert.equal(calls,0);assert.deepEqual(validateJsonSchemaValue({type:'object'},value),[])
  const methodId=randomUUID(),method='lg-style-controller'
  const handoff=await registry.get('literary_propose_task').execute({id:methodId,input:{...input,method}},exec)
  assert.equal(handoff.input.method,method)
  assert.equal((await api({action:'preview',id:methodId})).value.plan.method.name,method)
  await assert.rejects(registry.get('literary_propose_task').execute({id:randomUUID(),input:{...input,method:5}},exec),/invalid arguments/)
  const observed=await registry.get('literary_tasks').execute({action:'read',id},exec);assert.deepEqual(validateJsonSchemaValue({type:'object'},observed),[])
  assert.deepEqual(await registry.get('literary_propose_task').execute({id,input},exec),value)
  await assert.rejects(registry.get('literary_propose_task').execute({id:randomUUID(),input:JSON.stringify(input)},exec),/object/)
  await assert.rejects(registry.get('literary_propose_task').execute({id:randomUUID(),input:{document:1}},exec),/invalid arguments/)
  await assert.rejects(registry.get('literary_tasks').execute({action:'run',id},exec),/invalid arguments/)
  await assert.rejects(registry.get('literary_propose_task').execute({id:randomUUID(),input:{...input,task:'adopt'}},exec),/invalid arguments/)
  await assert.rejects(registry.get('literary_tasks').execute({action:'catalog'},{signal:exec.signal}),/作品会话/)
  assert.equal((await api({action:'preview',id})).ok,true);assert.equal((await api({action:'run',id,token:'forged'})).ok,false);assert.equal(calls,0)
  await d.dispose();assert.equal(routes.has('/api/lg/director'),false);assert.equal(registry.get('literary_tasks'),undefined);assert.equal(ctx.get('literaryDirector'),undefined)
  d=ctx.plugin(director);await d.await();assert.equal((await api({action:'read',id})).value.status,'proposed')
  assert.equal((await api({action:'stop',id,token:value.token,reason:'合成测试驳回'})).value.status,'dismissed');assert.equal(calls,0)
 }finally{await d.dispose();await a.dispose();await b.dispose();await tools.dispose();await deps.dispose()}
 assert.equal(routes.size,0)
})
