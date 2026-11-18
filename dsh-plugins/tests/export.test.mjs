import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'
import { exportBook } from '../lg-export/index.js'

function setup(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(readFileSync(new URL('../lg-books/tests/fixtures/legacy-schema.sql', import.meta.url), 'utf8'))
  db.exec("INSERT INTO project_meta VALUES ('project_id','id')")
  const books = { list: () => [{ path: '/book', id: 'id', name: '潮汐 & 港口' }], readState: (_path, fn) => fn(db) }
  const write = (id, kind, state, content, parent = null, sequence = id) => {
    db.prepare("INSERT INTO documents(id,kind,slug,title,state,parent_id,sequence,active_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'','')").run(id,kind,'s'+id,'标题'+id,state,parent,sequence,id)
    db.prepare("INSERT INTO document_versions(id,document_id,version_number,state,content,reason,created_at) VALUES (?,?,1,?,?,'','')").run(id,id,state,content)
  }
  const get = (target, format = 'txt', includeDrafts = false) => exportBook(books,{path:'/book',target,format,includeDrafts})
  return { db, books, write, get }
}

test('manuscript export selects current prose or ordered scenes and never includes unadopted versions', t => {
  const {db,write,get} = setup(t)
  write(1,'chapter','accepted','正文 # * 原样保留')
  write(2,'scene','accepted','重复场景',1)
  write(3,'chapter','draft','')
  write(4,'scene','accepted','先',3,2)
  write(5,'scene','draft','后',3,3)
  write(6,'chapter','archived','归档')
  write(7,'scene','accepted','归档章子项',6)
  db.exec("INSERT INTO document_versions(document_id,version_number,state,content,reason,created_at) VALUES(1,2,'candidate','未采用','','')")
  const formal=get('manuscript').toString(), draft=get('manuscript','md',true).toString()
  assert.match(formal,/正文 # \* 原样保留/);assert.match(formal,/标题4\n\n先/)
  assert.doesNotMatch(formal,/重复场景|归档|未采用|标题5/)
  assert.match(draft,/### 标题4[\s\S]+### 标题5/);assert.doesNotMatch(draft,/重复场景|未采用|归档/)
  db.exec("UPDATE document_versions SET state='candidate' WHERE id=1")
  assert.doesNotMatch(get('manuscript','txt',true).toString(),/正文 #/)
})

test('formal facts require a current accepted source, expanded export marks ideas and stale sources', t => {
  const {db,write,get}=setup(t)
  write(1,'chapter','accepted','正文')
  db.exec("INSERT INTO document_versions(id,document_id,version_number,state,content,reason,created_at) VALUES(2,1,2,'accepted','二版','','')")
  const put=db.prepare("INSERT INTO story_facts(category,fact_key,value,state,source_document_id,source_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'','')")
  put.run('character.voice','声音','清亮','canonical',1,1)
  put.run('地点','码头','雾蓝','canonical',null,null)
  put.run('物品','旧钟','旧版','canonical',1,2)
  put.run('关系','猜想','尚未确认','idea',null,null)
  put.run('world','不要','驳回的事实','rejected',null,null)
  assert.match(get('characters').toString(),/清亮/);assert.doesNotMatch(get('characters').toString(),/雾蓝|猜想/)
  assert.match(get('world').toString(),/雾蓝/);assert.doesNotMatch(get('world').toString(),/清亮|驳回/)
  assert.doesNotMatch(get('bible').toString(),/旧钟|猜想/)
  assert.match(get('bible','txt',true).toString(),/旧钟（来源待复核）/)
  assert.match(get('characters','txt',true).toString(),/猜想（构想）/)
})

test('timeline respects sort order and draft state, foreshadowing includes setup, payoff and tags',t=>{
  const {db,get}=setup(t)
  db.exec("INSERT INTO timeline_entries(label,sort_key,event,state,created_at,updated_at) VALUES ('后','2','归港','idea','',''),('先','1','启航','canonical','','')")
  assert.doesNotMatch(get('timeline').toString(),/归港/)
  assert.match(get('timeline','txt',true).toString(),/启航[\s\S]+后（构想）[\s\S]+归港/)
  db.prepare("INSERT INTO foreshadowing(title,setup_note,payoff_note,state,tags_json,created_at,updated_at) VALUES(?,?,?,?,?,'','')").run('灯','约定','相认','paid','["结局"]')
  assert.match(get('foreshadowing').toString(),/灯（paid）[\s\S]+约定[\s\S]+相认[\s\S]+结局/)
})

test('DOCX preserves Chinese, Unicode, tabs, special XML characters and paragraph breaks', t => {
  const {write,get}=setup(t);write(1,'chapter','accepted','潮<&>🌊\t尾\n\n第二段')
  const zip=unzipSync(get('manuscript','docx')), xml=strFromU8(zip['word/document.xml'])
  assert.match(xml,/潮&lt;&amp;&gt;🌊<\/w:t><w:tab\/>/)
  assert.match(xml,/第二段/);assert.match(xml,/w:val="Title"/);assert.ok(zip['word/_rels/document.xml.rels'])
  assert.match(get('manuscript','md').toString(),/^# 潮汐 & 港口/);assert.doesNotMatch(get('manuscript').toString(),/^# /)
})

test('rejects unregistered paths, invalid scopes, empty exports and broken active pointers', t => {
  const {books,db,write,get}=setup(t)
  assert.throws(()=>exportBook(books,{path:'/other',target:'bible',format:'md'}),/登记/)
  for(const input of [{format:'pdf'},{target:'__proto__'},{includeDrafts:'yes'},{format:['md']}]) {
    assert.throws(()=>exportBook(books,{path:'/book',target:'bible',format:'md',...input}),/无效/)
  }
  assert.throws(()=>get('manuscript'),/没有可导出/)
  write(1,'chapter','accepted','one');db.exec('UPDATE documents SET active_version_id=99')
  assert.throws(()=>get('manuscript'),/引用损坏/)
})

test('exports beyond the historical 1000-record cutoff without truncating silently',t=>{
  const {db,get}=setup(t)
  db.exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1005) INSERT INTO timeline_entries(label,event,state,created_at,updated_at) SELECT printf('%04d',i), 'event','canonical','','' FROM n")
  assert.match(get('timeline').toString(),/1005/)
})
