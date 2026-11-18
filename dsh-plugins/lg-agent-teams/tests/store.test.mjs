import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {TeamStore} from '../src/store.js'
const setup=(t,limit=100)=>{const directory=mkdtempSync(join(tmpdir(),'lg-team-test-'));const store=new TeamStore(directory,'test',limit);t.after(()=>store.close());return {store,directory}}
const input={role:'analysis',objective:'分析现场',operation:'a',inputs:[],method:true,prompt_hash:'test'}
test('operations are idempotent and dependencies cannot cross sessions or snapshots',t=>{
 const {store}=setup(t);const source_id=store.source('owner',{fingerprint:'one',path:'/fixture'})
 const first=store.createTask('owner',{...input,source_id});assert.equal(first.created,true)
 assert.equal(store.createTask('owner',{...input,source_id}).task.id,first.task.id)
 assert.throws(()=>store.createTask('owner',{...input,source_id,objective:'不同'}),/操作标识/)
 assert.throws(()=>store.createTask('other',{...input,source_id}),/当前会话/)
 assert.throws(()=>store.createTask('owner',{...input,source_id,operation:'b',inputs:[first.task.id]}),/未完成/)
 store.update(first.task.id,{status:'completed',artifact:{summary:'candidate'}})
 assert.equal(store.createTask('owner',{...input,role:'planning',source_id,operation:'b',inputs:[first.task.id]}).created,true)
 const other=store.source('owner',{fingerprint:'two',path:'/fixture'})
 assert.throws(()=>store.createTask('owner',{...input,source_id:other,operation:'c',inputs:[first.task.id]}),/范围不同/)
})
test('two DB connections share an exact request ceiling; failures and unfinished attempts count',t=>{
 const {store,directory}=setup(t,2),second=new TeamStore(directory,'test',2);t.after(()=>second.close())
 store.bind('parent','coordinator','/fixture')
 const first=store.reserve({sessionId:'parent',provider:'mock',model:'mock'})
 store.finish(first.id,{status:'failed',usage:null})
 second.reserve({sessionId:'parent',provider:'mock',model:'mock'})
 assert.throws(()=>store.reserve({sessionId:'parent'}),/耗尽/)
 assert.deepEqual(store.overview().roles[0],{role:'coordinator',requests:2,inputTokens:0,outputTokens:0,tokens:0,knownUsage:0,failed:1,pending:1,requestShare:1,tokenShare:0})
 assert.equal(store.overview().budget.used,2)
})
test('cache tokens and failures are attributed by actual session role, not by parent totals',t=>{
 const {store}=setup(t)
 store.bind('parent','coordinator','/a');store.bind('child','writing','/a','task-x');store.bind('other','analysis','/b','task-y')
 const parent=store.reserve({sessionId:'parent'}),child=store.reserve({sessionId:'child'}),other=store.reserve({sessionId:'other'})
 store.finish(parent.id,{status:'completed',usage:{inputTokens:10,outputTokens:5,cacheReadTokens:20,cacheWriteTokens:2}})
 store.finish(child.id,{status:'completed',usage:{inputTokens:10,outputTokens:53}})
 store.finish(other.id,{status:'failed',usage:null})
 const v=store.overview({path:'/a'});assert.equal(v.tokens,100);assert.equal(v.requests,2);assert.equal(v.roles[0].tokenShare,.37);assert.equal(v.roles[3].tokenShare,.63)
 assert.equal(store.overview().unknownUsage,1);assert.equal(store.overview().requests,3)
 assert.throws(()=>store.finish(child.id,{}),/已结算/)
})
test('result request snapshot includes title and failed member calls, excludes unrelated conversations',t=>{
 const {store}=setup(t);store.bind('owner','coordinator','/book');store.bind('other','coordinator','/book')
 const source_id=store.source('owner',{fingerprint:'one',path:'/book'})
 const {task}=store.createTask('owner',{...input,source_id})
 store.reserve({sessionId:'owner'});store.reserve({sessionId:'owner',purpose:'session-title'})
 const failed=store.reserve({sessionId:task.child});store.finish(failed.id,{status:'failed',usage:null})
 store.reserve({sessionId:'other'})
 const snapshot=store.requestSnapshot('owner')
 assert.equal(snapshot.conversation.requests,3)
 assert.deepEqual(snapshot.conversation.by_role,{coordinator:2,analysis:1,planning:0,writing:0})
 assert.equal(snapshot.budget.used,4);assert.equal(snapshot.budget.remaining,96)
})
test('individual member ceiling and explicit budget closure persist across reopening',t=>{
 const {store,directory}=setup(t);store.bind('child','analysis','/a','one')
 for(let i=0;i<6;i++)store.reserve({sessionId:'child'})
 assert.throws(()=>store.reserve({sessionId:'child'}),/最多 6/)
 store.closeBudget();const reopened=new TeamStore(directory,'test');t.after(()=>reopened.close())
 reopened.bind('main','coordinator','/a');assert.throws(()=>reopened.reserve({sessionId:'main'}),/已关闭/)
 assert.equal(reopened.overview().budget.used,6)
})
test('interactive usage exceeds both old ceilings and leaves closed experiment rows untouched',t=>{
 const {store,directory}=setup(t,1)
 store.bind('owner','coordinator','/book')
 store.reserve({sessionId:'owner'});store.closeBudget()
 const original=store.db.prepare('SELECT * FROM requests').all(),closures=store.db.prepare('SELECT * FROM closures').all()
 const usage=new TeamStore(directory,'interactive-usage',null);t.after(()=>usage.close())
 usage.bind('child','writing','/book','interactive-task')
 for(let i=0;i<120;i++){
  const row=usage.reserve({sessionId:'child'})
  usage.finish(row.id,{status:'completed',usage:{inputTokens:2,outputTokens:1}})
 }
 assert.equal(usage.overview().budget.mode,'usage')
 assert.equal(usage.overview().budget.limit,null)
 assert.equal(usage.overview().budget.used,120)
 assert.equal(usage.overview().budget.closed,false)
 assert.equal(usage.requestSnapshot('child').budget.remaining,null)
 assert.equal(usage.overview().roles.find(r=>r.role==='writing').tokens,360)
 assert.deepEqual(usage.db.prepare('SELECT * FROM requests WHERE budget=?').all('test'),original)
 assert.deepEqual(usage.db.prepare('SELECT * FROM closures').all(),closures)
 assert.throws(()=>store.reserve({sessionId:'owner'}),/已关闭/)
 assert.throws(()=>usage.closeBudget(),/仅计量/)
 usage.close()
 const reopened=new TeamStore(directory,'interactive-usage',null);t.after(()=>reopened.close())
 assert.doesNotThrow(()=>reopened.reserve({sessionId:'child'}))
 assert.equal(reopened.overview().budget.used,121)
})
test('count-only mode must be explicit; invalid numeric caps cannot silently disable limits',t=>{
 const {directory}=setup(t)
 for(const limit of [0,-1,101,Infinity,NaN])assert.throws(()=>new TeamStore(directory,'bad',limit),/请求额度/)
})
test('cold recovery preserves candidates and live work, interrupts only missing activations without replay',t=>{
 const {store,directory}=setup(t),source_id=store.source('owner',{fingerprint:'one',path:'/book'})
 const a=store.createTask('owner',{...input,source_id}).task,b=store.createTask('owner',{...input,source_id,operation:'b'}).task,c=store.createTask('owner',{...input,source_id,operation:'c'}).task
 store.update(a.id,{status:'completed',artifact:{summary:'保留候选'}})
 const reopened=new TeamStore(directory,'test');t.after(()=>reopened.close());reopened.recover(child=>child===c.child)
 assert.equal(reopened.task(a.id).artifact.summary,'保留候选');assert.equal(reopened.task(a.id).status,'completed')
 assert.equal(reopened.task(b.id).status,'interrupted');assert.equal(reopened.task(c.id).status,'starting')
 assert.equal(reopened.createTask('owner',{...input,source_id,operation:'b'}).created,false)
 assert.equal(reopened.overview().budget.used,0)
})
test('another live host cannot take over a task store; normal disposal releases only its own claim',t=>{
 const {store,directory}=setup(t),other=new TeamStore(directory,'test');t.after(()=>other.close())
 store.claimRuntime();assert.throws(()=>other.claimRuntime(),/活跃宿主/)
 store.close();assert.doesNotThrow(()=>other.claimRuntime())
})


