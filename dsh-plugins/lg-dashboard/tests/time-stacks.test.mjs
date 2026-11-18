import test from 'node:test'
import assert from 'node:assert/strict'
import {timelinePairs,timelineCapacity} from '../src/components/time-stacks.js'
const timeline={version:1,step:3600000,buckets:[{from:1000,to:2000,roles:[{role:'analysis',requests:2,known:1,input:100,output:10,inputAllocation:{system:60},outputAllocation:{text:5}},{role:'writing',requests:1,known:1,input:200,output:20,inputAllocation:{schemas:200},outputAllocation:{text:20}}]}]}
test('all-Agent and selected-Agent timeline use identical recorded totals and retain missing composition',()=>{
 const original=JSON.stringify(timeline),all=timelinePairs(timeline,'all')[0],one=timelinePairs(timeline,'analysis')[0]
 assert.equal(all.input.value,300);assert.equal(all.output.value,30);assert.equal(one.input.value,100)
 assert.equal(one.missing,1);assert.equal(one.input.parts.find(p=>p.key==='unknown').value,40)
 assert.equal(one.input.parts.find(p=>p.key==='system').color,'#9d7bf5')
 assert.equal(all.input.parts.find(p=>p.key==='schemas').color,'#5b8def')
 assert.equal(JSON.stringify(timeline),original)
})
test('a metric bucket keeps missing duration distinct from zero and retains request labels and colors',()=>{
 const duration=timelinePairs(timeline,'analysis','time')[0],empty=timelinePairs(timeline,'planning','time')[0]
 assert.equal(duration.input.value,null);assert.equal(duration.missing,2)
 assert.equal(empty.input.value,0);assert.equal(empty.missing,0)
 const requests=timelinePairs(timeline,'analysis','requests')[0]
 assert.deepEqual(requests.input.parts.map(p=>[p.label,p.value,p.color]),[
  ['Completed',2,'var(--lgd-accent,#d97757)'],['Failed',0,'#74dcae'],['Running',0,'#9ab8db'],
 ])
 assert.deepEqual(requests.output,{value:0,parts:[]})
})
test('responsive capacity targets the original demo width; old hosts never fall back to sampled requests',()=>{
 assert.equal(timelineCapacity(18),1);assert.equal(timelineCapacity(268),21);assert.ok(timelineCapacity(500)>timelineCapacity(268));assert.equal(timelineCapacity(1e5),96)
 assert.deepEqual(timelinePairs(undefined,'all'),[])
})

test('five groups merge adjacent buckets without changing range, totals, unknowns or original data',async()=>{
 const {coarsenTimeline}=await import('../src/components/time-stacks.js')
 const roles=['coordinator','analysis','planning','writing']
 const source={version:1,from:0,to:21*3600000,step:3600000,buckets:Array.from({length:21},(_,i)=>({from:i*3600000,to:(i+1)*3600000,roles:roles.map((role,j)=>({role,requests:2,known:1,input:(i+1)*(j+1)*10,output:(i+1)*(j+1),inputAllocation:{system:(i+1)*(j+1)*4},outputAllocation:{text:(i+1)*(j+1)*.5}}))}))}
 const before=JSON.stringify(source)
 const sum=(pairs,side)=>pairs.reduce((n,p)=>n+(p[side].value??0),0)
 for(const capacity of [1,3,5,7,21,96]){
  const merged=coarsenTimeline(source,capacity)
  assert.ok(merged.buckets.length<=capacity)
  assert.equal(merged.buckets[0].from,source.from);assert.equal(merged.buckets.at(-1).to,source.to)
  for(let i=1;i<merged.buckets.length;i++)assert.equal(merged.buckets[i-1].to,merged.buckets[i].from)
  for(const role of ['all',...roles]){
   const a=timelinePairs(source,role),b=timelinePairs(merged,role)
   for(const side of ['input','output']){
    assert.equal(sum(a,side),sum(b,side))
    assert.equal(a.reduce((n,p)=>n+p[side].parts.find(x=>x.key==='unknown').value,0),b.reduce((n,p)=>n+p[side].parts.find(x=>x.key==='unknown').value,0))
   }
  }
  for(const side of ['input','output'])assert.equal(sum(timelinePairs(merged,'all'),side),roles.reduce((n,role)=>n+sum(timelinePairs(merged,role),side),0))
 }
 assert.equal(JSON.stringify(source),before)
 assert.equal(coarsenTimeline(undefined,3),undefined)
 assert.ok(coarsenTimeline(source,20).buckets.length>coarsenTimeline(source,5).buckets.length)
})
