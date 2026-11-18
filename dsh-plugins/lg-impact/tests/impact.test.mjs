import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { createContext } from '../../lg-context/src/service.js'
import { createImpact } from '../src/service.js'
import { randomUUID } from 'node:crypto'
import { createPlanning } from '../../lg-planning/src/service.js'
import { createMemory } from '../../lg-memory/src/service.js'

function setup() {
  const path = realpathSync(mkdtempSync(join(tmpdir(),'lg-impact-')))
  createBook(path).db.close()
  const books = { readState:(p,fn)=>accessState(p,false,fn) }
  const service = createImpact(books)
  const write = fn => accessState(path,true,fn)
  const inspect = (document,version,offset) => service.inspect(path,document,version,offset)
  return { path,books,service,write,inspect }
}
function metadata(db, id, value) {
  db.prepare('UPDATE document_versions SET metadata_json=? WHERE id=?').run(JSON.stringify(value),id)
}
test('document-only timeline and foreshadowing links stay separate from version-bound facts, proposals and edit bases',()=>{
  const s=setup()
  s.write(db=>{
    db.exec(`INSERT INTO story_facts(category,fact_key,value,state,source_document_id,source_version_id,created_at,updated_at)
      VALUES ('地点','灯塔','码头','canonical',1,1,'now','now');
      INSERT INTO fact_proposals(category,fact_key,value,source_document_id,source_version_id,status,created_at)
      VALUES ('地点','旧址','码头',1,8,'proposed','now');
      INSERT INTO timeline_entries(label,event,state,source_document_id,created_at,updated_at) VALUES ('夜','熄灯','canonical',1,'now','now');
      INSERT INTO foreshadowing(title,setup_note,setup_document_id,payoff_document_id,state,created_at,updated_at) VALUES ('信','收到',1,1,'paid','now','now')`)
    metadata(db,8,{base_version_id:1,source_version_id:1})
  })
  const all=s.inspect(1), specific=s.inspect(1,1)
  assert.deepEqual(all.items.map(i=>i.relation).sort(),['声明来源','声明来源','关联正文','埋设位置','回收位置','编辑依据'].sort())
  assert.deepEqual(specific.items.map(i=>i.kind).sort(),['作品事实','文档版本'].sort())
  assert.equal(s.inspect(1,8).items[0].status,'候选版本')
  assert.throws(()=>s.inspect(1,6),/不属于/)
  assert.throws(()=>s.inspect(1,0),/编号/)
})
test('actual context service receipt links admitted documents, ignores options-only and refuses a foreign book',()=>{
  const s=setup(), context=createContext(s.books,{})
  const receipt=context.build(s.path,{documents:[6]}).receipt
  s.write(db=>metadata(db,8,{generation:{context:receipt}}))
  assert.equal(s.inspect(6,6).items[0].relation,'模型上下文')
  s.write(db=>metadata(db,8,{generation:{context:{...receipt,sources:[]}}}))
  assert.equal(s.inspect(6,6).discovered,0)
  s.write(db=>metadata(db,8,{generation:{context:{...receipt,book:'another-book'}}}))
  assert.equal(s.inspect(6,6).discovered,0);assert.equal(s.inspect(6,6).stats.invalid,1)
})
test('receipt produced by old Python host requires the recorded output digest and a matching owned version',()=>{
  const s=setup(), legacy=JSON.parse(readFileSync(new URL('./fixtures/legacy-sources.json',import.meta.url)))
  s.write(db=>{metadata(db,8,legacy);db.prepare('UPDATE document_versions SET content=? WHERE id=8').run('合成结果')})
  const first=s.inspect(1,1)
  assert.equal(first.discovered,1);assert.equal(first.items[0].relation,'旧生成收据 · read_document');assert.equal(first.stats.indexOnly,1)
  s.write(db=>db.exec("UPDATE document_versions SET content='已被修改' WHERE id=8"))
  assert.equal(s.inspect(1).discovered,0);assert.equal(s.inspect(1).stats.invalid,1)
  s.write(db=>{db.exec("UPDATE document_versions SET content='合成结果' WHERE id=8");legacy.generation_sources.observations[0].refs[0].version_id=6;metadata(db,8,legacy)})
  assert.equal(s.inspect(1).discovered,0);assert.equal(s.inspect(1).stats.invalid,1)
})
test('scene plan and review receipts distinguish the material they read from the manuscript under review',()=>{
  const s=setup(),receipt=createContext(s.books,{}).build(s.path,{documents:[6]}).receipt
  s.write(db=>{
    db.prepare("INSERT INTO scene_cards(document_id,chapter_id,status,metadata_json,created_at,updated_at) VALUES (2,1,'planned',?,'now','now')").run(JSON.stringify({lg_plan_proposal:{generation:{context:receipt}}}))
    db.exec('CREATE TABLE lg_review_runs(id TEXT PRIMARY KEY,source_json TEXT)')
    db.prepare('INSERT INTO lg_review_runs VALUES (?,?)').run('review-test',JSON.stringify({target:{section:'manuscript',id:1,version_id:8},context:{receipt}}))
  })
  assert.deepEqual(s.inspect(6,6).items.map(i=>i.kind).sort(),['审阅报告','待审场景计划'].sort())
  assert.equal(s.inspect(1,8).items[0].relation,'审阅对象')
  assert.equal(s.inspect(1,1).discovered,0)
})
test('historical results and pagination are read-only, and missing metadata is disclosed',()=>{
  const s=setup()
  s.write(db=>{
    db.exec('UPDATE documents SET active_version_id=8 WHERE id=1')
    const insert=db.prepare("INSERT INTO story_facts(category,fact_key,value,state,source_document_id,source_version_id,created_at,updated_at) VALUES ('状态',?,'历史','canonical',1,1,'now','now')")
    for(let i=0;i<55;i++)insert.run(String(i))
    db.exec("UPDATE document_versions SET metadata_json='broken' WHERE id=3")
  })
  const file=join(s.path,'.literarygiant/story.sqlite3'),before=readFileSync(file)
  const first=s.inspect(1,1),next=s.inspect(1,1,first.nextOffset)
  assert.equal(first.discovered,55);assert.equal(first.items.length,50);assert.equal(next.items.length,5)
  assert.equal(new Set([...first.items,...next.items].map(i=>i.id)).size,55)
  assert.ok(first.items.every(i=>i.status==='历史版本'));assert.equal(first.stats.invalid,1)
  assert.equal(s.service.documents(s.path,'码头').items[0].id,1)
  assert.deepEqual(s.service.versions(s.path,1).items.map(i=>i.id),[8,1])
  assert.deepEqual(readFileSync(file),before)
})
test('only current author selections and confirmed knowledge expose declared sources; withdrawal removes those links',()=>{
  const s=setup()
  const {books,path}=s
  books.changeState=(p,fn)=>accessState(p,true,fn)
  const planning=createPlanning(books), memory=createMemory(books)
  const impact=createImpact(books,(p,kind,id)=>kind==='creative_decision'?planning.read(p,'decisions',id):memory.record(p,'knowledge',id))
  const apply=(service,change)=>service.apply(path,change,service.preview(path,change).token,randomUUID())
  const sources=[{document_id:1,version_id:1}]
  const direction=apply(planning,{action:'decision.options',slug:'port',title:'航向',expected_version_id:0,
    topic:{scope:'chapter',document_id:1,key:'port'},sources,request:'三种选择',options:['东行','西行','停船'].map((title,i)=>({id:String(i),title,content:title}))})
  const cognition=apply(memory,{action:'knowledge.propose',slug:'lamp',title:'灯光',expected_version_id:0,
    topic:{audience:'reader',holder_document_id:null,key:'light',from_position:1},statement:{content:'灯已熄灭',stance:'knows',until_position:null,sources},rationale:'第一章末'})
  const relations=()=>impact.inspect(path,1,1).items.map(item=>item.relation)
  assert.deepEqual(relations(),[])
  const selected=apply(planning,{action:'decision.select',id:direction.document_id,expected_version_id:direction.version_id,options_version_number:1,option_id:'0'})
  const confirmed=apply(memory,{action:'knowledge.confirm',id:cognition.document_id,expected_version_id:cognition.version_id,proposal_version_number:1})
  assert.deepEqual(relations().sort(),['已选方向依据','已确认认知依据'].sort())
  apply(planning,{action:'decision.withdraw',id:selected.document_id,expected_version_id:selected.version_id})
  apply(memory,{action:'knowledge.withdraw',id:confirmed.document_id,expected_version_id:confirmed.version_id})
  assert.deepEqual(relations(),[])
})
test('bounded version scanning reports omitted rows instead of claiming full coverage',()=>{
  const s=setup()
  s.write(db=>{const insert=db.prepare("INSERT INTO document_versions(document_id,version_number,state,content,reason,created_at) VALUES (1,?,'draft','','test','now')")
    for(let i=3;i<=5004;i++)insert.run(i)
  })
  const report=s.inspect(1);assert.equal(report.stats.scanned.versions,5000);assert.ok(report.stats.limited.includes('versions'))
})
