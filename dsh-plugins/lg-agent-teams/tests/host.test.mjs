import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {Context,Service} from '@deepseek-ai/cordis'
import {native,hostBaseUrl} from './runtime.mjs'
const {LlmAdapter,createUserMessage} = await native('dsh-llm')
const {mountAgentLoopTestDependencies} = await native('dsh-agent-loop-testkit')
const {default:AgentLoop} = await native('dsh-agent-loop')
const {default:SubagentRuntime} = await native('dsh-subagent')
const Spawn = await native('dsh-subagent-spawn-in-process')
const Persistence = await native('dsh-session-persistence-jsonl')
import * as plugin from '../index.js'
import * as presets from '../presets/index.js'
import {mainPresetTools,memberTools,presetPrompt} from '../presets/roles.js'

class Directory extends Service {
 directories=new WeakMap()
 constructor(ctx){super(ctx,'workingDirectory')}
 get(session){return this.directories.get(session)??session.header.cwd}
 async ensure(agent){return this.get(agent.session)}
 async set(agent,path){this.directories.set(agent.session,path);return path}
}
function chunks(name,args,id){return [
 {type:'block-start',index:0,blockType:'tool-call'},
 {type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)},
 {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}},
 {type:'usage',usage:{inputTokens:10,outputTokens:5,cacheReadTokens:3}},
 {type:'finish',reason:{kind:'tool-calls'}},
]}
const answer=text=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text},{type:'block-end',index:0,block:{type:'text',text}},{type:'usage',usage:{inputTokens:10,outputTokens:5}},{type:'finish',reason:{kind:'stop'}}]
const analysis={summary:'她的认知与世界状态须分开',findings:[{kind:'observation',category:'knowledge',claim:'她相信守卫仍在桥上',evidence:[{chapter:1,paragraph:1,quote:'她以为守卫仍在桥上'}]}],unknowns:['守卫真实位置']}
const planning={summary:'用脚印引导行动',alternatives:[{id:'a',title:'门下',premise:'她发现新脚印',beats:['她放轻脚步靠近门缝'],tradeoffs:['保持身份未知']}],constraints:['不揭露身份'],open_questions:[]}
const writing={summary:'场景候选',text:'她收住了脚步。门缝外，一行湿脚印通向墙根。',checks:['不揭露身份'],open_questions:[]}

