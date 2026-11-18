import React, { useEffect, useRef, useState } from 'react'
import { previewTask, runTask, cancelTask } from '../../lg-agents/src/client-task.js'

export const categoryNames = { EventsLibrary: '事件机制', PayoffAngst: '爽点与虐点', CharacterArc: '人物弧线', EmotionRhythm: '情绪节奏', Worldview: '世界规则' }
const states = { proposed: '待审', approved: '已批准', rejected: '已拒绝', withdrawn: '已撤回' }
export function Cards({ path, references, request, onClose }) {
  const [category, setCategory] = useState('EventsLibrary'), [requirement, setRequirement] = useState('提取来源支持的文学方法，明确可迁移机制与来源专属细节。')
  const [page, setPage] = useState(null), [selected, setSelected] = useState(null), [preview, setPreview] = useState(null), [result, setResult] = useState(null)
  const [reason, setReason] = useState(''), [decision, setDecision] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const active = useRef(null)
  const api = (action, input = {}, signal) => request('library', { path, action, ...input }, signal)
  async function work(fn) { setBusy(true);setError('');try { await fn() } catch (error) { setError(error.message) } finally { setBusy(false) } }
  async function list(offset = 0) { setPage(await api('cards', { offset })) }
  useEffect(() => { void work(() => list());return () => active.current?.abort() }, [path])
  async function prepare() {
    const task = { task: 'analyze-reference', path, category, references: references.map(hit => hit.citation), request: requirement, operation: crypto.randomUUID() }
    setPreview(await previewTask(request, task));setResult(null)
  }
  async function generate() {
    const controller = new AbortController();active.current = controller
    const value = await runTask(request, preview, controller.signal)
    setResult(value)
    if (value.card) { setSelected(value.card);setDecision(null);setReason('');await list() }
  }
  async function decide(action) {
    const change = { id: selected.id, action, reason }
    setDecision({ ...await api('card-preview', { change }), operation: crypto.randomUUID() })
  }
  return <section><h2>文学方法分析卡</h2><p>选择 1–3 条原始资料，每条最多分析 4000 个字符。生成结果先保存为待审卡；作者批准后，可复用方法才会进入检索。</p>
    <p>已选来源：{references.length ? references.map(hit => hit.id).join('、') : '未选择；可返回检索选择资料，或审阅已有卡片。'}</p>
    <label>分析类别 <select value={category} disabled={busy || !!preview} onChange={event => setCategory(event.target.value)}>{Object.entries(categoryNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label style={{ display: 'block' }}>分析要求<textarea aria-label="分析要求" value={requirement} maxLength={2000} disabled={busy || !!preview} onChange={event => setRequirement(event.target.value)} style={{ width: '100%', minHeight: 70 }}/></label>
    {!preview && <button disabled={busy || !references.length || !requirement.trim()} onClick={() => work(prepare)}>预览材料与费用</button>}
    {preview && <aside><p>{preview.plan.provider} / {preview.plan.model} · 输入 {preview.plan.inputBytes} 字节 · 预留上限 ¥{preview.plan.reservedCny.toFixed(6)}</p>
      {preview.plan.source.sources.some(source => source.truncated) && <p>部分来源超过上限，本次只分析预览中的片段。</p>}
      <details><summary>完整模型输入</summary><pre>{preview.plan.modelInput.system + '\n\n' + preview.plan.modelInput.input}</pre></details>
      {!result && <button disabled={busy} onClick={() => work(generate)}>生成待审分析卡</button>}
      {busy && <button onClick={() => cancelTask(request, preview).catch(error => setError(error.message))}>取消生成</button>}
      <button disabled={busy} onClick={() => { setPreview(null);setResult(null) }}>调整要求／新任务</button>
      {result && <p>{result.status === 'reference-ready' ? '分析卡已保存，尚需作者审阅。' : result.validationError ?? result.candidateError ?? `任务状态：${result.status}`}</p>}
    </aside>}
    <h3>已有分析卡</h3><button disabled={busy} onClick={() => work(() => list())}>刷新列表</button>
    {page && <><p>共 {page.total} 张</p>{page.items.map(card => <p key={card.id}><button disabled={busy} onClick={() => work(async () => { setSelected(await api('card', { id: card.id }));setDecision(null);setReason('') })}>{card.analysis.title}</button> · {categoryNames[card.category]} · {states[card.status]}{card.stale ? ' · 来源已过期' : ''}</p>)}
      <button disabled={busy || page.offset === 0} onClick={() => work(() => list(Math.max(0, page.offset - 20)))}>上一页</button><button disabled={busy || page.nextOffset == null} onClick={() => work(() => list(page.nextOffset))}>下一页</button></>}
    {selected && <article><h3>{selected.analysis.title} · {states[selected.status]}</h3><p>{selected.analysis.summary}</p>
      <p>{selected.stale ? '来源已变化或不可用，本卡不能作为生成参考。' : '来源校验通过。请自行核对分析是否成立，字段完整度不代表文学质量。'}</p>
      <details open><summary>完整分析卡</summary><pre>{JSON.stringify(selected.analysis.instance_card, null, 2)}</pre></details>
      <h4>引用证据</h4><small>位置是本次过滤后资料文本中的字符范围，不是原文件行号。</small>
      {selected.analysis.evidence.map(evidence => <blockquote key={evidence.id}><small>{selected.sources[evidence.source].file} · {evidence.id} · {evidence.start}–{evidence.end}</small><p>{evidence.quote}</p></blockquote>)}
      <details><summary>完整来源快照</summary>{selected.sources.map(source => <pre key={source.citation}>{source.file + '\n' + source.text}</pre>)}</details>
      <details><summary>审阅记录</summary><pre>{JSON.stringify(selected.history, null, 2)}</pre></details>
      {['proposed', 'approved'].includes(selected.status) && <><label>审阅理由<input aria-label="审阅理由" value={reason} maxLength={2000} disabled={busy || !!decision} onChange={event => setReason(event.target.value)}/></label>
        {!decision && (selected.status === 'proposed' ? <><button disabled={busy || !reason.trim() || selected.stale} onClick={() => work(() => decide('approve'))}>预览批准</button><button disabled={busy || !reason.trim()} onClick={() => work(() => decide('reject'))}>预览拒绝</button></> : <button disabled={busy || !reason.trim()} onClick={() => work(() => decide('withdraw'))}>预览撤回</button>)}</>}
      {decision && <aside><p>将执行：{{ approve: '批准进入检索', reject: '拒绝此卡', withdraw: '撤回检索使用' }[decision.change.action]}。理由：{decision.change.reason}</p>
        <button disabled={busy} onClick={() => work(async () => { setSelected(await api('card-apply', { change: decision.change, token: decision.token, operation: decision.operation }));setDecision(null);await list() })}>确认此操作</button>
        <button disabled={busy} onClick={() => setDecision(null)}>返回审阅</button></aside>}
    </article>}
    {error && <p role="alert">{error}</p>}<button disabled={busy} onClick={onClose}>返回资料检索</button>
  </section>
}
