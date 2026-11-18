import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { readManuscript } from '../../lg-books/src/manuscript.js'
import { writeManuscript } from '../../lg-books/src/write.js'
import { createAuthor } from '../src/service.js'
import { createAgents } from '../../lg-agents/src/service.js'
import { Executor } from '../../lg-execution/src/run.js'

function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'lg-author-')),path=join(root,'book'),other=join(root,'other');mkdirSync(path);mkdirSync(other);createBook(path).db.close();createBook(other).db.close()
  const books={readState:(p,fn)=>{assert.ok([path,other].includes(p));return accessState(p,false,fn)},changeState:(p,fn)=>{assert.ok([path,other].includes(p));return accessState(p,true,fn)},manuscript:readManuscript,candidate:(p,i,g)=>writeManuscript(p,{...i,action:'candidate'},g)}
  const storage=join(root,'preferences.sqlite3'),legacyPersonal=join(root,'legacy-personal.json'),author=createAuthor(books,storage,legacyPersonal)
  t.after(()=>author.close())
  const apply=(scope,values,book=path)=>{const change={scope,values};return author.apply(book,change,author.preview(book,change).token,randomUUID())}
  return {root,path,other,books,author,storage,legacyPersonal,apply}
}
test('profile defaults, per-book override, explicit empty preference and restored inheritance stay distinct',t=>{
  const s=setup(t)
  assert.deepEqual(s.author.read(s.path).effective,{name:'作者',detail:'balanced',writing:'',writingScope:'personal'})
  s.apply('personal',{name:'星桥',detail:'concise',writing:'偏好短句。'})
  assert.equal(s.author.read(s.other).effective.writing,'偏好短句。')
  s.apply('book',{writing:'本书允许长句。'});assert.equal(s.author.read(s.path).effective.writingScope,'book')
  assert.equal(s.author.read(s.other).effective.writingScope,'personal')
  s.apply('book',{writing:''});assert.equal(s.author.read(s.path).effective.writing,'')
  s.apply('book',{});assert.equal(s.author.read(s.path).effective.writing,'偏好短句。')
  assert.equal(statSync(s.storage).mode&0o777,0o600)
})
test('legacy personal and book fields read without rewriting; native settings take precedence thereafter',t=>{
  const s=setup(t),local=join(s.path,'.literarygiant/preferences.json')
  const old=JSON.stringify({name:'旧称呼',detail:'detailed',writing:'旧个人偏好',ignored:'not imported'}),book=JSON.stringify({writing:'旧本书偏好',name:'ignored name'})
  writeFileSync(s.legacyPersonal,old);writeFileSync(local,book)
  const value=s.author.read(s.path);assert.equal(value.personal.source,'legacy');assert.equal(value.book.source,'legacy');assert.equal(value.effective.name,'旧称呼');assert.equal(value.effective.writing,'旧本书偏好')
  s.apply('personal',{name:'新称呼',detail:'balanced',writing:'新个人偏好'});s.apply('book',{})
  assert.equal(readFileSync(s.legacyPersonal,'utf8'),old);assert.equal(readFileSync(local,'utf8'),book)
  assert.equal(s.author.read(s.path).effective.writing,'新个人偏好')
  writeFileSync(local,'malformed');assert.equal(s.author.read(s.path).book.source,'native')
})
test('malformed, oversized or symbolic legacy files fail rather than silently importing unrelated data',t=>{
  const s=setup(t)
  writeFileSync(s.legacyPersonal,'invalid');assert.throws(()=>s.author.read(s.path),/旧偏好/)
  writeFileSync(s.legacyPersonal,JSON.stringify({writing:'x'.repeat(16001)}));assert.throws(()=>s.author.read(s.path),/16000/)
  const linked=join(s.root,'linked.json');symlinkSync(s.legacyPersonal,linked)
  const alternate=createAuthor(s.books,join(s.root,'alternate.sqlite3'),linked);t.after(()=>alternate.close())
  assert.throws(()=>alternate.read(s.path),/符号链接/)
})
test('saved operations replay across restart, stale saves fail and failed transactions preserve previous preferences',t=>{
  const s=setup(t),change={scope:'personal',values:{writing:'偏好短句'}},preview=s.author.preview(s.path,change),operation=randomUUID()
  const second=createAuthor(s.books,s.storage,s.legacyPersonal);t.after(()=>second.close())
  const saved=s.author.apply(s.path,change,preview.token,operation)
  assert.deepEqual(second.apply(s.path,change,preview.token,operation),saved)
  assert.throws(()=>second.apply(s.path,change,preview.token,randomUUID()),/已变化/)
  assert.throws(()=>second.apply(s.path,{...change,values:{writing:'新内容'}},preview.token,operation),/更换/)
  assert.equal(second.history(s.path,'personal').items.length,1)
  const book={scope:'book',values:{writing:'书内偏好'}},p=s.author.preview(s.path,book)
  s.books.changeState(s.path,db=>db.exec("CREATE TABLE lg_author_actions(id TEXT PRIMARY KEY,signature TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TRIGGER author_fail BEFORE INSERT ON lg_author_actions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"))
  assert.throws(()=>s.author.apply(s.path,book,p.token,randomUUID()),/synthetic failure/)
  assert.equal(s.author.read(s.path).book.source,'default')
})
test('legacy edits invalidate previews; unsupported fields and cross-book writes are rejected',t=>{
  const s=setup(t),change={scope:'book',values:{writing:'新偏好'}},p=s.author.preview(s.path,change)
  writeFileSync(join(s.path,'.literarygiant/preferences.json'),JSON.stringify({writing:'外部更新'}))
  assert.throws(()=>s.author.apply(s.path,change,p.token,randomUUID()),/已变化/)
  for(const value of [{scope:'book',values:{name:'不能覆盖称呼'}},{scope:'personal',values:{detail:'huge'}},{scope:'personal',values:{budget:10}},{scope:'unknown',values:{}}])assert.throws(()=>s.author.preview(s.path,value))
  assert.throws(()=>s.author.preview('unregistered',change))
})
function agentsFor(s) {
  let count=0;const runs=new Map(),preview=new Executor(null,null,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:2,maxOutputTokens:1024,maxInputBytes:100000})
  const execution={preview:input=>preview.preview(input),status:id=>runs.get(id),async run(id,input){if(runs.has(id))return runs.get(id);count++;const result={id,status:'succeeded',request:input,result:{text:JSON.stringify({replacement:'林澈熄了灯。海风停了。',notes:'星桥，已简化表达。'})}};runs.set(id,result);return result}}
  const agents=createAgents(s.books,execution,{roles:[]},undefined,undefined,undefined,undefined,undefined,()=>s.author),body=s.books.manuscript(s.path,1)
  const input={task:'polish',path:s.path,document:1,version:1,token:body.token,start:0,end:body.selected.content.length,request:'简化表达',operation:randomUUID()}
  return {agents,execution,input,count:()=>count}
}
test('effective preferences appear once in actual model input, cost, signature and candidate metadata',async t=>{
  const s=setup(t);s.apply('personal',{name:'星桥',detail:'concise',writing:'短句'});s.apply('book',{writing:'保留原有叙述视角'})
  const a=agentsFor(s),plan=a.agents.preview(a.input),payload=JSON.parse(plan.modelInput.input)
  assert.deepEqual(payload.authorPreferences,{name:'星桥',detail:'concise',writing:'保留原有叙述视角'})
  assert.equal(plan.inputBytes,Buffer.byteLength(plan.modelInput.system+plan.modelInput.input));assert.match(plan.modelInput.system,/单次 request 优先/)
  const result=await a.agents.run({...a.input,signature:plan.signature});assert.equal(result.status,'candidate-ready');assert.equal(a.count(),1)
  assert.deepEqual(result.run.request,plan.modelInput)
  const version=s.books.manuscript(s.path,1,result.candidate.version).selected
  assert.deepEqual(version.metadata.generation.authorPreferences,plan.authorPreferences)
  assert.equal(s.books.manuscript(s.path,1).document.activeVersion,1)
})
test('preference changes reject a stale task before dispatch; disabling the optional plugin preserves old standalone behavior',async t=>{
  const s=setup(t),a=agentsFor(s),plan=a.agents.preview(a.input)
  s.apply('personal',{writing:'新的偏好'})
  await assert.rejects(a.agents.run({...a.input,signature:plan.signature}),/已变化/);assert.equal(a.count(),0)
  const standalone=createAgents(s.books,a.execution,{roles:[]}),plain=standalone.preview(a.input)
  assert.equal(JSON.parse(plain.modelInput.input).authorPreferences,undefined)
  assert.notEqual(plain.signature,a.agents.preview(a.input).signature)
})
test('writing preferences are excluded from factual extraction and reference analysis materials',t=>{
  const s=setup(t);s.apply('personal',{name:'星桥',detail:'detailed',writing:'夸大戏剧冲突'})
  for(const task of ['extract-memory','analyze-reference'])assert.deepEqual(s.author.material(s.path,task).values,{name:'星桥',detail:'detailed'})
  for(const task of ['polish','ideas','scene-plan','draft-scene','draft-chapter','review','manuscript-review','plan-review'])assert.equal(s.author.material(s.path,task).values.writing,'夸大戏剧冲突')
})
test('default preferences add no input bytes or signature changes; irrelevant book settings do not block extraction',t=>{
  const s=setup(t),a=agentsFor(s),plain=createAgents(s.books,a.execution,{roles:[]}).preview(a.input),withAuthor=a.agents.preview(a.input)
  assert.deepEqual(withAuthor.modelInput,plain.modelInput);assert.equal(withAuthor.signature,plain.signature);assert.equal(withAuthor.inputBytes,plain.inputBytes)
  writeFileSync(join(s.path,'.literarygiant/preferences.json'),'invalid')
  assert.equal(s.author.material(s.path,'extract-memory'),undefined)
  assert.throws(()=>s.author.material(s.path,'polish'),/旧偏好/)
})

test('whole-chapter generation sends effective writing preferences in the previewed model request',async t=>{
  const s=setup(t);s.apply('personal',{name:'星桥',detail:'concise',writing:'整章使用第三人称，保留留白。'})
  const a=agentsFor(s),input={...a.input,task:'draft-chapter',role:'chapter-writer',request:'生成完整章节'},plan=a.agents.preview(input)
  assert.equal(JSON.parse(plan.modelInput.input).authorPreferences.writing,'整章使用第三人称，保留留白。')
  const result=await a.agents.run({...input,signature:plan.signature})
  assert.equal(result.status,'candidate-ready');assert.equal(a.count(),1);assert.deepEqual(result.run.request,plan.modelInput)
  assert.equal(s.books.manuscript(s.path,1).document.activeVersion,1)
})
