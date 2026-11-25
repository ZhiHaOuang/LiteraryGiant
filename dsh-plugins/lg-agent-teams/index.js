import {presetIds,presetCatalog,presetPrompt,presetHash,mainPresetTools} from './presets/roles.js'
import {createTelemetry} from './src/telemetry.js'
import {join} from 'node:path'
import z from '@deepseek-ai/schemastery'
import {roles,roleOf,rolePrompt,promptHash,coordinator} from './src/roles.js'
import {artifactSchemas,objectSchema,validateArtifact,hanCount} from './src/contracts.js'
import {bookForAgent,prepareSource,verifySource} from './src/context.js'
import {taskTools,proposalSchema,reviewSchema,priorKey,priorSummary,proposeSummary,reviewTarget} from './src/outline.js'
import {TeamStore} from './src/store.js'

export const name='lg-agent-teams'
export const inject=['literaryBooks','agents','subagents','tools','systemPrompt','llm']
export const Config=z.object({stateDirectory:z.string().default(''),budgetMode:z.union([z.const('auto'),z.const('limited'),z.const('usage')]).default('auto'),budgetId:z.string().default('literary-teams-v1'),requestLimit:z.number().step(1).min(1).max(100).default(100),provider:z.string().default(''),model:z.string().default(''),methods:z.boolean().default(true),activation:z.union([z.const('preset'),z.const('registered-book')]).default('preset')})
const s={type:'string'},integer={type:'integer'},strings={type:'array',items:s}
const mainTools=['lg_team_catalog','lg_team_prepare','lg_team_delegate','lg_team_result','lg_team_cancel','lg_team_outline_commit']
const summary=t=>({id:t.id,role:t.role,child:t.child,status:t.status,source_id:t.source_id,error:t.error})

