import {Icon} from './icons.jsx'
import React, { useState } from 'react'

export const number = value => Number(value ?? 0).toLocaleString()
export const palette = ['var(--lgd-primary, #327dff)', 'var(--lgd-accent, var(--dsw-alias-brand-primary, #d97757))', '#8b50ff', '#18b49b']
export function Card({title,meta,children,className='',icon='book'}) {
  return <section className={'lgd-card '+className}><div className="lgd-section-head"><h2><Icon name={icon}/>{title}</h2>{meta&&<span className="lgd-meta">{meta}</span>}</div>{children}</section>
}
export function Composition({title,rows,total,label,t,icon='data'}) {
  let offset=0
  return <Card title={title} icon={icon} meta={t('activeData')}>
    <div className="lgd-composition"><div className="lgd-ring">
      <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="39" fill="none" stroke="var(--lgd-track)" strokeWidth="10"/>
        {rows.map((row,i)=>{const share=total>0?row.value/total*100:0;const start=offset;offset+=share;return share>0&&<circle key={row.label} cx="50" cy="50" r="39" pathLength="100" fill="none" stroke={palette[i]} strokeWidth="10" strokeDasharray={`${share} ${100-share}`} strokeDashoffset={-start} transform="rotate(-90 50 50)"/>})}</svg>
      <div><b>{number(total)}</b><small>{label}</small></div></div>
      <dl className="lgd-legend">{rows.map((row,i)=><div key={row.label}><dt><i style={{background:palette[i]}}/>{row.label}</dt><dd>{total>0?(row.value/total*100).toFixed(1)+'%':'—'}</dd><small>{number(row.value)} {label}</small></div>)}</dl>
    </div>
  </Card>
}
export function ChapterChart({chapters,t,onChoose}) {
  const [metric,setMetric]=useState('words'),[page,setPage]=useState(0)
  const pages=Math.max(1,Math.ceil(chapters.length/16)),current=Math.min(page,pages-1),rows=chapters.slice(current*16,(current+1)*16)
  const max=Math.max(1,...rows.map(c=>c[metric]))
  return <Card title={t('chapterDistribution')} icon="data" meta={<div className="lgd-segment" aria-label={t('chartMetric')}>{['words','acceptedWords'].map(key=><button key={key} aria-pressed={metric===key} onClick={()=>setMetric(key)}>{t(key)}</button>)}</div>}>
    {rows.length?<><div className="lgd-chart"><div className="lgd-chart-axis">{[1,.75,.5,.25,0].map(n=><span key={n}>{number(Math.round(max*n))}</span>)}</div>
      <div className="lgd-bars">{rows.map((c,i)=><button key={c.id} className="lgd-bar-column" onClick={()=>onChoose(c)} aria-label={`${c.title} · ${t(metric)} ${number(c[metric])}`} title={`${c.title} · ${number(c[metric])}`}>
        <span className="lgd-bar-space"><i style={{height:`${c[metric]/max*100}%`,background:palette[metric==='words'?1:0]}}/></span><small>{current*16+i+1}</small></button>)}</div></div>
      <div className="lgd-chart-foot"><small>{t('chartHint')}</small>{pages>1&&<nav className="lgd-pager"><button disabled={!current} onClick={()=>setPage(current-1)} aria-label={t('previous')}>‹</button><span>{current+1}/{pages}</span><button disabled={current+1>=pages} onClick={()=>setPage(current+1)} aria-label={t('next')}>›</button></nav>}</div></>:<p className="lgd-muted lgd-chart-empty">{t('noChapters')}</p>}
  </Card>
}
