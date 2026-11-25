import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { paragraphs, selectedPassage, readLocal, writeLocal } from './review-text.js'
import { ReviewEdit } from './review-edit.jsx'
import { NoteSticker } from './review-sticker.jsx'

export async function requestReadingNotes(scope, input, signal) {
  const response = await fetch('api/lg/reading-notes', { method: 'POST', signal,
    headers: {'content-type':'application/json'}, body: JSON.stringify({...scope,...input}) })
  const result = await response.json()
  if (!result.ok) throw Error(result.error || 'Could not load notes.')
  return result.value
}
const fonts = {
  serif: '"Songti SC","Noto Serif CJK SC",serif',
  sans: '"PingFang SC","Microsoft YaHei",sans-serif',
  kai: 'KaiTi,"Kaiti SC","STKaiti",serif',
}
export function ReviewChapter({ pageChrome, path, data, type, navigating, onLock, showNotes, onShowNotes, chapterIndex, total, onStep, onSaved }) {
  const content = data.selected.content
  const scope = { path, document: data.document.id, version: data.selected.id }
  const positionKey = 'lg.reading.position.' + JSON.stringify([path,scope.document,scope.version])
  const [notes,setNotes] = useState(data.readingNotes), [ready,setReady] = useState(!data.notesError)
  const [draft,setDraft] = useState(null), [selection,setSelection] = useState(null)
  const [active,setActive] = useState(''), [filter,setFilter] = useState('all')
  const [error,setError] = useState(data.notesError), [saving,setSaving] = useState(false)
  const [retry,setRetry] = useState(0)
  const [editing,setEditing] = useState(false)
  const body = useRef(null), viewport = useRef(null), cards = useRef(null), editor = useRef(null)
  const busyRef = useRef(false)
  const rows = useMemo(() => paragraphs(content,notes),[content,notes])
  // The service returns newest first. Older notes keep their number when a new one is added.
  const numbers = useMemo(() => new Map(notes.map((note,i)=>[note.id,notes.length-i])),[notes])
  const chapterNotes = notes.filter(note=>!note.quote)
  const visible = notes.filter(note => filter === 'all' || (filter === 'done') === Boolean(note.resolved))
  const locked = !!draft || saving || editing
  const readOnly = locked || navigating
  const typeStyle = {fontFamily:fonts[type.font],fontSize:type.size,lineHeight:type.line,'--paragraph-gap':type.gap+'em'}
  useEffect(() => {
    setNotes(data.readingNotes); setReady(!data.notesError); setError(data.notesError)
  }, [data])
  useEffect(() => {
    if (!retry) return
    const controller = new AbortController()
    setReady(false)
    requestReadingNotes(scope,{action:'list'},controller.signal).then(value => {
      if (!controller.signal.aborted) { setNotes(value); setReady(true); setError('') }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [path,scope.document,scope.version,retry])
  useLayoutEffect(() => {
    const el = viewport.current
    el.scrollTop = (el.scrollHeight - el.clientHeight) * readLocal(positionKey,0)
    let timer
    const remember = () => {
      const max = el.scrollHeight - el.clientHeight
      if (max > 0) writeLocal(positionKey,Math.max(0,Math.min(1,el.scrollTop/max)))
    }
    const scroll = () => { clearTimeout(timer); timer = setTimeout(remember,150) }
    el.addEventListener('scroll',scroll)
    return () => { el.removeEventListener('scroll',scroll); if (timer) { clearTimeout(timer); remember() } }
  }, [positionKey])
  useEffect(() => {
    const read = () => { const range = selectedPassage(body.current,content); if (range) setSelection(range) }
    const doc = body.current.ownerDocument
    doc.addEventListener('selectionchange',read)
    return () => doc.removeEventListener('selectionchange',read)
  }, [content])
  useEffect(() => { if (draft) editor.current?.focus() }, [draft?.id])
  function start(row) {
    if (readOnly) return
    setError(''); onShowNotes(true); onLock(true)
    setDraft(row ? {...row} : { id:crypto.randomUUID(), start:0,end:0,quote:'',note:'',...selection })
  }
  function discard() { setDraft(null); onLock(false) }
  async function save(row, action, resolved) {
    if (busyRef.current || navigating) return
    busyRef.current = true; setSaving(true); onLock(true); setError('')
    let keepDraft = !!draft
    try {
      const value = await requestReadingNotes(scope,{...row, action, resolved:!!resolved})
      setNotes(value); setDraft(null); setSelection(null); setActive(row.id); setFilter('all')
      keepDraft = false
    } catch(e) { setError(e.message) }
    finally { busyRef.current = false; setSaving(false); onLock(keepDraft) }
  }
  function locate(note) {
    setActive(note.id)
    const sticker = viewport.current.querySelector('[data-note-number="'+numbers.get(note.id)+'"]')
    sticker?.focus({preventScroll:true})
    sticker?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})
  }
  function inspect(id) {
    if (readOnly) return
    setSelection(null); onShowNotes(true); setFilter('all'); setActive(id)
    requestAnimationFrame(() => {
      const card = cards.current?.querySelector('[data-note="'+id+'"]')
      card?.focus({preventScroll:true})
      card?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})
    })
  }
  function openSticker(id) {
    return <NoteSticker key={id} number={numbers.get(id)} action="Open" disabled={readOnly} onClick={()=>inspect(id)}/>
  }
  const tooLong = (selection?.quote.length ?? 0) > 4000
  const actions=<div className="lgrv-page-actions">
    {!editing && <button type="button" disabled={readOnly} onClick={()=>{setSelection(null);setEditing(true);onLock(true)}}>Edit text</button>}
    <button type="button" aria-pressed={showNotes} disabled={locked} onClick={()=>onShowNotes(!showNotes)}>{showNotes?'Hide review':'Show review'}</button>
  </div>
  return <>
    <section className="lgrv-paper lgrv-panel" aria-label="Chapter reader">
      {navigating && <span className="lgrv-opening" role="status">Opening…</span>}
      {pageChrome?.actions ? pageChrome.actions(actions) : <div className="lgrv-panel-head"><h2>{editing?'Edit text':'Text'}</h2>{actions}</div>}
      {editing && <ReviewEdit path={path} data={data} style={typeStyle} onSaved={receipt=>{setEditing(false);onLock(false);onSaved(receipt)}}
        onClose={()=>{setEditing(false);onLock(false)}}/>}
      <div className="lgrv-scroll-paper" hidden={editing} ref={viewport} tabIndex={0} aria-label="Manuscript">
        <div className="lgrv-sheet"><div className="lgrv-byline">Chapter {chapterIndex+1} / {total} · Version {data.selected.version_number}</div>
          <div className="lgrv-chapter-title"><h3>{data.document.title}</h3>
            {chapterNotes.map(note=>openSticker(note.id))}</div>
          <article ref={body} className="lgrv-prose" style={typeStyle}>
            {rows.map(row => <p key={row.start} data-text-start={row.start}>{row.pieces.map(part => part.ids.length
              ? <mark key={part.text ? part.start : part.anchors[0]} data-note-ids={part.ids.join(' ')} className={part.ids.includes(active)?'active':''}
                  onClick={() => {if (window.getSelection()?.isCollapsed) inspect(part.ids.includes(active)?active:part.ids[0])}}>
                  {part.anchors.map(openSticker)}{part.text}</mark>
              : <React.Fragment key={part.start}>{part.text}</React.Fragment>)}</p>)}
          </article>{!rows.length && <p className="lgrv-empty">This version is empty. You can still add a chapter note.</p>}</div>
      </div>
      {!editing && <div className="lgrv-paper-foot"><button disabled={locked||chapterIndex<1} onClick={() => onStep(-1)}>‹ Previous</button>
        <button className="lgrv-quote-button" disabled={!selection||tooLong||readOnly||!ready} onClick={() => start()}>{tooLong?'Select up to 4,000 characters':'Annotate selection'}</button>
        <button disabled={locked||chapterIndex<0||chapterIndex+1>=total} onClick={() => onStep(1)}>Next ›</button></div>}
    </section>
    {showNotes && <aside className="lgrv-notes lgrv-panel" aria-label="Chapter review">
      <div className="lgrv-panel-head"><h2>Review <small>{notes.length}</small></h2>
        <button disabled={readOnly||!ready||tooLong} onClick={() => start()} className="lgrv-primary">+ Add note</button></div>
      <div className="lgrv-notes-body" ref={cards}>
        {error && <div role="alert">{error} <button disabled={saving} onClick={() => setRetry(n=>n+1)}>Reload notes</button></div>}
        {draft ? <form className="lgrv-draft" onSubmit={event => {event.preventDefault();void save(draft,draft.revision?'update':'create',draft.resolved)}}>
          <strong>{draft.revision?'Edit note':draft.quote?'Passage note':'Chapter note'}</strong>
          {draft.quote && <blockquote>{draft.quote}</blockquote>}
          <textarea aria-label="Note" ref={editor} placeholder="Write your review…" maxLength={4000} value={draft.note}
            disabled={saving} onChange={e => setDraft({...draft,note:e.target.value})}/>
          <div className="lgrv-inline"><button type="submit" className="lgrv-primary" disabled={!draft.note.trim()||saving}>{saving?'Saving…':'Save note'}</button>
            <button type="button" disabled={saving} onClick={discard}>Cancel</button></div>
        </form> : selection && <div className="lgrv-selection"><b>Selected passage</b><blockquote>{selection.quote}</blockquote>
          <div className="lgrv-inline"><button disabled={tooLong||!ready||readOnly} onClick={() => start()}>Add passage note</button>
          <button disabled={saving} onClick={() => {window.getSelection()?.removeAllRanges();setSelection(null)}}>Clear selection</button></div></div>}
        {notes.length>0 && <label className="lgrv-filter">Show<select value={filter} onChange={e=>setFilter(e.target.value)}>
          <option value="all">All notes</option><option value="open">Open</option><option value="done">Resolved</option></select></label>}
        {visible.map(note => <section key={note.id} data-note={note.id} tabIndex={-1} aria-label={'Note '+numbers.get(note.id)} className={'lgrv-card'+(note.id===active?' selected':'')}>
          <div className="lgrv-card-head"><div className="lgrv-card-title">
            <NoteSticker number={numbers.get(note.id)} action="Locate" disabled={editing} onClick={()=>locate(note)}/>
            <strong>{note.quote?'Passage note':'Chapter note'}</strong></div><span>{note.resolved?'Resolved':'Open'}</span></div>
          {note.quote && <blockquote>{note.quote}</blockquote>}<p>{note.note}</p>
          <div className="lgrv-inline"><button disabled={editing} onClick={() => locate(note)}>Locate</button>
            <button disabled={readOnly} onClick={() => start(note)}>Edit</button>
            <button disabled={readOnly} onClick={() => save(note,'update',!note.resolved)}>{note.resolved?'Reopen':'Resolve'}</button></div>
        </section>)}
        {!draft && !visible.length && <p className="lgrv-empty">{!ready?(error?'':'Loading notes…'):notes.length?'No notes with this status.':'Select a passage to annotate it, or add a note for the whole chapter.'}</p>}
      </div>
    </aside>}
  </>
}
