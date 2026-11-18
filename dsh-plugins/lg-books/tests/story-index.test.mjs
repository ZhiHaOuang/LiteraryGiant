import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBook } from './fixture.mjs'
import { hash } from '../src/chapter-file-format.js'
import { storyIndex } from '../src/story-index.js'

const graph = {characters:[{id:'a',name:'阿青',role:'主角',summary:'守灯'},{id:'b',name:'渡鸦',role:'同伴',summary:'送信'}],
  events:[{id:'e',label:'出航',summary:'起锚',planned:true}],relationships:[{source:'a',target:'b',label:'委托'}],links:[]}

function setup(t) {
  const path=mkdtempSync(join(tmpdir(),'lg-story-')), {db}=createBook(path)
  t.after(()=>db.close())
  const dir=join(path,'ReferenceLibrary/indices');mkdirSync(dir)
  const put=(id,value)=>db.prepare('UPDATE document_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({story_index:value}),id)
  return {path,db,dir,put,read:()=>storyIndex(path),save:token=>storyIndex(path,token),file:join(dir,'story.json')}
}

test('active-version graph scopes endpoints per document, removes old rows on edit and excludes candidate heads',t=>{
  const f=setup(t);f.put(1,graph);f.put(3,graph);f.put(8,{characters:[{...graph.characters[0],name:'不公开候选'}]})
  const index=f.read();assert.equal(index.issues.length,0)
  assert.deepEqual(index.relationships.map(r=>[r.source,r.target]),[['1:a','1:b'],['3:a','3:b']])
  assert.equal(index.events[0].evidence.version,1);assert.ok(index.events[0].planned)
  assert.ok(!index.characters.some(c=>c.name==='不公开候选'))
  f.db.exec("UPDATE documents SET active_version_id=8 WHERE id=1")
  assert.ok(!f.read().relationships.some(r=>r.source==='1:a'))
  assert.throws(()=>f.save(index.token),/重新读取/)
})

test('checksum-verified visible artifacts use their own namespace and expire after the source changes',t=>{
  const f=setup(t),source='ReferenceLibrary/outline.md',key=hash(source),record=join(f.dir,'artifact-'+key+'.json')
  writeFileSync(join(f.path,source),'大纲');const payload={path:source,sha256:hash('大纲'),graph,state:'candidate'}
  writeFileSync(record,JSON.stringify(payload))
  const first=f.read();assert.equal(first.relationships[0].source,'artifact-'+key+':a')
  assert.equal(first.relationships[0].evidence.state,'candidate')
  writeFileSync(record,JSON.stringify({...payload,display:false}));assert.equal(f.read().relationships.length,0)
  writeFileSync(record,JSON.stringify(payload));writeFileSync(join(f.path,source),'已改写')
  const next=f.read();assert.equal(next.relationships.length,0);assert.equal(next.missing,first.missing+1)
  assert.ok(next.gaps.some(g=>g.source===source && g.reason==='changed-artifact'))
  assert.ok(next.gaps.some(g=>g.source==='第一章 旧码头' && g.version===1))
})

test('derived cache includes chapter/scene fallbacks and sorted evidence; repeat save is a no-op and the old cache is preserved',t=>{
  const f=setup(t)
  f.db.exec("INSERT INTO entity_tags VALUES('document',6,'主角'); INSERT INTO timeline_entries(label,sort_key,event,state,created_at,updated_at) VALUES('后','2','计划','idea','',''),('先','1','登岸','canonical','',''); INSERT INTO scene_cards(document_id,chapter_id,status,goal,created_at,updated_at) VALUES(4,3,'planned','停航前抵达','','')")
  const put=f.db.prepare("INSERT INTO story_facts(category,fact_key,value,state,source_document_id,source_version_id,created_at,updated_at) VALUES('人物',?,?,'canonical',1,?,'','')")
  put.run('现有角色','送信人',1);put.run('已过期角色','旧稿',8)
  const index=f.read();assert.ok(index.characters.some(c=>c.role==='主角'));assert.ok(index.characters.some(c=>c.name==='现有角色'))
  assert.ok(!index.characters.some(c=>c.name==='已过期角色'));assert.deepEqual(index.events.map(e=>e.planned),[false,true,true])
  assert.equal(existsSync(f.file),false);assert.ok(f.save(index.token).changed)
  const previous=readFileSync(f.file,'utf8'),old=JSON.parse(previous);assert.equal(old.chapters[1].has_prose,true);assert.equal(old.chapters[2].has_prose,false)
  assert.equal(old.chapters[0].active_version_id,1);assert.equal(old.outlines[0].content.includes('未来'),true)
  const next=f.read();assert.ok(next.current);assert.equal(f.save(next.token).changed,false)
  f.put(1,graph);const saved=f.save(f.read().token);assert.equal(readFileSync(saved.backup,'utf8'),previous)
})

test('malformed graphs reject the entire source and block cache publication',t=>{
  const f=setup(t);f.save(f.read().token);const original=readFileSync(f.file)
  for(const g of [{...graph,relationships:[{source:'a',target:'none',label:'缺失'}]},
    {...graph,events:[{...graph.events[0],planned:1}]},{...graph,characters:[graph.characters[0],graph.characters[0]]}]){
    f.put(1,g);const result=f.read();assert.ok(result.issues.length);assert.equal(result.relationships.length,0)
    assert.throws(()=>f.save(result.token),/核对/);assert.deepEqual(readFileSync(f.file),original)
  }
})

test('unknown cache, unsupported chapter analysis, changed preview and escaping artifact sources never replace files',t=>{
  const f=setup(t),before=f.read();writeFileSync(f.file,'私有手记')
  assert.throws(()=>f.save(before.token));assert.equal(readFileSync(f.file,'utf8'),'私有手记')
  const dir=join(f.path,'ReferenceLibrary/analyses/doc-1');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'CharacterArc.json'),'{}')
  const src='ReferenceLibrary/escape.md';symlinkSync(join(tmpdir(),'outside-lg-test'),join(f.path,src))
  writeFileSync(join(f.dir,'artifact-'+hash(src)+'.json'),JSON.stringify({path:src,sha256:hash(''),state:'draft',graph}))
  const result=f.read();assert.equal(result.issues.length,3);assert.equal(result.relationships.length,0)
  assert.throws(()=>f.save(result.token));assert.equal(readFileSync(f.file,'utf8'),'私有手记')
})
