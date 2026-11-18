import {references} from './validate.js'
import catalog from './catalog.json' with {type:'json'}

const entityKinds=['character','group','place','object','concept']
const prominenceOrder=['core','major','supporting','minor','unknown']
const typeOrder=Object.keys(catalog)
const facets={summary:'概括',rhythm:'节奏',emotion:'情绪',style:'文风',theme:'主题',logic:'逻辑',desire:'欲望',value:'价值取向',fear:'恐惧',behavior:'行为倾向',voice:'表达习惯',contradiction:'内在矛盾',growth:'变化'}
const compareText=(a,b)=>a.localeCompare(b,'zh-CN',{numeric:true})
const short=text=>Array.from(String(text??'').replace(/\s+/gu,' ').trim()).slice(0,56).join('')

function characterRoles(records){
 const bySubject=new Map()
 for(const record of records){
  if(record.type!=='role_assignment'||!['confirmed','candidate'].includes(record.approval)||record.freshness!=='current'||record.related_changed.length)continue
  const roles=bySubject.get(record.payload.subject)??[]
  roles.push(record);bySubject.set(record.payload.subject,roles)
 }
 return new Map([...bySubject].map(([subject,records])=>{
  // A stage-specific identity cannot silently become the character's whole-book rank.
  const global=records.filter(r=>r.scope.kind==='book'&&!r.scope.targets.length&&r.story_time.kind==='all')
  const confirmed=global.filter(r=>r.approval==='confirmed')
  const selected=confirmed.length?confirmed:global
  const levels=new Set(selected.map(r=>r.payload.prominence))
  const prominence=levels.size===1?[...levels][0]:'unknown'
  return [subject,{
   prominence,
   status:levels.size>1?'conflict':!global.length?'scoped':prominence==='unknown'?'unrated':'rated',
   approval:selected.length?(confirmed.length?'confirmed':'candidate'):null,
   roles:[...new Set(selected.flatMap(r=>r.payload.roles))].sort(compareText),
   assignments:records.sort((a,b)=>compareText(a.id,b.id)).map(r=>({id:r.id,prominence:r.payload.prominence,
    roles:r.payload.roles,approval:r.approval,scope:r.scope,story_time:r.story_time,summary:r.summary})),
  }]
 }))
}

// Source positions describe reading order, never inferred in-world chronology.
export function sourceLocations(documents,chapters){
 const byId=new Map(documents.map(d=>[d.id,d]))
 const chapterNumbers=new Map(chapters.map((c,i)=>[c.id,i+1]))
 return new Map(documents.map(document=>{
  let current=document
  const seen=new Set(),order=[]
  while(current&&!chapterNumbers.has(current.id)&&!seen.has(current.id)){
   seen.add(current.id);order.unshift(current.sequence);current=byId.get(current.parent_id)
  }
  return [document.id,current&&chapterNumbers.has(current.id)?{
   chapter:chapterNumbers.get(current.id),chapter_title:current.title,
   document_title:document.title,document_order:order,
  }:null]
 }))
}

function compareSource(a,b){
 const left=a.display.source,right=b.display.source
 const chapter=(left?.chapter??Infinity)-(right?.chapter??Infinity)
 if(chapter)return chapter
 const l=left?.document_order??[],r=right?.document_order??[]
 for(let i=0;i<Math.max(l.length,r.length);i++){
  const delta=(l[i]??-1)-(r[i]??-1)
  if(delta)return delta
 }
 return (left?.paragraph??Infinity)-(right?.paragraph??Infinity)||0
}

