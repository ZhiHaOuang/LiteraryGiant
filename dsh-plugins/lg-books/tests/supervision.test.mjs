import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,renameSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createBook} from './fixture.mjs'
import {writeManuscript,previewAcceptance,adjudicateAcceptance} from '../src/write.js'
import {readManuscript} from '../src/manuscript.js'
import {parseReportIdentity,legacyFingerprint} from '../src/analysis-snapshot.js'
import {retryAnalyses,latestPublication} from '../src/analysis-publication.js'
import original from './fixtures/supervised-candidate.json' with {type:'json'}
const categories=['CharacterArc','EventsLibrary','PayoffAngst','EmotionRhythm','Worldview']
function setup(t){
  const root=mkdtempSync(join(tmpdir(),'lg-supervision-')),{db}=createBook(root);t.after(()=>db.close())
  db.exec("INSERT INTO story_facts(category,fact_key,value,state,rationale,created_at,updated_at) VALUES ('人物','林澈','林澈持有铜钥匙。','canonical','作者记录','2026','2026')")
  const head=()=>readManuscript(root,1),token=head().token
  const {version}=writeManuscript(root,{action:'candidate',document:1,sourceVersion:1,token,operation:'native-supervised-candidate',content:'林澈把铜钥匙交给守灯人。',reason:'审阅钥匙的交接'})
  const input={action:'accept',operation:'supervised-accept-test',document:1,token,version}
  const policy=(chapter_categories,extra={})=>writeFileSync(join(root,'.literarygiant/supervision.json'),JSON.stringify({schema:'lg.supervision.v1',project_id:'test-book',chapter_categories,volume_categories:categories,...extra}))
  policy(['CharacterArc'])
  const dir=join(root,'ReferenceLibrary/analyses/candidates',String(version))
  mkdirSync(dir,{recursive:true})
  const report=structuredClone(original),put=()=>writeFileSync(join(dir,'CharacterArc.json'),JSON.stringify(report))
  const preview=()=>previewAcceptance(root,input),accept=(extra={})=>writeManuscript(root,{...input,...extra})
  const unchanged=()=>{assert.equal(head().selected.id,1);assert.equal(readManuscript(root,1,version).selected.state,'candidate')
    assert.equal(db.prepare('SELECT count(*) AS n FROM lg_plugin_operations WHERE id=?').get(input.operation).n,0)
    assert.ok(!existsSync(join(root,'manuscript/chapters/doc-1.md')))}
  return {root,version,input,policy,report,put,preview,accept,unchanged,db,dir}
}
test('supervised acceptance refuses missing/stale reports, fabricated quotes and invalid project policies atomically',t=>{
  const s=setup(t)
  assert.throws(s.preview,/审阅缺失/);assert.throws(()=>s.accept(),/审阅缺失/);s.unchanged()
  for(const key of ['base_fingerprint','fingerprint']){
    s.report[key]='0'.repeat(64);s.put();assert.throws(()=>s.accept(),/过期/);s.unchanged();s.report[key]=original[key]
  }
  s.report.report.findings[0].fact_quote='另一个事实';s.put();assert.throws(()=>s.accept(),/证据/);s.unchanged()
  s.policy(['CharacterArc'],{project_id:'other'});assert.throws(()=>s.accept(),/策略无效/);s.unchanged()
})
test('a conflict can only be dismissed by a bound author receipt, which never adopts the text',t=>{
  const s=setup(t);s.put()
  const p=s.preview(),report=p.supervision.reports[0]
  assert.equal(report.conflicts[0].evidence[0].version_id,s.version)
  assert.throws(()=>s.accept({reviewToken:p.reviewToken}),/尚未裁决/);s.unchanged()
  const decision={...s.input,reviewToken:p.reviewToken,reportDigest:report.digest,finding:1,reviewer:'作者',reason:'时间有先后',confirmed:true}
  for(const changes of [{confirmed:false},{reviewer:' '},{reason:''},{finding:2},{reportDigest:'other'},{reviewToken:'old'}])
    assert.throws(()=>adjudicateAcceptance(s.root,{...decision,...changes}))
  const done=adjudicateAcceptance(s.root,decision)
  assert.equal(done.reviewer,'作者');s.unchanged()
  assert.deepEqual(adjudicateAcceptance(s.root,decision),done)
  assert.throws(()=>adjudicateAcceptance(s.root,{...decision,reason:'覆盖旧理由'}))
  assert.throws(()=>s.accept({reviewToken:p.reviewToken}),/预览.*变化/)
  const next=s.preview();assert.deepEqual(next.supervision.reports[0].dismissed,[done]);s.unchanged()
  const accepted=s.accept({reviewToken:next.reviewToken})
  assert.deepEqual(accepted.supervision,next.supervision)
  assert.deepEqual(s.accept({reviewToken:next.reviewToken}),accepted)
})
test('a forged adjudication cannot authorize an evidenced Canonical conflict',t=>{
  const s=setup(t);s.put();const p=s.preview(),digest=p.supervision.reports[0].digest
  const dir=join(s.root,'ReferenceLibrary/analyses/adjudications',digest);mkdirSync(dir,{recursive:true})
  writeFileSync(join(dir,'1.json'),JSON.stringify({schema:'lg.adjudication.v1',report_digest:digest,review_report:{},finding_index:1,decision:'dismiss_false_positive',reviewer:'作者',reason:'理由',created_at:'now'}))
  assert.throws(()=>s.accept(),/裁决与报告不符/);s.unchanged()
})
test('a new required category or changed valid report invalidates the preview before any publication',t=>{
  const s=setup(t);s.report.report.findings=[];s.put();const p=s.preview()
  s.policy(['CharacterArc','EventsLibrary'])
  assert.throws(()=>s.accept({reviewToken:p.reviewToken}),/EventsLibrary/);s.unchanged()
  s.policy(['CharacterArc']);s.report.run_id='second';s.put()
  assert.throws(()=>s.accept({reviewToken:p.reviewToken}),/预览.*变化/);s.unchanged()
})

