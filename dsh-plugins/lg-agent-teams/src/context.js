import {realpathSync} from 'node:fs'
import {hash,text} from './contracts.js'

/** Only the active registered book is admissible. No model-supplied filesystem path. */
export function bookForAgent(books,agent){
  const cwd=agent?.ctx?.get?.('workingDirectory')?.get(agent.session)??agent?.session?.header?.cwd
  if(!cwd)return null
  let root;try{root=realpathSync(cwd)}catch{return null}
  return books.list().find(b=>!b.error&&b.path===root)??null
}

/** Read only explicitly selected chapters; never materialize the rest of the manuscript. */
export function prepareSource(books,path,input){
  text(input.brief,'作者要求',8000)
  if(!Array.isArray(input.chapters)||!input.chapters.length||input.chapters.length>8||new Set(input.chapters).size!==input.chapters.length
    ||input.chapters.some(n=>!Number.isSafeInteger(n)||n<1))throw Error('一次选择 1—8 个不重复章节号')
  if(!Number.isSafeInteger(input.through_chapter)||input.through_chapter<Math.max(...input.chapters))throw Error('阅读截止章不能早于所选章节')
  const min_han=input.min_han??0,max_han=input.max_han??20000
  if(!Number.isSafeInteger(min_han)||!Number.isSafeInteger(max_han)||min_han<0||max_han<1||max_han>20000||min_han>max_han)throw Error('汉字范围无效')
  const source=books.readState(path,db=>{
    const all=db.prepare("SELECT id,active_version_id FROM documents WHERE kind='chapter' AND state NOT IN ('archived','rejected','candidate') ORDER BY sequence,id").all()
    if(input.through_chapter>all.length)throw Error('阅读截止章超出作品')
    const chapters=input.chapters.slice().sort((a,b)=>a-b).map(n=>{
      const row=all[n-1];if(!row)throw Error('章节不存在')
      const v=db.prepare('SELECT d.title,v.content,v.id AS version_id FROM documents d JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id WHERE d.id=?').get(row.id)
      if(!v||!v.content.trim())throw Error('所选章节缺少正文：'+n)
      // Same paragraph convention as lg-books/story-data/validate.js: each non-empty line.
      return {number:n,document_id:row.id,version_id:v.version_id,title:v.title,sha256:hash(v.content),paragraphs:v.content.split(/\r?\n/u).map(s=>s.trim()).filter(Boolean)}
    })
    const book_id=db.prepare("SELECT value FROM project_meta WHERE key='project_id'").get()?.value
    if(!book_id)throw Error('作品标识缺失')
    return {schema:'lg.team-source.v1',book_id,path,brief:input.brief,through_chapter:input.through_chapter,chapters,constraints:{min_han,max_han}}
  })
  let total=0;const records=[],selected=new Set(source.chapters.map(c=>c.document_id))
  // Bounded pagination, no silently truncated context. Candidate facts keep their status.
  for(let offset=0;;offset+=200){
    const page=books.storyData(path,{through_chapter:input.through_chapter,limit:200,offset})
    total=page.total
    if(total>2000)throw Error('本范围故事资料超过首版上限，请缩小阅读范围')
    for(const r of page.records)if(r.freshness==='current'&&!r.related_changed.length&&!['rejected','withdrawn'].includes(r.approval)
      &&r.evidence.length&&r.evidence.every(e=>selected.has(e.document_id)))records.push(r)
    if(offset+200>=total)break
  }
  source.records=records
  if(books.storyTimeProjection)source.temporal=books.storyTimeProjection(records)
  source.notice='资料只覆盖本次选定正文，候选不等于正式事实；模型仍可能记得后文，须做语义复核。'
  if(Buffer.byteLength(JSON.stringify(source))>120000)throw Error('上下文超过 120 KB，请减少章节')
  return {...source,fingerprint:hash(source)}
}
export function verifySource(books,source){
  const current=prepareSource(books,source.path,{brief:source.brief,chapters:source.chapters.map(c=>c.number),through_chapter:source.through_chapter,...source.constraints})
  if(!source.temporal){delete current.temporal;delete current.fingerprint;current.fingerprint=hash(current)}
  if(!source.constraints){delete current.constraints;delete current.fingerprint;current.fingerprint=hash(current)}
  if(current.fingerprint!==source.fingerprint)throw Error('正文或故事资料已变化，请重新准备任务来源')
  return true
}
