import { defineTool } from '@deepseek-ai/dsh-tools'
import { createDirector,tasks } from './src/service.js'
const taskInput={type:'object',required:true,additionalProperties:false,properties:{
  task:{type:'string',enum:Object.keys(tasks),required:true},request:{type:'string',required:true,description:'Original task instruction, at most 2000 characters.'},
  ...Object.fromEntries(['document','version','start','end'].map(key=>[key,{type:'integer'}])),
  ...Object.fromEntries(['role','token','requirements','category','method'].map(key=>[key,{type:'string'}])),
  ...Object.fromEntries(['target','context','feedback'].map(key=>[key,{type:'object',additionalProperties:true}])),
  references:{type:'array',items:{type:'string'}},
}}
export const inject=['literaryBooks','literaryAgents','tools','workingDirectory']
function resultSummary(task) {
  const r=task.result
  if(!r)return undefined
  if(task.input.task==='candidate-analysis'&&r.report)return {status:r.status,category:task.input.target.category,entries:r.report.entries.length,findings:r.report.findings.length}
  return {status:r.status,candidate:r.candidate,report:r.report?.run,proposal:r.proposal,card:r.card?.id}
}
export function apply(ctx){
  const service=createDirector(ctx.literaryBooks,ctx.literaryAgents)
  ctx.effect(()=>()=>service.dispose(),'lg-director: settle tasks')
  ctx.effect(()=>ctx.provide('literaryDirector',service),'lg-director: task handoffs')
  ctx.inject(['connection'], scope => {
  scope.effect(()=>scope.connection.fetch.register({path:'/api/lg/director',methods:['POST'],requestBody:'buffered',async fetch(request){
    try{
      const i=await request.json();let value
      if(i.action==='catalog')value=service.catalog()
      else if(i.action==='source')value=service.source(i.path,i.document,i.version,i.start,i.end)
      else if(i.action==='supervision')value=service.supervision(i.path,i.document,i.version)
      else if(i.action==='propose')value=service.propose(i.path,i.input,i.id)
      else if(i.action==='list')value=service.list(i.path,i.offset)
      else if(i.action==='read')value=service.read(i.path,i.id)
      else if(i.action==='preview')value=service.preview(i.path,i.id)
      else if(i.action==='run')value=await service.run(i.path,i.id,i.token,request.signal)
      else if(i.action==='recover')value=await service.recover(i.path,i.id,request.signal)
      else if(i.action==='stop')value=service.stop(i.path,i.id,i.token,i.reason)
      else throw new Error('未知分派操作。')
      return Response.json({ok:true,value},{headers:{'cache-control':'no-store'}})
    }catch(error){return Response.json({ok:false,error:error.message},{status:400})}
  }}),'lg-director: author API')
  })
  const bookFor=async exec=>{if(!exec.agent)throw new Error('任务分派需要作品会话。');exec.signal?.throwIfAborted();return service.forDirectory(await ctx.workingDirectory.ensure(exec.agent,exec.signal))}
  for(const tool of [
    {name:'literary_tasks',description:'Inspect literary specialist capabilities and proposed task handoffs for the current registered book. source reads an exact chapter/scene version with bounded text and token; truncated excerpts never authorize whole-chapter edits. supervision(document,version) returns a candidate target and required report categories, states and specialist roles. list/read inspect proposals, not author approvals. Use literary_plan/library/memory tools for their domain targets. This tool never executes a model task.',parameters:{action:{type:'string',enum:['catalog','source','supervision','list','read'],required:true},id:{type:'string'},document:{type:'integer'},version:{type:'integer'},start:{type:'integer'},end:{type:'integer'},offset:{type:'integer'}},async execute(args,exec){
      const path=await bookFor(exec)
      if(args.action==='catalog')return service.catalog()
      if(args.action==='source')return service.source(path,args.document,args.version,args.start,args.end)
      if(args.action==='supervision')return service.supervision(path,args.document,args.version)
      if(args.action==='list')return service.list(path,args.offset)
      if(args.action==='read'){const s=service.read(path,args.id);return JSON.parse(JSON.stringify({id:s.id,input:s.input,status:s.status,reason:s.reason,origin:s.origin,result:resultSummary(s)}))}
      throw new Error('未知分派查询。')
    }},
    {name:'literary_propose_task',description:'Propose one bounded literary task; no specialist call and no adoption happen. Author confirms full input/cost in the Literary Tasks panel. Keep id unchanged for retries. input must be an object, never a JSON-encoded string. It uses an enabled task from literary_tasks catalog and request<=2000 chars. polish/draft-chapter/draft-scene: document,version,token,start,end; draft-chapter requires full current chapter. manuscript-review: target {section:manuscript,id,version_id,token,start,end}; extract-memory: target {document,version,token,start,end}. ideas/scene-plan/plan-review use exact literary_plan targets; analyze-reference uses category and references. candidate-analysis: use the exact supervision target with one missing or stale category in target.category. Optional role,context,references,feedback,requirements. Never supply path/operation/signature or infer author approval from dialogue.',parameters:{id:{type:'string',required:true},input:taskInput},async execute(args,exec){const s=service.propose(await bookFor(exec),args.input,args.id,String(exec.agent.id));return s.result&&s.input.task==='candidate-analysis'?{...s,result:resultSummary(s)}:s}},
  ])ctx.effect(()=>ctx.tools.register(defineTool({...tool,output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]}})),`lg-director: ${tool.name}`)
}
