import React, {type CSSProperties, useEffect, useMemo, useRef, useState} from 'react';
import {animate, motion, useMotionValue, useReducedMotion} from 'framer-motion';
import {agentStacks,INPUT_HEIGHT,OUTPUT_HEIGHT,BASE_LIFT} from './agent-stacks.js';
import {short,percent,seconds,roleColors} from '../team-data.js';
import {timelineCapacity,timeTooltip,timelinePairs,coarsenTimeline} from './time-stacks.js';
import {createResizeSettler} from '../resize-settle.js';
// Bencho Stacked bars, copyright (c) 2026 Lorenzo Cabra, MIT. See ../../LICENSE-bencho.
// The supplied demo, including its original explanatory comments, is retained in StackedBarsDemo.tsx.

/* ══ Stacked bars ═════════════════════════════════════════
   LG: each time bucket has two stacks sharing one fine baseline.
   Input grows upward; Output grows downward. Both use recorded
   time-bucket totals; only their composition is estimated.

   ── RUN ALONG IT ────────────────────────────────────────
   The column under the pointer gets a ring round its whole stack,
   the rest step back (their colour mixed toward the slab, never
   faded), and one tooltip glides beside it on a spring with the
   date, the total and what made it up.
   LG: the tooltip identifies time + side for the selected Agent(s).

   ── RANGE / BOOK ────────────────────────────────────────
   Every segment eases to its new height and offset a beat after
   its left neighbour. The same transition grows the bars out of
   the baseline the first time the card is seen. */
const SPRING={type:'spring' as const,stiffness:380,damping:34};
const TOTAL_HEIGHT=INPUT_HEIGHT+1+OUTPUT_HEIGHT;
type Part={key:string;label:string;color:string;value:number};
type Side={value:number|null;parts:Part[]};
type Pair={role:string;input:Side;output:Side;missing:number;from:number;to:number;label:string};
const full=(value:number|null)=>value===null?'Unavailable':new Intl.NumberFormat('en',{maximumFractionDigits:1}).format(value);

