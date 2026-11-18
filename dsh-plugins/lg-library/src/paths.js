import { existsSync, lstatSync, realpathSync, opendirSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve, relative, sep, extname } from 'node:path'

export const indexes = ['AbstractLibrary/pattern_index.jsonl', 'AbstractLibrary/instance_index.jsonl', 'indexes/abstract_index.jsonl']
const excluded = new Set(['plans', 'bible', 'reviews', 'drafts', 'analyses', 'archive', 'TaciturnRaw', 'Bridges'])
export function safeFile(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) throw new Error('引用路径无效。')
  const path = resolve(root, name), rel = relative(root, path)
  if (rel === '..' || rel.startsWith('..' + sep) || realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error('引用必须是所选资料目录内的普通文件。')
  return path
}
export function roots(book, configured) {
  const project = realpathSync(book)
  const local = resolve(project, 'Library')
  const shared = configured ? realpathSync(configured) : existsSync(local) && realpathSync(local) === local ? local : null
  if (shared && !lstatSync(shared).isDirectory()) throw new Error('Library 路径必须是目录。')
  const reference = resolve(project, 'ReferenceLibrary')
  let organized = false
  const manifest = resolve(project, '.literarygiant/assets.json')
  if (existsSync(manifest)) {
    if (realpathSync(manifest) !== manifest || lstatSync(manifest).size > 100_000) throw new Error('资料组织清单无效。')
    const data = JSON.parse(readFileSync(manifest, 'utf8'))
    if (data.schema !== 'lg.assets.v1' || data.status !== 'complete') throw new Error('作品资料迁移未完成，暂不检索。')
    organized = true
  }
  return { book: project, abstract: shared, bridge: shared, custom: organized ? resolve(reference, 'sources') : reference }
}
export function allowed(tier, file) {
  if (typeof file !== 'string') return false
  if (tier === 'abstract') return indexes.includes(file)
  if (tier === 'bridge') return /^BridgeIndex\/books\/[^/.][^/]*\.jsonl$/u.test(file)
  if (tier !== 'custom' || !['.json', '.jsonl', '.md', '.txt'].includes(extname(file).toLowerCase())) return false
  const parts = file.split(/[\\/]/)
  return !parts.some(part => excluded.has(part) || part.startsWith('.')) && !/(?:^|\/)research\/stages(?:\/|$)/u.test(file)
}
/** Bounded directory walk; never follows symlinks or visits excluded trees. */
export function files(root, tier, budget) {
  if (!root || !existsSync(root)) return []
  if (tier === 'abstract') return indexes.filter(name => existsSync(resolve(root, name)))
  const start = tier === 'bridge' ? 'BridgeIndex/books' : ''
  const pending = [start], found = []
  while (pending.length && found.length < budget.maxFiles && budget.entries < 5000) {
    const directory = pending.shift(), path = resolve(root, directory)
    if (!existsSync(path) || realpathSync(path) !== path || !lstatSync(path).isDirectory()) continue
    const handle = opendirSync(path)
    try {
      let entry
      while (budget.entries < 5000 && found.length < budget.maxFiles && (entry = handle.readSync())) {
        budget.entries++
        if (entry.name.startsWith('.') || entry.isSymbolicLink() || excluded.has(entry.name)) continue
        const name = directory ? directory + '/' + entry.name : entry.name
        if (/(?:^|\/)research\/stages(?:\/|$)/u.test(name)) continue
        if (entry.isDirectory() && tier === 'custom' && name.split('/').length < 8) pending.push(name)
        else if (entry.isFile() && allowed(tier, name)) found.push(name)
      }
    } finally { handle.closeSync() }
  }
  if (pending.length || budget.entries >= 5000 || found.length >= budget.maxFiles) budget.truncated = true
  return found.sort()
}
