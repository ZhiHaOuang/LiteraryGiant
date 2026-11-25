import {fitBubbleWidths,measureBubbleText} from './companion-layout.js'
import {createResizeSettler} from './resize-settle.js'
import React,{useEffect,useRef,useState,useLayoutEffect} from 'react'
import {motion,animate,useMotionValue,useReducedMotion} from 'framer-motion'
import {sparkDays} from './roster-data.js'
import {short} from './team-data.js'
import lord from './assets/display/lord-transparent.png'
import romeo from './assets/display/romeo-transparent.png'
import juliet from './assets/display/juliet-transparent.png'
import frog from './assets/display/frog-transparent.png'
import princess from './assets/display/princess-transparent.png'
import yu from './assets/display/yu-transparent.png'
import lines from './companion-lines.json'
import motionStyles from './companion-motion.css'
import {dialoguePairs,dialogueScenes,createDialogue,planDialogue} from './companion-dialogue.js'

export function AgentSparkline({days,dayKeys,name,preview=false}){
 const ref=useRef(null),[width,setWidth]=useState(112)
 useEffect(()=>{
  const observer=new ResizeObserver(([entry])=>setWidth(entry.contentRect.width))
  observer.observe(ref.current);return()=>observer.disconnect()
 },[])
 const points=sparkDays(days,dayKeys,width),w=Math.max(1,width),step=w/Math.max(1,points.length)
 const tokens=Math.max(1,...points.map(p=>p.tokens)),requests=Math.max(1,...points.map(p=>p.requests))
 const x=i=>(i+.5)*step,y=p=>38-p.requests/requests*30
 const recorded=days!==undefined
 return <span className="lgt-spark" ref={ref} data-preview={preview||undefined}>
  <svg viewBox={`0 0 ${w} 42`} role="img" aria-label={`${name} · ${points.length} days · Tokens / Requests`}>
   <title>Bars: Tokens · Line: Requests · Each scale is normalized independently{!recorded?' · Daily records unavailable':''}</title>
   <path d={`M0 39H${w}`} className="lgt-spark-base"/>
   {points.map((p,i)=><rect key={p.day} x={i*step+2} y={38-p.tokens/tokens*29} width={Math.max(1,step-4)} height={p.tokens/tokens*29} rx="1.5" className="lgt-spark-bar"/>)}
   {points.some(p=>p.requests>0)&&<polyline points={points.map((p,i)=>`${x(i)},${y(p)}`).join(' ')} className="lgt-spark-line"/>}
   {points.map((p,i)=><g key={p.day}>
    {p.requests>0&&<circle cx={x(i)} cy={y(p)} r="1.8" fill="#6B8A6F"/>}
    <rect x={i*step} y="0" width={step} height="42" className="lgt-spark-hit"><title>{`${preview?'Preview · ':''}${p.day}\nTokens: ${!recorded?'—':p.requests>0&&!p.known?'—':short(p.tokens)}\nRequests: ${recorded?p.requests:'—'}${p.requests>p.known?'\nSome requests have no token usage':''}`}</title></rect>
   </g>)}
  </svg>
  <span className="lgt-spark-dates"><span>{points[0]?.day.slice(5)}</span><span>{recorded?`${points.length}d`:'—'}</span><span>{points.at(-1)?.day.slice(5)}</span></span>
 </span>
}

