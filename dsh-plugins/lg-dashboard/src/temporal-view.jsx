import React,{useEffect,useState} from 'react'
import {requestStory} from './story-read.js'
import {StoryRecord} from './story-record.jsx'
import {StoryBrowser} from './story-browser.jsx'
import {timelineItems} from './story-sections-data.js'
import {pageSlice,temporalOptions} from './temporal-view-model.js'

const relations={before:'先于',after:'晚于',simultaneous:'同时',overlaps:'重叠'}

function Pager({page,pages,total,onPage,label}){
 return pages>1?<nav className="lgd-pager" aria-label={label}>
  <button disabled={!page} onClick={()=>onPage(page-1)}>上一页</button>
  <span>{page+1} / {pages} · {total} 条</span>
  <button disabled={page+1>=pages} onClick={()=>onPage(page+1)}>下一页</button>
 </nav>:null
}
function Records({records,value,path,onReference,label}){
 const [page,setPage]=useState(0),[expanded,setExpanded]=useState(''),slice=pageSlice(records,page,8)
 return <><div>{slice.items.map(r=><StoryRecord key={r.id} record={r} path={path} data={value} onReference={onReference} open={expanded===r.id} onToggle={()=>setExpanded(id=>id===r.id?'':r.id)}/>)}</div><Pager {...slice} onPage={setPage} label={label}/></>
}
function Timeline({value,path,onReference,subject=''}){
 const [page,setPage]=useState(0),[expanded,setExpanded]=useState(''),[relationPage,setRelationPage]=useState(0)
 const rows=timelineItems(value,subject),slice=pageSlice(rows,page,8),ids=new Set(rows.map(item=>item.record.id))
 const edges=pageSlice(value.timeline.relations.filter(e=>!subject||ids.has(e.from)||ids.has(e.to)),relationPage,8)
 const title=id=>value.directory[id]?.title??id
 return <>
  <p className="lgd-muted">{subject?'仅显示已登记此人物参与的事件。':'事件按已有时间关系组织。'}未确定先后的事件保留分组，来源章节可在条目中查看。</p>
  {slice.items.map(({record,group},i)=><React.Fragment key={record.id}>
   {(i===0||group!==slice.items[i-1].group)&&<h4 className="lgd-data-group">{group}</h4>}
   <StoryRecord record={record} path={path} data={value} onReference={onReference} open={expanded===record.id} onToggle={()=>setExpanded(id=>id===record.id?'':record.id)}/>
  </React.Fragment>)}
  {!slice.total&&<p className="lgd-section-empty">此范围尚无可展示的事件。</p>}
  <Pager {...slice} onPage={p=>{setPage(p);setExpanded('')}} label="情节事件分页"/>
  {!!edges.total&&<details className="lgd-time-relations"><summary>事件之间的先后与并行关系 · {edges.total}</summary><ul>{edges.items.map((edge,i)=><li key={i}>{title(edge.from)} <b>{relations[edge.relation]??edge.relation}</b> {title(edge.to)}</li>)}</ul><Pager {...edges} onPage={setRelationPage} label="时间关系分页"/></details>}
 </>
}
function Character({value,subject,event,path,onReference}){
 if(!subject||!event)return <p className="lgd-muted">选择人物和参照事件，查看该事件之前或之后的状态、认知与关系。未登记不代表不存在。</p>
 const result=value.character
 if(!result)return <p className="lgd-muted">未返回人物状态；请核对人物与事件是否在当前范围。</p>
 return <>
  <section className="lgd-time-group"><h4>时间条件确定适用 · {result.certain.length}</h4><p className="lgd-muted">“适用”指符合所选时间条件；候选内容仍需作者判断。</p>
   {result.certain.length?<Records records={result.certain} value={value} path={path} onReference={onReference} label="确定适用记录分页"/>:<p className="lgd-muted">没有足够依据确定当时状态。</p>}
  </section>
  <section className="lgd-time-group"><h4>时间或适用性待确认 · {result.uncertain.length}</h4><Records records={result.uncertain} value={value} path={path} onReference={onReference} label="待确认记录分页"/></section>
  {!!result.conflicts.length&&<section className="lgd-time-conflicts" role="status"><h4>需核对的状态冲突 · {result.conflicts.length}</h4>{result.conflicts.map((c,i)=><p key={i}>{c.reason}：{c.records.map(id=>value.directory[id]?.title??id).join('；')}</p>)}</section>}
  {(result.warnings??[]).map((warning,i)=><p key={i} className="lgd-muted">{warning}</p>)}
 </>
}

export function TemporalView({path,mode,subject,through}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[focus,setFocus]=useState('')
 const [event,setEvent]=useState(''),[phase,setPhase]=useState('after')
 const [includeCandidates,setIncludeCandidates]=useState(true),[refresh,setRefresh]=useState(0)
 useEffect(()=>{
  const controller=new AbortController();setBusy(true);setError('');setData(null);setFocus('')
  const options=temporalOptions({subject:mode==='character'&&event?subject:'',event:mode==='character'?event:'',phase,through,includeCandidates})
  requestStory({action:'story-time',path,options},controller.signal).then(value=>{if(!controller.signal.aborted)setData(value)}).catch(e=>{if(!controller.signal.aborted)setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setBusy(false)})
  return()=>controller.abort()
 },[path,mode,subject,event,phase,through,includeCandidates,refresh])
 return <div className="lgd-time-panel">
  <div hidden={!!focus}>
   <div className="lgd-time-controls">
    <label className="lgd-time-candidates"><input type="checkbox" checked={includeCandidates} onChange={e=>{setIncludeCandidates(e.target.checked);setEvent('')}}/>包括候选（供作者审阅）</label>
    <button disabled={busy} onClick={()=>setRefresh(v=>v+1)}>刷新事件</button>
   </div>
   {mode==='character'&&<div className="lgd-time-controls">
    <label>参照事件<select aria-label="经历参照事件" value={event} disabled={busy||!data?.entities.some(e=>e.id===subject)} onChange={e=>setEvent(e.target.value)}><option value="">选择事件</option>{data?.events.map(e=><option key={e.id} value={e.id}>{e.title}</option>)}</select></label>
    <label>时点<select aria-label="事件前后" value={phase} onChange={e=>setPhase(e.target.value)}><option value="before">事件之前</option><option value="after">事件之后</option></select></label>
   </div>}
   {busy&&<p role="status" className="lgd-muted">读取事件与状态…</p>}{error&&<p role="alert">{error}</p>}
   {!busy&&data?.timeline.warnings.length>0&&<details className="lgd-time-warnings"><summary>时间资料提示 · {data.timeline.warnings.length}</summary>{data.timeline.warnings.map((warning,i)=><p key={i}>{warning}</p>)}</details>}
   {!busy&&data&&(mode==='character'?<Character key={data.data_revision+subject+event+phase} value={data} path={path} onReference={setFocus} subject={subject} event={event}/>:<Timeline key={data.data_revision} value={data} path={path} onReference={setFocus} subject={subject}/>)}
  </div>
  {focus&&<><button onClick={()=>setFocus('')}>‹ 返回事件</button><StoryBrowser key={focus} path={path} options={{id:focus,confirmed_only:!includeCandidates}} through={through}/></>}
 </div>
}
