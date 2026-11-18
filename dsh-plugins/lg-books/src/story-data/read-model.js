import {openBook} from '../read.js'
import {readStoryData} from './store.js'
import {readStoryTime} from './queries.js'
import {digest,VERSION} from './validate.js'
export const READ_API='lg.story-data.read.v1'
export function sourceRevision(book){
 const exists=book.db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_story_data_records'").get()
 return digest({book_id:book.project.project_id,records:exists?book.db.prepare('SELECT * FROM lg_story_data_records ORDER BY id').all():[],
  documents:book.db.prepare('SELECT d.id,d.title,d.kind,d.parent_id,d.sequence,d.state,d.active_version_id,v.content FROM documents d LEFT JOIN document_versions v ON v.id=d.active_version_id ORDER BY d.id').all().map(({content,...d})=>({...d,content_hash:digest(content??'')}))})
}
function envelope(book,value){return {...value,api_version:READ_API,data_revision:sourceRevision(book),book_id:book.project.project_id}}
export function readStoryPage(directory,options={}){
 const book=openBook(directory)
 try{return envelope(book,{directory:{},entities:[],offset:0,limit:options.limit??50,...readStoryData(directory,options,book)})}finally{book.close()}
}
export function readStoryTimeline(directory,options={}){
 const book=openBook(directory)
 try{return envelope(book,readStoryTime(directory,options,book))}finally{book.close()}
}
export function collectStoryView(directory,options={},snapshot=null){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['through_chapter','confirmed_only'].includes(k)))throw Error('资料概览仅接受阅读范围和确认筛选')
 const book=snapshot??openBook(directory)
 try{
  const records=[];let page
  for(let offset=0;offset<5000;offset+=200){
   const value=readStoryData(directory,{...options,limit:200,offset},book);page??=value
   if(value.total>5000)throw Error('资料快照超过 5000 条，请缩小范围')
   records.push(...value.records)
   if(offset+200>=value.total)break
  }
  const timeline=readStoryTime(directory,{through_chapter:options.through_chapter,include_candidates:!options.confirmed_only},book)
  const valid=records.filter(r=>['candidate','confirmed'].includes(r.approval)&&r.freshness==='current'&&!r.related_changed.length)
  const people=valid.filter(r=>r.type==='entity'&&r.payload.entity_kind==='character')
  const names=new Map()
  for(const r of people){const name=r.payload.name.normalize('NFKC').trim();const ids=names.get(name)??[];ids.push(r.id);names.set(name,ids)}
  const roles=valid.filter(r=>r.type==='role_assignment')
  const byChapter=new Map()
  for(const r of records)for(const n of r.display?.source_chapters??[]){const id=page.chapters[n-1]?.id;if(id===undefined)continue;const ids=byChapter.get(id)??new Set();ids.add(r.id);byChapter.set(id,ids)}
  const sources=page.chapters.filter((c,i)=>!options.through_chapter||i<options.through_chapter).map((c,i)=>({id:c.id,title:c.title,sequence:i+1,version_id:c.active_version_id,record_count:byChapter.get(c.id)?.size??0,status:byChapter.has(c.id)?'registered':'unreviewed'}))
  const quality={candidate:records.filter(r=>r.approval==='candidate').length,confirmed:records.filter(r=>r.approval==='confirmed').length,
   source_issues:records.filter(r=>r.freshness!=='current').map(r=>r.id),dependency_issues:records.filter(r=>r.related_changed.length).map(r=>r.id),
   unplaced_events:timeline.timeline.unplaced,unknown_state_time:valid.filter(r=>r.type==='state'&&r.story_time.kind==='unknown').map(r=>r.id),
   unrated_characters:people.filter(p=>!roles.some(r=>r.payload.subject===p.id)).map(p=>p.id),
   scoped_roles:roles.filter(r=>r.scope.kind!=='book'||r.story_time.kind!=='all').map(r=>r.id),
   possible_duplicates:[...names].filter(([,ids])=>ids.length>1).map(([name,ids])=>({name,ids,decision:'unresolved'}))}
  const coverage={chapters:sources,registered_chapters:sources.filter(c=>c.status==='registered').length,total_chapters:sources.length,
   note:'已登记来源不代表提取完整或作者确认；正文顺序不等于故事发生顺序。'}
  const overview=envelope(book,{contract:VERSION,counts:page.counts,entities:page.entities??[],chapters:page.chapters,total:records.length,coverage,quality,
   limits:{records:5000,events:500},capabilities:{evidence:true,history:true,partial_timeline:true,event_state:true,scoped_roles:true,canonical_entity_merge:false,automatic_fact_acceptance:false}})
  const sections={people:records.filter(r=>['role_assignment','portrait','state','knowledge','relation'].includes(r.type)||r.type==='entity'&&r.payload.entity_kind==='character').map(r=>r.id),
   plot:records.filter(r=>['event','analysis','thread','plan','requirement','revelation'].includes(r.type)).map(r=>r.id),
   world:records.filter(r=>['world_rule','scene'].includes(r.type)||r.type==='entity'&&r.payload.entity_kind!=='character').map(r=>r.id)}
  book.verify();return {overview,records,timeline:envelope(book,timeline),sections}
 }finally{if(!snapshot)book.close()}
}
export const readStoryOverview=(directory,options)=>collectStoryView(directory,options).overview
