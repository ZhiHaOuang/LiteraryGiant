import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {createStoryFixture} from './story-data-fixture.mjs'
import {readStoryData,importStoryData,storyRecordHistory} from '../src/story-data/store.js'
import {sourceLocations,presentStoryRecords,sortStoryRecords} from '../src/story-data/presentation.js'

const fixture=()=>{
 const root=mkdtempSync(join(process.env.LG_STORY_TEST_ROOT??tmpdir(),'lg-story-order-'))
 return {root,batch:createStoryFixture(root)}
}
function add(root,batch,records){
 importStoryData(root,{...batch,operation:'extra',run:{...batch.run,id:'extra'},records:records.map(record=>({record,expected_revision:null}))})
}

test('all categories use numeric chapter/paragraph order; unknown positions come last',()=>{
 const {root}=fixture(),all=readStoryData(root,{limit:200})
 const chapters=all.records.map(r=>r.display.source?.chapter??Infinity)
 assert.deepEqual(chapters,[...chapters].sort((a,b)=>a-b))
 const events=readStoryData(root,{type:'event'})
 assert.deepEqual(events.records.map(r=>r.id),['event:injury','event:healing'])
 assert.equal(events.records[0].display.source.paragraph,1)
 assert.equal(events.records[0].display.source.chapter_title,'第二章 潮汐来信')
 assert.equal(all.records.at(-1).display.source,null)
})

test('repeated headings get content titles; identical content remains distinct across pages without rewriting history',()=>{
 const {root,batch}=fixture(),base=batch.records.find(r=>r.record.type==='analysis').record
 const records=Array.from({length:19},(_,i)=>({...structuredClone(base),id:`analysis:copy${i}`,title:'本章节奏',summary:i<2?'短句让这一段的节奏加快。':`第 ${i} 项不同的已有分析结论。`}))
 add(root,batch,records)
 const before=storyRecordHistory(root,records[0].id)
 const first=readStoryData(root,{type:'analysis',limit:8}),second=readStoryData(root,{type:'analysis',limit:8,offset:8}),third=readStoryData(root,{type:'analysis',limit:8,offset:16})
 assert.deepEqual([first.records.length,second.records.length,third.records.length],[8,8,4])
 const all=[...first.records,...second.records,...third.records]
 assert.equal(new Set(all.map(r=>r.id)).size,20)
 assert.equal(new Set(all.map(r=>r.display.title)).size,20)
 assert.ok(all.some(r=>r.display.title==='短句让这一段的节奏加快。 · 记录 1'))
 assert.equal(all.find(r=>r.id===records[0].id).title,'本章节奏')
 assert.deepEqual(storyRecordHistory(root,records[0].id),before)
 assert.equal(readStoryData(root,{type:'analysis',query:'不存在',offset:16}).offset,0)
 assert.equal(readStoryData(root,{type:'analysis',limit:8,offset:400}).offset,16)
})

test('entities group by kind and distinct incoming records, not names or invented importance',()=>{
 const {root,batch}=fixture(),base=batch.records.find(r=>r.record.type==='entity').record
 const extra={...structuredClone(base),id:'place:light',title:'灯塔',payload:{...base.payload,entity_kind:'place',name:'灯塔'}}
 add(root,batch,[extra])
 const data=readStoryData(root,{type:'entity'})
 assert.equal(data.records[0].id,'person:lin')
 assert.ok(data.records[0].display.related_count>data.records[1].display.related_count)
 assert.equal(data.records.at(-1).payload.entity_kind,'place')
 assert.equal('importance' in data.records[0].display,false)
 assert.equal(readStoryData(root,{type:'entity',entity_kind:'place'}).total,1)
 assert.deepEqual(data.entities.map(e=>e.id),data.records.map(e=>e.id))
 // A subject filter must not change an entity's rank/count within the reading scope.
 assert.equal(readStoryData(root,{type:'entity',subject:'person:lin'}).records[0].display.related_count,data.records[0].display.related_count)
})

test('counts ignore duplicate references and rejected records; later chapters do not leak into earlier rank',()=>{
 const {root}=fixture()
 const early=readStoryData(root,{type:'entity',through_chapter:1}),full=readStoryData(root,{type:'entity'})
 assert.ok(early.records[0].display.related_count<full.records[0].display.related_count)
 assert.equal(early.directory['person:yuan'],undefined)
 const all=readStoryData(root,{limit:200}).records
 const scene=all.find(r=>r.type==='scene'),entity=all.find(r=>r.id==='person:lin')
 const rows=presentStoryRecords([entity,scene,{...scene,id:'scene:rejected',approval:'rejected'}],new Map())
 assert.equal(rows[0].display.related_count,1,'pov and participants referencing the same person count once')
})

test('child scenes resolve to chapter order; chapter cutoff retains in-scope scene evidence',()=>{
 const {root,batch}=fixture(),db=new DatabaseSync(join(root,'.literarygiant/story.sqlite3'))
 const evidence={...batch.records[0].record.evidence[0],document_id:2,version_id:2}
 const original=db.prepare('SELECT content FROM document_versions WHERE id=1').get().content
 db.prepare('UPDATE document_versions SET content=? WHERE id=2').run(original);db.close()
 const record={...structuredClone(batch.records[0].record),id:'person:scene',evidence:[evidence]}
 batch.coverage.push({...batch.coverage[0],document_id:2,version_id:2})
 add(root,batch,[record])
 const selected=readStoryData(root,{id:record.id,through_chapter:1}).records[0]
 assert.equal(selected.display.source.chapter,1)
 assert.equal(selected.display.source.document_title,'不重复累计的场景')
 const chapters=[{id:9,title:'第九章'},{id:10,title:'第十章'}]
 const docs=[...chapters.map(c=>({...c,kind:'chapter'})),{id:11,parent_id:10,sequence:2},{id:12,parent_id:11,sequence:3}]
 const locations=sourceLocations(docs,chapters)
 assert.deepEqual(locations.get(12).document_order,[2,3])
 assert.equal(locations.get(12).chapter,2)
})

test('stable ties, explicit name sort, invalid sort rejection and restricted directories remain bounded',()=>{
 const {root}=fixture(),all=readStoryData(root,{limit:200}).records
 assert.deepEqual(sortStoryRecords(all).map(r=>r.id),sortStoryRecords([...all].reverse()).map(r=>r.id))
 const named=readStoryData(root,{sort:'name',limit:200}).records.map(r=>r.display.title)
 assert.deepEqual(named,[...named].sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true})))
 assert.throws(()=>readStoryData(root,{sort:'importance'}),/排序/)
 assert.throws(()=>readStoryData(root,{entity_kind:'character'}),/分类/)
 const restricted=readStoryData(root,{audience:'reader',through_chapter:1})
 assert.deepEqual(restricted.directory,{})
 assert.deepEqual(restricted.entities,[])
})
