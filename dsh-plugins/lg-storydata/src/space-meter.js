import {lstat,readdir,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {emptyParts} from './space-categories.js'

function category(file) {
  if(file.startsWith('manuscript/'))return 'manuscript'
  if(/^(?:\.literarygiant\/conversation(?:s|-artifacts)|conversations)\//.test(file))return 'chats'
  if(/^\.literarygiant\/story\.sqlite3(?:-wal|-shm|-journal)?$/.test(file))return 'database'
  if(/^(?:ReferenceLibrary\/bible\/characters|notes\/characters)\//.test(file))return 'characters'
  if(/^(?:ReferenceLibrary\/plans\/plots|notes\/plots)\//.test(file))return 'plot'
  if(/^(?:ReferenceLibrary\/bible\/worlds|notes\/(?:world|setting))\//.test(file))return 'setting'
  if(file.startsWith('notes/story-data/'))return 'archives'
  return 'other'
}

// Only metadata is read. Nested registered books are measured by their own pass.
async function bookFiles(root,roots,knownLinks) {
  if(await realpath(root)!==root)throw Error('Book directory changed')
  const parts=emptyParts(),links=new Set(),pending=['']
  let files=0,dbSize=0,walSize=0
  while(pending.length){
    const dir=pending.pop(),absolute=join(root,dir)
    if(await realpath(absolute)!==absolute)throw Error('Book directory changed')
    const entries=await readdir(absolute,{withFileTypes:true})
    for(let at=0;at<entries.length;at+=32){
      const group=entries.slice(at,at+32).filter(e=>e.isDirectory()||e.isFile())
      const stats=await Promise.all(group.map(e=>lstat(join(absolute,e.name),{bigint:true})))
      for(const [i,entry] of group.entries()){
        const file=dir?dir+'/'+entry.name:entry.name,stat=stats[i]
        if(stat.isDirectory()){if(!roots.has(join(root,file)))pending.push(file);continue}
        if(!stat.isFile())continue
        if(stat.nlink>1n){
          const id=stat.dev+':'+stat.ino
          if(knownLinks.has(id)||links.has(id))continue
          links.add(id)
        }
        const bytes=Number(stat.size)
        parts[category(file)]+=bytes;files++
        if(file==='.literarygiant/story.sqlite3')dbSize=bytes
        if(file==='.literarygiant/story.sqlite3-wal')walSize=bytes
      }
    }
  }
  return {parts,files,dbSize,walSize,links}
}

function bookState(db,{parts,dbSize,walSize}) {
  const chapters=db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind='chapter' AND state NOT IN ('candidate','rejected','archived')").get().n
  if(dbSize && !walSize){
    // dbstat reports whole allocated table/index pages. Shared pages, freelists
    // and unsupported SQLite builds keep their bytes under Database.
    const tables=db.prepare("SELECT name,tbl_name FROM sqlite_schema WHERE (tbl_name GLOB 'lg_outline_*' OR tbl_name GLOB 'lg_story_data_*') AND type IN ('table','index')").all()
    let pages
    try { pages=db.prepare('SELECT pgsize FROM dbstat WHERE aggregate=1 AND name=?') }
    catch(error){if(!/no such table: dbstat/i.test(error.message))throw error}
    const split={main:0,archives:0}
    if(pages)for(const table of tables){
      split[table.tbl_name.startsWith('lg_outline_')?'main':'archives']+=pages.get(table.name)?.pgsize??0
    }
    const assigned=split.main+split.archives
    if(assigned<=dbSize){parts.database-=assigned;parts.main+=split.main;parts.archives+=split.archives}
  }
  return chapters
}

const keyOf=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function measureShelf(books,segments) {
  const shelf=books.list({includeArchived:true}),roots=new Set(shelf.map(b=>b.path)),parts=emptyParts()
  const measured=[],unavailable=[],links=new Set()
  let files=0
  for(const book of [...shelf].sort((a,b)=>String(a.path).localeCompare(String(b.path)))){
    if(book.error){unavailable.push(book.name||'Unknown book');continue}
    try {
      const stats=await bookFiles(book.path,roots,links)
      const chapters=books.readState(book.path,db=>bookState(db,stats))
      let plots=null
      if(segments){
        try {
          const n=await segments.count(book.path)
          if(Number.isSafeInteger(n)&&n>=0)plots=n
        } catch { /* The storage and chapter measurements remain available. */ }
      }
      measured.push({id:book.id||book.path,chapters,plots})
      for(const key of Object.keys(parts))parts[key]+=stats.parts[key]
      for(const id of stats.links)links.add(id)
      files+=stats.files
    } catch {unavailable.push(book.name||'Unknown book')}
  }
  measured.sort((a,b)=>a.id.localeCompare(b.id))
  function position(field){
    if(!measured.length||measured.some(book=>book[field]===null))return null
    return {mark:keyOf(measured.map(b=>[b.id,b[field]])),position:measured.reduce((sum,b)=>sum+b[field],0)}
  }
  return {parts,files,bookCount:measured.length,unavailable,shelfKey:keyOf(measured.map(b=>b.id)),
    chapter:position('chapters'),plot:position('plots')}
}