async function harness(t,mode='team',limit=100,selected,budgetMode='limited',profile=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lg-team-host-'))),ctx=new Context(),db=new DatabaseSync(':memory:')
 db.exec(`CREATE TABLE project_meta(key TEXT,value TEXT);INSERT INTO project_meta VALUES('project_id','fixture');
 CREATE TABLE documents(id INTEGER,kind TEXT,state TEXT,sequence INTEGER,active_version_id INTEGER,title TEXT);
 CREATE TABLE document_versions(id INTEGER,document_id INTEGER,content TEXT);
 INSERT INTO documents VALUES(1,'chapter','draft',1,1,'第一章');INSERT INTO documents VALUES(2,'chapter','draft',2,2,'不得读取的后文');
 INSERT INTO document_versions VALUES(1,1,'城门已经关闭。她以为守卫仍在桥上。');INSERT INTO document_versions VALUES(2,2,'未来秘密：守卫是她父亲。');`)
 await mountAgentLoopTestDependencies(ctx)
 await ctx.plugin(Directory)
 await ctx.plugin(Persistence,{root:join(root,'sessions')})
 await ctx.plugin(AgentLoop,{agents:[]})
 if(selected){
  ctx.baseUrl=hostBaseUrl
  const {default:Loader}=await native('cordis-plugin-loader'),{default:Group}=await native('cordis-plugin-group')
  await ctx.plugin(Loader);ctx.loader.builtins.group=Group
  for(const name of ['dsh-token-meter','dsh-commands','dsh-user-questions','dsh-agent-preset-registry']){
   const {default:service}=await native(name)
   await ctx.plugin(service,name==='dsh-agent-preset-registry'?{default:'standard'}:{})
  }
  await ctx.agentPresets.register({id:'standard',name:'Fixture Standard',plugins:[]})
 }
 await ctx.plugin(SubagentRuntime)
 await ctx.plugin(Spawn,{providerName:'spawn'})
 ctx.provide('literaryBooks',{list:()=>[{path:root,name:'合成作品'}],readState:(_path,fn)=>fn(db),storyData:()=>({total:0,records:[]})})
 ctx.tools.register({name:'shell',description:'forbidden fixture',parameters:{type:'object',properties:{}},output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute(){throw Error('unreachable shell')}})
 ctx.systemPrompt.section({name:'tool-fixture',order:3000,text:'Independent tool guidance retained.'})
 if(profile)ctx.provide('profileContext',{dir:root,name:'fixture'})
 const fork=ctx.plugin(plugin,{stateDirectory:join(root,'state'),budgetId:'offline',...budgetMode?{budgetMode}:{},requestLimit:limit,methods:true,activation:selected?'preset':'registered-book'})
 await fork
 if(selected){
  await ctx.plugin(presets)
  const roster=await ctx.agentPresets.list()
  assert.equal(roster.length,5)
  for(const row of roster)assert.ok(!row.broken,JSON.stringify(row))
 }
 const requests=[],results=[],stages=new Map();let main=0
 class Adapter extends LlmAdapter{
  async resolveModel(provider,model){return {provider,id:model,name:model,reasoning:{defaultEffort:'off',efforts:[{id:'off',name:'Off'}]}}}
  async *stream(options){
   requests.push(options)
   if(requests.length>30)throw Error('Fixture runaway')
   const task=ctx.literaryTeams.store.taskForChild(options.sessionId)
   let response
   if(task){
    const step=stages.get(task.id)??0;stages.set(task.id,step+1)
    if(step===0)response=chunks('lg_team_context',{},'c'+requests.length)
    else if(mode==='adversarial'&&task.role==='analysis'&&step===1)response=chunks('shell',{},'c'+requests.length)
    else if(mode==='adversarial'&&task.role==='analysis'&&step===2){const bad=structuredClone(analysis);bad.findings[0].evidence[0].quote='这是凭空编造的句子';response=chunks('lg_analysis_submit',bad,'c'+requests.length)}
    else response=chunks('lg_'+task.role+'_submit',{analysis,planning,writing}[task.role],'c'+requests.length)
   }else if(['direct','blank','late-book'].includes(mode))response=answer('这是直接讨论，无需成员。')
   else if(mode==='source'||mode==='stale'){
    if(main++===0)response=chunks('lg_team_prepare',{chapters:[1],through_chapter:1,brief:'直接核对她知道什么。'},'c'+requests.length)
    else if(main===2){
     if(mode==='stale')db.exec("UPDATE document_versions SET content='原文已被作者修改' WHERE id=1")
     response=chunks('lg_team_source',{source_id:results.find(r=>r.name==='lg_team_prepare').value.source_id},'c'+requests.length)
    }else response=answer('她相信守卫仍在桥上，这不等于守卫的真实位置。')
   }
   else{
    const tasks=ctx.literaryTeams.store.tasks(options.sessionId)
    const source=results.find(r=>r.name==='lg_team_prepare')?.value?.source_id
    const step=main++
    if(step===0)response=chunks('lg_team_prepare',{chapters:[1],through_chapter:1,brief:'保持身份未知，分析后规划并试写候选。'},'c'+requests.length)
    else if([1,3,5].includes(step)){
     const role=['analysis','planning','writing'][(step-1)/2]
     response=chunks('lg_team_delegate',{role,source_id:source,objective:'保持身份未知并完成'+role,inputs:tasks.filter(t=>t.status==='completed').map(t=>t.id),operation:role},'c'+requests.length)
    }else if([2,4,6].includes(step))response=chunks('lg_team_result',{task_id:tasks.at(-1).id},'c'+requests.length)
    else response=answer('分析、规划与候选正文已返回，等待作者判断。')
   }
   yield* response
  }
 }
 ctx.llm.registerAdapter(['fixture'],new Adapter())
 ctx.on('tools/result',(exec,result)=>results.push({name:exec.name,isError:result.isError,value:result.value,content:result.content,session:exec.agent?.id}))
 const handle=await ctx.agents.create({sessionId:'main',meta:{cwd:mode==='late-book'?tmpdir():root,...selected?{agentPreset:selected}:{}},agentOptions:{provider:'fixture',model:'fixture',reasoningEffort:'off'},...selected?{setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,selected)}}:{}})
 t.after(async()=>{await ctx.subagents.drainDescendants([handle.agent]);await handle.dispose();await ctx.fiber.dispose();db.close()})
 if(mode==='blank')return {ctx,db,requests,results,handle,root}
 if(mode==='late-book')await ctx.workingDirectory.set(handle.agent,root)
 handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:mode==='direct'?'讨论一下这个想法':'分析第一章，规划一个方向，试写候选。'}]}))
 await handle.agent.whenIdle()
 while(await ctx.subagents.waitForTreeWork(handle.agent))await handle.agent.whenIdle()
 await handle.agent.whenIdle()
 if(!requests.length&&selected!=='lg-analysis')assert.fail(JSON.stringify(handle.agent.session.snapshotEvents().filter(e=>e.type==='turn/end'||e.type==='diagnostic')))
 return {ctx,db,requests,results,handle,root}
}

