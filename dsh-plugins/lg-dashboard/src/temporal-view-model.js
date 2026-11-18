const units={minute:'分钟',hour:'小时',day:'天'}
const range=(min,max)=>min===max?String(min):`${min}–${max}`

// Display only recorded coordinates. A label or reading position is never parsed into time.
export function formatStoryTime(time={},directory={}){
 const parts=[]
 if(time.label)parts.push(time.label)
 if(time.coordinate){
  const c=time.coordinate
  parts.push(`时间轴「${c.axis}」：开始 ${range(c.start_min,c.start_max)}，结束 ${range(c.end_min,c.end_max)} ${units[c.unit]??c.unit}`)
 }
 if(time.offset){
  const o=time.offset
  parts.push(`相对 ${directory[o.anchor_event]?.title??o.anchor_event} 的${o.anchor_point==='start'?'开始':'结束'}：${range(o.min,o.max)} ${units[o.unit]??o.unit}`)
 }
 if(time.kind==='unknown')parts.push('发生时间未确定')
 if(time.kind==='all')parts.push('适用范围内持续成立')
 return parts.join(' · ')||({relative:'相对事件时间',interval:'事件之间的区间',range:'时间范围'}[time.kind]??'未登记时间')
}

export function temporalOptions({subject='',event='',phase='after',through='',includeCandidates=false}={}){
 return {
  phase:phase==='before'?'before':'after',include_candidates:includeCandidates===true,
  ...(subject?{subject}:{}),...(event?{event}:{}),
  ...(through?{through_chapter:Number(through)}:{}),
 }
}

export function pageSlice(items,page,size=12){
 const pages=Math.max(1,Math.ceil(items.length/size)),current=Math.min(Math.max(0,page),pages-1)
 return {items:items.slice(current*size,(current+1)*size),page:current,pages,total:items.length}
}
