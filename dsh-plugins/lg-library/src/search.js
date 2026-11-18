import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { roots, files, safeFile, allowed, indexes } from './paths.js'
import { records, readRecord, digest } from './records.js'
import { flatten, terms, excerpt, sourceId } from './text.js'

const rank = { abstract: 0, custom: 1, bridge: 2 }
const order = (a, b) => rank[a.tier] - rank[b.tier] || b.score - a.score || a.file.localeCompare(b.file) || a.position - b.position
const quality = value => {
  const n = Number(value?.source_quality_score ?? value?.quality_score ?? value?.confidence ?? 0)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
}
function retain(map, hit, limit) {
  const key = hit.tier + ':' + hit.id, previous = map.get(key)
  if (!previous || order(hit, previous) < 0) map.set(key, hit)
  if (map.size > limit) map.delete([...map.entries()].sort((a, b) => order(a[1], b[1])).at(-1)[0])
}
function citation(book, tier, file, record) {
  return Buffer.from(JSON.stringify({ book: digest(book), tier, file, locator: record.locator, sha256: record.sha256 })).toString('base64url')
}
export function catalog(book, config = {}) {
  const root = roots(book, config.libraryRoot)
  return { abstract: indexes.map(file => ({ file, available: Boolean(root.abstract && existsSync(resolve(root.abstract, file))) })),
    custom: existsSync(root.custom), bridgeIndex: Boolean(root.bridge && existsSync(resolve(root.bridge, 'BridgeIndex/books'))),
    policy: 'abstract → custom → bridge index; no raw corpus scan' }
}
export async function search(book, input, config = {}, signal) {
  const queryTerms = terms(input.query), limit = input.limit ?? 5
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('检索条数需要在 1–20 之间。')
  const root = roots(book, config.libraryRoot), hits = new Map(), warnings = []
  const budget = { maxFiles: config.maxFiles ?? 300, maxBytes: config.maxBytes ?? 16_000_000,
    maxRecords: config.maxRecords ?? 20000, entries: 0, bytes: 0, records: 0, malformed: 0, truncated: false }
  let visited = 0
  for (const tier of ['abstract', 'custom', 'bridge']) {
    if (tier === 'bridge' && hits.size >= limit) break
    const names = files(root[tier], tier, budget)
    for (const file of names) {
      signal?.throwIfAborted()
      if (visited >= budget.maxFiles || budget.records >= budget.maxRecords || budget.bytes >= budget.maxBytes) { budget.truncated = true; break }
      visited++
      const local = new Map()
      try {
        for await (const record of records(safeFile(root[tier], file), budget, signal)) {
          const text = flatten(record.value).toLowerCase(), matched = queryTerms.filter(term => text.includes(term))
          if (!matched.length) continue
          const position = record.locator.line ?? record.locator.index
          retain(local, { tier, file, position, id: sourceId(record.value, `${file}:${position}`),
            excerpt: excerpt(record.value), matched, score: matched.length + quality(record.value), sha256: record.sha256,
            citation: citation(root.book, tier, file, record) }, limit)
        }
        for (const hit of local.values()) retain(hits, hit, limit)
      } catch (error) {
        signal?.throwIfAborted()
        // Paths are selected by the author; return only the relative file and a stable reason.
        warnings.push({ file, error: '资料不可读取、超限或在读取期间发生变化。' })
      }
    }
  }
  return { query: input.query, hits: [...hits.values()].sort(order), warnings,
    stats: { files: visited, bytes: budget.bytes, records: budget.records, malformed: budget.malformed, truncated: budget.truncated } }
}
export function readCitation(book, token, config = {}) {
  if (typeof token !== 'string' || token.length > 4096 || !/^[\w-]+$/u.test(token)) throw new Error('引用标识无效。')
  let ref
  try { ref = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) } catch { throw new Error('引用标识无效。') }
  const root = roots(book, config.libraryRoot)
  if (!ref || ref.book !== digest(root.book) || !allowed(ref.tier, ref.file) || !root[ref.tier] || !/^[a-f0-9]{64}$/u.test(ref.sha256)) throw new Error('引用不属于当前作品的允许资料。')
  const value = readRecord(safeFile(root[ref.tier], ref.file), ref.locator, ref.sha256)
  return { citation: token, tier: ref.tier, file: ref.file, sha256: ref.sha256,
    id: sourceId(value, ref.file), excerpt: excerpt(value), text: flatten(value) }
}
