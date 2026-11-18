import {test} from 'node:test'
import assert from 'node:assert/strict'
import {apiStats,heatmapWindow} from '../src/api-data.js'
const cost=(provider,model,input,output,cache=0)=>({[provider]:{[model]:{off:{uncached:input,cacheRead:cache,cacheWrite:0,output}}}})
const range={from:'2026-11-01',to:'2026-11-08'}
test('keeps vLLM and cloud model identities separate; cached input counted once',()=>{
 const result=apiStats([{activity:{days:{'2026-11-08':{requests:2,cost:{...cost('cloud','same',100,20,30),...cost('vllm','same',40,10)}}}}}],range)
 assert.equal(result.length,2);assert.equal(result[0].tokens,150);assert.equal(result[0].input,130)
 assert.equal(result[1].provider,'vllm');assert.equal(result[0].requestKnown,false)
})
test('date filter excludes outside usage and rejects partial-session speed attribution',()=>{
 const member={cost:cost('cloud','m',200,40),timing:{speedTokens:40,speedMs:1000,ttftMs:400,calls:2}}
 const activity={days:{'2026-10-31':{requests:1,cost:cost('cloud','m',100,20)},'2026-11-08':{requests:1,cost:cost('cloud','m',100,20)}}}
 const rows=[{activity,family:[member],familyActivity:[activity]}]
 let result=apiStats(rows,range)[0];assert.equal(result.tokens,120);assert.equal(result.requests,1);assert.equal(result.speedMs,0)
 result=apiStats(rows,{from:'2026-10-01',to:'2026-11-08'})[0];assert.equal(result.tokens,240);assert.equal(result.speedMs,1000);assert.equal(result.timedCalls,2)
})
test('mixed-model sessions never assign aggregate speed to the last model',()=>{
 const usage={...cost('a','m',10,2),...cost('b','m',20,4)}
 const activity={days:{'2026-11-08':{cost:usage,requests:2}}}
 const result=apiStats([{activity,family:[{cost:usage,timing:{speedTokens:6,speedMs:100}}],familyActivity:[activity]}],range)
 assert.ok(result.every(g=>g.speedMs===0))
})
test('heatmap has 53 Monday-first weeks and contiguous earlier pages',()=>{
 const current=heatmapWindow('2026-11-08'),prior=heatmapWindow('2026-11-08',1)
 assert.equal(current.length,371);assert.equal(new Date(current[0]+'T12:00:00').getDay(),1)
 const next=new Date(prior.at(-1)+'T12:00:00');next.setDate(next.getDate()+1)
 assert.equal(next.toISOString().slice(0,10),current[0])
})
