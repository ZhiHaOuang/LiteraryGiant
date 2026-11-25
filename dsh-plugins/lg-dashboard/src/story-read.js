import {characterPortraits} from '../../lg-books/src/story-data/presentation-fields.js'
import {requestBooks} from './api.js'
export const STORY_READ_API='lg.story-data.read.v1'
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)
const count=v=>Number.isInteger(v)&&v>=0
const arrays=(v,keys)=>object(v)&&keys.every(key=>Array.isArray(v[key]))
const strings=v=>Array.isArray(v)&&v.every(x=>typeof x==='string')
const record=r=>object(r)&&typeof r.id==='string'&&typeof r.type==='string'&&typeof r.title==='string'&&typeof r.summary==='string'&&typeof r.revision==='string'
 &&object(r.payload)&&object(r.scope)&&strings(r.scope.targets)&&typeof r.scope.description==='string'&&object(r.story_time)&&typeof r.story_time.kind==='string'
 &&Array.isArray(r.evidence)&&r.evidence.every(e=>object(e)&&Number.isInteger(e.document_id)&&Number.isInteger(e.version_id)&&Number.isInteger(e.paragraph)&&typeof e.quote==='string')
 &&Array.isArray(r.links)&&r.links.every(l=>object(l)&&typeof l.target==='string'&&typeof l.relation==='string')&&strings(r.related_changed)
 &&['candidate','confirmed','rejected','withdrawn'].includes(r.approval)&&['current','stale','invalid','unavailable'].includes(r.freshness)
 &&(r.type!=='entity'||typeof r.payload.name==='string'&&typeof r.payload.entity_kind==='string')
const records=(v,keys)=>arrays(v,keys)&&keys.every(key=>v[key].every(record))
// A new source revision invalidates the position of every subsequent page.
export function shouldRestartStoryPage(previous,value,key,page){
 return page>0&&previous?.key===key&&['book_id','api_version','data_revision'].some(k=>previous[k]!==value[k])
}
export function validateStoryResponse(action,value){
 if(!value||value.api_version!==STORY_READ_API||typeof value.data_revision!=='string'||!/^[a-f0-9]{64}$/u.test(value.data_revision))throw Error('故事资料接口版本不匹配，请保存工作并重新加载应用。')
 let valid=typeof value.book_id==='string'&&arrays(value,['chapters','entities'])&&value.chapters.every(c=>object(c)&&Number.isInteger(c.id)&&typeof c.title==='string')
 if(action==='story-data')valid&&=records(value,['records'])&&Array.isArray(value.runs)&&count(value.total)&&count(value.offset)&&count(value.limit)&&value.limit>0&&object(value.catalog)&&object(value.counts)&&object(value.directory)
 else if(action==='story-time')valid&&=records(value,['records'])&&Array.isArray(value.events)&&object(value.directory)&&arrays(value.timeline,['groups','unplaced','relations','warnings'])&&value.timeline.groups.every(g=>object(g)&&strings(g.events))&&(value.character===null||records(value.character,['certain','uncertain'])&&Array.isArray(value.character.conflicts))
 else if(action==='story-overview')valid&&=object(value.counts)&&count(value.total)&&arrays(value.coverage,['chapters'])&&count(value.coverage.total_chapters)&&count(value.coverage.registered_chapters)&&arrays(value.quality,['source_issues','dependency_issues','unplaced_events','unknown_state_time','unrated_characters','scoped_roles','possible_duplicates'])&&count(value.quality.candidate)&&count(value.quality.confirmed)&&value.quality.possible_duplicates.every(x=>object(x)&&typeof x.name==='string'&&Array.isArray(x.ids))
 else valid=false
 if(!valid)throw Error('故事资料响应不完整，未将缺失资料解释为空。')
 return value
}
export async function requestStory(input,signal){return validateStoryResponse(input.action,await requestBooks(input,signal))}

// A running older books service can return raw portraits without the card summary.
export async function withCharacterPortraits(page,input,cache,signal,read=requestStory){
 if(!page.counts.portrait||page.records.every(r=>Object.hasOwn(r.display??{},'character_portrait')
  &&(!r.display.character_portrait||Array.isArray(r.display.character_portrait.traits))))return page
 const {through_chapter,confirmed_only,audience,holder}=input.options
 const scope={through_chapter,confirmed_only,audience,holder}
 const key=JSON.stringify([input.path,page.book_id,page.data_revision,scope])
 if(cache.current?.key!==key){
  const records=[]
  do{
   const offset=records.length
   const batch=await read({action:'story-data',path:input.path,options:{...scope,type:'portrait',limit:200,offset}},signal)
   signal.throwIfAborted()
   if(batch.book_id!==page.book_id||batch.data_revision!==page.data_revision||batch.offset!==offset)throw Error('资料已更新，请刷新后查看侧写。')
   records.push(...batch.records)
   if(records.length>=batch.total)break
   if(!batch.records.length)throw Error('人物侧写读取不完整，请刷新。')
  }while(true)
  cache.current={key,records}
 }
 const portraits=characterPortraits(cache.current.records,page.records)
 return {...page,records:page.records.map(r=>({...r,display:{...r.display,character_portrait:portraits.get(r.id)??null}}))}
}
