import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { previewCreation, initializeBook, integrity } from '../src/initialize.js'
import { createPlanning } from '../../lg-planning/src/service.js'
import { createMemory } from '../../lg-memory/src/service.js'
import { createContext } from '../../lg-context/src/service.js'
import { readBook } from '../src/read.js'
import { accessState } from '../src/state.js'
import { createDocuments } from '../src/documents.js'
const parent = () => mkdtempSync(join(tmpdir(),'lg-native-book-'))
function setup() {
  const path = join(parent(),'book'), preview = previewCreation(path,'潮汐来信')
  const input = {...preview,operation:randomUUID()};initializeBook(input)
  const docs = createDocuments({readState:(p,fn)=>accessState(p,false,fn),changeState:(p,fn)=>accessState(p,true,fn)})
  const apply = change => {const preview=docs.preview(path,change);return docs.apply(path,change,preview.token,randomUUID())}
  return {path,input,docs,apply}
}
const create = {action:'create',kind:'character',slug:'lin',title:'林澈',content:'守灯人。',reason:'作者建立人物',tags:['主角']}
test('native initialization creates a compatible book and retry preserves edited notes',()=>{
  const {path,input}=setup();assert.equal(integrity(path).ok,true)
  const note=join(path,'ReferenceLibrary/bible/STORY_BIBLE.md')
  writeFileSync(note,'作者修改的提纲')
  const first=initializeBook(input),second=initializeBook(input)
  assert.equal(first.id,second.id);assert.equal(readFileSync(note,'utf8'),'作者修改的提纲')
  assert.throws(()=>initializeBook({...input,operation:randomUUID()}),/其他创建/)
})
test('creation rejects nonempty folders, symlinks and changed previews without overwriting',()=>{
  const root=parent(),path=join(root,'book');mkdirSync(path);writeFileSync(join(path,'keep.txt'),'保留')
  assert.throws(()=>previewCreation(path,'作品'),/完全为空/)
  const link=join(root,'broken');symlinkSync(join(root,'missing'),link)
  assert.throws(()=>previewCreation(link,'作品'),/符号链接/)
  const empty=join(root,'new'),preview=previewCreation(empty,'作品')
  assert.throws(()=>initializeBook({...preview,name:'另一部',operation:randomUUID()}),/重新预览/)
  assert.equal(readFileSync(join(path,'keep.txt'),'utf8'),'保留')
})
test('document candidates, adoption, historical restore and operation replay preserve active versions',()=>{
  const {path,docs,apply}=setup();const made=apply(create),original=docs.read(path,made.id)
  assert.equal(docs.list(path,{tags:['主角']}).total,1)
  const proposed=apply({action:'candidate',id:made.id,expected_token:original.token,content:'守灯人，等待归船。',reason:'候选'})
  assert.equal(docs.read(path,made.id).current.id,original.current.id)
  const change={action:'accept',id:made.id,version:proposed.version,expected_token:original.token,reason:'作者采用'}
  const preview=docs.preview(path,change),operation=randomUUID(),adopted=docs.apply(path,change,preview.token,operation)
  assert.deepEqual(docs.apply(path,change,preview.token,operation),adopted)
  assert.throws(()=>docs.apply(path,{...change,reason:'篡改'},preview.token,operation),/发生变化/)
  let current=docs.read(path,made.id);assert.equal(current.current.content,'守灯人，等待归船。')
  const restored=apply({action:'restore',id:made.id,version:original.current.id,expected_token:current.token,reason:'恢复早稿供审阅'})
  assert.equal(docs.read(path,made.id).current.id,adopted.version)
  apply({action:'accept',id:made.id,version:restored.version,expected_token:current.token,reason:'确认恢复'})
  current=docs.read(path,made.id);assert.equal(current.current.content,'守灯人。');assert.notEqual(current.current.id,original.current.id)
  apply({action:'archive',id:made.id,expected_token:current.token,reason:'归档'})
  assert.equal(docs.list(path).total,0)
  current=docs.read(path,made.id);apply({action:'reopen',id:made.id,expected_token:current.token,reason:'恢复显示'})
  assert.equal(docs.list(path,{state:'accepted'}).total,1)
})
test('stale sources, reserved metadata, managed kinds and model promotion are refused',()=>{
  const {path,docs,apply}=setup();const made=apply(create),original=docs.read(path,made.id)
  const candidate=docs.candidate(path,{action:'candidate',id:made.id,expected_token:original.token,content:'模型草案',reason:'建议'},randomUUID())
  apply({action:'update',id:made.id,expected_token:original.token,title:'林澈的新名',reason:'改名'})
  const current=docs.read(path,made.id)
  assert.throws(()=>apply({action:'accept',id:made.id,version:candidate.version,expected_token:current.token,reason:'采用'}),/来源已变化/)
  assert.throws(()=>docs.candidate(path,{action:'accept'},randomUUID()),/只能保存资料候选/)
  for (const kind of ['chapter','scene','creative_decision','narrative_knowledge']) assert.throws(()=>apply({...create,slug:kind,kind}),/专用入口/)
  assert.throws(()=>apply({...create,slug:'bad',metadata:{required_decision:1}}),/保留字段/)
  accessState(path,true,db=>db.prepare('UPDATE document_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({required_decision:{id:1}}),current.current.id))
  assert.throws(()=>apply({action:'accept',id:made.id,expected_token:current.token,reason:'旧审批'}),/旧审批/)
})

test('new native book supports planning, context and dashboard without legacy initialization',()=>{
  const {path,docs,apply}=setup(),person=apply(create)
  const books={readState:(p,fn)=>accessState(p,false,fn),changeState:(p,fn)=>accessState(p,true,fn)}
  const planning=createPlanning(books),memory=createMemory(books),context=createContext(books,memory,()=>planning)
  const change={action:'structure.create',kind:'chapter',slug:'chapter-1',title:'第一章',sequence:1}
  const preview=planning.preview(path,change),chapter=planning.apply(path,change,preview.token,randomUUID())
  assert.equal(planning.window(path,{chapter_id:chapter.id}).chapters.length,1)
  assert.equal(readBook(path).chapters.length,1)
  const result=context.build(path,{audience:'author',documents:[person.id],maxBytes:4000})
  assert.match(JSON.stringify(result.payload),/守灯人/);assert.equal(context.verify(path,result.receipt),true)
  const current=docs.read(path,person.id)
  apply({action:'edit',id:person.id,expected_token:current.token,content:'已经离开灯塔。',reason:'作者更新'})
  assert.throws(()=>context.verify(path,result.receipt),/已变化/)
})
