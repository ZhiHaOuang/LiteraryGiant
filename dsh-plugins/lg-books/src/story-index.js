import { appendAnalyses } from './analysis-index.js'
import { openBook } from './read.js'
import { chapterPath, createFile, hash, readText, replaceWithBackup } from './chapter-file-format.js'
import { appendArtifacts, appendGraph } from './story-graph.js'

const groups = ['characters','relationships','events','links']
const maxBytes = 32_000_000

function project(book, readDecision) {
  const db = book.db, issues = [], gaps = []
  const index = {characters:[],events:[],relationships:[],links:[],missing:0,chapters:[],outlines:[],name:book.project.name}
  let outputBytes = 0, entries = 0, analysisGaps = 0
  function add(group, item) {
    outputBytes += Buffer.byteLength(JSON.stringify(item))
    if (++entries > 100_000 || outputBytes > maxBytes) throw new RangeError('故事索引超过单次条目或大小上限。')
    index[group].push(item)
  }
  function markMissing(gap, report = false) {
    if (report) analysisGaps++
    else index.missing++
    if (gaps.length < 50) gaps.push(gap)
  }
  appendArtifacts(book.root,add,issues,markMissing)
  const tags = db.prepare("SELECT tag FROM entity_tags WHERE owner_type='document' AND owner_id=? ORDER BY tag")
  const written = new Set()
  let size = 0, seen = 0
  for (const row of db.prepare(`SELECT d.*,v.content,v.version_number,v.metadata_json AS version_meta,v.state AS version_state,
    sc.status AS scene_status FROM documents d LEFT JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id
    LEFT JOIN scene_cards sc ON sc.document_id=d.id WHERE d.state IN ('draft','accepted','final')
    ORDER BY d.kind,COALESCE(d.sequence,999999),d.created_at,d.id`).iterate()) {
    if (row.active_version_id !== null && row.version_number == null) throw new Error('作品的当前版本引用损坏。')
    if (row.version_state && !['draft','accepted','final'].includes(row.version_state)) continue
    const content = row.content ?? ''
    size += Buffer.byteLength(content) + Buffer.byteLength(row.version_meta ?? '') + Buffer.byteLength(row.metadata_json)
    if (++seen > 50_000 || size > maxBytes) throw new Error('作品超过单次故事索引上限。')
    const source = {document:row.title,document_id:row.id,kind:row.kind,version:row.version_number,state:row.state}
    const docTags = ['character','chapter','outline'].includes(row.kind) ? tags.all(row.id).map(t => t.tag) : []
    const graph = JSON.parse(row.version_meta ?? '{}').story_index
    if (graph != null) {
      try { appendGraph(add,graph,row.id,source) } catch (e) { if (e instanceof RangeError) throw e; issues.push(row.title + '：' + e.message) }
    } else if (row.kind === 'character') {
      add('characters',{id:'document:'+row.id,name:row.title,role:docTags.some(t => ['主角','protagonist'].includes(t)) ? '主角' : '人物资料',summary:content,evidence:source})
    } else if (['chapter','scene'].includes(row.kind) && content.trim()) markMissing({source:row.title,version:row.version_number,reason:'unannotated'})
    if (row.kind === 'scene' && content.trim() && row.scene_status !== 'archived') written.add(row.parent_id)
    if (row.kind === 'chapter' || row.kind === 'outline') {
      const doc = {id:row.id,kind:row.kind,slug:row.slug,title:row.title,state:row.state,parent_id:row.parent_id,sequence:row.sequence,
        active_version_id:row.active_version_id,active_version_number:row.version_number,content,tags:docTags,
        metadata:JSON.parse(row.metadata_json),created_at:row.created_at,updated_at:row.updated_at}
      if (row.kind === 'outline') add('outlines',doc)
      else add('chapters',doc)
    }
  }
  for (const chapter of index.chapters) chapter.has_prose = !!chapter.content.trim() || written.has(chapter.id)
  appendAnalyses(book,index.chapters,readDecision,add,issues,gap => markMissing(gap,true))
  for (const fact of db.prepare(`SELECT f.* FROM story_facts f LEFT JOIN documents d ON d.id=f.source_document_id
    LEFT JOIN document_versions v ON v.id=f.source_version_id AND v.document_id=d.id WHERE f.state='canonical'
    AND ((f.source_document_id IS NULL AND f.source_version_id IS NULL) OR
    (v.id=d.active_version_id AND d.state IN ('accepted','final') AND v.state IN ('accepted','final')))
    ORDER BY f.category,f.fact_key,f.id`).iterate()) {
    const category = [fact.category,...JSON.parse(fact.tags_json)].join(' ')
    if (/character|protagonist|人物|角色|主角/iu.test(category)) add('characters',{id:'fact:'+fact.id,name:fact.fact_key,
      role:/protagonist|主角/iu.test(category) ? '主角' : '已记录人物',summary:fact.value,evidence:{state:'canonical',document:'已确认设定',fact_id:fact.id}})
  }
  for (const e of db.prepare("SELECT * FROM timeline_entries WHERE state IN ('canonical','idea') ORDER BY sort_key,id").iterate()) {
    add('events',{id:'timeline:'+e.id,label:e.label,summary:e.event,planned:e.state!=='canonical',evidence:{state:e.state,document:'时间线',order:e.sort_key}})
  }
  for (const s of db.prepare(`SELECT sc.*,d.title,v.version_number FROM scene_cards sc JOIN documents d ON sc.document_id=d.id
    JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id WHERE sc.status!='archived'
    AND d.state IN ('draft','accepted','final') AND v.state IN ('draft','accepted','final')
    AND (sc.goal!='' OR sc.end_state!='') ORDER BY d.sequence IS NULL,d.sequence,d.id`).iterate()) {
    add('events',{id:'scene:'+s.document_id,label:s.title,summary:'目标：'+s.goal+'；终态：'+s.end_state,planned:true,
      evidence:{state:s.plan_state,document:'场景规划',document_id:s.document_id,version:s.version_number}})
  }
  return {index,issues,gaps,analysisGaps}
}

