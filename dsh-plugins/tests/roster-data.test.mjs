import test from 'node:test'
import assert from 'node:assert/strict'
import {recentSessions,sparkDays} from '../lg-dashboard/src/roster-data.js'
import {dateKeys} from '../lg-dashboard/src/global-data.js'
import {summarizeRequests} from '../lg-agent-teams/src/telemetry.js'

test('recent tasks keep running first then sort recent activity within the selected dates',()=>{
 const rows=[{id:'old',updatedAt:+new Date('2026-10-01')},{id:'recent',updatedAt:+new Date('2026-11-12T10:00:00')},{id:'earlier',updatedAt:+new Date('2026-11-11T10:00:00')},{id:'active',updatedAt:1,running:true}]
 assert.deepEqual(recentSessions(rows,{start:+new Date('2026-11-11T00:00:00'),end:+new Date('2026-11-12T23:59:59.999')}).map(r=>r.id),['active','recent','earlier'])
 assert.equal(rows[0].id,'old')
})
test('sparklines adapt day count, fill missing days, preserve range and unknown usage',()=>{
 const keys=dateKeys('2026-11-01','2026-11-12'),days={'2026-11-11':{requests:2,tokens:0,known:0}}
 assert.equal(sparkDays(days,keys,68).length,4)
 assert.equal(sparkDays(days,keys,224).length,12)
 assert.equal(sparkDays(days,keys,112)[0].day,'2026-11-06')
 assert.equal(sparkDays(days,keys,112).at(-2).known,0)
 assert.equal(sparkDays(days,['2026-11-12'],224).length,1)
 assert.deepEqual(sparkDays(days,[],224),[])
})
test('daily role usage includes all requests beyond the detail cap and counts cache once',()=>{
 const rows=Array.from({length:305},(_,i)=>({id:String(i),role:'coordinator',started:'2026-11-11T23:30:00',status:'completed',usage:{inputTokens:10,outputTokens:2,cacheReadTokens:3,cacheWriteTokens:1}}))
 rows.push({id:'missing',role:'coordinator',started:'2026-11-12T00:30:00',status:'failed'})
 const result=summarizeRequests(rows),main=result.roles[0]
 assert.equal(result.series.length,300)
 assert.deepEqual(main.days['2026-11-11'],{requests:305,tokens:4880,known:305})
 assert.deepEqual(main.days['2026-11-12'],{requests:1,tokens:0,known:0})
 assert.deepEqual(result.roles[1].days,{})
 assert.equal(Object.values(main.days).reduce((n,d)=>n+d.tokens,0),main.input+main.output)
})
