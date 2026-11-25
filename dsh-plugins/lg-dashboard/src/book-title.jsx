import React,{useRef,useState} from 'react'
import {requestBooks} from './api.js'

export function BookTitle({book,t,onSaved}) {
  const [draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const trigger=useRef(null),previous=useRef('')
  function finish() {
    setDraft(null)
    requestAnimationFrame(()=>trigger.current?.focus())
  }
  async function save(event) {
    event.preventDefault()
    if(busy||!draft?.trim())return
    setBusy(true);setError('')
    try {
      const saved=await requestBooks({action:'rename',path:book.path,projectId:book.id,expectedName:previous.current,name:draft})
      onSaved(saved);finish()
    } catch(reason){setError(reason.message)} finally {setBusy(false)}
  }
  if(draft===null)return <div className="lgd-book-title"><h3>{book.name}</h3>
    <button ref={trigger} onClick={()=>{previous.current=book.name;setDraft(book.name);setError('')}}>{t('renameBook')}</button></div>
  return <form onSubmit={save} onKeyDown={e=>{if(e.key==='Escape'&&!busy&&!e.nativeEvent.isComposing){e.preventDefault();finish()}}}>
    <div className="lgd-book-title"><input autoFocus onFocus={e=>e.target.select()} aria-label={t('bookName')} maxLength={200} value={draft} disabled={busy} onChange={e=>setDraft(e.target.value)}/>
    <button type="submit" disabled={busy||!draft.trim()}>{t('saveName')}</button><button type="button" disabled={busy} onClick={finish}>{t('cancelName')}</button></div>
    {error&&<p className="lgd-error" role="alert">{error}</p>}
  </form>
}
