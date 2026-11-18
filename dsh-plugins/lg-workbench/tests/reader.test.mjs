import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readerChapter, readerMessage} from '../src/reader-data.js'

test('reader uses exact selected version and distinguishes books and chapters',()=>{
  const data={document:{id:2,title:'第二章',content:'current'},selected:{id:8,content:'候选\n正文😀'}}
  const payload=readerChapter('/book',data,[{id:1},{id:2}],'作品')
  assert.equal(payload.text,'候选\n正文😀')
  assert.equal(payload.chapterIndex,2)
  assert.notEqual(payload.chapterId,readerChapter('/other',data,[],'').chapterId)
  assert.notEqual(payload.chapterId,readerChapter('/book',{...data,selected:{...data.selected,id:9}},[],'').chapterId)
  assert.deepEqual(Object.keys(payload).sort(),['bookTitle','chapterId','chapterIndex','text','title','type'])
})
test('only the active reader frame may provide readiness or an excerpt; no action forwarding',()=>{
  const frame={}
  assert.equal(readerMessage({source:{},data:{type:'lg-reader:quote',text:'fake'}},frame),null)
  assert.equal(readerMessage({source:frame,data:{type:'lg-reader:write',text:'replace'}},frame),null)
  assert.deepEqual(readerMessage({source:frame,data:{type:'lg-reader:ready'}},frame),{type:'ready'})
  assert.deepEqual(readerMessage({source:frame,data:{type:'lg-reader:quote',text:'摘录'}},frame),{type:'quote',text:'摘录'})
  assert.equal(readerMessage({source:frame,data:{type:'lg-reader:quote',text:{}}},frame),null)
})
