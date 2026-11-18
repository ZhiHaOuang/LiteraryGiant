import {openBook} from './read.js'
import {document,version,chapterSnapshot,digest} from './manuscript.js'
import {activate} from './version-activation.js'
import {chapterPath,readText,createFile,replaceWithBackup} from './chapter-file-format.js'
import {reviewChapter,checkedCandidate} from './supervision.js'
import {verifyReport} from './analysis-report.js'
import {candidateLineage} from './legacy-chapter.js'
import contracts from './analysis-contracts.json' with {type:'json'}

function inspect(raw,header,projected) {
  if (raw===null) return {state:'missing'}
  try {
    const p=JSON.parse(raw)
    if (p.schema!==header.schema||p.project_id!==header.project_id||p.chapter!==header.chapter||p.library!==header.library||
        (p.scope??'chapter')!=='chapter'||typeof p.run_id!=='string'||!p.run_id.trim()||
        !/^[a-f0-9]{64}$/u.test(p.base_fingerprint)||!/^[a-f0-9]{64}$/u.test(p.fingerprint)) throw new Error('分析文件身份或摘要无效。')
    if (p.base_fingerprint!==header.base_fingerprint||p.fingerprint!==header.fingerprint) return {state:'stale'}
    checkedCandidate(raw,p.project_id,p.chapter,p.library,p.base_fingerprint,projected)
    return {state:'current',run:p.run_id,signature:p.lg_signature,report:p.report}
  }catch(e){return {state:'invalid',error:e.message}}
}

/** Project the candidate in a rolled-back transaction, including changes to selected-plan sources. */
export function candidateAnalysis(path,target,readDecision,save) {
  const book=openBook(path,{write:true}),db=book.db
  try {
    const doc=document(db,target.document),v=version(db,doc.id,target.version)
    const scope=reviewChapter(book,doc,readDecision)
    if (!scope) {
      if (target.category||save) throw new Error('本书未启用候选监督。')
      return {categories:[]}
    }
    if(v.state!=='candidate'||target.token!==chapterSnapshot(db,doc).token)throw new Error('请选择基于当前章的 LG 候选。')
    candidateLineage(db,doc,v,target.token,readDecision)
    activate(db,doc,v.id,'accepted')
    const projected=scope.snapshot(),categories=[...new Set(scope.policy.chapter_categories)]
    const header=category=>({schema:'lg.book-analysis.v1',project_id:book.project.project_id,chapter:scope.chapter.slug,library:category,
      scope:'chapter',fingerprint:projected.fingerprint,source_fingerprint:projected.sourceFingerprint,base_fingerprint:scope.base})
    const dirs=['candidates',String(v.id)],read=c=>scope.read(dirs,c+'.json')
    if (target.category===undefined&&!save) {
      return {categories:categories.map(category=>{
        const {state,error}=inspect(read(category),header(category),projected)
        return {category,state,error}
      })}
    }
    const c=target.category
    if (!categories.includes(c)) throw new Error('本书监督策略未要求该类别。')
    const record=header(c),raw=read(c),existing=inspect(raw,record,projected)
    if(existing.state==='current') return existing
    if(existing.state==='invalid') throw new Error(existing.error)
    const token=digest([path,doc.id,v.id,c,scope.policy,record,contracts.cards[c].fingerprint,raw])
    if (!save) return {state:existing.state,token,documents:[...projected.references.values()],facts:projected.facts.map(({id,category,key,value})=>({id,category,key,value}))}
    if (token!==save.token) throw new Error('候选、设定、方向、策略或报告在生成期间已变化。')
    const payload={...record,run_id:save.operation,lg_signature:save.signature,contract:'lg.reference-card.v1',
      contract_fingerprint:contracts.cards[c].fingerprint,report:save.report}
    try {verifyReport(payload,projected,c,false)}
    catch(error){error.code='ANALYSIS_OUTPUT_INVALID';throw error}
    const text=JSON.stringify(payload)+'\n'
    if(Buffer.byteLength(text)>2_000_000) throw new Error('候选报告过大。')
    const output=chapterPath(book.root,['ReferenceLibrary','analyses',...dirs],c+'.json',true)
    const local=readText(output,2_000_000)
    book.verify()
    if(local===null) createFile(output,text)
    else {
      if(local!==raw) throw new Error('候选报告已变化。')
      const prefix=chapterPath(book.root,['.literarygiant','analysis-backups'],c+'-',true)
      replaceWithBackup(output,raw,text,prefix,2_000_000,'previous.json')
    }
    return {state:'current',run:save.operation,signature:save.signature,report:save.report}
  } finally {book.close()}
}
