const chapters=new Map()
const documents=createDocumentStore(async file=>({content:chapters.get(file.path).text,version:chapters.get(file.path).text}),async()=>{throw Error('试用章节只读')})
const settings=createSettings({getItem:()=>null,setItem:()=>{}})
settings.set({enabled:true,clearAfterSend:false})
const root=createRoot(document.getElementById('root'))
let active=null,current=null
const runtime={documents,settings,append:(_session,text)=>parent.postMessage({type:'lg-reader:quote',text,chapterId:current.chapterId},'*')}
root.render(React.createElement('p',{className:'trial-wait'},'等待 LG 章节…'))
window.addEventListener('message',event=>{
  if(event.source!==parent)return
  const item=event.data
  if(item?.type!=='lg-reader:chapter'||typeof item.text!=='string'||typeof item.chapterId!=='string')return
  if(active)active.abort()
  current=item;chapters.set(item.chapterId,item);active=new AbortController()
  const doc=documents.get('lg-reader-trial',item.chapterId,{path:item.chapterId,sessionId:'lg-reader-trial'})
  doc.update({content:item.text,draft:item.text,version:item.text,loading:false,dirty:false,error:null})
  document.body.dataset.theme=item.theme==='dark'?'dark':'light'
  root.render(React.createElement('div',{className:'trial-frame'},
    React.createElement('header',{className:'trial-title'},item.title||'章节'),
    React.createElement(MarkdownDocument,{key:item.chapterId,doc,runtime,sessionId:'lg-reader-trial',tab:{signal:active.signal,visible:true,navigation:{}},meta:{failure:null,reload:()=>{}}})))
})
parent.postMessage({type:'lg-reader:ready'},'*')
