import test from 'node:test'
import assert from 'node:assert/strict'
import {timelinePairs,coarsenTimeline} from '../src/components/time-stacks.js'
import {makePreviewRecords} from '../src/usage-preview.js'
import {totalRoles,usageBars,roleNames} from '../src/team-data.js'
import {statisticsRange} from '../src/stat-period.js'
import {dateKeys,localDay} from '../src/global-data.js'
test('daily endpoints include leap day and New Year, and All follows the earliest recorded key',()=>{
 const jan=+new Date(2027,0,3,12),mar=+new Date(2024,2,1,12)
 assert.deepEqual(statisticsRange('7d',[],jan),{from:'2026-12-27',to:'2027-01-03'})
 assert.deepEqual(statisticsRange('24h',[],mar),{from:'2024-02-29',to:'2024-03-01'})
 const rows=[{activity:{days:{'2027-01-01':{},invalid:{}}}},{activity:{days:{'2026-12-30':{},'2026-12-31':{}}}}]
 assert.deepEqual(statisticsRange('all',rows,jan),{from:'2026-12-30',to:'2027-01-03'})
 assert.deepEqual(statisticsRange('all',[],jan),{from:'2027-01-03',to:'2027-01-03'})
 assert.equal(statisticsRange('all',[{activity:{days:{'2027-01-04':{}}}}],jan).from,'2027-01-04')
})
test('all metrics preserve per-role totals across coarse time buckets and only tokens have a lower stack',()=>{
 const rows=makePreviewRecords(Date.parse('2026-11-12T12:00:00Z'))
 const timeline={version:1,step:1,from:0,to:30,buckets:Array.from({length:30},(_,i)=>({from:i,to:i+1,roles:Object.keys(roleNames).map(role=>({...totalRoles(rows.slice(i*12,i*12+12).filter(r=>r.role===role)),role}))}))}
 for(const mode of ['tokens','context','requests','time'])for(const role of ['all',...Object.keys(roleNames)])for(const capacity of [3,7,30]){
  const pairs=timelinePairs(coarsenTimeline(timeline,capacity),role,mode)
  const all=totalRoles(rows.filter(r=>role==='all'||r.role===role)),expected=mode==='tokens'?all.input:usageBars([{...all,role:'coordinator'}],mode)[0].value
  const actual=pairs.reduce((n,p)=>n+(p.input.value??0),0)
  assert.ok(Math.abs(actual-expected)<.0001,`${mode} ${role}`)
  assert.equal(pairs.reduce((n,p)=>n+(p.output.value??0),0),mode==='tokens'?all.output:0)
 }
})
test('header periods provide daily Context range while All includes history longer than one year',()=>{
 const now=Date.parse('2026-11-12T12:00:00Z'),rows=[{activity:{days:{'2024-01-01':{},'2026-11-11':{}}}}]
 assert.deepEqual(statisticsRange('today',rows,now),{from:localDay(new Date(now)),to:localDay(new Date(now))})
 assert.equal(statisticsRange('24h',rows,now).from,localDay(new Date(now-86400000)))
 for(const n of [7,14,30])assert.equal(statisticsRange(n+'d',rows,now).from,localDay(new Date(now-n*86400000)))
 const all=statisticsRange('all',rows,now);assert.equal(all.from,'2024-01-01');assert.equal(dateKeys(all.from,all.to).at(-1),all.to)
})