test('native DSH loop: analysis → planning → writing, automatic reports, scoped context and usage',{timeout:15000},async t=>{
 const h=await harness(t),tasks=h.ctx.literaryTeams.store.tasks('main')
 assert.equal(tasks.length,3);assert.deepEqual(tasks.map(t=>t.status),['completed','completed','completed'],JSON.stringify({tasks:tasks.map(t=>({role:t.role,error:t.error})),errors:h.results.filter(r=>r.isError)}))
 assert.deepEqual(tasks.at(-1).artifact,writing)
 assert.equal(h.results.filter(r=>r.isError).length,0,JSON.stringify(h.results.filter(r=>r.isError)))
 for(const request of h.requests){
  assert.ok(!JSON.stringify(request).includes('守卫是她父亲'))
  assert.ok(!request.tools.some(t=>t.name==='shell'))
  assert.ok(JSON.stringify(request).includes('Independent tool guidance retained.'))
 }
 const ctxs=h.results.filter(r=>r.name==='lg_team_context').map(r=>r.value)
 assert.equal(ctxs[1].inputs[0].artifact.summary,analysis.summary)
 assert.equal(ctxs[2].inputs[1].artifact.summary,planning.summary)
 assert.ok(h.requests.filter(r=>r.sessionId==='main').some(r=>JSON.stringify(r.messages).includes(writing.text)))
 const usage=h.ctx.literaryTeams.overview();assert.equal(usage.requests,h.requests.length);assert.equal(usage.roles[1].requests,2);assert.equal(usage.roles[2].requests,2);assert.equal(usage.roles[3].requests,2)
 const recorded=usage.monitoring.series
 assert.equal(recorded.length,h.requests.length)
 for(const row of recorded){
  assert.equal(row.telemetry.context.version,1)
  assert.ok(row.telemetry.context.turn>=1)
  assert.ok(row.telemetry.context.step>=1)
  assert.ok(row.telemetry.context.tokens.system>0)
  assert.ok(row.telemetry.context.items.schemas>0)
  assert.ok(!JSON.stringify(row.telemetry).includes('保持身份未知'))
 }
 assert.ok(recorded.some(row=>row.telemetry.calledTools.includes('lg_team_result')))
 assert.ok(recorded.some(row=>row.telemetry.context.tokens.tool>0))
 const snapshot=h.results.filter(r=>r.name==='lg_team_result').at(-1).value.request_snapshot
 assert.equal(snapshot.conversation.requests,h.requests.length-1)
 assert.deepEqual(snapshot.conversation.by_role,{coordinator:7,analysis:2,planning:2,writing:2})
 assert.equal(snapshot.budget.used,h.requests.length-1)
 assert.equal(snapshot.budget.remaining,100-snapshot.budget.used)
 assert.match(snapshot.scope,/不包含此后/)
})
test('member shell and fabricated evidence fail inside the real executor, then valid candidate succeeds',{timeout:15000},async t=>{
 const h=await harness(t,'adversarial')
 assert.equal(h.ctx.literaryTeams.store.tasks('main').filter(t=>t.status==='completed').length,3)
 assert.equal(h.results.filter(r=>r.isError).length,2)
 assert.equal(h.results.find(r=>r.name==='shell').isError,true)
 assert.match(JSON.stringify(h.results.find(r=>r.name==='lg_analysis_submit'&&r.isError)),/引文/)
})
test('simple discussion runs in main agent without forced delegation',{timeout:10000},async t=>{
 const h=await harness(t,'direct');assert.equal(h.requests.length,1);assert.equal(h.ctx.literaryTeams.store.tasks('main').length,0)
})
test('actual DSH loop stops before the fourth adapter request when the shared ceiling is three',{timeout:15000},async t=>{
 const h=await harness(t,'team',3)
 assert.equal(h.requests.length,3);assert.equal(h.ctx.literaryTeams.overview().budget.used,3)
 assert.equal(h.ctx.literaryTeams.store.tasks('main')[0].status,'failed')
 const ending=h.handle.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end')
 assert.equal(ending.data.reason.kind,'error');assert.match(JSON.stringify(ending),/额度已耗尽/)
})

