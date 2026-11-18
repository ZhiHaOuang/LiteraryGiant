import { chapterPath, readText, createFile } from './chapter-file-format.js'
import { analysisSnapshots, legacyFingerprint, parseReportIdentity } from './analysis-snapshot.js'
import { verifyReport } from './analysis-report.js'
import {readPolicy} from './supervision-policy.js'

const same=(a,b)=>legacyFingerprint(a)===legacyFingerprint(b)
const rawFile=(root,dirs,name)=>readText(chapterPath(root,dirs,name),2_000_000)

export function analysisReader(root) {
  const manifest=rawFile(root,['.literarygiant'],'assets.json')
  if (manifest!==null) {
    const assets=JSON.parse(manifest)
    if (assets?.schema!=='lg.assets.v1'||assets.status!=='complete') throw new Error('作品资料整理尚未完成。')
  }
  return (parts,name)=>{
    const current=rawFile(root,['ReferenceLibrary','analyses',...parts],name)
    return current===null&&manifest===null ? rawFile(root,['.literarygiant','analysis',...parts],name) : current
  }
}

export function checkedCandidate(raw,projectId,slug,category,base,projected) {
  const p=raw===null?null:JSON.parse(raw)
  if (p?.schema!=='lg.book-analysis.v1'||p.project_id!==projectId||p.chapter!==slug||p.library!==category||
      (p.scope??'chapter')!=='chapter'||typeof p.run_id!=='string'||!p.run_id.trim()||p.fingerprint!==projected.fingerprint||p.base_fingerprint!==base)
    throw new Error(`${category} 候选审阅缺失、已过期或与本章不符；请重新审阅后采用。`)
  verifyReport(p,projected,category,false)
  const typed=parseReportIdentity(raw)
  const identity=Object.fromEntries(['project_id','chapter','library','run_id','fingerprint','report'].map(k=>[k,typed[k]]))
  return {payload:p,identity,digest:legacyFingerprint(identity)}
}

// Capture the base before activation; verify the resulting chapter before the same SQLite transaction commits.
export function reviewChapter(book, doc, readDecision) {
  const policy=readPolicy(book)
  if (!policy) return null
  const chapter=book.db.prepare("SELECT id,slug,parent_id FROM documents WHERE kind='chapter' AND id=?").get(doc.kind==='chapter'?doc.id:doc.parent_id)
  if (!chapter) throw new Error('受监督的场景必须属于一个章节。')
  const snapshot=()=>analysisSnapshots(book,readDecision)(chapter)
  const base=snapshot().fingerprint
  const read=analysisReader(book.root)
  return {policy,chapter,snapshot,base,read}
}

export function supervisionCheck(book,doc,readDecision) {
  const scope=reviewChapter(book,doc,readDecision)
  if (!scope) return null
  const {policy,chapter,snapshot,base,read}=scope
  return (version,inspect)=>{
    const projected=snapshot(),reports=[],identities=new Map(),formats=new Map()
    for (const category of new Set(policy.chapter_categories)) {
      const raw=read(['candidates',String(version)],category+'.json')
      const {payload:p,identity,digest}=checkedCandidate(raw,book.project.project_id,chapter.slug,category,base,projected)
      const dismissed=[],conflicts=[]
      identities.set(digest,identity)
      formats.set(category,p.contract??null)
      for (const [i,finding] of p.report.findings.entries()) {
        const decisionRaw=read(['adjudications',digest],(i+1)+'.json')
        if (decisionRaw===null) {
          if (finding.kind==='canon_conflict') {
            if (!inspect) throw new Error(`${category} 第 ${i+1} 项存在尚未裁决的正式设定冲突：${finding.explanation}`)
            conflicts.push({finding:i+1,explanation:finding.explanation,factId:finding.fact_id,factQuote:finding.fact_quote,evidence:finding.evidence})
          }
          continue
        }
        const decision=JSON.parse(decisionRaw)
        if (finding.kind!=='canon_conflict'||decision?.schema!=='lg.adjudication.v1'||decision.report_digest!==digest||
            !decision.review_report||!same(parseReportIdentity(decisionRaw).review_report,identity)||decision.finding_index!==i+1||decision.decision!=='dismiss_false_positive'||
            ['reviewer','reason','created_at'].some(k=>typeof decision[k]!=='string'||!decision[k].trim()))
          throw new Error(`${category} 第 ${i+1} 项的作者裁决与报告不符。`)
        dismissed.push({finding:i+1,reviewer:decision.reviewer,reason:decision.reason,createdAt:decision.created_at})
      }
      reports.push({category,run:p.run_id,digest,dismissed,conflicts})
    }
    if (!same(readPolicy(book),policy)) throw new Error('本书监督策略发生变化，请重新核对。')
    const review={chapter:chapter.id,base,candidate:projected.fingerprint,reports}
    return {review,identities,formats,slug:chapter.slug}
  }
}

export function recordAdjudication(book,inspection,input,reviewToken) {
  const {reportDigest,finding,reviewer,reason}=input
  if (input.confirmed!==true||typeof reviewer!=='string'||!reviewer.trim()||reviewer.length>200||
      typeof reason!=='string'||!reason.trim()||reason.length>2000) throw new Error('请署名并说明判为误报的理由，再确认裁决。')
  const report=inspection?.review.reports.find(item=>item.digest===reportDigest)
  const prior=report?.dismissed.find(item=>item.finding===finding)
  if (prior&&prior.reviewer===reviewer.trim()&&prior.reason===reason.trim()) return prior
  if (input.reviewToken!==reviewToken||!report?.conflicts.some(item=>item.finding===finding)) throw new Error('冲突或裁决依据已变化，请重新预览。')
  const createdAt=new Date().toISOString()
  const receipt={schema:'lg.adjudication.v1',report_digest:reportDigest,review_report:inspection.identities.get(reportDigest),
    finding_index:finding,decision:'dismiss_false_positive',reviewer:reviewer.trim(),reason:reason.trim(),created_at:createdAt}
  const path=chapterPath(book.root,['ReferenceLibrary','analyses','adjudications',reportDigest],finding+'.json',true)
  createFile(path,JSON.stringify(receipt,null,2)+'\n')
  return {finding,reviewer:receipt.reviewer,reason:receipt.reason,createdAt}
}
