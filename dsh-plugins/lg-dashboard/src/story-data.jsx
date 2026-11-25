import React,{useEffect,useState} from 'react'
import {requestStory} from './story-read.js'
import {number} from './charts.jsx'
import {StoryBrowser} from './story-browser.jsx'
import {TemporalView} from './temporal-view.jsx'
import {storySections,personTabs,sectionStats} from './story-sections-data.js'
import css from './story-data.css'
import {StoryQuality} from './story-quality.jsx'
import {OutlineMain} from './outline-main.jsx'
import {StoryModuleDeck} from './story-module-deck.jsx'

function Tabs({items,value,onChange,label}){
 return <nav className="lgd-segment lgd-section-tabs" aria-label={label}>{items.map(([id,title])=><button key={id} aria-pressed={value===id} onClick={()=>onChange(id)}>{title}</button>)}</nav>
}
function People({path,person,onPerson,initialTab='profile',view,onView,sort,onSort}){
 const [tab,setTab]=useState(initialTab),[experience,setExperience]=useState('events')
 if(!person)return <StoryBrowser path={path} options={{type:'entity',entity_kind:'character'}} people onPerson={onPerson} peopleView={view} onPeopleView={onView} peopleSort={sort} onPeopleSort={onSort} empty="尚无人物档案。"/>
 return <>
  <Tabs items={personTabs} value={tab} onChange={setTab} label="人物资料栏目"/>
  {tab==='experience'?<><Tabs items={[["events","经历事件"],["at-event","事件前后状态"]]} value={experience} onChange={setExperience} label="人物经历内容"/>
   <TemporalView key={experience} path={path} mode={experience==='events'?'experience':'character'} subject={person.id}/>
  </>:<StoryBrowser key={tab} path={path} options={tab==='profile'?{id:person.id}:{type:tab,subject:person.id}}/>}
 </>
}
function Plot({path,counts}){
 const [tab,setTab]=useState('events'),[dimension,setDimension]=useState('rhythm'),[thread,setThread]=useState(''),[plan,setPlan]=useState('plan')
 const items=[['events','具体情节'],['summary','章节梗概'],['thread','伏笔与线索'],['revelation','读者揭示'],['rhythm','节奏与情绪']]
 if(counts?.plan||counts?.requirement)items.push(['plan','创作规划与要求'])
 let options={}
 if(tab==='revelation')options={type:'revelation'}
 if(tab==='summary')options={type:'analysis',dimension:'summary'}
 if(tab==='thread')options={type:'thread',...thread&&{thread_kind:thread}}
 if(tab==='rhythm')options={type:'analysis',dimension}
 if(tab==='plan')options={type:plan}
 return <>
  <Tabs items={items} value={tab} onChange={setTab} label="情节资料栏目"/>
  {tab==='events'?<TemporalView path={path} mode="time"/>:<>
   {tab==='revelation'&&<p className="lgd-muted">按正文出现顺序查看披露与暗示；人物陈述保留其来源，不作为已确认的世界事实。</p>}
   {tab==='thread'&&<div className="lgd-section-filter"><label>线索类型 <select value={thread} onChange={e=>setThread(e.target.value)}><option value="">全部线索</option>{[['foreshadowing','伏笔'],['mystery','悬念'],['conflict','冲突'],['relationship','关系线'],['goal','目标线']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label></div>}
   {tab==='rhythm'&&<><Tabs items={[["rhythm","节奏快慢"],["emotion","情绪变化"],["style","文风"],["theme","主题"],["logic","逻辑"]]} value={dimension} onChange={setDimension} label="分析维度"/><p className="lgd-muted">按章节查看已有分析。爽点、爆发点与蓄积点尚未单独标注。</p></>}
   {tab==='plan'&&<Tabs items={[["plan","创作规划"],["requirement","作者要求"]]} value={plan} onChange={setPlan} label="创作意图"/>}
   <StoryBrowser key={JSON.stringify(options)} path={path} options={options}/>
  </>}
 </>
}
function World({path}){
 const [tab,setTab]=useState('rules'),[visibility,setVisibility]=useState(''),[kind,setKind]=useState('group')
 const options=tab==='rules'?{type:'world_rule',...visibility&&{reader_visibility:visibility}}:tab==='scenes'?{type:'scene'}:{type:'entity',entity_kind:tab==='places'?'place':kind}
 return <>
  <Tabs items={[["rules","世界设定"],["places","地点"],["scenes","情节场景"],["other","势力与物品"]]} value={tab} onChange={setTab} label="环境资料栏目"/>
  {tab==='rules'&&<><Tabs items={[["","全部设定"],["revealed","已向读者揭露"],["unrevealed","未向读者揭露"],["unmarked","待核对"]]} value={visibility} onChange={setVisibility} label="设定揭露状态"/>
   {visibility==='unmarked'&&<p className="lgd-muted">没有明确揭露标记，或仅有暗示的设定，暂放在这里。</p>}
  </>}
  {tab==='other'&&<Tabs items={[["group","势力"],["object","物品"],["concept","概念"]]} value={kind} onChange={setKind} label="环境实体类型"/>}
  <StoryBrowser key={JSON.stringify(options)} path={path} options={options} empty={tab==='rules'&&visibility==='unrevealed'?'尚无明确标记为未揭露的设定；缺少揭露记录的内容保留在“待核对”中。':'此范围尚无记录。'}/>
 </>
}

export function StoryData({path}){return <StorySections key={path} path={path}/>}
function StorySections({path}){
 const [section,setSection]=useState(''),[person,setPerson]=useState(null)
 const [peopleView,setPeopleView]=useState('card'),[personTab,setPersonTab]=useState('profile')
 const [peopleSort,setPeopleSort]=useState('importance')
 const openPerson=(record,tab='profile')=>{setPersonTab(tab);setPerson(record)}
 const [data,setData]=useState(null),[error,setError]=useState('')
 useEffect(()=>{
  const controller=new AbortController();setError('')
  requestStory({action:'story-overview',path,options:{}},controller.signal).then(value=>{if(!controller.signal.aborted)setData(value)}).catch(e=>{if(!controller.signal.aborted){setError(e.message);setData(null)}})
  return()=>controller.abort()
 },[path])
 const overview=()=>{setSection('');setPerson(null)}
 const stats=sectionStats(data),active=storySections.find(item=>item.id===section)
 return <section className="lgd-story-sections" aria-label="故事资料"><style>{css}</style>
  <div className="lgd-story-section-head"><nav className="lgd-story-crumb" aria-label="故事资料导航">
   {section?<><button onClick={overview}>故事资料</button><span>/</span>{person?<><button onClick={()=>setPerson(null)}>{active.title}</button><span>/</span><strong>{person.payload.name}</strong></>:<strong>{active.title}</strong>}</>:<h2>故事资料</h2>}
  </nav>{!section&&data&&<small>{number(data.total)} 条资料 · 已登记来源 {data.coverage.registered_chapters} 章</small>}</div>
  {error&&<p role="alert">{error}</p>}
  {!section&&<StoryQuality data={data}/>}
  <StoryModuleDeck section={section} onSection={next=>{setSection(next);setPerson(null)}} stats={stats} loaded={Boolean(data)}>
   <div key={section}>
    {section && <OutlineMain key={person?.id??section} path={path} section={section} id={person?.id}/>}
    {person&&<div className="lgd-section-head"><h3>{person.payload.name}</h3><button onClick={()=>setPerson(null)}>‹ 人物列表</button></div>}
    {section==='people'?<People key={person?.id??'list'} path={path} person={person} onPerson={openPerson} initialTab={personTab} view={peopleView} onView={setPeopleView} sort={peopleSort} onSort={setPeopleSort}/>:section==='plot'?<Plot path={path} counts={data?.counts}/>:section==='world'?<World path={path}/>:null}
   </div>
  </StoryModuleDeck>
 </section>
}
