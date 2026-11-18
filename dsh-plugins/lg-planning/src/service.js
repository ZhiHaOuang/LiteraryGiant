import { checkGeneration, attachGeneration, generated } from './generation.js'
import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { hash, integer, now } from './common.js'
import { payload } from './decision-schema.js'
import { planDecision, applyDecision, decision, decisionContext } from './decisions.js'
import { planScene, applyScene, scene } from './scenes.js'
import { planStructure, applyStructure, structure, structureRecord, window } from './structure.js'
function plan(db, input) {
  if (!input || typeof input.action !== 'string' || JSON.stringify(input).length > 80000) throw new Error('规划请求格式或大小无效。')
  if (input.action.startsWith('decision.')) { const value = planDecision(db, input); payload(JSON.stringify(value.after)); return value }
  if (input.action.startsWith('scene.')) return planScene(db, input)
  return planStructure(db, input)
}
function apply(db, value) {
  return value.action.startsWith('decision.') ? applyDecision(db, value) : value.action.startsWith('scene.') ? applyScene(db, value) : applyStructure(db, value)
}
function affectedChapters(plan, result) {
  if (plan.action.startsWith('structure.') && result.kind === 'chapter' && result.token !== plan.before?.token) return [result.id]
  if (plan.action === 'scene.create') return result.chapter_id == null ? [] : [result.chapter_id]
  if (plan.action !== 'scene.move' || (plan.before.chapter_id === result.chapter_id && plan.before.sequence === result.sequence)) return []
  return [...new Set([plan.before.chapter_id,result.chapter_id].filter(id => id != null))]
}
function withChapterFiles(result, resolve) {
  if (!result.chapterFiles) return result
  return {...result, chapterFiles:result.chapterFiles.map(ref =>
    ref.operation ? resolve(ref) ?? {...ref,sync:'upgrade-required'} : ref)}
}
function commit(db, operation, signature, make, finish = (_db, result) => result) {
  if (typeof operation !== 'string' || !/^[\w-]{16,80}$/u.test(operation)) throw new Error('规划操作标识无效。')
  db.exec('CREATE TABLE IF NOT EXISTS lg_planning_operations (id TEXT PRIMARY KEY, signature TEXT NOT NULL, document_id INTEGER NOT NULL, action TEXT NOT NULL, before_json TEXT, result TEXT NOT NULL, created_at TEXT NOT NULL)')
  const previous = db.prepare('SELECT * FROM lg_planning_operations WHERE id=?').get(operation)
  if (previous) {
    if (previous.signature !== signature) throw new Error('重复规划操作的内容发生变化。')
    return JSON.parse(previous.result)
  }
  const value = make(), result = finish(db, apply(db, value), value)
  db.prepare('INSERT INTO lg_planning_operations VALUES (?,?,?,?,?,?,?)').run(operation, signature, result.document_id ?? result.id, value.action,
    value.before ? JSON.stringify(value.before) : null, JSON.stringify(result), now())
  return result
}
export function createPlanning(books, verifyGeneration) {
  const prepare = (path, db, input) => {
    const value = plan(db, input)
    checkGeneration(db, value, verifyGeneration && (proof => verifyGeneration(path, proof)))
    return value
  }
  const approved = (path, id) => {
    const item = books.readState(path, db => scene(db, id))
    if (item.plan_state !== 'approved' || !item.plan.trim()) throw new Error('请先由作者批准非空场景计划。')
    if (item.metadata.lg_plan_proposal) throw new Error('此场景还有待审替换计划，请先批准或放弃。')
    const proof = item.metadata.lg_plan_generation
    if (proof) {
      if (!verifyGeneration) throw new Error('计划来源校验服务不可用。')
      verifyGeneration(path, proof, id)
    }
    return { item, receipt: { schema: 'lg.approved-scene.v1', scene: id, token: item.token } }
  }
  const commitChange=(path,db,change,token,operation)=>commit(db, operation, hash({ change, token }), () => {
    const value = prepare(path, db, change)
    if (token !== hash({ path, value })) throw new Error('规划预览或来源已变化，请重新预览。')
    return value
  }, (db, item, plan) => {
    const ids = affectedChapters(plan,item)
    if (!ids.length) return item
    const chapterFiles = ids.map(chapter => books.chapterMirrors?.queue(db,chapter,operation) ?? {chapter,sync:'upgrade-required'})
    return {...item,chapterFiles}
  })
  return {
    approved,
    selectInTransaction(path,db,change,token,operation) {
      if(change.action!=='decision.select')throw new Error('此入口仅用于作者选择已有方案。')
      return commitChange(path,db,change,token,operation)
    },
    readDecisionInTransaction: decision,
    verifyDraft(path, receipt) {
      if (receipt?.schema !== 'lg.approved-scene.v1' || approved(path, receipt.scene).receipt.token !== receipt.token) throw new Error('起草所依据的已批准计划已变化，请重新审阅。')
      return true
    },
    preview(path, change) { return books.readState(path, db => { const value = prepare(path, db, change); return { value, token: hash({ path, value }) } }) },
    apply(path, change, token, operation) {
      const result = books.changeState(path, db => commitChange(path,db,change,token,operation))
      return withChapterFiles(result,ref => books.chapterMirrors?.finish(path,ref))
    },
    generated(path, operation, requestHash, signature) { return books.readState(path, db => generated(db, operation, requestHash, signature)) },
    propose(path, change, operation, generation = null) {
      if (!['decision.options', 'scene.plan'].includes(change?.action)) throw new Error('模型只能提交方向选项或场景待审计划。')
      return books.changeState(path, db => commit(db, operation, hash({ proposal: change, ...(generation ? { generation } : {}) }), () => {
        if (generation) {
          if (!verifyGeneration) throw new Error('生成来源校验服务不可用。')
          verifyGeneration(path, generation)
        }
        return plan(db, change)
      }, (db, result) => generation ? attachGeneration(db, result, generation) : result))
    },
    documents(path) { return books.readState(path, db => db.prepare(`SELECT d.id,d.title,d.kind,d.parent_id,d.active_version_id,v.version_number FROM documents d JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id WHERE d.kind NOT IN ('creative_decision','narrative_knowledge') AND d.state NOT IN ('archived','rejected') ORDER BY d.id LIMIT 1000`).all()) },
    read(path, section, id) { return books.readState(path, db => section === 'decisions' ? decision(db, id) : section === 'scenes' ? scene(db, id) : section === 'structure' ? structureRecord(db, id) : (() => { throw new Error('未知规划分类。') })()) },
    list(path, section, input = {}) {
      return books.readState(path, db => {
        if (section === 'structure') return structure(db, input)
        if (!['decisions', 'scenes'].includes(section)) throw new Error('未知规划分类。')
        const offset = integer(input.offset ?? 0, 0, 1000000), limit = integer(input.limit ?? 10, 1, 30), params = []
        let where = "d.kind=? AND d.state NOT IN ('archived','rejected')"; params.push(section === 'decisions' ? 'creative_decision' : 'scene')
        if (section === 'scenes' && input.chapter_id != null) { where += ' AND d.parent_id=?'; params.push(integer(input.chapter_id)) }
        if (section === 'scenes') where += ' AND EXISTS(SELECT 1 FROM scene_cards s WHERE s.document_id=d.id)'
        const total = db.prepare('SELECT COUNT(*) AS n FROM documents d WHERE ' + where).get(...params).n
        const rows = db.prepare('SELECT d.id FROM documents d WHERE ' + where + ' ORDER BY d.sequence IS NULL,d.sequence,d.id LIMIT ? OFFSET ?').all(...params, limit, offset)
        const items = []; let size = 0
        for (const row of rows) {
          let value
          try { value = section === 'decisions' ? decision(db, row.id) : scene(db, row.id) } catch { value = { document_id: row.id, error: '规划记录无效，需复核旧数据。' } }
          size += JSON.stringify(value).length
          if (size > 200000) break
          items.push(value)
        }
        return { items, total, offset, nextOffset: offset + items.length < total ? offset + items.length : null }
      })
    },
    history(path, id, offset = 0) { return books.readState(path, db => {
      integer(id); integer(offset, 0, 1000000)
      const versions = db.prepare('SELECT id,version_number,state,reason,created_at FROM document_versions WHERE document_id=? ORDER BY version_number DESC LIMIT 10 OFFSET ?').all(id, offset)
      const operations = db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_planning_operations'").get() ? db.prepare('SELECT id,action,before_json,result,created_at FROM lg_planning_operations WHERE document_id=? ORDER BY rowid DESC LIMIT 10 OFFSET ?').all(id, offset).map(row => ({ ...row, before: row.before_json ? JSON.parse(row.before_json) : null, before_json: undefined, result: withChapterFiles(JSON.parse(row.result),ref => books.chapterMirrors?.status(db,ref)) })) : []
      return { versions, operations, offset }
    }) },
    context(path, input = {}) { return books.readState(path, db => decisionContext(db, input.limit, input.chapter_id,input.decision_id)) },
    window(path, input) { return books.readState(path, db => window(db, input)) },
    forDirectory(path) {
      const cwd = realpathSync(path), candidates = books.list().filter(book => { if (book.error) return false; const rel = relative(realpathSync(book.path), cwd); return !rel || rel !== '..' && !rel.startsWith('..' + sep) && !rel.startsWith(sep) }).sort((a,b) => b.path.length - a.path.length)
      if (!candidates.length) throw new Error('请将会话工作目录设为已登记作品。')
      return candidates[0].path
    },
  }
}
