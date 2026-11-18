import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function createBook(root) {
  mkdirSync(join(root, '.literarygiant'), { recursive: true })
  mkdirSync(join(root, 'ReferenceLibrary/bible'), { recursive: true })
  writeFileSync(join(root, '.literarygiant/project.json'), JSON.stringify({ schema_version: 'lg.story-project.v1',
    project_id: 'test-book', name: '潮汐来信 · 验证书稿', updated_at: '2026-11-07T00:00:00Z' }))
  writeFileSync(join(root, 'ReferenceLibrary/bible/book-overview.json'), JSON.stringify({ text: '守灯人林澈在停航前收到一封未来来信，必须在救人与守诺之间做出选择。' }))
  const db = new DatabaseSync(join(root, '.literarygiant/story.sqlite3'))
  db.exec(readFileSync(new URL('./fixtures/legacy-schema.sql', import.meta.url), 'utf8'))
  db.prepare('INSERT INTO project_meta VALUES (?,?)').run('schema_version', 'lg.story-database.v1')
  db.prepare('INSERT INTO project_meta VALUES (?,?)').run('project_id', 'test-book')
  function document(id, kind, title, content, state = 'draft', parent = null) {
    db.prepare(`INSERT INTO documents(id,kind,slug,title,state,parent_id,sequence,active_version_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,kind,'doc-'+id,title,state,parent,id,id,'2026-11-07','2026-11-07')
    db.prepare(`INSERT INTO document_versions(id,document_id,version_number,state,content,reason,created_at)
      VALUES (?,?,1,?,?,?,?)`).run(id,id,state,content,'Author fixture','2026-11-07')
  }
  document(1,'chapter','第一章 旧码头','林澈关上灯。海风停了。','accepted')
  document(2,'scene','不重复累计的场景','这段不是另一份正文。','accepted',1)
  document(3,'chapter','第二章 潮汐来信','','draft')
  document(4,'scene','灯塔下','潮水上涨，她没有回头。','draft',3)
  document(5,'chapter','第三章 未寄出的信','','draft')
  document(6,'character','林澈','守灯人。承诺等最后一艘船返港。','accepted')
  document(7,'outline','第一卷 归港','## 故事前提\n一封来自未来的信，改变了归港计划。','draft')
  db.prepare(`INSERT INTO document_versions(document_id,version_number,state,content,reason,created_at)
    VALUES (1,2,'candidate','候选文本不能计入正式正文','候选','2026-11-07')`).run()
  return { db, document }
}
