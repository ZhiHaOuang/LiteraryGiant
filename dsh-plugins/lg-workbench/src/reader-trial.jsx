import React, {useEffect, useRef, useState} from 'react'
import {previews} from '../readers/previews.js'
import {readerChapter, readerMessage} from './reader-data.js'
import styles from './reader-trial.css'

export function ReaderTrial({path, data, chapters, bookTitle, onChapter, onVersion, busy, choice, onChoice, onBack}) {
  const [quote,setQuote]=useState(''),[wide,setWide]=useState(false)
  const frame=useRef(null)
  const chapter=readerChapter(path,data,chapters,bookTitle)
  const payload=useRef(chapter);payload.current=chapter
  const back=useRef(onBack);back.current=onBack
  const current=chapters.findIndex(item=>item.id===data.document.id)
  const selected=previews.find(item=>item.id===choice)
  useEffect(()=>{
    function receive(event){
      const message=readerMessage(event,frame.current?.contentWindow)
      if(message?.type==='ready')frame.current.contentWindow.postMessage(payload.current,'*')
      if(message?.type==='quote')setQuote(message.text)
      if(message?.type==='back')back.current()
    }
    window.addEventListener('message',receive)
    return()=>window.removeEventListener('message',receive)
  },[])
  useEffect(()=>{setQuote('')},[choice,chapter.chapterId])
  return <section className={'lgr-trial'+(wide?' lgr-expanded':'')} aria-label="章节阅读对照">
    <style>{styles}</style>
    <div className="lgr-toolbar"><div className="lgr-choices" role="group" aria-label="阅读器方案">
      {previews.map(item=><button key={item.id} aria-pressed={choice===item.id} onClick={()=>onChoice(item.id)}>{item.label}</button>)}
    </div><button onClick={()=>setWide(!wide)}>{wide?'收起阅读':'展开阅读'}</button></div>
    <div className="lgr-toolbar"><strong>{data.document.title}</strong><div className="lgr-controls">
      <button disabled={busy||current<=0} onClick={()=>onChapter(chapters[current-1].id)}>上一章</button>
      <select aria-label="阅读章节" disabled={busy} value={data.document.id} onChange={event=>onChapter(Number(event.target.value))}>
        {chapters.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
      </select><button disabled={busy||current<0||current>=chapters.length-1} onClick={()=>onChapter(chapters[current+1].id)}>下一章</button>
      <select aria-label="阅读版本" disabled={busy} value={data.selected.id} onChange={event=>onVersion(Number(event.target.value))}>
        {data.versions.map(version=><option key={version.id} value={version.id}>v{version.version_number} · {version.state}{version.id===data.document.activeVersion?' · 当前正文':''}</option>)}
      </select></div></div>
    <p className="lgr-caption">{selected.description} <a href={selected.source} target="_blank" rel="noreferrer">查看原项目</a></p>
    <p className="lgr-note">只读对照，不改正文、不调用模型。试用划线与批注在切换章节、方案或退出后清除；需要保留时先导出或复制。</p>
    <iframe key={choice+chapter.chapterId} ref={frame} title={selected.label+' · 章节阅读'} sandbox="allow-scripts allow-downloads"
      srcDoc={selected.html} onLoad={()=>frame.current?.contentWindow?.postMessage(payload.current,'*')}/>
    {quote&&<details open className="lgr-excerpt"><summary>选文与批注摘录 · 可复制</summary><textarea aria-label="阅读摘录" readOnly value={quote}/></details>}
  </section>
}
