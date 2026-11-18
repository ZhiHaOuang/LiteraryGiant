import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createStoryFixture} from './story-data-fixture.mjs'
import {readStoryData,importStoryData} from '../src/story-data/store.js'
import {presentStoryRecords} from '../src/story-data/presentation.js'

function fixture(){const root=mkdtempSync(join(tmpdir(),'lg-section-view-'));return {root,batch:createStoryFixture(root)}}
function add(root,batch,records){importStoryData(root,{...batch,operation:'section-filters',run:{...batch.run,id:'section-filters'},records:records.map(record=>({record,expected_revision:null}))})}

test('analysis and thread filters run before pagination and reject mismatched categories',()=>{
 const {root,batch}=fixture(),analysis=structuredClone(batch.records.find(r=>r.record.type==='analysis').record),thread=structuredClone(batch.records.find(r=>r.record.type==='thread').record)
 analysis.id='analysis:summary';analysis.payload.dimension='summary';thread.id='thread:foreshadow';thread.payload.thread_kind='foreshadowing'
 add(root,batch,[analysis,thread])
 const page=readStoryData(root,{type:'analysis',dimension:'summary',limit:1,offset:40})
 assert.equal(page.total,1);assert.equal(page.offset,0);assert.equal(page.records[0].id,analysis.id)
 assert.equal(readStoryData(root,{type:'thread',thread_kind:'foreshadowing'}).records[0].id,thread.id)
 assert.throws(()=>readStoryData(root,{type:'event',dimension:'summary'}),/维度/)
 assert.throws(()=>readStoryData(root,{type:'thread',thread_kind:'invented'}),/线索/)
 assert.throws(()=>readStoryData(root,{type:'entity',reader_visibility:'revealed'}),/揭露/)
})

test('world visibility uses explicit revelation evidence and respects chapter cutoff',()=>{
 const {root,batch}=fixture(),reveal=structuredClone(batch.records.find(r=>r.record.type==='revelation').record)
 assert.equal(readStoryData(root,{type:'world_rule',reader_visibility:'unmarked'}).total,1)
 assert.equal(readStoryData(root,{type:'world_rule',reader_visibility:'unrevealed'}).total,0)
 reveal.id='revelation:tide';reveal.payload.about_record='rule:tide'
 add(root,batch,[reveal])
 const world=readStoryData(root,{type:'world_rule',reader_visibility:'revealed'}).records[0]
 assert.deepEqual(world.display.reader_visibility.revelations,[{id:reveal.id,approval:'candidate',presentation:'reveal'}])
 assert.equal(readStoryData(root,{type:'world_rule',reader_visibility:'revealed',through_chapter:2}).total,0)
 assert.equal(readStoryData(root,{type:'world_rule',reader_visibility:'unmarked',through_chapter:2}).total,1)
})

test('hints, rejected or stale revelations never become certain exposure',()=>{
 const {root}=fixture(),rows=readStoryData(root,{limit:200}).records,original=rows.find(r=>r.type==='revelation')
 const state=patch=>presentStoryRecords([...rows.filter(r=>r.id!==original.id),{...original,...patch}],new Map()).find(r=>r.id==='rule:tide').display.reader_visibility
 const payload={...original.payload,about_record:null},links=[{relation:'reveals',target:'rule:tide',explanation:'合成关联'}]
 assert.equal(state({payload,links}).state,'revealed')
 assert.equal(state({payload:{...payload,presentation:'hint'},links}).state,'unmarked')
 for(const patch of [{approval:'rejected'},{freshness:'stale'},{related_changed:['rule:tide']}])assert.equal(state({payload,links,...patch}).state,'unmarked')
})
