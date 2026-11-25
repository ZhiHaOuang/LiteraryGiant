import React,{useEffect,useMemo,useState} from 'react'
import {UsageCard} from './usage-card.jsx'
import {InformationProtocolPanel} from './character-protocol-panel.jsx'
import {englishCharacterGroups} from './character-core-labels.js'
import css from './console.css'

import {storySectionLabels as sections} from '../../lg-books/src/story-data/labels.js'
const types={entity:'Entity',role_assignment:'Narrative Role',portrait:'Character Profile',state:'State',knowledge:'Knowledge',relation:'Relationship',event:'Event',analysis:'Analysis',thread:'Plot Thread',plan:'Plan',requirement:'Requirement',revelation:'Revelation',world_rule:'World Rule',scene:'Scene'}
const approvals={candidate:'Candidate',confirmed:'Confirmed',rejected:'Rejected',withdrawn:'Withdrawn'}
const format=n=>n.toLocaleString('en-US')
const all=''
export const panelTitle='Story Data'

function useInventory(action,path,module,facet,offset,refresh) {
  const [state,setState]=useState({})
  const key=JSON.stringify({action,path,options:{...(action==='overview' && {locale:'zh',includeArchived:true}),module:module||undefined,facet:facet||undefined,offset}})
  useEffect(()=>{
    const controller=new AbortController()
    async function load(){
      const response=await fetch('api/lg/storydata',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:key})
      const {ok,value,error}=await response.json()
      if(!ok || !response.ok)throw Error(error && /^[\x20-\x7e]+$/.test(error)?error:'Could not read the book inventory. Refresh the bookshelf and try again.')
      const version=action==='storage'?'lg.storydata.space.v1':'lg.storydata.inventory.v1'
      if(value?.version!==version)throw Error('Unsupported Story Data format.')
      if(!controller.signal.aborted)setState({key,value})
    }
    load().catch(error=>{if(!controller.signal.aborted)setState({key,error:error.message})})
    return ()=>controller.abort()
  },[key,refresh])
  return state.key===key?state:{}
}
function Metric({label,n,hint}){
  return <div><dt aria-description={hint}>{label}</dt><dd>{n==null?'—':format(n)}</dd></div>
}
function Counts({groups,rows}) {
  return <div className="lg-data-catalog">{groups.map(g=>{
    const facets=g.facets.map(f=>({...f,count:rows.filter(r=>r.module===g.module&&r.facet===f.id).reduce((n,r)=>n+r.count,0)}))
    const used=facets.filter(f=>f.count).length
    return <details key={g.module}><summary><strong>{g.label}</strong><span>{used} / {facets.length} categories used</span></summary>
      <dl>{facets.map(f=><div key={f.id}><dt>{f.label} <small>{f.count} {f.count===1?'entry':'entries'}</small></dt><dd>{f.vocabulary}</dd></div>)}</dl>
    </details>
  })}</div>
}
function Overview({data,storage}){
  const {protocol,books,totals}=data,readable=books.filter(b=>!b.error)
  const groups=readable.flatMap(book=>book.groups),space=storage.value
  const archived=readable.filter(book=>book.archived).length
  return <>
    <div className="lg-data-overview-top">
      <dl className="lg-data-metrics lg-data-kpis" aria-label="Overview Metrics">
        <Metric label="Books" n={readable.length} hint="Active and archived"/>
        <Metric label="Chapters" n={space?.chapters} hint="Across measured books"/>
        <Metric label="Active Books" n={readable.length-archived}/>
        <Metric label="Archived Books" n={archived}/>
        <Metric label="Book Files" n={space?.files} hint="Across measured books"/>
        <Metric label="Main Entries" n={totals.main} hint="Current reviewed entries"/>
        {Object.entries(sections).map(([key,title])=><Metric key={key} label={title}
          n={groups.filter(row=>row.section===key).reduce((sum,row)=>sum+row.count,0)} hint="Reviewed Main entries"/>)}
        <Metric label="Extracted Records" n={totals.records} hint="Current record versions"/>
      </dl>
      <UsageCard storage={storage}/>
    </div>
    <InformationProtocolPanel protocol={protocol}/>
  </>
}

