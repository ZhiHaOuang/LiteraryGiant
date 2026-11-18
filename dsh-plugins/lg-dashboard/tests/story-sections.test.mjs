import {test} from 'node:test'
import assert from 'node:assert/strict'
import {sectionStats,timelineItems} from '../src/story-sections-data.js'

test('section counts distinguish characters from locations and other entities',()=>{
 const result=sectionStats({entities:[{kind:'character'},{kind:'place'},{kind:'group'}],counts:{entity:3,event:4,portrait:2,scene:1}})
 assert.deepEqual(result.people,[['人物',1],['侧写',2],['关系',0]])
 assert.deepEqual(result.world,[['设定',0],['地点',1],['场景',1]])
 assert.equal(result.plot[0][1],4)
 assert.equal(sectionStats(null).people[0][1],0)
})

test('event display preserves partial order and unplaced events, filtering only registered actors',()=>{
 const records=['late','early','unknown'].map(id=>({id,type:'event',payload:{actors:id==='early'?['other']:['person']}}))
 const value={records,timeline:{groups:[{events:['early','late']}],unplaced:['unknown','late','missing']}}
 assert.deepEqual(timelineItems(value).map(r=>r.record.id),['early','late','unknown'])
 assert.deepEqual(timelineItems(value,'person').map(r=>[r.record.id,r.group]),[['late','时间关系组 1'],['unknown','时间待定位']])
 assert.deepEqual(timelineItems(value,'unregistered'),[])
})
