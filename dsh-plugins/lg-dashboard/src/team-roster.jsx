import {fitBubbleWidths} from './companion-layout.js'
import React,{useEffect,useRef,useState,useLayoutEffect} from 'react'
import {motion,animate,useMotionValue,useReducedMotion} from 'framer-motion'
import {sparkDays} from './roster-data.js'
import {short} from './team-data.js'
import lord from './assets/lord-transparent.png'
import romeo from './assets/romeo-transparent.png'
import juliet from './assets/juliet-transparent.png'
import frog from './assets/frog-transparent.png'
import princess from './assets/princess-transparent.png'
import yu from './assets/yu-transparent.png'
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
 useLayoutEffect(()=>{
  const root=ref.current,slot=root.parentElement,row=root.querySelector('.lgt-bubble-row'),avatarsRow=root.querySelector('.lgt-avatar-groups');let animation,lastTarget=null,lastWidth=-1
  const measure=()=>{
   // Keep the avatar row anchored; bubbles can only use the space above it.
   const textCap=Math.max(0,slot.clientHeight-avatarsRow.offsetHeight-44) // 18 frame + 8 gap + 10 bubble + 8 top clearance
   root.style.setProperty('--lgt-bubble-text-height',textCap+'px')
   root.toggleAttribute('data-no-room',textCap<14)
   const boxes=[...root.querySelectorAll('.lgt-bubble-space')],avatars=[...root.querySelectorAll('.lgt-companion img')]
   const measures=boxes.map(box=>[...box.querySelectorAll('.lgt-bubble-measure')])
   if(row.clientWidth!==lastWidth){
    lastWidth=row.clientWidth
    const canvas=document.createElement('canvas').getContext('2d'),style=getComputedStyle(measures.flat()[0]??row)
    canvas.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const left=row.getBoundingClientRect().left,plan=round?.plan??planDialogue([])
    const texts=measures.map(items=>Math.max(0,...items.map(el=>canvas.measureText(el.textContent).width)))
    const anchors=plan.lanes.map((_,side)=>avatars.slice(side*plan.members,(side+1)*plan.members).map(el=>{const a=el.getBoundingClientRect();return a.left+a.width/2-left}))
    // Measure browser line breaks too: CJK punctuation can wrap earlier than canvas predicts.
    const widths=fitBubbleWidths(texts,row.clientWidth,anchors,10,(i,w)=>Math.max(1,...measures[i].map(el=>{
     el.style.width=w+'px';el.style.maxWidth='none'
     return Math.round((el.offsetHeight-10)/parseFloat(getComputedStyle(el).lineHeight))
    })))
    measures.flat().forEach(el=>{el.style.width='';el.style.maxWidth=''})
    row.style.gridTemplateColumns=widths.map(w=>w+'px').join(' ')
    // A lane reserves space; its bubble only needs the narrowest width that keeps its line count.
    measures.forEach((items,i)=>items.forEach(el=>{
     el.style.width=widths[i]+'px'
     const height=el.offsetHeight;let lo=14,hi=Math.ceil(widths[i])
     while(lo<hi){const mid=Math.floor((lo+hi)/2);el.style.width=mid+'px';if(el.offsetHeight<=height)hi=mid;else lo=mid+1}
     el.style.width=hi+'px'
    }))
   }
   for(const bubble of root.querySelectorAll('.lgt-comic-bubble:not([data-hidden]):not(.lgt-bubble-measure)')){
    const box=bubble.parentElement,bounds=box.getBoundingClientRect(),plan=round.plan,side=Number(box.dataset.lane)
    const measured=measures[side].find(el=>el.dataset.measureOrder===bubble.dataset.lineOrder)
    if(measured)bubble.style.width=measured.style.width
    const text=bubble.querySelector('.lgt-bubble-text');text.toggleAttribute('data-clipped',text.scrollHeight>text.clientHeight+1)
    const candidates=avatars.slice(side*plan.members,(side+1)*plan.members).map((el,i)=>({index:side*plan.members+i,x:el.getBoundingClientRect().left+el.clientWidth/2-bounds.left}))
    const target=candidates.filter(a=>a.x>=4&&a.x<=box.clientWidth-4).sort((a,b)=>Math.abs(a.x-box.clientWidth/2)-Math.abs(b.x-box.clientWidth/2))[0]??candidates[0]
    bubble.dataset.avatarIndex=String(target.index)
    const center=target.x
    const left=Math.max(0,Math.min(box.clientWidth-bubble.offsetWidth,center-bubble.offsetWidth/2))
    bubble.style.left=left+'px';bubble.style.setProperty('--lgt-tail-offset',(center-left-bubble.offsetWidth/2)+'px')
   }
   const next=round&&round.phase!=='rest'&&textCap>=14?Math.min(textCap+10,Math.max(0,...measures.flat().map(el=>el.offsetHeight))):0
   if(next===lastTarget)return
   lastTarget=next;animation?.stop()
   if(reducedMotion||document.body.dataset.dshClaudeMotion==='reduced')height.set(next)
   else animation=animate(height,next,{type:'spring',stiffness:420,damping:28,mass:.7})
  }
  measure();const observer=new ResizeObserver(measure);observer.observe(root);observer.observe(slot);observer.observe(avatarsRow)
  return()=>{animation?.stop();observer.disconnect()}
 },[round?.id,round?.phase,round?.turn,reducedMotion])
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