function BookUsage({book,protocol,refresh}){
  const [module,setModule]=useState(all),[facet,setFacet]=useState(all),[offset,setOffset]=useState(0)
  const {value,error}=useInventory('book',book.path,module,facet,offset,refresh)
  const groups=useMemo(()=>englishCharacterGroups(protocol.groups),[protocol])
  const group=groups.find(g=>g.module===module)
  const label=m=>groups.find(g=>g.module===m)?.label??(m==='core@1.summary'?'Summary':m)
  useEffect(()=>{if(value && offset>0 && offset>=value.total)setOffset(0)},[value,offset])
  const [packs,setPacks]=useState([])
  useEffect(()=>{if(value)setPacks(value.packs)},[value])
  return <>
    <section><h2>{book.name}</h2>
      {value && <dl className="lg-data-metrics"><Metric label="Main Entries" n={value.main}/><Metric label="Categories in Use" n={new Set(value.groups.filter(g=>g.facet).map(g=>g.module+'/'+g.facet)).size}/><Metric label="Extracted Records" n={value.records}/></dl>}
      <div className="lg-data-controls"><label>Module <select aria-label="Module" value={module} onChange={e=>{setModule(e.target.value);setFacet(all);setOffset(0)}}><option value="">All Modules</option>
        {packs.flatMap(pack=>Object.keys(pack.modules).map(id=>pack.id+'@'+pack.version+'.'+id)).map(m=><option key={m} value={m}>{label(m)}</option>)}</select></label>
        {group&&<label>Category <select aria-label="Category" value={facet} onChange={e=>{setFacet(e.target.value);setOffset(0)}}><option value="">All Categories</option>{group.facets.map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</select></label>}
      </div>
      {error?<p role="alert">{error}</p>:!value?<p role="status">Loading book…</p>:<>
        <h3>Entries in Use <small>{value.total}</small></h3>
        {value.items.map(r=><article key={JSON.stringify([r.id,r.module,r.key])}><header><strong>{r.title}</strong><small>{sections[r.section]} / {label(r.module)}{r.facet?' / '+(groups.find(g=>g.module===r.module)?.facets.find(f=>f.id===r.facet)?.label??r.facet):''}</small></header>
          <p>{r.value}</p>{(r.scope||r.tags.length>0)&&<small>{[r.scope,...r.tags].filter(Boolean).join(' · ')}</small>}</article>)}
        {!value.total&&<p>No reviewed entries match these filters.</p>}
        {value.total>value.limit&&<nav><button disabled={!offset} onClick={()=>setOffset(offset-value.limit)}>Previous</button><span>{offset+1}–{Math.min(offset+value.limit,value.total)} / {value.total}</span><button disabled={offset+value.limit>=value.total} onClick={()=>setOffset(offset+value.limit)}>Next</button></nav>}
      </>}
    </section>
    {value&&<><section><h2>Character Category Coverage</h2><Counts groups={groups} rows={value.groups}/></section>
      <section><h2>Extracted Records</h2>{value.records?<div className="lg-data-tags">{value.extracted.map(r=><span key={r.type+'/'+r.approval}>{types[r.type]??r.type} · {approvals[r.approval]??r.approval} <b>{r.count}</b></span>)}</div>:<p>No extracted records.</p>}</section></>}
  </>
}

export function StoryDataConsole({page,pageChrome,updatePage}){
  const [refresh,setRefresh]=useState(0),[showBooks,setShowBooks]=useState(false),[path,setPath]=useState('')
  useEffect(()=>{
    if(page && page.title!==panelTitle)updatePage?.({title:panelTitle})
  },[page,updatePage])
  useEffect(()=>{
    const changed=()=>setRefresh(n=>n+1)
    window.addEventListener('lg-books-changed',changed)
    return()=>window.removeEventListener('lg-books-changed',changed)
  },[])
  const {value,error}=useInventory('overview',undefined,undefined,undefined,0,refresh)
  const storage=useInventory('storage',undefined,undefined,undefined,0,refresh)
  const books=value?.books.filter(b=>!b.error)??[],book=books.find(b=>b.path===path)??books[0]
  const refreshButton=<button type="button" className="lg-data-refresh" onClick={()=>setRefresh(n=>n+1)}>Refresh</button>
  return <main className="lg-data" aria-label={panelTitle} lang="en"><style>{css}</style><div className="lg-data-wrap">
    {pageChrome?.actions ? pageChrome.actions(refreshButton) : <header className="lg-data-title"><h1>{panelTitle}</h1>{refreshButton}</header>}
    {error?<p role="alert">{error}</p>:!value?<p role="status">Loading bookshelf…</p>:<>
      <Overview data={value} storage={storage}/>
      <details className="lg-data-book-records" open={showBooks} onToggle={e=>setShowBooks(e.currentTarget.open)}><summary>Book Records</summary>
        {showBooks&&(book?<><label className="lg-data-picker">Book <select aria-label="Book" value={book.path} onChange={e=>setPath(e.target.value)}>{books.map(b=><option key={b.path} value={b.path}>{b.name}{b.archived?' (archived)':''}</option>)}</select></label>
          <BookUsage key={book.path} book={book} protocol={value.protocol} refresh={refresh}/></>:<p>No readable books on the bookshelf.</p>)}
      </details>
    </>}
  </div></main>
}
