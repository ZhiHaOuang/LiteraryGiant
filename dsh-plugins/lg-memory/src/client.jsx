import { MemoryExtract } from './extract.jsx'
import React, { useEffect, useRef, useState } from 'react'
import { MemoryForm, initial, labels, stateLabels } from './forms.jsx'

export const inject = ['slots', 'locale']
const sections = { facts: '世界事实', proposals: '待审提案', timeline: '时间线', foreshadowing: '伏笔', knowledge: '叙事认知' }
async function request(endpoint, input, signal) {
  const response = await fetch(`api/lg/${endpoint}`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const result = await response.json()
  if (!result.ok) throw new Error(result.error ?? '读取失败')
  return result.value
}
function Record({ item }) {
  if (!item) return <p>无现有记录</p>
  if (item.error) return <p role="alert">{item.error}</p>
  const source = item.source?.status ?? item.source_status
  return <div><strong>{item.title ?? item.label ?? `${item.category ?? ''} · ${item.fact_key ?? ''}`}</strong>
    <p>{item.value ?? item.event ?? item.setup_note}</p>{item.payoff_note && <p>回收/放弃：{item.payoff_note}</p>}
    <small>{stateLabels[item.state ?? item.status] ?? ''}{source ? ` · ${stateLabels[source] ?? source}` : ''}</small>
    {item.topic && <><p>{item.topic.audience === 'character' ? `人物 ${item.topic.holder_document_id} · 故事位置` : '读者 · 阅读位置'} {item.topic.from_position} 起 · 主题 {item.topic.key}</p>
      <p>最新提案（第 {item.proposal_version_number} 版）：{item.proposal.content}</p>
      <p>当前确认：{item.confirmed ? `${stateLabels[item.confirmed.stance]} · ${item.confirmed.content}（截至 ${item.confirmed.until_position ?? '持续'}）` : '无'}</p></>}
    {item.extraction && <details><summary>提取证据 · 版本 {item.extraction.source.version}{item.extraction.stale ? ' · 已过期，不能采用' : ''}</summary>
      {item.extraction.evidence.map((e, i) => <blockquote key={i}><small>字符 {e.start}–{e.end}</small><p>{e.quote}</p></blockquote>)}</details>}
    {item.rationale && <p>依据：{item.rationale}</p>}
    {!!item.tags?.length && <small>{item.tags.join(' · ')}</small>}
  </div>
}
function Memory() {
  const [books, setBooks] = useState([]), [path, setPath] = useState(''), [section, setSection] = useState('facts')
  const [data, setData] = useState(null), [documents, setDocuments] = useState([]), [editor, setEditor] = useState(null)
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [history, setHistory] = useState(null)
  const [view, setView] = useState(null), [observer, setObserver] = useState({ audience: 'reader', position: 0, holder_document_id: null })
  const [filters, setFilters] = useState({ query: '', state: '', category: '', tags: '' }), [historyPage, setHistoryPage] = useState(null)
  const [extracting, setExtracting] = useState(false)
  const active = useRef(null)
  async function load(nextPath, nextSection = section, offset = 0, nextFilters = filters) {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setBusy(true); setError(''); setHistory(null); setView(null)
    try {
      const list = await request('books', { action: 'list' }, controller.signal), chosen = nextPath || list.find(book => !book.error)?.path || ''
      setBooks(list); setPath(chosen); setSection(nextSection)
      if (chosen) {
        const [items, docs] = await Promise.all([request('memory', { action: 'list', path: chosen, section: nextSection, offset,
          query: nextFilters.query, category: nextFilters.category, tags: nextFilters.tags.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean),
          ...(nextSection === 'proposals' ? { status: nextFilters.state } : { state: nextFilters.state }) }, controller.signal), request('memory', { action: 'documents', path: chosen }, controller.signal)])
        if (!controller.signal.aborted) { setData(items); setDocuments(docs) }
      } else setData(null)
    } catch (error) { if (!controller.signal.aborted) setError(error.message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  useEffect(() => { void load(''); return () => active.current?.abort() }, [])
  const edit = change => { setEditor({ change, key: crypto.randomUUID() }); setError('') }
  async function prepare(change) {
    setBusy(true); setError('')
    try { setPreview({ change, operation: crypto.randomUUID(), ...await request('memory', { action: 'preview', path, change }) }) }
    catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  async function apply() {
    setBusy(true); setError('')
    try {
      await request('memory', { action: 'apply', path, change: preview.change, token: preview.token, operation: preview.operation })
      setPreview(null); setEditor(null); await load(path)
    } catch (error) { setError(error.message + '。未确认结果时可用原操作重试。'); setBusy(false) }
  }
  async function inspect(input, setter) {
    setBusy(true); setError('')
    try { setter(await request('memory', { ...input, path })) } catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  const locked = busy || !!editor || !!preview || extracting
  return <main className="lgm-page"><style>{`
    .lgm-page{padding:28px;max-width:1100px;margin:auto;height:100%;overflow:auto;color:var(--foreground,inherit)}
    .lgm-page header,.lgm-row,.lgm-page nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}
    .lgm-page label{display:flex;flex-direction:column;gap:5px;margin:10px 0}.lgm-page input,.lgm-page select,.lgm-page textarea,.lgm-page button{padding:8px;border:1px solid #8885;border-radius:7px;background:transparent;color:inherit}
    .lgm-page textarea{min-height:90px;resize:vertical}.lgm-page article,.lgm-page aside,.lgm-page fieldset{border:1px solid #8884;border-radius:10px;padding:16px;margin:14px 0;min-width:0}
    .lgm-page p{white-space:pre-wrap;overflow-wrap:anywhere}.lgm-page small{opacity:.7}.lgm-page [role=alert]{color:#c96551}.lgm-page button:disabled{opacity:.5}.lgm-page [aria-current=true]{font-weight:700;border-color:currentColor}
  `}</style><small>LITERARYGIANT</small><h1>故事记忆</h1><p>世界事实、人物认识、读者已知和创作计划各自独立。模型提案需要作者确认；确认人物信念不会把它变成世界事实。</p>
    <header><select aria-label="作品" value={path} disabled={locked} onChange={event => load(event.target.value)}><option value="">选择作品</option>
      {books.map(book => <option key={book.path} value={book.path} disabled={!!book.error}>{book.name ?? book.path}</option>)}</select>
      <button disabled={locked} onClick={() => load(path)}>刷新</button></header>
    <nav>{Object.entries(sections).map(([key, title]) => <button key={key} aria-current={section === key} disabled={locked} onClick={() => {
      const next = { query: '', state: key === 'proposals' ? 'proposed' : '', category: '', tags: '' }; setFilters(next); void load(path, key, 0, next)
    }}>{title}</button>)}</nav>
    <form className="lgm-row" onSubmit={event => { event.preventDefault(); void load(path) }}>
      <input aria-label="记忆关键词" placeholder={section === 'knowledge' ? '标题或标识' : '关键词'} value={filters.query} maxLength={500} disabled={locked} onChange={event => setFilters({ ...filters, query: event.target.value })}/>
      {section !== 'knowledge' && <><select aria-label="记忆状态" value={filters.state} disabled={locked} onChange={event => setFilters({ ...filters, state: event.target.value })}>
        <option value="">全部状态</option>{(section === 'proposals' ? ['proposed', 'accepted', 'rejected'] : section === 'foreshadowing' ? ['open', 'planned', 'paid', 'abandoned'] : ['idea', 'canonical', 'archived', 'rejected']).map(state => <option key={state} value={state}>{stateLabels[state]}</option>)}</select>
        <input aria-label="记忆标签" placeholder="精确标签，逗号分隔" value={filters.tags} disabled={locked} onChange={event => setFilters({ ...filters, tags: event.target.value })}/></>}
      {['facts', 'proposals'].includes(section) && <input aria-label="事实分类" placeholder="分类" value={filters.category} maxLength={128} disabled={locked} onChange={event => setFilters({ ...filters, category: event.target.value })}/>}
      <button disabled={locked || !path}>筛选</button></form>
    {error && <p role="alert">{error}</p>}
    {!editor && <button disabled={!path || locked} onClick={() => edit(initial(section))}>新增{sections[section]}</button>}
    {!extracting && <button disabled={!path || locked} onClick={() => setExtracting(true)}>从正文提取记忆</button>}
    {extracting && <MemoryExtract path={path} documents={documents} request={request} onClose={() => setExtracting(false)} onSaved={() => {
      setExtracting(false); const next = { query: '', state: 'proposed', category: '', tags: '' }; setFilters(next); void load(path, 'proposals', 0, next)
    }}/>}
    {editor && !preview && <MemoryForm key={editor.key} initialValue={editor.change} documents={documents} onPreview={prepare} onCancel={() => setEditor(null)} busy={busy}/>}
    {preview && <aside><h2>确认：{labels[preview.value.action]}</h2><h3>当前记录</h3><Record item={preview.value.before}/>
      <h3>提交后</h3><Record item={{ ...preview.value.before, ...preview.value.after, ...(preview.value.title ? { title: preview.value.title } : {}) }}/>
      {preview.value.replacement && <><p>将更新以下同分类与键的事实：</p><Record item={preview.value.replacement}/></>}
      {!!preview.value.sources?.details?.length && <p>已绑定 {preview.value.sources.details.length} 个精确来源版本，状态：{stateLabels[preview.value.sources.status]}</p>}
      <div className="lgm-row"><button disabled={busy} onClick={apply}>确认提交</button><button disabled={busy} onClick={() => setPreview(null)}>返回修改</button></div></aside>}
    {data && <><p>{sections[section]} · 共 {data.total} 条{data.truncated ? ' · 本页达到内容上限' : ''}</p>
      {data.items.map(item => <article key={item.id ?? item.document_id}><Record item={item}/><div className="lgm-row">
        {section === 'facts' && !item.error && <>
          <button disabled={locked} onClick={() => edit({ ...initial('facts'), ...item, action: 'fact.set', key: item.fact_key })}>按分类与键更新</button>
          {item.state !== 'canonical' && <button disabled={locked} onClick={() => edit({ action: 'fact.promote', id: item.id, rationale: '' })}>确认为正式</button>}
          {item.state !== 'archived' && <button disabled={locked} onClick={() => edit({ action: 'fact.archive', id: item.id, rationale: '' })}>归档</button>}
          <button disabled={locked} onClick={() => { setHistoryPage({ id: item.id, offset: 0 }); void inspect({ action: 'history', id: item.id }, setHistory) }}>历史</button></>}
        {section === 'proposals' && item.status === 'proposed' && <><button disabled={locked} onClick={() => edit({ action: 'proposal.accept', id: item.id, rationale: '' })}>审阅并采用</button>
          <button disabled={locked} onClick={() => edit({ action: 'proposal.reject', id: item.id, rationale: '' })}>拒绝</button></>}
        {section === 'timeline' && <button disabled={locked} onClick={() => edit({ ...item, action: 'timeline.update' })}>修改事件</button>}
        {section === 'foreshadowing' && ['open', 'planned'].includes(item.state) && <button disabled={locked} onClick={() => edit({ action: 'foreshadow.resolve', id: item.id, state: 'paid', payoff_note: '' })}>回收或放弃</button>}
        {section === 'knowledge' && !item.error && <><button disabled={locked} onClick={() => edit({ action: 'knowledge.propose', slug: item.slug, title: item.title,
          topic: item.topic, statement: Object.fromEntries(['content', 'stance', 'until_position', 'sources'].map(key => [key, item.proposal[key]])), rationale: item.proposal.rationale, expected_version_id: item.version_id })}>修订提案</button>
          <button disabled={locked} onClick={() => edit({ action: 'knowledge.confirm', id: item.document_id, expected_version_id: item.version_id, proposal_version_number: item.proposal_version_number })}>确认提案</button>
          {item.confirmed && <button disabled={locked} onClick={() => edit({ action: 'knowledge.withdraw', id: item.document_id, expected_version_id: item.version_id })}>撤回确认</button>}</>}
      </div></article>)}
      <nav><button disabled={locked || !data.offset} onClick={() => load(path, section, Math.max(0, data.offset - 30))}>上一页</button>
        <button disabled={locked || data.nextOffset === null || data.nextOffset === data.offset} onClick={() => load(path, section, data.nextOffset)}>下一页</button></nav></>}
    {history && <aside><h2>事实历史</h2>{history.map(item => <p key={item.id}>{item.created_at} · {item.action}<br/>{item.old_value ?? '无'} → {item.new_value ?? '无'}<br/>{item.rationale}</p>)}
      <div className="lgm-row"><button disabled={locked || !historyPage?.offset} onClick={() => { const next = { ...historyPage, offset: Math.max(0, historyPage.offset - 100) }; setHistoryPage(next); void inspect({ action: 'history', ...next }, setHistory) }}>更新的历史</button>
        <button disabled={locked || history.length < 100} onClick={() => { const next = { ...historyPage, offset: historyPage.offset + 100 }; setHistoryPage(next); void inspect({ action: 'history', ...next }, setHistory) }}>更早的历史</button></div></aside>}
    {section === 'knowledge' && <aside><h2>检查视角可见内容</h2><p>人物用故事位置，读者用阅读位置；位置是作者坐标，不会从章节标题自动推断。</p>
      <div className="lgm-row"><select aria-label="视角类型" value={observer.audience} disabled={locked} onChange={event => setObserver({ ...observer, audience: event.target.value, holder_document_id: null })}>
        <option value="reader">读者</option><option value="character">人物</option></select>
        {observer.audience === 'character' && <select aria-label="视角人物" value={observer.holder_document_id ?? ''} disabled={locked} onChange={event => setObserver({ ...observer, holder_document_id: Number(event.target.value) })}>
          <option value="">选择人物</option>{documents.filter(doc => doc.kind === 'character').map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select>}
        <input aria-label="视角位置" type="number" value={observer.position} disabled={locked} onChange={event => setObserver({ ...observer, position: Number(event.target.value) })}/>
        <button disabled={locked || !path} onClick={() => inspect({ action: 'view', ...observer }, setView)}>查看投影</button></div>
      {view && <><p>{view.note}</p>{view.statements.map(item => <p key={item.record_id}>{stateLabels[item.stance]} · {item.content}</p>)}
        <small>可见 {view.statements.length} · 来源待复核 {view.withheld.length} · 无效 {view.invalid}{view.truncated ? ' · 结果截断' : ''}</small></>}
    </aside>}
  </main>
}
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('lg-memory', { zh: { title: '故事记忆' }, en: { title: 'Story memory' } }), 'lg-memory: locale')
  const t = ctx.locale.bind('lg-memory')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'lg-memory', locale: 'lg-memory' }, () => <Memory/>))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'lg-memory', order: 18, locale: 'lg-memory', label: () => t('title') }, () => <span aria-hidden="true">◇</span>))
}