test('report and adjudication identities match Python for integral floats, exponent notation and large integers',()=>{
  const raw='{"x":[0.0,0,-0.0,1.00e-5,1e16,12345678901234567890],"😀":1,"私":2}'
  const typed=parseReportIdentity(raw)
  assert.equal(legacyFingerprint(typed),'043569679cd6e44f16e058b15c961dc30e5be4c7b7e0f2959470a028a6bf300d')
  assert.equal(legacyFingerprint(parseReportIdentity(JSON.stringify(typed))),legacyFingerprint(typed))
})

function publication(t) {
  const s=setup(t);s.report.report.findings=[];s.put()
  const dir=join(s.root,'ReferenceLibrary/analyses/doc-1');mkdirSync(dir)
  const file=category=>join(dir,category+'.json')
  const retry=()=>retryAnalyses(s.root,1,s.input.operation)
  return {...s,file,retry}
}
test('accepted report replaces an identified previous chapter analysis with backup, keeping candidate and receipt intact',t=>{
  const s=publication(t),target=s.file('CharacterArc'),previous=JSON.stringify({...s.report,fingerprint:'old'})
  writeFileSync(target,previous);const source=readFileSync(join(s.dir,'CharacterArc.json'))
  assert.equal(s.preview().supervision.reports.length,1);assert.equal(readFileSync(target,'utf8'),previous)
  const result=s.accept();assert.equal(result.publication.status,'published')
  const report=JSON.parse(readFileSync(target));assert.equal(report.base_fingerprint,result.supervision.candidate)
  assert.equal(report.source_fingerprint.length,64);assert.deepEqual(report.report,s.report.report)
  assert.equal(readFileSync(result.publication.items[0].backup,'utf8'),previous)
  assert.deepEqual(readFileSync(join(s.dir,'CharacterArc.json')),source)
  const inode=statSync(target).ino;assert.deepEqual(s.retry(),result);assert.equal(statSync(target).ino,inode)
})
test('a failed category can be resumed independently, while altered sources or external reports remain untouched',t=>{
  const s=publication(t);s.policy(['CharacterArc','EventsLibrary'])
  const other={...s.report,library:'EventsLibrary'},source=join(s.dir,'EventsLibrary.json'),target=s.file('EventsLibrary')
  writeFileSync(source,JSON.stringify(other));mkdirSync(target)
  const saved=s.accept();assert.deepEqual(saved.publication.items.map(i=>i.status),['published','pending'])
  assert.equal(readManuscript(s.root,1).selected.id,s.version)
  const good=statSync(s.file('CharacterArc')).ino,versions=s.db.prepare('SELECT count(*) AS n FROM document_versions').get().n
  renameSync(target,target+'.obstruction');writeFileSync(source,JSON.stringify({...other,run_id:'changed'}))
  assert.match(s.retry().publication.items[1].error,/采用收据/);assert.ok(!existsSync(target))
  writeFileSync(source,JSON.stringify(other));writeFileSync(target,JSON.stringify(other))
  assert.match(s.retry().publication.items[1].error,/已保留/);assert.equal(readFileSync(target,'utf8'),JSON.stringify(other))
  renameSync(target,target+'.external')
  assert.equal(s.retry().publication.status,'published');assert.equal(statSync(s.file('CharacterArc')).ino,good)
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM document_versions').get().n,versions)
  assert.equal(latestPublication(s.db,1).publication.status,'published')
})
test('a changed Canonical snapshot supersedes outstanding publication even when the accepted version is still active',t=>{
  const s=publication(t),target=s.file('CharacterArc');mkdirSync(target);s.accept();renameSync(target,target+'.obstruction')
  s.db.exec("UPDATE story_facts SET value='作者修改正式设定' WHERE id=1")
  assert.equal(s.retry().publication.status,'superseded');assert.ok(!existsSync(target))
  assert.equal(readManuscript(s.root,1).selected.id,s.version)
})
test('after a receipt write failure an already-published file is recognized on retry without another replacement',t=>{
  const s=publication(t),target=s.file('CharacterArc')
  s.db.exec("CREATE TRIGGER fail_publication BEFORE UPDATE ON lg_plugin_operations WHEN json_extract(NEW.result,'$.publication.status')='published' BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END")
  const saved=s.accept();assert.ok(saved.publicationError);assert.equal(saved.publication.status,'pending');const inode=statSync(target).ino
  s.db.exec('DROP TRIGGER fail_publication')
  assert.equal(s.retry().publication.status,'published');assert.equal(statSync(target).ino,inode)
})
test('pre-publication acceptance receipts can fill a missing file but cannot replace an unbound existing report',t=>{
  const s=publication(t),target=s.file('CharacterArc');s.accept()
  s.db.prepare("UPDATE lg_plugin_operations SET result=json_remove(result,'$.publication') WHERE id=?").run(s.input.operation)
  writeFileSync(target,JSON.stringify({...s.report,run_id:'external'}))
  assert.equal(latestPublication(s.db,1).publication.status,'pending');assert.equal(s.retry().publication.status,'pending')
  assert.equal(JSON.parse(readFileSync(target)).run_id,'external')
  renameSync(target,target+'.external');assert.equal(s.retry().publication.status,'published')
})
test('an older receipt recognizes an equivalent formatted chapter report without replacing it',t=>{
  const s=publication(t);s.accept();const path=s.file('CharacterArc'),pretty=JSON.stringify(JSON.parse(readFileSync(path)),null,2)
  writeFileSync(path,pretty);s.db.prepare("UPDATE lg_plugin_operations SET result=json_remove(result,'$.publication') WHERE id=?").run(s.input.operation)
  assert.equal(s.retry().publication.status,'published');assert.equal(readFileSync(path,'utf8'),pretty)
})
test('Markdown synchronization and publication settle independently after acceptance',t=>{
  const s=publication(t),markdown=join(s.root,'manuscript','chapters','doc-1.md')
  mkdirSync(markdown,{recursive:true})
  const accepted=s.accept()
  assert.equal(accepted.sync,'mirror-pending');assert.ok(accepted.syncError)
  assert.equal(accepted.publication.status,'published')
  const inode=statSync(s.file('CharacterArc')).ino
  renameSync(markdown,markdown+'.obstruction')
  const replay=s.accept()
  assert.equal(replay.sync,'synchronized');assert.equal(replay.publication.status,'published')
  assert.equal(statSync(s.file('CharacterArc')).ino,inode)
})
