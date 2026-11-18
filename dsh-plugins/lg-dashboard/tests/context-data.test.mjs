import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
import {groupRows} from '../src/global-data.js'

// Bundle the pinned TypeScript upstream just as the plugin build does.
const compiled=await build({stdin:{contents:`
  export * from './context-data.js';
  export {kpisOf,aggregateDays} from '../../dsh-context/src/client/overview';
`,resolveDir:fileURLToPath(new URL('../src',import.meta.url)),loader:'js'},bundle:true,write:false,format:'esm',platform:'node'})
const {deriveUsage,kpisOf,aggregateDays}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'))
const cost={cloud:{model:{off:{uncached:100,cacheRead:20,cacheWrite:0,output:30}}}}
const rows=[
  {id:'a',cwd:'/books/a',updatedAt:1,activity:{days:{'2026-11-01':{cost,requests:2,turns:1},'2026-11-08':{cost,requests:3,turns:1}}}},
  {id:'b',cwd:'/books/b',updatedAt:2,activity:{days:{'2026-11-08':{cost,requests:1,turns:1}}}},
  {id:'unbound',updatedAt:3,activity:null},
].map(row=>({...row,timeline:null,family:[],familyCost:null}))
const groups=groupRows(rows,[{path:'/books/a'},{path:'/books/b'}]).rowsByBook
const prices=null,range={from:'2026-11-08',to:'2026-11-08'}

test('derived totals preserve upstream semantics across book and date filters',()=>{
  const scope={start:+new Date(range.from+'T00:00:00'),end:+new Date(range.to+'T23:59:59.999')}
  for(const filter of [null,'/books/a','/books/b','unbound','/removed']){
    const value=deriveUsage(rows,groups,range,prices,filter)
    const scoped=filter===null?rows:groups.get(filter)??[]
    assert.deepEqual(value.stats,kpisOf(scoped,prices,'cny',scope))
    assert.deepEqual(value.days,aggregateDays(rows,prices,'cny'),'Activity/Last 7 Days remain global')
    for(const [path,members] of groups)assert.deepEqual(value.kpisByBook.get(path),kpisOf(members,prices,'cny',scope))
    assert.deepEqual(value.agents.map(a=>a.row.id),scoped.filter(r=>r.activity?.days[range.from]).map(r=>r.id))
  }
})

test('invalid ranges keep all-date activity but suppress range statistics',()=>{
  const value=deriveUsage(rows,groups,{from:'2026-11-09',to:'2026-11-08'},prices,null)
  assert.equal(value.stats,null)
  assert.deepEqual(value.dayKeys,[])
  assert.deepEqual(value.agents,[]);assert.deepEqual(value.skills,[]);assert.deepEqual(value.tools,[])
  assert.deepEqual(value.days,aggregateDays(rows,prices,'cny'))
})

test('columns and recent sessions use inclusive local days across New Year',()=>{
 const bounds={from:'2026-12-31',to:'2027-01-01'}
 const sessions=[
  ['before','2026-12-30T23:59:59.999'],['first','2026-12-31T00:00:00'],
  ['last','2027-01-01T23:59:59.999'],['after','2027-01-02T00:00:00'],
  ['running','2026-12-30T12:00:00'],
 ].map(([id,time])=>({...rows[2],id,updatedAt:+new Date(time),running:id==='running'}))
 const groups=groupRows(sessions,[]).rowsByBook
 const selected=deriveUsage(sessions,groups,bounds,null,null)
 assert.deepEqual(selected.dayKeys,['2026-12-31','2027-01-01'])
 assert.deepEqual(selected.tasks.map(r=>r.id),['running','last','first'])
 const reversed=deriveUsage(sessions,groups,{from:bounds.to,to:bounds.from},null,null)
 assert.deepEqual(reversed.tasks.map(r=>r.id),['running'])
 assert.deepEqual(deriveUsage([],new Map(),bounds,null,null).dayKeys,selected.dayKeys)
})
