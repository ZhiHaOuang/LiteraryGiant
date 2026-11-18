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
export function createShelf(config,workspaceRegistry) {
  // Read the previous one-root setting without moving or creating any folders.
  let selected={booksDirectory:config.booksDirectory||(config.rootDirectory?join(config.rootDirectory,'Books'):''),
    libraryDirectory:config.libraryDirectory||(config.rootDirectory?join(config.rootDirectory,'Library'):'')}
  function snapshot() {
    try{return scanShelf(selected)}catch(error){return {booksPath:selected.booksDirectory,libraryPath:selected.libraryDirectory,books:[],unavailable:[],indexes:[],error:error.message}}
  }
  function list() {
    const shelf=snapshot(),seen=new Set(shelf.books.map(b=>b.path))
    const legacy=(config.projects??[]).filter(path=>!seen.has(path)).map(path=>{
      try{return {...describeBook(path),external:true}}catch(error){return {path,error:error.message,external:true}}
    })
    const workspaces=workspaceRegistry()?.list()??[]
    return [...new Map([...shelf.books,...legacy].map(book=>[book.path,book])).values()].map(book=>({...book,workspaceId:workspaces.find(w=>w.path===book.path)?.id}))
  }
  let pending=Promise.resolve()
  function sync() {
    // Serialize refreshes; native create is idempotent by canonical path.
    const task=pending.then(async()=>{
      const registry=workspaceRegistry(),failures=[]
      if(registry)for(const book of list().filter(b=>!b.error)) {
        try{await registry.create(book.path,book.name)}catch(error){failures.push({path:book.path,error:error.message})}
      }
      return {...snapshot(),books:list(),workspaceErrors:failures}
    })
    pending=task.catch(()=>{})
    return task
  }
  return {snapshot,list,sync,setDirectories(value){selected=value}}
}
