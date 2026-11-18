import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { digest } from './manuscript.js'
import { describeBook, openBook } from './read.js'
import { ensurePolicy } from './supervision-policy.js'
import templates from './templates.json' with { type: 'json' }
function statOrNull(path) {
  try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
function target(path, name) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('新作品需要绝对目录。')
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('请填写 1–200 字的作品名称。')
  const normalized = resolve(path), parent = realpathSync(dirname(normalized)), root = join(parent, basename(normalized))
  if (root === parent) throw new Error('不能将文件系统根目录作为作品。')
  const stat = lstatSync(parent)
  if (!stat.isDirectory()) throw new Error('作品的上级目录必须存在。')
  const existing = statOrNull(root)
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error('作品目录不能是符号链接或普通文件。')
  return { path: root, name: name.trim(), parent: { dev: stat.dev, ino: stat.ino } }
}
function safe(root, relative) {
  let path = root
  for (const part of relative.split('/')) {
    path = join(path, part)
    if (statOrNull(path)?.isSymbolicLink()) throw new Error('初始化路径不能包含符号链接。')
  }
  return path
}
function put(root, relative, content) {
  const file = safe(root, relative)
  mkdirSync(dirname(file), { recursive: true })
  try { writeFileSync(file, content, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 1000000 || readFileSync(file, 'utf8') !== content) throw new Error(`初始化文件发生冲突，已保留原文件：${relative}`)
  }
}
export function previewCreation(path, name) {
  const value = target(path, name)
  if (existsSync(value.path) && readdirSync(value.path).length) throw new Error('请选择不存在或完全为空的作品目录；已有作品请使用添加入口。')
  return { path: value.path, name: value.name, token: digest({ ...value, supervision: true }),
    creates: ['.literarygiant/project.json', '.literarygiant/story.sqlite3', '.literarygiant/supervision.json', 'ReferenceLibrary/bible', 'ReferenceLibrary/sources', 'ReferenceLibrary/drafts', 'ReferenceLibrary/analyses', 'ReferenceLibrary/archive', 'ReferenceLibrary/bible（9 份基础笔记）', '.learnings'] }
}
export function initializeBook(input) {
  const value = target(input.path, input.name)
  if (typeof input.operation !== 'string' || !/^[\w-]{16,80}$/u.test(input.operation)) throw new Error('创建操作标识无效。')
  const supervised = input.token === digest({ ...value, supervision: true })
  const journal = safe(value.path, '.literarygiant/creation.json')
  if (!supervised && (input.token !== digest(value) || !existsSync(journal))) throw new Error('创建预览已变化，请重新预览。')
  const signature = digest({ ...value, ...(supervised ? { supervision: true } : {}), operation: input.operation })
  let creation
  if (existsSync(journal)) {
    if (!lstatSync(journal).isFile() || lstatSync(journal).size > 20000) throw new Error('创建收据无效。')
    creation = JSON.parse(readFileSync(journal, 'utf8'))
    if (creation.schema !== 'lg.creation.v1' || creation.signature !== signature) throw new Error('此目录已有其他创建操作，未覆盖。')
    const stat = lstatSync(value.path)
    if (creation.directory.dev !== stat.dev || creation.directory.ino !== stat.ino) throw new Error('创建目录身份已变化。')
    if (existsSync(safe(value.path, '.literarygiant/project.json'))) {
      const book = describeBook(value.path)
      if (book.id !== creation.project.project_id) throw new Error('创建收据与作品身份不一致。')
      return book
    }
  } else {
    previewCreation(input.path, input.name)
    if (!statOrNull(value.path)) mkdirSync(value.path)
    if (readdirSync(value.path).length) throw new Error('目录已有内容，请重新选择空目录。')
    mkdirSync(join(value.path, '.literarygiant'))
    const stat = lstatSync(value.path), date = new Date().toISOString()
    creation = { schema: 'lg.creation.v1', signature, directory: { dev: stat.dev, ino: stat.ino }, project: {
      schema_version: 'lg.story-project.v1', project_id: randomUUID().replaceAll('-', ''), name: value.name,
      workspace: value.path, created_at: date, updated_at: date } }
    put(value.path, '.literarygiant/creation.json', JSON.stringify(creation) + '\n')
  }
  const dbPath = safe(value.path, '.literarygiant/story.sqlite3')
  if (existsSync(dbPath) && (!lstatSync(dbPath).isFile() || lstatSync(dbPath).size > 16000000)) throw new Error('待初始化数据库无效。')
  const db = new DatabaseSync(dbPath, { allowExtension: false })
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; BEGIN IMMEDIATE'); db.exec(schema)
    for (const [key, data] of Object.entries({ schema_version: 'lg.story-database.v1', project_id: creation.project.project_id, project_name: value.name, workspace: value.path })) {
      const stored = db.prepare('SELECT value FROM project_meta WHERE key=?').get(key)
      if (stored && stored.value !== data) throw new Error('初始化数据库身份冲突，未覆盖。')
      db.prepare('INSERT OR IGNORE INTO project_meta(key,value) VALUES (?,?)').run(key, data)
    }
    db.exec('COMMIT')
  } finally { db.close() }
  for (const folder of ['bible', 'sources', 'drafts', 'analyses', 'archive']) mkdirSync(safe(value.path, 'ReferenceLibrary/' + folder), { recursive: true })
  mkdirSync(safe(value.path, '.learnings'), { recursive: true })
  for (const [name, text] of Object.entries(templates)) put(value.path, 'ReferenceLibrary/bible/' + name, text)
  put(value.path, '.literarygiant/assets.json', JSON.stringify({ schema: 'lg.assets.v1', status: 'complete', moves: [] }) + '\n')
  // Publish the readable project identity only after the database and templates are ready.
  if (supervised) ensurePolicy({root:value.path, project:creation.project})
  put(value.path, '.literarygiant/project.json', JSON.stringify(creation.project, null, 2) + '\n')
  return describeBook(value.path)
}
export function integrity(path) {
  const book = openBook(path)
  try {
    const check = book.db.prepare('PRAGMA quick_check').all(), foreign = book.db.prepare('PRAGMA foreign_key_check').all()
    const required = ['project_meta','documents','document_versions','entity_tags','story_facts','fact_history','fact_proposals','scene_cards','timeline_entries','foreshadowing','review_issues']
    const tables = new Set(book.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
    const missing = required.filter(name => !tables.has(name))
    const invalidHeads = missing.length ? null : book.db.prepare('SELECT COUNT(*) AS n FROM documents d LEFT JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id WHERE d.active_version_id IS NOT NULL AND v.id IS NULL').get().n
    book.verify()
    return { ok: check.every(row => Object.values(row)[0] === 'ok') && !foreign.length && !missing.length && invalidHeads === 0,
      sqlite: check.map(row => Object.values(row)[0]), foreignKeyViolations: foreign.length, missingTables: missing, invalidActiveVersions: invalidHeads,
      note: '数据库结构、外键和作品身份检查；不证明正文或全部领域记录语义正确。' }
  } finally { book.close() }
}
