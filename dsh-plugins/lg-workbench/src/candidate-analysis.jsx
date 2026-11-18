import React,{useEffect,useRef,useState} from 'react'
import {AnalysisReport} from '../../lg-agents/src/analysis-report.jsx'
import {previewTask,runTask,cancelTask} from '../../lg-agents/src/client-task.js'

async function request(endpoint,input,signal) {
  const res=await fetch('api/lg/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal})
  const result=await res.json()
  if(!result.ok)throw new Error(result.error)
  return result.value
}
const names={CharacterArc:'人物弧线',EventsLibrary:'事件机制',PayoffAngst:'爽点与虐点',EmotionRhythm:'情绪节奏',Worldview:'世界规则'}
const states={current:'报告有效',missing:'缺少报告',stale:'来源已变化',invalid:'报告无效'}
export function CandidateAnalysis({path,target,onClose}) {
  const [list,setList]=useState(null),[plans,setPlans]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState(null)
  const active=useRef(null)
  async function status(signal) {
    const v=await request('agents',{action:'analysis-status',path,target},signal)
    if(!signal?.aborted)setList(v.categories)
  }
  useEffect(()=>{const c=new AbortController();status(c.signal).catch(e=>{if(!c.signal.aborted)setError(e.message)});return()=>{c.abort();active.current?.controller.abort()}},[])
  async function prepare(categories) {
    setBusy(true);setError('');setResult(null)
    try {
      const batch=[]
      for(const category of categories) batch.push(await previewTask(request,{path,task:'candidate-analysis',target:{...target,category},operation:crypto.randomUUID()}))
      setPlans(batch)
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function run() {
    if(active.current)return
    const job={controller:new AbortController(),preview:null,stop:false}
    active.current=job;setBusy(true);setError('')
    try {
      for(const preview of plans) {
        if(job.stop)break
        job.preview=preview
        const v=await runTask(request,preview,job.controller.signal)
        if(v.status!=='analysis-ready')throw new Error(v.validationError??v.candidateError??v.run?.result?.error??v.status)
        setResult(v.report);setPlans(remaining=>remaining.filter(p=>p!==preview))
      }
    }catch(e){if(!job.controller.signal.aborted)setError(e.message)}
    finally{
      active.current=null
      if(!job.controller.signal.aborted){try{await status()}catch(e){setError(e.message)}setBusy(false)}
    }
  }
  async function stop() {
    const job=active.current
    if(!job?.preview)return
    job.stop=true
    try {await cancelTask(request,job.preview)}catch(e){setError(e.message)}
  }
  const needed=list?.filter(c=>['missing','stale'].includes(c.state)).map(c=>c.category)??[]
  return <aside><h3>候选监督分析</h3>
    {list?.length===0&&<p>本书未启用候选监督。</p>}
    {list?.map(c=><p key={c.category}>{names[c.category]} · {states[c.state]} {c.error}
      {['missing','stale'].includes(c.state)&&<button disabled={busy||plans.length>0} onClick={()=>prepare([c.category])}>预览{names[c.category]}分析</button>}</p>)}
    {needed.length>1&&<button disabled={busy||plans.length>0} onClick={()=>prepare(needed)}>预览补齐 {needed.length} 类报告</button>}
    {plans.length>0&&<section><p>{plans.length} 份候选报告 · 合计预留 ¥{plans.reduce((sum,p)=>sum+p.plan.reservedCny,0).toFixed(6)}</p>
      {plans.map(({input,plan})=><details key={input.operation}><summary>{names[input.target.category]} · {plan.role} · 完整分析输入</summary>
        <p>{plan.provider} / {plan.model} · {plan.inputBytes} 字节 · 预留 ¥{plan.reservedCny.toFixed(6)}</p><pre>{plan.modelInput.system+'\n\n'+plan.modelInput.input}</pre></details>)}
      <button disabled={busy} onClick={run}>{plans.length===1?'生成这份候选报告':'确认按顺序生成报告'}</button>
      {busy?<button onClick={stop}>停止本批分析</button>:<button onClick={()=>setPlans([])}>返回类别</button>}</section>}
    {result&&<AnalysisReport report={result}/>}
    {error&&<p role="alert">{error}</p>}<button disabled={busy} onClick={onClose}>返回候选正文</button></aside>
}