test('dashboard archive excludes only chosen stats, preserving requests, snapshots and budget across restart',t=>{
 const {store,directory}=setup(t,2);store.bind('owner','coordinator','/book')
 const old=store.reserve({sessionId:'owner'}),recent=store.reserve({sessionId:'owner'})
 store.finish(old.id,{status:'completed',usage:{inputTokens:100,outputTokens:10}})
 store.finish(recent.id,{status:'completed',usage:{inputTokens:20,outputTokens:5}})
 const original=store.db.prepare('SELECT json FROM requests WHERE id=?').get(old.id).json
 store.db.prepare('INSERT INTO dashboard_archives VALUES(?,?,?)').run(old.id,'legacy-unrecorded-experiment',new Date().toISOString())
 const reopened=new TeamStore(directory,'test',2);t.after(()=>reopened.close())
 const view=reopened.overview({path:'/book'})
 assert.equal(view.requests,1);assert.equal(view.tokens,25)
 assert.deepEqual(view.monitoring.series.map(r=>r.id),[recent.id])
 assert.equal(view.budget.used,2);assert.throws(()=>reopened.reserve({sessionId:'owner'}),/耗尽/)
 assert.equal(reopened.requestSnapshot('owner').conversation.requests,2)
 assert.equal(reopened.db.prepare('SELECT json FROM requests WHERE id=?').get(old.id).json,original)
 assert.equal(reopened.overview({from:'2099-01-01'}).requests,0)
})
