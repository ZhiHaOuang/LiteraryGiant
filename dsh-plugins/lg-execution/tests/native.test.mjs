import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'
import { Ledger } from '../src/ledger.js'
import { NativeGuard } from '../src/native.js'
const config={provider:'fixture',model:'model',budgetCny:10,inputCnyPerMillion:1.2,outputCnyPerMillion:8,maxInputBytes:16000,maxOutputTokens:4096,nativeMaxCallsPerSession:2}
const options=()=>({provider:'fixture',model:'model',maxTokens:512,sessionId:'test-session',messages:[{role:'user',content:[{type:'text',text:'PRIVATE_NOVEL_TEXT'}]}],tools:[]})
const chunks=[{type:'block-end',index:0,block:{type:'tool-call',id:'tool',name:'read',arguments:'{}'}},{type:'usage',usage:{inputTokens:100,outputTokens:20,cacheReadTokens:30}},{type:'finish',reason:{kind:'tool-calls'}}]
const stream=async function*(){yield* chunks}
async function drain(iterator){const out=[];for await(const chunk of iterator)out.push(chunk);return out}
function setup(t,overrides={}){const path=join(mkdtempSync(join(tmpdir(),'lg-native-budget-')),'calls.sqlite3'),ledger=new Ledger(path),guard=new NativeGuard(()=>ledger,{...config,...overrides});t.after(async()=>{await guard.dispose();ledger.close()});return{path,ledger,guard}}
test('native guard preserves frozen request and exact chunks; only bounded metadata is persisted',async t=>{
 const s=setup(t),request=options();Object.freeze(request.messages);Object.freeze(request)
 const output=await drain(s.guard.stream(request,stream));assert.deepEqual(output,chunks);assert.equal(output[0],chunks[0])
 const row=s.ledger.db.prepare('SELECT request,result,status FROM literary_calls').get(),saved=JSON.parse(row.result)
 assert.equal(row.status,'succeeded');assert.equal(saved.toolCalls,1);assert.equal(saved.estimatedCny,(130*1.2+20*8)/1e6)
 assert.doesNotMatch(row.request,/PRIVATE_NOVEL_TEXT/);assert.doesNotMatch(row.result,/PRIVATE_NOVEL_TEXT/)
 assert.equal(JSON.parse(row.request).native.session,'test-session')
})
test('session quota survives restart and admission is atomic across independent ledger owners',async t=>{
 const s=setup(t,{nativeMaxCallsPerSession:1}),other=new Ledger(s.path),guard=new NativeGuard(()=>other,{...config,nativeMaxCallsPerSession:1});let calls=0
 const counted=async function*(){calls++;yield* chunks}
 try{const results=await Promise.allSettled([drain(s.guard.stream(options(),counted)),drain(guard.stream(options(),counted))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,1);assert.equal(other.totals().calls,1)
  await assert.rejects(drain(guard.stream(options(),counted)),/调用上限/);assert.equal(calls,1)
 }finally{await guard.dispose();other.close()}
})
test('unpriced route, excessive inputs/output, multimedia and exhausted budget refuse dispatch',async t=>{
 const s=setup(t,{budgetCny:0});let calls=0;const counted=async function*(){calls++;yield* chunks}
 for(const input of [{...options(),provider:'other'},{...options(),maxTokens:undefined},{...options(),maxTokens:9999},{...options(),system:'x'.repeat(16001)},{...options(),messages:[{role:'user',content:[{type:'image',data:'image'}]}]},options()])await assert.rejects(drain(s.guard.stream(input,counted)))
 assert.equal(calls,0);assert.equal(s.ledger.totals().calls,0)
})
test('cancelled, failed and early-stopped requests retain reservations and missing usage stays unknown',async t=>{
 const s=setup(t,{nativeMaxCallsPerSession:10}),controller=new AbortController()
 const cancelled=async function*(){controller.abort();yield{type:'finish',reason:{kind:'aborted'}}}
 await drain(s.guard.stream({...options(),signal:controller.signal},cancelled))
 await assert.rejects(drain(s.guard.stream(options(),async function*(){throw new Error('PRIVATE_HEADER')})),/PRIVATE_HEADER/)
 const iterator=s.guard.stream(options(),stream);await iterator.next();await iterator.return()
 const rows=s.ledger.db.prepare('SELECT status,result FROM literary_calls ORDER BY rowid').all();assert.deepEqual(rows.map(r=>r.status),['cancelled','failed','failed'])
 assert.ok(rows.every(r=>JSON.parse(r.result).estimatedCny===null));assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_HEADER/);assert.ok(s.ledger.totals().reservedCny>0)
})
test('Cordis opt-in guard covers native calls, avoids literary double billing and unregisters on disposal',async t=>{
 const path=join(mkdtempSync(join(tmpdir(),'lg-native-cordis-')),'ledger.sqlite3'),ctx=new Context();let dispatched=0
 const service=ctx.plugin(c=>c.provide('llm',{stream(request){return c.waterfall(this,'llm/stream',request,async function*(){dispatched++;yield* chunks})}}));await service.await()
 const off=ctx.plugin(plugin,{...config,ledgerPath:path,guardNative:false});await off.await();await drain(ctx.llm.stream({...options(),provider:'unpriced'}));await off.dispose()
 const fiber=ctx.plugin(plugin,{...config,ledgerPath:path,guardNative:true});await fiber.await()
 await drain(ctx.llm.stream(options()));assert.equal(ctx.literaryExecution.totals().calls,1)
 await drain(ctx.llm.stream({...options(),purpose:'literary-task'}));assert.equal(ctx.literaryExecution.totals().calls,2)
 await assert.rejects(drain(ctx.llm.stream({...options(),purpose:'literary-task'})),/调用上限/)
 await assert.rejects(drain(ctx.llm.stream({...options(),provider:'unpriced'})),/已配置/)
 await fiber.dispose();await drain(ctx.llm.stream({...options(),provider:'unpriced'}));assert.equal(dispatched,4);await service.dispose()
})
test('a reserved literary dispatch is exempt exactly once even if a caller reuses its purpose or object', async t => {
 const path = join(mkdtempSync(join(tmpdir(),'lg-owned-budget-')), 'calls.sqlite3')
 const ctx = new Context()
 let request, dispatched = 0
 const fixture = ctx.plugin(c => c.provide('llm',{
   async prepareCall(config) { return {config, stream: options => this.stream(options)} },
   stream(options) {
     request = options
     return c.waterfall(this, 'llm/stream', options, async function* () {
       dispatched++
       yield {type:'block-end',index:0,block:{type:'text',text:'合成正文'}}
       yield {type:'finish',reason:{kind:'stop'}}
     })
   }
 }))
 await fixture.await()
 const configWithGuard = {...config, ledgerPath:path, guardNative:true, timeoutMs:1000}
 const input = {system:'写作',input:'潮汐'}
 // Fund exactly one literary call. Any second reservation will be refused.
 configWithGuard.budgetCny = Math.ceil((Buffer.byteLength(input.system+input.input)+2048)*config.inputCnyPerMillion
   + config.maxOutputTokens*config.outputCnyPerMillion) / 1e6
 const fiber = ctx.plugin(plugin,configWithGuard)
 t.after(async () => { await fiber.dispose(); await fixture.dispose() })
 await fiber.await()
 const id = 'owned-call-replay-01'
 const saved = await ctx.literaryExecution.run(id,input)
 assert.equal(saved.status,'succeeded')
 const original = request
 await assert.rejects(drain(ctx.llm.stream({...original})),/预算不足/)
 await assert.rejects(drain(ctx.llm.stream(original)),/预算不足/)
 assert.deepEqual(await ctx.literaryExecution.run(id,input),saved)
 assert.equal(ctx.literaryExecution.totals().calls,1)
 assert.equal(dispatched,1)
})
