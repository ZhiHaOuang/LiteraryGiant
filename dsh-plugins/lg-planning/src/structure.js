import { doc, integer, text, createDocument, hash, now } from './common.js'
export function planStructure(db, input) {
  const before = input.action === 'structure.update' ? structureRecord(db, input.id) : null
  const kind = before?.kind ?? input.kind
  if (before && input.expected_token !== before.token) throw new Error('卷／章骨架已变化，请刷新。')
  if (!['structure.create', 'structure.update'].includes(input.action) || !['part', 'chapter'].includes(kind)) throw new Error('请选择创建卷或章节骨架。')
  const parent_id = input.parent_id == null ? null : doc(db, input.parent_id, 'part').id
  if (kind === 'part' && parent_id !== null) throw new Error('卷骨架不能嵌套另一卷。')
  const after = { kind, slug: text(before?.slug ?? input.slug, '骨架标识', 200), title: text(input.title, '骨架标题', 200), parent_id,
    sequence: input.sequence == null ? null : integer(input.sequence, 0, 1000000) }
  if (!/^[\p{L}\p{N}_-]+$/u.test(after.slug) || !before && db.prepare('SELECT 1 FROM documents WHERE slug=?').get(after.slug)) throw new Error('骨架标识无效或已存在。')
  return { action: input.action, before, after }
}
export function structureRecord(db, id) {
  const value = doc(db, id)
  if (!['part', 'chapter'].includes(value.kind)) throw new Error('请选择卷或章骨架。')
  const item = Object.fromEntries(['id','title','slug','kind','parent_id','sequence','state','active_version_id'].map(key => [key,value[key]]))
  return { ...item, token: hash(item) }
}
export function applyStructure(db, plan) {
  if (!plan.before) return structureRecord(db, createDocument(db, plan.after))
  const a = plan.after
  db.prepare('UPDATE documents SET title=?,parent_id=?,sequence=?,updated_at=? WHERE id=?').run(a.title.trim(), a.parent_id, a.sequence, now(), plan.before.id)
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='document_fts'").get()) db.prepare('UPDATE document_fts SET title=? WHERE rowid=?').run(a.title.trim(), plan.before.id)
  return structureRecord(db, plan.before.id)
}
export function structure(db, input = {}) {
  const offset = integer(input.offset ?? 0, 0, 1000000), limit = integer(input.limit ?? 30, 1, 100)
  const count = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind IN ('part','chapter') AND state NOT IN ('archived','rejected')").get().n
  const items = db.prepare(`SELECT id,title,slug,kind,parent_id,sequence,state,active_version_id FROM documents WHERE kind IN ('part','chapter') AND state NOT IN ('archived','rejected') ORDER BY CASE WHEN parent_id IS NULL THEN id ELSE parent_id END,kind DESC,sequence IS NULL,sequence,id LIMIT ? OFFSET ?`).all(limit, offset)
  return { items: items.map(item => ({ ...item, token: hash(item) })), total: count, offset, nextOffset: offset + items.length < count ? offset + items.length : null }
}
export function window(db, input) {
  const chapter = doc(db, input.chapter_id, 'chapter'), horizon = integer(input.horizon ?? 3, 1, 10)
  if (chapter.sequence === null) throw new Error('滚动窗口需要明确的章节顺序。')
  const items = db.prepare(`SELECT id,title,parent_id,sequence,active_version_id FROM documents WHERE kind='chapter' AND parent_id IS ? AND sequence>=? AND state NOT IN ('archived','rejected') ORDER BY sequence,id LIMIT ?`).all(chapter.parent_id, chapter.sequence, horizon + 1)
  if (new Set(items.map(item => item.sequence)).size !== items.length) throw new Error('章节顺序有歧义，请先整理顺序。')
  return { from: chapter.id, horizon, chapters: items.slice(0, horizon), hasMore: items.length > horizon,
    note: '只展开同卷近期章节；远期保留骨架。此查询不生成正文、不跨卷推断顺序、不自动批准计划。' }
}
