import React, { useEffect, useRef, useState } from 'react'
import { ContextPicker } from '../../lg-review/src/context-picker.jsx'
import { ReferencePicker } from '../../lg-review/src/reference-picker.jsx'
async function request(input, signal) {
  const response = await fetch('api/lg/agents', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const result = await response.json(); if (!result.ok) throw new Error(result.error); return result.value
}
export function GeneratePlan({ path, task, target: initialTarget, documents, feedback = null, initialContext = null, onClose }) {
  const [target, setTarget] = useState(initialTarget), [instruction, setInstruction] = useState(feedback ? '针对作者选中的问题修改，保留无关内容和既有约束。' : ''), [role, setRole] = useState('')
  const [roles, setRoles] = useState([]), [context, setContext] = useState(initialContext), [references, setReferences] = useState([])
  const [preview, setPreview] = useState(null), [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const active = useRef(null)
  useEffect(() => {
    const controller = new AbortController()
    request({ action: 'roles' }, controller.signal).then(setRoles).catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => { controller.abort(); if (active.current) { active.current.controller.abort(); void request({ action: 'cancel', operation: active.current.id }).catch(() => {}) } }
  }, [])
  async function prepare() {
    setBusy(true); setError(''); setResult(null)
    const input = { task, path, target, request: instruction, role: role || undefined, context,
      references: references.map(item => item.citation), ...(feedback ? { feedback } : {}), operation: crypto.randomUUID() }
    try { setPreview({ input, value: await request({ ...input, action: 'preview' }) }) }
    catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  async function run() {
    const controller = new AbortController(); active.current = { controller, id: preview.input.operation }
    setBusy(true); setError('')
    try { setResult(await request({ ...preview.input, action: 'run', signature: preview.value.signature }, controller.signal)); setPreview(null) }
    catch (error) { setError('结果未确认：' + error.message + '。可用同一任务重试。') }
    finally { active.current = null; setBusy(false) }
  }
  async function cancel() { try { await request({ action: 'cancel', operation: active.current.id }) } catch (error) { setError(error.message) } }
  const changeTopic = (key, value) => setTarget({ ...target, topic: { ...target.topic, [key]: value } })
  return <aside><h2>{task === 'ideas' ? '文学 Agent · 三方案构思' : '文学 Agent · 场景计划'}</h2>
    <p>一次有界生成，只保存待审内容。当前方向选择、已批准计划和正文不会被自动替换。</p>
    {!preview && !result && <fieldset disabled={busy}>
      {task === 'ideas' && <fieldset disabled={target.expected_version_id !== 0}>
        <label>方向标题<input value={target.title} maxLength={200} onChange={event => setTarget({ ...target, title: event.target.value })}/></label>
        <label>唯一标识<input value={target.slug} maxLength={200} onChange={event => setTarget({ ...target, slug: event.target.value })}/></label>
        <label>范围<select value={target.topic.scope} onChange={event => setTarget({ ...target, topic: { ...target.topic, scope: event.target.value, document_id: null } })}><option value="work">全书</option><option value="part">卷</option><option value="chapter">章节</option></select></label>
        {target.topic.scope !== 'work' && <label>目标<select value={target.topic.document_id ?? ''} onChange={event => changeTopic('document_id', Number(event.target.value))}><option value="">请选择</option>{documents.filter(doc => doc.kind === target.topic.scope).map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>}
        <label>主题标识<input value={target.topic.key} maxLength={200} onChange={event => changeTopic('key', event.target.value)}/></label>
      </fieldset>}
      <label>专家<select value={role} onChange={event => setRole(event.target.value)}><option value="">任务默认专家</option>{roles.filter(role => role.enabled && role.tasks.includes(task)).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
      <label>作者要求<textarea aria-label="规划生成要求" value={instruction} maxLength={2000} onChange={event => setInstruction(event.target.value)}/></label>
      <ContextPicker path={path} value={context} onChange={setContext} disabled={busy}/>
      <p>目标卷／章或场景设计会自动绑定为来源；完整输入在下一步显示。规划使用作者材料。</p>
      <ReferencePicker path={path} selected={references} onChange={setReferences} disabled={busy}/>
      <button disabled={!instruction.trim()} onClick={prepare}>预览输入与预算</button>
    </fieldset>}
    {preview && <><p>{preview.value.provider} / {preview.value.model} · 预留 ¥{preview.value.reservedCny.toFixed(4)} · {preview.value.inputBytes} 字节输入</p>
      <p>上下文 {preview.value.context.sources.length} 项，遗漏 {preview.value.context.omitted.length} 项。{preview.value.context.warnings.join(' ')}</p>
      <details><summary>完整模型输入</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{preview.value.modelInput.system + '\n\n' + preview.value.modelInput.input}</pre></details>
      <button disabled={busy} onClick={run}>{busy ? '正在生成…' : '确认执行生成'}</button>
      {busy ? <button onClick={cancel}>取消任务</button> : <button onClick={() => setPreview(null)}>返回调整</button>}</>}
    {result && <div role="status"><p>任务 {result.run?.id} · {result.status} · {result.run?.result?.elapsedMs ?? 0} ms</p>
      <p>{result.validationError || result.candidateError || result.run?.result?.error || ''}</p>
      {(result.output?.options ?? result.proposal?.options)?.map(option => <article key={option.id}><h3>{option.title}</h3><p>{option.content}</p></article>)}
      {(result.output?.plan || result.proposal?.metadata?.lg_plan_proposal?.plan) && <p>{result.output?.plan ?? result.proposal.metadata.lg_plan_proposal.plan}</p>}
      {result.proposal && <p>已保存待审规划。返回记录后，单独选择方案或审阅批准场景计划。</p>}
      <details><summary>本次用量</summary><pre>{JSON.stringify({ usage: result.run?.result?.usage, reservedCny: result.run?.reservedCny, estimatedCny: result.run?.result?.estimatedCny }, null, 2)}</pre></details>
      {!result.proposal && <button onClick={() => setResult(null)}>调整后重新预览新任务</button>}
    </div>}
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={onClose}>{result?.proposal ? '返回规划记录审阅' : '关闭生成面板'}</button>
  </aside>
}
