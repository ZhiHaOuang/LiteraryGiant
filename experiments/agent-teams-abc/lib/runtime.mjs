import {readFileSync,mkdirSync,appendFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {Context,Service} from '@deepseek-ai/cordis'
import {createUserMessage,LlmAdapter} from '@deepseek-ai/dsh-llm'
import {mountAgentLoopTestDependencies} from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {artifactSchemas,validateArtifact,hanCount} from '../frozen/src/contracts.js'
import {LIMITS} from './ledger.mjs'
export const REVISION='请对刚提交的初稿做一次最终修订：核对作者全部要求、人物实际可知的信息、物件与时间状态、动作因果、台词归属及场景是否推进。发现问题就修改；没有必要不要为改而改。仍只用 submit_writing 提交完整正文对象，不写分析进 text，不自报字数。'
const rolePrompt=role=>readFileSync(new URL('../frozen/prompts/'+role+'.md',import.meta.url),'utf8').replaceAll('lg_team_submit','submit_'+role)+'\n本实验直接在任务消息中提供完整来源，不需要 lg_team_context；该工具不提供。只使用当前 submit_'+role+'。没有可选方法草稿，不调用其他工具。'
const plain=value=>[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]
class Directory extends Service{
 directories=new WeakMap()
 constructor(ctx){super(ctx,'workingDirectory')}
 get(session){return this.directories.get(session)??session.header.cwd}
 async ensure(agent){return this.get(agent.session)}
 async set(agent,path){this.directories.set(agent.session,path);return path}
}
export async function runCell({root,caseData,arm,ledger,installAdapter,provider='fixture',model='fixture',fixtureReply,runTag=''}){
 if(!['A','B','C'].includes(arm))throw Error('INVALID_ARM')
 const cell=(runTag?runTag+'-':'')+caseData.id+'-'+arm,dir=join(root,'runs',cell);mkdirSync(dir,{recursive:true,mode:0o700});ledger.start(cell)
 const log=x=>appendFileSync(join(dir,'trace.jsonl'),JSON.stringify(x)+'\n',{mode:0o600})
 const ctx=new Context(),identities=new Map(),releases=new Map(),artifacts={},events=[],requests=[];let main,currentStage
 const started=performance.now(),abort=new AbortController();const timer=setTimeout(()=>abort.abort(Error('CELL_TIMEOUT')),300000)
 const attach=agent=>{
  const identity=identities.get(agent.id);if(!identity)return
  releases.get(agent.id)?.()
  const off=agent.ctx.systemPrompt.section({name:'deployment:persona-prefix',order:agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),interpolate:false,text:rolePrompt(identity.role)})
  const tools=agent.ctx.tools.restrict({allow:['submit_'+identity.role]});releases.set(agent.id,()=>{off();tools()})
 }
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Directory);await ctx.plugin(Persistence,{root:join(dir,'sessions')});await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(SubagentRuntime);await ctx.plugin(Spawn,{providerName:'spawn'})
  if(fixtureReply){class Fixture extends LlmAdapter{
   async resolveModel(provider,model){return {provider,id:model,name:model,reasoning:{defaultEffort:'off',efforts:[{id:'off',name:'Off'}]}}}
   async *stream(options){const id=identities.get(options.sessionId);const reply=fixtureReply({options,identity:id,artifacts,requests,arm});const args=JSON.stringify(reply.args);yield* [{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:'t'+requests.length,name:reply.name??'submit_'+id.role,argumentsDelta:args},{type:'block-end',index:0,block:{type:'tool-call',id:'t'+requests.length,name:reply.name??'submit_'+id.role,arguments:args}},{type:'usage',usage:{inputTokens:50,outputTokens:20,cacheReadTokens:10}},{type:'finish',reason:{kind:'tool-calls'}}]}
  };ctx.llm.registerAdapter(['fixture'],new Fixture())}else await installAdapter(ctx)
  ctx.on('agent/created',({agent})=>attach(agent));ctx.on('agent/disposed',({agent})=>{releases.get(agent.id)?.();releases.delete(agent.id)})
  ctx.tools.guard(exec=>identities.get(exec.agent?.id)?.role&&exec.name==='submit_'+identities.get(exec.agent.id).role?undefined:'实验只允许当前职责提交候选')
  for(const role of ['analysis','planning','writing'])ctx.tools.register({name:'submit_'+role,description:'提交本阶段候选。text 只放正文；错误时重交完整对象。',parameters:artifactSchemas[role],output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>plain(v)},execute(args,exec){
   const identity=identities.get(exec.agent?.id);if(identity?.role!==role)throw Error('ROLE_SCOPE')
   log({event:'attempt',role,phase:identity.phase,args})
   let artifact;try{artifact=validateArtifact(role,args,caseData.source,1)}catch(e){throw Error(e.message+'；请重新提交完整对象。')}
   artifacts[identity.phase]=artifact;events.push({role,phase:identity.phase,session:exec.agent.id,artifact})
   if(role==='writing'&&identity.phase==='draft'){identity.phase='final';return {status:'draft_saved',han:hanCount(artifact.text),next:REVISION}}
   exec.concludeTurn();return {status:'candidate_saved',phase:identity.phase,...role==='writing'?{han:hanCount(artifact.text)}:{}}
  }})
  ctx.on('tools/result',(exec,result)=>log({event:'tool',name:exec.name,isError:result.isError,value:result.value,content:result.content}))
  ctx.on('llm/stream',async function*(options,next){
   if(options.provider!==provider||options.model!==model)throw Error('MODEL_ROUTE')
   const row=ledger.reserve(cell,options),identity=identities.get(options.sessionId);requests.push({role:identity?.role??'auxiliary',phase:identity?.phase,session:options.sessionId,messages:options.messages,system:options.system,tools:options.tools});log({event:'request',id:row.id,phase:identity?.phase,options})
   let usage,status='completed';const begin=performance.now()
   try{for await(const chunk of next()){log({event:'chunk',id:row.id,chunk});if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish'&&!['stop','tool-calls'].includes(chunk.reason?.kind))status='failed';yield chunk}}
   catch(e){status='failed';log({event:'transport_error',code:e.code??e.name});throw e}
   finally{const settled=ledger.finish(row,{usage,status,elapsedMs:performance.now()-begin});log({event:'settled',...settled})}
  })
  const options={provider,model,reasoningEffort:'off',maxTokens:LIMITS.maxOutput}
  const mainId='abc-'+cell+'-main';if(arm!=='C')identities.set(mainId,{role:arm==='A'?'writing':'analysis',phase:arm==='A'?'draft':'analysis'})
  main=await ctx.agents.create({sessionId:mainId,meta:{cwd:root},agentOptions:options})
  abort.signal.addEventListener('abort',()=>{main.agent.cancel({kind:'user'});void ctx.subagents.drainDescendants([main.agent])},{once:true})
  const stages=arm==='A'?['writing']:['analysis','planning','writing']
  for(const [index,role] of stages.entries()){
   currentStage=role;const phase=role==='writing'?'draft':role
   const visibleSource={...caseData.source,chapters:caseData.source.chapters.map(c=>({...c,paragraphs:c.paragraphs.map((text,i)=>({paragraph:i+1,text}))}))}
   const packet={objective:caseData.brief,stage:role,...arm==='C'||index===0?{source:visibleSource}:{},...arm==='C'?{upstream:artifacts}:{},instruction:role==='analysis'?'给出3项最相关的认知/状态约束，附可核验引文。':role==='planning'?'只规划一个能满足作者目标的场景，明确新增设想。':'写400—600汉字初稿，提交后按工具返回的统一要求修订一次。'}
   if(arm==='C'){
    const childId='abc-'+cell+'-'+role;identities.set(childId,{role,phase})
    const activation=await ctx.subagents.startActivation({provider:'spawn',parent:main.agent,childId,name:role,label:role,maxDepth:1,delivery:'caller',signal:abort.signal,agentOptions:options,prompt:plain(packet)})
    const result=await activation.result;log({event:'activation_end',role,stopReason:result.stopReason})
   }else{
    identities.set(mainId,{role,phase});attach(main.agent)
    main.agent.followup(createUserMessage({source:{kind:'user'},content:plain(packet)}));await main.agent.whenIdle()
   }
   if(!artifacts[role==='writing'?'final':role])throw Error('STAGE_INCOMPLETE_'+role)
  }
 }catch(error){log({event:'cell_failure',stage:currentStage,code:error.code??error.message??error.name})}
 finally{
  clearTimeout(timer);if(main){await ctx.subagents?.drainDescendants([main.agent]);writeFileSync(join(dir,'main-events.json'),JSON.stringify(main.agent.session.snapshotEvents(),null,2),{mode:0o600});await main.dispose()}
  await ctx.fiber.dispose()
 }
 const rows=ledger.rows(cell),result={cell,caseId:caseData.id,split:caseData.split,arm,sourceHash:caseData.source_sha256,completed:!!artifacts.final,artifacts,requests:rows.length,knownTokens:rows.reduce((n,r)=>n+(r.usage?r.charged:0),0),unknownUsage:rows.filter(r=>!r.usage).length,elapsedMs:performance.now()-started,firstDraftHan:artifacts.draft?hanCount(artifacts.draft.text):null,finalHan:artifacts.final?hanCount(artifacts.final.text):null,limits:LIMITS}
 ledger.end(cell,result.completed?'completed':'failed');writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2),{mode:0o600});return {...result,events,requestTrace:requests}
}
