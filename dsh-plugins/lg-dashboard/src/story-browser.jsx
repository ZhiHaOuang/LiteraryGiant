import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import {requestStory,shouldRestartStoryPage,withCharacterPortraits} from './story-read.js'
import {StoryRecord} from './story-record.jsx'
import {PeopleCollection} from './people-collection.jsx'
import {peopleLayout} from './story-sections-data.js'

export function StoryBrowser({path,options={},through='',people=false,onPerson,peopleView='card',onPeopleView,peopleSort,onPeopleSort,empty='此范围尚无记录。'}){
 const browser=useRef(null),portraitCache=useRef(null),reflow=useRef(null)
 const [layout,setLayout]=useState({columns:1,pageSize:8}),[capacity,setCapacity]=useState(null)
 useLayoutEffect(()=>{
  if(!people)return
  const el=browser.current
  let previousWidth=0,previousColumns=0,timer
  function measure(width){
   if(width<=0||width===previousWidth)return
   previousWidth=width
   const layout=peopleLayout(width,peopleView)
   reflow.current?.resize(width,layout.columns)
   if(layout.columns===previousColumns&&!timer)return
   if(layout.columns!==previousColumns)setLayout(layout)
   clearTimeout(timer)
   const commit=()=>{
    timer=undefined
    setCapacity(old=>old?.view===peopleView&&old.size===layout.pageSize?old:{view:peopleView,size:layout.pageSize})
   }
   if(previousColumns)timer=setTimeout(commit,150)
   else commit()
   previousColumns=layout.columns
  }
  measure(el.clientWidth)
  const observer=new ResizeObserver(([entry])=>measure(entry.contentRect.width));observer.observe(el)
  return ()=>{observer.disconnect();clearTimeout(timer)}
 },[people,peopleView])
 const pageSize=people?(capacity?.size??8):8,ready=!people||capacity?.view===peopleView
 const [result,setResult]=useState(null),[busy,setBusy]=useState(true),[error,setError]=useState('')
 const [query,setQuery]=useState(''),[recordSort,setRecordSort]=useState('recommended'),[expanded,setExpanded]=useState(''),[focus,setFocus]=useState('')
 const sort=people?peopleSort:recordSort
 const cursor=useRef(null),[notice,setNotice]=useState('')
 const [request,setRequest]=useState({offset:0})
 const offset=focus?0:Math.floor(request.offset/pageSize)*pageSize
 const goToOffset=offset=>setRequest({offset})
 function changeSort(value){
  if(value===sort&&!error)return
  if(people)onPeopleSort(value)
  else setRecordSort(value)
  setNotice('');goToOffset(0)
 }
 const signature=JSON.stringify(options)
 // Only pages of the same book, filters and destination may share displayed results.
 const key=JSON.stringify([path,signature,people&&!focus?null:sort,focus,focus?'':query,through])
 const data=result?.key===key?result.value:null
 // Keep the current records visible during a resize, within the new page's row budget.
 const records=data?.records
 const visiblePeople=useMemo(()=>people&&records?.length>layout.pageSize?records.slice(0,layout.pageSize):records,[people,records,layout.pageSize])
 const shownSize=data?.limit??pageSize,shownPage=data?Math.floor(data.offset/shownSize):0
 useEffect(()=>{
  if(!ready)return
  const controller=new AbortController();setBusy(true);setError('')
  const filters=JSON.parse(signature),selection=focus?{id:focus,...filters.confirmed_only!==undefined&&{confirmed_only:filters.confirmed_only}}:filters
  if(cursor.current?.key!==key)setNotice('')
  const input={action:'story-data',path,options:{...selection,sort:focus?'recommended':sort,limit:pageSize,offset,
   ...query&&!focus&&{query},...through&&{through_chapter:Number(through)}}}
  requestStory(input,controller.signal).then(async value=>{
    if(controller.signal.aborted)return
    if(people&&!focus){
     try{value=await withCharacterPortraits(value,input,portraitCache,controller.signal)}
     catch(e){if(!controller.signal.aborted)setError(e.message)}
    }
    if(controller.signal.aborted)return
    const restart=shouldRestartStoryPage(cursor.current,value,key,offset/pageSize)
    cursor.current={key,book_id:value.book_id,api_version:value.api_version,data_revision:value.data_revision}
    if(restart){goToOffset(0);setNotice('资料已更新，已回到第一页。');return}
    setResult({key,value})
    setExpanded((focus||selection.id)?(value.records[0]?.id??''):'')
   }).catch(e=>{if(!controller.signal.aborted)setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setBusy(false)})
  return()=>controller.abort()
 },[path,signature,through,query,sort,request,focus,pageSize,people,ready])
 const pages=Math.max(1,Math.ceil((data?.total??0)/shownSize))
 const group=r=>r.display?.source?.chapter_title??'未定位章节'
 return <div ref={browser} className={'lgd-story-browser'+(people?' lgd-person-browser':'')} aria-busy={busy}>
  {focus?<div className="lgd-reference-heading"><button onClick={()=>setFocus('')}>‹ 返回当前列表</button><span>关联资料：{data?.directory[focus]?.title??'读取中'}</span></div>:!people&&!options.id&&<div className="lgd-story-search">
   <input type="search" aria-label="搜索当前资料" placeholder="搜索当前资料" value={query} onChange={e=>{setQuery(e.target.value);goToOffset(0)}}/>
   <select aria-label="当前资料排序" value={sort} onChange={e=>changeSort(e.target.value)}><option value="recommended">章节顺序</option><option value="name">名称顺序</option></select>
  </div>}
  {notice&&<p className="lgd-muted">{notice}</p>}
  {error&&<p role="alert">{error} <button onClick={()=>goToOffset(offset)}>重试</button></p>}{busy&&!data&&<p role="status" className="lgd-muted">读取资料…</p>}
  {data&&!data.total&&<p className="lgd-section-empty">{empty}</p>}
  {people&&!focus&&Boolean(visiblePeople?.length)&&<PeopleCollection records={visiblePeople} columns={layout.columns} reflow={reflow} awaitingResize={layout.pageSize>data.limit&&data.total>data.records.length} partialPage={data.offset>0&&data.records.length<data.limit} view={peopleView} onView={onPeopleView} sort={data.sort??sort} onSort={changeSort} onPerson={onPerson}/>}
  {(!people||focus)&&data?.records.map((r,i)=><React.Fragment key={r.revision}>
   {!focus&&!options.id&&sort!=='name'&&(i===0||group(r)!==group(data.records[i-1]))&&<h4 className="lgd-data-group">{group(r)}</h4>}
   <StoryRecord record={r} path={path} data={data} onReference={setFocus} open={expanded===r.id} onToggle={()=>setExpanded(id=>id===r.id?'':r.id)}/>
  </React.Fragment>)}
  {!focus&&data&&!options.id&&(!people||pages>1)&&<nav className="lgd-pager" aria-label="资料分页"><button disabled={busy||!shownPage} onClick={()=>goToOffset((shownPage-1)*shownSize)}>上一页</button><span>{shownPage+1} / {pages} · {data.total} 条</span><button disabled={busy||shownPage+1>=pages} onClick={()=>goToOffset((shownPage+1)*shownSize)}>下一页</button></nav>}
 </div>
}
