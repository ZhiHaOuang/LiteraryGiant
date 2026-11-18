import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Ledger,LIMITS,inputBound} from '../lib/ledger.mjs'
import {runCell,REVISION} from '../lib/runtime.mjs'
const fixture={id:'fixture',split:'calibration',brief:'不要让她知道守卫的真实位置，只写候选。',source_sha256:'fixture-hash',source:{constraints:{min_han:10,max_han:100},chapters:[{number:1,paragraphs:['她以为守卫仍在桥上。'],document_id:1,version_id:1}],records:[]}}
const artifacts={analysis:{summary:'须区分所信与事实',findings:[{kind:'observation',category:'knowledge',claim:'她以为守卫仍在桥上',evidence:[{chapter:1,paragraph:1,quote:'她以为守卫仍在桥上'}]}],unknowns:['守卫真实位置']},planning:{summary:'门边试探',alternatives:[{id:'one',title:'门边',premise:'她小心接近门口',beats:['听见声音后停步','隔门试探'],tradeoffs:['不确认守卫位置']}],constraints:['不让人物凭空知情'],open_questions:[]},writing:{summary:'候选',text:'她在门前停下了脚步，抬起的手没有落下。门外的响声忽然断了。',checks:['保持信息边界'],open_questions:[]}}
const reply=({identity})=>({args:structuredClone(artifacts[identity.role])})
test('native A/B/C differ only in workflow and session topology; every arm revises',async t=>{
 const root=mkdtempSync(join(tmpdir(),'lg-abc-')),ledger=new Ledger(join(root,'meter.sqlite3'));t.after(()=>ledger.close())
 const runs=[]
 for(const arm of ['A','B','C'])runs.push(await runCell({root,caseData:fixture,arm,ledger,fixtureReply:reply}))
 assert.deepEqual(runs.map(r=>r.completed),[true,true,true]);assert.deepEqual(runs.map(r=>r.requests),[2,4,4])
 assert.deepEqual(runs.map(r=>new Set(r.events.map(e=>e.session)).size),[1,1,3])
 for(const run of runs){assert.deepEqual(run.artifacts.draft,artifacts.writing);assert.deepEqual(run.artifacts.final,artifacts.writing);assert.match(JSON.stringify(run.requestTrace.at(-1).messages),new RegExp(REVISION.slice(0,10)));assert.equal(run.knownTokens,run.requests*80)}
 for(const role of ['analysis','planning','writing']){
  const b=runs[1].requestTrace.find(r=>r.role===role),c=runs[2].requestTrace.find(r=>r.role===role)
  assert.deepEqual(b.system,c.system);assert.deepEqual(b.tools,c.tools)
 }
 for(const run of runs){
  const first=JSON.stringify(run.requestTrace[0].messages)
  assert.ok(first.includes('\\"paragraph\\":1')||first.includes('"paragraph":1'))
 }
 const b=runs[1].requestTrace.find(r=>r.role==='writing'),c=runs[2].requestTrace.find(r=>r.role==='writing')
 assert.ok(b.messages.length>c.messages.length)
 assert.ok(JSON.stringify(c.messages).includes(artifacts.analysis.summary))
 assert.ok(JSON.stringify(c.messages).includes(artifacts.planning.summary))
 assert.ok(!JSON.stringify(c.messages).includes('submit_analysis'))
})
test('invalid evidence is rejected and repaired in the same cell, never a hidden rerun',async t=>{
 const root=mkdtempSync(join(tmpdir(),'lg-abc-')),ledger=new Ledger(join(root,'meter.sqlite3'));t.after(()=>ledger.close());let failed=false
 const run=await runCell({root,caseData:fixture,arm:'C',ledger,fixtureReply:x=>{const r=reply(x);if(x.identity.role==='analysis'&&!failed){failed=true;r.args.findings[0].evidence[0].quote='不存在的引文'}return r}})
 assert.equal(run.completed,true);assert.equal(run.requests,5)
 assert.throws(()=>ledger.start('fixture-C'),/UNIQUE/)
})
test('the same request ceiling terminates an unproductive native loop',async t=>{
 const root=mkdtempSync(join(tmpdir(),'lg-abc-')),ledger=new Ledger(join(root,'meter.sqlite3'),{...LIMITS,cellRequests:3});t.after(()=>ledger.close())
 const run=await runCell({root,caseData:fixture,arm:'A',ledger,fixtureReply:()=>({args:{...artifacts.writing,text:'短'}})})
 assert.equal(run.completed,false);assert.equal(run.requests,3);assert.equal(run.finalHan,null)
})
test('shared ledger counts auxiliary and failed calls, preserves unknown reservation and token cap',t=>{
 const root=mkdtempSync(join(tmpdir(),'lg-abc-ledger-')),opts={sessionId:'one',messages:[],maxTokens:10};const bound=inputBound(opts)+10
 const ledger=new Ledger(join(root,'meter.sqlite3'),{...LIMITS,requests:3,cellTokens:bound*2});t.after(()=>ledger.close())
 const a=ledger.reserve('x',{...opts,purpose:'session-title'});ledger.finish(a,{status:'failed',usage:null,elapsedMs:1})
 ledger.reserve('x',opts);assert.throws(()=>ledger.reserve('x',opts),/TOKEN_LIMIT/)
 ledger.reserve('y',opts);assert.throws(()=>ledger.reserve('z',opts),/REQUEST_LIMIT/)
 assert.equal(ledger.rows('x')[0].charged,bound)
})
