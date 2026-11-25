export function matchedBook(workspaceId,workspaces,books) {
  const workspace=workspaces.find(item=>item.workspaceId===workspaceId)
  return workspace&&books.find(book=>!book.error&&book.path===workspace.path)
}
export function bindWorkspaceBooks({workspaces,readBooks,openBook,document,window}) {
  let books=[],disposed=false,revision='',timer,controller
  const originals=new Map()
  const find=row=>matchedBook(row.getAttribute('data-row-key').slice('workspace:'.length),workspaces.list.getSnapshot().items??[],books)
  const restore=element=>{
    const attributes=originals.get(element)
    if(!attributes)return
    for(const [key,value] of attributes)value===null?element.removeAttribute(key):element.setAttribute(key,value)
    element.removeAttribute('data-lg-book-link');originals.delete(element)
  }
  const mark=()=>{
    if(disposed)return
    for(const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
      const label=row.querySelector('[data-dsh-claude-part~="row-project-text"]')??row.children[2]
      if(!label)continue
      if(!find(row)){restore(label);continue}
      if(!originals.has(label))originals.set(label,['role','tabindex'].map(key=>[key,label.getAttribute(key)]))
      label.setAttribute('role','link');label.setAttribute('tabindex','0');label.setAttribute('data-lg-book-link','')
    }
    for(const element of originals.keys())if(!element.isConnected)restore(element)
  }
  const refresh=async()=>{
    controller?.abort();controller=new AbortController()
    const current=controller
    try {const value=await readBooks(current.signal);if(!disposed&&!current.signal.aborted){books=value;mark()}}
    catch { /* Keep native workspace behavior when book discovery is unavailable. */ }
  }
  const changed=()=>{
    const next=JSON.stringify((workspaces.list.getSnapshot().items??[]).map(w=>[w.workspaceId,w.path,w.title]))
    if(next===revision)return
    revision=next;clearTimeout(timer);timer=setTimeout(refresh,100)
  }
  const activate=event=>{
    if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return
    if(event.type==='click'&&event.button!==0)return
    if(event.type==='keydown'&&!['Enter',' '].includes(event.key))return
    const label=event.target.closest?.('[data-lg-book-link]')
    if(!label)return
    const row=label.closest('[data-row-key^="workspace:"]'),book=row&&find(row)
    if(!book)return
    event.preventDefault();event.stopPropagation()
    if(row.getAttribute('aria-expanded')==='false') {
      const chevron=row.querySelector('[data-dsh-claude-part~="row-chevron"]')??row.children[1]
      chevron?.click()
    }
    openBook(book.path)
  }
  const observer=new window.MutationObserver(mark)
  observer.observe(document.body,{childList:true,subtree:true})
  document.addEventListener('click',activate,true);document.addEventListener('keydown',activate,true)
  window.addEventListener('focus',refresh)
  const unsubscribe=workspaces.list.subscribe(changed)
  changed()
  return ()=>{
    disposed=true;clearTimeout(timer);controller?.abort();observer.disconnect();unsubscribe()
    document.removeEventListener('click',activate,true);document.removeEventListener('keydown',activate,true);window.removeEventListener('focus',refresh)
    for(const element of originals.keys())restore(element)
  }
}

// Keep native dialogs, but route registered books through their authoritative service.
export function bindBookActions(ctx,requestBooks,onChanged) {
  const find=async workspaceId=>matchedBook(workspaceId,ctx.workspaces.list.getSnapshot().items,await requestBooks({action:'list'}))
  ctx.on('uiWorkspace/rename',async(workspaceId,name,next)=>{
    const book=await find(workspaceId)
    if(!book)return next()
    await requestBooks({action:'rename',path:book.path,projectId:book.id,expectedName:book.name,name})
    onChanged()
  })
  ctx.on('uiWorkspace/delete',async(workspaceId,next)=>{
    const book=await find(workspaceId)
    if(!book)return next()
    const shelf=await requestBooks({action:'remove',path:book.path,id:book.id,confirmed:true})
    onChanged()
    if(shelf.workspaceErrors?.length)throw Error(shelf.workspaceErrors.map(item=>item.error).join(' · '))
  })
}
