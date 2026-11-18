import test from 'node:test'
import assert from 'node:assert/strict'
import {makePreviewRecords,withPreview} from '../src/usage-preview.js'
import {totalRoles} from '../src/team-data.js'
test('month overlay is deterministic, complete and never mutates real usage',()=>{
 const now=Date.parse('2026-11-12T12:00:00Z'),rows=makePreviewRecords(now)
 assert.deepEqual(rows,makePreviewRecords(now));assert.equal(rows.length,360)
 assert.equal(new Set(rows.map(r=>r.role)).size,4)
 const role={...totalRoles([]),role:'coordinator',input:100,output:20,requests:1,known:1}
 for(const period of ['all','7d']){
  const from=now-(period==='all'?86400000:7*86400000),monitor={roles:[role],timeline:{version:1,period,from,to:now+1,step:86400000,buckets:Array.from({length:period==='all'?1:7},(_,i)=>({from:from+i*86400000,to:Math.min(now+1,from+(i+1)*86400000),roles:i===0?[role]:[]}))}}
  const original=JSON.stringify(monitor),result=withPreview(monitor,rows),total=totalRoles(result.roles),bucketTotal=totalRoles(result.timeline.buckets.flatMap(b=>b.roles))
  assert.equal(JSON.stringify(monitor),original)
  assert.equal(total.input,bucketTotal.input);assert.equal(total.output,bucketTotal.output)
  assert.equal(total.requests,1+rows.filter(r=>r.started>=result.timeline.from&&r.started<result.timeline.to).length)
  assert.ok(result.timeline.from<=from)
 }
 for(const row of rows){assert.equal(Object.values(row.inputAllocation).reduce((a,b)=>a+b,0),row.input);assert.equal(Object.values(row.outputAllocation).reduce((a,b)=>a+b,0),row.output)}
})
