// Pure story-time operations. Reading order and database timestamps never enter this module.
const units={minute:1,hour:60,day:1440}
const MAX_QUERY_RECORDS=5000,MAX_QUERY_EVENTS=500,MAX_WRITE_RECORDS=50000
function bounded(records,strict){
 const maximum=strict?MAX_WRITE_RECORDS:MAX_QUERY_RECORDS
 if(!Array.isArray(records)||records.length>maximum)throw Error(`故事时序超过单次 ${maximum} 条记录上限`)
 if(!strict&&records.filter(r=>r.type==='event').length>MAX_QUERY_EVENTS)throw Error('故事时序超过单次查询 500 个事件上限，请缩小阅读范围')
}
function finite(value){return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12}
function coordinate(c){
 if(!c)return null
 if(typeof c.axis!=='string'||!c.axis.trim()||!units[c.unit]||!['start_min','start_max','end_min','end_max'].every(k=>finite(c[k])))throw Error('故事时间坐标无效')
 const n=Object.fromEntries(['start_min','start_max','end_min','end_max'].map(k=>[k,c[k]*units[c.unit]]))
 if(n.start_min>n.start_max||n.end_min>n.end_max||n.start_min>n.end_max)throw Error('故事时间起止范围矛盾')
 // A feasible interval cannot end before its start, even when either endpoint is uncertain.
 n.end_min=Math.max(n.end_min,n.start_min);n.start_max=Math.min(n.start_max,n.end_max)
 return {axis:c.axis,...n}
}
function sameKey(r){
 const p=r.payload
 if(r.type==='state')return JSON.stringify([r.type,p.subject,p.facet])
 if(r.type==='knowledge')return p.topic?JSON.stringify([r.type,p.holder,p.topic]):null
 if(r.type==='relation')return JSON.stringify([r.type,p.subject,p.object,p.relation])
 return null
}
function verifyChains(records,byId){
 const done=new Set()
 for(const r of records){
  if(r.type==='role_assignment'&&byId.get(r.payload.subject)?.payload.entity_kind!=='character')throw Error('叙事角色必须属于人物')
  const previous=r.payload.previous_record
  if(!previous)continue
  const p=byId.get(previous),key=sameKey(r)
  if(!p||!key||sameKey(p)!==key)throw Error('前序记录必须属于同一人物／主体及同一状态属性或认知主题')
 }
 for(const r of records){
  const active=new Set();let current=r
  while(current&&!done.has(current.id)){
   if(active.has(current.id))throw Error('状态／认知前序关系存在循环')
   active.add(current.id);current=byId.get(current.payload.previous_record)
  }
  for(const id of active)done.add(id)
 }
}
function build(records,strict=true){
 bounded(records,strict)
 let work=0
 const spend=(n=1)=>{work+=n;if(work>20_000_000)throw Error('时间约束检查超过计算预算，请拆分或复核过密关联；未返回不完整结果')}
 const byId=new Map(records.map(r=>[r.id,r])),events=records.filter(r=>r.type==='event'),eventIds=new Set(events.map(r=>r.id)),warnings=[],edges=[],overlaps=[],same=[]
 if(byId.size!==records.length)throw Error('时序记录 ID 重复')
 if(strict)verifyChains(records,byId)
 const requireEvent=id=>{
  if(eventIds.has(id))return true
  if(strict)throw Error('时间边界引用缺失或不是事件：'+id)
  if(!warnings.includes('部分时间依据不在当前可见范围；相关顺序保持未知'))warnings.push('部分时间依据不在当前可见范围；相关顺序保持未知')
  return false
 }
 const edge=(a,b)=>{const left=requireEvent(a),right=requireEvent(b);if(left&&right){if(a===b)throw Error('事件不能先于或晚于自身');edges.push([a,b])}}
 for(const r of records){
  const t=r.story_time??{},o=t.offset
  if(t.after_event)requireEvent(t.after_event)
  if(t.before_event)requireEvent(t.before_event)
  if(r.type==='event'){
   if(t.after_event)edge(t.after_event,r.id)
   if(t.before_event)edge(r.id,t.before_event)
  }else if(t.after_event&&t.before_event)edge(t.after_event,t.before_event)
  coordinate(t.coordinate)
  if(o){
   if(!units[o.unit]||!finite(o.min)||!finite(o.max)||o.min>o.max||!['start','end'].includes(o.anchor_point))throw Error('相对时间偏移无效')
   requireEvent(o.anchor_event)
   if(r.id===o.anchor_event)throw Error('相对时间不能锚定自身')
   // Only an offset after the END guarantees that the entire anchor precedes this event.
   if(r.type==='event'&&o.anchor_point==='end'&&o.min>0)edge(o.anchor_event,r.id)
  }
  for(const l of r.links??[]){
   if(!['before','simultaneous','overlaps'].includes(l.relation))continue
   if(r.type!=='event')throw Error('时间关系只能连接事件')
   if(!requireEvent(l.target))continue
   if(l.target===r.id)throw Error('事件时间关系不能引用自身')
   if(l.relation==='before')edge(r.id,l.target)
   else (l.relation==='simultaneous'?same:overlaps).push([r.id,l.target])
  }
 }
 const coords=new Map(events.map(r=>[r.id,coordinate(r.story_time?.coordinate)]).filter(([,c])=>c))
 // Propagate known anchor coordinates. Offsets constrain a START, not an invented duration.
 const anchoredBy=new Map(events.map(r=>[r.id,[]])),anchorDegree=new Map(events.map(r=>[r.id,0]))
 for(const r of events){const a=r.story_time?.offset?.anchor_event;if(eventIds.has(a)){anchoredBy.get(a).push(r.id);anchorDegree.set(r.id,1)}}
 const anchorQueue=[...anchorDegree].filter(([,degree])=>degree===0).map(([id])=>id)
 for(let i=0;i<anchorQueue.length;i++){
   const r=byId.get(anchorQueue[i]);spend()
   const o=r.story_time?.offset,anchor=o&&coords.get(o.anchor_event)
   const lo=anchor?.[o?.anchor_point+'_min'],hi=anchor?.[o?.anchor_point+'_max']
   if(anchor&&Number.isFinite(lo)&&Number.isFinite(hi)){
   const start_min=lo+o.min*units[o.unit],start_max=hi+o.max*units[o.unit],old=coords.get(r.id)
   if(!Number.isFinite(start_min)||!Number.isFinite(start_max)||Math.max(Math.abs(start_min),Math.abs(start_max))>Number.MAX_SAFE_INTEGER)throw Error('相对时间累计超出可安全比较的数值范围')
   if(old){
    if(old.axis!==anchor.axis||old.start_max<start_min||old.start_min>start_max)throw Error('事件坐标与相对偏移矛盾')
   }else coords.set(r.id,{axis:anchor.axis,start_min,start_max,end_min:start_min,end_max:Infinity})
  }
  for(const next of anchoredBy.get(r.id)){anchorDegree.set(next,0);anchorQueue.push(next)}
 }
 if(anchorQueue.length!==events.length)throw Error('相对时间锚点存在循环；同一时段请使用同时关系')
 // Only disjoint, fully bounded ranges prove a chronological order.
 // Writes validate numeric constraints along explicit graph paths below, without an all-pairs graph.
 if(!strict)for(let i=0;i<events.length;i++)for(let j=i+1;j<events.length;j++){
  spend()
  const a=events[i].id,b=events[j].id,x=coords.get(a),y=coords.get(b)
  if(!x||!y||x.axis!==y.axis)continue
  if(x.end_max<y.start_min)edges.push([a,b])
  if(y.end_max<x.start_min)edges.push([b,a])
 }
 const parent=new Map(events.map(r=>[r.id,r.id]))
 function find(id){while(parent.get(id)!==id){parent.set(id,parent.get(parent.get(id)));id=parent.get(id)}return id}
 for(const [a,b] of same){
  const x=coords.get(a),y=coords.get(b)
  if(x&&y&&x.axis===y.axis&&(x.start_max<y.start_min||y.start_max<x.start_min||x.end_max<y.end_min||y.end_max<x.end_min))throw Error('同时事件的时间坐标不相容')
  const ra=find(a),rb=find(b);if(ra!==rb)parent.set(rb,ra)
 }
 const groups=new Map()
 for(const r of events){const id=find(r.id),items=groups.get(id)??[];items.push(r.id);groups.set(id,items)}
 for(const members of groups.values())members.sort()
 for(const members of groups.values()){
  const axes=new Map()
  for(const id of members){const c=coords.get(id);if(!c)continue;const a=axes.get(c.axis)??[];a.push(c);axes.set(c.axis,a)}
  for(const values of axes.values())if(Math.max(...values.map(c=>c.start_min))>Math.min(...values.map(c=>c.start_max))||Math.max(...values.map(c=>c.end_min))>Math.min(...values.map(c=>c.end_max)))throw Error('同时事件的时间坐标不相容')
 }
 const graph=new Map([...groups.keys()].map(id=>[id,new Set()])),incoming=new Map([...groups.keys()].map(id=>[id,0]))
 for(const [a,b] of edges){
  const x=coords.get(a),y=coords.get(b)
  if(x&&y&&x.axis===y.axis&&x.end_min>=y.start_max)throw Error('事件先后关系与时间坐标矛盾')
  const left=find(a),right=find(b)
  if(left===right)throw Error('事件先后关系与同时关系矛盾')
  if(!graph.get(left).has(right)){graph.get(left).add(right);incoming.set(right,incoming.get(right)+1)}
 }
 const indegree=new Map(incoming),layers=[];let count=0,queue=[...indegree].filter(([,n])=>n===0).map(([id])=>id).sort()
 while(queue.length){
  layers.push(queue);count+=queue.length;const next=[]
  for(const a of queue)for(const b of graph.get(a)){indegree.set(b,indegree.get(b)-1);if(indegree.get(b)===0)next.push(b)}
  queue=next.sort()
 }
 if(count!==groups.size)throw Error('事件先后关系存在循环')
 if(strict){
  // Propagate only earliest known endpoint bounds, per axis, through the DAG.
  // This checks A(date)->B(unknown)->C(date) without a quadratic reachability closure.
  const earliest=new Map([...groups.keys()].map(id=>[id,new Map()]))
  for(const layer of layers)for(const id of layer){
   const bounds=earliest.get(id)
   for(const member of groups.get(id)){
    const c=coords.get(member);if(!c)continue
    if(bounds.has(c.axis)&&bounds.get(c.axis)>=c.start_max)throw Error('传递事件先后关系与时间坐标矛盾')
   }
   for(const member of groups.get(id)){const c=coords.get(member);if(c)bounds.set(c.axis,Math.max(bounds.get(c.axis)??-Infinity,c.end_min))}
   for(const next of graph.get(id))for(const [axis,value] of bounds){spend();const target=earliest.get(next);target.set(axis,Math.max(target.get(axis)??-Infinity,value))}
  }
  const precedes=(from,to)=>{
   const start=find(from),target=find(to),seen=new Set(),pending=[start]
   while(pending.length){const n=pending.pop();if(seen.has(n))continue;seen.add(n);spend();for(const next of graph.get(n)){spend();if(next===target)return true;pending.push(next)}}
   return false
  }
  for(const [a,b] of overlaps){const x=coords.get(a),y=coords.get(b);if(precedes(a,b)||precedes(b,a)||(x&&y&&x.axis===y.axis&&(x.end_max<y.start_min||y.end_max<x.start_min)))throw Error('重叠事件与先后关系或坐标矛盾')}
  for(const r of records){
   const previous=byId.get(r.payload.previous_record),now=r.payload.trigger_event,then=previous?.payload.trigger_event
   if(previous&&eventIds.has(now)&&eventIds.has(then)&&precedes(now,then))throw Error('前序状态／认知的触发事件晚于后续记录')
  }
  return {warnings}
 }
 const reachable=new Map()
 for(const id of groups.keys()){
  const seen=new Set(),stack=[...graph.get(id)]
  while(stack.length){spend();const n=stack.pop();if(seen.has(n))continue;seen.add(n);stack.push(...graph.get(n))}
  reachable.set(id,seen)
 }
 const before=(a,b)=>eventIds.has(a)&&eventIds.has(b)&&reachable.get(find(a)).has(find(b))
 for(const [a,x] of coords)for(const [b,y] of coords)if(a!==b&&x.axis===y.axis&&before(a,b)&&x.end_min>=y.start_max)throw Error('传递事件先后关系与时间坐标矛盾')
 for(const [a,b] of overlaps){
  const x=coords.get(a),y=coords.get(b)
  if(before(a,b)||before(b,a)||(x&&y&&x.axis===y.axis&&(x.end_max<y.start_min||y.end_max<x.start_min)))throw Error('重叠事件与先后关系或坐标矛盾')
 }
 return {byId,events,eventIds,warnings,edges,overlaps,same,groups,graph,incoming,layers,coords,before,equal:(a,b)=>eventIds.has(a)&&eventIds.has(b)&&find(a)===find(b)}
}

