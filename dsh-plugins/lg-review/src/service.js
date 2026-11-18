import { snapshot, validateOutput, hash } from './targets.js'
import { checkManuscript } from './checks.js'
import { consistencySnapshot } from './consistency.js'
import { chapterQuality } from './chapter-quality.js'
const now = () => new Date().toISOString()
const operationId = value => { if (typeof value !== 'string' || !/^[\w-]{16,80}$/u.test(value)) throw new Error('审阅操作标识无效。'); return value }
const exists = db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_review_runs'").get()
function issue(db, id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('问题标识无效。')
  const row = db.prepare('SELECT * FROM review_issues WHERE id=?').get(id)
  if (!row) throw new Error('审阅问题不存在。')
  const result = { ...row, suggestions: JSON.parse(row.suggested_actions_json) }
  try { const value = JSON.parse(row.evidence); result.evidence = value.schema === 'lg.review-evidence.v1' ? value.items : row.evidence } catch {}
  return { ...result, token: hash(row) }
}
export function createReview(books, planning, context) {
  const prepare = (path,target,options) => snapshot(books,planning,context,path,target,options)
  const verify = (path,receipt) => {
    if (receipt?.schema==='lg.chapter-quality.v1') {
      if (chapterQuality(books,path,receipt.target,true).binding!==receipt.binding) throw new Error('章节质量报告来源已变化。')
      return
    }
    if(receipt?.schema==='lg.consistency-sources.v1') {
      if(consistencySnapshot(books,path,receipt.target).receipt.binding!==receipt.binding)throw new Error('一致性检查来源已变化，请重新检查。')
      return
    }
    if (receipt?.schema !== 'lg.review-sources.v1' || prepare(path,receipt.target,receipt.options).receipt.binding !== receipt.binding) throw new Error('审阅对象或约束材料已变化，请重新审阅。')
  }
  const report = (path,db,id) => {
    operationId(id)
    const row = exists(db) && db.prepare('SELECT * FROM lg_review_runs WHERE id=?').get(id)
    if (!row) throw new Error('审阅记录不存在。')
    const source = JSON.parse(row.source_json), saved = JSON.parse(row.result_json)
    let stale = false; try { verify(path,source.receipt) } catch { stale = true }
    return { run:id, target:source.target, revisionTarget:source.revisionTarget, ...(source.summary?{summary:source.summary}:{}), source:source.receipt, contextReceipt:source.context.receipt, stale,
      issues:saved.ids.map(id=>issue(db,id)), rejected:saved.rejected??[], created_at:row.created_at }
  }
  const preview = (path,change) => books.readState(path,db=>{
    const before=issue(db,change?.id)
    if (before.token !== change.expected_token) throw new Error('问题状态已变化，请刷新。')
    if (!['open','resolved','dismissed'].includes(change.status) || typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length>2000) throw new Error('请选择问题状态并说明作者判断。')
    return {before,after:{status:change.status,reason:change.reason},token:hash({path,before,change})}
  })
  function runCheck(kind,inspect,path,target,id) {
    const signature=hash({[kind]:target}),old=service.replay(path,id,signature,signature)
    if(old)return old
    const {issues,...source}=inspect(books,path,target)
    return service.save(path,id,signature,signature,source,{issues})
  }
  const service = {
    qualityPreview:(path,target)=>chapterQuality(books,path,target),
    quality:(path,target,id)=>runCheck('quality',chapterQuality,path,target,id),
    consistency:(path,target,id)=>runCheck('consistency',consistencySnapshot,path,target,id),
    check:(path,target,rules)=>checkManuscript(books,path,target,rules),
    snapshot:prepare, validate:validateOutput, verify,
    save(path,id,requestHash,signature,source,output) {
      operationId(id)
      return books.changeState(path,db=>{
        db.exec('CREATE TABLE IF NOT EXISTS lg_review_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,signature TEXT NOT NULL,source_json TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL)')
        const old=db.prepare('SELECT request_hash,signature FROM lg_review_runs WHERE id=?').get(id)
        if (old) { if(old.request_hash!==requestHash || old.signature!==signature)throw new Error('同一审阅任务不能更换请求。'); return report(path,db,id) }
        verify(path,source.receipt)
        if(JSON.stringify({source,output}).length>200000)throw new Error('审阅记录超过保存上限。')
        const ids=output.issues.map(item=>Number(db.prepare("INSERT INTO review_issues(document_id,run_id,severity,category,message,evidence,suggested_actions_json,status,created_at) VALUES (?,?,?,?,?,?,?,'open',?)").run(source.target.id||null,id,item.severity,item.category,item.message,JSON.stringify({schema:'lg.review-evidence.v1',items:item.evidence}),JSON.stringify([item.suggestion]),now()).lastInsertRowid))
        db.prepare('INSERT INTO lg_review_runs VALUES (?,?,?,?,?,?)').run(id,requestHash,signature,JSON.stringify(source),JSON.stringify({ids,rejected:output.rejected??[]}),now())
        return report(path,db,id)
      })
    },
    replay(path,id,requestHash,signature) {
      operationId(id)
      return books.readState(path,db=>{
        const row=exists(db)&&db.prepare('SELECT request_hash,signature FROM lg_review_runs WHERE id=?').get(id)
        if(!row)return null
        if(row.request_hash!==requestHash||row.signature!==signature)throw new Error('同一审阅任务不能更换请求。')
        return report(path,db,id)
      })
    },
    read:(path,id)=>books.readState(path,db=>report(path,db,id)),
    list(path,target,offset=0) {
      if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw new Error('审阅分页无效。')
      return books.readState(path,db=>{
        if(!exists(db))return {items:[],nextOffset:null}
        const rows=db.prepare("SELECT id,created_at,json_extract(source_json,'$.target.section') AS section,json_extract(source_json,'$.target.id') AS document_id FROM lg_review_runs WHERE json_extract(source_json,'$.target.section')=? AND json_extract(source_json,'$.target.id')=? ORDER BY rowid DESC LIMIT 21 OFFSET ?").all(target.section,target.id,offset)
        return {items:rows.slice(0,20),nextOffset:rows.length>20?offset+20:null}
      })
    },
    feedback(path,input,task,target) {
      const value=books.readState(path,db=>report(path,db,input?.run))
      if(value.stale)throw new Error('审阅来源已变化，请先重新审阅。')
      if (({ideas:'decisions','scene-plan':'scenes',polish:'manuscript'}[task]!==value.target.section) || hash(value.revisionTarget)!==hash(target))throw new Error('审阅与本次改稿目标不一致。')
      if(!Array.isArray(input.issues)||!input.issues.length||input.issues.length>10||new Set(input.issues).size!==input.issues.length)throw new Error('请选择 1–10 个不同的审阅问题。')
      const selected=input.issues.map(id=>{const item=value.issues.find(item=>item.id===id);if(!item||item.status!=='open')throw new Error('所选问题不属于此审阅或已经处理。');return {id:item.id,category:item.category,message:item.message,suggestions:item.suggestions,evidence:item.evidence}})
      return {run:value.run,issues:selected,source:value.source,context:value.contextReceipt}
    },
    verifyFeedback(path,proof) {
      if(!proof || !Array.isArray(proof.issues) || !proof.issues.length || proof.issues.length>10)throw new Error('改稿审阅依据无效。')
      const value=books.readState(path,db=>report(path,db,proof.run))
      if(value.stale || hash(value.source)!==hash(proof.source) || hash(value.contextReceipt)!==hash(proof.context))throw new Error('改稿审阅来源已变化，请重新审阅。')
      for(const selected of proof.issues) {
        const item=value.issues.find(item=>item.id===selected.id)
        if(!item || item.status!=='open' || hash(selected)!==hash({id:item.id,category:item.category,message:item.message,suggestions:item.suggestions,evidence:item.evidence}))throw new Error('改稿所选问题已经处理或发生变化，请重新审阅。')
      }
      return true
    },
    history(path,id) { return books.readState(path,db=>{
      issue(db,id)
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_review_actions'").get())return []
      return db.prepare("SELECT id,result_json,created_at FROM lg_review_actions WHERE json_extract(result_json,'$.issue.id')=? ORDER BY rowid DESC LIMIT 50").all(id).map(row=>({id:row.id,created_at:row.created_at,...JSON.parse(row.result_json)}))
    }) },
    preview,
    apply(path,change,token,id) {
      operationId(id)
      return books.changeState(path,db=>{
        db.exec('CREATE TABLE IF NOT EXISTS lg_review_actions(id TEXT PRIMARY KEY,signature TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL)')
        const signature=hash({change,token}),old=db.prepare('SELECT * FROM lg_review_actions WHERE id=?').get(id)
        if(old){if(old.signature!==signature)throw new Error('重复审阅处理的内容已变化。');return JSON.parse(old.result_json)}
        const planned=preview(path,change)
        if(planned.token!==token)throw new Error('作者处理预览已变化。')
        db.prepare('UPDATE review_issues SET status=? WHERE id=?').run(change.status,change.id)
        const result={issue:issue(db,change.id),reason:change.reason,previous:planned.before.status}
        db.prepare('INSERT INTO lg_review_actions VALUES (?,?,?,?)').run(id,signature,JSON.stringify(result),now());return result
      })
    },
  }
  return service
}
