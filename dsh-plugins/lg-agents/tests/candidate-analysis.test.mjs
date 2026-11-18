import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {readManuscript} from '../../lg-books/src/manuscript.js'
import {writeManuscript,previewAcceptance} from '../../lg-books/src/write.js'
import {candidateAnalysis} from '../../lg-books/src/candidate-analysis.js'
import {contract,finalizeCard,categories} from '../../lg-library/src/contracts.js'
import {createAgents} from '../src/service.js'
import {Executor} from '../../lg-execution/src/run.js'

function setup(t,{alter=()=>{},output,encode=JSON.stringify}={}) {
 const root=mkdtempSync(join(tmpdir(),'lg-candidate-analysis-')),{db}=createBook(root);t.after(()=>db.close())
 const all=['CharacterArc','EventsLibrary','PayoffAngst','EmotionRhythm','Worldview']
 writeFileSync(join(root,'.literarygiant/supervision.json'),JSON.stringify({schema:'lg.supervision.v1',project_id:'test-book',chapter_categories:all,volume_categories:all}))
 db.exec("INSERT INTO story_facts(category,fact_key,value,state,rationale,created_at,updated_at) VALUES('道具','灯','灯在塔上。','canonical','作者','now','now')")
 const token=readManuscript(root,1).token,v=writeManuscript(root,{action:'candidate',document:1,version:1,token,content:'林澈关上了铜灯。',reason:'核对',operation:randomUUID()}).version
 const books={candidateAnalysis:(p,target,save)=>candidateAnalysis(p,target,undefined,save)}
 const library={contracts:()=>categories.map(contract),finalizeChapterCard:(c,card,e)=>finalizeCard(c,card,e,true)}
 const config={roles:[]},price=new Executor(null,null,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:1,maxOutputTokens:1024,maxInputBytes:30000})
 const ledger=new Map(),execution={preview:x=>price.preview(x),status:id=>ledger.get(id),run:async(id,value)=>{
   if(ledger.has(id))return ledger.get(id)
   const p=JSON.parse(value.input),fill=x=>Array.isArray(x)?[]:x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,fill(v)])):
     typeof x==='number'||['1-5','-2 to 2','0 to 2'].includes(x)?1:x.includes('/')?x.split('/')[0]:'灯火变化'
   const data={summary:'章节检查',entries:[{key:'灯',label:'关灯',analysis:'人物主动关灯。',evidence:[p.units[0].id],instance_card:fill(p.instance_card)}],
    findings:[{kind:'canon_conflict',explanation:'请核对灯的状态。',evidence:[p.units[0].id],fact_id:1}]}
   output?.(data);alter(db)
   const run={id,status:'succeeded',result:{text:encode(data)}};ledger.set(id,run);return run
 }}
 const agents=createAgents(books,execution,config,()=>library),target={document:1,version:v,token}
 const task=c=>({task:'candidate-analysis',path:root,target:{...target,category:c},operation:randomUUID()})
 const accept=()=>previewAcceptance(root,{...target,operation:randomUUID()})
 const run=async input=>agents.run({...input,signature:agents.preview(input).signature})
 return {root,db,v,target,agents,task,run,ledger,config,accept}
}
test('all five scoped experts create evidence-bound candidate reports and replay without new calls or manuscript changes',async t=>{
 const s=setup(t)
 for(const c of categories){
  const input=s.task(c),p=s.agents.preview(input)
  assert.equal(JSON.parse(p.modelInput.input).units[0].version,s.v)
  const result=await s.agents.run({...input,signature:p.signature})
  assert.equal(result.status,'analysis-ready',result.candidateError??result.validationError)
  assert.equal(result.report.entries[0].evidence[0].quote,'林澈关上了铜灯。')
  assert.equal(result.report.findings[0].fact_quote,'灯在塔上。')
  assert.ok((await s.agents.run({...input,signature:p.signature})).replayed)
  assert.throws(()=>s.agents.preview(input),/已有当前报告/)
 }
 assert.equal(s.ledger.size,5)
 assert.ok(s.agents.analysisStatus(s.root,s.target).categories.every(x=>x.state==='current'))
 assert.equal(s.accept().supervision.reports.filter(x=>x.conflicts.length).length,5)
 assert.equal(readManuscript(s.root,1).selected.id,1)
})
test('unknown evidence, stale Canonical snapshots and disabled specialists never create a candidate report',async t=>{
 for(const opt of [{output:r=>r.entries[0].evidence=['bogus']},{alter:db=>db.exec("UPDATE story_facts SET value='新设定' WHERE id=1")}]){
  const s=setup(t,opt),input=s.task('CharacterArc'),out=await s.run(input)
  assert.ok(['invalid-output','analysis-pending'].includes(out.status));assert.equal(s.ledger.size,1)
  assert.equal(s.agents.analysisStatus(s.root,s.target).categories[0].state,'missing')
 }
 const s=setup(t);s.config.roles=[{id:'character',enabled:false}];assert.throws(()=>s.agents.preview(s.task('CharacterArc')),/未启用/);assert.equal(s.ledger.size,0)
})
test('one JSON fence is accepted while commentary and canonical IDs in evidence are rejected',async t=>{
 const fence=data=>['```json',JSON.stringify(data),'```'].join('\n')
 for(const [options,expected] of [[{encode:fence},'analysis-ready'],[{encode:d=>'说明\n'+fence(d)},'invalid-output'],
   [{encode:fence,output:d=>d.findings[0].evidence.push('1')},'invalid-output']]){
   const s=setup(t,options)
   assert.equal((await s.run(s.task('EventsLibrary'))).status,expected)
   assert.equal(s.agents.analysisStatus(s.root,s.target).categories.find(x=>x.category==='EventsLibrary').state,expected==='analysis-ready'?'current':'missing')
 }
})
test('a stale report can be regenerated with a backup, but foreign and malformed files are preserved',async t=>{
 const s=setup(t),input=s.task('CharacterArc');await s.run(input)
 const file=join(s.root,'ReferenceLibrary/analyses/candidates',String(s.v),'CharacterArc.json')
 const old=readFileSync(file,'utf8');s.db.exec("UPDATE story_facts SET value='另一条正式设定。' WHERE id=1")
 assert.equal(s.agents.analysisStatus(s.root,s.target).categories[0].state,'stale')
 assert.equal((await s.run(s.task('CharacterArc'))).status,'analysis-ready')
 assert.notEqual(readFileSync(file,'utf8'),old);assert.ok(existsSync(join(s.root,'.literarygiant/analysis-backups')))
 for(const value of ['broken',JSON.stringify({...JSON.parse(old),project_id:'foreign'})]){
   writeFileSync(file,value);assert.equal(s.agents.analysisStatus(s.root,s.target).categories[0].state,'invalid')
   assert.throws(()=>s.agents.preview(input));assert.equal(readFileSync(file,'utf8'),value)
 }
})
