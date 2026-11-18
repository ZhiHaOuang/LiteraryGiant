import React,{useEffect,useState} from 'react'
import {AnalysisReport} from '../../lg-agents/src/analysis-report.jsx'

export const inject = ['slots']

async function request(endpoint,input){const response=await fetch('/api/lg/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}),value=await response.json();if(!response.ok||!value.ok)throw new Error(value.error??'请求失败');return value.value}
const labels={proposed:'待确认',running:'执行中',completed:'已有结果',stopped:'已停止',dismissed:'已驳回'}
function Director({getEditor}){
  const [books,setBooks]=useState([]),[path,setPath]=useState(''),[items,setItems]=useState({items:[]}),[selected,setSelected]=useState(null),[preview,setPreview]=useState(null),[body,setBody]=useState(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[reason,setReason]=useState('作者停止本次分派。')
  const api=(action,args={})=>request('director',{action,path,...args})
  const analysis=selected?.input.task==='candidate-analysis'
  const target=analysis?selected.input.target:selected?.result?.candidate
  async function work(fn){setError('');setBusy(true);try{await fn()}catch(e){setError(e.message)}finally{setBusy(false)}}
  useEffect(()=>{request('books',{action:'list'}).then(setBooks).catch(e=>setError(e.message))},[])
  async function show(id){
    const value=await api('read',{id});setSelected(value);setPreview(null);setBody(null)
    if(value.result?.candidate)setBody(await request('books',{action:'manuscript',path,document:value.result.candidate.document,version:value.result.candidate.version}))
  }
  async function refresh(){setItems(await api('list'));if(selected)await show(selected.id)}
  async function changeBook(next){setPath(next);setSelected(null);setPreview(null);setBody(null);setItems(next?await request('director',{action:'list',path:next}):{items:[]})}
  async function execute(){const id=selected.id;await api('run',{id,token:preview.token});setItems(await api('list'));await show(id)}
  async function stop(){
    try{const current=await api('read',{id:selected.id});await api('stop',{id:current.id,token:current.token,reason});await show(current.id);setItems(await api('list'))}catch(e){setError(e.message)}
  }
  return <main className="lgd"><style>{`.lgd{padding:28px;max-width:1100px;margin:auto;height:100%;overflow:auto}.lgd input,.lgd select,.lgd button{padding:8px;margin:5px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit}.lgd article,.lgd aside{border:1px solid #8884;padding:16px;margin:16px 0;border-radius:10px}.lgd pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto}.lgd [role=alert]{color:#c96551}.lgd textarea{width:95%;min-height:220px;background:transparent;color:inherit}.lgd button:disabled{opacity:.5}`}</style>
    <small>LITERARYGIANT</small><h1>文学任务分派</h1><p>在作品目录的 DSH 会话中提出文学任务，Agent 会把建议放到这里。检查范围与输入后再交给专家；每项只执行一次有界任务。正文、规划和事实仍需分别审阅与采用。</p>
    <label>作品<select value={path} disabled={busy} onChange={e=>work(()=>changeBook(e.target.value))}><option value="">请选择作品</option>{books.map(b=><option key={b.path} value={b.path} disabled={!!b.error}>{b.name??b.path}</option>)}</select></label><button disabled={busy||!path} onClick={()=>work(refresh)}>刷新任务</button>
    {path&&!items.items.length&&<p>还没有任务提议。在对应作品的 DSH 会话中说明要处理的章节、范围和要求。</p>}
    <nav>{items.items.map(item=><button disabled={busy} key={item.id} onClick={()=>work(()=>show(item.id))}>{labels[item.status]} · {(item.request??item.task).slice(0,40)}</button>)}</nav>
    {items.nextOffset!=null&&<button disabled={busy} onClick={()=>work(async()=>{const next=await api('list',{offset:items.nextOffset});setItems({items:[...items.items,...next.items],nextOffset:next.nextOffset})})}>加载更早任务</button>}
    {selected&&<article><h2>{labels[selected.status]} · {selected.input.task}</h2><p>{selected.input.request}</p><p>来源会话：{selected.origin??'作者面板'}。任务 {selected.id}</p>
      <details><summary>目标版本、范围与材料选择</summary><pre>{JSON.stringify(selected.input,null,2)}</pre></details>
      {selected.reason&&<p>{selected.reason}</p>}
      {selected.callError&&<p>本机调用账本不可用：{selected.callError}</p>}
      {selected.call&&<p>原调用：{selected.call.status} · 预留 ¥{Number(selected.call.reservedCny??0).toFixed(6)}{selected.call.result?.estimatedCny!=null?` · 用量估算 ¥${selected.call.result.estimatedCny.toFixed(6)}`:''}</p>}
      {selected.status==='proposed'&&<button disabled={busy} onClick={()=>work(async()=>setPreview(await api('preview',{id:selected.id})))}>检查本次完整输入</button>}
      {preview&&<aside><p>{preview.plan.role} · {preview.plan.provider} / {preview.plan.model} · 输入 {preview.plan.inputBytes} 字节 · 本次预留 ¥{preview.plan.reservedCny.toFixed(6)}</p><details><summary>完整模型输入</summary><pre>{preview.plan.modelInput.system+'\n\n'+preview.plan.modelInput.input}</pre></details><button disabled={busy} onClick={()=>work(execute)}>确认范围并执行一次</button></aside>}
      {['running','stopped'].includes(selected.status)&&<button disabled={busy} onClick={()=>work(async()=>{const value=await api('recover',{id:selected.id});await show(selected.id);if(value.recoveryMessage)setError(value.recoveryMessage)})}>检查并恢复原结果</button>}
      {!['completed','dismissed'].includes(selected.status)&&<div><input aria-label="停止或驳回理由" value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)}/><button disabled={!reason.trim()} onClick={stop}>{selected.status==='proposed'&&!busy?'驳回提议':'停止任务'}</button></div>}
      {body&&<aside><h3>候选正文 · v{body.selected.version_number}</h3><textarea readOnly aria-label="分派生成候选" value={body.selected.content}/><p>尚未自动采用。请在章节编辑台比较并处理此候选。</p></aside>}
      {selected.result?.report&&(analysis?<AnalysisReport report={selected.result.report}/>:<aside><h3>审阅报告</h3>{selected.result.report.issues?.length?selected.result.report.issues.map(issue=><p key={issue.id}>{issue.category} · {issue.message}</p>):<p>报告未返回问题；这不代表要求已全部满足。</p>}<p>请在对应审阅面板核对证据、裁决及选择改稿问题。</p></aside>)}
      {target&&getEditor()&&<button disabled={busy} onClick={()=>work(()=>getEditor().openVersion(path,target.document,target.version))}>在文学编辑台打开此版本</button>}
      {selected.result&&<details><summary>执行结果与回执</summary><pre>{JSON.stringify({...selected.result,run:undefined},null,2)}</pre></details>}
    </article>}
    {error&&<p role="alert">{error}</p>}
  </main>
}
export function apply(ctx){
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'lg-director'},()=> <Director getEditor={()=>ctx.get('literaryWorkbench')}/>))
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'lg-director',order:20,label:()=>'文学任务'},()=> <span aria-hidden="true">↗</span>))
}
