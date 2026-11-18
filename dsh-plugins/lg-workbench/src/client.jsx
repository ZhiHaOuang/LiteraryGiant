import React, { useEffect, useRef, useState } from 'react'
import { request } from './api.js'
import { Documents } from './documents.jsx'
import { ChapterFiles, mirrorStatus, publicationStatus } from './chapter-files.jsx'
import { Editor } from './editor.jsx'
import { ReaderTrial } from './reader-trial.jsx'
import styles from './style.css'

export const inject = ['slots','layout']
const Icon = () => <span aria-hidden="true">✎</span>
function Workbench({initialTarget,updatePage,lockPage,closePage,revealChapter}) {
  const [books, setBooks] = useState([]), [path, setPath] = useState('')
  const [chapters, setChapters] = useState([]), [data, setData] = useState(null)
  const [error, setError] = useState(''), [receipt, setReceipt] = useState(null)
  const [locked, setLocked] = useState(false), [busy, setBusy] = useState(false)
  const [mode, setMode] = useState('manuscript')
  const [reader, setReader] = useState('whalesong')
  const active = useRef(null)
  const pageCallbacks=useRef({updatePage,lockPage,closePage})
  pageCallbacks.current={updatePage,lockPage,closePage}
  function lock(value){setLocked(value);pageCallbacks.current.lockPage?.(value)}
  async function load(nextPath, doc, version) {
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    setBusy(true); setError('')
    try {
      const list = await request({ action: 'list' }, controller.signal)
      setBooks(list)
      const selectedPath = nextPath || ''
      if (!selectedPath) { setPath('');setData(null); return }
      const book = await request({ action: 'read', path: selectedPath }, controller.signal)
      const id = doc ?? book.chapters[0]?.id
      const value=id ? await request({ action: 'manuscript', path: selectedPath, document: id, version }, controller.signal) : null
      if(controller.signal.aborted)return
      if(value){
        const chapter=value.parts.find(part=>part.kind==='chapter')
        const key=JSON.stringify([selectedPath,chapter.id])
        if(pageCallbacks.current.updatePage?.({key,title:`${book.name} · ${chapter.title}`})===false){
          revealChapter(selectedPath,chapter.id,id,version)
          if(!data)pageCallbacks.current.closePage?.()
          return
        }
      }
      setPath(selectedPath);setChapters(book.chapters);setData(value)
    } catch (error) { if (!controller.signal.aborted) setError(error.message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  useEffect(() => { void load(initialTarget?.path??'',initialTarget?.document,initialTarget?.version); return () => active.current?.abort() }, [initialTarget])
  async function refresh(version, result) {
    if (result) setReceipt(result)
    await load(path, data.document.id, version)
  }
  return <main className="lgw-page"><style>{styles}</style>
    <header><div><small>LITERARYGIANT</small><h1>文学编辑台</h1></div>
      <button disabled={busy || locked} onClick={() => load(path, data?.document.id)}>刷新</button></header>
    <div className="lgw-toolbar"><label>作品<select aria-label="作品" disabled={busy || locked} value={path}
      onChange={event => { setReceipt(null); void load(event.target.value) }}>
      <option value="">先在小说控制台添加作品</option>{books.map(book => <option key={book.path} value={book.path} disabled={!!book.error}>{book.name ?? book.path}</option>)}</select></label>
      {mode !== 'documents' && <label>章节<select aria-label="章节" disabled={busy || locked} value={data?.parts.find(part => part.kind === 'chapter')?.id ?? ''}
        onChange={event => { setReceipt(null); void load(path, Number(event.target.value)) }}>
        <option value="">选择章节</option>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select></label>}</div>
    <nav><button disabled={locked || busy} onClick={() => setMode('manuscript')}>章节正文</button><button disabled={locked || busy} onClick={() => setMode('reader')}>阅读对照</button><button disabled={locked || busy} onClick={() => setMode('documents')}>作品资料</button><button disabled={busy || locked} onClick={() => setMode('files')}>章节文件</button></nav>
    {mode === 'reader' && !busy && data && <ReaderTrial path={path} data={data} chapters={chapters} busy={busy} choice={reader} onChoice={setReader}
      bookTitle={books.find(book=>book.path===path)?.name??''} onChapter={id=>load(path,id)} onVersion={refresh} onBack={()=>setMode('manuscript')}/>}
    {mode === 'reader' && busy && <p role="status">正在加载章节…</p>}
    {mode === 'reader' && !busy && !data && <p>选择已有作品和章节后即可对照阅读。</p>}
    {mode === 'files' && data && <ChapterFiles key={path + ':' + data.parts.find(part => part.kind === 'chapter').id}
      path={path} onLock={lock} chapter={data.parts.find(part => part.kind === 'chapter').id} onApplied={() => load(path, data.document.id)}/>}
    {mode === 'documents' && path && <Documents key={path} path={path} onLock={lock}/>}
    {error && <p role="alert">{error}</p>}
    {mode === 'manuscript' && receipt && <p role="status">操作已完成 · {receipt.action} · 版本 ID {receipt.version}。
      {mirrorStatus(receipt)}{publicationStatus(receipt)}</p>}
    {locked && <p className="lgw-note">有未保存内容或待确认操作；完成或放弃后可切换作品与版本。</p>}
    {mode === 'manuscript' && data && <><nav aria-label="章节与场景">{data.parts.map(part => <button key={part.id} disabled={busy || locked || part.id === data.document.id}
      onClick={() => { setReceipt(null); void load(path, part.id) }}>{part.kind === 'chapter' ? '章节' : '场景'} · {part.title}</button>)}</nav>
      <fieldset disabled={busy} className="lgw-fieldset"><Editor key={path + ':' + data.document.id + ':' + data.selected.id + ':' + data.token}
        path={path} data={data} refresh={refresh} onLock={lock}/></fieldset></>}
    {mode === 'manuscript' && !data && !busy && <p>请选择作品，再打开需要阅读或编辑的章节。</p>}
  </main>
}
export function apply(ctx) {
    ctx.inject(['layout'],scope=>scope.provide('literaryWorkbench',{
    openVersion(path,document,version) {
      scope.layout.selectPanel('lg-workbench',{key:JSON.stringify([path,document]),title:'文学编辑台',target:{path,document,version}})
    },
  }))
  function Panel(props) {
    return <Workbench {...props} initialTarget={props.page?.target} revealChapter={(path,chapter,document,version)=>ctx.layout.selectPanel('lg-workbench',{key:JSON.stringify([path,chapter]),target:{path,document,version}})}/>
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'lg-workbench' }, Panel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'lg-workbench', order: 16,
    label: () => '文学编辑台' }, Icon))
}
