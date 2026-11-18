import React, { useEffect, useState } from 'react'
import { targets, formats } from './options.js'

export const inject = ['slots', 'fileActions']

function ExportPanel({ files }) {
  const [books, setBooks] = useState([]), [path, setPath] = useState('')
  const [target, setTarget] = useState('manuscript'), [format, setFormat] = useState('md')
  const [drafts, setDrafts] = useState(false), [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      const response = await fetch('/api/lg/books', { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list' }) })
      const result = await response.json()
      if (!result.ok) throw new Error(result.error)
      const available = result.value.filter(book => !book.error)
      setBooks(available); setPath(available[0]?.path || '')
    }
    load().catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [])

  async function save(mode) {
    setBusy(true); setMessage(''); setError('')
    const book = books.find(book => book.path === path)
    try {
      const url = new URL('/api/lg/export', location.href).href
      const result = await files.save({ url, name: book.name + '-' + targets[target] + '.' + format, mediaType: formats[format],
        async read(signal) {
          const response = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path, target, format, includeDrafts: drafts && target !== 'foreshadowing' }) })
          if (!response.ok) throw new Error((await response.json()).error)
          return response.blob()
        } }, mode)
      setMessage(result.status === 'saved' ? '已保存到 ' + result.path : result.status === 'requested' ? '已提交浏览器下载。' : '已取消保存。')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return <main className="lg-export"><style>{`.lg-export{padding:28px;max-width:760px;margin:auto;overflow:auto;height:100%}.lg-export fieldset{border:0;padding:0;display:grid;gap:14px}.lg-export select,.lg-export button{font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:6px;padding:6px 10px;margin-inline:6px}.lg-export [role=alert]{color:#bd5849}`}</style>
    <h1>作品导出</h1><fieldset disabled={busy} onChange={() => { setMessage(''); setError('') }}>
      <label>作品<select value={path} onChange={e => setPath(e.target.value)}>
        {!books.length && <option value="">请先在控制台登记作品</option>}
        {books.map(book => <option key={book.path} value={book.path}>{book.name}</option>)}</select></label>
      <label>导出内容<select value={target} onChange={e => setTarget(e.target.value)}>
        {Object.entries(targets).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
      <label>文件格式<select value={format} onChange={e => setFormat(e.target.value)}>
        <option value="md">Markdown</option><option value="txt">纯文本</option><option value="docx">Word (.docx)</option></select></label>
      {target !== 'foreshadowing' && <label><input type="checkbox" checked={drafts} onChange={e => setDrafts(e.target.checked)}/>
        {target === 'manuscript' ? '包括当前草稿' : '包括构想及待复核记录'}</label>}
      <div><button disabled={!path} onClick={() => save('download')}>下载</button>
        {files.canSaveAs && <button disabled={!path} onClick={() => save('saveAs')}>另存为…</button>}</div>
    </fieldset>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </main>
}

export function apply(ctx) {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'lg-export' },
    () => <ExportPanel files={ctx.fileActions}/>))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'lg-export', order: 25, label: () => '作品导出',
  }, () => <span aria-hidden="true">↓</span>))
}