export function verifyTemporalGraph(records){build(records);return true}

export function timelineView(records){
 const result=build(records,false),{groups,graph,incoming}=result
 const unplaced=[...groups].filter(([id,members])=>members.length===1&&!graph.get(id).size&&!incoming.get(id)&&!result.coords.has(id)&&!result.overlaps.some(pair=>pair.includes(id))).flatMap(([,ids])=>ids).sort()
 const hidden=new Set(unplaced)
 const relations=[...result.edges.map(([from,to])=>({from,to,relation:'before'})),...result.same.map(([from,to])=>({from,to,relation:'simultaneous'})),...result.overlaps.map(([from,to])=>({from,to,relation:'overlaps'}))]
 const unique=[...new Map(relations.map(r=>[JSON.stringify(r),r])).values()]
 return {groups:result.layers.map(layer=>({events:layer.flatMap(id=>groups.get(id)).filter(id=>!hidden.has(id)).sort(),simultaneous:layer.map(id=>groups.get(id)).filter(ids=>ids.length>1),note:'依赖展示层；组内未声明同时的事件先后未知，跨层也不代表任意两事件都有先后关系。'})).filter(g=>g.events.length),relations:unique,unplaced,warnings:[...result.warnings,'仅依据已登记时间约束；未知顺序不会按章序或写入时间补齐。']}
}

