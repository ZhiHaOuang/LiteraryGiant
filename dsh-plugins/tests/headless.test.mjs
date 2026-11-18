import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import {ToolsService} from '@deepseek-ai/dsh-tools'
import {createBook} from '../lg-books/tests/fixture.mjs'
import * as books from '../lg-books/index.js'
import * as agents from '../lg-agents/index.js'
import * as memory from '../lg-memory/index.js'
import * as context from '../lg-context/index.js'
import * as library from '../lg-library/index.js'
import * as planning from '../lg-planning/index.js'
import * as review from '../lg-review/index.js'
import * as author from '../lg-author/index.js'
import * as workflows from '../lg-workflows/index.js'
import * as director from '../lg-director/index.js'
import {Executor} from '../lg-execution/src/run.js'
test('literary services and native tools load without a web connection; HTTP mounts/unmounts independently',async()=>{
 const path=realpathSync(mkdtempSync(join(tmpdir(),'lg-headless-')));createBook(path).db.close()
 const ctx=new Context(),routes=new Map(),mounted=[]
 const preview=new Executor(null,null,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:2,maxInputBytes:100000,maxOutputTokens:1024})
 const deps=ctx.plugin(c=>{
  c.provide('systemPrompt',{tools(){return ()=>{}}});c.provide('workingDirectory',{ensure:async()=>path});c.provide('profileContext',{dir:path})
  c.provide('configEditor',{edit(){throw new Error('Unexpected mutation')}})
  c.provide('literaryExecution',{preview:input=>preview.preview(input),status:()=>null,cancel:()=>false,run(){throw new Error('No paid model calls in this test')}})
 });await deps.await()
 const toolFiber=ctx.plugin(ToolsService,{});await toolFiber.await()
 try{
  for(const [plugin,config] of [[books,{projects:[path]}],[memory,{}],[context,{}],[library,{}],[planning,{}],[review,{}],[author,{legacyPersonalPath:join(path,'absent-preferences.json')}],[agents,{roles:[]}],[workflows,{}],[director,{}]]){
   const fiber=ctx.plugin(plugin,config);mounted.push(fiber);await fiber.await()
  }
  const names=['literaryBooks','literaryMemory','literaryContext','literaryLibrary','literaryPlanning','literaryReview','literaryAuthor','literaryAgents','literaryWorkflows','literaryDirector']
  const services=names.map(name=>{const value=ctx.get(name);assert.ok(value,name);return value})
  const registry=ctx.get('tools'),schemas=registry.schemas();assert.ok(schemas.some(tool=>tool.name==='literary_propose_task'));assert.equal(ctx.get('literaryAgents').roles().filter(role=>role.enabled).length,11)
  const body=ctx.get('literaryBooks').manuscript(path,1)
  const proposed=ctx.get('literaryDirector').propose(path,{task:'polish',document:1,version:body.selected.id,token:body.token,start:0,end:body.selected.content.length,request:'只检查分派，无实际执行。'},'headless-fixture-0001')
  assert.equal(proposed.status,'proposed');assert.equal(routes.size,0)
  let connection=ctx.plugin(c=>c.provide('connection',{fetch:{register(route){assert.ok(!routes.has(route.path));routes.set(route.path,route);return ()=>routes.delete(route.path)}}}));await connection.await()
  assert.equal(routes.size,11);assert.ok(routes.has('/api/lg/director'))
  await connection.dispose();assert.equal(routes.size,0);assert.deepEqual(registry.schemas(),schemas)
  names.forEach((name,index)=>assert.equal(ctx.get(name),services[index],name))
  connection=ctx.plugin(c=>c.provide('connection',{fetch:{register(route){routes.set(route.path,route);return ()=>routes.delete(route.path)}}}));await connection.await();assert.equal(routes.size,11)
  await connection.dispose();assert.equal(ctx.get('literaryDirector').read(path,proposed.id).status,'proposed')
 }finally{for(const fiber of mounted.reverse())await fiber.dispose();await toolFiber.dispose();await deps.dispose()}
 assert.equal(routes.size,0)
})
