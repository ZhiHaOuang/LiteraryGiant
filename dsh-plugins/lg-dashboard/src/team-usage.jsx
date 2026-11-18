import {makePreviewRecords,withPreview} from './usage-preview.js'
import {timelineColors} from './components/time-stacks.js'
import {AgentTimelines} from './components/AgentTimelines'
import React,{useMemo,useState,useRef,useLayoutEffect} from 'react'
import {roleColors,monitorOf,totalRoles,short,percent,seconds,usageBar,usageBars,usageModes,tokenPair} from './team-data.js'
const usageUnit=mode=>mode==='time'?'Time':mode==='requests'?'Requests':'Tokens'
const chartRoles={coordinator:'Lead',analysis:'Analysis',planning:'Planning',writing:'Writing'}
const modeLabels={tokens:'Tokens',context:'Context',requests:'Requests',time:'Duration'}
const partLabel=p=>({text:'Answers',reasoning:'Reasoning',toolarg:'Tool args',unknown:'Unrecorded',other:'Other',ttft:'TTFT',unsegmented:'Unrecorded',completed:'Completed',failed:'Failed',pending:'Running'}[p.key]??p.label)
const format=(value,mode)=>mode==='time'?seconds(value):mode==='context'&&value!==null?'≈'+short(value):short(value)
function Ring({bars,mode,onChoose,selected}){
 const sum=bars.reduce((n,r)=>n+(r.value??0),0),known=bars.some(r=>r.value>0)||bars.every(r=>r.value===0);let offset=0
 return <div className="lgt-distribution"><div className="lgt-ring"><svg viewBox="0 0 100 100" aria-label="各 Agent 区间用量占比" role="img"><circle cx="50" cy="50" r="39" fill="none" stroke="var(--lgd-track)" strokeWidth="10"/>{bars.filter(r=>r.value>0).map(row=>{const size=row.value/sum*100,start=offset;offset+=size;return <circle key={row.role} cx="50" cy="50" r="39" pathLength="100" fill="none" stroke={roleColors[row.role]} strokeWidth="10" strokeDasharray={`${size} ${100-size}`} strokeDashoffset={-start} transform="rotate(-90 50 50)"><title>{chartRoles[row.role]} {percent(row.value,sum)}</title></circle>})}</svg><span><b>{known?format(sum,mode):'—'}</b><small>{usageUnit(mode)}</small></span></div>
 <div className="lgt-ring-legend">{bars.map(row=><button key={row.role} onClick={()=>onChoose(row.role)} aria-pressed={selected===row.role} title={`${chartRoles[row.role]} · ${format(row.value,mode)} · ${row.value===null?'—':percent(row.value,sum)} · 查看构成`}><i style={{background:roleColors[row.role]}}/><span>{chartRoles[row.role]}<small>{format(row.value,mode)}</small></span><b>{row.value===null?'—':percent(row.value,sum)}</b></button>)}</div></div>
}
function LegendName({text}){
 const ref=useRef(null),[clipped,setClipped]=useState(false)
 useLayoutEffect(()=>{
  const el=ref.current,measure=()=>setClipped(el.scrollWidth>el.clientWidth)
  measure();const observer=new ResizeObserver(measure);observer.observe(el)
  return()=>observer.disconnect()
 },[text])
 return <span ref={ref} className="lgt-legend-name" data-clipped={clipped||undefined} title={text}>{text}</span>
}
function TokenBreakdown({pair}){
 return <><div className="lgt-token-breakdowns" title="Category proportions are estimates. Gray indicates unrecorded composition.">{[['input','Input'],['output','Output']].map(([key,label])=>{const side=pair[key],parts=side.parts.filter(p=>p.value>0)
  return <div className="lgt-token-breakdown" key={key}><div className="lgt-breakdown-head"><b>{label} · {short(side.value)} Tokens</b></div>
   {parts.length?<><div className="lgt-sharebar">{parts.map(p=><i key={p.key} style={{width:p.value/side.value*100+'%',background:p.color}} title={`${p.label} ${p.key==='unknown'?'未采集':'约 '+percent(p.value,side.value)}`}/>)}</div>
   <div className="lgt-breakdown-legend">{parts.map(p=><span className="lgt-legend-item" key={p.key}><i style={{background:p.color}}/><LegendName text={partLabel(p)}/><b>{p.key==='unknown'?'': '≈'}{percent(p.value,side.value)}</b></span>)}</div></>:<p className="lgd-muted lgt-measure-empty">{side.value===null?'Usage unavailable.':'No usage.'}</p>}
  </div>})}</div>
 </>
}
export function TeamUsage({data,unbound,onCapacity}){
 const [role,setRole]=useState('all'),[mode,setMode]=useState('tokens')
 const records=useMemo(()=>makePreviewRecords(Date.now()),[])
 const monitor=useMemo(()=>{const real=monitorOf(data);return !unbound?withPreview(real,records):real},[data,records,unbound]),rows=unbound?[]:monitor.roles,scoped=role==='all'?rows:rows.filter(r=>r.role===role),total=totalRoles(scoped)
 const bars=usageBars(rows,mode),detail=usageBar(total,mode)
 const sum=bars.reduce((n,r)=>n+(r.value??0),0),parts=detail.parts
 const choose=r=>setRole(role===r?'all':r)
 return <>
 <div className="lgt-monitor-controls"><div className="lgd-segment lgt-mode-tabs">{Object.entries(usageModes).map(([key,label])=><button key={key} aria-pressed={mode===key} onClick={()=>setMode(key)}>{modeLabels[key]}</button>)}</div></div>
 <div className="lgt-kpis">{[['Requests',short(total.requests)],['Tokens',total.requests&&!total.known?'—':short(total.input+total.output)],['Cache Hit',total.cacheKnown?percent(total.cacheRead,total.cacheInput):'—'],['Output Speed',total.generationMs?short(total.speedTokens/total.generationMs*1000)+' tok/s':'—']].map(([label,value])=><div key={label}><small>{label}</small><b>{value}</b></div>)}</div>

 <div className="lgt-stat-plots"><Ring bars={bars} mode={mode} onChoose={choose} selected={role}/><AgentTimelines timeline={monitor.timeline} unbound={unbound} onCapacity={onCapacity} mode={mode}/></div>
 <div className="lgt-request-caption"><b>{role==='all'?'All Agents':chartRoles[role]}</b><span>{modeLabels[mode]} {format(detail.value,mode)} {usageUnit(mode)}{role!=='all'&&detail.value!==null?` · ${percent(detail.value,sum)}`:''}</span></div>
 {mode==='tokens'?<TokenBreakdown pair={tokenPair(total,timelineColors)}/>:<div className="lgt-breakdown">
 <div className="lgt-breakdown-head"><b>{role==='all'?'Overview':chartRoles[role]} · {modeLabels[mode]}</b><small>{mode==='context'?'dsh-context 估算 · 非实际账单':mode==='time'?'不含工具执行':'所选时间范围'}</small></div>
 {detail.value>0?<><div className="lgt-sharebar">{parts.filter(p=>p.value>0).map(p=><i key={p.key} style={{width:p.value/detail.value*100+'%',background:p.color}} title={`${p.label} ${percent(p.value,detail.value)}`}/>)}</div><div className="lgt-breakdown-legend">{parts.map(p=><span className="lgt-legend-item" key={p.key}><i style={{background:p.color}}/><LegendName text={partLabel(p)}/><b>{percent(p.value,detail.value)}</b><small>{format(p.value,mode)}</small></span>)}</div></>:<p className="lgd-muted lgt-measure-empty">{detail.value===null?'这部分历史记录未采集，无法还原构成。':'No usage in this range。'}</p>}
 </div>}

 </>
}
