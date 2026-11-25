import React, { useEffect, useRef, useState } from 'react'
import { Cards } from './cards.jsx'

export const inject = ['slots', 'locale']
async function request(endpoint, input, signal) {
  const response = await fetch(`api/lg/${endpoint}`, { method: 'POST', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const result = await response.json()
  if (!result.ok) throw new Error(result.error ?? '资料读取失败')
  return result.value
}
function Library() {
  const [books, setBooks] = useState([]), [path, setPath] = useState(''), [query, setQuery] = useState('')
  const [result, setResult] = useState(null), [source, setSource] = useState(null), [error, setError] = useState('')
  const [selected, setSelected] = useState([]), [showCards, setShowCards] = useState(false)
  const [busy, setBusy] = useState(false), active = useRef(null)
  useEffect(() => {
    const controller = new AbortController(); active.current = controller
    request('books', { action: 'list' }, controller.signal).then(list => {
      setBooks(list); setPath(list.find(book => !book.error)?.path ?? '')
    }).catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => active.current?.abort()
  }, [])
  async function run(input) {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setBusy(true); setError(''); setSource(null)
    if (input.action === 'search') setResult(null)
    try {
      const value = await request('library', { ...input, path }, controller.signal)
      if (controller.signal.aborted) return
      if (input.action === 'search') setResult(value); else setSource(value)
    } catch (error) { if (!controller.signal.aborted) setError(error.message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <main className="lgl-page"><style>{`
    .lgl-page{padding:28px;max-width:1080px;margin:auto;height:100%;overflow:auto;color:var(--foreground,inherit)}
    .lgl-page form{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}.lgl-page input{flex:1;min-width:180px}
    .lgl-page input,.lgl-page textarea,.lgl-page select,.lgl-page button{padding:8px;border:1px solid #8885;border-radius:7px;background:transparent;color:inherit}
    .lgl-page article,.lgl-page aside{border:1px solid #8884;border-radius:10px;padding:16px;margin:14px 0}
    .lgl-page p,.lgl-page pre{white-space:pre-wrap;overflow-wrap:anywhere}.lgl-page pre{max-height:450px;overflow:auto}
    .lgl-page small{opacity:.7}.lgl-page [role=alert]{color:#c96551}.lgl-page button:disabled{opacity:.5}
  `}</style><small>LITERARYGIANT</small><h1>文学资料</h1>
    <p>检索抽象模式、作品参考资料与 Bridge 索引。资料用于参考；采用情节与设定仍由作者决定。</p>
    <label>作品 <select value={path} disabled={busy || showCards} onChange={event => { setSelected([]); setPath(event.target.value); setResult(null); setSource(null); setError('') }}>
      <option value="">请选择已登记作品</option>{books.map(book => <option key={book.path} value={book.path} disabled={!!book.error}>{book.name ?? book.path}</option>)}
    </select></label>
    {showCards ? <Cards key={path} path={path} references={selected} request={request} onClose={() => { setShowCards(false); setResult(null); setSource(null) }}/> : <>
    <button disabled={busy || !path} onClick={() => setShowCards(true)}>分析所选资料／审阅卡片（已选 {selected.length}/3）</button>
    <form onSubmit={event => { event.preventDefault(); void run({ action: 'search', query, limit: 8 }) }}>
      <input aria-label="检索词" value={query} maxLength={500} placeholder="例如：身份揭露、信任冲突、情绪转折" onChange={event => setQuery(event.target.value)}/>
      <button disabled={busy || !path || !query.trim()}>{busy ? '读取中…' : '检索资料'}</button>
      {busy && <button type="button" onClick={() => { active.current?.abort(); setBusy(false) }}>取消</button>}
    </form>
    {error && <p role="alert">{error}</p>}
    {result && <><small>已读 {result.stats.files} 个文件 · {result.stats.records} 条记录{result.stats.truncated ? ' · 已到读取上限，结果可能不完整' : ''}
      {result.stats.malformed ? ` · 跳过 ${result.stats.malformed} 条格式错误记录` : ''}</small>
      {result.warnings.map((warning, i) => <p role="alert" key={i}>{warning.file}：{warning.error}</p>)}
      {!result.hits.length && <p>没有找到匹配资料。请检查作品 ReferenceLibrary 或插件设置中的 Library 路径。</p>}
      {result.hits.map(hit => <article key={hit.citation}><small>{{ abstract: '抽象模式', custom: '作品参考', bridge: 'Bridge 索引', curated: '已批准分析卡' }[hit.tier]} · {hit.file}</small>
        <h2>{hit.id}</h2><p>{hit.excerpt}</p><button disabled={busy} onClick={() => run({ action: 'read', citation: hit.citation })}>校验并查看来源</button>
        {hit.tier !== 'curated' && <button disabled={busy || !selected.some(item => item.citation === hit.citation) && selected.length >= 3} onClick={() => setSelected(previous => previous.some(item => item.citation === hit.citation) ? previous.filter(item => item.citation !== hit.citation) : [...previous, hit])}>{selected.some(item => item.citation === hit.citation) ? '取消选择' : '选择用于分析'}</button>}</article>)}</>}
    {source && <aside><h2>已校验来源 · {source.id}</h2><small>{source.file} · SHA-256 {source.sha256.slice(0, 12)}</small><pre>{source.text}</pre>
      <details><summary>引用标识</summary><pre>{source.citation}</pre></details></aside>}
    </>}
  </main>
}
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('lg-library', { zh: { title: '文学资料' }, en: { title: 'Literary References' } }), 'lg-library: locale')
  const t = ctx.locale.bind('lg-library')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'lg-library', locale: 'lg-library' }, () => <Library/>))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'lg-library', order: 17,
    locale: 'lg-library', label: () => 'Literary References' }, () => <span aria-hidden="true">▤</span>))
}
