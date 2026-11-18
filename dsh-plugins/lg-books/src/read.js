import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { projectSummary } from './summary.js'
import { pendingByChapter } from './pending-versions.js'
import { readPolicy } from './supervision-policy.js'

export function containedFile(root, name, maxBytes = 2_000_000) {
  const path = realpathSync(join(root, name))
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('文件必须位于本作品目录内。')
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('文件类型或大小超出读取范围。')
  return path
}

export function openBook(directory, { write = false } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('请选择作品的绝对目录。')
  const root = realpathSync(directory)
  const manifestPath = containedFile(root, '.literarygiant/project.json')
  const raw = readFileSync(manifestPath, 'utf8')
  const project = JSON.parse(raw)
  if (project.schema_version !== 'lg.story-project.v1' || !project.project_id || typeof project.name !== 'string') {
    throw new Error('不是受支持的 LG 作品。请选择包含 .literarygiant/project.json 的作品目录。')
  }
  const path = containedFile(root, '.literarygiant/story.sqlite3', 2_000_000_000)
  const db = new DatabaseSync(path, { readOnly: !write, allowExtension: false })
  try {
    db.exec(write ? 'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE' : 'PRAGMA query_only = ON; BEGIN')
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM project_meta').all().map(row => [row.key, row.value]))
    if (meta.schema_version !== 'lg.story-database.v1' || meta.project_id !== project.project_id) {
      throw new Error('作品标识与数据库不一致，未读取内容。')
    }
    return { root, project, db, close() { db.close() }, verify() {
      if (readFileSync(manifestPath, 'utf8') !== raw) throw new Error('作品信息已变化，请刷新。')
    } }
  } catch (error) { db.close(); throw error }
}

export function describeBook(directory) {
  const book = openBook(directory)
  try { return { id: book.project.project_id, name: book.project.name, path: book.root } }
  finally { book.close() }
}

export function readBook(directory) {
  const book = openBook(directory)
  try {
    const documents = []
    let size = 0
    const rows = book.db.prepare(`SELECT d.*, v.content, v.version_number, v.state AS version_state
      FROM documents d LEFT JOIN document_versions v ON v.id = d.active_version_id AND v.document_id = d.id
      WHERE d.state NOT IN ('archived', 'rejected') ORDER BY d.sequence IS NULL, d.sequence, d.id`).iterate()
    for (const row of rows) {
      if (row.active_version_id !== null && row.content === null) throw new Error('正文版本引用损坏，请先修复作品。')
      size += (row.content ?? '').length
      if (documents.length >= 50_000 || size > 100_000_000) throw new Error('作品超过当前控制台的读取上限。')
      documents.push(row)
    }
    const scalar = sql => Number(book.db.prepare(sql).get().n)
    const counts = {
      candidates: scalar("SELECT COUNT(*) AS n FROM document_versions WHERE state = 'candidate'"),
      facts: scalar("SELECT COUNT(*) AS n FROM story_facts WHERE state = 'canonical'"),
      proposals: scalar("SELECT COUNT(*) AS n FROM fact_proposals WHERE status = 'proposed'"),
      foreshadowing: scalar("SELECT COUNT(*) AS n FROM foreshadowing WHERE state IN ('open', 'planned')"),
      issues: scalar("SELECT COUNT(*) AS n FROM review_issues WHERE status = 'open'"),
    }
    let overview = ''
    const warnings = []
    let supervision
    try { supervision = { categories: readPolicy(book)?.chapter_categories ?? [] } }
    catch (error) { supervision = { error: error.message } }
    try {
      const data = JSON.parse(readFileSync(containedFile(book.root, 'ReferenceLibrary/bible/book-overview.json'), 'utf8'))
      if (typeof data.text !== 'string') throw new Error('简介格式错误')
      overview = data.text.slice(0, 2000)
    } catch (error) {
      if (error.code !== 'ENOENT') warnings.push('已保存简介不可用：' + error.message)
    }
    const summary = projectSummary(documents)
    const pending=pendingByChapter(book.db)
    for (const chapter of summary.chapters) chapter.pendingVersions=pending.get(chapter.id)??0
    if (!overview) {
      const outline = documents.find(row => row.kind === 'outline' && row.content)
      const match = outline?.content.match(/(?:^|\n)#{1,6}\s*(?:一句话简介|故事前提|故事梗概)\s*\n([^#]+)/u)
      overview = match?.[1]?.trim().slice(0, 2000) ?? ''
    }
    const fingerprint = createHash('sha256')
    for (const row of documents) fingerprint.update(JSON.stringify([row.id, row.active_version_id, row.state, row.content, row.updated_at]))
    const revision = fingerprint.digest('hex')
    book.verify()
    return { id: book.project.project_id, name: book.project.name, path: book.root,
      overview, revision, updatedAt: book.project.updated_at, ...summary, counts, warnings, supervision }
  } finally { book.close() }
}
