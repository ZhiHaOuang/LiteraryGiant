import React, {useEffect,useLayoutEffect,useRef,useState} from 'react'
import {motion,animate,useMotionValue,useReducedMotion} from 'framer-motion'
import type { ReactElement } from 'react'
import { formatCost, type CostCurrency } from '../../dsh-context/src/client/cost'
import { type DayTotals } from '../../dsh-context/src/client/overview'
import { shiftDayKey } from '../../dsh-context/src/shared/days'
import type { ViewKit } from '../../dsh-context/src/client/viewkit'
import { IconData } from '../../dsh-context/src/client/primitives'

export interface OverviewUsageProps {
  days: Record<string, DayTotals>
  currency: CostCurrency
  window?: string[]
  today: string
}

export function usageWindowOf(today: string): string[] {
  const columns: string[] = []
  for (let d = -6; d <= 0; d++) {
    const key = shiftDayKey(today, d)
    if (key === null) return []
    columns.push(key)
  }
  return columns
}

const TICKS: readonly number[] = [0, 25, 50, 75, 100]

export function makeOverviewUsage(kit: ViewKit): (props: OverviewUsageProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewUsage(props: OverviewUsageProps): ReactElement {
    const root=useRef<HTMLDivElement|null>(null),plot=useRef<HTMLDivElement|null>(null)
    const [seen,setSeen]=useState(false),[at,setAt]=useState<number|null>(null),[size,setSize]=useState({width:300,height:80})
    const reduced=useReducedMotion(),ringX=useMotionValue(0),ringY=useMotionValue(0),ringH=useMotionValue(0),tipX=useMotionValue(0),was=useRef<number|null>(null)
    const window = props.window ?? usageWindowOf(props.today)
    const byKey: Record<string, DayTotals | undefined> = props.days
    const columns = window.map(key => ({ key, entry: byKey[key] }))
    const empty = columns.every(c => c.entry === undefined || (c.entry.tokens <= 0 && c.entry.cost === null))
    useEffect(()=>{const el=root.current;if(!el||seen||empty)return;const io=new IntersectionObserver(([e])=>{if(e.isIntersecting){setSeen(true);io.disconnect()}},{threshold:.3});io.observe(el);return()=>io.disconnect()},[seen,empty])
    let maxTokens = 0
    let maxCost = 0
    for (const c of columns) {
      if (c.entry === undefined) continue
      if (c.entry.tokens > maxTokens) maxTokens = c.entry.tokens
      if (c.entry.cost !== null && c.entry.cost > maxCost) maxCost = c.entry.cost
    }
    const heightOf = (value: number, max: number): string => (max <= 0 || value <= 0 ? '0%' : `${Math.max(4, Math.round((value / max) * 100))}%`)
    const tickOf = (percent: number): string => fmt(Math.round((maxTokens * percent) / 100))
    const costTickOf = (percent: number): string => {
      if (maxCost <= 0) return '—'
      return percent === 0 ? '0' : formatCost((maxCost * percent) / 100, props.currency)
    }
    useLayoutEffect(()=>{const el=plot.current;if(!el)return;const measure=()=>{const width=el.clientWidth,height=el.clientHeight;setSize(current=>current.width===width&&current.height===height?current:{width,height})};measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect()},[empty,window.length])
    const tipWidth=Math.min(180,size.width),columnWidth=(size.width-6*(columns.length-1))/Math.max(1,columns.length)
    useEffect(()=>{
      if(at===null||!columns[at]){was.current=null;ringX.set(0);ringY.set(0);ringH.set(0);tipX.set(0);return}
      const entry=columns[at].entry,tokens=entry?.tokens??0,cost=entry?.cost??null
      const top=Math.max(parseFloat(heightOf(tokens,maxTokens)),parseFloat(cost===null?'0':heightOf(cost,maxCost)))*size.height/100
      const left=at*(columnWidth+6)+(columnWidth-23)/2,right=left+31
      const tx=Math.max(0,Math.min(size.width-tipWidth,right+tipWidth<=size.width?right:left-8-tipWidth))
      const controls:ReturnType<typeof animate>[]=[]
      const go=(mv:typeof ringX,value:number)=>{if(was.current===null||reduced||document.body.dataset.dshClaudeMotion==='reduced')mv.set(value);else controls.push(animate(mv,value,{type:'spring',stiffness:380,damping:34}))}
      go(ringX,left-3);go(ringY,size.height-top-3);go(ringH,top+6);go(tipX,tx);was.current=at
      return()=>controls.forEach(control=>control.stop())
    },[at,size.width,size.height,columnWidth,tipWidth,props.days,reduced])
    return (
      <div ref={root} className="lgd-card lgg-usage" data-reduced={reduced||undefined}>
        <div className="lgd-section-head">
          <span className="lgg-usage-title">
            <IconData size={14} />
            {t('ov.usage.title')}
          </span>
        </div>
        {empty || window.length === 0
          ? <div className="lgg-empty">{t('ov.usage.empty')}</div>
          : (
            <>
              <div className="lgg-usage-plot" role="group" aria-label={t('ov.usage.title')}>
                <div className="lgg-usage-rail lgg-usage-rail-l" aria-hidden="true">
                  {TICKS.map(p => <span key={p} className="lgg-usage-tick" style={{ top: `${100 - p}%` }}>{tickOf(p)}</span>)}
                </div>
                <div className="lgg-usage-grid">
                  <div ref={plot} className="lgg-usage-cols" data-scrub={at!==null?"":undefined} onPointerLeave={()=>setAt(null)}>
                    {TICKS.map(p => (
                      <span
                        key={p}
                        className={'lgg-usage-line' + (p === 0 ? ' lgg-usage-line-0' : '')}
                        style={{ bottom: `${p}%` }}
                        aria-hidden="true"
                      />
                    ))}
                    {columns.map((c,index) => {
                      const tokens = c.entry?.tokens ?? 0
                      const cost = c.entry?.cost ?? null
                      const label = `${c.key}\n${t('ov.usage.tokens')} ${fmt(tokens)}\n${t('ov.usage.costTip')} ${cost === null ? '—' : formatCost(cost, props.currency)}`
                      return (
                        <div key={c.key} className="lgg-usage-col" tabIndex={0} role="group" aria-label={label} data-on={at===index||undefined} style={{'--i':index} as React.CSSProperties} onPointerEnter={()=>setAt(index)} onFocus={()=>setAt(index)} onBlur={()=>setAt(null)} onKeyDown={e=>{if(e.key==='Escape')setAt(null)}}>
                          <div className="lgg-usage-bars">
                            <span
                              className="lgg-usage-bar lgg-usage-tokens"
                              style={{ height: seen?heightOf(tokens, maxTokens):0 }} data-value={tokens}
                            >
                              {tokens > 0 && <span className="lgg-usage-value">{fmt(tokens)}</span>}
                            </span>
                            <span
                              className="lgg-usage-bar lgg-usage-cost"
                              style={{ height: !seen||cost === null ? '0%' : heightOf(cost, maxCost) }} data-value={cost??'unknown'}
                            />
                          </div>
                        </div>
                      )
                    })}
                    <motion.span className="lgg-usage-ring" aria-hidden style={{x:ringX,y:ringY,height:ringH,width:29}}/>
                    <motion.div className="lgg-usage-tip" style={{x:tipX,width:tipWidth}} aria-hidden={at===null}>{at!==null&&columns[at]&&<><b>{columns[at].key}</b><span>Tokens <strong>{fmt(columns[at].entry?.tokens??0)}</strong></span><span>Cost <strong>{columns[at].entry?.cost==null?'—':formatCost(columns[at].entry!.cost!,props.currency)}</strong></span></>}</motion.div>
                  </div>
                </div>
                <div className="lgg-usage-rail lgg-usage-rail-r" aria-hidden="true">
                  {TICKS.map(p => <span key={p} className="lgg-usage-tick" style={{ top: `${100 - p}%` }}>{costTickOf(p)}</span>)}
                </div>
                <div className="lgg-usage-days" aria-hidden="true">
                  {columns.map(c => <span key={c.key} className="lgg-usage-day">{window.indexOf(c.key)%Math.ceil(window.length/7)===0?c.key.slice(5):''}</span>)}
                </div>
              </div>
            </>
          )}
        <div className="lgg-usage-key" aria-hidden="true">
          <span className="lgg-usage-swatch lgg-usage-tokens" />
          <span className="lgg-usage-key-label">{t('ov.usage.tokens')}</span>
          <span className="lgg-usage-swatch lgg-usage-cost" />
          <span className="lgg-usage-key-label">{t('ov.usage.cost')}</span>
        </div>
      </div>
    )
  }
}
