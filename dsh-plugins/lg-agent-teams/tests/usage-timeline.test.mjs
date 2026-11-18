import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {usageWindow,requestTimeline} from '../src/usage-timeline.js'
import {summarizeRequests} from '../src/telemetry.js'
import {TeamStore} from '../src/store.js'
const now=Date.parse('2026-11-12T12:30:00+08:00')
test('today and rolling time periods have distinct exact bounds; unsupported presets fail',()=>{
 assert.equal(usageWindow('24h',now).from,now-86400000)
 const midnight=new Date(now);midnight.setHours(0,0,0,0)
 assert.equal(usageWindow('today',now).from,+midnight)
 assert.equal(usageWindow('7d',now).from,now-7*86400000)
 assert.equal(usageWindow('all',now,0).from,0)
 assert.throws(()=>usageWindow('bad',now),/period/)
})
test('time buckets include more than 300 records, cached input and composition without duplicate accounting',()=>{
 const rows=Array.from({length:420},(_,i)=>({id:String(i),role:['coordinator','analysis','planning','writing'][i%4],started:new Date(now-(i+1)*60000).toISOString(),status:'completed',usage:{inputTokens:10,cacheReadTokens:5,outputTokens:2},telemetry:{version:1,context:{version:1,tokens:{system:1,schemas:2}},outputChars:{text:2,reasoning:1}}}))
 const all=summarizeRequests(rows),small=requestTimeline(rows,'all',12,now),large=requestTimeline(rows,'all',60,now)
 assert.equal(all.series.length,300);assert.ok(small.buckets.length<large.buckets.length)
 for(const timeline of [small,large])for(const role of all.roles){
  const own=timeline.buckets.flatMap(b=>b.roles).filter(r=>r.role===role.role)
  for(const key of ['requests','input','output','known'])assert.equal(own.reduce((n,r)=>n+r[key],0),role[key])
  assert.equal(own.reduce((n,r)=>n+(r.inputAllocation.system??0),0),role.inputAllocation.system)
 }
 assert.equal(all.roles.reduce((n,r)=>n+r.input,0),420*15)
})
test('bucket capacity is bounded and no-data intervals remain empty, without generated usage',()=>{
 assert.throws(()=>requestTimeline([],'7d',1000,now),/count/)
 const result=requestTimeline([],'7d',24,now)
 assert.ok(result.buckets.length<=24)
 assert.ok(result.buckets.every(b=>b.roles.every(r=>r.requests===0&&r.input===0&&r.output===0)))
})
test('actual store period filtering respects book/archive scope and returns the entire selected aggregate',t=>{
 const store=new TeamStore(mkdtempSync(join(tmpdir(),'lg-time-test-')),'test',null);t.after(()=>store.close())
 store.bind('a','analysis','/book-a');store.bind('b','writing','/book-b')
 const make=(session,age)=>{const r=store.reserve({sessionId:session});store.finish(r.id,{status:'completed',usage:{inputTokens:10,outputTokens:2}});const json=JSON.parse(store.db.prepare('SELECT json FROM requests WHERE id=?').get(r.id).json);json.started=new Date(Date.now()-age).toISOString();store.db.prepare('UPDATE requests SET started=?, json=? WHERE id=?').run(json.started,JSON.stringify(json),r.id);return r.id}
 make('a',3600000);make('a',25*3600000);make('b',3600000)
 const archived=make('a',3600000);store.db.prepare('INSERT INTO dashboard_archives VALUES(?,?,?)').run(archived,'test',new Date().toISOString())
 const recent=store.overview({period:'24h',buckets:20,path:'/book-a'}),all=store.overview({period:'all',buckets:20,path:'/book-a'})
 assert.equal(recent.requests,1);assert.equal(all.requests,2)
 assert.equal(recent.monitoring.timeline.buckets.flatMap(b=>b.roles).reduce((n,r)=>n+r.requests,0),1)
 assert.equal(all.budget.used,4)
 assert.throws(()=>store.overview({period:'all',buckets:Infinity}),/count/)
})
