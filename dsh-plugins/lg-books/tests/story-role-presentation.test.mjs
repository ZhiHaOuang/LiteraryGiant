import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createStoryFixture} from './story-data-fixture.mjs'
import {readStoryData,importStoryData} from '../src/story-data/store.js'
import {readStoryTime} from '../src/story-data/queries.js'
import {presentStoryRecords,sortStoryRecords} from '../src/story-data/presentation.js'
import {characterPortraits} from '../src/story-data/presentation-fields.js'

function fixture(){
 const root=mkdtempSync(join(process.env.LG_STORY_TEST_ROOT??tmpdir(),'lg-role-view-')),batch=createStoryFixture(root)
 const make=(subject,prominence,id='role:'+subject)=>({...structuredClone(batch.records[0].record),
  id,schema_version:'1.1.0',type:'role_assignment',title:'人物评级',summary:'合成测试人物身份。',
  scope:{kind:'book',description:'全书',targets:[]},story_time:{kind:'all',label:'全书',after_event:null,before_event:null},
  payload:{subject,prominence,roles:['protagonist']},approval:'candidate',freshness:'current',related_changed:[]})
 return {root,batch,make}
}
function projected(root,roles){
 const rows=readStoryData(root,{limit:200}).records
 return presentStoryRecords([...rows,...roles],new Map())
}

test('registered importance takes precedence over reference count; explicit reference sorting remains available',()=>{
 const {root,make}=fixture()
 const rows=projected(root,[make('person:yuan','core'),make('person:lin','major')]).filter(r=>r.type==='entity')
 assert.ok(rows.find(r=>r.id==='person:lin').display.related_count>rows.find(r=>r.id==='person:yuan').display.related_count)
 assert.equal(sortStoryRecords(rows,'recommended','entity')[0].id,'person:yuan')
 assert.equal(sortStoryRecords(rows,'references','entity')[0].id,'person:lin')
 assert.equal(rows.find(r=>r.id==='person:yuan').display.character_role.approval,'candidate')
})

test('scoped or uncertain-time roles stay inspectable without becoming whole-book importance',()=>{
 const {root,make}=fixture(),role=make('person:lin','core')
 role.scope={kind:'arc',description:'第一卷',targets:[]}
 let profile=projected(root,[role]).find(r=>r.id==='person:lin').display.character_role
 assert.equal(profile.prominence,'unknown');assert.equal(profile.status,'scoped');assert.equal(profile.assignments[0].prominence,'core')
 role.scope.kind='book';role.story_time.kind='unknown'
 profile=projected(root,[role]).find(r=>r.id==='person:lin').display.character_role
 assert.equal(profile.status,'scoped')
})

test('explicit character rating sort uses consistent scoped labels before reference counts and pagination',()=>{
 const {root,batch,make}=fixture()
 const scoped=(id,level)=>{
  const role=make(id,level)
  role.scope={kind:'arc',description:'第一卷',targets:[]}
  delete role.approval;delete role.freshness;delete role.related_changed
  return {record:role,expected_revision:null}
 }
 importStoryData(root,{...batch,operation:'scoped-sort',run:{...batch.run,id:'scoped-sort'},records:[
  scoped('person:yuan','core'),scoped('person:lin','supporting'),
 ]})
 const page=readStoryData(root,{type:'entity',entity_kind:'character',sort:'importance',limit:1})
 assert.equal(page.records[0].id,'person:yuan')
 assert.equal(page.records[0].display.character_role.status,'scoped')
 const conflicting=scoped('person:yuan','minor');conflicting.record.id='role:later'
 importStoryData(root,{...batch,operation:'conflicting-sort',run:{...batch.run,id:'conflicting-sort'},records:[conflicting]})
 assert.equal(readStoryData(root,{type:'entity',entity_kind:'character',sort:'importance',limit:1}).records[0].id,'person:lin')
})

