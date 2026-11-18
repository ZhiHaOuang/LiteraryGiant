import React, { useEffect, useRef, useState } from 'react'
import {requestBooks} from './api.js'
import {Icon} from './icons.jsx'

const groups = ['characters','relationships','events','links']
export function StoryIndex({ path, t }) {
  const [data,setData] = useState(null), [group,setGroup] = useState('characters')
  const [query,setQuery] = useState(''), [page,setPage] = useState(0)
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [receipt,setReceipt] = useState('')
  const active = useRef(null)
  useEffect(() => () => active.current?.abort(), [])
  async function load(save = false) {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError(''); setReceipt('')
    try {
      const value = await requestBooks({action:save ? 'story-index-save' : 'story-index',path,token:save ? data.token : undefined},controller.signal)
      if (save) {
        setData(previous => ({...previous,current:true}))
        setReceipt(t('index.saved')+' '+value.path+(value.backup ? ' · '+t('index.backup')+' '+value.backup : ''))
      } else { setData(value); setPage(0) }
    } catch (e) { if (!controller.signal.aborted) { setData(null); setError(e.message) } }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const rows = data?.[group] ?? []
  const nodes = data && (group === 'relationships' ? data.characters : group === 'links' ? data.events : [])
  const names = new Map((nodes || []).map(n => [n.id,n.name ?? n.label]))
  const title = row => row.source ? names.get(row.source)+' → '+names.get(row.target)+' · '+row.label : row.name ?? row.label
  const needle = query.trim().toLowerCase()
  const hits = rows.filter(row => !needle || [title(row),row.summary,row.role,row.evidence.document].join(' ').toLowerCase().includes(needle))
  return <section className="lgd-card lgd-index"><div className="lgd-section-head"><h2><Icon name="agent"/>{t('index.title')}</h2>
    <button disabled={busy} onClick={() => load()}>{data ? t('refresh') : t('index.read')}</button></div>
    {error && <p role="alert">{error}</p>}
    {data && <><nav aria-label={t('index.title')}>{groups.map(key => <button key={key} aria-pressed={key===group}
      onClick={() => { setGroup(key); setPage(0) }}>{t('index.'+key)} · {data[key].length}</button>)}</nav>
      <input aria-label={t('index.search')} placeholder={t('index.search')} value={query} onChange={e => { setQuery(e.target.value); setPage(0) }}/>
      {hits.slice(page*25,(page+1)*25).map((row,i) => <details key={group+':'+page+':'+i+':'+title(row)}>
        <summary>{title(row)} {row.evidence.state === 'analysis' && <span className="lgd-badge">{t('index.analysis')}</span>} {row.planned && <span className="lgd-badge">{t('state.planned')}</span>}</summary>
        {row.role && <p>{row.role}</p>}{row.summary && <p>{row.summary}</p>}
        <small>{t('index.source')} · {row.evidence.document} · {row.evidence.state}
          {row.evidence.version != null && ' · v'+row.evidence.version}
          {row.evidence.document_id != null && ' · #'+row.evidence.document_id}
          {row.evidence.fact_id != null && ' · #'+row.evidence.fact_id}
          {row.evidence.sha256 && ' · SHA-256 '+row.evidence.sha256}</small>
        {row.evidence.quotes?.map((q,n) => <blockquote key={n}><p>{q.quote}</p>
          <small>{q.title} · {t('index.'+q.kind)} · #{q.document_id} · {t('index.versionId')} {q.version_id}</small></blockquote>)}</details>)}
      {!hits.length && <p>{t('none')}</p>}
      {hits.length > 25 && <nav className="lgd-pager"><button disabled={!page} onClick={() => setPage(page-1)}>{t('previous')}</button>
        <span>{page+1} / {Math.ceil(hits.length/25)}</span><button disabled={(page+1)*25>=hits.length} onClick={() => setPage(page+1)}>{t('next')}</button></nav>}
      {data.missing > 0 && <details><summary>{t('index.missing')} · {data.missing}</summary>
        {(data.gaps ?? []).map((gap,n) => <p key={n}>{gap.source}{gap.version != null && ' · v'+gap.version} · {t('index.'+gap.reason)}</p>)}
        {data.gaps && data.missing > data.gaps.length && <small>{t('index.first50')}</small>}</details>}
      {data.issues.length > 0 && <details><summary>{t('index.incomplete')} · {data.issues.length}</summary>
        {data.issues.map((issue,n) => <p key={n}>{issue}</p>)}</details>}
      <button disabled={busy || data.current || data.issues.length>0} onClick={() => load(true)}>{t('index.rebuild')}</button>
      {receipt && <p role="status">{receipt}</p>}
    </>}
  </section>
}
