import React,{useState} from 'react'

export function RunHistory({api,getEditor,path,disabled}) {
  const [page,setPage]=useState(null),[source,setSource]=useState(false),[view,setView]=useState(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[limit,setLimit]=useState(30)
  async function work(fn){
    setBusy(true);setError('')
    try{await fn()}catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function list(old,before){
    const result=await api(old?'legacy-list':'history-list',{before})
    setSource(old);setView(null);setPage({...result,items:before?[...page.items,...result.items]:result.items})
  }
  async function show(item){
    const next=source?await api('legacy-preview',{id:item.id}):{record:await api('history-read',{token:item.token}),token:item.token}
    setView({...next,saved:!source});setLimit(30)
  }
  async function save(){
    const record=await api('legacy-import',{id:view.record.id,token:view.token,confirmed:true})
    await list(false);setView({record,token:view.token,saved:true})
  }
  const r=view?.record
  return <details><summary>旧版运行历史</summary><fieldset disabled={disabled||busy}>
    <button onClick={()=>work(()=>list(true))}>查看本书旧运行</button><button onClick={()=>work(()=>list(false))}>查看已导入快照</button>
    {page&&<nav aria-label={source?'旧运行':'已导入快照'}>{page.items.map(item=><button key={item.token??item.id} disabled={!!item.error} onClick={()=>work(()=>show(item))}>
      {item.title||item.id} · {item.error??item.status}{item.imported?' · '+item.imported:''}</button>)}
      {!page.items.length&&<p>{source?'本书未找到旧运行。':'尚无已导入快照。'}</p>}
      {page.next!=null&&<button onClick={()=>work(()=>list(source,page.next))}>加载更早记录</button>}</nav>}
    {r&&<section aria-label="旧运行详情"><h3>{r.workflow} · {r.id}</h3><p>{r.request}</p>
      <p>记录时状态 {r.status} · {r.updated}{r.reason?' · '+r.reason:''}</p>
      <p>{[r.strategy,r.provider,r.model,r.modelCalls!=null?'模型调用 '+r.modelCalls+' 次':''].filter(Boolean).join(' · ')}</p>
      {r.resumedFrom&&<p>源自旧运行 {r.resumedFrom}</p>}
      {r.stages.length>0&&<p>已完成步骤：{r.stages.join('、')}</p>}
      {r.decision&&<details><summary>当时的方向备选 · 第 {r.decision.number} 版</summary>
        {r.decision.options.map(o=><p key={o.id}><strong>{o.title}</strong> · {o.summary}</p>)}</details>}
      {r.events.length>0&&<details><summary>公开事件 · {r.events.length}</summary><ol>{r.events.slice(0,limit).map((e,i)=><li key={i}>{e.at} · {e.type} {e.stage} {e.message}</li>)}</ol>
        {limit<r.events.length&&<button onClick={()=>setLimit(limit+30)}>显示更多事件</button>}</details>}
      {r.versions.map(v=><p key={v.version}>{v.slug} · v{v.number} · 版本 ID {v.version}
        {view.saved&&getEditor()&&<button onClick={()=>work(async()=>{const target=await api('history-version',{token:view.token,version:v.version});getEditor().openVersion(path,target.document,target.version)})}>在编辑台打开历史版本</button>}</p>)}
      {r.candidateUnavailable&&<p>原任务标记的候选无法与本书版本对应。</p>}
      {view.saved?<p>已保存历史快照。</p>:<button onClick={()=>work(save)}>确认导入此历史快照</button>}
    </section>}
  </fieldset>{error&&<p role="alert">{error}</p>}</details>
}
