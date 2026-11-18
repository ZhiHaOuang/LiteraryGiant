import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,renameSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {accessState} from '../../lg-books/src/state.js'
import {legacyRun,oldRuns,verifyOldVersion} from '../../lg-books/src/legacy-runs.js'
import {runHistory} from '../src/run-history.js'

function fixture(){
  const path=mkdtempSync(join(tmpdir(),'lg-history-')),id='20261107T010203Z-1234abcd'
  createBook(path).db.close()
  const dir=join(path,'.literarygiant','runs',id);mkdirSync(dir,{recursive:true})
  const m={schema_version:'lg.run.v2',run_id:id,workflow:'write',status:'failed',request:'写一个场景',created_at:'now',updated_at:'now',completed_stages:['plan'],error:'PRIVATE_DIAGNOSTIC'}
  const save=()=>writeFileSync(join(dir,'run.json'),JSON.stringify(m));save()
  const events=['run.started','model.event','stage.failed'].map((type,n)=>({type,sequence:n+1,timestamp:'now',workflow:'write',run_id:id,message:n?'PRIVATE_MESSAGE':'开始',data:{private:'PRIVATE_DATA'}}))
  writeFileSync(join(dir,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'))
  const books={legacyRuns:oldRuns,legacyRun,readState:(p,fn)=>accessState(p,false,fn),changeState:(p,fn)=>accessState(p,true,fn),verifyOldVersion:(p,ref)=>accessState(p,false,db=>verifyOldVersion(db,ref))}
  books.changeState(path,db=>db.prepare("UPDATE document_versions SET metadata_json=? WHERE id=8").run(JSON.stringify({run_id:id})))
  return {path,id,dir,m,save,books,api:(action,args={})=>runHistory(books,path,{action,id,...args})}
}
test('public snapshots are immutable, idempotent and usable when the legacy run is moved away',async()=>{
  const s=fixture(),first=await s.api('legacy-preview')
  assert.equal(first.record.events.length,2);assert.doesNotMatch(JSON.stringify(first),/PRIVATE_/)
  await assert.rejects(s.api('legacy-import',{token:first.token}),/确认/)
  s.m.status='completed';s.save()
  await assert.rejects(s.api('legacy-import',{token:first.token,confirmed:true}),/变化/)
  const {token}=await s.api('legacy-preview'),save=()=>s.api('legacy-import',{token,confirmed:true})
  const [a,b]=await Promise.all([save(),save()]);assert.deepEqual(a,b)
  renameSync(s.dir,s.dir+'-moved');assert.deepEqual(await save(),a)
  assert.equal((await s.api('history-list')).items.length,1)
  assert.deepEqual(await s.api('history-read',{token}),a)
  assert.deepEqual(await s.api('history-version',{token,version:8}),{document:1,version:8})
  s.books.changeState(s.path,db=>db.exec("UPDATE document_versions SET content='变更' WHERE id=8"))
  await assert.rejects(s.api('history-version',{token,version:8}),/已变化/)
})
test('invalid identities, tampered task state and symlinked event logs cannot become history',async()=>{
  const s=fixture(),events=join(s.dir,'events.jsonl')
  await assert.rejects(s.api('legacy-preview',{id:'../other'}),/编号无效/)
  writeFileSync(events,JSON.stringify({run_id:'another',workflow:'write',type:'model.event'}))
  await assert.rejects(s.api('legacy-preview'),/不匹配/)
  renameSync(events,events+'.save');symlinkSync(events+'.save',events)
  await assert.rejects(s.api('legacy-preview'))
  renameSync(events,events+'.link');writeFileSync(join(s.dir,'literary-task.json'),JSON.stringify({runId:s.id,schema:'lg.literary-task.v1',fingerprint:'bad'}))
  await assert.rejects(s.api('legacy-preview'),/指纹/)
  s.m.run_id='wrong';s.save()
  assert.ok((await s.api('legacy-list')).items[0].error)
  assert.equal((await s.api('history-list')).items.length,0)
})
test('keyset pages do not duplicate older directories when a later run appears',async()=>{
  const s=fixture(),add=id=>{const p=join(s.dir,'..',id);mkdirSync(p);writeFileSync(join(p,'run.json'),JSON.stringify({...s.m,run_id:id}))}
  for(let n=0;n<21;n++)add('run-'+String(n).padStart(2,'0'))
  const page=await s.api('legacy-list');assert.equal(page.items.length,20);add('z-new')
  const last=await s.api('legacy-list',{before:page.next})
  assert.deepEqual(last.items.map(i=>i.id),['run-00',s.id]);assert.equal(last.next,null)
})
test('chunked UTF-8 events survive import and later public changes produce separate snapshots',async()=>{
  const s=fixture(),message='铜钥匙交接。'.repeat(8000),event={sequence:1,timestamp:'now',stage_id:'handoff',workflow:'write',run_id:s.id,type:'stage.completed',message}
  writeFileSync(join(s.dir,'events.jsonl'),JSON.stringify(event)+'\r\n')
  const original=await s.api('legacy-preview');assert.equal(original.record.events[0].message,message)
  await s.api('legacy-import',{token:original.token,confirmed:true})
  s.m.request='新的公开请求';s.save();const changed=await s.api('legacy-preview')
  await s.api('legacy-import',{token:changed.token,confirmed:true})
  const page=await s.api('history-list');assert.deepEqual(page.items.map(i=>i.token),[changed.token,original.token])
  const foreign=fixture();await assert.rejects(foreign.api('history-read',{token:changed.token}),/未找到/)
})
