import React, {useEffect,useRef,useState} from 'react'
import {requestBooks} from './api.js'

export function PendingVersions({path,chapter,t,getEditor}) {
  const [page,setPage]=useState({items:[],before:null}),[busy,setBusy]=useState(true),[error,setError]=useState('')
  const active=useRef(null)
  async function load(before=null) {
    active.current?.abort()
    const controller=new AbortController();active.current=controller;setBusy(true);setError('')
    try {
      const value=await requestBooks({action:'pending-versions',path,chapter,before},controller.signal)
      if(!controller.signal.aborted)setPage(old=>({items:before?[...old.items,...value.items]:value.items,before:value.before}))
    }catch(e){if(!controller.signal.aborted)setError(e.message)}
    finally{if(!controller.signal.aborted)setBusy(false)}
  }
  useEffect(()=>{void load();return()=>active.current?.abort()},[path,chapter])
  const editor=getEditor()
  return <div aria-label={t('chapterCandidates')}>
    {page.items.map(item=><p key={item.version}><strong>{item.title} · v{item.number}</strong> {item.reason}
      {editor&&<button onClick={()=>{try{editor.openVersion(path,item.document,item.version)}catch(e){setError(e.message)}}}>{t('reviewVersion')}</button>}</p>)}
    {busy&&<p>{t('loading')}</p>}
    {error&&<p role="alert">{error} <button onClick={()=>load(page.before)}>{t('retry')}</button></p>}
    {!busy&&!error&&!page.items.length&&<p>{t('noPendingVersions')}</p>}
    {!busy&&page.before!=null&&!error&&<button onClick={()=>load(page.before)}>{t('olderCandidates')}</button>}
  </div>
}
