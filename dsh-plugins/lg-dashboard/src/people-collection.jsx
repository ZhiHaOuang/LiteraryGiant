import React,{useEffect,useId,useRef,useState} from 'react'
import {motion,useReducedMotion} from 'framer-motion'
import {Icon} from './icons.jsx'
import {characterRoleView} from './story-fields.js'
import {personAreas} from './story-sections-data.js'
import css from './people-collection.css'

const views=['list','card','pack']

// Reuse the same keyed cards for all three layouts; Motion continues interrupted moves.
export function PeopleCollection({records,pageCapacity=records.length,view='card',onView,onPerson}){
 const prefix=useId(),tabs=useRef(null),osReduced=useReducedMotion()
 const [themeReduced,setThemeReduced]=useState(false),[selected,setSelected]=useState('')
 const reduced=osReduced||themeReduced,pack=view==='pack'
 const at=Math.max(0,records.findIndex(r=>r.id===selected)),person=records[at]
 useEffect(()=>{
  const update=()=>setThemeReduced(document.hidden||document.body.dataset.dshClaudeMotion==='reduced')
  update();const observer=new MutationObserver(update)
  observer.observe(document.body,{attributes:true,attributeFilter:['data-dsh-claude-motion']})
  document.addEventListener('visibilitychange',update)
  return()=>{observer.disconnect();document.removeEventListener('visibilitychange',update)}
 },[])
 function keyboard(event,index){
  const next={ArrowRight:(index+1)%3,ArrowLeft:(index+2)%3,Home:0,End:2}[event.key]
  if(next===undefined)return
  event.preventDefault();onView(views[next]);tabs.current.children[next].focus()
 }
 const guide=areas=><aside className="lgd-person-guide" aria-label="人物资料说明">{areas.map(area=><button key={area.id} type="button" disabled={!person} aria-label={person?`${person.payload.name} · ${area.title}`:area.title} onClick={()=>onPerson(person,area.id)}>
  <Icon name={area.icon}/><span><strong>{area.title}</strong><small>{area.description}</small></span>
 </button>)}</aside>
 return <div className="lgd-people-collection" data-view={view}>
  <style>{css}</style>
  <div ref={tabs} role="tablist" aria-label="人物展示方式" className="lgd-people-views">{views.map((id,i)=><button key={id} type="button" role="tab" id={`${prefix}-${id}`} aria-controls={`${prefix}-panel`} aria-selected={view===id} tabIndex={view===id?0:-1} onClick={()=>onView(id)} onKeyDown={e=>keyboard(e,i)}>
   {view===id&&<motion.span className="lgd-view-pill" layoutId={`${prefix}-pill`} transition={{duration:reduced?0:.25,ease:'easeOut'}}/>}<span>{id[0].toUpperCase()+id.slice(1)} view</span>
  </button>)}</div>
  <div id={`${prefix}-panel`} role="tabpanel" aria-labelledby={`${prefix}-${view}`} className="lgd-people-layout">
   {guide(personAreas.slice(0,3))}
   <div className="lgd-people-main">
    <div className="lgd-people-grid">
     {records.map((r,i)=>{
      const identity=characterRoleView(r.display?.character_role),depth=(i-at+records.length)%records.length,front=!pack||depth===0
      return <motion.button key={r.id} type="button" layout={!reduced} initial={false} className="lgd-person-row" data-person-id={r.id} aria-label={`${r.payload.name} · 打开人物资料`} aria-hidden={!front||undefined} tabIndex={front?0:-1} disabled={!front} onClick={()=>onPerson(r)}
       style={{zIndex:pack?records.length-depth:1,pointerEvents:front?'auto':'none'}}
       animate={{x:pack&&depth===1?-8:pack&&depth===2?8:0,y:pack?Math.min(depth,2)*7:0,rotate:pack&&depth===1?-5:pack&&depth===2?5:0,opacity:!pack||depth<3?1:0}}
       transition={reduced?{duration:0}:{duration:.45,ease:[.22,.8,.25,1]}}>
       <span className="lgd-person-initial" aria-hidden="true">{Array.from(r.payload.name)[0]}</span>
       <span className="lgd-person-text"><strong title={r.payload.name}>{r.payload.name}</strong><small className="lgd-person-description" title={r.payload.description}>{r.payload.description||'暂无人物简介'}</small></span>
       <span className="lgd-person-level">{identity.label}<small>{identity.detail}</small></span>
       {identity.scope&&<small className="lgd-person-scope" title={identity.scope}>{identity.scope}</small>}
      </motion.button>
     })}
     {!pack&&Array.from({length:pageCapacity-records.length},(_,i)=><span aria-hidden="true" key={'slot:'+i}/>)}
    </div>
    {pack&&person&&<nav className="lgd-pack-picker" aria-label="切换卡叠人物"><button type="button" aria-label="上一个人物" disabled={records.length<2} onClick={()=>setSelected(records[(at+records.length-1)%records.length].id)}>‹</button><span><strong>{person.payload.name}</strong><small>本页 {at+1} / {records.length}</small></span><button type="button" aria-label="下一个人物" disabled={records.length<2} onClick={()=>setSelected(records[(at+1)%records.length].id)}>›</button></nav>}
   </div>
   {guide(personAreas.slice(3))}
  </div>
 </div>
}
