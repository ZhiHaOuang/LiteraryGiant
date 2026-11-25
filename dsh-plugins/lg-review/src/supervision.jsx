import React,{useState} from 'react'
import {request,reviewAcceptance} from './api.js'

export function Supervision({review,input,busy,setBusy,onReviewed}) {
  const [selected,setSelected]=useState(null),[reviewer,setReviewer]=useState(''),[reason,setReason]=useState(''),[error,setError]=useState('')
  async function decide() {
    setBusy(true);setError('')
    try {
      await request({...input,action:'adjudicate-supervision',...selected,reviewer,reason,confirmed:true})
      onReviewed(await reviewAcceptance(input))
      setSelected(null);setReason('')
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  return <section aria-label="候选监督报告"><h4>候选监督报告 · {review.reports.length} 项</h4>
    {review.reports.map(r=><article key={r.category}><strong>{r.category}</strong> · {r.run}
      {r.dismissed.map(d=><p key={d.finding}>第 {d.finding} 项 · {d.reviewer} 判为误报 · {d.reason}</p>)}
      {r.conflicts.map(f=><section key={f.finding}><h4>第 {f.finding} 项 · 正式设定冲突</h4><p>{f.explanation}</p>
        <blockquote>设定 #{f.factId} · {f.factQuote}</blockquote>
        {f.evidence.map((e,i)=><blockquote key={i}>文档 {e.document_id} · 版本 {e.version_id} · {e.quote}</blockquote>)}
        <button disabled={busy} onClick={()=>{setSelected({reportDigest:r.digest,finding:f.finding});setReason('');setError('')}}>审阅此冲突</button>
        {selected?.reportDigest===r.digest&&selected.finding===f.finding&&<fieldset disabled={busy}>
          <label>裁决人<input value={reviewer} maxLength={200} onChange={e=>setReviewer(e.target.value)}/></label>
          <label>误报理由<textarea value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)}/></label>
          <button disabled={!reviewer.trim()||!reason.trim()} onClick={decide}>确认记录为误报</button>
          <button onClick={()=>setSelected(null)}>取消裁决</button>
        </fieldset>}</section>)}</article>)}
    {error&&<p role="alert">{error}</p>}</section>
}