export function presentStoryRecords(records,locations){
 const counts=new Map(),names=new Map(records.filter(r=>r.type==='entity').map(r=>[r.id,r.payload.name]))
 const roles=characterRoles(records)
 const revelations=new Map()
 for(const record of records){
  if(record.type!=='revelation'||!['confirmed','candidate'].includes(record.approval)||record.freshness!=='current'||record.related_changed.length)continue
  const targets=new Set([record.payload.about_record,...record.links.filter(l=>l.relation==='reveals').map(l=>l.target)].filter(Boolean))
  for(const target of targets){const items=revelations.get(target)??[];items.push({id:record.id,approval:record.approval,presentation:record.payload.presentation});revelations.set(target,items)}
 }
 // Count distinct, visible, non-rejected records. Repeated links in one record count once.
 for(const record of records){
  if(['rejected','withdrawn'].includes(record.approval))continue
  for(const id of new Set(references(record).map(([id])=>id))){
   if(id!==record.id)counts.set(id,(counts.get(id)??0)+1)
  }
 }
 const presented=records.map(record=>{
  const sources=record.evidence.map(e=>{
   const location=locations.get(e.document_id)
   return location?{...location,paragraph:e.paragraph,document_id:e.document_id}:null
  }).filter(Boolean).sort((a,b)=>compareSource({display:{source:a}},{display:{source:b}}))
  const source=sources[0]??null,p=record.payload
  const facet=facets[p.dimension??p.aspect]??p.facet??''
  const subject=names.get(p.subject??p.holder)
  let title=record.type==='entity'?p.name:record.title
  // Generic chapter headings describe a category; use the existing judgment as the title.
  const generic=/^(?:本章|本节|章节|本场景|全书|本书|第[\d一二三四五六七八九十百零〇]+章)/u.test(title)
  if(record.type==='analysis'||generic)title=short(record.summary)||title
  if(record.type==='portrait'&&subject&&!title.includes(subject))title=`${subject} · ${title}`
  return {...record,display:{title,category:catalog[record.type].label,facet,source,
   source_chapters:[...new Set(sources.map(s=>s.chapter))],
   related_count:counts.get(record.id)??0,entity_kind:p.entity_kind??null,
   ...(record.type==='world_rule'?{reader_visibility:{state:(revelations.get(record.id)??[]).some(r=>r.presentation!=='hint')?'revealed':'unmarked',revelations:revelations.get(record.id)??[]}}:{}),
   ...(record.type==='entity'&&p.entity_kind==='character'?{character_role:roles.get(record.id)??{prominence:'unknown',status:'unrated',approval:null,roles:[],assignments:[]}}:{})}}
 })
 // Do not collapse records with the same label. Distinguish even identical excerpts deterministically.
 const duplicates=new Map()
 for(const record of presented){
  const key=`${record.type}:${record.display.source?.chapter??''}:${record.display.title}`
  const group=duplicates.get(key)??[];group.push(record);duplicates.set(key,group)
 }
 for(const group of duplicates.values())if(group.length>1){
  group.sort((a,b)=>compareSource(a,b)||compareText(a.id,b.id))
  group.forEach((r,i)=>{r.display.title+=` · 记录 ${i+1}`})
 }
 return presented
}

export function sortStoryRecords(records,sort='recommended',type=''){
 const entityOrder=(a,b)=>entityKinds.indexOf(a.payload.entity_kind)-entityKinds.indexOf(b.payload.entity_kind)
 return [...records].sort((a,b)=>{
  const name=()=>compareText(a.display.title,b.display.title)||compareText(a.id,b.id)
  if(sort==='name')return name()
  if(type==='entity'&&['recommended','importance','references'].includes(sort)){
   const importance=sort==='references'?0:prominenceOrder.indexOf(a.display.character_role?.prominence??'unknown')-prominenceOrder.indexOf(b.display.character_role?.prominence??'unknown')
   const rank=entityOrder(a,b)||importance||b.display.related_count-a.display.related_count
   if(rank)return rank
  }
  return compareSource(a,b)||typeOrder.indexOf(a.type)-typeOrder.indexOf(b.type)||name()
 })
}

export function validatePresentationOptions(options){
 if(options.dimension&&(!['summary','rhythm','emotion','style','theme','logic'].includes(options.dimension)||options.type!=='analysis'))throw Error('分析维度无效')
 if(options.thread_kind&&(!['conflict','mystery','foreshadowing','relationship','goal'].includes(options.thread_kind)||options.type!=='thread'))throw Error('线索类别无效')
 if(options.reader_visibility&&(!['revealed','unrevealed','unmarked'].includes(options.reader_visibility)||options.type!=='world_rule'))throw Error('读者揭露筛选无效')
 if(options.sort&&!['recommended','importance','source','name','references'].includes(options.sort))throw Error('未知资料排序方式')
 if(options.sort==='importance'&&options.type!=='entity')throw Error('重要程度排序仅用于实体')
 if(options.sort==='references'&&options.type!=='entity')throw Error('关联数量排序仅用于实体')
 if(options.entity_kind&&(!entityKinds.includes(options.entity_kind)||options.type!=='entity'))throw Error('实体分类无效')
}
