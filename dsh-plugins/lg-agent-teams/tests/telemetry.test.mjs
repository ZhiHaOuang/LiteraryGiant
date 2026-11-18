import test from 'node:test'
import assert from 'node:assert/strict'
import {createTelemetry,inputComposition,summarizeRequests} from '../src/telemetry.js'
import {totalRoles} from '../../lg-dashboard/src/team-data.js'
test('numeric composition measures Unicode without retaining text or double counting stream block endings',()=>{
 const options={system:'系统',messages:[{role:'user',content:[{type:'text',text:'😀甲'}]},{role:'tool',content:[{type:'text',text:'结果'}]}]}
 assert.equal(inputComposition(options).user,2)
 let time=0;const m=createTelemetry(options,()=>time)
 time=100;m.chunk({type:'reasoning-delta',index:0,text:'思考'})
 time=200;m.chunk({type:'block-end',index:0,block:{type:'reasoning',text:'思考'}})
 time=250;m.chunk({type:'text-delta',index:1,text:'答案'})
 time=350;m.chunk({type:'block-end',index:1,block:{type:'text',text:'答案'}})
 time=400;const result=m.finish()
 assert.deepEqual(result.stages,{ttft:100,reasoning:100,text:100,toolarg:0,other:100})
 assert.equal(result.ttftMs,100);assert.equal(result.generationMs,300)
 assert.deepEqual(result.outputChars,{text:2,reasoning:2,toolarg:0})
 assert.ok(!JSON.stringify(result).includes('答案'))
})
test('no token stream has unknown TTFT, tool calls are unique per block',()=>{
 let time=0;const m=createTelemetry({},()=>time);time=50;const v=m.finish()
 assert.equal(v.ttftMs,null);assert.equal(v.stages.other,50)
 const n=createTelemetry({},()=>time)
 n.chunk({type:'tool-call-delta',index:0,argumentsDelta:'{'});n.chunk({type:'tool-call-delta',index:0,argumentsDelta:'}'});n.chunk({type:'tool-call-delta',index:1,argumentsDelta:'{}'})
 assert.equal(n.finish().toolCalls,2)
})
test('summary preserves unknowns, cache is counted once, weighted speed uses matched successful samples',()=>{
 const data=summarizeRequests([
 {id:'a',role:'coordinator',status:'completed',usage:{inputTokens:10,cacheReadTokens:20,outputTokens:5},elapsedMs:1000,telemetry:{version:1,ttftMs:500,generationMs:500,stages:{ttft:500,text:500},inputChars:{system:20},outputChars:{text:5}}},
 {id:'b',role:'coordinator',status:'failed',usage:null,elapsedMs:1000},
 {id:'c',role:'writing',status:'completed',usage:{inputTokens:50,outputTokens:15},elapsedMs:2000},
 ])
 assert.equal(data.series[1].input,null);assert.equal(data.series[1].telemetry,null)
 const total=totalRoles(data.roles)
 assert.equal(total.input,80);assert.equal(total.output,20);assert.equal(total.cache,20)
 assert.equal(total.measured,1);assert.equal(total.known,2);assert.equal(total.failed,1)
 assert.equal(total.speedTokens/total.generationMs*1000,10)
 assert.equal(total.elapsedMs,4000)
})
test('trend limit never limits full-scope role totals and returned records exclude raw failure text',()=>{
 const rows=Array.from({length:310},(_,i)=>({id:String(i),role:'analysis',status:'failed',failure:'SECRET',usage:null}))
 const m=summarizeRequests(rows)
 assert.equal(m.series.length,300);assert.equal(m.omitted,10);assert.equal(m.roles[1].requests,310)
 assert.ok(!JSON.stringify(m).includes('SECRET'))
})

test('name-only tool deltas retain call names and native turn/step without storing arguments',()=>{
 let time=0;const m=createTelemetry({system:'PRIVATE SYSTEM',messages:[]},()=>time,{turn:2,step:3})
 time=20;m.chunk({type:'tool-call-delta',index:0,name:'lg_team_result',argumentsDelta:''})
 time=30;m.chunk({type:'tool-call-delta',index:0,argumentsDelta:'PRIVATE ARGUMENTS'})
 time=40;const v=m.finish()
 assert.deepEqual(v.calledTools,['lg_team_result']);assert.equal(v.toolCalls,1);assert.equal(v.ttftMs,20)
 assert.equal(v.context.turn,2);assert.equal(v.context.step,3)
 assert.ok(!JSON.stringify(v).includes('PRIVATE'))
 assert.equal(createTelemetry({},()=>0).finish().context.turn,null)
})

