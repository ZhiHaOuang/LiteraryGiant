import React,{useMemo,useState,useEffect} from 'react'
import {Card} from './charts.jsx'
import {apiStats} from './api-data.js'
import {estimateSessionCost} from './context-data.js'
const colors=Array.from({length:8},(_,i)=>`color-mix(in srgb, var(--dsw-alias-button-primary-fill,#d97757) ${100-i*9}%, var(--dsw-alias-bg-layer-1))`)
const short=n=>new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(n)
const cost=n=>n===null?'—':'¥'+n.toLocaleString(undefined,{maximumFractionDigits:4})
export function ApiPanel({rows,range,dayKeys:keys,prices,ready,l,refresh}) {
  const [mode,setMode]=useState('tokens'),[chosen,setChosen]=useState(null),[day,setDay]=useState(null)
  const [providers,setProviders]=useState([]),[error,setError]=useState(false)
  useEffect(()=>{
    const controller=new AbortController()
    fetch('api/lg/dashboard/providers',{method:'POST',signal:controller.signal}).then(r=>r.json()).then(data=>{if(!controller.signal.aborted){setProviders(data.providers??[]);setError(!data.ok)}}).catch(()=>{if(!controller.signal.aborted)setError(true)})
    return ()=>controller.abort()
  },[refresh])
  useEffect(()=>{setDay(null)},[range.from,range.to])
  const valid=keys.length>0
  const groups=useMemo(()=>valid?apiStats(rows,range):[],[rows,range.from,range.to,valid])
  const total=groups.reduce((sum,g)=>sum+g.tokens,0)
  const present=new Set(groups.map(g=>g.provider))
  const idle=providers.filter(p=>!present.has(p.id))
  const active=groups.find(g=>g.key===chosen)??null
  const shown=active?[active]:groups
  const max=Math.max(1,...keys.map(key=>shown.reduce((sum,g)=>sum+(g.days[key]??0),0)))
  const price=g=>(prices?.prices?.[g.provider]||g.provider.startsWith('deepseek'))?estimateSessionCost(g.costUsage,prices,'cny'):null
  const speed=g=>g.speedMs>0?g.speedTokens/g.speedMs*1000:null
  const selectDay=day&&keys.includes(day)?day:null
  return <Card icon="agent" title={l('API / 模型统计','API / Model Statistics')} meta={<div className="lgd-segment">{['tokens','speed'].map(key=><button key={key} aria-pressed={mode===key} onClick={()=>setMode(key)}>{key==='tokens'?l('Token 趋势','Token trend'):l('速度','Speed')}</button>)}</div>}>
    <div className="lga-caption"><strong>{ready?short(total):'—'} Tokens</strong><small>{range.from} — {range.to}</small>{active&&<button onClick={()=>setChosen(null)}>{active.provider} / {active.model} ×</button>}</div>
    {!valid?<p className="lgg-empty">{l('请选择有效日期','Select a valid date range')}</p>:mode==='tokens'?<>
      <div className="lga-trend"><div className="lga-axis">{[1,.75,.5,.25,0].map(n=><small key={n}>{short(max*n)}</small>)}</div><div className="lga-columns">{keys.map(key=><button key={key} aria-pressed={selectDay===key} title={`${key} · ${short(shown.reduce((sum,g)=>sum+(g.days[key]??0),0))} Tokens`} onClick={()=>setDay(selectDay===key?null:key)}>{shown.map(group=><i key={group.key} style={{height:(group.days[key]??0)/max*100+'%',background:colors[groups.indexOf(group)%colors.length]}}/>)}</button>)}</div></div>
      <div className="lga-chart-dates" style={{gridTemplateColumns:`repeat(${keys.length},minmax(0,1fr))`}}>{keys.map((key,i)=><span key={key}>{i%Math.ceil(keys.length/8)===0?key.slice(5):''}</span>)}</div>
    </>:<div className="lga-speed">{groups.filter(g=>speed(g)!==null).map(g=><div key={g.key}><span>{g.provider} / {g.model}</span><meter min="0" max={Math.max(1,...groups.map(g=>speed(g)??0))} value={speed(g)}/><b>{speed(g).toFixed(1)} tok/s</b></div>)}{!groups.some(g=>speed(g)!==null)&&<p className="lgg-empty">{l('此区间没有可归属到单个模型的速度样本','No attributable per-model speed samples in this range')}</p>}</div>}
    <div className="lga-detail"><strong>{selectDay??l('区间汇总','Range overview')}</strong><span>{l('模型','Models')} {groups.length}</span><span>{l('Tokens','Tokens')} {short(selectDay?groups.reduce((s,g)=>s+(g.days[selectDay]??0),0):total)}</span></div>
    <div className="lga-composition">{groups.map((g,i)=><i key={g.key} style={{width:(total?g.tokens/total*100:0)+'%',background:colors[i%colors.length]}}/>)}</div>
    <div className="lgg-table-scroll"><table className="lga-api-table"><thead><tr>{[l('API / 模型','API / Model'),l('请求','Requests'),'Input / Output',l('Token 占比','Token share'),l('费用 · 估算','Cost · est.'),'tok/s','TTFT',l('速度样本','Timed calls')].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{groups.map((g,i)=><tr key={g.key}><td><button onClick={()=>setChosen(chosen===g.key?null:g.key)} aria-pressed={chosen===g.key}><i className="lgd-dot" style={{background:colors[i%colors.length]}}/>{providers.find(p=>p.id===g.provider)?.name??g.provider}<small>{g.model}</small></button></td><td title={g.requestKnown?'':l('混合模型的每日请求无法拆分','Daily requests cannot be split across models')}>{g.requestKnown?g.requests:'—'}</td><td>{short(g.input)} / {short(g.output)}</td><td>{total?(g.tokens/total*100).toFixed(1):0}%</td><td>{cost(price(g))}</td><td title={l('仅完整单模型会话样本','Complete single-model session samples only')}>{speed(g)===null?'—':speed(g).toFixed(1)}</td><td>{g.timedCalls?(g.ttftMs/g.timedCalls/1000).toFixed(2)+'s':'—'}</td><td>{g.timedCalls||'—'}</td></tr>)}</tbody></table></div>
    {!groups.length&&<p className="lgg-empty">{ready?l('此区间暂无已记录调用','No recorded calls in this range'):l('等待 API 用量记录','Waiting for API usage records')}</p>}
    {idle.length>0&&<details className="lga-provider-list"><summary>{l('API 服务','API services')} · {providers.length}</summary><div className="lga-idle">{providers.map(p=><span key={p.id} title={p.id}>{p.name}</span>)}</div></details>}
    {error&&<small role="status">{l('服务目录暂不可用，仍展示已有调用记录','Provider directory unavailable; recorded usage is still shown')}</small>}

  </Card>
}
