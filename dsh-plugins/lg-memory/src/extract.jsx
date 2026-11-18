import React, { useEffect, useRef, useState } from 'react'
import { previewTask, runTask, cancelTask } from '../../lg-agents/src/client-task.js'

export function MemoryExtract({ path, documents, request, onClose, onSaved }) {
  const [source, setSource] = useState(null), [range, setRange] = useState({ start: 0, end: 0 })
  const [requirement, setRequirement] = useState('提取原文明示、后续写作值得记住的事实。排除猜测、人物谎言和尚未发生的计划。')
  const [preview, setPreview] = useState(null), [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const active = useRef(null)
  useEffect(() => () => active.current?.abort(), [])
  async function load(document) {
    setBusy(true); setError(''); setSource(null); setPreview(null); setResult(null)
    try {
      const value = await request('memory', { action: 'extraction-source', path, document })
      setSource(value); setRange({ start: 0, end: value.text.length <= 12000 ? value.text.length : 0 })
    } catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  async function prepare() {
    setBusy(true); setError('')
    try {
      const task = { task: 'extract-memory', path, request: requirement, operation: crypto.randomUUID(),
        target: { document: source.document, version: source.version, token: source.token, ...range } }
      setPreview(await previewTask(request, task))
    } catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  async function run() {
    setBusy(true); setError(''); const controller = new AbortController(); active.current = controller
    try {
      const value = await runTask(request, preview, controller.signal)
      if (!controller.signal.aborted) setResult(value)
    } catch (error) { if (!controller.signal.aborted) setError(error.message + '；可用本次操作重新读取结果。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <aside><h2>从已采纳正文提取记忆</h2><p>最多 8 条待审事实，附精确版本原文证据。人物所说、所想未必真实；提案仍需逐条核对，不自动成为正式事实。</p>
    <label>章节或场景<select value={source?.document ?? ''} disabled={busy || !!preview} onChange={event => { if (event.target.value) void load(Number(event.target.value)) }}>
      <option value="">选择已采纳正文</option>{documents.filter(doc => ['chapter', 'scene'].includes(doc.kind) && ['accepted', 'final'].includes(doc.state)).map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>
    {source && <><p>在下方圈选范围；未圈选时使用整段（最多 12000 字）。当前范围 {range.start}–{range.end}，共 {range.end - range.start} 个字符。</p>
      <textarea aria-label="提取来源正文" readOnly disabled={busy || !!preview} value={source.text} style={{ minHeight: 180 }} onSelect={event => {
        const { selectionStart: start, selectionEnd: end } = event.currentTarget
        if (end > start) setRange({ start, end })
      }}/>
      <label>本次提取要求<textarea value={requirement} maxLength={2000} disabled={busy || !!preview} onChange={event => setRequirement(event.target.value)}/></label>
      {!preview && <button disabled={busy || range.end <= range.start || range.end - range.start > 12000 || !requirement.trim()} onClick={prepare}>预览材料与费用</button>}</>}
    {preview && <><p>{preview.plan.provider} / {preview.plan.model} · 输入 {preview.plan.inputBytes} 字节 · 预留上限 ¥{preview.plan.reservedCny.toFixed(6)}</p>
      <details><summary>查看完整模型输入</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview.plan.modelInput.system + '\n\n' + preview.plan.modelInput.input}</pre></details>
      {!result && <button disabled={busy} onClick={run}>生成待审提案</button>}
      {busy && <button onClick={() => cancelTask(request, preview).catch(error => setError(error.message))}>取消生成</button>}
      <button disabled={busy} onClick={() => { setPreview(null); setResult(null) }}>调整要求／新任务</button></>}
    {result && <><p>{result.status === 'memory-ready' ? `已保存 ${result.extraction.proposals.length} 条待审提案，正式事实未改变。` : result.validationError ?? result.candidateError ?? '生成未完成，未保存提案。'}</p>
      {result.run?.result?.elapsedMs != null && <small>模型调用 {result.run.result.elapsedMs} ms</small>}
      {result.status === 'memory-ready' && <button onClick={onSaved}>查看并逐条审阅</button>}</>}
    {error && <p role="alert">{error}</p>}<button disabled={busy} onClick={onClose}>关闭提取</button>
  </aside>
}