test('contradictory global ratings stay unresolved; visible confirmed ratings precede candidates',()=>{
 const {root,make}=fixture(),core=make('person:lin','core','role:core'),minor=make('person:lin','minor','role:minor')
 let profile=projected(root,[core,minor]).find(r=>r.id==='person:lin').display.character_role
 assert.equal(profile.status,'conflict');assert.equal(profile.prominence,'unknown')
 minor.approval='confirmed'
 profile=projected(root,[core,minor]).find(r=>r.id==='person:lin').display.character_role
 assert.equal(profile.prominence,'minor');assert.equal(profile.approval,'confirmed');assert.equal(profile.assignments.length,2)
})

test('rejected, stale and dependency-changed roles cannot determine importance',()=>{
 const {root,make}=fixture()
 for(const patch of [{approval:'rejected'},{approval:'withdrawn'},{freshness:'stale'},{related_changed:['person:lin']}]){
  const role={...make('person:lin','core'),...patch}
  assert.equal(projected(root,[role]).find(r=>r.id==='person:lin').display.character_role.assignments.length,0)
 }
})

test('real v1.1 records drive both book and temporal entity lists; cutoff excludes later ratings',()=>{
 const {root,batch,make}=fixture(),role=make('person:yuan','core')
 delete role.approval;delete role.freshness;delete role.related_changed
 role.evidence=batch.records.find(r=>r.record.id==='event:healing').record.evidence
 importStoryData(root,{...batch,operation:'ui-role',run:{...batch.run,id:'ui-role'},records:[{record:role,expected_revision:null}]})
 assert.equal(readStoryData(root,{type:'entity',sort:'importance'}).records[0].id,'person:yuan')
 assert.equal(readStoryTime(root,{include_candidates:true}).entities[0].id,'person:yuan')
 assert.equal(readStoryData(root,{type:'entity',through_chapter:2}).records.find(r=>r.id==='person:yuan').display.character_role.prominence,'unknown')
 assert.equal(readStoryTime(root).entities.length,0)
})

test('a card features a visible current portrait of this exact character',()=>{
 const {root}=fixture(),rows=readStoryData(root,{limit:200}).records
 const lin=rows.find(r=>r.id==='person:lin'),yuan=rows.find(r=>r.id==='person:yuan')
 const original=rows.find(r=>r.type==='portrait')
 const behavior={...original,id:'portrait:behavior',payload:{...original.payload,aspect:'behavior',description:'遇到逆风仍会出船。'}}
 const choose=entries=>presentStoryRecords([lin,yuan,...entries],new Map()).slice(0,2).map(r=>r.display.character_portrait)
 assert.equal(choose([original,behavior])[0].description,behavior.payload.description)
 assert.equal(choose([behavior,{...original,approval:'confirmed'}])[0].description,original.payload.description)
 for(const patch of [{approval:'rejected'},{approval:'withdrawn'},{freshness:'stale'},{related_changed:['person:lin']}]){
  assert.deepEqual(choose([{...original,...patch}]),[null,null])
 }
 assert.equal(choose([behavior])[1],null)
 const hidden=readStoryData(root,{type:'entity',confirmed_only:true})
 assert.ok(hidden.records.every(r=>!r.display.character_portrait))
})

test('short labels retain their subject, source and review status and omit ambiguous titles',()=>{
 const person={id:'l',payload:{name:'林澈',aliases:['守灯人'],entity_kind:'character'}}
 const portrait=(id,title,extra={})=>({id,title,type:'portrait',freshness:'current',related_changed:[],approval:'candidate',
  payload:{subject:'l',aspect:'value',description:'保留来信。'},...extra})
 const summarize=rows=>characterPortraits(rows,[person]).get('l').traits
 assert.deepEqual(summarize([portrait('a','守灯人的谨慎与克制')]),[
  {record_id:'a',label:'谨慎',approval:'candidate'},{record_id:'a',label:'克制',approval:'candidate'}])
 assert.deepEqual(summarize([portrait('b','林澈的克制',{approval:'confirmed'}),portrait('a','林澈的谨慎与克制')]).map(t=>t.label),['克制','谨慎'])
 assert.deepEqual(summarize([portrait('a','邻人的谨慎'),portrait('b','林澈的谨慎与克制',{freshness:'stale'}),portrait('c','林澈的谨慎是假象')]),[])
})
