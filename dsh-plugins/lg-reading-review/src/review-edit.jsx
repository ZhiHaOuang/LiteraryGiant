import React, { useState } from 'react'
import { request } from '../../lg-review/src/api.js'

export function ReviewEdit({path,data,style,onClose,onSaved}) {
  const [text,setText] = useState(data.selected.content), [reason,setReason] = useState('')
  const [pending,setPending] = useState(null), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const dirty = text !== data.selected.content
  function preview(action) {
    setPending({ action,path,document:data.document.id,version:data.selected.id,sourceVersion:data.selected.id,
      token:data.token,content:text,reason:reason.trim(),operation:crypto.randomUUID() })
    setError('')
  }
  async function confirm() {
    setBusy(true); setError('')
    try { onSaved(await request(pending)) }
    catch(e) { setError(e.message);setBusy(false) }
  }
  return <div className="lgrv-edit">
    <div className="lgrv-card-head"><h3>{data.document.title}</h3><span>v{data.selected.version_number}</span></div>
    <label>Chapter text<textarea aria-label="Edit manuscript" value={text} style={style} readOnly={!!pending}
      onChange={event => setText(event.target.value)}/></label>
    <label>Reason for edit<input aria-label="Reason for this edit" placeholder="What should this edit improve?" maxLength={2000}
      value={reason} readOnly={!!pending} onChange={event => setReason(event.target.value)}/></label>
    {error && <p role="alert">{error}</p>}
    {pending ? <section className="lgrv-edit-confirm" aria-label="Save preview"><strong>{pending.action==='edit'?'Preview author edit':'Preview new candidate'}</strong>
      <p>{pending.action==='edit'?'Confirm to make this the current manuscript. The previous version will be kept.':'Confirm to save a separate candidate for review.'}</p>
      <div className="lgrv-inline"><button className="lgrv-primary" disabled={busy} onClick={confirm}>{busy?'Saving…':'Confirm save'}</button>
        <button disabled={busy} onClick={() => setPending(null)}>Back to editing</button></div></section> :
      <div className="lgrv-inline">
        {data.selected.id===data.document.activeVersion && <button className="lgrv-primary" disabled={!dirty||!reason.trim()} onClick={() => preview('edit')}>Preview author edit</button>}
        <button disabled={!dirty||!reason.trim()} onClick={() => preview('candidate')}>Preview candidate</button>
        <button onClick={onClose}>{dirty?'Discard changes':'Back to reading'}</button>
      </div>}
  </div>
}
