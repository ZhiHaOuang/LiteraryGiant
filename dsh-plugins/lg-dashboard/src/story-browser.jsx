import React,{useEffect,useRef,useState} from 'react'
import {requestStory,shouldRestartStoryPage} from './story-read.js'
import {StoryRecord} from './story-record.jsx'
import {PeopleCollection} from './people-collection.jsx'
import {PEOPLE_PAGE_SIZE} from './story-sections-data.js'

export function StoryBrowser({path,options={},through='',people=false,onPerson,peopleView='card',onPeopleView,empty='此范围尚无记录。'}){
 const pageSize=people?PEOPLE_PAGE_SIZE:8
 const [result,setResult]=useState(null),[busy,setBusy]=useState(true),[error,setError]=useState('')
 const [query,setQuery]=useState(''),[sort,setSort]=useState('recommended'),[expanded,setExpanded]=useState(''),[focus,setFocus]=useState('')
 const cursor=useRef(null),[notice,setNotice]=useState('')
 const [request,setRequest]=useState({page:0})
 const {page}=request
 const goToPage=page=>setRequest({page})
 const signature=JSON.stringify(options)
 // Only pages of the same book, filters and destination may share displayed results.
 const key=JSON.stringify([path,signature,sort,focus,focus?'':query,through,pageSize])
 const data=result?.key===key?result.value:null
 const shownPage=data?Math.floor(data.offset/pageSize):0
 useEffect(()=>{
  const controller=new AbortController();setBusy(true);setError('')
  const filters=JSON.parse(signature),selection=focus?{id:focus,...filters.confirmed_only!==undefined&&{confirmed_only:filters.confirmed_only}}:filters
  if(cursor.current?.key!==key)setNotice('')
  requestStory({action:'story-data',path,options:{...selection,sort:focus?'recommended':sort,limit:pageSize,offset:focus?0:page*pageSize,
   ...query&&!focus&&{query},...through&&{through_chapter:Number(through)}}},controller.signal).then(value=>{
    if(controller.signal.aborted)return
    const restart=shouldRestartStoryPage(cursor.current,value,key,page)
    cursor.current={key,book_id:value.book_id,api_version:value.api_version,data_revision:value.data_revision}
    if(restart){goToPage(0);setNotice('资料已更新，已回到第一页。');return}
    setResult({key,value})
    setExpanded((focus||selection.id)?(value.records[0]?.id??''):'')
   }).catch(e=>{if(!controller.signal.aborted)setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setBusy(false)})
  return()=>controller.abort()
 },[path,signature,through,query,sort,request,focus,pageSize])
 const pages=Math.max(1,Math.ceil((data?.total??0)/pageSize))
 const group=r=>r.display?.source?.chapter_title??'未定位章节'
 return <div className={'lgd-story-browser'+(people?' lgd-person-browser':'')} aria-busy={busy}>
  {focus?<div className="lgd-reference-heading"><button onClick={()=>setFocus('')}>‹ 返回当前列表</button><span>关联资料：{data?.directory[focus]?.title??'读取中'}</span></div>:!options.id&&<div className="lgd-story-search">
   <input type="search" aria-label="搜索当前资料" placeholder={people?'查找人物':'搜索当前资料'} value={query} onChange={e=>{setQuery(e.target.value);goToPage(0)}}/>
   <select aria-label="当前资料排序" value={sort} onChange={e=>{setSort(e.target.value);goToPage(0)}}><option value="recommended">{people?'全书评级优先':'章节顺序'}</option>{people&&<option value="references">关联数量</option>}<option value="name">名称顺序</option></select>
  </div>}
  {notice&&<p className="lgd-muted">{notice}</p>}
  {error&&<p role="alert">{error} <button onClick={()=>goToPage(page)}>重试</button></p>}{busy&&!data&&<p role="status" className="lgd-muted">读取资料…</p>}
  {data&&!data.total&&<p className="lgd-section-empty">{empty}</p>}
  {people&&!focus&&Boolean(data?.records.length)&&<PeopleCollection records={data.records} pageCapacity={Math.min(pageSize,data.total)} view={peopleView} onView={onPeopleView} onPerson={onPerson}/>}
  {(!people||focus)&&data?.records.map((r,i)=><React.Fragment key={r.revision}>
   {!focus&&!options.id&&sort!=='name'&&(i===0||group(r)!==group(data.records[i-1]))&&<h4 className="lgd-data-group">{group(r)}</h4>}
   <StoryRecord record={r} path={path} data={data} onReference={setFocus} open={expanded===r.id} onToggle={()=>setExpanded(id=>id===r.id?'':r.id)}/>
  </React.Fragment>)}
  {!focus&&data&&!options.id&&<nav className="lgd-pager" aria-label="资料分页"><button disabled={busy||!shownPage} onClick={()=>goToPage(shownPage-1)}>上一页</button><span>{shownPage+1} / {pages} · {data.total} 条</span><button disabled={busy||shownPage+1>=pages} onClick={()=>goToPage(shownPage+1)}>下一页</button></nav>}
 </div>
}
