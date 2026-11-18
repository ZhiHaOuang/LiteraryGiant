import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { lstatSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class Ledger {
  constructor(path) {
    if (!isAbsolute(path)) throw new Error('执行账本需要本机绝对路径。')
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('账本不能使用符号链接。') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    this.db = new DatabaseSync(path, { allowExtension: false })
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS literary_calls(id TEXT PRIMARY KEY, signature TEXT NOT NULL, request TEXT NOT NULL,
        reserved_micros INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  }
  reserve(id, request, micros, ceiling, quota = null) {
    if (typeof id !== 'string' || !/^[\w-]{16,80}$/.test(id)) throw new Error('任务标识无效。')
    if (![micros, ceiling].every(Number.isSafeInteger) || micros <= 0 || ceiling < 0) throw new Error('预算配置无效。')
    const db = this.db, signature = fingerprint(request)
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = db.prepare('SELECT * FROM literary_calls WHERE id=?').get(id)
      if (existing) {
        if (existing.signature !== signature) throw new Error('同一任务标识不能更换请求。')
        return { existing: this.get(id) }
      }
      if (quota) {
        if (typeof quota.session !== 'string' || !quota.session || !Number.isSafeInteger(quota.maxCalls) || quota.maxCalls < 1 || quota.maxCalls > 1000) throw new Error('原生会话调用上限无效。')
        const count = db.prepare("SELECT COUNT(*) AS n FROM literary_calls WHERE json_extract(request,'$.native.session')=?").get(quota.session).n
        if (count >= quota.maxCalls) throw new Error('此原生会话已达到模型调用上限；未发送新请求。')
      }
      const used = db.prepare('SELECT COALESCE(SUM(reserved_micros),0) AS n FROM literary_calls').get().n
      if (used + micros > ceiling) throw new Error('累计预算不足；未调用模型。')
      const now = new Date().toISOString()
      db.prepare('INSERT INTO literary_calls VALUES (?,?,?,?,?,?,?,?)').run(id, signature, JSON.stringify(request), micros, 'reserved', null, now, now)
      db.exec('COMMIT')
      return { reservedCny: micros / 1e6 }
    } finally { if (db.isTransaction) db.exec('ROLLBACK') }
  }
  finish(id, status, result) {
    if (!['succeeded', 'failed', 'cancelled'].includes(status)) throw new Error('执行状态无效。')
    const updated = this.db.prepare("UPDATE literary_calls SET status=?,result=?,updated_at=? WHERE id=? AND status='reserved'")
      .run(status, JSON.stringify(result), new Date().toISOString(), id)
    if (updated.changes !== 1) throw new Error('任务已经结算或不存在。')
    return this.get(id)
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM literary_calls WHERE id=?').get(id)
    return row && { id, status: row.status, reservedCny: row.reserved_micros / 1e6,
      request: JSON.parse(row.request), result: row.result && JSON.parse(row.result) }
  }
  totals() {
    const row = this.db.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(reserved_micros),0)/1000000.0 AS reservedCny FROM literary_calls').get()
    return { ...row }
  }
  close() { this.db.close() }
}
