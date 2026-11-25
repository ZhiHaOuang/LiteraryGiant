import React,{useEffect,useRef,useState} from 'react'
import {makeStackedBar} from '../../dsh-context/src/client/components/stackedBar.tsx'
import {storySectionLabels} from '../../lg-books/src/story-data/labels.js'
import {categories,sumParts} from './space-categories.js'
import {RollingShare,StorageField} from './storage-meter.jsx'

const decimals=new Intl.NumberFormat('en-US',{maximumFractionDigits:1})
const bytes=value=>{
  const units=['B','KiB','MiB','GiB','TiB']
  let i=0,n=Math.abs(value)
  while(n>=1024 && i<units.length-1){n/=1024;i++}
  return (value<0?'−':'')+decimals.format(n)+' '+units[i]
}
const CompositionBar=makeStackedBar({fmt:bytes,catLabel:key=>key,t:()=>'of measured storage'})
export function Modes({name,items,value,onChange}){
  return <div className="lg-space-modes" role="group" aria-label={name}>
    {items.map(([id,label])=><button type="button" key={id} aria-pressed={value===id} onClick={()=>onChange(id)}>{label}</button>)}
  </div>
}
function StorageIcon({trend=false}){
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.1">
    {trend?<><path d="M1.5 2v11.5h13"/><path d="M4 10V7m4 3V4m4 6V2"/></>:<><ellipse cx="8" cy="4" rx="5.5" ry="2.2"/><path d="M2.5 4v8c0 3 11 3 11 0V4M2.5 8c0 3 11 3 11 0"/></>}
  </svg>
}

export function PanelHeader({title,trend=false,children}){
  return <header><h2><StorageIcon trend={trend}/>{title}</h2>{children}</header>
}

function TrendPlot({samples,unit,mode,highlight,caption}){
  const scroller=useRef(null)
  const [point,setPoint]=useState(null)
  useEffect(()=>{
    if(scroller.current)scroller.current.scrollLeft=scroller.current.scrollWidth
  },[unit,mode,samples.length])
  const columns=samples.map(row=>{
    const segments=categories.map(cat=>({...cat,n:row.parts[cat.key]-(mode==='delta'?row.previous[cat.key]:0)}))
    const up=segments.reduce((s,p)=>s+Math.max(0,p.n),0),down=segments.reduce((s,p)=>s+Math.max(0,-p.n),0)
    return {position:row.position,segments,up,down}
  })
  const high=Math.max(0,...columns.map(c=>c.up)),low=Math.max(0,...columns.map(c=>c.down))
  if(!high&&!low)return <p className="lg-space-empty">{mode==='delta'?'No size change since the first measurement.':'No stored bytes at these positions.'}</p>
  const range=high+low,zero=100*low/range
  const ticks=[...(high/range>.3?[high,high/2]:high/range>.14?[high]:[]),0,
    ...(low/range>.3?[-low/2,-low]:low/range>.14?[-low]:[])]
  const column=point&&columns[point.index],part=column?.segments.find(p=>p.key===point.key&&p.n)
  return <><div className="lg-space-chart" role="group" aria-label={'Storage '+mode+' by '+unit} onPointerLeave={()=>setPoint(null)}>
    <div className="lg-space-axis" aria-hidden="true">{ticks.map(n=><span key={n} style={{bottom:(n+low)/range*100+'%'}}>{bytes(n)}</span>)}</div>
    <div className="lg-space-plot">
      <div className="lg-space-guides" aria-hidden="true">{ticks.map(n=><i key={n} className={n===0?'zero':''} style={{bottom:(n+low)/range*100+'%'}}/>)}</div>
      <div className="lg-space-scroll" ref={scroller}><div className="lg-space-columns">
        {columns.map(({position,segments,up,down},i)=>{
          const label=(unit==='chapter'?'Chapters':storySectionLabels.plot)+' · '+position+' · '+bytes(up-down)
          const info=[label,...segments.filter(p=>p.n).map(p=>p.label+' '+bytes(p.n))].join('\n')
          return <div className="lg-space-col" key={i} tabIndex="0" role="img" aria-label={info}>
            {[true,false].map(positive=><div key={String(positive)} className={'lg-space-stack '+(positive?'up':'down')}
              style={positive?{bottom:zero+'%',height:100*up/range+'%'}:{top:100-zero+'%',height:100*down/range+'%'}}>
              {segments.filter(p=>positive?p.n>0:p.n<0).map(p=><i key={p.key} onPointerEnter={()=>setPoint({index:i,key:p.key})} onPointerLeave={()=>setPoint(null)}
                style={{flex:Math.abs(p.n)+' 1 0',background:p.color,opacity:highlight&&highlight!==p.key?0.3:1}}/>)}
            </div>)}
            <small>{position}</small>
          </div>
        })}
      </div></div>
    </div>
  </div><p className="lg-space-caption">{part?<>{column.position} · {part.label} · {bytes(part.n)} · <RollingShare part={Math.abs(part.n)} total={column.up+column.down}/></>:caption}</p></>
}

