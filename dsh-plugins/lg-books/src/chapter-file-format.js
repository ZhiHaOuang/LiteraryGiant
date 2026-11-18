import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const hash = text => createHash('sha256').update(text).digest('hex')
export const maxBytes = 8_000_000

export function chapterPath(root, directories, name, create = false) {
  if (!name || /[/\\\0]/u.test(name) || name === '.' || name === '..') throw new Error('章节文件名无效。')
  let parent = root
  for (const directory of directories) {
    parent = join(parent, directory)
    if (create) mkdirSync(parent, { recursive: true })
    try {
      if (realpathSync(parent) !== parent) throw new Error('章节目录不可使用符号链接。')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return join(parent, name)
}

export function readText(path, limit = maxBytes) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('章节文件类型或长度无效。')
    const bytes = readFileSync(fd)
    if (bytes.length > limit) throw new Error('章节文件过大。')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n?/gu, '\n')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  } finally { if (fd !== undefined) closeSync(fd) }
}

// Publish a complete new file without replacing a file an external editor just created.
export function createFile(path, text) {
  const temporary = join(dirname(path), '.lg-' + randomUUID() + '.tmp')
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
    linkSync(temporary, path)
  } finally { unlinkSync(temporary) }
}

export function render(rows, parts = rows.map(row => row.content)) {
  return '# ' + rows[0].title + '\n\n' + rows.map((row, i) =>
    '<!-- lg:document ' + row.id + ' -->\n' + parts[i] + '\n<!-- /lg:document -->\n\n').join('')
}

export function parse(text, rows) {
  const heading = '# ' + rows[0].title + '\n\n'
  const framing = () => new Error('只能修改标记之间的正文，章标题与标记须保留。')
  if (!text.startsWith(heading)) throw framing()
  const markers = text.matchAll(/^<!-- (?:lg:document (\d+)|\/lg:document) -->$/gmu)
  const parts = []
  let cursor = heading.length
  for (const row of rows) {
    const open = markers.next().value, close = markers.next().value
    if (!open || open[1] !== String(row.id) || !close || close[1] !== undefined) {
      throw new Error('章节或场景标记已变化，请保留编号和顺序。')
    }
    const start = open.index + open[0].length
    if (open.index !== cursor || text[start] !== '\n' || close.index < start + 2 || text[close.index - 1] !== '\n') throw framing()
    parts.push(text.slice(start + 1, close.index - 1))
    const end = close.index + close[0].length
    if (parts.length < rows.length && !text.startsWith('\n\n', end)) throw framing()
    cursor = parts.length < rows.length ? end + 2 : end
  }
  if (/[^\n]/u.test(text.slice(cursor))) throw framing()
  return parts
}

// Moving the old inode first preserves even an external save racing the refresh.
// Publication and restoration both refuse to replace a newly arrived destination.
export function refreshFile(root, chapter, path, expected, text) {
  const prefix = chapterPath(root, ['.literarygiant','chapter-sync-backups'], chapter + '-', true)
  return replaceWithBackup(path,expected,text,prefix,maxBytes,'previous.md')
}

export function replaceWithBackup(path, expected, text, prefix, limit, name) {
  const backup = join(mkdtempSync(prefix), name)
  renameSync(path, backup)
  try {
    if (readText(backup, limit) !== expected) throw new Error('文件在更新前已被再次保存。')
    createFile(path, text)
  } catch (error) {
    try { linkSync(backup, path) } catch {
      throw new Error('文件更新中断，两份内容均已保留。原文件位于 ' + backup, { cause:error })
    }
    unlinkSync(backup) // The original inode has its original name again.
    throw error
  }
  return backup
}
