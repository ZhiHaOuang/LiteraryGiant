import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {prepareSource,verifySource} from '../src/context.js'
function setup(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 db.exec(`CREATE TABLE project_meta(key TEXT,value TEXT);INSERT INTO project_meta VALUES('project_id','book');
 CREATE TABLE documents(id INTEGER,kind TEXT,state TEXT,sequence INTEGER,active_version_id INTEGER,title TEXT);
 CREATE TABLE document_versions(id INTEGER,document_id INTEGER,content TEXT);
 INSERT INTO documents VALUES(101,'chapter','draft',1,201,'第一章');INSERT INTO documents VALUES(102,'chapter','draft',2,202,'后文秘密');
 INSERT INTO document_versions VALUES(202,102,'绝不能混入本轮');`)
 db.prepare('INSERT INTO document_versions VALUES(201,101,?)').run('第一行。\r\n\r\n第二行。\n第三行。')
 const record={id:'knowledge',evidence:[{document_id:101}],freshness:'current',related_changed:[],approval:'candidate',payload:{claim:'人物相信守卫在桥上'}}
 const books={readState:(_p,fn)=>fn(db),storyData:()=>({records:[record,{...record,id:'future',evidence:[{document_id:102}],payload:{secret:'后文泄漏'}}],total:2})}
 return {db,books,record}
}
test('single-newline manuscript uses the story-data paragraph convention and fixed source identity',t=>{
 const {books}=setup(t),source=prepareSource(books,'/book',{chapters:[1],through_chapter:1,brief:'分析'})
 assert.deepEqual(source.chapters[0].paragraphs,['第一行。','第二行。','第三行。'])
 assert.equal(source.chapters[0].document_id,101);assert.equal(source.chapters[0].number,1)
 assert.equal(source.records.length,1);assert.equal(source.records[0].approval,'candidate')
 assert.ok(!JSON.stringify(source).includes('后文泄漏'));assert.ok(!JSON.stringify(source).includes('绝不能混入本轮'))
 assert.equal(verifySource(books,source),true)
})
test('changes to manuscript or contributing story records invalidate previously prepared work',t=>{
 const {db,books,record}=setup(t),input={chapters:[1],through_chapter:1,brief:'分析'}
 const source=prepareSource(books,'/book',input)
 record.payload.claim='另一判断';assert.throws(()=>verifySource(books,source),/已变化/)
 const newer=prepareSource(books,'/book',input)
 db.prepare('UPDATE document_versions SET content=? WHERE id=201').run('修改正文')
 assert.throws(()=>verifySource(books,newer),/已变化/)
})
test('unavailable chapters and incoherent reading cutoffs fail before a model call',t=>{
 const {books}=setup(t)
 for(const input of [{chapters:[1,1],through_chapter:1},{chapters:[2],through_chapter:1},{chapters:[3],through_chapter:3}])assert.throws(()=>prepareSource(books,'/book',{...input,brief:'分析'}))
})
test('team time projection receives only already admitted records and is part of frozen source',t=>{
 const {books}=setup(t)
 let note='组内先后未知'
 books.storyTimeProjection=records=>{
  assert.deepEqual(records.map(r=>r.id),['knowledge'])
  return {groups:[],unplaced:[],warnings:[note]}
 }
 const source=prepareSource(books,'/book',{chapters:[1],through_chapter:1,brief:'分析'})
 assert.deepEqual(source.temporal.warnings,[note]);assert.ok(verifySource(books,source))
 note='来源时序判断变化';assert.throws(()=>verifySource(books,source),/已变化/)
})
