import {localDay} from './global-data.js'
const n=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0
const admitted=(day,range)=>day>=range.from&&day<=range.to
export function usageBranches(cost) {
  return Object.entries(cost??{}).flatMap(([provider,models])=>Object.entries(models).map(([model,periods])=>{
    const totals={input:0,output:0,cache:0}
    for(const bucket of Object.values(periods)) {
      totals.input+=n(bucket.uncached)+n(bucket.cacheRead)+n(bucket.cacheWrite)
      totals.cache+=n(bucket.cacheRead)
      totals.output+=n(bucket.output)
    }
    return {key:JSON.stringify([provider,model]),provider,model,periods,...totals,tokens:totals.input+totals.output}
  }))
}
export function apiStats(rows,range) {
  const groups=new Map()
  const get=branch=>{
    if(!groups.has(branch.key))groups.set(branch.key,{key:branch.key,provider:branch.provider,model:branch.model,input:0,output:0,cache:0,tokens:0,requests:0,requestKnown:true,days:{},costUsage:{},speedTokens:0,speedMs:0,ttftMs:0,timedCalls:0})
    return groups.get(branch.key)
  }
  for(const row of rows)for(const [day,value] of Object.entries(row.activity?.days??{})) {
    if(!admitted(day,range))continue
    const branches=usageBranches(value.cost)
    for(const branch of branches) {
      const group=get(branch)
      for(const key of ['input','output','cache','tokens'])group[key]+=branch[key]
      if(branches.length===1)group.requests+=n(value.requests);else group.requestKnown=false
      group.days[day]=(group.days[day]??0)+branch.tokens
      const periods=group.costUsage[group.provider]??={}
      const target=periods[group.model]??={}
      for(const [period,bucket] of Object.entries(branch.periods)) {
        const out=target[period]??={uncached:0,cacheRead:0,cacheWrite:0,output:0}
        for(const key of Object.keys(out))out[key]+=n(bucket[key])
      }
    }
  }
  // Timing is cumulative: use only single-model members fully inside the range.
  const seen=new Set()
  for(const row of rows)for(const [index,member] of (row.family??[]).entries()) {
    if(!member||seen.has(member))continue
    seen.add(member)
    const dates=Object.keys(row.familyActivity?.[index]?.days??{})
    const branches=usageBranches(member.cost),timing=member.timing
    if(branches.length!==1||!timing||!dates.length||dates.some(day=>!admitted(day,range)))continue
    const group=groups.get(branches[0].key)
    if(!group)continue
    group.speedTokens+=n(timing.speedTokens);group.speedMs+=n(timing.speedMs)
    group.ttftMs+=n(timing.ttftMs);group.timedCalls+=n(timing.calls)
  }
  return [...groups.values()].sort((a,b)=>b.tokens-a.tokens||a.key.localeCompare(b.key))
}
export function heatmapWindow(today=localDay(),page=0) {
  const end=new Date(today+'T12:00:00')
  end.setDate(end.getDate()-page*371)
  const start=new Date(end)
  start.setDate(start.getDate()-((start.getDay()+6)%7)-52*7)
  return Array.from({length:371},(_,i)=>{const date=new Date(start);date.setDate(date.getDate()+i);return localDay(date)})
}
