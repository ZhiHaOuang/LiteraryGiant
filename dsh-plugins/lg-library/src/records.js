import { openSync, closeSync, readSync, fstatSync, constants } from 'node:fs'
import { extname } from 'node:path'
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'

export const digest = value => createHash('sha256').update(value).digest('hex')
const maxRecordBytes = 262144, maxJsonBytes = 8_000_000
const decode = buffer => new TextDecoder('utf-8', { fatal: true }).decode(buffer)
const usable = value => typeof value === 'string' || value && typeof value === 'object' && !Array.isArray(value)
export async function* records(path, budget, signal) {
  signal?.throwIfAborted()
  if (budget.records >= budget.maxRecords) { budget.truncated = true; return }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), before = fstatSync(fd, { bigint: true })
  const extension = extname(path).toLowerCase()
  try {
    if (extension !== '.jsonl') {
      const size = Number(before.size), cap = extension === '.json' ? maxJsonBytes : 120000
      if (extension === '.json' && size > cap) throw new Error('JSON 文件超过上限；请使用分条 JSONL 索引。')
      const length = Math.min(size, cap)
      if (budget.bytes + length > budget.maxBytes) { budget.truncated = true; return }
      const buffer = Buffer.alloc(length), count = readSync(fd, buffer, 0, length, 0)
      budget.bytes += count; signal?.throwIfAborted()
      if (count !== length) throw new Error('资料文件读取期间变化。')
      if (extension === '.json') {
        const data = JSON.parse(decode(buffer)), values = Array.isArray(data) ? data : [data]
        for (let index = 0; index < values.length; index++) {
          if (budget.records >= budget.maxRecords) { budget.truncated = true; return }
          budget.records++
          const value = values[index], raw = JSON.stringify(value)
          if (usable(value) && Buffer.byteLength(raw) <= maxRecordBytes) yield { value, sha256: digest(raw), locator: { format: 'json', index } }
        }
      } else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: size > length })
        const bytes = Buffer.byteLength(text)
        budget.records++; if (size > length) budget.truncated = true
        yield { value: text, sha256: digest(buffer.subarray(0, bytes)), locator: { format: 'text', offset: 0, length: bytes, line: 1 } }
      }
      return
    }
    let offset = 0, start = 0, line = 1, pending = Buffer.alloc(0)
    while (true) {
      signal?.throwIfAborted()
      if (budget.bytes >= budget.maxBytes || budget.records >= budget.maxRecords) { budget.truncated = true; return }
      const buffer = Buffer.alloc(Math.min(65536, budget.maxBytes - budget.bytes)), n = readSync(fd, buffer, 0, buffer.length, offset)
      offset += n; budget.bytes += n; pending = Buffer.concat([pending, buffer.subarray(0, n)])
      let boundary
      while ((boundary = pending.indexOf(10)) >= 0 || n === 0 && pending.length) {
        if (budget.records >= budget.maxRecords) { budget.truncated = true; return }
        if (boundary < 0) boundary = pending.length
        const raw = pending.subarray(0, boundary)
        if (raw.length > maxRecordBytes) throw new Error('单条索引记录超过读取上限。')
        const locator = { format: 'jsonl', offset: start, length: raw.length, line }
        start += boundary + 1; line++; pending = pending.subarray(boundary + 1)
        if (!raw.toString('utf8').trim()) continue
        budget.records++
        let value
        try { value = JSON.parse(decode(raw)) } catch { budget.malformed++; continue }
        if (usable(value)) yield { value, sha256: digest(raw), locator }
        if (budget.records >= budget.maxRecords) { budget.truncated = true; return }
      }
      if (pending.length > maxRecordBytes) throw new Error('单条索引记录超过读取上限。')
      if (!n) break
      await setImmediate()
    }
  } finally {
    const after = fstatSync(fd, { bigint: true }); closeSync(fd)
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error('资料文件读取期间变化，请重新检索。')
  }
}
export function readRecord(path, locator, expected) {
  const extension = extname(path).toLowerCase()
  if (!locator || locator.format !== (extension === '.json' ? 'json' : extension === '.jsonl' ? 'jsonl' : 'text')) throw new Error('引用记录格式不匹配。')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    let raw, value
    if (locator.format === 'json') {
      const size = fstatSync(fd).size
      if (size > maxJsonBytes || !Number.isSafeInteger(locator.index) || locator.index < 0) throw new Error('引用位置无效。')
      raw = Buffer.alloc(size); if (readSync(fd, raw, 0, size, 0) !== size) throw new Error('引用已变化。')
      const data = JSON.parse(decode(raw)); value = (Array.isArray(data) ? data : [data])[locator.index]
      if (!usable(value)) throw new Error('引用记录不存在。')
      raw = JSON.stringify(value)
      if (Buffer.byteLength(raw) > maxRecordBytes) throw new Error('单条引用超过读取上限。')
    } else {
      if (!['jsonl', 'text'].includes(locator.format) || ![locator.offset, locator.length].every(Number.isSafeInteger) ||
        locator.offset < 0 || locator.length < 1 || locator.length > maxRecordBytes) throw new Error('引用位置无效。')
      raw = Buffer.alloc(locator.length)
      if (readSync(fd, raw, 0, raw.length, locator.offset) !== raw.length) throw new Error('引用已变化。')
      if (locator.format === 'text' && locator.offset !== 0) throw new Error('文本引用位置无效。')
      if (locator.format === 'jsonl') {
        const edge = Buffer.alloc(1)
        if (locator.offset && (readSync(fd, edge, 0, 1, locator.offset - 1) !== 1 || edge[0] !== 10)) throw new Error('引用不是完整索引记录。')
        const n = readSync(fd, edge, 0, 1, locator.offset + raw.length)
        if (n && edge[0] !== 10 || raw.includes(10)) throw new Error('引用不是完整索引记录。')
      }
      value = locator.format === 'jsonl' ? JSON.parse(decode(raw)) : decode(raw)
    }
    if (digest(raw) !== expected) throw new Error('引用来源已变化，请重新检索并选择。')
    return value
  } finally { closeSync(fd) }
}
