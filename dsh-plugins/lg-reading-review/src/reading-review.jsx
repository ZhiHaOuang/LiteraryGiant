import React, { useEffect, useRef, useState } from 'react'
import { request } from '../../lg-review/src/api.js'
import { ReviewChapter, requestReadingNotes } from './review-chapter.jsx'
import { ReviewSettings } from './review-toolbar.jsx'
import { defaultType, readLocal, writeLocal } from './review-text.js'
import styles from './reading-review.css'
import { receiptStatus } from './receipt-status.js'

export const readingReviewTitle = 'Reading Review'

export function ReadingReview({pageChrome,initialTarget, lockPage, updatePage}) {
  const [books,setBooks] = useState([]), [book,setBook] = useState(null), [data,setData] = useState(null)
  const [busy,setBusy] = useState(true), [locked,setLocked] = useState(false), [error,setError] = useState('')
  const [query,setQuery] = useState(''), [mobileContents,setMobileContents] = useState(false)
  const [showNotes,setShowNotes] = useState(true)
  const [receipt,setReceipt] = useState(null)
  const [type,setType] = useState(() => ({...defaultType,...readLocal('lg.reading.type',{})}))
  const active = useRef(null), lastRequest = useRef(null), pageAPI = useRef(null)
  pageAPI.current = {lockPage,updatePage}
  function lock(value) { setLocked(value); pageAPI.current.lockPage?.(value) }
  async function open(target = {}, currentBook, saved = null) {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    lastRequest.current = {target,currentBook,saved}
    const fetchData = input => request(input,controller.signal)
    setBusy(true); setError('')
    try {
      let path = target.path
      if (!currentBook && (!path || !books.length)) {
        const list = await fetchData({action:'list'})
        if (controller.signal.aborted) return
        setBooks(list)
        if (!path) {
          const saved = readLocal('lg.reading.book','')
          path = list.find(b => b.path === saved && !b.error)?.path ?? list.find(b => !b.error)?.path
        }
        if (!path) { setBook(null); setData(null); setReceipt(null); return }
      }
      const next = currentBook?.path === path ? currentBook : await fetchData({action:'read',path})
      const remembered = readLocal('lg.reading.chapter.'+path,null)
      const document = target.document ?? next.chapters.find(c => c.id===remembered)?.id ?? next.chapters[0]?.id
      const value = document ? await fetchData({action:'manuscript',path,document,version:target.version}) : null
      if (controller.signal.aborted) return
      let readingNotes = [], notesError = ''
      if (value) {
        try {
          readingNotes = await requestReadingNotes({path,document:value.document.id,version:value.selected.id},{action:'list'},controller.signal)
        } catch (e) { notesError = e.message }
      }
      if (controller.signal.aborted) return
      const nextChapter = value?.parts.find(c => c.kind==='chapter')?.id
      if (book?.path!==path) setQuery('')
      if (book?.path!==path || nextChapter!==chapter?.id) setMobileContents(false)
      setBook(next); setData(value && {...value,readingNotes,notesError}); setReceipt(saved)
      writeLocal('lg.reading.book',path)
      if (nextChapter!=null) writeLocal('lg.reading.chapter.'+path,nextChapter)
    } catch(e) { if (!controller.signal.aborted) { setError(e.message); if (saved) setReceipt(saved) } }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  useEffect(() => {
    pageAPI.current.updatePage?.({title:readingReviewTitle})
    void open(initialTarget)
    return () => active.current?.abort()
  }, [initialTarget])
  useEffect(()=>{
    const controller=new AbortController()
    const refresh=async()=>{
      try {
        const list=await request({action:'list'},controller.signal)
        if(controller.signal.aborted)return
        setBooks(list)
        const current=list.find(item=>item.path===book?.path)
        // Update only metadata; preserve the current chapter and any unsaved edit.
        if(current) setBook(value=>({...value,name:current.name}))
      } catch(error){if(!controller.signal.aborted)setError(error.message)}
    }
    window.addEventListener('lg-books-changed',refresh)
    return()=>{controller.abort();window.removeEventListener('lg-books-changed',refresh)}
  },[book?.path])
  const chapters = book?.chapters ?? []
  const chapter = data?.parts.find(c => c.kind==='chapter')
  const index = chapters.findIndex(c => c.id===chapter?.id)
  const chapterRows = chapters.filter(c => c.title.toLowerCase().includes(query.trim().toLowerCase()))
  const changeChapter = id => {
    if (busy || id !== data?.document.id) void open({path:book.path,document:id},book)
  }
  const retry = () => {
    const {target,currentBook,saved} = lastRequest.current
    void open(target,currentBook,saved)
  }
  const settings=<ReviewSettings type={type} onChange={value=>{setType(value);writeLocal('lg.reading.type',value)}}
    books={books} book={book} onBook={path=>{if (busy || path!==book?.path) void open({path})}} data={data} disabled={locked}
    onVersion={version=>{if (busy || version!==data.selected.id) void open({path:book.path,document:data.document.id,version},book)}}/>
  return <main className="lgrv"><style>{styles}</style><div className="lgrv-inner">
    {!pageChrome?.actions && <header className="lgrv-top"><h1>{readingReviewTitle}</h1></header>}
    {settings}
    {error && <p role="alert">{error} <button disabled={locked||busy} onClick={retry}>Reload</button></p>}
    {busy && !book && <p role="status">Loading book…</p>}
    {receipt && <p role="status">{receipt.action==='edit'?'Author edit saved':'Candidate saved'} · Version ID {receipt.version}. {receiptStatus(receipt)}</p>}
    {!busy && !book && !error && <p className="lgrv-empty">No books yet. Choose your Books folder in Global Dashboard.</p>}
    {book && <div className={'lgrv-grid'+(showNotes?'':' without-notes')+(mobileContents?' contents-open':'')} aria-busy={busy}>
      <section className="lgrv-contents lgrv-panel" aria-label="Table of Contents"><div className="lgrv-panel-head"><h2>Table of Contents <small>{chapters.length}</small></h2>
        <button className="lgrv-mobile-toggle" aria-expanded={mobileContents} onClick={() => setMobileContents(!mobileContents)}>{mobileContents?'Collapse':'Expand'}</button></div>
        <div className="lgrv-directory"><input type="search" aria-label="Filter chapters" placeholder="Filter chapters…" value={query} onChange={e=>setQuery(e.target.value)}/>
          <div className="lgrv-list">{chapterRows.map(c => <button key={c.id} disabled={locked} aria-current={c.id===chapter?.id?'page':undefined}
            onClick={() => changeChapter(c.id)}>{c.title}</button>)}
            {!chapterRows.length && <p className="lgrv-empty">{query?'No matching chapters.':'No chapters yet.'}</p>}</div>
        </div></section>
      {data && <ReviewChapter key={JSON.stringify([book.path,data.document.id,data.selected.id])}
        pageChrome={pageChrome} path={book.path} data={data} type={type} navigating={busy} onLock={lock} showNotes={showNotes} onShowNotes={setShowNotes}
        chapterIndex={index} total={chapters.length} onStep={n => changeChapter(chapters[index+n].id)}
        onSaved={receipt=>open({path:book.path,document:data.document.id,version:receipt.version},book,receipt)}/>}
      {!busy && !data && <p className="lgrv-empty">This book has no chapters to review.</p>}
    </div>}
  </div></main>
}
