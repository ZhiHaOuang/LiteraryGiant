import {openBook} from './read.js'
import {identity} from './manuscript.js'
import {mirrorReceipt} from './mirror-queue.js'
import {chapterPath,readText,createFile,replaceWithBackup,hash} from './chapter-file-format.js'
import {analysisSnapshots,legacyFingerprint,parseReportIdentity} from './analysis-snapshot.js'
import {analysisReader,checkedCandidate} from './supervision.js'
import contracts from './analysis-contracts.json' with {type:'json'}

const limit=2_000_000
function destination(root,slug,category,create=false) {
  if (!slug||/[\\/\0]/u.test(slug)||['.','..'].includes(slug)||!Object.hasOwn(contracts.cards,category)) throw new Error('章节或分析类别无效。')
  return chapterPath(root,['ReferenceLibrary','analyses',slug],category+'.json',create)
}

export function queueAnalyses(book,inspection) {
  const items=inspection.review.reports.map(({category})=>{
    const item={category,status:'pending',contract:inspection.formats.get(category)}
    try {
      const previous=readText(destination(book.root,inspection.slug,category),limit)
      item.previous=previous===null?null:hash(previous)
    }catch(error){item.error=error.message}
    return item
  })
  return {status:'pending',items}
}

function publishOne(book,chapter,snapshot,saved,item,read) {
  const {category}=item,proof=saved.supervision.reports.find(r=>r.category===category)
  const raw=read(['candidates',String(saved.version)],category+'.json')
  const {payload,identity:review,digest}=checkedCandidate(raw,book.project.project_id,chapter.slug,category,saved.supervision.base,snapshot)
  if (digest!==proof.digest||Object.hasOwn(item,'contract')&&item.contract!==(payload.contract??null)) throw new Error('候选报告与采用收据不符。')
  const record={schema:'lg.book-analysis.v1',...review,source_fingerprint:snapshot.sourceFingerprint,scope:'chapter',base_fingerprint:snapshot.fingerprint}
  if (payload.contract) Object.assign(record,{contract:payload.contract,contract_fingerprint:contracts.cards[category].fingerprint})
  const text=JSON.stringify(record)+'\n'
  if (Buffer.byteLength(text)>limit) throw new Error('正式章节报告超过读取上限。')
  const path=destination(book.root,chapter.slug,category,true)
  const current=readText(path,limit)
  if (current===text) return
  if (current===null){createFile(path,text);return}
  if (legacyFingerprint(parseReportIdentity(current))===legacyFingerprint(parseReportIdentity(text))) return
  const previous=JSON.parse(current)
  if (hash(current)!==item.previous||previous?.schema!=='lg.book-analysis.v1'||previous.project_id!==record.project_id||
      previous.chapter!==chapter.slug||previous.library!==category||(previous.scope??'chapter')!=='chapter')
    throw new Error('现有章节报告已变化或归属不符，已保留原文件。')
  const prefix=chapterPath(book.root,['.literarygiant','analysis-backups'],category+'-',true)
  item.backup=replaceWithBackup(path,current,text,prefix,limit,'previous.json')
}

export function retryAnalyses(path,chapterId,operation,readDecision) {
  identity(chapterId)
  const book=openBook(path,{write:true}),db=book.db
  try {
    const saved=mirrorReceipt(db,chapterId,operation)
    if (saved.action!=='accept'||!saved.supervision||saved.supervision.chapter!==chapterId) throw new Error('找不到本次采用的监督收据。')
    // Older receipts can fill a missing destination but have no baseline authorizing replacement.
    const job=saved.publication??={status:'pending',items:saved.supervision.reports.map(({category})=>({category,status:'pending'}))}
    if (job.status!=='pending') return saved
    const chapter=db.prepare("SELECT id,slug,parent_id FROM documents WHERE kind='chapter' AND id=?").get(chapterId)
    try {
      const snapshot=chapter&&analysisSnapshots(book,readDecision)(chapter)
      const current=snapshot?.fingerprint===saved.supervision.candidate
      const read=current&&analysisReader(book.root)
      for (const item of job.items) {
        if (item.status!=='pending') continue
        delete item.error
        if (!current){item.status='superseded';continue}
        try {publishOne(book,chapter,snapshot,saved,item,read);item.status='published'}
        catch(error){item.error=error.message}
      }
      delete job.error
      job.status=job.items.some(i=>i.status==='pending')?'pending':current?'published':'superseded'
    }catch(error){job.error=error.message}
    db.prepare('UPDATE lg_plugin_operations SET result=? WHERE id=?').run(JSON.stringify(saved),operation)
    book.verify();db.exec('COMMIT')
    return saved
  }finally{book.close()}
}

export function latestPublication(db,chapter) {
  identity(chapter)
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_plugin_operations'").get()) return null
  const row=db.prepare(`SELECT result FROM lg_plugin_operations WHERE json_extract(result,'$.chapter')=?
    AND json_extract(result,'$.supervision') IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(chapter)
  if (!row) return null
  const {operation,version,publication}=JSON.parse(row.result)
  return {operation,version,publication:publication??{status:'pending',items:[]}}
}
