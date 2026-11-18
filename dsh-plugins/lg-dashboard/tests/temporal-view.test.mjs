import test from 'node:test'
import assert from 'node:assert/strict'
import {formatStoryTime,temporalOptions,pageSlice} from '../src/temporal-view-model.js'

test('a textual day label remains explicitly unknown rather than parsed into a time coordinate',()=>{
 assert.equal(formatStoryTime({kind:'unknown',label:'第 3 天早晨'}),'第 3 天早晨 · 发生时间未确定')
 assert.equal(formatStoryTime({kind:'relative',after_event:'arrival',label:''}),'相对事件时间')
})
test('coordinate and relative offset preserve recorded uncertainty, origin and units',()=>{
 assert.equal(formatStoryTime({kind:'range',coordinate:{axis:'arrival',unit:'day',start_min:2,start_max:4,end_min:5,end_max:5}}),'时间轴「arrival」：开始 2–4，结束 5 天')
 assert.equal(formatStoryTime({kind:'relative',offset:{anchor_event:'injury',anchor_point:'end',min:2,max:3,unit:'hour'}}),'相对 injury 的结束：2–3 小时')
})
test('candidate data requires an explicit boolean opt-in, cutoff remains a reading condition',()=>{
 assert.deepEqual(temporalOptions(),{phase:'after',include_candidates:false})
 assert.deepEqual(temporalOptions({subject:'person:lin',event:'event:injury',phase:'before',through:'3',includeCandidates:true}),{phase:'before',include_candidates:true,subject:'person:lin',event:'event:injury',through_chapter:3})
 assert.equal(temporalOptions({includeCandidates:'true'}).include_candidates,false)
})
test('relative anchors use the visible event title while preserving the recorded uncertainty',()=>{
 const time={kind:'relative',offset:{anchor_event:'event:injury',anchor_point:'end',min:2,max:3,unit:'day'}}
 assert.equal(formatStoryTime(time,{'event:injury':{title:'林澈摔伤'}}),'相对 林澈摔伤 的结束：2–3 天')
})
test('bounded lists do not drop records when a filter reduces the available pages',()=>{
 const all=Array.from({length:29},(_,i)=>i)
 assert.deepEqual([0,1,2].flatMap(p=>pageSlice(all,p).items),all)
 assert.deepEqual(pageSlice(all.slice(0,3),2),{items:[0,1,2],page:0,pages:1,total:3})
 assert.deepEqual(pageSlice([],99),{items:[],page:0,pages:1,total:0})
})
