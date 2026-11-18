import React, { useEffect, useState } from 'react'
import { request } from './api.js'

import { mirrorStatus, states } from '../../lg-books/src/mirror-status.js'
export { mirrorStatus } from '../../lg-books/src/mirror-status.js'

const publicationStates={published:'已发布',pending:'待发布',superseded:'来源已变化'}
export function publicationStatus(receipt) {
  if (receipt.publicationError) return '章节分析待重试：'+receipt.publicationError
  return receipt.publication?'章节分析'+publicationStates[receipt.publication.status]+'。':''
}

const actions = { 'recover-committed':'确认恢复同步基线', 'recover-import':'确认继续原导入', create: '确认建立章节文件', track: '确认登记相同文件', refresh: '确认更新磁盘文件', 'keep-file':'以外部文件保存新版本', 'keep-database':'保留当前作品并备份外部文件', import: '确认导入修改' }

export function ChapterFiles({ path, chapter, onApplied, onLock }) {
  const [view,setView] = useState(null), [error,setError] = useState(''), [result,setResult] = useState(null)
  const [busy,setBusy] = useState(false), [revision,setRevision] = useState(0)
  const [analysis,setAnalysis]=useState(null)
  useEffect(()=>{
    const controller=new AbortController()
    request({action:'analysis-publication',path,document:chapter},controller.signal)
      .then(value=>{if(!controller.signal.aborted)setAnalysis(value)})
      .catch(e=>{if(!controller.signal.aborted&&e.message!=='未知作品操作。')setError(e.message)})
    return ()=>controller.abort()
  },[path,chapter,revision])
  useEffect(() => {
    const controller = new AbortController()
    setView(null); setError('')
    request({ action:'chapter-file-preview', path, document:chapter }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setView({ ...value, operation:crypto.randomUUID() }) })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [path,chapter,revision])

  async function apply(intent) {
    setBusy(true); onLock(true); setError(''); setResult(null)
    try {
      const input = intent === 'retry'
        ? { action:'chapter-file-retry', operation:view.pendingOperation }
        : { action:'chapter-file-apply', token:view.token, intent, operation:view.operation }
      const receipt = await request({ ...input,path,document:chapter })
      setResult(receipt); setRevision(n => n + 1)
      if (receipt.versions?.length) await onApplied()
    } catch (e) { setError(e.message) } finally { setBusy(false); onLock(false) }
  }
  async function publish() {
    setBusy(true);onLock(true);setError('')
    try {setAnalysis(await request({action:'analysis-publication-retry',path,document:chapter,operation:analysis.operation}))}
    catch(e){setError(e.message)}finally{setBusy(false);onLock(false)}
  }
  return <section><h2>章节文件</h2>
    <button disabled={busy} onClick={() => { setResult(null); setRevision(n => n + 1) }}>重新比较</button>
    {view && <><p>{states[view.state]}</p><p><code>{view.path}</code></p>
      {view.problem && <p role="alert">{view.problem}</p>}
      {view.databaseText !== undefined && <details><summary>查看完整文件对照</summary>
        <label>作品当前内容<textarea readOnly value={view.databaseText}/></label>
        {view.fileText !== null && <label>磁盘文件内容<textarea readOnly value={view.fileText}/></label>}</details>}
      {view.changes.map(change => <article key={change.document}><h3>{change.title}</h3>
        <label>当前版本 {change.version}<textarea readOnly value={change.before}/></label>
        <label>外部修改<textarea readOnly value={change.after}/></label></article>)}
      {view.action === 'recover-committed' && <p>已核对原导入的版本来源。此次只登记同步基线，随后可比较磁盘上的后续编辑。</p>}
      {view.action === 'refresh' && <p>更新前会在作品内保留原文件副本。</p>}
      {['import','recover-import'].includes(view.action) && <p>确认后将为 {view.changes.length} 个修改过的章节或场景保存新版本。</p>}
      {view.state === 'conflict' && <p>核对两份内容后选择保留的一方。也可以先在外部编辑器合并段落，再点「重新比较」。</p>}
      {view.resolutions.map(intent => <button key={intent} disabled={busy} onClick={() => apply(intent)}>{actions[intent]}</button>)}
      {view.pendingOperation && <button disabled={busy} onClick={() => apply('retry')}>重试已保存版本的同步</button>}
      {view.action && <button disabled={busy} onClick={() => apply(view.action)}>{actions[view.action]}</button>}
    </>}
    {analysis&&<section aria-label="章节分析发布"><h3>章节分析发布 · 采用版本 {analysis.version}</h3>
      <p role="status">{publicationStatus(analysis)}</p>{analysis.publication.error&&<p>{analysis.publication.error}</p>}
      {analysis.publication.items.map(item=><p key={item.category}>{item.category} · {publicationStates[item.status]}
        {item.error&&' · '+item.error}{item.backup&&' · 原件保存在 '+item.backup}</p>)}
      {analysis.publication.status==='pending'&&<button disabled={busy} onClick={publish}>重试发布章节分析</button>}
    </section>}
    {result && <p role="status">{result.sync ? mirrorStatus(result) : ['import','keep-file','recover-import'].includes(result.action) ? '已导入，新版本数 ' + result.versions.length : result.action === 'recover-committed' ? '已恢复同步基线，新增版本数 0。' : result.backup ? '已更新，原文件保存在 ' + result.backup : '已登记章节文件。'}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