export function UsageCard({storage}){
  const [unit,setUnit]=useState('chapter'),[mode,setMode]=useState('total'),[view,setView]=useState('bar')
  const [hover,setHover]=useState(null),[focus,setFocus]=useState(null),highlight=hover??focus
  const data=storage.value
  if(!data)return <section className="lg-space-card"><h2>Storage Usage</h2><p role={storage.error?'alert':'status'}>{storage.error||'Measuring book folders…'}</p></section>
  const total=sumParts(data.parts),history=data.history[unit]
  const incomplete=data.unavailable.length>0
  const active=(!incomplete||data.bookCount>0)&&categories.find(c=>c.key===highlight)
  let notice=''
  if(incomplete)notice='Incomplete measurement · '+data.unavailable.join(', ')
  else if(!data.bookCount)notice='No registered books to measure.'
  else if(data.historyStatus==='unavailable')notice='Storage history could not be saved.'
  else if(unit==='plot'&&!data.plotAvailable)notice='Waiting for plot segmentation.'
  else if(history.length===1 && mode==='total')notice='First observed position · refresh as the book grows.'
  return <div className="lg-space" data-meter={view}>
    <section className="lg-space-card" aria-label="Storage Usage">
      <PanelHeader title="Storage Usage">
        <Modes name="Storage View" items={[['bar','Bar'],['field','Field']]} value={view} onChange={setView}/></PanelHeader>
      <div className="lg-space-headline"><strong hidden={!!active}>{incomplete&&!data.bookCount?'—':bytes(total)}</strong>
        <b className="lg-space-share" hidden={!active}><RollingShare part={active?data.parts[active.key]:total} total={total}/></b>
        <small>{active?active.label+' · '+bytes(data.parts[active.key]):incomplete?data.bookCount+' of '+(data.bookCount+data.unavailable.length)+' books measured':'across '+data.bookCount+' book'+(data.bookCount===1?'':'s')}</small></div>
      <div className="lg-space-composition" role="img" aria-label={'Book File Sizes · '+bytes(total)}>
        {view==='bar'?<CompositionBar parts={categories.map(c=>({...c,value:data.parts[c.key]}))} height={12}
          tip={false} hoverKey={highlight} onHoverKey={setHover}/>:<StorageField parts={data.parts}
          total={total} highlight={highlight} onHover={setHover}/>}
      </div>
    </section>
    <section className="lg-space-card" aria-label="Storage Growth">
      <PanelHeader title="Storage Growth" trend><div className="lg-space-controls">
        <Modes name="Narrative Position" items={[['chapter','Chapters'],['plot',storySectionLabels.plot]]} value={unit} onChange={setUnit}/>
        <Modes name="Measurement" items={[['total','Total'],['delta','Delta']]} value={mode} onChange={setMode}/>
      </div></PanelHeader>
      {history.length>0&&<TrendPlot key={unit+mode} samples={history} unit={unit} mode={mode} highlight={highlight} caption={notice}/>}
      {!history.length&&notice&&<p className="lg-space-empty">{notice}</p>}
      {data.historyStatus==='session'&&<small>History is available for this session.</small>}
    </section>
    <div className="lg-space-legend" role="group" aria-label="Shared Storage Legend">
      {categories.map(c=>{
        const n=data.parts[c.key],description=c.label+' · '+bytes(n)+' · '+decimals.format(total?100*n/total:0)+'%'
        return <span key={c.key} aria-label={description} tabIndex="0"
          onFocus={()=>setFocus(c.key)} onBlur={()=>setFocus(null)} onPointerEnter={()=>setHover(c.key)} onPointerLeave={()=>setHover(null)}>
          <i style={{background:c.color}}/>{c.label}<small>{incomplete&&!data.bookCount?'—':bytes(n)}</small></span>
      })}
    </div>
  </div>
}

