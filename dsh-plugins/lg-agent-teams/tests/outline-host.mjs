import assert from 'node:assert/strict'
import {join} from 'node:path'
import {Context,Service} from '@deepseek-ai/cordis'
import {native,hostBaseUrl} from './runtime.mjs'
import * as books from '../../lg-books/index.js'
import * as outline from '../../lg-storydata/index.js'
import * as teams from '../index.js'
import * as presets from '../presets/index.js'

const {LlmAdapter,createUserMessage}=await native('dsh-llm')
const {mountAgentLoopTestDependencies}=await native('dsh-agent-loop-testkit')
const {default:AgentLoop}=await native('dsh-agent-loop')
const {default:Subagents}=await native('dsh-subagent')
const spawn=await native('dsh-subagent-spawn-in-process')

// Fixed dispatch for a reproducible host experiment. The two callbacks see only
// their own task's delivered source, old dossier or review diff, and validation feedback.
export async function runOutlineCase({path,state,ids,brief,propose,review,attemptForbidden=false}) {
  const ctx=new Context(), events=[],requests=[],steps=new Map()
  let handle,sequence=0
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.provide('configEditor',{edit(){throw Error('fixture configuration is read-only')}})
    await ctx.plugin(books,{projects:[path]})
    await ctx.plugin(outline)
    class Directory extends Service {
      directories=new WeakMap()
      constructor(ctx){super(ctx,'workingDirectory')}
      get(session){return this.directories.get(session)??session.header.cwd}
      async set(agent,path){this.directories.set(agent.session,path);return path}
      async ensure(agent){return this.get(agent.session)}
    }
    await ctx.plugin(Directory)
    await ctx.plugin(await native('dsh-session-persistence-jsonl'),{root:join(state,'sessions')})
    await ctx.plugin(AgentLoop,{agents:[]})
    ctx.baseUrl=hostBaseUrl
    const {default:Loader}=await native('cordis-plugin-loader'),{default:Group}=await native('cordis-plugin-group')
    await ctx.plugin(Loader)
    ctx.loader.builtins.group=Group
    for(const name of ['dsh-token-meter','dsh-commands','dsh-user-questions','dsh-agent-preset-registry']){
      const {default:plugin}=await native(name)
      await ctx.plugin(plugin,name==='dsh-agent-preset-registry'?{default:'standard'}:{})
    }
    await ctx.agentPresets.register({id:'standard',name:'Standard',plugins:[]})
    await ctx.plugin(Subagents)
    await ctx.plugin(spawn,{providerName:'spawn'})
    await ctx.plugin(teams,{stateDirectory:state,budgetId:'outline-case',budgetMode:'limited',requestLimit:24,methods:true,activation:'preset'})
    await ctx.plugin(presets)
    ctx.on('tools/result',(exec,result)=>events.push({session:exec.agent?.id,name:exec.name,error:result.isError,value:result.value,content:result.isError?result.content:undefined}))
    const main='outline-test-main'
    const last=(session,name)=>events.findLast(e=>e.session===session && e.name===name && !e.error)?.value
    async function next(session) {
      const task=ctx.literaryTeams.store.taskForChild(session)
      const step=steps.get(session)??0
      steps.set(session,step+1)
      if(task){
        if(!step) return ['lg_team_context',{}]
        const input=last(session,'lg_team_context')
        if (!input) throw Error('成员未获得上下文')
        if(task.outline_action==='review') {
          if(attemptForbidden && step===1) return ['lg_outline_propose',{}]
          return ['lg_outline_review',await review(input)]
        }
        if(step<=ids.length) return ['lg_outline_prior',typeof ids[step-1]==='string'?{id:ids[step-1]}:ids[step-1]]
        const priors=events.filter(e=>e.session===session && e.name==='lg_outline_prior' && !e.error).map(e=>e.value)
        return ['lg_outline_propose',await propose(input,priors,events.findLast(e=>e.session===session && e.error)?.content)]
      }
      const tasks=ctx.literaryTeams.store.tasks(main)
      const source_id=last(main,'lg_team_prepare')?.source_id
      if (!step) return ['lg_team_prepare',{chapters:[1],through_chapter:1,brief}]
      if (!tasks.length) return ['lg_team_delegate',{role:'analysis',source_id,objective:brief,operation:'propose',outline_action:'propose',inputs:[]}]
      const [proposal,decision]=tasks
      if (proposal.status!=='completed' || (decision && decision.status!=='completed')) throw Error('成员中断 '+JSON.stringify(tasks.map(t=>[t.status,t.error])))
      if (!decision && proposal.artifact.status==='pending') return ['lg_team_delegate',{role:'analysis',source_id,objective:'逐项比较原文、旧摘要、候选和关联，决定是否值得保留。',operation:'review',outline_action:'review',inputs:[proposal.id]}]
      if(decision && !events.some(e=>e.name==='lg_team_outline_commit') && (decision.artifact.status==='approved'||attemptForbidden)) return ['lg_team_outline_commit',{review_task_id:decision.id}]
      return null
    }
    class CaseAdapter extends LlmAdapter {
      async resolveModel(provider,model){return {provider,id:model,name:model,reasoning:{defaultEffort:'off',efforts:[{id:'off',name:'off'}]}}}
      async *stream(options){
        requests.push({session:options.sessionId,tools:options.tools.map(t=>t.name)})
        const result=await next(options.sessionId)
        if(result){
          const [name,args]=result,id='call-'+(++sequence),argumentsText=JSON.stringify(args)
          yield {type:'block-start',index:0,blockType:'tool-call'}
          yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:argumentsText}
          yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:argumentsText}}
          yield {type:'finish',reason:{kind:'tool-calls'}}
        }else{
          yield {type:'block-start',index:0,blockType:'text'}
          yield {type:'text-delta',index:0,text:'完成'}
          yield {type:'block-end',index:0,block:{type:'text',text:'完成'}}
          yield {type:'finish',reason:{kind:'stop'}}
        }
      }
    }
    ctx.llm.registerAdapter(['outline-case'],new CaseAdapter())
    handle=await ctx.agents.create({sessionId:main,meta:{cwd:path,agentPreset:'lg'},agentOptions:{provider:'outline-case',model:'case',reasoningEffort:'off'},
      setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'lg')}})
    handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:brief}]}))
    await handle.agent.whenIdle()
    while(await ctx.subagents.waitForTreeWork(handle.agent)) await handle.agent.whenIdle()
    await handle.agent.whenIdle()
    const tasks=ctx.literaryTeams.store.tasks(main)
    assert.equal(tasks.length,2,JSON.stringify({tasks:tasks.map(t=>[t.status,t.error]),errors:events.filter(e=>e.error)}))
    assert.ok(tasks.every(t=>t.status==='completed'),JSON.stringify(tasks.map(t=>[t.status,t.error])))
    const [a,b]=tasks
    assert.notEqual(a.child,b.child)
    assert.ok(requests.filter(r=>r.session===a.child).every(r=>!r.tools.includes('lg_outline_review')))
    assert.ok(requests.filter(r=>r.session===b.child).every(r=>!r.tools.includes('lg_outline_propose')))
    const diff=ctx.literaryOutline.inspect(path,a.artifact.token)
    assert.equal(diff.actor,a.child); assert.equal(diff.reviewer,b.child)
    assert.equal(diff.status,b.artifact.status==='approved'?'committed':'rejected')
    return {tasks,requests,diff,errors:events.filter(e=>e.error),main:ctx.literaryOutline.main(path)}
  }finally{
    if(handle){await ctx.subagents.drainDescendants([handle.agent]);await handle.dispose()}
    await ctx.fiber.dispose()
  }
}

