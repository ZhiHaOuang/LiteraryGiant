import React,{useEffect,useState} from 'react'
export const inject=['slots']
const sourceName={default:'默认值',legacy:'旧偏好文件（只读兼容）',native:'插件设置'}
async function request(endpoint,input) {
  const response=await fetch(`api/lg/${endpoint}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})
  const result=await response.json();if(!result.ok)throw new Error(result.error??'偏好读取失败');return result.value
}
function Author() {
  const [books,setBooks]=useState([]),[path,setPath]=useState(''),[data,setData]=useState(null),[scope,setScope]=useState('personal')
  const [values,setValues]=useState({name:'作者',detail:'balanced',writing:''}),[inherit,setInherit]=useState(true)
  const [preview,setPreview]=useState(null),[history,setHistory]=useState(null),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  async function work(fn){setBusy(true);setError('');try{await fn()}catch(error){setError(error.message)}finally{setBusy(false)}}
  function edit(value,selectedScope=scope){setValues({...value.personal.values,...(selectedScope==='book'?{writing:value.book.values.writing??value.personal.values.writing}: {})});setInherit(!Object.hasOwn(value.book.values,'writing'));setPreview(null);setDirty(false)}
  async function load(nextPath=path,selectedScope=scope){if(!nextPath)selectedScope='personal';const value=await request('author',{action:'read',path:nextPath});setData(value);setPath(nextPath);setScope(selectedScope);edit(value,selectedScope);setHistory(null)}
  useEffect(()=>{void work(async()=>{const list=await request('books',{action:'list'});setBooks(list);await load(list.find(book=>!book.error)?.path??'')})},[])
  function update(key,value){setValues(old=>({...old,[key]:value}));setDirty(true)}
  async function prepare(){const change={scope,values:scope==='book'?(inherit?{}:{writing:values.writing}):values};setPreview({change,...await request('author',{action:'preview',path,change}),operation:crypto.randomUUID()})}
  const locked=busy||!!preview
  return <main className="lga"><style>{`
    .lga{padding:28px;max-width:1000px;margin:auto;height:100%;overflow:auto}.lga input,.lga select,.lga textarea,.lga button{padding:8px;margin:6px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit}.lga textarea{display:block;width:95%;min-height:180px}.lga aside{padding:16px;margin:18px 0;border:1px solid #8884;border-radius:10px}.lga pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}.lga [role=alert]{color:#c96551}.lga button:disabled{opacity:.5}
  `}</style><small>LITERARYGIANT</small><h1>作者偏好</h1><p>个人默认在当前 DSH profile 的作品间共用；本书可覆盖写作偏好。设置会显示在文学任务的完整模型输入中，单次任务要求优先。</p>
    <label>作品<select value={path} disabled={locked||dirty} onChange={event=>work(()=>load(event.target.value))}><option value="">仅个人设置</option>{books.map(book=><option key={book.path} value={book.path} disabled={!!book.error}>{book.name??book.path}</option>)}</select></label>
    <label>编辑范围<select value={scope} disabled={locked||dirty} onChange={event=>{setScope(event.target.value);edit(data,event.target.value);setHistory(null)}}><option value="personal">个人默认（当前 profile）</option><option value="book" disabled={!path}>本书写作偏好</option></select></label>
    {data&&<><aside><h2>当前生效</h2><p>称呼：{data.effective.name} · 回复详略：{{concise:'简洁',balanced:'适中',detailed:'详细'}[data.effective.detail]}</p><p>写作偏好来自：{data.effective.writingScope==='book'?'本书覆盖':'个人默认'}</p><pre>{data.effective.writing||'未设置写作偏好'}</pre>
      <small>个人：{sourceName[data.personal.source]} · 本书：{sourceName[data.book.source]}。保存新设置不会改写旧偏好文件。</small></aside>
      <fieldset disabled={locked}><legend>{scope==='book'?'本书设置':'个人默认设置'}</legend>
        {scope==='personal'?<><label>称呼<input value={values.name} maxLength={60} onChange={event=>update('name',event.target.value)}/></label><label>回复详略<select value={values.detail} onChange={event=>update('detail',event.target.value)}><option value="concise">简洁</option><option value="balanced">适中</option><option value="detailed">详细</option></select></label></>:<label><input type="checkbox" checked={inherit} onChange={event=>{setInherit(event.target.checked);setDirty(true)}}/>本书继承个人写作偏好</label>}
        <label>写作偏好<textarea value={values.writing} maxLength={16000} disabled={scope==='book'&&inherit} onChange={event=>update('writing',event.target.value)} placeholder="例如：保持克制的叙述，减少解释性独白。"/></label>
        <p>称呼与详略只影响对作者的说明。写作偏好用于创作及审阅，不传给事实提取或资料分析；它们不会自动批准情节或正文。</p>
        <button disabled={!dirty} onClick={()=>work(prepare)}>预览保存</button><button disabled={!dirty} onClick={()=>edit(data)}>放弃本次修改</button>
      </fieldset>
      {preview&&<aside><h2>确认偏好变更</h2><p>{scope==='personal'?'影响当前 profile 中继承个人设置的作品。':inherit?'本书恢复继承个人写作偏好。':'只更改本书写作偏好；空字符串表示明确不使用个人写作偏好。'}</p><pre>{JSON.stringify({before:preview.before.values,after:preview.after},null,2)}</pre>
        <button disabled={busy} onClick={()=>work(async()=>{await request('author',{action:'apply',path,change:preview.change,token:preview.token,operation:preview.operation});await load()})}>确认保存</button><button disabled={busy} onClick={()=>setPreview(null)}>返回编辑</button></aside>}
      <button disabled={locked||dirty} onClick={()=>work(()=>load())}>刷新</button><button disabled={locked} onClick={()=>work(async()=>setHistory(await request('author',{action:'history',path,scope})))}>保存历史</button>
      {history&&<aside><h2>当前范围保存历史</h2>{!history.items.length&&<p>尚无插件保存记录。</p>}{history.items.map(item=><details key={item.operation}><summary>修订 {item.revision} · {item.updatedAt}</summary><pre>{JSON.stringify(item.values,null,2)}</pre></details>)}{history.nextOffset!=null&&<button disabled={locked} onClick={()=>work(async()=>{const next=await request('author',{action:'history',path,scope,offset:history.nextOffset});setHistory({items:[...history.items,...next.items],nextOffset:next.nextOffset})})}>更早记录</button>}</aside>}
    </>}{error&&<p role="alert">{error}</p>}
  </main>
}
export function apply(ctx) {
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'lg-author'},Author))
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'lg-author',order:22,label:()=>'作者偏好'},()=> <span aria-hidden="true">✧</span>))
}
