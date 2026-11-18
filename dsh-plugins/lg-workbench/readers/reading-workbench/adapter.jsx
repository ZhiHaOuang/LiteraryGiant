import React, {useEffect, useMemo, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ReaderView} from './upstream/src/client/panel/ReaderView.tsx'
import {STYLES} from './upstream/src/client/styles.ts'
import {zh} from './upstream/src/client/locales.ts'

// The upstream reader is unchanged. Only its book/content API is scoped to the
// chapter supplied by LG; trial marks/settings never write the manuscript.
const trials=new Map()
function memoryApi(chapter){
  let state=trials.get(chapter.chapterId)
  if(!state||state.text!==chapter.text){
    state={text:chapter.text,marks:[],progress:undefined,next:0}
    trials.set(chapter.chapterId,state)
  }
  return {
    content:async()=>({content:chapter.text}),
    listHighlights:async()=>state.marks,
    createHighlight:async(input)=>{
      const mark={...input,id:chapter.chapterId+':'+(++state.next),createdAt:Date.now()}
      state.marks=[...state.marks,mark];return mark
    },
    deleteHighlight:async(id)=>{state.marks=state.marks.filter(mark=>mark.id!==id)},
    updateHighlightNote:async(id,note)=>{
      const mark=state.marks.find(mark=>mark.id===id)
      if(!mark)throw Error('试用批注已不存在')
      mark.note=note;return mark
    },
    saveProgress:async(input)=>{state.progress={...input,updatedAt:Date.now()};return state.progress},
    get progress(){return state.progress},
  }
}
function Trial(){
  const [chapter,setChapter]=useState(null)
  const [settings,setSettings]=useState({fontSize:20,lineHeight:1.8,theme:'follow',columns:'auto',txtReflow:'preserve',bookCss:'unified',fontFamily:'serif'})
  useEffect(()=>{
    const receive=event=>{
      const data=event.data
      if(event.source!==parent||data?.type!=='lg-reader:chapter')return
      if(typeof data.title!=='string'||typeof data.text!=='string'||typeof data.chapterId!=='string')return
      setChapter(current=>current?.chapterId===data.chapterId&&current.title===data.title&&current.text===data.text?current:{title:data.title,text:data.text,chapterId:data.chapterId})
    }
    addEventListener('message',receive)
    parent.postMessage({type:'lg-reader:ready'},'*')
    return()=>removeEventListener('message',receive)
  },[])
  const api=useMemo(()=>chapter?memoryApi(chapter):null,[chapter])
  return <div className="dsh-reading-page"><style>{STYLES}</style>{chapter?
    <ReaderView key={chapter.chapterId} api={api} t={key=>key==='reader.back'?'返回编辑':zh[key]}
      book={{id:chapter.chapterId,title:chapter.title,format:'txt',sourcePath:'',addedAt:0}}
      settings={settings} progress={api.progress} onSettingsChange={patch=>setSettings(current=>({...current,...patch}))}
      onBack={()=>parent.postMessage({type:'lg-reader:back'},'*')}/>:<p className="waiting">等待 LG 章节…</p>}
  </div>
}
createRoot(document.getElementById('root')).render(<Trial/>);
