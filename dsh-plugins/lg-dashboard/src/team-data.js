export const roleNames={coordinator:'主 Agent',analysis:'分析',planning:'规划',writing:'创作'}
export const roleColors={coordinator:'#e88aaa',analysis:'#ef8a46',planning:'#d8b94f',writing:'#4d8cf5'}
export const requestColors={completed:'var(--lgd-accent,#d97757)',failed:'#74dcae',pending:'#9ab8db'}
export const stageNames={ttft:'首 Token',reasoning:'推理',text:'回答',toolarg:'工具参数',other:'其他等待'}
export const inputNames={system:'系统提示',schemas:'工具定义',user:'用户消息',assistant:'历史回答',tool:'工具结果',developer:'注入内容',other:'其他'}
export const contextNames={system:'System Prompt',schemas:'Tool Schemas',user:'User Messages',developer:'Injected Context',skill:'Skill Injections',assistant:'Assistant Messages',tool:'Tool Results',other:'其他'}
export const outputNames={text:'回答',reasoning:'推理',toolarg:'工具参数'}
export function monitorOf(data){
 if(data?.monitoring)return data.monitoring
 return {roles:(data?.roles??[]).map(r=>({role:r.role,requests:r.requests,input:r.inputTokens,output:r.outputTokens,known:r.knownUsage,cache:null,failed:r.failed,pending:r.pending,elapsedMs:0,timed:0,measured:0,firstTokens:0,generationMs:0,inputChars:{},outputChars:{},stages:{}})),series:[],omitted:0}
}
export function totalRoles(rows){
 const total={requests:0,input:0,output:0,known:0,cache:0,cacheRead:0,cacheWrite:0,cacheKnown:0,cacheInput:0,contextMeasured:0,contextTokens:{},contextItems:{},inputAllocation:{},outputAllocation:{},inputCompositionKnown:0,outputCompositionKnown:0,failed:0,pending:0,elapsedMs:0,timed:0,measured:0,ttftMs:0,firstTokens:0,speedTokens:0,generationMs:0,toolCalls:0,inputChars:{},outputChars:{},stages:{}}
 for(const row of rows)for(const key of Object.keys(total)){
  if(typeof total[key]==='object')for(const [k,n] of Object.entries(row[key]??{}))total[key][k]=(total[key][k]??0)+n
  else if(Number.isFinite(row[key]))total[key]+=row[key]
 }
 return total
}
export const short=n=>n==null?'—':new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(n)
export const percent=(n,total)=>total>0?(n/total*100).toFixed(1)+'%':'—'
export const seconds=n=>n==null?'—':(n/1000).toFixed(n<10000?2:1)+'s'

export function agentCatalog(catalog=[]){
 const main=catalog.find(role=>role.id==='coordinator')??{id:'coordinator',name:'主 Agent',description:'与你讨论目标、安排成员并汇总候选结果。',output:'协调与汇总',prompt:null,method:null}
 return [main,...catalog.filter(role=>role.id!=='coordinator')]
}

export const usageModes={tokens:'Token 用量',context:'上下文',requests:'请求',time:'耗时'}
export const usageUnit=mode=>mode==='context'?'估算 Tokens':mode==='tokens'?'Tokens':mode==='input'||mode==='output'?'字符':mode==='time'?'请求耗时':'次'
export const componentColors={system:'#7457ff',schemas:'#f5a623',user:'#13c67b',assistant:'#3989ff',tool:'#02b8a6',developer:'#b451f5',skill:'#ff7b00',other:'#9aa7ba',text:'#09b9ac',reasoning:'#a45aff',toolarg:'#ef8a46',unknown:'#b6bec8',ttft:'#3989ff'}

function barsByRole(rows,project){
 return Object.keys(roleNames).map(role=>({role,...project(rows.find(row=>row.role===role)??{})}))
}

// Only composition is estimated. Both sides retain their recorded totals.
export function tokenPair(row,colors=componentColors){
 const requests=row.requests??0,known=row.known??0
 const side=(name,names)=>{
  const value=requests>0&&!known?null:(row[name]??0),allocation=row[name+'Allocation']??{}
  const parts=Object.entries(names).map(([key,label])=>({key,label,color:colors[key],value:Number.isFinite(allocation[key])&&allocation[key]>0?allocation[key]:0}))
  // Old hosts have no allocation fields. Preserve the unmatched total as unknown.
  const assigned=parts.reduce((n,p)=>n+p.value,0),remainder=(value??0)-assigned
  const tolerance=Number.EPSILON*64*Math.max(1,value??0)
  parts.push({key:'unknown',label:'未采集',color:colors.unknown,value:remainder>tolerance?remainder:0})
  return {value,parts,measured:row[name+'CompositionKnown']??0,known}
 }
 return {input:side('input',contextNames),output:side('output',outputNames),missing:Math.max(0,requests-known)}
}
export function pairedTokenBars(rows){
 return barsByRole(rows,tokenPair)
}

export function usageBar(row,mode='tokens'){
 const requests=row.requests??0
 const part=(key,label,color,value)=>({key,label,color,value:Number.isFinite(value)&&value>=0?value:0})
 let parts,known=row.known??0
 if(mode==='tokens')parts=[part('input','输入（含缓存）','#7b61ff',row.input),part('output','输出','#09b9ac',row.output)]
 else if(mode==='context'){
  known=row.contextMeasured??0
  parts=Object.entries(contextNames).map(([key,label])=>part(key,label,componentColors[key],row.contextTokens?.[key]))
 }else if(mode==='requests'){
  known=requests
  parts=[part('completed','完成',requestColors.completed,requests-(row.failed??0)-(row.pending??0)),part('failed','失败',requestColors.failed,row.failed),part('pending','进行中',requestColors.pending,row.pending)]
 }else if(mode==='time'){
  known=row.timed??0
  parts=Object.entries(stageNames).map(([key,label])=>part(key,label,componentColors[key],row.stages?.[key]))
  parts.push(part('unsegmented','未分段','#a7adb5',Math.max(0,(row.elapsedMs??0)-parts.reduce((n,p)=>n+p.value,0))))
 }else{
  known=row.measured??0
  const names=mode==='input'?{...inputNames,system:'系统提示 Prompt'}:outputNames,counts=mode==='input'?row.inputChars:row.outputChars
  parts=Object.entries(names).map(([key,label])=>part(key,label,componentColors[key],counts?.[key]))
 }
 return {parts,value:requests>0&&!known?null:parts.reduce((n,p)=>n+p.value,0),missing:Math.max(0,requests-known)}
}
export function usageBars(rows,mode='tokens'){
 return barsByRole(rows,row=>usageBar(row,mode))
}
