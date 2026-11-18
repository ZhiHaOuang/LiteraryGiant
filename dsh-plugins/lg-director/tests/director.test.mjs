import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,realpathSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {accessState} from '../../lg-books/src/state.js'
import {readManuscript} from '../../lg-books/src/manuscript.js'
import {writeManuscript} from '../../lg-books/src/write.js'
import {createAgents} from '../../lg-agents/src/service.js'
import {Executor} from '../../lg-execution/src/run.js'
import {Ledger} from '../../lg-execution/src/ledger.js'
import {createDirector} from '../src/service.js'
function setup(t,{answer,during}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lg-director-'))),path=join(root,'book');mkdirSync(path);createBook(path).db.close()
 const registered=p=>{assert.equal(p,path,'unregistered book');return p}
 const books={list:()=>[{path}],readState:(p,fn)=>accessState(registered(p),false,fn),changeState:(p,fn)=>accessState(registered(p),true,fn),manuscript:(p,...args)=>readManuscript(registered(p),...args),candidate:(p,input,generation)=>writeManuscript(registered(p),{...input,action:'candidate'},generation)}
 let count=0
 const llm={async prepareCall(){return {config:{},async *stream(options){count++;await during?.(options.signal);options.signal.throwIfAborted();yield {type:'block-end',index:0,block:{type:'text',text:answer??JSON.stringify({replacement:'林澈熄了灯。海风停了。',notes:'合成改稿'})}};yield {type:'usage',usage:{inputTokens:100,outputTokens:50}};yield {type:'finish',reason:{kind:'stop'}}}}}}
 const ledger=new Ledger(join(root,'budget.sqlite3')),config={provider:'fixture',model:'fixture',budgetCny:10,inputCnyPerMillion:1,outputCnyPerMillion:2,maxInputBytes:100000,maxOutputTokens:1024,timeoutMs:1000},execution=new Executor(llm,ledger,config)
 const roles={roles:[]},agents=createAgents(books,{preview:i=>execution.preview(i),run:(...args)=>execution.run(...args),status:id=>ledger.get(id),cancel:id=>execution.cancel(id)},roles),director=createDirector(books,agents),body=books.manuscript(path,1)
 const input={task:'polish',document:1,version:1,token:body.token,start:0,end:body.selected.content.length,request:'简化表达，保持情节。'}
 const propose=(value=input,id=randomUUID())=>director.propose(path,value,id,'fixture-session'),run=id=>director.run(path,id,director.preview(path,id).token)
 const rewrite=fn=>books.changeState(path,db=>{const row=db.prepare('SELECT id,state FROM lg_director_tasks LIMIT 1').get(),s=JSON.parse(row.state);fn(s);db.prepare('UPDATE lg_director_tasks SET state=? WHERE id=?').run(JSON.stringify(s),row.id)})
 t.after(async()=>{await director.dispose();await execution.dispose();ledger.close()})
 return {root,path,books,ledger,execution,roles,agents,director,input,body,propose,run,rewrite,count:()=>count}
}
test('proposals bind existing specialist previews but neither call models nor adopt prose',async t=>{
 const s=setup(t),p=s.propose(),again=s.propose(s.input,p.id)
 assert.deepEqual(again,p);assert.equal(p.status,'proposed');assert.equal(s.count(),0)
 const preview=s.director.preview(s.path,p.id);assert.deepEqual(preview.plan.modelInput,s.agents.preview({...s.input,path:s.path}).modelInput)
 assert.equal(s.books.manuscript(s.path,1).versions.length,s.body.versions.length)
 assert.throws(()=>s.propose({...s.input,request:'换任务'},p.id),/更换/)
 for(const value of [{...s.input,path:s.path},{...s.input,operation:randomUUID()},{...s.input,task:'accept'},{...s.input,signature:'forged'}])assert.throws(()=>s.propose(value),/有界/)
 assert.equal(s.director.list(s.path).items.length,1)
})
test('native scope stays inside registered book; source is bounded and marks truncation',t=>{
 const s=setup(t);mkdirSync(join(s.path,'nested'));assert.equal(s.director.forDirectory(join(s.path,'nested')),s.path)
 assert.throws(()=>s.director.forDirectory(s.root),/工作目录/)
 symlinkSync(s.root,join(s.path,'escape'));assert.throws(()=>s.director.forDirectory(join(s.path,'escape')),/工作目录/)
 const value=s.director.source(s.path,1,1,0,2);assert.equal(value.text,s.body.selected.content.slice(0,2));assert.equal(value.truncated,true)
 assert.equal(value.document.content,undefined);assert.equal(value.length,s.body.selected.content.length)
 assert.throws(()=>s.director.source(s.path,1,1,-1,2));assert.throws(()=>s.director.source('/other',1,1))
 s.books.changeState(s.path,db=>db.prepare('UPDATE document_versions SET content=? WHERE id=1').run('甲😀乙'))
 assert.throws(()=>s.director.source(s.path,1,1,0,2),/范围/)
})
test('wrong approval, changed text and disabled specialist refuse dispatch without charging',async t=>{
 const s=setup(t),p=s.propose(),preview=s.director.preview(s.path,p.id)
 await assert.rejects(s.director.run(s.path,p.id,'forged'),/预览/);assert.equal(s.count(),0)
 s.roles.roles=[{id:'manuscript-editor',enabled:false}]
 assert.throws(()=>s.director.preview(s.path,p.id),/角色|停用/);s.roles.roles=[]
 s.books.changeState(s.path,db=>db.prepare('UPDATE document_versions SET content=? WHERE id=1').run('作者改了正文。'))
 await assert.rejects(s.director.run(s.path,p.id,preview.token),/变化/);assert.equal(s.count(),0)
 assert.equal(s.director.read(s.path,p.id).status,'proposed')
})
test('concurrent author dispatch and cross-instance repeats share one specialist call and candidate',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),s=setup(t,{during:()=>gate}),p=s.propose(),preview=s.director.preview(s.path,p.id)
 const first=s.director.run(s.path,p.id,preview.token),second=s.director.run(s.path,p.id,preview.token)
 await new Promise(resolve=>setImmediate(resolve))
 const other=createDirector(s.books,s.agents);t.after(()=>other.dispose())
 assert.equal((await other.run(s.path,p.id,preview.token)).status,'running');assert.equal(s.count(),1)
 release();const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);assert.equal(a.status,'completed')
 assert.deepEqual(await other.run(s.path,p.id,preview.token),a);assert.equal(s.count(),1)
 assert.equal(s.books.manuscript(s.path,1).document.activeVersion,1);assert.equal(s.books.manuscript(s.path,1,a.result.candidate.version).selected.state,'candidate')
})
test('restart restores original successful result without another call even after persistence interruption',async t=>{
 const s=setup(t),p=s.propose(),value=await s.run(p.id),candidate=value.result.candidate.version
 s.rewrite(state=>{state.status='running';delete state.result})
 const other=createDirector(s.books,s.agents);t.after(()=>other.dispose())
 const recovered=await other.recover(s.path,p.id);assert.equal(recovered.result.candidate.version,candidate);assert.equal(s.count(),1)
 assert.deepEqual(await other.recover(s.path,p.id),recovered)
})
test('missing and reserved call outcomes remain inspect-only; recover never dispatches them',async t=>{
 const s=setup(t),p=s.propose();s.rewrite(state=>state.status='running')
 assert.match((await s.director.recover(s.path,p.id)).recoveryMessage,/不重新/);assert.equal(s.count(),0)
 const input=s.agents.preview({...s.input,path:s.path}).modelInput,plan=s.execution.preview(input)
 s.ledger.reserve('director-'+p.id,plan.request,plan.micros,10000000)
 assert.match((await s.director.recover(s.path,p.id)).recoveryMessage,/不重新/);assert.equal(s.count(),0)
 assert.equal((await s.director.run(s.path,p.id,'ignored')).status,'running');assert.equal(s.count(),0)
})
test('author dismissal cannot dispatch or recover and records the exact reason',async t=>{
 const s=setup(t),p=s.propose(),preview=s.director.preview(s.path,p.id)
 assert.throws(()=>s.director.stop(s.path,p.id,'stale','不做此任务'),/变化/)
 const value=s.director.stop(s.path,p.id,p.token,'范围不符合要求');assert.equal(value.status,'dismissed');assert.equal(value.reason,'范围不符合要求')
 assert.equal((await s.director.run(s.path,p.id,preview.token)).status,'dismissed');assert.equal((await s.director.recover(s.path,p.id)).status,'dismissed');assert.equal(s.count(),0)
})
test('author cancellation and plugin disposal stop in-flight calls and preserve reservations',async t=>{
 for(const dispose of [false,true]){
  const s=setup(t,{during:signal=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))}),p=s.propose(),pending=s.run(p.id)
  await new Promise(resolve=>setImmediate(resolve))
  if(dispose)await s.director.dispose()
  else{s.director.stop(s.path,p.id,s.director.read(s.path,p.id).token,'停止这次合成任务')}
  const result=await pending;assert.equal(result.status,'stopped');assert.equal(result.result.run.status,'cancelled');assert.equal(s.count(),1)
  assert.ok(result.result.run.reservedCny>0);assert.equal(s.books.manuscript(s.path,1).versions.length,s.body.versions.length)
  if(dispose)assert.throws(()=>s.director.run(s.path,p.id,'x'),/停用/)
  else{await s.director.recover(s.path,p.id);assert.equal(s.count(),1)}
 }
})
test('invalid model output is retained and recovery never makes a second paid attempt',async t=>{
 const s=setup(t,{answer:'invalid'}),p=s.propose(),result=await s.run(p.id)
 assert.equal(result.status,'stopped');assert.equal(result.result.status,'invalid-output')
 assert.equal((await s.director.recover(s.path,p.id)).result.status,'invalid-output');assert.equal(s.count(),1)
 assert.equal(s.books.manuscript(s.path,1).versions.length,s.body.versions.length)
})
test('an author can inspect and dismiss a saved proposal after losing local execution configuration',async t=>{
 const s=setup(t),p=s.propose(),unused=()=>{throw new Error('本机账本不可用')}
 const offline=createDirector(s.books,{...s.agents,status:unused,cancel:unused})
 t.after(()=>offline.dispose())
 const seen=offline.read(s.path,p.id);assert.equal(seen.callError,'本机账本不可用');assert.equal(seen.token,p.token)
 assert.equal(offline.stop(s.path,p.id,seen.token,'作者驳回').status,'dismissed')
 assert.equal((await offline.recover(s.path,p.id)).status,'dismissed');assert.equal(s.count(),0)
})
test('catalog reflects enabled capabilities and proposal ids cannot cross book registrations',t=>{
 const s=setup(t),p=s.propose();assert.ok(s.director.catalog().some(item=>item.task==='draft-chapter'))
 assert.ok(!s.director.catalog().some(item=>item.task==='extract-memory'))
 s.roles.roles=[{id:'chapter-writer',enabled:false}];assert.ok(!s.director.catalog().some(item=>item.task==='draft-chapter'))
 assert.throws(()=>s.director.read('/other',p.id));assert.throws(()=>s.director.propose('/other',s.input,randomUUID()))
 assert.throws(()=>s.director.list(s.path,-1),/分页/)
})
