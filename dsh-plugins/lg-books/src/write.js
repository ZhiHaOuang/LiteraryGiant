import { ensureOperationTable } from './mirror-queue.js'
import { retryChapterMirror } from './chapter-files.js'
import { activate } from './version-activation.js'
export { activate, refreshSearch } from './version-activation.js'
import { openBook } from './read.js'
import { document, version, chapterSnapshot, digest, identity } from './manuscript.js'
import { supervisionCheck, recordAdjudication } from './supervision.js'
import {queueAnalyses,retryAnalyses} from './analysis-publication.js'
import {compactFingerprint} from './analysis-snapshot.js'
import {candidateLineage} from './legacy-chapter.js'

/** Author API only. Model plugins receive a separate candidate-only service. */
export function writeManuscript(path,input,generation,verifyReferences,verifyContext,verifyDraft,verifyFeedback,readDecision) {
  let saved=saveVersion(path,input,'commit',generation,verifyReferences,verifyContext,verifyDraft,verifyFeedback,readDecision)
  if (saved.sync==='mirror-pending') {
    try { saved=retryChapterMirror(path,saved.chapter,saved.operation) }
    catch (error) { saved.syncError=error.message }
  }
  if (saved.supervision&&(!saved.publication||saved.publication.status==='pending')) {
    try { saved.publication=retryAnalyses(path,saved.chapter,saved.operation,readDecision).publication }
    catch (error) { saved.publicationError=error.message }
  }
  return saved
}

export function previewAcceptance(path,input,...checks) {
  return saveVersion(path,{...input,action:'accept'},'preview',...checks)
}

export function adjudicateAcceptance(path,input,...checks) {
  return saveVersion(path,{...input,action:'accept'},'adjudicate',...checks)
}

