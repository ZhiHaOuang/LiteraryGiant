import React,{useEffect,useId,useLayoutEffect,useRef,useState} from 'react'
import {motion} from 'framer-motion'
import {Icon} from './icons.jsx'
import {cardIntro,chapterRange,characterRoleView} from './story-fields.js'
import {PersonAvatar} from './person-avatar.jsx'
import {peopleLayout,personAreas} from './story-sections-data.js'
import {createPeopleReflow} from './people-reflow.js'
import css from './people-collection.css'

const views=['list','card','pack']

// Reuse the same keyed cards for all three layouts; Motion continues interrupted moves.
export function PeopleCollection({records,columns,reflow,awaitingResize,partialPage,view='card',onView,sort,onSort,onPerson}){
 const prefix=useId(),tabs=useRef(null)
 const [reduced,setReduced]=useState(true),[selected,setSelected]=useState('')
 const pack=view==='pack'
 const at=Math.max(0,records.findIndex(r=>r.id===selected)),person=records[at]
 useEffect(()=>{
  const preference=window.matchMedia('(prefers-reduced-motion: reduce)')
  const update=()=>setReduced(preference.matches||document.hidden||document.body.dataset.dshClaudeMotion==='reduced')
  update();const observer=new MutationObserver(update)
  observer.observe(document.body,{attributes:true,attributeFilter:['data-dsh-claude-motion']})
  document.addEventListener('visibilitychange',update)
  preference.addEventListener('change',update)
  return()=>{observer.disconnect();document.removeEventListener('visibilitychange',update);preference.removeEventListener('change',update)}
 },[])
 const grid=useRef(null),previousPage=useRef(null)
 useLayoutEffect(()=>{
  if(pack||reduced)return
  const el=grid.current,width=el.parentElement.clientWidth
  const controller=createPeopleReflow(el)
  controller.resize(width,peopleLayout(width,view).columns)
  reflow.current=controller
  return ()=>{reflow.current=null;controller.destroy()}
 },[reflow,view,pack,reduced])
 useLayoutEffect(()=>{
  const el=grid.current
  el.style.minHeight=''
  const last=previousPage.current
  if(last?.view===view&&(awaitingResize||(partialPage&&last.columns===columns))){el.style.minHeight=last.height+'px';return}
  const size={view,columns,height:el.offsetHeight}
  previousPage.current=size
  const observer=new ResizeObserver(([entry])=>{size.height=entry.borderBoxSize[0].blockSize})
  observer.observe(el)
  return ()=>observer.disconnect()
 },[records,view,columns,partialPage,awaitingResize])
 function keyboard(event,index){
  const next={ArrowRight:(index+1)%3,ArrowLeft:(index+2)%3,Home:0,End:2}[event.key]
  if(next===undefined)return
  event.preventDefault();onView(views[next]);tabs.current.children[next].focus()
 }
 const guide=areas=><aside className="lgd-person-guide" aria-label="人物资料说明">{areas.map(area=><button key={area.id} type="button" disabled={!person} aria-label={person?`${person.payload.name} · ${area.title}`:area.title} onClick={()=>onPerson(person,area.id)}>
  <Icon name={area.icon}/><span><strong>{area.title}</strong><small>{area.description}</small></span>
 </button>)}</aside>
 return <div className="lgd-people-collection" data-view={view} style={{'--people-columns':columns}}>
  <style>{css}</style>
  <div className="lgd-people-toolbar">
   <div ref={tabs} role="tablist" aria-label="人物展示方式" className="lgd-segment">{views.map((id,i)=><button key={id} type="button" role="tab" id={`${prefix}-${id}`} aria-controls={`${prefix}-panel`} aria-selected={view===id} tabIndex={view===id?0:-1} onClick={()=>onView(id)} onKeyDown={e=>keyboard(e,i)}>
    {id[0].toUpperCase()+id.slice(1)} View
   </button>)}</div>
   <div role="group" aria-label="人物排序" className="lgd-segment">
    <button type="button" aria-pressed={sort==='importance'} onClick={()=>onSort('importance')}>评级排序</button>
    <button type="button" aria-pressed={sort==='name'} onClick={()=>onSort('name')}>A-Z</button>
   </div>
  </div>
  <div id={`${prefix}-panel`} role="tabpanel" aria-labelledby={`${prefix}-${view}`} className="lgd-people-layout">
   {guide(personAreas.slice(0,3))}
   <div className="lgd-people-main">
    <div className="lgd-people-grid" ref={grid}>
     {records.map((r,i)=>{
      const identity=characterRoleView(r.display?.character_role),depth=(i-at+records.length)%records.length,front=!pack||depth===0
      const role=r.display?.character_role,portrait=r.display?.character_portrait
      const name=r.payload.name,alias=r.payload.aliases?.find(a=>a&&a!==name)
      const subtitle=identity.roles||(alias?`又名 ${alias}`:'')
      const bio=cardIntro(r.payload.description,r.summary),traits=portrait?.traits??[]
      const rank=role?.status!=='unrated'&&role?.assignments?.some(a=>a.prominence!=='unknown')?identity.label:''
      const caption=view==='list'?[subtitle,rank].filter(Boolean).join(' · '):subtitle
      return <motion.button key={r.id} type="button" layout={!reduced} layoutDependency={view} initial={false} className="lgd-person-row" data-person-id={r.id} aria-label={`${r.payload.name} · 打开人物资料`} aria-hidden={!front||undefined} tabIndex={front?0:-1} disabled={!front} onClick={()=>onPerson(r)}
       style={{zIndex:pack?records.length-depth:1,pointerEvents:front?'auto':'none'}}
       animate={{x:pack&&depth===1?-8:pack&&depth===2?8:0,y:pack?Math.min(depth,2)*7:0,rotate:pack&&depth===1?-5:pack&&depth===2?5:0,opacity:!pack||depth<3?1:0}}
       transition={reduced?{duration:0}:{duration:.45,ease:[.22,.8,.25,1]}}>
       <span className="lgd-person-head">
        <PersonAvatar id={r.id} description={r.payload.description}/><span className="lgd-person-name"><strong title={name}>{name}</strong>{caption&&<small title={caption}>{caption}</small>}</span>
        <span className="lgd-person-open" aria-hidden="true">›</span>
       </span>
       {bio&&<span className="lgd-person-bio">{bio}</span>}
       {(rank||traits.length>0)&&<span className="lgd-person-labels">
        {rank&&<strong className="lgd-person-rating" title={[identity.approval,chapterRange(identity.scope)||identity.scope].filter(Boolean).join(' · ')}>{rank}</strong>}
        {traits.map(t=><span className="lgd-person-trait" key={t.record_id+t.label} title={t.approval==='confirmed'?'已确认侧写':'候选侧写'}>{t.label}</span>)}
       </span>}
      </motion.button>
     })}
    </div>
    {pack&&person&&<nav className="lgd-pack-picker" aria-label="切换卡叠人物"><button type="button" aria-label="上一个人物" disabled={records.length<2} onClick={()=>setSelected(records[(at+records.length-1)%records.length].id)}>‹</button><span><strong>{person.payload.name}</strong><small>本页 {at+1} / {records.length}</small></span><button type="button" aria-label="下一个人物" disabled={records.length<2} onClick={()=>setSelected(records[(at+1)%records.length].id)}>›</button></nav>}
   </div>
   {guide(personAreas.slice(3))}
  </div>
 </div>
}
