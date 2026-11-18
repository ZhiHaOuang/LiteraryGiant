import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

export const inject = ['slots','configForms']
const taskNames = {polish:'选区润色',review:'选区审阅','candidate-analysis':'候选监督分析','manuscript-review':'正文审阅','plan-review':'规划审阅',ideas:'三方案构思',
  'scene-plan':'场景计划','draft-scene':'场景起草','draft-chapter':'整章生成','extract-memory':'提取故事事实','analyze-reference':'参考资料分析'}

function RoleSettings({form}) {
  const snapshot=useSyncExternalStore(useCallback(fn=>form.subscribe(fn),[form]),useCallback(()=>form.getSnapshot(),[form]))
  const [roles,setRoles]=useState([]),[id,setId]=useState('chapter-writer'),[draft,setDraft]=useState(null)
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('')
  useEffect(()=>{
    const controller=new AbortController()
    async function load() {
      const response=await fetch('/api/lg/agents',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({action:'roles'})})
      const result=await response.json()
      if (!result.ok) throw new Error(result.error)
      if (!controller.signal.aborted) setRoles(result.value)
    }
    load().catch(e=>{if(!controller.signal.aborted)setError(e.message)})
    return ()=>controller.abort()
  },[])
  const role=roles.find(item=>item.id===id)
  const configured=snapshot.value?.roles??[],saved=configured.find(item=>item.id===id)
  const value=draft??{enabled:saved?.enabled!==false,instructions:saved?.instructions??''}
  const writable=snapshot.status==='ready'&&snapshot.writable&&!busy
  function edit(change) {
    setMessage('');setError('')
    setDraft({...value,revision:draft?.revision??snapshot.revision,...change})
  }
  async function save() {
    setBusy(true);setError('');setMessage('')
    try {
      const updated={...saved,id,enabled:draft.enabled,instructions:draft.instructions}
      const rows=configured.slice(),index=rows.findIndex(item=>item.id===id)
      if (index<0) rows.push(updated)
      else rows[index]=updated
      if (!await form.mutate([{op:'set',path:['roles'],value:rows}],draft.revision)) throw new Error('设置未保存。请重新载入当前配置，再核对更改。')
      setDraft(null);setMessage('已保存到当前配置。')
    } catch(e) {setError(e.message)} finally {setBusy(false)}
  }
  return <section aria-label="文学专家设置" style={{display:'grid',gap:12,maxWidth:720}}>
    <h2>文学专家设置</h2><p>这些设置用于当前 DSH 配置下各作品的新任务。</p>
    <label>文学专家 <select aria-label="文学专家" value={id} disabled={!roles.length||busy||!!draft} onChange={e=>{setId(e.target.value);setMessage('');setError('')}}>
      {roles.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {role&&<><p>{role.role}</p><p>{role.tasks.length?'已接入任务：'+role.tasks.map(t=>taskNames[t]??t).join('、'):'当前插件组合没有该专家可执行的任务。'}</p>
      <label><input type="checkbox" checked={!!role.tasks.length&&value.enabled} disabled={!writable||!role.tasks.length} onChange={e=>edit({enabled:e.target.checked})}/> 启用此专家</label>
      <label>专家补充要求<textarea aria-label="专家补充要求" style={{display:'block',width:'100%',minHeight:90}} value={value.instructions} disabled={!writable||!role.tasks.length} onChange={e=>edit({instructions:e.target.value})}/></label>
      <div><button disabled={!writable||!draft} onClick={save}>保存专家设置</button>{draft&&<button disabled={busy} onClick={()=>{setDraft(null);setMessage('');setError('')}}>放弃编辑并载入当前配置</button>}</div></>}
    {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
  </section>
}

export function apply(ctx) {
  const form=ctx.configForms.get('lg-agents')
  ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({name:'plugins.bundle.config',key:'lg-agents'},
    ({view})=>view==='summary'?'文学专家、任务和补充要求':<RoleSettings form={form}/>))
}
