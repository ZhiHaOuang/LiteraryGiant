import React, { useEffect, useState } from 'react'
const kinds = { book: '全书设定', part: '卷资料', outline: '大纲', world: '世界观', character: '人物', timeline: '时间线资料', style: '文风', note: '笔记', research: '研究' }
async function request(path, input) {
  const response = await fetch('api/lg/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, path }) })
  const result = await response.json(); if (!result.ok) throw new Error(result.error); return result.value
}
export function Documents({ path, onLock }) {
  const [list, setList] = useState({ items: [] }), [data, setData] = useState(null)
  const [kind, setKind] = useState(''), [query, setQuery] = useState(''), [archived, setArchived] = useState(false)
  const [draft, setDraft] = useState(null), [preview, setPreview] = useState(null), [reason, setReason] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [receipt, setReceipt] = useState(null)
  const locked = busy || !!draft || !!preview
  useEffect(() => { onLock(locked); return () => onLock(false) }, [locked, onLock])
  async function load(id, version, offset = 0) {
    setBusy(true); setError('')
    try {
      setList(await request(path, { action: 'list', options: { kind: kind || undefined, query, state: archived ? 'archived' : undefined, offset } }))
      setData(id ? await request(path, { action: 'read', id, version }) : null)
    } catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [path])
  async function prepare(action) {
    setBusy(true); setError('')
    const change = draft ? { ...draft, reason } : { action, id: data.document.id, version: data.selected.id, expected_token: data.token, reason }
    try { setPreview({ ...await request(path, { action: 'preview', change }), change, operation: crypto.randomUUID() }) }
    catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  async function confirm() {
    setBusy(true); setError('')
    try {
      const value = await request(path, { action: 'apply', change: preview.change, token: preview.token, operation: preview.operation })
      setReceipt(value); setPreview(null); setDraft(null); setReason(''); await load(value.id, value.version)
    } catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  const edit = action => setDraft({ action, id: data.document.id, expected_token: data.token, content: data.current.content })
  const updateDraft = (key, value) => setDraft({ ...draft, [key]: value })
  return <section><h2>作品资料</h2><p>人物、世界观、大纲与笔记按版本保存。方向裁决、正式事实和角色认知请使用各自面板。</p>
    <fieldset disabled={locked}><label>类型<select value={kind} onChange={event => setKind(event.target.value)}><option value="">全部资料</option>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>搜索<input value={query} maxLength={200} onChange={event => setQuery(event.target.value)}/></label>
      <label><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)}/>查看归档</label>
      <button onClick={() => load()}>查询 / 刷新</button>
      <button onClick={() => { setDraft({ action: 'create', kind: kind || 'note', slug: '', title: '', content: '', tags: [] }); setReceipt(null) }}>新建资料</button>
      <select aria-label="选择资料" value={data?.document.id ?? ''} onChange={event => load(Number(event.target.value))}><option value="">选择资料 · 共 {list.total ?? 0} 项</option>{list.items.map(item => <option key={item.id} value={item.id}>{item.title} · {kinds[item.kind]} · {item.state}</option>)}</select>
      <button disabled={!list.offset} onClick={() => load(null, null, Math.max(0, list.offset - 30))}>上一页</button>
      <button disabled={list.nextOffset == null} onClick={() => load(null, null, list.nextOffset)}>下一页</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {receipt && <p role="status">已保存 · {receipt.action} · 版本 ID {receipt.version}。{receipt.changesActive ? '作品数据库已更新，外部资料文件未改动。' : '当前资料保持原样。'}</p>}
    {data && !draft && <><h3>{data.document.title} · {data.document.state}</h3>
      <select aria-label="资料版本" disabled={locked} value={data.selected.id} onChange={event => load(data.document.id, Number(event.target.value))}>{data.versions.map(version => <option key={version.id} value={version.id}>v{version.version_number} · {version.state}</option>)}</select>
      <div className="lgw-columns"><article><h4>当前资料 · v{data.current.version_number}</h4><pre style={{ whiteSpace: 'pre-wrap' }}>{data.current.content}</pre></article>
        {data.selected.id !== data.current.id && <article><h4>选中版本 · v{data.selected.version_number}</h4><pre style={{ whiteSpace: 'pre-wrap' }}>{data.selected.content}</pre></article>}</div>
      <fieldset disabled={locked}>{data.document.state === 'archived' ? <button onClick={() => prepare('reopen')}>预览恢复显示</button> : <>
        <button onClick={() => edit('edit')}>作者编辑当前资料</button><button onClick={() => edit('candidate')}>撰写新候选</button>
        <button onClick={() => setDraft({ action: 'update', id: data.document.id, expected_token: data.token, title: data.document.title, tags: data.document.tags })}>标题与标签</button>
        <button onClick={() => prepare('accept')}>预览采用选中版本</button>
        {data.selected.state === 'candidate' && <button onClick={() => prepare('reject')}>预览拒绝候选</button>}
        {data.selected.id !== data.current.id && <button onClick={() => prepare('restore')}>恢复选中版本为新候选</button>}
        <button onClick={() => prepare('archive')}>预览归档</button>
      </>}</fieldset></>}
    {draft && <fieldset disabled={busy || !!preview}><h3>{draft.action === 'create' ? '新建资料' : draft.action === 'update' ? '资料信息' : '编辑资料'}</h3>
      {draft.action === 'create' && <><label>类型<select value={draft.kind} onChange={event => updateDraft('kind', event.target.value)}>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>唯一标识<input value={draft.slug} maxLength={200} onChange={event => updateDraft('slug', event.target.value)} placeholder="汉字、字母、数字、短横线或下划线"/></label></>}
      {'title' in draft && <label>标题<input value={draft.title} maxLength={200} onChange={event => updateDraft('title', event.target.value)}/></label>}
      {'tags' in draft && <label>标签（每行一个）<textarea value={draft.tagsText ?? draft.tags.join('\n')} onChange={event => setDraft({ ...draft, tagsText: event.target.value, tags: event.target.value.split('\n').filter(value => value.trim()) })}/></label>}
      {'content' in draft && <textarea aria-label="资料内容" rows={16} value={draft.content} maxLength={400000} onChange={event => updateDraft('content', event.target.value)}/>}
      <button onClick={() => prepare(draft.action)}>预览修改</button></fieldset>}
    {(data || draft) && <label>修改说明<input aria-label="资料修改说明" disabled={busy || !!preview} value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} placeholder="必填，记录本次作者决定"/></label>}
    {preview && <section><h3>确认资料操作 · {preview.change.action}</h3><p>{preview.change.reason}</p>
      {preview.value.after.content !== undefined ? <pre style={{ whiteSpace: 'pre-wrap' }}>{preview.value.after.content}</pre> : <p>{preview.value.after.title ?? ''} {preview.value.after.state ?? ''} {preview.value.after.tags?.join('、') ?? ''}</p>}
      <button disabled={busy} onClick={confirm}>确认执行</button><button disabled={busy} onClick={() => setPreview(null)}>返回修改</button></section>}
    {draft && <button disabled={busy} onClick={() => { setDraft(null); setPreview(null); setError('') }}>放弃未保存修改</button>}
  </section>
}
