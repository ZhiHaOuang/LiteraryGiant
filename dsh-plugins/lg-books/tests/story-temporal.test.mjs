import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyTemporalGraph,timelineView,characterAt} from '../src/story-data/temporal.js'

const unknown=()=>({kind:'unknown',label:'未确定',after_event:null,before_event:null})
const row=(id,type='event',payload={})=>({id,type,payload,story_time:unknown(),links:[],scope:{kind:'book',targets:[]}})
const person=id=>row(id,'entity',{entity_kind:'character',name:id})
const time=(r,after_event,before_event=null)=>({...r,story_time:{kind:before_event?'interval':'relative',label:'',after_event,before_event}})
const point=(r,n,unit='day',axis='story')=>({...r,story_time:{...unknown(),kind:'range',coordinate:{axis,unit,start_min:n,start_max:n,end_min:n,end_max:n}}})
const before=(r,id)=>({...r,links:[{relation:'before',target:id}]})

test('combined story-time and before cycles are rejected, unrelated causal links are not chronology',()=>{
 assert.throws(()=>verifyTemporalGraph([time(row('a'),'b'),time(row('b'),'a')]),/循环/)
 assert.throws(()=>verifyTemporalGraph([before(row('a'),'b'),time(row('b'),null,'a')]),/循环/)
 assert.doesNotThrow(()=>verifyTemporalGraph([{...row('a'),links:[{relation:'causes',target:'b'}]},{...row('b'),links:[{relation:'causes',target:'a'}]}]))
})
test('state predecessors require same subject and facet and no cycles; knowledge requires stable topic',()=>{
 const p=person('p'),q=person('q'),a=row('a','state',{subject:'p',facet:'health',previous_record:'b'}),b=row('b','state',{subject:'q',facet:'location',previous_record:'a'})
 assert.throws(()=>verifyTemporalGraph([p,q,a,b]),/同一/)
 b.payload={subject:'p',facet:'health',previous_record:'a'}
 assert.throws(()=>verifyTemporalGraph([p,a,b]),/循环/)
 const k=row('k','knowledge',{holder:'p',topic:'father',previous_record:'j'}),j=row('j','knowledge',{holder:'p',topic:'identity'})
 assert.throws(()=>verifyTemporalGraph([p,k,j]),/同一/)
})
test('flashback event chronology ignores input/reading order, unknown events remain unplaced',()=>{
 const a=point(row('arrest'),3),b=point(row('theft'),1),c=row('unknown')
 const forward=timelineView([a,b,c]),reverse=timelineView([c,b,a])
 assert.deepEqual(forward,reverse)
 assert.deepEqual(forward.groups.map(g=>g.events),[['theft'],['arrest']])
 assert.deepEqual(forward.unplaced,['unknown'])
 assert.match(forward.groups[0].note,/不代表/)
})
test('same-time, overlap and different axes do not produce invented order',()=>{
 const a={...point(row('a'),1),links:[{relation:'simultaneous',target:'b'}]},b=point(row('b'),24,'hour'),c=point(row('c'),1,'day','dream')
 const result=timelineView([a,b,c]);assert.equal(result.relations.filter(r=>r.relation==='before').length,0)
 assert.deepEqual(result.groups[0].simultaneous,[['a','b']])
 assert.throws(()=>verifyTemporalGraph([{...a,links:[...a.links,{relation:'before',target:'b'}]},b]),/矛盾/)
 const x={...point(row('x'),1),links:[{relation:'overlaps',target:'y'}]},y=point(row('y'),2)
 assert.throws(()=>verifyTemporalGraph([x,y]),/重叠/)
})
test('ranges reject impossible starts and prove only disjoint intervals',()=>{
 const a=point(row('a'),1),b=point(row('b'),2);a.story_time.coordinate.end_min=0;a.story_time.coordinate.end_max=0
 assert.throws(()=>verifyTemporalGraph([a,b]),/起止/)
 const fuzzy=point(row('fuzzy'),1);fuzzy.story_time.coordinate.start_max=3;fuzzy.story_time.coordinate.end_max=4
 assert.equal(timelineView([fuzzy,b]).relations.length,0)
 assert.throws(()=>verifyTemporalGraph([before(point(row('later'),3),'earlier'),point(row('earlier'),1)]),/矛盾/)
})
test('relative offset uses anchor units, does not invent duration, rejects offset/before contradiction',()=>{
 const a=point(row('a'),1),b=row('b');b.story_time={...unknown(),kind:'relative',offset:{anchor_event:'a',anchor_point:'end',min:2,max:3,unit:'hour'}}
 assert(timelineView([a,b]).relations.some(r=>r.from==='a'&&r.to==='b'))
 assert.throws(()=>verifyTemporalGraph([a,before(b,'a')]),/循环|矛盾/)
 const c=row('c');c.story_time={...unknown(),kind:'relative',offset:{anchor_event:'missing',anchor_point:'end',min:1,max:2,unit:'day'}}
 assert.throws(()=>verifyTemporalGraph([c]),/引用缺失/)
 const visible=timelineView([c]);assert(visible.warnings.some(s=>s.includes('不在当前')))
})
test('indirect time contradictions and cyclic relative anchors cannot slip through',()=>{
 assert.throws(()=>verifyTemporalGraph([before(point(row('a'),3),'b'),before(row('b'),'c'),point(row('c'),1)]),/矛盾|循环/)
 const offset=(id,anchor)=>({...row(id),story_time:{...unknown(),kind:'relative',offset:{anchor_event:anchor,anchor_point:'start',min:1,max:1,unit:'day'}}})
 assert.throws(()=>verifyTemporalGraph([offset('x','y'),offset('y','x')]),/锚点存在循环/)
 const a=point(row('a'),1),b=point(row('b'),1),c=point(row('c'),3)
 b.story_time.coordinate.start_max=3;b.story_time.coordinate.end_max=3
 a.links=[{relation:'simultaneous',target:'b'}];b.links=[{relation:'simultaneous',target:'c'}]
 assert.throws(()=>verifyTemporalGraph([a,b,c]),/不相容/)
})
test('character state is bounded before/after events; unknown trigger is not everlasting truth',()=>{
 const p=person('p'),injury=row('injury'),healing=time(row('healing'),'injury'),state=time(row('hurt','state',{subject:'p',facet:'health',value:'受伤',trigger_event:'injury'}),'injury','healing')
 const unknownState=row('location','state',{subject:'p',facet:'location',value:'岛上',trigger_event:'injury'})
 const records=[p,injury,healing,state,unknownState]
 assert.equal(characterAt(records,{subject:'p',event:'injury',phase:'before'}).certain.length,0)
 assert.deepEqual(characterAt(records,{subject:'p',event:'injury',phase:'after'}).certain.map(r=>r.id),['hurt','location'])
 assert.deepEqual(characterAt(records,{subject:'p',event:'healing',phase:'before'}).certain.map(r=>r.id),['hurt'])
 assert.equal(characterAt(records,{subject:'p',event:'healing',phase:'after'}).certain.length,0)
 assert(characterAt(records,{subject:'p',event:'healing'}).uncertain.some(r=>r.id==='location'))
})
test('missing cutoff bounds stay uncertain and conflicting simultaneous states are reported',()=>{
 const p=person('p'),event=row('event'),s=time(row('s','state',{subject:'p',facet:'health',value:'受伤'}),'hidden')
 const a={...row('a','state',{subject:'p',facet:'health',value:'健康'}),story_time:{...unknown(),kind:'all'}},b={...row('b','state',{subject:'p',facet:'health',value:'生病'}),story_time:{...unknown(),kind:'all'}}
 const result=characterAt([p,event,s,a,b],{subject:'p',event:'event'})
 assert.deepEqual(result.uncertain.map(r=>r.id),['s']);assert.equal(result.conflicts.length,1)
 assert.equal(result.certain.length,2)
})
test('role assignment must point to a character; query rejects invalid phase and bounds its work',()=>{
 assert.throws(()=>verifyTemporalGraph([row('place','entity',{entity_kind:'place'}),row('role','role_assignment',{subject:'place'})]),/人物/)
 assert.throws(()=>characterAt([person('p'),row('e')],{subject:'p',event:'e',phase:'during'}),/之前或之后/)
 assert.throws(()=>timelineView(Array.from({length:501},(_,i)=>row('e'+i))),/500 个/)
 assert.doesNotThrow(()=>verifyTemporalGraph(Array.from({length:2000},(_,i)=>i===1999?row('e'+i):before(row('e'+i),'e'+(i+1)))))
})
test('scoped portraits and state offsets remain uncertain without matching time/scope evidence',()=>{
 const p=person('p'),e=row('e'),portrait={...row('portrait','portrait',{subject:'p',aspect:'fear'}),story_time:{...unknown(),kind:'all'},scope:{kind:'chapter',targets:[]}}
 const state=row('state','state',{subject:'p',facet:'health',value:'恢复',trigger_event:'e'});state.story_time={...unknown(),kind:'relative',offset:{anchor_event:'e',anchor_point:'end',min:2,max:2,unit:'day'}}
 const result=characterAt([p,e,portrait,state],{subject:'p',event:'e'})
 assert.equal(result.certain.length,0);assert.equal(result.uncertain.length,2);assert(result.warnings.some(s=>s.includes('偏移')))
})
test('a predecessor cannot have a demonstrably later trigger',()=>{
 const p=person('p'),a=before(row('a'),'b'),b=row('b')
 const old=row('old','state',{subject:'p',facet:'health',value:'受伤',trigger_event:'b'}),next=row('new','state',{subject:'p',facet:'health',value:'恢复',trigger_event:'a',previous_record:'old'})
 assert.throws(()=>verifyTemporalGraph([p,a,b,old,next]),/晚于/)
})
