// Run prepare-book-sections.mjs first; never touches a registered daily book.
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {readStoryData,importStoryData} from '../../lg-books/src/story-data/store.js'
import {contractHash} from '../../lg-books/src/story-data/validate.js'
const stage=process.env.LG_DASHBOARD_TEST_ROOT
assert.ok(stage?.includes('/LitIsLand/')&&existsSync(stage+'/.dashboard-test-profile'))
const root=stage+'/Books/潮汐来信',page=readStoryData(root,{limit:200})
assert.ok(!page.records.some(r=>r.id==='knowledge:question'),'Use a fresh synthetic fixture')
const stored=id=>page.records.find(r=>r.id===id)
const base=id=>{const {revision,confirmed_revision,approval,freshness,related_changed,created_at,run_id,display,...r}=stored(id);return structuredClone(r)}
const updates=[]
const add=(record,existing=false)=>updates.push({record,expected_revision:existing?stored(record.id).revision:null})
const role=base('role:person:lin');role.scope={kind:'arc',description:'仅前 1—3 章的身份判断',targets:[]};add(role,true)
const knowledge=base('knowledge:death');knowledge.schema_version='1.1.0';knowledge.payload.topic='father-status';knowledge.payload.previous_record=null;add(knowledge,true)
const question=structuredClone(knowledge);question.id='knowledge:question';question.title='林澈开始怀疑';question.payload.stance='doubts';question.payload.previous_record=knowledge.id;question.summary='林澈开始怀疑原有判断。';question.basis='author';question.evidence=[];question.author_note='只用于验证前序链接的合成作者候选。';add(question)
const state=base('state:injured');state.id='state:healed';state.schema_version='1.1.0';state.title='右臂恢复';state.payload.value='右臂已经恢复。';state.payload.previous_record='state:injured';state.payload.trigger_event='event:healing';state.story_time={kind:'unknown',label:'持续时间尚未登记',after_event:null,before_event:null};state.evidence=base('event:healing').evidence;add(state)
const healing=base('event:healing');healing.schema_version='1.1.0';healing.story_time={kind:'relative',label:'摔伤三日后',after_event:'event:injury',before_event:null,offset:{anchor_event:'event:injury',anchor_point:'end',min:3,max:3,unit:'day'}};add(healing,true)
add(base('event:injury'),true) // Rebind its before-link to the updated healing record.
for(let i=1;i<=9;i++){const r=base('revelation:alive');r.id='revelation:extra-'+i;r.title='合成读者披露 '+i;r.payload.about_record=null;add(r)}
importStoryData(root,{schema:'lg.story-data.batch.v1',contract_hash:contractHash,book_id:page.book_id,branch:'main',operation:'alignment-fixture',run:{id:'alignment-fixture',producer:'author',method:'UI field alignment test'},coverage:[...new Map(updates.flatMap(({record})=>record.evidence).map(({document_id,version_id,sha256})=>[document_id,{document_id,version_id,sha256,status:'complete',note:'合成资料阅读范围'}])).values()],records:updates})
console.log('Prepared scoped roles, knowledge/state predecessors, relative anchor and paged revelations.')
