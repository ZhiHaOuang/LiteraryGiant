import React, { useEffect, useRef, useState } from 'react'
import { mirrorStatus } from '../../lg-books/src/mirror-status.js'
import { ReviewPanel } from '../../lg-review/src/panel.jsx'
import { GeneratePlan } from './generate.jsx'
import { PlanningForm, initial, labels, cardFields, cardOf } from './forms.jsx'
export const inject = ['slots', 'locale']
const sections = { structure: '卷／章骨架', decisions: '创作方向', scenes: '场景与计划' }
async function request(endpoint, input, signal) {
  const response = await fetch(`api/lg/${endpoint}`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const result = await response.json()
  if (!result.ok) throw new Error(result.error ?? '规划请求失败')
  return result.value
}
function Record({ item }) {
  if (!item) return <p>无现有记录</p>
  if (item.error) return <p role="alert">{item.error}</p>
  if (item.topic) return <div><h3>{item.title ?? item.topic.key}</h3><small>{item.topic.scope} · {item.topic.key} · 来源 {item.source_status ?? '见预览'} · 当前记录第 {item.version_number ?? '新'} 版</small>
    <p>当前选择：{item.selection ? `${item.selection.title}\n${item.selection.content}` : '未选择或已撤回'}</p>
    <details><summary>候选方向（第 {item.options_version_number} 版）</summary>{item.options.map(option => <p key={option.id}>{option.id} · {option.title}<br/>{option.content}</p>)}</details></div>
  if ('plan_state' in item) return <div><h3>{item.title ?? '场景设计'}</h3><small>状态 {item.status} · 计划 {item.plan_state}</small>
    <dl>{Object.entries(cardFields).filter(([key]) => item[key]).map(([key,label]) => <React.Fragment key={key}><dt>{label}</dt><dd>{item[key]}</dd></React.Fragment>)}</dl>
    <p>当前计划：{item.plan || '尚无'}</p>{item.metadata?.lg_plan_proposal && <p>待审替换计划：{item.metadata.lg_plan_proposal.plan}</p>}</div>
  return <div><h3>{item.title}</h3><p>{item.kind === 'part' ? '卷' : '章'} · 顺序 {item.sequence ?? '未定'} · {item.state ?? '空骨架'}</p></div>
}
function ChapterFileResults({ files, locked, retry }) {
  if (!files?.length) return null
  return <aside aria-label="章节文件同步" role="status">{files.map(file => <div key={file.chapter}>
    <p>章节 #{file.chapter} · {mirrorStatus(file)}</p>
    {file.sync === 'mirror-pending' && <button disabled={locked} onClick={() => retry(file)}>重试章节 #{file.chapter} 同步</button>}
  </div>)}</aside>
}

function DraftDirection({item,documents,open,disabled}) {
  const [chosen,setChosen]=useState('')
  const topic=item.topic
  const chapters=documents.filter(d=>d.kind==='chapter'&&(topic.scope!=='part'||d.parent_id===topic.document_id))
  const chapter=topic.scope==='chapter'?topic.document_id:Number(chosen)
  return <>
    {topic.scope!=='chapter'&&<label>方向起草目标章<select value={chosen} disabled={disabled} onChange={e=>setChosen(e.target.value)}>
      <option value="">选择目标章</option>{chapters.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select></label>}
    <button disabled={disabled||!chapter} onClick={()=>open(chapter,item)}>按此方向起草章节</button>
  </>
}

function Planning({getWorkflows}) {
  const [books, setBooks] = useState([]), [path, setPath] = useState(''), [section, setSection] = useState('structure')
  const [data, setData] = useState(null), [documents, setDocuments] = useState([]), [editor, setEditor] = useState(null), [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [history, setHistory] = useState(null), [rolling, setRolling] = useState(null)
  const [generation, setGeneration] = useState(null)
  const [reviewTarget, setReviewTarget] = useState(null)
  const [chapterFiles,setChapterFiles] = useState([])
  const active = useRef(null)
  async function load(nextPath, nextSection = section, offset = 0) {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setBusy(true); setError(''); setHistory(null); setRolling(null); setChapterFiles([])
    try {
      const list = await request('books', { action: 'list' }, controller.signal), chosen = nextPath || list.find(book => !book.error)?.path || ''
      if (controller.signal.aborted) return
      const [page, docs] = chosen ? await Promise.all([
        request('planning', { action: 'list', path: chosen, section: nextSection, offset }, controller.signal),
        request('planning', { action: 'documents', path: chosen }, controller.signal),
      ]) : [null, []]
      if (controller.signal.aborted) return
      setBooks(list); setPath(chosen); setSection(nextSection); setData(page); setDocuments(docs)
    } catch (error) { if (!controller.signal.aborted) setError(error.message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  useEffect(() => { void load(''); return () => active.current?.abort() }, [])
  const edit = change => { setEditor({ change, key: crypto.randomUUID() }); setError('') }
  async function prepare(change) {
    setBusy(true); setError('')
    try { setPreview({ change, operation: crypto.randomUUID(), ...await request('planning', { action: 'preview', path, change }) }) }
    catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  async function apply() {
    setBusy(true); setError('')
    try {
      const result = await request('planning', { action: 'apply', path, change: preview.change, token: preview.token, operation: preview.operation })
      setPreview(null); setEditor(null); await load(path); setChapterFiles(result.chapterFiles ?? [])
    } catch (error) { setError(error.message + '。结果未确认时可以原操作重试。'); setBusy(false) }
  }
  async function retryFile(file) {
    setBusy(true); setError('')
    try {
      const updated = await request('books',{action:'chapter-file-retry',path,document:file.chapter,operation:file.operation})
      const replace = list => list.map(item => item.operation === file.operation ? updated : item)
      setChapterFiles(replace)
      setHistory(value => value && {...value,operations:value.operations.map(op => op.result.chapterFiles
        ? {...op,result:{...op.result,chapterFiles:replace(op.result.chapterFiles)}} : op)})
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  async function inspect(input, setter) {
    setBusy(true); setError('')
    try { setter(await request('planning', { path, ...input })) } catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  const locked = busy || !!editor || !!preview || !!generation || !!reviewTarget
  return <main className="lgp-page"><style>{`
    .lgp-page{padding:28px;max-width:1120px;margin:auto;height:100%;overflow:auto;color:var(--foreground,inherit)}
    .lgp-row,.lgp-page nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}.lgp-page label{display:flex;flex-direction:column;gap:6px;margin:12px 0}
    .lgp-page input,.lgp-page select,.lgp-page textarea,.lgp-page button{padding:8px;border:1px solid #8885;border-radius:7px;background:transparent;color:inherit}
    .lgp-page textarea{min-height:85px;resize:vertical}.lgp-page article,.lgp-page aside,.lgp-page fieldset{border:1px solid #8884;border-radius:10px;padding:16px;margin:14px 0;min-width:0}
    .lgp-page p,.lgp-page dd{white-space:pre-wrap;overflow-wrap:anywhere}.lgp-page dd{margin:4px 0 10px}.lgp-page dt,.lgp-page small{opacity:.7}.lgp-page [role=alert]{color:#c96551}.lgp-page button:disabled{opacity:.5}.lgp-page [aria-current=true]{font-weight:700;border-color:currentColor}
  `}</style><small>LITERARYGIANT</small><h1>故事规划</h1><p>远期保留骨架，近期逐步细化。方向选择、场景批准与正文采用分别处理。</p>
    <div className="lgp-row"><select aria-label="规划作品" value={path} disabled={locked} onChange={e => load(e.target.value)}><option value="">选择作品</option>{books.filter(book => !book.error).map(book => <option key={book.path} value={book.path}>{book.name}</option>)}</select>
      <button disabled={locked} onClick={() => load(path)}>刷新</button></div>
    <nav>{Object.entries(sections).map(([key,label]) => <button key={key} disabled={locked} aria-current={section === key} onClick={() => load(path,key)}>{label}</button>)}</nav>
    <button disabled={locked || !path} onClick={() => edit(initial(section))}>{section === 'decisions' ? '新增创作方向' : section === 'scenes' ? '新增场景卡' : '新增骨架'}</button>
    {section === 'decisions' && <button disabled={locked || !path} onClick={() => setGeneration({ task: 'ideas', target: { slug: '', title: '', expected_version_id: 0, topic: { scope: 'work', document_id: null, key: '' } } })}>Agent 构思新方向</button>}
    {reviewTarget && <ReviewPanel path={path} target={reviewTarget} onClose={() => { setReviewTarget(null); void load(path) }} onRevise={value => { setReviewTarget(null); setGeneration(value) }}/>}
    {generation && <GeneratePlan key={generation.task + ':' + (generation.target.id ?? generation.target.slug)} path={path} documents={documents} {...generation} onClose={() => { setGeneration(null); void load(path) }}/>} 
    <ChapterFileResults files={chapterFiles} locked={locked} retry={retryFile}/>
    {error && <p role="alert">{error}</p>}
    {editor && !preview && <PlanningForm key={editor.key} change={editor.change} documents={documents} onPreview={prepare} onCancel={() => setEditor(null)} disabled={busy}/>}
    {preview && <aside><h2>{labels[preview.change.action]} · 作者确认</h2><h3>变更前</h3><Record item={preview.value.before}/><h3>变更后</h3><Record item={preview.value.after}/>
      {preview.value.sources && <p>来源状态：{preview.value.sources.status}。创作方向不自动成为正式事实。</p>}
      <div className="lgp-row"><button disabled={busy} onClick={apply}>确认提交</button><button disabled={busy} onClick={() => setPreview(null)}>返回修改</button></div></aside>}
    {data && <><p>{sections[section]} · 共 {data.total} 项</p>{data.items.map(item => <article key={item.document_id ?? item.id}><Record item={item}/>
      {!item.error && <div className="lgp-row">
        {section === 'decisions' && <><button disabled={locked} onClick={() => setReviewTarget({ section: 'decisions', id: item.document_id, version_id: item.version_id })}>审阅与要求改稿</button><button disabled={locked} onClick={() => setGeneration({ task: 'ideas', target: { slug: item.slug, title: item.title, topic: item.topic, expected_version_id: item.version_id } })}>Agent 生成三方案</button><button disabled={locked} onClick={() => edit({ action: 'decision.options', slug: item.slug, title: item.title, topic: item.topic, options: item.options, sources: item.sources, request: item.request, expected_version_id: item.version_id })}>修订候选方向</button>
          <button disabled={locked} onClick={() => edit({ action: 'decision.select', id: item.document_id, expected_version_id: item.version_id, options_version_number: item.options_version_number, option_id: item.options[0].id })}>选择方案</button>
          {item.selection && <button disabled={locked} onClick={() => edit({ action: 'decision.withdraw', id: item.document_id, expected_version_id: item.version_id })}>撤回选择</button>}
          {item.selection&&['current','unbound'].includes(item.source_status)&&getWorkflows()&&<DraftDirection item={item} documents={documents} disabled={locked}
            open={(chapter,d)=>{try{getWorkflows().draftFromDirection(path,chapter,d)}catch(e){setError(e.message)}}}/>}</>}
        {section === 'scenes' && <><button disabled={locked || !item.plan && !item.metadata.lg_plan_proposal} onClick={() => setReviewTarget({ section: 'scenes', id: item.document_id, token: item.token })}>审阅与要求改稿</button><button disabled={locked} onClick={() => setGeneration({ task: 'scene-plan', target: { id: item.document_id, expected_token: item.token } })}>Agent 生成场景计划</button><button disabled={locked} onClick={() => edit({ action: 'scene.update', id: item.document_id, expected_token: item.token, card: cardOf(item) })}>修改场景卡</button>
          <button disabled={locked} onClick={() => edit({ action: 'scene.move', id: item.document_id, expected_token: item.token, chapter_id: item.chapter_id, sequence: item.sequence })}>调整归属／顺序</button>
          <button disabled={locked} onClick={() => edit({ action: 'scene.plan', id: item.document_id, expected_token: item.token, plan: item.metadata.lg_plan_proposal?.plan ?? item.plan })}>提交新计划</button>
          {(item.metadata.lg_plan_proposal || item.plan_state === 'candidate') && <button disabled={locked} onClick={() => edit({ action: 'scene.approve', id: item.document_id, expected_token: item.token })}>审阅并批准</button>}
          {item.metadata.lg_plan_proposal && <button disabled={locked} onClick={() => edit({ action: 'scene.discard', id: item.document_id, expected_token: item.token })}>放弃待审计划</button>}
          <button disabled={locked} onClick={() => edit({ action: 'scene.drafted', id: item.document_id, expected_token: item.token })}>标记已起草</button></>}
        {section === 'structure' && <button disabled={locked} onClick={() => edit({ action: 'structure.update', id: item.id, expected_token: item.token, kind: item.kind, title: item.title, parent_id: item.parent_id, sequence: item.sequence })}>调整骨架</button>}
        {section === 'structure' && item.kind === 'chapter' && <button disabled={locked} onClick={() => inspect({ action: 'window', chapter_id: item.id, horizon: 3 },setRolling)}>查看近期三章</button>}
        <button disabled={locked} onClick={() => inspect({ action: 'history', id: item.document_id ?? item.id },value => setHistory({ ...value, id: item.document_id ?? item.id }))}>历史</button>
      </div>}</article>)}<nav><button disabled={locked || !data.offset} onClick={() => load(path,section,Math.max(0,data.offset - 10))}>上一页</button>
      <button disabled={locked || data.nextOffset == null || data.nextOffset === data.offset} onClick={() => load(path,section,data.nextOffset)}>下一页</button></nav></>}
    {rolling && <aside><h2>近期规划窗口</h2>{rolling.chapters.map(chapter => <p key={chapter.id}>{chapter.sequence} · {chapter.title}</p>)}<p>{rolling.note}</p></aside>}
    {history && <aside><h2>规划历史</h2>{history.versions.map(version => <p key={version.id}>第 {version.version_number} 版 · {version.reason} · {version.created_at}</p>)}
      {history.operations.map(operation => <details key={operation.id}><summary>{labels[operation.action]} · {operation.created_at}</summary><Record item={operation.before}/><Record item={operation.result}/><ChapterFileResults files={operation.result.chapterFiles} locked={locked} retry={retryFile}/></details>)}
      <div className="lgp-row"><button disabled={locked || !history.offset} onClick={() => inspect({ action: 'history', id: history.id, offset: Math.max(0,history.offset - 10) },value => setHistory({ ...value,id:history.id }))}>更新记录</button>
        <button disabled={locked || history.operations.length < 10 && history.versions.length < 10} onClick={() => inspect({ action: 'history', id: history.id, offset: history.offset + 10 },value => setHistory({ ...value,id:history.id }))}>更早记录</button></div></aside>}
  </main>
}
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('lg-planning', { zh: { title: '故事规划' }, en: { title: 'Story planning' } }), 'lg-planning: locale')
  const t = ctx.locale.bind('lg-planning')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'lg-planning', locale: 'lg-planning' }, () => <Planning getWorkflows={()=>ctx.get('literaryWorkflowPanel')}/>))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'lg-planning', order: 19, locale: 'lg-planning', label: () => t('title') }, () => <span aria-hidden="true">⌘</span>))
}