function boundary(g,bound,event,phase,after){
 if(!g.eventIds.has(bound))return null
 if(g.equal(bound,event))return after?phase==='after':phase==='before'
 if(g.before(bound,event))return after
 if(g.before(event,bound))return !after
 return null
}
function applicability(g,r,event,phase){
 const t=r.story_time??{}
 if(t.kind==='all')return true
 const checks=[]
 if(t.offset)checks.push(null)
 if(t.after_event)checks.push(boundary(g,t.after_event,event,phase,true))
 if(t.before_event)checks.push(boundary(g,t.before_event,event,phase,false))
 if(t.coordinate){
  const own=coordinate(t.coordinate),target=g.coords.get(event)
  if(!target||target.axis!==own.axis)checks.push(null)
  else {
   const a=target[(phase==='before'?'start':'end')+'_min'],b=target[(phase==='before'?'start':'end')+'_max']
   // State coordinate intervals use [start,end); the event-side before/after limit is explicit.
   if(phase==='before')checks.push(b<=own.start_min||a>own.end_max?false:a>own.start_max&&b<=own.end_min?true:null)
   else checks.push(b<own.start_min||a>=own.end_max?false:a>=own.start_max&&b<own.end_min?true:null)
  }
 }
 if(checks.some(v=>v===false))return false
 if(checks.length)return checks.every(v=>v===true)?true:null
 // A trigger establishes a change, but without an end we cannot assume persistence forever.
 const trigger=r.payload.trigger_event
 if(trigger&&g.eventIds.has(trigger)){
  if(g.equal(trigger,event))return phase==='after'
  if(g.before(event,trigger))return false
 }
 return null
}

