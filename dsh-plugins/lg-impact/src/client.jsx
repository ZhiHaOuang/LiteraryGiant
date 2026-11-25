import React, { useEffect, useRef, useState } from 'react'

export const inject = ['slots']

async function request(endpoint, data, signal) {
  const response = await fetch('api/lg/' + endpoint, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(result.error || '查询失败。')
  return result.value
}

function Impact() {
  const [books, setBooks] = useState([]), [path, setPath] = useState('')
  const [query, setQuery] = useState(''), [docs, setDocs] = useState({items:[]})
  const [document, setDocument] = useState(0), [versions, setVersions] = useState({items:[]})
  const [version, setVersion] = useState(null), [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const active = useRef(null)
  async function work(fn) {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError('')
    try { await fn(controller.signal) }
    catch (error) { if (!controller.signal.aborted) setError(error.message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  function resetDocument() {
    setDocument(0)
    setVersion(null)
    setVersions({items:[]})
    setReport(null)
  }
  async function find(book, term, offset, signal) {
    const next = await request('impact', {action:'documents',path:book,query:term,offset}, signal)
    setDocs({ ...next, query:term, items:offset ? [...docs.items,...next.items] : next.items })
  }
  async function loadVersions(id, offset, signal) {
    const next = await request('impact', {action:'versions',path,document:id,offset}, signal)
    setVersions({ ...next, items:offset ? [...versions.items,...next.items] : next.items })
  }
  useEffect(() => {
    void work(async signal => {
      const list = await request('books',{action:'list'},signal)
      setBooks(list)
      const first = list.find(item => !item.error)?.path || ''
      setPath(first)
      if (first) await find(first,'',0,signal)
    })
    return () => active.current?.abort()
  }, [])
  function inspect(offset = 0) {
    void work(async signal => {
      const value = await request('impact',{action:'inspect',path,document,version,offset},signal)
      setReport({ ...value,offset })
    })
  }
  return <main className="lg-impact"><style>{`
    .lg-impact{box-sizing:border-box;height:100%;max-width:1100px;margin:auto;padding:24px;overflow:auto}
    .lg-impact fieldset{display:flex;flex-wrap:wrap;align-items:end;gap:12px;border:0;padding:0}
    .lg-impact label{display:grid;gap:4px}.lg-impact input,.lg-impact select,.lg-impact button{font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:5px;padding:6px}
    .lg-impact table{width:100%;border-collapse:collapse}.lg-impact th,.lg-impact td{text-align:left;padding:8px;border-bottom:1px solid #8884;overflow-wrap:anywhere}
    .lg-impact [role=alert]{color:#aa5945}
  `}</style><h1>修订影响</h1>
    <fieldset disabled={busy}><label>作品<select value={path} onChange={event=>{
      const book=event.target.value
      setPath(book);setQuery('');setDocs({items:[]});resetDocument()
      if(book)void work(signal=>find(book,'',0,signal))
    }}><option value="">选择作品</option>{books.filter(b=>!b.error).map(b=><option key={b.path} value={b.path}>{b.name}</option>)}</select></label>
    {path&&<><label>查找文档<input value={query} maxLength={200} onChange={e=>setQuery(e.target.value)}/></label>
      <button onClick={()=>{resetDocument();setDocs({items:[]});void work(signal=>find(path,query,0,signal))}}>搜索</button>
      <label>来源文档<select value={document||''} onChange={e=>{
        const id=Number(e.target.value);resetDocument();setDocument(id)
        if(id)void work(signal=>loadVersions(id,0,signal))
      }}><option value="">选择文档</option>{docs.items.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
      {docs.nextOffset!=null&&<button onClick={()=>work(signal=>find(path,docs.query,docs.nextOffset,signal))}>更多文档</button>}
    </>}
    {document>0&&<><label>来源版本<select value={version??''} onChange={e=>{setVersion(Number(e.target.value)||null);setReport(null)}}>
      <option value="">所有版本及文档关联</option>{versions.items.map(v=><option key={v.id} value={v.id}>v{v.version_number} · ID {v.id}</option>)}</select></label>
      {versions.nextOffset!=null&&<button onClick={()=>work(signal=>loadVersions(document,versions.nextOffset,signal))}>更多版本</button>}
      <button onClick={()=>inspect()}>查询引用</button></>}
    </fieldset>{busy&&<p role="status">正在查询…</p>}{error&&<p role="alert">{error}</p>}
    {report&&<section><h2>{report.subject.title}的直接引用</h2><p>已找到 {report.discovered} 项。引用记录供作者复核，情节是否需要调整由作者判断。</p>
      {report.items.length>0&&<table><thead><tr><th>引用方</th><th>记录</th><th>关系</th><th>引用的来源</th></tr></thead><tbody>
        {report.items.map((item,index)=><tr key={index}><td>{item.kind}</td><td>{item.title}{item.number?' · v'+item.number:''}<small> · {item.id}</small></td>
          <td>{item.relation}</td><td>{item.sourceVersion?'版本 ID '+item.sourceVersion+' · ':''}{item.status}</td></tr>)}
      </tbody></table>}
      <p>缺少生成输入记录的版本 {report.stats.unrecorded} 个，无法校验的记录或引用 {report.stats.invalid} 项，未解析的来源 {report.stats.unsupported} 项，仅索引引用 {report.stats.indexOnly} 项。</p>
      {!!report.stats.limited.length&&<p role="alert">本次扫描已达到上限，仍有记录待核对。</p>}
      {report.offset>0&&<button disabled={busy} onClick={()=>inspect(Math.max(0,report.offset-50))}>上一页</button>}
      {report.nextOffset!=null&&<button disabled={busy} onClick={()=>inspect(report.nextOffset)}>下一页</button>}
    </section>}
  </main>
}
export function apply(ctx) {
  ctx.slots.inject('main', () => ctx.slots.register({name:'main',key:'lg-impact'},Impact))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name:'sidebar.panellist',id:'lg-impact',order:24,label:()=>'Revision Impact',
  }, () => <span aria-hidden="true">↳</span>))
}
