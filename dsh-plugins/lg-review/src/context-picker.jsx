import React, { useEffect, useState } from 'react'
import {request} from './api.js'
export function ContextPicker({ path, value, onChange, disabled }) {
  const [documents, setDocuments] = useState([]), [available, setAvailable] = useState(false)
  useEffect(() => {
    const controller = new AbortController(); setAvailable(false); setDocuments([])
    fetch('api/lg/context', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'documents', path }) }).then(response => response.json()).then(result => {
      if (!controller.signal.aborted && result.ok) { setAvailable(true); setDocuments(result.value) }
    }).catch(() => {})
    return () => controller.abort()
  }, [path])
  const update = patch => onChange({ ...value, ...patch })
  return <details><summary>文学上下文（可选）</summary>
    {!available ? <p>lg-context 未启用或作品不可用；仍可执行选区任务。</p> : <fieldset disabled={disabled} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <label>材料视角<select value={value?.story ? 'character-story' : value?.audience ?? 'none'} onChange={event => {
        const audience = event.target.value
        onChange(audience === 'character-story' ? {audience:'character',story:{subject:'',event:'',phase:'after',through_chapter:1}} : audience === 'none' ? null : audience === 'author' ? { audience, documents: [], facts: true }
          : { audience, position: 0, ...(audience === 'character' ? { holder_document_id: documents.find(doc => doc.kind === 'character')?.id } : {}) })
      }}><option value="none">不附加</option><option value="author">作者辅助材料</option><option value="character">人物认知（旧位置）</option><option value="character-story">人物认知（按事件）</option><option value="reader">读者认知</option></select></label>
      {value?.audience === 'author' && <>
        <p>显式选择辅助文档；草稿与计划不自动成为事实。最多 8 份。</p>
        <select multiple aria-label="上下文文档" value={(value.documents ?? []).map(String)} onChange={event => update({ documents: Array.from(event.target.selectedOptions, option => Number(option.value)).slice(0, 8) })}>
          {documents.map(doc => <option key={doc.id} value={doc.id}>{doc.title} · {doc.kind} · {doc.state}</option>)}</select>
        <div>{[['facts', '确认事实'], ['ideas', '设想'], ['timeline', '时间线'], ['foreshadowing', '伏笔'], ['notes', '作者笔记'], ['decisions', '选定方向']].map(([key, label]) => <label key={key}>
          <input type="checkbox" checked={value[key] ?? false} onChange={event => update({ [key]: event.target.checked })}/>{label} </label>)}</div>
        <label>方向作用章节（可选）<select value={value.chapter ?? ''} onChange={event => {
          const { chapter, ...rest } = value; onChange(event.target.value ? { ...rest, chapter: Number(event.target.value) } : rest)
        }}><option value="">全书方向</option>{documents.filter(doc => doc.kind === 'chapter').map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>
        <label>场景设计（可选）<select value={value.scene ?? ''} onChange={event => {
          const { scene, ...rest } = value; onChange(event.target.value ? { ...rest, scene: Number(event.target.value) } : rest)
        }}><option value="">不附加</option>{documents.filter(doc => doc.kind === 'scene').map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>
      </>}
      {value?.story && <StoryContext path={path} value={value.story} onChange={story=>update({story})}/>}
      {value && !value.story && value.audience !== 'author' && <>
        <label>{value.audience === 'character' ? '故事位置' : '阅读位置'}<input type="number" value={value.position} onChange={event => update({ position: Number(event.target.value) })}/></label>
        {value.audience === 'character' && <label>人物<select value={value.holder_document_id ?? ''} onChange={event => update({ holder_document_id: Number(event.target.value) })}>
          <option value="">选择人物</option>{documents.filter(doc => doc.kind === 'character').map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>}
        <p>仅附加此位置已确认的认知；任务选区及作者要求仍会完整发送。</p>
      </>}
      {value && <label>上下文字节上限<input type="number" min={1000} max={12000} step={1000} value={value.maxBytes ?? 4000} onChange={event => update({ maxBytes: Number(event.target.value) })}/></label>}
    </fieldset>}
  </details>
}

function StoryContext({path,value,onChange}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 useEffect(()=>{
  const controller=new AbortController();setBusy(true);setData(null);setError('')
  request({action:'story-time',path,options:{include_candidates:false,through_chapter:value.through_chapter}},controller.signal)
   .then(result=>{if(!controller.signal.aborted)setData(result)})
   .catch(e=>{if(!controller.signal.aborted)setError(e.message)})
   .finally(()=>{if(!controller.signal.aborted)setBusy(false)})
  return()=>controller.abort()
 },[path,value.through_chapter])
 const update=patch=>onChange({...value,...patch})
 const characters=(data?.entities??[]).filter(e=>e.kind==='character')
 return <>
  <p>仅使用当前有效且已确认的记录。选择事件不会把正文阅读顺序变成故事时间；选区与作者要求仍是独立输入。</p>
  <label>阅读截止章节<select aria-label="认知阅读截止章节" value={value.through_chapter??''} disabled={busy} onChange={e=>update({through_chapter:Number(e.target.value),subject:'',event:''})}>
   <option value="" disabled>选择截止章节</option>{(data?.chapters??[]).map((c,i)=><option key={c.id} value={i+1}>{c.title}</option>)}
  </select></label>
  <label>人物<select aria-label="事件认知人物" value={value.subject??''} disabled={busy} onChange={e=>update({subject:e.target.value})}>
   <option value="">选择已确认人物</option>{characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
  </select></label>
  <label>参照事件<select aria-label="认知参照事件" value={value.event??''} disabled={busy} onChange={e=>update({event:e.target.value})}>
   <option value="">选择已确认事件</option>{(data?.events??[]).map(e=><option key={e.id} value={e.id}>{e.title}</option>)}
  </select></label>
  <label>时点<select aria-label="认知事件前后" value={value.phase??'after'} onChange={e=>update({phase:e.target.value})}><option value="before">事件之前</option><option value="after">事件之后</option></select></label>
  {busy&&<p role="status">读取已确认资料…</p>}{error&&<p role="alert">{error}</p>}
  {!busy&&data&&(!characters.length||!data.events?.length)&&<p>当前范围没有足够的已确认人物或事件，请先审阅并确认故事资料；不会自动使用候选。</p>}
  {!value.subject||!value.event?<p>填写人物与参照事件后才能预览该上下文。</p>:null}
 </>
}
