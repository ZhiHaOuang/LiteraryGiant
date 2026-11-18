import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Exclusive slots count every attempted request, including errors and interruptions. */
export function reserve(directory, metadata, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('Invalid request limit')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (existsSync(join(directory, 'closure.json'))) throw Error('本轮模型请求预算已结算关闭')
  for (let id = 1; id <= limit; id++) {
    try {
      writeFileSync(join(directory, `${id}.request.json`), JSON.stringify({ id, at: new Date().toISOString(), ...metadata }), { flag: 'wx', mode: 0o600 })
      return id
    } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  throw Error('本轮 20 次模型请求额度已耗尽')
}
export function settle(directory, id, result) {
  writeFileSync(join(directory, `${id}.finish.json`), JSON.stringify(result), { flag: 'wx', mode: 0o600 })
}
export function count(directory) { return readdirSync(directory).filter(f => /^\d+\.request\.json$/.test(f)).length }
