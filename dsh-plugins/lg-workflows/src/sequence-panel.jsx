import React, { useEffect, useState } from 'react'
import { wordCount } from '../../lg-books/src/summary.js'
import { reviewAcceptance } from '../../lg-workbench/src/api.js'
import { Supervision } from '../../lg-workbench/src/supervision.jsx'

export function SequencePicker({ path, chapter, request, scenes, setScenes, carry, setCarry }) {
  const [page,setPage] = useState({items:[]}), [error,setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setPage({items:[]})
    setError('')
    request('planning',{action:'list',section:'scenes',path,chapter_id:chapter,limit:30},controller.signal)
      .then(value=>{if(!controller.signal.aborted)setPage(value)})
      .catch(error=>{if(!controller.signal.aborted)setError(error.message)})
    return () => controller.abort()
  }, [path,chapter])
  async function more() {
    try {
      const next = await request('planning',{action:'list',section:'scenes',path,chapter_id:chapter,limit:30,offset:page.nextOffset})
      setPage({...next,items:[...page.items,...next.items]})
    } catch(error) {setError(error.message)}
  }
  return <section><h3>起草顺序</h3>
    <p>按需要的顺序选择 2–6 个空场景。每场使用作者批准的计划。</p>
    {page.items.filter(item=>item.plan_state==='approved'&&!item.metadata.lg_plan_proposal).map(item=>
      <button key={item.document_id} disabled={scenes.includes(item.document_id)||scenes.length>=6}
        onClick={()=>setScenes([...scenes,item.document_id])}>加入「{item.title}」</button>)}
    {page.nextOffset!=null&&<button onClick={more}>更多场景</button>}
    <ol>{scenes.map(id=><li key={id}>{page.items.find(item=>item.document_id===id)?.title??id}
      <button onClick={()=>setScenes(scenes.filter(item=>item!==id))}>移除</button></li>)}</ol>
    <label><input type="checkbox" checked={carry} onChange={e=>setCarry(e.target.checked)}/>将前一个已采用场景的正文摘录加入下一场输入</label>
    {error&&<p role="alert">{error}</p>}
  </section>
}

export function CandidateDecision({ candidate, range, disabled, request, path, onBusy, onDone }) {
  const [preview,setPreview] = useState(null), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [review,setReview] = useState(null)
  const {selected,document,token} = candidate
  const unit=document.kind==='chapter'?'本章':'本场'
  const words = wordCount(selected.content)
  const outside = range?.min != null && words < range.min || range?.max != null && words > range.max
  function lock(value) {setBusy(value);onBusy(value)}
  function reviewed(input,result) {
    setPreview({...input,reviewToken:result.reviewToken})
    setReview(result.supervision)
  }
  async function prepare(action) {
    setError('');setReview(null)
    const input={action,path,document:document.id,version:selected.id,token,operation:crypto.randomUUID()}
    if(action==='reject'){setPreview(input);return}
    lock(true)
    try {reviewed(input,await reviewAcceptance(input))}
    catch(error){setError(error.message)}
    finally{lock(false)}
  }
  async function confirm() {
    lock(true)
    try {
      await request('books',preview)
      await onDone()
      setPreview(null)
    } catch(error) {setError(error.message)}
    finally {lock(false)}
  }
  return <aside><h3>{document.title} · 候选 v{selected.version_number}</h3><pre>{selected.content}</pre>
    <p role={outside?'alert':undefined}>正文 {words} 字{range && (range.min!=null || range.max!=null) && `，计划范围 ${range.min??0}–${range.max??'不限'} 字`}{outside?'，超出计划范围。':'。'}</p>
    {selected.state==='candidate' && selected.metadata.base_version_id===document.activeVersion ?
      <fieldset disabled={disabled||busy}>{preview?<><p>{preview.action==='accept'?'确认后，这份候选将成为'+unit+'正式正文。':'确认后，这份候选将标记为拒绝，流程可跳过'+unit+'。'}</p>
        {review&&<Supervision review={review} input={preview} busy={busy} setBusy={lock} onReviewed={result=>reviewed(preview,result)}/>}
        <button disabled={review?.reports.some(r=>r.conflicts.length)} onClick={confirm}>确认{preview.action==='accept'?'采用':'拒绝'}{unit}候选</button><button onClick={()=>setPreview(null)}>返回</button></>:
        <><button onClick={()=>prepare('accept')}>预览采用{unit}候选</button><button onClick={()=>prepare('reject')}>预览拒绝{unit}候选</button></>}</fieldset>:
      <p>{selected.state==='rejected'?'作者已拒绝此候选。':unit+'当前正文版本 ID '+document.activeVersion+'。'}</p>}
    {error&&<p role="alert">{error}</p>}
  </aside>
}

export function sceneStepLabel(step, candidate) {
  const version = step.result?.candidate?.version
  if (!version) return step.status==='running'?'起草中':'已停止'
  const current = candidate?.parts.find(part=>part.id===step.task.document)
  if (current?.active_version_id===version && ['accepted','final'].includes(current.state)) return '正文已采用'
  if (candidate?.selected.id===version && candidate.selected.state==='rejected') return '作者已拒绝'
  return '候选已生成'
}
