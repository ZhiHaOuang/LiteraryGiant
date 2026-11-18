import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createBook} from './fixture.mjs'
import {compactFingerprint as fingerprint} from '../src/analysis-snapshot.js'
import {hash} from '../src/chapter-file-format.js'
import {readManuscript} from '../src/manuscript.js'
import {previewAcceptance,writeManuscript} from '../src/write.js'
import {candidateAnalysis} from '../src/candidate-analysis.js'
import {accessState} from '../src/state.js'
import {createPlanning} from '../../lg-planning/src/service.js'
import {decision} from '../../lg-planning/src/decisions.js'

function setup(t,withChoice=false){
  const root=mkdtempSync(join(tmpdir(),'lg-old-chapter-')),{db}=createBook(root);t.after(()=>db.close())
  const books={readState:(p,fn)=>accessState(p,false,fn),changeState:(p,fn)=>accessState(p,true,fn)},planning=createPlanning(books)
  const change=c=>planning.apply(root,c,planning.preview(root,c).token,randomUUID())
  const select=(d,id)=>change({action:'decision.select',id:d.document_id,expected_version_id:d.version_id,options_version_number:1,option_id:id})
  const head=readManuscript(root,1),base=head.selected,old=readManuscript(root,1,8).selected,run='synthetic-bounded-run'
  const observed={tool:'read_document',coverage:'partial',payload_sha256:fingerprint({id:1,active_version_id:base.id,content:base.content,state:head.document.state}),refs:[{kind:'document',document_id:1,version_id:1,exposure:'content'}]}
  const receipt={schema:'lg.generation-sources.v1',mode:'literary-task',run_id:run,stage_id:'chapter',coverage:'partial',observations:[observed],input:{prompt_sha256:hash('prompt'),instructions_sha256:hash('instructions')},unknown_reasons:[]}
  const m={run_id:run,literary_task_policy:'lg.literary-task.v1',base_version_id:1,generation_sources:receipt,generation_output_sha256:hash(old.content)}
  let picked
  if(withChoice){
    const options=change({action:'decision.options',slug:'key-route',title:'钥匙去向',expected_version_id:0,topic:{scope:'chapter',document_id:1,key:'key'},request:'三个方向',sources:[{document_id:1,version_id:1}],options:['a','b','c'].map(id=>({id,title:id,content:'选择'+id}))})
    picked=select(options,'a');const {selection,topic,status,source_status}=picked
    const ref={kind:'creative_decision',exposure:'selected',document_id:picked.document_id,option_id:'a',options_version_id:options.options_version_id,selection_sha256:fingerprint({selection,topic,status,source_status,source_details:picked.source_details.map(({sha256,...x})=>x)})}
    receipt.observations.push({tool:'studio_decision',coverage:'partial',refs:[ref],payload_sha256:hash('historical decision projection')})
    m.required_decision={document_id:picked.document_id,selection_sha256:fingerprint(selection)}
  }
  const put=()=>db.prepare('UPDATE document_versions SET metadata_json=? WHERE id=8').run(JSON.stringify(m));put()
  const input={action:'accept',document:1,version:8,token:head.token,operation:randomUUID()}
  const call=(fn,value)=>fn(root,value,null,null,null,null,null,decision)
  return {root,db,m,put,input,picked,select,preview:(v=input)=>call(previewAcceptance,v),write:v=>call(writeManuscript,v)}
}
test('old bounded chapter requires an exact author preview and rechecks the original input and output',t=>{
  const s=setup(t),p=s.preview();assert.equal(p.legacySource.base,1);assert.equal(p.legacySource.version,8)
  assert.throws(()=>s.write(s.input),/重新预览/)
  s.db.prepare("UPDATE document_versions SET content=content||'修改' WHERE id=8").run()
  assert.throws(()=>s.write({...s.input,reviewToken:p.reviewToken}),/摘要/)
  s.db.prepare('UPDATE document_versions SET content=? WHERE id=8').run('候选文本不能计入正式正文')
  s.db.prepare("UPDATE document_versions SET content=content||'修改' WHERE id=1").run()
  const now=readManuscript(s.root,1);assert.equal(now.document.activeVersion,1)
  assert.throws(()=>s.preview({...s.input,token:now.token}),/原章内容/)
})
test('derived candidates preserve the original decision for both hosts and cannot be adopted after reselection',t=>{
  const s=setup(t,true),result=s.write({...s.input,action:'candidate',sourceVersion:8,content:'按原方向精修。',reason:'修改',operation:randomUUID()})
  const revised={...s.input,version:result.version},meta=readManuscript(s.root,1,result.version).selected.metadata
  assert.deepEqual(meta.required_decision,s.m.required_decision);assert.equal(s.preview(revised).legacySource.direction.option,'a')
  const p=s.preview();s.select(s.picked,'b')
  assert.throws(()=>s.write({...s.input,reviewToken:p.reviewToken}),/选择或方向来源已变化/)
  assert.throws(()=>s.preview(revised),/选择或方向来源已变化/)
  assert.equal(readManuscript(s.root,1).document.activeVersion,1)
})
test('supported legacy chapters still require supervision and unsupported receipt shapes cannot pass',t=>{
  const s=setup(t),all=['CharacterArc','EventsLibrary','PayoffAngst','EmotionRhythm','Worldview']
  writeFileSync(join(s.root,'.literarygiant/supervision.json'),JSON.stringify({schema:'lg.supervision.v1',project_id:'test-book',chapter_categories:['EventsLibrary'],volume_categories:all}))
  assert.throws(s.preview,/审阅缺失/)
  assert.equal(candidateAnalysis(s.root,s.input,decision).categories[0].state,'missing')
  s.m.generation_sources.observations.push(s.m.generation_sources.observations[0]);s.put()
  assert.throws(s.preview,/来源记录/);assert.throws(()=>candidateAnalysis(s.root,s.input,decision),/来源记录/)
})
test('a legacy selection-free chapter replays the original adoption receipt after the base changes',t=>{
  const s=setup(t),p=s.preview(),input={...s.input,reviewToken:p.reviewToken},saved=s.write(input)
  assert.deepEqual(saved.legacySource,p.legacySource);assert.equal(readManuscript(s.root,1).document.activeVersion,8)
  assert.deepEqual(s.write(input),saved)
})
