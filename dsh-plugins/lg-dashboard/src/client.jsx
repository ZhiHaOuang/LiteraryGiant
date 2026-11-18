import {bindBookshelfEntry} from './navigation.js'
import {DirectoryChooser,StartupFolder,useShelf} from './bookshelf.jsx'
import { GlobalDashboard } from './global.jsx'
import globalStyles from './global.css'
import React, { useEffect, useRef, useState } from 'react'
import zh from '../locale/zh.json'
import en from '../locale/en.json'
import { StoryIndex } from './story-index.jsx'
import {Icon} from './icons.jsx'
import { PendingVersions } from './pending-versions.jsx'
import {StoryData} from './story-data.jsx'
import styles from './style.css'
import {Card,Composition,ChapterChart,number,palette} from './charts.jsx'

export const inject = ['slots', 'locale', 'layout']
const CHAPTERS_PER_PAGE=10

import {requestBooks} from './api.js'

function BookIcon({size=18}) {return <Icon name="book" size={size}/>}
function BookshelfIcon({size=18}) {return <span data-lg-bookshelf-entry style={{display:'contents'}}><BookIcon size={size}/></span>}

function BookSupervision({ book, disabled, t }) {
  const [policy,setPolicy]=useState(book.supervision)
  const [busy,setBusy]=useState(false), [error,setError]=useState('')
  if (!policy) return null
  async function enable() {
    setBusy(true); setError('')
    try { setPolicy(await requestBooks({action:'enable-supervision',path:book.path,projectId:book.id,confirmed:true})) }
    catch (error) {setError(error.message)} finally {setBusy(false)}
  }
  return <section className="lgd-card"><h2><Icon name="review"/>{t('supervision')}</h2>
    {policy.error ? <p role="alert">{policy.error}</p> : policy.categories.length
      ? <p>{policy.categories.map(c=>t('supervision.'+c)).join(' · ')}</p>
      : <><p>{t('supervision.off')}</p><button disabled={disabled||busy} onClick={enable}>{t('supervision.enable')}</button></>}
    {error&&<p role="alert">{error}</p>}
  </section>
}

