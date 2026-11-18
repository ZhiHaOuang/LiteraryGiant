import {captureContext} from './context-capture.js'
// Local counters and bounded tool/skill names. Never persists prompts or response text.
const count=value=>{let n=0;for(const _ of String(value??''))n++;return n}
export function inputComposition(options){
 const chars={system:count(options.system),schemas:count(JSON.stringify(options.tools??[])),user:0,assistant:0,tool:0,developer:0,other:0}
 if(!options.tools?.length)chars.schemas=0
 for(const message of options.messages??[]){
  const key=Object.hasOwn(chars,message.role)?message.role:'other'
  for(const block of Array.isArray(message.content)?message.content:[{text:message.content}])
   chars[key]+=count(block.text??block.arguments??'')
 }
 return chars
}
export function createTelemetry(options,clock=()=>performance.now(),position=null){
 const context={...captureContext(options),turn:Number.isSafeInteger(position?.turn)?position.turn:null,step:Number.isSafeInteger(position?.step)?position.step:null}
 const start=clock(),inputChars=inputComposition(options),outputChars={text:0,reasoning:0,toolarg:0},stages={ttft:0,reasoning:0,text:0,toolarg:0,other:0}
 const seen=new Set(),calledTools=new Set();let first=null,last=start,phase='ttft',toolCalls=0
 function advance(time){stages[phase]+=Math.max(0,time-last);last=time}
 return {
  chunk(chunk){
   const time=clock(),kind={'text-delta':'text','reasoning-delta':'reasoning','tool-call-delta':'toolarg'}[chunk.type]
   if(kind){
    const content=kind==='toolarg'?chunk.argumentsDelta:chunk.text
    if(kind==='toolarg'&&typeof chunk.name==='string'&&chunk.name&&calledTools.size<64)calledTools.add(chunk.name.slice(0,160))
    if(!content&&!(kind==='toolarg'&&chunk.name))return
    advance(time);if(first===null)first=time;phase=kind
    outputChars[kind]+=count(content)
    if(kind==='toolarg'&&!seen.has(chunk.index)){seen.add(chunk.index);toolCalls++}
   }else if(chunk.type==='block-end'&&first!==null){advance(time);phase='other'}
  },
  finish(){
   const end=clock();advance(end)
   if(first===null){stages.other+=stages.ttft;stages.ttft=0}
   return {version:1,context,inputChars,outputChars,toolCalls,calledTools:[...calledTools],ttftMs:first===null?null:first-start,generationMs:first===null?null:end-first,stages}
  },
 }
}
const valid=n=>Number.isFinite(n)&&n>=0
const add=(target,values)=>{for(const [key,value] of Object.entries(values??{}))if(valid(value))target[key]=(target[key]??0)+value}
// Allocate only requests whose actual usage and composition were both observed.
// These values are visual estimates, never provider-reported category tokens.
const inputKeys=['system','schemas','user','developer','skill','assistant','tool','other']
const outputKeys=['text','reasoning','toolarg']
function allocate(target,total,weights,keys){
 const sum=keys.reduce((n,key)=>n+(valid(weights?.[key])?weights[key]:0),0)
 if(!sum){target.unknown=(target.unknown??0)+total;return false}
 for(const key of keys)if(valid(weights?.[key]))target[key]=(target[key]??0)+total*weights[key]/sum
 return true
}
export function requestMetrics(row){
 const known=valid(row.usage?.inputTokens)&&valid(row.usage?.outputTokens)
 const cache=(row.usage?.cacheReadTokens??0)+(row.usage?.cacheWriteTokens??0)
 return {id:row.id,role:row.role,session:row.session,task:row.task,provider:row.provider,model:row.model,purpose:row.purpose,started:row.started,status:row.status,
  input:known?row.usage.inputTokens+cache:null,output:known?row.usage.outputTokens:null,cache:known?cache:null,
  cacheRead:known&&valid(row.usage.cacheReadTokens)?row.usage.cacheReadTokens:null,cacheWrite:known&&valid(row.usage.cacheWriteTokens)?row.usage.cacheWriteTokens:null,reasoningTokens:valid(row.usage?.reasoningTokens)?row.usage.reasoningTokens:null,
  elapsedMs:valid(row.elapsedMs)?row.elapsedMs:null,telemetry:row.telemetry?.version===1?row.telemetry:null}
}
export function summarizeRequests(rows){
 const records=rows.map(requestMetrics),roles=['coordinator','analysis','planning','writing'].map(role=>{
  const own=records.filter(row=>row.role===role),result={role,days:{},requests:own.length,input:0,output:0,cache:0,known:0,cacheRead:0,cacheWrite:0,cacheKnown:0,cacheInput:0,contextMeasured:0,contextTokens:{},contextItems:{},inputAllocation:{},outputAllocation:{},inputCompositionKnown:0,outputCompositionKnown:0,failed:0,pending:0,elapsedMs:0,timed:0,measured:0,ttftMs:0,firstTokens:0,speedTokens:0,generationMs:0,toolCalls:0,inputChars:{},outputChars:{},stages:{}}
  for(const r of own){
   const m=r.telemetry
   const date=new Date(r.started)
   if(Number.isFinite(+date)){
    const day=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
    const bucket=result.days[day]??={requests:0,tokens:0,known:0}
    bucket.requests++
    if(r.input!==null){bucket.tokens+=r.input+r.output;bucket.known++}
   }
   if(r.input!==null){
    result.input+=r.input;result.output+=r.output;result.cache+=r.cache;result.known++
    if(allocate(result.inputAllocation,r.input,m?.context?.version===1?m.context.tokens:null,inputKeys))result.inputCompositionKnown++
    if(allocate(result.outputAllocation,r.output,m?.outputChars,outputKeys))result.outputCompositionKnown++
   }
   if(r.cacheRead!==null){result.cacheRead+=r.cacheRead;result.cacheInput+=r.input;result.cacheKnown++}
   if(r.cacheWrite!==null)result.cacheWrite+=r.cacheWrite
   if(r.status==='failed')result.failed++;if(r.status==='pending')result.pending++
   if(r.elapsedMs!==null){result.elapsedMs+=r.elapsedMs;result.timed++}
   if(!m)continue
   if(m.context?.version===1){result.contextMeasured++;add(result.contextTokens,m.context.tokens);add(result.contextItems,m.context.items)}
   result.measured++;result.toolCalls+=m.toolCalls??0;add(result.inputChars,m.inputChars);add(result.outputChars,m.outputChars);add(result.stages,m.stages)
   if(valid(m.ttftMs)){result.ttftMs+=m.ttftMs;result.firstTokens++}
   if(r.output!==null&&m.generationMs>0&&r.status==='completed'){result.speedTokens+=r.output;result.generationMs+=m.generationMs}
  }
  return result
 })
 return {version:1,roles,series:records.slice(-300),omitted:Math.max(0,records.length-300)}
}
