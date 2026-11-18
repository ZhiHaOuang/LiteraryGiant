import {totalRoles,roleNames} from './team-data.js'
const DAY=86400000
// Render-only, deterministic test records. Never persisted or sent to a provider.
export function makePreviewRecords(now){
 let seed=20261112
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
 const allocate=(amount,keys)=>{const weights=keys.map(()=>.2+random()),sum=weights.reduce((a,b)=>a+b,0);let left=amount
  return Object.fromEntries(keys.map((key,i)=>{const n=i===keys.length-1?left:Math.floor(amount*weights[i]/sum);left-=n;return [key,n]}))}
 const rows=[]
 for(let day=0;day<30;day++)for(const role of Object.keys(roleNames))for(let n=0;n<3;n++){
  const started=now-30*DAY+(day+(n+.2+random()*.6)/3)*DAY,input=800+Math.floor(random()*9000),output=80+Math.floor(random()*1300)
  const inputAllocation=allocate(input,['system','schemas','user','developer','skill','assistant','tool']),outputAllocation=allocate(output,['text','reasoning','toolarg'])
  const generationMs=output/(80+random()*120)*1000,cacheRead=Math.floor(input*random()*.8)
  rows.push({started,role,source:'lg-dashboard-preview-30d',...totalRoles([]),requests:1,known:1,input,output,inputAllocation,outputAllocation,inputCompositionKnown:1,outputCompositionKnown:1,contextMeasured:1,contextTokens:inputAllocation,cacheKnown:1,cacheRead,cache:cacheRead,cacheInput:input,speedTokens:output,generationMs,elapsedMs:generationMs+250,timed:1,measured:1,stages:{ttft:250,text:generationMs*.65,reasoning:generationMs*.25,toolarg:generationMs*.1}})
 }
 return rows
}
export function withPreview(monitor,records){
 const t=monitor.timeline
 if(t?.version!==1||!records.length)return monitor
 const earliest=records[0].started,from=t.period==='all'?Math.min(t.from,earliest):t.from
 const buckets=[]
 for(let cursor=from;cursor<t.from;cursor+=t.step)buckets.push({from:cursor,to:Math.min(cursor+t.step,t.from),roles:[]})
 buckets.push(...t.buckets.map(b=>({...b})))
 const additions=records.filter(r=>r.started>=from&&r.started<t.to)
 const merge=(real,added)=>Object.keys(roleNames).map(role=>({...totalRoles([...real,...added].filter(r=>r.role===role)),role}))
 for(const bucket of buckets)bucket.roles=merge(bucket.roles,additions.filter(r=>r.started>=bucket.from&&r.started<bucket.to))
 return {...monitor,preview:true,roles:merge(monitor.roles,additions),timeline:{...t,from,buckets}}
}
