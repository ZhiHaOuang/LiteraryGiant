import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, opendirSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { hash } from './policy.js'
const names = ['STORY_BIBLE.md', 'CHARACTERS.md', 'LOCATIONS.md', 'WORLDVIEW.md', 'TIMELINE.md', 'PLOT_POINTS.md', 'RELATIONSHIPS.md', 'STYLE_GUIDE.md', 'ERRORS.md']
function contained(root, file) {
  const rel = relative(root, realpathSync(file))
  if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) throw new Error('笔记路径超出作品目录。')
  let part = root
  for (const name of relative(root, file).split(sep)) { part = join(part, name); if (lstatSync(part).isSymbolicLink()) throw new Error('笔记路径不能包含符号链接。') }
}
function read(root, file, max = 262144) {
  contained(root, file)
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > max) throw new Error('笔记文件过大或类型无效。')
    const data = Buffer.alloc(before.size); let at = 0
    while (at < data.length) { const n = readSync(fd, data, at, data.length - at, at); if (!n) break; at += n }
    const after = fstatSync(fd), named = lstatSync(file)
    contained(root, file)
    if (named.ino !== before.ino || named.dev !== before.dev || at !== data.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('读取期间笔记变化。')
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } finally { closeSync(fd) }
}
export function notes(path) {
  const root = realpathSync(path), manifest = join(root, '.literarygiant/assets.json'), warnings = [], items = []
  let organized = false
  if (existsSync(manifest)) {
    const value = JSON.parse(read(root, manifest, 65536))
    if (value.schema !== 'lg.assets.v1' || value.status !== 'complete') throw new Error('作品资产整理状态未完成。')
    organized = true
  }
  const base = !organized && existsSync(join(root, '.literarygiant/memory')) ? '.literarygiant/memory' : 'ReferenceLibrary/bible'
  const files = names.map(name => join(base, name)), learnings = join(root, '.learnings')
  if (existsSync(learnings)) {
    contained(root, learnings)
    const entries = [], directory = opendirSync(learnings)
    try {
      let entry, count = 0
      while ((entry = directory.readSync())) {
        if (++count > 1000) throw new Error('.learnings 目录超过 1000 项读取上限。')
        if (entry.name.endsWith('.md')) entries.push(entry.name)
      }
    } finally { directory.closeSync() }
    entries.sort()
    files.push(...entries.slice(0, 8).map(name => join('.learnings', name)))
    if (entries.length > 8) warnings.push('仅选择前 8 份 .learnings 笔记。')
  }
  for (const file of files) {
    const absolute = join(root, file)
    if (!existsSync(absolute)) continue
    const text = read(root, absolute)
    items.push({ kind: 'note', id: file, label: '作者笔记／非正式事实', text, identity: { file }, sourceHash: hash(text) })
  }
  if (!items.length) warnings.push('未发现固定文学笔记。')
  return { items, warnings }
}
