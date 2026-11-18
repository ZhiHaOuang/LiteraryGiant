import React, { useEffect, useRef, useState } from 'react'
import { ContextPicker } from '../../lg-workbench/src/context-picker.jsx'
import { ReferencePicker } from '../../lg-workbench/src/reference-picker.jsx'
import { SequencePicker, CandidateDecision, sceneStepLabel } from './sequence-panel.jsx'
import {ChapterPicker} from './chapter-picker.jsx'
import {IdeaOptions} from './idea-options.jsx'
import {RunHistory} from './run-history.jsx'
import { RuleFields, rulesInput, CheckResult } from '../../lg-review/src/rule-fields.jsx'
export const inject = ['slots']
const states={ready:'待下一步',running:'执行中或待恢复','awaiting-direction':'等待作者选定方向','awaiting-scene':'等待作者处理场景','awaiting-chapter':'等待作者处理章节','awaiting-author':'等待作者审阅',stopped:'已停止',closed:'作者已结束'}
async function request(endpoint,input,signal) {
  const response=await fetch(`api/lg/${endpoint}`,{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify(input)})
  const result=await response.json();if(!result.ok)throw new Error(result.error??'请求失败');return result.value
}
function Workflow({returnTo,getEditor,remember}) {
  const [books,setBooks]=useState([]),[path,setPath]=useState(''),[chapters,setChapters]=useState([]),[body,setBody]=useState(null),[range,setRange]=useState({start:0,end:0})
  const [scenes,setScenes]=useState([]),[carry,setCarry]=useState(true)
  const [batch,setBatch]=useState([])
  const [kind,setKind]=useState('revision')
  const [direction,setDirection]=useState(null),[pendingChoice,setPendingChoice]=useState(null)
  const [ideas,setIdeas]=useState(false),[ideaRequest,setIdeaRequest]=useState('为本章提出三个不同的剧情方向，说明人物的选择和代价。')
  const [fields,setFields]=useState({}),[checks,setChecks]=useState(null),[selectedChecks,setSelectedChecks]=useState([])
  const [instruction,setInstruction]=useState('改善选区的表达与衔接，保留情节和人物意图。'),[reviewRequest,setReviewRequest]=useState('审阅修订后的因果、人物行动和表达，引用具体证据。')
  const [calls,setCalls]=useState(4),[ceiling,setCeiling]=useState('0.2'),[context,setContext]=useState(null),[references,setReferences]=useState([])
  const [flows,setFlows]=useState({items:[]}),[flow,setFlow]=useState(null),[preview,setPreview]=useState(null),[step,setStep]=useState(null),[report,setReport]=useState(null),[issues,setIssues]=useState([]),[candidate,setCandidate]=useState(null)
  const [revision,setRevision]=useState('只修正已选问题，保留无关内容。'),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const active=useRef(null)
  const api=(action,input={},signal)=>request('workflows',{path,action,...input},signal)
  async function work(fn){setBusy(true);setError('');try{await fn()}catch(error){setError(error.message)}finally{setBusy(false)}}
  async function loadBook(nextPath,document,version){
    setDirection(null);setIdeas(false);setPendingChoice(null)
    setFields({});setChecks(null);setSelectedChecks([])
    setBatch([]);setScenes([]);setBody(null);setPath(nextPath);setFlow(null);setPreview(null);setStep(null);setReport(null);setCandidate(null);setContext(null);setReferences([])
    const book=await request('books',{action:'read',path:nextPath});setChapters(book.chapters)
    const id=document??book.chapters[0]?.id
    const value=id?await request('books',{action:'manuscript',path:nextPath,document:id,version}):null
    setBody(value);setRange({start:0,end:value?.selected.content.length??0})
    setFlows(await request('workflows',{action:'list',path:nextPath}))
  }
  useEffect(()=>{void work(async()=>{
    const list=await request('books',{action:'list'});setBooks(list)
    const book=list.find(b=>!b.error&&b.path===returnTo?.path)??list.find(b=>!b.error)
    if(!book)return
    if(returnTo&&book.path!==returnTo.path)throw new Error('目标作品已不在当前作品列表中。')
    await loadBook(book.path,returnTo?.chapter)
    if(returnTo?.direction){
      setKind('chapter');setDirection(returnTo.direction);setInstruction('根据作者选定的方向，写出本章完整候选正文。')
    }else if(returnTo?.id)await show(await request('workflows',{path:book.path,action:'read',id:returnTo.id}),book.path)
  });return()=>active.current?.abort()},[])
  async function show(value,bookPath=path){
    if((value.definition.chapters&&!value.chapterDecisions&&!value.chapterProgressError)||(value.status==='awaiting-direction'&&!value.choice&&!value.choiceError))value=await request('workflows',{path:bookPath,action:'read',id:value.id})
    setChecks(null);setSelectedChecks([])
    setPendingChoice(null);setFlow(value);setPreview(null);setStep(null);setIssues([]);setReport(null);setCandidate(null)
    const last=value.steps.at(-1)
    if(last?.result?.report)setReport(await request('review',{action:'read',path:bookPath,run:last.result.report.run}))
    const generated=value.steps.findLast(item=>item.result?.candidate)
    if(generated)setCandidate(await request('books',{action:'manuscript',path:bookPath,document:generated.task.document,version:generated.result.candidate.version}))
    if(generated&&value.definition.rules) {
      try { setChecks(await request('workflows',{path:bookPath,action:'checks',id:value.id})) }
      catch (error) { setError(error.message) }
    }
    setFlows(await request('workflows',{path:bookPath,action:'list'}))
  }
  function openCandidate() {
    remember({path,id:flow.id})
    try {getEditor().openVersion(path,candidate.document.id,candidate.selected.id)}
    catch(error){remember(null);setError(error.message)}
  }
  async function showFromServer(){await show(await api('read',{id:flow.id}))}
  async function prepare(){
    const input={kind,...(kind==='chapters'?{chapters:batch,carryPrevious:carry}:kind==='scenes'?{scenes,carryPrevious:carry}:{}),source:{document:body.document.id,version:body.selected.id,token:body.token,...(kind==='chapter'?{start:0,end:body.selected.content.length}:range)},request:instruction,reviewRequest,context,references:references.map(item=>item.citation),limits:{maxCalls:kind==='chapters'?batch.length:kind==='scenes'?scenes.length:calls,maxReservedCny:Number(ceiling)}}
    const rules=rulesInput(fields)
    if(direction){
      if(kind!=='chapter'||direction.chapter!==body.document.id||context?.audience&&context.audience!=='author'||context?.decisions||context?.chapter&&context.chapter!==direction.chapter)
        throw new Error('此方向已绑定目标章，请使用作者视角，并关闭额外的方向汇总。')
      input.context={...context,chapter:direction.chapter,direction:direction.pin}
    }
    if(kind==='chapter'&&Object.keys(rules).length)input.rules=rules
    if(kind==='chapter'&&ideas)input.ideas={id:crypto.randomUUID(),request:ideaRequest}
    setPreview({input,...await api('preview',{input}),id:crypto.randomUUID()})
  }
  async function prepareStep(ruleFeedback){
    const feedback=ruleFeedback??(flow.status==='awaiting-author'?{issues,request:revision}:undefined)
    setStep({...await api('next-preview',{id:flow.id,feedback}),feedback})
  }
  async function execute(){
    const controller=new AbortController();active.current=controller
    try{await show(await api('advance',{id:flow.id,feedback:step.feedback,token:step.token},controller.signal))}finally{active.current=null}
  }
  const chapterDecisions=flow?.chapterDecisions??[]
  const handled=chapterDecisions.length>0&&chapterDecisions.every(d=>d.status!=='pending')
  const flowStatus=flow?.status==='awaiting-chapter'&&handled
    ? (chapterDecisions.length===flow.definition.chapters.length?'本批章节已处理':'可起草下一章') : states[flow?.status]
  const queue=flow?.definition.scenes
  const chapterTitle=queue&&flow.definition.parts.find(part=>part.id===flow.definition.chapter)?.title
  const locked=busy||!!preview||!!step||!!pendingChoice
  const canRepair=flow?.status==='ready'&&!!flow.steps.at(-1)?.result?.candidate&&flow.steps.length<flow.definition.limits.maxCalls
  return <main className="lgf"><style>{`
    .lgf{padding:28px;max-width:1100px;margin:auto;height:100%;overflow:auto}.lgf input,.lgf select,.lgf textarea,.lgf button{padding:8px;margin:5px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit}
    .lgf textarea{display:block;width:95%;min-height:90px}.lgf article,.lgf aside{border:1px solid #8884;padding:16px;margin:16px 0;border-radius:10px}.lgf pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto}.lgf [role=alert]{color:#c96551}.lgf button:disabled{opacity:.5}.lgf small{opacity:.7}
  `}</style><small>LITERARYGIANT</small><h1>文学工作流</h1><p>每步执行前可查看模型输入与预算。已保存的流程可以继续。</p>
    <label>作品<select value={path} disabled={locked} onChange={event=>work(()=>loadBook(event.target.value))}><option value="">请选择作品</option>{books.map(book=><option key={book.path} value={book.path} disabled={!!book.error}>{book.name??book.path}</option>)}</select></label>
    <label>已保存流程<select value={flow?.id??''} disabled={locked} onChange={event=>event.target.value?work(async()=>show(await api('read',{id:event.target.value}))):setFlow(null)}><option value="">新建流程</option>{flow&&!flows.items.some(item=>item.id===flow.id)&&<option value={flow.id}>{flow.title} · {states[flow.status]}</option>}{flows.items.map(item=><option key={item.id} value={item.id}>{item.title} · {states[item.status]}</option>)}</select></label>
    {flows.nextOffset!=null&&<button disabled={locked} onClick={()=>work(async()=>{const next=await api('list',{offset:flows.nextOffset});setFlows({items:[...flows.items,...next.items],nextOffset:next.nextOffset})})}>加载更早流程</button>}
    {path&&<RunHistory key={path} path={path} api={api} getEditor={getEditor} disabled={locked}/>}
    {!flow&&body&&<fieldset disabled={locked}>
      {direction&&<aside><strong>按已选方向起草 · {direction.title}</strong><p>{direction.content}</p>
        <button onClick={()=>setDirection(null)}>解除本次起草的方向关联</button></aside>}
      <label>流程<select disabled={!!direction} value={kind} onChange={event=>{setKind(event.target.value);if(event.target.value==='scenes'&&body.document.kind==='scene')void work(()=>loadBook(path,body.parts.find(part=>part.kind==='chapter').id));setInstruction(event.target.value==='chapters'?'按本章要求起草整章，衔接前章已确认的情节。':event.target.value==='scenes'?'按批准计划逐场起草，保持人物行动和场景衔接。':event.target.value==='chapter'?'按所选方向、大纲和本次要求生成本章完整候选正文。':'改善选区的表达与衔接，保留情节和人物意图。')}}><option value="revision">选区修订—审阅—反馈</option><option value="chapter">整章生成—审阅—反馈</option><option value="scenes">按场景顺序起草</option><option value="chapters">按章节顺序起草</option></select></label>
      {kind!=='chapters'&&<label>章节<select disabled={!!direction} value={body.parts.find(part=>part.kind==='chapter')?.id??''} onChange={event=>work(()=>loadBook(path,Number(event.target.value)))}>{chapters.map(chapter=><option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select></label>}
      {kind==='chapters'?<ChapterPicker chapters={chapters} items={batch} change={setBatch} carry={carry} setCarry={setCarry}/>:kind==='scenes'?<SequencePicker path={path} chapter={body.parts.find(p=>p.kind==='chapter').id} request={request} scenes={scenes} setScenes={setScenes} carry={carry} setCarry={setCarry}/>:<><nav>{body.parts.map(part=><button key={part.id} disabled={!!direction} onClick={()=>work(()=>loadBook(path,part.id))}>{part.kind==='scene'?'场景':'章'} · {part.title}</button>)}</nav>
      <label>版本<select disabled={!!direction} value={body.selected.id} onChange={event=>work(()=>loadBook(path,body.document.id,Number(event.target.value)))}>{body.versions.map(version=><option key={version.id} value={version.id}>v{version.version_number} · {version.state}</option>)}</select></label>
      {kind==='chapter'?<p>使用当前章节的完整正文版本；空章可起草。仅处理章节文档，不拼接或修改子场景。完整输入超限时停止，不静默截断。</p>:<p>在正文中圈选本次范围。当前 {range.start}–{range.end}，未圈选时使用全文；超出模型输入上限时请缩小。</p>}
      <textarea aria-label="工作流原文选区" readOnly value={body.selected.content} onSelect={event=>{const {selectionStart:start,selectionEnd:end}=event.currentTarget;if(kind==='revision'&&end>start)setRange({start,end})}}/></>}
      {kind==='chapter'&&<details><summary>整章正文规则（可选）</summary><p>规则随首次模型输入保存。每版候选按整章正文逐字检查。</p><RuleFields fields={fields} onChange={setFields}/></details>}
      {kind==='chapter'&&!direction&&<label><input type="checkbox" checked={ideas} onChange={e=>setIdeas(e.target.checked)}/>先生成三个方向，再由我选择</label>}
      {kind==='chapter'&&ideas&&<label>构思要求<textarea value={ideaRequest} maxLength={2000} onChange={e=>setIdeaRequest(e.target.value)}/></label>}
      <label>{kind==='chapters'?'跨章共同要求':kind==='scenes'?'各场起草要求':kind==='chapter'?'整章创作要求':'修订要求'}<textarea value={instruction} maxLength={2000} onChange={event=>setInstruction(event.target.value)}/></label>
      {!['scenes','chapters'].includes(kind)&&<><label>每次审阅要求<textarea value={reviewRequest} maxLength={2000} onChange={event=>setReviewRequest(event.target.value)}/></label>
      <label>最多调用次数<input type="number" min="2" max="6" value={calls} onChange={event=>setCalls(Number(event.target.value))}/></label></>}
      <label>本流程预留上限（元）<input type="number" min="0.001" max="100" step="0.01" value={ceiling} onChange={event=>setCeiling(event.target.value)}/></label>
      <ContextPicker path={path} value={context} onChange={setContext} disabled={locked}/><ReferencePicker path={path} selected={references} onChange={setReferences} disabled={locked}/>
      <button disabled={!instruction.trim()||!['scenes','chapters'].includes(kind)&&!reviewRequest.trim()||kind==='scenes'&&scenes.length<2||(kind==='chapters'?batch.length<2||batch.some(c=>!c.request.trim()):kind==='revision'?range.end<=range.start:body.document.kind!=='chapter'||body.selected.id!==body.document.activeVersion)} onClick={()=>work(prepare)}>预览并冻结流程</button>
    </fieldset>}
    {preview&&<aside><p>首次输入 {preview.plan.inputBytes} 字节，预留 ¥{preview.plan.reservedCny.toFixed(6)}。最多 {preview.definition.limits.maxCalls} 次调用，总预留不超过 ¥{ceiling}，同时受执行器累计预算约束。</p>
      {preview.definition.chapters&&<ol>{preview.definition.chapters.map(c=><li key={c.document}>{c.title} · {c.request}</li>)}</ol>}
      <details><summary>首次完整模型输入</summary><pre>{preview.plan.modelInput.system+'\n\n'+preview.plan.modelInput.input}</pre></details>
      <button disabled={busy} onClick={()=>work(async()=>show(await api('create',{input:preview.input,token:preview.token,id:preview.id})))}>保存流程，暂不调用模型</button><button disabled={busy} onClick={()=>setPreview(null)}>返回修改</button>
    </aside>}
    {flow&&<><h2>{queue?chapterTitle+' · 逐场起草':flow.title}</h2>{queue&&<><p>起草顺序　{queue.map(scene=>scene.title).join(' → ')}</p><details><summary>本批创作要求</summary><p>{flow.definition.request}</p></details></>}<p>{flowStatus} · 已登记 {flow.steps.length}/{flow.definition.limits.maxCalls} 次调用 · 累计预留 ¥{(flow.reservedMicros/1e6).toFixed(6)} / ¥{(flow.definition.limits.maxReservedMicros/1e6).toFixed(6)}</p>
      {flow.definition.chapters&&<ol aria-label="本批章节">{flow.definition.chapters.map(c=><li key={c.document}>{c.title} · {c.request}</li>)}</ol>}
      {flow.reason&&<p>{flow.reason}</p>}{flow.recoveryMessage&&<p role="alert">{flow.recoveryMessage}</p>}
      {flow.chapterProgressError&&<p role="alert">{flow.chapterProgressError}</p>}
      {flow.currentCallError&&<p>本机调用账本不可用：{flow.currentCallError}</p>}
      {flow.steps[0]?.result?.proposal&&<IdeaOptions key={flow.id} flow={flow} api={api} work={work} reload={showFromServer} disabled={busy||!!step} pending={pendingChoice} setPending={setPendingChoice}/>}
      <button disabled={busy} onClick={()=>work(async()=>show(await api('read',{id:flow.id})))}>刷新状态</button>
      <button disabled={busy} onClick={()=>work(async()=>show(await api('recover',{id:flow.id})))}>恢复已完成的原调用</button>
      {!['stopped','closed'].includes(flow.status)&&<button onClick={()=>request('workflows',{action:'read',path,id:flow.id}).then(current=>api('stop',{id:flow.id,token:current.token})).then(show).catch(error=>setError(error.message))}>停止后续步骤</button>}
      <button disabled={busy||flow.status==='running'||flow.status==='closed'} onClick={()=>work(async()=>show(await api('close',{id:flow.id,token:flow.token})))}>结束此流程</button>
      {flow.steps.map((item,index)=><article key={item.task.operation}><h3>{queue?`第 ${index+1} 场 · ${queue[index].title} · ${sceneStepLabel(item,candidate)}`:flow.definition.chapters?`${flow.definition.chapters[index].title} · ${({accepted:'正文已采用',rejected:'候选已拒绝',pending:'待审候选'})[chapterDecisions[index]?.status]??item.status}`:`第 ${index+1} 步 · ${item.task.task} · ${item.status}`}</h3><p>{item.result?.error??item.error??''}</p>
        <small>调用 {item.task.operation} · {item.result?.call?.elapsedMs??'—'} ms · 输入 {item.plan.inputBytes} 字节 · 预留 ¥{(item.reservedMicros/1e6).toFixed(6)}</small>
        <details><summary>本步完整输入与结果摘要</summary><pre>{item.plan.modelInput.system+'\n\n'+item.plan.modelInput.input}</pre><pre>{JSON.stringify(item.result,null,2)}</pre></details>
      </article>)}
      {candidate&&(queue||flow.definition.chapters)&&<CandidateDecision key={flow.id+':'+candidate.selected.id+':'+candidate.selected.state} path={path} candidate={candidate} range={flow.steps.at(-1)?.plan.wordRange} request={request} disabled={locked||flow.status==='closed'||flow.status==='stopped'} onBusy={setBusy} onDone={showFromServer}/> }
      {candidate&&!queue&&!flow.definition.chapters&&<details><summary>最新候选 v{candidate.selected.version_number}（当前正文未自动采用）</summary><pre>{candidate.selected.content}</pre></details>}
      {candidate&&getEditor()&&<button disabled={locked} onClick={openCandidate}>在文学编辑台打开此版本</button>}
      {checks&&<aside><h3>整章候选规则检查</h3><CheckResult result={checks} selection={selectedChecks} onSelect={canRepair?setSelectedChecks:undefined} disabled={locked}/>
        {canRepair&&checks.passed===false&&<button disabled={locked||!selectedChecks.length} onClick={()=>work(()=>prepareStep({version:checks.target.version,checks:selectedChecks}))}>预览按勾选规则改稿</button>}
      </aside>}
      {report&&<aside><h3>选择本次改稿问题</h3><p>{report.stale?'报告来源已变化，不能继续改稿。':`${report.issues.length} 项建议。未报告问题不代表已获作者认可。`}</p>
        {report.issues.map(issue=><article key={issue.id}><label><input type="checkbox" disabled={locked||report.stale||issue.status!=='open'} checked={issues.includes(issue.id)} onChange={event=>setIssues(event.target.checked?[...issues,issue.id]:issues.filter(id=>id!==issue.id))}/>{issue.category} · {issue.message}</label>
          {Array.isArray(issue.evidence)&&issue.evidence.map((evidence,index)=><blockquote key={index}>{evidence.quote}</blockquote>)}{issue.suggestions.map((suggestion,index)=><p key={index}>{suggestion}</p>)}</article>)}
        <label>本次改稿要求<textarea value={revision} maxLength={2000} disabled={locked} onChange={event=>setRevision(event.target.value)}/></label>
      </aside>}
      {!step&&!pendingChoice&&flow.steps.length<flow.definition.limits.maxCalls&&['ready','awaiting-author','awaiting-scene','awaiting-direction','awaiting-chapter'].includes(flow.status)&&!(flow.definition.scenes&&flow.steps.length>=flow.definition.scenes.length)&&<button disabled={busy||!!flow.chapterProgressError||flow.status==='awaiting-chapter'&&!handled||flow.status==='awaiting-direction'&&!flow.choice?.option||flow.status==='awaiting-author'&&(!issues.length||report?.stale)} onClick={()=>work(prepareStep)}>预览下一步</button>}
      {step&&<aside><h3>下一步 · {step.task.task}</h3><p>输入 {step.plan.inputBytes} 字节 · 预留 ¥{step.plan.reservedCny.toFixed(6)}</p><details><summary>完整模型输入</summary><pre>{step.plan.modelInput.system+'\n\n'+step.plan.modelInput.input}</pre></details>
        <button disabled={busy} onClick={()=>work(execute)}>执行这一步</button><button disabled={busy} onClick={()=>setStep(null)}>返回</button></aside>}
    </>}{error&&<p role="alert">{error}</p>}
  </main>
}
export function apply(ctx) {
  let returnTo
  ctx.inject(['layout'],scope=>scope.provide('literaryWorkflowPanel',{
    draftFromDirection(path,chapter,item){
      const {options_version_id,option_id,title,content}=item.selection
      const pin={document_id:item.document_id,options_version_id,option_id}
      returnTo={path,chapter,direction:{chapter,pin,title,content}}
      try{scope.layout.selectPanel('lg-workflows')}catch(error){returnTo=null;throw error}
    },
  }))
  function Panel() {
    const [target]=useState(()=>returnTo)
    useEffect(()=>{if(returnTo===target)returnTo=null},[target])
    return <Workflow returnTo={target} remember={value=>{returnTo=value}} getEditor={()=>ctx.get('literaryWorkbench')}/>
  }
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'lg-workflows'},Panel))
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'lg-workflows',order:21,label:()=>'文学工作流'},()=> <span aria-hidden="true">⇢</span>))
}
