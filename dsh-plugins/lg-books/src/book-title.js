import {randomUUID} from 'node:crypto'
import {readFileSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs'
import {containedFile,openBook} from './read.js'

export function bookName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('请填写 1–200 字的作品名称。')
  return value.trim()
}

export function renameBook(directory,{projectId,expectedName,name}) {
  const title=bookName(name)
  const book=openBook(directory,{write:true})
  try {
    const project=book.project
    if (project.project_id!==projectId) throw new Error('作品标识已变化，请刷新。')
    if (typeof expectedName!=='string' || (project.name!==expectedName && project.name!==title)) throw new Error('书名已变化，请刷新后再修改。')
    const manifest=containedFile(book.root,'.literarygiant/project.json')
    const previous=readFileSync(manifest,'utf8')
    const updated=project.name===title?project:{...project,name:title,updated_at:new Date().toISOString()}
    const contents=JSON.stringify(updated,null,2)+'\n'
    // The manifest is authoritative. Replaying a completed rename also reconciles its SQLite mirror.
    book.db.prepare("INSERT INTO project_meta(key,value) VALUES ('project_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(title)
    book.verify()
    if (updated===project) book.db.exec('COMMIT')
    else {
      const temp=manifest+'.'+randomUUID()+'.tmp', options={flag:'wx',mode:statSync(manifest).mode & 0o777}
      try {
        writeFileSync(temp,contents,options)
        book.verify()
        renameSync(temp,manifest)
        try { book.db.exec('COMMIT') }
        catch (error) {
          if (readFileSync(manifest,'utf8')===contents) {
            writeFileSync(temp,previous,options)
            renameSync(temp,manifest)
          }
          throw error
        }
      } finally { rmSync(temp,{force:true}) }
    }
    return {id:projectId,path:book.root,name:title,updatedAt:updated.updated_at}
  } finally { book.close() }
}