export function characterAt(records,{subject,event,phase='after'}={}){
 if(!['before','after'].includes(phase))throw Error('请选择事件之前或之后')
 const g=build(records,false),person=g.byId.get(subject)
 if(person?.type!=='entity'||person.payload.entity_kind!=='character')throw Error('人物查询需要可见的人物实体')
 if(!g.eventIds.has(event))throw Error('查询事件不在当前可见范围')
 const certain=[],uncertain=[],conflicts=[]
 for(const r of records){
  if(!['state','relation','knowledge','role_assignment','portrait'].includes(r.type))continue
  const p=r.payload
  if((p.subject??p.holder)!==subject&&!(r.type==='relation'&&p.object===subject))continue
  let status=applicability(g,r,event,phase)
  const scoped=r.scope?.kind
  if(scoped&&scoped!=='book'&&!(r.scope?.targets??[]).includes(event)&&!(scoped==='entity'&&(r.scope.targets??[]).includes(subject))&&status===true)status=null
  if(status===true)certain.push(r)
  else if(status===null)uncertain.push(r)
 }
 const keyed=new Map()
 for(const r of certain){const key=sameKey(r);if(!key)continue;const group=keyed.get(key)??[];group.push(r);keyed.set(key,group)}
 for(const rows of keyed.values()){
  const value=r=>JSON.stringify(r.type==='state'?r.payload.value:r.type==='knowledge'?[r.payload.proposition,r.payload.stance]:r.payload.description)
  if(new Set(rows.map(value)).size>1)conflicts.push({records:rows.map(r=>r.id),reason:'同一维度存在多个不同描述；可能并存或冲突，需要作者核对，不按最后写入覆盖。'})
 }
 return {certain,uncertain,conflicts,warnings:[...g.warnings,...(uncertain.some(r=>r.story_time?.offset)?['状态／认知偏移尚未解析为有效区间，保留为时间不确定。']:[]),'只查询已提供的可见记录；没有记录不代表人物没有经历或不知道。'],event,phase,subject}
}
