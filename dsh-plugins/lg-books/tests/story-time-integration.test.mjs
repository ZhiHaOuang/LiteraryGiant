import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createStoryFixture} from './story-data-fixture.mjs'
import {readStoryData,importStoryData,decideStoryRecord,previewStoryMigration,migrateStoryData} from '../src/story-data/store.js'
import {readStoryTime} from '../src/story-data/queries.js'
import {contractHash,legacyContractHash,validateRecord,verifyGraph} from '../src/story-data/validate.js'
import {createContext} from '../../lg-context/src/service.js'

const fixture=()=>{const root=mkdtempSync(join(process.env.LG_STORY_TEST_ROOT??tmpdir(),'lg-time-'));return {root,batch:createStoryFixture(root)}}
const approve=(root,id)=>{const r=readStoryData(root,{id}).records[0];return decideStoryRecord(root,{book_id:'test-book',operation:'approve:'+r.revision,id,expected_revision:r.revision,approval:'confirmed',author:'测试作者',reason:'合成场景确认'})}
function update(root,batch,r,operation){const current=readStoryData(root,{id:r.id}).records[0];return importStoryData(root,{...batch,contract_hash:contractHash,operation,run:{id:operation,producer:'author',method:'合成测试'},records:[{record:r,expected_revision:current?.revision??null}]})}

test('v1 reads without implicit migration; explicit migration preserves all revisions and rejects stale token',()=>{
 const {root}=fixture(),db=new DatabaseSync(join(root,'.literarygiant/story.sqlite3'))
 db.prepare('UPDATE lg_story_data_meta SET value=? WHERE key=?').run('1.0.0','version');db.prepare('UPDATE lg_story_data_meta SET value=? WHERE key=?').run(legacyContractHash,'contract_hash')
 const original=db.prepare('SELECT * FROM lg_story_data_revisions ORDER BY id').all()
 assert.equal(readStoryData(root).total,15)
 assert.equal(db.prepare("SELECT value FROM lg_story_data_meta WHERE key='version'").get().value,'1.0.0')
 const p=previewStoryMigration(root);assert.equal(p.needed,true);assert.deepEqual(p.issues,[])
 assert.throws(()=>migrateStoryData(root,{token:'0'.repeat(64),operation:'migrate-stale'}),/变化/)
 const input={token:p.token,operation:'migrate-test'},receipt=migrateStoryData(root,input)
 assert.deepEqual(migrateStoryData(root,input),receipt)
 assert.deepEqual(db.prepare('SELECT * FROM lg_story_data_revisions ORDER BY id').all(),original)
 assert.equal(previewStoryMigration(root).needed,false);db.close()
})

test('v1.1 permits scoped roles and time coordinates, but old version cannot silently accept new fields',()=>{
 const {root,batch}=fixture(),person=batch.records[0].record
 const role={...structuredClone(person),id:'role:lin',schema_version:'1.1.0',type:'role_assignment',basis:'author',author_note:'作者指定',scope:{kind:'arc',description:'第一卷',targets:[]},payload:{subject:'person:lin',prominence:'core',roles:['protagonist']}}
 validateRecord(role);update(root,batch,role,'role-add')
 assert.equal(readStoryData(root,{type:'role_assignment'}).records[0].payload.prominence,'core')
 assert.throws(()=>validateRecord({...role,schema_version:'1.0.0'}))
 const event=structuredClone(batch.records.find(r=>r.record.id==='event:injury').record)
 event.schema_version='1.1.0';event.story_time={kind:'range',label:'第三天上午',after_event:null,before_event:null,coordinate:{axis:'main',unit:'hour',start_min:56,start_max:58,end_min:58,end_max:60}}
 validateRecord(event);update(root,batch,event,'event-range')
 assert.ok(readStoryTime(root,{include_candidates:true}).events.length)
})

test('temporal and predecessor cycles are rejected by real import validation',()=>{
 const {batch}=fixture(),rows=batch.records.map(x=>structuredClone(x.record))
 const a=rows.find(r=>r.id==='event:injury'),b=rows.find(r=>r.id==='event:healing')
 a.links=[];a.story_time={kind:'relative',label:'A在B后',after_event:b.id,before_event:null};b.story_time={kind:'relative',label:'B在A后',after_event:a.id,before_event:null}
 assert.throws(()=>verifyGraph(rows),/循环|矛盾/)
})

test('confirmed query excludes candidates; no future revelation enters event-bound character context',()=>{
 const {root,batch}=fixture()
 assert.equal(readStoryTime(root).events.length,0)
 assert.equal(readStoryTime(root,{include_candidates:true}).events.length,2)
 for(const r of batch.records)approve(root,r.record.id)
 const knowledge=structuredClone(batch.records.find(r=>r.record.id==='knowledge:death').record)
 knowledge.story_time={kind:'all',label:'测试明确有效范围',after_event:null,before_event:null}
 update(root,batch,knowledge,'knowledge-range');approve(root,knowledge.id)
 const books={readState(){},storyTime:(path,input)=>readStoryTime(path,input)}
 const context=createContext(books,{}),options={audience:'character',maxBytes:4000,story:{subject:'person:lin',event:'event:injury',phase:'after',through_chapter:2}}
 const built=context.build(root,options),text=JSON.stringify(built.payload)
 assert.match(text,/父亲已经死亡/);assert.doesNotMatch(text,/医馆醒来/)
 assert.ok(context.verify(root,built.receipt))
 const changed=structuredClone(knowledge);changed.payload.stance='doubts';update(root,batch,changed,'knowledge-change');approve(root,knowledge.id)
 assert.throws(()=>context.verify(root,built.receipt),/变化/)
 assert.throws(()=>context.build(root,{...options,notes:true}),/混入/)
 assert.throws(()=>readStoryTime(root,{include_candidates:'yes'}),/无效/)
})
