import {tokenPair,totalRoles,usageBar,componentColors,requestColors} from '../team-data.js'
import {COLUMN_GAP,MAX_BAR_WIDTH} from './agent-stacks.js'
export const timePresets=[['today','当天'],['24h','近24小时'],['7d','近7天'],['14d','近14天'],['30d','近30天'],['all','全部']]
// Bencho's supplied Colour palette, with gray reserved for missing composition.
export const timelineColors={...componentColors,system:'#9d7bf5',schemas:'#5b8def',user:'#9ab8db',developer:'#f2c46d',skill:'#74dcae',assistant:'#e57bb8',tool:'#74dcae',other:'#9ab8db',text:'#9d7bf5',reasoning:'#5b8def',toolarg:'#f2c46d',unknown:'#b6bec8',ttft:'#5b8def',unsegmented:'#b6bec8'}
export const timelineCapacity=width=>Math.max(1,Math.min(96,Math.floor((Math.max(1,width)+COLUMN_GAP)/(MAX_BAR_WIDTH+COLUMN_GAP))))
export const timeLabel=(time,step)=>new Intl.DateTimeFormat('en-GB',step<86400000?{hour:'2-digit',minute:'2-digit'}:{month:'2-digit',day:'2-digit'}).format(time)
export const timeTooltip=time=>new Intl.DateTimeFormat('en-GB',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(time)
const metricLabels={completed:'Completed',failed:'Failed',pending:'Running',ttft:'TTFT',reasoning:'Reasoning',text:'Answers',toolarg:'Tool args',other:'Other',unsegmented:'Unrecorded'}

function metricPair(total,mode){
 const {value,parts,missing}=usageBar(total,mode)
 const input={value,parts:parts.map(p=>({...p,label:metricLabels[p.key]??p.label,color:requestColors[p.key]??timelineColors[p.key]??p.color}))}
 return {input,output:{value:0,parts:[]},missing}
}
export function timelinePairs(timeline,role,mode='tokens'){
 if(timeline?.version!==1)return []
 return timeline.buckets.map(bucket=>{
  const rows=role==='all'?bucket.roles:bucket.roles.filter(row=>row.role===role)
  const total=totalRoles(rows)
  const pair=mode==='tokens'?tokenPair(total,timelineColors):metricPair(total,mode)
  return {...pair,role:String(bucket.from),label:timeLabel(bucket.from,timeline.step),from:bucket.from,to:bucket.to}
 })
}

// Each small chart merges whole adjacent server buckets; never interpolate usage.
export function coarsenTimeline(timeline,capacity){
 if(timeline?.version!==1)return undefined
 const count=Math.max(1,Math.floor(capacity)),source=timeline.buckets
 if(source.length<=count)return timeline
 const stride=Math.ceil(source.length/count),buckets=[]
 for(let i=0;i<source.length;i+=stride){
  const group=source.slice(i,i+stride)
  const rows=group.flatMap(bucket=>bucket.roles)
  const roles=['coordinator','analysis','planning','writing'].map(role=>({
   ...totalRoles(rows.filter(row=>row.role===role)),role,
  }))
  buckets.push({from:group[0].from,to:group.at(-1).to,roles})
 }
 return {...timeline,step:timeline.step*stride,buckets}
}