export function storyIndex(path, token, readDecision) {
  const publish = token !== undefined
  if (publish && (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token))) throw new Error('请先查看本次故事索引。')
  const book = openBook(path,{write:publish})
  try {
    const {index,issues,gaps,analysisGaps} = project(book,readDecision)
    const encoded = JSON.stringify(index,null,2)+'\n'
    if (Buffer.byteLength(encoded) > maxBytes) throw new Error('生成的故事索引超过保存上限。')
    const parts = ['ReferenceLibrary','indices']
    const file = chapterPath(book.root,parts,'story.json'), previous = readText(file,maxBytes)
    if (previous !== null) {
      try {
        const old = JSON.parse(previous)
        if (!['chapters','outlines',...groups].every(k => Array.isArray(old?.[k])) || typeof old.name !== 'string' || !Number.isSafeInteger(old.missing)) throw new Error()
      } catch { issues.push('已有 story.json 格式无法识别，已保留原文件。') }
    }
    const revision = hash(JSON.stringify([book.project.project_id,hash(encoded),analysisGaps,gaps,previous === null ? null : hash(previous)]))
    book.verify()
    if (publish) {
      if (issues.length || token !== revision) throw new Error('来源或现有索引发生变化，请重新读取并核对。')
      let backup
      if (previous === null) createFile(chapterPath(book.root,parts,'story.json',true),encoded)
      else if (previous !== encoded) {
        const prefix = chapterPath(book.root,['.literarygiant','story-index-backups'],'index-',true)
        backup = replaceWithBackup(file,previous,encoded,prefix,maxBytes,'story.json')
      }
      return {path:file,backup,changed:previous !== encoded}
    }
    return { ...Object.fromEntries(groups.map(k => [k,index[k]])),missing:index.missing+analysisGaps,issues,gaps,
      token:revision,current:previous === encoded,path:file }
  } finally { book.close() }
}
