import React,{useEffect,useState} from 'react'

const labels={observation:'原文所见',belief:'人物判断','public-claim':'公开说法',appraisal:'他人评价',plan:'规划',intention:'人物意图',before:'先于',after:'后于',triggers:'触发',enables:'促成',impedes:'阻碍',revises:'修正',interpretation:'解释性推断',
  believes:'相信',doubts:'怀疑',denies:'否认',uncertain:'未确定',scene:'当场',phase:'阶段','long-term':'长期',
  active:'进行中',blocked:'受阻',paused:'搁置',achieved:'达成',abandoned:'放弃',outgoing:'本人物对对方',incoming:'对方对本人物',mutual:'双向',
  public:'公开',private:'私下',unknown:'未知',core:'核心',major:'重要',supporting:'辅助',minor:'次要'}

export function CharacterMain({path,id,onFollow}) {
  const [groups,setGroups]=useState(null),[error,setError]=useState('')
  useEffect(()=>{
    const controller=new AbortController()
    async function load(){
      setGroups(null);setError('')
      const response=await fetch('api/lg/outline',{method:'POST',headers:{'content-type':'application/json'},
        signal:controller.signal,body:JSON.stringify({action:'character',path,options:{id}})})
      if(response.status===404) throw Error('启用 lg-storydata 后可读取人物 Main。')
      const {ok,value,error}=await response.json()
      if(!response.ok || !ok) throw Error(error || '人物档案读取失败')
      if(value?.api_version!=='lg.outline.character.v1' || value.id!==id || !Array.isArray(value.groups) ||
          !value.groups.every(g=>typeof g.label==='string' && Array.isArray(g.facets) &&
            (g.item===null || (Array.isArray(g.item.entries) && Array.isArray(g.item.related))))) throw Error('人物档案读取接口不匹配')
      if(!controller.signal.aborted) setGroups(value.groups)
    }
    load().catch(e=>{if(!controller.signal.aborted)setError(e.message)})
    return ()=>controller.abort()
  },[path,id])
  if(error) return <p role="alert">{error}</p>
  if(!groups) return <p>正在读取人物档案…</p>
  return <section aria-label="人物 Main">{groups.map(({module,label,facets,item})=><section key={module}>
    <h4>{label}</h4>
    {item ? <>
      {item.freshness==='stale' && <small>来源已变化，待复核</small>}
      {item.entries.length===0 && <p>本次审查后无当前条目。</p>}
      <dl>{item.entries.map(entry=><React.Fragment key={entry.key}>
        <dt>{facets.find(f=>f.id===entry.facet)?.label??entry.facet}</dt>
        <dd>{entry.value}<br/><small>{[entry.scope,entry.time,entry.target,...['direction','visibility','nature','stance','span','status','importance'].map(k=>labels[entry[k]]),
          entry.event_relation && labels[entry.event_relation],entry.related_event_id && item.related.find(t=>t.id===entry.related_event_id)?.title,...entry.tags].filter(Boolean).join(' · ')}</small></dd>
      </React.Fragment>)}</dl>
      {item.related.map(target=><button type="button" key={target.id} onClick={()=>onFollow(target.id,item.related_sections?.[target.id])}>{target.title}</button>)}
    </> : <p>尚无已审查条目。</p>}
  </section>)}</section>
}
