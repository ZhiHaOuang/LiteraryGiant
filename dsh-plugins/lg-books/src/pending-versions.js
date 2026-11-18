// Resolve each candidate through its current owner. An unassigned scene has no chapter queue.
const sources = `FROM document_versions v
  JOIN documents d ON d.id=v.document_id
  JOIN document_versions head ON head.id=d.active_version_id AND head.document_id=d.id
  JOIN documents chapter ON chapter.id=CASE d.kind WHEN 'chapter' THEN d.id WHEN 'scene' THEN d.parent_id END
  JOIN document_versions ch ON ch.id=chapter.active_version_id AND ch.document_id=chapter.id
  WHERE v.state='candidate' AND chapter.kind='chapter'
    AND d.state NOT IN ('archived','rejected','candidate') AND head.state NOT IN ('archived','rejected','candidate')
    AND chapter.state NOT IN ('archived','rejected','candidate') AND ch.state NOT IN ('archived','rejected','candidate')`

export function pendingByChapter(db) {
  return new Map(db.prepare(`SELECT chapter.id, count(*) AS n ${sources} GROUP BY chapter.id`).all().map(row=>[row.id,row.n]))
}

export function pendingVersions(db, chapter, before) {
  if (!Number.isSafeInteger(chapter)||chapter<1||before!=null&&(!Number.isSafeInteger(before)||before<1)) throw new Error('章节或候选分页位置无效。')
  const rows=db.prepare(`SELECT d.id AS document,d.kind,d.title,v.id AS version,v.version_number AS number,
    substr(v.reason,1,240) AS reason,v.created_at AS createdAt ${sources}
    AND chapter.id=? ${before==null?'':'AND v.id<?'} ORDER BY v.id DESC LIMIT 21`).all(...(before==null?[chapter]:[chapter,before]))
  const items=rows.slice(0,20)
  return {items,before:rows.length>20?items.at(-1).version:null}
}
