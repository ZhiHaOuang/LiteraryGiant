import React,{useRef,useState} from 'react'
import {Card,number} from './charts.jsx'
import {requestBooks} from './api.js'
import styles from './book-progress.css'

export function BookProgress({books,shelf,loading,l,onOpenBook,onRefresh,cost,lastActivity,time}){
 const [status,setStatus]=useState('active')
 const [form,setForm]=useState(null),[name,setName]=useState(''),[path,setPath]=useState(''),[preview,setPreview]=useState(null)
 const [selection,setSelection]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const lock=useRef(false),operation=useRef(null),panel=useRef(null)
 const focus=()=>requestAnimationFrame(()=>panel.current?.querySelector('input,button')?.focus())
 const open=mode=>{setForm(mode);setSelection(null);setPreview(null);setError('');setNotice('');setName('');setPath('');focus()}
 const choose=(book,action)=>{setSelection({book,action});setForm(null);setError('');setNotice('');focus()}
 const close=()=>{setForm(null);setSelection(null);setPreview(null);setError('')}
 const target=path.trim()||(form==='create'&&name.trim()?shelf.booksPath.replace(/\/$/,'')+'/'+name.trim().replace(/[\\/]/g,'-'):'')
 async function run(task){
  if(lock.current)return
  lock.current=true;setBusy(true);setError('')
  try{await task()}catch(e){setError(e.message)}finally{lock.current=false;setBusy(false)}
 }
 async function finish(message){close();setNotice(message);await onRefresh()}
 const labels={archive:l('归档','Archive'),restore:l('恢复','Restore'),remove:l('移出','Remove')}
 const visible=books.filter(book=>status==='all'||!!book.archived===(status==='archived'))
  .sort((a,b)=>(lastActivity(b)||0)-(lastActivity(a)||0))
 return <Card title={l('作品进度','Book Progress')} className="lgg-book-progress" meta={<span className="lgg-book-header-actions">
  <span className="lgd-segment" role="group" aria-label={l('书架状态','Book Status')}>{[['active',l('进行中','Active')],['archived',l('已归档','Archived')],['all',l('全部','All')]].map(([key,label])=><button key={key} aria-pressed={status===key} onClick={()=>setStatus(key)}>{label}</button>)}</span>
  <span className="lgd-segment"><button disabled={busy} onClick={()=>open('create')}>＋ {l('新增书籍','Add Book')}</button></span>
 </span>}>
  <style>{styles}</style>
  {!!shelf.workspaceErrors?.length&&<p role="alert" className="lgd-error">{l('书架已保存，侧栏同步未完成：','Shelf saved; sidebar sync incomplete: ')}{shelf.workspaceErrors.map(item=>item.error).join(' · ')} <button disabled={busy} onClick={()=>void run(onRefresh)}>{l('重试','Retry')}</button></p>}
  {form&&<form ref={panel} className="lgg-book-form" aria-label={l('新增书籍','Add Book')} onSubmit={e=>{e.preventDefault();void run(async()=>{
   if(form==='add'){await requestBooks({action:'add',path:target});await finish(l('作品已添加到书架。','Book added to the shelf.'));return}
   if(!preview){const value=await requestBooks({action:'create-preview',path:target,name:name.trim()});operation.current=crypto.randomUUID();setPreview(value);return}
   await requestBooks({action:'create',path:preview.path,name:preview.name,token:preview.token,operation:operation.current})
   await finish(l('新作品已创建。','Book created.'))
  })}}>
   <fieldset disabled={busy}>
    <div className="lgd-segment"><button type="button" aria-pressed={form==='create'} onClick={()=>open('create')}>{l('新建作品','Create New')}</button><button type="button" aria-pressed={form==='add'} onClick={()=>open('add')}>{l('添加已有作品','Add Existing')}</button></div>
    {form==='create'&&<label>{l('作品名称','Book Name')}<input required maxLength={200} value={name} onChange={e=>{setName(e.target.value);setPreview(null)}}/></label>}
    <label>{l('作品目录','Book Folder')}<input required value={target} placeholder={shelf.booksPath+'/…'} onChange={e=>{setPath(e.target.value);setPreview(null)}}/></label>
    <small>{form==='create'?l('在不存在或空目录中创建作品；已有内容不会被覆盖。','Creates a book in a new or empty folder; existing content is never overwritten.'):l('选择已有 LG 作品的绝对目录，包含 .literarygiant/project.json。','Enter an existing LG book folder containing .literarygiant/project.json.')}</small>
    {preview&&<div className="lgg-book-confirm"><strong>{preview.name}</strong><span>{preview.path}</span><small>{l('将创建作品数据库和基础资料。','Creates the book database and starter notes.')}</small></div>}
    <div className="lgg-book-buttons"><button type="button" onClick={close}>{l('取消','Cancel')}</button><button type="submit">{busy?l('处理中…','Working…'):form==='add'?l('添加到书架','Add to Shelf'):preview?l('确认创建','Confirm Creation'):l('预览创建','Preview Creation')}</button></div>
   </fieldset>
  </form>}
  {selection&&<section ref={panel} className="lgg-book-form" aria-label={l('确认书架操作','Confirm Shelf Action')}>
   <strong>{labels[selection.action]} · {selection.book.name}</strong>
   <p>{selection.action==='remove'?l('仅从书架和侧栏移除登记；作品文件、正文、数据库和对话均保留。需要时可通过“添加已有作品”重新加入。','Removes this book from the shelf and sidebar. Files, manuscripts, databases and conversations remain; use Add existing to bring it back.'):selection.action==='archive'?l('移到“已归档”列表并隐藏侧栏入口，之后可以恢复；作品文件和对话保留。','Moves this book to Archived and hides its sidebar entry. You can restore it later; files and conversations remain.'):l('将作品恢复到“进行中”列表。','Returns this book to the Active list.')}</p>
   <div className="lgg-book-buttons"><button disabled={busy} onClick={close}>{l('取消','Cancel')}</button><button disabled={busy} onClick={()=>void run(async()=>{const {book,action}=selection;await requestBooks({action,path:book.path,id:book.id,confirmed:true});await finish(l('书架已更新。','Shelf updated.'))})}>{busy?l('处理中…','Working…'):l('确认','Confirm')+' '+labels[selection.action]}</button></div>
  </section>}
  {error&&<p role="alert" className="lgd-error">{error}</p>}{notice&&<p role="status" className="lgd-muted">{notice}</p>}
  <div className="lgg-book-table"><table><thead><tr>{[l('作品','Book'),l('状态','Status'),l('有正文章节','Written Chapters'),l('正文字数','Words'),l('已采用','Accepted'),l('区间费用 · 估算','Period cost · est.'),l('待审候选','Candidates'),l('最近活动','Last Activity'),l('整理','Manage')].map((label,i)=><th key={label} data-column={['book','status','chapters','words','accepted','cost','candidates','activity','manage'][i]}>{label}</th>)}</tr></thead>
   <tbody>{visible.map(book=><tr key={book.path}><td data-column="book"><button className="lgg-book-link" title={book.name} onClick={()=>onOpenBook(book.path)}>{book.name}</button></td><td data-column="status">{book.archived?l('已归档','Archived'):l('进行中','Active')}</td><td data-column="chapters">{book.written} / {book.chapters.length}</td><td data-column="words">{number(book.words)}</td><td data-column="accepted">{number(book.acceptedWords)}</td><td data-column="cost">{cost(book)}</td><td data-column="candidates">{number(book.counts.candidates)}</td><td data-column="activity">{time(lastActivity(book))}</td><td data-column="manage"><div className="lgd-segment lgg-book-row-actions" role="group" aria-label={book.name}><button disabled={busy} aria-pressed={selection?.book.path===book.path&&selection.action===(book.archived?'restore':'archive')} onClick={()=>choose(book,book.archived?'restore':'archive')}>{labels[book.archived?'restore':'archive']}</button><button disabled={busy} aria-pressed={selection?.book.path===book.path&&selection.action==='remove'} onClick={()=>choose(book,'remove')}>{labels.remove}</button></div></td></tr>)}</tbody>
  </table></div>
  {!visible.length&&<p className="lgg-empty">{loading?l('正在读取作品…','Loading books…'):l('暂无匹配作品，可切换状态筛选或新增书籍。','No matching books. Change the status filter or add a book.')}</p>}
 </Card>
}
