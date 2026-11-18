import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBook } from './fixture.mjs'
import { storyIndex } from '../src/story-index.js'

// hashlib.sha256(json.dumps(the legacy fixture snapshot, ensure_ascii=False, sort_keys=True).encode()).
const fingerprint = '267f0ce9483cc91fd7d67d4a57555a89da025b913588fc33db897c823094c174'
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'lg-analysis-')), {db}=createBook(root)
  t.after(()=>db.close())
  const entry={key:'light',label:'灯熄灭',analysis:'灯灭时风也停了。',evidence:[{document_id:1,version_id:1,quote:'林澈关上灯'}]}
  const payload={schema:'lg.book-analysis.v1',project_id:'test-book',chapter:'doc-1',library:'EventsLibrary',
    fingerprint,source_fingerprint:fingerprint,report:{summary:'灯灭',entries:[entry],findings:[]}}
  const put=(p=payload,legacy=false)=>{
    const dir=join(root,legacy?'.literarygiant/analysis':'ReferenceLibrary/analyses','doc-1')
    mkdirSync(dir,{recursive:true});writeFileSync(join(dir,p.library+'.json'),JSON.stringify(p))
  }
  return {root,db,entry,payload,put,read:()=>storyIndex(root),save:token=>storyIndex(root,token)}
}
const projected = index=>index.events.filter(e=>e.evidence.state==='analysis')

test('current legacy report exposes an exact chapter/scene citation and persists it with the original index fields',t=>{
  const f=setup(t);f.entry.evidence.push({document_id:2,version_id:2,quote:'另一份正文'});f.put()
  const index=f.read();assert.deepEqual(index.issues,[])
  const [row]=projected(index);assert.equal(row.id,'analysis:1:EventsLibrary:light');assert.equal(row.evidence.document,'第一章 旧码头 · 章节分析')
  assert.deepEqual(row.evidence.quotes.map(q=>[q.version_id,q.title,q.quote]),[[1,'第一章 旧码头','林澈关上灯'],[2,'不重复累计的场景','另一份正文']])
  const receipt=f.save(index.token);assert.ok(JSON.parse(readFileSync(receipt.path)).events.some(e=>e.id===row.id))
})

test('snapshot equality depends on the entire chapter, even if a quoted passage still matches',t=>{
  const f=setup(t);f.put();const before=f.read()
  f.db.exec("UPDATE document_versions SET content='场景换了。' WHERE id=2")
  const after=f.read();assert.deepEqual(projected(after),[]);assert.equal(after.issues.length,0)
  assert.ok(after.gaps.some(g=>g.reason==='analysis-stale'));assert.throws(()=>f.save(before.token),/重新读取/)
})

test('a Canonical-only change is distinguished from a manuscript change and withholds the analysis',t=>{
  const f=setup(t);f.put()
  f.db.exec("INSERT INTO story_facts(category,fact_key,value,state,created_at,updated_at) VALUES('物品','灯','红色','canonical','','')")
  const after=f.read();assert.deepEqual(projected(after),[]);assert.ok(after.gaps.some(g=>g.reason==='analysis-canon'))
  assert.equal(after.issues.length,0)
})

test('rejects fabricated evidence, wrong version, malformed card and ungrounded Canonical conflict before replacing cache',t=>{
  const f=setup(t);f.put();const saved=f.save(f.read().token),original=readFileSync(saved.path)
  const invalid=[
    {...f.entry,evidence:[{document_id:1,version_id:1,quote:'不存在的句子'}]},
    {...f.entry,evidence:[{document_id:1,version_id:2,quote:'林澈关上灯'}]},
    {...f.entry,analysis:''},
  ]
  const variants=invalid.map(entry=>({...f.payload,report:{...f.payload.report,entries:[entry]}}))
  variants.push({...f.payload,contract:'lg.reference-card.v1'}, {...f.payload,contract:'lg.reference-card.v8'},
    {...f.payload,report:{...f.payload.report,findings:[{kind:'canon_conflict',explanation:'设定有冲突',evidence:f.entry.evidence,fact_id:42,fact_quote:'假设定'}]}})
  for(const bad of variants){
    f.put(bad);const preview=f.read();assert.equal(preview.issues.length,1);assert.equal(projected(preview).length,0)
    assert.throws(()=>f.save(preview.token));assert.deepEqual(readFileSync(saved.path),original)
  }
})

test('current location takes precedence and an organized book ignores the retired report tree',t=>{
  const f=setup(t);f.put(f.payload,true);assert.equal(projected(f.read()).length,1)
  writeFileSync(join(f.root,'.literarygiant/assets.json'),JSON.stringify({schema:'lg.assets.v1',status:'complete'}))
  assert.equal(projected(f.read()).length,0)
  f.put({...f.payload,report:{...f.payload.report,entries:[{...f.entry,label:'当前目录'}]}})
  assert.equal(projected(f.read())[0].label,'当前目录')
})

test('events grounded only in an author-selected plan are marked planned and cannot quote other options',t=>{
  const f=setup(t),topic={scope:'work',document_id:null,key:'航线'},selection={title:'沿岸',content:'沿岸返航。',options_version_id:22}
  f.db.prepare("INSERT INTO documents(id,kind,slug,title,state,active_version_id,created_at,updated_at) VALUES(22,'creative_decision','route','航线','draft',22,'','')").run()
  f.db.prepare("INSERT INTO document_versions(id,document_id,version_number,state,content,reason,created_at) VALUES(22,22,1,'draft',?,'','')").run(JSON.stringify({schema:'lg.creative-decision.v1',topic,selection}))
  f.payload.fingerprint=f.payload.source_fingerprint='4fd817ff8ce18828c1272afec13c8f843dd189ba3c1bedd89bb970fa9e189a43'
  f.entry.evidence=[{document_id:22,version_id:22,quote:'沿岸返航'}];f.put()
  const read=()=>storyIndex(f.root,undefined,()=>({topic,selection,source_status:'unbound',source_details:[]}))
  assert.equal(projected(read())[0].planned,true)
  f.entry.evidence.push({document_id:1,version_id:1,quote:'林澈关上灯'});f.put()
  assert.equal(projected(read())[0].planned,false)
  f.entry.evidence[0].quote='向外海驶去';f.put()
  assert.equal(read().issues.length,1);assert.equal(projected(read()).length,0)
})
