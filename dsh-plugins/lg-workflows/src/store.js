import { createHash } from 'node:crypto'
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const now = () => new Date().toISOString()
export const identity = id => { if (typeof id !== 'string' || !/^[\w-]{16,50}$/u.test(id)) throw new Error('工作流标识无效。');return id }
const exists = db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_workflow_runs'").get()
export function load(db, id) {
  identity(id)
  const row = exists(db) && db.prepare('SELECT state FROM lg_workflow_runs WHERE id=?').get(id)
  if (!row) throw new Error('工作流不存在。')
  return JSON.parse(row.state)
}
export function save(db, state) {
  state.updatedAt = now()
  const text = JSON.stringify(state)
  if (text.length > 1500000) throw new Error('工作流记录超过上限。')
  db.exec('CREATE TABLE IF NOT EXISTS lg_workflow_runs(id TEXT PRIMARY KEY,state TEXT NOT NULL)')
  db.prepare('INSERT INTO lg_workflow_runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(state.id, text)
  return expose(state)
}
export const expose = state => ({ ...state, token: hash(state) })
export function listing(db, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error('工作流分页无效。')
  if (!exists(db)) return { items: [], nextOffset: null }
  const rows = db.prepare('SELECT state FROM lg_workflow_runs ORDER BY rowid DESC LIMIT 21 OFFSET ?').all(offset)
  return { items: rows.slice(0,20).map(row => { const s = JSON.parse(row.state);return { id:s.id,status:s.status,title:s.title,steps:s.steps.length,createdAt:s.createdAt,updatedAt:s.updatedAt } }), nextOffset:rows.length>20?offset+20:null }
}