function saveVersion(path, input, mode, generation = null, verifyReferences = null, verifyContext = null, verifyDraft = null, verifyFeedback = null, readDecision = null) {
  if (!['edit', 'candidate', 'accept', 'reject'].includes(input.action)) throw new Error('未知编辑操作。')
  if (typeof input.operation !== 'string' || !/^[\w-]{16,80}$/.test(input.operation)) throw new Error('操作收据标识无效。')
  if (typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)) throw new Error('请先读取整章快照。')
  identity(input.document)
  const signature = digest(input), book = openBook(path, { write: true }), db = book.db
  try {
    if (mode==='commit') {
      ensureOperationTable(db,['edit','accept'].includes(input.action))
      const receipt = db.prepare('SELECT * FROM lg_plugin_operations WHERE id=?').get(input.operation)
      if (receipt) {
        if (receipt.signature !== signature) throw new Error('重复操作的内容发生变化，请重新预览。')
        return JSON.parse(receipt.result)
      }
    }
    const doc = document(db, input.document), snapshot = chapterSnapshot(db, doc)
    if (snapshot.token !== input.token) throw new Error('整章或场景已变化，请刷新比较后再提交。')
    let target, supervision,publication,legacySource
    if (['edit', 'candidate'].includes(input.action)) {
      if (typeof input.content !== 'string' || input.content.length > 400_000) throw new Error('正文格式或长度无效。')
      if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) throw new Error('请填写修改目的（最多 2000 字）。')
      const number = db.prepare('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM document_versions WHERE document_id=?').get(doc.id).n
      if (input.sourceVersion != null && input.version != null && input.sourceVersion !== input.version) {
        throw new Error('查看版本与修改来源不一致，请重新预览。')
      }
      const source = version(db, doc.id, input.sourceVersion ?? input.version ?? doc.active_version_id)
      if (input.action === 'edit' && source.id !== doc.active_version_id) throw new Error('历史版本修改须先保存为候选，再审阅采用。')
      const metadata = { schema: 'lg.candidate.v1', origin: 'lg-workbench', base_version_id: doc.active_version_id,
        chapter_token: snapshot.token, sources: snapshot.parts, source_version_id: source.id, operation: input.operation,
        ...(generation ? { generation } : {}) }
      if(generation?.source?.legacyParent||source.state==='candidate'&&(source.metadata.literary_task_policy==='lg.literary-task.v1'||source.metadata.legacy_parent!==undefined)){
        if(source.state!=='candidate')throw new Error('旧候选已被处理，请重新预览。')
        const {legacy,inherited}=candidateLineage(db,doc,source,snapshot.token,readDecision)
        if(!legacy)throw new Error('改稿来源缺少旧候选依据。')
        metadata.legacy_parent=compactFingerprint(legacy)
        if(inherited)metadata.required_decision=inherited
        if(generation?.source?.legacyParent&&generation.source.legacyParent!==metadata.legacy_parent)throw new Error('旧候选来源在改稿期间已变化。')
      }
      const state = input.action === 'candidate' ? 'candidate' : doc.state
      target = Number(db.prepare(`INSERT INTO document_versions(document_id,version_number,state,content,reason,metadata_json,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(doc.id, number, state, input.content, input.reason, JSON.stringify(metadata), new Date().toISOString()).lastInsertRowid)
      if (input.action === 'edit') activate(db, doc, target, state)
    } else {
      const selected = version(db, doc.id, input.version)
      target = selected.id
      if (selected.state !== 'candidate' || target === doc.active_version_id) throw new Error('只能处理尚未采用的候选版本。')
      if (input.action === 'accept') {
        const chain=candidateLineage(db,doc,selected,snapshot.token,readDecision)
        legacySource=chain.legacy
        for(const ancestor of chain.native){
          const proof=ancestor.metadata.generation
          if (proof?.references?.length) {
            if (!verifyReferences) throw new Error('此候选使用参考资料，采用前需要启用 lg-library 校验来源。')
            verifyReferences(proof.references)
          }
          if (proof?.context) {
            if (!verifyContext) throw new Error('此候选使用文学上下文，采用前需要启用 lg-context 校验来源。')
            verifyContext(proof.context)
          }
          if (proof?.draft) {
            if (!verifyDraft) throw new Error('此候选按场景计划起草，采用前需要启用 lg-planning 校验计划。')
            verifyDraft(proof.draft)
          }
          if (proof?.feedback) {
            if (!verifyFeedback) throw new Error('此候选按审阅意见改稿，采用前需要启用 lg-review。')
            verifyFeedback(proof.feedback)
          }
        }
        const check=supervisionCheck(book,doc,readDecision)
        activate(db, doc, target, 'accepted')
        const inspection=check?.(target,mode!=='commit')
        supervision=inspection?.review
        const reviewToken=legacySource?digest({supervision:supervision??null,legacySource,target,content:digest(selected.content)}):digest(supervision??null)
        if (mode!=='commit') {
          book.verify()
          const decision=mode==='adjudicate'?recordAdjudication(book,inspection,input,reviewToken):null
          db.exec('ROLLBACK')
          if (decision) return decision
          return {supervision:supervision??null,reviewToken,...(legacySource?{legacySource}:{})}
        }
        if ((legacySource||input.reviewToken!==undefined)&&input.reviewToken!==reviewToken) throw new Error('采用预览中的监督依据已变化，请重新预览。')
        if (inspection) publication=queueAnalyses(book,inspection)
      } else db.prepare("UPDATE document_versions SET state='rejected' WHERE id=?").run(target)
    }
    const changesManuscript = ['edit', 'accept'].includes(input.action)
    const result = { operation: input.operation, document: doc.id, version: target, action: input.action,
      changesManuscript, sync: changesManuscript ? 'mirror-pending' : 'not-needed', ...(supervision?{supervision,publication}:{}),...(legacySource?{legacySource}:{}),
      ...(changesManuscript ? {chapter:doc.kind === 'chapter' ? doc.id : doc.parent_id} : {}) }
    db.prepare('INSERT INTO lg_plugin_operations VALUES (?,?,?,?)').run(input.operation, signature, JSON.stringify(result), new Date().toISOString())
    book.verify(); db.exec('COMMIT')
    return result
  } finally { book.close() }
}