/** Reuses native DSH activations and automatic parent delivery. No custom model loop. */
export function apply(ctx,config){
  const directory=config.stateDirectory||(ctx.get('profileContext')?.dir&&join(ctx.get('profileContext').dir,'lg-agent-teams'))
  if(!directory)throw Error('请配置文学协作状态目录')
  // Interactive App usage has its own meter; old experiment budgets stay immutable.
  // Old profile patches replace whole configs and may omit the new field.
  // Auto keeps installed App profiles count-only and bare experiment mounts bounded.
  const usageOnly=config.budgetMode==='usage'||config.budgetMode==='auto'&&!!ctx.get('profileContext')
  const store=new TeamStore(directory,usageOnly?'interactive-usage':config.budgetId,usageOnly?null:config.requestLimit),releases=new Map(),active=new Map()
  try{store.claimRuntime()}catch(error){store.close();throw error}
  const books=ctx.literaryBooks
  const outline=()=>{
    const service=ctx.get('literaryStoryData') ?? ctx.get('literaryOutline')
    if (!service) throw Error('请先启用 lg-storydata')
    return service
  }
  const selected=agent=>agent&&ctx.get('agentPresets')?.composedPreset(agent.ctx)
  const isNew=agent=>selected(agent)==='lg'
  const managed=agent=>!!agent&&(!!store.taskForChild(agent.id)||isNew(agent)||config.activation==='registered-book'&&!!bookForAgent(books,agent))
  const rootTools=agent=>isNew(agent)?mainPresetTools:mainTools
  const root=exec=>{const agent=exec.agent,book=bookForAgent(books,agent);if(!agent||!managed(agent)||agent.session.header.parentSession||!book)throw Error('请在已登记作品的主会话中执行');store.bind(agent.id,'coordinator',book.path);return agent}
  const own=(agent,id)=>{const task=store.task(id);if(task.owner!==agent.id)throw Error('任务不属于当前主会话');return task}
  const member=exec=>{const task=exec.agent&&store.taskForChild(exec.agent.id);if(!task||!['starting','running'].includes(task.status))throw Error('当前成员没有可执行任务');return task}
  const register=(name,description,parameters,execute)=>ctx.tools.register({name,description,parameters,
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    async execute(args,exec){
      exec.signal.throwIfAborted();let value
      try{value=await execute(args,exec)}catch(error){if(name.endsWith('_submit'))throw Error(error.message+'。修正后重交完整对象（含原本正确的字段），不是局部补丁。');throw error}
      if(name.endsWith('_submit')||['lg_outline_propose','lg_outline_review'].includes(name)||(['lg_team_delegate','lg_team_result'].includes(name)&&['starting','running'].includes(value.status)))exec.concludeTurn()
      return value
    },
  })
  register('lg_team_catalog','查看当前三种文学职责、用途和输出；不启动模型。',objectSchema({}),(_args,exec)=>({roles:roles.map(({id,name,description,output,version})=>({id,name,description,output,version,...isNew(exec.agent)?{version:'preset-v1',preset:presetIds[id],executor:'native'}:{}}))}))
  const prepareSchema=objectSchema({chapters:{type:'array',items:integer},through_chapter:integer,brief:s})
  prepareSchema.properties.min_han={type:'integer',description:'作者明确的最少汉字数；未要求时省略。'}
  prepareSchema.properties.max_han={type:'integer',description:'作者明确的最多汉字数；未要求时省略。'}
  register('lg_team_prepare','为当前作品固定 1—8 个章号、阅读截止位置和完整作者要求。有明确汉字范围时填写 min_han/max_han，程序在交稿时执行检查。返回来源 ID。',prepareSchema,(args,exec)=>{
    const agent=root(exec),book=bookForAgent(books,agent),source=prepareSource(books,book.path,args),id=store.source(agent.id,source)
    return {source_id:id,book:book.name,chapters:source.chapters.map(({number,title,version_id})=>({number,title,version_id})),records:source.records.length,brief:source.brief,constraints:source.constraints,fingerprint:source.fingerprint}
  })
  register('lg_team_source','读取当前主会话已经固定的完整正文和资料。不得指定任意路径或扩大章节范围。',objectSchema({source_id:s}),(args,exec)=>{
    const agent=root(exec),source=store.readSource(agent.id,args.source_id)
    if(source.path!==bookForAgent(books,agent)?.path)throw Error('来源与当前作品不同')
    verifySource(books,source)
    const {path:_path,...visible}=source
    return {...visible,chapters:source.chapters.map(c=>({...c,paragraphs:c.paragraphs.map((text,i)=>({paragraph:i+1,text}))})),candidate:true}
  })
  const delegateSchema=objectSchema({role:{type:'string',enum:roles.map(r=>r.id)},source_id:s,objective:s,inputs:strings,operation:s})
  delegateSchema.properties.outline_action={type:'string',enum:['propose','review'],description:'仅在作者要求更新 Main 时用于 analysis。提议 inputs 为空；独立审查 inputs 仅填提议任务 ID。'}
  delegateSchema.properties.option_count={type:'integer',description:'规划方案数量 1—3，默认 1；只有作者要求多方案时提高。'}
  register('lg_team_delegate','按需委派分析、规划或创作。inputs 为本会话同来源已完成任务 ID。operation 是本次任务唯一标识；重放返回原任务，不重试失败。派发后自动等待成员回报。',delegateSchema,async(args,exec)=>{
    const agent=root(exec);roleOf(args.role)
    const source=store.readSource(agent.id,args.source_id)
    if(source.path!==bookForAgent(books,agent)?.path)throw Error('来源与当前作品不同，请在原作品会话继续')
    verifySource(books,source)
    if (args.outline_action) {
      outline()
      if (args.role!=='analysis' || !['propose','review'].includes(args.outline_action)) throw Error('Main 更新需要分析成员')
      if (!Array.isArray(args.inputs) || args.inputs.length!==(args.outline_action==='review'?1:0)) throw Error('Main 任务输入数不符')
      if (args.outline_action==='review') reviewTarget(outline(),store,source,{...args,owner:agent.id})
    }
    const option_count=args.option_count??1
    if(!Number.isInteger(option_count)||option_count<1||option_count>3)throw Error('规划方案数量只能为 1—3')
    const preset=isNew(agent)?presetIds[args.role]:undefined
    const {task,created}=store.createTask(agent.id,{...args,option_count,...preset?{preset}: {},method:preset?false:config.methods!==false,prompt_hash:preset?presetHash(args.role):promptHash(args.role,config.methods!==false)})
    if(!created)return summary(task)
    try{
      const activation=await ctx.subagents.startActivation({provider:'spawn',parent:agent,childId:task.child,label:'文学'+roleOf(task.role).name,name:task.role+'-'+task.id.slice(-8),maxDepth:1,
        delivery:'parent',signal:exec.signal,...task.preset?{agentPreset:task.preset}:{},
        agentOptions:{...(config.provider?{provider:config.provider}:{}),...(config.model?{model:config.model}:{}),reasoningEffort:'off',maxTokens:6000},
        prompt:[{type:'text',text:`任务 ${task.id}\n职责：${roleOf(task.role).name}\n目标：${task.objective}\n${task.role==='planning'?'本任务方案数量：'+task.option_count+'，不要自行增加。\n':''}先调用 lg_team_context 读取已固定的作者要求、正文和上游制品。然后用 ${task.outline_action?'lg_outline_'+task.outline_action:'lg_'+task.role+'_submit'} 提交。你不能改变阅读范围。`}],
      })
      active.set(task.id,activation)
      if(store.task(task.id).status==='starting')store.update(task.id,{status:'running'})
      void activation.result.then(result=>{
        const latest=store.task(task.id)
        if(latest.status==='completed'&&result.stopReason==='completed')return
        if(!['cancelled','interrupted'].includes(latest.status))store.update(task.id,{status:result.stopReason==='aborted'?'cancelled':'failed',error:latest.error??(result.stopReason==='completed'?'成员结束但未提交有效候选':'成员执行结束：'+result.stopReason)})
      },error=>{if(store.task(task.id).status!=='cancelled')store.update(task.id,{status:'failed',error:String(error.message).slice(0,500)})}).finally(()=>active.delete(task.id))
      return summary(store.task(task.id))
    }catch(error){store.update(task.id,{status:'failed',error:String(error.message).slice(0,500)});throw error}
  })
  register('lg_team_result','读取本会话任务的完整候选和来源；进行中则结束本轮等待，不能用于忙轮询。',objectSchema({task_id:s}),(args,exec)=>{
    const agent=root(exec),task=own(agent,args.task_id),source=store.readSource(agent.id,task.source_id)
    let stale=false;try{verifySource(books,source)}catch{stale=true}
    return {...summary(task),objective:task.objective,inputs:task.inputs,artifact:task.artifact,metrics:task.metrics??null,request_snapshot:store.requestSnapshot(agent.id),candidate:true,source_stale:stale,source:{fingerprint:source.fingerprint,chapters:source.chapters.map(({number,document_id,version_id})=>({number,document_id,version_id}))}}
  })
  register('lg_team_cancel','取消本会话指定成员当前任务；保留历史和已生成候选。',objectSchema({task_id:s}),async(args,exec)=>{
    const agent=root(exec),task=own(agent,args.task_id)
    if(['starting','running'].includes(task.status)){
      store.update(task.id,{status:'cancelled',error:'主 Agent 取消任务'})
      if(active.has(task.id))await active.get(task.id).dispose()
      else ctx.subagents.interrupt(task.child,{kind:'ancestor',agent})
    }
    return summary(store.task(task.id))
  })
  register('lg_team_context','读取当前成员被分配的作者要求、逐段正文、故事资料和上游候选，不接收任意路径。',objectSchema({}),(_args,exec)=>{
    const task=member(exec),source=store.readSource(task.owner,task.source_id);verifySource(books,source)
    const inputs=task.inputs.map(id=>{const t=store.task(id);return {id,role:t.role,candidate:true,artifact:t.artifact}})
    const diff = task.outline_action==='review' ? reviewTarget(outline(),store,source,task) : undefined
    store.update(task.id,{context_read:true})
    const {path:_path,...publicSource}=source
    return {task_id:task.id,objective:task.objective,...task.outline_action?{character_protocol:outline().characterProtocol()}:{},...diff?{outline_diff:diff}:{},source:{...publicSource,chapters:source.chapters.map(c=>({...c,paragraphs:c.paragraphs.map((text,i)=>({paragraph:i+1,text}))}))},inputs}
  })
  function outlineTask(exec,mode) {
    const task=member(exec)
    if (task.role!=='analysis' || task.outline_action!==mode || !task.context_read) throw Error('先由指定成员读取本任务上下文')
    const source=store.readSource(task.owner,task.source_id)
    verifySource(books,source)
    return {task,source}
  }
  function finishOutline(task,receipt,summary) {
    const artifact={...receipt,summary}
    store.update(task.id,{status:'completed',artifact,completed_at:new Date().toISOString()})
    return {task_id:task.id,status:'completed',artifact}
  }
  const priorSchema=objectSchema({id:s})
  priorSchema.properties.module={type:'string',description:'指定人物模块；省略时读取通用摘要'}
  register('lg_outline_prior','查询当前档案的指定模块及版本。新模块版本为 0。',priorSchema,({id,module},exec)=>{
    const {task,source}=outlineTask(exec,'propose')
    if (typeof id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(id)) throw Error('档案 ID 格式无效')
    const prior=priorSummary(outline(),source,id,module)
    const readVersions={...task.outline_priors,[priorKey(id,module)]:prior.revision}
    if(Object.keys(readVersions).length>24) throw Error('本次任务最多比较 24 个档案')
    store.update(task.id,{outline_priors:readVersions})
    return prior
  })
  register('lg_outline_propose','按情节点提交有证据的 Main 候选。复用已有人物 ID，先比较旧摘要；零变化可交空数组。',proposalSchema,(input,exec)=>{
    const {task,source}=outlineTask(exec,'propose')
    return finishOutline(task,proposeSummary(outline(),books,source,task,input),input.beat)
  })
  register('lg_outline_review','独立核对上下文中的 before/after、引文、关联和保留价值，提交批准或驳回及具体依据。',reviewSchema,(input,exec)=>{
    const {task,source}=outlineTask(exec,'review')
    const target=reviewTarget(outline(),store,source,task)
    return finishOutline(task,outline().review(source.path,target.token,input,task.child),input.reason)
  })
  register('lg_team_outline_commit','按独立审查任务 ID 提交已批准的 Main 更新。',objectSchema({review_task_id:s}),({review_task_id},exec)=>{
    const agent=root(exec),task=own(agent,review_task_id)
    if(task.outline_action!=='review' || task.status!=='completed' || task.artifact?.status!=='approved') throw Error('需要已完成且批准的独立审查')
    const source=store.readSource(agent.id,task.source_id),target=reviewTarget(outline(),store,source,task)
    if(target.token!==task.artifact.token || target.reviewer!==task.child) throw Error('审查版本或身份不符')
    if(target.status!=='committed') verifySource(books,source)
    return outline().commit(source.path,target.token)
  })
  for(const role of roles)register('lg_'+role.id+'_submit','提交'+role.name+'候选并结束本轮；程序核验格式、来源与证据，正式采纳仍由作者决定。',artifactSchemas[role.id],(args,exec)=>{
    const task=member(exec);if(task.outline_action||task.role!==role.id||!task.context_read)throw Error('必须由正确职责成员先读取上下文')
    const source=store.readSource(task.owner,task.source_id);verifySource(books,source)
    const artifact=validateArtifact(role.id,args,source,task.option_count)
    const evidence_bindings=role.id==='analysis'?artifact.findings.flatMap(f=>f.evidence.map(e=>{
      const ch=source.chapters.find(c=>c.number===e.chapter)
      return {...e,document_id:ch.document_id,version_id:ch.version_id,sha256:ch.sha256}
    })):[]
    const metrics=role.id==='writing'?{han:hanCount(artifact.text),min_han:source.constraints?.min_han??0,max_han:source.constraints?.max_han??20000}:null
    store.update(task.id,{status:'completed',artifact,evidence_bindings,metrics,completed_at:new Date().toISOString()})
    return {task_id:task.id,status:'completed',candidate:true,summary:artifact.summary,metrics,message:'候选已保存，主 Agent 用 lg_team_result 读取全文。'}
  })
  const attach=agent=>{
    const task=store.taskForChild(agent.id),book=bookForAgent(books,agent)
    if(!task&&(!managed(agent)||agent.session.header.parentSession))return
    if(!task&&book)store.bind(agent.id,'coordinator',book.path)
    if(releases.has(agent))return
    // Restrict the concrete session, where preset-local tools are now inherited.
    // Presets own their persona; legacy in-flight tasks keep their original one.
    if(task?.preset||isNew(agent)){
      const allow=task?taskTools(task):mainPresetTools
      releases.set(agent,agent.ctx.tools.restrict({allow}));return
    }
    if(!task&&!book)return
    const allow=task?taskTools(task):mainTools
    const offTools=agent.ctx.tools.restrict({allow})
    const offPrompt=agent.ctx.systemPrompt.section({name:'deployment:persona-prefix',order:agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),interpolate:false,
      text:task?rolePrompt(task.role,task.method).replaceAll('lg_team_submit','lg_'+task.role+'_submit'):coordinator})
    releases.set(agent,()=>{offTools();offPrompt()})
  }
  ctx.on('agent/created',({agent})=>attach(agent))
  ctx.on('agent-preset/selected',(sessionId)=>{const agent=ctx.agents.get(sessionId);if(agent){releases.get(agent)?.();releases.delete(agent);attach(agent)}})
  ctx.on('agent/disposed',({agent})=>{releases.get(agent)?.();releases.delete(agent)})
  ctx.on('agent/status',({agent,status})=>{
    if(status!=='idle')return
    const task=store.taskForChild(agent.id);if(!task||!['starting','running'].includes(task.status))return
    const reason=agent.session.snapshotEvents().findLast(e=>e.type==='turn/end')?.data?.reason
    if(reason?.kind==='error'){
      const code=reason.error?.code
      store.update(task.id,{error:'成员执行失败'+(typeof code==='string'&&/^[A-Z0-9_/-]{1,100}$/u.test(code)?'：'+code:'')})
    }
  })
  for(const agent of ctx.agents.list())attach(agent)
  // A cold host cannot own a prior in-flight promise. Preserve it as interrupted; never replay paid work.
  store.recover(child=>ctx.agents.get(child))
  ctx.tools.guard(exec=>{
    const identity=exec.agent&&store.session(exec.agent.id);if(!identity||!managed(exec.agent))return undefined
    const allow=identity.role==='coordinator'?rootTools(exec.agent):taskTools(store.task(identity.task))
    return allow.includes(exec.name)?undefined:'本文学任务未授予此工具；不能绕过候选与作者控制'
  })
  ctx.on('llm/stream',async function*(options,next){
    const agent=ctx.agents.get(options.sessionId??''),preset=selected(agent)
    if(Object.values(presetIds).includes(preset)){
      if(preset==='lg'&&!bookForAgent(books,agent))throw Error('请先将 LG 主 Agent 会话绑定到已登记作品')
      if(preset!=='lg'&&!store.taskForChild(agent.id))throw Error('文学成员 preset 需要由 LG 主 Agent 派发任务，不能单独启动付费会话')
      attach(agent)
    }
    const identity=store.session(options.sessionId??'');if(!identity||!managed(agent)){yield* next();return}
    const position=options.purpose?null:ctx.agents.get(options.sessionId)?.session.snapshotEvents().findLast(e=>e.type==='step/start')?.data
    const telemetry=createTelemetry(options,undefined,position)
    const reservation=store.reserve(options),start=performance.now();let usage=null,status='completed',failure=null,finish=null
    try{
      for await(const chunk of next()){
        telemetry.chunk(chunk)
        if(chunk.type==='usage')usage=chunk.usage
        if(chunk.type==='finish'){finish=chunk.reason?.kind;if(!['stop','tool-calls'].includes(finish))status='failed'}
        yield chunk
      }
    }catch(error){status='failed';failure=error.code??error.name;throw error}
    finally{store.finish(reservation.id,{status,usage,failure,finish,elapsedMs:Math.round(performance.now()-start),telemetry:telemetry.finish()})}
  })
  const service={catalog:()=>roles.map(r=>({...r,...config.activation==='registered-book'?{}:presetCatalog().find(p=>p.id===r.id),enabled:true})),overview:options=>store.overview(options),task:id=>store.task(id),store}
  ctx.effect(()=>ctx.provide('literaryTeams',service),'lg-agent-teams: service')
  ctx.inject(['connection'],scope=>scope.effect(()=>scope.connection.fetch.register({path:'/api/lg/teams',methods:['POST'],requestBody:'buffered',async fetch(request){
    try{
      const input=await request.json()
      if(input.action==='overview')return Response.json({ok:true,value:{catalog:[{id:'coordinator',name:'主 Agent',description:'与你讨论目标、安排成员并汇总候选结果。',output:'协调与汇总',version:config.activation==='registered-book'?'1.1.0':'preset-v1',prompt:config.activation==='registered-book'?coordinator:presetPrompt('coordinator'),method:null,preset:config.activation==='registered-book'?null:'lg',executor:'native'},...service.catalog()],...service.overview(input)}})
      if(input.action==='task'){
        const task=service.task(input.id),source=store.readSource(task.owner,task.source_id)
        let source_current=true;try{verifySource(books,source)}catch{source_current=false}
        return Response.json({ok:true,value:{...task,metrics:task.role==='writing'&&task.artifact?{han:hanCount(task.artifact.text),...(source.constraints??{})}:null,source_current,source:{brief:source.brief,through_chapter:source.through_chapter,fingerprint:source.fingerprint,chapters:source.chapters.map(({number,title,document_id,version_id,sha256})=>({number,title,document_id,version_id,sha256}))}}})
      }
      throw Error('未知文学协作查询')
    }catch(error){return Response.json({ok:false,error:error.message},{status:400})}
  }}),'lg-agent-teams: read-only dashboard'))
  ctx.effect(()=>async()=>{
    for(const release of releases.values())release();releases.clear()
    await Promise.allSettled([...active.values()].map(a=>a.dispose()));active.clear();store.close()
  },'lg-agent-teams: shutdown')
}
