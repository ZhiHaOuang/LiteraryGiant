import React, { useEffect, useRef, useState } from 'react'

export function ReferencePicker({ path, selected, onChange, disabled }) {
  const [query, setQuery] = useState(''), [result, setResult] = useState(null), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), active = useRef(null)
  useEffect(() => { setResult(null); setError(''); return () => active.current?.abort() }, [path])
  async function search() {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setBusy(true); setError(''); setResult(null)
    try {
      const response = await fetch('api/lg/library', { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'search', path, query, limit: 5 }) })
      if (response.status === 404) throw new Error('资料选择需要启用 lg-library 插件。')
      const value = await response.json()
      if (!value.ok) throw new Error(value.error)
      if (!controller.signal.aborted) setResult(value.value)
    } catch (error) { if (!controller.signal.aborted) setError(error.message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const contains = hit => selected.some(item => item.citation === hit.citation)
  return <details><summary>参考资料（可选）· 已选 {selected.length}/3</summary>
    <p>资料是外部参考，不会自动成为本书事实。每条最多发送前 1200 字，完整发送内容会出现在任务预览中。</p>
    <div className="lgw-toolbar"><input aria-label="任务参考资料检索" value={query} maxLength={500} disabled={disabled || busy}
      placeholder="输入情节、人物或文风关键词" onChange={event => setQuery(event.target.value)}/>
      <button type="button" disabled={disabled || busy || !query.trim()} onClick={search}>{busy ? '检索中…' : '检索参考资料'}</button></div>
    {selected.map(hit => <p key={hit.citation}>{hit.id} · {hit.file} <button type="button" disabled={disabled}
      onClick={() => onChange(selected.filter(item => item.citation !== hit.citation))}>移除</button></p>)}
    {result?.stats.truncated && <p>已到检索上限，结果可能不完整。</p>}
    {result?.warnings.map((warning, i) => <p role="alert" key={i}>{warning.file}：{warning.error}</p>)}
    {result && !result.hits.length && <p>没有找到匹配资料。</p>}
    {result?.hits.map(hit => <article key={hit.citation}><strong>{hit.id}</strong><small> · {hit.file}</small><p>{hit.excerpt}</p>
      <button type="button" disabled={disabled || contains(hit) || selected.length >= 3} onClick={() => onChange([...selected, hit])}>{contains(hit) ? '已选择' : '用于本次任务'}</button></article>)}
    {error && <p role="alert">{error}</p>}
  </details>
}