export function StackedBars({timeline:sourceTimeline,groupRole='all',title='Summarizer',onCapacity,showScale=false,mode='tokens'}:{timeline:any;groupRole?:string;title?:string;onCapacity?:(n:number)=>void;showScale?:boolean;mode?:string}){
 const paired=mode==='tokens',metricLabel=({context:'Context',requests:'Requests',time:'Duration'} as Record<string,string>)[mode]??'Input',unit=mode==='time'?'':mode==='requests'?'Requests':'Tokens'
 const metricValue=(value:number|null)=>mode==='time'?seconds(value):full(value)
 const heading=useRef<HTMLSpanElement|null>(null);
 const root=useRef<HTMLDivElement|null>(null),plot=useRef<HTMLDivElement|null>(null);
 const [tipWidth,setTipWidth]=useState(250),[width,setWidth]=useState(300),[seen,setSeen]=useState(false),[at,setAt]=useState<string|null>(null),[pinned,setPinned]=useState<string|null>(null);
 const selected=pinned?.split(':')[0];
 const capacity=timelineCapacity(width);
 const capacityUpdate=useRef<ReturnType<typeof createResizeSettler>|null>(null);
 // Resize locally with existing buckets; request a new resolution once the width settles.
 useEffect(()=>{
  if(!onCapacity)return;
  const update=createResizeSettler(window,onCapacity);capacityUpdate.current=update;
  return()=>{update.dispose();capacityUpdate.current=null};
 },[onCapacity]);
 useEffect(()=>{capacityUpdate.current?.schedule(capacity)},[capacity,onCapacity]);
 const timeline=useMemo(()=>coarsenTimeline(sourceTimeline,capacity),[sourceTimeline,capacity]);
 const pairs=useMemo(()=>timelinePairs(timeline,groupRole,mode),[timeline,groupRole,mode]);
 useEffect(()=>{setPinned(null);setAt(null)},[timeline?.from,timeline?.to]);
 const osReduced=useReducedMotion(),[themeReduced,setThemeReduced]=useState(false),reduced=osReduced||themeReduced;
 useEffect(()=>{
  const el=plot.current;if(!el)return;
  const measure=()=>{const label=heading.current;if(label)label.toggleAttribute('data-clipped',label.scrollWidth>label.clientWidth+1);setWidth(Math.max(1,el.clientWidth));setTipWidth(Math.min(250,(el.closest('.lgt-time-groups')??el).clientWidth));};measure();
  const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  const update=()=>setThemeReduced(document.body.dataset.dshClaudeMotion==='reduced');update();
  const observer=new MutationObserver(update);observer.observe(document.body,{attributes:true,attributeFilter:['data-dsh-claude-motion']});
  return()=>observer.disconnect();
 },[]);
 /* grow in once, the first time the card is on screen */
 useEffect(()=>{
  const el=root.current;if(!el||seen)return;
  if(typeof IntersectionObserver==='undefined'){setSeen(true);return;}
  const observer=new IntersectionObserver(([entry])=>{if(entry.isIntersecting){setSeen(true);observer.disconnect();}},{threshold:.3});
  observer.observe(el);return()=>observer.disconnect();
 },[seen]);
 const {columns,maxima,cell,barWidth}=useMemo(()=>agentStacks(pairs,width,paired),[pairs,width,paired]);
 const cur=columns.find(c=>c.id===at),r=Math.min(2.5,barWidth/2);
 const ringX=useMotionValue(0),ringY=useMotionValue(0),ringH=useMotionValue(0),tipX=useMotionValue(0);
 const was=useRef<string|null>(null);
 /* ring and tooltip: placed at once when they appear, glide after */
 useEffect(()=>{
  if(!cur){was.current=null;ringX.set(0);ringY.set(0);ringH.set(0);tipX.set(0);return;}
  const h=seen?cur.height:0;
  const y=cur.side==='input'?INPUT_HEIGHT-BASE_LIFT-h:INPUT_HEIGHT+1+BASE_LIFT;
  /* beside the column: right while it fits there, else left */
  const right=cur.left+barWidth+8;
  // Small groups share the card's tooltip bounds so full details remain readable.
  const plotBounds=plot.current!.getBoundingClientRect(),hostBounds=(plot.current!.closest('.lgt-time-groups')??plot.current!).getBoundingClientRect();
  const minX=hostBounds.left-plotBounds.left,maxX=hostBounds.right-plotBounds.left-tipWidth;
  const tx=Math.max(minX,Math.min(maxX,right<=maxX?right:cur.left-8-tipWidth));
  const controls:ReturnType<typeof animate>[]=[];
  const go=(mv:typeof ringX,value:number)=>{if(was.current===null||reduced)mv.set(value);else controls.push(animate(mv,value,SPRING));};
  go(ringX,cur.left-3);go(ringY,y-3);go(ringH,Math.max(6,h+6));go(tipX,tx);was.current=cur.id;
  return()=>controls.forEach(control=>control.stop());
 },[cur,seen,barWidth,width,tipWidth,reduced]);
 const choose=(id:string)=>setPinned(current=>current===id?null:id);
 const pick=(event:React.PointerEvent<HTMLDivElement>)=>{
  const bounds=event.currentTarget.getBoundingClientRect();if(!pairs.length||!bounds.width)return;
  const index=Math.max(0,Math.min(pairs.length-1,Math.floor((event.clientX-bounds.left)/cell)));
  setAt(pairs[index].role+':'+(!paired||event.clientY-bounds.top<=INPUT_HEIGHT?'input':'output'));
 };
 return <div ref={root} className="lgd-stacked-bars stb stb-agent stb-group" data-group={groupRole} data-mode={mode} data-scale={showScale||undefined} data-period={timeline?.period} data-reduced={reduced||undefined} data-scrub={cur?'':undefined}
  style={{'--stb-heading':roleColors[groupRole]??'var(--lgd-accent,#d97757)','--stb-r':r+'px','--stb-rr':r+3+'px'} as CSSProperties}>
  <div className="lgt-bars-head" title={paired?'Input above / Output below. Independent scales; composition estimated.':metricLabel+' by time bucket'}><span title={title}><span ref={heading} className="lgt-heading-text">{title}</span></span></div>
  <div className="stb-agent-chart">
   {showScale&&<div className="stb-agent-side stb-agent-input"><span>{mode==='time'?'Time':mode==='requests'?'Calls':metricLabel}</span><small>{mode==='time'?seconds(maxima.input):short(maxima.input)}</small></div>}
   {showScale&&paired&&<div className="stb-agent-side stb-agent-output"><span>Output</span><small>{short(maxima.output)}</small></div>}
   <div ref={plot} className="stb-plot" role="group" aria-label={paired?`${title}: Input above, Output below. Independent scales.`:`${title}: ${metricLabel} over time.`}
    style={{height:paired?TOTAL_HEIGHT:INPUT_HEIGHT+8}} onPointerMove={pick} onPointerLeave={()=>setAt(null)} onPointerCancel={()=>setAt(null)}>
    <span className="stb-base" style={{top:INPUT_HEIGHT}}/>
    {columns.map((column,index)=>{
     const top=column.side==='input'?0:INPUT_HEIGHT+1,half=column.side==='input'?INPUT_HEIGHT:OUTPUT_HEIGHT;
     return <div key={column.id} className="stb-col stb-agent-col" data-on={cur?.id===column.id||undefined} data-selected={selected===column.role||undefined}
      data-bucket={column.role} data-side={column.side} data-total={column.value??'unknown'}
      style={{left:column.left,width:column.width,'--i':Math.floor(index/2),top,height:half,bottom:'auto'} as CSSProperties}>
      {column.parts.map(part=><span key={part.key} className="stb-bar" data-part={part.key} data-value={part.value}
       style={{'--c':part.color,height:seen?part.height:0,...column.side==='input'?{bottom:BASE_LIFT+(seen?part.offset:0)}:{top:BASE_LIFT+(seen?part.offset:0)}} as CSSProperties}/>)}
      {!column.parts.length&&column.value===null&&<span className="stb-zero" style={column.side==='input'?{bottom:BASE_LIFT}:{top:BASE_LIFT}}>{column.value===null?'—':'0'}</span>}
      <span className="stb-selection" style={{height:Math.max(6,column.height+6),...column.side==='input'?{bottom:0}:{top:0}}}/>
      <button type="button" className="stb-hit" aria-pressed={selected===column.role} aria-label={`${timeTooltip(Number(column.role))} ${paired?(column.side==='input'?'Input':'Output'):metricLabel}: ${metricValue(column.value)} ${unit}`}
       onFocus={()=>setAt(column.id)} onBlur={()=>setAt(null)} onClick={()=>choose(column.id)}
       onKeyDown={event=>{if(event.key==='Escape'){setAt(null);setPinned(null);return;}const step=event.key==='ArrowRight'?(paired?2:1):event.key==='ArrowLeft'?-(paired?2:1):event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0;if(step){event.preventDefault();root.current?.querySelectorAll<HTMLButtonElement>('.stb-hit')[Math.max(0,Math.min(columns.length-1,index+step))]?.focus();}}}/>
     </div>;
    })}
    <motion.span className="stb-ring" aria-hidden style={{x:ringX,y:ringY,height:ringH,width:barWidth+6}}/>
    <motion.div className="stb-tip" style={{x:tipX,width:tipWidth}} aria-hidden={!cur}>
     {cur&&<><div className="stb-tip-head"><span>{title} · {paired?(cur.side==='input'?'Input':'Output'):metricLabel}</span><b>{metricValue(cur.value)}</b></div>
      <div className="stb-tip-range">{timeTooltip(Number(cur.role))} – {timeTooltip((pairs.find(p=>p.role===cur.role)?.to??Number(cur.role))-1)}</div>
      {cur.parts.map(part=><div className="stb-tip-row" key={part.key}><i style={{'--c':part.color} as CSSProperties}/><span>{part.label}</span><b>{part.key==='unknown'||mode==='time'||mode==='requests'?'':'≈'}{percent(part.value,cur.value)}</b></div>)}
      {cur.value===null?<div className="stb-tip-note">Token usage unavailable</div>:cur.value===0?<div className="stb-tip-note">No usage</div>:<div className="stb-tip-note">{paired?`Tokens · ${cur.side==='input'?'includes cache':'output'} · composition estimated`:mode==='context'?'Estimated context tokens':mode==='time'?'Request time · excludes tool execution':'Requests'}</div>}
      {cur.missing>0&&<div className="stb-tip-note">{cur.missing} requests missing usage</div>}
     </>}
    </motion.div>
   </div>
  </div>
 </div>;
}