function Dashboard({ t,getEditor,initialBook,initialChapter,initialDiscover,ctx,onShelf,shelf,reloadShelf }) {
  const books = shelf.books
  const [selected, setSelected] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [pendingOnly,setPendingOnly]=useState(false)
  const [page, setPage] = useState(0)
  const [expanded,setExpanded]=useState(null)
  const active = useRef(null)
  const chapterBrowser = useRef(null)

  async function load(path, discover=false) {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError(''); setData(null); setPage(0);setExpanded(null)
    try {
      const current = discover ? await reloadShelf() : shelf
      if (controller.signal.aborted || !current) return
      const list = current.books
      if(path&&!list.some(book=>book.path===path&&!book.error))throw Error('此 workspace 尚不是已加载的 LG 作品，请返回书架检查。')
      const next = path || list.find(book => !book.error)?.path || ''
      setSelected(next)
      if (next) {
        const value=await requestBooks({action:'read',path:next}, controller.signal)
        if (!controller.signal.aborted) {
          setData(value)
          if (initialChapter) {
            setExpanded(initialChapter)
            setPage(Math.max(0,Math.floor(value.chapters.findIndex(c=>c.id===initialChapter)/CHAPTERS_PER_PAGE)))
          }
        }
      }
    } catch (error) { if (!controller.signal.aborted) setError(error.message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  useEffect(() => { void load(initialBook,initialDiscover); return () => active.current?.abort() }, [initialBook,initialChapter,initialDiscover])
  useEffect(()=>{
    if(expanded===null)return
    const frame=requestAnimationFrame(()=>chapterBrowser.current?.querySelector('.lgd-chapter-open .lgd-chapter-head')?.scrollIntoView({block:'nearest'}))
    return()=>cancelAnimationFrame(frame)
  },[expanded,page])

  const chapters = data?.chapters.filter(chapter => (!pendingOnly||chapter.pendingVersions>0)&&chapter.title.toLowerCase().includes(query.toLowerCase())) ?? []
  const totalPages = Math.max(1, Math.ceil(chapters.length / CHAPTERS_PER_PAGE))
  const currentPage=Math.min(page,totalPages-1)
  const state = value => t('state.' + value) || value
  const chapterRows=chapters.slice(currentPage*CHAPTERS_PER_PAGE,(currentPage+1)*CHAPTERS_PER_PAGE)
  const wordRows=data?[{label:t('acceptedWords'),value:data.acceptedWords},{label:t('draftWords'),value:Math.max(0,data.words-data.acceptedWords)}]:[]
  const coverage=data?[{label:t('written'),value:data.written},{label:t('unwritten'),value:data.chapters.length-data.written}]:[]
  function chooseChapter(chapter){
    setQuery('');setPendingOnly(false);setPage(Math.floor(data.chapters.findIndex(c=>c.id===chapter.id)/CHAPTERS_PER_PAGE));setExpanded(chapter.id)
    requestAnimationFrame(()=>chapterBrowser.current?.scrollIntoView({block:'nearest'}))
  }
  return <main className="lgd-page lgd-book-page">
    <style>{styles}</style>
    <header className="lgd-header lgd-topbar" data-window-drag><h1>{t('title')}</h1>
      <div className="lgd-header-actions"><button onClick={onShelf}>‹ {ctx.locale.getLocale?.().active==='zh'?'全局 Dashboard':'Global Dashboard'}</button>
      <button disabled={busy} onClick={()=>load(selected,true)}>{busy?t('loading'):t('refresh')}</button></div></header><div className="lgd-canvas">
    {error&&<p role="alert" className="lgd-error">{error}</p>}
    {books.filter(book=>book.error).map(book=><p className="lgd-error" key={book.path}>{book.path}: {book.error}</p>)}
    {!data&&!busy&&!error&&<section className="lgd-empty"><BookIcon size={36}/><h2>{t('empty')}</h2><p>{t('emptyHint')}</p><button onClick={onShelf}>‹ {ctx.locale.getLocale?.().active==='zh'?'全局 Dashboard':'Global Dashboard'}</button></section>}
    {busy&&<p role="status" className="lgd-muted">{t('loading')}</p>}
    {data&&<>
      <div className="lgd-overview-grid">
        <Card icon="data" title={t('bookStats')} meta={t('activeData')}>
          <div className="lgd-metrics">{[['words',data.words],['chapters',data.chapters.length],['candidates',data.counts.candidates],['facts',data.counts.facts]].map(([label,value],i)=><div className="lgd-metric" key={label}><b style={{color:palette[i]}}>{number(value)}</b><span>{t(label)}</span></div>)}</div>
          <div className="lgd-ledgers"><div><div className="lgd-ledger-title"><b>{t('manuscript')}</b><strong>{number(data.words)}</strong></div><div className="lgd-chips"><span><i style={{background:palette[0]}}/>{t('acceptedWords')} <b>{number(data.acceptedWords)}</b></span><span><i style={{background:palette[1]}}/>{t('draftWords')} <b>{number(Math.max(0,data.words-data.acceptedWords))}</b></span></div></div>
          <div><div className="lgd-ledger-title"><b>{t('needsAttention')}</b><strong>{number(data.counts.issues)}</strong></div><div className="lgd-chips"><span><i style={{background:palette[2]}}/>{t('proposals')} <b>{number(data.counts.proposals)}</b></span><span><i style={{background:palette[3]}}/>{t('foreshadowing')} <b>{number(data.counts.foreshadowing)}</b></span></div></div></div>
        </Card>
        <Card icon="book" title={t('overview')} className="lgd-book-info"><h3>{data.name}</h3><p className="lgd-synopsis">{data.overview||t('noOverview')}</p><details className="lgd-location"><summary>{t('bookLocation')}</summary><small>{data.path}</small></details></Card>
      </div>
      <StoryData key={data.path+':story-data'} path={data.path}/>
      <div className="lgd-columns">
        <Composition icon="database" title={t('manuscriptComposition')} rows={wordRows} total={data.words} label={t('wordUnit')} t={t}/>
        <Composition icon="gauge" title={t('chapterCoverage')} rows={coverage} total={data.chapters.length} label={t('chapterUnit')} t={t}/>
      </div>
      <div className="lgd-columns lgd-main-columns">
        <div className="lgd-column lgd-progress-reference"><Card icon="book" title={t('currentManuscript')} meta={t('wordsHint')}><div className="lgd-progress-number"><strong>{number(data.acceptedWords)} <small>/ {number(data.words)} {t('wordUnit')}</small></strong><span><b>{data.words?Math.round(data.acceptedWords/data.words*100):0}%</b> {t('adoptionRate')}</span></div>
          <div className="lgd-progress-track">{wordRows.map((row,i)=><i key={row.label} style={{width:(data.words?row.value/data.words*100:0)+'%',background:palette[i]}}/>)}</div><div className="lgd-chips">{wordRows.map((row,i)=><span key={row.label}><i style={{background:palette[i]}}/>{row.label} <b>{number(row.value)}</b></span>)}</div></Card>
          <ChapterChart key={data.path} chapters={data.chapters} t={t} onChoose={chooseChapter}/>
          <BookSupervision key={data.path} book={data} t={t} disabled={busy}/>
          <Card icon="folder" title={t('storyMaterials')}><p className="lgd-muted">正文提取的人物、情节和认知见上方「故事资料」；此处仅显示此前手工创建的资料。</p><details><summary><i className="lgd-dot" style={{background:palette[2]}}/>{t('characters')}<span className="lgd-row-meta">{data.characters.length}</span></summary>
            {data.characters.slice(0,40).map(person=><details key={person.id}><summary>{person.title}<span className="lgd-badge">{state(person.state)}</span></summary><p>{person.summary}</p></details>)}{!data.characters.length&&<p className="lgd-muted">{t('none')}</p>}{data.characters.length>40&&<small>{t('first40')}</small>}</details>
            <details><summary><i className="lgd-dot" style={{background:palette[1]}}/>{t('plans')}<span className="lgd-row-meta">{data.outlines.length}</span></summary>{data.outlines.map(outline=><p key={outline.id}>{outline.title} <span className="lgd-badge">{state(outline.state)}</span></p>)}{!data.outlines.length&&<p className="lgd-muted">{t('none')}</p>}</details></Card>
        </div>
        <div className="lgd-column lgd-chapter-column" id="lgd-chapter-browser" ref={chapterBrowser}><Card icon="plot" title={t('progress')} meta={`${chapters.length} / ${data.chapters.length}`} className="lgd-browser">
          <div className="lgd-browser-controls"><input type="search" aria-label={t('search')} placeholder={t('search')} value={query} onChange={e=>{setQuery(e.target.value);setPage(0)}}/><div className="lgd-segment"><button aria-pressed={!pendingOnly} onClick={()=>{setPendingOnly(false);setPage(0)}}>{t('allChapters')}</button><button aria-pressed={pendingOnly} onClick={()=>{setPendingOnly(true);setPage(0)}}>{t('pendingShort')}</button></div></div>
          <div className="lgd-browser-caption"><span>{t('chapter')}</span><span>{t('words')} / {t('status')}</span></div>
          <div className="lgd-chapter-list">{chapterRows.map(chapter=><div className={'lgd-chapter '+(expanded===chapter.id?'lgd-chapter-open':'')} key={chapter.id}>
            <button className="lgd-chapter-head" aria-expanded={expanded===chapter.id} onClick={()=>setExpanded(expanded===chapter.id?null:chapter.id)} title={chapter.title}>
              <span className="lgd-chevron" aria-hidden="true">{expanded===chapter.id?'⌄':'›'}</span><i className="lgd-dot" style={{background:chapter.acceptedWords?palette[0]:chapter.words?palette[1]:'var(--lgd-track)'}}/><strong>{chapter.title}</strong>
              {chapter.pendingVersions>0&&<span className="lgd-pending-badge">{chapter.pendingVersions} {t('pendingShort')}</span>}<span className="lgd-row-meta">{number(chapter.words)}</span><span className="lgd-badge">{state(chapter.state)}</span></button>
            {expanded===chapter.id&&<div className="lgd-chapter-body"><div className="lgd-chips"><span>{t('acceptedWords')} <b>{number(chapter.acceptedWords)}</b></span><span>{t('version')} <b>{chapter.version??'—'}</b></span></div>
              {chapter.source==='scenes'&&<small>{t('fromScenes')}</small>}
              <PendingVersions path={data.path} chapter={chapter.id} t={t} getEditor={getEditor}/></div>}
          </div>)}
          {!chapters.length&&<p className="lgd-muted">{t('noChapters')}</p>}</div>
          <nav className="lgd-pager lgd-chapter-pager" aria-label={t('progress')}><button disabled={!currentPage} onClick={()=>{setPage(currentPage-1);setExpanded(null)}}>{t('previous')}</button><span>{currentPage+1} / {totalPages} · {chapterRows.length} {t('chapterUnit')}</span><button disabled={currentPage+1>=totalPages} onClick={()=>{setPage(currentPage+1);setExpanded(null)}}>{t('next')}</button></nav>
        </Card></div>
      </div>
      <StoryIndex key={data.path} path={data.path} t={t}/>
      {data.warnings.map(warning=><p className="lgd-error" key={warning}>{warning}</p>)}
      <footer>{t('footnote')}</footer>
    </>}
    </div>
  </main>
}

function DashboardRoot({ctx,t,slotProps,navigation,legacy}) {
  // Single-panel desktop hosts do not supply a per-pane target.
  const [legacyTarget,setLegacyTarget]=useState(legacy.target)
  useEffect(()=>{
    if(slotProps.page)return
    legacy.update=setLegacyTarget
    return ()=>{if(legacy.update===setLegacyTarget)legacy.update=null}
  },[legacy,slotProps.page])
  const target=slotProps.page?slotProps.page.target:legacyTarget
  const view=target?.path?target:null
  const [choosing,setChoosing]=useState(false)
  const {shelf,error,busy:shelfLoading,reload:reloadShelf,accept:setShelf}=useShelf()
  const showGlobal=()=>navigation.openGlobal()
  const home=()=>{showGlobal();void reloadShelf()}
  if(error)return <div role="alert"><p>{error}</p><button disabled={shelfLoading} onClick={reloadShelf}>{t('retry')}</button></div>
  if(!shelf)return null
  if(!shelf.booksPath||!shelf.libraryPath||shelf.error||choosing)return <DirectoryChooser ctx={ctx} initial={shelf} onLoaded={s=>{setShelf(s);setChoosing(false);showGlobal()}} onCancel={shelf.booksPath&&shelf.libraryPath&&!shelf.error?()=>setChoosing(false):undefined}/>
  if(!view)return <GlobalDashboard ctx={ctx} slotProps={slotProps} shelf={shelf} shelfLoading={shelfLoading} onRefresh={reloadShelf} onChangeRoot={()=>setChoosing(true)}
    onOpenBook={(path,chapter)=>navigation.openBook(path,chapter)}/>
  return <div className="lgg-book-shell"><style>{globalStyles}</style><Dashboard key={view.path??'manage'} ctx={ctx} onShelf={home} shelf={shelf} reloadShelf={reloadShelf}
    t={t} initialBook={view.path} initialChapter={view.chapter} initialDiscover={view.discover}
    getEditor={()=>ctx.get('literaryWorkbench')}/>
</div>
}

export function apply(ctx) {
  const labels = dictionary => Object.fromEntries(Object.entries(dictionary).filter(([, value]) => typeof value === 'string'))
  ctx.effect(() => ctx.locale.register('lg-dashboard', { zh: labels(zh), en: labels(en) }), 'lg-dashboard: locale')
  const t = ctx.locale.bind('lg-dashboard')
  const legacy={target:null,update:null}
  const openPage=options=>{
    ctx.layout.selectPanel('lg-dashboard',options)
    legacy.target=options.target
    legacy.update?.(options.target)
  }
  const navigation={
    openGlobal:()=>openPage({scope:'pane',key:'default',title:'Global Dashboard',target:{}}),
    openBook:(path,chapter)=>openPage({scope:'pane',key:path,title:`${path.split('/').filter(Boolean).at(-1)} · Dashboard`,target:{path,chapter,discover:true}}),
  }
  const showGlobal=()=>navigation.openGlobal()
  ctx.effect(()=>bindBookshelfEntry(document,showGlobal),'lg-dashboard: bookshelf home')
  ctx.provide('literaryDashboard',navigation)
  ctx.slots.inject('settings.onboarding',()=>ctx.slots.register({name:'settings.onboarding',id:'lg-folder',order:-200},()=> <StartupFolder ctx={ctx}/>))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'lg-dashboard', locale: 'lg-dashboard' }, props =>
    <DashboardRoot navigation={navigation} legacy={legacy} ctx={ctx} t={t} slotProps={props}/>))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'lg-dashboard',
    order: 15, locale: 'lg-dashboard', label: () => ctx.locale.getLocale?.().active==='zh'?'书架总览':'Bookshelf' }, BookshelfIcon))
}
