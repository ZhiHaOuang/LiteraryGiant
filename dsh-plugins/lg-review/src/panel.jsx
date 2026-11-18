import React, { useEffect, useRef, useState } from 'react'
import { ContextPicker } from '../../lg-workbench/src/context-picker.jsx'
async function request(endpoint,input,signal) {
 const response=await fetch(`api/lg/${endpoint}`,{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify(input)})
 const result=await response.json();if(!result.ok)throw new Error(result.error);return result.value
}
const labels = {consistency:'一致性检查',manuscript:'正文',scenes:'场景卡',decisions:'创作方向',facts:'正式事实',timeline:'时间线',foreshadowing:'伏笔',context:'上下文',card:'场景约束','fact-source':'事实来源待复核','canonical-conflict':'正式事实取值不一致','scene-plan':'场景计划','scene-length':'场景字数','forbidden-content':'约束内容提及','character-availability':'人物状态提及','scene-identity':'场景关联',error:'数据异常',warning:'待复核',info:'提示',open:'待处理',resolved:'已处理',dismissed:'作者忽略'}
const label = value => labels[value] ?? ({quality:'章节质量',length:'篇幅',workflow:'场景采用',hook:'章末提示'}[value]) ?? value
export function ReviewPanel({path,target,onClose,onRevise}) {
 const quality=target.section==='quality',deterministic=quality||target.section==='consistency'
 const [checkOperation,setCheckOperation]=useState(()=>crypto.randomUUID())
 const [instruction,setInstruction]=useState('检查作者约束、人物目标、因果与信息知晓是否一致，引用问题双方的编号。')
 const [context,setContext]=useState(null),[preview,setPreview]=useState(null),[report,setReport]=useState(null),[history,setHistory]=useState({items:[]})
 const [selected,setSelected]=useState([]),[reason,setReason]=useState(''),[decision,setDecision]=useState(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState(null)
 const [decisions,setDecisions]=useState({})
 const active=useRef(null)
 const api=(action,extra={})=>request('review',{action,path,...extra})
 async function check() {
  setBusy(true);setError('')
  try{setReport(await api(target.section,{target,operation:checkOperation}));setSelected([]);setHistory(await api('list',{target}));setCheckOperation(crypto.randomUUID())}
  catch(error){setError(error.message+'。请求未确认时重试保留同一检查 ID。')}finally{setBusy(false)}
 }
 async function load(run) {setBusy(true);setError('');try{setHistory(await api('list',{target}));if(run){setReport(await api('read',{run}));setSelected([])}}catch(error){setError(error.message)}finally{setBusy(false)}}
 useEffect(()=>{void load();return()=>{if(active.current){active.current.controller.abort();void request('agents',{action:'cancel',operation:active.current.id}).catch(()=>{})}}},[])
 async function prepare() {
  setBusy(true);setError('');setResult(null)
  const input={task:target.section==='manuscript'?'manuscript-review':'plan-review',path,target,context,request:instruction,operation:crypto.randomUUID()}
  try{setPreview({input,value:await request('agents',{...input,action:'preview'})})}catch(error){setError(error.message)}finally{setBusy(false)}
 }
 async function run() {
  setBusy(true);setError('');const controller=new AbortController();active.current={id:preview.input.operation,controller}
  try{const value=await request('agents',{...preview.input,action:'run',signature:preview.value.signature},controller.signal);setResult(value);setPreview(null);if(value.report){setReport(value.report);setSelected([]);setHistory(await api('list',{target}))}}
  catch(error){setError('结果未确认：'+error.message+'。重试保留同一任务 ID。')}finally{active.current=null;setBusy(false)}
 }
 async function decide(item,status) {
  setBusy(true);setError('');const change={id:item.id,expected_token:item.token,status,reason}
  try{setDecision({change,...await api('preview',{change}),operation:crypto.randomUUID()})}catch(error){setError(error.message)}finally{setBusy(false)}
 }
 async function confirm() {
  setBusy(true);setError('')
  try{await api('apply',{change:decision.change,token:decision.token,operation:decision.operation});setDecision(null);setReason('');await load(report.run)}catch(error){setError(error.message)}finally{setBusy(false)}
 }
 const locked=busy||!!preview||!!decision
 return <aside><h2>{quality?'章节质量报告':deterministic?'作品一致性检查':target.section==='manuscript'?'正文审阅与改稿':'规划审阅与改稿'}</h2><p>{deterministic?'以下为程序规则提示，不调用模型。作者判断问题是否成立。':'以下为模型建议。作者判断问题是否成立；'}新报告不会自动关闭旧问题。</p>
  {deterministic&&<>{quality?<p>统计当前章正文和按顺序已采用的场景卡正文。对白占比按双引号匹配，章末信号按标点和词语匹配。</p>:<p>{target.id?'检查所选章节／场景的当前正文及子场景':'检查全书当前章节和场景正文'}，不检查候选版本。正式事实和时间线按全书核对；仅全书检查统计未回收伏笔。</p>}<button disabled={locked} onClick={check}>免费检查并保存报告</button></>}
  {!deterministic&&!preview&&<fieldset disabled={locked}><label>审阅要求<textarea value={instruction} maxLength={2000} onChange={event=>setInstruction(event.target.value)}/></label>
   <ContextPicker path={path} value={context} onChange={setContext} disabled={locked}/><p>未另选上下文时，沿用原生成任务选择的材料，并读取其当前内容。</p>
   <button disabled={!instruction.trim()} onClick={prepare}>预览审阅输入与预算</button></fieldset>}
  {preview&&<><p>{preview.value.provider} / {preview.value.model} · 预留 ¥{preview.value.reservedCny.toFixed(4)} · {preview.value.inputBytes} 字节</p>
   <details><summary>完整审阅输入</summary><pre style={{whiteSpace:'pre-wrap'}}>{preview.value.modelInput.system+'\n\n'+preview.value.modelInput.input}</pre></details>
   <button disabled={busy} onClick={run}>确认执行审阅</button>{busy?<button onClick={()=>request('agents',{action:'cancel',operation:active.current.id}).catch(error=>setError(error.message))}>取消任务</button>:<button onClick={()=>setPreview(null)}>返回调整</button>}</>}
  {result&&<p role="status">{result.status} · {result.run?.result?.elapsedMs??0} ms · {result.validationError||result.candidateError||result.run?.result?.error||''}</p>}
  <label>已保存报告<select disabled={locked} value={report?.run??''} onChange={event=>load(event.target.value)}><option value="">选择报告</option>{history.items.map(item=><option key={item.id} value={item.id}>{item.created_at} · {item.id.slice(0,8)}</option>)}</select></label>
  {history.nextOffset!=null&&<button disabled={locked} onClick={async()=>{setBusy(true);try{setHistory(await api('list',{target,offset:history.nextOffset}))}catch(error){setError(error.message)}finally{setBusy(false)}}}>更早报告</button>}
  {report&&<><p>报告对象：{label(report.target.section)} · {report.target.section==='consistency'&&report.target.id===0?'全书':`文档 ${report.target.id}`} · 版本 {deterministic?'检查时的当前正文':report.target.version_id??'场景计划'}{report.target.section==='manuscript'&&` · 范围 ${report.revisionTarget.start}–${report.revisionTarget.end}`}</p><p>{report.stale?'报告来源已变化；可保留判断记录，不能直接据此要求当前版本改稿。':'报告来源与当前目标一致。'} · {report.issues.length} 项建议</p>
   {!!report.rejected?.length&&<p role="alert">{report.rejected.length} 条意见因证据或格式不合格未登记：{report.rejected.map(item=>`第 ${item.index} 条：${item.error}`).join('；')}。原输出保留在任务记录中。</p>}
   {quality&&report.summary&&<section aria-label="章节质量指标"><p>估算 {report.summary.wordCount} 字 · {report.summary.paragraphCount} 段 · 对白占比 {Number((report.summary.dialogueRatio*100).toFixed(1))}% · 场景已采用 {report.summary.acceptedSceneCount}/{report.summary.sceneCount}</p>
    <p>章末信号：{report.summary.endingHookSignal?'已匹配':'未匹配'}</p>{report.summary.excerpt&&<blockquote>{report.summary.excerpt.quote}<small> · 文档 {report.summary.excerpt.anchor.document} · 版本 {report.summary.excerpt.anchor.version} · 位置 {report.summary.excerpt.anchor.start}–{report.summary.excerpt.anchor.end}</small></blockquote>}
    <details><summary>统计来源</summary>{report.summary.sources.map(s=><p key={s.document}>文档 {s.document} · 版本 {s.version}</p>)}</details></section>}
   {!quality&&report.summary&&<p>已检查 {report.summary.documents} 份正文、{report.summary.scenes} 张场景卡、{report.summary.facts} 条正式事实（当前可用 {report.summary.currentFacts} 条）、{report.summary.timeline} 条正式时间记录{report.summary.openForeshadowing===null?'':`、${report.summary.openForeshadowing} 条未回收伏笔`}。字面提及、同时事件和不同条件的事实都可能合理。</p>}
   {!report.issues.length&&<p>未报告问题不等于内容已正确或已经获得作者批准。</p>}
   {report.issues.map(item=><article key={item.id}><label><input type="checkbox" disabled={deterministic||locked||report.stale||item.status!=='open'} hidden={deterministic} checked={selected.includes(item.id)} onChange={event=>setSelected(event.target.checked?[...selected,item.id]:selected.filter(id=>id!==item.id))}/>{label(item.category)} · {label(item.severity)} · {label(item.status)}</label>
    <p>{item.message}</p>{Array.isArray(item.evidence)?item.evidence.map((evidence,index)=><blockquote key={index}>{evidence.quote}<small> · {label(evidence.label)} · {label(evidence.anchor.section)} · 记录 {evidence.anchor.id??evidence.anchor.document??''} · 版本 {evidence.anchor.version??'—'}{evidence.anchor.start!=null?` · 位置 ${evidence.anchor.start}–${evidence.anchor.end}`:''}</small></blockquote>):<blockquote>{item.evidence}</blockquote>}
    {item.suggestions.map((suggestion,index)=><p key={index}>建议：{suggestion}</p>)}
    <button disabled={locked} onClick={async()=>{setBusy(true);try{setDecisions({...decisions,[item.id]:await api('history',{id:item.id})})}catch(error){setError(error.message)}finally{setBusy(false)}}}>作者处理记录</button>
    {decisions[item.id]?.map(entry=><p key={entry.id}>{entry.created_at} · {label(entry.previous)} → {label(entry.issue.status)} · {entry.reason}</p>)}
    <button disabled={locked||!reason.trim()} onClick={()=>decide(item,'resolved')}>标记已处理</button><button disabled={locked||!reason.trim()} onClick={()=>decide(item,'dismissed')}>忽略建议</button><button disabled={locked||!reason.trim()||item.status==='open'} onClick={()=>decide(item,'open')}>重新打开</button>
   </article>)}
   <label>作者处理理由<input disabled={locked} value={reason} maxLength={2000} onChange={event=>setReason(event.target.value)}/></label>
   {!deterministic&&<button disabled={locked||report.stale||!selected.length} onClick={()=>onRevise({task:report.target.section==='decisions'?'ideas':report.target.section==='manuscript'?'polish':'scene-plan',target:report.revisionTarget,feedback:{run:report.run,issues:selected},initialContext:report.source.options})}>按已选问题要求改稿</button>}
  </>}
  {decision&&<section><p>将问题标记为 {label(decision.change.status)}。理由：{decision.change.reason}</p><button disabled={busy} onClick={confirm}>确认作者判断</button><button disabled={busy} onClick={()=>setDecision(null)}>返回</button></section>}
  {error&&<p role="alert">{error}</p>}<button disabled={busy} onClick={onClose}>返回原记录</button>
 </aside>
}
