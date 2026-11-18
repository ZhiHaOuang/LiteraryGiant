import React,{useEffect,useState} from 'react'
import {Card,number} from './charts.jsx'
import styles from './team-panel.css'
import {TeamUsage} from './team-usage.jsx'
import {AgentSparkline,Companions} from './team-roster.jsx'
import {dateKeys,localDay} from './global-data.js'
import {previewUsageDays} from './roster-data.js'
import {agentCatalog} from './team-data.js'
import coordinatorAvatar from './assets/coordinator-avatar.png'
import analysisAvatar from './assets/analysis-avatar.png'
import planningAvatar from './assets/planning-avatar.png'
import writingAvatar from './assets/writing-avatar.png'
const avatars={coordinator:coordinatorAvatar,analysis:analysisAvatar,planning:planningAvatar,writing:writingAvatar}
const names={coordinator:'主 Agent',analysis:'分析',planning:'规划',writing:'创作'}
const statuses={starting:'准备中',running:'执行中',completed:'候选已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'}
async function query(input,signal){
 const response=await fetch('api/lg/teams',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal})
 if(response.status===404)return null
 const body=await response.json();if(!response.ok||!body.ok)throw Error(body.error??'文学协作查询失败');return body.value
}
function Result({task}){
 const [value,setValue]=useState(null),[error,setError]=useState('')
 return <details className="lgt-task" onToggle={async e=>{if(e.currentTarget.open&&!value)try{setValue(await query({action:'task',id:task.id}));setError('')}catch(e){setError(e.message)}}}>
  <summary><span>{task.owner?.startsWith('experiment-')?'隔离实验 · ':''}{names[task.role]} · {task.objective.length>80?task.objective.slice(0,80)+'…':task.objective}</span><small>{statuses[task.status]??task.status}</small></summary>
  {error&&<p role="alert">{error}</p>}
  {value&&<div><details><summary>完整任务目标</summary><p>{task.objective}</p></details><p>{value.artifact?.summary??value.error??'等待成员提交。'}</p>
   {value.metrics&&<p><strong>程序实测 {value.metrics.han} 汉字</strong>{value.metrics.min_han!==undefined?` · 要求 ${value.metrics.min_han}—${value.metrics.max_han}`:''}</p>}
   {value.source&&<details><summary>作者要求与来源版本{value.source_current?'':' · 当前无法核对'}</summary><p>{value.source.brief}</p><ul>{value.source.chapters.map(ch=><li key={ch.document_id}>第 {ch.number} 章 · {ch.title} · 版本 {ch.version_id}</li>)}</ul></details>}
   {value.artifact?.text&&<pre className="lgt-prose">{value.artifact.text}</pre>}
   {value.artifact&&<details><summary>完整结构化候选</summary><pre>{JSON.stringify(value.artifact,null,2)}</pre></details>}
   <small>任务 {value.id} · 来源 {value.source_id} · 候选，不代表正式采纳</small>
  </div>}
 </details>
}
export function TeamPanels({range,filter,refresh,period='7d'}){
 const [preview,setPreview]=useState(true),[bucketCount,setBucketCount]=useState(24)
 const [data,setData]=useState(null),[error,setError]=useState(''),[ready,setReady]=useState(false)
 useEffect(()=>{
  const controller=new AbortController();let timer
  const load=async()=>{try{const value=await query({action:'overview',period,buckets:bucketCount,...filter&&filter!=='unbound'?{path:filter}:{}},controller.signal);if(!controller.signal.aborted){setData(value);setError('');setReady(true)}}catch(e){if(!controller.signal.aborted){setError(e.message);setReady(true)}}finally{if(!controller.signal.aborted)timer=setTimeout(load,30000)}}
  void load();return()=>{controller.abort();clearTimeout(timer)}
 },[period,bucketCount,filter,refresh])
 const empty=!ready?'正在读取文学协作…':error||'文学协作插件尚未启用。'
 const tasks=filter==='unbound'?[]:data?.tasks??[]
 const timeline=data?.monitoring?.timeline,agentRange=timeline?{from:localDay(new Date(timeline.from)),to:localDay(new Date(timeline.to-1))}:range
 const dayKeys=data?dateKeys(agentRange.from,agentRange.to):[]
 return <><style>{styles}</style><div className="lgt-panels">
  <Card className="lgt-roster" icon="agent" title="文学 Agent" meta={<span className="lgt-roster-meta"><button className="lgt-preview-toggle" aria-pressed={preview} onClick={()=>setPreview(!preview)} title="仅左侧小图使用示例数据，不计入真实统计">Preview</button><span>1 主 + 3 成员</span></span>}>
   {data&&error&&<p role="alert">更新失败，以下为上次结果：{error}</p>}
   {!data&&<p role="status">{empty}</p>}
   {data&&agentCatalog(data.catalog).map(role=><details className="lgt-role" key={role.id}>
    <summary><img src={avatars[role.id]} draggable={false} className={'lgt-avatar lgt-avatar-'+role.id} alt=""/><span><b>{role.name}</b><small>{role.output}</small></span><AgentSparkline days={preview?previewUsageDays(dayKeys,role.id):filter==='unbound'?{}:data.monitoring?.roles?.find(r=>r.role===role.id)?.days} dayKeys={dayKeys} name={role.name} preview={preview}/><span className="lgt-role-chevron">›</span></summary>
    <p>{role.description}</p>{role.prompt?<details><summary>职责 Prompt{role.version?' · v'+role.version:''}</summary><pre>{role.prompt}</pre></details>:<small>重启 App 后可读取主 Agent 的实际职责 Prompt。</small>}
    {role.method&&<details><summary>可选方法草稿 · 待你审查</summary><pre>{role.method}</pre></details>}
   </details>)}
   {data&&<Companions/>}
  </Card>
  <Card className="lgt-monitor" icon="gauge" title="文学 Agent 统计">
   {data&&error&&<p role="alert">用量更新失败，以下为上次结果。</p>}
   {!data?<p role="status">{empty}</p>:<TeamUsage data={data} unbound={filter==='unbound'} onCapacity={setBucketCount}/>}
  </Card>
 </div>{tasks.length>0&&<details className="lgt-results"><summary>文学协作任务与候选 · {tasks.length}</summary>{tasks.slice().reverse().map(task=><Result key={task.id} task={task}/>)}</details>}</>
}