test('four native presets load and spawn independent role scopes through the real registry',{timeout:15000},async t=>{
 const h=await harness(t,'adversarial',100,'lg'),tasks=h.ctx.literaryTeams.store.tasks('main')
 assert.deepEqual(tasks.map(t=>t.status),['completed','completed','completed'])
 assert.deepEqual(tasks.map(t=>t.preset),['lg-analysis','lg-planning','lg-writing'])
 assert.ok(tasks.every(t=>t.method===false))
 assert.equal(h.ctx.agentPresets.composedPreset(h.handle.agent.ctx),'lg')
 for(const request of h.requests){
  const task=tasks.find(t=>t.child===request.sessionId),allowed=task?memberTools(task.role):mainPresetTools
  assert.deepEqual(request.tools.map(t=>t.name).sort(),[...allowed].sort())
  assert.ok(!JSON.stringify(request).includes('守卫是她父亲'))
  assert.ok(JSON.stringify(request).includes('Independent tool guidance retained.'))
  assert.ok(JSON.stringify(request).includes(presetPrompt(task?.role??'coordinator').split('\n')[0]))
  if(task)assert.ok(!JSON.stringify(request).includes(presetPrompt('coordinator').split('\n')[0]))
 }
 assert.equal(h.results.find(r=>r.name==='shell').isError,true)
 assert.equal(h.ctx.literaryTeams.overview().requests,h.requests.length)
 assert.equal(h.ctx.literaryTeams.catalog()[0].preset,'lg-analysis')
})
test('LG main reads frozen paragraphs directly without creating members',{timeout:10000},async t=>{
 const h=await harness(t,'source',100,'lg')
 assert.equal(h.requests.length,3)
 assert.equal(h.ctx.literaryTeams.store.tasks('main').length,0)
 const result=h.results.find(r=>r.name==='lg_team_source')
 assert.equal(result.isError,false)
 assert.equal(result.value.chapters[0].paragraphs[0].paragraph,1)
 assert.ok(result.value.chapters[0].paragraphs[0].text.includes('她以为'))
 assert.equal(result.value.chapters.length,1)
 assert.equal(result.value.path,undefined)
 assert.equal(h.ctx.literaryTeams.overview().requests,3)
})
test('new main source tool rejects stale frozen content',{timeout:10000},async t=>{
 const h=await harness(t,'stale',100,'lg')
 assert.equal(h.results.find(r=>r.name==='lg_team_source').isError,true)
})
test('ordinary Standard keeps its native scope and bypasses LG request accounting',{timeout:10000},async t=>{
 const h=await harness(t,'direct',100,'standard')
 assert.ok(h.requests[0].tools.some(t=>t.name==='shell'))
 assert.ok(!JSON.stringify(h.requests[0]).includes('你是 LiteraryGiant'))
 assert.equal(h.ctx.literaryTeams.overview().requests,0)
 assert.equal(h.ctx.literaryTeams.store.session('main'),undefined)
})
test('unassigned member preset stops before the provider is called',{timeout:10000},async t=>{
 const h=await harness(t,'direct',100,'lg-analysis')
 assert.equal(h.requests.length,0)
 const ending=h.handle.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end')
 assert.match(JSON.stringify(ending),/派发任务/)
})
test('blank-session preset switching binds and releases LG policy without leaking',{timeout:10000},async t=>{
 const h=await harness(t,'blank',100,'standard'),agent=h.handle.agent
 await h.ctx.agentPresets.select(agent,'lg')
 assert.equal(h.ctx.literaryTeams.store.session('main').role,'coordinator')
 assert.equal(h.ctx.agentPresets.composedPreset(agent.ctx),'lg')
 await h.ctx.agentPresets.select(agent,'standard')
 assert.equal(h.ctx.agentPresets.composedPreset(agent.ctx),'standard')
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'只讨论'}]}))
 await agent.whenIdle()
 assert.ok(h.requests[0].tools.some(t=>t.name==='shell'))
 assert.equal(h.ctx.literaryTeams.overview().requests,0)
})
test('LG selected before the book still binds scope and budget before its first request',{timeout:10000},async t=>{
 const h=await harness(t,'late-book',100,'lg')
 assert.equal(h.requests.length,1)
 assert.deepEqual(h.requests[0].tools.map(t=>t.name).sort(),[...mainPresetTools].sort())
 assert.equal(h.ctx.literaryTeams.overview().requests,1)
 assert.equal(h.ctx.literaryTeams.store.session('main').path,h.root)
})
test('new preset path preserves the same hard request ceiling',{timeout:10000},async t=>{
 const h=await harness(t,'team',3,'lg')
 assert.equal(h.requests.length,3)
 assert.equal(h.ctx.literaryTeams.overview().budget.used,3)
 assert.match(JSON.stringify(h.handle.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end')),/额度已耗尽/)
})
test('App usage mode continues past stale experiment limits while metering native requests',{timeout:10000},async t=>{
 const h=await harness(t,'team',1,'lg','usage')
 assert.equal(h.ctx.literaryTeams.store.tasks('main').filter(t=>t.status==='completed').length,3)
 assert.ok(h.requests.length>6)
 assert.equal(h.ctx.literaryTeams.overview().requests,h.requests.length)
 assert.equal(h.ctx.literaryTeams.overview().budget.id,'interactive-usage')
 assert.equal(h.ctx.literaryTeams.overview().budget.limit,null)
 assert.equal(h.ctx.literaryTeams.store.db.prepare('SELECT count(*) AS n FROM requests WHERE budget=?').get('offline').n,0)
})
test('legacy profile config without a mode stays count-only in the App',{timeout:10000},async t=>{
 const h=await harness(t,'team',1,'lg',null,true)
 assert.equal(h.ctx.literaryTeams.overview().budget.mode,'usage')
 assert.equal(h.ctx.literaryTeams.store.tasks('main').filter(t=>t.status==='completed').length,3)
 assert.equal(h.ctx.literaryTeams.overview().requests,h.requests.length)
})
test('bare experiment mounts without a mode retain finite defaults',{timeout:10000},async t=>{
 const h=await harness(t,'team',1,'lg',null)
 assert.equal(h.ctx.literaryTeams.overview().budget.mode,'limited')
 assert.equal(h.requests.length,1)
 assert.match(JSON.stringify(h.handle.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end')),/额度已耗尽/)
})