const companions=[{image:princess,name:'公主'},{image:frog,name:'青蛙'},{image:lord,name:'和摸伐'},{image:romeo,name:'罗密欧'},{image:yu,name:'与'},{image:juliet,name:'朱丽叶'}]
const pairs=[...dialoguePairs(lines.active),...dialogueScenes(lines.conversations??[])]
export function Companions({playlist=pairs}){
 const ref=useRef(null),[round,setRound]=useState(null),height=useMotionValue(0),reducedMotion=useReducedMotion()
 const currentRound=useRef(round),refresh=useRef(()=>{})
 useLayoutEffect(()=>{
  const root=ref.current,slot=root.parentElement,row=root.querySelector('.lgt-bubble-row'),avatarsRow=root.querySelector('.lgt-avatar-groups')
  const canvas=document.createElement('canvas').getContext('2d'),textMeasures=new Map()
  let animation,lastTarget=null,lastWidth=null,lastPlan=null,resizing=false
  const settling=createResizeSettler(window,()=>{resizing=false;root.removeAttribute('data-resizing');measure(true)})
  const measure=(optimize=false)=>{
   const round=currentRound.current,plan=round?.plan??planDialogue([]),width=row.clientWidth
   if(width<=0)return
   const changed=lastWidth!==null&&width!==lastWidth
   if(changed){if(!resizing)root.setAttribute('data-resizing','');resizing=true;settling.schedule()}
   const newScene=lastPlan!==round?.plan
   optimize=!resizing&&(optimize||lastWidth===null||newScene)
   lastWidth=width;lastPlan=round?.plan
   const textCap=Math.max(0,slot.clientHeight-avatarsRow.offsetHeight-44)
   const boxes=[...root.querySelectorAll('.lgt-bubble-space')],avatars=[...root.querySelectorAll('.lgt-companion img')]
   const measures=boxes.map(box=>[...box.querySelectorAll('.lgt-bubble-measure')])
   const avatarBounds=avatars.map(el=>el.getBoundingClientRect()),rowLeft=row.getBoundingClientRect().left
   // Cache font metrics across turns. Browser wrapping is measured only at the chosen widths.
   const style=getComputedStyle(measures.flat()[0]??row),font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
   canvas.font=font
   const textMeasure=el=>{const key=font+'\n'+el.textContent;if(!textMeasures.has(key))textMeasures.set(key,measureBubbleText(el.textContent,text=>canvas.measureText(text).width));return textMeasures.get(key)}
   const textWidth=el=>textMeasure(el).width
   root.style.setProperty('--lgt-bubble-text-height',textCap+'px')
   root.toggleAttribute('data-no-room',textCap<14)
   if(resizing){
    row.style.gridTemplateColumns=plan.weights.map(w=>`minmax(0,${w}fr)`).join(' ')
   }else if(optimize){
    const texts=measures.map(items=>Math.max(0,...items.map(textWidth)))
    const anchors=plan.lanes.map((_,side)=>avatarBounds.slice(side*plan.members,(side+1)*plan.members).map(a=>a.left+a.width/2-rowLeft))
    row.style.gridTemplateColumns=fitBubbleWidths(texts,width,anchors,6,(side,w)=>Math.max(1,...measures[side].map(el=>textMeasure(el).linesAt(w)))).map(w=>`minmax(0,${w}fr)`).join(' ')
   }
   // max-width keeps these natural text widths inside their lane during a drag.
   if(resizing||optimize||newScene)for(const el of measures.flat())el.style.width=Math.ceil(textWidth(el)+15)+'px'
   if(optimize){
    // Tighten all final bubbles together. Each binary-search step costs one layout,
    // not one layout per candidate per lane; this never runs during a resize.
    const fitting=measures.flat().map(el=>({el,lo:1,hi:el.offsetWidth,height:el.offsetHeight}))
    while(fitting.some(item=>item.lo<item.hi)){
     for(const item of fitting)if(item.lo<item.hi){item.mid=Math.floor((item.lo+item.hi)/2);item.el.style.width=item.mid+'px'}
     const heights=fitting.map(item=>item.el.offsetHeight)
     fitting.forEach((item,i)=>{if(item.lo<item.hi){if(heights[i]<=item.height)item.hi=item.mid;else item.lo=item.mid+1}})
    }
    for(const item of fitting)item.el.style.width=item.hi+'px'
   }
   const bubbles=[...root.querySelectorAll('.lgt-comic-bubble:not([data-hidden]):not(.lgt-bubble-measure)')]
   for(const bubble of bubbles){
    const side=Number(bubble.parentElement.dataset.lane)
    bubble.style.width=measures[side].find(el=>el.dataset.measureOrder===bubble.dataset.lineOrder).style.width
   }
   // Read in one batch after applying sizes; never alternate writes/reads per candidate.
   const bounds=boxes.map(box=>box.getBoundingClientRect())
   const heights=measures.flat().map(el=>el.offsetHeight)
   const positions=bubbles.map(bubble=>{
    const side=Number(bubble.parentElement.dataset.lane),box=bounds[side],bubbleWidth=bubble.offsetWidth
    const text=bubble.querySelector('.lgt-bubble-text'),clipped=text.scrollHeight>text.clientHeight+1
    const candidates=avatarBounds.slice(side*plan.members,(side+1)*plan.members).map((a,i)=>({index:side*plan.members+i,x:a.left+a.width/2-box.left}))
    const target=candidates.filter(a=>a.x>=4&&a.x<=box.width-4).sort((a,b)=>Math.abs(a.x-box.width/2)-Math.abs(b.x-box.width/2))[0]??candidates[0]
    const left=Math.max(0,Math.min(box.width-bubbleWidth,target.x-bubbleWidth/2))
    return {bubble,text,clipped,index:target.index,left,tail:target.x-left-bubbleWidth/2}
   })
   for(const {bubble,text,clipped,index,left,tail} of positions){
    text.toggleAttribute('data-clipped',clipped);bubble.dataset.avatarIndex=String(index)
    bubble.style.left=left+'px';bubble.style.setProperty('--lgt-tail-offset',tail+'px')
   }
   const next=round&&round.phase!=='rest'&&textCap>=14?Math.min(textCap+10,Math.max(0,...heights)):0
   if(next===lastTarget&&!resizing)return
   lastTarget=next;animation?.stop()
   if(resizing||reducedMotion||document.body.dataset.dshClaudeMotion==='reduced')height.set(next)
   else animation=animate(height,next,{type:'spring',stiffness:420,damping:28,mass:.7})
  }
  refresh.current=()=>measure();measure()
  const observer=new ResizeObserver(()=>measure());observer.observe(slot)
  return()=>{
   refresh.current=()=>{};settling.dispose();animation?.stop();observer.disconnect();root.removeAttribute('data-resizing')
  }
 },[reducedMotion,height])
 useLayoutEffect(()=>{currentRound.current=round;refresh.current()},[round])
 useEffect(()=>{
  let visible=false
  const reduced=matchMedia('(prefers-reduced-motion: reduce)')
  const controller=createDialogue({pairs:playlist,onChange:setRound,width:()=>ref.current?.clientWidth??440,exitMs:()=>{
   const value=getComputedStyle(ref.current).getPropertyValue('--dsh-claude-duration-enter').trim(),n=parseFloat(value)
   return Number.isFinite(n)?n*(value.endsWith('ms')?1:1000):400
  }})
  const update=()=>controller.setEnabled(visible&&!document.hidden&&!reduced.matches&&document.body.dataset.dshClaudeMotion!=='reduced')
  const observer=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;update()});observer.observe(ref.current)
  const prefs=new MutationObserver(update);prefs.observe(document.body,{attributes:true,attributeFilter:['data-dsh-claude-motion']})
  reduced.addEventListener('change',update);document.addEventListener('visibilitychange',update)
  return()=>{controller.dispose();observer.disconnect();prefs.disconnect();reduced.removeEventListener('change',update);document.removeEventListener('visibilitychange',update)}
 },[playlist])
 const plan=round?.plan??planDialogue([])
 return <div className="lgt-companion-slot"><div className="lgt-companions" ref={ref} data-lanes={plan.count} data-phase={round?.phase??'idle'} data-round={round?.id} aria-label="书桌搭档对话"><style>{motionStyles}</style>
  <div className="lgt-bubble-row" style={{gridTemplateColumns:plan.weights.map(w=>`minmax(0,${w}fr)`).join(' ')}}>
  {plan.lanes.map((planned,side)=>{
   const line=round?.visible?.[side],order=line?.order??0,speaker=line?.member??0,shown=line&&round.phase!=='rest'
   return <motion.div className="lgt-bubble-space" key={side} data-lane={side} style={{height}} aria-hidden="true">
     {planned.map(item=><div className="lgt-comic-bubble lgt-bubble-measure" key={item.order} data-measure-order={item.order}><span className="lgt-bubble-text">{item.text}</span></div>)}
     {line&&<div className="lgt-comic-bubble" data-order={order%3} data-line-order={order} data-avatar-index={side*plan.members+speaker} data-hidden={!shown||undefined} data-leaving={round.phase==='leaving'||undefined} key={`${round.id}-${line.order}-${round.phase==='leaving'}`} title={line.text}><span className="lgt-bubble-text">{line.text}</span></div>}
    </motion.div>
  })}
  </div>
  <div className="lgt-avatar-groups">{[companions.slice(0,3),companions.slice(3)].map((members,side)=><div className="lgt-companion-pair" key={side} data-group={side} aria-label={members.map(c=>c.name).join('、')}><div className="lgt-companion-row">{members.map(c=><div className="lgt-companion" key={c.name}><img src={c.image} alt="" draggable={false}/><span>{c.name}</span></div>)}</div></div>)}</div>
 </div></div>
}