test('context aggregates stay estimated and cache hits exclude writes and unmeasured samples',()=>{
 const telemetry=createTelemetry({system:'A system prompt',messages:[{role:'user',content:[{type:'text',text:'Hi'}]}]},()=>0).finish()
 const contextTotal=Object.values(telemetry.context.tokens).reduce((a,b)=>a+b,0)
 const data=summarizeRequests([
  {id:'a',role:'coordinator',status:'completed',usage:{inputTokens:100,cacheReadTokens:200,cacheWriteTokens:100,outputTokens:10},telemetry},
  {id:'b',role:'coordinator',status:'completed',usage:{inputTokens:600,outputTokens:20},telemetry:{version:1,inputChars:{system:20}}},
  {id:'c',role:'analysis',status:'completed',usage:{inputTokens:50,cacheReadTokens:0,cacheWriteTokens:50,outputTokens:5},telemetry},
 ])
 const total=totalRoles(data.roles)
 assert.equal(total.input,1100);assert.equal(total.cacheRead,200);assert.equal(total.cacheWrite,150)
 assert.equal(total.cacheKnown,2);assert.equal(total.cacheInput,500)
 assert.equal(total.cacheRead/total.cacheInput,.4)
 assert.equal(total.contextMeasured,2);assert.equal(total.measured,3)
 assert.equal(Object.values(total.contextTokens).reduce((a,b)=>a+b,0),contextTotal*2)
 assert.notEqual(contextTotal*2,total.input)
 assert.equal(data.series[1].cacheRead,null)
 assert.equal(data.roles[0].contextMeasured,1)
 assert.equal(total.contextItems.user,2)
})

test('paired token composition estimates each observed request and leaves historical usage unallocated',()=>{
 const rows=[
  {id:'a',role:'analysis',status:'completed',usage:{inputTokens:100,cacheReadTokens:60,cacheWriteTokens:40,outputTokens:20},telemetry:{version:1,context:{version:1,tokens:{system:1,schemas:3}},outputChars:{text:3,reasoning:1}}},
  {id:'b',role:'analysis',status:'completed',usage:{inputTokens:200,outputTokens:80},telemetry:{version:1,context:{version:1,tokens:{system:3,schemas:1}},outputChars:{text:1,reasoning:3}}},
  {id:'c',role:'analysis',status:'completed',usage:{inputTokens:100,outputTokens:10}},
  {id:'d',role:'analysis',status:'failed',usage:null,telemetry:{version:1,context:{version:1,tokens:{system:999}},outputChars:{text:999}}},
 ]
 const role=summarizeRequests(rows).roles.find(row=>row.role==='analysis')
 assert.equal(role.input,500);assert.equal(role.output,110);assert.equal(role.known,3)
 assert.deepEqual(role.inputAllocation,{system:200,schemas:200,unknown:100})
 assert.deepEqual(role.outputAllocation,{text:35,reasoning:65,unknown:10})
 assert.equal(role.inputCompositionKnown,2);assert.equal(role.outputCompositionKnown,2)
 assert.equal(role.requests,4)
})

test('paired compositions aggregate the full selected range even when request details are capped',()=>{
 const rows=Array.from({length:310},(_,i)=>({id:String(i),role:'writing',status:'completed',usage:{inputTokens:10,outputTokens:4},telemetry:{version:1,context:{version:1,tokens:{user:2,system:3}},outputChars:{text:1}}}))
 const summary=summarizeRequests(rows),role=summary.roles.find(row=>row.role==='writing')
 assert.equal(summary.series.length,300);assert.equal(summary.omitted,10)
 assert.equal(role.inputAllocation.system,1860);assert.equal(role.inputAllocation.user,1240)
 assert.equal(role.outputAllocation.text,1240);assert.equal(role.inputCompositionKnown,310)
})
