import {existsSync,lstatSync,realpathSync,opendirSync} from 'node:fs'
import {isAbsolute,join} from 'node:path'
import {describeBook} from './read.js'

function directory(path) {
  if(typeof path!=='string'||!isAbsolute(path))throw Error('请选择已存在的绝对目录。')
  const resolved=realpathSync(path)
  if(!lstatSync(resolved).isDirectory())throw Error('所选路径不是文件夹。')
  return resolved
}
/** Both selected folders already exist; choosing them never creates nested directories. */
export function prepareDirectories({booksDirectory,libraryDirectory}) {
  const booksPath=directory(booksDirectory),libraryPath=directory(libraryDirectory)
  if(booksPath===libraryPath)throw Error('Books 创作目录与 Library 参考库请选择不同的文件夹。')
  return {booksDirectory:booksPath,libraryDirectory:libraryPath}
}
export function scanShelf(selected) {
  if(!selected.booksDirectory&&!selected.libraryDirectory)return {booksPath:'',libraryPath:'',books:[],unavailable:[],indexes:[]}
  const valid=prepareDirectories(selected),booksPath=valid.booksDirectory,libraryPath=valid.libraryDirectory
  const books=[],unavailable=[],handle=opendirSync(booksPath)
  let count=0
  try {
    let entry
    while((entry=handle.readSync())) {
      if(entry.name.startsWith('.'))continue
      if(++count>2000)throw Error('Books 下项目超过 2000 个，请缩小创作目录。')
      if(!entry.isDirectory()&&!entry.isSymbolicLink())continue
      const bookPath=join(booksPath,entry.name)
      try {
        if(entry.isSymbolicLink())throw Error('不自动加载符号链接目录。')
        books.push(describeBook(bookPath))
      } catch(error){unavailable.push({path:bookPath,name:entry.name,error:error.message})}
    }
  } finally{handle.closeSync()}
  books.sort((a,b)=>a.name.localeCompare(b.name))
  const indexes=['AbstractLibrary/pattern_index.jsonl','AbstractLibrary/instance_index.jsonl','indexes/abstract_index.jsonl','BridgeIndex/books'].map(name=>({name,available:existsSync(join(libraryPath,name))}))
  return {booksPath,libraryPath,books,unavailable,indexes}
}
export function createShelf(config,workspaceRegistry,persist) {
  // Read the previous one-root setting without moving or creating any folders.
  let selected={booksDirectory:config.booksDirectory||(config.rootDirectory?join(config.rootDirectory,'Books'):''),
    libraryDirectory:config.libraryDirectory||(config.rootDirectory?join(config.rootDirectory,'Library'):'')}
  let catalog={projects:config.projects??[],archivedProjects:config.archivedProjects??[],removedProjects:config.removedProjects??[],shelvedWorkspaces:config.shelvedWorkspaces??[]}
  function snapshot() {
    try{return scanShelf(selected)}catch(error){return {booksPath:selected.booksDirectory,libraryPath:selected.libraryDirectory,books:[],unavailable:[],indexes:[],error:error.message}}
  }
  function list({includeArchived=false}={}) {
    const shelf=snapshot(),seen=new Set(shelf.books.map(b=>b.path))
    const legacy=(catalog.projects??[]).filter(path=>!seen.has(path)).map(path=>{
      try{return {...describeBook(path),external:true}}catch(error){return {path,error:error.message,external:true}}
    })
    const workspaces=workspaceRegistry()?.list()??[]
    return [...new Map([...shelf.books,...legacy].map(book=>[book.path,book])).values()].filter(book=>!catalog.removedProjects.includes(book.path)&&(includeArchived||!catalog.archivedProjects.includes(book.path))).map(book=>({...book,archived:catalog.archivedProjects.includes(book.path),workspaceId:workspaces.find(w=>w.path===book.path)?.id}))
  }
  let pending=Promise.resolve()
  function sync() {
    // Serialize reconciliation. Only explicit shelf exclusions remove registrations;
    // native delete retains directories and session logs. Save grouping before removal.
    const task=pending.then(async()=>{
      const registry=workspaceRegistry(),failures=[]
      if(registry) {
        const hidden=new Set([...catalog.archivedProjects,...catalog.removedProjects])
        for(const workspace of registry.list().filter(w=>hidden.has(w.path))) {
          try {
            const previous=catalog.shelvedWorkspaces.find(w=>w.path===workspace.path)
            const backup={path:workspace.path,title:workspace.title,sessionIds:[...new Set([...(workspace.sessionIds??[]),...(previous?.sessionIds??[])])]}
            if(!persist)throw Error('无法保存 workspace 会话关联，尚未移除侧栏登记。')
            if(JSON.stringify(previous)!==JSON.stringify(backup))await persist(current=>({...current,shelvedWorkspaces:[...(current.shelvedWorkspaces??[]).filter(w=>w.path!==backup.path),backup]}))
            await registry.delete(workspace.id)
          }catch(error){failures.push({path:workspace.path,error:error.message})}
        }
        for(const book of list().filter(b=>!b.error)) {
          try {
            const backup=catalog.shelvedWorkspaces.find(w=>w.path===book.path)
            const workspace=await registry.create(book.path,book.name)
            if(backup) {
              // attachSession prepends; reverse traversal restores the saved order.
              for(const id of [...backup.sessionIds].reverse())if(!workspace.sessionIds.includes(id))await workspace.attachSession(id)
              await persist(current=>({...current,shelvedWorkspaces:(current.shelvedWorkspaces??[]).filter(w=>w.path!==book.path)}))
            }
          }catch(error){failures.push({path:book.path,error:error.message})}
        }
      }
      return {...snapshot(),books:list({includeArchived:true}),workspaceErrors:failures}
    })
    pending=task.catch(()=>{})
    return task
  }
  return {snapshot,list,sync,setCatalog(value){catalog={projects:value.projects??[],archivedProjects:value.archivedProjects??[],removedProjects:value.removedProjects??[],shelvedWorkspaces:value.shelvedWorkspaces??[]}},setDirectories(value){selected=value}}
}
