import {test} from 'node:test'
import assert from 'node:assert/strict'
import {validateStoryResponse,STORY_READ_API,shouldRestartStoryPage,withCharacterPortraits} from '../src/story-read.js'
test('dashboard refuses incompatible/incomplete reads instead of displaying empty data',()=>{
 const value={api_version:STORY_READ_API,data_revision:'a'.repeat(64),book_id:'test-book',records:[],chapters:[],entities:[],runs:[],catalog:{},counts:{},directory:{},total:0,offset:0,limit:8}
 assert.equal(validateStoryResponse('story-data',value),value)
 assert.throws(()=>validateStoryResponse('story-data',{...value,api_version:'future'}),/版本/)
 assert.throws(()=>validateStoryResponse('story-data',{...value,records:null}),/不完整/)
 assert.throws(()=>validateStoryResponse('story-overview',value),/不完整/)
 assert.throws(()=>validateStoryResponse('story-overview',{...value,coverage:{},quality:{}}),/不完整/)
 assert.throws(()=>validateStoryResponse('story-time',{...value,events:[],timeline:{},character:null}),/不完整/)
 assert.throws(()=>validateStoryResponse('story-data',{...value,total:undefined}),/不完整/)
 assert.throws(()=>validateStoryResponse('story-data',{...value,offset:undefined}),/不完整/)
 assert.throws(()=>validateStoryResponse('story-data',{...value,directory:null}),/不完整/)
})

test('empty overview counts are valid while coverage and quality must be present',()=>{
 const coverage={chapters:[],registered_chapters:0,total_chapters:0}
 const quality={source_issues:[],dependency_issues:[],unplaced_events:[],unknown_state_time:[],unrated_characters:[],scoped_roles:[],possible_duplicates:[],candidate:0,confirmed:0}
 const value={api_version:STORY_READ_API,data_revision:'a'.repeat(64),book_id:'test-book',chapters:[],entities:[],counts:{},total:0,coverage,quality}
 assert.equal(validateStoryResponse('story-overview',value),value)
 for(const patch of [{counts:null},{coverage:null},{coverage:{...coverage,registered_chapters:undefined}},{quality:null}]){
  assert.throws(()=>validateStoryResponse('story-overview',{...value,...patch}),/不完整/)
 }
})

test('an empty timeline and a null character projection are valid but missing collections are rejected',()=>{
 const timeline={groups:[],unplaced:[],relations:[],warnings:[]}
 const value={api_version:STORY_READ_API,data_revision:'a'.repeat(64),book_id:'test-book',chapters:[],entities:[],directory:{},records:[],events:[],timeline,character:null}
 assert.equal(validateStoryResponse('story-time',value),value)
 for(const field of ['groups','unplaced','relations','warnings']){
  assert.throws(()=>validateStoryResponse('story-time',{...value,timeline:{...timeline,[field]:undefined}}),/不完整/)
 }
 for(const field of ['records','events','directory']){
  assert.throws(()=>validateStoryResponse('story-time',{...value,[field]:undefined}),/不完整/)
 }
})

test('changed source versions reset subsequent pages only within the same query',()=>{
 const previous={key:'people',book_id:'book-a',api_version:STORY_READ_API,data_revision:'a'.repeat(64)}
 assert.equal(shouldRestartStoryPage(previous,previous,'people',1),false)
 const next={...previous,data_revision:'b'.repeat(64)}
 assert.equal(shouldRestartStoryPage(previous,next,'people',1),true)
 assert.equal(shouldRestartStoryPage(previous,next,'people',0),false)
 assert.equal(shouldRestartStoryPage(previous,next,'world',1),false)
 assert.equal(shouldRestartStoryPage(null,next,'people',1),false)
})

test('record-level incompatibilities fail at the adapter instead of crashing a detail card',()=>{
 const record={id:'state:a',type:'state',title:'状态',summary:'合成状态。',revision:'r1',payload:{facet:'身体'},scope:{description:'全书',targets:[]},story_time:{kind:'unknown'},evidence:[],links:[],related_changed:[],approval:'candidate',freshness:'current'}
 const value={api_version:STORY_READ_API,data_revision:'a'.repeat(64),book_id:'test-book',records:[record],chapters:[],entities:[],runs:[],catalog:{},counts:{},directory:{},total:1,offset:0,limit:8}
 assert.equal(validateStoryResponse('story-data',value),value)
 assert.equal(validateStoryResponse('story-data',{...value,records:[{...record,payload:{...record.payload,future_field:'kept'}}]}).records[0].payload.future_field,'kept')
 for(const patch of [{payload:null},{scope:null},{links:null},{evidence:[null]},{related_changed:null}])assert.throws(()=>validateStoryResponse('story-data',{...value,records:[{...record,...patch}]}),/不完整/)
})

test('older services hydrate from visible portrait pages once per book revision and cutoff',async()=>{
 const page={book_id:'book',data_revision:'rev',counts:{portrait:3},records:[{id:'lin',display:{}}]}
 const input={path:'/book',options:{through_chapter:3,confirmed_only:true}},cache={current:null}
 const calls=[],signal=new AbortController().signal
 const read=async request=>{
  const o=request.options
  calls.push(o)
  const r={type:'portrait',approval:'confirmed',freshness:'current',related_changed:[],display:{source:{chapter:2},facet:'行为倾向'},payload:{subject:'lin',aspect:'behavior',description:'保留旧信。'}}
  return {...page,offset:o.offset,total:3,records:o.offset===0?[{...r,id:'wrong',approval:'rejected'}]:[{...r,id:'later',freshness:'stale'},{...r,id:'visible'}]}
 }
 const hydrated=await withCharacterPortraits(page,input,cache,signal,read)
 assert.equal(hydrated.records[0].display.character_portrait.description,'保留旧信。')
 assert.deepEqual(calls.map(o=>[o.offset,o.through_chapter,o.confirmed_only]),[[0,3,true],[1,3,true]])
 await withCharacterPortraits(page,input,cache,signal,read)
 await withCharacterPortraits({...page,records:[{id:'lin',display:{character_portrait:null}}]},input,{current:null},signal,read)
 assert.equal(calls.length,2)
 await withCharacterPortraits(page,{...input,options:{through_chapter:2}},cache,signal,read)
 assert.equal(calls.length,4)
 await assert.rejects(withCharacterPortraits({...page,data_revision:'changed'},input,cache,signal,read),/更新/)
})
