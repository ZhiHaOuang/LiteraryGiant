import React,{useState} from 'react'
import {Card} from './charts.jsx'
import {heatmapWindow} from './api-data.js'
import {localDay} from './global-data.js'
export function Activity({days,l,onSelect,ready}) {
  const [metric,setMetric]=useState('tokens'),[page,setPage]=useState(0)
  const today=localDay(),keys=heatmapWindow(today,page)
  const max=Math.max(1,...Object.values(days).map(day=>day[metric]??0))
  const oldest=Object.keys(days).sort()[0]
  const level=value=>!value?0:Math.min(5,Math.max(1,Math.ceil(value/max*5)))
  const months=Array.from({length:53},(_,index)=>{const key=keys[index*7],previous=keys[(index-1)*7];return index===0||key.slice(0,7)!==previous?.slice(0,7)?key.slice(0,7):''})
  return <Card icon="gauge" title="Activity" meta={<div className="lgd-segment">{['tokens','requests','sessions'].map(key=><button key={key} aria-pressed={metric===key} onClick={()=>setMetric(key)}>{({tokens:'Tokens',requests:l('请求','Requests'),sessions:l('会话','Sessions')})[key]}</button>)}</div>}>
    <div className="lga-caption"><span>{keys[0]} — {keys.filter(key=>key<=today).at(-1)}</span><nav><button disabled={!oldest||oldest>=keys[0]} onClick={()=>setPage(page+1)}>{l('更早','Earlier')}</button><button disabled={page===0} onClick={()=>setPage(page-1)}>{l('较新','Newer')}</button></nav></div>
    {!ready&&<p className="lgd-muted">{l('等待活动记录','Waiting for activity records')}</p>}
    <div className="lga-heat-scroll"><div className="lga-calendar"><div className="lga-weekdays"><span>{l('周一','Mon')}</span><span>{l('周三','Wed')}</span><span>{l('周日','Sun')}</span></div><div className="lga-months">{months.map((month,i)=><span key={i}>{month}</span>)}</div><div className="lga-heat">
      {keys.map(key=>{const value=days[key]?.[metric]??0;return <button key={key} disabled={key>today||!ready} data-level={level(value)} title={`${key} · ${ready?value.toLocaleString():'—'} ${metric}`} aria-label={`${key} · ${value} ${metric}`} onClick={()=>onSelect(key)}/>})}
    </div></div></div><div className="lga-heat-key"><small>{l('少','Less')}</small>{[0,1,2,3,4,5].map(level=><i key={level} data-level={level}/>)}<small>{l('多','More')}</small></div>
  </Card>
}
