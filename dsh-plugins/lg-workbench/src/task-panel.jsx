import React, { useEffect, useRef, useState } from 'react'
import { ContextPicker } from './context-picker.jsx'
import { ReferencePicker } from './reference-picker.jsx'

async function agentRequest(input, signal) {
  const response = await fetch('api/lg/agents', { method: 'POST', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const result = await response.json()
  if (!result.ok) throw new Error(result.error ?? '文学 Agent 请求失败')
  return result.value
}
export function TaskPanel({ path, data, range, disabled, lock, openCandidate, onReview, feedback, clearFeedback }) {
  const [task, setTask] = useState('polish'), [role, setRole] = useState('')
  const [roles, setRoles] = useState([]), [request, setRequest] = useState(feedback ? '只处理选中的审阅问题，保留无关内容；不添加新事实。' : '')
  const [preview, setPreview] = useState(null), [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [references, setReferences] = useState([]), [context, setContext] = useState(null)
  useEffect(() => { setReferences([]); setContext(feedback?.initialContext ?? null) }, [path])
  const [methods, setMethods] = useState([]), [method, setMethod] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setMethod('')
    setMethods([])
    agentRequest({action:'methods',task},controller.signal).then(items => {
      if (!controller.signal.aborted) setMethods(items)
    }).catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => controller.abort()
  }, [task])
  const active = useRef(null)
  useEffect(() => {
    const controller = new AbortController()
    agentRequest({ action: 'roles' }, controller.signal).then(setRoles).catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => {
      controller.abort()
      if (active.current) { active.current.controller.abort(); void agentRequest({ action: 'cancel', operation: active.current.id }).catch(() => {}) }
    }
  }, [])
  async function prepare() {
    setError(''); setResult(null); setBusy(true); lock(true)
    const input = { task, ...(method ? {method} : {}), role: role || undefined, path, document: data.document.id, version: data.selected.id,
      token: data.token, ...(task === 'draft-chapter' ? { start: 0, end: data.selected.content.length } : range), request, context, ...(feedback ? { feedback: feedback.feedback } : {}), references: references.map(item => item.citation), operation: crypto.randomUUID() }
    try { setPreview({ input, value: await agentRequest({ action: 'preview', ...input }) }) }
    catch (error) { setError(error.message); lock(false) }
    finally { setBusy(false) }
  }
  async function run() {
    const controller = new AbortController(), id = preview.input.operation
    active.current = { controller, id }; setBusy(true); setError('')
    try {
      setResult(await agentRequest({ ...preview.input, action: 'run', signature: preview.value.signature }, controller.signal))
      setPreview(null); lock(false)
    } catch (error) { setError('请求结果未确认：' + error.message + '。重试会使用相同任务 ID。') }
    finally { active.current = null; setBusy(false) }
  }
  async function cancel() {
    try { await agentRequest({ action: 'cancel', operation: active.current.id }) }
    catch (error) { setError(error.message) }
  }
  return <section className="lgw-confirm">
    <h3>文学 Agent · {task === 'draft-scene' ? '场景起草' : task === 'draft-chapter' ? '整章生成' : '选区任务'}</h3>{task === 'draft-scene' ? <p>按已批准计划起草整个空场景，只保存候选；本次不使用选区范围。</p> : task === 'draft-chapter' ? <p>生成当前章节的完整候选正文；空章可起草，已有正文可重写。子场景与其他章节保持原样。</p> : <p>范围 {range.start}–{range.end}，基于版本 ID {data.selected.id}。生成结果仅保存为候选；审阅不修改正文。</p>}
    {!preview && <fieldset disabled={disabled || busy} className="lgw-fieldset">
      <div className="lgw-toolbar"><label>任务<select disabled={!!feedback} value={task} onChange={event => { setTask(event.target.value); setRole('') }}>
        <option value="polish">选区润色</option>{data.document.kind === 'chapter' && data.selected.id === data.document.activeVersion && <option value="draft-chapter">生成整章候选</option>}{!roles.some(role => role.enabled && role.tasks.includes('manuscript-review')) && <option value="review">临时证据审阅</option>}{data.document.kind === 'scene' && !data.document.content.trim() && data.selected.id === data.document.activeVersion && <option value="draft-scene">按批准计划起草空场景</option>}</select></label>
        <label>专家<select value={role} onChange={event => setRole(event.target.value)}><option value="">任务默认专家</option>
          {roles.filter(role => role.enabled && role.tasks.includes(task)).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label></div>
      {methods.length>0 && <label>文学方法<select value={method} onChange={event=>setMethod(event.target.value)}>
        <option value="">按本次要求执行</option>{methods.map(item=><option key={item.name} value={item.name}>{item.title}</option>)}
      </select>{method&&<small>{methods.find(item=>item.name===method)?.description}</small>}</label>}
      <label>本次要求<textarea aria-label="文学任务要求" className="lgw-task-request" value={request} maxLength={2000} onChange={event => setRequest(event.target.value)}/></label>
      <ContextPicker path={path} value={context} onChange={setContext} disabled={disabled || busy}/>
      <ReferencePicker path={path} selected={references} onChange={setReferences} disabled={disabled || busy}/>
      {feedback && <p>已绑定报告 {feedback.feedback.run.slice(0,8)} 的 {feedback.feedback.issues.length} 项意见；版本与选区已固定。<button onClick={clearFeedback}>退出按问题改稿</button></p>}
      {!feedback && roles.some(role => role.enabled && role.tasks.includes('manuscript-review')) && <button disabled={range.end <= range.start} onClick={onReview}>审阅此选区／查看已保存报告</button>}
      <button disabled={!request.trim() || !['draft-scene','draft-chapter'].includes(task) && range.end <= range.start} onClick={prepare}>预览模型输入</button>
    </fieldset>}
    {preview && <><p>{preview.value.provider} / {preview.value.model} · 本次预留 ¥{preview.value.reservedCny.toFixed(4)} · {preview.value.inputBytes} 字节输入</p>
      {preview.value.scope === 'chapter-body' && <p>范围为当前章节文档；其下 {preview.value.childScenes} 个子场景不参与拼接，也不会被改写。</p>}
      {!!preview.value.references?.length && <p>已绑定 {preview.value.references.length} 条参考资料；执行与采用前会重新校验来源。</p>}
      {preview.value.context && <p>文学上下文：{preview.value.context.payload.audience}，{preview.value.context.sources.length} 项材料，遗漏 {preview.value.context.omitted.length} 项。{preview.value.context.warnings.join(' ')}</p>}
      <details><summary>完整模型输入</summary><pre>{preview.value.modelInput.system + '\n\n' + preview.value.modelInput.input}</pre></details>
      <button disabled={busy} onClick={run}>{busy ? '正在执行…' : '确认执行文学任务'}</button>
      {busy ? <button onClick={cancel}>取消任务</button> : <button onClick={() => { setPreview(null); lock(false) }}>返回调整</button>}</>}
    {result && <div role="status"><p>任务 {result.run.id} · {result.status ?? result.run.status} · {result.run.result?.elapsedMs ?? 0} ms</p>
      <p>{result.run.result?.error || result.validationError || result.candidateError || ''}</p>
      {result.stale && <p>来源已经变化；这份报告只对应原版本。</p>}
      {result.output?.words != null && <p>正文 {result.output.words} 字／词，目标 {result.output.wordRange.min ?? '不限'}–{result.output.wordRange.max ?? '不限'}。{!result.output.inRange && '未达到场景字数目标，需要作者审阅调整。'}</p>}
      {result.output?.notes && <p>{result.output.notes}</p>}
      {result.candidate && <button onClick={() => openCandidate(result.candidate.version, result.candidate)}>打开候选进行比较</button>}
      {result.output?.issues?.map((issue, i) => <article key={i}><strong>{issue.category} · {issue.message}</strong>
        {issue.evidence.map((evidence, j) => <blockquote key={j}>{evidence.quote}<small> · 版本 {evidence.version} · {evidence.start}–{evidence.end}</small></blockquote>)}
        <p>{issue.suggestion}</p></article>)}
      {result.output?.issues?.length === 0 && <p>本次未报告问题；这不证明全书一致。</p>}
      <details><summary>用量与预算记录</summary><pre>{JSON.stringify({ usage: result.run.result?.usage, reservedCny: result.run.reservedCny, estimatedCny: result.run.result?.estimatedCny }, null, 2)}</pre></details>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>
}
