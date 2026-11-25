import React,{useState,useRef,useLayoutEffect} from 'react'
import {Card} from './charts.jsx'
import {heatmapWindow} from './api-data.js'
import {localDay} from './global-data.js'
export function Activity({days,onSelect,ready}) {
  const [metric,setMetric]=useState('tokens')
  const calendar=useRef(null)
  useLayoutEffect(()=>{
    const el=calendar.current
    // Give every square and gutter the same whole-device-pixel size. Fractional
    // fr tracks distribute rounding across columns, making equal gaps look unequal.
    const measure=()=>{
      const css=getComputedStyle(el),ratio=window.devicePixelRatio||1
      const width=el.getBoundingClientRect().width-parseFloat(css.gridTemplateColumns)-parseFloat(css.columnGap)
      const gap=Math.round(Math.max(1,Math.min(3,width*.0025))*ratio)/ratio
      const cell=Math.max(1,Math.floor((width-52*gap)*ratio/53))/ratio
      el.style.setProperty('--heat-gap',gap+'px')
      el.style.setProperty('--heat-cell',cell+'px')
      el.style.setProperty('--heat-width',(53*cell+52*gap)+'px')
    }
    measure();const observer=new ResizeObserver(measure);observer.observe(el)
    window.addEventListener('resize',measure)
    return()=>{observer.disconnect();window.removeEventListener('resize',measure)}
  },[])
  const today=localDay(),keys=heatmapWindow(today)
  const max=Math.max(1,...Object.values(days).map(day=>day[metric]??0))
  const level=value=>!value?0:Math.min(5,Math.max(1,Math.ceil(value/max*5)))
  const date=key=>new Date(key+'T12:00:00')
  const formatDate=key=>date(key).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
  const months=Array.from({length:53},(_,index)=>({index,key:keys[index*7]}))
    .filter(({index,key})=>index===0||key.slice(0,7)!==keys[(index-1)*7].slice(0,7))
  return <Card icon="gauge" title="Activity" meta={<div className="lgd-segment">{['tokens','requests','sessions'].map(key=><button key={key} aria-pressed={metric===key} onClick={()=>setMetric(key)}>{({tokens:'Tokens',requests:'Requests',sessions:'Sessions'})[key]}</button>)}</div>}>
    <div className="lga-caption"><strong>{formatDate(keys[0])} – {formatDate(today)}</strong></div>
    {!ready&&<p className="lgd-muted">Waiting for activity records</p>}
    <div className="lga-calendar" ref={calendar}>
      <div className="lga-weekdays">{['Mon','Wed','Fri','Sun'].map((day,i)=><span key={day} style={{gridRow:i*2+1}}>{day}</span>)}</div>
      <div className="lga-months">{months.map(({index,key},i)=><span key={key} title={date(key).toLocaleDateString('en-US',{month:'long',year:'numeric'})} style={{gridColumn:`${index+1} / ${(months[i+1]?.index??53)+1}`}}>{date(key).toLocaleDateString('en-US',{month:'short'})}</span>)}</div>
      <div className="lga-heat">
      {keys.map(key=>{const value=days[key]?.[metric]??0;return <button key={key} disabled={key>today||!ready} data-level={level(value)} title={`${key} · ${ready?value.toLocaleString('en-US'):'—'} ${metric}`} aria-label={`${key} · ${value} ${metric}`} onClick={()=>onSelect(key)}/>})}
    </div></div><div className="lga-heat-key"><small>Less</small>{[0,1,2,3,4,5].map(level=><i key={level} data-level={level}/>)}<small>More</small></div>
  </Card>
}
