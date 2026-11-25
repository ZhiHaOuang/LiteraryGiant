import React,{useEffect,useState} from 'react'

import {CharacterMain} from './character-main.jsx'

function MainPage({path,section,id,onFollow,otherModules=false}) {
  const [offset,setOffset] = useState(0), [page,setPage] = useState(null), [error,setError] = useState('')
  useEffect(()=>{
    const controller = new AbortController()
    async function load() {
      setError('')
      setPage(null)
      const response = await fetch('api/lg/outline',{
        method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,
        body:JSON.stringify({action:'main',path,options:{section,id,offset,limit:12,...otherModules && {other_modules:true}}})
      })
      if (response.status===404) throw Error('启用 lg-storydata 后可读取 Main。')
      const {ok,value,error} = await response.json()
      if (!ok || !response.ok) throw Error(error || '读取 Main 失败')
      if (value?.api_version!=='lg.outline.read.v1' || !Array.isArray(value.items)
          || !Number.isSafeInteger(value.total) || value.offset!==offset || !value.items.every(item=>
            typeof item?.title==='string' && typeof item.text==='string' && Array.isArray(item.related)
            && item.related.every(target=>typeof target?.id==='string' && typeof target.title==='string'))) {
        throw Error('Main 读取接口版本或格式不匹配')
      }
      if (!controller.signal.aborted) setPage(value)
    }
    load().catch(e=>{if (!controller.signal.aborted) setError(e.message)})
    return ()=>controller.abort()
  },[path,section,id,offset,otherModules])
  return <div>
    {error ? <p role="alert">{error}</p> : !page ? <p>正在读取…</p> :
      <>
        {!page.items.length && <p>此范围暂无已审查的摘要。</p>}
        {page.items.map(item=><article key={item.id+'/'+item.module}>
          <strong>{item.title}</strong> <small>{item.module==='core@1.summary'?'摘要':item.module} · {item.basis==='inference'?'推断':'据原文'} · v{item.revision}</small>
          {item.freshness==='stale' && <small> · 来源已变化，待复核</small>}
          <p>{item.text}</p>
          {item.related.length>0 && <nav aria-label="关联档案">{item.related.map(target=><button
            type="button" key={target.id} onClick={()=>onFollow(target.id,item.related_sections?.[target.id])}>{target.title}</button>)}</nav>}
        </article>)}
        {(offset>0 || offset+page.limit<page.total) && <nav aria-label="Main 翻页">
          <button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-page.limit))}>上一页</button>
          <button disabled={offset+page.limit>=page.total} onClick={()=>setOffset(offset+page.limit)}>下一页</button>
        </nav>}
      </>}
  </div>
}

function OtherModules(props) {
  const [open,setOpen]=useState(false)
  return <details open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>摘要与按书扩展</summary>
    {open && <MainPage {...props} section="people" otherModules/>}
  </details>
}

export function OutlineMain(props) {
  const character=props.section==='people' && Boolean(props.id)
  const [open,setOpen] = useState(character)
  const [target,setTarget] = useState(null)
  const id=target?.id??props.id, section=target?.section??(target?undefined:props.section)
  const follow=(id,section)=>setTarget(id===props.id?null:{id,section})
  return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>当前档案 Main</summary>
    {open && <>
      {target && <button type="button" onClick={()=>setTarget(null)}>返回当前档案</button>}
      {section==='people' && id ? <>
        <CharacterMain key={id} path={props.path} id={id} onFollow={follow}/>
        <OtherModules key={id+'/extras'} path={props.path} id={id} onFollow={follow}/>
      </> : <MainPage key={id??section} path={props.path} section={section} id={id} onFollow={follow}/>}
    </>}
  </details>
}
