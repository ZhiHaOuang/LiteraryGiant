import React from 'react'

export function IdeaOptions({flow,api,work,reload,disabled,pending,setPending}) {
  const options=flow.steps[0].result.proposal.options
  const waiting=flow.status==='awaiting-direction'
  const selected=waiting?flow.choice?.option:flow.steps[1]?.task.context?.direction?.option_id??flow.choiceReceipt?.option
  async function prepare(option){
    const preview=await api('choice-preview',{id:flow.id,option})
    setPending({option,token:preview.token,operation:crypto.randomUUID()})
  }
  return <section aria-label="本次构思方案"><h3>本次构思方案</h3>
    {options.map(o=><article key={o.id}><strong>{o.title}</strong><p>{o.content}</p>
      {selected===o.id?<p>{waiting?'当前已选':'已选方向'}</p>:waiting&&!pending&&<button disabled={disabled} onClick={()=>work(()=>prepare(o.id))}>预览选择「{o.title}」</button>}
    </article>)}
    {waiting&&pending&&<div><p>将「{options.find(o=>o.id===pending.option).title}」设为本章创作方向。</p>
      <button disabled={disabled} onClick={()=>work(async()=>{await api('choose',{id:flow.id,...pending});setPending(null);await reload()})}>确认本章方向</button>
      <button disabled={disabled} onClick={()=>setPending(null)}>返回方案</button></div>}
    {flow.choiceError&&<p role="alert">{flow.choiceError}</p>}
  </section>
}
