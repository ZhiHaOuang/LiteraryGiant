import React,{useEffect,useId,useLayoutEffect,useRef} from 'react'
import {Icon} from './icons.jsx'
import {number} from './charts.jsx'
import {storySections} from './story-sections-data.js'
import {createCardSpring} from './story-card-motion.js'

export function StoryModuleDeck({section,onSection,stats,loaded,children}){
 const root=useRef(null),motion=useRef(null),pendingFocus=useRef(''),prefix=useId()
 useEffect(()=>{
  const el=root.current,doc=el.ownerDocument,win=doc.defaultView
  const media=win.matchMedia('(prefers-reduced-motion: reduce)')
  let hovered='',focused=''
  const cards=()=>[...el.children],idFor=target=>{
   const trigger=target?.closest?.('.lgd-module-trigger')
   return trigger&&el.contains(trigger)&&trigger.getAttribute('aria-expanded')==='false'?trigger.dataset.section:''
  }
  const reduced=()=>media.matches||doc.body.dataset.dshClaudeMotion==='reduced'||doc.hidden
  const engine=createCardSpring({
   read:()=>cards().filter(card=>card.dataset.expanded==='false').map(card=>card.dataset.section),
   write:(id,value)=>{const card=cards().find(card=>card.dataset.section===id);if(card)card.style.flexGrow=String(value)},
   requestFrame:callback=>win.requestAnimationFrame(callback),cancelFrame:id=>win.cancelAnimationFrame(id),reduced,
  })
  motion.current=engine
  const sync=()=>{el.dataset.reducedMotion=String(reduced());engine.set(hovered||focused)}
  const over=e=>{if(e.pointerType==='touch')return;hovered=idFor(e.target);sync()}
  const out=e=>{if(el.contains(e.relatedTarget))return;hovered='';sync()}
  const focus=e=>{focused=e.target.matches(':focus-visible')?idFor(e.target):'';sync()}
  const blur=e=>{focused=idFor(e.relatedTarget);sync()}
  const cancel=()=>{hovered=focused='';sync()}
  const visibility=()=>{if(doc.hidden)hovered=focused='';sync()}
  const listeners=[['pointerover',over],['pointerout',out],['focusin',focus],['focusout',blur],['pointercancel',cancel]]
  listeners.forEach(([event,handler])=>el.addEventListener(event,handler))
  media.addEventListener('change',sync);doc.addEventListener('visibilitychange',visibility)
  const observer=new win.MutationObserver(sync)
  observer.observe(doc.body,{attributes:true,attributeFilter:['data-dsh-claude-motion']})
  sync()
  return()=>{engine.destroy();motion.current=null;observer.disconnect();media.removeEventListener('change',sync);doc.removeEventListener('visibilitychange',visibility);listeners.forEach(([event,handler])=>el.removeEventListener(event,handler))}
 },[])
 useLayoutEffect(()=>{
  motion.current?.reset()
  if(!pendingFocus.current)return
  const button=[...root.current.querySelectorAll('.lgd-module-trigger')].find(el=>el.dataset.section===pendingFocus.current)
  pendingFocus.current='';button?.focus({preventScroll:true})
  const bounds=button?.getBoundingClientRect(),viewport=root.current.closest('.lgd-canvas')?.getBoundingClientRect()
  if(bounds&&viewport&&(bounds.top<viewport.top||bounds.bottom>viewport.bottom))button.scrollIntoView({block:'nearest'})
 },[section])
 const items=section?[...storySections.filter(item=>item.id!==section),...storySections.filter(item=>item.id===section)]:storySections
 return <div ref={root} className="lgd-story-modules" data-open={Boolean(section)}>
  {items.map(item=>{
   const expanded=section===item.id,control=`${prefix}-${item.id}`,panel=control+'-content'
   return <section key={item.id} data-section={item.id} data-expanded={expanded} className={'lgd-card lgd-story-module'+(expanded?' lgd-module-expanded':'')}>
    <div className="lgd-module-summary">
     <button type="button" id={control} data-section={item.id} className="lgd-module-trigger" aria-labelledby={control+'-title'} aria-expanded={expanded} aria-controls={expanded?panel:undefined} onClick={()=>{pendingFocus.current=item.id;onSection(expanded?'':item.id)}}/>
     <h2 className="lgd-module-title"><Icon name={item.icon}/><span id={control+'-title'}>{item.title}</span><span className="lgd-module-chevron" aria-hidden="true">{expanded?'⌃':'⌄'}</span></h2>
     <span className="lgd-module-description">{item.description}</span>
     <span className="lgd-module-stats">{stats[item.id].map(([label,count])=><span key={label}><span className="lgd-module-stat-label">{label}</span><strong>{loaded?number(count):'—'}</strong></span>)}</span>
     <span className="lgd-module-topics">{item.topics.map(title=><span key={title}>{title}</span>)}</span>
    </div>
    {expanded&&<div id={panel} role="region" aria-labelledby={control+'-title'} className="lgd-story-data lgd-story-detail">{children}</div>}
   </section>
  })}
 </div>
}
