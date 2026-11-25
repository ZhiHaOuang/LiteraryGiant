import React,{useCallback,useEffect,useRef,useState} from 'react'
import {Card} from './charts.jsx'
import styles from './style.css'

import {requestBooks} from './api.js'

export function useShelf() {
  const [shelf,setShelf]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const active=useRef(null)
  const accept=useCallback(value=>{
    active.current?.abort()
    setShelf(value);setError('');setBusy(false)
  },[])
  const reload=useCallback(async()=>{
    active.current?.abort()
    const controller=new AbortController();active.current=controller
    setError('');setBusy(true)
    try {
      const value=await requestBooks({action:'shelf'},controller.signal)
      if(!controller.signal.aborted){setShelf(value);return value}
    } catch(error){if(!controller.signal.aborted)setError(error.message)}
    finally{if(!controller.signal.aborted)setBusy(false)}
  },[])
  useEffect(()=>{
    void reload()
    window.addEventListener('lg-books-changed',reload)
    return()=>{active.current?.abort();window.removeEventListener('lg-books-changed',reload)}
  },[reload])
  return {shelf,error,busy,reload,accept}
}
export function DirectoryChooser({ctx,onLoaded,onCancel,initial}) {
  const zh=ctx.locale.getLocale?.().active==='zh',l=(cn,en)=>zh?cn:en
  const [paths,setPaths]=useState({booksDirectory:initial?.booksPath??'',libraryDirectory:initial?.libraryPath??''}),[busy,setBusy]=useState(false),[error,setError]=useState('')
  async function pick(field){
    setError('')
    try{const value=await ctx.get('uiWorkspace')?.pickDirectory();if(value)setPaths(current=>({...current,[field]:value}))}catch(e){setError(e.message)}
  }
  async function submit(event){
    event.preventDefault();setBusy(true);setError('')
    try{const shelf=await requestBooks({...Object.fromEntries(Object.entries(paths).map(([key,value])=>[key,value.trim()])),action:'configure-directories'});if(shelf.error)throw Error(shelf.error);onLoaded(shelf)}
    catch(e){setError(e.message)}finally{setBusy(false)}
  }
  return <div className="lgd-page lgs-setup"><style>{styles}</style><div className="lgd-canvas"><Card title={l('分别选择 Books 和 Library','Choose Books and Library Separately')}>
    <h2>LiteraryGiant</h2><p>{l('无需登录。创作目录和参考库分别选择，可以放在不同的位置。','No sign-in required. Choose your writing and reference folders independently, anywhere on your computer.')}</p>
    <div className="lgd-columns"><div><b>Books/</b><p>{l('每本书一个文件夹，对应一个 workspace。','One folder and workspace for each book.')}</p></div><div><b>Library/</b><p>{l('共享的标准参考库，供文学工具与 Agent 调用。','Shared reference library for literary tools and agents.')}</p></div></div>
    <form onSubmit={submit}><fieldset disabled={busy}>
      {[['booksDirectory',l('Books 创作目录','Books Folder'),l('选择 Books 目录','Choose Books Folder')],['libraryDirectory',l('Library 参考库目录','Library Folder'),l('选择 Library 目录','Choose Library Folder')]].map(([field,label,button])=><div key={field} className="lgs-directory-field"><label>{label}<input aria-label={label} value={paths[field]} onChange={e=>setPaths({...paths,[field]:e.target.value})} placeholder={l('所选文件夹本身即为该目录','The selected folder itself is used')}/></label><button type="button" onClick={()=>pick(field)}>{button}</button></div>)}
      <div className="lgd-header-actions"><button disabled={!paths.booksDirectory.trim()||!paths.libraryDirectory.trim()}>{busy?l('加载中…','Loading…'):l('保存并加载','Save and Load')}</button>{onCancel&&<button type="button" onClick={onCancel}>{l('取消','Cancel')}</button>}</div></fieldset></form>
    <small>{l('直接加载各自选中的文件夹，不追加 Books/ 或 Library/ 子目录，不移动已有文件。','Loads each selected folder directly, without adding Books/ or Library/ subfolders or moving existing files.')}</small>
    {error&&<p role="alert" className="lgd-error">{error}</p>}
  </Card></div></div>
}
export function StartupFolder({ctx}) {
  const {shelf,error,busy,reload,accept}=useShelf()
  if(shelf?.booksPath&&shelf.libraryPath&&!shelf.error)return null
  if(!shelf&&!error)return null
  return <div className="lgs-first-run" role="dialog" aria-modal="true" aria-label="LiteraryGiant"><style>{styles}</style>
    {error?<div role="alert">{error}<button disabled={busy} onClick={reload}>↻</button></div>:<DirectoryChooser ctx={ctx} initial={shelf} onLoaded={value=>{accept(value);ctx.get('layout')?.selectPanel('lg-dashboard')}}/>}
  </div>
}
export function ShelfLocation({ctx,shelf,onChange,refreshAction}) {
  const zh=ctx.locale.getLocale?.().active==='zh',l=(cn,en)=>zh?cn:en
  const folderName=path=>path?.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||path||l('未设置','Not set')
  return <Card className="lgs-location-card" title={l('创作目录与参考库','Writing Folder & Library')} meta={<span className="lgs-folder-controls">
    {[['Books',shelf.booksPath],['Library',shelf.libraryPath]].map(([label,path])=><span className="lgs-folder-chip" key={label} title={path||l('未设置','Not set')}><span>{label}</span><span className="lgs-folder-name">{folderName(path)}</span></span>)}
    <button onClick={onChange}>{l('设置目录','Set Folders')}</button>{refreshAction}
  </span>}>
    {shelf.error&&<p role="alert">{shelf.error}</p>}
  </Card>
}
