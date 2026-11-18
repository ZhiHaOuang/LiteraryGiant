import {readStoryData} from './store.js'
import {openBook} from '../read.js'
import {timelineView,characterAt} from './temporal.js'
import {digest} from './validate.js'
import {sortStoryRecords} from './presentation.js'

// Author-facing query. Runtime identity/capability checks belong to the caller.
// Character contexts receive only the filtered knowledge projection in lg-context.
export function readStoryTime(directory,options={},snapshot=null) {
 const allowed=['subject','event','phase','through_chapter','include_candidates']
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!allowed.includes(k)))throw Error('未知故事时间参数')
 for(const key of ['subject','event'])if(options[key]!==undefined&&(typeof options[key]!=='string'||!/^[A-Za-z][A-Za-z0-9:_-]{0,119}$/u.test(options[key])))throw Error('故事对象标识无效')
 if(options.phase!==undefined&&!['before','after'].includes(options.phase))throw Error('请选择事件之前或之后')
 if(options.include_candidates!==undefined&&typeof options.include_candidates!=='boolean')throw Error('候选筛选参数无效')
 const book=snapshot??openBook(directory)
 try {
 const records=[],query={through_chapter:options.through_chapter,confirmed_only:!options.include_candidates,limit:200}
 let first
 // All pages and source checks use one SQLite read transaction.
 const collect=()=>{
  const values=[];let page
  for(let offset=0;offset<5000;offset+=200){
   page=readStoryData(directory,{...query,offset},book);if(page.total>5000)throw Error('故事时间查询超过 5000 条；请缩小阅读范围')
   if(!first)first=page
   values.push(...page.records)
   if(offset+200>=page.total)return values
  }
  throw Error('故事时间查询超过上限')
 }
 const raw=collect()
 book.verify()
 const usable=raw.filter(r=>!['rejected','withdrawn'].includes(r.approval)&&r.freshness==='current'&&!r.related_changed.length)
 records.push(...usable)
 const entities=sortStoryRecords(records.filter(r=>r.type==='entity'),'recommended','entity').map(r=>({id:r.id,name:r.payload.name,kind:r.payload.entity_kind}))
 const events=records.filter(r=>r.type==='event').map(r=>({id:r.id,title:r.title}))
 if(options.subject&&!entities.some(e=>e.id===options.subject&&e.kind==='character'))throw Error('人物不在当前有效资料范围内')
 if(options.event&&!events.some(e=>e.id===options.event))throw Error('事件不在当前有效资料范围内')
 const timeline=timelineView(records)
 const character=options.subject&&options.event?characterAt(records,{subject:options.subject,event:options.event,phase:options.phase??'after'}):null
 if(raw.length!==records.length)timeline.warnings.push('已排除来源失效、关联变化或被撤回的记录。')
 return {timeline,character,entities,events,records,chapters:first.chapters,
  directory:Object.fromEntries(records.map(r=>[r.id,{title:r.title,type:r.type}])),revision:digest(raw),
  coverage_notice:'仅依据当前有效记录计算。组内未确定先后的事件不代表同时发生；未登记不代表不存在。'+(options.include_candidates?'包含未确认候选，仅供作者审阅。':'仅使用作者已确认记录。')}
 }finally{if(!snapshot)book.close()}
}
