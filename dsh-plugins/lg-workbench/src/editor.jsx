import React, { useState } from 'react'
import { request,reviewAcceptance } from './api.js'
import { Supervision } from './supervision.jsx'
import {CandidateAnalysis} from './candidate-analysis.jsx'
import { TaskPanel } from './task-panel.jsx'
import { ReviewPanel } from '../../lg-review/src/panel.jsx'
import { CheckPanel } from '../../lg-review/src/check-panel.jsx'

const labels = { edit: '保存作者编辑', candidate: '保存为候选', accept: '采用候选为正文', reject: '拒绝候选' }
export function Editor({ path, data, refresh, onLock }) {
  const [text, setText] = useState(data.selected.content)
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(null)
  const [acceptance,setAcceptance]=useState(null)
  const [legacy,setLegacy]=useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [taskLocked, setTaskLocked] = useState(false)
  const [range, setRange] = useState({ start: 0, end: data.selected.content.length })
  const [reviewTarget, setReviewTarget] = useState(null), [feedback, setFeedback] = useState(null)
  const dirty = text !== data.selected.content
  const candidate = data.selected.state === 'candidate'
  function change(value) { setText(value); onLock(value !== data.selected.content) }
  async function preview(action) {
    setError(''); onLock(true)
    const input={ action, path, document: data.document.id, version: data.selected.id,
      sourceVersion: data.selected.id, content: text, reason: reason.trim(), token: data.token, operation: crypto.randomUUID() }
    if(action!=='accept'){setPending(input);return}
    setBusy(true)
    try {
      const review=await reviewAcceptance(input)
      setAcceptance(review.supervision);setLegacy(review.legacySource);setPending({...input,reviewToken:review.reviewToken})
    }catch(error){setError(error.message);onLock(false)}finally{setBusy(false)}
  }
  async function submit() {
    setBusy(true); setError('')
    try {
      const receipt = await request(pending)
      onLock(false)
      await refresh(receipt.version, receipt)
    } catch (error) { setError(error.message) }
    finally { setBusy(false) }
  }
  return <section className="lgw-editor">
    <header><div><h2>{data.document.title}</h2><p>当前正文 ID {data.document.activeVersion} · 查看版本 {data.selected.version_number} · {data.selected.state}</p></div>
      <label>版本 <select aria-label="查看版本" value={data.selected.id} disabled={dirty || !!pending || busy || taskLocked || !!feedback}
        onChange={event => refresh(Number(event.target.value))}>
        {data.versions.map(version => <option key={version.id} value={version.id}>v{version.version_number} · {version.state} · {version.reason.slice(0, 50)}</option>)}
      </select></label></header>
    <div className="lgw-compare">
      <label>当前正文<textarea aria-label="当前正文" readOnly value={data.document.content}/></label>
      <label>{pending ? '本次提交内容（预览已冻结）' : '待编辑 / 候选文本'}
        <textarea aria-label="待编辑文本" readOnly={!!pending || busy || taskLocked || !!feedback} value={text} onChange={event => change(event.target.value)}
          onSelect={event => { if (!dirty && !taskLocked && !feedback) setRange({ start: event.target.selectionStart, end: event.target.selectionEnd }) }}/></label>
    </div>
    <p className="lgw-note">只改动当前选中的章节或场景。版本保留，可先保存候选，再审阅采用。保存作者编辑或采用候选后会同步整章 Markdown。外部文件有改动时，可在「章节文件」中比较。</p>
    {!pending && !taskLocked && !feedback && <>
      <label>修改目的<input aria-label="修改目的" value={reason} maxLength={2000} onChange={event => setReason(event.target.value)}/></label>
      {dirty && data.selected.id !== data.document.activeVersion && <p>正在修改历史版本，请先另存为候选，再审阅采用。</p>}
      <div className="lgw-actions">
        <button disabled={!dirty || !reason.trim() || busy} onClick={() => preview('candidate')}>预览候选</button>
        <button disabled={!dirty || !reason.trim() || busy || data.selected.id !== data.document.activeVersion} onClick={() => preview('edit')}>预览作者编辑</button>
        <button disabled={!candidate || dirty || busy} onClick={() => preview('accept')}>预览采用</button>
        <button disabled={!candidate || dirty || busy} onClick={() => preview('reject')}>预览拒绝</button>
        {dirty && <button onClick={() => change(data.selected.content)}>放弃未保存编辑</button>}
      </div>
    </>}
    {pending && <section className="lgw-confirm" aria-label="提交预览">
      <h3>{labels[pending.action]}</h3>
      {pending.action==='accept'&&legacy&&<section aria-label="旧章节来源"><h4>旧章节来源已核对</h4>
        <p>旧运行 {legacy.run} · 原正文版本 {legacy.base} · 生成候选版本 {legacy.version}</p>
        {legacy.direction&&<p>作者选定方向：{legacy.direction.title} · {legacy.direction.content}</p>}</section>}
      {pending.action==='accept'&&acceptance&&<Supervision review={acceptance} input={pending} busy={busy} setBusy={setBusy}
        onReviewed={r=>{setAcceptance(r.supervision);setPending({...pending,reviewToken:r.reviewToken})}}/>}
      <p>{['edit', 'accept'].includes(pending.action) ? '确认后将更新当前正文；历史版本保留。' : '本次操作不改变当前正文。'} 整章版本会在提交时再次校验。</p>
      <p>修改目的：{pending.reason || '作者审阅选定版本'} · 版本 ID {pending.version}</p>
      <button disabled={busy||pending.action==='accept'&&acceptance?.reports.some(r=>r.conflicts.length)} onClick={submit}>{busy ? '正在提交…' : '确认' + labels[pending.action]}</button>
      <button disabled={busy} onClick={() => { setPending(null); onLock(dirty) }}>返回修改</button>
    </section>}
    {error && <p role="alert">{error} 提交未确认时保留当前内容；重试使用同一收据。</p>}
    {typeof data.selected.metadata?.generation?.method?.title === 'string' && typeof data.selected.metadata.generation.method.technique === 'string' &&
      <details><summary>生成方法 · {data.selected.metadata.generation.method.title}</summary><p>{data.selected.metadata.generation.method.technique}</p></details>}
    {data.selected.metadata?.generation && <details><summary>此版本的生成来源</summary><pre>{JSON.stringify(data.selected.metadata.generation, null, 2)}</pre></details>}
    {!dirty && !pending && <>
      <CheckPanel path={path} data={data} disabled={taskLocked || busy || !!feedback}/>
      {!reviewTarget&&<div><button disabled={taskLocked || busy || !!feedback} onClick={()=>{setReviewTarget({section:'consistency',id:data.document.id});setTaskLocked(true);onLock(true)}}>当前章节／场景一致性</button>
        <button disabled={taskLocked || busy || !!feedback} onClick={()=>{setReviewTarget({section:'consistency',id:0});setTaskLocked(true);onLock(true)}}>全书一致性</button>
        {data.document.kind==='chapter'&&data.selected.id===data.document.activeVersion&&<button disabled={taskLocked || busy || !!feedback} onClick={()=>{setReviewTarget({section:'quality',id:data.document.id});setTaskLocked(true);onLock(true)}}>章节质量报告</button>}</div>}
      <button disabled={taskLocked || busy || !!feedback} onClick={() => setRange({ start: 0, end: data.selected.content.length })}>使用当前查看版本的全文</button>
      {candidate&&(data.selected.metadata?.schema==='lg.candidate.v1'||data.selected.metadata?.literary_task_policy==='lg.literary-task.v1')&&!reviewTarget&&<button disabled={taskLocked||busy||!!feedback} onClick={()=>{
        setReviewTarget({section:'candidate-analysis',document:data.document.id,version:data.selected.id,token:data.token});setTaskLocked(true);onLock(true)
      }}>检查或补齐监督报告</button>}
      {reviewTarget?.section==='candidate-analysis'?<CandidateAnalysis path={path} target={reviewTarget} onClose={()=>{setReviewTarget(null);setTaskLocked(false);onLock(false)}}/>:reviewTarget ? <ReviewPanel path={path} target={reviewTarget}
        onClose={() => { setReviewTarget(null); setTaskLocked(false); onLock(false) }}
        onRevise={value => {
          const target = value.target
          if (target.document !== data.document.id || target.version !== data.selected.id || target.token !== data.token) { setError('请先返回并切换到该报告对应的版本，再要求改稿。'); return }
          setRange({start:target.start,end:target.end}); setFeedback(value); setReviewTarget(null); setTaskLocked(false); onLock(true)
        }}/> : <TaskPanel key={feedback ? feedback.feedback.run + feedback.feedback.issues.join(',') : 'regular'} path={path} data={data} range={range} disabled={busy} openCandidate={refresh}
        feedback={feedback} clearFeedback={() => { setFeedback(null); onLock(false) }}
        onReview={() => { setReviewTarget({section:'manuscript',id:data.document.id,version_id:data.selected.id,token:data.token,...range}); setTaskLocked(true); onLock(true) }}
        lock={value => { setTaskLocked(value); onLock(!!feedback || value) }}/>}
    </>}
  </section>
}
