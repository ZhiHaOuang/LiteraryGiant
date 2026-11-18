import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createBook} from './fixture.mjs'
import {importStoryData,readStoryData,decideStoryRecord,storyRecordHistory} from '../src/story-data/store.js'
import {digest,contractHash,validateRecord} from '../src/story-data/validate.js'
import {createStoryFixture} from './story-data-fixture.mjs'

function fixture(){
 const root=mkdtempSync(join(process.env.LG_STORY_TEST_ROOT??tmpdir(),'lg-story-')),{db}=createBook(root)
 const content=db.prepare('SELECT content FROM document_versions WHERE id=1').get().content
 const evidence=[{document_id:1,version_id:1,sha256:digest(content),paragraph:1,quote:'林澈关上灯。'}]
 const base=(id,type,payload)=>({schema_version:'1.0.0',id,type,title:'测试记录',summary:'来自测试正文的候选记录。',basis:'text',scope:{kind:'book',description:'测试书范围',targets:[]},story_time:{kind:'unknown',label:'未确定',after_event:null,before_event:null},evidence,author_note:'',links:[],payload})
 const person=base('char:lin','entity',{entity_kind:'character',name:'林澈',aliases:[],description:'守灯人。'})
 const belief=base('belief:father','knowledge',{holder:person.id,proposition:'父亲已经死亡。',stance:'believes',acquired_by:'told',trigger_event:null})
 const revelation=base('reveal:letter','revelation',{proposition:'信中声称父亲已经死亡。',presentation:'statement',speaker:person.id,about_record:belief.id})
 const batch=(records,op='import:one')=>({schema:'lg.story-data.batch.v1',contract_hash:contractHash,book_id:'test-book',branch:'main',operation:op,run:{id:op,producer:'model',method:'fixture-v1'},coverage:[{document_id:1,version_id:1,sha256:digest(content),status:'complete',note:'完整测试段落'}],records:records.map(record=>({expected_revision:null,record}))})
 const confirm=id=>{const r=readStoryData(root).records.find(r=>r.id===id);return decideStoryRecord(root,{operation:'approve:'+id+':'+r.revision,book_id:'test-book',id,expected_revision:r.revision,approval:'confirmed',author:'测试作者',reason:'确认这是人物的相信，并非世界事实。'})}
 return {root,db,base,person,belief,revelation,batch,confirm,evidence}
}
test('separates beliefs/revelations/world facts, candidate views and confirmed versions',()=>{
 const f=fixture();f.db.close()
 const input=f.batch([f.person,f.belief,f.revelation]),first=importStoryData(f.root,input)
 assert.deepEqual(importStoryData(f.root,input),first)
 assert.equal(readStoryData(f.root).total,3)
 assert.equal(readStoryData(f.root,{audience:'character',holder:f.person.id,through_chapter:1}).total,0)
 assert.equal(readStoryData(f.root,{audience:'character',holder:f.person.id,through_chapter:1}).chapters.length,1)
 f.confirm(f.person.id);f.confirm(f.belief.id);f.confirm(f.revelation.id)
 assert.equal(readStoryData(f.root,{audience:'character',holder:f.person.id,through_chapter:1}).records[0].payload.stance,'believes')
 assert.equal(readStoryData(f.root,{audience:'reader',through_chapter:1}).records[0].type,'revelation')
 assert.equal(readStoryData(f.root,{type:'world_rule'}).total,0)
 const current=readStoryData(f.root).records.find(r=>r.id===f.belief.id),edited=structuredClone(f.belief);edited.payload.proposition='另一份尚未确认的猜测。'
 const update=f.batch([edited],'import:two');update.records[0].expected_revision=current.revision;importStoryData(f.root,update)
 assert.equal(readStoryData(f.root,{audience:'character',holder:f.person.id,through_chapter:1}).records[0].payload.proposition,'父亲已经死亡。')
 assert.equal(storyRecordHistory(f.root,f.belief.id).length,3)
 assert.throws(()=>importStoryData(f.root,{...update,operation:'import:three'}),/版本/)
})
test('rejects unsupported contracts, wrong books, stale writes, fabricated evidence and dangling references atomically',()=>{
 const f=fixture();f.db.close()
 for(const mutation of [b=>b.book_id='other',b=>b.contract_hash='x',b=>b.branch='other',b=>b.records[0].record.evidence[0].quote='原文不存在的引文',b=>b.records.push({expected_revision:null,record:f.belief})]){
  const b=structuredClone(f.batch([f.person]));mutation(b)
  if(b.records.length>1){b.records[1]=structuredClone(b.records[1]);b.records[1].record.payload.holder='missing'}
  assert.throws(()=>importStoryData(f.root,b))
  assert.equal(readStoryData(f.root).total,0)
 }
 const input=f.batch([f.person]);importStoryData(f.root,input)
 const conflict=structuredClone(input);conflict.records[0].record.summary='不同的内容';assert.throws(()=>importStoryData(f.root,conflict),/不同内容/)
 const stale=f.batch([f.person],'new-operation');assert.throws(()=>importStoryData(f.root,stale),/版本/)
})
test('tracks source revisions and preserves historical records after manuscript edits',()=>{
 const f=fixture();importStoryData(f.root,f.batch([f.person,f.belief]));f.confirm(f.person.id);f.confirm(f.belief.id)
 f.db.prepare("INSERT INTO document_versions(document_id,version_number,state,content,reason,created_at) VALUES (1,3,'accepted','林澈打开灯。','修订','2026-11-11')").run()
 f.db.prepare('UPDATE documents SET active_version_id=(SELECT max(id) FROM document_versions) WHERE id=1').run();f.db.close()
 assert.equal(readStoryData(f.root).records[0].freshness,'stale')
 assert.equal(readStoryData(f.root,{audience:'character',holder:f.person.id,through_chapter:1}).total,0)
 assert.equal(storyRecordHistory(f.root,f.belief.id).length,2)
 assert.throws(()=>f.confirm(f.belief.id),/过期/)
})
test('validates typed payloads, chronology, author authority and actual payoff',()=>{
 const f=fixture();f.db.close()
 const plan=f.base('plan:one','plan',{level:'chapter',parent:null,objective:'救出父亲。',steps:['抵达城门。'],expected_changes:[],constraints:[],reveal:[],withhold:[],selection:'selected',realized_events:[]})
 assert.throws(()=>validateRecord(plan),/作者规划/)
 plan.basis='author';plan.author_note='作者计划';assert.throws(()=>importStoryData(f.root,f.batch([plan])),/冒充作者/)
 const author=f.batch([plan]);author.run.producer='author';importStoryData(f.root,author)
 assert.equal(readStoryData(f.root,{type:'event'}).total,0)
 const a=f.base('event:a','event',{actors:[],location:null,action:'关灯。',outcome:'灯灭了。',motivation:'',scene:null}),b=structuredClone(a);b.id='event:b'
 a.links=[{relation:'before',target:b.id,explanation:'先发生'}];b.links=[{relation:'before',target:a.id,explanation:'错误顺序'}]
 assert.throws(()=>importStoryData(f.root,f.batch([a,b],'cycle')),/循环/)
 const bad=structuredClone(f.person);bad.story_time.kind='relative';assert.throws(()=>validateRecord(bad),/边界/)
})
test('complete typed fixture, chapter cutoff, reference browsing and history',()=>{
 const root=mkdtempSync(join(process.env.LG_STORY_TEST_ROOT??tmpdir(),'lg-story-catalog-'))
 createStoryFixture(root)
 const all=readStoryData(root,{limit:100})
 assert.equal(Object.keys(all.counts).length,13)
 assert.equal(readStoryData(root,{through_chapter:1,type:'revelation'}).total,0)
 assert.equal(readStoryData(root,{through_chapter:3,type:'revelation'}).total,1)
 assert.equal(readStoryData(root,{id:'state:injured'}).records[0].story_time.before_event,'event:healing')
 assert.ok(readStoryData(root,{subject:'person:lin'}).total>=5)
 assert.equal(readStoryData(root,{query:'认知不存在'}).total,0)
 assert.equal(storyRecordHistory(root,'person:lin')[0].record.payload.name,'林澈')
})
test('dependency changes require review, while a pending candidate preserves confirmed support',()=>{
 const f=fixture();f.db.close();importStoryData(f.root,f.batch([f.person,f.belief]));f.confirm(f.person.id);f.confirm(f.belief.id)
 const current=readStoryData(f.root).records.find(r=>r.id===f.person.id),changed=structuredClone(f.person);changed.payload.description='作者尚未确认的新档案描述。'
 const update=f.batch([changed],'entity-update');update.records[0].expected_revision=current.revision;importStoryData(f.root,update)
 assert.deepEqual(readStoryData(f.root,{id:f.belief.id}).records[0].related_changed,[])
 f.confirm(f.person.id)
 assert.deepEqual(readStoryData(f.root,{id:f.belief.id}).records[0].related_changed,[f.person.id])
 assert.equal(readStoryData(f.root,{audience:'character',holder:f.person.id,through_chapter:1}).total,0)
 assert.throws(()=>f.confirm(f.belief.id),/关联依据/)
 const belief=readStoryData(f.root,{id:f.belief.id}).records[0]
 const decision=decideStoryRecord(f.root,{operation:'reject-candidate',book_id:'test-book',id:belief.id,expected_revision:belief.revision,approval:'rejected',author:'作者',reason:'先拒绝待复核版本'})
 assert.ok(readStoryData(f.root,{id:belief.id}).records[0].confirmed_revision)
 decideStoryRecord(f.root,{operation:'withdraw-confirmation',book_id:'test-book',id:belief.id,expected_revision:decision.revision,approval:'withdrawn',author:'作者',reason:'撤回确认'})
 assert.equal(readStoryData(f.root,{id:belief.id}).records[0].confirmed_revision,null)
})

test('restricted metadata hides later chapter titles even before extraction',()=>{
 const f=fixture();f.db.close()
 const view=readStoryData(f.root,{audience:'reader',through_chapter:1})
 assert.equal(view.chapters.length,1);assert.equal(view.records.length,0)
 assert.throws(()=>readStoryData(f.root,{audience:'character',through_chapter:1}),/持有人/)
})

test('history follows append order even when timestamps move backwards',()=>{
 const f=fixture();importStoryData(f.root,f.batch([f.person]));f.confirm(f.person.id)
 const expected=storyRecordHistory(f.root,f.person.id)
 f.db.prepare('UPDATE lg_story_data_revisions SET created_at=? WHERE id=?').run('2099-01-01',expected[0].revision)
 f.db.prepare('UPDATE lg_story_data_revisions SET created_at=? WHERE id=?').run('2000-01-01',expected[1].revision);f.db.close()
 const actual=storyRecordHistory(f.root,f.person.id)
 assert.equal(actual[0].revision,expected[0].revision);assert.equal(actual[1].previous,actual[0].revision)
})
